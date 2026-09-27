// C1 Phase 2: 校对动作算法测试（先 RED 后 GREEN）
// 断言结构化：精确字段/结构匹配，禁止 toContain 降级

import { describe, it, expect } from 'vitest';

import type { ProofItem } from '../../src/shared/contracts/recog-ui-types.js';
import { splitDraft, mergeDrafts, proofItemToScanDraft } from '../../src/recog/proof.js';
import { isValidQuestionContent } from '../../src/shared/contracts/question-content.js';

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

describe('splitDraft', () => {
  it('atText 命中块首 → 在块边界断，前段保留原题号，后段新起条目', () => {
    const draft = makeItem({
      draftId: '10-10',
      pageNo: 10,
      qno: 10,
      contentHtml: '<div class="question"><p>第一题题面</p><p>10. 第二题题面</p></div>',
      rawText: '第一题题面\n10. 第二题题面',
    });
    const result = splitDraft(draft, '10. 第二题题面');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.first.draftId).toBe('10-10');
    expect(result.first.qno).toBe(10);
    expect(result.first.source).toBe('rule');
    expect(result.first.contentHtml).toBe('<div class="question"><p>第一题题面</p></div>');
    expect(result.first.rawText).toBe('第一题题面\n');
    expect(result.first.status).toBe('pending');

    expect(result.second.qno).toBe(10.5);
    expect(result.second.draftId).toBe('10-10.5');
    expect(result.second.source).toBe('manual');
    expect(result.second.contentHtml).toBe('<div class="question"><p>10. 第二题题面</p></div>');
    expect(result.second.rawText).toBe('10. 第二题题面');
    expect(result.second.status).toBe('pending');

    expect(isValidQuestionContent(result.first.contentHtml)).toBe(true);
    expect(isValidQuestionContent(result.second.contentHtml)).toBe(true);
  });

  it('atText 命中块中段 → 块内断开且标签闭合，两段各自成 <p>', () => {
    // C0 已知交接：楚天 p10 解析区行内题号并入 q10 的兜底场景
    const draft = makeItem({
      draftId: '10-10',
      pageNo: 10,
      qno: 10,
      contentHtml: '<div class="question"><p>【解析】因为A正确。10. 某物质的质量为多少</p></div>',
      analysisHtml: '<p>【解析】因为A正确。10. 某物质的质量为多少</p>',
      rawText: '【解析】因为A正确。10. 某物质的质量为多少',
    });
    const result = splitDraft(draft, '10. 某物质的质量为多少');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 断点在 contentHtml：答案/解析留在前段
    expect(result.first.contentHtml).toBe('<div class="question"><p>【解析】因为A正确。</p></div>');
    expect(result.first.analysisHtml).toBe('<p>【解析】因为A正确。10. 某物质的质量为多少</p>');
    expect(result.second.contentHtml).toBe('<div class="question"><p>10. 某物质的质量为多少</p></div>');
    expect(result.second.analysisHtml).toBeUndefined();
  });

  it('断点不切开 <span class="math"> 原子节点（公式整体随前段）', () => {
    const draft = makeItem({
      contentHtml:
        '<div class="question"><p>前半<span class="math" data-tex="x^2"></span>后半题面</p></div>',
      rawText: '前半\\(x^2\\)后半题面',
    });
    const result = splitDraft(draft, '后半题面');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.first.contentHtml).toBe(
      '<div class="question"><p>前半<span class="math" data-tex="x^2"></span></p></div>',
    );
    expect(result.second.contentHtml).toBe('<div class="question"><p>后半题面</p></div>');
  });

  it('图引用随段归属：断点前的 figure 归前段，断点后的归后段', () => {
    const figA = '<figure class="diagram" data-align="center" data-w="0" data-h="0"><img src="" alt="p1-img-0"></figure>';
    const figB = '<figure class="diagram" data-align="center" data-w="0" data-h="0"><img src="" alt="p1-img-1"></figure>';
    const draft = makeItem({
      contentHtml: `<div class="question"><p>题面</p>${figA}<p>断点后续文本</p>${figB}</div>`,
      imageRefIds: ['p1-img-0', 'p1-img-1'],
      rawText: '题面\n断点后续文本',
    });
    const result = splitDraft(draft, '断点后续文本');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.first.contentHtml).toBe(`<div class="question"><p>题面</p>${figA}</div>`);
    expect(result.first.imageRefIds).toEqual(['p1-img-0']);
    expect(result.second.contentHtml).toBe(`<div class="question"><p>断点后续文本</p>${figB}</div>`);
    expect(result.second.imageRefIds).toEqual(['p1-img-1']);
  });

  it('atText 命中答案区 → 答案在断点处切开，解析整体随后段走', () => {
    const draft = makeItem({
      contentHtml: '<div class="question"><p>题面</p></div>',
      answerHtml: '<p>【答案】A</p><p>11. 下一题答案B</p>',
      analysisHtml: '<p>本题解析</p>',
      rawText: '题面\n【答案】A\n11. 下一题答案B\n本题解析',
    });
    const result = splitDraft(draft, '11. 下一题答案B');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.first.contentHtml).toBe('<div class="question"><p>题面</p></div>');
    expect(result.first.answerHtml).toBe('<p>【答案】A</p>');
    expect(result.first.analysisHtml).toBeUndefined();
    expect(result.second.answerHtml).toBe('<p>11. 下一题答案B</p>');
    expect(result.second.analysisHtml).toBe('<p>本题解析</p>');
  });

  it('atText 未命中 → 返回错误，不静默', () => {
    const draft = makeItem({ contentHtml: '<div class="question"><p>题面</p></div>' });
    const result = splitDraft(draft, '不存在的断点文本');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('atText 未命中：不存在的断点文本');
  });

  it('支持显式指定新题号（opts.newQno）', () => {
    const draft = makeItem({
      qno: 10,
      pageNo: 10,
      draftId: '10-10',
      contentHtml: '<div class="question"><p>前段</p><p>后段题面</p></div>',
    });
    const result = splitDraft(draft, '后段题面', { newQno: 11 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.second.qno).toBe(11);
    expect(result.second.draftId).toBe('10-11');
  });
});

describe('mergeDrafts', () => {
  const a = makeItem({
    draftId: '1-1',
    qno: 1,
    contentHtml: '<div class="question"><p>甲题题面</p></div>',
    answerHtml: '<p>甲答案</p>',
    imageRefIds: ['p1-img-0'],
    rawText: '1. 甲题题面',
    warnings: ['w1'],
  });
  const b = makeItem({
    draftId: '1-2',
    qno: 2,
    contentHtml: '<div class="question"><p>乙题题面</p></div>',
    analysisHtml: '<p>乙解析</p>',
    imageRefIds: ['p1-img-1'],
    rawText: '2. 乙题题面',
  });
  const c = makeItem({
    draftId: '2-3',
    pageNo: 2,
    qno: 3,
    contentHtml: '<div class="question"><p>丙题题面</p></div>',
    imageRefIds: [],
    rawText: '3. 丙题题面',
  });

  it('多条目按传入顺序拼接进目标，块级结构保持', () => {
    const { merged, consumedIds } = mergeDrafts([a, b, c], '1-2');
    expect(consumedIds).toEqual(['1-1', '2-3']);
    expect(merged.draftId).toBe('1-2');
    expect(merged.qno).toBe(2);
    expect(merged.contentHtml).toBe(
      '<div class="question"><p>甲题题面</p><p>乙题题面</p><p>丙题题面</p></div>',
    );
    expect(merged.answerHtml).toBe('<p>甲答案</p>');
    expect(merged.analysisHtml).toBe('<p>乙解析</p>');
    expect(merged.imageRefIds).toEqual(['p1-img-0', 'p1-img-1']);
    expect(merged.rawText).toBe('1. 甲题题面\n2. 乙题题面\n3. 丙题题面');
    expect(merged.warnings).toEqual(['w1']);
    expect(merged.status).toBe('pending');
    expect(isValidQuestionContent(merged.contentHtml)).toBe(true);
  });

  it('intoId 不在参与者中 → 返回错误', () => {
    expect(() => mergeDrafts([a, b], '9-9')).toThrow('合并目标 9-9 不在参与者中');
  });
});

describe('proofItemToScanDraft', () => {
  it('字段一一映射到 ScanDraft（入库适配）', () => {
    const item = makeItem({
      draftId: '3-4',
      pageNo: 3,
      qno: 4,
      contentHtml: '<div class="question"><p>题面</p></div>',
      answerHtml: '<p>答案</p>',
      analysisHtml: '<p>解析</p>',
      imageRefIds: ['p3-img-0'],
      rawText: '4. 题面',
      warnings: ['w'],
      score: 5,
    });
    const draft = proofItemToScanDraft(item);
    expect(draft).toEqual({
      pageNo: 3,
      qno: 4,
      contentHtml: '<div class="question"><p>题面</p></div>',
      answerHtml: '<p>答案</p>',
      analysisHtml: '<p>解析</p>',
      imageRefIds: ['p3-img-0'],
      rawText: '4. 题面',
      warnings: ['w'],
    });
  });

  it('无答案/解析时不产出对应字段', () => {
    const draft = proofItemToScanDraft(makeItem({}));
    expect('answerHtml' in draft).toBe(false);
    expect('analysisHtml' in draft).toBe(false);
  });
});
