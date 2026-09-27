// 0035 P1/P2：DOCX 组装器——计划 + 已解析资源（公式 PNG / 图片字节）→ .docx Buffer。
// 与库解耦的分工：plan.ts 负责"卷面是什么"，本文件负责"落成 Word 元素"（段落/表格/图片/twip 参数）。
// 公式=图片定案（D-051）：行内公式以 PNG 内嵌，按 KaTeX 深度做基线校正（w:position 下沉，负值）；
// 基线校正经 XmlComponent 包装注入（docx 库未暴露 ImageRun 的 run 属性，属 OOXML 合法用法）。

import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  ImageRun,
  LineRuleType,
  PageNumber,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TableLayoutType,
  TextRun,
  WidthType,
  XmlComponent,
  type IContext,
  type ITableOptions,
  type IXmlableObject,
  type ParagraphChild,
} from 'docx';
import type { DocxPlan, PlannedFigure, PlannedQuestion } from './plan.js';
import { mathKey } from './plan.js';
import { resolveFigureWidthPx } from './layout-map.js';
import type { InlineItem, OptionEntry, TableCellEntry } from './content-subset.js';
import type { DocxImageType } from './image-size.js';

/** 教师版答案/解析红笔（与 HTML 引擎同色） */
const ANSWER_COLOR = 'D32F2F';
/** 缺图/缺公式占位色 */
const PLACEHOLDER_COLOR = '808080';
/** 0050 P4：表格实线边框（4 = 0.5pt，印刷样细线）与表头浅底（近白，打印友好） */
const TABLE_BORDER = { style: BorderStyle.SINGLE, size: 4, color: '000000' } as const;
const TABLE_BORDERS: ITableOptions['borders'] = {
  top: TABLE_BORDER, bottom: TABLE_BORDER, left: TABLE_BORDER, right: TABLE_BORDER,
  insideHorizontal: TABLE_BORDER, insideVertical: TABLE_BORDER,
};
const TABLE_HEADER_FILL = 'F2F2F2';
const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' } as const;
const BORDERLESS: ITableOptions['borders'] = {
  top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER,
  insideHorizontal: NO_BORDER, insideVertical: NO_BORDER,
};

export interface LoadedImage {
  kind: 'image';
  data: Buffer;
  type: DocxImageType;
  width: number;
  height: number;
}

export interface MissingImage {
  kind: 'missing';
  reason: string;
}

export type AssetEntry = LoadedImage | MissingImage;

export interface RasteredMath {
  png: Buffer;
  widthPx: number;
  heightPx: number;
  depthPx: number;
}

export interface DocxAssets {
  /** key = mathKey(tex, display, fontPx) */
  math: Map<string, RasteredMath>;
  /** key = 原始 src（data-assets/… / data: / http(s):） */
  assets: Map<string, AssetEntry>;
}

export interface AssemblyIssue {
  kind: 'math-missing' | 'figure-missing' | 'image-unsupported';
  detail: string;
}

export interface AssembleHooks {
  onIssue?: (issue: AssemblyIssue) => void;
}

/**
 * 下沉图片 run：`<w:r><w:rPr><w:position w:val="-N"/></w:rPr>…drawing…</w:r>`。
 * Word 把行内图底边压在基线上，公式盒自带的下沉部（depth）会被顶到基线上方——
 * 按深度半磅数负向平移（负值=下沉）把公式基线落回文字基线。
 */
class LoweredImageRun extends XmlComponent {
  private readonly image: ImageRun;
  private readonly halfPoints: number;

  constructor(image: ImageRun, halfPoints: number) {
    super('w:r');
    this.image = image;
    this.halfPoints = halfPoints;
  }

  prepForXml(context: IContext): IXmlableObject | undefined {
    const inner = this.image.prepForXml(context);
    const children = inner !== undefined && Array.isArray(inner['w:r']) ? inner['w:r'] : [];
    return {
      'w:r': [
        { 'w:rPr': [{ 'w:position': { _attr: { 'w:val': this.halfPoints } } }] },
        ...children,
      ],
    };
  }
}

function alignmentOf(align: 'left' | 'center' | 'right'): (typeof AlignmentType)[keyof typeof AlignmentType] {
  if (align === 'right') return AlignmentType.RIGHT;
  if (align === 'left') return AlignmentType.LEFT;
  return AlignmentType.CENTER;
}

function placeholderRun(text: string): TextRun {
  return new TextRun({ text, color: PLACEHOLDER_COLOR });
}

/** px → 半磅（1px = 0.75pt = 1.5 半磅） */
function pxToHalfPoints(px: number): number {
  return Math.round(px * 1.5);
}

interface BuildCtx {
  plan: DocxPlan;
  assets: DocxAssets;
  hooks?: AssembleHooks;
  contentWidthPx: number;
}

function mathChild(item: InlineItem, ctx: BuildCtx): ParagraphChild {
  const key = mathKey(item.value, item.display === true, ctx.plan.page.baseFontPx);
  const raster = ctx.assets.math.get(key);
  if (!raster) {
    ctx.hooks?.onIssue?.({ kind: 'math-missing', detail: item.value });
    return placeholderRun(`[公式渲染失败：${item.value}]`);
  }
  const image = new ImageRun({
    type: 'png',
    data: raster.png,
    transformation: { width: raster.widthPx, height: raster.heightPx },
    altText: { name: '公式', description: item.value },
  });
  const halfPoints = pxToHalfPoints(raster.depthPx);
  if (item.display === true || halfPoints <= 0) return image;
  return new LoweredImageRun(image, -halfPoints);
}

function assetChild(
  entry: AssetEntry | undefined,
  src: string,
  widthPx: number,
  alt: string,
  ctx: BuildCtx
): ParagraphChild {
  if (!entry || entry.kind === 'missing') {
    ctx.hooks?.onIssue?.({ kind: entry ? 'figure-missing' : 'image-unsupported', detail: src });
    return placeholderRun(`[图缺失：${src}]`);
  }
  const height = Math.max(1, Math.round((widthPx * entry.height) / entry.width));
  return new ImageRun({
    type: entry.type,
    data: entry.data,
    transformation: { width: Math.max(1, Math.round(widthPx)), height },
    altText: { name: alt === '' ? '题图' : alt, description: alt === '' ? src : alt },
  });
}

function inlineImageChild(item: InlineItem, ctx: BuildCtx): ParagraphChild {
  const widthPx = resolveFigureWidthPx({
    widthPercent: null,
    dataWidthPx: item.widthPx ?? null,
    intrinsicWidthPx: null,
    contentWidthPx: ctx.contentWidthPx,
  });
  return assetChild(ctx.assets.assets.get(item.value), item.value, widthPx, item.alt ?? '', ctx);
}

function itemChild(item: InlineItem, ctx: BuildCtx, color?: string): ParagraphChild {
  if (item.kind === 'break') return new TextRun({ break: 1 });
  if (item.kind === 'math') return mathChild(item, ctx);
  if (item.kind === 'image') return inlineImageChild(item, ctx);
  return new TextRun({
    text: item.value,
    ...(item.format.bold === true ? { bold: true } : {}),
    ...(item.format.italic === true ? { italics: true } : {}),
    ...(item.format.vertical === 'sub' ? { subScript: true } : {}),
    ...(item.format.vertical === 'sup' ? { superScript: true } : {}),
    ...(color !== undefined ? { color } : {}),
  });
}

function itemsToChildren(items: InlineItem[], ctx: BuildCtx, color?: string): ParagraphChild[] {
  return items.map((item) => itemChild(item, ctx, color));
}

/**
 * 行内项 → 段落序列：display 公式（独立居中段）就地拆段（与 HTML 引擎的块级语义一致）。
 */
function itemsToParagraphs(
  items: InlineItem[],
  ctx: BuildCtx,
  options?: { alignment?: 'left' | 'center' | 'right'; color?: string; runsPrefix?: TextRun[]; spacingAfterTwip?: number }
): Paragraph[] {
  const out: Paragraph[] = [];
  let acc: ParagraphChild[] = options?.runsPrefix !== undefined ? [...options.runsPrefix] : [];
  const shared = {
    ...(options?.alignment !== undefined ? { alignment: alignmentOf(options.alignment) } : {}),
    ...(options?.spacingAfterTwip !== undefined ? { spacing: { after: options.spacingAfterTwip } } : {}),
  };
  const flush = (): void => {
    if (acc.length === 0) return;
    out.push(new Paragraph({ ...shared, children: acc }));
    acc = [];
  };
  for (const item of items) {
    if (item.kind === 'math' && item.display === true) {
      flush();
      out.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 60, after: 60 },
        children: [mathChild(item, ctx)],
      }));
      continue;
    }
    acc.push(itemChild(item, ctx, options?.color));
  }
  flush();
  return out;
}

function figureWidthPx(figure: PlannedFigure, ctx: BuildCtx): number {
  const entry = ctx.assets.assets.get(figure.src);
  const intrinsicWidthPx = entry && entry.kind === 'image' ? entry.width : null;
  return resolveFigureWidthPx({
    widthPercent: figure.widthPercent,
    dataWidthPx: figure.dataWidthPx,
    intrinsicWidthPx,
    contentWidthPx: ctx.contentWidthPx,
  });
}

function figureParagraph(figure: PlannedFigure, ctx: BuildCtx): Paragraph {
  const child = assetChild(ctx.assets.assets.get(figure.src), figure.src, figureWidthPx(figure, ctx), figure.alt, ctx);
  return new Paragraph({ alignment: alignmentOf(figure.align), spacing: { before: 60, after: 60 }, children: [child] });
}

function optionParagraph(option: OptionEntry, ctx: BuildCtx): Paragraph {
  return new Paragraph({
    indent: { left: 360 },
    spacing: { line: ctx.plan.page.bodyLineTwip, lineRule: LineRuleType.AUTO },
    children: itemsToChildren(option.items, ctx),
  });
}

/** 选项表格（单行 1×N / 两行 2×⌈N/2⌉；无边框 + 定宽均分） */
function optionsTable(options: OptionEntry[], mode: 'single-line' | 'two-lines', ctx: BuildCtx): Table {
  const cellOf = (option: OptionEntry | undefined, widthPct: number): TableCell => new TableCell({
    width: { size: widthPct, type: WidthType.PERCENTAGE },
    children: option === undefined
      ? [new Paragraph({ children: [] })]
      : [new Paragraph({ spacing: { line: ctx.plan.page.bodyLineTwip, lineRule: LineRuleType.AUTO }, children: itemsToChildren(option.items, ctx) })],
  });
  const perRow = mode === 'single-line' ? options.length : 2;
  const rows: TableRow[] = [];
  for (let i = 0; i < options.length; i += perRow) {
    const slice = options.slice(i, i + perRow);
    const widthPct = Math.floor(100 / perRow);
    const cells = slice.map((option) => cellOf(option, widthPct));
    while (cells.length < perRow) cells.push(cellOf(undefined, widthPct));
    rows.push(new TableRow({ children: cells }));
  }
  return new Table({
    rows,
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    borders: BORDERLESS,
  });
}

/**
 * 0050 P4：题内表格 → 真 `w:tbl`（表头行加粗 + 浅底、实线边框、列宽均分起步）。
 * 单元格内行内件（公式图片 / 行内图 / 上下标）复用既有 child 管线；格内不排块级语义
 * （内容子集已把格内解析限为行内项）。图片可用宽按列数摊分——否则行内图按整幅版心出图会撑破格。
 */
function contentTable(rows: TableCellEntry[][], ctx: BuildCtx): Table {
  const columns = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const columnCount = Math.max(1, columns);
  const widthPct = Math.floor(100 / columnCount);
  const cellCtx: BuildCtx = { ...ctx, contentWidthPx: Math.max(1, Math.floor(ctx.contentWidthPx / columnCount)) };
  const cellOf = (cell: TableCellEntry): TableCell => {
    const items = cell.header
      ? cell.items.map((item) => ({ ...item, format: { ...item.format, bold: true } }))
      : cell.items;
    const paragraphs = itemsToParagraphs(items, cellCtx);
    return new TableCell({
      width: { size: widthPct, type: WidthType.PERCENTAGE },
      ...(cell.colspan > 1 ? { columnSpan: cell.colspan } : {}),
      ...(cell.rowspan > 1 ? { rowSpan: cell.rowspan } : {}),
      ...(cell.header ? { shading: { fill: TABLE_HEADER_FILL } } : {}),
      children: paragraphs.length > 0 ? paragraphs : [new Paragraph({ children: [] })],
    });
  };
  return new Table({
    rows: rows.map((cells) => new TableRow({ children: cells.map(cellOf) })),
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    borders: TABLE_BORDERS,
  });
}

function answerSpaceParagraphs(question: PlannedQuestion, ctx: BuildCtx): Paragraph[] {
  const space = question.answerSpace;
  if (!space) return [];
  if (space.style === 'blank') {
    return [new Paragraph({ spacing: { line: space.heightTwip, lineRule: LineRuleType.EXACTLY }, children: [] })];
  }
  const border = { bottom: { style: BorderStyle.SINGLE, size: 4, color: '999999' } } as const;
  // 行数缺省按高度/行高反算（计划层一般给全；手写计划/探针容错）
  const count = space.lineCount ?? Math.max(1, Math.round(space.heightTwip / ctx.plan.page.answerLineTwip));
  const lines: Paragraph[] = [];
  for (let i = 0; i < count; i += 1) {
    lines.push(new Paragraph({
      border,
      spacing: { line: ctx.plan.page.answerLineTwip, lineRule: LineRuleType.EXACTLY },
      children: [],
    }));
  }
  return lines;
}

function questionHeaderRuns(question: PlannedQuestion): TextRun[] {
  const runs: TextRun[] = [];
  if (question.showNo) runs.push(new TextRun({ text: `${question.no}.`, bold: true }));
  if (question.showScore && question.score !== undefined) runs.push(new TextRun({ text: ` (${question.score}分)` }));
  return runs;
}

function contentChildren(question: PlannedQuestion, ctx: BuildCtx, headerRuns: TextRun[]): (Paragraph | Table)[] {
  const children: (Paragraph | Table)[] = [];
  let headerPending = headerRuns;
  for (const block of question.blocks) {
    if (block.kind === 'paragraph') {
      children.push(...itemsToParagraphs(block.items, ctx, { runsPrefix: headerPending }));
      headerPending = [];
      continue;
    }
    if (block.kind === 'math') {
      children.push(...itemsToParagraphs([{ kind: 'math', value: block.tex, format: {}, display: true }], ctx, { runsPrefix: headerPending }));
      headerPending = [];
      continue;
    }
    if (block.kind === 'figure') {
      if (headerPending.length > 0) {
        children.push(new Paragraph({ children: headerPending }));
        headerPending = [];
      }
      children.push(figureParagraph(block.figure, ctx));
      continue;
    }
    if (block.kind === 'options') {
      if (headerPending.length > 0) {
        children.push(new Paragraph({ children: headerPending }));
        headerPending = [];
      }
      if (block.optionsLayout === 'single-line' || block.optionsLayout === 'two-lines') {
        children.push(optionsTable(block.options, block.optionsLayout, ctx));
        children.push(new Paragraph({ children: [] }));
      } else {
        children.push(...block.options.map((option) => optionParagraph(option, ctx)));
      }
      continue;
    }
    // 0050 P4：题内表格 → 真 w:tbl（题号/分值先在表前落段；表后空段收尾防与后续内容黏连）
    if (block.kind === 'table') {
      if (headerPending.length > 0) {
        children.push(new Paragraph({ children: headerPending }));
        headerPending = [];
      }
      children.push(contentTable(block.rows, ctx));
      children.push(new Paragraph({ children: [] }));
      continue;
    }
    // answer 块（题干内嵌答案）
    children.push(...itemsToParagraphs(block.items, ctx, {
      runsPrefix: headerPending,
      color: ctx.plan.mode === 'teacher' ? ANSWER_COLOR : undefined,
    }));
    headerPending = [];
  }
  if (headerPending.length > 0) children.unshift(new Paragraph({ children: headerPending }));
  return children;
}

function sideBySideTable(question: PlannedQuestion, ctx: BuildCtx, left: (Paragraph | Table)[]): Table {
  const leftCell = new TableCell({
    width: { size: 60, type: WidthType.PERCENTAGE },
    children: left.length > 0 ? left : [new Paragraph({ children: [] })],
  });
  const rightCell = new TableCell({
    width: { size: 40, type: WidthType.PERCENTAGE },
    children: question.sideFigures.map((figure) => figureParagraph(figure, ctx)),
  });
  return new Table({
    rows: [new TableRow({ children: [leftCell, rightCell] })],
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    borders: BORDERLESS,
  });
}

function questionChildren(question: PlannedQuestion, ctx: BuildCtx): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [];
  if (question.kind === 'text') {
    const style = question.textStyle ?? { align: 'center' as const, bold: true };
    for (const block of question.blocks) {
      if (block.kind !== 'paragraph') continue;
      const items = style.bold
        ? block.items.map((item) => ({ ...item, format: { ...item.format, bold: true } }))
        : block.items;
      out.push(...itemsToParagraphs(items, ctx, { alignment: style.align }));
    }
    return out;
  }

  const headerRuns = questionHeaderRuns(question);
  const content = contentChildren(question, ctx, headerRuns);
  if (question.sideFigures.length > 0) {
    out.push(sideBySideTable(question, ctx, content));
    out.push(new Paragraph({ children: [] }));
  } else {
    out.push(...content);
  }

  const answerColor = ctx.plan.mode === 'teacher' ? ANSWER_COLOR : undefined;
  if (question.answerItems !== undefined && question.answerItems.length > 0) {
    out.push(...itemsToParagraphs(
      [{ kind: 'text', value: '答案：', format: { bold: true } }, ...question.answerItems],
      ctx,
      { color: answerColor }
    ));
  }
  if (question.analysisItems !== undefined && question.analysisItems.length > 0) {
    out.push(...itemsToParagraphs(
      [{ kind: 'text', value: '解析：', format: { bold: true } }, ...question.analysisItems],
      ctx,
      { color: answerColor }
    ));
  }

  out.push(...answerSpaceParagraphs(question, ctx));
  return out;
}

function footerParagraph(): Paragraph {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [
      new TextRun({ text: '第 ' }),
      new TextRun({ children: [PageNumber.CURRENT] }),
      new TextRun({ text: ' 页 / 共 ' }),
      new TextRun({ children: [PageNumber.TOTAL_PAGES] }),
      new TextRun({ text: ' 页' }),
    ],
  });
}

/**
 * 计划 + 资源 → docx Buffer。
 * 缺资源一律显式占位 + 上报（不静默丢内容）；产物可被 Word/WPS 直接打开。
 */
export async function assembleDocx(plan: DocxPlan, assets: DocxAssets, hooks?: AssembleHooks): Promise<Buffer> {
  const ctx: BuildCtx = { plan, assets, hooks, contentWidthPx: plan.page.columnWidthPx };
  const children: (Paragraph | Table)[] = [];

  for (const line of plan.headerLines) {
    children.push(new Paragraph({
      alignment: alignmentOf(line.align),
      spacing: { after: 120 },
      children: [new TextRun({ text: line.text, bold: line.bold, size: Math.round(line.sizePt * 2) })],
    }));
  }

  for (const question of plan.questions) {
    children.push(...questionChildren(question, ctx));
  }
  if (children.length === 0) children.push(new Paragraph({ children: [] }));
  const last = children[children.length - 1];
  if (last instanceof Table) children.push(new Paragraph({ children: [] }));

  const logoChildren: ParagraphChild[] = plan.logos.map((logo) => assetChild(
    assets.assets.get(logo.src),
    logo.src,
    logo.widthPx,
    '校徽/Logo',
    ctx
  ));
  const hasLogos = plan.logos.length > 0;

  const doc = new Document({
    title: plan.title,
    creator: '魔方助教',
    styles: {
      default: {
        document: {
          run: {
            font: { ascii: plan.page.fontFamily, eastAsia: plan.page.fontFamily, hAnsi: plan.page.fontFamily },
            size: plan.page.baseFontHalfPoints,
          },
          paragraph: { spacing: { line: plan.page.bodyLineTwip, lineRule: LineRuleType.AUTO } },
        },
      },
    },
    sections: [{
      properties: {
        page: {
          size: { width: plan.page.widthTwip, height: plan.page.heightTwip },
          margin: {
            top: plan.page.marginTwip.top,
            right: plan.page.marginTwip.right,
            bottom: plan.page.marginTwip.bottom,
            left: plan.page.marginTwip.left,
          },
        },
        ...(plan.page.columns === 2 ? { column: { count: 2, space: plan.page.columnGapTwip, equalWidth: true } } : {}),
        ...(hasLogos ? { titlePage: true } : {}),
      },
      ...(hasLogos ? { headers: { first: new Header({ children: [new Paragraph({ alignment: alignmentOf(plan.logos[0].align), children: logoChildren })] }) } } : {}),
      footers: { default: new Footer({ children: [footerParagraph()] }) },
      children,
    }],
  });

  return Packer.toBuffer(doc);
}
