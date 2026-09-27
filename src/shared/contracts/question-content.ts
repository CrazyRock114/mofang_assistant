// Phase 1: 内容 HTML 契约类型与常量（依据架构文档 §2，已定案不得发明）

/**
 * 题面/答案/解析统一为 HTML 片段
 * 公式：<span class="math" data-tex="...">（data-tex 存 LaTeX 源）
 * 图片：块级 <figure class="diagram" data-align="left|center|right" data-w data-h> + 内嵌 <img>
 * 行内图（0045 只增）：<span class="inline-figure"><img data-w data-h></span>（随文字串行，
 *   形态对齐采集层 capture/normalize.ts 既有产物——此前为暗契约，本处正式化）
 * 表格（0045 目检返工④ 只增）：<table><tbody><tr><th|td>…（编辑器插入，@tiptap/extension-table 产物）
 * 选项：<div class="options"> 内 <span class="option">
 * 题面根：<div class="question">
 * 答案三态语义（学生隐藏/题后/卷尾）只是渲染层概念，契约中仅保留完整答案 HTML
 */

export const CONTENT_CLASSES = {
  QUESTION_ROOT: 'question',
  MATH: 'math',
  DIAGRAM: 'diagram',
  INLINE_FIGURE: 'inline-figure',
  OPTIONS: 'options',
  OPTION: 'option',
} as const;

export const DIAGRAM_ALIGN = ['left', 'center', 'right'] as const;
export type DiagramAlign = typeof DIAGRAM_ALIGN[number];

export interface MathElement {
  tag: 'span';
  class: typeof CONTENT_CLASSES.MATH;
  'data-tex': string;
}

export interface DiagramElement {
  tag: 'figure';
  class: typeof CONTENT_CLASSES.DIAGRAM;
  'data-align': DiagramAlign;
  'data-w': string;
  'data-h': string;
}

/** 0045 只增：行内图元素（随文字串行的小图；data-w/h 写在 img 上，同采集层形态） */
export interface InlineFigureElement {
  tag: 'span';
  class: typeof CONTENT_CLASSES.INLINE_FIGURE;
}

/**
 * 契约 HTML 片段验证辅助函数
 */
export function isValidQuestionContent(html: string): boolean {
  return html.includes(`class="${CONTENT_CLASSES.QUESTION_ROOT}"`);
}

export function containsMath(html: string): boolean {
  return html.includes(`class="${CONTENT_CLASSES.MATH}"`) && html.includes('data-tex=');
}

export function containsDiagram(html: string): boolean {
  return html.includes(`class="${CONTENT_CLASSES.DIAGRAM}"`);
}
