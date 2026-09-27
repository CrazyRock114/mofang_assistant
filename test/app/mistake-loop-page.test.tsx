// 0026 P1-P4：错题本页（两栏 + 题库式题卡 + 悬浮试题篮）组件测试 — jsdom，Mock (in-memory) 单跑。
// 覆盖任务书 §四：聚合展示一致性（与 0025 数据口逐字段一致）/ 学生状态分布（红黄绿按学生）/
// 显式入篮与移出 / 勾选批量参数 / D1 加入试题篮 / D3 Top N 参数化 / P4 成册（卷头 + PDF payload）。
// 真桥（真实 IpcExtClient）侧由 test/app/mistake-loop-ext-wiring.test.tsx 覆盖；
// 真库（SQLite）侧由 test/bank/mistake-loop-derive.test.ts 双跑。
// @vitest-environment jsdom

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import { MockBankService } from '../../src/bank/mock/mock-bank.js';
import { createMockExtServices } from '../../src/bank/mock/mock-ext.js';
import { MockBankStore } from '../../src/bank/mock/mock-store.js';
import { MistakesPage } from '../../src/app/pages/MistakesPage.js';
import {
  classMistakeTitle, describeWrongCount, mistakeBookHeaderLines, mistakeBookTitle, weekWindow,
} from '../../src/app/pages/mistake-loop.js';
import type { ExtPageServices } from '../../src/app/pages/ExtUi.js';
import type {
  BankService, BankExtServices, ClassInfo, Question, Student,
} from '../../src/shared/contracts/bank-types.js';

// ---------------- 测试世界（固定数据集：3 生 × 4 题部分重叠 + 班外 1 生 + 窗口外 1 题） ----------------

interface World {
  bank: BankService;
  ext: BankExtServices;
  store: MockBankStore;
  svc: ExtPageServices;
  clazz: ClassInfo;
  wang: Student;
  zhang: Student;
  li: Student;
  zhao: Student;
  q1: Question;
  q2: Question;
  q3: Question;
  q4: Question;
  q5: Question;
  window: { from: string; to: string };
  inWeekMon: string;
  inWeekSun: string;
}

async function makeQuestion(bank: BankService, subject: string, stem: string, extra: Partial<Question> = {}): Promise<Question> {
  return bank.createQuestion({
    subject,
    sourceType: 'local',
    sourceDetail: { origin: 'test' },
    content: `<div class="question">${stem}</div>`,
    stemHtml: `<div class="question">${stem}</div>`,
    images: [],
    ...extra,
  });
}

async function seedWorld(): Promise<World> {
  const store = new MockBankStore();
  // seedSampleData=false：本文件用固定数据集（播种的示例卷会混进篮子搜索与列表）
  const bank = new MockBankService(store, false);
  const ext = createMockExtServices(store);

  const clazz = await ext.class.createClass({ name: '初二一班' });
  const wang = await ext.student.createStudent({ name: '王小明', studentNo: 'S001' });
  const zhang = await ext.student.createStudent({ name: '张三' });
  const li = await ext.student.createStudent({ name: '李四' });
  const zhao = await ext.student.createStudent({ name: '赵六' }); // 无班级（班外）
  for (const s of [wang, zhang, li]) await ext.student.enrollStudent(s.id, clazz.id);

  const q1 = await makeQuestion(bank, '物理', '自由落体求落地速度', { answer: '<p>v = gt</p>', analysis: '<p>匀加速</p>' });
  const q2 = await makeQuestion(bank, '物理', '牛顿第二定律应用', { questionType: '选择题', difficulty: 3 });
  const q3 = await makeQuestion(bank, '物理', '动量守恒判断');
  const q4 = await makeQuestion(bank, '化学', '氧化还原配平');
  const q5 = await makeQuestion(bank, '物理', '窗口外旧错题');

  const now = new Date();
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  const y = monday.getFullYear(); const m = `${monday.getMonth() + 1}`.padStart(2, '0'); const d = `${monday.getDate()}`.padStart(2, '0');
  const inWeekMon = `${y}-${m}-${d}T10:00:00.000Z`;
  const inWeekSun = `${y}-${m}-${d}T10:00:00.000Z`;

  await ext.mistake.recordWrong({ questionId: q1.id, studentId: wang.id, occurredAt: inWeekMon });
  await ext.mistake.recordWrong({ questionId: q1.id, studentId: zhang.id, occurredAt: inWeekSun });
  await ext.mistake.recordWrong({ questionId: q2.id, studentId: wang.id, occurredAt: inWeekMon });
  await ext.mistake.recordWrong({ questionId: q2.id, studentId: zhang.id, occurredAt: inWeekMon });
  await ext.mistake.recordWrong({ questionId: q2.id, studentId: li.id, occurredAt: inWeekSun });
  await ext.mistake.recordWrong({ questionId: q2.id, studentId: zhao.id, occurredAt: inWeekMon }); // 班外
  await ext.mistake.recordWrong({ questionId: q3.id, studentId: zhang.id, occurredAt: inWeekMon });
  await ext.mistake.recordWrong({ questionId: q4.id, studentId: wang.id, occurredAt: inWeekMon });
  await ext.mistake.recordWrong({ questionId: q5.id, studentId: li.id, occurredAt: '2026-08-01T10:00:00.000Z' });

  const window_ = weekWindow(now);
  return { bank, ext, store, svc: { bank, ext }, clazz, wang, zhang, li, zhao, q1, q2, q3, q4, q5, window: window_, inWeekMon, inWeekSun };
}

// ---------------- 渲染与交互助手 ----------------

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  flushSync(() => root?.unmount());
  container.remove();
  delete window.__mofangBank;
  window.location.hash = '';
});

function render(element: ReactElement) {
  root = createRoot(container);
  flushSync(() => root.render(element));
}

function el(selector: string): HTMLElement {
  const node = container.querySelector(selector);
  if (!node) throw new Error(`找不到 ${selector}：${container.innerHTML.slice(0, 300)}`);
  return node as HTMLElement;
}

function clickEl(selector: string) {
  flushSync(() => el(selector).click());
}

function keyOn(selector: string, key: string, ctrlKey = false) {
  flushSync(() => el(selector).dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey, bubbles: true })));
}

function setInput(selector: string, value: string) {
  const input = el(selector) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function setSelect(selector: string, value: string) {
  const select = el(selector) as HTMLSelectElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  setter.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

async function waitFor(assertion: () => void) {
  await vi.waitFor(assertion, { timeout: 3000, interval: 20 });
}

/** 卡片 id 序（data-wrong-count 只挂在卡片根上，不会误收内部子节点） */
function cardIds(): string[] {
  return [...container.querySelectorAll('[data-testid^="mistake-card-"]')]
    .filter((node) => node.hasAttribute('data-wrong-count'))
    .map((node) => node.getAttribute('data-testid')!.replace('mistake-card-', ''));
}

async function renderPage(world: World) {
  render(<MistakesPage services={world.svc} />);
  await waitFor(() => {
    if (container.querySelectorAll('[data-testid^="mistake-card-"]').length === 0) throw new Error('题卡列表未渲染');
  });
}

/** 打开右侧悬浮试题篮抽屉（面板默认收起） */
function openBasketDrawer() {
  if (!container.querySelector('[data-testid="mistake-basket-panel"]')) clickEl('[data-testid="mistake-basket-toggle"]');
}

// ---------------- P1：两栏骨架 + 聚合展示 ----------------

describe('0026 P1：错题本两栏（左控件栏 / 右题卡列表）+ 悬浮试题篮', () => {
  let world: World;

  beforeEach(async () => { localStorage.clear(); world = await seedWorld(); });

  it('两栏骨架：左控件栏 + 右题卡列表 + 右侧悬浮篮（无错题也常驻）', async () => {
    render(<MistakesPage services={{ bank: world.bank, ext: world.ext }} />);
    await waitFor(() => expect(container.querySelector('[data-testid="mistakes-page"]')).toBeTruthy());
    expect(container.querySelector('[data-testid="mistake-filter-panel"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="mistake-basket-toggle"]')).toBeTruthy();
    // 悬浮篮默认收起（不占屏），点击后展开抽屉
    expect(container.querySelector('[data-testid="mistake-basket-panel"]')).toBeNull();
    openBasketDrawer();
    expect(container.querySelector('[data-testid="mistake-basket-panel"]')).toBeTruthy();
  });

  it('题卡显示完整题面（与题库同管线）+ 人次 + 元信息', async () => {
    await renderPage(world);
    const scope = { studentIds: [world.wang.id, world.zhang.id, world.li.id], occurredFrom: world.window.from, occurredTo: world.window.to };
    const expected = await world.ext.mistake.aggregateByQuestion(scope);

    // 人次数降序：q2(3) > q1(2) > {q3,q4}(1)；与数据口次序逐位一致
    expect(cardIds()).toEqual(expected.map((row) => row.questionId));
    expect(cardIds()[0]).toBe(world.q2.id);

    for (const row of expected) {
      const node = el(`[data-testid="mistake-card-${row.questionId}"]`);
      expect(node.getAttribute('data-wrong-count')).toBe(String(row.wrongCount));
      expect(el(`[data-testid="mistake-wrongcount-${row.questionId}"]`).textContent).toBe(describeWrongCount(row.wrongCount, 3));
    }
    // 文案形态：错 3/3 人 / 错 2/3 人
    expect(el(`[data-testid="mistake-wrongcount-${world.q2.id}"]`).textContent).toBe('错 3/3 人');
    expect(el(`[data-testid="mistake-wrongcount-${world.q1.id}"]`).textContent).toBe('错 2/3 人');

    // 完整题面（不是 80 字摘要）：题干全文在卡片里（异步装载，等 .question 节点出现）
    await waitFor(() => {
      const stem = el(`[data-testid="mistake-stem-${world.q1.id}"]`);
      if (!stem.querySelector('div.question')) throw new Error('完整题面未装载');
    });
    const stem = el(`[data-testid="mistake-stem-${world.q1.id}"]`);
    expect(stem.textContent).toContain('自由落体求落地速度');

    // 辅助信息：题型/难度（q2 有）
    const q2Card = el(`[data-testid="mistake-card-${world.q2.id}"]`);
    expect(q2Card.textContent).toContain('选择题');
    expect(q2Card.textContent).toContain('中等');
  });

  it('学生状态分布：红黄绿按**学生**算（未掌握 N / 订正过 N / 已掌握 N），随数据实时变', async () => {
    await renderPage(world);
    // 默认全班在册学生都未订正 → q2 三人全红
    expect(el(`[data-testid="mistake-stages-${world.q2.id}"]`).textContent).toContain('未掌握 3');
    expect(el(`[data-testid="mistake-stages-${world.q2.id}"]`).textContent).not.toContain('订正过');

    // 张三的 q2 改成「订正过」（黄）→ 分布变 未掌握 2 / 订正过 1
    const zhangRow = [...world.store.mistakes.values()].find((m) => m.questionId === world.q2.id && m.studentId === world.zhang.id)!;
    await world.ext.mistake.setStage(zhangRow.id, 'yellow');
    setSelect('[data-testid="mistake-subject-filter"]', '化学'); // 触发一次重查
    await waitFor(() => expect(cardIds()).toEqual([world.q4.id]));
    setSelect('[data-testid="mistake-subject-filter"]', '');
    await waitFor(() => {
      const chips = el(`[data-testid="mistake-stages-${world.q2.id}"]`).textContent ?? '';
      if (!chips.includes('未掌握 2') || !chips.includes('订正过 1')) throw new Error(`状态分布未更新：${chips}`);
    });
  });

  it('按学生状态筛选：只算该状态的学生（红=未掌握）；筛完的空态可见', async () => {
    await renderPage(world);
    setSelect('[data-testid="mistake-stage-filter"]', 'yellow');
    await waitFor(() => expect(container.querySelector('[data-testid="mistakes-empty"]')).toBeTruthy());
    setSelect('[data-testid="mistake-stage-filter"]', 'red');
    await waitFor(() => expect(cardIds().sort()).toEqual([world.q1.id, world.q2.id, world.q3.id, world.q4.id].sort()));
  });

  it('默认筛选=本周+本班：窗口外错题(q5)不显示；班外学生(赵六)不计入人次与分母', async () => {
    await renderPage(world);
    expect((el('[data-testid="mistake-from-input"]') as HTMLInputElement).value).toBe(world.window.from);
    expect((el('[data-testid="mistake-to-input"]') as HTMLInputElement).value).toBe(world.window.to);
    expect((el('[data-testid="mistake-class-filter"]') as HTMLSelectElement).value).toBe(world.clazz.id);

    expect(cardIds()).not.toContain(world.q5.id);
    expect(el(`[data-testid="mistake-wrongcount-${world.q2.id}"]`).textContent).toBe('错 3/3 人');
  });

  it('切「全部班级」：班外学生计入（q2 变 4 人、分母 4）；清空时间窗：窗口外 q5 出现', async () => {
    await renderPage(world);
    setSelect('[data-testid="mistake-class-filter"]', '');
    await waitFor(() => expect(el(`[data-testid="mistake-wrongcount-${world.q2.id}"]`).textContent).toBe('错 4/4 人'));

    setInput('[data-testid="mistake-from-input"]', '');
    setInput('[data-testid="mistake-to-input"]', '');
    await waitFor(() => expect(cardIds()).toContain(world.q5.id));
    expect(cardIds()[0]).toBe(world.q2.id);
  });

  it('按学生筛选：只列该生错题，分母=1；学科筛选与选项并集保持', async () => {
    await renderPage(world);
    setSelect('[data-testid="mistake-student-filter"]', world.zhang.id);
    await waitFor(() => {
      expect(cardIds().sort()).toEqual([world.q1.id, world.q2.id, world.q3.id].sort());
    });
    expect(el(`[data-testid="mistake-wrongcount-${world.q2.id}"]`).textContent).toBe('错 1/1 人');

    setSelect('[data-testid="mistake-student-filter"]', '');
    await waitFor(() => expect(cardIds().length).toBe(4));
    setSelect('[data-testid="mistake-subject-filter"]', '化学');
    await waitFor(() => expect(cardIds()).toEqual([world.q4.id]));
    // 学科选项单调并集：切到化学后仍能切回物理
    expect([...(el('[data-testid="mistake-subject-filter"]') as HTMLSelectElement).options].map((o) => o.value)).toContain('物理');
  });

  it('左栏时间窗：起/止上下排列（并排时日期框显示不全）', async () => {
    await renderPage(world);
    const stack = container.querySelector('[data-testid="mistake-from-input"]')!.closest('.m-window-fields');
    expect(stack).not.toBeNull();
    // 两个日期框同在一个纵向容器里，且各带「起」「止」标签
    const fields = stack!.querySelectorAll('.m-window-field');
    expect(fields.length).toBe(2);
    expect(fields[0].querySelector('input')!.getAttribute('data-testid')).toBe('mistake-from-input');
    expect(fields[1].querySelector('input')!.getAttribute('data-testid')).toBe('mistake-to-input');
    expect(Array.from(fields).map((f) => f.querySelector('span')!.textContent).join('')).toBe('起止');
  });

  it('分页：小数据集只有 1 页，两个翻页钮均禁用且显示页码', async () => {
    await renderPage(world);
    expect(el('[data-testid="mistake-prev-page"]').textContent ?? '').toBe('上一页');
    expect((el('[data-testid="mistake-prev-page"]') as HTMLButtonElement).disabled).toBe(true);
    expect((el('[data-testid="mistake-next-page"]') as HTMLButtonElement).disabled).toBe(true);
    expect(container.textContent).toContain('第 1 / 1 页');
  });
});

// ---------------- P1：入篮 / 移出 / 详情 / 批量 ----------------

describe('0026 P1：显式入篮（按钮变移出）+ 详情 + 勾选批量', () => {
  let world: World;

  beforeEach(async () => { localStorage.clear(); world = await seedWorld(); });

  it('卡片按钮 = 加入试题篮（落 papers 篮）；加入后按钮变「移出试题篮」且再点不重复加', async () => {
    await renderPage(world);
    expect(container.querySelector(`[data-testid="mistake-basket-add-${world.q2.id}"]`)).toBeTruthy();
    clickEl(`[data-testid="mistake-basket-add-${world.q2.id}"]`);
    await waitFor(() => expect(el('[data-testid="mistake-basket-count"]').textContent).toBe('1'));

    const basketId = [...world.store.papers.values()].find((p) => (p.status ?? 'basket') === 'basket')!.id;
    const refs = await world.bank.getPaperQuestions(basketId);
    expect(refs.map((r) => r.questionId)).toEqual([world.q2.id]);

    // 按钮换成移出（不再有「加入」钮）；卡片标记 in-basket
    await waitFor(() => expect(container.querySelector(`[data-testid="mistake-basket-add-${world.q2.id}"]`)).toBeNull());
    expect(container.querySelector(`[data-testid="mistake-basket-remove-${world.q2.id}"]`)).toBeTruthy();
    expect(el(`[data-testid="mistake-card-${world.q2.id}"]`).getAttribute('data-in-basket')).toBe('true');
  });

  it('点卡片空白处不入篮（入篮只走按钮）', async () => {
    await renderPage(world);
    clickEl(`[data-testid="mistake-stem-${world.q2.id}"]`);
    clickEl(`[data-testid="mistake-card-${world.q2.id}"]`);
    await waitFor(() => expect(el('[data-testid="mistake-basket-count"]').textContent).toBe('0'));
  });

  it('移出：卡片按钮移出 + 抽屉内移出；清空回到 0', async () => {
    await renderPage(world);
    clickEl(`[data-testid="mistake-basket-add-${world.q1.id}"]`);
    clickEl(`[data-testid="mistake-basket-add-${world.q2.id}"]`);
    await waitFor(() => expect(el('[data-testid="mistake-basket-count"]').textContent).toBe('2'));

    openBasketDrawer();
    await waitFor(() => expect(container.querySelector(`[data-testid="mistake-basket-item-${world.q1.id}"]`)).toBeTruthy());
    clickEl(`[data-testid="mistake-basket-item-remove-${world.q1.id}"]`);
    await waitFor(() => expect(el('[data-testid="mistake-basket-count"]').textContent).toBe('1'));

    // 再用卡片上的「移出试题篮」把剩下那道移掉 → 按钮切回「加入试题篮」
    clickEl(`[data-testid="mistake-basket-remove-${world.q2.id}"]`);
    await waitFor(() => expect(el('[data-testid="mistake-basket-count"]').textContent).toBe('0'));
    expect(container.querySelector(`[data-testid="mistake-basket-add-${world.q2.id}"]`)).toBeTruthy();

    // 清空按钮在篮空时禁用，故再加一道再清（两步确认）
    clickEl(`[data-testid="mistake-basket-add-${world.q2.id}"]`);
    await waitFor(() => expect(el('[data-testid="mistake-basket-count"]').textContent).toBe('1'));
    clickEl('[data-testid="mistake-basket-clear-btn"]');
    flushSync(() => [...container.querySelectorAll('button')].find((b) => b.textContent === '确认清空')!.click());
    await waitFor(() => expect(el('[data-testid="mistake-basket-count"]').textContent).toBe('0'));
  });

  it('查看详情按钮 = 详情弹层：快照可读 + 按生明细（三色灯/备注/删除均在详情内）', async () => {
    await renderPage(world);
    clickEl(`[data-testid="mistake-detail-btn-${world.q2.id}"]`);
    await waitFor(() => expect(container.querySelector('[data-testid="mistake-detail-modal"]')).toBeTruthy());
    // 按生明细异步装载：等三名在册学生的行出现
    await waitFor(() => {
      for (const name of ['王小明', '张三', '李四']) {
        if (!container.querySelector(`[data-testid="mistake-detail-row-${name}"]`)) throw new Error(`详情缺 ${name}`);
      }
    });
    // 班外学生不入详情（赵六不在本班）
    expect(container.querySelector('[data-testid="mistake-detail-row-赵六"]')).toBeNull();
    expect(el('[data-testid="mistake-snapshot"]').textContent).toContain('牛顿第二定律应用');

    // 详情内改状态：张三 红→黄（U2 既有能力保留）
    setSelect('[data-testid="mistake-stage-select-张三"]', 'yellow');
    await waitFor(() => {
      const rows = [...world.store.mistakes.values()].filter((m) => m.questionId === world.q2.id && m.studentId === world.zhang.id);
      expect(rows[0].stage).toBe('yellow');
    });

    // 详情内备注保存
    setInput('[data-testid="mistake-note-input-李四"]', '二次订正仍未掌握');
    clickEl('[data-testid="mistake-note-save-btn-李四"]');
    await waitFor(() => {
      const rows = [...world.store.mistakes.values()].filter((m) => m.questionId === world.q2.id && m.studentId === world.li.id);
      expect(rows[0].note).toBe('二次订正仍未掌握');
    });

    // 详情内删除（两步确认）→ 该生行消失
    clickEl('[data-testid="mistake-delete-btn-李四"]');
    flushSync(() => [...container.querySelectorAll('button')].find((b) => b.textContent === '确认删除')!.click());
    await waitFor(() => expect(container.querySelector('[data-testid="mistake-detail-row-李四"]')).toBeNull());
  });

  it('勾选 + 批量改状态：只作用于当前筛选内的错题行（班外/窗口外不动），operation_log 留痕', async () => {
    await renderPage(world);
    clickEl(`[data-testid="mistake-select-${world.q1.id}"]`);
    clickEl(`[data-testid="mistake-select-${world.q2.id}"]`);
    await waitFor(() => expect(el('[data-testid="mistake-batch-bar"]').getAttribute('data-selected-count')).toBe('2'));

    setSelect('[data-testid="mistake-batch-stage-select"]', 'green');
    clickEl('[data-testid="mistake-batch-apply-btn"]');
    await waitFor(() => {
      const scoped = [...world.store.mistakes.values()].filter((m) => m.questionId === world.q1.id || m.questionId === world.q2.id);
      expect(scoped.every((m) => m.stage === 'green')).toBe(false); // 班外的赵六 q2 行仍红
      const inClass = scoped.filter((m) => m.studentId !== world.zhao.id);
      expect(inClass.length).toBe(5);
      expect(inClass.every((m) => m.stage === 'green')).toBe(true);
    });
    expect(world.store.logs.some((l) => l.type === 'mistake.batchSetStage' && l.affectedCount === 5)).toBe(true);
  });

  it('勾选 + 批量删除：删掉筛选内 5 行，列表随之收起且班外行保留', async () => {
    await renderPage(world);
    clickEl(`[data-testid="mistake-select-${world.q1.id}"]`);
    clickEl(`[data-testid="mistake-select-${world.q2.id}"]`);
    await waitFor(() => expect(el('[data-testid="mistake-batch-bar"]').getAttribute('data-selected-count')).toBe('2'));

    clickEl('[data-testid="mistake-batch-delete-btn"]');
    flushSync(() => [...container.querySelectorAll('button')].find((b) => b.textContent === '确认删除')!.click());
    await waitFor(() => expect(cardIds().sort()).toEqual([world.q3.id, world.q4.id].sort()));

    expect(world.store.logs.some((l) => l.type === 'mistake.batchDelete' && l.affectedCount === 5)).toBe(true);
    const zhaoRow = [...world.store.mistakes.values()].find((m) => m.studentId === world.zhao.id);
    expect(zhaoRow?.questionId).toBe(world.q2.id); // 班外行未被波及
  });

  it('键盘流：↑↓ 移动游标、Space 勾选、Enter 看详情（入篮不再是隐式键盘动作）', async () => {
    await renderPage(world);
    keyOn('[data-testid="mistake-card-list"]', 'ArrowDown');
    await waitFor(() => expect(el(`[data-testid="mistake-card-${world.q2.id}"]`).getAttribute('data-active')).toBe('true'));
    keyOn('[data-testid="mistake-card-list"]', 'ArrowDown');
    await waitFor(() => expect(el(`[data-testid="mistake-card-${world.q1.id}"]`).getAttribute('data-active')).toBe('true'));

    keyOn('[data-testid="mistake-card-list"]', ' ');
    await waitFor(() => expect(el(`[data-testid="mistake-card-${world.q1.id}"]`).getAttribute('data-selected')).toBe('true'));
    // 空格只勾选，不入篮
    expect(el('[data-testid="mistake-basket-count"]').textContent).toBe('0');

    keyOn('[data-testid="mistake-card-list"]', 'Enter');
    await waitFor(() => expect(container.querySelector('[data-testid="mistake-detail-modal"]')).toBeTruthy());
    expect(el('[data-testid="mistake-basket-count"]').textContent).toBe('0');
  });
});

// ---------------- P2：D1 / D3 出卷联动 ----------------

describe('0026 P2：D1 加入试题篮 / D3 按错误人次 Top N 出卷', () => {
  let world: World;

  beforeEach(async () => { localStorage.clear(); world = await seedWorld(); });

  it('D1：篮 →「并入既有试题篮」（去重）并跳组卷', async () => {
    const target = await world.bank.createPaper('我的试题篮');
    await world.bank.addQuestion(target.id, world.q3.id, 5);

    await renderPage(world);
    clickEl(`[data-testid="mistake-basket-add-${world.q2.id}"]`);
    await waitFor(() => expect(el('[data-testid="mistake-basket-count"]').textContent).toBe('1'));
    openBasketDrawer();

    // 目标篮选项：既有篮在列（本篮自身不在列）
    const options = [...(el('[data-testid="mistake-basket-target-select"]') as HTMLSelectElement).options].map((o) => o.value);
    expect(options).toContain(target.id);

    setSelect('[data-testid="mistake-basket-target-select"]', target.id);
    clickEl('[data-testid="mistake-basket-merge-btn"]');
    await waitFor(() => expect(window.location.hash).toBe(`#/basket/${target.id}`));

    const refs = await world.bank.getPaperQuestions(target.id);
    expect(refs.map((r) => r.questionId)).toEqual([world.q3.id, world.q2.id]);
  });

  it('D1：篮 →「去组卷」直达本篮（篮本身即一张 papers 卷）', async () => {
    await renderPage(world);
    clickEl(`[data-testid="mistake-basket-add-${world.q1.id}"]`);
    await waitFor(() => expect(el('[data-testid="mistake-basket-count"]').textContent).toBe('1'));
    openBasketDrawer();

    clickEl('[data-testid="mistake-basket-open-btn"]');
    const basketId = [...world.store.papers.values()].find((p) => (p.status ?? 'basket') === 'basket')!.id;
    expect(window.location.hash).toBe(`#/basket/${basketId}`);
  });

  it('D1：无既有篮 →「并入新建试题篮」建新篮并跳转', async () => {
    await renderPage(world);
    clickEl(`[data-testid="mistake-basket-add-${world.q1.id}"]`);
    await waitFor(() => expect(el('[data-testid="mistake-basket-count"]').textContent).toBe('1'));
    openBasketDrawer();

    setSelect('[data-testid="mistake-basket-target-select"]', '__new__');
    clickEl('[data-testid="mistake-basket-merge-btn"]');
    await waitFor(() => expect(window.location.hash.startsWith('#/basket/')).toBe(true));

    const newId = window.location.hash.replace('#/basket/', '');
    const refs = await world.bank.getPaperQuestions(newId);
    expect(refs.map((r) => r.questionId)).toEqual([world.q1.id]);
  });

  it('D3：Top N 一键出卷 = 班级筛选 → id 集（0025 导出口）→ 前 N 入新篮 → 跳组卷', async () => {
    await renderPage(world);
    setInput('[data-testid="mistake-topn-input"]', '2');
    clickEl('[data-testid="mistake-topn-btn"]');

    const classScope = {
      studentIds: [world.wang.id, world.zhang.id, world.li.id],
      occurredFrom: world.window.from, occurredTo: world.window.to,
    };
    const expectedIds = (await world.ext.mistake.exportQuestionIds(classScope)).slice(0, 2);
    expect(expectedIds).toEqual([world.q2.id, world.q1.id]);

    await waitFor(() => expect(window.location.hash.startsWith('#/basket/')).toBe(true));
    const newId = window.location.hash.replace('#/basket/', '');
    const paper = await world.ext.paper.getPaperEx(newId);
    expect(paper?.title).toBe(classMistakeTitle('初二一班', 2));
    const refs = await world.bank.getPaperQuestions(newId);
    expect(refs.map((r) => r.questionId)).toEqual(expectedIds);
  });

  it('D3：忽略单生筛选（班级错题集=整班一份），单生筛选下出卷仍是全班 Top N', async () => {
    await renderPage(world);
    setSelect('[data-testid="mistake-student-filter"]', world.li.id);
    await waitFor(() => expect(cardIds()).toEqual([world.q2.id]));
    setInput('[data-testid="mistake-topn-input"]', '1');
    clickEl('[data-testid="mistake-topn-btn"]');
    await waitFor(() => expect(window.location.hash.startsWith('#/basket/')).toBe(true));

    const refs = await world.bank.getPaperQuestions(window.location.hash.replace('#/basket/', ''));
    expect(refs.map((r) => r.questionId)).toEqual([world.q2.id]);
  });
});

// ---------------- P4：错题本成册（退一级：生成卷 → 送到组卷） ----------------

describe('0026 P4：错题本成册（目检返工二：送到组卷，不替用户定稿/导出）', () => {
  let world: World;

  beforeEach(async () => { localStorage.clear(); world = await seedWorld(); });

  it('选生 → 一键成册到组卷：卷头带学生名/时间窗/题量，卷面题=该生错题集，状态=排版中且跳组卷', async () => {
    await renderPage(world);
    setSelect('[data-testid="mistake-student-filter"]', world.wang.id);
    await waitFor(() => expect(cardIds().sort()).toEqual([world.q1.id, world.q2.id, world.q4.id].sort()));

    clickEl('[data-testid="mistake-book-btn"]');
    await waitFor(() => expect(window.location.hash.startsWith('#/basket/')).toBe(true));

    const paperId = window.location.hash.replace('#/basket/', '');
    const title = mistakeBookTitle('王小明', world.window);
    const paper = await world.ext.paper.getPaperEx(paperId);
    expect(paper?.title).toBe(title);
    // 退一级：止于「排版中」，不替用户定稿（快照/done 由教师在排版间完成）
    expect(paper?.status).toBe('composing');
    expect((await world.ext.paper.listPaperSnapshotQuestions(paperId)).length).toBe(0);

    // 卷面题 = 0025 导出口（该生 + 时间窗）
    const expectedIds = await world.ext.mistake.exportQuestionIds({
      studentIds: [world.wang.id], occurredFrom: world.window.from, occurredTo: world.window.to,
    });
    const refs = await world.bank.getPaperQuestions(paperId);
    expect(refs.map((r) => r.questionId).sort()).toEqual([...expectedIds].sort());
    expect(refs.length).toBe(3);

    // 卷头（0009 header.lines 路径，零 docgen 改动）随卷落库，教师进排版间即可微调
    expect(paper?.layoutConfig?.header?.lines).toEqual(mistakeBookHeaderLines('王小明', world.window, 3));

    // 送到组卷后提示可见（并说明导出由用户自理）
    expect(el('[data-testid="page-message"]').textContent).toContain('已送到组卷');
    expect(el('[data-testid="page-message"]').textContent).toContain('自行导出');
  });

  it('未选学生时成册按钮禁用（成册按学生出）', async () => {
    await renderPage(world);
    expect((el('[data-testid="mistake-book-btn"]') as HTMLButtonElement).disabled).toBe(true);
  });
});
