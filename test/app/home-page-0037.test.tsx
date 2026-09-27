// 0037：首页改版组件测试 — jsdom + Mock(in-memory) + 假 guard 桥（window.__mofangGuard 注入）。
// 呈现依据：home-dashboard 设计稿（界面初稿 v1.1）+ 目检返工意见（2026-09-21 两轮）：
// - 双主角：左「教学资产」（4 大数字 + 沉淀曲线）∥ 右「工作足迹」；每项口径 tooltip
// - 空库态：统计区整区换引导（小方 stand 96 + 「去采集题目」「录一道题」），不显示一排 0
// - 小方出现位（返工一轮 #3 后两处）：页头 cheer 42 / 空库引导 stand 96
// - 快速入口（返工二轮 #4）：录题 / 采集 / 组卷 / 反馈（反馈卡指向 #/feedback，原错题本卡撤下）
// - 返工一轮：试卷三区不上首页、页头仅留「开始组卷」、备课三步撤下、数据备份迁设置页
//   （0049 目检意见① 2026-09-22：页头「开始组卷」撤下——与快捷入口「组卷」卡重复，见下方用例）
//
// 0049 适配（v3 首页落地，2026-09-22；等强适配，逐条申报见 0049 交付报告 §适配与删除清单）：
//   ① 类名随设计稿 v3 更新：.page-head→.home-v3 .hero、.dash-qentry/.dash-qname/.dash-qdesc→
//      .qentry/.qname/.qdesc、.dash-duo→.duo（断言强度不变，仅选择器搬家）；
//   ② 区标题「教学资产沉淀」→「教学资产」（v3 设计定稿命名）；
//   ③ 反馈卡描述 → 「课堂表现一键写反馈」（v3 定稿文案）；
//   ④ 短文案「AI 用量条」结构随 v3 撤下：原 4 例（次数/token 累计、日期轴短式、柱悬停弹窗、
//      无数据仍渲染 30 柱）删除——AI 次数/token 现由足迹卡「AI 消耗 N tokens」承载，新口径断言
//      在 test/app/home-page-0049.test.tsx（P3-2/P3-4）；契约字段 aiDaily/aiInvocations 未删；
//   ⑤ 桥夹具补齐 0049 契约四组新字段（activity/streak/questionGrowth/recentPapers），
//      既有 7 字段断言原样保留。
// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import { HomePage } from '../../src/app/pages/HomePage.js';
import { MockBankService } from '../../src/bank/mock/mock-bank.js';
import { createMockExtServices } from '../../src/bank/mock/mock-ext.js';
import { MockBankStore } from '../../src/bank/mock/mock-store.js';
import { workWindowKeys } from '../../src/bank/dashboard-service.js';
import type { HomeActivityDay, HomeDashboardStats } from '../../src/shared/contracts/bank-types.js';
import type { MofangGuardBridge } from '../../src/shared/contracts/bridge.js';

let store: MockBankStore;
vi.mock('../../src/app/services/BankServiceFactory.js', () => ({
  createBankService: () => new MockBankService(store, false),
}));
vi.mock('../../src/app/services/BankExtServiceFactory.js', () => ({
  createBankExtServices: () => createMockExtServices(store),
}));

// ---------------- 假 guard 桥（HomePage 经 window.__mofangGuard 取统计） ----------------

/** 固定日历：以 2026-09-21 为「今天」往前推 ago 天 → YYYY-MM-DD（免时钟漂移） */
function dayDate(ago: number): string {
  const d = new Date(2026, 8, 21 - ago);
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

const FIX_END = new Date(2026, 8, 21, 12, 0, 0);

/**
 * 0049 契约新增字段的最小有效夹具（本文件不测足迹口径，只保证页面可渲染）。
 * withActions=true 时末日落 1 笔动作 → 足迹卡走「有数据」分支（图例/AI 行在位）；
 * 空库用例传 false（灰格 + veil）。
 */
function footprintFixture(withActions = true): Pick<HomeDashboardStats, 'activity' | 'streak' | 'questionGrowth' | 'recentPapers'> {
  const keys = workWindowKeys(FIX_END);
  const activity: HomeActivityDay[] = keys.map((date, i) => ({
    date,
    byCategory: {
      proof: withActions && i === keys.length - 1 ? 1 : 0,
      capture: 0,
      compose: 0,
      mistake: 0,
      feedback: 0,
      ai: 0,
    },
    tokens: 0,
  }));
  return {
    activity,
    streak: withActions ? { current: 1, longest: 1 } : { current: 0, longest: 0 },
    questionGrowth: keys.map((date) => ({ date, total: 0 })),
    recentPapers: [],
  };
}

function dashFixture(overrides: Partial<HomeDashboardStats> = {}): HomeDashboardStats {
  return {
    questions: 1247,
    papers: 36,
    documentsRecognized: 24,
    mistakeRecords: 218,
    aiInvocations: 342,
    aiTokens: 1_286_000, // → 128.6 万
    aiDaily: Array.from({ length: 30 }, (_, i) => ({
      date: dayDate(29 - i),
      count: i === 29 ? 40 : (i % 4) + 1,
      tokens: i === 29 ? 40_000 : ((i % 4) + 1) * 1_000,
    })),
    ...footprintFixture(),
    ...overrides,
  };
}

function injectGuardFake(getDashboard: () => Promise<HomeDashboardStats>): MofangGuardBridge {
  const fake: MofangGuardBridge = {
    getDashboard,
    getStats: async () => ({ questions: 1, papers: 1, assets: 1 }),
    createBackup: () => Promise.reject(new Error('not needed in test')),
    restoreBackup: () => Promise.reject(new Error('not needed in test')),
  };
  window.__mofangGuard = fake;
  return fake;
}

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

function q<T extends Element = Element>(selector: string): T | null {
  return container.querySelector<T>(selector);
}
function qa<T extends Element = Element>(selector: string): T[] {
  return Array.from(container.querySelectorAll<T>(selector));
}

beforeEach(() => {
  store = new MockBankStore();
});

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  window.location.hash = '';
  delete window.__mofangGuard;
});

describe('0037 P1：教学资产区（双主角之一，返工 #4 指标换血 + 二轮 #2/#3；0049 v3 命名适配）', () => {
  it('四指标大数字卡：题库题目/试卷库/录入文档/错题沉淀，数值来自 getDashboard', async () => {
    injectGuardFake(async () => dashFixture());
    render();
    await waitFor(() => {
      if (!q('[data-testid="home-dash-stats"]')) throw new Error('统计区未渲染');
    });
    expect(q('[data-testid="home-stat-questions"]')!.textContent).toContain('1,247');
    expect(q('[data-testid="home-stat-papers"]')!.textContent).toContain('36');
    expect(q('[data-testid="home-stat-documents"]')!.textContent).toContain('24');
    expect(q('[data-testid="home-stat-mistakes"]')!.textContent).toContain('218');
    const zoneText = q('[data-testid="home-dash-stats"]')!.textContent ?? '';
    for (const label of ['题库题目', '试卷库', '录入文档', '错题沉淀']) {
      expect(zoneText).toContain(label);
    }
    // 0049 v3：区标题「教学资产沉淀」→「教学资产」；「数字旁 ⓘ 可查看口径」提示语仍不出现
    expect(zoneText).toContain('教学资产');
    expect(zoneText).not.toContain('沉淀统计');
    expect(zoneText).not.toContain('可查看口径');
  });

  it('口径 tooltip：四指标 + 足迹/AI 各有 .info-tip>.itip，口径文案与实现一致（返工 #4 口径）', async () => {
    injectGuardFake(async () => dashFixture());
    render();
    await waitFor(() => {
      if (qa('.home-v3 .info-tip .itip').length < 6) throw new Error('tooltip 未渲染齐');
    });
    const tips = qa('.home-v3 .info-tip .itip').map((el) => el.textContent ?? '');
    const all = tips.join('\n');
    expect(tips.length).toBeGreaterThanOrEqual(6);
    expect(all).toContain('不含回收站'); // 试卷库口径
    expect(all).toContain('识别记录'); // 录入文档口径
    expect(all).toContain('学生×题'); // 错题沉淀口径
    expect(all).toContain('operation_log'); // 足迹（流量）口径来源
    expect(all).toContain('未返回'); // token 口径：供应商未返回 usage 不计入
    expect(all).not.toContain('source_type'); // 网络采集指标已随返工 #4 撤下
  });
});

describe('0037 P2：快速入口区（双主角之二，收敛 4 卡；二轮 #4 反馈换入）', () => {
  it('恰好 4 张大动作卡：录题/采集/组卷/反馈，文案按设计定稿', async () => {
    injectGuardFake(async () => dashFixture());
    render();
    await waitFor(() => {
      if (qa('.home-v3 .qentry').length !== 4) throw new Error(`入口卡未渲染齐：${qa('.home-v3 .qentry').length}`);
    });
    const names = qa('.home-v3 .qentry .qname').map((el) => el.textContent);
    expect(names).toEqual(['录题', '采集', '组卷', '反馈']);
    const descs = qa('.home-v3 .qentry .qdesc').map((el) => el.textContent);
    expect(descs[0]).toBe('从图片或文档中录入试题');
    expect(descs[1]).toBe('从网络题库采集');
    expect(descs[2]).toBe('选题、排版、导出');
    expect(descs[3]).toBe('课堂表现一键写反馈'); // 0049 v3 定稿文案（原「记录课堂表现与成绩，一键写反馈」）
    // 旧 10 卡与一轮的错题本卡撤下：管理类/错题本入口名称不得再出现在入口卡中
    for (const gone of ['学生档案', '班级管理', '考试管理', '课后反馈', '题库管理', '试卷管理', '错题本']) {
      expect(names).not.toContain(gone);
    }
  });

  it('四卡点击落点：录题→#/proof、采集→#/capture、组卷→#/basket、反馈→#/feedback', async () => {
    injectGuardFake(async () => dashFixture());
    render();
    await waitFor(() => {
      if (qa('.home-v3 .qentry').length !== 4) throw new Error('入口卡未渲染齐');
    });
    const targets: Array<[string, string]> = [
      ['[data-testid="home-proof-link"]', '#/proof'],
      ['[data-testid="home-capture-link"]', '#/capture'],
      ['[data-testid="home-compose-entry"]', '#/basket'],
      ['[data-testid="home-feedback-link"]', '#/feedback'],
    ];
    for (const [testid, hash] of targets) {
      const btn = q(testid) as HTMLButtonElement | null;
      expect(btn, `${testid} 未渲染`).toBeTruthy();
      flushSync(() => btn!.click());
      expect(window.location.hash).toBe(hash);
      window.location.hash = '';
    }
    expect(q('[data-testid="home-mistakes-link"]'), '错题本卡应随二轮 #4 撤下').toBeNull();
  });
});

describe('0037 P3 + 返工 #1/#2/#3/#6：首页收敛', () => {
  it('返工 #2 + 目检意见①：页头不放动作按钮（「开始组卷」随 0049 目检撤下），无「查看错题本」', async () => {
    injectGuardFake(async () => dashFixture());
    render();
    await waitFor(() => {
      if (!q('.home-v3 .hero')) throw new Error('页头未渲染');
    });
    const headText = q('.home-v3 .hero')!.textContent ?? '';
    expect(headText).not.toContain('查看错题本');
    // 0037 返工 #2 曾把页头收敛为「仅留开始组卷」；0049 目检意见①（2026-09-22）认为它与
    // 快捷入口「组卷」卡重复 → 页头右侧只留 🔥 连续天数徽章，页头无按钮
    expect(headText).not.toContain('开始组卷');
    expect(q('.home-v3 .hero button')).toBeNull();
  });

  it('返工 #1/#3/#6：试卷三区/备课三步/数据备份不再上首页', async () => {
    injectGuardFake(async () => dashFixture());
    render();
    await waitFor(() => {
      if (!q('.home-v3 .duo')) throw new Error('双主角区未渲染');
    });
    expect(q('[data-testid="home-papers-zone"]'), '试卷三区应从首页移除').toBeNull();
    expect(q('.guide-card'), '备课三步指引卡应从首页移除').toBeNull();
    expect(container.textContent).not.toContain('数据备份');
    expect(container.textContent).not.toContain('备课三步');
    expect(container.textContent).not.toContain('新建试题篮');
  });

  it('小方出现位（返工 #3 后两处）：页头 cheer（42px）；指引卡 happy 不再出现', async () => {
    injectGuardFake(async () => dashFixture());
    render();
    await waitFor(() => {
      if (!q('.home-v3 .hero [data-mascot="cheer"]')) throw new Error('页头小方未渲染');
    });
    const cheer = q('.home-v3 .hero [data-mascot="cheer"]') as HTMLImageElement;
    expect(cheer.getAttribute('height')).toBe('42');
    expect(q('[data-mascot="happy"]'), '指引卡已撤，happy 位不应存在').toBeNull();
  });

  it('空库态：统计区整区换引导（stand 96 + 两按钮），不显示一排 0', async () => {
    injectGuardFake(async () => dashFixture({
      questions: 0, papers: 0, documentsRecognized: 0, mistakeRecords: 0, aiInvocations: 0, aiTokens: 0,
      aiDaily: Array.from({ length: 30 }, (_, i) => ({ date: dayDate(29 - i), count: 0, tokens: 0 })),
      ...footprintFixture(false),
    }));
    render();
    await waitFor(() => {
      if (!q('[data-testid="home-empty-hero"]')) throw new Error('空库引导态未渲染');
    });
    expect(q('[data-testid="home-dash-stats"]'), '空库时不得渲染数字统计区').toBeNull();
    const stand = q('[data-testid="home-empty-hero"] [data-mascot="stand"]') as HTMLImageElement | null;
    expect(stand, '空库引导小方 stand 未渲染').toBeTruthy();
    expect(stand!.getAttribute('height')).toBe('96');
    const captureBtn = q('[data-testid="home-empty-capture-btn"]') as HTMLButtonElement;
    const proofBtn = q('[data-testid="home-empty-proof-btn"]') as HTMLButtonElement;
    expect(captureBtn.textContent).toContain('去采集题目');
    expect(proofBtn.textContent).toContain('录一道题');
    flushSync(() => captureBtn.click());
    expect(window.location.hash).toBe('#/capture');
    flushSync(() => proofBtn.click());
    expect(window.location.hash).toBe('#/proof');
  });
});
