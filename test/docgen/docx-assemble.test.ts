// 0035 P1：DOCX 组装器——段落/表格/图片计数快照断言（解包 word/document.xml 实测）+ 边界。

import { describe, it, expect } from 'vitest';
import { assembleDocx, type DocxAssets } from '../../src/docgen/export/docx/assemble.js';
import { mapLayout } from '../../src/docgen/export/docx/layout-map.js';
import { resolveLayout } from '../../src/docgen/render/layout.js';
import type { DocxPlan, PlannedQuestion } from '../../src/docgen/export/docx/plan.js';
import { documentXml, readZipEntries, countOf } from './helpers/zip-read.js';

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
);

/** 语义断言辅助：取某标签的属性值（首个匹配） */
function attrOf(xml: string, tag: string, attr: string): string | null {
  const match = new RegExp(`<${tag}\\b[^>]*\\b${attr}="([^"]*)"`).exec(xml);
  return match ? match[1] : null;
}

function emptyAssets(): DocxAssets {
  return { math: new Map(), assets: new Map() };
}

function makeQuestion(over: Partial<PlannedQuestion> = {}): PlannedQuestion {
  return {
    kind: 'question',
    id: 'q1',
    no: 1,
    showNo: true,
    showScore: true,
    score: 5,
    blocks: [],
    sideFigures: [],
    ...over,
  };
}

function makePlan(over: Partial<DocxPlan> = {}): DocxPlan {
  return {
    mode: 'teacher',
    title: '0035 组装卷',
    page: mapLayout(resolveLayout(undefined)),
    headerLines: [{ text: '0035 组装卷', sizePt: 18, align: 'center', bold: true }],
    logos: [],
    questions: [],
    mathItems: [],
    degradations: [],
    ...over,
  };
}

describe('0035 assemble：基础结构', () => {
  it('空卷产出合法 zip（document.xml 在、可打开）', async () => {
    const buf = await assembleDocx(makePlan(), emptyAssets());
    const entries = readZipEntries(buf);
    expect(entries.has('word/document.xml')).toBe(true);
    expect(entries.has('[Content_Types].xml')).toBe(true);
  });

  it('纸张/边距/双栏/字号按 mapLayout 落 twip（A3 横版双列）', async () => {
    const plan = makePlan({
      page: mapLayout(resolveLayout({ version: 2, pageSize: 'A3', orientation: 'landscape', columns: 2, columnGapMm: 8 })),
    });
    const xml = documentXml(await assembleDocx(plan, emptyAssets()));
    expect(attrOf(xml, 'w:pgSz', 'w:w')).toBe('23811'); // A3 横版 420mm
    expect(attrOf(xml, 'w:pgSz', 'w:h')).toBe('16838'); // 297mm
    expect(attrOf(xml, 'w:pgMar', 'w:top')).toBe('1134');
    expect(attrOf(xml, 'w:pgMar', 'w:left')).toBe('850');
    expect(attrOf(xml, 'w:cols', 'w:num')).toBe('2');
    expect(attrOf(xml, 'w:cols', 'w:space')).toBe('454');
  });

  it('题号/分值/正文段落 + 段落计数', async () => {
    const plan = makePlan({
      questions: [makeQuestion({
        blocks: [
          { kind: 'paragraph', items: [{ kind: 'text', value: '质量为 m 的物体', format: {} }] },
          { kind: 'paragraph', items: [{ kind: 'text', value: '求动能。', format: { bold: true } }] },
        ],
      })],
    });
    const xml = documentXml(await assembleDocx(plan, emptyAssets()));
    expect(countOf(xml, '<w:p>')).toBe(3); // 题头段 + 两段正文（无页眉/页脚在同文件内）
    expect(xml).toContain('质量为 m 的物体');
    expect(xml).toContain('1.');
    expect(xml).toContain('(5分)');
    expect(countOf(xml, '<w:b/>')).toBeGreaterThanOrEqual(2); // 题头 + 加粗段
  });

  it('教师版答案/解析段（红字）与作答区（横线底边框）', async () => {
    const plan = makePlan({
      questions: [makeQuestion({
        answerItems: [{ kind: 'text', value: '答：甲', format: {} }],
        analysisItems: [{ kind: 'text', value: '解析：因为甲', format: {} }],
        answerSpace: { style: 'lines', heightTwip: 1296 },
      })],
    });
    const xml = documentXml(await assembleDocx(plan, emptyAssets()));
    expect(xml).toContain('答：甲');
    expect(xml).toContain('解析：因为甲');
    expect(xml).toContain('D32F2F'); // 教师版红笔
    expect(countOf(xml, '<w:pBdr>')).toBeGreaterThanOrEqual(1); // 作答区横线
  });
});

describe('0035 assemble：公式与图片', () => {
  it('行内公式图 + display 公式段 + 基线校正（w:position 负值）', async () => {
    const plan = makePlan({
      mathItems: [
        { key: 'inline:16:F=ma', tex: 'F=ma', display: false, fontPx: 16 },
        { key: 'display:16:a=\\frac{F}{m}', tex: 'a=\\frac{F}{m}', display: true, fontPx: 16 },
      ],
      questions: [makeQuestion({
        blocks: [
          {
            kind: 'paragraph',
            items: [
              { kind: 'text', value: '由', format: {} },
              { kind: 'math', value: 'F=ma', format: {}, display: false },
              { kind: 'text', value: '得', format: {} },
            ],
          },
          { kind: 'math', tex: 'a=\\frac{F}{m}' },
        ],
      })],
    });
    const assets: DocxAssets = {
      math: new Map([
        ['inline:16:F=ma', { png: PNG_1x1, widthPx: 60, heightPx: 20, depthPx: 4 }],
        ['display:16:a=\\frac{F}{m}', { png: PNG_1x1, widthPx: 40, heightPx: 40, depthPx: 0 }],
      ]),
      assets: new Map(),
    };
    const buf = await assembleDocx(plan, assets);
    const xml = documentXml(buf);
    expect(countOf(xml, '<w:drawing>')).toBe(2);
    expect(readZipEntries(buf).size).toBeGreaterThan(0);
    // 基线校正：depth 4px → 4×0.75pt = 3pt = 6 半磅，负值=下沉
    expect(xml).toContain('<w:position w:val="-6"/>');
    // 行内公式与文本同段；display 公式独立居中段
    expect(attrOf(xml, 'w:jc', 'w:val')).toBe('center');
    expect(countOf(xml, 'framePr')).toBe(0);
  });

  it('图块按 widthPx 落位（对齐/宽度按版式）', async () => {
    const plan = makePlan({
      questions: [makeQuestion({
        blocks: [{
          kind: 'figure',
          figure: { src: 'data-assets/capture/a.png', alt: '电路图', align: 'center', widthPercent: null, dataWidthPx: 300, dataHeightPx: 200 },
        }],
      })],
    });
    const assets: DocxAssets = {
      math: new Map(),
      assets: new Map([
        ['data-assets/capture/a.png', { kind: 'image', data: PNG_1x1, type: 'png', width: 300, height: 200 }],
      ]),
    };
    const xml = documentXml(await assembleDocx(plan, assets));
    expect(countOf(xml, '<w:drawing>')).toBe(1);
    expect(xml).toContain('电路图'); // altText 落 wp:docPr descr
    // 300px 宽 < 60% 版心（408px）→ 原宽（9525 EMU/px）
    expect(xml).toContain(`cx="${300 * 9525}"`);
  });

  it('图缺失 → 占位文本（显式，不静默丢）且不产 drawing', async () => {
    const plan = makePlan({
      questions: [makeQuestion({
        blocks: [{
          kind: 'figure',
          figure: { src: 'data-assets/capture/missing.png', alt: '', align: 'center', widthPercent: null, dataWidthPx: null, dataHeightPx: null },
        }],
      })],
    });
    const xml = documentXml(await assembleDocx(plan, emptyAssets()));
    expect(countOf(xml, '<w:drawing>')).toBe(0);
    expect(xml).toContain('图缺失');
  });

  it('side-by-side 图块 → 双列表格（正文左、图右）', async () => {
    const plan = makePlan({
      questions: [makeQuestion({
        blocks: [{ kind: 'paragraph', items: [{ kind: 'text', value: '题干文字', format: {} }] }],
        sideFigures: [{ src: 'data-assets/capture/side.png', alt: '', align: 'center', widthPercent: 45, dataWidthPx: null, dataHeightPx: null }],
      })],
    });
    const assets: DocxAssets = {
      math: new Map(),
      assets: new Map([
        ['data-assets/capture/side.png', { kind: 'image', data: PNG_1x1, type: 'png', width: 100, height: 100 }],
      ]),
    };
    const xml = documentXml(await assembleDocx(plan, assets));
    expect(countOf(xml, '<w:tbl>')).toBe(1);
    expect(countOf(xml, '<w:tc>')).toBe(2);
    expect(xml).toContain('题干文字');
    expect(countOf(xml, '<w:drawing>')).toBe(1);
  });
});

describe('0035 assemble：选项版式与页眉页脚', () => {
  it('选项 auto=逐项段落；single-line=单行表格', async () => {
    const blocks = [{
      kind: 'options' as const,
      optionsLayout: 'auto' as const,
      options: [
        { label: 'A', items: [{ kind: 'text' as const, value: 'A. 甲', format: {} }] },
        { label: 'B', items: [{ kind: 'text' as const, value: 'B. 乙', format: {} }] },
      ],
    }];
    const auto = documentXml(await assembleDocx(makePlan({ questions: [makeQuestion({ blocks })] }), emptyAssets()));
    expect(countOf(auto, '<w:tbl>')).toBe(0);
    expect(countOf(auto, '<w:p>')).toBe(4); // 卷头行 + 题头 + 选项两段

    const single = documentXml(await assembleDocx(
      makePlan({ questions: [makeQuestion({ blocks: [{ ...blocks[0], optionsLayout: 'single-line' }] })] }),
      emptyAssets()
    ));
    expect(countOf(single, '<w:tbl>')).toBe(1);
    expect(attrOf(single, 'w:tblLayout', 'w:type')).toBe('fixed');
  });

  it('卷头行 + 页脚页码字段落位', async () => {
    const plan = makePlan();
    const entries = readZipEntries(await assembleDocx(plan, emptyAssets()));
    const xml = entries.get('word/document.xml')?.toString('utf8') ?? '';
    expect(xml).toContain('0035 组装卷');
    const footer = entries.get('word/footer1.xml')?.toString('utf8') ?? '';
    expect(footer).toContain('PAGE');
    // 无 Logo：不产页眉部件（卷头行走正文首段，不重复到每页）
    expect(entries.has('word/header1.xml')).toBe(false);
  });

  it('logo 以页眉近似落位（重排版式：绝对定位不可保真）', async () => {
    const plan = makePlan({
      logos: [{ src: 'data-assets/logos/pixel.png', align: 'left', widthPx: 90 }],
    });
    const assets: DocxAssets = {
      math: new Map(),
      assets: new Map([['data-assets/logos/pixel.png', { kind: 'image', data: PNG_1x1, type: 'png', width: 1, height: 1 }]]),
    };
    const entries = readZipEntries(await assembleDocx(plan, assets));
    const header = entries.get('word/header1.xml')?.toString('utf8') ?? '';
    expect(countOf(header, '<w:drawing>')).toBe(1);
  });
});
