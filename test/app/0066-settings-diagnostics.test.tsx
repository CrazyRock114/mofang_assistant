// 0066 可运维性一期（R-002）：设置页「诊断」卡 —— 桥取用 / 无桥不渲染 / 导出成功失败取消三态。
//
// 环境：jsdom；假桥注入走 window.__mofangDiag（与真机同取用路径；无桥环境整卡不渲染，
// 故既有设置页基线零扰动——0061 StorageCleanerCard 同范式）。
// @vitest-environment jsdom

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import { SettingsPage } from '../../src/app/pages/SettingsPage.js';
import type { MofangDiagBridge } from '../../src/shared/contracts/bridge.js';

let container: HTMLDivElement;
let root: Root | null = null;

function render(ui: ReactElement = <SettingsPage />) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => root!.render(ui));
}

function makeDiagFake(result: Record<string, unknown>) {
  const calls: string[] = [];
  const fake = {
    exportDiagnostics: async () => {
      calls.push('export');
      return result;
    },
  };
  return { fake: fake as unknown as MofangDiagBridge, calls };
}

function setBridge(bridge: MofangDiagBridge | undefined): void {
  if (bridge === undefined) delete (window as { __mofangDiag?: MofangDiagBridge }).__mofangDiag;
  else (window as { __mofangDiag?: MofangDiagBridge }).__mofangDiag = bridge;
}

const card = () => container.querySelector('[data-testid="settings-diagnostics-card"]');
const button = () => container.querySelector<HTMLButtonElement>('[data-testid="settings-diagnostics-export"]');
const banner = () => container.querySelector('[data-testid="page-message"]');

async function waitFor(fn: () => boolean, label: string): Promise<void> {
  await vi.waitFor(
    () => {
      if (!fn()) throw new Error(label);
    },
    { timeout: 3000, interval: 20 },
  );
}

beforeEach(() => {
  setBridge(undefined);
});

afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  root = null;
  container?.remove();
  setBridge(undefined);
});

describe('0066 设置页诊断卡', () => {
  it('无桥整卡不渲染（浏览器 demo / 测试基线零扰动）', () => {
    render();
    expect(card()).toBeNull();
    expect(container.querySelector('[data-testid="settings-diagnostics-export"]')).toBeNull();
  });

  it('有桥渲染卡片：标题「诊断」+ 导出按钮', () => {
    setBridge(makeDiagFake({ success: false }).fake);
    render();

    expect(card()).not.toBeNull();
    expect(card()!.textContent).toContain('诊断');
    expect(button()?.textContent).toContain('导出诊断包');
  });

  it('页头说明文案含「诊断」（设置页导航面同步）', () => {
    render();
    expect(container.querySelector('.page-desc')?.textContent).toContain('诊断');
  });

  it('点击导出成功 → 桥被调一次 + 成功 banner 含落盘路径', async () => {
    const { fake, calls } = makeDiagFake({ success: true, path: 'C:\\Users\\t\\mofang-diagnostics-2026-09-24.zip' });
    setBridge(fake);
    render();

    flushSync(() => button()!.click());
    await waitFor(() => banner() !== null, '成功 banner 未出现');

    expect(calls).toEqual(['export']);
    expect(banner()?.getAttribute('data-type')).toBe('success');
    expect(banner()?.textContent).toContain('C:\\Users\\t\\mofang-diagnostics-2026-09-24.zip');
  });

  it('失败 → 错误 banner 带原因（不静默）', async () => {
    setBridge(makeDiagFake({ success: false, error: '磁盘空间不足' }).fake);
    render();

    flushSync(() => button()!.click());
    await waitFor(() => banner() !== null, '失败 banner 未出现');

    expect(banner()?.getAttribute('data-type')).toBe('error');
    expect(banner()?.textContent).toContain('磁盘空间不足');
  });

  it('用户取消 → 不弹 banner（无操作即无提示）', async () => {
    setBridge(makeDiagFake({ success: false, canceled: true }).fake);
    render();

    flushSync(() => button()!.click());
    await vi.waitFor(() => {
      if (!banner()) throw new Error('尚无 banner');
    }, { timeout: 300, interval: 50 }).catch(() => undefined);
    expect(banner()).toBeNull();
  });

  it('桥抛异常 → 错误 banner（IPC 失败必须可见）', async () => {
    const { fake } = makeDiagFake({});
    (fake as unknown as { exportDiagnostics: () => Promise<unknown> }).exportDiagnostics = async () => {
      throw new Error('主进程未就绪');
    };
    setBridge(fake);
    render();

    flushSync(() => button()!.click());
    await waitFor(() => banner() !== null, '异常 banner 未出现');

    expect(banner()?.getAttribute('data-type')).toBe('error');
    expect(banner()?.textContent).toContain('主进程未就绪');
  });

  it('导出中按钮禁用并显示进行态文案', async () => {
    let release: (value: Record<string, unknown>) => void = () => undefined;
    const pending = new Promise<Record<string, unknown>>((resolve) => {
      release = resolve;
    });
    const fake = { exportDiagnostics: () => pending } as unknown as MofangDiagBridge;
    setBridge(fake);
    render();

    flushSync(() => button()!.click());
    expect(button()!.disabled).toBe(true);
    expect(button()!.textContent).toContain('导出中');

    await vi.waitFor(async () => {
      release({ success: true, path: 'x.zip' });
      await pending;
    });
    await waitFor(() => button()!.disabled === false, '按钮未恢复');
  });
});
