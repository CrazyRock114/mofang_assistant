// 0029 P1：≤4 层截断（D-050②）——注入组装前的快照视图收窄（纯函数、无 IO、不改 0024 既有文件）。
//
// 语义：截断后的快照是 AI 的「整个世界」——既作为 buildAnchorPrompt 的注入清单，
// 也作为 validateAnchorSuggestions 的回指白名单。深层节点不注入，回指即 unknown-id，
// 这是「≤4 层口径」的结构性保证（不靠调用方自觉）。
// trees/dict/query 原样保留：空树仍列出（序列化侧空树不产行）；字典锚不受层数影响；
// empty 标志沿用全量快照口径（字典锚仍在则不是「必然编词」的空锚点，树类建议自然回落 NONE）。

import type { AnchorSnapshot } from '../../shared/contracts/ai-anchor.js';
import { ANCHOR_INJECTION_MAX_DEPTH } from '../../shared/contracts/ai-suggest-types.js';

/**
 * 按路径层数截断快照节点（depth = path.length，根=1；超过 maxDepth 的节点不进注入清单）。
 * 不变异入参；同快照同参数输出逐字段确定。
 */
export function truncateSnapshotToDepth(
  snapshot: AnchorSnapshot,
  maxDepth: number = ANCHOR_INJECTION_MAX_DEPTH,
): AnchorSnapshot {
  return { ...snapshot, nodes: snapshot.nodes.filter((n) => n.path.length <= maxDepth) };
}
