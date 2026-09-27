// 0066 可运维性一期（R-002）：主进程极简日志（自研，零依赖）+ IPC 错误路径收口。
//
// 设计口径（任务书 §一.1；交付报告 §三登记）：
//  - 落点固定 <userData>/logs/app.log（不与 app.getPath('logs') 混用——smoke 重定向后依然可定位）；
//  - 行格式 = 单行 JSON（ts/level/module/message/meta），便于 grep 与后续解析；
//  - 单文件 ≤2MB、保留 ≤3 代（app.log.1 ~ app.log.3），滚动时机 = init() 探一次 + 每次写入前预判；
//  - 落盘失败一律吞掉（日志不许反过来把主进程拖垮）；写入前后皆过 scrubSecrets（诊断包合规第二道闸）；
//  - 本模块零 electron 依赖（target 以结构性接口传入），故可在 node 环境直接单测。

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DIAG_LOG_DIR_NAME = 'logs';
export const DIAG_APP_LOG_NAME = 'app.log';
export const DIAG_CRASH_LOG_NAME = 'crash.log';
/** 单文件上限（字节） */
export const DIAG_LOG_MAX_BYTES = 2 * 1024 * 1024;
/** 保留代数上限（app.log.1 ~ app.log.N；最老代被弃） */
export const DIAG_LOG_MAX_GENERATIONS = 3;
/** 单条 message 字符上限（防异常对象把文件撑爆） */
const MAX_MESSAGE_CHARS = 4000;

export type DiagLevel = 'info' | 'warn' | 'error';

export interface DiagLoggerOptions {
  /** userData 根（与 app.getPath('userData') 同源；日志落 <userData>/logs） */
  userDataPath?: string;
  /** 直接指定日志目录（优先于 userDataPath） */
  logDir?: string;
  maxBytes?: number;
  maxGenerations?: number;
  /** 同步回显到 console（开发态用；打包态只落盘） */
  echo?: boolean;
  now?: () => Date;
}

/** ipcMain 的最小结构面（本模块不 import electron，主进程把真 ipcMain 传进来） */
export interface IpcHandlerRegistrar {
  handle(channel: string, listener: (...args: unknown[]) => unknown): unknown;
}

/** 密钥脱敏（诊断包合规：日志与包内容都不得出现明文 Key / 令牌 / Cookie 值） */
export function scrubSecrets(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-***')
    .replace(
      /(\b(?:api[-_]?key|apikey|key|token|secret|password|passwd)\s*[:=]\s*"?)([^"\s,;]{4,})/gi,
      '$1***',
    )
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer ***')
    .replace(
      /(\b(?:sessionid|session|cookie|csrftoken)\s*[:=]\s*"?)([^";\s,]{3,})/gi,
      '$1***',
    );
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export class DiagLogger {
  readonly logDir: string;
  private readonly maxBytes: number;
  private readonly maxGenerations: number;
  private readonly echo: boolean;
  private readonly now: () => Date;
  private bytes = 0;
  private ready = false;

  constructor(options: DiagLoggerOptions = {}) {
    const dir = options.logDir ?? (options.userDataPath ? join(options.userDataPath, DIAG_LOG_DIR_NAME) : '');
    if (!dir) throw new Error('DiagLogger 需要 userDataPath 或 logDir');
    this.logDir = dir;
    this.maxBytes = options.maxBytes ?? DIAG_LOG_MAX_BYTES;
    this.maxGenerations = options.maxGenerations ?? DIAG_LOG_MAX_GENERATIONS;
    this.echo = options.echo ?? false;
    this.now = options.now ?? (() => new Date());
  }

  appLogPath(): string {
    return join(this.logDir, DIAG_APP_LOG_NAME);
  }

  crashLogPath(): string {
    return join(this.logDir, DIAG_CRASH_LOG_NAME);
  }

  /** 建目录 + 启动时滚动（幂等；失败不抛——日志不许阻断启动） */
  init(): this {
    try {
      mkdirSync(this.logDir, { recursive: true });
      this.bytes = existsSync(this.appLogPath()) ? statSync(this.appLogPath()).size : 0;
      this.ready = true;
      if (this.bytes > this.maxBytes) this.rotate();
    } catch {
      this.ready = false;
    }
    return this;
  }

  /** 滚动一代：app.log.(N-1)→.N …→ app.log.1，app.log→app.log.1，最老代被弃 */
  rotate(): boolean {
    try {
      const genPath = (i: number): string => join(this.logDir, `${DIAG_APP_LOG_NAME}.${i}`);
      const oldest = genPath(this.maxGenerations);
      if (existsSync(oldest)) rmSync(oldest, { force: true });
      for (let i = this.maxGenerations - 1; i >= 1; i--) {
        if (existsSync(genPath(i))) renameSync(genPath(i), genPath(i + 1));
      }
      if (existsSync(this.appLogPath())) renameSync(this.appLogPath(), genPath(1));
      // 只可能发生在「上一版/外部写入留下的超大 app.log」上：归档同样受单文件上限约束
      // （保留末尾=最新的那段，按行首对齐）
      this.truncateArchive(genPath(1));
      writeFileSync(this.appLogPath(), '');
      this.bytes = 0;
      return true;
    } catch {
      return false;
    }
  }

  private truncateArchive(path: string): void {
    try {
      if (!existsSync(path)) return;
      const size = statSync(path).size;
      if (size <= this.maxBytes) return;
      const tail = readFileSync(path).subarray(size - this.maxBytes).toString('utf8');
      const firstBreak = tail.indexOf('\n');
      writeFileSync(path, firstBreak >= 0 ? tail.slice(firstBreak + 1) : tail, 'utf8');
    } catch {
      // 截断失败不阻断滚动
    }
  }

  /** 写一行（返回落盘行原文，供测试与调用方复用；落盘失败返回该行但不抛） */
  log(level: DiagLevel, module: string, message: string, meta?: Record<string, unknown>): string {
    const entry: Record<string, unknown> = {
      ts: this.now().toISOString(),
      level,
      module,
      message: message.length > MAX_MESSAGE_CHARS ? `${message.slice(0, MAX_MESSAGE_CHARS)}…[截断]` : message,
    };
    if (meta && Object.keys(meta).length > 0) entry.meta = meta;
    const line = scrubSecrets(JSON.stringify(entry));

    if (this.echo) {
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else console.log(line);
    }

    try {
      if (!this.ready) this.init();
      const size = Buffer.byteLength(line, 'utf8') + 1;
      if (this.bytes + size > this.maxBytes) this.rotate();
      appendFileSync(this.appLogPath(), `${line}\n`);
      this.bytes += size;
    } catch {
      // 落盘失败不阻断主流程（磁盘满/权限/目录被占）
    }
    return line;
  }

  info(module: string, message: string, meta?: Record<string, unknown>): string {
    return this.log('info', module, message, meta);
  }

  warn(module: string, message: string, meta?: Record<string, unknown>): string {
    return this.log('warn', module, message, meta);
  }

  error(module: string, message: string, meta?: Record<string, unknown>): string {
    return this.log('error', module, message, meta);
  }

  /** 当前在写字节数（含已滚动历史不计） */
  byteSize(): number {
    return this.bytes;
  }
}

let activeLogger: DiagLogger | null = null;

/** 装/卸活动 logger（null=卸下；未装时 diagLog 静默） */
export function setActiveDiagLogger(logger: DiagLogger | null): void {
  activeLogger = logger;
}

export function getActiveDiagLogger(): DiagLogger | null {
  return activeLogger;
}

/** 主进程启动点调用：按（重定向后的）userData 初始化并装为活动实例 */
export function initDiagLogger(
  userDataPath: string,
  options: Omit<DiagLoggerOptions, 'userDataPath'> = {},
): DiagLogger {
  const logger = new DiagLogger({ ...options, userDataPath });
  logger.init();
  activeLogger = logger;
  return logger;
}

/** 便捷写入口（无活动实例时静默 no-op：测试/非主进程环境零副作用） */
export function diagLog(
  level: DiagLevel,
  module: string,
  message: string,
  meta?: Record<string, unknown>,
): string | null {
  const logger = activeLogger;
  if (!logger) return null;
  try {
    return logger.log(level, module, message, meta);
  } catch {
    return null;
  }
}

/**
 * IPC 错误路径收口：包住 ipcMain.handle，让所有通道的 handler 异常统一过日志后再原样抛出
 * （不逐点改写各注册器；必须在 register* 之前调用一次）。
 */
export function installIpcErrorLogging(target: IpcHandlerRegistrar, logger: DiagLogger | null = null): void {
  const original = target.handle.bind(target);
  const write = (message: string, meta: Record<string, unknown>): void => {
    if (logger) logger.error('ipc', message, meta);
    else diagLog('error', 'ipc', message, meta);
  };

  target.handle = (channel: string, listener: (...args: unknown[]) => unknown): unknown =>
    original(channel, async (...args: unknown[]) => {
      try {
        return await listener(...args);
      } catch (err) {
        const detail = errorText(err);
        write(`${channel} 处理失败：${detail}`, { channel, error: detail });
        throw err;
      }
    });
}
