// 0036 P2：框模型（纯函数域，零 DOM 依赖——渲染层画框与主进程/测试共用同一份几何）
//
// 坐标口径：**归一化 0..1**（相对页图像素尺寸）。页图缩放、渲染策略更换、DPI 差异都不影响已画框，
// 裁剪时由 denormalizeRect 乘回像素。任务书 §一 P2 的框模型 {type,page,x,y,w,h} + qid 分组键。
//
// 本文件不碰 canvas / fs / electron：画框交互（pointer 事件→归一化矩形）、选中判定、撤销栈
// 全部是可以直接单测的纯逻辑。

import type { SplitBox, SplitBoxType, SplitRunLink } from '../../shared/contracts/split-types.js';
import { SPLIT_BOX_TYPES } from '../../shared/contracts/split-types.js';

/** 归一化最小边长：再小的框多半是误点（约 0.4% 页宽），不生成也不允许缩到 0 */
export const BOX_MIN_SIZE = 0.004;
/** 撤销栈深度：任务书要求 ≥20 步；对齐对标竞品 50 步 */
export const UNDO_LIMIT = 50;
/** 裁剪留白（页宽比例）：框贴字太紧会把靠近边框的字符切掉，四周各放 0.4% */
export const CROP_PADDING = 0.004;

export interface Point {
  x: number;
  y: number;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface PageSize {
  /** 页图像素宽 */
  w: number;
  /** 页图像素高 */
  h: number;
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function isSplitBoxType(value: string): value is SplitBoxType {
  return (SPLIT_BOX_TYPES as readonly string[]).includes(value);
}

/** 像素矩形 → 归一化（越界部分夹回页内；宽高为负时归零，不产生反向矩形） */
export function normalizeRect(rect: Rect, page: PageSize): Rect {
  if (page.w <= 0 || page.h <= 0) return { x: 0, y: 0, w: 0, h: 0 };
  const x = clamp01(rect.x / page.w);
  const y = clamp01(rect.y / page.h);
  const w = Math.max(0, Math.min(clamp01((rect.x + rect.w) / page.w) - x));
  const h = Math.max(0, Math.min(clamp01((rect.y + rect.h) / page.h) - y));
  return { x, y, w, h };
}

/** 归一化矩形 → 像素（渲染层画框/裁剪都走它，保证与 normalizeRect 严格互逆） */
export function denormalizeRect(rect: Rect, page: PageSize): Rect {
  return { x: rect.x * page.w, y: rect.y * page.h, w: rect.w * page.w, h: rect.h * page.h };
}

/**
 * 拖拽起止点（像素）→ 归一化矩形；小于最小边长返回 null（调用方据此忽略这次拖拽）。
 * 支持任意方向拖拽：起点在右下、终点在左上同样成立。
 */
export function rectFromDrag(start: Point, end: Point, page: PageSize): Rect | null {
  const px: Rect = {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    w: Math.abs(end.x - start.x),
    h: Math.abs(end.y - start.y),
  };
  const norm = normalizeRect(px, page);
  if (norm.w < BOX_MIN_SIZE || norm.h < BOX_MIN_SIZE) return null;
  return norm;
}

export function boxRect(box: SplitBox): Rect {
  return { x: box.x, y: box.y, w: box.w, h: box.h };
}

/** 点（归一化）是否落在框内 */
export function containsPoint(box: SplitBox, point: Point): boolean {
  return point.x >= box.x && point.x <= box.x + box.w && point.y >= box.y && point.y <= box.y + box.h;
}

/** 交集面积（用于找「点中哪个框」的最小包围者） */
function intersectionArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * 命中判定：返回包含该点的框。多个框重叠时取**面积最小**的那个——
 * 用户在大框里画了小框（题干框里圈一段公式）时，点在小框上应选中小框。
 */
export function hitTest(boxes: SplitBox[], page: number, point: Point): SplitBox | null {
  let best: SplitBox | null = null;
  for (const box of boxes) {
    if (box.page !== page) continue;
    if (!containsPoint(box, point)) continue;
    if (!best || box.w * box.h < best.w * best.h) best = box;
  }
  return best;
}

/** 平移（归一化增量；整框夹回页内，宽高不变——拖出边界时贴边而不是变形） */
export function moveBox(box: SplitBox, dx: number, dy: number): SplitBox {
  const x = Math.min(Math.max(0, box.x + dx), 1 - box.w);
  const y = Math.min(Math.max(0, box.y + dy), 1 - box.h);
  return { ...box, x, y };
}

/** 缩放手柄（四角 + 四边） */
export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

/**
 * 按手柄拖动缩放：被拖的对边固定不动，越界即夹住；缩到最小边长以下即停在该边长（不翻转）。
 */
export function resizeBox(box: SplitBox, handle: ResizeHandle, point: Point): SplitBox {
  const left = box.x;
  const top = box.y;
  const right = box.x + box.w;
  const bottom = box.y + box.h;

  let x0 = left;
  let y0 = top;
  let x1 = right;
  let y1 = bottom;

  if (handle.includes('w')) x0 = Math.min(point.x, right - BOX_MIN_SIZE);
  if (handle.includes('e')) x1 = Math.max(point.x, left + BOX_MIN_SIZE);
  if (handle.includes('n')) y0 = Math.min(point.y, bottom - BOX_MIN_SIZE);
  if (handle.includes('s')) y1 = Math.max(point.y, top + BOX_MIN_SIZE);

  const cx0 = clamp01(x0);
  const cy0 = clamp01(y0);
  const cx1 = clamp01(x1);
  const cy1 = clamp01(y1);

  return {
    ...box,
    x: cx0,
    y: cy0,
    w: Math.max(BOX_MIN_SIZE, cx1 - cx0),
    h: Math.max(BOX_MIN_SIZE, cy1 - cy0),
  };
}

export function boxesOnPage(boxes: SplitBox[], page: number): SplitBox[] {
  return boxes.filter((b) => b.page === page);
}

export function boxesOfQuestion(boxes: SplitBox[], qid: string): SplitBox[] {
  return boxes.filter((b) => b.qid === qid);
}

/** 题目组 id 列表（保持首次出现顺序＝用户画框顺序） */
export function questionIds(boxes: SplitBox[]): string[] {
  const out: string[] = [];
  for (const b of boxes) if (!out.includes(b.qid)) out.push(b.qid);
  return out;
}

/** 下一个题目组 id：q{n}，取已用序号最大值 +1（删题后不复用号，避免与已发起 run 的溯源串号） */
export function nextQuestionId(boxes: SplitBox[]): string {
  let max = 0;
  for (const id of questionIds(boxes)) {
    const m = id.match(/^q(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `q${max + 1}`;
}

/** 框 id：稳定且可读（页号 + 序号），便于测试断言与日志定位 */
export function makeBoxId(page: number, seq: number): string {
  return `p${page}-b${seq}`;
}

/** 已用框 id 的最大序号（新增框续号用） */
export function nextBoxSeq(boxes: SplitBox[]): number {
  let max = 0;
  for (const b of boxes) {
    const m = b.id.match(/-b(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

export function unionRect(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** 单页裁剪计划（像素坐标，已夹回页内并含留白） */
export interface CropPlan {
  page: number;
  rect: Rect;
}

/**
 * 一题一 run 的裁剪计划（P3「裁剪本地做、只送小图」）：
 * 该题**全部类型的框**（题干/配图/答案）按页各自取并集 → 每页一张裁剪小图，
 * 也就是一次 run 的多个 page 素材。答案框并进来的理由：识别要连答案解析一起出，
 * 只送题干等于让模型凭空编答案。
 *
 * @param boxes 该题的框（调用方已按 qid 过滤）
 * @param pageSizes 页号 → 页图像素尺寸（缺该页尺寸则跳过该页，宁可少送也不送错坐标）
 */
export function cropPlansForQuestion(
  boxes: SplitBox[],
  pageSizes: Map<number, PageSize>,
  padding = CROP_PADDING,
): CropPlan[] {
  const byPage = new Map<number, Rect[]>();
  for (const box of boxes) {
    const list = byPage.get(box.page);
    if (list) list.push(boxRect(box));
    else byPage.set(box.page, [boxRect(box)]);
  }

  const plans: CropPlan[] = [];
  for (const page of [...byPage.keys()].sort((a, b) => a - b)) {
    const size = pageSizes.get(page);
    if (!size) continue;
    const union = unionRect(byPage.get(page) ?? []);
    if (!union) continue;
    const px = denormalizeRect(union, size);
    const padX = size.w * padding;
    const padY = size.h * padding;
    const x0 = Math.max(0, Math.floor(px.x - padX));
    const y0 = Math.max(0, Math.floor(px.y - padY));
    const x1 = Math.min(size.w, Math.ceil(px.x + px.w + padX));
    const y1 = Math.min(size.h, Math.ceil(px.y + px.h + padY));
    if (x1 - x0 < 1 || y1 - y0 < 1) continue;
    plans.push({ page, rect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } });
  }
  return plans;
}

// ==================== 撤销栈（纯值，不可变快照） ====================

export interface UndoStack<T> {
  /** 提交新状态（清空重做栈） */
  push(next: T): void;
  /** 回退一步；无可退返回 null */
  undo(): T | null;
  /** 重做一步；无可重做返回 null */
  redo(): T | null;
  canUndo(): boolean;
  canRedo(): boolean;
  present(): T;
  /** 可回退步数（测试/UI 灰显用） */
  undoDepth(): number;
}

/**
 * 定长撤销栈：任务书要求撤销 ≥20 步，取 50（对齐竞品）。
 * 只存快照不存 diff——框数量级是几十，快照比 diff 简单且不会算错。
 */
export function createUndoStack<T>(initial: T, limit = UNDO_LIMIT): UndoStack<T> {
  const depth = Math.max(1, limit);
  const past: T[] = [];
  const future: T[] = [];
  let current = initial;

  return {
    push(next: T): void {
      past.push(current);
      current = next;
      if (past.length > depth) past.shift();
      future.length = 0;
    },
    undo(): T | null {
      const prev = past.pop();
      if (prev === undefined) return null;
      future.push(current);
      current = prev;
      return current;
    },
    redo(): T | null {
      const next = future.pop();
      if (next === undefined) return null;
      past.push(current);
      current = next;
      return current;
    },
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    present: () => current,
    undoDepth: () => past.length,
  };
}

// ==================== 识别进度 / 锁定语义 ====================

/**
 * 识别完成后**课程与框锁定**（任务书 §一 P3；D-052 文案口径：锁定是状态词不是错误词）。
 * 锁定条件：该题的 run 已 done（识别产出齐备）。失败/取消不锁——用户要能改框重试。
 */
export function isQuestionLocked(runs: SplitRunLink[], qid: string): boolean {
  const run = runs.find((r) => r.qid === qid);
  return run !== undefined && run.status === 'done';
}

/** 段内是否还有在跑的 run（决定「识别本段」按钮是否可再点） */
export function hasActiveRun(runs: SplitRunLink[]): boolean {
  return runs.some((r) => r.status === 'creating' || r.status === 'queued' || r.status === 'ocr' || r.status === 'ai');
}

// ==================== 快捷键（纯映射，供 UI 与测试共用一个真源） ====================

export type SplitShortcut = 'delete' | 'undo' | 'redo' | 'next-question' | 'prev-question' | 'escape';

export interface ShortcutInput {
  key: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

/**
 * 快捷键映射（任务书 §一 P2「删除/撤销/下一题」）：
 *   Delete/Backspace=删框、Ctrl+Z=撤销、Ctrl+Shift+Z / Ctrl+Y=重做、↑↓=上/下一题、Esc=取消
 * 输入态（改名输入框）由调用方先判——这里只做键位判定，不猜焦点。
 */
export function shortcutOf(input: ShortcutInput): SplitShortcut | null {
  const mod = input.ctrl === true || input.meta === true;
  const key = input.key;
  if (key === 'Escape') return 'escape';
  if (mod && (key === 'z' || key === 'Z')) return input.shift ? 'redo' : 'undo';
  if (mod && (key === 'y' || key === 'Y')) return 'redo';
  if (key === 'Delete' || key === 'Backspace') return 'delete';
  if (!mod && (key === 'ArrowDown' || key === 'PageDown')) return 'next-question';
  if (!mod && (key === 'ArrowUp' || key === 'PageUp')) return 'prev-question';
  return null;
}
