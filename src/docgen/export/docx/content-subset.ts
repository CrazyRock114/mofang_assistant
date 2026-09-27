// 0035 P1：内容子集转换器（内容契约允许的标签 → DOCX 中间模型）。
// 允许标签（契约/引擎口径）：p、strong/b、em/i、sub、sup、br、span.math[data-tex]、
//   figure.diagram（内含 img）、div.question、div.options > span.option、div.answer、行内 img、
//   0050：table/thead/tbody/tfoot/tr/th|td（题内表格——识别链 markdown 表格与站点原生表格同路）。
// 清单外标签显式降级：记录（tag+样本文本）后按纯文本化继续，不静默吞、不中断。
// 无 DOM 依赖（纯字符串扫描，与 docgen/render 的引擎口径一致——同一份内容在 PDF 与 DOCX 两侧语义同源）。

export interface InlineFormat {
  bold?: boolean;
  italic?: boolean;
  vertical?: 'sub' | 'sup';
}

export type InlineItemKind = 'text' | 'math' | 'image' | 'break';

/** 行内项：text=文本 / math=LaTeX 源（value=tex） / image=src（value=src） / break=硬换行 */
export interface InlineItem {
  kind: InlineItemKind;
  value: string;
  format: InlineFormat;
  /** kind='math'：行间（display）公式 */
  display?: boolean;
  /** kind='image'：替代文本 */
  alt?: string;
  /** kind='image'：显式像素宽高（data-w/data-h；缺省 null = 用图片内在尺寸） */
  widthPx?: number | null;
  heightPx?: number | null;
}

export interface OptionEntry {
  label: string | null;
  items: InlineItem[];
}

/** 0050 P4：表格单元格（行内项 + 表头标记 + 合并跨度；Word 侧 colspan/rowspan 直出） */
export interface TableCellEntry {
  items: InlineItem[];
  /** 表头格（`<th>` 或位于 `<thead>` 内）→ Word 侧加粗 */
  header: boolean;
  colspan: number;
  rowspan: number;
}

export type ContentBlock =
  | { kind: 'paragraph'; items: InlineItem[] }
  | { kind: 'math'; tex: string }
  | { kind: 'figure'; src: string; alt: string; align: 'left' | 'center' | 'right'; widthPx: number | null; heightPx: number | null }
  | { kind: 'options'; options: OptionEntry[] }
  | { kind: 'answer'; items: InlineItem[] }
  | { kind: 'table'; rows: TableCellEntry[][] };

export interface Degradation {
  tag: string;
  text: string;
}

export interface SubsetResult {
  blocks: ContentBlock[];
  degradations: Degradation[];
}

export interface MergedDegradation {
  tag: string;
  count: number;
  sample: string;
}

interface Ctx {
  degradations: Degradation[];
}

// ---------- 标签扫描（容错：未闭合/脏 HTML 不中断） ----------

interface TagRead {
  name: string;
  closing: boolean;
  selfClosing: boolean;
  attrText: string;
  end: number;
}

const TAG_NAME_RE = /[a-zA-Z0-9:-]/;
const VOID_TAGS = new Set(['br', 'img', 'hr', 'meta', 'link', 'input', 'wbr', 'source']);
const FORMAT_TAGS = new Set(['strong', 'b', 'em', 'i', 'sub', 'sup']);
/** 清单外但属块级语义的标签：降级时同时断段（避免多行黏成一大段） */
const BLOCKISH_TAGS = new Set([
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'section', 'article', 'pre', 'hr',
]);
const SKIP_CONTENT_TAGS = new Set(['script', 'style']);
/** 0035 修复批：表格降级时的单元格分隔符（全角空格——行内续排且不与中文粘连） */
const CELL_SEPARATOR = '　';

function readTag(html: string, start: number): TagRead {
  let i = start + 1;
  let closing = false;
  if (html[i] === '/') {
    closing = true;
    i += 1;
  }
  const nameStart = i;
  while (i < html.length && TAG_NAME_RE.test(html[i])) i += 1;
  const name = html.slice(nameStart, i).toLowerCase();
  let quote: string | null = null;
  let end = -1;
  while (i < html.length) {
    const ch = html[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      end = i;
      break;
    }
    i += 1;
  }
  if (end < 0) {
    return { name, closing, selfClosing: true, attrText: html.slice(nameStart + name.length), end: html.length };
  }
  const selfClosing = html[end - 1] === '/' || VOID_TAGS.has(name);
  return { name, closing, selfClosing, attrText: html.slice(nameStart + name.length, end).replace(/\/\s*$/, ''), end: end + 1 };
}

/** 平衡查找同名闭合标签（未闭合 → 取到末尾；容错优先） */
function findClosing(html: string, from: number, name: string): { inner: string; end: number } {
  let depth = 1;
  let i = from;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    const tag = readTag(html, lt);
    if (tag.name === name) {
      if (tag.closing) {
        depth -= 1;
        if (depth === 0) return { inner: html.slice(from, lt), end: tag.end };
      } else if (!tag.selfClosing) {
        depth += 1;
      }
    }
    i = Math.max(tag.end, lt + 1);
  }
  return { inner: html.slice(from), end: html.length };
}

function parseAttrs(attrText: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  for (const match of attrText.matchAll(re)) {
    const value = match[3] ?? match[4] ?? match[5] ?? '';
    attrs.set(match[1].toLowerCase(), value);
  }
  return attrs;
}

function classListOf(attrs: Map<string, string>): string[] {
  return (attrs.get('class') ?? '').split(/\s+/).filter((c) => c !== '');
}

function numAttr(attrs: Map<string, string>, name: string): number | null {
  const raw = attrs.get(name);
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  times: '×', divide: '÷', deg: '°', hellip: '…', mdash: '—', ndash: '–', middot: '·',
};

/** 实体解码（命名 + 十进制 + 十六进制；未知实体原样保留） */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

function textItem(raw: string, format: InlineFormat): InlineItem | null {
  const value = decodeEntities(raw).replace(/\s+/g, ' ');
  if (value === '') return null;
  return { kind: 'text', value, format: { ...format } };
}

function toPlainText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// ---------- 行内解析（无块级输出） ----------

function parseInline(html: string, ctx: Ctx): InlineItem[] {
  const items: InlineItem[] = [];
  const formatStack: InlineFormat[] = [];
  let format: InlineFormat = {};
  let i = 0;

  const push = (item: InlineItem | null): void => {
    if (item !== null) items.push(item);
  };

  while (i < html.length) {
    if (html[i] !== '<') {
      const next = html.indexOf('<', i);
      const chunk = next < 0 ? html.slice(i) : html.slice(i, next);
      push(textItem(chunk, format));
      i = next < 0 ? html.length : next;
      continue;
    }
    if (html.startsWith('<!--', i)) {
      const close = html.indexOf('-->', i);
      i = close < 0 ? html.length : close + 3;
      continue;
    }
    if (html[i + 1] === '!') {
      const close = html.indexOf('>', i);
      i = close < 0 ? html.length : close + 1;
      continue;
    }
    const tag = readTag(html, i);
    if (tag.name === '') {
      i += 1;
      continue;
    }
    if (tag.closing) {
      if (FORMAT_TAGS.has(tag.name) && formatStack.length > 0) format = formatStack.pop() as InlineFormat;
      else if (tag.name === 'p' || tag.name === 'br') push({ kind: 'break', value: '', format: {} });
      else if (BLOCKISH_TAGS.has(tag.name)) push({ kind: 'break', value: '', format: {} });
      i = tag.end;
      continue;
    }
    if (tag.name === 'br') {
      push({ kind: 'break', value: '', format: {} });
      i = tag.end;
      continue;
    }
    if (FORMAT_TAGS.has(tag.name)) {
      formatStack.push(format);
      format = applyFormat(format, tag.name);
      i = tag.end;
      continue;
    }
    if (tag.name === 'span') {
      const attrs = parseAttrs(tag.attrText);
      const classes = classListOf(attrs);
      const { inner, end } = findClosing(html, tag.end, 'span');
      const math = mathFromSpan(classes, attrs, inner);
      if (math !== null) {
        push({ ...math, format: { ...format } });
        i = end;
        continue;
      }
      appendInline(items, inner, ctx, format);
      i = end;
      continue;
    }
    if (tag.name === 'img') {
      const attrs = parseAttrs(tag.attrText);
      push(imageItem(attrs, format));
      i = tag.end;
      continue;
    }
    if (tag.name === 'figure') {
      const { inner, end } = findClosing(html, tag.end, 'figure');
      const item = figureInnerItem(inner, format);
      if (item !== null) push(item);
      i = end;
      continue;
    }
    if (SKIP_CONTENT_TAGS.has(tag.name)) {
      const { end } = findClosing(html, tag.end, tag.name);
      ctx.degradations.push({ tag: tag.name, text: '' });
      i = end;
      continue;
    }
    if (tag.name === 'p') {
      // 契约内标签：行内上下文里 <p> 只作段边界（闭合分支已落 break）
      i = tag.end;
      continue;
    }
    if (tag.name === 'div') {
      recordDegradation(ctx, 'div', '');
      i = tag.end;
      continue;
    }
    recordDegradation(ctx, tag.name, toPlainText(html.slice(tag.end, tag.end + 40)));
    i = tag.end;
  }
  return items;
}

function appendInline(target: InlineItem[], html: string, ctx: Ctx, format: InlineFormat): void {
  for (const item of parseInline(html, ctx)) {
    target.push({ ...item, format: { ...format, ...item.format } });
  }
}

function applyFormat(format: InlineFormat, tag: string): InlineFormat {
  if (tag === 'strong' || tag === 'b') return { ...format, bold: true };
  if (tag === 'em' || tag === 'i') return { ...format, italic: true };
  if (tag === 'sub') return { ...format, vertical: 'sub' };
  if (tag === 'sup') return { ...format, vertical: 'sup' };
  return format;
}

function recordDegradation(ctx: Ctx, tag: string, sample: string): void {
  const text = sample.replace(/\s+/g, ' ').trim().slice(0, 40);
  ctx.degradations.push({ tag, text });
}

/** span 契约形态（span.math[data-tex]）与存量已渲染形态（span.katex + annotation）统一取 tex */
function mathFromSpan(classes: string[], attrs: Map<string, string>, inner: string): InlineItem | null {
  if (classes.includes('math')) {
    const tex = attrs.get('data-tex');
    if (tex === undefined) return null;
    const display = attrs.get('data-display') === 'true';
    return { kind: 'math', value: decodeEntities(tex), format: {}, display };
  }
  if (classes.includes('katex')) {
    const annotation = /<annotation[^>]*>([\s\S]*?)<\/annotation>/.exec(inner);
    if (!annotation) return null;
    return { kind: 'math', value: decodeEntities(annotation[1]), format: {}, display: false };
  }
  return null;
}

function imageItem(attrs: Map<string, string>, format: InlineFormat): InlineItem | null {
  const src = attrs.get('src');
  if (src === undefined || src === '') return null;
  return {
    kind: 'image',
    value: src,
    format: { ...format },
    alt: attrs.get('alt') ?? '',
    widthPx: numAttr(attrs, 'data-w'),
    heightPx: numAttr(attrs, 'data-h'),
  };
}

/** figure 内首个 img → 行内图片项（figure 自身的 data-w/data-h 优先于 img 上的） */
function figureInnerItem(inner: string, format: InlineFormat): InlineItem | null {
  const at = inner.search(/<img\b/i);
  if (at < 0) return null;
  return imageItem(parseAttrs(readTag(inner, at).attrText), format);
}

// ---------- 块级解析 ----------

function paragraphOf(items: InlineItem[]): ContentBlock | null {
  const trimmed = trimItems(items);
  return trimmed.length > 0 ? { kind: 'paragraph', items: trimmed } : null;
}

/** 断段时收敛两端空白（中间空白保留——公式两侧的间隔有语义） */
function trimItems(items: InlineItem[]): InlineItem[] {
  const out = items.filter((item) => item.kind !== 'text' || item.value !== '');
  let start = 0;
  let end = out.length;
  while (start < end && out[start].kind === 'text' && out[start].value.trim() === '') start += 1;
  while (end > start && out[end - 1].kind === 'text' && out[end - 1].value.trim() === '') end -= 1;
  const sliced = out.slice(start, end);
  if (sliced.length > 0 && sliced[0].kind === 'text') sliced[0] = { ...sliced[0], value: sliced[0].value.replace(/^\s+/, '') };
  if (sliced.length > 0) {
    const last = sliced[sliced.length - 1];
    if (last.kind === 'text') sliced[sliced.length - 1] = { ...last, value: last.value.replace(/\s+$/, '') };
  }
  return sliced.filter((item) => item.kind !== 'text' || item.value !== '');
}

function optionEntries(inner: string, ctx: Ctx): OptionEntry[] {
  const entries: OptionEntry[] = [];
  let i = 0;
  while (i < inner.length) {
    const at = inner.indexOf('<span', i);
    if (at < 0) break;
    const tag = readTag(inner, at);
    const attrs = parseAttrs(tag.attrText);
    const classes = classListOf(attrs);
    const { inner: optionInner, end } = findClosing(inner, tag.end, 'span');
    if (classes.includes('option')) {
      const items = parseInline(optionInner, ctx);
      const labelMatch = /^\s*([A-Za-zＡ-Ｚ][.．、])\s*/.exec(items.filter((it) => it.kind === 'text')[0]?.value ?? '');
      entries.push({ label: labelMatch ? labelMatch[1].replace(/[．、]/, '.') : null, items });
    }
    i = end;
  }
  return entries;
}

// ---------- 0050 P4：表格（题内表格 → Word 真表格的中间模型） ----------

/** 单元格内容收敛：去首尾空白 + 去首尾硬换行（格内 `<p>…</p>` 只作段边界，不留空行项） */
function cellItems(items: InlineItem[]): InlineItem[] {
  const trimmed = trimItems(items);
  let start = 0;
  let end = trimmed.length;
  while (start < end && trimmed[start].kind === 'break') start += 1;
  while (end > start && trimmed[end - 1].kind === 'break') end -= 1;
  return trimmed.slice(start, end);
}

/** 一行 → 单元格（td/th；行内解析，格内不递归块级语义）；th 或 thead 内的格标表头 */
function parseTableRowCells(rowInner: string, ctx: Ctx, inHead: boolean): TableCellEntry[] {
  const cells: TableCellEntry[] = [];
  let i = 0;
  while (i < rowInner.length) {
    const lt = rowInner.indexOf('<', i);
    if (lt < 0) break;
    const tag = readTag(rowInner, lt);
    if (tag.name === '') {
      i = lt + 1;
      continue;
    }
    if (tag.name === 'td' || tag.name === 'th') {
      const { inner, end } = findClosing(rowInner, tag.end, tag.name);
      const attrs = parseAttrs(tag.attrText);
      const sink: InlineItem[] = [];
      appendInline(sink, inner, ctx, {});
      cells.push({
        items: cellItems(sink),
        header: tag.name === 'th' || inHead,
        colspan: numAttr(attrs, 'colspan') ?? 1,
        rowspan: numAttr(attrs, 'rowspan') ?? 1,
      });
      i = end;
      continue;
    }
    i = tag.end;
  }
  return cells;
}

/**
 * 表内 HTML → 行/格结构。
 * 行边界只在 `<tr>`（thead/tbody/tfoot/colgroup/col 为结构壳，不产出内容）；
 * 表内清单外标签（caption 等）照纪律记账。无 tr 的表返回空数组（调用方按既有降级处理）。
 */
function parseTableRows(inner: string, ctx: Ctx): TableCellEntry[][] {
  const rows: TableCellEntry[][] = [];
  let inHead = false;
  let i = 0;
  while (i < inner.length) {
    const lt = inner.indexOf('<', i);
    if (lt < 0) break;
    const tag = readTag(inner, lt);
    if (tag.name === '') {
      i = lt + 1;
      continue;
    }
    if (tag.closing) {
      if (tag.name === 'thead') inHead = false;
      i = tag.end;
      continue;
    }
    if (tag.name === 'thead') {
      inHead = true;
      i = tag.end;
      continue;
    }
    if (tag.name === 'tbody' || tag.name === 'tfoot' || tag.name === 'colgroup' || tag.name === 'col') {
      i = tag.end;
      continue;
    }
    if (tag.name === 'tr') {
      const { inner: rowInner, end } = findClosing(inner, tag.end, 'tr');
      const cells = parseTableRowCells(rowInner, ctx, inHead);
      if (cells.length > 0) rows.push(cells);
      i = end;
      continue;
    }
    recordDegradation(ctx, tag.name, toPlainText(inner.slice(tag.end, tag.end + 40)));
    i = tag.end;
  }
  return rows;
}

export function parseContentSubset(html: string): SubsetResult {
  const ctx: Ctx = { degradations: [] };
  const blocks: ContentBlock[] = [];
  let current: InlineItem[] = [];
  const formatStack: InlineFormat[] = [];
  let format: InlineFormat = {};

  const flush = (): void => {
    const paragraph = paragraphOf(current);
    if (paragraph !== null) blocks.push(paragraph);
    current = [];
  };

  let i = 0;
  while (i < html.length) {
    if (html[i] !== '<') {
      const next = html.indexOf('<', i);
      const chunk = next < 0 ? html.slice(i) : html.slice(i, next);
      const item = textItem(chunk, format);
      if (item !== null) current.push(item);
      i = next < 0 ? html.length : next;
      continue;
    }
    if (html.startsWith('<!--', i)) {
      const close = html.indexOf('-->', i);
      i = close < 0 ? html.length : close + 3;
      continue;
    }
    if (html[i + 1] === '!') {
      const close = html.indexOf('>', i);
      i = close < 0 ? html.length : close + 1;
      continue;
    }
    const tag = readTag(html, i);
    if (tag.name === '') {
      i += 1;
      continue;
    }

    if (tag.closing) {
      // 段边界只有契约级块（p/div）；清单外标签降级时纯文本化接排（不擅自断段）
      // 0035 修复批：表格类闭合同样断段（`</tr>` 收行、`</table>` 收表并让后续正文另起段）
      if (FORMAT_TAGS.has(tag.name) && formatStack.length > 0) format = formatStack.pop() as InlineFormat;
      else if (tag.name === 'p' || tag.name === 'div') flush();
      else if (tag.name === 'tr' || tag.name === 'table' || tag.name === 'thead'
        || tag.name === 'tbody' || tag.name === 'tfoot') flush();
      i = tag.end;
      continue;
    }

    if (tag.name === 'br') {
      current.push({ kind: 'break', value: '', format: {} });
      i = tag.end;
      continue;
    }
    if (tag.name === 'p') {
      flush();
      i = tag.end;
      continue;
    }
    if (FORMAT_TAGS.has(tag.name)) {
      formatStack.push(format);
      format = applyFormat(format, tag.name);
      i = tag.end;
      continue;
    }
    if (tag.name === 'span') {
      const attrs = parseAttrs(tag.attrText);
      const classes = classListOf(attrs);
      const { inner, end } = findClosing(html, tag.end, 'span');
      const math = mathFromSpan(classes, attrs, inner);
      if (math !== null) {
        if (math.display === true) {
          flush();
          blocks.push({ kind: 'math', tex: math.value });
        } else {
          current.push(math);
        }
        i = end;
        continue;
      }
      if (classes.includes('math') || classes.includes('katex')) {
        // 契约形态缺 data-tex（脏数据）：显式降级，不静默吞
        recordDegradation(ctx, 'span.math', toPlainText(inner));
        appendInline(current, inner, ctx, format);
        i = end;
        continue;
      }
      // 0035 修复批：裸 span 是**纯行内包裹**（契约里 span 只作 span.math 出现；采集站的
      // .inline-figure 等壳层类同理）——拆壳后文字/图片原样续排，无内容与结构损失，
      // 故不再计入降级清单（否则每卷都报「span×N」，把「缺图/表格」这类真缺口淹没）。
      // 真正的损失仍逐项记账（span.math 缺 data-tex 见上、表格类见下、未知标签见尾）。
      appendInline(current, inner, ctx, format);
      i = end;
      continue;
    }
    if (tag.name === 'img') {
      const item = imageItem(parseAttrs(tag.attrText), format);
      if (item !== null) current.push(item);
      i = tag.end;
      continue;
    }
    if (tag.name === 'figure') {
      const { inner, end } = findClosing(html, tag.end, 'figure');
      flush();
      const attrs = parseAttrs(tag.attrText);
      const imgAt = inner.search(/<img\b/i);
      const imgAttrs = imgAt >= 0 ? parseAttrs(readTag(inner, imgAt).attrText) : new Map<string, string>();
      const src = imgAttrs.get('src') ?? '';
      if (src === '') {
        recordDegradation(ctx, 'figure', toPlainText(inner));
      } else {
        const alignRaw = attrs.get('data-align');
        blocks.push({
          kind: 'figure',
          src,
          alt: imgAttrs.get('alt') ?? '',
          align: alignRaw === 'left' || alignRaw === 'right' ? alignRaw : 'center',
          widthPx: numAttr(attrs, 'data-w') ?? numAttr(imgAttrs, 'data-w'),
          heightPx: numAttr(attrs, 'data-h') ?? numAttr(imgAttrs, 'data-h'),
        });
      }
      i = end;
      continue;
    }
    if (tag.name === 'div') {
      const attrs = parseAttrs(tag.attrText);
      const classes = classListOf(attrs);
      if (classes.includes('question')) {
        i = tag.end;
        continue;
      }
      if (classes.includes('options')) {
        const { inner, end } = findClosing(html, tag.end, 'div');
        flush();
        blocks.push({ kind: 'options', options: optionEntries(inner, ctx) });
        i = end;
        continue;
      }
      if (classes.includes('answer')) {
        const { inner, end } = findClosing(html, tag.end, 'div');
        flush();
        const sink: InlineItem[] = [];
        appendInline(sink, inner, ctx, format);
        blocks.push({ kind: 'answer', items: trimItems(sink) });
        i = end;
        continue;
      }
      recordDegradation(ctx, 'div', '');
      flush();
      i = tag.end;
      continue;
    }
    if (SKIP_CONTENT_TAGS.has(tag.name)) {
      const { end } = findClosing(html, tag.end, tag.name);
      recordDegradation(ctx, tag.name, toPlainText(html.slice(tag.end, end)));
      i = end;
      continue;
    }
    // 0050 P4：契约内表格 → 结构化表格块（Word 侧出真 w:tbl）。
    // 无 tr 的空表/坏表回落既有容错语义（断段 + 记账，内容随正文续排）。
    if (tag.name === 'table') {
      const { inner, end } = findClosing(html, tag.end, 'table');
      const rows = parseTableRows(inner, ctx);
      if (rows.length === 0) {
        flush();
        recordDegradation(ctx, 'table', '');
        i = tag.end;
        continue;
      }
      flush();
      blocks.push({ kind: 'table', rows });
      i = end;
      continue;
    }
    // 0035 修复批：表格类清单外标签降级时**保留结构边界**——整表断开、行独立成段、单元格间留分隔。
    // 否则整张表的行/单元格文字黏成一段（真题：选项装在 table 里的题，A/B/C/D 连成一行）。
    // 仍逐标签记账（不静默吞），只是纯文本化时不再丢掉行/格边界。
    // （0050 P4 起 table 已入契约清单，此处只剩表壳/行/格标签游离于表外的脏数据形态。）
    if (tag.name === 'thead' || tag.name === 'tbody' || tag.name === 'tfoot') {
      flush();
      recordDegradation(ctx, tag.name, '');
      i = tag.end;
      continue;
    }
    if (tag.name === 'tr') {
      flush();
      recordDegradation(ctx, tag.name, toPlainText(html.slice(tag.end, tag.end + 40)));
      i = tag.end;
      continue;
    }
    if (tag.name === 'td' || tag.name === 'th') {
      // 单元格间留一个全角空格分隔（行内续排，不另起段——保持「同一行并排」的读感）
      const tail = current[current.length - 1];
      if (tail !== undefined && !(tail.kind === 'text' && tail.value.endsWith(CELL_SEPARATOR))) {
        current.push({ kind: 'text', value: CELL_SEPARATOR, format: {} });
      }
      recordDegradation(ctx, tag.name, toPlainText(html.slice(tag.end, tag.end + 40)));
      i = tag.end;
      continue;
    }
    recordDegradation(ctx, tag.name, toPlainText(html.slice(tag.end, tag.end + 40)));
    i = tag.end;
  }

  flush();
  return { blocks, degradations: ctx.degradations };
}

/** 降级清单聚合（按标签计数 + 首见样本；保持出现序） */
export function mergeDegradations(list: Degradation[]): MergedDegradation[] {
  const order: string[] = [];
  const map = new Map<string, MergedDegradation>();
  for (const entry of list) {
    const existing = map.get(entry.tag);
    if (existing) {
      existing.count += 1;
      continue;
    }
    order.push(entry.tag);
    map.set(entry.tag, { tag: entry.tag, count: 1, sample: entry.text });
  }
  return order.map((tag) => map.get(tag) as MergedDegradation);
}

/**
 * 内联片段直接解析（答案/解析字段：单段语义，块级元素折成硬换行）。
 * 返回降级清单——答案/解析里的清单外标签同样显式记录，不静默吞。
 */
export function parseInlineFragment(html: string): { items: InlineItem[]; degradations: Degradation[] } {
  const ctx: Ctx = { degradations: [] };
  return { items: trimItems(parseInline(html, ctx)), degradations: ctx.degradations };
}

/** 纯文本 → 行内项（文本块行；换行转 break） */
export function textToInlineItems(text: string): InlineItem[] {
  const parts = text.split(/\r?\n/);
  const items: InlineItem[] = [];
  parts.forEach((part, index) => {
    if (index > 0) items.push({ kind: 'break', value: '', format: {} });
    if (part !== '') items.push({ kind: 'text', value: part, format: {} });
  });
  return trimItems(items);
}
