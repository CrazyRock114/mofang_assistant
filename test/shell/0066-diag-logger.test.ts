// 0066 可运维性一期（R-002）：主进程极简 logger —— 落盘 / 大小轮转 / 代数上限 / 密钥脱敏 / IPC 错误收口。
//
// 环境：node（真 fs）；logger 与收口助手零 electron 依赖（结构性接口收 target），故不需要 electron mock。
// 轮转口径（本单定稿，交付报告 §三登记）：单文件 ≤maxBytes；保留 ≤maxGenerations 代（app.log.1 ~ app.log.N），
// 最老代被弃；滚动时机 = 启动 init() 时探一次 + 每次写入前按在写字节数预判。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  DiagLogger,
  DIAG_APP_LOG_NAME,
  DIAG_LOG_DIR_NAME,
  DIAG_LOG_MAX_BYTES,
  DIAG_LOG_MAX_GENERATIONS,
  initDiagLogger,
  setActiveDiagLogger,
  getActiveDiagLogger,
  diagLog,
  scrubSecrets,
  installIpcErrorLogging,
  type IpcHandlerRegistrar,
} from '../../src/shell/diag/logger.js';

let root: string;
let userData: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mofang-0066-logger-'));
  userData = join(root, 'userData');
  mkdirSync(userData, { recursive: true });
});

afterEach(() => {
  setActiveDiagLogger(null);
  rmSync(root, { recursive: true, force: true });
});

const appLog = () => join(userData, DIAG_LOG_DIR_NAME, DIAG_APP_LOG_NAME);
const readLines = (path: string): Array<Record<string, unknown>> =>
  readFileSync(path, 'utf8').split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l) as Record<string, unknown>);

describe('0066 DiagLogger 落盘与格式', () => {
  it('日志写入 <userData>/logs/app.log，单行 JSON 含 ts/level/module/message', () => {
    const logger = new DiagLogger({ userDataPath: userData });
    logger.init();

    logger.info('diag', '启动');
    logger.warn('ipc', '可疑调用', { channel: 'guard.getStats' });
    logger.error('crash', '炸了');

    expect(existsSync(appLog())).toBe(true);
    const lines = readLines(appLog());
    expect(lines).toHaveLength(3);
    expect(lines[0].level).toBe('info');
    expect(lines[0].module).toBe('diag');
    expect(lines[0].message).toBe('启动');
    expect(typeof lines[0].ts).toBe('string');
    expect(new Date(String(lines[0].ts)).toString()).not.toBe('Invalid Date');
    expect(lines[1].level).toBe('warn');
    expect(lines[1].meta).toEqual({ channel: 'guard.getStats' });
    expect(lines[2].level).toBe('error');
  });

  it('多行消息/含换行 meta 仍为单行（每行独立可 JSON.parse）', () => {
    const logger = new DiagLogger({ userDataPath: userData });
    logger.init();

    logger.error('ipc', 'line1\nline2\r\nline3', { stack: 'a\nb' });

    const raw = readFileSync(appLog(), 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(1);
    const line = JSON.parse(raw.trim()) as Record<string, unknown>;
    expect(String(line.message)).toContain('line1');
  });

  it('尊重 userData 重定向：两个不同 userData 各自落各自的 logs 目录', () => {
    const other = join(root, 'redirected');
    mkdirSync(other, { recursive: true });

    new DiagLogger({ userDataPath: userData }).init().info('diag', 'A');
    new DiagLogger({ userDataPath: other }).init().info('diag', 'B');

    expect(readLines(appLog())[0].message).toBe('A');
    expect(readLines(join(other, 'logs', 'app.log'))[0].message).toBe('B');
  });

  it('默认上限=2MB / 保留 3 代（口径常量随包可读）', () => {
    expect(DIAG_LOG_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(DIAG_LOG_MAX_GENERATIONS).toBe(3);
  });
});

describe('0066 DiagLogger 轮转', () => {
  it('写入超限滚动：代数正确、最老代被弃、当前文件只剩新内容', () => {
    const maxBytes = 400;
    const logger = new DiagLogger({ userDataPath: userData, maxBytes, maxGenerations: 3 });
    logger.init();

    // 每行约 100 字节，写 40 行 → 至少滚 3 次以上
    for (let i = 0; i < 40; i++) {
      logger.info('rot', `第${i}行`, { pad: 'x'.repeat(50) });
    }

    const dir = join(userData, DIAG_LOG_DIR_NAME);
    const files = readdirSync(dir).sort();
    expect(files).toEqual([DIAG_APP_LOG_NAME, 'app.log.1', 'app.log.2', 'app.log.3']);

    // 每代都在上限内
    for (const f of files) {
      expect(readFileSync(join(dir, f)).length).toBeLessThanOrEqual(maxBytes);
    }

    // 最新一行在当前文件；最老一行全库（含各代）零命中
    const all = files.map((f) => readFileSync(join(dir, f), 'utf8')).join('');
    expect(all).toContain('第39行');
    expect(all).not.toContain('第0行');
    // 代越靠前内容越新：app.log 的末行晚于 app.log.1 的末行
    const lastOf = (f: string): number => {
      const lines = readLines(join(dir, f));
      return Number(String(lines[lines.length - 1].message).replace('第', '').replace('行', ''));
    };
    expect(lastOf(DIAG_APP_LOG_NAME)).toBeGreaterThan(lastOf('app.log.1'));
    expect(lastOf('app.log.1')).toBeGreaterThan(lastOf('app.log.2'));
  });

  it('启动时滚动：遗留超限 app.log 在 init() 即滚成 app.log.1', () => {
    const dir = join(userData, DIAG_LOG_DIR_NAME);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, DIAG_APP_LOG_NAME), 'x'.repeat(500));

    const logger = new DiagLogger({ userDataPath: userData, maxBytes: 200, maxGenerations: 3 });
    logger.init();

    expect(existsSync(join(dir, 'app.log.1'))).toBe(true);
    expect(readFileSync(join(dir, DIAG_APP_LOG_NAME)).length).toBe(0);
    logger.info('diag', '首次写入');
    expect(readLines(join(dir, DIAG_APP_LOG_NAME))).toHaveLength(1);
  });

  it('遗留超限文件的归档同样受上限约束（截尾保留最新内容，按行首对齐）', () => {
    const dir = join(userData, DIAG_LOG_DIR_NAME);
    mkdirSync(dir, { recursive: true });
    const oldLines = Array.from({ length: 20 }, (_, i) => `old-${i}-${'x'.repeat(40)}\n`).join('');
    writeFileSync(join(dir, DIAG_APP_LOG_NAME), oldLines);

    const logger = new DiagLogger({ userDataPath: userData, maxBytes: 200, maxGenerations: 3 });
    logger.init();

    const archive = readFileSync(join(dir, 'app.log.1'), 'utf8');
    expect(Buffer.byteLength(archive, 'utf8')).toBeLessThanOrEqual(200);
    expect(archive).toContain('old-19-'); // 最新一行保留
    expect(archive).not.toContain('old-0-'); // 最老内容被裁
    expect(archive.startsWith('old-')).toBe(true); // 行首对齐（无半行残片）
  });

  it('落盘失败不抛（路径被占用成文件也不炸主进程）', () => {
    const blocked = join(root, 'blocked');
    writeFileSync(blocked, 'not a dir');
    const logger = new DiagLogger({ logDir: blocked });
    expect(() => {
      logger.init();
      logger.error('diag', '写不进去也不许抛');
    }).not.toThrow();
  });
});

describe('0066 密钥脱敏（诊断包合规第二道闸）', () => {
  it('scrubSecrets 掩掉 sk- 明文 / api key 字段 / Bearer / cookie 形值', () => {
    const masked = scrubSecrets(
      `key=sk-abcdefghijklmnopqrstuvwxyz012345 apiKey: "plainsecret123456" Authorization: Bearer abc.def.ghi ` +
        `Cookie: SESSIONID=deadbeef; token=zzz`,
    );
    expect(masked).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345');
    expect(masked).not.toContain('plainsecret123456');
    expect(masked).not.toContain('abc.def.ghi');
    expect(masked).not.toContain('deadbeef');
    expect(masked).toContain('***');
  });

  it('写入路径同样过脱敏（message 与 meta 双面）', () => {
    const logger = new DiagLogger({ userDataPath: userData });
    logger.init();
    logger.error('ai', 'invoke 失败 key=sk-abcdefghijklmnopqrstuvwxyz012345', { key: 'sk-zzzzzzzzzzzzzzzzzzzzzzzz' });

    const raw = readFileSync(appLog(), 'utf8');
    expect(raw).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345');
    expect(raw).not.toContain('sk-zzzzzzzzzzzzzzzzzzzzzzzz');
  });

  it('普通文本不被误伤', () => {
    const text = '导出诊断包成功：C:\\Users\\teacher\\logs\\app.log（1234 字节）';
    expect(scrubSecrets(text)).toBe(text);
  });
});

describe('0066 单例与 IPC 错误收口', () => {
  it('initDiagLogger 装为活动实例，diagLog 直写；未初始化时 diagLog 静默不抛', () => {
    setActiveDiagLogger(null);
    expect(getActiveDiagLogger()).toBeNull();
    expect(() => diagLog('error', 'ipc', '没有 logger 也不抛')).not.toThrow();
    expect(existsSync(appLog())).toBe(false);

    initDiagLogger(userData);
    expect(getActiveDiagLogger()).not.toBeNull();
    diagLog('info', 'diag', '单例写入');
    expect(readLines(appLog())[0].message).toBe('单例写入');
  });

  it('installIpcErrorLogging：handler 抛错 → 记 app.log 且原样再抛', async () => {
    const logger = initDiagLogger(userData);
    const registered = new Map<string, (...args: unknown[]) => unknown>();
    const target: IpcHandlerRegistrar = {
      handle: (channel, listener) => {
        registered.set(channel, listener);
      },
    };
    installIpcErrorLogging(target);

    target.handle('guard.getStats', async () => 'ok');
    target.handle('diag.exportDiagnostics', async () => {
      throw new Error('磁盘满了');
    });

    await expect(Promise.resolve(registered.get('guard.getStats')!(null, undefined))).resolves.toBe('ok');
    await expect(Promise.resolve(registered.get('diag.exportDiagnostics')!(null, undefined))).rejects.toThrow('磁盘满了');

    const lines = readLines(logger.appLogPath());
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe('error');
    expect(lines[0].module).toBe('ipc');
    expect(String(lines[0].message)).toContain('diag.exportDiagnostics');
    expect(String(lines[0].message)).toContain('磁盘满了');
  });

  it('installIpcErrorLogging：成功路径不写日志、返回值原样透传', async () => {
    const logger = initDiagLogger(userData);
    const registered = new Map<string, (...args: unknown[]) => unknown>();
    const target: IpcHandlerRegistrar = {
      handle: (channel, listener) => {
        registered.set(channel, listener);
      },
    };
    installIpcErrorLogging(target);
    target.handle('x.y', async (_event: unknown, payload: unknown) => ({ echo: payload }));

    await expect(Promise.resolve(registered.get('x.y')!(null, { a: 1 }))).resolves.toEqual({ echo: { a: 1 } });
    expect(existsSync(logger.appLogPath())).toBe(false);
  });
});
