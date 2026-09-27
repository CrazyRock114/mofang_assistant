// 0044 P2：试卷管理页（#/papers）——呈现依据 `paper-manager 设计稿` v5（冻结稿）。
//
// 结构：左栏可嵌套文件夹树（全部试卷 / 未分类 / 自定义夹 + 新建文件夹 + 右键子夹/重命名/删除
// + 底部回收站）+ 右区（页头统计 / 试卷·试题篮双 tab / 搜索·状态筛选·新建工具条 / 状态分段卡网格）。
//
// 拍板口径：
//   D-060  一卷一夹；删除=入回收站；搜索仅卷名；不做缩略图；旧 #/basket 重定向本页
//   D-061⑧ 卡片无顶部色块、无来源标识——所有试卷一视同仁
//   D-062  文件夹可嵌套；删夹=卷回未分类+子夹上移一级；卡片归属行显示嵌套路径
//   D-063  文件夹一律默认折叠、点击-展开（同知识点树 TreeRows 口径）；展开态会话内记忆
//
// 试卷 tab 只收 composing/done/archived（basket 走试题篮 tab，0011 多篮体系不动）；
// 排版中分段优先置顶。拖卡归类 = HTML5 drag + optimistic 更新（state 纯函数在 papers-logic）。

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PaperFolder, PaperStatus, PaperSummary } from '../../shared/contracts/bank-types.js';
import type { TreeNode } from '../../shared/contracts/bank-types.js';
import {
  useExtPageServices, MessageBanner, Modal, PageHeader, ConfirmButton, Field,
  type ExtPageServices, type PageMessage,
} from './ExtUi.js';
import { PAPER_STATUS_LABEL } from './paper-actions.js';
import { buildParentIndex, TreeNodeRows } from '../components/TreeRows.js';
import { FolderTreePicker } from '../components/FolderTreePicker.js';
import {
  applyFolderMove, filterPapers, folderByParent, folderPathOf, relativeTime,
  type FolderScope,
} from './papers-logic.js';

const STATUS_CHIP_KEYS: Array<{ key: PaperStatus | 'all'; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'basket', label: '试题篮' },
  { key: 'composing', label: '排版中' },
  { key: 'done', label: '已完成' },
  { key: 'archived', label: '已归档' },
];

// 目检返工⑤：去掉「试卷/试题篮」双 tab——试题篮并入试卷列表作为一个状态分段
const SECTION_ORDER: PaperStatus[] = ['basket', 'composing', 'done', 'archived']; // 三轮目检：试题篮段置顶
// 目检返工⑨：每个状态分段单页显示上限（约 3 行卡），超出出翻页器
const SECTION_PAGE_SIZE = 9;
/** 分段标题（PAPER_STATUS_LABEL.basket='草稿'，界面口径统一叫「试题篮」） */
const SECTION_LABEL: Record<PaperStatus, string> = { ...PAPER_STATUS_LABEL, basket: '试题篮' };

// 五轮目检②③：菜单布局/外观内联保底（papers.css 先于 theme.css 加载会被全局 .btn 覆盖——
// 布局关键样式直接内联，hover 变色仍由 CSS !important 承担）
const MENU_BOX_STYLE: React.CSSProperties = {
  position: 'absolute', right: 'calc(100% + 8px)', top: 0,
  display: 'flex', flexDirection: 'column', alignItems: 'stretch',
  zIndex: 60, minWidth: 132, padding: '5px 0', overflow: 'hidden',
  background: '#fffdf7', border: '1px solid #d5c8b0', borderRadius: 10,
  boxShadow: '0 8px 32px rgba(74, 52, 30, 0.16)',
};
const CTX_MENU_BOX_STYLE: React.CSSProperties = { ...MENU_BOX_STYLE, position: 'fixed' };
const MENU_ITEM_STYLE: React.CSSProperties = {
  display: 'block', width: '100%', textAlign: 'left',
  border: 'none', padding: '8px 14px', margin: 0,
  fontSize: '0.8rem', fontFamily: 'inherit', color: '#6b5f52', cursor: 'pointer',
};

export function PapersPage({ services }: { services?: ExtPageServices } = {}) {
  const svc = useExtPageServices(services);
  const [summaries, setSummaries] = useState<PaperSummary[]>([]);
  const [trashSummaries, setTrashSummaries] = useState<PaperSummary[]>([]);
  const [folders, setFolders] = useState<PaperFolder[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<PageMessage | null>(null);

  const [trashView, setTrashView] = useState(false);
  const [scope, setScope] = useState<FolderScope>('all');
  const [keyword, setKeyword] = useState('');
  const [statusFilter, setStatusFilter] = useState<PaperStatus | 'all'>('all');
  // D-063：展开态会话内记忆（组件 state = 本次进入页面的会话）
  const [openFolders, setOpenFolders] = useState<ReadonlySet<string>>(new Set<string>());

  const [menuFor, setMenuFor] = useState<string | null>(null);
  // 二轮目检：右键菜单跟鼠标坐标（fixed 定位）
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; folderId: string } | null>(null);
  // 三轮目检：行内编辑——重命名直接在该夹名字处变成输入框
  const [editingFolder, setEditingFolder] = useState<{ id: string; name: string } | null>(null);
  const [newFolder, setNewFolder] = useState<{ parentId: string | null } | null>(null);
  const [newFolderName, setNewFolderName] = useState('');
  // 二轮目检：批量选取与批量操作
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchMoveOpen, setBatchMoveOpen] = useState(false);
  const [batchTrashOpen, setBatchTrashOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<PaperSummary | null>(null);
  const [renameName, setRenameName] = useState('');
  const [moveTarget, setMoveTarget] = useState<PaperSummary | null>(null);
  const [moveChoice, setMoveChoice] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PaperSummary | null>(null);
  const [deleteFolderTarget, setDeleteFolderTarget] = useState<PaperFolder | null>(null);
  const [dragPaperId, setDragPaperId] = useState<string | null>(null);
  // 目检返工⑨：各状态分段的当前页（keyword/状态筛选变化时重置）
  const [sectionPage, setSectionPage] = useState<Record<string, number>>({});

  // 目检返工⑦：⋯菜单点外部/Esc 关闭（菜单内点击已 stopPropagation）
  useEffect(() => {
    if (!menuFor) return;
    const close = () => setMenuFor(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuFor(null); };
    document.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuFor]);

  // 二轮目检：文件夹右键菜单点外/Esc 关闭
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setCtxMenu(null); };
    document.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [ctxMenu]);

  const notify = setMessage;

  const reload = useCallback(async () => {
    const [list, trash, folderList] = await Promise.all([
      svc.ext.paper.listPapersEx(),
      svc.ext.paper.listPapersEx({ statuses: ['trashed'] }),
      svc.ext.paper.listFolders(),
    ]);
    setSummaries(list);
    setTrashSummaries(trash);
    setFolders(folderList);
    setLoading(false);
  }, [svc]);

  useEffect(() => {
    reload().catch((err) => {
      notify({ type: 'error', text: `试卷列表加载失败：${err instanceof Error ? err.message : String(err)}` });
      setLoading(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload]);

  const byParent = useMemo(() => folderByParent(folders), [folders]);
  // 共享 TreeRows 的输入形状（TreeNode；treeId 占位不参与行为）
  const treeNodes: TreeNode[] = useMemo(
    () => folders.map((f) => ({ id: f.id, treeId: 'paper-folders', parentId: f.parentId, name: f.name, sort: f.sort })),
    [folders],
  );
  const nodesByParent = useMemo(() => buildParentIndex(treeNodes, { sort: true }), [treeNodes]);

  const inTrashCount = trashSummaries.length;
  // 目检返工⑤：不再区分试卷/试题篮两个列表——全量卷走统一分段（试题篮=一种状态）

  const visiblePapers = useMemo(
    () => filterPapers(summaries, {
      keyword,
      ...(statusFilter !== 'all' ? { status: statusFilter } : {}),
      ...(scope !== 'all' ? { folder: scope, byParent } : {}),
    }),
    [summaries, keyword, statusFilter, scope, byParent],
  );

  const countIn = useCallback(
    (status: PaperStatus) => filterPapers(summaries, {
      status,
      ...(scope !== 'all' ? { folder: scope, byParent } : {}),
    }).length,
    [summaries, scope, byParent],
  );

  // ---------- 动作 ----------

  const refreshAfter = async (msg: PageMessage) => {
    try {
      await reload();
      notify(msg);
    } catch (err) {
      notify({ type: 'error', text: `刷新失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  const movePaper = async (paperId: string, folderId: string | null) => {
    // optimistic：先改本地 state（纯函数），失败回滚重拉
    setSummaries((prev) => applyFolderMove(prev, paperId, folderId));
    try {
      await svc.ext.paper.moveToFolder(paperId, folderId);
      notify({ type: 'success', text: folderId ? '已移动到文件夹' : '已移出文件夹（未分类）' });
    } catch (err) {
      notify({ type: 'error', text: `移动失败：${err instanceof Error ? err.message : String(err)}` });
      await reload().catch(() => {});
    }
  };

  const createFolder = async () => {
    if (!newFolder) return;
    const name = newFolderName.trim();
    if (!name) return;
    try {
      await svc.ext.paper.createFolder({ name, ...(newFolder.parentId ? { parentId: newFolder.parentId } : {}) });
      // 目检返工②：新建后自动展开父夹——「默认折叠」只在重新进入界面时生效，新建的夹必须立刻可见
      if (newFolder.parentId) {
        setOpenFolders((prev) => new Set(prev).add(newFolder.parentId!));
      }
      setNewFolder(null);
      setNewFolderName('');
      await refreshAfter({ type: 'success', text: `已新建文件夹「${name}」` });
    } catch (err) {
      notify({ type: 'error', text: `新建文件夹失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  // ---------- 二轮目检：批量选取与批量操作 ----------
  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const runBatch = async (label: string, action: (id: string) => Promise<unknown>) => {
    const ids = [...selectedIds];
    let ok = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        await action(id);
        ok++;
      } catch {
        failed++;
      }
    }
    setSelectedIds([]);
    await refreshAfter({
      type: failed > 0 ? 'error' : 'success',
      text: `批量${label} ${ids.length} 张：成功 ${ok}，失败 ${failed}`,
    });
  };

  const batchMoveTo = async (folderId: string | null) => {
    setBatchMoveOpen(false);
    await runBatch(folderId ? '移动' : '移出文件夹', (id) => svc.ext.paper.moveToFolder(id, folderId));
  };

  const batchTrash = async () => {
    setBatchTrashOpen(false);
    await runBatch('删除', (id) => svc.ext.paper.trashPaper(id));
  };

  const batchArchive = async () => {
    await runBatch('归档', (id) => svc.ext.paper.updatePaperStatus(id, 'archived'));
  };

  // 三轮目检：文件夹重命名——在该夹名字处行内编辑（右键菜单触发）
  const renameFolder = async () => {
    if (!editingFolder) return;
    const target = editingFolder;
    if (!target.name.trim()) { setEditingFolder(null); return; }
    try {
      await svc.ext.paper.renameFolder(target.id, target.name);
      setEditingFolder(null);
      await refreshAfter({ type: 'success', text: `已重命名为「${target.name.trim()}」` });
    } catch (err) {
      notify({ type: 'error', text: `重命名失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  const deleteFolder = async () => {
    if (!deleteFolderTarget) return;
    const target = deleteFolderTarget;
    setDeleteFolderTarget(null);
    try {
      await svc.ext.paper.deleteFolder(target.id);
      if (scope === target.id) setScope('all');
      await refreshAfter({ type: 'success', text: `已删除文件夹「${target.name}」（夹内试卷移入未分类，子夹上移一级）` });
    } catch (err) {
      notify({ type: 'error', text: `删除文件夹失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  const renamePaper = async () => {
    if (!renameTarget) return;
    try {
      await svc.ext.paper.updatePaperTitle(renameTarget.paper.id, renameName);
      setRenameTarget(null);
      await refreshAfter({ type: 'success', text: '已重命名' });
    } catch (err) {
      notify({ type: 'error', text: `重命名失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  const trashPaper = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    try {
      await svc.ext.paper.trashPaper(target.paper.id);
      await refreshAfter({ type: 'success', text: `「${target.paper.title}」已移入回收站` });
    } catch (err) {
      notify({ type: 'error', text: `删除失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  const restorePaper = async (id: string) => {
    try {
      await svc.ext.paper.restorePaper(id);
      await refreshAfter({ type: 'success', text: '已恢复到原状态' });
    } catch (err) {
      notify({ type: 'error', text: `恢复失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  const deleteForever = async (id: string) => {
    try {
      await svc.ext.paper.deleteForeverPaper(id);
      await refreshAfter({ type: 'success', text: '已彻底删除（题目仍在题库）' });
    } catch (err) {
      notify({ type: 'error', text: `彻底删除失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  // ---------- 树交互（容器级委托：行 closest 解析夹 id；折叠钮自身 stopPropagation） ----------

  // 五轮目检④：展开 folderId 的整条祖先链（深层目录插入行/子级必须全部祖先展开才可见）
  const expandFolderChain = (folderId: string) => {
    setOpenFolders((prev) => {
      const next = new Set(prev);
      const byId = new Map(folders.map((f) => [f.id, f]));
      let cur: string | undefined = folderId;
      let guard = 0;
      while (cur && guard++ < 128) {
        next.add(cur);
        cur = byId.get(cur)?.parentId;
      }
      return next;
    });
  };

  const folderIdFromEvent = (target: EventTarget | null): string | null => {
    const el = (target as HTMLElement | null)?.closest?.('[data-testid^="papers-tree-node-"]');
    if (!el) return null;
    const testid = el.getAttribute('data-testid') ?? '';
    return testid.slice('papers-tree-node-'.length) || null;
  };

  const onDropToFolder = async (e: React.DragEvent) => {
    const folderId = folderIdFromEvent(e.target);
    if (!folderId) return;
    const paperId = e.dataTransfer.getData('text/paper-id') || dragPaperId;
    if (!paperId) return;
    setDragPaperId(null);
    await movePaper(paperId, folderId);
  };

  // 目检返工④：拖拽悬停的落点行高亮（drop target 提示；直接操作 class 避免拖动中重渲）
  const onDragOverFolder = (e: React.DragEvent) => {
    const el = (e.target as HTMLElement | null)?.closest?.('[data-testid^="papers-tree-node-"]') as HTMLElement | null;
    if (!el) return;
    e.preventDefault();
    document.querySelectorAll('.pm-side .tree-row.drop-hot').forEach((n) => n.classList.remove('drop-hot'));
    el.classList.add('drop-hot');
  };
  const clearDragHot = () => {
    document.querySelectorAll('.pm-side .tree-row.drop-hot').forEach((n) => n.classList.remove('drop-hot'));
  };

  const toggleFolder = (id: string) => {
    setOpenFolders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  if (loading) return <div>加载中…</div>;

  // ---------- 渲染片段 ----------

  const folderRowCount = (id: FolderScope): number | null => {
    if (id === 'all') return summaries.length;
    if (id === 'uncategorized') return filterPapers(summaries, { folder: 'uncategorized' }).length;
    return filterPapers(summaries, { folder: id, byParent }).length;
  };

  const fixedFolderRow = (key: FolderScope, label: string, icon: string, testid: string) => (
    <div
      data-testid={testid}
      className={`folder ${scope === key && !trashView ? 'on' : ''}`}
      onClick={() => { setScope(key); setTrashView(false); }}
    >
      <span className="f-ico">{icon}</span>
      <span className="fname">{label}</span>
      <span className="cnt">{folderRowCount(key)}</span>
    </div>
  );

  const paperCard = (summary: PaperSummary, options: { basket?: boolean } = {}) => {
    const { paper, questionCount } = summary;
    const status = paper.status ?? 'basket';
    const dir = paper.folderId ? folderPathOf(folders, paper.folderId) : '';
    return (
      <div
        key={paper.id}
        data-testid={`papers-card-${paper.id}`}
        className="pcard"
        draggable={!options.basket}
        onDragStart={(e) => {
          e.dataTransfer.setData('text/paper-id', paper.id);
          setDragPaperId(paper.id);
        }}
        onDragEnd={() => setDragPaperId(null)}
      >
        <div className="body">
          {/* 二轮目检：批量选取勾选框 */}
          <label className="pcard-check" onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox"
              data-testid={`papers-card-check-${paper.id}`}
              checked={selectedIds.includes(paper.id)}
              onChange={() => toggleSelect(paper.id)}
            />
          </label>
          <div className="name" data-testid={`papers-card-title-${paper.id}`}>{paper.title}</div>
          <div className="meta">
            <span className={`pill ${status}`} data-testid={`papers-card-pill-${paper.id}`}>{PAPER_STATUS_LABEL[status]}</span>
            <span>{questionCount} 题 · {relativeTime(paper.createdAt)}</span>
          </div>
          <div className="acts">
            {status === 'composing' && (
              <button className="btn btn-primary btn-sm" data-testid={`papers-card-continue-${paper.id}`}
                onClick={() => { window.location.hash = `#/compose/${paper.id}`; }}>
                继续排版
              </button>
            )}
            {status === 'done' && (
              // 目检返工⑥：已定稿卡只留「查看」——进只读排版页，导出/新建副本在排版页内
              // 三轮目检⑥：查看=金色（与继续排版的橙区分）
              <button className="btn btn-gold btn-sm" data-testid={`papers-card-view-${paper.id}`}
                onClick={() => { window.location.hash = `#/compose/${paper.id}`; }}>
                查看
              </button>
            )}
            {status === 'archived' && (
              <button className="btn btn-ghost btn-sm" data-testid={`papers-card-unarchive-${paper.id}`}
                onClick={() => void svc.ext.paper.updatePaperStatus(paper.id, 'done').then(() => refreshAfter({ type: 'success', text: '已恢复为已定稿' }))
                  .catch((err) => notify({ type: 'error', text: `恢复失败：${err instanceof Error ? err.message : String(err)}` }))}>
                恢复为已定稿
              </button>
            )}
            {options.basket && (
              // 三轮目检⑥：打开试题篮=绿色（与继续排版的橙区分）
              <button className="btn btn-green btn-sm" data-testid={`papers-card-open-${paper.id}`}
                onClick={() => { window.location.hash = `#/basket/${paper.id}`; }}>
                打开试题篮
              </button>
            )}
            {/* 目检返工⑦ + 五轮目检⑥：⋯菜单（试题篮卡同款）——挂按钮 relative 包裹内、按钮左侧、纵向 */}
            <span className="more-wrap">
              <button className="btn btn-ghost btn-sm more" data-testid={`papers-card-more-${paper.id}`}
                onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === paper.id ? null : paper.id); }}>⋯</button>
              {menuFor === paper.id && (
                <span className="pcard-menu left" style={MENU_BOX_STYLE} onClick={(e) => e.stopPropagation()} data-testid={`papers-menu-${paper.id}`}>
                  <button style={MENU_ITEM_STYLE} data-testid="papers-menu-rename" onClick={() => { setRenameName(paper.title); setRenameTarget(summary); setMenuFor(null); }}>重命名</button>
                  <button style={MENU_ITEM_STYLE} data-testid="papers-menu-move" onClick={() => { setMoveChoice(paper.folderId ?? null); setMoveTarget(summary); setMenuFor(null); }}>移动到文件夹</button>
                  {status !== 'archived' && (
                    <button style={MENU_ITEM_STYLE} data-testid="papers-menu-archive" onClick={() => {
                      setMenuFor(null);
                      void svc.ext.paper.updatePaperStatus(paper.id, 'archived')
                        .then(() => refreshAfter({ type: 'success', text: '已归档' }))
                        .catch((err) => notify({ type: 'error', text: `归档失败：${err instanceof Error ? err.message : String(err)}` }));
                    }}>归档</button>
                  )}
                  {status === 'archived' && (
                    <button style={MENU_ITEM_STYLE} data-testid="papers-menu-unarchive" onClick={() => {
                      setMenuFor(null);
                      void svc.ext.paper.updatePaperStatus(paper.id, 'done')
                        .then(() => refreshAfter({ type: 'success', text: '已恢复为已定稿' }))
                        .catch((err) => notify({ type: 'error', text: `恢复失败：${err instanceof Error ? err.message : String(err)}` }));
                    }}>恢复为已定稿</button>
                  )}
                  <button style={{ ...MENU_ITEM_STYLE, color: '#b5493a' }} data-testid="papers-menu-delete" onClick={() => { setDeleteTarget(summary); setMenuFor(null); }}>删除</button>
                </span>
              )}
            </span>
          </div>
          {!options.basket && (
            <div className="fdir" data-testid={`papers-card-fdir-${paper.id}`}>📁 {dir || '未分类'}</div>
          )}
        </div>
      </div>
    );
  };

  const sectionOf = (status: PaperStatus, list: PaperSummary[]) => {
    if (list.length === 0) return null;
    // 目检返工⑨：分段内分页（单页上限 SECTION_PAGE_SIZE 张），翻页只影响本段
    const page = sectionPage[status] ?? 0;
    const pageCount = Math.max(1, Math.ceil(list.length / SECTION_PAGE_SIZE));
    const pageItems = list.slice(page * SECTION_PAGE_SIZE, (page + 1) * SECTION_PAGE_SIZE);
    return (
      <div key={status} data-testid={`papers-section-${status}`}>
        <div className="pm-group">{SECTION_LABEL[status]}（{list.length}）</div>
        <div className="pm-grid">{pageItems.map((s) => paperCard(s, { basket: status === 'basket' }))}</div>
        {pageCount > 1 && (
          <div className="pm-pager" data-testid={`papers-pager-${status}`}>
            <button className="btn btn-sm" data-testid={`papers-pager-prev-${status}`} disabled={page === 0}
              onClick={() => setSectionPage((p) => ({ ...p, [status]: Math.max(0, page - 1) }))}>‹ 上一页</button>
            <span className="pm-pager-info">第 {page + 1} / {pageCount} 页</span>
            <button className="btn btn-sm" data-testid={`papers-pager-next-${status}`} disabled={page >= pageCount - 1}
              onClick={() => setSectionPage((p) => ({ ...p, [status]: Math.min(pageCount - 1, page + 1) }))}>下一页 ›</button>
          </div>
        )}
      </div>
    );
  };

  const composingCount = countIn('composing');
  const basketCount = countIn('basket');
  const doneCount = countIn('done');
  const archivedCount = countIn('archived');

  return (
    <div className="papers-page" data-testid="papers-page">
      <PageHeader title="试卷管理" backHref="#/" />
      <MessageBanner message={message} />
      <div className="pm">
        {/* ===== 左栏：文件夹树（D-063 默认折叠、点击展开） ===== */}
        <aside className="pm-side" data-testid="papers-side">
          <h4>文件夹</h4>
          {fixedFolderRow('all', '全部试卷', '🗂', 'papers-folder-row-all')}
          {fixedFolderRow('uncategorized', '未分类', '📥', 'papers-folder-row-uncategorized')}
          <div
            className="pm-tree-scroll"
            onContextMenu={(e) => {
              const folderId = folderIdFromEvent(e.target);
              if (!folderId) { setCtxMenu(null); return; }
              e.preventDefault();
              // 二轮目检：菜单出现在鼠标附近（clamp 防溢出屏幕）
              setCtxMenu({
                x: Math.min(e.clientX, window.innerWidth - 170),
                y: Math.min(e.clientY, window.innerHeight - 110),
                folderId,
              });
            }}
            onDragOver={(e) => {
              if (folderIdFromEvent(e.target)) { e.preventDefault(); onDragOverFolder(e); }
            }}
            onDragLeave={clearDragHot}
            onDrop={(e) => { clearDragHot(); void onDropToFolder(e); }}
          >
            <TreeNodeRows
              byParent={nodesByParent}
              parentId=""
              depth={0}
              open={openFolders}
              onToggle={toggleFolder}
              selectedId={scope !== 'all' && scope !== 'uncategorized' ? scope : ''}
              onSelect={(id) => { setScope(id); setTrashView(false); }}
              testidPrefix="papers-tree-node"
              toggleTestidPrefix="papers-tree-toggle"
              selectTitle={null}
              // 七轮目检：保留逐层缩进 + 深层内容横向滚动（不压缩行宽）
              hScroll
              // 三轮目检③：重命名=原位行内编辑（该夹名字处直接变成输入框）
              editingRow={editingFolder ? {
                id: editingFolder.id,
                value: editingFolder.name,
                onChange: (v) => setEditingFolder({ id: editingFolder.id, name: v }),
                onConfirm: () => void renameFolder(),
                onCancel: () => setEditingFolder(null),
                testid: 'papers-folder-rename-input',
                confirmTestid: 'papers-folder-rename-confirm',
              } : null}
              // 三轮目检③：新建子夹=原位命名行（插在目标父夹子级末尾；顶级=顶级层末尾）
              insertRow={newFolder ? {
                afterParentId: newFolder.parentId ?? '',
                node: (
                  <div className="tree-row folder inline-new">
                    <input
                      autoFocus
                      className="input"
                      data-testid="papers-newchild-input"
                      value={newFolderName}
                      placeholder={newFolder.parentId ? `建于「${folderPathOf(folders, newFolder.parentId)}」` : '新文件夹名'}
                      onChange={(e) => setNewFolderName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void createFolder();
                        if (e.key === 'Escape') { setNewFolder(null); setNewFolderName(''); }
                      }}
                    />
                    <button className="btn btn-sm btn-primary" data-testid="papers-newchild-confirm"
                      disabled={!newFolderName.trim()} onClick={() => void createFolder()}>✓</button>
                    <button className="btn btn-sm" onClick={() => { setNewFolder(null); setNewFolderName(''); }}>✕</button>
                  </div>
                ),
              } : null}
            />
          </div>
          {/* 目检返工①：建夹入口统一——选中具体夹时按钮即「在其内新建」（不必右键），未选中=建顶级；右键入口保留 */}
          <div className="folder new" data-testid="papers-create-folder"
            onClick={() => {
              const parentId = scope !== 'all' && scope !== 'uncategorized' ? scope : null;
              setNewFolder({ parentId });
              setNewFolderName('');
              // 三轮目检③ + 五轮目检④：命名行出现在树中目标位置——需展开整条祖先链（仅展开父夹不够）
              if (parentId) expandFolderChain(parentId);
            }}>
            {/* 九轮目检：按钮文案固定，父级信息由命名行 placeholder 传达 */}
            ＋ 新建文件夹
          </div>
          <div className="side-note">
            文件夹可嵌套且<b>默认折叠</b>：点 ▸ 展开子夹。右键文件夹=新建子文件夹/删除（删夹不删卷——卷回「未分类」，子夹上移一级）。试卷卡可拖到文件夹归类。
          </div>
          <div className="side-sp" />
          <div
            data-testid="papers-trash-entry"
            data-count={inTrashCount}
            className={`folder trash ${trashView ? 'on' : ''}`}
            onClick={() => setTrashView(true)}
          >
            <span className="f-ico">🗑</span>
            <span className="fname">回收站</span>
            <span className="cnt">{inTrashCount}</span>
          </div>
        </aside>

        {/* ===== 右主区 ===== */}
        <main className="pm-main">
          {trashView ? (
            <>
              <div className="pm-head">
                <div>
                  <h1>回收站</h1>
                  <div className="sub">已删除 {inTrashCount} 张试卷（可恢复到删除前的状态）</div>
                </div>
                <button className="btn btn-ghost" onClick={() => setTrashView(false)}>返回试卷列表</button>
              </div>
              <div className="pm-scroll">
              <div className="pm-grid" data-testid="papers-trash-list">
                {trashSummaries.length === 0 && <p className="muted">回收站为空。</p>}
                {trashSummaries.map((s) => (
                  <div key={s.paper.id} className="pcard" data-testid={`papers-trash-card-${s.paper.id}`}>
                    <div className="body">
                      <div className="name">{s.paper.title}</div>
                      <div className="meta"><span className="pill trashed">回收站</span><span>{s.questionCount} 题</span></div>
                      <div className="acts">
                        <button className="btn btn-green btn-sm" data-testid={`papers-restore-${s.paper.id}`} onClick={() => void restorePaper(s.paper.id)}>恢复</button>
                        <ConfirmButton
                          testid={`papers-delete-forever-${s.paper.id}`}
                          label="彻底删除"
                          confirmLabel="确认彻底删除？"
                          onConfirm={() => void deleteForever(s.paper.id)}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              </div>
            </>
          ) : (
            <>
              <div className="pm-head">
                <div>
                  <h1>试卷管理</h1>
                  <div className="sub" data-testid="papers-stat-sub">
                    {scope === 'all' ? '全部试卷' : scope === 'uncategorized' ? '未分类' : folderPathOf(folders, scope)} · {visiblePapers.length} 张
                    （试题篮 {basketCount} · 排版中 {composingCount} · 已完成 {doneCount} · 已归档 {archivedCount}）
                  </div>
                </div>
                <button className="btn btn-primary" data-testid="papers-new-paper" onClick={async () => {
                  try {
                    // 目检返工⑧：createPaperEx 扩展方法在真桥无 IPC 通道（IpcExtClient unwired）——
                    // 走既有 bank.paper.create 通道；三轮目检①：新建落「试题篮」状态并进入篮详情页（非排版间）
                    const paper = await svc.bank.createPaper('未命名试题篮');
                    window.location.hash = `#/basket/${paper.id}`;
                  } catch (err) {
                    notify({ type: 'error', text: `新建失败：${err instanceof Error ? err.message : String(err)}` });
                  }
                }}>＋ 新建试卷</button>
              </div>

              {/* 目检返工⑤：去掉「试卷/试题篮」双 tab——试题篮并入下方状态分段 */}
              <div className="pm-tools">
                <div className="pm-search">🔍 <input
                  placeholder="搜索卷名…"
                  value={keyword}
                  data-testid="papers-search-input"
                  onChange={(e) => { setKeyword(e.target.value); setSectionPage({}); }}
                /></div>
                <div className="pm-filter">
                  {STATUS_CHIP_KEYS.map(({ key, label }) => (
                    <span key={key}
                      data-testid={`papers-chip-${key}`}
                      className={`fchip ${statusFilter === key ? 'on' : ''}`}
                      onClick={() => { setStatusFilter(key); setSectionPage({}); }}>{label}</span>
                  ))}
                </div>
                <span className="sp" />
                <span className="muted pm-sort-hint">按创建时间排序 ▾</span>
              </div>

              {/* 二轮目检：批量操作条（选中 > 0 出现；逐张循环既有通道，失败计数不中断）——固定不随滚动 */}
              {selectedIds.length > 0 && (
                <div className="selection-bar" data-testid="papers-batch-bar" data-selected-count={selectedIds.length}>
                  <strong>已选 {selectedIds.length} 张</strong>
                  <span style={{ flex: 1 }} />
                  <button className="btn btn-sm" data-testid="papers-batch-move" onClick={() => { setMoveChoice(null); setBatchMoveOpen(true); }}>移动到文件夹…</button>
                  <button className="btn btn-sm" data-testid="papers-batch-archive" onClick={() => void batchArchive()}>批量归档</button>
                  <button className="btn btn-sm btn-danger" data-testid="papers-batch-trash" onClick={() => setBatchTrashOpen(true)}>批量删除</button>
                  <button className="btn btn-sm" data-testid="papers-batch-clear" onClick={() => setSelectedIds([])}>取消选择</button>
                </div>
              )}

              {/* 三轮目检④：只有试题区滚动（左栏/页头/搜索条固定） */}
              <div className="pm-scroll">
                {statusFilter === 'all' ? (
                  SECTION_ORDER.map((status) => sectionOf(status, visiblePapers.filter((s) => (s.paper.status ?? 'basket') === status)))
                ) : (
                  sectionOf(statusFilter, visiblePapers)
                )}
                {visiblePapers.length === 0 && <p className="muted">没有匹配的试卷。</p>}
              </div>
            </>
          )}
        </main>
      </div>

      {/* ===== 弹层族 ===== */}
      {/* 二轮目检：右键菜单跟鼠标坐标（fixed），点外/Esc 关闭 */}
      {ctxMenu && (
        <div
          className="pcard-menu ctx"
          data-testid="papers-ctxmenu"
          style={{ ...CTX_MENU_BOX_STYLE, left: ctxMenu.x, top: ctxMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button style={MENU_ITEM_STYLE} data-testid="papers-menu-newchild" onClick={() => {
            // 插入行渲染在该夹子级末尾——祖先链有折叠则不可见，展开整条链
            expandFolderChain(ctxMenu.folderId);
            setNewFolder({ parentId: ctxMenu.folderId });
            setNewFolderName('');
            setCtxMenu(null);
          }}>新建子文件夹</button>
          <button style={MENU_ITEM_STYLE} data-testid="papers-menu-rename-folder" onClick={() => {
            const target = folders.find((f) => f.id === ctxMenu.folderId);
            setEditingFolder({ id: ctxMenu.folderId, name: target?.name ?? '' });
            setCtxMenu(null);
          }}>重命名</button>
          <button style={MENU_ITEM_STYLE} data-testid="papers-menu-delete-folder" onClick={() => { setDeleteFolderTarget(folders.find((f) => f.id === ctxMenu.folderId) ?? null); setCtxMenu(null); }}>删除文件夹</button>
        </div>
      )}



      {renameTarget && (
        <Modal title="重命名试卷" onClose={() => setRenameTarget(null)}>
          <Field label="卷名">
            <input className="input" data-testid="papers-rename-input" value={renameName} onChange={(e) => setRenameName(e.target.value)} />
          </Field>
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => setRenameTarget(null)}>取消</button>
            <button className="btn btn-primary" data-testid="papers-rename-confirm" disabled={!renameName.trim()} onClick={() => void renamePaper()}>保存</button>
          </div>
        </Modal>
      )}

      {moveTarget && (
        <Modal title="移动到文件夹" onClose={() => setMoveTarget(null)}>
          <FolderTreePicker
            folders={folders}
            value={moveChoice}
            onChange={(id) => setMoveChoice(id)}
            onCreateFolder={async (name, parentId) => {
              const created = await svc.ext.paper.createFolder({ name, ...(parentId ? { parentId } : {}) });
              await reload().catch(() => {});
              return created.id;
            }}
          />
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '0.9rem' }}>
            <button className="btn" onClick={() => setMoveTarget(null)}>取消</button>
            <button className="btn btn-primary" data-testid="papers-move-confirm" onClick={() => {
              const target = moveTarget;
              setMoveTarget(null);
              if (target) void movePaper(target.paper.id, moveChoice);
            }}>保存</button>
          </div>
        </Modal>
      )}

      {deleteTarget && (
        <Modal title="删除试卷" onClose={() => setDeleteTarget(null)}>
          <p data-testid="papers-delete-text" style={{ marginTop: 0 }}>
            将「{deleteTarget.paper.title}」移入回收站？之后可在回收站恢复或彻底删除。
          </p>
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => setDeleteTarget(null)}>取消</button>
            <button className="btn btn-danger" data-testid="papers-delete-confirm" onClick={() => void trashPaper()}>确认删除</button>
          </div>
        </Modal>
      )}

      {/* 二轮目检：批量移动（树选择器选目标夹） */}
      {batchMoveOpen && (
        <Modal title={`批量移动 ${selectedIds.length} 张到文件夹`} onClose={() => setBatchMoveOpen(false)}>
          <FolderTreePicker
            folders={folders}
            value={moveChoice}
            onChange={(id) => setMoveChoice(id)}
            onCreateFolder={async (name, parentId) => {
              const folder = await svc.ext.paper.createFolder({ name, ...(parentId ? { parentId } : {}) });
              await reload().catch(() => {});
              return folder.id;
            }}
          />
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '0.9rem' }}>
            <button className="btn" onClick={() => setBatchMoveOpen(false)}>取消</button>
            <button className="btn btn-primary" data-testid="papers-batch-move-confirm" onClick={() => void batchMoveTo(moveChoice)}>确认移动</button>
          </div>
        </Modal>
      )}

      {/* 二轮目检：批量删除（入回收站）应用内一次确认 */}
      {batchTrashOpen && (
        <Modal title="批量删除" onClose={() => setBatchTrashOpen(false)}>
          <p data-testid="papers-batch-trash-text" style={{ marginTop: 0 }}>
            将选中的 {selectedIds.length} 张试卷移入回收站？之后可在回收站恢复或彻底删除。
          </p>
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => setBatchTrashOpen(false)}>取消</button>
            <button className="btn btn-danger" data-testid="papers-batch-trash-confirm" onClick={() => void batchTrash()}>确认删除</button>
          </div>
        </Modal>
      )}

      {deleteFolderTarget && (
        <Modal title="删除文件夹" onClose={() => setDeleteFolderTarget(null)}>
          <p style={{ marginTop: 0 }}>
            将删除文件夹「{deleteFolderTarget.name}」。夹内试卷将移回「未分类」，子文件夹上移一级（不删除任何试卷）。
          </p>
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => setDeleteFolderTarget(null)}>取消</button>
            <button className="btn btn-danger" data-testid="papers-deletefolder-confirm" onClick={() => void deleteFolder()}>确认删除</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

