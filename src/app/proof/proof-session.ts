// C1 Phase 1: 校对会话状态迁移（纯 reducer，无 DOM；状态在 renderer 内存，不落库）
// 状态机：pending → ok/split/merge/delete；split/merge 产生新 ProofItem（source:'manual'，算法在 src/recog/proof.ts）
// delete 不物理移除：标记 status='delete'，UI 置灰展示并可恢复（审计留痕）

import type { ProofAction, ProofItem } from '../../shared/contracts/recog-ui-types.js';
import { mergeDrafts, plainTextOf, splitDraft } from '../../recog/proof.js';

export interface ApplyResult {
  items: ProofItem[];
  error?: string;
}

export function applyProofAction(items: ProofItem[], action: ProofAction): ApplyResult {
  switch (action.type) {
    case 'markOk': {
      return { items: items.map((it) => (it.draftId === action.draftId ? { ...it, status: action.ok ? 'ok' : 'pending' } : it)) };
    }
    case 'delete': {
      return { items: items.map((it) => (it.draftId === action.draftId ? { ...it, status: 'delete' } : it)) };
    }
    case 'rescore': {
      return {
        items: items.map((it) => {
          if (it.draftId !== action.draftId) return it;
          const next = { ...it };
          if (action.score === undefined) delete next.score;
          else next.score = action.score;
          return next;
        }),
      };
    }
    case 'split': {
      const idx = items.findIndex((it) => it.draftId === action.draftId);
      if (idx === -1) return { items, error: `条目 ${action.draftId} 不存在` };
      const draft = items[idx];

      // 断点区位判定（纯文本视角，与 splitDraft 的字段优先序一致：content 先于 analysis）：
      // atText 命中 analysisHtml 且不命中 contentHtml → 解析区拆分，拆出物是"下一题的解析"
      const inContent = plainTextOf(draft.contentHtml).includes(action.atText);
      const inAnalysis =
        !inContent && draft.analysisHtml !== undefined && plainTextOf(draft.analysisHtml).includes(action.atText);

      if (action.intoDraftId !== undefined && !inAnalysis) {
        return { items, error: '断点不在解析区，无法并入已有题（并入仅用于解析区拆分）' };
      }

      // 解析区拆分 + 并入已有条目：后段解析移交目标条目，不产生新条目，不校验题号撞号
      if (inAnalysis && action.intoDraftId !== undefined) {
        const targetIdx = items.findIndex((it) => it.draftId === action.intoDraftId);
        if (targetIdx === -1) return { items, error: `并入目标 ${action.intoDraftId} 不存在` };
        if (targetIdx === idx) return { items, error: '并入目标不能是拆分源自身' };

        const result = splitDraft(draft, action.atText);
        if (!result.ok) return { items, error: result.error };

        const target = items[targetIdx];
        const moved = result.second.analysisHtml ?? '';
        const mergedTarget: ProofItem = {
          ...target,
          ...(target.analysisHtml !== undefined || moved ? { analysisHtml: (target.analysisHtml ?? '') + moved } : {}),
          imageRefIds: [...new Set([...target.imageRefIds, ...result.second.imageRefIds])],
          rawText: result.second.rawText ? `${target.rawText}\n${result.second.rawText}` : target.rawText,
          status: 'pending', // 解析被改动，须重新校对
        };
        return { items: items.map((it, i) => (i === idx ? result.first : i === targetIdx ? mergedTarget : it)) };
      }

      // 新建条目（含解析区拆分但未指定并入目标）：题号校验仅在此分支进行
      const qnos = new Set(items.map((it) => it.qno));
      // 0046（qno nullable 适配，逐处申报）：未编号草稿（null）拆分且用户未指定新题号 →
      // 新条目同为未编号（null），不再做 `+0.5` 算术（null + 0.5 = NaN）
      let newQno: number | null;
      if (action.newQno !== undefined) {
        if (!Number.isInteger(action.newQno) || action.newQno <= 0) {
          return { items, error: `新题号须为正整数：${action.newQno}` };
        }
        if (qnos.has(action.newQno)) {
          return { items, error: `新题号 q${action.newQno} 已存在（可改题号；若断点在解析区，可选择并入已有题）` };
        }
        newQno = action.newQno;
      } else {
        newQno = draft.qno === null ? null : draft.qno + 0.5;
        if (newQno !== null) while (qnos.has(newQno)) newQno += 0.5;
      }

      const result = splitDraft(draft, action.atText, { newQno });
      if (!result.ok) return { items, error: result.error };

      // draftId 撞号兜底（极端重复拆分）
      const ids = new Set(items.map((it) => it.draftId));
      while (ids.has(result.second.draftId)) result.second = { ...result.second, draftId: `${result.second.draftId}-m` };

      return { items: [...items.slice(0, idx), result.first, result.second, ...items.slice(idx + 1)] };
    }
    case 'merge': {
      const idSet = new Set(action.draftIds);
      const participants = items.filter((it) => idSet.has(it.draftId));
      if (participants.length !== action.draftIds.length) return { items, error: '合并所选条目不存在' };
      if (!idSet.has(action.intoId)) return { items, error: `合并目标 ${action.intoId} 须在所选条目中` };

      const { merged, consumedIds } = mergeDrafts(participants, action.intoId);
      const consumed = new Set(consumedIds);
      return {
        items: items.map((it) => {
          if (it.draftId === action.intoId) return merged;
          if (consumed.has(it.draftId)) return { ...it, status: 'delete' };
          return it;
        }),
      };
    }
  }
}

/** 收集可入库条目：仅 status==='ok' */
export function collectOkItems(items: ProofItem[]): ProofItem[] {
  return items.filter((it) => it.status === 'ok');
}

/** 条目排序修正（跨页题续接错位兜底）：delta ±1 与邻居交换 */
export function moveItem(items: ProofItem[], draftId: string, delta: -1 | 1): ProofItem[] {
  const idx = items.findIndex((it) => it.draftId === draftId);
  const target = idx + delta;
  if (idx === -1 || target < 0 || target >= items.length) return items;
  const next = [...items];
  [next[idx], next[target]] = [next[target], next[idx]];
  return next;
}
