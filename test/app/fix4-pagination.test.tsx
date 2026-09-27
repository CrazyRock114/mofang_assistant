// 0004-fix-4 2.1：分页预览接线（排版间右栏）。
// 探针面：①视图切换按钮（分页视图/连续视图，默认分页）②注入产物携带页化配置（paginate/columns/列间距）
// ③页化脚本段已注入（mf-sheets/mf-sheet/data-mf-sheets 标记 + 差异标注文案）。
// 真实页化渲染（sheet 数/块分布）由 Electron 实机探针覆盖（jsdom 无布局引擎）。
// @vitest-environment jsdom

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import type { BankService, BankExtServices } from '../../src/shared/contracts/bank-types.js';
import { MockBankService } from '../../src/bank/mock/mock-bank.js';
import { createMockExtServices } from '../../src/bank/mock/mock-ext.js';
import { MockBankStore } from '../../src/bank/mock/mock-store.js';

import { ComposePage } from '../../src/app/pages/ComposePage.js';
import type { ExtPageServices } from '../../src/app/pages/ExtUi.js';

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

function clickBtn(selector: string) {
  const el = container.querySelector(selector);
  if (!el) throw new Error(`找不到元素: ${selector}`);
  flushSync(() => (el as HTMLButtonElement).click());
}

function srcdocOf(selector = '[data-testid="compose-preview-iframe"]'): string {
  const el = container.querySelector(selector);
  return el?.getAttribute('srcdoc') ?? '';
}

async function waitFor(assertion: () => void) {
  await vi.waitFor(assertion, { timeout: 3000, interval: 20 });
}

async function makeQuestion(stem: string): Promise<string> {
  const q = await ctx.bank.createQuestion({
    subject: '物理',
    sourceType: 'local',
    sourceDetail: { origin: 'test' },
    content: `<div class="question">${stem}</div>`,
    images: [],
  });
  return q.id;
}

async function makePaper(title: string, questionIds: string[]): Promise<string> {
  const paper = await ctx.ext.paper.createPaperEx(title);
  for (const qid of questionIds) await ctx.bank.addQuestion(paper.id, qid, 5);
  await ctx.ext.paper.updatePaperStatus(paper.id, 'composing');
  return paper.id;
}

describe('fix-4 2.1：分页预览接线（默认分页视图 + 视图切换）', () => {
  it('默认分页视图：注入产物含页化脚本段 + paginate 配置 + 差异标注', async () => {
    const q1 = await makeQuestion('分页题一');
    const q2 = await makeQuestion('分页题二');
    const paperId = await makePaper('分页预览卷', [q1, q2]);
    render(<ComposePage paperId={paperId} svc={svc} />);

    await waitFor(() => {
      const doc = srcdocOf();
      if (!doc.includes('"paginate":true')) throw new Error('页化配置未注入');
    });
    const doc = srcdocOf();
    // 页化脚本段（块级装箱 + 纸流容器）
    expect(doc).toContain('function paginateDocument');
    expect(doc).toContain('mf-sheets');
    expect(doc).toContain('mf-sheet');
    expect(doc).toContain('data-mf-sheets');
    // 0007 P1/P5：内联 planPageGroups 已删除，装箱单源 = paginate.planFlow（段级装箱，esbuild 打包进注入运行时）
    expect(doc).toContain('planFlow');
    // 差异标注（诚实 UI；0007 P2 起分页=导出 PDF 实际分页，语义同步更新）
    expect(doc).toContain('分页视图 = 导出 PDF 实际分页');
    // 页规格/栏数参与装箱
    expect(doc).toContain('"columns":1');
    expect(doc).toContain('"pageHmm":297');
    // 视图切换按钮在（默认分页态）
    expect(container.querySelector('[data-testid="preview-view-paged"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="preview-view-continuous"]')).not.toBeNull();
  });

  it('切连续视图 → 重新注入（paginate:false）；再切回分页 → paginate:true', async () => {
    const q1 = await makeQuestion('切换题');
    const paperId = await makePaper('视图切换卷', [q1]);
    render(<ComposePage paperId={paperId} svc={svc} />);
    await waitFor(() => {
      if (!srcdocOf().includes('"paginate":true')) throw new Error('初始未分页');
    });

    clickBtn('[data-testid="preview-view-continuous"]');
    await waitFor(() => {
      if (!srcdocOf().includes('"paginate":false')) throw new Error('未切到连续视图');
    });

    clickBtn('[data-testid="preview-view-paged"]');
    await waitFor(() => {
      if (!srcdocOf().includes('"paginate":true')) throw new Error('未切回分页视图');
    });
  });

  it('A3 双列：栏数与列间距参与页化（columns:2）', async () => {
    const q1 = await makeQuestion('双列分页题');
    const paperId = await makePaper('双列分页卷', [q1]);
    render(<ComposePage paperId={paperId} svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="layout-columns"]')) throw new Error('版式控件未渲染');
    });
    const select = container.querySelector('[data-testid="layout-columns"]') as HTMLSelectElement;
    flushSync(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
      setter.call(select, '2');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await waitFor(() => {
      const doc = srcdocOf();
      if (!doc.includes('"columns":2')) throw new Error('栏数未注入页化配置');
    });
    expect(srcdocOf()).toContain('"columnGapMm":8');
  });
});
