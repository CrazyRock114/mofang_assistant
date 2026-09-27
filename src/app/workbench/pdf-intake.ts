// 0040 返工③（2026-09-20 目检）：整卷 PDF → 录题工作台（本地逐页栅格化）。
//
// 为什么在渲染层做：pdfjs 需要 canvas 2D 上下文（0036 P1 的同一条理由，D-051 只批了纯 JS 的 pdfjs-dist）。
// 页图是**本地转出来的 PNG**：过桥时就是普通图片素材（走既有的 recog.run.create），
// 主进程不需要为 PDF 开新口，识别引擎也不必知道素材的原身是 PDF。
//
// 与 0036 切题工作区的分工：那边是「按段框选 → 一题一 run」的老链；这边是整卷页图进新工作台，
// 手动框选/AI 一键都在新工作台里做（用户 2026-09-20 反馈「PDF 不该被赶到旧工作台」）。
//
// 上限：单次 MATERIAL_MAX_PAGES（30）页 —— 与图片素材同一口径，超出的页明确告知而不是悄悄丢。

import type { RecogMaterial } from '../../shared/contracts/recog-run-types.js';
import { MATERIAL_MAX_PAGES } from '../../recog/material.js';
import { DEFAULT_RENDER_SCALE, loadPdf, rasterizePage, type LoadedPdf } from '../splitting/pdf-raster.js';
import { bytesToBase64 } from '../splitting/source-io.js';

/** 栅格化依赖（测试注入假实现：jsdom 里没有 pdfjs worker 也没有真 canvas） */
export interface PdfIntakeDeps {
  load: (bytes: Uint8Array) => Promise<LoadedPdf>;
  rasterize: (doc: LoadedPdf['doc'], pageNo: number, scale?: number) => Promise<{ canvas: HTMLCanvasElement }>;
  toBlob: (canvas: HTMLCanvasElement) => Promise<Blob>;
  maxPages: number;
}

export interface PdfIntakeResult {
  /** 过桥素材（主进程按此落盘页图） */
  materials: RecogMaterial[];
  /** 本次会话的页图字节（工作台裁图源；取用后即弃） */
  files: File[];
  totalPages: number;
  importedPages: number;
  /** 需要让用户知道的事（超页数截断等）；null = 无需提示 */
  notice: string | null;
}

function toBlobOf(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => { if (blob) resolve(blob); else reject(new Error('页图编码失败（canvas.toBlob 返回空）')); },
      'image/png',
    );
  });
}

const DEFAULT_DEPS: PdfIntakeDeps = {
  load: loadPdf,
  rasterize: rasterizePage,
  toBlob: toBlobOf,
  maxPages: MATERIAL_MAX_PAGES,
};

/** 卷名 → 页图名主干（去扩展名、压掉路径分隔符与超长名；素材名会进 sourceDetail 溯源） */
export function pdfStem(fileName: string): string {
  const base = (fileName.split(/[\\/]/).pop() ?? fileName).replace(/\.pdf$/i, '').trim();
  const safe = base.replace(/[<>:"|?*]/g, '_');
  return (safe === '' ? '整卷' : safe).slice(0, 60);
}

/** 0046 P1.4：栅格化进度回调（done = 已完成页序 1-based，total = 本次导入页数） */
export type RasterizeProgress = (done: number, total: number) => void;

/**
 * PDF 字节 → 逐页 PNG 素材。
 * 逐页转、转完即弃 canvas（不缓存位图：一本 30 页卷的位图水位按 8.7MB/页算会直接撑爆渲染进程）。
 * 0046 P1.4：每页完成即回调 onProgress，入口页驱动统一读条（原来只有一条静态文案）。
 */
export async function rasterizePdf(file: File, deps: PdfIntakeDeps = DEFAULT_DEPS, onProgress?: RasterizeProgress): Promise<PdfIntakeResult> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length === 0) throw new Error('PDF 为空（0 字节文件不是有效素材）');
  const loaded = await deps.load(bytes);
  try {
    const totalPages = loaded.pageCount;
    if (totalPages <= 0) throw new Error('这份 PDF 没有可读页面');
    const importedPages = Math.min(totalPages, deps.maxPages);
    const stem = pdfStem(file.name);
    const materials: RecogMaterial[] = [];
    const files: File[] = [];
    for (let pageNo = 1; pageNo <= importedPages; pageNo++) {
      const raster = await deps.rasterize(loaded.doc, pageNo, DEFAULT_RENDER_SCALE);
      const blob = await deps.toBlob(raster.canvas);
      const name = `${stem}-p${String(pageNo).padStart(3, '0')}.png`;
      materials.push({ name, mime: 'image/png', dataBase64: bytesToBase64(new Uint8Array(await blob.arrayBuffer())) });
      files.push(new File([blob], name, { type: 'image/png' }));
      onProgress?.(pageNo, importedPages);
    }
    return {
      materials,
      files,
      totalPages,
      importedPages,
      notice: totalPages > importedPages
        ? `这份 PDF 共 ${totalPages} 页，本次只转入前 ${importedPages} 页（单次上限 ${deps.maxPages} 页）；其余页请分次导入`
        : null,
    };
  } finally {
    // 用完必须 close：pdfjs 持有 worker 与传输缓冲
    await loaded.doc.destroy().catch(() => undefined);
  }
}

/** 页图名 → run 名（进工作台标题与 sourceDetail.paperTitle；与页图主干同源） */
export function pdfPaperTitle(fileName: string): string {
  return pdfStem(fileName);
}
