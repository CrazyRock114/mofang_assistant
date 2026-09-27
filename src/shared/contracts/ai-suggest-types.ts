// 0029: AI 挂树/打标建议契约（D-050 修订口径：≤4 层单次注入 + NONE 协议 + 必人确认）
// 本文件为 0029 独占新建契约（0028 recog-run-types.ts 同款「新建契约文件=只增」范畴）。
//
// 分工（任务书 §一）：
//   - ≤4 层截断（纯函数）：src/recog/anchor/depth.ts（不改 0024 既有文件）
//   - 建议管线编排（快照→截断→prompt→invoke→后置校验→分组）：src/shell/ai/suggest-host.ts
//   - 人确认 UI 与写入：renderer（挂树回走 tree.linkQuestion、打标回走 bank.question.addTag）
//
// 铁律（P-07）：AI 只建议、必人确认——本契约只有「锚点状态回执 + 建议产出」读面，
// 不含任何直写库通道；树/标签的一切写入都由人确认后经既有通道完成。

import type { AnchorQuery, AnchorValidationFailure } from './ai-anchor.js';

/**
 * D-050②：一期注入限 ≤4 层（depth = 根→叶路径层数，根=1）。
 * 实测依据 r025 实测留痕：≤4 层全组合 ≤8.4k token（24k 预算 35% 余量）；
 * 如需调整层数须新决策修订 D-050（任务书 §三.1）。
 */
export const ANCHOR_INJECTION_MAX_DEPTH = 4;

/** 建议范围入参：题集 + 学段-学科定格（P-12；学科三形态同 AnchorQuery.subjectId） */
export interface AiSuggestPayload {
  /** 非空、全库存在的题目 id 集（主进程逐一核验，缺一即 IPC 拒绝） */
  questionIds: string[];
  query: AnchorQuery;
}

/** 锚点状态回执入参（空锚点禁放行的 UI 预检；不做任何 AI 调用） */
export type AiAnchorStatusPayload = Pick<AiSuggestPayload, 'query'>;

/**
 * 建议链状态：ok = 建议产出；empty-anchor = 空锚点（P-11 拒绝放行，引导先采集）；
 * unavailable = AI 不可用（未配置 Key/未启用/网络失败——P-3 要求明示原因而非隐藏）。
 */
export type AiSuggestStatus = 'ok' | 'empty-anchor' | 'unavailable';

/** 注入口径回执（UI 展示 + 探针断言用；与 r025-tree-stats 口径对齐） */
export interface AiSuggestMeta {
  stage: string;
  subjectId: string;
  edition?: string;
  /** 参与建议的题数（去重后） */
  questionCount: number;
  /** 该学段-学科非归档树数（0039 收敛后每学段×学科一套权威树） */
  treeCount: number;
  /** 全深节点数（截断前） */
  totalNodeCount: number;
  /** ≤4 层截断后实际注入节点数 */
  injectedNodeCount: number;
  /** 截断剔除节点数 = totalNodeCount - injectedNodeCount */
  truncatedNodeCount: number;
  /** 注入文本 token 估算（保守口径，0024 budget.ts；对照 D-050 的 8.4k 实测口径） */
  injectedTokens: number;
}

/** 单题挂树建议（0024 后置校验已通过的 accepted 条目，按题归属后分组） */
export interface AiTreeSuggestion {
  questionId: string;
  /** 一期只出 tree-node（题型/难度类属 out-of-scope 落草稿，见 AiSuggestDraft） */
  kind: 'tree-node';
  /** tree_nodes.id（已对 ≤4 层截断后白名单核验） */
  targetId: string;
  /** 展示路径（根→叶，来自注入清单，如「力学 > 摩擦力」） */
  targetLabel: string;
  /** 模型自评置信度 0~1；缺省=模型未给 */
  confidence?: number;
  /** evidence 人读摘要（如「题目 q1 · 节点 力学>摩擦力」） */
  evidenceSummary: string;
}

/** 单题打标建议（标签为自由词，不进锚点白名单；新标签「待治理」徽标由 UI 判定展示） */
export interface AiTagSuggestion {
  questionId: string;
  /** 已清洗（trim/去首尾空白）；超长/空串不进本列表，落 drafts */
  tag: string;
}

/**
 * 被拦/未采信条目——落草稿高亮（任务书 P-3：不静默丢弃），仅展示、绝不写入。
 * source 口径：validation=0024 校验器拦截（含解析失败整篇）；unattributed=无法归属到入参题集
 * （evidence 缺题目引用或 questionId 不在本次题集）；out-of-scope=非本单写入类别（题型/难度建议）。
 */
export interface AiSuggestDraft {
  source: 'validation' | 'unattributed' | 'out-of-scope';
  reason: string;
  /** 原始条目文本（截断 200 字符） */
  raw: string;
  /** validator 拦截时的结构化失败明细（parseError/unattributed/out-of-scope 无） */
  failure?: AnchorValidationFailure;
}

/** 锚点状态回执（ai.suggest.anchorStatus）：UI 据此禁放行 + 展示注入口径 */
export interface AiAnchorStatusResult {
  status: 'ok' | 'empty-anchor';
  /** empty-anchor 时的人读引导语（P-11 口径） */
  reason: string | null;
  meta: AiSuggestMeta;
  /** 快照部分缺失告警（0024 warnings 原样透传 + 截断提示） */
  warnings: string[];
}

/** 建议链统一结果（tree/tags 两通道同构；未请求的数组恒为空） */
export interface AiSuggestResult {
  status: AiSuggestStatus;
  /** status≠ok 时的人读原因；ok 态为 null */
  reason: string | null;
  meta: AiSuggestMeta;
  /** 快照部分缺失告警（透传 + 截断提示） */
  warnings: string[];
  /** 模型明示清单内无匹配（合法输出，非失败） */
  none: boolean;
  suggestions: AiTreeSuggestion[];
  tagSuggestions: AiTagSuggestion[];
  drafts: AiSuggestDraft[];
  /** 去重丢弃的 `${kind}:${targetId}` / 打标 `${questionId}:${tag}`（不静默） */
  duplicates: string[];
  /** AI 往返耗时（unavailable 也可能有值）；未发起调用为 null */
  latencyMs: number | null;
  /** 网关回传的 token 用量（如实透传） */
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}
