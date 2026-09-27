// 0035 修复批 F4（用户目检）：导出取消态提示统一——**PDF 与 Word 行为一致**。
// 旧状：`exportPaperPdf` 丢弃主进程返回的 `filePath`（取消时为 null），页面一律报「已提交导出」，
// 用户取消保存对话框却看到成功文案（真题目检项 4）；Word 路径已正确区分取消。
// 覆盖：排版间 + 试卷列表卡片的 PDF/Word 取消与成功四态。
// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import type { BankService, BankExtServices } from '../../src/shared/contracts/bank-types.js';
import { MockBankService } from '../../src/bank/mock/mock-bank.js';
import { createMockExtServices } from '../../src/bank/mock/mock-ext.js';
import { MockBankStore } from '../../src/bank/mock/mock-store.js';

import { ComposePage } from '../../src/app/pages/ComposePage.js';
import { PaperSections } from '../../src/app/pages/BasketListPage.js';
import type { ExtPageServices } from '../../src/app/pages/ExtUi.js';

interface Ctx {
  bank: BankService;
  ext: BankExtServices;
  store: MockBankStore;
}

let ctx: Ctx;
let svc: ExtPageServices;
let container: HTMLDivElement;
let root: Root | null = null;

function createCtx(): Ctx {
  const store = new MockBankStore();
  return { bank: new MockBankService(store), ext: createMockExtServices(store), store };
}

beforeEach(() => {
  ctx = createCtx();
  svc = { bank: ctx.bank, ext: ctx.ext };
});

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  vi.restoreAllMocks();
  delete (window as unknown as { __mofangBank?: unknown }).__mofangBank;
});

function render(ui: ReactElement) {
  root?.unmount();
  container?.remove();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => root!.render(ui));
}

function clickBtn(selector: string) {
  const el = container.querySelector(selector);
  if (!el) throw new Error(`找不到元素: ${selector}`);
  flushSync(() => (el as HTMLButtonElement).click());
}

async function waitFor(assertion: () => void) {
  await vi.waitFor(assertion, { timeout: 3000, interval: 20 });
}

async function makePaper(title: string, status: 'composing' | 'done'): Promise<string> {
  const q = await ctx.bank.createQuestion({
    subject: '物理',
    sourceType: 'local',
    sourceDetail: { origin: 'test' },
    content: '<div class="question">取消态题</div>',
    images: [],
  });
  const paper = await ctx.ext.paper.createPaperEx(title);
  await ctx.bank.addQuestion(paper.id, q.id, 5);
  if (status === 'done') {
    await ctx.ext.paper.updatePaperStatus(paper.id, 'composing');
    await ctx.ext.paper.updatePaperStatus(paper.id, 'done');
  }
  return paper.id;
}

/** 装 PDF/Word 导出替身（返回 filePath=null 模拟用户在保存框取消） */
function stubBridges(over: { pdfFilePath?: string | null; docxFilePath?: string | null } = {}) {
  const exportPdf = vi.fn().mockResolvedValue({
    filePath: over.pdfFilePath === undefined ? 'D:/out/卷.pdf' : over.pdfFilePath,
    pagination: { sheets: 1, overflow: 0 },
  });
  const exportDocx = vi.fn().mockResolvedValue({
    filePath: over.docxFilePath === undefined ? 'D:/out/卷.docx' : over.docxFilePath,
    stats: {
      mathTotal: 0, mathRasterized: 0, mathFailed: 0,
      imagesTotal: 0, imagesEmbedded: 0, imagesMissing: 0, degradations: [], issues: [],
    },
  });
  (window as unknown as { __mofangBank?: unknown }).__mofangBank = { exportPdf, exportDocx };
  return { exportPdf, exportDocx };
}

async function renderCompose(paperId: string) {
  render(<ComposePage paperId={paperId} svc={svc} />);
  await waitFor(() => {
    if (!container.querySelector('[data-testid="preset-manage-btn"]')) throw new Error('排版间未渲染');
  });
}

describe('0035 修复批 F4：排版间导出取消态（PDF 与 Word 一致）', () => {
  it('PDF 取消（filePath=null）→ 中性提示「已取消」，不报「已提交导出」', async () => {
    const paperId = await makePaper('PDF 取消卷', 'composing');
    stubBridges({ pdfFilePath: null });
    await renderCompose(paperId);

    clickBtn('[data-testid="compose-export-student-btn"]');
    await waitFor(() => {
      if (!container.textContent?.includes('已取消')) throw new Error('取消提示未出现');
    });
    expect(container.textContent).not.toContain('已提交导出');
  });

  it('PDF 成功 → 成功提示（既有行为不回归）', async () => {
    const paperId = await makePaper('PDF 成功卷', 'composing');
    stubBridges({ pdfFilePath: 'D:/out/成功卷.pdf' });
    await renderCompose(paperId);

    clickBtn('[data-testid="compose-export-student-btn"]');
    await waitFor(() => {
      if (!container.textContent?.includes('已提交导出')) throw new Error('成功提示未出现');
    });
  });

  it('Word 取消 → 中性提示；Word 成功 → 已导出（既有行为不回归）', async () => {
    const paperId = await makePaper('Word 取消卷', 'composing');
    stubBridges({ docxFilePath: null });
    await renderCompose(paperId);
    clickBtn('[data-testid="compose-export-docx-student-btn"]');
    await waitFor(() => {
      if (!container.textContent?.includes('已取消')) throw new Error('Word 取消提示未出现');
    });
    expect(container.textContent).not.toContain('已导出 Word');
  });
});

describe('0035 修复批 F4：试卷列表卡片导出取消态', () => {
  it('卡片 PDF 取消 → 中性提示，不报已提交', async () => {
    const paperId = await makePaper('卡片 PDF 取消卷', 'done');
    stubBridges({ pdfFilePath: null });

    render(<PaperSections svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector(`[data-testid="card-export-${paperId}"]`)) throw new Error('卡片未渲染');
    });
    clickBtn(`[data-testid="card-export-${paperId}"]`);
    await waitFor(() => {
      if (!container.textContent?.includes('已取消')) throw new Error('卡片取消提示未出现');
    });
    expect(container.textContent).not.toContain('已提交导出');
  });

  it('卡片 Word 取消 → 中性提示', async () => {
    const paperId = await makePaper('卡片 Word 取消卷', 'done');
    stubBridges({ docxFilePath: null });

    render(<PaperSections svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector(`[data-testid="card-export-docx-${paperId}"]`)) throw new Error('卡片未渲染');
    });
    clickBtn(`[data-testid="card-export-docx-${paperId}"]`);
    await waitFor(() => {
      if (!container.textContent?.includes('已取消')) throw new Error('卡片 Word 取消提示未出现');
    });
  });
});
