// 0070（R-052 乙方案，2026-09-25 用户拍板）：图块坐标换算——把「相对送图」归一的 bbox 反算成「相对页」归一。
//
// 为什么需要它：模型给的插图坐标（DSO grounding 0-999 / 主模型内联 bboxNorm）归一基准是**送给它的那张图**
// （单帧 = 框选的裁剪图；多帧 = 纵向拼接图），而题卡契约里 `WorkbenchFigure` 的 pageNo/bbox 是**页坐标**语义
// ——左栏图块红框按页画（`figureMarks`）、拖动微调从该页重裁（`onFigureChange`）。两套坐标只有在
// 「框 = 整页」时重合，所以单帧非整页框与多帧卡一直错位（残余 C1/C2，用户目检后授权本轮解决）。
//
// 换算数学（全部在归一化空间做，与像素缩放无关）：
//   帧 i 的裁剪图覆盖页上像素框 px_i = (x,y,w,h)（已夹页内），其产出尺寸 (blockWidth, blockHeight) 即它在
//   拼接图里的块（画布取最宽、左对齐、块间 STITCH_GAP_PX 页缝）。
//   送图归一 (u,v) → 先定位块 i（按 y 中心）→ 块内归一 → 页归一：
//     x_page = (px_i.x + (u×W_canvas / blockWidth_i) × px_i.w) / pageWidth_i
//     y_page = (px_i.y + ((v×H_canvas − offsetY_i) / blockHeight_i) × px_i.h) / pageHeight_i
//   单帧即「一块的布局」，公式退化为按框矩形仿射映射：x_page = frame.rect.x + u × frame.rect.w。
//
// 边界：块定位取 bbox 中心；块内坐标夹到 [0,1]（模型给的框可能比块更宽/更靠缝，夹回该帧自己的区域——
// 那才是真正送出去的内容）；无效框（x2≤x1 或 y2≤y1）返回 null，由调用方保留原坐标并显式告警（不静默。

import type { OnestepBBox, WorkbenchFrame } from '../../shared/contracts/onestep-types.js';
import { cropOutputGeometry } from './crop.js';
import { STITCH_GAP_PX } from '../splitting/page-images.js';

/** 送图里一帧的位置（页坐标换算的锚） */
export interface SentMapFrame {
  frame: WorkbenchFrame;
  pageWidth: number;
  pageHeight: number;
  /** 该帧在页图上的源像素框 */
  px: { x: number; y: number; w: number; h: number };
  /** 该帧在送图里的块（纵向偏移 / 块尺寸；画布取最宽左对齐） */
  offsetY: number;
  blockWidth: number;
  blockHeight: number;
}

export interface SentMap {
  /** 送图尺寸（= 拼接图尺寸；单帧时即该帧裁剪尺寸） */
  width: number;
  height: number;
  frames: SentMapFrame[];
}

/**
 * 帧列表 + 页尺寸 → 送图布局。页尺寸缺失返回 null（上层保留原坐标 + 告警）。
 * 布局与 `createStitcher` 同口径：块宽取最宽、左对齐，块高逐帧累加，块间留页缝。
 */
export function buildSentMap(
  frames: WorkbenchFrame[],
  pageSizeOf: (pageNo: number) => { width: number; height: number } | undefined,
): SentMap | null {
  if (frames.length === 0) return null;
  const out: SentMapFrame[] = [];
  let cursorY = 0;
  let width = 0;
  for (const frame of frames) {
    const size = pageSizeOf(frame.pageNo);
    if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0) {
      return null;
    }
    const geo = cropOutputGeometry({ width: size.width, height: size.height }, frame.rect);
    if (out.length > 0) cursorY += STITCH_GAP_PX;
    out.push({
      frame,
      pageWidth: size.width,
      pageHeight: size.height,
      px: geo.px,
      offsetY: cursorY,
      blockWidth: geo.outWidth,
      blockHeight: geo.outHeight,
    });
    cursorY += geo.outHeight;
    width = Math.max(width, geo.outWidth);
  }
  return { width, height: cursorY, frames: out };
}

export interface MappedBbox {
  /** 换算后的坐标落在这一帧所在的页 */
  pageNo: number;
  bbox: OnestepBBox;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** bbox（送图归一） → 该帧所在页的页坐标归一；无效框 / 空布局 → null */
export function mapBboxToPage(map: SentMap, bbox: OnestepBBox): MappedBbox | null {
  const [x1, y1, x2, y2] = bbox;
  if (!(x2 > x1) || !(y2 > y1)) return null;
  if (map.frames.length === 0 || map.width <= 0 || map.height <= 0) return null;

  const centerY = ((y1 + y2) / 2) * map.height;
  const block = map.frames.find((f) => centerY >= f.offsetY && centerY <= f.offsetY + f.blockHeight)
    ?? nearestFrame(map, centerY);

  // 块内归一（夹 [0,1]：模型给的框可能比块宽或压在页缝上——夹回这一帧真正送出去的区域）
  const u1 = clamp01((x1 * map.width) / block.blockWidth);
  const u2 = clamp01((x2 * map.width) / block.blockWidth);
  const v1 = clamp01((y1 * map.height - block.offsetY) / block.blockHeight);
  const v2 = clamp01((y2 * map.height - block.offsetY) / block.blockHeight);

  return {
    pageNo: block.frame.pageNo,
    bbox: [
      clamp01((block.px.x + u1 * block.px.w) / block.pageWidth),
      clamp01((block.px.y + v1 * block.px.h) / block.pageHeight),
      clamp01((block.px.x + u2 * block.px.w) / block.pageWidth),
      clamp01((block.px.y + v2 * block.px.h) / block.pageHeight),
    ],
  };
}

/** 页缝/块外 → 取纵向最近的一块（夹回该帧区域，不跨帧乱猜） */
function nearestFrame(map: SentMap, y: number): SentMapFrame {
  let best = map.frames[0]!;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const frame of map.frames) {
    const distance = y < frame.offsetY
      ? frame.offsetY - y
      : y > frame.offsetY + frame.blockHeight ? y - (frame.offsetY + frame.blockHeight) : 0;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = frame;
    }
  }
  return best;
}
