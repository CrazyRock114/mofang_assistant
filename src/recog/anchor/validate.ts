// 0024 P2：后置校验器（P-11「不让 AI 编词」的拦截点）——纯函数、无 IO、不抛裸异常
//
// 拦截口径（任务书 §四对抗用例）：
//   清单外 ID → unknown-id；evidence 缺失/为空 → missing-evidence；evidence 越界或形态非法 → evidence-out-of-anchor；
//   条目结构畸形（非对象 / kind 非法 / targetId 缺失 / confidence 非法）→ bad-shape；
//   非 JSON / 缺 suggestions → parseError（结构化失败，调用方按「不可采信」处理，不是抛异常）。
//   NONE = 合法输出（模型明示清单内无匹配），ok=true。
// 被拦项一律出明细（index/reason/detail/raw），交给上层落草稿+高亮（0029），本单不做 UI。

import type {
  AISuggestion, AISuggestionKind, AnchorSnapshot, AnchorValidationFailure,
  AnchorValidationFailureReason, AnchorValidationResult, EvidenceRef,
} from '../../shared/contracts/ai-anchor.js';
import { NONE_TOKEN } from './prompt.js';

/** 解析中间形态：JSON.parse 的结果按结构逐层守卫，不引入 any/unknown 断言 */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const TARGET_KINDS: readonly AISuggestionKind[] = ['tree-node', 'question-type', 'difficulty'];

interface IdSets {
  nodes: Set<string>;
  dict: Set<string>;
}

type ItemParse =
  | { ok: true; suggestion: AISuggestion }
  | { ok: false; reason: AnchorValidationFailureReason; detail: string };

function asObject(value: JsonValue | undefined): { [key: string]: JsonValue } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value;
}

function isTargetKind(value: JsonValue | undefined): value is AISuggestionKind {
  return typeof value === 'string' && (TARGET_KINDS as readonly string[]).includes(value);
}

function nonEmptyString(value: JsonValue | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function truncate(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function toRaw(item: JsonValue): string {
  return truncate(typeof item === 'string' ? item : JSON.stringify(item) ?? String(item));
}

/** 剥离 ```json ... ``` 代码块（模型常见输出习惯） */
function stripFence(text: string): string {
  const match = /^```[A-Za-z]*\s*([\s\S]*?)\s*```$/.exec(text.trim());
  return match ? match[1]!.trim() : text.trim();
}

function idSetsOf(snapshot: AnchorSnapshot): IdSets {
  return {
    nodes: new Set(snapshot.nodes.map((n) => n.id)),
    dict: new Set([
      ...snapshot.dict.subjects, ...snapshot.dict.questionTypes, ...snapshot.dict.difficulties,
    ].map((e) => e.id)),
  };
}

/** 该 kind 的落点白名单：树节点只认 tree_nodes.id；题型/难度各认自己那一节字典 ID */
function whitelistOf(snapshot: AnchorSnapshot, kind: AISuggestionKind): Set<string> {
  if (kind === 'tree-node') return new Set(snapshot.nodes.map((n) => n.id));
  if (kind === 'question-type') return new Set(snapshot.dict.questionTypes.map((e) => e.id));
  return new Set(snapshot.dict.difficulties.map((e) => e.id));
}

/** evidence 单条：结构非法或指向清单外 → null（原因由调用方统一归为越界） */
function parseEvidence(value: JsonValue, sets: IdSets): EvidenceRef | null {
  const obj = asObject(value);
  if (!obj) return null;
  const kind = obj['kind'];
  if (kind === 'tree-node') {
    const nodeId = obj['nodeId'];
    if (!nonEmptyString(nodeId) || !sets.nodes.has(nodeId)) return null;
    return { kind: 'tree-node', nodeId };
  }
  if (kind === 'dict') {
    const entryId = obj['entryId'];
    if (!nonEmptyString(entryId) || !sets.dict.has(entryId)) return null;
    return { kind: 'dict', entryId };
  }
  if (kind === 'question') {
    const questionId = obj['questionId'];
    if (!nonEmptyString(questionId)) return null;
    return { kind: 'question', questionId };
  }
  if (kind === 'data-row') {
    const source = obj['source'];
    const rowId = obj['rowId'];
    if (!nonEmptyString(source) || !nonEmptyString(rowId)) return null;
    return { kind: 'data-row', source, rowId };
  }
  return null;
}

function parseItem(item: JsonValue, snapshot: AnchorSnapshot, sets: IdSets): ItemParse {
  const obj = asObject(item);
  if (!obj) return { ok: false, reason: 'bad-shape', detail: '建议项不是对象' };

  const kind = obj['kind'];
  if (!isTargetKind(kind)) {
    return { ok: false, reason: 'bad-shape', detail: `kind 非法或缺失：${JSON.stringify(obj['kind'] ?? null)}` };
  }

  const targetId = obj['targetId'];
  if (!nonEmptyString(targetId)) {
    return { ok: false, reason: 'bad-shape', detail: `${kind} 建议缺 targetId` };
  }

  const confidenceRaw = obj['confidence'];
  let confidence: number | undefined;
  if (confidenceRaw !== undefined && confidenceRaw !== null) {
    if (typeof confidenceRaw !== 'number' || !Number.isFinite(confidenceRaw) || confidenceRaw < 0 || confidenceRaw > 1) {
      return { ok: false, reason: 'bad-shape', detail: `confidence 须为 0~1 数值，实得 ${JSON.stringify(confidenceRaw)}` };
    }
    confidence = confidenceRaw;
  }

  // 编词拦截主路径：先核落点 ID，再核 evidence（保证「伪造 ID」优先报 unknown-id）
  const whitelist = whitelistOf(snapshot, kind);
  if (!whitelist.has(targetId)) {
    return {
      ok: false, reason: 'unknown-id',
      detail: `${kind} 建议 ID「${targetId}」不在锚点清单内（白名单 ${whitelist.size} 项）`,
    };
  }

  const evidenceRaw = obj['evidence'];
  if (!Array.isArray(evidenceRaw) || evidenceRaw.length === 0) {
    return { ok: false, reason: 'missing-evidence', detail: `${kind}:${targetId} 缺 evidence（P-13 硬契约）` };
  }
  const evidence: EvidenceRef[] = [];
  for (const raw of evidenceRaw) {
    const parsed = parseEvidence(raw, sets);
    if (!parsed) {
      return {
        ok: false, reason: 'evidence-out-of-anchor',
        detail: `${kind}:${targetId} 的 evidence 形态非法或指向清单外：${truncate(JSON.stringify(raw) ?? '')}`,
      };
    }
    evidence.push(parsed);
  }

  return {
    ok: true,
    suggestion: { kind, targetId, evidence, ...(confidence !== undefined ? { confidence } : {}) },
  };
}

function parseErrorResult(message: string): AnchorValidationResult {
  return { ok: false, none: false, parseError: message, accepted: [], failures: [], duplicates: [] };
}

/** 顶层取建议数组：`{"suggestions":[…]}` 为首选，裸数组容忍（模型常见） */
function extractItems(parsed: JsonValue): JsonValue[] | null {
  if (Array.isArray(parsed)) return parsed;
  const obj = asObject(parsed);
  if (obj && Array.isArray(obj['suggestions'])) return obj['suggestions'];
  return null;
}

/**
 * 校验 AI 返回体：`raw` 为模型原始文本，`snapshot` 为本次注入的锚点快照。
 * 任何情况都返回结构（不抛）：解析失败走 parseError，条目失败走 failures 明细。
 */
export function validateAnchorSuggestions(raw: string, snapshot: AnchorSnapshot): AnchorValidationResult {
  const text = raw.trim();
  if (text.toUpperCase() === NONE_TOKEN) {
    return { ok: true, none: true, parseError: null, accepted: [], failures: [], duplicates: [] };
  }

  const body = stripFence(text);
  if (body.toUpperCase() === NONE_TOKEN) {
    return { ok: true, none: true, parseError: null, accepted: [], failures: [], duplicates: [] };
  }

  let parsed: JsonValue;
  try {
    parsed = JSON.parse(body) as JsonValue;
  } catch (err) {
    return parseErrorResult(`返回体不是合法 JSON：${err instanceof Error ? err.message : String(err)}`);
  }

  const items = extractItems(parsed);
  if (!items) return parseErrorResult('返回体缺 suggestions 数组（且不是建议数组本身）');

  const sets = idSetsOf(snapshot);
  const accepted: AISuggestion[] = [];
  const failures: AnchorValidationFailure[] = [];
  const duplicates: string[] = [];
  const seen = new Set<string>();

  items.forEach((item, index) => {
    const result = parseItem(item, snapshot, sets);
    if (!result.ok) {
      failures.push({ index, reason: result.reason, detail: result.detail, raw: toRaw(item) });
      return;
    }
    const key = `${result.suggestion.kind}:${result.suggestion.targetId}`;
    if (seen.has(key)) {
      duplicates.push(key);
      return;
    }
    seen.add(key);
    accepted.push(result.suggestion);
  });

  return { ok: failures.length === 0, none: false, parseError: null, accepted, failures, duplicates };
}
