// 0071 自定义数据保存位置（R-043）：引导配置 + 启动重定向 + pending 迁移（重启后执行）。
//
// 设计口径（任务书 §一；全部为纯 Node，零 electron 依赖——主进程只把 app.getPath 结果与
// app.setPath 副作用接在外面，故本模块可在 vitest 里用真 fs 直接测）：
//  - 引导配置落 <appData>/mofang-assistant/data-location.json —— 在 userData 之外（appData 不受
//    app.setPath('userData') 影响），换位置后仍读得到自己；读写走「临时文件 + rename」防半截。
//  - 配置值即 userData 本体：数据落 <配置值>/data、日志 <配置值>/logs、登录态分区跟随。
//  - 迁移一律「下次启动、db 未开、零句柄」时执行：备份 → 复制 → 校验 → 校验过才翻转配置。
//    校验不过或中途失败 = 配置不动、仍用原位置启动（错误进 app.log + 落 lastMigrationError 供设置页可见）。
//  - 旧目录保留不删（迁移备份也留在旧位置的 backups/，不随迁移重复占空间）。

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, win32 } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  VOLATILE_RUNTIME_ENTRIES,
  copyTree,
  isEmptyDirOrMissing,
  listFilesWithSizes,
  type CopyTreeReport,
} from '../guard/fs-utils.js';
import type {
  DataLocationCancelResult,
  DataLocationChangeResult,
  DataLocationInfo,
  DataLocationSource,
} from '../shared/contracts/ipc-channels.js';

/** 引导配置目录名（appData 下；与 Electron 默认 userData 同名是巧合，不经 userData 解析） */
export const DATA_LOCATION_CONFIG_DIR = 'mofang-assistant';
/** 引导配置文件（形态 { dataRoot?, pendingDataRoot?, lastMigrationError? }） */
export const DATA_LOCATION_CONFIG_FILE = 'data-location.json';
/** 便携版默认数据目录名（PORTABLE_EXECUTABLE_DIR 之下） */
export const PORTABLE_DATA_DIR = 'mofang-data';
/** 迁移进行中标记（目标根下的哨兵：它存在 = 该目录由迁移流程创建/可能半成品，重试可安全清空） */
export const MIGRATION_MARKER = '.mofang-migrating';
/** 迁移面顶层排除项：备份目录与引导配置本体（旧位置留档，不随迁移再搬一份） */
export const MIGRATION_EXCLUDED_TOP_LEVEL: ReadonlySet<string> = new Set(['backups', DATA_LOCATION_CONFIG_FILE]);

export interface DataLocationConfig {
  /** 正式生效的数据位置（= userData 本体）；缺省 = 用系统默认位置 */
  dataRoot?: string;
  /** 待迁移目标（设置页写入、重启后执行）；迁移成功即被清空 */
  pendingDataRoot?: string;
  /** 上次迁移失败留痕（设置页可见；成功即清） */
  lastMigrationError?: { at: string; message: string };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 跨平台路径是否为绝对路径（支持 Windows 盘符与 UNC 路径以及 POSIX / 根路径） */
export function isPathAbsolute(p: string): boolean {
  return isAbsolute(p) || win32.isAbsolute(p);
}

function isWindowsStylePath(p: string): boolean {
  return process.platform === 'win32' || /^[a-zA-Z]:[\\/]/.test(p);
}

/** Windows 盘符大小写不敏感口径的同一路径判定 */
function samePath(a: string, b: string): boolean {
  if (isWindowsStylePath(a) || isWindowsStylePath(b)) {
    return win32.resolve(a).toLowerCase() === win32.resolve(b).toLowerCase();
  }
  const na = resolve(a);
  const nb = resolve(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/** child 是否位于 parent 之下（不含相等） */
function isSubPath(child: string, parent: string): boolean {
  if (isWindowsStylePath(child) || isWindowsStylePath(parent)) {
    const rel = win32.relative(win32.resolve(parent), win32.resolve(child));
    return rel !== '' && !rel.startsWith('..') && !win32.isAbsolute(rel);
  }
  const rel = relative(resolve(parent), resolve(child));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** 读引导配置：缺文件=无配置；坏 JSON/形态非法 → 空配置 + error（绝不抛——坏配置不许炸启动） */
export function readDataLocationConfig(configPath: string): { config: DataLocationConfig; error: string | null } {
  let raw: string;
  try {
    if (!existsSync(configPath)) return { config: {}, error: null };
    raw = readFileSync(configPath, 'utf8');
  } catch (err) {
    return { config: {}, error: `读取失败：${messageOf(err)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { config: {}, error: `JSON 解析失败：${messageOf(err)}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { config: {}, error: '配置形态非法（应为 JSON 对象）' };
  }

  const record = parsed as Record<string, unknown>;
  const config: DataLocationConfig = {};
  const errors: string[] = [];
  for (const key of ['dataRoot', 'pendingDataRoot'] as const) {
    const value = record[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || value.trim() === '') {
      errors.push(`${key} 应为非空字符串`);
      continue;
    }
    config[key] = value.trim();
  }
  const lastError = record.lastMigrationError;
  if (lastError !== undefined && lastError !== null) {
    const rec = lastError as Record<string, unknown>;
    if (rec && typeof rec === 'object' && typeof rec.message === 'string') {
      config.lastMigrationError = { at: typeof rec.at === 'string' ? rec.at : '', message: rec.message };
    }
  }
  return { config, error: errors.length > 0 ? errors.join('；') : null };
}

/** 写引导配置（临时文件 + rename，防半截）；字段缺省 = 删除该字段 */
export function writeDataLocationConfig(configPath: string, config: DataLocationConfig): void {
  mkdirSync(dirname(configPath), { recursive: true });
  const payload: DataLocationConfig = {};
  if (config.dataRoot !== undefined) payload.dataRoot = config.dataRoot;
  if (config.pendingDataRoot !== undefined) payload.pendingDataRoot = config.pendingDataRoot;
  if (config.lastMigrationError !== undefined) payload.lastMigrationError = config.lastMigrationError;
  const tmpPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  renameSync(tmpPath, configPath);
}

/** 目录可建且可写（写探针文件后即刻删除；只读介质/Program Files 在此判失败） */
function ensureWritableDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.mofang-write-probe-${process.pid}-${Date.now()}`);
    writeFileSync(probe, 'ok', 'utf8');
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

export interface BootstrapEnv {
  /** 引导配置落点（appData/mofang-assistant/data-location.json） */
  configPath: string;
  /** 系统默认 userData（= app.getPath('userData')，本机制介入之前的值） */
  defaultUserDataPath: string;
  /** PORTABLE_EXECUTABLE_DIR（便携版启动器注入；非便携 = undefined） */
  portableDir?: string;
}

export interface BootstrapPlan {
  /** 读到的配置（dataRoot 若不可用已剔除；pending 原样保留） */
  config: DataLocationConfig;
  /** 本次生效的 userData 根（调用方 app.setPath('userData', plan.userDataPath)） */
  userDataPath: string;
  /** 生效来源：config=用户自定义 / portable=便携版默认 / default=系统默认 */
  source: DataLocationSource;
  /** 本次启动应执行的迁移目标（null = 无 / 不可执行） */
  pendingDataRoot: string | null;
  /** 回退、坏配置、自愈等要向 app.log 交代的条目 */
  warnings: string[];
}

/**
 * 启动解析：配置（优先）→ 便携版默认 → 系统默认；并自查 pending 两处退化
 * （与生效位置相同=已完成；非绝对路径=不可执行）。
 * 只读 + 最多建一次目录（不写配置）——除「pending == 生效位置」的自愈清除。
 */
export function resolveBootstrapPlan(env: BootstrapEnv): BootstrapPlan {
  const warnings: string[] = [];
  const read = readDataLocationConfig(env.configPath);
  const config: DataLocationConfig = { ...read.config };
  if (read.error) warnings.push(`引导配置不可用（${read.error}），按默认位置启动`);

  let userDataPath: string | null = null;
  let source: DataLocationSource = 'default';

  if (config.dataRoot !== undefined) {
    if (!isPathAbsolute(config.dataRoot)) {
      warnings.push(`配置的数据位置不是绝对路径（${config.dataRoot}），按默认位置启动`);
      delete config.dataRoot;
    } else if (ensureWritableDir(config.dataRoot)) {
      userDataPath = config.dataRoot;
      source = 'config';
    } else {
      warnings.push(`配置的数据位置不可用（${config.dataRoot}），本次回退默认位置启动`);
      delete config.dataRoot;
    }
  }

  if (userDataPath === null && env.portableDir) {
    const portableRoot = join(env.portableDir, PORTABLE_DATA_DIR);
    if (ensureWritableDir(portableRoot)) {
      userDataPath = portableRoot;
      source = 'portable';
    } else {
      warnings.push(`便携版数据目录不可写（${portableRoot}），回退系统默认位置`);
    }
  }

  if (userDataPath === null) {
    userDataPath = env.defaultUserDataPath;
    source = 'default';
  }

  let pendingDataRoot = config.pendingDataRoot ?? null;
  if (pendingDataRoot !== null && samePath(pendingDataRoot, userDataPath)) {
    warnings.push(`待迁移目标与当前位置相同（${pendingDataRoot}），已按完成处理并清除`);
    pendingDataRoot = null;
    const repaired: DataLocationConfig = { ...config };
    delete repaired.pendingDataRoot;
    try {
      writeDataLocationConfig(env.configPath, repaired);
      delete config.pendingDataRoot;
    } catch (err) {
      warnings.push(`清除待迁移配置失败：${messageOf(err)}`);
    }
  } else if (pendingDataRoot !== null && !isPathAbsolute(pendingDataRoot)) {
    warnings.push(`待迁移目标不是绝对路径（${pendingDataRoot}），本次跳过迁移`);
    pendingDataRoot = null;
  }

  return { config, userDataPath, source, pendingDataRoot, warnings };
}

export type TargetVerdict = { ok: true } | { ok: false; error: string };

/**
 * 目标目录校验（设置页选目录时）：必须是空的 / 不存在的绝对路径，
 * 且不得与当前位置互为包含（递归复制隐患）。
 */
export function validateTargetDir(target: string, currentUserData: string): TargetVerdict {
  const value = (target ?? '').trim();
  if (value === '') return { ok: false, error: '请选择目标目录' };
  if (!isPathAbsolute(value)) return { ok: false, error: '目标目录必须是绝对路径' };
  if (samePath(value, currentUserData)) {
    return { ok: false, error: '目标目录与当前数据位置相同，无需更改' };
  }
  if (isSubPath(value, currentUserData)) {
    return { ok: false, error: '目标目录在当前数据位置之内，会造成递归复制，请另选目录' };
  }
  if (isSubPath(currentUserData, value)) {
    return { ok: false, error: '当前数据位置在该目录之内（相当于把数据搬进自身父级），请另选目录' };
  }
  if (!isEmptyDirOrMissing(value)) {
    return { ok: false, error: '目标目录非空（必须选空目录或不存在的路径，请先清空或另选）' };
  }
  return { ok: true };
}

export interface MigrationDeps {
  /** 整棵树复制（生产 = guard/fs-utils.copyTree：目录递归 / 顶层普通文件直拷 / 符号链接按目标分类，
   *  并返回复制清单与跳过清单）；与恢复链的 copyDirectory 同一文件域、各自语义清晰 */
  copyTree: (src: string, dest: string, options: { excludeNames: ReadonlySet<string>; skipNames: ReadonlySet<string> }) => CopyTreeReport;
  /** 迁移前备份产出（生产 = guard/backup-service.createBackup 出 zip；抛错/reject = 失败，迁移中止） */
  createPreMigrationBackup: (params: { dataDir: string; outputPath: string }) => void | Promise<void>;
}

export interface MigrationResult {
  ok: boolean;
  error?: string;
  /** 迁移前备份 zip 落点（旧位置 backups/） */
  backupPath?: string;
  copiedFiles?: number;
  copiedBytes?: number;
  /** 跳过项（运行期易变条目/悬空链接/复制期间消失；调用方落日志——不静默丢文件） */
  skipped?: string[];
}

/** bank.db 快速校验面（版本 + 行数；只读打开，不跑全量 integrity_check——那是几十秒级的全扫） */
function quickDbFacts(dbPath: string): { userVersion: number; questions: number; papers: number } | null {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const userVersion = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    const questions = (db.prepare('SELECT COUNT(*) AS c FROM questions WHERE deleted = 0').get() as { c: number }).c;
    const papers = (db.prepare('SELECT COUNT(*) AS c FROM papers').get() as { c: number }).c;
    return { userVersion, questions, papers };
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* 已关闭/从未打开 */
    }
  }
}

/**
 * 迁移校验：目标清单逐条比对**复制时记录的源清单**（不受复制后源目录变化干扰）+ bank.db 快速打开与行数咬合。
 * 清单口径与复制面同源（同一 excludeNames/skipNames 策略：运行期易变条目与悬空链接两边都不计）。
 */
function verifyMigrationCopy(
  from: string,
  to: string,
  copied: Map<string, number>,
): { ok: true; files: number; bytes: number } | { ok: false; error: string } {
  const dst = listFilesWithSizes(to, {
    excludeNames: MIGRATION_EXCLUDED_TOP_LEVEL,
    skipNames: VOLATILE_RUNTIME_ENTRIES,
  });
  dst.delete(MIGRATION_MARKER); // 迁移标记不算产物

  for (const [rel, size] of copied) {
    const got = dst.get(rel);
    if (got === undefined) return { ok: false, error: `目标缺文件：${rel}` };
    if (got !== size) return { ok: false, error: `字节数不符：${rel}（源 ${size} / 目标 ${got}）` };
  }
  for (const rel of dst.keys()) {
    if (!copied.has(rel)) return { ok: false, error: `目标多出文件：${rel}` };
  }

  if (copied.has('data/bank.db')) {
    const before = quickDbFacts(join(from, 'data', 'bank.db'));
    const after = quickDbFacts(join(to, 'data', 'bank.db'));
    if (before === null || after === null) return { ok: false, error: '目标数据库无法打开（data/bank.db）' };
    if (before.userVersion !== after.userVersion) {
      return { ok: false, error: `数据库 schema 版本不符（源 ${before.userVersion} / 目标 ${after.userVersion}）` };
    }
    if (before.questions !== after.questions || before.papers !== after.papers) {
      return {
        ok: false,
        error: `数据库行数不符（题 ${before.questions}→${after.questions}，卷 ${before.papers}→${after.papers}）`,
      };
    }
  }

  let bytes = 0;
  for (const size of dst.values()) bytes += size;
  return { ok: true, files: dst.size, bytes };
}

function migrationStamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

/**
 * 执行 pending 迁移（重启后、db 未开、零句柄时由主进程调用）。
 * 步骤：目标就绪（半成品清空重来）→ 写迁移标记 → 迁移前备份（落旧位置）→ 复制 → 校验 → 翻转配置。
 * 任何一步失败 = ok:false 且 **配置不动**（原位置照常启动；pending 保留，下次再试）；
 * 失败原因同时落 lastMigrationError 供设置页展示。
 */
export async function runPendingMigration(
  input: { configPath: string; fromUserData: string; toRoot: string },
  deps: MigrationDeps,
  now: () => Date = () => new Date(),
): Promise<MigrationResult> {
  const { configPath, fromUserData, toRoot } = input;
  const markerPath = join(toRoot, MIGRATION_MARKER);

  const recordFailure = (message: string, backupPath?: string, skipped?: string[]): MigrationResult => {
    const read = readDataLocationConfig(configPath);
    try {
      writeDataLocationConfig(configPath, {
        ...read.config,
        lastMigrationError: { at: now().toISOString(), message },
      });
    } catch {
      // 留痕失败不得掩盖迁移失败本身
    }
    return { ok: false, error: message, backupPath, ...(skipped ? { skipped } : {}) };
  };

  try {
    // 1. 目标就绪：已有内容时，只有「上次未完成的迁移」（标记在）才允许清空重来
    if (existsSync(toRoot)) {
      if (!statSync(toRoot).isDirectory()) return recordFailure(`目标路径不是目录：${toRoot}`);
      if (readdirSync(toRoot).length > 0) {
        if (!existsSync(markerPath)) {
          return recordFailure(`目标目录已有内容（非上次未完成的迁移），本次不迁移：${toRoot}`);
        }
        rmSync(toRoot, { recursive: true, force: true });
      }
    }
    mkdirSync(toRoot, { recursive: true });
    writeFileSync(markerPath, `${JSON.stringify({ startedAt: now().toISOString(), from: fromUserData, to: toRoot })}\n`, 'utf8');

    // 2. 迁移前备份（旧位置 backups/；失败即中止——宁可不迁，也不留没有退路的现场）
    const backupPath = join(fromUserData, 'backups', `mofang-migrate-${migrationStamp(now())}.mofang-backup.zip`);
    try {
      // 备份目录由本流程保证存在（备份实现只管写文件）
      mkdirSync(dirname(backupPath), { recursive: true });
      await deps.createPreMigrationBackup({ dataDir: join(fromUserData, 'data'), outputPath: backupPath });
    } catch (err) {
      return recordFailure(`迁移前备份失败：${messageOf(err)}`, backupPath);
    }

    // 3. 复制（整棵树；顶层排除 backups/ 与引导配置本体，跳过运行期易变条目并记录）
    let copied: Map<string, number>;
    let skipped: string[];
    try {
      const report: CopyTreeReport = deps.copyTree(fromUserData, toRoot, {
        excludeNames: MIGRATION_EXCLUDED_TOP_LEVEL,
        skipNames: VOLATILE_RUNTIME_ENTRIES,
      });
      copied = report.files;
      skipped = report.skipped;
    } catch (err) {
      return recordFailure(`复制失败：${messageOf(err)}`, backupPath);
    }

    // 4. 校验（目标清单 == 复制清单；bank.db 另做快速打开/行数咬合）
    const verify = verifyMigrationCopy(fromUserData, toRoot, copied);
    if (!verify.ok) return recordFailure(`迁移校验未通过：${verify.error}`, backupPath, skipped);

    // 5. 翻转配置（清 pending + 清上次失败留痕），再摘标记——顺序反了会在「翻转失败」时留下
    //    「目标非空且无标记」的死局；按此顺序，翻转失败的下次启动仍可清空重来。
    writeDataLocationConfig(configPath, { dataRoot: toRoot });
    try {
      rmSync(markerPath, { force: true });
    } catch {
      // 标记残留无碍：pending 已清，后续启动不会再走迁移分支
    }

    return { ok: true, backupPath, copiedFiles: verify.files, copiedBytes: verify.bytes, skipped };
  } catch (err) {
    return recordFailure(messageOf(err));
  }
}

// ============================================================================
// 设置页通道逻辑（get / change / cancel；主进程接线层只负责弹窗与形验转发）
// ============================================================================

export interface DataLocationRuntime {
  configPath: string;
  /** 本进程生效的 userData 根（启动解析结果，进程内不变） */
  userDataPath: string;
  source: DataLocationSource;
  /** 便携版运行（PORTABLE_EXECUTABLE_DIR 存在） */
  portable: boolean;
}

export function describeDataLocation(runtime: DataLocationRuntime): DataLocationInfo {
  const read = readDataLocationConfig(runtime.configPath);
  return {
    userDataPath: runtime.userDataPath,
    source: runtime.source,
    dataRoot: read.config.dataRoot ?? null,
    pendingDataRoot: read.config.pendingDataRoot ?? null,
    lastMigrationError: read.config.lastMigrationError?.message ?? null,
    portable: runtime.portable,
  };
}

/** 选定目标目录：校验通过才写入 pending（正式生效的 dataRoot 不动，等重启迁移成功再翻转） */
export function changeDataLocation(runtime: DataLocationRuntime, targetDir: string): DataLocationChangeResult {
  const verdict = validateTargetDir(targetDir, runtime.userDataPath);
  if (!verdict.ok) return { success: false, error: verdict.error };

  const read = readDataLocationConfig(runtime.configPath);
  const next: DataLocationConfig = { ...read.config, pendingDataRoot: resolve(targetDir) };
  try {
    writeDataLocationConfig(runtime.configPath, next);
  } catch (err) {
    return { success: false, error: `写入引导配置失败：${messageOf(err)}` };
  }
  return { success: true, pendingDataRoot: resolve(targetDir) };
}

/** 撤销待迁移（保留正式生效位置） */
export function cancelDataLocationChange(runtime: DataLocationRuntime): DataLocationCancelResult {
  const read = readDataLocationConfig(runtime.configPath);
  const next: DataLocationConfig = {};
  if (read.config.dataRoot !== undefined) next.dataRoot = read.config.dataRoot;
  try {
    writeDataLocationConfig(runtime.configPath, next);
  } catch (err) {
    return { success: false, error: `写入引导配置失败：${messageOf(err)}` };
  }
  return { success: true };
}
