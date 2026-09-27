// 0035 P1/P3：DOCX 计划层（Question[] + ResolvedLayout → 可组装计划）——模式/题号/图版式/公式去重。

import { describe, it, expect } from 'vitest';
import type { Paper, Question } from '../../src/shared/contracts/bank-types.js';
import { buildDocxPlan } from '../../src/docgen/export/docx/plan.js';
import { resolveFigureWidthPx } from '../../src/docgen/export/docx/layout-map.js';
import type { InlineItem } from '../../src/docgen/export/docx/content-subset.js';

function makeQuestion(over: Partial<Question> = {}): Question {
  return {
    id: 'q1',
    subject: '物理',
    sourceType: 'local',
    sourceDetail: {},
    content: '<div class="question"><p>质量为 m 的物体，动能 <span class="math" data-tex="E_k = \\frac{1}{2}mv^2"></span>。</p></div>',
    images: [],
    createdAt: '2026-09-17T00:00:00Z',
    updatedAt: '2026-09-17T00:00:00Z',
    ...over,
  };
}

function makePaper(over: Partial<Paper> = {}): Paper {
  return { id: 'p1', title: '0035 计划卷', config: {}, createdAt: '2026-09-17T00:00:00Z', archived: false, ...over };
}

const itemText = (items: InlineItem[]): string => items.map((i) => i.value).join('');

describe('0035 plan：模式与字段', () => {
  it('教师版带答案/解析（红笔语义由组装层落色），学生版不带', () => {
    const q = makeQuestion({ answer: '答：<span class="math" data-tex="v=\\sqrt{2gh}"></span>', analysis: '<p>由机械能守恒得</p>' });
    const teacher = buildDocxPlan(makePaper(), [q], { mode: 'teacher' });
    expect(teacher.questions[0].answerItems).toBeDefined();
    expect(itemText(teacher.questions[0].answerItems ?? [])).toContain('v=\\sqrt{2gh}');
    expect(itemText(teacher.questions[0].analysisItems ?? [])).toContain('由机械能守恒得');

    const student = buildDocxPlan(makePaper(), [q], { mode: 'student' });
    expect(student.questions[0].answerItems).toBeUndefined();
    expect(student.questions[0].analysisItems).toBeUndefined();
  });

  it('学生版 + fieldVisibility.answer=true → 答案可见（讲义形态）', () => {
    const q = makeQuestion({ answer: '答：甲' });
    const plan = buildDocxPlan(makePaper({ layoutConfig: { version: 2, fieldVisibility: { answer: true } } }), [q], { mode: 'student' });
    expect(itemText(plan.questions[0].answerItems ?? [])).toBe('答：甲');
  });

  it('题号/分值按题目行递增，文本块行不占号；分值 undefined 不渲染', () => {
    const q1 = makeQuestion({ id: 'q1' });
    const q2 = makeQuestion({ id: 'q2', content: '<div class="question">第二题</div>' });
    const textId = 'text:t1';
    const textRow = makeQuestion({ id: textId, content: '<div class="question">一、选择题</div>' });
    const plan = buildDocxPlan(makePaper(), [q1, textRow, q2], {
      mode: 'teacher',
      scores: [5, undefined],
      textBlocks: { [textId]: { id: textId, text: '一、选择题', style: 'section' } },
    });
    expect(plan.questions.map((q) => q.kind)).toEqual(['question', 'text', 'question']);
    expect(plan.questions.map((q) => q.no)).toEqual([1, 0, 2]);
    expect(plan.questions[0].score).toBe(5);
    expect(plan.questions[2].score).toBeUndefined();
    expect(plan.questions[1].blocks[0].kind).toBe('paragraph');
    expect(plan.questions[1].blocks.some((b) => b.kind === 'answer')).toBe(false);
  });

  it('fieldVisibility.questionNo=false / score=false → 题头位关闭', () => {
    const plan = buildDocxPlan(
      makePaper({ layoutConfig: { version: 2, fieldVisibility: { questionNo: false, score: false } } }),
      [makeQuestion()],
      { mode: 'teacher', scores: [3] }
    );
    expect(plan.questions[0].showNo).toBe(false);
    expect(plan.questions[0].showScore).toBe(false);
  });
});

describe('0035 plan：公式与图片', () => {
  it('公式清单按 tex+display+字号去重（同式两处只栅格一次）', () => {
    const q = makeQuestion({
      content: '<div class="question">甲 <span class="math" data-tex="F=ma"></span> 乙 <span class="math" data-tex="F=ma"></span>'
        + '<span class="math" data-tex="a=\\frac{F}{m}" data-display="true"></span></div>',
    });
    const plan = buildDocxPlan(makePaper(), [q], { mode: 'teacher' });
    expect(plan.mathItems).toHaveLength(2);
    expect(plan.mathItems.map((m) => m.key)).toEqual(['inline:16:F=ma', 'display:16:a=\\frac{F}{m}']);
  });

  it('figure.diagram 落图块；题级 widthPercent/side-by-side 覆盖生效', () => {
    const q = makeQuestion({
      content: '<div class="question"><p>如图</p><figure class="diagram" data-align="center" data-w="300" data-h="200">'
        + '<img src="data-assets/capture/a.png"></figure><figure class="diagram" data-w="200">'
        + '<img src="data-assets/capture/b.png"></figure></div>',
      images: [
        { assetId: 'capture/a.png', type: 'figure' },
        { assetId: 'capture/b.png', type: 'figure' },
      ],
    });
    const plan = buildDocxPlan(makePaper(), [q], {
      mode: 'teacher',
      questionLayouts: { q1: { figures: [{ assetId: 'capture/b.png', mode: 'side-by-side', widthPercent: 50 }] } },
    });
    const blocks = plan.questions[0].blocks.filter((b) => b.kind === 'figure');
    expect(blocks).toHaveLength(1);
    if (blocks[0].kind === 'figure') {
      expect(blocks[0].figure.src).toBe('data-assets/capture/a.png');
      expect(blocks[0].figure.dataWidthPx).toBe(300);
      expect(blocks[0].figure.widthPercent).toBeNull();
    }
    expect(plan.questions[0].sideFigures).toHaveLength(1);
    expect(plan.questions[0].sideFigures[0].src).toBe('data-assets/capture/b.png');
    expect(plan.questions[0].sideFigures[0].widthPercent).toBe(50);
  });

  it('选项版式生效值：题级覆盖 ?? 卷级档', () => {
    const q = makeQuestion({
      content: '<div class="question">选一选。<div class="options"><span class="option">A. 甲</span><span class="option">B. 乙</span></div></div>',
    });
    const volume = buildDocxPlan(makePaper({ layoutConfig: { version: 2, optionsLayout: 'two-lines' } }), [q], { mode: 'teacher' });
    expect(volume.questions[0].blocks.find((b) => b.kind === 'options')?.optionsLayout).toBe('two-lines');
    const perQuestion = buildDocxPlan(makePaper({ layoutConfig: { version: 2, optionsLayout: 'two-lines' } }), [q], {
      mode: 'teacher',
      questionLayouts: { q1: { optionsLayout: 'auto' } },
    });
    expect(perQuestion.questions[0].blocks.find((b) => b.kind === 'options')?.optionsLayout).toBe('auto');
  });

  it('题级作答区（lines=3）按行高换算高度；卷级启用时逐题带作答区', () => {
    const q = makeQuestion();
    const plan = buildDocxPlan(makePaper({ layoutConfig: { version: 2, answerSpace: { enabled: true, style: 'blank', heightMm: 20 } } }), [q], {
      mode: 'teacher',
      questionLayouts: { q1: { answerSpace: { style: 'lines', lines: 3 } } },
    });
    const space = plan.questions[0].answerSpace;
    expect(space?.style).toBe('lines');
    // 行高 = 12pt × 1.8 × 25.4/72 = 7.62mm → 3 行 = 22.86mm → 1296 twip
    expect(space?.heightTwip).toBe(1296);
  });

  it('空题/无公式/多图边界不崩', () => {
    const empty = buildDocxPlan(makePaper(), [makeQuestion({ content: '' })], { mode: 'teacher' });
    expect(empty.questions[0].blocks).toHaveLength(0);
    expect(empty.mathItems).toHaveLength(0);
    const noMath = buildDocxPlan(makePaper(), [makeQuestion({ content: '<div class="question">纯文本</div>' })], { mode: 'teacher' });
    expect(noMath.mathItems).toHaveLength(0);
    const multi = buildDocxPlan(makePaper(), [makeQuestion({
      content: '<div class="question"><figure class="diagram" data-w="100"><img src="data-assets/a.png"></figure>'
        + '<figure class="diagram" data-w="100"><img src="data-assets/b.png"></figure>'
        + '<figure class="diagram" data-w="100"><img src="data-assets/c.png"></figure></div>',
      images: [
        { assetId: 'a.png', type: 'figure' }, { assetId: 'b.png', type: 'figure' }, { assetId: 'c.png', type: 'figure' },
      ],
    })], { mode: 'teacher' });
    expect(multi.questions[0].blocks.filter((b) => b.kind === 'figure')).toHaveLength(3);
  });
});

describe('0035 layout-map：图片显示宽（widthPercent > min(原宽, 60% 档)）', () => {
  it('覆盖档优先（版心 680px × 50% = 340px）', () => {
    expect(resolveFigureWidthPx({ widthPercent: 50, dataWidthPx: 300, intrinsicWidthPx: 300, contentWidthPx: 680 })).toBe(340);
  });

  it('无覆盖：原宽小于 60% 档时按原宽（只收敛不放大小图）', () => {
    expect(resolveFigureWidthPx({ widthPercent: null, dataWidthPx: 300, intrinsicWidthPx: 300, contentWidthPx: 680 })).toBe(300);
  });

  it('无覆盖：原宽超 60% 档时收敛到 60% 版心', () => {
    expect(resolveFigureWidthPx({ widthPercent: null, dataWidthPx: 1031, intrinsicWidthPx: 1031, contentWidthPx: 680 })).toBe(408);
  });

  it('无 data-w：用图片内在宽；内在宽未知 → 直接取 60% 档', () => {
    expect(resolveFigureWidthPx({ widthPercent: null, dataWidthPx: null, intrinsicWidthPx: 200, contentWidthPx: 680 })).toBe(200);
    expect(resolveFigureWidthPx({ widthPercent: null, dataWidthPx: null, intrinsicWidthPx: null, contentWidthPx: 680 })).toBe(408);
  });
});
