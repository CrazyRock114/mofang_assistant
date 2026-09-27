// 0035 P2：公式图片化——KaTeX 渲染 → 隐藏 BrowserWindow 栅格 PNG（零原生依赖，D-051）。
// 实现要点（探针实证，见 0035 交付留痕在案）：
//   ① 主进程内 katex.renderToString（纯 JS，无 DOM）；KaTeX CSS/字体经 file:// 绝对路径加载；
//   ② 全部公式一次排进隐藏窗（每式一行，行内放零尺寸基线探针 + 逐式 strut 度量）：
//      公式盒顶/底取 KaTeX strut 并集（strut 是 KaTeX 自己算出的行高盒，比"元素 rect 并集"干净——
//      后者会被字体 ascent/descent 撑大）；基线取零尺寸 inline-block 底边；
//      量取脚本按**行序号**寻址（rasterize-measure.ts；key 内插 CSS 选择器会因两层转义静默 miss）；
//   ③ 逐式滚动进视口后 webContents.capturePage 截图（zoomFactor 放大到 3 倍像素密度；
//      隐藏窗 capturePage 已有 production 先例——feedback.exportCards；CDP Page.captureScreenshot
//      在隐藏窗会挂起，探针实测否决）；
//   ④ 单式失败（KaTeX 报错/无输出/行缺失）显式记录并跳过，不中断整卷——组装层落 [公式渲染失败] 占位。
// 尺寸口径：显示宽高取 CSS px（96dpi，与卷面字号同口径），PNG 像素密度另行放大，docx 内按显示尺寸缩放。

import { BrowserWindow } from 'electron';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import katex from 'katex';
import { rewriteKatexFontUrls } from '../../render/buildPaperHtml.js';
import { measureRowScript, type RawMeasurement } from './rasterize-measure.js';
import type { RasteredMath } from './assemble.js';
import type { MathItem } from './plan.js';

/** 目标像素密度倍率上限（3x：打印清晰度与产物体积的折中，同 POC；受窗口宽/显示器缩放影响实际值可能更高） */
export const RASTER_ZOOM_MAX = 3;
/** 截图留边（CSS px，防抗锯齿裁切；同时用于基线深度补偿） */
const CAPTURE_PAD = 2;
/** 栅格窗口 DIP 尺寸 */
const WINDOW_WIDTH = 1800;
const WINDOW_HEIGHT = 1200;

export interface MathRasterOutcome {
  images: Map<string, RasteredMath>;
  failed: Array<{ key: string; error: string }>;
}

interface MeasuredRow extends RawMeasurement {}

/** 公式行 HTML（含零尺寸基线探针；display 公式走 KaTeX 自带块级容器） */
function renderRows(items: MathItem[]): string {
  return items
    .map((item) => {
      const html = katex.renderToString(item.tex, {
        throwOnError: false,
        displayMode: item.display,
        output: 'html',
      });
      const font = item.fontPx.toFixed(4);
      return `<div class="mf-row" data-key="${escapeAttr(item.key)}" data-display="${item.display ? '1' : '0'}" style="font-size:${font}px">`
        + `<span class="mf-bl"></span><span class="mf-tex">${html}</span></div>`;
    })
    .join('\n');
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildPage(items: MathItem[], katexCss: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><style>${katexCss}</style>
<style>
  html, body { margin: 0; padding: 0; background: #fff; }
  /* line-height:1 收紧行盒（strut 度量不依赖行盒，收紧只为减少滚动高度与串行干扰） */
  .mf-row { display: block; line-height: 1; padding: 24px; white-space: nowrap; }
  .mf-bl { display: inline-block; width: 0; height: 0; vertical-align: baseline; }
  .mf-tex { display: inline-block; line-height: 1; vertical-align: baseline; }
  .mf-disp { display: block; }
</style></head>
<body>
${renderRows(items)}
</body></html>`;
}

function loadKatexCss(): string {
  const katexPath = require.resolve('katex/dist/katex.min.css');
  return rewriteKatexFontUrls(readFileSync(katexPath, 'utf-8'));
}

/**
 * 批量栅格公式为 PNG。
 * images 键 = MathItem.key；failed 为非致命失败清单（调用方记日志并继续）。
 */
export async function rasterizeMath(items: MathItem[]): Promise<MathRasterOutcome> {
  const outcome: MathRasterOutcome = { images: new Map(), failed: [] };
  if (items.length === 0) return outcome;

  const dir = join(tmpdir(), 'mofang-docx-math');
  mkdirSync(dir, { recursive: true });
  const htmlPath = join(dir, `math-${Date.now()}.html`);
  const win = new BrowserWindow({
    show: false,
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    // 隐藏窗仍需出帧（capturePage 依赖帧；缺省即 true，显式声明防语义漂移）
    paintWhenInitiallyHidden: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
      zoomFactor: RASTER_ZOOM_MAX,
    },
  });

  try {
    writeFileSync(htmlPath, buildPage(items, loadKatexCss()), 'utf-8');
    await win.loadFile(htmlPath);
    // 字体就绪（KaTeX 字体未加载完会量错盒）
    await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');

    // 首轮量取（不滚动；先拿宽度定缩放——超宽公式降低 zoom 以放宽 CSS 视口，防裁切）
    const firstPass: MeasuredRow[] = [];
    for (let index = 0; index < items.length; index += 1) {
      const raw = await win.webContents.executeJavaScript(measureRowScript(index)) as string;
      firstPass.push(JSON.parse(raw) as MeasuredRow);
    }
    const widest = firstPass.reduce((max, row) => Math.max(max, row.error ? 0 : row.width), 0);
    const zoom = Math.max(1, Math.min(RASTER_ZOOM_MAX, Math.floor((WINDOW_WIDTH - 60) / Math.max(widest + CAPTURE_PAD * 2, 1))));
    if (zoom !== RASTER_ZOOM_MAX) win.webContents.setZoomFactor(zoom);
    await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      try {
        // 缩放变化会改变布局 → 逐式重新量取（量取前 scrollIntoView 保证在视口内）
        const raw = await win.webContents.executeJavaScript(measureRowScript(index)) as string;
        const row = JSON.parse(raw) as MeasuredRow;
        if (row.error !== undefined) {
          outcome.failed.push({ key: item.key, error: row.error });
          continue;
        }
        // 行序回读校验：命中行必须是本式（key 仅作校验，不参与寻址——见 rasterize-measure.ts）
        if (row.key !== '' && row.key !== item.key) {
          outcome.failed.push({ key: item.key, error: `行序错位（读到 ${row.key}）` });
          continue;
        }
        const rect = {
          x: Math.max(0, Math.round((row.x - CAPTURE_PAD) * zoom)),
          y: Math.max(0, Math.round((row.y - CAPTURE_PAD) * zoom)),
          width: Math.max(1, Math.round((row.width + CAPTURE_PAD * 2) * zoom)),
          height: Math.max(1, Math.round((row.height + CAPTURE_PAD * 2) * zoom)),
        };
        const image = await win.webContents.capturePage(rect);
        const png = image.toPNG();
        if (png.length === 0) {
          outcome.failed.push({ key: item.key, error: 'capturePage 返回空图' });
          continue;
        }
        outcome.images.set(item.key, {
          png,
          // 显示尺寸 = CSS px（截图像素密度更高，docx 内按显示尺寸缩放回去）
          widthPx: Math.max(1, Math.round(row.width + CAPTURE_PAD * 2)),
          heightPx: Math.max(1, Math.round(row.height + CAPTURE_PAD * 2)),
          // 基线校正深度（含截图留边补偿）
          depthPx: Math.max(0, row.depth + CAPTURE_PAD),
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
