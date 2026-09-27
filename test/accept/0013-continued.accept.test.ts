// 0013 程序化独立验收探针（验收方新写）：跨页续片继承题容器版式类（报告 §七 实机修复点）。
// 与施工方用例的差异：自建 fixture（ol-two + 4 选项）、deferSetup 由探针显式触发起页化，
// 并在起页化前人为给原题容器挂上 mf-q-hover / mf-q-selected（模拟父层重建前的交互态），
// 逐一验证续片类名继承及其「剔除分页/交互标记类」的收窄口径。
// @vitest-environment jsdom

import { describe, it, expect, afterEach } from 'vitest';
import { injectPreviewScript } from '../../src/app/pages/preview-frame-script.js';

declare global {
  interface Window {
    __mofangPaginate?: { setup: () => void };
  }
}

const PAGE_W_MM = 210;
const PAGE_H_MM = 297;

/** 单题 fixture：长题干（860px）+ 4 选项组（180px）→ 选项组被推到下一页成续片 */
function fixtureHtml(itemClasses: string): string {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>0013 验收续片探针</title></head><body>' +
    '<div class="paper" style="box-sizing: border-box; padding: 60.75px 56.69px;">' +
    '<div class="paper-header"><h1 class="paper-title">0013 验收续片探针卷</h1></div>' +
    '<div class="paper-questions">' +
    `<div class="${itemClasses}">` +
    '<div class="question-header"><span class="question-number">1.</span></div>' +
    '<div class="mf-question-body"><div class="question-content">' +
    '<p class="acc-tall">占满首页剩余容量的长题干（验收方独立探针，非施工方样本）。</p>' +
    '<div class="options"><span class="option">A. 甲选项</span><span class="option">B. 乙选项</span>' +
    '<span class="option">C. 丙选项</span><span class="option">D. 丁选项</span></div>' +
    '</div></div></div>' +
    '</div></div></body></html>';
}

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length > 0) restores.pop()!();
  document.body.innerHTML = '';
  delete window.__mofangPaginate;
});

/** 布局度量打桩（验收方自建口径）：题块/选项组有高度，sheet 的 scrollHeight=子块和、clientHeight=内容区高 */
function stubLayout(): void {
  const sumOf = (el: Element) => Array.from(el.children).reduce((acc, child) => acc + heightOf(child), 0);
  const maxOf = (el: Element) => Array.from(el.children).reduce((acc, child) => Math.max(acc, heightOf(child)), 0);

  function heightOf(el: Element): number {
    if (el.classList.contains('mf-sheet')) return sumOf(el);
    if (el.classList.contains('mf-sheet-cols')) return maxOf(el);
    if (el.classList.contains('mf-col')) return sumOf(el);
    if (el.classList.contains('paper-header')) return 100;
    if (el.classList.contains('question-header')) return 20;
    if (el.classList.contains('mf-paged-note') || el.classList.contains('paper-footer')) return 20;
    if (el.classList.contains('acc-tall')) return 860;
    if (el.classList.contains('options')) return 180;
    if (el.classList.contains('mf-unit-wrap')) {
      if (el.classList.contains('acc-tall') || el.querySelector('.acc-tall')) return 860;
      if (el.querySelector('.option')) return 180;
      return 0;
    }
    return 0;
  }

  const origRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const h = heightOf(this);
    return { width: 600, height: h, top: 0, left: 0, right: 600, bottom: h, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
  restores.push(() => { Element.prototype.getBoundingClientRect = origRect; });

  const define = (prop: 'offsetHeight' | 'scrollHeight' | 'clientHeight', get: (el: HTMLElement) => number) => {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get(this: HTMLElement) { return get(this); } });
    restores.push(() => { Reflect.deleteProperty(HTMLElement.prototype, prop); });
  };
  define('offsetHeight', (el) => heightOf(el));
  define('scrollHeight', (el) => heightOf(el));
  define('clientHeight', (el) => {
    if (el.classList.contains('mf-col')) return Math.max(1, parseFloat(el.style.height) || 0);
    if (!el.classList.contains('mf-sheet')) return heightOf(el);
    const height = parseFloat(el.style.height) || 0;
    const padT = parseFloat(el.style.paddingTop) || 0;
    const padB = parseFloat(el.style.paddingBottom) || 0;
    return Math.max(1, height - padT - padB);
  });
}

/** fixture → 注入脚本 → 挂交互态 → 显式起页化（deferSetup：计量桩先就位，避免测量口径漂移）。
 *  marker=true 时给原题容器加中性标记类 acc-mark（继承点判别用，见用例内注）。 */
function paginateWith(itemClasses: string, marker = false): string {
  const html = fixtureHtml(itemClasses);
  document.body.innerHTML = html.slice(html.indexOf('<body>') + '<body>'.length, html.indexOf('</body>'));
  const injected = injectPreviewScript(html, {
    assetsRoot: null,
    pageWmm: PAGE_W_MM,
    pageHmm: PAGE_H_MM,
    questionIds: ['acc-split'],
    paginate: true,
    interactive: true,
    deferSetup: true,
    optionsLayouts: { 'acc-split': 'two-lines' },
  });
  expect(injected).toContain('"optionsLayouts"');
  stubLayout();
  const script = injected.slice(injected.indexOf('<script>') + '<script>'.length, injected.indexOf('</script>'));
  new Function(script)();

  const item = document.querySelector('.question-item');
  expect(item).not.toBeNull();
  // 父层重建前的交互态（选中+悬停）挂在原题容器上——续片不得继承这些分页/交互标记类。
  // acc-mark 为验收方自加的中性标记类：续片须继承它，以证明类名确系「从原题容器继承」
  // （而非恰巧命中常量类名）——修复前该行写死 'question-item mf-continued' 时本断言必失败。
  item!.classList.add('mf-q-hover', 'mf-q-selected');
  if (marker) item!.classList.add('acc-mark');
  expect(window.__mofangPaginate).toBeDefined();
  window.__mofangPaginate!.setup();
  return item!.className;
}

describe('0013 验收探针 ⑦ 跨页续片继承题容器版式类（§七 修复点）', () => {
  it('ol-two 题跨页：选项所在续片继承 ol-two，且不含 mf-split / mf-q-hover / mf-q-selected', () => {
    const firstClassName = paginateWith('question-item ol-two', true);

    const frags = document.querySelectorAll('.mf-continued');
    expect(frags).toHaveLength(1);
    const frag = frags[0] as HTMLElement;
    // 切分确实把选项组移到续片（否则本用例不能证明继承点）
    expect(frag.querySelector('.options')).not.toBeNull();
    expect(frag.querySelectorAll('.option')).toHaveLength(4);
    // 核心：续片继承题容器版式类（横排/两行 CSS 才能命中续片内选项）+ 中性标记类随行
    expect(frag.classList.contains('ol-two')).toBe(true);
    expect(frag.classList.contains('question-item')).toBe(true);
    expect(frag.classList.contains('acc-mark')).toBe(true);
    expect(frag.className).toBe('question-item ol-two acc-mark mf-continued');
    // 分页/交互标记类不随继承（首片让位标记 + hover/选中态）
    expect(frag.classList.contains('mf-split')).toBe(false);
    expect(frag.classList.contains('mf-q-hover')).toBe(false);
    expect(frag.classList.contains('mf-q-selected')).toBe(false);
    // 题序映射不受影响；首片保留版式类并挂上让位标记
    expect(frag.getAttribute('data-mf-qindex')).toBe('0');
    expect(firstClassName).toContain('ol-two');
    expect(firstClassName).toContain('mf-split');
  });

  it('auto 题跨页（存量卷零回归）：续片类名逐字 = question-item mf-continued', () => {
    paginateWith('question-item');
    const frags = document.querySelectorAll('.mf-continued');
    expect(frags).toHaveLength(1);
    expect((frags[0] as HTMLElement).className).toBe('question-item mf-continued');
    expect(document.querySelectorAll('.question-item')[0].classList.contains('ol-two')).toBe(false);
  });
});
