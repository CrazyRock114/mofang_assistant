// 0037 P1 + 目检返工（2026-09-21 意见 #4/#5）：首页沉淀统计聚合（bank/dashboard-service）。
// 指标口径（目检意见 #4 拍板）：
//   题库题目 = questions 未删除（deleted=0）；试卷库 = papers 不含回收站（status≠'trashed'）；
//   录入文档 = recog_runs 行数（录题工作台识别记录，每识别一份文件计一篇，不分状态）；
//   错题沉淀 = mistakes 行数（学生×题，与错题本页「学生状态」口径一致）。
//   （原「网络采集」指标随目检意见 #4 撤下。）
// AI 用量 = operation_log 中 operation_type='ai.invoke' 且 status='succeeded'（写入点 shell/ai），
//   token 取 metadata_json.tokens（供应商未返回不计入）；次数/token 为全期累计，30 天窗只作用趋势。
// 目检意见 #5：趋势按日聚合升级为 {count, tokens} 双值（悬停弹窗需当日 token）；
//   时间窗过滤为纯函数（本地日、零日补 0、升序、末位=今日、含第 30 天边界）。零迁移零新表。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDatabase, type Database } from '../../src/bank/db.js';
import { OperationLogger } from '../../src/bank/operation-log.js';
import {
  getHomeDashboard,
  localDateKey,
  bucketInvocationsByDay,
  AI_DAILY_WINDOW_DAYS,
} from '../../src/bank/dashboard-service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '../../src/bank/migrations');

/** 相对 now 的本地时刻：today - days 天的 hour:15（纯本地构造，免时区漂移） */
function daysAgoAt(now: Date, days: number, hour = 9): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - days, hour, 15, 0, 0);
}

describe('0037 P1：dashboard 纯函数（时间窗过滤/按日聚合，返工 #5 双值）', () => {
  const now = new Date(2026, 8, 21, 14, 0, 0); // 2026-09-21 14:00 本地

  it('localDateKey：本地日期键 YYYY-MM-DD（不看时分秒）', () => {
    expect(localDateKey(new Date(2026, 8, 21, 8, 5))).toBe('2026-09-21');
    expect(localDateKey(new Date(2026, 0, 2, 23, 59))).toBe('2026-01-02');
  });

  it('bucketInvocationsByDay：30 天窗、零日补 0、升序、末位=今日；按日 {count, tokens} 双值', () => {
    const rows = [
      { startedAt: daysAgoAt(now, 0, 8).toISOString(), tokens: 10 },
      { startedAt: daysAgoAt(now, 0, 20).toISOString(), tokens: 20 },
      { startedAt: daysAgoAt(now, 3).toISOString(), tokens: 5 },
      { startedAt: daysAgoAt(now, 29).toISOString(), tokens: 7 }, // 窗口边界（第 30 天）——含
      { startedAt: daysAgoAt(now, 30).toISOString(), tokens: 1 }, // 窗口外——排除
      { startedAt: daysAgoAt(now, 90).toISOString(), tokens: 1 }, // 远古——排除
    ];
    const buckets = bucketInvocationsByDay(rows, now);
    expect(buckets).toHaveLength(AI_DAILY_WINDOW_DAYS);
    // 升序且末位=今日（双值聚合）
    expect(buckets[buckets.length - 1]).toEqual({ date: localDateKey(now), count: 2, tokens: 30 });
    expect(buckets[buckets.length - 1 - 3]).toEqual({ date: localDateKey(daysAgoAt(now, 3)), count: 1, tokens: 5 });
    expect(buckets[0]).toEqual({ date: localDateKey(daysAgoAt(now, 29)), count: 1, tokens: 7 });
    // 零日补 0（如昨天）
    expect(buckets[buckets.length - 2]).toEqual({ date: localDateKey(daysAgoAt(now, 1)), count: 0, tokens: 0 });
    // 逐日日期严格递增（升序无重复）
    for (let i = 1; i < buckets.length; i++) {
      expect(buckets[i]!.date > buckets[i - 1]!.date).toBe(true);
    }
  });

  it('bucketInvocationsByDay：窗口起点=本地零点，恰在起点的行含、起点前 1ms 的行不含', () => {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29, 0, 0, 0, 0);
    const rows = [
      { startedAt: start.toISOString(), tokens: 9 },                    // 恰在窗口起点 → 含
      { startedAt: new Date(start.getTime() - 1).toISOString(), tokens: 99 }, // 起点前 1ms → 不含
    ];
    const buckets = bucketInvocationsByDay(rows, now);
    expect(buckets[0]).toEqual({ date: localDateKey(start), count: 1, tokens: 9 });
    expect(buckets.reduce((sum, b) => sum + b.count, 0)).toBe(1);
    expect(buckets.reduce((sum, b) => sum + b.tokens, 0)).toBe(9);
  });
});

describe('0037 P1：getHomeDashboard 真库固定数据集（返工 #4 指标换血）', () => {
  let db: Database;
  let tempDir: string;
  const now = new Date();

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dash-0037-'));
    db = openDatabase(join(tempDir, 'test.db'), migrationsDir);
  });
  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** questions 夹具（最小必填列） */
  function insertQuestion(id: string, sourceType: 'network' | 'local', deleted = 0): void {
    db.prepare(
      `INSERT INTO questions (id, subject, source_type, source_detail, content, created_at, updated_at, deleted)
       VALUES (?, 'physics', ?, 'test', '题面', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', ?)`,
    ).run(id, sourceType, deleted);
  }

  function insertPaper(id: string, status: string): void {
    db.prepare(
      `INSERT INTO papers (id, title, created_at, status) VALUES (?, ?, '2026-09-01T00:00:00Z', ?)`,
    ).run(id, `卷-${id}`, status);
  }

  function insertStudent(id: string): void {
    db.prepare(
      `INSERT INTO students (id, name, created_at, updated_at) VALUES (?, ?, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`,
    ).run(id, `学生-${id}`);
  }

  function insertMistake(id: string, questionId: string, studentId: string): void {
    db.prepare(
      `INSERT INTO mistakes (id, question_id, student_id, occurred_at, stage, snapshot_json, created_at, updated_at)
       VALUES (?, ?, ?, '2026-09-05T00:00:00Z', 'red', '{}', '2026-09-05T00:00:00Z', '2026-09-05T00:00:00Z')`,
    ).run(id, questionId, studentId);
  }

  /** 录入文档夹具：recog_runs 行（每行=一份文件的识别记录，不分状态） */
  function insertRun(id: string, status: string): void {
    db.prepare(
      `INSERT INTO recog_runs (id, status, stage, source_kind, created_at, updated_at)
       VALUES (?, ?, ?, 'image', '2026-09-10T00:00:00Z', '2026-09-10T00:00:00Z')`,
    ).run(id, status, status);
  }

  /** 留痕夹具：直接指定 started_at（OperationLogger 只能记当前时刻） */
  function insertInvoke(opts: {
    at: Date;
    status?: 'succeeded' | 'failed';
    type?: string;
    tokens?: number;
  }): void {
    const tokens = opts.tokens === undefined
      ? {}
      : { tokens: { promptTokens: Math.floor(opts.tokens / 2), completionTokens: opts.tokens - Math.floor(opts.tokens / 2), totalTokens: opts.tokens } };
    db.prepare(
      `INSERT INTO operation_log (id, operation_type, started_at, finished_at, status, affected_count, description, metadata_json)
       VALUES (?, ?, ?, ?, ?, 0, 'AI 调用（测试夹具）', ?)`,
    ).run(
      crypto.randomUUID(),
      opts.type ?? 'ai.invoke',
      opts.at.toISOString(),
      opts.at.toISOString(),
      opts.status ?? 'succeeded',
      JSON.stringify(tokens),
    );
  }

  it('资产四指标：题数/试卷库（不含回收站）/录入文档（recog_runs 全状态）/错题沉淀', () => {
    insertQuestion('qn1', 'network');
    insertQuestion('qn2', 'local');
    insertQuestion('qn-del', 'network', 1); // 已删除 → 不计
    insertPaper('p1', 'basket');
    insertPaper('p2', 'done');
    insertPaper('p3', 'trashed'); // 回收站 → 不计
    insertPaper('p4', 'archived');
    insertRun('r1', 'done');
    insertRun('r2', 'error');     // 失败的识别也是一条「识别记录」
    insertRun('r3', 'queued');
    insertStudent('s1');
    insertStudent('s2');
    insertMistake('m1', 'qn1', 's1');
    insertMistake('m2', 'qn1', 's2'); // 同题不同学生各计一条
    insertMistake('m3', 'qn2', 's1');

    const dash = getHomeDashboard(db, now);
    expect(dash.questions).toBe(2);
    expect(dash.papers).toBe(3); // basket+done+archived，trashed 不计
    expect(dash.documentsRecognized).toBe(3);
    expect(dash.mistakeRecords).toBe(3);
  });

  it('AI 用量：只认 ai.invoke 且 succeeded；token 全期累计；趋势按日 {count, tokens}', () => {
    insertStudent('s1');
    insertQuestion('qn1', 'network');

    // 今日一条经真 OperationLogger 写入（证明 gateway 留痕形态可被聚合）
    const logger = new OperationLogger(db);
    const logId = logger.logStart('ai.invoke', 'AI 调用', {
      role: 'reasoning', profileName: 'R1', model: 'test-model', tokens: { promptTokens: 60, completionTokens: 40, totalTokens: 100 },
    });
    logger.logSuccess(logId, 0);

    insertInvoke({ at: daysAgoAt(now, 0, 8), tokens: 200 });        // 今日
    insertInvoke({ at: daysAgoAt(now, 3) });                        // 窗口内，无 tokens → 计次不计 token
    insertInvoke({ at: daysAgoAt(now, 29), tokens: 50 });           // 窗口边界（第 30 天）→ 计
    insertInvoke({ at: daysAgoAt(now, 30) });                       // 第 31 天 → 不进 30 天窗，但仍计累计
    insertInvoke({ at: daysAgoAt(now, 40), tokens: 999999 });       // 远古 → 不进窗，计入累计
    insertInvoke({ at: daysAgoAt(now, 2), status: 'failed' });      // 失败 → 完全不计
    insertInvoke({ at: daysAgoAt(now, 1), type: 'tree.consolidate' }); // 他类型 → 完全不计

    const dash = getHomeDashboard(db, now);
    // 次数/token 累计 = 全期成功 ai.invoke（窗口只作用于 30 天趋势，任务书口径「累计」）
    expect(dash.aiInvocations).toBe(6);
    expect(dash.aiTokens).toBe(1000349); // 100 + 200 + 0 + 50 + 0 + 999999
    expect(dash.aiDaily).toHaveLength(30);
    // 末日双值：今日 2 次 / 100+200=300 tokens
    expect(dash.aiDaily[dash.aiDaily.length - 1]).toEqual({ date: localDateKey(now), count: 2, tokens: 300 });
    expect(dash.aiDaily[dash.aiDaily.length - 1 - 29]).toEqual({ date: localDateKey(daysAgoAt(now, 29)), count: 1, tokens: 50 });
    // 30 天窗内合计 = 4 次 / 350 tokens；窗外两条不进趋势
    expect(dash.aiDaily.reduce((s, b) => s + b.count, 0)).toBe(4);
    expect(dash.aiDaily.reduce((s, b) => s + b.tokens, 0)).toBe(350);
  });

  it('空库：全 0 且 aiDaily 为 30 个零日（首页据此整区换引导）', () => {
    const dash = getHomeDashboard(db, now);
    expect(dash.questions).toBe(0);
    expect(dash.papers).toBe(0);
    expect(dash.documentsRecognized).toBe(0);
    expect(dash.mistakeRecords).toBe(0);
    expect(dash.aiInvocations).toBe(0);
    expect(dash.aiTokens).toBe(0);
    expect(dash.aiDaily).toHaveLength(30);
    expect(dash.aiDaily.every((b) => b.count === 0 && b.tokens === 0)).toBe(true);
  });
});
