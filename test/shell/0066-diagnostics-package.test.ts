// 0066 可运维性一期（R-002）：诊断包组装 —— manifest + logs/ + 脱敏 DB 统计，zip 往返 + 排除清单硬断言。
//
// 环境：node（真 fs + 真 SQLite 真迁移）；本文件是「排除清单」（任务书 §零.8 / §六.3）在单测层的咬合点：
// 题库原库、图片资产、登录态分区目录、模型档案密钥密文列（列名与取值）都不得出现在包内任何字节里。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { Database } from '../../src/bank/db.js';
import { readZip } from '../../src/guard/zip-utils.js';
import {
  buildDiagnosticsPackage,
  DIAG_LOG_TAIL_MAX_BYTES,
  type DiagnosticsPackageResult,
} from '../../src/shell/diag/diagnostics-package.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const realMigrationsDir = join(__dirname, '../../src/bank/migrations');

/** 密钥密文哨兵值：出现在包内任一字节即为合规失败 */
const KEY_CIPHER_SENTINEL = 'CIPHERTEXT-9f8e7d6c5b4a-EXCLUDE-ME';
/** 资产字节哨兵值 */
const ASSET_SENTINEL = 'ASSET-BYTES-EXCLUDE-ME';
/** 登录态哨兵值 */
const COOKIE_SENTINEL = 'SESSION-COOKIE-EXCLUDE-ME';

let root: string;
let userData: string;
let dataDir: string;
let logsDir: string;
let db: Database;

function writeLog(name: string, content: string): void {
  writeFileSync(join(logsDir, name), content, 'utf8');
}

function build(now = new Date('2026-09-24T10:00:00.000Z')): DiagnosticsPackageResult {
  return buildDiagnosticsPackage({
    outputPath: join(root, 'mofang-diagnostics-test.zip'),
    userDataPath: userData,
    dataDir,
    appVersion: '0.1.0-test',
    electronVersion: '38.8.6-test',
    nodeVersion: '24.0.0-test',
    platform: 'win32',
    arch: 'x64',
    now: () => now,
    getTableCounts: () => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as Array<{ name: string }>;
      return tables.map((t) => ({
        name: t.name,
        count: (db.prepare(`SELECT COUNT(*) AS c FROM "${t.name}"`).get() as { c: number }).c,
      }));
    },
  });
}

const entryOf = (result: Extract<DiagnosticsPackageResult, { success: true }>, path: string) => {
  const zip = readZip(result.path);
  const entry = zip.find((e) => e.path === path);
  if (!entry) throw new Error(`包内缺条目 ${path}（实有：${zip.map((e) => e.path).join(', ')}）`);
  return entry;
};
const pathsOf = (result: Extract<DiagnosticsPackageResult, { success: true }>) =>
  readZip(result.path).map((e) => e.path).sort();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mofang-0066-diagpkg-'));
  userData = join(root, 'userData');
  dataDir = join(userData, 'data');
  logsDir = join(userData, 'logs');
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(join(dataDir, 'assets', 'recog'), { recursive: true });
  mkdirSync(join(dataDir, 'recog', 'runs', 'run-1'), { recursive: true });
  mkdirSync(join(dataDir, 'splitting', 'p1'), { recursive: true });
  mkdirSync(join(userData, 'Partitions', 'mofang-capture'), { recursive: true });

  // 真迁移建真库（含 model_profiles.key_encrypted 列）
  db = new Database(join(dataDir, 'bank.db'));
  Database.runMigrations(db, realMigrationsDir);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO questions (id, subject, source_type, source_detail, content, answer, images, created_at, updated_at, deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('q-1', '数学', 'network', JSON.stringify({ site: 'jyeoo', url: 'https://x/1', questionId: 'q-1', collectedAt: now }), '<div>1+1</div>', '<div>2</div>', '[]', now, now, 0);
  db.prepare(
    `INSERT INTO model_profiles (id, role, name, provider, protocol, base_url, model, key_encrypted, capability, is_enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('p-1', 'vision', '看图档案', 'siliconflow', 'openai-chat', 'https://api.example.com', 'm', KEY_CIPHER_SENTINEL, '{}', 1, now, now);

  // 排除面素材（内容带哨兵值）
  writeFileSync(join(dataDir, 'assets', 'recog', `${'a'.repeat(32)}.png`), ASSET_SENTINEL);
  writeFileSync(join(dataDir, 'recog', 'runs', 'run-1', 'source.json'), ASSET_SENTINEL);
  writeFileSync(join(dataDir, 'splitting', 'p1', 'page-1.png'), ASSET_SENTINEL);
  writeFileSync(join(userData, 'Partitions', 'mofang-capture', 'Cookies'), COOKIE_SENTINEL);
  writeFileSync(join(userData, 'data', 'bank.db.bak-0066'), KEY_CIPHER_SENTINEL);

  // 该进包的日志
  writeLog('app.log', '{"ts":"t","level":"info","module":"diag","message":"启动"}\n');
  writeLog('app.log.1', '{"ts":"t0","level":"info","module":"diag","message":"上一代"}\n');
  writeLog('crash.log', '{"ts":"t","kind":"render-process-gone","message":"crashed"}\n');
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* 已关闭 */
  }
  rmSync(root, { recursive: true, force: true });
});

describe('0066 诊断包组装：条目与 manifest', () => {
  it('包内条目=manifest + logs（app.log 全量 + 轮转代 + crash + 两份 capture 尾段）', () => {
    writeFileSync(join(dataDir, 'capture-collect.log'), 'collect-line\n', 'utf8');
    writeFileSync(join(dataDir, 'capture-paper.log'), 'paper-line\n', 'utf8');

    const result = build();
    expect(result.success).toBe(true);
    const ok = result as Extract<DiagnosticsPackageResult, { success: true }>;

    expect(pathsOf(ok)).toEqual([
      'logs/app.log',
      'logs/app.log.1',
      'logs/capture-collect.log',
      'logs/capture-paper.log',
      'logs/crash.log',
      'manifest.json',
    ]);
    expect(entryOf(ok, 'logs/app.log').content.toString('utf8')).toBe(readFileSync(join(logsDir, 'app.log'), 'utf8'));
    expect(entryOf(ok, 'logs/capture-collect.log').content.toString('utf8')).toBe('collect-line\n');
  });

  it('manifest 字段齐：版本/平台/arch/Electron/时间戳 + 脱敏各表 counts + 自定义 now', () => {
    const result = build(new Date('2026-09-24T10:00:00.000Z')) as Extract<DiagnosticsPackageResult, { success: true }>;
    const manifest = JSON.parse(entryOf(result, 'manifest.json').content.toString('utf8')) as Record<string, unknown>;

    expect(manifest.format).toBe('mofang-assistant-diagnostics');
    expect(manifest.format_version).toBe(1);
    expect(manifest.generated_at).toBe('2026-09-24T10:00:00.000Z');
    expect(manifest.app_version).toBe('0.1.0-test');
    expect(manifest.electron_version).toBe('38.8.6-test');
    expect(manifest.node_version).toBe('24.0.0-test');
    expect(manifest.platform).toBe('win32');
    expect(manifest.arch).toBe('x64');

    const stats = (manifest.db as { stats: Array<{ name: string; count: number }> }).stats;
    expect(stats.find((s) => s.name === 'questions')?.count).toBe(1);
    expect(stats.find((s) => s.name === 'model_profiles')?.count).toBe(1);
    expect(stats.find((s) => s.name === 'papers')?.count).toBe(0);

    const logs = manifest.logs as Array<{ path: string; bytes: number; truncated: boolean }>;
    expect(logs.find((l) => l.path === 'logs/app.log')?.bytes).toBe(readFileSync(join(logsDir, 'app.log')).length);
    expect(logs.find((l) => l.path === 'logs/app.log')?.truncated).toBe(false);
  });

  it('capture 两份 log 尾段截断：≤256KB 且保留最新内容（最老内容被裁掉并登记 truncated）', () => {
    const head = 'OLDEST-LINE-' + 'a'.repeat(100) + '\n';
    const tail = 'NEWEST-LINE\n';
    writeFileSync(join(dataDir, 'capture-collect.log'), head + 'b'.repeat(400 * 1024) + '\n' + tail, 'utf8');
    writeFileSync(join(dataDir, 'capture-paper.log'), head, 'utf8');

    const result = build() as Extract<DiagnosticsPackageResult, { success: true }>;
    const entry = entryOf(result, 'logs/capture-collect.log');
    expect(entry.content.length).toBeLessThanOrEqual(DIAG_LOG_TAIL_MAX_BYTES);
    expect(entry.content.toString('utf8')).toContain('NEWEST-LINE');
    expect(entry.content.toString('utf8')).not.toContain('OLDEST-LINE-');

    const manifest = JSON.parse(entryOf(result, 'manifest.json').content.toString('utf8')) as {
      logs: Array<{ path: string; bytes: number; truncated: boolean }>;
    };
    expect(manifest.logs.find((l) => l.path === 'logs/capture-collect.log')?.truncated).toBe(true);
    expect(manifest.logs.find((l) => l.path === 'logs/capture-paper.log')?.truncated).toBe(false);
  });

  it('缺日志/缺目录也成功（不因无日志阻断导出）', () => {
    rmSync(logsDir, { recursive: true, force: true });
    const result = build();
    expect(result.success).toBe(true);
    expect(pathsOf(result as Extract<DiagnosticsPackageResult, { success: true }>)).toEqual(['manifest.json']);
  });

  it('输出路径不可写 → {success:false, error}（不抛）', () => {
    const result = buildDiagnosticsPackage({
      outputPath: join(root, 'no-such-dir', 'x.zip'),
      userDataPath: userData,
      dataDir,
      appVersion: '0.1.0-test',
      electronVersion: '38.8.6-test',
      getTableCounts: () => [{ name: 'questions', count: 1 }],
    });
    expect(result.success).toBe(false);
    expect(String((result as { error: string }).error).length).toBeGreaterThan(0);
  });
});

describe('0066 诊断包排除清单（红线级）', () => {
  it('包内不出现：密钥密文列名与取值 / 题库原库 / 资产字节 / 登录态 / runs / splitting', () => {
    writeFileSync(join(dataDir, 'capture-collect.log'), 'collect\n', 'utf8');
    writeFileSync(join(dataDir, 'capture-paper.log'), 'paper\n', 'utf8');

    const result = build() as Extract<DiagnosticsPackageResult, { success: true }>;
    const zipEntries = readZip(result.path);

    // 条目路径不得触碰排除面
    for (const entry of zipEntries) {
      expect(entry.path).not.toMatch(/bank\.db|Partitions|assets|recog\/runs|splitting|Crashpad/i);
    }

    const joined = Buffer.concat(zipEntries.map((e) => e.content));
    expect(joined.toString('utf8')).not.toContain(KEY_CIPHER_SENTINEL);
    expect(joined.toString('utf8')).not.toContain('key_encrypted');
    expect(joined.toString('utf8')).not.toContain(ASSET_SENTINEL);
    expect(joined.toString('utf8')).not.toContain(COOKIE_SENTINEL);

    // 原始 zip 字节面同样零命中（防「明文块塞进压缩流」）
    const raw = readFileSync(result.path);
    expect(raw.toString('utf8')).not.toContain(KEY_CIPHER_SENTINEL);
    expect(raw.toString('utf8')).not.toContain(ASSET_SENTINEL);
    expect(raw.toString('utf8')).not.toContain(COOKIE_SENTINEL);

    // 备份文件（data/bank.db.bak-*）同样不进包
    expect(pathsOf(result).some((p) => p.includes('bak'))).toBe(false);
    expect(existsSync(join(dataDir, 'bank.db'))).toBe(true);
  });

  it('manifest.excluded 自述排除面（不含敏感字面量）', () => {
    const result = build() as Extract<DiagnosticsPackageResult, { success: true }>;
    const manifest = JSON.parse(entryOf(result, 'manifest.json').content.toString('utf8')) as { excluded: string[] };
    expect(manifest.excluded.length).toBeGreaterThanOrEqual(4);
    expect(manifest.excluded.join('')).not.toContain('key_encrypted');
  });
});
