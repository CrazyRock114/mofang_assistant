// 0030 反馈模块一期：AI 通道提示词模板 + 反馈记录落档（SQLite 真实实现，迁移 0010）。
// 照 0005 feedback-service / preset-service 模式：服务层守卫 + OperationLogger 留痕；软删不改语义。
//
// 与 0005 的边界（域不可混）：
//   FeedbackServiceImpl（0005）→ feedback_templates（离线通道正文插值，本文件零触碰）；
//   本文件 → feedback_prompt_templates（AI 通道提示词）+ feedback_records（落档）。
// 记录面口径（D-065）：一次「保存记录」一条，无「已发」状态字段——channel/prompt_snapshot/
// model_profile_id 只回答「当时怎么生成的」，不回答「发没发」。

import type { Database } from './db.js';
import { OperationLogger } from './operation-log.js';
import type {
  FeedbackChannel, FeedbackPromptTemplate, FeedbackPromptTemplateInput, FeedbackPromptTemplateService,
  FeedbackRecord, FeedbackRecordInput, FeedbackRecordPatch, FeedbackRecordQuery, FeedbackRecordService,
} from '../shared/contracts/bank-types.js';

const FEEDBACK_CHANNELS: readonly FeedbackChannel[] = ['offline', 'ai'];

function requireText(value: string | undefined, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} cannot be empty`);
  return value;
}

/** 可空文本列：undefined/null/空白 → null（空串与 NULL 不混用，列表筛选口径统一） */
function optionalText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : value;
}

// ==================== 提示词模板（AI 通道） ====================

interface PromptTemplateRow {
  id: string;
  name: string;
  body: string;
  is_builtin: number;
  created_at: string | null;
  updated_at: string | null;
}

function rowToPromptTemplate(row: PromptTemplateRow): FeedbackPromptTemplate {
  return {
    id: row.id,
    name: row.name,
    body: row.body,
    isBuiltin: Boolean(row.is_builtin),
    createdAt: row.created_at ?? '',
    updatedAt: row.updated_at ?? '',
  };
}

export class FeedbackPromptTemplateServiceImpl implements FeedbackPromptTemplateService {
  private logger: OperationLogger;

  constructor(private db: Database) {
    this.logger = new OperationLogger(db);
  }

  async createTemplate(data: FeedbackPromptTemplateInput): Promise<FeedbackPromptTemplate> {
    const name = requireText(data.name, 'Feedback prompt template name');
    const body = requireText(data.body, 'Feedback prompt template body');
    return this.logger.wrap('feedback.prompt.create', `Create feedback prompt template: ${name}`, () => {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO feedback_prompt_templates (id, name, body, is_builtin, deleted, created_at, updated_at)
        VALUES (?, ?, ?, 0, 0, ?, ?)
      `).run(id, name, body, now, now);
      return { id, name, body, isBuiltin: false, createdAt: now, updatedAt: now };
    });
  }

  async getTemplate(id: string): Promise<FeedbackPromptTemplate | null> {
    const row = this.db.prepare(`
      SELECT id, name, body, is_builtin, created_at, updated_at
      FROM feedback_prompt_templates WHERE id = ? AND deleted = 0
    `).get(id) as PromptTemplateRow | undefined;
    return row ? rowToPromptTemplate(row) : null;
  }

  async listTemplates(filter?: { includeDeleted?: boolean }): Promise<FeedbackPromptTemplate[]> {
    const sql = filter?.includeDeleted
      ? `SELECT id, name, body, is_builtin, created_at, updated_at
         FROM feedback_prompt_templates ORDER BY is_builtin DESC, created_at ASC`
      : `SELECT id, name, body, is_builtin, created_at, updated_at
         FROM feedback_prompt_templates WHERE deleted = 0 ORDER BY is_builtin DESC, created_at ASC`;
    const rows = this.db.prepare(sql).all() as unknown as PromptTemplateRow[];
    return rows.map(rowToPromptTemplate);
  }

  async updateTemplate(id: string, data: Partial<FeedbackPromptTemplateInput>): Promise<FeedbackPromptTemplate> {
    return this.logger.wrap('feedback.prompt.update', `Update feedback prompt template ${id}`, () => {
      const row = this.db.prepare(
        'SELECT id, name, body, is_builtin, created_at, updated_at FROM feedback_prompt_templates WHERE id = ? AND deleted = 0',
      ).get(id) as PromptTemplateRow | undefined;
      if (!row) throw new Error(`Feedback prompt template ${id} not found`);
      if (row.is_builtin) throw new Error('Builtin feedback prompt template cannot be updated');

      const name = data.name !== undefined ? requireText(data.name, 'Feedback prompt template name') : row.name;
      const body = data.body !== undefined ? requireText(data.body, 'Feedback prompt template body') : row.body;
      const now = new Date().toISOString();
      this.db.prepare('UPDATE feedback_prompt_templates SET name = ?, body = ?, updated_at = ? WHERE id = ?')
        .run(name, body, now, id);
      return { id, name, body, isBuiltin: false, createdAt: row.created_at ?? '', updatedAt: now };
    });
  }

  async deleteTemplate(id: string): Promise<void> {
    this.logger.wrap('feedback.prompt.delete', `Delete feedback prompt template ${id}`, () => {
      const row = this.db.prepare('SELECT id, is_builtin FROM feedback_prompt_templates WHERE id = ? AND deleted = 0')
        .get(id) as PromptTemplateRow | undefined;
      if (!row) throw new Error(`Feedback prompt template ${id} not found`);
      if (row.is_builtin) throw new Error('Builtin feedback prompt template cannot be deleted');
      this.db.prepare('UPDATE feedback_prompt_templates SET deleted = 1, updated_at = ? WHERE id = ?')
        .run(new Date().toISOString(), id);
    });
  }
}

// ==================== 反馈记录（落档） ====================

interface RecordRow {
  id: string;
  student_id: string | null;
  student_name: string;
  class_id: string | null;
  exam_id: string | null;
  channel: string;
  prompt_template_id: string | null;
  prompt_snapshot: string | null;
  model_profile_id: string | null;
  input_json: string;
  body: string;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: RecordRow): FeedbackRecord {
  return {
    id: row.id,
    studentId: row.student_id,
    studentName: row.student_name,
    classId: row.class_id,
    examId: row.exam_id,
    channel: row.channel === 'ai' ? 'ai' : 'offline',
    promptTemplateId: row.prompt_template_id,
    promptSnapshot: row.prompt_snapshot,
    modelProfileId: row.model_profile_id,
    inputJson: row.input_json,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const RECORD_COLUMNS = `id, student_id, student_name, class_id, exam_id, channel, prompt_template_id,
  prompt_snapshot, model_profile_id, input_json, body, created_at, updated_at`;

/** 姓名关键字转 LIKE 模式：转义 % _ \（避免用户输入的 % 变通配符） */
function likePattern(keyword: string): string {
  return `%${keyword.trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

export class FeedbackRecordServiceImpl implements FeedbackRecordService {
  private logger: OperationLogger;

  constructor(private db: Database) {
    this.logger = new OperationLogger(db);
  }

  /** 写入后读回一行（行必在——不在即数据异常，不静默） */
  private readRecord(id: string): FeedbackRecord {
    const row = this.db.prepare(`SELECT ${RECORD_COLUMNS} FROM feedback_records WHERE id = ?`)
      .get(id) as RecordRow | undefined;
    if (!row) throw new Error(`Feedback record ${id} not found`);
    return rowToRecord(row);
  }

  async createRecord(data: FeedbackRecordInput): Promise<FeedbackRecord> {
    const studentName = requireText(data.studentName, 'Feedback record studentName');
    if (!FEEDBACK_CHANNELS.includes(data.channel)) {
      throw new Error(`Feedback record channel must be one of: ${FEEDBACK_CHANNELS.join(', ')}`);
    }
    const body = requireText(data.body, 'Feedback record body');
    const inputJson = requireText(data.inputJson, 'Feedback record inputJson');

    return this.logger.wrap('feedback.record.create', `Create feedback record: ${studentName}`, () => {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO feedback_records (
          id, student_id, student_name, class_id, exam_id, channel, prompt_template_id,
          prompt_snapshot, model_profile_id, input_json, body, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        optionalText(data.studentId),
        studentName,
        optionalText(data.classId),
        optionalText(data.examId),
        data.channel,
        optionalText(data.promptTemplateId),
        optionalText(data.promptSnapshot),
        optionalText(data.modelProfileId),
        inputJson,
        body,
        now,
        now,
      );
      return this.readRecord(id);
    });
  }

  async getRecord(id: string): Promise<FeedbackRecord | null> {
    const row = this.db.prepare(`SELECT ${RECORD_COLUMNS} FROM feedback_records WHERE id = ?`)
      .get(id) as RecordRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  async listRecords(query?: FeedbackRecordQuery): Promise<FeedbackRecord[]> {
    const where: string[] = [];
    const params: string[] = [];
    if (query?.classId) {
      where.push('class_id = ?');
      params.push(query.classId);
    }
    if (query?.studentName && query.studentName.trim() !== '') {
      where.push("student_name LIKE ? ESCAPE '\\'");
      params.push(likePattern(query.studentName));
    }
    const sql = `SELECT ${RECORD_COLUMNS} FROM feedback_records`
      + (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '')
      + ' ORDER BY created_at DESC, id DESC';
    const rows = this.db.prepare(sql).all(...params) as unknown as RecordRow[];
    return rows.map(rowToRecord);
  }

  async updateRecord(id: string, data: FeedbackRecordPatch): Promise<FeedbackRecord> {
    return this.logger.wrap('feedback.record.update', `Update feedback record ${id}`, () => {
      const existing = this.db.prepare(`SELECT ${RECORD_COLUMNS} FROM feedback_records WHERE id = ?`)
        .get(id) as RecordRow | undefined;
      if (!existing) throw new Error(`Feedback record ${id} not found`);

      const body = data.body !== undefined ? requireText(data.body, 'Feedback record body') : existing.body;
      const studentName = data.studentName !== undefined
        ? requireText(data.studentName, 'Feedback record studentName')
        : existing.student_name;
      const now = new Date().toISOString();
      this.db.prepare('UPDATE feedback_records SET body = ?, student_name = ?, updated_at = ? WHERE id = ?')
        .run(body, studentName, now, id);
      return this.readRecord(id);
    });
  }

  async deleteRecord(id: string): Promise<void> {
    this.logger.wrap('feedback.record.delete', `Delete feedback record ${id}`, () => {
      const result = this.db.prepare('DELETE FROM feedback_records WHERE id = ?').run(id);
      if (Number(result.changes) === 0) throw new Error(`Feedback record ${id} not found`);
    });
  }
}
