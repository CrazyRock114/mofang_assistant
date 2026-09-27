// 0035 P4：DOCX 导出 UI 入口测试（jsdom + Mock(in-memory) 注入单跑，照 compose-layout.test.tsx 模式）。
// 覆盖：
//   ① 排版间（组卷完成页）「导出 Word」学生/教师版按钮 → __mofangBank.exportDocx 真调用；
//      payload 与 PDF 导出同源（questions/layoutConfig/questionLayouts/textBlocks/scores 同输入）；
//   ② 「Word 为重排版式，非所见即所得」提示可见（任务书 P3 用户可见项的程序化锚点）；
//   ③ 试卷列表卡片「导出 Word」入口 → 同通道；
//   ④ 缺口如实回传（公式栅格失败/缺图）→ 提示含缺口计数，不假装完美；用户取消 → 中性提示不报成功；
//   ⑤ 非 Electron 环境（无 __mofangBank）→ 明确错误文案，不静默。
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
import type { ExportDocxPayload } from '../../src/shared/contracts/bridge.js';

// ---------------- 测试世界（Mock in-memory 单跑，注入 svc） ----------------

interface Ctx {
  bank: BankService;
  ext: BankExtServices;
  store: MockBankStore;
}

function createCtx(): Ctx {
  const store = new MockBankStore();
  return {
    bank: new MockBankService(store),
    ext: createMockExtServices(store),
    store,
  };
}

let ctx: Ctx;
let svc: ExtPageServices;

beforeEach(() => {
  ctx = createCtx();
  svc = { bank: ctx.bank, ext: ctx.ext };
});

// ---------------- 渲染/交互辅助 ----------------

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
  delete (window as unknown as { __mofangBank?: unknown }).__mofangBank;
});

function clickBtn(selector: string) {
  const el = container.querySelector(selector);
  if (!el) throw new Error(`找不到元素: ${selector}`);
  flushSync(() => (el as HTMLButtonElement).click());
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

async function makePaperAtStatus(title: string, status: 'basket' | 'composing' | 'done', questionIds: string[] = []): Promise<string> {
  const paper = await ctx.ext.paper.createPaperEx(title);
  for (const qid of questionIds) await ctx.bank.addQuestion(paper.id, qid, 5);
  if (status !== 'basket') await ctx.ext.paper.updatePaperStatus(paper.id, 'composing');
  if (status === 'done') await ctx.ext.paper.updatePaperStatus(paper.id, 'done');
  return paper.id;
}

/** 安装 exportDocx 替身；返回 mock（payload 断言出口） */
function stubExportDocx(result: { filePath: string | null; stats?: unknown } = { filePath: 'D:/out/卷.docx' }) {
  const exportDocx = vi.fn().mockResolvedValue({
    filePath: result.filePath,
    stats: result.stats ?? {
      mathTotal: 2, mathRasterized: 2, mathFailed: 0,
      imagesTotal: 1, imagesEmbedded: 1, imagesMissing: 0,
      degradations: [], issues: [],
    },
  });
  (window as unknown as { __mofangBank?: unknown }).__mofangBank = { exportDocx };
  return exportDocx;
}

/** 排版间渲染就绪（控件区出现） */
async function renderCompose(paperId: string) {
  render(<ComposePage paperId={paperId} svc={svc} />);
  await waitFor(() => {
    if (!container.querySelector('[data-testid="preset-manage-btn"]')) throw new Error('排版间未渲染');
  });
}

// ==================== ① 排版间「导出 Word」入口 ====================

describe('0035 P4：排版间「导出 Word」', () => {
  it('学生版按钮 → exportDocx payload 与渲染同源（mode/questions/layoutConfig/scores/textBlocks/questionLayouts）', async () => {
    const q1 = await makeQuestion('公式题 <span class="math" data-tex="a^2+b^2"></span>');
    const q2 = await makeQuestion('普通题');
    const paperId = await makePaperAtStatus('导出 Word 卷', 'composing', [q1, q2]);
    // 题级覆盖（选项版式单行）+ 文本内容块行（节标题，不占题号）：与渲染层同源输入
    await ctx.ext.paper.setQuestionLayouts(paperId, q2, { optionsLayout: 'single-line' });
    await ctx.bank.addQuestion(paperId, 'text:sec1', undefined, undefined, { text: '二、综合题', style: 'section' });
    const exportDocx = stubExportDocx();

    await renderCompose(paperId);
    clickBtn('[data-testid="compose-export-docx-student-btn"]');
    await waitFor(() => {
      if (exportDocx.mock.calls.length === 0) throw new Error('exportDocx 未被调用');
    });

    const payload = exportDocx.mock.calls[0][0] as ExportDocxPayload;
    expect(payload.mode).toBe('student');
    expect(payload.suggestedName).toContain('学生版');
    expect(payload.suggestedName.endsWith('.docx')).toBe(true);
    // 行序原样透传（含文本块占位题；主进程按 textBlocks 识别）
    expect(payload.questions.map((q) => q.id)).toEqual([q1, q2, 'text:sec1']);
    expect(payload.paper.id).toBe(paperId);
    // 与 PDF 导出的渲染输入同源：版式配置 + 题级覆盖 + 文本块 + 分值数组
    expect(payload.layoutConfig).toBeDefined();
    expect(payload.questionLayouts).toEqual({ [q2]: { optionsLayout: 'single-line' } });
    expect(payload.textBlocks?.['text:sec1']).toEqual({ id: 'text:sec1', text: '二、综合题', style: 'section' });
    // 分值数组按题行序（文本块不占位）
    expect(payload.scores).toEqual([5, 5]);
  });

  it('教师版按钮 → mode=teacher，题面含答案（教师版语义）', async () => {
    const q1 = await makeQuestion('带解析题');
    const paperId = await makePaperAtStatus('教师版卷', 'composing', [q1]);
    const exportDocx = stubExportDocx();

    await renderCompose(paperId);
    clickBtn('[data-testid="compose-export-docx-teacher-btn"]');
    await waitFor(() => {
      if (exportDocx.mock.calls.length === 0) throw new Error('exportDocx 未被调用');
    });
    const payload = exportDocx.mock.calls[0][0] as ExportDocxPayload;
    expect(payload.mode).toBe('teacher');
    expect(payload.suggestedName).toContain('教师版');
  });

  it('导出成功 → 成功提示含文件名；「重排版式非所见即所得」提示随 0063 返工⑤迁 Word 项感叹号 title', async () => {
    const q1 = await makeQuestion('提示题');
    const paperId = await makePaperAtStatus('提示卷', 'composing', [q1]);
    stubExportDocx({ filePath: 'D:/out/提示卷-学生版.docx' });

    await renderCompose(paperId);
    // 0063 返工⑤（用户拍板 2026-09-24）：常驻说明行退役——「重排版式非所见即所得」提示
    // 迁到导出菜单两个 Word 项的感叹号（.compose-menu-item-warn）+ 按钮 title（hover 原生提示）；
    // 导出前即在场（title 恒挂），语义等强适配
    const docxStudentBtn = container.querySelector('[data-testid="compose-export-docx-student-btn"]') as HTMLElement;
    expect(docxStudentBtn.getAttribute('title')).toContain('重排版式');
    expect(docxStudentBtn.getAttribute('title')).toContain('非所见即所得');
    expect(docxStudentBtn.querySelector('.compose-menu-item-warn')).not.toBeNull();

    clickBtn('[data-testid="compose-export-docx-student-btn"]');
    await waitFor(() => {
      if (!container.textContent?.includes('已导出 Word')) throw new Error('成功提示未出现');
    });
    expect(container.textContent).toContain('提示卷-学生版.docx');
  });
});

// ==================== ② 缺口如实回传 ====================

describe('0035 P4：导出缺口如实呈现（不假装完美）', () => {
  it('公式栅格失败 + 缺图 → 提示含缺口计数（warn 语义）', async () => {
    const q1 = await makeQuestion('缺口题');
    const paperId = await makePaperAtStatus('缺口卷', 'composing', [q1]);
    stubExportDocx({
      filePath: 'D:/out/缺口卷.docx',
      stats: {
        mathTotal: 3, mathRasterized: 2, mathFailed: 1,
        imagesTotal: 2, imagesEmbedded: 1, imagesMissing: 1,
        degradations: [{ tag: 'table', count: 1 }], issues: ['math-raster: tex 非法'],
      },
    });

    await renderCompose(paperId);
    clickBtn('[data-testid="compose-export-docx-student-btn"]');
    await waitFor(() => {
      if (!container.textContent?.includes('公式')) throw new Error('缺口提示未出现');
    });
    const banner = container.querySelector('[data-testid="page-message"]');
    expect(banner?.textContent).toContain('1');
    expect(container.textContent).toContain('缺图');
    expect(container.textContent).toContain('降级');
  });

  it('用户取消保存对话框（filePath=null）→ 中性提示，不报成功', async () => {
    const q1 = await makeQuestion('取消题');
    const paperId = await makePaperAtStatus('取消卷', 'composing', [q1]);
    stubExportDocx({ filePath: null });

    await renderCompose(paperId);
    clickBtn('[data-testid="compose-export-docx-student-btn"]');
    await waitFor(() => {
      if (!container.textContent?.includes('取消')) throw new Error('取消提示未出现');
    });
    expect(container.textContent).not.toContain('已导出 Word');
  });

  it('非 Electron 环境（无 __mofangBank）→ 明确错误文案，不静默', async () => {
    const q1 = await makeQuestion('无桥题');
    const paperId = await makePaperAtStatus('无桥卷', 'composing', [q1]);
    // 不安装替身：window.__mofangBank 不存在
    await renderCompose(paperId);
    clickBtn('[data-testid="compose-export-docx-student-btn"]');
    await waitFor(() => {
      if (!container.textContent?.includes('Electron')) throw new Error('环境错误提示未出现');
    });
  });
});

// ==================== ③ 试卷列表卡片入口 ====================

describe('0035 P4：试卷列表卡片「导出 Word」', () => {
  it('已定稿卷卡片按钮 → exportDocx 通道（快照装载 + 版式同源）', async () => {
    const q1 = await makeQuestion('列表导出题');
    const paperId = await makePaperAtStatus('列表导出卷', 'done', [q1]);
    const exportDocx = stubExportDocx();

    render(<PaperSections svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector(`[data-testid="card-export-docx-${paperId}"]`)) throw new Error('卡片导出按钮未渲染');
    });
    clickBtn(`[data-testid="card-export-docx-${paperId}"]`);
    await waitFor(() => {
      if (exportDocx.mock.calls.length === 0) throw new Error('exportDocx 未被调用');
    });
    const payload = exportDocx.mock.calls[0][0] as ExportDocxPayload;
    expect(payload.paper.id).toBe(paperId);
    expect(payload.questions.map((q) => q.id)).toEqual([q1]);
    expect(payload.suggestedName.endsWith('.docx')).toBe(true);
  });
});
