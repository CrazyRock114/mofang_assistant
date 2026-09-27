// 0004 Phase 2/3 页面组件测试 — jsdom + Mock(in-memory) 注入单跑（照 ext-pages.test.tsx 模式）
// 覆盖：试题篮列表三区 + 0011 多篮正式化（新建不拦截直建多张/状态条计数/多篮列表呈现）+
// 归档/恢复/重新编辑（克隆）；篮详情加题/重命名/进入组卷 + 0011 双主入口；
// 排版间返回/放弃 + basket 态进入组卷 + 0011 工具条单行/done 返回/网络采集入口；
// 题库管理页（筛选/软删双按钮弹层/pick 回调/树字典空态）。
// 真实 SQLite 服务语义由 test/bank/basket-contract.test.ts 双跑覆盖。
// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import type { BankService, BankExtServices } from '../../src/shared/contracts/bank-types.js';
import { MockBankService } from '../../src/bank/mock/mock-bank.js';
import { createMockExtServices } from '../../src/bank/mock/mock-ext.js';
import { MockBankStore } from '../../src/bank/mock/mock-store.js';

import { PaperSections } from '../../src/app/pages/BasketListPage.js';
import { BasketDetailPage } from '../../src/app/pages/BasketDetailPage.js';
import { ComposePage } from '../../src/app/pages/ComposePage.js';
import { BankPage } from '../../src/app/pages/BankPage.js';
import { BankBrowser } from '../../src/app/components/BankBrowser.js';
import type { ExtPageServices } from '../../src/app/pages/ExtUi.js';

// ---------------- 测试世界（Mock in-memory 单跑，注入 svc） ----------------

interface Ctx {
  bank: BankService;
  ext: BankExtServices;
  store: MockBankStore;
}

function createCtx(): Ctx {
  const store = new MockBankStore();
  return {
    bank: new MockBankService(store),
    ext: createMockExtServices(store),
    store,
  };
}

let ctx: Ctx;
let svc: ExtPageServices;

beforeEach(() => {
  ctx = createCtx();
  svc = { bank: ctx.bank, ext: ctx.ext };
});

// ---------------- 渲染/交互辅助（照 ext-pages 模式） ----------------

let container: HTMLDivElement;
let root: Root | null = null;

function render(ui: ReactElement) {
  root?.unmount();
  container?.remove();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => {
    root!.render(ui);
  });
}

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  vi.restoreAllMocks();
  // hash 跨用例残留会让「未跳转」类断言假红——逐用例归零（fix-1 A 快照失败用例实证）
  window.location.hash = '';
});

function clickBtn(selector: string) {
  const el = container.querySelector(selector);
  if (!el) throw new Error(`找不到元素: ${selector}`);
  flushSync(() => (el as HTMLButtonElement).click());
}

function setInput(selector: string, value: string) {
  const el = container.querySelector(selector);
  if (!el) throw new Error(`找不到输入框: ${selector}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  (el as HTMLInputElement).dispatchEvent(new Event('input', { bubbles: true }));
}

// 照 ext-pages.test.tsx 模式：select 走原生 setter + change 事件
function setSelect(selector: string, value: string) {
  const el = container.querySelector(selector);
  if (!el) throw new Error(`找不到下拉框: ${selector}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  setter.call(el as HTMLSelectElement, value);
  (el as HTMLSelectElement).dispatchEvent(new Event('change', { bubbles: true }));
}

async function waitFor(assertion: () => void) {
  await vi.waitFor(assertion, { timeout: 3000, interval: 20 });
}

/** 造题 + 推状态机辅助 */
async function makeQuestion(stem: string): Promise<string> {
  const q = await ctx.bank.createQuestion({
    subject: '物理',
    sourceType: 'local',
    sourceDetail: { origin: 'test' },
    content: `<div class="question">${stem}</div>`,
    images: [],
  });
  return q.id;
}

async function makePaperAtStatus(title: string, status: 'basket' | 'done' | 'archived', questionIds: string[] = []): Promise<string> {
  const paper = await ctx.ext.paper.createPaperEx(title);
  for (const qid of questionIds) await ctx.bank.addQuestion(paper.id, qid, 5);
  if (status !== 'basket') {
    await ctx.ext.paper.updatePaperStatus(paper.id, 'composing');
    await ctx.ext.paper.updatePaperStatus(paper.id, 'done');
    if (status === 'archived') await ctx.ext.paper.updatePaperStatus(paper.id, 'archived');
  }
  return paper.id;
}

// ==================== 试题篮列表（PaperSections 三区） ====================

describe('0004 试题篮列表 PaperSections', () => {
  it('三区渲染：处理中/已出卷/已归档各归其位，卡片带题数与总分', async () => {
    await makePaperAtStatus('进行中卷', 'basket');
    await makePaperAtStatus('已出卷甲', 'done');
    await makePaperAtStatus('归档卷', 'archived');

    render(<PaperSections svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="paper-card-p1"]')) throw new Error('列表未渲染');
    });

    const inflight = container.querySelector('[data-testid="section-inflight"]')!;
    const done = container.querySelector('[data-testid="section-done"]')!;
    expect(inflight.textContent).toContain('进行中卷');
    expect(done.textContent).toContain('已出卷甲');
    // 归档区默认折叠：done 卡片（p3）可见，归档卡片（p4）toggle 前不渲染
    expect(container.querySelector('[data-testid="paper-card-p2"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="paper-card-p3"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="paper-card-p4"]')).toBeNull();
    // 题数与总分（p1 种子卷 3 题总分 60）
    expect(container.querySelector('[data-testid="paper-card-p1"]')!.textContent).toContain('3 题 · 总分 60');
  });

  it('0011 多篮正式化：已有处理中卷新建不拦截，直接建第二张并跳详情', async () => {
    await makePaperAtStatus('占用中的卷', 'basket');
    const papersBefore = ctx.store.papers.size;

    render(<PaperSections svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="create-basket-btn"]')) throw new Error('未渲染');
    });

    clickBtn('[data-testid="create-basket-btn"]');
    await waitFor(() => {
      if (ctx.store.papers.size !== papersBefore + 1) throw new Error('新卷未创建');
    });
    // 无拦截弹层（B8 全链删除）
    expect(container.querySelector('[data-testid="intercept-text"]')).toBeNull();
    const created = [...ctx.store.papers.values()].find((p) => p.title === '未命名试题篮');
    expect(created?.status).toBe('basket');
    expect(window.location.hash).toBe(`#/basket/${created!.id}`);
    // 旧处理中卷不受影响（仍是 basket）
    const old = [...ctx.store.papers.values()].find((p) => p.title === '占用中的卷');
    expect(old?.status).toBe('basket');
  });

  it('0011 多篮正式化：连建两张试题篮并存，处理中区列表呈现全部', async () => {
    const before = ctx.store.papers.size;
    render(<PaperSections svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="create-basket-btn"]')) throw new Error('未渲染');
    });
    clickBtn('[data-testid="create-basket-btn"]');
    await waitFor(() => {
      if (ctx.store.papers.size !== before + 1) throw new Error('第一张未创建');
    });
    clickBtn('[data-testid="create-basket-btn"]');
    await waitFor(() => {
      if (ctx.store.papers.size !== before + 2) throw new Error('第二张未创建');
    });
    const created = [...ctx.store.papers.values()].filter((p) => p.title === '未命名试题篮');
    expect(created.length).toBe(2);
    expect(created.every((p) => p.status === 'basket')).toBe(true);

    // 重挂列表：处理中区呈现全部处理中卷（种子 p1 + 两张新篮全为 basket）
    render(<PaperSections svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="inflight-status-text"]')) throw new Error('状态条未渲染');
    });
    const inflightCards = container.querySelectorAll('[data-testid="section-inflight"] [data-testid^="paper-card-"]');
    const expectedInFlight = [...ctx.store.papers.values()].filter((p) => p.status === 'basket' || p.status === 'composing').length;
    expect(inflightCards.length).toBe(expectedInFlight);
    expect(container.querySelector('[data-testid="inflight-status-text"]')!.textContent)
      .toBe(`${expectedInFlight} 张处理中`);
  });

  it('无处理中卷时新建：直接建新 basket 卷', async () => {
    // 种子卷 p1 本身是 basket（in-flight）——先推到 done 腾出「处理中唯一」名额
    await ctx.ext.paper.updatePaperStatus('p1', 'composing');
    await ctx.ext.paper.updatePaperStatus('p1', 'done');

    render(<PaperSections svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="create-basket-btn"]')) throw new Error('未渲染');
    });
    clickBtn('[data-testid="create-basket-btn"]');
    await waitFor(() => {
      if (![...ctx.store.papers.values()].some((p) => p.title === '未命名试题篮')) {
        throw new Error('新卷未创建');
      }
    });
    const created = [...ctx.store.papers.values()].find((p) => p.title === '未命名试题篮')!;
    expect(created.status).toBe('basket');
  });

  it('done 卷归档 + archived 卷恢复（合法迁移直达，失败走 MessageBanner）', async () => {
    const doneId = await makePaperAtStatus('待归档卷', 'done');
    await makePaperAtStatus('待恢复卷', 'archived');

    render(<PaperSections svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector(`[data-testid="card-archive-${doneId}"]`)) throw new Error('done 卡片未渲染');
    });

    // fix-1 C：归档走确认弹层（文案=归档后不再活跃使用，可随时恢复为已定稿）
    clickBtn(`[data-testid="card-archive-${doneId}"]`);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="archive-confirm-text"]')) throw new Error('归档确认弹层未出现');
    });
    expect(container.querySelector('[data-testid="archive-confirm-text"]')!.textContent)
      .toContain('归档后不再活跃使用，可随时恢复为已定稿');
    expect(ctx.store.papers.get(doneId)?.status).toBe('done'); // 确认前未迁移
    clickBtn('[data-testid="archive-confirm-btn"]');
    await waitFor(() => {
      if (ctx.store.papers.get(doneId)?.status !== 'archived') throw new Error('归档未生效');
    });

    // 展开归档区 → 恢复为已定稿
    clickBtn('[data-testid="archived-toggle"]');
    await waitFor(() => {
      const restoreBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '恢复为已定稿');
      if (!restoreBtn) throw new Error('恢复按钮未渲染');
    });
    const restoreBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '恢复为已定稿')!;
    const archivedCard = restoreBtn.closest('[data-testid^="paper-card-"]') as HTMLElement;
    const restoredId = archivedCard.getAttribute('data-testid')!.replace('paper-card-', '');
    flushSync(() => restoreBtn.click());
    await waitFor(() => {
      if (ctx.store.papers.get(restoredId)?.status !== 'done') throw new Error('恢复未生效');
    });
  });

  it('重新编辑：done 卷克隆出新 basket 卷并跳转，原卷不动', async () => {
    const qid = await makeQuestion('克隆前快照题');
    const doneId = await makePaperAtStatus('原卷', 'done', [qid]);
    await ctx.ext.paper.snapshotPaperQuestions(doneId);

    render(<PaperSections svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector(`[data-testid="card-clone-${doneId}"]`)) throw new Error('done 卡片未渲染');
    });
    clickBtn(`[data-testid="card-clone-${doneId}"]`);

    await waitFor(() => {
      const cloned = [...ctx.store.papers.values()].find((p) => p.title === '原卷复制');
      if (!cloned) throw new Error('克隆卷未创建');
    });
    const cloned = [...ctx.store.papers.values()].find((p) => p.title === '原卷复制')!;
    expect(cloned.status).toBe('basket');
    expect((ctx.store.paperQuestions.get(cloned.id) ?? []).length).toBe(1);
    // 原卷不动
    expect(ctx.store.papers.get(doneId)?.status).toBe('done');
    // 跳转在克隆完成后同批异步落地——waitFor 消除微任务竞态
    await waitFor(() => {
      if (window.location.hash !== `#/basket/${cloned.id}`) throw new Error('未跳转新篮详情');
    });
  });
  it('0011-fix done/archived 卡「打开」：进排版间只读视图（#/compose/:id）', async () => {
    const paperId = await makePaperAtStatus('已定稿卷', 'done');
    render(<PaperSections svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector(`[data-testid="card-open-${paperId}"]`)) throw new Error('打开入口未渲染');
    });
    expect(container.querySelector(`[data-testid="card-open-${paperId}"]`)!.textContent).toBe('打开');
    clickBtn(`[data-testid="card-open-${paperId}"]`);
    expect(window.location.hash).toBe(`#/compose/${paperId}`);

    // archived 卡同样有「打开」（折叠区展开）
    const archivedId = await makePaperAtStatus('已归档卷', 'archived');
    render(<PaperSections svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="archived-toggle"]')) throw new Error('未渲染');
    });
    clickBtn('[data-testid="archived-toggle"]');
    await waitFor(() => {
      if (!container.querySelector(`[data-testid="card-open-${archivedId}"]`)) throw new Error('archived 打开入口未渲染');
    });
    clickBtn(`[data-testid="card-open-${archivedId}"]`);
    expect(window.location.hash).toBe(`#/compose/${archivedId}`);
  });
});

// ==================== 篮详情页 ====================

describe('0004 篮详情页 BasketDetailPage', () => {
  it('题列表渲染 + 加题（BankBrowser pick）+ 移除', async () => {
    const q1 = await makeQuestion('篮内题甲');
    const q2 = await makeQuestion('篮外题乙');
    const paperId = await makePaperAtStatus('编辑中的篮', 'basket', [q1]);

    render(<BasketDetailPage paperId={paperId} svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector(`[data-testid="remove-btn-${q1}"]`)) throw new Error('篮详情未渲染');
    });
    expect(container.querySelector('[data-testid="basket-title"]')!.textContent).toBe('编辑中的篮');

    // 加题：弹层 → BankBrowser 选入
    clickBtn('[data-testid="basket-pick-btn"]');
    await waitFor(() => {
      if (!container.querySelector(`[data-testid="bank-pick-${q2}"]`)) throw new Error('选题弹层未渲染');
    });
    clickBtn(`[data-testid="bank-pick-${q2}"]`);
    await waitFor(() => {
      if (!container.querySelector(`[data-testid="remove-btn-${q2}"]`)) throw new Error('加题未生效');
    });

    // 移除
    clickBtn(`[data-testid="remove-btn-${q2}"]`);
    await waitFor(() => {
      if (container.querySelector(`[data-testid="remove-btn-${q2}"]`)) throw new Error('移除未生效');
    });
  });

  it('重命名（updatePaperTitle）+ 空标题报错', async () => {
    const paperId = await makePaperAtStatus('旧篮名', 'basket');

    render(<BasketDetailPage paperId={paperId} svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="basket-rename-btn"]')) throw new Error('未渲染');
    });

    clickBtn('[data-testid="basket-rename-btn"]');
    setInput('[data-testid="basket-rename-input"]', '新篮名');
    clickBtn('[data-testid="basket-rename-confirm"]');
    await waitFor(() => {
      if (ctx.store.papers.get(paperId)?.title !== '新篮名') throw new Error('重命名未生效');
    });

    // 空标题：报错不静默
    clickBtn('[data-testid="basket-rename-btn"]');
    setInput('[data-testid="basket-rename-input"]', '   ');
    clickBtn('[data-testid="basket-rename-confirm"]');
    await waitFor(() => {
      const banner = container.querySelector('[data-testid="page-message"]');
      if (!banner || !banner.textContent!.includes('标题不能为空')) throw new Error('空标题未报错');
    });
  });

  it('进入组卷：basket→composing 并跳排版间', async () => {
    const qid = await makeQuestion('组卷前置题');
    const paperId = await makePaperAtStatus('要组卷的篮', 'basket', [qid]);

    render(<BasketDetailPage paperId={paperId} svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="basket-compose-btn"]')) throw new Error('未渲染');
    });
    clickBtn('[data-testid="basket-compose-btn"]');

    await waitFor(() => {
      if (ctx.store.papers.get(paperId)?.status !== 'composing') throw new Error('状态未迁移');
    });
    expect(window.location.hash).toBe(`#/compose/${paperId}`);
  });

  it('空篮空态提示', async () => {
    const paperId = await makePaperAtStatus('空篮', 'basket');
    render(<BasketDetailPage paperId={paperId} svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="basket-empty"]')) throw new Error('空态未渲染');
    });
    expect(container.querySelector('[data-testid="basket-empty"]')!.textContent).toContain('暂无题目');
  });
});

// ==================== 排版间 ====================

describe('0004 排版间 ComposePage', () => {
  it('composing 卷：返回试题篮（composing→basket）+ 归档（→archived，双按钮确认）', async () => {
    const qid = await makeQuestion('排版间题');
    const paperId = await makePaperAtStatus('排版中卷', 'basket', [qid]);
    await ctx.ext.paper.updatePaperStatus(paperId, 'composing');

    render(<ComposePage paperId={paperId} svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="compose-back-basket-btn"]')) throw new Error('排版间未渲染');
    });
    expect(container.querySelector('[data-testid="paper-status-badge"]')!.getAttribute('data-status')).toBe('composing');
    expect(container.querySelector('[data-testid="paper-status-badge"]')!.textContent).toBe('排版中');

    // 返回试题篮
    clickBtn('[data-testid="compose-back-basket-btn"]');
    await waitFor(() => {
      if (ctx.store.papers.get(paperId)?.status !== 'basket') throw new Error('返回未生效');
      if (window.location.hash !== `#/basket/${paperId}`) throw new Error('未跳篮详情');
    });

    // 再进 composing → 归档
    await ctx.ext.paper.updatePaperStatus(paperId, 'composing');
    render(<ComposePage paperId={paperId} svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="compose-archive-btn"]')) throw new Error('排版间未渲染');
    });
    clickBtn('[data-testid="compose-archive-btn"]');
    await waitFor(() => {
      if (!container.querySelector('[data-testid="compose-archive-confirm"]')) throw new Error('确认弹层未出现');
    });
    expect(container.querySelector('[data-testid="compose-archive-confirm-text"]')!.textContent)
      .toBe('归档后不再活跃使用，可随时恢复为已定稿');
    clickBtn('[data-testid="compose-archive-confirm"]');
    await waitFor(() => {
      if (ctx.store.papers.get(paperId)?.status !== 'archived') throw new Error('归档未生效');
    });
    expect(window.location.hash).toBe('#/basket');
  });

  it('basket 卷进入排版间：提示进入组卷（正式流不含越态定稿按钮）', async () => {
    const paperId = await makePaperAtStatus('还在篮里的卷', 'basket');
    render(<ComposePage paperId={paperId} svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="compose-start-btn"]')) throw new Error('未渲染');
    });
    // composing 态才有返回/放弃；basket 态无定稿入口（定稿 Phase 5 随版式控件接入）
    expect(container.querySelector('[data-testid="compose-back-basket-btn"]')).toBeNull();
    // 0011-fix 语义命名：排版间入口按钮 = 进入排版
    expect(container.querySelector('[data-testid="compose-start-btn"]')!.textContent).toBe('进入排版');

    clickBtn('[data-testid="compose-start-btn"]');
    await waitFor(() => {
      if (ctx.store.papers.get(paperId)?.status !== 'composing') throw new Error('进入组卷未生效');
    });
  });

  it('fix-1 A：composing 定稿 = 快照 → done → 跳 #/basket（快照先行）', async () => {
    const qid = await makeQuestion('定稿题');
    const paperId = await makePaperAtStatus('待定稿卷', 'basket', [qid]);
    await ctx.ext.paper.updatePaperStatus(paperId, 'composing');

    // 顺序探针：记录 snapshot 与 status 调用的先后
    const calls: string[] = [];
    const snapSpy = vi.spyOn(ctx.ext.paper, 'snapshotPaperQuestions').mockImplementation(async (id: string) => {
      calls.push('snapshot');
      return 1;
    });
    const statusSpy = vi.spyOn(ctx.ext.paper, 'updatePaperStatus').mockImplementation(async (id: string, next: PaperStatus) => {
      calls.push(`status:${next}`);
      ctx.store.papers.get(id)!.status = next;
      return ctx.store.papers.get(id)!;
    });

    render(<ComposePage paperId={paperId} svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="compose-finalize-btn"]')) throw new Error('定稿按钮未渲染');
    });
    clickBtn('[data-testid="compose-finalize-btn"]');

    await waitFor(() => {
      if (ctx.store.papers.get(paperId)?.status !== 'done') throw new Error('定稿未生效');
      if (window.location.hash !== '#/basket') throw new Error('定稿后未跳列表');
    });
    expect(calls).toEqual(['snapshot', 'status:done']);
    expect(snapSpy).toHaveBeenCalledWith(paperId);
    expect(statusSpy).toHaveBeenCalledWith(paperId, 'done');
  });

  it('fix-1 A：快照失败 → 中止定稿并报错，状态仍 composing（绝不置 done）', async () => {
    const qid = await makeQuestion('快照失败题');
    const paperId = await makePaperAtStatus('快照失败卷', 'basket', [qid]);
    await ctx.ext.paper.updatePaperStatus(paperId, 'composing');

    vi.spyOn(ctx.ext.paper, 'snapshotPaperQuestions').mockRejectedValue(new Error('题不存在：q-x'));
    const statusSpy = vi.spyOn(ctx.ext.paper, 'updatePaperStatus');

    render(<ComposePage paperId={paperId} svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="compose-finalize-btn"]')) throw new Error('定稿按钮未渲染');
    });
    clickBtn('[data-testid="compose-finalize-btn"]');

    await waitFor(() => {
      const banner = container.querySelector('[data-testid="page-message"]');
      if (!banner || !banner.textContent!.includes('定稿中止')) throw new Error('未报错中止');
    });
    // 状态未迁移 + 未调用 done 迁移 + 未跳转
    expect(ctx.store.papers.get(paperId)?.status).toBe('composing');
    expect(statusSpy.mock.calls.filter((c) => c[1] === 'done').length).toBe(0);
    expect(window.location.hash).not.toBe('#/basket');
  });

  it('fix-1 C：basket 态无定稿/归档入口（正式流不含越态按钮）', async () => {
    const paperId = await makePaperAtStatus('草稿卷', 'basket');
    render(<ComposePage paperId={paperId} svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="compose-start-btn"]')) throw new Error('未渲染');
    });
    expect(container.querySelector('[data-testid="compose-finalize-btn"]')).toBeNull();
    expect(container.querySelector('[data-testid="compose-archive-btn"]')).toBeNull();
    expect(container.querySelector('[data-testid="paper-status-badge"]')!.textContent).toBe('草稿');
  });

  it('0011 工具条单行：容器去换行、标题 min-width:0+overflow 裁切、按钮组整组不换位', async () => {
    const longTitle = '超长卷名防挤压验证——'.repeat(6) + '末尾锚点';
    const paperId = await makePaperAtStatus(longTitle, 'basket');
    render(<ComposePage paperId={paperId} svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="compose-toolbar"]')) throw new Error('工具条未渲染');
    });
    const bar = container.querySelector('[data-testid="compose-toolbar"]') as HTMLElement;
    // 整行去 flex-wrap:wrap（长标题不再把按钮挤换行）
    expect(bar.style.flexWrap).not.toBe('wrap');
    // h1 容器：弹性收缩 + 溢出裁切（DOM 断言，不测像素）
    const h1 = container.querySelector('[data-testid="compose-toolbar-title"]') as HTMLElement;
    expect(h1.style.minWidth).toBe('0px');
    expect(h1.style.overflow).toBe('hidden');
    expect(h1.style.whiteSpace).toBe('nowrap');
    // 按钮组：整组恒在标题右侧，不换行不换位
    const actions = container.querySelector('[data-testid="compose-toolbar-actions"]') as HTMLElement;
    expect(actions.style.flex).toBe('0 0 auto');
    expect(actions.style.display).toBe('flex');
    // 标题文本在场（未因裁切丢失内容节点）
    expect(h1.textContent).toContain('末尾锚点');
  });

  it('0011-fix 排版间左上角统一「← 返回试卷列表」（全状态，纯导航不改状态）+ done/archived「生成副本重新编辑」', async () => {
    // composing：左上角返回链接 + 返回试题篮（状态回退）并存
    const qid = await makeQuestion('排版返回题');
    const paperId = await makePaperAtStatus('排版中卷', 'basket', [qid]);
    await ctx.ext.paper.updatePaperStatus(paperId, 'composing');
    render(<ComposePage paperId={paperId} svc={svc} />);
    await waitFor(() => {
      const link = container.querySelector('a.page-back');
      if (!link) throw new Error('左上角返回链接未渲染');
    });
    const backLink = () => container.querySelector('a.page-back') as HTMLAnchorElement;
    expect(backLink().textContent).toBe('← 返回试卷列表');
    expect(backLink().getAttribute('href')).toBe('#/basket');
    // 工具条内不再有第二个返回按钮（统一收口到左上角）
    expect(container.querySelector('[data-testid="compose-back-btn"]')).toBeNull();
    expect(container.querySelector('[data-testid="compose-back-basket-btn"]')).not.toBeNull();
    // 点击左上角链接 → 回列表且不改状态（jsdom 锚点 hash 导航异步落地）
    flushSync(() => backLink().click());
    await vi.waitFor(() => {
      expect(window.location.hash).toBe('#/basket');
    });
    expect(ctx.store.papers.get(paperId)?.status).toBe('composing');

    // basket 态：同样有左上角返回
    const pid2 = await makePaperAtStatus('草稿卷返回', 'basket');
    render(<ComposePage paperId={pid2} svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('a.page-back')) throw new Error('未渲染');
    });
    expect(container.querySelector('a.page-back')!.textContent).toBe('← 返回试卷列表');

    // done 态：左上角返回 + 生成副本重新编辑（克隆出新草稿卷并跳详情）
    const cloneQid = await makeQuestion('副本来源题');
    const doneId = await makePaperAtStatus('已定稿可克隆卷', 'done', [cloneQid]);
    await ctx.ext.paper.snapshotPaperQuestions(doneId);
    render(<ComposePage paperId={doneId} svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="compose-clone-btn"]')) throw new Error('生成副本按钮未渲染');
    });
    expect(container.querySelector('[data-testid="compose-clone-btn"]')!.textContent).toBe('生成副本重新编辑');
    expect(container.querySelector('a.page-back')!.textContent).toBe('← 返回试卷列表');
    clickBtn('[data-testid="compose-clone-btn"]');
    await waitFor(() => {
      if (![...ctx.store.papers.values()].some((p) => p.title === '已定稿可克隆卷复制')) throw new Error('副本未创建');
    });
    const cloned = [...ctx.store.papers.values()].find((p) => p.title === '已定稿可克隆卷复制')!;
    expect(cloned.status).toBe('basket');
    expect(ctx.store.papers.get(doneId)?.status).toBe('done'); // 原卷不动
    await waitFor(() => {
      if (window.location.hash !== `#/basket/${cloned.id}`) throw new Error('未跳副本详情');
    });

    // composing/basket 态无生成副本（只读克隆仅定稿/归档语义）
    render(<ComposePage paperId={paperId} svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('a.page-back')) throw new Error('未渲染');
    });
    expect(container.querySelector('[data-testid="compose-clone-btn"]')).toBeNull();
  });

  it('0018 目检返工二：加题/新建题/从网络题库加题入口退役（加题归试题篮；排版间仅留插入大标题）', async () => {
    const qid = await makeQuestion('排版采集入口题');
    const paperId = await makePaperAtStatus('排版采集入口卷', 'basket', [qid]);
    await ctx.ext.paper.updatePaperStatus(paperId, 'composing');

    render(<ComposePage paperId={paperId} svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="compose-insert-text-block-btn"]')) throw new Error('题卡区未渲染');
    });
    // 加题三入口退役（0018 目检返工二：返回试题篮 → 加题 → 再进排版）
    expect(container.querySelector('[data-testid="compose-pick-btn"]')).toBeNull();
    expect(container.querySelector('[data-testid="compose-new-question-btn"]')).toBeNull();
    expect(container.querySelector('[data-testid="compose-capture-btn"]')).toBeNull();
    // 插入大标题（试卷结构编辑）保留
    expect(container.querySelector('[data-testid="compose-insert-text-block-btn"]')).not.toBeNull();
  });
});

// ==================== fix-1 C/F2：处理中状态条 + 卷列表批量 ====================

describe('0004-fix-1 C/F2：处理中状态条 + 卷列表批量归档/恢复', () => {
  it('0011 状态条计数：0 张处理中不显示状态条；≥1 张显示「N 张处理中」（无单卷特写）', async () => {
    // 腾空处理中区（种子 p1 = basket → done）
    await ctx.ext.paper.updatePaperStatus('p1', 'composing');
    await ctx.ext.paper.updatePaperStatus('p1', 'done');
    render(<PaperSections svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="section-inflight"]')) throw new Error('列表未渲染');
    });
    // 0 张处理中：状态条整体不显示
    expect(container.querySelector('[data-testid="inflight-status-bar"]')).toBeNull();
    expect(container.querySelector('[data-testid="inflight-status-text"]')).toBeNull();

    // 建 2 张处理中 → 状态条出现计数 2；无单卷「继续」特写按钮；列表区照常呈现全部
    await ctx.ext.paper.createPaperEx('处理中甲');
    await ctx.ext.paper.createPaperEx('处理中乙');
    render(<PaperSections svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="inflight-status-text"]')) throw new Error('状态条未出现');
    });
    expect(container.querySelector('[data-testid="inflight-status-text"]')!.textContent).toBe('2 张处理中');
    expect(container.querySelector('[data-testid="inflight-continue-btn"]')).toBeNull();
    expect(container.querySelectorAll('[data-testid="section-inflight"] [data-testid^="paper-card-"]').length).toBe(2);
    expect(container.querySelector('[data-testid="section-inflight"]')!.textContent).toContain('处理中甲');
    expect(container.querySelector('[data-testid="section-inflight"]')!.textContent).toContain('处理中乙');
  });

  it('批量归档：勾多张 done 卡 → 确认弹层 → 全部 →archived', async () => {
    const a = await makePaperAtStatus('批量归档甲', 'done');
    const b = await makePaperAtStatus('批量归档乙', 'done');

    render(<PaperSections svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector(`[data-testid="card-select-${a}"]`)) throw new Error('勾选框未渲染');
    });
    clickBtn(`[data-testid="card-select-${a}"]`);
    clickBtn(`[data-testid="card-select-${b}"]`);
    expect(container.querySelector('[data-testid="done-batch-bar"]')!.getAttribute('data-selected-count')).toBe('2');

    clickBtn('[data-testid="batch-archive-btn"]');
    await waitFor(() => {
      if (!container.querySelector('[data-testid="archive-confirm-text"]')) throw new Error('批量确认弹层未出现');
    });
    expect(container.querySelector('[data-testid="archive-confirm-text"]')!.textContent).toContain('将批量归档 2 卷');
    clickBtn('[data-testid="archive-confirm-btn"]');

    await waitFor(() => {
      if (ctx.store.papers.get(a)?.status !== 'archived') throw new Error('甲未归档');
      if (ctx.store.papers.get(b)?.status !== 'archived') throw new Error('乙未归档');
    });
  });

  it('批量恢复：展开归档区勾多张 → 批量恢复为已定稿（→done）', async () => {
    const a = await makePaperAtStatus('批量恢复甲', 'archived');
    const b = await makePaperAtStatus('批量恢复乙', 'archived');

    render(<PaperSections svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="archived-toggle"]')) throw new Error('未渲染');
    });
    clickBtn('[data-testid="archived-toggle"]');
    await waitFor(() => {
      if (!container.querySelector(`[data-testid="card-select-${a}"]`)) throw new Error('归档区勾选框未渲染');
    });
    clickBtn(`[data-testid="card-select-${a}"]`);
    clickBtn(`[data-testid="card-select-${b}"]`);
    clickBtn('[data-testid="batch-restore-btn"]');

    await waitFor(() => {
      if (ctx.store.papers.get(a)?.status !== 'done') throw new Error('甲未恢复');
      if (ctx.store.papers.get(b)?.status !== 'done') throw new Error('乙未恢复');
    });
    expect(container.querySelector('[data-testid="page-message"]')!.textContent).toContain('批量恢复为已定稿 2 卷');
  });
});

// ==================== fix-1 F3：篮详情批量移除/设分 ====================

describe('0004-fix-1 F3：篮详情批量移除/批量设分', () => {
  it('fix-1 F3：批量移除：勾题 → 确认「移出试题篮 N 题？」→ 逐题移除', async () => {
    const q1 = await makeQuestion('批量移除甲');
    const q2 = await makeQuestion('批量移除乙');
    const paperId = await makePaperAtStatus('批量移除篮', 'basket', [q1, q2]);

    render(<BasketDetailPage paperId={paperId} svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector(`[data-testid="basket-select-${q1}"]`)) throw new Error('勾选框未渲染');
    });
    clickBtn(`[data-testid="basket-select-${q1}"]`);
    clickBtn(`[data-testid="basket-select-${q2}"]`);
    expect(container.querySelector('[data-testid="basket-selection-bar"]')!.getAttribute('data-selected-count')).toBe('2');

    clickBtn('[data-testid="basket-batch-remove-btn"]');
    await waitFor(() => {
      if (!container.querySelector('[data-testid="basket-batch-remove-text"]')) throw new Error('确认弹层未出现');
    });
    expect(container.querySelector('[data-testid="basket-batch-remove-text"]')!.textContent).toBe('移出试题篮 2 题？');
    clickBtn('[data-testid="basket-batch-remove-confirm"]');

    await waitFor(() => {
      if ((ctx.store.paperQuestions.get(paperId) ?? []).length !== 0) throw new Error('批量移除未生效');
      if (!container.querySelector('[data-testid="basket-empty"]')) throw new Error('空态未渲染');
    });
  });

  it('批量设分：勾题 → 弹层输入分值 → 逐题 setQuestionScore', async () => {
    const q1 = await makeQuestion('批量设分甲');
    const q2 = await makeQuestion('批量设分乙');
    const paperId = await makePaperAtStatus('批量设分篮', 'basket', [q1, q2]);
    const scoreSpy = vi.spyOn(ctx.bank, 'setQuestionScore');

    render(<BasketDetailPage paperId={paperId} svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector(`[data-testid="basket-select-${q1}"]`)) throw new Error('勾选框未渲染');
    });
    clickBtn('[data-testid="basket-select-all"]');
    expect(container.querySelector('[data-testid="basket-selection-bar"]')!.getAttribute('data-selected-count')).toBe('2');

    clickBtn('[data-testid="basket-batch-score-btn"]');
    setInput('[data-testid="basket-batch-score-input"]', '8');
    clickBtn('[data-testid="basket-batch-score-confirm"]');

    await waitFor(() => {
      expect(scoreSpy).toHaveBeenCalledTimes(2);
    });
    const rows = ctx.store.paperQuestions.get(paperId)!;
    expect(rows.every((r) => r.score === 8)).toBe(true);
    expect(container.querySelector('[data-testid="page-message"]')!.textContent).toBe('批量设分（8 分）2 题：成功 2 题，失败 0 题');
  });

  it('0011 篮详情双主入口：「从题库加题」「从网络题库加题」（带 toBasket+from）；新建题为次级', async () => {
    const paperId = await makePaperAtStatus('标题卷', 'basket');
    render(<BasketDetailPage paperId={paperId} svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="basket-capture-btn"]')) throw new Error('未渲染');
    });
    expect(container.textContent).toContain('试题篮 · 标题卷');
    // 双主入口文案对齐用户口径；新建题保留次级
    expect(container.querySelector('[data-testid="basket-pick-btn"]')!.textContent).toBe('从题库加题');
    expect(container.querySelector('[data-testid="basket-new-question-btn"]')!.textContent).toBe('新建题');
    expect(container.querySelector('[data-testid="basket-capture-btn"]')!.textContent).toBe('从网络题库加题');
    // 0011-fix 语义命名：选题→排版步骤按钮不叫「组卷」（组卷=选题+排版全程）
    expect(container.querySelector('[data-testid="basket-compose-btn"]')!.textContent).toBe('进入排版');
    // 0011-fix 返回统一：左上角「← 返回试卷列表」
    expect(container.querySelector('a.page-back')!.textContent).toBe('← 返回试卷列表');

    clickBtn('[data-testid="basket-capture-btn"]');
    expect(window.location.hash).toBe(`#/capture?toBasket=${paperId}&from=basket/${paperId}`);
  });
});

// ==================== 题库浏览器 + 题库管理页 ====================

describe('0004 题库管理 BankBrowser / BankPage', () => {
  it('列表渲染 + keyword 筛选（题干文本）+ 来源徽标', async () => {
    render(<BankPage svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="bank-item-q1"]')) throw new Error('题库列表未渲染');
    });
    // 种子 5 题 + 统计行
    expect(container.querySelectorAll('[data-testid^="bank-item-"]').length).toBe(5);
    expect(container.querySelector('[data-testid="bank-count"]')!.textContent).toContain('题库共 5 题');

    setInput('[data-testid="bank-keyword-input"]', '自由落体');
    await waitFor(() => {
      const items = container.querySelectorAll('[data-testid^="bank-item-"]');
      if (items.length !== 1) throw new Error('keyword 筛选未生效');
    });
    expect(container.querySelector('[data-testid="bank-item-q1"]')).not.toBeNull();
  });

  it('树/字典空态：树面板「待采集」占位 + 字典下拉禁用（不渲染假数据）', async () => {
    render(<BankPage svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="bank-tree-empty"]')) throw new Error('树面板未渲染');
    });
    expect(container.querySelector('[data-testid="bank-tree-empty"]')!.textContent).toContain('知识树待采集');
    const subjectSelect = container.querySelector('[data-testid="bank-filter-subject"]') as HTMLSelectElement;
    expect(subjectSelect.disabled).toBe(true);
    expect(subjectSelect.textContent).toContain('待采集');
  });

  // 0006-fix-1（目检反馈）：树面板接真实采集数据——学段→学科→树级联 + 节点折叠浏览
  // 0006-fix-2（返工）：级联补「类型」级——学段→学科（归一去重）→类型（知识点/章节挑题）→树
  // 0014 改版：学段/学科两下拉上移顶栏（bank-filter-stage / bank-filter-subject 单真源联动），
  //   树面板只保留类型切换 + 树选择 + 节点浏览（原 bank-tree-stage / bank-tree-subject 随元素删除）
  it('树面板：有树时学段上移顶栏（默认首学段），类型→树级联与默认首树节点保留', async () => {
    await ctx.ext.dict.createEntry({ kind: 'subject', code: 'physics', label: '物理' });
    const t1 = await ctx.ext.tree.createTree({ type: 'knowledge', name: '组卷网·知识点·初中物理', subjectId: 'physics', stage: '初中' });
    const t2 = await ctx.ext.tree.createTree({ type: 'knowledge', name: '组卷网·知识点·高中物理', subjectId: 'physics', stage: '高中' });
    const root1 = await ctx.ext.tree.createNode({ treeId: t1.id, name: '力学', sort: 0 });
    await ctx.ext.tree.createNode({ treeId: t1.id, parentId: root1.id, name: '摩擦力', sort: 0 });
    await ctx.ext.tree.createNode({ treeId: t1.id, name: '电学', sort: 1 });
    await ctx.ext.tree.createNode({ treeId: t2.id, name: '电磁学', sort: 0 });

    render(<BankPage svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="bank-tree-panel"]')) throw new Error('树面板未渲染');
    });
    expect(container.querySelector('[data-testid="bank-tree-empty"]')).toBeNull();

    // 0014：学段下拉在顶栏（bank-filter-stage），树面板内不再有学段/学科下拉
    const stageSel = container.querySelector('[data-testid="bank-filter-stage"]') as HTMLSelectElement;
    expect(stageSel).not.toBeNull();
    // 0014 目检返工：学段升级为筛题维度——首项「全部学段」（默认，不过滤含未挂树题），其余=树学段集合
    expect(Array.from(stageSel.options).map((o) => o.value)).toEqual(['', '初中', '高中']);
    expect(Array.from(stageSel.options).map((o) => o.textContent)).toEqual(['全部学段', '初中', '高中']);
    expect(stageSel.value).toBe('');
    expect(container.querySelector('[data-testid="bank-tree-stage"]')).toBeNull();
    expect(container.querySelector('[data-testid="bank-tree-subject"]')).toBeNull();

    // 类型级：知识点挑题；全部学段下同科两学段的树都在列
    const typeSel = container.querySelector('[data-testid="bank-tree-type"]') as HTMLSelectElement;
    expect(Array.from(typeSel.options).map((o) => o.value)).toEqual(['knowledge']);
    expect(typeSel.value).toBe('knowledge');
    const treeSel = container.querySelector('[data-testid="bank-tree-select"]') as HTMLSelectElement;
    // 0054 R-049①：树名显示层剥来源前缀（数据层树名原文不变）
    expect(treeSel.textContent).toContain('初中物理');
    expect(treeSel.textContent).toContain('高中物理');
    expect(treeSel.textContent).not.toContain('组卷网·知识点·');

    // 默认加载首树：第一级渲染（力学/电学），子级折叠不渲染（0054 目检反馈：一级也保持折叠）
    await waitFor(() => {
      if (!container.querySelector(`[data-testid="bank-tree-node-${root1.id}"]`)) throw new Error('根节点未渲染');
    });
    expect(container.querySelector('[data-testid="bank-tree-node-count"]')!.textContent).toContain('3 节点');
    expect(container.textContent).toContain('力学');
    expect(container.textContent).toContain('电学');
    expect(container.textContent).not.toContain('摩擦力');
  });

  it('树面板：节点展开/折叠 + 顶栏切学段联动树列表与节点', async () => {
    const t1 = await ctx.ext.tree.createTree({ type: 'knowledge', name: '组卷网·知识点·初中物理', subjectId: 'physics', stage: '初中' });
    const t2 = await ctx.ext.tree.createTree({ type: 'textbook', name: '菁优网·知识点·高中物理', subjectId: 'physics', stage: '高中' });
    const root1 = await ctx.ext.tree.createNode({ treeId: t1.id, name: '力学', sort: 0 });
    const child1 = await ctx.ext.tree.createNode({ treeId: t1.id, parentId: root1.id, name: '摩擦力', sort: 0 });
    const root2 = await ctx.ext.tree.createNode({ treeId: t2.id, name: '必修第一册', sort: 0 });

    render(<BankPage svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector(`[data-testid="bank-tree-toggle-${root1.id}"]`)) throw new Error('根节点未渲染');
    });

    // 展开 → 子节点出现；再折叠 → 消失（默认折叠，0054 目检反馈口径）
    clickBtn(`[data-testid="bank-tree-toggle-${root1.id}"]`);
    expect(container.querySelector(`[data-testid="bank-tree-node-${child1.id}"]`)!.textContent).toContain('摩擦力');
    clickBtn(`[data-testid="bank-tree-toggle-${root1.id}"]`);
    expect(container.querySelector(`[data-testid="bank-tree-node-${child1.id}"]`)).toBeNull();

    // 顶栏切学段 → 类型级回落到该学段唯一类型（章节挑题），树下拉与节点联动换高中树
    setSelect('[data-testid="bank-filter-stage"]', '高中');
    await waitFor(() => {
      if (!container.querySelector(`[data-testid="bank-tree-node-${root2.id}"]`)) throw new Error('高中树节点未渲染');
    });
    const typeSel = container.querySelector('[data-testid="bank-tree-type"]') as HTMLSelectElement;
    expect(Array.from(typeSel.options).map((o) => o.value)).toEqual(['textbook']);
    expect(Array.from(typeSel.options).map((o) => o.textContent)).toEqual(['章节挑题']);
    expect(typeSel.value).toBe('textbook');
    const treeSel = container.querySelector('[data-testid="bank-tree-select"]') as HTMLSelectElement;
    // 0054 R-049①：剥来源前缀后「高中物理」仍在、旧前缀形态不再出现
    expect(treeSel.textContent).toContain('高中物理');
    expect(treeSel.textContent).not.toContain('组卷网·知识点·');
    expect(container.querySelector(`[data-testid="bank-tree-node-${root1.id}"]`)).toBeNull();
  });

  // 0006-fix-2（用户目检返工）：学科下拉三格式（subj:physics / physics2 / 物理）归一同一项；
  // 知识点树与教材章节树按类型级分开（知识点挑题 / 章节挑题）
  // 0014 改版：学科切换走顶栏 bank-filter-subject（字典条目 id='subj:{code}'），树级联跟随（单真源）
  it('顶栏学科联动树级联：混合格式学科归一去重 + 类型级分开知识点/章节（politics 歧义不并错）', async () => {
    await ctx.ext.dict.createEntry({ kind: 'subject', code: 'physics', label: '物理' });
    await ctx.ext.dict.createEntry({ kind: 'subject', code: 'physics', label: 'physics2', site: 'jyeoo', sourceLabel: 'physics2' });
    await ctx.ext.dict.createEntry({ kind: 'subject', code: 'morality-law', label: '道德与法治' });
    await ctx.ext.dict.createEntry({ kind: 'subject', code: 'politics', label: '政治' });
    await ctx.ext.dict.createEntry({ kind: 'subject', code: 'morality-law', label: 'politics', site: 'jyeoo', sourceLabel: 'politics' });

    const k1 = await ctx.ext.tree.createTree({ type: 'knowledge', name: '组卷网·知识点·初中物理', subjectId: 'subj:physics', stage: '初中', source: 'zujuan' });
    const k2 = await ctx.ext.tree.createTree({ type: 'knowledge', name: '菁优网·知识点·初中物理·人教版（2024）八年级上', subjectId: 'physics2', stage: '初中', source: 'jyeoo' });
    const k3 = await ctx.ext.tree.createTree({ type: 'knowledge', name: '组卷网·知识点·高中物理', subjectId: '物理', stage: '初中', source: 'zujuan' });
    const tb = await ctx.ext.tree.createTree({ type: 'textbook', name: '组卷网·教材·初中物理·人教版（2024）八年级上册', subjectId: '物理', stage: '初中', source: 'zujuan' });
    // 歧义雷区：菁优初中道法 segment=politics → 道德与法治；组卷高中政治『政治』→ 政治，两者不并组
    const d1 = await ctx.ext.tree.createTree({ type: 'knowledge', name: '菁优网·知识点·初中道法·统编版（2024）七年级上', subjectId: 'politics', stage: '初中', source: 'jyeoo' });
    const z1 = await ctx.ext.tree.createTree({ type: 'knowledge', name: '组卷网·知识点·高中政治', subjectId: '政治', stage: '初中', source: 'zujuan' });
    const root1 = await ctx.ext.tree.createNode({ treeId: k1.id, name: '机械运动', sort: 0 });
    const rootTb = await ctx.ext.tree.createNode({ treeId: tb.id, name: '第一章 机械运动', sort: 0 });

    render(<BankPage svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="bank-tree-panel"]')) throw new Error('树面板未渲染');
    });

    // 顶栏学科下拉：三格式（subj:physics / physics2 / 物理）归一后只剩一项「物理」（站点同义行不进）
    const subjSel = container.querySelector('[data-testid="bank-filter-subject"]') as HTMLSelectElement;
    const subjOptions = Array.from(subjSel.options).map((o) => ({ value: o.value, text: o.textContent }));
    // 归一行组内按 code 升序（listEntries 契约：ORDER BY kind, site IS NULL DESC, code）
    expect(subjOptions.map((o) => o.value)).toEqual(['', 'subj:morality-law', 'subj:physics', 'subj:politics']);
    expect(subjOptions.map((o) => o.text)).toEqual(['全部学科', '道德与法治', '物理', '政治']);

    // 类型级：默认知识点挑题（知识点树三棵，教材树不入），切章节挑题 → 只剩教材树
    const typeSel = container.querySelector('[data-testid="bank-tree-type"]') as HTMLSelectElement;
    expect(Array.from(typeSel.options).map((o) => o.value)).toEqual(['knowledge', 'textbook']);
    expect(Array.from(typeSel.options).map((o) => o.textContent)).toEqual(['知识点挑题', '章节挑题']);
    expect(typeSel.value).toBe('knowledge');
    const treeSelText = () => (container.querySelector('[data-testid="bank-tree-select"]') as HTMLSelectElement).textContent!;
    // 0054 R-049①：只剥「知识点」前缀（后缀版本/册次保留）；教材前缀不在剥离清单内
    expect(treeSelText()).toContain('初中物理');
    expect(treeSelText()).toContain('初中物理·人教版（2024）八年级上');
    expect(treeSelText()).toContain('高中物理');
    expect(treeSelText()).not.toContain('组卷网·知识点·');
    expect(treeSelText()).not.toContain('菁优网·知识点·');
    expect(treeSelText()).not.toContain('组卷网·教材·初中物理');
    await waitFor(() => {
      if (!container.querySelector(`[data-testid="bank-tree-node-${root1.id}"]`)) throw new Error('知识点树节点未渲染');
    });

    setSelect('[data-testid="bank-tree-type"]', 'textbook');
    await waitFor(() => {
      if (!container.querySelector(`[data-testid="bank-tree-node-${rootTb.id}"]`)) throw new Error('教材树节点未渲染');
    });
    // 切章节挑题 → 只剩教材树（唯一下拉项 = 教材树原文名：未被剥前缀）
    expect(treeSelText()).toBe('组卷网·教材·初中物理·人教版（2024）八年级上册');

    // 顶栏学科切换（树级联跟随）：道法（菁优 politics）与政治（组卷）分立为两项，各自只带自己的树
    setSelect('[data-testid="bank-tree-type"]', 'knowledge');
    setSelect('[data-testid="bank-filter-subject"]', 'subj:morality-law');
    await waitFor(() => {
      if (!treeSelText().includes('初中道法')) throw new Error('学科切换后树列表未联动');
    });
    expect(treeSelText()).toContain('初中道法·统编版（2024）七年级上');
    expect(treeSelText()).not.toContain('高中政治');
    setSelect('[data-testid="bank-filter-subject"]', 'subj:politics');
    await waitFor(() => {
      if (!treeSelText().includes('高中政治')) throw new Error('政治树未联动');
    });
    expect(treeSelText()).not.toContain('初中道法');
    void k2; void k3; void d1; void z1;
  });

  it('管理模式：软删走自绘双按钮弹层（禁 confirm）', async () => {
    render(<BankPage svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="bank-delete-q1"]')) throw new Error('删除按钮未渲染');
    });

    // 弹层确认前不删
    clickBtn('[data-testid="bank-delete-q1"]');
    await waitFor(() => {
      if (!container.querySelector('[data-testid="bank-delete-confirm"]')) throw new Error('确认弹层未出现');
    });
    expect(ctx.store.questions.has('q1')).toBe(true);

    clickBtn('[data-testid="bank-delete-confirm"]');
    await waitFor(() => {
      if (ctx.store.questions.has('q1')) throw new Error('软删未生效');
      // 弹层关闭 + 列表刷新（异步态更新与软删同批，waitFor 内一并断言）
      if (container.querySelector('[data-testid="bank-delete-confirm"]')) throw new Error('确认弹层未关闭');
    });
  });

  it('题卡直显（fix-1b 形态）+ 编辑入口 + 答案/解析折叠', async () => {
    render(<BankPage svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="bank-item-q1"]')) throw new Error('未渲染');
    });
    expect(container.querySelector('[data-testid="bank-edit-q1"]')).not.toBeNull();

    // 题卡直显：.question-content 容器 + 完整题干 + 公式已渲染；无两级展开按钮
    const stem = container.querySelector('[data-testid="bank-stem-q1"]') as HTMLElement;
    expect(stem.className).toBe('question-content');
    expect(stem.textContent).toContain('自由落体');
    expect(stem.querySelector('.katex')).not.toBeNull();
    expect(container.querySelector('[data-testid="bank-detail-q1"]')).toBeNull();
    expect(container.querySelector('[data-testid="bank-item-detail-q1"]')).toBeNull();

    // q1 种子题带答案 + 解析：默认收起 → 点钮出现
    expect(container.querySelector('[data-testid="bank-answer-q1"]')).toBeNull();
    clickBtn('[data-testid="bank-answer-toggle-q1"]');
    await waitFor(() => {
      if (!container.querySelector('[data-testid="bank-answer-q1"]')) throw new Error('答案未展开');
    });
    expect(container.querySelector('[data-testid="bank-answer-q1"]')!.textContent).toContain('机械能守恒');

    clickBtn('[data-testid="bank-analysis-toggle-q1"]');
    await waitFor(() => {
      if (!container.querySelector('[data-testid="bank-analysis-q1"]')) throw new Error('解析未展开');
    });
    expect(container.querySelector('[data-testid="bank-analysis-q1"]')!.textContent).toContain('机械能守恒定律');
  });

  it('pick 模式：选入回调携带 questionId，excludeIds 过滤已选题', async () => {
    const picked: string[] = [];
    render(<BankBrowser svc={svc} onPick={(qid) => picked.push(qid)} excludeIds={['q1']} />);

    await waitFor(() => {
      if (!container.querySelector('[data-testid="bank-pick-q2"]')) throw new Error('pick 列表未渲染');
    });
    // q1 被排除
    expect(container.querySelector('[data-testid="bank-pick-q1"]')).toBeNull();
    expect(container.querySelectorAll('[data-testid^="bank-pick-"]').length).toBe(4);

    clickBtn('[data-testid="bank-pick-q2"]');
    expect(picked).toEqual(['q2']);
  });
});

// ==================== 0014 题库页改版：两栏布局 / 顶栏学段 / 节点筛题 / 选择题聚合 ====================

describe('0014 题库页改版（左树右列表 + 挂树筛题 + 题型聚合）', () => {
  it('两栏布局 DOM：.bank-layout 左树右列表，树面板在左栏、筛选与列表在右栏；学段上移顶栏', async () => {
    await ctx.ext.dict.createEntry({ kind: 'subject', code: 'physics', label: '物理' });
    const t = await ctx.ext.tree.createTree({ type: 'knowledge', name: '组卷网·知识点·初中物理', subjectId: 'subj:physics', stage: '初中' });
    await ctx.ext.tree.createNode({ treeId: t.id, name: '力学', sort: 0 });

    render(<BankPage svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="bank-tree-panel"]')) throw new Error('树面板未渲染');
      if (!container.querySelector('[data-testid="bank-item-q1"]')) throw new Error('题卡列表未渲染');
    });

    const layout = container.querySelector('[data-testid="bank-layout"]')!;
    expect(layout.className).toContain('bank-layout');
    const side = container.querySelector('[data-testid="bank-side"]')!;
    expect(side.contains(container.querySelector('[data-testid="bank-tree-panel"]')!)).toBe(true);
    const main = container.querySelector('[data-testid="bank-main"]')!;
    expect(main.contains(container.querySelector('[data-testid="bank-keyword-input"]')!)).toBe(true);
    expect(main.contains(container.querySelector('[data-testid="bank-item-q1"]')!)).toBe(true);
    expect(main.contains(container.querySelector('[data-testid="bank-pager"]')!)).toBe(true);
    // 左栏与右栏互斥：筛选栏不在左栏、树面板不在右栏
    expect(side.contains(container.querySelector('[data-testid="bank-keyword-input"]')!)).toBe(false);
    expect(main.contains(container.querySelector('[data-testid="bank-tree-panel"]')!)).toBe(false);

    // 0014 目检返工二/三：题库页全高布局——页头/筛选栏固定，仅题目列表滚动
    // （bank-browser-root 中间层接 flex 链——返工三修复整页仍滚）
    const browserRoot = container.querySelector('.bank-browser-root');
    expect(browserRoot).not.toBeNull();
    expect(browserRoot!.contains(container.querySelector('[data-testid="bank-tree-panel"]'))).toBe(true);
    expect(container.querySelector('.bank-page')).not.toBeNull();
    expect(container.querySelector('.bank-page')!.contains(browserRoot!)).toBe(true);
    expect(main.querySelector('.bank-main-fixed')).not.toBeNull();
    expect(main.querySelector('.bank-main-fixed')!.contains(container.querySelector('[data-testid="bank-keyword-input"]'))).toBe(true);
    expect(main.querySelector('.bank-main-scroll')).not.toBeNull();
    expect(main.querySelector('.bank-main-scroll')!.contains(container.querySelector('[data-testid="bank-item-q1"]'))).toBe(true);
    expect(main.querySelector('.bank-main-scroll')!.contains(container.querySelector('[data-testid="bank-pager"]'))).toBe(true);

    // 学段下拉在右栏顶部的筛选栏（原树面板学段/学科下拉已随改版删除）
    expect(main.contains(container.querySelector('[data-testid="bank-filter-stage"]')!)).toBe(true);
    expect(container.querySelector('[data-testid="bank-tree-stage"]')).toBeNull();
    expect(container.querySelector('[data-testid="bank-tree-subject"]')).toBeNull();
    // 树面板保留类型切换 + 树选择 + 节点列表
    expect(container.querySelector('[data-testid="bank-tree-type"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="bank-tree-select"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="bank-tree-nodes"]')).not.toBeNull();
  });

  it('无树态：左栏空态卡保留，学段下拉禁用（数据源=树学段集合，无树无选项）', async () => {
    render(<BankPage svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="bank-tree-empty"]')) throw new Error('空态卡未渲染');
    });
    expect(container.querySelector('[data-testid="bank-tree-empty"]')!.textContent).toContain('知识树待采集');
    const stageSel = container.querySelector('[data-testid="bank-filter-stage"]') as HTMLSelectElement;
    expect(stageSel.disabled).toBe(true);
  });

  it('点节点筛题：命中挂在该节点子孙的题（子树派生）+ 面包屑路径 + 清除恢复全量', async () => {
    const t = await ctx.ext.tree.createTree({ type: 'knowledge', name: '物理知识点树', stage: '初中' });
    const root = await ctx.ext.tree.createNode({ treeId: t.id, name: '电学', sort: 0 });
    const child = await ctx.ext.tree.createNode({ treeId: t.id, parentId: root.id, name: '电路', sort: 0 });
    const qTree = await makeQuestion('挂树题');
    const qOther = await makeQuestion('无关题');
    await ctx.ext.tree.linkQuestion(qTree, child.id); // 只挂子节点「电路」

    render(<BankPage svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector(`[data-testid="bank-tree-node-${root.id}"]`)) throw new Error('树节点未渲染');
    });

    // 点根节点「电学」→ 挂在其子孙「电路」的题也命中（B5 子树派生）
    clickBtn(`[data-testid="bank-tree-node-${root.id}"]`);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="bank-node-crumb"]')) throw new Error('面包屑未出现');
    });
    const crumb = container.querySelector('[data-testid="bank-node-crumb"]')!;
    expect(crumb.textContent).toContain('电学');
    await waitFor(() => {
      const items = container.querySelectorAll('[data-testid^="bank-item-"]');
      if (items.length !== 1) throw new Error(`节点筛题未生效，当前 ${items.length} 题`);
    });
    expect(container.querySelector(`[data-testid="bank-item-${qTree}"]`)).not.toBeNull();
    expect(container.querySelector(`[data-testid="bank-item-${qOther}"]`)).toBeNull();

    // 展开后点子节点 → 面包屑含根到叶路径
    clickBtn(`[data-testid="bank-tree-toggle-${root.id}"]`);
    clickBtn(`[data-testid="bank-tree-node-${child.id}"]`);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="bank-node-crumb"]')!.textContent.includes('电路')) throw new Error('面包屑未更新');
    });
    expect(container.querySelector('[data-testid="bank-node-crumb"]')!.textContent).toContain('电学 › 电路');

    // 清除 → 面包屑消失，列表恢复全量
    clickBtn('[data-testid="bank-node-crumb-clear"]');
    await waitFor(() => {
      if (!container.querySelector(`[data-testid="bank-item-${qOther}"]`)) throw new Error('清除后列表未恢复');
    });
    expect(container.querySelector('[data-testid="bank-node-crumb"]')).toBeNull();
  });

  it('选择题聚合：字典有单选+多选行 → 聚合项出现且 listQuestions 收两行 typeIds；单值 typeId 旧路径零回归', async () => {
    await ctx.ext.dict.createEntry({ kind: 'question_type', code: 'single-choice', label: '单选题' });
    await ctx.ext.dict.createEntry({ kind: 'question_type', code: 'multi-choice', label: '多选题' });
    await ctx.ext.dict.createEntry({ kind: 'question_type', code: 'solution', label: '解答题' });
    const listSpy = vi.spyOn(ctx.bank, 'listQuestions');

    render(<BankPage svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="bank-item-q1"]')) throw new Error('列表未渲染');
    });

    // 聚合项出现（字典行 code 驱动，缺任一行即隐没）
    const typeSel = () => container.querySelector('[data-testid="bank-filter-type"]') as HTMLSelectElement;
    const optionValues = () => Array.from(typeSel().options).map((o) => o.value);
    expect(optionValues()).toContain('choice-group');
    expect(optionValues()).toContain('qtype:single-choice');
    expect(optionValues()).toContain('qtype:multi-choice');

    // 选聚合项 → typeIds 两行（字典 id），无 typeId
    setSelect('[data-testid="bank-filter-type"]', 'choice-group');
    await waitFor(() => {
      const call = listSpy.mock.calls.at(-1)?.[0];
      if (!call?.typeIds) throw new Error('listQuestions 未收到 typeIds');
    });
    expect([...listSpy.mock.calls.at(-1)![0].typeIds!].sort()).toEqual(['qtype:multi-choice', 'qtype:single-choice']);
    expect(listSpy.mock.calls.at(-1)![0].typeId).toBeUndefined();

    // 单值旧路径：typeId 生效、typeIds 不带
    setSelect('[data-testid="bank-filter-type"]', 'qtype:single-choice');
    await waitFor(() => {
      const call = listSpy.mock.calls.at(-1)?.[0];
      if (call?.typeId !== 'qtype:single-choice') throw new Error('typeId 未生效');
    });
    expect(listSpy.mock.calls.at(-1)![0].typeIds).toBeUndefined();

    // 下拉回显：typeIds 生效时选中聚合项
    setSelect('[data-testid="bank-filter-type"]', 'choice-group');
    await waitFor(() => {
      if (typeSel().value !== 'choice-group') throw new Error('聚合项未回显');
    });
  });

  it('选择题聚合：字典缺多选行 → 聚合项隐没（不渲染半档）', async () => {
    await ctx.ext.dict.createEntry({ kind: 'question_type', code: 'single-choice', label: '单选题' });
    render(<BankPage svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="bank-item-q1"]')) throw new Error('列表未渲染');
    });
    const typeSel = container.querySelector('[data-testid="bank-filter-type"]') as HTMLSelectElement;
    expect(Array.from(typeSel.options).some((o) => o.value === 'choice-group')).toBe(false);
  });

  it('学段筛题（目检返工）：顶栏选学段 → 只剩挂在该学段树上的题；全部学段恢复全量', async () => {
    const junior = await ctx.ext.tree.createTree({ type: 'knowledge', name: '初中物理树', stage: '初中' });
    const senior = await ctx.ext.tree.createTree({ type: 'knowledge', name: '高中物理树', stage: '高中' });
    const jNode = await ctx.ext.tree.createNode({ treeId: junior.id, name: '初中节点', sort: 0 });
    const sNode = await ctx.ext.tree.createNode({ treeId: senior.id, name: '高中节点', sort: 0 });
    const qJ = await makeQuestion('初中挂树题');
    const qS = await makeQuestion('高中挂树题');
    const qNone = await makeQuestion('未挂树题');
    await ctx.ext.tree.linkQuestion(qJ, jNode.id);
    await ctx.ext.tree.linkQuestion(qS, sNode.id);

    render(<BankPage svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector(`[data-testid="bank-item-${qNone}"]`)) throw new Error('列表未渲染');
    });
    // 默认「全部学段」：挂树/未挂树题全量可见
    const stageSel = () => container.querySelector('[data-testid="bank-filter-stage"]') as HTMLSelectElement;
    expect(stageSel().value).toBe('');
    const itemCount = () => container.querySelectorAll('[data-testid^="bank-item-"]').length;
    expect(itemCount()).toBe(8); // 种子 5 + 本用例 3

    // 选「初中」→ 只剩初中挂树题（未挂树题按学段筛语义隐藏）
    setSelect('[data-testid="bank-filter-stage"]', '初中');
    await waitFor(() => {
      if (!container.querySelector(`[data-testid="bank-item-${qJ}"]`) || container.querySelector(`[data-testid="bank-item-${qS}"]`)) throw new Error('学段筛选未生效');
    });
    expect(itemCount()).toBe(1);
    expect(container.querySelector(`[data-testid="bank-item-${qNone}"]`)).toBeNull();

    // 切「高中」→ 只剩高中挂树题
    setSelect('[data-testid="bank-filter-stage"]', '高中');
    await waitFor(() => {
      if (!container.querySelector(`[data-testid="bank-item-${qS}"]`) || container.querySelector(`[data-testid="bank-item-${qJ}"]`)) throw new Error('切高中未生效');
    });
    expect(itemCount()).toBe(1);

    // 回「全部学段」→ 全量恢复
    setSelect('[data-testid="bank-filter-stage"]', '');
    await waitFor(() => {
      if (!container.querySelector(`[data-testid="bank-item-${qNone}"]`)) throw new Error('全部学段未恢复');
    });
    expect(itemCount()).toBe(8);
  });
});

// ==================== 0018 P1：篮列表卡片行单行（防长卷名挤压按钮换行） ====================
// 照 0011 工具条断言（compose-toolbar 版）加卡片行版本——
// 行容器去 flexWrap:wrap、卷名承载 min-width:0+ellipsis、按钮组 flex 0 0 auto；
// 新增 testid 前缀 paper-row-*（避开既有 paper-card-* 前缀查询，纯增零改名）。

describe('0018 篮列表卡片行单行（防长卷名挤压按钮）', () => {
  it('行容器去换行、卷名 min-width:0+ellipsis 裁切、按钮组不换位（长卷名回归）', async () => {
    const longTitle = '超长卷名防挤压验证——'.repeat(6) + '末尾锚点';
    const paperId = await makePaperAtStatus(longTitle, 'done');

    render(<PaperSections svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="section-done"] [data-testid^="paper-card-"]')) throw new Error('已出卷列表未渲染');
    });

    const row = container.querySelector(`[data-testid="paper-row-${paperId}"]`) as HTMLElement;
    const title = container.querySelector(`[data-testid="paper-row-title-${paperId}"]`) as HTMLElement;
    const actions = container.querySelector(`[data-testid="paper-row-actions-${paperId}"]`) as HTMLElement;
    expect(row).not.toBeNull();
    expect(title).not.toBeNull();
    expect(actions).not.toBeNull();

    // 行容器去 flex-wrap:wrap（长卷名不再把按钮挤到第二行）
    expect(row.style.flexWrap).not.toBe('wrap');
    // 卷名承载元素：弹性收缩 + 溢出省略（DOM 断言，不测像素）
    expect(title.style.minWidth).toBe('0px');
    expect(title.style.overflow).toBe('hidden');
    expect(title.style.textOverflow).toBe('ellipsis');
    expect(title.style.whiteSpace).toBe('nowrap');
    // 卷名文本在场（未因裁切丢失内容节点）+ 悬停 title 见全名
    expect(title.textContent).toContain('末尾锚点');
    expect(title.getAttribute('title')).toContain('末尾锚点');
    // 按钮组整组恒在卷名右侧，不换行不换位
    expect(actions.style.flex).toBe('0 0 auto');
    // done 卷 6 个操作按钮齐全（修复零丢按钮；0035 P4 增「导出 Word」→ 5 升 6）+ 计数文本语义不变
    expect(actions.querySelectorAll('button').length).toBe(6);
    expect(actions.querySelector('[data-testid^="card-export-docx-"]')?.textContent).toBe('导出 Word');
    expect(row.textContent).toContain('题 · 总分');
  });
});
