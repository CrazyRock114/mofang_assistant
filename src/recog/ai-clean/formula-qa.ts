// 0056 目检返工④：公式识别结果的质量闸门（纯函数，零 IO）。
//
// 依据组卷网公式图转文字施工参考（2026-09-24 更新版）：
//   §2.4 SVG 骨架校验器——组卷公式 SVG 的**几何结构可解析**（实测：`<line>`=分数线、`<path>`=字形轮廓、
//        `<g transform="translate(x,y)">`=字符分组），可与 OCR 结果机械对拍，把「模型幻觉」变成可判定信号；
//   §2.5 已知幻觉/垃圾形态——代码围栏、长文本幻觉（`[Image of …]`）、方括号幻觉（单字母被写成 `[H]`）、
//        `{\displaystyle` 残留、MathML `alttext` 回包。
//
// 口径（与参考 §2.4「否定式校验」一致）：**只做否定式判据**——骨架没有的东西不许出现在结果里；
// 命中即**标记可疑**（弹层可见、不自动采用），**不自动改写**（改写要人确认，见 §2.5 剥壳副作用教训）。

/** 公式 SVG 骨架（几何结构摘要；非公式 SVG/无信号时各字段为 0/false） */
export interface FormulaSkeleton {
  /** 分数线条数：**独立**横线（|y1-y2| 小、横向够长、两端不接斜/竖笔） */
  fractionBars: number;
  /** 根号骨架：存在「斜/竖笔 + 与之端点相接的横梁」组合 */
  radical: boolean;
  /** 字符分组数（`<g transform="translate(x,y)">` 数，≈字符数） */
  glyphGroups: number;
  /** 行数（分组按 y 值聚类；分式上下层各算一行） */
  rows: number;
  /**
   * 线状信号总数（`<line>` 元素个数）。
   * 真库实测（760 张公式 SVG）：只有 100 张含 `<line>`，**其余 660 张把根号/分式画成路径**——
   * 对后者几何否定式无从判起（骨架里啥都没有 ≠ 图里没有），所有几何判据必须先看这个开关，
   * 否则「结果含 \sqrt 而骨架无根号」会对 660 张里的每一次正确识别集体误报。
   */
  lineSignals: number;
}

function attrOf(tag: string, name: string): number | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*"(-?[\\d.]+)"`, 'i').exec(tag);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/**
 * 解析公式 SVG 骨架（只看几何，不认字符；`<text>` 不存在的站点产物正是本项目遇到的形态）。
 */
export function parseFormulaSkeleton(svg: string): FormulaSkeleton {
  const skeleton: FormulaSkeleton = { fractionBars: 0, radical: false, rows: 0, glyphGroups: 0, lineSignals: 0 };
  if (typeof svg !== 'string' || svg === '') return skeleton;

  const lines: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
  for (const match of svg.matchAll(/<line\b([^>]*)>/gi)) {
    const tag = match[1] ?? '';
    const x1 = attrOf(tag, 'x1');
    const y1 = attrOf(tag, 'y1');
    const x2 = attrOf(tag, 'x2');
    const y2 = attrOf(tag, 'y2');
    if (x1 === null || y1 === null || x2 === null || y2 === null) continue;
    lines.push({ x1, y1, x2, y2 });
  }
  skeleton.lineSignals = lines.length;
  /** 斜/竖笔（|dy|>3）：根号的斜杠与端部立笔；分式横线不在此列 */
  const strokes = lines.filter((line) => Math.abs(line.y2 - line.y1) > 3);
  /** 横笔够长（分数线/根号横梁**同形**：dy≈0 且 dx>3） */
  const horizontals = lines.filter((line) => Math.abs(line.y2 - line.y1) <= 1 && Math.abs(line.x2 - line.x1) > 3);
  /**
   * 区分「根号横梁」与「分数线」：真库实测（组卷 35555640 六张公式）——
   * 根号 = 斜杠 + 端部短笔 + 横梁**首尾相接**（横梁起点 = 短笔终点）；
   * 分式横线则**独立成线**（不与任何斜/竖笔共用端点）。
   * （旧判据「横线是否接竖笔」是错的：组卷根号的斜杠并非竖直 → 根号一律认不出，
   *   导致「结果含 \sqrt 而骨架无根号」把每一次正确识别都误报成需复核。）
   */
  const sharesEndpoint = (
    bar: { x1: number; y1: number; x2: number; y2: number },
    stroke: { x1: number; y1: number; x2: number; y2: number },
  ): boolean => {
    const barEnds = [[bar.x1, bar.y1], [bar.x2, bar.y2]];
    const strokeEnds = [[stroke.x1, stroke.y1], [stroke.x2, stroke.y2]];
    return barEnds.some(([bx, by]) => strokeEnds.some(([sx, sy]) => Math.abs(bx - sx) <= 2 && Math.abs(by - sy) <= 2));
  };
  for (const bar of horizontals) {
    if (strokes.some((stroke) => sharesEndpoint(bar, stroke))) skeleton.radical = true;   // 根号横梁
    else skeleton.fractionBars += 1;                                                      // 分数线
  }

  const ys: number[] = [];
  for (const match of svg.matchAll(/<g\b[^>]*\btransform\s*=\s*"translate\(\s*(-?[\d.]+)\s*[, ]\s*(-?[\d.]+)/gi)) {
    const y = Number(match[2]);
    if (!Number.isFinite(y)) continue;
    skeleton.glyphGroups += 1;
    ys.push(y);
  }
  const distinctRows = new Set(ys.map((y) => Math.round(y / 4)));   // 4px 容差聚类成行
  skeleton.rows = distinctRows.size;
  return skeleton;
}

export interface FormulaQaResult {
  /** 人读告警（弹层展示；空数组 = 未发现机械矛盾） */
  flags: string[];
}

/** 结果文本里的「可读规模」：剥掉命令后剩下的字符数（粗估；用于与骨架字符数对拍） */
function visibleCharCount(tex: string): number {
  return tex
    .replace(/\\[a-zA-Z]+/g, '')       // \frac \sin …
    .replace(/[{}\\]/g, '')
    .replace(/\s+/g, '')
    .length;
}

/**
 * 否定式校验（参考 §2.4）：结果里出现骨架不支持的结构 → 标记可疑。
 * 只报「骨架没有、结果却说有」的方向；骨架有而结果没用（少识别）不在此判——那属漏识别，
 * 由字符数対拍兜（`glyphGroups` 远多于结果规模时提示可能漏识别）。
 */
export function checkFormulaAgainstSkeleton(tex: string, skeleton: FormulaSkeleton): FormulaQaResult {
  const flags: string[] = [];
  if (tex === '') return { flags };
  const hasFrac = /\\[dt]?frac|\\over|\\dfrac|\\tfrac/.test(tex);
  const hasSqrt = /\\sqrt/.test(tex);

  // 几何否定式只在**该图确有线状信号**时成立：660/760 张站点 SVG 把根号/分式画成路径，
  // 骨架里「没有根号」只是没信号，不是图里没有——对这种图一律不判，避免把正确结果误报成可疑。
  if (skeleton.lineSignals > 0) {
    if (hasFrac && skeleton.fractionBars === 0) flags.push('骨架里没有分数线，但结果含分式（\\frac）——疑幻觉');
    if (hasSqrt && !skeleton.radical) flags.push('骨架里没有根号结构，但结果含 \\sqrt——疑幻觉');
  }
  const visible = visibleCharCount(tex);
  if (skeleton.glyphGroups > 0 && visible > skeleton.glyphGroups * 3 + 4) {
    flags.push(`结果规模（约 ${visible} 字符）远超骨架字符分组数（${skeleton.glyphGroups}）——疑长文本幻觉`);
  }
  if (skeleton.glyphGroups >= 6 && visible > 0 && visible * 4 < skeleton.glyphGroups) {
    flags.push(`结果规模（约 ${visible} 字符）远小于骨架字符分组数（${skeleton.glyphGroups}）——疑漏识别`);
  }
  return { flags };
}

/** 输出清洗结果 */
export interface SanitizedFormula {
  tex: string;
  /** 清洗动作（人读；进台账/弹层便于追因） */
  notes: string[];
}

/** 去代码围栏（```latex … ```） */
function stripCodeFence(raw: string): { text: string; changed: boolean } {
  const fenced = /^\s*```[a-zA-Z]*\s*\n?([\s\S]*?)\n?\s*```\s*$/.exec(raw);
  if (fenced) return { text: fenced[1] ?? '', changed: true };
  return { text: raw, changed: false };
}

/** MathML 回包取 `alttext`（参考 §2.2：模型偶尔回 MathML，alttext 最干净） */
function extractAltText(raw: string): { text: string; changed: boolean } {
  const match = /alttext\s*=\s*"([^"]*)"/i.exec(raw);
  if (!match) return { text: raw, changed: false };
  const unescaped = (match[1] ?? '')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
  return { text: unescaped, changed: true };
}

/** 剥掉**整体**包裹的 `\[ … \]` / `\( … \)`（只剥一层；多段混排不动——留给定界符归一路径） */
function stripWrappingDelimiters(raw: string): { text: string; changed: boolean } {
  const trimmed = raw.trim();
  const paired = /^\\\[([\s\S]*)\\\]$/.exec(trimmed) ?? /^\\\(([\s\S]*)\\\)$/.exec(trimmed);
  if (paired) return { text: (paired[1] ?? '').trim(), changed: true };
  return { text: raw, changed: false };
}

/** 去掉尾部多余大括号（参考 §2.2「尾部多余大括号」；只在括号数不平衡时剥） */
function trimUnbalancedBraces(raw: string): { text: string; changed: boolean } {
  let text = raw.trim();
  let changed = false;
  const balance = (value: string): number =>
    (value.match(/\{/g)?.length ?? 0) - (value.match(/\}/g)?.length ?? 0);
  while (balance(text) < 0 && text.endsWith('}')) {
    text = text.slice(0, -1).trimEnd();
    changed = true;
  }
  return { text, changed };
}

/**
 * 结果清洗（参考 §2.2 输出清洗顺序 + §2.5 幻觉剥离）：
 * 去代码围栏 → 取 MathML alttext → 剥整体定界 → 去 `{\displaystyle` → 剥方括号幻觉 → 去多余尾括号。
 */
export function sanitizeFormulaTex(raw: string): SanitizedFormula {
  const notes: string[] = [];
  let text = (raw ?? '').trim();

  const fence = stripCodeFence(text);
  if (fence.changed) { text = fence.text.trim(); notes.push('去代码围栏'); }

  const alt = extractAltText(text);
  if (alt.changed) { text = alt.text.trim(); notes.push('取 MathML alttext'); }

  const wrap = stripWrappingDelimiters(text);
  if (wrap.changed) { text = wrap.text; notes.push('剥整体定界符'); }

  if (/\{\s*\\displaystyle/.test(text) || /\\displaystyle/.test(text)) {
    text = text.replace(/\{\s*\\displaystyle\s*/g, '{').replace(/\\displaystyle\s*/g, '');
    notes.push('去 \\displaystyle');
  }

  const bracket = /^\[([A-Za-z0-9_{}\\]+)\]$/.exec(text.trim());
  if (bracket) { text = bracket[1] ?? ''; notes.push('剥方括号幻觉'); }

  // 返工⑧：裸 `<` / `>` → `\lt` / `\gt`。
  // 真机现场（用户 2026-09-24 第二道样题）：选项 `t'<t` 在对照弹层显示成 `t' &lt; t`——
  // `<` 写进 `data-tex` 属性时被转义成 `&lt;`，而渲染链读出的仍是实体原文（KaTeX 只看到 `lt;`）。
  // LaTeX 里用 `\lt`/`\gt` 是等价写法且**不含 HTML 特殊字符**，整条链（属性/渲染/编辑）都不再需要转义。
  if (/[<>]/.test(text)) {
    text = text.replace(/(?<!\\)</g, '\\lt ').replace(/(?<!\\)>/g, '\\gt ');
    notes.push('裸 < > 换 \\lt \\gt');
  }

  const braces = trimUnbalancedBraces(text);
  if (braces.changed) { text = braces.text; notes.push('去多余尾括号'); }

  return { tex: text.trim(), notes };
}

/**
 * 垃圾/幻觉形态判据（参考 §2.5）：命中即**判该图失败**（保留原图、记账原因），绝不写进 data-tex。
 * 返回 null = 通过。
 */
export function hallucinationReason(tex: string): string | null {
  const text = (tex ?? '').trim();
  if (text === '') return '引擎返回空公式';
  if (/[\r\n]/.test(text)) return '结果含换行（长文本幻觉形态）';
  if (/\[Image|\[Figure|as an AI|I cannot/i.test(text)) return '结果含描述性短语（非公式）';
  if (/^(?:latex|tex|math|公式|formula)$/i.test(text)) return '结果不是公式（回显了提示词词元）';
  if (text.length > 80) return `结果过长（${text.length} 字符 > 80）——疑长文本幻觉`;
  return null;
}
