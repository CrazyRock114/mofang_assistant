// 0024 P2：路径压缩序列化（P-11）——每行 `节点ID | 一级 > 二级 > 三级`，只给路径 + ID，不给描述。
//
// 目的是「不让 AI 编词」：清单里只有可回指的 ID 与结构，模型没有任何可发挥的措辞空间；
// 输出必须回指清单内 ID，清单外一律 NONE（prompt 侧硬边界见 prompt.ts，后置拦截见 validate.ts）。
// 纯函数、确定性输出（同一快照两次序列化逐字节一致，便于缓存与预算实测）。

import type { AnchorDictRef, AnchorNodeRef, AnchorSnapshot } from '../../shared/contracts/ai-anchor.js';

/** 节点腿：按树分组（树标题行仅标结构，不是锚点行） */
export function serializeAnchorNodes(snapshot: AnchorSnapshot): string {
  const lines: string[] = [];
  const byTree = new Map<string, AnchorNodeRef[]>();
  for (const node of snapshot.nodes) {
    const list = byTree.get(node.treeId);
    if (list) list.push(node); else byTree.set(node.treeId, [node]);
  }

  const emitted = new Set<string>();
  for (const tree of snapshot.trees) {
    const nodes = byTree.get(tree.id) ?? [];
    if (nodes.length === 0) continue;
    lines.push(`# 树：${tree.name}［${tree.type}${tree.stage ? `／${tree.stage}` : ''}］`);
    for (const node of nodes) {
      emitted.add(node.id);
      lines.push(`${node.id} | ${node.path.join(' > ')}`);
    }
  }

  // 兜底：treeId 不在 trees 清单内的节点也照出（不静默丢锚点）
  for (const node of snapshot.nodes) {
    if (emitted.has(node.id)) continue;
    lines.push(`${node.id} | ${node.path.join(' > ')}`);
  }
  return lines.join('\n');
}

function dictSection(title: string, entries: AnchorDictRef[]): string[] {
  if (entries.length === 0) return [];
  return [`# ${title}`, ...entries.map((e) => `${e.id} | ${e.label}`)];
}

/** 字典腿：按 kind 分节；空节不输出 */
export function serializeAnchorDict(snapshot: AnchorSnapshot): string {
  return [
    ...dictSection('学科', snapshot.dict.subjects),
    ...dictSection('题型', snapshot.dict.questionTypes),
    ...dictSection('难度', snapshot.dict.difficulties),
  ].join('\n');
}

/** 整篇：表头 + 树腿 + 字典腿（空快照下不产生任何锚点行） */
export function serializeAnchorSnapshot(snapshot: AnchorSnapshot): string {
  const parts = ['# 锚点清单（只能从下列 ID 中选取；清单外一律输出 NONE）'];
  const nodes = serializeAnchorNodes(snapshot);
  const dict = serializeAnchorDict(snapshot);
  if (nodes) parts.push(nodes);
  if (dict) parts.push(dict);
  return parts.join('\n');
}
