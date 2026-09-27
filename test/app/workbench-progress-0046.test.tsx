// 0046 P1/P3：工作台读条动画七点位（工作台侧六点）+ 黄条「去处理」跳转 + P5.1 draftWrite 调用链。
// 异步全部可控（deferred 门），中间态可断言；页图解码同样可控（页图加载读条要看到过程）。
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { act } from 'react';

import type { MofangAiBridge, MofangRecogBridge } from '../../src/shared/contracts/bridge.js';
import type { BankExtServices, BankService, DictEntry, Question } from '../../src/shared/contracts/bank-types.js';
import type { AiInvokeResult } from '../../src/shared/contracts/ai-types.js';
import type { RecogDraftWritePayload, RecogEventPayload, RecogRun, RecogRunDetail } from '../../src/shared/contracts/recog-run-types.js';
import type { WorkbenchCard, WorkbenchState } from '../../src/shared/contracts/onestep-types.js';
import type { PageImageLike } from '../../src/app/workbench/crop.js';
import { createMockExtServices } from '../../src/bank/mock/mock-ext.js';
import { MockBankStore } from '../../src/bank/mock/mock-store.js';
import { MockBankService } from '../../src/bank/mock/mock-bank.js';
import { newPendingCard, makeFrame } from '../../src/recog/onestep/workbench.js';
import { clearPendingImages } from '../../src/app/workbench/handoff.js';

const NOW = '2026-09-22T10:00:00.000Z';
const RUN_ID = 'run-0046-1';
const FAKE_IMAGE: PageImageLike = { naturalWidth: 1000, naturalHeight: 1400, source: {} as CanvasImageSource, origin: 'memory' };

/** 页图解码闸：pageImagesAuto=true 时立即就绪，false 时挂起等测试放行（页图读条中间态） */
let pageImagesAuto = true;
vi.mock('../../src/app/workbench/crop.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/app/workbench/crop.js')>();
  return {
    ...actual,
    loadPageImage: (): Promise<PageImageLike> => {
      if (pageImagesAuto) return Promise.resolve(FAKE_IMAGE);
      return new Promise<PageImageLike>((resolve) => { invokeGates.pageImageResolvers.push(resolve); });
    },
    loadFileImage: (): Promise<PageImageLike> => {
      if (pageImagesAuto) return Promise.resolve(FAKE_IMAGE);
      return new Promise<PageImageLike>((resolve) => { invokeGates.pageImageResolvers.push(resolve); });
    },
    cropNormalizedRect: () => ({ ok: true as const, dataUrl: 'data:image/png;base64,QUJD', width: 320, height: 200 }),
  };
});

import { WorkbenchPage } from '../../src/app/pages/WorkbenchPage.js';

/** 识别 invoke 闸：resolve 函数排队，测试逐个放行 */
const invokeGates: {
  ai: Array<(r: AiInvokeResult) => void>;
  createQuestion: Array<(q: Question) => void>;
  pageImageResolvers: Array<(img: PageImageLike) => void>;
  /** 0046 目检返工②：挂树建议生成门 */
  treeForDraft: Array<(r: unknown) => void>;
} = { ai: [], createQuestion: [], pageImageResolvers: [], treeForDraft: [] };

/** 无图块的最小一步到位 JSON（主调用一次腿即可，不触发 DSO 对账） */
const MAIN_JSON = JSON.stringify({
  questions: [{ qno: '5', questionType: '填空', stemMarkdown: '求 $F$ 的大小。', options: null, answerMarkdown: '10N', analysisMarkdown: null, suggestedTags: [] }],
  figures: [],
});

function makeRun(): RecogRun {
  return {
    id: RUN_ID, status: 'queued', stage: 'queued', sourceKind: 'image', sourceName: '浮力练习',
    pageCount: 1, pagesDone: 0, error: null, warnings: [], questionIds: [],
    createdAt: NOW, updatedAt: NOW, finishedAt: null,
  };
}

interface Hooks {
  eventSink: Array<(payload: RecogEventPayload) => void>;
  draftWrites: RecogDraftWritePayload[];
}

function makeState(cards: WorkbenchCard[]): WorkbenchState {
  return {
    version: 1, runId: RUN_ID, mode: 'auto', stage: '初中', subjectId: 'subj:physics', paperTitle: '浮力练习',
    pages: [{ pageNo: 1, name: 'p001.png', width: 1000, height: 1400 }],
    cards, nextSeq: 100, updatedAt: NOW,
  };
}

function pendingCard(id: string): WorkbenchCard {
  return newPendingCard({
    id,
    frames: [makeFrame(`f-${id}`, { pageNo: 1, rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.3 } })],
    source: 'manual',
  });
}

function questionCard(id: string, over: Partial<WorkbenchCard> = {}): WorkbenchCard {
  return {
    ...newPendingCard({ id, frames: [], source: 'ai' }),
    status: 'question',
    checked: true,
    qno: '5',
    typeCode: 'qtype:blank',
    contentHtml: '<div class="question"><p>将物体放入液体中。</p></div>',
    answerHtml: '<p>10N</p>',
    analysisHtml: '',
    ...over,
  };
}

function makeRecog(hooks: Hooks, state: WorkbenchState | null): MofangRecogBridge {
  const run = makeRun();
  return {
    create: async () => ({ runId: RUN_ID, pageCount: 1 }),
    status: async (): Promise<RecogRunDetail> => ({
      run,
      runDir: 'C:/tmp/run',
      pages: [{ runId: RUN_ID, pageNo: 1, imageFile: 'pages/p001.png', ocrFile: null, status: 'done', textChars: 0, imageRefCount: 0, error: null, updatedAt: NOW, imagePath: 'C:/tmp/run/pages/p001.png', ocrText: '' }],
      drafts: [],
    }),
    cancel: async () => run,
    history: async () => [run],
    attachQuestions: async () => run,
    resume: async () => run,
    onEvent: (cb) => { hooks.eventSink.push(cb); return () => undefined; },
    workbench: {
      load: async () => state,
      save: async () => ({ savedAt: NOW }),
    },
    draftWrite: async (payload) => {
      hooks.draftWrites.push(payload);
      return { savedAt: NOW, draftCount: payload.drafts.length, warnings: [] };
    },
  };
}

function makeAi(): MofangAiBridge {
  const invoke = async (payload: { role: string }): Promise<AiInvokeResult> => {
    void payload;
    return new Promise<AiInvokeResult>((resolve) => { invokeGates.ai.push(resolve); });
  };
  return {
    profile: {
      list: async () => [{
        id: 'p1', role: 'vision' as const, name: 'OCR', provider: 'x', protocol: 'openai-chat',
        baseUrl: 'https://x', model: 'deepseek-ocr', capability: null, isEnabled: true, hasKey: true,
        lastTestAt: NOW, lastTestOk: true, createdAt: NOW, updatedAt: NOW,
      }],
      create: async () => { throw new Error('unused'); },
      update: async () => { throw new Error('unused'); },
      delete: async () => undefined,
      setEnabled: async () => { throw new Error('unused'); },
      testConnection: async () => ({ ok: false, latencyMs: null, error: 'unused' }),
    },
    invoke: invoke as MofangAiBridge['invoke'],
    models: { list: async () => ({ ok: false, models: [], error: 'unused' }) },
    suggest: {
      anchorStatus: async () => { throw new Error('unused'); },
      treeLink: async () => { throw new Error('unused'); },
      tags: async () => { throw new Error('unused'); },
      treeForDraft: async () => new Promise((resolve) => { invokeGates.treeForDraft.push(resolve); }),
    },
  };
}

function makeBank(): BankService {
  const base = new MockBankService(new MockBankStore(), false);
  return {
    ...base,
    createQuestion: async (data) => new Promise<Question>((resolve) => {
      invokeGates.createQuestion.push(() => resolve({
        ...data, id: `q-${invokeGates.createQuestion.length}`, createdAt: NOW, updatedAt: NOW,
      } as Question));
    }),
  } as BankService;
}

function makeExt(): BankExtServices {
  const base = createMockExtServices(new MockBankStore());
  const subjects: DictEntry[] = [{ id: 'subj:physics', kind: 'subject', code: 'physics', label: '物理', site: null, active: true }];
  const types: DictEntry[] = [{ id: 'qtype:blank', kind: 'question_type', code: 'fill', label: '填空题', site: null, active: true }];
  return {
    ...base,
    dict: {
      ...base.dict,
      listEntries: async (filter) => (filter?.kind === 'subject' ? subjects : filter?.kind === 'question_type' ? types : []),
    },
  } as BankExtServices;
}

let container: HTMLDivElement;
let root: Root | null = null;
let hooks: Hooks;

function renderWorkbench(cards: WorkbenchCard[], opts?: { files?: File[] }): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => {
    root!.render(
      <WorkbenchPage
        runId={RUN_ID}
        recog={makeRecog(hooks, makeState(cards))}
        ai={makeAi()}
        bank={makeBank()}
        ext={makeExt()}
        files={opts?.files}
        defaults={{ stage: '初中', subjectId: 'subj:physics', paperTitle: '浮力练习' }}
      />,
    );
  });
}

async function settle(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

function click(el: Element | null): void {
  if (!el) throw new Error('找不到可点元素');
  flushSync(() => { (el as HTMLElement).click(); });
}

function q<T extends Element>(testid: string): T | null {
  return container.querySelector<T>(`[data-testid="${testid}"]`);
}

function fire(event: RecogEventPayload): void {
  act(() => { hooks.eventSink.forEach((cb) => cb(event)); });
}

beforeEach(() => {
  clearPendingImages();
  pageImagesAuto = true;
  invokeGates.ai = [];
  invokeGates.createQuestion = [];
  invokeGates.pageImageResolvers = [];
  hooks = { eventSink: [], draftWrites: [] };
  window.location.hash = '';
});

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
});

describe('0046 P1：工作台读条（点位 1/2/3/6）', () => {
  it('① 单卡识别：读条出现（统一 progress-shell 结构 + 阶段文案），完成即撤', async () => {
    renderWorkbench([pendingCard('c1')]);
    await settle();
    expect(q('wb-prog-c1')).toBeNull();
    click(q('wb-recognize-c1'));
    await settle();
    const prog = q('wb-prog-c1');
    expect(prog).toBeTruthy();
    expect(prog!.className).toContain('progress-shell');
    expect(prog!.textContent).toContain('AI 识别中');
    // 放行主调用 → 出题卡，读条撤下
    act(() => { invokeGates.ai.forEach((r) => r({ ok: true, content: MAIN_JSON, latencyMs: 1 })); });
    await settle();
    expect(q('wb-prog-c1')).toBeNull();
    expect(q('wb-card-c1')?.getAttribute('data-status')).toBe('question');
  });

  it('② 批量识别：聚合读条「第 i/n 题」随完成数递增，全完撤下', async () => {
    renderWorkbench([pendingCard('c1'), pendingCard('c2')]);
    await settle();
    click(q('wb-recognize-all'));
    await settle();
    // 两张卡各自 pending 中（invoke 未放行）：先确认读条在
    expect(q('wb-batch-prog')?.textContent).toContain('第 0/2 题');
    // 每卡识别链 = 主调用 + DSO 双模板共 3 腿；逐门放行直到第一张卡完成（读条 1/2）
    for (let i = 0; i < 8; i++) {
      if (q('wb-batch-prog')?.textContent?.includes('第 1/2 题')) break;
      const gate = invokeGates.ai.shift();
      if (!gate) break;
      act(() => { gate({ ok: true, content: MAIN_JSON, latencyMs: 1 }); });
      await settle(2);
    }
    expect(q('wb-batch-prog')?.textContent).toContain('第 1/2 题');
    act(() => { invokeGates.ai.forEach((r) => r({ ok: true, content: MAIN_JSON, latencyMs: 1 })); });
    await settle();
    expect(q('wb-batch-prog')).toBeNull();
  });

  it('③ AI 一键：读条「第 i/n 页」，全部页完成撤下', async () => {
    renderWorkbench([]);
    await settle();
    click(q('wb-ai-one-click'));
    await settle();
    expect(q('wb-ai-prog')?.textContent).toContain('第 0/1 页');
    act(() => { invokeGates.ai.forEach((r) => r({ ok: true, content: MAIN_JSON, latencyMs: 1 })); });
    await settle();
    expect(q('wb-ai-prog')).toBeNull();
  });

  it('⑥ 批量入库：聚合读条「第 i/n 题」逐题递增（目检返工④：点击即入库，无二次确认）', async () => {
    renderWorkbench([questionCard('c1'), questionCard('c2')]);
    await settle();
    click(q('wb-batch-commit'));
    await settle();
    expect(q('wb-confirm-batch-commit')).toBeNull(); // 弹层已按用户拍板移除
    expect(q('wb-commit-prog')?.textContent).toContain('第 0/2 题');
    act(() => { invokeGates.createQuestion[0]?.(); });
    await settle();
    expect(q('wb-commit-prog')?.textContent).toContain('第 1/2 题');
    act(() => { invokeGates.createQuestion.forEach((r) => r()); });
    await settle();
    expect(q('wb-commit-prog')).toBeNull();
  });
});

describe('0046 P1：事件驱动读条（点位 5）+ 页图加载（点位 7）', () => {
  it('⑤ 后台 OCR：订阅 recog.onEvent 驱动读条（queued/ocr/ai/done 全程）', async () => {
    renderWorkbench([]);
    await settle();
    expect(hooks.eventSink.length).toBeGreaterThan(0);
    fire({ runId: RUN_ID, type: 'queued', pageCount: 2, progress: 0 });
    await settle();
    expect(q('wb-bg-prog')?.textContent).toContain('排队');
    fire({ runId: RUN_ID, type: 'ocr', pageIndex: 1, pageCount: 2, progress: 0.5 });
    await settle();
    expect(q('wb-bg-prog')?.textContent).toContain('第 1/2 页');
    fire({ runId: RUN_ID, type: 'ocr', pageIndex: 2, pageCount: 2, progress: 1 });
    await settle();
    expect(q('wb-bg-prog')?.textContent).toContain('第 2/2 页');
    fire({ runId: RUN_ID, type: 'done', draftCount: 1, pageCount: 2, progress: 1 });
    await settle();
    expect(q('wb-bg-prog')).toBeNull();
  });

  it('⑤ 非 run 命中（其他 run 的事件）不驱动本页读条', async () => {
    renderWorkbench([]);
    await settle();
    fire({ runId: 'other-run', type: 'ocr', pageIndex: 1, pageCount: 2, progress: 0.5 });
    await settle();
    expect(q('wb-bg-prog')).toBeNull();
  });

  it('⑦ 页图加载：有页数时读条（解码中可见，完成撤下）', async () => {
    pageImagesAuto = false;
    renderWorkbench([pendingCard('c1')]);
    await settle();
    const prog = q('wb-page-prog');
    expect(prog).toBeTruthy();
    expect(prog!.textContent).toContain('页图');
    expect(prog!.textContent).toContain('1 页');
    // 放行页图解码 → 加载完成，读条撤下
    act(() => { invokeGates.pageImageResolvers.forEach((r) => r(FAKE_IMAGE)); });
    await settle();
    expect(q('wb-page-prog')).toBeNull();
  });
});

describe('0046 P5.1：识别成功 → recog.draftWrite 写回调用链', () => {
  it('单卡识别成功 → draftWrite 携带 Onestep 草稿整批写回', async () => {
    renderWorkbench([pendingCard('c1')]);
    await settle();
    click(q('wb-recognize-c1'));
    await settle();
    act(() => { invokeGates.ai.forEach((r) => r({ ok: true, content: MAIN_JSON, latencyMs: 1 })); });
    await settle();
    expect(hooks.draftWrites).toHaveLength(1);
    expect(hooks.draftWrites[0]!.runId).toBe(RUN_ID);
    expect(hooks.draftWrites[0]!.drafts).toHaveLength(1);
    expect(hooks.draftWrites[0]!.drafts[0]!.qno).toBe('5');
  });

  it('识别失败不写回', async () => {
    renderWorkbench([pendingCard('c1')]);
    await settle();
    click(q('wb-recognize-c1'));
    await settle();
    act(() => { invokeGates.ai.forEach((r) => r({ ok: false, error: '模型超时', latencyMs: 1 })); });
    await settle();
    expect(hooks.draftWrites).toHaveLength(0);
  });
});

describe('0046 P3：黄条「去处理」跳转', () => {
  it('答案/解析皆空的卡：黄条带「去处理」按钮，点击展开答案区', async () => {
    renderWorkbench([questionCard('c1', { answerHtml: '', analysisHtml: '' })]);
    await settle();
    expect(q('wb-warn-c1')?.textContent).toContain('未识别到答案');
    expect(q('wb-warn-fix-c1')?.textContent).toContain('去处理');
    expect(q('wb-ans-area-c1')).toBeNull();
    click(q('wb-warn-fix-c1'));
    await settle();
    expect(q('wb-ans-area-c1')).toBeTruthy();
  });

  it('图块未确认的卡：点击「去处理」→ 左栏对应图块框闪烁定位', async () => {
    renderWorkbench([questionCard('c1', {
      figures: [{ ref: '图1', pageNo: 1, bbox: [0.1, 0.1, 0.5, 0.4], adjusted: false }],
      contentHtml: '<div class="question"><p>题干</p><figure class="diagram" data-align="center" data-w="320" data-h="200"><img class="q-figure" src="data:image/png;base64,QUJD"></figure></div>',
    })]);
    await settle();
    expect(q('wb-warn-fix-c1')).toBeTruthy();
    click(q('wb-warn-fix-c1'));
    await settle();
    const mark = q('wb-figure-c1-0');
    expect(mark).toBeTruthy();
    expect(mark!.className).toContain('wb-fig-flash');
  });

  it('目检返工②：点「出知识节点建议」→ 生成中读条出现，建议返回后读条撤、chips 就位', async () => {
    renderWorkbench([questionCard('c1')]);
    await settle();
    expect(q('wb-tree-prog-c1')).toBeNull();
    click(q('wb-tree-suggest-btn-c1'));
    await settle();
    expect(q('wb-tree-prog-c1')?.textContent).toContain('知识节点建议生成中');
    // 放行建议结果（0024 锚点链返回一条建议）
    act(() => {
      invokeGates.treeForDraft.forEach((resolve) => resolve({
        status: 'ok', reason: null,
        meta: { stage: '初中', subjectId: 'subj:physics', questionCount: 1, treeCount: 1, totalNodeCount: 5, injectedNodeCount: 5, truncatedNodeCount: 0, injectedTokens: 100 },
        warnings: [], none: false,
        suggestions: [{ questionId: 'draft-1', kind: 'tree-node', targetId: 'n-floating', targetLabel: '力学 > 浮力', confidence: 0.86, evidenceSummary: '题目' }],
        tagSuggestions: [], drafts: [], duplicates: [], latencyMs: 100,
      }));
    });
    await settle();
    expect(q('wb-tree-prog-c1')).toBeNull();
    expect(q('wb-tree-suggest-c1-n-floating')?.textContent).toContain('浮力');
  });
});
