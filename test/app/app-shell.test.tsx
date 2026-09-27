// 0010-merge：导航壳 v2 + 三主题验收测试（0010-merge 任务书 §三.1）
// 0011 改版：多篮正式化 + 导航合并（Q1-4 拍板）——「组卷排版」+「试卷管理」并为一条「组卷」恒 #/basket，
// 4 组 11 条 → 10 条（nav-basket 退役，唯一授权删除）；resolveComposeHref 三态解析链全删。
// 覆盖：导航文案与映射、路由高亮（#/basket、#/basket/:id、#/compose/:id 均高亮「组卷」）、
// 侧栏折叠（mfa-nav-collapsed 持久化 + 重挂载保持 + 折叠态 title）、主题切换（机制沿用）、
// index.html 防闪烁、品牌位 Logo（展开/折叠两态）、左下固定区（皮肤开关 + 设置入口）、
// 纸张隔离探针（iframe 无 data-theme、theme.css 无穿透选择器）。
// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import { AppShell, NAV_COLLAPSED_KEY } from '../../src/app/components/AppShell.js';
import { ComposePage } from '../../src/app/pages/ComposePage.js';
import { THEME_KEY, type AppTheme } from '../../src/app/theme.js';
import { MockBankService } from '../../src/bank/mock/mock-bank.js';
import { createMockExtServices } from '../../src/bank/mock/mock-ext.js';
import { MockBankStore } from '../../src/bank/mock/mock-store.js';
import type { ExtPageServices } from '../../src/app/pages/ExtUi.js';

let container: HTMLDivElement;
let root: Root | null = null;

/** 隔离 mock 服务（空 store 起步，组卷排版三态断言确定性） */
function makeSvc(store = new MockBankStore()): ExtPageServices {
  const bank = new MockBankService(store, false);
  return { bank, ext: createMockExtServices(store) };
}

function renderShell(route: string, svc?: ExtPageServices) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => {
    root!.render(<AppShell route={route} svc={svc}><div data-testid="page-slot">PAGE</div></AppShell>);
  });
}

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  localStorage.removeItem(THEME_KEY);
  localStorage.removeItem(NAV_COLLAPSED_KEY);
  document.documentElement.removeAttribute('data-theme');
});

function navItem(key: string): HTMLElement {
  const el = container.querySelector(`[data-testid="nav-${key}"]`);
  if (!el) throw new Error(`找不到导航条目 nav-${key}`);
  return el as HTMLElement;
}

// ---------------- 导航渲染 ----------------

// 0036（返工 2026-09-18）：备课工具组新增「PDF 切题」——原 10 条 → 11 条（用户目检要求：
// 「没有看到继续切题与项目列表」，需给已有切题项目一个入口，否则只能靠重复拖 PDF 进工作区）
// 0040（2026-09-19）：任务书 §二 P2.2——「试题录入」+「PDF 切题」两项**合并**为「录题工作台」（#/intake）
// → 4 组 11 条 → 10 条；#/split 路由保留（入口页卡二进入），故两条旧路由仍高亮「录题工作台」。
describe('0011 导航壳：4 组 10 条（组卷合并 Q1-4 + 0040 录题工作台三入口合并）', () => {
  it('渲染 4 个分组，条目文案与映射表一致（组卷排版+试卷管理 → 组卷）', () => {
    renderShell('#/', makeSvc());
    const groups = [...container.querySelectorAll('.nav-group')];
    expect(groups.map((g) => g.querySelector('.nav-group-title')!.textContent)).toEqual([
      '首页', '备课工具', '学生管理', '课后反馈',
    ]);

    const labels = [...container.querySelectorAll('.nav-item .nav-label')].map((el) => el.textContent);
    expect(labels).toEqual([
      '首页',
      '题库管理', '网络采集', '试卷管理', '录题工作台', // 0044（D-060⑦）：「组卷」更名「试卷管理」
      '学生档案', '班级管理', '考试管理', '错题本',
      '课后反馈',
    ]);
    // 落地路由抽查（映射表逐项）
    expect(navItem('home').getAttribute('href')).toBe('#/');
    expect(navItem('bank').getAttribute('href')).toBe('#/bank');
    expect(navItem('capture').getAttribute('href')).toBe('#/capture');
    // 0040：三入口合并——「录题工作台」恒落 #/intake；旧「试题录入（#/proof）」「PDF 切题（#/split）」条目退役
    expect(navItem('intake').getAttribute('href')).toBe('#/intake');
    expect(container.querySelector('[data-testid="nav-proof"]')).toBeNull();
    expect(container.querySelector('[data-testid="nav-split"]')).toBeNull();
    expect(navItem('students').getAttribute('href')).toBe('#/students');
    expect(navItem('classes').getAttribute('href')).toBe('#/classes');
    expect(navItem('exams').getAttribute('href')).toBe('#/exams');
    expect(navItem('mistakes').getAttribute('href')).toBe('#/mistakes');
    expect(navItem('feedback').getAttribute('href')).toBe('#/feedback');
    // 0011：组卷条目原恒 #/basket；0044（D-060⑦）：更名「试卷管理」并落 #/papers；nav-basket 退役
    expect(navItem('compose').getAttribute('href')).toBe('#/papers');
    expect(container.querySelector('[data-testid="nav-basket"]')).toBeNull();
  });
});

// ---------------- 路由高亮 ----------------

describe('0011 导航壳：路由高亮（子页父项高亮）', () => {
  it.each([
    ['#/bank', 'bank'],
    ['#/capture?toBasket=p1', 'capture'],
    ['#/compose/p123', 'compose'],
    ['#/paper/p1', 'compose'], // 旧路由重定向期间父项高亮
    ['#/proof', 'intake'], // 0040：#/proof 重定向 #/intake，高亮归「录题工作台」
    ['#/proof/abc', 'intake'], // 旧直链兼容期同高亮
    ['#/intake', 'intake'],
    ['#/intake/run-1', 'intake'],
    ['#/split', 'intake'], // 0036 路由保留：入口页卡二进入，父项归「录题工作台」
    ['#/split/p1', 'intake'],
    ['#/basket', 'compose'], // 0011：列表页并入「组卷」条目；0044 重定向 #/papers 后同样高亮
    ['#/papers', 'compose'], // 0044：试卷管理页主路由
    ['#/basket/p9', 'compose'], // 子页父项（篮详情/排版页归「组卷」高亮）
    ['#/students', 'students'],
    ['#/students/s1', 'students'],
    ['#/classes/c1', 'classes'],
    ['#/exams', 'exams'],
    ['#/exams/e9', 'exams'], // 子页父项
    ['#/mistakes', 'mistakes'],
    ['#/feedback', 'feedback'],
  ])('%s → %s 高亮', (route, key) => {
    renderShell(route, makeSvc());
    for (const item of ['home', 'bank', 'capture', 'compose', 'intake', 'students', 'classes', 'exams', 'mistakes', 'feedback']) {
      expect(navItem(item).getAttribute('data-active')).toBe(item === key ? 'true' : 'false');
    }
  });

  it('未知路由回落首页高亮', () => {
    renderShell('#/nonexistent', makeSvc());
    expect(navItem('home').getAttribute('data-active')).toBe('true');
  });
});

// ---------------- 组卷条目恒静态（0011 无三态解析；0044 D-060⑦ 起恒 #/papers 试卷管理页） ----------------

describe('0011 组卷条目恒静态（0044 起恒 #/papers——resolveComposeHref 解析链已删）', () => {
  async function svcWithPapers(statuses: Array<'basket' | 'composing' | 'done'>): Promise<ExtPageServices> {
    const store = new MockBankStore();
    const bank = new MockBankService(store, false);
    const ext = createMockExtServices(store);
    const ids: string[] = [];
    // mock 状态机：basket → composing → done（done 需逐级迁移）
    const chain: Record<string, string[]> = { basket: [], composing: ['composing'], done: ['composing', 'done'] };
    for (const status of statuses) {
      const paper = await bank.createPaper(`卷-${status}-${ids.length}`);
      for (const step of chain[status]) {
        await ext.paper.updatePaperStatus(paper.id, step as 'composing' | 'done');
      }
      ids.push(paper.id);
    }
    return { bank, ext };
  }

  it('恰 1 卷处理中 → href 恒 #/papers（0044 试卷管理页），点击直接跳转', async () => {
    const svc = await svcWithPapers(['basket']);
    renderShell('#/', svc);
    expect(navItem('compose').getAttribute('href')).toBe('#/papers');
    // jsdom 锚点 hash 导航异步落地 → waitFor
    flushSync(() => navItem('compose').click());
    await vi.waitFor(() => {
      expect(window.location.hash).toBe('#/papers');
    });
  });

  it('多卷处理中（多篮并存）→ href 恒 #/papers', async () => {
    const svc = await svcWithPapers(['basket', 'composing']);
    renderShell('#/', svc);
    expect(navItem('compose').getAttribute('href')).toBe('#/papers');
  });

  it('0 卷处理中 → href 恒 #/papers；点击直接跳转', async () => {
    const svc = await svcWithPapers(['done']);
    renderShell('#/', svc);
    expect(navItem('compose').getAttribute('href')).toBe('#/papers');
    flushSync(() => navItem('compose').click());
    await vi.waitFor(() => {
      expect(window.location.hash).toBe('#/papers');
    });
  });

  it('查询失败也不影响：href 静态恒 #/papers（无运行时解析依赖）', async () => {
    const store = new MockBankStore();
    const svc: ExtPageServices = {
      bank: new MockBankService(store, false),
      ext: {
        ...createMockExtServices(store),
        paper: {
          ...createMockExtServices(store).paper,
          listPapersEx: async () => {
            throw new Error('ipc down');
          },
        },
      },
    };
    renderShell('#/', svc);
    expect(navItem('compose').getAttribute('href')).toBe('#/papers');
  });
});

// ---------------- 侧栏折叠 ----------------

describe('0010-merge 侧栏折叠（mfa-nav-collapsed）', () => {
  it('点击品牌行开关 → 折叠态（aside.collapsed）+ localStorage="1" + 条目出现 title 提示', () => {
    renderShell('#/', makeSvc());
    const toggle = container.querySelector('[data-testid="sidebar-collapse-toggle"]') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    flushSync(() => toggle.click());
    expect(container.querySelector('aside.sidebar')!.className).toBe('sidebar collapsed');
    expect(localStorage.getItem(NAV_COLLAPSED_KEY)).toBe('1');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // 折叠态：条目 title 悬浮提示出现（展开态无）
    expect(navItem('bank').getAttribute('title')).toBe('题库管理');
    expect(navItem('home').getAttribute('title')).toBe('首页');
  });

  it('重挂载（模拟重启）后折叠态保持', () => {
    renderShell('#/', makeSvc());
    flushSync(() => (container.querySelector('[data-testid="sidebar-collapse-toggle"]') as HTMLButtonElement).click());
    expect(localStorage.getItem(NAV_COLLAPSED_KEY)).toBe('1');

    root?.unmount();
    root = null;
    container.remove();
    renderShell('#/', makeSvc());
    expect(container.querySelector('aside.sidebar')!.className).toBe('sidebar collapsed');
  });

  it('再次点击展开 → localStorage="0"', () => {
    localStorage.setItem(NAV_COLLAPSED_KEY, '1');
    renderShell('#/', makeSvc());
    expect(container.querySelector('aside.sidebar')!.className).toBe('sidebar collapsed');
    flushSync(() => (container.querySelector('[data-testid="sidebar-collapse-toggle"]') as HTMLButtonElement).click());
    expect(container.querySelector('aside.sidebar')!.className).toBe('sidebar');
    expect(localStorage.getItem(NAV_COLLAPSED_KEY)).toBe('0');
    expect(navItem('bank').getAttribute('title')).toBeNull();
  });
});

// ---------------- 品牌位 Logo 与左下固定区 ----------------

describe('0010-merge 品牌位（Logo）与左下固定区', () => {
  it('展开态：方块标 + 「魔方助教」文字；折叠态：纯方块标（文字承载元素隐藏）', () => {
    renderShell('#/', makeSvc());
    const logo = container.querySelector('[data-testid="brand-logo"]') as HTMLImageElement;
    expect(logo).not.toBeNull();
    expect(logo.getAttribute('src')).toContain('logo-mark');
    expect(container.querySelector('[data-testid="brand-name"]')!.textContent).toBe('魔方助教');
    // 导航内不再放吉祥物（品牌位已被 Logo 占）
    expect(container.querySelectorAll('.sidebar [data-mascot]').length).toBe(0);

    flushSync(() => (container.querySelector('[data-testid="sidebar-collapse-toggle"]') as HTMLButtonElement).click());
    expect(container.querySelector('.sidebar.collapsed [data-testid="brand-logo"]')).not.toBeNull();
  });

  it('左下固定区自上而下 = 皮肤三档开关 → 设置入口（#/settings）', () => {
    renderShell('#/', makeSvc());
    const foot = container.querySelector('.sidebar-foot')!;
    expect(foot.querySelector('[data-testid="shell-theme-switch"]')).not.toBeNull();
    const settings = foot.querySelector('[data-testid="nav-settings"]') as HTMLAnchorElement;
    expect(settings).not.toBeNull();
    expect(settings.getAttribute('href')).toBe('#/settings');
    // 皮肤开关在设置入口之上
    expect(foot.firstElementChild!.contains(container.querySelector('[data-testid="shell-theme-switch"]'))).toBe(true);
  });
});

// ---------------- 主题切换 ----------------

describe('0010 主题机制（mfa-theme / data-theme，机制沿用）', () => {
  it.each<AppTheme>(['dark', 'light', 'warm'])('点「%s」→ html data-theme=%s 且 localStorage 持久化', (tier) => {
    renderShell('#/', makeSvc());
    const btn = container.querySelector(`[data-testid="shell-theme-switch-${tier}"]`) as HTMLButtonElement;
    expect(btn).not.toBeNull();
    flushSync(() => btn.click());
    expect(document.documentElement.getAttribute('data-theme')).toBe(tier);
    expect(localStorage.getItem(THEME_KEY)).toBe(tier);
  });

  it('缺省（无存储、无属性）→ 暖纸 warm', () => {
    renderShell('#/', makeSvc());
    expect(document.documentElement.getAttribute('data-theme')).toBe('warm');
    expect(localStorage.getItem(THEME_KEY)).toBe('warm');
  });
});

// ---------------- index.html 防闪烁脚本 ----------------

describe('0010 index.html 防闪烁内联脚本', () => {
  it('head 内脚本包含 mfa-theme 读取与 data-theme 写入', () => {
    const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf-8');
    expect(html).toContain('mfa-theme');
    expect(html).toContain('data-theme');
    expect(html).toContain("'warm'");
  });
});

// ---------------- 纸张隔离探针（§三.3，沿用） ----------------

describe('0010 纸张隔离：壳层主题不渗入预览 iframe', () => {
  it('ComposePage 壳渲染出 iframe；iframe 元素无 data-theme；theme.css 无穿透 iframe 的选择器', async () => {
    const svc = makeSvc();
    const paper = await svc.bank.createPaper('隔离探针卷');

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    document.documentElement.setAttribute('data-theme', 'dark');
    flushSync(() => {
      root!.render(
        <AppShell route={`#/compose/${paper.id}`} svc={svc}>
          <ComposePage paperId={paper.id} svc={svc} />
        </AppShell>,
      );
    });

    const iframe = await vi.waitFor(() => {
      const el = container.querySelector('[data-testid="compose-preview-iframe"]');
      expect(el).not.toBeNull();
      return el as HTMLIFrameElement;
    }, { timeout: 8000, interval: 100 });

    expect(iframe.getAttribute('data-theme')).toBeNull();

    const themeCss = readFileSync(resolve(process.cwd(), 'src/app/theme.css'), 'utf-8');
    expect(/iframe\s[^{]*\{/.test(themeCss)).toBe(false);
    expect(themeCss).not.toContain('srcdoc');
  });
});

// ---------------- 0018 P3：折叠态皮肤开关 compact 形态 ----------------

describe('0018 折叠态皮肤开关 compact 形态', () => {
  it('展开态无 compact 类；折叠态 theme-switch 带 compact（竖排形态），三档 testid 结构不变', () => {
    renderShell('#/', makeSvc());
    expect(container.querySelector('.theme-switch.compact')).toBeNull();
    flushSync(() => (container.querySelector('[data-testid="sidebar-collapse-toggle"]') as HTMLButtonElement).click());
    const sw = container.querySelector('.sidebar.collapsed .theme-switch') as HTMLElement;
    expect(sw).not.toBeNull();
    expect(sw.className).toContain('compact');
    // 三档按钮 testid 结构零变化（shell-theme-switch-{warm,light,dark}）
    for (const t of ['warm', 'light', 'dark']) {
      expect(container.querySelector(`[data-testid="shell-theme-switch-${t}"]`)).not.toBeNull();
    }
  });

  it('折叠态下三档可点：点 dark → data-theme=dark 且持久化（机制零回归）', () => {
    localStorage.setItem(NAV_COLLAPSED_KEY, '1');
    renderShell('#/', makeSvc());
    const btn = container.querySelector('[data-testid="shell-theme-switch-dark"]') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    flushSync(() => btn.click());
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem(THEME_KEY)).toBe('dark');
  });

  it('theme.css 追加 compact 竖排规则（flex-direction:column + min-width:0，防胶囊溢出裁切）', () => {
    const themeCss = readFileSync(resolve(process.cwd(), 'src/app/theme.css'), 'utf-8');
    expect(themeCss).toMatch(/\.theme-switch\.compact\s*\{[^}]*flex-direction:\s*column/);
    expect(themeCss).toMatch(/\.theme-switch\.compact\s*\{[^}]*min-width:\s*0/);
  });
});
