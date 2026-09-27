// 0040 P5（D-055⑤/D-056③）：知识节点选择弹层 —— 学段/科目切换 + 节点搜索 + 任意层级可选中。
// 0054：树名剥来源前缀 + 去「综合库」根层 + 默认展开一级；确认语义=追加（同节点去重）。
//
// 呈现层答案同 R-034：节点浏览器与题库页同源（`TreeRows` 共享组件 + 父子索引），
// 差异只有三点：① 加搜索框（按节点名即时过滤，命中的祖先自动展开）；② 任意层级节点都可直接选；
// ③ 底部显示「学段 · 科目 › 节点路径」当前选择并提供「确认挂载」。

import { useEffect, useMemo, useState } from 'react';
import type { BankExtServices, Tree, TreeNode } from '../../shared/contracts/bank-types.js';
import { buildParentIndex, TreeNodeRows, topLevelRowIds } from '../components/TreeRows.js';
import { Modal } from '../pages/ExtUi.js';
// 0054（R-049）：树名剥来源前缀 + 去「综合库」根层（与题库页树面板同口径）
import { TREE_ROOT_NAMES, displayTreeName } from '../utils/tree-display.js';

export interface TreePickerSelection {
  nodeId: string;
  label: string;
}

const TREE_TYPE_LABEL: Record<string, string> = {
  knowledge: '知识点树',
  chapter: '章节树',
  exam_point: '考点树',
};

export function TreePickerModal({
  ext, stage, subjectId, subjectLabel, onConfirm, onClose,
}: {
  ext: BankExtServices;
  stage: string;
  subjectId: string;
  subjectLabel: string;
  onConfirm: (selection: TreePickerSelection) => void;
  onClose: () => void;
}) {
  const [trees, setTrees] = useState<Tree[]>([]);
  const [treeId, setTreeId] = useState('');
  const [nodes, setNodes] = useState<TreeNode[]>([]);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set<string>());
  const [selectedId, setSelectedId] = useState('');
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 树清单：按当前学段/学科定格（切学科即换树；空清单显示「待采集」不造假）。
  // listTrees 的 filter 只支持 type/subjectId（契约），学段维度在客户端按 t.stage 收敛（题库页同口径）。
  useEffect(() => {
    let alive = true;
    setLoading(true);
    void (async () => {
      try {
        const all = await ext.tree.listTrees();
        const list = all.filter(
          (t) => (!subjectId || t.subjectId === subjectId) && (!stage || !t.stage || t.stage === stage),
        );
        if (!alive) return;
        setTrees(list);
        setTreeId((prev) => (list.some((t) => t.id === prev) ? prev : (list[0]?.id ?? '')));
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [ext, stage, subjectId]);

  useEffect(() => {
    if (!treeId) { setNodes([]); return; }
    let alive = true;
    void (async () => {
      try {
        const rows = await ext.tree.getNodes(treeId);
        if (!alive) return;
        setNodes(rows);
        // 0054 R-049③：默认展开一级（去根层后的第一级）——树数据到达时只初始化一次
        setOpen(new Set(topLevelRowIds(rows, TREE_ROOT_NAMES)));
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { alive = false; };
  }, [ext, treeId]);

  const byParent = useMemo(() => buildParentIndex(nodes, { sort: true }), [nodes]);

  // 搜索：命中节点 + 其全部祖先可见；命中后自动展开祖先
  const matched = useMemo(() => {
    const kw = keyword.trim();
    if (!kw) return null;
    const ids = new Set<string>();
    const parentOf = new Map<string, string>();
    for (const [pid, list] of byParent) for (const n of list) parentOf.set(n.id, pid);
    for (const node of nodes) {
      if (!node.name.includes(kw)) continue;
      let cur: string | undefined = node.id;
      let guard = 0;
      while (cur && guard++ < 128) {
        ids.add(cur);
        cur = parentOf.get(cur) || undefined;
      }
    }
    return ids;
  }, [keyword, nodes, byParent]);

  useEffect(() => {
    if (!matched) return;
    setOpen(new Set(matched));
  }, [matched]);

  const visibleByParent = useMemo(() => {
    if (!matched) return byParent;
    const filtered = new Map<string, TreeNode[]>();
    for (const [pid, list] of byParent) {
      filtered.set(pid, list.filter((n) => matched.has(n.id)));
    }
    return filtered;
  }, [byParent, matched]);

  const labelOf = useMemo(() => {
    const parentOf = new Map<string, string>();
    const nameOf = new Map<string, string>();
    for (const [pid, list] of byParent) for (const n of list) { parentOf.set(n.id, pid); nameOf.set(n.id, n.name); }
    return (id: string): string => {
      const path: string[] = [];
      let cur: string | undefined = id;
      let guard = 0;
      while (cur && guard++ < 128) {
        path.unshift(nameOf.get(cur) ?? cur);
        cur = parentOf.get(cur) || undefined;
      }
      return path.join(' › ');
    };
  }, [byParent]);

  const toggle = (id: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectedLabel = selectedId ? labelOf(selectedId) : '';

  return (
    <Modal title="选择知识节点" onClose={onClose}>
      <div className="wb-tm" data-testid="wb-tree-picker">
        <div className="wb-tm-filters">
          <span className="wb-tm-muted" data-testid="wb-tm-stage">{stage || '不限学段'}</span>
          <span className="wb-tm-muted" data-testid="wb-tm-subject">{subjectLabel || subjectId || '未定学科'}</span>
          <select
            className="wb-tm-select"
            aria-label="选择树"
            data-testid="wb-tm-tree"
            value={treeId}
            onChange={(e) => setTreeId(e.target.value)}
          >
            {trees.length === 0 && <option value="">（该学段/学科暂无树）</option>}
            {trees.map((t) => (
              <option key={t.id} value={t.id}>{TREE_TYPE_LABEL[t.type] ?? t.type} · {displayTreeName(t.name)}</option>
            ))}
          </select>
          <input
            className="wb-tm-search"
            placeholder="搜索节点…"
            aria-label="搜索节点"
            data-testid="wb-tm-search"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
        </div>

        {error && <div className="wb-q-err">{error}</div>}
        {loading && <div className="wb-tm-muted">树节点加载中…</div>}

        <div className="wb-tm-tree" data-testid="wb-tm-tree-body">
          {!loading && nodes.length === 0 && <div className="wb-tm-muted">该树暂无节点（先跑采集）</div>}
          {nodes.length > 0 && (
            <TreeNodeRows
              byParent={visibleByParent}
              parentId=""
              depth={0}
              open={open}
              onToggle={toggle}
              selectedId={selectedId}
              onSelect={setSelectedId}
              testidPrefix="wb-tree-node"
              toggleTestidPrefix="wb-tree-toggle"
              selectTitle={null}
              skipRootNames={TREE_ROOT_NAMES}
            />
          )}
        </div>

        <div className="wb-tm-cur">
          当前选择：<b data-testid="wb-tm-path">{selectedLabel || '（未选择）'}</b>
          <span className="wb-tm-muted">　任意层级都可直接选</span>
        </div>
        <div className="wb-tm-foot">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>取消</button>
          <button
            type="button"
            className="btn btn-green btn-sm"
            data-testid="wb-tm-confirm"
            disabled={!selectedId}
            onClick={() => onConfirm({ nodeId: selectedId, label: selectedLabel })}
          >
            确认挂载
          </button>
        </div>
      </div>
    </Modal>
  );
}
