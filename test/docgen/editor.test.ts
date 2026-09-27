// @vitest-environment jsdom

import { describe, it, expect, beforeEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { MathInline, QuestionBlock, FigureNode, OptionsNode, OptionNode, AnswerBlock, QUESTION_TABLE_EXTENSIONS } from '../../src/docgen/editor/extensions';
import { LockExtension, getLockState } from '../../src/docgen/editor/state/lockState';
import { toContractHtml, fromContractHtml, isEquivalentHtml } from '../../src/docgen/editor/serialize';

// Mock sample from A1 bank-core
const sampleWithMath = `<div class="question choice" data-qno="1">
  <p>一个质量为 <span class="math" data-tex="m"></span> 的物体从静止开始下落，重力势能转化为动能，速度达到 <span class="math" data-tex="v"></span> 时，其动能为 <span class="math" data-tex="\\frac{1}{2}mv^2"></span>。</p>
  <div class="options">
    <span>A. 正确</span>
    <span>B. 错误</span>
  </div>
  <div class="answer">
    <p>答案：A</p>
    <p>解析：根据动能公式 <span class="math" data-tex="E_k = \\frac{1}{2}mv^2"></span>。</p>
  </div>
</div>`;

const sampleWithFigure = `<div class="question" data-qno="2">
  <p>如图所示电路：</p>
  <figure class="diagram" data-align="center">
    <img class="q-figure" src="data:image/png;base64,iVBORw0KGgo=" data-w="220" data-h="120" />
    <figcaption>电路图</figcaption>
  </figure>
  <p>求电流。</p>
</div>`;

describe('Editor Contract Tests (jsdom)', () => {
  let editor: Editor;

  beforeEach(() => {
    editor = new Editor({
      extensions: [
        StarterKit.configure({
          heading: false,
          codeBlock: false,
        }),
        MathInline,
        QuestionBlock,
        FigureNode,
        OptionsNode,
        OptionNode,
        AnswerBlock,
        // 0045 返工④：QuestionBlock 白名单含 table，自建 Editor 须同步注册表格扩展
        ...QUESTION_TABLE_EXTENSIONS,
        LockExtension,
      ],
      content: '',
    });
  });

  it('契约往返：含公式题目 parse → getHTML 等价', () => {
    fromContractHtml(editor, sampleWithMath);
    const output = toContractHtml(editor);

    // Verify math nodes preserved
    expect(output).toContain('class="math"');
    expect(output).toContain('data-tex="m"');
    expect(output).toContain('data-tex="\\frac{1}{2}mv^2"');
    expect(output).toContain('data-tex="E_k = \\frac{1}{2}mv^2"');

    // Verify structure preserved
    expect(output).toContain('class="question choice"');
    expect(output).toContain('class="options"');
    expect(output).toContain('class="answer"');

    // Check no KaTeX rendering residue (should be data-tex only, no rendered HTML)
    expect(output).not.toContain('katex');
    expect(output).not.toContain('mfrac');
  });

  it('契约往返：含图题目 parse → getHTML 保留 w/h/caption', () => {
    fromContractHtml(editor, sampleWithFigure);
    const output = toContractHtml(editor);

    expect(output).toContain('class="diagram"');
    expect(output).toContain('class="q-figure"');
    expect(output).toContain('data-w="220"');
    expect(output).toContain('data-h="120"');
    expect(output).toContain('<figcaption>电路图</figcaption>');
  });

  it('mathInline: 修改 tex 后序列化正确', () => {
    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'mathInline', attrs: { tex: 'x^2', display: false } },
          ],
        },
      ],
    });

    // Update tex
    const pos = 1; // Math node position
    editor.chain().command(({ tr, state }) => {
      const node = state.doc.nodeAt(pos);
      if (node && node.type.name === 'mathInline') {
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, tex: 'y^3' });
      }
      return true;
    }).run();

    const html = toContractHtml(editor);
    expect(html).toContain('data-tex="y^3"');
    expect(html).not.toContain('x^2');
  });

  it('figureNode: w/h attrs 修改后序列化正确', () => {
    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'figureNode',
          attrs: { src: 'test.png', w: 100, h: 50, caption: 'test', align: 'center' },
        },
      ],
    });

    // Update dimensions
    const pos = 0;
    editor.chain().command(({ tr, state }) => {
      const node = state.doc.nodeAt(pos);
      if (node && node.type.name === 'figureNode') {
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, w: 300, h: 200 });
      }
      return true;
    }).run();

    const html = toContractHtml(editor);
    expect(html).toContain('data-w="300"');
    expect(html).toContain('data-h="200"');
  });

  it('questionBlock: 非法嵌套被 schema 拒绝', () => {
    // QuestionBlock content: 'block+' means it can contain block nodes
    // But it should not allow nested questionBlock (self-recursion)
    const tryNested = () => {
      editor.commands.setContent({
        type: 'doc',
        content: [
          {
            type: 'questionBlock',
            attrs: { qno: '1', qtype: 'choice' },
            content: [
              {
                type: 'questionBlock', // Nested - should fail
                attrs: { qno: '2', qtype: 'free' },
                content: [
                  { type: 'paragraph', content: [{ type: 'text', text: 'nested' }] },
                ],
              },
            ],
          },
        ],
      });
    };

    // Schema should reject nested questionBlock
    // In ProseMirror, invalid content is silently dropped or corrected
    expect(tryNested).not.toThrow(); // It won't throw, but content will be corrected

    const html = editor.getHTML();
    const json = editor.getJSON();
    // Should only have one questionBlock level, nested one should be dropped or flattened
    // Match both 'class="question"' and 'class="question choice"'
    const questionCount = (html.match(/class="question(\s|")/g) || []).length;
    expect(questionCount).toBe(1); // Only outer question should remain
  });

  it('锁定模式：锁定后文本编辑不可用', () => {
    editor.commands.setContent('<p>test content</p>');

    // Initially editable
    expect(editor.isEditable).toBe(true);

    // Lock text
    editor.commands.lockText();

    // Should no longer be editable
    expect(editor.isEditable).toBe(false);

    // Verify lock state
    const lockState = getLockState(editor);
    expect(lockState.textLocked).toBe(true);

    // Unlock
    editor.commands.unlockText();
    expect(editor.isEditable).toBe(true);
  });

  it('answerBlock: getHTML 包含完整答案内容', () => {
    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'answerBlock',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: '答案：42' }] },
            { type: 'paragraph', content: [{ type: 'text', text: '解析：根据计算' }] },
          ],
        },
      ],
    });

    const html = toContractHtml(editor);
    expect(html).toContain('class="answer"');
    expect(html).toContain('答案：42');
    expect(html).toContain('解析：根据计算');
  });

  it('options: 结构正确解析', () => {
    const optionsHtml = `<div class="options"><span>A. 选项1</span><span>B. 选项2</span></div>`;
    fromContractHtml(editor, `<div class="question"><p>题干</p>${optionsHtml}</div>`);

    const output = toContractHtml(editor);
    expect(output).toContain('class="options"');
    expect(output).toContain('A. 选项1');
    expect(output).toContain('B. 选项2');

    // Should have 2 span elements within options
    const optionsMatch = output.match(/<div class="options">(.*?)<\/div>/s);
    expect(optionsMatch).toBeTruthy();
    // Match <span> or <span class="...">
    const spanCount = (optionsMatch![1].match(/<span[\s>]/g) || []).length;
    expect(spanCount).toBe(2);
  });
});
