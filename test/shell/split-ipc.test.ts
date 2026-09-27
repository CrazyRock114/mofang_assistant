// 0036 P1：split.* 通道 handler 单测（mock ipcMain，模式照 test/shell/recog-ipc.test.ts）
// - 十通道注册齐备 + 通道名逐字
// - payload 形验（缺字段/类型不对 → 拒绝，不透传到宿主）
// - 合法 payload 透传 SplitHost

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { registerSplitIpcHandlers } from '../../src/shell/ipc.js';
import { IPC_CHANNELS } from '../../src/shared/contracts/ipc-channels.js';
import type { SplitHost } from '../../src/shell/splitting/split-host.js';

function makeFakeHost() {
  return {
    createProject: vi.fn(async () => ({ id: 'p1', name: 'a', sourceName: 'a.pdf', pageCount: 0, segmentCount: 0, updatedAt: 'now' })),
    appendSource: vi.fn(async () => ({ size: 3 })),
    readSource: vi.fn(async () => ({ dataBase64: '', eof: true })),
    saveMeta: vi.fn(async () => ({ id: 'p1', name: 'a', sourceName: 'a.pdf', pageCount: 1, segmentCount: 1, updatedAt: 'now' })),
    saveDraft: vi.fn(async () => ({ savedAt: 'now' })),
    listProjects: vi.fn(async () => []),
    openProject: vi.fn(async () => ({ meta: { id: 'p1' }, draft: { version: 1, segments: {}, updatedAt: 'now' } })),
    removeProject: vi.fn(async () => undefined),
    writePage: vi.fn(async () => ({ file: 'pages/p001.png' })),
    readPage: vi.fn(async () => ({ dataBase64: null })),
  } as unknown as SplitHost;
}

function invoke(channel: string, payload?: unknown): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`通道未注册: ${channel}`);
  return fn(null, payload) as Promise<unknown>;
}

const PROJECT_ID = '11111111-2222-4333-8444-555555555555';

beforeEach(() => {
  handlers.clear();
});

describe('0036 P1：split.* 通道注册', () => {
  it('十通道一次注册齐备', () => {
    registerSplitIpcHandlers(makeFakeHost);
    for (const channel of [
      IPC_CHANNELS.SPLIT_PROJECT_CREATE, IPC_CHANNELS.SPLIT_PROJECT_SAVE_META,
      IPC_CHANNELS.SPLIT_PROJECT_SAVE_DRAFT, IPC_CHANNELS.SPLIT_PROJECT_LIST,
      IPC_CHANNELS.SPLIT_PROJECT_OPEN, IPC_CHANNELS.SPLIT_PROJECT_REMOVE,
      IPC_CHANNELS.SPLIT_SOURCE_APPEND, IPC_CHANNELS.SPLIT_SOURCE_READ,
      IPC_CHANNELS.SPLIT_PAGE_WRITE, IPC_CHANNELS.SPLIT_PAGE_READ,
    ]) {
      expect(handlers.has(channel)).toBe(true);
    }
  });

  it('通道名逐字（契约不许漂移）', () => {
    expect(IPC_CHANNELS.SPLIT_PROJECT_CREATE).toBe('split.project.create');
    expect(IPC_CHANNELS.SPLIT_PROJECT_SAVE_META).toBe('split.project.saveMeta');
    expect(IPC_CHANNELS.SPLIT_PROJECT_SAVE_DRAFT).toBe('split.project.saveDraft');
    expect(IPC_CHANNELS.SPLIT_PROJECT_LIST).toBe('split.project.list');
    expect(IPC_CHANNELS.SPLIT_PROJECT_OPEN).toBe('split.project.open');
    expect(IPC_CHANNELS.SPLIT_PROJECT_REMOVE).toBe('split.project.remove');
    expect(IPC_CHANNELS.SPLIT_SOURCE_APPEND).toBe('split.source.append');
    expect(IPC_CHANNELS.SPLIT_SOURCE_READ).toBe('split.source.read');
    expect(IPC_CHANNELS.SPLIT_PAGE_WRITE).toBe('split.page.write');
    expect(IPC_CHANNELS.SPLIT_PAGE_READ).toBe('split.page.read');
  });
});

describe('0036 P1：split.* payload 形验', () => {
  it('create：缺 sourceName / 字节数非数字 → 拒绝', async () => {
    const host = makeFakeHost();
    registerSplitIpcHandlers(() => host);
    await expect(invoke(IPC_CHANNELS.SPLIT_PROJECT_CREATE, { sourceBytes: 1 })).rejects.toThrow(/sourceName/);
    await expect(invoke(IPC_CHANNELS.SPLIT_PROJECT_CREATE, { sourceName: '', sourceBytes: 1 })).rejects.toThrow(/sourceName/);
    await expect(invoke(IPC_CHANNELS.SPLIT_PROJECT_CREATE, { sourceName: 'a.pdf', sourceBytes: '1' })).rejects.toThrow(/sourceBytes/);
    expect(host.createProject).not.toHaveBeenCalled();
  });

  it('create：合法 payload 透传宿主', async () => {
    const host = makeFakeHost();
    registerSplitIpcHandlers(() => host);
    const out = await invoke(IPC_CHANNELS.SPLIT_PROJECT_CREATE, { name: 'a', sourceName: 'a.pdf', sourceBytes: 10 });
    expect(host.createProject).toHaveBeenCalledWith({ name: 'a', sourceName: 'a.pdf', sourceBytes: 10 });
    expect(out).toMatchObject({ id: 'p1' });
  });

  it('appendSource：projectId/offset/dataBase64 缺一不可', async () => {
    const host = makeFakeHost();
    registerSplitIpcHandlers(() => host);
    await expect(invoke(IPC_CHANNELS.SPLIT_SOURCE_APPEND, { offset: 0, dataBase64: 'AA==' })).rejects.toThrow(/projectId/);
    await expect(invoke(IPC_CHANNELS.SPLIT_SOURCE_APPEND, { projectId: PROJECT_ID, dataBase64: 'AA==' })).rejects.toThrow(/offset/);
    await expect(invoke(IPC_CHANNELS.SPLIT_SOURCE_APPEND, { projectId: PROJECT_ID, offset: 0 })).rejects.toThrow(/dataBase64/);
  });

  it('readSource：length 必须为正整数', async () => {
    const host = makeFakeHost();
    registerSplitIpcHandlers(() => host);
    await expect(invoke(IPC_CHANNELS.SPLIT_SOURCE_READ, { projectId: PROJECT_ID, offset: 0, length: 0 })).rejects.toThrow(/length/);
    await expect(invoke(IPC_CHANNELS.SPLIT_SOURCE_READ, { projectId: PROJECT_ID, offset: 0, length: -3 })).rejects.toThrow(/length/);
    await expect(invoke(IPC_CHANNELS.SPLIT_SOURCE_READ, { projectId: PROJECT_ID, offset: 0, length: 3.5 })).rejects.toThrow(/length/);
  });

  it('saveMeta：segments 必须是数组', async () => {
    const host = makeFakeHost();
    registerSplitIpcHandlers(() => host);
    await expect(
      invoke(IPC_CHANNELS.SPLIT_PROJECT_SAVE_META, { projectId: PROJECT_ID, pageCount: 1, segments: {} }),
    ).rejects.toThrow(/segments/);
  });

  it('saveDraft：draft 必须是对象', async () => {
    const host = makeFakeHost();
    registerSplitIpcHandlers(() => host);
    await expect(
      invoke(IPC_CHANNELS.SPLIT_PROJECT_SAVE_DRAFT, { projectId: PROJECT_ID, draft: 'x' }),
    ).rejects.toThrow(/draft/);
  });

  it('writePage：pageNo 正整数 + 字节非空', async () => {
    const host = makeFakeHost();
    registerSplitIpcHandlers(() => host);
    await expect(
      invoke(IPC_CHANNELS.SPLIT_PAGE_WRITE, { projectId: PROJECT_ID, pageNo: 0, dataBase64: 'AA==' }),
    ).rejects.toThrow(/pageNo/);
    await expect(
      invoke(IPC_CHANNELS.SPLIT_PAGE_WRITE, { projectId: PROJECT_ID, pageNo: 1, dataBase64: '' }),
    ).rejects.toThrow(/dataBase64/);
  });

  it('id 类通道：projectId 缺失/非字符串 → 拒绝', async () => {
    const host = makeFakeHost();
    registerSplitIpcHandlers(() => host);
    for (const channel of [
      IPC_CHANNELS.SPLIT_PROJECT_OPEN, IPC_CHANNELS.SPLIT_PROJECT_REMOVE, IPC_CHANNELS.SPLIT_PAGE_READ,
    ]) {
      await expect(invoke(channel, {})).rejects.toThrow(/projectId/);
      await expect(invoke(channel, { projectId: 42 })).rejects.toThrow(/projectId/);
    }
  });

  it('list：无 payload 也放行（列表是最常用的入口）', async () => {
    const host = makeFakeHost();
    registerSplitIpcHandlers(() => host);
    await expect(invoke(IPC_CHANNELS.SPLIT_PROJECT_LIST)).resolves.toEqual([]);
    expect(host.listProjects).toHaveBeenCalledTimes(1);
  });
});
