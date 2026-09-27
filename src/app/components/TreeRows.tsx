// 0040 P5（只增）：树节点折叠浏览的共享组件 + 父子索引工具。
//
// 出处：`BankBrowser.tsx` 的模块私有 `TreeNodeRows` 与 byParent 父子索引模式（0006-fix-1 千级节点
// 只渲染已展开分支）——0040 的挂树节点选择弹层需要同一套行为，故抽为共享组件，题库页原位换用
// （DOM 结构/data-testid/交互逐字保持，行为零变化）。
//
// 通用性约束：题库页用 `bank-tree-*` 前缀（既有测试依赖），录题工作台用 `wb-tree-*` 前缀。

import type { TreeNode } from '../../shared/contracts/bank-types.js';

/**
 * 父子索引（parentId='' 为根；parentId 悬空——父不在本树——按根处理，与题库页既有口径一致）。
 * `sort` 为真时按 `TreeNode.sort` 升序排列子孙（题库页既有行为）。
 */
export function buildParentIndex(nodes: TreeNode[], options?: { sort?: boolean }): Map<string, TreeNode[]> {
  const ids = new Set(nodes.map((n) => n.id));
  const byParent = new Map<string, TreeNode[]>();
  for (const n of nodes) {
    const key = n.parentId && ids.has(n.parentId) ? n.parentId : '';
    const list = byParent.get(key);
    if (list) list.push(n);
    else byParent.set(key, [n]);
  }
  if (options?.sort) {
    for (const list of byParent.values()) list.sort((a, b) => a.sort - b.sort);
  }
  return byParent;
}

/**
 * 0054（R-049③）：顶层行 id 集（供调用方预置 `open` = 默认展开一级）。
 * 与 `TreeNodeRows` 的 `skipRootNames` 同口径：命中清单的顶层节点不占行位，改取其 children。
 * 调用方口径：树数据加载后**只初始化一次**，用户手动折叠/展开后不再覆盖。
 */
export function topLevelRowIds(nodes: TreeNode[], skipRootNames?: readonly string[]): string[] {
  const byParent = buildParentIndex(nodes);
  const roots = byParent.get('') ?? [];
  const skip = skipRootNames && skipRootNames.length > 0 ? new Set(skipRootNames) : null;
  const out: string[] = [];
  for (const n of roots) {
    if (skip?.has(n.name)) {
      for (const child of byParent.get(n.id) ?? []) out.push(child.id);
      continue;
    }
    out.push(n.id);
  }
  return out;
}

export interface TreeNodeRowsProps {
  byParent: Map<string, TreeNode[]>;
  parentId: string;
  depth: number;
  open: ReadonlySet<string>;
  onToggle: (id: string) => void;
  selectedId: string;
  onSelect: (id: string) => void;
  /** 节点行 data-testid 前缀（缺省 'bank-tree-node'，题库页既有口径） */
  testidPrefix?: string;
  /** 折叠钮 data-testid 前缀（缺省 'bank-tree-toggle'；与行前缀不是简单拼接关系，故独立成项） */
  toggleTestidPrefix?: string;
  /** 选中行 title（缺省题库页口径「按该节点筛题」；录题工作台传 null 表示不设） */
  selectTitle?: string | null;
  /** 行尾右侧补充内容（录题工作台的「挂到这里」按钮等）；缺省不渲染 */
  renderTrailing?: (node: TreeNode) => React.ReactNode;
  /**
   * 0044 目检三轮（只增，可选）：行内编辑——命中 id 的行整体替换为输入框（原位重命名）。
   * 不传时零变化（题库页/录题台不受影响）。
   */
  editingRow?: {
    id: string;
    value: string;
    onChange: (v: string) => void;
    onConfirm: () => void;
    onCancel: () => void;
    /** 输入框 data-testid */
    testid?: string;
    /** 确认按钮 data-testid */
    confirmTestid?: string;
  } | null;
  /**
   * 0044 目检三轮（只增，可选）：插入行——渲染在 afterParentId 对应层级子级的末尾
   * （afterParentId='' = 顶级层末尾），用于「新建子文件夹」的原位命名行。
   */
  insertRow?: { afterParentId: string; node: React.ReactNode } | null;
  /**
   * 0044 目检六轮（只增，可选）：缩进封顶深度——超过后不再递增（行可读空间保住，
   * 适配窄栏多层文件夹）。缺省不封顶（题库页/录题台现行为零变化）。
   */
  maxIndentDepth?: number;
  /**
   * 0044 目检七轮（只增，可选）：横向滚动模式——行按内容完整宽度渲染（不再 ellipsis
   * 自我裁剪），由调用方容器提供 overflow-x:auto 出左右滚动条。缺省 false（题库页/
   * 录题台既有压缩行为零变化）。
   */
  hScroll?: boolean;
  /**
   * 0054（R-049②，只增，可选）：去根层——顶层节点名命中清单时该行不渲染，直接渲染其
   * children（层级缩进随之上提一级；只作用于顶层，深层同名节点照渲染）。缺省不传 =
   * 现状逐字不变（FolderTreePicker 文件夹树等调用方零影响）。
   */
  skipRootNames?: readonly string[];
}

/**
 * 树节点折叠浏览：byParent 预建父子索引；只渲染已展开分支，
 * 千级节点树（组卷知识点树实测 1372 节点）不一次性铺开 DOM。
 * 节点行可点（整行=选中，▸ 钮=折叠/展开），选中行高亮。
 */
export function TreeNodeRows({
  byParent, parentId, depth, open, onToggle, selectedId, onSelect,
  testidPrefix = 'bank-tree-node', toggleTestidPrefix = 'bank-tree-toggle',
  selectTitle = '按该节点筛题', renderTrailing,
  editingRow = null, insertRow = null, maxIndentDepth, hScroll = false, skipRootNames,
}: TreeNodeRowsProps) {
  const rawChildren = byParent.get(parentId) ?? [];
  // 0054 R-049②：去根层（只作用于顶层 depth===0）——命中名的顶层节点不渲染，其 children 顶上第一级
  const children = depth === 0 && skipRootNames && skipRootNames.length > 0
    ? rawChildren.flatMap((n) => (skipRootNames.includes(n.name) ? (byParent.get(n.id) ?? []) : [n]))
    : rawChildren;
  // 六轮目检：缩进封顶——超过 maxIndentDepth 的层不再加深
  const indentDepth = maxIndentDepth === undefined ? depth : Math.min(depth, maxIndentDepth);
  const indentStyle = { paddingLeft: `calc(${indentDepth} * 1.1rem + 8px)` };
  // 七轮目检：行样式两态——缺省 ellipsis 自我裁剪；hScroll=按内容完整宽度（容器横向滚动）
  const rowStyle = {
    ...indentStyle, lineHeight: 1.7, whiteSpace: 'nowrap' as const, cursor: 'pointer',
    display: 'flex', alignItems: 'center',
    ...(hScroll
      ? { width: 'max-content', minWidth: '100%' }
      : { overflow: 'hidden', textOverflow: 'ellipsis' }),
  };
  return (
    <>
      {children.map((n) => {
        const hasChildren = (byParent.get(n.id)?.length ?? 0) > 0;
        const expanded = open.has(n.id);
        const selected = selectedId === n.id;
        const editing = editingRow !== null && editingRow.id === n.id;
        return (
          <div key={n.id}>
            {editing ? (
              // 0044 目检三轮：原位行内编辑（输入框替换整行，缩进与原行一致）
              <div
                style={{ ...indentStyle, lineHeight: 1.7, display: 'flex', alignItems: 'center', gap: 4 }}
              >
                <input
                  autoFocus
                  className="input"
                  data-testid={editingRow.testid}
                  value={editingRow.value}
                  style={{ flex: 1, minWidth: 0, fontSize: '0.8rem', padding: '3px 8px' }}
                  onChange={(e) => editingRow.onChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') editingRow.onConfirm();
                    if (e.key === 'Escape') editingRow.onCancel();
                  }}
                />
                <button
                  className="btn btn-sm btn-primary"
                  data-testid={editingRow.confirmTestid}
                  disabled={!editingRow.value.trim()}
                  style={{ flex: 'none', padding: '2px 8px' }}
                  onClick={(e) => { e.stopPropagation(); editingRow.onConfirm(); }}
                >✓</button>
                <button
                  className="btn btn-sm"
                  style={{ flex: 'none', padding: '2px 8px' }}
                  onClick={(e) => { e.stopPropagation(); editingRow.onCancel(); }}
                >✕</button>
              </div>
            ) : (
            <div
              data-testid={`${testidPrefix}-${n.id}`}
              className={selected ? 'tree-row active' : 'tree-row'}
              style={rowStyle}
              onClick={() => onSelect(n.id)}
              title={selectTitle === null || selected ? undefined : selectTitle}
            >
              {hasChildren ? (
                <button
                  className="tree-arrow"
                  data-testid={`${toggleTestidPrefix}-${n.id}`}
                  aria-expanded={expanded}
                  onClick={(e) => { e.stopPropagation(); onToggle(n.id); }}
                  style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0, width: '1.2em' }}
                >
                  {expanded ? '▾' : '▸'}
                </button>
              ) : (
                <span style={{ display: 'inline-block', width: '1.2em' }} />
              )}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{n.name}</span>
              {renderTrailing ? renderTrailing(n) : null}
            </div>
            )}
            {hasChildren && expanded && (
              <TreeNodeRows
                byParent={byParent} parentId={n.id} depth={depth + 1} open={open}
                onToggle={onToggle} selectedId={selectedId} onSelect={onSelect}
                testidPrefix={testidPrefix} toggleTestidPrefix={toggleTestidPrefix} selectTitle={selectTitle}
                editingRow={editingRow} insertRow={insertRow}
                maxIndentDepth={maxIndentDepth} hScroll={hScroll}
                {...(renderTrailing ? { renderTrailing } : {})}
              />
            )}
            {/* 五轮返工①：插入行 per-node 渲染——叶子夹（无子夹）不产生子级递归层，
                层末尾方案对「在尚无子夹的夹下新建」永不渲染（用户实测深层目录新建不可见）。
                条件=该节点本身展开即可（无需已有子夹）；缩进=子级深度。 */}
            {insertRow !== null && insertRow.afterParentId === n.id && expanded && (
              <div style={{ paddingLeft: `calc(${maxIndentDepth === undefined ? depth + 1 : Math.min(depth + 1, maxIndentDepth)} * 1.1rem + 8px)`, width: hScroll ? 'max-content' : undefined, minWidth: hScroll ? '100%' : undefined }}>{insertRow.node}</div>
            )}
          </div>
        );
      })}
      {/* 插入行：仅顶级层（parentId=''）在层末尾渲染（顶级新建，无缩进） */}
      {insertRow !== null && insertRow.afterParentId === parentId && parentId === '' && insertRow.node}
    </>
  );
}
