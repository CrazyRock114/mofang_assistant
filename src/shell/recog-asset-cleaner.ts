// 0061 废图清理（R-057 / D-072）：recog 图资产孤儿扫描 → 移入 `data/assets/_trash/<日期>/`（可撤销回收）。
//
// 纪律（技术架构硬规则 + 任务书 §一/§三）：
//   - **零 SQL**（硬规则 2「bank-core 唯一碰 SQL」）：引用判定一律经注入的**既有只读 service 面**
//     （题读面 / 逐卷题面 + 试卷快照 / 错题读面）与文件态草稿（workbench.json 属文件态非 SQL）；
//   - **零写库**：本模块不产任何 UPDATE/DELETE，唯一留痕是注入的 operation_log 一条（`recog.assetTrash`）；
//   - **范围硬边界**（D-072②）：只进 `data/assets/recog/`；`assets/capture/`、`assets/logos/` 零触碰；
//     且只认**内容寻址命名的资产文件**（`<32hex>.<ext>`）——人工放进 recog/ 的非资产文件不参与判定、
//     永不移动（宁留不误删）；
//   - **每次调用全新全量重扫**（D-072⑤ 禁增量缓存）：恢复旧备份/编辑题面后引用会重现，缓存会把该保留的图判成孤儿；
//   - **移动 = 回收目录**（D-072③ 可撤销，目录自身不自清）：跨盘回落 copy+unlink；单文件失败
//     （Windows 占用 EPERM/EBUSY）逐文件跳过并计数，不得整批失败。
//
// 引用判定面（六源，全部「宁留不误删」）：
//   ① 题目三字段 content/answer/analysis（+ 结构化 stemHtml/options[].html——采集链题的权威题干形态）
//   ② `questions.images[].assetId`（0057 起入库填；两形态带/不带 `data-assets/` 前缀都归一）
//   ③ `paper_questions.layout_json` 的 `figures[].assetId`（逐卷读，全部状态含 archived/trashed）
//   ④ 试卷快照 `paper_snapshots`（done/archived 卷的显示与出纸走快照题：改题/软删不漂移）
//   ⑤ 录题草稿 `data/recog/runs/*/workbench.json` 的 cards 三字段
//   ⑥ 错题快照 `mistakes.snapshot_json`（错题本按快照显示：stemHtml/options/answer/analysis/images）
//   注 ①+② 为任务书 §零.2 点名口径，③④⑤⑥ 为其自然延伸（同「仍被显示」判据）——漏算任一即「误删致裂图」。

import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  FileScanRecogAssetGarbageResult, FileTrashRecogAssetsPayload, FileTrashRecogAssetsResult,
} from '../shared/contracts/ipc-channels.js';

/** recog 子目录（相对 data/assets）——D-072② 唯一范围 */
const RECOG_SUBDIR = 'recog';
/** 回收目录（相对 data/assets）——D-072③ 可撤销 */
const TRASH_SUBDIR = '_trash';
/** 录题草稿运行目录（相对 dataDir） */
const RUNS_REL = join('recog', 'runs');
/** 草稿文件名（工作台文件态，`src/recog/runs/workbench-store.ts` 单源常量同串） */
const WORKBENCH_FILE = 'workbench.json';
/** operation_log 类型名（0061 独占，与 0057 的 recog.imageAssetsBackfill 并列） */
const TRASH_OPERATION = 'recog.assetTrash';

/**
 * 资产相对路径形验（相对 data/assets）：内容寻址命名 + 白名单扩展名。
 * 与 recog-image-store 的落盘命名（sha256 前 32 位 + `RECOG_IMAGE_EXTENSIONS`）同形；
 * 该常量未导出，此处按任务书 §一.1 的字面口径独立声明（避免改动 0057 文件）。
 */
export const RECOG_ASSET_REL_RE = /^recog\/[0-9a-f]{32}\.(png|jpe?g|gif|webp|svg)$/;
const RECOG_ASSET_NAME_RE = /^[0-9a-f]{32}\.(png|jpe?g|gif|webp|svg)$/;

/** 存储形态资产引用：`src="data-assets/<rel…>"`（单/双引号两形态；口径同 asset-src.ts STORED_SRC_RE） */
const STORED_SRC_RE = /\bsrc\s*=\s*(?:"data-assets\/([^"]*)"|'data-assets\/([^']*)')/g;
/**
 * 损坏草稿兜底用：**不要求 `src=` 上下文**的资产路径直取（JSON 正文里引号被转义成 `\"`，
 * 严格 src 形态匹配不到；此处只认路径本体，到引号/反斜杠/空白为止）。
 * 只用于「JSON 解析失败」的保守路径——多算引用只是少回收几张图，不算错。
 */
const RAW_ASSET_REF_RE = /data-assets\/([^"'\s\\]+)/g;
/** assetId 归一：去 `data-assets/` 前缀（含重复前缀存量脏值）——口径同 figureBlocks.normalizeAssetId */
const DATA_ASSETS_PREFIX_RE = /^(?:\.\/)*data-assets\//i;

/** 题/快照/草稿三字段的行形态（结构化子集；真实 Question/MistakeQuestionSnapshot 结构上可赋值） */
export interface RecogAssetRefRow {
  content?: string | null;
  stemHtml?: string | null;
  answer?: string | null;
  analysis?: string | null;
  options?: Array<{ html?: string | null }> | null;
  images?: Array<{ assetId?: string | null }> | null;
}

/** 卷内题目行（只看 layout 覆盖条目：`figures[].assetId`） */
export interface RecogAssetLayoutRow {
  layout?: { figures?: Array<{ assetId?: string | null }> | null } | null;
}

/**
 * 清理工具的只读库面（既有 service 的结构化子集；实现侧直接传真 service，测试传假实现）。
 * 全部为**读**方法——本单不消费任何写面（§一「明确不做」）。
 */
export interface RecogAssetCleanerServices {
  bank: {
    /** 题读面（domain: QuestionService.listQuestions，已过滤软删题） */
    listQuestions(): Promise<RecogAssetRefRow[]>;
    /** 逐卷题面（domain: PaperService.getPaperQuestions；本模块只读其 layout.figures） */
    getPaperQuestions(paperId: string): Promise<RecogAssetLayoutRow[]>;
  };
  paper: {
    /** 卷列表读面（**显式含全部状态**：archived/trashed 卷的引用同样算「仍被引用」） */
    listPapersEx(filter?: { statuses?: readonly string[] }): Promise<Array<{ paper: { id: string } }>>;
    /** 试卷快照读面（domain: PaperService.listPaperSnapshotQuestions） */
    listPaperSnapshotQuestions(paperId: string): Promise<RecogAssetRefRow[]>;
  };
  mistake: {
    /** 错题读面（domain: MistakeService.listMistakes；本模块只读其 snapshot） */
    listMistakes(): Promise<Array<{ snapshot?: RecogAssetRefRow | null }>>;
  };
}

/** operation_log 面（与 bank `OperationLogger` 同名方法同签名，直接注入即可） */
export interface OperationLogLike {
  logStart(operationType: string, description: string, metadata?: Record<string, unknown>): string;
  logSuccess(id: string, affectedCount: number): void;
  logFailure(id: string, error: Error): void;
}

export interface RecogAssetCleanerDeps {
  /** userData/data 目录（资产在 `data/assets/recog/`，回收目录 `data/assets/_trash/`） */
  dataDir: string;
  /** 只读库面（懒取自当前库句柄——reloadDatabase 后服务实例会重建） */
  refs: RecogAssetCleanerServices;
  /** operation_log 留痕面（trash 有效动作一条；缺省零留痕——测试/无库环境） */
  logger?: OperationLogLike;
  /** 移动注入（缺省 rename + 跨盘 copy/unlink 回落；测试可换假实现验占用跳过路径） */
  moveFile?: (from: string, to: string) => void;
  warn?: (message: string) => void;
}

/** 资产文件名 → 相对 data/assets 的路径（与 contract relPath 同形） */
function relPathOf(fileName: string): string {
  return `${RECOG_SUBDIR}/${fileName}`;
}

/** assetId（可能带 `data-assets/` 前缀、可能重复前缀）→ 相对 data/assets 的 relPath；空 → null */
function normalizeAssetRef(assetId: string | null | undefined): string | null {
  if (typeof assetId !== 'string' || assetId === '') return null;
  let id = assetId;
  while (DATA_ASSETS_PREFIX_RE.test(id)) id = id.replace(DATA_ASSETS_PREFIX_RE, '');
  return id === '' ? null : id;
}

/** HTML 内资产引用（去前缀）→ 引用集 */
function collectFromHtml(html: string, into: Set<string>): void {
  for (const match of html.matchAll(STORED_SRC_RE)) {
    const rel = normalizeAssetRef(match[1] ?? match[2] ?? '');
    if (rel) into.add(rel);
  }
}

/** 原始文本内资产路径（宽松口径；仅用于解析失败的草稿兜底）→ 引用集 */
function collectFromRawText(text: string, into: Set<string>): void {
  for (const match of text.matchAll(RAW_ASSET_REF_RE)) {
    const rel = normalizeAssetRef(match[1] ?? '');
    if (rel) into.add(rel);
  }
}

/** 一行（题/快照/草稿卡）的全部引用面 → 引用集 */
function collectFromRow(row: RecogAssetRefRow, into: Set<string>): void {
  for (const field of [row.content, row.stemHtml, row.answer, row.analysis]) {
    if (typeof field === 'string' && field !== '') collectFromHtml(field, into);
  }
  for (const option of row.options ?? []) {
    if (typeof option?.html === 'string') collectFromHtml(option.html, into);
  }
  for (const image of row.images ?? []) {
    const rel = normalizeAssetRef(image?.assetId);
    if (rel) into.add(rel);
  }
}

/** 盘上资产文件（只认内容寻址命名的资产；非资产文件不参与判定） */
function readAssetFiles(recogDir: string): Array<{ relPath: string; bytes: number }> {
  if (!existsSync(recogDir)) return [];
  return readdirSync(recogDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && RECOG_ASSET_NAME_RE.test(entry.name))
    .map((entry) => ({ relPath: relPathOf(entry.name), bytes: statSync(join(recogDir, entry.name)).size }))
    .sort((left, right) => left.relPath.localeCompare(right.relPath));
}

/** 录题草稿引用（文件态；损坏 JSON 按原文兜底提取引用——宁留不误删，并告警计数） */
function collectFromDrafts(runsDir: string, into: Set<string>, warn: (message: string) => void): void {
  if (!existsSync(runsDir)) return;
  for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(runsDir, entry.name, WORKBENCH_FILE);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    let cards: Array<{ contentHtml?: string | null; answerHtml?: string | null; analysisHtml?: string | null }> = [];
    try {
      const state = JSON.parse(text) as { cards?: typeof cards };
      cards = Array.isArray(state.cards) ? state.cards : [];
    } catch {
      // 半截 JSON（写盘被打断）：正文里的资产引用串照扫——宁可少回收，不可误删
      warn(`0061 废图清理：草稿 ${entry.name}/${WORKBENCH_FILE} 解析失败，已按原文兜底提取引用（宁留不误删）`);
      collectFromRawText(text, into);
      continue;
    }
    for (const card of cards) {
      for (const html of [card?.contentHtml, card?.answerHtml, card?.analysisHtml]) {
        if (typeof html === 'string' && html !== '') collectFromHtml(html, into);
      }
    }
  }
}

/**
 * 扫描 recog 域孤儿资产（只读；每次全量重扫，禁缓存）。
 * 任一引用源读取失败 → 整体抛错（宁可不清理，不产「半套引用集」——否则可能误删）。
 */
export async function scanRecogAssetGarbage(deps: RecogAssetCleanerDeps): Promise<FileScanRecogAssetGarbageResult> {
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const files = readAssetFiles(join(deps.dataDir, 'assets', RECOG_SUBDIR));
  const referenced = new Set<string>();

  // ①②：题读面（三字段 + 结构化字段 + images 列）
  for (const row of await deps.refs.bank.listQuestions()) collectFromRow(row, referenced);

  // ③④：逐卷 layout_json 覆盖条目 + 试卷快照（全部状态：archived/trashed 卷的引用同样算「仍被引用」）
  const papers = await deps.refs.paper.listPapersEx({ statuses: ['basket', 'composing', 'done', 'archived', 'trashed'] });
  for (const summary of papers) {
    const paperId = summary.paper.id;
    for (const row of await deps.refs.bank.getPaperQuestions(paperId)) {
      for (const figure of row.layout?.figures ?? []) {
        const rel = normalizeAssetRef(figure?.assetId);
        if (rel) referenced.add(rel);
      }
    }
    for (const snapshot of await deps.refs.paper.listPaperSnapshotQuestions(paperId)) {
      collectFromRow(snapshot, referenced);
    }
  }

  // ⑤：录题草稿（文件态）
  collectFromDrafts(join(deps.dataDir, RUNS_REL), referenced, warn);

  // ⑥：错题快照
  for (const mistake of await deps.refs.mistake.listMistakes()) collectFromRow(mistake.snapshot ?? {}, referenced);

  const orphans = files.filter((file) => !referenced.has(file.relPath));
  return {
    orphans,
    totalBytes: orphans.reduce((sum, file) => sum + file.bytes, 0),
    referencedCount: files.length - orphans.length,
    scannedCount: files.length,
  };
}

/** 回收目录时间戳（本地时区，与文件名形态一致） */
function trashStampOf(now: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** 逐条形验（路径逃逸防线：`..`/绝对路径/非白名单扩展名/非 recog 子目录一律拒绝） */
function validateRelPaths(payload: FileTrashRecogAssetsPayload): string[] {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.relPaths)) {
    throw new Error('Invalid payload（relPaths 必填字符串数组）');
  }
  const out: string[] = [];
  for (const entry of payload.relPaths) {
    if (typeof entry !== 'string' || !RECOG_ASSET_REL_RE.test(entry)) {
      throw new Error(`Invalid relPath: ${String(entry)}（须形如 recog/<32hex>.<png|jpg|jpeg|gif|webp|svg>）`);
    }
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

/** 同盘 rename；跨盘（EXDEV）回落 copy+unlink */
function defaultMove(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    copyFileSync(from, to);
    unlinkSync(from);
  }
}

/** Windows 占用/权限类失败：跳过该文件（不整批失败），moved 只计成功 */
function isBusyError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'EPERM' || code === 'EBUSY';
}

/**
 * 把孤儿资产移入回收目录（`data/assets/_trash/<YYYYMMDD-HHmmss>/recog/<原文件名>`，保相对结构）。
 * 执行前**重扫一次**（D-072⑤），只移动「入参 ∩ 最新孤儿集」——入参里的被引用者/已恢复引用者跳过不误删。
 * 留痕：入参非空时一条 `recog.assetTrash`（logStart 记 planned/bytes/trashDir → logSuccess(count=moved)）；
 * 意外错误 → logFailure 并整批抛出。
 */
export async function trashRecogAssets(
  deps: RecogAssetCleanerDeps,
  payload: FileTrashRecogAssetsPayload,
): Promise<FileTrashRecogAssetsResult> {
  const relPaths = validateRelPaths(payload);
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const move = deps.moveFile ?? defaultMove;
  const trashDir = join(deps.dataDir, 'assets', TRASH_SUBDIR, trashStampOf(new Date()));
  if (relPaths.length === 0) return { moved: 0, bytes: 0, trashDir };

  const scan = await scanRecogAssetGarbage(deps);
  const orphanSet = new Map(scan.orphans.map((orphan) => [orphan.relPath, orphan.bytes]));
  const planned = relPaths.filter((relPath) => orphanSet.has(relPath));
  const plannedBytes = planned.reduce((sum, relPath) => sum + (orphanSet.get(relPath) ?? 0), 0);

  // 台账：有实际清理动作（planned>0）才落一条 start→success；零动作（全跳过/已清空）不产台账噪声
  // （与 0057 backfill「干净库零留痕」同口径）。metadata 全为动手前已知量——bytes = 计划回收字节，
  // 逐件失败（占用）时与实际差额可由 affected_count（= moved）对照读出。
  const logId = planned.length > 0
    ? deps.logger?.logStart(
      TRASH_OPERATION,
      `回收未引用录题图资产 ${planned.length} 件（移入 ${TRASH_SUBDIR}/<日期>/recog）`,
      { requested: relPaths.length, planned: planned.length, bytes: plannedBytes, trashDir },
    )
    : undefined;

  try {
    let moved = 0;
    let bytes = 0;
    let skipped = 0;
    for (const relPath of relPaths) {
      if (!orphanSet.has(relPath)) {
        skipped += 1; // 入参 ∩ 最新孤儿集：已恢复引用者不误删
        continue;
      }
      const from = join(deps.dataDir, 'assets', relPath);
      const to = join(trashDir, relPath);
      try {
        mkdirSync(dirname(to), { recursive: true });
        move(from, to);
        moved += 1;
        bytes += orphanSet.get(relPath) ?? 0;
      } catch (err) {
        if (!isBusyError(err)) throw err;
        skipped += 1;
        warn(`0061 废图清理：${relPath} 被占用（${(err as NodeJS.ErrnoException).code}），本次跳过（留待下次）`);
      }
    }
    if (logId !== undefined) deps.logger?.logSuccess(logId, moved);
    return { moved, bytes, trashDir };
  } catch (err) {
    if (logId !== undefined) deps.logger?.logFailure(logId, err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
}
