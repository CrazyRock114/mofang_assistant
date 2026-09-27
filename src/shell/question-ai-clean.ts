// 0056（R-041）：采集题 AI 整理·主进程编排（读盘取图字节 → 引擎 → 合回 → 落库 + 台账）。
// 0065（R-068）：答案/解析链三条新增——① 含正文字段原位替换（plan 分流见 plan.ts）；
//   ② 引擎判不出归属时整图内容归解析区 + warning；③ 403 占位图前置指纹识别（零 token）+ 事后文案兜底。
// 0069（R-075）：答案/解析整图靶的**配图抠图**（D-083「答案识别与录题同一条路」）——转写腿链之外
//   加一条 DSO grounding 坐标腿（双模板并行）→ reconcileFigures 对账 → 按 bbox 裁出配图落资产
//   （内容寻址）→ 合成时 [图N] 换真图 + images[] 记账。见 `attachAnswerFigures`。
//
// 为什么在主进程（任务书 §一.1 拍板①）：整理 = 读 `data/assets/` 图字节 → 调 provider → 合回 HTML →
// 写库 的一条链，渲染层不该也不会自己拼这条链（资产读盘能力只在主进程，D-043 密钥链同源）。
//
// P-07 / D-050 同口径：本模块**只产出建议**——preview 零写库（对照弹层给人看），
// 人确认后 commit 才逐题 update 并写 operation_log 台账（成功/failed+原因）。
//
// 纪律：串行逐题（AI 成本口径，无并发——0054 挂账 c 的节流口径顺手遵守）；
//       单题失败不中断整批（与 0057 backfill 同型）；子母题不整理（R-042 结构批再做）；
//       403 占位图**不送引擎**、不计失败（0065 §一.3）。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { QuestionImage } from '../shared/contracts/bank-types.js';
import type { AiInvokePayload, AiInvokeResult, ModelRole } from '../shared/contracts/ai-types.js';
import type {
  QuestionAiCleanApplyMode,
  QuestionAiCleanFields,
  QuestionAiCleanItem,
  QuestionAiCleanItemPatch,
  QuestionAiCleanPlaceholder,
} from '../shared/contracts/ipc-channels.js';
import type { OnestepBBox, OnestepDraft, OnestepProvider } from '../shared/contracts/onestep-types.js';
import { planAiClean, type AiCleanField, type AiCleanTarget } from '../recog/ai-clean/plan.js';
import { mergeAiClean, type AiCleanFigureRef, type AiCleanImageOutput } from '../recog/ai-clean/merge.js';
import { placeholderReasonOf, placeholderTextReason } from '../recog/ai-clean/placeholder.js';
import {
  MONTAGE_MAX_FRAGMENT_LONG_EDGE_PX,
  MONTAGE_MAX_ITEMS,
  chunkMontage,
  parseMontageRows,
  planMontage,
  type MontagePlan,
} from '../recog/ai-clean/montage.js';
import { mimeOfFormat, mimeOfPath, sniffImageType } from '../recog/ai-clean/image-format.js';
import {
  checkFormulaAgainstSkeleton,
  hallucinationReason,
  parseFormulaSkeleton,
  sanitizeFormulaTex,
} from '../recog/ai-clean/formula-qa.js';
import { createTwoStageProvider, ONESTEP_OCR_TIMEOUT_MS } from '../recog/providers/onestep.js';
import { AI_CLEAN_ANSWER_STRUCTURE_PROMPT, AI_CLEAN_ANSWER_TRANSCRIBE_PROMPT, DSO_GROUNDING_PROMPTS } from '../recog/onestep/prompts.js';
import { figureRefsInMarkdown, reconcileFigures } from '../recog/onestep/figures.js';
import { saveRecogImageDataUrl } from './recog-image-store.js';
import type { AiCleanImagePrepared, AiCleanImagePreparer, AiCleanImageRequest } from './ai-clean-image-prep.js';
import type {
  AiCleanCanvasItem,
  AiCleanCanvasOutcome,
  AiCleanMontageFragment,
  AiCleanMontageOutcome,
} from './ai-clean-canvas-raster.js';

/** 整理台账（operation_log 面；与 0057 backfill 注入面同签名） */
export interface AiCleanLogger {
  logStart(operationType: string, description: string, metadata?: Record<string, unknown>): string;
  logSuccess(id: string, affectedCount: number): void;
  logFailure(id: string, error: Error): void;
}

/** 题读面/写面（bank service 子集投影；本模块不碰 SQL——架构硬规则 2） */
export interface AiCleanQuestionLike {
  id: string;
  content: string;
  answer?: string;
  analysis?: string;
  images?: QuestionImage[];
  sourceDetail?: Record<string, unknown>;
}

export interface QuestionAiCleanDeps {
  getQuestion(id: string): Promise<AiCleanQuestionLike | null>;
  updateQuestion(id: string, patch: {
    content?: string;
    answer?: string;
    analysis?: string;
    images?: QuestionImage[];
  }): Promise<unknown>;
  /** userData/data 目录（资产根 `data/assets`） */
  dataDir: string;
  /** 引擎（测试注入假实现）；缺省由 invoke 组两段式 provider */
  provider?: OnestepProvider;
  /** 模型调用腿（provider 未注入时必需；= aiGateway.invoke，本层不触 Key） */
  invoke?: (payload: AiInvokePayload) => Promise<AiInvokeResult>;
  /** 资产读盘（缺省真 fs；测试可换假实现） */
  readAsset?(absPath: string): Buffer;
  /**
   * 图片准备（目检返工①）：靶资产 → 模型可读 data（SVG 栅格化 / 位图原样 / 非图片记账）。
   * 缺省 = 不栅格化的保守实现：位图原样、SVG 显式报错（**绝不把 SVG 原样发给视觉端点**——
   * 端点不收 SVG，实测 HTTP 400 code 20015）。真机由 main.ts 注入 `createAiCleanImagePreparer()`。
   */
  prepareImages?: AiCleanImagePreparer;
  /**
   * 返工⑦（用户拍板）：**公式靶的转写角色链**（按序试，首个「过闸门」的结果为准）。
   *
   * 为什么不再默认用专用 OCR：真机实证（用户 2026-09-24 目检截图 + 旧探针样本）——DeepSeek-OCR 把
   * **孤立的公式小图当成「文档」做版面处理**：`2√(gd)` → `\sqrt{2}\cdot\text{ged}`（读序错乱）、
   * `√(d/g)` → `√a`（丢掉分式）、`d/4` → `\frac{\alpha}{4}`（d 认成 α），还会回吐
   * `<|ref|>equation<|/ref|><|det|>[[130, 220…` 这类版面参考串。同一模型对**整页答案图**却转写正常。
   * 通用视觉/推理模型对「一张小图 → 一段 LaTeX」这类任务反而稳（看图直接出公式）。
   *
   * 缺省 `['reasoning','vision']`：主腿 = 通用视觉/推理档案；专用 OCR（vision）留作**兜底腿**
   * （主腿对某张图不过闸门时才试它）。答案/解析整图仍走 vision（整页 OCR 是专用模型的强项）。
   */
  formulaRoles?: ModelRole[];
  /**
   * 拼图渲染（返工⑦）：把一题内的公式片段拼成带编号的网格大图（缺省真 canvas 实现；测试注入替身）。
   * 缺省实现懒取（不静态 import 栅格器模块——它顶层拉 electron，会污染无 Electron 的测试导入链）。
   */
  renderMontage?: (fragments: AiCleanMontageFragment[], plan: MontagePlan) => Promise<AiCleanMontageOutcome>;
  /**
   * 0069（R-075）：**配图裁剪器**（答案/解析整图靶按 bbox 裁图 → PNG）。
   * 缺省真 canvas 实现（`rasterizeAiCleanCanvas`，懒取同 `renderMontage`：它顶层拉 electron）；
   * 测试注入替身即可（`dist` 无 Electron 也能跑纯逻辑）。
   */
  renderCrop?: (items: AiCleanCanvasItem[]) => Promise<AiCleanCanvasOutcome>;
  logger?: AiCleanLogger;
  warn?(message: string): void;
}

/** 缺省配图裁剪器（懒取真 canvas 实现） */
function defaultRenderCrop(items: AiCleanCanvasItem[]): Promise<AiCleanCanvasOutcome> {
  const mod = require('./ai-clean-canvas-raster.js') as typeof import('./ai-clean-canvas-raster.js');
  return mod.rasterizeAiCleanCanvas(items);
}

/** 缺省拼图渲染器（懒取真 canvas 实现） */
function defaultRenderMontage(
  fragments: AiCleanMontageFragment[],
  plan: MontagePlan,
): Promise<AiCleanMontageOutcome> {
  const mod = require('./ai-clean-canvas-raster.js') as typeof import('./ai-clean-canvas-raster.js');
  return mod.rasterizeAiCleanMontage(fragments, plan);
}

const AI_CLEAN_OPERATION = 'question.aiClean';

/** 公式靶缺省转写腿（主腿 → 兜底腿）；见 `QuestionAiCleanDeps.formulaRoles` */
export const DEFAULT_FORMULA_ROLES: ModelRole[] = ['reasoning', 'vision'];

/**
 * 0069（R-075）：答案/解析整图靶**配图坐标腿**的档案角色——D-083 与录题侧同源：坐标是 OCR 的活
 * （`recog/providers/onestep.ts` 的 `dsoGrounding` 缺省 `groundingRole='vision'`）。
 */
export const ANSWER_FIGURE_GROUNDING_ROLE: ModelRole = 'vision';

/**
 * 0069：抠图产物的**外扩边距**（归一化，四边各外扩一份）——模型给的框常贴着图形外沿，
 * 不留边容易切掉线宽/顶点/坐标轴箭头（验收口径「裁切边界不截字不截图」）。取值与 0040 裁图
 * 的 `padding: 0.004` 同档（渲染层 crop.ts 的默认口径）。
 */
export const ANSWER_FIGURE_CROP_PAD = 0.004;

/**
 * 0069 目检返工②：答案/解析文字里的**配图线索**（「如图所示」这类指代）。
 *
 * 用途：双出文字里没有 `[图N]` 时，只有提到配图才值得再花一次（免费 OCR）坐标腿去确认——
 * 用户真机报障（真库 0fdd502b 排球场题）正是「解析图在开头、模型没标占位 → 静默没抠出」。
 * 词表**从严**（只认明确的图指代），宁可漏判也不给每道题都加一次调用。
 */
const FIGURE_MENTION_RE = /如图|见图|图示|图甲|图乙|图丙|下图|上图|见下图|见上图/;

/** 字段人读名（弹层与台账用） */
function fieldLabelOf(field: AiCleanTarget['field']): string {
  return field === 'content' ? '题面' : field === 'answer' ? '答案区' : '解析区';
}

/**
 * 0065：事后兜底——某段转写文本本身就是「无权限/暂未开通」权限文案 → 该图按**占位图**处理
 * （原图保留、不写字段、不进失败清单）。
 * 未登记变体的唯一兜底：横幅文案固定，转写必然撞上这组词；代价是多一次调用（见交付报告 §残余项）。
 */
function placeholderGuardOf(target: AiCleanTarget, text: string): AiCleanImageOutput | null {
  const reason = placeholderTextReason(text);
  if (reason === null) return null;
  return { target, ok: false, placeholderReason: reason };
}

/** 全为占位图时的跳过原因（弹层可见；不进失败清单） */
function placeholderSkipReason(placeholders: QuestionAiCleanPlaceholder[]): string {
  const fields = [...new Set(placeholders.map((entry) => fieldLabelOf(entry.field ?? 'answer')))].join('、');
  return `${fields} ${placeholders.length} 张为站点占位图（403 无权限）——需到站点开通权限后重新采集（本批未送引擎）`;
}

/** 采集链标记的子母题（quesChildNum>1 落 sourceDetail.childQuestionCount）本批不整理 */
function skipReasonOf(question: AiCleanQuestionLike): string | null {
  const child = Number(question.sourceDetail?.['childQuestionCount'] ?? 0);
  if (Number.isFinite(child) && child > 1) {
    return `子母题（含 ${child} 小题）暂不整理——结构批（R-042）落地后再做`;
  }
  return null;
}

/**
 * 公式靶的转写提示词（返工③ · 施工参考 §2.2 线上实测口径）：
 * 英文短提示词 + 「只出 LaTeX」——中文提示词会招来解释性文字，专用 OCR 模型（DeepSeek-OCR）
 * 对中文通用指令更是直接空返回（0042 §Q2 留档「中文『图』两次空返回淘汰」）。
 * 对通用 VLM 同样适用（公式图转写本就是它能力域内的简单任务）。
 */
const FORMULA_TRANSCRIBE_PROMPT =
  'Identify the math formula in the image. Output ONLY the LaTeX code, nothing else.';

/**
 * 空返回时的备用模板（两种靶通用）：DeepSeek-OCR 官方 grounding 模板——
 * 0042 留档实测「稳定产出带 LaTeX 的 markdown」（原文形态 `\( U \)`，本单已做定界符归一）。
 */
const OCR_FALLBACK_PROMPT = DSO_GROUNDING_PROMPTS[1];

/**
 * 拼图靶的转写提示词（返工⑦ · 线上实测经验）：一题内多张公式图拼成**带编号的网格大图**，
 * 一次调用取回全部。编号给了可机械校验的对应关系（缺号/重号/越界 → 整片作废走单图兜底）。
 * 仍用英文短提示词（同 `FORMULA_TRANSCRIBE_PROMPT` 的口径）。
 */
const MONTAGE_TRANSCRIBE_PROMPT =
  'The image shows several math formulas arranged in a grid, each labeled by a number on its left. '
  + 'Output exactly one line per formula in the form "<number>: <LaTeX code>", and nothing else.';

/**
 * 缺省图片准备（无 Electron 栅格器时的保守口径）：位图原样过桥（mime 用嗅探真身）、
 * SVG 与「非图片字节」都显式记账——不发出去、也不静默。
 */
function defaultPrepareImages(requests: AiCleanImageRequest[]): Map<string, AiCleanImagePrepared> {
  const out = new Map<string, AiCleanImagePrepared>();
  for (const request of requests) {
    const format = sniffImageType(request.bytes);
    if (format === 'svg') {
      out.set(request.key, { error: 'SVG 公式图需栅格化后才能送视觉模型（本次未注入图片准备器——装配问题）' });
      continue;
    }
    if (format === 'unknown') {
      out.set(request.key, { error: `资产不是图片（${request.assetRelPath}）` });
      continue;
    }
    out.set(request.key, { dataBase64: request.bytes.toString('base64'), mime: mimeOfFormat(format) });
  }
  return out;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 失败原因补全（返工⑧ 改口径）：**不再猜「403 占位图」**。
 * 返工① 曾给「答案/解析图转写为空」补一句「也可能是站点 403 占位图」——用户第二道样题上它被
 * 重复列了 8 次（解析区 8 张公式小图），看起来像程序坏了，且掩盖了真因（该档案读不出公式小图）。
 * 现在只把**字段**写清楚（弹层据此分组显示），原因本身原样透传（不替模型编解释）。
 */
function withEmptyImageHint(target: AiCleanTarget, reason: string): string {
  const field = target.field === 'content' ? '题面' : target.field === 'answer' ? '答案区' : '解析区';
  if (target.kind !== 'answer' || !reason.includes('空内容')) return reason;
  return `${reason}（${field}图）`;
}

function fieldsOf(question: AiCleanQuestionLike): QuestionAiCleanFields {
  return {
    content: question.content ?? '',
    answer: question.answer ?? '',
    analysis: question.analysis ?? '',
    images: question.images ?? [],
  };
}

/**
 * 注入面解析：provider 优先，其次由 invoke 组两段式（两者皆无 = 装配错误，显式抛）。
 * `role` = 转写腿（OCR 腿）走哪个档案；缺省 vision。
 *
 * 返工⑥/⑦（用户拍板）：不做「双模型投票」（第二意见腿已删）；公式靶改为**角色链按序试**
 * （见 `QuestionAiCleanDeps.formulaRoles`），主腿是通用视觉/推理档案，专用 OCR 退为兜底。
 */
export interface ProviderOptions {
  /** 转写腿（OCR 腿）走哪个档案角色；缺省 vision */
  role?: ModelRole;
  /** 转写提示词覆盖（拼图靶要用「编号网格」提示词，与单图靶不同） */
  prompt?: string;
  /** 是否挂 DSO grounding 备用模板（只对专用 OCR 档案有意义） */
  dsoFallback?: boolean;
}

function providerOf(
  deps: QuestionAiCleanDeps,
  kind: AiCleanTarget['kind'],
  options: ProviderOptions = {},
): OnestepProvider {
  if (deps.provider) return deps.provider;
  if (!deps.invoke) throw new Error('question.aiClean：未注入 provider/invoke（装配错误）');
  const ocrRole = options.role ?? 'vision';
  return createTwoStageProvider({
    invoke: deps.invoke,
    ...(options.role !== undefined ? { groundingRole: options.role } : {}),
    // 返工③：公式靶给英文「只出 LaTeX」短提示词（线上实测口径）；答案/解析靶保持中文通用转写指令
    // （整张答案解析图要的是逐字转写，不是单个公式）
    ...(kind === 'formula' ? { transcribePrompt: options.prompt ?? FORMULA_TRANSCRIBE_PROMPT } : {}),
    // 0069：答案/解析整图靶的两条腿都换成「图占位」口径——转写腿在图位置留 [图N]（抠图坐标腿的落点）、
    // 结构化腿把 [图N] 原样带进 answer/analysis markdown（否则「整理为通顺 Markdown」会把它洗掉）
    ...(kind === 'answer'
      ? { transcribePrompt: AI_CLEAN_ANSWER_TRANSCRIBE_PROMPT, structurePrompt: AI_CLEAN_ANSWER_STRUCTURE_PROMPT }
      : {}),
    // 返工②：空返回时用 DSO 官方 grounding 模板再试一次——**只对专用 OCR 档案有意义**
    // （DeepSeek-OCR 只认自家模板；通用视觉模型不需要，多了反而招来版面参考串；拼图靶也不适用）
    ...(ocrRole === 'vision' && (options.dsoFallback ?? kind === 'formula') === true
      ? { transcribeFallbackPrompt: OCR_FALLBACK_PROMPT }
      : {}),
  });
}

/**
 * 取图 → 文字：**优先纯转写**（`provider.transcribe`）——公式图文转文字属转写域，
 * 文本模型改写的第二腿对单公式是净损失（0042 §8 分工红线 + 施工参考 §2.1）；
 * provider 未实现 transcribe（如一步到位 VLM）→ 退回 extract 取 stemMarkdown。
 */
async function transcribeText(provider: OnestepProvider, image: { dataBase64: string; mime: string }): Promise<string> {
  if (typeof provider.transcribe === 'function') return provider.transcribe({ image });
  const drafts = await provider.extract({ image });
  return drafts[0]?.stemMarkdown ?? '';
}

/** 单图 → 引擎草稿（公式靶取 stemMarkdown；答案靶取 answer/analysis 双出——拍板②） */
function outputOf(target: AiCleanTarget, drafts: OnestepDraft[]): AiCleanImageOutput {
  const draft = drafts[0];
  if (!draft) return { target, ok: false, error: '引擎未产出任何草稿' };
  // 0065 目检返工①：**任一产出侧**是站点权限文案 → 判占位图（未登记变体兜底）。
  // 原来只查题面字段：若模型把「（403）您没有权限查看组卷网答案解析…」放进 answerMarkdown，
  // 就会原样写进答案区（真库 20 处占位图全在答案区，故这一支必须堵上）。
  for (const text of [draft.answerMarkdown, draft.analysisMarkdown, draft.stemMarkdown]) {
    const guarded = placeholderGuardOf(target, text ?? '');
    if (guarded !== null) return guarded;
  }
  if (target.kind === 'formula') return { target, ok: true, text: draft.stemMarkdown };
  const answerText = draft.answerMarkdown;
  const analysisText = draft.analysisMarkdown;
  const bothEmpty = (answerText ?? '').trim() === '' && (analysisText ?? '').trim() === '';
  // 0065（任务书 §一.1）：引擎**判不出**答案/解析归属（两侧皆空、内容落在题面字段）时，
  // 整图内容归解析区、答案区留空，并记 warning 供人在对照弹层核对——不静默丢内容、也不猜成答案。
  if (bothEmpty) {
    const fallback = (draft.stemMarkdown ?? '').trim();
    if (fallback !== '') {
      return {
        target,
        ok: true,
        answerText: null,
        analysisText: draft.stemMarkdown,
        flags: ['引擎未区分答案/解析归属：整图内容已归入解析区（答案区留空）——请在对照弹层核对'],
      };
    }
  }
  return { target, ok: true, answerText, analysisText };
}

/** 整图（答案/解析）靶的一条腿（一个模型档案角色） */
export interface AnswerLeg {
  /** 人读标签（档案角色名，如 `reasoning`/`vision`；注入替身 = `注入`） */
  label: string;
  provider: OnestepProvider;
}

/** 该腿的产出是否可用（占位图结论也算「有结论」；双出两侧全空 = 该腿白跑，换下一腿） */
function answerOutputUsable(output: AiCleanImageOutput): boolean {
  if (output.placeholderReason !== undefined) return true;
  if (!output.ok) return false;
  return (output.answerText ?? '').trim() !== '' || (output.analysisText ?? '').trim() !== '';
}

/**
 * 0065 目检返工①（用户真机）：答案/解析**整图**靶转写——**腿链**，与公式靶同源（任务书 §一.1
 * 「单图腿链兜底（formulaRoles：推理主腿 + 专用 OCR 兜底）」）。
 *
 * 为什么必须退腿（真机现场定位）：用户库 `model_profiles` 的 vision 槽 = **DeepSeek-OCR**，
 * 而整图靶用的是**中文通用**提示词（`ONESTEP_TRANSCRIBE_PROMPT`）——该档案对中文通用指令直接空返回
 * （0042 §Q2 留档「中文『图』两次空返回淘汰」），于是「答案图永远转不出来」，且旧实现**只有这一条腿**、
 * 没有备用模板、没有第二条腿可退 ⇒ 用户看到的「OCR 转写腿返回空内容（该档案不具备转写能力域）」。
 *
 * 口径：按腿序试（缺省 reasoning → vision），首个产出可用双出的腿为准；退腿时**挂可见告警**（不静默换模型）；
 * 全腿无产出才判失败，并把**各腿原因**一并报出（不再只报一句「不具备转写能力域」）。
 */
export async function transcribeAnswerField(
  target: AiCleanTarget,
  image: { dataBase64: string; mime: string },
  legs: AnswerLeg[],
): Promise<AiCleanImageOutput> {
  const failures: string[] = [];
  for (const [index, leg] of legs.entries()) {
    let output: AiCleanImageOutput;
    try {
      const drafts = await leg.provider.extract({ image });
      output = outputOf(target, drafts);
    } catch (err) {
      failures.push(`${leg.label}：${messageOf(err)}`);
      continue;
    }
    if (answerOutputUsable(output)) {
      // 占位图结论直接透传（它本身就是「不用再试了」的结论，不挂回退告警）
      if (index === 0 || output.placeholderReason !== undefined) return output;
      return {
        ...output,
        flags: [
          ...(output.flags ?? []),
          `答案/解析图转写已回退到「${leg.label}」腿（前序腿未产出：${failures[index - 1]?.slice(0, 60) ?? '—'}）`,
        ],
      };
    }
    failures.push(`${leg.label}：引擎未产出答案/解析文字（两侧皆空）`);
  }
  const reason = failures.length > 0 ? failures.join('；') : '引擎未产出任何草稿';
  const prefix = legs.length > 1 ? `全部转写腿未通过（${legs.map((leg) => leg.label).join('→')}）：` : '';
  return { target, ok: false, error: withEmptyImageHint(target, `${prefix}${reason}`) };
}

/**
 * preview：产出逐题「整理前后对照」（**零写库**）。
 * 引擎按题内靶序串行调用；同一图（相同资产路径）在同一轮只调一次（多题共用图零重复成本）。
 */
/**
 * 取该靶的**原始 SVG 文本**（仅公式靶且资产确为 SVG 时；位图/答案区 → null，无骨架可校验）。
 * 注意：训练/测试注入的 readAsset 可能读不到（如已栅格化的替身）——失败静默为 null（不阻塞主链）。
 */
function svgTextOf(
  readAsset: (absPath: string) => Buffer,
  dataDir: string,
  target: AiCleanTarget,
): string | null {
  if (target.kind !== 'formula') return null;
  if (!/\.svg$/i.test(target.assetRelPath)) return null;
  try {
    return readAsset(join(dataDir, 'assets', target.assetRelPath)).toString('utf8');
  } catch {
    return null;
  }
}

/** 一条转写腿（一个模型档案角色） */
export interface FormulaLeg {
  /** 人读标签（档案角色名，如 `reasoning`/`vision`；注入替身 = `注入`） */
  label: string;
  provider: OnestepProvider;
}

/** 单段公式文本的质量闸门结果 */
export type FormulaGateResult =
  | { ok: true; text: string; flags: string[]; needsReview: boolean }
  | { ok: false; reason: string };

/**
 * 单段公式文本过闸门（单图靶与拼图靶**共用**）：清洗（§2.2/§2.5）→ 幻觉拦截 → 骨架校验（§2.4）。
 * `extraFlags` = 调用场景自带的说明（如拼图行序兜底、回退腿提示）。
 */
export function gateFormulaText(
  target: AiCleanTarget,
  raw: string,
  svgText: string | null,
  extraFlags: string[] = [],
): FormulaGateResult {
  const sanitized = sanitizeFormulaTex(raw);
  const garbage = hallucinationReason(sanitized.tex);
  if (garbage !== null) {
    return { ok: false, reason: `转写结果不可用：${garbage}（原文：${raw.slice(0, 40)}…）` };
  }
  const flags: string[] = [];
  if (sanitized.notes.length > 0) flags.push(`结果已清洗（${sanitized.notes.join('、')}）`);
  // 骨架校验（§2.4 否定式；仅原始 SVG 可得时）
  if (svgText !== null) {
    const skeleton = parseFormulaSkeleton(svgText);
    flags.push(...checkFormulaAgainstSkeleton(sanitized.tex, skeleton).flags);
  }
  flags.push(...extraFlags);
  return {
    ok: true,
    text: sanitized.tex,
    flags,
    // 「疑」标记 = 需人工复核（弹层默认不勾选）
    needsReview: flags.some((flag) => flag.includes('疑')),
  };
}

export interface TranscribeFormulaDeps {
  target: AiCleanTarget;
  image: { dataBase64: string; mime: string };
  svgText: string | null;
  /** 转写腿（按序试；首个「过闸门」的结果为准，全部不过 → 把各腿原因一并报出） */
  legs: FormulaLeg[];
  /** 调用场景自带的说明（如「拼图第 N 行未通过 → 已按单图重试」），并入 flags 供人看 */
  extraFlags?: string[];
}

/**
 * 公式靶：转写 → 清洗（§2.2/§2.5）→ 骨架校验（§2.4）；**转写腿按序试**（返工⑦）。
 * 口径：垃圾/幻觉形态 → 该腿作废、换下一腿（全部作废才判该图失败，保留原图）；
 *       骨架矛盾 → 结果可用但**标可疑**（flags 带「疑」字 → 弹层默认不勾选，人工定夺）；
 *       仅靠兜底腿才拿到结果 → 记一条回退告警（可见、不阻断）。
 */
export async function transcribeFormula(input: TranscribeFormulaDeps): Promise<AiCleanImageOutput> {
  const { target, image, svgText, legs } = input;
  const baseFlags = input.extraFlags ?? [];
  const failures: string[] = [];
  /** 过了幻觉闸门但带「疑」标记的第一条结果（所有腿都无干净结果时兜底采用） */
  let flagged: AiCleanImageOutput | null = null;

  for (const [index, leg] of legs.entries()) {
    let raw: string;
    try {
      raw = await transcribeText(leg.provider, image);
    } catch (err) {
      failures.push(`${leg.label}：${messageOf(err)}`);
      continue;
    }
    // 0065：转写文本本身就是权限文案 → 该图是未登记的占位图变体：直接判占位（保留原图、不写字段），
    // 不让「请开通权限」被当成公式写进题面/解析区（省下后续腿与重试）
    const guarded = placeholderGuardOf(target, raw);
    if (guarded !== null) return guarded;
    const extra = index > 0
      ? [...baseFlags, `公式转写已回退到「${leg.label}」腿（前 ${index} 条未过：${failures[index - 1]?.slice(0, 60) ?? '—'}）`]
      : baseFlags;
    const gated = gateFormulaText(target, raw, svgText, extra);
    if (!gated.ok) {
      failures.push(`${leg.label}：${gated.reason}`);
      continue;
    }
    // 「干净」= 无「疑」标记（清洗动作/回退说明不算脏）→ 立刻采用；
    // 带「疑」标记的先记下，留给后续腿翻盘（后腿给出干净结果则以后者为准）
    if (!gated.needsReview) return { target, ok: true, text: gated.text, flags: gated.flags };
    if (flagged === null) flagged = { target, ok: true, text: gated.text, flags: gated.flags };
  }

  if (flagged !== null) return flagged;
  const reason = failures.length > 0 ? failures.join('；') : '引擎未产出任何草稿';
  const prefix = legs.length > 1 ? `全部转写腿未通过（${legs.map((leg) => leg.label).join('→')}）：` : '';
  return { target, ok: false, error: withEmptyImageHint(target, `${prefix}${reason}`) };
}

/** 拼图靶的一个片段（已准备好的图 + 其靶与原始 SVG 文本） */
export interface FormulaMontageFragmentInput {
  /** 靶缓存键（`${kind}:${assetRelPath}`） */
  cacheKey: string;
  target: AiCleanTarget;
  image: { dataBase64: string; mime: string };
  width: number;
  height: number;
  svgText: string | null;
}

export interface FormulaMontageDeps {
  fragments: FormulaMontageFragmentInput[];
  /** 转写腿（按序试；首个「回包能按编号对齐」的腿为准） */
  legs: FormulaLeg[];
  render: (fragments: AiCleanMontageFragment[], plan: MontagePlan) => Promise<AiCleanMontageOutcome>;
}

export interface FormulaMontageOutcome {
  /** 通过的片段：cacheKey → 结果（主循环直接采用） */
  results: Map<string, AiCleanImageOutput>;
  /** 未拿到结果的片段：cacheKey → 人读原因（主循环会按单图重试，此原因作为可见告警附上） */
  rescued: Map<string, string>;
  /**
   * 0065：回包某行就是权限文案 → 该片段是**未登记的占位图变体**：cacheKey → 人读原因。
   * 不进 rescued（不按单图重试——重试只会再拿回同一句权限文案）。
   */
  placeholders: Map<string, string>;
}

/**
 * 拼图靶转写（返工⑦ · 线上实测经验）：一题内多张公式图拼成**一张带编号的网格大图** → 一次调用取回全部。
 *
 * 口径：
 *   · 排版由 `planMontage` 算（片段不重采样；超上限整体收敛）；
 *   · 回包必须能**按编号严格对齐**（缺号/重号/越界 → 该腿作废换下一腿；全部作废 → 整片交单图兜底）；
 *   · 单行过不了闸门（幻觉/骨架矛盾）→ **只把那一行走单图兜底**（其余行照常采用，不因一行废全片）；
 *   · 模型忘了编号但行数恰好 → 按行序对齐，并挂一条可见告警（建议人工核对）。
 */
export async function transcribeFormulaMontage(deps: FormulaMontageDeps): Promise<FormulaMontageOutcome> {
  const { fragments, legs, render } = deps;
  const results = new Map<string, AiCleanImageOutput>();
  const rescued = new Map<string, string>();
  const placeholders = new Map<string, string>();
  if (fragments.length < 2) {
    for (const fragment of fragments) rescued.set(fragment.cacheKey, '拼图片段不足两张');
    return { results, rescued, placeholders };
  }

  const plan = planMontage(fragments.map((fragment) => ({ width: fragment.width, height: fragment.height })));
  const composed = await render(
    fragments.map((fragment) => ({
      key: fragment.cacheKey,
      dataUrl: `data:${fragment.image.mime};base64,${fragment.image.dataBase64}`,
      width: fragment.width,
      height: fragment.height,
    })),
    plan,
  );
  if (!composed.ok) {
    for (const fragment of fragments) rescued.set(fragment.cacheKey, `公式拼图渲染失败（${composed.error}）`);
    return { results, rescued, placeholders };
  }

  const montageImage = { dataBase64: composed.png.toString('base64'), mime: 'image/png' };
  const failures: string[] = [];
  for (const [index, leg] of legs.entries()) {
    let raw: string;
    try {
      raw = await transcribeText(leg.provider, montageImage);
    } catch (err) {
      failures.push(`${leg.label}：${messageOf(err)}`);
      continue;
    }
    const parsed = parseMontageRows(raw, fragments.length);
    if (parsed === null) {
      failures.push(`${leg.label}：回包无法按编号对齐（原文：${raw.slice(0, 60)}…）`);
      continue;
    }
    const extra: string[] = [];
    if (index > 0) extra.push(`公式拼图已回退到「${leg.label}」腿（前序腿未通过：${failures[index - 1]?.slice(0, 60) ?? '—'}）`);
    if (parsed.ordered) extra.push('公式拼图回包未编号——已按行序对齐（建议人工核对）');
    for (const [position, fragment] of fragments.entries()) {
      const rowText = parsed.rows.get(position + 1);
      if (rowText === undefined) {
        rescued.set(fragment.cacheKey, `公式拼图缺第 ${position + 1} 行`);
        continue;
      }
      // 0065：该行就是权限文案 → 占位图（不按单图重试，也不当失败）
      const guarded = placeholderGuardOf(fragment.target, rowText);
      if (guarded !== null) {
        placeholders.set(fragment.cacheKey, `${guarded.placeholderReason}（公式拼图第 ${position + 1} 行）`);
        continue;
      }
      const gated = gateFormulaText(fragment.target, rowText, fragment.svgText, extra);
      if (!gated.ok) {
        rescued.set(fragment.cacheKey, `公式拼图第 ${position + 1} 行${gated.reason}`);
        continue;
      }
      if (gated.needsReview) {
        // 可疑行也交单图兜底：单图链有机会换腿翻盘（照采可疑结果的语义留给单图路径）
        rescued.set(fragment.cacheKey, `公式拼图第 ${position + 1} 行起疑（${gated.flags.join('、')}）`);
        continue;
      }
      results.set(fragment.cacheKey, { target: fragment.target, ok: true, text: gated.text, flags: gated.flags });
    }
    return { results, rescued, placeholders };
  }

  const reason = failures.length > 0 ? failures.join('；') : '拼图无可用腿';
  for (const fragment of fragments) rescued.set(fragment.cacheKey, `公式拼图未通过（${reason}）`);
  return { results, rescued, placeholders };
}

/**
 * 0069（R-075）：答案/解析整图靶的**配图坐标腿**——DSO grounding 双模板（并行）。
 *
 * 调用范式逐条照抄 `recog/providers/onestep.ts` 的 `dsoGrounding`（0042 §十第二轮定稿）：role 走
 * vision 槽、双模板**并行**、温度 0、OCR 超时；**双模板全失败**才算失败（单模板失败不致命——
 * 并集口径本就为容错）。本腿只服务抠图：失败不抛出，由调用方记可见告警并退化为 0065 现状。
 */
async function dsoGroundingRaw(
  deps: QuestionAiCleanDeps,
  image: { dataBase64: string; mime: string },
): Promise<{ raw: string[]; failed: string | null }> {
  const invoke = deps.invoke;
  if (!invoke) return { raw: [], failed: '未注入 invoke（无坐标腿可用——装配问题）' };
  const url = `data:${image.mime};base64,${image.dataBase64}`;
  const settled = await Promise.all(
    DSO_GROUNDING_PROMPTS.map(async (prompt) => {
      try {
        return await invoke({
          role: ANSWER_FIGURE_GROUNDING_ROLE,
          messages: [{
            role: 'user',
            content: [
              { type: 'image_url', imageUrl: { url } },
              { type: 'text', text: prompt },
            ],
          }],
          temperature: 0,
          timeoutMs: ONESTEP_OCR_TIMEOUT_MS,
        });
      } catch (err) {
        return { ok: false as const, error: messageOf(err) };
      }
    }),
  );
  const raw: string[] = [];
  const errors: string[] = [];
  for (const result of settled) {
    if (result.ok) raw.push(result.content);
    else errors.push(result.error);
  }
  return { raw, failed: raw.length === 0 && errors.length > 0 ? errors.join('；') : null };
}

/**
 * 0069：bbox（0~1 归一）→ 裁剪矩形（四边外扩 {@link ANSWER_FIGURE_CROP_PAD}，越界收到图内）。
 * 退化框（宽高 ≤ 0）返回 null = 不裁（调用方记告警，不留静默空壳）。
 */
function cropRectOf(bbox: OnestepBBox): { x: number; y: number; width: number; height: number } | null {
  const [x1, y1, x2, y2] = bbox;
  if (!(x2 > x1) || !(y2 > y1)) return null;
  const pad = ANSWER_FIGURE_CROP_PAD;
  const x = Math.max(0, x1 - pad);
  const y = Math.max(0, y1 - pad);
  const right = Math.min(1, x2 + pad);
  const bottom = Math.min(1, y2 + pad);
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * 0069（R-075）：整图靶的**配图抠图**（转写腿链之外的一条腿 + 对账 + 裁剪落资产）。
 *
 * 触发门（成本口径）：**双出文字里确有 `[图N]` 占位**才跑坐标腿——纯文字答案图（无占位）时零调用、
 * 零告警、产出与 0065 逐字节一致（这是本单的回归锁）。
 *
 * 落法（D-083 方案 A）：
 *   ① 坐标腿双模板并行（并行在该腿内部；与转写腿串行——转写腿的产出决定要不要跑坐标腿）；
 *   ② `reconcileFigures` 原样复用（`inlineBoxes` 恒空：两段式主模型无 bbox 能力），文案换答案/解析口径；
 *   ③ 裁剪源 = **送模型的那份字节**（`prepared`，与 crop.ts 的「从送给模型的那张图上裁」同口径：
 *      准备层可能放大/加白边，用源资产原图配同一矩形会整块偏掉）；
 *   ④ 产物走 `saveRecogImageDataUrl` 内容寻址落 `data/assets/recog/`（幂等、零孤儿）。
 *
 * 一切失败（坐标腿失败/退化框/裁剪失败/落资产失败）都**显式告警**，文字链照常返回——不静默、不阻塞。
 */
async function attachAnswerFigures(
  deps: QuestionAiCleanDeps,
  image: { dataBase64: string; mime: string },
  output: AiCleanImageOutput,
  renderCrop: (items: AiCleanCanvasItem[]) => Promise<AiCleanCanvasOutcome>,
): Promise<AiCleanImageOutput> {
  if (!output.ok) return output;
  const answerText = output.answerText ?? '';
  const analysisText = output.analysisText ?? '';
  const placeholderRefs = [...new Set([
    ...figureRefsInMarkdown(answerText),
    ...figureRefsInMarkdown(analysisText),
  ])].sort((a, b) => a - b);

  // ---- 无 [图N] 时：只有文字提到配图才值得花一次坐标腿去确认（返工②：把「静默漏图」变成可见）----
  if (placeholderRefs.length === 0) {
    if (!FIGURE_MENTION_RE.test(`${answerText}${analysisText}`)) return output;   // 无图线索 = 零成本
    const grounded = await dsoGroundingRaw(deps, image);
    const flags: string[] = [];
    if (grounded.failed !== null) {
      flags.push(`配图坐标腿未出结果（${grounded.failed}）——本图若有配图未被抠出，可重试整理或在编辑器手动补图`);
    } else {
      const detected = reconcileFigures(
        { dsoRawOutputs: grounded.raw, inlineBoxes: [], placeholderRefs: [] },
        { label: '答案/解析区' },
      );
      if (detected.figures.length > 0) {
        flags.push(
          `文字里提到配图（如「如图」）但模型未在答案/解析中留下 [图N] 占位——检出 ${detected.figures.length} 个图块**未抠出**：`
          + '可重试整理（模型重采样），或在编辑器里手动补图',
        );
      }
    }
    return flags.length > 0 ? { ...output, flags: [...(output.flags ?? []), ...flags] } : output;
  }

  const grounded = await dsoGroundingRaw(deps, image);
  const reconciled = reconcileFigures(
    { dsoRawOutputs: grounded.raw, inlineBoxes: [], placeholderRefs },
    { label: '答案/解析区', uncoveredHint: '不静默留占位：请在编辑器里补图或删掉该占位' },
  );
  const flags = [...reconciled.warnings];
  if (grounded.failed !== null) {
    flags.push(`配图坐标腿（DeepSeek-OCR grounding 双模板）未出结果（${grounded.failed}）——答案/解析文字照常整理，配图未抠出`);
  }

  const figures: AiCleanFigureRef[] = [];
  const cropItems: AiCleanCanvasItem[] = [];
  const refOfKey = new Map<string, number>();
  for (const [index, figure] of reconciled.figures.entries()) {
    const refIndex = index + 1;
    const srcRect = cropRectOf(figure.bbox);
    if (srcRect === null) {
      flags.push(`[图${refIndex}] 坐标退化（宽高为 0）——未抠图，请在编辑器里补图或删掉该占位`);
      continue;
    }
    const key = `fig:${refIndex}`;
    cropItems.push({
      key,
      width: 0,                                  // 裁剪模式不用（输出尺寸由源图内在尺寸与 srcRect 定）
      height: 0,
      draw: { x: 0, y: 0, width: 0, height: 0 },
      source: { mime: image.mime, base64: image.dataBase64 },
      srcRect,
    });
    refOfKey.set(key, refIndex);
  }

  if (cropItems.length > 0) {
    let rendered: AiCleanCanvasOutcome;
    try {
      rendered = await renderCrop(cropItems);
    } catch (err) {
      rendered = { images: new Map(), failed: cropItems.map((item) => ({ key: item.key, error: messageOf(err) })) };
    }
    for (const item of cropItems) {
      const refIndex = refOfKey.get(item.key)!;
      const png = rendered.images.get(item.key);
      if (!png || png.length === 0) {
        const failure = rendered.failed.find((entry) => entry.key === item.key);
        flags.push(`[图${refIndex}] 抠图失败（${failure?.error ?? '未产出 PNG'}）——已留空占位，请在编辑器里补图`);
        continue;
      }
      try {
        const saved = saveRecogImageDataUrl(deps.dataDir, { dataUrl: `data:image/png;base64,${png.toString('base64')}` });
        figures.push({
          refIndex,
          src: `data-assets/${saved.relPath}`,
          ...(saved.width !== undefined && saved.height !== undefined
            ? { width: saved.width, height: saved.height }
            : {}),
        });
      } catch (err) {
        flags.push(`[图${refIndex}] 抠图落资产失败（${messageOf(err)}）——已留空占位，请在编辑器里补图`);
      }
    }
  }

  // 对账出图但没落成产物的编号也要可见（reconcile 只报「未配到图块」，这里补「配到了但没抠成」）
  const producedRefs = new Set(reconciled.figures.map((_, index) => index + 1));
  const cropMissing = placeholderRefs.filter((n) => producedRefs.has(n) && !figures.some((f) => f.refIndex === n));
  if (cropMissing.length > 0) {
    flags.push(`答案/解析区 [${cropMissing.map((n) => `图${n}`).join('、')}] 未能抠出配图——已留空占位（请在编辑器里补图或删掉该占位）`);
  }
  if (figures.length > 0) {
    flags.push(`配图抠图：已抠出 ${figures.length} 张（来源：DSO grounding 坐标腿）并落资产，可在对照弹层核对`);
  }

  return { ...output, figures, flags: [...(output.flags ?? []), ...flags] };
}

/**
 * preview：产出逐题「整理前后对照」（**零写库**）。
 * 引擎按题内靶序串行调用；同一图（相同资产路径）在同一轮只调一次（多题共用图零重复成本）。
 */
export async function previewQuestionAiClean(
  deps: QuestionAiCleanDeps,
  questionIds: string[],
): Promise<QuestionAiCleanItem[]> {
  const readAsset = deps.readAsset ?? ((absPath: string) => readFileSync(absPath));
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  /** 答案/解析靶的 provider（整图靶腿链，见 `answerLegs`） */
  const answerLegsCache = new Map<AiCleanTarget['kind'], AnswerLeg[]>();
  /**
   * 整图（答案/解析）靶的转写腿链（0065 目检返工①）：
   * 注入 provider 时只有一条「注入」腿（测试/探针口径）；否则按 `formulaRoles` 逐腿构建
   * （缺省 reasoning 主腿 → vision 兜底腿），每条腿都挂 DSO 备用模板（vision 槽若是专用 OCR 模型，只认自家模板）。
   */
  const answerLegs = (kind: AiCleanTarget['kind']): AnswerLeg[] => {
    const cached = answerLegsCache.get(kind);
    if (cached) return cached;
    const legs: AnswerLeg[] = deps.provider
      ? [{ label: '注入', provider: deps.provider }]
      : (deps.formulaRoles ?? DEFAULT_FORMULA_ROLES).map((role) => ({
        label: role,
        provider: providerOf(deps, kind, { role, dsoFallback: true }),
      }));
    answerLegsCache.set(kind, legs);
    return legs;
  };
  /** 公式靶转写腿链（单图模式 / 拼图模式各一份，提示词不同；注入 provider 时只有一条「注入」腿） */
  const legsCache = new Map<'single' | 'montage', FormulaLeg[]>();
  const formulaLegs = (mode: 'single' | 'montage'): FormulaLeg[] => {
    const cached = legsCache.get(mode);
    if (cached) return cached;
    const legs: FormulaLeg[] = deps.provider
      ? [{ label: '注入', provider: deps.provider }]
      : (deps.formulaRoles ?? DEFAULT_FORMULA_ROLES).map((role) => ({
        label: role,
        provider: providerOf(deps, 'formula', mode === 'montage'
          ? { role, prompt: MONTAGE_TRANSCRIBE_PROMPT, dsoFallback: false }
          : { role }),
      }));
    legsCache.set(mode, legs);
    return legs;
  };
  const renderMontage = deps.renderMontage ?? defaultRenderMontage;
  const renderCrop = deps.renderCrop ?? defaultRenderCrop;
  const cache = new Map<string, AiCleanImageOutput>();
  /** 拼图行未通过时的单图兜底说明（cacheKey → 人读原因；主循环重试后附为可见告警） */
  const montageRescue = new Map<string, string>();
  const items: QuestionAiCleanItem[] = [];

  for (const questionId of questionIds) {
    const question = await deps.getQuestion(questionId);
    if (!question) {
      items.push({
        questionId, ok: false, before: null, after: null, converted: 0,
        failedImages: [], skipped: null, error: '题目不存在或已删除', warnings: [],
      });
      continue;
    }
    const before = fieldsOf(question);
    const skipped = skipReasonOf(question);
    if (skipped !== null) {
      items.push({
        questionId, ok: false, before, after: null, converted: 0,
        failedImages: [], skipped, error: null, warnings: [],
      });
      continue;
    }

    const plan = planAiClean({ content: before.content, answer: before.answer, analysis: before.analysis });
    /** 返工⑧ 的 deferred 面：0065 起恒空（含正文字段改走原位模式），保留字段以兼容 0056 弹层 */
    const deferredList = plan.deferred.map((entry) => ({
      src: entry.src,
      reason: entry.reason,
    }));
    /** 0065：各字段本次的整理方式（弹层标签；只列确有靶的字段） */
    const fieldModes: Partial<Record<AiCleanField, QuestionAiCleanApplyMode>> = {};
    for (const target of plan.targets) fieldModes[target.field] = target.mode;
    if (plan.targets.length === 0) {
      items.push({
        questionId, ok: false, before, after: null, converted: 0,
        failedImages: [], skipped: plan.reason ?? '无需整理', error: null, warnings: [],
        ...(deferredList.length > 0 ? { deferred: deferredList } : {}),
      });
      continue;
    }

    // ---- 图片准备（目检返工①）：本题待跑靶一次性准备（读盘 + 嗅探 + SVG 栅格化，批量一次开窗）----
    const pendingTargets = plan.targets.filter((target) => !cache.has(`${target.kind}:${target.assetRelPath}`));
    const pendingByKey = new Map<string, AiCleanTarget>();
    const requests: AiCleanImageRequest[] = [];
    const readFailures = new Map<string, string>();
    /**
     * 0065：**403 占位图前置判据**（零 token）——读盘字节逐字节比对库内已知样本，
     * 命中则**不进 requests**（不准备、不调用），只记账待弹层单列分组。
     */
    const placeholderByKey = new Map<string, QuestionAiCleanPlaceholder>();
    for (const target of pendingTargets) {
      const cacheKey = `${target.kind}:${target.assetRelPath}`;
      if (pendingByKey.has(cacheKey)) continue;
      pendingByKey.set(cacheKey, target);
      try {
        const bytes = readAsset(join(deps.dataDir, 'assets', target.assetRelPath));
        if (bytes.length === 0) throw new Error('资产文件为空');
        const placeholderReason = placeholderReasonOf(bytes);
        if (placeholderReason !== null) {
          placeholderByKey.set(cacheKey, { src: target.src, field: target.field, reason: placeholderReason });
          continue;
        }
        requests.push({
          key: cacheKey,
          assetRelPath: target.assetRelPath,
          bytes,
          mime: mimeOfPath(target.assetRelPath),
          width: target.width,
          height: target.height,
        });
      } catch (err) {
        readFailures.set(cacheKey, messageOf(err));
      }
    }
    const prepare = deps.prepareImages;
    const prepared = prepare ? await prepare(requests) : defaultPrepareImages(requests);

    // ---- 返工⑦（线上实测经验 + 用户拍板）：公式靶**先走拼图**（一题内 ≥2 张 → 拼一张带编号网格大图，
    //      一次调用取回全部公式）。拼不动的（渲染失败/回包不能按编号对齐/单行不过闸门）由下面的主循环
    //      按**单图腿链**兜底重试（推理主腿 → 专用 OCR 兜底）。----
    const formulaFragments: FormulaMontageFragmentInput[] = [];
    for (const target of plan.targets) {
      if (target.kind !== 'formula') continue;
      const cacheKey = `${target.kind}:${target.assetRelPath}`;
      if (cache.has(cacheKey)) continue;
      if (placeholderByKey.has(cacheKey)) continue;             // 0065：占位图不进拼图（零调用）
      const ready = prepared.get(cacheKey);
      if (!ready || 'error' in ready) continue;                 // 读盘/准备失败 → 主循环按既有口径记账
      if (!ready.width || !ready.height) continue;               // 尺寸未知 → 单图路径
      // 大图不进拼图（见 MONTAGE_MAX_FRAGMENT_LONG_EDGE_PX）：留在单图路径按 1:1 送。
      if (Math.max(ready.width, ready.height) > MONTAGE_MAX_FRAGMENT_LONG_EDGE_PX) continue;
      formulaFragments.push({
        cacheKey,
        target,
        image: { dataBase64: ready.dataBase64, mime: ready.mime },
        width: ready.width,
        height: ready.height,
        svgText: svgTextOf(readAsset, deps.dataDir, target),
      });
    }
    if (formulaFragments.length >= 2) {
      for (const chunk of chunkMontage(formulaFragments, MONTAGE_MAX_ITEMS)) {
        if (chunk.length < 2) continue;                          // 尾片只剩一张 → 交给单图路径
        const outcome = await transcribeFormulaMontage({
          fragments: chunk,
          legs: formulaLegs('montage'),
          render: renderMontage,
        });
        for (const [key, value] of outcome.results) cache.set(key, value);
        for (const [key, reason] of outcome.rescued) montageRescue.set(key, reason);
        // 0065：拼图行即权限文案 → 该片段判占位（不按单图重试、不进失败清单）
        for (const [key, reason] of outcome.placeholders) {
          const fragment = chunk.find((entry) => entry.cacheKey === key);
          if (fragment) cache.set(key, { target: fragment.target, ok: false, placeholderReason: reason });
        }
      }
    }

    const outputs: AiCleanImageOutput[] = [];
    for (const target of plan.targets) {
      // 同图去重按「靶种 + 资产路径」：同一资产在公式位与答案位语义不同，不互相套用结果
      const cacheKey = `${target.kind}:${target.assetRelPath}`;
      // 0065：前置判据命中的占位图——直接记占位输出（零引擎调用、零准备）
      const placeholder = placeholderByKey.get(cacheKey);
      if (placeholder !== undefined) {
        outputs.push({ target, ok: false, placeholderReason: placeholder.reason });
        continue;
      }
      const cached = cache.get(cacheKey);
      if (cached) {
        outputs.push({ ...cached, target });
        continue;
      }
      let output: AiCleanImageOutput;
      const readFailure = readFailures.get(cacheKey);
      const ready = prepared.get(cacheKey);
      if (readFailure !== undefined) {
        output = { target, ok: false, error: readFailure };
      } else if (!ready) {
        output = { target, ok: false, error: '图片准备未产出该靶（装配问题）' };
      } else if ('error' in ready) {
        output = { target, ok: false, error: ready.error };
      } else if (target.kind === 'formula') {
        // ---- 返工④/⑦：公式靶走「纯转写 + 清洗 + 骨架校验」，转写腿按序试（推理主腿 → 专用 OCR 兜底）；
        //      走到这里 = 拼图没给结果（含「拼图行未通过」）→ 单图重试，并把拼图侧原因附为可见告警。----
        const rescue = montageRescue.get(cacheKey);
        output = await transcribeFormula({
          target,
          image: { dataBase64: ready.dataBase64, mime: ready.mime },
          svgText: svgTextOf(readAsset, deps.dataDir, target),
          legs: formulaLegs('single'),
          extraFlags: rescue !== undefined ? [`${rescue} → 已按单图重试`] : [],
        });
      } else {
        // 0065 目检返工①：整图（答案/解析）靶走**腿链**（reasoning 主腿 → vision 兜底），
        // 不再单腿直取 vision（真机 vision 槽 = 专用 OCR 模型 + 中文通用提示词 = 必然空返回）
        const transcribed = await transcribeAnswerField(
          target,
          { dataBase64: ready.dataBase64, mime: ready.mime },
          answerLegs(target.kind),
        );
        // 0069（R-075）：双出文字里有 [图N] 占位 → 再跑坐标腿抠图拼回（无占位则原样返回，零成本）
        output = await attachAnswerFigures(
          deps,
          { dataBase64: ready.dataBase64, mime: ready.mime },
          transcribed,
          renderCrop,
        );
      }
      cache.set(cacheKey, output);
      outputs.push(output);
    }

    const merged = mergeAiClean({ ...before }, outputs);
    const failedImages = merged.failed;
    const placeholders: QuestionAiCleanPlaceholder[] = merged.placeholders;
    const convertedOk = merged.converted > 0;
    /** 0065：本题的靶**全是**占位图 → 未产出任何改写、也无失败（弹层单列分组，不进失败清单）。
     *  两路占位图都要算：前置指纹（placeholderByKey）与事后文案兜底（merged.placeholders）。 */
    const placeholderSrcs = new Set(placeholders.map((entry) => entry.src));
    const allPlaceholder = placeholders.length > 0 && failedImages.length === 0 && merged.converted === 0
      && plan.targets.every((target) => placeholderSrcs.has(target.src));
    if (allPlaceholder) {
      items.push({
        questionId, ok: false, before, after: null, converted: 0,
        failedImages: [], skipped: placeholderSkipReason(placeholders), error: null, warnings: [],
        fieldModes, placeholders,
      });
      continue;
    }    if (!convertedOk) {
      const reason = failedImages.map((f) => `${f.src}：${f.reason}`).join('；') || '整理未产出可用结果';
      warn(`question.aiClean：题 ${questionId} 整理失败（不中断整批）：${reason}`);
      items.push({
        questionId, ok: false, before, after: null, converted: 0,
        failedImages, skipped: null, error: reason, warnings: merged.warnings,
        fieldModes,
        ...(deferredList.length > 0 ? { deferred: deferredList } : {}),
        ...(placeholders.length > 0 ? { placeholders } : {}),
      });
      continue;
    }
    items.push({
      questionId,
      ok: true,
      before,
      after: {
        content: merged.content,
        answer: merged.answer,
        analysis: merged.analysis,
        images: merged.images,
      },
      converted: merged.converted,
      failedImages,
      skipped: null,
      error: null,
      warnings: merged.warnings,
      fieldModes,
      ...(deferredList.length > 0 ? { deferred: deferredList } : {}),
      ...(placeholders.length > 0 ? { placeholders } : {}),
      // 返工④：有质量标记（骨架矛盾等）→ 弹层默认不勾选，人工定夺
      ...(merged.needsReview ? { needsReview: true } : {}),
    });
  }
  return items;
}

export interface AiCleanCommitResult {
  saved: number;
  failed: Array<{ questionId: string; reason: string }>;
}

/**
 * commit：人确认后的改写逐题落库（只写三字段 + images），并写 operation_log 台账。
 * 单题失败记账继续，不整批回滚；零条待写则不产空账。
 */
export async function commitQuestionAiClean(
  deps: QuestionAiCleanDeps,
  items: QuestionAiCleanItemPatch[],
): Promise<AiCleanCommitResult> {
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const failed: Array<{ questionId: string; reason: string }> = [];
  let saved = 0;
  if (items.length === 0) return { saved, failed };

  const logId = deps.logger?.logStart(
    AI_CLEAN_OPERATION,
    `采集题 AI 整理：确认写入 ${items.length} 题（公式图/答案图转文字；整图靶配图另行抠出落资产）`,
    { questions: items.map((item) => item.questionId) },
  );

  for (const item of items) {
    try {
      await deps.updateQuestion(item.questionId, {
        content: item.content,
        answer: item.answer,
        analysis: item.analysis,
        images: item.images,
      });
      saved += 1;
    } catch (err) {
      const reason = messageOf(err);
      failed.push({ questionId: item.questionId, reason });
      warn(`question.aiClean：题 ${item.questionId} 落库失败（不整批回滚）：${reason}`);
    }
  }

  if (deps.logger && logId !== undefined) {
    if (failed.length > 0) {
      deps.logger.logFailure(logId, new Error(`${failed.length} 题落库失败：${failed.map((f) => `${f.questionId}: ${f.reason}`).join('；')}`));
    } else {
      deps.logger.logSuccess(logId, saved);
    }
  }
  return { saved, failed };
}
