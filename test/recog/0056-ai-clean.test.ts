// 0056（R-041）：采集题 AI 整理·纯函数层（图定位 plan + 合回 merge）。
//
// 口径（任务书 §零.3/§零.6/§一.1 三条拍板）：
//   ① 整理对象 = 行内公式图（content 内 span.inline-figure 包裹；题干区与选项区都算）+ 答案/解析区的图；
//      块级 figure.diagram（真配图）不转写——它不是公式；
//   ② 答案防采集图（answer 区单图，answer+解析合一）转写后 answer/analysis 双出、空侧留空；
//   ③ 公式位换 <span class="math" data-tex>；images 列同步移除已转文字的图条目（任务书 §零.6）。
//
// 纯函数零 IO：图字节由调用方喂，本层只做「定位」与「合回」。

import { describe, it, expect } from 'vitest';

import type { QuestionImage } from '../../src/shared/contracts/bank-types.js';
import { planAiClean, assetRelPathOf, type AiCleanTarget } from '../../src/recog/ai-clean/plan.js';
import { mergeAiClean, formulaHtmlOf } from '../../src/recog/ai-clean/merge.js';

/** 采集题典型 content：题干行内公式图 + 块级配图 + 选项区行内公式图 */
const CONTENT_MIXED = [
  '<div class="question">',
  '如图所示，物体受',
  '<span class="inline-figure"><img class="q-figure" data-w="84" data-h="20" src="data-assets/capture/zujuan/f1.png"></span>',
  '作用，求',
  '<span class="inline-figure"><img class="q-figure" data-w="66" data-h="16" src="data-assets/capture/zujuan/f2.png"></span>',
  '的大小。',
  '<figure class="diagram" data-w="197" data-h="122"><img class="q-figure" src="data-assets/capture/jyeoo/jh1-1.png"></figure>',
  '<div class="options">',
  '<span class="option">A. <span class="inline-figure"><img class="q-figure" data-w="33" data-h="12" src="data-assets/capture/zujuan/f3.svg"></span></span>',
  '<span class="option">B. 0.8</span>',
  '</div>',
  '</div>',
].join('');

/** 答案区防采集图（zujuan 形态：answerHtml 就是一张裸 img，analysisHtml 空） */
const ANSWER_IMG = '<img src="data-assets/capture/zujuan/ans-1.png">';

describe('0056 plan：图定位', () => {
  it('题干区行内公式图 → 靶（region=stem / kind=formula / 资产路径可解）', () => {
    const plan = planAiClean({ content: CONTENT_MIXED, answer: '', analysis: '' });
    const stemTargets = plan.targets.filter((t) => t.region === 'stem');
    expect(stemTargets.map((t) => t.src)).toEqual([
      'data-assets/capture/zujuan/f1.png',
      'data-assets/capture/zujuan/f2.png',
    ]);
    expect(stemTargets.every((t) => t.field === 'content' && t.kind === 'formula')).toBe(true);
    expect(stemTargets[0]!.assetRelPath).toBe('capture/zujuan/f1.png');
    expect(stemTargets[0]!.width).toBe(84);
    expect(stemTargets[0]!.height).toBe(20);
  });

  it('块级 figure.diagram（真配图）不进靶——它不是公式', () => {
    const plan = planAiClean({ content: CONTENT_MIXED, answer: '', analysis: '' });
    expect(plan.targets.some((t) => t.src.includes('jh1-1.png'))).toBe(false);
  });

  it('选项区行内图单独标 region=options（合回仍原位替换，但统计口径可分）', () => {
    const plan = planAiClean({ content: CONTENT_MIXED, answer: '', analysis: '' });
    const optTargets = plan.targets.filter((t) => t.region === 'options');
    expect(optTargets.map((t) => t.src)).toEqual(['data-assets/capture/zujuan/f3.svg']);
  });

  it('答案区图 → field=answer / region=answer / kind=answer', () => {
    const plan = planAiClean({ content: CONTENT_MIXED, answer: ANSWER_IMG, analysis: '' });
    const answerTargets = plan.targets.filter((t) => t.field === 'answer');
    expect(answerTargets).toHaveLength(1);
    expect(answerTargets[0]!.kind).toBe('answer');
    expect(answerTargets[0]!.assetRelPath).toBe('capture/zujuan/ans-1.png');
  });

  it('解析区图同口径（field=analysis / region=analysis；字段就是一张图）', () => {
    const plan = planAiClean({
      content: CONTENT_MIXED,
      answer: '',
      analysis: '<img src="data-assets/capture/zujuan/ans-analysis.png">',
    });
    expect(plan.targets.filter((t) => t.field === 'analysis').map((t) => t.region)).toEqual(['analysis']);
    expect(plan.deferred).toEqual([]);
  });

  // ---- 返工⑧：解析/答案区「混在正文里的图」不属本批 ----
  // 【0065（R-068）等强改写，登记在案】口径变更：含正文字段的图**不再进 deferred 挡门**，改为
  // 该字段走「原位替换」模式（`mode='inline-figures'`）——0056 时代整字段替换会冲掉正文，
  // 故当时放弃；0065 起逐图原位替换，正文一字不动（见 test/recog/0065-answer-analysis.test.ts）。
  // 断言只强不弱：原断言「targets 为空 + 进 deferred」，现断言「成为 inline 靶 + deferred 为空 + reason 为空」。
  it('0065 改写：解析区含正文 → 内嵌图成为 inline 靶（原 deferred 挡门已退役），纯图字段才是整字段靶', () => {
    const withText = planAiClean({
      content: '',
      answer: '',
      analysis: '<p>解析：由牛顿第二定律</p><img src="data-assets/capture/zujuan/ans-analysis.png">',
    });
    expect(withText.targets.map((t) => [t.field, t.kind, t.mode])).toEqual([
      ['analysis', 'formula', 'inline-figures'],
    ]);
    expect(withText.targets[0]!.assetRelPath).toBe('capture/zujuan/ans-analysis.png');
    expect(withText.deferred).toEqual([]);
    expect(withText.reason).toBeNull();

    const imageOnly = planAiClean({
      content: '',
      answer: '<figure class="diagram"><img src="data-assets/capture/zujuan/ans-page.jpg"></figure>',
      analysis: '',
    });
    expect(imageOnly.targets.map((t) => t.assetRelPath)).toEqual(['capture/zujuan/ans-page.jpg']);
    expect(imageOnly.targets[0]!.mode).toBe('replace-field');
    expect(imageOnly.deferred).toEqual([]);
  });

  it('无图题：targets 空 + reason 非空（不静默空跑）', () => {
    const plan = planAiClean({ content: '<div class="question">纯文字题</div>', answer: '0.6', analysis: '' });
    expect(plan.targets).toEqual([]);
    expect(plan.reason).toBeTruthy();
  });

  it('assetRelPathOf：非 data-assets 引用（远程 src/data URL）不可解 → null', () => {
    expect(assetRelPathOf('data-assets/capture/recog/x.png')).toBe('capture/recog/x.png');
    expect(assetRelPathOf('https://img.jyeoo.net/a.png')).toBeNull();
    expect(assetRelPathOf('data:image/png;base64,AAAA')).toBeNull();
  });
});

describe('0056 formulaHtmlOf：转写文本 → 公式位 HTML', () => {
  it('带 $…$ 定界：走既有 markdown→契约 HTML，取行内 math span', () => {
    expect(formulaHtmlOf('$\\sin 37°=0.6$')).toBe('<span class="math" data-tex="\\sin 37°=0.6"></span>');
  });

  it('$$…$$ 定界 → 独立公式（data-display="true"）', () => {
    expect(formulaHtmlOf('$$x^2+y^2=r^2$$')).toBe('<span class="math" data-tex="x^2+y^2=r^2" data-display="true"></span>');
  });

  it('一行多公式：逐段转 span，公式外的文字保留（不吞内容）', () => {
    const html = formulaHtmlOf('$\\sin 37°=0.6$，$\\cos 37°=0.8$');
    expect(html).toBe(
      '<span class="math" data-tex="\\sin 37°=0.6"></span>，<span class="math" data-tex="\\cos 37°=0.8"></span>',
    );
  });

  it('无定界：整段视为 LaTeX 源（引擎对「单图=单公式」的产出形态）', () => {
    expect(formulaHtmlOf('\\frac{1}{2}mv^2')).toBe('<span class="math" data-tex="\\frac{1}{2}mv^2"></span>');
  });

  it('目检返工②：`\\( … \\)` 定界（DeepSeek-OCR 等专用 OCR 产出形态）→ 行内 math span', () => {
    expect(formulaHtmlOf('\\( \\sin 37°=0.6 \\)')).toBe('<span class="math" data-tex="\\sin 37°=0.6"></span>');
  });

  it('目检返工②：`\\[ … \\]` 定界 → 独立公式（data-display）', () => {
    expect(formulaHtmlOf('\\[ x^2+y^2=r^2 \\]')).toBe('<span class="math" data-tex="x^2+y^2=r^2" data-display="true"></span>');
  });

  it('目检返工②：DSO 形态整句（中文 + \\(…\\) 混排）→ 公式位正确切出、文字保留', () => {
    const html = formulaHtmlOf('交流电源的电压 \\( U \\) 保持不变，定值电阻为 \\( R_0 \\)');
    expect(html).toBe('交流电源的电压 <span class="math" data-tex="U"></span> 保持不变，定值电阻为 <span class="math" data-tex="R_0"></span>');
  });
});

describe('0056 merge：公式位换文字 + 答案拆分 + images 维护', () => {
  const images: QuestionImage[] = [
    { assetId: 'data-assets/capture/zujuan/f1.png', type: 'figure' },
    { assetId: 'data-assets/capture/jyeoo/jh1-1.png', type: 'figure' },
    { assetId: 'data-assets/capture/zujuan/ans-1.png', type: 'answer-image' },
  ];

  function targetOf(src: string, kind: AiCleanTarget['kind'], field: AiCleanTarget['field'], region: AiCleanTarget['region']): AiCleanTarget {
    return { field, region, src, assetRelPath: src.replace(/^data-assets\//, ''), kind, width: 84, height: 20 };
  }

  it('公式靶成功 → 原 span 消失、原位换 span.math（其余内容逐字不动）', () => {
    const merged = mergeAiClean(
      { content: CONTENT_MIXED, answer: ANSWER_IMG, analysis: '', images },
      [
        { target: targetOf('data-assets/capture/zujuan/f1.png', 'formula', 'content', 'stem'), ok: true, text: '$\\sin 37°=0.6$' },
      ],
    );
    expect(merged.content).not.toContain('f1.png');
    expect(merged.content).toContain('<span class="math" data-tex="\\sin 37°=0.6"></span>');
    // 未转的图原样保留（含块级配图）
    expect(merged.content).toContain('data-assets/capture/jyeoo/jh1-1.png');
    expect(merged.content).toContain('data-assets/capture/zujuan/f2.png');
    expect(merged.converted).toBe(1);
    expect(merged.failed).toEqual([]);
  });

  it('答案靶成功 → answer/analysis 双出、空侧留空（拍板②）', () => {
    const merged = mergeAiClean(
      { content: CONTENT_MIXED, answer: ANSWER_IMG, analysis: '', images },
      [
        {
          target: targetOf('data-assets/capture/zujuan/ans-1.png', 'answer', 'answer', 'answer'),
          ok: true,
          answerText: '0.6',
          analysisText: null,
        },
      ],
    );
    expect(merged.answer).toBe('<p>0.6</p>');
    expect(merged.analysis).toBe('');
    expect(merged.answer).not.toContain('<img');
  });

  it('答案靶双出：answer 空侧留空、analysis 有文字', () => {
    const merged = mergeAiClean(
      { content: CONTENT_MIXED, answer: ANSWER_IMG, analysis: '', images },
      [
        {
          target: targetOf('data-assets/capture/zujuan/ans-1.png', 'answer', 'answer', 'answer'),
          ok: true,
          answerText: null,
          analysisText: '由 $v=at$ 得…',
        },
      ],
    );
    expect(merged.answer).toBe('');
    expect(merged.analysis).toBe('<p>由 <span class="math" data-tex="v=at"></span> 得…</p>');
  });

  it('答案靶两侧全空 → 判失败，字段不动（不把答案写成空）', () => {
    const merged = mergeAiClean(
      { content: CONTENT_MIXED, answer: ANSWER_IMG, analysis: '', images },
      [
        {
          target: targetOf('data-assets/capture/zujuan/ans-1.png', 'answer', 'answer', 'answer'),
          ok: true,
          answerText: null,
          analysisText: null,
        },
      ],
    );
    expect(merged.answer).toBe(ANSWER_IMG);
    expect(merged.converted).toBe(0);
    expect(merged.failed).toHaveLength(1);
  });

  it('单图失败 → 该图原样保留 + 记账（其余图照转）', () => {
    const merged = mergeAiClean(
      { content: CONTENT_MIXED, answer: '', analysis: '', images },
      [
        { target: targetOf('data-assets/capture/zujuan/f1.png', 'formula', 'content', 'stem'), ok: false, error: '模型超时' },
        { target: targetOf('data-assets/capture/zujuan/f2.png', 'formula', 'content', 'stem'), ok: true, text: '\\cos 37°=0.8' },
      ],
    );
    expect(merged.content).toContain('data-assets/capture/zujuan/f1.png');
    expect(merged.content).toContain('<span class="math" data-tex="\\cos 37°=0.8"></span>');
    expect(merged.converted).toBe(1);
    expect(merged.failed).toEqual([{ src: 'data-assets/capture/zujuan/f1.png', field: 'content', reason: '模型超时' }]);
  });

  it('images 列：已转文字的图条目移除，未转条目（含块级配图）保留', () => {
    const merged = mergeAiClean(
      { content: CONTENT_MIXED, answer: ANSWER_IMG, analysis: '', images },
      [
        { target: targetOf('data-assets/capture/zujuan/f1.png', 'formula', 'content', 'stem'), ok: true, text: '$x$' },
        {
          target: targetOf('data-assets/capture/zujuan/ans-1.png', 'answer', 'answer', 'answer'),
          ok: true,
          answerText: '0.6',
          analysisText: null,
        },
      ],
    );
    expect(merged.images.map((i) => i.assetId)).toEqual(['data-assets/capture/jyeoo/jh1-1.png']);
  });

  it('images 列：旧形态（无前缀 / 字符串条目）同样能命中移除', () => {
    const legacy = [
      'capture/zujuan/f1.png',
      { assetId: 'capture/jyeoo/jh1-1.png', type: 'figure' },
    ] as unknown as QuestionImage[];
    const merged = mergeAiClean(
      { content: CONTENT_MIXED, answer: '', analysis: '', images: legacy },
      [
        { target: targetOf('data-assets/capture/zujuan/f1.png', 'formula', 'content', 'stem'), ok: true, text: '$x$' },
      ],
    );
    expect(merged.images.map((i) => (typeof i === 'string' ? i : i.assetId))).toEqual(['capture/jyeoo/jh1-1.png']);
  });

  it('答案区原有文字被整理结果整体替换 → 记 warning（弹层可见，不静默丢内容）', () => {
    const merged = mergeAiClean(
      { content: CONTENT_MIXED, answer: `<p>原答案文字</p>${ANSWER_IMG}`, analysis: '', images },
      [
        {
          target: targetOf('data-assets/capture/zujuan/ans-1.png', 'answer', 'answer', 'answer'),
          ok: true,
          answerText: '0.6',
          analysisText: null,
        },
      ],
    );
    expect(merged.answer).toBe('<p>0.6</p>');
    expect(merged.warnings.some((w) => w.includes('答案区'))).toBe(true);
  });
});
