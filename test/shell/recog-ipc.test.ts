// 0028 P1：recog.run.* 通道 handler 单测（mock ipcMain 层，模式照 test/shell/ai-ipc.test.ts）
// - 五通道注册齐备（create/status/cancel/history/attachQuestions）
// - payload 校验（缺字段/类型不对 → 拒绝）
// - 透传 RecogHost（编排全在 shell/recog，handler 只验形）

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

import { registerRecogIpcHandlers } from '../../src/shell/ipc.js';
import { IPC_CHANNELS } from '../../src/shared/contracts/ipc-channels.js';
import type { RecogHost } from '../../src/shell/recog/recog-host.js';

function makeFakeHost() {
  return {
    createRun: vi.fn(async () => ({ runId: 'run-1', pageCount: 2 })),
    status: vi.fn(async () => ({ run: { id: 'run-1' }, pages: [], drafts: [], warnings: [] })),
    cancel: vi.fn(async () => ({ id: 'run-1', status: 'cancelled' })),
    history: vi.fn(async () => []),
    attachQuestions: vi.fn(async () => ({ id: 'run-1', questionIds: ['q1'] })),
  } as unknown as RecogHost;
}

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`通道未注册: ${channel}`);
  return fn(null, ...args) as Promise<unknown>;
}

beforeEach(() => {
  handlers.clear();
});

describe('0028 P1：recog.run.* 通道注册与校验', () => {
  it('注册即齐备：create/status/cancel/history/attachQuestions', () => {
    registerRecogIpcHandlers(makeFakeHost);
    expect(handlers.has(IPC_CHANNELS.RECOG_RUN_CREATE)).toBe(true);
    expect(handlers.has(IPC_CHANNELS.RECOG_RUN_STATUS)).toBe(true);
    expect(handlers.has(IPC_CHANNELS.RECOG_RUN_CANCEL)).toBe(true);
    expect(handlers.has(IPC_CHANNELS.RECOG_RUN_HISTORY)).toBe(true);
    expect(handlers.has(IPC_CHANNELS.RECOG_RUN_ATTACH_QUESTIONS)).toBe(true);
  });

  it('通道名逐字（契约不许漂移）', () => {
    expect(IPC_CHANNELS.RECOG_RUN_CREATE).toBe('recog.run.create');
    expect(IPC_CHANNELS.RECOG_RUN_STATUS).toBe('recog.run.status');
    expect(IPC_CHANNELS.RECOG_RUN_CANCEL).toBe('recog.run.cancel');
    expect(IPC_CHANNELS.RECOG_RUN_HISTORY).toBe('recog.run.history');
    expect(IPC_CHANNELS.RECOG_RUN_ATTACH_QUESTIONS).toBe('recog.run.attachQuestions');
    expect(IPC_CHANNELS.RECOG_EVENT).toBe('recog.event');
  });

  it('create：合法 payload 透传 host.createRun', async () => {
    const host = makeFakeHost();
    registerRecogIpcHandlers(() => host);
    const payload = { materials: [{ name: 'a.png', mime: 'image/png', dataBase64: 'AA==' }], sourceKind: 'image' };
    await invoke(IPC_CHANNELS.RECOG_RUN_CREATE, payload);
    expect(host.createRun).toHaveBeenCalledWith(payload);
  });

  it('create：缺 materials / 空数组 / 元素缺 name / dataBase64 非串 → 拒绝', async () => {
    const host = makeFakeHost();
    registerRecogIpcHandlers(() => host);
    await expect(invoke(IPC_CHANNELS.RECOG_RUN_CREATE, undefined)).rejects.toThrow();
    await expect(invoke(IPC_CHANNELS.RECOG_RUN_CREATE, {})).rejects.toThrow(/materials/);
    await expect(invoke(IPC_CHANNELS.RECOG_RUN_CREATE, { materials: [] })).rejects.toThrow(/materials/);
    await expect(invoke(IPC_CHANNELS.RECOG_RUN_CREATE, { materials: [{ mime: 'image/png', dataBase64: 'AA==' }] })).rejects.toThrow(/materials\[0\]\.name/);
    await expect(invoke(IPC_CHANNELS.RECOG_RUN_CREATE, { materials: [{ name: 'a.png', mime: 'image/png', dataBase64: 5 }] })).rejects.toThrow(/materials\[0\]\.dataBase64/);
    expect(host.createRun).not.toHaveBeenCalled();
  });

  it('0046 P5.2：create sourceName 可选非空串（非串拒绝；缺省与合法值透传）', async () => {
    const host = makeFakeHost();
    registerRecogIpcHandlers(() => host);
    await expect(invoke(IPC_CHANNELS.RECOG_RUN_CREATE, {
      materials: [{ name: 'a.png', mime: 'image/png', dataBase64: 'AA==' }], sourceKind: 'image', sourceName: 5,
    })).rejects.toThrow(/sourceName/);
    await expect(invoke(IPC_CHANNELS.RECOG_RUN_CREATE, {
      materials: [{ name: 'a.png', mime: 'image/png', dataBase64: 'AA==' }], sourceKind: 'image', sourceName: '',
    })).rejects.toThrow(/sourceName/);
    const payload = { materials: [{ name: 'a.png', mime: 'image/png', dataBase64: 'AA==' }], sourceKind: 'image', sourceName: '期中物理' };
    await invoke(IPC_CHANNELS.RECOG_RUN_CREATE, payload);
    expect(host.createRun).toHaveBeenCalledWith(payload);
  });

  it('status / cancel：runId 必填；合法透传', async () => {
    const host = makeFakeHost();
    registerRecogIpcHandlers(() => host);
    await expect(invoke(IPC_CHANNELS.RECOG_RUN_STATUS, {})).rejects.toThrow(/runId/);
    await expect(invoke(IPC_CHANNELS.RECOG_RUN_CANCEL, {})).rejects.toThrow(/runId/);
    await invoke(IPC_CHANNELS.RECOG_RUN_STATUS, { runId: 'run-1' });
    await invoke(IPC_CHANNELS.RECOG_RUN_CANCEL, { runId: 'run-1' });
    expect(host.status).toHaveBeenCalledWith('run-1');
    expect(host.cancel).toHaveBeenCalledWith('run-1');
  });

  it('history：limit 可选，非数字/负数 → 拒绝；合法透传', async () => {
    const host = makeFakeHost();
    registerRecogIpcHandlers(() => host);
    await invoke(IPC_CHANNELS.RECOG_RUN_HISTORY, undefined);
    expect(host.history).toHaveBeenCalledWith(undefined);
    await expect(invoke(IPC_CHANNELS.RECOG_RUN_HISTORY, { limit: -1 })).rejects.toThrow(/limit/);
    await expect(invoke(IPC_CHANNELS.RECOG_RUN_HISTORY, { limit: '5' })).rejects.toThrow(/limit/);
    await invoke(IPC_CHANNELS.RECOG_RUN_HISTORY, { limit: 5 });
    expect(host.history).toHaveBeenLastCalledWith(5);
  });

  it('attachQuestions：runId + questionIds 数组必填（非串元素拒绝）', async () => {
    const host = makeFakeHost();
    registerRecogIpcHandlers(() => host);
    await expect(invoke(IPC_CHANNELS.RECOG_RUN_ATTACH_QUESTIONS, { runId: 'r', questionIds: 'q1' })).rejects.toThrow(/questionIds/);
    await expect(invoke(IPC_CHANNELS.RECOG_RUN_ATTACH_QUESTIONS, { runId: 'r', questionIds: [1] })).rejects.toThrow(/questionIds/);
    await invoke(IPC_CHANNELS.RECOG_RUN_ATTACH_QUESTIONS, { runId: 'r', questionIds: ['q1'] });
    expect(host.attachQuestions).toHaveBeenCalledWith('r', ['q1']);
  });

  it('getter 闭包：host 重建后 handler 自动指向新实例（对齐 reloadDatabase 语义）', async () => {
    const a = makeFakeHost();
    const b = makeFakeHost();
    let current = a;
    registerRecogIpcHandlers(() => current);
    await invoke(IPC_CHANNELS.RECOG_RUN_HISTORY, undefined);
    expect(a.history).toHaveBeenCalledTimes(1);
    current = b;
    await invoke(IPC_CHANNELS.RECOG_RUN_HISTORY, undefined);
    expect(b.history).toHaveBeenCalledTimes(1);
    expect(a.history).toHaveBeenCalledTimes(1);
  });
});
