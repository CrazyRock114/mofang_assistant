// 0004-fix-5 P0-2：图换位锚点换算（renderer 侧纯模块，引擎同源）。
// 拖拽落点 = 段边界锚位（anchorIndex），本模块负责：
// ①求当前视觉序与各图当前边界（引擎 buildRenderSegments 同源，含无锚旧数据的槽位语义）；
// ②落点 → 全量覆盖数组：**物化锚点**（所有条目写 anchorIndex + orderIndex=视觉序），
//   避免「有锚/无锚条目混用」时未锚条目回退原位导致其它图跳动；
// ③被移动图落在目标边界上已有图之后（指示线语义：贴在该边界前）。

import type { Question, QuestionFigureLayout } from '../../shared/contracts/bank-types.js';
import {
  planQuestionFigures,
  applyFigureOverrides,
  buildRenderSegments,
  buildImageTypeTable,
  normalizeAssetId,
} from '../../docgen/render/figureBlocks.js';

/** 位置换算只需图块归属，不关心对齐/宽度/版式（中性全局档） */
const NEUTRAL_LAYOUT = { mode: 'inline' as const, align: 'center' as const, widthPercent: null };

export interface FigureVisualState {
  /** 当前视觉序（assetId 归一形态） */
  order: string[];
  /** 各图当前边界（显式锚位或原位段下标） */
  boundaryOf: Record<string, number>;
  /** 可落点边界数（0..boundaryCount） */
  boundaryCount: number;
}

/** 当前视觉序 + 各图边界（引擎同源纯函数；无覆盖/旧 orderIndex 数据同样适用） */
export function figureVisualState(
  content: string,
  images: Question['images'],
  figures?: QuestionFigureLayout[]
): FigureVisualState {
  const plan = planQuestionFigures(content, buildImageTypeTable(images ?? []), figures);
  const specs = applyFigureOverrides(plan.figures, NEUTRAL_LAYOUT, figures);
  const order: string[] = [];
  const boundaryOf: Record<string, number> = {};
  for (const segment of buildRenderSegments(plan.segments, specs)) {
    if (segment.kind !== 'figure') continue;
    const raw = segment.spec.figure.assetId;
    if (raw === null) continue;
    const id = normalizeAssetId(raw) ?? raw;
    order.push(id);
    boundaryOf[id] = segment.spec.anchorIndex !== null
      ? segment.spec.anchorIndex
      : (plan.homeBoundary.get(segment.spec.figure) ?? plan.boundaryCount);
  }
  return { order, boundaryOf, boundaryCount: plan.boundaryCount };
}

/**
 * 拖拽落点 → 该题全量覆盖数组（整体覆盖式写入，与 QuestionFigureSettings 同构）。
 * 保留既有条目字段（宽度/对齐/版式）；movedAssetId 落 anchorIndex=target，其余条目物化当前边界。
 */
export function figuresAfterAnchorMove(
  content: string,
  images: Question['images'],
  current: QuestionFigureLayout[] | undefined,
  movedAssetId: string,
  anchorIndex: number
): QuestionFigureLayout[] {
  const { order, boundaryOf, boundaryCount } = figureVisualState(content, images, current);
  const byAsset = new Map<string, QuestionFigureLayout>();
  for (const entry of current ?? []) {
    byAsset.set(normalizeAssetId(entry.assetId) ?? entry.assetId, entry);
  }
  const movedId = normalizeAssetId(movedAssetId) ?? movedAssetId;
  const target = Math.min(boundaryCount, Math.max(0, Math.round(anchorIndex)));
  const rest = order.filter((id) => id !== movedId);
  // 插入位 = 目标边界上已有图**之前**（指示线画在 marker 处 = 该边界图块组之上）
  let at = rest.length;
  for (let i = 0; i < rest.length; i++) {
    if ((boundaryOf[rest[i]] ?? boundaryCount) >= target) {
      at = i;
      break;
    }
  }
  const next = [...rest.slice(0, at), movedId, ...rest.slice(at)];
  return next.map((id, index) => {
    const prev = byAsset.get(id);
    return {
      ...(prev ?? {}),
      assetId: prev ? prev.assetId : id,
      orderIndex: index,
      anchorIndex: id === movedId ? target : (boundaryOf[id] ?? target),
    };
  });
}
