// 0004 Phase 4（乙路）：PaperLayoutConfig v2 → 归一化版式（纯函数，无 IO/无库读取）。
// 渲染层只消费 ResolvedLayout；resolveLayout(undefined) = 全默认（基线），渲染入口据此走基线/配置双路径。

import type { PaperLayoutConfig, PaperHeaderLine, OptionsLayoutMode } from '../../shared/contracts/bank-types.js';

/** 0009：卷头自定义行（归一化后全字段有值——渲染与 UI 只消费本类型，缺省不猜） */
export interface ResolvedHeaderLine {
  text: string;
  sizePt: number;
  align: 'left' | 'center' | 'right';
  bold: boolean;
}

/** 0009：卷头行字号界（pt；越界收拢到边界） */
export const HEADER_LINE_SIZE_MIN = 6;
export const HEADER_LINE_SIZE_MAX = 72;
/** 缺省字号：首行 18pt（对齐 .paper-title 旧观感）/ 其余 11pt（对齐 .paper-meta 旧观感） */
const HEADER_LINE_SIZE_FIRST = 18;
const HEADER_LINE_SIZE_REST = 11;

/** 归一化版式（全部字段有值；数值单位 pt/mm） */
export interface ResolvedLayout {
  pageSize: 'A4' | 'A3';
  /** 0004-fix-2 F2-A：横竖版（缺省 portrait；landscape=物理宽高互换） */
  orientation: 'portrait' | 'landscape';
  columns: 1 | 2;
  columnGapMm: number;
  /** 正文字号 pt（基线 12） */
  fontSize: number;
  fontFamily: string;
  /** null = 未配置，保持基线双值（正文 1.8 / 题面 2） */
  lineHeight: number | null;
  pageMarginMm: { top: number; right: number; bottom: number; left: number };
  /**
   * title=null → 用卷标题。
   * 0009：lines 非空 → 多行自定义模式（title 不参与渲染）；lines 全空 → 旧三态逐点零回归。
   */
  header: { style: 'none' | 'simple' | 'exam'; title: string | null; lines: ResolvedHeaderLine[] };
  /** undefined = 未配置（answer/analysis 按 mode 基线；questionNo/score 缺省显示） */
  fieldVisibility: { questionNo?: boolean; score?: boolean; answer?: boolean; analysis?: boolean };
  answerSpace: { enabled: boolean; style: 'blank' | 'lines'; heightMm: number };
  /** widthPercent=null = 未配置（图块宽走默认观感档 min(原宽,60%)；0004 Phase 5 全局档） */
  figureLayout: { mode: 'inline' | 'side-by-side'; align: 'left' | 'center' | 'right'; widthPercent: number | null };
  logos: Array<{ assetId: string; xRatio: number; yRatio: number; widthRatio: number }>;
  /** 0013：选择题选项版式卷级默认档（缺省 auto=竖排；题级 layout_json.optionsLayout 覆盖优先） */
  optionsLayout: OptionsLayoutMode;
}

/**
 * 0013：选项版式归一化单源（渲染/UI/协议共用；非法值/缺省回 auto）。
 * 题级显式 'auto' = 有意覆盖卷级档回自动，由调用方以「键存在」语义区分（undefined 不归一）。
 */
export function normalizeOptionsLayout(value: string | undefined | null): OptionsLayoutMode {
  return value === 'single-line' || value === 'two-lines' || value === 'auto' ? value : 'auto';
}

/** 纸张物理尺寸 mm（竖向基准；landscape 时经 pageDimsMm 宽高互换） */
export const PAGE_SIZE_MM: Record<'A4' | 'A3', { w: number; h: number }> = {
  A4: { w: 210, h: 297 },
  A3: { w: 297, h: 420 },
};

/** 取向换算后的页面物理尺寸 mm（0004-fix-2 F2-A：landscape 宽高互换） */
export function pageDimsMm(layout: Pick<ResolvedLayout, 'pageSize' | 'orientation'>): { w: number; h: number } {
  const base = PAGE_SIZE_MM[layout.pageSize];
  return layout.orientation === 'landscape' ? { w: base.h, h: base.w } : base;
}

const DEFAULTS: Omit<ResolvedLayout, 'lineHeight'> & { lineHeight: number | null } = {
  pageSize: 'A4',
  orientation: 'portrait',
  columns: 1,
  columnGapMm: 8,
  fontSize: 12,
  fontFamily: "'SimSun', 'STSong', serif",
  lineHeight: null,
  pageMarginMm: { top: 20, right: 15, bottom: 20, left: 15 },
  header: { style: 'exam', title: null, lines: [] },
  fieldVisibility: {},
  answerSpace: { enabled: false, style: 'blank', heightMm: 20 },
  figureLayout: { mode: 'inline', align: 'center', widthPercent: null },
  logos: [],
  optionsLayout: 'auto',
};

/**
 * 0009：单行缺省落定（归一化单行真源——渲染层不猜；UI 编辑态经同源取显示缺省）。
 * 字号：非数 → 缺省（首行 18 / 其余 11）；越界 → 收拢到 6–72。
 * 对齐：非枚举 → center；加粗：非布尔 → 仅首行 true。
 */
export function resolveHeaderLine(line: PaperHeaderLine, index: number): ResolvedHeaderLine {
  const fallbackSize = index === 0 ? HEADER_LINE_SIZE_FIRST : HEADER_LINE_SIZE_REST;
  const size = typeof line.sizePt === 'number' && Number.isFinite(line.sizePt) ? line.sizePt : fallbackSize;
  const align = line.align === 'left' || line.align === 'center' || line.align === 'right' ? line.align : 'center';
  const bold = typeof line.bold === 'boolean' ? line.bold : index === 0;
  return {
    text: line.text,
    sizePt: Math.min(HEADER_LINE_SIZE_MAX, Math.max(HEADER_LINE_SIZE_MIN, size)),
    align,
    bold,
  };
}

/**
 * 0009：卷头行序列归一化——先剔纯空行（trim 后为空），再逐行落定缺省（首行序 = 渲染首行）。
 * 返回值非空 = 多行自定义模式（渲染与模式判定共用同一份结果）。
 */
export function resolveHeaderLines(lines?: PaperHeaderLine[]): ResolvedHeaderLine[] {
  if (!Array.isArray(lines)) return [];
  return lines
    .filter((line) => line && typeof line.text === 'string' && line.text.trim() !== '')
    .map((line, index) => resolveHeaderLine(line, index));
}

/**
 * 归一化：v1 / v2 / 缺省 config → ResolvedLayout。
 * v1 config（version:1）无 v2 字段 → 新字段全默认（v1 值语义不变）。
 */
export function resolveLayout(config?: PaperLayoutConfig): ResolvedLayout {
  if (!config) return { ...DEFAULTS, pageMarginMm: { ...DEFAULTS.pageMarginMm }, header: { ...DEFAULTS.header, lines: [] } };
  return {
    pageSize: config.pageSize ?? DEFAULTS.pageSize,
    orientation: config.orientation ?? DEFAULTS.orientation,
    columns: config.columns ?? DEFAULTS.columns,
    columnGapMm: config.columnGapMm ?? DEFAULTS.columnGapMm,
    fontSize: config.fontSize ?? DEFAULTS.fontSize,
    fontFamily: config.fontFamily ?? DEFAULTS.fontFamily,
    lineHeight: config.lineHeight ?? null,
    pageMarginMm: config.pageMarginMm ?? { ...DEFAULTS.pageMarginMm },
    header: {
      style: config.header?.style ?? DEFAULTS.header.style,
      title: config.header?.title ?? null,
      lines: resolveHeaderLines(config.header?.lines),
    },
    fieldVisibility: config.fieldVisibility ?? DEFAULTS.fieldVisibility,
    answerSpace: {
      enabled: config.answerSpace?.enabled ?? DEFAULTS.answerSpace.enabled,
      style: config.answerSpace?.style ?? DEFAULTS.answerSpace.style,
      heightMm: config.answerSpace?.heightMm ?? DEFAULTS.answerSpace.heightMm,
    },
    figureLayout: {
      mode: config.figureLayout?.mode ?? DEFAULTS.figureLayout.mode,
      align: config.figureLayout?.align ?? DEFAULTS.figureLayout.align,
      // 全局图宽档（Phase 5）：仅接受 (0,100] 数值，非法/缺省 = null（默认观感档）
      widthPercent: typeof config.figureLayout?.widthPercent === 'number'
        && config.figureLayout.widthPercent > 0 && config.figureLayout.widthPercent <= 100
        ? config.figureLayout.widthPercent
        : null,
    },
    logos: config.logos ?? [],
    // 0013：选项版式归一（非法值/缺省回 auto，单源 normalizeOptionsLayout）
    optionsLayout: normalizeOptionsLayout(config.optionsLayout),
  };
}

/**
 * §二-3 mode × fieldVisibility 语义：
 * answer/analysis = mode 基线（student 隐 / teacher 显）+ fieldVisibility 显式覆盖位；
 * questionNo/score 两 mode 通用显隐（缺省显示，显式 false 隐藏）。
 */
export function effectiveContentVisibility(
  fv: ResolvedLayout['fieldVisibility'],
  mode: 'student' | 'teacher'
): { questionNo: boolean; score: boolean; answer: boolean; analysis: boolean } {
  return {
    questionNo: fv.questionNo !== false,
    score: fv.score !== false,
    answer: mode === 'teacher' ? fv.answer !== false : fv.answer === true,
    analysis: mode === 'teacher' ? fv.analysis !== false : fv.analysis === true,
  };
}

/** 数值 → mm 字符串（去尾零：20 → '20mm'，14.85 → '14.85mm'） */
export function mm(value: number): string {
  return `${Number(value.toFixed(2))}mm`;
}

/** pt → mm（1pt = 25.4/72 mm） */
export const PT_TO_MM = 25.4 / 72;

/**
 * 0004-fix-4 #6：作答区行高（mm）——config 字号 × 行距（缺省 1.8，与 paper.css 基线同值）× pt→mm。
 * 题级 lines 换算用（高度 = lines × 本值）；卷级 heightMm 语义不变。
 */
export function answerSpaceLineHeightMm(layout: ResolvedLayout): number {
  const lineHeight = layout.lineHeight ?? 1.8;
  return Number((layout.fontSize * lineHeight * PT_TO_MM).toFixed(2));
}

/**
 * config 驱动的增量 CSS（注入在 paper.css 之后，同特异性后者胜）。
 * 仅值驱动项（@page/变量/版心宽/分栏/Logo 锚点）；结构类规则（figure-block 等）在 paper.css 基础层。
 * 0007 P3：Logo 打印 fixed 方案退役——页化运行时逐页克隆进 sheet（坐标基准统一=纸面），
 *   引擎只保留屏显/打印同一 absolute 锚点。
 * 0007 P4：双列 column-count 收敛 @media screen（连续视图）；打印分栏由页化手工列盒承担。
 * fix-3 P1-1：屏显页边距模拟（.paper padding=config 页边距，@media print 归零防打印双倍边距；
 * border-box 使 max-width 含 padding，屏显纸宽=物理纸宽、内容宽=纸宽−边距）。
 * fix-3 P1-2：extra.perQuestionAnswerSpace=任一题题级作答区覆盖（卷级关闭仍注入作答区规则）。
 */
export function buildLayoutCss(
  layout: ResolvedLayout,
  extra?: { perQuestionAnswerSpace?: boolean }
): string {
  const m = layout.pageMarginMm;
  // 0004-fix-2 F2-A：landscape 时 @page size 后缀 landscape（printToPDF 同参出纸）
  const sizeValue = `${layout.pageSize}${layout.orientation === 'landscape' ? ' landscape' : ''}`;
  const parts: string[] = [
    `@page { size: ${sizeValue}; margin: ${mm(m.top)} ${mm(m.right)} ${mm(m.bottom)} ${mm(m.left)}; }`,
  ];

  const vars: string[] = [
    `--mf-font-size: ${layout.fontSize}pt`,
    `--mf-font-family: ${layout.fontFamily}`,
  ];
  if (layout.lineHeight !== null) {
    vars.push(`--mf-line-height: ${layout.lineHeight}`, `--mf-question-line-height: ${layout.lineHeight}`);
  }
  parts.push(`:root { ${vars.join('; ')}; }`);

  // 版心宽基准 = 取向换算后页宽（landscape 用横幅宽）
  parts.push(`.paper { max-width: ${pageDimsMm(layout).w}mm; }`);

  // 屏显页边距模拟（fix-3 P1-1）：屏显 .paper 带 config 页边距 padding（border-box：
  // max-width 含 padding，屏显纸宽=物理纸宽）；打印归零（@page margin 已承担页边距，防双倍）。
  // 仅 config 路径注入（基线产物零污染）。
  parts.push(
    `@media screen { .paper { box-sizing: border-box; padding: ${mm(m.top)} ${mm(m.right)} ${mm(m.bottom)} ${mm(m.left)}; } }`,
    '@media print { .paper { padding: 0; } }'
  );

  if (layout.columns === 2) {
    // 0007 P4：column-count 收敛屏显（连续视图仍用浏览器分列）；打印/导出一律走页化
    // 手工列盒（preview-frame-runtime planColumns 逐列装箱）——Chromium column+打印断列路径退役
    parts.push(`@media screen { .paper-questions { column-count: 2; column-gap: ${mm(layout.columnGapMm)}; } }`);
  }

  // 图排版块化结构类（U4 v1，仅 config 路径注入；基线产物不含这些元素也不含这些规则）。
  // fix-2 F2-C：inline 图块按段序原位输出（随文流），不再有 .figure-flow 尾聚容器；
  // fix-2 F2-B：选项块级保底规则（内容根缺 .question 包裹时 paper.css 严格子代选择器不命中 → 粘连）
  parts.push(
    [
      '.question-row { display: flex; gap: 4mm; align-items: flex-start; }',
      '.question-row > .question-content { flex: 1 1 auto; min-width: 0; }',
      '.question-side { flex: 0 0 auto; max-width: 45%; }',
      '.question-content .options > .option { display: block; margin: 0.3em 0; padding-left: 1em; }',
      '.figure-block { width: 100%; break-inside: avoid; }',
      '.figure-block--left { text-align: left; }',
      '.figure-block--center { text-align: center; }',
      '.figure-block--right { text-align: right; }',
      '.figure-block > figure { margin: 0.5em 0; }',
      '.figure-block--left > figure { margin-right: auto; }',
      '.figure-block--center > figure { margin-left: auto; margin-right: auto; }',
      '.figure-block--right > figure { margin-left: auto; }',
      // 已知尺寸图：封顶在 figure 内联样式（processFigures，60% 默认观感档），img 放开填满 figure
      '.figure-block > figure > img { max-width: 100%; height: auto; }',
      // 裸 img 图块（行内起源、figure 语义）：内联样式仅 width，封顶在 CSS（60% 默认档，多列下相对列盒）
      '.figure-block > img { max-width: 60%; height: auto; }',
      // 未知尺寸图（无 style 属性）：无原像素宽可依，按 60% 默认观感档封顶
      '.figure-block > figure:not([style]) { max-width: 60%; }',
      // 0004-fix-5 P0-2：段边界标记（交互预览落点锚）。零尺寸绝对定位（静态位置=段边界处）：
      // 不生成行盒、不占流内空间 → 布局零影响；pointer-events:none 不挡点击。
      '.mf-seg { position: absolute; width: 1px; height: 0; overflow: hidden; pointer-events: none; }',
    ].join('\n')
  );

  // 0013：选项版式三态结构规则（与 paper.css 基础层同文同步；auto 缺省不加类 → 规则惰性零回归）。
  // 选项级规则用 4 类特异性（.question-item.ol-*）压过 paper.css 基线悬挂缩进 1em
  // （.question-content > .question > .options > .option 同特异性，注入序在后即胜）。
  parts.push(
    [
      '.options { break-inside: avoid; }',
      '.ol-single .options { display: flex; gap: 1.2em; }',
      '.ol-single .options > .option { display: block; flex: 1 1 0; padding-left: 0; }',
      '.ol-two .options { display: grid; grid-template-columns: 1fr 1fr; column-gap: 1.2em; }',
      '.ol-two .options > .option { display: block; padding-left: 0; }',
      '.question-item.ol-single .options > .option { padding-left: 0; }',
      '.question-item.ol-two .options > .option { padding-left: 0; }',
    ].join('\n')
  );

  // 作答区（fix-3 P1-2）：卷级启用或任一题题级覆盖时注入结构规则；
  // lines 背景规则随作答区规则同注入（题级 lines 覆盖时卷级可为 blank，规则惰性不误伤）
  if (layout.answerSpace.enabled || extra?.perQuestionAnswerSpace) {
    parts.push('.answer-space { break-inside: avoid; }');
    parts.push(
      '.answer-space--lines { background-image: repeating-linear-gradient(to bottom, transparent, transparent calc(1em - 1px), #999 calc(1em - 1px), #999 1em); }'
    );
  }

  if (layout.logos.length > 0) {
    parts.push('.paper { position: relative; }');
    parts.push('.paper-logo { position: absolute; }');
    // 0007 P3：@media print position:fixed 方案退役——页化运行时把 Logo 克隆进每页 sheet
    // （坐标基准统一=纸面，屏显=打印同一绝对定位；fixed 会使逐页克隆叠影），
    // 屏显/打印两态落点差消除（fix-3 已知限制①清偿）。
  }

  return parts.join('\n');
}
