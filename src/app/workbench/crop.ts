// 0040 P3/P4：本地裁图（只送小图/口径一致的地基）。
//
// 口径（0042 §十第二轮 + 0036「裁剪本地做」）：裁切一律在渲染层用 canvas 完成，
// 从**送给模型的那张图**上裁，坐标口径天然一致；主进程不参与图像处理。
//
// 降级（显式不静默）：重开草稿后页图只有 `file:///` 路径，Chromium 在 webSecurity 默认下会把
// file:// 图判为不可导出的画布 → `toDataURL` 抛 SecurityError。此时返回 ok:false + 人读原因，
// 由 UI 提示「重新拖入原图后可继续裁图」，绝不静默产出坏图。

import type { WorkbenchRect } from '../../shared/contracts/onestep-types.js';

/** 页图（渲染层持有的可裁源） */
export interface PageImageLike {
  /** 自然像素宽高（decode 后） */
  naturalWidth: number;
  naturalHeight: number;
  /** 可绘制源（HTMLImageElement / ImageBitmap / canvas 均可） */
  source: CanvasImageSource;
  /** 页图来源：memory = 本次会话拖入的字节（可裁）；disk = 从 run 目录读回的 file:// 路径（可能受安全限制） */
  origin: 'memory' | 'disk';
}

/** 归一化矩形 → 像素矩形（含边距外扩，越界裁剪到页内） */
export function rectToPixels(
  rect: WorkbenchRect,
  page: { width: number; height: number },
  options?: { padding?: number },
): { x: number; y: number; w: number; h: number } {
  const pad = options?.padding ?? 0;
  const left = Math.min(rect.x, rect.x + rect.w);
  const top = Math.min(rect.y, rect.y + rect.h);
  const x = Math.max(0, Math.round((left - pad) * page.width));
  const y = Math.max(0, Math.round((top - pad) * page.height));
  const right = Math.min(page.width, Math.round((left + Math.abs(rect.w) + pad) * page.width));
  const bottom = Math.min(page.height, Math.round((top + Math.abs(rect.h) + pad) * page.height));
  return { x, y, w: Math.max(1, right - x), h: Math.max(1, bottom - y) };
}

export type CropOutcome =
  | { ok: true; dataUrl: string; width: number; height: number }
  | { ok: false; reason: string };

/** 裁图上限（长边像素）：题干图芯片不需要超过该尺寸，防 workbench.json/HTML 膨胀 */
export const CROP_MAX_EDGE_PX = 900;

/** 裁剪几何（纯算，不碰画布）：源像素框 + 产出尺寸 + 缩比 */
export interface CropGeometry {
  /** 页图上的源像素框（已夹页内；与 cropNormalizedRect 实际送进 drawImage 的区域一致） */
  px: { x: number; y: number; w: number; h: number };
  /** 产出尺寸（含 maxEdge 缩比后的取整） */
  outWidth: number;
  outHeight: number;
  /** 缩比（1 = 未缩放） */
  scale: number;
}

/**
 * 归一化矩形 → 裁剪几何（0070 坐标换算与裁剪共用同一口径，避免两套算法漂移）。
 * 纯函数：只做 rectToPixels + maxEdge 取整，不创建画布。
 */
export function cropOutputGeometry(
  page: { width: number; height: number },
  rect: WorkbenchRect,
  options?: { padding?: number; maxEdge?: number },
): CropGeometry {
  const px = rectToPixels(rect, page, options);
  const maxEdge = options?.maxEdge ?? CROP_MAX_EDGE_PX;
  const scale = Math.min(1, maxEdge / Math.max(px.w, px.h));
  return {
    px,
    outWidth: Math.max(1, Math.round(px.w * scale)),
    outHeight: Math.max(1, Math.round(px.h * scale)),
    scale,
  };
}

/**
 * 从页图裁出归一化矩形 → PNG data URL。
 * 失败原因（人读）：页图未就绪 / 画布安全限制（file:// 图不可导出）。
 */
export function cropNormalizedRect(
  page: PageImageLike,
  rect: WorkbenchRect,
  options?: { padding?: number; maxEdge?: number },
): CropOutcome {
  const { naturalWidth: w, naturalHeight: h } = page;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return { ok: false, reason: '页图尚未加载完成，无法裁图' };
  }
  const { px, outWidth: outW, outHeight: outH } = cropOutputGeometry({ width: w, height: h }, rect, options);

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { ok: false, reason: '当前环境不支持 canvas 2d（无法裁图）' };
  try {
    ctx.drawImage(page.source, px.x, px.y, px.w, px.h, 0, 0, outW, outH);
    const dataUrl = canvas.toDataURL('image/png');
    if (!dataUrl || !dataUrl.startsWith('data:image')) {
      return { ok: false, reason: '裁图产出为空' };
    }
    return { ok: true, dataUrl, width: outW, height: outH };
  } catch (err) {
    return {
      ok: false,
      reason:
        page.origin === 'disk'
          ? `重开草稿的页图受浏览器安全限制不可导出（${err instanceof Error ? err.message : String(err)}）——请重新拖入原图后再裁图`
          : `裁图失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** 页图加载（磁盘路径 → HTMLImageElement；decode 完成后才能裁） */
export function loadPageImage(url: string, origin: 'memory' | 'disk'): Promise<PageImageLike> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      resolve({ naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, source: img, origin });
    };
    img.onerror = () => reject(new Error(`页图加载失败：${url}`));
    img.src = url;
  });
}

/** run 目录页图绝对路径 → 渲染层可加载 URL（ProofPage resolveImageSrc 同款口径） */
export function imageSrcOf(imagePath: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(imagePath)) return `file:///${imagePath.replace(/\\/g, '/')}`;
  if (imagePath.startsWith('/')) return `file://${imagePath}`;
  return imagePath;
}

/** File → 可裁页图（本次会话拖入的字节：不受 file:// 安全限制） */
export function loadFileImage(file: File): Promise<PageImageLike> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, source: img, origin: 'memory' });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`图片解码失败：${file.name}`)); };
    img.src = url;
  });
}
