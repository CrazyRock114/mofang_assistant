// 0049 P2：首页工作足迹聚合（bank/dashboard-service 扩展）——流量口径六类动作。
// 呈现依据：home-dashboard-v3 设计稿（v3 定稿，D-068）；口径见任务书 §P2。
// 关键口径：
//   · 六类映射（WORK_CATEGORY_RULES）：proof=question.create/update/addTag/removeTag + recogRun.create；
//     compose=paper.* + paperSet.*；mistake=mistake.*；feedback=feedback.*；ai=ai.invoke；其余类型不计。
//   · 采集与录题同源不可分（OperationLogger 对 question.create 不带 metadata）→ fallback 采集并入录题，
//     'capture' 恒 0（图例五类；申报见交付报告）。本文件钉住这条 fallback。
//   · 窗口：起点=本周一 −26 周（周一对齐），末日=今日（今日为周一时恰 183 天）；零日补全、升序。
//   · streak：当日六类合计>0 计活跃；current 自今日向前、longest 窗口内最长；只计 succeeded 留痕。
//   · 沉淀曲线：现存题按 created_at 本地日累计，终点恒等 questions(deleted=0) 计数。
//   · recentPapers：papers status≠'trashed'，按 created_at 降序（表无 updated_at 列）取 3。
// 零迁移零新表：全部读既有 operation_log / questions / papers / paper_questions。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDatabase, type Database } from '../../src/bank/db.js';
import {
  getHomeDashboard,
  localDateKey,
  workWindowStart,
  workWindowKeys,
  classifyWorkOperation,
  aggregateWorkActivity,
  buildQuestionGrowth,
  WORK_CATEGORY_RULES,
  WORK_WINDOW_WEEKS,
} from '../../src/bank/dashboard-service.js';
import type { HomeWorkCategory } from '../../src/shared/contracts/bank-types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '../../src/bank/migrations');

/** 相对 now 的本地时刻：today - days 天的 hour:15（纯本地构造，免时区漂移） */
function daysAgoAt(now: Date, days: number, hour = 9): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - days, hour, 15, 0, 0);
}

const LOCAL_ZERO: Record<HomeWorkCategory, number> = {
  proof: 0, capture: 0, compose: 0, mistake: 0, feedback: 0, ai: 0,
};

describe('0049 P2-a：六类映射表（未映射类型不进分子）', () => {
  it('proof：question.create/update/addTag/removeTag + recogRun.create', () => {
    for (const t of ['question.create', 'question.update', 'question.addTag', 'question.removeTag', 'recogRun.create']) {
      expect(classifyWorkOperation(t), t).toBe('proof');
    }
  });

  it('compose：paper.* 前缀全部（含 folder 操作）+ paperSet.* 前缀', () => {
    for (const t of [
      'paper.create', 'paper.updateTitle', 'paper.trash', 'paper.restore', 'paper.deleteForever',
      'paper.folder.create', 'paper.folder.rename', 'paper.folder.delete', 'paper.moveToFolder',
      'paper.addQuestion', 'paper.setScore', 'paperSet.create', 'paperSet.addPaper', 'paperSet.delete',
    ]) {
      expect(classifyWorkOperation(t), t).toBe('compose');
    }
  });

  it('mistake / feedback / ai：前缀与全等命中', () => {
    for (const t of ['mistake.recordWrong', 'mistake.setStage', 'mistake.batchDelete', 'mistake.setNote']) {
      expect(classifyWorkOperation(t), t).toBe('mistake');
    }
    for (const t of ['feedback.create', 'feedback.update', 'feedback.delete']) {
      expect(classifyWorkOperation(t), t).toBe('feedback');
    }
    expect(classifyWorkOperation('ai.invoke')).toBe('ai');
  });

  it('未映射类型 → null（学生/班级/考试/字典/树/预设/模型档案/备份恢复/删题 均不计）', () => {
    for (const t of [
      'student.create', 'student.enroll', 'student.setStatus', 'student.addEvent',
      'class.create', 'class.update', 'exam.create', 'exam.recordScores', 'exam.recordResults',
      'dict.create', 'dict.update', 'preset.create', 'preset.update', 'modelProfile.update',
      'modelProfile.setEnabled', 'modelProfile.recordTestResult',
      'tree.create', 'tree.createNode', 'tree.linkQuestion', 'tree.unlinkQuestion',
      'tree.consolidate', 'tree.restore',
      'backup', 'restore', 'rollback',
      'question.delete', // 任务书 §P2.1 映射表未列 delete → 不计（交付报告登记）
      '',
    ]) {
      expect(classifyWorkOperation(t), t).toBeNull();
    }
  });

  it('fallback 钉桩：capture 规则为空（采集并入录题，六键保留为未来占位）', () => {
    expect(WORK_CATEGORY_RULES.capture.exact).toEqual([]);
    expect(WORK_CATEGORY_RULES.capture.prefixes).toEqual([]);
    expect(Object.keys(WORK_CATEGORY_RULES).sort()).toEqual(['ai', 'capture', 'compose', 'feedback', 'mistake', 'proof']);
  });
});

describe('0049 P2-b：窗口（周一对齐 + 零日补全）', () => {
  it('今日为周一：起点=26 周前的周一，恰 183 天（与设计稿 03-23~09-21 逐位一致）', () => {
    const now = new Date(2026, 8, 21, 14, 0, 0); // 2026-09-21 周一
    expect(workWindowStart(now).getDay()).toBe(1);
    const keys = workWindowKeys(now);
    expect(keys).toHaveLength(WORK_WINDOW_WEEKS * 7 + 1); // 183
    expect(keys[0]).toBe('2026-03-23');
    expect(keys[keys.length - 1]).toBe('2026-09-21');
  });

  it('起点恒为周一、末日恒为今日、逐日连续升序（任意星期）', () => {
    const now = new Date(2026, 8, 23, 8, 30, 0); // 2026-09-23 周三
    const start = workWindowStart(now);
    expect(localDateKey(start)).toBe('2026-03-23');
    expect(start.getDay()).toBe(1);
    const keys = workWindowKeys(now);
    expect(keys).toHaveLength(185); // 183 + 本周已过 2 天
    expect(keys[keys.length - 1]).toBe('2026-09-23');
    for (let i = 1; i < keys.length; i++) {
      const prev = new Date(`${keys[i - 1]}T00:00:00`);
      const cur = new Date(`${keys[i]}T00:00:00`);
      expect(cur.getTime() - prev.getTime()).toBe(86400000);
    }
  });

  it('跨月/跨年边界：起点仍为周一（2027-01-06 周三 → 2026-07-06 周一）', () => {
    const now = new Date(2027, 0, 6, 10, 0, 0);
    expect(localDateKey(workWindowStart(now))).toBe('2026-07-06');
  });
});

describe('0049 P2-c：按日聚合与连续天数（纯函数）', () => {
  const now = new Date(2026, 8, 21, 14, 0, 0); // 周一

  it('零日补全、升序、末位=今日；六类分桶；tokens 只落 ai 日', () => {
    const rows = [
      { operationType: 'question.create', startedAt: daysAgoAt(now, 0, 8).toISOString() },
      { operationType: 'paper.create', startedAt: daysAgoAt(now, 0, 9).toISOString() },
      { operationType: 'paper.folder.create', startedAt: daysAgoAt(now, 0, 10).toISOString() },
      { operationType: 'ai.invoke', startedAt: daysAgoAt(now, 0, 11).toISOString(), tokens: 120 },
      { operationType: 'mistake.recordWrong', startedAt: daysAgoAt(now, 2).toISOString() },
      { operationType: 'feedback.create', startedAt: daysAgoAt(now, 2).toISOString() },
      { operationType: 'student.create', startedAt: daysAgoAt(now, 1).toISOString() }, // 未映射 → 不进
      { operationType: 'question.create', startedAt: daysAgoAt(now, 200).toISOString() }, // 窗外 → 不进
    ];
    const { activity } = aggregateWorkActivity(rows, now);
    expect(activity).toHaveLength(183);
    expect(activity[0]!.date).toBe('2026-03-23');
    expect(activity[activity.length - 1]!.date).toBe('2026-09-21');
    expect(activity[activity.length - 1]!.byCategory).toEqual({ ...LOCAL_ZERO, proof: 1, compose: 2, ai: 1 });
    expect(activity[activity.length - 1]!.tokens).toBe(120);
    // 零日：昨天（student.create 未映射 → 全 0）
    expect(activity[activity.length - 2]!.byCategory).toEqual(LOCAL_ZERO);
    expect(activity[activity.length - 2]!.tokens).toBe(0);
    // 前天两笔
    expect(activity[activity.length - 3]!.byCategory).toEqual({ ...LOCAL_ZERO, mistake: 1, feedback: 1 });
  });

  it('streak：今日活跃 → current≥1；今日断档 → 0（longest 仍在窗口内）', () => {
    const active = [0, 1, 2].map((ago) => ({ operationType: 'question.create', startedAt: daysAgoAt(now, ago).toISOString() }));
    const a = aggregateWorkActivity(active, now).streak;
    expect(a.current).toBe(3);
    expect(a.longest).toBe(3);

    const gapToday = [1, 2, 3].map((ago) => ({ operationType: 'question.create', startedAt: daysAgoAt(now, ago).toISOString() }));
    const b = aggregateWorkActivity(gapToday, now).streak;
    expect(b.current).toBe(0);
    expect(b.longest).toBe(3);
  });

  it('streak：longest 取窗口内最长连续（多段断开取最大段）', () => {
    const rows = [
      ...[10, 11, 12, 13].map((ago) => ({ operationType: 'paper.create', startedAt: daysAgoAt(now, ago).toISOString() })),
      ...[30, 31].map((ago) => ({ operationType: 'feedback.create', startedAt: daysAgoAt(now, ago).toISOString() })),
      { operationType: 'question.create', startedAt: daysAgoAt(now, 0).toISOString() },
    ];
    const s = aggregateWorkActivity(rows, now).streak;
    expect(s.current).toBe(1);
    expect(s.longest).toBe(4);
  });

  it('streak：全零 → {0,0}（空库态据此隐藏 🔥）', () => {
    expect(aggregateWorkActivity([], now).streak).toEqual({ current: 0, longest: 0 });
  });

  it('窗外行不进 streak（当前连击不向窗口外回溯）', () => {
    const rows = [0, 1].map((ago) => ({ operationType: 'question.create', startedAt: daysAgoAt(now, ago).toISOString() }))
      .concat([{ operationType: 'question.create', startedAt: daysAgoAt(now, 183).toISOString() }]);
    expect(aggregateWorkActivity(rows, now).streak.current).toBe(2);
  });
});

describe('0049 P2-d：沉淀曲线（累计、终点恒等题库计数）', () => {
  const now = new Date(2026, 8, 21, 14, 0, 0);

  it('窗口前的题计入基线；窗口内按日累计；终点=总题数', () => {
    const created = [
      daysAgoAt(now, 300).toISOString(),  // 窗口前 → 基线
      daysAgoAt(now, 183).toISOString(),  // 窗口前 1 天 → 基线
      daysAgoAt(now, 182).toISOString(),  // 窗口首日
      daysAgoAt(now, 5).toISOString(),
      daysAgoAt(now, 5, 20).toISOString(), // 同日两题
      daysAgoAt(now, 0).toISOString(),
    ];
    const growth = buildQuestionGrowth(created, now);
    expect(growth).toHaveLength(183);
    expect(growth[0]).toEqual({ date: '2026-03-23', total: 3 }); // 2 基线 + 窗口首日 1
    expect(growth[growth.length - 1]!.total).toBe(6);             // 恒等总题数
    for (let i = 1; i < growth.length; i++) {
      expect(growth[i]!.total).toBeGreaterThanOrEqual(growth[i - 1]!.total); // 单调不减
    }
    expect(growth[growth.length - 6]!.total).toBe(5); // 9/16 = 5 题（到 5 天前那两题）
  });

  it('空数组 → 全 0（空库态）', () => {
    const growth = buildQuestionGrowth([], now);
    expect(growth.every((p) => p.total === 0)).toBe(true);
    expect(growth).toHaveLength(183);
  });

  it('未来日期（时钟偏差）也计入终点，终点仍恒等总题数', () => {
    const created = [daysAgoAt(now, 0).toISOString(), new Date(now.getTime() + 86400000 * 3).toISOString()];
    const growth = buildQuestionGrowth(created, now);
    expect(growth[growth.length - 1]!.total).toBe(2);
  });
});

describe('0049 P2-e：getHomeDashboard 真库（足迹四组字段 + 既有 7 字段不回归）', () => {
  let db: Database;
  let tempDir: string;
  const now = new Date();

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dash-0049-'));
    db = openDatabase(join(tempDir, 'test.db'), migrationsDir);
  });
  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function insertQuestion(id: string, createdAt: Date, deleted = 0): void {
    db.prepare(
      `INSERT INTO questions (id, subject, source_type, source_detail, content, created_at, updated_at, deleted)
       VALUES (?, 'physics', 'local', 'test', '题面', ?, ?, ?)`,
    ).run(id, createdAt.toISOString(), createdAt.toISOString(), deleted);
  }

  function insertPaper(id: string, status: string, createdAt: Date): void {
    db.prepare(
      `INSERT INTO papers (id, title, created_at, status) VALUES (?, ?, ?, ?)`,
    ).run(id, `卷-${id}`, createdAt.toISOString(), status);
  }

  function linkQuestion(paperId: string, questionId: string, position: number): void {
    db.prepare(
      `INSERT INTO paper_questions (id, paper_id, question_id, position) VALUES (?, ?, ?, ?)`,
    ).run(`${paperId}-${questionId}`, paperId, questionId, position);
  }

  function insertOp(opts: { type: string; at: Date; status?: 'succeeded' | 'failed'; tokens?: number }): void {
    const meta = opts.tokens === undefined ? {} : { tokens: { totalTokens: opts.tokens } };
    db.prepare(
      `INSERT INTO operation_log (id, operation_type, started_at, finished_at, status, affected_count, description, metadata_json)
       VALUES (?, ?, ?, ?, ?, 0, '足迹夹具', ?)`,
    ).run(
      crypto.randomUUID(), opts.type, opts.at.toISOString(), opts.at.toISOString(),
      opts.status ?? 'succeeded', JSON.stringify(meta),
    );
  }

  it('activity 六类合计与 operation_log 手工 SQL 复核一致；未映射/失败/窗外不计', () => {
    insertOp({ type: 'question.create', at: daysAgoAt(now, 0, 8) });
    insertOp({ type: 'question.addTag', at: daysAgoAt(now, 0, 9) });
    insertOp({ type: 'recogRun.create', at: daysAgoAt(now, 1) });
    insertOp({ type: 'paper.create', at: daysAgoAt(now, 3) });
    insertOp({ type: 'paper.folder.delete', at: daysAgoAt(now, 3) });
    insertOp({ type: 'paperSet.addPaper', at: daysAgoAt(now, 3) });
    insertOp({ type: 'mistake.recordWrong', at: daysAgoAt(now, 4) });
    insertOp({ type: 'feedback.create', at: daysAgoAt(now, 5) });
    insertOp({ type: 'ai.invoke', at: daysAgoAt(now, 6), tokens: 500 });
    insertOp({ type: 'ai.invoke', at: daysAgoAt(now, 6), tokens: 250 });
    insertOp({ type: 'student.create', at: daysAgoAt(now, 0, 10) });         // 未映射
    insertOp({ type: 'question.removeTag', at: daysAgoAt(now, 0, 11), status: 'failed' }); // 失败
    insertOp({ type: 'question.create', at: daysAgoAt(now, 200) });          // 窗外

    const dash = getHomeDashboard(db, now);
    const totals = dash.activity.reduce((acc, d) => {
      for (const k of Object.keys(d.byCategory) as HomeWorkCategory[]) acc[k] += d.byCategory[k];
      return acc;
    }, { ...LOCAL_ZERO });
    // 手工 SQL：窗口起点独立重算（本周一 −26 周），只认成功且命中映射表的行
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
    const windowStartIso = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - 182).toISOString();
    const manual = db.prepare(
      `SELECT COUNT(*) AS n FROM operation_log
       WHERE status = 'succeeded' AND started_at >= ?
         AND (operation_type IN ('question.create','question.update','question.addTag','question.removeTag','recogRun.create')
              OR operation_type LIKE 'paper.%' OR operation_type LIKE 'paperSet.%'
              OR operation_type LIKE 'mistake.%' OR operation_type LIKE 'feedback.%')`,
    ).get(windowStartIso) as { n: number };
    const manualAi = db.prepare(
      `SELECT COUNT(*) AS n FROM operation_log WHERE status = 'succeeded' AND operation_type = 'ai.invoke' AND started_at >= ?`,
    ).get(windowStartIso) as { n: number };
    const mapped = totals.proof + totals.compose + totals.mistake + totals.feedback;
    expect(mapped).toBe(manual.n);           // proof3 + compose3 + mistake1 + feedback1 = 8
    expect(totals.proof).toBe(3);            // 含 recogRun.create；失败的 removeTag 与窗外 create 不计
    expect(totals.capture).toBe(0);          // fallback：采集并录题
    expect(totals.ai).toBe(manualAi.n);
    // tokens 按日落 ai 日
    expect(dash.activity[dash.activity.length - 1]!.tokens).toBe(0);
    expect(dash.activity[dash.activity.length - 7]!.tokens).toBe(750);
    // 窗口长度与末日
    expect(dash.activity[dash.activity.length - 1]!.date).toBe(localDateKey(now));
    expect(dash.activity[0]!.date).toBe(localDateKey(workWindowStart(now)));
  });

  it('streak 手算复核：真库跨 3 日活跃 → current=3；窗口内最长另算', () => {
    for (const ago of [0, 1, 2]) insertOp({ type: 'question.create', at: daysAgoAt(now, ago, 12) });
    for (const ago of [20, 21, 22, 23, 24]) insertOp({ type: 'paper.create', at: daysAgoAt(now, ago, 12) });
    const dash = getHomeDashboard(db, now);
    expect(dash.streak.current).toBe(3);
    expect(dash.streak.longest).toBe(5);
  });

  it('questionGrowth 终点恒等 questions(deleted=0) 计数；已删题不回溯计入', () => {
    insertQuestion('q1', daysAgoAt(now, 300));      // 窗口前
    insertQuestion('q2', daysAgoAt(now, 100));
    insertQuestion('q3', daysAgoAt(now, 0));
    insertQuestion('q-del', daysAgoAt(now, 50), 1); // 已删 → 不计
    const dash = getHomeDashboard(db, now);
    const live = (db.prepare('SELECT COUNT(*) AS n FROM questions WHERE deleted = 0').get() as { n: number }).n;
    expect(live).toBe(3);
    expect(dash.questionGrowth[dash.questionGrowth.length - 1]!.total).toBe(live);
    expect(dash.questionGrowth[dash.questionGrowth.length - 1]!.total).toBe(dash.questions); // 与资产卡大数字同源
    expect(dash.questionGrowth[0]!.total).toBe(1); // 窗口前 1 题为基线
  });

  it('recentPapers：排除回收站、按最新创建降序取 3、questionCount 为挂题计数', () => {
    insertQuestion('qa', daysAgoAt(now, 10));
    insertQuestion('qb', daysAgoAt(now, 9));
    insertPaper('p-old', 'done', daysAgoAt(now, 30));
    insertPaper('p-mid', 'composing', daysAgoAt(now, 5));
    insertPaper('p-new', 'basket', daysAgoAt(now, 1));
    insertPaper('p-trash', 'trashed', daysAgoAt(now, 0)); // 回收站 → 排除
    linkQuestion('p-mid', 'qa', 0);
    linkQuestion('p-mid', 'qb', 1);

    const dash = getHomeDashboard(db, now);
    expect(dash.recentPapers.map((p) => p.id)).toEqual(['p-new', 'p-mid', 'p-old']);
    expect(dash.recentPapers[1]!.questionCount).toBe(2);
    expect(dash.recentPapers[0]!.questionCount).toBe(0);
    expect(dash.recentPapers[1]!.status).toBe('composing');
    expect(dash.recentPapers[1]!.title).toBe('卷-p-mid');
    expect(dash.recentPapers[1]!.updatedAt).toBe(daysAgoAt(now, 5).toISOString());
  });

  it('空库：四组字段各自空态（activity 全零 / streak 0 / growth 全 0 / recentPapers 空）', () => {
    const dash = getHomeDashboard(db, now);
    expect(dash.activity.length).toBe(workWindowKeys(now).length);
    expect(dash.activity.every((d) => d.tokens === 0 && Object.values(d.byCategory).every((v) => v === 0))).toBe(true);
    expect(dash.streak).toEqual({ current: 0, longest: 0 });
    expect(dash.questionGrowth.every((p) => p.total === 0)).toBe(true);
    expect(dash.recentPapers).toEqual([]);
  });

  it('既有 7 字段零回归（四指标 + AI 累计 + aiDaily 仍在）', () => {
    insertQuestion('q1', daysAgoAt(now, 1));
    insertPaper('p1', 'done', daysAgoAt(now, 2));
    insertOp({ type: 'ai.invoke', at: daysAgoAt(now, 0, 8), tokens: 42 });
    const dash = getHomeDashboard(db, now);
    expect(dash.questions).toBe(1);
    expect(dash.papers).toBe(1);
    expect(dash.aiInvocations).toBe(1);
    expect(dash.aiTokens).toBe(42);
    expect(dash.aiDaily).toHaveLength(30);
    expect(dash.aiDaily[dash.aiDaily.length - 1]!.tokens).toBe(42);
  });
});
