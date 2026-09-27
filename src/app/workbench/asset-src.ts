// 0057 录题图资产化：显示形态 ⇄ 存储形态双侧归一 + content 资产引用 → `questions.images` + 落资产封装。
//
// 口径（任务书 §0.5 方案 A）：
//   存储形态 = `data-assets/<子目录>/<文件>` 相对引用（题卡 state / 落库 / 导出 / 迁移的唯一权威形态，
//             只有它能被 buildPaperHtml.rewriteDataAssetSrcs、preview-frame-runtime.assetIdOf、
//             paper-actions.contentAssetIds 三处解析）；
//   显示形态 = `${assetsRoot 的 file:// URL}/<子目录>/<文件>`（进编辑器与线上插入用——渲染层页面是
//             file:// 载入，相对引用解析不到 userData/data/assets，直接用相对引用会裂图）。
//
// 本模块是纯函数 + 一次桥调用封装，零 SQL/零 docgen 依赖（资产根改写口径与
// `src/docgen/render/buildPaperHtml.core.ts` rewriteDataAssetSrcs 保持同构，但不 import 该域，
// 避免把渲染引擎的「无资产根 → 转占位 span」语义带进编辑器：编辑器里出现占位 span 会被保存回写进题库）。

import type { QuestionImage } from '../../shared/contracts/bank-types.js';
import type { FileSaveRecogImagePayload } from '../../shared/contracts/ipc-channels.js';

/** 存储形态前缀（与采集链 `capture/assets.ts` DATA_ASSETS_PREFIX 同串） */
export const DATA_ASSETS_PREFIX = 'data-assets/';

/** `src=` 属性取值（单/双引号两形态；SVG data URL 正文内可含单引号，故按属性引号配对取） */
const SRC_ATTR_RE = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
/** 仅命中存储形态的 `src="data-assets/…"`（含引号，便于原地替换保引号风格） */
const STORED_SRC_RE = /\bsrc\s*=\s*(?:"data-assets\/([^"]*)"|'data-assets\/([^']*)')/g;
/** 内联图片 data URL（入库前兜底改写的对象） */
const INLINE_IMAGE_SRC_RE = /\bsrc\s*=\s*(?:"(data:image\/[^"]*)"|'(data:image\/[^']*)')/g;

/** assetsRoot（userData/data/assets 绝对路径）→ file:// URL 根（与 rewriteDataAssetSrcs 同口径） */
export function fileUrlRootOf(assetsRoot: string): string {
  const root = assetsRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  return `${root.startsWith('/') ? 'file://' : 'file:///'}${root}`;
}

/** 单条存储形态引用 → 显示形态；非资产引用（内联 data URL / 空）原样返回 */
export function displaySrcOf(src: string, assetsRoot: string | null): string {
  if (!assetsRoot || !src.startsWith(DATA_ASSETS_PREFIX)) return src;
  return `${fileUrlRootOf(assetsRoot)}/${src.slice(DATA_ASSETS_PREFIX.length)}`;
}

/**
 * 存储形态 HTML → 显示形态（进编辑器 / 线上插入用）。
 * 无资产根（浏览器 demo / vitest）原样返回——不动内容，绝不产占位节点（编辑器会把它保存回库）。
 */
export function toDisplayHtml(html: string, assetsRoot: string | null): string {
  if (!assetsRoot || !html.includes(DATA_ASSETS_PREFIX)) return html;
  const root = fileUrlRootOf(assetsRoot);
  return html.replace(STORED_SRC_RE, (_match, dq: string | undefined, sq: string | undefined) => {
    const rel = dq ?? sq ?? '';
    return dq !== undefined ? `src="${root}/${rel}"` : `src='${root}/${rel}'`;
  });
}

/**
 * 显示形态 HTML → 存储形态（编辑器 onSave 回写前用）。
 * 只改写落在 assetsRoot 之下的绝对引用；其它 src（内联 data URL、外链）原样保留。
 */
export function toStoredHtml(html: string, assetsRoot: string | null): string {
  if (!assetsRoot || !html.includes('file:')) return html;
  const prefix = `${fileUrlRootOf(assetsRoot)}/`;
  if (!html.includes(prefix)) return html;
  return html.replace(SRC_ATTR_RE, (match, dq: string | undefined, sq: string | undefined) => {
    const value = dq ?? sq ?? '';
    if (!value.startsWith(prefix)) return match;
    const rel = value.slice(prefix.length);
    return dq !== undefined
      ? `src="${DATA_ASSETS_PREFIX}${rel}"`
      : `src='${DATA_ASSETS_PREFIX}${rel}'`;
  });
}

/** content 内引用的资产相对路径（去前缀，按出现序去重） */
export function contentAssetRefs(html: string): string[] {
  const out: string[] = [];
  for (const match of html.matchAll(STORED_SRC_RE)) {
    const rel = match[1] ?? match[2] ?? '';
    if (rel !== '' && !out.includes(rel)) out.push(rel);
  }
  return out;
}

/**
 * 题卡 contentHtml → 入库 `questions.images`（以 content 实际引用为准，两腿复用）。
 * assetId 写**带 `data-assets/` 前缀的完整引用串**（= 与 content 内 src 同串）：与真机既有
 * 196 道同形态、引擎侧 normalizeAssetId/buildImageTypeTable 已归一闭合、与采集链
 * `capture/ingest.ts toQuestionImages` 一致。type 一律 'figure'（录题台三个落图入口都进题干/选项区）。
 * width/height 不写：真机既有 1660/1660 条目只有 {assetId,type} 两键，不为新链另立形态。
 */
export function questionImagesFromHtml(html: string): QuestionImage[] {
  return contentAssetRefs(html).map((rel) => ({
    assetId: `${DATA_ASSETS_PREFIX}${rel}`,
    type: 'figure' as const,
  }));
}

// ==================== 落资产（file.saveRecogImage 桥封装；显式降级） ====================

export interface SavedRecogImage {
  relPath: string;
  width?: number;
  height?: number;
}

/** 本模块用到的 file 桥面（结构子集；测试可注入假实现） */
export interface RecogImageBridgeLike {
  saveRecogImage(payload: FileSaveRecogImagePayload): Promise<SavedRecogImage>;
}

/** 桥取用：浏览器 demo / vitest 无 `__mofangFile` → null（调用方走显式降级，禁静默） */
export function recogImageBridge(): RecogImageBridgeLike | null {
  if (typeof window === 'undefined') return null;
  const bridge = window.__mofangFile;
  if (!bridge || typeof bridge.saveRecogImage !== 'function') return null;
  return bridge;
}

export type PersistOutcome =
  | { ok: true; /** 存储形态 src */ src: string; relPath: string }
  | { ok: false; /** 降级 src（原内联 dataUrl） */ src: string; reason: string };

/**
 * 裁图 dataUrl → 落 `data/assets/recog/` → 存储形态 src。
 * 降级（显式，记账责任在调用方）：非 data:image 形态 / 无桥（浏览器 demo、测试）/ 落盘失败
 * → 回落原 dataUrl 并给 reason（题卡内仍能显示；入库前 normalizeHtmlAssets 会再兜底一次）。
 */
export async function persistImageSrc(
  dataUrl: string,
  size: { width?: number; height?: number } = {},
  bridge: RecogImageBridgeLike | null = recogImageBridge(),
): Promise<PersistOutcome> {
  if (!dataUrl.startsWith('data:image/')) {
    return { ok: false, src: dataUrl, reason: '非 data:image 形态，跳过落资产' };
  }
  if (!bridge) {
    return { ok: false, src: dataUrl, reason: '无 file 桥（浏览器 demo / 测试环境），保持内联图' };
  }
  try {
    const asset = await bridge.saveRecogImage({
      dataUrl,
      ...(size.width !== undefined ? { width: size.width } : {}),
      ...(size.height !== undefined ? { height: size.height } : {}),
    });
    return { ok: true, src: `${DATA_ASSETS_PREFIX}${asset.relPath}`, relPath: asset.relPath };
  } catch (err) {
    return { ok: false, src: dataUrl, reason: err instanceof Error ? err.message : String(err) };
  }
}

export interface PersistBatchResult {
  /** key → 存储形态 src（含降级项：降级时即原 dataUrl） */
  srcOf: Map<number, string>;
  /** 降级条目（调用方必须记账：题卡可显示，但入库后不可排版调整） */
  degraded: Array<{ key: number; reason: string }>;
}

/** 批量落资产（识别落卡的图块裁图集：先 await 全部落盘，再造同步映射给 draftToCard） */
export async function persistImageSrcs(
  entries: Array<{ key: number; dataUrl: string; width?: number; height?: number }>,
  bridge: RecogImageBridgeLike | null = recogImageBridge(),
): Promise<PersistBatchResult> {
  const srcOf = new Map<number, string>();
  const degraded: Array<{ key: number; reason: string }> = [];
  await Promise.all(entries.map(async (entry) => {
    const outcome = await persistImageSrc(
      entry.dataUrl,
      {
        ...(entry.width !== undefined ? { width: entry.width } : {}),
        ...(entry.height !== undefined ? { height: entry.height } : {}),
      },
      bridge,
    );
    srcOf.set(entry.key, outcome.src);
    if (!outcome.ok) degraded.push({ key: entry.key, reason: outcome.reason });
  }));
  return { srcOf, degraded };
}

export interface NormalizeAssetsResult {
  /** 改写后的 HTML（残余内联 data URL 已换成 `data-assets/…`；降级项原样保留） */
  html: string;
  /** 新落资产数 */
  persisted: number;
  /** 降级原因（命中内联图但落盘失败/无桥） */
  degraded: string[];
}

/**
 * 入库前兜底：把 HTML 里残余的内联 data URL 就地落资产并改写为存储形态。
 *
 * 为什么必须兜底（任务书 §三 禁区 6「禁把内联 data URL 写进新入库数据」）：编辑器自带的
 * 「图片」按钮（本地上传）与 Ctrl+V 粘贴剪贴板图片产出的都是内联 data URL——那两条在
 * `src/docgen/editor/**`（本单禁区）内，无法在插入点接资产链；另有落资产降级回落的情形。
 * 于是在两条入库腿提交前各跑一次本函数，保证落库 content/answer/analysis 里零内联图。
 * 正常路径（框选/重裁/粘贴已落资产）此时无内联图 → 零改写零写盘。
 */
export async function normalizeHtmlAssets(
  html: string,
  bridge: RecogImageBridgeLike | null = recogImageBridge(),
): Promise<NormalizeAssetsResult> {
  const hits = [...html.matchAll(INLINE_IMAGE_SRC_RE)].map((m) => m[1] ?? m[2] ?? '');
  if (hits.length === 0) return { html, persisted: 0, degraded: [] };

  const unique = [...new Set(hits)];
  const persistedByDataUrl = new Map<string, string>();
  const degraded: string[] = [];
  await Promise.all(unique.map(async (dataUrl) => {
    const outcome = await persistImageSrc(dataUrl, {}, bridge);
    if (outcome.ok) persistedByDataUrl.set(dataUrl, outcome.src);
    else degraded.push(outcome.reason);
  }));

  let out = html;
  for (const [dataUrl, src] of persistedByDataUrl) {
    out = out.split(`"${dataUrl}"`).join(`"${src}"`).split(`'${dataUrl}'`).join(`'${src}'`);
  }
  return { html: out, persisted: persistedByDataUrl.size, degraded };
}
