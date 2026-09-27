// 0056（R-064）：采集归一化「小图误判 inline-figure」判定改写。
//
// 现状（0016 前）：`INLINE_IMAGE_MAX_PX=200` 纯尺寸判定——宽高都 ≤200px 一律包 span.inline-figure，
// 而排版侧 0041 口径把 inline-figure 排除在图片排版外（不块化 / 不列出 / 点不动）
// → 菁优 94~197px 真配图被当成行内公式图，用户「图片无法调整」（诊断在案：
// inline-figure 诊断台账，真库 63 道）。
//
// 新判据（任务书 §零.10 拍板落入）：
//   ① 选项区（region='options'）恒行内——块级 figure 进 <span class="option"> 会破选项行版式；
//   ② 位图（非 .svg）且高 > 60px → 块级 figure（实测分离带宽裕：公式条高 ≤20px、真配图最小高 80px）；
//   ③ 位图高 ≤60px → 行内（公式条/小符号）；
//   ④ 非位图（.svg）与尺寸未知 → 块级（不引入「未知尺寸 → 行内 → 不可调」新盲区；大 SVG 同口径可调）。
//
// @vitest-environment jsdom

import { describe, it, expect } from 'vitest';

import { wrapImagesAsFigures, normalizeCaptured } from '../../src/capture/normalize.js';

/** 尺寸表（key = HTML 内 src = 落盘后的 data-assets 相对路径） */
function sizes(entries: Record<string, { width: number; height: number }>): Map<string, { width: number; height: number }> {
  return new Map(Object.entries(entries));
}

const IMG = (src: string): string => `<img src="${src}">`;

describe('0056 R-064 判定四态', () => {
  it('位图（png）且高 > 60px → 块级 figure.diagram（菁优 197×122 真配图）', () => {
    const html = wrapImagesAsFigures(
      IMG('data-assets/capture/jyeoo/jh1-1.png'),
      sizes({ 'data-assets/capture/jyeoo/jh1-1.png': { width: 197, height: 122 } }),
      'stem',
    );
    expect(html).toBe('<figure class="diagram" data-w="197" data-h="122"><img class="q-figure" src="data-assets/capture/jyeoo/jh1-1.png"></figure>');
  });

  it('位图高 ≤ 60px → 行内 span.inline-figure（公式条 84×20）', () => {
    const html = wrapImagesAsFigures(
      IMG('data-assets/capture/zujuan/f1.png'),
      sizes({ 'data-assets/capture/zujuan/f1.png': { width: 84, height: 20 } }),
      'stem',
    );
    expect(html).toBe('<span class="inline-figure"><img class="q-figure" data-w="84" data-h="20" src="data-assets/capture/zujuan/f1.png"></span>');
  });

  it('SVG 小图仍行内（组卷公式 33×12）', () => {
    const html = wrapImagesAsFigures(
      IMG('data-assets/capture/zujuan/f3.svg'),
      sizes({ 'data-assets/capture/zujuan/f3.svg': { width: 33, height: 12 } }),
      'stem',
    );
    expect(html).toContain('inline-figure');
  });

  it('SVG 大图同样走块级（非位图不给行内盲区——改判据只收窄位图）', () => {
    const html = wrapImagesAsFigures(
      IMG('data-assets/capture/zujuan/big.svg'),
      sizes({ 'data-assets/capture/zujuan/big.svg': { width: 400, height: 300 } }),
      'stem',
    );
    expect(html).toContain('<figure class="diagram"');
  });

  it('选项区位图高 > 60px 仍行内（拍板：选项区恒行内，不拽出文字流）', () => {
    const html = wrapImagesAsFigures(
      IMG('data-assets/capture/zujuan/opt-a.png'),
      sizes({ 'data-assets/capture/zujuan/opt-a.png': { width: 120, height: 90 } }),
      'options',
    );
    expect(html).toBe('<span class="inline-figure"><img class="q-figure" data-w="120" data-h="90" src="data-assets/capture/zujuan/opt-a.png"></span>');
  });

  it('尺寸未知 → 块级（沿用旧口径：未知不落「行内=不可调」盲区）', () => {
    const html = wrapImagesAsFigures(IMG('data-assets/capture/jyeoo/unknown.png'), new Map(), 'stem');
    expect(html).toBe('<figure class="diagram" data-w="0" data-h="0"><img class="q-figure" src="data-assets/capture/jyeoo/unknown.png"></figure>');
  });

  it('答案/解析区按新判据（位图高 > 60 → 块级）', () => {
    const html = wrapImagesAsFigures(
      IMG('data-assets/capture/zujuan/ans.png'),
      sizes({ 'data-assets/capture/zujuan/ans.png': { width: 160, height: 88 } }),
      'answer',
    );
    expect(html).toContain('<figure class="diagram"');
  });

  it('region 缺省 = 非选项区（旧调用点不传 region 时行为按新判据）', () => {
    const html = wrapImagesAsFigures(
      IMG('data-assets/capture/jyeoo/jh1-1.png'),
      sizes({ 'data-assets/capture/jyeoo/jh1-1.png': { width: 197, height: 122 } }),
    );
    expect(html).toContain('<figure class="diagram"');
  });
});

describe('0056 R-064 四调用点 region 透传（normalizeCaptured）', () => {
  const captured = {
    questionId: 'q1',
    site: 'jyeoo',
    sourceUrl: 'https://www.jyeoo.com/x',
    stemHtml: IMG('data-assets/capture/jyeoo/stem-1.png'),
    options: [IMG('data-assets/capture/zujuan/opt-a.png')],
    answerHtml: IMG('data-assets/capture/jyeoo/ans-1.png'),
    analysisHtml: IMG('data-assets/capture/jyeoo/ana-1.png'),
    images: [],
    meta: {},
    rect: null,
  };

  const localImages = [
    { localPath: 'data-assets/capture/jyeoo/stem-1.png', origSrc: 's1', role: 'content' as const, width: 197, height: 122 },
    { localPath: 'data-assets/capture/zujuan/opt-a.png', origSrc: 's2', role: 'content' as const, width: 120, height: 90 },
    { localPath: 'data-assets/capture/jyeoo/ans-1.png', origSrc: 's3', role: 'answer' as const, width: 160, height: 88 },
    { localPath: 'data-assets/capture/jyeoo/ana-1.png', origSrc: 's4', role: 'answer' as const, width: 150, height: 70 },
  ];

  it('题干区配图块级 / 选项区配图行内 / 答案区与解析区配图块级', () => {
    const normalized = normalizeCaptured(captured, localImages);
    // 题干区：块级
    expect(normalized.contentHtml).toContain('<figure class="diagram" data-w="197" data-h="122"><img class="q-figure" src="data-assets/capture/jyeoo/stem-1.png"></figure>');
    // 选项区：行内
    expect(normalized.contentHtml).toContain('<span class="option"><span class="inline-figure"><img class="q-figure" data-w="120" data-h="90" src="data-assets/capture/zujuan/opt-a.png"></span></span>');
    // 答案区 / 解析区：块级
    expect(normalized.answerHtml).toContain('<figure class="diagram"');
    expect(normalized.analysisHtml).toContain('<figure class="diagram"');
  });
});
