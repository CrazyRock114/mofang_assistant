/**
 * 0039：树归档名约定（树收敛的软删表示法）
 *
 * trees 表无 status 列，任务书 §二「预期无迁移，如确需 schema 变更停下申报」，故归档态以
 * 树名后缀表示：`（已归档·0039）`。约定要点：
 *   - 不改站名前缀：siteOfTree 仍按「菁优网·/组卷网·」定站（后缀不影响前缀匹配）；
 *   - 原名可无损还原（archivedNameOf 幂等）；判定只用 isArchivedTreeName（唯一状态源）；
 *   - 读侧统一过滤：TreeServiceImpl.listTrees 默认剔归档（includeArchived 取全量）、
 *     锚点快照（D-050① 多来源/教材树不进锚点清单）、采集建树目标（capture/tree-collect）。
 *
 * 纯模块（零依赖）：mock（renderer 图）与主进程共用同一谓词，避免把 bank/db 拖进前端编译图。
 */

/** 归档标记：树名后缀（唯一状态源） */
export const TREE_ARCHIVE_SUFFIX = '（已归档·0039）';

/** 树名 → 归档名（幂等：已带后缀原样返回） */
export function archivedNameOf(name: string): string {
  return name.endsWith(TREE_ARCHIVE_SUFFIX) ? name : `${name}${TREE_ARCHIVE_SUFFIX}`;
}

/** 是否已归档（软删态）——列表过滤与采集守卫共用 */
export function isArchivedTreeName(name: string): boolean {
  return name.endsWith(TREE_ARCHIVE_SUFFIX);
}
