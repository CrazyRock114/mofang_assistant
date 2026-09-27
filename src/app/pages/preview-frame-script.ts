// 0004-fix-2 F2-D + fix-3 P0-1/P0-2：排版间页内预览 iframe 的交互层注入脚本（renderer 侧包装）。
// 0007 P1：脚本体迁至真模块 preview-frame-runtime.js（esbuild 打包文本经虚拟模块导入；
// 装箱规则单源 = ./paginate.ts）。本文件保留：CFG 装配 + 注入拼装 + FRAME_CSS + PreviewFrameContext 契约。
// 引擎 buildPaperHtml 结构输出零改动。脚本内为原生 JS。

import runtimeText from 'virtual:preview-frame-runtime';

export interface PreviewFrameContext {
  /** data-assets 资产磁盘根（file:/// 前缀推导用；null=无资产根，脚本仅支持 data-assets/ 直引形态） */
  assetsRoot: string | null;
  /** 取向换算后的页面物理尺寸 mm（Logo 比例坐标换算基准） */
  pageWmm: number;
  pageHmm: number;
  /** 题序对应的 questionId（.question-item 文档序 ↔ 题序） */
  questionIds: string[];
  /** fix-3：外来图资产（questionId → assetId 列表；mini 条据此刻出「移除」按钮） */
  foreignAssets?: Record<string, string[]>;
  /** fix-4 2.1：栏数（1/2）与列间距（mm）——分页装箱按列宽测量；
   *  0007 P4：双列=手工列盒逐列装箱（planColumns），抬头通栏压缩首页列容量 */
  columns?: 1 | 2;
  columnGapMm?: number;
  /** fix-4 2.1：分页视图开关（缺省 true=块级装箱纸流；false=连续单流） */
  paginate?: boolean;
  /** fix-4：交互层开关（缺省 true；新窗预览=false：只页化，不挂拖拽/选中框） */
  interactive?: boolean;
  /**
   * fix-5 P1-3（只增）：各题作答区现状（操作条三态依据；parent 为唯一真源=覆盖+卷级配置）。
   * enabled=false → 「添加答题区」；true → 行数步进 + 样式切换 + 删除。
   */
  answerSpaces?: Record<string, { enabled: boolean; lines: number; style: 'blank' | 'lines' }>;
  /** fix-5 P1-3（只增）：重建后自动恢复的选中题（行数步进/样式切换后操作条不消失） */
  selectedQuestionId?: string | null;
  /**
   * 0058（只增）：重建后自动恢复的**图选中态**（框/手柄/浮动条跨 srcdoc 重建保持，R-054）。
   * 缺省 null=不恢复；题内无匹配 assetId 时静默跳过。恢复路径**不回发** mf-figure-select（防自激回路）。
   */
  selectedFigure?: { questionId: string; assetId: string } | null;
  /**
   * fix-6 P1-1（只增）：文本内容块行现状（qid → 有效对齐；显式 align 优先，缺省按样式基线观感）。
   * 命中的行点选后操作条走文本块分支（编辑/对齐/删除），不渲染答题区/分值条。
   */
  textBlocks?: Record<string, { align: 'left' | 'center' | 'right' }>;
  /**
   * 0013（只增）：各题选项版式生效值（qid → auto | single-line | two-lines；题级覆盖 ?? 卷级档）。
   * 操作条「选项版式」按钮的当前态文案与循环起点依据；仅含 .options 的题出按钮。
   */
  optionsLayouts?: Record<string, 'auto' | 'single-line' | 'two-lines'>;
  /** 0007 P2（只增）：true=注入后不自动 setup（导出隐藏窗在字体/图片就绪后调 window.__mofangPaginate.setup()） */
  deferSetup?: boolean;
  /**
   * 0063（R-067 / D-077⑤，只增）：app 三主题取值，供 FRAME_CSS 选中框/浮动条主题化（--mf-* 变量）。
   * app 页本地接口非契约文件；逐字段可选，缺省字段走暖纸缺省（THEME_FALLBACK）。
   * 交互预览由 ComposePage 读 <html> 计算变量传入；导出/新窗路径不传（interactive=false 本就不建交互层，
   * FRAME_CSS 的 var() 双保险兜底观感）。
   */
  theme?: {
    accent?: string;
    accentDeep?: string;
    accentSoft?: string;
    card?: string;
    lineStrong?: string;
    ink2?: string;
    ink3?: string;
    brick?: string;
  };
}

/** 0063：暖纸缺省值（theme.css :root 同源）——ctx.theme 缺省/缺字段时逐字段回退（editor.css 带回退值范式）。 */
const THEME_FALLBACK = {
  accent: '#E8734A',
  accentDeep: '#D25A33',
  accentSoft: '#FBE3D7',
  card: '#FFFDF7',
  lineStrong: '#D5C8B0',
  ink2: '#6B5F52',
  ink3: '#9A8C7B',
  brick: '#B5493A',
} as const;


const FRAME_CSS = `
<style>
/* 0063（R-067/D-077⑤）：选中框/浮动条主题化——全量 var(--mf-*, 暖纸值) 双保险（值由 injectPreviewScript
   按 ctx.theme 注入 :root 块；类名全部保留=既有测试锚点）。 */
.mf-selection-box { position: absolute; border: 1.5px solid var(--mf-accent, #E8734A); border-radius: 3px;
  box-shadow: 0 0 0 3px var(--mf-accent-soft, #FBE3D7); box-sizing: border-box;
  pointer-events: none; z-index: 98; }
.mf-selection-handle { position: absolute; right: 0; bottom: 0; transform: translate(50%, 50%);
  width: calc(14px * var(--mf-inv-scale, 1)); height: calc(14px * var(--mf-inv-scale, 1));
  min-width: 10px; min-height: 10px; cursor: nwse-resize; pointer-events: auto;
  background: var(--mf-accent, #E8734A); border: 2px solid #fff; border-radius: 50%;
  box-shadow: 0 1px 3px rgba(0,0,0,0.25); z-index: 101; }
/* fix-4 顺手项 #3：手柄命中容差——不可见外扩 6px（视觉尺寸不变，好点） */
.mf-selection-handle::after { content: ''; position: absolute; inset: -6px; }
.mf-figure-toolbar { position: absolute; z-index: 100; display: flex; align-items: center; gap: 4px;
  background: var(--mf-card, #FFFDF7); border: 1px solid var(--mf-line-strong, #D5C8B0); border-radius: 9px;
  padding: 3px 4px; box-shadow: 0 4px 14px rgba(90,70,40,0.18); font-size: 12px; }
.mf-figure-toolbar > button { border: none; background: transparent; color: var(--mf-ink2, #6B5F52);
  cursor: pointer; padding: 3px 8px; border-radius: 6px; font-size: 12.5px; white-space: nowrap; }
.mf-figure-toolbar > button:hover { background: var(--mf-accent-soft, #FBE3D7); color: var(--mf-accent-deep, #D25A33); }
/* 0063 返工轮三（D-077⑤ 延伸）：当前版式态高亮（成行/右栏，runtime 按 .question-side 归属标 active） */
.mf-figure-toolbar > button.mf-toolbar-active { background: var(--mf-accent-soft, #FBE3D7); color: var(--mf-accent-deep, #D25A33); font-weight: 600; }
/* runtime 对「移除/删除/对齐选中」写内联色（#c92a2a / 对齐选中钮的 background）且 runtime 零改动
 * ⇒ [style*=] 命中 + !important 压内联（样式表 !important 优先于非 important 内联）。
 * 题操作条内唯一写内联 background 的钮=对齐选中态钮；删除/移除钮仅写内联 color。 */
.mf-figure-toolbar > button[style*="#c92a2a"], .mf-question-bar > button[style*="#c92a2a"] { color: var(--mf-brick, #B5493A) !important; }
.mf-question-bar > button[style*="background"] { background: var(--mf-accent, #E8734A) !important; color: #fff !important; }
.mf-move-indicator { position: absolute; height: 3px; background: var(--mf-accent, #E8734A); z-index: 99; pointer-events: none; border-radius: 2px; }
/* 0004-fix-4 2.1：分页纸流（每页一张纸；纸间灰隙 + 阴影；页内 overflow hidden 防串页） */
.mf-sheets { display: flex; flex-direction: column; align-items: center; gap: 18px; padding: 0 0 14px; }
.mf-sheet { position: relative; box-sizing: border-box; background: #fff; box-shadow: 0 2px 10px rgba(0,0,0,0.28); overflow: hidden; }
.mf-sheet--overflow::after { content: '⚠ 块超出单页高度（预览近似，导出以 PDF 为准）'; position: absolute; right: 8px; bottom: 6px; font-size: 10px; color: #c92a2a; }
.mf-paged { padding: 0 !important; max-width: none !important; background: transparent !important; }
.mf-paged .paper-questions { margin: 0; }
.mf-paged-note { font-size: 11px; color: #868e96; text-align: center; padding: 4px 8px; max-width: 100%; }
.mf-continued::before { content: '（续）'; font-size: 10pt; color: #868e96; }
/* 0004-fix-4 2.5：题级点选交互（hover 虚线框 / 选中实线框 / 题尾操作条） */
.mf-q-hover { outline: 1.5px dashed var(--mf-ink3, #9A8C7B); outline-offset: 2px; }
.mf-q-selected { outline: 2px solid var(--mf-accent, #E8734A); outline-offset: 2px; }
.mf-question-bar { position: absolute; z-index: 100; display: flex; align-items: center; gap: 4px;
  background: var(--mf-card, #FFFDF7); border: 1px solid var(--mf-line-strong, #D5C8B0); border-radius: 9px;
  padding: 3px 4px; box-shadow: 0 4px 14px rgba(90,70,40,0.18); font-size: 12px; }
.mf-question-bar > button { border: none; background: transparent; color: var(--mf-ink2, #6B5F52);
  cursor: pointer; padding: 3px 8px; border-radius: 6px; font-size: 12.5px; white-space: nowrap; }
.mf-question-bar > button:hover { background: var(--mf-accent-soft, #FBE3D7); color: var(--mf-accent-deep, #D25A33); }
</style>
`;

/** 0063（D-077⑤）：按 ctx.theme 拼主题变量 :root 块（逐字段缺省回退暖纸值）；FRAME_CSS 的
 *  var(--mf-x, 暖纸值) 双保险——两处任一缺席观感仍正常（导出隐藏窗不传 theme 时全走 fallback）。 */
function themeRootCss(theme?: PreviewFrameContext['theme']): string {
  const v = (actual: string | undefined, fallback: string) => (actual && actual.trim() ? actual.trim() : fallback);
  const vars = [
    `--mf-accent:${v(theme?.accent, THEME_FALLBACK.accent)}`,
    `--mf-accent-deep:${v(theme?.accentDeep, THEME_FALLBACK.accentDeep)}`,
    `--mf-accent-soft:${v(theme?.accentSoft, THEME_FALLBACK.accentSoft)}`,
    `--mf-card:${v(theme?.card, THEME_FALLBACK.card)}`,
    `--mf-line-strong:${v(theme?.lineStrong, THEME_FALLBACK.lineStrong)}`,
    `--mf-ink2:${v(theme?.ink2, THEME_FALLBACK.ink2)}`,
    `--mf-ink3:${v(theme?.ink3, THEME_FALLBACK.ink3)}`,
    `--mf-brick:${v(theme?.brick, THEME_FALLBACK.brick)}`,
  ].join(';');
  return `<style>:root{${vars}}</style>`;
}

/** 把交互层脚本+CSS 注入引擎产物（</body> 前）；无 body 标记则尾部拼接。引擎输出结构零改动。
 *  0007 P1：脚本体不再是本文件模板字符串——真模块 preview-frame-runtime.js（装箱单源=./paginate.js）
 *  经 esbuild 打包文本由虚拟模块注入（scripts/preview-frame-runtime-plugin.mjs，vite/vitest 双挂）。
 *  0063：FRAME_CSS 前先拼主题 :root 块（值取 ctx.theme，缺省暖纸）。 */
export function injectPreviewScript(html: string, ctx: PreviewFrameContext): string {
  const cfg = JSON.stringify({
    assetsRoot: ctx.assetsRoot,
    pageWmm: ctx.pageWmm,
    pageHmm: ctx.pageHmm,
    questionIds: ctx.questionIds,
    foreignAssets: ctx.foreignAssets ?? {},
    columns: ctx.columns ?? 1,
    columnGapMm: ctx.columnGapMm ?? 0,
    paginate: ctx.paginate !== false,
    interactive: ctx.interactive !== false,
    answerSpaces: ctx.answerSpaces ?? {},
    selectedQuestionId: ctx.selectedQuestionId ?? null,
    // 0058（只增）：图选中态恢复输入（缺省 null；导出/新窗路径省略 = 等价关闭，shell 侧零改动）
    selectedFigure: ctx.selectedFigure ?? null,
    textBlocks: ctx.textBlocks ?? {},
    optionsLayouts: ctx.optionsLayouts ?? {},
    deferSetup: ctx.deferSetup === true,
  });
  // 函数式替换：路径中的 $ 序列不做替换语义展开；打包文本已含 IIFE 包装（esbuild format:iife）
  const body = runtimeText.replace(/(["'])__CFG__\1/, () => cfg);
  const script = `${themeRootCss(ctx.theme)}<script>${body}</script>${FRAME_CSS}`;
  const marker = html.lastIndexOf('</body>');
  return marker >= 0 ? `${html.slice(0, marker)}${script}${html.slice(marker)}` : `${html}${script}`;
}
