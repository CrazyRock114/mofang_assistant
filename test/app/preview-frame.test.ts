// 0004-fix-2 F2-D：预览 iframe postMessage 协议单测（D 组处理器锚点）。
// parse 白名单收窄（非法/伪造消息返回 null）+ 纯 reducer（图缩放/对齐/版式/换位、Logo 拖拽/缩放）
// 语义断言。纯 Node 无 DOM（协议模块本身零 DOM 依赖）。
// 0004-fix-3：新增 mf-figure-remove 消息/移除 reducer + 预览缩放状态机纯函数。

import { describe, it, expect } from 'vitest';
import {
  parsePreviewMessage,
  upsertFigureEntry,
  removeFigureEntry,
  figureOrderAfterMove,
  logoAfterDrag,
  logoAfterResize,
} from '../../src/app/pages/preview-frame-protocol.js';
import { clampZoom, stepZoom } from '../../src/app/pages/PaperPreviewFrame.js';

describe('fix-2 F2-D parsePreviewMessage：消息白名单收窄', () => {
  it('协议消息逐型收窄成功', () => {
    expect(parsePreviewMessage({ t: 'mf-preview-ready', height: 800 })).toEqual({ t: 'mf-preview-ready', height: 800 });
    expect(parsePreviewMessage({ t: 'mf-height', height: 1234.5 })).toEqual({ t: 'mf-height', height: 1234.5 });
    expect(parsePreviewMessage({ t: 'mf-figure-resize', questionId: 'q1', assetId: 'capture/a.png', widthPercent: 42.5 }))
      .toEqual({ t: 'mf-figure-resize', questionId: 'q1', assetId: 'capture/a.png', widthPercent: 42.5 });
    expect(parsePreviewMessage({ t: 'mf-figure-align', questionId: 'q1', assetId: 'a', align: 'left' }))
      .toEqual({ t: 'mf-figure-align', questionId: 'q1', assetId: 'a', align: 'left' });
    expect(parsePreviewMessage({ t: 'mf-figure-mode', questionId: 'q1', assetId: 'a', mode: 'side-by-side' }))
      .toEqual({ t: 'mf-figure-mode', questionId: 'q1', assetId: 'a', mode: 'side-by-side' });
    expect(parsePreviewMessage({ t: 'mf-figure-move', questionId: 'q1', assetId: 'b', beforeAssetId: null }))
      .toEqual({ t: 'mf-figure-move', questionId: 'q1', assetId: 'b', beforeAssetId: null });
    expect(parsePreviewMessage({ t: 'mf-figure-remove', questionId: 'q1', assetId: 'logos/x.png' }))
      .toEqual({ t: 'mf-figure-remove', questionId: 'q1', assetId: 'logos/x.png' });
    expect(parsePreviewMessage({ t: 'mf-logo-drag', index: 0, xRatio: 0.1, yRatio: 0.2 }))
      .toEqual({ t: 'mf-logo-drag', index: 0, xRatio: 0.1, yRatio: 0.2 });
    expect(parsePreviewMessage({ t: 'mf-logo-resize', index: 1, widthRatio: 0.3 }))
      .toEqual({ t: 'mf-logo-resize', index: 1, widthRatio: 0.3 });
    expect(parsePreviewMessage({ t: 'mf-title-click' })).toEqual({ t: 'mf-title-click' });
  });

  it('伪造/坏结构消息一律 null（不炸不透传）', () => {
    expect(parsePreviewMessage(null)).toBeNull();
    expect(parsePreviewMessage('str')).toBeNull();
    expect(parsePreviewMessage({})).toBeNull();
    expect(parsePreviewMessage({ t: 'other' })).toBeNull();
    // 逐字段坏值
    expect(parsePreviewMessage({ t: 'mf-figure-resize', questionId: 'q1', assetId: 'a', widthPercent: 'big' })).toBeNull();
    expect(parsePreviewMessage({ t: 'mf-figure-align', questionId: 'q1', assetId: 'a', align: 'top' })).toBeNull();
    expect(parsePreviewMessage({ t: 'mf-figure-mode', questionId: 'q1', assetId: 'a', mode: 'float' })).toBeNull();
    expect(parsePreviewMessage({ t: 'mf-figure-move', questionId: 'q1', assetId: 'b', beforeAssetId: 3 })).toBeNull();
    expect(parsePreviewMessage({ t: 'mf-figure-remove', questionId: 'q1' })).toBeNull();
    expect(parsePreviewMessage({ t: 'mf-logo-drag', index: '0', xRatio: 0.1, yRatio: 0.2 })).toBeNull();
    expect(parsePreviewMessage({ t: 'mf-height' })).toBeNull();
  });
});

describe('fix-2 F2-D 题级覆盖 reducers', () => {
  it('upsertFigureEntry：已有条目合入 patch（保持其它字段），无条目追加', () => {
    const current = [
      { assetId: 'a.png', widthPercent: 30, orderIndex: 0 },
      { assetId: 'b.png', orderIndex: 1 },
    ];
    const patched = upsertFigureEntry(current, 'b.png', { align: 'right' });
    expect(patched).toEqual([
      { assetId: 'a.png', widthPercent: 30, orderIndex: 0 },
      { assetId: 'b.png', orderIndex: 1, align: 'right' },
    ]);
    // 原数组不被改变（纯函数）
    expect(current[1]).toEqual({ assetId: 'b.png', orderIndex: 1 });

    const appended = upsertFigureEntry(current, 'c.png', { mode: 'side-by-side' });
    expect(appended).toHaveLength(3);
    expect(appended[2]).toEqual({ assetId: 'c.png', mode: 'side-by-side' });
  });

  it('upsertFigureEntry：未覆盖题（undefined）首条创建', () => {
    expect(upsertFigureEntry(undefined, 'a.png', { widthPercent: 25 })).toEqual([
      { assetId: 'a.png', widthPercent: 25 },
    ]);
  });

  it('figureOrderAfterMove：移动到指定图之前（orderIndex 全量重排）', () => {
    const domOrder = ['a.png', 'b.png', 'c.png'];
    const moved = figureOrderAfterMove(domOrder, undefined, 'c.png', 'a.png');
    expect(moved.map((f) => f.assetId)).toEqual(['c.png', 'a.png', 'b.png']);
    expect(moved.map((f) => f.orderIndex)).toEqual([0, 1, 2]);
  });

  it('figureOrderAfterMove：beforeAssetId=null = 移到题尾', () => {
    const domOrder = ['a.png', 'b.png'];
    const moved = figureOrderAfterMove(domOrder, undefined, 'a.png', null);
    expect(moved.map((f) => f.assetId)).toEqual(['b.png', 'a.png']);
    expect(moved.map((f) => f.orderIndex)).toEqual([0, 1]);
  });

  it('figureOrderAfterMove：已有覆盖的图保留字段（对齐/宽度不丢），未覆盖图按 DOM 序补充', () => {
    const domOrder = ['a.png', 'b.png', 'c.png'];
    const current = [{ assetId: 'a.png', align: 'right' as const, widthPercent: 40, orderIndex: 0 }];
    const moved = figureOrderAfterMove(domOrder, current, 'b.png', 'a.png');
    expect(moved.map((f) => f.assetId)).toEqual(['b.png', 'a.png', 'c.png']);
    const a = moved.find((f) => f.assetId === 'a.png');
    expect(a?.align).toBe('right');
    expect(a?.widthPercent).toBe(40);
    expect(moved.map((f) => f.orderIndex)).toEqual([0, 1, 2]);
  });

  it('figureOrderAfterMove：beforeAssetId 不在列表 → 回落题尾（不炸）', () => {
    const moved = figureOrderAfterMove(['a.png', 'b.png'], undefined, 'b.png', 'ghost.png');
    expect(moved.map((f) => f.assetId)).toEqual(['a.png', 'b.png']);
  });
});

describe('fix-2 F2-D Logo reducers', () => {
  it('logoAfterDrag：比例坐标钳到 [0,1] 并保留 assetId/widthRatio', () => {
    const logo = { assetId: 'logos/x.png', xRatio: 0.2, yRatio: 0.1, widthRatio: 0.15 };
    expect(logoAfterDrag(logo, 1.5, -0.3)).toEqual({ assetId: 'logos/x.png', xRatio: 1, yRatio: 0, widthRatio: 0.15 });
    expect(logoAfterDrag(logo, 0.5555, 0.1234).xRatio).toBe(0.56);
    expect(logoAfterDrag(logo, 0.5555, 0.1234).yRatio).toBe(0.12);
  });

  it('logoAfterResize：widthRatio 钳到 (0,1]', () => {
    const logo = { assetId: 'logos/x.png', xRatio: 0.2, yRatio: 0.1, widthRatio: 0.15 };
    expect(logoAfterResize(logo, 0.5).widthRatio).toBe(0.5);
    expect(logoAfterResize(logo, 9).widthRatio).toBe(1);
    expect(logoAfterResize(logo, 0).widthRatio).toBe(0.01);
  });
});

// ==================== 0004-fix-3：移除 reducer + 预览缩放状态机 ====================

describe('fix-3 mf-figure-remove reducer', () => {
  it('removeFigureEntry：删目标条目保留其余（纯函数，不改入参）', () => {
    const current = [
      { assetId: 'a.png', orderIndex: 0 },
      { assetId: 'logos/x.png', orderIndex: 1, widthPercent: 60 },
    ];
    expect(removeFigureEntry(current, 'logos/x.png')).toEqual([{ assetId: 'a.png', orderIndex: 0 }]);
    expect(current).toHaveLength(2); // 入参不变
  });

  it('removeFigureEntry：未覆盖题/不存在条目 → 空数组兜底', () => {
    expect(removeFigureEntry(undefined, 'a.png')).toEqual([]);
    expect(removeFigureEntry([{ assetId: 'a.png' }], 'ghost.png')).toEqual([{ assetId: 'a.png' }]);
  });
});

describe('fix-3 预览缩放状态机（clampZoom/stepZoom 纯函数）', () => {
  it('clampZoom：钳到 [0.3, 3] 并保留两位小数；非法值回落 1', () => {
    expect(clampZoom(0.05)).toBe(0.3);
    expect(clampZoom(5)).toBe(3);
    expect(clampZoom(1.2349)).toBe(1.23);
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(Number.NaN)).toBe(1);
  });

  it('stepZoom：放大 ×1.1 / 缩小 ÷1.1，从适应档数值起步并钳界', () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1.1, -1)).toBe(1);
    expect(stepZoom(2.9, 1)).toBe(3);
    expect(stepZoom(0.32, -1)).toBe(0.3);
  });
});

// ==================== 0013 选项版式协议（mf-question-options-layout） ====================

describe('0013 parsePreviewMessage：选项版式消息收窄', () => {
  it('三合法 mode 收窄成功', () => {
    expect(parsePreviewMessage({ t: 'mf-question-options-layout', questionId: 'q1', mode: 'auto' }))
      .toEqual({ t: 'mf-question-options-layout', questionId: 'q1', mode: 'auto' });
    expect(parsePreviewMessage({ t: 'mf-question-options-layout', questionId: 'q1', mode: 'single-line' }))
      .toEqual({ t: 'mf-question-options-layout', questionId: 'q1', mode: 'single-line' });
    expect(parsePreviewMessage({ t: 'mf-question-options-layout', questionId: 'q1', mode: 'two-lines' }))
      .toEqual({ t: 'mf-question-options-layout', questionId: 'q1', mode: 'two-lines' });
  });

  it('坏结构/伪造消息一律 null', () => {
    expect(parsePreviewMessage({ t: 'mf-question-options-layout', questionId: 'q1', mode: 'bogus' })).toBeNull();
    expect(parsePreviewMessage({ t: 'mf-question-options-layout', questionId: 'q1' })).toBeNull();
    expect(parsePreviewMessage({ t: 'mf-question-options-layout', mode: 'auto' })).toBeNull();
    expect(parsePreviewMessage({ t: 'mf-question-options-layout', questionId: 1, mode: 'auto' })).toBeNull();
  });
});
