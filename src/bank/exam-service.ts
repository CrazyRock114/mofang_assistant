// 0002: 考试服务（B7/U7/U9/U10/U14）——exams/exam_scores + 登记编排（成绩+错题+自动升黄）
// 成绩独立落表（U14）：批量 upsert（exam_id+student_id 唯一）；student_events.exam_score 仍写（仅时间线展示流）。
// U9 自动升黄：考试关联卷时，该生卷中未被勾错的题视为做对——红升黄、黄只刷 last_correct_at（黄不自动升绿）；
// 无卷考试（或该生在 custom-mistake 集合中无卷）不触发。

import type {
  Exam, ExamScore, ScoreEntry, ExamResultEntry, ExamRecordSummary, ExamService,
} from '../shared/contracts/bank-types.js';
import type { Database } from './db.js';
import { OperationLogger } from './operation-log.js';
import { recordWrongSync } from './mistake-service.js';

export class ExamServiceImpl implements ExamService {
  private logger: OperationLogger;

  constructor(private db: Database) {
    this.logger = new OperationLogger(db);
  }

  async createExam(data: { title: string; classId?: string; subjectId?: string; occurredAt: string; paperSetId?: string; remark?: string }): Promise<Exam> {
    return this.logger.wrap('exam.create', `Create exam: ${data.title}`, () => {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      this.db.prepare(`
        INSERT INTO exams (id, title, class_id, subject_id, occurred_at, paper_set_id, remark, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, data.title, data.classId ?? null, data.subjectId ?? null, data.occurredAt, data.paperSetId ?? null, data.remark ?? null, now);

      return {
        id,
        title: data.title,
        classId: data.classId,
        subjectId: data.subjectId,
        occurredAt: data.occurredAt,
        paperSetId: data.paperSetId,
        remark: data.remark,
        createdAt: now,
      };
    });
  }

  async getExam(id: string): Promise<Exam | null> {
    const row = this.db.prepare('SELECT * FROM exams WHERE id = ?').get(id) as any;
    return row ? this.rowToExam(row) : null;
  }

  async listExams(filter: { classId?: string; subjectId?: string } = {}): Promise<Exam[]> {
    let sql = 'SELECT * FROM exams WHERE 1=1';
    const params: any[] = [];
    if (filter.classId) { sql += ' AND class_id = ?'; params.push(filter.classId); }
    if (filter.subjectId) { sql += ' AND subject_id = ?'; params.push(filter.subjectId); }
    sql += ' ORDER BY occurred_at DESC';

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map(row => this.rowToExam(row));
  }

  async recordScores(examId: string, entries: ScoreEntry[]): Promise<number> {
    return this.logger.wrap('exam.recordScores', `Record ${entries.length} scores for exam ${examId}`, () => {
      const exam = this.getExamRow(examId);
      return this.upsertScores(exam, entries);
    });
  }

  async getExamScores(examId: string): Promise<ExamScore[]> {
    const rows = this.db.prepare('SELECT * FROM exam_scores WHERE exam_id = ? ORDER BY student_id').all(examId) as any[];
    return rows.map(row => this.rowToScore(row));
  }

  async getStudentScores(studentId: string): Promise<Array<ExamScore & { examTitle?: string }>> {
    const rows = this.db.prepare(`
      SELECT es.*, e.title AS exam_title
      FROM exam_scores es LEFT JOIN exams e ON e.id = es.exam_id
      WHERE es.student_id = ?
      ORDER BY es.created_at
    `).all(studentId) as any[];
    return rows.map(row => ({
      ...this.rowToScore(row),
      examTitle: row.exam_title ?? undefined,
    }));
  }

  async recordResults(examId: string, entries: ExamResultEntry[]): Promise<ExamRecordSummary> {
    return this.logger.wrap('exam.recordResults', `Record results for exam ${examId} (${entries.length} students)`, () => {
      const exam = this.getExamRow(examId);
      const summary: ExamRecordSummary = {
        scoresUpserted: 0,
        mistakesCreated: 0,
        mistakesUpdated: 0,
        autoPromotedToYellow: 0,
        promotedStudents: 0,
      };

      // 1) 成绩批量 upsert + exam_score 展示流事件（U14）
      summary.scoresUpserted = this.upsertScores(exam, entries);

      // 2) 错题登记 + U9 自动升黄
      const paperScope = this.resolvePaperScope(exam);

      for (const entry of entries) {
        const wrongIds = entry.wrongQuestionIds ?? [];
        const wrongSet = new Set(wrongIds);

        // 勾错 → 自动标红入本（多次错=更新同一关系，回红）
        for (const questionId of wrongIds) {
          const res = recordWrongSync(this.db, {
            questionId,
            studentId: entry.studentId,
            examId: exam.id,
            sourcePaperId: paperScope.studentPaper(exam, entry.studentId) ?? undefined,
            occurredAt: exam.occurred_at,
          });
          if (res.created) summary.mistakesCreated++;
          else summary.mistakesUpdated++;
        }

        // U9：该生有卷才触发（无卷考试/无卷学生不触发）
        const studentPaperId = paperScope.studentPaper(exam, entry.studentId);
        if (studentPaperId) {
          const paperQuestionIds = (this.db.prepare(
            'SELECT question_id FROM paper_questions WHERE paper_id = ?'
          ).all(studentPaperId) as any[]).map(r => r.question_id);

          let promoted = 0;
          for (const questionId of paperQuestionIds) {
            if (wrongSet.has(questionId)) continue; // 勾错=做错，留在红
            const existing = this.db.prepare(
              'SELECT id, stage FROM mistakes WHERE question_id = ? AND student_id = ?'
            ).get(questionId, entry.studentId) as any;
            if (!existing) continue;

            if (existing.stage === 'red') {
              // 做对：红自动升黄
              this.db.prepare(
                "UPDATE mistakes SET stage = 'yellow', last_correct_at = ?, updated_at = ? WHERE id = ?"
              ).run(exam.occurred_at, new Date().toISOString(), existing.id);
              promoted++;
            } else if (existing.stage === 'yellow') {
              // 重复做对：不升级（黄不自动升绿），仅刷新最近做对时间
              this.db.prepare(
                'UPDATE mistakes SET last_correct_at = ?, updated_at = ? WHERE id = ?'
              ).run(exam.occurred_at, new Date().toISOString(), existing.id);
            }
            // green：手动专属，不动
          }

          if (promoted > 0) {
            summary.autoPromotedToYellow += promoted;
            summary.promotedStudents++;
          }
        }
      }

      return summary;
    });
  }

  /** 成绩 upsert（exam_id+student_id 唯一）+ exam_score 展示流事件；返回 upsert 条数 */
  private upsertScores(exam: any, entries: ScoreEntry[]): number {
    const now = new Date().toISOString();
    let count = 0;

    for (const entry of entries) {
      if (!this.db.prepare('SELECT id FROM students WHERE id = ?').get(entry.studentId)) {
        throw new Error(`Student ${entry.studentId} not found`);
      }

      const existing = this.db.prepare(
        'SELECT id FROM exam_scores WHERE exam_id = ? AND student_id = ?'
      ).get(exam.id, entry.studentId) as any;

      if (existing) {
        // upsert 只更新提供的字段：undefined 保留原值（重复批量录入不丢 detail/成绩）
        this.db.prepare(`
          UPDATE exam_scores
          SET score = COALESCE(?, score), detail_json = COALESCE(?, detail_json), updated_at = ?
          WHERE id = ?
        `).run(entry.score ?? null, entry.detail ? JSON.stringify(entry.detail) : null, now, existing.id);
      } else {
        this.db.prepare(`
          INSERT INTO exam_scores (id, exam_id, student_id, score, detail_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(crypto.randomUUID(), exam.id, entry.studentId, entry.score ?? null, entry.detail ? JSON.stringify(entry.detail) : null, now, now);
      }

      // 时间线展示流（U14：独立落表之外仍写事件）
      this.db.prepare(`
        INSERT INTO student_events (id, student_id, event_type, occurred_at, payload_json, created_at)
        VALUES (?, ?, 'exam_score', ?, ?, ?)
      `).run(
        crypto.randomUUID(),
        entry.studentId,
        exam.occurred_at,
        JSON.stringify({
          eventType: 'exam_score',
          examId: exam.id,
          ...(entry.score !== undefined ? { score: entry.score } : {}),
          ...(exam.subject_id ? { subjectId: exam.subject_id } : {}),
        }),
        now
      );

      count++;
    }

    return count;
  }

  /**
   * 解析考试关联卷范围（拍板 §6-7/U7）：
   * uniform 集合 → 全体共用单卷；custom-mistake 集合 → 每生各自卷（无卷学生返回 null）；无 paper_set → null
   */
  private resolvePaperScope(exam: any): { studentPaper: (exam: any, studentId: string) => string | null } {
    if (!exam.paper_set_id) {
      return { studentPaper: () => null };
    }

    const setRow = this.db.prepare('SELECT id, type FROM paper_sets WHERE id = ?').get(exam.paper_set_id) as any;
    if (!setRow) {
      return { studentPaper: () => null };
    }

    const refs = this.db.prepare(
      'SELECT paper_id, student_id FROM paper_set_papers WHERE paper_set_id = ?'
    ).all(exam.paper_set_id) as any[];

    if (setRow.type === 'uniform') {
      const paperId = refs.find(r => !r.student_id)?.paper_id ?? refs[0]?.paper_id ?? null;
      return { studentPaper: () => paperId };
    }

    // custom-mistake：每生一卷
    const byStudent = new Map<string, string>();
    for (const ref of refs) {
      if (ref.student_id) byStudent.set(ref.student_id, ref.paper_id);
    }
    return { studentPaper: (_exam: any, studentId: string) => byStudent.get(studentId) ?? null };
  }

  private getExamRow(examId: string): any {
    const row = this.db.prepare('SELECT * FROM exams WHERE id = ?').get(examId) as any;
    if (!row) throw new Error(`Exam ${examId} not found`);
    return row;
  }

  private rowToExam(row: any): Exam {
    return {
      id: row.id,
      title: row.title,
      classId: row.class_id ?? undefined,
      subjectId: row.subject_id ?? undefined,
      occurredAt: row.occurred_at,
      paperSetId: row.paper_set_id ?? undefined,
      remark: row.remark ?? undefined,
      createdAt: row.created_at,
    };
  }

  private rowToScore(row: any): ExamScore {
    return {
      id: row.id,
      examId: row.exam_id,
      studentId: row.student_id,
      score: row.score ?? undefined,
      detail: row.detail_json ? JSON.parse(row.detail_json) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
