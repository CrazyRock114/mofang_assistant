import { Node, mergeAttributes } from '@tiptap/core';
import katex from 'katex';

// Bridge for opening math editor - injected by parent component
export const mathBridge: { open: ((params: MathEditParams) => void) | null } = { open: null };

export interface MathEditParams {
  getPos: () => number | undefined;
  tex: string;
  display: boolean;
  anchorRect: DOMRect;
  /**
   * 0045 P3（只增，可选）：插入态——工具条 ƒx 拉起，确认后在光标处插入新 mathInline；
   * 缺省 false = 编辑既有公式节点（mathBridge 现状，回写原节点）。
   */
  insertMode?: boolean;
}

export const MathInline = Node.create({
  name: 'mathInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      tex: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-tex') || '',
        renderHTML: (attrs) => ({ 'data-tex': attrs.tex }),
      },
      display: {
        default: false,
        parseHTML: (el) => el.getAttribute('data-display') === '1',
        renderHTML: (attrs) => (attrs.display ? { 'data-display': '1' } : {}),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span.math[data-tex]',
        getAttrs: (el) => {
          if (typeof el === 'string') return false;
          return {
            tex: el.getAttribute('data-tex') || '',
            display: el.getAttribute('data-display') === '1',
          };
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    // D4 修复：只输出 class 和 data-tex，不合并 HTMLAttributes（避免泄漏 tex 属性）
    const attrs: Record<string, any> = {
      class: 'math',
      'data-tex': node.attrs.tex,
    };
    if (node.attrs.display) {
      attrs['data-display'] = '1';
    }
    return ['span', attrs];
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement('span');
      dom.className = 'math-view';
      dom.setAttribute('contenteditable', 'false');
      let curTex = node.attrs.tex;
      let curDisplay = node.attrs.display;

      const render = () => {
        try {
          katex.render(curTex || '\\placeholder{}', dom, {
            displayMode: curDisplay,
            throwOnError: false,
          });
        } catch (e) {
          dom.textContent = curTex;
        }
      };
      render();

      // 2026-09-21 目检返工②（用户口径）：单击公式**不再**弹公式编辑器——单击就是正常文本编辑
      // （光标落位/选中节点）；双击公式才进编辑态。弹层入口以工具条 ƒx 为准。
      dom.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (mathBridge.open) {
          mathBridge.open({
            getPos,
            tex: curTex,
            display: curDisplay,
            anchorRect: dom.getBoundingClientRect(),
          });
        }
      });

      return {
        dom,
        update(updated) {
          if (updated.type !== node.type) return false;
          if (updated.attrs.tex !== curTex || updated.attrs.display !== curDisplay) {
            curTex = updated.attrs.tex;
            curDisplay = updated.attrs.display;
            render();
          }
          return true;
        },
        selectNode() { dom.classList.add('ProseMirror-selectednode'); },
        deselectNode() { dom.classList.remove('ProseMirror-selectednode'); },
        stopEvent(event) {
          // 仅双击在节点内时视为已消费（避免 PM 再处理）；单击放行 → PM 正常落光标/选中节点
          return event.type === 'dblclick' && dom.contains(event.target as globalThis.Node);
        },
        ignoreMutation() { return true; },
      };
    };
  },
});
