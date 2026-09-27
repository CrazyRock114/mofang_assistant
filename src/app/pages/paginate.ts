// 0004-fix-4 2.1：分页预览的块级装箱器（纯函数 + 测量分离，可单测的可迁移资产）。
// 规则（注入运行时 preview-frame-runtime.js 直接消费本模块，单一来源）：
//   · 装箱单位 = 段级单元（题首 / 段落块 / 图块 / 选项区 / 作答区 / 公式容器…）；
//     0007 P5：planFlow 段级装箱（同组单元归并片段 + keepWithNext 题首防孤），
//     planPages/planColumns 为同实现的块级/列级视图（每块自成片段）；
//   · 贪心装箱：单元序依序放入当前容器，放不下 → 整单元推下一容器（单元内不拆行）；
//   · 超容量单元（罕见）：独占容器 + 溢出标记（渲染侧截断并打标）。
// 测量侧（浏览器）负责给出单元高 px；本模块只做纯计算，故可脱离 DOM 单测。
// 差异标注：分页含段级装箱 + 长文段内行级断页（0007 P6，行盒断点拆「前段+残段」），
// 字体回退/渲染细节与导出 PDF 仍可能有出入（精确分页以导出 PDF 为准）。

/** 装箱输入块（key=稳定标识便于探针断言；heightPx=块自身高 px，不含外边距——
 *  0007 P1 起外边距经 marginTopPx/marginBottomPx 单列，装箱按折叠口径累计；
 *  边距缺省 = 0，heightPx 视为含边距全量（旧调用方语义不变）） */
export interface PageBlockSpec {
  key: string;
  heightPx: number;
  /** 块上外边距 px（可选，≥0） */
  marginTopPx?: number;
  /** 块下外边距 px（可选，≥0） */
  marginBottomPx?: number;
}

/** 一页的装箱结果 */
export interface PlannedPage {
  blocks: PageBlockSpec[];
  /** 该页含超页高块（独占页 + 溢出截断标记） */
  overflowWarn: boolean;
}

export interface PaginationPlan {
  pages: PlannedPage[];
  /** 溢出块总数（诚实 UI 标记/探针用） */
  overflowCount: number;
}

/** mm → px（96dpi，与 PaperPreviewFrame.mmToPx 同源换算） */
export function mmToPx(mm: number): number {
  return (mm * 96) / 25.4;
}

/** 页内容高 px = 页高 − 上下页边距（装箱容量；列数>1 时由调用方乘列数） */
export function pageContentHeightPx(pageHeightMm: number, marginTopMm: number, marginBottomMm: number): number {
  return Math.max(1, mmToPx(pageHeightMm) - mmToPx(marginTopMm) - mmToPx(marginBottomMm));
}

/**
 * 块级贪心装箱（纯函数）：
 * 依序把块放入当前页；当前页放不下 → 新开一页；块（含边距）> 页容量 → 独占一页并标 overflowWarn。
 * 空块序列 → 零页；容量非法（≤0）→ 按 1px 处理（每块独占页，不静默丢块）。
 *
 * 0007 P1 外边距折叠口径（与浏览器流式布局一致）：
 *   页内首块 = heightPx + mt + mb（页容器有 padding，顶边距不穿透折叠）；
 *   后续块增量 = heightPx + mb + max(0, mt − 前块 mb)（相邻边距取 max 折叠，非求和）。
 *
 * 0007 P5：本函数 = planFlow 的块级视图（每块自成片段，容器=页）——规则单一来源，
 * 段级消费方（注入运行时）直接用 planFlow，块级调用方与既有测试继续用本签名。
 */
export function planPages(blocks: PageBlockSpec[], contentHeightPx: number): PaginationPlan {
  const plan = planFlow(blocks, { capacityPx: contentHeightPx });
  return {
    pages: plan.containers.map((container) => ({
      blocks: flattenUnits(container.fragments),
      overflowWarn: container.overflowWarn,
    })),
    overflowCount: plan.overflowCount,
  };
}

/** 0007 P5：段级装箱单元（= 装箱最小单位：题首 / 段落块 / 图块 / 选项区 / 作答区 / 公式容器…）——
 *  group = 归属块 key（同 key 连续单元归并成同一片段；跨容器切分 → 续片段）；
 *  keepWithNext = 与下一单元绑定（题首+首段防孤：不可作片段末单元，断容器时随绑定链整页推走）。 */
export interface FlowUnitSpec extends PageBlockSpec {
  group?: string;
  keepWithNext?: boolean;
  /** 0007 P6：行盒高序列（px，按行序；运行时 Range 行盒懒测量注入，合计应 ≈ heightPx）。
   *  缺省 / 长度 <4 / keepWithNext 单元 = 不可拆，走段级路径（放不下整段推下一容器）。 */
  lineHeights?: number[];
  /** 0007 P6：拆片段标记（planFlow 输出侧字段，调用方勿设）——
   *  单元放不下当前容器剩余容量时按行盒边界拆分：of=原单元 key（渲染侧回映射用），
   *  startLine/lineCount=本片段在原行序列中的区间，totalLines=原行数。
   *  前段保留原 key；残段 key = `${of}#s${startLine}`（同组归并进续片段）。 */
  split?: { of: string; startLine: number; lineCount: number; totalLines: number };
}

/** 片段 = 一个块在一容器内的落位（group=null 表示独立块：抬头/文本块等不与题片段合并） */
export interface FlowFragmentPlan {
  group: string | null;
  /** 同组前有片段（跨容器切分）→ 渲染侧建 .mf-continued 续片段 */
  continued: boolean;
  units: FlowUnitSpec[];
}

/** 容器 = 页（单列）或列（双列 containersPerSheet=2） */
export interface FlowContainerPlan {
  fragments: FlowFragmentPlan[];
  /** 容器内容超容量（渲染侧独占 + 截断标记；二次校验兜底） */
  overflowWarn: boolean;
}

export interface FlowPlan {
  containers: FlowContainerPlan[];
  /** 溢出容器数（诚实 UI 标记/探针用） */
  overflowCount: number;
}

export interface PlanFlowOptions {
  /** 每容器内容容量 px */
  capacityPx: number;
  /** 首张 sheet 的容器容量 px（抬头通栏占位压缩；缺省 = capacityPx） */
  firstSheetCapacityPx?: number;
  /** 每张 sheet 的容器数（1=单列页；2=双列列盒）；仅决定首张 sheet 容量适用范围 */
  containersPerSheet?: number;
  /** 0007 P6：续片段「（续）」标记行高 px（渲染侧片段首行占位）——拆分产物的残段以此计顶边距，
   *  保证段内拆分到行盒边界的容器不被标记行顶破容量（段级续片段粒度松、由既有二次校验吸收，不加价）。
   *  缺省 0 = 不占位（块级视图/旧调用方语义不变）。 */
  continuedMarkerPx?: number;
}

/** 容差：折叠口径的浮点残差不触发溢出误判 */
const CAPACITY_EPSILON = 1e-6;

function heightOfUnit(unit: PageBlockSpec): number {
  return Number.isFinite(unit.heightPx) ? Math.max(0, unit.heightPx) : 0;
}
function marginTopOfUnit(unit: PageBlockSpec): number {
  return Number.isFinite(unit.marginTopPx) ? Math.max(0, unit.marginTopPx!) : 0;
}
function marginBottomOfUnit(unit: PageBlockSpec): number {
  return Number.isFinite(unit.marginBottomPx) ? Math.max(0, unit.marginBottomPx!) : 0;
}
function flattenUnits(fragments: FlowFragmentPlan[]): PageBlockSpec[] {
  const out: PageBlockSpec[] = [];
  for (const fragment of fragments) out.push(...fragment.units);
  return out;
}
function normalizeCapacity(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/**
 * 0007 P5 段级贪心装箱（纯函数；装箱粒度题级→段级）：
 * 单元依序落位——同组（group）连续单元归并进当前片段；组变/无组 → 新片段；片段不跨容器。
 * 容器放不下 → 新容器；离容器尾前先回取 keepWithNext 绑定链（题首+首段防孤），绑定链与新单元
 * 同容器落位（绑定优先于容量：超容量标 overflowWarn，不静默拆散）。
 * 单元（含边距）超容量 → 独占容器 + overflowWarn（渲染侧截断打标）；组跨容器 → 续片段 continued。
 * 容器内边距折叠口径与 planPages 逐点一致（容器首单元顶边距计入、相邻 max 折叠、跨容器重置）。
 *
 * 0007 P6 段内行级拆分（只增）：单元带 lineHeights（行盒高序列，运行时懒测量注入）且放不下
 * 当前容器剩余容量时，按行盒边界拆「前段（留当前容器）+ 残段（回工作串续排，成续片段）」；
 * 防孤行 orphans=widows=2——剩余空间放不下 2 行则整段推下一容器、残段不足 2 行则前段少带行补齐，
 * 行数 <4 不可兼得 → 不拆；无 lineHeights / keepWithNext 单元 → 段级路径不变。
 * 拆分产物的边距口径：前段让出尾边距（marginBottomPx=0，段下边距随末段落位）、残段顶边距 =
 * 续片段（续）标记行高占位（continuedMarkerPx，缺省 0）；
 * 拆得掉的超长单元不再标 overflowWarn（overflowWarn 收窄 = 真正放不下的段级单元）。
 */
export function planFlow(units: FlowUnitSpec[], options: PlanFlowOptions): FlowPlan {
  const perSheet = Math.max(1, Math.floor(options.containersPerSheet ?? 1));
  const baseCapacity = normalizeCapacity(options.capacityPx);
  const firstCapacity = options.firstSheetCapacityPx !== undefined
    ? normalizeCapacity(options.firstSheetCapacityPx)
    : baseCapacity;

  const containers: FlowContainerPlan[] = [];
  let current: FlowContainerPlan | null = null;
  let used = 0;
  let prevMarginBottom = 0;

  const capacityNow = (): number => (containers.length <= perSheet ? firstCapacity : baseCapacity);

  const openContainer = (): FlowContainerPlan => {
    const container: FlowContainerPlan = { fragments: [], overflowWarn: false };
    containers.push(container);
    used = 0;
    prevMarginBottom = 0;
    return container;
  };

  const append = (unit: FlowUnitSpec, group: string | null): void => {
    const fragments = current!.fragments;
    const last = fragments.length > 0 ? fragments[fragments.length - 1] : null;
    if (last && group !== null && last.group === group) last.units.push(unit);
    else fragments.push({ group, continued: false, units: [unit] });
  };

  const place = (unit: FlowUnitSpec, group: string | null): void => {
    const height = heightOfUnit(unit);
    const mt = marginTopOfUnit(unit);
    const mb = marginBottomOfUnit(unit);
    const first = current!.fragments.length === 0;
    const delta = first ? height + mt + mb : height + mb + Math.max(0, mt - prevMarginBottom);
    append(unit, group);
    used += delta;
    prevMarginBottom = mb;
    if (used > capacityNow() + CAPACITY_EPSILON) current!.overflowWarn = true;
  };

  const lineHeightSum = (heights: number[]): number =>
    heights.reduce((sum, h) => sum + (Number.isFinite(h) ? Math.max(0, h) : 0), 0);

  /** 0007 P6：放不下当前容器的带行盒单元按行边界拆分——前段就地落位，残段插回工作串（紧随当前位）。
   *  返回是否拆出（false → 调用方走段级路径：整单元推下一容器 / 独占标溢出）。 */
  const trySplitInline = (unit: FlowUnitSpec, group: string | null, work: FlowUnitSpec[], wi: number): boolean => {
    const heights = unit.lineHeights;
    if (!heights || heights.length < 4 || unit.keepWithNext) return false;
    const mt = marginTopOfUnit(unit);
    const avail = capacityNow() - used - Math.max(0, mt - prevMarginBottom);
    let k = 0;
    let acc = 0;
    for (let i = 0; i < heights.length; i++) {
      const lh = Number.isFinite(heights[i]) ? Math.max(0, heights[i]) : 0;
      if (acc + lh <= avail + CAPACITY_EPSILON) { acc += lh; k = i + 1; } else break;
    }
    if (k >= heights.length) return false;      // 行盒口径放得下（与 heightPx 的口径残差）→ 段级路径
    if (k > heights.length - 2) k = heights.length - 2;   // 防孤行：残段 ≥2 行（前段少带行补齐）
    if (k < 2) return false;                    // 防孤行：前段 ≥2 行（不足即推，不硬拆）
    const total = unit.split ? unit.split.totalLines : heights.length;   // 沿链保持原行数
    const baseKey = unit.split ? unit.split.of : unit.key;
    const baseStart = unit.split ? unit.split.startLine : 0;
    // 前段克隆保留原 key（渲染侧 key→单元回映射不变）；残段新 key 带累计行号（同组归并续片段），残段顶边距 = 续片段（续）标记占位（沿链传递）
    const head: FlowUnitSpec = {
      ...unit,
      heightPx: lineHeightSum(heights.slice(0, k)),
      marginBottomPx: 0,
      lineHeights: heights.slice(0, k),
      split: { of: baseKey, startLine: baseStart, lineCount: k, totalLines: total },
    };
    const tail: FlowUnitSpec = {
      ...unit,
      key: `${baseKey}#s${baseStart + k}`,
      heightPx: lineHeightSum(heights.slice(k)),
      marginTopPx: continuedMarker,
      lineHeights: heights.slice(k),
      split: { of: baseKey, startLine: baseStart + k, lineCount: heights.length - k, totalLines: total },
    };
    place(head, group);
    work.splice(wi + 1, 0, tail);
    return true;
  };

  // 工作串：拆出的残段插回紧随位（splice），原输入数组不被改写
  const work = units.slice();
  // 0007 P6：续片段「（续）」标记行高占位——残段以此计顶边距，段内拆到行盒边界的容器不被标记行顶破容量
  const continuedMarker = Number.isFinite(options.continuedMarkerPx) ? Math.max(0, options.continuedMarkerPx!) : 0;
  for (let wi = 0; wi < work.length; wi++) {
    const unit = work[wi];
    const group = unit.group !== undefined ? unit.group : null;
    if (current === null) {
      current = openContainer();
    }
    const height = heightOfUnit(unit);
    const mt = marginTopOfUnit(unit);
    const mb = marginBottomOfUnit(unit);
    const first = current.fragments.length === 0;
    const delta = first ? height + mt + mb : height + mb + Math.max(0, mt - prevMarginBottom);
    if (used + delta <= capacityNow() + CAPACITY_EPSILON) {
      place(unit, group);
      continue;
    }
    // 0007 P6：段内行级拆分（放不下整体 → 按行盒断点拆前段+残段；拆不动回落段级路径）
    if (trySplitInline(unit, group, work, wi)) continue;
    // 断容器：先回取绑定链（keepWithNext 单元不可作片段末单元）→ 与当前单元同容器落位
    const carry: Array<{ unit: FlowUnitSpec; group: string | null }> = [];
    const tail: FlowContainerPlan = current;
    while (tail.fragments.length > 0) {
      const lastFragment = tail.fragments[tail.fragments.length - 1];
      const lastUnit = lastFragment.units[lastFragment.units.length - 1];
      if (!lastUnit.keepWithNext) break;
      lastFragment.units.pop();
      if (lastFragment.units.length === 0) tail.fragments.pop();
      carry.unshift({ unit: lastUnit, group: lastFragment.group });
    }
    if (tail.fragments.length === 0) containers.pop();   // 容器被掏空 → 不留空容器/空页
    current = openContainer();
    for (const carried of carry) place(carried.unit, carried.group);
    // 0007 P6：残段/超长单元在新容器再给一次行级拆分机会（仍拆不动 → 原语义强制落位标溢出）
    if (!trySplitInline(unit, group, work, wi)) place(unit, group);
  }

  // 续片段标记：同组在本片段之前已有片段（组片段在文档序上连续）
  const seenGroups = new Set<string>();
  for (const container of containers) {
    for (const fragment of container.fragments) {
      if (fragment.group === null) {
        fragment.continued = false;
        continue;
      }
      fragment.continued = seenGroups.has(fragment.group);
      seenGroups.add(fragment.group);
    }
  }

  return { containers, overflowCount: containers.filter((container) => container.overflowWarn).length };
}

/** 0007 P4：一张 sheet 的手工列装箱结果（双列打印根治——列内高度分配由装箱器控制） */
export interface ColumnSheetPlan {
  /** 逐列块序列（只含非空列；渲染侧按 columnsPerSheet 补齐空列盒） */
  columns: PageBlockSpec[][];
  /** 该 sheet 任一列含超列高块（独占列 + 溢出截断标记） */
  overflowWarn: boolean;
}

export interface ColumnPaginationPlan {
  sheets: ColumnSheetPlan[];
  /** 溢出列总数（诚实 UI 标记/探针用） */
  overflowCount: number;
}

export interface PlanColumnsOptions {
  /** 每张 sheet 的列数（≥1；1 时分布与 planPages 逐点一致） */
  columnsPerSheet: number;
  /** 首张 sheet 的列容量 px（抬头通栏占位压缩；缺省 = columnCapacityPx） */
  firstSheetColumnCapacityPx?: number;
}

/**
 * 手工列贪心装箱（纯函数；0007 P4，双列打印根治）：
 * 块序依序填入当前列；当前列放不下 → 下一列；列尽 → 新开一张 sheet。
 * 块（含边距）> 列容量 → 独占一列并标 overflowWarn（渲染侧截断打标）。
 * 列内边距折叠口径与 planPages 逐点一致（列首=页首语义：顶边距计入、跨列重置折叠基线）；
 * 首张 sheet 各列容量可被 firstSheetColumnCapacityPx 压缩（抬头跨列通栏占位）。
 *
 * 0007 P5：本函数 = planFlow 的列级视图（容器=列，containersPerSheet=columnsPerSheet；
 * 块级调用方每块自成片段）——与段级消费方同一份装箱实现，规则零漂移。
 */
export function planColumns(
  blocks: PageBlockSpec[],
  columnCapacityPx: number,
  options: PlanColumnsOptions,
): ColumnPaginationPlan {
  const perSheet = Math.max(1, Math.floor(options.columnsPerSheet));
  const plan = planFlow(blocks, {
    capacityPx: columnCapacityPx,
    containersPerSheet: perSheet,
    ...(options.firstSheetColumnCapacityPx !== undefined
      ? { firstSheetCapacityPx: options.firstSheetColumnCapacityPx }
      : {}),
  });

  const sheets: ColumnSheetPlan[] = [];
  plan.containers.forEach((container, index) => {
    const sheetIndex = Math.floor(index / perSheet);
    if (!sheets[sheetIndex]) sheets[sheetIndex] = { columns: [], overflowWarn: false };
    sheets[sheetIndex].columns.push(flattenUnits(container.fragments));
    if (container.overflowWarn) sheets[sheetIndex].overflowWarn = true;
  });

  return { sheets, overflowCount: plan.overflowCount };
}
