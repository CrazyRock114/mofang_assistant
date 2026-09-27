// 0067 顺手修复（用户 2026-09-24 授权）：入库结果条「查看题库」跳错页。
// 原实现写死 `window.location.hash = '#/'`（首页工作台），题库管理路由是 `#/bank`
// （main.tsx:79 分发 + AppShell NAV_ITEMS 'bank' 条目 href='#/bank'）。
// 断言不写死字符串魔法值：以 NAV_ITEMS 的 bank 条目为路由单一来源（href 与 match 双口径）。
// @vitest-environment jsdom

import { describe, it, expect, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import { CapturePage } from '../../src/app/pages/CapturePage.js';
import { CaptureClient } from '../../src/app/services/capture-client.js';
import { NAV_ITEMS, resolveActiveKey } from '../../src/app/components/AppShell.js';
import { MockBankService } from '../../src/bank/mock/mock-bank.js';
import { createMockExtServices } from '../../src/bank/mock/mock-ext.js';
import { MockBankStore } from '../../src/bank/mock/mock-store.js';
import type { ExtPageServices } from '../../src/app/pages/ExtUi.js';

let container: HTMLDivElement;
let root: Root | null = null;

function render(client?: CaptureClient, svc?: ExtPageServices) {
  root?.unmount();
  root = null;
  container?.remove();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => {
    root!.render(<CapturePage capture={client} pollIntervalMs={1000} svc={svc} />);
  });
}

function createSvc(): ExtPageServices {
  const store = new MockBankStore();
  return { bank: new MockBankService(store, false), ext: createMockExtServices(store) };
}

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  delete window.__mofangPaths;
  window.location.hash = '';
});

const BROWSER_TAB_BTNS = ['组卷网', '菁优网', '导出试题篮'];
function ensureBrowserTab() {
  const panelBtn = container.querySelector('[data-testid="capture-tab-panel"]') as HTMLButtonElement | null;
  if (panelBtn && panelBtn.className.includes('btn-primary')) {
    const browserBtn = container.querySelector('[data-testid="capture-tab-browser"]') as HTMLButtonElement;
    flushSync(() => browserBtn.click());
  }
}
function btn(text: string): HTMLButtonElement {
  if (BROWSER_TAB_BTNS.includes(text)) ensureBrowserTab();
  const b = [...container.querySelectorAll('button')].find((x) => x.textContent === text);
  if (!b) throw new Error(`找不到按钮: ${text}`);
  return b as HTMLButtonElement;
}
/** 切到「采集界面」标签页（采集组件所在；幂等） */
function openPanel() {
  const b = container.querySelector('[data-testid="capture-tab-panel"]') as HTMLButtonElement | null;
  if (!b) throw new Error('找不到「采集界面」标签');
  if (!b.className.includes('btn-primary')) flushSync(() => b.click());
}
/** 状态语义读浏览器页顶部栏（地址/站点/登录灯）——与 capture-page.test 同源口径 */
function statusBarText(): string {
  ensureBrowserTab();
  const addr = container.querySelector('[data-testid="capture-address"]');
  const badge = container.querySelector('[data-testid="capture-site-badge"]');
  const light = container.querySelector('[data-testid="capture-login-light"]');
  return `${addr?.textContent ?? ''} ${badge?.textContent ?? ''} ${light?.textContent ?? ''} ${light?.getAttribute('title') ?? ''}`;
}
async function waitFor(assertion: () => void) {
  const { vi } = await import('vitest');
  await vi.waitFor(assertion, { timeout: 2000, interval: 20 });
}

const bankNav = NAV_ITEMS.find((i) => i.key === 'bank')!;
const homeNav = NAV_ITEMS.find((i) => i.key === 'home')!;

describe('0067 顺手修复：入库后「查看题库」跳题库管理页（#/bank），不再回首页', () => {
  it('点「查看题库」→ hash = 题库路由（且落进 bank 导航、不落 home 导航）', async () => {
    render(new CaptureClient(), createSvc());
    flushSync(() => btn('组卷网').click());
    await waitFor(() => expect(statusBarText()).toContain('组卷网'));
    flushSync(() => btn('导出试题篮').click());
    openPanel();
    await waitFor(() => expect(container.querySelectorAll('[data-testid^="capture-item-"]').length).toBe(3));

    openPanel();
    flushSync(() => btn('入库').click());
    await waitFor(() => expect(container.querySelector('[data-testid="collect-ok"]')!.textContent).toBe('3'));

    const goto = container.querySelector('[data-testid="goto-bank"]') as HTMLElement;
    expect(goto).not.toBeNull();
    expect(goto.textContent).toBe('查看题库');
    flushSync(() => goto.click());

    expect(window.location.hash).toBe(bankNav.href);          // 路由单一来源：题库导航 href
    expect(window.location.hash).not.toBe(homeNav.href);      // 不再是首页
    expect(bankNav.match(window.location.hash)).toBe(true);   // 落地被题库条目命中
    expect(homeNav.match(window.location.hash)).toBe(false);
    expect(resolveActiveKey(window.location.hash)).toBe('bank'); // 侧栏高亮同源口径
  });
});
