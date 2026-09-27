// 0056（R-041）：采集题 AI 整理·合回（纯函数，零 IO）。
// 0065（R-068）：答案/解析字段补**原位替换**（解析区公式小图 → 可编辑公式）。
// 0069（R-075）：整图靶抠出的配图按 `[图N]` **拼回真图**（块级 figure.diagram）+ `images[]` 记 `type='figure'`。
//
// 三条拍板口径（0056 任务书 §零.3/§零.6/§一.1；0065 §一.2 加第四条；0069 §一.1⑤/⑥ 加第五条）：
//   ① 公式位 → `<span class="math" data-tex>` 文字位（与 0040 引擎产出口径同源：markdown.ts mathSpanHtml）；
//   ② 答案图 → answer/analysis 双出、**空侧留空**（不再把「答案+解析」合并串塞进两个字段）；
//   ③ images 列同步维护：已转文字的图条目移除，未转条目（块级配图等）原样保留；
//   ④（0065）answer/analysis 字段**含正文**时不再整体替换——逐图原位替换成公式位，**正文一字不动**；
//   ⑤（0069）引擎双出文字里的 `[图N]` → 抠图产物（真 src + 宽高）；无产物落空 src 占位（不静默吞）。
//
// 失败不静默：单图失败 → 该图原样保留 + 进 failed 记账（题级由编排层判 ok/failed）。

import type { QuestionImage } from '../../shared/contracts/bank-types.js';
import { mathSpanHtml, stemMarkdownToHtml, textMarkdownToHtml, type MarkdownRenderOptions } from '../onestep/markdown.js';
import { imageEntryRef, textOutsideImages, type AiCleanSource, type AiCleanTarget } from './plan.js';

/**
 * 0069（R-075）：整图靶抠出的一张配图——`[图N]`（N = 阅读序编号）→ 真图资产。
 * `src` 与采集链资产同口径（`data-assets/recog/<hash>.png`），宽高来自落资产后的真实 PNG。
 */
export interface AiCleanFigureRef {
  /** `[图N]` 的 N（1 起，阅读序） */
  refIndex: number;
  /** data-assets 相对引用 */
  src: string;
  width?: number;
  height?: number;
}

/** 单图转写结果（公式靶给 text；答案靶给 answer/analysis 双出） */
export interface AiCleanImageOutput {
  target: AiCleanTarget;
  ok: boolean;
  /** kind='formula'：转写文本（LaTeX 或带 $ 定界的 Markdown） */
  text?: string;
  /** kind='answer'：答案/解析文字（null = 该侧空；两侧全空按失败处理） */
  answerText?: string | null;
  analysisText?: string | null;
  /**
   * 0069（R-075）：整图靶抠出的配图（0069 起答案靶带此面；公式靶恒无）。
   * 无抠图结果 = 缺省 → `[图N]` 落空 src 占位（由 markdown 层给占位节点，编排层给可见告警）。
   */
  figures?: AiCleanFigureRef[];
  /** ok=false：失败原因 */
  error?: string;
  /**
   * 0065（R-068）：该图实为**站点权限占位图**（403）——原图保留、**不计失败**、不写字段，
   * 由弹层单列「占位图」分组。前置判据（指纹）与事后兜底（转写文本命中权限文案）都落到这里。
   */
  placeholderReason?: string;
  /** 0056 返工④：质量标记（骨架矛盾/疑幻觉/清洗动作）——原样并入 merged.warnings 供人确认 */
  flags?: string[];
}

export interface AiCleanMerged {
  content: string;
  answer: string;
  analysis: string;
  images: QuestionImage[];
  /** 实际替换掉的图数（公式靶 + 答案靶，按出现次数计） */
  converted: number;
  /** 未替换的失败图（去重后按 src 记） */
  failed: Array<{ src: string; field: AiCleanTarget['field']; reason: string }>;
  /** 0065：403 占位图（去重后按 src 记）——不是失败，弹层单列分组 */
  placeholders: Array<{ src: string; field: AiCleanTarget['field']; reason: string }>;
  /** 人读告警（对照弹层展示；如「答案区原有文字被整体替换」） */
  warnings: string[];
  /** 0056 返工④：需要人工复核的靶（质量闸门起疑，如骨架矛盾）——弹层默认不勾选 */
  needsReview: boolean;
}

/** 行内图 span（同 plan.ts 口径；此处带捕获组以取内部 img） */
const INLINE_FIGURE_SPAN_RE = /<span\b[^>]*\bclass\s*=\s*"[^"]*\binline-figure\b[^"]*"[^>]*>\s*(<img\b[^>]*>)\s*<\/span>/gi;

/**
 * 0065：answer/analysis 字段的原位替换面——**三种包裹形态一视同仁**，捕获组 1/2/3 取内部 img：
 *   ① `<span class="inline-figure"><img></span>`（解析区公式小图，真库最常见）；
 *   ② `<figure class="diagram"><img></figure>`（R-064 判据划到块级的宽公式；真库样题 41e87e40 解析区第 3 张即此形态，
 *      用户目检口径是「那 8 张都变可编辑公式」故必须覆盖；替换整块而不是只抠 img，避免留空 `<figure>` 壳）；
 *   ③ 裸 `<img>`（采集链的防采集图）。
 */
const FIELD_IMAGE_RE = new RegExp(
  '<span\\b[^>]*\\bclass\\s*=\\s*"[^"]*\\binline-figure\\b[^"]*"[^>]*>\\s*(<img\\b[^>]*>)\\s*<\\/span>'
  + '|<figure\\b[^>]*\\bclass\\s*=\\s*"[^"]*\\bdiagram\\b[^"]*"[^>]*>\\s*(<img\\b[^>]*>)\\s*<\\/figure>'
  + '|(<img\\b[^>]*>)',
  'gi',
);

function attrOf(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return match ? (match[1] ?? match[2] ?? '') : null;
}

/**
 * 0056 目检返工②：LaTeX 定界符归一——专用 OCR 模型（DeepSeek-OCR 等）与不少 VLM 产出的公式是
 * `\( … \)` / `\[ … \]` 形态，而本仓契约与 markdown 层只认 `$…$` / `$$…$$`
 * （0042 留档的 DSO 输出原文即 `\( U \)`、`\( R_0 \)`）。不归一会把 `\(` 原样塞进 data-tex，
 * KaTeX 渲染即报错。故在合回前统一换算。
 */
export function normalizeMathDelimiters(markdown: string): string {
  // 匹配文本形态的 `\[ … \]` / `\( … \)`（左括号前的反斜杠在正则里写成 \\\[ / \\\( ）
  return (markdown ?? '')
    .replace(/\\\[([\s\S]*?)\\\]/g, (_match, tex: string) => `$$${tex}$$`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_match, tex: string) => `$${tex}$`);
}

/** 单段落包裹 → 内联内容（`<p><span class="math"…></span></p>` → span）；多段落原样 */
function unwrapSingleParagraph(html: string): string {
  const match = /^<p>([\s\S]*)<\/p>$/.exec(html);
  return match ? match[1] ?? '' : html;
}

/**
 * 转写文本 → 公式位 HTML。
 * 带 `$…$` / `$$…$$` 定界：走既有 markdown→契约 HTML（与录题工作台同源），取其中的公式位；
 * 无定界：整段视为 LaTeX 源（引擎对「单图 = 单公式」的产出形态）。
 */
export function formulaHtmlOf(markdown: string): string {
  const trimmed = normalizeMathDelimiters(markdown).trim();
  if (trimmed === '') return '';
  if (trimmed.includes('$')) return unwrapSingleParagraph(stemMarkdownToHtml(trimmed));
  return mathSpanHtml(trimmed, false);
}

/**
 * 合回：把引擎产出写回契约 HTML ——
 *   · 公式靶（content）：原位替换 `span.inline-figure` 包裹为 `span.math`（其余内容逐字不动）；
 *   · 0065 公式靶（answer/analysis 含正文字段）：同口径原位替换，包裹形态三选一（行内/块级/裸 img）；
 *   · 答案靶（answer/analysis 无正文字段）：字段整体换成 answer/analysis 双出文字（有产出的那侧才写，
 *     两侧全空判失败）；
 *   · images：移除已转文字的图条目（按资产路径归一比较，兼容旧形态）。
 */
export function mergeAiClean(
  source: AiCleanSource & { images?: QuestionImage[] },
  outputs: AiCleanImageOutput[],
): AiCleanMerged {
  const images = source.images ?? [];
  const warnings: string[] = [];
  const bySrc = new Map<string, AiCleanImageOutput>();
  for (const output of outputs) bySrc.set(output.target.assetRelPath, output);

  // ---------- 公式靶：原位替换 ----------
  let converted = 0;
  const convertedRefs = new Set<string>();
  /**
   * 一次原位替换扫描：命中的包裹元素整体换成公式位，失败/无产出/非公式靶 → 原样返回。
   * 只有 `kind='formula'` 的靶参与（答案靶走下面的整字段替换，两者互斥）。
   */
  const replaceInline = (html: string, pattern: RegExp): string =>
    html.replace(pattern, (match: string, ...groups: unknown[]) => {
      const imgTag = (groups[0] ?? groups[1] ?? groups[2]) as string | undefined;
      if (!imgTag) return match;
      const src = attrOf(imgTag, 'src');
      if (!src) return match;
      const rel = src.startsWith('data-assets/') ? src.slice('data-assets/'.length) : src;
      const output = bySrc.get(rel);
      if (!output || !output.ok || output.target.kind !== 'formula') return match;
      const html2 = formulaHtmlOf(output.text ?? '');
      if (html2 === '') return match;
      converted += 1;
      convertedRefs.add(rel);
      return html2;
    });

  // 题面：0056 口径零变化——只换行内包裹（块级 figure.diagram 是真配图，plan 也从不把它做成靶）
  const content = replaceInline(source.content ?? '', INLINE_FIGURE_SPAN_RE);
  // 0065：answer/analysis 的原位替换（三种包裹形态；只动 img 节点，正文由测试与探针双锁「逐字不变」）
  const answerInline = replaceInline(source.answer ?? '', FIELD_IMAGE_RE);
  const analysisInline = replaceInline(source.analysis ?? '', FIELD_IMAGE_RE);

  // ---------- 0069：整图靶抠出的配图（[图N] → 真图资产） ----------
  const figureByRef = new Map<number, AiCleanFigureRef>();
  const figureWarnings: string[] = [];
  for (const output of outputs) {
    for (const figure of output.figures ?? []) {
      const existing = figureByRef.get(figure.refIndex);
      if (existing === undefined) {
        figureByRef.set(figure.refIndex, figure);
        continue;
      }
      // 同编号来自不同整图靶 = 两个字段各自从 1 编号，无法一一对应 → 取先出现的并显式告警（不静默）
      if (existing.src !== figure.src) {
        figureWarnings.push(
          `[图${figure.refIndex}] 来自多个整图靶（题内多张整图各自编号）——已取先出现的那张，请人工核对`,
        );
      }
    }
  }
  const figureOptions: MarkdownRenderOptions = {
    figureSrc: (refIndex) => figureByRef.get(refIndex)?.src,
    figureSize: (refIndex) => {
      const figure = figureByRef.get(refIndex);
      return figure !== undefined && figure.width !== undefined && figure.height !== undefined
        ? { width: figure.width, height: figure.height }
        : undefined;
    },
  };

  // ---------- 答案靶：字段整体替换（同侧多图按靶序拼接，不丢内容） ----------
  const answerParts: string[] = [];
  const analysisParts: string[] = [];
  for (const output of outputs) {
    if (output.target.kind !== 'answer' || !output.ok) continue;
    const answerText = (output.answerText ?? '').trim();
    const analysisText = (output.analysisText ?? '').trim();
    if (answerText === '' && analysisText === '') continue; // 两侧全空：字段不动（由题级 failed 记账）
    if (answerText !== '') answerParts.push(answerText);
    if (analysisText !== '') analysisParts.push(analysisText);
    converted += 1;
    convertedRefs.add(output.target.assetRelPath);
  }
  // 拍板②：引擎 answer/analysis **双出**——有产出的题按引擎结论重写**两个**字段，空侧留空
  // （不再把「答案+解析」合并串同时塞进两字段；两侧全空则整题判失败、字段原样不动）
  const fieldWrites = new Map<'answer' | 'analysis', string>();
  if (answerParts.length > 0 || analysisParts.length > 0) {
    fieldWrites.set('answer', answerParts.length > 0 ? textMarkdownToHtml(normalizeMathDelimiters(answerParts.join('\n\n')), figureOptions) : '');
    fieldWrites.set('analysis', analysisParts.length > 0 ? textMarkdownToHtml(normalizeMathDelimiters(analysisParts.join('\n\n')), figureOptions) : '');
  }

  for (const field of ['answer', 'analysis'] as const) {
    const next = fieldWrites.get(field);
    if (next === undefined) continue;
    const originalText = textOutsideImages(source[field] ?? '');
    if (originalText !== '') {
      warnings.push(`${field === 'answer' ? '答案' : '解析'}区原有文字（${originalText.length} 字）已按整理结果整体替换——请在对照弹层核对`);
    }
  }

  // ---------- 失败记账（按 src 去重；两侧全空的答案靶记失败）+ 0065 占位图单列 ----------
  const failed: Array<{ src: string; field: AiCleanTarget['field']; reason: string }> = [];
  const placeholders: Array<{ src: string; field: AiCleanTarget['field']; reason: string }> = [];
  const seen = new Set<string>();
  const seenPlaceholder = new Set<string>();
  for (const output of outputs) {
    const { target } = output;
    // 0065：占位图不是失败——单列记账（原图保留、字段不动），弹层分组提示去站点开通权限
    if (output.placeholderReason !== undefined) {
      if (seenPlaceholder.has(target.src)) continue;
      seenPlaceholder.add(target.src);
      placeholders.push({ src: target.src, field: target.field, reason: output.placeholderReason });
      continue;
    }
    let reason: string | null = null;
    if (!output.ok) reason = output.error ?? '转写失败';
    else if (target.kind === 'formula' && formulaHtmlOf(output.text ?? '') === '') reason = '引擎返回空转写';
    else if (target.kind === 'answer'
      && (output.answerText ?? '').trim() === ''
      && (output.analysisText ?? '').trim() === '') reason = '引擎未产出答案/解析文字（两侧皆空）';
    if (reason === null) continue;
    if (seen.has(target.src)) continue;
    seen.add(target.src);
    failed.push({ src: target.src, field: target.field, reason });
  }

  // ---------- 返工④：质量标记汇总（骨架矛盾等质量闸门起疑 → 交人工定夺） ----------
  const qualityFlags: string[] = [];
  for (const output of outputs) {
    for (const flag of output.flags ?? []) qualityFlags.push(flag);
  }
  for (const flag of [...qualityFlags, ...figureWarnings]) warnings.push(flag);
  const needsReview = qualityFlags.some((flag) => flag.includes('疑'));

  // ---------- images 列维护 ----------
  const kept = images.filter((entry) => !convertedRefs.has(imageEntryRef(entry)));
  /**
   * 0069：抠图产物作为 `type='figure'` 新条目入 images —— 只记**真被拼进文本**的那些
   * （模型没写该编号 = 产物无人引用，不进列，避免孤儿条目）；已在列里的同资产不再重复追加
   * （内容寻址 + 幂等重跑：同图重裁命中同一文件）。
   */
  const appended: QuestionImage[] = [];
  if (fieldWrites.size > 0) {
    const fieldHtml = `${fieldWrites.get('answer') ?? ''}${fieldWrites.get('analysis') ?? ''}`;
    const existingRefs = new Set(kept.map((entry) => imageEntryRef(entry)));
    for (const refIndex of [...figureByRef.keys()].sort((a, b) => a - b)) {
      const figure = figureByRef.get(refIndex)!;
      if (!fieldHtml.includes(figure.src)) continue;
      if (existingRefs.has(imageEntryRef(figure.src))) continue;
      appended.push({
        assetId: figure.src,
        type: 'figure',
        ...(figure.width !== undefined && figure.height !== undefined
          ? { width: figure.width, height: figure.height }
          : {}),
      });
    }
  }

  return {
    content,
    // 整字段替换（无正文字段）优先；否则用原位替换结果（含正文字段，0065）
    answer: fieldWrites.get('answer') ?? answerInline,
    analysis: fieldWrites.get('analysis') ?? analysisInline,
    images: [...kept, ...appended],
    converted,
    failed,
    placeholders,
    // 0069 目检返工①：同一条告警不重复列（同一资产被引用多次时，输出面会带同一份 flags）
    warnings: [...new Set(warnings)],
    needsReview,
  };
}
