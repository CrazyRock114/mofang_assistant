import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { forwardRef, useEffect, useState, useImperativeHandle, useRef } from 'react';
import { MathInline, mathBridge, QuestionBlock, FigureNode, OptionsNode, OptionNode, AnswerBlock, QUESTION_TABLE_EXTENSIONS } from './extensions';
import { InlineFigure } from './extensions/inlineFigure';
import { LockExtension } from './state/lockState';
import { MathPopup } from './math/MathPopup';
import { toContractHtml, fromContractHtml } from './serialize';
import type { MathEditParams } from './extensions/mathInline';
import './editor.css';

// 0045 编辑器增强（任务书 P1~P4 + 二之一工具条收口；界面初稿 v1.2 已拍板；2026-09-21 目检返工③④⑥）：
// - P1 受控插入 API：forwardRef 暴露 QuestionEditorApi（insertHtml/insertFigure/insertInlineFigure/
//   openMathPopup/getHtml/focus，均为 TipTap 官方命令的类型化封装）。既有 initialContent/onSave
//   行为零变化；不传 ref 的存量调用点无感知。
// - P2 图片三件套：Ctrl+V 粘贴剪贴板图片（image/* → dataURL → 行内图，光标处）；
//   行内图节点 InlineFigure（契约 span.inline-figure）；块级⇄行内互转（选中浮动条，保尺寸）；
//   块级拖柄沿用现状，行内同款单柄等比缩放。
// - P3 公式入口：ƒx 直弹可视化公式编辑器（MathPopup 插入态，mathlive 符号虚拟键盘五页签）；
//   点已有公式弹窗编辑（mathBridge 现状不动）。
// - P4 选择题：选项增删行（选项区块内 ＋/✕，标号 A 起连续，2~10）；图片选项全链。
// - 目检返工③（用户）：工具条按宿主分化——题面（variant='stem'，缺省）＝ ƒx / 🖼图片 / ▦表格 /
//   ＋选项 / 💾；答案·解析（variant='plain'）＝ ƒx / 🖼 / ▦ / 💾。
//   **「插入答案块」按钮移除**（答案/解析各有独立编辑区，题面无此需要；answerBlock 节点保留，
//   存量含 .answer 的内容照常解析渲染）。
// - 目检返工④（用户）：接入 TipTap 官方表格扩展（@tiptap/extension-table，新增依赖，见交付报告申报），
//   工具条插入 3×3 带表头表格；单元格内可用公式/图片等行内能力。
// - 目检返工⑥（用户）：图片按钮改标准「风景照」图标（内联 SVG，存为图片的通用语义）。

interface QuestionEditorProps {
  initialContent?: string;
  onSave?: (html: string) => void;
  /**
   * 0045 目检返工③（只增，可选）：工具条形态。
   *  'stem'（缺省）：题面——ƒx / 图片 / 表格 / 插入选项 / 存回；
   *  'plain'：答案·解析等附属区——ƒx / 图片 / 表格 / 存回（无「插入选项」）。
   */
  variant?: 'stem' | 'plain';
  /**
   * 0045 目检返工⑤（只增，可选）：是否显示工具条「存回」按钮。
   * 缺省 true；题库编辑弹层统一把保存收到弹层右下角 → 三个编辑器均传 false。
   */
  showSave?: boolean;
  /**
   * 0045 目检返工④/sixth（只增，可选）：编辑区最小高度（px）。
   * 缺省 0 = 不加最小高度——文本框**紧贴内容**（文本多少、框多高，空内容约一行）；
   * 题库编辑弹层不再传值（用户目检①：文本框要紧密包裹文本、上下不留白）。
   */
  minHeight?: number;
}

/** 受控插入的图片参数（缺省尺寸交 NodeView 自然尺寸回填） */
export interface FigureInsertion {
  src: string;
  w?: number;
  h?: number;
  caption?: string;
  align?: 'left' | 'center' | 'right';
}

/** 0045 P1：命令式受控插入句柄（ref 形态；宿主持有后可在不动文档其余部分的前提下插入节点） */
export interface QuestionEditorApi {
  /** 在光标处插入契约 HTML 片段（TipTap insertContent） */
  insertHtml(html: string): void;
  /** 插入块级配图（figureNode，可拖动调位，录题图芯片链路兼容） */
  insertFigure(fig: FigureInsertion): void;
  /** 插入行内小图（inlineFigure，随文字串行） */
  insertInlineFigure(fig: { src: string; w?: number; h?: number }): void;
  /** 拉起可视化公式弹层（插入态：确认后在光标处插入公式） */
  openMathPopup(): void;
  /** 当前文档的契约 HTML */
  getHtml(): string;
  focus(): void;
}

export const QuestionEditor = forwardRef<QuestionEditorApi, QuestionEditorProps>(function QuestionEditor(
  { initialContent = '', onSave, variant = 'stem', showSave = true, minHeight = 0 },
  ref,
) {
  const [mathParams, setMathParams] = useState<MathEditParams | null>(null);
  const [tablePicker, setTablePicker] = useState(false);
  const [tableHover, setTableHover] = useState<{ rows: number; cols: number } | null>(null);
  const [tableRows, setTableRows] = useState('3');
  const [tableCols, setTableCols] = useState('3');
  const mathBtnRef = useRef<HTMLButtonElement>(null);
  const tableBtnRef = useRef<HTMLButtonElement>(null);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // Disable default nodes that conflict with our custom ones
        heading: false,
        codeBlock: false,
      }),
      MathInline,
      QuestionBlock,
      FigureNode,
      InlineFigure,
      OptionsNode,
      OptionNode,
      AnswerBlock,
      // 0045 目检返工④：官方表格（题面/答案解析均可插表格）
      ...QUESTION_TABLE_EXTENSIONS,
      LockExtension,
    ],
    content: '',
    editorProps: {
      attributes: {
        class: 'question-editor-content',
      },
      // P2 粘贴：剪贴板 image/* → dataURL → 行内图落光标处（同「加图」内联字节日径）
      handlePaste: (view, event) => {
        const files = (event as ClipboardEvent).clipboardData?.files;
        if (!files || files.length === 0) return false;
        const image = Array.from(files).find((f) => f.type.startsWith('image/'));
        if (!image) return false;
        const reader = new FileReader();
        reader.onload = () => {
          const src = typeof reader.result === 'string' ? reader.result : '';
          if (!src) return;
          const figureType = view.state.schema.nodes.inlineFigure;
          if (!figureType) return;
          const { from } = view.state.selection;
          view.dispatch(view.state.tr.insert(from, figureType.create({ src, w: 0, h: 0 })));
        };
        reader.readAsDataURL(image);
        return true; // 已消费，阻止默认文本粘贴
      },
    },
  });

  // Set up math bridge
  if (editor) {
    mathBridge.open = (params: MathEditParams) => {
      setMathParams(params);
    };
  }

  // Load initial content when editor is ready
  if (editor && initialContent && !editor.getHTML().includes('question')) {
    fromContractHtml(editor, initialContent);
  }

  // P1：受控插入句柄（编辑器就绪后才可用；未就绪时调用静默降级为 no-op）
  useImperativeHandle(
    ref,
    () => ({
      insertHtml: (html: string) => {
        editor?.chain().focus().insertContent(html).run();
      },
      insertFigure: (fig: FigureInsertion) => {
        editor
          ?.chain()
          .focus()
          .insertContent({
            type: 'figureNode',
            attrs: { src: fig.src, w: fig.w ?? 220, h: fig.h ?? 120, caption: fig.caption ?? '', align: fig.align ?? 'center' },
          })
          .run();
      },
      insertInlineFigure: (fig: { src: string; w?: number; h?: number }) => {
        const type = editor?.schema.nodes.inlineFigure;
        if (!editor || !type) return;
        editor.chain().focus().insertContent({ type: 'inlineFigure', attrs: { src: fig.src, w: fig.w ?? 0, h: fig.h ?? 0 } }).run();
      },
      openMathPopup: () => {
        if (!editor) return;
        const anchorRect = mathBtnRef.current?.getBoundingClientRect() ?? editor.view.dom.getBoundingClientRect();
        setMathParams({ getPos: () => undefined, tex: '', display: false, anchorRect, insertMode: true });
      },
      getHtml: () => (editor ? toContractHtml(editor) : ''),
      focus: () => {
        editor?.commands.focus();
      },
    }),
    [editor],
  );

  const handleMathUpdate = (tex: string) => {
    if (!editor || !mathParams) return;

    // P3 插入态：确认后在光标处插入新公式节点（不要求既有节点）
    if (mathParams.insertMode === true) {
      editor
        .chain()
        .focus()
        .insertContent({ type: 'mathInline', attrs: { tex, display: mathParams.display } })
        .run();
      return;
    }

    const pos = mathParams.getPos();
    if (typeof pos === 'number') {
      editor.chain()
        .focus()
        .command(({ tr, state }) => {
          const node = state.doc.nodeAt(pos);
          if (node && node.type.name === 'mathInline') {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, tex });
          }
          return true;
        })
        .run();
    }
  };

  const handleSave = () => {
    if (!editor) return;
    const html = toContractHtml(editor);
    onSave?.(html);
  };

  /**
   * 目检返工②：ƒx 的锚点=**编辑器内当前光标矩形**（无则退 ƒx 按钮），弹层据此就近弹出；
   * 若当前选中的是 mathInline 节点（单击公式即选中）→ 直接进编辑态改这条公式。
   */
  const openMathPopup = () => {
    if (!editor) return;
    const { state } = editor;
    const sel = state.selection as unknown as { node?: { type: { name: string }; attrs: Record<string, unknown> }; from: number };
    if (sel.node && sel.node.type.name === 'mathInline') {
      const dom = editor.view.nodeDOM(sel.from);
      const anchorRect = dom instanceof HTMLElement ? dom.getBoundingClientRect() : mathBtnRef.current?.getBoundingClientRect() ?? editor.view.dom.getBoundingClientRect();
      setMathParams({
        getPos: () => sel.from,
        tex: String(sel.node.attrs['tex'] ?? ''),
        display: sel.node.attrs['display'] === true,
        anchorRect,
      });
      return;
    }
    setMathParams({
      getPos: () => undefined,
      tex: '',
      display: false,
      anchorRect: caretAnchorRect() ?? mathBtnRef.current?.getBoundingClientRect() ?? editor.view.dom.getBoundingClientRect(),
      insertMode: true,
    });
  };

  /** 编辑器内当前光标矩形（选区已渲染时可用；否则 null 由调用方回退） */
  const caretAnchorRect = (): DOMRect | null => {
    if (!editor) return null;
    const browserSel = window.getSelection();
    if (!browserSel || browserSel.rangeCount === 0) return null;
    const anchorNode = browserSel.anchorNode;
    if (!anchorNode || !editor.view.dom.contains(anchorNode)) return null;
    const rect = browserSel.getRangeAt(0).getBoundingClientRect();
    return rect.width || rect.height ? rect : null;
  };

  const insertFigure = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (ev) => {
          const src = ev.target?.result as string;
          editor?.chain().focus().insertContent({
            type: 'figureNode',
            attrs: { src, w: 220, h: 120, caption: '', align: 'center' },
          }).run();
        };
        reader.readAsDataURL(file);
      }
    };
    input.click();
  };

  /** 目检返工③：插入选项区块（A~D 四行；已有选项区则拒绝） */
  const insertOptions = () => {
    editor?.chain().focus().insertOptions().run();
  };

  /** 目检返工③（用户）：表格先选尺寸（几行几列）再插——Word 式网格选择 */
  const openTablePicker = () => {
    setTableHover(null);
    setTablePicker((v) => !v);
  };
  const insertTableSized = (rows: number, cols: number) => {
    setTablePicker(false);
    setTableHover(null);
    editor?.chain().focus().insertTable({ rows, cols, withHeaderRow: true }).run();
  };

  // 表格尺寸面板：点外部 / Esc 关闭
  useEffect(() => {
    if (!tablePicker) return;
    const onDown = (e: MouseEvent): void => {
      const target = e.target as globalThis.Node;
      if (tableBtnRef.current?.contains(target)) return;
      if ((target as HTMLElement).closest?.('.qe-table-picker')) return;
      setTablePicker(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setTablePicker(false);
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [tablePicker]);

  if (!editor) {
    return <div>Loading editor...</div>;
  }

  const tablePickerRect = tablePicker ? tableBtnRef.current?.getBoundingClientRect() ?? null : null;
  const TABLE_PICKER_SIZE = 8;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="qe-toolbar" data-testid="qe-toolbar">
        <button ref={mathBtnRef} type="button" data-testid="qe-btn-math" title="插入公式" onClick={openMathPopup}>ƒx</button>
        <button type="button" data-testid="qe-btn-figure" title="插入图片" onClick={insertFigure}>
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
            <rect x="3" y="4.5" width="18" height="15" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <circle cx="8.6" cy="9.8" r="1.5" fill="currentColor" />
            <path d="M4.6 17.8l4.6-5 3 3.2 2.9-2.8 4.3 4.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button ref={tableBtnRef} type="button" data-testid="qe-btn-table" title="插入表格" onClick={openTablePicker} aria-expanded={tablePicker}>
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
            <rect x="3" y="4.5" width="18" height="15" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path d="M3 9.5h18M3 14.5h18M9.5 4.5v15M15 4.5v15" fill="none" stroke="currentColor" strokeWidth="1.3" />
          </svg>
        </button>
        {variant === 'stem' && (
          <button type="button" data-testid="qe-btn-options" title="插入选项" onClick={insertOptions}>
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
              <path d="M4 6.5h1.6M4 12h1.6M4 17.5h1.6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              <path d="M9 6.5h11M9 12h11M9 17.5h11" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        )}
        <span className="qe-tb-spacer" />
        {showSave && (
          <button type="button" className="qe-btn-save" data-testid="qe-btn-save" title="存回题库" onClick={handleSave}>💾</button>
        )}
      </div>

      <div
        className="qe-editor-area"
        style={minHeight > 0 ? { flex: 1, minHeight: `${minHeight}px` } : { flex: 1 }}
      >
        <EditorContent editor={editor} />
      </div>

      {/* 表格尺寸选择（返工③：先选几行几列；Word 式网格） */}
      {tablePicker && tablePickerRect && (
        <div
          className="qe-table-picker"
          data-testid="qe-table-picker"
          style={{
            position: 'fixed',
            top: Math.min(tablePickerRect.bottom + 6, window.innerHeight - 210),
            left: Math.min(tablePickerRect.left, window.innerWidth - 220),
            zIndex: 9999,
          }}
        >
          <div className="qe-table-picker-grid" onMouseLeave={() => setTableHover(null)}>
            {Array.from({ length: TABLE_PICKER_SIZE * TABLE_PICKER_SIZE }, (_, i) => {
              const r = Math.floor(i / TABLE_PICKER_SIZE) + 1;
              const c = (i % TABLE_PICKER_SIZE) + 1;
              const on = tableHover !== null && r <= tableHover.rows && c <= tableHover.cols;
              return (
                <button
                  key={i}
                  type="button"
                  className={on ? 'qe-table-cell on' : 'qe-table-cell'}
                  data-testid={`qe-table-cell-${r}-${c}`}
                  onMouseEnter={() => setTableHover({ rows: r, cols: c })}
                  onClick={() => insertTableSized(r, c)}
                />
              );
            })}
          </div>
          <div className="qe-table-picker-caption" data-testid="qe-table-picker-caption">
            {tableHover ? `${tableHover.rows} 行 × ${tableHover.cols} 列` : '拖动选择行列'}
          </div>
          {/* 第五轮（用户）：网格下方再给「行/列」数字输入 + 插入（大表格不用去划格子） */}
          <div className="qe-table-picker-ops">
            <input
              type="number"
              min={1}
              max={20}
              data-testid="qe-table-rows"
              value={tableRows}
              onChange={(e) => setTableRows(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              aria-label="行数"
            />
            <span>行 ×</span>
            <input
              type="number"
              min={1}
              max={20}
              data-testid="qe-table-cols"
              value={tableCols}
              onChange={(e) => setTableCols(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              aria-label="列数"
            />
            <span>列</span>
            <button type="button" data-testid="qe-table-insert" onClick={() => {
              const r = Math.min(20, Math.max(1, Number(tableRows) || 1));
              const c = Math.min(20, Math.max(1, Number(tableCols) || 1));
              insertTableSized(r, c);
            }}>
              插入
            </button>
          </div>
        </div>
      )}

      <MathPopup
        params={mathParams}
        onClose={() => setMathParams(null)}
        onUpdate={handleMathUpdate}
      />
    </div>
  );
});
