// 0023: mock 模型档案 service（内存实现）——与真实 ModelProfileServiceImpl 契约测试双跑同绿（D-005）。
// 语义逐字对齐真实层：启用排他（同 role 至多一条）、P-18 未测通禁启用、对外剥离 keyEncrypted 只回 hasKey。

import type {
  ModelProfile, ModelProfileInput, ModelProfileListFilter, ModelProfileService, ModelProfileUpdate, ModelRole,
  AiInvokeResult, AiProfileCreatePayload, AiProfileIdPayload, AiProfileListPayload,
  AiProfileSetEnabledPayload, AiProfileTestConnectionPayload, AiProfileUpdatePayload,
  AiTestConnectionResult, AiInvokePayload, AiModelsListPayload, AiModelsListResult,
} from '../../shared/contracts/ai-types.js';
// 0029（只增）：AI 挂树/打标建议 payload/结果（demo 桥如实报「桌面端功能」）
import type {
  AiAnchorStatusPayload, AiAnchorStatusResult, AiSuggestMeta, AiSuggestPayload, AiSuggestResult,
} from '../../shared/contracts/ai-suggest-types.js';
// 0040（只增）：工作台草稿挂树建议 payload（类型单源 onestep-types.ts）
import type { AiSuggestTreeForDraftPayload } from '../../shared/contracts/onestep-types.js';
import type { MofangAiBridge } from '../../shared/contracts/bridge.js';
import { MODEL_ROLES, PROTOCOL_OPENAI_CHAT } from '../../shared/contracts/ai-types.js';
import type { MockBankStore } from './mock-store.js';

function requireNonEmpty(value: string | undefined, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field}不能为空`);
  }
  return value;
}

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

/** 行 → 对外形态：剥离 keyEncrypted，只回 hasKey（与真实 rowToProfile 语义一致） */
function stripKey(row: ModelProfile & { keyEncrypted: string | null }): ModelProfile {
  const { keyEncrypted, ...rest } = row;
  void keyEncrypted;
  return { ...rest, hasKey: row.keyEncrypted !== null };
}

export function createMockModelProfileService(store: MockBankStore): ModelProfileService {
  const clone = (p: ModelProfile & { keyEncrypted: string | null }): ModelProfile & { keyEncrypted: string | null } =>
    JSON.parse(JSON.stringify(p)) as ModelProfile & { keyEncrypted: string | null };

  const svc: ModelProfileService = {
    async createProfile(data: ModelProfileInput): Promise<ModelProfile> {
      const protocol = data.protocol ?? PROTOCOL_OPENAI_CHAT;
      validateFields(data.role, data.name, data.provider, data.baseUrl, data.model, protocol);

      const now = new Date().toISOString();
      const row: ModelProfile & { keyEncrypted: string | null } = {
        id: `model-profile-${store.modelProfiles.size + 1}-${Math.floor(Math.random() * 1e6)}`,
        role: data.role,
        name: data.name,
        provider: data.provider,
        protocol,
        baseUrl: data.baseUrl,
        model: data.model,
        capability: data.capability ? { ...data.capability } : null,
        isEnabled: false,
        hasKey: false,
        lastTestAt: null,
        lastTestOk: null,
        createdAt: now,
        updatedAt: now,
        keyEncrypted: data.keyEncrypted ?? null,
      };
      store.modelProfiles.set(row.id, row);
      store.log('modelProfile.create', `Create model profile: ${data.name}`);
      return stripKey(clone(row));
    },

    async getProfile(id: string): Promise<ModelProfile | null> {
      const row = store.modelProfiles.get(id);
      return row ? stripKey(clone(row)) : null;
    },

    async listProfiles(filter: ModelProfileListFilter = {}): Promise<ModelProfile[]> {
      let rows = [...store.modelProfiles.values()];
      if (filter.role !== undefined) {
        if (!MODEL_ROLES.includes(filter.role)) {
          throw new Error(`角色不合法: ${filter.role}`);
        }
        rows = rows.filter((r) => r.role === filter.role);
      }
      rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.role.localeCompare(b.role));
      return rows.map((r) => stripKey(clone(r)));
    },

    async updateProfile(id: string, data: ModelProfileUpdate): Promise<ModelProfile> {
      const row = store.modelProfiles.get(id);
      if (!row) throw new Error(`模型档案 ${id} 不存在`);

      const next = {
        name: data.name ?? row.name,
        provider: data.provider ?? row.provider,
        protocol: data.protocol ?? row.protocol,
        baseUrl: data.baseUrl ?? row.baseUrl,
        model: data.model ?? row.model,
        capability: data.capability === undefined ? row.capability : (data.capability ? { ...data.capability } : null),
        keyEncrypted: data.keyEncrypted === undefined ? row.keyEncrypted : (data.keyEncrypted ?? null),
      };
      validateFields(row.role, next.name, next.provider, next.baseUrl, next.model, next.protocol);

      Object.assign(row, next, { updatedAt: new Date().toISOString() });
      store.log('modelProfile.update', `Update model profile ${id}`);
      return stripKey(clone(row));
    },

    async deleteProfile(id: string): Promise<void> {
      const row = store.modelProfiles.get(id);
      if (!row) throw new Error(`模型档案 ${id} 不存在`);
      store.modelProfiles.delete(id);
      store.log('modelProfile.delete', `Delete model profile ${id}`);
    },

    async setProfileEnabled(id: string, enabled: boolean): Promise<ModelProfile> {
      const row = store.modelProfiles.get(id);
      if (!row) throw new Error(`模型档案 ${id} 不存在`);

      if (enabled) {
        if (row.lastTestOk !== true) {
          throw new Error('该档案尚未通过连通性测试（或最近一次测试失败），禁止启用');
        }
        // 同 role 排他：先停同角色其余档案（真实层同事务语义）
        for (const other of store.modelProfiles.values()) {
          if (other.role === row.role && other.id !== id) other.isEnabled = false;
        }
      }
      row.isEnabled = enabled;
      row.updatedAt = new Date().toISOString();
      store.log('modelProfile.setEnabled', `${enabled ? 'Enable' : 'Disable'} model profile ${id}`);
      return stripKey(clone(row));
    },

    async recordTestResult(id: string, ok: boolean, testedAt: string): Promise<void> {
      const row = store.modelProfiles.get(id);
      if (!row) throw new Error(`模型档案 ${id} 不存在`);
      row.lastTestAt = testedAt;
      row.lastTestOk = ok;
      store.log('modelProfile.recordTestResult', `Record test result (${ok ? 'ok' : 'fail'}) for ${id}`);
    },

    async getEnabledProfile(role: ModelRole): Promise<ModelProfile | null> {
      if (!MODEL_ROLES.includes(role)) {
        throw new Error(`角色不合法: ${role}`);
      }
      const row = [...store.modelProfiles.values()].find((r) => r.role === role && r.isEnabled);
      return row ? stripKey(clone(row)) : null;
    },

    async getKeyEncrypted(id: string): Promise<string | null> {
      const row = store.modelProfiles.get(id);
      return row ? row.keyEncrypted : null;
    },
  };

  return svc;
}

// ==================== 0023：renderer 演示桥（浏览器 demo 无 __mofangAi 时回落） ====================

/**
 * 浏览器 demo 用 mock ai 桥：档案 CRUD 走内存 service（明文 Key 原样充当 keyEncrypted 占位——
 * demo 无托管层，语义演示用）；测连通/invoke 如实返回「桌面端功能」失败，不静默造假。
 */
export function createMockAiBridge(store: MockBankStore): MofangAiBridge {
  const profiles = createMockModelProfileService(store);
  return {
    profile: {
      list: (payload = {}) => profiles.listProfiles(payload.filter),
      create: async (payload: AiProfileCreatePayload) => {
        const { apiKey, ...rest } = payload.data;
        const input: ModelProfileInput = { ...rest, keyEncrypted: apiKey ?? null };
        return profiles.createProfile(input);
      },
      update: async (payload: AiProfileUpdatePayload) => {
        const { apiKey, ...rest } = payload.data;
        const update: ModelProfileUpdate = { ...rest };
        if (apiKey !== undefined) update.keyEncrypted = apiKey === '' ? null : apiKey;
        return profiles.updateProfile(payload.id, update);
      },
      delete: (payload: AiProfileIdPayload) => profiles.deleteProfile(payload.id),
      setEnabled: (payload: AiProfileSetEnabledPayload) => profiles.setProfileEnabled(payload.id, payload.enabled),
      testConnection: async (payload: AiProfileTestConnectionPayload): Promise<AiTestConnectionResult> => {
        const p = await profiles.getProfile(payload.profileId);
        if (!p) throw new Error(`模型档案 ${payload.profileId} 不存在`);
        if (!p.hasKey) return { ok: false, latencyMs: null, error: '该档案未配置 API Key，请先在编辑表单填入 Key' };
        return { ok: false, latencyMs: null, error: '浏览器演示环境不支持真实连通性测试（桌面端可用）' };
      },
    },
    invoke: async (_payload: AiInvokePayload): Promise<AiInvokeResult> => ({
      ok: false,
      error: '浏览器演示环境未接入模型网关（ai.invoke 仅桌面端可用）',
      latencyMs: 0,
    }),
    // 0023 目检返工 R3（只增）：demo 环境如实失败（不静默造假）
    models: {
      list: async (_payload: AiModelsListPayload): Promise<AiModelsListResult> => ({
        ok: false,
        models: [],
        error: '浏览器演示环境不支持获取模型列表（桌面端可用）',
      }),
    },
    // 0029（只增）：AI 挂树/打标建议——demo 环境如实报「桌面端功能」（不静默造假；
    // meta 回执全零，锚点状态按 empty-anchor 口径回带原因文本）
    suggest: {
      anchorStatus: async (payload: AiAnchorStatusPayload): Promise<AiAnchorStatusResult> => ({
        status: 'empty-anchor',
        reason: '浏览器演示环境未接入锚点快照（AI 建议仅桌面端可用）',
        meta: zeroMeta(payload.query),
        warnings: [],
      }),
      treeLink: async (payload: AiSuggestPayload): Promise<AiSuggestResult> => unavailableResult(payload),
      tags: async (payload: AiSuggestPayload): Promise<AiSuggestResult> => unavailableResult(payload),
      // 0040（只增）：工作台草稿挂树建议——demo 环境同口径如实报不可用（meta 以 subjectId/stage 回显）
      treeForDraft: async (payload: AiSuggestTreeForDraftPayload): Promise<AiSuggestResult> =>
        unavailableResult({
          questionIds: ['draft-1'],
          query: { subjectId: payload.subjectId ?? '', ...(payload.stage ? { stage: payload.stage } : {}) },
        }),
    },
  };
}

/** 0029：demo meta 回执（全零；subjectId/stage 回显入参） */
function zeroMeta(query: AiSuggestPayload['query']): AiSuggestMeta {
  return {
    stage: query.stage ?? '',
    subjectId: query.subjectId,
    questionCount: 0,
    treeCount: 0,
    totalNodeCount: 0,
    injectedNodeCount: 0,
    truncatedNodeCount: 0,
    injectedTokens: 0,
  };
}

/** 0029：demo 建议结果（unavailable 口径，与 mock invoke 同语态） */
function unavailableResult(payload: AiSuggestPayload): AiSuggestResult {
  return {
    status: 'unavailable',
    reason: '浏览器演示环境未接入模型网关（AI 建议仅桌面端可用）',
    meta: zeroMeta(payload.query),
    warnings: [],
    none: false,
    suggestions: [],
    tagSuggestions: [],
    drafts: [],
    duplicates: [],
    latencyMs: null,
  };
}
