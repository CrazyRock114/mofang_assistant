// 0004-fix-4 #7（目检 #7「依旧只有部分图可调」）：图默认全可调。
// 参与集放宽 = 非公式/答案/解析语义的题内图（含无语义裸行内 img、无 data-w）默认参与块化；
// 公式/答案/解析语义豁免不变（留文本流）；外源 src（http/data）无 assetId 仍不参与。

import { describe, it, expect } from 'vitest';
import type { Paper, Question } from '../../src/shared/contracts/bank-types.js';
import { buildPaperHtml } from '../../src/docgen/render/buildPaperHtml.js';
import { blockifyQuestionContent, buildImageTypeTable } from '../../src/docgen/render/figureBlocks.js';

const paper: Paper = {
  id: 'fix4-all-adjustable',
  title: '图默认全可调探针卷',
  config: {},
  createdAt: '2026-09-09T00:00:00Z',
  archived: false,
};

function bodyOf(html: string): string {
  return html.slice(html.indexOf('<body>'), html.indexOf('</body>'));
}

describe('fix-4 #7 参与集放宽（blockify 纯函数）', () => {
  it('无语义裸行内 img（无 data-w）→ 参与块化（figure 段）', () => {
    const blocks = blockifyQuestionContent(
      '<p><img src="data-assets/capture/bare.png"></p>',
      buildImageTypeTable([])
    );
    expect(blocks.figures.map((f) => f.assetId)).toEqual(['capture/bare.png']);
    expect(blocks.textHtml).not.toContain('<img');
  });

  it('figure 语义行内 img（无 data-w）→ 参与', () => {
    const blocks = blockifyQuestionContent(
      '<p><img src="data-assets/capture/f.png"></p>',
      buildImageTypeTable([{ assetId: 'capture/f.png', type: 'figure' }])
    );
    expect(blocks.figures).toHaveLength(1);
  });

  it('公式/答案/解析语义行内 img → 豁免（留文本流）', () => {
    const types = buildImageTypeTable([
      { assetId: 'capture/formula.svg', type: 'formula-image' },
      { assetId: 'capture/ans.png', type: 'answer-image' },
      { assetId: 'capture/ana.png', type: 'analysis-image' },
    ]);
    for (const assetId of ['capture/formula.svg', 'capture/ans.png', 'capture/ana.png']) {
      const blocks = blockifyQuestionContent(`<p><img src="data-assets/${assetId}"></p>`, types);
      expect(blocks.figures).toHaveLength(0);
      expect(blocks.textHtml).toContain(assetId);
    }
  });

  it('外源 src（http/data）无 assetId → 不参与（覆盖机制无从追踪）', () => {
    const blocks = blockifyQuestionContent(
      '<p><img src="https://example.com/a.png"><img src="data:image/png;base64,AAA"></p>',
      buildImageTypeTable([])
    );
    expect(blocks.figures).toHaveLength(0);
  });
});

describe('fix-4 #7 渲染面：裸行内图默认块化（可拖拽/可缩放）', () => {
  it('config 路径下裸行内图输出 .figure-block（不再留文本流）', async () => {
    const q: Question = {
      id: 'q-bare-inline',
      subject: '物理',
      sourceType: 'network',
      sourceDetail: { site: 'xuke' },
      content: '<div class="question">题干<img src="data-assets/capture/bare-inline.png">文字</div>',
      images: [],
    };
    const body = bodyOf(
      await buildPaperHtml(paper, [q], {
        mode: 'student',
        assetsRoot: '/tmp/assets',
        layoutConfig: { version: 2 },
      })
    );
    expect(body).toContain('<div class="figure-block figure-block--center"');
    expect(body).toContain('file:///tmp/assets/capture/bare-inline.png');
    // 图块带 data-mf 锚点能力（交互层按 .figure-block 增强）：不再被 <p> 文本流包住
    expect(body).not.toMatch(/<p><img[^>]*bare-inline/);
  });

  it('公式语义图 + 覆盖条目 → 仍留文本流（豁免不变）', async () => {
    const q: Question = {
      id: 'q-formula',
      subject: '物理',
      sourceType: 'network',
      sourceDetail: { site: 'xuke' },
      content: '<div class="question">题干<span class="inline-figure"><img src="data-assets/capture/f.svg"></span></div>',
      images: [{ assetId: 'capture/f.svg', type: 'formula-image', width: 42 }],
    };
    const body = bodyOf(
      await buildPaperHtml(paper, [q], {
        mode: 'student',
        layoutConfig: { version: 2 },
        questionLayouts: { [q.id]: { figures: [{ assetId: 'capture/f.svg', orderIndex: 0 }] } },
      })
    );
    expect(body).not.toContain('figure-block');
    expect(body).toContain('inline-figure');
  });
});
