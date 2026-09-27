// C0 Phase 3: DraftBuilder 测试（先 RED 后 GREEN）
// 最小 markdown→HTML 转换：段落/行内公式/展示公式/选项块/图位块
// 断言结构化，契约对齐 question-content.ts

import { describe, it, expect } from 'vitest';

import type { RecognizedQuestion } from '../../src/shared/contracts/recog-types.js';
import { isValidQuestionContent, containsMath } from '../../src/shared/contracts/question-content.js';
import { createDraftBuilder } from '../../src/recog/draft.js';

function makeQuestion(blocks: RecognizedQuestion['blocks']): RecognizedQuestion {
  return {
    id: '1-1',
    pageNo: 1,
    qno: 1,
    blocks,
    imageRefIds: blocks.filter((b) => b.type === 'image' && b.imageRefId).map((b) => b.imageRefId!),
    rawText: blocks.map((b) => b.text).join('\n'),
  };
}

describe('DraftBuilder', () => {
  it('行内公式 \\(...\\) → <span class="math" data-tex>，契约校验通过', () => {
    const q = makeQuestion([
      { id: '1-1-question-0', type: 'question', text: '质量 \\(m = 2.0\\) 的汽车' },
    ]);
    const draft = createDraftBuilder().build(q);

    expect(draft.contentHtml).toBe(
      '<div class="question"><p>质量 <span class="math" data-tex="m = 2.0"></span> 的汽车</p></div>',
    );
    expect(isValidQuestionContent(draft.contentHtml)).toBe(true);
    expect(containsMath(draft.contentHtml)).toBe(true);
    expect(draft.pageNo).toBe(1);
    expect(draft.qno).toBe(1);
    expect(draft.warnings).toEqual([]);
  });

  it('展示公式 \\[...\\] → data-display="true"', () => {
    const q = makeQuestion([
      { id: '1-1-question-0', type: 'question', text: '由公式\n\\[E_k = \\frac{1}{2}mv^2\\]\n可得' },
    ]);
    const draft = createDraftBuilder().build(q);

    expect(draft.contentHtml).toBe(
      '<div class="question"><p>由公式\n<span class="math" data-tex="E_k = \\frac{1}{2}mv^2" data-display="true"></span>\n可得</p></div>',
    );
  });

  it('选项块 → <div class="options"><span class="option">', () => {
    const q = makeQuestion([
      { id: '1-1-question-0', type: 'question', text: '下列说法正确的是（ ）' },
      { id: '1-1-option-0', type: 'option', text: 'A. 力是产生加速度的原因' },
      { id: '1-1-option-1', type: 'option', text: 'B. 加速度与力成反比' },
    ]);
    const draft = createDraftBuilder().build(q);

    expect(draft.contentHtml).toBe(
      '<div class="question"><p>下列说法正确的是（ ）</p>' +
        '<div class="options"><span class="option">A. 力是产生加速度的原因</span>' +
        '<span class="option">B. 加速度与力成反比</span></div></div>',
    );
  });

  it('image 块 → <figure class="diagram"> 占位（无裁图数据时 data-w/h=0、img src 留空），记 warning', () => {
    const q = makeQuestion([
      { id: '1-1-question-0', type: 'question', text: '实验装置如图所示' },
      { id: '1-1-image-0', type: 'image', text: '<|ref|>image<|/ref|><|det|>[[85, 690, 718, 780]]<|/det|>', imageRefId: 'p1-img-0' },
    ]);
    const draft = createDraftBuilder().build(q);

    expect(draft.contentHtml).toBe(
      '<div class="question"><p>实验装置如图所示</p>' +
        '<figure class="diagram" data-align="center" data-w="0" data-h="0"><img src="" alt="p1-img-0"></figure></div>',
    );
    expect(draft.imageRefIds).toEqual(['p1-img-0']);
    expect(draft.warnings).toEqual(['图片块 p1-img-0 无裁图数据，img 为占位']);
  });

  it('答案/解析块 → answerHtml / analysisHtml；空题面记 warning', () => {
    const q = makeQuestion([
      { id: '1-1-answer-0', type: 'answer', text: '【答案】BD' },
      { id: '1-1-analysis-0', type: 'analysis', text: '【解析】由动量守恒可知，\\(p = mv\\) 守恒' },
    ]);
    const draft = createDraftBuilder().build(q);

    expect(draft.answerHtml).toBe('<p>【答案】BD</p>');
    expect(draft.analysisHtml).toBe(
      '<p>【解析】由动量守恒可知，<span class="math" data-tex="p = mv"></span> 守恒</p>',
    );
    expect(draft.contentHtml).toBe('<div class="question"></div>');
    expect(draft.warnings).toEqual(['题面为空']);
  });

  it('HTML 转义：正文转义 & < >，data-tex 属性转义引号', () => {
    const q = makeQuestion([
      { id: '1-1-question-0', type: 'question', text: 'a & b < c，\\(x "quoted" < 1\\)' },
    ]);
    const draft = createDraftBuilder().build(q);

    expect(draft.contentHtml).toBe(
      '<div class="question"><p>a &amp; b &lt; c，<span class="math" data-tex="x &quot;quoted&quot; &lt; 1"></span></p></div>',
    );
  });

  it('rawText 透传、无答案时 answerHtml/analysisHtml 为 undefined', () => {
    const q = makeQuestion([
      { id: '1-1-question-0', type: 'question', text: '纯题面' },
    ]);
    const draft = createDraftBuilder().build(q);

    expect(draft.rawText).toBe('纯题面');
    expect(draft.answerHtml).toBeUndefined();
    expect(draft.analysisHtml).toBeUndefined();
  });
});
