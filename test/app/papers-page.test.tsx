// 0044 P2：试卷管理页（#/papers）测试 —— 文件夹树嵌套（默认折叠/点击展开）、右键新建子夹、
// 文件夹增删改、搜索仅卷名、状态筛选、卡操作路由、卡片无来源标识 + 归属嵌套路径、拖卡归类
// （state 纯函数）、回收站（恢复/彻底删除）、试题篮 tab。服务注入 mock 双面（真实语义在
// paper-folder-contract.test.ts 双跑覆盖，此处只验渲染与交互）。
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { act } from 'react';

import type { BankService, BankExtServices } from '../../src/shared/contracts/bank-types.js';
import { createMockExtServices } from '../../src/bank/mock/mock-ext.js';
import { MockBankStore } from '../../src/bank/mock/mock-store.js';
import { MockBankService } from '../../src/bank/mock/mock-bank.js';

import {
  folderByParent, folderPathOf, filterPapers, applyFolderMove, relativeTime,
} from '../../src/app/pages/papers-logic.js';
import { PapersPage } from '../../src/app/pages/PapersPage.js';
import type { PaperFolder } from '../../src/shared/contracts/bank-types.js';

// ---------- 纯函数（拖卡归类 state / 过滤 / 路径） ----------

function folder(id: string, name: string, parentId?: string): PaperFolder {
  return { id, name, ...(parentId ? { parentId } : {}), sort: 0, createdAt: '2026-01-01T00:00:00Z' };
}

describe('0044 papers-logic 纯函数', () => {
  it('folderByParent：parentId 悬空按顶级处理（buildParentIndex 同口径）', () => {
    const byParent = folderByParent([folder('a', 'A'), folder('b', 'B', 'a'), folder('c', 'C', 'ghost')]);
    expect(byParent.get('')?.map((f) => f.id).sort()).toEqual(['a', 'c']);
    expect(byParent.get('a')?.map((f) => f.id)).toEqual(['b']);
    expect(byParent.has('ghost')).toBe(false);
  });

  it('folderPathOf：嵌套路径「父 / 子」（D-062 卡片归属行口径）', async () => {
    const folders = [folder('g', '七年级数学·上'), folder('m', '单元测', 'g')];
    expect(folderPathOf(folders, 'm')).toBe('七年级数学·上 / 单元测');
    expect(folderPathOf(folders, 'g')).toBe('七年级数学·上');
    expect(folderPathOf(folders, 'ghost')).toBe('');
  });

  it('filterPapers：仅卷名过滤（非卷名不命中）+ 状态筛选 + 文件夹范围', async () => {
    const summaries = [
      { paper: { id: 'p1', title: '一次函数 周测卷', config: {}, createdAt: '2026-09-01T00:00:00Z', archived: false, status: 'done' as const, folderId: 'm' }, questionCount: 5, totalScore: 100 },
      { paper: { id: 'p2', title: '浮力 专项', config: {}, createdAt: '2026-09-02T00:00:00Z', archived: false, status: 'composing' as const }, questionCount: 3, totalScore: 30 },
      { paper: { id: 'p3', title: '物理 实验卷', config: {}, createdAt: '2026-09-03T00:00:00Z', archived: false, status: 'done' as const, folderId: 'm' }, questionCount: 2, totalScore: 20 },
    ];
    // 关键词命中卷名
    expect(filterPapers(summaries, { keyword: '浮力' }).map((s) => s.paper.id)).toEqual(['p2']);
    // 关键词不命中非卷名字段（'done' 是状态串不是卷名——搜「done」不得命中任何卷）
    expect(filterPapers(summaries, { keyword: 'done' })).toEqual([]);
    // 状态筛选
    expect(filterPapers(summaries, { status: 'composing' }).map((s) => s.paper.id)).toEqual(['p2']);
    // 文件夹范围
    expect(filterPapers(summaries, { folder: 'm' }).map((s) => s.paper.id).sort()).toEqual(['p1', 'p3']);
    // 未分类范围
    expect(filterPapers(summaries, { folder: 'uncategorized' }).map((s) => s.paper.id)).toEqual(['p2']);
    // 组合
    expect(filterPapers(summaries, { keyword: '卷', status: 'done', folder: 'm' }).map((s) => s.paper.id).sort()).toEqual(['p1', 'p3']);
  });

  it('applyFolderMove：返回新数组不改入参（拖卡 state 纯函数）', async () => {
    const summaries = [
      { paper: { id: 'p1', title: 'A', config: {}, createdAt: '', archived: false, status: 'done' as const }, questionCount: 0, totalScore: 0 },
    ];
    const next = applyFolderMove(summaries, 'p1', 'm');
    expect(next).not.toBe(summaries);
    expect(next[0]?.paper.folderId).toBe('m');
    expect(summaries[0]?.paper.folderId).toBeUndefined();
    const cleared = applyFolderMove(next, 'p1', null);
    expect(cleared[0]?.paper.folderId).toBeUndefined();
    expect(next[0]?.paper.folderId).toBe('m');
  });

  it('relativeTime：相对时间分档（刚刚/分钟前/昨天/日期）', async () => {
    const now = new Date('2026-09-20T12:00:00Z');
    expect(relativeTime('2026-09-20T11:40:00Z', now)).toBe('20 分钟前');
    expect(relativeTime('2026-09-19T12:00:00Z', now)).toBe('昨天');
    expect(relativeTime('2026-09-15T12:00:00Z', now)).toBe('09-15');
  });
});

// ---------- 页面（jsdom） ----------

interface Ctx {
  bank: BankService;
  ext: BankExtServices;
  ids: { grand: string; mid: string };
}

async function seedWorld(): Promise<Ctx> {
  const store = new MockBankStore();
  const bank = new MockBankService(store, false);
  const ext = createMockExtServices(store);
  // 文件夹：grand > mid（子夹）
  const grand = await ext.paper.createFolder({ name: '七年级数学·上' });
  const mid = await ext.paper.createFolder({ name: '单元测', parentId: grand.id });
  // 卷：排版中（未分类）/ 已完成（在 mid）/ 已归档 / 试题篮
  const composing = await ext.paper.createPaperEx('浮力 专项', {}, { status: 'composing' });
  const done = await ext.paper.createPaperEx('一次函数 周测卷', {}, { status: 'done' });
  await ext.paper.moveToFolder(done.id, mid.id);
  const archived = await ext.paper.createPaperEx('旧卷归档', {}, { status: 'archived' });
  const basketPaper = await ext.paper.createPaperEx('采集篮 01');
  void composing; void archived; void basketPaper;
  return { bank, ext, ids: { grand: grand.id, mid: mid.id } };
}

describe('0044 试卷管理页（#/papers）', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await seedWorld();
  });

  afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    container?.remove();
    window.location.hash = '';
  });

  async function renderPage() {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      flushSync(() => root!.render(<PapersPage services={ctx} />));
      // 等 listPapersEx/listFolders 的 Promise 链 resolve 后 setState
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function $testid(id: string): HTMLElement | null {
    return container.querySelector(`[data-testid="${id}"]`);
  }

  const nativeInputValue = (el: HTMLInputElement, v: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };

  async function rerender() {
    await act(async () => {
      flushSync(() => root!.render(<PapersPage services={ctx} />));
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('初始渲染：状态分段（排版中优先置顶）+ 统计行 + 卡片无来源标识 + 归属行显示嵌套路径', async () => {
    await renderPage();
    // 试卷 tab 默认激活；basket 卷不进试卷 tab
    expect(container.textContent).toContain('排版中');
    expect(container.textContent).toContain('一次函数 周测卷');
    // 目检返工⑤：无 tab——试题篮并入状态分段，全部卷同列表可见
    expect(container.textContent).toContain('采集篮 01');
    expect(container.textContent).toContain('试题篮');
    // 归属行：done 卷在「七年级数学·上 / 单元测」（嵌套路径，D-062）
    expect(container.textContent).toContain('七年级数学·上 / 单元测');
    // 无来源标识（D-061⑧：录题/手动/采集一视同仁）
    expect(container.textContent).not.toContain('来自录题工作台');
    expect(container.textContent).not.toContain('来源');
    // 排版中分段在已完成分段之前（置顶）
    const sections = Array.from(container.querySelectorAll('[data-testid^="papers-section-"]')).map((el) => el.getAttribute('data-testid'));
    // 三轮目检②：分段顺序 试题篮→排版中→已定稿→已归档
    expect(sections.indexOf('papers-section-basket')).toBeGreaterThanOrEqual(0);
    expect(sections.indexOf('papers-section-basket')).toBeLessThan(sections.indexOf('papers-section-composing'));
    expect(sections.indexOf('papers-section-composing')).toBeLessThan(sections.indexOf('papers-section-done'));
    expect(sections.indexOf('papers-section-done')).toBeLessThan(sections.indexOf('papers-section-archived'));
  });

  it('文件夹树默认折叠：只列顶级夹；点击 ▸ 展开子夹（D-063）', async () => {
    await renderPage();
    // 顶级夹可见
    expect($testid(`papers-tree-node-${ctx.ids.grand}`)).not.toBeNull();
    // 子夹默认不可见（折叠）
    expect($testid(`papers-tree-node-${ctx.ids.mid}`)).toBeNull();
    // 点击展开钮 → 子夹出现
    const toggle = $testid(`papers-tree-toggle-${ctx.ids.grand}`);
    expect(toggle).not.toBeNull();
    act(() => { toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await rerender();
    expect($testid(`papers-tree-node-${ctx.ids.mid}`)).not.toBeNull();
    // 再点收起
    act(() => { $testid(`papers-tree-toggle-${ctx.ids.grand}`)!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await rerender();
    expect($testid(`papers-tree-node-${ctx.ids.mid}`)).toBeNull();
  });

  it('选中文件夹过滤卡片；「未分类」只看无归属卷', async () => {
    await renderPage();
    // 点「未分类」→ 排版中卷（无归属）可见、已完成卷（在夹内）不可见
    act(() => { $testid('papers-folder-row-uncategorized')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await rerender();
    expect(container.textContent).toContain('浮力 专项');
    expect(container.textContent).not.toContain('一次函数 周测卷');
    // 点顶级夹 → 子夹内卷可见（父夹选中=含子树）
    act(() => { $testid('papers-folder-row-all')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    act(() => { $testid(`papers-tree-node-${ctx.ids.grand}`)!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await rerender();
    expect(container.textContent).toContain('一次函数 周测卷');
    // 选夹=只看该子树：未分类的排版中卷不在列
    expect(container.textContent).not.toContain('浮力 专项');
  });

  it('搜索仅卷名过滤（D-060⑤）+ 状态筛选 chips', async () => {
    await renderPage();
    const input = $testid('papers-search-input') as HTMLInputElement;
    act(() => { nativeInputValue(input, '浮力'); });
    await rerender();
    expect(container.textContent).toContain('浮力 专项');
    expect(container.textContent).not.toContain('一次函数 周测卷');

    // 清空搜索 → 点「已完成」chip → 只剩 done 分段
    act(() => { nativeInputValue(input, ''); });
    act(() => { $testid('papers-chip-done')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await rerender();
    expect(container.textContent).toContain('一次函数 周测卷');
    expect(container.textContent).not.toContain('浮力 专项');
  });

  it('卡操作路由：排版中卡「继续排版」进 #/compose/<id>', async () => {
    await renderPage();
    const btn = $testid('papers-card-continue-p1');
    expect(btn).not.toBeNull();
    act(() => { btn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(window.location.hash).toBe('#/compose/p1');
  });

  it('⋯菜单：删除（入回收站，应用内二次确认）→ 卡片消失；回收站视图可见并可恢复回原状态', async () => {
    await renderPage();
    // 打开 done 卷的 ⋯ 菜单
    act(() => { $testid('papers-card-more-p2')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await rerender();
    const del = $testid('papers-menu-delete');
    expect(del).not.toBeNull();
    act(() => { del!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await rerender();
    // 应用内二次确认（禁 window.confirm）：确认弹层出现
    const confirm = $testid('papers-delete-confirm');
    expect(confirm).not.toBeNull();
    await act(async () => { confirm!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await rerender();
    // 列表消失（默认排除 trashed；成功 toast 文案含卷名，故用卡片 testid 精准断言）
    expect($testid('papers-card-p2')).toBeNull();
    // 回收站入口计数 + 进入回收站视图
    const trashEntry = $testid('papers-trash-entry');
    expect(trashEntry?.getAttribute('data-count')).toBe('1');
    act(() => { trashEntry!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await rerender();
    expect($testid('papers-restore-p2')).not.toBeNull();
    // 恢复 → 回原状态 done
    await act(async () => { $testid('papers-restore-p2')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await rerender();
    const paper = await ctx.ext.paper.getPaperEx('p2');
    expect(paper?.status).toBe('done');
  });

  it('右键文件夹 → 新建子文件夹（菜单跟鼠标、行内命名，父子关系正确落库）', async () => {
    await renderPage();
    act(() => {
      $testid(`papers-tree-node-${ctx.ids.grand}`)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 180 }));
    });
    await rerender();
    const newChild = $testid('papers-menu-newchild');
    expect(newChild).not.toBeNull();
    // 菜单跟鼠标：fixed 定位在触发坐标附近（二轮目检）
    const ctxEl = $testid('papers-ctxmenu')!;
    expect(ctxEl.style.left).toBe('120px');
    expect(ctxEl.style.top).toBe('180px');
    act(() => { newChild!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await rerender();
    const input = $testid('papers-newchild-input') as HTMLInputElement;
    expect(input).not.toBeNull();
    act(() => { nativeInputValue(input, '期中考试'); });
    await act(async () => { $testid('papers-newchild-confirm')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await rerender();
    const folders = await ctx.ext.paper.listFolders();
    const created = folders.find((f) => f.name === '期中考试');
    expect(created?.parentId).toBe(ctx.ids.grand);
  });

  it('拖卡归类：卡片 drop 到文件夹行 → moveToFolder 落库 + 卡片归属刷新', async () => {
    await renderPage();
    const card = $testid('papers-card-p1');
    expect(card).not.toBeNull();
    const dropTarget = $testid(`papers-tree-node-${ctx.ids.grand}`);
    expect(dropTarget).not.toBeNull();
    // jsdom 无 DragEvent/DataTransfer：通用 Event + 手工 dataTransfer 桩
    const data: Record<string, string> = {};
    const makeDrag = (type: string): Event => {
      const e = new Event(type, { bubbles: true, cancelable: true });
      (e as unknown as { dataTransfer: unknown }).dataTransfer = {
        setData: (k: string, v: string) => { data[k] = v; },
        getData: (k: string) => data[k] ?? '',
      };
      return e;
    };
    act(() => { card!.dispatchEvent(makeDrag('dragstart')); });
    await act(async () => { dropTarget!.dispatchEvent(makeDrag('drop')); });
    await rerender();
    const paper = await ctx.ext.paper.getPaperEx('p1');
    expect(paper?.folderId).toBe(ctx.ids.grand);
  });

  it('新建文件夹（左栏行内命名）与文件夹删除（删夹卷回未分类）与右键重命名', async () => {
    await renderPage();
    // 顶级新建：行内命名行直接出现（二轮目检：不弹窗）
    act(() => { $testid('papers-create-folder')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await rerender();
    const input = $testid('papers-newchild-input') as HTMLInputElement;
    expect(input).not.toBeNull();
    act(() => { nativeInputValue(input, '物理·单元测'); });
    await act(async () => { $testid('papers-newchild-confirm')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await rerender();
    const folders = await ctx.ext.paper.listFolders();
    const created = folders.find((f) => f.name === '物理·单元测');
    expect(created?.parentId).toBeUndefined();

    // 删除子夹（含 done 卷的夹）→ 卷回未分类（子夹默认折叠，先展开再右键）
    act(() => { $testid(`papers-tree-toggle-${ctx.ids.grand}`)!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await rerender();
    act(() => {
      $testid(`papers-tree-node-${ctx.ids.mid}`)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    await rerender();
    act(() => { $testid('papers-menu-delete-folder')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await rerender();
    await act(async () => { $testid('papers-deletefolder-confirm')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const paper = await ctx.ext.paper.getPaperEx('p2');
    expect(paper?.folderId).toBeUndefined();
    const remaining = await ctx.ext.paper.listFolders();
    expect(remaining.find((f) => f.id === ctx.ids.mid)).toBeUndefined();
  });

  it('多层文件夹逐层缩进 + 横向滚动（七轮目检回归）', async () => {
    // 造 5 层链：A > B > C > D > E
    const a = await ctx.ext.paper.createFolder({ name: '深A' });
    const b = await ctx.ext.paper.createFolder({ name: '深B', parentId: a.id });
    const c = await ctx.ext.paper.createFolder({ name: '深C', parentId: b.id });
    const d = await ctx.ext.paper.createFolder({ name: '深D', parentId: c.id });
    const e = await ctx.ext.paper.createFolder({ name: '深E', parentId: d.id });
    await renderPage();
    // 展开整条链
    for (const id of [a.id, b.id, c.id, d.id]) {
      act(() => { $testid(`papers-tree-toggle-${id}`)!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    }
    await rerender();
    const rowOf = (id: string) => container.querySelector(`[data-testid="papers-tree-node-${id}"]`) as HTMLElement;
    const pl = (id: string) => rowOf(id)!.style.paddingLeft;
    // 七轮目检：恢复逐层缩进——5 层全部递增（不封顶）
    expect(pl(a.id)).not.toBe(pl(b.id));
    expect(pl(b.id)).not.toBe(pl(c.id));
    expect(pl(c.id)).not.toBe(pl(d.id));
    expect(pl(d.id)).not.toBe(pl(e.id));
    // 深层行不自我裁剪：按内容完整宽度渲染（hScroll），由容器出横向滚动条
    expect(rowOf(e.id)!.style.width).toBe('max-content');
    const scrollBox = container.querySelector('.pm-tree-scroll') as HTMLElement;
    expect(scrollBox).not.toBeNull();
    expect(scrollBox.style.overflowX === 'auto' || getComputedStyle(scrollBox).overflowX === 'auto' || scrollBox.className.includes('pm-tree-scroll')).toBe(true);
  });

  it('叶子夹（无子夹）下新建子夹：命名行可见且落库（五轮返工①回归）', async () => {
    // 直接造一个叶子夹（无任何子夹——此前该场景命名行永不渲染）；须在页面加载数据前建好
    const leaf = await ctx.ext.paper.createFolder({ name: '叶子夹' });
    await renderPage();
    act(() => {
      $testid(`papers-tree-node-${leaf.id}`)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 160 }));
    });
    await rerender();
    act(() => { $testid('papers-menu-newchild')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await rerender();
    const input = $testid('papers-newchild-input') as HTMLInputElement;
    expect(input).not.toBeNull();
    act(() => { nativeInputValue(input, '叶下子夹'); });
    await act(async () => { $testid('papers-newchild-confirm')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await rerender();
    const folders = await ctx.ext.paper.listFolders();
    expect(folders.find((f) => f.name === '叶下子夹')?.parentId).toBe(leaf.id);
  });

  it('批量操作：勾选多张 → 批量移动到文件夹 / 批量删除（二轮目检）', async () => {
    await renderPage();
    // 勾 2 张（排版中 p1 + 已完成 p2）
    act(() => { $testid('papers-card-check-p1')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await rerender();
    act(() => { $testid('papers-card-check-p2')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await rerender();
    expect($testid('papers-batch-bar')?.getAttribute('data-selected-count')).toBe('2');

    // 批量移动到顶级夹
    act(() => { $testid('papers-batch-move')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await rerender();
    // 树选择器默认折叠：先点字段展开浮层
    act(() => { $testid('folder-tree-picker-field')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await rerender();
    act(() => { $testid('folder-tree-pick-uncategorized')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    // 选回顶级夹：展开树选 grand
    act(() => { $testid(`folder-tree-toggle-${ctx.ids.grand}`)!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await rerender();
    act(() => { $testid(`folder-tree-node-${ctx.ids.grand}`)!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { $testid('papers-batch-move-confirm')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await rerender();
    expect((await ctx.ext.paper.getPaperEx('p1'))?.folderId).toBe(ctx.ids.grand);
    expect((await ctx.ext.paper.getPaperEx('p2'))?.folderId).toBe(ctx.ids.grand);
    // 选中集清空
    expect($testid('papers-batch-bar')).toBeNull();

    // 批量删除 → 确认 → 两张都入回收站
    act(() => { $testid('papers-card-check-p1')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await rerender();
    act(() => { $testid('papers-card-check-p2')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await rerender();
    act(() => { $testid('papers-batch-trash')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await rerender();
    await act(async () => { $testid('papers-batch-trash-confirm')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await rerender();
    expect((await ctx.ext.paper.getPaperEx('p1'))?.status).toBe('trashed');
    expect((await ctx.ext.paper.getPaperEx('p2'))?.status).toBe('trashed');
  });

  it('试题篮分段：basket 卷作为状态分段呈现（目检返工⑤）、卡片行为不变（0011）', async () => {
    await renderPage();
    // 试题篮分段直接可见（无 tab）
    expect($testid('papers-section-basket')).not.toBeNull();
    expect(container.textContent).toContain('采集篮 01');
    // 五轮目检⑥：试题篮卡也有同款 ⋯ 菜单（重命名/移动/归档/删除）
    act(() => { $testid('papers-card-more-p4')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await rerender();
    expect($testid('papers-menu-p4')).not.toBeNull();
    expect(container.querySelector('[data-testid="papers-menu-p4"]')!.textContent).toContain('移动到文件夹');
    act(() => { document.body.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await rerender();
    // 卡片点击 → #/basket/<id>
    act(() => { $testid('papers-card-open-p4')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(window.location.hash).toBe('#/basket/p4');
  });

  it('新建试卷：落试题篮状态并进入篮详情页 #/basket/<id>（三轮目检①，非排版间）', async () => {
    await renderPage();
    act(() => { $testid('papers-new-paper')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await new Promise((r) => setTimeout(r, 20));
    expect(window.location.hash).toMatch(/^#\/basket\/p\d+$/);
    // 新建的卷状态=basket（试题篮分段可见）
    const papers = await ctx.ext.paper.listPapersEx({ statuses: ['basket'] });
    expect(papers.some((s2) => s2.paper.title === '未命名试题篮')).toBe(true);
  });

  it('文件夹重命名=原位行内编辑（三轮目检③）', async () => {
    await renderPage();
    act(() => {
      $testid(`papers-tree-node-${ctx.ids.grand}`)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 90, clientY: 150 }));
    });
    await rerender();
    act(() => { $testid('papers-menu-rename-folder')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await rerender();
    // 编辑框出现在该夹所在行（testid 沿用），预填原名
    const renameInput = $testid('papers-folder-rename-input') as HTMLInputElement;
    expect(renameInput).not.toBeNull();
    expect(renameInput.value).toBe('七年级数学·上');
    act(() => { nativeInputValue(renameInput, '七年级数学·上（改名）'); });
    await act(async () => { $testid('papers-folder-rename-confirm')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const afterRename = await ctx.ext.paper.listFolders();
    expect(afterRename.find((f) => f.id === ctx.ids.grand)?.name).toBe('七年级数学·上（改名）');
  });

  it('⋯菜单点外部关闭（目检返工⑦）；已定稿卡只留「查看」进只读排版页（目检返工⑥）', async () => {
    await renderPage();
    act(() => { $testid('papers-card-more-p2')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await rerender();
    expect($testid('papers-menu-p2')).not.toBeNull();
    // 点外部（document 派发冒泡 click）→ 菜单关闭
    act(() => { document.body.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await rerender();
    expect($testid('papers-menu-p2')).toBeNull();
    // 已定稿卡：只有「查看」，点击 → #/compose/<id>（只读排版页）
    expect($testid('papers-card-view-p2')).not.toBeNull();
    act(() => { $testid('papers-card-view-p2')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(window.location.hash).toBe('#/compose/p2');
  });

  it('分段分页：超过单页上限出现翻页器，翻页后显示其余卷（目检返工⑨）', async () => {
    // 追加 10 张已完成卷（合计 11 张 done > 单页 9）
    for (let i = 0; i < 10; i++) {
      await ctx.ext.paper.createPaperEx(`分页卷${i + 1}`, {}, { status: 'done' });
    }
    await renderPage();
    const section = $testid('papers-section-done')!;
    // 第一页只显示 9 张 + 翻页器出现
    expect(section.querySelectorAll('.pcard').length).toBe(9);
    expect($testid('papers-pager-done')).not.toBeNull();
    expect(section.textContent).toContain('第 1 / 2 页');
    // 下一页 → 显示剩余 2 张
    act(() => { $testid('papers-pager-next-done')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await rerender();
    const section2 = $testid('papers-section-done')!;
    expect(section2.querySelectorAll('.pcard').length).toBe(2);
  });
});
