// 0004-fix-5 P0-2 探针：拖拽落点 → 全量覆盖数组（锚点物化）+ 当前视觉序/边界换算。
// 覆盖：任意段边界落位、同边界插入序、旧 orderIndex 数据基线、外来图、assetId 前缀形态。

import { describe, it, expect } from 'vitest';
import { figureVisualState, figuresAfterAnchorMove } from '../../src/app/pages/figure-anchors.js';
import type { QuestionFigureLayout } from '../../src/shared/contracts/bank-types.js';

const ONE_FIG =
  '<div class="question">题干文字<figure data-w="300"><img src="data-assets/capture/a.png"></figure>' +
  '<div class="options"><div class="option">A. 甲</div></div></div>';
const TWO_FIG =
  '<div class="question">t0<figure data-w="300"><img src="data-assets/capture/a.png"></figure>t1' +
  '<figure data-w="300"><img src="data-assets/capture/b.png"></figure>t2</div>';

const FIG_IMAGES = [
  { assetId: 'capture/a.png', type: 'figure' as const },
  { assetId: 'capture/b.png', type: 'figure' as const },
];

describe('fix-5 P0-2 视觉序/边界换算（引擎同源）', () => {
  it('单图题：视觉序 + 原位边界（text0/fig/text1 → 边界 1；fix-6 切分后段数 4）', () => {
    const state = figureVisualState(ONE_FIG, []);
    expect(state.order).toEqual(['capture/a.png']);
    expect(state.boundaryOf['capture/a.png']).toBe(1);
    expect(state.boundaryCount).toBe(4);
  });

  it('双图题：无覆盖时视觉序=内容序，边界=各图原段下标', () => {
    const state = figureVisualState(TWO_FIG, FIG_IMAGES);
    expect(state.order).toEqual(['capture/a.png', 'capture/b.png']);
    expect(state.boundaryOf['capture/a.png']).toBe(1);
    expect(state.boundaryOf['capture/b.png']).toBe(3);
    expect(state.boundaryCount).toBe(5);
  });

  it('旧 orderIndex 覆盖（槽位语义）→ 视觉序随覆盖变化', () => {
    const current: QuestionFigureLayout[] = [
      { assetId: 'capture/a.png', orderIndex: 1 },
      { assetId: 'capture/b.png', orderIndex: 0 },
    ];
    const state = figureVisualState(TWO_FIG, FIG_IMAGES, current);
    expect(state.order).toEqual(['capture/b.png', 'capture/a.png']);
  });
});

describe('fix-5 P0-2 落点 → 覆盖数组（物化锚点）', () => {
  it('单图拖到题干与选项之间（边界 1）→ 该图 anchorIndex=1，字段物化', () => {
    const figures = figuresAfterAnchorMove(ONE_FIG, [], undefined, 'capture/a.png', 1);
    expect(figures).toEqual([{ assetId: 'capture/a.png', orderIndex: 0, anchorIndex: 1 }]);
  });

  it('单图拖到题尾（边界=段数；fix-6 切分后段数 4）→ anchorIndex=4', () => {
    const figures = figuresAfterAnchorMove(ONE_FIG, [], undefined, 'capture/a.png', 4);
    expect(figures[0].anchorIndex).toBe(4);
  });

  it('越界锚位钳到 [0, 段数]', () => {
    expect(figuresAfterAnchorMove(ONE_FIG, [], undefined, 'capture/a.png', 99)[0].anchorIndex).toBe(4);
    expect(figuresAfterAnchorMove(ONE_FIG, [], undefined, 'capture/a.png', -5)[0].anchorIndex).toBe(0);
  });

  it('两图：b 拖到边界 1（a 之前）→ 视觉序 [b, a]，两图都物化锚点', () => {
    const figures = figuresAfterAnchorMove(TWO_FIG, FIG_IMAGES, undefined, 'capture/b.png', 1);
    expect(figures.map((f) => f.assetId)).toEqual(['capture/b.png', 'capture/a.png']);
    expect(figures.map((f) => f.anchorIndex)).toEqual([1, 1]);
    expect(figures.map((f) => f.orderIndex)).toEqual([0, 1]);
  });

  it('两图：a 拖到题尾（边界 4）→ 视觉序 [b, a]，a 在题尾', () => {
    const figures = figuresAfterAnchorMove(TWO_FIG, FIG_IMAGES, undefined, 'capture/a.png', 4);
    expect(figures.map((f) => f.assetId)).toEqual(['capture/b.png', 'capture/a.png']);
    expect(figures.map((f) => f.anchorIndex)).toEqual([3, 4]);
  });

  it('保留既有条目字段（宽度/对齐/版式）', () => {
    const current: QuestionFigureLayout[] = [
      { assetId: 'capture/a.png', widthPercent: 42, align: 'right', mode: 'side-by-side', orderIndex: 0 },
    ];
    const figures = figuresAfterAnchorMove(ONE_FIG, [], current, 'capture/a.png', 2);
    expect(figures[0]).toMatchObject({ assetId: 'capture/a.png', widthPercent: 42, align: 'right', mode: 'side-by-side', anchorIndex: 2 });
  });

  it('assetId 前缀形态（真机存量）同样命中并保留原写法', () => {
    const current: QuestionFigureLayout[] = [{ assetId: 'data-assets/capture/a.png', orderIndex: 0 }];
    const figures = figuresAfterAnchorMove(ONE_FIG, [], current, 'capture/a.png', 1);
    expect(figures).toHaveLength(1);
    expect(figures[0].assetId).toBe('data-assets/capture/a.png');
    expect(figures[0].anchorIndex).toBe(1);
  });

  it('外来图（content 无引用）也参与视觉序并可被拖动', () => {
    const current: QuestionFigureLayout[] = [{ assetId: 'logos/x.png', orderIndex: 0 }];
    const state = figureVisualState(ONE_FIG, [], current);
    expect(state.order).toContain('logos/x.png');
    const figures = figuresAfterAnchorMove(ONE_FIG, [], current, 'logos/x.png', 0);
    expect(figures.find((f) => f.assetId === 'logos/x.png')?.anchorIndex).toBe(0);
  });
});
