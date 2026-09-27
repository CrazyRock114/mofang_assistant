// 0046 P1：入口页读条（点位 4 PDF 栅格化 / 点位 5 后台 OCR 事件订阅）+ P5.2 sourceName 透传。
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { act } from 'react';

import type { MofangRecogBridge } from '../../src/shared/contracts/bridge.js';
import type { RecogEventPayload, RecogRun, RecogRunCreatePayload, RecogRunDetail } from '../../src/shared/contracts/recog-run-types.js';
import { clearPendingImages } from '../../src/app/workbench/handoff.js';
import { clearPendingPdf } from '../../src/app/splitting/handoff.js';
import { INITIAL_STAGE_SUBJECT, setStageSubject } from '../../src/app/state/stage-subject.js';

const NOW = '2026-09-22T10:00:00.000Z';
const RUN_ID = 'run-0046-pdf';

interface Hooks {
  eventSink: Array<(payload: RecogEventPayload) => void>;
  creates: RecogRunCreatePayload[];
  rasterizeProgress: Array<{ done: number; total: number }>;
}

function makeRun(status: RecogRun['status']): RecogRun {
  return {
    id: RUN_ID, status, stage: status, sourceKind: 'image', sourceName: null,
    pageCount: 3, pagesDone: 0, error: null, warnings: [], questionIds: [],
    createdAt: NOW, updatedAt: NOW, finishedAt: null,
  };
}

function makeRecog(hooks: Hooks, status: RecogRun['status']): MofangRecogBridge {
  const run = makeRun(status);
  return {
    create: async (payload) => {
      hooks.creates.push(payload);
      return { runId: RUN_ID, pageCount: payload.materials.length };
    },
    status: async (): Promise<RecogRunDetail> => ({ run, runDir: 'C:/tmp/run', pages: [], drafts: [] }),
    cancel: async () => run,
    history: async () => [run],
    attachQuestions: async () => run,
    resume: async () => run,
    onEvent: (cb) => { hooks.eventSink.push(cb); return () => undefined; },
    workbench: {
      load: async () => null,
      save: async () => ({ savedAt: NOW }),
    },
    draftWrite: async () => ({ savedAt: NOW, draftCount: 0, warnings: [] }),
  };
}

let container: HTMLDivElement;
let root: Root | null = null;
let hooks: Hooks;

async function renderIntake(status: RecogRun['status'], rasterize?: unknown): Promise<void> {
  const { IntakePage } = await import('../../src/app/pages/IntakePage.js');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const recog = makeRecog(hooks, status);
  flushSync(() => {
    root!.render(
      <IntakePage
        recog={recog}
        {...(rasterize ? { rasterize: rasterize as never } : {})}
      />,
    );
  });
}

async function settle(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

function q<T extends Element>(testid: string): T | null {
  return container.querySelector<T>(`[data-testid="${testid}"]`);
}

function dropFiles(files: File[]): void {
  const drop = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(drop, 'dataTransfer', { value: { files } });
  act(() => { q('intake-dropzone')!.dispatchEvent(drop); });
}

function fire(event: RecogEventPayload): void {
  act(() => { hooks.eventSink.forEach((cb) => cb(event)); });
}

beforeEach(() => {
  clearPendingImages();
  clearPendingPdf();
  setStageSubject(INITIAL_STAGE_SUBJECT);
  hooks = { eventSink: [], creates: [], rasterizeProgress: [] };
  window.location.hash = '';
});

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
});

describe('0046 P1：入口页读条', () => {
  it('④ PDF 栅格化：逐页读条「第 i/n 页」（rasterize 进度回调驱动），完成撤下', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await renderIntake('done', async (_file: File, onProgress?: (done: number, total: number) => void) => {
      onProgress?.(1, 2);
      hooks.rasterizeProgress.push({ done: 1, total: 2 });
      await gate; // 挂起：留住读条中间态
      return {
        materials: [
          { name: '卷-p001.png', mime: 'image/png', dataBase64: 'QUJD' },
          { name: '卷-p002.png', mime: 'image/png', dataBase64: 'QUJD' },
        ],
        files: [new File([new Uint8Array([1])], '卷-p001.png', { type: 'image/png' })],
        totalPages: 2, importedPages: 2, notice: null,
      };
    });
    await settle();
    expect(hooks.eventSink.length).toBeGreaterThan(0); // ⑤ 入口页已订阅事件流
    const pdf = new File([new Uint8Array([1, 2, 3])], '浮力练习卷.pdf', { type: 'application/pdf' });
    dropFiles([pdf]);
    await settle();
    expect(hooks.rasterizeProgress).toContainEqual({ done: 1, total: 2 });
    expect(q('intake-pdf-prog')?.textContent).toContain('第 1/2 页');
    act(() => { release(); });
    await settle();
    expect(q('intake-pdf-prog')).toBeNull();
    expect(window.location.hash).toBe(`#/intake/${RUN_ID}`);
  });

  it('⑤ 后台 OCR：事件驱动「最近识别记录」行内读条与状态 pill 实时化', async () => {
    await renderIntake('queued');
    await settle();
    // 初始：排队中，无读条
    expect(q(`intake-run-status-${RUN_ID}`)?.textContent).toContain('排队中');
    expect(q(`intake-run-prog-${RUN_ID}`)).toBeNull();
    fire({ runId: RUN_ID, type: 'ocr', pageIndex: 2, pageCount: 3, progress: 0.66 });
    await settle();
    expect(q(`intake-run-status-${RUN_ID}`)?.getAttribute('data-status')).toBe('ocr');
    expect(q(`intake-run-prog-${RUN_ID}`)?.textContent).toContain('第 2/3 页');
    fire({ runId: RUN_ID, type: 'done', draftCount: 2, pageCount: 3, progress: 1 });
    await settle();
    expect(q(`intake-run-prog-${RUN_ID}`)).toBeNull();
    expect(q(`intake-run-status-${RUN_ID}`)?.textContent).toContain('已完成');
  });
});

describe('0046 P5.2：入口页 create 带卷名', () => {
  it('PDF 拖入 → recog.create 带卷名（pdfPaperTitle）', async () => {
    await renderIntake('done', async () => ({
      materials: [{ name: '卷-p001.png', mime: 'image/png', dataBase64: 'QUJD' }],
      files: [new File([new Uint8Array([1])], '卷-p001.png', { type: 'image/png' })],
      totalPages: 1, importedPages: 1, notice: null,
    }));
    await settle();
    const pdf = new File([new Uint8Array([1, 2, 3])], '期中物理卷.pdf', { type: 'application/pdf' });
    dropFiles([pdf]);
    await settle();
    expect(hooks.creates).toHaveLength(1);
    expect(hooks.creates[0]!.sourceName).toBe('期中物理卷');
  });

  it('单图拖入 → create 沿用素材名（与 host 单素材口径一致）；多图不带 sourceName', async () => {
    await renderIntake('done');
    await settle();
    dropFiles([new File([new Uint8Array([1])], 'photo.jpg', { type: 'image/jpeg' })]);
    await settle();
    expect(hooks.creates[0]!.sourceName).toBe('photo.jpg');

    hooks.creates.length = 0;
    dropFiles([
      new File([new Uint8Array([1])], 'a.png', { type: 'image/png' }),
      new File([new Uint8Array([2])], 'b.png', { type: 'image/png' }),
    ]);
    await settle();
    expect(hooks.creates[0]!.sourceName).toBeUndefined();
  });
});
