// 0036 P1：PDF 栅格化（pdfjs-dist，仅渲染层——Chromium 有 canvas，主进程没有）
//
// 为什么放渲染层：pdfjs 渲染需要 canvas 2D 上下文，Node 侧要额外原生依赖（napi-rs/canvas）才画得出来，
// 而 D-051 只批了纯 JS 的 pdfjs-dist 一个依赖。渲染层是 Electron 里唯一自带的 canvas 环境。
//
// worker：pdfjs 把解析放在 Web Worker（不阻塞 UI）。vite 用 `?url` 把 worker 文件作为资源产出，
// 打包后落在 dist/renderer/assets/ 内（electron-builder 的 dist/**/* 白名单已覆盖，S-2 实测项）。

import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy } from 'pdfjs-dist';

/** 默认渲染档：150dpi 等价的显示缩放（A4 → 约 1240×1754）。放大档按需传入并作为缓存键的一部分 */
export const DEFAULT_RENDER_SCALE = 1.5;
/** 单页位图上限（渲染尺寸保护）：超长卷/超大页按比例回缩，防一次渲染吃掉几百 MB */
export const MAX_PAGE_PIXELS = 4500 * 6400;

let workerConfigured = false;

function ensureWorker(): void {
  if (workerConfigured) return;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  workerConfigured = true;
}

export interface LoadedPdf {
  doc: PDFDocumentProxy;
  pageCount: number;
  /** 首页尺寸（px @scale1；供 UI 预估版式与裁剪坐标换算） */
  firstPageSize: { w: number; h: number };
}

/** 源 PDF 字节 → pdfjs 文档句柄（用完必须 close：pdfjs 持有 worker 与传输缓冲） */
export async function loadPdf(bytes: Uint8Array): Promise<LoadedPdf> {
  ensureWorker();
  // pdfjs 会接管并转移（transfer）传入的 buffer，故先复制一份：调用方可能还要用它
  const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  const page = await doc.getPage(1);
  const viewport = page.getViewport({ scale: 1 });
  return { doc, pageCount: doc.numPages, firstPageSize: { w: viewport.width, h: viewport.height } };
}

export interface RasterPage {
  canvas: HTMLCanvasElement;
  /** 位图字节（width×height×4；页图 LRU 的字节水位与 S-2 内存实测都按它记） */
  bytes: number;
  width: number;
  height: number;
  /** 该页在 PDF 内的原始点尺寸（px @scale1），归一化框换算的基准 */
  baseSize: { w: number; h: number };
}

/**
 * 渲染一页到离屏 canvas。
 * 返回的 canvas 同时供「显示」与「裁剪」使用（一次渲染两用，避免位图存两份）。
 */
export async function rasterizePage(doc: PDFDocumentProxy, pageNo: number, scale = DEFAULT_RENDER_SCALE): Promise<RasterPage> {
  const page = await doc.getPage(pageNo);
  const base = page.getViewport({ scale: 1 });
  const safeScale = safeScaleFor(base, scale);
  const viewport = page.getViewport({ scale: safeScale });

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法获取 canvas 2D 上下文（渲染环境异常）');

  await page.render({ canvasContext: ctx, viewport }).promise;

  return {
    canvas,
    bytes: canvas.width * canvas.height * 4,
    width: canvas.width,
    height: canvas.height,
    baseSize: { w: base.width, h: base.height },
  };
}

/** 超大页保护：按面积上限等比回缩（宁可见到小图，也不要一次渲染把渲染进程打爆） */
export function safeScaleFor(base: { width: number; height: number }, scale: number): number {
  const pixels = base.width * base.height * scale * scale;
  if (pixels <= MAX_PAGE_PIXELS) return scale;
  return scale * Math.sqrt(MAX_PAGE_PIXELS / pixels);
}
