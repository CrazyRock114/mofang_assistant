// 0070（R-052）：多帧卡识别——「先拼后识」。
//
// 断点（0046 目检登记）：一道题被分页/分栏切成两半时，用户在左栏框两处并「并入最新待识别题」
// 归成一张卡；但识别只取 `frames[0]`，第二框起的内容被静默丢弃。本模块把多帧卡
// **逐帧裁剪 → 纵向拼成一张 → 走既有单图识别链**（`recognizeRegion` 的「已有图送 extract」段）：
//   · 一次模型调用看全题（一题两次并发调用最易在免费通道翻车，与 0036 跨页挂同一口径）；
//   · 布局随结果回传（`sentMap`）——模型给的图块坐标是**相对这张拼接图**归一的，上层据此换算回
//     「各帧所在页」的页坐标（乙方案：`figure-map.ts`），题卡/左栏红框/拖动重裁才都自洽。
//
// 口径（任务书 §一 + 2026-09-25 用户目检）：
//   · 帧序 = frames 数组顺序（框选/并入顺序）；每帧按**自己的 pageNo** 取页图、按自己的 rect 裁剪，
//     跨页帧天然支持。不做帧序调整 UI（要改顺序 = 删掉重框）。
//   · 拼接图是临时产物：不落资产、不入库；题卡只保留首帧用于溯源（`draftToCard` 的 frame 选项）。
//   · 失败一律 ok:false + 人读原因（不静默丢帧；少一帧的识别会产出缺内容的题卡，还花掉用户的 token）。

import type { AiInvokePayload, AiInvokeResult } from '../../shared/contracts/ai-types.js';
import type { OnestepDraft, OnestepExtractContext, WorkbenchFrame, WorkbenchMode, WorkbenchRect } from '../../shared/contracts/onestep-types.js';
import { cropNormalizedRect, loadPageImage, type CropOutcome, type PageImageLike } from './crop.js';
import { buildSentMap, type SentMap } from './figure-map.js';
import { recognizeImage, splitDataUrl, type RecognizeImageInput, type RecognizeModelRoles } from './recognize.js';
import type { CroppedImage, StitchFn } from '../splitting/run-launch.js';

/** 单帧裁剪器（渲染层缺省 = canvas 裁图；探针/单测可注入——须与实现同口径：归一化矩形 → PNG） */
export type FrameCropFn = (page: PageImageLike, rect: WorkbenchRect) => CropOutcome;

export interface StitchRecognizeRequest {
  /** 待识别卡的框选帧（≥2；单帧不走本函数） */
  frames: WorkbenchFrame[];
  /** 页号 → 可裁页图（缺 = 该页图未就绪，逐帧各取自己的页） */
  pageImageOf: (pageNo: number) => PageImageLike | undefined;
  /** 拼接器（渲染层传 `createStitcher()`；与 0036 跨页题同一实现同一口径） */
  stitch: StitchFn;
  mode: WorkbenchMode;
  invoke: (payload: AiInvokePayload) => Promise<AiInvokeResult>;
  roles?: RecognizeModelRoles;
  context?: OnestepExtractContext;
  /** 裁剪器（缺省 = 应用真裁图，与单帧路径同一函数） */
  crop?: FrameCropFn;
  /** 拼接图 data URL → 可裁源（缺省 = `loadPageImage(url, 'memory')`；图块回填裁图直接用它） */
  decode?: (dataUrl: string) => Promise<PageImageLike>;
}

export type StitchRecognizeOutcome =
  | {
      ok: true;
      drafts: OnestepDraft[];
      /** 送模型的那张拼接图（可裁源；换算失败时上层退化为直接从它裁） */
      sentImage: PageImageLike;
      sentWidth: number;
      sentHeight: number;
      /**
       * 送图布局（0070 乙方案：把模型给的「相对拼接图」坐标换算回各帧所在页）。
       * 与真拼接图尺寸不符 / 页尺寸缺失时为 null —— 调用方**保留送图坐标并显式告警**（不静默）。
       */
      sentMap: SentMap | null;
    }
  | { ok: false; error: string };

/**
 * 多帧卡：逐帧裁剪 → 纵向拼接 → 单图识别。
 * 任一帧裁不出来就整体失败（宁可不给结果，也不发出一次「少了一帧」的识别）。
 */
export async function recognizeStitchedFrames(request: StitchRecognizeRequest): Promise<StitchRecognizeOutcome> {
  const crop = request.crop ?? cropNormalizedRect;
  const parts: CroppedImage[] = [];
  /** 逐帧页尺寸（拼图布局换算用；与裁剪同一次取图，不重复查） */
  const pageSizes = new Map<number, { width: number; height: number }>();
  for (const frame of request.frames) {
    const page = request.pageImageOf(frame.pageNo);
    if (!page) {
      return { ok: false, error: `第 ${frame.pageNo} 页图尚未就绪（或本会话没有可裁的原始图片字节）` };
    }
    pageSizes.set(frame.pageNo, { width: page.naturalWidth, height: page.naturalHeight });
    const cropped = crop(page, frame.rect);
    if (!cropped.ok) {
      return { ok: false, error: `第 ${frame.pageNo} 页裁剪失败：${cropped.reason}` };
    }
    try {
      const { mime, dataBase64 } = splitDataUrl(cropped.dataUrl);
      parts.push({ mime, dataBase64 });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  let stitched: CroppedImage;
  try {
    stitched = await request.stitch(parts);
  } catch (err) {
    return { ok: false, error: `拼接失败：${err instanceof Error ? err.message : String(err)}` };
  }

  const mime = stitched.mime || 'image/png';
  const dataUrl = `data:${mime};base64,${stitched.dataBase64}`;
  const decode = request.decode ?? ((url: string): Promise<PageImageLike> => loadPageImage(url, 'memory'));
  let sentImage: PageImageLike;
  try {
    // 拼接图要当可裁源（图块回填）——宽高从这张图自己来，不做任何坐标映射
    sentImage = await decode(dataUrl);
  } catch (err) {
    return { ok: false, error: `拼接图解码失败：${err instanceof Error ? err.message : String(err)}` };
  }

  const image: RecognizeImageInput = {
    dataBase64: stitched.dataBase64,
    mime,
    // 溯源页号 = 首帧所在页（跨页卡没有单一页号；入库 sourceDetail.pageNo 取首帧口径）
    pageNo: request.frames[0]!.pageNo,
    width: sentImage.naturalWidth,
    height: sentImage.naturalHeight,
  };
  const outcome = await recognizeImage({
    image,
    mode: request.mode,
    invoke: request.invoke,
    ...(request.roles ? { roles: request.roles } : {}),
    ...(request.context ? { context: request.context } : {}),
  });
  if (!outcome.ok) return { ok: false, error: outcome.error };

  // 0070 乙方案：布局换算锚（拿真拼接图尺寸对账——不符就当拿不到布局，交给上层保留原坐标并告警）
  const built = buildSentMap(request.frames, (pageNo) => pageSizes.get(pageNo));
  const sentMap = built && built.width === sentImage.naturalWidth && built.height === sentImage.naturalHeight ? built : null;

  return {
    ok: true,
    drafts: outcome.drafts,
    sentImage,
    sentWidth: outcome.sentWidth,
    sentHeight: outcome.sentHeight,
    sentMap,
  };
}
