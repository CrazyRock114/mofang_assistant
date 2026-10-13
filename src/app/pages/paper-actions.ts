// 0004 Phase 2：试题篮/排版间共享动作层 —— 卷数据装载、学生/教师版预览与导出、状态徽标。
// 从旧 PaperEditor 预览导出逻辑提取（卡片直开预览/导出，不要求先开排版页）。
// 0004 Phase 5 升级（快照走读 + config 驱动渲染）：
// - done/archived 卷的装载改走 listPaperSnapshotQuestions（快照恒定：改题不漂移）；
//   无快照行（旧数据）回落现题并置 snapshotMissing 标记（UI 提示「已用当前题库内容」）；
// - 预览/导出把 paper.layoutConfig 与题级图覆盖（ref.layout 聚合）传给渲染引擎（config 路径），
//   导出 PDF 的 pageSize 按 layoutConfig.pageSize（缺省 A4）。

import type {
  BankService, Paper, PaperExtService, PaperQuestionRef, PaperStatus, Question,
  PaperLayoutConfig, QuestionFigureLayout, QuestionAnswerSpaceOverride, PaperTextBlock,
  OptionsLayoutMode,
} from '../../shared/contracts/bank-types.js';
import { renderMath, rewriteDataAssetSrcs } from '../../docgen/render/buildPaperHtml.core.js';
import { inlineFigureAssetIds, normalizeAssetId } from '../../docgen/render/figureBlocks.js';
import { pageDimsMm, resolveLayout, answerSpaceLineHeightMm, normalizeOptionsLayout } from '../../docgen/render/layout.js';
import { injectPreviewScript } from './preview-frame-script.js';
import { getUserDataAssetsRoot } from '../services/paths.js';
// 0035（只增）：DOCX 导出结果形态（统计缺口如实回传 UI）
import type { ExportDocxStats } from '../../shared/contracts/bridge.js';

export type PreviewMode = 'student' | 'teacher';

/** 卷状态中文标签 + 语义色（fix-1 C 组定稿：草稿/排版中/已定稿/已归档；徽标语义色保留）；0044 只增回收站 */
export const PAPER_STATUS_LABEL: Record<PaperStatus, string> = {
  basket: '草稿', composing: '排版中', done: '已定稿', archived: '已归档', trashed: '回收站',
};
export const PAPER_STATUS_COLOR: Record<PaperStatus, string> = {
  basket: '#868e96', composing: '#1971c2', done: '#2b8a3e', archived: '#495057', trashed: '#c92a2a',
};

/** 处理中状态（多篮正式化后仍为列表分区/采集页联动的单源判定） */
export function isPaperInFlight(status: PaperStatus | undefined): boolean {
  return status === 'basket' || status === 'composing';
}

/** fix-1 C：归档确认文案（所有 →archived 操作共用，动词统一「归档」） */
export const ARCHIVE_CONFIRM_TEXT = '归档后不再活跃使用，可随时恢复为已定稿';

/** fix-1 C：状态迁移后的提示文案（归档/恢复为已定稿） */
export function transitionMessage(next: PaperStatus, title: string): string {
  return next === 'archived' ? `「${title}」已归档` : `「${title}」已恢复为已定稿`;
}

export interface PaperQuestionItem {
  ref: PaperQuestionRef;
  /** 题目行=库中题；kind='text' 行=占位题（id=行 id，正文在 ref.textBody，渲染走 textBlocks） */
  question: Question;
}

/**
 * 0004-fix-4 2.3：文本内容块行 → 占位题对象（复用题序列 UI/引擎管线，渲染侧经 textBlocks 识别）。
 * 占位题不落库、不指向 questions 表；content 为转义后的纯文本（列表展示用）。
 */
export function textBlockAsQuestion(ref: PaperQuestionRef): Question {
  const text = ref.textBody ?? '';
  return {
    id: ref.questionId,
    subject: '文本块',
    sourceType: 'local',
    sourceDetail: { origin: 'text-block' },
    content: `<div class="question">${text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')}</div>`,
    images: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

/** 0004-fix-4 2.3：题序列 → 渲染输入 textBlocks（仅 kind='text' 行）；fix-6 P1-1：align 一并传渲染 */
export function textBlocksFromItems(items: PaperQuestionItem[]): Record<string, PaperTextBlock> {
  const blocks: Record<string, PaperTextBlock> = {};
  for (const item of items) {
    if (item.ref.kind !== 'text') continue;
    blocks[item.ref.questionId] = {
      id: item.ref.questionId,
      text: item.ref.textBody ?? '',
      ...(item.ref.style ? { style: item.ref.style } : {}),
      ...(item.ref.align ? { align: item.ref.align } : {}),
    };
  }
  return blocks;
}

/**
 * 0004-fix-6 P1-1：文本块行 → 预览交互层现状（qid → 有效对齐）。
 * 有效对齐 = 显式 align 优先，缺省按样式基线观感（section 居中 / note 左）——与渲染层一致；
 * 操作条据此刻出当前对齐态（右栏对齐按钮的高亮/当前态依据）。
 */
export function textBlockStatesFromItems(items: PaperQuestionItem[]): Record<string, { align: 'left' | 'center' | 'right' }> {
  const states: Record<string, { align: 'left' | 'center' | 'right' }> = {};
  for (const item of items) {
    if (item.ref.kind !== 'text') continue;
    const align = item.ref.align ?? (item.ref.style === 'note' ? 'left' : 'center');
    states[item.ref.questionId] = { align };
  }
  return states;
}

export interface PaperBundle {
  paper: Paper;
  questions: PaperQuestionItem[];
  /** Phase 5 快照走读：done/archived 卷存在无快照行（回落现题）时为 true，UI 据此提示 */
  snapshotMissing?: boolean;
}

/** 题级覆盖聚合（ref.layout → 渲染输入 questionLayouts；未覆盖题不产生键）。
 * 0013：layout 扩 optionsLayout 第三键（整对象透传；非法值由渲染侧归一化单源兜底）。 */
export function questionLayoutsFromItems(
  items: PaperQuestionItem[]
): Record<string, { figures?: QuestionFigureLayout[]; answerSpace?: QuestionAnswerSpaceOverride; optionsLayout?: OptionsLayoutMode }> {
  const layouts: Record<string, { figures?: QuestionFigureLayout[]; answerSpace?: QuestionAnswerSpaceOverride; optionsLayout?: OptionsLayoutMode }> = {};
  for (const item of items) {
    if (item.ref.layout) layouts[item.question.id] = item.ref.layout;
  }
  return layouts;
}

/**
 * 0013：选项版式生效值聚合（qid → auto | single-line | two-lines）——题级覆盖 ?? 卷级默认档 ?? auto，
 * 与引擎 renderLayoutQuestion 同规则同源（normalizeOptionsLayout 归一）；预览操作条按钮的
 * 当前态文案与循环起点据此渲染。文本块行不产生键。
 */
export function optionsLayoutsFromItems(
  items: PaperQuestionItem[],
  layout?: PaperLayoutConfig
): Record<string, OptionsLayoutMode> {
  const fallback = resolveLayout(layout).optionsLayout;
  const out: Record<string, OptionsLayoutMode> = {};
  for (const item of items) {
    if (item.ref.kind === 'text') continue;
    const override = item.ref.layout?.optionsLayout;
    out[item.question.id] = override !== undefined ? normalizeOptionsLayout(override) : fallback;
  }
  return out;
}

// ---------- fix-3 P0-1：图片可调面扩展（UI 列表数据源放宽） ----------

/** 不参与排版提升的图片语义（G3：公式/答案/解析图留文本流） */
const NON_FIGURE_IMAGE_TYPES: ReadonlySet<string> = new Set(['formula-image', 'answer-image', 'analysis-image']);

/** 题内 content 引用的 data-assets 资产 id（img/figure src 相对引用；按出现序去重） */
export function contentAssetIds(question: Question): string[] {
  const ids: string[] = [];
  for (const match of question.content.matchAll(/\bsrc=(["'])data-assets\/([^"']+)\1/g)) {
    if (!ids.includes(match[2])) ids.push(match[2]);
  }
  return ids;
}

/**
 * 题内"可参与排版"的图全集（QuestionFigureSettings 列表数据源，fix-3 放宽）：
 * 已覆盖条目（orderIndex 序，含外来图）在前 + content 中全部非公式/答案/解析图（裸图可加入调节）。
 * 与引擎 isPromotableAsset 同规则（图类资格），公式/答案/解析语义不列出。
 * 0041（用户口径：排版页公式固定）：`.inline-figure` 包裹的行内公式图**不列出**——它们不参与
 *   「图片排版」（引擎侧覆盖对其不生效，见 planQuestionFigures）；存量 layout_json 里对行内公式的
 *   历史条目随之不再进入列表 → 下次保存即整体覆盖掉（天然自愈）。
 */
export function listAdjustableAssets(question: Question, current?: QuestionFigureLayout[]): string[] {
  const semanticById = new Map((question.images ?? []).map((img) => [img.assetId, img.type] as const));
  const inlineFixed = inlineFigureAssetIds(question.content);
  const out: string[] = [];
  const covered = [...(current ?? [])].sort(
    (a, b) => (a.orderIndex ?? Number.MAX_SAFE_INTEGER) - (b.orderIndex ?? Number.MAX_SAFE_INTEGER)
  );
  for (const f of covered) {
    const id = normalizeAssetId(f.assetId) ?? f.assetId;
    if (inlineFixed.has(id)) continue;
    if (!out.includes(f.assetId)) out.push(f.assetId);
  }
  for (const assetId of contentAssetIds(question)) {
    if (inlineFixed.has(normalizeAssetId(assetId) ?? assetId)) continue;
    const semantic = semanticById.get(assetId);
    if (semantic && NON_FIGURE_IMAGE_TYPES.has(semantic)) continue;
    if (!out.includes(assetId)) out.push(assetId);
  }
  return out;
}

/**
 * 装载卷 + 题目（getPaperEx 含 archived；题缺失/软删自然跳过——与旧 PaperEditor 容错一致）。
 * Phase 5 快照走读：done/archived 卷一律优先快照题（Q2 快照态，改题/软删不漂移）；
 * 快照缺行（旧数据未快照）逐题回落现题并置 snapshotMissing。
 */
export async function loadPaperBundle(bank: BankService, paper: PaperExtService, paperId: string): Promise<PaperBundle | null> {
  const p = await paper.getPaperEx(paperId);
  if (!p) return null;

  const refs = await bank.getPaperQuestions(paperId);
  const status = p.status ?? 'basket';

  if (status === 'done' || status === 'archived') {
    const snapshotQuestions = await paper.listPaperSnapshotQuestions(paperId);
    const snapById = new Map(snapshotQuestions.map((q) => [q.id, q]));
    const items: PaperQuestionItem[] = [];
    let missing = false;
    for (const ref of refs) {
      // 0004-fix-4 2.3：文本内容块行（无快照行）→ 占位题 + 行内正文
      if (ref.kind === 'text') {
        items.push({ ref, question: textBlockAsQuestion(ref) });
        continue;
      }
      const snap = snapById.get(ref.questionId);
      if (snap) {
        items.push({ ref, question: snap });
      } else {
        // 快照缺行（旧卷未快照/行缺失）：回落现题（软删题自然跳过）
        missing = true;
        const q = await bank.getQuestion(ref.questionId);
        if (q) items.push({ ref, question: q });
      }
    }
    return { paper: p, questions: items, snapshotMissing: missing };
  }

  // basket/composing：编辑态，取现题
  const items = await Promise.all(
    refs.map(async (ref: PaperQuestionRef) => {
      // 0004-fix-4 2.3：文本内容块行（无对应题）→ 占位题
      if (ref.kind === 'text') return { ref, question: textBlockAsQuestion(ref) };
      const q = await bank.getQuestion(ref.questionId);
      return q ? { ref, question: q } : null;
    })
  );
  return { paper: p, questions: items.filter(Boolean) as PaperQuestionItem[] };
}

/** 题面只读渲染：KaTeX 公式 + data-assets 绝对路径解析（与校对页/预览同源纯函数） */
export function renderPaperQuestionHtml(html: string): string {
  return rewriteDataAssetSrcs(renderMath(html), getUserDataAssetsRoot());
}

/** 预览/导出的版式渲染输入（Phase 5：config 路径；缺省=基线路径与历史一致） */
export interface PaperRenderLayout {
  layoutConfig?: PaperLayoutConfig;
  questionLayouts?: Record<string, { figures?: QuestionFigureLayout[]; answerSpace?: QuestionAnswerSpaceOverride; optionsLayout?: OptionsLayoutMode }>;
  /** 0004-fix-4 2.3：文本内容块（key=行 id；渲染为节标题块且不占题号） */
  textBlocks?: Record<string, PaperTextBlock>;
  /**
   * 0004-fix-5 P1-1（只增）：题分值数组（按**题目行**序；文本块不占位）。
   * 缺省/未传 = 引擎不输出题头分值（既有行为）；ComposePage 预览与导出均传 refs.score。
   * 0018 目检返工三：元素允许 undefined（= 该题未设置分值，不渲染题头分值；与 0 分区分）。
   */
  scores?: (number | undefined)[];
}

/**
 * 0004-fix-5 P1-1：题序列 → 渲染分值数组（按题目行序；文本块不占位）。
 * 引擎 renderQuestions 按题目行 index 取 scores[index]（文本块行不递增题号）。
 * 0018 目检返工三：未设置分值如实透传 undefined（不再补 0）——NULL 不渲染题头、0 分渲染 (0分)。
 */
export function scoresFromItems(items: PaperQuestionItem[]): (number | undefined)[] {
  const out: (number | undefined)[] = [];
  for (const item of items) {
    if (item.ref.kind === 'text') continue;
    out.push(item.ref.score);
  }
  return out;
}

/** 0004-fix-5 P1-3：题级作答区现状（右栏操作条三态依据；与引擎同源回落语义） */
export interface AnswerSpaceState {
  enabled: boolean;
  lines: number;
  style: 'blank' | 'lines';
}

/**
 * 0004-fix-5 P1-3：题序列 + 卷级版式 → 各题作答区现状（enabled/行数/样式）。
 * 与引擎 renderLayoutQuestion 同规则：题级覆盖优先（lines 优先 heightMm；style 'none'=不插），
 * 无覆盖回落卷级；行数由 heightMm 反算时用引擎同一行高常量（answerSpaceLineHeightMm）。
 */
export function answerSpacesFromItems(
  items: PaperQuestionItem[],
  layout?: PaperLayoutConfig
): Record<string, AnswerSpaceState> {
  const resolved = resolveLayout(layout);
  const lineHeight = answerSpaceLineHeightMm(resolved);
  const out: Record<string, AnswerSpaceState> = {};
  for (const item of items) {
    if (item.ref.kind === 'text') continue;
    const override = item.ref.layout?.answerSpace;
    const style: 'blank' | 'lines' = override?.style === 'lines' || override?.style === 'blank'
      ? override.style
      : resolved.answerSpace.style;
    const enabled = override
      ? (override.lines !== undefined ? override.lines > 0 : override.style !== 'none')
      : resolved.answerSpace.enabled;
    const rawLines = override?.lines !== undefined
      ? override.lines
      : override?.heightMm !== undefined
        ? Math.round(override.heightMm / lineHeight)
        : Math.round(resolved.answerSpace.heightMm / lineHeight);
    out[item.question.id] = { enabled, lines: Math.max(1, rawLines), style };
  }
  return out;
}

/** 完整 HTML 构图（浏览器入口；assetsRoot 显式传入——window.open 新窗无 __mofangPaths，D1-fix R-2） */
async function buildHtml(paper: Paper, questions: Question[], mode: PreviewMode, layout?: PaperRenderLayout): Promise<string> {
  const { buildPaperHtml } = await import('../../docgen/render/buildPaperHtml.browser.js');
  return buildPaperHtml(paper, questions, {
    mode,
    assetsRoot: getUserDataAssetsRoot(),
    layoutConfig: layout?.layoutConfig,
    questionLayouts: layout?.questionLayouts,
    textBlocks: layout?.textBlocks,
    scores: layout?.scores,
  });
}

/** 新窗预览（学生/教师版；layout 传入 → config 驱动渲染，缺省基线）。
 * 0004-fix-4 2.1：新窗同用页化产物（分页纸流）；交互层关闭（新窗无父层消息通道）。 */
export async function previewPaper(paper: Paper, questions: Question[], mode: PreviewMode, layout?: PaperRenderLayout): Promise<void> {
  const html = await buildHtml(paper, questions, mode, layout);
  const resolved = resolveLayout(layout?.layoutConfig);
  const dims = pageDimsMm(resolved);
  const paginated = injectPreviewScript(html, {
    assetsRoot: getUserDataAssetsRoot(),
    pageWmm: dims.w,
    pageHmm: dims.h,
    questionIds: questions.map((q) => q.id),
    columns: resolved.columns,
    columnGapMm: resolved.columnGapMm,
    paginate: true,
    interactive: false,
  });
  const win = window.open('', '_blank');
  if (win) {
    win.document.write(paginated);
    win.document.close();
  }
}

/** 0035 修复批：PDF 导出结果（与 DocxExportOutcome 同形——取消/成功/失败三态可分，UI 不误报成功） */
export interface PdfExportOutcome {
  /** 错误文案；null = 成功或用户取消 */
  error: string | null;
  /** 落盘路径；null = 用户取消（保存对话框）或失败 */
  filePath: string | null;
  /** 用户在保存对话框取消 */
  canceled: boolean;
}

/** 导出 PDF（Electron 真机调 printToPDF；纯网页端调起浏览器高保真原生打印另存为 PDF） */
export async function exportPaperPdf(paper: Paper, questions: Question[], mode: PreviewMode, layout?: PaperRenderLayout): Promise<PdfExportOutcome> {
  const html = await buildHtml(paper, questions, mode, layout);
  const suggestedName = `${paper.title}-${mode === 'student' ? '学生版' : '教师版'}.pdf`;

  if (!window.__mofangBank) {
    // 纯网页端方案：通过隐藏 iframe 调起浏览器打印，用户可直接另存为 PDF
    try {
      const iframe = document.createElement('iframe');
      iframe.style.position = 'fixed';
      iframe.style.right = '0';
      iframe.style.bottom = '0';
      iframe.style.width = '0';
      iframe.style.height = '0';
      iframe.style.border = '0';
      document.body.appendChild(iframe);
      const doc = iframe.contentWindow?.document;
      if (doc) {
        doc.open();
        doc.write(html);
        doc.close();
        setTimeout(() => {
          iframe.contentWindow?.focus();
          iframe.contentWindow?.print();
          setTimeout(() => {
            if (iframe.parentNode) document.body.removeChild(iframe);
          }, 6000);
        }, 500);
      }
      return { error: null, filePath: '已调起打印对话框（选择“另存为 PDF”）', canceled: false };
    } catch (err) {
      return { error: `调起打印失败：${err instanceof Error ? err.message : String(err)}`, filePath: null, canceled: false };
    }
  }

  const pageSize = layout?.layoutConfig?.pageSize;
  // fix-2 F2-A：横版出纸按 layoutConfig.orientation（printToPDF landscape 参数）
  const landscape = layout?.layoutConfig?.orientation === 'landscape';
  // 0007 P2：页化导出入参与预览同源（同一 resolveLayout/pageDimsMm 换算）——
  // 主进程隐藏窗跑同一套装箱写回 sheet 再出 PDF，预览=导出同构。
  const resolved = resolveLayout(layout?.layoutConfig);
  const dims = pageDimsMm(resolved);
  const result = await window.__mofangBank.exportPdf({
    html,
    suggestedName,
    ...(pageSize ? { pageSize } : {}),
    ...(landscape ? { landscape: true } : {}),
    paginate: {
      pageWmm: dims.w,
      pageHmm: dims.h,
      columns: resolved.columns,
      columnGapMm: resolved.columnGapMm,
    },
  });
  return { error: null, filePath: result.filePath, canceled: result.filePath === null };
}

/** PDF 导出结果 → UI 提示（取消态中性；与 Word 侧 docxOutcomeMessage 同口径） */
export function pdfOutcomeMessage(
  outcome: PdfExportOutcome,
  title: string,
  mode: PreviewMode,
  pageSizeLabel: string
): { type: 'success' | 'error'; text: string } {
  const version = mode === 'student' ? '学生版' : '教师版';
  if (outcome.error) return { type: 'error', text: outcome.error };
  if (outcome.canceled || outcome.filePath === null) {
    return { type: 'success', text: `已取消导出「${title}」（${version}）PDF` };
  }
  return { type: 'success', text: `已提交导出（${version}，${pageSizeLabel}）：${outcome.filePath}` };
}

/** 0035 P3：Word 出口的定位提示（重排版式——与竞品一致，非缺陷；导出前后常驻可见） */
export const DOCX_REFLOW_NOTICE = 'Word 为重排版式，非所见即所得（以 Word/WPS 打开后的排版为准）';

/** 0035：DOCX 导出结果（区分「成功/取消/失败」三态；stats 缺口如实回传，取消时也有 stats） */
export interface DocxExportOutcome {
  /** 错误文案；null = 成功或用户取消 */
  error: string | null;
  /** 落盘路径；null = 用户取消（保存对话框）或失败 */
  filePath: string | null;
  /** 用户在保存对话框取消 */
  canceled: boolean;
  /** 导出统计（成功/取消均有；缺口计数供 UI 如实提示） */
  stats?: ExportDocxStats;
}

/**
 * 0035 P4：导出 Word(DOCX)（Electron 调主进程；纯网页端前端生成 Blob 并下载）。
 */
export async function exportPaperDocx(
  paper: Paper,
  questions: Question[],
  mode: PreviewMode,
  layout?: PaperRenderLayout
): Promise<DocxExportOutcome> {
  const suggestedName = `${paper.title}-${mode === 'student' ? '学生版' : '教师版'}.docx`;

  if (!window.__mofangBank) {
    try {
      const { exportPaperDocxInBrowser } = await import('../services/web-docx.js');
      const blob = await exportPaperDocxInBrowser(paper, questions, mode, layout);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = suggestedName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      return { error: null, filePath: suggestedName, canceled: false };
    } catch (err) {
      return { error: `生成 Word 失败：${err instanceof Error ? err.message : String(err)}`, filePath: null, canceled: false };
    }
  }

  const questionLayouts = layout?.questionLayouts;
  const textBlocks = layout?.textBlocks;
  const scores = layout?.scores;
  const layoutConfig = layout?.layoutConfig ?? paper.layoutConfig;
  const result = await window.__mofangBank.exportDocx({
    paper,
    questions,
    mode,
    suggestedName,
    ...(layoutConfig ? { layoutConfig } : {}),
    ...(questionLayouts && Object.keys(questionLayouts).length > 0 ? { questionLayouts } : {}),
    ...(textBlocks && Object.keys(textBlocks).length > 0 ? { textBlocks } : {}),
    ...(scores && scores.length > 0 ? { scores } : {}),
  });
  return { error: null, filePath: result.filePath, canceled: result.filePath === null, stats: result.stats };
}

/** 导出结果 → UI 提示（缺口如实入文案：公式栅格失败/缺图/清单外标签降级；不假装完美） */
export function docxOutcomeMessage(
  outcome: DocxExportOutcome,
  title: string,
  mode: PreviewMode
): { type: 'success' | 'error'; text: string } {
  const version = mode === 'student' ? '学生版' : '教师版';
  if (outcome.error) return { type: 'error', text: outcome.error };
  if (outcome.canceled || outcome.filePath === null) return { type: 'success', text: `已取消导出「${title}」（${version}）Word` };
  const stats = outcome.stats;
  const gaps: string[] = [];
  if (stats && stats.mathFailed > 0) gaps.push(`公式 ${stats.mathFailed} 处未渲染`);
  if (stats && stats.imagesMissing > 0) gaps.push(`缺图 ${stats.imagesMissing} 处`);
  if (stats && stats.degradations.length > 0) {
    const entries = stats.degradations.map((d) => `${d.tag}×${d.count}`).join('、');
    gaps.push(`清单外标签降级 ${entries}`);
  }
  if (gaps.length === 0) return { type: 'success', text: `已导出 Word：${outcome.filePath}` };
  return { type: 'error', text: `已导出 Word（有缺口）：${outcome.filePath} —— ${gaps.join('；')}` };
}
