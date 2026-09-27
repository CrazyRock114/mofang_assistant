// 0044 P3：录题台「存为试卷」双出口 + 弹层测试（视图三/视图二）。
// 覆盖：双出口按钮存在性、弹层默认名=来源文件名可改（paperTitle → run sourceName → 兜底）、
// 树选择器默认折叠/点击展开（D-063）、按钮仅「取消/保存」（D-061⑩）、保存走 recog.saveAsPaper
// 且题卡落锁定态、取消不产生调用、语义说明在框内。服务注入假桥（不摸真 IPC）。
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { act } from 'react';

import type { MofangAiBridge, MofangRecogBridge, MofangSplitBridge } from '../../src/shared/contracts/bridge.js';
import type { BankExtServices, BankService } from '../../src/shared/contracts/bank-types.js';
import type { RecogRun, RecogRunDetail } from '../../src/shared/contracts/recog-run-types.js';
import type { RecogSaveAsPaperPayload, RecogSaveAsPaperResult } from '../../src/shared/contracts/ipc-channels.js';
import type { WorkbenchState } from '../../src/shared/contracts/onestep-types.js';
import { createMockExtServices } from '../../src/bank/mock/mock-ext.js';
import { MockBankStore } from '../../src/bank/mock/mock-store.js';
import { MockBankService } from '../../src/bank/mock/mock-bank.js';

import { WorkbenchPage } from '../../src/app/pages/WorkbenchPage.js';

const RUN_ID = 'run-0044-1';

function makeCard(id: string, qno: string, checked: boolean): WorkbenchState['cards'][number] {
  return {
    id,
    status: 'question',
    source: 'ai',
    checked,
    frames: [{ id: `${id}-f1`, pageNo: 1, rect: { x: 0.1, y: 0.1, w: 0.8, h: 0.3 } }],
    error: null,
    qno,
    typeCode: '',
    contentHtml: `<div class="question"><p>第 ${qno} 题题干</p></div>`,
    answerHtml: '<p>A</p>',
    analysisHtml: '',
    figures: [],
    figureSource: 'dso',
    warnings: [],
    tags: [],
    adoptedTags: qno === '1' ? ['期中'] : [],
    treeSuggestions: [],
    adoptedNode: qno === '1' ? { nodeId: 'node-9', label: '浮力' } : null,
    committedQuestionId: null,
  };
}

/** 0047：已入库卡（普通「入库」路径：只有 committedQuestionId，无所属卷） */
function makeCommittedCard(id: string, qno: string, questionId: string): WorkbenchState['cards'][number] {
  return { ...makeCard(id, qno, false), status: 'committed', committedQuestionId: questionId };
}

function makeState(paperTitle: string, cards: WorkbenchState['cards']): WorkbenchState {
  return {
    version: 1,
    runId: RUN_ID,
    mode: 'auto',
    stage: '',
    subjectId: '',
    paperTitle,
    pages: [],
    cards,
    nextSeq: cards.length + 1,
    updatedAt: '2026-09-20T10:00:00Z',
  };
}

function makeRecog(overrides: {
  state?: WorkbenchState | null;
  runSourceName?: string;
  saveAsPaper?: (payload: RecogSaveAsPaperPayload) => Promise<RecogSaveAsPaperResult>;
  failSaveAsPaper?: boolean;
}): { bridge: MofangRecogBridge; savePayloads: RecogSaveAsPaperPayload[]; savedStates: WorkbenchState[] } {
  const savePayloads: RecogSaveAsPaperPayload[] = [];
  const savedStates: WorkbenchState[] = [];
  let state = overrides.state ?? null;
  const bridge: MofangRecogBridge = {
    create: async () => { throw new Error('not used'); },
    status: async (): Promise<RecogRunDetail> => ({
      run: {
        id: RUN_ID, status: 'done', stage: 'done', sourceKind: 'image',
        sourceName: overrides.runSourceName ?? null,
        pageCount: 1, pagesDone: 1, error: null, warnings: [], questionIds: [],
        createdAt: '2026-09-20T09:00:00Z', updatedAt: '2026-09-20T10:00:00Z', finishedAt: '2026-09-20T10:00:00Z',
      } satisfies RecogRun,
      pages: [],
    }),
    cancel: async () => { throw new Error('not used'); },
    history: async () => [],
    attachQuestions: async (payload): Promise<RecogRun> => ({
      id: payload.runId, status: 'done', stage: 'done', sourceKind: 'image', sourceName: null,
      pageCount: 1, pagesDone: 1, error: null, warnings: [], questionIds: payload.questionIds,
      createdAt: '', updatedAt: '', finishedAt: null,
    }),
    resume: async () => { throw new Error('not used'); },
    onEvent: () => () => undefined,
    workbench: {
      load: async (): Promise<WorkbenchState | null> => state,
      save: async (payload) => {
        state = payload.state;
        savedStates.push(payload.state);
        return { savedAt: '2026-09-20T10:00:00Z' };
      },
    },
    saveAsPaper: async (payload) => {
      if (overrides.failSaveAsPaper) throw new Error('simulated orchestration failure');
      savePayloads.push(payload);
      return { paperId: 'paper-1', questionIds: payload.cards.map((_c, i) => `q-${i + 1}`) };
    },
  };
  return { bridge, savePayloads, savedStates };
}

function makeAi(): MofangAiBridge {
  return {
    profile: {
      list: async () => [],
      create: async () => { throw new Error('not used'); },
      update: async () => { throw new Error('not used'); },
      delete: async () => undefined,
      setEnabled: async () => { throw new Error('not used'); },
      testConnection: async () => { throw new Error('not used'); },
    },
    invoke: async () => { throw new Error('not used'); },
    models: { list: async () => ({ models: [] }) },
    suggest: {
      anchorStatus: async () => { throw new Error('not used'); },
      treeLink: async () => { throw new Error('not used'); },
      tags: async () => { throw new Error('not used'); },
      treeForDraft: async () => ({ status: 'unavailable', reason: 'no profile' }),
    },
  } as unknown as MofangAiBridge;
}

function makeSplit(): MofangSplitBridge {
  const reject = async (): Promise<never> => { throw new Error('not used'); };
  return {
    createProject: reject, appendSource: reject, readSource: reject, saveMeta: reject,
    saveDraft: reject, listProjects: async () => [], openProject: reject,
    removeProject: reject, writePage: reject, readPage: async () => ({ dataBase64: null, width: 0, height: 0 }),
  } as unknown as MofangSplitBridge;
}

describe('0044 录题台双出口 + 存为试卷弹层', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let bank: BankService;
  let ext: BankExtServices;

  beforeEach(() => {
    const store = new MockBankStore();
    bank = new MockBankService(store, false);
    ext = createMockExtServices(store);
  });

  afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    container?.remove();
    window.location.hash = '';
  });

  async function renderWorkbench(recog: MofangRecogBridge, defaults: { stage: string; subjectId: string; paperTitle: string }) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      flushSync(() => root!.render(
        <WorkbenchPage
          runId={RUN_ID}
          recog={recog}
          ai={makeAi()}
          bank={bank}
          ext={ext}
          split={makeSplit()}
          files={[]}
          defaults={defaults}
        />,
      ));
      await new Promise((r) => setTimeout(r, 30));
    });
    await act(async () => {
      flushSync(() => root!.render(
        <WorkbenchPage
          runId={RUN_ID}
          recog={recog}
          ai={makeAi()}
          bank={bank}
          ext={ext}
          split={makeSplit()}
          files={[]}
          defaults={defaults}
        />,
      ));
      await new Promise((r) => setTimeout(r, 30));
    });
  }

  function $testid(id: string): HTMLElement | null {
    return container.querySelector(`[data-testid="${id}"]`);
  }

  const nativeInputValue = (el: HTMLInputElement, v: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };

  // 0053 目检返工③（用户拍板）：「存为试卷」按钮去箭头与题数，文案恒为「存为试卷」
  it('双出口存在性：批量条同时含「入库（2）」与「存为试卷」（视图三）', async () => {
    const recog = makeRecog({ state: makeState('来源卷.pdf', [makeCard('c1', '1', true), makeCard('c2', '2', true)]) }).bridge;
    await renderWorkbench(recog, { stage: '', subjectId: '', paperTitle: '' });
    expect($testid('wb-batch-commit')?.textContent).toContain('入库（2）');
    expect($testid('wb-save-as-paper')?.textContent).toBe('存为试卷');
  });

  it('弹层：默认名=来源文件名可改；树选择器默认折叠、点字段展开（D-063）；按钮仅「取消/保存」（D-061⑩）', async () => {
    const recog = makeRecog({ state: makeState('2024 秋季期中卷.pdf', [makeCard('c1', '1', true), makeCard('c2', '2', true)]) }).bridge;
    await renderWorkbench(recog, { stage: '', subjectId: '', paperTitle: '' });
    await act(async () => {
      $testid('wb-save-as-paper')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      // 弹层在默认名兜底（recog.status）就绪后异步打开，等一拍
      await new Promise((r) => setTimeout(r, 20));
    });
    // 默认名 = workbench paperTitle（来源文件名）
    const title = $testid('wb-save-as-paper-title') as HTMLInputElement;
    expect(title.value).toBe('2024 秋季期中卷.pdf');
    // 可改
    act(() => { nativeInputValue(title, '改过的卷名'); });
    expect(($testid('wb-save-as-paper-title') as HTMLInputElement).value).toBe('改过的卷名');
    // 树选择器默认折叠
    expect($testid('folder-tree-picker-pop')).toBeNull();
    act(() => { $testid('folder-tree-picker-field')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect($testid('folder-tree-picker-pop')).not.toBeNull();
    expect($testid('folder-tree-pick-uncategorized')).not.toBeNull();
    expect($testid('folder-tree-new')).not.toBeNull();
    // 语义说明在框内
    expect($testid('wb-save-as-paper-note')?.textContent).toContain('录入题库');
    expect($testid('wb-save-as-paper-note')?.textContent).toContain('可排版的试卷');
    // 按钮仅「取消 / 保存」两个
    const modal = $testid('wb-save-as-paper-modal')!;
    const buttons = Array.from(modal.querySelectorAll('button')).map((b) => b.textContent?.trim());
    expect(buttons).toEqual(['取消', '保存']);
  });

  it('保存：走 recog.saveAsPaper 一步编排（保序 + 采纳透传）、题卡落锁定态、弹层关闭、留在工作台', async () => {
    const recog = makeRecog({
      state: makeState('来源卷.pdf', [makeCard('c1', '1', true), makeCard('c2', '2', true), makeCard('c3', '3', false)]),
    });
    await renderWorkbench(recog.bridge, { stage: '', subjectId: '', paperTitle: '' });
    await act(async () => {
      $testid('wb-save-as-paper')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      // 弹层在默认名兜底（recog.status）就绪后异步打开，等一拍
      await new Promise((r) => setTimeout(r, 20));
    });
    const title = $testid('wb-save-as-paper-title') as HTMLInputElement;
    act(() => { nativeInputValue(title, '我的试卷'); });
    await act(async () => { $testid('wb-save-as-paper-save')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    // 编排入参：只含勾选卡（c1/c2，c3 未勾不进）、保题卡序、挂树/标签沿用
    expect(recog.savePayloads).toHaveLength(1);
    const payload = recog.savePayloads[0]!;
    expect(payload.runId).toBe(RUN_ID);
    expect(payload.title).toBe('我的试卷');
    expect(payload.cards.map((c) => c.qno)).toEqual(['1', '2']);
    expect(payload.cards[0]?.adoptedNode?.nodeId).toBe('node-9');
    expect(payload.cards[0]?.adoptedTags).toEqual(['期中']);
    expect(payload.cards[1]?.adoptedNode).toBeNull();
    // 已存题卡落锁定态（wb-committed-<id>），未勾卡不受影响；留在工作台（无跳转）
    expect($testid('wb-committed-c1')).not.toBeNull();
    expect($testid('wb-committed-c2')).not.toBeNull();
    expect($testid('wb-committed-c3')).toBeNull();
    expect($testid('wb-save-as-paper-modal')).toBeNull();
    expect(window.location.hash).toBe('');
    // toast 提示可去「试卷管理」继续排版
    expect(container.textContent).toContain('试卷管理');
  });

  it('取消：弹层关闭且不产生 saveAsPaper 调用；失败口径：题卡状态不变可重试', async () => {
    const recog = makeRecog({ state: makeState('', [makeCard('c1', '1', true)]) });
    await renderWorkbench(recog.bridge, { stage: '', subjectId: '', paperTitle: '' });
    await act(async () => {
      $testid('wb-save-as-paper')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      // 弹层在默认名兜底（recog.status）就绪后异步打开，等一拍
      await new Promise((r) => setTimeout(r, 20));
    });
    // paperTitle 空 → 默认名回落 run sourceName（fake 返回 null）→ 兜底「未命名试卷」
    expect(($testid('wb-save-as-paper-title') as HTMLInputElement).value).toBe('未命名试卷');
    act(() => { $testid('wb-save-as-paper-cancel')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect($testid('wb-save-as-paper-modal')).toBeNull();
    expect(recog.savePayloads).toHaveLength(0);

    // 失败重试口径
    const failing = makeRecog({ state: makeState('', [makeCard('c1', '1', true)]), failSaveAsPaper: true });
    await renderWorkbench(failing.bridge, { stage: '', subjectId: '', paperTitle: '' });
    await act(async () => {
      $testid('wb-save-as-paper')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      // 弹层在默认名兜底（recog.status）就绪后异步打开，等一拍
      await new Promise((r) => setTimeout(r, 20));
    });
    await act(async () => { $testid('wb-save-as-paper-save')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    // 题卡状态不变（仍 question、可勾选可重试），错误可见，弹层仍开
    expect($testid('wb-committed-c1')).toBeNull();
    expect(container.textContent).toContain('存为试卷失败');
    expect($testid('wb-save-as-paper-modal')).not.toBeNull();
    void vi;
  });

  // ==================================================================
  // 0047：「存为试卷」链题卡撤销入库静默无效（先摘卷再删题）
  // ==================================================================

  /** 打开弹层 → 保存（存为试卷成功路径的公共前段） */
  async function saveAsPaperViaModal(): Promise<void> {
    await act(async () => {
      $testid('wb-save-as-paper')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 20));
    });
    await act(async () => { $testid('wb-save-as-paper-save')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  }

  /** 点「存草稿」立即 flush 落盘，再从 savedStates 读回题卡真身（不靠时序猜）
   *  0053 目检返工：存草稿按钮已退役（录题状态本就防抖实时保存）——改用卸载触发 use-workbench 的 flush 兜底 */
  async function savedCards(persisted: WorkbenchState[]): Promise<WorkbenchState['cards']> {
    await act(async () => { root?.unmount(); });
    root = null;
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    const last = persisted.at(-1);
    expect(last).toBeDefined();
    return (last as WorkbenchState).cards;
  }

  it('0047 存为试卷成功后：题卡 committedQuestionId=真实题 id、committedPaperId=卷 id（修复前为 null 的 RED 点）', async () => {
    const recog = makeRecog({
      state: makeState('来源卷.pdf', [makeCard('c1', '1', true), makeCard('c2', '2', true)]),
    });
    await renderWorkbench(recog.bridge, { stage: '', subjectId: '', paperTitle: '' });
    await saveAsPaperViaModal();
    const cards = await savedCards(recog.savedStates);
    const c1 = cards.find((c) => c.id === 'c1');
    const c2 = cards.find((c) => c.id === 'c2');
    // questionIds 按题卡序一一对应（c1→q-1、c2→q-2），卷 id=paper-1
    expect(c1?.status).toBe('committed');
    expect(c1?.committedQuestionId).toBe('q-1');
    expect(c1?.committedPaperId).toBe('paper-1');
    expect(c2?.committedQuestionId).toBe('q-2');
    expect(c2?.committedPaperId).toBe('paper-1');
  });

  it('0047 撤销（存为试卷链）：先摘卷后删题、入参逐项精确、题卡解锁且 committedPaperId 清空', async () => {
    const recog = makeRecog({ state: makeState('来源卷.pdf', [makeCard('c1', '1', true)]) });
    await renderWorkbench(recog.bridge, { stage: '', subjectId: '', paperTitle: '' });
    await saveAsPaperViaModal();
    expect($testid('wb-committed-c1')).not.toBeNull();

    const order: string[] = [];
    const removed: Array<[string, string]> = [];
    const deleted: string[] = [];
    vi.spyOn(bank, 'removeQuestion').mockImplementation(async (paperId, questionId) => {
      order.push('removeQuestion');
      removed.push([paperId, questionId]);
    });
    vi.spyOn(bank, 'deleteQuestion').mockImplementation(async (id) => {
      order.push('deleteQuestion');
      deleted.push(id);
    });

    // ConfirmButton 两步：首点进入确认态，再点执行
    await act(async () => { $testid('wb-uncommit-c1')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { $testid('wb-uncommit-c1')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(removed).toEqual([['paper-1', 'q-1']]);
    expect(deleted).toEqual(['q-1']);
    expect(order).toEqual(['removeQuestion', 'deleteQuestion']);
    // 题卡解锁回可编辑态
    expect($testid('wb-uncommit-c1')).toBeNull();
    expect($testid('wb-committed-c1')).toBeNull();
    expect($testid('wb-commit-c1')).not.toBeNull();
    // committedPaperId 清空
    const cards = await savedCards(recog.savedStates);
    const c1 = cards.find((c) => c.id === 'c1');
    expect(c1?.status).toBe('question');
    expect(c1?.committedQuestionId).toBeNull();
    expect(c1?.committedPaperId ?? null).toBeNull();
  });

  it('0047 撤销（存为试卷链）：摘卷失败 → 中止、题不删、报错可见、题卡仍锁定', async () => {
    const recog = makeRecog({ state: makeState('来源卷.pdf', [makeCard('c1', '1', true)]) });
    await renderWorkbench(recog.bridge, { stage: '', subjectId: '', paperTitle: '' });
    await saveAsPaperViaModal();

    vi.spyOn(bank, 'removeQuestion').mockImplementation(async () => {
      throw new Error('simulated detach failure');
    });
    const del = vi.spyOn(bank, 'deleteQuestion').mockImplementation(async () => undefined);

    await act(async () => { $testid('wb-uncommit-c1')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { $testid('wb-uncommit-c1')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(del).not.toHaveBeenCalled();
    expect(container.textContent).toContain('撤销入库失败');
    expect(container.textContent).toContain('simulated detach failure');
    // 题卡保持锁定（可再试）
    expect($testid('wb-committed-c1')).not.toBeNull();
    const cards = await savedCards(recog.savedStates);
    const c1 = cards.find((c) => c.id === 'c1');
    expect(c1?.status).toBe('committed');
    expect(c1?.committedQuestionId).toBe('q-1');
    expect(c1?.committedPaperId).toBe('paper-1');
  });

  it('0047 回归：普通「入库」卡撤销不调 removeQuestion，行为与现状一致', async () => {
    const recog = makeRecog({ state: makeState('来源卷.pdf', [makeCommittedCard('c1', '1', 'q-plain')]) });
    await renderWorkbench(recog.bridge, { stage: '', subjectId: '', paperTitle: '' });
    expect($testid('wb-committed-c1')).not.toBeNull();

    const remove = vi.spyOn(bank, 'removeQuestion').mockImplementation(async () => undefined);
    const deleted: string[] = [];
    vi.spyOn(bank, 'deleteQuestion').mockImplementation(async (id) => { deleted.push(id); });

    await act(async () => { $testid('wb-uncommit-c1')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { $testid('wb-uncommit-c1')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(remove).not.toHaveBeenCalled();
    expect(deleted).toEqual(['q-plain']);
    expect($testid('wb-committed-c1')).toBeNull();
    expect($testid('wb-commit-c1')).not.toBeNull();
    const cards = await savedCards(recog.savedStates);
    const c1 = cards.find((c) => c.id === 'c1');
    expect(c1?.status).toBe('question');
    expect(c1?.committedQuestionId).toBeNull();
  });
});
