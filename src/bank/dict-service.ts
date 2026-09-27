// 0002: 字典服务（G2/U6/U12）——dict_entries CRUD + 归一行重名守卫
// 依据：schema 草案 §2.1 + 拍板 §6-10（SQLite 唯一约束不拦 NULL 列，归一行重名由 service 层负责）

import type { DictEntry, DictEntryInput, DictKind, DictService } from '../shared/contracts/bank-types.js';
import type { Database } from './db.js';
import { OperationLogger } from './operation-log.js';

const KIND_ID_PREFIX: Record<DictKind, string> = {
  subject: 'subj',
  question_type: 'qtype',
  difficulty: 'diff',
};

export class DictServiceImpl implements DictService {
  private logger: OperationLogger;

  constructor(private db: Database) {
    this.logger = new OperationLogger(db);
  }

  async listEntries(filter: { kind?: DictKind; activeOnly?: boolean } = {}): Promise<DictEntry[]> {
    let sql = 'SELECT * FROM dict_entries WHERE 1=1';
    const params: any[] = [];

    if (filter.kind) {
      sql += ' AND kind = ?';
      params.push(filter.kind);
    }
    if (filter.activeOnly) {
      sql += ' AND active = 1';
    }

    // 归一行在前（site IS NULL DESC），组内按 code 升序
    sql += ' ORDER BY kind, site IS NULL DESC, code';

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map(row => this.rowToEntry(row));
  }

  async getEntry(id: string): Promise<DictEntry | null> {
    const row = this.db.prepare('SELECT * FROM dict_entries WHERE id = ?').get(id) as any;
    return row ? this.rowToEntry(row) : null;
  }

  async createEntry(data: DictEntryInput): Promise<DictEntry> {
    return this.logger.wrap('dict.create', `Create dict entry ${data.kind}:${data.code}${data.site ? `@${data.site}` : ''}`, () => {
      const normalized = !data.site;

      // 拍板 §6-10 重名守卫：归一行同 kind 同 label 重名拒绝（UNIQUE 约束不拦 site=NULL）
      if (normalized) {
        const dup = this.db.prepare(
          'SELECT id FROM dict_entries WHERE kind = ? AND site IS NULL AND label = ?'
        ).get(data.kind, data.label) as any;
        if (dup) {
          throw new Error(`Duplicate normalized dict entry: ${data.kind} "${data.label}" already exists (${dup.id})`);
        }
      }

      // 部分唯一索引 uq_dict_normalized_code 兜底归一行 code 冲突；站点行由 UNIQUE(kind, site, source_label) 兜底
      const id = normalized
        ? `${KIND_ID_PREFIX[data.kind]}:${data.code}`
        : `${KIND_ID_PREFIX[data.kind]}:${data.site}:${data.sourceLabel ?? data.label}`;

      this.db.prepare(`
        INSERT INTO dict_entries (id, kind, code, label, site, source_label, active)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        data.kind,
        data.code,
        data.label,
        data.site ?? null,
        data.sourceLabel ?? null,
        data.active === false ? 0 : 1
      );

      return {
        id,
        kind: data.kind,
        code: data.code,
        label: data.label,
        site: data.site,
        sourceLabel: data.sourceLabel,
        active: data.active !== false,
      };
    });
  }

  async updateEntry(id: string, data: { code?: string; label?: string; active?: boolean }): Promise<DictEntry> {
    return this.logger.wrap('dict.update', `Update dict entry ${id}`, () => {
      const existing = this.db.prepare('SELECT * FROM dict_entries WHERE id = ?').get(id) as any;
      if (!existing) throw new Error(`Dict entry ${id} not found`);

      // 0016 P1-3 指认守卫：patch.code 须指向同 kind 已建归一行（site IS NULL）
      //（对齐 applySubjectAssignments 守卫语义 tree-subject-fix.ts:68-69；mock 侧 mock-ext.ts 同构实现）
      if (data.code !== undefined) {
        const target = this.db.prepare(
          'SELECT id FROM dict_entries WHERE kind = ? AND site IS NULL AND code = ?'
        ).get(existing.kind, data.code);
        if (!target) {
          throw new Error(`未知归一码 "${data.code}"（kind=${existing.kind} 无此归一行；指认须指向同 kind 已建归一行）`);
        }
      }

      const next = {
        code: data.code ?? existing.code,
        label: data.label ?? existing.label,
        active: data.active !== undefined ? (data.active ? 1 : 0) : existing.active,
      };

      this.db.prepare('UPDATE dict_entries SET code = ?, label = ?, active = ? WHERE id = ?')
        .run(next.code, next.label, next.active, id);

      return this.rowToEntry({ ...existing, ...next });
    });
  }

  private rowToEntry(row: any): DictEntry {
    return {
      id: row.id,
      kind: row.kind,
      code: row.code,
      label: row.label,
      site: row.site ?? undefined,
      sourceLabel: row.source_label ?? undefined,
      active: Boolean(row.active),
    };
  }
}
