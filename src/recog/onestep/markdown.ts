// 0040 P1/P4：模型 Markdown → 编辑器契约 HTML（纯函数，无 IO）。
//
// 契约格式以 `src/docgen/editor/` 的 TipTap 节点为准（唯一编辑器，禁引第二套）：
//   题干段落      → <p>…</p>
//   行内公式      → <span class="math" data-tex="…"></span>
//   独立公式行    → <span class="math" data-tex="…" data-display="true"></span>
//   题内插图 [图N]→ <figure class="diagram" data-align="center" data-w data-h><img class="q-figure" src></figure>
//   整题外壳      → <div class="question">题干 + <div class="options">…</div></div>（capture/normalize 同款）
//
// 注意：题干里的 [图N] 落为**块级** figureNode（FigureNode parseHTML 只认 figure.diagram，
// 可整块拖动调位）；选项里的 [图N]（0045 P4 图片选项）落为 span.inline-figure 行内图——
// 块级 figure 进 <span class="option"> 会被 schema 提升、破版式，故选项内一律行内。

import type { OnestepOption } from '../../shared/contracts/onestep-types.js';

export function escapeHtmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeHtmlAttr(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** 图块契约 HTML（src 为空 = 尚未裁图，渲染层按占位显示） */
export function figureNodeHtml(src: string, width = 0, height = 0, ref?: string): string {
  const refAttr = ref ? ` data-fig-ref="${escapeHtmlAttr(ref)}"` : '';
  return (
    `<figure class="diagram" data-align="center" data-w="${width}" data-h="${height}"${refAttr}>` +
    `<img class="q-figure" src="${escapeHtmlAttr(src)}"></figure>`
  );
}

/** 0045 P4：行内图契约 HTML（随文字串行；形态对齐采集层 span.inline-figure，data-w/h 写在 img 上） */
export function inlineFigureHtml(src: string, width = 0, height = 0): string {
  return `<span class="inline-figure"><img class="q-figure" data-w="${width}" data-h="${height}" src="${escapeHtmlAttr(src)}"></span>`;
}

/** 行内/独立公式 span */
export function mathSpanHtml(tex: string, display: boolean): string {
  return `<span class="math" data-tex="${escapeHtmlAttr(tex.trim())}"${display ? ' data-display="true"' : ''}></span>`;
}

const MATH_OR_FIGURE_RE = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$|\[图\s*(\d+)\]/g;

export interface MarkdownRenderOptions {
  /** 图编号（[图N] 的 N）→ 图片 src；缺省/未命中 = 空 src 占位（渲染层显示「待补图」） */
  figureSrc?: (refIndex: number) => string | undefined;
  /** 图编号 → 像素尺寸（裁图后回填，供排版限宽） */
  figureSize?: (refIndex: number) => { width: number; height: number } | undefined;
}

/**
 * 单行文本 → 行内 HTML（公式 / 图块 / 其余文本按字面转义）。
 * figureMode='block'（题干默认）：[图N] 落块级 figureNode（可整块拖动调位）；
 * figureMode='inline'（选项内，0045 P4）：[图N] 落 span.inline-figure 行内图——
 * 块级 figure 进 <span class="option"> 会被 schema 提升破版，选项内必须行内。
 */
function inlineToHtml(line: string, options: MarkdownRenderOptions, figureMode: 'block' | 'inline' = 'block'): string {
  let out = '';
  let last = 0;
  for (const m of line.matchAll(MATH_OR_FIGURE_RE)) {
    const index = m.index ?? 0;
    out += escapeHtmlText(line.slice(last, index));
    last = index + m[0].length;
    if (m[1] !== undefined) {
      out += mathSpanHtml(m[1], true);
      continue;
    }
    if (m[2] !== undefined) {
      out += mathSpanHtml(m[2], false);
      continue;
    }
    const refIndex = Number(m[3]);
    const size = options.figureSize?.(refIndex);
    if (figureMode === 'inline') {
      out += inlineFigureHtml(options.figureSrc?.(refIndex) ?? '', size?.width ?? 0, size?.height ?? 0);
      continue;
    }
    out += figureNodeHtml(options.figureSrc?.(refIndex) ?? '', size?.width ?? 0, size?.height ?? 0, `图${refIndex}`);
  }
  out += escapeHtmlText(line.slice(last));
  return out;
}

// ==================== 0050 P1（R-037 第①步）：GFM 表格 → 契约 <table> ====================
//
// 结构与 `src/shared/contracts/question-content.ts` 白名单逐字对齐（thead/tbody/tr/th|td）：
// 表格由识别引擎产出的 markdown 纯文本还原成真表格，题卡/出纸/Word 导出共享同一份契约 HTML。
// 手写识别（零新依赖，D-067 口径）：只认「表头行 + 分隔行」齐备的表，宁可漏转不误伤。

/** 分隔行单元格：`---` / `:---` / `---:` / `:---:`（GFM 对齐语法，列数须与表头一致） */
const TABLE_DELIM_CELL_RE = /^:?-{1,}:?$/;

interface TableRowSplit {
  cells: string[];
  /** 首尾皆竖线（或多格行）——「闭合行」；行尾竖线可省（GFM 口径），单格残行 `abc|` 不算 */
  closed: boolean;
}

/**
 * 行 → 单元格。转义竖线（`\|`）与 `$…$` 内的竖线**不作分隔符**——
 * 单元格里的绝对值 `$|x|$` 是理科表格的常见形态，按裸 `|` 切会把行切错。
 */
function splitTableRow(line: string): TableRowSplit {
  const trimmed = line.trim();
  const closed = trimmed.length > 1 && trimmed.startsWith('|') && trimmed.endsWith('|');
  let body = trimmed;
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|')) body = body.slice(0, -1);
  const cells: string[] = [];
  let current = '';
  let inMath = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '\\' && body[i + 1] === '|') {
      current += '|';
      i += 1;
      continue;
    }
    if (ch === '$' && body[i - 1] !== '\\') {
      inMath = !inMath;
      current += ch;
      continue;
    }
    if (ch === '|' && !inMath) {
      cells.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current);
  return { cells: cells.map((c) => c.trim()), closed };
}

/** 可作表行（表头/表体）：含竖线，且多格或首尾闭合（`abc|`／`| abc` 这类未闭合残行不算） */
function isTableRowLine(line: string): boolean {
  if (!line.includes('|')) return false;
  const { cells, closed } = splitTableRow(line);
  return cells.length > 1 || closed;
}

/** 分隔行：列数与表头一致且每格都是 `:?-+:?`（列数不齐 → 不转，防误伤普通竖线文本） */
function isTableDelimiterRow(line: string, columns: number): boolean {
  if (!line.includes('|')) return false;
  const { cells } = splitTableRow(line);
  return cells.length === columns && cells.every((cell) => TABLE_DELIM_CELL_RE.test(cell));
}

/**
 * 从第 start 行起读一张表（表头行 + 分隔行齐备才成立；返回 next = 表尾后一行）。
 * 列数以表头为准：表体行少补空单元格、多于表头截断。单元格只跑行内件（不递归列表/标题等块级语法），
 * `[图N]` 落**行内图**——块级 figure 会被图块化管线从 `<td>` 内摘出、拆破表结构（与选项内同口径）。
 */
function readTableAt(
  lines: string[],
  start: number,
  options: MarkdownRenderOptions
): { html: string; next: number } | null {
  const headerLine = lines[start];
  if (!isTableRowLine(headerLine)) return null;
  const header = splitTableRow(headerLine).cells;
  if (header.length === 0) return null;
  const delimiterLine = lines[start + 1];
  if (delimiterLine === undefined || !isTableDelimiterRow(delimiterLine, header.length)) return null;

  const cellHtml = (text: string): string => inlineToHtml(text, options, 'inline');
  const row = (cells: string[], tag: 'th' | 'td'): string => {
    const padded = cells.slice(0, header.length);
    while (padded.length < header.length) padded.push('');
    return `<tr>${padded.map((cell) => `<${tag}>${cellHtml(cell)}</${tag}>`).join('')}</tr>`;
  };

  const bodyRows: string[] = [];
  let i = start + 2;
  while (i < lines.length && isTableRowLine(lines[i])) {
    bodyRows.push(row(splitTableRow(lines[i]).cells, 'td'));
    i += 1;
  }
  const head = `<thead>${row(header, 'th')}</thead>`;
  const body = `<tbody>${bodyRows.join('')}</tbody>`;
  return { html: `<table>${head}${body}</table>`, next: i };
}

/**
 * 题干 Markdown → 契约 HTML。
 * 段落规则：空行分段；单行内的 `[图N]` 与公式原位置内联替换（图块本身是块级节点，
 * 落进段落时会由 ProseMirror 的块级提升规则提到段落之间——与「图随题走」的诉求一致）。
 * 0050 P1：表头行 + 分隔行的 GFM 表格转 `<table>`（行内件照常；块级语法不递归）。
 */
export function stemMarkdownToHtml(markdown: string, options: MarkdownRenderOptions = {}): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: string[] = [];
  let buffer: string[] = [];
  const flush = () => {
    if (buffer.length === 0) return;
    blocks.push(`<p>${buffer.join('<br>')}</p>`);
    buffer = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') {
      flush();
      continue;
    }
    const table = readTableAt(lines, i, options);
    if (table !== null) {
      flush();
      blocks.push(table.html);
      i = table.next - 1;
      continue;
    }
    buffer.push(inlineToHtml(line, options));
  }
  flush();
  return blocks.join('');
}

/**
 * 选项 → `.options > span.option`（标号前置，与 capture/normalize 同款）。
 * 0045 P4：renderOptions 透传（图块 src/尺寸与题干同源）；选项内 [图N] 一律行内图。
 */
export function optionsToHtml(options: OnestepOption[] | null, renderOptions: MarkdownRenderOptions = {}): string {
  if (!options || options.length === 0) return '';
  const spans = options
    .map((o) => `<span class="option">${escapeHtmlText(o.label)}. ${inlineToHtml(o.content, renderOptions, 'inline')}</span>`)
    .join('');
  return `<div class="options">${spans}</div>`;
}

/** 整题外壳（题库/卷面渲染与编辑器都认这个壳）；0045 P4：renderOptions 透传到选项 */
export function composeCardContentHtml(stemHtml: string, options: OnestepOption[] | null, renderOptions: MarkdownRenderOptions = {}): string {
  return `<div class="question">${stemHtml}${optionsToHtml(options, renderOptions)}</div>`;
}

/** 答案/解析片段 → 可进编辑器的壳（ProofPage wrapForEditor 同款口径） */
export function wrapForEditor(html: string | null | undefined): string {
  return `<div class="question">${html ?? ''}</div>`;
}

/** 编辑器产物 → 片段（剥掉包装壳） */
export function unwrapFromEditor(html: string): string {
  const trimmed = html.trim();
  const open = '<div class="question">';
  if (trimmed.startsWith(open) && trimmed.endsWith('</div>')) {
    return trimmed.slice(open.length, trimmed.length - '</div>'.length);
  }
  return trimmed;
}

/**
 * 纯文本片段（答案/解析 Markdown → HTML 段落；公式与换行同题干口径）。
 * 0069（只增可选）：`options` 透传——整图靶抠出的配图按 [图N] → `figure.diagram`（真 src/尺寸），
 * 缺省不传时产出与既有逐字节一致。
 */
export function textMarkdownToHtml(markdown: string | null, options: MarkdownRenderOptions = {}): string {
  if (markdown === null) return '';
  return stemMarkdownToHtml(markdown, options);
}

// ==================== 契约 HTML 上的图块操作（人工微调后重裁回填） ====================

const FIGURE_NODE_RE = /<figure\b[^>]*\bclass\s*=\s*"[^"]*\bdiagram\b[^"]*"[^>]*>[\s\S]*?<\/figure>/g;

/** 契约 HTML 里的图块节点数（不含行内小图 span） */
export function countFigureNodes(html: string): number {
  return html.match(FIGURE_NODE_RE)?.length ?? 0;
}

/**
 * 替换第 index（0 基）个图块节点的图片与尺寸（人工拖动框 → 重裁 → 回填）。
 * 越界或节点不存在时原样返回（不抛——UI 层不该因一次回填失败炸掉编辑面）。
 */
export function replaceFigureSrc(
  html: string,
  index: number,
  src: string,
  size?: { width: number; height: number },
): string {
  let cursor = 0;
  let replaced = false;
  return html.replace(FIGURE_NODE_RE, (match) => {
    if (replaced || cursor !== index) {
      cursor += 1;
      return match;
    }
    replaced = true;
    cursor += 1;
    return figureNodeHtml(src, size?.width ?? 0, size?.height ?? 0);
  });
}
