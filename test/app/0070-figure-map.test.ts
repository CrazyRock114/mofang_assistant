// 0070（R-052 乙方案，2026-09-25 用户授权）：图块坐标换算——「相对送图」归一 → 「相对页」归一。
//
// 为什么必须换算：模型给的插图坐标（DSO grounding 0-999 / 主模型内联 bboxNorm）归一基准是**送给它的那张图**
// （单帧 = 框选裁剪图；多帧 = 纵向拼接图），而题卡契约里 `WorkbenchFigure.bbox` 与 pageNo 是**页坐标**语义
// （左栏图块红框按页画、拖动微调从该页重裁）。两套坐标在「框 = 整页」时重合，故 0040 起一直没暴露。
//
// 本文件锁定换算数学（纯函数，零 DOM 渲染）：帧几何 → 送图布局 → bbox 反算回帧所在页。
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { WorkbenchFrame } from '../../src/shared/contracts/onestep-types.js';
import type { PageImageLike } from '../../src/app/workbench/crop.js';
import { cropNormalizedRect, cropOutputGeometry } from '../../src/app/workbench/crop.js';
import { buildSentMap, mapBboxToPage } from '../../src/app/workbench/figure-map.js';
import { STITCH_GAP_PX } from '../../src/app/splitting/page-images.js';
import { makeFrame } from '../../src/recog/onestep/workbench.js';

// 本文件只做几何与尺寸断言（不比像素）：canvas 垫片只提供 getContext/toDataURL 的最小面
class MiniCanvas {
  width = 0;
  height = 0;
  getContext(): Record<string, unknown> { return { fillStyle: '#000000', drawImage: () => undefined, fillRect: () => undefined }; }
  toDataURL(): string { return 'data:image/png;base64,QUJD'; }
}

let originalCreateElement: typeof document.createElement;
beforeEach(() => {
  originalCreateElement = document.createElement.bind(document);
  document.createElement = ((tag: string, options?: ElementCreationOptions): HTMLElement => (
    tag === 'canvas' ? (new MiniCanvas() as unknown as HTMLElement) : originalCreateElement(tag, options)
  )) as typeof document.createElement;
});
afterEach(() => { document.createElement = originalCreateElement; vi.restoreAllMocks(); });

// 与页面级测试同口径的页尺寸：页1 1000×1400、页2 1200×1600
const PAGE_SIZE: Record<number, { width: number; height: number }> = { 1: { width: 1000, height: 1400 }, 2: { width: 1200, height: 1600 } };
const sizeOf = (pageNo: number): { width: number; height: number } | undefined => PAGE_SIZE[pageNo];
const pageImage = (pageNo: number): PageImageLike => ({
  naturalWidth: PAGE_SIZE[pageNo]!.width, naturalHeight: PAGE_SIZE[pageNo]!.height,
  source: {} as CanvasImageSource, origin: 'memory',
});

/** 页1 下半（整宽）→ 裁 900×630；页2 左上 1/4（半宽）→ 裁 600×400（画布取最宽 900、左对齐） */
const FRAME_1: WorkbenchFrame = makeFrame('f1', { pageNo: 1, rect: { x: 0, y: 0.5, w: 1, h: 0.5 } });
const FRAME_2: WorkbenchFrame = makeFrame('f2', { pageNo: 2, rect: { x: 0, y: 0, w: 0.5, h: 0.25 } });

describe('0070 图块坐标换算：送图归一 → 页坐标归一', () => {
  it('单帧：bbox 按框的位置与尺寸仿射映射回该页（框不在整页时不再错位）', () => {
    const map = buildSentMap([FRAME_1], sizeOf);
    expect(map).not.toBeNull();
    // 单帧布局 = 该帧裁剪本身（900×630，未触发上限外的一切缩放）
    expect({ w: map!.width, h: map!.height }).toEqual({ w: 900, h: 630 });

    // 裁剪图坐标 [0.1,0.2,0.4,0.4] → 页坐标：x 不变（框横向铺满），y = 0.5 + v×0.5
    const mapped = mapBboxToPage(map!, [0.1, 0.2, 0.4, 0.4]);
    expect(mapped).not.toBeNull();
    expect(mapped!.pageNo).toBe(1);
    expect(mapped!.bbox[0]).toBeCloseTo(0.1, 9);
    expect(mapped!.bbox[1]).toBeCloseTo(0.6, 9);
    expect(mapped!.bbox[2]).toBeCloseTo(0.4, 9);
    expect(mapped!.bbox[3]).toBeCloseTo(0.7, 9);

    // 该帧的实际裁剪尺寸与布局口径一致（900 上限档）：1000×700 → 900×630
    const crop = cropNormalizedRect(pageImage(1), FRAME_1.rect);
    expect(crop.ok).toBe(true);
    if (crop.ok) expect({ w: crop.width, h: crop.height }).toEqual({ w: map!.width, h: map!.height });
  });

  it('多帧：bbox 落在哪一帧块里就换算到那一帧所在页（跨页帧各归各页）', () => {
    const map = buildSentMap([FRAME_1, FRAME_2], sizeOf);
    expect(map).not.toBeNull();
    // 拼接布局：宽取最宽 900；高 = 630 + 400 + 页缝 12
    expect({ w: map!.width, h: map!.height }).toEqual({ w: 900, h: 630 + 400 + STITCH_GAP_PX });
    expect(map!.frames.map((f) => f.offsetY)).toEqual([0, 630 + STITCH_GAP_PX]);

    // 块1（y ∈ [0,630)）里的框 → 页1：x 铺满不变；y 底坐标 = (0.1×1042)/630 = 0.16540 → 页 y = 0.5 + 0.1654×0.5
    const inFirst = mapBboxToPage(map!, [0.1, 0.1, 0.4, 0.3]);
    expect(inFirst!.pageNo).toBe(1);
    expect(inFirst!.bbox[0]).toBeCloseTo(0.1, 9);
    expect(inFirst!.bbox[1]).toBeCloseTo(0.582698, 6);
    expect(inFirst!.bbox[3]).toBeCloseTo(0.5 + (0.3 * 1042 / 630) * 0.5, 9);

    // 块2（y ∈ [642,1042)）里的框 → 页2：半宽块 → x 按 900/600 折算后再乘框宽 0.5
    const inSecond = mapBboxToPage(map!, [0.1, 0.7, 0.4, 0.9]);
    expect(inSecond!.pageNo).toBe(2);
    expect(inSecond!.bbox[0]).toBeCloseTo(0.075, 9);   // 0.1×900/600×0.5
    expect(inSecond!.bbox[2]).toBeCloseTo(0.3, 9);     // 0.4×900/600×0.5
    expect(inSecond!.bbox[1]).toBeCloseTo(0.054625, 6); // (0.7×1042−642)/400×0.25
    expect(inSecond!.bbox[3]).toBeCloseTo(0.184875, 6); // (0.9×1042−642)/400×0.25
  });

  it('越界与夹缝：bbox 落在页缝/块外 → 归到最近的一帧并夹回该帧区域内（不产负坐标/越页）', () => {
    const map = buildSentMap([FRAME_1, FRAME_2], sizeOf)!;
    // 就在页缝上（缝心 y ≈ 0.625 → 651px，落进第二块）
    const onSeam = mapBboxToPage(map, [0.1, 0.615, 0.4, 0.635]);
    expect([1, 2]).toContain(onSeam!.pageNo);
    expect(onSeam!.bbox[1]).toBeGreaterThanOrEqual(0);
    expect(onSeam!.bbox[3]).toBeLessThanOrEqual(1);
    // x 超出块宽（模型给了比块更宽的框）→ 夹回该帧框内（页2 是半宽框 → 0~0.5）
    const wide = mapBboxToPage(map, [-0.5, 0.7, 1.5, 0.9]);
    expect(wide!.pageNo).toBe(2);
    expect(wide!.bbox[0]).toBeCloseTo(0, 9);
    expect(wide!.bbox[2]).toBeCloseTo(0.5, 9);
    // 反向框（x2 < x1）→ 判为无效，返回 null（调用方保留原坐标并告警）
    expect(mapBboxToPage(map, [0.4, 0.1, 0.1, 0.3])).toBeNull();
  });

  it('页尺寸缺失 → 不产布局（null），调用方据此保留原坐标 + 显式告警', () => {
    expect(buildSentMap([FRAME_1], () => undefined)).toBeNull();
    expect(buildSentMap([FRAME_1], () => ({ width: 0, height: 0 }))).toBeNull();
    expect(buildSentMap([], sizeOf)).toBeNull();
  });
});

describe('0070 口径共享：crop.ts 暴露的裁剪几何与实际裁剪一致', () => {
  it('cropOutputGeometry 与 cropNormalizedRect 的产出尺寸逐例一致（含 900 上限档与夹页内）', () => {
    const page = pageImage(1);
    const cases = [
      { x: 0, y: 0.5, w: 1, h: 0.5 },        // 无缩放
      { x: 0.1, y: 0.2, w: 0.3, h: 0.2 },    // 无缩放
      { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },    // 触发 900 上限（1000 宽 → 0.9 缩比）
    ];
    for (const rect of cases) {
      const geo = cropOutputGeometry({ width: page.naturalWidth, height: page.naturalHeight }, rect);
      const crop = cropNormalizedRect(page, rect);
      expect(crop.ok).toBe(true);
      if (crop.ok) {
        expect({ w: crop.width, h: crop.height }).toEqual({ w: geo.outWidth, h: geo.outHeight });
        expect(geo.px.w).toBeGreaterThan(0);
      }
    }
    // 越界矩形：夹回页内（与 rectToPixels 同口径）
    const clamped = cropOutputGeometry({ width: 100, height: 100 }, { x: -0.2, y: -0.2, w: 0.5, h: 0.5 });
    expect(clamped.px.x).toBe(0);
    expect(clamped.px.y).toBe(0);
    expect(clamped.px.x + clamped.px.w).toBeLessThanOrEqual(100);
    expect(clamped.px.y + clamped.px.h).toBeLessThanOrEqual(100);
  });
});
