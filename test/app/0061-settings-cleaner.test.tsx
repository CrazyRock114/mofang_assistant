// 0061 设置页「存储清理」卡（R-057 / D-072①）：手动扫描 → 预览弹层 → 确认移入回收目录 → 结果条。
// 假桥注入走 window.__mofangFile（与真机同取用路径；卡在无桥环境整卡不渲染，故既有设置页基线零扰动）。
// @vitest-environment jsdom

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import { SettingsPage } from '../../src/app/pages/SettingsPage.js';
import type { MofangFileBridge } from '../../src/shared/contracts/bridge.js';

let container: HTMLDivElement;
let root: Root | null = null;

function render(ui: ReactElement = <SettingsPage />) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => root!.render(ui));
}

const REL_A = `recog/${'a'.repeat(32)}.png`;
const REL_B = `recog/${'b'.repeat(32)}.png`;

function makeFileFake(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: string[] = [];
  const fake = {
    scanRecogAssetGarbage: async () => {
      calls.push('scan');
      return {
        orphans: [{ relPath: REL_A, bytes: 1_048_576 }, { relPath: REL_B, bytes: 524_288 }],
        totalBytes: 1_572_864,
        referencedCount: 3,
        scannedCount: 5,
      };
    },
    trashRecogAssets: async (payload: { relPaths: string[] }) => {
      calls.push(`trash:${payload.relPaths.join(',')}`);
      return { moved: payload.relPaths.length, bytes: 1_572_864, trashDir: 'C:\\data\\assets\\_trash\\20260923-101500' };
    },
    ...overrides,
  };
  return { fake: fake as unknown as MofangFileBridge, calls };
}

function setBridge(bridge: MofangFileBridge | undefined): void {
  if (bridge === undefined) delete (window as { __mofangFile?: MofangFileBridge }).__mofangFile;
  else (window as { __mofangFile?: MofangFileBridge }).__mofangFile = bridge;
}

const card = () => container.querySelector('[data-testid="settings-cleaner-card"]');
const banner = () => container.querySelector('[data-testid="page-message"]')?.textContent ?? '';

async function waitFor(fn: () => boolean, label: string): Promise<void> {
  await vi.waitFor(() => {
    if (!fn()) throw new Error(label);
  }, { timeout: 3000, interval: 20 });
}

beforeEach(() => { setBridge(makeFileFake().fake); });

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  setBridge(undefined);
  localStorage.clear();
});

describe('0061 设置页存储清理卡', () => {
  it('卡在场：标题「存储清理」+ 说明 + 扫描按钮；无桥环境整卡不渲染（零死按钮）', () => {
    render();
    expect(card()).not.toBeNull();
    expect(card()!.textContent).toContain('存储清理');
    expect(card()!.textContent).toContain('不再被任何题目/试卷/草稿引用');
    expect(container.querySelector('[data-testid="settings-cleaner-scan"]')).not.toBeNull();

    root!.unmount();
    container.remove();
    setBridge(undefined);
    render();
    expect(card()).toBeNull();
  });

  it('扫描 → 预览弹层：未引用文件数 + 总大小 + 前 10 条文件名；不点确认不动文件', async () => {
    render();
    flushSync(() => (container.querySelector('[data-testid="settings-cleaner-scan"]') as HTMLButtonElement).click());
    await waitFor(() => container.querySelector('[data-testid="settings-cleaner-preview"]') !== null, '预览弹层未出现');
    const modal = container.querySelector('[data-testid="settings-cleaner-preview"]')!;
    expect(modal.textContent).toContain('发现 2 个未引用文件');
    expect(modal.textContent).toContain('1.5 MB');
    expect(modal.textContent).toContain(REL_A.slice('recog/'.length, 'recog/'.length + 8));
  });

  it('确认 → trashRecogAssets 收到扫描出的 relPaths → 成功条（数量/释放空间/回收目录）', async () => {
    const { fake, calls } = makeFileFake();
    setBridge(fake);
    render();
    flushSync(() => (container.querySelector('[data-testid="settings-cleaner-scan"]') as HTMLButtonElement).click());
    await waitFor(() => container.querySelector('[data-testid="settings-cleaner-confirm"]') !== null, '确认按钮未出现');
    flushSync(() => (container.querySelector('[data-testid="settings-cleaner-confirm"]') as HTMLButtonElement).click());
    await waitFor(() => banner().includes('已移入回收目录'), '成功条未出现');
    expect(calls).toContain(`trash:${REL_A},${REL_B}`);
    expect(banner()).toContain('2 个文件');
    expect(banner()).toContain('1.5 MB');
    expect(banner()).toContain('_trash\\20260923-101500');
    expect(container.querySelector('[data-testid="settings-cleaner-preview"]')).toBeNull();
  });

  it('取消 = 零动作（不调 trash）', async () => {
    const { fake, calls } = makeFileFake();
    setBridge(fake);
    render();
    flushSync(() => (container.querySelector('[data-testid="settings-cleaner-scan"]') as HTMLButtonElement).click());
    await waitFor(() => container.querySelector('[data-testid="settings-cleaner-cancel"]') !== null, '取消按钮未出现');
    flushSync(() => (container.querySelector('[data-testid="settings-cleaner-cancel"]') as HTMLButtonElement).click());
    await waitFor(() => container.querySelector('[data-testid="settings-cleaner-preview"]') === null, '弹层未关闭');
    expect(calls.filter((c) => c.startsWith('trash:'))).toEqual([]);
  });

  it('N=0 分支：不弹确认层，只提示无可清理', async () => {
    const { fake } = makeFileFake({
      scanRecogAssetGarbage: async () => ({ orphans: [], totalBytes: 0, referencedCount: 4, scannedCount: 4 }),
    });
    setBridge(fake);
    render();
    flushSync(() => (container.querySelector('[data-testid="settings-cleaner-scan"]') as HTMLButtonElement).click());
    await waitFor(() => banner().includes('未发现'), '零结果提示未出现');
    expect(container.querySelector('[data-testid="settings-cleaner-preview"]')).toBeNull();
    expect(banner()).toContain('无需清理');
  });

  it('失败分支不静默：扫描异常 / 执行异常各出错误条', async () => {
    const { fake } = makeFileFake({
      scanRecogAssetGarbage: async () => { throw new Error('IPC 扫描失败'); },
      trashRecogAssets: async () => { throw new Error('IPC 移动失败'); },
    });
    setBridge(fake);
    render();
    flushSync(() => (container.querySelector('[data-testid="settings-cleaner-scan"]') as HTMLButtonElement).click());
    await waitFor(() => banner().includes('IPC 扫描失败'), '扫描错误条未出现');

    // 执行失败：换回正常扫描、坏掉的 trash
    const second = makeFileFake({ trashRecogAssets: async () => { throw new Error('IPC 移动失败'); } });
    setBridge(second.fake);
    root!.unmount();
    container.remove();
    render();
    flushSync(() => (container.querySelector('[data-testid="settings-cleaner-scan"]') as HTMLButtonElement).click());
    await waitFor(() => container.querySelector('[data-testid="settings-cleaner-confirm"]') !== null, '确认按钮未出现');
    flushSync(() => (container.querySelector('[data-testid="settings-cleaner-confirm"]') as HTMLButtonElement).click());
    await waitFor(() => banner().includes('IPC 移动失败'), '执行错误条未出现');
  });
});
