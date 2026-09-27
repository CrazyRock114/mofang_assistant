// 0004-fix-6 探针：①P0-1 options 独立段切分（边界加密、拼接输出不变、落锚端到端、题首孤图选项居尾）
// ②P0-2 图块缩放固定宽剥离（widthPercent 覆盖时内层 figure/img 随块宽；无覆盖历史输出不变）
// ③P1-1 文本块对齐渲染（显式 align 类 / 缺省无类零漂移）④预览协议文本块消息收窄。

import { describe, it, expect } from 'vitest';
import type { Paper, Question, QuestionFigureLayout, PaperTextBlock } from '../../src/shared/contracts/bank-types.js';
import { buildPaperHtml } from '../../src/docgen/render/buildPaperHtml.js';
import { renderTextBlockHtml } from '../../src/docgen/render/buildPaperHtml.core.js';
import {
  planQuestionFigures,
  splitOptionsSegments,
  isOptionsSegment,
  buildImageTypeTable,
  applyFigureOverrides,
  buildRenderSegments,
  renderFigureBlock,
  type ContentSegment,
} from '../../src/docgen/render/figureBlocks.js';
import { parsePreviewMessage } from '../../src/app/pages/preview-frame-protocol.js';

const paper: Paper = {
  id: 'fix6-probe',
  title: 'fix-6 探针卷',
  config: {},
  createdAt: '2026-09-09T00:00:00Z',
  archived: false,
};

const layoutConfig = { version: 2 as const, pageMarginMm: { top: 20, right: 15, bottom: 20, left: 15 }, header: { style: 'simple' as const } };

function makeQuestion(id: string, content: string, images: Question['images'] = []): Question {
  return {
    id,
    subject: '物理',
    sourceType: 'local',
    sourceDetail: { origin: 'probe' },
    content,
    images,
    createdAt: '2026-09-09T00:00:00Z',
    updatedAt: '2026-09-09T00:00:00Z',
  };
}

function bodyOf(html: string): string {
  return html.slice(html.indexOf('<body>'), html.indexOf('</body>'));
}

function concatTextHtml(segments: ContentSegment[]): string {
  return segments.map((s) => (s.kind === 'text' ? s.html : '')).join('');
}

// 用户目检五 #1 缺口题形：题干与选项黏在同一 text 段（纯文本选项无图断开）
const STEM_OPTIONS_NO_FIG =
  '<div class="question">题干文字：一物体做自由落体运动，求下落高度。' +
  '<div class="options"><div class="option">A. 1 m</div><div class="option">B. 2 m</div></div></div>';

describe('fix-6 P0-1 options 独立段切分', () => {
  it('含 options 的 text 段切为 [前, options, 后]；拼接输出逐字节一致', () => {
    const segments = splitOptionsSegments([{ kind: 'text', html: STEM_OPTIONS_NO_FIG }]);
    // [题根开标签+题干, options 容器, 题根闭合]——after 段为纯结构闭合标签
    expect(segments.length).toBe(3);
    expect(isOptionsSegment(segments[1])).toBe(true);
    // 拼接复原 = 原文（关 markers 渲染零差异的等价断言）
    expect(concatTextHtml(segments)).toBe(STEM_OPTIONS_NO_FIG);
  });

  it('options 内嵌套 div 平衡扫描完整切出；无闭合脏 HTML 不切分（保持原段）', () => {
    const nested = '<div class="question">题干<div class="options"><div class="option">A <b>x</b></div><div class="option">B</div></div></div>';
    const segments = splitOptionsSegments([{ kind: 'text', html: nested }]);
    expect(segments.length).toBe(3);
    expect(isOptionsSegment(segments[1])).toBe(true);
    expect(concatTextHtml(segments)).toBe(nested);

    const broken = '<div class="question">题干<div class="options"><div class="option">A</div>';
    const kept = splitOptionsSegments([{ kind: 'text', html: broken }]);
    expect(kept.length).toBe(1);
    expect(isOptionsSegment(kept[0])).toBe(false);
  });

  it('无图题 marker 边界加密：段数 1→3，markers 2→4（options 前后边界出现）', async () => {
    const q = makeQuestion('q1', STEM_OPTIONS_NO_FIG);
    const body = bodyOf(await buildPaperHtml(paper, [q], { mode: 'student', assetsRoot: null, layoutConfig, segmentAnchors: true }));
    const count = (body.match(/class="mf-seg"/g) ?? []).length;
    expect(count).toBe(4); // 段数 3（题干/options/题根闭合）→ 边界 0..3；切分前为 2
  });

  it('落锚端到端：覆盖图 anchorIndex=options 段下标 → 重建后图在选项前', async () => {
    // 段序列 = [text(题干), text(options)]，边界 1 = options 前
    const figures: QuestionFigureLayout[] = [{ assetId: 'capture/a.png', anchorIndex: 1, orderIndex: 0 }];
    const q = makeQuestion('q1', STEM_OPTIONS_NO_FIG, [{ assetId: 'capture/a.png', type: 'figure' }]);
    const body = bodyOf(await buildPaperHtml(paper, [q], {
      mode: 'student', assetsRoot: null, layoutConfig,
      questionLayouts: { q1: { figures } },
    }));
    const figAt = body.indexOf('figure-block');
    const optAt = body.indexOf('<div class="options"');
    expect(figAt).toBeGreaterThan(-1);
    expect(optAt).toBeGreaterThan(figAt); // 图在选项前（fix-5 时该题形只能落题首/题尾）
  });

  it('题首孤图 + 切分：图仍插在选项之前（选项居尾语义保持）', () => {
    const content = '<div class="question"><figure data-w="300"><img src="data-assets/capture/a.png"></figure>题干文字在图后。<div class="options"><div class="option">A. 甲</div></div></div>';
    const plan = planQuestionFigures(content, buildImageTypeTable([{ assetId: 'capture/a.png', type: 'figure' }]));
    // relocate 后段序 = [text(题干), figure, text(options)]：图在题干后、options 独立段前
    const optsSegIdx = plan.segments.findIndex((s) => isOptionsSegment(s));
    const figSegIdx = plan.segments.findIndex((s) => s.kind === 'figure');
    expect(optsSegIdx).toBeGreaterThan(-1);
    expect(figSegIdx).toBe(optsSegIdx - 1);
    expect(plan.segments[optsSegIdx - 2] && plan.segments[optsSegIdx - 2].kind === 'text').toBe(true);
  });
});

describe('fix-6 P0-2 图块缩放固定宽剥离', () => {
  const spec = (html: string, widthPercent: number | null) => ({
    figure: { html, assetId: 'capture/a.png' },
    align: 'center' as const,
    sideBySide: false,
    widthPercent,
    orderKey: 0,
    domIndex: 0,
    anchorIndex: null,
  });

  it('独立 img 固定像素宽 → width:100%（随块宽缩放，真机「部分图不可调」根因）', () => {
    const html = renderFigureBlock(spec('<img class="q-figure" data-w="144" style="width: 144px;" src="data-assets/capture/a.png">', 50));
    expect(html).toContain('width: 100%');
    expect(html).not.toContain('width: 144px');
    expect(html).toContain('width: 50%');
  });

  it('figure 层像素宽+60% 封顶 → 100%（既有语义）；widthPercent=null 不剥（历史输出不变）', () => {
    const withOverride = renderFigureBlock(spec('<figure data-w="310" style="width: 310px; max-width: 60%; break-inside: avoid;"><img src="data-assets/capture/a.png"></figure>', 94.57));
    expect(withOverride).toContain('width: 100%; max-width: 100%;');

    const untouched = renderFigureBlock(spec('<img class="q-figure" data-w="144" style="width: 144px;" src="data-assets/capture/a.png">', null));
    expect(untouched).toContain('width: 144px'); // 无覆盖：默认观感档保持，打印/PDF 零改动
    expect(untouched).not.toContain('figure-block--center style'); // 无 width style
  });
});

describe('fix-6 P1-1 文本块对齐渲染', () => {
  const block = (align?: PaperTextBlock['align']): PaperTextBlock => ({
    id: 'text:t1',
    text: '一、单项选择题',
    style: 'section',
    ...(align ? { align } : {}),
  });

  it('显式 align 输出对齐类（左/中/右）', () => {
    expect(renderTextBlockHtml(block('left'))).toContain('mf-text-item--section mf-text-item--align-left');
    expect(renderTextBlockHtml(block('center'))).toContain('mf-text-item--align-center');
    expect(renderTextBlockHtml(block('right'))).toContain('mf-text-item--align-right');
  });

  it('缺省 align 无对齐类（CSS 基线观感，存量零漂移）；端到端渲染生效', async () => {
    expect(renderTextBlockHtml(block())).not.toContain('mf-text-item--align-');
    expect(renderTextBlockHtml(block())).toContain('mf-text-item--section');
    const q = makeQuestion('text:t1', '占位');
    const body = bodyOf(await buildPaperHtml(paper, [q], {
      mode: 'student', layoutConfig,
      textBlocks: { 'text:t1': block('right') },
    }));
    expect(body).toContain('mf-text-item--align-right');
  });
});

describe('fix-6 P1-1 预览协议文本块消息收窄', () => {
  it('mf-text-align / mf-text-edit / mf-text-remove 逐型放行', () => {
    expect(parsePreviewMessage({ t: 'mf-text-align', questionId: 'text:x', align: 'center' })).toEqual({ t: 'mf-text-align', questionId: 'text:x', align: 'center' });
    expect(parsePreviewMessage({ t: 'mf-text-edit', questionId: 'text:x' })).toEqual({ t: 'mf-text-edit', questionId: 'text:x' });
    expect(parsePreviewMessage({ t: 'mf-text-remove', questionId: 'text:x' })).toEqual({ t: 'mf-text-remove', questionId: 'text:x' });
  });

  it('坏结构一律 null（非法 align / 非字符串 id / 缺字段）', () => {
    expect(parsePreviewMessage({ t: 'mf-text-align', questionId: 'text:x', align: 'up' })).toBeNull();
    expect(parsePreviewMessage({ t: 'mf-text-align', questionId: 3, align: 'left' })).toBeNull();
    expect(parsePreviewMessage({ t: 'mf-text-edit' })).toBeNull();
    expect(parsePreviewMessage({ t: 'mf-text-remove', questionId: null })).toBeNull();
  });
});
