// 0026 真桥双跑：错题闭环产品层的派生函数（mistake-loop.ts）在**真实 SQLite** 与 **mock 内存** 两遍
// 跑同一份固定数据集，两遍必须同绿且派生输出互相一致（D-005 双跑口径；0025 已保证数据层同口径，
// 本文件锁的是「0026 在其上做的筛选/派生/入篮/出卷/成册」这一层）。
//
// 覆盖任务书 §四：
// - 聚合展示一致性：固定数据集（3 生 × 4 题部分重叠）→ 展示派生（人次文案/次序/难度）与数据口逐字段一致
// - 批量操作：UI 派生的 mistakes 行 id 集 → 批量口参数断言（行数/类型/状态）+ 作用域不越界
// - 入篮联动：错题 id 集 → 试题篮（去重计划 + 逐题 addQuestion）→ 卷内次序断言
// - D3 Top N 参数化 + 成册（卷头/快照/定稿）链路断言
//
// 固定数据集（与 0025 契约测试同构；时刻为 UTC ISO，均落在 2026-09-14~2026-09-20 窗口内）：
//   q1 物理：s1 / s2                q2 物理：s1 / s2 / s3（班内三人）+ s4（班外）
//   q3 物理：s2                     q4 化学：s1
//   q5 物理：s3（窗口外，2026-08-01）
// 班级 c1 = {s1, s2, s3}；s4 无班级。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BankService, BankExtServices, MistakeAggregateRow, Question, Student } from '../../src/shared/contracts/bank-types.js';
import { openDatabase } from '../../src/bank/db.js';
import { BankServiceImpl } from '../../src/bank/bank-service.js';
import { createExtServices } from '../../src/bank/ext-services.js';
import { MockBankService } from '../../src/bank/mock/mock-bank.js';
import { createMockExtServices } from '../../src/bank/mock/mock-ext.js';
import { MockBankStore } from '../../src/bank/mock/mock-store.js';
import {
  classMistakeTitle, describeWrongCount, difficultyLabel, mistakeBookHeaderLines, mistakeBookTitle,
  planAddToBasket, scopeMistakeIds, toAggregateFilter, topN,
  type MistakeScope,
} from '../../src/app/pages/mistake-loop.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '../../src/bank/migrations');

const WINDOW = { from: '2026-09-14', to: '2026-09-20' };

interface World {
  bank: BankService;
  ext: BankExtServices;
  q1: Question; q2: Question; q3: Question; q4: Question; q5: Question;
  s1: Student; s2: Student; s3: Student; s4: Student;
  classId: string;
  cleanup: () => void;
}

async function seed(factory: () => { bank: BankService; ext: BankExtServices; cleanup: () => void }): Promise<World> {
  const { bank, ext, cleanup } = factory();
  const clazz = await ext.class.createClass({ name: '初二一班' });
  const s1 = await ext.student.createStudent({ name: '王小明' });
  const s2 = await ext.student.createStudent({ name: '张三' });
  const s3 = await ext.student.createStudent({ name: '李四' });
  const s4 = await ext.student.createStudent({ name: '赵六' }); // 班外
  for (const s of [s1, s2, s3]) await ext.student.enrollStudent(s.id, clazz.id);

  const mk = (subject: string, stem: string, extra: Partial<Question> = {}) => bank.createQuestion({
    subject, sourceType: 'local', sourceDetail: { origin: 'test' },
    content: `<div class="question">${stem}</div>`, stemHtml: `<div class="question">${stem}</div>`, images: [], ...extra,
  });
  const q1 = await mk('物理', '自由落体求落地速度');
  const q2 = await mk('物理', '牛顿第二定律应用', { questionType: '选择题', difficulty: 3 });
  const q3 = await mk('物理', '动量守恒判断', { difficulty: 2 });
  const q4 = await mk('化学', '氧化还原配平');
  const q5 = await mk('物理', '窗口外旧错题');

  await ext.mistake.recordWrong({ questionId: q1.id, studentId: s1.id, occurredAt: '2026-09-14T10:00:00.000Z' });
  await ext.mistake.recordWrong({ questionId: q1.id, studentId: s2.id, occurredAt: '2026-09-20T10:00:00.000Z' });
  await ext.mistake.recordWrong({ questionId: q2.id, studentId: s1.id, occurredAt: '2026-09-14T10:00:00.000Z' });
  await ext.mistake.recordWrong({ questionId: q2.id, studentId: s2.id, occurredAt: '2026-09-15T10:00:00.000Z' });
  await ext.mistake.recordWrong({ questionId: q2.id, studentId: s3.id, occurredAt: '2026-09-20T10:00:00.000Z' });
  await ext.mistake.recordWrong({ questionId: q2.id, studentId: s4.id, occurredAt: '2026-09-14T10:00:00.000Z' });
  await ext.mistake.recordWrong({ questionId: q3.id, studentId: s2.id, occurredAt: '2026-09-16T10:00:00.000Z' });
  await ext.mistake.recordWrong({ questionId: q4.id, studentId: s1.id, occurredAt: '2026-09-17T10:00:00.000Z' });
  await ext.mistake.recordWrong({ questionId: q5.id, studentId: s3.id, occurredAt: '2026-08-01T10:00:00.000Z' });

  return { bank, ext, q1, q2, q3, q4, q5, s1, s2, s3, s4, classId: clazz.id, cleanup };
}

const implementations: Array<{ name: string; factory: () => { bank: BankService; ext: BankExtServices; cleanup: () => void } }> = [
  {
    name: 'Real (SQLite)',
    factory: () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'mistake-loop-derive-'));
      const db = openDatabase(join(tempDir, 'test.db'), migrationsDir);
      return {
        bank: new BankServiceImpl(db),
        ext: createExtServices(db),
        cleanup: () => { db.close(); rmSync(tempDir, { recursive: true, force: true }); },
      };
    },
  },
  {
    name: 'Mock (in-memory)',
    factory: () => {
      const store = new MockBankStore();
      return {
        bank: new MockBankService(store, false),
        ext: createMockExtServices(store),
        cleanup: () => {},
      };
    },
  },
];

/** 两遍共同产出的派生视图（跨实现比对用；题 id 与同人次次序实现相关，故不进本视图） */
interface DerivedView {
  /** 人次降序 → 同人次按摘要归一的规范序（对同人次次序做与 id 无关的判定） */
  canonical: string[];
  topN2: string[];
  batchTargetCount: number;
}

/** 摘要 → 题 id（本实现内的映射；用于与另一遍按摘要对齐） */
async function summaryToId(world: World): Promise<Map<string, string>> {
  const rows = await world.ext.mistake.aggregateByQuestion(toAggregateFilter({
    studentIds: [world.s1.id, world.s2.id, world.s3.id], occurredFrom: WINDOW.from, occurredTo: WINDOW.to,
  }));
  return new Map(rows.map((row) => [row.stemSummary, row.questionId]));
}

for (const impl of implementations) {
  describe(`0026 错题闭环产品层派生 · ${impl.name}`, () => {
    let world: World;
    /** 本班筛选（左栏默认态：本周 + 本班） */
    let classScope: MistakeScope;

    // 真库这一遍建的是一个完整世界（建库 + 全量迁移 + 班级/4 生/5 题/9 条错题登记），
    // 默认 10s 钩子预算在机器被并行 lane 占满时会超（实测为钩子超时，非断言失败），故显式放宽。
    beforeEach(async () => {
      world = await seed(impl.factory);
      classScope = {
        studentIds: [world.s1.id, world.s2.id, world.s3.id],
        occurredFrom: WINDOW.from,
        occurredTo: WINDOW.to,
      };
    }, 30_000);

    afterEach(() => { world.cleanup(); });

    it('聚合展示派生与数据口逐字段一致：人次降序 + 「错 N/M 人」+ 难度文案', async () => {
      const rows = await world.ext.mistake.aggregateByQuestion(toAggregateFilter(classScope));
      const scopeCount = 3;

      // 人次降序：前两位人次不同，次序唯一（q2 三人在班 / q1 两人）
      expect(rows.map((row) => row.questionId)).toEqual([
        world.q2.id, world.q1.id,
        ...rows.slice(2).map((row) => row.questionId),
      ]);
      expect(rows[0].stemSummary).toBe('牛顿第二定律应用');
      expect(rows[1].stemSummary).toBe('自由落体求落地速度');
      // 同人次（各 1 人）后两位次序由 question_id 决定（0026 不重排，只按数据口序展示）
      expect(rows.length).toBe(4);
      expect(new Set(rows.slice(2).map((row) => row.questionId))).toEqual(new Set([world.q3.id, world.q4.id]));

      // 人次文案按数据口计数逐行派生（分母=班内人数）
      const textBySummary = new Map(rows.map((row) => [row.stemSummary, describeWrongCount(row.wrongCount, scopeCount)]));
      expect(textBySummary.get('牛顿第二定律应用')).toBe('错 3/3 人');
      expect(textBySummary.get('自由落体求落地速度')).toBe('错 2/3 人');
      expect(textBySummary.get('动量守恒判断')).toBe('错 1/3 人');
      expect(textBySummary.get('氧化还原配平')).toBe('错 1/3 人');
      expect(rows[0].questionId).toBe(world.q2.id);
      // 难度文案（q2=3 中等 / q1 未设 / q3=2 较易 / q4 未设）
      const diffBySummary = new Map(rows.map((row) => [row.stemSummary, difficultyLabel(row.difficulty)]));
      expect(diffBySummary.get('牛顿第二定律应用')).toBe('中等');
      expect(diffBySummary.get('动量守恒判断')).toBe('较易');
      expect(diffBySummary.get('自由落体求落地速度')).toBeUndefined();
      // 窗口外错题不入默认视图
      expect(rows.some((row) => row.questionId === world.q5.id)).toBe(false);
      // 班外学生的错题不计入人次
      expect(rows[0].wrongCount).toBe(3);
    });

    it('筛选口径联动：切「全部班级」人次升到 4；学科=化学只剩 q4；status 过滤为空', async () => {
      const allScope: MistakeScope = { occurredFrom: WINDOW.from, occurredTo: WINDOW.to };
      const allRows = await world.ext.mistake.aggregateByQuestion(toAggregateFilter(allScope));
      expect(allRows[0].questionId).toBe(world.q2.id);
      expect(allRows[0].wrongCount).toBe(4);

      const chem = await world.ext.mistake.aggregateByQuestion(toAggregateFilter({ ...classScope, subject: '化学' }));
      expect(chem.map((row) => row.questionId)).toEqual([world.q4.id]);

      const yellow = await world.ext.mistake.aggregateByQuestion(toAggregateFilter({ ...classScope, stage: 'yellow' }));
      expect(yellow).toEqual([]);
    });

    it('批量口参数派生：聚合行 → 本班 mistakes 行 id（不越界到班外/窗口外）', async () => {
      const rows = await world.ext.mistake.aggregateByQuestion(toAggregateFilter(classScope));
      const picked = rows.filter((row) => row.questionId === world.q1.id || row.questionId === world.q2.id);

      const ids: string[] = [];
      for (const row of picked) {
        const list = await world.ext.mistake.listMistakes({ questionId: row.questionId });
        ids.push(...scopeMistakeIds(list, classScope));
      }
      expect(ids.length).toBe(5); // q1×2 + q2×3（班内）

      const staged = await world.ext.mistake.setStages(ids, 'green');
      expect(staged.affectedCount).toBe(5);

      // 作用域不越界：班外 s4 的 q2 行仍红；窗口外 q5 行未动
      const s4Rows = await world.ext.mistake.listMistakes({ studentId: world.s4.id });
      expect(s4Rows.map((m) => m.stage)).toEqual(['red']);
      const s3Rows = await world.ext.mistake.listMistakes({ studentId: world.s3.id, questionId: world.q5.id });
      expect(s3Rows.map((m) => m.stage)).toEqual(['red']);

      // 批量删除同口径：删掉本班 q1/q2 的 5 行，班外行保留
      const deleted = await world.ext.mistake.deleteMistakes(ids);
      expect(deleted.affectedCount).toBe(5);
      const after = await world.ext.mistake.aggregateByQuestion(toAggregateFilter(classScope));
      expect(new Set(after.map((row) => row.questionId))).toEqual(new Set([world.q3.id, world.q4.id]));
      const s4Remain = await world.ext.mistake.listMistakes({ studentId: world.s4.id });
      expect(s4Remain.length).toBe(1);
    });

    it('D3 Top N 派生：0025 导出口 → topN 截断 → 入新篮（次序=聚合序）', async () => {
      const exportIds = await world.ext.mistake.exportQuestionIds(toAggregateFilter(classScope));
      const picked = topN(exportIds, 2);
      expect(picked).toEqual([world.q2.id, world.q1.id]);

      // 入篮计划 + 逐题 addQuestion（0026 的 D3 落点：题集 → 新篮）
      const paper = await world.ext.paper.createPaperEx(classMistakeTitle('初二一班', 2), {}, { status: 'basket' });
      const existing = await world.bank.getPaperQuestions(paper.id);
      const plan = planAddToBasket(existing.map((ref) => ref.questionId), picked);
      expect(plan).toEqual({ toAdd: picked, skipped: 0 });
      for (const qid of plan.toAdd) await world.bank.addQuestion(paper.id, qid);

      const refs = await world.bank.getPaperQuestions(paper.id);
      expect(refs.map((ref) => ref.questionId)).toEqual([world.q2.id, world.q1.id]);
      expect(paper.title).toBe('初二一班错题集 Top 2');
    });

    it('D1 入篮派生：错题集并入既有篮（去重）→ 卷内次序 = 既有 + 新增', async () => {
      const basket = await world.bank.createPaper('我的试题篮');
      await world.bank.addQuestion(basket.id, world.q3.id, 5);

      const exportIds = await world.ext.mistake.exportQuestionIds(toAggregateFilter(classScope));
      expect(exportIds.length).toBe(4);
      const existing = await world.bank.getPaperQuestions(basket.id);
      const plan = planAddToBasket(existing.map((ref) => ref.questionId), exportIds);
      expect(plan.skipped).toBe(1); // q3 已在篮
      expect(plan.toAdd).toEqual(exportIds.filter((id) => id !== world.q3.id));
      for (const qid of plan.toAdd) await world.bank.addQuestion(basket.id, qid);

      const refs = await world.bank.getPaperQuestions(basket.id);
      // 既有题保持首位，其余按导出口次序追加
      expect(refs.map((ref) => ref.questionId)).toEqual([world.q3.id, ...plan.toAdd]);
      expect(refs.length).toBe(4);

      // 二次并入同一题集：全部命中已在篮（幂等，不重复落库）
      const again = planAddToBasket(refs.map((ref) => ref.questionId), exportIds);
      expect(again.toAdd).toEqual([]);
      expect(again.skipped).toBe(4);
    });

    it('成册派生：该生错题集 → composing 建档 → 卷头 → 快照 → done（卷面次序=聚合序）', async () => {
      const studentScope: MistakeScope = { ...classScope, studentIds: [world.s1.id] };
      const ids = await world.ext.mistake.exportQuestionIds(toAggregateFilter(studentScope));
      // 次序 = 该筛选下聚合行序（导出即聚合序；0026 只透传）
      const rows = await world.ext.mistake.aggregateByQuestion(toAggregateFilter(studentScope));
      expect(ids).toEqual(rows.map((row) => row.questionId));
      expect(new Set(ids)).toEqual(new Set([world.q1.id, world.q2.id, world.q4.id]));
      expect(ids.length).toBe(3);

      const title = mistakeBookTitle('王小明', WINDOW);
      const paper = await world.ext.paper.createPaperEx(title, {}, { status: 'composing' });
      for (const qid of ids) await world.bank.addQuestion(paper.id, qid);
      await world.ext.paper.setPaperLayoutConfig(paper.id, {
        version: 2,
        header: { style: 'exam', lines: mistakeBookHeaderLines('王小明', WINDOW, ids.length) },
      });
      const snapCount = await world.ext.paper.snapshotPaperQuestions(paper.id);
      expect(snapCount).toBe(3);
      await world.ext.paper.updatePaperStatus(paper.id, 'done');

      const reloaded = await world.ext.paper.getPaperEx(paper.id);
      expect(reloaded?.status).toBe('done');
      expect(reloaded?.layoutConfig?.header?.lines).toEqual(mistakeBookHeaderLines('王小明', WINDOW, 3));
      const snapshots = await world.ext.paper.listPaperSnapshotQuestions(paper.id);
      expect(snapshots.map((q) => q.id)).toEqual(ids); // 快照序 = 卷面题序 = 导出口序
    });
  });
}

// ---------------- 跨实现一致性：两遍派生视图逐字段相同 ----------------

describe('0026 真桥↔mock：派生视图逐字段一致', () => {
  let realWorld: World;
  let mockWorld: World;

  beforeEach(async () => {
    realWorld = await seed(implementations[0].factory);
    mockWorld = await seed(implementations[1].factory);
  });

  afterEach(() => {
    realWorld.cleanup();
    mockWorld.cleanup();
  });

  async function derive(world: World): Promise<DerivedView> {
    const scope: MistakeScope = {
      studentIds: [world.s1.id, world.s2.id, world.s3.id],
      occurredFrom: WINDOW.from, occurredTo: WINDOW.to,
    };
    const rows: MistakeAggregateRow[] = await world.ext.mistake.aggregateByQuestion(toAggregateFilter(scope));
    // 规范序：人次降序 + 同人次按摘要（与题 id 无关，跨实现可比）
    const canonical = rows
      .map((row) => ({ summary: row.stemSummary, count: row.wrongCount, text: describeWrongCount(row.wrongCount, 3), diff: difficultyLabel(row.difficulty) ?? '—' }))
      .sort((a, b) => (b.count - a.count) || a.summary.localeCompare(b.summary))
      .map((entry) => `${entry.summary}|${entry.text}|${entry.diff}`);

    const exportIds = await world.ext.mistake.exportQuestionIds(toAggregateFilter(scope));
    const batchTargets: string[] = [];
    for (const row of rows.slice(0, 2)) {
      batchTargets.push(...scopeMistakeIds(await world.ext.mistake.listMistakes({ questionId: row.questionId }), scope));
    }
    return { canonical, topN2: topN(exportIds, 2), batchTargetCount: batchTargets.length };
  }

  it('两遍的展示次序/人次文案/难度/TopN/批量集完全一致（题 id 一一对应）', async () => {
    const real = await derive(realWorld);
    const mock = await derive(mockWorld);

    // 同人次次序实现相关（true 库按 uuid 排序）→ 规范序逐字段比
    expect(real.canonical).toEqual(mock.canonical);
    expect(real.canonical.length).toBe(4);
    expect(real.canonical[0]).toBe('牛顿第二定律应用|错 3/3 人|中等');
    expect(real.canonical[1]).toBe('自由落体求落地速度|错 2/3 人|—');

    // TopN 的题 id 不同（uuid vs mock 计数 id）→ 映射回摘要再比
    const realMap = await summaryToId(realWorld);
    const mockMap = await summaryToId(mockWorld);
    const toSummaries = (ids: string[], map: Map<string, string>): string[] =>
      ids.map((id) => [...map.entries()].find(([, v]) => v === id)?.[0] ?? id);
    expect(toSummaries(real.topN2, realMap)).toEqual(toSummaries(mock.topN2, mockMap));
    expect(toSummaries(real.topN2, realMap)).toEqual(['牛顿第二定律应用', '自由落体求落地速度']);
    // 批量口入参规模一致（本班 q2×3 + q1×2 = 5 行）
    expect(real.batchTargetCount).toBe(5);
    expect(mock.batchTargetCount).toBe(real.batchTargetCount);
  });
});
