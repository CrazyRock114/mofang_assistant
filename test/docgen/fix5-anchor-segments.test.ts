// 0004-fix-5 P0-2/P0-3 探针：段边界锚点语义 + assetId 归一（裂图根因）+ 旧数据零变化。
// 覆盖：①锚点渲染（图落题干↔选项之间/题尾/同边界稳定序）②旧 orderIndex 槽位语义逐字节不变
// ③段边界标记（markers=true 才产，打印路径零标记）④assetId 前缀归一（覆盖/语义表/foreign 不重复）
// ⑤planQuestionFigures 段边界归属（homeBoundary/boundaryCount）。

import { describe, it, expect } from 'vitest';
import type { Paper, Question, QuestionFigureLayout } from '../../src/shared/contracts/bank-types.js';
import { buildPaperHtml } from '../../src/docgen/render/buildPaperHtml.js';
import {
  blockifyQuestionContent,
  buildImageTypeTable,
  buildRenderSegments,
  applyFigureOverrides,
  planQuestionFigures,
  normalizeAssetId,
  foreignFigureHtml,
  type FigureRenderSpec,
  type RenderSegment,
} from '../../src/docgen/render/figureBlocks.js';

const paper: Paper = {
  id: 'fix5-anchor',
  title: '锚点语义探针卷',
  config: {},
  createdAt: '2026-09-09T00:00:00Z',
  archived: false,
};

const layoutConfig = { version: 2 as const, pageMarginMm: { top: 20, right: 15, bottom: 20, left: 15 }, header: { style: 'simple' as const } };

function bodyOf(html: string): string {
  return html.slice(html.indexOf('<body>'), html.indexOf('</body>'));
}

function figureQuestion(content: string, images: Question['images'] = []): Question {
  return {
    id: 'q1',
    subject: '物理',
    sourceType: 'local',
    sourceDetail: { origin: 'probe' },
    content,
    images,
    createdAt: '2026-09-09T00:00:00Z',
    updatedAt: '2026-09-09T00:00:00Z',
  };
}

async function render(q: Question, figures?: QuestionFigureLayout[], segmentAnchors?: boolean): Promise<string> {
  return buildPaperHtml(paper, [q], {
    mode: 'student',
    assetsRoot: null,
    layoutConfig,
    ...(figures ? { questionLayouts: { [q.id]: { figures } } } : {}),
    ...(segmentAnchors ? { segmentAnchors: true } : {}),
  });
}

const STEM_FIG_OPTIONS =
  '<div class="question">题干文字一<figure data-w="300"><img src="data-assets/capture/a.png"></figure>' +
  '<div class="options"><div class="option">A. 甲</div></div></div>';

function figureAssetsOf(html: string): string[] {
  return [...bodyOf(html).matchAll(/class="figure-block[^"]*"[^>]*>[\s\S]*?src="([^"]+)"/g)].map((m) => m[1]);
}

describe('fix-5 P0-2 段边界锚点（引擎渲染面）', () => {
  it('anchorIndex=1（题干与图之间）→ 图块渲染在 options 之前且位于题干文本后', async () => {
    const html = await render(figureQuestion(STEM_FIG_OPTIONS), [{ assetId: 'capture/a.png', anchorIndex: 1 }]);
    const body = bodyOf(html);
    const figureAt = body.indexOf('figure-block');
    const optionsAt = body.indexOf('class="options"');
    const stemAt = body.indexOf('题干文字一');
    expect(figureAt).toBeGreaterThan(stemAt);
    expect(figureAt).toBeLessThan(optionsAt);
    expect(figureAssetsOf(html)).toHaveLength(1);
  });

  it('anchorIndex=题尾边界（=段数；fix-6 切分后为 4）→ 图块落在 options 之后（题尾独立行）', async () => {
    const html = await render(figureQuestion(STEM_FIG_OPTIONS), [{ assetId: 'capture/a.png', anchorIndex: 4 }]);
    const body = bodyOf(html);
    expect(body.indexOf('figure-block')).toBeGreaterThan(body.indexOf('class="options"'));
  });

  it('planQuestionFigures：boundaryCount=段数，homeBoundary=图块原段下标', () => {
    const plan = planQuestionFigures(STEM_FIG_OPTIONS, buildImageTypeTable([{ assetId: 'capture/a.png', type: 'figure' }]));
    // 段序列：text(题根+题干) / figure / text(options) / text(题根闭合) → 4 段，边界 0..4
    // （fix-6 P0-1：options 容器切分为独立段，边界加密；拼接输出不变）
    expect(plan.segments.map((s) => s.kind)).toEqual(['text', 'figure', 'text', 'text']);
    expect(plan.boundaryCount).toBe(4);
    expect(plan.homeBoundary.get(plan.figures[0])).toBe(1);
    expect(plan.foreignAssets).toEqual([]);
  });

  it('同边界多图按 specs 稳定序排列（orderKey/domIndex）', () => {
    const blocks = blockifyQuestionContent(
      't0<figure><img src="data-assets/capture/a.png"></figure>t1<figure><img src="data-assets/capture/b.png"></figure>t2',
      {}
    );
    const specs = applyFigureOverrides(blocks.figures, { mode: 'inline', align: 'center', widthPercent: null }, [
      { assetId: 'capture/a.png', anchorIndex: 1 },
      { assetId: 'capture/b.png', anchorIndex: 1 },
    ]);
    const rendered = buildRenderSegments(blocks.segments, specs);
    const assets = rendered
      .filter((s): s is { kind: 'figure'; spec: FigureRenderSpec } => s.kind === 'figure')
      .map((s) => s.spec.figure.assetId);
    expect(assets).toEqual(['capture/a.png', 'capture/b.png']);
  });

  it('显式锚图块离开原位后，未锚图块保持自身段位（不漂移）', () => {
    const blocks = blockifyQuestionContent(
      't0<figure><img src="data-assets/capture/a.png"></figure>t1<figure><img src="data-assets/capture/b.png"></figure>t2',
      {}
    );
    const specs = applyFigureOverrides(blocks.figures, { mode: 'inline', align: 'center', widthPercent: null }, [
      { assetId: 'capture/a.png', anchorIndex: 4 },
    ]);
    const rendered = buildRenderSegments(blocks.segments, specs);
    const seq = rendered.map((s) => (s.kind === 'figure' ? 'figure' : s.kind === 'text' ? 'text' : 'marker'));
    // 段序：text0 / figA(空槽) / text1 / figB(原位) / figA(锚 4) / text2
    expect(seq).toEqual(['text', 'text', 'figure', 'figure', 'text']);
    const assets = rendered
      .filter((s): s is { kind: 'figure'; spec: FigureRenderSpec } => s.kind === 'figure')
      .map((s) => s.spec.figure.assetId);
    expect(assets).toEqual(['capture/b.png', 'capture/a.png']);
  });

  it('旧 orderIndex 槽位语义零变化（无锚数据）', () => {
    const blocks = blockifyQuestionContent(
      't1<figure><img src="data-assets/capture/a.png"></figure>t2<figure><img src="data-assets/capture/b.png"></figure>t3',
      {}
    );
    const specs = applyFigureOverrides(blocks.figures, { mode: 'inline', align: 'center', widthPercent: null }, [
      { assetId: 'capture/a.png', orderIndex: 1 },
      { assetId: 'capture/b.png', orderIndex: 0 },
    ]);
    const rendered = buildRenderSegments(blocks.segments, specs);
    const assets = rendered
      .filter((s): s is { kind: 'figure'; spec: FigureRenderSpec } => s.kind === 'figure')
      .map((s) => s.spec.figure.assetId);
    expect(assets).toEqual(['capture/b.png', 'capture/a.png']);
  });
});

describe('fix-5 P0-2 段边界标记（.mf-seg）', () => {
  it('segmentAnchors=true → 每边界一个标记，数量=段数+1；缺省不产标记', async () => {
    const q = figureQuestion(STEM_FIG_OPTIONS);
    const withMarkers = await render(q, undefined, true);
    const without = await render(q);
    // fix-6 P0-1 探针演进：options 切分后段数 3→4，边界数=段数+1=5
    expect([...bodyOf(withMarkers).matchAll(/class="mf-seg"/g)]).toHaveLength(5);
    expect([...bodyOf(withMarkers).matchAll(/data-mf-seg="(\d+)"/g)].map((m) => m[1])).toEqual(['0', '1', '2', '3', '4']);
    expect(bodyOf(without)).not.toContain('mf-seg');
  });

  it('标记为绝对定位零尺寸元素（不产行盒/不挡点击）', async () => {
    const html = await render(figureQuestion(STEM_FIG_OPTIONS), undefined, true);
    expect(html).toContain('.mf-seg { position: absolute; width: 1px; height: 0; overflow: hidden; pointer-events: none; }');
  });

  it('buildRenderSegments markers=true → 每边界前插 marker 段（顺序：marker→图块→该段）', () => {
    const blocks = blockifyQuestionContent(
      't0<figure><img src="data-assets/capture/a.png"></figure>t1',
      {}
    );
    const specs = applyFigureOverrides(blocks.figures, { mode: 'inline', align: 'center', widthPercent: null });
    const rendered: RenderSegment[] = buildRenderSegments(blocks.segments, specs, { markers: true });
    expect(rendered.map((s) => (s.kind === 'marker' ? `m${s.boundary}` : s.kind))).toEqual(['m0', 'text', 'm1', 'figure', 'm2', 'text', 'm3']);
  });
});

describe('fix-5 P0-3 assetId 归一（裂图根因）', () => {
  it('normalizeAssetId：去前缀（含重复前缀脏值）', () => {
    expect(normalizeAssetId('data-assets/capture/a.png')).toBe('capture/a.png');
    expect(normalizeAssetId('data-assets/data-assets/capture/a.png')).toBe('capture/a.png');
    expect(normalizeAssetId('capture/a.png')).toBe('capture/a.png');
    expect(normalizeAssetId(null)).toBeNull();
  });

  it('foreignFigureHtml：前缀 assetId 不再双前缀（修复裂图 src）', () => {
    expect(foreignFigureHtml('data-assets/capture/a.png')).toContain('src="data-assets/capture/a.png"');
    expect(foreignFigureHtml('data-assets/capture/a.png')).not.toContain('data-assets/data-assets/');
  });

  it('覆盖条目带前缀（真机形态）→ 命中原图，不合成外来图（单图无裂）', async () => {
    const html = await render(figureQuestion(STEM_FIG_OPTIONS), [
      { assetId: 'data-assets/capture/a.png', orderIndex: 0, widthPercent: 94.57 },
    ]);
    expect([...bodyOf(html).matchAll(/class="figure-block/g)]).toHaveLength(1);
    expect(bodyOf(html)).not.toContain('mf-foreign');
    expect([...bodyOf(html).matchAll(/<img/g)]).toHaveLength(1);
  });

  it('两种 assetId 形态并存的存量覆盖（真机 layout_json 实态）→ 仍单图无 foreign', async () => {
    const html = await render(figureQuestion(STEM_FIG_OPTIONS), [
      { assetId: 'data-assets/capture/a.png', orderIndex: 0, widthPercent: 94.57 },
      { assetId: 'capture/a.png', orderIndex: 1, mode: 'inline', align: 'center' },
    ]);
    expect([...bodyOf(html).matchAll(/class="figure-block/g)]).toHaveLength(1);
    expect(bodyOf(html)).not.toContain('mf-foreign');
  });

  it('images[].assetId 带前缀 → 语义表命中，公式图留文本流（不误块化）', async () => {
    const q = figureQuestion(
      '<div class="question">公式 <img src="data-assets/capture/formula.svg"> 后文</div>',
      [{ assetId: 'data-assets/capture/formula.svg', type: 'formula-image' }]
    );
    const html = await render(q);
    expect(bodyOf(html)).not.toContain('figure-block');
    expect(bodyOf(html)).toContain('capture/formula.svg');
  });

  it('外来图（content 无引用）仍正常合成（归一不误伤外来图通道）', async () => {
    const html = await render(figureQuestion(STEM_FIG_OPTIONS), [
      { assetId: 'data-assets/logos/x.png', orderIndex: 0 },
    ]);
    const body = bodyOf(html);
    expect(body).toContain('mf-foreign');
    expect(body).toContain('src="data-assets/logos/x.png"');
    expect([...body.matchAll(/class="figure-block/g)]).toHaveLength(2);
  });
});
