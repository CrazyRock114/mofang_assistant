// 0040 P1：图块坐标管线（纯函数，无 IO）。
//
// 分工硬约束（0042 纪要 §八.3）：**坐标是 OCR 的独占能力**——图块定位默认走 DeepSeek-OCR
// grounding 双模板（模型无关、免费、1~5s）；主模型内联 bbox 只作兜底腿（显式降级 + 对账）。
// 单模板不可靠（v1 在紧凑竞赛排版退化为纯转写 0 图块；官方模板在旧样本漏检/多检图注），
// 故并行双模板取并集 → 面积过滤 → IoU 去重（保大）→ 阅读序重编号。
//
// 坐标换算：模型侧 0-999 归一 → 本工程统一 0~1 归一（与 box-model normalizeRect 同口径）。

import type { OnestepBBox, OnestepFigure, OnestepFigureSource } from '../../shared/contracts/onestep-types.js';
import { FIGURE_DEDUP_IOU, MIN_FIGURE_AREA_999 } from './prompts.js';
import type { RawFigureBox } from './parse.js';

/** DSO grounding 原始区域行（label + 0-999 框） */
export interface DsoRegion {
  label: string;
  box999: [number, number, number, number];
}

/**
 * DSO grounding 输出 → 区域行（0-999 归一口径，实测拟合确认）。
 * 逐字移植 POC `common.dso_regions`：匹配 `<|ref|>…<|/ref|><|det|>[[x1,y1,x2,y2]]`。
 */
export function dsoRegions(raw: string): DsoRegion[] {
  // 用字符串构造（模式里含 `<|/ref|>`，字面量需转义斜杠，构造式更不易写错）
  const re = new RegExp(
    '<\\|ref\\|>(.*?)<\\|/ref\\|>\\s*<\\|det\\|>\\s*\\[\\s*\\[\\s*([\\d.]+)\\s*,\\s*([\\d.]+)\\s*,\\s*([\\d.]+)\\s*,\\s*([\\d.]+)\\s*\\]\\s*\\]',
    'g',
  );
  const out: DsoRegion[] = [];
  for (const m of raw.matchAll(re)) {
    out.push({
      label: m[1] ?? '',
      box999: [Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])],
    });
  }
  return out;
}

/** 只取图片类区域（label 含 image/图），按阅读顺序（先上后左）排序 */
export function dsoImageBoxes(raw: string): RawFigureBox[] {
  const boxes = dsoRegions(raw)
    .filter((r) => r.label.toLowerCase().includes('image') || r.label.includes('图'))
    .sort((a, b) => (a.box999[1] - b.box999[1]) || (a.box999[0] - b.box999[0]));
  return boxes.map((r, i) => ({ ref: `图${i + 1}`, bbox999: r.box999 }));
}

export function area999(box: [number, number, number, number]): number {
  return Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);
}

export function iou999(a: [number, number, number, number], b: [number, number, number, number]): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = area999(a) + area999(b) - inter;
  return union > 0 ? inter / union : 0;
}

/** 0-999 → 0~1 归一（越界裁剪；退化框按 0 宽高收口，不产负值） */
export function box999ToNorm(box: [number, number, number, number]): OnestepBBox {
  const clamp = (v: number) => Math.min(1, Math.max(0, v / 999));
  const x1 = clamp(box[0]);
  const y1 = clamp(box[1]);
  const x2 = clamp(box[2]);
  const y2 = clamp(box[3]);
  return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
}

/** 0~1 → 0-999（回填内联腿/写回对账时用；取整避免浮点误差在往返中累积） */
export function normToBox999(box: OnestepBBox): [number, number, number, number] {
  return [Math.round(box[0] * 999), Math.round(box[1] * 999), Math.round(box[2] * 999), Math.round(box[3] * 999)];
}

export interface MergeFigureOptions {
  /** 是否施加面积下限（DSO 需过滤图注噪点；内联兜底腿不过滤，宁可多给也不静默缺） */
  applyAreaFilter: boolean;
}

/**
 * 多模板并集 → 面积过滤 → 重叠去重（保大的）→ 阅读序重编号（逐字移植 POC `merge_fig_boxes`）。
 * 输出 ref 统一为「图1..图N」，bbox 已换算到 0~1 归一。
 */
export function mergeFigureBoxes(lists: RawFigureBox[][], options: MergeFigureOptions): OnestepFigure[] {
  const cand: RawFigureBox[] = [];
  for (const list of lists) {
    for (const box of list) {
      if (options.applyAreaFilter && area999(box.bbox999) < MIN_FIGURE_AREA_999) continue;
      cand.push(box);
    }
  }
  cand.sort((a, b) => area999(b.bbox999) - area999(a.bbox999));
  const kept: RawFigureBox[] = [];
  for (const box of cand) {
    if (kept.every((k) => iou999(box.bbox999, k.bbox999) < FIGURE_DEDUP_IOU)) kept.push(box);
  }
  kept.sort((a, b) => (a.bbox999[1] - b.bbox999[1]) || (a.bbox999[0] - b.bbox999[0]));
  return kept.map((k, i) => ({ ref: `图${i + 1}`, bbox: box999ToNorm(k.bbox999) }));
}

// ==================== 题面占位符对账 ====================

/** 题面 `[图N]` 引用编号（升序去重；N 从 1 起） */
export function figureRefsInMarkdown(markdown: string): number[] {
  const nums = new Set<number>();
  for (const m of markdown.matchAll(/\[图\s*(\d+)\]/g)) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && n > 0) nums.add(n);
  }
  return [...nums].sort((a, b) => a - b);
}

export interface ReconcileFiguresInput {
  /** DSO 双模板原始输出（0-999；模板 A/B 各一份） */
  dsoRawOutputs: string[];
  /** 主模型内联 figures（0-999，兜底腿） */
  inlineBoxes: RawFigureBox[];
  /** 题面 [图N] 引用编号 */
  placeholderRefs: number[];
}

export interface ReconcileFiguresResult {
  figures: OnestepFigure[];
  source: OnestepFigureSource;
  warnings: string[];
}

/**
 * 0069（R-075，只增可选）：告警文案的场景覆盖——录题侧是「题面 + 左栏手动框选」，
 * 答案/解析抠图链（AI 整理）没有左栏，需换成编辑器口径。**缺省值 = 既有文案逐字不变**。
 */
export interface ReconcileFiguresOptions {
  /** 占位符所在区域的称谓（缺省「题面」） */
  label?: string;
  /** 未被覆盖的 [图N] 的处置提示（缺省「不静默留占位：请用左栏手动框选补图」） */
  uncoveredHint?: string;
}

/**
 * 图块来源对账（0042 §十第三/四轮加固口径，显式降级不静默）：
 *   ① DSO 双模板并集为主；② DSO 无出图 → 回落内联框并标注来源；
 *   ③ DSO 数量不足占位符数 → 按序用内联框补齐（标 mixed）；
 *   ④ 未被覆盖的 [图N] 显式告警（严禁静默留占位）。
 */
export function reconcileFigures(
  input: ReconcileFiguresInput,
  options: ReconcileFiguresOptions = {},
): ReconcileFiguresResult {
  const label = options.label ?? '题面';
  const uncoveredHint = options.uncoveredHint ?? '不静默留占位：请用左栏手动框选补图';
  const dsoMerged = mergeFigureBoxes(
    input.dsoRawOutputs.map((raw) => dsoImageBoxes(raw)),
    { applyAreaFilter: true },
  );
  const inlineMerged = mergeFigureBoxes([input.inlineBoxes], { applyAreaFilter: false });
  const needed = input.placeholderRefs.length > 0 ? Math.max(...input.placeholderRefs) : 0;
  const warnings: string[] = [];

  let figures: OnestepFigure[] = [];
  let source: OnestepFigureSource = 'none';

  if (dsoMerged.length === 0 && inlineMerged.length === 0) {
    source = 'none';
    warnings.push('图块坐标来源：无（DeepSeek-OCR 与主模型内联框均未出图）');
  } else if (dsoMerged.length === 0) {
    source = 'inline';
    figures = inlineMerged;
    warnings.push(
      `图块坐标来源：主模型内联补齐 ${inlineMerged.length} 个（DeepSeek-OCR 未出图，已显式降级；内联坐标口径较弱，请人工确认）`,
    );
  } else if (dsoMerged.length >= needed || inlineMerged.length <= dsoMerged.length) {
    source = 'dso';
    figures = dsoMerged;
    warnings.push(`图块坐标来源：DeepSeek-OCR 定位 ${dsoMerged.length} 个`);
  } else {
    // DSO 有出图但数量不足占位符数 → 按序内联补齐（不覆盖 DSO 已定位的框）
    const extra = inlineMerged.slice(dsoMerged.length, needed);
    figures = [...dsoMerged, ...extra].map((f, i) => ({ ref: `图${i + 1}`, bbox: f.bbox }));
    source = 'mixed';
    warnings.push(
      `图块坐标来源：DeepSeek-OCR 定位 ${dsoMerged.length} 个 + 主模型内联补齐 ${extra.length} 个`,
    );
  }

  const covered = new Set(figures.map((_, i) => i + 1));
  const uncovered = input.placeholderRefs.filter((n) => !covered.has(n));
  if (uncovered.length > 0) {
    warnings.push(
      `${label} [${uncovered.map((n) => `图${n}`).join('、')}] 未配到图块（${uncoveredHint}）`,
    );
  }
  if (needed > 0 && figures.length > needed) {
    warnings.push(`检出 ${figures.length} 个图块但${label}只有 ${needed} 个 [图N] 占位（多出部分未使用）`);
  }
  return { figures, source, warnings };
}

/** 题面 [图N] → 顺序编号（不含 ref 字符串；裁图时按序号取 figures[i]） */
export function figurePlaceholderIndexes(markdown: string): number[] {
  const out: number[] = [];
  for (const m of markdown.matchAll(/\[图\s*(\d+)\]/g)) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && n > 0) out.push(n);
  }
  return out;
}
