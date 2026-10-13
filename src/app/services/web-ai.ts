// 纯网页端 AI 桥：浏览器原生 Fetch 直连大模型，无后台服务中转
import type {
  AiInvokePayload,
  AiInvokeResult,
  AiModelsListPayload,
  AiModelsListResult,
  AiProfileCreatePayload,
  AiProfileIdPayload,
  AiProfileListPayload,
  AiProfileSetEnabledPayload,
  AiProfileTestConnectionPayload,
  AiProfileUpdatePayload,
  AiTestConnectionResult,
  ModelProfileInput,
  ModelProfileUpdate,
} from '../../shared/contracts/ai-types.js';
import type {
  AiAnchorStatusPayload,
  AiAnchorStatusResult,
  AiSuggestPayload,
  AiSuggestResult,
} from '../../shared/contracts/ai-suggest-types.js';
import type { AiSuggestTreeForDraftPayload } from '../../shared/contracts/onestep-types.js';
import type { MofangAiBridge } from '../../shared/contracts/bridge.js';
import type { MockBankStore } from '../../bank/mock/mock-store.js';
import { createMockModelProfileService } from '../../bank/mock/mock-ai.js';
import { chatCompletion, listModels } from '../../shell/ai/proxy.js';

export function createWebAiBridge(store: MockBankStore): MofangAiBridge {
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
        const apiKey = await profiles.getKeyEncrypted(payload.profileId);
        if (!apiKey) {
          return { ok: false, latencyMs: null, error: '该档案未配置 API Key，请先在编辑表单填入 Key' };
        }

        const t0 = performance.now();
        try {
          // 发送短文本连通性测试
          await chatCompletion({
            baseUrl: p.baseUrl,
            model: p.model,
            apiKey,
            messages: [{ role: 'user', content: '连通性测试：请回复 pong' }],
            timeoutMs: 15_000,
          });
          const latencyMs = Math.round(performance.now() - t0);
          await profiles.recordTestResult(payload.profileId, true, new Date().toISOString());
          return { ok: true, latencyMs };
        } catch (err) {
          const latencyMs = Math.round(performance.now() - t0);
          const errorMsg = err instanceof Error ? err.message : String(err);
          await profiles.recordTestResult(payload.profileId, false, new Date().toISOString());
          return {
            ok: false,
            latencyMs,
            error: `连通性测试失败：${errorMsg}（若遇到跨域 CORS 错误，请检查 API 服务商是否允许浏览器直接请求，或配置支持 CORS 的代理地址）`,
          };
        }
      },
    },

    invoke: async (payload: AiInvokePayload): Promise<AiInvokeResult> => {
      // 查找该角色启用的档案
      const profile = await profiles.getEnabledProfile(payload.role);
      if (!profile) {
        return {
          ok: false,
          latencyMs: 0,
          error: `角色「${payload.role}」尚未启用模型档案。请先在「设置 → 模型配置」中添加模型、测试通过后开启。`,
        };
      }

      const apiKey = await profiles.getKeyEncrypted(profile.id);
      if (!apiKey) {
        return {
          ok: false,
          latencyMs: 0,
          error: `模型档案「${profile.name}」未配置有效的 API Key`,
        };
      }

      const t0 = performance.now();
      try {
        const outcome = await chatCompletion({
          baseUrl: profile.baseUrl,
          model: profile.model,
          apiKey,
          messages: payload.messages,
          temperature: payload.temperature,
          maxTokens: payload.maxTokens,
          timeoutMs: 60_000,
        });
        const latencyMs = Math.round(performance.now() - t0);
        store.log('ai.invoke', `AI 调用成功 [${payload.role}] ${profile.model}`);
        return {
          ok: true,
          content: outcome.content,
          usage: outcome.usage,
          latencyMs,
        };
      } catch (err) {
        const latencyMs = Math.round(performance.now() - t0);
        return {
          ok: false,
          latencyMs,
          error: `模型调用失败：${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },

    models: {
      list: async (payload: AiModelsListPayload): Promise<AiModelsListResult> => {
        try {
          const models = await listModels({
            baseUrl: payload.baseUrl,
            apiKey: payload.apiKey,
          });
          return { ok: true, models };
        } catch (err) {
          return {
            ok: false,
            models: [],
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    },

    suggest: {
      anchorStatus: async (payload: AiAnchorStatusPayload): Promise<AiAnchorStatusResult> => ({
        status: 'ready',
        reason: '',
        meta: {
          stage: payload.query.stage ?? '',
          subjectId: payload.query.subjectId,
          questionCount: store.questions.size,
          treeCount: store.trees.size,
          totalNodeCount: store.treeNodes.size,
          injectedNodeCount: 0,
          truncatedNodeCount: 0,
          injectedTokens: 0,
        },
        warnings: [],
      }),

      treeLink: async (payload: AiSuggestPayload): Promise<AiSuggestResult> => ({
        status: 'ok',
        reason: '',
        meta: {
          stage: payload.query.stage ?? '',
          subjectId: payload.query.subjectId,
          questionCount: payload.questionIds.length,
          treeCount: store.trees.size,
          totalNodeCount: store.treeNodes.size,
          injectedNodeCount: 0,
          truncatedNodeCount: 0,
          injectedTokens: 0,
        },
        warnings: [],
        none: false,
        suggestions: [],
        tagSuggestions: [],
        drafts: [],
        duplicates: [],
        latencyMs: 0,
      }),

      tags: async (payload: AiSuggestPayload): Promise<AiSuggestResult> => ({
        status: 'ok',
        reason: '',
        meta: {
          stage: payload.query.stage ?? '',
          subjectId: payload.query.subjectId,
          questionCount: payload.questionIds.length,
          treeCount: store.trees.size,
          totalNodeCount: store.treeNodes.size,
          injectedNodeCount: 0,
          truncatedNodeCount: 0,
          injectedTokens: 0,
        },
        warnings: [],
        none: false,
        suggestions: [],
        tagSuggestions: [],
        drafts: [],
        duplicates: [],
        latencyMs: 0,
      }),

      treeForDraft: async (payload: AiSuggestTreeForDraftPayload): Promise<AiSuggestResult> => ({
        status: 'ok',
        reason: '',
        meta: {
          stage: payload.stage ?? '',
          subjectId: payload.subjectId ?? '',
          questionCount: 1,
          treeCount: store.trees.size,
          totalNodeCount: store.treeNodes.size,
          injectedNodeCount: 0,
          truncatedNodeCount: 0,
          injectedTokens: 0,
        },
        warnings: [],
        none: false,
        suggestions: [],
        tagSuggestions: [],
        drafts: [],
        duplicates: [],
        latencyMs: 0,
      }),
    },
  };
}
