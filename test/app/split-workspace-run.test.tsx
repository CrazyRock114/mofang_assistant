// 0036 目检返工：识别失败的可见性与可恢复性
//
// 案底（用户目检 2026-09-18）：跨页题卡只显示「识别失败」，**看不到失败原因**、也没有重试入口，
// 用户与验收方都无从判断是模型/限流/图片问题——「失败必须可解释、可恢复」。
// 复用 0028 既有能力：recog.event 的 error 事件带 message；recog.run.resume 走 error→ocr 续跑边
// （已完成页由 checkpoint 跳过）。
// @vitest-environment jsdom

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import type { MofangRecogBridge, MofangSplitBridge } from '../../src/shared/contracts/bridge.js';
import type { RecogEventPayload, RecogRun, RecogRunDetail } from '../../src/shared/contracts/recog-run-types.js';
import type { SplitProjectSummary } from '../../src/shared/contracts/split-types.js';
import { SplitWorkspacePage } from '../../src/app/pages/SplitWorkspacePage.js';
import { clearPendingPdf } from '../../src/app/splitting/handoff.js';

const NOW = '2026-09-18T10:00:00.000Z';
const PROJECT_ID = '11111111-2222-4333-8444-555555555555';

const PROJECT: SplitProjectSummary = {
  id: PROJECT_ID, name: '教辅 A', sourceName: '教辅 A.pdf', pageCount: 30, segmentCount: 1, updatedAt: NOW,
};

/** 段草稿里预置一道已发起但识别失败的题（模拟用户看到的现场） */
function meta() {
  return {
    id: PROJECT_ID, name: PROJECT.name, sourceName: PROJECT.sourceName, sourceBytes: 100,
    pageCount: 30,
    segments: [{ id: 'seg1', title: '第 1–15 页', fromPage: 1, toPage: 15, createdAt: NOW }],
    createdAt: NOW, updatedAt: NOW,
  };
}

function draftWithFailedRun() {
  return {
    version: 1 as const,
    updatedAt: NOW,
    segments: {
      seg1: {
        boxes: [
          { id: 'p1-b1', qid: 'q1', type: 'text' as const, page: 1, x: 0.1, y: 0.1, w: 0.5, h: 0.2 },
          { id: 'p2-b2', qid: 'q1', type: 'answer' as const, page: 2, x: 0.1, y: 0.1, w: 0.5, h: 0.1 },
        ],
        runs: [{ qid: 'q1', runId: 'run-failed', status: 'error' as const, questionIds: [], error: null }],
      },
    },
  };
}

function makeSplit(): MofangSplitBridge {
  return {
    createProject: vi.fn(),
    appendSource: vi.fn(),
    readSource: vi.fn(async () => ({ dataBase64: '', eof: true })),
    saveMeta: vi.fn(),
    saveDraft: vi.fn(async () => ({ savedAt: NOW })),
    listProjects: vi.fn(async () => [PROJECT]),
    openProject: vi.fn(async () => ({ meta: meta(), draft: draftWithFailedRun() })),
    removeProject: vi.fn(),
    writePage: vi.fn(async () => ({ file: 'pages/p001.png' })),
    readPage: vi.fn(async () => ({ dataBase64: null })),
  } as unknown as MofangSplitBridge;
}

function makeRecog() {
  const listeners = new Set<(p: RecogEventPayload) => void>();
  const resume = vi.fn(async (): Promise<RecogRun> => ({
    id: 'run-failed', status: 'ocr', stage: 'ocr', sourceKind: 'pdf-split', sourceName: null,
    pageCount: 2, pagesDone: 0, error: null, warnings: [], questionIds: [], createdAt: NOW, updatedAt: NOW, finishedAt: null,
  }));
  const bridge = {
    create: vi.fn(),
    status: vi.fn(async (): Promise<RecogRunDetail> => ({
      run: {
        id: 'run-failed', status: 'error', stage: 'error', sourceKind: 'pdf-split', sourceName: null,
        pageCount: 2, pagesDone: 0, error: '第 2 页识别失败：vision OCR 调用失败：429 rate limit', warnings: [],
        questionIds: [], createdAt: NOW, updatedAt: NOW, finishedAt: NOW,
      },
      runDir: 'C:/tmp/run-failed', pages: [], drafts: [],
    })),
    cancel: vi.fn(),
    history: vi.fn(async () => []),
    attachQuestions: vi.fn(),
    resume,
    onEvent: (cb: (p: RecogEventPayload) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  } as unknown as MofangRecogBridge;
  return {
    bridge,
    resume,
    emit: (p: RecogEventPayload) => {
      for (const cb of [...listeners]) cb(p);
    },
  };
}

let container: HTMLDivElement;
let root: Root | null = null;

function flush(): void {
  flushSync(() => {});
}
function el<T extends HTMLElement = HTMLElement>(testid: string): T {
  const node = container.querySelector(`[data-testid="${testid}"]`);
  if (!node) throw new Error(`找不到元素: ${testid}（DOM: ${container.innerHTML.slice(0, 400)}）`);
  return node as T;
}
function has(testid: string): boolean {
  return container.querySelector(`[data-testid="${testid}"]`) !== null;
}
async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    flush();
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor 超时（DOM: ${container.innerHTML.slice(0, 500)}）`);
}

async function renderWorkspace(): Promise<{ recog: ReturnType<typeof makeRecog> }> {
  const split = makeSplit();
  const recog = makeRecog();
  window.location.hash = `#/split/${PROJECT_ID}`;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => root!.render(<SplitWorkspacePage projectId={PROJECT_ID} split={split} recog={recog.bridge} />));
  // 等草稿加载完（题卡出现）再发事件：openProject 是异步的，草稿未到时事件无处落账
  await waitFor(() => has('split-q-select-q1'));
  return { recog };
}

beforeEach(() => {
  clearPendingPdf();
});
afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  window.location.hash = '';
});

describe('0036 目检返工：识别失败的可见性与重试', () => {
  it('error 事件到达后题卡显示失败原因（不再只有「识别失败」三个字）', async () => {
    const { recog } = await renderWorkspace();
    recog.emit({
      runId: 'run-failed', type: 'error', pageCount: 2,
      message: '第 2 页识别失败：vision OCR 调用失败：429 rate limit',
    });
    await waitFor(() => has('split-run-error-q1'));
    expect(el('split-run-error-q1').textContent).toContain('429');
  });

  it('失败题提供「重试」：调 recog.resume 且状态回到识别中（复用 0028 续跑边）', async () => {
    const { recog } = await renderWorkspace();
    recog.emit({ runId: 'run-failed', type: 'error', pageCount: 2, message: '第 2 页识别失败：超时' });
    await waitFor(() => has('split-run-retry-q1'));

    el('split-run-retry-q1').click();
    await waitFor(() => recog.resume.mock.calls.length > 0);
    expect(recog.resume).toHaveBeenCalledWith({ runId: 'run-failed' });
    // 状态文案应离开「识别失败」，回到在跑语义
    await waitFor(() => (el('split-run-status-q1').textContent ?? '').includes('识别中'));
  });

  it('重试后错误原因清空（不把上一次的失败文案一直挂在题卡上）', async () => {
    const { recog } = await renderWorkspace();
    recog.emit({ runId: 'run-failed', type: 'error', pageCount: 2, message: '第 2 页识别失败：超时' });
    await waitFor(() => has('split-run-error-q1'));
    el('split-run-retry-q1').click();
    await waitFor(() => !has('split-run-error-q1'));
  });

  it('重开的项目里历史失败原因从草稿恢复（关页回来仍知道为什么失败）', async () => {
    // 预置草稿里已带 error（上一次会话失败后落盘）
    const split = makeSplit();
    (split.openProject as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      meta: meta(),
      draft: {
        version: 1, updatedAt: NOW,
        segments: {
          seg1: {
            boxes: draftWithFailedRun().segments.seg1.boxes,
            runs: [{ qid: 'q1', runId: 'run-failed', status: 'error', questionIds: [], error: '第 1 页识别失败：连接超时' }],
          },
        },
      },
    });
    const recog = makeRecog();
    window.location.hash = `#/split/${PROJECT_ID}`;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => root!.render(<SplitWorkspacePage projectId={PROJECT_ID} split={split} recog={recog.bridge} />));
    await waitFor(() => has('split-run-error-q1'));
    expect(el('split-run-error-q1').textContent).toContain('连接超时');
  });
});
