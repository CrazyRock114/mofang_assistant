// 0013 选项版式：预览交互层（注入运行时）+ 父层消息往返探针。
// ①运行时 DOM 断言：题尾操作条「选项版式」按钮仅出现在含 .options 的题、文案随生效值、
//   点击按 auto→单行→两行→auto 循环回传协议消息；
// ②父层接线：mf-question-options-layout 消息 → persistRefLayout 落 layout_json 第三键
//   （figures/answerSpace 随行保留）→ 防抖重建后预览类名同步。
// @vitest-environment jsdom

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import type { BankService, BankExtServices } from '../../src/shared/contracts/bank-types.js';
import { MockBankService } from '../../src/bank/mock/mock-bank.js';
import { createMockExtServices } from '../../src/bank/mock/mock-ext.js';
import { MockBankStore } from '../../src/bank/mock/mock-store.js';

import { injectPreviewScript } from '../../src/app/pages/preview-frame-script.js';
import { ComposePage } from '../../src/app/pages/ComposePage.js';
import type { ExtPageServices } from '../../src/app/pages/ExtUi.js';

// ==================== ① 运行时 DOM 探针（fixture + 执行注入脚本，照 paginate-dom 模式） ====================

/** 最小卷面：q1 含 2 个选项、q2 阅读题干（无 .options 容器） */
function fixtureHtml(): string {
  return '<div class="paper"><div class="paper-questions">' +
    '<div class="question-item"><div class="question-header"><span class="question-number">1.</span></div>' +
    '<div class="mf-question-body"><div class="question-content">' +
    '<div class="question">题干一<div class="options"><span class="option">A. 甲</span><span class="option">B. 乙</span></div></div>' +
    '</div></div></div>' +
    '<div class="question-item"><div class="question-header"><span class="question-number">2.</span></div>' +
    '<div class="mf-question-body"><div class="question-content"><p>阅读题干（无选项容器）</p></div></div></div>' +
    '</div></div>';
}

/** 注入并执行运行时脚本（interactive 开、paginate 关），返回捕获的选项版式消息收集器 */
function runRuntime(optionsLayouts: Record<string, string>): { posted: Array<{ t: string; questionId?: string; mode?: string }> } {
  const html = `<!DOCTYPE html><html><head><title>0013 运行时探针</title></head><body>${fixtureHtml()}</body></html>`;
  document.body.innerHTML = html.slice(html.indexOf('<body>') + '<body>'.length, html.indexOf('</body>'));
  const posted: Array<{ t: string; questionId?: string; mode?: string }> = [];
  window.addEventListener('message', (ev: MessageEvent) => {
    const data = ev.data as { t?: string; questionId?: string; mode?: string } | null;
    if (data && data.t === 'mf-question-options-layout') posted.push(data);
  });
  const injected = injectPreviewScript(html, {
    assetsRoot: null,
    pageWmm: 210,
    pageHmm: 297,
    questionIds: ['q1', 'q2'],
    paginate: false,
    interactive: true,
    answerSpaces: {},
    textBlocks: {},
    selectedQuestionId: null,
    optionsLayouts,
  });
  const script = injected.slice(injected.indexOf('<script>') + '<script>'.length, injected.indexOf('</script>'));
  // eslint-disable-next-line no-new-func
  new Function(script)();
  return { posted };
}

function barButtonOf(labelPart: string): HTMLButtonElement {
  const bar = document.querySelector('.mf-question-bar');
  if (!bar) throw new Error('题尾操作条未出现');
  const buttons = Array.from(bar.querySelectorAll('button'));
  const hit = buttons.find((b) => (b.textContent ?? '').includes(labelPart));
  if (!hit) throw new Error(`操作条无「${labelPart}」按钮（现有：${buttons.map((b) => b.textContent).join('/')}）`);
  return hit;
}

function clickQuestion(index: number): void {
  const item = document.querySelectorAll('.question-item')[index];
  if (!item) throw new Error(`题块 ${index} 不存在`);
  flushSync(() => {
    item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('0013 运行时：题尾操作条「选项版式」按钮', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('含 .options 的题出按钮且文案=当前生效值；点击循环回传下一档（auto→单行→两行→auto）', async () => {
    // 三态各重建一次点一次 = 完整循环序列 auto→single-line→two-lines→auto
    const cycle: Array<{ current: string; next: string }> = [
      { current: 'auto', next: 'single-line' },
      { current: 'single-line', next: 'two-lines' },
      { current: 'two-lines', next: 'auto' },
    ];
    for (const { current, next } of cycle) {
      const { posted } = runRuntime({ q1: current, q2: current });
      clickQuestion(0);
      const label = { auto: '自动', 'single-line': '单行', 'two-lines': '两行' }[current] ?? current;
      const btn = barButtonOf(`选项版式：${label}`);
      flushSync(() => btn.click());
      // jsdom postMessage 异步派发，等一个宏任务再断言
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(posted).toEqual([{ t: 'mf-question-options-layout', questionId: 'q1', mode: next }]);
    }
  });

  it('无 .options 的题（阅读大题）不出选项版式按钮（其余按钮照常）', () => {
    runRuntime({ q1: 'auto', q2: 'auto' });
    clickQuestion(1);
    const bar = document.querySelector('.mf-question-bar');
    expect(bar).not.toBeNull();
    const texts = Array.from(bar!.querySelectorAll('button')).map((b) => b.textContent ?? '');
    expect(texts.some((t) => t.includes('选项版式'))).toBe(false);
    expect(texts.some((t) => t.includes('分值'))).toBe(true); // 同条其余按钮不受影响
  });
});

// ==================== ② 父层接线（ComposePage 消息往返，照 fix4-question-select 模式） ====================

interface Ctx {
  bank: BankService;
  ext: BankExtServices;
  store: MockBankStore;
}

function createCtx(): Ctx {
  const store = new MockBankStore();
  return { bank: new MockBankService(store), ext: createMockExtServices(store), store };
}

let ctx: Ctx;
let svc: ExtPageServices;

beforeEach(() => {
  ctx = createCtx();
  svc = { bank: ctx.bank, ext: ctx.ext };
});

let container: HTMLDivElement;
let root: Root | null = null;

function render(ui: ReactElement) {
  root?.unmount();
  container?.remove();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => {
    root!.render(ui);
  });
}

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  vi.restoreAllMocks();
  window.location.hash = '';
});

async function waitFor(assertion: () => void) {
  await vi.waitFor(assertion, { timeout: 3000, interval: 20 });
}

function srcdocOf(): string {
  return container.querySelector('[data-testid="compose-preview-iframe"]')?.getAttribute('srcdoc') ?? '';
}

/** 模拟 iframe 注入脚本回传（source 必须等于预览 iframe 的 contentWindow） */
async function postFromFrame(data: object) {
  await new Promise((resolve) => setTimeout(resolve, 400));
  const iframe = container.querySelector('[data-testid="compose-preview-iframe"]') as HTMLIFrameElement;
  const win = iframe?.contentWindow;
  if (!win) throw new Error('预览 iframe contentWindow 不存在');
  const event = new MessageEvent('message', { data });
  Object.defineProperty(event, 'source', { value: win });
  flushSync(() => {
    window.dispatchEvent(event);
  });
}

describe('0013 父层接线：选项版式消息 → layout_json 第三键', () => {
  it('循环切换落库序列 auto→单行→两行→auto：键写对、figures/answerSpace 随行保留、预览类名同步', async () => {
    const q = await ctx.bank.createQuestion({
      subject: '物理',
      sourceType: 'local',
      sourceDetail: { origin: 'test' },
      content:
        '<div class="question">下列说法正确的是？' +
        '<div class="options"><span class="option">A. 甲</span><span class="option">B. 乙</span>' +
        '<span class="option">C. 丙</span><span class="option">D. 丁</span></div></div>',
      images: [],
    });
    const paper = await ctx.ext.paper.createPaperEx('选项版式接线卷');
    await ctx.bank.addQuestion(paper.id, q.id, 5);
    // 预置题级 figures 覆盖 + 作答区覆盖（验证切选项版式时随行保留）
    await ctx.ext.paper.setQuestionLayouts(paper.id, q.id, {
      figures: [{ assetId: 'capture/x.png', orderIndex: 0 }],
      answerSpace: { style: 'lines', lines: 2 },
    });
    await ctx.ext.paper.updatePaperStatus(paper.id, 'composing');
    const paperId = paper.id;
    render(<ComposePage paperId={paperId} svc={svc} />);
    await waitFor(() => {
      if (!srcdocOf().includes('mf-question-bar')) throw new Error('交互层未注入');
    });

    const layoutOf = () => ctx.store.paperQuestions.get(paper.id)![0].layout;

    // auto→单行
    await postFromFrame({ t: 'mf-question-options-layout', questionId: q.id, mode: 'single-line' });
    await waitFor(() => {
      if (layoutOf()?.optionsLayout !== 'single-line') throw new Error('单行档未落库');
    });
    expect(layoutOf()?.figures).toEqual([{ assetId: 'capture/x.png', orderIndex: 0 }]);
    expect(layoutOf()?.answerSpace).toEqual({ style: 'lines', lines: 2 });
    await waitFor(() => {
      if (!srcdocOf().includes('class="question-item ol-single"')) throw new Error('单行档预览未同步');
    });

    // 单行→两行
    await postFromFrame({ t: 'mf-question-options-layout', questionId: q.id, mode: 'two-lines' });
    await waitFor(() => {
      if (layoutOf()?.optionsLayout !== 'two-lines') throw new Error('两行档未落库');
    });
    await waitFor(() => {
      if (!srcdocOf().includes('class="question-item ol-two"')) throw new Error('两行档预览未同步');
    });

    // 两行→auto（显式题级 auto 覆盖落库）
    await postFromFrame({ t: 'mf-question-options-layout', questionId: q.id, mode: 'auto' });
    await waitFor(() => {
      if (layoutOf()?.optionsLayout !== 'auto') throw new Error('自动档未落库');
    });
    expect(layoutOf()?.figures).toEqual([{ assetId: 'capture/x.png', orderIndex: 0 }]);
    await waitFor(() => {
      const doc = srcdocOf();
      // 注意：paper.css 内联进 head 也含 ol-single 字样——断言必须锚定类属性而非裸子串
      if (doc.includes('class="question-item ol-')) throw new Error('自动档预览仍有类名');
      if (!doc.includes('class="question-item"')) throw new Error('预览丢失');
    });
  }, 20000);
});
