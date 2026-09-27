// 0024: AI 锚点契约（P-10~P-13）——锚点快照（字典并集）+ AI 建议 / evidence 硬契约 + 后置校验结果
//
// 分工（任务书 §一）：
//   - 快照导出实现：src/bank/anchor-snapshot-service.ts（只读查询，不写 operation_log）
//   - 注入组装（路径压缩序列化 / NONE 协议 prompt）与后置校验：src/recog/anchor/（纯函数，无 IO）
//   - 本文件纯类型 + 口径常量（src/shared 无逻辑）
//
// 口径锚点：P-10 字典并集（dict_entries + tree_nodes，不改 schema）、
// P-11 路径压缩 + 清单外一律 NONE + 后置校验、P-13 evidence 硬契约。
// 硬边界（用户原话「不能让 AI 编词」）：AI 输出必须回指清单内 ID，回指不上一律拦截，不静默丢弃。

import type { DictKind, TreeType } from './bank-types.js';

// ==================== 锚点快照（P-10 并集口径） ====================

/** 快照查询：学段-学科为人工选择（P-12），学科支持三种原文格式（归一同源 subject-normalize.ts） */
export interface AnchorQuery {
  /** 学段（trees.stage 精确匹配）；''/缺省 = 不限学段 */
  stage?: string;
  /**
   * 学科：dict id（'subj:physics'）/ 归一 code / 中文标签三种用户可选形态（归一同源 subject-normalize.ts）。
   * 站点 segment 原文（如 'physics2'）刻意不接受——'politics' 那类撞名会并错学科（见 subject-normalize.ts 歧义雷区）。
   */
  subjectId: string;
  /** 教材版本（trees.edition 精确匹配）；缺省 = 不限版本。指定时不排除「未标注版本」树 */
  edition?: string;
}

export interface AnchorTreeRef {
  id: string;
  name: string;
  type: TreeType;
  stage?: string;
  edition?: string;
  source?: string;
  /** 归一学科 code（快照过滤依据） */
  subjectKey: string;
}

/** 树节点锚点行：AI 回指的**唯一**树侧白名单键 = tree_nodes.id */
export interface AnchorNodeRef {
  id: string;
  treeId: string;
  /** 根→叶名称链（路径压缩用；不含任何描述文本） */
  path: string[];
}

/** 字典锚点行：AI 回指的字典侧白名单键 = dict_entries.id（只收归一行，站点同义行是「原文→标准」映射腿） */
export interface AnchorDictRef {
  id: string;
  kind: DictKind;
  code: string;
  label: string;
}

export interface AnchorDictGroups {
  /** 全量归一行：学科归一口径需要完整清单（不按当前学科收敛） */
  subjects: AnchorDictRef[];
  /** 题型无学科列，天然全量 */
  questionTypes: AnchorDictRef[];
  difficulties: AnchorDictRef[];
}

export interface AnchorSnapshot {
  query: AnchorQuery;
  trees: AnchorTreeRef[];
  nodes: AnchorNodeRef[];
  dict: AnchorDictGroups;
  /**
   * 显式空态（P-11）：true = 无任何可锚定内容 → 调用方**必须拒绝放行 AI**（空锚点=必然编词）。
   * 判据：树节点为空 **且** 字典锚（学科/题型/难度）全空；另有「未选择学科」定格失败态。
   */
  empty: boolean;
  /** 空态人读原因（含引导语）；非空态为 null */
  emptyReason: string | null;
  /** 部分缺失告警（非空态仍可放行，但需提示先跑采集）；无缺失为 [] */
  warnings: string[];
}

/** 快照导出服务（只读；不写 operation_log、不动 schema） */
export interface AnchorSnapshotService {
  getAnchorSnapshot(query: AnchorQuery): Promise<AnchorSnapshot>;
}

// ==================== AI 建议与 evidence 硬契约（P-13） ====================

/**
 * 建议落点类别：树节点（挂树/知识点）、题型、难度。
 * 标签（标签池）待 0027 建池后以只增方式扩展 kind，本期不放行无白名单的 kind。
 */
export type AISuggestionKind = 'tree-node' | 'question-type' | 'difficulty';

/**
 * 证据引用（硬契约）：AI 每条建议必须回指来源——知识点/章节 ID、题号、或数据行。
 * 校验口径见 src/recog/anchor/validate.ts：tree-node/dict 必须在快照白名单内；
 * question/data-row 由下游（0029/0030）按题号与数据行二次核验，本单只校验结构完整性。
 */
export type EvidenceRef =
  | { kind: 'tree-node'; nodeId: string }
  | { kind: 'dict'; entryId: string }
  | { kind: 'question'; questionId: string }
  | { kind: 'data-row'; source: string; rowId: string };

export interface AISuggestion {
  kind: AISuggestionKind;
  /** 落点 ID：tree-node → tree_nodes.id；question-type/difficulty → dict_entries.id。必须在快照白名单内 */
  targetId: string;
  /** 证据（P-13）：缺失或指向清单外 = 校验失败 */
  evidence: EvidenceRef[];
  /** 模型自评置信度 0~1；缺省=未给。非数值/越界按 bad-shape 拦截（不静默） */
  confidence?: number;
}

export type AnchorValidationFailureReason =
  /** 条目结构畸形（非对象 / kind 非法 / targetId 缺失 / confidence 非法） */
  | 'bad-shape'
  /** targetId 不在快照白名单内（编词拦截主路径） */
  | 'unknown-id'
  /** evidence 缺失或为空数组 */
  | 'missing-evidence'
  /** evidence 引用指向快照白名单外（或形态非法） */
  | 'evidence-out-of-anchor';

export interface AnchorValidationFailure {
  /** 原始条目序号（0 基；坏结构条目同样计数） */
  index: number;
  reason: AnchorValidationFailureReason;
  detail: string;
  /** 原始条目文本（截断 200 字符；0029 落草稿+高亮用） */
  raw: string;
}

export interface AnchorValidationResult {
  /** 整体是否可采信：parseError 为 null 且 failures 为空（NONE 亦为 ok） */
  ok: boolean;
  /** 模型明示「清单内无匹配」（合法输出，非失败） */
  none: boolean;
  /** 解析/结构错误（结构化失败，绝不抛裸异常）；null = 无 */
  parseError: string | null;
  /** 通过校验且去重后的建议 */
  accepted: AISuggestion[];
  /** 被拦项明细（不静默丢弃） */
  failures: AnchorValidationFailure[];
  /** 去重丢弃的 `${kind}:${targetId}`（不静默：仅供上层提示） */
  duplicates: string[];
}

// ==================== 注入组装（路径压缩 / NONE 协议） ====================

/**
 * 注入策略：'full' = 全量路径压缩（本单实装）；
 * 'layered' = 分层注入预案（先粗定位 → 展开子树），**接口在位、实现留待 V-6 实测超预算后启用**。
 */
export type AnchorInjectionStrategy = 'full' | 'layered';

export interface AnchorPromptOptions {
  snapshot: AnchorSnapshot;
  /** 任务说明（由上层 0029/0030 给，如「为下列题目建议挂树节点与题型」） */
  task: string;
  /** 缺省 'full' */
  strategy?: AnchorInjectionStrategy;
}

export interface AnchorPrompt {
  system: string;
  user: string;
}

/**
 * V-6 阈值口径（实现规划 §六）：单次注入的快照估算 token 超过此值即超标 → 启用分层注入预案。
 */
export const ANCHOR_TOKEN_BUDGET = 24000;
