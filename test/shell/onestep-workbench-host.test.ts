// 0040 P1：工作台宿主 + 通道 handler 测试。
// - RecogHost.loadWorkbench/saveWorkbench（真文件系统 tmp 隔离；run 目录即工作台文件态）
// - recog.workbench.load/save 通道注册、通道名逐字、payload 形验、透传
// - ai.suggest.treeForDraft 通道注册与形验

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
  },
  BrowserWindow: class {},
  dialog: {},
  safeStorage: { isEncryptionAvailable: () => false },
}));

import { RecogHost } from '../../src/shell/recog/recog-host.js';
import { registerAiSuggestIpcHandlers, registerRecogIpcHandlers } from '../../src/shell/ipc.js';
import { IPC_CHANNELS } from '../../src/shared/contracts/ipc-channels.js';
import type { AiSuggestHost } from '../../src/shell/ai/suggest-host.js';
import type { RecogEventPayload, RecogRun, RecogRunService } from '../../src/shared/contracts/recog-run-types.js';
import type { WorkbenchState } from '../../src/shared/contracts/onestep-types.js';

const NOW = '2026-09-19T10:00:00.000Z';

function makeRunsService(runId: string): RecogRunService {
  const run: RecogRun = {
    id: runId, status: 'done', stage: 'done', sourceKind: 'image', sourceName: null,
    pageCount: 1, pagesDone: 1, error: null, warnings: [], questionIds: [],
    createdAt: NOW, updatedAt: NOW, finishedAt: NOW,
  };
  return {
    createRun: async () => run,
    getRun: async (id) => (id === runId ? run : null),
    listRuns: async () => [run],
    setStatus: async () => run,
    listPages: async () => [],
    markPage: async () => undefined,
    setWarnings: async () => run,
    attachQuestions: async () => run,
  };
}

function makeState(runId: string): WorkbenchState {
  return {
    version: 1, runId, mode: 'auto', stage: '初中', subjectId: 'subj:physics', paperTitle: '浮力练习',
    pages: [{ pageNo: 1, name: 'p001.png', width: 1200, height: 1600 }],
    cards: [], nextSeq: 1, updatedAt: NOW,
  };
}

let root = '';
let host: RecogHost;
const RUN_ID = 'run-0040';

beforeEach(() => {
  handlers.clear();
  root = mkdtempSync(join(tmpdir(), 'mofang-0040-host-'));
  mkdirSync(join(root, RUN_ID), { recursive: true });
  const emitted: RecogEventPayload[] = [];
  void emitted;
  host = new RecogHost({
    runs: makeRunsService(RUN_ID),
    invoke: async () => ({ ok: false, error: '未脚本化', latencyMs: 0 }),
    runsRoot: root,
    broadcast: () => undefined,
    now: () => NOW,
  });
});

afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('0040 P1：RecogHost 工作台文件态', () => {
  it('首次进入（无 workbench.json）→ load 返回 null', async () => {
    expect(await host.loadWorkbench({ runId: RUN_ID })).toBeNull();
  });

  it('save → load 往返语义一致（run 目录 workbench.json）', async () => {
    const state = makeState(RUN_ID);
    const saved = await host.saveWorkbench({ runId: RUN_ID, state });
    expect(saved.savedAt).toBe(NOW);
    const loaded = await host.loadWorkbench({ runId: RUN_ID });
    expect(loaded?.runId).toBe(RUN_ID);
    expect(loaded?.paperTitle).toBe('浮力练习');
    expect(loaded?.updatedAt).toBe(NOW);
  });

  it('未知 run → 拒绝（不静默建目录）', async () => {
    await expect(host.loadWorkbench({ runId: 'nope' })).rejects.toThrow(/不存在/);
    await expect(host.saveWorkbench({ runId: 'nope', state: makeState('nope') })).rejects.toThrow(/不存在/);
  });

  it('卡流状态完整往返（含题卡 HTML 与采纳态）', async () => {
    const state = makeState(RUN_ID);
    state.cards = [{
      id: 'c1', status: 'question', source: 'ai', checked: true, frames: [],
      error: null, qno: '2-17', typeCode: '填空',
      contentHtml: '<div class="question"><p>甲</p></div>', answerHtml: '<p>B</p>', analysisHtml: '',
      figures: [{ ref: '图1', pageNo: 1, bbox: [0.1, 0.2, 0.3, 0.4], adjusted: true }],
      figureSource: 'dso', warnings: ['w'], tags: ['浮力'], adoptedTags: ['浮力'],
      treeSuggestions: [{ nodeId: 'n1', label: '力学 > 浮力', confidence: null }],
      adoptedNode: { nodeId: 'n1', label: '力学 > 浮力' }, committedQuestionId: null,
    }];
    state.nextSeq = 2;
    await host.saveWorkbench({ runId: RUN_ID, state });
    const loaded = await host.loadWorkbench({ runId: RUN_ID });
    expect(loaded?.cards).toEqual(state.cards);
  });
});

describe('0040 P1：recog.workbench.* 通道', () => {
  it('通道名逐字（契约不许漂移）', () => {
    expect(IPC_CHANNELS.RECOG_WORKBENCH_LOAD).toBe('recog.workbench.load');
    expect(IPC_CHANNELS.RECOG_WORKBENCH_SAVE).toBe('recog.workbench.save');
    expect(IPC_CHANNELS.AI_SUGGEST_TREE_FOR_DRAFT).toBe('ai.suggest.treeForDraft');
  });

  it('load：缺 runId / 非字符串 → 拒绝', async () => {
    registerRecogIpcHandlers(() => host);
    const fn = handlers.get(IPC_CHANNELS.RECOG_WORKBENCH_LOAD)!;
    await expect(fn(null, {})).rejects.toThrow(/runId/);
    await expect(fn(null, { runId: '' })).rejects.toThrow(/runId/);
    await expect(fn(null, null)).rejects.toThrow(/payload/);
  });

  it('save：state.runId 与 payload.runId 不一致 → 拒绝（防串档写坏别的 run）', async () => {
    registerRecogIpcHandlers(() => host);
    const fn = handlers.get(IPC_CHANNELS.RECOG_WORKBENCH_SAVE)!;
    await expect(fn(null, { runId: RUN_ID, state: makeState('other') })).rejects.toThrow(/须与 payload.runId 一致/);
  });

  it('save：state.cards 非数组 → 拒绝', async () => {
    registerRecogIpcHandlers(() => host);
    const fn = handlers.get(IPC_CHANNELS.RECOG_WORKBENCH_SAVE)!;
    const bad = { ...makeState(RUN_ID), cards: 'nope' };
    await expect(fn(null, { runId: RUN_ID, state: bad })).rejects.toThrow(/cards/);
  });

  it('save/load：合法 payload 透传宿主', async () => {
    registerRecogIpcHandlers(() => host);
    const saveFn = handlers.get(IPC_CHANNELS.RECOG_WORKBENCH_SAVE)!;
    const loadFn = handlers.get(IPC_CHANNELS.RECOG_WORKBENCH_LOAD)!;
    await saveFn(null, { runId: RUN_ID, state: makeState(RUN_ID) });
    const loaded = (await loadFn(null, { runId: RUN_ID })) as WorkbenchState | null;
    expect(loaded?.runId).toBe(RUN_ID);
  });
});

describe('0040 P1：ai.suggest.treeForDraft 通道', () => {
  function makeSuggestHost() {
    return {
      treeForDraft: vi.fn(async () => ({ status: 'ok' })),
      anchorStatus: vi.fn(), suggestTree: vi.fn(), suggestTags: vi.fn(),
    } as unknown as AiSuggestHost;
  }

  it('注册齐备且形验：stemText 必填', async () => {
    const suggest = makeSuggestHost();
    registerAiSuggestIpcHandlers(() => suggest);
    const fn = handlers.get(IPC_CHANNELS.AI_SUGGEST_TREE_FOR_DRAFT)!;
    expect(fn).toBeDefined();
    await expect(fn(null, { subjectId: 'subj:physics' })).rejects.toThrow(/stemText/);
    await expect(fn(null, { subjectId: 'subj:physics', stemText: '' })).rejects.toThrow(/stemText/);
  });

  // 2026-09-20 返工⑥：学科未定是合法起步态——形验不再把它打成「Invalid payload. subjectId」，
  // 具体原因由业务层给（suggest-host 的「挂树建议需要学科范围」）
  it('学科缺省/空串 → 形验放行，空学科透传业务层', async () => {
    const suggest = makeSuggestHost();
    registerAiSuggestIpcHandlers(() => suggest);
    const fn = handlers.get(IPC_CHANNELS.AI_SUGGEST_TREE_FOR_DRAFT)!;
    await fn(null, { stemText: '木块在水平面滑动' });
    expect(suggest.treeForDraft).toHaveBeenCalledWith({ subjectId: '', stemText: '木块在水平面滑动' });
    await fn(null, { subjectId: '', stemText: '甲' });
    expect(suggest.treeForDraft).toHaveBeenLastCalledWith({ subjectId: '', stemText: '甲' });
  });

  it('透传：stage 缺省不下发（走不限学段口径）', async () => {
    const suggest = makeSuggestHost();
    registerAiSuggestIpcHandlers(() => suggest);
    const fn = handlers.get(IPC_CHANNELS.AI_SUGGEST_TREE_FOR_DRAFT)!;
    await fn(null, { subjectId: 'subj:physics', stemText: '木块在水平面滑动' });
    expect(suggest.treeForDraft).toHaveBeenCalledWith({ subjectId: 'subj:physics', stemText: '木块在水平面滑动' });
    await fn(null, { subjectId: 'subj:physics', stemText: '甲', stage: '初中' });
    expect(suggest.treeForDraft).toHaveBeenLastCalledWith({ subjectId: 'subj:physics', stemText: '甲', stage: '初中' });
  });
});
