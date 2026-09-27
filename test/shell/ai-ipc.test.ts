// 0023 P2：ai.* 通道 handler 单测（mock ipcMain 层，模式照 test/shell/dict-tree-ipc.test.ts）
// - 七通道注册齐备（list/create/update/delete/setEnabled/testConnection/invoke）
// - payload 校验（缺字段/类型不对 → 拒绝）
// - 透传 AiGateway（密文/明文转换在网关，handler 只验形）

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

import { registerAiIpcHandlers } from '../../src/shell/ipc.js';
import { IPC_CHANNELS } from '../../src/shared/contracts/ipc-channels.js';
import type { AiGateway } from '../../src/shell/ai/ai-gateway.js';

function makeFakeGateway(): AiGateway {
  return {
    listProfiles: vi.fn(async () => []),
    createProfile: vi.fn(async (payload: { data: { name: string } }) => ({ id: 'mp-1', name: payload.data.name }) as never),
    updateProfile: vi.fn(async () => ({} as never)),
    deleteProfile: vi.fn(async () => undefined),
    setEnabled: vi.fn(async () => ({} as never)),
    testConnection: vi.fn(async () => ({ ok: true, latencyMs: 5, reply: 'pong' })),
    invoke: vi.fn(async () => ({ ok: true, content: 'x', latencyMs: 1 })),
    listModels: vi.fn(async () => ({ ok: true, models: ['deepseek-chat'] })),
  } as unknown as AiGateway;
}

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`通道未注册: ${channel}`);
  return fn(null, ...args) as Promise<unknown>;
}

beforeEach(() => {
  handlers.clear();
});

describe('0023 P2：ai.* 七通道注册与校验', () => {
  it('注册即齐备：list/create/update/delete/setEnabled/testConnection/invoke', () => {
    registerAiIpcHandlers(makeFakeGateway);
    expect(handlers.has(IPC_CHANNELS.AI_PROFILE_LIST)).toBe(true);
    expect(handlers.has(IPC_CHANNELS.AI_PROFILE_CREATE)).toBe(true);
    expect(handlers.has(IPC_CHANNELS.AI_PROFILE_UPDATE)).toBe(true);
    expect(handlers.has(IPC_CHANNELS.AI_PROFILE_DELETE)).toBe(true);
    expect(handlers.has(IPC_CHANNELS.AI_PROFILE_SET_ENABLED)).toBe(true);
    expect(handlers.has(IPC_CHANNELS.AI_PROFILE_TEST_CONNECTION)).toBe(true);
    expect(handlers.has(IPC_CHANNELS.AI_INVOKE)).toBe(true);
  });

  it('create：合法 payload 透传 gateway.createProfile', async () => {
    const gw = makeFakeGateway();
    registerAiIpcHandlers(() => gw);
    const payload = { data: { role: 'reasoning', name: 'R1', provider: 'sf', baseUrl: 'https://x/v1', model: 'm', apiKey: 'sk-x' } };
    await invoke(IPC_CHANNELS.AI_PROFILE_CREATE, payload);
    expect(gw.createProfile).toHaveBeenCalledWith(payload);
  });

  it('create：缺 data / data.role 非法 → 拒绝', async () => {
    const gw = makeFakeGateway();
    registerAiIpcHandlers(() => gw);
    await expect(invoke(IPC_CHANNELS.AI_PROFILE_CREATE, undefined)).rejects.toThrow();
    await expect(invoke(IPC_CHANNELS.AI_PROFILE_CREATE, {})).rejects.toThrow();
    await expect(invoke(IPC_CHANNELS.AI_PROFILE_CREATE, { data: { role: 'chat', name: 'x', provider: 'p', baseUrl: 'u', model: 'm' } }))
      .rejects.toThrow(/role/);
  });

  it('update：缺 id / 缺 data → 拒绝；合法透传', async () => {
    const gw = makeFakeGateway();
    registerAiIpcHandlers(() => gw);
    await expect(invoke(IPC_CHANNELS.AI_PROFILE_UPDATE, { id: 'x' })).rejects.toThrow();
    const payload = { id: 'mp-1', data: { name: '新名' } };
    await invoke(IPC_CHANNELS.AI_PROFILE_UPDATE, payload);
    expect(gw.updateProfile).toHaveBeenCalledWith(payload);
  });

  it('delete/setEnabled：缺 id 或 enabled 非布尔 → 拒绝；合法透传', async () => {
    const gw = makeFakeGateway();
    registerAiIpcHandlers(() => gw);
    await expect(invoke(IPC_CHANNELS.AI_PROFILE_DELETE, {})).rejects.toThrow();
    await invoke(IPC_CHANNELS.AI_PROFILE_DELETE, { id: 'mp-1' });
    expect(gw.deleteProfile).toHaveBeenCalledWith({ id: 'mp-1' });

    await expect(invoke(IPC_CHANNELS.AI_PROFILE_SET_ENABLED, { id: 'mp-1', enabled: 'yes' })).rejects.toThrow();
    await invoke(IPC_CHANNELS.AI_PROFILE_SET_ENABLED, { id: 'mp-1', enabled: true });
    expect(gw.setEnabled).toHaveBeenCalledWith({ id: 'mp-1', enabled: true });
  });

  it('testConnection：缺 profileId → 拒绝；合法透传并回传结果', async () => {
    const gw = makeFakeGateway();
    registerAiIpcHandlers(() => gw);
    await expect(invoke(IPC_CHANNELS.AI_PROFILE_TEST_CONNECTION, {})).rejects.toThrow();
    const result = (await invoke(IPC_CHANNELS.AI_PROFILE_TEST_CONNECTION, { profileId: 'mp-1' })) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(gw.testConnection).toHaveBeenCalledWith({ profileId: 'mp-1' });
  });

  it('invoke：缺 role / role 非法 / messages 空 → 拒绝（三分支之首的前置形验）', async () => {
    const gw = makeFakeGateway();
    registerAiIpcHandlers(() => gw);
    await expect(invoke(IPC_CHANNELS.AI_INVOKE, undefined)).rejects.toThrow();
    await expect(invoke(IPC_CHANNELS.AI_INVOKE, { messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(/role/);
    await expect(invoke(IPC_CHANNELS.AI_INVOKE, { role: 'chat', messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(/role/);
    await expect(invoke(IPC_CHANNELS.AI_INVOKE, { role: 'reasoning', messages: [] })).rejects.toThrow(/messages/);
  });

  it('invoke：合法 payload 透传 gateway.invoke', async () => {
    const gw = makeFakeGateway();
    registerAiIpcHandlers(() => gw);
    const payload = { role: 'reasoning', messages: [{ role: 'user', content: 'hi' }] };
    await invoke(IPC_CHANNELS.AI_INVOKE, payload);
    expect(gw.invoke).toHaveBeenCalledWith(payload);
  });

  it('返工 R3：models.list 通道注册；缺 profileId 且缺 baseUrl → 拒绝；合法透传', async () => {
    const gw = makeFakeGateway();
    registerAiIpcHandlers(() => gw);
    expect(handlers.has(IPC_CHANNELS.AI_MODELS_LIST)).toBe(true);

    await expect(invoke(IPC_CHANNELS.AI_MODELS_LIST, {})).rejects.toThrow();
    const payload = { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-x' };
    await invoke(IPC_CHANNELS.AI_MODELS_LIST, payload);
    expect(gw.listModels).toHaveBeenCalledWith(payload);
  });
});
