import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MathEditParams } from '../extensions/mathInline';

// 0045 P3 公式编辑器（2026-09-21 目检返工②重做，用户口径）：
// - **不用 mathlive 自带的整宽虚拟键盘**（实测它铺满窗口底部、遮住答案/解析编辑区，
//   且首次 show 时高度测成 0 会整块停到视口外）——改为弹层内**紧凑符号面板**（Word 公式编辑器形态）：
//   五个短页签（常用/运算符/希腊/函数/上下标），每个页签 3~4 行小键帽，点一下把符号
//   插进 mathfield 光标处（mf.insert；动作键走 executeCommand）。
// - **LaTeX 仅作底层存储**，界面零露出：键帽全部显示人读符号（label），tex 只在内部流转。
// - **位置随光标/窗口动态调整**：锚点优先取编辑器内当前光标矩形（无则用调用方给的 anchorRect），
//   先按「锚点下方」摆，下方空间不够自动翻到上方，横向与纵向都做视口钳制；
//   挂载后按**实测尺寸**再校正一次（layout effect，绘制前完成，不闪跳）。
// - **关闭**：点弹层外任意处（document 捕获 mousedown，**不阻断该次点击**——点「取消」既关弹层
//   也照常触发按钮本身，Word 同款）、Esc（document 级捕获）、✕、取消；关闭=放弃，不写入公式。

/** 键帽：label 显示给人看；tex 是插入的 LaTeX（动作键走 cmd） */
interface PaletteKey {
  label: string;
  tex?: string;
  cmd?: 'moveToPreviousChar' | 'moveToNextChar' | 'deleteBackward';
  title?: string;
}

interface PaletteTab {
  id: string;
  label: string;
  rows: PaletteKey[][];
}

/** 动作行（光标移动/退格）——每个页签底部共用 */
const ACTION_ROW: PaletteKey[] = [
  { label: '←', cmd: 'moveToPreviousChar', title: '光标左移' },
  { label: '→', cmd: 'moveToNextChar', title: '光标右移' },
  { label: '⌫', cmd: 'deleteBackward', title: '退格' },
];

/** 紧凑符号面板（中小学数理常用；覆盖老版五页签的全部符号，键帽改为 6 列小格） */
const PALETTE_TABS: PaletteTab[] = [
  {
    id: 'common',
    label: '常用',
    rows: [
      [
        { label: '7', tex: '7' },
        { label: '8', tex: '8' },
        { label: '9', tex: '9' },
        { label: '÷', tex: '\\div', title: '除法' },
        { label: 'x²', tex: 'x^{2}', title: '平方' },
        { label: '√□', tex: '\\sqrt{\\placeholder{}}', title: '根号' },
      ],
      [
        { label: '4', tex: '4' },
        { label: '5', tex: '5' },
        { label: '6', tex: '6' },
        { label: '×', tex: '\\times', title: '乘法' },
        { label: 'xₙ', tex: 'x_{\\placeholder{}}', title: '下标' },
        { label: 'ⁿ√□', tex: '\\sqrt[\\placeholder{}]{\\placeholder{}}', title: 'n 次根' },
      ],
      [
        { label: '1', tex: '1' },
        { label: '2', tex: '2' },
        { label: '3', tex: '3' },
        { label: '−', tex: '-', title: '减号' },
        { label: '□/□', tex: '\\frac{\\placeholder{}}{\\placeholder{}}', title: '分数' },
        { label: 'π', tex: '\\pi', title: '圆周率' },
      ],
      [
        { label: '0', tex: '0' },
        { label: '.', tex: '.' },
        { label: '=', tex: '=' },
        { label: '+', tex: '+', title: '加号' },
        { label: '(', tex: '(', title: '左括号' },
        { label: ')', tex: ')', title: '右括号' },
      ],
    ],
  },
  {
    id: 'operators',
    label: '运算符',
    rows: [
      [
        { label: '±', tex: '\\pm' },
        { label: '≠', tex: '\\neq' },
        { label: '≤', tex: '\\le' },
        { label: '≥', tex: '\\ge' },
        { label: '≈', tex: '\\approx' },
        { label: '°', tex: '\\degree', title: '度' },
      ],
      [
        { label: '∠', tex: '\\angle' },
        { label: '⊥', tex: '\\perp' },
        { label: '∥', tex: '\\parallel' },
        { label: '△', tex: '\\triangle' },
        { label: '∵', tex: '\\because' },
        { label: '∴', tex: '\\therefore' },
      ],
      [
        { label: '∈', tex: '\\in' },
        { label: '⊂', tex: '\\subset' },
        { label: '∪', tex: '\\cup' },
        { label: '∩', tex: '\\cap' },
        { label: '∞', tex: '\\infty' },
        { label: '∝', tex: '\\propto' },
      ],
    ],
  },
  {
    id: 'greek',
    label: '希腊',
    rows: [
      [
        { label: 'α', tex: '\\alpha' },
        { label: 'β', tex: '\\beta' },
        { label: 'γ', tex: '\\gamma' },
        { label: 'δ', tex: '\\delta' },
        { label: 'θ', tex: '\\theta' },
        { label: 'φ', tex: '\\varphi' },
      ],
      [
        { label: 'λ', tex: '\\lambda' },
        { label: 'μ', tex: '\\mu' },
        { label: 'ρ', tex: '\\rho' },
        { label: 'σ', tex: '\\sigma' },
        { label: 'ω', tex: '\\omega' },
        { label: 'ε', tex: '\\varepsilon' },
      ],
      [
        { label: 'Δ', tex: '\\Delta' },
        { label: 'Σ', tex: '\\Sigma' },
        { label: 'Ω', tex: '\\Omega' },
        { label: 'η', tex: '\\eta' },
        { label: 'ζ', tex: '\\zeta' },
        { label: 'ξ', tex: '\\xi' },
      ],
    ],
  },
  {
    id: 'functions',
    label: '函数',
    rows: [
      [
        { label: 'sin', tex: '\\sin' },
        { label: 'cos', tex: '\\cos' },
        { label: 'tan', tex: '\\tan' },
        { label: 'cot', tex: '\\cot' },
        { label: 'sec', tex: '\\sec' },
        { label: 'csc', tex: '\\csc' },
      ],
      [
        { label: 'arcsin', tex: '\\arcsin' },
        { label: 'arccos', tex: '\\arccos' },
        { label: 'arctan', tex: '\\arctan' },
        { label: 'log', tex: '\\log' },
        { label: 'ln', tex: '\\ln' },
        { label: 'lg', tex: '\\lg' },
      ],
      [
        { label: 'lim', tex: '\\lim_{\\placeholder{}\\to\\placeholder{}}', title: '极限' },
        { label: 'max', tex: '\\max' },
        { label: 'min', tex: '\\min' },
        { label: 'f(x)', tex: 'f\\left(x\\right)=', title: '函数式' },
        { label: 'x̂', tex: '\\hat{\\placeholder{}}', title: '带帽字母' },
        { label: 'x̄', tex: '\\overline{\\placeholder{}}', title: '平均值' },
      ],
    ],
  },
  {
    id: 'scripts',
    label: '上下标',
    rows: [
      [
        { label: 'x²', tex: 'x^{2}' },
        { label: 'x³', tex: 'x^{3}' },
        { label: 'xⁿ', tex: 'x^{\\placeholder{}}', title: '任意次幂' },
        { label: 'xₙ', tex: 'x_{\\placeholder{}}', title: '下标' },
        { label: 'x̂', tex: '\\hat{\\placeholder{}}' },
        { label: 'x̄', tex: '\\overline{\\placeholder{}}' },
      ],
      [
        { label: '□/□', tex: '\\frac{\\placeholder{}}{\\placeholder{}}', title: '分数' },
        { label: '√□', tex: '\\sqrt{\\placeholder{}}', title: '根号' },
        { label: 'ⁿ√□', tex: '\\sqrt[\\placeholder{}]{\\placeholder{}}', title: 'n 次根' },
        { label: '|□|', tex: '\\left|\\placeholder{}\\right|', title: '绝对值' },
        { label: '∑', tex: '\\sum_{\\placeholder{}}^{\\placeholder{}}', title: '求和' },
        { label: '∫', tex: '\\int_{\\placeholder{}}^{\\placeholder{}}', title: '积分' },
      ],
      [
        { label: '∂', tex: '\\partial' },
        { label: '∇', tex: '\\nabla' },
        { label: 'Δ', tex: '\\Delta' },
        { label: 'x⃗', tex: '\\vec{\\placeholder{}}', title: '向量' },
        { label: 'ẋ', tex: '\\dot{\\placeholder{}}', title: '时间导数' },
        { label: '∞', tex: '\\infty' },
      ],
    ],
  },
];

interface MathPopupProps {
  params: MathEditParams | null;
  onClose: () => void;
  onUpdate: (tex: string) => void;
}

/** mathfield 的最小形状（含未进公开类型可选项的 insert/executeCommand） */
interface MathfieldLike {
  value: string;
  style: Record<string, string>;
  insert?: (s: string, options?: unknown) => boolean;
  executeCommand?: (command: string) => boolean;
  focus: () => void;
}

const POPUP_WIDTH = 336;
const GAP = 8;
/** 无光标矩形时的兜底高度估计（挂载后会按实测尺寸校正） */
const EST_HEIGHT = 300;

export function MathPopup({ params, onClose, onUpdate }: MathPopupProps) {
  const mathFieldRef = useRef<MathfieldLike | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState(0);
  /** 实测校正后的落点；null = 尚未校正（用估算值先画） */
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const insertKey = (key: PaletteKey): void => {
    const mf = mathFieldRef.current;
    if (!mf) return;
    try {
      if (key.cmd) mf.executeCommand?.(key.cmd);
      else if (key.tex) mf.insert?.(key.tex);
      mf.focus();
    } catch {
      /* 单键失败不阻塞面板 */
    }
  };

  /** 关闭 = 放弃编辑（不写入），仅回收弹层 */
  const closeAll = (): void => {
    onClose();
  };

  // 打开/切换本次编辑时重置页签与校正位
  useEffect(() => {
    setTab(0);
    setPos(null);
  }, [params]);

  // Esc 关闭（document 级捕获，不依赖焦点位置）
  useEffect(() => {
    if (!params) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeAll();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  // 点弹层外关闭（document 捕获 mousedown；**不 preventDefault**——该次点击照常作用于下层元素，
  // 点弹层外的「取消」既关弹层也触发按钮本身）
  useEffect(() => {
    if (!params) return;
    const onDown = (e: MouseEvent): void => {
      if (popupRef.current && !popupRef.current.contains(e.target as globalThis.Node)) closeAll();
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  // 初始化 mathlive 数学字段（可视化编辑；LaTeX 不露出）
  useEffect(() => {
    if (!params || !containerRef.current) return;

    import('mathlive')
      .then((MathLive) => {
        if (!containerRef.current) return;
        const mf = new MathLive.MathfieldElement() as unknown as MathfieldLike;
        mf.value = params.tex;
        mf.style.width = '100%';
        mf.style.fontSize = '17px';
        try {
          // 面板自带符号；关掉 mathlive 的整宽虚拟键盘（返工②：大键盘遮挡编辑区）
          (mf as unknown as { mathVirtualKeyboardPolicy?: string }).mathVirtualKeyboardPolicy = 'sandboxed';
        } catch {
          /* 旧内核无此属性时忽略 */
        }
        mathFieldRef.current = mf;
        try {
          containerRef.current.innerHTML = '';
          containerRef.current.appendChild(mf as unknown as globalThis.Node);
        } catch {
          /* 非 DOM 环境挂载失败时静默；取值走 mathFieldRef */
        }
        setTimeout(() => {
          try {
            mf.focus();
          } catch {
            /* 忽略 */
          }
        }, 30);
      })
      .catch(() => {
        /* mathlive 装载失败（如测试环境）：弹层仍渲染，不阻塞关闭/取消 */
      });

    return () => {
      mathFieldRef.current = null;
    };
  }, [params]);

  // 落点：优先锚点下方，不够翻上方；横向钳制；挂载后按**实测尺寸**校正（绘制前完成不闪跳）
  useLayoutEffect(() => {
    if (!params || !popupRef.current) return;
    const measured = popupRef.current.getBoundingClientRect();
    const w = measured.width || POPUP_WIDTH;
    const h = measured.height || EST_HEIGHT;
    const anchor = params.anchorRect;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let top = anchor.bottom + 10;
    if (top + h > vh - GAP) {
      // 下方放不下 → 翻到锚点上方；上方也放不下 → 贴底（尽量可见）
      const above = anchor.top - h - 10;
      top = above >= GAP ? above : Math.max(GAP, vh - h - GAP);
    }
    let left = anchor.left;
    if (left + w > vw - GAP) left = vw - w - GAP;
    if (left < GAP) left = GAP;
    setPos({ top: Math.max(GAP, top), left });
  }, [params, tab]);

  // 估算落点（首帧用；随后被 layout effect 的实测校正覆盖）
  const estimated = params
    ? {
      top: Math.min(params.anchorRect.bottom + 10, Math.max(GAP, window.innerHeight - EST_HEIGHT - GAP)),
      left: Math.max(GAP, Math.min(params.anchorRect.left, window.innerWidth - POPUP_WIDTH - GAP)),
    }
    : null;
  const placed = pos ?? estimated;

  const handleSave = (): void => {
    const tex = mathFieldRef.current?.value ?? '';
    if (tex.trim() === '') {
      // 空公式不落节点（避免插入空 mathInline 造成“看不见的公式”）
      closeAll();
      return;
    }
    onUpdate(tex);
    closeAll();
  };

  if (!params || !placed) return null;

  const insertMode = params.insertMode === true;
  const activeTab = PALETTE_TABS[tab] ?? PALETTE_TABS[0]!;

  return (
    <div
      ref={popupRef}
      data-testid="qe-math-popup"
      style={{
        position: 'fixed',
        top: placed.top,
        left: placed.left,
        width: POPUP_WIDTH,
        zIndex: 9999,
        background: 'var(--card, #fffdf7)',
        border: '1px solid var(--line-strong, #d5c8b0)',
        borderRadius: '10px',
        padding: '10px 12px 12px',
        boxShadow: '0 8px 32px rgba(74, 52, 30, 0.18)',
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') closeAll();
        else if (e.key === 'Enter' && e.ctrlKey) handleSave();
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', fontSize: '12px', color: 'var(--ink-2, #6b5f52)', marginBottom: '6px' }}>
        <span>∑ {insertMode ? '插入公式' : '编辑公式'}</span>
        <span style={{ marginLeft: '6px', color: 'var(--ink-3, #9a8c7b)' }}>点符号即输</span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          data-testid="qe-math-close"
          title="关闭"
          onClick={closeAll}
          style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '13px', color: 'var(--ink-3, #9a8c7b)', padding: '0 2px' }}
        >
          ✕
        </button>
      </div>

      <div ref={containerRef} className="qe-math-field" style={{ marginBottom: '6px' }} />

      {/* 紧凑符号面板（返工②：替代 mathlive 整宽大键盘） */}
      <div className="qe-math-tabs" role="tablist">
        {PALETTE_TABS.map((t, i) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={i === tab}
            className={i === tab ? 'qe-math-tab on' : 'qe-math-tab'}
            onClick={() => setTab(i)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="qe-math-keys" data-testid="qe-math-keys">
        {activeTab.rows.flat().map((key, i) => (
          <button
            key={`${activeTab.id}-${i}`}
            type="button"
            className="qe-math-key"
            title={key.title ?? key.label}
            onClick={() => insertKey(key)}
          >
            {key.label}
          </button>
        ))}
        {ACTION_ROW.map((key, i) => (
          <button
            key={`${activeTab.id}-act-${i}`}
            type="button"
            className="qe-math-key qe-math-key-act"
            title={key.title ?? key.label}
            onClick={() => insertKey(key)}
          >
            {key.label}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '8px' }}>
        <button type="button" data-testid="qe-math-cancel" className="btn btn-ghost btn-sm" onClick={closeAll}>
          取消
        </button>
        <button type="button" data-testid="qe-math-confirm" className="btn btn-primary btn-sm" onClick={handleSave}>
          {insertMode ? '插入' : '确定'}
        </button>
      </div>
    </div>
  );
}
