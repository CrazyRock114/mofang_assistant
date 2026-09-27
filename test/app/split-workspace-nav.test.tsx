// 0036 目检返工：切题工作区的「返回」链路（导入首屏 ⇄ 工作区）
//
// 案底（用户目检 2026-09-18）：「没有看到继续切题与项目列表」——
// 根因是同一组件实例内 hash 从 #/split/<id> 变回 #/split 时本地 projectId 状态未复位，
// 于是「返回项目列表」成了空按钮，用户永远回不到列表。
// 本文件用迷你路由（hashchange → 透传 projectId）复现真实 main.tsx 的分发行为。
// @vitest-environment jsdom

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import type { MofangSplitBridge } from '../../src/shared/contracts/bridge.js';
import type { SplitProjectSummary } from '../../src/shared/contracts/split-types.js';
import { SplitWorkspacePage } from '../../src/app/pages/SplitWorkspacePage.js';
import { clearPendingPdf } from '../../src/app/splitting/handoff.js';

function flush(): void {
  flushSync(() => {});
}

const NOW = '2026-09-18T10:00:00.000Z';
const PROJECT: SplitProjectSummary = {
  id: '11111111-2222-4333-8444-555555555555',
  name: '教辅 A',
  sourceName: '教辅 A.pdf',
  pageCount: 30,
  segmentCount: 2,
  updatedAt: NOW,
};

function makeMeta() {
  return {
    id: PROJECT.id,
    name: PROJECT.name,
    sourceName: PROJECT.sourceName,
    sourceBytes: 100,
    pageCount: PROJECT.pageCount,
    segments: [
      { id: 'seg1', title: '第 1–15 页', fromPage: 1, toPage: 15, createdAt: NOW },
      { id: 'seg2', title: '第 16–30 页', fromPage: 16, toPage: 30, createdAt: NOW },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** 假桥：readSource 故意返回空 → 页图回落链在「无源文件」处收束，测试不必初始化 pdfjs */
function makeFakeSplit() {
  return {
    createProject: vi.fn(),
    appendSource: vi.fn(),
    readSource: vi.fn(async () => ({ dataBase64: '', eof: true })),
    saveMeta: vi.fn(),
    saveDraft: vi.fn(async () => ({ savedAt: NOW })),
    listProjects: vi.fn(async () => [PROJECT]),
    openProject: vi.fn(async () => ({ meta: makeMeta(), draft: { version: 1, segments: {}, updatedAt: NOW } })),
    removeProject: vi.fn(),
    writePage: vi.fn(async () => ({ file: 'pages/p001.png' })),
    readPage: vi.fn(async () => ({ dataBase64: null })),
  } as unknown as MofangSplitBridge;
}

let container: HTMLDivElement;
let root: Root | null = null;

function el<T extends HTMLElement = HTMLElement>(testid: string): T {
  const node = container.querySelector(`[data-testid="${testid}"]`);
  if (!node) throw new Error(`找不到元素: ${testid}（DOM: ${container.innerHTML.slice(0, 400)}）`);
  return node as T;
}

function has(testid: string): boolean {
  return container.querySelector(`[data-testid="${testid}"]`) !== null;
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    flush();
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor 超时（DOM: ${container.innerHTML.slice(0, 400)}）`);
}

/** 迷你路由：与 main.tsx 的 #/split 分发同构（hash → projectId prop） */
function Harness({ split }: { split: MofangSplitBridge }) {
  const [route, setRoute] = useState(window.location.hash);
  useEffect(() => {
    const onHash = (): void => setRoute(window.location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const m = route.match(/^#\/split\/(.+)$/);
  return <SplitWorkspacePage split={split} {...(m ? { projectId: decodeURIComponent(m[1]) } : {})} />;
}

function renderAt(hash: string, split: MofangSplitBridge): void {
  window.location.hash = hash;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => root!.render(<Harness split={split} />));
}

async function goTo(hash: string): Promise<void> {
  window.location.hash = hash;
  // jsdom 的 hashchange 是异步派发：等它到（真实浏览器同样时序）
  await waitFor(() => true, 100);
}

beforeEach(() => {
  clearPendingPdf();
  window.location.hash = '';
});

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  window.location.hash = '';
});

describe('0036 目检返工：切题工作区「返回」链路', () => {
  it('首屏（无项目）显示导入区 + 项目列表 + 「继续切题」', async () => {
    const split = makeFakeSplit();
    renderAt('#/split', split);
    await waitFor(() => has('split-project-list'));
    expect(el('split-dropzone-title').textContent).toContain('把整本教辅');
    expect(el(`split-open-${PROJECT.id}`).textContent).toContain('继续切题');
  });

  it('点「继续切题」→ 进工作区（#/split/<id> 由路由驱动）', async () => {
    const split = makeFakeSplit();
    renderAt('#/split', split);
    await waitFor(() => has('split-project-list'));
    el(`split-open-${PROJECT.id}`).click();
    await waitFor(() => has('split-workspace'));
    expect(window.location.hash).toBe(`#/split/${PROJECT.id}`);
    expect(split.openProject).toHaveBeenCalledWith({ projectId: PROJECT.id });
    // 工作区应带上该项目的段
    expect(el('split-segment-seg1').textContent).toContain('第 1–15 页');
  });

  it('工作区点「返回项目列表」→ 真的回到列表（案底：原为空按钮）', async () => {
    const split = makeFakeSplit();
    renderAt('#/split', split);
    await waitFor(() => has('split-project-list'));
    el(`split-open-${PROJECT.id}`).click();
    await waitFor(() => has('split-workspace'));

    el('split-back-to-list').click();
    await waitFor(() => has('split-project-list'));
    expect(has('split-workspace')).toBe(false);
    expect(window.location.hash).toBe('#/split');
  });

  it('浏览器后退（hash 变回 #/split）同样回到列表，不是卡在工作区', async () => {
    const split = makeFakeSplit();
    renderAt('#/split', split);
    await waitFor(() => has('split-project-list'));
    el(`split-open-${PROJECT.id}`).click();
    await waitFor(() => has('split-workspace'));

    await goTo('#/split');
    await waitFor(() => has('split-project-list'));
    expect(has('split-workspace')).toBe(false);
  });

  it('「返回项目列表」后再次进入同一项目仍能打开（复位不残留半截状态）', async () => {
    const split = makeFakeSplit();
    renderAt('#/split', split);
    await waitFor(() => has('split-project-list'));
    el(`split-open-${PROJECT.id}`).click();
    await waitFor(() => has('split-workspace'));
    el('split-back-to-list').click();
    await waitFor(() => has('split-project-list'));

    el(`split-open-${PROJECT.id}`).click();
    await waitFor(() => has('split-workspace'));
    expect(split.openProject).toHaveBeenCalledTimes(2);
  });

  it('首屏有「返回首页」（每屏都能返回上一级）', async () => {
    const split = makeFakeSplit();
    renderAt('#/split', split);
    await waitFor(() => has('split-project-list'));
    const back = el('split-back-home');
    back.click();
    await waitFor(() => window.location.hash === '#/');
    expect(window.location.hash).toBe('#/');
  });
});
