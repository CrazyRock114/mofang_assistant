// 0056（R-041）图定位 + 0065（R-068）字段分流（纯函数，零 IO）。
//
// 整理对象（0056 §零.3/§零.6 + 0065 §一.1/§一.2）：
//   ① content 内 **行内图**（span.inline-figure 包裹）——采集链的行内图 = 公式图（R-064 判定收紧后
//      「位图且高 >60px」已走块级，行内包裹的位图只剩公式条与 SVG 公式）；
//      块级 figure.diagram（真配图）不转写——它不是公式，转成文字会丢掉图形语义；
//   ② answer / analysis 字段里的图——学科网/组卷的「答案+解析防采集图」，转写后拆回两字段（拍板②）；
//      0069 起**含正文字段**里的「位图 + 块级 figure.diagram + data-h > 60px」判为真配图，不做靶（R-064 判据分流）。
//
// 0065 把 ② 一分为二（**本单的核心分流**，按「字段里有没有正文」定整理方式）：
//   · 字段**就是一张图**（无正文）→ `mode: 'replace-field'`：整字段替换 + 引擎 answer/analysis 双出（0056 口径）；
//   · 字段**有正文**（正文 + 混排小图）→ `mode: 'inline-figures'`：逐图转写后**原位替换**成
//     `<span class="math" data-tex>`，正文一字不动。0056 的 `deferred`（整字段放弃）由此退役。
//
// 本层只回答「哪些图要转、在哪、怎么合回」；图字节与模型调用由调用方喂（主进程编排）。

import type { QuestionImage } from '../../shared/contracts/bank-types.js';

export type AiCleanField = 'content' | 'answer' | 'analysis';

/**
 * 图所在区域（合回口径用）：
 *   stem/options = content 内的题干区/选项区（选项区图恒行内，见 0056 R-064 判定）；
 *   answer/analysis = 对应字段整体（字段即答案/解析语义）。
 */
export type AiCleanRegion = 'stem' | 'options' | 'answer' | 'analysis';

/** 图种：formula = 行内公式图（原位换 span.math）；answer = 答案/解析图（字段整体换文字） */
export type AiCleanTargetKind = 'formula' | 'answer';

/**
 * 0065：该靶怎么合回（契约面 `QuestionAiCleanApplyMode` 同源）。
 *   · `replace-field`：字段整体替换（字段=整张防采集图；引擎 answer/analysis 双出）；
 *   · `inline-figures`：逐图原位替换为 `span.math`（压成字段**正文一字不动**，含 answer/analysis 字段）。
 */
export type AiCleanApplyMode = 'replace-field' | 'inline-figures';

export interface AiCleanTarget {
  field: AiCleanField;
  region: AiCleanRegion;
  /** 字段 HTML 内的原样 src（data-assets/… 相对引用） */
  src: string;
  /** 相对 `data/assets` 的路径（读字节用） */
  assetRelPath: string;
  kind: AiCleanTargetKind;
  /** 0065：合回方式（= 该靶所在字段的分流结论） */
  mode: AiCleanApplyMode;
  /** data-w/data-h 原值（0 = 未知/未写） */
  width: number;
  height: number;
}

export interface AiCleanSource {
  content: string;
  answer: string;
  analysis: string;
}

/**
 * 0056 返工⑧的 `deferred` 面（本批**不整理**的图）在 0065 已退役：
 * 「字段有正文 → 整字段放弃」改为「该字段走原位模式」（见 `fieldTargets`）。
 * 类型与 `AiCleanPlan.deferred` 字段保留（契约 `QuestionAiCleanItem.deferred` 只增不删的兼容面，
 * 弹层旧块仍在），本单起恒为空数组。
 */
export interface AiCleanDeferredTarget {
  field: 'answer' | 'analysis';
  src: string;
  assetRelPath: string;
  reason: string;
}

export interface AiCleanPlan {
  targets: AiCleanTarget[];
  /** targets 为空时的原因（人读；不为空 = 不必送引擎） */
  reason: string | null;
  /** 本批不整理的图（附原因；「答案解析链」另单处理的那些） */
  deferred: AiCleanDeferredTarget[];
}

/** `data-assets/<rel>` → `<rel>`；非 data-assets 引用（远程 src / 内联 data URL / mock 演示图）→ null */
export function assetRelPathOf(src: string): string | null {
  const prefix = 'data-assets/';
  if (!src.startsWith(prefix) || src.length <= prefix.length) return null;
  return src.slice(prefix.length);
}

/** 行内图 span（形态见 question-content.ts：span.inline-figure 内恰一张 img） */
const INLINE_FIGURE_RE = /<span\b[^>]*\bclass\s*=\s*"[^"]*\binline-figure\b[^"]*"[^>]*>\s*<img\b[^>]*>\s*<\/span>/gi;
/** 单张 img 取用（无 g 旗——避免与全局正则在循环里共享 lastIndex） */
const IMG_TAG_RE = /<img\b[^>]*>/i;
/** 选项区起点（契约壳 `<div class="options">`；无 = 全按题干区算） */
const OPTIONS_OPEN_RE = /<div\b[^>]*\bclass\s*=\s*"[^"]*\boptions\b[^"]*"[^>]*>/i;

function attrOf(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return match ? (match[1] ?? match[2] ?? '') : null;
}

function numberOf(value: string | null): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function targetFrom(
  field: AiCleanField,
  region: AiCleanRegion,
  imgTag: string,
  kind: AiCleanTargetKind,
  mode: AiCleanApplyMode,
): AiCleanTarget | null {
  const src = attrOf(imgTag, 'src');
  if (!src) return null;
  const assetRelPath = assetRelPathOf(src);
  if (assetRelPath === null) return null;
  return {
    field,
    region,
    src,
    assetRelPath,
    kind,
    mode,
    width: numberOf(attrOf(imgTag, 'data-w')),
    height: numberOf(attrOf(imgTag, 'data-h')),
  };
}

/**
 * 0069（R-075）：R-064 判据的**真配图**高度阈（px）——位图且高 > 此值 = 真配图（几何图形/函数图像/电路图）。
 *
 * 与采集链 `capture/normalize.ts` 的 `INLINE_IMAGE_MAX_HEIGHT_PX` 同值同口径（60：公式条高 ≤20px、
 * 真配图最小高 80px 的实测分离带中点）。此处**不 import**（recognition 不得反向依赖 capture，
 * 架构 §1.1 依赖单向），故按 R-064 口径在本地重声明并由测试锁值。
 */
const REAL_FIGURE_MIN_HEIGHT_PX = 60;

/** 非位图判据（.svg 是公式类矢量特征；与 `capture/normalize.ts` 的 VECTOR_SRC_RE 同口径本地重声明） */
const VECTOR_SRC_RE = /\.svg(\?|#|$)/i;

/** content 内的行内图：选项区前的算题干区，之后的算选项区（选项区恒行内，R-064 口径） */
function contentTargets(content: string): AiCleanTarget[] {
  if (!content.includes('inline-figure')) return [];
  const optionsAt = OPTIONS_OPEN_RE.exec(content)?.index ?? -1;
  const targets: AiCleanTarget[] = [];
  for (const match of content.matchAll(INLINE_FIGURE_RE)) {
    const index = match.index ?? 0;
    const img = IMG_TAG_RE.exec(match[0]);
    if (!img) continue;
    const region: AiCleanRegion = optionsAt >= 0 && index >= optionsAt ? 'options' : 'stem';
    // content 恒为原位替换（0056 口径零变化）
    const target = targetFrom('content', region, img[0], 'formula', 'inline-figures');
    if (target) targets.push(target);
  }
  return targets;
}

/** 字段里除图之外的可见文字（与 merge 的「整体替换会丢字」判据同口径） */
export function textOutsideImages(html: string): string {
  return (html ?? '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, ' ')
    .trim();
}

/** 答案解析链（0056 弹层的灰字说明）——0056 口径下的「本批不处理」，0065 起该挡门已退役 */
export const DEFERRED_ANSWER_FIELD_REASON =
  '解析/答案区含正文的内嵌图：整字段替换会冲掉正文，归「答案解析链」另单处理（本单只转题面公式）';

/**
 * 答案/解析字段内的图扫描（0069 扩：块级包裹与裸 img 分开认）。
 * 捕获组 1 = `<figure class="diagram">` 内的 img（块级；真配图判据要读**包裹元素**上的 data-h
 * ——采集链把块级图的尺寸写在 figure 上、行内图写在 img 上）；组 2 = 行内/裸 img。
 */
const FIELD_IMAGE_SCAN_RE = new RegExp(
  '<figure\\b[^>]*\\bclass\\s*=\\s*"[^"]*\\bdiagram\\b[^"]*"[^>]*>\\s*(<img\\b[^>]*>)\\s*<\\/figure>'
  + '|(<img\\b[^>]*>)',
  'gi',
);

/**
 * 0069（R-075 · D-083 沿用 R-064 判据）：块级 `figure.diagram` 里的**真配图**。
 * 位图（非 .svg）且 data-h > 60px = 几何图形/函数图像一类真配图 → **不做转写靶、原样保留**
 * （它已是独立资产，转成文字会丢图形语义）；矢量图不走此阈（R-064 同口径），尺寸未知（0）也不判
 * ——宁可多转也不静默吞图。
 */
function isBlockRealFigure(wrapperHtml: string, imgTag: string): boolean {
  const src = attrOf(imgTag, 'src') ?? '';
  if (VECTOR_SRC_RE.test(src)) return false;
  const figureTag = /<figure\b[^>]*>/i.exec(wrapperHtml)?.[0] ?? '';
  const height = numberOf(attrOf(figureTag, 'data-h')) || numberOf(attrOf(imgTag, 'data-h'));
  return height > REAL_FIGURE_MIN_HEIGHT_PX;
}

/**
 * 答案/解析字段内的图（裸 img、行内包裹、块级包裹一视同仁：0056 起该字段的图都算待整理对象）。
 *
 * 0065 分流（按**字段里有没有正文**）：
 *   · 有正文 → `inline-figures`：逐图转写后原位替换，正文一字不动（原位替换只动 img 节点，
 *     正文守恒由 merge 层与测试双锁）；
 *   · 无正文（字段就是一张图）→ `replace-field`：整字段替换 + 引擎双出（0056 口径）。
 *
 * 0069 再加一道「字里那张图要不要转」的判据（**只在含正文字段生效**）：
 *   · 位图 + 块级 `figure.diagram` + data-h > 60px = **真配图 → 不做靶**（原样保留）；
 *   · 无正文字段（整图靶）不受此判据影响——那里的图就是待转写的答案/解析整页图。
 */
function fieldTargets(field: 'answer' | 'analysis', html: string): AiCleanTarget[] {
  if (!html || !html.includes('<img')) return [];
  const hasText = textOutsideImages(html) !== '';
  const mode: AiCleanApplyMode = hasText ? 'inline-figures' : 'replace-field';
  const kind: AiCleanTargetKind = hasText ? 'formula' : 'answer';
  const targets: AiCleanTarget[] = [];
  for (const match of html.matchAll(FIELD_IMAGE_SCAN_RE)) {
    const blockImg = match[1];
    const imgTag = blockImg ?? match[2];
    if (!imgTag) continue;
    if (hasText && blockImg !== undefined && isBlockRealFigure(match[0], blockImg)) continue;
    const target = targetFrom(field, field, imgTag, kind, mode);
    if (target) targets.push(target);
  }
  return targets;
}

/**
 * 同一张资产在题内出现多次（真库实测：一道题把同一张公式图引用三四回）→ **只保留首次**。
 *
 * 为什么必须去重（0069 目检返工①：用户看到 4 条一模一样的长告警，真库题 c476a786 现场）：
 * 整理的工作单位是「一张图」——引擎按 `${kind}:${资产}` 缓存、合回按 src 全局替换，
 * 重复靶只会 ① 把同一张图重复塞进公式拼图（模型对重复格子产出不一致 → 假「起疑」告警）、
 * ② 把同一条告警按引用次数重复报出（10 个靶 = 每条告警说 2~3 遍）。**语义零变化**：
 * 原位替换按 src 匹配，出现几次就替换几处（`converted` 仍按替换处数计）。
 */
function dedupeTargets(targets: AiCleanTarget[]): AiCleanTarget[] {
  const seen = new Set<string>();
  const out: AiCleanTarget[] = [];
  for (const target of targets) {
    const key = `${target.kind}:${target.assetRelPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(target);
  }
  return out;
}

/**
 * 定位待整理图。targets 按「题干 → 选项 → 答案 → 解析」的阅读序排列（逐题串行的调用序即此序），
 * 同一资产（同 kind）只出现一次（见 `dedupeTargets`）。
 */
export function planAiClean(source: AiCleanSource): AiCleanPlan {
  const targets = dedupeTargets([
    ...contentTargets(source.content ?? ''),
    ...fieldTargets('answer', source.answer ?? ''),
    ...fieldTargets('analysis', source.analysis ?? ''),
  ]);
  // deferred 自 0065 起恒为空（含正文字段改走原位模式）——保留字段以兼容 0056 弹层与契约只增
  const deferred: AiCleanDeferredTarget[] = [];
  if (targets.length === 0) {
    return {
      targets,
      deferred,
      reason: '题内无行内公式图/答案图（无 data-assets 图可转写），无需整理',
    };
  }
  return { targets, deferred, reason: null };
}

/** images 列里某条目的资产引用（兼容旧形态：字符串条目 / 带或不带 data-assets 前缀） */
export function imageEntryRef(entry: QuestionImage | string): string {
  const raw = typeof entry === 'string' ? entry : entry?.assetId ?? '';
  return raw.startsWith('data-assets/') ? raw.slice('data-assets/'.length) : raw;
}
