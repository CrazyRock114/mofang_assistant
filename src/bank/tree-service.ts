// 0002: 树服务（B3/B4/U5/U12）——trees/tree_nodes/question_node_links/tree_source_map
// 只读预置体系：服务供建树（采集/后台更新加节点）；无用户编辑（B4）。
// 拍板 §6-10：根节点（parent_id=NULL）重名检查由 service 层负责（UNIQUE(tree_id,parent_id,name) 不拦 NULL）。

import type {
  Tree, TreeType, TreeNode, TreeSourceMapping, TreeService,
} from '../shared/contracts/bank-types.js';
import type { Database } from './db.js';
import { OperationLogger } from './operation-log.js';
import { isArchivedTreeName } from './tree-archive.js';

export class TreeServiceImpl implements TreeService {
  private logger: OperationLogger;

  constructor(private db: Database) {
    this.logger = new OperationLogger(db);
  }

  async createTree(data: { type: TreeType; name: string; subjectId?: string; edition?: string; stage?: string; source?: string }): Promise<Tree> {
    return this.logger.wrap('tree.create', `Create tree: ${data.name}`, () => {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      this.db.prepare(`
        INSERT INTO trees (id, type, subject_id, edition, stage, name, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, data.type, data.subjectId ?? null, data.edition ?? null, data.stage ?? null, data.name, data.source ?? null, now);

      return {
        id,
        type: data.type,
        subjectId: data.subjectId,
        edition: data.edition,
        stage: data.stage,
        name: data.name,
        source: data.source,
        createdAt: now,
      };
    });
  }

  async listTrees(filter: { type?: TreeType; subjectId?: string; includeArchived?: boolean } = {}): Promise<Tree[]> {
    let sql = 'SELECT * FROM trees WHERE 1=1';
    const params: any[] = [];
    if (filter.type) { sql += ' AND type = ?'; params.push(filter.type); }
    if (filter.subjectId) { sql += ' AND subject_id = ?'; params.push(filter.subjectId); }
    sql += ' ORDER BY created_at';

    const rows = this.db.prepare(sql).all(...params) as any[];
    const trees = rows.map(row => ({
      id: row.id,
      type: row.type,
      subjectId: row.subject_id ?? undefined,
      edition: row.edition ?? undefined,
      stage: row.stage ?? undefined,
      name: row.name,
      source: row.source ?? undefined,
      createdAt: row.created_at,
    }));
    // 0039：默认剔已归档（收敛后每科一套权威树）；includeArchived 取全量供治理/审计
    return filter.includeArchived ? trees : trees.filter((t) => !isArchivedTreeName(t.name));
  }

  async getTree(id: string): Promise<Tree | null> {
    const row = this.db.prepare('SELECT * FROM trees WHERE id = ?').get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      type: row.type,
      subjectId: row.subject_id ?? undefined,
      edition: row.edition ?? undefined,
      stage: row.stage ?? undefined,
      name: row.name,
      source: row.source ?? undefined,
      createdAt: row.created_at,
    };
  }

  async getNodes(treeId: string): Promise<TreeNode[]> {
    const rows = this.db.prepare(`
      SELECT id, tree_id, parent_id, name, sort
      FROM tree_nodes WHERE tree_id = ?
      ORDER BY sort, name
    `).all(treeId) as any[];
    return rows.map(row => this.rowToNode(row));
  }

  async getDescendants(nodeId: string): Promise<Array<TreeNode & { depth: number }>> {
    // 后代展开（递归 CTE）：含自身，先序近似（depth 分层），同级按 sort/name
    const rows = this.db.prepare(`
      WITH RECURSIVE sub(id, depth) AS (
        SELECT id, 0 FROM tree_nodes WHERE id = ?
        UNION ALL
        SELECT tn.id, sub.depth + 1
        FROM tree_nodes tn JOIN sub ON tn.parent_id = sub.id
      )
      SELECT tn.id, tn.tree_id, tn.parent_id, tn.name, tn.sort, sub.depth
      FROM tree_nodes tn JOIN sub ON tn.id = sub.id
      ORDER BY sub.depth, tn.sort, tn.name
    `).all(nodeId) as any[];

    return rows.map(row => ({ ...this.rowToNode(row), depth: row.depth }));
  }

  async createNode(data: { treeId: string; parentId?: string; name: string; sort?: number; sourceMapping?: { site: string; siteNodeId: string; siteNodeName?: string } }): Promise<TreeNode> {
    return this.logger.wrap('tree.createNode', `Create tree node: ${data.name}`, () => {
      const tree = this.db.prepare('SELECT id FROM trees WHERE id = ?').get(data.treeId) as any;
      if (!tree) throw new Error(`Tree ${data.treeId} not found`);

      if (data.parentId) {
        const parent = this.db.prepare('SELECT id FROM tree_nodes WHERE id = ?').get(data.parentId) as any;
        if (!parent) throw new Error(`Parent node ${data.parentId} not found`);
      } else {
        // 拍板 §6-10：根节点重名守卫（parent_id=NULL 时 UNIQUE 约束失效）
        const dup = this.db.prepare(
          'SELECT id FROM tree_nodes WHERE tree_id = ? AND parent_id IS NULL AND name = ?'
        ).get(data.treeId, data.name) as any;
        if (dup) {
          throw new Error(`Duplicate root node "${data.name}" in tree ${data.treeId}`);
        }
      }

      const id = crypto.randomUUID();
      const sort = data.sort ?? 0;

      this.db.transaction(() => {
        this.db.prepare(`
          INSERT INTO tree_nodes (id, tree_id, parent_id, name, sort)
          VALUES (?, ?, ?, ?, ?)
        `).run(id, data.treeId, data.parentId ?? null, data.name, sort);

        if (data.sourceMapping) {
          this.db.prepare(`
            INSERT INTO tree_source_map (node_id, site, site_node_id, site_node_name)
            VALUES (?, ?, ?, ?)
          `).run(id, data.sourceMapping.site, data.sourceMapping.siteNodeId, data.sourceMapping.siteNodeName ?? null);
        }
      });

      return { id, treeId: data.treeId, parentId: data.parentId, name: data.name, sort };
    });
  }

  async linkQuestion(questionId: string, nodeId: string): Promise<void> {
    this.logger.wrap('tree.linkQuestion', `Link question ${questionId} to node ${nodeId}`, () => {
      const node = this.db.prepare('SELECT id FROM tree_nodes WHERE id = ?').get(nodeId) as any;
      if (!node) throw new Error(`Tree node ${nodeId} not found`);

      // 多挂（B3）：INSERT OR IGNORE——重复挂接幂等
      this.db.prepare(`
        INSERT OR IGNORE INTO question_node_links (question_id, node_id)
        VALUES (?, ?)
      `).run(questionId, nodeId);
    });
  }

  async unlinkQuestion(questionId: string, nodeId: string): Promise<void> {
    this.logger.wrap('tree.unlinkQuestion', `Unlink question ${questionId} from node ${nodeId}`, () => {
      this.db.prepare('DELETE FROM question_node_links WHERE question_id = ? AND node_id = ?')
        .run(questionId, nodeId);
    });
  }

  async getQuestionNodes(questionId: string): Promise<TreeNode[]> {
    const rows = this.db.prepare(`
      SELECT tn.id, tn.tree_id, tn.parent_id, tn.name, tn.sort
      FROM question_node_links qnl JOIN tree_nodes tn ON tn.id = qnl.node_id
      WHERE qnl.question_id = ?
      ORDER BY tn.tree_id, tn.sort
    `).all(questionId) as any[];
    return rows.map(row => this.rowToNode(row));
  }

  async resolveSourceNode(site: string, siteNodeId: string): Promise<TreeNode | null> {
    const row = this.db.prepare(`
      SELECT tn.id, tn.tree_id, tn.parent_id, tn.name, tn.sort
      FROM tree_source_map tsm JOIN tree_nodes tn ON tn.id = tsm.node_id
      WHERE tsm.site = ? AND tsm.site_node_id = ?
    `).get(site, siteNodeId) as any;
    return row ? this.rowToNode(row) : null;
  }

  async getSourceMappings(nodeId: string): Promise<TreeSourceMapping[]> {
    const rows = this.db.prepare(`
      SELECT node_id, site, site_node_id, site_node_name
      FROM tree_source_map WHERE node_id = ?
    `).all(nodeId) as any[];
    return rows.map(row => ({
      nodeId: row.node_id,
      site: row.site,
      siteNodeId: row.site_node_id,
      siteNodeName: row.site_node_name ?? undefined,
    }));
  }

  private rowToNode(row: any): TreeNode {
    return {
      id: row.id,
      treeId: row.tree_id,
      parentId: row.parent_id ?? undefined,
      name: row.name,
      sort: row.sort,
    };
  }
}
