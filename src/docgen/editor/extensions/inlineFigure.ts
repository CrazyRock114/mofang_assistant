// 0045 P2：行内图节点（inline 原子节点，随文字串行）。
//
// 契约形态对齐采集层暗契约（capture/normalize.ts）：`<span class="inline-figure"><img data-w data-h></span>`，
// CONTENT_CLASSES.INLINE_FIGURE 已在 question-content.ts 正式化（只增）。
// 交互（设计初稿 v1.2）：选中浮动条（成行⇄串文/尺寸/删除）+ 右下角等比缩放柄；
// w/h=0 表示「自然尺寸待回填」——NodeView 在图片载入后量取自然宽高写回节点（封顶 200px，行内图口径同 paper.css）。

import { Node } from '@tiptap/core';
import { createFigureBar } from './figureBar';

/** 行内图自然尺寸回填封顶（与渲染层 .inline-figure 200px 封顶同口径） */
const INLINE_MAX_WIDTH = 200;

export const InlineFigure = Node.create({
  name: 'inlineFigure',
  group: 'inline',
  inline: true,
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      src: {
        default: '',
        parseHTML: (el) => el.querySelector('img')?.getAttribute('src') ?? '',
        renderHTML: () => ({}), // src 只在 img 上输出，不泄漏到 span
      },
      w: {
        default: 0,
        parseHTML: (el) => parseInt(el.querySelector('img')?.getAttribute('data-w') ?? '0', 10) || 0,
        renderHTML: () => ({}),
      },
      h: {
        default: 0,
        parseHTML: (el) => parseInt(el.querySelector('img')?.getAttribute('data-h') ?? '0', 10) || 0,
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span.inline-figure',
        getAttrs: (el) => {
          if (typeof el === 'string') return false;
          const img = el.querySelector('img');
          return {
            src: img?.getAttribute('src') ?? '',
            w: parseInt(img?.getAttribute('data-w') ?? '0', 10) || 0,
            h: parseInt(img?.getAttribute('data-h') ?? '0', 10) || 0,
          };
        },
      },
    ];
  },

  renderHTML({ node }) {
    // 属性顺序对齐采集层形态：class → data-w → data-h → src（契约 HTML 稳定、diff 友好）
    return [
      'span',
      { class: 'inline-figure' },
      [
        'img',
        {
          class: 'q-figure',
          'data-w': String(node.attrs.w),
          'data-h': String(node.attrs.h),
          src: node.attrs.src,
        },
      ],
    ];
  },

  addCommands() {
    return {
      inlineFigureToBlock: (pos: number) => ({ tr, state, dispatch }) => {
        const node = state.doc.nodeAt(pos);
        if (!node || node.type.name !== 'inlineFigure') return false;
        if (dispatch) {
          const figureType = state.schema.nodes.figureNode;
          if (!figureType) return false;
          tr.replaceWith(
            pos,
            pos + node.nodeSize,
            figureType.create({ src: node.attrs.src, w: node.attrs.w, h: node.attrs.h, caption: '', align: 'center' }),
          );
          dispatch(tr);
        }
        return true;
      },
      removeInlineFigure: (pos: number) => ({ tr, state, dispatch }) => {
        const node = state.doc.nodeAt(pos);
        if (!node || node.type.name !== 'inlineFigure') return false;
        if (dispatch) {
          tr.delete(pos, pos + node.nodeSize);
          dispatch(tr);
        }
        return true;
      },
      updateInlineFigureSize: (pos: number, w: number, h: number) => ({ tr, state, dispatch }) => {
        const node = state.doc.nodeAt(pos);
        if (!node || node.type.name !== 'inlineFigure') return false;
        if (dispatch) {
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, w, h });
          dispatch(tr);
        }
        return true;
      },
    };
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      let cur = { ...node.attrs } as { src: string; w: number; h: number };

      const dom = document.createElement('span');
      dom.className = 'inline-figure inline-figure-view';
      dom.setAttribute('contenteditable', 'false');

      const img = document.createElement('img');
      img.className = 'q-figure';

      const handle = document.createElement('span');
      handle.className = 'resize-handle';
      handle.title = '拖拽调整图片大小';

      dom.append(img, handle);

      let naturalized = cur.w > 0 && cur.h > 0;
      const sync = (): void => {
        if (img.getAttribute('src') !== cur.src) img.setAttribute('src', cur.src);
        // 第六轮（用户目检④）：尺寸走 CSS 变量（editor.css 以 !important 反超题库显示的
        // `width:auto !important` 缩略档）——此前写内联 style 在应用里被题库规则盖掉，
        // 表现为"图片宽度被限制、拖拽放大没效果"。
        dom.style.setProperty('--qe-fig-w', cur.w > 0 ? `${cur.w}px` : 'auto');
        dom.style.setProperty('--qe-fig-h', cur.h > 0 ? `${cur.h}px` : 'auto');
        img.setAttribute('data-w', String(cur.w));
        img.setAttribute('data-h', String(cur.h));
        bar.refresh();
      };

      // 自然尺寸回填（w/h=0 的粘贴产物）：图片载入后量宽高写回节点，契约 HTML 即有真尺寸
      img.addEventListener('load', () => {
        if (naturalized) return;
        const naturalW = img.naturalWidth;
        const naturalH = img.naturalHeight;
        if (!naturalW || !naturalH) return;
        const w = Math.min(INLINE_MAX_WIDTH, naturalW);
        const h = Math.max(1, Math.round((w * naturalH) / naturalW));
        naturalized = true;
        cur = { ...cur, w, h };
        sync();
        const pos = typeof getPos === 'function' ? getPos() : undefined;
        if (typeof pos === 'number') {
          editor.commands.updateInlineFigureSize(pos, w, h);
        }
      });

      const bar = createFigureBar({
        editor,
        getPos,
        mode: 'inline',
        getSrc: () => cur.src,
      });
      dom.append(bar.dom);

      sync();

      // 等比缩放柄（右下角单柄，Word 极简化）：拖动中只刷 DOM，松手写回节点
      handle.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const startX = e.clientX;
        const startW = cur.w || INLINE_MAX_WIDTH;
        const ratio = (cur.h || 1) / startW;
        const onMove = (ev: MouseEvent): void => {
          const w = Math.max(20, Math.round(startW + (ev.clientX - startX)));
          cur = { ...cur, w, h: Math.max(1, Math.round(w * ratio)) };
          naturalized = true;
          sync();
        };
        const onUp = (): void => {
          window.removeEventListener('mousemove', onMove, true);
          window.removeEventListener('mouseup', onUp, true);
          const pos = typeof getPos === 'function' ? getPos() : undefined;
          if (typeof pos === 'number') {
            editor.commands.updateInlineFigureSize(pos, cur.w, cur.h);
          }
        };
        window.addEventListener('mousemove', onMove, true);
        window.addEventListener('mouseup', onUp, true);
      });

      return {
        dom,
        update(updated) {
          if (updated.type !== node.type) return false;
          cur = { src: updated.attrs.src, w: updated.attrs.w, h: updated.attrs.h };
          if (cur.w > 0 && cur.h > 0) naturalized = true;
          sync();
          return true;
        },
        selectNode() {
          dom.classList.add('ProseMirror-selectednode');
        },
        deselectNode() {
          dom.classList.remove('ProseMirror-selectednode');
          bar.reset();
        },
        stopEvent(event) {
          if (bar.dom.contains(event.target as globalThis.Node)) return true;
          if (handle.contains(event.target as globalThis.Node)) return true;
          return event.type === 'click' && dom.contains(event.target as globalThis.Node);
        },
        ignoreMutation() {
          return true;
        },
      };
    };
  },
});

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    inlineFigure: {
      /** 行内图 → 块级配图（保 src/w/h；caption 空、居中） */
      inlineFigureToBlock: (pos: number) => ReturnType;
      removeInlineFigure: (pos: number) => ReturnType;
      updateInlineFigureSize: (pos: number, w: number, h: number) => ReturnType;
    };
  }
}
