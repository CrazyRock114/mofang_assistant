// 0066 可运维性一期（R-002）：诊断包组装（自研 ZIP，零新依赖）。
//
// 包内固定面（任务书 §零.8）：
//   manifest.json          版本/平台/arch/Electron/时间戳 + 各表行数（脱敏统计）+ 包内文件清单 + 排除面自述
//   logs/app.log[.N]       app.log 全量 + 轮转代（诊断「崩溃/轮转前发生了什么」）
//   logs/crash.log         崩溃记录
//   logs/capture-*.log     采集层两份既有 log 的尾段（≤256KB，最老内容裁掉并登记 truncated）
//
// 硬排除（红线）：题库原库及备份、图片资产、识别 run 素材、切题工作区、采集登录态分区、
// 模型档案的 API Key 密文列（本模块只取各表行数，从不读任何列值）、Electron 缓存与崩溃转储、
// 采集 HTML 快照。sqlite 行数统计由调用方注入（bank 层唯一碰 SQL 的纪律经注入面保持）。

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createZip, type ZipEntry } from '../../guard/zip-utils.js';
import {
  DIAG_APP_LOG_NAME,
  DIAG_CRASH_LOG_NAME,
  DIAG_LOG_DIR_NAME,
  DIAG_LOG_MAX_GENERATIONS,
  scrubSecrets,
} from './logger.js';

export const DIAG_PACKAGE_FORMAT = 'mofang-assistant-diagnostics';
export const DIAG_PACKAGE_FORMAT_VERSION = 1;
export const DIAG_MANIFEST_NAME = 'manifest.json';
/** capture 两份 log 进包的尾段上限 */
export const DIAG_LOG_TAIL_MAX_BYTES = 256 * 1024;

export interface DiagnosticTableCount {
  name: string;
  count: number;
}

export interface DiagnosticsManifestLog {
  /** 包内路径 */
  path: string;
  /** 源文件字节数 */
  bytes: number;
  /** 是否做了尾段截断 */
  truncated: boolean;
}

export interface DiagnosticsManifest {
  format: string;
  format_version: number;
  generated_at: string;
  app_version: string;
  electron_version: string;
  node_version: string;
  platform: string;
  arch: string;
  user_data_path: string;
  logs: DiagnosticsManifestLog[];
  db: { stats: DiagnosticTableCount[] };
  /** 排除面自述（不含敏感字面量，供用户/支持方核对） */
  excluded: string[];
}

export interface DiagnosticsPackageRequest {
  /** 产物 zip 落点（父目录须已存在——主进程 dialog 已保证；本模块不擅自建目录） */
  outputPath: string;
  userDataPath: string;
  dataDir: string;
  appVersion: string;
  electronVersion: string;
  nodeVersion?: string;
  platform?: string;
  arch?: string;
  /** 各表行数（SQL 由 bank 层注入，本模块不碰库） */
  getTableCounts: () => DiagnosticTableCount[];
  now?: () => Date;
  maxLogTailBytes?: number;
}

export type DiagnosticsPackageResult =
  | { success: true; path: string; manifest: DiagnosticsManifest; entries: string[] }
  | { success: false; error: string };

/** 排除面自述（措辞刻意不含敏感列名字面量——包内任何字节都不得命中排除词） */
const EXCLUDED_SURFACES = [
  '题库原库文件及其备份（只导各表行数统计，不导任何列值）',
  '图片资产目录 data/assets/**',
  '识别 run 素材 data/recog/runs/** 与切题工作区 data/splitting/**',
  '采集登录态分区（Chromium 分区目录及其 Cookie / 缓存）',
  '模型档案的 API Key 密文列（统计只计行数）',
  'Electron 默认缓存与崩溃转储（Cache / Code Cache / Crashpad）',
  '采集 HTML 快照 capture-html-snapshots/**（可能含账号痕迹）',
];

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 读整文件（不存在返回 null） */
function readWhole(path: string): { content: Buffer; bytes: number } | null {
  if (!existsSync(path)) return null;
  const stat = statSync(path);
  if (!stat.isFile()) return null;
  return { content: readFileSync(path), bytes: stat.size };
}

/** 读尾段（≤maxBytes，按行首对齐；返回 truncated 标记与源文件字节数） */
export function readLogTail(
  path: string,
  maxBytes: number,
): { content: Buffer; bytes: number; truncated: boolean } | null {
  const whole = readWhole(path);
  if (!whole) return null;
  if (whole.content.length <= maxBytes) return { ...whole, truncated: false };

  const sliced = whole.content.subarray(whole.content.length - maxBytes).toString('utf8');
  const firstBreak = sliced.indexOf('\n');
  const body = firstBreak >= 0 ? sliced.slice(firstBreak + 1) : sliced;
  const header = `[截断] 仅保留末尾 ${maxBytes} 字节（原始 ${whole.bytes} 字节）\n`;
  return {
    // capture 层日志不经本单 logger，进包前再过一次脱敏（合规第二道闸；对内容形态零改写）
    content: Buffer.from(scrubSecrets(header + body), 'utf8'),
    bytes: whole.bytes,
    truncated: true,
  };
}

export function buildDiagnosticsPackage(request: DiagnosticsPackageRequest): DiagnosticsPackageResult {
  try {
    const now = (request.now ?? (() => new Date()))();
    const tailMax = request.maxLogTailBytes ?? DIAG_LOG_TAIL_MAX_BYTES;
    const logsDir = join(request.userDataPath, DIAG_LOG_DIR_NAME);

    const entries: ZipEntry[] = [];
    const manifestLogs: DiagnosticsManifestLog[] = [];

    // 1. app.log 全量 + 轮转代（新 → 旧）
    const appLogCandidates = [
      DIAG_APP_LOG_NAME,
      ...Array.from({ length: DIAG_LOG_MAX_GENERATIONS }, (_, i) => `${DIAG_APP_LOG_NAME}.${i + 1}`),
    ];
    for (const name of [...appLogCandidates, DIAG_CRASH_LOG_NAME]) {
      const whole = readWhole(join(logsDir, name));
      if (!whole) continue;
      const zipPath = `logs/${name}`;
      // 文本日志进包前统一再过一次脱敏（合规第二道闸；对正常文本零改写）
      entries.push({ path: zipPath, content: Buffer.from(scrubSecrets(whole.content.toString('utf8')), 'utf8') });
      manifestLogs.push({ path: zipPath, bytes: whole.bytes, truncated: false });
    }

    // 2. 采集层两份既有 log 的尾段
    for (const name of ['capture-collect.log', 'capture-paper.log']) {
      const tail = readLogTail(join(request.dataDir, name), tailMax);
      if (!tail) continue;
      const zipPath = `logs/${name}`;
      entries.push({ path: zipPath, content: tail.content });
      manifestLogs.push({ path: zipPath, bytes: tail.bytes, truncated: tail.truncated });
    }

    // 3. manifest（含脱敏统计）
    const manifest: DiagnosticsManifest = {
      format: DIAG_PACKAGE_FORMAT,
      format_version: DIAG_PACKAGE_FORMAT_VERSION,
      generated_at: now.toISOString(),
      app_version: request.appVersion,
      electron_version: request.electronVersion,
      node_version: request.nodeVersion ?? process.versions.node,
      platform: request.platform ?? process.platform,
      arch: request.arch ?? process.arch,
      user_data_path: request.userDataPath,
      logs: manifestLogs,
      db: { stats: request.getTableCounts() },
      excluded: [...EXCLUDED_SURFACES],
    };
    entries.unshift({
      path: DIAG_MANIFEST_NAME,
      content: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'),
    });

    createZip(entries, request.outputPath);
    if (!existsSync(request.outputPath)) throw new Error('诊断包写入后不存在');

    return {
      success: true,
      path: request.outputPath,
      manifest,
      entries: entries.map((entry) => entry.path),
    };
  } catch (err) {
    return { success: false, error: errorText(err) };
  }
}
