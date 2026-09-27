// 0004-fix-3 渲染探针（P0-1 覆盖优先参与/外来图合成 + P0-3 打印分流 CSS + P1-2 题级作答区）。
// 依据 0004 fix-3 口径 §二验收：
// - 裸 img（无语义）无覆盖=文本流不回归；覆盖提升=块化可调；外来图=题尾合成渲染可排序；
// - 提升资格=图类 asset（公式/答案/解析语义不提升）；外来图缺省宽档=60%；
// - 题级作答区 题级>卷级、none=不插、缺省逐项回落卷级；CSS 屏显/打印分流规则。

import { describe, it, expect } from 'vitest';
import type { Paper, Question, PaperLayoutConfig } from '../../src/shared/contracts/bank-types.js';
import { buildPaperHtml } from '../../src/docgen/render/buildPaperHtml.js';
import { buildLayoutCss, resolveLayout } from '../../src/docgen/render/layout.js';
import {
  blockifyQuestionContent,
  isPromotableAsset,
  foreignFigureHtml,
} from '../../src/docgen/render/figureBlocks.js';
import { hasPerQuestionAnswerSpace } from '../../src/docgen/render/buildPaperHtml.core.js';

/** 截取 <body>…（CSS 全在 head，元素断言用本作用域） */
function bodyOf(html: string): string {
  const start = html.indexOf('<body>');
  return start >= 0 ? html.slice(start) : html;
}

function makePaper(config: Paper['config'] = {}): Paper {
  return {
    id: 'fix3-paper',
    title: 'fix-3 探针卷',
    config,
    createdAt: '2026-09-09T00:00:00Z',
    archived: false,
  };
}

/** 裸图题：content 内含行内裸图（无 data-w、无 images 语义）+ 块级裸 figure——均无 figure 语义标注 */
function makeBareFigureQuestion(): Question {
  return {
    id: 'bare-fig-q',
    subject: '物理',
    sourceType: 'network',
    sourceDetail: { site: 'xueke' },
    content:
      '<div class="question">题干文字。' +
      '<p><img src="data-assets/capture/bare-inline.png"></p>' +
      '<figure><img src="data-assets/capture/bare-block.png"></figure>' +
      '尾段文字。</div>',
    images: [],
    createdAt: '2026-09-09T00:00:00Z',
    updatedAt: '2026-09-09T00:00:00Z',
  };
}

describe('0004-fix-3 P0-1 — 覆盖优先参与（目检 #2a）', () => {
  it('裸行内 img（无语义）无覆盖 → 默认参与块化（fix-4 #7 演进：目检 #7 图默认全可调）', async () => {
    const body = bodyOf(
      await buildPaperHtml(makePaper(), [makeBareFigureQuestion()], {
        mode: 'student',
        assetsRoot: '/tmp/assets',
        layoutConfig: { version: 2 },
      })
    );
    // fix-4 #7：非公式/答案/解析语义的行内裸图默认参与块化（fix-3「需覆盖才提升」语义放宽）
    expect(body).not.toContain('<p><img src="file:///tmp/assets/capture/bare-inline.png"></p>');
    expect(body).toContain('file:///tmp/assets/capture/bare-inline.png');
    // 块级裸 figure（fix-2 既有语义）+ 行内裸 img（fix-4 默认参与）= 两个图块
    expect((body.match(/class="figure-block/g) ?? [])).toHaveLength(2);
  });

  it('块级裸 figure 被覆盖 → 提升块化（figure-block 出现，原 DOM 位随文流）', async () => {
    const body = bodyOf(
      await buildPaperHtml(makePaper(), [makeBareFigureQuestion()], {
        mode: 'student',
        assetsRoot: '/tmp/assets',
        layoutConfig: { version: 2 },
        questionLayouts: {
          'bare-fig-q': { figures: [{ assetId: 'capture/bare-block.png', orderIndex: 0 }] },
        },
      })
    );
    expect(body).toContain('figure-block');
    const posT1 = body.indexOf('题干文字。');
    const posBlock = body.indexOf('figure-block');
    const posTail = body.indexOf('尾段文字。');
    expect(posBlock).toBeGreaterThan(posT1); // 原位（第一段后）
    expect(posTail).toBeGreaterThan(posBlock);
    // fix-4 #7：行内裸图默认参与（本条覆盖只命中块级图；行内图按默认段序块化）
    expect(body).not.toContain('<p><img src="file:///tmp/assets/capture/bare-inline.png"></p>');
    expect(body).toContain('file:///tmp/assets/capture/bare-inline.png');
  });

  it('行内裸 img 被覆盖 → 提升块化（data-w 缺失也参与；无像素宽走 60% 封顶）', async () => {
    const html = await buildPaperHtml(makePaper(), [makeBareFigureQuestion()], {
      mode: 'student',
      assetsRoot: '/tmp/assets',
      layoutConfig: { version: 2 },
      questionLayouts: {
        'bare-fig-q': { figures: [{ assetId: 'capture/bare-inline.png', orderIndex: 99 }] },
      },
    });
    const body = bodyOf(html);
    expect(body).toContain('figure-block');
    expect(body).toContain('file:///tmp/assets/capture/bare-inline.png');
    // 裸 img 无像素宽信息 → 默认观感档封顶（60%）
    expect(html).toContain('.figure-block > img { max-width: 60%;');
  });

  it('提升资格：公式/答案/解析语义图覆盖不提升（isPromotableAsset=false，留文本流）', () => {
    expect(isPromotableAsset('capture/f.svg', { 'capture/f.svg': 'formula-image' })).toBe(false);
    expect(isPromotableAsset('capture/a.png', { 'capture/a.png': 'answer-image' })).toBe(false);
    expect(isPromotableAsset('capture/n.png', { 'capture/n.png': 'analysis-image' })).toBe(false);
    expect(isPromotableAsset('capture/g.png', { 'capture/g.png': 'figure' })).toBe(true);
    expect(isPromotableAsset('capture/bare.png', {})).toBe(true); // 裸图可提升
  });

  it('引擎兜底：formula-image 语义 + 覆盖条目 → 仍留文本流（不块化）', async () => {
    const q: Question = {
      ...makeBareFigureQuestion(),
      id: 'formula-q',
      content:
        '<div class="question">公式图题。' +
        '<p><span class="inline-figure"><img data-w="42" src="data-assets/capture/f.svg"></span></p>' +
        '</div>',
      images: [{ assetId: 'capture/f.svg', type: 'formula-image', width: 42 }],
    };
    const body = bodyOf(
      await buildPaperHtml(makePaper(), [q], {
        mode: 'student',
        layoutConfig: { version: 2 },
        questionLayouts: {
          'formula-q': { figures: [{ assetId: 'capture/f.svg', orderIndex: 0 }] },
        },
      })
    );
    expect(body).not.toContain('figure-block');
    expect(body).toContain('inline-figure');
  });

  it('外来图（覆盖含但 content 无）→ 合成渲染：mf-foreign figure + 60% 缺省档 + src 重写；无 orderIndex=题尾默认位', async () => {
    const body = bodyOf(
      await buildPaperHtml(makePaper(), [makeBareFigureQuestion()], {
        mode: 'student',
        assetsRoot: '/tmp/assets',
        layoutConfig: { version: 2 },
        questionLayouts: {
          'bare-fig-q': { figures: [{ assetId: 'logos/inserted.png' }] },
        },
      })
    );
    expect(body).toContain('figure-block');
    // 0058（选项① 授权，用户 2026-09-22「按选项1来」）：覆盖档下无内联宽的图补「内层拉满」——
    // 外来合成图此前落库后仍被 60% 默认档双重封顶（≈0.36 块宽），与运行时拖中宽度不一致（手感回退）。
    expect(body).toContain('<figure class="mf-foreign" style="width: 100%; max-width: 100%;"><img src="file:///tmp/assets/logos/inserted.png" style="width: 100%; max-width: 100%;"></figure>');
    // 缺省宽档 60%（同 S4 观感档；图宽 = 块宽 = 60% 版心）
    expect(body).toMatch(/figure-block--center" style="width: 60%;/);
    // 题尾位（无 orderIndex → domIndex 最大排最后）：尾段文字之后
    const posTail = body.indexOf('尾段文字。');
    const posForeign = body.indexOf('mf-foreign');
    expect(posForeign).toBeGreaterThan(posTail);
  });

  it('外来图 orderIndex=0 → 参与槽位排序（排在 content 已覆盖图之前）', async () => {
    const body = bodyOf(
      await buildPaperHtml(makePaper(), [makeBareFigureQuestion()], {
        mode: 'student',
        assetsRoot: '/tmp/assets',
        layoutConfig: { version: 2 },
        questionLayouts: {
          'bare-fig-q': {
            figures: [
              { assetId: 'capture/bare-block.png', orderIndex: 1 },
              { assetId: 'logos/inserted.png', orderIndex: 0 },
            ],
          },
        },
      })
    );
    const posForeign = body.indexOf('mf-foreign');
    const posBlock = body.indexOf('file:///tmp/assets/capture/bare-block.png');
    expect(posForeign).toBeGreaterThan(0);
    expect(posBlock).toBeGreaterThan(posForeign); // 外来图占槽位 1（原 bare-block 位之前）
  });

  it('外来图题级 widthPercent 覆盖优先于 60% 缺省档', async () => {
    const body = bodyOf(
      await buildPaperHtml(makePaper(), [makeBareFigureQuestion()], {
        mode: 'student',
        layoutConfig: { version: 2 },
        questionLayouts: {
          'bare-fig-q': { figures: [{ assetId: 'logos/inserted.png', widthPercent: 35 }] },
        },
      })
    );
    expect(body).toContain('style="width: 35%; margin-left: auto; margin-right: auto;"');
  });

  it('foreignFigureHtml：assetId HTML 转义（防注入）+ 块化纯函数含图类参与集', () => {
    expect(foreignFigureHtml('logos/a&b.png')).toContain('logos/a&amp;b.png');
    expect(foreignFigureHtml('logos/<x>.png')).toContain('logos/&lt;x&gt;.png');
    // 参与集驱动块化：extraParticipate 命中=提取为 figure 段
    const blocks = blockifyQuestionContent(
      '文<p><img src="data-assets/capture/bare.png"></p>尾',
      {},
      new Set(['capture/bare.png'])
    );
    expect(blocks.figures.map((f) => f.assetId)).toEqual(['capture/bare.png']);
  });
});

describe('0004-fix-3 P0-3/P1-1 — 打印 CSS 分流（Logo 每页/屏显边距模拟）', () => {
  const LOGO_CONFIG: PaperLayoutConfig = {
    version: 2,
    logos: [{ assetId: 'logos/school.png', xRatio: 0.06, yRatio: 0.05, widthRatio: 0.12 }],
  };

  it('有 Logo：屏显/打印同一 absolute（0007 P3：打印 fixed 退役，逐页重复改由页化克隆承担）', () => {
    const css = buildLayoutCss(resolveLayout(LOGO_CONFIG));
    expect(css).toContain('.paper-logo { position: absolute; }');
    // 0007 P3：@media print position:fixed 方案退役——页化运行时装箱阶段把 Logo 克隆进每页
    // sheet（坐标基准统一=纸面），两态落点差消除；config 路径不再输出 fixed 规则
    expect(css).not.toContain('position: fixed');
  });

  it('屏显页边距模拟（.paper padding=config 边距，border-box）+ 打印归零防双倍', () => {
    const css = buildLayoutCss(resolveLayout({
      version: 2,
      pageMarginMm: { top: 18, right: 12, bottom: 16, left: 14 },
    }));
    expect(css).toContain('@media screen { .paper { box-sizing: border-box; padding: 18mm 12mm 16mm 14mm; } }');
    expect(css).toContain('@media print { .paper { padding: 0; } }');
  });

  it('无 config（基线）不注入屏显边距/打印分流规则（基线产物零污染）', async () => {
    const html = await buildPaperHtml(makePaper(), [makeBareFigureQuestion()], { mode: 'student' });
    expect(html).not.toContain('@media screen');
    expect(html).not.toContain('paper-logo');
    // 基线 paper.css 不含 position: fixed 规则
    expect(html).not.toContain('position: fixed');
  });

  it('config 驱动产物内联分流规则（预览/导出同管线）', async () => {
    const html = await buildPaperHtml(makePaper(), [], {
      mode: 'student',
      layoutConfig: LOGO_CONFIG,
    });
    // 0007 P3：Logo 打印 fixed 退役（逐页内容化由页化克隆承担；fixed 会使克隆叠影）
    expect(html).not.toContain('.paper-logo { position: fixed; }');
    expect(html).toContain('@media print { .paper { padding: 0; } }');
  });

  it('公式防跨页：paper.css 结构层含 KaTeX 避免规则（基线+config 双路径生效）', async () => {
    const html = await buildPaperHtml(makePaper(), [], { mode: 'student' });
    expect(html).toMatch(/\.katex-display\s*\{[^}]*break-inside:\s*avoid/);
    expect(html).toMatch(/\.katex\s*\{[^}]*break-inside:\s*avoid/);
  });

  it('题目允许跨页：question-item 不再整题避免分页（首页空白根因②收窄）', async () => {
    const html = await buildPaperHtml(makePaper(), [], { mode: 'student' });
    // paper.css 的 .question-item 规则块内无 break-inside/page-break-inside 声明
    const block = html.match(/\.question-item\s*\{[^}]*\}/);
    expect(block).not.toBeNull();
    expect(block![0]).not.toContain('break-inside');
    expect(block![0]).not.toContain('page-break-inside');
  });
});

describe('0004-fix-3 P1-2 — 题级作答区（目检 #5）', () => {
  const TWO_Q = [makeBareFigureQuestion(), { ...makeBareFigureQuestion(), id: 'bare-fig-q2' }];

  it('卷级关闭 + 题级覆盖 → 该题插入、其余题不插', async () => {
    const body = bodyOf(
      await buildPaperHtml(makePaper(), TWO_Q, {
        mode: 'student',
        layoutConfig: { version: 2 },
        questionLayouts: {
          'bare-fig-q': { answerSpace: { style: 'lines', heightMm: 30 } },
        },
      })
    );
    expect((body.match(/class="answer-space answer-space--lines"/g) ?? []).length).toBe(1);
    expect(body).toContain('height: 30mm');
  });

  it('题级 none → 卷级开启下该题不插，其余题保留卷级作答区', async () => {
    const body = bodyOf(
      await buildPaperHtml(makePaper(), TWO_Q, {
        mode: 'student',
        layoutConfig: { version: 2, answerSpace: { enabled: true, style: 'blank', heightMm: 20 } },
        questionLayouts: {
          'bare-fig-q': { answerSpace: { style: 'none' } },
        },
      })
    );
    expect((body.match(/class="answer-space /g) ?? []).length).toBe(1); // 仅第二题（卷级）
    expect(body).toContain('height: 20mm');
  });

  it('题级缺省逐项回落卷级：仅覆盖 heightMm → style 用卷级 lines', async () => {
    const body = bodyOf(
      await buildPaperHtml(makePaper(), [makeBareFigureQuestion()], {
        mode: 'student',
        layoutConfig: { version: 2, answerSpace: { enabled: true, style: 'lines', heightMm: 20 } },
        questionLayouts: {
          'bare-fig-q': { answerSpace: { heightMm: 44 } },
        },
      })
    );
    expect(body).toContain('answer-space--lines');
    expect(body).toContain('height: 44mm');
  });

  it('卷级关闭 + 题级覆盖（style 缺省）→ style 回落卷级默认 blank', async () => {
    const body = bodyOf(
      await buildPaperHtml(makePaper(), [makeBareFigureQuestion()], {
        mode: 'student',
        layoutConfig: { version: 2 },
        questionLayouts: {
          'bare-fig-q': { answerSpace: { heightMm: 25 } },
        },
      })
    );
    expect(body).toContain('answer-space--blank');
    expect(body).toContain('height: 25mm');
  });

  it('作答区插入位=题尾（解析/答案字段后）', async () => {
    const q: Question = {
      ...makeBareFigureQuestion(),
      answer: '<p>参考答案</p>',
      analysis: '<p>解析内容</p>',
    };
    const body = bodyOf(
      await buildPaperHtml(makePaper(), [q], {
        mode: 'teacher',
        layoutConfig: { version: 2 },
        questionLayouts: {
          'bare-fig-q': { answerSpace: { style: 'blank', heightMm: 12 } },
        },
      })
    );
    const posAnalysis = body.indexOf('解析内容');
    const posSpace = body.indexOf('answer-space');
    expect(posAnalysis).toBeGreaterThan(0);
    expect(posSpace).toBeGreaterThan(posAnalysis);
  });

  it('卷级关闭且无题级覆盖 → 无作答区规则；有题级覆盖 → CSS 规则补注入（hasPerQuestionAnswerSpace）', async () => {
    const none = await buildPaperHtml(makePaper(), [makeBareFigureQuestion()], {
      mode: 'student',
      layoutConfig: { version: 2 },
    });
    expect(none).not.toContain('.answer-space');

    const perQ = await buildPaperHtml(makePaper(), [makeBareFigureQuestion()], {
      mode: 'student',
      layoutConfig: { version: 2 },
      questionLayouts: {
        'bare-fig-q': { answerSpace: { style: 'lines', heightMm: 30 } },
      },
    });
    expect(perQ).toContain('.answer-space { break-inside: avoid; }');
    expect(perQ).toContain('.answer-space--lines');

    expect(hasPerQuestionAnswerSpace({ a: { answerSpace: { style: 'lines' } } })).toBe(true);
    expect(hasPerQuestionAnswerSpace({ a: { figures: [] } })).toBe(false);
    expect(hasPerQuestionAnswerSpace(undefined)).toBe(false);
  });
});
