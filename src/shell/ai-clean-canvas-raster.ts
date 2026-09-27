// 0056 目检返工⑥：AI 整理的**图片栅格器**（canvas 版，替代返工⑤ 的 capturePage 版）。
//
// 为什么换掉 capturePage（真机探针 `scripts/probe-0056-volleyball.mjs` 实测，2026-09-24）：
//   同一道题 7 张图，隐藏窗 `capturePage(rect)` 的结果依赖**窗口可见区**与出帧状态——
//     · 排在后半页的行 → `capturePage 返回空图`（答案图 8.jpg 直接整张失败 → 用户看到的「未转写」）；
//     · 跨越可见区下沿的行 → 截回**灰底且被截断**的图（选项 A 的 `9d/20` 只剩分子 → 模型必然读错）；
//     · 同一份 76×96 CSS 的下发尺寸，在「有显示缩放 1.5×」的机器上出图 351×206 或 441 不定长。
//   canvas 路线把「画布像素」直接握在手里：`canvas.width/height` 是像素，`drawImage` 按目标尺寸
//   重采样（SVG 是矢量 → 放大到多少就锐到多少），`toDataURL('image/png')` 原样取回——
//   **与窗口大小、出帧、系统显示缩放全部无关**，也不再需要窗口可见区（`paintWhenInitiallyHidden:false`）。
//
// 页面只做两件事：① 收到 items（画布尺寸 + 内容绘制区 + 图源 data URL）→ 逐张画进 canvas → 回 PNG；
//   ② 收到带 `srcRect` 的 items（0069 配图抠图）→ 按源图内的归一化矩形裁出该区域 → 回 PNG。
// 图源两种形态统一成 data URL：公式 SVG 用 `image/svg+xml`，位图用嗅探出的真身 mime。

import { BrowserWindow } from 'electron';
import type { MontagePlan } from '../recog/ai-clean/montage.js';
import { MONTAGE_LABEL_PX } from '../recog/ai-clean/montage.js';

/** 一批要画的图（`draw` 是画布像素坐标下的内容矩形，四周留白由调用方算好） */
export interface AiCleanCanvasItem {
  key: string;
  /** 画布（= 输出 PNG）像素尺寸 */
  width: number;
  height: number;
  /** 内容绘制矩形（画布像素） */
  draw: { x: number; y: number; width: number; height: number };
  /** 图源（data URL 的两段；mime 必须是浏览器认得的图种） */
  source: { mime: string; base64: string };
  /**
   * 0069（R-075，只增可选）：**裁剪模式**——只输出源图的该矩形（0~1 归一，相对**源图自身像素**）。
   *
   * 存在时 `width`/`height`/`draw` 被忽略：输出画布 = 源矩形 × 源图内在尺寸。归一化而非像素矩形是
   * 刻意的——源图的真实像素尺寸只有画布侧知道（`naturalWidth/naturalHeight`），调用方手里的
   * 「准备后尺寸」在放大/加白边路径下 ≠ 源图尺寸，按它算像素矩形会整块偏掉。
   */
  srcRect?: { x: number; y: number; width: number; height: number };
}

export interface AiCleanCanvasOutcome {
  /** key → PNG 字节 */
  images: Map<string, Buffer>;
  failed: Array<{ key: string; error: string }>;
}

export type AiCleanCanvasRenderer = (items: AiCleanCanvasItem[]) => Promise<AiCleanCanvasOutcome>;

/** 隐藏页：暴露 `window.mfRender(items)`（逐个 try/catch，单张坏图不拖垮整批） */
const PAGE = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"></head><body><script>'
  + 'window.mfRender = async function (items) {'
  + '  const out = [];'
  + '  for (const item of items) {'
  + '    try {'
  + '      const img = new Image();'
  + '      await new Promise(function (resolve, reject) {'
  + '        img.onload = function () { resolve(null); };'
  + '        img.onerror = function () { reject(new Error("img-broken（图源载入失败）")); };'
  + '        img.src = "data:" + item.source.mime + ";base64," + item.source.base64;'
  + '      });'
  + '      if (!img.naturalWidth || !img.naturalHeight) throw new Error("img-empty（图源无内在尺寸）");'
  + '      const canvas = document.createElement("canvas");'
  + '      if (item.srcRect) {'
  // 裁剪模式（0069）：源矩形按**源图自身像素**换算（由 img 内在尺寸定），输出即裁剪产物（1:1、零重采样）
  + '        const sx = Math.min(img.naturalWidth - 1, Math.max(0, Math.round(item.srcRect.x * img.naturalWidth)));'
  + '        const sy = Math.min(img.naturalHeight - 1, Math.max(0, Math.round(item.srcRect.y * img.naturalHeight)));'
  + '        const sw = Math.max(1, Math.min(img.naturalWidth - sx, Math.round(item.srcRect.width * img.naturalWidth)));'
  + '        const sh = Math.max(1, Math.min(img.naturalHeight - sy, Math.round(item.srcRect.height * img.naturalHeight)));'
  + '        canvas.width = sw; canvas.height = sh;'
  + '        const cctx = canvas.getContext("2d");'
  + '        cctx.fillStyle = "#ffffff";'
  + '        cctx.fillRect(0, 0, sw, sh);'
  + '        cctx.imageSmoothingEnabled = true;'
  + '        cctx.imageSmoothingQuality = "high";'
  + '        cctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);'
  + '        out.push({ key: item.key, dataUrl: canvas.toDataURL("image/png") });'
  + '        continue;'
  + '      }'
  + '      canvas.width = item.width; canvas.height = item.height;'
  + '      const ctx = canvas.getContext("2d");'
  + '      ctx.fillStyle = "#ffffff";'
  + '      ctx.fillRect(0, 0, item.width, item.height);'
  + '      ctx.imageSmoothingEnabled = true;'
  + '      ctx.imageSmoothingQuality = "high";'
  + '      ctx.drawImage(img, item.draw.x, item.draw.y, item.draw.width, item.draw.height);'
  + '      out.push({ key: item.key, dataUrl: canvas.toDataURL("image/png") });'
  + '    } catch (err) {'
  + '      out.push({ key: item.key, error: String((err && err.message) || err) });'
  + '    }'
  + '  }'
  + '  return out;'
  + '};'
  + 'window.mfMontage = async function (payload) {'
  + '  try {'
  + '    const plan = payload.plan;'
  + '    const canvas = document.createElement("canvas");'
  + '    canvas.width = plan.width; canvas.height = plan.height;'
  + '    const ctx = canvas.getContext("2d");'
  + '    ctx.fillStyle = "#ffffff";'
  + '    ctx.fillRect(0, 0, plan.width, plan.height);'
  + '    ctx.textBaseline = "middle";'
  + '    for (let index = 0; index < payload.items.length; index += 1) {'
  + '      const item = payload.items[index];'
  + '      const col = index % plan.cols;'
  + '      const row = Math.floor(index / plan.cols);'
  + '      const cellX = plan.margin + col * (plan.labelCol + plan.cellWidth + plan.gap);'
  + '      const cellY = plan.margin + row * (plan.cellHeight + plan.gap);'
  + '      const drawWidth = Math.max(1, Math.round(item.width * plan.scale));'
  + '      const drawHeight = Math.max(1, Math.round(item.height * plan.scale));'
  + '      const img = new Image();'
  + '      await new Promise(function (resolve, reject) {'
  + '        img.onload = function () { resolve(null); };'
  + '        img.onerror = function () { reject(new Error("montage-img-broken（片段载入失败）")); };'
  + '        img.src = item.dataUrl;'
  + '      });'
  + '      ctx.drawImage(img, cellX + plan.labelCol, cellY, drawWidth, drawHeight);'
  + '      ctx.fillStyle = "#000000";'
  + '      ctx.font = "bold " + Math.max(12, Math.round(plan.labelPx * plan.scale)) + "px sans-serif";'
  + '      ctx.fillText(String(index + 1) + ".", cellX, cellY + drawHeight / 2);'
  + '    }'
  + '    return { dataUrl: canvas.toDataURL("image/png") };'
  + '  } catch (err) {'
  + '    return { error: String((err && err.message) || err) };'
  + '  }'
  + '};'
  + '</script></body></html>';

let sharedWindow: BrowserWindow | null = null;
let pageLoaded = false;

/** 常驻隐藏窗（进程内单例；被外部关掉时自动重建）。画布渲染不需要出帧 → 不请求 paint。 */
function getWindow(): BrowserWindow {
  if (sharedWindow !== null && !sharedWindow.isDestroyed()) return sharedWindow;
  sharedWindow = new BrowserWindow({
    show: false,
    width: 480,
    height: 320,
    paintWhenInitiallyHidden: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });
  pageLoaded = false;
  return sharedWindow;
}

/** 测试/收尾用：拆掉长驻窗（生产不调用——窗口常驻是刻意的） */
export function disposeAiCleanCanvasRasterizer(): void {
  if (sharedWindow !== null && !sharedWindow.isDestroyed()) sharedWindow.destroy();
  sharedWindow = null;
  pageLoaded = false;
}

function dataUrlToBytes(dataUrl: string): Buffer | null {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return null;
  const bytes = Buffer.from(dataUrl.slice(comma + 1), 'base64');
  return bytes.length > 0 ? bytes : null;
}

/**
 * 批量栅格化：一次 executeJavaScript 画完整批（页面常驻，不反复 loadURL）。
 * 单张失败只记该张（错误文案带回主进程记账）。
 */
export async function rasterizeAiCleanCanvas(items: AiCleanCanvasItem[]): Promise<AiCleanCanvasOutcome> {
  const outcome: AiCleanCanvasOutcome = { images: new Map(), failed: [] };
  if (items.length === 0) return outcome;

  const win = getWindow();
  if (!pageLoaded) {
    await win.loadURL(`data:text/html;base64,${Buffer.from(PAGE, 'utf8').toString('base64')}`);
    pageLoaded = true;
  }

  type Row = { key?: string; dataUrl?: string; error?: string };
  let rows: Row[];
  try {
    const payload = items.map((item) => ({
      key: item.key,
      width: item.width,
      height: item.height,
      draw: item.draw,
      source: item.source,
      // 0069：裁剪矩形必须随负载过桥（页面按它切块；漏传 = 退回全图尺寸 0×0）
      ...(item.srcRect !== undefined ? { srcRect: item.srcRect } : {}),
    }));
    rows = await win.webContents.executeJavaScript(`window.mfRender(${JSON.stringify(payload)})`) as Row[];
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    for (const item of items) outcome.failed.push({ key: item.key, error: `画布渲染失败：${reason}` });
    return outcome;
  }

  const byKey = new Map(rows.map((row) => [row.key ?? '', row]));
  for (const item of items) {
    const row = byKey.get(item.key);
    if (!row || row.error !== undefined) {
      outcome.failed.push({ key: item.key, error: row?.error ?? '画布未产出该图' });
      continue;
    }
    const bytes = row.dataUrl ? dataUrlToBytes(row.dataUrl) : null;
    if (bytes === null) {
      outcome.failed.push({ key: item.key, error: '画布产出为空' });
      continue;
    }
    outcome.images.set(item.key, bytes);
  }
  return outcome;
}

/** 拼图输入：已准备好的片段 PNG（`label` 由绘制按序号出，不从外部传） */
export interface AiCleanMontageFragment {
  key: string;
  dataUrl: string;
  width: number;
  height: number;
}

/** 拼图结果：要么一张 PNG，要么一条明确原因 */
export type AiCleanMontageOutcome = { ok: true; png: Buffer } | { ok: false; error: string };

/**
 * 拼「编号网格大图」（返工⑦：一题内多张公式图拼成一张，一次调用取回全部）。
 * 版式由 `planMontage`（纯函数）算好；这里只负责画（片段居中格左上对齐 + 左侧行号）。
 */
export async function rasterizeAiCleanMontage(
  fragments: AiCleanMontageFragment[],
  plan: MontagePlan,
): Promise<AiCleanMontageOutcome> {
  if (fragments.length === 0) return { ok: false, error: '拼图无片段' };
  const win = getWindow();
  if (!pageLoaded) {
    await win.loadURL(`data:text/html;base64,${Buffer.from(PAGE, 'utf8').toString('base64')}`);
    pageLoaded = true;
  }
  try {
    const payload = {
      plan: { ...plan, labelPx: MONTAGE_LABEL_PX },
      items: fragments.map((fragment) => ({
        dataUrl: fragment.dataUrl,
        width: fragment.width,
        height: fragment.height,
      })),
    };
    const result = await win.webContents.executeJavaScript(`window.mfMontage(${JSON.stringify(payload)})`) as
      { dataUrl?: string; error?: string };
    if (result?.error !== undefined) return { ok: false, error: result.error };
    const bytes = result?.dataUrl ? dataUrlToBytes(result.dataUrl) : null;
    if (bytes === null) return { ok: false, error: '拼图画布产出为空' };
    return { ok: true, png: bytes };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `拼图渲染失败：${reason}` };
  }
}
