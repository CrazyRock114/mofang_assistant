// @vitest-environment jsdom

import { describe, it, expect, beforeEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { MathInline, QuestionBlock, FigureNode, OptionsNode, OptionNode, AnswerBlock, QUESTION_TABLE_EXTENSIONS } from '../../src/docgen/editor/extensions';
import { LockExtension, getLockState } from '../../src/docgen/editor/state/lockState';
import { toContractHtml, fromContractHtml } from '../../src/docgen/editor/serialize';

// A1 mock 真实样本（来自 src/bank/mock/mock-bank.ts）
const mockSamples = {
  q1: '<div class="question">一个质量为 m 的物体从高度 h 处自由落体，落地时速度为多少？已知重力加速度为 g，动能公式为 <span class="math" data-tex="E_k = \\frac{1}{2}mv^2"></span>。</div>',
  q2: '<div class="question">下列关于牛顿第二定律 <span class="math" data-tex="F = ma"></span> 的说法，正确的是？<div class="options"><span class="option">A. 力是产生加速度的原因</span><span class="option">B. 加速度与力成反比</span></div></div>',
  q3: '<div class="question">如图所示电路中，测量电阻 R 的阻值。<figure class="diagram" data-align="center" data-w="300" data-h="200"><img src="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'300\' height=\'200\'%3E%3Crect width=\'300\' height=\'200\' fill=\'%23f0f0f0\'/%3E%3Ctext x=\'150\' y=\'100\' text-anchor=\'middle\' font-size=\'16\' fill=\'%23333\'%3E电路图占位%3C/text%3E%3C/svg%3E" alt="电路图"></figure>根据欧姆定律 <span class="math" data-tex="R = \\frac{U}{I}"></span> 计算电阻。</div>',
  q4: '<div class="question">证明：在匀速圆周运动中，向心加速度 <span class="math" data-tex="a_c = \\frac{v^2}{r}"></span>。</div>',
  q5: '<div class="question">光在真空中的传播速度约为 _____ m/s。（填数字）</div>',
};

describe('契约往返回归测试（B0-fix）', () => {
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

  describe('R1 全量往返', () => {
    it('q1: 公式保真', () => {
      fromContractHtml(editor, mockSamples.q1);
      const output = toContractHtml(editor);

      // data-tex 值逐一保真
      expect(output).toContain('data-tex="E_k = \\frac{1}{2}mv^2"');

      // 不含裸属性泄漏（D4 回归断言）
      // 注意：要排除 data-tex 中的 tex，只检测裸的 ' tex="'
      expect(output).not.toMatch(/\s+tex="/);
    });

    it('q2: 公式保真 + 选项结构', () => {
      fromContractHtml(editor, mockSamples.q2);
      const output = toContractHtml(editor);

      // data-tex 值保真
      expect(output).toContain('data-tex="F = ma"');

      // 不含裸属性泄漏
      expect(output).not.toMatch(/\s+tex="/);
      expect(output).not.toMatch(/\s+qno="/);
      expect(output).not.toMatch(/\s+qtype="/);
    });

    it('q3: 公式保真 + 图片', () => {
      fromContractHtml(editor, mockSamples.q3);
      const output = toContractHtml(editor);

      // data-tex 值保真
      expect(output).toContain('data-tex="R = \\frac{U}{I}"');

      // 不含裸属性泄漏
      expect(output).not.toMatch(/\s+tex="/);
    });

    it('q4: 公式保真', () => {
      fromContractHtml(editor, mockSamples.q4);
      const output = toContractHtml(editor);

      // data-tex 值保真
      expect(output).toContain('data-tex="a_c = \\frac{v^2}{r}"');

      // 不含裸属性泄漏
      expect(output).not.toMatch(/\s+tex="/);
    });

    it('q5: 纯文本题保真', () => {
      fromContractHtml(editor, mockSamples.q5);
      const output = toContractHtml(editor);

      // 文本保真
      expect(output).toContain('光在真空中的传播速度约为 _____ m/s');

      // 不含裸属性泄漏
      expect(output).not.toMatch(/\s+qno="/);
      expect(output).not.toMatch(/\s+qtype="/);
    });
  });

  describe('R2 选项契约', () => {
    it('q2 往返后 class="option" 保真', () => {
      fromContractHtml(editor, mockSamples.q2);
      const output = toContractHtml(editor);

      // class="option" 保真（D1 缺陷回归）
      expect(output).toContain('class="option"');

      // options 容器结构不变
      expect(output).toContain('class="options"');

      // 两个选项都带 class="option"
      const optionMatches = output.match(/class="option"/g);
      expect(optionMatches).toBeTruthy();
      expect(optionMatches!.length).toBe(2);
    });
  });

  describe('R3 图片契约', () => {
    it('q3 往返后 figure 上 data-w/h/align 保真', () => {
      fromContractHtml(editor, mockSamples.q3);
      const output = toContractHtml(editor);

      // data-w/h 保真在 figure 上（D2 缺陷回归：不许 220×120 默认值篡改）
      expect(output).toContain('data-w="300"');
      expect(output).toContain('data-h="200"');

      // data-align 保真
      expect(output).toContain('data-align="center"');

      // 不含裸属性泄漏（D4）
      // figure 上不应有裸 src/w/h/caption/align（注意：img 上的 src 是允许的）
      expect(output).not.toMatch(/<figure[^>]+\s+src=/);
      expect(output).not.toMatch(/\s+w="/);
      expect(output).not.toMatch(/\s+h="/);
      expect(output).not.toMatch(/\s+caption="/);
      expect(output).not.toMatch(/\s+align="/);
    });
  });

  describe('R4 嵌套拒绝', () => {
    it('setContent 嵌套 questionBlock 被拒绝，JSON 计数 = 1', () => {
      editor.commands.setContent({
        type: 'doc',
        content: [
          {
            type: 'questionBlock',
            attrs: { qno: '1', qtype: 'choice' },
            content: [
              {
                type: 'questionBlock', // 嵌套 - 应被 schema 拒绝
                attrs: { qno: '2', qtype: 'free' },
                content: [
                  { type: 'paragraph', content: [{ type: 'text', text: 'nested' }] },
                ],
              },
            ],
          },
        ],
      });

      // 用 JSON 计数 questionBlock 节点（禁止正则 HTML，B0 假阳性教训）
      const json = editor.getJSON();
      const countQuestionBlocks = (node: any): number => {
        let count = 0;
        if (node.type === 'questionBlock') count++;
        if (node.content) {
          for (const child of node.content) {
            count += countQuestionBlocks(child);
          }
        }
        return count;
      };

      const total = countQuestionBlocks(json);
      expect(total).toBe(1); // D3 缺陷回归：嵌套必须在 schema 层被拒绝
    });

    it('fromContractHtml 解析嵌套 HTML 不得产生嵌套', () => {
      const nestedHtml = '<div class="question"><p>外层</p><div class="question"><p>内层嵌套</p></div></div>';
      fromContractHtml(editor, nestedHtml);

      const json = editor.getJSON();
      const countQuestionBlocks = (node: any): number => {
        let count = 0;
        if (node.type === 'questionBlock') count++;
        if (node.content) {
          for (const child of node.content) {
            count += countQuestionBlocks(child);
          }
        }
        return count;
      };

      const total = countQuestionBlocks(json);
      // 嵌套 HTML 解析后应被打平，不产生真嵌套
      expect(total).toBeGreaterThanOrEqual(1);

      // 深度检查：每个 questionBlock 内部不应含 questionBlock
      const checkNoNestedQuestion = (node: any, insideQuestion: boolean): boolean => {
        if (node.type === 'questionBlock') {
          if (insideQuestion) return false; // 发现嵌套，失败
          insideQuestion = true;
        }
        if (node.content) {
          for (const child of node.content) {
            if (!checkNoNestedQuestion(child, insideQuestion)) return false;
          }
        }
        return true;
      };

      expect(checkNoNestedQuestion(json, false)).toBe(true);
    });
  });

  describe('R5 双往返幂等', () => {
    it('q1 双往返幂等', () => {
      fromContractHtml(editor, mockSamples.q1);
      const output1 = toContractHtml(editor);

      fromContractHtml(editor, output1);
      const output2 = toContractHtml(editor);

      expect(output1).toBe(output2);
    });

    it('q2 双往返幂等', () => {
      fromContractHtml(editor, mockSamples.q2);
      const output1 = toContractHtml(editor);

      fromContractHtml(editor, output1);
      const output2 = toContractHtml(editor);

      expect(output1).toBe(output2);
    });

    it('q3 双往返幂等', () => {
      fromContractHtml(editor, mockSamples.q3);
      const output1 = toContractHtml(editor);

      fromContractHtml(editor, output1);
      const output2 = toContractHtml(editor);

      expect(output1).toBe(output2);
    });
  });

  describe('R6 位置锁 enforcement', () => {
    it('positionLocked 状态下 dragstart 被阻止', () => {
      editor.commands.setContent('<p>test content</p>');

      // 锁定位置
      editor.commands.lockPosition();

      const lockState = getLockState(editor);
      expect(lockState.positionLocked).toBe(true);

      // 构造 dragstart 事件
      const event = new Event('dragstart', { bubbles: true, cancelable: true });

      // 触发事件（通过编辑器 DOM）
      editor.view.dom.dispatchEvent(event);

      // 断言事件被阻止（D6：enforcement 实现回归）
      expect(event.defaultPrevented).toBe(true);
    });

    it('未锁定时 dragstart 不被阻止', () => {
      editor.commands.setContent('<p>test content</p>');

      // 未锁定
      const lockState = getLockState(editor);
      expect(lockState.positionLocked).toBe(false);

      // 构造 dragstart 事件
      const event = new Event('dragstart', { bubbles: true, cancelable: true });

      // 触发事件
      editor.view.dom.dispatchEvent(event);

      // 断言事件未被阻止
      expect(event.defaultPrevented).toBe(false);
    });
  });
});
