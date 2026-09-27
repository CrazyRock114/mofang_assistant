// 0004-fix-5 P0-2/P1-1/P1-3 接线探针：协议扩展 + ComposePage 接线（锚点落库/分值入口/操作条三态/CFG 注入）
// + IpcBankClient.addQuestion 5 参直通（P1-2 真机路径断点）。
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
import { parsePreviewMessage } from '../../src/app/pages/preview-frame-protocol.js';
import { IpcBankClient } from '../../src/app/services/IpcBankClient.js';
import type { ExtPageServices } from '../../src/app/pages/ExtUi.js';

interface Ctx { bank: BankService; ext: BankExtServices; store: MockBankStore }
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
  flushSync(() => root!.render(ui));
}
afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  vi.restoreAllMocks();
  delete (window as unknown as { __mofangBank?: unknown }).__mofangBank;
});

function srcdocOf(): string {
  return container.querySelector('[data-testid="compose-preview-iframe"]')?.getAttribute('srcdoc') ?? '';
}
async function waitFor(assertion: () => void) {
  await vi.waitFor(assertion, { timeout: 3000, interval: 20 });
}
async function postFromFrame(data: object) {
  await new Promise((resolve) => setTimeout(resolve, 400));
  const iframe = container.querySelector('[data-testid="compose-preview-iframe"]') as HTMLIFrameElement;
  const win = iframe?.contentWindow;
  if (!win) throw new Error('预览 iframe contentWindow 不存在');
  const event = new MessageEvent('message', { data });
  Object.defineProperty(event, 'source', { value: win });
  flushSync(() => window.dispatchEvent(event));
}

/** 预览 iframe 就绪（srcdoc 含段边界标记）后再投递——防抖重建未完成时投递会被丢弃 */
async function waitPreviewReady() {
  await waitFor(() => {
    if (!srcdocOf().includes('mf-seg')) throw new Error('预览未就绪');
  });
}

/** 投递到「断言成立」为止（jsdom + React 时序下首次投递偶发丢失；最多 3 次） */
async function postUntil(data: object, predicate: () => boolean) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await waitPreviewReady();
    await postFromFrame(data);
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (predicate()) return;
  }
}

async function makeFigureQuestion(stem: string, assetId = 'capture/a.png'): Promise<string> {
  const q = await ctx.bank.createQuestion({
    subject: '物理',
    sourceType: 'local',
    sourceDetail: { origin: 'test' },
    content: `<div class="question">${stem}<figure data-w="300"><img src="data-assets/${assetId}"></figure><div class="options"><div class="option">A. 甲</div></div></div>`,
    images: [{ assetId, type: 'figure', width: 300 }],
  });
  return q.id;
}
async function makePaper(title: string, questionIds: string[]): Promise<string> {
  const paper = await ctx.ext.paper.createPaperEx(title);
  for (const qid of questionIds) await ctx.bank.addQuestion(paper.id, qid, 5);
  await ctx.ext.paper.updatePaperStatus(paper.id, 'composing');
  return paper.id;
}

describe('fix-5 协议扩展（parse 白名单收窄）', () => {
  it('mf-figure-move 带 anchorIndex：合法收窄 / 非法拒收', () => {
    expect(parsePreviewMessage({ t: 'mf-figure-move', questionId: 'q1', assetId: 'a', beforeAssetId: null, anchorIndex: 2 }))
      .toEqual({ t: 'mf-figure-move', questionId: 'q1', assetId: 'a', beforeAssetId: null, anchorIndex: 2 });
    expect(parsePreviewMessage({ t: 'mf-figure-move', questionId: 'q1', assetId: 'a', beforeAssetId: null, anchorIndex: -1 })).toBeNull();
    expect(parsePreviewMessage({ t: 'mf-figure-move', questionId: 'q1', assetId: 'a', beforeAssetId: null, anchorIndex: 1.5 })).toBeNull();
    expect(parsePreviewMessage({ t: 'mf-figure-move', questionId: 'q1', assetId: 'a', beforeAssetId: null, anchorIndex: '2' })).toBeNull();
  });

  it('mf-question-answer-space 三态 + 旧形态兼容', () => {
    expect(parsePreviewMessage({ t: 'mf-question-answer-space', questionId: 'q1', action: 'add' }))
      .toEqual({ t: 'mf-question-answer-space', questionId: 'q1', action: 'add' });
    expect(parsePreviewMessage({ t: 'mf-question-answer-space', questionId: 'q1', action: 'lines', lines: 4 }))
      .toEqual({ t: 'mf-question-answer-space', questionId: 'q1', action: 'lines', lines: 4 });
    expect(parsePreviewMessage({ t: 'mf-question-answer-space', questionId: 'q1', action: 'style', style: 'lines' }))
      .toEqual({ t: 'mf-question-answer-space', questionId: 'q1', action: 'style', style: 'lines' });
    expect(parsePreviewMessage({ t: 'mf-question-answer-space', questionId: 'q1', action: 'remove' }))
      .toEqual({ t: 'mf-question-answer-space', questionId: 'q1', action: 'remove' });
    // 旧形态（fix-4 仅 lines）仍收窄为同一形状
    expect(parsePreviewMessage({ t: 'mf-question-answer-space', questionId: 'q1', lines: 3 }))
      .toEqual({ t: 'mf-question-answer-space', questionId: 'q1', lines: 3 });
    // 非法
    expect(parsePreviewMessage({ t: 'mf-question-answer-space', questionId: 'q1', action: 'drop' })).toBeNull();
    expect(parsePreviewMessage({ t: 'mf-question-answer-space', questionId: 'q1', action: 'style', style: 'dotted' })).toBeNull();
    expect(parsePreviewMessage({ t: 'mf-question-answer-space', questionId: 'q1' })).toBeNull();
  });

  it('mf-question-score：合法收窄 / 坏结构拒收', () => {
    expect(parsePreviewMessage({ t: 'mf-question-score', questionId: 'q1' })).toEqual({ t: 'mf-question-score', questionId: 'q1' });
    expect(parsePreviewMessage({ t: 'mf-question-score' })).toBeNull();
    expect(parsePreviewMessage({ t: 'mf-question-score', questionId: 7 })).toBeNull();
  });
});

describe('fix-5 P0-2 接线：落点锚位 → 题级覆盖落库（物化 anchorIndex）', () => {
  it('mf-figure-move(anchorIndex=2) → layout_json 写 anchorIndex 且 orderIndex 归一', async () => {
    const q1 = await makeFigureQuestion('锚点题');
    const paperId = await makePaper('锚点卷', [q1]);
    render(<ComposePage paperId={paperId} svc={svc} />);
    await waitFor(() => {
      if (!srcdocOf().includes('mf-seg')) throw new Error('段边界标记未注入');
    });

    const anchorStored = () => {
      const figures = ctx.store.paperQuestions.get(paperId)![0].layout?.figures ?? [];
      const hit = figures.find((f) => f.assetId === 'capture/a.png');
      return Boolean(hit && hit.anchorIndex === 2 && hit.orderIndex === 0);
    };
    await postUntil({ t: 'mf-figure-move', questionId: q1, assetId: 'capture/a.png', beforeAssetId: null, anchorIndex: 2 }, anchorStored);
    await waitFor(() => {
      if (!anchorStored()) throw new Error('锚点未落库');
    });
  });

  it('srcdoc 注入 CFG：段边界标记 + 作答区现状 + 恢复选中题 + 题分值 (5分)', async () => {
    const q1 = await makeFigureQuestion('分值题');
    const paperId = await makePaper('分值卷', [q1]);
    render(<ComposePage paperId={paperId} svc={svc} />);
    await waitFor(() => {
      if (!srcdocOf().includes('data-mf-seg')) throw new Error('段边界标记未注入');
    });
    const doc = srcdocOf();
    // P1-1：分值进渲染输入（题头 (5分)）
    expect(doc).toContain('<span class="question-score">(5分)</span>');
    // P1-3：作答区现状 + 恢复选中题进 CFG
    expect(doc).toContain('answerSpaces');
    expect(doc).toContain('selectedQuestionId');
    // P0-2：标记 CSS 与脚本层落点候选
    expect(doc).toContain('.mf-seg');
    expect(doc).toContain('boundaryCandidates');
  });

  it('操作条消息 → 选中题被记住并随 CFG 回传（重建后操作条不消失）', async () => {
    const q1 = await makeFigureQuestion('选中题');
    const paperId = await makePaper('选中卷', [q1]);
    render(<ComposePage paperId={paperId} svc={svc} />);
    await waitFor(() => {
      if (!srcdocOf().includes('mf-seg')) throw new Error('段边界标记未注入');
    });
    const added = () => ctx.store.paperQuestions.get(paperId)![0].layout?.answerSpace?.lines === 3;
    await postUntil({ t: 'mf-question-answer-space', questionId: q1, action: 'add' }, added);
    await waitFor(() => {
      if (!added()) throw new Error('添加未落库');
    });
    await waitFor(() => {
      const doc = srcdocOf();
      if (!doc.includes(`"selectedQuestionId":"${q1}"`)) throw new Error('选中题未回传 CFG');
      if (!doc.includes(`"${q1}":{"enabled":true,"lines":3`)) throw new Error('作答区现状未回传 CFG');
    });
  });

  it('mf-question-score → 左栏分值输入展开（P1-1 右栏入口）', async () => {
    const q1 = await makeFigureQuestion('分值入口题');
    const paperId = await makePaper('分值入口卷', [q1]);
    render(<ComposePage paperId={paperId} svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector(`[data-testid="score-btn-${q1}"]`)) throw new Error('题卡未渲染');
    });
    expect(container.querySelector(`[data-testid="score-input-${q1}"]`)).toBeNull();
    const scoreOpened = () => Boolean(container.querySelector(`[data-testid="score-input-${q1}"]`));
    await postUntil({ t: 'mf-question-score', questionId: q1 }, scoreOpened);
    expect(scoreOpened()).toBe(true);
    const input = container.querySelector(`[data-testid="score-input-${q1}"]`) as HTMLInputElement;
    expect(input.value).toBe('5');
  });
});

describe('fix-5 P1-2：IpcBankClient.addQuestion 全 5 参直通（真机路径断点）', () => {
  it('textBlock/layout 原样透传到桥（此前被丢弃 → 插入大标题无效果）', async () => {
    const calls: Array<Record<string, unknown>> = [];
    (window as unknown as { __mofangBank?: unknown }).__mofangBank = {
      addQuestion: (payload: Record<string, unknown>) => {
        calls.push(payload);
        return Promise.resolve();
      },
    };
    const client = new IpcBankClient();
    await client.addQuestion('p1', 'text:abc', undefined, { figures: [{ assetId: 'x.png' }] }, { text: '一、选择题', style: 'section' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      paperId: 'p1',
      questionId: 'text:abc',
      textBlock: { text: '一、选择题', style: 'section' },
      layout: { figures: [{ assetId: 'x.png' }] },
    });
  });
});
