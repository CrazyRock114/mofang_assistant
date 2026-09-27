// 0040 返工④（2026-09-20 目检）：选项结构化兜底。
//
// 病因：一步到位提示词第 4 条要求 `options` 数组，0042 留档的 230 份原始响应里选项题一律
// `options: null`，选项文字被模型写进了 stemMarkdown 正文（「A．… B．…」）。前端于是把选项
// 当普通段落渲染——用户看到「选项以纯文本呈现」。
//
// 口径：**只在模型没给结构化 options 时兜底**（有结构化输出就用模型的，不去猜）；
// 还原必须满足可证伪的形状条件（标号从 A 起连续、≥2 项、每项内容非空且不太长），
// 任一不满足就放弃还原、保留原文并留告警——宁可平铺，不可错拆（错拆会改题面语义）。

import type { OnestepOption } from '../../shared/contracts/onestep-types.js';

/** 标号上限（A~J）：再多就不是选项了，多半是正文里的字母 */
const MAX_OPTIONS = 10;
/** 单项内容长度上限（超过说明把后文段落也吞进来了 → 放弃还原） */
const MAX_OPTION_CONTENT_CHARS = 400;

/**
 * 选项标号：行首/空白后的 A~H（**含全角 Ａ~Ｈ**——中文卷面/OCR 常态），
 * 后随 `. ．、: ：` 或右括号（（A）形态）。
 */
const OPTION_MARKER = /(^|\n|\s)[（(]?([A-HＡ-Ｈ])(?:[）)]|[.．、:：])\s*/g;

/** 全角拉丁字母 → 半角（Ａ U+FF21 → A） */
function toHalfWidthLabel(label: string): string {
  const code = label.charCodeAt(0);
  return code >= 0xff21 && code <= 0xff3a ? String.fromCharCode(code - 0xfee0) : label;
}

/** 数学环境内的字母不是选项标号（$A. $ / \alpha 之类） */
function inMath(text: string, index: number): boolean {
  let dollars = 0;
  for (let i = 0; i < index; i++) if (text[i] === '$') dollars += 1;
  return dollars % 2 === 1;
}

interface Marker {
  label: string;
  /** 标号 token 的起止（含前导空白之外的部分） */
  start: number;
  end: number;
}

function scanMarkers(text: string): Marker[] {
  const out: Marker[] = [];
  OPTION_MARKER.lastIndex = 0;
  for (let hit = OPTION_MARKER.exec(text); hit !== null; hit = OPTION_MARKER.exec(text)) {
    const lead = hit[1] ?? '';
    const label = toHalfWidthLabel(hit[2] ?? '');
    const start = hit.index + lead.length;
    if (inMath(text, start)) continue;
    out.push({ label, start, end: OPTION_MARKER.lastIndex });
  }
  return out;
}

export interface ExtractedOptions {
  /** 去掉选项块之后的题干原文 */
  stem: string;
  options: OnestepOption[];
}

/**
 * 题干里「A．… B．…」形态的选项块 → 结构化选项 + 干净的题干。
 * 识别不出可证伪的选项块时返回 null（调用方保留原文）。
 */
export function extractOptionsFromStem(markdown: string): ExtractedOptions | null {
  const markers = scanMarkers(markdown);
  if (markers.length < 2) return null;

  // 找最长的一段「从 A 起严格连续」的标号链（模型偶尔把答案行也写成 A. 开头）
  let best: Marker[] = [];
  let chain: Marker[] = [];
  for (const marker of markers) {
    const expected = String.fromCharCode(65 + chain.length);
    if (marker.label === expected) {
      chain.push(marker);
    } else if (marker.label === 'A') {
      chain = [marker];
    } else {
      chain = [];
    }
    if (chain.length > best.length) best = [...chain];
  }
  if (best.length < 2 || best.length > MAX_OPTIONS) return null;

  const first = best[0]!;
  const head = markdown.slice(0, first.start).trim();
  // 选项块之前必须有题干（否则整段都是选项 → 拆完题干就空了，按规则 ① 反而是坏数据）
  if (head === '') return null;

  const options: OnestepOption[] = [];
  for (let i = 0; i < best.length; i++) {
    const marker = best[i]!;
    const until = i + 1 < best.length ? best[i + 1]!.start : markdown.length;
    const content = markdown.slice(marker.end, until).replace(/\s*\n\s*/g, ' ').trim();
    if (content === '' || content.length > MAX_OPTION_CONTENT_CHARS) return null;
    options.push({ label: marker.label, content });
  }

  return { stem: head, options };
}

/**
 * 模型既给了结构化 `options`、又把选项行留在题干末尾时，把这段重复尾巴去掉。
 * 只删「标号链与结构化选项逐个相同」的尾部块（可证伪），其余一概不动。
 */
export function stripDuplicateOptionTail(markdown: string, options: OnestepOption[]): string {
  if (options.length < 2) return markdown;
  const markers = scanMarkers(markdown);
  if (markers.length < options.length) return markdown;
  const labels = options.map((o) => o.label);
  for (let start = 0; start + labels.length <= markers.length; start++) {
    const slice = markers.slice(start, start + labels.length);
    if (!slice.every((marker, i) => marker.label === labels[i])) continue;
    const head = markdown.slice(0, slice[0]!.start).trim();
    // 整段都是选项（题干为空）→ 不动：那不是「重复尾巴」，是题干本身缺了
    if (head === '') return markdown;
    return head;
  }
  return markdown;
}
