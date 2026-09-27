// 0049 P3：首页 v3「工作足迹」组件测试 — jsdom + 假 guard 桥（window.__mofangGuard 注入）。
// 呈现依据：home-dashboard-v3 设计稿（v3 定稿，D-068）+ 任务书 §P3。
// 断言面（对应任务书 §四 P3 与 §六 目检清单）：
// - 三态渲染分支：满数据 / 低数据（notice-warm 阈值：半年动作 <100 且题库 <50）/ 空库（引导 hero + 灰格 veil）
// - testid 等价清单：四入口 + 四 stat + home-dash-stats + home-empty-hero（0037 保留）
//   ＋ home-footprint / home-heatmap / home-growth-chart / home-recent-papers（0049 新增）
// - 热力图档级映射：0 / 1-2 / 3-4 / 5-7 / ≥8 → lv0~lv4 + 今日格 today 橙圈
// - 图例隔离：点类别 → 堆叠条 dim + 该类 keep；再点还原
// - 存量/流量零重复：资产卡（存量）与足迹卡（流量）各自吃不同来源
// - 沉淀曲线终点数字 = 资产卡题库题目数；+N 本月徽章
// - 最近试卷：最新一卷便签黄 C 位（.star.tape）、状态 pill、查看全部 → #/papers；无卷整区不渲染
// - 🔥 连续天数：current>0 才显示、title=最长、空库不显示
// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import { HomePage, relativeTime } from '../../src/app/pages/HomePage.js';
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

/** 数据快照末日（周一，与设计稿 2026-09-21 同日）——组件内「今日」取自数据末日，测试不依赖真机时钟 */
const FIX_END = new Date(2026, 8, 21, 12, 0, 0);

/** 热力图档级样本：前 9 天 = 0/1/2/3/4/5/7/8/20 次（覆盖 lv0~lv4 两两边界），末日=8 次 */
const LEVELS = [0, 1, 2, 3, 4, 5, 7, 8, 20];

function buildActivity(): HomeActivityDay[] {
  const keys = workWindowKeys(FIX_END);
  return keys.map((date, i) => {
    const last = i === keys.length - 1;
    const proof = i < LEVELS.length ? LEVELS[i]! : last ? 3 : 0;
    return {
      date,
      byCategory: {
        proof,
        capture: 0,
        compose: last ? 2 : 0,
        mistake: last ? 1 : 0,
        feedback: last ? 1 : 0,
        ai: last ? 1 : 0,
      },
      tokens: last ? 5000 : 0,
    };
  });
}

/** 快照末日往前 ago 天的 ISO 时刻（本地构造，免时区漂移） */
function agoIso(agoDays: number, hour = 20, minute = 10): string {
  return new Date(FIX_END.getFullYear(), FIX_END.getMonth(), FIX_END.getDate() - agoDays, hour, minute).toISOString();
}

function dashFixture(overrides: Partial<HomeDashboardStats> = {}): HomeDashboardStats {
  const keys = workWindowKeys(FIX_END);
  // 沉淀曲线：终点恰 = 本期题库题目数 211（与资产卡同源，组件据此断言终点数字）
  const questionGrowth = keys.map((date, i) => ({ date, total: 29 + i }));
  return {
    questions: 211,
    papers: 59,
    documentsRecognized: 35,
    mistakeRecords: 9,
    aiInvocations: 342,
    aiTokens: 1_286_000,
    aiDaily: Array.from({ length: 30 }, (_, i) => ({
      date: keys[keys.length - 30 + i]!,
      count: (i % 4) + 1,
      tokens: ((i % 4) + 1) * 1000,
    })),
    activity: buildActivity(),
    streak: { current: 6, longest: 11 },
    questionGrowth,
    recentPapers: [
      { id: 'p1', title: '八年级物理 · 九月月考卷', status: 'composing', questionCount: 24, updatedAt: agoIso(0, 10, 0) },
      { id: 'p2', title: '九年级数学 · 期中复习卷', status: 'done', questionCount: 28, updatedAt: agoIso(1) },
      { id: 'p3', title: '八年级物理 · 浮力专项卷', status: 'done', questionCount: 18, updatedAt: agoIso(5, 9, 0) },
    ],
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

describe('0049 P3-1：满数据态四段结构与 testid 等价清单', () => {
  it('四段结构齐：页头带 / 快捷入口横条 / 双主角 / 最近试卷', async () => {
    injectGuardFake(async () => dashFixture());
    render();
    await waitFor(() => {
      if (!q('[data-testid="home-recent-papers"]')) throw new Error('最近试卷未渲染');
    });
    expect(q('.home-v3 .hero')).toBeTruthy();
    expect(qa('.home-v3 .quick .qentry')).toHaveLength(4);
    expect(q('.home-v3 .duo [data-testid="home-dash-stats"]')).toBeTruthy();
    expect(q('.home-v3 .duo [data-testid="home-footprint"]')).toBeTruthy();
    expect(q('.home-v3 .duo [data-testid="home-heatmap"]')).toBeTruthy();
    expect(q('.home-v3 .duo [data-testid="home-growth-chart"]')).toBeTruthy();
    expect(q('[data-testid="home-recent-papers"]')).toBeTruthy();
  });

  it('0037 testid 等价保留：四入口 + 四 stat + home-dash-stats + home-empty-hero 分支', async () => {
    injectGuardFake(async () => dashFixture());
    render();
    await waitFor(() => {
      if (!q('[data-testid="home-dash-stats"]')) throw new Error('资产卡未渲染');
    });
    for (const id of ['home-proof-link', 'home-capture-link', 'home-compose-entry', 'home-feedback-link']) {
      expect(q(`[data-testid="${id}"]`), id).toBeTruthy();
    }
    for (const id of ['home-stat-questions', 'home-stat-papers', 'home-stat-documents', 'home-stat-mistakes']) {
      expect(q(`[data-testid="${id}"]`), id).toBeTruthy();
    }
  });

  it('入口四卡：名称/描述与色砖（orange/green/gold/violet）+ 悬停箭头在位', async () => {
    injectGuardFake(async () => dashFixture());
    render();
    await waitFor(() => {
      if (qa('.home-v3 .qentry').length !== 4) throw new Error('入口卡未渲染齐');
    });
    const names = qa('.home-v3 .qname').map((el) => el.textContent);
    expect(names).toEqual(['录题', '采集', '组卷', '反馈']);
    const descs = qa('.home-v3 .qdesc').map((el) => el.textContent);
    expect(descs).toEqual(['从图片或文档中录入试题', '从网络题库采集', '选题、排版、导出', '课堂表现一键写反馈']);
    const tints = qa<HTMLElement>('.home-v3 .qentry').map((el) => el.dataset.tint);
    expect(tints).toEqual(['orange', 'green', 'gold', 'violet']);
    expect(qa('.home-v3 .qentry .qarrow')).toHaveLength(4);
  });

  it('入口四卡点击落点：#/proof、#/capture、#/basket、#/feedback', async () => {
    injectGuardFake(async () => dashFixture());
    render();
    await waitFor(() => {
      if (qa('.home-v3 .qentry').length !== 4) throw new Error('入口卡未渲染齐');
    });
    for (const [testid, hash] of [
      ['home-proof-link', '#/proof'],
      ['home-capture-link', '#/capture'],
      ['home-compose-entry', '#/basket'],
      ['home-feedback-link', '#/feedback'],
    ] as Array<[string, string]>) {
      const btn = q(`[data-testid="${testid}"]`) as HTMLButtonElement;
      flushSync(() => btn.click());
      expect(window.location.hash, testid).toBe(hash);
      window.location.hash = '';
    }
  });

  it('页头带：日期=本地今天（N月N日 · 周X）；「开始组卷」已随目检意见①撤下（组卷由入口卡承载）', async () => {
    injectGuardFake(async () => dashFixture());
    render();
    await waitFor(() => {
      if (!q('[data-testid="home-today"]')) throw new Error('页头未渲染');
    });
    const today = new Date();
    const expectLabel = `${today.getMonth() + 1}月${today.getDate()}日 · ${['周日', '周一', '周二', '周三', '周四', '周五', '周六'][today.getDay()]}`;
    expect(q('[data-testid="home-today"]')!.textContent).toBe(expectLabel);
    // 目检意见①（2026-09-22）：页头不再放「开始组卷」（与快捷入口「组卷」卡重复）
    expect(q('[data-testid="home-start-compose"]')).toBeNull();
    expect(q('.home-v3 .hero')!.textContent).not.toContain('开始组卷');
    // 组卷落点由入口卡唯一承载（#/basket）
    const composeEntry = q('[data-testid="home-compose-entry"]') as HTMLButtonElement;
    flushSync(() => composeEntry.click());
    expect(window.location.hash).toBe('#/basket');
  });

  it('小方出现位：页头 cheer 42（空库态另有 stand 96）', async () => {
    injectGuardFake(async () => dashFixture());
    render();
    await waitFor(() => {
      if (!q('.home-v3 .hero [data-mascot="cheer"]')) throw new Error('页头小方未渲染');
    });
    expect((q('.home-v3 .hero [data-mascot="cheer"]') as HTMLImageElement).getAttribute('height')).toBe('42');
  });
});

describe('0049 P3-2：存量 vs 流量分层（两卡数字零重复）', () => {
  it('资产卡吃存量四指标；足迹卡吃流量总数（半年合计=activity 求和），互不串味', async () => {
    injectGuardFake(async () => dashFixture());
    render();
    await waitFor(() => {
      if (!q('[data-testid="home-footprint-total"]')) throw new Error('足迹头部未渲染');
    });
    expect(q('[data-testid="home-stat-questions"]')!.textContent).toContain('211');
    expect(q('[data-testid="home-stat-papers"]')!.textContent).toContain('59');
    expect(q('[data-testid="home-stat-documents"]')!.textContent).toContain('35');
    expect(q('[data-testid="home-stat-mistakes"]')!.textContent).toContain('9');
    // 流量总数 = 各日六类求和 = 53+2+1+1+1 = 58（fixture 造得与任何存量数字都不同）
    expect(q('[data-testid="home-footprint-total"]')!.textContent).toContain('58');
    // 存量数字不进足迹卡；流量总数不进资产卡
    const footprintText = q('[data-testid="home-footprint"]')!.textContent ?? '';
    expect(footprintText).not.toContain('211');
    expect(footprintText).not.toContain('1,247');
    expect(q('[data-testid="home-dash-stats"]')!.textContent ?? '').not.toContain('58');
  });

  it('图例五类（采集并入录题）+ 各类半年合计 + AI tokens 行', async () => {
    injectGuardFake(async () => dashFixture());
    render();
    await waitFor(() => {
      if (qa('.home-v3 .legend .lg').length === 0) throw new Error('图例未渲染');
    });
    const cats = qa<HTMLElement>('.home-v3 .legend .lg').map((el) => el.dataset.cat);
    expect(cats).toEqual(['proof', 'compose', 'mistake', 'feedback', 'ai']);
    expect(cats).not.toContain('capture'); // fallback 申报：采集不可分 → 图例五类
    const nums = qa('.home-v3 .legend .lg .n').map((el) => el.textContent);
    expect(nums).toEqual(['53', '2', '1', '1', '1']);
    const aiLine = q('.home-v3 .ai-line')!.textContent ?? '';
    expect(aiLine).toContain('AI 消耗');
    expect(aiLine).toContain('5,000');
    expect(aiLine).toContain('tokens');
  });

  it('AI tokens ≥1 万显示「N.N 万」（0037 口径沿用）', async () => {
    injectGuardFake(async () => dashFixture({
      activity: buildActivity().map((d, i, arr) => (i === arr.length - 1 ? { ...d, tokens: 28600 } : d)),
    }));
    render();
    await waitFor(() => {
      if (!q('.home-v3 .ai-line')) throw new Error('AI 行未渲染');
    });
    expect(q('.home-v3 .ai-line')!.textContent).toContain('2.9 万');
  });
});

describe('0049 P3-3：热力图（档级映射 / 今日圈 / 悬停明细 / 最活跃日）', () => {
  it('档级映射：0→lv0、1-2→lv1、3-4→lv2、5-7→lv3、≥8→lv4（data-level 与类名双钉）', async () => {
    injectGuardFake(async () => dashFixture());
    render();
    await waitFor(() => {
      if (qa('.home-v3 .hcell').length === 0) throw new Error('热力图未渲染');
    });
    const cells = qa<HTMLElement>('.home-v3 .hcell');
    expect(cells.length).toBe(workWindowKeys(FIX_END).length);
    const expected = ['0', '1', '1', '2', '2', '3', '3', '4', '4'];
    for (let i = 0; i < expected.length; i++) {
      expect(cells[i]!.dataset.level, `第 ${i} 格`).toBe(expected[i]);
      expect(cells[i]!.className, `第 ${i} 格`).toContain(expected[i] === '0' ? 'hcell' : `lv${expected[i]}`);
    }
    expect(cells[0]!.className).not.toContain('lv'); // 0 档无 lv 类（走 --heat0）
  });

  it('今日格橙圈（today）且只有一格；悬停明细含日期与六类明细', async () => {
    injectGuardFake(async () => dashFixture());
    render();
    await waitFor(() => {
      if (qa('.home-v3 .hcell').length === 0) throw new Error('热力图未渲染');
    });
    const today = qa('.home-v3 .hcell.today');
    expect(today).toHaveLength(1);
    const tip = today[0]!.querySelector('.tip')!;
    expect(tip.querySelector('.tt')!.textContent).toContain('9月21日');
    expect(tip.querySelector('.tt')!.textContent).toContain('周一');
    expect(tip.querySelector('.tt')!.textContent).toContain('8 次'); // 3+2+1+1+1
    const rows = Array.from(tip.querySelectorAll('.tr'));
    expect(rows.map((r) => r.firstChild?.nextSibling?.textContent)).toEqual(['录题', '组卷', '错题', '反馈', 'AI']);
    expect(rows.map((r) => r.querySelector('em')!.textContent)).toEqual(['3', '2', '1', '1', '1 · 5,000 tokens']);
    // 零值类别不占行（只列当日有动作的类）
    expect(rows).toHaveLength(5);
  });

  it('最活跃日注脚：取窗口内最高总次数日（并列取最早）', async () => {
    injectGuardFake(async () => dashFixture());
    render();
    await waitFor(() => {
      if (!q('.home-v3 .heat-foot')) throw new Error('热力图页脚未渲染');
    });
    // 第 9 天（03-31）20 次为峰值
    expect(q('.home-v3 .heat-foot')!.textContent).toContain('3/31');
    expect(q('.home-v3 .heat-foot')!.textContent).toContain('20 次');
  });

  it('月份行与「一三五」行标在位；色阶图例（少→多 5 档）在位', async () => {
    injectGuardFake(async () => dashFixture());
    render();
    await waitFor(() => {
      if (qa('.home-v3 .hcell').length === 0) throw new Error('热力图未渲染');
    });
    expect(qa('.home-v3 .heat-months span').filter((s) => (s.textContent ?? '') !== '').length).toBeGreaterThan(4);
    expect(q('.home-v3 .heat-months')!.textContent).toContain('3月');
    expect(q('.home-v3 .heat-wk')!.textContent).toContain('一');
    expect(q('.home-v3 .heat-wk')!.textContent).toContain('三');
    expect(q('.home-v3 .heat-wk')!.textContent).toContain('五');
    expect(qa('.home-v3 .heat-scale i')).toHaveLength(5);
  });
});

describe('0049 P3-4：近 30 日堆叠条 + 图例隔离交互', () => {
  it('堆叠条：30 日窗口、按类分色段、今日有段', async () => {
    injectGuardFake(async () => dashFixture());
    render();
    await waitFor(() => {
      if (qa('.home-v3 .bars-svg .seg').length === 0) throw new Error('堆叠条未渲染');
    });
    const segs = qa<HTMLElement>('.home-v3 .bars-svg .seg');
    const cats = new Set(segs.map((s) => s.dataset.cat));
    expect([...cats].sort()).toEqual(['ai', 'compose', 'feedback', 'mistake', 'proof']);
    expect(q('.home-v3 .bars-axis')!.textContent).toContain('8/23');
    expect(q('.home-v3 .bars-axis')!.textContent).toContain('9/21');
  });

  it('图例隔离：点「组卷」→ 堆叠条 dim + 组卷段 keep；再点还原', async () => {
    injectGuardFake(async () => dashFixture());
    render();
    await waitFor(() => {
      if (qa('.home-v3 .legend .lg').length === 0) throw new Error('图例未渲染');
    });
    const compose = qa<HTMLElement>('.home-v3 .legend .lg').find((el) => el.dataset.cat === 'compose')!;
    flushSync(() => compose.click());
    // 注意：SVG 元素的 className 是 SVGAnimatedString，取 class 属性断言
    expect(q('.home-v3 .bars-svg')!.getAttribute('class')).toContain('dim');
    const kept = qa<HTMLElement>('.home-v3 .bars-svg .seg.keep').map((s) => s.dataset.cat);
    expect(kept.length).toBeGreaterThan(0);
    expect(new Set(kept)).toEqual(new Set(['compose']));
    expect(compose.className).not.toContain('off');
    expect(qa('.home-v3 .legend .lg.off').length).toBe(4);
    // 再点同一类别 → 取消隔离
    flushSync(() => compose.click());
    expect(q('.home-v3 .bars-svg')!.getAttribute('class')).not.toContain('dim');
    expect(qa('.home-v3 .bars-svg .seg.keep')).toHaveLength(0);
    expect(qa('.home-v3 .legend .lg.off')).toHaveLength(0);
    // 点另一类别 → 隔离切换（旧类解禁，新类保留）
    const proof = qa<HTMLElement>('.home-v3 .legend .lg').find((el) => el.dataset.cat === 'proof')!;
    flushSync(() => compose.click());
    flushSync(() => proof.click());
    expect(new Set(qa<HTMLElement>('.home-v3 .bars-svg .seg.keep').map((s) => s.dataset.cat))).toEqual(new Set(['proof']));
  });
});

describe('0049 P3-5：沉淀曲线（终点数字=题库题目数 + 本月徽章）', () => {
  it('终点数字 = 资产卡题库题目数（211）；+21 本月徽章', async () => {
    injectGuardFake(async () => dashFixture());
    render();
    await waitFor(() => {
      if (!q('[data-testid="home-growth-end"]')) throw new Error('沉淀曲线未渲染');
    });
    expect(q('[data-testid="home-growth-end"]')!.textContent).toBe('211');
    expect(q('[data-testid="home-stat-questions"]')!.textContent).toContain('211');
    // 09-01 为月度起点：211 − 190 = 21
    expect(q('[data-testid="home-growth-delta"]')!.textContent).toContain('+21');
    expect(q('[data-testid="home-growth-delta"]')!.textContent).toContain('本月');
    // 曲线为 SVG 平滑路径 + 渐变填充 + 终点圆点
    expect(q('[data-testid="home-growth-chart"] svg path')).toBeTruthy();
    expect(qa('[data-testid="home-growth-chart"] svg path').length).toBeGreaterThanOrEqual(2);
    expect(q('[data-testid="home-growth-chart"] svg circle')).toBeTruthy();
    expect(q('[data-testid="home-growth-chart"] svg linearGradient')).toBeTruthy();
  });

  it('月份刻度按真实位置绝对定位；起点月与次刻度过近时舍起点月（设计稿防重叠规则）', async () => {
    injectGuardFake(async () => dashFixture());
    render();
    await waitFor(() => {
      if (!q('.home-v3 .grow-axis')) throw new Error('月份轴未渲染');
    });
    const ticks = qa<HTMLElement>('.home-v3 .grow-axis span');
    expect(ticks.length).toBeGreaterThanOrEqual(6);
    // 窗口起点 03-23，4/1 位于 4.95%（<7%）→ 首刻度舍 3 月，从 4 月起（设计稿同规则）
    expect(ticks[0]!.textContent).toBe('4月');
    expect(ticks[ticks.length - 1]!.textContent).toBe('9月');
    for (const t of ticks) expect(t.style.left).toMatch(/%$/);
    // 每格刻度按真实位置递增
    const lefts = ticks.map((t) => Number.parseFloat(t.style.left));
    for (let i = 1; i < lefts.length; i++) expect(lefts[i]!).toBeGreaterThan(lefts[i - 1]!);
  });
});

describe('0049 P3-6：最近试卷条', () => {
  it('三卡：最新一卷便签黄 C 位（.star.tape）+ 状态 pill + 题数', async () => {
    injectGuardFake(async () => dashFixture());
    render();
    await waitFor(() => {
      if (qa('.home-v3 .pcard').length !== 3) throw new Error('最近试卷未渲染齐');
    });
    const cards = qa('.home-v3 .pcard');
    expect(cards[0]!.className).toContain('star');
    expect(cards[0]!.className).toContain('tape');
    expect(cards[1]!.className).not.toContain('star');
    expect(cards[0]!.textContent).toContain('八年级物理 · 九月月考卷');
    // pill 文案复用 PAPER_STATUS_LABEL 全应用口径（done='已定稿'，设计稿 mock 写的「已完成」为示意语）
    const pills = qa('.home-v3 .pcard .st-pill').map((el) => el.textContent);
    expect(pills).toEqual(['排版中', '已定稿', '已定稿']);
    expect(qa('.home-v3 .pcard .st-pill')[0]!.className).toContain('yellow');
    expect(qa('.home-v3 .pcard .st-pill')[1]!.className).toContain('green');
    expect(cards[0]!.textContent).toContain('24 题');
  });

  it('单卡落点沿用试卷管理页口径：试题篮→#/basket/:id，其余→#/compose/:id', async () => {
    injectGuardFake(async () => dashFixture({
      recentPapers: [
        { id: 'p-basket', title: '草稿卷', status: 'basket', questionCount: 3, updatedAt: agoIso(0, 9, 0) },
        { id: 'p-done', title: '定稿卷', status: 'done', questionCount: 8, updatedAt: agoIso(2) },
      ],
    }));
    render();
    await waitFor(() => {
      if (qa('.home-v3 .pcard').length !== 2) throw new Error('最近试卷未渲染齐');
    });
    flushSync(() => (q('[data-testid="home-recent-p-basket"]') as HTMLElement).click());
    expect(window.location.hash).toBe('#/basket/p-basket');
    window.location.hash = '';
    flushSync(() => (q('[data-testid="home-recent-p-done"]') as HTMLElement).click());
    expect(window.location.hash).toBe('#/compose/p-done');
  });

  it('「查看全部 →」跳 #/papers', async () => {
    injectGuardFake(async () => dashFixture());
    render();
    await waitFor(() => {
      if (!q('[data-testid="home-recent-more"]')) throw new Error('查看全部未渲染');
    });
    flushSync(() => (q('[data-testid="home-recent-more"]') as HTMLButtonElement).click());
    expect(window.location.hash).toBe('#/papers');
  });

  it('无试卷：整区不渲染', async () => {
    injectGuardFake(async () => dashFixture({ recentPapers: [] }));
    render();
    await waitFor(() => {
      if (!q('[data-testid="home-footprint"]')) throw new Error('足迹卡未渲染');
    });
    expect(q('[data-testid="home-recent-papers"]')).toBeNull();
  });

  it('相对时间：刚刚 / N 分钟前 / N 小时前 / 昨天 HH:MM / M/D（纯函数，固定 now）', () => {
    const now = new Date(2026, 8, 21, 15, 30);
    const at = (d: number, h: number, m: number) => new Date(2026, 8, 21 - d, h, m).toISOString();
    expect(relativeTime(at(0, 15, 30), now)).toBe('刚刚');
    expect(relativeTime(at(0, 15, 5), now)).toBe('25 分钟前');
    expect(relativeTime(at(0, 10, 0), now)).toBe('5 小时前');
    expect(relativeTime(at(1, 20, 10), now)).toBe('昨天 20:10');
    expect(relativeTime(at(5, 9, 0), now)).toBe('9/16');
  });
});

describe('0049 P3-7：三态（满数据 / 低数据 / 空库）', () => {
  it('满数据态：无低数据提示条', async () => {
    injectGuardFake(async () => dashFixture());
    render();
    await waitFor(() => {
      if (!q('[data-testid="home-footprint"]')) throw new Error('足迹卡未渲染');
    });
    expect(q('.home-v3 .notice-warm')).toBeNull();
    expect(q('.home-v3 .heat-empty-veil')).toBeNull();
  });

  it('低数据态：半年动作 <100 且题库 <50 → 足迹卡顶部 notice-warm 提示条', async () => {
    injectGuardFake(async () => dashFixture({ questions: 18, papers: 2, documentsRecognized: 3, mistakeRecords: 0 }));
    render();
    await waitFor(() => {
      if (!q('.home-v3 .notice-warm')) throw new Error('低数据提示条未渲染');
    });
    expect(q('[data-testid="home-footprint"] .notice-warm')!.textContent).toContain('数据还不多');
    // 低数据态仍渲染足迹主体（不是空库）
    expect(q('.home-v3 .hcell')).toBeTruthy();
    expect(q('[data-testid="home-dash-stats"]')).toBeTruthy();
  });

  it('低数据阈值边界：题库 ≥50 或动作 ≥100 均不再提示（两条件须同时满足）', async () => {
    injectGuardFake(async () => dashFixture({ questions: 50 }));
    render();
    await waitFor(() => {
      if (!q('[data-testid="home-footprint"]')) throw new Error('足迹卡未渲染');
    });
    expect(q('.home-v3 .notice-warm')).toBeNull();
  });

  it('空库态：资产区整区换引导 hero（stand 96 + 两按钮）+ 灰格 veil + 无 🔥 + 无最近试卷', async () => {
    injectGuardFake(async () => dashFixture({
      questions: 0, papers: 0, documentsRecognized: 0, mistakeRecords: 0, aiInvocations: 0, aiTokens: 0,
      activity: workWindowKeys(FIX_END).map((date) => ({
        date,
        byCategory: { proof: 0, capture: 0, compose: 0, mistake: 0, feedback: 0, ai: 0 },
        tokens: 0,
      })),
      streak: { current: 0, longest: 0 },
      questionGrowth: workWindowKeys(FIX_END).map((date) => ({ date, total: 0 })),
      recentPapers: [],
    }));
    render();
    await waitFor(() => {
      if (!q('[data-testid="home-empty-hero"]')) throw new Error('空库引导态未渲染');
    });
    expect(q('[data-testid="home-dash-stats"]'), '空库时不得渲染数字统计区').toBeNull();
    const stand = q('[data-testid="home-empty-hero"] [data-mascot="stand"]') as HTMLImageElement | null;
    expect(stand, '空库引导小方 stand 未渲染').toBeTruthy();
    expect(stand!.getAttribute('height')).toBe('96');
    expect(q('[data-testid="home-empty-capture-btn"]')!.textContent).toContain('去采集题目');
    expect(q('[data-testid="home-empty-proof-btn"]')!.textContent).toContain('录一道题');
    // 足迹卡：灰格 + 中央虚线提示 + 不显示总数/图例/AI 行
    expect(q('.home-v3 .heat-empty-veil')!.textContent).toContain('还没有足迹');
    expect(q('[data-testid="home-footprint-total"]')).toBeNull();
    expect(q('.home-v3 .flow-bottom')).toBeNull();
    expect(q('.home-v3 .notice-warm')).toBeNull(); // 空库不叠低数据提示
    // 🔥 与最近试卷不显示
    expect(q('[data-testid="home-streak"]')).toBeNull();
    expect(q('[data-testid="home-recent-papers"]')).toBeNull();
    // 满格灰：全部 level 0
    expect(qa<HTMLElement>('.home-v3 .hcell').every((c) => c.dataset.level === '0')).toBe(true);
  });

  it('空库引导两按钮落点：#/capture、#/proof', async () => {
    injectGuardFake(async () => dashFixture({
      questions: 0,
      activity: workWindowKeys(FIX_END).map((date) => ({
        date,
        byCategory: { proof: 0, capture: 0, compose: 0, mistake: 0, feedback: 0, ai: 0 },
        tokens: 0,
      })),
      streak: { current: 0, longest: 0 },
      questionGrowth: workWindowKeys(FIX_END).map((date) => ({ date, total: 0 })),
      recentPapers: [],
    }));
    render();
    await waitFor(() => {
      if (!q('[data-testid="home-empty-hero"]')) throw new Error('空库引导态未渲染');
    });
    flushSync(() => (q('[data-testid="home-empty-capture-btn"]') as HTMLButtonElement).click());
    expect(window.location.hash).toBe('#/capture');
    flushSync(() => (q('[data-testid="home-empty-proof-btn"]') as HTMLButtonElement).click());
    expect(window.location.hash).toBe('#/proof');
  });

  it('🔥 连续天数：current>0 显示且 title=最长；current=0 不显示', async () => {
    injectGuardFake(async () => dashFixture({ streak: { current: 6, longest: 11 } }));
    render();
    await waitFor(() => {
      if (!q('[data-testid="home-streak"]')) throw new Error('🔥 徽章未渲染');
    });
    const badge = q('[data-testid="home-streak"]')!;
    expect(badge.textContent).toContain('连续 6 天');
    expect(badge.getAttribute('title')).toContain('11');
    // 断档（今日无动作 → 服务端给 current=0）→ 徽章撤下
    root?.unmount();
    container?.remove();
    injectGuardFake(async () => dashFixture({ streak: { current: 0, longest: 11 } }));
    render();
    await waitFor(() => {
      if (!q('[data-testid="home-footprint"]')) throw new Error('足迹卡未渲染');
    });
    expect(q('[data-testid="home-streak"]')).toBeNull();
  });

  it('数据未就绪（桥缺失）仍渲染页头与快捷入口（0037 兼容）', async () => {
    render();
    await waitFor(() => {
      if (qa('.home-v3 .qentry').length !== 4) throw new Error('入口卡未渲染');
    });
    expect(q('.home-v3 .hero h1')!.textContent).toContain('工作台');
    expect(q('[data-testid="home-today"]')).toBeTruthy();
    expect(q('[data-testid="home-dash-stats"]')).toBeNull();
    expect(q('[data-testid="home-footprint"]')).toBeNull();
  });
});

describe('0049 P3-8：小方与口径提示', () => {
  it('说明性文字收进 ⓘ tooltip（资产/足迹/四指标/增长/AI 各一枚）', async () => {
    injectGuardFake(async () => dashFixture());
    render();
    await waitFor(() => {
      if (qa('.home-v3 .info-tip .itip').length === 0) throw new Error('tooltip 未渲染');
    });
    const tips = qa('.home-v3 .info-tip .itip').map((el) => el.textContent ?? '');
    expect(tips.length).toBeGreaterThanOrEqual(6);
    const all = tips.join('\n');
    expect(all).toContain('不含回收站');
    expect(all).toContain('识别记录');
    expect(all).toContain('学生×题');
    expect(all).toContain('operation_log');
    expect(all).toContain('未返回');
    // 足迹口径说明不得声称含导出（D-068 挂账：导出/打印留痕不在本单）
    expect(all).not.toContain('导出');
  });
});
