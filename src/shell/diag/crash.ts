// 0066 可运维性一期（R-002）：崩溃捕获落盘（crash.log）。
//
// 分工：本文件只做「事件 → 记录」的纯记录层（零 electron 依赖、零 process 全局、绝不 process.exit），
// main.ts 负责把 Electron 的四类事件接进来（uncaughtException / unhandledRejection /
// render-process-gone / child-process-gone）。任务书 §一.2：落盘后保持现状行为，只多落盘。

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DIAG_CRASH_LOG_NAME, diagLog, getActiveDiagLogger, scrubSecrets } from './logger.js';

/** crash.log 文件名（与 logger 侧同源常量，避免两处漂移） */
export const CRASH_LOG_NAME = DIAG_CRASH_LOG_NAME;

export type CrashKind =
  | 'uncaughtException'
  | 'unhandledRejection'
  | 'render-process-gone'
  | 'child-process-gone';

export interface CrashRecordInput {
  kind: CrashKind;
  message: string;
  reason?: string;
  exitCode?: number;
  stack?: string;
  details?: Record<string, unknown>;
}

export interface CrashRecord extends CrashRecordInput {
  ts: string;
}

/** 任意抛出物 → 可读消息 + 栈（字符串/普通对象/undefined 都不漏记） */
export function describeUnknown(value: unknown): { message: string; stack?: string } {
  if (value instanceof Error) return { message: value.message, stack: value.stack };
  if (typeof value === 'string') return { message: value };
  if (value === null || value === undefined) return { message: String(value) };
  try {
    return { message: JSON.stringify(value) };
  } catch {
    return { message: String(value) };
  }
}

/** Electron 事件 details 的宽松取值（只认感兴趣的四个字段，其余不落盘） */
function pickDetails(details: unknown): {
  reason?: string;
  exitCode?: number;
  type?: string;
  serviceName?: string;
  extra: Record<string, unknown>;
} {
  if (!details || typeof details !== 'object') return { extra: {} };
  const raw = details as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  const extra: Record<string, unknown> = {};
  if (str(raw.type)) extra.type = str(raw.type);
  if (str(raw.serviceName)) extra.serviceName = str(raw.serviceName);
  return {
    reason: str(raw.reason),
    exitCode: num(raw.exitCode),
    type: str(raw.type),
    serviceName: str(raw.serviceName),
    extra,
  };
}

/** 单行 JSON 记录（脱敏；可注入时间供断言） */
export function formatCrashRecord(input: CrashRecordInput, now: Date = new Date()): string {
  const record: CrashRecord = { ts: now.toISOString(), ...input };
  return scrubSecrets(JSON.stringify(record));
}

/** 追加一条到 <logDir>/crash.log（失败返回 false，不抛） */
export function appendCrashRecord(logDir: string, line: string): boolean {
  try {
    mkdirSync(logDir, { recursive: true });
    appendFileSync(join(logDir, CRASH_LOG_NAME), `${line}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * 崩溃接线器：把 Electron/Node 事件转成 crash.log 记录 + app.log 的 error 行。
 * 返回值为记录（日志目录缺失时 null）——调用方据此决定是否给用户提示。
 */
export class CrashWiring {
  constructor(private readonly resolveLogDir: () => string | null) {}

  record(input: CrashRecordInput): CrashRecord | null {
    const dir = this.resolveLogDir();
    if (!dir) return null;
    const record: CrashRecord = { ts: new Date().toISOString(), ...input };
    const line = scrubSecrets(JSON.stringify(record));
    appendCrashRecord(dir, line);
    diagLog('error', 'crash', `${input.kind}：${input.message}`, {
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
    });
    return record;
  }

  uncaughtException(error: unknown): CrashRecord | null {
    const { message, stack } = describeUnknown(error);
    return this.record({ kind: 'uncaughtException', message, stack });
  }

  unhandledRejection(reason: unknown): CrashRecord | null {
    const { message, stack } = describeUnknown(reason);
    return this.record({ kind: 'unhandledRejection', message, stack });
  }

  renderProcessGone(details: unknown): CrashRecord | null {
    const picked = pickDetails(details);
    return this.record({
      kind: 'render-process-gone',
      message: `渲染进程退出（reason=${picked.reason ?? 'unknown'}，exitCode=${picked.exitCode ?? 'unknown'}）`,
      reason: picked.reason,
      exitCode: picked.exitCode,
    });
  }

  childProcessGone(details: unknown): CrashRecord | null {
    const picked = pickDetails(details);
    return this.record({
      kind: 'child-process-gone',
      message: `子进程退出（type=${picked.type ?? 'unknown'}，reason=${picked.reason ?? 'unknown'}，service=${picked.serviceName ?? '-'}）`,
      reason: picked.reason,
      exitCode: picked.exitCode,
      details: picked.extra,
    });
  }
}

/** 主进程用：日志目录取活动 logger（未初始化时记录自动降级为 no-op） */
export function createCrashWiring(): CrashWiring {
  return new CrashWiring(() => getActiveDiagLogger()?.logDir ?? null);
}
