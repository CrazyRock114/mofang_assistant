// 0072（R-073 发布批 lane A / D-088 呈现层口径）：设置页「关于」卡更新区 ——
// 无桥不渲染 / dev 无 handler（getStatus reject）不渲染 / 各状态呈现（检查中 / 已是最新 / 发现新版 /
// 下载中进度 / 慢速提示 / 重启以完成更新 / 仅手动检查可见失败）。
//
// 环境：jsdom；假桥注入走 window.__mofangUpdate（与真机同取用路径；诊断卡/数据位置卡同范式）。
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import { SettingsPage } from '../../src/app/pages/SettingsPage.js';
import type { UpdateStatus } from '../../src/shared/contracts/distribution-types.js';
import type { MofangUpdateBridge } from '../../src/shared/contracts/bridge.js';

let container: HTMLDivElement;
let root: Root | null = null;

const flushPromises = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function render(ui: ReactElement = <SettingsPage />) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => root!.render(ui));
}

/** 可编程假桥：getStatus 返回值/拒绝 + 事件回调可手动触发 */
function makeUpdateBridge(opts: { status?: UpdateStatus; reject?: boolean } = {}) {
  const calls: string[] = [];
  const listeners: Array<(s: UpdateStatus) => void> = [];
  const bridge = {
    getStatus: async () => {
      calls.push('getStatus');
      if (opts.reject) throw new Error('No handler registered for update.getStatus');
      return opts.status ?? { phase: 'idle' };
    },
    checkNow: async () => {
      calls.push('checkNow');
      return { started: true };
    },
    openExternal: async () => {
      calls.push('openExternal');
      return { ok: true };
    },
    quitAndInstall: async () => {
      calls.push('quitAndInstall');
    },
    onStatus: (cb: (s: UpdateStatus) => void) => {
      listeners.push(cb);
      return () => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
  };
  return { bridge: bridge as unknown as MofangUpdateBridge, calls, listeners };
}

function setBridge(bridge: MofangUpdateBridge | undefined): void {
  const w = window as unknown as { __mofangUpdate?: MofangUpdateBridge };
  delete w.__mofangUpdate;
  if (bridge) w.__mofangUpdate = bridge;
}

const area = () => container.querySelector('[data-testid="settings-update-area"]');

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  root?.unmount();
  root = null;
  if (container) container.remove();
});

describe('0072 关于卡更新区：可用性门控', () => {
  it('无 update 桥 → 更新区不渲染，关于卡其余照旧（版本行在）', () => {
    setBridge(undefined);
    render();
    expect(area()).toBeNull();
    expect(container.querySelector('[data-testid="about-version"]')).not.toBeNull();
  });

  it('桥存在但 getStatus reject（dev/自动化无 handler）→ 更新区不渲染', async () => {
    setBridge(makeUpdateBridge({ reject: true }).bridge);
    render();
    await flushPromises();
    flushSync(() => root!.render(<SettingsPage />));
    expect(area()).toBeNull();
  });
});

describe('0072 关于卡更新区：各状态呈现', () => {
  it('idle：显示「检查更新」按钮，点击调 checkNow', async () => {
    const { bridge, calls } = makeUpdateBridge({ status: { phase: 'idle' } });
    setBridge(bridge);
    render();
    await flushPromises();
    flushSync(() => root!.render(<SettingsPage />));
    const btn = container.querySelector('[data-testid="settings-update-check"]') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    flushSync(() => btn.click());
    await flushPromises();
    expect(calls).toContain('checkNow');
  });

  it('not-available：呈现「已是最新」', async () => {
    setBridge(makeUpdateBridge({ status: { phase: 'not-available' } }).bridge);
    render();
    await flushPromises();
    flushSync(() => root!.render(<SettingsPage />));
    expect(area()!.textContent).toContain('已是最新');
  });

  it('checking：呈现检查中', async () => {
    setBridge(makeUpdateBridge({ status: { phase: 'checking' } }).bridge);
    render();
    await flushPromises();
    flushSync(() => root!.render(<SettingsPage />));
    expect(area()!.textContent).toContain('检查中');
  });

  it('available：呈现新版本号 + 手动下载入口', async () => {
    setBridge(makeUpdateBridge({ status: { phase: 'available', version: '1.0.1' } }).bridge);
    render();
    await flushPromises();
    flushSync(() => root!.render(<SettingsPage />));
    expect(area()!.textContent).toContain('1.0.1');
    expect(container.querySelector('[data-testid="settings-update-manual-download"]')).not.toBeNull();
  });

  it('downloading：进度百分比呈现；slowHint → 非阻塞慢速提示（下载不停）', async () => {
    setBridge(makeUpdateBridge({ status: { phase: 'downloading', percent: 42, speedBps: 40 * 1024, slowHint: true } }).bridge);
    render();
    await flushPromises();
    flushSync(() => root!.render(<SettingsPage />));
    expect(area()!.textContent).toContain('42%');
    expect(container.querySelector('[data-testid="settings-update-slow-hint"]')).not.toBeNull();
  });

  it('downloading 无 slowHint：不显示慢速提示', async () => {
    setBridge(makeUpdateBridge({ status: { phase: 'downloading', percent: 42, speedBps: 900 * 1024, slowHint: false } }).bridge);
    render();
    await flushPromises();
    flushSync(() => root!.render(<SettingsPage />));
    expect(container.querySelector('[data-testid="settings-update-slow-hint"]')).toBeNull();
  });

  it('downloaded：呈现「重启以完成更新」+「立即重启」按钮，点击转发 quitAndInstall', async () => {
    const { bridge, calls } = makeUpdateBridge({ status: { phase: 'downloaded', version: '1.0.1' } });
    setBridge(bridge);
    render();
    await flushPromises();
    flushSync(() => root!.render(<SettingsPage />));
    expect(area()!.textContent).toContain('重启以完成更新');
    const restart = container.querySelector('[data-testid="settings-update-restart"]') as HTMLButtonElement;
    expect(restart).not.toBeNull();
    flushSync(() => restart.click());
    await flushPromises();
    expect(calls).toContain('quitAndInstall');
  });

  it('error + manual：失败文案可见', async () => {
    setBridge(makeUpdateBridge({ status: { phase: 'error', error: '网络错误', manual: true } }).bridge);
    render();
    await flushPromises();
    flushSync(() => root!.render(<SettingsPage />));
    expect(area()!.textContent).toContain('网络错误');
  });

  it('error 非 manual（自动检查失败）：失败文案不可见（连续自动失败不打扰）', async () => {
    setBridge(makeUpdateBridge({ status: { phase: 'error', error: '网络错误', manual: false } }).bridge);
    render();
    await flushPromises();
    flushSync(() => root!.render(<SettingsPage />));
    expect(area()!.textContent).not.toContain('网络错误');
  });

  it('诊断联动文案恒在（更新异常引导导出诊断包）', async () => {
    setBridge(makeUpdateBridge({ status: { phase: 'idle' } }).bridge);
    render();
    await flushPromises();
    flushSync(() => root!.render(<SettingsPage />));
    expect(area()!.textContent).toContain('诊断');
  });
});
