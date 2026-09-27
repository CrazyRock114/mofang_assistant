// 0058（选项① 授权）：覆盖档「内层拉满」兜底单测。
// 依据 0058 停下申报 §四 选项①（用户 2026-09-22 拍板「按选项1来」）。
// 语义：widthPercent 非 null（有覆盖档）时，**无内联宽的图**（情形 B）也要交外层块控制尺寸——
// figure 与其内 img 同写 width:100%;max-width:100%，与运行时拖中 stretchFigureInner 同形；
// 否则落库后仍命中 paper.css 的 60% 默认档（figure→img 双重命中 ≈0.36）⇒ 拖中 1:1、松手回缩。
// 无覆盖档（widthPercent=null）→ 输出逐字节不变（打印/PDF 默认观感档零改动）。

import { describe, it, expect } from 'vitest';
import { renderFigureBlock, foreignFigureHtml, type FigureRenderSpec } from '../../src/docgen/render/figureBlocks.js';

function spec(html: string, widthPercent: number | null): FigureRenderSpec {
  return {
    figure: { html, assetId: 'capture/a.png' },
    align: 'center',
    sideBySide: false,
    widthPercent,
    orderKey: 0,
    domIndex: 0,
    anchorIndex: null,
  };
}

/** 情形 B 主形态：figure 无 data-w、无 style；内层 img 亦无 style（真库 28/28 均此形） */
const B_FIGURE = '<figure class="diagram"><img class="q-figure" src="data-assets/capture/a.png"></figure>';

describe('0058 情形 B 兜底：无内联宽 figure 覆盖档下补拉满', () => {
  it('figure 与内层 img 同写 width:100%;max-width:100%（拖中 ≡ 落库）', () => {
    const html = renderFigureBlock(spec(B_FIGURE, 60));
    expect(html).toContain('<figure class="diagram" style="width: 100%; max-width: 100%;">');
    expect(html).toMatch(/<img class="q-figure" src="data-assets\/capture\/a\.png" style="width: 100%; max-width: 100%;">/);
    // 块宽仍由 widthPercent 驱动（分母语义不变）
    expect(html).toContain('width: 60%; margin-left: auto; margin-right: auto;');
    // 内层拉满两处（figure + img），无第三处注入
    expect(html.match(/style="width: 100%/g)).toHaveLength(2);
  });

  it('裸 img 块（无内联宽）同样补拉满（figure-block > img 也吃 60% 默认档）', () => {
    const html = renderFigureBlock(spec('<img class="q-figure" src="data-assets/capture/a.png">', 45));
    expect(html).toMatch(/<img class="q-figure" src="data-assets\/capture\/a\.png" style="width: 100%; max-width: 100%;">/);
    expect(html).toContain('width: 45%;');
  });

  it('外来合成图（foreignFigureHtml，覆盖档缺省 60%）补拉满', () => {
    const html = renderFigureBlock(spec(foreignFigureHtml('logos/inserted.png'), 60));
    expect(html).toContain('<figure class="mf-foreign" style="width: 100%; max-width: 100%;">');
    expect(html).toMatch(/<img src="data-assets\/logos\/inserted\.png" style="width: 100%; max-width: 100%;">/);
  });

  it('无覆盖档（null）→ 输出逐字节不变（默认观感档 60% 仍由 CSS 承担）', () => {
    expect(renderFigureBlock(spec(B_FIGURE, null)))
      .toBe(`<div class="figure-block figure-block--center">${B_FIGURE}</div>`);
  });

  it('已有内联宽的 img 不被覆盖（不越权改用户/采集给定样式）', () => {
    const html = renderFigureBlock(spec('<figure class="diagram"><img class="q-figure" style="border: 1px solid #000;" src="data-assets/capture/a.png"></figure>', 50));
    expect(html).toContain('<figure class="diagram" style="width: 100%; max-width: 100%;">');
    expect(html).toContain('style="border: 1px solid #000;"');   // img 自带样式原样保留
    expect(html).not.toContain('border: 1px solid #000; width: 100%');
  });

  it('幂等：已拉满的内层原样透传，不再二次注入', () => {
    const filled = '<figure class="diagram" style="width: 100%; max-width: 100%;">'
      + '<img class="q-figure" src="data-assets/capture/a.png" style="width: 100%; max-width: 100%;"></figure>';
    const html = renderFigureBlock(spec(filled, 70));
    expect(html).toContain(filled);
    expect(html.match(/style="width: 100%/g)).toHaveLength(2);
  });

  it('情形 A（既有剥壳路径）行为不变：固定像素宽仍剥成 100%，且内层 img 一并拉满', () => {
    const html = renderFigureBlock(spec('<figure data-w="310" style="width: 310px; max-width: 60%; break-inside: avoid;"><img src="data-assets/capture/a.png"></figure>', 94.57));
    expect(html).toContain('width: 100%; max-width: 100%;');
    expect(html).not.toContain('width: 310px');
    // figure（剥壳） + img（0058 兜底补拉满）= 两处，且 img 拉满后「小自然宽图」也不会停在原像素宽
    expect(html.match(/style="width: 100%/g)).toHaveLength(2);
    expect(html).toContain('break-inside: avoid;');
  });
});
