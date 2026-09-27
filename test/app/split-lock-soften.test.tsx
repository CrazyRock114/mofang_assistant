// 0040 P6.2：0036 锁定语义软化（D-054 并入）。
// 原语义：识别完成的题「改框须先删识别结果」，且整段学段/学科选择器被锁定禁用。
// 新语义：「解锁并重识别」一步操作（解锁 → 框可改 → 再识别即覆盖），学段/学科不再因锁定禁用。
// @vitest-environment jsdom

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import type { MofangRecogBridge, MofangSplitBridge } from '../../src/shared/contracts/bridge.js';
import type { RecogRun, RecogRunDetail } from '../../src/shared/contracts/recog-run-types.js';
import type { SplitProjectSummary } from '../../src/shared/contracts/split-types.js';
import { SplitWorkspacePage } from '../../src/app/pages/SplitWorkspacePage.js';
import { clearPendingPdf } from '../../src/app/splitting/handoff.js';

const NOW = '2026-09-19T10:00:00.000Z';
const PROJECT_ID = '11111111-2222-4333-8444-555555555555';

const PROJECT: SplitProjectSummary = {
  id: PROJECT_ID, name: '教辅 A', sourceName: '教辅 A.pdf', pageCount: 30, segmentCount: 1, updatedAt: NOW,
};

/** 段草稿里预置一道**识别完成**（done）的题 → 旧语义下即锁定态 */
function meta() {
  return {
    id: PROJECT_ID, name: PROJECT.name, sourceName: PROJECT.sourceName, sourceBytes: 100,
    pageCount: 30,
    segments: [{ id: 'seg1', title: '第 1–15 页', fromPage: 1, toPage: 15, createdAt: NOW }],
    createdAt: NOW, updatedAt: NOW,
  };
}

function draftWithDoneRun() {
  return {
    version: 1 as const,
    updatedAt: NOW,
    segments: {
      seg1: {
        boxes: [
          { id: 'p1-b1', qid: 'q1', type: 'text' as const, page: 1, x: 0.1, y: 0.1, w: 0.5, h: 0.2 },
        ],
        runs: [{ qid: 'q1', runId: 'run-done', status: 'done' as const, questionIds: ['q-1'], error: null }],
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
    openProject: vi.fn(async () => ({ meta: meta(), draft: draftWithDoneRun() })),
    removeProject: vi.fn(),
    writePage: vi.fn(async () => ({ file: 'pages/p001.png' })),
    readPage: vi.fn(async () => ({ dataBase64: null })),
  } as unknown as MofangSplitBridge;
}

function makeRecog(): MofangRecogBridge {
  const run: RecogRun = {
    id: 'run-done', status: 'done', stage: 'done', sourceKind: 'pdf-split', sourceName: null,
    pageCount: 1, pagesDone: 1, error: null, warnings: [], questionIds: ['q-1'],
    createdAt: NOW, updatedAt: NOW, finishedAt: NOW,
  };
  return {
    create: vi.fn(),
    status: vi.fn(async (): Promise<RecogRunDetail> => ({ run, runDir: 'C:/tmp/run-done', pages: [], drafts: [] })),
    cancel: vi.fn(),
    history: vi.fn(async () => []),
    attachQuestions: vi.fn(),
    resume: vi.fn(),
    onEvent: () => () => undefined,
  } as unknown as MofangRecogBridge;
}

let container: HTMLDivElement;
let root: Root | null = null;

function flush(): void { flushSync(() => {}); }
function el<T extends HTMLElement = HTMLElement>(testid: string): T {
  const node = container.querySelector(`[data-testid="${testid}"]`);
  if (!node) throw new Error(`找不到元素: ${testid}（DOM: ${container.innerHTML.slice(0, 400)}）`);
  return node as T;
}
function has(testid: string): boolean {
  return container.querySelector(`[data-testid="${testid}"]`) !== null;
}
/** 点击：flushSync 包裹，保证 React 状态更新在断言前落定（既有页面测试同款） */
function clickBtn(testid: string): void {
  flushSync(() => { el(testid).click(); });
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

async function renderWorkspace(): Promise<void> {
  window.location.hash = `#/split/${PROJECT_ID}`;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => root!.render(<SplitWorkspacePage projectId={PROJECT_ID} split={makeSplit()} recog={makeRecog()} />));
  await waitFor(() => has('split-q-select-q1'));
}

beforeEach(() => { clearPendingPdf(); });
afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  window.location.hash = '';
});

describe('0040 P6.2：识别完成题「解锁并重识别」', () => {
  it('识别完成的题标注锁定态，并提供「解锁并重识别」一步入口', async () => {
    await renderWorkspace();
    expect(el('split-q-q1').getAttribute('data-locked')).toBe('true');
    expect(has('split-run-unlock-q1')).toBe(true);
    expect(el('split-lock-status').textContent).toContain('解锁并重识别');
  });

  it('学段/学科选择器不再因锁定禁用（0040 软化：锁定只管框，不管课程）', async () => {
    await renderWorkspace();
    expect((el('split-stage-select') as HTMLSelectElement).disabled).toBe(false);
    expect((el('split-subject-select') as HTMLSelectElement).disabled).toBe(false);
  });

  it('点「解锁并重识别」→ 该题脱离锁定、框可改，且计数进「识别本段」的启用条件', async () => {
    await renderWorkspace();
    // 解锁前：唯一一题已识别完成 → 「识别本段」无可发起项（禁用）
    expect((el('split-recognize') as HTMLButtonElement).disabled).toBe(true);

    clickBtn('split-run-unlock-q1');
    await waitFor(() => el('split-q-q1').getAttribute('data-locked') === 'false');
    expect(el('split-recognize').textContent).toContain('1 重识别');
    expect((el('split-recognize') as HTMLButtonElement).disabled).toBe(false);
    expect(container.textContent).toContain('已解锁');
  });

  it('解锁后撤销上一步/删除框可作用于该题（框不再被锁定挡掉）', async () => {
    await renderWorkspace();
    clickBtn('split-run-unlock-q1');
    await waitFor(() => el('split-q-q1').getAttribute('data-locked') === 'false');
    // 选中该题的框 → 删除框可用（解锁前被 lockedQids 挡掉）
    clickBtn('split-q-select-q1');
    await waitFor(() => !(el('split-delete') as HTMLButtonElement).disabled);
    clickBtn('split-delete');
    await waitFor(() => (container.textContent ?? '').includes('本段题目（0）'));
  });
});
