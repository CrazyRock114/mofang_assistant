// 0002: 试卷集合服务（U7）——paper_sets/paper_set_papers
// uniform 统一卷集合（单卷=集合含一卷）/ custom-mistake 定制错题卷集合（每生一卷）。
// 0025 P3（只增）：batch_meta 写入校验 + 读出解析（结构口径见 paper-set-batch-meta.ts，未登记键保留）。

import type { PaperSet, PaperType, PaperSetPaperRef, PaperSetService } from '../shared/contracts/bank-types.js';
import type { Database } from './db.js';
import { OperationLogger } from './operation-log.js';
import { validateBatchMeta, parseBatchMeta } from './paper-set-batch-meta.js';

export class PaperSetServiceImpl implements PaperSetService {
  private logger: OperationLogger;

  constructor(private db: Database) {
    this.logger = new OperationLogger(db);
  }

  async createPaperSet(data: { name: string; type: PaperType; batchMeta?: Record<string, unknown> }): Promise<PaperSet> {
    return this.logger.wrap('paperSet.create', `Create paper set: ${data.name} (${data.type})`, () => {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      // 0025 P3：结构非法在写入前拒绝（不静默吞）
      if (data.batchMeta) validateBatchMeta(data.batchMeta);

      this.db.prepare(`
        INSERT INTO paper_sets (id, name, type, batch_meta, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, data.name, data.type, data.batchMeta ? JSON.stringify(data.batchMeta) : null, now);

      return {
        id,
        name: data.name,
        type: data.type,
        batchMeta: data.batchMeta,
        createdAt: now,
      };
    });
  }

  async getPaperSet(id: string): Promise<PaperSet | null> {
    const row = this.db.prepare('SELECT * FROM paper_sets WHERE id = ?').get(id) as any;
    return row ? this.rowToSet(row) : null;
  }

  async listPaperSets(filter: { type?: PaperType } = {}): Promise<PaperSet[]> {
    let sql = 'SELECT * FROM paper_sets';
    const params: any[] = [];
    if (filter.type) {
      sql += ' WHERE type = ?';
      params.push(filter.type);
    }
    sql += ' ORDER BY created_at DESC';

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map(row => this.rowToSet(row));
  }

  async addPaper(paperSetId: string, paperId: string, studentId?: string): Promise<void> {
    this.logger.wrap('paperSet.addPaper', `Add paper ${paperId} to set ${paperSetId}`, () => {
      if (!this.db.prepare('SELECT id FROM paper_sets WHERE id = ?').get(paperSetId)) {
        throw new Error(`Paper set ${paperSetId} not found`);
      }
      if (!this.db.prepare('SELECT id FROM papers WHERE id = ?').get(paperId)) {
        throw new Error(`Paper ${paperId} not found`);
      }

      // PK(paper_set_id, paper_id)：重复加入幂等（覆盖 studentId 标注）
      this.db.prepare(`
        INSERT INTO paper_set_papers (paper_set_id, paper_id, student_id)
        VALUES (?, ?, ?)
        ON CONFLICT (paper_set_id, paper_id) DO UPDATE SET student_id = excluded.student_id
      `).run(paperSetId, paperId, studentId ?? null);
    });
  }

  async removePaper(paperSetId: string, paperId: string): Promise<void> {
    this.logger.wrap('paperSet.removePaper', `Remove paper ${paperId} from set ${paperSetId}`, () => {
      this.db.prepare('DELETE FROM paper_set_papers WHERE paper_set_id = ? AND paper_id = ?')
        .run(paperSetId, paperId);
    });
  }

  async getSetPapers(paperSetId: string): Promise<PaperSetPaperRef[]> {
    const rows = this.db.prepare(`
      SELECT paper_set_id, paper_id, student_id
      FROM paper_set_papers WHERE paper_set_id = ?
      ORDER BY rowid
    `).all(paperSetId) as any[];
    return rows.map(row => ({
      paperSetId: row.paper_set_id,
      paperId: row.paper_id,
      studentId: row.student_id ?? undefined,
    }));
  }

  async getStudentPaper(paperSetId: string, studentId: string): Promise<PaperSetPaperRef | null> {
    const row = this.db.prepare(`
      SELECT paper_set_id, paper_id, student_id
      FROM paper_set_papers WHERE paper_set_id = ? AND student_id = ?
    `).get(paperSetId, studentId) as any;
    return row ? {
      paperSetId: row.paper_set_id,
      paperId: row.paper_id,
      studentId: row.student_id,
    } : null;
  }

  async deletePaperSet(id: string): Promise<void> {
    this.logger.wrap('paperSet.delete', `Delete paper set ${id}`, () => {
      // B11：删集合，引用的 papers 保留不动
      this.db.transaction(() => {
        this.db.prepare('DELETE FROM paper_set_papers WHERE paper_set_id = ?').run(id);
        this.db.prepare('DELETE FROM paper_sets WHERE id = ?').run(id);
      });
    });
  }

  private rowToSet(row: any): PaperSet {
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      // 0025 P3：读出解析（坏 JSON / 坏结构显式报错，不静默回落 undefined）
      batchMeta: parseBatchMeta(row.batch_meta),
      createdAt: row.created_at,
    };
  }
}
