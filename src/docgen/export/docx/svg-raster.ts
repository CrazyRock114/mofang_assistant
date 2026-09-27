// 0035 修复批 F1：SVG 资产栅格化——SVG → 隐藏 BrowserWindow 渲染 → PNG（零新依赖）。
// 背景（用户目检真题）：采集站（菁优）的公式/符号图与部分配图是 **SVG**，旧实现只认位图
// （PNG/JPEG/GIF/BMP）→ 整幅落 `[图缺失]`；Electron nativeImage 亦不支持 SVG（探针实测四种
// 载入方式全空），故与公式同路：隐藏窗渲染 + capturePage。
// 口径：
//   ① 尺寸取「版式给的显示尺寸（DOM data-w/data-h）」优先，缺省回落 SVG 自身内在尺寸；
//   ② PNG 像素密度放大（zoomFactor，同公式栅格），docx 内按显示尺寸缩放 → 打印清晰；
//   ③ 单个 SVG 失败（解析/载入/空图）显式记账并跳过，不中断整卷；
//   ④ 内联 SVG 源（data: URL / file:）不在此处理——只接 data-assets 本地产物。

import { BrowserWindow } from 'electron';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AssetEntry } from './assemble.js';
import type { SvgAssetItem, SvgRasterOutcomeLike } from './index.js';

/** 像素密度倍率上限（同公式栅格；打印清晰度与体积折中） */
export const SVG_RASTER_ZOOM_MAX = 3;
/** 截图留边（CSS px，防抗锯齿裁切） */
const CAPTURE_PAD = 1;
const WINDOW_WIDTH = 1400;
const WINDOW_HEIGHT = 1200;

/** SVG 自身内在尺寸（width/height 属性；缺省 300×150 为 SVG 规范默认视口） */
export function svgIntrinsicSize(svg: string): { width: number; height: number } {
  const width = /\bwidth=["']?(\d+(?:\.\d+)?)/i.exec(svg);
  const height = /\bheight=["']?(\d+(?:\.\d+)?)/i.exec(svg);
  if (width !== null && height !== null) {
    const w = Number(width[1]);
    const h = Number(height[1]);
    if (w > 0 && h > 0) return { width: w, height: h };
  }
  const viewBox = /\bviewBox=["']\s*[-\d.]+\s+[-\d.]+\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)/i.exec(svg);
  if (viewBox !== null) {
    const w = Number(viewBox[1]);
    const h = Number(viewBox[2]);
    if (w > 0 && h > 0) return { width: w, height: h };
  }
  return { width: 300, height: 150 };
}

/** 单行尺寸（渲染后量取；失败落 error） */
interface MeasuredSvg {
  key: string;
  width: number;
  height: number;
  error?: string;
}

function measureScript(index: number): string {
  return `(() => {
    const rows = document.querySelectorAll('.mf-svg-row');
    const row = rows[${index}];
    const miss = (error) => JSON.stringify({ key: '', width: 0, height: 0, error });
    if (!row) return miss('row-missing');
    const img = row.querySelector('img');
    if (!img) return miss('img-missing');
    if (!img.complete) return miss('img-not-loaded');
    if (img.naturalWidth === 0) return miss('img-broken');
    const rect = img.getBoundingClientRect();
    return JSON.stringify({ key: row.getAttribute('data-key') || '', width: rect.width, height: rect.height });
  })()`;
}

/** 截图框（视口坐标：先 scrollIntoView 再取，与公式栅格同口径） */
function boxScript(index: number): string {
  return `(() => {
    const rows = document.querySelectorAll('.mf-svg-row');
    const img = rows[${index}].querySelector('img');
    img.scrollIntoView({ block: 'center' });
    const r = img.getBoundingClientRect();
    return JSON.stringify({ x: r.left, y: r.top, w: r.width, h: r.height });
  })()`;
}

function buildPage(items: SvgAssetItem[]): string {
  const rows = items.map((item, index) => {
    const size = svgIntrinsicSize(item.svg.toString('utf-8'));
    const w = item.widthPx ?? size.width;
    const h = item.heightPx ?? size.height;
    const src = `data:image/svg+xml;base64,${item.svg.toString('base64')}`;
    return `<div class="mf-svg-row" id="mf-svg-${index}" data-key="${escapeAttr(item.key)}">`
      + `<img src="${src}" width="${w}" height="${h}" alt="">`
      + '</div>';
  }).join('\n');
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><style>
  html, body { margin: 0; padding: 0; background: #fff; }
  /* 行内小图与整幅配图通用：不设最大宽——显示尺寸由 width/height 属性决定（与卷面同口径） */
  .mf-svg-row { display: block; padding: 16px; }
  .mf-svg-row > img { display: block; }
</style></head>
<body>
${rows}
</body></html>`;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 批量栅格 SVG 为 PNG。
 * images 键 = item.key；failed 为非致命失败清单（调用方记账并继续，不中断整卷）。
 */
export async function rasterizeSvgAssets(items: SvgAssetItem[]): Promise<SvgRasterOutcomeLike> {
  const outcome: SvgRasterOutcomeLike = { images: new Map(), failed: [] };
  if (items.length === 0) return outcome;

  const dir = join(tmpdir(), 'mofang-docx-svg');
  mkdirSync(dir, { recursive: true });
  const htmlPath = join(dir, `svg-${Date.now()}.html`);
  const win = new BrowserWindow({
    show: false,
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    // 隐藏窗仍需出帧（capturePage 依赖帧；与公式栅格同口径）
    paintWhenInitiallyHidden: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
      zoomFactor: SVG_RASTER_ZOOM_MAX,
    },
  });

  try {
    writeFileSync(htmlPath, buildPage(items), 'utf-8');
    await win.loadFile(htmlPath);

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      try {
        const raw = await win.webContents.executeJavaScript(measureScript(index)) as string;
        const row = JSON.parse(raw) as MeasuredSvg;
        if (row.error !== undefined) {
          outcome.failed.push({ key: item.key, error: row.error });
          continue;
        }
        if (row.key !== '' && row.key !== item.key) {
          outcome.failed.push({ key: item.key, error: `行序错位（读到 ${row.key}）` });
          continue;
        }
        const box = await win.webContents.executeJavaScript(boxScript(index)) as string;
        const rect = JSON.parse(box) as { x: number; y: number; w: number; h: number };
        const image = await win.webContents.capturePage({
          x: Math.max(0, Math.round((rect.x - CAPTURE_PAD) * SVG_RASTER_ZOOM_MAX)),
          y: Math.max(0, Math.round((rect.y - CAPTURE_PAD) * SVG_RASTER_ZOOM_MAX)),
          width: Math.max(1, Math.round((rect.w + CAPTURE_PAD * 2) * SVG_RASTER_ZOOM_MAX)),
          height: Math.max(1, Math.round((rect.h + CAPTURE_PAD * 2) * SVG_RASTER_ZOOM_MAX)),
        });
        const png = image.toPNG();
        if (png.length === 0) {
          outcome.failed.push({ key: item.key, error: 'capturePage 返回空图' });
          continue;
        }
        const natural = svgIntrinsicSize(item.svg.toString('utf-8'));
        outcome.images.set(item.key, {
          kind: 'image',
          data: png,
          type: 'png',
          // 内在尺寸 = 显示尺寸（CSS px）：docx 内按显示尺寸缩放 3× 像素 → 打印清晰（同公式口径）
          width: item.widthPx ?? Math.round(natural.width),
          height: item.heightPx ?? Math.round(natural.height),
        });
      } catch (err) {
        outcome.failed.push({ key: item.key, error: err instanceof Error ? err.message : String(err) });
      }
    }
  } finally {
    if (!win.isDestroyed()) win.destroy();
    if (existsSync(htmlPath)) {
      try { unlinkSync(htmlPath); } catch { /* 忽略清理失败 */ }
    }
  }

  return outcome;
}
