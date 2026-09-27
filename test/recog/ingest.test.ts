// C0 Phase 4: ingest 产物与 MockBankService.createQuestion 入参契约匹配，往返字段一致

import { describe, it, expect } from 'vitest';

import type { ScanDraft } from '../../src/shared/contracts/recog-types.js';
import { buildIngestInputs } from '../../src/recog/ingest.js';
import { MockBankService } from '../../src/bank/mock/mock-bank.js';

const drafts: ScanDraft[] = [
  {
    pageNo: 1,
    qno: 1,
    contentHtml: '<div class="question"><p>题面一</p><div class="options"><span class="option">A. 甲</span></div></div>',
    answerHtml: '<p>A</p>',
    analysisHtml: '<p>解析一</p>',
    imageRefIds: ['p1-img-0'],
    rawText: '1. 题面一\nA. 甲',
    warnings: [],
  },
  {
    pageNo: 2,
    qno: 2,
    contentHtml: '<div class="question"><p>题面二</p></div>',
    imageRefIds: [],
    rawText: '2. 题面二',
    warnings: [],
  },
];

describe('buildIngestInputs → MockBankService 往返', () => {
  it('sourceType/sourceDetail/content 等字段入库后读回一致', async () => {
    const inputs = buildIngestInputs(drafts, { subject: '物理', paperTitle: '2024年上海市高考物理试卷' });
    expect(inputs).toHaveLength(2);
    expect(inputs[0].sourceType).toBe('local');
    expect(inputs[0].sourceDetail).toEqual({
      origin: 'scan',
      pageNo: 1,
      qno: 1,
      paperTitle: '2024年上海市高考物理试卷',
    });

    const bank = new MockBankService();
    const created = await bank.createQuestion(inputs[0]);
    const readBack = await bank.getQuestion(created.id);
    expect(readBack).not.toBeNull();
    expect(readBack!.subject).toBe('物理');
    expect(readBack!.sourceType).toBe('local');
    expect(readBack!.sourceDetail).toEqual({
      origin: 'scan',
      pageNo: 1,
      qno: 1,
      paperTitle: '2024年上海市高考物理试卷',
    });
    expect(readBack!.content).toBe(drafts[0].contentHtml);
    expect(readBack!.answer).toBe(drafts[0].answerHtml);
    expect(readBack!.analysis).toBe(drafts[0].analysisHtml);
    expect(readBack!.images).toEqual([{ assetId: 'p1-img-0', type: 'figure' }]); // 0002 结构化
  });

  it('无答案/解析的草稿不产出 answer/analysis 字段，往返后为 undefined/空', async () => {
    const inputs = buildIngestInputs([drafts[1]], { subject: '物理' });
    expect(inputs[0].sourceDetail).toEqual({ origin: 'scan', pageNo: 2, qno: 2 });
    expect('answer' in inputs[0]).toBe(false);
    expect('analysis' in inputs[0]).toBe(false);

    const bank = new MockBankService();
    const created = await bank.createQuestion(inputs[0]);
    const readBack = await bank.getQuestion(created.id);
    expect(readBack!.content).toBe('<div class="question"><p>题面二</p></div>');
    expect(readBack!.images).toEqual([]);
  });
});
