// 0071 自定义数据保存位置（R-043）：设置页「数据保存位置」卡 ——
// 桥取用 / 无桥不渲染 / 读取进展与来源标签 / 更改成功（重启后迁移提示）/ 被拒 / 取消目录选择 /
// 撤销待迁移 / 迁移失败留痕展示。
//
// 环境：jsdom；假桥注入走 window.__mofangDataLocation（与真机同取用路径；无桥环境整卡不渲染，
// 故既有设置页基线零扰动——0066 诊断卡同范式）。
// @vitest-environment jsdom

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import { SettingsPage } from '../../src/app/pages/SettingsPage.js';
import type { MofangDataLocationBridge } from '../../src/shared/contracts/bridge.js';
import type { DataLocationInfo } from '../../src/shared/contracts/ipc-channels.js';

let container: HTMLDivElement;
let root: Root | null = null;

function render(ui: ReactElement = <SettingsPage />) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => root!.render(ui));
}

const INFO: DataLocationInfo = {
  userDataPath: 'C:\\Users\\t\\AppData\\Roaming\\mofang-assistant',
  source: 'default',
  dataRoot: null,
  pendingDataRoot: null,
  lastMigrationError: null,
  portable: false,
};

function makeFake(overrides: Partial<{
  info: DataLocationInfo;
  change: () => Promise<Record<string, unknown>>;
  cancel: () => Promise<Record<string, unknown>>;
}> = {}) {
  const calls: string[] = [];
  const state = { info: overrides.info ?? INFO };
  const fake = {
    get: async () => {
      calls.push('get');
      return state.info;
    },
    change: async () => {
      calls.push('change');
      if (overrides.change) return overrides.change();
      state.info = { ...state.info, pendingDataRoot: 'D:\\mofang-data' };
      return { success: true, pendingDataRoot: 'D:\\mofang-data' };
    },
    cancel: async () => {
      calls.push('cancel');
      if (overrides.cancel) return overrides.cancel();
      state.info = { ...state.info, pendingDataRoot: null };
      return { success: true };
    },
  };
  return { fake: fake as unknown as MofangDataLocationBridge, calls, state };
}

function setBridge(bridge: MofangDataLocationBridge | undefined): void {
  if (bridge === undefined) delete (window as { __mofangDataLocation?: MofangDataLocationBridge }).__mofangDataLocation;
  else (window as { __mofangDataLocation?: MofangDataLocationBridge }).__mofangDataLocation = bridge;
}

const card = () => container.querySelector('[data-testid="settings-data-location-card"]');
const current = () => container.querySelector('[data-testid="settings-data-location-current"]');
const pending = () => container.querySelector('[data-testid="settings-data-location-pending"]');
const lastError = () => container.querySelector('[data-testid="settings-data-location-last-error"]');
const changeBtn = () => container.querySelector<HTMLButtonElement>('[data-testid="settings-data-location-change"]');
const cancelBtn = () => container.querySelector<HTMLButtonElement>('[data-testid="settings-data-location-cancel"]');
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

describe('0071 设置页数据保存位置卡', () => {
  it('无桥整卡不渲染（浏览器 demo / 测试基线零扰动）', () => {
    render();
    expect(card()).toBeNull();
    expect(changeBtn()).toBeNull();
  });

  it('有桥渲染卡片：标题 + 当前位置 + 来源标签 + 更改按钮', async () => {
    setBridge(makeFake().fake);
    render();
    await waitFor(() => current() !== null && current()!.textContent!.includes('AppData'), '当前位置未渲染');

    expect(card()!.textContent).toContain('数据保存位置');
    expect(current()!.textContent).toContain('C:\\Users\\t\\AppData\\Roaming\\mofang-assistant');
    expect(current()!.textContent).toContain('系统默认位置');
    expect(changeBtn()?.textContent).toContain('更改');
    // 未登记待迁移时不出「取消迁移」
    expect(cancelBtn()).toBeNull();
  });

  it('页头说明文案含「数据位置」（设置页导航面同步）', () => {
    render();
    expect(container.querySelector('.page-desc')?.textContent).toContain('数据位置');
  });

  it('条件位置口径文案在卡内可见（重启生效 / 目标须空目录 / 旧位置与备份保留）', () => {
    setBridge(makeFake().fake);
    render();
    const text = card()!.textContent!;
    expect(text).toContain('重启');
    expect(text).toContain('空目录');
    expect(text).toContain('备份');
  });

  it('点击更改成功 → 桥被调一次 + 成功 banner 含重启提示与新位置', async () => {
    const { fake, calls } = makeFake();
    setBridge(fake);
    render();
    await waitFor(() => current() !== null, '当前位置未渲染');

    flushSync(() => changeBtn()!.click());
    await waitFor(() => banner() !== null, '成功 banner 未出现');

    expect(calls.filter((c) => c === 'change').length).toBe(1);
    expect(banner()?.getAttribute('data-type')).toBe('success');
    expect(banner()?.textContent).toContain('重启');
    expect(banner()?.textContent).toContain('D:\\mofang-data');
    // 登记后待迁移行出现 + 取消迁移按钮出现
    await waitFor(() => pending() !== null, '待迁移行未出现');
    expect(pending()!.textContent).toContain('D:\\mofang-data');
    expect(cancelBtn()).not.toBeNull();
  });

  it('被拒（非空目录等）→ 错误 banner 带原因（不静默）', async () => {
    const { fake } = makeFake({ change: async () => ({ success: false, error: '目标目录非空（必须选空目录或不存在的路径，请先清空或另选）' }) });
    setBridge(fake);
    render();
    await waitFor(() => current() !== null, '当前位置未渲染');

    flushSync(() => changeBtn()!.click());
    await waitFor(() => banner() !== null, '失败 banner 未出现');

    expect(banner()?.getAttribute('data-type')).toBe('error');
    expect(banner()?.textContent).toContain('非空');
    expect(pending()).toBeNull();
  });

  it('用户取消目录选择 → 不弹 banner（无变更即无提示）', async () => {
    const { fake } = makeFake({ change: async () => ({ success: false, canceled: true }) });
    setBridge(fake);
    render();
    await waitFor(() => current() !== null, '当前位置未渲染');

    flushSync(() => changeBtn()!.click());
    await vi.waitFor(
      () => {
        if (!container.textContent!.includes('D:\\mofang-data')) throw new Error('尚未返回');
      },
      { timeout: 300, interval: 50 },
    ).catch(() => undefined);
    expect(banner()).toBeNull();
    expect(pending()).toBeNull();
  });

  it('撤销待迁移：有 pending 时才出按钮，点击后待迁移行消失 + 成功提示', async () => {
    const { fake, calls } = makeFake({
      info: { ...INFO, pendingDataRoot: 'D:\\mofang-data' },
    });
    setBridge(fake);
    render();
    await waitFor(() => pending() !== null, '待迁移行未出现');
    expect(cancelBtn()).not.toBeNull();

    flushSync(() => cancelBtn()!.click());
    await waitFor(() => banner() !== null, '取消成功 banner 未出现');

    expect(calls).toContain('cancel');
    expect(banner()?.getAttribute('data-type')).toBe('success');
    expect(pending()).toBeNull();
  });

  it('上次迁移失败留痕 → 卡内可见（用户知道迁移没成，仍在旧位置）', async () => {
    const { fake } = makeFake({
      info: { ...INFO, pendingDataRoot: 'D:\\mofang-data', lastMigrationError: '迁移校验未通过：目标缺文件：data/bank.db' },
    });
    setBridge(fake);
    render();
    await waitFor(() => lastError() !== null, '失败留痕未渲染');

    expect(lastError()!.textContent).toContain('上次迁移未完成');
    expect(lastError()!.textContent).toContain('目标缺文件');
  });

  it('桥抛异常 → 错误 banner（IPC 失败必须可见）', async () => {
    const { fake } = makeFake({ change: async () => { throw new Error('主进程未就绪'); } });
    setBridge(fake);
    render();
    await waitFor(() => current() !== null, '当前位置未渲染');

    flushSync(() => changeBtn()!.click());
    await waitFor(() => banner() !== null, '异常 banner 未出现');

    expect(banner()?.getAttribute('data-type')).toBe('error');
    expect(banner()?.textContent).toContain('主进程未就绪');
  });
});
