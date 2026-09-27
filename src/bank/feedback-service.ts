// 0005 课后反馈 M6：文本反馈模板服务（SQLite 真实实现）。
// 照 preset-service 模式：内置模板不可改/删（服务层守卫）；用户模板软删。
// 渲染纯函数（renderFeedback）与卡片导出 IO 不在本服务——服务侧只做模板 CRUD（任务书 §一 P1-2）。

import type { Database } from './db.js';
import { OperationLogger } from './operation-log.js';
import type { FeedbackService, FeedbackTemplate, FeedbackTemplateInput } from '../shared/contracts/bank-types.js';

interface FeedbackTemplateRow {
  id: string;
  name: string;
  body_template: string;
  is_builtin: number;
  created_at: string | null;
  updated_at: string | null;
}

function rowToTemplate(row: FeedbackTemplateRow): FeedbackTemplate {
  return {
    id: row.id,
    name: row.name,
    bodyTemplate: row.body_template,
    isBuiltin: Boolean(row.is_builtin),
    createdAt: row.created_at ?? '',
    updatedAt: row.updated_at ?? '',
  };
}

export class FeedbackServiceImpl implements FeedbackService {
  private logger: OperationLogger;

  constructor(private db: Database) {
    this.logger = new OperationLogger(db);
  }

  async createTemplate(data: FeedbackTemplateInput): Promise<FeedbackTemplate> {
    if (!data.name || !data.name.trim()) throw new Error('Feedback template name cannot be empty');
    if (!data.bodyTemplate || !data.bodyTemplate.trim()) throw new Error('Feedback template body cannot be empty');

    return this.logger.wrap('feedback.create', `Create feedback template: ${data.name}`, () => {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO feedback_templates (id, name, body_template, is_builtin, deleted, created_at, updated_at)
        VALUES (?, ?, ?, 0, 0, ?, ?)
      `).run(id, data.name, data.bodyTemplate, now, now);
      return {
        id, name: data.name, bodyTemplate: data.bodyTemplate,
        isBuiltin: false, createdAt: now, updatedAt: now,
      };
    });
  }

  async getTemplate(id: string): Promise<FeedbackTemplate | null> {
    const row = this.db.prepare(`
      SELECT id, name, body_template, is_builtin, created_at, updated_at
      FROM feedback_templates WHERE id = ? AND deleted = 0
    `).get(id) as FeedbackTemplateRow | undefined;
    return row ? rowToTemplate(row) : null;
  }

  async listTemplates(filter?: { includeDeleted?: boolean }): Promise<FeedbackTemplate[]> {
    const sql = filter?.includeDeleted
      ? `SELECT id, name, body_template, is_builtin, created_at, updated_at
         FROM feedback_templates ORDER BY is_builtin DESC, created_at ASC`
      : `SELECT id, name, body_template, is_builtin, created_at, updated_at
         FROM feedback_templates WHERE deleted = 0 ORDER BY is_builtin DESC, created_at ASC`;
    const rows = this.db.prepare(sql).all() as any[];
    return rows.map(rowToTemplate);
  }

  async updateTemplate(id: string, data: Partial<FeedbackTemplateInput>): Promise<FeedbackTemplate> {
    return this.logger.wrap('feedback.update', `Update feedback template ${id}`, () => {
      const row = this.db.prepare('SELECT * FROM feedback_templates WHERE id = ? AND deleted = 0').get(id) as FeedbackTemplateRow | undefined;
      if (!row) throw new Error(`Feedback template ${id} not found`);
      if (row.is_builtin) throw new Error('Builtin feedback template cannot be updated');

      const name = data.name !== undefined ? data.name : row.name;
      const bodyTemplate = data.bodyTemplate !== undefined ? data.bodyTemplate : row.body_template;
      if (!name || !name.trim()) throw new Error('Feedback template name cannot be empty');
      if (!bodyTemplate || !bodyTemplate.trim()) throw new Error('Feedback template body cannot be empty');

      this.db.prepare('UPDATE feedback_templates SET name = ?, body_template = ?, updated_at = ? WHERE id = ?')
        .run(name, bodyTemplate, new Date().toISOString(), id);
      return {
        id, name, bodyTemplate, isBuiltin: false,
        createdAt: row.created_at ?? '', updatedAt: new Date().toISOString(),
      };
    });
  }

  async deleteTemplate(id: string): Promise<void> {
    this.logger.wrap('feedback.delete', `Delete feedback template ${id}`, () => {
      const row = this.db.prepare('SELECT id, is_builtin FROM feedback_templates WHERE id = ? AND deleted = 0').get(id) as FeedbackTemplateRow | undefined;
      if (!row) throw new Error(`Feedback template ${id} not found`);
      if (row.is_builtin) throw new Error('Builtin feedback template cannot be deleted');

      this.db.prepare('UPDATE feedback_templates SET deleted = 1, updated_at = ? WHERE id = ?')
        .run(new Date().toISOString(), id);
    });
  }
}
