// 0040 P1：一步到位引擎 Provider 双实现（供应商/模型无关；对模型名零假设）。
//
//   主档  createOnestepProvider      —— 一步到位 VLM：图 → 结构化草稿（0042 Q1 可行路线）
//   降级  createTwoStageProvider     —— 两段式：OCR 转写腿（vision）+ 文本结构化腿（reasoning）
//
// 纪律（任务书 §三.3 / D-043）：一切模型调用只经注入的 `invoke`（= ai.invoke 网关）；
// 本层不见 Key、不读档案、不直连供应商——换模型只是设置页换档案。
//
// 图块分工（0042 §八.3）：坐标是 OCR 的活 → 默认并行跑 DeepSeek-OCR grounding 双模板；
// 主模型内联 bbox 仅作兜底腿并在草稿 warnings 里显式标注来源（不静默）。

import type { AiChatMessage, AiInvokePayload, AiInvokeResult, ModelRole } from '../../shared/contracts/ai-types.js';
import type { OnestepDraft, OnestepExtractInput, OnestepProvider } from '../../shared/contracts/onestep-types.js';
import { reconcileFigures } from '../onestep/figures.js';
import { parseOnestepResponse } from '../onestep/parse.js';
import {
  buildOnestepExtractPrompt,
  DSO_GROUNDING_PROMPTS,
  ONESTEP_TRANSCRIBE_PROMPT,
  TWOSTAGE_STRUCTURE_PROMPT,
} from '../onestep/prompts.js';
import { buildOnestepDrafts, nextBudgetRetry, ONESTEP_BUDGET_RETRY_MAX_TOKENS } from '../onestep/validate.js';

/** 单次一步到位调用超时（0042 实测整页 30~105s，thinking 档最慢 104s） */
export const ONESTEP_TIMEOUT_MS = 180_000;
/** 一步到位输出预算（POC DEFAULT_MAX_TOKENS；思考档截断由规则 ⑤ 接管） */
export const ONESTEP_MAX_TOKENS = 4096;
/** OCR 转写腿超时（免费 OCR 实测 1~5s，留足余量） */
export const ONESTEP_OCR_TIMEOUT_MS = 60_000;
/** 文本结构化腿超时 */
export const ONESTEP_STRUCTURE_TIMEOUT_MS = 90_000;
/**
 * 两类重试各自的上限（分开计数，语义不混）：
 *   MODEL_RETRIES_MAX  = 规则①②「原样重试」上限（空数组/坏 JSON 再给一次采样机会）
 *   BUDGET_RETRIES_MAX = 规则⑤「预算阶梯」上限（4096 → 8192 → 16384，每级都可能是
 *                        「模型确实需要更多预算」或「供应商不许这么大」——后者由网关丢参数兜底）
 * 总调用次数上界 = 1 + 1 + 2 = 4。
 */
const MODEL_RETRIES_MAX = 1;
const BUDGET_RETRIES_MAX = 2;

export interface OnestepProviderDeps {
  /** AI 调用（main.ts 注入 aiGateway.invoke；本层不触 Key，D-043） */
  invoke: (payload: AiInvokePayload) => Promise<AiInvokeResult>;
  /** 主档模型角色（缺省 'vision'——题图直出结构必须视觉模型） */
  role?: ModelRole;
  /** 图块 grounding 角色（缺省 'vision'；配 DeepSeek-OCR 档案即得受控坐标） */
  groundingRole?: ModelRole;
  /** 降级档腿 2（文本结构化）角色，缺省 'reasoning' */
  structureRole?: ModelRole;
  /** 主调用是否携带内联 bbox 兜底腿（缺省 true：DSO 不出图时的显式降级来源） */
  inlineGrounding?: boolean;
  /** 主调用输出预算（缺省 ONESTEP_MAX_TOKENS） */
  maxTokens?: number;
  /** 首次调用是否关闭思考（缺省 'disabled'：0042 §9.1 实测必须关，否则整页样本烧尽预算） */
  thinking?: 'enabled' | 'disabled';
  /**
   * 0056 目检返工③（只增，可选）：**覆盖转写腿主提示词**（缺省 = ONESTEP_TRANSCRIBE_PROMPT 中文通用指令）。
   * 用途：公式图转写——组卷网公式图转文字施工参考（§2.2）线上实测口径是
   * 英文短提示词「Identify the math formula in the image. Output ONLY the LaTeX code, nothing else.」
   * （中文提示词会招来解释性文字；专用 OCR 模型对中文通用指令直接空返回）。
   */
  transcribePrompt?: string;
  /**
   * 0056 目检返工②（只增，可选）：转写腿**空返回时的备用提示词**（用完即不再重试）。
   * 用途：专用 OCR 模型（如 DeepSeek-OCR）不认通用中文指令——0042 §Q2 路线2 留档
   * 「中文『图』两次空返回淘汰」；DSO 官方模板 `<|grounding|>Convert the document to markdown.`
   * 才稳定产出带 LaTeX 的 markdown（= 我们要的转写结果）。缺省不传 = 行为与既有完全一致。
   */
  transcribeFallbackPrompt?: string;
  /**
   * 0069（R-075，只增，可选）：**覆盖结构化腿提示词**（缺省 = TWOSTAGE_STRUCTURE_PROMPT 录题通用口径）。
   * 用途：答案/解析整图靶的整理链要在结构化腿里保住转写腿标出的 `[图N]` 占位
   * （见 `AI_CLEAN_ANSWER_STRUCTURE_PROMPT`）。缺省不传 = 行为与既有完全一致（录题链零改动）。
   */
  structurePrompt?: string;
  timeoutMs?: number;
}

function dataUrl(input: OnestepExtractInput): string {
  return `data:${input.image.mime};base64,${input.image.dataBase64}`;
}

function textOnlyMessages(prompt: string, text: string): AiChatMessage[] {
  return [
    { role: 'system', content: prompt },
    { role: 'user', content: text },
  ];
}

function visionMessages(prompt: string, url: string): AiChatMessage[] {
  return [
    {
      role: 'user',
      content: [
        { type: 'image_url', imageUrl: { url } },
        { type: 'text', text: prompt },
      ],
    },
  ];
}

function failureText(result: AiInvokeResult & { ok: false }): string {
  return result.error;
}

/** 调用结果的成功内容；失败即抛（Provider 面无「静默降级」，一切失败都要能报给 UI 红条） */
async function requireContent(
  invoke: (payload: AiInvokePayload) => Promise<AiInvokeResult>,
  payload: AiInvokePayload,
  label: string,
): Promise<string> {
  const result = await invoke(payload);
  if (!result.ok) throw new Error(`${label}失败：${failureText(result)}`);
  return result.content;
}

/**
 * 主档：一步到位 VLM。
 * 主调用与 DSO grounding **并行**（0042 §十第二轮：+2~3.5s），主调用失败不影响图块结论的采集，
 * 但主调用失败即整体失败（识别是主任务，坐标是附属）。
 */
export function createOnestepProvider(deps: OnestepProviderDeps): OnestepProvider {
  const role = deps.role ?? 'vision';
  const groundingRole = deps.groundingRole ?? 'vision';
  const maxTokens = deps.maxTokens ?? ONESTEP_MAX_TOKENS;
  const timeoutMs = deps.timeoutMs ?? ONESTEP_TIMEOUT_MS;
  const thinking = deps.thinking ?? 'disabled';

  const dsoGrounding = async (url: string): Promise<{ raw: string[]; failed: string | null }> => {
    const settled = await Promise.all(
      DSO_GROUNDING_PROMPTS.map(async (prompt) => {
        const result = await deps.invoke({
          role: groundingRole,
          messages: visionMessages(prompt, url),
          temperature: 0,
          timeoutMs: ONESTEP_OCR_TIMEOUT_MS,
        });
        return result;
      }),
    );
    const raw: string[] = [];
    const errors: string[] = [];
    for (const result of settled) {
      if (result.ok) raw.push(result.content);
      else errors.push(result.error);
    }
    // 双模板全失败才算 grounding 失败（单模板失败不致命：并集口径本就为容错）
    return { raw, failed: raw.length === 0 && errors.length > 0 ? errors.join('；') : null };
  };

  return {
    name: 'onestep-vlm',
    async extract(input: OnestepExtractInput): Promise<OnestepDraft[]> {
      const url = dataUrl(input);
      const prompt = buildOnestepExtractPrompt({ inlineGrounding: deps.inlineGrounding ?? true });

      let modelRetries = 0;
      let budgetRetries = 0;
      let budget = { thinking, maxTokens };
      // 坐标腿与主调用并行；**重试复用同一次结果**（重试只该重试主调用，坐标没必要重跑）
      let groundingCall: Promise<{ raw: string[]; failed: string | null }> | null = null;
      for (;;) {
        groundingCall ??= dsoGrounding(url);
        const [mainResult, grounding] = await Promise.all([
          deps.invoke({
            role,
            messages: visionMessages(prompt, url),
            temperature: 0,
            maxTokens: budget.maxTokens,
            thinking: budget.thinking,
            timeoutMs,
          }),
          groundingCall,
        ]);
        if (!mainResult.ok) throw new Error(`一步到位识别失败：${failureText(mainResult)}`);

        // 规则 ⑤：产出为空 = 预算耗尽的现场证据（0042 §9.1：思考 token 烧尽输出预算）
        // ——先于解析判定，否则会被「返回体无法解析」掩盖真实原因
        if (mainResult.content.trim() === '') {
          const next = nextBudgetRetry(budget);
          if (budgetRetries < BUDGET_RETRIES_MAX && next !== null) {
            budgetRetries += 1;
            budget = next;
            continue;
          }
          throw new Error(
            `模型未返回任何内容（推理 token 烧尽输出预算、正文截断为空）——已按规则 ⑤ 关思考并把预算逐级提到 ${budget.maxTokens} 仍为空。` +
            '该档模型多半是「思考关不掉」的模型：请换一个非思考档模型，或用左栏「✂ 手动框选」逐题识别（手动档零模型依赖）',
          );
        }

        const parsed = parseOnestepResponse(mainResult.content);
        if (!parsed.ok) {
          if (modelRetries < MODEL_RETRIES_MAX) { modelRetries += 1; continue; } // 规则 ②：JSON 不可解析 → 原样重试一次
          throw new Error(`一步到位返回体无法解析：${parsed.reason}`);
        }

        const placeholderRefsHint = parsed.value.inlineFigures.length;
        const preliminary = buildOnestepDrafts({
          raw: mainResult.content,
          parsed: parsed.value,
          pageNo: input.image.pageNo ?? 1,
          figures: [],
          figureSource: 'none',
          figureWarnings: [],
        });
        if (preliminary.failure !== null) {
          // 规则 ①：合规空数组 → 原样重试一次（换一次采样机会，仍空即报错引导换档）
          if (preliminary.retry === 'model' && modelRetries < MODEL_RETRIES_MAX) { modelRetries += 1; continue; }
          throw new Error(preliminary.failure);
        }

        // 图块对账（DSO 为主 + 内联兜底 + 未覆盖占位符显式告警）
        const placeholderRefs = new Set<number>();
        for (const draft of preliminary.drafts) {
          for (const m of draft.stemMarkdown.matchAll(/\[图\s*(\d+)\]/g)) placeholderRefs.add(Number(m[1]));
        }
        const reconciled = reconcileFigures({
          dsoRawOutputs: grounding.raw,
          inlineBoxes: parsed.value.inlineFigures,
          placeholderRefs: [...placeholderRefs].sort((a, b) => a - b),
        });
        const warnings = [...reconciled.warnings];
        if (grounding.failed !== null) {
          warnings.push(`DeepSeek-OCR grounding 调用失败（${grounding.failed}）——已回落内联腿，坐标请人工确认`);
        }
        if (placeholderRefsHint === 0 && parsed.value.inlineFigures.length === 0 && grounding.raw.length === 0) {
          warnings.push('本页未取得任何图块坐标（页面无图或定位腿不可用）');
        }

        const built = buildOnestepDrafts({
          raw: mainResult.content,
          parsed: parsed.value,
          pageNo: input.image.pageNo ?? 1,
          figures: reconciled.figures,
          figureSource: reconciled.source,
          figureWarnings: warnings,
        });
        if (built.failure !== null) throw new Error(built.failure);
        return built.drafts;
      }
    },
  };
}

/**
 * 降级档：两段式（OCR 转写腿 → 文本推理结构化腿）。
 * 价值（0042 §4.2）：腿 1 免费且秒级；无 VLM Key 时的零成本可用路径。
 * 局限（已显式标注）：无坐标能力——figures 恒为空、source='none'，占位符由人工框选补图。
 */
export function createTwoStageProvider(deps: OnestepProviderDeps): OnestepProvider {
  const ocrRole = deps.groundingRole ?? 'vision';
  const structureRole = deps.structureRole ?? 'reasoning';
  const maxTokens = deps.maxTokens ?? ONESTEP_MAX_TOKENS;

  /** 转写腿（0056 只增：抽成内部函数，`transcribe()` 与 `extract()` 共用同一提示词链与备用模板） */
  const transcribeImage = async (input: OnestepExtractInput): Promise<string> => {
      const url = dataUrl(input);
      let transcription = await requireContent(
        deps.invoke,
        {
          role: ocrRole,
          messages: visionMessages(deps.transcribePrompt ?? ONESTEP_TRANSCRIBE_PROMPT, url),
          temperature: 0,
          timeoutMs: ONESTEP_OCR_TIMEOUT_MS,
        },
        'OCR 转写腿',
      );
      // 0056 目检返工②：空返回 → 若给了备用模板（专用 OCR 模型只认自己的模板）就再试一次；
      // 仍是空 = 该档案确实不具备转写能力域（既有语义，不静默、不无限重试）
      if (transcription.trim() === '' && deps.transcribeFallbackPrompt !== undefined) {
        transcription = await requireContent(
          deps.invoke,
          {
            role: ocrRole,
            messages: visionMessages(deps.transcribeFallbackPrompt, url),
            temperature: 0,
            timeoutMs: ONESTEP_OCR_TIMEOUT_MS,
          },
          'OCR 转写腿（备用模板）',
        );
      }
      if (transcription.trim() === '') throw new Error('OCR 转写腿返回空内容（该档案不具备转写能力域）');
      return transcription;
  };

  return {
    name: 'onestep-twostage',
    /** 0056（只增）：纯转写（公式图文转文字的直通路径；跳过第二腿，避免文本模型改写 OCR 结论） */
    transcribe: transcribeImage,
    async extract(input: OnestepExtractInput): Promise<OnestepDraft[]> {
      const transcription = await transcribeImage(input);
      let modelRetries = 0;
      let budgetRetries = 0;
      let budget: { thinking: 'enabled' | 'disabled'; maxTokens: number } = {
        thinking: deps.thinking ?? 'disabled',
        maxTokens,
      };
      for (;;) {
        const structured = await deps.invoke({
          role: structureRole,
          messages: textOnlyMessages(deps.structurePrompt ?? TWOSTAGE_STRUCTURE_PROMPT, transcription),
          temperature: 0,
          maxTokens: budget.maxTokens,
          thinking: budget.thinking,
          timeoutMs: ONESTEP_STRUCTURE_TIMEOUT_MS,
        });
        if (!structured.ok) throw new Error(`结构化腿失败：${failureText(structured)}`);

        const parsed = parseOnestepResponse(structured.content);
        if (!parsed.ok) {
          if (modelRetries < MODEL_RETRIES_MAX) { modelRetries += 1; continue; }
          throw new Error(`结构化腿返回体无法解析：${parsed.reason}`);
        }
        const built = buildOnestepDrafts({
          raw: structured.content,
          parsed: parsed.value,
          pageNo: input.image.pageNo ?? 1,
          figures: [],
          figureSource: 'none',
          figureWarnings: [
            '图块坐标来源：无（两段式为纯文本链，无坐标能力）——题面若有 [图N] 请用左栏手动框选补图',
          ],
        });
        if (built.failure !== null) {
          const next = built.retry === 'budget' ? nextBudgetRetry(budget) : null;
          if (budgetRetries < BUDGET_RETRIES_MAX && next !== null) {
            budgetRetries += 1;
            budget = next;
            continue;
          }
          if (built.retry === 'model' && modelRetries < MODEL_RETRIES_MAX) { modelRetries += 1; continue; }
          throw new Error(built.failure);
        }
        return built.drafts;
      }
    },
  };
}

/** 规则 ⑤ 的预算重试上限对外导出（测试与 UI 文案共用同一常量源） */
export { ONESTEP_BUDGET_RETRY_MAX_TOKENS };
