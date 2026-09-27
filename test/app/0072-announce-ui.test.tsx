// 0072（R-073 发布批 lane A / D-088 呈现层口径）：公告中心 UI ——
// 左下入口按钮（设置上方，无桥不渲染，未读红点）+ 公告弹窗（三来源标记 / level 配色 / 二维码缺省态 /
// 条目 links / 关闭与「今日不再提醒」抑制 / 新 urgent id 破抑制 / 更新可用合成条目置顶）。
//
// 环境：jsdom；假桥注入走 window.__mofangAnnounce / window.__mofangUpdate（与真机同取用路径）。
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import {
  AnnounceCenter,
  shouldAutoOpen,
  ANNOUNCE_MUTED_DATE_KEY,
  ANNOUNCE_READ_IDS_KEY,
} from '../../src/app/components/AnnounceCenter.js';
import { MF_DIST_BASE } from '../../src/shared/endpoints.js';
import type { AnnounceSnapshot } from '../../src/shared/contracts/distribution-types.js';
import type { MofangAnnounceBridge, MofangUpdateBridge } from '../../src/shared/contracts/bridge.js';

let container: HTMLDivElement;
let root: Root | null = null;

const flushPromises = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function render(elm: ReactElement = <AnnounceCenter />) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => root!.render(elm));
}

const SNAP_REMOTE: AnnounceSnapshot = {
  source: 'remote',
  data: {
    updatedAt: '2026-09-25T10:00:00Z',
    qrImage: '/assets/qr-group.png',
    messages: [
      { id: 'n1', level: 'info', title: '公告一', body: '正文一' },
      { id: 'n2', level: 'urgent', title: '紧急公告', body: '正文二', links: [{ text: '详情', url: 'https://x.example/a' }] },
    ],
  },
};

function makeAnnounceBridge(snap: AnnounceSnapshot) {
  return {
    get: async () => snap,
    refresh: async () => snap,
  } as unknown as MofangAnnounceBridge;
}

function setBridges(announce: MofangAnnounceBridge | undefined, update?: MofangUpdateBridge): void {
  const w = window as unknown as { __mofangAnnounce?: MofangAnnounceBridge; __mofangUpdate?: MofangUpdateBridge };
  delete w.__mofangAnnounce;
  delete w.__mofangUpdate;
  if (announce) w.__mofangAnnounce = announce;
  if (update) w.__mofangUpdate = update;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  root?.unmount();
  root = null;
  if (container) container.remove();
  localStorage.clear();
});

// ---------------- shouldAutoOpen 纯函数（自动弹出判据口径） ----------------

describe('0072 shouldAutoOpen（D-088 口径：内置兜底不弹；今日不再提醒抑制；新 urgent id 破抑制）', () => {
  const today = '2026-09-25';

  it('纯内置兜底（builtin）不弹', () => {
    const snap: AnnounceSnapshot = { source: 'builtin', data: { updatedAt: 'x', messages: [{ id: 'b', level: 'info', title: 't', body: 'b' }] } };
    expect(shouldAutoOpen(snap, null, [], today)).toBe(false);
  });

  it('无生效公告（空 messages）不弹', () => {
    const snap: AnnounceSnapshot = { source: 'remote', data: { updatedAt: 'x', messages: [] } };
    expect(shouldAutoOpen(snap, null, [], today)).toBe(false);
  });

  it('remote/cache 有未读 → 弹', () => {
    expect(shouldAutoOpen(SNAP_REMOTE, null, [], today)).toBe(true);
    expect(shouldAutoOpen({ ...SNAP_REMOTE, source: 'cache' }, null, [], today)).toBe(true);
  });

  it('全部已读（普通公告）→ 不弹（已读抑制）', () => {
    expect(shouldAutoOpen(SNAP_REMOTE, null, ['n1', 'n2'], today)).toBe(false);
  });

  it('今日已静音 + 新普通 id 未读 → 不弹（今日不再提醒抑制）', () => {
    const snap: AnnounceSnapshot = { source: 'remote', data: { updatedAt: 'x', messages: [{ id: 'fresh-info', level: 'info', title: 't', body: 'b' }] } };
    expect(shouldAutoOpen(snap, today, ['n1', 'n2'], today)).toBe(false);
  });

  it('今日已静音 + 新 urgent id 未读 → 仍弹（破抑制）', () => {
    const snap: AnnounceSnapshot = { source: 'remote', data: { updatedAt: 'x', messages: [{ id: 'fresh-urgent', level: 'urgent', title: 't', body: 'b' }] } };
    expect(shouldAutoOpen(snap, today, ['n1'], today)).toBe(true);
  });

  it('昨日静音（mutedDate≠today）→ 恢复提醒', () => {
    const snap: AnnounceSnapshot = { source: 'cache', data: { updatedAt: 'x', messages: [{ id: 'y-info', level: 'info', title: 't', body: 'b' }] } };
    expect(shouldAutoOpen(snap, '2026-09-24', ['n1'], today)).toBe(true);
  });
});

// ---------------- 入口按钮与未读标 ----------------

describe('0072 公告入口（左下固定区，AppShell 内）', () => {
  it('无 announce 桥 → 组件不渲染（浏览器 demo / 测试零扰动）', () => {
    setBridges(undefined);
    render();
    expect(container.querySelector('[data-testid="nav-announce"]')).toBeNull();
  });

  it('有桥：入口按钮渲染，有未读且今日静音（不自动弹）时带未读标', async () => {
    // 静音今日 → 挂载不自动弹（弹窗不出现）→ 未读标保留（未读判定与弹窗抑制是两个独立机制）
    const n = new Date();
    const today = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
    localStorage.setItem(ANNOUNCE_MUTED_DATE_KEY, today);
    // 全 info 快照（若含 urgent 则破抑制仍会弹——那是不变式用例的职责）
    const infoOnly: AnnounceSnapshot = { source: 'remote', data: { updatedAt: 'x', messages: [{ id: 'n1', level: 'info', title: '公告一', body: '正文一' }] } };
    setBridges(makeAnnounceBridge(infoOnly));
    render();
    await flushPromises();
    flushSync(() => root!.render(<AnnounceCenter />));
    expect(container.querySelector('[data-testid="nav-announce"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="announce-modal"]')).toBeNull();
    expect(container.querySelector('[data-testid="announce-unread-dot"]')).not.toBeNull();
  });

  it('全部已读后重新挂载：无未读标', async () => {
    localStorage.setItem(ANNOUNCE_READ_IDS_KEY, JSON.stringify(['n1', 'n2']));
    setBridges(makeAnnounceBridge(SNAP_REMOTE));
    render();
    await flushPromises();
    expect(container.querySelector('[data-testid="announce-unread-dot"]')).toBeNull();
  });
});

// ---------------- 公告弹窗 ----------------

describe('0072 公告弹窗（点击入口打开）', () => {
  it('弹窗渲染：公告列表 + level 配色标记 + 条目 links + 来源标记', async () => {
    setBridges(makeAnnounceBridge(SNAP_REMOTE));
    render();
    await flushPromises();
    flushSync(() => (container.querySelector('[data-testid="nav-announce"]') as HTMLButtonElement).click());
    const modal = container.querySelector('[data-testid="announce-modal"]');
    expect(modal).not.toBeNull();
    expect(modal!.textContent).toContain('公告一');
    expect(modal!.textContent).toContain('紧急公告');
    expect(container.querySelector('[data-testid="announce-message-urgent"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="announce-message-info"]')).not.toBeNull();
    const link = container.querySelector('[data-testid="announce-link-1"]') as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.getAttribute('href')).toBe('https://x.example/a');
    expect(modal!.textContent).toContain('远程');
  });

  it('二维码：qrImage 拼 MF_DIST_BASE 成绝对 URL；缺省态占位文案不裂图', async () => {
    setBridges(makeAnnounceBridge(SNAP_REMOTE));
    render();
    await flushPromises();
    flushSync(() => (container.querySelector('[data-testid="nav-announce"]') as HTMLButtonElement).click());
    const qr = container.querySelector('[data-testid="announce-qr"]') as HTMLImageElement;
    expect(qr).not.toBeNull();
    expect(qr.getAttribute('src')).toBe(`${MF_DIST_BASE}/assets/qr-group.png`);

    const noQr: AnnounceSnapshot = { source: 'remote', data: { updatedAt: 'x', messages: [{ id: 'm', level: 'info', title: 't', body: 'b' }] } };
    setBridges(makeAnnounceBridge(noQr));
    root!.unmount();
    render();
    await flushPromises();
    flushSync(() => (container.querySelector('[data-testid="nav-announce"]') as HTMLButtonElement).click());
    expect(container.querySelector('[data-testid="announce-qr"]')).toBeNull();
    expect(container.querySelector('[data-testid="announce-qr-placeholder"]')).not.toBeNull();
  });

  it('点开即记已读：关闭后红点消失（readIds 落 localStorage）', async () => {
    setBridges(makeAnnounceBridge(SNAP_REMOTE));
    render();
    await flushPromises();
    flushSync(() => (container.querySelector('[data-testid="nav-announce"]') as HTMLButtonElement).click());
    flushSync(() => (container.querySelector('[data-testid="announce-close"]') as HTMLButtonElement).click());
    const readIds = JSON.parse(localStorage.getItem(ANNOUNCE_READ_IDS_KEY) ?? '[]') as string[];
    expect(readIds).toEqual(expect.arrayContaining(['n1', 'n2']));
    expect(container.querySelector('[data-testid="announce-unread-dot"]')).toBeNull();
  });

  it('勾选「今日不再提醒」后关闭：记日历日；重启（重新挂载）不再自动弹', async () => {
    setBridges(makeAnnounceBridge(SNAP_REMOTE));
    render();
    await flushPromises();
    flushSync(() => (container.querySelector('[data-testid="nav-announce"]') as HTMLButtonElement).click());
    const checkbox = container.querySelector('[data-testid="announce-mute-today"]') as HTMLInputElement;
    flushSync(() => checkbox.click());
    expect(checkbox.checked).toBe(true);
    flushSync(() => (container.querySelector('[data-testid="announce-close"]') as HTMLButtonElement).click());
    expect(localStorage.getItem(ANNOUNCE_MUTED_DATE_KEY)).toBeTruthy();

    // 重启 = 重新挂载
    root!.unmount();
    render();
    await flushPromises();
    expect(container.querySelector('[data-testid="announce-modal"]')).toBeNull();
  });

  it('不勾选直接关闭：不写静音日（次日/重启仍提醒新公告）', async () => {
    setBridges(makeAnnounceBridge(SNAP_REMOTE));
    render();
    await flushPromises();
    flushSync(() => (container.querySelector('[data-testid="nav-announce"]') as HTMLButtonElement).click());
    flushSync(() => (container.querySelector('[data-testid="announce-close"]') as HTMLButtonElement).click());
    expect(localStorage.getItem(ANNOUNCE_MUTED_DATE_KEY)).toBeNull();
  });
});

// ---------------- 启动自动弹出与更新合成条目 ----------------

describe('0072 启动自动弹出与「新版本可用」合成条目', () => {
  it('挂载即有生效公告（缓存命中态）且未被抑制 → 自动弹一次', async () => {
    setBridges(makeAnnounceBridge(SNAP_REMOTE));
    render();
    await flushPromises();
    expect(container.querySelector('[data-testid="announce-modal"]')).not.toBeNull();
  });

  it('纯内置兜底（builtin）不自动弹，入口可点开看兜底内容', async () => {
    const builtin: AnnounceSnapshot = { source: 'builtin', data: { updatedAt: 'x', messages: [{ id: 'b', level: 'info', title: '内置', body: '兜底' }] } };
    setBridges(makeAnnounceBridge(builtin));
    render();
    await flushPromises();
    expect(container.querySelector('[data-testid="announce-modal"]')).toBeNull();
    flushSync(() => (container.querySelector('[data-testid="nav-announce"]') as HTMLButtonElement).click());
    expect(container.querySelector('[data-testid="announce-modal"]')).not.toBeNull();
  });

  it('update available → 弹窗内置顶「新版本」合成条目（本地生成，非公告数据）', async () => {
    const updateBridge = {
      getStatus: async () => ({ phase: 'available', version: '1.0.1' }),
      checkNow: async () => ({ started: true }),
      openExternal: async () => ({ ok: true }),
      onStatus: () => () => {},
    } as unknown as MofangUpdateBridge;
    setBridges(makeAnnounceBridge(SNAP_REMOTE), updateBridge);
    render();
    await flushPromises();
    expect(container.querySelector('[data-testid="announce-modal"]')).not.toBeNull();
    const entry = container.querySelector('[data-testid="announce-update-entry"]');
    expect(entry).not.toBeNull();
    expect(entry!.textContent).toContain('1.0.1');
    // 置顶：合成条目在公告条目之前
    const modal = container.querySelector('[data-testid="announce-modal"]')!;
    const firstEntry = modal.querySelector('[data-testid^="announce-"]');
    expect(firstEntry).toBe(entry);
  });
});
