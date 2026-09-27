import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 教师版答案/解析图限宽（D1-fix-2 实站复验追加）：
 * 答案/解析渲染在 .answer-field/.analysis-field（.question-content 之外），
 * 实站答案图 1768px 宽曾因无规则约束按原尺寸铺开（"插图巨大"）
 * D1-fix-3 J-3：块级大图封顶收紧为 80% 版心
 * 0004 S4：块级图默认观感档演进为 60% 版心/列宽（已知尺寸封顶在 figure 内联样式；
 * answer/analysis 字段图不参与 S4 档位，维持 80%）
 */
describe('paper.css — 答案/解析字段图限宽', () => {
  const css = readFileSync(join(__dirname, '../../src/docgen/render/paper.css'), 'utf-8');

  it('.answer-field/.analysis-field 内 figure 图限宽 80%', () => {
    expect(css).toMatch(/\.answer-field\s+figure\s*>\s*img[\s\S]*?max-width:\s*80%/);
    expect(css).toMatch(/\.analysis-field\s+figure\s*>\s*img[\s\S]*?max-width:\s*80%/);
  });

  it('.answer-field/.analysis-field 内裸 img 兜底限宽 80%', () => {
    expect(css).toMatch(/\.answer-field\s+img[\s\S]*?max-width:\s*80%/);
  });

  it('块级图 .question-content figure > img 放开 100%（0004 S4：封顶由 figure 内联样式 60% 默认档承担）', () => {
    expect(css).toMatch(/\.question-content\s+figure\s*>\s*img\s*\{[^}]*max-width:\s*100%/);
  });

  it('未知尺寸图 figure:not([style]) > img 封顶 60%（0004 S4 默认观感档）', () => {
    expect(css).toMatch(
      /\.question-content\s+figure:not\(\[style\]\)\s*>\s*img\s*\{[^}]*max-width:\s*60%/
    );
  });

  it('.inline-figure > img 垂直居中 + 仍 200px 封顶（D1-fix-3 J-4，不受 80% 影响）', () => {
    expect(css).toMatch(/\.inline-figure\s*>\s*img\s*\{[^}]*vertical-align:\s*middle/);
    expect(css).toMatch(/\.inline-figure\s*>\s*img\s*\{[^}]*max-width:\s*200px/);
    // .inline-figure > img 规则在 .answer-field img 之后（同特异性靠后生效），行内小图不被 80% 误伤
    expect(css.indexOf('.inline-figure > img {')).toBeGreaterThan(css.indexOf('.answer-field img,'));
  });

  it('0041 对齐采集预览：行内公式图按内在尺寸出图（撤 0010 P5 下限档），等比与 200px 封顶仍在', () => {
    // 采集预览渲染**未归一化**的原始站点 HTML（裸 img → 内在尺寸）；题库/排版走 .inline-figure 契约，
    // 曾带 1.25×字号下限被抬到 20px（真机实测墨迹 16.7-18.7px vs 采集预览 8.7-13.3px、正文 12pt≈15px）。
    // 现行：按内在尺寸出图（= 原站观感，用户 2026-09-18 目检拍板）。
    expect(css).not.toMatch(/\.inline-figure\s*>\s*img\s*\{[^}]*min-height/);
    // width:auto!important 覆盖 processFigures 写的 data-w 内联宽（防存量脏数据）；等比据此成立
    expect(css).toMatch(/\.inline-figure\s*>\s*img\s*\{[^}]*width:\s*auto\s*!important/);
    // 200px 封顶（上界护栏）与 height:auto 保持
    expect(css).toMatch(/\.inline-figure\s*>\s*img\s*\{[^}]*max-width:\s*200px/);
    expect(css).toMatch(/\.inline-figure\s*>\s*img\s*\{[^}]*height:\s*auto/);
    // 选择器只命中 .inline-figure 直系 img——figure.diagram/answer-field 图零波及
    expect(css).not.toMatch(/\.question-content\s+img\s*\{[^}]*min-height/);
    expect(css).not.toMatch(/figure\.diagram\s+img[^{]*\{[^}]*min-height/);
  });

  it('0009 卷头多行：.paper-header-line 基础行距在、字号不在 CSS 写死（由行内联样式承载）', () => {
    expect(css).toMatch(/\.paper-header-line\s*\{[^}]*line-height:\s*1\.4/);
    expect(css).toMatch(/\.paper-header-line\s*\{[^}]*margin:\s*0 0 0\.3em 0/);
    expect(css).not.toMatch(/\.paper-header-line\s*\{[^}]*font-size/);
  });
});
