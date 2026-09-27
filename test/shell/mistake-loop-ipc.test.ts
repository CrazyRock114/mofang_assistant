// 0025 P1/P2：通道接线测试
// 一、handler 层（mock ipcMain 层，模式照 test/shell/dict-tree-ipc.test.ts）：
//     12 条通道注册齐备 + payload 校验 + 透传 service（8 条既有 unwired 补线 + 4 条 0025 新增错题通道）
// 二、真桥全链（真 SQLite + 注册 handler + preload 形态桥 + IpcExtClient）：逐条真实调用、断言落库/到达 service；
//     聚合一条按任务书 §六.2 与手工 SQL 逐行核对。
// 说明：进程边界（ipcRenderer/contextBridge）在 node 环境下以「handler 注册表 → 桥方法」等价替身表达，
//       链路上其余各段（preload 白名单形态 / bridge 类型 / handler 校验 / service / SQLite）全为真实实现。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

import { registerExtIpcHandlers } from '../../src/shell/ipc.js';
import { IPC_CHANNELS } from '../../src/shared/contracts/ipc-channels.js';
import type { BankExtServices, BankService, MistakeAggregateRow } from '../../src/shared/contracts/bank-types.js';
import type { MofangBankExtBridge } from '../../src/shared/contracts/bridge.js';
import { openDatabase } from '../../src/bank/db.js';
import { BankServiceImpl } from '../../src/bank/bank-service.js';
import { createExtServices } from '../../src/bank/ext-services.js';
import { IpcExtClient } from '../../src/app/services/IpcExtClient.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '../../src/bank/migrations');

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`通道未注册: ${channel}`);
  return fn(null, ...args) as Promise<unknown>;
}

beforeEach(() => {
  handlers.clear();
});

// ==================== 一、handler 层：注册齐备 + 校验 + 透传 ====================

/** 只填被测通道所需方法；未实现方法调用即抛（测试自证只走被测路径） */
type FakeFn = ReturnType<typeof vi.fn>;
interface FakeExt {
  dict: { createEntry: FakeFn };
  tree: {
    createTree: FakeFn; createNode: FakeFn; linkQuestion: FakeFn;
    unlinkQuestion: FakeFn; resolveSourceNode: FakeFn;
  };
  paperSet: { removePaper: FakeFn; deletePaperSet: FakeFn };
  mistake: {
    aggregateByQuestion: FakeFn; deleteMistakes: FakeFn; setStages: FakeFn; exportQuestionIds: FakeFn;
  };
}

function makeFakeExt(): FakeExt {
  return {
    dict: {
      createEntry: vi.fn(async (data: { kind: string; code: string; label: string }) =>
        ({ id: `${data.kind}:${data.code}`, ...data, active: true })),
    },
    tree: {
      createTree: vi.fn(async (data: { name: string }) => ({ id: 'tree-new', name: data.name })),
      createNode: vi.fn(async (data: { treeId: string; name: string }) => ({ id: 'node-new', treeId: data.treeId, name: data.name, sort: 0 })),
      linkQuestion: vi.fn(async () => undefined),
      unlinkQuestion: vi.fn(async () => undefined),
      resolveSourceNode: vi.fn(async (site: string, siteNodeId: string) => ({ id: 'node-x', treeId: 'tree-x', name: `${site}:${siteNodeId}`, sort: 0 })),
    },
    paperSet: {
      removePaper: vi.fn(async () => undefined),
      deletePaperSet: vi.fn(async () => undefined),
    },
    mistake: {
      aggregateByQuestion: vi.fn(async (filter?: { stage?: string }) => [{ questionId: 'q1', wrongCount: 2, filter }]),
      deleteMistakes: vi.fn(async (ids: string[]) => ({ affectedCount: ids.length })),
      setStages: vi.fn(async (ids: string[], stage: string) => ({ affectedCount: ids.length, stage })),
      exportQuestionIds: vi.fn(async () => ['q1', 'q2']),
    },
  };
}

/** 被测通道只需子集方法；未用到的服务方法通过该转换占位（handler 层测试不触达） */
const asExtServices = (fake: FakeExt): BankExtServices => fake as unknown as BankExtServices;

const EIGHT_NEW_CHANNELS = [
  IPC_CHANNELS.DICT_CREATE,
  IPC_CHANNELS.PAPER_SET_DELETE,
  IPC_CHANNELS.PAPER_SET_REMOVE_PAPER,
  IPC_CHANNELS.TREE_CREATE,
  IPC_CHANNELS.TREE_CREATE_NODE,
  IPC_CHANNELS.TREE_LINK_QUESTION,
  IPC_CHANNELS.TREE_UNLINK_QUESTION,
  IPC_CHANNELS.TREE_RESOLVE_SOURCE_NODE,
];
const MISTAKE_LOOP_CHANNELS = [
  IPC_CHANNELS.MISTAKE_AGGREGATE,
  IPC_CHANNELS.MISTAKE_BATCH_DELETE,
  IPC_CHANNELS.MISTAKE_BATCH_SET_STAGE,
  IPC_CHANNELS.MISTAKE_EXPORT_QUESTION_IDS,
];

describe('0025 P2：8 条既有 unwired 通道补线 handler', () => {
  it('注册即齐备：DICT_CREATE + PAPER_SET_DELETE/REMOVE_PAPER + TREE 写 5 通道', () => {
    registerExtIpcHandlers(() => asExtServices(makeFakeExt()));
    EIGHT_NEW_CHANNELS.forEach((ch) => expect(handlers.has(ch)).toBe(true));
  });

  it('dict.create：合法 payload 透传 createEntry(data)', async () => {
    const fake = makeFakeExt();
    registerExtIpcHandlers(() => asExtServices(fake));
    const data = { kind: 'subject', code: 'physics', label: '物理' };
    const result = await invoke(IPC_CHANNELS.DICT_CREATE, { data });
    expect(fake.dict.createEntry).toHaveBeenCalledWith(data);
    expect(result).toMatchObject({ id: 'subject:physics' });
  });

  it.each([
    ['缺 payload', undefined],
    ['data 非对象', { data: 'bad' }],
    ['缺 kind', { data: { code: 'a', label: 'b' } }],
    ['kind 非法', { data: { kind: 'nope', code: 'a', label: 'b' } }],
    ['缺 code', { data: { kind: 'subject', label: 'b' } }],
    ['缺 label', { data: { kind: 'subject', code: 'a' } }],
  ])('dict.create 非法 payload %s → 拒绝', async (_name, payload) => {
    registerExtIpcHandlers(() => asExtServices(makeFakeExt()));
    await expect(invoke(IPC_CHANNELS.DICT_CREATE, payload)).rejects.toThrow(/Invalid/);
  });

  it('paper_set.removePaper：合法 payload 透传 removePaper(paperSetId, paperId)', async () => {
    const fake = makeFakeExt();
    registerExtIpcHandlers(() => asExtServices(fake));
    await invoke(IPC_CHANNELS.PAPER_SET_REMOVE_PAPER, { paperSetId: 'ps-1', paperId: 'p-1' });
    expect(fake.paperSet.removePaper).toHaveBeenCalledWith('ps-1', 'p-1');
  });

  it.each([
    ['缺 payload', undefined],
    ['缺 paperSetId', { paperId: 'p-1' }],
    ['缺 paperId', { paperSetId: 'ps-1' }],
  ])('paper_set.removePaper 非法 payload %s → 拒绝', async (_name, payload) => {
    registerExtIpcHandlers(() => asExtServices(makeFakeExt()));
    await expect(invoke(IPC_CHANNELS.PAPER_SET_REMOVE_PAPER, payload)).rejects.toThrow(/Invalid/);
  });

  it('paper_set.delete：合法 payload 透传 deletePaperSet(id)', async () => {
    const fake = makeFakeExt();
    registerExtIpcHandlers(() => asExtServices(fake));
    await invoke(IPC_CHANNELS.PAPER_SET_DELETE, { id: 'ps-1' });
    expect(fake.paperSet.deletePaperSet).toHaveBeenCalledWith('ps-1');
  });

  it.each([
    ['缺 payload', undefined],
    ['缺 id', {}],
    ['id 非字符串', { id: 1 }],
  ])('paper_set.delete 非法 payload %s → 拒绝', async (_name, payload) => {
    registerExtIpcHandlers(() => asExtServices(makeFakeExt()));
    await expect(invoke(IPC_CHANNELS.PAPER_SET_DELETE, payload)).rejects.toThrow(/Invalid/);
  });

  it('tree.createTree：合法 payload 透传 createTree(data)', async () => {
    const fake = makeFakeExt();
    registerExtIpcHandlers(() => asExtServices(fake));
    const data = { type: 'knowledge', name: '人教版·高中物理', subjectId: 'subj:phy' };
    await invoke(IPC_CHANNELS.TREE_CREATE, { data });
    expect(fake.tree.createTree).toHaveBeenCalledWith(data);
  });

  it.each([
    ['缺 payload', undefined],
    ['缺 name', { data: { type: 'knowledge' } }],
    ['type 非法', { data: { type: 'nope', name: 'x' } }],
    ['data 非对象', { data: 1 }],
  ])('tree.createTree 非法 payload %s → 拒绝', async (_name, payload) => {
    registerExtIpcHandlers(() => asExtServices(makeFakeExt()));
    await expect(invoke(IPC_CHANNELS.TREE_CREATE, payload)).rejects.toThrow(/Invalid/);
  });

  it('tree.createNode：合法 payload 透传 createNode(data)（含 sourceMapping）', async () => {
    const fake = makeFakeExt();
    registerExtIpcHandlers(() => asExtServices(fake));
    const data = { treeId: 'tree-1', parentId: 'node-0', name: '力学', sourceMapping: { site: 'zujuan', siteNodeId: 'n-9' } };
    await invoke(IPC_CHANNELS.TREE_CREATE_NODE, { data });
    expect(fake.tree.createNode).toHaveBeenCalledWith(data);
  });

  it.each([
    ['缺 payload', undefined],
    ['缺 treeId', { data: { name: '力学' } }],
    ['缺 name', { data: { treeId: 'tree-1' } }],
  ])('tree.createNode 非法 payload %s → 拒绝', async (_name, payload) => {
    registerExtIpcHandlers(() => asExtServices(makeFakeExt()));
    await expect(invoke(IPC_CHANNELS.TREE_CREATE_NODE, payload)).rejects.toThrow(/Invalid/);
  });

  it('tree.linkQuestion / unlinkQuestion：合法 payload 透传 (questionId, nodeId)', async () => {
    const fake = makeFakeExt();
    registerExtIpcHandlers(() => asExtServices(fake));
    await invoke(IPC_CHANNELS.TREE_LINK_QUESTION, { questionId: 'q-1', nodeId: 'n-1' });
    await invoke(IPC_CHANNELS.TREE_UNLINK_QUESTION, { questionId: 'q-1', nodeId: 'n-1' });
    expect(fake.tree.linkQuestion).toHaveBeenCalledWith('q-1', 'n-1');
    expect(fake.tree.unlinkQuestion).toHaveBeenCalledWith('q-1', 'n-1');
  });

  it.each([
    [IPC_CHANNELS.TREE_LINK_QUESTION],
    [IPC_CHANNELS.TREE_UNLINK_QUESTION],
  ])('%s 非法 payload → 拒绝', async (channel) => {
    registerExtIpcHandlers(() => asExtServices(makeFakeExt()));
    await expect(invoke(channel, { questionId: 'q-1' })).rejects.toThrow(/Invalid nodeId/);
    await expect(invoke(channel, { nodeId: 'n-1' })).rejects.toThrow(/Invalid questionId/);
  });

  it('tree.resolveSourceNode：合法 payload 透传 (site, siteNodeId)', async () => {
    const fake = makeFakeExt();
    registerExtIpcHandlers(() => asExtServices(fake));
    const result = await invoke(IPC_CHANNELS.TREE_RESOLVE_SOURCE_NODE, { site: 'zujuan', siteNodeId: 'n-9' });
    expect(fake.tree.resolveSourceNode).toHaveBeenCalledWith('zujuan', 'n-9');
    expect(result).toMatchObject({ id: 'node-x' });
  });

  it.each([
    ['缺 payload', undefined],
    ['缺 site', { siteNodeId: 'n-9' }],
    ['缺 siteNodeId', { site: 'zujuan' }],
  ])('tree.resolveSourceNode 非法 payload %s → 拒绝', async (_name, payload) => {
    registerExtIpcHandlers(() => asExtServices(makeFakeExt()));
    await expect(invoke(IPC_CHANNELS.TREE_RESOLVE_SOURCE_NODE, payload)).rejects.toThrow(/Invalid/);
  });
});

describe('0025 P1：4 条错题闭环新通道 handler', () => {
  it('注册即齐备：聚合/批量删/批量改档/题 id 导出', () => {
    registerExtIpcHandlers(() => asExtServices(makeFakeExt()));
    MISTAKE_LOOP_CHANNELS.forEach((ch) => expect(handlers.has(ch)).toBe(true));
  });

  it('mistake.aggregateByQuestion：filter 透传（缺省 undefined）', async () => {
    const fake = makeFakeExt();
    registerExtIpcHandlers(() => asExtServices(fake));
    await invoke(IPC_CHANNELS.MISTAKE_AGGREGATE, { filter: { stage: 'red', subject: '物理' } });
    expect(fake.mistake.aggregateByQuestion).toHaveBeenCalledWith({ stage: 'red', subject: '物理' });
    await invoke(IPC_CHANNELS.MISTAKE_AGGREGATE, undefined);
    expect(fake.mistake.aggregateByQuestion).toHaveBeenCalledWith(undefined);
  });

  it('mistake.batchDelete：ids 透传', async () => {
    const fake = makeFakeExt();
    registerExtIpcHandlers(() => asExtServices(fake));
    const result = await invoke(IPC_CHANNELS.MISTAKE_BATCH_DELETE, { ids: ['m-1', 'm-2'] });
    expect(fake.mistake.deleteMistakes).toHaveBeenCalledWith(['m-1', 'm-2']);
    expect(result).toEqual({ affectedCount: 2 });
  });

  it('mistake.batchSetStage：ids + stage 透传', async () => {
    const fake = makeFakeExt();
    registerExtIpcHandlers(() => asExtServices(fake));
    await invoke(IPC_CHANNELS.MISTAKE_BATCH_SET_STAGE, { ids: ['m-1'], stage: 'green' });
    expect(fake.mistake.setStages).toHaveBeenCalledWith(['m-1'], 'green');
  });

  it('mistake.exportQuestionIds：filter 透传，返回 id 集', async () => {
    const fake = makeFakeExt();
    registerExtIpcHandlers(() => asExtServices(fake));
    const result = await invoke(IPC_CHANNELS.MISTAKE_EXPORT_QUESTION_IDS, { filter: { subject: '物理' } });
    expect(fake.mistake.exportQuestionIds).toHaveBeenCalledWith({ subject: '物理' });
    expect(result).toEqual(['q1', 'q2']);
  });

  it.each([
    ['批次缺 ids', IPC_CHANNELS.MISTAKE_BATCH_DELETE, {}],
    ['批次 ids 非数组', IPC_CHANNELS.MISTAKE_BATCH_DELETE, { ids: 'm-1' }],
    ['批次 ids 空数组', IPC_CHANNELS.MISTAKE_BATCH_DELETE, { ids: [] }],
    ['批次 ids 含非字符串', IPC_CHANNELS.MISTAKE_BATCH_DELETE, { ids: ['m-1', 2] }],
    ['改档缺 stage', IPC_CHANNELS.MISTAKE_BATCH_SET_STAGE, { ids: ['m-1'] }],
    ['改档 stage 非法', IPC_CHANNELS.MISTAKE_BATCH_SET_STAGE, { ids: ['m-1'], stage: 'purple' }],
  ])('非法 payload %s → 拒绝且不触达 service', async (_name, channel, payload) => {
    const fake = makeFakeExt();
    registerExtIpcHandlers(() => asExtServices(fake));
    await expect(invoke(channel, payload)).rejects.toThrow(/Invalid/);
    expect(fake.mistake.deleteMistakes).not.toHaveBeenCalled();
    expect(fake.mistake.setStages).not.toHaveBeenCalled();
  });
});

// ==================== 二、真桥全链 ====================

describe('0025 真桥全链（真 SQLite + handler + preload 形态桥 + IpcExtClient）', () => {
  let tempDir = '';
  let db: ReturnType<typeof openDatabase> | null = null;
  let bank: BankService;
  let ext: BankExtServices;
  let client: IpcExtClient;

  beforeEach(() => {
    handlers.clear();
    tempDir = mkdtempSync(join(tmpdir(), 'mistake-loop-bridge-'));
    db = openDatabase(join(tempDir, 'test.db'), migrationsDir);
    bank = new BankServiceImpl(db);
    ext = createExtServices(db);
    registerExtIpcHandlers(() => ext);

    // preload 形态桥：每个方法体 = ipcRenderer.invoke(channel, payload) 的等价替身
    const bridge: MofangBankExtBridge = {
      dict: {
        list: (p) => invoke(IPC_CHANNELS.DICT_LIST, p) as ReturnType<MofangBankExtBridge['dict']['list']>,
        get: (p) => invoke(IPC_CHANNELS.DICT_GET, p) as ReturnType<MofangBankExtBridge['dict']['get']>,
        update: (p) => invoke(IPC_CHANNELS.DICT_UPDATE, p) as ReturnType<MofangBankExtBridge['dict']['update']>,
        create: (p) => invoke(IPC_CHANNELS.DICT_CREATE, p) as ReturnType<MofangBankExtBridge['dict']['create']>,
      },
      student: {
        create: (p) => invoke(IPC_CHANNELS.STUDENT_CREATE, p) as ReturnType<MofangBankExtBridge['student']['create']>,
        get: (p) => invoke(IPC_CHANNELS.STUDENT_GET, p) as ReturnType<MofangBankExtBridge['student']['get']>,
        list: (p) => invoke(IPC_CHANNELS.STUDENT_LIST, p) as ReturnType<MofangBankExtBridge['student']['list']>,
        update: (p) => invoke(IPC_CHANNELS.STUDENT_UPDATE, p) as ReturnType<MofangBankExtBridge['student']['update']>,
        setStatus: (p) => invoke(IPC_CHANNELS.STUDENT_SET_STATUS, p) as ReturnType<MofangBankExtBridge['student']['setStatus']>,
        enroll: (p) => invoke(IPC_CHANNELS.STUDENT_ENROLL, p) as ReturnType<MofangBankExtBridge['student']['enroll']>,
        endEnrollment: (p) => invoke(IPC_CHANNELS.STUDENT_END_ENROLLMENT, p) as ReturnType<MofangBankExtBridge['student']['endEnrollment']>,
        getClasses: (p) => invoke(IPC_CHANNELS.STUDENT_GET_CLASSES, p) as ReturnType<MofangBankExtBridge['student']['getClasses']>,
        addEvent: (p) => invoke(IPC_CHANNELS.STUDENT_ADD_EVENT, p) as ReturnType<MofangBankExtBridge['student']['addEvent']>,
        listEvents: (p) => invoke(IPC_CHANNELS.STUDENT_LIST_EVENTS, p) as ReturnType<MofangBankExtBridge['student']['listEvents']>,
      },
      class: {
        create: (p) => invoke(IPC_CHANNELS.CLASS_CREATE, p) as ReturnType<MofangBankExtBridge['class']['create']>,
        get: (p) => invoke(IPC_CHANNELS.CLASS_GET, p) as ReturnType<MofangBankExtBridge['class']['get']>,
        list: (p) => invoke(IPC_CHANNELS.CLASS_LIST, p) as ReturnType<MofangBankExtBridge['class']['list']>,
        update: (p) => invoke(IPC_CHANNELS.CLASS_UPDATE, p) as ReturnType<MofangBankExtBridge['class']['update']>,
      },
      exam: {
        create: (p) => invoke(IPC_CHANNELS.EXAM_CREATE, p) as ReturnType<MofangBankExtBridge['exam']['create']>,
        get: (p) => invoke(IPC_CHANNELS.EXAM_GET, p) as ReturnType<MofangBankExtBridge['exam']['get']>,
        list: (p) => invoke(IPC_CHANNELS.EXAM_LIST, p) as ReturnType<MofangBankExtBridge['exam']['list']>,
        recordScores: (p) => invoke(IPC_CHANNELS.EXAM_RECORD_SCORES, p) as ReturnType<MofangBankExtBridge['exam']['recordScores']>,
        getScores: (p) => invoke(IPC_CHANNELS.EXAM_GET_SCORES, p) as ReturnType<MofangBankExtBridge['exam']['getScores']>,
        getStudentScores: (p) => invoke(IPC_CHANNELS.EXAM_GET_STUDENT_SCORES, p) as ReturnType<MofangBankExtBridge['exam']['getStudentScores']>,
        recordResults: (p) => invoke(IPC_CHANNELS.EXAM_RECORD_RESULTS, p) as ReturnType<MofangBankExtBridge['exam']['recordResults']>,
      },
      mistake: {
        recordWrong: (p) => invoke(IPC_CHANNELS.MISTAKE_RECORD_WRONG, p) as ReturnType<MofangBankExtBridge['mistake']['recordWrong']>,
        get: (p) => invoke(IPC_CHANNELS.MISTAKE_GET, p) as ReturnType<MofangBankExtBridge['mistake']['get']>,
        list: (p) => invoke(IPC_CHANNELS.MISTAKE_LIST, p) as ReturnType<MofangBankExtBridge['mistake']['list']>,
        setStage: (p) => invoke(IPC_CHANNELS.MISTAKE_SET_STAGE, p) as ReturnType<MofangBankExtBridge['mistake']['setStage']>,
        cycleStage: (p) => invoke(IPC_CHANNELS.MISTAKE_CYCLE_STAGE, p) as ReturnType<MofangBankExtBridge['mistake']['cycleStage']>,
        setNote: (p) => invoke(IPC_CHANNELS.MISTAKE_SET_NOTE, p) as ReturnType<MofangBankExtBridge['mistake']['setNote']>,
        delete: (p) => invoke(IPC_CHANNELS.MISTAKE_DELETE, p) as ReturnType<MofangBankExtBridge['mistake']['delete']>,
        aggregateByQuestion: (p) => invoke(IPC_CHANNELS.MISTAKE_AGGREGATE, p) as ReturnType<MofangBankExtBridge['mistake']['aggregateByQuestion']>,
        batchDelete: (p) => invoke(IPC_CHANNELS.MISTAKE_BATCH_DELETE, p) as ReturnType<MofangBankExtBridge['mistake']['batchDelete']>,
        batchSetStage: (p) => invoke(IPC_CHANNELS.MISTAKE_BATCH_SET_STAGE, p) as ReturnType<MofangBankExtBridge['mistake']['batchSetStage']>,
        exportQuestionIds: (p) => invoke(IPC_CHANNELS.MISTAKE_EXPORT_QUESTION_IDS, p) as ReturnType<MofangBankExtBridge['mistake']['exportQuestionIds']>,
      },
      paperSet: {
        create: (p) => invoke(IPC_CHANNELS.PAPER_SET_CREATE, p) as ReturnType<MofangBankExtBridge['paperSet']['create']>,
        get: (p) => invoke(IPC_CHANNELS.PAPER_SET_GET, p) as ReturnType<MofangBankExtBridge['paperSet']['get']>,
        list: (p) => invoke(IPC_CHANNELS.PAPER_SET_LIST, p) as ReturnType<MofangBankExtBridge['paperSet']['list']>,
        addPaper: (p) => invoke(IPC_CHANNELS.PAPER_SET_ADD_PAPER, p) as ReturnType<MofangBankExtBridge['paperSet']['addPaper']>,
        removePaper: (p) => invoke(IPC_CHANNELS.PAPER_SET_REMOVE_PAPER, p) as ReturnType<MofangBankExtBridge['paperSet']['removePaper']>,
        getPapers: (p) => invoke(IPC_CHANNELS.PAPER_SET_GET_PAPERS, p) as ReturnType<MofangBankExtBridge['paperSet']['getPapers']>,
        getStudentPaper: (p) => invoke(IPC_CHANNELS.PAPER_SET_GET_STUDENT_PAPER, p) as ReturnType<MofangBankExtBridge['paperSet']['getStudentPaper']>,
        delete: (p) => invoke(IPC_CHANNELS.PAPER_SET_DELETE, p) as ReturnType<MofangBankExtBridge['paperSet']['delete']>,
      },
      paper: {
        updatePaperStatus: (p) => invoke(IPC_CHANNELS.PAPER_UPDATE_STATUS, p) as ReturnType<MofangBankExtBridge['paper']['updatePaperStatus']>,
        setLayoutConfig: (p) => invoke(IPC_CHANNELS.PAPER_SET_LAYOUT_CONFIG, p) as ReturnType<MofangBankExtBridge['paper']['setLayoutConfig']>,
        listPapersEx: (p) => invoke(IPC_CHANNELS.BANK_PAPER_LIST_EX, p) as ReturnType<MofangBankExtBridge['paper']['listPapersEx']>,
        getPaperEx: (p) => invoke(IPC_CHANNELS.BANK_PAPER_GET_EX, p) as ReturnType<MofangBankExtBridge['paper']['getPaperEx']>,
        snapshotPaperQuestions: (p) => invoke(IPC_CHANNELS.BANK_PAPER_SNAPSHOT, p) as ReturnType<MofangBankExtBridge['paper']['snapshotPaperQuestions']>,
        listPaperSnapshotQuestions: (p) => invoke(IPC_CHANNELS.BANK_PAPER_SNAPSHOT_LIST, p) as ReturnType<MofangBankExtBridge['paper']['listPaperSnapshotQuestions']>,
        clonePaperToBasket: (p) => invoke(IPC_CHANNELS.BANK_PAPER_CLONE_TO_BASKET, p) as ReturnType<MofangBankExtBridge['paper']['clonePaperToBasket']>,
        updatePaperTitle: (p) => invoke(IPC_CHANNELS.BANK_PAPER_UPDATE_TITLE, p) as ReturnType<MofangBankExtBridge['paper']['updatePaperTitle']>,
        setQuestionLayouts: (p) => invoke(IPC_CHANNELS.BANK_PAPER_SET_QUESTION_LAYOUTS, p) as ReturnType<MofangBankExtBridge['paper']['setQuestionLayouts']>,
      },
      preset: {
        create: (p) => invoke(IPC_CHANNELS.PRESET_CREATE, p) as ReturnType<MofangBankExtBridge['preset']['create']>,
        get: (p) => invoke(IPC_CHANNELS.PRESET_GET, p) as ReturnType<MofangBankExtBridge['preset']['get']>,
        list: (p) => invoke(IPC_CHANNELS.PRESET_LIST, p) as ReturnType<MofangBankExtBridge['preset']['list']>,
        update: (p) => invoke(IPC_CHANNELS.PRESET_UPDATE, p) as ReturnType<MofangBankExtBridge['preset']['update']>,
        delete: (p) => invoke(IPC_CHANNELS.PRESET_DELETE, p) as ReturnType<MofangBankExtBridge['preset']['delete']>,
      },
      tree: {
        listTrees: (p) => invoke(IPC_CHANNELS.TREE_LIST, p) as ReturnType<MofangBankExtBridge['tree']['listTrees']>,
        getNodes: (p) => invoke(IPC_CHANNELS.TREE_GET_NODES, p) as ReturnType<MofangBankExtBridge['tree']['getNodes']>,
        getDescendants: (p) => invoke(IPC_CHANNELS.TREE_GET_DESCENDANTS, p) as ReturnType<MofangBankExtBridge['tree']['getDescendants']>,
        getQuestionNodes: (p) => invoke(IPC_CHANNELS.TREE_GET_QUESTION_NODES, p) as ReturnType<MofangBankExtBridge['tree']['getQuestionNodes']>,
        getSourceMappings: (p) => invoke(IPC_CHANNELS.TREE_GET_SOURCE_MAPPINGS, p) as ReturnType<MofangBankExtBridge['tree']['getSourceMappings']>,
        createTree: (p) => invoke(IPC_CHANNELS.TREE_CREATE, p) as ReturnType<MofangBankExtBridge['tree']['createTree']>,
        createNode: (p) => invoke(IPC_CHANNELS.TREE_CREATE_NODE, p) as ReturnType<MofangBankExtBridge['tree']['createNode']>,
        linkQuestion: (p) => invoke(IPC_CHANNELS.TREE_LINK_QUESTION, p) as ReturnType<MofangBankExtBridge['tree']['linkQuestion']>,
        unlinkQuestion: (p) => invoke(IPC_CHANNELS.TREE_UNLINK_QUESTION, p) as ReturnType<MofangBankExtBridge['tree']['unlinkQuestion']>,
        resolveSourceNode: (p) => invoke(IPC_CHANNELS.TREE_RESOLVE_SOURCE_NODE, p) as ReturnType<MofangBankExtBridge['tree']['resolveSourceNode']>,
      },
      feedback: {
        create: (p) => invoke(IPC_CHANNELS.FEEDBACK_CREATE, p) as ReturnType<MofangBankExtBridge['feedback']['create']>,
        get: (p) => invoke(IPC_CHANNELS.FEEDBACK_GET, p) as ReturnType<MofangBankExtBridge['feedback']['get']>,
        list: (p) => invoke(IPC_CHANNELS.FEEDBACK_LIST, p) as ReturnType<MofangBankExtBridge['feedback']['list']>,
        update: (p) => invoke(IPC_CHANNELS.FEEDBACK_UPDATE, p) as ReturnType<MofangBankExtBridge['feedback']['update']>,
        delete: (p) => invoke(IPC_CHANNELS.FEEDBACK_DELETE, p) as ReturnType<MofangBankExtBridge['feedback']['delete']>,
      },
    };

    (globalThis as { window?: { __mofangBankExt?: MofangBankExtBridge } }).window = { __mofangBankExt: bridge };
    client = new IpcExtClient();
  });

  afterEach(() => {
    db?.close();
    db = null;
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = '';
  });

  it('8 条补线通道逐一真实调用并落库（renderer → 桥 → handler → service → SQLite）', async () => {
    const raw = db!;

    // 1) dict.create → dict_entries
    const entry = await client.dict.createEntry({ kind: 'subject', code: 'physics', label: '物理' });
    expect(entry.label).toBe('物理');
    expect(raw.prepare('SELECT label FROM dict_entries WHERE id = ?').get(entry.id)).toMatchObject({ label: '物理' });

    // 2) tree.createTree → trees
    const tree = await client.tree.createTree({ type: 'knowledge', name: '人教版·高中物理', subjectId: entry.id });
    expect(raw.prepare('SELECT name FROM trees WHERE id = ?').get(tree.id)).toMatchObject({ name: '人教版·高中物理' });

    // 3) tree.createNode（带 sourceMapping）→ tree_nodes + tree_source_map
    const node = await client.tree.createNode({
      treeId: tree.id, name: '力学', sourceMapping: { site: 'zujuan', siteNodeId: 'n-9', siteNodeName: '力学' },
    });
    expect(raw.prepare('SELECT name FROM tree_nodes WHERE id = ?').get(node.id)).toMatchObject({ name: '力学' });
    expect(raw.prepare('SELECT site_node_name FROM tree_source_map WHERE node_id = ?').get(node.id))
      .toMatchObject({ site_node_name: '力学' });

    // 4) tree.resolveSourceNode → 命中同节点
    const resolved = await client.tree.resolveSourceNode('zujuan', 'n-9');
    expect(resolved?.id).toBe(node.id);
    expect(await client.tree.resolveSourceNode('zujuan', 'n-不存在')).toBeNull();

    // 5) tree.linkQuestion / 6) unlinkQuestion → question_node_links
    const q = await bank.createQuestion({
      subject: '物理', sourceType: 'local', sourceDetail: { origin: 'bridge-test' },
      content: '<div class="question">挂树题</div>', stemHtml: '<div class="question">挂树题</div>', images: [],
    });
    await client.tree.linkQuestion(q.id, node.id);
    await client.tree.linkQuestion(q.id, node.id); // 幂等（多挂 INSERT OR IGNORE）
    expect(raw.prepare('SELECT COUNT(*) AS c FROM question_node_links WHERE question_id = ?').get(q.id)).toMatchObject({ c: 1 });
    expect((await client.tree.getQuestionNodes(q.id)).map((n) => n.id)).toEqual([node.id]);
    await client.tree.unlinkQuestion(q.id, node.id);
    expect(raw.prepare('SELECT COUNT(*) AS c FROM question_node_links WHERE question_id = ?').get(q.id)).toMatchObject({ c: 0 });

    // 7) paper_set.removePaper → paper_set_papers（卷保留）
    const paper = await bank.createPaper('真桥卷');
    const set = await client.paperSet.createPaperSet({
      name: '真桥批次', type: 'custom-mistake', batchMeta: { perStudentLimit: 5, timeWindowDays: 14 },
    });
    await client.paperSet.addPaper(set.id, paper.id);
    await client.paperSet.removePaper(set.id, paper.id);
    expect(raw.prepare('SELECT COUNT(*) AS c FROM paper_set_papers WHERE paper_set_id = ?').get(set.id)).toMatchObject({ c: 0 });
    expect(await bank.getPaper(paper.id)).not.toBeNull();

    // 8) paper_set.delete → 集合行清空、卷保留
    await client.paperSet.deletePaperSet(set.id);
    expect(raw.prepare('SELECT COUNT(*) AS c FROM paper_sets WHERE id = ?').get(set.id)).toMatchObject({ c: 0 });
    expect(await bank.getPaper(paper.id)).not.toBeNull();
  });

  it('4 条错题闭环通道真实调用：聚合与手工 SQL 逐行核对（任务书 §六.2）', async () => {
    const raw = db!;
    const students = [];
    for (const nm of ['甲', '乙', '丙']) students.push(await client.student.createStudent({ name: nm }));
    const questions = [];
    for (let i = 1; i <= 4; i += 1) {
      questions.push(await bank.createQuestion({
        subject: i === 4 ? '化学' : '物理',
        sourceType: 'local',
        sourceDetail: { origin: 'bridge-probe' },
        content: `<div class="question">探针题${i}</div>`,
        stemHtml: `<div class="question">探针题${i}</div>`,
        questionType: i === 2 ? '多选题' : '单选题',
        difficulty: 0.4 + i / 10,
        images: [],
      }));
    }
    // 3 生 × 4 题 × 部分重叠（q2 三生全错；q1/q4 两生；q3 一生）
    const plan: Array<[number, number, string, string]> = [
      [0, 0, 'red', '2026-09-01T08:00:00.000Z'],
      [0, 1, 'red', '2026-09-05T08:00:00.000Z'],
      [1, 0, 'red', '2026-09-02T08:00:00.000Z'],
      [1, 1, 'yellow', '2026-09-06T08:00:00.000Z'],
      [1, 2, 'red', '2026-09-10T08:00:00.000Z'],
      [2, 1, 'green', '2026-09-03T08:00:00.000Z'],
      [3, 2, 'red', '2026-09-20T08:00:00.000Z'],
      [3, 0, 'red', '2026-09-21T08:00:00.000Z'],
    ];
    const ids: string[] = [];
    for (const [qi, si, stage, at] of plan) {
      const res = await client.mistake.recordWrong({ questionId: questions[qi].id, studentId: students[si].id, occurredAt: at });
      ids.push(res.mistake.id);
      if (stage !== 'red') await client.mistake.setStage(res.mistake.id, stage as 'yellow' | 'green');
    }

    // 手工 SQL（独立实现，不引用 service）：全量口径
    const manualAll = raw.prepare(`
      SELECT m.question_id AS questionId, COUNT(DISTINCT m.student_id) AS wrongCount
      FROM mistakes m JOIN questions q ON q.id = m.question_id
      GROUP BY m.question_id
      ORDER BY wrongCount DESC, m.question_id ASC
    `).all() as Array<{ questionId: string; wrongCount: number }>;
    const viaIpc: MistakeAggregateRow[] = await client.mistake.aggregateByQuestion();
    expect(viaIpc.map((r) => ({ questionId: r.questionId, wrongCount: r.wrongCount }))).toEqual(manualAll);
    expect(viaIpc.map((r) => r.wrongCount)).toEqual([3, 2, 2, 1]);

    // 手工 SQL：stage + 时间窗组合口径（走 IPC，与手工 SQL 逐行核对）
    const manualRedWindow = raw.prepare(`
      SELECT m.question_id AS questionId, COUNT(DISTINCT m.student_id) AS wrongCount
      FROM mistakes m JOIN questions q ON q.id = m.question_id
      WHERE m.stage = 'red' AND m.occurred_at >= ? AND m.occurred_at <= ? AND q.subject = ?
      GROUP BY m.question_id
      ORDER BY wrongCount DESC, m.question_id ASC
    `).all('2026-09-04T00:00:00.000Z', '2026-09-21T23:59:59.999Z', '物理') as Array<{ questionId: string; wrongCount: number }>;
    const viaIpcWindow = await client.mistake.aggregateByQuestion({
      stage: 'red', occurredFrom: '2026-09-04', occurredTo: '2026-09-21', subject: '物理',
    });
    expect(viaIpcWindow.map((r) => ({ questionId: r.questionId, wrongCount: r.wrongCount }))).toEqual(manualRedWindow);
    // 同人次（各 2 人次）按题号升序 = SQLite BINARY 序；uuid 随机，不得写死插入序
    const asc = (...ids: string[]) => [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(viaIpcWindow.map((r) => r.questionId)).toEqual(asc(questions[0].id, questions[1].id));

    // 导出题 id 集 = 聚合次序（去重）
    expect(await client.mistake.exportQuestionIds()).toEqual(viaIpc.map((r) => r.questionId));

    // 批量改档 + 批量删除 → 行数 + operation_log 落库
    const batchStage = await client.mistake.setStages([ids[0], ids[1]], 'green');
    expect(batchStage.affectedCount).toBe(2);
    const batchDelete = await client.mistake.deleteMistakes([ids[2], ids[3]]);
    expect(batchDelete.affectedCount).toBe(2);
    const logs = raw.prepare(
      `SELECT operation_type, status, affected_count FROM operation_log WHERE operation_type LIKE 'mistake.batch%' ORDER BY rowid`,
    ).all() as Array<{ operation_type: string; status: string; affected_count: number }>;
    expect(logs).toEqual([
      { operation_type: 'mistake.batchSetStage', status: 'succeeded', affected_count: 2 },
      { operation_type: 'mistake.batchDelete', status: 'succeeded', affected_count: 2 },
    ]);

    // batch_meta：合法结构往返（读出解析）
    const set = await client.paperSet.createPaperSet({
      name: '探针批次', type: 'custom-mistake', batchMeta: { perStudentLimit: 8, sourceRule: 'stage=red' },
    });
    expect((await client.paperSet.getPaperSet(set.id))!.batchMeta).toEqual({ perStudentLimit: 8, sourceRule: 'stage=red' });
    await expect(client.paperSet.createPaperSet({
      name: '非法批次', type: 'custom-mistake', batchMeta: { perStudentLimit: -1 },
    })).rejects.toThrow(/batch_meta/);
  });
});
