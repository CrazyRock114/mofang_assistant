// @vitest-environment jsdom

// 0045 编辑器增强 · 编辑器核心测试（任务书 §四：直接 new TipTap Editor 先例，test/docgen/editor.test.ts 同法）。
// 覆盖：P2 行内图节点（schema/契约往返/块⇄行互转）、P4 选项增删行（标号 A 起连续、2~10 约束）、
// 契约往返保真（inlineFigure 在题干与选项内、互转后契约 HTML 稳定）。
// 禁断言降级：不使用恒真断言；尺寸/标号逐一核对。

import { describe, it, expect, beforeEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { MathInline, QuestionBlock, FigureNode, OptionsNode, OptionNode, AnswerBlock, QUESTION_TABLE_EXTENSIONS } from '../../src/docgen/editor/extensions';
import { InlineFigure } from '../../src/docgen/editor/extensions/inlineFigure';
import { LockExtension } from '../../src/docgen/editor/state/lockState';
import { toContractHtml, fromContractHtml } from '../../src/docgen/editor/serialize';
import { CONTENT_CLASSES } from '../../src/shared/contracts/question-content';

const IMG_SRC = 'data:image/png;base64,iVBORw0KGgo=';

function buildEditor(): Editor {
  return new Editor({
    extensions: [
      StarterKit.configure({ heading: false, codeBlock: false }),
      MathInline,
      QuestionBlock,
      FigureNode,
      InlineFigure,
      OptionsNode,
      OptionNode,
      AnswerBlock,
      // 0045 返工④：QuestionBlock 白名单含 table，自建 Editor 须同步注册表格扩展
      ...QUESTION_TABLE_EXTENSIONS,
      LockExtension,
    ],
    content: '',
  });
}

/** 在文档中找第 index（0 基）个指定类型节点，返回 { pos, node }；找不到抛错（不让断言静默假绿） */
function findNode(editor: Editor, typeName: string, index = 1): { pos: number; node: { attrs: Record<string, unknown>; type: { name: string } } } {
  let seen = 0;
  let found: { pos: number; node: any } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === typeName) {
      seen += 1;
      if (seen === index && !found) found = { pos, node };
    }
  });
  if (!found) throw new Error(`文档中不存在第 ${index} 个 ${typeName} 节点`);
  return found;
}

describe('0045 P2：行内图节点 inlineFigure（schema 与契约）', () => {
  let editor: Editor;

  beforeEach(() => {
    editor = buildEditor();
  });

  it('CONTENT_CLASSES 只增 inline-figure（暗契约正式化）', () => {
    expect(CONTENT_CLASSES['INLINE_FIGURE']).toBe('inline-figure');
  });

  it('题干段落内的行内图可随文字串行（inline 原子节点）', () => {
    fromContractHtml(editor, `<div class="question"><p>如图所示<span class="inline-figure"><img class="q-figure" data-w="56" data-h="20" src="${IMG_SRC}"></span>受力分析。</p></div>`);
    const html = toContractHtml(editor);
    expect(html).toContain('<span class="inline-figure"><img class="q-figure" data-w="56" data-h="20"');
    expect(html).toContain(`src="${IMG_SRC}"`);
    // 行内图在段落文本流中（不是块级 figure.diagram）
    expect(html).toContain('如图所示<span class="inline-figure"');
  });

  it('契约往返：行内图 w/h/src 保真（两轮往返稳定）', () => {
    const input = `<div class="question"><p>前文<span class="inline-figure"><img class="q-figure" data-w="339" data-h="74" src="${IMG_SRC}"></span>后文</p></div>`;
    fromContractHtml(editor, input);
    const once = toContractHtml(editor);
    expect(once).toContain('data-w="339"');
    expect(once).toContain('data-h="74"');
    fromContractHtml(editor, once);
    const twice = toContractHtml(editor);
    expect(twice).toContain('data-w="339"');
    expect(twice).toContain('data-h="74"');
    expect(twice).toContain(`src="${IMG_SRC}"`);
  });

  it('块级 figureNode ⇄ 行内 inlineFigure 互转保尺寸（命令级）', () => {
    editor.commands.setContent({
      type: 'doc',
      content: [
        { type: 'figureNode', attrs: { src: IMG_SRC, w: 220, h: 120, caption: '', align: 'center' } },
      ],
    });
    const block = findNode(editor, 'figureNode');
    editor.commands.figureNodeToInline(block.pos);

    const inline = findNode(editor, 'inlineFigure');
    expect(inline.node.attrs['w']).toBe(220);
    expect(inline.node.attrs['h']).toBe(120);
    expect(inline.node.attrs['src']).toBe(IMG_SRC);

    editor.commands.inlineFigureToBlock(inline.pos);
    const back = findNode(editor, 'figureNode');
    expect(back.node.attrs['w']).toBe(220);
    expect(back.node.attrs['h']).toBe(120);
  });

  it('块⇄行互转后契约 HTML 稳定（宽高属性在契约位置）', () => {
    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'questionBlock',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: '题干' }] },
            { type: 'figureNode', attrs: { src: IMG_SRC, w: 300, h: 200, caption: '', align: 'center' } },
          ],
        },
      ],
    });
    const block = findNode(editor, 'figureNode');
    editor.commands.figureNodeToInline(block.pos);
    const inlineHtml = toContractHtml(editor);
    expect(inlineHtml).toContain('<span class="inline-figure"><img class="q-figure" data-w="300" data-h="200"');

    const inline = findNode(editor, 'inlineFigure');
    editor.commands.inlineFigureToBlock(inline.pos);
    const blockHtml = toContractHtml(editor);
    expect(blockHtml).toContain('<figure class="diagram"');
    expect(blockHtml).toContain('data-w="300"');
    expect(blockHtml).toContain('data-h="200"');
  });
});

describe('0045 P4：选项增删行（OptionsNode/OptionNode）', () => {
  let editor: Editor;

  beforeEach(() => {
    editor = buildEditor();
  });

  function setFourOptions(): void {
    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'questionBlock',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: '题干' }] },
            {
              type: 'optionsNode',
              content: (['A', 'B', 'C', 'D'] as const).map((label) => ({
                type: 'optionNode',
                content: [{ type: 'text', text: `${label}. 选项${label}` }],
              })),
            },
          ],
        },
      ],
    });
  }

  function optionTexts(): string[] {
    const out: string[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'optionNode') out.push(node.textContent);
    });
    return out;
  }

  it('addOption：在 D 后追加 E 且落在 optionsNode 区块内，标号自动连续', () => {
    setFourOptions();
    const options = findNode(editor, 'optionsNode');
    // 光标放进最后一个选项内（addOption 按 selection 所在 optionsNode 工作）
    editor.commands.setTextSelection(options.pos + 2);
    expect(editor.commands.addOption()).toBe(true);
    const texts = optionTexts();
    expect(texts).toHaveLength(5);
    expect(texts[4]).toBe('E. ');
    // 结构级：新行必须落在 <div class="options"> 区块内（掉到区块外视同失败）
    const html = toContractHtml(editor);
    const block = /<div class="options">([\s\S]*?)<\/div>/.exec(html);
    expect(block).toBeTruthy();
    expect((block![1]!.match(/<span/g) || []).length).toBe(5);
  });

  it('removeOptionAt：删中间项后标号自动重排（A 起连续，内容保留）', () => {
    setFourOptions();
    const second = findNode(editor, 'optionNode', 2); // B
    expect(editor.commands.removeOptionAt(second.pos)).toBe(true);
    // C→B、D→C 递补（设计稿视图四：删行后标号自动 A 起连续），内容不动
    const texts = optionTexts();
    expect(texts).toEqual(['A. 选项A', 'B. 选项C', 'C. 选项D']);
  });

  it('下限 2：只剩 2 项时删除被拒绝', () => {
    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'optionsNode',
          content: [
            { type: 'optionNode', content: [{ type: 'text', text: 'A. 对' }] },
            { type: 'optionNode', content: [{ type: 'text', text: 'B. 错' }] },
          ],
        },
      ],
    });
    const first = findNode(editor, 'optionNode', 1);
    expect(editor.commands.removeOptionAt(first.pos)).toBe(false);
    expect(optionTexts()).toEqual(['A. 对', 'B. 错']);
  });

  it('上限 10：加到 10 项后再加被拒绝（与引擎 MAX_OPTIONS 一致）', () => {
    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'optionsNode',
          content: Array.from({ length: 10 }, (_, i) => ({
            type: 'optionNode',
            content: [{ type: 'text', text: `${String.fromCharCode(65 + i)}. 项${i}` }],
          })),
        },
      ],
    });
    const options = findNode(editor, 'optionsNode');
    editor.commands.setTextSelection(options.pos + 2);
    expect(editor.commands.addOption()).toBe(false);
    expect(optionTexts()).toHaveLength(10);
  });

  it('选项内可放行内图（inline* 天然允许 + 契约往返）', () => {
    fromContractHtml(editor, `<div class="question"><p>题干</p><div class="options"><span class="option">A. 文本</span><span class="option">B. <span class="inline-figure"><img class="q-figure" data-w="48" data-h="18" src="${IMG_SRC}"></span> 如图</span></div></div>`);
    const html = toContractHtml(editor);
    expect(html).toContain('<span class="option">B. <span class="inline-figure"><img class="q-figure" data-w="48" data-h="18"');
    // 二次往返稳定
    fromContractHtml(editor, html);
    expect(toContractHtml(editor)).toContain('data-w="48" data-h="18"');
  });
});
