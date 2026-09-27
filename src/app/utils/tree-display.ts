// 0054（R-049①②）：知识树呈现层的两个共享常量与显示层纯函数。
//
// 纪律：本模块**只用于显示**——树名/根层名一律不在数据层改写（`tree.name` 原文决定
// `siteOfTree` 定站与 0039 树收敛分组，落库数据零改动）。词缀剥除只认两字面形态，
// 不猜不模糊匹配（版本/册次后缀照原样保留）。

/**
 * 站来源前缀（采集链拼死在树名里，`src/capture/tree-collect.ts`）：
 * 组卷网知识点树 = `组卷网·知识点·{学段}{学科}`；菁优知识点树 = `菁优网·知识点·{学段}{学科}·{版本}{册次}`。
 * 注意：`组卷网·教材·…` 是章节树前缀，**不在剥离清单内**（沿用站点原文命名）。
 */
export const TREE_SOURCE_PREFIXES: readonly string[] = ['组卷网·知识点·', '菁优网·知识点·'];

/**
 * 树根层名（R-049②：「综合库」是采集链的根节点名——`tree-collect.ts` 根 title 缺省回落值，
 * 且该根自身也是可挂节点）。消费方传入 `TreeRows.skipRootNames` 时该层不渲染、其子级顶上第一级。
 */
export const TREE_ROOT_NAMES: readonly string[] = ['综合库'];

/**
 * 树名显示层剥来源前缀；无前缀/剥后为空一律原样返回（不产生空选项）。
 * 例：`组卷网·知识点·初中物理` → `初中物理`；`菁优网·知识点·高中物理·人教版必修一` → `高中物理·人教版必修一`。
 */
export function displayTreeName(name: string): string {
  for (const prefix of TREE_SOURCE_PREFIXES) {
    if (!name.startsWith(prefix)) continue;
    const rest = name.slice(prefix.length);
    if (rest !== '') return rest;
  }
  return name;
}
