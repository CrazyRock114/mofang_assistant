/**
 * 0012 P2：React 顶部采集栏组件测试（mock 桥链路）
 * - 顶部栏内容：页面标识（站点徽标+标题）/地址（只读可复制）/登录态三态灯/前进后退刷新/快捷入口/
 *   导出试题篮/加入当前试题篮（同步入库，toBasket 条件出现）/保存HTML
 * - 事件推送订阅刷新（快路径）；路由离开=detach（closeWindow）；bounds 上报接通
 * @vitest-environment jsdom
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import { CapturePage } from '../../src/app/pages/CapturePage.js';
import { CaptureClient } from '../../src/app/services/capture-client.js';

let container: HTMLDivElement;
let root: Root | null = null;

function render(client: CaptureClient, svc?: never) {
  root?.unmount();
  root = null;
  container?.remove();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => {
    root!.render(<CapturePage capture={client} pollIntervalMs={50} svc={svc} />);
  });
}

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  window.location.hash = '';
});

function findBtn(text: string): HTMLButtonElement | null {
  return ([...container.querySelectorAll('button')].find((x) => x.textContent === text) as HTMLButtonElement | null) ?? null;
}

function btn(text: string): HTMLButtonElement {
  const b = findBtn(text);
  if (!b) throw new Error(`找不到按钮: ${text}`);
  return b;
}

function testid(id: string): HTMLElement {
  const el = container.querySelector(`[data-testid="${id}"]`);
  if (!el) throw new Error(`找不到 testid: ${id}`);
  return el as HTMLElement;
}

/** 切到「采集界面」标签页（采集组件所在；幂等） */
function openPanel() {
  const b = container.querySelector('[data-testid="capture-tab-panel"]') as HTMLButtonElement | null;
  if (!b) throw new Error('找不到「采集界面」标签');
  if (!b.className.includes('btn-primary')) flushSync(() => b.click());
}

async function waitFor(assertion: () => void) {
  await vi.waitFor(assertion, { timeout: 2000, interval: 20 });
}

/** 可编程 mock 桥（带 0012 三通道） */
function makeBridge(overrides: Partial<Record<string, unknown>> = {}) {
  const state = {
    open: false,
    url: '',
    title: '',
    site: null as string | null,
    loggedIn: false,
    lastExtraction: null as { at: string; count: number } | null,
    canGoBack: false,
    canGoForward: false,
  };
  const eventCallbacks: Array<(p: unknown) => void> = [];
  const bridge = {
    async openWindow() { state.open = true; state.url = 'https://zujuan.xkw.com/'; state.site = 'zujuan'; state.title = '组卷网'; state.loggedIn = true; },
    async closeWindow() { state.open = false; },
    async navigate({ url, via }: { url: string; via?: string }) {
      state.open = true;
      if (via === 'url' || !via) {
        state.url = url;
        state.site = /xkw/.test(url) ? 'zujuan' : null;
        state.loggedIn = state.site !== null;
      }
    },
    async getState() { return { ...state }; },
    async extractBasket() {
      const { MOCK_ZUJUAN_EXTRACTION } = await import('../../src/app/capture/mock-capture-data.js');
      return { extracted: MOCK_ZUJUAN_EXTRACTION };
    },
    async collect() { return { ok: 0, dup: 0, failed: [] }; },
    async getLastExtraction() { return { extracted: null }; },
    async setBounds() { /* 记录于 overrides 断言 */ },
    onEvent(cb: (p: unknown) => void) {
      eventCallbacks.push(cb);
      return () => { /* 退订 */ };
    },
    async savePageHtml() { return { ok: false, error: 'mock 不支持' }; },
    ...overrides,
  };
  return { bridge, state, eventCallbacks };
}

describe('0012 P2：React 顶部采集栏', () => {
  it('0012 返工 2：第一行=返回+三页签；第二行=精简浏览器控件（无开窗/保存HTML/页面标题）', async () => {
    const { bridge } = makeBridge();
    render(new CaptureClient(bridge as never));

    expect(testid('capture-header-back')).not.toBeNull(); // 0012 返工 5：页头「← 返回」
    expect(testid('capture-back-btn')).not.toBeNull();
    for (const id of ['capture-tab-panel', 'capture-tab-browser', 'capture-tab-paper', 'capture-address', 'capture-site-badge', 'capture-login-light', 'capture-nav-back', 'capture-nav-forward', 'capture-nav-reload', 'capture-extract-btn']) {
      expect(testid(id)).not.toBeNull();
    }
    expect(findBtn('组卷网')).not.toBeNull();
    expect(findBtn('菁优网')).not.toBeNull();
    expect(testid('capture-goto-paper-btn')).not.toBeNull();
    expect(testid('capture-close-browser-btn')).not.toBeNull();
    // 页签顺序：浏览器居首（返工 3：导航进入先见浏览器页）
    const tabs = ['capture-tab-browser', 'capture-tab-panel', 'capture-tab-paper'].map((id) => testid(id));
    expect(tabs[0]!.className).toContain('btn-primary'); // 默认页=浏览器
    for (let i = 1; i < tabs.length; i++) {
      expect(tabs[i - 1]!.compareDocumentPosition(tabs[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    // 返工 2 删除项：开窗/关窗按钮、保存HTML、页面标题、状态卡
    for (const t of ['打开采集窗口', '关闭采集窗口', '保存HTML']) {
      expect(findBtn(t)).toBeNull();
    }
    expect(document.querySelector('[data-testid="capture-save-html"]')).toBeNull();
    expect(document.querySelector('[data-testid="capture-status"]')).toBeNull();
    expect(testid('capture-view-slot')).not.toBeNull();
    expect(testid('capture-slot-empty').textContent).toContain('试题采集');
    expect(testid('capture-slot-empty').textContent).toContain('试卷下载');
  });

  it('快速导航后：站点徽标与地址就位；无 toBasket 时不出现「加入当前试题篮（同步入库）」', async () => {
    const { bridge } = makeBridge();
    render(new CaptureClient(bridge as never));
    flushSync(() => btn('组卷网').click());
    await waitFor(() => {
      expect(testid('capture-site-badge').textContent).toBe('组卷网');
      expect(testid('capture-address').textContent).toContain('zujuan.xkw.com');
    });
    // toBasket 语境按钮仅 toBasket 场景出现
    let threw = false;
    try { testid('capture-collect-btn'); } catch { threw = true; }
    expect(threw).toBe(true);
  });

  it('登录态三态灯：未打开=灰（登录文案「检测中」入 tooltip）；已开已登录=绿；事件推送 loggedIn=false → 红', async () => {
    const { bridge, eventCallbacks } = makeBridge();
    render(new CaptureClient(bridge as never));

    // 0038 返工 2：站点/登录合并为一框后，登录文案不再占框内文字位（文字位让给站点名），
    // 语义改由灯色 data-state + tooltip 承载——断言语义等价（三态不降级）
    expect(testid('capture-login-light').getAttribute('data-state')).toBe('grey');
    expect(testid('capture-login-light').getAttribute('title')).toContain('检测中');

    flushSync(() => btn('组卷网').click());
    await waitFor(() => {
      expect(testid('capture-login-light').getAttribute('data-state')).toBe('green');
      expect(testid('capture-login-light').getAttribute('title')).toContain('已登录');
    });

    // 事件推送快路径：loggedIn=false → 灯转红（无需等轮询）。
    // 高负载下 50ms 轮询会把 getState 的 true 暂时写回 → 在等待窗口内持续重发事件保证确定姓
    await waitFor(() => {
      for (const cb of eventCallbacks) {
        cb({ url: 'https://zujuan.xkw.com/my', title: '我的组卷网', loggedIn: false });
      }
      expect(testid('capture-login-light').getAttribute('data-state')).toBe('red');
      expect(testid('capture-login-light').getAttribute('title')).toContain('未登录');
    }, { timeout: 5000, interval: 10 });
  });

  it('后退/前进按导航栈可用态禁用；点击走 via 通道（back/forward/reload 不重发地址）', async () => {
    const { bridge, state } = makeBridge({
      async navigate({ via }: { url: string; via?: string }) {
        // 状态照常就位（via 记录由 navSpy 断言）
        state.open = true;
        state.url = 'https://zujuan.xkw.com/';
        state.site = 'zujuan';
        state.loggedIn = true;
        void via;
      },
    });
    const client = new CaptureClient(bridge as never);
    const navSpy = vi.spyOn(client, 'navigate');
    render(client);
    flushSync(() => btn('组卷网').click());
    await waitFor(() => expect((testid('capture-address') as HTMLButtonElement).disabled).toBe(false));

    expect((testid('capture-nav-back') as HTMLButtonElement).disabled).toBe(true);
    expect((testid('capture-nav-forward') as HTMLButtonElement).disabled).toBe(true);

    // 可用态由 getState.canGoBack 驱动——直接驱动一次状态
    (bridge as { getState: () => Promise<unknown> }).getState = async () => ({
      open: true, url: 'https://zujuan.xkw.com/', title: '组卷网', site: 'zujuan', loggedIn: true, lastExtraction: null, canGoBack: true, canGoForward: true,
    });
    await waitFor(() => expect((testid('capture-nav-back') as HTMLButtonElement).disabled).toBe(false));

    flushSync(() => (testid('capture-nav-back') as HTMLButtonElement).click());
    flushSync(() => (testid('capture-nav-forward') as HTMLButtonElement).click());
    flushSync(() => (testid('capture-nav-reload') as HTMLButtonElement).click());
    await waitFor(() => expect(navSpy.mock.calls.length).toBeGreaterThanOrEqual(4));
    // 首次为快速导航 via='url'；断言其后三次浏览器控件导航
    expect(navSpy.mock.calls.slice(-3).map((c) => (c[0] as { via?: string }).via)).toEqual(['back', 'forward', 'reload']);
  });

  it('导出试题篮：成功后顶部栏提示「已提取 N 题」', async () => {
    const { bridge } = makeBridge();
    render(new CaptureClient(bridge as never));
    flushSync(() => btn('组卷网').click());
    await waitFor(() => expect((testid('capture-extract-btn') as HTMLButtonElement).disabled).toBe(false));
    flushSync(() => (testid('capture-extract-btn') as HTMLButtonElement).click());
    await waitFor(() => {
      expect(testid('capture-extract-notice').textContent).toContain('已提取 3 题');
    });
  });

  it('toBasket 场景：采集界面页出现「加入当前试题篮（同步入库）」且无提取结果时禁用', async () => {
    const { svc } = await import('../../src/app/services/CaptureServiceFactory.js').then(() => ({ svc: undefined as never }));
    void svc;
    const { createMockExtServices } = await import('../../src/bank/mock/mock-ext.js');
    const { MockBankService } = await import('../../src/bank/mock/mock-bank.js');
    const { MockBankStore } = await import('../../src/bank/mock/mock-store.js');
    const store = new MockBankStore();
    const bank = new MockBankService(store, false);
    const paper = await bank.createPaper('顶部栏直达篮');
    const svcObj = { bank, ext: createMockExtServices(store) };

    const { bridge } = makeBridge();
    window.location.hash = `#/capture?toBasket=${paper.id}`;
    render(new CaptureClient(bridge as never), svcObj as never);

    openPanel();
    await waitFor(() => expect(testid('capture-collect-btn')).toBeDefined());
    expect(testid('capture-collect-btn').textContent).toBe('加入当前试题篮（同步入库）');
    expect((testid('capture-collect-btn') as HTMLButtonElement).disabled).toBe(true); // 无提取结果时禁用
  });

  it('路由离开=detach：卸载时自动 closeWindow（语义同现状关窗）', async () => {
    const closeSpy = vi.fn(async () => undefined);
    const { bridge } = makeBridge({ async closeWindow() { await closeSpy(); } });
    const client = new CaptureClient(bridge as never);
    render(client);
    flushSync(() => btn('组卷网').click());
    await waitFor(() => expect((testid('capture-address') as HTMLButtonElement).disabled).toBe(false));
    root?.unmount();
    root = null;
    expect(closeSpy).toHaveBeenCalledOnce();
  });

  it('bounds 上报接通：打开后向桥上报视口矩形（jsdom 矩形为 0，仅验证通道接通）', async () => {
    const setBoundsSpy = vi.fn(async () => undefined);
    const { bridge } = makeBridge({ setBounds: setBoundsSpy });
    const client = new CaptureClient(bridge as never);
    render(client);
    flushSync(() => btn('组卷网').click());
    await waitFor(() => expect((testid('capture-address') as HTMLButtonElement).disabled).toBe(false));
    // bounds effect 以 250ms 节拍兜底上报
    await waitFor(() => expect(setBoundsSpy.mock.calls.length).toBeGreaterThanOrEqual(1));
    const payload = setBoundsSpy.mock.calls[0]![0] as Record<string, number>;
    expect(Object.keys(payload).sort()).toEqual(['height', 'width', 'x', 'y']);
  });
});

// ==================== 0012 P4：自动识别年级学科（预填 + 手选锁定 + 提示可见） ====================

describe('0012 P4：学段/学科自动预填', () => {
  async function renderWithDict() {
    const { createMockExtServices } = await import('../../src/bank/mock/mock-ext.js');
    const { MockBankService } = await import('../../src/bank/mock/mock-bank.js');
    const { MockBankStore } = await import('../../src/bank/mock/mock-store.js');
    const store = new MockBankStore();
    const bank = new MockBankService(store, false);
    const ext = createMockExtServices(store);
    await ext.dict.createEntry({ kind: 'subject', code: 'math', label: '数学' });
    await ext.dict.createEntry({ kind: 'subject', code: 'physics', label: '物理' });
    await ext.dict.createEntry({ kind: 'subject', code: 'morality-law', label: '道德与法治' });
    // 菁优站点行：道法→morality-law（politics 歧义破除，站点行优先）
    await ext.dict.createEntry({ kind: 'subject', code: 'morality-law', label: '道法', site: 'jyeoo', sourceLabel: '道法' });
    return { svc: { bank, ext } };
  }

  function selects() {
    return {
      stage: container.querySelector('[data-testid="stage-select"]') as HTMLSelectElement,
      subject: container.querySelector('[data-testid="subject-select"]') as HTMLSelectElement,
    };
  }

  function selectSetter(el: HTMLSelectElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    flushSync(() => {
      setter.call(el, value);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  it('事件语境 → 两下拉预填 + 「已按页面识别」提示可见（默认未手选时）', async () => {
    const { svc } = await renderWithDict();
    const { bridge, eventCallbacks } = makeBridge();
    render(new CaptureClient(bridge as never), svc as never);
    openPanel();
    await waitFor(() => expect([...selects().subject.options].map((o) => o.value)).toContain('物理'));

    for (const cb of eventCallbacks) {
      cb({ url: 'https://zujuan.xkw.com/4p2338916.html', title: '物理卷', loggedIn: true, stage: '初中', subject: '物理', subjectVia: 'paper-url' });
    }
    await waitFor(() => {
      expect(selects().stage.value).toBe('初中');
      expect(selects().subject.value).toBe('物理');
      expect(testid('capture-autofill-hint').textContent).toContain('已按页面识别');
      expect(testid('capture-autofill-hint').textContent).toContain('初中·物理');
    });
  });

  it('用户手选一次即锁定：后续页面跳转事件不再覆盖（最后一次手选优先），提示随之消失', async () => {
    const { svc } = await renderWithDict();
    const { bridge, eventCallbacks } = makeBridge();
    render(new CaptureClient(bridge as never), svc as never);
    openPanel();
    await waitFor(() => expect([...selects().subject.options].map((o) => o.value)).toContain('物理'));

    for (const cb of eventCallbacks) {
      cb({ url: 'https://zujuan.xkw.com/4p2338916.html', title: '物理卷', loggedIn: true, stage: '初中', subject: '物理' });
    }
    await waitFor(() => expect(selects().subject.value).toBe('物理'));

    // 手动改选 → 锁定 + 提示消失
    selectSetter(selects().stage, '高中');
    selectSetter(selects().subject, '数学');
    expect(() => testid('capture-autofill-hint')).toThrow();

    // 再来一语境：不覆盖手选
    for (const cb of eventCallbacks) {
      cb({ url: 'https://zujuan.xkw.com/13p999.html', title: '另一卷', loggedIn: true, stage: '初中', subject: '物理' });
    }
    await new Promise((r) => setTimeout(r, 50));
    expect(selects().stage.value).toBe('高中');
    expect(selects().subject.value).toBe('数学');
  });

  it('菁优道法：站点行优先归一 → 下拉预填「道德与法治」（politics 歧义不落错）', async () => {
    const { svc } = await renderWithDict();
    const { bridge, eventCallbacks } = makeBridge();
    render(new CaptureClient(bridge as never), svc as never);
    openPanel();
    await waitFor(() => expect([...selects().subject.options].map((o) => o.value)).toContain('道德与法治'));

    for (const cb of eventCallbacks) {
      cb({ url: 'https://www.jyeoo.com/politics/', title: '道法', loggedIn: true, stage: '初中', subject: '道法', subjectVia: 'segment' });
    }
    await waitFor(() => {
      expect(selects().stage.value).toBe('初中');
      expect(selects().subject.value).toBe('道德与法治');
    });
  });

  it('信号缺失（无 stage/subject 或未命中字典）→ 保持现状默认，无提示', async () => {
    const { svc } = await renderWithDict();
    const { bridge, eventCallbacks } = makeBridge();
    render(new CaptureClient(bridge as never), svc as never);
    openPanel();
    await waitFor(() => expect([...selects().subject.options].map((o) => o.value)).toContain('数学'));

    for (const cb of eventCallbacks) {
      cb({ url: 'https://zujuan.xkw.com/', title: '首页', loggedIn: true });
      cb({ url: 'https://zujuan.xkw.com/x', title: '未命中', loggedIn: true, stage: '高中', subject: '梵文' });
    }
    await new Promise((r) => setTimeout(r, 50));
    expect(selects().stage.value).toBe('高中'); // 默认
    expect(selects().subject.value).toBe('数学'); // 默认
    expect(() => testid('capture-autofill-hint')).toThrow();
  });
});

// ==================== 0012 目检返工：浏览器/采集界面双标签页 ====================

describe('0012 目检返工：双标签页行为', () => {
  it('默认浏览器页；切到采集界面 → 上报零矩形（视图隐藏、会话保持）；切回 → 恢复真实矩形', async () => {
    // jsdom 的 getBoundingClientRect 恒为 0——stub 出真实矩形才能区分「真实上报」与「零矩形隐藏」
    const rectSpy = vi.spyOn(HTMLDivElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 48, width: 1200, height: 700, top: 48, left: 0, right: 1200, bottom: 748, toJSON: () => ({}),
    } as DOMRect);
    const setBoundsSpy = vi.fn(async () => undefined);
    const { bridge } = makeBridge({ setBounds: setBoundsSpy });
    const client = new CaptureClient(bridge as never);
    render(client);
    flushSync(() => btn('组卷网').click());
    await waitFor(() => expect(setBoundsSpy.mock.calls.length).toBeGreaterThanOrEqual(1));

    flushSync(() => (testid('capture-tab-panel') as HTMLButtonElement).click());
    await waitFor(() => {
      const last = setBoundsSpy.mock.calls[setBoundsSpy.mock.calls.length - 1]![0] as Record<string, number>;
      expect(last.width).toBe(0);
      expect(last.height).toBe(0);
    });

    flushSync(() => (testid('capture-tab-browser') as HTMLButtonElement).click());
    await waitFor(() => {
      const last = setBoundsSpy.mock.calls[setBoundsSpy.mock.calls.length - 1]![0] as Record<string, number>;
      expect(last.width).toBe(1200);
    });
    // 浏览器页独有控件回来了；视图槽位回来了
    expect(testid('capture-extract-btn')).toBeDefined();
    expect(testid('capture-view-slot')).toBeDefined();
    rectSpy.mockRestore();
  });

  it('采集界面页不渲染浏览器控件（P0.5 红线：提取一律要求站点视图可见）', async () => {
    const { bridge } = makeBridge();
    render(new CaptureClient(bridge as never));
    flushSync(() => btn('组卷网').click());
    await waitFor(() => expect((testid('capture-address') as HTMLButtonElement).disabled).toBe(false));
    flushSync(() => (testid('capture-tab-panel') as HTMLButtonElement).click());
    expect(findBtn('导出试题篮')).toBeNull();
    expect(findBtn('关闭浏览器')).toBeNull();
    // 采集组件在采集界面页在场
    expect(testid('stage-select')).toBeDefined();
    expect(testid('subject-select')).toBeDefined();
  });

  it('标签页徽标：有提取结果时「采集界面」显示题数', async () => {
    const { bridge } = makeBridge();
    render(new CaptureClient(bridge as never));
    flushSync(() => btn('组卷网').click());
    await waitFor(() => expect((testid('capture-extract-btn') as HTMLButtonElement).disabled).toBe(false));
    expect(testid('capture-tab-panel').textContent).not.toContain('（');
    flushSync(() => (testid('capture-extract-btn') as HTMLButtonElement).click());
    await waitFor(() => {
      expect(testid('capture-tab-panel').textContent).toContain('（3 题）');
    });
  });
});

// ==================== 0012 目检返工 3：页签顺序 / 整卷下载带链跳转 / 关闭浏览器 ====================

describe('0012 目检返工 3：操作逻辑微调', () => {
  it('「整卷下载」按钮：仅组卷整卷详情页可用，点击带同一链接跳整卷下载页', async () => {
    const { bridge } = makeBridge();
    const client = new CaptureClient(bridge as never);
    render(client);
    // 非试卷页：不可用
    flushSync(() => btn('组卷网').click());
    await waitFor(() => expect((testid('capture-address') as HTMLButtonElement).disabled).toBe(false));
    expect((testid('capture-goto-paper-btn') as HTMLButtonElement).disabled).toBe(true);

    // 导航到整卷详情页（mock 链路直接驱动状态）
    (bridge as { getState: () => Promise<unknown> }).getState = async () => ({
      open: true, url: 'https://zujuan.xkw.com/4p2338916.html', title: '物理卷', site: 'zujuan', loggedIn: true, lastExtraction: null,
    });
    await waitFor(() => expect((testid('capture-goto-paper-btn') as HTMLButtonElement).disabled).toBe(false));
    flushSync(() => (testid('capture-goto-paper-btn') as HTMLButtonElement).click());

    // 跳到整卷下载页签，输入框预填同一链接
    expect((testid('capture-tab-paper') as HTMLButtonElement).className).toContain('btn-primary');
    expect((container.querySelector('[data-testid="paper-url-input"]') as HTMLInputElement).value)
      .toBe('https://zujuan.xkw.com/4p2338916.html');
  });

  it('「关闭浏览器」：手动卸载后不自动重开；再次快速导航恢复', async () => {
    const closeSpy = vi.fn(async () => undefined);
    const { bridge, state } = makeBridge({ async closeWindow() {
      await closeSpy();
      state.open = false;
      state.url = '';
      state.loggedIn = false;
    } });
    render(new CaptureClient(bridge as never));
    flushSync(() => btn('组卷网').click());
    await waitFor(() => expect((testid('capture-address') as HTMLButtonElement).disabled).toBe(false));

    // 手动关闭：closeWindow 恰一次；灯回「检测中」（open=false）
    flushSync(() => (testid('capture-close-browser-btn') as HTMLButtonElement).click());
    await waitFor(() => expect(closeSpy).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 300)); // 给自动重开效应留窗口（应被抑制）
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(testid('capture-login-light').getAttribute('data-state')).toBe('grey');

    // 快速导航 → 浏览器恢复（不再触发 closeWindow）
    flushSync(() => btn('组卷网').click());
    flushSync(() => btn('组卷网').click());
    await waitFor(() => expect((testid('capture-address') as HTMLButtonElement).disabled).toBe(false));
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});

describe('0038（R-030）：采集页站导航突出 + 文案「导出试题篮」', () => {
  it('站导航带高亮类（无分组外框/圆点）；旧名不再出现；最大化提示在场', async () => {
    const { bridge } = makeBridge();
    render(new CaptureClient(bridge as never));

    // 0038 返工 1：撤分组外框与前置圆点，高亮改由加粗边框 + 荧光圈（btn-site-nav）承载
    expect(findBtn('组卷网')!.className).toContain('btn btn-site-nav');
    expect(findBtn('菁优网')!.className).toContain('btn btn-site-nav');
    expect(findBtn('组卷网')!.getAttribute('title')).toBe('快速导航：组卷网');
    expect(findBtn('菁优网')!.getAttribute('title')).toBe('快速导航：菁优网');

    // 0038 返工 2：前进/后退/刷新压缩为紧凑控件组
    const ctlGroup = container.querySelector('.cap-nav-ctl-group');
    expect(ctlGroup).not.toBeNull();
    expect([...ctlGroup!.querySelectorAll('button')].map((b) => b.getAttribute('data-testid')))
      .toEqual(['capture-nav-back', 'capture-nav-forward', 'capture-nav-reload']);
    for (const id of ['capture-nav-back', 'capture-nav-forward', 'capture-nav-reload']) {
      expect(testid(id).className).toContain('btn-nav-ctl');
    }

    // 文案改名：旧名全链不再出现；新名在按钮与流程引导处
    expect(findBtn('提取试题篮')).toBeNull();
    expect(findBtn('导出试题篮')).not.toBeNull();
    expect(testid('capture-extract-btn').textContent).toBe('导出试题篮');
    expect(testid('capture-slot-empty').textContent).toContain('「导出试题篮」');

    // 0038 返工 3（目检）：最大化建议并入「浏览器未启动」引导文字（不再常显）
    expect(testid('capture-slot-empty').contains(testid('capture-maximize-tip'))).toBe(true);
    expect(testid('capture-maximize-tip').textContent).toContain('建议将应用窗口最大化');
  });

  it('站点/登录合并为一框：未进站文字=检测中（灯灰）→ 进站文字=站点名（灯绿）', async () => {
    const { bridge } = makeBridge();
    render(new CaptureClient(bridge as never));

    // 未进站：合并框文字「检测中」，灯灰
    expect(testid('capture-site-state').textContent).toContain('检测中');
    expect(testid('capture-site-badge').textContent).toBe('检测中');
    expect(testid('capture-login-light').getAttribute('data-state')).toBe('grey');

    // 进入组卷网：文字=站点名，灯=已登录（绿）
    flushSync(() => btn('组卷网').click());
    await waitFor(() => {
      expect(testid('capture-site-badge').textContent).toBe('组卷网');
      expect(testid('capture-login-light').getAttribute('data-state')).toBe('green');
    });
    expect(testid('capture-login-light').getAttribute('title')).toContain('已登录');
    // 0038 返工 3：浏览器已启动 → 引导（含最大化建议）随空态一起消失
    expect(container.querySelector('[data-testid="capture-slot-empty"]')).toBeNull();
    expect(container.querySelector('[data-testid="capture-maximize-tip"]')).toBeNull();
  });
});
