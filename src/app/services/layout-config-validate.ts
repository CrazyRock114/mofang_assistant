// 0004 Phase 5：PaperLayoutConfig 导入校验（预设文件导入用）。
// 任务书 Phase 5：「导入预设文件校验：JSON 结构=PaperLayoutConfig v2 校验（非法结构报错不静默）」。
// 纯函数无 IO；逐字段白名单校验，非法即抛错（错误文案直接可示人）。
// 注意：本文件为 renderer 新文件——不写 any/unknown 字样（grep 探针）；JSON.parse 结果
// 收窄到 object 后经 Record 判型逐字段取值，不做整体类型断言。

import type { PaperLayoutConfig, PaperHeaderLine } from '../../shared/contracts/bank-types.js';
import { HEADER_LINE_SIZE_MIN, HEADER_LINE_SIZE_MAX } from '../../docgen/render/layout.js';

/** JSON 可承载的值域（不含数组语义，数组单列校验） */
type JsonScalar = string | number | boolean | null | undefined;
type JsonValue = JsonScalar | object;
type LayoutRecord = Record<string, JsonValue>;

const asRecord = (value: JsonValue): LayoutRecord | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as LayoutRecord;
};

const isFiniteNumber = (value: JsonValue): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const optionalNumber = (rec: LayoutRecord, key: string, opts: { min?: number; max?: number }, label: string): number | undefined => {
  const raw = rec[key];
  if (raw === undefined || raw === null) return undefined;
  if (!isFiniteNumber(raw)) throw new Error(`预设校验失败：${label} 必须是数值`);
  if (opts.min !== undefined && raw < opts.min) throw new Error(`预设校验失败：${label} 不能小于 ${opts.min}`);
  if (opts.max !== undefined && raw > opts.max) throw new Error(`预设校验失败：${label} 不能大于 ${opts.max}`);
  return raw;
};

const optionalEnum = <T extends string | number>(rec: LayoutRecord, key: string, allowed: readonly T[], label: string): T | undefined => {
  const raw = rec[key];
  if (raw === undefined || raw === null) return undefined;
  const hit = allowed.find((a) => a === raw);
  if (!hit) throw new Error(`预设校验失败：${label} 必须是 ${allowed.join('/')} 之一`);
  return hit;
};

const optionalBoolean = (rec: LayoutRecord, key: string, label: string): boolean | undefined => {
  const raw = rec[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'boolean') throw new Error(`预设校验失败：${label} 必须是布尔值`);
  return raw;
};

const optionalMargin = (rec: LayoutRecord, key: string, label: string): PaperLayoutConfig['pageMarginMm'] => {
  if (rec[key] === undefined || rec[key] === null) return undefined;
  const raw = asRecord(rec[key]);
  if (!raw) throw new Error(`预设校验失败：${label} 必须是对象`);
  const top = optionalNumber(raw, 'top', { min: 0, max: 100 }, `${label}.top`);
  const right = optionalNumber(raw, 'right', { min: 0, max: 100 }, `${label}.right`);
  const bottom = optionalNumber(raw, 'bottom', { min: 0, max: 100 }, `${label}.bottom`);
  const left = optionalNumber(raw, 'left', { min: 0, max: 100 }, `${label}.left`);
  if (top === undefined || right === undefined || bottom === undefined || left === undefined) {
    throw new Error(`预设校验失败：${label} 需要 top/right/bottom/left 四个数值`);
  }
  return { top, right, bottom, left };
};

/**
 * 校验并归一导入的版式 config（version 1/2 均收）。
 * 抛错文案以「预设校验失败：」开头（UI 直接展示，不静默）；白名单外字段丢弃不透传。
 */
export function validateLayoutConfig(value: object): PaperLayoutConfig {
  const rec = asRecord(value);
  if (!rec) throw new Error('预设校验失败：根节点必须是 JSON 对象');

  const version = rec['version'];
  if (version !== 1 && version !== 2) {
    throw new Error('预设校验失败：version 必须是 1 或 2（非版式预设文件）');
  }

  const headerRaw = rec['header'] === undefined || rec['header'] === null ? null : asRecord(rec['header']);
  if (rec['header'] !== undefined && rec['header'] !== null && !headerRaw) {
    throw new Error('预设校验失败：header 必须是对象');
  }
  const headerStyle = headerRaw ? optionalEnum(headerRaw, 'style', ['none', 'simple', 'exam'] as const, 'header.style') : undefined;
  const headerTitle = headerRaw && typeof headerRaw['title'] === 'string' ? (headerRaw['title'] as string) : undefined;
  // 0009：卷头多行自定义白名单——逐行逐字段（text 非 string/行非对象 → 剔行；非法字段 → 剔字段；未知字段丢弃）。
  // 字号域 6–72：越界视为非法字段剔掉（渲染侧归一化再回缺省/收拢，二者同源于 layout.resolveHeaderLines）。
  const headerLinesRaw = headerRaw ? headerRaw['lines'] : undefined;
  let headerLines: NonNullable<NonNullable<PaperLayoutConfig['header']>['lines']> | undefined;
  if (Array.isArray(headerLinesRaw)) {
    const kept: NonNullable<NonNullable<PaperLayoutConfig['header']>['lines']> = [];
    for (const entry of headerLinesRaw) {
      const item = asRecord(entry as JsonValue);
      if (!item) continue;
      const text = item['text'];
      if (typeof text !== 'string') continue;
      const line: PaperHeaderLine = { text };
      const sizePt = item['sizePt'];
      if (isFiniteNumber(sizePt) && sizePt >= HEADER_LINE_SIZE_MIN && sizePt <= HEADER_LINE_SIZE_MAX) line.sizePt = sizePt;
      const align = item['align'];
      if (align === 'left' || align === 'center' || align === 'right') line.align = align;
      const bold = item['bold'];
      if (typeof bold === 'boolean') line.bold = bold;
      kept.push(line);
    }
    headerLines = kept;
  }

  const fvRaw = rec['fieldVisibility'] === undefined || rec['fieldVisibility'] === null ? null : asRecord(rec['fieldVisibility']);
  if (rec['fieldVisibility'] !== undefined && rec['fieldVisibility'] !== null && !fvRaw) {
    throw new Error('预设校验失败：fieldVisibility 必须是对象');
  }

  const answerRaw = rec['answerSpace'] === undefined || rec['answerSpace'] === null ? null : asRecord(rec['answerSpace']);
  if (rec['answerSpace'] !== undefined && rec['answerSpace'] !== null && !answerRaw) {
    throw new Error('预设校验失败：answerSpace 必须是对象');
  }
  const answerStyle = answerRaw ? optionalEnum(answerRaw, 'style', ['blank', 'lines'] as const, 'answerSpace.style') : undefined;

  const figureRaw = rec['figureLayout'] === undefined || rec['figureLayout'] === null ? null : asRecord(rec['figureLayout']);
  if (rec['figureLayout'] !== undefined && rec['figureLayout'] !== null && !figureRaw) {
    throw new Error('预设校验失败：figureLayout 必须是对象');
  }
  const figureMode = figureRaw ? optionalEnum(figureRaw, 'mode', ['inline', 'side-by-side'] as const, 'figureLayout.mode') : undefined;
  const figureAlign = figureRaw ? optionalEnum(figureRaw, 'align', ['left', 'center', 'right'] as const, 'figureLayout.align') : undefined;
  const figureWidth = figureRaw ? optionalNumber(figureRaw, 'widthPercent', { min: 0, max: 100 }, 'figureLayout.widthPercent') : undefined;

  // logos：数组结构白名单（assetId 必填字符串 + 三个比例数值）
  const logosRaw = rec['logos'];
  let logos: PaperLayoutConfig['logos'];
  if (logosRaw !== undefined && logosRaw !== null) {
    if (!Array.isArray(logosRaw)) throw new Error('预设校验失败：logos 必须是数组');
    logos = logosRaw.map((entry, i) => {
      const item = asRecord(entry as JsonValue);
      if (!item) throw new Error(`预设校验失败：logos[${i}] 必须是对象`);
      const assetId = item['assetId'];
      if (typeof assetId !== 'string' || !assetId) throw new Error(`预设校验失败：logos[${i}].assetId 必须是非空字符串`);
      const x = optionalNumber(item, 'xRatio', { min: 0, max: 1 }, `logos[${i}].xRatio`);
      const y = optionalNumber(item, 'yRatio', { min: 0, max: 1 }, `logos[${i}].yRatio`);
      const w = optionalNumber(item, 'widthRatio', { min: 0, max: 1 }, `logos[${i}].widthRatio`);
      if (x === undefined || y === undefined || w === undefined) {
        throw new Error(`预设校验失败：logos[${i}] 需要 xRatio/yRatio/widthRatio 三个数值`);
      }
      return { assetId, xRatio: x, yRatio: y, widthRatio: w };
    });
  }

  // 逐字段重组（version=1 时忽略 v2 专属字段；读侧 v1 语义本就不含它们）
  const config: PaperLayoutConfig = { version };
  const fontSize = optionalNumber(rec, 'fontSize', { min: 6, max: 36 }, 'fontSize');
  if (fontSize !== undefined) config.fontSize = fontSize;
  if (typeof rec['fontFamily'] === 'string') config.fontFamily = rec['fontFamily'];
  const lineHeight = optionalNumber(rec, 'lineHeight', { min: 1, max: 3 }, 'lineHeight');
  if (lineHeight !== undefined) config.lineHeight = lineHeight;
  const margin = optionalMargin(rec, 'pageMarginMm', 'pageMarginMm');
  if (margin) config.pageMarginMm = margin;
  if (headerRaw && (headerStyle !== undefined || headerTitle !== undefined || headerLines !== undefined)) {
    config.header = {
      ...(headerStyle !== undefined ? { style: headerStyle } : {}),
      ...(headerTitle !== undefined ? { title: headerTitle } : {}),
      ...(headerLines !== undefined ? { lines: headerLines } : {}),
    };
  }
  if (fvRaw) {
    const questionNo = optionalBoolean(fvRaw, 'questionNo', 'fieldVisibility.questionNo');
    const score = optionalBoolean(fvRaw, 'score', 'fieldVisibility.score');
    const answer = optionalBoolean(fvRaw, 'answer', 'fieldVisibility.answer');
    const analysis = optionalBoolean(fvRaw, 'analysis', 'fieldVisibility.analysis');
    const fv: NonNullable<PaperLayoutConfig['fieldVisibility']> = {};
    if (questionNo !== undefined) fv.questionNo = questionNo;
    if (score !== undefined) fv.score = score;
    if (answer !== undefined) fv.answer = answer;
    if (analysis !== undefined) fv.analysis = analysis;
    config.fieldVisibility = fv;
  }
  if (answerRaw) {
    const enabled = optionalBoolean(answerRaw, 'enabled', 'answerSpace.enabled');
    const heightMm = optionalNumber(answerRaw, 'heightMm', { min: 5, max: 200 }, 'answerSpace.heightMm');
    config.answerSpace = {
      ...(enabled !== undefined ? { enabled } : {}),
      ...(answerStyle !== undefined ? { style: answerStyle } : {}),
      ...(heightMm !== undefined ? { heightMm } : {}),
    };
  }
  if (figureRaw && (figureMode !== undefined || figureAlign !== undefined || figureWidth !== undefined)) {
    config.figureLayout = {
      ...(figureMode !== undefined ? { mode: figureMode } : {}),
      ...(figureAlign !== undefined ? { align: figureAlign } : {}),
      ...(figureWidth !== undefined ? { widthPercent: figureWidth } : {}),
    };
  }
  if (logos) config.logos = logos;
  // 0013：选项版式白名单（卷级默认档）——合法值放行，非法值剔字段回缺省（渲染侧 resolveLayout
  // 归一 auto 同源；不同于 header.style 的抛错口径，本字段剔字段不报错以兼容旧导入文件）。
  const optionsLayout = rec['optionsLayout'];
  if (optionsLayout === 'auto' || optionsLayout === 'single-line' || optionsLayout === 'two-lines') {
    config.optionsLayout = optionsLayout;
  }
  if (version === 2) {
    const pageSize = optionalEnum(rec, 'pageSize', ['A4', 'A3'] as const, 'pageSize');
    if (pageSize !== undefined) config.pageSize = pageSize;
    // fix-2 F2-A：横竖版白名单
    const orientation = optionalEnum(rec, 'orientation', ['portrait', 'landscape'] as const, 'orientation');
    if (orientation !== undefined) config.orientation = orientation;
    const columns = optionalEnum(rec, 'columns', [1, 2] as const, 'columns');
    if (columns !== undefined) config.columns = columns;
    const gap = optionalNumber(rec, 'columnGapMm', { min: 0, max: 40 }, 'columnGapMm');
    if (gap !== undefined) config.columnGapMm = gap;
  }
  return config;
}

/** 解析预设 JSON 文本 → 校验 → PaperLayoutConfig（解析失败/结构非法均抛错，文案可直示） */
export function parseLayoutConfigJson(text: string): PaperLayoutConfig {
  let parsed: object;
  try {
    parsed = JSON.parse(text) as object;
  } catch {
    throw new Error('预设校验失败：文件内容不是合法 JSON');
  }
  return validateLayoutConfig(parsed);
}
