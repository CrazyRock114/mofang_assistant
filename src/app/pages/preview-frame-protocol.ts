// 0004-fix-2 F2-B/D：排版间页内预览 iframe（srcdoc=引擎 buildPaperHtml.browser 全量产物）的
// postMessage 协议与纯 reducer。iframe 交互层（图缩放/换位/对齐/Logo 拖拽/标题点编）经本协议
// 回传父层，父层更新版式 state → 防抖重建 srcdoc；引擎产物零侵入（交互层为 renderer 侧注入脚本）。
// 本文件是 D 组 postMessage 处理器的可单测锚点：parse + reducer 纯函数，无 DOM/IPC 依赖。

import type { QuestionFigureLayout, OptionsLayoutMode } from '../../shared/contracts/bank-types.js';

/** iframe 注入脚本 → 父层消息（t 前缀 mf- 防与宿主页面其它 message 冲突） */
export type PreviewFrameMessage =
  | { t: 'mf-preview-ready'; height: number }
  | { t: 'mf-height'; height: number }
  | { t: 'mf-figure-resize'; questionId: string; assetId: string; widthPercent: number }
  | { t: 'mf-figure-align'; questionId: string; assetId: string; align: 'left' | 'center' | 'right' }
  | { t: 'mf-figure-mode'; questionId: string; assetId: string; mode: 'inline' | 'side-by-side' }
  | { t: 'mf-figure-move'; questionId: string; assetId: string; beforeAssetId: string | null; anchorIndex?: number }
  | { t: 'mf-figure-remove'; questionId: string; assetId: string }
  /**
   * 0058（只增，R-054）：图选中态变化（选中/取消）——父层记忆后在 srcdoc 重建时经 CFG.selectedFigure 回灌。
   * 双 null = 取消选中（点空白 / Esc / 换位拖拽起手）；恢复路径不回发本消息（防自激回路）。
   */
  | { t: 'mf-figure-select'; questionId: string | null; assetId: string | null }
  | { t: 'mf-logo-drag'; index: number; xRatio: number; yRatio: number }
  | { t: 'mf-logo-resize'; index: number; widthRatio: number }
  /**
   * fix-4 2.5 + fix-5 P1-3：右栏题级操作条 → 答题区。
   * action 缺省（旧形态，仅 lines）= 'add'；add=加 3 行空白；lines=改行数；style=切空白/横线；remove=删。
   */
  | { t: 'mf-question-answer-space'; questionId: string; action?: 'add' | 'lines' | 'style' | 'remove'; lines?: number; style?: 'blank' | 'lines' }
  /** fix-5 P1-1：右栏题级操作条 → 分值入口（父层展开该题分值行内输入） */
  | { t: 'mf-question-score'; questionId: string }
  /** fix-4 2.5：右栏题级操作条 → 「插入大标题」（插到该题前） */
  | { t: 'mf-question-insert-text'; questionId: string }
  /**
   * 0013：右栏题级操作条 → 选项版式循环切换（仅含 .options 的题出按钮）。
   * mode = 点击后的下一档（auto→single-line→two-lines→auto 循环）；父层写 layout_json.optionsLayout
   * （题级显式覆盖，'auto' = 有意覆盖卷级档回自动），figures/answerSpace 随行保留。
   */
  | { t: 'mf-question-options-layout'; questionId: string; mode: OptionsLayoutMode }
  /**
   * fix-6 P1-1：右栏文本块操作条 → 编辑 / 对齐（左中右）/ 删除。
   * 文本块行（kind='text'）点选后操作条分支（区分于题目行的答题区/分值条）。
   */
  | { t: 'mf-text-edit'; questionId: string }
  | { t: 'mf-text-align'; questionId: string; align: 'left' | 'center' | 'right' }
  | { t: 'mf-text-remove'; questionId: string }
  | { t: 'mf-title-click' };

const FIGURE_ALIGN = ['left', 'center', 'right'] as const;
const FIGURE_MODE = ['inline', 'side-by-side'] as const;
const TEXT_ALIGN = ['left', 'center', 'right'] as const;
const OPTIONS_LAYOUT_MODES = ['auto', 'single-line', 'two-lines'] as const;

/** JSON 可承载值域（与 layout-config-validate 同款收窄；不引 any/unknown 字样过 grep 探针） */
type JsonScalar = string | number | boolean | null | undefined;
type JsonValue = JsonScalar | object;
type MsgRecord = Record<string, JsonValue>;

const isMsgRecord = (v: JsonValue): v is MsgRecord =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: JsonValue): v is string => typeof v === 'string';
const isNum = (v: JsonValue): v is number => typeof v === 'number' && Number.isFinite(v);

/** 消息白名单收窄（window message data 为跨边界输入，逐字段判型；非协议消息返回 null） */
export function parsePreviewMessage(data: object | null): PreviewFrameMessage | null {
  const rec = isMsgRecord(data) ? data : null;
  if (!rec) return null;
  switch (rec['t']) {
    case 'mf-preview-ready':
    case 'mf-height':
      return isNum(rec['height']) ? { t: rec['t'], height: rec['height'] } : null;
    case 'mf-figure-resize':
      return isStr(rec['questionId']) && isStr(rec['assetId']) && isNum(rec['widthPercent'])
        ? { t: 'mf-figure-resize', questionId: rec['questionId'], assetId: rec['assetId'], widthPercent: rec['widthPercent'] }
        : null;
    case 'mf-figure-align':
      return isStr(rec['questionId']) && isStr(rec['assetId'])
        && FIGURE_ALIGN.find((a) => a === rec['align']) !== undefined
        ? { t: 'mf-figure-align', questionId: rec['questionId'], assetId: rec['assetId'], align: rec['align'] as (typeof FIGURE_ALIGN)[number] }
        : null;
    case 'mf-figure-mode':
      return isStr(rec['questionId']) && isStr(rec['assetId'])
        && FIGURE_MODE.find((m) => m === rec['mode']) !== undefined
        ? { t: 'mf-figure-mode', questionId: rec['questionId'], assetId: rec['assetId'], mode: rec['mode'] as (typeof FIGURE_MODE)[number] }
        : null;
    case 'mf-figure-move': {
      if (!isStr(rec['questionId']) || !isStr(rec['assetId'])) return null;
      if (!(rec['beforeAssetId'] === null || isStr(rec['beforeAssetId']))) return null;
      // fix-5 P0-2：可选段边界锚位（非负整数；缺省=旧图块序语义）
      const anchor = rec['anchorIndex'];
      if (anchor !== undefined && (!isNum(anchor) || !Number.isInteger(anchor) || anchor < 0)) return null;
      return anchor === undefined
        ? { t: 'mf-figure-move', questionId: rec['questionId'], assetId: rec['assetId'], beforeAssetId: rec['beforeAssetId'] }
        : { t: 'mf-figure-move', questionId: rec['questionId'], assetId: rec['assetId'], beforeAssetId: rec['beforeAssetId'], anchorIndex: anchor };
    }
    case 'mf-figure-remove':
      return isStr(rec['questionId']) && isStr(rec['assetId'])
        ? { t: 'mf-figure-remove', questionId: rec['questionId'], assetId: rec['assetId'] }
        : null;
    case 'mf-figure-select': {
      // 0058：双字符串=选中；双 null=取消；半 null/坏类型一律拒收（nullable 判定照 mf-figure-move 先例）
      const qid = rec['questionId'];
      const aid = rec['assetId'];
      const nullPair = qid === null && aid === null;
      const strPair = isStr(qid) && isStr(aid);
      if (!nullPair && !strPair) return null;
      return { t: 'mf-figure-select', questionId: strPair ? (qid as string) : null, assetId: strPair ? (aid as string) : null };
    }
    case 'mf-logo-drag':
      return isNum(rec['index']) && isNum(rec['xRatio']) && isNum(rec['yRatio'])
        ? { t: 'mf-logo-drag', index: rec['index'], xRatio: rec['xRatio'], yRatio: rec['yRatio'] }
        : null;
    case 'mf-logo-resize':
      return isNum(rec['index']) && isNum(rec['widthRatio'])
        ? { t: 'mf-logo-resize', index: rec['index'], widthRatio: rec['widthRatio'] }
        : null;
    case 'mf-question-answer-space': {
      if (!isStr(rec['questionId'])) return null;
      const action = rec['action'];
      const lines = rec['lines'];
      const style = rec['style'];
      const actionOk = action === undefined || action === 'add' || action === 'lines' || action === 'style' || action === 'remove';
      const linesOk = lines === undefined || isNum(lines);
      const styleOk = style === undefined || style === 'blank' || style === 'lines';
      if (!actionOk || !linesOk || !styleOk) return null;
      // 旧形态（仅 lines，无 action）= 加答题区：保持返回形状不变（既有断言零删改）
      if (action === undefined && isNum(lines)) return { t: 'mf-question-answer-space', questionId: rec['questionId'], lines };
      if (action === undefined) return null;
      return {
        t: 'mf-question-answer-space',
        questionId: rec['questionId'],
        action,
        ...(isNum(lines) ? { lines } : {}),
        ...(style === 'blank' || style === 'lines' ? { style } : {}),
      };
    }
    case 'mf-question-score':
      return isStr(rec['questionId'])
        ? { t: 'mf-question-score', questionId: rec['questionId'] }
        : null;
    case 'mf-question-insert-text':
      return isStr(rec['questionId'])
        ? { t: 'mf-question-insert-text', questionId: rec['questionId'] }
        : null;
    case 'mf-question-options-layout': {
      if (!isStr(rec['questionId'])) return null;
      const mode = rec['mode'];
      const hit = OPTIONS_LAYOUT_MODES.find((m) => m === mode);
      return hit !== undefined
        ? { t: 'mf-question-options-layout', questionId: rec['questionId'], mode: hit }
        : null;
    }
    case 'mf-text-edit':
    case 'mf-text-remove':
      return isStr(rec['questionId'])
        ? { t: rec['t'], questionId: rec['questionId'] }
        : null;
    case 'mf-text-align':
      return isStr(rec['questionId'])
        && TEXT_ALIGN.find((a) => a === rec['align']) !== undefined
        ? { t: 'mf-text-align', questionId: rec['questionId'], align: rec['align'] as (typeof TEXT_ALIGN)[number] }
        : null;
    case 'mf-title-click':
      return { t: 'mf-title-click' };
    default:
      return null;
  }
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const round2 = (v: number): number => Number(v.toFixed(2));

/**
 * 题级覆盖 figures 数组中确保某图有条目（无则在末尾追加）并合入 patch。
 * 纯函数；返回新数组（不改变入参）。
 */
export function upsertFigureEntry(
  figures: QuestionFigureLayout[] | undefined,
  assetId: string,
  patch: Partial<Omit<QuestionFigureLayout, 'assetId'>>,
): QuestionFigureLayout[] {
  const list = (figures ?? []).map((f) => ({ ...f }));
  const hit = list.find((f) => f.assetId === assetId);
  if (hit) {
    Object.assign(hit, patch);
  } else {
    list.push({ assetId, ...patch });
  }
  return list;
}

/**
 * fix-3 P0-1：移除某图覆盖条目（预览「移除」按钮回传）——
 * 题内图=恢复文本流（裸图/原位），外来图=整体移除；返回新数组（不改变入参）。
 */
export function removeFigureEntry(
  figures: QuestionFigureLayout[] | undefined,
  assetId: string,
): QuestionFigureLayout[] {
  return (figures ?? []).filter((f) => f.assetId !== assetId);
}

/**
 * 图换位（fix-2 F2-D）：把 movedAssetId 移到 beforeAssetId 之前（null=题尾），
 * 返回该题全量覆盖数组（orderIndex=新序；与 QuestionFigureSettings 整体覆盖式保存同构）。
 * 基准序 = 已有覆盖的 orderIndex 序 ∪ DOM 序补充（未覆盖图按 DOM 序排后）。
 */
export function figureOrderAfterMove(
  domOrderAssets: string[],
  currentFigures: QuestionFigureLayout[] | undefined,
  movedAssetId: string,
  beforeAssetId: string | null,
): QuestionFigureLayout[] {  const byAsset = new Map<string, QuestionFigureLayout>();
  for (const f of currentFigures ?? []) byAsset.set(f.assetId, f);

  const ordered: string[] = [];
  for (const f of [...(currentFigures ?? [])].sort(
    (a, b) => (a.orderIndex ?? Number.MAX_SAFE_INTEGER) - (b.orderIndex ?? Number.MAX_SAFE_INTEGER),
  )) {
    if (!ordered.includes(f.assetId)) ordered.push(f.assetId);
  }
  for (const assetId of domOrderAssets) {
    if (!ordered.includes(assetId)) ordered.push(assetId);
  }

  const without = ordered.filter((id) => id !== movedAssetId);
  const at = beforeAssetId !== null ? without.indexOf(beforeAssetId) : without.length;
  const insertAt = at >= 0 ? at : without.length;
  without.splice(insertAt, 0, movedAssetId);

  return without.map((assetId, index) => {
    const prev = byAsset.get(assetId);
    return { ...(prev ?? { assetId }), assetId, orderIndex: index };
  });
}

/** Logo 拖拽落值：比例坐标钳到 [0,1]（纯函数） */
export function logoAfterDrag(
  logo: { assetId: string; xRatio: number; yRatio: number; widthRatio: number },
  xRatio: number,
  yRatio: number,
): { assetId: string; xRatio: number; yRatio: number; widthRatio: number } {
  return { ...logo, xRatio: round2(clamp01(xRatio)), yRatio: round2(clamp01(yRatio)) };
}

/** Logo 角柄缩放落值：widthRatio 钳到 (0,1]（纯函数） */
export function logoAfterResize(
  logo: { assetId: string; xRatio: number; yRatio: number; widthRatio: number },
  widthRatio: number,
): { assetId: string; xRatio: number; yRatio: number; widthRatio: number } {
  return { ...logo, widthRatio: round2(Math.min(1, Math.max(0.01, widthRatio))) };
}
