// 0044 P2：试卷管理页纯逻辑（state 层可测函数；组件只做渲染与 IPC 调用）。
// 文件夹树索引/路径（D-062 嵌套口径）、卷过滤（仅卷名搜索 D-060⑤ + 状态筛选 + 文件夹范围）、
// 拖卡归类的 state 纯函数、相对时间分档。

import type { PaperFolder, PaperStatus, PaperSummary } from '../../shared/contracts/bank-types.js';

/** 左栏文件夹过滤范围：all=全部试卷 / uncategorized=未分类 / 其余=具体夹 id */
export type FolderScope = 'all' | 'uncategorized' | (string & {});

/**
 * 父子索引（复用 0040 TreeRows.buildParentIndex 的同构口径：parentId 悬空按顶级）。
 * PaperFolder → 树形状（treeId 占位 'paper-folders'，匹配共享 TreeNodeRows 的输入形状）。
 */
export function folderByParent(folders: PaperFolder[]): Map<string, PaperFolder[]> {
  const ids = new Set(folders.map((f) => f.id));
  const byParent = new Map<string, PaperFolder[]>();
  for (const f of folders) {
    const key = f.parentId && ids.has(f.parentId) ? f.parentId : '';
    const list = byParent.get(key);
    if (list) list.push(f);
    else byParent.set(key, [f]);
  }
  return byParent;
}

/** 嵌套路径（「七年级数学·上 / 单元测」，D-062 卡片归属行口径）；夹不存在返回空串 */
export function folderPathOf(folders: PaperFolder[], folderId: string): string {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const parts: string[] = [];
  let cur: string | undefined = folderId;
  let guard = 0;
  while (cur && guard++ < 128) {
    const f = byId.get(cur);
    if (!f) return ''; // 悬空引用：不拼半截路径
    parts.unshift(f.name);
    cur = f.parentId;
  }
  return parts.join(' / ');
}

/** 该夹的子树集合（含自身）——父夹选中=含子树口径 */
export function folderSubtreeIds(byParent: Map<string, PaperFolder[]>, rootId: string): Set<string> {
  const out = new Set<string>();
  const walk = (id: string) => {
    if (out.has(id) || out.size > 10000) return; // 访问集防数据环
    out.add(id);
    for (const child of byParent.get(id) ?? []) walk(child.id);
  };
  walk(rootId);
  return out;
}

export interface PaperFilterOptions {
  keyword?: string;
  status?: PaperStatus;
  /** all / uncategorized / 夹 id；缺省 all（不按夹过滤） */
  folder?: FolderScope;
  /** 父夹选中=含子树的索引（folder 传夹 id 时使用） */
  byParent?: Map<string, PaperFolder[]>;
}

/** 卷过滤：搜索**仅卷名**（D-060⑤，非卷名字段不参与）+ 状态 + 文件夹范围 */
export function filterPapers(summaries: PaperSummary[], opts: PaperFilterOptions): PaperSummary[] {
  const keyword = opts.keyword?.trim() ?? '';
  let scope: Set<string> | null = null;
  if (opts.folder && opts.folder !== 'all') {
    if (opts.folder === 'uncategorized') {
      return summaries.filter((s) => !s.paper.folderId
        && (!opts.status || (s.paper.status ?? 'basket') === opts.status)
        && (!keyword || s.paper.title.includes(keyword)));
    }
    scope = folderSubtreeIds(opts.byParent ?? folderByParent([]), opts.folder);
  }
  return summaries.filter((s) => {
    if (keyword && !s.paper.title.includes(keyword)) return false;
    if (opts.status && (s.paper.status ?? 'basket') !== opts.status) return false;
    if (scope && !scope.has(s.paper.folderId ?? '')) return false;
    return true;
  });
}

/** 拖卡归类 state 纯函数（不可变：返回新数组；optimistic 更新用） */
export function applyFolderMove(summaries: PaperSummary[], paperId: string, folderId: string | null): PaperSummary[] {
  return summaries.map((s) => (s.paper.id === paperId
    ? {
        ...s,
        paper: (folderId === null
          ? (() => { const { folderId: _drop, ...rest } = s.paper; void _drop; return rest; })()
          : { ...s.paper, folderId }),
      }
    : s));
}

/** 相对时间（卡片 meta 行；NOW 注入便于测试）：分钟内=刚刚 / 小时内=N 分钟前 / 昨天 / MM-DD */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diffMs = now.getTime() - t;
  if (diffMs < 60_000) return '刚刚';
  if (diffMs < 3_600_000) {
    const minutes = Math.floor(diffMs / 60_000);
    return `${minutes} 分钟前`;
  }
  const nowDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const tDay = Date.UTC(new Date(iso).getUTCFullYear(), new Date(iso).getUTCMonth(), new Date(iso).getUTCDate());
  if (nowDay - tDay === 86_400_000) return '昨天';
  const m = `${new Date(iso).getUTCMonth() + 1}`.padStart(2, '0');
  const d = `${new Date(iso).getUTCDate()}`.padStart(2, '0');
  return `${m}-${d}`;
}
