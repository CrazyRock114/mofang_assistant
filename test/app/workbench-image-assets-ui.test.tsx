// 0057 P2/P3：录题链图资产化的界面腿——落资产（file.saveRecogImage）→ 题卡存存储形态 →
// 编辑器内显显示形态 → 两腿入库填 images；无桥时显式降级不静默。
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { act } from 'react';

import type { MofangAiBridge, MofangFileBridge, MofangRecogBridge } from '../../src/shared/contracts/bridge.js';
import type { BankExtServices, BankService, Question } from '../../src/shared/contracts/bank-types.js';
import type { RecogRun, RecogRunDetail } from '../../src/shared/contracts/recog-run-types.js';
import type { RecogSaveAsPaperPayload, RecogSaveAsPaperResult } from '../../src/shared/contracts/ipc-channels.js';
import type { WorkbenchState } from '../../src/shared/contracts/onestep-types.js';
import type { PageImageLike } from '../../src/app/workbench/crop.js';
import { createMockExtServices } from '../../src/bank/mock/mock-ext.js';
import { MockBankStore } from '../../src/bank/mock/mock-store.js';
import { MockBankService } from '../../src/bank/mock/mock-bank.js';

const FAKE_IMAGE: PageImageLike = { naturalWidth: 1000, naturalHeight: 1400, source: {} as CanvasImageSource, origin: 'memory' };
const CROP_DATA_URL = 'data:image/png;base64,QUJD'; // 与 mock 裁图一致
vi.mock('../../src/app/workbench/crop.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/app/workbench/crop.js')>();
  return {
    ...actual,
    loadPageImage: async (): Promise<PageImageLike> => FAKE_IMAGE,
    loadFileImage: async (): Promise<PageImageLike> => FAKE_IMAGE,
    cropNormalizedRect: () => ({ ok: true as const, dataUrl: CROP_DATA_URL, width: 320, height: 200 }),
  };
});

import { WorkbenchPage } from '../../src/app/pages/WorkbenchPage.js';

const RUN_ID = 'run-0057-1';
const NOW = '2026-09-22T10:00:00.000Z';
const ASSETS_ROOT = 'C:\\ud\\data\\assets';
const ASSETS_URL = 'file:///C:/ud/data/assets';

const MAIN_JSON = JSON.stringify({
  questions: [{
    qno: '2-17',
    questionType: '填空',
    stemMarkdown: '如图[图1]，求浮力。',
    options: null,
    answerMarkdown: null,
    analysisMarkdown: null,
    suggestedTags: [],
  }],
  figures: [{ ref: '图1', bboxNorm: [100, 200, 400, 400] }],
});

function makeState(cards: WorkbenchState['cards']): WorkbenchState {
  return {
    version: 1, runId: RUN_ID, mode: 'auto', stage: '', subjectId: '', paperTitle: '浮力练习.png',
    pages: [], cards, nextSeq: cards.length + 1, updatedAt: NOW,
  };
}

interface Spies {
  createdQuestions: Array<Record<string, unknown>>;
  savedStates: WorkbenchState[];
  savePayloads: RecogSaveAsPaperPayload[];
  savedImages: Array<{ dataUrl: string; width?: number; height?: number }>;
}

function makeSpies(): Spies {
  return { createdQuestions: [], savedStates: [], savePayloads: [], savedImages: [] };
}

function makeBank(spies: Spies): BankService {
  const base = new MockBankService(new MockBankStore(), false);
  return {
    ...base,
    createQuestion: async (data) => {
      spies.createdQuestions.push(data as unknown as Record<string, unknown>);
      return { ...data, id: `q-${spies.createdQuestions.length}`, createdAt: NOW, updatedAt: NOW } as Question;
    },
    addTag: async () => undefined,
    deleteQuestion: async () => undefined,
  } as BankService;
}

function makeExt(): BankExtServices {
  const base = createMockExtServices(new MockBankStore());
  return base;
}

function makeRecog(spies: Spies, initialState: WorkbenchState | null): MofangRecogBridge {
  let state = initialState;
  return {
    create: async () => { throw new Error('not used'); },
    status: async (): Promise<RecogRunDetail> => ({
      run: {
        id: RUN_ID, status: 'done', stage: 'done', sourceKind: 'image', sourceName: '浮力练习.png',
        pageCount: 1, pagesDone: 1, error: null, warnings: [], questionIds: [],
        createdAt: NOW, updatedAt: NOW, finishedAt: NOW,
      } satisfies RecogRun,
      runDir: 'C:/tmp/run-0057',
      pages: [{
        runId: RUN_ID, pageNo: 1, imageFile: 'pages/p001.png', ocrFile: null, status: 'done',
        textChars: 0, imageRefCount: 0, error: null, updatedAt: NOW,
        imagePath: 'C:/tmp/run-0057/pages/p001.png', ocrText: '',
      }],
      drafts: [],
    }),
    cancel: async () => { throw new Error('not used'); },
    history: async () => [],
    attachQuestions: async (payload): Promise<RecogRun> => ({
      id: payload.runId, status: 'done', stage: 'done', sourceKind: 'image', sourceName: null,
      pageCount: 1, pagesDone: 1, error: null, warnings: [], questionIds: payload.questionIds,
      createdAt: NOW, updatedAt: NOW, finishedAt: NOW,
    }),
    resume: async () => { throw new Error('not used'); },
    onEvent: () => () => undefined,
    workbench: {
      load: async () => state,
      save: async (payload) => { state = payload.state; spies.savedStates.push(payload.state); return { savedAt: NOW }; },
    },
    saveAsPaper: async (payload): Promise<RecogSaveAsPaperResult> => {
      spies.savePayloads.push(payload);
      return { paperId: 'paper-1', questionIds: payload.cards.map((_c, i) => `q-${i + 1}`) };
    },
    draftWrite: async () => ({ id: RUN_ID, status: 'done' }),
  } as unknown as MofangRecogBridge;
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((part) => {
      const p = part as { type?: string; text?: string };
      return p.type === 'text' ? (p.text ?? '') : '';
    }).join(' ');
  }
  return '';
}

/** AI 双档（vision 坐标腿 + reasoning 主档）；坐标腿问答照主档同源假数据（DSO 应答） */
function makeAi(): MofangAiBridge {
  const invoke = async (payload: { messages: Array<{ content: unknown }> }) => {
    const text = payload.messages.map((m) => textOf(m.content)).join(' ');
    if (text.includes('<|ref|>image<|/ref|>') || text.includes('Convert the document to markdown')) {
      return { ok: true, content: '<|ref|>image<|/ref|><|det|>[[100, 200, 400, 400]]<|/det|>', latencyMs: 3 };
    }
    return { ok: true, content: MAIN_JSON, latencyMs: 40 };
  };
  const profileOf = (id: string, role: 'vision' | 'reasoning', model: string) => ({
    id, role, name: role === 'vision' ? 'OCR' : 'VLM', provider: 'x', protocol: 'openai-chat',
    baseUrl: 'https://x', model, capability: null, isEnabled: true, hasKey: true,
    lastTestAt: NOW, lastTestOk: true, createdAt: NOW, updatedAt: NOW,
  });
  return {
    profile: {
      list: async () => [profileOf('p1', 'vision', 'deepseek-ocr'), profileOf('p2', 'reasoning', 'deepseek-flash')],
      create: async () => { throw new Error('not used'); },
      update: async () => { throw new Error('not used'); },
      delete: async () => undefined,
      setEnabled: async () => { throw new Error('not used'); },
      testConnection: async () => ({ ok: false, latencyMs: null, error: 'not used' }),
    },
    invoke: invoke as MofangAiBridge['invoke'],
    models: { list: async () => ({ ok: false, models: [], error: 'not used' }) },
    suggest: {
      anchorStatus: async () => { throw new Error('not used'); },
      treeLink: async () => { throw new Error('not used'); },
      tags: async () => { throw new Error('not used'); },
      treeForDraft: async () => ({ status: 'unavailable', reason: 'not used' }) as never,
    },
  } as unknown as MofangAiBridge;
}

/** 假 file 桥：只记账 + 固定 relPath（不写盘） */
function installFileBridge(spies: Spies, relPath = 'recog/abc123.png'): void {
  window.__mofangFile = {
    saveRecogImage: async (payload) => {
      spies.savedImages.push(payload);
      return { relPath, width: payload.width, height: payload.height };
    },
  } as unknown as MofangFileBridge;
}

let container: HTMLDivElement;
let root: Root | null = null;

function render(node: React.ReactElement): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => { root!.render(node); });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

async function settleUntil(predicate: () => boolean, rounds = 60): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    if (predicate()) return;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }
}

function click(el: Element | null): void {
  if (!el) throw new Error('找不到可点元素');
  flushSync(() => { (el as HTMLElement).click(); });
}

function q<T extends Element>(testid: string): T | null {
  return container.querySelector<T>(`[data-testid="${testid}"]`);
}

function renderWorkbench(spies: Spies, initialState: WorkbenchState | null = null): void {
  render(
    <WorkbenchPage
      runId={RUN_ID}
      recog={makeRecog(spies, initialState)}
      ai={makeAi()}
      bank={makeBank(spies)}
      ext={makeExt()}
      defaults={{ stage: '', subjectId: '', paperTitle: '浮力练习.png' }}
      files={[new File(['x'], 'page.png', { type: 'image/png' })]}
    />,
  );
}

beforeEach(() => {
  window.__mofangPaths = { userDataAssets: ASSETS_ROOT };
  delete window.__mofangFile;
});

afterEach(() => {
  flushSync(() => { root?.unmount(); });
  root = null;
  container.remove();
  delete window.__mofangPaths;
  delete window.__mofangFile;
});

describe('0057 P2：识别落卡的图先落资产（题卡存存储形态、编辑器显显示形态）', () => {
  it('AI 一键录入：裁图经 file.saveRecogImage 落盘，题卡内容写 data-assets 相对引用', async () => {
    const spies = makeSpies();
    installFileBridge(spies);
    renderWorkbench(spies);
    await settle();

    click(q('wb-ai-one-click'));
    await settle();
    await settle();

    expect(spies.savedImages).toEqual([{ dataUrl: CROP_DATA_URL, width: 320, height: 200 }]);
    // 题卡落盘走防抖：等到含资产引用的状态落盘（不靠固定轮次猜防抖窗口）
    await settleUntil(
      () => (spies.savedStates.at(-1)?.cards ?? []).some((c) => c.contentHtml.includes('data-assets/')),
      300,
    );
    const card = (spies.savedStates.at(-1)?.cards ?? []).find((c) => c.contentHtml.includes('data-assets/'));
    expect(card).toBeTruthy();
    expect(card!.contentHtml).toContain('src="data-assets/recog/abc123.png"');
    expect(card!.contentHtml).not.toContain('data:image');
  });

  it('编辑器内是显示形态：题卡里的 img src 是 file:// 绝对路径（相对引用在 file:// 页面会裂图）', async () => {
    const spies = makeSpies();
    installFileBridge(spies);
    renderWorkbench(spies);
    await settle();
    click(q('wb-ai-one-click'));
    await settle();
    await settleUntil(() => q('wb-editor-wrap-c1')?.querySelector('figure.diagram img.q-figure') != null);

    const img = q('wb-editor-wrap-c1')?.querySelector<HTMLImageElement>('figure.diagram img.q-figure');
    expect(img?.getAttribute('src')).toBe(`${ASSETS_URL}/recog/abc123.png`);
  });

  it('无资产根（浏览器 demo）：两侧归一退化为恒等，行为与改动前一致（不产占位节点）', async () => {
    const spies = makeSpies();
    installFileBridge(spies);
    delete window.__mofangPaths; // 无 __mofangPaths
    renderWorkbench(spies);
    await settle();
    click(q('wb-ai-one-click'));
    await settle();
    await settleUntil(() => q('wb-editor-wrap-c1')?.querySelector('figure.diagram img.q-figure') != null);

    const img = q('wb-editor-wrap-c1')?.querySelector<HTMLImageElement>('figure.diagram img.q-figure');
    expect(img?.getAttribute('src')).toBe('data-assets/recog/abc123.png');
    expect(container.querySelector('.asset-placeholder')).toBeNull();
  });
});

describe('0057 P3：两条入库腿都填 images（且落库内容零内联图）', () => {
  it('腿一「入库此题」：images 带 data-assets 前缀、content 无 data:、题卡回写存储形态', async () => {
    const spies = makeSpies();
    installFileBridge(spies);
    renderWorkbench(spies);
    await settle();
    click(q('wb-ai-one-click'));
    await settle();
    await settleUntil(() => q('wb-commit-c1') != null);

    click(q('wb-commit-c1'));
    await settle();

    expect(spies.createdQuestions).toHaveLength(1);
    const input = spies.createdQuestions[0]!;
    expect(input['images']).toEqual([{ assetId: 'data-assets/recog/abc123.png', type: 'figure' }]);
    expect(String(input['content'])).toContain('src="data-assets/recog/abc123.png"');
    expect(String(input['content'])).not.toContain('data:image');
    expect(String(input['stemHtml'])).toBe(String(input['content']));
  });

  it('入库前兜底：题卡里残余内联图（编辑器自带上传/粘贴形态）→ 提交前就地资产化', async () => {
    const spies = makeSpies();
    installFileBridge(spies, 'recog/fromEditor.png');
    const card = { ...makeState([]).cards } as never;
    void card;
    const seeded: WorkbenchState = makeState([{
      id: 'c1', status: 'question', source: 'ai', checked: true, frames: [], error: null,
      qno: '5', typeCode: '',
      contentHtml: `<div class="question"><p>题干</p><img src="${CROP_DATA_URL}"></div>`,
      answerHtml: '', analysisHtml: '', figures: [], figureSource: 'none',
      warnings: [], tags: [], adoptedTags: [], treeSuggestions: [], adoptedNode: null,
      committedQuestionId: null,
    }]);
    renderWorkbench(spies, seeded);
    await settle();
    await settleUntil(() => q('wb-commit-c1') != null);

    click(q('wb-commit-c1'));
    await settle();

    expect(spies.savedImages).toHaveLength(1);
    const input = spies.createdQuestions[0]!;
    expect(String(input['content'])).toContain('src="data-assets/recog/fromEditor.png"');
    expect(String(input['content'])).not.toContain('data:image');
    expect(input['images']).toEqual([{ assetId: 'data-assets/recog/fromEditor.png', type: 'figure' }]);
  });

  it('无 file 桥：显式降级（题照常入库、images 空、红条说明未落为资产）', async () => {
    const spies = makeSpies();
    delete window.__mofangFile;
    renderWorkbench(spies);
    await settle();
    click(q('wb-ai-one-click'));
    await settle();
    await settleUntil(() => q('wb-commit-c1') != null);

    click(q('wb-commit-c1'));
    await settle();

    const input = spies.createdQuestions[0]!;
    expect(String(input['content'])).toContain('data:image');
    expect(input['images']).toEqual([]);
    expect(container.textContent).toContain('未落为资产');
  });

  it('腿二「存为试卷」：payload 卡带 images（同一纯函数口径）', async () => {
    const spies = makeSpies();
    installFileBridge(spies);
    const seeded: WorkbenchState = makeState([{
      id: 'c1', status: 'question', source: 'ai', checked: true, frames: [], error: null,
      qno: '5', typeCode: '',
      contentHtml: '<div class="question"><p>题干</p><figure class="diagram"><img class="q-figure" src="data-assets/recog/fromPaper.png"></figure></div>',
      answerHtml: '', analysisHtml: '', figures: [], figureSource: 'none',
      warnings: [], tags: [], adoptedTags: [], treeSuggestions: [], adoptedNode: null,
      committedQuestionId: null,
    }]);
    renderWorkbench(spies, seeded);
    await settle();

    click(q('wb-save-as-paper'));
    await settleUntil(() => q('wb-save-as-paper-save') != null);
    click(q('wb-save-as-paper-save'));
    await settle();

    expect(spies.savePayloads).toHaveLength(1);
    expect(spies.savePayloads[0]!.cards[0]!.images).toEqual([
      { assetId: 'data-assets/recog/fromPaper.png', type: 'figure' },
    ]);
  });
});
