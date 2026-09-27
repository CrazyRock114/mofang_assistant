// 0004 Phase 4（乙路）：题干 HTML 块化模型（U4 v1，纯函数）。
// 0004-fix-2 F2-C 重构：块化输出改为**交错段序列**（text/figure 原位序），图块保留插入锚点——
// inline 渲染按段序输出（图在原 DOM 位置随文流），side-by-side 聚合右栏不受影响；
// 语义过滤不变：块级 <figure> 与行内 <img data-w> 中仅语义 type=figure 参与
// （G3：formula-image/answer-image/analysis-image 不参与，留文本流）；
// 题级覆盖（QuestionFigureLayout）决定图块输出顺序/对齐/宽度/单图 side-by-side；
// 题首孤图 relocate 与 capture relocateLeadingFigures 语义一致（fix-1c：首部图块群后移、选项保持居尾）。

import type { QuestionFigureLayout } from '../../shared/contracts/bank-types.js';

export interface ParsedFigure {
  /** 原始元素 HTML（已过 processFigures 宽度样式） */
  html: string;
  /** data-assets 资产 id；data:/http: 等外源 src 为 null（仍按 figure 参与） */
  assetId: string | null;
}

/** 交错段（fix-2 F2-C）：text=原始 HTML 片段（可能含未闭合标签，按序拼接后复原完整结构）；figure=提取的图块 */
export type ContentSegment =
  | { kind: 'text'; html: string }
  | { kind: 'figure'; figure: ParsedFigure };

export interface ParsedBlocks {
  /** 交错段序列（原 DOM 序；图块锚点=段位置） */
  segments: ContentSegment[];
  /** 原 DOM 顺序的图块（segments 中 figure 段视图，便捷沿用） */
  figures: ParsedFigure[];
  /** 全部文本段连接（去图后文本；供非交错消费方/调试） */
  textHtml: string;
}

export interface FigureRenderSpec {
  figure: ParsedFigure;
  align: 'left' | 'center' | 'right';
  sideBySide: boolean;
  /** null = 不缩放（保留 data-w 像素宽 + max-width 封顶基线） */
  widthPercent: number | null;
  /** 稳定排序键：orderIndex（缺省 MAX）+ DOM 序 */
  orderKey: number;
  domIndex: number;
  /**
   * 0004-fix-5 P0-2（只增）：任意段边界锚位 = 目标插入点在**段序列**中的下标（0..段数，边界 k = 第 k 段之前）。
   * null = 未指定 → 沿用槽位序（旧 orderIndex 语义；无锚数据输出与历史逐字节一致）。
   */
  anchorIndex: number | null;
}

const CONTENT_ELEMENT_RE = /<figure\b[^>]*>[\s\S]*?<\/figure>|<img\b[^>]*>/gi;
const DATA_ASSETS_SRC_RE = /\bsrc=(["'])data-assets\/([^"']+)\1/i;
const OPTIONS_TAIL_RE = /^([\s\S]*?)(<div class="options"[\s\S]*<\/div>\s*)$/i;
const OPTIONS_OPEN_RE = /<div class="options"/i;
const DATA_ASSETS_PREFIX_RE = /^(?:\.\/)*data-assets\//i;

/**
 * 0004-fix-5 P0-3（只增）：assetId 归一 = 去 `data-assets/` 前缀（含重复前缀的存量脏值）。
 * 真机数据两形态并存（question.images[].assetId / layout_json 覆盖条目带前缀；引擎 extractAssetId 产出去前缀形态）；
 * 不归一时覆盖匹配不上 → 误判外来图 → foreignFigureHtml 再补一层前缀（data-assets/data-assets/…）= 裂图双图（复现证据 probe2）。
 */
export function normalizeAssetId(assetId: string | null): string | null {
  if (assetId === null) return null;
  let id = assetId;
  while (DATA_ASSETS_PREFIX_RE.test(id)) id = id.replace(DATA_ASSETS_PREFIX_RE, '');
  return id;
}

function extractAssetId(html: string): string | null {
  const match = html.match(DATA_ASSETS_SRC_RE);
  return match ? normalizeAssetId(match[2]) : null;
}

/** 图片语义类型表（assetId → type），由 Question.images 构建 */
export type ImageTypeTable = Record<string, 'figure' | 'formula-image' | 'answer-image' | 'analysis-image'>;

export function buildImageTypeTable(images: Array<{ assetId: string; type: 'figure' | 'formula-image' | 'answer-image' | 'analysis-image' }>): ImageTypeTable {
  const table: ImageTypeTable = {};
  // fix-5：键归一（真机 images[].assetId 带 data-assets/ 前缀，不归一时语义查找全落空 → 公式图被误块化）
  for (const image of images) {
    const id = normalizeAssetId(image.assetId);
    if (id !== null) table[id] = image.type;
  }
  return table;
}

/** 剥标签后的可见文本（空白剔除；题首孤图 relocate 的「其后存在文本」判定用） */
function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, '').trim();
}

/**
 * 0035（只增）：该下标处的元素是否被 `<span class="inline-figure">` 直接包裹。
 * 采集站把**行内公式/符号小图**包进该 span（paper.css：`.inline-figure > img` 随文流、
 * 下限 1.25 倍正文、200px 封顶）——语义上不是块级配图。
 * 判定：向前取最近的 `<span`，其 class 含 inline-figure，且与当前位置之间没有 `</span>`。
 * 仅由 0035 DOCX 导出侧 opt-in 使用（引擎默认行为零变化）。
 */
export function isInsideInlineFigureWrap(content: string, index: number): boolean {
  const before = content.slice(0, index);
  const openAt = before.lastIndexOf('<span');
  if (openAt < 0) return false;
  const fragment = before.slice(openAt);
  if (/<\/span>/i.test(fragment)) return false;
  const end = fragment.indexOf('>');
  if (end < 0) return false;
  return /<span\b[^>]*\bclass=(["'])[^"']*\binline-figure\b[^"']*\1[^>]*>/i.test(fragment.slice(0, end + 1));
}

/**
 * 0041：content 中被 `<span class="inline-figure">` 包裹的图资产 id 全集（归一形态）。
 * 语义 = 行内公式/符号图：排版侧**恒留文本流**（paper.css `.inline-figure > img` 的 1.25×字号下限
 * + width:auto 等比 + 200px 封顶生效前提）；题级覆盖对它不生效（不成块、也不合成外来图）。
 * 消费方：planQuestionFigures（覆盖集过滤）+ UI 可调图列表（app/pages/paper-actions.listAdjustableAssets）。
 * 采集产物为扁平形态（span 内直接是 img/figure），故按最近闭合 span 取内部元素。
 */
export function inlineFigureAssetIds(content: string): Set<string> {
  const out = new Set<string>();
  const re = /<span\b[^>]*\bclass=(["'])[^"']*\binline-figure\b[^"']*\1[^>]*>([\s\S]*?)<\/span>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    for (const el of m[2].matchAll(/<(?:img|figure)\b[^>]*>/gi)) {
      const id = extractAssetId(el[0]);
      if (id !== null) out.add(id);
    }
  }
  return out;
}

type TextSegment = Extract<ContentSegment, { kind: 'text' }>;
const isTextSegment = (s: ContentSegment): s is TextSegment => s.kind === 'text';

/** 该元素是否参与块化（图块提取） */
function participates(element: string, imageTypes: ImageTypeTable, extraAssets?: ReadonlySet<string>): boolean {
  // fix-3 覆盖优先参与：题级覆盖命中的 assetId 无条件提升（语义过滤只放行图类，
  // formula/answer/analysis 语义不提升——UI 侧限制提升范围，引擎侧同规则兜底）
  if (extraAssets && extraAssets.size > 0) {
    const id = extractAssetId(element);
    if (id !== null && extraAssets.has(id)) return true;
  }
  if (/^<figure\b/i.test(element)) {
    const assetId = extractAssetId(element);
    const semantic = assetId ? imageTypes[assetId] : undefined;
    return !(semantic && semantic !== 'figure');
  }
  // 行内 <img>（0004-fix-4 #7 目检 #7「依旧只有部分图可调」）：默认全可调——
  // 非公式/答案/解析语义的行内图（含无语义裸行内 img、无 data-w）一律参与块化；
  // 无语义 = images 未登记的图，按图类处理；公式/答案/解析语义豁免不变（留文本流）。
  const assetId = extractAssetId(element);
  if (assetId === null) return false; // 外源 src（http/data）无 assetId，覆盖机制无从追踪，留文本流
  const semantic = imageTypes[assetId];
  return semantic === undefined || semantic === 'figure';
}

/**
 * 覆盖提升资格（fix-3）：覆盖命中的 assetId 仅对"图类"asset 生效——
 * 语义为 formula-image/answer-image/analysis-image 的图不提升（留文本流）；
 * 无语义（裸图）与 figure 语义可提升。
 */
export function isPromotableAsset(assetId: string, imageTypes: ImageTypeTable): boolean {
  const semantic = imageTypes[normalizeAssetId(assetId) ?? assetId];
  return semantic === undefined || semantic === 'figure';
}

/**
 * 块化（fix-2 F2-C 交错段版）：按原 DOM 序扫描，提取参与块化的图元素为 figure 段，
 * 其余字符为 text 段——**插入锚点保留在段序列中**（图在哪，段序即还原）。
 * text 段是原始 HTML 切片，可能含未闭合标签；消费方按段序拼接即复原完整结构。
 * fix-3 P0-1：extraParticipate = 题级覆盖命中的 assetId 全集（覆盖优先参与，见 participates）。
 */
export function blockifyQuestionContent(
  content: string,
  imageTypes: ImageTypeTable,
  extraParticipate?: ReadonlySet<string>,
  options?: { skipInlineFigureWrap?: boolean }
): ParsedBlocks {
  const segments: ContentSegment[] = [];
  const figures: ParsedFigure[] = [];
  let cursor = 0;

  for (const match of content.matchAll(CONTENT_ELEMENT_RE)) {
    const element = match[0];
    const start = match.index ?? 0;
    // 0035 opt-in：.inline-figure 包裹的行内小图留文本流（显式覆盖提升的除外——用户意图优先）
    if (options?.skipInlineFigureWrap === true && isInsideInlineFigureWrap(content, start)) {
      const assetId = extractAssetId(element);
      if (assetId === null || !(extraParticipate?.has(assetId) ?? false)) continue;
    }
    if (!participates(element, imageTypes, extraParticipate)) continue;
    const textChunk = content.slice(cursor, start);
    if (textChunk) segments.push({ kind: 'text', html: textChunk });
    const figure: ParsedFigure = { html: element, assetId: extractAssetId(element) };
    figures.push(figure);
    segments.push({ kind: 'figure', figure });
    cursor = start + element.length;
  }
  const tail = content.slice(cursor);
  if (tail) segments.push({ kind: 'text', html: tail });

  const textHtml = segments
    .filter((s): s is TextSegment => s.kind === 'text')
    .map((s) => s.html)
    .join('');

  return { segments, figures, textHtml };
}

/**
 * fix-6 P0-1：题首孤图后移（fix-2 F2-C；与 capture relocateLeadingFigures / 题库显示层语义一致）：
 * 段序列首部为连续图块群且其后存在可见文本时，图块群整体移到最后文本段之后
 * （存量菁优左文右图题引擎路径即时正常，不依赖重采）；纯图题保持原序。
 * 题根开标签等纯结构标记段（无可见文本/无内联内容）不阻断题首判定（capture 经外层
 * 正则剥 <div class="question"> 后扫描，此处段化后等价处理）。
 * 选项保持居尾（capture 同语义）：锚段选择跳过 options 独立段（fix-6 切分产物）→ 图插在选项前；
 * 未切分形态（异常/兜底）仍走 OPTIONS_TAIL_RE 拆分。
 * 仅 inline 路径消费方需要此语义；side-by-side 聚栏不受段序影响，提前执行无副作用。
 */
export function relocateLeadingFigureSegments(segments: ContentSegment[]): ContentSegment[] {
  const hasVisibleContent = (html: string): boolean =>
    visibleText(html) !== '' || /<(img|figure|svg)\b/i.test(html);

  const leading: ContentSegment[] = [];
  let start = 0;
  while (start < segments.length) {
    const seg = segments[start];
    if (seg.kind === 'figure') {
      leading.push(seg);
      start++;
      continue;
    }
    if (hasVisibleContent(seg.html)) break; // 首个可见内容节点（文本/行内图）→ 题首判定结束
    start++; // 纯结构标记段跳过
  }
  if (leading.length === 0 || start >= segments.length) return segments; // 无题首图 / 纯图题保持原序

  const rest = segments.slice(start);
  const hasText = rest.some((s) => isTextSegment(s) && visibleText(s.html) !== '');
  if (!hasText) return segments; // 图+公式无正文等场景保持原序（capture hasTextOutsideTags 同语义）

  // 插入锚点：最后一个含可见内容的 text 段之后；options 独立段（fix-6 切分产物）不作为锚——
  // 题首孤图落在选项之前（选项居尾语义）；该段含选项尾时拆分插在选项前（未切分形态兜底）
  let anchor = -1;
  for (let j = 0; j < rest.length; j++) {
    const seg = rest[j];
    if (isTextSegment(seg) && hasVisibleContent(seg.html) && !isOptionsSegment(seg)) anchor = j;
  }
  if (anchor < 0) return segments;

  // 结构前缀（题根开标签等）保持在序列最前
  const prefix = segments.slice(0, start - leading.length);
  const out = [...prefix, ...rest];
  const tail = out[prefix.length + anchor];
  if (isTextSegment(tail)) {
    const split = OPTIONS_TAIL_RE.exec(tail.html);
    if (split) {
      out.splice(prefix.length + anchor, 1,
        { kind: 'text', html: split[1] },
        ...leading,
        { kind: 'text', html: split[2] },
      );
      return out;
    }
  }
  out.splice(prefix.length + anchor + 1, 0, ...leading);
  return out;
}

/**
 * fix-6 P0-1：text 段内 .options 容器切分为独立 text 段（落点边界加密）。
 * 根因（用户目检五 #1）：题干与选项黏在同一 text 段的题（纯文本选项无图断开），
 * 段间无 .mf-seg 边界 → 拖图到选项前无候选落点/错位吸附（题尾或尾文前）。
 * 切分只增段边界不增减字符：text 段按序拼接复原完整结构 → 关闭 markers 的渲染输出
 * 与历史逐字节一致（打印/PDF 零改动）；options 容器成为独立段后其前后边界天然有标记，
 * 拖图落「选项前」可精确落锚（anchorIndex = options 段下标）。
 * div 平衡扫描定位容器闭合；无闭合（脏 HTML）不切分（保持原段，零风险）。
 */
export function isOptionsSegment(segment: ContentSegment): boolean {
  return segment.kind === 'text' && segment.html.trimStart().startsWith('<div class="options"');
}

function scanOptionsContainer(html: string): { start: number; end: number } | null {
  const open = OPTIONS_OPEN_RE.exec(html);
  if (!open) return null;
  const start = open.index;
  const tagRe = /<div\b|<\/div>/gi;
  tagRe.lastIndex = start;
  let depth = 0;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(html)) !== null) {
    depth += match[0] === '</div>' ? -1 : 1;
    if (depth === 0) return { start, end: tagRe.lastIndex };
  }
  return null;
}

export function splitOptionsSegments(segments: ContentSegment[]): ContentSegment[] {
  const out: ContentSegment[] = [];
  for (const segment of segments) {
    if (segment.kind !== 'text') {
      out.push(segment);
      continue;
    }
    const range = scanOptionsContainer(segment.html);
    if (!range) {
      out.push(segment);
      continue;
    }
    const before = segment.html.slice(0, range.start);
    const optionsHtml = segment.html.slice(range.start, range.end);
    const after = segment.html.slice(range.end);
    if (before) out.push({ kind: 'text', html: before });
    out.push({ kind: 'text', html: optionsHtml });
    if (after) out.push({ kind: 'text', html: after });
  }
  return out;
}

/**
 * 全局 figureLayout × 题级覆盖 → 渲染规格序列。
 * 排序：orderIndex 小者先；未指定者按原 DOM 序排在已指定者之后（稳定）。
 * 宽度优先级链（0004 Phase 5）：题级 widthPercent > 全局 figureLayout.widthPercent >
 * 默认观感档（null = min(原宽, 60% 版心/列宽)，见 0004-S4 交付报告）。
 * fix-2 F2-C：orderIndex 语义 = 交错段序列中的图块槽位目标序（渲染层按此把图块依序放回槽位）。
 * fix-5 P0-2：anchorIndex 存在时该图按段边界锚位落位（见 buildRenderSegments）；
 * 覆盖匹配按 assetId 归一（存量前缀形态兼容，见 normalizeAssetId）。
 */
export function applyFigureOverrides(
  figures: ParsedFigure[],
  globalLayout: { mode: 'inline' | 'side-by-side'; align: 'left' | 'center' | 'right'; widthPercent: number | null },
  overrides?: QuestionFigureLayout[]
): FigureRenderSpec[] {
  const byAsset = new Map<string, QuestionFigureLayout>();
  for (const override of overrides ?? []) {
    const id = normalizeAssetId(override.assetId) ?? override.assetId;
    if (!byAsset.has(id)) byAsset.set(id, override);
  }

  return figures
    .map((figure, domIndex) => {
      const key = figure.assetId === null ? null : (normalizeAssetId(figure.assetId) ?? figure.assetId);
      const override = key === null ? undefined : byAsset.get(key);
      return {
        figure,
        align: override?.align ?? globalLayout.align,
        sideBySide: (override?.mode ?? globalLayout.mode) === 'side-by-side',
        widthPercent: override?.widthPercent ?? globalLayout.widthPercent,
        orderKey: override?.orderIndex ?? Number.MAX_SAFE_INTEGER,
        domIndex,
        anchorIndex: override?.anchorIndex ?? null,
      };
    })
    .sort((a, b) => a.orderKey - b.orderKey || a.domIndex - b.domIndex);
}

/**
 * 0004-fix-5 P0-2：题内图排版计划（块化/提升/外来合成/段边界归属）——引擎与 UI 共用的唯一入口。
 * 语义与 fix-2/fix-3/fix-4 逐项一致（覆盖提升、语义豁免、题首孤图后移、外来图题尾合成），
 * 新增：①覆盖 assetId 归一（存量前缀形态兼容）；②homeBoundary（图块在段序列中的原段下标）
 * 与 boundaryCount（全部可落点边界数 = 段数）——交互层落点指示线与 UI 锚位换算的基准。
 */
export interface QuestionFigurePlan {
  /** 交错段序列（题首孤图后移 + 外来图题尾合成后的最终序） */
  segments: ContentSegment[];
  /** 全部图块（content 内参与块化者 + 外来合成者；DOM/内容序） */
  figures: ParsedFigure[];
  /** 覆盖含但 content 匹配不到的外来 assetId（归一形态） */
  foreignAssets: string[];
  /** 图块 → 其段下标（无显式锚时的原位边界） */
  homeBoundary: Map<ParsedFigure, number>;
  /** 可落点边界数 = segments.length（边界 0..n，边界 k = 第 k 段之前） */
  boundaryCount: number;
}

export function planQuestionFigures(
  content: string,
  imageTypes: ImageTypeTable,
  overrideFigures?: QuestionFigureLayout[],
  /** 0035（只增，opt-in）：.inline-figure 包裹的行内小图不参与块化（DOCX 导出侧用；缺省零变化）；
   * 0041：排版/预览/PDF 路径同样开启（行内公式图固定随文流），且覆盖条目对行内公式图不生效。 */
  options?: { skipInlineFigureWrap?: boolean }
): QuestionFigurePlan {
  const inlineWrapped = options?.skipInlineFigureWrap === true ? inlineFigureAssetIds(content) : null;
  const promotedAssets = new Set(
    (overrideFigures ?? [])
      .map((f) => normalizeAssetId(f.assetId) ?? f.assetId)
      .filter((assetId) => isPromotableAsset(assetId, imageTypes))
      // 0041：行内公式图不做覆盖提升（既不成块，也不作为「覆盖含但 content 匹配不到」的外来图合成）——
      // 存量 layout_json 里对行内公式的条目（历史 UI 全量写入所致）由此自然失效，公式回到文本流。
      .filter((assetId) => inlineWrapped === null || !inlineWrapped.has(assetId))
  );
  const blocks = blockifyQuestionContent(content, imageTypes, promotedAssets, options);
  const matchedAssets = new Set(blocks.figures.map((f) => f.assetId));
  const foreignAssets = [...promotedAssets].filter((assetId) => !matchedAssets.has(assetId));
  const foreignFigures = foreignAssets.map((assetId): ParsedFigure => ({
    html: foreignFigureHtml(assetId),
    assetId,
  }));
  const segments: ContentSegment[] = [
    // fix-6 P0-1：先切 options 独立段（边界加密、拼接不变）再题首孤图后移（锚段跳过 options 段）
    ...relocateLeadingFigureSegments(splitOptionsSegments(blocks.segments)),
    ...foreignFigures.map((figure): ContentSegment => ({ kind: 'figure', figure })),
  ];
  const homeBoundary = new Map<ParsedFigure, number>();
  segments.forEach((segment, index) => {
    if (segment.kind === 'figure') homeBoundary.set(segment.figure, index);
  });
  return {
    segments,
    figures: [...blocks.figures, ...foreignFigures],
    foreignAssets,
    homeBoundary,
    boundaryCount: segments.length,
  };
}

/** 渲染段（fix-5 P0-2：+ marker 边界标记；markers 关闭时输出与历史同形） */
export type RenderSegment =
  | { kind: 'text'; html: string }
  | { kind: 'figure'; spec: FigureRenderSpec }
  | { kind: 'marker'; boundary: number };

export interface BuildRenderSegmentsOptions {
  /** 段边界标记（交互预览用；缺省 false = 打印/PDF 与历史输出零改动） */
  markers?: boolean;
}

/**
 * 交错段渲染序列（fix-2 F2-C 槽位语义 + fix-5 P0-2 段边界锚语义）。
 * 无锚数据（存量 orderIndex 覆盖 / 无覆盖）：排序后的图块依段序填充图块槽位——与历史逐字节一致。
 * 存在锚位（anchorIndex 非 null）时：有锚图块落显式边界；未锚图块保持原位段下标（不因他人移动漂移）；
 * 同边界多图按 specs 序（orderKey/domIndex）稳定排列。
 * markers=true 时在每个边界（0..n）前插入 marker 段——边界 k = 第 k 段之前，交互层据此吸附。
 */
export function buildRenderSegments(
  segments: ContentSegment[],
  specs: FigureRenderSpec[],
  options?: BuildRenderSegmentsOptions
): RenderSegment[] {
  const total = segments.length;
  const at = new Map<number, FigureRenderSpec[]>();
  const place = (pos: number, spec: FigureRenderSpec): void => {
    const list = at.get(pos);
    if (list) list.push(spec);
    else at.set(pos, [spec]);
  };

  const home = new Map<ParsedFigure, number>();
  segments.forEach((segment, index) => {
    if (segment.kind === 'figure') home.set(segment.figure, index);
  });

  const hasAnchor = specs.some((spec) => spec.anchorIndex !== null);
  if (!hasAnchor) {
    // 旧语义：槽位填充（段序中的图块段依序接排序后的 specs）
    const slots = segments
      .map((segment, index) => (segment.kind === 'figure' ? index : -1))
      .filter((index) => index >= 0);
    specs.forEach((spec, k) => place(k < slots.length ? slots[k] : total, spec));
  } else {
    // 新语义：显式锚优先；未锚者保持原位（home）
    for (const spec of specs) {
      const raw = spec.anchorIndex;
      const pos = raw === null
        ? (home.get(spec.figure) ?? total)
        : Math.min(total, Math.max(0, Math.round(raw)));
      place(pos, spec);
    }
  }

  const out: RenderSegment[] = [];
  for (let i = 0; i <= total; i++) {
    if (options?.markers === true) out.push({ kind: 'marker', boundary: i });
    for (const spec of at.get(i) ?? []) out.push({ kind: 'figure', spec });
    if (i < total) {
      const segment = segments[i];
      if (segment.kind === 'text') out.push({ kind: 'text', html: segment.html });
    }
  }
  return out;
}

/**
 * 0058（选项① 授权，用户 2026-09-22「按选项1来」）：内层拉满兜底。
 * 覆盖档下若内层**无内联宽**（figure 无 data-w/style 的「情形 B」——外来合成图、识别链 data-w="0" 形态），
 * 上面两条剥壳正则都不命中 ⇒ 落库后 figure 仍被 `paper.css` 的 `figure:not([style]) > img { max-width: 60% }`
 * 与 layout 的 `.figure-block > figure:not([style]) { max-width: 60% }` 双重封顶（≈0.36 块宽），
 * 而拖中运行时已把内层拉满 ⇒ 「拖中 1:1、松手回缩」，手感回退。
 * 故此处按运行时 stretchFigureInner 同形补写 width:100%;max-width:100%（figure 与其内无样式的 img），
 * 使「有覆盖档时 图宽 == 块宽 == widthPercent × 父内容宽」对 A/B 两形态统一成立。
 * 已有内联样式的元素一律不碰（不越权改采集/用户给定样式）；widthPercent=null（无覆盖档）走不到这里，
 * 默认观感档由 CSS 单一承担（打印/PDF 输出逐字节不变）。
 */
function fillStatelessInner(inner: string): string {
  const filled = 'width: 100%; max-width: 100%;';
  const addStyle = (tag: string): string => (/\/>$/.test(tag)
    ? tag.replace(/\/>$/, ` style="${filled}" />`)
    : tag.replace(/>$/, ` style="${filled}">`));
  let out = inner;
  if (/^<figure\b(?![^>]*\bstyle=)/i.test(out)) out = out.replace(/^<figure\b[^>]*>/i, (tag) => addStyle(tag));
  // 内层 img 同样拉满：figure 拿到 style 后 img 只受 max-width:100% 约束，小图（自然宽 < 块宽）仍停在原像素宽
  out = out.replace(/<img\b(?![^>]*\bstyle=)[^>]*>/gi, (tag) => addStyle(tag));
  return out;
}

/** 单图块 HTML：align 作用于块位置与内部图对齐；widthPercent 缩放为版心内容宽百分比 */
export function renderFigureBlock(spec: FigureRenderSpec): string {
  let inner = spec.figure.html;
  let widthStyle = '';
  if (spec.widthPercent !== null) {
    // 覆盖缩放：剥 processFigures 生成的像素宽/60% 默认档封顶（精确匹配其输出格式），交外层块控制尺寸。
    // fix-6 P0-2（实机取证）：仅剥 figure 层时独立 <img style="width: NNNpx;"> 恒定原宽——
    // 块 648px 内 img 144px，拖手柄/重建后图视觉不变（「部分图不可调」根因），img 固定宽一并剥为 100%；
    // 内联 max-width:100% 压过 layout 注入的 `.figure-block > img { max-width: 60% }` 默认档（无覆盖图不受影响）
    inner = inner.replace(/width:\s*[\d.]+px;\s*max-width:\s*60%;/, 'width: 100%; max-width: 100%;');
    inner = inner.replace(/(<img\b[^>]*?\bstyle="[^"]*?)\bwidth:\s*[\d.]+px;\s*/gi, '$1width: 100%; max-width: 100%; ');
    // 0058：无内联宽形态（情形 B）补拉满兜底（见 fillStatelessInner 注释）
    inner = fillStatelessInner(inner);
    // 0067（R-069）：块级对齐须随覆盖档一并生效——`figure-block--{align}` 类只对齐**块内** figure
    // （layout.ts `.figure-block--left > figure` 等），块自身横向位置由内联 margin 决定；覆盖档下恒写双 auto
    // 会把块重拉回居中 ⇒ 调宽后点「居左/居右」视觉无效（用户返工轮三报告）。故与 align 同源：
    // left→left:0/right:auto、right→left:auto/right:0、center→双 auto（历史输出逐字节不变）。
    const sideMargins = spec.align === 'left'
      ? 'margin-left: 0; margin-right: auto;'
      : (spec.align === 'right' ? 'margin-left: auto; margin-right: 0;' : 'margin-left: auto; margin-right: auto;');
    widthStyle = `width: ${Number(spec.widthPercent.toFixed(2))}%; ${sideMargins}`;
  }
  return `<div class="figure-block figure-block--${spec.align}"${widthStyle ? ` style="${widthStyle}"` : ''}>${inner}</div>`;
}

/**
 * 外来图合成 figure HTML（fix-3 P0-1）：覆盖含但 content 匹配不到的图（插图/外来 assetId）
 * 以统一 figure 形态进段序列（题尾默认位），src 保持 data-assets 相对引用交统一重写管线。
 * mf-foreign 标记供探针/UI 识别（不参与样式）。
 * fix-5 P0-3：assetId 先归一再去前缀拼装——存量覆盖带 `data-assets/` 前缀时旧实现产出
 * `data-assets/data-assets/…`（裂图），见 normalizeAssetId 注释。
 */
export function foreignFigureHtml(assetId: string): string {
  const rel = normalizeAssetId(assetId) ?? assetId;
  const safe = rel.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<figure class="mf-foreign"><img src="data-assets/${safe}"></figure>`;
}
