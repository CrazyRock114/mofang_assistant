// 0036 P3：识别衔接——「一题一 run」的发起层（渲染层编排，纯逻辑 + 注入 IO）
//
// 分工：
//   planQuestionRun  纯函数：框 → 每页一张裁剪计划（跨页题出多张，页序升序）
//   launchQuestionRun 编排：逐页裁剪 → 过桥 recog.run.create（sourceKind='pdf-split'）
//
// **只送裁剪小图**（任务书 §一 P3 / 规划 T7 差异化点）：竞品把整页 base64 上传、服务端再裁，
// 我们本地裁完只送题目那一块——免费路线的 token 成本差距就在这里。
//
// 跨页题（2026-09-18 目检案底）：一题跨两页时**本地拼成一张图**再送，而不是一页一张素材。
// 一页一张 = 两次并发 vision 调用（免费通道的并发/限流最容易在这里翻车）+ 引擎还得靠跨页
// stitching 猜续接；拼成一张后：一次调用、模型一次看全题、token 减半、续接不再靠猜。
//
// 裁剪失败/无框/页尺寸缺失一律**整体失败**：宁可不给 run，也不发出一次「少了一页」的识别
// （少页的 run 会产出缺答案的题卡，而且消耗的是用户的 token）。

import type { MofangRecogBridge } from '../../shared/contracts/bridge.js';
import type { RecogMaterial } from '../../shared/contracts/recog-run-types.js';
import type { SplitBox } from '../../shared/contracts/split-types.js';
import { cropPlansForQuestion, type CropPlan, type PageSize } from '../../recog/splitting/box-model.js';

/** 裁剪产物（mime 固定 png：vision 通道对 png 无损，且比 jpeg 少一层压缩伪影） */
export interface CroppedImage {
  dataBase64: string;
  mime: string;
}

/** 裁剪器：渲染层实现为 canvas 裁切；测试注入假实现（本层不碰 DOM） */
export type CropFn = (page: number, rect: CropPlan['rect']) => Promise<CroppedImage>;

/**
 * 拼接器：把同一道题的多页裁剪按**阅读顺序**纵向拼成一张图（渲染层 canvas 实现）。
 * 只在跨页题（卡片数 > 1）时调用；不提供拼接器而遇到跨页题会明确报错——
 * 静默降级回「一页一张素材」会原样复现目检案底，不如让调用方把拼接器给全。
 */
export type StitchFn = (parts: CroppedImage[]) => Promise<CroppedImage>;

export interface QuestionRunPlan {
  qid: string;
  cards: CropPlan[];
  /** 素材名（与 cards 同序）：q1-p3.png —— 页号进名字，日志/溯源能直接对上页 */
  materials: string[];
}

/**
 * 素材名（溯源用）：单页题 `q1-p3.png`；跨页题 `q1-p13-14.png`（拼接图覆盖的原 PDF 页都写进去）。
 * 单素材 run 会把它当 sourceName 落库，所以名字本身就是这道题与 PDF 的对应关系。
 */
export function materialName(qid: string, pages: number[]): string {
  return `${qid}-p${pages.join('-')}.png`;
}

/**
 * 纯计划：框 → 裁剪计划。无框或页尺寸缺失即抛（原因直接给用户看）。
 */
export function planQuestionRun(boxes: SplitBox[], qid: string, pageSizes: Map<number, PageSize>): QuestionRunPlan {
  const own = boxes.filter((b) => b.qid === qid);
  if (own.length === 0) {
    throw new Error(`题目 ${qid} 没有可识别的框（先画框再识别）`);
  }
  const cards = cropPlansForQuestion(own, pageSizes);
  if (cards.length === 0) {
    const pages = [...new Set(own.map((b) => b.page))].join('、');
    throw new Error(`题目 ${qid} 的页尺寸未知（第 ${pages} 页尚未栅格化，先把页面加载出来）`);
  }
  return { qid, cards, materials: [materialName(qid, cards.map((c) => c.page))] };
}

export interface LaunchQuestionRunInput {
  boxes: SplitBox[];
  qid: string;
  pageSizes: Map<number, PageSize>;
  crop: CropFn;
  recog: MofangRecogBridge;
  /** 跨页题的拼接器（渲染层注入 canvas 实现）；单页题不需要 */
  stitch?: StitchFn;
}

/**
 * 发起一题的识别 run：裁剪（跨页则拼接）→ 素材 → recog.run.create（立即返回 runId，进度看 recog.event）。
 * 一题一 run：runId 由调用方写进段草稿（SplitRunLink），断点续跑与结果回写都靠它。
 */
export async function launchQuestionRun(input: LaunchQuestionRunInput): Promise<{ runId: string; pageCount: number }> {
  const plan = planQuestionRun(input.boxes, input.qid, input.pageSizes);

  const parts: CroppedImage[] = [];
  for (const card of plan.cards) {
    try {
      parts.push(await input.crop(card.page, card.rect));
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      throw new Error(`第 ${card.page} 页裁剪失败：${why}`);
    }
  }

  let image: CroppedImage;
  if (parts.length === 1) {
    image = parts[0];
  } else {
    if (!input.stitch) {
      throw new Error(`题目 ${input.qid} 跨 ${parts.length} 页，但调用方未提供拼接器（拒绝降级为多素材：会引发多次并发识别调用）`);
    }
    try {
      image = await input.stitch(parts);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      throw new Error(`跨页拼接失败：${why}`);
    }
  }

  const materials: RecogMaterial[] = [{
    name: plan.materials[0],
    mime: image.mime || 'image/png',
    dataBase64: image.dataBase64,
  }];

  const created = await input.recog.create({ materials, sourceKind: 'pdf-split' });
  return { runId: created.runId, pageCount: created.pageCount };
}
