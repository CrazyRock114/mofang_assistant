// 0066 可运维性一期（R-002）：崩溃捕获落盘 —— crash.log 记录形态 + 主进程接线（源码级断言）。
//
// 环境：node（真 fs）。CrashWiring 是「事件 → 记录」的最小单元：main.ts 只负责把 Electron 的事件接进来
// （render-process-gone / child-process-gone / uncaughtException / unhandledRejection），
// 落盘后**不** process.exit（任务书 §一.2：保持现状行为，只多落盘）——本文件以源码级断言钉住这两点。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  CrashWiring,
  createCrashWiring,
  CRASH_LOG_NAME,
  formatCrashRecord,
} from '../../src/shell/diag/crash.js';
import { initDiagLogger, setActiveDiagLogger } from '../../src/shell/diag/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const shellDir = join(__dirname, '../../src/shell');

let root: string;
let userData: string;
let crashLog: string;

const readRecords = (): Array<Record<string, unknown>> =>
  readFileSync(crashLog, 'utf8').split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l) as Record<string, unknown>);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mofang-0066-crash-'));
  userData = join(root, 'userData');
  crashLog = join(userData, 'logs', CRASH_LOG_NAME);
});

afterEach(() => {
  setActiveDiagLogger(null);
  rmSync(root, { recursive: true, force: true });
});

describe('0066 CrashWiring 记录形态', () => {
  it('uncaughtException：crash.log 一条 JSON（kind/message/stack/ts），app.log 同步留 error 行', () => {
    const logger = initDiagLogger(userData);
    const wiring = createCrashWiring();

    const record = wiring.uncaughtException(new Error('主进程炸了'));

    expect(record).not.toBeNull();
    const records = readRecords();
    expect(records).toHaveLength(1);
    expect(records[0].kind).toBe('uncaughtException');
    expect(String(records[0].message)).toContain('主进程炸了');
    expect(String(records[0].stack)).toContain('主进程炸了');
    expect(new Date(String(records[0].ts)).toString()).not.toBe('Invalid Date');

    const appLines = readFileSync(logger.appLogPath(), 'utf8').split('\n').filter((l) => l.length > 0);
    expect(appLines).toHaveLength(1);
    expect((JSON.parse(appLines[0]) as { level: string }).level).toBe('error');
  });

  it('unhandledRejection：字符串与非 Error 对象都能成一行（不因入参形态漏记）', () => {
    initDiagLogger(userData);
    const wiring = createCrashWiring();

    wiring.unhandledRejection('裸字符串原因');
    wiring.unhandledRejection({ code: 42, detail: '对象原因' });

    const records = readRecords();
    expect(records).toHaveLength(2);
    expect(records[0].kind).toBe('unhandledRejection');
    expect(String(records[0].message)).toContain('裸字符串原因');
    expect(String(records[1].message)).toContain('42');
    expect(String(records[1].message)).toContain('对象原因');
  });

  it('render-process-gone / child-process-gone：reason 与 exitCode 落盘', () => {
    initDiagLogger(userData);
    const wiring = createCrashWiring();

    wiring.renderProcessGone({ reason: 'crashed', exitCode: 133 });
    wiring.childProcessGone({ type: 'GPU', reason: 'crashed', exitCode: 1, serviceName: 'gpu-process' });

    const records = readRecords();
    expect(records).toHaveLength(2);
    expect(records[0].kind).toBe('render-process-gone');
    expect(records[0].reason).toBe('crashed');
    expect(records[0].exitCode).toBe(133);
    expect(records[1].kind).toBe('child-process-gone');
    expect(String(records[1].message)).toContain('gpu-process');
  });

  it('crash.log 追加不截断历史（多次崩溃逐条累积）', () => {
    initDiagLogger(userData);
    const wiring = createCrashWiring();
    for (let i = 0; i < 5; i++) wiring.renderProcessGone({ reason: `crashed-${i}`, exitCode: 1 });
    expect(readRecords()).toHaveLength(5);
  });

  it('无活动 logger（未初始化）→ 记录返回 null 且不抛、不建文件', () => {
    setActiveDiagLogger(null);
    const wiring = createCrashWiring();
    expect(() => wiring.uncaughtException(new Error('无 logger'))).not.toThrow();
    expect(wiring.uncaughtException(new Error('无 logger'))).toBeNull();
    expect(existsSync(crashLog)).toBe(false);
  });

  it('崩溃记录同样过密钥脱敏', () => {
    initDiagLogger(userData);
    const wiring = createCrashWiring();
    wiring.uncaughtException(new Error('request failed key=sk-abcdefghijklmnopqrstuvwxyz012345'));
    expect(readFileSync(crashLog, 'utf8')).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345');
  });

  it('formatCrashRecord 纯函数：单行、可注入时间', () => {
    const line = formatCrashRecord(
      { kind: 'render-process-gone', message: 'x\ny', reason: 'crashed', exitCode: 9 },
      new Date('2026-09-24T00:00:00.000Z'),
    );
    expect(line.includes('\n')).toBe(false);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.ts).toBe('2026-09-24T00:00:00.000Z');
    expect(parsed.kind).toBe('render-process-gone');
    expect(parsed.exitCode).toBe(9);
  });

  it('CrashWiring 可注入日志目录（不依赖活动单例）', () => {
    const dir = join(root, 'explicit-logs');
    const wiring = new CrashWiring(() => dir);
    wiring.uncaughtException(new Error('显式目录'));
    expect(existsSync(join(dir, CRASH_LOG_NAME))).toBe(true);
  });
});

describe('0066 主进程崩溃接线（源码级断言）', () => {
  const mainSrc = () => readFileSync(join(shellDir, 'main.ts'), 'utf8');

  it('main.ts 接过四类事件 + crashReporter + logger 初始化 + IPC 收口', () => {
    const src = mainSrc();
    expect(src).toContain("process.on('uncaughtException'");
    expect(src).toContain("process.on('unhandledRejection'");
    expect(src).toContain("app.on('child-process-gone'");
    expect(src).toContain("app.on('render-process-gone'");
    expect(src).toContain("webContents.on('render-process-gone'");
    expect(src).toContain('crashReporter.start');
    expect(src).toContain('initDiagLogger(');
    expect(src).toContain('installIpcErrorLogging(');
    // 落盘后不自杀（保持现状行为：只多落盘）
    expect(src).not.toContain('process.exit(');
  });

  it('渲染进程崩溃给用户可见提示（dialog 重载入口，不新造 UI 体系）', () => {
    const src = mainSrc();
    expect(src).toContain('showMessageBox');
    expect(src).toContain('reload()');
  });

  it('crash.ts 自身不 process.exit / 不 import electron（纯记录层，可单测）', () => {
    const src = readFileSync(join(shellDir, 'diag', 'crash.ts'), 'utf8');
    expect(src).not.toContain('process.exit(');
    expect(src).not.toContain("from 'electron'");
  });
});
