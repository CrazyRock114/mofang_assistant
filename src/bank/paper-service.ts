// Phase 2: paper-service 实现 BankService 接口（Paper 操作）
// 0002 适配：status 状态机（basket→composing→done→archived；composing↔basket 可返）+ paper_type + layout_config_json。
// archived 旧列废弃（拍板 §6-2 单轨）：读侧恒等于 status==='archived'，列保留不再读写。

import type {
  Paper, PaperSummary, PaperQuestionRef, Question, PaperFolder,
  PaperStatus, PaperType, PaperLayoutConfig, PaperCreateOptions, PaperExtService, PaperTextBlockStyle,
  PaperTextBlockAlign,
} from '../shared/contracts/bank-types.js';
import type { Database } from './db.js';
import { OperationLogger } from './operation-log.js';
import { QuestionService } from './question-service.js';

/**
 * 合法状态迁移表（决策稿 G6：流程 basket→composing→done→archived；composing↔basket 可返；放弃=→archived；archived→done 恢复）。
 * 0044（只增）：任意非 trashed → trashed（回收站，服务层记 trashed_from=原状态）；
 * trashed 无 updatePaperStatus 出边——恢复走专用 restorePaper（读 trashed_from 还原，防止猜原状态）。
 */
const ALLOWED_TRANSITIONS: Record<PaperStatus, PaperStatus[]> = {
  basket: ['composing', 'archived', 'trashed'],
  composing: ['basket', 'done', 'archived', 'trashed'],
  done: ['archived', 'trashed'],
  archived: ['done', 'trashed'],
  trashed: [],
};

export class PaperService implements PaperExtService {
  private logger: OperationLogger;

  constructor(private db: Database) {
    this.logger = new OperationLogger(db);
  }

  async createPaper(title: string, config: Record<string, unknown> = {}, opts: PaperCreateOptions = {}): Promise<Paper> {
    return this.createPaperEx(title, config, opts);
  }

  async createPaperEx(title: string, config: Record<string, unknown> = {}, opts: PaperCreateOptions = {}): Promise<Paper> {
    return this.logger.wrap('paper.create', `Create paper: ${title}`, () => {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const status = opts.status ?? 'basket';
      const paperType = opts.paperType ?? 'uniform';

      this.db.prepare(`
        INSERT INTO papers (id, title, config, created_at, status, paper_type)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, title, JSON.stringify(config), now, status, paperType);

      return {
        id,
        title,
        config,
        createdAt: now,
        archived: status === 'archived',
        status,
        paperType,
      };
    });
  }

  async getPaper(id: string): Promise<Paper | null> {
    const row = this.db.prepare(`
      SELECT * FROM papers WHERE id = ?
    `).get(id) as any;

    // 语义对齐旧行为：archived 卷默认不可见（getPaper 过滤）
    if (!row || row.status === 'archived') return null;

    return this.rowToPaper(row);
  }

  async listPapers(): Promise<PaperSummary[]> {
    const rows = this.db.prepare(`
      SELECT
        p.id, p.title, p.config, p.created_at, p.status, p.paper_type, p.layout_config_json,
        COUNT(pq.id) as question_count,
        COALESCE(SUM(pq.score), 0) as total_score
      FROM papers p
      LEFT JOIN paper_questions pq ON p.id = pq.paper_id
      WHERE p.status != 'archived'
      GROUP BY p.id
      ORDER BY p.created_at DESC
    `).all() as any[];

    return rows.map(row => ({
      paper: this.rowToPaper(row),
      questionCount: row.question_count,
      totalScore: row.total_score,
    }));
  }

  // ==================== 0004：试题篮/快照/克隆/重命名 ====================

  async listPapersEx(filter: { statuses?: PaperStatus[] } = {}): Promise<PaperSummary[]> {
    let sql = `
      SELECT
        p.id, p.title, p.config, p.created_at, p.status, p.paper_type, p.layout_config_json, p.folder_id,
        COUNT(pq.id) as question_count,
        COALESCE(SUM(pq.score), 0) as total_score
      FROM papers p
      LEFT JOIN paper_questions pq ON p.id = pq.paper_id
    `;
    const params: string[] = [];
    if (filter.statuses && filter.statuses.length > 0) {
      sql += ` WHERE p.status IN (${filter.statuses.map(() => '?').join(', ')})`;
      params.push(...filter.statuses);
    } else {
      // 0044：缺省排除 trashed（回收站不在常规列表；显式含 trashed 走 statuses）
      sql += ` WHERE p.status != 'trashed'`;
    }
    sql += ' GROUP BY p.id ORDER BY p.created_at DESC';

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map(row => ({
      paper: this.rowToPaper(row),
      questionCount: row.question_count,
      totalScore: row.total_score,
    }));
  }

  async getPaperEx(id: string): Promise<Paper | null> {
    const row = this.db.prepare('SELECT * FROM papers WHERE id = ?').get(id) as any;
    return row ? this.rowToPaper(row) : null;
  }

  async snapshotPaperQuestions(paperId: string): Promise<number> {
    const paper = await this.getPaperEx(paperId);
    if (!paper) throw new Error(`Paper ${paperId} not found`);

    const refs = this.db.prepare(`
      SELECT question_id, kind FROM paper_questions WHERE paper_id = ? ORDER BY position ASC
    `).all(paperId) as any[];

    const questionService = new QuestionService(this.db);
    const questions: Question[] = [];
    for (const ref of refs) {
      // 0004-fix-4 2.3：文本内容块不是题（不查 questions 表、不产快照行）；
      // 其正文存在 paper_questions.text_body，随 refs 带出（克隆/走读由行机制承担）
      if (ref.kind === 'text') continue;
      const q = await questionService.getQuestion(ref.question_id as string);
      // 题不存在（含软删）抛错：done 卷绝不允许缺题快照
      if (!q) throw new Error(`Question ${ref.question_id} not found (missing or deleted); snapshot aborted`);
      questions.push(q);
    }

    this.logger.wrap('paper.snapshot', `Snapshot ${questions.length} questions of paper ${paperId}`, () => {
      this.db.transaction(() => {
        for (const q of questions) {
          const contentSnapshot = JSON.stringify(q);
          // paper_snapshots 无唯一键，upsert 先查后写（幂等：重复快照覆盖同内容）
          const existing = this.db.prepare(`
            SELECT rowid FROM paper_snapshots WHERE paper_id = ? AND question_id = ?
          `).get(paperId, q.id) as any;
          if (existing) {
            this.db.prepare(`
              UPDATE paper_snapshots SET content_snapshot = ? WHERE paper_id = ? AND question_id = ?
            `).run(contentSnapshot, paperId, q.id);
          } else {
            this.db.prepare(`
              INSERT INTO paper_snapshots (paper_id, question_id, content_snapshot) VALUES (?, ?, ?)
            `).run(paperId, q.id, contentSnapshot);
          }
        }
      });
    });

    return questions.length;
  }

  async listPaperSnapshotQuestions(paperId: string): Promise<Question[]> {
    // JOIN paper_questions：只还原仍在卷内的快照，按 position 序（与出卷顺序一致）
    const rows = this.db.prepare(`
      SELECT ps.content_snapshot
      FROM paper_snapshots ps
      JOIN paper_questions pq ON pq.paper_id = ps.paper_id AND pq.question_id = ps.question_id
      WHERE ps.paper_id = ?
      ORDER BY pq.position ASC
    `).all(paperId) as any[];

    return rows.map(row => JSON.parse(row.content_snapshot) as Question);
  }

  async clonePaperToBasket(sourcePaperId: string, title?: string): Promise<Paper> {
    const source = await this.getPaperEx(sourcePaperId);
    if (!source) throw new Error(`Paper ${sourcePaperId} not found`);

    const refs = await this.getPaperQuestions(sourcePaperId);
    const questionService = new QuestionService(this.db);

    // 快照 map：question_id → content_snapshot（快照有行才走「原题在引用原 id / 原题失重建」分支）
    const snapRows = this.db.prepare(`
      SELECT question_id, content_snapshot FROM paper_snapshots WHERE paper_id = ?
    `).all(sourcePaperId) as any[];
    const snapMap = new Map(snapRows.map(r => [r.question_id as string, r.content_snapshot as string]));

    const resolved: Array<{
      questionId: string;
      score?: number;
      layout?: PaperQuestionRef['layout'];
      textBlock?: { text: string; style?: PaperTextBlockStyle; align?: PaperTextBlockAlign };
    }> = [];
    const skipped: string[] = [];
    for (const ref of refs) {
      // 0004-fix-4 2.3：文本内容块随行拷贝（kind/text_body/style；无 questions 行可解析）
      // 0004-fix-6 P1-1：text_align 随行拷贝
      if (ref.kind === 'text') {
        resolved.push({
          questionId: ref.questionId,
          textBlock: {
            text: ref.textBody ?? '',
            ...(ref.style ? { style: ref.style } : {}),
            ...(ref.align ? { align: ref.align } : {}),
          },
        });
        continue;
      }
      const snapshotJson = snapMap.get(ref.questionId);
      if (snapshotJson !== undefined) {
        const original = await questionService.getQuestion(ref.questionId);
        if (original) {
          // 原题仍在（未软删）：引用原题 id
          resolved.push({ questionId: ref.questionId, score: ref.score, layout: ref.layout });
        } else {
          // 原题软删/不存在：从快照重建新题再引用（题目不可变原则：不写回原题）
          const snapQuestion = JSON.parse(snapshotJson) as Question;
          const { id: _id, createdAt: _c, updatedAt: _u, ...rebuildData } = snapQuestion;
          void _id; void _c; void _u;
          const rebuilt = await questionService.createQuestion(rebuildData);
          resolved.push({ questionId: rebuilt.id, score: ref.score, layout: ref.layout });
        }
      } else {
        // 快照无行（旧卷未快照）：逐题取现题，缺失跳过
        const q = await questionService.getQuestion(ref.questionId);
        if (q) {
          resolved.push({ questionId: q.id, score: ref.score, layout: ref.layout });
        } else {
          skipped.push(ref.questionId);
        }
      }
    }

    const newTitle = title !== undefined ? title : `${source.title}复制`;
    const newPaper = await this.createPaperEx(newTitle, source.config, {
      status: 'basket',
      paperType: source.paperType ?? 'uniform',
    });
    if (source.layoutConfig) {
      await this.setPaperLayoutConfig(newPaper.id, source.layoutConfig);
    }
    for (const item of resolved) {
      // 0004-fix-2 F2-E：题级图排版覆盖（layout_json）随行拷贝——重新编辑后新卷图覆盖不丢
      // 0004-fix-4 2.3：文本内容块（kind/text_body/style）随行拷贝
      await this.addQuestion(newPaper.id, item.questionId, item.score, item.layout, item.textBlock);
    }

    if (skipped.length > 0) {
      this.logger.wrap('paper.clone', `Clone paper ${sourcePaperId} → ${newPaper.id}; skipped missing questions: ${skipped.join(', ')}`, () => undefined);
    }

    // 返回值带 layoutConfig（setPaperLayoutConfig 在 createPaperEx 之后落库）
    return source.layoutConfig ? { ...newPaper, layoutConfig: source.layoutConfig } : newPaper;
  }

  async updatePaperTitle(id: string, title: string): Promise<Paper> {
    if (!title || !title.trim()) throw new Error('Paper title cannot be empty');

    return this.logger.wrap('paper.updateTitle', `Rename paper ${id}`, () => {
      const row = this.db.prepare('SELECT id FROM papers WHERE id = ?').get(id) as any;
      if (!row) throw new Error(`Paper ${id} not found`);

      this.db.prepare('UPDATE papers SET title = ? WHERE id = ?').run(title, id);
      const updated = this.db.prepare('SELECT * FROM papers WHERE id = ?').get(id) as any;
      return this.rowToPaper(updated);
    });
  }

  async updatePaperStatus(id: string, status: PaperStatus): Promise<void> {
    this.logger.wrap('paper.updateStatus', `Update paper ${id} status to ${status}`, () => {
      const row = this.db.prepare('SELECT status FROM papers WHERE id = ?').get(id) as any;
      if (!row) throw new Error(`Paper ${id} not found`);

      const current = row.status as PaperStatus;
      if (current !== status && !ALLOWED_TRANSITIONS[current].includes(status)) {
        throw new Error(`Illegal paper status transition: ${current} -> ${status}`);
      }

      // 0044：入回收站记 trashed_from=原状态（restorePaper 依据）；离开 trashed 只走 restorePaper（清列）
      if (status === 'trashed') {
        this.db.prepare('UPDATE papers SET status = ?, trashed_from = ? WHERE id = ?').run(status, current, id);
      } else {
        this.db.prepare('UPDATE papers SET status = ? WHERE id = ?').run(status, id);
      }
    });
  }

  async setPaperLayoutConfig(id: string, layoutConfig: PaperLayoutConfig): Promise<void> {
    this.logger.wrap('paper.setLayoutConfig', `Set layout config for paper ${id}`, () => {
      const row = this.db.prepare('SELECT id FROM papers WHERE id = ?').get(id) as any;
      if (!row) throw new Error(`Paper ${id} not found`);

      this.db.prepare('UPDATE papers SET layout_config_json = ? WHERE id = ?')
        .run(JSON.stringify(layoutConfig), id);
    });
  }

  /**
   * 0004-fix-4 2.3：加行——textBlock 存在时写 kind='text' 文本内容块（不占题号）；
   * 同 (paperId, questionId) 已存在且为文本块 → upsert 更新正文/样式（复用本通道，不新增 IPC）。
   */
  async addQuestion(
    paperId: string,
    questionId: string,
    score?: number,
    layout?: PaperQuestionRef['layout'],
    textBlock?: { text: string; style?: PaperTextBlockStyle; align?: PaperTextBlockAlign }
  ): Promise<void> {
    this.logger.wrap(
      'paper.addQuestion',
      `Add ${textBlock ? 'text block' : 'question'} ${questionId} to paper ${paperId}`,
      () => {
        const existing = this.db.prepare(`
          SELECT id, kind FROM paper_questions WHERE paper_id = ? AND question_id = ?
        `).get(paperId, questionId) as { id: string; kind: string | null } | undefined;

        if (textBlock) {
          if (existing && existing.kind !== 'text') {
            throw new Error(`Row ${questionId} in paper ${paperId} is not a text block`);
          }
          if (existing) {
            // upsert 更新路径（编辑大标题正文/样式/对齐；fix-6 P1-1：align 缺省=清回 NULL 基线观感）
            this.db.prepare(`
              UPDATE paper_questions SET kind = 'text', text_body = ?, style = ?, text_align = ? WHERE id = ?
            `).run(textBlock.text, textBlock.style ?? 'section', textBlock.align ?? null, existing.id);
            return;
          }
          const maxPositionRow = this.db.prepare(`
            SELECT MAX(position) as max_pos FROM paper_questions WHERE paper_id = ?
          `).get(paperId) as any;
          const nextPosition = (maxPositionRow?.max_pos ?? -1) + 1;
          this.db.prepare(`
            INSERT INTO paper_questions (id, paper_id, question_id, position, score, frozen, layout_json, kind, text_body, style, text_align)
            VALUES (?, ?, ?, ?, NULL, 0, NULL, 'text', ?, ?, ?)
          `).run(crypto.randomUUID(), paperId, questionId, nextPosition, textBlock.text, textBlock.style ?? 'section', textBlock.align ?? null);
          return;
        }

        if (existing) throw new Error(`Row ${questionId} already exists in paper ${paperId}`);
        // 获取当前最大 position
        const maxPositionRow = this.db.prepare(`
          SELECT MAX(position) as max_pos FROM paper_questions WHERE paper_id = ?
        `).get(paperId) as any;

        const nextPosition = (maxPositionRow?.max_pos ?? -1) + 1;
        const id = crypto.randomUUID();

        this.db.prepare(`
          INSERT INTO paper_questions (id, paper_id, question_id, position, score, frozen, layout_json)
          VALUES (?, ?, ?, ?, ?, 0, ?)
        `).run(id, paperId, questionId, nextPosition, score ?? null, layout ? JSON.stringify(layout) : null);
      }
    );
  }

  async removeQuestion(paperId: string, questionId: string): Promise<void> {
    this.logger.wrap('paper.removeQuestion', `Remove question ${questionId} from paper ${paperId}`, () => {
      this.db.transaction(() => {
        // 删除该题目
        this.db.prepare(`
          DELETE FROM paper_questions WHERE paper_id = ? AND question_id = ?
        `).run(paperId, questionId);

        // 重新调整 position（连续递增）
        this.reorderPositionsAfterRemoval(paperId);
      });
    });
  }

  async reorderQuestions(paperId: string, questionIds: string[]): Promise<void> {
    this.logger.wrap('paper.reorderQuestions', `Reorder ${questionIds.length} questions in paper ${paperId}`, () => {
      this.db.transaction(() => {
        questionIds.forEach((qid, index) => {
          this.db.prepare(`
            UPDATE paper_questions SET position = ? WHERE paper_id = ? AND question_id = ?
          `).run(index, paperId, qid);
        });
      });
    });
  }

  async getPaperQuestions(paperId: string): Promise<PaperQuestionRef[]> {
    // 0004 Phase 5：layout_json 一并带出（题级图排版覆盖；NULL → undefined）
    // 0004-fix-4 2.3：kind/text_body/style 一并带出（'text'=文本内容块行）
    // 0004-fix-6 P1-1：text_align 一并带出（'text' 行对齐；NULL → undefined）
    const rows = this.db.prepare(`
      SELECT id, paper_id, question_id, position, score, frozen, layout_json, kind, text_body, style, text_align
      FROM paper_questions
      WHERE paper_id = ?
      ORDER BY position ASC
    `).all(paperId) as any[];

    return rows.map(row => ({
      id: row.id,
      paperId: row.paper_id,
      questionId: row.question_id,
      position: row.position,
      score: row.score ?? undefined,
      frozen: Boolean(row.frozen),
      ...(row.kind ? { kind: row.kind as PaperQuestionRef['kind'] } : {}),
      ...(row.text_body !== null && row.text_body !== undefined ? { textBody: row.text_body as string } : {}),
      ...(row.style ? { style: row.style as PaperTextBlockStyle } : {}),
      ...(row.text_align ? { align: row.text_align as PaperTextBlockAlign } : {}),
      ...(row.layout_json
        ? { layout: JSON.parse(row.layout_json) as PaperQuestionRef['layout'] }
        : {}),
    }));
  }

  async setQuestionLayouts(paperId: string, questionId: string, layout: NonNullable<PaperQuestionRef['layout']>): Promise<void> {
    this.logger.wrap('paper.setQuestionLayouts', `Set question layouts for ${questionId} in paper ${paperId}`, () => {
      const row = this.db.prepare(`
        SELECT id FROM paper_questions WHERE paper_id = ? AND question_id = ?
      `).get(paperId, questionId) as any;
      if (!row) throw new Error(`Question ${questionId} not found in paper ${paperId}`);

      this.db.prepare(`
        UPDATE paper_questions SET layout_json = ? WHERE id = ?
      `).run(JSON.stringify(layout), row.id);
    });
  }

  async setQuestionScore(paperId: string, questionId: string, score: number | undefined): Promise<void> {
    // 0018 目检返工三：undefined = 清除分值（score 列置 NULL，回未设置）
    this.logger.wrap('paper.setScore', `Set score ${score ?? 'NULL'} for question ${questionId} in paper ${paperId}`, () => {
      this.db.prepare(`
        UPDATE paper_questions SET score = ? WHERE paper_id = ? AND question_id = ?
      `).run(score ?? null, paperId, questionId);
    });
  }

  // ==================== 0044（只增）：试卷文件夹 + 回收站 ====================

  async listFolders(): Promise<PaperFolder[]> {
    const rows = this.db.prepare(`
      SELECT id, name, parent_id, sort, created_at FROM paper_folders ORDER BY created_at ASC, id ASC
    `).all() as any[];
    return rows.map((row) => this.rowToFolder(row));
  }

  async createFolder(data: { name: string; parentId?: string }): Promise<PaperFolder> {
    const name = data.name.trim();
    if (!name) throw new Error('Folder name cannot be empty');
    return this.logger.wrap('paper.folder.create', `Create folder ${name}`, () => {
      // 防环/悬空校验：父必须存在；父链上不得出现自身（新建时 id 未定，防御性走父链 + 访问集防数据环死循环）
      let parentId: string | undefined;
      if (data.parentId !== undefined) {
        const chain = this.folderAncestors(data.parentId);
        if (chain === null) throw new Error(`Parent folder ${data.parentId} not found`);
        parentId = data.parentId;
        void chain;
      }
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO paper_folders (id, name, parent_id, sort, created_at) VALUES (?, ?, ?, 0, ?)
      `).run(id, name, parentId ?? null, now);
      return { id, name, ...(parentId ? { parentId } : {}), sort: 0, createdAt: now };
    });
  }

  async renameFolder(id: string, name: string): Promise<PaperFolder> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Folder name cannot be empty');
    return this.logger.wrap('paper.folder.rename', `Rename folder ${id}`, () => {
      const row = this.db.prepare('SELECT * FROM paper_folders WHERE id = ?').get(id) as any;
      if (!row) throw new Error(`Folder ${id} not found`);
      this.db.prepare('UPDATE paper_folders SET name = ? WHERE id = ?').run(trimmed, id);
      return this.rowToFolder({ ...row, name: trimmed });
    });
  }

  async deleteFolder(id: string): Promise<void> {
    this.logger.wrap('paper.folder.delete', `Delete folder ${id}`, () => {
      const row = this.db.prepare('SELECT parent_id FROM paper_folders WHERE id = ?').get(id) as any;
      if (!row) throw new Error(`Folder ${id} not found`);

      // D-062 删夹口径（单事务）：夹内卷回未分类 + 子夹上移一级（被删夹为顶级则子夹升顶级）
      this.db.transaction(() => {
        this.db.prepare('UPDATE papers SET folder_id = NULL WHERE folder_id = ?').run(id);
        this.db.prepare('UPDATE paper_folders SET parent_id = ? WHERE parent_id = ?').run(row.parent_id ?? null, id);
        this.db.prepare('DELETE FROM paper_folders WHERE id = ?').run(id);
      });
    });
  }

  async moveToFolder(paperId: string, folderId: string | null): Promise<void> {
    this.logger.wrap('paper.moveToFolder', `Move paper ${paperId} to folder ${folderId ?? '(none)'}`, () => {
      if (!this.db.prepare('SELECT id FROM papers WHERE id = ?').get(paperId)) {
        throw new Error(`Paper ${paperId} not found`);
      }
      if (folderId !== null && !this.db.prepare('SELECT id FROM paper_folders WHERE id = ?').get(folderId)) {
        throw new Error(`Folder ${folderId} not found`);
      }
      this.db.prepare('UPDATE papers SET folder_id = ? WHERE id = ?').run(folderId, paperId);
    });
  }

  async trashPaper(id: string): Promise<void> {
    this.logger.wrap('paper.trash', `Trash paper ${id}`, () => {
      const row = this.db.prepare('SELECT status FROM papers WHERE id = ?').get(id) as any;
      if (!row) throw new Error(`Paper ${id} not found`);
      const current = row.status as PaperStatus;
      if (current === 'trashed') throw new Error(`Paper ${id} is already trashed`);
      this.db.prepare('UPDATE papers SET status = ?, trashed_from = ? WHERE id = ?').run('trashed', current, id);
    });
  }

  async restorePaper(id: string): Promise<void> {
    this.logger.wrap('paper.restore', `Restore paper ${id}`, () => {
      const row = this.db.prepare('SELECT status, trashed_from FROM papers WHERE id = ?').get(id) as any;
      if (!row) throw new Error(`Paper ${id} not found`);
      if (row.status !== 'trashed') throw new Error(`Paper ${id} is not in trash`);
      // trashed_from 缺失 = 数据异常，显式报错不猜（任务书：恢复=还原原状态）
      if (!row.trashed_from) throw new Error(`Paper ${id} has no trashed_from recorded`);
      this.db.prepare('UPDATE papers SET status = ?, trashed_from = NULL WHERE id = ?').run(row.trashed_from, id);
    });
  }

  async deleteForeverPaper(id: string): Promise<void> {
    this.logger.wrap('paper.deleteForever', `Delete forever paper ${id}`, () => {
      const row = this.db.prepare('SELECT status FROM papers WHERE id = ?').get(id) as any;
      if (!row) throw new Error(`Paper ${id} not found`);
      if (row.status !== 'trashed') throw new Error(`Paper ${id} is not in trash; deleteForever only works on trashed papers`);

      // 关联行级联清理：paper_questions（任务书口径）+ paper_snapshots / paper_set_papers
      // （彻底删除后孤儿快照与试卷集悬挂引用无处消费——服务端申报口径）；questions 表不动（题库独立存活）
      this.db.transaction(() => {
        this.db.prepare('DELETE FROM paper_questions WHERE paper_id = ?').run(id);
        this.db.prepare('DELETE FROM paper_snapshots WHERE paper_id = ?').run(id);
        this.db.prepare('DELETE FROM paper_set_papers WHERE paper_id = ?').run(id);
        this.db.prepare('DELETE FROM papers WHERE id = ?').run(id);
      });
    });
  }

  /** 父链遍历（防环：访问集护栏；父缺失返回 null——调用方据此抛错） */
  private folderAncestors(startParentId: string): string[] | null {
    const seen = new Set<string>();
    const chain: string[] = [];
    let cur: string | null = startParentId;
    while (cur) {
      if (seen.has(cur)) return chain; // 数据环防御：不再上行（服务无法产生环，兜底不炸）
      seen.add(cur);
      chain.push(cur);
      const row = this.db.prepare('SELECT parent_id FROM paper_folders WHERE id = ?').get(cur) as any;
      if (!row) return null;
      cur = (row.parent_id as string | null) ?? null;
    }
    return chain;
  }

  private rowToFolder(row: any): PaperFolder {
    return {
      id: row.id,
      name: row.name,
      ...(row.parent_id ? { parentId: row.parent_id as string } : {}),
      sort: typeof row.sort === 'number' ? row.sort : 0,
      createdAt: row.created_at,
    };
  }

  private rowToPaper(row: any): Paper {
    const status = row.status as PaperStatus;
    return {
      id: row.id,
      title: row.title,
      config: JSON.parse(row.config),
      createdAt: row.created_at,
      archived: status === 'archived',
      status,
      paperType: (row.paper_type as PaperType) ?? 'uniform',
      layoutConfig: row.layout_config_json ? (JSON.parse(row.layout_config_json) as PaperLayoutConfig) : undefined,
      // 0044：NULL → undefined（未分类）；归属文件夹列随各查询带出（listPapersEx/SELECT *）
      ...(row.folder_id ? { folderId: row.folder_id as string } : {}),
    };
  }

  private reorderPositionsAfterRemoval(paperId: string): void {
    const rows = this.db.prepare(`
      SELECT id FROM paper_questions WHERE paper_id = ? ORDER BY position
    `).all(paperId) as any[];

    rows.forEach((row, index) => {
      this.db.prepare(`
        UPDATE paper_questions SET position = ? WHERE id = ?
      `).run(index, row.id);
    });
  }
}
