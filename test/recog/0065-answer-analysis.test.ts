// 0065（R-068）：组卷网答案解析链·纯函数层（plan 分流 + merge 原位替换）。
//
// 本单相对 0056 的两处行为变更（任务书 §一.1/§一.2）：
//   ① answer/analysis 字段**含正文**时不再整体挡门（0056 的 deferred），改为**该字段走原位模式**：
//      逐图转写 → `<span class="math" data-tex>` 原位替换，正文一字不动；
//   ② answer/analysis 字段**就是一张图**（无正文）时维持 0056 口径：整字段替换 + 引擎双出。
//
// 为什么原位替换要覆盖 figure.diagram：真库样题（41e87e40）解析区 8 张里恰有 1 张是
// `<figure class="diagram" data-w="287" data-h="38">` 包裹的宽公式（R-064 判据把它划到了块级），
// 用户目检口径是「那 8 张都变可编辑公式」。见交付报告 §口径申报。

import { describe, it, expect } from 'vitest';

import {
  planAiClean,
  textOutsideImages,
  type AiCleanTarget,
} from '../../src/recog/ai-clean/plan.js';
import { mergeAiClean } from '../../src/recog/ai-clean/merge.js';

const A1 = 'capture/zujuan/17371192-10.png';   // 解析区行内公式图
const A2 = 'capture/zujuan/17371192-11.png';
const A3 = 'capture/zujuan/17371192-13.png';   // 解析区**块级包裹**的宽公式（真库样题第 3 张）

/** 真库样题 41e87e40 解析区形态：正文 + 行内公式小图 + 块级包裹公式图 */
const ANALYSIS_TEXT_WITH_FIGURES = [
  '【详解】CD．设斜面与水平方向夹角为<i>θ</i>，根据牛顿第二定律得，物体运动的加速度',
  `<p><span class="inline-figure"><img class="q-figure" data-w="122" data-h="27" src="data-assets/${A1}"></span></p>`,
  '根据几何关系可知，物体发生的位移为',
  `<p><span class="inline-figure"><img class="q-figure" data-w="102" data-h="28" src="data-assets/${A2}"></span></p>`,
  '解得',
  `<p><figure class="diagram" data-w="287" data-h="38"><img class="q-figure" src="data-assets/${A3}"></figure></p>`,
  '故A正确，B错误。',
].join('');

const ANSWER_IMG = '<img src="data-assets/capture/zujuan/ans-1.png">';

function targetOf(
  src: string,
  overrides: Partial<AiCleanTarget> = {},
): AiCleanTarget {
  return {
    field: 'analysis',
    region: 'analysis',
    src,
    assetRelPath: src.replace(/^data-assets\//, ''),
    kind: 'formula',
    mode: 'inline-figures',
    width: 0,
    height: 0,
    ...overrides,
  };
}

describe('0065 plan：字段分流（replace-field / inline-figures）', () => {
  it('answer 纯图字段 → kind=answer + mode=replace-field（0056 口径维持）', () => {
    const plan = planAiClean({ content: '', answer: ANSWER_IMG, analysis: '' });
    expect(plan.targets).toHaveLength(1);
    expect(plan.targets[0]!.kind).toBe('answer');
    expect(plan.targets[0]!.mode).toBe('replace-field');
    expect(plan.deferred).toEqual([]);
  });

  it('analysis 有正文 + 小图 → 逐图 inline-figures 靶（不再进 deferred 挡门）', () => {
    const plan = planAiClean({ content: '', answer: '', analysis: ANALYSIS_TEXT_WITH_FIGURES });
    expect(plan.targets.map((t) => [t.field, t.kind, t.mode])).toEqual([
      ['analysis', 'formula', 'inline-figures'],
      ['analysis', 'formula', 'inline-figures'],
      ['analysis', 'formula', 'inline-figures'],
    ]);
    // 0056 的 deferred 挡门在本单退役：含正文字段也整理，且不再报「本批未处理」
    expect(plan.deferred).toEqual([]);
    expect(plan.reason).toBeNull();
  });

  it('块级 figure.diagram 包裹的公式图同样进 inline 靶（真库样题第 3 张）', () => {
    const plan = planAiClean({ content: '', answer: '', analysis: ANALYSIS_TEXT_WITH_FIGURES });
    expect(plan.targets.map((t) => t.assetRelPath)).toContain(A3);
  });

  it('answer 有正文 + 图 → inline 靶；两字段同时有正文时互不串位', () => {
    const plan = planAiClean({
      content: '',
      answer: `<p>答案：$v=at$ 得</p><img src="data-assets/${A1}">`,
      analysis: `<p>解析</p><img src="data-assets/${A2}">`,
    });
    expect(plan.targets.map((t) => [t.field, t.mode])).toEqual([
      ['answer', 'inline-figures'],
      ['analysis', 'inline-figures'],
    ]);
  });

  it('题面行内图仍为 kind=formula + inline-figures（content 口径零变化）', () => {
    const plan = planAiClean({
      content: `<div class="question">题<span class="inline-figure"><img src="data-assets/capture/zujuan/f1.png"></span></div>`,
      answer: '',
      analysis: '',
    });
    expect(plan.targets.map((t) => [t.field, t.region, t.kind, t.mode])).toEqual([
      ['content', 'stem', 'formula', 'inline-figures'],
    ]);
  });
});

describe('0065 merge：answer/analysis 原位替换（正文守恒）', () => {
  it('analysis 逐图原位替换：图消失、公式位出现、**正文逐字不变**', () => {
    const merged = mergeAiClean(
      { content: '', answer: '', analysis: ANALYSIS_TEXT_WITH_FIGURES, images: [] },
      [
        { target: targetOf(`data-assets/${A1}`), ok: true, text: '\\frac{1}{2}mv^2' },
        { target: targetOf(`data-assets/${A2}`), ok: true, text: 'x=v_0t' },
        { target: targetOf(`data-assets/${A3}`), ok: true, text: '$W=Fs\\cos\\theta$' },
      ],
    );
    expect(merged.analysis).not.toContain(A1);
    expect(merged.analysis).not.toContain(A3);
    expect(merged.analysis).toContain('<span class="math" data-tex="\\frac{1}{2}mv^2"></span>');
    expect(merged.analysis).toContain('<span class="math" data-tex="W=Fs\\cos\\theta"></span>');
    // 正文守恒（去标签后逐字一致）——本单的硬约束
    expect(textOutsideImages(merged.analysis)).toBe(textOutsideImages(ANALYSIS_TEXT_WITH_FIGURES));
    expect(merged.converted).toBe(3);
    expect(merged.failed).toEqual([]);
    // 字段整体替换路径未被触发（无「原有文字被整体替换」告警）
    expect(merged.warnings.some((w) => w.includes('整体替换'))).toBe(false);
  });

  it('裸 img（answer 有正文字段）原位替换：正文不变、img 消失', () => {
    const html = `<p>答案：由牛顿第二定律得</p><img src="data-assets/${A1}"><p>故 a=2 m/s²。</p>`;
    const merged = mergeAiClean(
      { content: '', answer: html, analysis: '', images: [] },
      [{ target: targetOf(`data-assets/${A1}`, { field: 'answer', region: 'answer' }), ok: true, text: 'a=\\frac{F}{m}' }],
    );
    expect(merged.answer).not.toContain('<img');
    expect(merged.answer).toContain('<span class="math" data-tex="a=\\frac{F}{m}"></span>');
    expect(textOutsideImages(merged.answer)).toBe(textOutsideImages(html));
  });

  it('原位替换失败 → 该图原样留、正文仍守恒（不静默丢图）', () => {
    const merged = mergeAiClean(
      { content: '', answer: '', analysis: ANALYSIS_TEXT_WITH_FIGURES, images: [] },
      [{ target: targetOf(`data-assets/${A1}`), ok: false, error: '模型超时' }],
    );
    expect(merged.analysis).toContain(A1);
    expect(merged.converted).toBe(0);
    expect(merged.failed.map((f) => f.field)).toEqual(['analysis']);
    expect(textOutsideImages(merged.analysis)).toBe(textOutsideImages(ANALYSIS_TEXT_WITH_FIGURES));
  });

  it('纯图字段仍走整字段替换（不因本单误改成原位）', () => {
    const merged = mergeAiClean(
      { content: '', answer: ANSWER_IMG, analysis: '', images: [] },
      [
        {
          target: targetOf('data-assets/capture/zujuan/ans-1.png', { field: 'answer', region: 'answer', kind: 'answer', mode: 'replace-field' }),
          ok: true,
          answerText: '0.6',
          analysisText: null,
        },
      ],
    );
    expect(merged.answer).toBe('<p>0.6</p>');
    expect(merged.converted).toBe(1);
  });

  it('题面块级配图（figure.diagram）不被原位替换波及（content 口径零变化）', () => {
    const content = '如图<figure class="diagram"><img src="data-assets/capture/jyeoo/jh1-1.png"></figure>所示';
    const merged = mergeAiClean(
      { content, answer: '', analysis: '', images: [] },
      [{ target: targetOf('data-assets/capture/jyeoo/jh1-1.png', { field: 'content', region: 'stem' }), ok: true, text: 'x' }],
    );
    expect(merged.content).toBe(content);
    expect(merged.converted).toBe(0);
  });

  it('images 列：answer/analysis 原位替换掉的图条目同样移除', () => {
    const merged = mergeAiClean(
      {
        content: '',
        answer: '',
        analysis: ANALYSIS_TEXT_WITH_FIGURES,
        images: [
          { assetId: `data-assets/${A1}`, type: 'formula-image' },
          { assetId: 'data-assets/capture/jyeoo/jh1-1.png', type: 'figure' },
        ],
      },
      [{ target: targetOf(`data-assets/${A1}`), ok: true, text: '\\frac{1}{2}mv^2' }],
    );
    expect(merged.images.map((i) => i.assetId)).toEqual(['data-assets/capture/jyeoo/jh1-1.png']);
  });
});
