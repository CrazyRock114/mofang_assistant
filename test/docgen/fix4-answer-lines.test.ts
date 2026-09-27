// 0004-fix-4 #6（目检 #6）：题级作答区「行数」化——契约只增 lines，引擎换算 = 行数 × 行高。
// 行高常量 = config 字号 pt × 行距（缺省 1.8）× pt→mm（0.3528）；lines 优先于 heightMm（兼容存量覆盖）。
// 卷级 config.answerSpace 字段保留（存量数据/预设兼容），但 UI 不再暴露（全局控件组已删）。

import { describe, it, expect } from 'vitest';
import type { Paper, Question } from '../../src/shared/contracts/bank-types.js';
import { buildPaperHtml } from '../../src/docgen/render/buildPaperHtml.js';
import { answerSpaceLineHeightMm, PT_TO_MM, resolveLayout } from '../../src/docgen/render/layout.js';

const paper: Paper = {
  id: 'fix4-lines',
  title: '作答区行数探针卷',
  config: {},
  createdAt: '2026-09-09T00:00:00Z',
  archived: false,
};

function makeQ(id: string): Question {
  return {
    id,
    content: `<div class="question">题 ${id}</div>`,
    subject: '物理',
    sourceType: 'local',
    sourceDetail: { origin: 'test' },
    images: [],
  };
}

function bodyOf(html: string): string {
  return html.slice(html.indexOf('<body>'), html.indexOf('</body>'));
}

describe('fix-4 #6 行高换算常量', () => {
  it('PT_TO_MM = 25.4/72；行高 = 字号 × 行距（缺省 1.8）× pt→mm', () => {
    expect(PT_TO_MM).toBeCloseTo(0.35278, 4);
    // 12pt × 1.8 × 0.3528 = 7.62mm（基线字号/行距）
    expect(answerSpaceLineHeightMm(resolveLayout({ version: 2 }))).toBe(7.62);
    // 14pt × 1.5 × 0.3528 = 7.41mm
    expect(answerSpaceLineHeightMm(resolveLayout({ version: 2, fontSize: 14, lineHeight: 1.5 }))).toBe(7.41);
  });
});

describe('fix-4 #6 题级 lines → 高度 mm', () => {
  it('lines=3 → height 22.86mm（3 × 7.62）；样式随题级 style', async () => {
    const q = makeQ('q-lines3');
    const html = await buildPaperHtml(paper, [q], {
      mode: 'student',
      layoutConfig: { version: 2 },
      questionLayouts: { [q.id]: { answerSpace: { style: 'lines', lines: 3 } } },
    });
    expect(bodyOf(html)).toContain('answer-space--lines');
    expect(bodyOf(html)).toContain('height: 22.86mm');
  });

  it('lines=0 = 该题不留作答区（不插 .answer-space）', async () => {
    const q = makeQ('q-lines0');
    const html = await buildPaperHtml(paper, [q], {
      mode: 'student',
      layoutConfig: { version: 2, answerSpace: { enabled: true, style: 'blank', heightMm: 20 } },
      questionLayouts: { [q.id]: { answerSpace: { style: 'blank', lines: 0 } } },
    });
    expect(bodyOf(html)).not.toContain('<div class="answer-space');
  });

  it('lines 优先于 heightMm（存量覆盖字段并存时以行数为准）', async () => {
    const q = makeQ('q-priority');
    const html = await buildPaperHtml(paper, [q], {
      mode: 'student',
      layoutConfig: { version: 2 },
      questionLayouts: { [q.id]: { answerSpace: { style: 'blank', lines: 2, heightMm: 99 } } },
    });
    expect(bodyOf(html)).toContain('answer-space--blank');
    expect(bodyOf(html)).toContain('height: 15.24mm'); // 2 × 7.62
    expect(bodyOf(html)).not.toContain('99mm');
  });

  it('无 lines 的存量覆盖沿用 heightMm 语义（回落卷级）', async () => {
    const q = makeQ('q-legacy');
    const html = await buildPaperHtml(paper, [q], {
      mode: 'student',
      layoutConfig: { version: 2, answerSpace: { enabled: true, style: 'lines', heightMm: 30 } },
      questionLayouts: { [q.id]: { answerSpace: { style: 'blank' } } },
    });
    expect(bodyOf(html)).toContain('answer-space--blank');
    expect(bodyOf(html)).toContain('height: 30mm');
  });

  it('卷级关闭 + 题级 lines：仅该题插 + CSS 规则补注入', async () => {
    const q1 = makeQ('q-a');
    const q2 = makeQ('q-b');
    const html = await buildPaperHtml(paper, [q1, q2], {
      mode: 'student',
      layoutConfig: { version: 2 },
      questionLayouts: { [q1.id]: { answerSpace: { style: 'lines', lines: 2 } } },
    });
    const body = bodyOf(html);
    expect((body.match(/class="answer-space /g) ?? [])).toHaveLength(1);
    expect(body).toContain('answer-space--lines');
    expect(html).toContain('.answer-space--lines');
  });

  it('行数随字号/行距联动（14pt × 1.5 → 行高 7.41mm；lines=2 → 14.82mm）', async () => {
    const q = makeQ('q-font');
    const html = await buildPaperHtml(paper, [q], {
      mode: 'student',
      layoutConfig: { version: 2, fontSize: 14, lineHeight: 1.5 },
      questionLayouts: { [q.id]: { answerSpace: { style: 'lines', lines: 2 } } },
    });
    expect(bodyOf(html)).toContain('height: 14.82mm');
  });
});
