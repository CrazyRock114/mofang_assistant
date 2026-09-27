// 0002: 错题本服务（B7/U2/U9/U10）——mistakes CRUD + 红黄绿状态机 + 题快照
// 拍板 §6-1：(question_id, student_id) 全局唯一——错题=一生一题的关系；多次错=更新同一关系（历史留痕走 student_events）。
// 快照哲学：题改/软删后错题仍可显示（与 paper_snapshots 同哲学）。

import type {
  Mistake, MistakeStage, MistakeQuestionSnapshot, MistakeService,
  MistakeAggregateFilter, MistakeAggregateRow, MistakeBatchResult,
} from '../shared/contracts/bank-types.js';
import type { Database } from './db.js';
import { OperationLogger } from './operation-log.js';
// 0025 P1（只增）：聚合口径纯函数与 SQL 构造（独立模块，真实/mock 单一来源）
import { buildAggregateSql, rowToAggregate, assertBatchIds, assertMistakeStage } from './mistake-aggregate.js';
import type { AggregateRow } from './mistake-aggregate.js';

/** 从 questions 行构建错题题快照（优先 stemHtml，回落 content） */
export function buildSnapshotFromRow(row: any): MistakeQuestionSnapshot {
  return {
    stemHtml: (row.stem_html as string) || (row.content as string) || '',
    options: row.options_json ? JSON.parse(row.options_json) : [],
    answer: row.answer ?? undefined,
    analysis: row.analysis ?? undefined,
    images: row.images ? JSON.parse(row.images) : [],
  };
}

function rowToMistake(row: any): Mistake {
  return {
    id: row.id,
    questionId: row.question_id,
    studentId: row.student_id,
    examId: row.exam_id ?? undefined,
    sourcePaperId: row.source_paper_id ?? undefined,
    occurredAt: row.occurred_at,
    stage: row.stage,
    lastCorrectAt: row.last_correct_at ?? undefined,
    snapshot: JSON.parse(row.snapshot_json),
    note: row.note ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 错题登记同步核心（供 MistakeService 与 ExamService.recordResults 共用；SQLite 同步驱动）：
 * 新关系标红；已存在（一生一题，拍板 §6-1）则刷新 occurredAt/来源、回红、快照刷新。
 */
export function recordWrongSync(db: Database, data: { questionId: string; studentId: string; examId?: string; sourcePaperId?: string; occurredAt: string; note?: string }): { mistake: Mistake; created: boolean } {
  const qrow = db.prepare('SELECT * FROM questions WHERE id = ?').get(data.questionId) as any;
  if (!qrow) throw new Error(`Question ${data.questionId} not found`);
  if (!db.prepare('SELECT id FROM students WHERE id = ?').get(data.studentId)) {
    throw new Error(`Student ${data.studentId} not found`);
  }

  const snapshot = buildSnapshotFromRow(qrow);
  const now = new Date().toISOString();

  const existing = db.prepare(
    'SELECT * FROM mistakes WHERE question_id = ? AND student_id = ?'
  ).get(data.questionId, data.studentId) as any;

  if (existing) {
    // 多次错=更新同一关系：刷新 occurredAt（最近一次错）、来源、回红、快照刷新
    db.prepare(`
      UPDATE mistakes
      SET exam_id = ?, source_paper_id = ?, occurred_at = ?, stage = 'red', snapshot_json = ?, note = COALESCE(?, note), updated_at = ?
      WHERE id = ?
    `).run(
      data.examId ?? existing.exam_id,
      data.sourcePaperId ?? existing.source_paper_id,
      data.occurredAt,
      JSON.stringify(snapshot),
      data.note ?? null,
      now,
      existing.id
    );
    const updated = db.prepare('SELECT * FROM mistakes WHERE id = ?').get(existing.id) as any;
    return { mistake: rowToMistake(updated), created: false };
  }

  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO mistakes (id, question_id, student_id, exam_id, source_paper_id, occurred_at, stage, snapshot_json, note, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'red', ?, ?, ?, ?)
  `).run(
    id,
    data.questionId,
    data.studentId,
    data.examId ?? null,
    data.sourcePaperId ?? null,
    data.occurredAt,
    JSON.stringify(snapshot),
    data.note ?? null,
    now,
    now
  );

  const row = db.prepare('SELECT * FROM mistakes WHERE id = ?').get(id) as any;
  return { mistake: rowToMistake(row), created: true };
}

/** 状态机循环顺序：红→黄→绿→红（U2：可回退红；点状态灯循环用） */
const STAGE_CYCLE: Record<MistakeStage, MistakeStage> = {
  red: 'yellow',
  yellow: 'green',
  green: 'red',
};

export class MistakeServiceImpl implements MistakeService {
  private logger: OperationLogger;

  constructor(private db: Database) {
    this.logger = new OperationLogger(db);
  }

  async recordWrong(data: { questionId: string; studentId: string; examId?: string; sourcePaperId?: string; occurredAt: string; note?: string }): Promise<{ mistake: Mistake; created: boolean }> {
    return this.logger.wrap('mistake.recordWrong', `Record wrong: student ${data.studentId} × question ${data.questionId}`, () => {
      return recordWrongSync(this.db, data);
    });
  }

  async getMistake(id: string): Promise<Mistake | null> {
    const row = this.db.prepare('SELECT * FROM mistakes WHERE id = ?').get(id) as any;
    return row ? rowToMistake(row) : null;
  }

  async listMistakes(filter: { studentId?: string; stage?: MistakeStage; questionId?: string; examId?: string } = {}): Promise<Mistake[]> {
    let sql = 'SELECT * FROM mistakes WHERE 1=1';
    const params: any[] = [];
    if (filter.studentId) { sql += ' AND student_id = ?'; params.push(filter.studentId); }
    if (filter.stage) { sql += ' AND stage = ?'; params.push(filter.stage); }
    if (filter.questionId) { sql += ' AND question_id = ?'; params.push(filter.questionId); }
    if (filter.examId) { sql += ' AND exam_id = ?'; params.push(filter.examId); }
    sql += ' ORDER BY occurred_at DESC';

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map(row => rowToMistake(row));
  }

  async setStage(id: string, stage: MistakeStage): Promise<Mistake> {
    return this.logger.wrap('mistake.setStage', `Set mistake ${id} stage to ${stage}`, () => {
      const result = this.db.prepare('UPDATE mistakes SET stage = ?, updated_at = ? WHERE id = ?')
        .run(stage, new Date().toISOString(), id);
      if (result.changes === 0) throw new Error(`Mistake ${id} not found`);
      const row = this.db.prepare('SELECT * FROM mistakes WHERE id = ?').get(id) as any;
      return rowToMistake(row);
    });
  }

  async cycleStage(id: string): Promise<Mistake> {
    const current = await this.getMistake(id);
    if (!current) throw new Error(`Mistake ${id} not found`);
    return this.setStage(id, STAGE_CYCLE[current.stage]);
  }

  async setNote(id: string, note: string): Promise<void> {
    this.logger.wrap('mistake.setNote', `Set note on mistake ${id}`, () => {
      const result = this.db.prepare('UPDATE mistakes SET note = ?, updated_at = ? WHERE id = ?')
        .run(note, new Date().toISOString(), id);
      if (result.changes === 0) throw new Error(`Mistake ${id} not found`);
    });
  }

  async deleteMistake(id: string): Promise<void> {
    this.logger.wrap('mistake.delete', `Delete mistake ${id}`, () => {
      // U10：宁可多标，多出的人工删（关系记录，硬删；题/生不受影响）
      const result = this.db.prepare('DELETE FROM mistakes WHERE id = ?').run(id);
      if (result.changes === 0) throw new Error(`Mistake ${id} not found`);
    });
  }

  // ==================== 0025 P1（只增）：聚合 / 批量 / 导出 ====================

  async aggregateByQuestion(filter: MistakeAggregateFilter = {}): Promise<MistakeAggregateRow[]> {
    const { sql, params } = buildAggregateSql(filter);
    const rows = this.db.prepare(sql).all(...params) as AggregateRow[];
    return rows.map(rowToAggregate);
  }

  async deleteMistakes(ids: string[]): Promise<MistakeBatchResult> {
    assertBatchIds(ids);
    return this.logger.wrap('mistake.batchDelete', `Batch delete ${ids.length} mistake(s)`, () => {
      // 幂等：勾选集可能含已被删项——不存在的 id 跳过，只计实际删除数
      const affectedCount = this.db.transaction(() => {
        const stmt = this.db.prepare('DELETE FROM mistakes WHERE id = ?');
        let changed = 0;
        for (const id of ids) changed += Number(stmt.run(id).changes);
        return changed;
      });
      return { affectedCount };
    }, { requested: ids.length });
  }

  async setStages(ids: string[], stage: MistakeStage): Promise<MistakeBatchResult> {
    assertBatchIds(ids);
    assertMistakeStage(stage);
    return this.logger.wrap('mistake.batchSetStage', `Batch set stage ${stage} on ${ids.length} mistake(s)`, () => {
      const now = new Date().toISOString();
      const affectedCount = this.db.transaction(() => {
        const stmt = this.db.prepare('UPDATE mistakes SET stage = ?, updated_at = ? WHERE id = ?');
        let changed = 0;
        for (const id of ids) changed += Number(stmt.run(stage, now, id).changes);
        return changed;
      });
      return { affectedCount };
    }, { requested: ids.length, stage });
  }

  /** 导出题 id 集：复用聚合（已 GROUP BY question_id 去重）→ 次序与聚合一致 */
  async exportQuestionIds(filter: MistakeAggregateFilter = {}): Promise<string[]> {
    const rows = await this.aggregateByQuestion(filter);
    return rows.map((row) => row.questionId);
  }
}
