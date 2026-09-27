// 0040 P3/P4：工作台框选/图块微调的几何（纯函数，零 DOM）。
//
// 复用 0036 `src/recog/splitting/box-model.ts` 的归一化坐标几何（任务书 §一「几何复用」）：
// 归一化口径、最小边长、拖拽起止点成框、平移夹边、手柄缩放全部走既有纯函数；
// 本文件只做「WorkbenchRect ↔ SplitBox 形状适配」与工作台特有的一层封装。

import type { SplitBox } from '../../shared/contracts/split-types.js';
import type { WorkbenchRect } from '../../shared/contracts/onestep-types.js';
import {
  BOX_MIN_SIZE, clamp01, denormalizeRect, moveBox, normalizeRect, rectFromDrag, resizeBox,
  type PageSize, type Point, type ResizeHandle,
} from '../../recog/splitting/box-model.js';

export type { Point, ResizeHandle, PageSize };
export { BOX_MIN_SIZE, clamp01, denormalizeRect, normalizeRect, rectFromDrag };

/** 归一化矩形 + 页号 → SplitBox 形状（只为复用 box-model 的纯几何；无落库语义） */
export function toSplitBox(rect: WorkbenchRect, page: number): SplitBox {
  return { id: 'wb', qid: 'wb', type: 'text', page, x: rect.x, y: rect.y, w: rect.w, h: rect.h };
}

export function fromSplitBox(box: SplitBox): WorkbenchRect {
  return { x: box.x, y: box.y, w: box.w, h: box.h };
}

/** 平移（整框夹回页内，宽高不变） */
export function moveRect(rect: WorkbenchRect, dx: number, dy: number, page = 1): WorkbenchRect {
  return fromSplitBox(moveBox(toSplitBox(rect, page), dx, dy));
}

/** 手柄缩放（被拖对边固定；缩到最小边长即停） */
export function resizeRect(rect: WorkbenchRect, handle: ResizeHandle, point: Point, page = 1): WorkbenchRect {
  return fromSplitBox(resizeBox(toSplitBox(rect, page), handle, point));
}

/** 面板像素坐标（渲染层绝对定位用；与归一化严格互逆） */
export function rectToBoxStyle(rect: WorkbenchRect, page: PageSize): { left: number; top: number; width: number; height: number } {
  const px = denormalizeRect(rect, page);
  return { left: px.x, top: px.y, width: px.w, height: px.h };
}

/** 框面积（命中判定/重叠取小用） */
export function rectArea(rect: WorkbenchRect): number {
  return Math.max(0, rect.w) * Math.max(0, rect.h);
}

/** 归一化点是否落在框内（续题/选中判定） */
export function rectContains(rect: WorkbenchRect, point: Point): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.w && point.y >= rect.y && point.y <= rect.y + rect.h;
}

/** 全部框的最小外接矩形（「并入最新待识别」合并多帧时用于溯源展示） */
export function unionRects(rects: WorkbenchRect[]): WorkbenchRect | null {
  if (rects.length === 0) return null;
  let x0 = 1;
  let y0 = 1;
  let x1 = 0;
  let y1 = 0;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: clamp01(x0), y: clamp01(y0), w: clamp01(x1) - clamp01(x0), h: clamp01(y1) - clamp01(y0) };
}
