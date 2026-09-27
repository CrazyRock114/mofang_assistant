// 0004-fix-1 路由回归：采集路由带 query（#/capture?toBasket=<paperId>）必须命中 CapturePage
// 案底：main.tsx 原 `route === '#/capture'` 不匹配带 query 的 hash → 回落 HomePage，
// 篮详情「从网络采集」的目标篮联动整条链断（CDP 目检实测定位：hash=#/capture?toBasket=p1 但页面是首页）。
// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
// 0022 flake 顺修：App 改静态导入——转换/求值成本落在收集期，不再吃单测 5s 预算
// （vi.mock 由 vitest 提升到 import 之前，mock 注册顺序不变）
import { App } from '../../src/app/main.js';

// 路由目标页全部替换为轻量标记，只验证「hash → 哪个页面组件」的匹配逻辑
vi.mock('../../src/app/pages/CapturePage.js', () => ({ CapturePage: () => <div data-page="capture" /> }));
vi.mock('../../src/app/pages/HomePage.js', () => ({ HomePage: () => <div data-page="home" /> }));
// 0028：试题录入路由转正——路由目标 mock 由占位页改指 ProofIntakePage
vi.mock('../../src/app/pages/ProofIntakePage.js', () => ({
  ProofIntakePage: ({ runId }: { runId?: string }) => (
    <div data-page="proof-intake" data-run-id={runId ?? ''} />
  ),
}));
// 0036：PDF 切题工作区路由目标（mock 掉，路由单测不初始化 pdfjs）
vi.mock('../../src/app/pages/SplitWorkspacePage.js', () => ({ SplitWorkspacePage: () => <div data-page="split-workspace" /> }));
// 0040：录题工作台两页（入口页 + 工作台；路由单测不初始化编辑器/裁图/run 读盘）
vi.mock('../../src/app/pages/IntakePage.js', () => ({ IntakePage: () => <div data-page="intake" /> }));
vi.mock('../../src/app/pages/WorkbenchPage.js', () => ({
  WorkbenchPage: ({ runId }: { runId: string }) => <div data-page="workbench" data-run-id={runId} />,
}));
vi.mock('../../src/app/pages/StudentsPage.js', () => ({ StudentsPage: () => <div data-page="students" /> }));
vi.mock('../../src/app/pages/ClassesPage.js', () => ({ ClassesPage: () => <div data-page="classes" />, ClassDetailPage: () => <div data-page="class-detail" /> }));
vi.mock('../../src/app/pages/ExamsPage.js', () => ({ ExamsPage: () => <div data-page="exams" />, ExamDetailPage: () => <div data-page="exam-detail" /> }));
vi.mock('../../src/app/pages/MistakesPage.js', () => ({ MistakesPage: () => <div data-page="mistakes" /> }));
vi.mock('../../src/app/pages/BasketListPage.js', () => ({ BasketListPage: () => <div data-page="basket-list" /> }));
// 0044：试卷管理页（#/papers；路由单测不初始化列表数据）
vi.mock('../../src/app/pages/PapersPage.js', () => ({ PapersPage: () => <div data-page="papers" /> }));
vi.mock('../../src/app/pages/BasketDetailPage.js', () => ({ BasketDetailPage: () => <div data-page="basket-detail" /> }));
vi.mock('../../src/app/pages/ComposePage.js', () => ({ ComposePage: () => <div data-page="compose" /> }));
vi.mock('../../src/app/pages/BankPage.js', () => ({ BankPage: () => <div data-page="bank" /> }));
vi.mock('../../src/app/pages/SettingsPage.js', () => ({ SettingsPage: () => <div data-page="settings" /> }));

// main.tsx 入口自挂载已加 #root 守卫（jsdom 无 #root → 不自动挂载），故直接渲染导出的 App
let container: HTMLDivElement;
let root: Root | null = null;

function renderAt(hash: string) {
  window.location.hash = hash;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => root!.render(<App />));
}

function pageName(): string | null {
  const el = container.querySelector('[data-page]');
  return el ? el.getAttribute('data-page') : null;
}

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  window.location.hash = '';
});

describe('0004-fix-1 路由回归：采集路由带 query', () => {
  it('#/capture?toBasket=p1 命中 CapturePage（修复前回落 HomePage）', async () => {
    await renderAt('#/capture?toBasket=p1');
    expect(pageName()).toBe('capture');
  });

  it('#/capture 无 query 仍命中 CapturePage（零回归）', async () => {
    await renderAt('#/capture');
    expect(pageName()).toBe('capture');
  });
});

describe('0010-merge 设置页 v0：main.tsx 只增 #/settings 一条路由', () => {
  it('#/settings 命中 SettingsPage（唯一新增路由，其余分发逐字不动）', async () => {
    await renderAt('#/settings');
    expect(pageName()).toBe('settings');
  });

  // 0053：录题页「去配置」深链——带 query 的设置路由必须命中设置页（先例：#/capture?）
  it('#/settings?view=ai 命中 SettingsPage（0053 深链，同一 return 位不增分支）', async () => {
    await renderAt('#/settings?view=ai');
    expect(pageName()).toBe('settings');
  });

  it('main.tsx 源码级锁定：分发分支恰 13 条（原 12 + settings），其余逐字未动的护栏', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(process.cwd(), 'src/app/main.tsx'), 'utf-8');
    expect(src).toMatch(/route === '#\/settings'/);
    // 原 12 条路由锚点零丢失
    for (const anchor of [
      "route === '#/basket'", String.raw`route.match(/^#\/basket\/(.+)$/);`, String.raw`route.match(/^#\/compose\/(.+)$/);`,
      "route === '#/bank'", "route === '#/feedback'",
      // 0040：原 `route === '#/proof' || route.startsWith('#/proof/')` 单锚拆为两条
      // （`#/proof` 无 runId 重定向 #/intake；`#/proof/<runId>` 旧直链保留）
      "route === '#/proof'", "route.startsWith('#/proof/')",
      "route === '#/capture' || route.startsWith('#/capture?')", "route === '#/students'",
      "route === '#/classes'", String.raw`route.match(/^#\/classes\/(.+)$/);`, "route === '#/exams'",
      String.raw`route.match(/^#\/exams\/(.+)$/);`, "route === '#/mistakes'",
      // 0053（只增）：设置页 query 深链条件（同一 return 位，AppShell 计数不变）
      "route.startsWith('#/settings?')",
    ]) {
      expect(src.includes(anchor), anchor).toBe(true);
    }
  });
});

// 0028：试题录入路由转正（R-007 识别管线开放）——分支总数 13 不变，仅渲染目标替换
describe('0028：试题录入路由转正（识别管线开放）', () => {
  it('0040 口径：#/proof（无 runId）重定向到 #/intake（工作台接管入口）', async () => {
    await renderAt('#/proof');
    // RouteRedirect 在 effect 里改 hash，jsdom 的 hashchange 异步派发 → 等一个宏任务
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(window.location.hash).toBe('#/intake');
    expect(pageName()).toBe('intake');
  });

  it('#/proof/<runId> 命中同一页（关页回来续跑入口）', async () => {
    await renderAt('#/proof/run-abc-123');
    expect(pageName()).toBe('proof-intake');
    expect(container.querySelector('[data-page]')?.getAttribute('data-run-id')).toBe('run-abc-123');
  });

  it('#/proof/<runId>?from=split/<项目>：query 不污染 runId（0036 返工：否则状态回读查不到 run）', async () => {
    await renderAt('#/proof/run-abc-123?from=split/11111111-2222-4333-8444-555555555555');
    expect(pageName()).toBe('proof-intake');
    expect(container.querySelector('[data-page]')?.getAttribute('data-run-id')).toBe('run-abc-123');
  });

  it('main.tsx 源码级锁定：#/proof 分支锚点仍在 / 占位页彻底退场 / runId 解出并透传', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(process.cwd(), 'src/app/main.tsx'), 'utf-8');
    expect(src).toContain("route === '#/proof'");
    expect(src).toContain("route.startsWith('#/proof/')");
    expect(src).toContain('<ProofIntakePage');
    expect(src).not.toContain('ProofPlaceholder');
    expect(src).toContain('runId');
    // 路由分支总数护栏：0040 新增 #/intake 与 #/intake/<runId> 两条 → 18 处 AppShell 渲染；
    // 0044：#/basket 渲染位被 RouteRedirect 取代（-1）、#/papers 新增（+1）→ 总数 18 不变
    expect((src.match(/return <AppShell route=\{route\}>/g) ?? []).length).toBe(18);
  });
});

// 0036：PDF 切题工作区路由（录题页 PDF 拖入的落点；#/split/<projectId> 恢复现场）
describe('0036：切题工作区路由', () => {
  it('#/split 命中 SplitWorkspacePage（导入首屏）', async () => {
    await renderAt('#/split');
    expect(pageName()).toBe('split-workspace');
  });

  it('#/split/<projectId> 命中同一页（带入项目恢复现场）', async () => {
    await renderAt('#/split/11111111-2222-4333-8444-555555555555');
    expect(pageName()).toBe('split-workspace');
  });

  it('main.tsx 源码级锁定：分支锚点在 / projectId 解出并透传', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(process.cwd(), 'src/app/main.tsx'), 'utf-8');
    expect(src).toContain("route === '#/split' || route.startsWith('#/split/')");
    expect(src).toContain('<SplitWorkspacePage');
    expect(src).toContain('projectId');
  });
});

// 0040：录题工作台 v2 路由（入口页 + 工作台；`#/proof` 重定向见上）
describe('0040：录题工作台路由', () => {
  it('#/intake 命中 IntakePage（入口页）', async () => {
    await renderAt('#/intake');
    expect(pageName()).toBe('intake');
  });

  it('#/intake/<runId> 命中 WorkbenchPage 并透传 runId（关页回来恢复现场）', async () => {
    await renderAt('#/intake/run-0040-abc');
    expect(pageName()).toBe('workbench');
    expect(container.querySelector('[data-page]')?.getAttribute('data-run-id')).toBe('run-0040-abc');
  });

  it('#/intake/<runId>?from=x：query 不污染 runId', async () => {
    await renderAt('#/intake/run-0040-abc?from=split/p1');
    expect(container.querySelector('[data-page]')?.getAttribute('data-run-id')).toBe('run-0040-abc');
  });

  it('main.tsx 源码级锁定：#/intake 两分支锚点在 / 组件透传', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(process.cwd(), 'src/app/main.tsx'), 'utf-8');
    expect(src).toContain("route === '#/intake'");
    expect(src).toContain("route.startsWith('#/intake/')");
    expect(src).toContain('<IntakePage />');
    expect(src).toContain('<WorkbenchPage runId={runId} />');
    expect(src).toContain('<RouteRedirect to="#/intake" />');
  });
});

// 0044：试卷管理页路由（R-036/D-060⑦——组卷列表升级；旧 #/basket 重定向，旧链接不失效）
describe('0044：试卷管理页路由', () => {
  it('#/papers 命中 PapersPage', async () => {
    await renderAt('#/papers');
    expect(pageName()).toBe('papers');
  });

  it('#/basket（无 id）重定向到 #/papers（旧链接不失效，D-060⑦）', async () => {
    await renderAt('#/basket');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(window.location.hash).toBe('#/papers');
    expect(pageName()).toBe('papers');
  });

  it('#/basket/<id> 篮详情保留（禁区 2：行为不变）', async () => {
    await renderAt('#/basket/p1');
    expect(pageName()).toBe('basket-detail');
  });

  it('main.tsx 源码级锁定：#/papers 分支锚点在 / #/basket 重定向 / PapersPage 挂载', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(process.cwd(), 'src/app/main.tsx'), 'utf-8');
    expect(src).toContain("route === '#/basket'");
    expect(src).toContain('<RouteRedirect to="#/papers" />');
    expect(src).toContain("route === '#/papers'");
    expect(src).toContain('<PapersPage />');
  });
});
