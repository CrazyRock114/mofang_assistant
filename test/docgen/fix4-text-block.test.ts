// 0004-fix-4 2.3（D-2026-09-09-04）：大标题=文本内容块——渲染探针。
// 覆盖：节标题块输出 / 不占题号（题号按题目行递增）/ 正文转义防注入 / note 样式 / 分页块单位。
// 引擎产物结构：.question-item.mf-text-item（复用顶层块机制 → 分页装箱/拖序/克隆同题行）。

import { describe, it, expect } from 'vitest';
import type { Paper, Question, PaperTextBlock } from '../../src/shared/contracts/bank-types.js';
import { buildPaperHtml } from '../../src/docgen/render/buildPaperHtml.js';
import { renderTextBlockHtml } from '../../src/docgen/render/buildPaperHtml.core.js';

const paper: Paper = {
  id: 'fix4-textblock',
  title: '文本块探针卷',
  config: {},
  createdAt: '2026-09-09T00:00:00Z',
  archived: false,
};

function makeQ(id: string, stem: string): Question {
  return {
    id,
    content: `<div class="question">${stem}</div>`,
    subject: '物理',
    sourceType: 'local',
    sourceDetail: { origin: 'test' },
    images: [],
  };
}

function bodyOf(html: string): string {
  return html.slice(html.indexOf('<body>'), html.indexOf('</body>'));
}

const textBlocks: Record<string, PaperTextBlock> = {
  'text:t1': { id: 'text:t1', text: '一、单项选择题', style: 'section' },
};

describe('fix-4 2.3 文本块渲染', () => {
  it('节标题块输出（.mf-text-item--section + 正文）', async () => {
    const body = bodyOf(
      await buildPaperHtml(paper, [makeQ('q1', '题一'), makeQ('text:t1', '占位'), makeQ('q2', '题二')], {
        mode: 'student',
        layoutConfig: { version: 2 },
        textBlocks,
      })
    );
    expect(body).toContain('class="question-item mf-text-item mf-text-item--section"');
    expect(body).toContain('一、单项选择题');
    // 文本块结构本身不含题号/分值（其它题目行的 header 不影响本断言）
    const start = body.indexOf('mf-text-item--section');
    const end = body.indexOf('question-item', start + 1);
    const textItem = body.slice(start, end > 0 ? end : start + 300);
    expect(textItem).not.toContain('question-header');
    expect(textItem).not.toContain('question-number');
  });

  it('不占题号：题号按题目行递增（1. / 2.，文本块处不出现 2.）', async () => {
    const body = bodyOf(
      await buildPaperHtml(paper, [makeQ('q1', '题一'), makeQ('text:t1', '占位'), makeQ('q2', '题二')], {
        mode: 'student',
        layoutConfig: { version: 2 },
        textBlocks,
      })
    );
    const numbers = [...body.matchAll(/class="question-number">(\d+)\.</g)].map((m) => m[1]);
    expect(numbers).toEqual(['1', '2']);
    // 文本块位于两题之间（文档序）
    expect(body.indexOf('mf-text-item')).toBeGreaterThan(body.indexOf('题一'));
    expect(body.indexOf('mf-text-item')).toBeLessThan(body.indexOf('题二'));
  });

  it('正文转义防注入 + 换行保留', () => {
    const html = renderTextBlockHtml({ id: 'text:x', text: '<script>alert(1)</script>\n第二行' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<br>第二行');
  });

  it('note 样式 → mf-text-item--note', () => {
    expect(renderTextBlockHtml({ id: 'text:n', text: '备注', style: 'note' })).toContain('mf-text-item--note');
  });

  it('分页块单位：文本块与题目行同为 .question-item 顶层块（装箱器可识别）', async () => {
    const body = bodyOf(
      await buildPaperHtml(paper, [makeQ('q1', '题一'), makeQ('text:t1', '占位')], {
        mode: 'student',
        layoutConfig: { version: 2 },
        textBlocks,
      })
    );
    expect((body.match(/class="question-item/g) ?? [])).toHaveLength(2);
  });

  it('未传 textBlocks（基线/存量路径）→ 占位题按普通题渲染（零回归）', async () => {
    const body = bodyOf(
      await buildPaperHtml(paper, [makeQ('q1', '题一')], { mode: 'student', layoutConfig: { version: 2 } })
    );
    expect(body).not.toContain('mf-text-item');
    expect(body).toContain('question-number');
  });
});
