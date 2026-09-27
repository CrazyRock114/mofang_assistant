// 0029：AI 建议管线宿主（shell 编排层，renderer 建议链唯一入口）。
//
// 链路（D-050：单次注入一次出建议，无多轮分层交互）：
//   快照（bank 只读）→ ≤4 层截断（recog/anchor/depth）→ prompt 组装（0024 buildAnchorPrompt）
//   → ai.invoke（reasoning 角色，经 0023 网关，本层不触 Key）→ 后置校验（0024 validateAnchorSuggestions）
//   → 按题归属分组 → 结构化建议 + 落草稿明细（P-3：不静默丢弃）。
//
// 边界：本宿主是纯读面（P-07）——不写树、不写标签；确认写入由 renderer 回走既有通道
// （tree.linkQuestion / bank.addTag）。批量归属策略：逐题分组后再过 0024 校验器——
// 校验器组内去重只作用于同题（跨题同名建议是合法的，不能互删）。

import type { AnchorQuery, AnchorSnapshot, AnchorSnapshotService, AnchorValidationFailure } from '../../shared/contracts/ai-anchor.js';
import type { Question } from '../../shared/contracts/bank-types.js';
import type { AiInvokePayload, AiInvokeResult, AiChatMessage } from '../../shared/contracts/ai-types.js';
import type {
  AiAnchorStatusPayload, AiAnchorStatusResult, AiSuggestDraft, AiSuggestMeta,
  AiSuggestPayload, AiSuggestResult, AiTagSuggestion, AiTreeSuggestion,
} from '../../shared/contracts/ai-suggest-types.js';
import type { AiSuggestTreeForDraftPayload } from '../../shared/contracts/onestep-types.js';
import { buildAnchorPrompt } from '../../recog/anchor/prompt.js';
import { estimateAnchorTokens } from '../../recog/anchor/budget.js';
import { validateAnchorSuggestions } from '../../recog/anchor/validate.js';
import { truncateSnapshotToDepth } from '../../recog/anchor/depth.js';

// ==================== 常量 ====================

/** 单次建议的最大输出 token（批量 1~2 建议/题 + JSON 结构余量；20 题 ×~80 token 仍宽裕） */
export const AI_SUGGEST_MAX_OUTPUT_TOKENS = 2000;
const INVOKE_TIMEOUT_MS = 60_000;
const INVOKE_RETRIES = 1;
const INVOKE_TEMPERATURE = 0.2;
/** 单题注入文本上限（题面截断，token 有界） */
const QUESTION_TEXT_MAX_CHARS = 800;
/** 标签词长度上限（超长落草稿） */
const TAG_MAX_CHARS = 24;
/**
 * 0040：草稿挂树建议的伪题号——草稿尚未入库，没有 questionId；
 * 用固定哨兵让 AI 的 evidence 归属校验口径与库内题完全一致（回指不上即被拦，不静默）。
 */
const DRAFT_QUESTION_ID = 'draft-1';

const TREE_TASK = [
  '任务：为下列每道题目从锚点清单中建议最合适的挂树节点（kind 固定为 tree-node）。',
  '要求：',
  '1. 每道题目最多给 2 个最贴切的节点建议；不确定宁缺毋滥。',
  '2. 每条建议的 evidence 必须以题目引用开头（{"kind":"question","questionId":"<题目id>"}），后接落点节点引用（{"kind":"tree-node","nodeId":"<清单中的节点ID>"}）。',
  '3. 某道题与清单内节点无匹配时不输出该题的建议；全部题目均无匹配时只输出 NONE。',
].join('\n');

const TAG_TASK = [
  '任务：为下列每道题目建议 0~3 个简短标签（题型特征/易错点/考点关键词，每个标签不超过 12 个字）。',
  '输出格式（严格遵守，不要输出 Markdown 代码块以外的任何说明文字）：',
  '{"tags":[{"questionId":"<题目id>","tag":"<标签词>"}]}',
  '全部题目均无合适标签时只输出 NONE。',
].join('\n');

// ==================== 题面注入文本（纯函数） ====================

const ENTITY_MAP: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ',
};

/** 题 HTML → 注入纯文本：含 data-tex 的标签整体转 $…$、剥其余标签、解码常见实体、折叠空白、超长截断 */
export function htmlToPromptText(html: string, maxChars: number = QUESTION_TEXT_MAX_CHARS): string {
  const withMath = html.replace(/<[^>]*\sdata-tex="([^"]*)"[^>]*>/g, (_m, tex: string) => `$${tex}$`);
  const noTags = withMath.replace(/<[^>]+>/g, ' ');
  const decoded = noTags.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITY_MAP[m] ?? m);
  const flat = decoded.replace(/\s+/g, ' ').trim();
  return flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat;
}

/** 批量题块：逐题一行【题目 <id>】<纯文本>（题目 id 是 AI 回指的唯一锚） */
export function questionPromptBlock(questions: Question[]): string {
  return questions.map((q) => `【题目 ${q.id}】${htmlToPromptText(q.stemHtml ?? q.content)}`).join('\n');
}

// ==================== 批量响应解析（JsonValue 结构守卫，无 any/unknown） ====================

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function asObject(value: JsonValue | undefined): { [key: string]: JsonValue } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value;
}

function nonEmptyString(value: JsonValue | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function truncate(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function stripFence(text: string): string {
  const match = /^```[A-Za-z]*\s*([\s\S]*?)\s*```$/.exec(text.trim());
  return match ? match[1]!.trim() : text.trim();
}

type ItemsExtract =
  | { kind: 'none' }
  | { kind: 'items'; items: JsonValue[] }
  | { kind: 'error'; message: string };

/** 顶层取建议数组：NONE 合法输出 → none；`{"suggestions":[…]}` 首选、裸数组容忍 */
function extractSuggestionItems(raw: string): ItemsExtract {
  const trimmed = raw.trim();
  if (trimmed.toUpperCase() === 'NONE') return { kind: 'none' };
  const body = stripFence(trimmed);
  if (body.toUpperCase() === 'NONE') return { kind: 'none' };
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(body) as JsonValue;
  } catch (err) {
    return { kind: 'error', message: `返回体不是合法 JSON：${err instanceof Error ? err.message : String(err)}` };
  }
  if (Array.isArray(parsed)) return { kind: 'items', items: parsed };
  const obj = asObject(parsed);
  if (obj && Array.isArray(obj['suggestions'])) return { kind: 'items', items: obj['suggestions'] };
  return { kind: 'error', message: '返回体缺 suggestions 数组（且不是建议数组本身）' };
}

// ==================== 打标解析（标签是自由词，不进锚点白名单；结构与题集二次核验） ====================

export interface TagParseDraft {
  source: 'validation' | 'unattributed';
  reason: string;
  raw: string;
}

export interface TagParseResult {
  none: boolean;
  parseError: string | null;
  tags: AiTagSuggestion[];
  drafts: TagParseDraft[];
  duplicates: string[];
}

/** 打标响应解析：结构守卫 + 题集归属核验 + 标签清洗（trim/折叠空白/限长）+ 去重（不静默） */
export function parseTagSuggestions(raw: string, questionIds: ReadonlySet<string>): TagParseResult {
  const text = raw.trim();
  const body = stripFence(text);
  if (text.toUpperCase() === 'NONE' || body.toUpperCase() === 'NONE') {
    return { none: true, parseError: null, tags: [], drafts: [], duplicates: [] };
  }
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(body) as JsonValue;
  } catch (err) {
    return {
      none: false, parseError: `返回体不是合法 JSON：${err instanceof Error ? err.message : String(err)}`,
      tags: [], drafts: [], duplicates: [],
    };
  }
  const obj = asObject(parsed);
  const items = Array.isArray(parsed) ? parsed : (obj && Array.isArray(obj['tags']) ? obj['tags'] : null);
  if (!items) {
    return { none: false, parseError: '返回体缺 tags 数组（且不是标签数组本身）', tags: [], drafts: [], duplicates: [] };
  }

  const tags: AiTagSuggestion[] = [];
  const drafts: TagParseDraft[] = [];
  const duplicates: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const entry = asObject(item);
    if (!entry || !nonEmptyString(entry['questionId']) || typeof entry['tag'] !== 'string') {
      drafts.push({ source: 'validation', reason: '标签条目不是对象或缺 questionId/tag 字段', raw: truncate(JSON.stringify(item) ?? String(item)) });
      continue;
    }
    const questionId = entry['questionId'];
    if (!questionIds.has(questionId)) {
      drafts.push({ source: 'unattributed', reason: `标签归属题号「${questionId}」不在本次题集内（无法归属，不写入）`, raw: truncate(JSON.stringify(item) ?? String(item)) });
      continue;
    }
    const cleaned = entry['tag'].replace(/\s+/g, ' ').trim();
    if (!cleaned) {
      drafts.push({ source: 'validation', reason: '标签为空或全空白', raw: truncate(JSON.stringify(item) ?? String(item)) });
      continue;
    }
    if (cleaned.length > TAG_MAX_CHARS) {
      drafts.push({ source: 'validation', reason: `标签超长（>${TAG_MAX_CHARS} 字）：${truncate(cleaned, 30)}`, raw: truncate(JSON.stringify(item) ?? String(item)) });
      continue;
    }
    const key = `${questionId}:${cleaned}`;
    if (seen.has(key)) {
      duplicates.push(key);
      continue;
    }
    seen.add(key);
    tags.push({ questionId, tag: cleaned });
  }
  return { none: false, parseError: null, tags, drafts, duplicates };
}

// ==================== 宿主 ====================

export interface AiSuggestHostDeps {
  /** 锚点快照（bank 只读服务；0024 交付面） */
  snapshots: AnchorSnapshotService;
  /** AI 调用（main.ts 注入 aiGateway.invoke；本层不触 Key，D-043） */
  invoke: (payload: AiInvokePayload) => Promise<AiInvokeResult>;
  /** 题面装载（main.ts 注入 bankService.getQuestion） */
  getQuestion: (id: string) => Promise<Question | null>;
}

export class AiSuggestHost {
  constructor(private deps: AiSuggestHostDeps) {}

  /** 锚点状态回执：空锚点禁放行的 UI 预检（无任何 AI 调用） */
  async anchorStatus(payload: AiAnchorStatusPayload): Promise<AiAnchorStatusResult> {
    const snapshot = await this.deps.snapshots.getAnchorSnapshot(payload.query);
    const truncated = truncateSnapshotToDepth(snapshot);
    const meta = this.buildMeta(snapshot, truncated, 0);
    return {
      status: snapshot.empty ? 'empty-anchor' : 'ok',
      reason: snapshot.empty ? (snapshot.emptyReason ?? '锚点为空：先采集字典/树') : null,
      meta,
      warnings: withTruncationNote(snapshot.warnings, meta),
    };
  }

  /** 挂树建议链（题库页批量为主场景；单题同样适用） */
  async suggestTree(payload: AiSuggestPayload): Promise<AiSuggestResult> {
    const { questions, meta, snapshot, truncated, warnings } = await this.prepare(payload);
    if (snapshot.empty) {
      return emptyAnchorResult(meta, snapshot, warnings);
    }

    const prompt = buildAnchorPrompt({
      snapshot: truncated,
      task: `${TREE_TASK}\n\n${questionPromptBlock(questions)}`,
    });
    const outcome = await this.deps.invoke(this.invokePayload(prompt));
    if (!outcome.ok) {
      return { status: 'unavailable', reason: outcome.error, meta, warnings, none: false, suggestions: [], tagSuggestions: [], drafts: [], duplicates: [], latencyMs: outcome.latencyMs };
    }
    return this.collectTreeSuggestions(outcome, questions.map((q) => q.id), truncated, meta, warnings);
  }

  /**
   * 0040（只增）：工作台草稿挂树建议——题面来源是**尚未入库**的草稿文本。
   * 与 suggestTree 同链同口径（快照 → ≤4 层截断 → buildAnchorPrompt → invoke → 0024 后置校验），
   * 唯一差别是不装载库内题目，草稿以一个稳定伪题号参与 evidence 归属校验。
   * 纯读面（P-07）：只产建议，点击采纳后的写入走既有通道。
   */
  async treeForDraft(payload: AiSuggestTreeForDraftPayload): Promise<AiSuggestResult> {
    const stemText = payload.stemText.trim();
    if (stemText === '') throw new Error('stemText 不能为空（至少一段题干文本）');
    // 0040 返工⑥：空学科给「下一步怎么做」，而不是让空快照回一句无信息量的「锚点为空」——
    // 学科是树侧过滤的必填定格（P-12），没有它锚点清单本来就是空的
    const subjectId = (payload.subjectId ?? '').trim();
    if (subjectId === '') throw new Error('挂树建议需要学科范围：请先选定学科（或直接用「换节点…」手动挂载）');
    const query: AnchorQuery = {
      subjectId,
      ...(payload.stage ? { stage: payload.stage } : {}),
    };
    const snapshot = await this.deps.snapshots.getAnchorSnapshot(query);
    const truncated = truncateSnapshotToDepth(snapshot);
    const meta = this.buildMeta(snapshot, truncated, 1);
    const warnings = withTruncationNote(snapshot.warnings, meta);
    if (snapshot.empty) return emptyAnchorResult(meta, snapshot, warnings);

    const prompt = buildAnchorPrompt({
      snapshot: truncated,
      task: `${TREE_TASK}\n\n【题目 ${DRAFT_QUESTION_ID}】${stemText}`,
    });
    const outcome = await this.deps.invoke(this.invokePayload(prompt));
    if (!outcome.ok) {
      return { status: 'unavailable', reason: outcome.error, meta, warnings, none: false, suggestions: [], tagSuggestions: [], drafts: [], duplicates: [], latencyMs: outcome.latencyMs };
    }
    return this.collectTreeSuggestions(outcome, [DRAFT_QUESTION_ID], truncated, meta, warnings);
  }

  /** 挂树响应 → 建议/草稿/去重（按 evidence 题目引用分桶过 0024 后置校验；suggestTree 与 treeForDraft 共用） */
  private collectTreeSuggestions(
    outcome: AiInvokeResult & { ok: true },
    requestedIds: string[],
    truncated: AnchorSnapshot,
    meta: AiSuggestMeta,
    warnings: string[],
  ): AiSuggestResult {
    const suggestions: AiTreeSuggestion[] = [];
    const drafts: AiSuggestDraft[] = [];
    const duplicates: string[] = [];
    const extract = extractSuggestionItems(outcome.content);
    if (extract.kind === 'none') {
      return this.done('ok', meta, warnings, { none: true }, outcome);
    }
    if (extract.kind === 'error') {
      drafts.push({ source: 'validation', reason: extract.message, raw: truncate(outcome.content) });
      return this.done('ok', meta, warnings, { drafts }, outcome);
    }

    // 逐题分组（跨题同名建议合法，0024 校验器的组内去重只应作用于同题）：
    // 先按 evidence 的题目引用分桶，再逐桶过 validateAnchorSuggestions。
    const requested = new Set(requestedIds);
    const buckets = new Map<string, JsonValue[]>();
    for (const id of requestedIds) buckets.set(id, []);
    for (const item of extract.items) {
      const owner = questionRefOf(item, requested);
      if (owner === null) {
        drafts.push({ source: 'unattributed', reason: 'evidence 缺题目引用或题号不在本次题集内（无法归属，不写入）', raw: truncate(JSON.stringify(item) ?? String(item)) });
        continue;
      }
      buckets.get(owner)!.push(item);
    }

    const labelOf = new Map(truncated.nodes.map((n) => [n.id, n.path.join(' > ')]));
    for (const [questionId, items] of buckets) {
      if (items.length === 0) continue;
      const validation = validateAnchorSuggestions(JSON.stringify({ suggestions: items }), truncated);
      duplicates.push(...validation.duplicates);
      for (const failure of validation.failures) {
        drafts.push(validationFailureDraft(failure));
      }
      for (const accepted of validation.accepted) {
        if (accepted.kind !== 'tree-node') {
          drafts.push({
            source: 'out-of-scope',
            reason: `${accepted.kind} 建议本单不写入（一期只落挂树；题型/难度建议待后续任务）`,
            raw: truncate(JSON.stringify(accepted)),
          });
          continue;
        }
        suggestions.push({
          questionId,
          kind: 'tree-node',
          targetId: accepted.targetId,
          targetLabel: labelOf.get(accepted.targetId) ?? accepted.targetId,
          ...(accepted.confidence !== undefined ? { confidence: accepted.confidence } : {}),
          evidenceSummary: accepted.evidence.map((ref) => evidenceLabel(ref, labelOf)).join(' · '),
        });
      }
    }
    return this.done('ok', meta, warnings, { suggestions, drafts, duplicates }, outcome);
  }

  /** 打标建议链（同链 reasoning；新标签「待治理」徽标由 UI 侧既有通道探测展示） */
  async suggestTags(payload: AiSuggestPayload): Promise<AiSuggestResult> {
    const { questions, meta, snapshot, truncated, warnings } = await this.prepare(payload);
    if (snapshot.empty) {
      return emptyAnchorResult(meta, snapshot, warnings);
    }

    const prompt = buildAnchorPrompt({
      snapshot: truncated,
      task: `${TAG_TASK}\n\n${questionPromptBlock(questions)}`,
    });
    const outcome = await this.deps.invoke(this.invokePayload(prompt));
    if (!outcome.ok) {
      return { status: 'unavailable', reason: outcome.error, meta, warnings, none: false, suggestions: [], tagSuggestions: [], drafts: [], duplicates: [], latencyMs: outcome.latencyMs };
    }

    const parsed = parseTagSuggestions(outcome.content, new Set(questions.map((q) => q.id)));
    const drafts: AiSuggestDraft[] = parsed.drafts.map((d) => ({ ...d }));
    return this.done('ok', meta, warnings, {
      none: parsed.none,
      tagSuggestions: parsed.tags,
      drafts,
      duplicates: parsed.duplicates,
    }, outcome, parsed.parseError);
  }

  // ---------- 内部 ----------

  /** 公共前置：题集装载去重（缺题即拒）→ 快照 → 截断 → meta/warnings（不发起 AI 调用） */
  private async prepare(payload: AiSuggestPayload) {
    const ids = [...new Set(payload.questionIds)];
    if (ids.length === 0) throw new Error('questionIds 不能为空（至少一道题）');
    const questions: Question[] = [];
    const missing: string[] = [];
    for (const id of ids) {
      const q = await this.deps.getQuestion(id);
      if (q) questions.push(q); else missing.push(id);
    }
    if (missing.length > 0) {
      throw new Error(`以下题目不存在或已删除：${missing.join('、')}`);
    }

    const snapshot = await this.deps.snapshots.getAnchorSnapshot(payload.query);
    const truncated = truncateSnapshotToDepth(snapshot);
    const meta = this.buildMeta(snapshot, truncated, questions.length);
    const warnings = withTruncationNote(snapshot.warnings, meta);
    return { questions, meta, snapshot, truncated, warnings };
  }

  private buildMeta(snapshot: AnchorSnapshot, truncated: AnchorSnapshot, questionCount: number): AiSuggestMeta {
    return {
      stage: snapshot.query.stage ?? '',
      subjectId: snapshot.query.subjectId,
      ...(snapshot.query.edition !== undefined ? { edition: snapshot.query.edition } : {}),
      questionCount,
      treeCount: snapshot.trees.length,
      totalNodeCount: snapshot.nodes.length,
      injectedNodeCount: truncated.nodes.length,
      truncatedNodeCount: snapshot.nodes.length - truncated.nodes.length,
      injectedTokens: estimateAnchorTokens(truncated),
    };
  }

  private invokePayload(prompt: { system: string; user: string }): AiInvokePayload {
    const messages: AiChatMessage[] = [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ];
    return {
      role: 'reasoning',
      messages,
      maxTokens: AI_SUGGEST_MAX_OUTPUT_TOKENS,
      temperature: INVOKE_TEMPERATURE,
      timeoutMs: INVOKE_TIMEOUT_MS,
      retries: INVOKE_RETRIES,
    };
  }

  private done<T extends Partial<AiSuggestResult>>(
    status: 'ok', meta: AiSuggestMeta, warnings: string[], parts: T,
    outcome: AiInvokeResult & { ok: true }, parseError?: string | null,
  ): AiSuggestResult {
    const drafts = 'drafts' in parts ? parts.drafts ?? [] : [];
    if (parseError) {
      drafts.push({ source: 'validation', reason: parseError, raw: truncate(outcome.content) });
    }
    return {
      status,
      reason: null,
      meta,
      warnings,
      none: ('none' in parts ? parts.none : false) ?? false,
      suggestions: 'suggestions' in parts ? parts.suggestions ?? [] : [],
      tagSuggestions: 'tagSuggestions' in parts ? parts.tagSuggestions ?? [] : [],
      drafts,
      duplicates: 'duplicates' in parts ? parts.duplicates ?? [] : [],
      latencyMs: outcome.latencyMs,
      ...(outcome.usage !== undefined ? { usage: outcome.usage } : {}),
    };
  }
}

// ==================== 小工具 ====================

/** evidence 里的题目引用：questionId ∈ 本次题集即归属（取首个命中）；无 → null */
function questionRefOf(item: JsonValue, requested: ReadonlySet<string>): string | null {
  const obj = asObject(item);
  if (!obj) return null;
  const evidence = obj['evidence'];
  if (!Array.isArray(evidence)) return null;
  for (const ref of evidence) {
    const entry = asObject(ref);
    if (!entry || entry['kind'] !== 'question') continue;
    const questionId = entry['questionId'];
    if (typeof questionId === 'string' && requested.has(questionId)) return questionId;
  }
  return null;
}

function validationFailureDraft(failure: AnchorValidationFailure): AiSuggestDraft {
  return {
    source: 'validation',
    reason: `${failure.reason}: ${failure.detail}`,
    raw: failure.raw,
    failure,
  };
}

function evidenceLabel(ref: import('../../shared/contracts/ai-anchor.js').EvidenceRef, labelOf: Map<string, string>): string {
  if (ref.kind === 'question') return `题目 ${ref.questionId}`;
  if (ref.kind === 'tree-node') return `节点 ${labelOf.get(ref.nodeId) ?? ref.nodeId}`;
  if (ref.kind === 'dict') return `字典 ${ref.entryId}`;
  return `数据行 ${ref.source}:${ref.rowId}`;
}

function withTruncationNote(warnings: string[], meta: AiSuggestMeta): string[] {
  if (meta.truncatedNodeCount <= 0) return [...warnings];
  return [
    ...warnings,
    `已按 D-050 ≤4 层截断：剔除 ${meta.truncatedNodeCount} 个深层节点（不进注入清单，AI 回指即被拦）`,
  ];
}

function emptyAnchorResult(meta: AiSuggestMeta, snapshot: AnchorSnapshot, warnings: string[]): AiSuggestResult {
  return {
    status: 'empty-anchor',
    reason: snapshot.emptyReason ?? '锚点为空：先采集字典/树（P-11：空锚点=必然编词）',
    meta,
    warnings,
    none: false,
    suggestions: [],
    tagSuggestions: [],
    drafts: [],
    duplicates: [],
    latencyMs: null,
  };
}
