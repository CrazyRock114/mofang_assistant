// 0044（D-063）：文件夹树选择器 —— 「字段 + 点击展开的树浮层」（非原生下拉）。
// 默认只列顶级、▸ 点击展开子夹（与知识点树 TreeRows 同一折叠口径）；含「＋ 新建文件夹…」项
// （即建即选，新建父夹=当前选中值）；首行恒为「未分类」（value=null）。
// 消费方：试卷管理页「移动到文件夹」弹层、录题台「存为试卷」弹层。

import { useMemo, useState } from 'react';
import type { PaperFolder } from '../../shared/contracts/bank-types.js';
import type { TreeNode } from '../../shared/contracts/bank-types.js';
import { buildParentIndex, TreeNodeRows } from './TreeRows.js';

export function FolderTreePicker({
  folders, value, onChange, onCreateFolder,
}: {
  folders: PaperFolder[];
  /** null = 未分类 */
  value: string | null;
  onChange: (folderId: string | null) => void;
  /** 提供「＋ 新建文件夹…」能力（即建即选）；缺省不渲染该项 */
  onCreateFolder?: (name: string, parentId: string | null) => Promise<string>;
}) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set<string>());
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

  const byId = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);
  const treeNodes: TreeNode[] = useMemo(
    () => folders.map((f) => ({ id: f.id, treeId: 'paper-folders', parentId: f.parentId, name: f.name, sort: f.sort })),
    [folders],
  );
  const nodesByParent = useMemo(() => buildParentIndex(treeNodes, { sort: true }), [treeNodes]);

  const pathLabel = (folderId: string | null): string => {
    if (!folderId) return '未分类';
    const parts: string[] = [];
    let cur: string | undefined = folderId;
    let guard = 0;
    while (cur && guard++ < 128) {
      const f = byId.get(cur);
      if (!f) break;
      parts.unshift(f.name);
      cur = f.parentId;
    }
    return parts.length > 0 ? parts.join(' / ') : '未分类';
  };

  const create = async () => {
    if (!onCreateFolder || !newName.trim() || busy) return;
    setBusy(true);
    try {
      const id = await onCreateFolder(newName.trim(), value);
      // 目检返工②：新建后展开选中夹（新子夹立刻可见），并选中它
      if (value) setExpanded((prev) => new Set(prev).add(value));
      onChange(id);
      setCreating(false);
      setNewName('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="treepick" data-testid="folder-tree-picker">
      <div
        className="treepick-field"
        data-testid="folder-tree-picker-field"
        onClick={() => setOpen(!open)}
      >
        <span className="v">📁 {pathLabel(value)}</span>
        <span className="muted">{open ? '▴' : '▾'}</span>
      </div>
      {open && (
        <div className="treepick-pop" data-testid="folder-tree-picker-pop">
          <div
            className={`tp-row ${value === null ? 'on' : ''}`}
            data-testid="folder-tree-pick-uncategorized"
            onClick={() => onChange(null)}
          >
            <span className="caret" />
            <span>📥 未分类</span>
          </div>
          <TreeNodeRows
            byParent={nodesByParent}
            parentId=""
            depth={0}
            open={expanded}
            onToggle={(id) => setExpanded((prev) => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id); else next.add(id);
              return next;
            })}
            selectedId={value ?? ''}
            onSelect={(id) => onChange(id)}
            testidPrefix="folder-tree-node"
            toggleTestidPrefix="folder-tree-toggle"
            selectTitle={null}
          />
          {onCreateFolder && (
            creating ? (
              <div className="tp-row tp-create">
                <input
                  className="input"
                  data-testid="folder-tree-new-input"
                  value={newName}
                  autoFocus
                  placeholder="新文件夹名（建在当前选中夹之下）"
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void create(); }}
                />
                <button className="btn btn-sm btn-primary" data-testid="folder-tree-new-confirm" disabled={!newName.trim() || busy} onClick={() => void create()}>创建</button>
              </div>
            ) : (
              <div className="tp-row tp-new" data-testid="folder-tree-new" onClick={() => setCreating(true)}>＋ 新建文件夹…</div>
            )
          )}
        </div>
      )}
    </div>
  );
}
