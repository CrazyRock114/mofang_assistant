// 0069（R-075）：答案/解析区抠图·纯函数层（plan 的 R-064 分流 / merge 的 [图N] 拼回 / figures 对账可选面）。
//
// 三条口径（任务书 §一.1/§一.2）：
//   ① **含正文字段**里的「位图 + 块级 figure.diagram + data-h > 60px」= 真配图 → **不做靶、原样保留**
//      （R-064 判据分流；行内小图与 ≤60px 的宽公式块照旧转写）；
//   ② 整图靶抠出的配图按 [图N] 拼回**块级 figure.diagram**（真 src + data-w/h），无抠图结果时
//      落空 src 占位（不静默吞）；
//   ③ 抠图产物作为 `type='figure'` 新条目写进 images 列；原整图条目按既有「已转文字即移除」口径移除。

import { describe, it, expect } from 'vitest';

import { planAiClean } from '../../src/recog/ai-clean/plan.js';
import { mergeAiClean, type AiCleanImageOutput } from '../../src/recog/ai-clean/merge.js';
import { reconcileFigures } from '../../src/recog/onestep/figures.js';
import type { AiCleanTarget } from '../../src/recog/ai-clean/plan.js';

/** 位图块级大图（真配图：几何图形） */
const BIG_FIG = 'capture/zujuan/34585790-3.png';
/** 位图块级小图（宽公式：真库样题 41e87e40 第 3 张 `data-h="38"`） */
const WIDE_FORMULA = 'capture/zujuan/17371192-13.png';
/** 矢量块级图（R-064 判据下矢量不看 60px 阈） */
const VECTOR_FIG = 'capture/zujuan/34585790-4.svg';
/** 行内小位图（选项/解析区公式条） */
const INLINE_FORMULA = 'capture/zujuan/17371192-10.png';
/** 整图靶（答案区就是一张防采集图） */
const ANSWER_PAGE = 'capture/zujuan/34585790-9.jpg';

function blockFigure(rel: string, width: number, height: number): string {
  return `<figure class="diagram" data-w="${width}" data-h="${height}"><img class="q-figure" src="data-assets/${rel}"></figure>`;
}

function inlineFigure(rel: string, width: number, height: number): string {
  return `<span class="inline-figure"><img class="q-figure" data-w="${width}" data-h="${height}" src="data-assets/${rel}"></span>`;
}

/** 含正文字段：正文 + 四类图（块级大位图 / 块级小位图 / 块级矢量 / 行内小图） */
const ANALYSIS_WITH_TEXT = [
  '<p>【详解】如图所示，根据几何关系解得</p>',
  blockFigure(BIG_FIG, 320, 180),
  '<p>代入数据得</p>',
  blockFigure(WIDE_FORMULA, 287, 38),
  blockFigure(VECTOR_FIG, 400, 180),
  inlineFigure(INLINE_FORMULA, 122, 27),
  '<p>故 A 正确。</p>',
].join('');

describe('0069 plan：R-064 判据分流（含正文字段）', () => {
  it('位图 + 块级 figure.diagram + data-h>60 是真配图 → 不做靶（原样保留）', () => {
    const plan = planAiClean({ content: '', answer: '', analysis: ANALYSIS_WITH_TEXT });
    expect(plan.targets.some((t) => t.assetRelPath === BIG_FIG)).toBe(false);
  });

  it('位图块级小图（data-h ≤ 60，真库样题 41e87e40 第 3 张）仍做靶', () => {
    const plan = planAiClean({ content: '', answer: '', analysis: ANALYSIS_WITH_TEXT });
    expect(plan.targets.some((t) => t.assetRelPath === WIDE_FORMULA)).toBe(true);
  });

  it('矢量块级大图仍做靶（R-064 判据对 .svg 不走 60px 阈）', () => {
    const plan = planAiClean({ content: '', answer: '', analysis: ANALYSIS_WITH_TEXT });
    expect(plan.targets.some((t) => t.assetRelPath === VECTOR_FIG)).toBe(true);
  });

  it('行内小图仍做靶（行内没有「真配图」语义）', () => {
    const plan = planAiClean({ content: '', answer: '', analysis: ANALYSIS_WITH_TEXT });
    expect(plan.targets.some((t) => t.assetRelPath === INLINE_FORMULA)).toBe(true);
  });

  it('无正文字段（整图靶）不受分流影响：位图大图仍是 answer 靶', () => {
    const plan = planAiClean({ content: '', answer: blockFigure(ANSWER_PAGE, 1768, 968), analysis: '' });
    expect(plan.targets.map((t) => [t.field, t.kind, t.mode])).toEqual([['answer', 'answer', 'replace-field']]);
  });

  it('尺寸未知（data-h 缺省=0）的块级位图不做「真配图」判定 → 仍做靶（不静默留图）', () => {
    const plan = planAiClean({
      content: '',
      answer: '',
      analysis: `<p>如图</p><figure class="diagram"><img class="q-figure" src="data-assets/${BIG_FIG}"></figure>`,
    });
    expect(plan.targets.some((t) => t.assetRelPath === BIG_FIG)).toBe(true);
  });
});

describe('0069 目检返工①：同一资产重复出现不再产生重复靶（真库 c476a786 现场）', () => {
  const REPEATED = [
    '<p>题</p>',
    inlineFigure(INLINE_FORMULA, 122, 27),
    '<p>中</p>',
    inlineFigure(INLINE_FORMULA, 122, 27),
    '<p>后</p>',
    inlineFigure(INLINE_FORMULA, 122, 27),
  ].join('');

  it('同一资产在题面被引用 3 次 → 只出 1 个靶（工作单位是「一张图」）', () => {
    const plan = planAiClean({ content: REPEATED, answer: '', analysis: '' });
    expect(plan.targets).toHaveLength(1);
    expect(plan.targets[0]!.assetRelPath).toBe(INLINE_FORMULA);
  });

  it('同一资产在题面与答案区（不同 kind）→ 两个靶都留（语义不同，不互相套用）', () => {
    const plan = planAiClean({
      content: REPEATED,
      answer: inlineFigure(INLINE_FORMULA, 122, 27),
      analysis: '',
    });
    expect(plan.targets.map((t) => t.kind)).toEqual(['formula', 'answer']);
  });
});

describe('0069 merge：整图靶抠图拼回', () => {
  function answerTarget(rel = ANSWER_PAGE): AiCleanTarget {
    return {
      field: 'answer',
      region: 'answer',
      src: `data-assets/${rel}`,
      assetRelPath: rel,
      kind: 'answer',
      mode: 'replace-field',
      width: 1768,
      height: 968,
    };
  }

  function outputOf(
    partial: Partial<AiCleanImageOutput> & Pick<AiCleanImageOutput, 'answerText' | 'analysisText'>,
    rel = ANSWER_PAGE,
  ): AiCleanImageOutput {
    return { target: answerTarget(rel), ok: true, ...partial };
  }

  it('抠出配图 → [图N] 落块级 figure.diagram（真 src + data-w/h）', () => {
    const merged = mergeAiClean(
      { content: '', answer: blockFigure(ANSWER_PAGE, 1768, 968), analysis: '', images: [] },
      [outputOf({
        answerText: null,
        analysisText: '【详解】如图[图1]，由几何关系得 $\\theta=37°$；受力如图[图2]。',
        figures: [
          { refIndex: 1, src: 'data-assets/recog/aaaa.png', width: 320, height: 240 },
          { refIndex: 2, src: 'data-assets/recog/bbbb.png', width: 180, height: 150 },
        ],
      })],
    );
    expect(merged.analysis).toContain('src="data-assets/recog/aaaa.png"');
    expect(merged.analysis).toContain('data-w="320" data-h="240"');
    expect(merged.analysis).toContain('src="data-assets/recog/bbbb.png"');
    // 占位符本身不留痕：正文里不出现 [图N] 字面
    expect(merged.analysis).not.toContain('[图1]');
    expect(merged.analysis).not.toContain('[图2]');
    expect(merged.analysis).toContain('class="math" data-tex="\\theta=37°"');
  });

  it('抠图产物写进 images（type=figure + 宽高）；原整图条目按既有口径移除', () => {
    const merged = mergeAiClean(
      {
        content: '',
        answer: blockFigure(ANSWER_PAGE, 1768, 968),
        analysis: '',
        images: [
          { assetId: `data-assets/${ANSWER_PAGE}`, type: 'answer-image' },
          { assetId: 'data-assets/capture/zujuan/keep-me.png', type: 'figure' },
        ],
      },
      [outputOf({
        answerText: null,
        analysisText: '如图[图1]。',
        figures: [{ refIndex: 1, src: 'data-assets/recog/aaaa.png', width: 320, height: 240 }],
      })],
    );
    expect(merged.images).toEqual([
      { assetId: 'data-assets/capture/zujuan/keep-me.png', type: 'figure' },
      { assetId: 'data-assets/recog/aaaa.png', type: 'figure', width: 320, height: 240 },
    ]);
  });

  it('无抠图结果（figures 缺省）→ [图N] 落空 src 占位（不静默吞），且不进 images', () => {
    const merged = mergeAiClean(
      { content: '', answer: blockFigure(ANSWER_PAGE, 1768, 968), analysis: '', images: [] },
      [outputOf({ answerText: null, analysisText: '如图[图1]所示。' })],
    );
    expect(merged.analysis).toContain('class="diagram"');
    expect(merged.analysis).toContain('src=""');
    expect(merged.images).toEqual([]);
  });

  it('抠图产物没被文本引用（模型没写这个编号）→ 不写进 images（不留孤儿条目）', () => {
    const merged = mergeAiClean(
      { content: '', answer: blockFigure(ANSWER_PAGE, 1768, 968), analysis: '', images: [] },
      [outputOf({
        answerText: null,
        analysisText: '如图[图1]所示。',
        figures: [
          { refIndex: 1, src: 'data-assets/recog/aaaa.png', width: 10, height: 10 },
          { refIndex: 2, src: 'data-assets/recog/unused.png', width: 10, height: 10 },
        ],
      })],
    );
    expect(merged.images).toEqual([{ assetId: 'data-assets/recog/aaaa.png', type: 'figure', width: 10, height: 10 }]);
  });

  it('同一编号出现在两个整图靶 → 取先出现的并显式告警（不静默）', () => {
    const other = 'capture/zujuan/34585790-10.jpg';
    const merged = mergeAiClean(
      { content: '', answer: '', analysis: '', images: [] },
      [
        outputOf({
          answerText: '第一张[图1]。',
          analysisText: null,
          figures: [{ refIndex: 1, src: 'data-assets/recog/first.png', width: 10, height: 10 }],
        }),
        outputOf({
          answerText: '第二张[图1]。',
          analysisText: null,
          figures: [{ refIndex: 1, src: 'data-assets/recog/second.png', width: 10, height: 10 }],
        }, other),
      ],
    );
    expect(merged.answer).toContain('data-assets/recog/first.png');
    expect(merged.answer).not.toContain('data-assets/recog/second.png');
    expect(merged.warnings.some((w) => w.includes('图1') && w.includes('编号'))).toBe(true);
  });

  it('0065 口径零变化：无 figures 字段时产出与既有完全一致（options 恒传但空映射）', () => {
    const merged = mergeAiClean(
      { content: '', answer: blockFigure(ANSWER_PAGE, 1768, 968), analysis: '', images: [] },
      [outputOf({ answerText: 'A．0.6', analysisText: '由勾股定理得 $a^2+b^2=c^2$' })],
    );
    expect(merged.answer).toBe('<p>A．0.6</p>');
    expect(merged.analysis).toBe('<p>由勾股定理得 <span class="math" data-tex="a^2+b^2=c^2"></span></p>');
  });
});

describe('0069 figures：对账面文案可按场景覆盖（缺省逐字不变）', () => {
  const input = {
    dsoRawOutputs: ['<|ref|>image<|/ref|><|det|>[[100,100,400,400]]'],
    inlineBoxes: [],
    placeholderRefs: [1, 2],
  };

  it('缺省（录题侧）：文案逐字不变（左栏手动框选）', () => {
    const result = reconcileFigures(input);
    expect(result.figures).toHaveLength(1);
    expect(result.warnings.some((w) => w.includes('题面 [图2] 未配到图块') && w.includes('左栏手动框选'))).toBe(true);
  });

  it('答案/解析链可换称谓与处置提示', () => {
    const result = reconcileFigures(input, {
      label: '答案/解析区',
      uncoveredHint: '请在编辑器补图或删掉该占位',
    });
    expect(result.warnings.some((w) => w.includes('答案/解析区 [图2] 未配到图块') && w.includes('编辑器补图'))).toBe(true);
  });
});
