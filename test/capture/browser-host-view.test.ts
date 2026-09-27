/**
 * 0012 P1：CaptureHost 内嵌 WebContentsView 形态单测（mock webContents 层）
 *
 * - attach/detach 状态机（open=view 已挂载；close=removeChildView+webContents 销毁，语义同现状关窗）
 * - bounds 通道（渲染层上报 → view.setBounds；零宽高=遮挡编排态，提取如实拒绝）
 * - 事件推送序列（did-navigate/title → 防抖 → capture.event 广播；登录态/语境附带）
 * - 独立窗兜底形态（--capture-live：standalone 双形态共存）
 * - 红线回归：UA 剥段、隐藏窗通路、sandbox 无 preload
 * // @vitest-environment node —— 文件级注释会被 esbuild 注释吞掉，环境在 vitest.config 默认 node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ==================== electron fakes ====================

type Handler = (...args: unknown[]) => void;

interface FakeEvented {
  on: (event: string, cb: Handler) => unknown;
  emit: (event: string, ...args: unknown[]) => void;
}

function makeEvented(): { on: ReturnType<typeof vi.fn>; emit: (event: string, ...args: unknown[]) => void; handlers: Map<string, Set<Handler>> } {
  const handlers = new Map<string, Set<Handler>>();
  return {
    handlers,
    on: vi.fn((event: string, cb: Handler) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(cb);
      return this;
    }),
    emit: (event: string, ...args: unknown[]) => {
      for (const cb of [...(handlers.get(event) ?? [])]) cb(...args);
    },
  };
}

function makeWebContents() {
  const ev = makeEvented();
  return {
    ...ev,
    isDestroyed: vi.fn(() => false),
    close: vi.fn(),
    destroy: vi.fn(),
    loadURL: vi.fn(async () => undefined),
    getURL: vi.fn(() => 'https://zujuan.xkw.com/'),
    getTitle: vi.fn(() => '组卷网'),
    executeJavaScript: vi.fn(async () => undefined),
    canGoBack: vi.fn(() => false),
    canGoForward: vi.fn(() => false),
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    send: vi.fn(),
    toggleDevTools: vi.fn(),
    inspectElement: vi.fn(),
    openDevTools: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    setUserAgent: vi.fn(),
  };
}

function makeSession() {
  return {
    ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Electron/38.8.6',
    getUserAgent() { return this.ua; },
    setUserAgent(ua: string) { this.ua = ua; },
    cookies: { get: vi.fn(async () => [] as Array<unknown>) },
    fetch: vi.fn(),
    protocol: { handle: vi.fn() },
  };
}

/** 探针世界：host/测试共享的 fake electron 内部状态 */
const world = {
  windows: [] as Array<Record<string, unknown> & { isDestroyed: () => boolean }>,
  views: [] as Array<Record<string, unknown>>,
  sessions: new Map<string, ReturnType<typeof makeSession>>(),
};

vi.mock('electron', () => {
  const makeSessionInner = () => ({
    ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Electron/38.8.6',
    getUserAgent() { return this.ua; },
    setUserAgent(ua: string) { this.ua = ua; },
    cookies: { get: async () => [] },
    fetch: async () => { throw new Error('no fetch in unit test'); },
    protocol: { handle: () => undefined },
  });

  class FakeBrowserWindow {
    static getAllWindows() {
      return world.windows.filter((w) => !w.isDestroyed());
    }
    contentView = {
      children: [] as unknown[],
      addChildView(view: unknown) { this.children.push(view); },
      removeChildView(view: unknown) { this.children = this.children.filter((c) => c !== view); },
    };
    webContents = makeWebContents();
    isDestroyed = vi.fn(() => false);
    close = vi.fn();
    destroy = vi.fn();
    focus = vi.fn();
    setMenu = vi.fn();
    isMinimized = vi.fn(() => false);
    isVisible = vi.fn(() => true);
    ev = makeEvented();
    /** 构造全量 options（与 Electron BrowserWindow 构造一致），测试断言 webPreferences 子层 */
    opts: { webPreferences?: Record<string, unknown> } | undefined;
    constructor(opts: { webPreferences?: Record<string, unknown> }) {
      this.opts = opts;
      this.on = this.ev.on;
      world.windows.push(this as unknown as Record<string, unknown> & { isDestroyed: () => boolean });
    }
    on!: (event: string, cb: Handler) => unknown;
  }

  class FakeWebContentsView {
    webContents = makeWebContents();
    bounds = { x: 0, y: 0, width: 0, height: 0 };
    visible = true;
    /** Electron WebContentsView 构造参数为 { webPreferences }，解包后暴露供断言 */
    webPreferences: Record<string, unknown> | undefined;
    setBounds(b: { x: number; y: number; width: number; height: number }) { this.bounds = { ...b }; }
    getBounds() { return { ...this.bounds }; }
    setVisible(v: boolean) { this.visible = v; }
    getVisible() { return this.visible; }
    constructor(opts: { webPreferences?: Record<string, unknown> }) {
      this.webPreferences = opts?.webPreferences;
      world.views.push(this as unknown as Record<string, unknown>);
    }
  }

  return {
    // 0022：host.ts 资源定位改 app.getAppPath()；dev 下 app.getAppPath() === process.cwd()，
    // 与原 process.cwd() 取值一致（dist/capture/inject.js 在仓库根下）
    app: { getAppPath: () => process.cwd() },
    session: {
      fromPartition: (partition: string) => {
        if (!world.sessions.has(partition)) world.sessions.set(partition, makeSessionInner());
        return world.sessions.get(partition);
      },
      defaultSession: makeSessionInner(),
    },
    BrowserWindow: FakeBrowserWindow,
    WebContentsView: FakeWebContentsView,
    Menu: { buildFromTemplate: (template: unknown) => ({ template, popup: () => undefined }) },
  };
});

import { CaptureHost } from '../../src/capture/browser/host.js';
import { IPC_CHANNELS } from '../../src/shared/contracts/ipc-channels.js';

// ==================== 测试世界装配 ====================

// savePageHtml 落盘目标须在系统临时目录（禁在仓库根留产物）
const USER_DATA = join(tmpdir(), 'mofang-0012-host-unit-test');

interface FakeContainerWindow {
  contentView: { children: unknown[] };
  webContents: { send: ReturnType<typeof vi.fn> };
  isDestroyed: () => boolean;
}

interface FakeViewHandle {
  webContents: ReturnType<typeof makeWebContents>;
  bounds: { x: number; y: number; width: number; height: number };
  webPreferences: Record<string, unknown> | undefined;
}

interface World {
  container: FakeContainerWindow;
  containerWindowCount: () => number;
  lastView: () => FakeViewHandle | undefined;
  makeHost: () => CaptureHost;
  partitionSession: () => ReturnType<typeof makeSession>;
}

function setup(): World {
  world.windows.length = 0;
  world.views.length = 0;
  world.sessions.clear();
  const container = new (class {
    contentView = { children: [] as unknown[], addChildView(v: unknown) { this.children.push(v); }, removeChildView(v: unknown) { this.children = this.children.filter((c) => c !== v); } };
    webContents = makeWebContents();
    isDestroyed = () => false;
  })();
  world.windows.push(container as unknown as Record<string, unknown> & { isDestroyed: () => boolean });
  const makeHost = () =>
    new CaptureHost({
      bankService: {} as ConstructorParameters<typeof CaptureHost>[0]['bankService'],
      userDataPath: USER_DATA,
      getContainerWindow: () => container as unknown as NonNullable<Parameters<NonNullable<ConstructorParameters<typeof CaptureHost>[0]['getContainerWindow']>>[0]>,
    });
  return {
    container: container as unknown as FakeContainerWindow,
    containerWindowCount: () => world.windows.length,
    lastView: () => world.views[world.views.length - 1] as FakeViewHandle | undefined,
    makeHost,
    partitionSession: () => world.sessions.get('persist:mofang-capture')!,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  // 防抖定时器泄漏防护：真实定时器 300ms，测试均等待落定后结束
  await new Promise((r) => setTimeout(r, 0));
});

// ==================== P1 attach/detach 状态机 ====================

describe('0012 P1：CaptureHost 内嵌 view 状态机（mock webContents 层）', () => {
  it('openWindow=挂载 view：挂进容器 contentView、初始零矩形（渲染层未上报前不可见）、无 preload、sandbox 开', async () => {
    const w = setup();
    const host = w.makeHost();
    await host.openWindow();

    expect(w.lastView()).toBeDefined();
    expect(w.container.contentView.children).toContain(w.lastView());
    expect(w.lastView()!.bounds).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    // 红线：view 不再挂 toolbar-preload（P2 退役），sandbox/contextIsolation 与原窗一致
    expect(w.lastView()!.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false });
    expect(w.lastView()!.webPreferences?.['preload']).toBeUndefined();
    // session 分区红线：persist:mofang-capture
    expect(w.lastView()!.webPreferences?.['session']).toBe(w.partitionSession());

    const state = await host.getState();
    expect(state.open).toBe(true);
  });

  it('openWindow 幂等：重复 open 不重复挂载、不新开窗', async () => {
    const w = setup();
    const host = w.makeHost();
    await host.openWindow();
    await host.openWindow();
    expect(world.views.length).toBe(1);
    expect(w.container.contentView.children.length).toBe(1);
  });

  it('closeWindow=detach：移出 contentView、销毁 webContents、open=false、url/title 归零', async () => {
    const w = setup();
    const host = w.makeHost();
    await host.openWindow();
    const view = w.lastView()!;

    await host.closeWindow();
    expect(w.container.contentView.children).not.toContain(view);
    expect(view.webContents.close).toHaveBeenCalled();
    const state = await host.getState();
    expect(state.open).toBe(false);
    expect(state.url).toBe('');
    expect(state.title).toBe('');
  });

  it('navigate 自动挂载并 loadURL；getState.url 跟随', async () => {
    const w = setup();
    const host = w.makeHost();
    await host.navigate('https://zujuan.xkw.com/__smoke__/basket');
    expect(w.lastView()).toBeDefined();
    expect(w.lastView()!.webContents.loadURL).toHaveBeenCalledWith('https://zujuan.xkw.com/__smoke__/basket');
    const state = await host.getState();
    expect(state.open).toBe(true);
    expect(state.url).toBe('https://zujuan.xkw.com/');
  });

  it('getState 携带导航栈可用态（canGoBack/canGoForward），未开时 false', async () => {
    const w = setup();
    const host = w.makeHost();
    const closed = await host.getState();
    expect(closed.open).toBe(false);
    expect(closed.canGoBack).toBe(false);
    expect(closed.canGoForward).toBe(false);

    await host.openWindow();
    const view = w.lastView()!;
    view.webContents.canGoBack.mockReturnValue(true);
    const state = await host.getState();
    expect(state.canGoBack).toBe(true);
    expect(state.canGoForward).toBe(false);
  });

  it('容器窗缺位（主窗未就绪）→ openWindow 如实抛错', async () => {
    const w = setup();
    world.windows.length = 0; // getAllWindows 空
    const host = new CaptureHost({
      bankService: {} as ConstructorParameters<typeof CaptureHost>[0]['bankService'],
      userDataPath: USER_DATA,
      getContainerWindow: () => null,
    });
    await expect(host.openWindow()).rejects.toThrow(/宿主窗口/);
  });
});

// ==================== P1 bounds 通道 ====================

describe('0012 P1：bounds 通道（渲染层上报编排）', () => {
  it('setBounds 应用到 view（四元组原样，负 y 允许=P0 A3 滚出场景）', async () => {
    const w = setup();
    const host = w.makeHost();
    await host.openWindow();
    await host.setBounds({ x: 0, y: 48, width: 1136, height: 700 });
    expect(w.lastView()!.bounds).toEqual({ x: 0, y: 48, width: 1136, height: 700 });
    await host.setBounds({ x: 0, y: -260, width: 1136, height: 700 });
    expect(w.lastView()!.bounds).toEqual({ x: 0, y: -260, width: 1136, height: 700 });
  });

  it('未挂载时 setBounds 只记录不炸（重挂后渲染层会重报）', async () => {
    const w = setup();
    const host = w.makeHost();
    await expect(host.setBounds({ x: 0, y: 0, width: 100, height: 100 })).resolves.toBeUndefined();
  });

  it('红线：零宽高（遮挡编排期）提取如实拒绝；正常矩形提取放行', async () => {
    const w = setup();
    const host = w.makeHost();
    await host.openWindow();
    const view = w.lastView()!;
    view.webContents.executeJavaScript.mockImplementation(async (script: string) => {
      if (script.includes('__mofangCapturePage.extractBasket()')) {
        return { url: 'https://zujuan.xkw.com/', mode: 'zujuan-basket', captured: [], warnings: [] };
      }
      return undefined;
    });

    await host.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    await expect(host.extractBasket()).rejects.toThrow(/不可见/);

    await host.setBounds({ x: 0, y: 48, width: 1136, height: 700 });
    const { extracted } = await host.extractBasket();
    expect(extracted.mode).toBe('zujuan-basket');
  });

  it('未开窗提取照旧抛 not open（既有语义）', async () => {
    const w = setup();
    const host = w.makeHost();
    await expect(host.extractBasket()).rejects.toThrow(/not open|capture window/i);
  });
});

// ==================== P1 事件推送 ====================

describe('0012 P1：状态事件推送（capture.event，轮询保留兜底）', () => {
  it('did-navigate → 防抖推送 {url,title,loggedIn} 到所有存活窗（capture.event 通道）', async () => {
    const w = setup();
    const host = w.makeHost();
    await host.openWindow();
    const view = w.lastView()!;
    view.webContents.executeJavaScript.mockImplementation(async (script: string) => {
      if (script.includes('document.documentElement')) return '<html>我的存档</html>'; // zujuan 登录特征
      return undefined;
    });

    view.webContents.emit('did-navigate', null, 'https://zujuan.xkw.com/my/archive');
    // 真实 Electron：did-navigate 后 getURL 返回新地址（假件同步跟随）
    view.webContents.getURL.mockReturnValue('https://zujuan.xkw.com/my/archive');
    await new Promise((r) => setTimeout(r, 500)); // 防抖 300ms + 异步链落定

    expect(view.webContents.send).not.toHaveBeenCalled(); // 推送走窗广播，不走 view 自己
    const calls = w.container.webContents.send.mock.calls.filter((c) => c[0] === IPC_CHANNELS.CAPTURE_EVENT);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const payload = calls[calls.length - 1]![1] as Record<string, unknown>;
    expect(payload.url).toBe('https://zujuan.xkw.com/my/archive');
    expect(payload.loggedIn).toBe(true);
    expect(typeof payload.title).toBe('string');
  }, 10000);

  it('登录态检测失败 → loggedIn=null（渲染层保持轮询兜底结果，不误报未登录）', async () => {
    const w = setup();
    const host = w.makeHost();
    await host.openWindow();
    const view = w.lastView()!;
    view.webContents.executeJavaScript.mockRejectedValue(new Error('page navigating'));
    view.webContents.emit('did-navigate', null, 'https://www.jyeoo.com/math2/');
    await new Promise((r) => setTimeout(r, 500));
    const calls = w.container.webContents.send.mock.calls.filter((c) => c[0] === IPC_CHANNELS.CAPTURE_EVENT);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect((calls[calls.length - 1]![1] as Record<string, unknown>).loggedIn).toBeNull();
  }, 10000);

  it('0012 P4：导航事件推送携带页面语境（pageContext→resolve，stage/subject/via 入 payload）；未命中字段缺省', async () => {
    const w = setup();
    const host = w.makeHost();
    await host.openWindow();
    const view = w.lastView()!;
    view.webContents.getURL.mockReturnValue('https://zujuan.xkw.com/4p2338916.html');
    view.webContents.executeJavaScript.mockImplementation(async (script: string) => {
      if (script.includes('__mofangCapturePage.pageContext()')) {
        return {
          url: 'https://zujuan.xkw.com/4p2338916.html',
          zujuan: { activeSubjectBankId: null, activeStageText: null, navItems: [{ bankId: '4', label: '物理', stage: '初中' }], bankids: [] },
          jyeoo: null,
        };
      }
      if (script.includes('document.documentElement')) return '<html>组卷网</html>';
      return undefined;
    });
    view.webContents.emit('did-navigate', null, 'https://zujuan.xkw.com/4p2338916.html');
    await new Promise((r) => setTimeout(r, 500));
    let calls = w.container.webContents.send.mock.calls.filter((c) => c[0] === IPC_CHANNELS.CAPTURE_EVENT);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    let payload = calls[calls.length - 1]![1] as Record<string, unknown>;
    expect(payload.stage).toBe('初中');
    expect(payload.subject).toBe('物理');
    expect(payload.subjectVia).toBe('paper-url');

    // 未命中（navItems 缺 bankId）→ stage/subject 字段缺省（渲染层不预填）
    view.webContents.executeJavaScript.mockImplementation(async (script: string) => {
      if (script.includes('__mofangCapturePage.pageContext()')) {
        return { url: 'x', zujuan: { activeSubjectBankId: null, activeStageText: null, navItems: [], bankids: [] }, jyeoo: null };
      }
      if (script.includes('document.documentElement')) return '<html></html>';
      return undefined;
    });
    view.webContents.emit('did-navigate-in-page', null, 'https://zujuan.xkw.com/4p2338916.html');
    await new Promise((r) => setTimeout(r, 500));
    calls = w.container.webContents.send.mock.calls.filter((c) => c[0] === IPC_CHANNELS.CAPTURE_EVENT);
    payload = calls[calls.length - 1]![1] as Record<string, unknown>;
    expect(payload.stage).toBeUndefined();
    expect(payload.subject).toBeUndefined();
  }, 10000);

  it('closeWindow 后不再推送（view 已销毁）', async () => {
    const w = setup();
    const host = w.makeHost();
    await host.openWindow();
    const view = w.lastView()!;
    await host.closeWindow();
    view.webContents.emit('did-navigate', null, 'https://zujuan.xkw.com/');
    await new Promise((r) => setTimeout(r, 500));
    const calls = w.container.webContents.send.mock.calls.filter((c) => c[0] === IPC_CHANNELS.CAPTURE_EVENT);
    expect(calls.length).toBe(0);
  }, 10000);
});

// ==================== P5 独立窗兜底形态（--capture-live） ====================

describe('0012 P5：独立窗兜底形态（standalone 双形态共存）', () => {
  it('openWindow({standalone:true}) 走独立窗：不挂 view、带原生导航菜单、open=true', async () => {
    const w = setup();
    const host = w.makeHost();
    const before = w.containerWindowCount();
    await host.openWindow({ standalone: true });

    expect(world.views.length).toBe(0);
    expect(w.containerWindowCount()).toBe(before + 1);
    const win = world.windows[world.windows.length - 1]!;
    expect(win.setMenu).toHaveBeenCalled();
    expect((await host.getState()).open).toBe(true);
  });

  it('standalone 最小化 → 提取如实拒绝（红线）；恢复后放行', async () => {
    const w = setup();
    const host = w.makeHost();
    await host.openWindow({ standalone: true });
    const win = world.windows[world.windows.length - 1]!;
    const wc = (win as unknown as { webContents: ReturnType<typeof makeWebContents> }).webContents;
    wc.executeJavaScript.mockImplementation(async (script: string) => {
      if (script.includes('__mofangCapturePage.extractBasket()')) {
        return { url: 'https://zujuan.xkw.com/', mode: 'zujuan-basket', captured: [], warnings: [] };
      }
      return undefined;
    });

    (win.isMinimized as ReturnType<typeof vi.fn>).mockReturnValue(true);
    await expect(host.extractBasket()).rejects.toThrow(/不可见/);
    (win.isMinimized as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const { extracted } = await host.extractBasket();
    expect(extracted.mode).toBe('zujuan-basket');
  });

  it('standalone closeWindow 关窗复位；随后 openWindow() 缺省回 view 形态', async () => {
    const w = setup();
    const host = w.makeHost();
    await host.openWindow({ standalone: true });
    await host.closeWindow();
    expect((await host.getState()).open).toBe(false);

    await host.openWindow();
    expect(world.views.length).toBe(1);
    expect((await host.getState()).open).toBe(true);
  });
});

// ==================== 红线回归 ====================

describe('0012 红线回归（菁优 UA 分级投放铁律）', () => {
  it('构造即剥 Electron 段（host.ts:72 同式，作用于 persist:mofang-capture 分区）', () => {
    const w = setup();
    w.makeHost();
    const session = w.partitionSession();
    expect(session.getUserAgent()).not.toMatch(/ Electron\/\S+/);
    expect(session.getUserAgent()).toContain('Chrome/');
  });

  it('隐藏窗通路不受 view 托管影响：offscreen BrowserWindow + 同分区 + executeJavaScript 注入', async () => {
    const w = setup();
    const host = w.makeHost();
    const before = w.containerWindowCount();
    const hidden = await (host as unknown as { openHiddenPage(url: string): Promise<{ finalUrl: () => string; call: (fn: string) => Promise<unknown>; close: () => Promise<void> }> }).openHiddenPage('https://zujuan.xkw.com/13q987654.html');
    // 隐藏窗是新建 BrowserWindow（offscreen），不是 view、不占容器
    expect(w.containerWindowCount()).toBe(before + 1);
    expect(world.views.length).toBe(0);
    const newWin = world.windows[world.windows.length - 1]!;
    expect((newWin as unknown as { opts?: { webPreferences?: Record<string, unknown> } }).opts?.webPreferences).toMatchObject({ offscreen: true });
    expect((newWin as unknown as { opts?: { webPreferences?: Record<string, unknown> } }).opts?.webPreferences?.['session']).toBe(w.partitionSession());
    // HiddenPage 协议照旧（假件应答注入 bundle 后的页内函数调用）
    const hiddenWc = (newWin as unknown as { webContents: ReturnType<typeof makeWebContents> }).webContents;
    hiddenWc.executeJavaScript.mockImplementation(async (script: string) => {
      if (script.includes('__mofangCapturePage.extractBasket()')) {
        return { url: 'https://zujuan.xkw.com/13q987654.html', mode: 'none', captured: [], warnings: [] };
      }
      return undefined;
    });
    const probe = await hidden.call('extractBasket');
    expect(probe).toBeDefined();
    await hidden.close();
  });
});

// ==================== P2 保存页 HTML（取证能力移植） ====================

describe('0012 P2：savePageHtml（toolbar-preload「保存HTML」迁主进程通道）', () => {
  it('打开态：序列化当前页 → 落盘 userData/data/capture-html-snapshots/ → ok+path', async () => {
    const w = setup();
    const host = w.makeHost();
    await host.openWindow();
    const view = w.lastView()!;
    view.webContents.executeJavaScript.mockImplementation(async (script: string) => {
      if (script.includes('cloneNode')) return '<html><body>fixture</body></html>';
      return undefined;
    });
    const result = await host.savePageHtml();
    expect(result.ok).toBe(true);
    expect(result.path).toBeTruthy();
    expect(result.error).toBeUndefined();
  });

  it('未开窗：如实 ok=false + error（不打断 UI）', async () => {
    const w = setup();
    const host = w.makeHost();
    const result = await host.savePageHtml();
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.path).toBeUndefined();
  });
});
