// 0036 P2：框模型纯函数单测（任务书 §四 TDD 首项：归一化坐标换算 / 跨页框 / 撤销栈）
// @vitest-environment node

import { describe, it, expect } from 'vitest';
import {
  BOX_MIN_SIZE, CROP_PADDING, UNDO_LIMIT,
  boxesOfQuestion, boxesOnPage, containsPoint, createUndoStack, cropPlansForQuestion, denormalizeRect,
  hasActiveRun, hitTest, isQuestionLocked, makeBoxId, moveBox, nextBoxSeq, nextQuestionId, normalizeRect,
  questionIds, rectFromDrag, resizeBox, shortcutOf, unionRect,
} from '../../src/recog/splitting/box-model.js';
import type { SplitBox, SplitRunLink } from '../../src/shared/contracts/split-types.js';

const PAGE = { w: 1000, h: 2000 };

function box(partial: Partial<SplitBox> & { id: string; qid: string }): SplitBox {
  return { type: 'text', page: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.1, ...partial };
}

describe('0036 P2：归一化坐标换算', () => {
  it('像素 → 归一化（相对页尺寸）', () => {
    const r = normalizeRect({ x: 100, y: 400, w: 500, h: 200 }, PAGE);
    expect(r.x).toBe(0.1);
    expect(r.y).toBe(0.2);
    expect(r.w).toBeCloseTo(0.5, 10);
    expect(r.h).toBeCloseTo(0.1, 10);
  });

  it('越界部分夹回页内（宽高按夹取后的边界重算，不产生反向矩形）', () => {
    const r = normalizeRect({ x: 900, y: 1900, w: 400, h: 400 }, PAGE);
    expect(r.x).toBe(0.9);
    expect(r.y).toBe(0.95);
    expect(r.w).toBeCloseTo(0.1, 10);
    expect(r.h).toBeCloseTo(0.05, 10);
  });

  it('负向矩形归零（拖到页外时不出现负宽高）', () => {
    expect(normalizeRect({ x: -100, y: -100, w: -50, h: -50 }, PAGE)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });

  it('非法页尺寸（0）不产生 NaN', () => {
    expect(normalizeRect({ x: 10, y: 10, w: 10, h: 10 }, { w: 0, h: 0 })).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });

  it('归一化 ↔ 像素严格互逆（缩放/DPI 变化不影响已画框）', () => {
    const norm = normalizeRect({ x: 123, y: 456, w: 321, h: 654 }, PAGE);
    const back = denormalizeRect(norm, PAGE);
    expect(back.x).toBeCloseTo(123, 9);
    expect(back.y).toBeCloseTo(456, 9);
    expect(back.w).toBeCloseTo(321, 9);
    expect(back.h).toBeCloseTo(654, 9);
  });
});

describe('0036 P2：拖拽建框', () => {
  it('任意方向拖拽都得到同一个正矩形（右下→左上同样成立）', () => {
    const a = rectFromDrag({ x: 100, y: 200 }, { x: 400, y: 600 }, PAGE);
    const b = rectFromDrag({ x: 400, y: 600 }, { x: 100, y: 200 }, PAGE);
    expect(a).toEqual(b);
    expect(a?.x).toBe(0.1);
    expect(a?.y).toBe(0.1);
    expect(a?.w).toBeCloseTo(0.3, 10);
    expect(a?.h).toBeCloseTo(0.2, 10);
  });

  it('过小的拖拽返回 null（防误点生成零面积框）', () => {
    expect(rectFromDrag({ x: 100, y: 100 }, { x: 101, y: 101 }, PAGE)).toBeNull();
  });

  it('最小边长门槛即 BOX_MIN_SIZE', () => {
    const justUnder = rectFromDrag({ x: 0, y: 0 }, { x: PAGE.w * BOX_MIN_SIZE * 0.5, y: 200 }, PAGE);
    const justOver = rectFromDrag({ x: 0, y: 0 }, { x: 10, y: 200 }, PAGE);
    expect(justUnder).toBeNull();
    expect(justOver).not.toBeNull();
  });

  it('拖到页外时夹回页内', () => {
    const r = rectFromDrag({ x: 800, y: 1800 }, { x: 5000, y: 5000 }, PAGE);
    expect(r).not.toBeNull();
    expect(r?.x).toBe(0.8);
    expect(r?.y).toBe(0.9);
    expect(r?.w).toBeCloseTo(0.2, 10);
    expect(r?.h).toBeCloseTo(0.1, 10);
  });
});

describe('0036 P2：命中与变换', () => {
  const boxes: SplitBox[] = [
    box({ id: 'p1-b1', qid: 'q1', x: 0.1, y: 0.1, w: 0.6, h: 0.6 }),
    box({ id: 'p1-b2', qid: 'q1', x: 0.2, y: 0.2, w: 0.1, h: 0.1 }),
    box({ id: 'p2-b3', qid: 'q2', page: 2, x: 0.1, y: 0.1, w: 0.2, h: 0.2 }),
  ];

  it('重叠时命中面积最小的框（题干大框里圈的小框优先）', () => {
    expect(hitTest(boxes, 1, { x: 0.25, y: 0.25 })?.id).toBe('p1-b2');
  });

  it('同页非重叠区命中大框；页外/跨页不误命中', () => {
    expect(hitTest(boxes, 1, { x: 0.6, y: 0.6 })?.id).toBe('p1-b1');
    expect(hitTest(boxes, 1, { x: 0.9, y: 0.02 })).toBeNull();
    expect(hitTest(boxes, 2, { x: 0.25, y: 0.25 })?.id).toBe('p2-b3');
  });

  it('containsPoint 边界含等号（贴边点得住）', () => {
    const b = box({ id: 'x', qid: 'q1', x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
    expect(containsPoint(b, { x: 0.1, y: 0.1 })).toBe(true);
    expect(containsPoint(b, { x: 0.3, y: 0.3 })).toBe(true);
    expect(containsPoint(b, { x: 0.31, y: 0.3 })).toBe(false);
  });

  it('平移夹回页内（贴边不越界，宽高不变）', () => {
    const b = box({ id: 'x', qid: 'q1', x: 0.9, y: 0.9, w: 0.2, h: 0.2 });
    const moved = moveBox(b, 0.5, 0.5);
    expect(moved.x).toBeCloseTo(0.8, 10);
    expect(moved.y).toBeCloseTo(0.8, 10);
    expect({ w: moved.w, h: moved.h }).toEqual({ w: 0.2, h: 0.2 });
  });

  it('缩放手柄：对边固定、越界夹住、缩到最小边长即停（不翻转）', () => {
    const b = box({ id: 'x', qid: 'q1', x: 0.2, y: 0.2, w: 0.4, h: 0.4 });
    // 拖右下角扩大
    expect(resizeBox(b, 'se', { x: 0.9, y: 0.9 })).toMatchObject({ x: 0.2, y: 0.2, w: 0.7, h: 0.7 });
    // 拖左上角向右下越过右边界 → 停在最小边长，不翻转
    const flipped = resizeBox(b, 'nw', { x: 0.99, y: 0.99 });
    expect(flipped.w).toBeCloseTo(BOX_MIN_SIZE, 10);
    expect(flipped.h).toBeCloseTo(BOX_MIN_SIZE, 10);
    // 拖上边不下移下边
    expect(resizeBox(b, 'n', { x: 0.5, y: 0.05 })).toMatchObject({ y: 0.05, h: 0.55 });
  });

  it('按页/按题取框与题号列表', () => {
    expect(boxesOnPage(boxes, 1).map((b) => b.id)).toEqual(['p1-b1', 'p1-b2']);
    expect(boxesOfQuestion(boxes, 'q1').map((b) => b.id)).toEqual(['p1-b1', 'p1-b2']);
    expect(questionIds(boxes)).toEqual(['q1', 'q2']);
  });

  it('题号与框号续号不复用（删题后不与已发起 run 串号）', () => {
    expect(nextQuestionId(boxes)).toBe('q3');
    expect(nextQuestionId([])).toBe('q1');
    expect(nextBoxSeq(boxes)).toBe(4);
    expect(makeBoxId(7, 3)).toBe('p7-b3');
  });
});

describe('0036 P2：跨页框与一题一 run 裁剪计划', () => {
  const sizes = new Map([
    [1, { w: 1000, h: 2000 }],
    [2, { w: 1000, h: 2000 }],
  ]);

  it('跨页题：按页各出一张裁剪图，页序升序', () => {
    const boxes: SplitBox[] = [
      box({ id: 'p1-b1', qid: 'q1', page: 1, x: 0.1, y: 0.5, w: 0.5, h: 0.2 }),
      box({ id: 'p2-b2', qid: 'q1', page: 2, x: 0.1, y: 0.05, w: 0.5, h: 0.1, type: 'answer' }),
    ];
    const plans = cropPlansForQuestion(boxes, sizes);
    expect(plans.map((p) => p.page)).toEqual([1, 2]);
  });

  it('同页多框取并集（题干+配图+答案合并成一张小图，只送小图给 vision）', () => {
    const boxes: SplitBox[] = [
      box({ id: 'p1-b1', qid: 'q1', page: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.1, type: 'text' }),
      box({ id: 'p1-b2', qid: 'q1', page: 1, x: 0.5, y: 0.3, w: 0.2, h: 0.2, type: 'image' }),
    ];
    const plans = cropPlansForQuestion(boxes, sizes, 0);
    expect(plans).toHaveLength(1);
    // 并集：x 0.1→0.7（px 100→700），y 0.1→0.5（px 200→1000）
    expect(plans[0].rect).toEqual({ x: 100, y: 200, w: 600, h: 800 });
  });

  it('默认带留白（贴字太紧会切掉靠边字符）', () => {
    const boxes: SplitBox[] = [box({ id: 'p1-b1', qid: 'q1', page: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.1 })];
    const [plan] = cropPlansForQuestion(boxes, sizes);
    expect(plan.rect.x).toBeCloseTo(100 - 1000 * CROP_PADDING, 6);
    expect(plan.rect.y).toBeCloseTo(200 - 2000 * CROP_PADDING, 6);
    // 留白确实让裁剪窗口大于框本身
    expect(plan.rect.w).toBeGreaterThan(200);
  });

  it('留白在页边被夹住（不产生越界裁剪区域）', () => {
    const boxes: SplitBox[] = [box({ id: 'p1-b1', qid: 'q1', page: 1, x: 0, y: 0, w: 1, h: 1 })];
    const [plan] = cropPlansForQuestion(boxes, sizes);
    expect(plan.rect).toEqual({ x: 0, y: 0, w: 1000, h: 2000 });
  });

  it('缺页尺寸时跳过该页（宁可少送一页，也不按错误坐标裁剪）', () => {
    const boxes: SplitBox[] = [
      box({ id: 'p1-b1', qid: 'q1', page: 1 }),
      box({ id: 'p9-b2', qid: 'q1', page: 9 }),
    ];
    expect(cropPlansForQuestion(boxes, sizes).map((p) => p.page)).toEqual([1]);
  });

  it('空框集返回空计划', () => {
    expect(cropPlansForQuestion([], sizes)).toEqual([]);
  });

  it('unionRect：空集为 null，否则最小外接矩形', () => {
    expect(unionRect([])).toBeNull();
    const u = unionRect([{ x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, { x: 0.5, y: 0.4, w: 0.1, h: 0.1 }]);
    expect(u).not.toBeNull();
    expect(u?.x).toBeCloseTo(0.1, 10);
    expect(u?.y).toBeCloseTo(0.1, 10);
    expect(u?.w).toBeCloseTo(0.5, 10);
    expect(u?.h).toBeCloseTo(0.4, 10);
  });
});

describe('0036 P2：撤销栈（任务书要求 ≥20 步）', () => {
  it('默认深度 50（≥ 任务书下限 20）', () => {
    expect(UNDO_LIMIT).toBe(50);
    expect(UNDO_LIMIT).toBeGreaterThanOrEqual(20);
  });

  it('提交 → 撤销 → 重做闭环', () => {
    const stack = createUndoStack<string>('a');
    stack.push('b');
    stack.push('c');
    expect(stack.present()).toBe('c');
    expect(stack.undo()).toBe('b');
    expect(stack.undo()).toBe('a');
    expect(stack.undo()).toBeNull();
    expect(stack.canUndo()).toBe(false);
    expect(stack.redo()).toBe('b');
  });

  it('新提交清空重做栈（撤销后改框不能再「重做」回旧分支）', () => {
    const stack = createUndoStack<string>('a');
    stack.push('b');
    stack.undo();
    stack.push('c');
    expect(stack.canRedo()).toBe(false);
    expect(stack.present()).toBe('c');
  });

  it('超过深度上限时丢弃最老快照（可撤销步数 = 上限）', () => {
    const stack = createUndoStack<number>(0, 3);
    for (let i = 1; i <= 10; i++) stack.push(i);
    let steps = 0;
    while (stack.canUndo()) {
      stack.undo();
      steps++;
    }
    expect(steps).toBe(3);
    expect(stack.present()).toBe(7);
  });

  it('深度至少 20 步（任务书硬要求）', () => {
    const stack = createUndoStack<number>(0);
    for (let i = 1; i <= 25; i++) stack.push(i);
    expect(stack.undoDepth()).toBe(25);
  });
});

describe('0036 P2：锁定语义与快捷键', () => {
  const runs: SplitRunLink[] = [
    { qid: 'q1', runId: 'r1', status: 'done', questionIds: ['qq1'] },
    { qid: 'q2', runId: 'r2', status: 'ocr', questionIds: [] },
    { qid: 'q3', runId: 'r3', status: 'error', questionIds: [] },
  ];

  it('识别完成（done）才锁定框与课程；失败/取消不锁（要能改框重试）', () => {
    expect(isQuestionLocked(runs, 'q1')).toBe(true);
    expect(isQuestionLocked(runs, 'q2')).toBe(false);
    expect(isQuestionLocked(runs, 'q3')).toBe(false);
    expect(isQuestionLocked(runs, 'q4')).toBe(false);
  });

  it('在跑判定覆盖 creating/queued/ocr/ai（决定本段能否再发起识别）', () => {
    expect(hasActiveRun(runs)).toBe(true);
    expect(hasActiveRun([runs[0]])).toBe(false);
    expect(hasActiveRun([{ qid: 'q9', runId: 'r9', status: 'creating', questionIds: [] }])).toBe(true);
  });

  it('快捷键：删除/撤销/重做/上下一题/取消', () => {
    expect(shortcutOf({ key: 'Delete' })).toBe('delete');
    expect(shortcutOf({ key: 'Backspace' })).toBe('delete');
    expect(shortcutOf({ key: 'z', ctrl: true })).toBe('undo');
    expect(shortcutOf({ key: 'Z', meta: true })).toBe('undo');
    expect(shortcutOf({ key: 'z', ctrl: true, shift: true })).toBe('redo');
    expect(shortcutOf({ key: 'y', ctrl: true })).toBe('redo');
    expect(shortcutOf({ key: 'ArrowDown' })).toBe('next-question');
    expect(shortcutOf({ key: 'PageUp' })).toBe('prev-question');
    expect(shortcutOf({ key: 'Escape' })).toBe('escape');
    expect(shortcutOf({ key: 'a' })).toBeNull();
    expect(shortcutOf({ key: 'z' })).toBeNull();
  });
});
