// 0004-fix-1 E 组：首页主入口「组卷」测试 — jsdom + Mock(in-memory) 单跑
// 0011 改版（Q1-4 拍板）：组卷入口恒跳 #/basket（与导航语义对齐，不再取第一张处理中卷直达）；
// 0037 首页改版：快捷入口收敛 4 张大动作卡（录题/采集/组卷/反馈），10 张旧平铺小卡撤下首页
// （学生/班级/考试/反馈等管理类入口顶导航可达，页面不删）；录题卡指向 #/proof（0040 已收口）。
// 0049 v3 适配：① 入口卡类名随设计稿更新（旧 dash-qname/dash-qdesc → qname/qdesc）；
// ② 页头「开始组卷」按钮随 2026-09-22 目检意见①撤下 → 0011 的「恒跳 #/basket」语义
//    现由快捷入口「组卷」卡（home-compose-entry）承载，本文件断言随之改点该卡，语义不变。
// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import { HomePage } from '../../src/app/pages/HomePage.js';
import { MockBankService } from '../../src/bank/mock/mock-bank.js';
import { createMockExtServices } from '../../src/bank/mock/mock-ext.js';
import { MockBankStore } from '../../src/bank/mock/mock-store.js';

// HomePage 经 useExtPageServices() 取服务（无注入 prop）——工厂走 window.__mofangBank/Ext 桥，
// jsdom 下无桥即回落 mock；此处直接 mock 工厂模块，注入同一份 store 以便断言。
let store: MockBankStore;
vi.mock('../../src/app/services/BankServiceFactory.js', () => ({
  createBankService: () => new MockBankService(store, false),
}));
vi.mock('../../src/app/services/BankExtServiceFactory.js', () => ({
  createBankExtServices: () => createMockExtServices(store),
}));

let container: HTMLDivElement;
let root: Root | null = null;

function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => root!.render(<HomePage />));
}

async function waitFor(assertion: () => void) {
  await vi.waitFor(assertion, { timeout: 3000, interval: 20 });
}

function clickEntry() {
  const btn = container.querySelector('[data-testid="home-compose-entry"]') as HTMLButtonElement | null;
  if (!btn) throw new Error('组卷入口未渲染');
  flushSync(() => btn.click());
}

beforeEach(() => {
  store = new MockBankStore();
});

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  window.location.hash = '';
});

describe('0011（0049 后由入口卡承载）：组卷入口恒跳 #/basket，不直达任何卷', () => {
  it('有处理中卷（草稿/排版中）仍恒跳列表，不直达任何卷', async () => {
    const bank = new MockBankService(store, false);
    const ext = createMockExtServices(store);
    const paper = await bank.createPaper('首页在处理卷');
    render();
    await waitFor(() => {
      if (!container.querySelector('[data-testid="home-compose-entry"]')) throw new Error('未渲染');
    });
    clickEntry();
    await waitFor(() => {
      if (window.location.hash !== '#/basket') throw new Error(`未跳列表：${window.location.hash}`);
    });
    expect(window.location.hash).toBe('#/basket');

    // 排版中卷在场（旧逻辑会直达排版间）→ 仍恒 #/basket
    await ext.paper.updatePaperStatus(paper.id, 'composing');
    render();
    await waitFor(() => {
      if (!container.querySelector('[data-testid="home-compose-entry"]')) throw new Error('未渲染');
    });
    clickEntry();
    expect(window.location.hash).toBe('#/basket');
  });

  it('无处理中卷 → 跳 #/basket 新建引导（行为不变）', async () => {
    const bank = new MockBankService(store, false);
    const ext = createMockExtServices(store);
    const paper = await bank.createPaper('已出卷');
    await ext.paper.updatePaperStatus(paper.id, 'composing');
    await ext.paper.updatePaperStatus(paper.id, 'done');
    render();
    await waitFor(() => {
      if (!container.querySelector('[data-testid="home-compose-entry"]')) throw new Error('未渲染');
    });
    clickEntry();
    expect(window.location.hash).toBe('#/basket');
  });

  it('快捷入口卡文案（0037 收敛 4 卡；二轮返工 #4 反馈换入）：采集/组卷/反馈名称落位（全量断言见 home-page-0037）', async () => {
    render();
    await waitFor(() => {
      if (!container.querySelector('[data-testid="home-capture-link"]')) throw new Error('采集入口未渲染');
    });
    // 0037：入口名统一为动作短词（「网络采集」→「采集」）；题库管理/试卷管理不再上首页（顶导航可达）
    // 二轮返工 #4：错题本卡撤下换「反馈」（定向 #/feedback）
    expect(container.querySelector('[data-testid="home-capture-link"] .qname')!.textContent).toBe('采集');
    expect(container.querySelector('[data-testid="home-compose-entry"] .qname')!.textContent).toBe('组卷');
    expect(container.querySelector('[data-testid="home-feedback-link"] .qname')!.textContent).toBe('反馈');
    expect(container.querySelector('[data-testid="home-bank-link"]')).toBeNull();
    expect(container.querySelector('[data-testid="home-basket-link"]')).toBeNull();
    expect(container.querySelector('[data-testid="home-mistakes-link"]')).toBeNull();
  });
});

// 0022→0037：录题卡指向 #/proof；0040 收口后指向落定，文案随目检二轮 #4 定稿（不绑具体交互词）
describe('0037：首页录题卡（原「试题录入」占位卡的行为变更适配）', () => {
  it('录题卡 desc 为「从图片或文档中录入试题」，入口可点（#/proof）', async () => {
    render();
    await waitFor(() => {
      if (!container.querySelector('[data-testid="home-proof-link"]')) throw new Error('录题入口未渲染');
    });
    const card = container.querySelector<HTMLButtonElement>('[data-testid="home-proof-link"]');
    expect(card!.querySelector('.qdesc')!.textContent).toBe('从图片或文档中录入试题');
    // 不置灰不 disabled（顶导航/入口直达一致）
    expect(card!.disabled).toBe(false);
    flushSync(() => card!.click());
    expect(window.location.hash).toBe('#/proof');
  });
});
