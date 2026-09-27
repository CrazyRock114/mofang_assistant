// 0003: 学生/班级/考试/错题本四页组件测试 — jsdom 环境，Mock (in-memory) 实现单跑
// 覆盖验收探针「用户路径（页面操作→库）」：建生→分班→建考→登记勾错→红升黄→错题本操作 全链
// 断言结构化（data-testid 定位 + 精确文本）；禁 prompt/alert/confirm（两步确认按钮代替）
// 覆盖策略：真实 SQLite 服务语义由 test/bank/ext-contract.test.ts（node 环境双跑）覆盖，
// Electron 真桥真库全链由 scripts/smoke-ext.mjs 覆盖；本文件聚焦 UI 组件交互，
// 单跑 Mock 与浏览器 demo 的真实后端同构，无覆盖损失。
// 环境约束：vitest 3 的 DOM 环境（jsdom）worker 中 node: 内置模块具名/default 导入均失效
// （fix-1 返工根因，非确定性复现），故本文件禁止任何 node: 导入与真实文件系统/SQLite 操作。
// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import type { BankService, BankExtServices } from '../../src/shared/contracts/bank-types.js';
import { MockBankService } from '../../src/bank/mock/mock-bank.js';
import { createMockExtServices } from '../../src/bank/mock/mock-ext.js';
import { MockBankStore } from '../../src/bank/mock/mock-store.js';

import { StudentsPage } from '../../src/app/pages/StudentsPage.js';
import { ClassesPage, ClassDetailPage } from '../../src/app/pages/ClassesPage.js';
import { ExamsPage, ExamDetailPage } from '../../src/app/pages/ExamsPage.js';
import { MistakesPage } from '../../src/app/pages/MistakesPage.js';
import type { ExtPageServices } from '../../src/app/pages/ExtUi.js';

// ---------------- 测试世界（Mock in-memory 单跑） ----------------

interface ExtCtx {
  bank: BankService;
  ext: BankExtServices;
  cleanup: () => void;
}

function createMockCtx(): ExtCtx {
  const store = new MockBankStore();
  return {
    bank: new MockBankService(store),
    ext: createMockExtServices(store),
    cleanup: () => {},
  };
}

// ---------------- 渲染/交互辅助（照 capture-page 测试模式） ----------------

let container: HTMLDivElement;
let root: Root | null = null;

function render(ui: ReactElement) {
  // 同测试内二次 render：先卸载上一棵树，避免旧监听干扰
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
});

function btn(text: string): HTMLButtonElement {
  const b = [...container.querySelectorAll('button')].find((x) => x.textContent === text);
  if (!b) throw new Error(`找不到按钮: ${text}`);
  return b as HTMLButtonElement;
}

function clickBtn(selector: string) {
  const el = container.querySelector(selector);
  if (!el) throw new Error(`找不到按钮: ${selector}`);
  flushSync(() => (el as HTMLButtonElement).click());
}

function inputEl(selector: string): HTMLInputElement {
  const el = container.querySelector(selector);
  if (!el) throw new Error(`找不到输入框: ${selector}`);
  return el as HTMLInputElement;
}

/** React 受控输入：原生 setter + input 事件 */
function setInput(selector: string, value: string) {
  const el = inputEl(selector);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** React 受控下拉：change 事件 */
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

/** 测试世界：两题一卷一集合（uniform）+ 两名学生 + 一个班（两名学生在班） */
async function seedWorld(ctx: ExtCtx) {
  const { bank, ext } = ctx;
  const q1 = await bank.createQuestion({
    subject: '物理',
    sourceType: 'local',
    sourceDetail: { origin: 'test' },
    content: '<div class="question">自由落体求落地速度</div>',
    stemHtml: '<div class="question">自由落体求落地速度</div>',
    answer: '<p>v = gt</p>',
    images: [],
  });
  const q2 = await bank.createQuestion({
    subject: '物理',
    sourceType: 'local',
    sourceDetail: { origin: 'test' },
    content: '<div class="question">牛顿第二定律应用</div>',
    images: [],
  });
  const paper = await bank.createPaper('测试统一卷');
  await bank.addQuestion(paper.id, q1.id, 5);
  await bank.addQuestion(paper.id, q2.id, 5);
  const paperSet = await ext.paperSet.createPaperSet({ name: '测试集合', type: 'uniform' });
  await ext.paperSet.addPaper(paperSet.id, paper.id);

  const student = await ext.student.createStudent({ name: '王小明', studentNo: 'S001' });
  const student2 = await ext.student.createStudent({ name: '张三' });
  const clazz = await ext.class.createClass({ name: '初二一班' });
  await ext.student.enrollStudent(student.id, clazz.id);
  await ext.student.enrollStudent(student2.id, clazz.id);

  return { q1, q2, paper, paperSet, student, student2, clazz };
}

describe('0003 四页面用户路径 - Mock (in-memory)', () => {
  let ctx: ExtCtx;
  let svc: ExtPageServices;

  beforeEach(() => {
    ctx = createMockCtx();
    svc = { bank: ctx.bank, ext: ctx.ext };
  });

  afterEach(() => {
    ctx.cleanup();
  });

  // ==================== 学生管理页 ====================

  it('学生管理：新建→列表可见→检索过滤；封存→默认隐藏→勾选查回；详情抽屉时间线', async () => {
    // 预置两名学生（经服务层建档）
    await svc.ext.student.createStudent({ name: '王小明', studentNo: 'S001' });
    await svc.ext.student.createStudent({ name: '张三' });

    render(<StudentsPage services={svc} />);
    await waitFor(() => {
      expect(container.querySelectorAll('[data-testid="student-row"]').length).toBe(2);
    });

    // 新建学生
    flushSync(() => btn('新建学生').click());
    setInput('[data-testid="student-name-input"]', '李四');
    setInput('[data-testid="student-no-input"]', 'S003');
    flushSync(() => btn('保存').click());
    await waitFor(() => {
      expect(container.querySelectorAll('[data-testid="student-row"]').length).toBe(3);
    });
    expect(container.querySelector('[data-testid="page-message"]')!.textContent).toContain('已新建学生「李四」');

    // 检索过滤
    setInput('[data-testid="student-keyword-input"]', '李四');
    await waitFor(() => {
      expect(container.querySelectorAll('[data-testid="student-row"]').length).toBe(1);
    });
    setInput('[data-testid="student-keyword-input"]', '');
    await waitFor(() => {
      expect(container.querySelectorAll('[data-testid="student-row"]').length).toBe(3);
    });

    // 封存（两步确认）→ 默认隐藏 → 显示已封存查回
    const archiveBtn = container.querySelector('[data-testid="student-archive-btn-李四"]') as HTMLButtonElement;
    flushSync(() => archiveBtn.click());
    flushSync(() => btn('确认封存').click());
    await waitFor(() => {
      expect(container.querySelectorAll('[data-testid="student-row"]').length).toBe(2);
    });
    const toggle = inputEl('[data-testid="student-archived-toggle"]');
    // React 对 checkbox 的 onChange 由 click 事件驱动（programmatic checked+change 不触发）
    flushSync(() => toggle.click());
    await waitFor(() => {
      const rows = [...container.querySelectorAll('[data-testid="student-row"]')];
      expect(rows.length).toBe(3);
      expect(rows.find((r) => r.getAttribute('data-name') === '李四')!.textContent).toContain('已封存');
    });

    // 详情抽屉：时间线加备注
    clickBtn('[data-testid="student-detail-btn-张三"]');
    await waitFor(() => {
      expect(container.querySelector('[data-testid="student-detail-title"]')!.textContent).toContain('张三');
    });
    setInput('[data-testid="student-note-input"]', '最近状态不错');
    flushSync(() => btn('添加').click());
    await waitFor(() => {
      expect(container.querySelector('[data-testid="student-events"]')!.textContent).toContain('最近状态不错');
    });
  });

  // ==================== 班级列表 + 详情（分班） ====================

  it('班级：新建班级；详情页入班→名单可见；结课→历史分班', async () => {
    const world = await seedWorld(ctx);

    render(<ClassesPage services={svc} />);
    await waitFor(() => {
      expect(container.querySelectorAll('[data-testid="class-item"]').length).toBe(1);
    });

    // 新建班级
    flushSync(() => btn('新建班级').click());
    setInput('[data-testid="class-name-input"]', '初二二班');
    flushSync(() => btn('保存').click());
    await waitFor(() => {
      expect(container.querySelectorAll('[data-testid="class-item"]').length).toBe(2);
    });
    const classes = await svc.ext.class.listClasses({ status: 'all' });
    const newClass = classes.find((c) => c.name === '初二二班')!;

    // 详情页（空班）：把张三编入
    render(<ClassDetailPage classId={newClass.id} services={svc} />);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="class-roster-empty"]')).toBeTruthy();
    });
    const target = (await svc.ext.student.listStudents({})).find((s) => s.name === '张三')!;
    setSelect('[data-testid="enroll-student-select"]', target.id);
    clickBtn('[data-testid="enroll-btn"]');
    await waitFor(() => {
      expect(container.querySelector('[data-testid="class-roster"]')!.textContent).toContain('张三');
    });

    // 结课（两步确认）→ 名单移除 + 历史分班出现
    const endBtn = container.querySelector('[data-testid="end-enrollment-btn-张三"]') as HTMLButtonElement;
    flushSync(() => endBtn.click());
    flushSync(() => btn('确认结课').click());
    await waitFor(() => {
      expect(container.querySelector('[data-testid="ended-student-row"]')!.textContent).toContain('张三');
    });
    expect(container.querySelector('[data-testid="page-message"]')!.textContent).toContain('已结束');
  });

  // ==================== 考试登记（含 U9） ====================

  it('考试登记：录成绩+勾错→摘要标红；二次登记→U9 自动升黄摘要；成绩列表', async () => {
    const world = await seedWorld(ctx);
    const exam = await svc.ext.exam.createExam({
      title: '九月月考',
      classId: world.clazz.id,
      occurredAt: '2026-09-01',
      paperSetId: world.paperSet.id,
    });

    render(<ExamDetailPage examId={exam.id} services={svc} />);
    await waitFor(() => {
      expect(container.querySelectorAll('[data-testid^="exam-student-row-"]').length).toBe(2);
    });

    // 王小明：成绩 85 + 勾错第 1 题（提交按全名单：张三未录成绩=缺考也写入）
    setInput('[data-testid="score-input-王小明"]', '85');
    flushSync(() => (container.querySelector('[data-testid="wrong-checkbox-王小明-1"]') as HTMLInputElement).click());
    clickBtn('[data-testid="record-submit-btn"]');
    await waitFor(() => {
      const summary = container.querySelector('[data-testid="record-summary"]')!.textContent!;
      expect(summary).toContain('成绩写入 2 条');
      expect(summary).toContain('新标红 1 题');
      expect(summary).toContain('自动升黄 0 题');
    });

    // 二次登记：取消勾错（视为做对）→ U9 红自动升黄
    flushSync(() => (container.querySelector('[data-testid="wrong-checkbox-王小明-1"]') as HTMLInputElement).click());
    clickBtn('[data-testid="record-submit-btn"]');
    await waitFor(() => {
      const summary = container.querySelector('[data-testid="record-summary"]')!.textContent!;
      expect(summary).toContain('自动升黄 1 题（1 名学生）');
    });

    // 成绩列表（exam_scores 独立表，U14）：王小明 85；张三缺考
    await waitFor(() => {
      const table = container.querySelector('[data-testid="exam-scores-table"]')!.textContent!;
      expect(table).toContain('王小明');
      expect(table).toContain('85');
      expect(table).toContain('缺考');
    });
  });

  it('考试登记：无卷考试提交后显示不触发自动升黄提示（错误路径提示）', async () => {
    const world = await seedWorld(ctx);
    const exam = await svc.ext.exam.createExam({
      title: '校外联考',
      classId: world.clazz.id,
      occurredAt: '2026-09-05',
      // 无 paperSetId
    });

    render(<ExamDetailPage examId={exam.id} services={svc} />);
    await waitFor(() => {
      expect(container.querySelectorAll('[data-testid^="exam-student-row-"]').length).toBe(2);
    });
    setInput('[data-testid="score-input-王小明"]', '90');
    clickBtn('[data-testid="record-submit-btn"]');
    await waitFor(() => {
      expect(container.querySelector('[data-testid="no-paperset-hint"]')!.textContent)
        .toContain('不触发红题自动升黄');
    });
  });

  it('考试列表：列出考试并区分有无卷集合', async () => {
    const world = await seedWorld(ctx);
    await svc.ext.exam.createExam({ title: '有卷考试', classId: world.clazz.id, occurredAt: '2026-09-01', paperSetId: world.paperSet.id });
    await svc.ext.exam.createExam({ title: '无卷考试', classId: world.clazz.id, occurredAt: '2026-09-02' });

    render(<ExamsPage services={svc} />);
    await waitFor(() => {
      expect(container.querySelectorAll('[data-testid="exam-row"]').length).toBe(2);
    });
    const table = container.querySelector('[data-testid="exams-table"]')!.textContent!;
    expect(table).toContain('有卷考试');
    expect(table).toContain('无卷考试');
    expect(table).toContain('无卷（校外登记）');
  });

  // ==================== 错题本 ====================

  // 0026：错题本改三栏（聚合列表 + 详情弹层）——0003 能力（快照可读/状态灯循环与回退/备注/删除）逐项保留，
  // 只是收进「双击行 → 详情」；筛选改走聚合口径。默认筛选=本周+本班，故数据落在本週窗口内。
  const inWeek = (() => {
    const monday = new Date();
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    const y = monday.getFullYear(); const m = `${monday.getMonth() + 1}`.padStart(2, '0'); const d = `${monday.getDate()}`.padStart(2, '0');
    return `${y}-${m}-${d}T10:00:00.000Z`;
  })();

  async function openFirstDetail(questionId: string) {
    // 0026 目检返工：详情改显式按钮（双击不再是隐含交互）
    const btn = container.querySelector(`[data-testid="mistake-detail-btn-${questionId}"]`) as HTMLButtonElement;
    btn.click();
    await waitFor(() => expect(container.querySelector('[data-testid="mistake-detail-modal"]')).toBeTruthy());
  }

  it('错题本：聚合行可见+快照可读；详情内状态灯循环红→黄→绿与手动回退；备注；删除', async () => {
    const world = await seedWorld(ctx);
    const { mistake } = await svc.ext.mistake.recordWrong({
      questionId: world.q1.id,
      studentId: world.student.id,
      occurredAt: inWeek,
    });

    render(<MistakesPage services={svc} />);
    await waitFor(() => {
      expect(container.querySelector(`[data-testid="mistake-card-${world.q1.id}"]`)).toBeTruthy();
    });
    const row = () => container.querySelector(`[data-testid="mistake-card-${world.q1.id}"]`)!;
    // 主信息=错误人次（P-02/P-30）
    expect(row().getAttribute('data-wrong-count')).toBe('1');
    expect(row().textContent).toContain('自由落体求落地速度');

    await openFirstDetail(world.q1.id);
    const detailRow = () => container.querySelector('[data-testid="mistake-detail-row-王小明"]')!;
    // 快照题面可读（读快照而非实时题库）
    expect(container.querySelector('[data-testid="mistake-snapshot"]')!.textContent).toContain('自由落体求落地速度');
    expect(container.querySelector('[data-testid="mistake-snapshot"]')!.textContent).toContain('答案');

    // 状态灯循环：红→黄→绿
    clickBtn('[data-testid="mistake-cycle-btn-王小明"]');
    await waitFor(() => expect(detailRow().getAttribute('data-stage')).toBe('yellow'));
    clickBtn('[data-testid="mistake-cycle-btn-王小明"]');
    await waitFor(() => expect(detailRow().getAttribute('data-stage')).toBe('green'));

    // 手动回退红（U2：可回退）
    setSelect('[data-testid="mistake-stage-select-王小明"]', 'red');
    await waitFor(() => expect(detailRow().getAttribute('data-stage')).toBe('red'));

    // 备注
    setInput('[data-testid="mistake-note-input-王小明"]', '二次订正仍未掌握');
    clickBtn('[data-testid="mistake-note-save-btn-王小明"]');
    await waitFor(() => {
      expect(container.querySelector('[data-testid="page-message"]')!.textContent).toContain('备注已保存');
    });

    // 删除（两步确认）→ 详情行消失 + 列表空态
    clickBtn('[data-testid="mistake-delete-btn-王小明"]');
    flushSync(() => btn('确认删除').click());
    await waitFor(() => {
      expect(container.querySelector('[data-testid="mistake-detail-row-王小明"]')).toBeNull();
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="mistakes-empty"]')).toBeTruthy();
    });
    expect(await svc.ext.mistake.getMistake(mistake.id)).toBeNull();
  });

  it('错题本：按学生/状态筛选生效（聚合口径）', async () => {
    const world = await seedWorld(ctx);
    await svc.ext.mistake.recordWrong({ questionId: world.q1.id, studentId: world.student.id, occurredAt: inWeek });
    await svc.ext.mistake.recordWrong({ questionId: world.q2.id, studentId: world.student2.id, occurredAt: inWeek });

    const rows = () => [...container.querySelectorAll('[data-testid^="mistake-card-"]')].filter((n) => n.hasAttribute('data-wrong-count'));
    render(<MistakesPage services={svc} />);
    await waitFor(() => expect(rows().length).toBe(2));

    // 按学生筛选：只剩该生的错题（聚合行）
    setSelect('[data-testid="mistake-student-filter"]', world.student.id);
    await waitFor(() => {
      expect(rows().length).toBe(1);
      expect(container.querySelector(`[data-testid="mistake-card-${world.q1.id}"]`)).toBeTruthy();
    });
    setSelect('[data-testid="mistake-student-filter"]', '');
    await waitFor(() => expect(rows().length).toBe(2));

    // 按状态筛选：张三的错题置黄后筛 yellow 只剩 1 条
    const zhangsanMistakes = await svc.ext.mistake.listMistakes({ studentId: world.student2.id });
    await svc.ext.mistake.setStage(zhangsanMistakes[0].id, 'yellow');
    setSelect('[data-testid="mistake-stage-filter"]', 'yellow');
    await waitFor(() => {
      expect(rows().length).toBe(1);
      expect(container.querySelector(`[data-testid="mistake-card-${world.q2.id}"]`)).toBeTruthy();
    });

    // 时间窗筛选：清空后窗口外错题一并出现
    await svc.ext.mistake.recordWrong({ questionId: world.q2.id, studentId: world.student.id, occurredAt: '2026-01-01T10:00:00.000Z' });
    setInput('[data-testid="mistake-from-input"]', '');
    setInput('[data-testid="mistake-to-input"]', '');
    setSelect('[data-testid="mistake-stage-filter"]', '');
    await waitFor(() => expect(rows().length).toBe(2));
  });
});

// ==================== fix-2：新建考试关联已定稿卷（P0-2） ====================

describe('0003-fix-2 新建考试关联已定稿卷 - Mock (in-memory)', () => {
  let ctx: ExtCtx;
  let svc: ExtPageServices;

  beforeEach(() => {
    // jsdom 的 location.hash 跨用例残留会让「提交后跳详情页」的 waitFor 提前误过（撞上在途 save 的 onClose 卸载弹层）
    window.location.hash = '';
    ctx = createMockCtx();
    svc = { bank: ctx.bank, ext: ctx.ext };
  });

  afterEach(() => {
    ctx.cleanup();
  });

  /** 预置：done 卷（一题）+ 班级（一名学生） */
  async function seedDonePaperAndClass(paperTitle: string) {
    const q = await svc.bank.createQuestion({
      subject: '数学',
      sourceType: 'local',
      sourceDetail: { origin: 'test' },
      content: '<div>勾股定理计算</div>',
      images: [],
    });
    const paper = await svc.bank.createPaper(paperTitle);
    await svc.bank.addQuestion(paper.id, q.id, 5);
    // 状态机合法迁移：basket→composing→done（与组卷页「开始排版→定稿」用户路径一致）
    await svc.ext.paper.updatePaperStatus(paper.id, 'composing');
    await svc.ext.paper.updatePaperStatus(paper.id, 'done');
    const clazz = await svc.ext.class.createClass({ name: '初二三班' });
    const student = await svc.ext.student.createStudent({ name: '李雷' });
    await svc.ext.student.enrollStudent(student.id, clazz.id);
    return { paper, clazz };
  }

  /** 等弹层异步数据（班级/学科/集合/done 卷）加载完：班级下拉出现目标班 */
  async function waitForModalLoaded(clazzId: string) {
    await waitFor(() => {
      const sel = container.querySelector('[data-testid="exam-class-select"]') as HTMLSelectElement | null;
      expect(sel).toBeTruthy();
      expect(Array.from(sel!.options).some((o) => o.value === clazzId)).toBe(true);
    });
  }

  it('建卷定稿 → 新建考试选该卷 → 提交后自动编排单卷集合并关联（集合含该卷）', async () => {
    const { paper, clazz } = await seedDonePaperAndClass('期中定稿卷');

    render(<ExamsPage services={svc} />);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="exam-create-btn"]')).toBeTruthy();
    });
    flushSync(() => btn('新建考试').click());
    await waitForModalLoaded(clazz.id);

    setInput('[data-testid="exam-title-input"]', '期中考试');
    setSelect('[data-testid="exam-class-select"]', clazz.id);
    setSelect('[data-testid="exam-donepaper-select"]', paper.id);
    flushSync(() => btn('创建并进入登记').click());

    // 提交成功 → onCreated 跳详情页
    await waitFor(() => {
      expect(window.location.hash.startsWith('#/exams/')).toBe(true);
    });
    const examId = decodeURIComponent(window.location.hash.replace('#/exams/', ''));
    const exam = await svc.ext.exam.getExam(examId);
    expect(exam).toBeTruthy();
    // createExam 收到非空 paperSetId；集合=uniform 单卷集合，名=卷标题，含该卷
    expect(exam!.paperSetId).toBeTruthy();
    const set = await svc.ext.paperSet.getPaperSet(exam!.paperSetId!);
    expect(set!.type).toBe('uniform');
    expect(set!.name).toBe('期中定稿卷');
    const refs = await svc.ext.paperSet.getSetPapers(exam!.paperSetId!);
    expect(refs.map((r) => r.paperId)).toEqual([paper.id]);
  });

  it('同一 done 卷二次建考试 → 复用原集合（集合数不增）', async () => {
    const { paper, clazz } = await seedDonePaperAndClass('可复用定稿卷');

    render(<ExamsPage services={svc} />);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="exam-create-btn"]')).toBeTruthy();
    });

    const createExamViaUi = async (title: string) => {
      flushSync(() => btn('新建考试').click());
      await waitForModalLoaded(clazz.id);
      setInput('[data-testid="exam-title-input"]', title);
      setSelect('[data-testid="exam-class-select"]', clazz.id);
      setSelect('[data-testid="exam-donepaper-select"]', paper.id);
      flushSync(() => btn('创建并进入登记').click());
    };

    await createExamViaUi('第一次考试');
    await waitFor(() => {
      expect(window.location.hash.startsWith('#/exams/')).toBe(true);
    });
    const firstHash = window.location.hash;
    const setsAfterFirst = await svc.ext.paperSet.listPaperSets({});
    expect(setsAfterFirst.length).toBe(1);
    const reusedSetId = setsAfterFirst[0].id;

    await createExamViaUi('第二次考试');
    await waitFor(() => {
      expect(window.location.hash).not.toBe(firstHash);
    });
    const setsAfterSecond = await svc.ext.paperSet.listPaperSets({});
    expect(setsAfterSecond.length).toBe(1);
    expect(setsAfterSecond[0].id).toBe(reusedSetId);
    // 两场考试都关联到同一集合
    const exams = await svc.ext.exam.listExams({});
    expect(exams.length).toBe(2);
    expect(exams.every((e) => e.paperSetId === reusedSetId)).toBe(true);
  });

  it('无 done 卷（只有 basket）→ 表单空态提示，无法提交关联；仍可无卷建考试', async () => {
    await svc.bank.createPaper('未定稿草稿卷'); // basket，未定稿
    const clazz = await svc.ext.class.createClass({ name: '初二四班' });
    const student = await svc.ext.student.createStudent({ name: '韩梅' });
    await svc.ext.student.enrollStudent(student.id, clazz.id);

    render(<ExamsPage services={svc} />);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="exam-create-btn"]')).toBeTruthy();
    });
    flushSync(() => btn('新建考试').click());
    await waitForModalLoaded(clazz.id);

    // 空态提示 + 无 done 卷下拉（无提交关联的入口）
    const empty = container.querySelector('[data-testid="exam-donepaper-empty"]');
    expect(empty).toBeTruthy();
    expect(empty!.textContent).toContain('暂无已定稿试卷');
    expect(container.querySelector('[data-testid="exam-donepaper-select"]')).toBeNull();

    // 不关联任何卷仍可建考试（校外登记路径不回归）
    setInput('[data-testid="exam-title-input"]', '校外登记考试');
    setSelect('[data-testid="exam-class-select"]', clazz.id);
    flushSync(() => btn('创建并进入登记').click());
    await waitFor(() => {
      expect(window.location.hash.startsWith('#/exams/')).toBe(true);
    });
    const examId = decodeURIComponent(window.location.hash.replace('#/exams/', ''));
    const exam = await svc.ext.exam.getExam(examId);
    expect(exam).toBeTruthy();
    expect(exam!.paperSetId).toBeUndefined();
  });
});
