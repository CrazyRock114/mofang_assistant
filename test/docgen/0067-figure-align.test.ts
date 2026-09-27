/**
 * 0067（R-069）：图块宽度覆盖档下的对齐失效——修复锁定。
 *
 * 根因（任务书 §零.7）：`renderFigureBlock` 在 widthPercent 非 null 时恒产
 * `width:X%; margin-left:auto; margin-right:auto;`——内联双 auto 压过 `figure-block--{align}` 类的
 * text-align（align 类只对齐**块内**的 figure，块自身被双 auto 居中）⇒ 调宽后点「居左/居右」图不动。
 *
 * 修复（§零.8）：按 spec.align 产非对称边距（left→left:0/right:auto；right→left:auto/right:0；
 * center→双 auto 维持）。preview 与导出 PDF 同管线同时生效；不动 layout.ts 的 CSS、不用 !important。
 * DOCX 侧零改动（走段落 alignment，assemble.ts:251-253）。
 */

import { describe, it, expect } from 'vitest';
import { renderFigureBlock, type FigureRenderSpec } from '../../src/docgen/render/figureBlocks.js';

function spec(align: 'left' | 'center' | 'right', widthPercent: number | null): FigureRenderSpec {
  return {
    figure: { html: '<figure class="diagram"><img src="data-assets/capture/a.png"></figure>', assetId: 'capture/a.png' },
    align,
    sideBySide: false,
    widthPercent,
    orderKey: 0,
    domIndex: 0,
    anchorIndex: null,
  };
}

describe('0067 R-069 宽度覆盖档 × 对齐 → 非对称边距', () => {
  it('align=left + widthPercent → margin-left:0 / margin-right:auto（靠左）', () => {
    const html = renderFigureBlock(spec('left', 45));
    expect(html).toContain('style="width: 45%; margin-left: 0; margin-right: auto;"');
    expect(html).toContain('class="figure-block figure-block--left"');
  });

  it('align=right + widthPercent → margin-left:auto / margin-right:0（靠右）', () => {
    const html = renderFigureBlock(spec('right', 45));
    expect(html).toContain('style="width: 45%; margin-left: auto; margin-right: 0;"');
    expect(html).toContain('class="figure-block figure-block--right"');
  });

  it('align=center + widthPercent → 双 auto 维持（居中行为逐字节不变）', () => {
    const html = renderFigureBlock(spec('center', 45));
    expect(html).toContain('style="width: 45%; margin-left: auto; margin-right: auto;"');
  });

  it('无覆盖档（widthPercent=null）→ 三态均无内联尺寸样式（默认观感档零改动）', () => {
    for (const align of ['left', 'center', 'right'] as const) {
      const html = renderFigureBlock(spec(align, null));
      expect(html).toBe(
        `<div class="figure-block figure-block--${align}"><figure class="diagram"><img src="data-assets/capture/a.png"></figure></div>`
      );
    }
  });

  it('宽度格式化仍按 toFixed(2)（数字格式化语义不变）', () => {
    expect(renderFigureBlock(spec('left', 45.678))).toContain('style="width: 45.68%; margin-left: 0; margin-right: auto;"');
  });

  it('右对齐 + 内层拉满兜底共存（0058 情形 B 语义不回归）', () => {
    const html = renderFigureBlock({
      ...spec('right', 60),
      figure: { html: '<figure class="diagram"><img class="q-figure" src="data-assets/capture/a.png"></figure>', assetId: 'capture/a.png' },
    });
    expect(html).toContain('<figure class="diagram" style="width: 100%; max-width: 100%;">');
    expect(html).toContain('style="width: 60%; margin-left: auto; margin-right: 0;"');
  });
});
