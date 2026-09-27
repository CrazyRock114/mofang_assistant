// 0016 P1-1/P1-2：既有通道补线 handler 单测（mock ipcMain 层，模式照 test/shell/capture-ipc.test.ts）
// - dict.update（DICT_UPDATE）：payload 校验 + 透传 dictService.updateEntry（守卫在 service 层）
// - tree.getSourceMappings（TREE_GET_SOURCE_MAPPINGS）：payload 校验 + 透传 treeService.getSourceMappings

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
}));

import { registerExtIpcHandlers } from '../../src/shell/ipc.js';
import { IPC_CHANNELS } from '../../src/shared/contracts/ipc-channels.js';
import type { BankExtServices } from '../../src/shared/contracts/bank-types.js';

function makeFakeExt() {
  return {
    dict: {
      listEntries: vi.fn(async () => []),
      getEntry: vi.fn(async () => null),
      createEntry: vi.fn(async () => { throw new Error('unused'); }),
      updateEntry: vi.fn(async (id: string, data: { code?: string; active?: boolean }) => ({ id, code: data.code ?? '', active: Boolean(data.active) })),
    },
    tree: {
      getSourceMappings: vi.fn(async (nodeId: string) => [{ nodeId, site: 'zujuan', siteNodeId: 'n1', siteNodeName: '力学' }]),
    },
  } as unknown as BankExtServices & {
    dict: { updateEntry: ReturnType<typeof vi.fn> };
    tree: { getSourceMappings: ReturnType<typeof vi.fn> };
  };
}

function register(ext: BankExtServices): void {
  registerExtIpcHandlers(() => ext);
}

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`通道未注册: ${channel}`);
  return fn(null, ...args) as Promise<unknown>;
}

beforeEach(() => {
  handlers.clear();
});

describe('0016 P1：dict.update handler 补线', () => {
  it('注册即存在；合法 payload 透传 dict.updateEntry(id, data)', async () => {
    const ext = makeFakeExt();
    register(ext);

    await invoke(IPC_CHANNELS.DICT_UPDATE, { id: 'subj:jyeoo:xuanxue0', data: { code: 'physics', active: true } });
    expect((ext as any).dict.updateEntry).toHaveBeenCalledWith('subj:jyeoo:xuanxue0', { code: 'physics', active: true });
  });

  it.each([
    ['缺 payload', undefined],
    ['非对象', 'bad'],
    ['缺 id', { data: {} }],
    ['id 非字符串', { id: 1, data: {} }],
    ['缺 data', { id: 'x' }],
    ['data 非对象', { id: 'x', data: 'bad' }],
  ])('非法 payload %s → 抛 Invalid payload', async (_name, payload) => {
    const ext = makeFakeExt();
    register(ext);
    await expect(invoke(IPC_CHANNELS.DICT_UPDATE, payload)).rejects.toThrow(/Invalid payload/);
  });
});

describe('0016 P1：tree.getSourceMappings handler 补线', () => {
  it('注册即存在；合法 payload 透传 tree.getSourceMappings(nodeId)，返回映射列表', async () => {
    const ext = makeFakeExt();
    register(ext);

    const result = await invoke(IPC_CHANNELS.TREE_GET_SOURCE_MAPPINGS, { nodeId: 'node-1' });
    expect((ext as any).tree.getSourceMappings).toHaveBeenCalledWith('node-1');
    expect(result).toEqual([{ nodeId: 'node-1', site: 'zujuan', siteNodeId: 'n1', siteNodeName: '力学' }]);
  });

  it.each([
    ['缺 payload', undefined],
    ['缺 nodeId', {}],
    ['nodeId 非字符串', { nodeId: 1 }],
  ])('非法 payload %s → 抛 Invalid nodeId', async (_name, payload) => {
    const ext = makeFakeExt();
    register(ext);
    await expect(invoke(IPC_CHANNELS.TREE_GET_SOURCE_MAPPINGS, payload)).rejects.toThrow(/Invalid nodeId/);
  });
});
