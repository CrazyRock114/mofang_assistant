// 0025 P1/P3：错题闭环数据层契约测试 — 参数化跑两遍（真实 SQLite + mock 内存），两遍必须同绿。
// 覆盖（0025 任务书 §四）：
// - 聚合正确性：3 生 × 4 题 × 部分重叠错题固定数据集；人次计数/去重/排序/各过滤器单独与组合
// - 批量操作：批量删除/改 stage 的行数与 operation_log 留痕（类型/条数/状态）逐字段断言
// - question_id 集导出：去重 + 次序（供 0026 入篮）
// - batch_meta：合法结构往返、未登记键容忍（既有语义）、非法结构拒绝、坏数据读出显式报错
// 固定数据集（时刻均为 UTC ISO；q1-q3 物理、q4 化学）：
//   q1 × s1 red 09-01 / q1 × s2 red 09-05
//   q2 × s1 red 09-02 / q2 × s2 yellow 09-06 / q2 × s3 red 09-10
//   q3 × s2 green 09-03
//   q4 × s3 red 09-20 / q4 × s1 red 09-21

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BankService, BankExtServices, MistakeBatchResult, PaperSetBatchMeta } from '../../src/shared/contracts/bank-types.js';
import { openDatabase } from '../../src/bank/db.js';
import { BankServiceImpl } from '../../src/bank/bank-service.js';
import { createExtServices } from '../../src/bank/ext-services.js';
import { MockBankService } from '../../src/bank/mock/mock-bank.js';
import { createMockExtServices } from '../../src/bank/mock/mock-ext.js';
import { MockBankStore } from '../../src/bank/mock/mock-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '../../src/bank/migrations');

interface OpLogRow {
  operationType: string;
  status: string;
  affectedCount: number;
  description: string;
}

interface MistakeLoopCtx {
  bank: BankService;
  ext: BankExtServices;
  /** operation_log 留痕（真实=查表；mock=store.logs） */
  readOpLogs: () => OpLogRow[];
  /** 往 paper_sets.batch_meta 塞坏数据（真实=坏 JSON 原文；mock=结构非法对象） */
  poisonBatchMeta: (setId: string, raw: string) => void;
  cleanup: () => void;
}

const implementations: Array<{ name: string; factory: () => MistakeLoopCtx }> = [
  {
    name: 'Real (SQLite)',
    factory: () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'mistake-loop-test-'));
      const db = openDatabase(join(tempDir, 'test.db'), migrationsDir);
      return {
        bank: new BankServiceImpl(db),
        ext: createExtServices(db),
        readOpLogs: () => db.prepare(
          `SELECT operation_type AS operationType, status, affected_count AS affectedCount, description
           FROM operation_log ORDER BY started_at, rowid`,
        ).all() as OpLogRow[],
        poisonBatchMeta: (setId, raw) => {
          db.prepare('UPDATE paper_sets SET batch_meta = ? WHERE id = ?').run(raw, setId);
        },
        cleanup: () => {
          db.close();
          rmSync(tempDir, { recursive: true, force: true });
        },
      };
    },
  },
  {
    name: 'Mock (in-memory)',
    factory: () => {
      const store = new MockBankStore();
      return {
        bank: new MockBankService(store),
        ext: createMockExtServices(store),
        readOpLogs: () => store.logs.map((l) => ({
          operationType: l.type,
          status: l.status,
          affectedCount: l.affectedCount ?? 0,
          description: l.description,
        })),
        poisonBatchMeta: (setId, raw) => {
          const set = store.paperSets.get(setId);
          if (!set) throw new Error(`Paper set ${setId} not found`);
          // 结构非法（perStudentLimit 是字符串）——mock 无 JSON 层，故污染结构本身
          store.paperSets.set(setId, { ...set, batchMeta: { perStudentLimit: raw } });
        },
        cleanup: () => {},
      };
    },
  },
];

function makeQuestionData(subject: string, content: string, extra: Record<string, string | number> = {}) {
  return {
    subject,
    sourceType: 'local' as const,
    sourceDetail: { origin: 'mistake-loop-test' },
    content,
    images: [],
    ...extra,
  };
}

/** 同人次内按题号升序（SQLite BINARY 序）——固定数据集的题 id 是 uuid，断言不得写死插入序 */
function expectTiers(tiers: Array<[string[], number]>): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  for (const [ids, count] of tiers) {
    [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).forEach((id) => out.push([id, count]));
  }
  return out;
}

const LONG_STEM = '甲乙两物体在同一直线上运动，甲的速度为每秒三米，乙的速度为每秒五米，'
  + '两物体同时从同一地点出发，求两物体相遇时的位置与所需时间以及平均速度大小；'
  + '若两物体速度同时加倍而其他条件不变，再求相遇位置与所用时间，并说明两次结果的比值关系';

interface Fixture {
  q1: string; q2: string; q3: string; q4: string;
  s1: string; s2: string; s3: string;
  m1: string; m2: string; m3: string; m4: string; m5: string; m6: string; m7: string; m8: string;
}

async function seedFixture(ctx: MistakeLoopCtx): Promise<Fixture> {
  const { bank, ext } = ctx;
  const q1 = await bank.createQuestion(makeQuestionData('物理', '<div class="question">小球自由落体求落地速度</div>', {
    stemHtml: '<div class="question">小球自由落体求落地速度</div>',
    questionType: '单选题',
    difficulty: 0.4,
  }));
  const q2 = await bank.createQuestion(makeQuestionData('物理', '<p>牛顿第二定律：加速度与合外力成正比</p>', {
    stemHtml: '<p>牛顿第二定律：加速度与合外力成正比</p>',
    questionType: '多选题',
    difficulty: 0.6,
  }));
  // 仅 content（无 stemHtml）→ 摘要回落 content；长题干 → 截断
  const q3 = await bank.createQuestion(makeQuestionData('物理', LONG_STEM, {
    questionType: '填空题',
    difficulty: 0.3,
  }));
  const q4 = await bank.createQuestion(makeQuestionData('化学', '<p><span class="math" data-tex="2H_2+O_2=2H_2O">水的合成</span></p>', {
    stemHtml: '<p><span class="math" data-tex="2H_2+O_2=2H_2O">水的合成</span></p>',
    questionType: '单选题',
    difficulty: 0.5,
  }));

  const s1 = await ext.student.createStudent({ name: '学生甲' });
  const s2 = await ext.student.createStudent({ name: '学生乙' });
  const s3 = await ext.student.createStudent({ name: '学生丙' });

  const rec = async (questionId: string, studentId: string, occurredAt: string): Promise<string> => {
    const res = await ext.mistake.recordWrong({ questionId, studentId, occurredAt });
    return res.mistake.id;
  };
  const m1 = await rec(q1.id, s1.id, '2026-09-01T08:00:00.000Z');
  const m2 = await rec(q1.id, s2.id, '2026-09-05T08:00:00.000Z');
  const m3 = await rec(q2.id, s1.id, '2026-09-02T08:00:00.000Z');
  const m4 = await rec(q2.id, s2.id, '2026-09-06T08:00:00.000Z');
  const m5 = await rec(q2.id, s3.id, '2026-09-10T08:00:00.000Z');
  const m6 = await rec(q3.id, s2.id, '2026-09-03T08:00:00.000Z');
  const m7 = await rec(q4.id, s3.id, '2026-09-20T08:00:00.000Z');
  const m8 = await rec(q4.id, s1.id, '2026-09-21T08:00:00.000Z');
  await ext.mistake.setStage(m4, 'yellow');
  await ext.mistake.setStage(m6, 'green');

  return {
    q1: q1.id, q2: q2.id, q3: q3.id, q4: q4.id,
    s1: s1.id, s2: s2.id, s3: s3.id,
    m1, m2, m3, m4, m5, m6, m7, m8,
  };
}

implementations.forEach(({ name, factory }) => {
  describe(`0025 错题闭环数据层 - ${name}`, () => {
    let ctx: MistakeLoopCtx;
    let bank: BankService;
    let ext: BankExtServices;
    let fx: Fixture;

    beforeEach(async () => {
      ctx = factory();
      bank = ctx.bank;
      ext = ctx.ext;
      fx = await seedFixture(ctx);
    });

    afterEach(() => {
      ctx.cleanup();
    });

    // ==================== P1 聚合：人次计数/去重/排序/过滤器 ====================

    describe('P1 错误人次聚合', () => {
      it('默认口径：按 question_id 聚合 COUNT(DISTINCT student_id)，人次降序、同人次按题号升序', async () => {
        const rows = await ext.mistake.aggregateByQuestion();
        expect(rows.map((r) => [r.questionId, r.wrongCount])).toEqual(expectTiers([
          [[fx.q2], 3], [[fx.q1, fx.q4], 2], [[fx.q3], 1],
        ]));
        expect(rows.map((r) => r.wrongCount)).toEqual([3, 2, 2, 1]);
      });

      it('人次=去重学生数（同生同题只算 1 人次）；带题面字段与首末错误时间', async () => {
        const rows = await ext.mistake.aggregateByQuestion();
        const q2Row = rows.find((r) => r.questionId === fx.q2)!;
        expect(q2Row.wrongCount).toBe(3); // s1/s2/s3 —— 一生一题唯一关系，重复登记不叠加
        expect(q2Row.subject).toBe('物理');
        expect(q2Row.questionType).toBe('多选题');
        expect(q2Row.difficulty).toBe(0.6);
        expect(q2Row.firstOccurredAt).toBe('2026-09-02T08:00:00.000Z');
        expect(q2Row.lastOccurredAt).toBe('2026-09-10T08:00:00.000Z');
      });

      it('题干摘要：strip HTML；无 stemHtml 回落 content；超长截断', async () => {
        const rows = await ext.mistake.aggregateByQuestion();
        const byId = new Map(rows.map((r) => [r.questionId, r]));
        expect(byId.get(fx.q1)!.stemSummary).toBe('小球自由落体求落地速度');
        expect(byId.get(fx.q4)!.stemSummary).toBe('水的合成');
        const longSummary = byId.get(fx.q3)!.stemSummary;
        expect(longSummary.startsWith('甲乙两物体在同一直线上运动')).toBe(true);
        expect(longSummary.length).toBeLessThanOrEqual(81); // 80 字 + 省略号
        expect(longSummary.endsWith('…')).toBe(true);
      });

      it('stage 过滤：单档命中，人次按过滤后口径重算', async () => {
        expect((await ext.mistake.aggregateByQuestion({ stage: 'yellow' })).map((r) => [r.questionId, r.wrongCount]))
          .toEqual([[fx.q2, 1]]);
        expect((await ext.mistake.aggregateByQuestion({ stage: 'green' })).map((r) => [r.questionId, r.wrongCount]))
          .toEqual([[fx.q3, 1]]);
        expect((await ext.mistake.aggregateByQuestion({ stage: 'red' })).map((r) => [r.questionId, r.wrongCount]))
          .toEqual(expectTiers([[[fx.q1, fx.q2, fx.q4], 2]]));
      });

      it('学科过滤：按 questions.subject 精确匹配', async () => {
        expect((await ext.mistake.aggregateByQuestion({ subject: '化学' })).map((r) => [r.questionId, r.wrongCount]))
          .toEqual([[fx.q4, 2]]);
        expect((await ext.mistake.aggregateByQuestion({ subject: '物理' })).map((r) => [r.questionId, r.wrongCount]))
          .toEqual([[fx.q2, 3], [fx.q1, 2], [fx.q3, 1]]);
      });

      it('时间窗过滤：date-only 边界按当日全含（下界 00:00 / 上界 23:59:59.999）', async () => {
        expect((await ext.mistake.aggregateByQuestion({ occurredFrom: '2026-09-06' })).map((r) => [r.questionId, r.wrongCount]))
          .toEqual(expectTiers([[[fx.q2, fx.q4], 2]]));
        expect((await ext.mistake.aggregateByQuestion({ occurredTo: '2026-09-03' })).map((r) => [r.questionId, r.wrongCount]))
          .toEqual(expectTiers([[[fx.q1, fx.q2, fx.q3], 1]]));
        expect((await ext.mistake.aggregateByQuestion({
          occurredFrom: '2026-09-04', occurredTo: '2026-09-06',
        })).map((r) => [r.questionId, r.wrongCount])).toEqual(expectTiers([[[fx.q1, fx.q2], 1]]));
      });

      it('学生集合过滤：OR 语义（D1 勾选学生导出用）', async () => {
        expect((await ext.mistake.aggregateByQuestion({ studentIds: [fx.s1] })).map((r) => [r.questionId, r.wrongCount]))
          .toEqual(expectTiers([[[fx.q1, fx.q2, fx.q4], 1]]));
        expect((await ext.mistake.aggregateByQuestion({ studentIds: [fx.s1, fx.s3] })).map((r) => [r.questionId, r.wrongCount]))
          .toEqual(expectTiers([[[fx.q2, fx.q4], 2], [[fx.q1], 1]]));
      });

      it('过滤器组合：学科 + stage 同时生效', async () => {
        const rows = await ext.mistake.aggregateByQuestion({ subject: '物理', stage: 'red' });
        expect(rows.map((r) => [r.questionId, r.wrongCount])).toEqual(expectTiers([[[fx.q1, fx.q2], 2]]));
      });

      it('无命中 → 空数组（不抛错）', async () => {
        expect(await ext.mistake.aggregateByQuestion({ occurredFrom: '2027-01-01' })).toEqual([]);
        expect(await ext.mistake.aggregateByQuestion({ subject: '不存在的学科' })).toEqual([]);
      });

      it('导出题 id 集：去重 + 次序同聚合（0026 入篮按序切片）', async () => {
        expect(await ext.mistake.exportQuestionIds()).toEqual(
          expectTiers([[[fx.q2], 3], [[fx.q1, fx.q4], 2], [[fx.q3], 1]]).map(([id]) => id),
        );
        expect(await ext.mistake.exportQuestionIds({ subject: '化学' })).toEqual([fx.q4]);
        expect(await ext.mistake.exportQuestionIds({ stage: 'red' })).toEqual(
          expectTiers([[[fx.q1, fx.q2, fx.q4], 2]]).map(([id]) => id),
        );
        expect(await ext.mistake.exportQuestionIds({ occurredFrom: '2027-01-01' })).toEqual([]);
      });
    });

    // ==================== P1 批量操作 + operation_log 留痕 ====================

    describe('P1 错题批量操作', () => {
      it('批量改 stage：返回影响条数，逐行落库', async () => {
        const res: MistakeBatchResult = await ext.mistake.setStages([fx.m1, fx.m2, fx.m3], 'yellow');
        expect(res.affectedCount).toBe(3);
        const yellow = await ext.mistake.listMistakes({ stage: 'yellow' });
        expect(yellow.map((m) => m.id).sort()).toEqual([fx.m1, fx.m2, fx.m3, fx.m4].sort());
        expect((await ext.mistake.getMistake(fx.m1))!.stage).toBe('yellow');
      });

      it('批量删除：返回影响条数，行为硬删（题/生不受影响）', async () => {
        const res = await ext.mistake.deleteMistakes([fx.m1, fx.m2]);
        expect(res.affectedCount).toBe(2);
        expect(await ext.mistake.getMistake(fx.m1)).toBeNull();
        expect(await ext.mistake.getMistake(fx.m2)).toBeNull();
        expect((await ext.mistake.listMistakes()).length).toBe(6);
        expect(await bank.getQuestion(fx.q1)).not.toBeNull();
        expect(await ext.student.getStudent(fx.s1)).not.toBeNull();
      });

      it('批量删除幂等：不存在的 id 跳过，只计实际删除数', async () => {
        const res = await ext.mistake.deleteMistakes([fx.m3, 'no-such-mistake-id']);
        expect(res.affectedCount).toBe(1);
        expect(await ext.mistake.getMistake(fx.m3)).toBeNull();
      });

      it('空 id 集 → 显式拒绝（不写操作日志，不静默返回 0）', async () => {
        const before = ctx.readOpLogs().filter((l) => l.operationType.startsWith('mistake.batch')).length;
        await expect(ext.mistake.deleteMistakes([])).rejects.toThrow(/ids/);
        await expect(ext.mistake.setStages([], 'yellow')).rejects.toThrow(/ids/);
        const after = ctx.readOpLogs().filter((l) => l.operationType.startsWith('mistake.batch')).length;
        expect(after).toBe(before);
      });

      it('非法 stage → 显式拒绝', async () => {
        await expect(ext.mistake.setStages([fx.m1], 'purple' as never)).rejects.toThrow(/stage/);
      });

      it('operation_log 留痕：类型/条数/状态逐字段对齐', async () => {
        await ext.mistake.setStages([fx.m1, fx.m2, fx.m3], 'yellow');
        await ext.mistake.deleteMistakes([fx.m1, fx.m2]);

        const logs = ctx.readOpLogs().filter((l) => l.operationType.startsWith('mistake.batch'));
        expect(logs.map((l) => l.operationType)).toEqual(['mistake.batchSetStage', 'mistake.batchDelete']);
        expect(logs.map((l) => l.affectedCount)).toEqual([3, 2]);
        expect(logs.map((l) => l.status)).toEqual(['succeeded', 'succeeded']);
        expect(logs[0].description).toContain('3');
        expect(logs[1].description).toContain('2');
      });
    });

    // ==================== P3 batch_meta 类型化 ====================

    describe('P3 batch_meta', () => {
      it('合法结构往返：写入即校验，读出原样（含类型化视图）', async () => {
        const meta: PaperSetBatchMeta = { perStudentLimit: 3, timeWindowDays: 30, sourceRule: 'stage=red&subject=物理' };
        const set = await ext.paperSet.createPaperSet({ name: '错题卷批次', type: 'custom-mistake', batchMeta: { ...meta } });
        expect(set.batchMeta).toEqual(meta);
        expect((await ext.paperSet.getPaperSet(set.id))!.batchMeta).toEqual(meta);
        const listed = (await ext.paperSet.listPaperSets({ type: 'custom-mistake' })).find((s) => s.id === set.id)!;
        expect(listed.batchMeta).toEqual(meta);
      });

      it('未登记键容忍（既有语义兼容，不静默丢弃）', async () => {
        const set = await ext.paperSet.createPaperSet({
          name: '历史批次', type: 'uniform', batchMeta: { exam: '期末' },
        });
        expect((await ext.paperSet.getPaperSet(set.id))!.batchMeta).toEqual({ exam: '期末' });
      });

      it.each([
        ['perStudentLimit 负数', { perStudentLimit: -1 }],
        ['perStudentLimit 非整数', { perStudentLimit: 1.5 }],
        ['perStudentLimit 非数值', { perStudentLimit: '3' }],
        ['perStudentLimit 零', { perStudentLimit: 0 }],
        ['timeWindowDays 负数', { timeWindowDays: -7 }],
        ['timeWindowDays 非数值', { timeWindowDays: '30' }],
        ['sourceRule 空串', { sourceRule: '' }],
        ['sourceRule 非字符串', { sourceRule: 7 }],
        ['batchMeta 非对象', 'not-an-object'],
        ['batchMeta 数组', [1, 2]],
      ])('非法结构拒绝：%s', async (_label, bad) => {
        await expect(ext.paperSet.createPaperSet({
          name: '非法批次', type: 'custom-mistake', batchMeta: bad as never,
        })).rejects.toThrow(/batch_meta/);
      });

      it('坏数据读出显式报错（不静默回落 undefined）', async () => {
        const set = await ext.paperSet.createPaperSet({ name: '待污染', type: 'uniform' });
        ctx.poisonBatchMeta(set.id, '{not-json');
        await expect(ext.paperSet.getPaperSet(set.id)).rejects.toThrow(/batch_meta/);
        await expect(ext.paperSet.listPaperSets()).rejects.toThrow(/batch_meta/);
      });
    });
  });
});
