// 0035 P1：内容子集转换器（契约标签 → DOCX 中间模型）——逐标签断言 + 清单外降级路径。

import { describe, it, expect } from 'vitest';
import {
  parseContentSubset,
  mergeDegradations,
  type InlineItem,
  type ContentBlock,
} from '../../src/docgen/export/docx/content-subset.js';

/** 可见文本（仅 text 项；公式/图片/换行项不参与——与"文本是否保留"的断言语义对齐） */
const text = (items: InlineItem[]): string => items.filter((i) => i.kind === 'text').map((i) => i.value).join('');
const firstParagraph = (blocks: ContentBlock[]): Extract<ContentBlock, { kind: 'paragraph' }> => {
  const para = blocks.find((b): b is Extract<ContentBlock, { kind: 'paragraph' }> => b.kind === 'paragraph');
  if (!para) throw new Error('无段落块');
  return para;
};

describe('0035 content-subset：契约内标签', () => {
  it('p/strong/em/sub/sup 逐标签转 run 格式（文本不丢）', () => {
    const { blocks, degradations } = parseContentSubset(
      '<div class="question"><p>质量<strong>守恒</strong>与<em>速度</em>的<sub>1</sub><sup>2</sup></p></div>'
    );
    expect(degradations).toHaveLength(0);
    const para = firstParagraph(blocks);
    expect(text(para.items)).toBe('质量守恒与速度的12');
    const runs = para.items.filter((i) => i.kind === 'text');
    expect(runs.map((r) => [r.value, r.format.bold === true, r.format.italic === true, r.format.vertical ?? null])).toEqual([
      ['质量', false, false, null],
      ['守恒', true, false, null],
      ['与', false, false, null],
      ['速度', false, true, null],
      ['的', false, false, null],
      ['1', false, false, 'sub'],
      ['2', false, false, 'sup'],
    ]);
  });

  it('span.math[data-tex] → 行内公式项；data-display=true → 独立公式块', () => {
    const { blocks } = parseContentSubset(
      '<div class="question">已知 <span class="math" data-tex="E_k = \\frac{1}{2}mv^2"></span> 求值。'
      + '<span class="math" data-tex="x = \\frac{-b}{2a}" data-display="true"></span></div>'
    );
    const para = firstParagraph(blocks);
    const math = para.items.find((i) => i.kind === 'math');
    expect(math?.value).toBe('E_k = \\frac{1}{2}mv^2');
    expect(math?.display).toBe(false);
    expect(text(para.items)).toBe('已知  求值。');
    const displayBlock = blocks.find((b) => b.kind === 'math');
    expect(displayBlock).toBeDefined();
    if (displayBlock?.kind === 'math') expect(displayBlock.tex).toBe('x = \\frac{-b}{2a}');
  });

  it('figure.diagram → 图块（data-align/data-w/data-h + img src 抽取）', () => {
    const { blocks, degradations } = parseContentSubset(
      '<div class="question"><p>如图</p><figure class="diagram" data-align="right" data-w="300" data-h="200">'
      + '<img src="data-assets/capture/a.png" alt="电路图"></figure></div>'
    );
    expect(degradations).toHaveLength(0);
    const figure = blocks.find((b) => b.kind === 'figure');
    expect(figure).toBeDefined();
    if (figure?.kind === 'figure') {
      expect(figure.src).toBe('data-assets/capture/a.png');
      expect(figure.alt).toBe('电路图');
      expect(figure.align).toBe('right');
      expect(figure.widthPx).toBe(300);
      expect(figure.heightPx).toBe(200);
    }
  });

  it('options → 选项块（逐 option 一项，含行内公式）', () => {
    const { blocks } = parseContentSubset(
      '<div class="question">选一选。<div class="options">'
      + '<span class="option">A. 甲 <span class="math" data-tex="a=1"></span></span>'
      + '<span class="option">B. 乙</span></div></div>'
    );
    const options = blocks.find((b) => b.kind === 'options');
    expect(options).toBeDefined();
    if (options?.kind === 'options') {
      expect(options.options).toHaveLength(2);
      expect(text(options.options[0].items)).toBe('A. 甲 ');
      expect(options.options[0].items.some((i) => i.kind === 'math' && i.value === 'a=1')).toBe(true);
      expect(text(options.options[1].items)).toBe('B. 乙');
    }
  });

  it('answer → 答案块（独立语义块，不混入题干段）', () => {
    const { blocks } = parseContentSubset(
      '<div class="question"><p>题干</p><div class="answer">答：<strong>甲</strong></div></div>'
    );
    const answer = blocks.find((b) => b.kind === 'answer');
    expect(answer).toBeDefined();
    if (answer?.kind === 'answer') expect(text(answer.items)).toBe('答：甲');
    expect(firstParagraph(blocks).items.some((i) => i.value.includes('答'))).toBe(false);
  });

  it('实体解码 + br 保留（硬换行项）', () => {
    const { blocks } = parseContentSubset('<div class="question"><p>a&amp;b&nbsp;c&lt;d&gt;<br>第二行</p></div>');
    const para = firstParagraph(blocks);
    expect(text(para.items)).toBe('a&b c<d>第二行');
    expect(para.items.some((i) => i.kind === 'break')).toBe(true);
  });
});

describe('0035 content-subset：清单外标签显式降级', () => {
  it('表格已入契约清单（0050 P4）：结构化表格块取代纯文本化，内容逐格在案（不静默吞）', () => {
    const { blocks, degradations } = parseContentSubset(
      '<div class="question"><table><tr><td>甲</td><td>乙</td></tr></table></div>'
    );
    const table = blocks.find((b) => b.kind === 'table');
    expect(table).toBeDefined();
    if (table?.kind !== 'table') throw new Error('无表格块');
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0].map((cell) => text(cell.items))).toEqual(['甲', '乙']);
    expect(degradations).toEqual([]);
  });

  it('无 tr 的空表回落既有降级口径（断段 + 记账，不静默吞）', () => {
    const { blocks, degradations } = parseContentSubset(
      '<div class="question"><p>前文</p><table></table><p>后文</p></div>'
    );
    expect(blocks.some((b) => b.kind === 'table')).toBe(false);
    expect(degradations.map((d) => d.tag)).toContain('table');
    expect(text(firstParagraph(blocks).items)).toBe('前文');
  });

  it('script/style 内容整段丢弃且记降级（不落进正文）', () => {
    const { blocks, degradations } = parseContentSubset(
      '<div class="question"><p>正文</p><script>alert(1)</script><style>.a{color:red}</style></div>'
    );
    expect(degradations.map((d) => d.tag).sort()).toEqual(['script', 'style']);
    expect(text(firstParagraph(blocks).items)).toBe('正文');
    expect(blocks.some((b) => b.kind === 'paragraph' && text(b.items).includes('alert'))).toBe(false);
  });

  it('裸 span/div（无契约语义）降级但保留文本', () => {
    const { blocks, degradations } = parseContentSubset(
      '<div class="question"><div><span style="color:red">红字</span></div></div>'
    );
    expect(degradations.length).toBeGreaterThan(0);
    expect(text(firstParagraph(blocks).items)).toBe('红字');
  });

  it('mergeDegradations 按标签聚合计数 + 样本', () => {
    const merged = mergeDegradations([
      { tag: 'table', text: '甲' },
      { tag: 'table', text: '乙' },
      { tag: 'td', text: '甲' },
    ]);
    expect(merged).toEqual([
      { tag: 'table', count: 2, sample: '甲' },
      { tag: 'td', count: 1, sample: '甲' },
    ]);
  });
});

describe('0035 content-subset：容错与兼容形态', () => {
  it('空串/纯文本不崩（无标签 → 单段落）', () => {
    expect(parseContentSubset('').blocks).toHaveLength(0);
    const only = parseContentSubset('裸文本');
    expect(text(firstParagraph(only.blocks).items)).toBe('裸文本');
  });

  it('未闭合标签不崩（容错解析，文本保留）', () => {
    const { blocks } = parseContentSubset('<div class="question"><p>前半<strong>粗体未闭合');
    expect(text(firstParagraph(blocks).items)).toBe('前半粗体未闭合');
  });

  it('已渲染 KaTeX 形态（span.katex + annotation）按公式回收（存量数据兼容）', () => {
    const { blocks } = parseContentSubset(
      '<div class="question"><span class="katex"><span class="katex-mathml"><math><semantics>'
      + '<annotation encoding="application/x-tex">\\sqrt{2}</annotation></semantics></math></span>'
      + '<span class="katex-html">√2</span></span></div>'
    );
    const math = firstParagraph(blocks).items.find((i) => i.kind === 'math');
    expect(math?.value).toBe('\\sqrt{2}');
  });

  it('行内裸 img（data-w）按行内图片项（真实数据存在，HTML 管线同语义）', () => {
    const { blocks } = parseContentSubset(
      '<div class="question"><p>公式图 <img src="data-assets/capture/m1.png" data-w="120"></p></div>'
    );
    const img = firstParagraph(blocks).items.find((i) => i.kind === 'image');
    expect(img?.value).toBe('data-assets/capture/m1.png');
    expect(img?.widthPx).toBe(120);
  });
});
