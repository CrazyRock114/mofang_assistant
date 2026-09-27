// 0023 P2：OpenAI 兼容 chat/completions 代理内核（单次尝试；重试编排在上层网关）。
// 纯 Node（全局 fetch，Node 24 / Electron 38 主进程均可用），不 import electron——vitest 直测。
// 红线（D-043）：一切错误信息经 redactKey 脱敏——HTTP 响应体/网络异常文本中若出现 Key/Authorization
// 片段一律替换为 ***（构造注入测试钉死）。

import type { AiChatMessage, AiUsage } from '../../shared/contracts/ai-types.js';

export interface ChatCompletionParams {
  baseUrl: string;
  model: string;
  apiKey: string;
  messages: AiChatMessage[];
  maxTokens?: number;
  temperature?: number;
  /**
   * 0040（只增）：思考开关——供应商对「关闭思考」的 wire 形态不统一，故按形态发送：
   *   'thinking'        → 顶层 `thinking: { type }`（DeepSeek 官方 / MiMo 实测接受，POC 同口径）
   *   'enable-thinking' → 顶层 `enable_thinking: bool`（SiliconFlow / Qwen 系口径）
   * 缺省不发送该字段。形态由外层网关照「被拒即换形态」的阶梯决定（见 thinkingWireLadder）。
   */
  thinking?: { form: 'thinking' | 'enable-thinking'; value: 'enabled' | 'disabled' };
  /** 单次尝试超时（毫秒） */
  timeoutMs: number;
}

export interface ChatCompletionOutcome {
  content: string;
  usage?: AiUsage;
}

/** 错误信息脱敏：抹去 Key 本体与其 Bearer 片段 */
export function redactKey(text: string, apiKey: string): string {
  let out = text;
  if (apiKey) {
    out = out.split(apiKey).join('***');
    out = out.split(`Bearer ${apiKey}`).join('Bearer ***');
  }
  return out;
}

/** base_url 归一：去尾斜杠 + /chat/completions（OpenAI 兼容惯例，base_url 含 /v1） */
export function chatEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

/** 契约消息 → wire 消息（camelCase imageUrl → OpenAI image_url） */
export function toWireMessages(messages: AiChatMessage[]): Array<{ role: string; content: unknown }> {
  return messages.map((m) => ({
    role: m.role,
    content:
      typeof m.content === 'string'
        ? m.content
        : m.content.map((part) =>
            part.type === 'text'
              ? { type: 'text', text: part.text }
              : { type: 'image_url', image_url: { url: part.imageUrl.url } },
          ),
  }));
}

/** HTTP 错误（状态码 + 已脱敏响应体摘要） */
export class AiHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'AiHttpError';
  }
}

/** 5xx/429/网络错误/超时 → 可重试；4xx 参数类 → 不重试 */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof AiHttpError) return err.status >= 500 || err.status === 429;
  return true; // 网络层错误（含超时）默认可重试
}

interface WireResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

/** wire content 归一为字符串：string 原样；分片数组拼接 text 片段（vision 回复常态为 string，兼容分片） */
function contentToString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === 'object' && (p as { type?: string }).type === 'text' ? String((p as { text?: unknown }).text ?? '') : ''))
      .join('');
  }
  return '';
}

/**
 * 0040（只增）：供应商不识别思考开关参数时的降级判据。
 * 实测口径：不识别该字段的兼容实现回 400/422 并在报文里点名参数名，形如
 *   `Value error, current model does not support parameter \`enable_thinking\`（SiliconFlow 实测）
 * 注意：这里刻意用**子串**匹配而非 `\bthinking\b`——`_` 属单词字符，`enable_thinking`
 * 里不存在单词边界，词边界正则会把这条真实报错漏掉（2026-09-19 用户实测踩到）。
 */
export function isUnsupportedThinkingError(err: unknown): boolean {
  if (!(err instanceof AiHttpError)) return false;
  if (err.status !== 400 && err.status !== 422) return false;
  return /thinking/i.test(err.message);
}

/**
 * 0040（只增）：`max_tokens` 被供应商拒（超出该模型输出上限）的判据。
 * 实测形态两种：英文 `max_tokens is too large / maximum ... tokens`；
 * 中文/本地化 `token 超过上限 / 超出限制`。**上下文超长**类报错也会提到 token——
 * 那种情况下丢掉 max_tokens 修不好问题，但重试一次后再失败也只是把同样的错误如实上抛，不会更糟。
 */
export function isTokenLimitError(err: unknown): boolean {
  if (!(err instanceof AiHttpError)) return false;
  if (err.status !== 400 && err.status !== 422) return false;
  const message = err.message;
  if (/max_tokens/i.test(message)) return true;
  return /tokens?/i.test(message) && /(exceed|limit|too large|maximum|上限|超过|超出|过大)/i.test(message);
}

/**
 * 0040（只增）：思考开关的 wire 形态阶梯（供应商口径不统一，逐个试到被接受为止）：
 *   ① `thinking: { type }`（DeepSeek 官方 / MiMo）
 *   ② `enable_thinking: bool`（SiliconFlow / Qwen 系）
 *   ③ 不发该字段（供应商完全不支持 → 放弃关思考，由规则⑤提预算兜底）
 * 每次被 `isUnsupportedThinkingError` 判为「不认这个参数」就下移一格；返回 null 表示已到底。
 */
export function nextThinkingForm(
  thinking: 'enabled' | 'disabled',
  current: 'thinking' | 'enable-thinking' | 'none',
): ChatCompletionParams['thinking'] | 'none' | null {
  if (current === 'thinking') return { form: 'enable-thinking', value: thinking };
  if (current === 'enable-thinking') return 'none';
  return null;
}

/**
 * 思考开关首格（阶梯入口）：用户开关 → 第一种 wire 形态。未开该开关时返回 undefined（不发字段）。
 */
export function firstThinkingForm(
  thinking: 'enabled' | 'disabled' | undefined,
): ChatCompletionParams['thinking'] {
  return thinking === undefined ? undefined : { form: 'thinking', value: thinking };
}

export async function chatCompletion(params: ChatCompletionParams): Promise<ChatCompletionOutcome> {
  const { baseUrl, model, apiKey, messages, maxTokens, temperature, thinking, timeoutMs } = params;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let resp: Response;
    try {
      resp = await fetch(chatEndpoint(baseUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: toWireMessages(messages),
          stream: false,
          ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
          ...(temperature !== undefined ? { temperature } : {}),
          ...(thinking === undefined
            ? {}
            : thinking.form === 'enable-thinking'
              ? { enable_thinking: thinking.value === 'enabled' }
              : { thinking: { type: thinking.value } }),
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`请求超时（${timeoutMs}ms）`);
      }
      throw new Error(redactKey(`网络错误：${err instanceof Error ? err.message : String(err)}`, apiKey));
    }

    if (!resp.ok) {
      const bodyText = await resp.text().catch(() => '');
      throw new AiHttpError(resp.status, redactKey(`HTTP ${resp.status}：${bodyText.slice(0, 500) || '(无响应体)'}`, apiKey));
    }

    const data = (await resp.json()) as WireResponse;
    const content = contentToString(data.choices?.[0]?.message?.content);
    const usage = data.usage
      ? {
          promptTokens: data.usage.prompt_tokens ?? 0,
          completionTokens: data.usage.completion_tokens ?? 0,
          totalTokens: data.usage.total_tokens ?? 0,
        }
      : undefined;
    return { content, usage };
  } finally {
    clearTimeout(timer);
  }
}

// ==================== 0023 目检返工 R3：获取模型列表（GET {base_url}/models） ====================

interface WireModelsResponse {
  data?: Array<{ id?: string }>;
}

/** 拉取 OpenAI 兼容模型列表（单次尝试，无重试）；返回模型 id 列表；错误信息已脱敏 */
export async function listModels(params: { baseUrl: string; apiKey: string; timeoutMs?: number }): Promise<string[]> {
  const { baseUrl, apiKey, timeoutMs = 15_000 } = params;
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let resp: Response;
    try {
      resp = await fetch(endpoint, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`请求超时（${timeoutMs}ms）`);
      }
      throw new Error(redactKey(`网络错误：${err instanceof Error ? err.message : String(err)}`, apiKey));
    }
    if (!resp.ok) {
      const bodyText = await resp.text().catch(() => '');
      throw new AiHttpError(resp.status, redactKey(`HTTP ${resp.status}：${bodyText.slice(0, 500) || '(无响应体)'}`, apiKey));
    }
    const data = (await resp.json()) as WireModelsResponse;
    return (data.data ?? [])
      .map((m) => (typeof m?.id === 'string' ? m.id : ''))
      .filter((id) => id !== '')
      .sort((a, b) => a.localeCompare(b));
  } finally {
    clearTimeout(timer);
  }
}
