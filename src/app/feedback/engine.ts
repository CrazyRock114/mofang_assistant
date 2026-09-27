// 0030 P2：生成管线编排（双通道）。纯逻辑 + 注入式 invoke——本模块不摸 window：
//   • 离线通道 = 0005 renderFeedback 插值（无 Key 可用，确定性输出）；
//   • AI 通道  = 组装器（prompt.ts）→ ai.invoke({role:'reasoning'}) → 红线守卫（guard.ts）。
// 「失败是结果不是异常」（照 AiInvokeResult 联合类型口径）：网关失败/组装期缺值都回 ok:false + 人读原因，
// 由 UI 显示在卡上并可重试；**不静默回落离线档**（回落口径由 UI 在「未配 AI」时显式选择通道，不偷偷换）。

import type { AiInvokePayload, AiInvokeResult, ModelRole } from '../../shared/contracts/ai-types.js';
import type { FeedbackChannel } from '../../shared/contracts/bank-types.js';
import { renderFeedback } from './render.js';
import { buildPrompt, performanceText, scoreSlotValue, type FeedbackInputs, type FeedbackStyle } from './prompt.js';
import { checkFeedbackText, type FeedbackGuardFailure } from './guard.js';

/** 生成用的模型角色：reasoning 档（文本生成的自然档位；档案解析由网关按角色取启用档案） */
export const AI_FEEDBACK_ROLE: ModelRole = 'reasoning';

/** 输出上限（篇幅最长档 ~350 字，2000 token 富余；防跑飞）；温度偏高以便「换一版」有差异 */
export const FEEDBACK_MAX_TOKENS = 2000;
export const FEEDBACK_TEMPERATURE = 0.8;
/** 生成是纯文本短请求，但思考型模型可能慢——给到 60s（网关缺省 30s 偏紧） */
export const FEEDBACK_TIMEOUT_MS = 60000;

/** 离线档附加变量（工作台不收集、但有则带入的键；0005 十键的其余项见 offlineVars） */
export interface OfflineVarsExtra {
  /** 科目（工作台表单无此字段，留给调用方带入） */
  subject?: string;
  /** 日期（缺省空串——模板里可自行写死） */
  date?: string;
  /** 老师姓名（落款用） */
  teacherName?: string;
}

function trimmed(value: string | undefined): string {
  return (value ?? '').trim();
}

/**
 * 输入 → 0005 十键槽位映射（离线通道）。
 * 槽位值写成短句而非裸值：0005 内置模板是「多槽位连排」句式（{课堂表现}{成绩}{学习建议} 相邻无分隔），
 * 裸值拼出来是「…积极举手82分（课堂小测）完成练习册…」；短句形态才能读成人话。
 * 映射申报（报告 §四）：{本次内容}←课堂内容（课程主题仅在「内容里没提到它」时作前缀，避免同一件事说两遍）、
 * {学习建议}←课后任务（D-065 的四项输入无「学习建议」项）、{成绩}←成绩短句、
 * {课堂表现}←表现标签连排；{科目}{老师姓名}{错题情况} 工作台不收集=空串。
 * 备注（目检返工③）**不进离线正文**：它是「给 AI 的补充说明」（如「今天咳嗽，别写太重」），
 * 0005 十键里没有对应槽位，UI 文案已注明其用途；AI 通道则由 {备注} 槽位承接。
 */
export function offlineVars(inputs: FeedbackInputs, extra: OfflineVarsExtra = {}): Record<string, string> {
  const performance = performanceText(inputs.performance);
  const score = trimmed(inputs.score);
  const scoreTitle = trimmed(inputs.scoreTitle);
  const homework = trimmed(inputs.homework);
  const topic = trimmed(inputs.topic);
  const content = trimmed(inputs.lessonContent);
  return {
    学生姓名: trimmed(inputs.studentName),
    科目: trimmed(extra.subject),
    日期: trimmed(extra.date),
    考试名称: scoreTitle,
    成绩: score === '' ? '' : `本次${scoreTitle === '' ? '测试' : scoreTitle}得 ${score} 分。`,
    错题情况: '',
    课堂表现: performance === '' ? '' : `上课时${performance}。`,
    本次内容: topic === '' || content.includes(topic) ? content : `${topic}：${content}`,
    学习建议: homework === '' ? '' : `课后安排：${homework}。`,
    老师姓名: trimmed(extra.teacherName),
  };
}

/** 离线正文兜底清理：结尾空签名（`——` 后无内容）不留残迹；收尾空白去掉 */
function tidyOfflineText(text: string): string {
  return text.replace(/[—\-]{2,}\s*$/, '').replace(/[ \t]+$/gm, '').trim();
}

/** 离线通道渲染（0005 插值 + 收尾清理）；未做守卫的例外：离线输出由输入直出，守卫结果同样回传（统一口径） */
export function renderOfflineFeedback(
  bodyTemplate: string,
  inputs: FeedbackInputs,
  extra: OfflineVarsExtra = {},
): string {
  return tidyOfflineText(renderFeedback(bodyTemplate, offlineVars(inputs, extra)));
}

export interface GenerateRequest {
  inputs: FeedbackInputs;
  style: FeedbackStyle;
  channel: FeedbackChannel;
  /** AI 档：提示词模板（id 进落档留痕） */
  promptTemplate?: { id: string; body: string };
  /** 离线档：0005 正文模板（内置或用户模板） */
  offlineTemplateBody?: string;
  /** 离线档附加变量 */
  offlineExtra?: OfflineVarsExtra;
  /** AI 档：生成时启用的档案 id（落档留痕） */
  modelProfileId?: string | null;
  /** ai.invoke 桥（UI 注入 window.__mofangAi.invoke；测试注入桩） */
  invoke?: (payload: AiInvokePayload) => Promise<AiInvokeResult>;
}

export type GenerateOutcome =
  | {
    ok: true;
    text: string;
    channel: FeedbackChannel;
    /** 实际发给模型的提示词全文（离线档为 null）——落档时作 prompt_snapshot */
    prompt: string | null;
    promptTemplateId: string | null;
    modelProfileId: string | null;
    failures: FeedbackGuardFailure[];
  }
  | { ok: false; channel: FeedbackChannel; error: string };

/** 生成一份反馈（快速模式单份 / 批量模式逐人共用同一条链） */
export async function generateFeedback(request: GenerateRequest): Promise<GenerateOutcome> {
  if (request.channel === 'offline') {
    const text = renderOfflineFeedback(request.offlineTemplateBody ?? '', request.inputs, request.offlineExtra ?? {});
    return {
      ok: true,
      text,
      channel: 'offline',
      prompt: null,
      promptTemplateId: null,
      modelProfileId: null,
      failures: checkFeedbackText(request.inputs, text).failures,
    };
  }

  let prompt: string;
  try {
    prompt = buildPrompt(request.promptTemplate?.body ?? '', request.inputs, request.style);
  } catch (err) {
    return { ok: false, channel: 'ai', error: err instanceof Error ? err.message : String(err) };
  }
  if (!request.invoke) return { ok: false, channel: 'ai', error: '当前环境没有 AI 通道（ai.invoke 不可用）' };

  const result = await request.invoke({
    role: AI_FEEDBACK_ROLE,
    messages: [{ role: 'user', content: prompt }],
    maxTokens: FEEDBACK_MAX_TOKENS,
    temperature: FEEDBACK_TEMPERATURE,
    timeoutMs: FEEDBACK_TIMEOUT_MS,
  });
  if (!result.ok) return { ok: false, channel: 'ai', error: result.error };

  const text = result.content.trim();
  return {
    ok: true,
    text,
    channel: 'ai',
    prompt,
    promptTemplateId: request.promptTemplate?.id ?? null,
    modelProfileId: request.modelProfileId ?? null,
    failures: checkFeedbackText(request.inputs, text).failures,
  };
}

/** 落档快照（input_json）：键名用中文，与提示词事实段同口径，便于日后回看当时填了什么 */
export function feedbackInputSnapshot(inputs: FeedbackInputs): string {
  return JSON.stringify({
    课程主题: trimmed(inputs.topic),
    课堂内容: trimmed(inputs.lessonContent),
    课堂表现: (inputs.performance ?? []).map((p) => trimmed(p)).filter((p) => p !== ''),
    课后任务: trimmed(inputs.homework),
    成绩: scoreSlotValue(inputs),
    备注: trimmed(inputs.note),
  });
}
