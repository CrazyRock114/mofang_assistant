// 0004-fix-4 2.5（目检 4a）：右栏题级点选交互——协议 + 父层 reducer/接线探针。
// 交互机制全在注入脚本层（hover 虚线框 / 点选实线框 / 题尾操作条），父层只消费 postMessage；
// 本探针锚定：①协议白名单收窄 ②父层动作（增加答题区 3 行 / 插入大标题插到该题前）③注入产物含脚本层机制。
// @vitest-environment jsdom

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import type { BankService, BankExtServices } from '../../src/shared/contracts/bank-types.js';
import { MockBankService } from '../../src/bank/mock/mock-bank.js';
import { createMockExtServices } from '../../src/bank/mock/mock-ext.js';
import { MockBankStore } from '../../src/bank/mock/mock-store.js';

import { parsePreviewMessage } from '../../src/app/pages/preview-frame-protocol.js';
import { ComposePage } from '../../src/app/pages/ComposePage.js';
import type { ExtPageServices } from '../../src/app/pages/ExtUi.js';

describe('fix-4 2.5 协议：题级操作条消息', () => {
  it('parse：合法消息收窄成功；坏结构/伪造一律 null', () => {
    expect(parsePreviewMessage({ t: 'mf-question-answer-space', questionId: 'q1', lines: 3 }))
      .toEqual({ t: 'mf-question-answer-space', questionId: 'q1', lines: 3 });
    expect(parsePreviewMessage({ t: 'mf-question-insert-text', questionId: 'q1' }))
      .toEqual({ t: 'mf-question-insert-text', questionId: 'q1' });
    expect(parsePreviewMessage({ t: 'mf-question-answer-space', questionId: 'q1', lines: '3' })).toBeNull();
    expect(parsePreviewMessage({ t: 'mf-question-answer-space', questionId: 1, lines: 3 })).toBeNull();
    expect(parsePreviewMessage({ t: 'mf-question-insert-text' })).toBeNull();
    expect(parsePreviewMessage({ t: 'mf-question-insert-text', questionId: null })).toBeNull();
  });
});

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

/** 模拟 iframe 注入脚本回传（source 必须等于预览 iframe 的 contentWindow，否则被过滤）。
 * 注意：预览 srcdoc 防抖重建后需等一帧让 PaperPreviewFrame 的消息监听就绪并取最新 iframe 节点。 */
async function postFromFrame(data: object) {
  await new Promise((resolve) => setTimeout(resolve, 400));
  const iframe = container.querySelector('[data-testid="compose-preview-iframe"]') as HTMLIFrameElement;
  const win = iframe?.contentWindow;
  if (!win) throw new Error('预览 iframe contentWindow 不存在');
  const event = new MessageEvent('message', { data });
  // jsdom 的 MessageEvent 构造不保留 source（只读属性）——按协议语义显式定义
  Object.defineProperty(event, 'source', { value: win });
  flushSync(() => {
    window.dispatchEvent(event);
  });
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

describe('fix-4 2.5 右栏点选交互接线', () => {
  it('注入产物含脚本层机制（hover/选中框/操作条/消息名）', async () => {
    const q1 = await makeQuestion('点选题');
    const paperId = await makePaper('点选卷', [q1]);
    render(<ComposePage paperId={paperId} svc={svc} />);
    await waitFor(() => {
      if (!srcdocOf().includes('mf-question-bar')) throw new Error('交互层未注入');
    });
    const doc = srcdocOf();
    expect(doc).toContain('enhanceQuestionSelect');
    expect(doc).toContain('.mf-q-hover');
    expect(doc).toContain('.mf-q-selected');
    expect(doc).toContain('mf-question-answer-space');
    expect(doc).toContain('mf-question-insert-text');
    expect(doc).toContain('Escape');
  });

  it('「增加答题区」消息 → 该题落 3 行空白作答区覆盖', async () => {
    const q1 = await makeQuestion('加答题区题');
    const paperId = await makePaper('加答题区卷', [q1]);
    render(<ComposePage paperId={paperId} svc={svc} />);
    await waitFor(() => {
      if (!srcdocOf().includes('mf-question-answer-space')) throw new Error('交互层未注入');
    });

    await postFromFrame({ t: 'mf-question-answer-space', questionId: q1, lines: 3 });
    await waitFor(() => {
      const layout = ctx.store.paperQuestions.get(paperId)![0].layout;
      if (layout?.answerSpace?.style !== 'blank' || layout?.answerSpace?.lines !== 3) {
        throw new Error('答题区覆盖未落库');
      }
    });
    // 预览重建后出现 3 行高度（3 × 7.62mm = 22.86mm）
    await waitFor(() => {
      if (!srcdocOf().includes('height: 22.86mm')) throw new Error('预览未反映 3 行作答区');
    });
  });

  it('「插入大标题」消息 → 打开大标题弹层且插入位=该题前（保存后行序正确）', async () => {
    const q1 = await makeQuestion('题一');
    const q2 = await makeQuestion('题二');
    const paperId = await makePaper('插入大标题卷', [q1, q2]);
    render(<ComposePage paperId={paperId} svc={svc} />);
    await waitFor(() => {
      if (!srcdocOf().includes('mf-question-insert-text')) throw new Error('交互层未注入');
    });

    await postFromFrame({ t: 'mf-question-insert-text', questionId: q2 });
    await waitFor(() => {
      if (!container.querySelector('[data-testid="text-block-input"]')) throw new Error('大标题弹层未打开');
    });
    const input = container.querySelector('[data-testid="text-block-input"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    flushSync(() => {
      setter.call(input, '二、多项选择题');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const saveBtn = container.querySelector('[data-testid="text-block-save"]') as HTMLButtonElement;
    flushSync(() => saveBtn.click());

    await waitFor(() => {
      const rows = ctx.store.paperQuestions.get(paperId) ?? [];
      if (rows.length !== 3) throw new Error('文本块未插入');
      if (rows[1].kind !== 'text' || rows[1].textBody !== '二、多项选择题') throw new Error('插入位不对');
    });
    const rows = ctx.store.paperQuestions.get(paperId)!;
    expect(rows.map((r) => r.questionId)).toEqual([q1, rows[1].questionId, q2]);
  });
});
