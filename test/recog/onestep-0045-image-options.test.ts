// 0045 P4：引擎侧图片选项 + 选项数≠4（3/5/6 项）全链测试（任务书 §四）。
// 口径：OnestepOption.content 只增 [图N] 占位引用该题图块（同题干图块机制）；
// optionsToHtml 把占位转为 span.inline-figure 内联图（契约对齐采集层），block figure 不得进 span.option。

import { describe, it, expect } from 'vitest';
import { optionsToHtml, composeCardContentHtml, stemMarkdownToHtml } from '../../src/recog/onestep/markdown';
import { extractOptionsFromStem } from '../../src/recog/onestep/options';
import { draftToCard } from '../../src/recog/onestep/workbench';
import type { OnestepDraft } from '../../src/shared/contracts/onestep-types';

describe('0045 P4：选项数≠4 引擎链（3/5/6 项）', () => {
  it('题干内联「A．… E．…」5 项选项块可还原（A 起连续）', () => {
    const md = '下列说法正确的是\nA．甲对\nB．乙错\nC．丙对\nD．丁错\nE．戊对';
    const out = extractOptionsFromStem(md);
    expect(out).not.toBeNull();
    expect(out!.options.map((o) => o.label)).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(out!.options[3]!.content).toBe('丁错');
    expect(out!.stem).toBe('下列说法正确的是');
  });

  it('3 项与 6 项选项块均可还原', () => {
    const three = extractOptionsFromStem('判断如下\nA. 对\nB. 错\nC. 不确定');
    expect(three?.options.map((o) => o.label)).toEqual(['A', 'B', 'C']);
    const six = extractOptionsFromStem('匹配题\nA. 1\nB. 2\nC. 3\nD. 4\nE. 5\nF. 6');
    expect(six?.options.map((o) => o.label)).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
  });

  it('结构化 3 项 options 经 optionsToHtml 输出 3 个 span.option（标号前置）', () => {
    const html = optionsToHtml([
      { label: 'A', content: '一' },
      { label: 'B', content: '二' },
      { label: 'C', content: '三' },
    ]);
    expect(html).toBe('<div class="options"><span class="option">A. 一</span><span class="option">B. 二</span><span class="option">C. 三</span></div>');
  });
});

describe('0045 P4：图片选项（[图N] 占位 → span.inline-figure 内联图）', () => {
  it('选项 content 里的 [图1] 转为内联图并取到真图 src 与尺寸', () => {
    const html = optionsToHtml(
      [
        { label: 'A', content: '[图1] 所示装置' },
        { label: 'B', content: '纯文本' },
      ],
      {
        figureSrc: (n) => (n === 1 ? 'data:image/png;base64,AAA=' : undefined),
        figureSize: (n) => (n === 1 ? { width: 48, height: 18 } : undefined),
      },
    );
    expect(html).toContain('<span class="option">A. <span class="inline-figure"><img class="q-figure" data-w="48" data-h="18" src="data:image/png;base64,AAA="></span> 所示装置</span>');
    expect(html).toContain('<span class="option">B. 纯文本</span>');
    // 图片选项不得落块级 figure.diagram（块级图进 span 会被 schema 提升、破版式）
    expect(html).not.toContain('figure class="diagram"');
  });

  it('缺图（figureSrc 未命中）落空 src 占位，不静默丢占位', () => {
    const html = optionsToHtml([{ label: 'A', content: '[图2] 缺图' }]);
    expect(html).toContain('<span class="inline-figure"><img class="q-figure" data-w="0" data-h="0" src="">');
    expect(html).not.toContain('[图2]');
  });

  it('draftToCard：题干与选项的 [图N] 都替换为真图（图块同源）', () => {
    const draft: OnestepDraft = {
      qno: '5',
      questionType: '单选',
      stemMarkdown: '如图 [图1] 所示的电路，闭合开关后',
      options: [
        { label: 'A', content: '[图1] 灯亮' },
        { label: 'B', content: '灯不亮' },
      ],
      answerMarkdown: 'A',
      analysisMarkdown: null,
      suggestedTags: [],
      figures: [{ ref: '图1', bbox: [0.1, 0.1, 0.5, 0.4] }],
      figureSource: 'dso',
      warnings: [],
    };
    const card = draftToCard(draft, {
      id: 'c1',
      source: 'ai',
      pageNo: 2,
      figureSrc: () => 'data:image/png;base64,BBB=',
      figureSize: () => ({ width: 120, height: 60 }),
    });
    // 题干图块仍是块级 figure.diagram（图芯片可拖动调位）
    expect(card.contentHtml).toContain('<figure class="diagram"');
    expect(card.contentHtml).toContain('src="data:image/png;base64,BBB="');
    // 选项内为行内图（同源真图）
    expect(card.contentHtml).toContain('<span class="option">A. <span class="inline-figure"><img class="q-figure" data-w="120" data-h="60" src="data:image/png;base64,BBB="></span> 灯亮</span>');
    // 无 [图N] 残留
    expect(card.contentHtml).not.toContain('[图1]');
    // 图块坐标照常登记
    expect(card.figures).toHaveLength(1);
    expect(card.figures[0]!.ref).toBe('图1');
  });

  it('composeCardContentHtml 透传渲染参数（题干+选项一次组装）', () => {
    const renderOptions = {
      figureSrc: () => 'data:image/gif;base64,C=',
      figureSize: () => ({ width: 10, height: 8 }),
    };
    // 题干先经 stemMarkdownToHtml（[图N] → 块级图块），选项随 composeCardContentHtml 透传（[图N] → 行内图）
    const stemHtml = stemMarkdownToHtml('题干 [图1]', renderOptions);
    const html = composeCardContentHtml(stemHtml, [{ label: 'A', content: '[图1]' }], renderOptions);
    expect(html).toContain('<figure class="diagram"');
    expect(html).toContain('<span class="inline-figure"');
    expect(html).toContain('data:image/gif;base64,C=');
  });
});
