/**
 * 0012 P1：capture.* 新增通道 IPC handler 单测（mock ipcMain 层）
 * - capture.setBounds：payload 校验（数字/有限/宽高非负；x/y 允许负=P0 A3 滚出场景）
 * - capture.savePageHtml：透传 host（取证结果如实回传）
 */

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

import { registerCaptureIpcHandlers } from '../../src/shell/ipc.js';
import { IPC_CHANNELS } from '../../src/shared/contracts/ipc-channels.js';

function makeFakeHost() {
  return {
    openWindow: vi.fn(async () => undefined),
    closeWindow: vi.fn(async () => undefined),
    navigate: vi.fn(async () => undefined),
    getState: vi.fn(async () => ({ open: false, url: '', title: '', site: null, loggedIn: false, lastExtraction: null })),
    extractBasket: vi.fn(async () => ({ extracted: { url: '', mode: 'none', captured: [], warnings: [] } })),
    collect: vi.fn(async () => ({ ok: 0, dup: 0, failed: [] })),
    getLastExtraction: vi.fn(async () => ({ extracted: null })),
    paperPreview: vi.fn(async () => { throw new Error('unused'); }),
    paperImport: vi.fn(async () => { throw new Error('unused'); }),
    setBounds: vi.fn(async () => undefined),
    savePageHtml: vi.fn(async () => ({ ok: true, path: 'C:\\ud\\data\\capture-html-snapshots\\x.html' })),
  };
}

/** 既有签名：getter 闭包（恢复后 host 重建，handler 自动指向新实例） */
function register(host: ReturnType<typeof makeFakeHost>): void {
  registerCaptureIpcHandlers(() => host as unknown as ReturnType<Parameters<typeof registerCaptureIpcHandlers>[0]>);
}

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`通道未注册: ${channel}`);
  return fn(null, ...args) as Promise<unknown>;
}

beforeEach(() => {
  handlers.clear();
});

describe('0012：capture.setBounds handler（payload 校验）', () => {
  it('注册即存在；合法 payload（含负 x/y 滚出场景）透传 host.setBounds', async () => {
    const host = makeFakeHost();
    register(host);

    await invoke(IPC_CHANNELS.CAPTURE_SET_BOUNDS, { x: 0, y: 48, width: 1136, height: 700 });
    expect(host.setBounds).toHaveBeenCalledWith({ x: 0, y: 48, width: 1136, height: 700 });

    // P0 A3：滚动滚出后视口矩形 y 为负——x/y 允许负值
    await invoke(IPC_CHANNELS.CAPTURE_SET_BOUNDS, { x: -20, y: -260, width: 1136, height: 700 });
    expect(host.setBounds).toHaveBeenLastCalledWith({ x: -20, y: -260, width: 1136, height: 700 });
  });

  it.each([
    ['缺 payload', undefined],
    ['非对象', 'bad'],
    ['缺字段', { x: 0, y: 0, width: 100 }],
    ['NaN', { x: Number.NaN, y: 0, width: 100, height: 100 }],
    ['Infinity', { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 100 }],
    ['字符串坐标', { x: '0', y: 0, width: 100, height: 100 }],
    ['负宽', { x: 0, y: 0, width: -1, height: 100 }],
    ['负高', { x: 0, y: 0, width: 100, height: -1 }],
  ])('非法 payload %s → 抛 Invalid payload', async (_name, payload) => {
    const host = makeFakeHost();
    register(host);
    await expect(invoke(IPC_CHANNELS.CAPTURE_SET_BOUNDS, payload)).rejects.toThrow(/Invalid payload/);
    expect(host.setBounds).not.toHaveBeenCalled();
  });
});

describe('0012：capture.savePageHtml handler（取证透传）', () => {
  it('透传 host.savePageHtml 结果', async () => {
    const host = makeFakeHost();
    register(host);
    const r = (await invoke(IPC_CHANNELS.CAPTURE_SAVE_PAGE_HTML)) as { ok: boolean; path?: string };
    expect(r.ok).toBe(true);
    expect(host.savePageHtml).toHaveBeenCalledOnce();
  });
});
