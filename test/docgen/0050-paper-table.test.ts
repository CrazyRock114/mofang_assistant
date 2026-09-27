// 0050 P3：出卷纸面表格——样式护栏（paper.css）+ 渲染链不改表结构（buildPaperHtml 基线与 config 双路径）。
//
// 口径（任务书 §二.P3）：近印刷样（实线边框 + 表头加粗）；A4 版心内不溢出；
// 纸面属内容物（固定近白底，不随主题——paper-sheet 硬约束不变，故样式用实色不用 token）。

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Paper, Question } from '../../src/shared/contracts/bank-types.js';
import { buildPaperHtml } from '../../src/docgen/render/buildPaperHtml.js';

const css = readFileSync(join(__dirname, '../../src/docgen/render/paper.css'), 'utf-8');
const SECTION_START = '0050（R-037 第①步）：纸面表格';
const SECTION_END = '教师版答案/解析字段在 .question-content 之外';
const section = css.slice(css.indexOf(SECTION_START), css.indexOf(SECTION_END));
/** 区段去注释后的规则正文（断言选择器/声明时不受注释文字干扰） */
const sectionRules = section.replace(/\/\*[\s\S]*?\*\//g, '');

/** 0050 P1 产出的契约表格（识别链 md 表格 → 契约 HTML 的真实形态） */
const TABLE_CONTENT =
  '<div class="question"><p>下表为实验数据：</p>'
  + '<table><thead><tr><th>物理量</th><th>数值</th></tr></thead>'
  + '<tbody><tr><td>甲</td><td>1</td></tr><tr><td>乙</td><td>2</td></tr></tbody></table>'
  + '<p>结论：成正比。</p></div>';

function makeQuestion(over: Partial<Question> = {}): Question {
  return {
    id: 'q1',
    subject: '物理',
    sourceType: 'local',
    sourceDetail: {},
    content: TABLE_CONTENT,
    images: [],
    createdAt: '2026-09-22T00:00:00Z',
    updatedAt: '2026-09-22T00:00:00Z',
    ...over,
  };
}

function makePaper(over: Partial<Paper> = {}): Paper {
  return { id: 'p1', title: '0050 表格卷', config: {}, createdAt: '2026-09-22T00:00:00Z', archived: false, ...over };
}

describe('0050 P3：paper.css 纸面表格样式', () => {
  it('区段存在（0050 锚点，位于内容规则区）', () => {
    expect(css).toContain(SECTION_START);
    expect(section.length).toBeGreaterThan(0);
  });

  it('表格：边框合并 + 满版心定宽（width/max-width 100% + table-layout:fixed → 版心内不溢出）', () => {
    expect(section).toMatch(/\.question-content table,[\s\S]*?\{[^}]*border-collapse:\s*collapse/);
    expect(section).toMatch(/\.question-content table,[\s\S]*?\{[^}]*width:\s*100%/);
    expect(section).toMatch(/\.question-content table,[\s\S]*?\{[^}]*max-width:\s*100%/);
    expect(section).toMatch(/\.question-content table,[\s\S]*?\{[^}]*table-layout:\s*fixed/);
  });

  it('单元格：实线边框 + 表头加粗（近印刷样）', () => {
    expect(section).toMatch(/\.question-content table th,\s*[\s\S]*?\{[^}]*border:\s*1px solid #000/);
    expect(section).toMatch(/\.question-content table th,\s*[\s\S]*?\{[^}]*font-weight:\s*bold/);
    expect(section).toMatch(/\.question-content table th,\s*[\s\S]*?\{[^}]*background:\s*#f2f2f2/);
  });

  it('行不跨页切割（tr break-inside:avoid；表可跨页——同「题目允许跨页」口径）', () => {
    expect(section).toMatch(/\.question-content table tr,[\s\S]*?\{[^}]*break-inside:\s*avoid/);
    // 整表不做整块保留（长表硬留会留空白页）
    expect(section).not.toMatch(/\.question-content table\s*\{[^}]*break-inside:\s*avoid/);
  });

  it('纸面不随主题：区段用实色不用 token（paper-sheet 硬约束）', () => {
    expect(section).not.toMatch(/var\(--/);
  });

  it('答案/解析字段表格同档（.answer-field/.analysis-field 在 .question-content 之外）', () => {
    expect(section).toContain('.answer-field table');
    expect(section).toContain('.analysis-field table');
  });

  it('单元格内裸图相对单元格限宽；不碰 .inline-figure 档（0041 口径零回归）', () => {
    expect(sectionRules).toMatch(/\.question-content table td > img/);
    expect(sectionRules).not.toMatch(/\.inline-figure/);
    expect(sectionRules).not.toMatch(/figure\.diagram/);
    expect(css).toMatch(/\.inline-figure\s*>\s*img\s*\{[^}]*max-width:\s*200px/);
    expect(css).toMatch(/\.inline-figure\s*>\s*img\s*\{[^}]*width:\s*auto\s*!important/);
  });
});

describe('0050 P3：渲染链不改表结构（buildPaperHtml 双路径）', () => {
  it('基线路径：表格标签原样进题面，样式随 paper.css 内联', async () => {
    const html = await buildPaperHtml(makePaper(), [makeQuestion()], { mode: 'student' });
    expect(html).toContain('<table><thead><tr><th>物理量</th><th>数值</th></tr></thead>');
    expect(html).toContain('<tbody><tr><td>甲</td><td>1</td></tr><tr><td>乙</td><td>2</td></tr></tbody></table>');
    // 表前后段落原位（表格不被拆段；用内容锚点避开 CSS 注释里的同名字符串）
    expect(html.indexOf('<p>下表为实验数据：</p>')).toBeLessThan(html.indexOf('<table><thead>'));
    expect(html.indexOf('</tbody></table>')).toBeLessThan(html.indexOf('<p>结论：成正比。</p>'));
    // 纸面表格样式随 CSS 内联进产物
    expect(html).toContain('border-collapse: collapse');
    expect(html).toContain('table-layout: fixed');
  });

  it('config 驱动路径（块化图排版管线）：表格结构完整、不吞后续段落', async () => {
    const html = await buildPaperHtml(makePaper(), [makeQuestion()], {
      mode: 'student',
      layoutConfig: { optionsLayout: 'two-lines' },
    });
    expect(html).toContain('<table><thead><tr><th>物理量</th><th>数值</th></tr></thead>');
    expect(html).toContain('<td>乙</td>');
    expect(html.indexOf('</tbody></table>')).toBeLessThan(html.indexOf('结论：成正比。'));
  });

  it('教师版：答案/解析字段里的表格同样进产物（.answer-field 档）', async () => {
    const q = makeQuestion({
      content: '<div class="question"><p>题干</p></div>',
      answer: '<table><thead><tr><th>甲</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>',
    });
    const html = await buildPaperHtml(makePaper(), [q], { mode: 'teacher' });
    expect(html).toContain('class="answer-field"');
    expect(html).toContain('<table><thead><tr><th>甲</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>');
  });
});
