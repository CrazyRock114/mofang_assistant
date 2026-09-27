// 0002: 版式预设服务（G7/U4）——layout_presets
// 受控 PaperLayoutConfig（version 化）；B11：内置不可删，用户预设软删；已出卷 config 拷贝不受影响。

import type { LayoutPreset, PresetService } from '../shared/contracts/bank-types.js';
import type { Database } from './db.js';
import { OperationLogger } from './operation-log.js';

export class PresetServiceImpl implements PresetService {
  private logger: OperationLogger;

  constructor(private db: Database) {
    this.logger = new OperationLogger(db);
  }

  async createPreset(data: { name: string; config: LayoutPreset['config']; isBuiltin?: boolean }): Promise<LayoutPreset> {
    return this.logger.wrap('preset.create', `Create preset: ${data.name}`, () => {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      this.db.prepare(`
        INSERT INTO layout_presets (id, name, config_json, is_builtin, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, data.name, JSON.stringify(data.config), data.isBuiltin ? 1 : 0, now);

      return {
        id,
        name: data.name,
        config: data.config,
        isBuiltin: Boolean(data.isBuiltin),
        createdAt: now,
      };
    });
  }

  async getPreset(id: string): Promise<LayoutPreset | null> {
    const row = this.db.prepare('SELECT * FROM layout_presets WHERE id = ? AND deleted = 0').get(id) as any;
    return row ? this.rowToPreset(row) : null;
  }

  async listPresets(filter: { includeDeleted?: boolean } = {}): Promise<LayoutPreset[]> {
    const sql = filter.includeDeleted
      ? 'SELECT * FROM layout_presets ORDER BY is_builtin DESC, created_at'
      : 'SELECT * FROM layout_presets WHERE deleted = 0 ORDER BY is_builtin DESC, created_at';
    const rows = this.db.prepare(sql).all() as any[];
    return rows.map(row => this.rowToPreset(row));
  }

  async updatePreset(id: string, data: { name?: string; config?: LayoutPreset['config'] }): Promise<LayoutPreset> {
    return this.logger.wrap('preset.update', `Update preset ${id}`, () => {
      const existing = this.db.prepare('SELECT * FROM layout_presets WHERE id = ? AND deleted = 0').get(id) as any;
      if (!existing) throw new Error(`Preset ${id} not found`);
      // 0004 守卫补全（对齐 B11 拍板）：内置预设不可改（应用可、改不可）
      if (existing.is_builtin) throw new Error('Built-in preset cannot be updated');

      const next = {
        name: data.name ?? existing.name,
        config_json: data.config ? JSON.stringify(data.config) : existing.config_json,
      };

      this.db.prepare('UPDATE layout_presets SET name = ?, config_json = ? WHERE id = ?')
        .run(next.name, next.config_json, id);

      return this.rowToPreset({ ...existing, ...next });
    });
  }

  async deletePreset(id: string): Promise<void> {
    this.logger.wrap('preset.delete', `Delete preset ${id}`, () => {
      const row = this.db.prepare('SELECT * FROM layout_presets WHERE id = ? AND deleted = 0').get(id) as any;
      if (!row) throw new Error(`Preset ${id} not found`);
      if (row.is_builtin) throw new Error('Built-in preset cannot be deleted');

      // B11：用户预设软删；已出卷的 config 拷贝在 papers.layout_config_json，不受影响
      this.db.prepare('UPDATE layout_presets SET deleted = 1 WHERE id = ?').run(id);
    });
  }

  private rowToPreset(row: any): LayoutPreset {
    return {
      id: row.id,
      name: row.name,
      config: JSON.parse(row.config_json),
      isBuiltin: Boolean(row.is_builtin),
      createdAt: row.created_at,
    };
  }
}
