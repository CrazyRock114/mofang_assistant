// 0013 程序化独立验收探针（验收方新写；题样/断言与施工方测试零重复）。
// 覆盖任务书「验收」段要求：三态类名输出 / 题级与卷级优先序 / 归一化单源 / 校验器白名单 /
// 预览协议收窄 / CSS 三处同步（paper.css + buildLayoutCss 注入 + app.css 镜像）。
// 渲染断言走 buildPaperHtml.core 的 renderQuestions（真实渲染入口，非 test 内复制逻辑）。

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import type { Question, PaperLayoutConfig } from '../../src/shared/contracts/bank-types.js';
import { renderQuestions } from '../../src/docgen/render/buildPaperHtml.core.js';
import { resolveLayout, normalizeOptionsLayout, buildLayoutCss } from '../../src/docgen/render/layout.js';
import { validateLayoutConfig } from '../../src/app/services/layout-config-validate.js';
import { parsePreviewMessage } from '../../src/app/pages/preview-frame-protocol.js';

/** 5 选项化学选择题（C 选项含行内 KaTeX；选项数≠4 以验非四选项自适应样本） */
function choice5(): Question {
  return {
    id: 'acc-c5',
    subject: '化学',
    sourceType: 'local',
    sourceDetail: { origin: 'accept-probe' },
    content:
      '<div class="question">下列关于物态变化的判断，正确的是？' +
      '<div class="options">' +
      '<span class="option">A. 冰化成水——熔化</span>' +
      '<span class="option">B. 露的形成——凝固</span>' +
      '<span class="option">C. <span class="math" data-tex="\\frac{1}{2}" data-display="false"></span> 为分界值</span>' +
      '<span class="option">D. 霜的形成——液化</span>' +
      '<span class="option">E. 雪的形成——凝华</span>' +
      '</div></div>',
    images: [],
    createdAt: '2026-09-14T00:00:00Z',
    updatedAt: '2026-09-14T00:00:00Z',
  };
}

/** 无 .options 容器的材料题（负样本：规则无目标） */
function material(): Question {
  return {
    id: 'acc-read',
    subject: '语文',
    sourceType: 'local',
    sourceDetail: { origin: 'accept-probe' },
    content: '<div class="question"><p>阅读下面的材料，回答后面的问题。</p><table><tr><td>材料表行</td></tr></table></div>',
    images: [],
    createdAt: '2026-09-14T00:00:00Z',
    updatedAt: '2026-09-14T00:00:00Z',
  };
}

/** 题容器开标签（类名断言锚点） */
function itemTagOf(html: string): string {
  const hit = /<div class="question-item[^"]*">/.exec(html);
  return hit ? hit[0] : '(未命中题容器)';
}

const choice = choice5();

describe('0013 验收探针 ① 渲染三态类名（卷级）', () => {
  it('single-line → ol-single；two-lines → ol-two；缺省/非法值/基线路径 → 不加类', () => {
    expect(itemTagOf(renderQuestions([choice], {
      mode: 'student', layoutConfig: { version: 2, optionsLayout: 'single-line' },
    }))).toBe('<div class="question-item ol-single">');

    expect(itemTagOf(renderQuestions([choice], {
      mode: 'student', layoutConfig: { version: 2, optionsLayout: 'two-lines' },
    }))).toBe('<div class="question-item ol-two">');

    const defaulted = renderQuestions([choice], { mode: 'student', layoutConfig: { version: 2 } });
    expect(itemTagOf(defaulted)).toBe('<div class="question-item">');

    const bogus = JSON.parse('{"version":2,"optionsLayout":"SINGLE-LINE"}') as PaperLayoutConfig;
    expect(itemTagOf(renderQuestions([choice], { mode: 'student', layoutConfig: bogus })))
      .toBe('<div class="question-item">');

    // 基线路径（无 config 无覆盖）与卷级显式 auto 输出同形 ⇒ auto 不加类零回归
    const baseline = renderQuestions([choice], { mode: 'student' });
    expect(itemTagOf(baseline)).toBe('<div class="question-item">');
    const explicitAuto = renderQuestions([choice], {
      mode: 'student', layoutConfig: { version: 2, optionsLayout: 'auto' },
    });
    expect(itemTagOf(explicitAuto)).toBe(itemTagOf(defaulted));
  });
});

describe('0013 验收探针 ② 生效值优先序（题级覆盖 ?? 卷级 ?? auto）', () => {
  it('题级 two-lines 压卷级 single-line；题级显式 auto 压卷级 two-lines；题级缺省落卷级', () => {
    const perQWin = renderQuestions([choice], {
      mode: 'student',
      layoutConfig: { version: 2, optionsLayout: 'single-line' },
      questionLayouts: { 'acc-c5': { optionsLayout: 'two-lines' } },
    });
    expect(itemTagOf(perQWin)).toBe('<div class="question-item ol-two">');
    expect(perQWin).not.toContain('ol-single');

    const backToAuto = renderQuestions([choice], {
      mode: 'student',
      layoutConfig: { version: 2, optionsLayout: 'two-lines' },
      questionLayouts: { 'acc-c5': { optionsLayout: 'auto' } },
    });
    expect(itemTagOf(backToAuto)).toBe('<div class="question-item">');
    expect(backToAuto).not.toContain('ol-two');

    const fallThrough = renderQuestions([choice], {
      mode: 'student',
      layoutConfig: { version: 2, optionsLayout: 'single-line' },
      questionLayouts: { 'acc-c5': {} },
    });
    expect(itemTagOf(fallThrough)).toBe('<div class="question-item ol-single">');

    // 无卷级档、仅题级覆盖：题级 two-lines 生效（config 缺省 auto）
    const perQOnly = renderQuestions([choice], {
      mode: 'student',
      questionLayouts: { 'acc-c5': { optionsLayout: 'two-lines' } },
    });
    expect(itemTagOf(perQOnly)).toBe('<div class="question-item ol-two">');
  });
});

describe('0013 验收探针 ③ normalizeOptionsLayout 归一（渲染外用例）', () => {
  it('三合法值透传；空格/大小写/下划线/未知/空串/null/undefined/数字/对象/布尔 → auto', () => {
    expect(normalizeOptionsLayout('auto')).toBe('auto');
    expect(normalizeOptionsLayout('single-line')).toBe('single-line');
    expect(normalizeOptionsLayout('two-lines')).toBe('two-lines');

    expect(normalizeOptionsLayout(' SINGLE-LINE ')).toBe('auto');
    expect(normalizeOptionsLayout('single_line')).toBe('auto');
    expect(normalizeOptionsLayout('two_lines')).toBe('auto');
    expect(normalizeOptionsLayout('x')).toBe('auto');
    expect(normalizeOptionsLayout('')).toBe('auto');
    expect(normalizeOptionsLayout(null)).toBe('auto');
    expect(normalizeOptionsLayout(undefined)).toBe('auto');
    expect(normalizeOptionsLayout(JSON.parse('0') as string)).toBe('auto');
    expect(normalizeOptionsLayout(JSON.parse('{"mode":"two-lines"}') as string)).toBe('auto');
    expect(normalizeOptionsLayout(JSON.parse('true') as string)).toBe('auto');

    expect(resolveLayout({ version: 2, optionsLayout: 'two-lines' }).optionsLayout).toBe('two-lines');
    expect(resolveLayout(JSON.parse('{"version":2,"optionsLayout":"TWO-LINES"}') as PaperLayoutConfig).optionsLayout).toBe('auto');
    expect(resolveLayout(undefined).optionsLayout).toBe('auto');
  });
});

describe('0013 验收探针 ④ 校验器白名单（layout-config-validate）', () => {
  it('三合法值放行；非法值（大小写/数字/布尔/null）剔字段；未知字段丢弃；缺省不产键；经 resolveLayout 保留', () => {
    expect(validateLayoutConfig({ version: 2, optionsLayout: 'auto' }).optionsLayout).toBe('auto');
    expect(validateLayoutConfig({ version: 2, optionsLayout: 'single-line' }).optionsLayout).toBe('single-line');
    expect(validateLayoutConfig({ version: 2, optionsLayout: 'two-lines' }).optionsLayout).toBe('two-lines');

    const badCase = JSON.parse('{"version":2,"optionsLayout":"Single-Line","probeUnknown":123}') as object;
    const cleaned = validateLayoutConfig(badCase);
    expect(cleaned.optionsLayout).toBeUndefined();
    expect('probeUnknown' in cleaned).toBe(false);

    const badNum = JSON.parse('{"version":2,"optionsLayout":2}') as object;
    expect(validateLayoutConfig(badNum).optionsLayout).toBeUndefined();
    const badBool = JSON.parse('{"version":2,"optionsLayout":true}') as object;
    expect(validateLayoutConfig(badBool).optionsLayout).toBeUndefined();
    const badNull = JSON.parse('{"version":2,"optionsLayout":null}') as object;
    expect(validateLayoutConfig(badNull).optionsLayout).toBeUndefined();

    expect('optionsLayout' in validateLayoutConfig({ version: 2 })).toBe(false);
    expect(resolveLayout(validateLayoutConfig({ version: 2, optionsLayout: 'two-lines' })).optionsLayout).toBe('two-lines');
  });
});

describe('0013 验收探针 ⑤ 预览协议收窄（parsePreviewMessage）', () => {
  it('三合法 mode 通过且多余字段丢弃；坏 mode/mode 非字符串/缺 questionId/非对象 → null', () => {
    expect(parsePreviewMessage({ t: 'mf-question-options-layout', questionId: 'acc-c5', mode: 'auto' }))
      .toEqual({ t: 'mf-question-options-layout', questionId: 'acc-c5', mode: 'auto' });
    expect(parsePreviewMessage({ t: 'mf-question-options-layout', questionId: 'acc-c5', mode: 'single-line' }))
      .toEqual({ t: 'mf-question-options-layout', questionId: 'acc-c5', mode: 'single-line' });
    expect(parsePreviewMessage({ t: 'mf-question-options-layout', questionId: 'acc-c5', mode: 'two-lines' }))
      .toEqual({ t: 'mf-question-options-layout', questionId: 'acc-c5', mode: 'two-lines' });
    expect(parsePreviewMessage({ t: 'mf-question-options-layout', questionId: 'acc-c5', mode: 'two-lines', evil: 1 }))
      .toEqual({ t: 'mf-question-options-layout', questionId: 'acc-c5', mode: 'two-lines' });

    expect(parsePreviewMessage({ t: 'mf-question-options-layout', questionId: 'acc-c5', mode: 'TWO-LINES' })).toBeNull();
    expect(parsePreviewMessage({ t: 'mf-question-options-layout', questionId: 'acc-c5', mode: 'two_lines' })).toBeNull();
    expect(parsePreviewMessage({ t: 'mf-question-options-layout', questionId: 'acc-c5', mode: '' })).toBeNull();
    expect(parsePreviewMessage({ t: 'mf-question-options-layout', questionId: 'acc-c5', mode: 2 })).toBeNull();
    expect(parsePreviewMessage({ t: 'mf-question-options-layout', questionId: 'acc-c5', mode: null })).toBeNull();
    expect(parsePreviewMessage({ t: 'mf-question-options-layout', questionId: 'acc-c5' })).toBeNull();
    expect(parsePreviewMessage({ t: 'mf-question-options-layout', mode: 'auto' })).toBeNull();
    expect(parsePreviewMessage({ t: 'mf-question-options-layout', questionId: 7, mode: 'auto' })).toBeNull();
    expect(parsePreviewMessage({ t: 'mf-question-options-layout', questionId: 'acc-c5', mode: { v: 'auto' } })).toBeNull();
    expect(parsePreviewMessage(null)).toBeNull();
  });
});

describe('0013 验收探针 ⑥ CSS 三处同步 + 严格子选择器纪律', () => {
  const norm = (css: string) => css.replace(/\s+/g, ' ');
  const paperCss = norm(readFileSync(new URL('../../src/docgen/render/paper.css', import.meta.url), 'utf-8'));
  const appCss = norm(readFileSync(new URL('../../src/app/app.css', import.meta.url), 'utf-8'));
  const injected = norm(buildLayoutCss(resolveLayout({ version: 2, optionsLayout: 'single-line' })));

  const RULES = [
    '.options { break-inside: avoid; }',
    '.ol-single .options { display: flex; gap: 1.2em; }',
    '.ol-single .options > .option { display: block; flex: 1 1 0; padding-left: 0; }',
    '.ol-two .options { display: grid; grid-template-columns: 1fr 1fr; column-gap: 1.2em; }',
    '.ol-two .options > .option { display: block; padding-left: 0; }',
  ];
  const SPECIFICITY_OVERRIDES = [
    '.question-item.ol-single .options > .option { padding-left: 0; }',
    '.question-item.ol-two .options > .option { padding-left: 0; }',
  ];

  it('paper.css 基础层含五条结构规则 + 两条特异性覆盖行；无后代选择器写法', () => {
    for (const rule of RULES) expect(paperCss).toContain(rule);
    for (const rule of SPECIFICITY_OVERRIDES) expect(paperCss).toContain(rule);
    expect(paperCss).not.toContain('.ol-single .options .option');
    expect(paperCss).not.toContain('.ol-two .options .option');
  });

  it('buildLayoutCss 注入同五条 + 两条覆盖行；规则独立于卷级档（auto 卷也注入，惰性不误伤）', () => {
    for (const rule of RULES) expect(injected).toContain(rule);
    for (const rule of SPECIFICITY_OVERRIDES) expect(injected).toContain(rule);
    const autoInjected = norm(buildLayoutCss(resolveLayout({ version: 2 })));
    for (const rule of RULES) expect(autoInjected).toContain(rule);
    expect(injected).not.toContain('.ol-single .options .option');
  });

  it('app.css 题卡镜像含同五条结构规则（ol-single flex / ol-two grid / break-inside）', () => {
    for (const rule of RULES) expect(appCss).toContain(rule);
  });

  it('题容器类与 CSS 命中面：strict-child 结构（真实 DOM 解析）——5 个直接子代 .option、公式在项内', () => {
    const html = renderQuestions([choice], {
      mode: 'student', layoutConfig: { version: 2, optionsLayout: 'single-line' },
    });
    const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`);
    const container = dom.window.document.querySelector('.options');
    expect(container).not.toBeNull();
    const children = Array.from(container!.children);
    expect(children).toHaveLength(5);
    expect(children.every((el) => el.classList.contains('option'))).toBe(true);
    // 严格子代语义：KaTeX 内部 span 不落在 .options 直接子级（否则后代选择器会崩公式）
    expect(Array.from(container!.children).filter((el) => el.classList.contains('katex'))).toHaveLength(0);
    expect(container!.querySelector('.option .katex')).not.toBeNull();
    expect(dom.window.document.querySelectorAll('.option .katex').length).toBe(1);
    // 分列容器只落在题容器上，选项容器自身无内联样式侵入
    expect(container!.getAttribute('style')).toBeNull();
  });

  it('无选项材料题：不产生 .options 容器、分列规则无目标、题面原序保持', () => {
    const html = renderQuestions([material()], {
      mode: 'student', layoutConfig: { version: 2, optionsLayout: 'two-lines' },
    });
    expect(itemTagOf(html)).toBe('<div class="question-item ol-two">');
    expect(html).not.toContain('class="options"');
    expect(html.indexOf('阅读下面的材料')).toBeLessThan(html.indexOf('材料表行'));
  });
});
