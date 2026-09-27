// 0035 P3：版式映射（ResolvedLayout → DOCX 单位）——纯函数，无 IO/无库读取。
// 单位口径：Word 页面/边距/栏距用 twip（1/1440 英寸）；字号半磅；图片尺寸用 px（docx 按 9525 EMU/px 换算，
// 96dpi 与渲染管线的 CSS px 同口径——同卷在 PDF 与 Word 里字号/图宽物理尺寸一致）。
// 双栏：OOXML 的 pgSz 宽高是物理尺寸，横版不靠 w:orient（Word 以宽高自行判定）——故取向在装订前互换。

import type { ResolvedLayout } from '../../render/layout.js';
import { pageDimsMm, PT_TO_MM } from '../../render/layout.js';

/** mm → twip（1mm = 1440/25.4 twip） */
export function mmToTwip(mmValue: number): number {
  return Math.round((mmValue * 1440) / 25.4);
}

/** pt → 半磅（Word 字号单位） */
export function ptToHalfPoints(pt: number): number {
  return Math.round(pt * 2);
}

/** pt → px（96dpi，与渲染管线 CSS px 同口径） */
export function ptToPx(pt: number): number {
  return (pt * 96) / 72;
}

/** pt → twip（行距用；1pt = 20 twip） */
export function ptToTwip(pt: number): number {
  return Math.round(pt * 20);
}

/** 正文行距基线（paper.css --mf-line-height 1.8 → 240 分之一行 ×1.8） */
export const DEFAULT_BODY_LINE = 432;
/** 题面行距基线（paper.css --mf-question-line-height 2 → 480） */
export const DEFAULT_QUESTION_LINE = 480;

/** CSS 字体族串 → Word 字体名（取首个族名去引号；通用族与常见中文字体归一） */
export function wordFontFamily(cssFamily: string): string {
  const first = cssFamily.split(',')[0]?.trim().replace(/^['"]|['"]$/g, '') ?? '';
  const key = first.toLowerCase();
  const table: Record<string, string> = {
    simsun: 'SimSun',
    stsong: 'STSong',
    serif: 'SimSun',
    'sans-serif': 'Microsoft YaHei',
    'microsoft yahei': 'Microsoft YaHei',
    simhei: 'SimHei',
    kaiti: 'KaiTi',
    fangsong: 'FangSong',
    consolas: 'Consolas',
    monospace: 'Consolas',
    arial: 'Arial',
    'times new roman': 'Times New Roman',
  };
  return table[key] ?? (first !== '' ? first : 'SimSun');
}

/** DOCX 页面规格（twip/px 双口径；装订层直接消费） */
export interface DocxPageSpec {
  widthTwip: number;
  heightTwip: number;
  orientation: 'portrait' | 'landscape';
  marginTwip: { top: number; right: number; bottom: number; left: number };
  columns: 1 | 2;
  columnGapTwip: number;
  /** 版心宽（页宽 − 左右边距） */
  contentWidthTwip: number;
  contentWidthPx: number;
  /** 单栏列宽（双栏时 = (版心宽 − 栏距)/2）——图宽百分比基准 */
  columnWidthPx: number;
  baseFontHalfPoints: number;
  baseFontPx: number;
  bodyLineTwip: number;
  questionLineTwip: number;
  /** 作答区单行行高 twip（正文行距档；与 answerSpaceLineHeightMm 同源换算） */
  answerLineTwip: number;
  /** Word 字体名（卷面正文） */
  fontFamily: string;
}

/** ResolvedLayout → DOCX 页面规格（取向已互换，物理宽高正确） */
export function mapLayout(resolved: ResolvedLayout): DocxPageSpec {
  const dims = pageDimsMm(resolved);
  const marginTwip = {
    top: mmToTwip(resolved.pageMarginMm.top),
    right: mmToTwip(resolved.pageMarginMm.right),
    bottom: mmToTwip(resolved.pageMarginMm.bottom),
    left: mmToTwip(resolved.pageMarginMm.left),
  };
  const contentWidthTwip = mmToTwip(dims.w) - marginTwip.left - marginTwip.right;
  const contentWidthPx = Math.round((dims.w - resolved.pageMarginMm.left - resolved.pageMarginMm.right) * 96 / 25.4);
  const gapTwip = mmToTwip(resolved.columnGapMm);
  const columnWidthPx = resolved.columns === 2
    ? Math.round((contentWidthPx - (resolved.columnGapMm * 96) / 25.4) / 2)
    : contentWidthPx;
  const lineHeight = resolved.lineHeight ?? 1.8;
  return {
    widthTwip: mmToTwip(dims.w),
    heightTwip: mmToTwip(dims.h),
    orientation: resolved.orientation,
    marginTwip,
    columns: resolved.columns,
    columnGapTwip: gapTwip,
    contentWidthTwip,
    contentWidthPx,
    columnWidthPx,
    baseFontHalfPoints: ptToHalfPoints(resolved.fontSize),
    baseFontPx: ptToPx(resolved.fontSize),
    bodyLineTwip: resolved.lineHeight === null ? DEFAULT_BODY_LINE : Math.round(240 * resolved.lineHeight),
    questionLineTwip: resolved.lineHeight === null ? DEFAULT_QUESTION_LINE : Math.round(240 * resolved.lineHeight),
    answerLineTwip: ptToTwip(resolved.fontSize * lineHeight),
    fontFamily: wordFontFamily(resolved.fontFamily),
  };
}

/**
 * 图片显示宽（px）——与 HTML 引擎同优先级链：
 * 题级/全局覆盖档 widthPercent > min(原像素宽, 60% 列宽)（只收敛不放大小图；原宽未知 → 直接取 60% 档）。
 */
export function resolveFigureWidthPx(args: {
  widthPercent: number | null;
  dataWidthPx: number | null;
  intrinsicWidthPx: number | null;
  contentWidthPx: number;
}): number {
  const { widthPercent, dataWidthPx, intrinsicWidthPx, contentWidthPx } = args;
  if (widthPercent !== null) {
    return Math.max(1, Math.round((contentWidthPx * widthPercent) / 100));
  }
  const cap = Math.round(contentWidthPx * 0.6);
  const base = dataWidthPx ?? intrinsicWidthPx;
  if (base === null) return Math.max(1, cap);
  return Math.max(1, Math.min(base, cap));
}

/** 作答区高度（mm）→ twip（与 layout.answerSpaceLineHeightMm 同口径：字号 × 行距 × pt→mm） */
export function answerSpaceHeightTwip(fontSizePt: number, lineHeight: number | null, lines: number): number {
  const lh = lineHeight ?? 1.8;
  return mmToTwip(lines * fontSizePt * lh * PT_TO_MM);
}
