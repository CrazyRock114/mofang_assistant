// 0023 P2：AI 网关——ai.* 通道的业务编排（renderer 唯一入口）。
// 职责：档案 CRUD 透传 + 明文 Key「加密即弃」（P2.1 Key 写入流）+ 测连通（文本短请求 /
// 视觉必发随包小图，P2.2）+ invoke 按 role 解析启用档案（三分支校验：缺 role / 无启用档案 /
// 协议未实现——任务书 §四）+ 有限重试 + 错误信息脱敏（D-043）。
// 不 import electron：vault 为注入依赖（纯 Node vitest 直测；main.ts 注入 createDefaultKeyVault()）。

import { readFileSync } from 'node:fs';
import type {
  AiChatMessage, AiInvokePayload, AiInvokeResult, AiModelsListPayload, AiModelsListResult,
  AiProfileCreatePayload, AiProfileIdPayload, AiProfileListPayload, AiProfileSetEnabledPayload,
  AiProfileTestConnectionPayload, AiProfileUpdatePayload, AiTestConnectionResult,
  AiUsage, ModelProfile, ModelProfileService,
} from '../../shared/contracts/ai-types.js';
import { MODEL_ROLES, PROTOCOL_OPENAI_CHAT } from '../../shared/contracts/ai-types.js';
import type { KeyVault } from './key-vault.js';
import { chatCompletion, firstThinkingForm, isRetryableError, isTokenLimitError, isUnsupportedThinkingError, listModels, nextThinkingForm, redactKey } from './proxy.js';

export interface AiGatewayDeps {
  profiles: ModelProfileService;
  vault: KeyVault;
  /** 视觉角色测连通随包小图路径（build/ai-test-image.png）；缺省=视觉测连通返回明确失败 */
  testImagePath?: string;
  /** 0037（只增）：invoke 成功留痕（operation_log 复用，零新表）；缺省=不写留痕 */
  opLogger?: AiInvokeOpLogger;
}

/** 0037（只增）：留痕最小结构面（bank OperationLogger 满足；测试可注 fake） */
export interface AiInvokeOpLogger {
  logStart(operationType: string, description: string, metadata?: Record<string, unknown>): string;
  logSuccess(id: string, affectedCount: number): void;
}

const INVOKE_TIMEOUT_DEFAULT_MS = 30_000;
const RETRIES_MAX = 2;
const REPLY_PREVIEW_MAX = 200;

/** 测连通短请求（文本角色）：一轮对话、极短输出，尽量省 token */
const TEST_TEXT_MESSAGES = [
  { role: 'user' as const, content: '这是一次连通性测试。请只回复两个字符：pong' },
];

export class AiGateway {
  constructor(private deps: AiGatewayDeps) {}

  // ---------- 档案 CRUD（Key 经托管层加密，明文即弃） ----------

  async listProfiles(payload: AiProfileListPayload = {}): Promise<ModelProfile[]> {
    return this.deps.profiles.listProfiles(payload.filter);
  }

  async createProfile(payload: AiProfileCreatePayload): Promise<ModelProfile> {
    const { apiKey, ...rest } = payload.data;
    const keyEncrypted = apiKey ? await this.deps.vault.encrypt(apiKey) : undefined;
    return this.deps.profiles.createProfile({ ...rest, keyEncrypted });
  }

  async updateProfile(payload: AiProfileUpdatePayload): Promise<ModelProfile> {
    const { apiKey, ...rest } = payload.data;
    // 明文缺省（undefined）=不换 Key；空串=清除 Key；非空=换 Key（加密即弃）
    const keyEncrypted = apiKey === undefined ? undefined : (apiKey === '' ? null : await this.deps.vault.encrypt(apiKey));
    return this.deps.profiles.updateProfile(payload.id, { ...rest, keyEncrypted });
  }

  async deleteProfile(payload: AiProfileIdPayload): Promise<void> {
    return this.deps.profiles.deleteProfile(payload.id);
  }

  async setEnabled(payload: AiProfileSetEnabledPayload): Promise<ModelProfile> {
    return this.deps.profiles.setProfileEnabled(payload.id, payload.enabled);
  }

  // ---------- 测连通（P2.2） ----------

  async testConnection(payload: AiProfileTestConnectionPayload): Promise<AiTestConnectionResult> {
    const profile = await this.deps.profiles.getProfile(payload.profileId);
    if (!profile) throw new Error(`模型档案 ${payload.profileId} 不存在`);

    const keyEncrypted = await this.deps.profiles.getKeyEncrypted(profile.id);
    if (!keyEncrypted) {
      return { ok: false, latencyMs: null, error: '该档案未配置 API Key，请先在编辑表单填入 Key' };
    }

    const messages = this.buildTestMessages(profile);
    const startedAt = Date.now();
    try {
      const key = await this.deps.vault.decrypt(keyEncrypted);
      const outcome = await chatCompletion({
        baseUrl: profile.baseUrl,
        model: profile.model,
        apiKey: key,
        messages,
        maxTokens: 32,
        timeoutMs: INVOKE_TIMEOUT_DEFAULT_MS,
      });
      const latencyMs = Date.now() - startedAt;
      await this.deps.profiles.recordTestResult(profile.id, true, new Date().toISOString());
      return { ok: true, latencyMs, reply: outcome.content.slice(0, REPLY_PREVIEW_MAX) };
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      await this.deps.profiles.recordTestResult(profile.id, false, new Date().toISOString());
      const keyForRedact = await this.decryptQuietly(keyEncrypted);
      return { ok: false, latencyMs, error: redactKey(errMessage(err), keyForRedact) };
    }
  }

  // ---------- invoke：通用代理（按 role → 启用档案） ----------

  async invoke(payload: AiInvokePayload): Promise<AiInvokeResult> {
    // 分支一：role 必填且须为五角色之一（payload 校验，IPC 拒绝）
    if (!payload || !MODEL_ROLES.includes(payload.role)) {
      throw new Error('Invalid ai.invoke payload：role 必填且须为五角色之一（reasoning/vision/light/embedding/specialty）');
    }
    if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
      throw new Error('Invalid ai.invoke payload：messages 不能为空');
    }

    // 分支二：该角色无启用档案（未配置态）
    const profile = await this.deps.profiles.getEnabledProfile(payload.role);
    if (!profile) {
      throw new Error(`角色 ${payload.role} 未配置启用的模型档案（设置 → 模型配置中启用）`);
    }

    // 分支三：协议未实装（R5 配置位）
    if (profile.protocol !== PROTOCOL_OPENAI_CHAT) {
      throw new Error(`协议 "${profile.protocol}" 尚未实现（一期仅支持 ${PROTOCOL_OPENAI_CHAT}）`);
    }

    const keyEncrypted = await this.deps.profiles.getKeyEncrypted(profile.id);
    if (!keyEncrypted) {
      return { ok: false, latencyMs: 0, error: '启用的模型档案未配置 API Key' };
    }
    const apiKey = await this.deps.vault.decrypt(keyEncrypted);

    const timeoutMs = payload.timeoutMs ?? INVOKE_TIMEOUT_DEFAULT_MS;
    const retries = Math.max(0, Math.min(payload.retries ?? 0, RETRIES_MAX));
    const startedAt = Date.now();

    // 0040（只增）：思考开关按 wire 形态阶梯发送——被拒不报错，逐格下移（thinking → enable_thinking → 不发）
    let thinking = firstThinkingForm(payload.thinking);
    let thinkingLadderDone = thinking === undefined;
    // 0040（只增）：max_tokens 被供应商拒（超出该模型输出上限）→ 丢掉该参数改走供应商默认并重试一次。
    // 案底（2026-09-19 用户实测）：思考模型关不掉思考 → 正文吐空 → 上层按规则⑤提预算到 16384
    // → 供应商回「token 超过上限」→ 原实现把这条 400 直接抛给用户，整条识别链失败。
    let maxTokens = payload.maxTokens;
    let maxTokensDropped = maxTokens === undefined;

    let lastError = '';
    let attempt = 0;
    for (;;) {
      try {
        const outcome = await chatCompletion({
          baseUrl: profile.baseUrl,
          model: profile.model,
          apiKey,
          messages: payload.messages,
          ...(maxTokens !== undefined ? { maxTokens } : {}),
          temperature: payload.temperature,
          ...(thinking !== undefined ? { thinking } : {}),
          timeoutMs,
        });
        const latencyMs = Date.now() - startedAt;
        const result: AiInvokeResult = { ok: true, content: outcome.content, latencyMs, usage: outcome.usage };
        this.writeInvocationLog(profile, payload.role, latencyMs, outcome.usage);
        return result;
      } catch (err) {
        lastError = redactKey(errMessage(err), apiKey);
        // 供应商不认当前思考开关形态：下移一格重试（不占 retries 配额，不影响其它失败语义）
        if (!thinkingLadderDone && isUnsupportedThinkingError(err)) {
          const next = nextThinkingForm(payload.thinking ?? 'disabled', thinking?.form ?? 'none');
          if (next !== null) {
            thinking = next === 'none' ? undefined : next;
            thinkingLadderDone = thinking === undefined;
            continue;
          }
        }
        // 输出上限被拒：丢掉 max_tokens（供应商默认值必然合法）再试一次
        if (!maxTokensDropped && isTokenLimitError(err)) {
          maxTokens = undefined;
          maxTokensDropped = true;
          continue;
        }
        if (attempt < retries && isRetryableError(err)) {
          attempt += 1;
          await sleep(300 * attempt);
          continue;
        }
        break;
      }
    }
    return { ok: false, error: lastError, latencyMs: Date.now() - startedAt };
  }

  // ---------- 获取模型列表（0023 目检返工 R3） ----------

  /**
   * OpenAI 兼容 GET {base_url}/models 主进程代理。
   * 编辑态传 profileId（apiKey 留空 → 回落存量 Key）；新建表单态直传 baseUrl + apiKey。
   * 明文 Key 仅此一瞬用于请求，不落库、不回传 renderer；错误信息脱敏。
   */
  async listModels(payload: AiModelsListPayload): Promise<AiModelsListResult> {
    let baseUrl = payload.baseUrl?.trim();
    let apiKey = payload.apiKey || undefined;

    if (payload.profileId) {
      const profile = await this.deps.profiles.getProfile(payload.profileId);
      if (!profile) throw new Error(`模型档案 ${payload.profileId} 不存在`);
      if (!baseUrl) baseUrl = profile.baseUrl;
      if (!apiKey) {
        const keyEncrypted = await this.deps.profiles.getKeyEncrypted(profile.id);
        apiKey = keyEncrypted ? await this.deps.vault.decrypt(keyEncrypted) : undefined;
      }
    }

    if (!baseUrl || !apiKey) {
      return { ok: false, models: [], error: '获取模型列表需先填写 Base URL 与 API Key（编辑已存 Key 的档案可留空 Key）' };
    }

    try {
      const models = await listModels({ baseUrl, apiKey });
      return { ok: true, models };
    } catch (err) {
      return { ok: false, models: [], error: redactKey(errMessage(err), apiKey) };
    }
  }

  // ---------- 内部 ----------

  /**
   * 0037（只增）：invoke 成功留痕——operation_type='ai.invoke'，metadata 记角色/模型档案/
   * model/耗时；tokens 仅 provider 返回 usage 时携带（未返回不计入，首页聚合同口径）。
   * 只记成功调用（任务书口径）；留痕写库失败不影响调用结果（尽力而为）。
   */
  private writeInvocationLog(profile: ModelProfile, role: string, latencyMs: number, usage: AiUsage | undefined): void {
    const logger = this.deps.opLogger;
    if (!logger) return;
    try {
      const metadata: Record<string, unknown> = {
        role,
        profileId: profile.id,
        profileName: profile.name,
        provider: profile.provider,
        model: profile.model,
        latencyMs,
      };
      if (usage) metadata.tokens = usage;
      const logId = logger.logStart('ai.invoke', `AI 调用：${role} · ${profile.name}`, metadata);
      logger.logSuccess(logId, 0);
    } catch {
      // 统计留痕尽力而为：写不进不影响本次调用
    }
  }

  /** 测连通消息：视觉角色必发随包小图（data URL）；其余文本短请求 */
  private buildTestMessages(profile: ModelProfile): AiChatMessage[] {
    if (profile.role !== 'vision') {
      return TEST_TEXT_MESSAGES;
    }
    const dataUrl = this.readTestImageAsDataUrl();
    return [
      {
        role: 'user',
        content: [
          { type: 'text', text: '这是一次连通性测试。请读出图中的文字与公式（一行即可）。' },
          { type: 'image_url', imageUrl: { url: dataUrl } },
        ],
      },
    ];
  }

  private readTestImageAsDataUrl(): string {
    if (!this.deps.testImagePath) {
      throw new Error('视觉测连通不可用：随包测试图缺失（打包白名单核查 build/ai-test-image.png）');
    }
    const bytes = readFileSync(this.deps.testImagePath);
    return `data:image/png;base64,${bytes.toString('base64')}`;
  }

  /** 失败路径的脱敏兜底：解密失败时返回空串（redactKey 对空串是恒等） */
  private async decryptQuietly(keyEncrypted: string): Promise<string> {
    try {
      return await this.deps.vault.decrypt(keyEncrypted);
    } catch {
      return '';
    }
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
