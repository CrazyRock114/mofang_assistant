// 0036 P1/P3：页图供给（默认档渲染 + 页图 LRU + 工作区落盘缓存 + 裁剪）
//
// 取一页位图的三级回落（越靠前越便宜）：
//   1) 内存 LRU（换页/翻回时零成本）
//   2) 工作区页图缓存（重开项目不必重新跑 pdfjs 渲染）
//   3) pdfjs 现场渲染（并顺手写回工作区缓存，下次走 2）
//
// 页图缓存按 **renderPolicy（页号@缩放档）** 记键：换缩放档旧位图自动失效，不会被当命中（对标竞品的 renderPolicy 语义）。
// 字节水位由 page-cache 的 LRU 限制兜住——A4@1.5x 约 1240×1754×4B ≈ 8.7MB/页，无上限缓存会撑爆渲染进程。

import type { MofangSplitBridge } from '../../shared/contracts/bridge.js';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { createPageImageCache, renderPolicyKey, type PageImageCache } from '../../recog/splitting/page-cache.js';
import type { CropPlan, PageSize } from '../../recog/splitting/box-model.js';
import { DEFAULT_RENDER_SCALE, rasterizePage, safeScaleFor, type RasterPage } from './pdf-raster.js';
import { base64ToBytes } from './source-io.js';
import type { CroppedImage, CropFn, StitchFn } from './run-launch.js';

export interface PageImageStoreDeps {
  split: MofangSplitBridge;
  projectId: string;
  /** 取 pdfjs 文档句柄（异步加载完才有值；未就绪时 get 会等到 ready） */
  getDoc: () => Promise<PDFDocumentProxy>;
  scale?: number;
}

export interface CapturedPageImage extends RasterPage {
  key: string;
}

/** PNG base64 → 可绘制位图（走 createImageBitmap，避免 Image 解码的 onload 回调地狱） */
async function bitmapFromPngBase64(dataBase64: string): Promise<ImageBitmap> {
  const bytes = base64ToBytes(dataBase64);
  return createImageBitmap(new Blob([bytes], { type: 'image/png' }));
}

function drawToCanvas(bitmap: ImageBitmap): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法获取 canvas 2D 上下文');
  ctx.drawImage(bitmap, 0, 0);
  return canvas;
}

export class PageImageStore {
  private readonly cache: PageImageCache<CapturedPageImage>;
  private readonly scale: number;

  constructor(private readonly deps: PageImageStoreDeps) {
    this.scale = deps.scale ?? DEFAULT_RENDER_SCALE;
    this.cache = createPageImageCache<CapturedPageImage>();
  }

  get renderScale(): number {
    return this.scale;
  }

  /** 仅内存查询（画框时高频调用，不能触发 IO） */
  peek(pageNo: number): CapturedPageImage | undefined {
    return this.cache.get(pageNo, this.scale);
  }

  async get(pageNo: number): Promise<CapturedPageImage> {
    const hit = this.peek(pageNo);
    if (hit) return hit;

    const fromDisk = await this.tryDisk(pageNo);
    if (fromDisk) {
      this.cache.set(pageNo, this.scale, fromDisk);
      return fromDisk;
    }

    const doc = await this.deps.getDoc();
    const raster = await rasterizePage(doc, pageNo, this.scale);
    const captured: CapturedPageImage = { ...raster, key: renderPolicyKey(pageNo, this.scale) };
    this.cache.set(pageNo, this.scale, captured);
    // 写缓存是优化不是正确性：写失败不影响看图（只在控制台留痕，不打断用户）
    try {
      await this.deps.split.writePage({
        projectId: this.deps.projectId,
        pageNo,
        dataBase64: canvasToPngBase64(captured.canvas),
      });
    } catch (err) {
      console.warn(`[0036] 页图缓存写入失败（不影响阅读）：${err instanceof Error ? err.message : String(err)}`);
    }
    return captured;
  }

  /** 页图像素尺寸表（裁剪计划换算基准；只算已入缓存的页，避免为算尺寸把整本渲染一遍） */
  pageSizes(pages: number[]): Map<number, PageSize> {
    const out = new Map<number, PageSize>();
    for (const page of pages) {
      const hit = this.peek(page);
      if (hit) out.set(page, { w: hit.width, h: hit.height });
    }
    return out;
  }

  /**
   * 解析跨页题所需页的像素尺寸：缓存命中直接给；未渲染的页只取 viewport（**不渲染**）按同一缩放公式推算。
   * 只取尺寸不渲染是有意的——跨页题的另一页往往只是答案区，为算坐标去渲一页全图纯属浪费。
   */
  async resolvePageSizes(pages: number[]): Promise<Map<number, PageSize>> {
    const out = this.pageSizes(pages);
    const missing = [...new Set(pages)].filter((p) => !out.has(p));
    if (missing.length === 0) return out;
    const doc = await this.deps.getDoc();
    for (const pageNo of missing) {
      const page = await doc.getPage(pageNo);
      const base = page.getViewport({ scale: 1 });
      const scale = safeScaleFor(base, this.scale);
      out.set(pageNo, { w: Math.max(1, Math.ceil(base.width * scale)), h: Math.max(1, Math.ceil(base.height * scale)) });
    }
    return out;
  }

  stats(): { count: number; bytes: number } {
    return { count: this.cache.size(), bytes: this.cache.bytes() };
  }

  clear(): void {
    this.cache.clear();
  }

  private async tryDisk(pageNo: number): Promise<CapturedPageImage | null> {
    try {
      const cached = await this.deps.split.readPage({ projectId: this.deps.projectId, pageNo });
      if (!cached.dataBase64) return null;
      const bitmap = await bitmapFromPngBase64(cached.dataBase64);
      const canvas = drawToCanvas(bitmap);
      bitmap.close();
      return {
        canvas,
        bytes: canvas.width * canvas.height * 4,
        width: canvas.width,
        height: canvas.height,
        // 磁盘缓存不带原始点尺寸：以渲染尺寸反推（归一化框相对渲染尺寸，ratio 一致故裁剪不受影响）
        baseSize: { w: canvas.width / this.scale, h: canvas.height / this.scale },
        key: renderPolicyKey(pageNo, this.scale),
      };
    } catch {
      return null; // 缓存读失败一律回落现场渲染
    }
  }
}

/** canvas → PNG base64（无 data URL 前缀） */
export function canvasToPngBase64(canvas: HTMLCanvasElement): string {
  const url = canvas.toDataURL('image/png');
  const comma = url.indexOf(',');
  if (comma < 0) throw new Error('canvas.toDataURL 返回异常');
  return url.slice(comma + 1);
}

/** 跨页拼接的页缝宽度（px）：留一道可见细线，让模型知道这里翻过页，阅读顺序仍是从上到下 */
export const STITCH_GAP_PX = 12;

/**
 * 拼接器：把同一道题的多页裁剪**按阅读顺序**纵向拼成一张图（跨页题的落点，2026-09-18 目检案底）。
 * 为什么必须拼：一页一张素材 = 两次并发 vision 调用（免费通道的并发/限流最易在此翻车），
 * 且引擎要靠跨页 stitching 猜续接；拼成一张后一次调用看全题、token 也减半。
 * 各页裁剪宽度可能不同（不同页的框宽度不同），故画布取最宽、左对齐，页缝画一道细线。
 */
export function createStitcher(): StitchFn {
  return async (parts: CroppedImage[]): Promise<CroppedImage> => {
    const bitmaps: ImageBitmap[] = [];
    try {
      for (const part of parts) bitmaps.push(await bitmapFromPngBase64(part.dataBase64));
      if (bitmaps.length === 0) throw new Error('没有可拼接的裁剪图');
      const width = Math.max(...bitmaps.map((b) => b.width));
      const height = bitmaps.reduce((sum, b) => sum + b.height, 0) + STITCH_GAP_PX * (bitmaps.length - 1);

      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, width);
      canvas.height = Math.max(1, height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('无法获取 canvas 2D 上下文');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      let y = 0;
      const seams: number[] = [];
      for (const bitmap of bitmaps) {
        ctx.drawImage(bitmap, 0, y);
        y += bitmap.height;
        if (y < canvas.height) {
          seams.push(y + Math.floor(STITCH_GAP_PX / 2));
          y += STITCH_GAP_PX;
        }
      }
      // 页缝线（先画完所有位图再画线，避免线被后续 drawImage 覆盖）
      ctx.fillStyle = '#c9c9c9';
      for (const seam of seams) ctx.fillRect(0, seam, canvas.width, 1);

      return { dataBase64: canvasToPngBase64(canvas), mime: 'image/png' };
    } finally {
      for (const bitmap of bitmaps) bitmap.close();
    }
  };
}

/**
 * 裁剪器：从页图位图上抠出计划矩形 → PNG base64（**本地裁剪、只送小图**，规划 T7 差异化点）。
 * 裁剪矩形来自 cropPlansForQuestion（已含留白并夹回页内），这里只做像素搬移。
 */
export function createCropper(store: PageImageStore): CropFn {
  return async (page: number, rect: CropPlan['rect']): Promise<CroppedImage> => {
    const source = await store.get(page);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(rect.w));
    canvas.height = Math.max(1, Math.round(rect.h));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法获取 canvas 2D 上下文');
    ctx.drawImage(source.canvas, rect.x, rect.y, rect.w, rect.h, 0, 0, canvas.width, canvas.height);
    return { dataBase64: canvasToPngBase64(canvas), mime: 'image/png' };
  };
}
