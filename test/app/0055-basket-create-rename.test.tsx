// 0055（R-063，吸收 R-048）：全域「加入试题篮」入口可新建 + 可重命名。
// 本单补两个入口：题库页批量加篮弹层（BankBrowser）+ 采集页加篮区（CapturePage）——
// 录题台 CardFlow / 错题本 MistakesPage 的「新建」口本单不动（已在 0053/0026 落地）。
// 口径（任务书 §一.2）：0 篮早退放宽为「弹层照开、列表为空、新建行为唯一入口」；
// 弹层内「＋ 新建试题篮」= 行内输入 + 确定即建并选中（弹层不关）；每张篮卡可行内重命名（复用 updatePaperTitle 既有全链）；
// 采集页目标下拉恒渲染（恰 1 张篮也在）+「＋ 新建试题篮…」选项，任何态都有新建口。
// @vitest-environment jsdom

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import type { BankExtServices, BankService, Question } from '../../src/shared/contracts/bank-types.js';
import { MockBankService } from '../../src/bank/mock/mock-bank.js';
import { createMockExtServices } from '../../src/bank/mock/mock-ext.js';
import { MockBankStore } from '../../src/bank/mock/mock-store.js';
import { BankBrowser } from '../../src/app/components/BankBrowser.js';
import { CapturePage } from '../../src/app/pages/CapturePage.js';
import { CaptureClient } from '../../src/app/services/capture-client.js';
import type { ExtPageServices } from '../../src/app/pages/ExtUi.js';

interface Ctx {
  bank: BankService;
  ext: BankExtServices;
  store: MockBankStore;
  svc: ExtPageServices;
}

let ctx: Ctx;

beforeEach(() => {
  const store = new MockBankStore();
  const bank = new MockBankService(store, false);
  const ext = createMockExtServices(store);
  ctx = { bank, ext, store, svc: { bank, ext } };
});

let container: HTMLDivElement;
let root: Root | null = null;

function render(ui: ReactElement) {
  root?.unmount();
  container?.remove();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => { root!.render(ui); });
}

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  delete window.__mofangPaths;
  window.location.hash = '';
  vi.restoreAllMocks();
});

function q<T extends HTMLElement>(testid: string): T | null {
  return container.querySelector(`[data-testid="${testid}"]`) as T | null;
}

function click(testid: string) {
  const el = q<HTMLButtonElement>(testid);
  if (!el) throw new Error(`找不到元素: ${testid}`);
  flushSync(() => el.click());
}

function check(testid: string) {
  const el = q<HTMLInputElement>(testid);
  if (!el) throw new Error(`找不到勾选框: ${testid}`);
  flushSync(() => el.click());
}

function setInput(testid: string, value: string) {
  const el = q<HTMLInputElement>(testid);
  if (!el) throw new Error(`找不到输入框: ${testid}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  flushSync(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function setSelect(testid: string, value: string) {
  const el = q<HTMLSelectElement>(testid);
  if (!el) throw new Error(`找不到下拉: ${testid}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  flushSync(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function waitFor(assertion: () => void) {
  await vi.waitFor(assertion, { timeout: 3000, interval: 20 });
}

async function makeQuestion(): Promise<Question> {
  return ctx.bank.createQuestion({
    subject: '物理',
    sourceType: 'local',
    sourceDetail: { origin: 'test' },
    content: '<div class="question">加篮用例题干</div>',
    images: [],
  });
}

/** 弹层内已选中的篮 id（radio 选中项） */
function pickedBasketId(): string | null {
  const el = container.querySelector('input[name="bank-basket-pick"]:checked') as HTMLInputElement | null;
  return el?.value ?? null;
}

describe('0055 R-063 题库页批量加篮弹层：0 篮态 / 新建 / 重命名', () => {
  it('0 篮态：弹层照开（列表为空 + 新建行=唯一入口）；直接确认则提示「请先新建试题篮」', async () => {
    const question = await makeQuestion();
    render(<BankBrowser svc={ctx.svc} />);
    await waitFor(() => expect(q(`bank-select-${question.id}`)).not.toBeNull());
    check(`bank-select-${question.id}`);
    click('bank-batch-add-basket-btn');

    await waitFor(() => { if (!q('bank-batch-basket-modal')) throw new Error('0 篮态弹层未照开'); });
    expect(q('bank-batch-basket-empty')).not.toBeNull();
    expect(container.querySelectorAll('input[name="bank-basket-pick"]').length).toBe(0);
    expect(q('bank-batch-basket-new-name')).not.toBeNull();
    // 0055 目检①：「＋ 新建试题篮」行在列表**顶部**（先能建再谈选）
    const list = container.querySelector('.basket-pick-list')!;
    expect(list.firstElementChild!.getAttribute('data-testid')).toBe('bank-batch-basket-new-row');

    // 未建篮直接确认：不静默——提示仍可见且不进任何篮
    click('bank-batch-basket-confirm');
    await waitFor(() => {
      expect(q('page-message')!.textContent).toBe('请先新建试题篮');
    });
  });

  it('新建行：行内输入 → 确定即建并选中（弹层不关）；再确认 → 题进新篮', async () => {
    const question = await makeQuestion();
    const createSpy = vi.spyOn(ctx.bank, 'createPaper');
    render(<BankBrowser svc={ctx.svc} />);
    await waitFor(() => expect(q(`bank-select-${question.id}`)).not.toBeNull());
    check(`bank-select-${question.id}`);
    click('bank-batch-add-basket-btn');
    await waitFor(() => { if (!q('bank-batch-basket-modal')) throw new Error('选篮弹层未出现'); });

    setInput('bank-batch-basket-new-name', '现场新建篮');
    click('bank-batch-basket-new-confirm');

    await waitFor(() => {
      const created = createSpy.mock.results[0]?.value as Promise<unknown> | undefined;
      expect(created).toBeDefined();
    });
    const created = await (createSpy.mock.results[0]!.value as Promise<{ id: string; title: string; status: string }>);
    expect(created.title).toBe('现场新建篮');
    expect(created.status).toBe('basket');

    // 建后即选中 + 弹层不关 + 新篮进列表（题数 0）
    await waitFor(() => {
      if (!q('bank-batch-basket-modal')) throw new Error('弹层被关掉了（应保持打开）');
      expect(pickedBasketId()).toBe(created.id);
    });
    expect(q('bank-batch-basket-modal')!.textContent).toContain('现场新建篮');
    expect(q(`bank-basket-option-${created.id}`)).not.toBeNull();
    // 输入框已清空（可连续新建）
    expect(q<HTMLInputElement>('bank-batch-basket-new-name')!.value).toBe('');

    click('bank-batch-basket-confirm');
    await waitFor(() => {
      expect(q('page-message')!.textContent).toBe('已加入试题篮「现场新建篮」：成功 1 题');
    });
    expect((await ctx.bank.getPaperQuestions(created.id)).map((r) => r.questionId)).toEqual([question.id]);
  });

  it('重命名：每张篮卡行内改名走 updatePaperTitle 全链，卡片标题即时更新', async () => {
    const question = await makeQuestion();
    const paper = await ctx.bank.createPaper('旧篮名');
    const renameSpy = vi.spyOn(ctx.ext.paper, 'updatePaperTitle');
    render(<BankBrowser svc={ctx.svc} />);
    await waitFor(() => expect(q(`bank-select-${question.id}`)).not.toBeNull());
    check(`bank-select-${question.id}`);
    click('bank-batch-add-basket-btn');
    await waitFor(() => { if (!q(`bank-basket-option-${paper.id}`)) throw new Error('选篮弹层未出现'); });
    // 0055 目检①：已有篮时新建行仍在列表顶部（不随列表滚到底部）
    expect(container.querySelector('.basket-pick-list')!.firstElementChild!.getAttribute('data-testid'))
      .toBe('bank-batch-basket-new-row');

    click(`bank-basket-rename-${paper.id}`);
    setInput(`bank-basket-rename-input-${paper.id}`, '新篮名');
    click(`bank-basket-rename-save-${paper.id}`);

    await waitFor(() => { expect(renameSpy).toHaveBeenCalledTimes(1); });
    expect(renameSpy).toHaveBeenCalledWith(paper.id, '新篮名');
    await waitFor(() => {
      expect(q(`bank-basket-option-${paper.id}`)!.textContent).toContain('新篮名');
    });
    // 落库（真实数据面）
    expect((await ctx.ext.paper.getPaperEx(paper.id))!.title).toBe('新篮名');
  });
});

describe('0055 R-063 采集页加篮区：下拉恒渲染 + 新建项', () => {
  function openPanel() {
    const b = q<HTMLButtonElement>('capture-tab-panel');
    if (!b) throw new Error('找不到「采集界面」标签');
    if (!b.className.includes('btn-primary')) flushSync(() => b.click());
  }

  it('恰 1 张处理中卷：目标下拉恒渲染（现状无下拉）+ 末项「＋ 新建试题篮…」；选中即弹行内输入', async () => {
    const paper = await ctx.bank.createPaper('唯一篮');
    render(<CapturePage capture={new CaptureClient()} pollIntervalMs={1000} svc={ctx.svc} />);
    openPanel();

    await waitFor(() => {
      if (!q('capture-basket-target-select')) throw new Error('恰 1 张篮时下拉未渲染');
    });
    const sel = q<HTMLSelectElement>('capture-basket-target-select')!;
    expect([...sel.options].map((o) => o.text)).toEqual(['唯一篮', '＋ 新建试题篮…']);
    expect(sel.value).toBe(paper.id);

    setSelect('capture-basket-target-select', '__new__');
    await waitFor(() => { if (!q('capture-basket-new-name')) throw new Error('新建输入未出现'); });
    setInput('capture-basket-new-name', '采集现场新建篮');
    click('capture-basket-new-confirm');

    const created = (await ctx.bank.listPapers()).find((p) => p.paper.title === '采集现场新建篮')!.paper;
    await waitFor(() => {
      expect(q<HTMLSelectElement>('capture-basket-target-select')!.value).toBe(created.id);
      expect(q<HTMLInputElement>('capture-add-basket-checkbox')!.checked).toBe(true);
    });
    // 建后即为 target：提示条指向新篮（勾选定语不变）
    await waitFor(() => {
      expect(q('capture-target-banner')!.textContent).toContain('采集现场新建篮');
    });
  });

  it('0 张处理中卷：仍留新建口（现状无任何加篮控件）；建后即勾选为入库目标', async () => {
    render(<CapturePage capture={new CaptureClient()} pollIntervalMs={1000} svc={ctx.svc} />);
    openPanel();

    await waitFor(() => {
      if (!q('capture-new-basket-btn')) throw new Error('0 篮态无新建口');
    });
    // 0 张：勾选框语义不变（不渲染）
    expect(q('capture-add-basket-checkbox')).toBeNull();

    click('capture-new-basket-btn');
    await waitFor(() => { if (!q('capture-basket-new-name')) throw new Error('新建输入未出现'); });
    setInput('capture-basket-new-name', '零篮态新建篮');
    click('capture-basket-new-confirm');

    await waitFor(() => {
      expect(q<HTMLInputElement>('capture-add-basket-checkbox')!.checked).toBe(true);
      expect(q('capture-target-banner')!.textContent).toContain('零篮态新建篮');
    });
    expect(q<HTMLSelectElement>('capture-basket-target-select')).not.toBeNull();
  });
});
