// 0028 P1：run 草稿 → 校对条目（ScanDraft → ProofItem）
// 与 scripts/build-proof-input.mjs 的组装口径逐字对齐（同一份 recog 管线产物 → 同一份 ProofPageInput 形态），
// 差别只在输入来自 run 产物目录而非 POC 目录。放 src 侧供应用内消费，避免 UI 与脚本两套映射漂移。

import type { ScanDraft } from '../../shared/contracts/recog-types.js';
import type { ProofItem } from '../../shared/contracts/recog-ui-types.js';
import type { RecogRunDetailPage } from '../../shared/contracts/recog-run-types.js';

/**
 * 草稿 → 校对条目（status 一律 pending：人签是用户动作，机器不得预置通过）。
 * 0046（qno nullable 适配，逐处申报）：qno=null 的草稿 draftId 以 `${pageNo}-null` 为基，
 * 同页多条时追加 -2/-3 后缀防撞号（draftId 是校对页动作的定位键，必须唯一）。
 */
export function scanDraftsToProofItems(drafts: ScanDraft[]): ProofItem[] {
  const usedIds = new Set<string>();
  return drafts.map((d) => {
    let draftId = `${d.pageNo}-${d.qno}`;
    let n = 1;
    while (usedIds.has(draftId)) draftId = `${d.pageNo}-${d.qno}-${(n += 1)}`;
    usedIds.add(draftId);
    return {
      draftId,
      pageNo: d.pageNo,
      qno: d.qno,
      source: 'rule',
      contentHtml: d.contentHtml,
      ...(d.answerHtml !== undefined ? { answerHtml: d.answerHtml } : {}),
      ...(d.analysisHtml !== undefined ? { analysisHtml: d.analysisHtml } : {}),
      imageRefIds: [...d.imageRefIds],
      status: 'pending',
      warnings: [...d.warnings],
      rawText: d.rawText,
    };
  });
}

/** 页记录 → ProofPageInput.pages（图路径与 OCR 原文已由 shell 侧备好） */
export function runPagesToProofPages(
  pages: RecogRunDetailPage[],
): Array<{ pageNo: number; imagePath: string; ocrText: string }> {
  return pages.map((p) => ({ pageNo: p.pageNo, imagePath: p.imagePath, ocrText: p.ocrText }));
}
