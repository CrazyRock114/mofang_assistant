/**
 * 0039 P1：树收敛（每学段×学科一套权威树）—— 纯计划 + 单事务落库
 *
 * 背景（D-050① / R-025）：采集按来源立树，实库 32 个（学段×学科）组合里 29 个多树并存
 * （203 棵 / 34,201 节点）。AI 锚点（0024/0029）与题库页都要求「每科一套权威树」，
 * 故本模块做一次性数据治理：每组合选定权威树（知识树优先取最大；无知识树时最大教材树升格），
 * 冗余树**按路径匹配**把挂链重挂到权威树同名节点，并整体软删（改名加后缀，不物理删）。
 *
 * 归档表示法（无 schema 变更口径）：`trees.name` 追加 `（已归档·0039）` 后缀——
 * trees 表无 status 列，任务书 §二 明确「预期无迁移，如确需 schema 变更停下申报」；
 * 后缀不破坏站名前缀（siteOfTree 按「菁优网·/组卷网·」定站仍可用），
 * 原名可无损还原（archivedNameOf 幂等、isArchivedTreeName 判定），读侧统一经
 * `listTrees`（默认排除归档）/ 本模块谓词过滤。
 *
 * 采集侧归一（P2）的机制：重挂同时把 `tree_source_map` 的 node_id 改指权威树节点，
 * 于是 `resolveSourceNode(站点节点)` 自然收敛到权威树（建树幂等导入不再另立树）；
 * 路径无同名节点的映射保留原样（不猜不并），采集挂树时显式 warning 跳过（见 capture/ingest.ts）。
 *
 * 幂等：已归档树不参与判定（改名后缀即状态），二次重跑全零变更。
 * 留痕：落库走 operation_log（tree.consolidate，含分组决策与孤儿清单）。
 * 不猜不并：缺学段 / 学科不可解析的树不并组，列 ungrouped 交人工（0027 树治理）。
 */

import type { SQLOutputValue } from 'node:sqlite';

import type {
  DictEntry, QuestionNodeLink, Tree, TreeNode, TreeType,
} from '../shared/contracts/bank-types.js';
import type { Database } from './db.js';
import { OperationLogger } from './operation-log.js';
import { resolveSubjectKey, siteOfTree } from './subject-normalize.js';
import { archivedNameOf, isArchivedTreeName, TREE_ARCHIVE_SUFFIX } from './tree-archive.js';

// 归档名约定在纯模块（tree-archive.ts，零依赖）——本模块与 mock/读取方共享同一谓词
export { TREE_ARCHIVE_SUFFIX, archivedNameOf, isArchivedTreeName } from './tree-archive.js';

type SqlRow = Record<string, SQLOutputValue>;

function sqlString(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`树收敛取数异常：列 ${key} 非文本（实得 ${typeof value}）`);
  return value;
}

function sqlStringOrNull(row: SqlRow, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' ? value : null;
}

function sqlNumber(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value !== 'number') throw new Error(`树收敛取数异常：列 ${key} 非数值（实得 ${typeof value}）`);
  return value;
}

/** 节点 → 根路径（父不在本树 / 悬空父 = 根；环守卫不死循环不丢节点） */

// ---------- 权威树判定 ----------

export interface TreeWithNodeCount {
  tree: Tree;
  nodeCount: number;
}

/** 判定依据：唯一树 / 知识树取最大 / 教材树升格（无知识树可升） */
export type AuthoritativeReason = 'only' | 'knowledge-largest' | 'textbook-promoted';

export interface AuthoritativePick {
  tree: Tree;
  nodeCount: number;
  reason: AuthoritativeReason;
}

/**
 * 每（学段×学科）选定权威树：知识树优先取节点最多者；无知识树时最大教材树升格（type 不改写——
 * 树性质仍是教材树，只是本组权威）。并列时按 createdAt → id 定序，结果与入参顺序无关（可重跑）。
 */
export function pickAuthoritativeTree(candidates: TreeWithNodeCount[]): AuthoritativePick | null {
  if (candidates.length === 0) return null;
  const knowledge = candidates.filter((c) => c.tree.type === 'knowledge');
  const pool = knowledge.length > 0 ? knowledge : candidates;
  const best = pool.slice().sort((a, b) => (
    (b.nodeCount - a.nodeCount)
    || a.tree.createdAt.localeCompare(b.tree.createdAt)
    || a.tree.id.localeCompare(b.tree.id)
  ))[0];
  const reason: AuthoritativeReason = candidates.length === 1
    ? 'only'
    : knowledge.length > 0 ? 'knowledge-largest' : 'textbook-promoted';
  return { tree: best.tree, nodeCount: best.nodeCount, reason };
}

// ---------- 计划 ----------

export interface TreeConsolidationInput {
  /** 全量树（含已归档——已归档不参与判定，保证幂等） */
  trees: Tree[];
  nodesByTree: Map<string, TreeNode[]>;
  links: QuestionNodeLink[];
  sourceMappings: Array<{ nodeId: string; site: string; siteNodeId: string }>;
  dictEntries: DictEntry[];
}

export interface TreeGroupPlan {
  stage: string;
  subjectKey: string;
  authoritativeTreeId: string;
  authoritativeName: string;
  authoritativeType: TreeType;
  authoritativeNodeCount: number;
  reason: AuthoritativeReason;
  redundant: Array<{ id: string; name: string; type: TreeType; nodeCount: number }>;
}

export interface TreeNodeRemap {
  /** 冗余树（被归档方） */
  treeId: string;
  treeName: string;
  fromNodeId: string;
  toNodeId: string;
  /** 命中路径（根→节点名称序列，供人工逐条核对） */
  path: string[];
  /** 该节点上的挂链数（重挂后被搬走） */
  linkCount: number;
}

export interface TreeOrphanNode {
  treeId: string;
  treeName: string;
  nodeId: string;
  path: string[];
  /** 该节点上的挂链题号（保留原链，交人工/0027 指认，不静默丢） */
  questionIds: string[];
  /** 该节点上的站点源映射（保留原样，采集侧命中时警告跳过） */
  sourceMappings: Array<{ site: string; siteNodeId: string }>;
}

export interface TreeConsolidationSummary {
  treeCount: number;
  groupCount: number;
  keptTrees: number;
  archivedTrees: number;
  remappedNodes: number;
  /** 路径在权威树无同名节点而未重挂的节点数（含无挂链者；它们只在报告里计数） */
  unmatchedNodes: number;
  orphanNodes: number;
  orphanLinks: number;
  ungroupedTrees: number;
}

export type UngroupedReason = '缺学段' | '学科不可解析';

export interface TreeConsolidationPlan {
  groups: TreeGroupPlan[];
  /** 不并组的树（不猜不并；已归档树不在内——它们已收敛完毕） */
  ungrouped: Array<{ id: string; name: string; reason: UngroupedReason }>;
  remaps: TreeNodeRemap[];
  orphans: TreeOrphanNode[];
  summary: TreeConsolidationSummary;
}

/** 节点 → 根路径（父不在本树 / 悬空父 = 根；环守卫不死循环不丢节点） */
function buildPathIndex(nodes: TreeNode[]): Map<string, string[]> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const cache = new Map<string, string[]>();
  const visiting = new Set<string>();
  const pathOf = (node: TreeNode): string[] => {
    const cached = cache.get(node.id);
    if (cached) return cached;
    if (visiting.has(node.id)) return [node.name]; // 数据环：以自身为根
    visiting.add(node.id);
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    const path = parent ? [...pathOf(parent), node.name] : [node.name];
    visiting.delete(node.id);
    cache.set(node.id, path);
    return path;
  };
  const out = new Map<string, string[]>();
  for (const node of nodes) out.set(node.id, pathOf(node));
  return out;
}

/**
 * 构建收敛计划（纯函数，不碰 DB）：分组 → 选权威 → 逐节点路径匹配（重挂/孤儿）。
 * 已归档树不参与；缺学段或学科不可解析的树不进任何组（ungrouped）。
 */
export function buildTreeConsolidationPlan(input: TreeConsolidationInput): TreeConsolidationPlan {
  const { trees, nodesByTree, links, sourceMappings, dictEntries } = input;

  const linksByNode = new Map<string, string[]>();
  for (const link of links) {
    const list = linksByNode.get(link.nodeId);
    if (list) list.push(link.questionId); else linksByNode.set(link.nodeId, [link.questionId]);
  }
  const mappingsByNode = new Map<string, Array<{ site: string; siteNodeId: string }>>();
  for (const m of sourceMappings) {
    const list = mappingsByNode.get(m.nodeId);
    const entry = { site: m.site, siteNodeId: m.siteNodeId };
    if (list) list.push(entry); else mappingsByNode.set(m.nodeId, [entry]);
  }

  const active = trees.filter((t) => !isArchivedTreeName(t.name));
  const byGroup = new Map<string, { stage: string; subjectKey: string; trees: Tree[] }>();
  const ungrouped: TreeConsolidationPlan['ungrouped'] = [];
  for (const tree of active) {
    const stage = (tree.stage ?? '').trim();
    if (!stage) { ungrouped.push({ id: tree.id, name: tree.name, reason: '缺学段' }); continue; }
    // 学科分组与题库页/锚点同源（站点行优先，不猜不并）
    const subjectKey = resolveSubjectKey(tree.subjectId, siteOfTree(tree.source, tree.name), dictEntries);
    if (!subjectKey) { ungrouped.push({ id: tree.id, name: tree.name, reason: '学科不可解析' }); continue; }
    const key = `${stage}\u0000${subjectKey}`;
    const bucket = byGroup.get(key);
    if (bucket) bucket.trees.push(tree); else byGroup.set(key, { stage, subjectKey, trees: [tree] });
  }

  const groups: TreeGroupPlan[] = [];
  const remaps: TreeNodeRemap[] = [];
  const orphans: TreeOrphanNode[] = [];
  let keptTrees = 0;
  let archivedTrees = 0;
  let remappedNodes = 0;
  let unmatchedNodes = 0;

  for (const { stage, subjectKey, trees: groupTrees } of byGroup.values()) {
    const candidates = groupTrees.map((tree) => ({ tree, nodeCount: (nodesByTree.get(tree.id) ?? []).length }));
    const pick = pickAuthoritativeTree(candidates);
    if (!pick) continue;
    keptTrees += 1;
    const redundant = candidates.filter((c) => c.tree.id !== pick.tree.id);
    groups.push({
      stage,
      subjectKey,
      authoritativeTreeId: pick.tree.id,
      authoritativeName: pick.tree.name,
      authoritativeType: pick.tree.type,
      authoritativeNodeCount: pick.nodeCount,
      reason: pick.reason,
      redundant: redundant.map((c) => ({ id: c.tree.id, name: c.tree.name, type: c.tree.type, nodeCount: c.nodeCount })),
    });

    // 权威树路径索引（UNIQUE(tree_id,parent_id,name) 保证同树全路径唯一）
    const authPathIndex = buildPathIndex(nodesByTree.get(pick.tree.id) ?? []);
    const authByPath = new Map<string, string>();
    for (const [nodeId, path] of authPathIndex) authByPath.set(path.join('\u0000'), nodeId);

    for (const red of redundant) {
      archivedTrees += 1;
      const redNodes = nodesByTree.get(red.tree.id) ?? [];
      const redPathIndex = buildPathIndex(redNodes);
      for (const node of redNodes) {
        const path = redPathIndex.get(node.id) ?? [node.name];
        const targetId = authByPath.get(path.join('\u0000'));
        const questionIds = linksByNode.get(node.id) ?? [];
        if (targetId) {
          remaps.push({
            treeId: red.tree.id,
            treeName: red.tree.name,
            fromNodeId: node.id,
            toNodeId: targetId,
            path,
            linkCount: questionIds.length,
          });
          remappedNodes += 1;
          continue;
        }
        unmatchedNodes += 1;
        if (questionIds.length > 0) {
          orphans.push({
            treeId: red.tree.id,
            treeName: red.tree.name,
            nodeId: node.id,
            path,
            questionIds,
            sourceMappings: mappingsByNode.get(node.id) ?? [],
          });
        }
      }
    }
  }

  groups.sort((a, b) => a.stage.localeCompare(b.stage, 'zh') || a.subjectKey.localeCompare(b.subjectKey));
  return {
    groups,
    ungrouped,
    remaps,
    orphans,
    summary: {
      treeCount: trees.length,
      groupCount: groups.length,
      keptTrees,
      archivedTrees,
      remappedNodes,
      unmatchedNodes,
      orphanNodes: orphans.length,
      orphanLinks: orphans.reduce((sum, o) => sum + o.questionIds.length, 0),
      ungroupedTrees: ungrouped.length,
    },
  };
}

// ---------- 落库 ----------

export interface TreeConsolidationReport {
  keptTrees: number;
  archivedTrees: number;
  remappedNodes: number;
  /** 实搬走的旧链数（删除计数） */
  movedLinks: number;
  /** 目标节点已有同题同链 → 去重丢弃数（未丢数据，仅合并重复挂接） */
  mergedLinks: number;
  sourceMappingsRepointed: number;
  orphanNodes: number;
  orphanLinks: number;
  /** 孤儿清单（路径无同名节点的挂链，保留原链交人工指认） */
  orphans: TreeOrphanNode[];
}

/**
 * 落库（单事务 + operation_log 留痕）：
 *   1. 重挂：旧链搬到权威树同名节点（同链去重）、`tree_source_map` 重指、旧链删除；
 *   2. 归档：冗余树改名加后缀（软删，不物理删——节点/挂链/映射俱在）；
 *   3. 孤儿节点不动（挂链与映射原样保留，仅进报告与日志）。
 * 幂等：对已收敛库（全零计划）执行零变更，仍留一条 operation_log。
 */
export function applyTreeConsolidationPlan(db: Database, plan: TreeConsolidationPlan): TreeConsolidationReport {
  const logger = new OperationLogger(db);
  const report: TreeConsolidationReport = {
    keptTrees: plan.summary.keptTrees,
    archivedTrees: 0,
    remappedNodes: 0,
    movedLinks: 0,
    mergedLinks: 0,
    sourceMappingsRepointed: 0,
    orphanNodes: plan.summary.orphanNodes,
    orphanLinks: plan.summary.orphanLinks,
    orphans: plan.orphans,
  };
  const logId = logger.logStart(
    'tree.consolidate',
    `树收敛：${plan.summary.groupCount} 组 / 归档 ${plan.summary.archivedTrees} 棵冗余树 / 重挂 ${plan.summary.remappedNodes} 节点`,
    {
      summary: plan.summary,
      groups: plan.groups.map((g) => ({
        stage: g.stage,
        subjectKey: g.subjectKey,
        authoritative: { id: g.authoritativeTreeId, name: g.authoritativeName, nodeCount: g.authoritativeNodeCount, reason: g.reason },
        redundant: g.redundant.map((r) => ({ id: r.id, name: r.name, type: r.type, nodeCount: r.nodeCount })),
      })),
      ungrouped: plan.ungrouped,
      orphans: plan.orphans,
    },
  );
  try {
    db.transaction(() => {
      const selectLinks = db.prepare('SELECT question_id FROM question_node_links WHERE node_id = ?');
      const insertLink = db.prepare('INSERT OR IGNORE INTO question_node_links (question_id, node_id) VALUES (?, ?)');
      const deleteLinks = db.prepare('DELETE FROM question_node_links WHERE node_id = ?');
      const repointMapping = db.prepare('UPDATE tree_source_map SET node_id = ? WHERE node_id = ?');
      const renameTree = db.prepare('UPDATE trees SET name = ? WHERE id = ?');

      for (const remap of plan.remaps) {
        const rows = selectLinks.all(remap.fromNodeId);
        for (const row of rows) {
          const inserted = insertLink.run(sqlString(row, 'question_id'), remap.toNodeId);
          if (Number(inserted.changes) === 0) report.mergedLinks += 1;
        }
        report.movedLinks += Number(deleteLinks.run(remap.fromNodeId).changes);
        report.sourceMappingsRepointed += Number(repointMapping.run(remap.toNodeId, remap.fromNodeId).changes);
        report.remappedNodes += 1;
      }
      for (const group of plan.groups) {
        for (const red of group.redundant) {
          report.archivedTrees += Number(renameTree.run(archivedNameOf(red.name), red.id).changes);
        }
      }
    });
    logger.logSuccess(logId, report.archivedTrees + report.remappedNodes + report.movedLinks);
    return report;
  } catch (error) {
    logger.logFailure(logId, error as Error);
    throw error;
  }
}

export type TreeRestoreSkipReason = '未找到' | '未归档' | '重复请求';

export interface TreeRestoreReport {
  restored: number;
  /** 恢复后的树（原名/类型/学段/学科） */
  trees: Array<{ id: string; name: string; type: TreeType; stage?: string; subjectId?: string }>;
  /** 未恢复的请求项（不静默忽略） */
  skipped: Array<{ key: string; reason: TreeRestoreSkipReason }>;
}

/**
 * 归档恢复（树收敛的回归通路）：剥除归档后缀 → 树重新可见（listTrees/锚点清单/题库页即刻恢复）。
 *
 * 用途（用户 2026-09-18 目检口径）：章节挑题与知识点挑题功能重复度高、收敛合理，但「未来需要时可回归」——
 * 数据从未物理删（节点/挂链/源映射俱在），本函数即一键回归；恢复后采集侧按类型匹配落树
 * （见 capture/tree-collect.ts 的同类型优先），恢复的教材树可继续承接教材采集，不会被知识树吞掉。
 *
 * 幂等：已恢复项记 `未归档` 跳过；单事务 + operation_log（tree.restore）留痕。
 * 注意：恢复只改树名（可见性），**不回滚**收敛时已完成的挂链重挂与源映射重指（那是数据归一，非归档态）。
 */
export function restoreArchivedTrees(db: Database, treeIds: string[]): TreeRestoreReport {
  const logger = new OperationLogger(db);
  const report: TreeRestoreReport = { restored: 0, trees: [], skipped: [] };
  const logId = logger.logStart('tree.restore', `树归档恢复：请求 ${treeIds.length} 棵`, { requested: treeIds });
  try {
    const selectTree = db.prepare('SELECT id, name, type, stage, subject_id FROM trees WHERE id = ?');
    const renameTree = db.prepare('UPDATE trees SET name = ? WHERE id = ?');
    db.transaction(() => {
      const requested = new Set<string>();
      for (const id of treeIds) {
        if (requested.has(id)) { report.skipped.push({ key: id, reason: '重复请求' }); continue; }
        requested.add(id);
        const row = selectTree.get(id);
        if (!row) { report.skipped.push({ key: id, reason: '未找到' }); continue; }
        const name = sqlString(row, 'name');
        if (!isArchivedTreeName(name)) { report.skipped.push({ key: id, reason: '未归档' }); continue; }
        const type = sqlString(row, 'type');
        if (type !== 'knowledge' && type !== 'textbook') {
          throw new Error(`trees.type 非法值：${type}（schema CHECK 之外的脏数据，不静默忽略）`);
        }
        const stage = sqlStringOrNull(row, 'stage');
        const subjectId = sqlStringOrNull(row, 'subject_id');
        const restoredName = name.slice(0, -TREE_ARCHIVE_SUFFIX.length);
        renameTree.run(restoredName, id);
        report.restored += 1;
        report.trees.push({
          id,
          name: restoredName,
          type,
          ...(stage !== null ? { stage } : {}),
          ...(subjectId !== null ? { subjectId } : {}),
        });
      }
    });
    logger.logSuccess(logId, report.restored);
    return report;
  } catch (error) {
    logger.logFailure(logId, error as Error);
    throw error;
  }
}

/** 全量装载（真库/脚本入口；含已归档树——计划侧自行排除，保证幂等） */
export function loadTreeConsolidationInput(db: Database, dictEntries: DictEntry[]): TreeConsolidationInput {
  const trees = (db.prepare(`
    SELECT id, type, subject_id, edition, stage, name, source, created_at
    FROM trees ORDER BY created_at, name, id
  `).all()).map((row): Tree => {
    const type = sqlString(row, 'type');
    if (type !== 'knowledge' && type !== 'textbook') {
      throw new Error(`trees.type 非法值：${type}（schema CHECK 之外的脏数据，不静默忽略）`);
    }
    const subjectId = sqlStringOrNull(row, 'subject_id');
    const edition = sqlStringOrNull(row, 'edition');
    const stage = sqlStringOrNull(row, 'stage');
    const source = sqlStringOrNull(row, 'source');
    return {
      id: sqlString(row, 'id'),
      type,
      name: sqlString(row, 'name'),
      createdAt: sqlString(row, 'created_at'),
      ...(subjectId !== null ? { subjectId } : {}),
      ...(edition !== null ? { edition } : {}),
      ...(stage !== null ? { stage } : {}),
      ...(source !== null ? { source } : {}),
    };
  });

  const nodesByTree = new Map<string, TreeNode[]>();
  for (const row of db.prepare(`
    SELECT id, tree_id, parent_id, name, sort FROM tree_nodes ORDER BY tree_id, sort, name
  `).all()) {
    const treeId = sqlString(row, 'tree_id');
    const parentId = sqlStringOrNull(row, 'parent_id');
    const node: TreeNode = {
      id: sqlString(row, 'id'),
      treeId,
      name: sqlString(row, 'name'),
      sort: sqlNumber(row, 'sort'),
      ...(parentId !== null ? { parentId } : {}),
    };
    const list = nodesByTree.get(treeId);
    if (list) list.push(node); else nodesByTree.set(treeId, [node]);
  }

  const links = (db.prepare('SELECT question_id, node_id FROM question_node_links').all()).map((row): QuestionNodeLink => ({
    questionId: sqlString(row, 'question_id'),
    nodeId: sqlString(row, 'node_id'),
  }));

  const sourceMappings = (db.prepare('SELECT node_id, site, site_node_id FROM tree_source_map').all()).map((row) => ({
    nodeId: sqlString(row, 'node_id'),
    site: sqlString(row, 'site'),
    siteNodeId: sqlString(row, 'site_node_id'),
  }));

  return { trees, nodesByTree, links, sourceMappings, dictEntries };
}
