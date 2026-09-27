// D1 P2: CapturePage 组件状态机测试 — 开合/导航/采集预览/入库结果/轮询
// mock 模式下端到端 UI 流（无需 Electron）；断言结构化（data-testid 定位 + 精确文本）
// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import { CapturePage } from '../../src/app/pages/CapturePage.js';
import { CaptureClient } from '../../src/app/services/capture-client.js';
import { MockBankService } from '../../src/bank/mock/mock-bank.js';
import { createMockExtServices } from '../../src/bank/mock/mock-ext.js';
import { MockBankStore } from '../../src/bank/mock/mock-store.js';
import type { ExtPageServices } from '../../src/app/pages/ExtUi.js';

let container: HTMLDivElement;
let root: Root | null = null;

function render(client?: CaptureClient, pollIntervalMs = 1000, svc?: ExtPageServices) {
  root?.unmount();
  root = null;
  container?.remove();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => {
    root!.render(<CapturePage capture={client} pollIntervalMs={pollIntervalMs} svc={svc} />);
  });
}

/** 0004-fix-1 D：采集进篮联动的注入服务世界（Mock in-memory） */
function createSvc(): { svc: ExtPageServices; store: MockBankStore } {
  const store = new MockBankStore();
  return { svc: { bank: new MockBankService(store, false), ext: createMockExtServices(store) }, store };
}

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  delete window.__mofangPaths;
  window.location.hash = '';
});

/** 0012 目检返工：浏览器控件（打开/导航/提取等）在「浏览器」标签页——点击前自动切页 */
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

function findBtn(text: string): HTMLButtonElement | null {
  if (BROWSER_TAB_BTNS.includes(text)) ensureBrowserTab();
  return ([...container.querySelectorAll('button')].find((x) => x.textContent === text) as HTMLButtonElement | null) ?? null;
}

/** 切到「采集界面」标签页（采集组件所在；幂等） */
function openPanel() {
  const b = container.querySelector('[data-testid="capture-tab-panel"]') as HTMLButtonElement | null;
  if (!b) throw new Error('找不到「采集界面」标签');
  if (!b.className.includes('btn-primary')) flushSync(() => b.click());
}

/** 切到「整卷下载」标签页（0012 目检返工 2：独立页；幂等） */
function openPaper() {
  const b = container.querySelector('[data-testid="capture-tab-paper"]') as HTMLButtonElement | null;
  if (!b) throw new Error('找不到「整卷下载」标签');
  if (!b.className.includes('btn-primary')) flushSync(() => b.click());
}

/** 0012 目检返工 2：状态卡退役——状态语义改读浏览器页顶部栏（地址/站点/登录灯）
 *  0038 返工 2：站点/登录合并为一框——登录文案移入灯 tooltip，故一并读 title（语义等价） */
function statusBarText(): string {
  ensureBrowserTab();
  const addr = container.querySelector('[data-testid="capture-address"]');
  const badge = container.querySelector('[data-testid="capture-site-badge"]');
  const light = container.querySelector('[data-testid="capture-login-light"]');
  return `${addr?.textContent ?? ''} ${badge?.textContent ?? ''} ${light?.textContent ?? ''} ${light?.getAttribute('title') ?? ''}`;
}

async function waitFor(assertion: () => void) {
  await vi.waitFor(assertion, { timeout: 2000, interval: 20 });
}

describe('CapturePage 状态机（mock 链路端到端）', () => {
  it('0012 返工 5：初始未启动（不导航不挂载）+ 流程引导在场；快速导航后站点/登录就位', async () => {
    render(new CaptureClient());
    // 初始未启动：地址不可点、引导（试题采集/试卷下载两流程）在场
    expect((container.querySelector('[data-testid="capture-address"]') as HTMLButtonElement).disabled).toBe(true);
    const empty = container.querySelector('[data-testid="capture-slot-empty"]');
    expect(empty!.textContent).toContain('试题采集');
    expect(empty!.textContent).toContain('试卷下载');

    flushSync(() => btn('组卷网').click());
    await waitFor(() => {
      expect(statusBarText()).toContain('组卷网');
      expect(statusBarText()).toContain('已登录');
      expect(statusBarText()).toContain('https://zujuan.xkw.com');
    });
  });

  it('导航到组卷网：状态栏显示站点与登录态', async () => {
    render(new CaptureClient());
    flushSync(() => btn('组卷网').click());
    await waitFor(() => {
      expect(statusBarText()).toContain('组卷网');
      expect(statusBarText()).toContain('已登录');
      expect(statusBarText()).toContain('https://zujuan.xkw.com');
    });
  });

  it('采集试题篮 → 预览 3 题：题干摘要 / KaTeX 公式 / 答案徽标', async () => {
    render(new CaptureClient());
    flushSync(() => btn('组卷网').click());
    await waitFor(() => expect(statusBarText()).toContain('组卷网'));

    flushSync(() => btn('导出试题篮').click());
    openPanel();
    await waitFor(() => {
      expect(container.querySelectorAll('[data-testid^="capture-item-"]').length).toBe(3);
    });

    const first = container.querySelector('[data-testid="capture-item-13q900001"]') as HTMLElement;
    expect(first).not.toBeNull();
    // 公式按既有 KaTeX 渲染（与校对页同源）
    expect(first.querySelector('.katex')).not.toBeNull();
    // 答案/解析有无徽标
    expect(first.querySelector('[data-testid="capture-answer-13q900001"]')!.getAttribute('data-state')).toBe('ok');
    expect(first.querySelector('[data-testid="capture-analysis-13q900001"]')!.getAttribute('data-state')).toBe('ok');
  });

  it('采集预览图：有 __mofangPaths 时 data-assets src 改写为 file:/// 绝对路径', async () => {
    window.__mofangPaths = { userDataAssets: 'C:\\ud\\data\\assets' };
    render(new CaptureClient());
    flushSync(() => btn('组卷网').click());
    await waitFor(() => expect(statusBarText()).toContain('组卷网'));
    flushSync(() => btn('导出试题篮').click());
    openPanel();
    await waitFor(() => {
      const item = container.querySelector('[data-testid="capture-item-13q900002"]') as HTMLElement;
      expect(item).not.toBeNull();
      const img = item.querySelector('img');
      expect(img).not.toBeNull();
      expect(img!.getAttribute('src')).toBe('file:///C:/ud/data/assets/capture/zujuan/13q900002-1.png');
    });
  });

  it('采集预览图：无 __mofangPaths（浏览器 dev）时回落占位', async () => {
    render(new CaptureClient());
    flushSync(() => btn('组卷网').click());
    await waitFor(() => expect(statusBarText()).toContain('组卷网'));
    flushSync(() => btn('导出试题篮').click());
    openPanel();
    await waitFor(() => {
      const item = container.querySelector('[data-testid="capture-item-13q900002"]') as HTMLElement;
      expect(item.querySelector('.asset-placeholder')).not.toBeNull();
      expect(item.querySelector('img[src^="data-assets/"]')).toBeNull();
    });
  });

  it('入库：结果 ok/dup/failed 精确展示 + 查看题库跳转出现', async () => {
    render(new CaptureClient());
    openPanel();
    expect(btn('入库').disabled).toBe(true);

    flushSync(() => btn('组卷网').click());
    await waitFor(() => expect(statusBarText()).toContain('组卷网'));
    flushSync(() => btn('导出试题篮').click());
    openPanel();
    await waitFor(() => expect(container.querySelectorAll('[data-testid^="capture-item-"]').length).toBe(3));

    expect(btn('入库').disabled).toBe(false);
    openPanel();
    flushSync(() => btn('入库').click());
    await waitFor(() => {
      expect(container.querySelector('[data-testid="collect-ok"]')!.textContent).toBe('3');
      expect(container.querySelector('[data-testid="collect-dup"]')!.textContent).toBe('0');
      expect(container.querySelector('[data-testid="collect-failed"]')!.textContent).toBe('0');
    });

    const goto = container.querySelector('[data-testid="goto-bank"]') as HTMLElement;
    expect(goto).not.toBeNull();
    flushSync(() => goto.click());
    // 0067 顺手修复（用户 2026-09-24 授权，原断言为 bug 现场）：按钮文案「查看题库」→ 题库管理页
    // `#/bank`（main.tsx 分发 + AppShell NAV_ITEMS['bank'].href）；旧实现写死 `#/` = 首页工作台。
    expect(window.location.hash).toBe('#/bank');
    expect(window.location.hash).not.toBe('#/');
  });

  it('菁优网：gated 题灰点 + 原因标注，告警列表展示', async () => {
    render(new CaptureClient());
    flushSync(() => btn('菁优网').click());
    await waitFor(() => expect(statusBarText()).toContain('菁优网'));
    flushSync(() => btn('导出试题篮').click());
    openPanel();
    await waitFor(() => {
      const gated = container.querySelector('[data-testid="capture-item-jyeoo-tid-900002"]') as HTMLElement;
      expect(gated).not.toBeNull();
      const badge = gated.querySelector('[data-testid="capture-answer-jyeoo-tid-900002"]')!;
      expect(badge.getAttribute('data-state')).toBe('missing');
      expect(badge.textContent).toContain('vip-gated');
      expect(container.querySelector('[data-testid="capture-warnings"]')!.textContent).toContain('vip-gated');
    });
  });

  it('轮询：getState 按间隔自动刷新（无需手动操作）', async () => {
    const client = new CaptureClient();
    const spy = vi.spyOn(client, 'getState');
    render(client, 20);
    await waitFor(() => {
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(3);
    });
  });

  it('学科下拉：两级选择默认高中+数学；改选初中+物理后入库 payload 带组合串「初中物理」（L-1 / P3-1）', async () => {
    const client = new CaptureClient();
    const collectSpy = vi.spyOn(client, 'collect');
    render(client);
    openPanel();

    const stageSel = container.querySelector('[data-testid="stage-select"]') as HTMLSelectElement;
    const sel = container.querySelector('[data-testid="subject-select"]') as HTMLSelectElement;
    expect(stageSel).not.toBeNull();
    expect(sel).not.toBeNull();
    expect(stageSel.value).toBe('高中');
    expect(sel.value).toBe('数学');
    // 字典异步加载：等「物理」进下拉再手选（原测试靠导航耗时隐式等待）
    await waitFor(() => expect([...sel.options].map((o) => o.value)).toContain('物理'));

    // 0012 目检返工：下拉在「采集界面」标签页——手选须在切到浏览器页之前完成
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    flushSync(() => {
      setter.call(stageSel, '初中');
      stageSel.dispatchEvent(new Event('change', { bubbles: true }));
      setter.call(sel, '物理');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(stageSel.value).toBe('初中');
    expect(sel.value).toBe('物理');

    flushSync(() => btn('组卷网').click());
    await waitFor(() => expect(statusBarText()).toContain('组卷网'));

    flushSync(() => btn('导出试题篮').click());
    openPanel();
    await waitFor(() => expect(container.querySelectorAll('[data-testid^="capture-item-"]').length).toBe(3));
    openPanel();
    flushSync(() => btn('入库').click());
    await waitFor(() => expect(collectSpy).toHaveBeenCalled());
    expect(collectSpy.mock.calls[0][0].subject).toBe('初中物理');
  });

  it('入库后预览徽标刷新为补抓后状态（D1-fix-4 复验：答案/解析 enrich 在主进程 collect 内完成，旧副本不回显）', async () => {
    const { MOCK_ZUJUAN_EXTRACTION } = await import('../../src/app/capture/mock-capture-data.js');
    // 入库前解析为空（徽标 missing）；collect 返回 enriched captured（解析已补抓）
    const preEnrich = {
      ...MOCK_ZUJUAN_EXTRACTION,
      captured: MOCK_ZUJUAN_EXTRACTION.captured.map((q) => ({ ...q, analysisHtml: '' })),
    };
    const enriched = {
      ...preEnrich,
      captured: preEnrich.captured.map((q) => ({ ...q, analysisHtml: '<p>解析：补抓完成</p>' })),
    };
    const bridge: any = {
      async openWindow() {},
      async closeWindow() {},
      async navigate() {},
      async getState() {
        return { open: true, url: 'https://zujuan.xkw.com', title: '组卷网', site: 'zujuan', loggedIn: true, lastExtraction: null };
      },
      async extractBasket() { return { extracted: preEnrich }; },
      async collect() { return { ok: 3, dup: 0, failed: [], captured: enriched.captured }; },
      async getLastExtraction() { return { extracted: null }; },
    };
    render(new CaptureClient(bridge), 20);
    await waitFor(() => expect(statusBarText()).toContain('组卷网'));
    flushSync(() => btn('导出试题篮').click());
    openPanel();
    await waitFor(() => expect(container.querySelectorAll('[data-testid^="capture-item-"]').length).toBe(3));
    // 入库前：解析徽标 missing，文案为「待入库时补抓」（D1-fix-4 复验语义修正：补抓发生在入库动作时，不误导为已丢失）
    container.querySelectorAll('[data-testid^="capture-analysis-"]').forEach((b) => {
      expect(b.getAttribute('data-state')).toBe('missing');
      expect(b.textContent).toContain('待入库时补抓');
      expect(b.textContent).not.toContain('缺失');
    });

    openPanel();
    flushSync(() => btn('入库').click());
    await waitFor(() => expect(container.querySelector('[data-testid="collect-ok"]')!.textContent).toBe('3'));
    // 入库后：徽标刷新为 ok（enriched captured 回显）
    container.querySelectorAll('[data-testid^="capture-analysis-"]').forEach((b) =>
      expect(b.getAttribute('data-state')).toBe('ok'),
    );
  });

  it('采集窗控件条提取后：轮询发现新 lastExtraction 自动同步预览到主窗（L-2）', async () => {
    const { MOCK_ZUJUAN_EXTRACTION } = await import('../../src/app/capture/mock-capture-data.js');
    const bridge: any = {
      async openWindow() {},
      async closeWindow() {},
      async navigate() {},
      async getState() {
        return {
          open: true,
          url: 'https://zujuan.xkw.com',
          title: '组卷网',
          site: 'zujuan',
          loggedIn: true,
          // 模拟控件条「导出试题篮」已在采集窗侧完成（主窗未点过采集）
          lastExtraction: { at: '2026-09-06T10:00:00.000Z', count: 3 },
        };
      },
      async extractBasket() { throw new Error('主窗未主动提取，不应调用'); },
      async collect() { return { ok: 0, dup: 0, failed: [] }; },
      async getLastExtraction() { return { extracted: MOCK_ZUJUAN_EXTRACTION }; },
    };
    render(new CaptureClient(bridge), 20);
    openPanel();
    await waitFor(() => {
      expect(container.querySelectorAll('[data-testid^="capture-item-"]').length).toBe(3);
    });
  });
});

// ==================== 0004-fix-1 D 组：采集进篮联动 ====================

describe('0004-fix-1 D：采集进篮联动（toBasket / okIds 加篮去重）', () => {
  /** mock 桥：extractBasket 回 zujuan 3 题；collect 回 okIds=3（对齐真实 ingest 语义） */
  function linkageBridge(okIds: string[]): any {
    return {
      async openWindow() {},
      async closeWindow() {},
      async navigate() {},
      async getState() {
        return { open: true, url: 'https://zujuan.xkw.com', title: '组卷网', site: 'zujuan', loggedIn: true, lastExtraction: null };
      },
      async extractBasket() {
        const { MOCK_ZUJUAN_EXTRACTION } = await import('../../src/app/capture/mock-capture-data.js');
        return { extracted: MOCK_ZUJUAN_EXTRACTION };
      },
      async collect() { return { ok: okIds.length, dup: 0, failed: [], okIds }; },
      async getLastExtraction() { return { extracted: null }; },
    };
  }

  it('0011 toBasket：顶部横幅「目标试题篮：<标题>」+ 主按钮「加入当前试题篮（同步入库）」+ 默认挂篮（无勾选框）', async () => {
    const { svc } = createSvc();
    const paper = await svc.bank.createPaper('采集联动篮');
    // 已在篮 1 题（okIds 首条）→ 只加后两条
    const q0 = await svc.bank.createQuestion({ subject: '物理', sourceType: 'local', sourceDetail: { origin: 'test' }, content: '<p>已在篮</p>', images: [] });
    await svc.bank.addQuestion(paper.id, q0.id);
    const addSpy = vi.spyOn(svc.bank, 'addQuestion');

    window.location.hash = `#/capture?toBasket=${paper.id}`;
    render(new CaptureClient(linkageBridge([q0.id, 'mock-q-b', 'mock-q-c'])), 20, svc);
    openPanel();

    // 顶部目标横幅：toBasket 语义定稿文案（常显）
    await waitFor(() => {
      expect(container.querySelector('[data-testid="capture-target-banner"]')!.textContent)
        .toContain('目标试题篮：采集联动篮');
    });
    // toBasket 场景勾选框移除（默认挂篮）+ 主按钮为「加入当前试题篮（同步入库）」
    expect(container.querySelector('[data-testid="capture-add-basket-checkbox"]')).toBeNull();
    expect(findBtn('入库')).toBeNull();
    expect(findBtn('加入当前试题篮（同步入库）')).not.toBeNull();

    await waitFor(() => expect(statusBarText()).toContain('组卷网'));
    flushSync(() => btn('导出试题篮').click());
    openPanel();
    await waitFor(() => expect(container.querySelectorAll('[data-testid^="capture-item-"]').length).toBe(3));

    openPanel();
    flushSync(() => btn('加入当前试题篮（同步入库）').click());
    await waitFor(() => {
      expect(container.querySelector('[data-testid="capture-basket-notice"]')!.textContent)
        .toBe('2 题已加入试题篮「采集联动篮」（已在篮跳过 1 题）');
    });
    // 去重：已在篮的 q0 未再 addQuestion
    expect(addSpy.mock.calls.map((c) => c[1])).toEqual(['mock-q-b', 'mock-q-c']);
    expect((await svc.bank.getPaperQuestions(paper.id)).map((r) => r.questionId).sort())
      .toEqual([q0.id, 'mock-q-b', 'mock-q-c'].sort());

    // 回篮按钮跳转（无 from → 落目标篮详情）
    flushSync(() => (container.querySelector('[data-testid="back-to-basket"]') as HTMLButtonElement).click());
    expect(window.location.hash).toBe(`#/basket/${paper.id}`);
  });

  it('0011-fix 同步挂篮：题已在库（collect 判 dup，okIds 不含）→ 仍按本批采集题全量加入目标篮', async () => {
    const { svc } = createSvc();
    const paper = await svc.bank.createPaper('重复题同步篮');
    // 题库中已存在本批采集的 3 道题（站点键 site:questionId 对齐 mock 提取数据）——
    // 模拟「此前采过/换篮重采」：主进程 ingest 判 dup，okIds 为空
    const bankIds: string[] = [];
    for (const qid of ['13q900001', '13q900002', '13q900003']) {
      const q = await svc.bank.createQuestion({
        subject: '数学', sourceType: 'network',
        sourceDetail: { site: 'zujuan', questionId: qid, url: 'https://zujuan.xkw.com' },
        content: `<div class="question">库内已有 ${qid}</div>`, images: [],
      });
      bankIds.push(q.id);
    }
    const dupBridge = {
      async openWindow() {},
      async closeWindow() {},
      async navigate() {},
      async getState() {
        return { open: true, url: 'https://zujuan.xkw.com', title: '组卷网', site: 'zujuan', loggedIn: true, lastExtraction: null };
      },
      async extractBasket() {
        const { MOCK_ZUJUAN_EXTRACTION } = await import('../../src/app/capture/mock-capture-data.js');
        return { extracted: MOCK_ZUJUAN_EXTRACTION };
      },
      async collect() { return { ok: 0, dup: 3, failed: [], okIds: [] }; },
      async getLastExtraction() { return { extracted: null }; },
    };

    window.location.hash = `#/capture?toBasket=${paper.id}`;
    render(new CaptureClient(dupBridge), 20, svc);
    openPanel();
    await waitFor(() => {
      expect(container.querySelector('[data-testid="capture-target-banner"]')!.textContent)
        .toContain('目标试题篮：重复题同步篮');
    });
    await waitFor(() => expect(statusBarText()).toContain('组卷网'));
    flushSync(() => btn('导出试题篮').click());
    openPanel();
    await waitFor(() => expect(container.querySelectorAll('[data-testid^="capture-item-"]').length).toBe(3));

    openPanel();
    flushSync(() => btn('加入当前试题篮（同步入库）').click());
    await waitFor(() => {
      expect(container.querySelector('[data-testid="capture-basket-notice"]')!.textContent)
        .toBe('3 题已加入试题篮「重复题同步篮」');
    });
    // dup 题不再静默丢：三道已在库的题全部挂进目标篮
    expect((await svc.bank.getPaperQuestions(paper.id)).map((r) => r.questionId).sort())
      .toEqual([...bankIds].sort());
  });

  it('0011-fix 入库/挂篮结果栏上移：结果显示在采集预览区之前（不被长列表压底）', async () => {
    const { svc } = createSvc();
    const paper = await svc.bank.createPaper('结果位置篮');
    window.location.hash = `#/capture?toBasket=${paper.id}`;
    render(new CaptureClient(linkageBridge(['mock-q-pos'])), 20, svc);
    openPanel();
    await waitFor(() => {
      expect(container.querySelector('[data-testid="capture-target-banner"]')!.textContent).toContain('结果位置篮');
    });
    await waitFor(() => expect(statusBarText()).toContain('组卷网'));
    flushSync(() => btn('导出试题篮').click());
    openPanel();
    await waitFor(() => expect(container.querySelectorAll('[data-testid^="capture-item-"]').length).toBe(3));
    openPanel();
    flushSync(() => btn('加入当前试题篮（同步入库）').click());
    await waitFor(() => {
      if (!container.querySelector('[data-testid="collect-result"]')) throw new Error('结果栏未渲染');
    });
    const result = container.querySelector('[data-testid="collect-result"]')!;
    const preview = [...container.querySelectorAll('section')].find((s) => s.querySelector('h2')?.textContent?.startsWith('采集预览'));
    expect(preview).not.toBeNull();
    // DOM 序：结果栏在采集预览之前（compareDocumentPosition FOLLOWING = preview 在 result 之后）
    expect(result.compareDocumentPosition(preview!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('0011 toBasket 装载失败：错误提示并回 #/basket', async () => {
    const { svc } = createSvc();
    window.location.hash = '#/capture?toBasket=missing-paper';
    render(new CaptureClient(linkageBridge([])), 20, svc);
    openPanel();
    await waitFor(() => {
      if (window.location.hash !== '#/basket') throw new Error(`未回列表：${window.location.hash}`);
    });
    expect(container.querySelector('[data-testid="capture-error"]')!.textContent).toContain('目标试题篮');
  });

  it('0011 主按钮文案：无 toBasket 保持「入库」', async () => {
    const { svc } = createSvc();
    render(new CaptureClient(linkageBridge([])), 20, svc);
    openPanel();
    await waitFor(() => expect(findBtn('入库')).not.toBeNull());
    expect(findBtn('加入当前试题篮（同步入库）')).toBeNull();
    expect(container.querySelector('[data-testid="capture-target-banner"]')).toBeNull();
  });

  it('0011 无 toBasket + 多张处理中：目标下拉选择，勾选+入库加到选中篮', async () => {
    const { svc } = createSvc();
    const p1 = await svc.bank.createPaper('多篮甲');
    // 0014 顺手修复既有偶发：listPapersEx 契约=created_at DESC（最新篮在前）。两卷同毫秒创建时
    // 稳定排序保留插入序，断言曾被同毫秒巧合养绿；显式错开毫秒使命中确定（mock 单跑实测约 1/200 跨毫秒翻转）
    await new Promise((resolve) => setTimeout(resolve, 2));
    const p2 = await svc.bank.createPaper('多篮乙');
    render(new CaptureClient(linkageBridge(['mock-q-m'])), 20, svc);
    openPanel();

    await waitFor(() => {
      if (!container.querySelector('[data-testid="capture-basket-target-select"]')) throw new Error('目标下拉未渲染');
    });
    const sel = container.querySelector('[data-testid="capture-basket-target-select"]') as HTMLSelectElement;
    // 0055（R-063）等强适配：下拉末项恒为「＋ 新建试题篮…」——选项仍逐项精确断言（未放宽）
    expect([...sel.options].map((o) => o.text)).toEqual(['多篮乙', '多篮甲', '＋ 新建试题篮…']);
    expect(container.querySelector('[data-testid="capture-add-basket-checkbox"]')).not.toBeNull();

    // 选「多篮乙」+ 勾选 → 横幅指到乙
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    flushSync(() => {
      setter.call(sel, p2.id);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    flushSync(() => (container.querySelector('[data-testid="capture-add-basket-checkbox"]') as HTMLInputElement).click());
    await waitFor(() => {
      expect(container.querySelector('[data-testid="capture-target-banner"]')!.textContent).toContain('多篮乙');
    });

    await waitFor(() => expect(statusBarText()).toContain('组卷网'));
    flushSync(() => btn('导出试题篮').click());
    openPanel();
    await waitFor(() => expect(container.querySelectorAll('[data-testid^="capture-item-"]').length).toBe(3));
    openPanel();
    flushSync(() => btn('入库').click());

    await waitFor(() => {
      expect(container.querySelector('[data-testid="capture-basket-notice"]')!.textContent).toContain('多篮乙');
    });
    expect((await svc.bank.getPaperQuestions(p2.id)).map((r) => r.questionId)).toEqual(['mock-q-m']);
    expect((await svc.bank.getPaperQuestions(p1.id)).length).toBe(0);
  });

  it('0011 回到试题篮：from 参数优先（compose 来源回排版页）', async () => {
    const { svc } = createSvc();
    const paper = await svc.bank.createPaper('回跳来源篮');
    window.location.hash = `#/capture?toBasket=${paper.id}&from=compose/${paper.id}`;
    render(new CaptureClient(linkageBridge(['mock-q-f'])), 20, svc);
    openPanel();

    await waitFor(() => {
      expect(container.querySelector('[data-testid="capture-target-banner"]')!.textContent)
        .toContain('目标试题篮：回跳来源篮');
    });
    await waitFor(() => expect(statusBarText()).toContain('组卷网'));
    flushSync(() => btn('导出试题篮').click());
    openPanel();
    await waitFor(() => expect(container.querySelectorAll('[data-testid^="capture-item-"]').length).toBe(3));
    openPanel();
    flushSync(() => btn('加入当前试题篮（同步入库）').click());
    await waitFor(() => {
      if (!container.querySelector('[data-testid="back-to-basket"]')) throw new Error('回篮按钮未出现');
    });
    flushSync(() => (container.querySelector('[data-testid="back-to-basket"]') as HTMLButtonElement).click());
    expect(window.location.hash).toBe(`#/compose/${paper.id}`);
  });

  it('无 toBasket + 存在处理中卷：勾选项常驻，勾上后入库即加入该篮', async () => {
    const { svc } = createSvc();
    const paper = await svc.bank.createPaper('处理中草稿篮');
    render(new CaptureClient(linkageBridge(['mock-q-x'])), 20, svc);
    openPanel();

    await waitFor(() => {
      expect(container.querySelector('[data-testid="capture-add-basket-checkbox"]')).not.toBeNull();
    });
    // 未勾选：无目标提示条
    expect(container.querySelector('[data-testid="capture-target-banner"]')).toBeNull();

    flushSync(() => (container.querySelector('[data-testid="capture-add-basket-checkbox"]') as HTMLInputElement).click());
    await waitFor(() => {
      expect(container.querySelector('[data-testid="capture-target-banner"]')!.textContent)
        .toContain('将加入：试题篮 处理中草稿篮');
    });

    await waitFor(() => expect(statusBarText()).toContain('组卷网'));
    flushSync(() => btn('导出试题篮').click());
    openPanel();
    await waitFor(() => expect(container.querySelectorAll('[data-testid^="capture-item-"]').length).toBe(3));
    openPanel();
    flushSync(() => btn('入库').click());

    await waitFor(async () => {
      expect(container.querySelector('[data-testid="capture-basket-notice"]')!.textContent)
        .toBe('1 题已加入试题篮「处理中草稿篮」');
    });
    expect((await svc.bank.getPaperQuestions(paper.id)).map((r) => r.questionId)).toEqual(['mock-q-x']);
  });

  it('无 toBasket 且无处理中卷：行为不变（无勾选项、无加篮横幅）', async () => {
    const { svc } = createSvc();
    render(new CaptureClient(linkageBridge(['mock-q-1'])), 20, svc);
    openPanel();
    await waitFor(() => expect(container.querySelector('[data-testid="capture-add-basket-checkbox"]')).toBeNull());

    await waitFor(() => expect(statusBarText()).toContain('组卷网'));
    flushSync(() => btn('导出试题篮').click());
    openPanel();
    await waitFor(() => expect(container.querySelectorAll('[data-testid^="capture-item-"]').length).toBe(3));
    openPanel();
    flushSync(() => btn('入库').click());
    await waitFor(() => expect(container.querySelector('[data-testid="collect-ok"]')!.textContent).toBe('1'));
    expect(container.querySelector('[data-testid="capture-basket-notice"]')).toBeNull();
  });

  it('mock 双跑：createMockCaptureBridge.collect 返回 okIds（与真实链路语义一致，dup 不含）', async () => {
    const { createMockCaptureBridge, MOCK_ZUJUAN_EXTRACTION } = await import('../../src/app/capture/mock-capture-data.js');
    const bridge = createMockCaptureBridge();
    const first = await bridge.collect({ extracted: MOCK_ZUJUAN_EXTRACTION });
    expect(first.ok).toBe(3);
    expect(first.okIds).toHaveLength(3);
    expect(first.okIds!.every((id) => id.startsWith('mock-q-zujuan:'))).toBe(true);
    // 二次采集全 dup → okIds 空
    const second = await bridge.collect({ extracted: MOCK_ZUJUAN_EXTRACTION });
    expect(second.dup).toBe(3);
    expect(second.okIds).toEqual([]);
  });
});

// ==================== 0011：返回机制（hash ?from= 显式参数，Q1-3 拍板） ====================

describe('0011 采集页返回 from-aware（fallback #/basket）', () => {
  it('带 from=basket/* → 按钮「返回试题篮」，点击落 from 指向页（#/basket/p9）', async () => {
    const { svc } = createSvc();
    window.location.hash = '#/capture?from=basket/p9';
    render(new CaptureClient(), 1000, svc);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="capture-back-btn"]')) throw new Error('返回按钮未渲染');
    });
    // 0011-fix：返回按钮指名道姓（目检返工二）
    expect(container.querySelector('[data-testid="capture-back-btn"]')!.textContent).toBe('返回试题篮');
    flushSync(() => (container.querySelector('[data-testid="capture-back-btn"]') as HTMLButtonElement).click());
    expect(window.location.hash).toBe('#/basket/p9');
  });

  it('带 from=compose/<id> → 按钮「返回排版」，点击回排版间（toBasket 用真实存在的篮）', async () => {
    const { svc } = createSvc();
    const paper = await svc.bank.createPaper('from 探针篮');
    window.location.hash = `#/capture?toBasket=${paper.id}&from=compose/${paper.id}`;
    render(new CaptureClient(), 1000, svc);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="capture-back-btn"]')) throw new Error('返回按钮未渲染');
    });
    expect(container.querySelector('[data-testid="capture-back-btn"]')!.textContent).toBe('返回排版');
    flushSync(() => (container.querySelector('[data-testid="capture-back-btn"]') as HTMLButtonElement).click());
    expect(window.location.hash).toBe(`#/compose/${paper.id}`);
  });

  it('无 from → 按钮「返回组卷」，点击落 #/basket（fallback 从 #/ 改为列表页）', async () => {
    const { svc } = createSvc();
    window.location.hash = '#/capture';
    render(new CaptureClient(), 1000, svc);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="capture-back-btn"]')) throw new Error('返回按钮未渲染');
    });
    expect(container.querySelector('[data-testid="capture-back-btn"]')!.textContent).toBe('返回组卷');
    flushSync(() => (container.querySelector('[data-testid="capture-back-btn"]') as HTMLButtonElement).click());
    expect(window.location.hash).toBe('#/basket');
  });
});

// ==================== 0006-fix-3 P3-1：CapturePage 学科下拉字典化 ====================

/** 下拉项 value 列表（断言字典驱动项） */
function optionValues(sel: HTMLSelectElement): string[] {
  return [...sel.options].map((o) => o.value);
}

function subjectSelect(): HTMLSelectElement {
  const el = container.querySelector('[data-testid="subject-select"]') as HTMLSelectElement | null;
  if (!el) throw new Error('找不到 subject-select');
  return el;
}

function stageSelect(): HTMLSelectElement {
  const el = container.querySelector('[data-testid="stage-select"]') as HTMLSelectElement | null;
  if (!el) throw new Error('找不到 stage-select');
  return el;
}

describe('P3-1：学科下拉字典驱动（0006-fix-3）', () => {
  it('dict 归一行驱动学科项（站点同义行不进下拉），默认高中+数学', async () => {
    const { svc } = createSvc();
    await svc.ext.dict.createEntry({ kind: 'subject', code: 'math', label: '数学' });
    await svc.ext.dict.createEntry({ kind: 'subject', code: 'physics', label: '物理' });
    await svc.ext.dict.createEntry({ kind: 'subject', code: 'biology', label: '生物' });
    await svc.ext.dict.createEntry({ kind: 'subject', code: 'physics', label: 'physics2', site: 'jyeoo', sourceLabel: 'physics2' });

    render(new CaptureClient(), 1000, svc);
    openPanel();
    await waitFor(() => expect(optionValues(subjectSelect())).toContain('生物'));
    // 归一行按 code 升序（MockDictService 同真实实现）；站点行被过滤
    expect(optionValues(subjectSelect())).toEqual(['生物', '数学', '物理']);
    expect(subjectSelect().value).toBe('数学');
    expect(stageSelect().value).toBe('高中');
  });

  it('空字典兜底：无归一行时回落 6 项常量（数学/物理/化学），默认组合串仍「高中数学」', async () => {
    const { svc } = createSvc();
    const client = new CaptureClient();
    const collectSpy = vi.spyOn(client, 'collect');
    render(client, 1000, svc);

    openPanel();
    await waitFor(() => expect(optionValues(subjectSelect())).toEqual(['数学', '物理', '化学']));
    expect(optionValues(stageSelect())).toEqual(['小学', '初中', '高中']);
    expect(subjectSelect().value).toBe('数学');

    flushSync(() => btn('组卷网').click());
    await waitFor(() => expect(statusBarText()).toContain('组卷网'));
    flushSync(() => btn('导出试题篮').click());
    openPanel();
    await waitFor(() => expect(container.querySelectorAll('[data-testid^="capture-item-"]').length).toBe(3));
    openPanel();
    flushSync(() => btn('入库').click());
    await waitFor(() => expect(collectSpy).toHaveBeenCalled());
    expect(collectSpy.mock.calls[0][0].subject).toBe('高中数学');
  });

  it('字典无「数学」时默认学科回落字典首项（选中值不悬空）', async () => {
    const { svc } = createSvc();
    await svc.ext.dict.createEntry({ kind: 'subject', code: 'physics', label: '物理' });
    render(new CaptureClient(), 1000, svc);
    openPanel();
    await waitFor(() => expect(optionValues(subjectSelect())).toEqual(['物理']));
    expect(subjectSelect().value).toBe('物理');
  });
});

// ==================== 0006 P4：组卷整卷下载（预览勾选 + 去向二选一） ====================

describe('0006 P4：整卷下载（mock 桥，UI 流程）', () => {
  const PAPER_URL = 'https://zujuan.xkw.com/4p2338916.html';

  function paperBridge() {
    const imported: any[] = [];
    const bridge: any = {
      async openWindow() {},
      async closeWindow() {},
      async navigate() {},
      async getState() {
        return { open: false, url: '', title: '', site: null, loggedIn: false, lastExtraction: null };
      },
      async extractBasket() { throw new Error('整卷下载不得调用试题篮提取'); },
      async collect() { throw new Error('整卷下载不得调用试题篮 collect'); },
      async getLastExtraction() { return { extracted: null }; },
      async paperPreview({ url }: { url: string }) {
        if (!/zujuan\.xkw\.com\/\d+p\d+\.html/.test(url)) throw new Error('仅支持组卷网整卷详情页 URL（https://zujuan.xkw.com/{bankId}p{paperId}.html）');
        return {
          url,
          bankId: '4',
          paperId: '2338916',
          title: '广东省东莞市东华初级中学2024-2025学年八年级上学期11月期中物理试题',
          total: 3,
          missing: [],
          warnings: ['第 3 批未返回 1 题（站点覆盖率缺口）'],
          items: [
            { questionId: '22724580', bankid: '4', questionType: '单选题', difficulty: '较易', stemSummary: '探究物体吸收太阳能的能力与什么有关', answerPresent: true, analysisPresent: true, childCount: 1 },
            { questionId: '23283767', bankid: '4', questionType: '单选题', difficulty: '适中', stemSummary: '光的反射实验现象', answerPresent: true, analysisPresent: true, childCount: 1 },
            { questionId: '21875127', bankid: '4', questionType: '解答题', difficulty: '适中', stemSummary: '含 2 小题的母题', answerPresent: true, analysisPresent: false, childCount: 2 },
          ],
        };
      },
      async paperImport(payload: any) {
        imported.push(payload);
        return {
          target: payload.target,
          ...(payload.target === 'paper'
            ? { paperId: 'paper-p4-1', paperTitle: '广东省东莞市东华初级中学…物理试题', snapshotCount: payload.questionIds.length }
            : {}),
          ok: payload.questionIds.length,
          dup: 0,
          updated: 0,
          failed: [],
          warnings: [],
        };
      },
    };
    return { bridge, imported };
  }

  function paperInput(): HTMLInputElement {
    const el = container.querySelector('[data-testid="paper-url-input"]') as HTMLInputElement | null;
    if (!el) throw new Error('找不到 paper-url-input');
    return el;
  }

  function paperPreviewBtn(): HTMLButtonElement {
    const el = container.querySelector('[data-testid="paper-preview-button"]') as HTMLButtonElement | null;
    if (!el) throw new Error('找不到 paper-preview-button');
    return el;
  }

  async function previewAndWait() {
    flushSync(() => paperPreviewBtn().click());
    await waitFor(() => expect(container.querySelector('[data-testid="paper-preview-panel"]')).not.toBeNull());
  }

  it('粘贴整卷 URL → 预览面板：卷名/题号/题型/题干摘要/子母题标注/告警', async () => {
    const { bridge } = paperBridge();
    render(new CaptureClient(bridge), 1000);
    openPaper();

    const input = paperInput();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    flushSync(() => {
      setter.call(input, PAPER_URL);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await previewAndWait();

    const panel = container.querySelector('[data-testid="paper-preview-panel"]') as HTMLElement;
    expect(panel.textContent).toContain('广东省东莞市东华初级中学');
    expect(panel.textContent).toContain('共 3 题');
    expect(container.querySelector('[data-testid="paper-item-22724580"]')!.textContent).toContain('单选题');
    expect(container.querySelector('[data-testid="paper-item-22724580"]')!.textContent).toContain('探究物体吸收太阳能');
    expect(container.querySelector('[data-testid="paper-item-21875127"]')!.textContent).toContain('含 2 小题');
    expect(container.querySelector('[data-testid="paper-preview-warnings"]')!.textContent).toContain('覆盖率缺口');
    // 整卷下载与试题篮零交互
    expect(container.querySelectorAll('[data-testid^="capture-item-"]')).toHaveLength(0);
  });

  it('默认全选 + 默认去向成品卷；取消勾选后导入仅提交勾选题', async () => {
    const { bridge, imported } = paperBridge();
    render(new CaptureClient(bridge), 1000);
    openPaper();

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    flushSync(() => {
      setter.call(paperInput(), PAPER_URL);
      paperInput().dispatchEvent(new Event('input', { bubbles: true }));
    });
    await previewAndWait();

    expect((container.querySelector('[data-testid="paper-check-22724580"]') as HTMLInputElement).checked).toBe(true);
    expect((container.querySelector('[data-testid="paper-target-paper"]') as HTMLInputElement).checked).toBe(true);

    // 取消第 2 题
    flushSync(() => (container.querySelector('[data-testid="paper-check-23283767"]') as HTMLInputElement).click());
    flushSync(() => (container.querySelector('[data-testid="paper-import-button"]') as HTMLButtonElement).click());

    await waitFor(() => expect(imported).toHaveLength(1));
    expect(imported[0]).toEqual({
      url: PAPER_URL,
      questionIds: ['22724580', '21875127'],
      target: 'paper',
    });
    await waitFor(() => expect(container.querySelector('[data-testid="paper-import-result"]')!.textContent).toContain('成品卷'));
    expect(container.querySelector('[data-testid="paper-import-result"]')!.textContent).toContain('2 题');
  });

  it('去向二选一：散题入题库 → target=bank，结果显示入库计数', async () => {
    const { bridge, imported } = paperBridge();
    render(new CaptureClient(bridge), 1000);
    openPaper();

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    flushSync(() => {
      setter.call(paperInput(), PAPER_URL);
      paperInput().dispatchEvent(new Event('input', { bubbles: true }));
    });
    await previewAndWait();

    flushSync(() => (container.querySelector('[data-testid="paper-target-bank"]') as HTMLInputElement).click());
    expect((container.querySelector('[data-testid="paper-target-bank"]') as HTMLInputElement).checked).toBe(true);
    flushSync(() => (container.querySelector('[data-testid="paper-import-button"]') as HTMLButtonElement).click());

    await waitFor(() => expect(imported).toHaveLength(1));
    expect(imported[0].target).toBe('bank');
    expect(imported[0].questionIds).toEqual(['22724580', '23283767', '21875127']);
    await waitFor(() => {
      const result = container.querySelector('[data-testid="paper-import-result"]')!.textContent!;
      expect(result).toContain('入库');
      expect(result).toContain('3');
    });
  });

  it('全不选 → 导入按钮禁用；非整卷 URL → 错误提示（不发起预览）', async () => {
    const { bridge } = paperBridge();
    render(new CaptureClient(bridge), 1000);
    openPaper();

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    flushSync(() => {
      setter.call(paperInput(), PAPER_URL);
      paperInput().dispatchEvent(new Event('input', { bubbles: true }));
    });
    await previewAndWait();

    for (const id of ['22724580', '23283767', '21875127']) {
      const cb = container.querySelector(`[data-testid="paper-check-${id}"]`) as HTMLInputElement;
      if (cb.checked) flushSync(() => cb.click());
    }
    expect((container.querySelector('[data-testid="paper-import-button"]') as HTMLButtonElement).disabled).toBe(true);

    flushSync(() => {
      setter.call(paperInput(), 'https://www.jyeoo.com/physics2/ques/detail/abc');
      paperInput().dispatchEvent(new Event('input', { bubbles: true }));
    });
    flushSync(() => paperPreviewBtn().click());
    await waitFor(() => expect(container.querySelector('[data-testid="paper-error"]')).not.toBeNull());
    expect(container.querySelector('[data-testid="paper-error"]')!.textContent).toContain('zujuan.xkw.com');
  });

  it('浏览器 dev 默认 mock 桥：paperPreview/paperImport 可用（无 Electron 也能走通面板）', async () => {
    const { createMockCaptureBridge } = await import('../../src/app/capture/mock-capture-data.js');
    const bridge = createMockCaptureBridge();
    const preview = await bridge.paperPreview({ url: PAPER_URL });
    expect(preview.items.length).toBeGreaterThan(0);
    expect(preview.url).toBe(PAPER_URL);
    const result = await bridge.paperImport({ url: PAPER_URL, questionIds: [preview.items[0].questionId], target: 'paper' });
    expect(result.target).toBe('paper');
    expect(result.ok).toBe(1);
  });
});
