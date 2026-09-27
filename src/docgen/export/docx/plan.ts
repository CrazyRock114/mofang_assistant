// 0035 P1/P3：DOCX 计划层——Question[] + ResolvedLayout → 与库无关的可组装计划（纯函数，无 IO/无 DOM）。
// 与 HTML/PDF 引擎同源：图块化/题级覆盖/题首孤图后移/选项版式/作答区一律复用 docgen/render 的判定函数，
// 保证同一份卷在 PDF 与 Word 两侧的内容序与版式参数一致（Word 层面为重排版式，非所见即所得）。

import type {
  Paper,
  Question,
  PaperLayoutConfig,
  QuestionFigureLayout,
  QuestionAnswerSpaceOverride,
  OptionsLayoutMode,
  PaperTextBlock,
} from '../../../shared/contracts/bank-types.js';
import {
  resolveLayout,
  effectiveContentVisibility,
  answerSpaceLineHeightMm,
  normalizeOptionsLayout,
  pageDimsMm,
  type ResolvedLayout,
  type ResolvedHeaderLine,
} from '../../render/layout.js';
import {
  planQuestionFigures,
  applyFigureOverrides,
  buildRenderSegments,
  buildImageTypeTable,
  normalizeAssetId,
} from '../../render/figureBlocks.js';
import { stripAnswerBlocks } from '../../render/buildPaperHtml.core.js';
import {
  parseContentSubset,
  parseInlineFragment,
  textToInlineItems,
  mergeDegradations,
  type ContentBlock,
  type InlineItem,
  type OptionEntry,
  type TableCellEntry,
  type Degradation,
  type MergedDegradation,
} from './content-subset.js';
import { mapLayout, mmToTwip, type DocxPageSpec } from './layout-map.js';

/** 公式栅格任务条目（key 去重：同式同字号只栅格一次） */
export interface MathItem {
  key: string;
  tex: string;
  display: boolean;
  fontPx: number;
}

/** 图片落位输入（显示宽的解析在组装期——内在尺寸需读盘） */
export interface PlannedFigure {
  src: string;
  alt: string;
  align: 'left' | 'center' | 'right';
  /** 覆盖档（题级 > 全局）；null = 走 min(原宽, 60% 列宽) 默认档 */
  widthPercent: number | null;
  dataWidthPx: number | null;
  dataHeightPx: number | null;
}

export type PlanBlock =
  | { kind: 'paragraph'; items: InlineItem[] }
  | { kind: 'math'; tex: string }
  | { kind: 'figure'; figure: PlannedFigure }
  | { kind: 'options'; options: OptionEntry[]; optionsLayout: OptionsLayoutMode }
  | { kind: 'answer'; items: InlineItem[] }
  // 0050 P4：题内表格（Word 侧出真 w:tbl；行/格 + 表头标记原样带过）
  | { kind: 'table'; rows: TableCellEntry[][] };

export interface PlannedQuestion {
  kind: 'question' | 'text';
  id: string;
  /** 题号（kind='text' 恒 0——文本块不占号） */
  no: number;
  showNo: boolean;
  showScore: boolean;
  score?: number;
  /** 文本块行的观感（section=居中加粗 / note=左对齐） */
  textStyle?: { align: 'left' | 'center' | 'right'; bold: boolean };
  blocks: PlanBlock[];
  /** side-by-side 图块（右栏聚图） */
  sideFigures: PlannedFigure[];
  answerItems?: InlineItem[];
  analysisItems?: InlineItem[];
  answerSpace?: { style: 'blank' | 'lines'; heightTwip: number; lineCount?: number };
}

export interface PlannedLogo {
  src: string;
  align: 'left' | 'center' | 'right';
  widthPx: number;
}

export interface DocxPlan {
  mode: 'student' | 'teacher';
  title: string;
  page: DocxPageSpec;
  headerLines: ResolvedHeaderLine[];
  logos: PlannedLogo[];
  questions: PlannedQuestion[];
  mathItems: MathItem[];
  /** 需读盘的图片 src 全集（figure/行内图/logo；去重保序） */
  imageSrcs: string[];
  /**
   * 0035 修复批（只增）：src → 版式给的显示尺寸（DOM data-w/data-h；未标注则 null）。
   * 供 SVG 栅格器定渲染尺寸（位图不需要——从字节里读内在尺寸）。
   */
  imageHints: Record<string, { widthPx: number | null; heightPx: number | null }>;
  degradations: MergedDegradation[];
}

export interface DocxPlanOptions {
  mode: 'student' | 'teacher';
  scores?: (number | undefined)[];
  layoutConfig?: PaperLayoutConfig;
  questionLayouts?: Record<string, {
    figures?: QuestionFigureLayout[];
    answerSpace?: QuestionAnswerSpaceOverride;
    optionsLayout?: OptionsLayoutMode;
  }>;
  textBlocks?: Record<string, PaperTextBlock>;
}

export function mathKey(tex: string, display: boolean, fontPx: number): string {
  const size = Math.round(fontPx * 100) / 100;
  return `${display ? 'display' : 'inline'}:${size}:${tex}`;
}

/** 图元素 HTML → img src（无 src = 脏数据，调用方显式降级） */
function figureSrcOf(html: string): string {
  const match = /\bsrc=(["'])([^"']+)\1/.exec(html);
  return match ? match[2] : '';
}

function numAttrOf(html: string, name: string): number | null {
  const match = new RegExp(`\\b${name}="(\\d+)"`).exec(html);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function buildDocxPlan(paper: Paper, questions: Question[], options: DocxPlanOptions): DocxPlan {
  // 版式配置优先取调用方传值（UI 已装配态），缺省回落卷自身的 layoutConfig（出卷定稿拷贝）
  const resolved = resolveLayout(options.layoutConfig ?? paper.layoutConfig);
  const page = mapLayout(resolved);
  const degradations: Degradation[] = [];
  const mathKeys = new Set<string>();
  const mathItems: MathItem[] = [];
  const imageSrcs: string[] = [];
  const imageHints: Record<string, { widthPx: number | null; heightPx: number | null }> = {};
  const pushImageSrc = (src: string, widthPx: number | null = null, heightPx: number | null = null): void => {
    if (src === '') return;
    if (!imageSrcs.includes(src)) imageSrcs.push(src);
    // 首个非空标注胜出（同 src 在 figure/行内两处出现时尺寸语义一致）
    const prev = imageHints[src];
    if (prev === undefined || (prev.widthPx === null && widthPx !== null)) {
      imageHints[src] = { widthPx, heightPx };
    }
  };
  const collectMath = (tex: string, display: boolean): void => {
    const key = mathKey(tex, display, page.baseFontPx);
    if (mathKeys.has(key)) return;
    mathKeys.add(key);
    mathItems.push({ key, tex, display, fontPx: page.baseFontPx });
  };

  /**
   * 0035 修复批：行内图项也纳入 src 全集（读盘/栅格用）。
   * 画像语义豁免（formula-image / answer-image / analysis-image）与 .inline-figure 小图都**留行内**，
   * 不经 figure 块路径，若此处不收集就会整幅落 `[图缺失]`（真题：选项内的 SVG 符号图）。
   */
  const collectInlineImages = (items: InlineItem[]): void => {
    for (const item of items) if (item.kind === 'image') pushImageSrc(item.value, item.widthPx ?? null, item.heightPx ?? null);
  };

  const blocksToPlan = (blocks: ContentBlock[], optionsLayout: OptionsLayoutMode): PlanBlock[] => {
    const out: PlanBlock[] = [];
    for (const block of blocks) {
      if (block.kind === 'paragraph') {
        for (const item of block.items) {
          if (item.kind === 'math') collectMath(item.value, item.display === true);
          else if (item.kind === 'image') pushImageSrc(item.value, item.widthPx ?? null, item.heightPx ?? null);
        }
        out.push({ kind: 'paragraph', items: block.items });
        continue;
      }
      if (block.kind === 'math') {
        collectMath(block.tex, true);
        out.push({ kind: 'math', tex: block.tex });
        continue;
      }
      if (block.kind === 'figure') {
        pushImageSrc(block.src, block.widthPx, block.heightPx);
        out.push({
          kind: 'figure',
          figure: {
            src: block.src,
            alt: block.alt,
            align: block.align,
            widthPercent: null,
            dataWidthPx: block.widthPx,
            dataHeightPx: block.heightPx,
          },
        });
        continue;
      }
      if (block.kind === 'options') {
        for (const option of block.options) {
          for (const item of option.items) {
            if (item.kind === 'math') collectMath(item.value, item.display === true);
            else if (item.kind === 'image') pushImageSrc(item.value, item.widthPx ?? null, item.heightPx ?? null);
          }
        }
        out.push({ kind: 'options', options: block.options, optionsLayout });
        continue;
      }
      // 0050 P4：单元格内的行内公式/图同样入栅格与读盘全集（Word 侧格内照常出公式图/图件）
      if (block.kind === 'table') {
        for (const row of block.rows) {
          for (const cell of row) {
            for (const item of cell.items) {
              if (item.kind === 'math') collectMath(item.value, item.display === true);
              else if (item.kind === 'image') pushImageSrc(item.value, item.widthPx ?? null, item.heightPx ?? null);
            }
          }
        }
        out.push({ kind: 'table', rows: block.rows });
        continue;
      }
      for (const item of block.items) {
        if (item.kind === 'math') collectMath(item.value, item.display === true);
        else if (item.kind === 'image') pushImageSrc(item.value, item.widthPx ?? null, item.heightPx ?? null);
      }
      out.push({ kind: 'answer', items: block.items });
    }
    return out;
  };

  let questionIndex = 0;
  const planned: PlannedQuestion[] = [];

  questions.forEach((q) => {
    const textBlock = options.textBlocks?.[q.id];
    if (textBlock) {
      planned.push({
        kind: 'text',
        id: q.id,
        no: 0,
        showNo: false,
        showScore: false,
        textStyle: {
          align: textBlock.align ?? (textBlock.style === 'note' ? 'left' : 'center'),
          bold: (textBlock.style ?? 'section') === 'section',
        },
        blocks: [{ kind: 'paragraph', items: textToInlineItems(textBlock.text) }],
        sideFigures: [],
      });
      return;
    }

    const index = questionIndex;
    questionIndex += 1;
    const score = options.scores?.[index];
    const vis = effectiveContentVisibility(resolved.fieldVisibility, options.mode);

    // 内容管线：答案位关闭一律剥离（与 renderLayoutQuestion 同语义）
    let content = q.content;
    if (!vis.answer) content = stripAnswerBlocks(content);

    const perQuestion = options.questionLayouts?.[q.id];
    const overrideFigures = perQuestion?.figures ?? [];
    const optionsLayout = perQuestion?.optionsLayout !== undefined
      ? normalizeOptionsLayout(perQuestion.optionsLayout)
      : resolved.optionsLayout;

    // 0035 修复批：`.inline-figure` 包裹的采集符号小图**留行内**（不块化）——块化会把选项/句子
    // 切成「文字 / 居中图 / 文字」，并切断选项容器导致相邻选项黏连（真题复现，见 logs/）。
    // opt-in：引擎侧同函数默认行为不变；题级覆盖显式提升的图仍块化（planQuestionFigures 内判）。
    const figurePlan = planQuestionFigures(content, buildImageTypeTable(q.images ?? []), overrideFigures, { skipInlineFigureWrap: true });
    const specs = applyFigureOverrides(figurePlan.figures, resolved.figureLayout, overrideFigures);
    const foreignSet = new Set(figurePlan.foreignAssets);
    for (const spec of specs) {
      const id = normalizeAssetId(spec.figure.assetId);
      if (id !== null && foreignSet.has(id) && spec.widthPercent === null) spec.widthPercent = 60;
    }

    const blocks: PlanBlock[] = [];
    const sideFigures: PlannedFigure[] = [];
    for (const segment of buildRenderSegments(figurePlan.segments, specs, { markers: false })) {
      if (segment.kind === 'text') {
        const parsed = parseContentSubset(segment.html);
        degradations.push(...parsed.degradations);
        blocks.push(...blocksToPlan(parsed.blocks, optionsLayout));
        continue;
      }
      if (segment.kind === 'marker') continue;
      const src = figureSrcOf(segment.spec.figure.html);
      if (src === '') {
        degradations.push({ tag: 'figure', text: '图元素缺 src（已跳过）' });
        continue;
      }
      pushImageSrc(src, numAttrOf(segment.spec.figure.html, 'data-w'), numAttrOf(segment.spec.figure.html, 'data-h'));
      const figure: PlannedFigure = {
        src,
        alt: '',
        align: segment.spec.align,
        widthPercent: segment.spec.widthPercent,
        dataWidthPx: numAttrOf(segment.spec.figure.html, 'data-w'),
        dataHeightPx: numAttrOf(segment.spec.figure.html, 'data-h'),
      };
      if (segment.spec.sideBySide) sideFigures.push(figure);
      else blocks.push({ kind: 'figure', figure });
    }

    const item: PlannedQuestion = {
      kind: 'question',
      id: q.id,
      no: index + 1,
      showNo: vis.questionNo,
      showScore: vis.score && score !== undefined,
      ...(score !== undefined ? { score } : {}),
      blocks,
      sideFigures,
    };

    if (vis.answer && q.answer) {
      const parsed = parseInlineFragment(q.answer);
      degradations.push(...parsed.degradations);
      for (const inline of parsed.items) if (inline.kind === 'math') collectMath(inline.value, false);
      item.answerItems = parsed.items;
    }
    if (vis.analysis && q.analysis) {
      const parsed = parseInlineFragment(q.analysis);
      degradations.push(...parsed.degradations);
      for (const inline of parsed.items) if (inline.kind === 'math') collectMath(inline.value, false);
      item.analysisItems = parsed.items;
    }

    const perSpace = perQuestion?.answerSpace;
    const perLines = perSpace?.lines;
    const spaceEnabled = perSpace
      ? (perLines !== undefined ? perLines > 0 : perSpace.style !== 'none')
      : resolved.answerSpace.enabled;
    if (spaceEnabled) {
      const style = perSpace?.style === 'lines' || perSpace?.style === 'blank' ? perSpace.style : resolved.answerSpace.style;
      const lineMm = answerSpaceLineHeightMm(resolved);
      const heightMm = perLines !== undefined ? perLines * lineMm : perSpace?.heightMm ?? resolved.answerSpace.heightMm;
      item.answerSpace = {
        style,
        heightTwip: mmToTwip(heightMm),
        lineCount: Math.max(1, Math.round(heightMm / lineMm)),
      };
    }

    planned.push(item);
  });

  // 卷头：none 全灭 > 多行自定义 > exam/simple 基线（与 buildHtmlDocument 同语义，含总分/时长行）
  let headerLines: ResolvedHeaderLine[] = resolved.header.lines;
  if (resolved.header.style === 'none') {
    headerLines = [];
  } else if (headerLines.length === 0) {
    const totalScore = (paper.config?.totalScore as number) ?? 0;
    const duration = (paper.config?.duration as number) ?? 0;
    headerLines = [{ text: paper.title, sizePt: 18, align: 'center', bold: true }];
    if (resolved.header.style === 'exam' && (totalScore > 0 || duration > 0)) {
      const meta = [totalScore > 0 ? `总分：${totalScore}分` : '', duration > 0 ? `时长：${duration}分钟` : '']
        .filter((part) => part !== '')
        .join('   ');
      headerLines.push({ text: meta, sizePt: 11, align: 'center', bold: false });
    }
  }

  const dims = pageDimsMm(resolved);
  const pageWidthPx = (dims.w * 96) / 25.4;
  const logos: PlannedLogo[] = resolved.logos.map((logo) => ({
    src: `data-assets/${logo.assetId}`,
    align: logo.xRatio < 0.34 ? 'left' : logo.xRatio > 0.66 ? 'right' : 'center',
    widthPx: Math.max(1, Math.round(logo.widthRatio * pageWidthPx)),
  }));
  for (const logo of logos) pushImageSrc(logo.src);

  return {
    mode: options.mode,
    title: resolved.header.title ?? paper.title,
    page,
    headerLines,
    logos,
    questions: planned,
    mathItems,
    imageSrcs,
    imageHints,
    degradations: mergeDegradations(degradations),
  };
}
