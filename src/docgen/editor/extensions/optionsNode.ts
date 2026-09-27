import { Node, mergeAttributes } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { TextSelection } from '@tiptap/pm/state';

// 0045 P4：选择题选项增删行（设计初稿 v1.2 视图四，问卷形态的选项行编辑）。
// 约束与引擎同口径：下限 2（判断题 A/B）、上限 10（recog/onestep/options.ts MAX_OPTIONS）。
// 标号永远 A 起连续：标号是选项文本的前缀（契约形态 `<span class="option">A. …</span>`），
// 删行后对后续选项逐个改写前缀字母；新行 append「{下一标号}. 」空选项。
// 观感由编辑器自带样式保证（editor.css），不再依赖宿主 CSS。

/** 选项行数上限（与引擎 MAX_OPTIONS 一致） */
const MAX_OPTIONS = 10;
/** 选项行数下限（判断题两项） */
const MIN_OPTIONS = 2;

const LABEL_PREFIX_RE = /^（?([A-JＡ-Ｈ])([.．、:：）)])?/;

/** 剩余行数是否可再删（下限守卫） */
export function canRemoveOption(count: number): boolean {
  return count > MIN_OPTIONS;
}

/**
 * 改写一个 optionNode 的标号前缀字母（保持标点与内容；首个 text 无标号前缀则跳过，不猜）。
 * optionPos 为该选项在 tr.doc 中的绝对位置（节点本身），标号是其内首个 text 的第 N 个字符。
 */
function reletterOption(tr: Transaction, optionPos: number, option: PMNode, newLabel: string): void {
  let done = false;
  option.descendants((child, childPos) => {
    if (done) return false;
    if (!child.isText || typeof child.text !== 'string') return;
    const match = LABEL_PREFIX_RE.exec(child.text);
    const letter = match?.[1];
    if (!match || !letter) {
      done = true; // 首个 text 无标号前缀 → 该行不重排（不发明标号）
      return;
    }
    const letterOffset = child.text.indexOf(letter);
    const at = optionPos + 1 + childPos + letterOffset;
    tr.insertText(newLabel, at, at + 1);
    done = true;
    return false;
  });
}

function findParentOptions($from: { depth: number; node(depth: number): PMNode }): { node: PMNode; depth: number } | null {
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (node.type.name === 'optionsNode') return { node, depth: d };
  }
  return null;
}

export const OptionsNode = Node.create({
  name: 'optionsNode',
  group: 'block',
  content: 'optionNode+',

  parseHTML() {
    return [{ tag: 'div.options' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ class: 'options' }, HTMLAttributes), 0];
  },

  addCommands() {
    return {
      /** 0045 目检返工③：在题面末尾插入一个选项区块（默认 A~D 四行空选项；已有选项区块则不动） */
      insertOptions: () => ({ tr, state, dispatch }) => {
        const $from = state.selection.$from;
        const optionsType = state.schema.nodes.optionsNode;
        const optionType = state.schema.nodes.optionNode;
        if (!optionsType || !optionType) return false;

        // 光标所在 questionBlock 内已有选项区块 → 不重复插（题面只有一个选项区）
        let host: PMNode | null = null;
        let hostDepth = 0;
        for (let d = $from.depth; d >= 0; d--) {
          const node = $from.node(d);
          if (node.type.name === 'questionBlock') {
            host = node;
            hostDepth = d;
            break;
          }
        }
        const scope = host ?? state.doc;
        let existing = false;
        scope.descendants((n) => {
          if (n.type.name === 'optionsNode') existing = true;
        });
        if (existing) return false;

        if (dispatch) {
          const rows = ['A', 'B', 'C', 'D'].map((label) => optionType.create(null, state.schema.text(`${label}. `)));
          const block = optionsType.create(null, rows);
          // 落在题面末尾（questionBlock 闭合 token 前）；无题面壳时落在光标所在块之后
          const pos = host !== null
            ? $from.before(hostDepth) + host.nodeSize - 1
            : ($from.depth > 0 ? $from.after($from.depth) : state.doc.content.size);
          tr.insert(pos, block);
          dispatch(tr);
        }
        return true;
      },
      addOption: () => ({ tr, state, dispatch }) => {
        const parent = findParentOptions(state.selection.$from);
        if (!parent) return false;
        if (parent.node.childCount >= MAX_OPTIONS) return false;
        if (dispatch) {
          const optionType = state.schema.nodes.optionNode;
          if (!optionType) return false;
          const label = String.fromCharCode(65 + parent.node.childCount);
          // 追加在 optionsNode 闭合 token 之前（区块内末尾）；$from.after(depth) 是节点外，不能用
          const insertPos = state.selection.$from.before(parent.depth) + parent.node.nodeSize - 1;
          tr.insert(insertPos, optionType.create(null, state.schema.text(`${label}. `)));
          dispatch(tr);
        }
        return true;
      },
      removeOptionAt: (pos: number) => ({ tr, state, dispatch }) => {
        const target = state.doc.nodeAt(pos);
        if (!target || target.type.name !== 'optionNode') return false;
        const $t = state.doc.resolve(pos);
        const parent = $t.parent;
        if (parent.type.name !== 'optionsNode') return false;
        if (!canRemoveOption(parent.childCount)) return false;
        if (dispatch) {
          const targetIndex = $t.index($t.depth);
          tr.delete(pos, pos + target.nodeSize);
          // 删除后：目标位开始的后续选项标号逐个重排（A 起连续）
          const $after = tr.doc.resolve(Math.min(pos, tr.doc.content.size));
          const depth = $after.depth;
          const contentStart = $after.start(depth);
          const parentNode = $after.parent;
          let offset = 0;
          for (let i = 0; i < parentNode.childCount; i++) {
            const child = parentNode.child(i);
            if (i >= targetIndex) {
              reletterOption(tr, contentStart + offset, child, String.fromCharCode(65 + i));
            }
            offset += child.nodeSize;
          }
          dispatch(tr);
        }
        return true;
      },
    };
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement('div');
      dom.className = 'options qe-options';

      const header = document.createElement('div');
      header.className = 'qe-opt-head';
      header.setAttribute('contenteditable', 'false');

      const contentDOM = document.createElement('div');
      contentDOM.className = 'qe-opt-rows';

      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'qe-opt-add';
      addBtn.setAttribute('contenteditable', 'false');
      addBtn.title = '在末尾添加一个选项';

      dom.append(header, contentDOM, addBtn);

      let current: PMNode = node;
      const refresh = (): void => {
        const pos = typeof getPos === 'function' ? getPos() : undefined;
        if (typeof pos === 'number') {
          const inDoc = editor.state.doc.nodeAt(pos);
          if (inDoc && inDoc.type.name === 'optionsNode') current = inDoc;
        }
        const count = current.childCount;
        header.textContent = `选项 ${count} 项`;
        const nextLabel = String.fromCharCode(65 + Math.min(count, MAX_OPTIONS - 1));
        addBtn.textContent = `＋ 添加选项（${nextLabel}）`;
        addBtn.disabled = count >= MAX_OPTIONS;
      };
      refresh();

      addBtn.addEventListener('mousedown', (e) => e.preventDefault());
      addBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const pos = typeof getPos === 'function' ? getPos() : undefined;
        if (typeof pos !== 'number') return;
        const inDoc = editor.state.doc.nodeAt(pos);
        if (!inDoc || inDoc.type.name !== 'optionsNode' || inDoc.childCount === 0) return;
        // 把光标送进区块内再执行 addOption（addOption 按光标所在的 optionsNode 定位）
        const { state, view } = editor;
        view.dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve(pos + 1), 1)));
        editor.commands.addOption();
      });

      return {
        dom,
        contentDOM,
        update(updated) {
          if (updated.type !== node.type) return false;
          current = updated;
          refresh();
          return true;
        },
        ignoreMutation(mutation) {
          // 行区交给 PM；头部/添加钮的自绘 DOM 变化忽略
          return !(contentDOM.contains(mutation.target) || mutation.target === contentDOM);
        },
      };
    };
  },
});

export const OptionNode = Node.create({
  name: 'optionNode',
  content: 'inline*',

  parseHTML() {
    return [{ tag: 'div.options > span' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes({ class: 'option' }, HTMLAttributes), 0];
  },

  addNodeView() {
    return ({ editor, getPos }) => {
      const dom = document.createElement('span');
      dom.className = 'option qe-opt-row';

      const contentDOM = document.createElement('span');
      contentDOM.className = 'qe-opt-body';

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'qe-opt-del';
      del.textContent = '✕';
      del.title = '删除该选项';
      del.setAttribute('contenteditable', 'false');

      dom.append(contentDOM, del);

      const refresh = (): void => {
        let count = 0;
        const pos = typeof getPos === 'function' ? getPos() : undefined;
        if (typeof pos === 'number') {
          const $p = editor.state.doc.resolve(pos);
          count = $p.parent.type.name === 'optionsNode' ? $p.parent.childCount : 0;
        }
        del.disabled = !canRemoveOption(count);
      };
      refresh();

      del.addEventListener('mousedown', (e) => e.preventDefault());
      del.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const pos = typeof getPos === 'function' ? getPos() : undefined;
        if (typeof pos !== 'number') return;
        editor.commands.removeOptionAt(pos);
      });

      return {
        dom,
        contentDOM,
        update() {
          refresh();
          return true;
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
    optionsNode: {
      /** 0045 目检返工③：题面末尾插入选项区块（A~D 四行；已有选项区块则拒绝） */
      insertOptions: () => ReturnType;
      /** 光标所在选项区块末尾追加一个选项（标号自动连续；满 10 项拒绝） */
      addOption: () => ReturnType;
      /** 删除指定位置的选项行并重排后续标号（剩 2 项时拒绝） */
      removeOptionAt: (pos: number) => ReturnType;
    };
  }
}
