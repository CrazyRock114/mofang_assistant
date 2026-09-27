// 0056（R-041）AI 整理：**图片准备层**——把靶资产变成「视觉模型能读、且看得清」的 data。
//
// 版本脉络（每一条都是真机/真库实证换来的，改前先读）：
//   ①（2026-09-23）真机 400 `code 20015 image_url provided is not a valid image.`：
//     学科网/组卷公式图**天生是 SVG**，OpenAI 兼容视觉端点不收 `image/svg+xml` → 必须栅格化成 PNG；
//     位图则**嗅探真身**取 mime（不信扩展名）。
//   ③（施工参考 §2.2）DeepSeek-OCR 硬门槛：图片最短边 > 28px（线上口径 ≥56px）→ 小位图先放大。
//   ⑤（用户假设）公式图字形紧贴声明框 → 送模型前加白边。
//   ⑥（2026-09-24 真机探针）⑤ 的留白实现有两个硬伤，本版重做：
//      a) 留白**只扩了画布**：内容仍按 SVG 声明尺寸（13×28 就是 13×28 px）画，等于把公式缩小后丢进大白框；
//      b) 栅格器用隐藏窗 `capturePage(rect)`：截取依赖窗口可见区与出帧——
//         排在页尾的答案图整张 `capturePage 返回空图`（用户看到的「未转写」），
//         跨可见区下沿的选项图截回**灰底 + 下半截被裁**（`9d/20` 只剩分子 → 模型必然读错），
//         且下发尺寸会被系统显示缩放再乘一遍（76×96 CSS 在 1.5× 机器上出图不定长）。
//      ⇒ 本版：尺寸全部按**最终像素**算（与 CSS/缩放无关），渲染走 canvas（`ai-clean-canvas-raster.ts`）：
//        · 小图/公式：内容长边放大到 AI_CLEAN_CONTENT_LONG_EDGE_PX（矢量放大不糊），四周加 18% 白边；
//        · 小位图：最短边抬到 ≥56px（倍数上限 6× 防爆）后再加白边；
//        · 大图（内容长边 > 400px）：**原样过桥**（1:1、零重编码；自带留白，加边只会白增体积/降分辨率）；
//        · 超长（> 1800px）：canvas 等比收敛到上限（防体积失控）。
//
// 纪律：本层只在主进程用（渲染器要 Electron 窗口）；编排层只依赖注入面（`prepareImages`），
// 故单测注入替身即可（`dist` 无 Electron 也能跑纯逻辑）。

import type { AiCleanCanvasItem, AiCleanCanvasRenderer } from './ai-clean-canvas-raster.js';
import { rasterizeAiCleanCanvas } from './ai-clean-canvas-raster.js';
import { svgIntrinsicSize } from '../docgen/export/docx/svg-raster.js';
import { mimeOfFormat, sniffImageType } from '../recog/ai-clean/image-format.js';

/** 小图/公式的**内容长边**目标（最终像素）：矢量放大不糊，给模型留足字形细节 */
export const AI_CLEAN_CONTENT_LONG_EDGE_PX = 300;
/** 内容长边 ≤ 此值才加白边（大图自带留白；加边只会白增体积） */
export const AI_CLEAN_PAD_MAX_CONTENT_PX = 400;
/** 白边比例（按内容长边） */
export const AI_CLEAN_PAD_RATIO = 0.18;
export const AI_CLEAN_PAD_MIN_PX = 18;
export const AI_CLEAN_PAD_MAX_PX = 144;
/**
 * 位图最短边下限（px）：DeepSeek-OCR 类专用 OCR 模型硬门槛是 >28px，线上口径取 56（施工参考 §2.2）。
 */
export const AI_CLEAN_MIN_EDGE_PX = 56;
/** 小位图放大倍数上限（防 5×2 这类被拉到怪物尺寸：放大只会更糊） */
export const AI_CLEAN_MAX_UPSCALE = 6;
/** 送模型 PNG 的最终长边上限（px）：防大图遗留体积失控 */
export const AI_CLEAN_MAX_LONG_EDGE_PX = 1800;

/** 待准备的一张图（编排层读盘后交过来；`key` 与靶缓存键一致 = `${kind}:${assetRelPath}`） */
export interface AiCleanImageRequest {
  key: string;
  assetRelPath: string;
  bytes: Buffer;
  /** 调用方按扩展名猜的 mime（本层只作参考，不作结论） */
  mime: string;
  /** 版式给的显示尺寸（DOM data-w/data-h；0 = 未知；SVG 无内在尺寸时兜底用） */
  width: number;
  height: number;
}

export interface AiCleanPreparedImage {
  dataBase64: string;
  mime: string;
  /** 人读处理说明（进告警/诊断；如「公式图放大 10.7× → 546×300 内容 + 留白 54px」） */
  note?: string;
  /** 最终像素尺寸（返工⑦：公式靶「拼大图」排版要按各片段真实尺寸摆位） */
  width?: number;
  height?: number;
}

/** 结果：要么可发送的 data，要么一条明确原因（调用方记账，题级判失败） */
export type AiCleanImagePrepared = AiCleanPreparedImage | { error: string };

export type AiCleanImagePreparer = (
  requests: AiCleanImageRequest[],
) => Promise<Map<string, AiCleanImagePrepared>>;

/** 位图取尺寸（Electron nativeImage 缺省实现；测试注入替身；null = 环境不支持 → 原样过桥） */
export interface AiCleanRasterMeasure {
  sizeOf(bytes: Buffer): { width: number; height: number } | null;
}

export interface AiCleanImagePrepDeps {
  /** 画布栅格器（缺省电子实现：隐藏窗 canvas；测试注入替身） */
  renderCanvas?: AiCleanCanvasRenderer;
  /** 位图量尺（缺省 Electron nativeImage；传 null 强制「取不到尺寸」路径） */
  measureRaster?: AiCleanRasterMeasure | null;
  /** 内容长边目标（最终像素；缺省 AI_CLEAN_CONTENT_LONG_EDGE_PX） */
  contentLongEdgePx?: number;
  /** 送模型长边上限（px；缺省 AI_CLEAN_MAX_LONG_EDGE_PX） */
  maxLongEdgePx?: number;
}

/** 一张图的下发方案（canvas 口径；纯函数可单测） */
export interface AiCleanCanvasPlan {
  /** 画布（= 输出 PNG）像素尺寸 */
  width: number;
  height: number;
  /** 内容绘制矩形（画布像素） */
  draw: { x: number; y: number; width: number; height: number };
  /** 内容缩放比（1 = 原尺寸；>1 放大；<1 = 收敛到上限） */
  scale: number;
  /** 白边宽度（画布像素；0 = 未加） */
  pad: number;
  /** 人读说明 */
  note: string;
}

export interface PlanCanvasOptions {
  contentLongEdgePx?: number;
  padMaxContentPx?: number;
  padRatio?: number;
  padMinPx?: number;
  padMaxPx?: number;
  maxLongEdgePx?: number;
  /** 缩放上限（位图用；SVG 是矢量不设限） */
  maxUpscale?: number;
  /** 量词（进 note：'公式图' / '位图'） */
  label?: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 算一张图的画布方案（纯函数）：
 *   放大（仅当内容长边不足目标） → 按比例加白边（仅当内容长边 ≤ 阈值） → 超上限则整体收敛。
 * 「原尺寸 1:1」在 `scale=1 && pad=0` 时成立——大图会走原样过桥，不经本函数。
 */
export function planCanvasBox(
  content: { width: number; height: number },
  options: PlanCanvasOptions = {},
): AiCleanCanvasPlan {
  const target = options.contentLongEdgePx ?? AI_CLEAN_CONTENT_LONG_EDGE_PX;
  const padMaxContent = options.padMaxContentPx ?? AI_CLEAN_PAD_MAX_CONTENT_PX;
  const padRatio = options.padRatio ?? AI_CLEAN_PAD_RATIO;
  const padMin = options.padMinPx ?? AI_CLEAN_PAD_MIN_PX;
  const padMax = options.padMaxPx ?? AI_CLEAN_PAD_MAX_PX;
  const maxLongEdge = options.maxLongEdgePx ?? AI_CLEAN_MAX_LONG_EDGE_PX;
  const maxUpscale = options.maxUpscale ?? Number.POSITIVE_INFINITY;
  const label = options.label ?? '图';

  const rawWidth = content.width > 0 ? content.width : 1;
  const rawHeight = content.height > 0 ? content.height : 1;
  const longEdge = Math.max(rawWidth, rawHeight);
  const scale = Math.min(
    longEdge >= target ? 1 : target / longEdge,
    maxUpscale,
  );
  let innerWidth = Math.max(1, Math.round(rawWidth * scale));
  let innerHeight = Math.max(1, Math.round(rawHeight * scale));
  let pad = Math.max(innerWidth, innerHeight) <= padMaxContent
    ? clamp(Math.round(Math.max(innerWidth, innerHeight) * padRatio), padMin, padMax)
    : 0;
  // 超上限 → 整体等比收敛（内容与白边同缩，比例不变）
  let shrink = 1;
  const boxLongEdge = Math.max(innerWidth, innerHeight) + pad * 2;
  if (boxLongEdge > maxLongEdge) {
    shrink = maxLongEdge / boxLongEdge;
    innerWidth = Math.max(1, Math.round(innerWidth * shrink));
    innerHeight = Math.max(1, Math.round(innerHeight * shrink));
    pad = Math.floor(pad * shrink);
  }
  const width = innerWidth + pad * 2;
  const height = innerHeight + pad * 2;
  /** 内容相对原图的**最终**缩放比（含超上限收敛） */
  const effectiveScale = scale * shrink;
  const grew = Math.abs(effectiveScale - 1) > 0.01;
  const note = [
    `${label}${grew ? `缩放 ${effectiveScale.toFixed(2)}×` : '原尺寸'} ${Math.round(rawWidth)}×${Math.round(rawHeight)} → 内容 ${innerWidth}×${innerHeight}`,
    pad > 0 ? `留白 ${pad}px（四周白边，防字形贴边被裁）` : '无留白（大图 1:1 过桥）',
    `输出 ${width}×${height}px`,
  ].join(' · ');
  return {
    width,
    height,
    draw: { x: pad, y: pad, width: innerWidth, height: innerHeight },
    scale: effectiveScale,
    pad,
    note,
  };
}

/** 缺省位图量尺（Electron nativeImage；非 Electron 环境/取不到图 → null，调用方原样过桥）
 *  —— `require` 懒取（同本仓 ipc.ts 取 clipboard 的手法）：本模块被 ipc/main 静态引用，
 *  若在模块顶层 `import { nativeImage }`，任何 mock 掉 electron 的测试（未导出该字段）都会在
 *  「导入链」阶段直接报错；懒取 + try/catch 把风险收在本函数内。 */
function defaultRasterMeasure(): AiCleanRasterMeasure | null {
  let nativeImage: typeof import('electron').nativeImage | undefined;
  try {
    nativeImage = (require('electron') as typeof import('electron')).nativeImage;
  } catch {
    return null;
  }
  if (!nativeImage || typeof nativeImage.createFromBuffer !== 'function') return null;
  return {
    sizeOf(bytes) {
      try {
        const image = nativeImage.createFromBuffer(bytes);
        const size = image.getSize();
        return size.width > 0 && size.height > 0 ? size : null;
      } catch {
        return null;
      }
    },
  };
}

/** SVG 是否自带尺寸声明（viewBox 或数字 width；`width="100%"` 这类比例尺寸不算） */
function hasExplicitSize(svgText: string): boolean {
  return /viewBox\s*=/i.test(svgText) || /<svg\b[^>]*[\s"']width\s*=\s*"\s*[\d.]+/i.test(svgText);
}

/**
 * SVG 内在尺寸：自带尺寸声明 → 用它（0035 的 `svgIntrinsicSize` 解析 viewBox/width/height）；
 * 没声明（比例尺寸产物）→ 退回**版式给的显示尺寸**（`data-w/data-h` 是站点自己的排版依据，
 * 比 0035 的 300×150 缺省更贴真）；再没有 → 300×150 兜底。
 */
export function svgContentSize(
  svgText: string,
  declared?: { width: number; height: number },
): { width: number; height: number } {
  const intrinsic = svgIntrinsicSize(svgText);
  const usable = intrinsic.width > 0 && intrinsic.height > 0 ? intrinsic : null;
  if (usable !== null && hasExplicitSize(svgText)) return usable;
  if (declared && declared.width > 0 && declared.height > 0) {
    return { width: declared.width, height: declared.height };
  }
  return usable ?? { width: 300, height: 150 };
}

/**
 * 造一个图片准备器。
 * SVG → canvas（放大 + 留白 → PNG）；位图 → 小图放大加白边走 canvas、大图原样过桥（嗅探 mime）、
 * 超长图收敛到上限；非图片字节 → error。
 */
export function createAiCleanImagePreparer(deps: AiCleanImagePrepDeps = {}): AiCleanImagePreparer {
  const renderCanvas = deps.renderCanvas ?? rasterizeAiCleanCanvas;
  const measureRaster = deps.measureRaster === undefined ? defaultRasterMeasure() : deps.measureRaster;
  const planOptions: PlanCanvasOptions = {
    contentLongEdgePx: deps.contentLongEdgePx ?? AI_CLEAN_CONTENT_LONG_EDGE_PX,
    maxLongEdgePx: deps.maxLongEdgePx ?? AI_CLEAN_MAX_LONG_EDGE_PX,
  };

  return async (requests: AiCleanImageRequest[]): Promise<Map<string, AiCleanImagePrepared>> => {
    const out = new Map<string, AiCleanImagePrepared>();
    const canvasItems: AiCleanCanvasItem[] = [];
    const notes = new Map<string, string>();

    for (const request of requests) {
      const format = sniffImageType(request.bytes);
      if (format === 'unknown') {
        out.set(request.key, {
          error: `资产不是图片（${request.assetRelPath}：字节既非 PNG/JPEG/GIF/WEBP，也非 SVG）`,
        });
        continue;
      }
      if (format === 'svg') {
        const plan = planCanvasBox(
          svgContentSize(request.bytes.toString('utf8'), { width: request.width, height: request.height }),
          { ...planOptions, label: '公式图' },
        );
        canvasItems.push({
          key: request.key,
          width: plan.width,
          height: plan.height,
          draw: plan.draw,
          source: { mime: 'image/svg+xml', base64: request.bytes.toString('base64') },
        });
        notes.set(request.key, plan.note);
        continue;
      }
      // 位图：先量尺（量不到 → 原样过桥记账，不静默丢图）
      const size = measureRaster?.sizeOf(request.bytes) ?? null;
      if (size === null) {
        out.set(request.key, {
          dataBase64: request.bytes.toString('base64'),
          mime: mimeOfFormat(format),
          note: '当前环境取不到位图尺寸（原样送出：无留白、未放大）',
        });
        continue;
      }
      const longEdge = Math.max(size.width, size.height);
      // 大图（长边 > 留白阈值且不超上限）→ 原样过桥：零重编码、零失真（答案/解析整图走这条）
      if (longEdge > AI_CLEAN_PAD_MAX_CONTENT_PX && longEdge <= (planOptions.maxLongEdgePx ?? AI_CLEAN_MAX_LONG_EDGE_PX)) {
        out.set(request.key, {
          dataBase64: request.bytes.toString('base64'),
          mime: mimeOfFormat(format),
          note: `位图原样过桥 ${size.width}×${size.height}（1:1、零重编码；大图自带留白）`,
          width: size.width,
          height: size.height,
        });
        continue;
      }
      const plan = planCanvasBox(size, {
        ...planOptions,
        maxUpscale: AI_CLEAN_MAX_UPSCALE,
        label: '位图',
      });
      // 硬门槛兜底：放大后最短边仍 < 56px（极端细长图）→ 记账提醒（不阻断，模型侧另有长度门槛）
      const shortEdge = Math.min(plan.draw.width, plan.draw.height);
      canvasItems.push({
        key: request.key,
        width: plan.width,
        height: plan.height,
        draw: plan.draw,
        source: { mime: mimeOfFormat(format), base64: request.bytes.toString('base64') },
      });
      notes.set(
        request.key,
        `${plan.note}${shortEdge < AI_CLEAN_MIN_EDGE_PX ? ` · 注意：最短边 ${shortEdge}px < 模型硬门槛 ${AI_CLEAN_MIN_EDGE_PX}px` : ''}`,
      );
    }

    if (canvasItems.length > 0) {
      const result = await renderCanvas(canvasItems);
      for (const item of canvasItems) {
        const png = result.images.get(item.key);
        if (png && png.length > 0) {
          out.set(item.key, {
            dataBase64: png.toString('base64'),
            mime: 'image/png',
            note: notes.get(item.key),
            width: item.width,
            height: item.height,
          });
          continue;
        }
        const failure = result.failed.find((entry) => entry.key === item.key);
        out.set(item.key, { error: `栅格化失败：${failure?.error ?? '未产出 PNG'}` });
      }
    }

    return out;
  };
}
