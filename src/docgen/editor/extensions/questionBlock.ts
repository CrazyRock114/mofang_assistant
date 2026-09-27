import { Node, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

export const QuestionBlock = Node.create({
  name: 'questionBlock',
  group: 'block',
  // D3 修复：显式白名单，禁止嵌套 questionBlock
  // 0045 目检返工④（只增）：放行 table（题目内表格；@tiptap/extension-table 产物）——
  // 自建 Editor 的消费方须一并注册 QUESTION_TABLE_EXTENSIONS（extensions/index.ts），否则 schema 拒绝构建
  content: '(paragraph | blockquote | bulletList | orderedList | horizontalRule | optionsNode | figureNode | answerBlock | table)+',
  // D3 修复：isolating 防止复制粘贴时产生嵌套
  isolating: true,
  // 第六轮（用户目检②）：不再可拖拽——题面不应被拖进选项/答案区（手柄已删，此处同时封死拖拽入口）
  draggable: false,

  addAttributes() {
    return {
      qno: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-qno') || '',
        renderHTML: (attrs) => {
          // D4 修复：qno 为空时不输出 data-qno=""，避免污染
          if (attrs.qno) {
            return { 'data-qno': String(attrs.qno) };
          }
          return {};
        },
      },
      qtype: {
        default: 'choice',
        parseHTML: (el) => (el.classList.contains('choice') ? 'choice' : 'free'),
        // D4 修复：qtype 通过 class 输出，不输出裸属性
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div.question',
        getAttrs: (el) => {
          if (typeof el === 'string') return false;
          return {
            qno: el.getAttribute('data-qno') || '',
            qtype: el.classList.contains('choice') ? 'choice' : 'free',
          };
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const cls = node.attrs.qtype === 'choice' ? 'question choice' : 'question';
    const attrs: Record<string, any> = { class: cls };
    // D4 修复：qno 为空时不输出 data-qno
    if (node.attrs.qno) {
      attrs['data-qno'] = String(node.attrs.qno);
    }
    return [
      'div',
      mergeAttributes(attrs, HTMLAttributes),
      0,
    ];
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('div');
      const applyAttrs = (n: typeof node) => {
        dom.className = 'question' + (n.attrs.qtype === 'choice' ? ' choice' : '');
        dom.setAttribute('data-qno', String(n.attrs.qno));
      };
      applyAttrs(node);

      const contentDOM = document.createElement('div');
      contentDOM.className = 'q-content';
      // 第六轮（用户目检②）：删除「拖动调整题目顺序」手柄——该手柄会把题面拖进选项/答案区，
      // 对题库编辑场景无实际作用（题目顺序在题库列表侧管），故整块移除。
      dom.append(contentDOM);

      return {
        dom,
        contentDOM,
        update(updated) {
          if (updated.type !== node.type) return false;
          applyAttrs(updated);
          return true;
        },
        ignoreMutation(mutation) {
          return !contentDOM.contains(mutation.target);
        },
      };
    };
  },

  addProseMirrorPlugins() {
    // D3 修复：appendTransaction 插件，主动检测并拒绝嵌套 questionBlock
    return [
      new Plugin({
        key: new PluginKey('noNestedQuestionBlock'),
        appendTransaction(transactions, oldState, newState) {
          // 检查新文档是否有嵌套 questionBlock
          const nestedPositions: { pos: number; size: number }[] = [];

          newState.doc.descendants((node, pos) => {
            if (node.type.name === 'questionBlock') {
              // 检查此 questionBlock 内部是否有嵌套的 questionBlock
              node.descendants((child, childPos) => {
                if (child.type.name === 'questionBlock') {
                  // 记录嵌套节点的绝对位置和大小
                  nestedPositions.push({
                    pos: pos + childPos + 1,
                    size: child.nodeSize,
                  });
                }
              });
            }
          });

          // 如果发现嵌套，删除内层 questionBlock，保留其内容
          if (nestedPositions.length > 0) {
            let tr = newState.tr;

            // 从后往前处理，避免位置偏移
            for (const { pos, size } of nestedPositions.reverse()) {
              const node = tr.doc.nodeAt(pos);
              if (node && node.type.name === 'questionBlock') {
                // 提取内部内容（跳过开始和结束token）
                const content = node.content;
                // 用内容替换整个 questionBlock 节点
                tr.replaceWith(pos, pos + node.nodeSize, content);
              }
            }

            return tr;
          }

          return null;
        },
      }),
    ];
  },
});