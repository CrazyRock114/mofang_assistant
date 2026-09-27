// 0035 P3：版式映射纯函数（ResolvedLayout → twip/pt/px）——纸张/取向/双栏/页边距/字号。

import { describe, it, expect } from 'vitest';
import { resolveLayout } from '../../src/docgen/render/layout.js';
import {
  mmToTwip,
  ptToHalfPoints,
  ptToPx,
  mapLayout,
  DEFAULT_BODY_LINE,
  DEFAULT_QUESTION_LINE,
} from '../../src/docgen/export/docx/layout-map.js';

describe('0035 layout-map：twip/pt/px 换算', () => {
  it('mm → twip（1mm = 1440/25.4 twip，四舍五入）', () => {
    expect(mmToTwip(25.4)).toBe(1440);
    expect(mmToTwip(210)).toBe(11906); // A4 宽
    expect(mmToTwip(297)).toBe(16838); // A4 高
    expect(mmToTwip(15)).toBe(850);
  });

  it('pt → half-points / px（Word 字号半磅；96dpi 像素）', () => {
    expect(ptToHalfPoints(12)).toBe(24);
    expect(ptToHalfPoints(10.5)).toBe(21);
    expect(ptToPx(12)).toBe(16);
    expect(ptToPx(18)).toBe(24);
  });
});

describe('0035 layout-map：ResolvedLayout → 页面规格', () => {
  it('缺省（A4 竖版单栏）尺寸/页边距/字号/行距全落定', () => {
    const spec = mapLayout(resolveLayout(undefined));
    expect(spec.widthTwip).toBe(11906);
    expect(spec.heightTwip).toBe(16838);
    expect(spec.orientation).toBe('portrait');
    expect(spec.marginTwip).toEqual({ top: 1134, right: 850, bottom: 1134, left: 850 });
    expect(spec.columns).toBe(1);
    expect(spec.baseFontHalfPoints).toBe(24);
    expect(spec.baseFontPx).toBe(16);
    expect(spec.bodyLineTwip).toBe(DEFAULT_BODY_LINE);
    expect(spec.questionLineTwip).toBe(DEFAULT_QUESTION_LINE);
  });

  it('A3 横版：物理宽高互换（不依赖 w:orient 属性）', () => {
    const spec = mapLayout(resolveLayout({ version: 2, pageSize: 'A3', orientation: 'landscape' }));
    expect(spec.widthTwip).toBe(23811); // 420mm
    expect(spec.heightTwip).toBe(16838); // 297mm
    expect(spec.orientation).toBe('landscape');
  });

  it('双栏：栏数 + 栏间距 twip；版心宽扣除左右边距', () => {
    const spec = mapLayout(resolveLayout({ version: 2, columns: 2, columnGapMm: 8, pageMarginMm: { top: 10, right: 20, bottom: 10, left: 20 } }));
    expect(spec.columns).toBe(2);
    expect(spec.columnGapTwip).toBe(mmToTwip(8));
    expect(spec.contentWidthTwip).toBe(mmToTwip(210) - mmToTwip(20) * 2);
    expect(spec.contentWidthPx).toBe(Math.round((210 - 40) * 96 / 25.4));
  });

  it('字号/行距配置生效（行距为倍数 → 240 分之一行）', () => {
    const spec = mapLayout(resolveLayout({ version: 2, fontSize: 14, lineHeight: 1.5 }));
    expect(spec.baseFontHalfPoints).toBe(28);
    expect(spec.baseFontPx).toBeCloseTo(14 * 96 / 72, 6);
    expect(spec.bodyLineTwip).toBe(Math.round(240 * 1.5));
    expect(spec.questionLineTwip).toBe(Math.round(240 * 1.5));
  });
});
