// 0050 P4：题内表格 → Word 真表格（w:tbl）。
//
// 链路三段各自断言：
//   ① content-subset：契约 <table> → 结构化行/格（表头标记、合并跨度、格内行内件、容错）
//   ② plan：表格块流入计划 + 格内公式/图进栅格与读盘全集
//   ③ assemble：真 `<w:tbl>`（行数/格数/表头加粗浅底/实线边框/列宽均分/格内图件不丢）
// 背景：0035 起表格属「清单外降级」（纯文本化，只在文字层保证不错位）；0050 起表格进契约清单—
// 题卡/出纸/Word 三侧同源渲染（R-037 第①步：先渲染；编辑态由 0045 的 TipTap 表格承担）。

import { describe, it, expect } from 'vitest';
import type { Paper, Question } from '../../src/shared/contracts/bank-types.js';
import { parseContentSubset, type TableCellEntry } from '../../src/docgen/export/docx/content-subset.js';
import { buildDocxPlan, type DocxPlan, type PlannedQuestion } from '../../src/docgen/export/docx/plan.js';
import { assembleDocx, type DocxAssets } from '../../src/docgen/export/docx/assemble.js';
import { mapLayout } from '../../src/docgen/export/docx/layout-map.js';
import { resolveLayout } from '../../src/docgen/render/layout.js';
import { documentXml, countOf } from './helpers/zip-read.js';

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
);

const textOf = (cell: TableCellEntry): string =>
  cell.items.filter((i) => i.kind === 'text').map((i) => i.value).join('');

/** 识别链产出形态（0050 P1）：表头 + 表体 + 格内公式/行内图 */
const TABLE_HTML =
  '<div class="question"><p>下表为实验数据：</p>'
  + '<table><thead><tr><th>物理量</th><th>数值</th></tr></thead><tbody>'
  + '<tr><td>速度 <span class="math" data-tex="v=\\frac{s}{t}"></span></td><td>1</td></tr>'
  + '<tr><td>图示 <span class="inline-figure"><img class="q-figure" data-w="22" data-h="39" src="data-assets/capture/zujuan/2.svg"></span></td>'
  + '<td>2</td></tr>'
  + '</tbody></table><p>结论：成正比。</p></div>';

function makeQuestion(over: Partial<Question> = {}): Question {
  return {
    id: 'q1',
    subject: '物理',
    sourceType: 'local',
    sourceDetail: {},
    content: TABLE_HTML,
    images: [],
    createdAt: '2026-09-22T00:00:00Z',
    updatedAt: '2026-09-22T00:00:00Z',
    ...over,
  };
}

function makePaper(over: Partial<Paper> = {}): Paper {
  return { id: 'p1', title: '0050 表格卷', config: {}, createdAt: '2026-09-22T00:00:00Z', archived: false, ...over };
}

function emptyAssets(): DocxAssets {
  return { math: new Map(), assets: new Map() };
}

function makePlan(over: Partial<DocxPlan> = {}): DocxPlan {
  return {
    mode: 'student',
    title: '0050 表格卷',
    page: mapLayout(resolveLayout(undefined)),
    headerLines: [],
    logos: [],
    questions: [],
    mathItems: [],
    imageSrcs: [],
    imageHints: {},
    degradations: [],
    ...over,
  };
}

function makePlannedQuestion(over: Partial<PlannedQuestion> = {}): PlannedQuestion {
  return { kind: 'question', id: 'q1', no: 1, showNo: true, showScore: false, blocks: [], sideFigures: [], ...over };
}

const tableCells = (a: string, b: string, header = false): TableCellEntry[] => [
  { items: [{ kind: 'text', value: a, format: {} }], header, colspan: 1, rowspan: 1 },
  { items: [{ kind: 'text', value: b, format: {} }], header, colspan: 1, rowspan: 1 },
];

describe('0050 P4 ①content-subset：契约表格 → 结构化行/格', () => {
  it('thead/th 标表头，表体格为非表头；行列数与文本逐格对应', () => {
    const { blocks, degradations } = parseContentSubset(
      '<div class="question"><table><thead><tr><th>甲</th><th>乙</th></tr></thead>'
      + '<tbody><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></tbody></table></div>'
    );
    const table = blocks.find((b) => b.kind === 'table');
    expect(table).toBeDefined();
    if (table?.kind !== 'table') throw new Error('无表格块');
    expect(table.rows).toHaveLength(3);
    expect(table.rows.map((r) => r.length)).toEqual([2, 2, 2]);
    expect(table.rows[0].map((c) => c.header)).toEqual([true, true]);
    expect(table.rows[1].map((c) => c.header)).toEqual([false, false]);
    expect(table.rows.map((r) => r.map(textOf))).toEqual([['甲', '乙'], ['1', '2'], ['3', '4']]);
    // 表格已入契约清单：不再计降级（不静默吞的纪律由「内容逐格在案」承担）
    expect(degradations).toEqual([]);
  });

  it('表体 <th> 与 thead 外的 <th> 同样标表头；colspan/rowspan 带过', () => {
    const { blocks } = parseContentSubset(
      '<div class="question"><table><tbody>'
      + '<tr><th colspan="2">合并表头</th></tr>'
      + '<tr><td rowspan="2">甲</td><td>1</td></tr>'
      + '</tbody></table></div>'
    );
    const table = blocks.find((b) => b.kind === 'table');
    if (table?.kind !== 'table') throw new Error('无表格块');
    expect(table.rows[0][0]).toMatchObject({ header: true, colspan: 2, rowspan: 1 });
    expect(table.rows[1][0]).toMatchObject({ header: false, colspan: 1, rowspan: 2 });
  });

  it('格内行内件照常：公式项 + 行内图项（含 data-w/h）；<p> 包裹不残留空换行项', () => {
    const { blocks } = parseContentSubset(TABLE_HTML);
    const table = blocks.find((b) => b.kind === 'table');
    if (table?.kind !== 'table') throw new Error('无表格块');
    const mathCell = table.rows[1][0];
    expect(mathCell.items.some((i) => i.kind === 'math' && i.value === 'v=\\frac{s}{t}')).toBe(true);
    const imageCell = table.rows[2][0];
    const image = imageCell.items.find((i) => i.kind === 'image');
    expect(image).toMatchObject({ value: 'data-assets/capture/zujuan/2.svg', widthPx: 22, heightPx: 39 });
    // 格内首尾硬换行被收敛（<p> 包裹只作段边界）
    for (const row of table.rows) {
      for (const cell of row) {
        expect(cell.items[0]?.kind).not.toBe('break');
        expect(cell.items[cell.items.length - 1]?.kind).not.toBe('break');
      }
    }
  });

  it('表前后段落原位保留（表格不吞题干、不粘连后续正文）', () => {
    const { blocks } = parseContentSubset(TABLE_HTML);
    const kinds = blocks.map((b) => b.kind);
    expect(kinds).toEqual(['paragraph', 'table', 'paragraph']);
    const first = blocks[0];
    const last = blocks[2];
    if (first.kind !== 'paragraph' || last.kind !== 'paragraph') throw new Error('段落缺失');
    expect(textOf({ items: first.items, header: false, colspan: 1, rowspan: 1 })).toContain('下表为实验数据');
    expect(textOf({ items: last.items, header: false, colspan: 1, rowspan: 1 })).toBe('结论：成正比。');
  });

  it('无 tr 的坏表回落既有容错：断段 + 记账，前后正文各自成段', () => {
    const { blocks, degradations } = parseContentSubset(
      '<div class="question"><p>前文</p><table></table><p>后文</p></div>'
    );
    expect(blocks.some((b) => b.kind === 'table')).toBe(false);
    expect(degradations.map((d) => d.tag)).toContain('table');
    const joined = blocks.filter((b) => b.kind === 'paragraph').map((b) => b.items.map((i) => i.value).join(''));
    expect(joined).toContain('前文');
    expect(joined).toContain('后文');
  });

  it('格内嵌套表 → 内层按清单外降级（不递归成表块）', () => {
    const { blocks, degradations } = parseContentSubset(
      '<div class="question"><table><tbody><tr><td>甲<table><tr><td>内</td></tr></table></td></tr></tbody></table></div>'
    );
    const tables = blocks.filter((b) => b.kind === 'table');
    expect(tables).toHaveLength(1);
    if (tables[0].kind !== 'table') throw new Error('无表格块');
    expect(textOf(tables[0].rows[0][0])).toContain('甲');
    expect(degradations.map((d) => d.tag)).toContain('table');
  });

  it('表外游离的 tr/td（脏数据）仍按清单外降级（零回归）', () => {
    const { degradations } = parseContentSubset('<div class="question"><tr><td>甲</td></tr></div>');
    const tags = degradations.map((d) => d.tag);
    expect(tags).toContain('tr');
    expect(tags).toContain('td');
  });
});

describe('0050 P4 ②plan：表格块流入计划 + 格内资源入全集', () => {
  it('表格块进 plan，格内公式进栅格全集、行内图进读盘全集，零降级', () => {
    const plan = buildDocxPlan(makePaper(), [makeQuestion()], { mode: 'student' });
    const block = plan.questions[0].blocks.find((b) => b.kind === 'table');
    expect(block).toBeDefined();
    if (block?.kind !== 'table') throw new Error('计划无表格块');
    expect(block.rows).toHaveLength(3);
    expect(plan.mathItems.some((m) => m.tex === 'v=\\frac{s}{t}')).toBe(true);
    expect(plan.imageSrcs).toContain('data-assets/capture/zujuan/2.svg');
    expect(plan.degradations).toEqual([]);
  });
});

describe('0050 P4 ③assemble：真 w:tbl', () => {
  it('2×2 表（表头 + 表体）→ 1 表 2 行 4 格；表头加粗浅底、实线边框、列宽均分 50%', async () => {
    const plan = makePlan({
      questions: [makePlannedQuestion({
        blocks: [
          { kind: 'paragraph', items: [{ kind: 'text', value: '下表：', format: {} }] },
          { kind: 'table', rows: [tableCells('物理量', '数值', true), tableCells('甲', '1')] },
        ],
      })],
    });
    const buf = await assembleDocx(plan, emptyAssets());
    const xml = documentXml(buf);
    expect(countOf(xml, '<w:tbl>')).toBe(1);
    expect(countOf(xml, '<w:tr>')).toBe(2);
    expect(countOf(xml, '<w:tc>')).toBe(4);
    expect(countOf(xml, '<w:tblBorders>')).toBe(1);
    // 表内加粗只落在表头（表体两格无加粗；题号段的加粗不计入表内）
    const tableXml = xml.slice(xml.indexOf('<w:tbl>'), xml.indexOf('</w:tbl>'));
    expect(countOf(tableXml, '<w:b/>')).toBe(2);
    // 表头格浅底
    expect(countOf(tableXml, 'w:fill="F2F2F2"')).toBe(2);
    // 列宽均分（2 列 → 各 50%）
    expect(countOf(xml, 'w:w="50%"')).toBeGreaterThanOrEqual(2);
    // 表在题号段之后、正文之前（顺序：题头段 → 表格 → 空段收尾）
    expect(xml.indexOf('下表：')).toBeLessThan(xml.indexOf('<w:tbl>'));
  });

  it('3 列表格列宽均分 33%，格内容不丢', async () => {
    const plan = makePlan({
      questions: [makePlannedQuestion({
        blocks: [{
          kind: 'table',
          rows: [
            [
              { items: [{ kind: 'text', value: '甲', format: {} }], header: true, colspan: 1, rowspan: 1 },
              { items: [{ kind: 'text', value: '乙', format: {} }], header: true, colspan: 1, rowspan: 1 },
              { items: [{ kind: 'text', value: '丙', format: {} }], header: true, colspan: 1, rowspan: 1 },
            ],
            [
              { items: [{ kind: 'text', value: '1', format: {} }], header: false, colspan: 1, rowspan: 1 },
              { items: [{ kind: 'text', value: '2', format: {} }], header: false, colspan: 1, rowspan: 1 },
              { items: [{ kind: 'text', value: '3', format: {} }], header: false, colspan: 1, rowspan: 1 },
            ],
          ],
        }],
      })],
    });
    const xml = documentXml(await assembleDocx(plan, emptyAssets()));
    expect(countOf(xml, '<w:tc>')).toBe(6);
    expect(countOf(xml, 'w:w="33%"')).toBeGreaterThanOrEqual(6);
    for (const value of ['甲', '乙', '丙', '1', '2', '3']) expect(xml).toContain(value);
  });

  it('格内行内图 → 格内 drawing（图件不丢）；无 data-w 时按列宽摊分限宽（不按整幅版心出图）', async () => {
    const plan = makePlan({
      questions: [makePlannedQuestion({
        blocks: [{
          kind: 'table',
          rows: [[
            { items: [{ kind: 'text', value: '图', format: {} }], header: false, colspan: 1, rowspan: 1 },
            { items: [{ kind: 'image', value: 'data-assets/capture/big.png', format: {}, alt: '' }], header: false, colspan: 1, rowspan: 1 },
          ]],
        }],
      })],
    });
    const assets: DocxAssets = {
      math: new Map(),
      assets: new Map([
        ['data-assets/capture/big.png', { kind: 'image', data: PNG_1x1, type: 'png', width: 2000, height: 1000 }],
      ]),
    };
    const xml = documentXml(await assembleDocx(plan, assets));
    expect(countOf(xml, '<w:drawing>')).toBe(1);
    // 2 列 → 格宽 = 版心宽 / 2；无标注图按「格宽 60%」封顶（而非整幅版心 60%）
    const cellWidth = Math.max(1, Math.floor(plan.page.columnWidthPx / 2));
    const expected = Math.max(1, Math.round(cellWidth * 0.6));
    expect(xml).toContain(`cx="${expected * 9525}"`);
  });

  it('格内公式 → 格内公式图（复用既有栅格管线，含基线校正）', async () => {
    const plan = makePlan({
      questions: [makePlannedQuestion({
        blocks: [{
          kind: 'table',
          rows: [[
            { items: [{ kind: 'math', value: 'v=\\frac{s}{t}', format: {}, display: false }], header: false, colspan: 1, rowspan: 1 },
          ]],
        }],
      })],
    });
    const assets: DocxAssets = {
      math: new Map([
        [`inline:${plan.page.baseFontPx}:v=\\frac{s}{t}`, { png: PNG_1x1, widthPx: 60, heightPx: 20, depthPx: 4 }],
      ]),
      assets: new Map(),
    };
    const xml = documentXml(await assembleDocx(plan, assets));
    expect(countOf(xml, '<w:drawing>')).toBe(1);
    expect(xml).toContain('<w:position w:val="-6"/>');
  });

  it('空单元格产出空段（不塌表）；表头空格同样加粗', async () => {
    const plan = makePlan({
      questions: [makePlannedQuestion({
        blocks: [{
          kind: 'table',
          rows: [
            [
              { items: [], header: true, colspan: 1, rowspan: 1 },
              { items: [{ kind: 'text', value: '乙', format: {} }], header: true, colspan: 1, rowspan: 1 },
            ],
            [
              { items: [], header: false, colspan: 1, rowspan: 1 },
              { items: [{ kind: 'text', value: '2', format: {} }], header: false, colspan: 1, rowspan: 1 },
            ],
          ],
        }],
      })],
    });
    const xml = documentXml(await assembleDocx(plan, emptyAssets()));
    expect(countOf(xml, '<w:tc>')).toBe(4);
    // 每格都有段落元素（空格落空段 `<w:p/>`——不塌表）
    const tableXml = xml.slice(xml.indexOf('<w:tbl>'), xml.indexOf('</w:tbl>'));
    expect((tableXml.match(/<w:p\b/g) ?? []).length).toBe(4);
    const tableRows = tableXml.split('<w:tr>').slice(1);
    expect(tableRows).toHaveLength(2);
    for (const row of tableRows) {
      expect((row.match(/<w:p\b/g) ?? []).length).toBe(2);
    }
  });
});
