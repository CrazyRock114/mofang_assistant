/**
 * 采集内容归一化：原始 HTML → question-content 契约结构
 */

import type { CapturedQuestion, NormalizedCaptureQuestion } from '../shared/contracts/capture-types.js';

/** 归一化入参图片：契约字段 + 下载层读取的真实像素尺寸（D1-fix R-4，契约只读不改类型） */
type NormalizedImages = Array<{
  localPath: string;
  origSrc: string;
  role: 'content' | 'answer';
  width?: number;
  height?: number;
}>;

/** 清洗白名单：只保留安全标签，其余整标签剥除（内部文本保留） */
const ALLOWED_TAGS = new Set([
  'p', 'div', 'span', 'br', 'hr',
  'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup',
  'img', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'ul', 'ol', 'li', 'figure', 'figcaption', 'blockquote',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]);

/** 清洗白名单：只保留安全属性（class/src/alt/表格跨格/公式与图片尺寸 data-*） */
const ALLOWED_ATTRS = new Set([
  'class', 'title', 'src', 'alt', 'colspan', 'rowspan',
  'data-tex', 'data-display', 'data-w', 'data-h',
]);

/** 剥除白名单外属性，重建标签（属性值统一双引号） */
function rebuildTag(tagName: string, attrsText: string): string {
  const parts: string[] = [];
  const attrRe = /([a-zA-Z][a-zA-Z0-9-]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(attrsText))) {
    const name = m[1].toLowerCase();
    if (!ALLOWED_ATTRS.has(name) || m[2] === undefined) continue;
    let value = m[2];
    if (!value.startsWith('"') && !value.startsWith("'")) value = `"${value}"`;
    else if (value.startsWith("'")) value = `"${value.slice(1, -1)}"`;
    parts.push(`${name}=${value}`);
  }
  return `<${tagName}${parts.length > 0 ? ' ' + parts.join(' ') : ''}>`;
}

/**
 * HTML 清洗：危险内容剥离 + 标签/属性白名单（D1-fix R-7）
 * 白名单外标签（含 spanTimes 类畸形粘连标签）整标签剥除；站点私有属性（qml-space-size 等）随属性白名单剥除
 */
export function cleanCapturedHtml(html: string): string {
  // 剥离 script/iframe/style 标签
  let cleaned = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  cleaned = cleaned.replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '');
  cleaned = cleaned.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

  // 剥离注释
  cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, '');

  // 剥离危险属性：on* 事件、javascript: 链接（白名单重建前的快速通道）
  cleaned = cleaned.replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, '');
  cleaned = cleaned.replace(/\s+on\w+\s*=\s*[^\s>]+/gi, '');
  cleaned = cleaned.replace(/href\s*=\s*["']javascript:[^"']*["']/gi, '');

  // 剥离 style 属性（保留 class）
  cleaned = cleaned.replace(/\s+style\s*=\s*["'][^"']*["']/gi, '');

  // 标签/属性白名单：逐个标签重建，白名单外整标签剥除（文本保留）
  cleaned = cleaned.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s|\/)[^<>]*?)?(\/?)>/g, (match, closing: string, name: string, attrs: string | undefined) => {
    const tagName = name.toLowerCase();
    if (!ALLOWED_TAGS.has(tagName)) return '';
    if (closing) return `</${tagName}>`;
    return rebuildTag(tagName, attrs ?? '');
  });

  return cleaned;
}

/**
 * 选项 HTML 归一化（D1-fix-2 F-5）：保留清洗后的 HTML（含公式图），仅收敛两端空白。
 * 旧实现剥成纯文本会丢掉选项内公式图——调用前需经 cleanCapturedHtml/wrapImagesAsFigures
 */
function normalizeOptionHtml(optionHtml: string): string {
  return optionHtml.trim();
}

/**
 * 入库题干题号前缀剥离（D1-fix-2 F-2）：篮内题卡题号（"1 . "、"2、"、【推荐N】）不是题干正文。
 * 仅剥开头；小数（3.14米）不误剥（点后紧跟数字则不剥）；前缀在首个块级标签内（<p>1. …）同样处理
 */
export function stripStemLeadingIndex(html: string): string {
  const PREFIX = /^\s*(?:【推荐\d+】\s*(?:\d+\s*[.、．](?!\s*\d)\s*)?|\d+\s*[.、．](?!\s*\d)\s*)/;
  const stripped = html.replace(PREFIX, '');
  if (stripped !== html) return stripped;
  return html.replace(
    /^(\s*<(?:p|div)[^>]*>\s*)(?:【推荐\d+】\s*(?:\d+\s*[.、．](?!\s*\d)\s*)?|\d+\s*[.、．](?!\s*\d)\s*)/,
    '$1',
  );
}

/**
 * 行内图高度阈值（px）：位图高 ≤ 此值判为「公式条」留文字流（0056 R-064 新判据）
 *
 * 旧口径（0016 前）是「宽高都 ≤200 一律行内」的**纯尺寸判定**，不看语义——菁优 94~197px 的真配图
 * 被当成行内公式图，而排版侧 0041 口径把所有 inline-figure 排除在图片排版之外（不块化 / 不列出 /
 * 点不动）→ 用户报障「采集题图片无法调整」（诊断在案：inline-figure 诊断台账，
 * 真库 63 道）。新判据的实测分离带宽裕：公式条高 ≤20px、真配图最小高 80px，60 取中间。
 */
export const INLINE_IMAGE_MAX_HEIGHT_PX = 60;

/**
 * 兜底尺寸阈（px，0056 R-064 收窄后只服务于**非位图**：.svg 矢量图与尺寸未知）
 * ——大 SVG（配图）与未知尺寸仍按旧「宽高都 ≤200 才行内」走块级，保住可调；
 * 位图不再看此阈（只看 INLINE_IMAGE_MAX_HEIGHT_PX）。
 */
export const INLINE_IMAGE_MAX_PX = 200;

/** 图所在区域（0056 R-064）：选项区恒行内——块级 figure 进 <span class="option"> 会破选项行版式 */
export type NormalizeRegion = 'stem' | 'options' | 'answer' | 'analysis';

/** 非位图判据：.svg 是公式类矢量特征（组卷公式 33×12 级），不参与「大图块级」判定 */
const VECTOR_SRC_RE = /\.svg(\?|#|$)/i;

/**
 * 裸 img 包裹为 render 层消费的 question-content 契约结构（D1-fix R-3/R-4 治本；0056 R-064 改判据）：
 * - 选项区（region='options'）→ **恒** `<span class="inline-figure">` 行内元素（不拽出文字流）
 * - 位图（非 .svg）且高 > 60px → `<figure class="diagram">` 块级居中（真配图，可调）
 * - 位图高 ≤ 60px → `<span class="inline-figure">` 行内（公式条，随文字流）
 * - 非位图（.svg）→ 沿用兜底尺寸阈（≤200 双阈行内，大 SVG 块级——矢量配图同样可调）
 * - 尺寸未知（0）→ `<figure class="diagram">`（沿用旧口径：未知不给「行内 = 不可调」新盲区）
 * data-w/h 写在 img 上（行内）或 figure 上（块级，未知 = 0，渲染按 max-width 限）
 * imageSizes：下载层读到的真实像素尺寸（key = HTML 内 src，即落盘后的 data-assets 相对路径）
 */
export function wrapImagesAsFigures(
  html: string,
  imageSizes?: Map<string, { width?: number; height?: number }>,
  region: NormalizeRegion = 'stem',
): string {
  return html.replace(/<img\b([^>]*?)\/?>/gi, (match, attrs: string) => {
    const src =
      /\bsrc\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ??
      /\bsrc\s*=\s*'([^']*)'/i.exec(attrs)?.[1] ??
      '';
    if (!src) return match;
    const dims = imageSizes?.get(src);
    const w = dims?.width ?? 0;
    const h = dims?.height ?? 0;
    const known = w > 0 && h > 0;
    const isVector = VECTOR_SRC_RE.test(src);
    const inline = region === 'options'
      ? true
      : known
        ? (isVector ? w <= INLINE_IMAGE_MAX_PX && h <= INLINE_IMAGE_MAX_PX : h <= INLINE_IMAGE_MAX_HEIGHT_PX)
        : false;
    if (inline) {
      return `<span class="inline-figure"><img class="q-figure" data-w="${w}" data-h="${h}" src="${src}"></span>`;
    }
    return `<figure class="diagram" data-w="${w}" data-h="${h}"><img class="q-figure" src="${src}"></figure>`;
  });
}

/** 归一化入参 → src 尺寸查找表（下载落盘后 HTML src 已是 localPath） */
function buildImageSizeMap(images: NormalizedImages): Map<string, { width?: number; height?: number }> {
  const map = new Map<string, { width?: number; height?: number }>();
  for (const img of images) {
    map.set(img.localPath, { width: img.width, height: img.height });
  }
  return map;
}

/* ===== 0004-fix-1c B组：题首孤图后移 =====
 * 菁优"左文右图"题靠站点 CSS 并排布局，剥离样式后 DOM 顺序暴露为图前置（真库证据 48e21ffd：
 * 题干首个节点即 <span class="inline-figure"><img…>，文本在后）→ 题库/卷面图冲题首。
 * 在归一化产物（wrapImagesAsFigures 之后，图已是 figure/span.inline-figure 契约结构）上后移。 */

/** 行内图 span 开标签（class 含 inline-figure） */
const INLINE_FIGURE_OPEN_RE = /^<span\b[^>]*\bclass\s*=\s*["'][^"']*\binline-figure\b[^"']*["'][^>]*>/i;

/** void 标签无闭合（顶层扫描用） */
const VOID_TAGS = new Set(['img', 'br', 'hr']);

/** 开标签解析：返回标签名与开标签结束下标 */
function openTagAt(html: string, start: number): { tag: string; openEnd: number } | null {
  if (html[start] !== '<') return null;
  const nameMatch = /^<([a-zA-Z][a-zA-Z0-9]*)/.exec(html.slice(start, start + 32));
  if (!nameMatch) return null;
  const gt = html.indexOf('>', start);
  if (gt === -1) return null;
  return { tag: nameMatch[1].toLowerCase(), openEnd: gt + 1 };
}

/** 与开标签配对的闭合结束下标（深度计数；void 标签 = 开标签结束；未闭合容错为末尾） */
function closeTagEnd(html: string, tag: string, openEnd: number): number {
  if (VOID_TAGS.has(tag)) return openEnd;
  const re = new RegExp(`<(/?)${tag}\\b[^>]*?>`, 'gi');
  re.lastIndex = openEnd;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[1]) {
      depth--;
      if (depth === 0) return re.lastIndex;
    } else if (!/\/>$/.test(m[0])) {
      depth++;
    }
  }
  return html.length;
}

/**
 * 判定 html 从 start 起是否"可后移图块"，是则返回节点结束下标：
 * - <figure …>…</figure>（块级配图，任意内部结构）
 * - <span class="inline-figure">…</span>（行内图 span；菁优左文右图实证形态）
 * - 包裹孤图的 <p>：内部恰一个 figure 且无其它非空文本（整 p 后移；
 *   p 包行内公式图不算——公式前置是正当语序，后移会破坏阅读顺序）
 */
function figureBlockEndAt(html: string, start: number): number | null {
  const open = openTagAt(html, start);
  if (!open) return null;
  const { tag, openEnd } = open;
  if (tag === 'figure') return closeTagEnd(html, tag, openEnd);
  if (tag === 'span') {
    return INLINE_FIGURE_OPEN_RE.test(html.slice(start, openEnd)) ? closeTagEnd(html, tag, openEnd) : null;
  }
  if (tag === 'p') {
    const closeEnd = closeTagEnd(html, tag, openEnd);
    const closeStart = html.lastIndexOf('</p', closeEnd);
    if (closeStart <= openEnd) return null;
    const inner = html.slice(openEnd, closeStart);
    const figureCount = (inner.match(/<figure\b/gi) || []).length;
    const textLeft = inner.replace(/<[^>]*>/g, '').trim();
    return figureCount === 1 && !textLeft ? closeEnd : null;
  }
  return null;
}

/** 剥标签后剩余非空文本（"纯图题"判定用：图块后无文本则不后移） */
function hasTextOutsideTags(html: string): boolean {
  return html.replace(/<[^>]*>/g, '').trim().length > 0;
}

/** 题干区后移：首个非空节点起的连续图块群（可夹空白）整体移到区末；其后无文本（纯图题）不动 */
function relocateStemRegion(stem: string): string {
  const lower = stem.toLowerCase();
  if (!lower.includes('<figure') && !lower.includes('inline-figure')) return stem;
  let i = 0;
  let groupStart = -1;
  let groupEnd = -1;
  while (i < stem.length) {
    if (stem[i] === '<') {
      const end = figureBlockEndAt(stem, i);
      if (end === null) break; // 首个非空节点不是图块（文本/公式/其它元素）
      if (groupStart === -1) groupStart = i;
      groupEnd = i = end;
    } else {
      const next = stem.indexOf('<', i);
      const chunk = stem.slice(i, next === -1 ? stem.length : next);
      if (chunk.trim()) break; // 首个非空节点是文本
      i = next === -1 ? stem.length : next;
    }
  }
  if (groupStart === -1) return stem;
  const rest = stem.slice(groupEnd);
  if (!hasTextOutsideTags(rest)) return stem; // 纯图题/图+选项题保持原序
  // 保持原标签/data-w/类原样整体后移；p 包裹整 p 后移，块级独立性不变
  return stem.slice(0, groupStart) + rest + stem.slice(groupStart, groupEnd);
}

/**
 * 题首孤图后移（0004-fix-1c B组）：题干 HTML 首个非空节点是图块（figure / span.inline-figure /
 * 包裹孤图的 p）且其后存在非空文本 → 图块群整体移到题干内容末尾，文本回到句首。
 * 纯图题（图块后无文本）与首节点为文本/公式者原样返回。
 * 识别 question-content 契约包裹（<div class="question">…<div class="options">…）时只后移题干区、
 * 选项保持居尾——题库存量 content 直通入口（0004-fix-1c C组 BankBrowser 渲染前预处理共用）。
 */
export function relocateLeadingFigures(html: string): string {
  if (!html) return html;
  const wrapped = /^(\s*<div class="question">)([\s\S]*)(<\/div>\s*)$/.exec(html);
  if (wrapped) {
    const inner = wrapped[2];
    const split = /^([\s\S]*?)(<div class="options">[\s\S]*<\/div>\s*)$/.exec(inner);
    const stemPart = split ? split[1] : inner;
    const optionsTail = split ? split[2] : '';
    const relocated = relocateStemRegion(stemPart);
    return relocated === stemPart ? html : wrapped[1] + relocated + optionsTail + wrapped[3];
  }
  return relocateStemRegion(html);
}

/**
 * 归一化采集题目为契约结构
 */
export function normalizeCaptured(q: CapturedQuestion, normalizedImages: NormalizedImages = []): NormalizedCaptureQuestion {
  const imageSizes = buildImageSizeMap(normalizedImages);

  // 清洗所有 HTML 字段
  // 0004-fix-1c B组：题首孤图后移在 wrap（产出图块契约结构）之后执行；题号前缀剥离放最后——
  // 图前置题的题号随文本回到句首后剥离才能命中（<figure/>1．如图 → 1．如图<figure/> → 如图<figure/>）
  // 0056 R-064：四调用点各自带 region——选项区恒行内，题干/答案/解析按「位图且高 >60px 走块级」新判据
  const cleanStem = stripStemLeadingIndex(
    relocateLeadingFigures(wrapImagesAsFigures(cleanCapturedHtml(q.stemHtml), imageSizes, 'stem')),
  );
  // 选项保留公式图（F-5）：清洗 + 图包裹，不再剥成纯文本
  const cleanOptions = q.options.map((opt) =>
    normalizeOptionHtml(wrapImagesAsFigures(cleanCapturedHtml(opt), imageSizes, 'options')),
  );
  const cleanAnswer = wrapImagesAsFigures(cleanCapturedHtml(q.answerHtml), imageSizes, 'answer');
  const cleanAnalysis = wrapImagesAsFigures(cleanCapturedHtml(q.analysisHtml), imageSizes, 'analysis');

  // 构建 question-content 契约结构：<div class="question">题干 + <div class="options">选项</div></div>
  let contentHtml = '<div class="question">';

  // 题干
  contentHtml += cleanStem;

  // 选项（每个选项包裹为 <span class="option">）
  if (cleanOptions.length > 0) {
    contentHtml += '<div class="options">';
    cleanOptions.forEach((opt) => {
      contentHtml += `<span class="option">${opt}</span>`;
    });
    contentHtml += '</div>';
  } else {
    contentHtml += '<div class="options"></div>';
  }

  contentHtml += '</div>';

  return {
    ...q,
    contentHtml,
    answerHtml: cleanAnswer,
    analysisHtml: cleanAnalysis,
    normalizedImages,
  };
}
