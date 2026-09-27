// 0004-fix-4 2.1：分页预览装箱器（纯函数）单测——块序 / 推页 / 超页高块 / 页高换算。
// 注入脚本内联一份同规则实现（浏览器实时测量）；本探针锚定规则本身（可迁移资产）。

import { describe, it, expect } from 'vitest';
import {
  mmToPx,
  pageContentHeightPx,
  planColumns,
  planFlow,
  planPages,
  type FlowContainerPlan,
  type FlowUnitSpec,
  type PageBlockSpec,
} from '../../src/app/pages/paginate.js';

const block = (key: string, heightPx: number): PageBlockSpec => ({ key, heightPx });

describe('fix-4 2.1 页高换算（mm → px）', () => {
  it('mmToPx：96dpi 标准换算（210mm ≈ 793.7px）', () => {
    expect(mmToPx(210)).toBeCloseTo(793.7, 1);
    expect(mmToPx(25.4)).toBeCloseTo(96, 6);
  });

  it('pageContentHeightPx = 页高 − 上下页边距', () => {
    // A4 297mm − 20 − 20 = 257mm ≈ 971.3px
    expect(pageContentHeightPx(297, 20, 20)).toBeCloseTo(971.3, 1);
    // A3 横版 297mm − 10 − 10 = 277mm ≈ 1047px
    expect(pageContentHeightPx(297, 10, 10)).toBeCloseTo(1046.9, 1);
    // 非法值兜底 ≥1（不静默丢块）
    expect(pageContentHeightPx(0, 100, 100)).toBe(1);
  });
});

describe('fix-4 2.1 planPages 块级贪心装箱', () => {
  it('块序保持 + 依序放入当前页（容量内不推页）', () => {
    const plan = planPages([block('a', 100), block('b', 100), block('c', 100)], 300);
    expect(plan.pages).toHaveLength(1);
    expect(plan.pages[0].blocks.map((b) => b.key)).toEqual(['a', 'b', 'c']);
    expect(plan.overflowCount).toBe(0);
  });

  it('超余量 → 整块推下一页（块内不拆行，页序不乱）', () => {
    const plan = planPages([block('a', 100), block('b', 100), block('c', 150)], 250);
    expect(plan.pages.map((p) => p.blocks.map((b) => b.key))).toEqual([['a', 'b'], ['c']]);
  });

  it('恰好填满不推页（边界 = 容量）', () => {
    const plan = planPages([block('a', 250), block('b', 50)], 250);
    expect(plan.pages.map((p) => p.blocks.map((b) => b.key))).toEqual([['a'], ['b']]);
  });

  it('超页高块独占页 + 溢出标记（rare，渲染侧截断打标）', () => {
    const plan = planPages([block('tall', 400), block('small', 50)], 300);
    expect(plan.pages[0].blocks.map((b) => b.key)).toEqual(['tall']);
    expect(plan.pages[0].overflowWarn).toBe(true);
    expect(plan.pages[1].blocks.map((b) => b.key)).toEqual(['small']);
    expect(plan.pages[1].overflowWarn).toBe(false);
    expect(plan.overflowCount).toBe(1);
  });

  it('空块序列 → 零页；容量非法 → 每块独占页且不丢块', () => {
    expect(planPages([], 300).pages).toHaveLength(0);
    const plan = planPages([block('a', 2), block('b', 3)], 0);
    expect(plan.pages).toHaveLength(2);
    expect(plan.pages.every((p) => p.overflowWarn)).toBe(true);
    expect(plan.overflowCount).toBe(2);
  });

  it('多页连续装箱（10 块 × 100px / 容量 250px → 5 页）', () => {
    const blocks = Array.from({ length: 10 }, (_, i) => block(`q${i}`, 100));
    const plan = planPages(blocks, 250);
    expect(plan.pages).toHaveLength(5);
    expect(plan.pages.every((p) => p.blocks.length === 2)).toBe(true);
  });
});

// 0007 P1：外边距折叠口径（设计稿 §一/结论三-2——旧测量 offsetHeight+mt+mb 求和，
// 相邻块外边距在真实流中折叠，装箱双算致页数高估（探针③ A4 单栏 6v5 的半数贡献））
describe('0007 P1 planPages 外边距折叠（相邻块 max 折叠；页首顶边距计入）', () => {
  const mblock = (key: string, heightPx: number, marginTopPx: number, marginBottomPx: number): PageBlockSpec =>
    ({ key, heightPx, marginTopPx, marginBottomPx });

  it('相邻块折叠：max(上块 mb, 下块 mt) 取代求和（求和会推页的边界样本）', () => {
    // 折叠口径：a=100+0+20=120；b 增量=100+10+max(0,30−20)=120 → 240；c 增量=100+0+max(0,10−10)=100 → 340
    const blocks = [mblock('a', 100, 0, 20), mblock('b', 100, 30, 10), mblock('c', 100, 10, 0)];
    expect(planPages(blocks, 339).pages.map((p) => p.blocks.map((b) => b.key))).toEqual([['a', 'b'], ['c']]);
    // 容量 340 恰好全下 → 单页（边界 = 容量不推页）
    expect(planPages(blocks, 340).pages).toHaveLength(1);
  });

  it('溢出判定含外边距：h+mt+mb > 容量 → overflowWarn', () => {
    const plan = planPages([mblock('tall', 250, 30, 0)], 270);
    expect(plan.pages[0].overflowWarn).toBe(true);
    expect(plan.overflowCount).toBe(1);
  });

  it('页首块顶边距计入页容量（折叠不穿透页容器 padding）', () => {
    // a 独占：100+20+0=120 ≤ 120；a+b 同页需 120+100+0+max(0,10−0)=230 > 120 → b 推页
    const plan = planPages([mblock('a', 100, 20, 0), mblock('b', 100, 10, 0)], 120);
    expect(plan.pages.map((p) => p.blocks.map((b) => b.key))).toEqual([['a'], ['b']]);
  });

  it('外边距缺省 = 0（heightPx 视为含边距全量，与旧口径逐点一致）', () => {
    expect(planPages([block('a', 100), block('b', 100), block('c', 150)], 250)
      .pages.map((p) => p.blocks.map((b) => b.key))).toEqual([['a', 'b'], ['c']]);
    expect(planPages([block('tall', 400)], 300).pages[0].overflowWarn).toBe(true);
  });
});

// 0007 P4：双列手工列装箱（双列打印根治——列内高度分配由装箱器控制，
// 退役 Chromium column-count 打印断列）。列=容量与页内容高等高的窄盒；
// 块序依序填列：列满 → 下一列 → 列尽 → 下一张 sheet；抬头通栏由调用方
// 以 firstSheetColumnCapacityPx 压缩首页列容量表达。
describe('0007 P4 planColumns 手工列装箱', () => {
  const mblock = (key: string, heightPx: number, marginTopPx: number, marginBottomPx: number): PageBlockSpec =>
    ({ key, heightPx, marginTopPx, marginBottomPx });
  const keysOf = (plan: ReturnType<typeof planColumns>) =>
    plan.sheets.map((s) => s.columns.map((col) => col.map((b) => b.key)));

  it('顺序填列：列满 → 下一列 → 列尽 → 下一张 sheet', () => {
    const blocks = [block('a', 100), block('b', 100), block('c', 100), block('d', 100), block('e', 100)];
    const plan = planColumns(blocks, 250, { columnsPerSheet: 2 });
    expect(keysOf(plan)).toEqual([
      [['a', 'b'], ['c', 'd']],
      [['e']],
    ]);
    expect(plan.overflowCount).toBe(0);
    expect(plan.sheets.every((s) => !s.overflowWarn)).toBe(true);
  });

  it('恰好填满列不推列（边界 = 列容量）', () => {
    const plan = planColumns([block('a', 250), block('b', 50), block('c', 300)], 300, { columnsPerSheet: 2 });
    expect(keysOf(plan)).toEqual([[['a', 'b'], ['c']]]);
  });

  it('首页列容量压缩（抬头通栏占位）：仅首张 sheet 各列用压缩容量', () => {
    const blocks = [block('a', 100), block('b', 100), block('c', 100), block('d', 100), block('e', 100)];
    const plan = planColumns(blocks, 250, { columnsPerSheet: 2, firstSheetColumnCapacityPx: 150 });
    // sheet1：150 容量 → 每列 1 块；sheet2 起恢复 250 → 每列 2 块
    expect(keysOf(plan)).toEqual([
      [['a'], ['b']],
      [['c', 'd'], ['e']],
    ]);
  });

  it('列内边距折叠口径与 planPages 一致；跨列重置（列首顶边距计入）', () => {
    // a=100+0+20=120；b 增量=100+10+max(0,30−20)=120 → 240；c 增量=100 → 340
    const blocks = [mblock('a', 100, 0, 20), mblock('b', 100, 30, 10), mblock('c', 100, 10, 0)];
    expect(keysOf(planColumns(blocks, 339, { columnsPerSheet: 2 }))).toEqual([[['a', 'b'], ['c']]]);
    // 容量 340 恰好全下同列
    expect(keysOf(planColumns(blocks, 340, { columnsPerSheet: 2 }))).toEqual([[['a', 'b', 'c']]]);
    // c 落新列时顶边距 10 全额计入（列首不折叠穿透）：100+10+0=110 > 100 → 不与 100 容量共列
    expect(keysOf(planColumns([mblock('x', 100, 0, 0), mblock('c', 100, 10, 0)], 100, { columnsPerSheet: 2 })))
      .toEqual([[['x'], ['c']]]);
  });

  it('columnsPerSheet=1 退化为 planPages 同分布（单源口径一致）', () => {
    const blocks = [
      mblock('h', 100, 0, 0),
      ...Array.from({ length: 5 }, (_, i) => mblock(`q${i + 1}`, 300, 10, 30)),
    ];
    const viaColumns = planColumns(blocks, 971, { columnsPerSheet: 1 });
    const viaPages = planPages(blocks, 971);
    expect(keysOf(viaColumns).map((s) => s[0])).toEqual(viaPages.pages.map((p) => p.blocks.map((b) => b.key)));
    expect(viaColumns.overflowCount).toBe(viaPages.overflowCount);
  });

  it('超列高块独占列 + 溢出标记；后续块进下一列不与其共列', () => {
    const plan = planColumns([block('tall', 400), block('small', 50)], 300, { columnsPerSheet: 2 });
    expect(keysOf(plan)).toEqual([[['tall'], ['small']]]);
    expect(plan.sheets[0].overflowWarn).toBe(true);
    expect(plan.overflowCount).toBe(1);
  });

  it('空块序列 → 零 sheet；容量非法 → 兜底 1px 不丢块', () => {
    expect(planColumns([], 300, { columnsPerSheet: 2 }).sheets).toHaveLength(0);
    const plan = planColumns([block('a', 2), block('b', 3)], 0, { columnsPerSheet: 2 });
    expect(keysOf(plan)).toEqual([[['a'], ['b']]]);
    expect(plan.sheets.every((s) => s.overflowWarn)).toBe(true);
    expect(plan.overflowCount).toBe(2);
  });
});

// 0007 P5：段级装箱（装箱粒度题级→段级）——单元（段）序列按组（题）归并成片段；
// 组跨容器切分 → 续片段（continued=true，渲染侧 .mf-continued）；
// keepWithNext（题首单元）不可作片段末单元 → 断容器时随绑定链整体推页（题首+首段防孤）。
// 容器 = 页（单列）或列（双列，containersPerSheet）；首张 sheet 的容器容量可压缩（抬头通栏占位）。
describe('0007 P5 planFlow 段级装箱（片段归并 + 防孤绑定 + 容器边界）', () => {
  const unit = (key: string, heightPx: number, group?: string, keepWithNext?: boolean) => ({
    key,
    heightPx,
    ...(group !== undefined ? { group } : {}),
    ...(keepWithNext ? { keepWithNext: true } : {}),
  });
  const unitWithMargins = (key: string, heightPx: number, mt: number, mb: number, group?: string) => ({
    key,
    heightPx,
    marginTopPx: mt,
    marginBottomPx: mb,
    ...(group !== undefined ? { group } : {}),
  });
  const keysOf = (plan: { containers: FlowContainerPlan[] }) =>
    plan.containers.map((c) => c.fragments.map((f) => f.units.map((u) => u.key)));

  it('同组单元归并进同一片段；组不同 → 片段边界（不同题的段不混片）', () => {
    const plan = planFlow(
      [unit('a1', 400, 'A'), unit('a2', 400, 'A'), unit('b1', 400, 'B'), unit('b2', 400, 'B')],
      { capacityPx: 900 },
    );
    expect(keysOf(plan)).toEqual([[['a1', 'a2']], [['b1', 'b2']]]);
    expect(plan.containers.flatMap((c) => c.fragments.map((f) => f.group))).toEqual(['A', 'B']);
    expect(plan.containers.flatMap((c) => c.fragments.map((f) => f.continued))).toEqual([false, false]);
    expect(plan.overflowCount).toBe(0);
  });

  it('组跨容器切分 → 续片段 continued=true（片边界=段边界，段序不乱）', () => {
    const plan = planFlow([unit('a1', 600, 'A'), unit('a2', 600, 'A'), unit('a3', 600, 'A')], { capacityPx: 700 });
    expect(keysOf(plan)).toEqual([[['a1']], [['a2']], [['a3']]]);
    expect(plan.containers.flatMap((c) => c.fragments.map((f) => f.continued))).toEqual([false, true, true]);
    expect(plan.containers.flatMap((c) => c.fragments.map((f) => f.group))).toEqual(['A', 'A', 'A']);
  });

  it('防孤绑定（keepWithNext）：题首不落片段尾——断容器时随绑定链整页推走', () => {
    // x1(300) 填掉大半页 → 题首 h(50, keepWithNext) 恰好挤进页尾，首段 p1(300) 放不下 → h 与 p1 同推次页
    const plan = planFlow(
      [
        unitWithMargins('x1', 300, 0, 0, 'X'),
        { key: 'h', heightPx: 50, group: 'A', keepWithNext: true },
        unitWithMargins('p1', 300, 0, 0, 'A'),
      ],
      { capacityPx: 350 },
    );
    expect(keysOf(plan)).toEqual([[['x1']], [['h', 'p1']]]);
    expect(plan.containers[1].fragments[0].continued).toBe(false);
    expect(plan.containers[1].fragments[0].units[0].keepWithNext).toBe(true);
    expect(plan.overflowCount).toBe(0);
  });

  it('防孤绑定优先于容量：绑定对超容量时同容器落位并标溢出（不静默拆散）', () => {
    const plan = planFlow(
      [unit('h', 200, 'A', true), unit('p1', 400, 'A'), unit('p2', 400, 'A')],
      { capacityPx: 500 },
    );
    expect(keysOf(plan)).toEqual([[['h', 'p1']], [['p2']]]);
    // 绑定对 600 > 容量 500 → 该容器标溢出（渲染侧截断标记由二次校验兜底）
    expect(plan.containers[0].overflowWarn).toBe(true);
    expect(plan.containers[1].overflowWarn).toBe(false);
    expect(plan.overflowCount).toBe(1);
  });

  it('容器首单元顶边距计入（折叠不穿透容器，与 planPages 同口径）', () => {
    const plan = planFlow(
      [unitWithMargins('a1', 100, 0, 20, 'A'), unitWithMargins('a2', 100, 30, 10, 'A'), unitWithMargins('a3', 100, 10, 0, 'A')],
      { capacityPx: 339 },
    );
    // 折叠口径：a1=120；a2 增量=120 → 240；a3 增量=100 → 340 > 339 → a3 推容器
    expect(keysOf(plan)).toEqual([[['a1', 'a2']], [['a3']]]);
    expect(planFlow(
      [unitWithMargins('a1', 100, 0, 20, 'A'), unitWithMargins('a2', 100, 30, 10, 'A'), unitWithMargins('a3', 100, 10, 0, 'A')],
      { capacityPx: 340 },
    ).containers).toHaveLength(1);
  });

  it('溢出单元独占容器 + 溢出计数=容器数；后续单元不与其共容器', () => {
    const plan = planFlow([unit('tall', 400, 'A'), unit('small', 50, 'A')], { capacityPx: 300 });
    expect(keysOf(plan)).toEqual([[['tall']], [['small']]]);
    expect(plan.containers[0].overflowWarn).toBe(true);
    expect(plan.overflowCount).toBe(1);
  });

  it('无组单元各自成片段（抬头/独立块不与题片段合并）', () => {
    const plan = planFlow([unit('h', 100), unit('a1', 100, 'A'), unit('a2', 100, 'A'), unit('t', 100)], { capacityPx: 900 });
    expect(keysOf(plan)).toEqual([[['h'], ['a1', 'a2'], ['t']]]);
    expect(plan.containers[0].fragments.map((f) => f.group)).toEqual([null, 'A', null]);
  });

  it('首张 sheet 容器容量压缩：仅前 containersPerSheet 个容器用压缩容量', () => {
    const blocks = [unit('a', 100, 'A'), unit('b', 100, 'B'), unit('c', 100, 'C'), unit('d', 100, 'C'), unit('e', 100, 'E')];
    const plan = planFlow(blocks, { capacityPx: 250, firstSheetCapacityPx: 150, containersPerSheet: 2 });
    // 容器0/1 压缩 150 → 各 1 单元；容器2 起恢复 250 → c/d 同组归并一片
    expect(keysOf(plan)).toEqual([[['a']], [['b']], [['c', 'd']], [['e']]]);
  });

  it('空单元序列 → 零容器；容量非法 → 兜底 1px 每单元独占容器不丢段', () => {
    expect(planFlow([], { capacityPx: 300 }).containers).toHaveLength(0);
    const plan = planFlow([unit('a', 2, 'A'), unit('b', 3, 'A')], { capacityPx: 0 });
    expect(keysOf(plan)).toEqual([[['a']], [['b']]]);
    expect(plan.containers.every((c) => c.overflowWarn)).toBe(true);
    expect(plan.overflowCount).toBe(2);
  });

  it('单源口径：无 group/keepWithNext 时 == planPages 分布；containersPerSheet=2 时 == planColumns 分布', () => {
    const blocks: PageBlockSpec[] = [
      { key: 'h', heightPx: 100 },
      ...Array.from({ length: 5 }, (_, i) => ({ key: `q${i + 1}`, heightPx: 300, marginTopPx: 10, marginBottomPx: 30 })),
    ];
    const flatFlow = (plan: { containers: FlowContainerPlan[] }) =>
      plan.containers.map((c) => c.fragments.flatMap((f) => f.units.map((u) => u.key)));
    expect(flatFlow(planFlow(blocks, { capacityPx: 971 })))
      .toEqual(planPages(blocks, 971).pages.map((p) => p.blocks.map((b) => b.key)));
    // 双列：容器按 2 个一张 sheet 切分 == planColumns 的 sheet/列分布
    const viaFlow = planFlow(blocks, { capacityPx: 971, containersPerSheet: 2 });
    const columnsOfFlow: string[][][] = [];
    viaFlow.containers.forEach((c, i) => {
      const si = Math.floor(i / 2);
      if (!columnsOfFlow[si]) columnsOfFlow[si] = [];
      columnsOfFlow[si].push(c.fragments.flatMap((f) => f.units.map((u) => u.key)));
    });
    const viaColumns = planColumns(blocks, 971, { columnsPerSheet: 2 });
    expect(columnsOfFlow).toEqual(viaColumns.sheets.map((s) => s.columns.map((col) => col.map((b) => b.key))));
    // 首页压缩同口径
    const viaFlowFirst = planFlow(blocks, { capacityPx: 250, firstSheetCapacityPx: 150, containersPerSheet: 2 });
    const columnsOfFirst: string[][][] = [];
    viaFlowFirst.containers.forEach((c, i) => {
      const si = Math.floor(i / 2);
      if (!columnsOfFirst[si]) columnsOfFirst[si] = [];
      columnsOfFirst[si].push(c.fragments.flatMap((f) => f.units.map((u) => u.key)));
    });
    const viaColumnsFirst = planColumns(blocks, 250, { columnsPerSheet: 2, firstSheetColumnCapacityPx: 150 });
    expect(columnsOfFirst).toEqual(viaColumnsFirst.sheets.map((s) => s.columns.map((col) => col.map((b) => b.key))));
  });

  it('planPages / planColumns 由 planFlow 单源承载（同分布 + 同溢出计数）', () => {
    const blocks: PageBlockSpec[] = [
      { key: 'tall', heightPx: 1200 },
      { key: 'a', heightPx: 200, marginTopPx: 10, marginBottomPx: 20 },
      { key: 'b', heightPx: 200 },
    ];
    const pages = planPages(blocks, 971);
    expect(pages.pages.map((p) => p.blocks.map((b) => b.key))).toEqual([['tall'], ['a', 'b']]);
    expect(pages.overflowCount).toBe(1);
    expect(pages.pages[0].overflowWarn).toBe(true);
    const columns = planColumns(blocks, 971, { columnsPerSheet: 2 });
    expect(columns.sheets.map((s) => s.columns.map((col) => col.map((b) => b.key)))).toEqual([[['tall'], ['a', 'b']]]);
    expect(columns.overflowCount).toBe(1);
  });
});

// 0007 P6：长文段内行级拆分——单元带 lineHeights（运行时 Range 行盒懒测量注入）且放不下
// 当前容器剩余容量时，按行盒边界拆「前段（留当前容器）+ 残段（续片段）」；
// 防孤行 orphans=widows=2（前段/残段各 ≥2 行，不足即整段推下一容器，不硬拆）；
// 无 lineHeights / 行数 <4 / keepWithNext 单元 → 回落段级路径（P5 语义零回归）。
describe('0007 P6 planFlow 段内行级拆分（lineHeights 行盒断点 + 防孤行）', () => {
  /** 带行盒信息的文本单元：heightPx = 行高合计（运行时归一化口径） */
  const lunit = (
    key: string,
    lineHeights: number[],
    group?: string,
    opts?: { mt?: number; mb?: number },
  ): FlowUnitSpec => ({
    key,
    heightPx: lineHeights.reduce((sum, h) => sum + h, 0),
    lineHeights,
    ...(opts?.mt !== undefined ? { marginTopPx: opts.mt } : {}),
    ...(opts?.mb !== undefined ? { marginBottomPx: opts.mb } : {}),
    ...(group !== undefined ? { group } : {}),
  });
  const lines = (n: number, h = 100): number[] => Array.from({ length: n }, () => h);
  const keysOf = (plan: { containers: FlowContainerPlan[] }) =>
    plan.containers.map((c) => c.fragments.map((f) => f.units.map((u) => u.key)));

  it('行级断点选择：剩余容量断在第 k 行（前段 k 行留当前容器，残段 n−k 行成续片段）', () => {
    // 10 行 × 100 = 1000 > 容量 500 → 断在第 5 行后（500 恰满）
    const plan = planFlow([lunit('p', lines(10), 'A')], { capacityPx: 500 });
    expect(keysOf(plan)).toEqual([[['p']], [['p#s5']]]);
    const head = plan.containers[0].fragments[0].units[0];
    const tail = plan.containers[1].fragments[0].units[0];
    expect(head.split).toEqual({ of: 'p', startLine: 0, lineCount: 5, totalLines: 10 });
    expect(tail.split).toEqual({ of: 'p', startLine: 5, lineCount: 5, totalLines: 10 });
    // 前段恰满容器不标溢出（overflowWarn 语义收窄：拆得掉的不再标溢出）
    expect(plan.overflowCount).toBe(0);
    expect(plan.containers.every((c) => !c.overflowWarn)).toBe(true);
    // 续片段标记沿用（同款 .mf-continued 渲染语义）
    expect(plan.containers[1].fragments[0].continued).toBe(true);
    expect(plan.containers[0].fragments[0].continued).toBe(false);
  });

  it('拆后两片段行数合计=原行数；高度/边距守恒（前段让出尾边距、残段顶边距归零）', () => {
    // 8 行 × 100 + mt 10 + mb 20；容量 550 → 可用 540 → k=5（500 ≤ 540 < 600）
    const plan = planFlow([lunit('p', lines(8), 'A', { mt: 10, mb: 20 })], { capacityPx: 550 });
    const head = plan.containers[0].fragments[0].units[0];
    const tail = plan.containers[1].fragments[0].units[0];
    expect(head.lineHeights).toHaveLength(5);
    expect(tail.lineHeights).toHaveLength(3);
    expect((head.lineHeights?.length ?? 0) + (tail.lineHeights?.length ?? 0)).toBe(8);
    expect(head.heightPx + tail.heightPx).toBe(800);
    expect(head.marginTopPx).toBe(10);
    expect(head.marginBottomPx).toBe(0);
    expect(tail.marginTopPx).toBe(0);
    expect(tail.marginBottomPx).toBe(20);
    expect(head.group).toBe('A');
    expect(tail.group).toBe('A');
  });

  it('防孤行：剩余空间放不下 2 行 → 整段推下一容器（不硬拆）', () => {
    // x=460 填底 → 剩余 40 < 2 行；p = 4 行 × 100 = 400 ≤ 容量 500 → 整段落次容器，无拆分
    const plan = planFlow(
      [{ key: 'x', heightPx: 460, group: 'X' }, lunit('p', lines(4), 'A')],
      { capacityPx: 500 },
    );
    expect(keysOf(plan)).toEqual([[['x']], [['p']]]);
    const p = plan.containers[1].fragments[0].units[0];
    expect(p.split).toBeUndefined();
    expect(p.heightPx).toBe(400);
    expect(plan.overflowCount).toBe(0);
  });

  it('防孤行：残段不足 2 行 → 前段少带行补齐（n=6、可放 5 行 → 断 4+2）', () => {
    const plan = planFlow([lunit('p', lines(6), 'A')], { capacityPx: 500 });
    const head = plan.containers[0].fragments[0].units[0];
    const tail = plan.containers[1].fragments[0].units[0];
    expect(head.split?.lineCount).toBe(4);
    expect(tail.split?.lineCount).toBe(2);
    expect(tail.key).toBe('p#s4');
  });

  it('无 lineHeights 回落段级：整段推页 / 超容量独占容器 + overflowWarn（P5 语义零回归）', () => {
    const plan = planFlow(
      [{ key: 'x', heightPx: 460, group: 'X' }, { key: 'p', heightPx: 400, group: 'A' }],
      { capacityPx: 500 },
    );
    expect(keysOf(plan)).toEqual([[['x']], [['p']]]);
    expect(plan.containers[1].fragments[0].units[0].split).toBeUndefined();
    const tall = planFlow([{ key: 'tall', heightPx: 600, group: 'A' }], { capacityPx: 500 });
    expect(tall.containers[0].overflowWarn).toBe(true);
    expect(tall.overflowCount).toBe(1);
  });

  it('超长单段跨多容器连续拆分（10 行 / 容量 340 → 3+3+2+2，键带累计行号）', () => {
    const plan = planFlow([lunit('p', lines(10), 'A')], { capacityPx: 340 });
    expect(keysOf(plan)).toEqual([[['p']], [['p#s3']], [['p#s6']], [['p#s8']]]);
    const parts = plan.containers.map((c) => c.fragments[0].units[0]);
    expect(parts.map((u) => u.split?.lineCount)).toEqual([3, 3, 2, 2]);
    expect(parts.map((u) => u.split?.startLine)).toEqual([0, 3, 6, 8]);
    expect(parts.every((u) => u.split?.totalLines === 10)).toBe(true);
    expect(plan.containers.map((c) => c.fragments[0].continued)).toEqual([false, true, true, true]);
    expect(plan.overflowCount).toBe(0);
  });

  it('行数不足 4（首 2 + 尾 2 不可兼得）不拆 → 段级兜底：独占容器 + overflowWarn', () => {
    const plan = planFlow([lunit('p', lines(3, 200), 'A')], { capacityPx: 500 });
    expect(keysOf(plan)).toEqual([[['p']]]);
    expect(plan.containers[0].fragments[0].units[0].split).toBeUndefined();
    expect(plan.containers[0].overflowWarn).toBe(true);
    expect(plan.overflowCount).toBe(1);
  });

  it('keepWithNext 单元不拆（防孤绑定语义不变，行盒信息忽略）', () => {
    // 题首 h（keepWithNext，带行盒）在页底放不下 → 推页，h 自身不拆；
    // 首段 p（4 行）随题首同片，放不下剩余 300 → 段内拆 2+2（题首仍与首段前 2 行同片，绑定保持）
    const plan = planFlow(
      [
        { key: 'x', heightPx: 460, group: 'X' },
        { key: 'h', heightPx: 200, group: 'A', keepWithNext: true, lineHeights: lines(2) },
        lunit('p', lines(4), 'A'),
      ],
      { capacityPx: 500 },
    );
    expect(keysOf(plan)).toEqual([[['x']], [['h', 'p']], [['p#s2']]]);
    const h = plan.containers[1].fragments[0].units[0];
    expect(h.split).toBeUndefined();
    expect(h.keepWithNext).toBe(true);
    // 题首与首段前段同片（防孤），首段残段续下一容器
    expect(plan.containers[1].fragments[0].units.map((u) => u.key)).toEqual(['h', 'p']);
    expect(plan.containers[1].fragments[0].units[1].split?.lineCount).toBe(2);
    expect(plan.containers[2].fragments[0].continued).toBe(true);
  });

  it('组归并：前段并入同组当前片段；残段成同组续片段（题首+前段同片不拆散）', () => {
    const plan = planFlow(
      [
        { key: 'h', heightPx: 50, group: 'A', keepWithNext: true },
        lunit('p', lines(10), 'A'),
      ],
      { capacityPx: 550 },
    );
    // h(50) + p 前段 5 行(500) 同片；残段 5 行续片段
    expect(plan.containers[0].fragments).toHaveLength(1);
    expect(plan.containers[0].fragments[0].units.map((u) => u.key)).toEqual(['h', 'p']);
    expect(plan.containers[1].fragments[0].group).toBe('A');
    expect(plan.containers[1].fragments[0].continued).toBe(true);
  });

  it('放得下的带行盒单元不拆：分布与无行盒口径逐点一致（单源口径不回归）', () => {
    const specs: FlowUnitSpec[] = [
      { key: 'h', heightPx: 100 },
      { key: 'a', heightPx: 300, marginTopPx: 10, marginBottomPx: 30, group: 'A' },
      { key: 'b', heightPx: 300, marginTopPx: 10, marginBottomPx: 30, group: 'B', lineHeights: lines(3) },
      { key: 'c', heightPx: 300, marginTopPx: 10, marginBottomPx: 30, group: 'C' },
      { key: 'd', heightPx: 300, marginTopPx: 10, marginBottomPx: 30, group: 'D', lineHeights: lines(3) },
    ];
    const strip = (withLines: FlowUnitSpec[]): FlowUnitSpec[] =>
      withLines.map(({ lineHeights: _lineHeights, ...rest }) => rest);
    const flat = (plan: { containers: FlowContainerPlan[] }) =>
      plan.containers.map((c) => c.fragments.flatMap((f) => f.units.map((u) => u.key)));
    const withLines = planFlow(specs, { capacityPx: 971 });
    const without = planFlow(strip(specs), { capacityPx: 971 });
    expect(flat(withLines)).toEqual(flat(without));
    expect(withLines.containers.flatMap((c) => c.fragments.flatMap((f) => f.units))).toSatisfy(
      (us: FlowUnitSpec[]) => us.every((u) => u.split === undefined),
    );
  });

  it('续片段（续）标记占位（continuedMarkerPx）：残段顶边距=标记高且计入容量，沿链传递', () => {
    // 对照组（无标记占位）：10 行 × 100 / 容量 500 → 5+5 两容器（与首用例同分布）
    const plain = planFlow([lunit('p', lines(10), 'A')], { capacityPx: 500 });
    expect(keysOf(plain)).toEqual([[['p']], [['p#s5']]]);
    // 标记占位 18px：残段带 mt=18 → 5 行(500)+18 > 500 → 新容器再给一次拆分机会：
    // 可用 500−18=482 → k=4 → 防孤回带到 3 → 残段再拆 3+2；全链 mt=18 沿链传递
    const plan = planFlow([lunit('p', lines(10), 'A')], { capacityPx: 500, continuedMarkerPx: 18 });
    expect(keysOf(plan)).toEqual([[['p']], [['p#s5']], [['p#s8']]]);
    const parts = plan.containers.map((c) => c.fragments[0].units[0]);
    expect(parts.map((u) => u.split?.lineCount)).toEqual([5, 3, 2]);
    expect(parts.map((u) => u.split?.startLine)).toEqual([0, 5, 8]);
    expect(parts.every((u) => u.split?.totalLines === 10)).toBe(true);
    // 前段保留原顶边距口径（本例缺省），残段一律 mt=标记高（占位计入容量：318/218 ≤ 500 不标溢出）
    expect(parts[0].marginTopPx).toBeUndefined();
    expect(parts[1].marginTopPx).toBe(18);
    expect(parts[2].marginTopPx).toBe(18);
    expect(plan.containers.map((c) => c.fragments[0].continued)).toEqual([false, true, true]);
    expect(plan.overflowCount).toBe(0);
  });
});
