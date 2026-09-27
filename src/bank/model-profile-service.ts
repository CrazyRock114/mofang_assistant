// 0023 P1: 模型档案 service（真实 SQLite 实现）——model_profiles 表
// 红线（D-043）：key_encrypted 只在本文件内部经 getKeyEncrypted 供主进程托管层取用；
// list/get/getEnabledProfile 一律剥离，只回 hasKey（契约测试钉死）。
// 启用守卫（P1.2）：同 role 至多一条 is_enabled=1，启用动作在事务内排他；P-18 未测通禁启用。

import type {
  ModelProfile, ModelProfileInput, ModelProfileListFilter, ModelProfileService, ModelProfileUpdate,
  ModelCapability, ModelRole,
} from '../shared/contracts/ai-types.js';
import { MODEL_ROLES, PROTOCOL_OPENAI_CHAT } from '../shared/contracts/ai-types.js';
import type { Database } from './db.js';
import { OperationLogger } from './operation-log.js';

/** model_profiles 行形态（key_encrypted 仅本层可见） */
interface ModelProfileRow {
  id: string;
  role: string;
  name: string;
  provider: string;
  protocol: string;
  base_url: string;
  model: string;
  key_encrypted: string | null;
  capability: string | null;
  is_enabled: number;
  last_test_at: string | null;
  last_test_ok: number | null;
  created_at: string;
  updated_at: string;
}

/** 行 → 对外形态：剥离 key_encrypted，只回 hasKey */
function rowToProfile(row: ModelProfileRow): ModelProfile {
  let capability: ModelCapability | null = null;
  if (row.capability !== null && row.capability !== '') {
    capability = JSON.parse(row.capability) as ModelCapability;
  }
  return {
    id: row.id,
    role: row.role as ModelRole,
    name: row.name,
    provider: row.provider,
    protocol: row.protocol,
    baseUrl: row.base_url,
    model: row.model,
    capability,
    isEnabled: row.is_enabled === 1,
    hasKey: row.key_encrypted !== null,
    lastTestAt: row.last_test_at,
    lastTestOk: row.last_test_ok === null ? null : row.last_test_ok === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requireNonEmpty(value: string | undefined, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field}不能为空`);
  }
  return value;
}

/** 建档/更新共用校验：role 枚举 + 必填非空 + protocol 非空（返回归一后的 protocol） */
function validateFields(role: string, name: string, provider: string, baseUrl: string, model: string, protocol: string): void {
  if (!MODEL_ROLES.includes(role as ModelRole)) {
    throw new Error(`角色不合法: ${role}`);
  }
  requireNonEmpty(name, '档案名称');
  requireNonEmpty(provider, 'provider');
  requireNonEmpty(baseUrl, 'base_url');
  requireNonEmpty(model, 'model');
  requireNonEmpty(protocol, 'protocol');
}

export class ModelProfileServiceImpl implements ModelProfileService {
  private logger: OperationLogger;

  constructor(private db: Database) {
    this.logger = new OperationLogger(db);
  }

  async createProfile(data: ModelProfileInput): Promise<ModelProfile> {
    const role = data.role;
    const name = data.name;
    const provider = data.provider;
    const protocol = data.protocol ?? PROTOCOL_OPENAI_CHAT;
    validateFields(role, name, provider, data.baseUrl, data.model, protocol);

    return this.logger.wrap('modelProfile.create', `Create model profile: ${name}`, () => {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const capability = data.capability ? JSON.stringify(data.capability) : null;
      const keyEncrypted = data.keyEncrypted ?? null;

      this.db.prepare(`
        INSERT INTO model_profiles (
          id, role, name, provider, protocol, base_url, model,
          key_encrypted, capability, is_enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      `).run(id, role, name, provider, protocol, data.baseUrl, data.model, keyEncrypted, capability, now, now);

      return rowToProfile(this.getRow(id)!);
    });
  }

  async getProfile(id: string): Promise<ModelProfile | null> {
    const row = this.getRow(id);
    return row ? rowToProfile(row) : null;
  }

  async listProfiles(filter: ModelProfileListFilter = {}): Promise<ModelProfile[]> {
    if (filter.role !== undefined) {
      if (!MODEL_ROLES.includes(filter.role)) {
        throw new Error(`角色不合法: ${filter.role}`);
      }
      const rows = this.db.prepare('SELECT * FROM model_profiles WHERE role = ? ORDER BY created_at').all(filter.role) as unknown as ModelProfileRow[];
      return rows.map(rowToProfile);
    }
    const rows = this.db.prepare('SELECT * FROM model_profiles ORDER BY role, created_at').all() as unknown as ModelProfileRow[];
    return rows.map(rowToProfile);
  }

  async updateProfile(id: string, data: ModelProfileUpdate): Promise<ModelProfile> {
    return this.logger.wrap('modelProfile.update', `Update model profile ${id}`, () => {
      const row = this.getRow(id);
      if (!row) throw new Error(`模型档案 ${id} 不存在`);

      const next = {
        name: data.name ?? row.name,
        provider: data.provider ?? row.provider,
        protocol: data.protocol ?? row.protocol,
        base_url: data.baseUrl ?? row.base_url,
        model: data.model ?? row.model,
        capability: data.capability === undefined ? row.capability : (data.capability ? JSON.stringify(data.capability) : null),
        // undefined=保持不变；显式 null=清除 Key
        key_encrypted: data.keyEncrypted === undefined ? row.key_encrypted : (data.keyEncrypted ?? null),
      };
      validateFields(row.role, next.name, next.provider, next.base_url, next.model, next.protocol);

      this.db.prepare(`
        UPDATE model_profiles
        SET name = ?, provider = ?, protocol = ?, base_url = ?, model = ?, capability = ?, key_encrypted = ?, updated_at = ?
        WHERE id = ?
      `).run(next.name, next.provider, next.protocol, next.base_url, next.model, next.capability, next.key_encrypted, new Date().toISOString(), id);

      return rowToProfile(this.getRow(id)!);
    });
  }

  async deleteProfile(id: string): Promise<void> {
    this.logger.wrap('modelProfile.delete', `Delete model profile ${id}`, () => {
      const row = this.getRow(id);
      if (!row) throw new Error(`模型档案 ${id} 不存在`);
      this.db.prepare('DELETE FROM model_profiles WHERE id = ?').run(id);
    });
  }

  async setProfileEnabled(id: string, enabled: boolean): Promise<ModelProfile> {
    return this.logger.wrap('modelProfile.setEnabled', `${enabled ? 'Enable' : 'Disable'} model profile ${id}`, () => {
      // P-18 双保险 + 排他切换在同一事务内（任务书 P1.2：启用动作在事务内排他）
      return this.db.transaction(() => {
        const row = this.getRow(id);
        if (!row) throw new Error(`模型档案 ${id} 不存在`);

        if (enabled) {
          if (row.last_test_ok !== 1) {
            throw new Error('该档案尚未通过连通性测试（或最近一次测试失败），禁止启用');
          }
          this.db.prepare('UPDATE model_profiles SET is_enabled = 0 WHERE role = ? AND id != ?').run(row.role, id);
          this.db.prepare('UPDATE model_profiles SET is_enabled = 1, updated_at = ? WHERE id = ?').run(new Date().toISOString(), id);
        } else {
          this.db.prepare('UPDATE model_profiles SET is_enabled = 0, updated_at = ? WHERE id = ?').run(new Date().toISOString(), id);
        }
        return rowToProfile(this.getRow(id)!);
      });
    });
  }

  async recordTestResult(id: string, ok: boolean, testedAt: string): Promise<void> {
    this.logger.wrap('modelProfile.recordTestResult', `Record test result (${ok ? 'ok' : 'fail'}) for ${id}`, () => {
      const row = this.getRow(id);
      if (!row) throw new Error(`模型档案 ${id} 不存在`);
      this.db.prepare('UPDATE model_profiles SET last_test_at = ?, last_test_ok = ? WHERE id = ?')
        .run(testedAt, ok ? 1 : 0, id);
    });
  }

  async getEnabledProfile(role: ModelRole): Promise<ModelProfile | null> {
    if (!MODEL_ROLES.includes(role)) {
      throw new Error(`角色不合法: ${role}`);
    }
    const row = this.db.prepare('SELECT * FROM model_profiles WHERE role = ? AND is_enabled = 1').get(role) as ModelProfileRow | undefined;
    return row ? rowToProfile(row) : null;
  }

  async getKeyEncrypted(id: string): Promise<string | null> {
    const row = this.getRow(id);
    return row ? row.key_encrypted : null;
  }

  private getRow(id: string): ModelProfileRow | undefined {
    return this.db.prepare('SELECT * FROM model_profiles WHERE id = ?').get(id) as ModelProfileRow | undefined;
  }
}
