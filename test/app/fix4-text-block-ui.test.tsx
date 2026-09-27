// 0004-fix-4 2.3：排版间「插入大标题」（文本内容块）UI 探针。
// 探针面：插入 → 列表出现文本块行（无题号/分值/作答区控件）→ 预览 srcdoc 渲染 .mf-text-item
// → 编辑更新 → 移除；文本块不占题号（预览题号仍为 1.）。
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

function setInput(selector: string, value: string) {
  const el = container.querySelector(selector);
  if (!el) throw new Error(`找不到输入框: ${selector}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  flushSync(() => {
    setter.call(el, value);
    (el as HTMLInputElement).dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function srcdocOf(selector = '[data-testid="compose-preview-iframe"]'): string {
  return container.querySelector(selector)?.getAttribute('srcdoc') ?? '';
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

describe('fix-4 2.3：插入大标题（文本内容块）', () => {
  it('插入 → 列表文本块行 + 预览渲染 .mf-text-item（不占题号）→ 编辑 → 移除', async () => {
    const q1 = await makeQuestion('大标题后第一题');
    const paperId = await makePaper('大标题卷', [q1]);
    render(<ComposePage paperId={paperId} svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="compose-insert-text-block-btn"]')) throw new Error('插入按钮未渲染');
    });

    // 插入大标题
    clickBtn('[data-testid="compose-insert-text-block-btn"]');
    await waitFor(() => {
      if (!container.querySelector('[data-testid="text-block-input"]')) throw new Error('大标题弹层未出现');
    });
    setInput('[data-testid="text-block-input"]', '一、单项选择题');
    clickBtn('[data-testid="text-block-save"]');

    await waitFor(() => {
      const rows = ctx.store.paperQuestions.get(paperId) ?? [];
      if (!rows.some((r) => r.kind === 'text' && r.textBody === '一、单项选择题')) throw new Error('文本块未落库');
    });
    const rows = ctx.store.paperQuestions.get(paperId) ?? [];
    const textRow = rows.find((r) => r.kind === 'text')!;
    expect(textRow.style).toBe('section');

    // 列表：文本块行（无分值/图片/作答区控件）
    await waitFor(() => {
      if (!container.querySelector(`[data-testid="text-block-row-${textRow.questionId}"]`)) throw new Error('文本块行未渲染');
    });
    const row = container.querySelector(`[data-testid="text-block-row-${textRow.questionId}"]`)!;
    expect(row.textContent).toContain('一、单项选择题');
    expect(container.querySelector(`[data-testid="score-btn-${textRow.questionId}"]`)).toBeNull();
    expect(container.querySelector(`[data-testid="figure-settings-btn-${textRow.questionId}"]`)).toBeNull();
    expect(container.querySelector(`[data-testid="answer-space-style-${textRow.questionId}"]`)).toBeNull();

    // 预览：引擎渲染 .mf-text-item + 题号仍为 1.（文本块不占题号）
    await waitFor(() => {
      const doc = srcdocOf();
      if (!doc.includes('mf-text-item--section')) throw new Error('预览未渲染文本块');
    });
    const doc = srcdocOf();
    expect(doc).toContain('一、单项选择题');
    expect(doc).toContain('class="question-number">1.');

    // 编辑
    clickBtn(`[data-testid="text-block-edit-${textRow.questionId}"]`);
    await waitFor(() => {
      const input = container.querySelector('[data-testid="text-block-input"]') as HTMLInputElement | null;
      if (!input || input.value !== '一、单项选择题') throw new Error('编辑弹层未回填');
    });
    setInput('[data-testid="text-block-input"]', '二、多项选择题');
    clickBtn('[data-testid="text-block-save"]');
    await waitFor(() => {
      const updated = (ctx.store.paperQuestions.get(paperId) ?? []).find((r) => r.kind === 'text');
      if (updated?.textBody !== '二、多项选择题') throw new Error('文本块未更新');
    });

    // 移除
    clickBtn(`[data-testid="text-block-remove-${textRow.questionId}"]`);
    await waitFor(() => {
      const left = ctx.store.paperQuestions.get(paperId) ?? [];
      if (left.some((r) => r.kind === 'text')) throw new Error('文本块未移除');
    });
  });
});
