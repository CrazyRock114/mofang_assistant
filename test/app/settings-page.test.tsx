// 0010-merge P2.8：设置页 v0 验收——外观（主题三档，与导航开关同机制同 key）+ 关于（完整 Logo、
// 产品名、标语、版本号读 package.json）；禁放死按钮（备份/账号等未做功能不出现）。
// 0016 授权改写（任务书 §二 P2.6）：设置页新增「字典映射/树映射」只读+指认块——
// 禁词清单移除「字典」，按钮数改「外观 3 + 指认按钮数动态」口径（指认按钮仅在存在未知行时出现）。
// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import { SettingsPage } from '../../src/app/pages/SettingsPage.js';
import { THEME_KEY } from '../../src/app/theme.js';
import { createMockExtServices } from '../../src/bank/mock/mock-ext.js';
import { MockBankStore } from '../../src/bank/mock/mock-store.js';
import type { MofangGuardBridge } from '../../src/shared/contracts/bridge.js';

let container: HTMLDivElement;
let root: Root | null = null;

function render(ui: ReactElement = <SettingsPage />) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => root!.render(ui));
}

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  localStorage.removeItem(THEME_KEY);
  document.documentElement.removeAttribute('data-theme');
});

describe('0010-merge P2.8 设置页 v0', () => {
  it('页题「设置」；外观块 = 主题三档开关（与导航开关同机制同 key）', () => {
    render();
    expect(container.querySelector('.page-title')!.textContent).toBe('设置');
    for (const tier of ['warm', 'light', 'dark']) {
      expect(container.querySelector(`[data-testid="settings-theme-switch-${tier}"]`)).not.toBeNull();
    }
    flushSync(() => (container.querySelector('[data-testid="settings-theme-switch-dark"]') as HTMLButtonElement).click());
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem(THEME_KEY)).toBe('dark');
  });

  it('关于块：完整 logo-full 图 + 产品名 + 标语 + 版本号读 package.json', () => {
    render();
    const logo = container.querySelector('[data-testid="about-logo-full"]') as HTMLImageElement;
    expect(logo).not.toBeNull();
    expect(logo.getAttribute('src')).toContain('logo-full');
    expect(container.textContent).toContain('魔方助教');
    expect(container.textContent).toContain('让每一位老师更轻松');
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8')) as { version: string };
    expect(container.querySelector('[data-testid="about-version"]')!.textContent).toBe(`版本：${pkg.version}`);
  });

  it('禁放死按钮（0016 授权改写+返工1；0037 目检返工 #6 备份真功能迁入，摘出禁词）：账号/登录/同步零占位；空字典基线 = 主题 3 钮 + 映射入口 1 钮', () => {
    render();
    const text = container.textContent!;
    for (const banned of ['账号', '登录', '同步']) {
      expect(text.includes(banned), `不得出现「${banned}」`).toBe(false);
    }
    // 基线形态（目检返工 1：映射收进入口卡）：主题三档 ×3 + 「查看映射」入口 ×1，无指认按钮
    // （0037 返工 #6：备份卡经 guard 桥在场才渲染，无桥基线不计入）
    const themeBtns = [...container.querySelectorAll('button')].filter((b) => b.dataset.themeBtn !== undefined);
    expect(themeBtns.length).toBe(3);
    expect(container.querySelector('[data-testid="settings-mapping-open"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="settings-dict-assign-btn"]')).toBeNull();
  });

  it('0016：存在未知行时指认按钮出现（mock 注入，动态口径另一侧）', async () => {
    const ext = createMockExtServices(new MockBankStore());
    await ext.dict.createEntry({ kind: 'subject', code: 'physics', label: '物理' });
    await ext.dict.createEntry({
      kind: 'subject', code: '', label: '玄学', site: 'jyeoo', sourceLabel: 'xuanxue0', active: false,
    });
    render(<SettingsPage ext={ext} />);
    // 目检返工 1：映射条目收进入口卡详情视图，先经入口进入
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="settings-mapping-open"]')).not.toBeNull();
    }, { timeout: 3000, interval: 20 });
    flushSync(() => (container.querySelector('[data-testid="settings-mapping-open"]') as HTMLButtonElement).click());
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="settings-dict-assign-btn"]')).not.toBeNull();
    }, { timeout: 3000, interval: 20 });
  });
});

// 0037 目检返工 #6：数据备份自首页迁入设置页（guard 桥在场才渲染；能力与原首页备份卡等强：
// 立即备份 / 从备份恢复（先预览弹层再确认，禁 confirm）/ 结果消息条）
describe('0037 返工 #6：设置页数据备份卡', () => {
  function makeGuardFake(): { guard: MofangGuardBridge; calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      guard: {
        getDashboard: () => Promise.reject(new Error('not needed in test')),
        getStats: async () => ({ questions: 12, papers: 3, assets: 7 }),
        createBackup: () => {
          calls.push('createBackup');
          return Promise.resolve({
            success: true,
            backupPath: 'C:\\backup\\bank.db.bak',
            manifest: { backup_id: 'b1', created_at: '2026-09-21T00:00:00Z', counts: { questions: 12, papers: 3, assets: 7 } },
          });
        },
        restoreBackup: (payload: { confirmed: boolean }) => {
          calls.push(`restoreBackup:${String(payload.confirmed)}`);
          if (!payload.confirmed) {
            return Promise.resolve({ success: true, needsConfirmation: true, restored: undefined, error: undefined, manifest: undefined });
          }
          return Promise.resolve({
            success: true, restored: { questions: 12, papers: 3, assets: 7 }, error: undefined, needsConfirmation: undefined, manifest: undefined,
          });
        },
      } as MofangGuardBridge,
    };
  }

  it('备份卡在场：标题「数据备份」+ 立即备份/从备份恢复按钮 + 当前数据行', async () => {
    const { guard } = makeGuardFake();
    render(<SettingsPage guard={guard} />);
    await vi.waitFor(() => {
      if (!container.querySelector('[data-testid="settings-backup-card"]')) throw new Error('备份卡未渲染');
    }, { timeout: 3000, interval: 20 });
    expect(container.querySelector('[data-testid="settings-backup-btn"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="settings-restore-btn"]')).not.toBeNull();
    await vi.waitFor(() => {
      if (!(container.querySelector('[data-testid="settings-backup-card"]')!.textContent ?? '').includes('题目 12')) {
        throw new Error('当前数据行未渲染');
      }
    }, { timeout: 3000, interval: 20 });
  });

  it('立即备份 → 走 guard.createBackup → 成功消息可见（IPC 失败不允许静默）', async () => {
    const { guard, calls } = makeGuardFake();
    render(<SettingsPage guard={guard} />);
    await vi.waitFor(() => {
      if (!container.querySelector('[data-testid="settings-backup-btn"]')) throw new Error('备份按钮未渲染');
    }, { timeout: 3000, interval: 20 });
    flushSync(() => (container.querySelector('[data-testid="settings-backup-btn"]') as HTMLButtonElement).click());
    await vi.waitFor(() => {
      const banner = container.querySelector('[data-testid="page-message"]');
      if (!banner || !(banner.textContent ?? '').includes('备份成功')) throw new Error('成功消息未出现');
    }, { timeout: 3000, interval: 20 });
    expect(calls).toContain('createBackup');
  });

  it('恢复两段式：先预览弹层（规模可见）→ 确认后走 confirmed:true', async () => {
    const { guard, calls } = makeGuardFake();
    render(<SettingsPage guard={guard} />);
    await vi.waitFor(() => {
      if (!container.querySelector('[data-testid="settings-restore-btn"]')) throw new Error('恢复按钮未渲染');
    }, { timeout: 3000, interval: 20 });
    flushSync(() => (container.querySelector('[data-testid="settings-restore-btn"]') as HTMLButtonElement).click());
    // 第一步：预览弹层（自绘，禁 confirm）
    await vi.waitFor(() => {
      if (!container.querySelector('[data-testid="restore-confirm-btn"]')) throw new Error('恢复确认弹层未出现');
    }, { timeout: 3000, interval: 20 });
    expect(container.textContent).toContain('确认恢复数据');
    flushSync(() => (container.querySelector('[data-testid="restore-confirm-btn"]') as HTMLButtonElement).click());
    await vi.waitFor(() => {
      const banner = container.querySelector('[data-testid="page-message"]');
      if (!banner || !(banner.textContent ?? '').includes('恢复成功')) throw new Error('恢复成功消息未出现');
    }, { timeout: 3000, interval: 20 });
    expect(calls).toEqual(['restoreBackup:false', 'restoreBackup:true']);
  });
});
