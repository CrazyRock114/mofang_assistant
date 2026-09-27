// Phase 2: question-service 实现 BankService 接口（Question 操作）
// 0002 适配：加列 stem_html/options_json/subject_id/type_id/difficulty_id（G1 结构化 + G2 字典化）；
// grade/textbook/version/chapter 列已随 0002 删除（并入树，拍板 B2）——入参兼容保留、服务端忽略。
// 0062（R-066/D-076② 翻案 B2）：stage 列随迁移 0017 加回并落库，学段筛选题级优先（本文件 filter.stage）。

import type { Question, QuestionFilter, QuestionOption, QuestionImage } from '../shared/contracts/bank-types.js';
import type { Database } from './db.js';
import { OperationLogger } from './operation-log.js';
import { validateSource } from './gate.js';

export class QuestionService {
  private logger: OperationLogger;

  constructor(private db: Database) {
    this.logger = new OperationLogger(db);
  }

  async createQuestion(data: Omit<Question, 'id' | 'createdAt' | 'updatedAt'>): Promise<Question> {
    return this.logger.wrap('question.create', `Create question: ${data.subject}`, () => {
      validateSource(data);

      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      this.db.prepare(`
        INSERT INTO questions (
          id, subject, subject_id, source_type, source_detail, question_type, type_id, difficulty, difficulty_id,
          stem_html, options_json, knowledge_points, stage,
          content, answer, analysis, images, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        data.subject,
        data.subjectId ?? null,
        data.sourceType,
        JSON.stringify(data.sourceDetail),
        data.questionType ?? null,
        data.typeId ?? null,
        data.difficulty ?? null,
        data.difficultyId ?? null,
        data.stemHtml ?? null,
        data.options ? JSON.stringify(data.options) : null,
        data.knowledgePoints ? JSON.stringify(data.knowledgePoints) : null,
        data.stage ?? null,
        data.content,
        data.answer ?? null,
        data.analysis ?? null,
        JSON.stringify(data.images),
        now,
        now
      );

      return {
        ...data,
        id,
        createdAt: now,
        updatedAt: now,
        images: data.images ?? [],
      };
    });
  }

  async getQuestion(id: string): Promise<Question | null> {
    const row = this.db.prepare(`
      SELECT * FROM questions WHERE id = ? AND deleted = 0
    `).get(id) as any;

    if (!row) return null;

    // 0054：读侧回填 question_tags（单题视图与列表同口径）
    return this.attachTags([this.rowToQuestion(row)])[0]!;
  }

  async listQuestions(filter?: QuestionFilter): Promise<Question[]> {
    let sql = 'SELECT DISTINCT q.* FROM questions q LEFT JOIN question_tags qt ON q.id = qt.question_id WHERE q.deleted = 0';
    const params: any[] = [];

    if (filter?.subject) {
      sql += ' AND q.subject = ?';
      params.push(filter.subject);
    }

    // 0002 B5 字典维度
    if (filter?.subjectId) {
      sql += ' AND q.subject_id = ?';
      params.push(filter.subjectId);
    }
    if (filter?.typeId) {
      sql += ' AND q.type_id = ?';
      params.push(filter.typeId);
    }
    // 0014 题型多值（选择题聚合）；与 typeId 同现时 typeId 优先（契约 JSDoc 记档口径）
    if (!filter?.typeId && filter?.typeIds && filter.typeIds.length > 0) {
      sql += ` AND q.type_id IN (${filter.typeIds.map(() => '?').join(', ')})`;
      params.push(...filter.typeIds);
    }
    if (filter?.difficultyId) {
      sql += ' AND q.difficulty_id = ?';
      params.push(filter.difficultyId);
    }

    // 0002 B5 树维度：子树派生（递归 CTE 展开节点自身+全部后代，再取挂接题）
    if (filter?.treeNodeId) {
      sql += ` AND q.id IN (
        SELECT question_id FROM question_node_links
        WHERE node_id IN (
          WITH RECURSIVE sub(node_id) AS (
            SELECT id FROM tree_nodes WHERE id = ?
            UNION ALL
            SELECT tn.id FROM tree_nodes tn JOIN sub s ON tn.parent_id = s.node_id
          )
          SELECT node_id FROM sub
        )
      )`;
      params.push(filter.treeNodeId);
    }

    // 0062（R-066/D-076② 翻案 B2）：学段维度——题级优先、空回退树 stage，空题级未挂树按「未分组」归一。
    // 分区语义（任务书 §一.4 散文口径「题级非空→只看题级；题级空→未挂树按「未分组」参与，挂了树回退树 stage」
    // + §六 目检清单「已挂树的旧题筛选行为不变」）：每题恰好落一个学段筛——
    //   ① 题级非空 → 只看题级（挂树学段不参与）；
    //   ② 题级空 + 挂了树 → 回退树 stage（树 stage 空值归一「未分组」，树面板学段集合同源）；
    //   ③ 题级空 + 从未挂树 → 按「未分组」参与（堵死「题消失了」的旧体感）。
    if (filter?.stage) {
      sql += ` AND (
        (NULLIF(q.stage, '') IS NOT NULL AND q.stage = ?)
        OR (NULLIF(q.stage, '') IS NULL AND (
          EXISTS (
            SELECT 1 FROM question_node_links l
            JOIN tree_nodes tn ON tn.id = l.node_id
            JOIN trees t ON t.id = tn.tree_id
            WHERE l.question_id = q.id AND COALESCE(NULLIF(t.stage, ''), '未分组') = ?
          )
          OR (? = '未分组' AND NOT EXISTS (
            SELECT 1 FROM question_node_links l WHERE l.question_id = q.id
          ))
        ))
      )`;
      params.push(filter.stage, filter.stage, filter.stage);
    }

    if (filter?.tag) {
      sql += ' AND qt.tag = ?';
      params.push(filter.tag);
    }

    if (filter?.keyword) {
      sql += ' AND q.content LIKE ?';
      params.push(`%${filter.keyword}%`);
    }

    sql += ' ORDER BY q.created_at DESC';

    const rows = this.db.prepare(sql).all(...params) as any[];
    // 0054：读侧回填 question_tags（题库题卡要显示「标签」，来源不分 AI 建议/批量/手动）
    return this.attachTags(rows.map(row => this.rowToQuestion(row)));
  }

  /**
   * 0054（只增）：批量回填题目标签（一次 IN 查询，避免逐题 N+1）。
   * 无标签的题**不产生 tags 字段**（保持旧形状，调用方按 `?? []` 口径读）。
   */
  private attachTags(questions: Question[]): Question[] {
    if (questions.length === 0) return questions;
    const ids = questions.map((q) => q.id);
    const rows = this.db.prepare(
      `SELECT question_id, tag FROM question_tags
       WHERE question_id IN (${ids.map(() => '?').join(', ')})
       ORDER BY tag`,
    ).all(...ids) as Array<{ question_id: string; tag: string }>;
    if (rows.length === 0) return questions;
    const byId = new Map<string, string[]>();
    for (const row of rows) {
      const list = byId.get(row.question_id);
      if (list) list.push(row.tag); else byId.set(row.question_id, [row.tag]);
    }
    return questions.map((q) => (byId.has(q.id) ? { ...q, tags: byId.get(q.id)! } : q));
  }

  async updateQuestion(id: string, data: Partial<Omit<Question, 'id' | 'createdAt'>>): Promise<Question> {
    return this.logger.wrap('question.update', `Update question: ${id}`, () => {
      if (data.sourceType !== undefined || data.sourceDetail !== undefined) {
        const existing = this.db.prepare('SELECT source_type, source_detail FROM questions WHERE id = ?').get(id) as any;
        if (!existing) throw new Error(`Question ${id} not found`);

        validateSource({
          sourceType: data.sourceType ?? existing.source_type,
          sourceDetail: data.sourceDetail ?? JSON.parse(existing.source_detail),
        });
      }

      const now = new Date().toISOString();
      const updates: string[] = ['updated_at = ?'];
      const params: any[] = [now];

      if (data.subject !== undefined) { updates.push('subject = ?'); params.push(data.subject); }
      if (data.subjectId !== undefined) { updates.push('subject_id = ?'); params.push(data.subjectId); }
      if (data.sourceType !== undefined) { updates.push('source_type = ?'); params.push(data.sourceType); }
      if (data.sourceDetail !== undefined) { updates.push('source_detail = ?'); params.push(JSON.stringify(data.sourceDetail)); }
      if (data.questionType !== undefined) { updates.push('question_type = ?'); params.push(data.questionType); }
      if (data.typeId !== undefined) { updates.push('type_id = ?'); params.push(data.typeId); }
      if (data.difficulty !== undefined) { updates.push('difficulty = ?'); params.push(data.difficulty); }
      if (data.difficultyId !== undefined) { updates.push('difficulty_id = ?'); params.push(data.difficultyId); }
      if (data.stemHtml !== undefined) { updates.push('stem_html = ?'); params.push(data.stemHtml); }
      if (data.options !== undefined) { updates.push('options_json = ?'); params.push(JSON.stringify(data.options)); }
      if (data.knowledgePoints !== undefined) { updates.push('knowledge_points = ?'); params.push(JSON.stringify(data.knowledgePoints)); }
      if (data.content !== undefined) { updates.push('content = ?'); params.push(data.content); }
      if (data.answer !== undefined) { updates.push('answer = ?'); params.push(data.answer); }
      if (data.analysis !== undefined) { updates.push('analysis = ?'); params.push(data.analysis); }
      if (data.images !== undefined) { updates.push('images = ?'); params.push(JSON.stringify(data.images)); }

      params.push(id);

      this.db.prepare(`UPDATE questions SET ${updates.join(', ')} WHERE id = ?`).run(...params);

      const updated = this.db.prepare('SELECT * FROM questions WHERE id = ?').get(id) as any;
      return this.rowToQuestion(updated);
    });
  }

  async deleteQuestion(id: string): Promise<void> {
    return this.logger.wrap('question.delete', `Delete question: ${id}`, () => {
      // 软删：deleted=1；listQuestions/getQuestion 已过滤 deleted=0，试卷引用保留但取题自然消失
      this.db.prepare('UPDATE questions SET deleted = 1, updated_at = ? WHERE id = ?')
        .run(new Date().toISOString(), id);
    });
  }

  async addTag(questionId: string, tag: string, color?: string): Promise<void> {
    this.logger.wrap('question.addTag', `Add tag "${tag}" to ${questionId}`, () => {
      this.db.prepare(`
        INSERT OR REPLACE INTO question_tags (question_id, tag, color)
        VALUES (?, ?, ?)
      `).run(questionId, tag, color ?? null);
    });
  }

  async removeTag(questionId: string, tag: string): Promise<void> {
    this.logger.wrap('question.removeTag', `Remove tag "${tag}" from ${questionId}`, () => {
      this.db.prepare(`
        DELETE FROM question_tags WHERE question_id = ? AND tag = ?
      `).run(questionId, tag);
    });
  }

  private rowToQuestion(row: any): Question {
    return {
      id: row.id,
      subject: row.subject,
      subjectId: row.subject_id ?? undefined,
      sourceType: row.source_type,
      sourceDetail: JSON.parse(row.source_detail),
      questionType: row.question_type,
      typeId: row.type_id ?? undefined,
      difficulty: row.difficulty,
      difficultyId: row.difficulty_id ?? undefined,
      stemHtml: row.stem_html ?? undefined,
      options: row.options_json ? (JSON.parse(row.options_json) as QuestionOption[]) : undefined,
      knowledgePoints: row.knowledge_points ? JSON.parse(row.knowledge_points) : undefined,
      stage: row.stage ?? undefined,
      content: row.content,
      answer: row.answer,
      analysis: row.analysis,
      images: JSON.parse(row.images) as QuestionImage[],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
