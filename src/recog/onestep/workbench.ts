// 0040 P1/P4/P5：工作台卡流模型（纯函数，无 IO，renderer 与 shell 共用）。
//
// 状态落 run 目录 `workbench.json`（`src/recog/runs/workbench-store.ts` 负责读写）。
// 本文件只做「状态怎么变」——不碰磁盘、不碰 React。

import type { OnestepDraft, WorkbenchCard, WorkbenchCardSource, WorkbenchFigure, WorkbenchFrame, WorkbenchPage, WorkbenchRect, WorkbenchState, WorkbenchTreeSuggestion } from '../../shared/contracts/onestep-types.js';
import { WORKBENCH_STATE_VERSION } from '../../shared/contracts/onestep-types.js';
import { countFigureNodes, figureNodeHtml, stemMarkdownToHtml, composeCardContentHtml, textMarkdownToHtml } from './markdown.js';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function asObject(value: JsonValue | undefined): { [key: string]: JsonValue } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value;
}

function str(value: JsonValue | undefined, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function num(value: JsonValue | undefined, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function bool(value: JsonValue | undefined, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function strArray(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

// ==================== 状态构造 ====================

export interface CreateWorkbenchStateInput {
  runId: string;
  mode: WorkbenchState['mode'];
  stage: string;
  subjectId: string;
  paperTitle: string;
  pages: WorkbenchPage[];
  now: string;
}

export function createWorkbenchState(input: CreateWorkbenchStateInput): WorkbenchState {
  return {
    version: WORKBENCH_STATE_VERSION,
    runId: input.runId,
    mode: input.mode,
    stage: input.stage,
    subjectId: input.subjectId,
    paperTitle: input.paperTitle,
    pages: input.pages,
    cards: [],
    nextSeq: 1,
    updatedAt: input.now,
  };
}

/** 卡 id 分配（nextSeq 随状态持久化，重开不撞车） */
export function allocateCardId(state: WorkbenchState): { id: string; nextSeq: number } {
  const seq = state.nextSeq > 0 ? state.nextSeq : 1;
  return { id: `c${seq}`, nextSeq: seq + 1 };
}

// ==================== 状态反序列化（磁盘 → 内存，损坏不炸） ====================

function parseRect(value: JsonValue | undefined): WorkbenchRect | null {
  const obj = asObject(value);
  if (!obj) return null;
  return { x: num(obj['x']), y: num(obj['y']), w: num(obj['w']), h: num(obj['h']) };
}

function parseFrames(value: JsonValue | undefined): WorkbenchFrame[] {
  if (!Array.isArray(value)) return [];
  const frames: WorkbenchFrame[] = [];
  for (const item of value) {
    const obj = asObject(item);
    if (!obj) continue;
    const rect = parseRect(obj['rect']);
    if (!rect) continue;
    const frame: WorkbenchFrame = { id: str(obj['id'], `f${frames.length + 1}`), pageNo: num(obj['pageNo'], 1), rect };
    if (typeof obj['pageWidth'] === 'number') frame.pageWidth = obj['pageWidth'];
    if (typeof obj['pageHeight'] === 'number') frame.pageHeight = obj['pageHeight'];
    frames.push(frame);
  }
  return frames;
}

function parseFigures(value: JsonValue | undefined): WorkbenchFigure[] {
  if (!Array.isArray(value)) return [];
  const figures: WorkbenchFigure[] = [];
  for (const item of value) {
    const obj = asObject(item);
    if (!obj) continue;
    const bbox = obj['bbox'];
    if (!Array.isArray(bbox) || bbox.length < 4) continue;
    const nums = bbox.slice(0, 4).map((v) => num(v, -1));
    if (nums.some((n) => n < 0)) continue;
    figures.push({
      ref: str(obj['ref'], `图${figures.length + 1}`),
      pageNo: num(obj['pageNo'], 1),
      bbox: [nums[0]!, nums[1]!, nums[2]!, nums[3]!],
      adjusted: bool(obj['adjusted']),
    });
  }
  return figures;
}

function parseTreeSuggestions(value: JsonValue | undefined): WorkbenchTreeSuggestion[] {
  if (!Array.isArray(value)) return [];
  const out: WorkbenchTreeSuggestion[] = [];
  for (const item of value) {
    const obj = asObject(item);
    if (!obj) continue;
    const nodeId = str(obj['nodeId']);
    if (nodeId === '') continue;
    out.push({
      nodeId,
      label: str(obj['label'], nodeId),
      confidence: typeof obj['confidence'] === 'number' ? obj['confidence'] : null,
    });
  }
  return out;
}

/**
 * 0054（R-045③，只增）：`adoptedNodes` 多值解析——缺省/非数组返回 undefined（**不下发该键**，
 * 旧草稿保持「只有单值 adoptedNode」的原状态，读侧由 `adoptedNodesOf` 归一）；
 * 条目缺 nodeId / 非对象一律跳过（不炸不猜，与 parseTreeSuggestions 同口径）。
 */
function parseAdoptedNodes(value: JsonValue | undefined): Array<{ nodeId: string; label: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: Array<{ nodeId: string; label: string }> = [];
  for (const item of value) {
    const obj = asObject(item);
    if (!obj) continue;
    const nodeId = str(obj['nodeId']);
    if (nodeId === '') continue;
    out.push({ nodeId, label: str(obj['label'], nodeId) });
  }
  return out;
}

function parseCard(value: JsonValue, index: number): WorkbenchCard | null {
  const obj = asObject(value);
  if (!obj) return null;
  const statusRaw = str(obj['status'], 'pending');
  const status = (['pending', 'recognizing', 'question', 'failed', 'committed'] as const).find((s) => s === statusRaw) ?? 'pending';
  const sourceRaw = str(obj['source'], 'manual');
  const source: WorkbenchCardSource = sourceRaw === 'ai' || sourceRaw === 'semi' ? sourceRaw : 'manual';
  const figureSourceRaw = str(obj['figureSource'], 'none');
  const figureSource = (['dso', 'inline', 'none', 'mixed'] as const).find((s) => s === figureSourceRaw) ?? 'none';
  const adoptedNodeRaw = asObject(obj['adoptedNode']);
  const adoptedNode =
    adoptedNodeRaw && str(adoptedNodeRaw['nodeId']) !== ''
      ? { nodeId: str(adoptedNodeRaw['nodeId']), label: str(adoptedNodeRaw['label'], str(adoptedNodeRaw['nodeId'])) }
      : null;
  // 0054（R-045③，只增）：多值知识节点（旧草稿无此键 → undefined，不改变原状态）
  const parsedAdoptedNodes = parseAdoptedNodes(obj['adoptedNodes']);
  const errorRaw = obj['error'];
  return {
    id: str(obj['id'], `c${index + 1}`),
    status,
    source,
    checked: bool(obj['checked']),
    frames: parseFrames(obj['frames']),
    error: typeof errorRaw === 'string' && errorRaw !== '' ? errorRaw : null,
    qno: typeof obj['qno'] === 'string' && obj['qno'] !== '' ? obj['qno'] : null,
    typeCode: str(obj['typeCode']),
    contentHtml: str(obj['contentHtml']),
    answerHtml: str(obj['answerHtml']),
    analysisHtml: str(obj['analysisHtml']),
    figures: parseFigures(obj['figures']),
    figureSource,
    warnings: strArray(obj['warnings']),
    tags: strArray(obj['tags']),
    adoptedTags: strArray(obj['adoptedTags']),
    treeSuggestions: parseTreeSuggestions(obj['treeSuggestions']),
    adoptedNode,
    committedQuestionId: str(obj['committedQuestionId']) !== '' ? str(obj['committedQuestionId']) : null,
    // 0054（R-045③，只增）：多值知识节点。缺省/非数组 → 不下发该键（旧草稿原状态保持，
    // 读侧 adoptedNodesOf 回落单值 adoptedNode）；写了就按条目容错读回。
    ...(parsedAdoptedNodes !== undefined ? { adoptedNodes: parsedAdoptedNodes } : {}),
    // 0047（只增）：存为试卷链的所属卷 id（撤销摘卷依据）。普通入库卡本就不写 → 保持缺省；
    // 写了就如实读回，否则重进工作台后撤销会退化成「只删题不摘卷」（留悬挂 paper_questions 行）。
    ...(str(obj['committedPaperId']) !== '' ? { committedPaperId: str(obj['committedPaperId']) } : {}),
  };
}

/**
 * workbench.json 文本 → 状态；损坏/版本不符/runId 不匹配一律返回 null（当作首次进入，不炸不静默篡改）。
 */
export function parseWorkbenchState(text: string, runId: string): WorkbenchState | null {
  let value: JsonValue;
  try {
    value = JSON.parse(text) as JsonValue;
  } catch {
    return null;
  }
  const obj = asObject(value);
  if (!obj) return null;
  if (num(obj['version'], 0) !== WORKBENCH_STATE_VERSION) return null;
  if (str(obj['runId']) !== runId) return null;
  const modeRaw = str(obj['mode'], 'auto');
  const mode = modeRaw === 'semi' ? 'semi' : 'auto';
  const pagesRaw = obj['pages'];
  const pages: WorkbenchPage[] = [];
  if (Array.isArray(pagesRaw)) {
    for (const item of pagesRaw) {
      const p = asObject(item);
      if (!p) continue;
      pages.push({ pageNo: num(p['pageNo'], pages.length + 1), name: str(p['name']), width: num(p['width']), height: num(p['height']) });
    }
  }
  const cardsRaw = obj['cards'];
  const cards: WorkbenchCard[] = [];
  if (Array.isArray(cardsRaw)) {
    cardsRaw.forEach((item, index) => {
      const card = parseCard(item, index);
      if (card) cards.push(card);
    });
  }
  return {
    version: WORKBENCH_STATE_VERSION,
    runId,
    mode,
    stage: str(obj['stage']),
    subjectId: str(obj['subjectId']),
    paperTitle: str(obj['paperTitle']),
    pages,
    cards,
    nextSeq: Math.max(1, Math.round(num(obj['nextSeq'], cards.length + 1))),
    updatedAt: str(obj['updatedAt']),
  };
}

// ==================== 卡片构造与核验 ====================

export interface NewFrameInput {
  pageNo: number;
  rect: WorkbenchRect;
  pageWidth?: number;
  pageHeight?: number;
}

export function makeFrame(id: string, input: NewFrameInput): WorkbenchFrame {
  const frame: WorkbenchFrame = { id, pageNo: input.pageNo, rect: input.rect };
  if (input.pageWidth !== undefined) frame.pageWidth = input.pageWidth;
  if (input.pageHeight !== undefined) frame.pageHeight = input.pageHeight;
  return frame;
}

/** 待识别卡（手动框选产物；多张框选图并入同一张卡） */
export function newPendingCard(input: { id: string; frames: WorkbenchFrame[]; source: WorkbenchCardSource }): WorkbenchCard {
  return {
    id: input.id,
    status: 'pending',
    source: input.source,
    checked: false,
    frames: input.frames,
    error: null,
    qno: null,
    typeCode: '',
    contentHtml: '',
    answerHtml: '',
    analysisHtml: '',
    figures: [],
    figureSource: 'none',
    warnings: [],
    tags: [],
    adoptedTags: [],
    treeSuggestions: [],
    adoptedNode: null,
    adoptedNodes: [],
    committedQuestionId: null,
  };
}

export interface DraftToCardOptions {
  id: string;
  source: WorkbenchCardSource;
  /** 该题图块落到的页号（同一页多题时同页） */
  pageNo: number;
  /** 图编号 → 裁图 data URL（renderer 的 canvas 裁图产物；缺省 = 空 src 占位） */
  figureSrc?: (refIndex: number) => string | undefined;
  figureSize?: (refIndex: number) => { width: number; height: number } | undefined;
  /** 原卷题号（引擎 qno 为空时可由操作层按上下文补） */
  qno?: string | null;
  /** 题型字典键（操作层按字典映射后的 question_type 归一行 id；缺省 = 引擎原文） */
  typeCode?: string;
  /** 框选帧（0070：question 卡保留识别所用的全部帧用于溯源——左栏逐个画出；缺省 = 不进卡） */
  frames?: WorkbenchFrame[];
  /** 图编号 → 图块所在页号（0070 乙方案：跨页卡的图块可能落在不同帧页上；缺省 = 全部用 pageNo） */
  figurePageNo?: (refIndex: number) => number | undefined;
}

/** 引擎草稿 → 题卡（Markdown 落契约 HTML；[图N] 换真图或占位——题干块级、选项行内（0045 P4）） */
export function draftToCard(draft: OnestepDraft, options: DraftToCardOptions): WorkbenchCard {
  const renderOptions = {
    ...(options.figureSrc ? { figureSrc: options.figureSrc } : {}),
    ...(options.figureSize ? { figureSize: options.figureSize } : {}),
  };
  const stemHtml = stemMarkdownToHtml(draft.stemMarkdown, renderOptions);
  const figures: WorkbenchFigure[] = draft.figures.map((f, index) => ({
    ref: f.ref,
    pageNo: options.figurePageNo?.(index + 1) ?? options.pageNo,
    bbox: f.bbox,
    adjusted: false,
  }));
  return {
    id: options.id,
    status: 'question',
    source: options.source,
    checked: true,
    frames: options.frames ? [...options.frames] : [],
    error: null,
    qno: options.qno !== undefined ? options.qno : draft.qno,
    typeCode: options.typeCode ?? draft.questionType,
    // 0045 P4：渲染参数透传到选项（图片选项 [图N] → 行内图，同题干图块机制）
    contentHtml: composeCardContentHtml(stemHtml, draft.options, renderOptions),
    answerHtml: textMarkdownToHtml(draft.answerMarkdown),
    analysisHtml: textMarkdownToHtml(draft.analysisMarkdown),
    figures,
    figureSource: draft.figureSource,
    warnings: [...draft.warnings],
    tags: [...draft.suggestedTags],
    // 2026-09-23 目检反馈：识别产出的建议标签**默认全部采纳**（chip 呈选中态，人可逐个点掉）
    adoptedTags: [...draft.suggestedTags],
    treeSuggestions: [],
    adoptedNode: null,
    adoptedNodes: [],
    committedQuestionId: null,
  };
}

/**
 * 0054（R-045③）：已采纳知识节点**读侧归一**——新字段优先，旧草稿（0054 之前的
 * workbench.json 只有单值 `adoptedNode`）回落为单元素数组。UI/落库一律经本函数读取，
 * 不得直接读 `card.adoptedNode`（那是首节点兼容镜像）。
 */
export function adoptedNodesOf(card: WorkbenchCard): Array<{ nodeId: string; label: string }> {
  if (card.adoptedNodes) return card.adoptedNodes;
  return card.adoptedNode ? [card.adoptedNode] : [];
}

/**
 * 0054（R-045③）：已采纳知识节点**写侧补丁**——两字段恒同步（多值全量 + 首节点镜像）。
 * 用法：`patchCard(id, adoptedNodesPatch(next))`；空数组即两字段同清。
 */
export function adoptedNodesPatch(
  nodes: Array<{ nodeId: string; label: string }>,
): Pick<WorkbenchCard, 'adoptedNodes' | 'adoptedNode'> {
  return { adoptedNodes: nodes, adoptedNode: nodes[0] ?? null };
}

/** 题干中 `[图N]` 的引用编号（与 figures 序号对账用；与 figures.ts 同口径的轻量版） */
export function figureRefsInHtml(html: string): number[] {
  const out: number[] = [];
  for (const m of html.matchAll(/\[图\s*(\d+)\]/g)) out.push(Number(m[1]));
  return out;
}

/** 题干里未被替换的 `[图N]` 残留（严禁静默留占位） */
export function residualFigureRefs(html: string): number[] {
  return figureRefsInHtml(html);
}

/**
 * 核验提示条（黄条；不硬拦，任务书 P4.4）：
 * 答案/解析缺失、图块待确认、[图N] 占位符未配平（图块数 < 占位最大编号）。
 */
export function verifyWarnings(card: WorkbenchCard): string[] {
  if (card.status !== 'question' && card.status !== 'committed') return [];
  const warnings = [...card.warnings];
  if (card.answerHtml.trim() === '' && card.analysisHtml.trim() === '') {
    warnings.push('未识别到答案/解析，请人工补充或确认原卷确实没有');
  }
  const residual = residualFigureRefs(card.contentHtml);
  if (residual.length > 0) {
    warnings.push(`题干仍有未替换的 [${residual.map((n) => `图${n}`).join('、')}] 占位符——图块坐标缺失，请人工框选补图`);
  }
  const nodes = countFigureNodes(card.contentHtml);
  if (nodes > card.figures.length) {
    warnings.push(`题干有 ${nodes} 处图块位，但只配到 ${card.figures.length} 个图块坐标——请人工框选补图`);
  }
  if (card.figures.some((f) => !f.adjusted) && card.figures.length > 0) {
    warnings.push('图块裁切范围来自自动定位，建议逐图确认（可在左栏拖动微调）');
  }
  return warnings;
}

/** 当前可提交（入库）的卡：已出题、未入库 */
export function isCommittable(card: WorkbenchCard): boolean {
  return card.status === 'question';
}

/** 勾选制批量入库的默认勾选集（只含未入库的题卡） */
export function checkedCommittableIds(state: WorkbenchState): string[] {
  return state.cards.filter((c) => c.checked && isCommittable(c)).map((c) => c.id);
}

// ==================== 卡片 HTML 上的纯文本抽取（挂树建议题面用） ====================

const ENTITY_MAP: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ',
};

/** 契约 HTML → 注入纯文本（含 data-tex 的标签整体转 $…$；剥标签、解码实体、折叠空白、限长） */
export function cardStemText(card: WorkbenchCard, maxChars = 800): string {
  const withMath = card.contentHtml.replace(/<[^>]*\sdata-tex="([^"]*)"[^>]*>/g, (_m, tex: string) => `$${tex}$`);
  const withFigures = withMath.replace(/<figure\b[\s\S]*?<\/figure>/g, ' [图] ');
  const noTags = withFigures.replace(/<[^>]+>/g, ' ');
  const decoded = noTags.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITY_MAP[m] ?? m);
  const flat = decoded.replace(/\s+/g, ' ').trim();
  return flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat;
}

/** 卡片图块占位替换（人工微调框后重裁回填；按位置对应 figures 序号） */
export function figureNodeForIndex(card: WorkbenchCard, index: number, src: string, size?: { width: number; height: number }): string {
  const figure = card.figures[index];
  return figureNodeHtml(src, size?.width ?? 0, size?.height ?? 0, figure?.ref);
}
