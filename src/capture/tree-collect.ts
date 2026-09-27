/**
 * 0006 P2：树采集解析与幂等落库计划（纯函数 + TreeService 落库，浏览器/jsdom 双环境）
 *
 * 结构依据：0006 实站侦察纪要（2026-09-10 P0 实站取证）
 * - 组卷网知识点树：zsd 页 .tree-box > .tk-tree[tree-id=根id] > ul.tree-ul > li[tree-id][data-tree-type=1]，
 *   嵌套 ul 即层级；根=综合库（zsd18194 之于初中物理）；树为全学科（czwl 实测 1372 节点/6 层）。
 * - 菁优教材书树：搜索页 #JYE_BOOK_TREE_HOLDER，li[ek]=版本 → li[bk][gd]=书。
 * - 菁优知识点树：#JYE_POINT_TREE_HOLDER，li[pk][nm] 嵌套；pk 为累计路径（书~章~/书~节~/书~节~数字），
 *   当前选中书 = .tree-head #spanEdition/#spanGrade。
 * 幂等（任务书 P2）：节点经 tree_source_map(site, site_node_id) 反查，已有只复用不重建；
 * 只增节点不删既有；重复执行零增量。
 */

import type { Tree, TreeService } from '../shared/contracts/bank-types.js';
import { pickAuthoritativeTree } from '../bank/tree-consolidation.js';
import { SUBJ_PREFIX } from '../bank/subject-normalize.js';

export interface TreeSourceNode {
  /** 站点节点稳定 id（组卷 zsd 数字 id；菁优累计 pk 路径） */
  siteNodeId: string;
  name: string;
  parentSiteNodeId: string | null;
  sort: number;
}

/** doc 参数用 any（浏览器 DOMParser / jsdom 双环境，detail-pages.ts 同款约定） */

/** 组卷网知识点树（zsd 页）：根 + 全量节点（仅 data-tree-type=1 主树） */
export function parseZujuanKnowledgeTree(doc: any): { rootId: string; nodes: TreeSourceNode[] } {
  const rootEl = doc.querySelector('.tk-tree[tree-id]');
  if (!rootEl) return { rootId: '', nodes: [] };
  const rootId = rootEl.getAttribute('tree-id') || '';
  const nodes: TreeSourceNode[] = [];
  const seen = new Set<string>();
  const walk = (ul: any, parentKey: string | null) => {
    let sort = 0;
    ul.querySelectorAll(':scope > li[tree-id]').forEach?.((li: any) => {
      const id = li.getAttribute('tree-id') || '';
      if (!id || seen.has(id)) return;
      // 只收知识点主树（4/5=能力/专题辅树）
      if ((li.getAttribute('data-tree-type') || '1') !== '1') return;
      const anchor = li.querySelector('a.tree-anchor') || li.querySelector('[title]');
      const name = (anchor?.getAttribute('title') || anchor?.textContent || '').trim();
      if (!name) return;
      seen.add(id);
      nodes.push({ siteNodeId: id, name, parentSiteNodeId: parentKey, sort: sort++ });
      li.querySelectorAll(':scope > ul').forEach?.((childUl: any) => walk(childUl, id));
    });
  };
  rootEl.querySelectorAll(':scope > ul').forEach?.((ul: any) => walk(ul, rootId));
  // 根（综合库）自身也是可挂节点
  const rootName = (rootEl.getAttribute('title') || '').trim() || '综合库';
  return { rootId, nodes: [{ siteNodeId: rootId, name: rootName, parentSiteNodeId: null, sort: 0 }, ...nodes] };
}

export interface JyeooBook {
  /** 书 GUID（bk） */
  bk: string;
  /** 学段码（gd） */
  gd: string;
  nm: string;
  editionEk: string;
  editionName: string;
}

/** 菁优教材书树（JYE_BOOK_TREE_HOLDER）：版本 → 书 */
export function parseJyeooBookTree(doc: any): JyeooBook[] {
  const out: JyeooBook[] = [];
  const holder = doc.querySelector('#JYE_BOOK_TREE_HOLDER');
  if (!holder) return out;
  holder.querySelectorAll(':scope > li[ek]').forEach?.((edition: any) => {
    const ek = edition.getAttribute('ek') || '';
    const editionName = (edition.getAttribute('nm') || '').trim();
    edition.querySelectorAll(':scope > ul > li[bk]').forEach?.((book: any) => {
      const bk = book.getAttribute('bk') || '';
      const nm = (book.getAttribute('nm') || '').trim();
      if (bk && nm) out.push({ bk, gd: book.getAttribute('gd') || '', nm, editionEk: ek, editionName });
    });
  });
  return out;
}

export interface JyeooKnowledgeTree {
  /** 当前选中书（tree-head 展示态） */
  bookBk: string | null;
  editionName: string;
  bookName: string;
  nodes: TreeSourceNode[];
}

/** 菁优知识点树（JYE_POINT_TREE_HOLDER + tree-head 当前书展示态） */
export function parseJyeooKnowledgeTree(doc: any): JyeooKnowledgeTree {
  const editionName = (doc.querySelector('#spanEdition')?.textContent || '').replace(/[：:]\s*$/, '').trim();
  const bookName = (doc.querySelector('#spanGrade')?.textContent || '').trim();
  const nodes: TreeSourceNode[] = [];
  const seen = new Set<string>();
  const holder = doc.querySelector('#JYE_POINT_TREE_HOLDER');
  if (holder) {
    const walk = (ul: any, parentKey: string | null) => {
      let sort = 0;
      ul.querySelectorAll(':scope > li[pk]').forEach?.((li: any) => {
        const pk = li.getAttribute('pk') || '';
        const name = (li.getAttribute('nm') || '').trim();
        if (!pk || !name || seen.has(pk)) return;
        seen.add(pk);
        nodes.push({ siteNodeId: pk, name, parentSiteNodeId: parentKey, sort: sort++ });
        li.querySelectorAll(':scope > ul').forEach?.((childUl: any) => walk(childUl, pk));
      });
    };
    holder.querySelectorAll(':scope > li[pk]').forEach?.((chapter: any) => {
      // 章级：parentKey = null（书本身不建节点，树按 章为根）
      const pk = chapter.getAttribute('pk') || '';
      const name = (chapter.getAttribute('nm') || '').trim();
      if (pk && name && !seen.has(pk)) {
        seen.add(pk);
        nodes.push({ siteNodeId: pk, name, parentSiteNodeId: null, sort: nodes.length });
      }
      chapter.querySelectorAll(':scope > ul').forEach?.((ul: any) => walk(ul, pk || null));
    });
  }
  return { bookBk: null, editionName, bookName, nodes };
}

// ---------- 计划构建与幂等落库 ----------

export interface TreePlanGroup {
  /** 业务幂等键（树名即键：同名复用） */
  name: string;
  type: 'textbook' | 'knowledge';
  subjectId?: string;
  edition?: string;
  stage?: string;
  site: 'zujuan' | 'jyeoo';
  nodes: TreeSourceNode[];
}

export interface TreeApplyReport {
  treesCreated: number;
  treesReused: number;
  nodesCreated: number;
  /** 经 tree_source_map 反查已存在而复用的节点数 */
  nodesSkipped: number;
  /** 同 (tree,parent,name) 已有同名节点（站点同名不同 id）而跳过——本地树不存重复名兄弟 */
  nodesNameConflict: number;
  /** 0039 P2：父节点反查命中的本地节点不在目标权威树（多为已归档树的孤儿映射）而跳过——不跨树挂载 */
  nodesSkippedCrossTree: number;
}

/**
 * 0006-fix-2：知识点树 subjectId 一律走 dict 归一值（`subj:{code}`，由调用方经 subjectIdOf 反查传入）；
 * 反查不到时缺省该键（不写站点原文 segment / 中文名 —— 那是历史三格式并存的根源，
 * 见 0006 fix-2 口径 §零）。
 */

/** 组卷网知识点树计划 */
export function buildZujuanKnowledgePlan(input: {
  rootId: string;
  nodes: TreeSourceNode[];
  /** 归一学科 id（`subj:{code}`）；dict 反查不到缺省 */
  subjectId?: string;
  stage: string;
  subjectLabel: string;
}): TreePlanGroup {
  return {
    name: `组卷网·知识点·${input.stage}${input.subjectLabel}`,
    type: 'knowledge',
    ...(input.subjectId ? { subjectId: input.subjectId } : {}),
    stage: input.stage,
    site: 'zujuan',
    nodes: input.nodes,
  };
}

/** 菁优知识点树计划（按当前选中书） */
export function buildJyeooKnowledgePlan(input: {
  tree: JyeooKnowledgeTree;
  /** 归一学科 id（`subj:{code}`）；dict 反查不到缺省 */
  subjectId?: string;
  stage: string;
  subjectLabel: string;
}): TreePlanGroup {
  const { tree } = input;
  return {
    name: `菁优网·知识点·${input.stage}${input.subjectLabel}·${tree.editionName}${tree.bookName}`,
    type: 'knowledge',
    ...(input.subjectId ? { subjectId: input.subjectId } : {}),
    edition: tree.editionName,
    stage: input.stage,
    site: 'jyeoo',
    nodes: tree.nodes,
  };
}

/**
 * 0039 P2：计划的权威树分组键（学段 + 归一学科 code）；两者缺一即不可分组 → null（回落按名复用）。
 * 树行同键：库内 subject_id 经 0006-fix-2 矫正后为 `subj:{code}`（非该形态的树不参与分组，仍可被同名计划复用）。
 */
function authoritativeGroupKeyOf(stage: string | undefined, subjectId: string | undefined): string | null {
  const st = (stage ?? '').trim();
  const raw = (subjectId ?? '').trim();
  if (!st || !raw.startsWith(SUBJ_PREFIX)) return null;
  const code = raw.slice(SUBJ_PREFIX.length).trim();
  return code ? `${st}\u0000${code}` : null;
}

/**
 * 幂等落库：目标树按（学段×学科）权威树收敛（0039 P2——多来源在采集侧归一，不再按来源另立树）；
 * 不可分组的计划（缺学段/学科未归一）回落按名复用（0039 前语义）。
 * 节点经 resolveSourceNode(site, siteNodeId) 反查，已有只复用不重建（父先于子，plan 保证）；
 * 父命中的本地节点不在目标树（归档树孤儿映射）→ 跳过不跨树挂载并按报告计数。
 */
export async function applyTreePlan(service: TreeService, groups: TreePlanGroup[]): Promise<TreeApplyReport> {
  const report: TreeApplyReport = {
    treesCreated: 0, treesReused: 0, nodesCreated: 0, nodesSkipped: 0, nodesNameConflict: 0, nodesSkippedCrossTree: 0,
  };
  // 默认 listTrees 已剔归档树（0039）——候选即权威树
  const trees = await service.listTrees();
  const treeByName = new Map(trees.map((t) => [t.name, t]));
  const treesByGroup = new Map<string, Tree[]>();
  for (const t of trees) {
    const key = authoritativeGroupKeyOf(t.stage, t.subjectId);
    if (!key) continue;
    const list = treesByGroup.get(key);
    if (list) list.push(t); else treesByGroup.set(key, [t]);
  }
  const registerTree = (t: Tree): void => {
    const key = authoritativeGroupKeyOf(t.stage, t.subjectId);
    if (!key) return;
    const list = treesByGroup.get(key);
    if (list) { if (!list.some((x) => x.id === t.id)) list.push(t); } else treesByGroup.set(key, [t]);
  };

  for (const g of groups) {
    const groupKey = authoritativeGroupKeyOf(g.stage, g.subjectId);
    let tree: Tree | undefined;
    if (groupKey) {
      // 权威树判定与 0039 P1 同源（知识树优先取最大）——同一组合只服务一棵树。
      // 0039 回归口径：**同类型树优先**（恢复的教材树继续承接教材采集，不被知识树吞掉）；
      // 组内无同类型树时回落组权威树（多来源在采集侧归一，不另立新树）。
      const candidates = treesByGroup.get(groupKey) ?? [];
      const sameType = candidates.filter((t) => t.type === g.type);
      const pool = sameType.length > 0 ? sameType : candidates;
      const withCounts = [] as Array<{ tree: Tree; nodeCount: number }>;
      for (const c of pool) withCounts.push({ tree: c, nodeCount: (await service.getNodes(c.id)).length });
      tree = pickAuthoritativeTree(withCounts)?.tree;
    }
    if (!tree) tree = treeByName.get(g.name); // 兜底：不可分组计划按名复用
    if (tree) report.treesReused++; else {
      tree = await service.createTree({
        type: g.type,
        name: g.name,
        ...(g.subjectId ? { subjectId: g.subjectId } : {}),
        ...(g.edition ? { edition: g.edition } : {}),
        ...(g.stage ? { stage: g.stage } : {}),
        source: g.site,
      });
      treeByName.set(tree.name, tree);
      registerTree(tree);
      report.treesCreated++;
    }
    const targetTree = tree;
    // 同名兄弟索引（UNIQUE(tree_id,parent_id,name) 预判）：站点同名不同 id 的节点挂同一父时，
    // 本地树只保留首个，后续记 nameConflict 跳过（2026-09-10 教材树实撞）
    const siblingNames = new Set(
      (await service.getNodes(targetTree.id)).map((n) => `${n.parentId ?? ''}|${n.name}`)
    );
    // 父先于子（采集解析保证）；父缺失（脏输入）记入报告不阻塞其余节点
    for (const node of g.nodes) {
      const existing = await service.resolveSourceNode(g.site, node.siteNodeId);
      if (existing) { report.nodesSkipped++; continue; }
      let parentId: string | undefined;
      if (node.parentSiteNodeId) {
        const parent = await service.resolveSourceNode(g.site, node.parentSiteNodeId);
        if (!parent) continue; // 父未建（乱序/缺根）——不孤儿挂载，如实跳过
        // 0039 P2：父命中的本地节点不在目标权威树（归档树孤儿映射等）——不跨树挂载
        if (parent.treeId !== targetTree.id) { report.nodesSkippedCrossTree++; continue; }
        parentId = parent.id;
      }
      const siblingKey = `${parentId ?? ''}|${node.name}`;
      if (siblingNames.has(siblingKey)) { report.nodesNameConflict++; continue; }
      await service.createNode({
        treeId: targetTree.id,
        name: node.name,
        sort: node.sort,
        ...(parentId ? { parentId } : {}),
        sourceMapping: { site: g.site, siteNodeId: node.siteNodeId, siteNodeName: node.name },
      });
      siblingNames.add(siblingKey);
      report.nodesCreated++;
    }
  }
  return report;
}
