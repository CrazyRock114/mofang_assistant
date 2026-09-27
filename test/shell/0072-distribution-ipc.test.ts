// 0072（R-073 发布批 lane A）：announce.*/update.* 通道接线 ——
// get/refresh/getStatus/checkNow 四个 invoke 通道转发到服务；update.openExternal 校验 http(s)。
//
// 环境：node；electron 全 mock（ipcMain.handle 收进本地 Map，shell.openExternal 可编程）——0071 同范式。

import { describe, it, expect, vi, beforeEach } from 'vitest';

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const openExternal = vi.fn();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
  },
  shell: {
    openExternal: (...args: unknown[]) => openExternal(...args),
  },
}));

import { registerAnnounceIpcHandlers, registerUpdateIpcHandlers } from '../../src/shell/ipc.js';
import { IPC_CHANNELS } from '../../src/shared/contracts/ipc-channels.js';
import type { AnnounceSnapshot, UpdateStatus } from '../../src/shared/contracts/distribution-types.js';

const SNAP: AnnounceSnapshot = {
  source: 'remote',
  data: { updatedAt: '2026-09-25', messages: [{ id: 'a', level: 'info', title: 't', body: 'b' }] },
};
const STATUS: UpdateStatus = { phase: 'available', version: '1.0.1' };

const invokeGet = () => handlers.get(IPC_CHANNELS.ANNOUNCE_GET)!(null) as Promise<AnnounceSnapshot>;
const invokeRefresh = () => handlers.get(IPC_CHANNELS.ANNOUNCE_REFRESH)!(null) as Promise<AnnounceSnapshot>;
const invokeGetStatus = () => handlers.get(IPC_CHANNELS.UPDATE_GET_STATUS)!(null) as Promise<UpdateStatus>;
const invokeCheckNow = () => handlers.get(IPC_CHANNELS.UPDATE_CHECK_NOW)!(null) as Promise<{ started: boolean }>;
const invokeOpenExternal = (url: string) =>
  handlers.get(IPC_CHANNELS.UPDATE_OPEN_EXTERNAL)!(null, url) as Promise<{ ok: boolean; error?: string }>;

beforeEach(() => {
  handlers.clear();
  openExternal.mockReset();
});

describe('0072 announce.* 接线', () => {
  it('announce.get 转发 getSnapshot', async () => {
    registerAnnounceIpcHandlers({ getSnapshot: () => SNAP, refresh: async () => SNAP });
    expect(await invokeGet()).toEqual(SNAP);
  });

  it('announce.refresh 转发 refresh', async () => {
    const refresh = vi.fn(async () => SNAP);
    registerAnnounceIpcHandlers({ getSnapshot: () => SNAP, refresh });
    expect(await invokeRefresh()).toEqual(SNAP);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('0072 update.* 接线', () => {
  it('update.getStatus 转发 getStatus', async () => {
    registerUpdateIpcHandlers({
      getStatus: () => STATUS,
      checkNow: async () => ({ started: true }),
      quitAndInstall: () => {},
    });
    expect(await invokeGetStatus()).toEqual(STATUS);
  });

  it('update.checkNow 转发 checkNow', async () => {
    const checkNow = vi.fn(async () => ({ started: true }));
    registerUpdateIpcHandlers({
      getStatus: () => STATUS,
      checkNow,
      quitAndInstall: () => {},
    });
    expect(await invokeCheckNow()).toEqual({ started: true });
    expect(checkNow).toHaveBeenCalledTimes(1);
  });

  it('update.quitAndInstall 转发 quitAndInstall', async () => {
    const quit = vi.fn();
    registerUpdateIpcHandlers({
      getStatus: () => STATUS,
      checkNow: async () => ({ started: true }),
      quitAndInstall: quit,
    });
    await (handlers.get(IPC_CHANNELS.UPDATE_QUIT_AND_INSTALL)!(null) as Promise<void>);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('update.openExternal：http(s) 放行 shell.openExternal', async () => {
    registerUpdateIpcHandlers({
      getStatus: () => STATUS,
      checkNow: async () => ({ started: true }),
      quitAndInstall: () => {},
    });
    const result = await invokeOpenExternal('https://mofang-assistant.larqitek.com/');
    expect(result.ok).toBe(true);
    expect(openExternal).toHaveBeenCalledWith('https://mofang-assistant.larqitek.com/');
  });

  it('update.openExternal：非 http(s) 拒绝且不触 shell', async () => {
    registerUpdateIpcHandlers({
      getStatus: () => STATUS,
      checkNow: async () => ({ started: true }),
      quitAndInstall: () => {},
    });
    const result = await invokeOpenExternal('file:///C:/Windows/System32');
    expect(result.ok).toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
  });
});
