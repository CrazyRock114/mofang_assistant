// 0050 P1（R-037 第①步）：识别链 markdown 表格 → 契约 HTML 真表格（RED 先行）。
//
// 口径（任务书 §二.P1）：
//   ① 表头行 + 分隔行（|---| / |:---|）齐备才转；缺分隔行/分隔行列数不齐 → 不转（保持段落，防误伤普通竖线文本）；
//   ② 列数以表头为准：表体行少补空单元格、多于表头截断；
//   ③ 单元格内行内件照常（$…$ 公式、[图N] 图）——[图N] 落**行内图**（span.inline-figure）：
//      块级 figure 会被图块化管线（figureBlocks）从 <td> 内摘出、拆破表结构（与选项内同口径）；
//   ④ 单元格内不递归块级语法（列表/标题/引用只作字面文本）；
//   ⑤ 未闭合残行（`abc|`／`| abc` 单格位孤立竖线行）不并入表，按普通段落落；行尾管可省（GFM 口径）。

import { describe, it, expect } from 'vitest';
import { stemMarkdownToHtml, textMarkdownToHtml } from '../../src/recog/onestep/markdown.js';

const OPTIONS = {
  figureSrc: (refIndex: number) => `data-assets/capture/probe/f${refIndex}.png`,
  figureSize: () => ({ width: 40, height: 30 }),
};

describe('0050 P1：markdown 表格 → 契约 <table>', () => {
  it('标准表（表头 + 分隔行 + 表体）转真表格，前后段落原位保留', () => {
    const html = stemMarkdownToHtml(
      '下表为实验数据：\n\n| 物理量 | 数值 |\n| --- | --- |\n| 甲 | 1 |\n| 乙 | 2 |\n\n结论：成正比。'
    );
    expect(html).toBe(
      '<p>下表为实验数据：</p>'
      + '<table><thead><tr><th>物理量</th><th>数值</th></tr></thead>'
      + '<tbody><tr><td>甲</td><td>1</td></tr><tr><td>乙</td><td>2</td></tr></tbody></table>'
      + '<p>结论：成正比。</p>'
    );
  });

  it('对齐语法（:---:/---:）同样是合法分隔行', () => {
    const html = stemMarkdownToHtml('| 甲 | 乙 |\n|:---|---:|\n| 1 | 2 |');
    expect(html).toBe(
      '<table><thead><tr><th>甲</th><th>乙</th></tr></thead>'
      + '<tbody><tr><td>1</td><td>2</td></tr></tbody></table>'
    );
  });

  it('行首尾竖线可省（无外框形态照样成表）', () => {
    const html = stemMarkdownToHtml('甲 | 乙\n--- | ---\n1 | 2');
    expect(html).toBe(
      '<table><thead><tr><th>甲</th><th>乙</th></tr></thead>'
      + '<tbody><tr><td>1</td><td>2</td></tr></tbody></table>'
    );
  });

  it('只有表头无表体：仍是表格（空 tbody）', () => {
    const html = stemMarkdownToHtml('| 甲 | 乙 |\n| --- | --- |');
    expect(html).toBe('<table><thead><tr><th>甲</th><th>乙</th></tr></thead><tbody></tbody></table>');
  });

  it('缺分隔行不转（普通竖线文本保持段落，不误伤）', () => {
    expect(stemMarkdownToHtml('| 甲 | 乙 |\n| 丙 | 丁 |')).toBe('<p>| 甲 | 乙 |<br>| 丙 | 丁 |</p>');
  });

  it('分隔行列数不齐 → 不转（列数以表头为准的前提是分隔行齐备）', () => {
    expect(stemMarkdownToHtml('| 甲 | 乙 |\n| --- |\n| 1 | 2 |'))
      .toBe('<p>| 甲 | 乙 |<br>| --- |<br>| 1 | 2 |</p>');
  });

  it('无竖线的单行 + 短横线（水平线/普通断行）不误判成单列表格', () => {
    // 无竖线 = 不成表：三行按既有段落口径（连续行 <br> 相连）原样落
    expect(stemMarkdownToHtml('实验记录\n---\n下一步')).toBe('<p>实验记录<br>---<br>下一步</p>');
  });

  it('列数不齐：少补空单元格、多于表头截断（列数以表头为准）', () => {
    const html = stemMarkdownToHtml('| 甲 | 乙 | 丙 |\n| --- | --- | --- |\n| 1 |\n| 1 | 2 | 3 | 4 |');
    expect(html).toBe(
      '<table><thead><tr><th>甲</th><th>乙</th><th>丙</th></tr></thead>'
      + '<tbody><tr><td>1</td><td></td><td></td></tr>'
      + '<tr><td>1</td><td>2</td><td>3</td></tr></tbody></table>'
    );
  });

  it('单元格内公式照常转 span.math（行内，非 display）', () => {
    const html = stemMarkdownToHtml('| 量 | 式 |\n| --- | --- |\n| 速度 | $v=\\frac{s}{t}$ |');
    expect(html).toContain('<td>速度</td>');
    expect(html).toContain('<td><span class="math" data-tex="v=\\frac{s}{t}"></span></td>');
    expect(html).not.toContain('data-display');
  });

  it('单元格内 [图N] 落行内图（span.inline-figure），不落块级 figure（表结构不被图块化摘图）', () => {
    const html = stemMarkdownToHtml('| 量 | 图示 |\n| --- | --- |\n| 甲 | [图1] |', OPTIONS);
    expect(html).toContain('data-assets/capture/probe/f1.png');
    expect(html).toContain('<span class="inline-figure">');
    expect(html).toContain('data-w="40" data-h="30"');
    expect(html).not.toContain('<figure');
  });

  it('单元格内不递归块级语法（列表/标题/引用只作字面文本）', () => {
    const html = stemMarkdownToHtml('| 甲 | 乙 |\n| --- | --- |\n| - 项一 | # 标题 |');
    expect(html).toContain('<td>- 项一</td>');
    expect(html).toContain('<td># 标题</td>');
    expect(html).not.toContain('<ul>');
    expect(html).not.toContain('<h1>');
  });

  it('未闭合残行不并入表（按普通段落落），表在此终止', () => {
    const html = stemMarkdownToHtml('| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\nabc|\n| 3 | 4 |');
    // 表在残行处终止；残行与后续行按既有段落口径相连（无分隔行 → 不成第二张表）
    expect(html).toBe(
      '<table><thead><tr><th>甲</th><th>乙</th></tr></thead>'
      + '<tbody><tr><td>1</td><td>2</td></tr></tbody></table>'
      + '<p>abc|<br>| 3 | 4 |</p>'
    );
  });

  it('行尾竖线可省：多格行（缺尾管）仍属表体', () => {
    const html = stemMarkdownToHtml('| 甲 | 乙 |\n| --- | --- |\n| 1 | 2');
    expect(html).toBe(
      '<table><thead><tr><th>甲</th><th>乙</th></tr></thead>'
      + '<tbody><tr><td>1</td><td>2</td></tr></tbody></table>'
    );
  });

  it('转义竖线与 $…$ 内的竖线不算分隔符（绝对值/公式列不被切格）', () => {
    const html = stemMarkdownToHtml('| 量 | 备注 |\n| --- | --- |\n| $|x|$ | 甲\\|乙 |');
    expect(html).toBe(
      '<table><thead><tr><th>量</th><th>备注</th></tr></thead>'
      + '<tbody><tr><td><span class="math" data-tex="|x|"></span></td><td>甲|乙</td></tr></tbody></table>'
    );
  });

  it('空表体行（仅竖线）不产生空行占位', () => {
    const html = stemMarkdownToHtml('| 甲 | 乙 |\n| --- | --- |\n|  |  |');
    expect(html).toBe(
      '<table><thead><tr><th>甲</th><th>乙</th></tr></thead>'
      + '<tbody><tr><td></td><td></td></tr></tbody></table>'
    );
  });

  it('表格后紧跟正文（无空行）不吞正文', () => {
    const html = stemMarkdownToHtml('| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n据表可知____。');
    expect(html).toBe(
      '<table><thead><tr><th>甲</th><th>乙</th></tr></thead>'
      + '<tbody><tr><td>1</td><td>2</td></tr></tbody></table>'
      + '<p>据表可知____。</p>'
    );
  });

  it('答案/解析片段（textMarkdownToHtml）同口径转表', () => {
    const html = textMarkdownToHtml('| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |');
    expect(html).toBe(
      '<table><thead><tr><th>甲</th><th>乙</th></tr></thead>'
      + '<tbody><tr><td>1</td><td>2</td></tr></tbody></table>'
    );
  });

  it('单元格文本走 HTML 转义（不注入标签）', () => {
    const html = stemMarkdownToHtml('| 甲 | 乙 |\n| --- | --- |\n| <b>x</b> | a&b |');
    expect(html).toContain('<td>&lt;b&gt;x&lt;/b&gt;</td>');
    expect(html).toContain('<td>a&amp;b</td>');
  });

  it('无表格时段落行为零变化（空行分段 + 单行内 <br>）', () => {
    expect(stemMarkdownToHtml('第一行\n第二行\n\n第三段')).toBe('<p>第一行<br>第二行</p><p>第三段</p>');
  });
});
