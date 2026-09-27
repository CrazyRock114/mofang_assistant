// 0035 目检修复批（用户真实试卷复现）——RED 先行：
//   F2 行内小图（.inline-figure 包裹，采集符号图）在 DOCX 计划里**保持行内**，
//      不再被块化成独立居中图块（块化会把选项拆成「文字/图/文字」并把相邻选项黏成一段）；
//   F3 清单外表格标签降级时**保留行/单元格边界**（行独立成段、单元格间留分隔），
//      不再把整张表的选项黏成一行（真题：验证动量守恒的 A/B/C/D 选项表）。
// 背景证据（真实库 + 真管线，见 0035 交付留痕在案）：
//   题 e0d1aaab：选项 B/C 含 <span class="inline-figure"><img src="...svg"></span>，
//   块化后 Word 出现「B．…范围为」/「[图]」/「mg~」/「[图]」/「mgC．…」——选项被拆且跨选项黏连。

import { describe, it, expect } from 'vitest';
import type { Paper, Question } from '../../src/shared/contracts/bank-types.js';
import { buildDocxPlan } from '../../src/docgen/export/docx/plan.js';
import { parseContentSubset, type InlineItem } from '../../src/docgen/export/docx/content-subset.js';

function makeQuestion(over: Partial<Question> = {}): Question {
  return {
    id: 'q1',
    subject: '物理',
    sourceType: 'local',
    sourceDetail: {},
    content: '<div class="question"><p>题干</p></div>',
    images: [],
    createdAt: '2026-09-17T00:00:00Z',
    updatedAt: '2026-09-17T00:00:00Z',
    ...over,
  };
}

function makePaper(over: Partial<Paper> = {}): Paper {
  return { id: 'p1', title: '修复批计划卷', config: {}, createdAt: '2026-09-17T00:00:00Z', archived: false, ...over };
}

const textOf = (items: InlineItem[]): string => items.filter((i) => i.kind === 'text').map((i) => i.value).join('');
const kindOf = (items: InlineItem[]): string[] => items.map((i) => i.kind);

/** 采集站真实形态：选项内含 .inline-figure 包裹的小符号图（SVG），另有块级 figure 大图 */
const OPTION_WITH_INLINE_FIGURE =
  '<div class="question">则下列说法正确的是（　　）<p>'
  + '<figure class="diagram" data-w="860" data-h="840"><img src="data-assets/capture/zujuan/1.png"></figure>'
  + '</p><div class="options">'
  + '<span class="option">A．范围为0~<i>mg</i></span>'
  + '<span class="option">B．范围为<span class="inline-figure">'
  + '<img class="q-figure" data-w="22" data-h="39" src="data-assets/capture/zujuan/2.svg">'
  + '</span><i>mg</i>~<span class="inline-figure">'
  + '<img class="q-figure" data-w="30" data-h="39" src="data-assets/capture/zujuan/3.svg">'
  + '</span><i>mg</i></span>'
  + '</div></div>';

const IMAGES = [
  { assetId: 'data-assets/capture/zujuan/1.png', type: 'figure' as const },
  { assetId: 'data-assets/capture/zujuan/2.svg', type: 'figure' as const },
  { assetId: 'data-assets/capture/zujuan/3.svg', type: 'figure' as const },
];

describe('0035 修复批 F2：行内小图不再被块化（选项保持完整）', () => {
  it('.inline-figure 内的小图留行内：选项不拆段、不产生独立图块', () => {
    const q = makeQuestion({ content: OPTION_WITH_INLINE_FIGURE, images: IMAGES });
    const plan = buildDocxPlan(makePaper(), [q], { mode: 'student' });
    const blocks = plan.questions[0].blocks;

    // 只有块级 figure（1.png）成为图块；两张 .inline-figure 小图不是图块
    const figures = blocks.filter((b) => b.kind === 'figure');
    expect(figures).toHaveLength(1);

    // 选项块完整：4 个选项里 B 选项含 2 个行内图项，文字连续（不被切碎）
    const options = blocks.find((b) => b.kind === 'options');
    expect(options).toBeDefined();
    if (options?.kind !== 'options') throw new Error('无选项块');
    expect(options.options).toHaveLength(2);
    const optionB = options.options[1];
    // 2 个行内图都在该选项内（未被拆出去成块）；文字连续（不因拆段而丢失/错位）
    expect(kindOf(optionB.items).filter((k) => k === 'image')).toHaveLength(2);
    expect(textOf(optionB.items)).toBe('B．范围为mg~mg');
    // 选项标签解析正确（块化后 C/D 掉标签、黏到段落的旧症状不复发）
    expect(optionB.label).toBe('B.');

    // 计划只收块级图 + 行内图两类 src 全集（行内图仍需读盘/栅格）
    expect(plan.imageSrcs).toContain('data-assets/capture/zujuan/1.png');
    expect(plan.imageSrcs).toContain('data-assets/capture/zujuan/2.svg');
    expect(plan.imageSrcs).toContain('data-assets/capture/zujuan/3.svg');
  });

  it('0041 口径：题级覆盖不再提升 .inline-figure 行内图（公式固定，不成块也不重复出图）', () => {
    const q = makeQuestion({ content: OPTION_WITH_INLINE_FIGURE, images: IMAGES });
    const plan = buildDocxPlan(makePaper(), [q], {
      mode: 'student',
      questionLayouts: { q1: { figures: [{ assetId: 'capture/zujuan/2.svg' }] } },
    });
    const figures = plan.questions[0].blocks.filter((b) => b.kind === 'figure');
    // 0041 口径（用户拍板「排版页公式固定」）：只有块级 1.png 成块；覆盖命中的 2.svg 属行内公式图
    // → 固定留行内（不提升；也不再走「覆盖含但 content 匹配不到 → 外来图合成」的重复路径）
    expect(figures).toHaveLength(1);
    const options = plan.questions[0].blocks.find((b) => b.kind === 'options');
    if (options?.kind !== 'options') throw new Error('无选项块');
    expect(kindOf(options.options[1].items).filter((k) => k === 'image')).toHaveLength(2);
    // 行内图仍进读盘清单（DOCX 需栅格化）；且不得作为图块出现（无重复出图）
    expect(plan.imageSrcs).toContain('data-assets/capture/zujuan/2.svg');
    expect(figures.some((b) => b.kind === 'figure' && b.figure.src.includes('2.svg'))).toBe(false);
  });

  it('裸行内图（无 .inline-figure 包裹）仍按 0004-fix-4 语义参与块化（零回归）', () => {
    const q = makeQuestion({
      content: '<div class="question">如图<img src="data-assets/capture/zujuan/9.png">所示</div>',
      images: [{ assetId: 'data-assets/capture/zujuan/9.png', type: 'figure' }],
    });
    const plan = buildDocxPlan(makePaper(), [q], { mode: 'student' });
    expect(plan.questions[0].blocks.filter((b) => b.kind === 'figure')).toHaveLength(1);
  });
});

describe('0050 起：题内表格 → 表格块（0035 F3「降级保边界」升级为真表格）', () => {
  it('A/B/C/D 选项表：行/格边界在表内（不再黏成一行），文本逐格对应', () => {
    const html = '<div class="question">则（　　）<table><tbody>'
      + '<tr><td>A．甲</td><td>B．乙</td></tr>'
      + '<tr><td>C．丙</td><td>D．丁</td></tr>'
      + '</tbody></table>(2)下一问</div>';
    const { blocks, degradations } = parseContentSubset(html);

    const table = blocks.find((b) => b.kind === 'table');
    expect(table).toBeDefined();
    if (table?.kind !== 'table') throw new Error('无表格块');
    // 行边界：A/B 与 C/D 分属两行两格；单元格文本不再挤进同一段
    expect(table.rows.map((row) => row.map((cell) => textOf(cell.items))))
      .toEqual([['A．甲', 'B．乙'], ['C．丙', 'D．丁']]);
    // 表格已入契约清单：不再产生 table/tr/td 降级记录（旧口径的纯文本化被结构化取代）
    expect(degradations).toEqual([]);
  });

  it('表后正文另起一段（表格不吞掉后续题干）', () => {
    const html = '<div class="question"><table><tbody><tr><td>A．甲</td></tr></tbody></table>(2)若采用图乙装置，必需的工具是____。</div>';
    const { blocks } = parseContentSubset(html);
    expect(blocks.map((b) => b.kind)).toEqual(['table', 'paragraph']);
    const paragraphs = blocks.filter((b) => b.kind === 'paragraph').map((b) => textOf(b.items));
    expect(paragraphs).toEqual(['(2)若采用图乙装置，必需的工具是____。']);
  });
});
