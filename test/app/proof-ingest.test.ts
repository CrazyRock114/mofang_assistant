// C1 Phase 4: 入库闭环 — ProofItem(ok) 集合 → buildIngestInputs → MockBankService.createQuestion 往返
// 既有 test/recog/ingest.test.ts 不动，本文件只加新用例

import { describe, it, expect } from 'vitest';

import type { ProofItem } from '../../src/shared/contracts/recog-ui-types.js';
import { collectOkItems } from '../../src/app/proof/proof-session.js';
import { proofItemToScanDraft } from '../../src/recog/proof.js';
import { buildIngestInputs } from '../../src/recog/ingest.js';
import { MockBankService } from '../../src/bank/mock/mock-bank.js';

function makeItem(overrides: Partial<ProofItem>): ProofItem {
  return {
    draftId: '1-1',
    pageNo: 1,
    qno: 1,
    source: 'rule',
    contentHtml: '<div class="question"><p>题面</p></div>',
    imageRefIds: [],
    status: 'pending',
    warnings: [],
    rawText: '1. 题面',
    ...overrides,
  };
}

describe('校对入库闭环', () => {
  const items: ProofItem[] = [
    makeItem({
      draftId: '1-1',
      qno: 1,
      status: 'ok',
      contentHtml: '<div class="question"><p>题面一</p></div>',
      answerHtml: '<p>答案一</p>',
      imageRefIds: ['p1-img-0'],
      score: 5,
    }),
    makeItem({ draftId: '1-2', qno: 2, status: 'pending' }),
    makeItem({ draftId: '1-3', qno: 3, status: 'ok', contentHtml: '<div class="question"><p>题面三</p></div>' }),
    makeItem({ draftId: '1-4', qno: 4, status: 'delete' }),
  ];

  it('collectOkItems 只收集 status===ok 条目', () => {
    const ok = collectOkItems(items);
    expect(ok.map((i) => i.draftId)).toEqual(['1-1', '1-3']);
  });

  it('ok 集合 → buildIngestInputs → createQuestion 往返字段一致', async () => {
    const ok = collectOkItems(items);
    const inputs = buildIngestInputs(ok.map(proofItemToScanDraft), { subject: '物理', paperTitle: '校对卷' });
    expect(inputs).toHaveLength(2);
    expect(inputs[0].sourceType).toBe('local');
    expect(inputs[0].sourceDetail).toEqual({ origin: 'scan', pageNo: 1, qno: 1, paperTitle: '校对卷' });
    expect(inputs[0].content).toBe('<div class="question"><p>题面一</p></div>');
    expect(inputs[0].answer).toBe('<p>答案一</p>');
    expect(inputs[0].images).toEqual([{ assetId: 'p1-img-0', type: 'figure' }]); // 0002 结构化

    const bank = new MockBankService();
    const created = await bank.createQuestion(inputs[0]);
    const readBack = await bank.getQuestion(created.id);
    expect(readBack).not.toBeNull();
    expect(readBack!.sourceType).toBe('local');
    expect(readBack!.sourceDetail).toEqual({ origin: 'scan', pageNo: 1, qno: 1, paperTitle: '校对卷' });
    expect(readBack!.content).toBe(inputs[0].content);
    expect(readBack!.answer).toBe(inputs[0].answer);
    expect(readBack!.images).toEqual([{ assetId: 'p1-img-0', type: 'figure' }]); // 0002 结构化

    // operation_log 由 bank 层自动记录（操作留痕）
    const logs = bank.getOperationLogs();
    expect(logs.filter((l) => l.type === 'question.create')).toHaveLength(1);
  });

  it('score 不进 createQuestion（分值属 PaperQuestionRef，入卷时才带）', () => {
    const inputs = buildIngestInputs(collectOkItems(items).map(proofItemToScanDraft), { subject: '物理' });
    expect('score' in inputs[0]).toBe(false);
  });
});
