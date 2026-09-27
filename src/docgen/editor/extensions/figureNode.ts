import { Node, mergeAttributes } from '@tiptap/core';
import { createFigureBar } from './figureBar';

export const FigureNode = Node.create({
  name: 'figureNode',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      src: {
        default: '',
        parseHTML: (el) => {
          const img = el.querySelector('img');
          return img ? img.getAttribute('src') || '' : '';
        },
        renderHTML: () => ({}), // D4: src 只在 img 上，不在 figure 上
      },
      w: {
        default: 220,
        parseHTML: (el) => {
          const img = el.querySelector('img');
          return parseInt(el.getAttribute('data-w') || img?.getAttribute('data-w') || '220', 10) || 220;
        },
        renderHTML: () => ({}), // D4: 通过 renderHTML 显式输出，不自动泄漏
      },
      h: {
        default: 120,
        parseHTML: (el) => {
          const img = el.querySelector('img');
          return parseInt(el.getAttribute('data-h') || img?.getAttribute('data-h') || '120', 10) || 120;
        },
        renderHTML: () => ({}), // D4: 通过 renderHTML 显式输出，不自动泄漏
      },
      caption: {
        default: '',
        parseHTML: (el) => {
          const cap = el.querySelector('figcaption');
          return cap ? cap.textContent?.trim() || '' : '';
        },
        renderHTML: () => ({}), // D4: caption 走 figcaption，不泄漏裸属性
      },
      align: {
        default: 'center',
        parseHTML: (el) => el.getAttribute('data-align') || 'center',
        renderHTML: () => ({}), // D4: 通过 renderHTML 显式输出，不自动泄漏
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'figure.diagram',
        getAttrs: (el) => {
          if (typeof el === 'string') return false;
          const img = el.querySelector('img');
          const cap = el.querySelector('figcaption');
          // D2 修复：优先从 figure 读 data-w/h（契约位置），img 上的作向后兼容回退
          const w = parseInt(el.getAttribute('data-w') || img?.getAttribute('data-w') || '220', 10) || 220;
          const h = parseInt(el.getAttribute('data-h') || img?.getAttribute('data-h') || '120', 10) || 120;
          return {
            src: img ? img.getAttribute('src') : '',
            w,
            h,
            caption: cap ? cap.textContent?.trim() : '',
            align: el.getAttribute('data-align') || 'center',
          };
        },
      },
    ];
  },

  addCommands() {
    return {
      figureNodeToInline: (pos: number) => ({ tr, state, dispatch }) => {
        const node = state.doc.nodeAt(pos);
        if (!node || node.type.name !== 'figureNode') return false;
        const inlineType = state.schema.nodes.inlineFigure;
        if (!inlineType) return false;
        if (dispatch) {
          tr.replaceWith(
            pos,
            pos + node.nodeSize,
            inlineType.create({ src: node.attrs.src, w: node.attrs.w, h: node.attrs.h }),
          );
          dispatch(tr);
        }
        return true;
      },
      removeFigureNode: (pos: number) => ({ tr, state, dispatch }) => {
        const node = state.doc.nodeAt(pos);
        if (!node || node.type.name !== 'figureNode') return false;
        if (dispatch) {
          tr.delete(pos, pos + node.nodeSize);
          dispatch(tr);
        }
        return true;
      },
      updateFigureSize: (pos: number, w: number, h: number) => ({ tr, state, dispatch }) => {
        const node = state.doc.nodeAt(pos);
        if (!node || node.type.name !== 'figureNode') return false;
        if (dispatch) {
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, w, h });
          dispatch(tr);
        }
        return true;
      },
    };
  },

  renderHTML({ node, HTMLAttributes }) {
    // D2+D4 修复：data-w/h/align 输出在 figure 上，img 只留 class + src
    return [
      'figure',
      mergeAttributes({
        class: 'diagram',
        'data-align': node.attrs.align,
        'data-w': String(node.attrs.w),
        'data-h': String(node.attrs.h),
      }, HTMLAttributes),
      [
        'img',
        {
          class: 'q-figure',
          src: node.attrs.src,
        },
      ],
      ['figcaption', {}, node.attrs.caption || ''],
    ];
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      let cur = { ...node.attrs };
      const dom = document.createElement('figure');
      dom.className = 'diagram figure-view';
      dom.setAttribute('contenteditable', 'false');

      const img = document.createElement('img');
      img.className = 'q-figure';
      const cap = document.createElement('figcaption');

      const handle = document.createElement('span');
      handle.className = 'resize-handle';
      handle.title = '拖拽调整图片大小';

      dom.append(img, cap, handle);

      // 0045 P2：选中态浮动条（成行⇄串文/预览/删除[两步]；仅选中时 CSS 显示，位于图片上方）
      const bar = createFigureBar({
        editor,
        getPos,
        mode: 'block',
        getSrc: () => cur.src,
      });
      dom.append(bar.dom);

      const sync = () => {
        if (img.getAttribute('src') !== cur.src) img.setAttribute('src', cur.src);
        img.style.width = cur.w + 'px';
        img.style.height = cur.h + 'px';
        // D2 修复：NodeView 中也同步到 figure（虽然 attrs 本身没变，但 HTML 映射已改）
        dom.setAttribute('data-w', String(cur.w));
        dom.setAttribute('data-h', String(cur.h));
        cap.textContent = cur.caption || '';
        dom.setAttribute('data-align', cur.align);
        bar.refresh();
      };
      sync();

      // Resize handle: maintain aspect ratio, write back to node attrs on mouseup
      handle.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const startX = e.clientX;
        const startW = cur.w;
        const ratio = cur.h / cur.w;
        const onMove = (ev: MouseEvent) => {
          const w = Math.max(40, Math.round(startW + (ev.clientX - startX)));
          cur = { ...cur, w, h: Math.round(w * ratio) };
          sync();
        };
        const onUp = () => {
          window.removeEventListener('mousemove', onMove, true);
          window.removeEventListener('mouseup', onUp, true);
          const pos = typeof getPos === 'function' ? getPos() : null;
          if (typeof pos === 'number') {
            editor.chain().command(({ tr, state }) => {
              const n = state.doc.nodeAt(pos);
              if (!n || n.type.name !== 'figureNode') return false;
              tr.setNodeMarkup(pos, undefined, { ...n.attrs, w: cur.w, h: cur.h });
              return true;
            }).run();
          }
        };
        window.addEventListener('mousemove', onMove, true);
        window.addEventListener('mouseup', onUp, true);
      });

      return {
        dom,
        update(updated) {
          if (updated.type !== node.type) return false;
          cur = { ...updated.attrs };
          sync();
          return true;
        },
        selectNode() { dom.classList.add('ProseMirror-selectednode'); },
        deselectNode() {
          dom.classList.remove('ProseMirror-selectednode');
          bar.reset();
        },
        stopEvent(event) {
          if (bar.dom.contains(event.target as globalThis.Node)) return true;
          if (handle.contains(event.target as globalThis.Node)) return true;
          return event.type === 'click' && dom.contains(event.target as globalThis.Node);
        },
        ignoreMutation() { return true; },
      };
    };
  },
});

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    figureNode: {
      /** 块级配图 → 行内图（保 src/w/h；caption 丢弃——行内图契约无 caption） */
      figureNodeToInline: (pos: number) => ReturnType;
      removeFigureNode: (pos: number) => ReturnType;
      updateFigureSize: (pos: number, w: number, h: number) => ReturnType;
    };
  }
}
