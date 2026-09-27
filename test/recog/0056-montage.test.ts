// 0056 返工⑦：公式靶「拼大图」纯逻辑（排版 / 分片 / 回包按编号对齐）。
//
// 依据（线上实测经验 + 用户 2026-09-24 拍板）：孤立小公式图缺上下文（`√(d/g)` 单张送会被读成 `√a`），
// 同题多张拼成一张**带编号的网格大图**→ 一次调用取回全部，且编号给了可机械校验的对应关系。

import { describe, it, expect } from 'vitest';
import {
  MONTAGE_MAX_ITEMS,
  chunkMontage,
  parseMontageRows,
  planMontage,
} from '../../src/recog/ai-clean/montage.js';

describe('0056 返工⑦：拼图排版 planMontage', () => {
  it('6 张 → 3 列 2 行；格尺寸取最大片段（片段本身不重采样）', () => {
    const plan = planMontage([
      { width: 247, height: 408 },
      { width: 408, height: 273 },
      { width: 322, height: 408 },
      { width: 348, height: 408 },
      { width: 408, height: 346 },
      { width: 408, height: 300 },
    ]);
    expect(plan.cols).toBe(3);
    expect(plan.rows).toBe(2);
    expect(plan.cellWidth).toBe(408);
    expect(plan.cellHeight).toBe(408);
    expect(plan.scale).toBe(1);
    expect(plan.width).toBe(1640);   // 20*2 + 3*(112+408) + 2*20
    expect(plan.height).toBe(876);   // 20*2 + 2*408 + 20
  });

  it('≤3 张单行；4 张起 ⌈√n⌉ 列', () => {
    expect(planMontage([{ width: 10, height: 10 }, { width: 10, height: 10 }]).cols).toBe(2);
    expect(planMontage([{ width: 10, height: 10 }, { width: 10, height: 10 }, { width: 10, height: 10 }]).cols).toBe(3);
    expect(planMontage(Array.from({ length: 4 }, () => ({ width: 10, height: 10 }))).cols).toBe(2);
    expect(planMontage(Array.from({ length: 8 }, () => ({ width: 10, height: 10 }))).cols).toBe(3);
  });

  it('超长边上限 → 整体等比收敛（内容与间距同缩）', () => {
    const plan = planMontage(Array.from({ length: 8 }, () => ({ width: 900, height: 900 })));
    expect(plan.scale).toBeLessThan(1);
    expect(Math.max(plan.width, plan.height)).toBe(1800);
  });
});

describe('0056 返工⑦：分片 chunkMontage', () => {
  it('按 ≤max 切片，片序/片内序都保持原序', () => {
    expect(chunkMontage([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunkMontage([1, 2], 8)).toEqual([[1, 2]]);
    expect(chunkMontage([], 8)).toEqual([]);
    expect(MONTAGE_MAX_ITEMS).toBe(8);
  });
});

describe('0056 返工⑦：拼图回包解析 parseMontageRows', () => {
  it('编号形态：逐行 `n: LaTeX` → 行号映射', () => {
    const parsed = parseMontageRows('1: \\frac{d}{4}\n2: \\sqrt{gd}', 2);
    expect(parsed?.ordered).toBe(false);
    expect([...(parsed?.rows ?? [])]).toEqual([[1, '\\frac{d}{4}'], [2, '\\sqrt{gd}']]);
  });

  it('去代码围栏 + 容忍分隔符变体（`1)` / `2.` / `3、`）', () => {
    const parsed = parseMontageRows('```latex\n1) \\sqrt{a}\n2. E=mc^2\n3、x^2\n```', 3);
    expect(parsed?.rows.get(3)).toBe('x^2');
  });

  it('缺号 / 重号 / 越界 → 判该片作废（null）', () => {
    expect(parseMontageRows('1: a', 2)).toBeNull();
    expect(parseMontageRows('1: a\n1: b', 2)).toBeNull();
    expect(parseMontageRows('1: a\n3: c', 2)).toBeNull();
    expect(parseMontageRows('1: a\n2: b\n3: c', 2)).toBeNull();
  });

  it('混排（部分编号 + 部分裸行）→ 作废（宁缺毋错，交单图兜底）', () => {
    expect(parseMontageRows('1: a\n\\frac{d}{4}', 2)).toBeNull();
  });

  it('模型忘了编号但行数恰好 → 按行序对齐，且报 ordered=true（调用方挂可见告警）', () => {
    const parsed = parseMontageRows('\\frac{d}{4}\n\\sqrt{gd}', 2);
    expect(parsed?.ordered).toBe(true);
    expect([...(parsed?.rows ?? [])]).toEqual([[1, '\\frac{d}{4}'], [2, '\\sqrt{gd}']]);
  });

  it('无编号兜底要求「像公式」：纯词垃圾（banana/kiwi）不放行', () => {
    expect(parseMontageRows('banana\nkiwi', 2)).toBeNull();
  });

  it('空回包 / 行数不符 → null', () => {
    expect(parseMontageRows('', 2)).toBeNull();
    expect(parseMontageRows('1: a\n2: b\n3: c', 3)).not.toBeNull();
    expect(parseMontageRows('1: a\n2: b', 3)).toBeNull();
  });
});
