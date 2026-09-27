// 0050 P2：题卡内容表格样式护栏（照 test/app/app-css.test.ts 既有存在性断言模式）。
//
// 口径（任务书 §二.P2）：样式落 src/app/app.css（theme.css 禁动），主题 token 不写死色值；
// 表头底色 + 细边框 + 紧凑行高 + 不撑破卡片（max-width:100% + 横向滚动兜底）。

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(__dirname, '../../src/app/app.css'), 'utf-8');

/** 0050 区段（注释锚点之间）：避免误命中其它区块的同名规则 */
const SECTION_START = '0050（R-037 第①步）：题卡内容表格样式';
const SECTION_END = '0013：选项版式三态题卡镜像';
const section = css.slice(css.indexOf(SECTION_START), css.indexOf(SECTION_END));

describe('0050 P2：app.css 内容表格样式', () => {
  it('区段存在且落在 app.css（theme.css 禁动纪律：样式区段带 0050 锚点）', () => {
    expect(css).toContain(SECTION_START);
    expect(section.length).toBeGreaterThan(0);
    expect(css.indexOf(SECTION_START)).toBeLessThan(css.indexOf(SECTION_END));
  });

  it('表格本体：边框合并 + max-width:100%（不撑破卡片）+ 紧凑行高/字号', () => {
    expect(section).toMatch(/\.question-content table[\s\S]*?\{[^}]*border-collapse:\s*collapse/);
    expect(section).toMatch(/\.question-content table[\s\S]*?\{[^}]*max-width:\s*100%/);
    expect(section).toMatch(/\.question-content table[\s\S]*?\{[^}]*line-height:\s*1\.45/);
    expect(section).toMatch(/\.question-content table[\s\S]*?\{[^}]*font-size:\s*0\.95em/);
  });

  it('单元格：细边框 var(--line-strong) + 紧凑内边距 + 长串不撑破（overflow-wrap）', () => {
    expect(section).toMatch(/\.question-content table th,\s*[\s\S]*?\{[^}]*border:\s*1px solid var\(--line-strong\)/);
    expect(section).toMatch(/\.question-content table th,\s*[\s\S]*?\{[^}]*padding:\s*3px 8px/);
    expect(section).toMatch(/\.question-content table th,\s*[\s\S]*?\{[^}]*overflow-wrap:\s*anywhere/);
  });

  it('表头：底色 var(--card-warm) + 加粗（随主题，不写死色值）', () => {
    expect(section).toMatch(/\.question-content table th,\s*[\s\S]*?\{[^}]*background:\s*var\(--card-warm\)/);
    expect(section).toMatch(/\.question-content table th,\s*[\s\S]*?\{[^}]*font-weight:\s*600/);
  });

  it('横向滚动兜底：内容容器 overflow-x:auto（超宽表滚动条出在卡片内）', () => {
    expect(section).toMatch(/\.question-content,\s*\n\s*\.q-stem,\s*\n\s*\.m-stem\s*\{[^}]*overflow-x:\s*auto/);
  });

  it('覆盖题卡同族容器（.question 题根 / .q-stem / .m-stem，不只 .question-content）', () => {
    for (const sel of ['.question table', '.q-stem table', '.m-stem table']) {
      expect(section).toContain(sel);
    }
  });

  it('全 token 配色：区段内无写死色值（#rrggbb / rgb()/命名色）', () => {
    expect(section).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(section).not.toMatch(/\brgba?\(/);
  });

  it('钉住既有护栏口径：inline-figure 200px 档不被本单表格规则改写（0041 口径零回归）', () => {
    // 表格规则只命中 table 后代；.inline-figure > img 规则原文仍在（同一文件内未被替换）
    expect(css).toMatch(/\.inline-figure\s*>\s*img\s*\{[^}]*max-width:\s*200px/);
    expect(section).not.toMatch(/\.inline-figure/);
  });
});
