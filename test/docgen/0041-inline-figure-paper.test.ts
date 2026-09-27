// 0041：排版侧行内公式图尺寸修复——`.inline-figure` 包裹的行内公式图**留文本流**（不块化）。
// 为什么：块化会在 span 内插 div.figure-block，使 paper.css `.inline-figure > img`（0010 P5：
//   min-height 1.25×字号 + width:auto 等比 + 200px 封顶）直系选择器失配，且被
//   `.figure-block > img { max-width: 60% }` 相对 shrink-to-fit 盒再收缩（真机实测
//   排版 34.2×7.2 vs 题库 95×20 px，纸面高 1.9mm vs 5.29mm）。
// 边界（本文件同时锚定）：显式提升仍块化（用户意图优先）；裸行内 img 语义不变（0004-fix-4 #7）；
//   块级配图零变化；formula-image 语义豁免不变（既有 fix3/fix4 测试覆盖）。

import { describe, it, expect } from 'vitest';
import type { Paper, Question } from '../../src/shared/contracts/bank-types.js';
import { buildPaperHtml } from '../../src/docgen/render/buildPaperHtml.js';

const paper: Paper = {
  id: 'p-0041',
  title: '0041 行内公式图探针卷',
  config: {},
  createdAt: '2026-09-18T00:00:00Z',
  archived: false,
};

function makeQuestion(overrides: Partial<Question> = {}): Question {
  return {
    id: 'q-0041',
    subject: '物理',
    sourceType: 'network',
    sourceDetail: { site: 'zujuan' },
    // 真库形态：采集站点把行内公式图包进 .inline-figure，语义登记为 figure（ingest 只产 answer-image/figure）
    content:
      '<div class="question">传送带与长度<span class="inline-figure"><img class="q-figure" data-w="57" data-h="12" src="data-assets/capture/zujuan/f-1.svg"></span>的滑板衔接。</div>',
    images: [{ assetId: 'capture/zujuan/f-1.svg', type: 'figure', width: 57 }],
    createdAt: '2026-09-18T00:00:00Z',
    updatedAt: '2026-09-18T00:00:00Z',
    ...overrides,
  };
}

function bodyOf(html: string): string {
  return html.slice(html.indexOf('<body>'), html.indexOf('</body>'));
}

/** 取出全部 `.inline-figure` span 的内部 HTML（用于断言 span 内不含 figure-block） */
function inlineFigureInners(body: string): string[] {
  const out: string[] = [];
  const re = /<span class="inline-figure">([\s\S]*?)<\/span>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) out.push(m[1]);
  return out;
}

describe('0041：排版路径行内公式图留文本流（.inline-figure > img 契约恢复）', () => {
  it('config 路径：.inline-figure 内行内公式图直系保留、不插 figure-block', async () => {
    const q = makeQuestion();
    const html = await buildPaperHtml(paper, [q], {
      mode: 'student',
      assetsRoot: '/tmp/assets',
      layoutConfig: { version: 2 },
    });
    const body = bodyOf(html);

    // img 仍是 .inline-figure 的直系子（P5 规则 `.inline-figure > img` 的命中前提）
    expect(body).toMatch(/<span class="inline-figure"><img class="q-figure"[^>]*style="width: 57px;"/);
    // span 内不得出现块化包装（60% 收缩与 min-height 失配的根因）
    const inners = inlineFigureInners(body);
    expect(inners).toHaveLength(1);
    expect(inners[0]).not.toContain('figure-block');
    // 内联宽度样式保留（processFigures 行为不变）
    expect(inners[0]).toContain('style="width: 57px;"');
    // 产物内联的 paper.css 仍带 P5 规则（CSS 契约在，缺的只是被块化打空的命中）
    expect(html).toContain('.inline-figure > img {');
  });

  it('题级覆盖对行内公式图不生效：仍留文本流，且不合成重复的外来图块（存量 layout_json 自愈）', async () => {
    const q = makeQuestion();
    const body = bodyOf(
      await buildPaperHtml(paper, [q], {
        mode: 'student',
        assetsRoot: '/tmp/assets',
        layoutConfig: { version: 2 },
        questionLayouts: { [q.id]: { figures: [{ assetId: 'capture/zujuan/f-1.svg', orderIndex: 0, widthPercent: 100 }] } },
      })
    );
    expect(body).not.toContain('figure-block');
    const inners = inlineFigureInners(body);
    expect(inners).toHaveLength(1);
    expect(inners[0]).toMatch(/<img class="q-figure"[^>]*style="width: 57px;"/);
    // 关键防回归：覆盖条目被过滤后，不得走「覆盖含但 content 匹配不到 → 外来图题尾合成」路径（否则同图渲染两次）
    expect(body.match(/f-1\.svg/g) ?? []).toHaveLength(1);
  });

  it('混合题：块级图被覆盖提升（仍可调）与行内公式图固定（互不影响）', async () => {
    const q = makeQuestion({
      content:
        '<div class="question">长度<span class="inline-figure"><img class="q-figure" data-w="57" data-h="12" src="data-assets/capture/zujuan/f-1.svg"></span>如图<figure class="diagram" data-w="339" data-h="74"><img class="q-figure" src="data-assets/capture/zujuan/big.png"></figure>求值。</div>',
      images: [
        { assetId: 'capture/zujuan/f-1.svg', type: 'figure' },
        { assetId: 'capture/zujuan/big.png', type: 'figure' },
      ],
    });
    const body = bodyOf(
      await buildPaperHtml(paper, [q], {
        mode: 'student',
        assetsRoot: '/tmp/assets',
        layoutConfig: { version: 2 },
        questionLayouts: {
          [q.id]: { figures: [{ assetId: 'capture/zujuan/big.png', orderIndex: 0, widthPercent: 50 }] },
        },
      })
    );
    // 行内公式图：直系 + 不成块
    expect(inlineFigureInners(body)[0]).not.toContain('figure-block');
    // 块级图：被覆盖提升 → figure-block + 50% 宽
    expect(body).toContain('figure-block');
    expect(body).toMatch(/figure-block--center" style="width: 50%;/);
  });

  it('裸行内 img（无 .inline-figure 包裹）→ 仍参与块化（0004-fix-4 #7 零回归）', async () => {
    const q = makeQuestion({
      content: '<div class="question">题干<img src="data-assets/capture/zujuan/bare.png">文字</div>',
      images: [{ assetId: 'capture/zujuan/bare.png', type: 'figure' }],
    });
    const body = bodyOf(
      await buildPaperHtml(paper, [q], {
        mode: 'student',
        assetsRoot: '/tmp/assets',
        layoutConfig: { version: 2 },
      })
    );
    expect(body).toContain('<div class="figure-block figure-block--center"');
  });

  it('块级配图零变化：figure.diagram 仍走图块（width + 60% 封顶）', async () => {
    const q = makeQuestion({
      content: '<div class="question">如图<figure class="diagram" data-w="339" data-h="74"><img class="q-figure" src="data-assets/capture/zujuan/big.png"></figure>求值。</div>',
      images: [{ assetId: 'capture/zujuan/big.png', type: 'figure' }],
    });
    const body = bodyOf(
      await buildPaperHtml(paper, [q], {
        mode: 'student',
        assetsRoot: '/tmp/assets',
        layoutConfig: { version: 2 },
      })
    );
    expect(body).toContain('figure-block');
    expect(body).toMatch(/<figure[^>]*style="[^"]*width:\s*339px/);
    expect(body).toMatch(/<figure[^>]*style="[^"]*max-width:\s*60%/);
  });

  it('资产根改写不因留文本流而漏：src 仍重写为 file:// 绝对路径（防预览/PDF 裂图）', async () => {
    const q = makeQuestion();
    const body = bodyOf(
      await buildPaperHtml(paper, [q], {
        mode: 'student',
        assetsRoot: '/tmp/assets',
        layoutConfig: { version: 2 },
      })
    );
    expect(body).toContain('file:///tmp/assets/capture/zujuan/f-1.svg');
    expect(body).not.toContain('src="data-assets/capture/zujuan/f-1.svg"');
  });
});
