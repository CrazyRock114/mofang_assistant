// C1 Phase 2: 校对动作算法（纯函数，无 DOM）
// splitDraft：在 contentHtml/answerHtml/analysisHtml 的文本首次出现 atText 处断开。
//   断点按段落/块级边界解析：命中块首则整块归后段；命中块中段则在该字符处把块一分为二，
//   但不切开 <span class="math"> 原子节点（公式零文本宽度，整体随前段走）。
//   atText 须与 OCR 原文一致（对解码后纯文本精确匹配），未命中返回错误，不静默。
// mergeDrafts：多条目按传入顺序拼接进目标条目（contentHtml 去根包裹后顺序相接）。
// 图引用归属：按各段 HTML 中 figure 的 alt（= imageRefId）出现情况分配；两段都找不到的归前段。

import type { ProofItem } from '../shared/contracts/recog-ui-types.js';
import type { ScanDraft } from '../shared/contracts/recog-types.js';

export type SplitResult = { ok: true; first: ProofItem; second: ProofItem } | { ok: false; error: string };

const QUESTION_ROOT_OPEN = '<div class="question">';
const QUESTION_ROOT_CLOSE = '</div>';

// ===== DOM-free HTML 工具 =====

const VOID_TAGS = new Set(['img', 'br', 'hr', 'input', 'meta', 'link']);

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 标签是否原子节点起始（<span class="math"…> 或 <figure …>）：纯文本视角零宽度、不可切开 */
function atomicElementEnd(html: string, tagStart: number): number | null {
  if (/^<span\s+class="math"/.test(html.slice(tagStart))) {
    const close = html.indexOf('</span>', tagStart);
    return close === -1 ? null : close + '</span>'.length;
  }
  if (/^<figure[\s>]/.test(html.slice(tagStart))) {
    const close = html.indexOf('</figure>', tagStart);
    return close === -1 ? null : close + '</figure>'.length;
  }
  return null;
}

/** 提取纯文本：原子节点整体剥除，其余标签剔除，实体解码 */
export function plainTextOf(html: string): string {
  let out = '';
  let i = 0;
  while (i < html.length) {
    if (html[i] === '<') {
      const atomicEnd = atomicElementEnd(html, i);
      if (atomicEnd !== null) {
        i = atomicEnd;
        continue;
      }
      const gt = html.indexOf('>', i);
      if (gt === -1) break;
      i = gt + 1;
      continue;
    }
    if (html[i] === '&') {
      const semi = html.indexOf(';', i);
      if (semi !== -1 && semi - i <= 6) {
        out += decodeEntities(html.slice(i, semi + 1));
        i = semi + 1;
        continue;
      }
    }
    out += html[i];
    i++;
  }
  return out;
}

/** 拆根 <div class="question"> 包裹；非根包裹则原样返回 */
function unwrapQuestionRoot(html: string): string {
  const trimmed = html.trim();
  if (trimmed.startsWith(QUESTION_ROOT_OPEN) && trimmed.endsWith(QUESTION_ROOT_CLOSE)) {
    return trimmed.slice(QUESTION_ROOT_OPEN.length, trimmed.length - QUESTION_ROOT_CLOSE.length);
  }
  return trimmed;
}

/** 把 HTML 片段拆为顶层块序列（深度 0 的元素各为一块；顶层裸文本各为一块） */
export function splitTopLevelBlocks(html: string): string[] {
  const blocks: string[] = [];
  let i = 0;
  const n = html.length;
  while (i < n) {
    // 跳过块间空白
    while (i < n && /\s/.test(html[i])) i++;
    if (i >= n) break;
    const start = i;
    if (html[i] === '<') {
      let depth = 0;
      while (i < n) {
        if (html[i] !== '<') {
          i++;
          continue;
        }
        const gt = html.indexOf('>', i);
        if (gt === -1) {
          i = n;
          break;
        }
        const tagBody = html.slice(i + 1, gt);
        const isClose = tagBody.startsWith('/');
        const isSelfClose = tagBody.endsWith('/');
        const tagName = (isClose ? tagBody.slice(1) : tagBody).trimStart().split(/[\s/>]/)[0].toLowerCase();
        if (isClose) {
          depth--;
          i = gt + 1;
          if (depth <= 0) break;
        } else if (!isSelfClose && !VOID_TAGS.has(tagName)) {
          depth++;
          i = gt + 1;
        } else {
          i = gt + 1;
          if (depth === 0) break; // 顶层 void/自闭合元素自成一块
        }
      }
      blocks.push(html.slice(start, i));
    } else {
      // 顶层裸文本块
      while (i < n && html[i] !== '<') i++;
      blocks.push(html.slice(start, i));
    }
  }
  return blocks;
}

/**
 * 在块的纯文本偏移 textOffset 处把块切开（cut 在 atText 起始字符之前）。
 * 返回 { pre, post }（保持原块开闭标签）；偏移 0 或覆盖整块时返回 null（走块边界断）。
 */
function cutBlock(blockHtml: string, textOffset: number): { pre: string; post: string } | null {
  const openMatch = blockHtml.match(/^<([a-zA-Z][\w-]*)([^>]*)>/);
  let openTag = '';
  let closeTag = '';
  let inner = blockHtml;
  if (openMatch && !VOID_TAGS.has(openMatch[1].toLowerCase())) {
    const close = `</${openMatch[1]}>`;
    if (blockHtml.endsWith(close)) {
      openTag = openMatch[0];
      closeTag = close;
      inner = blockHtml.slice(openTag.length, blockHtml.length - close.length);
    } else {
      return null; // 标签不配对，不冒险切
    }
  }

  let textCount = 0;
  let cutPos: number | null = null;
  let i = 0;
  while (i < inner.length) {
    if (inner[i] === '<') {
      const atomicEnd = atomicElementEnd(inner, i);
      if (atomicEnd !== null) {
        // 原子节点零文本宽度：不断在其前，整体随前段走（断点落在紧随其后的文本字符前）
        i = atomicEnd;
        continue;
      }
      const gt = inner.indexOf('>', i);
      if (gt === -1) break;
      i = gt + 1;
      continue;
    }
    if (textCount === textOffset) {
      cutPos = i;
      break;
    }
    if (inner[i] === '&') {
      const semi = inner.indexOf(';', i);
      if (semi !== -1 && semi - i <= 6) {
        textCount++;
        i = semi + 1;
        continue;
      }
    }
    textCount++;
    i++;
  }
  if (cutPos === null) {
    if (textCount === textOffset) cutPos = inner.length; // 断点在块尾
    else return null;
  }
  const preInner = inner.slice(0, cutPos);
  const postInner = inner.slice(cutPos);
  if (plainTextOf(preInner).trim() === '' || plainTextOf(postInner).trim() === '') return null;
  return { pre: `${openTag}${preInner}${closeTag}`, post: `${openTag}${postInner}${closeTag}` };
}

// ===== 字段级拆分 =====

interface FieldSplit {
  firstHtml: string;
  secondHtml: string;
}

/** 在块序列中找到 atText 首次出现并拆分；返回 null 表示本字段未命中 */
function splitFieldHtml(fieldHtml: string, atText: string): FieldSplit | null {
  const blocks = splitTopLevelBlocks(fieldHtml);
  for (let b = 0; b < blocks.length; b++) {
    const text = plainTextOf(blocks[b]);
    const offset = text.indexOf(atText);
    if (offset === -1) continue;
    if (offset === 0) {
      // 块边界断：本块整体归后段
      return { firstHtml: blocks.slice(0, b).join(''), secondHtml: blocks.slice(b).join('') };
    }
    const cut = cutBlock(blocks[b], offset);
    if (cut === null) {
      // 断点退化到块首/块尾或标签不配对：按块边界断（整块归后段）
      return { firstHtml: blocks.slice(0, b).join(''), secondHtml: blocks.slice(b).join('') };
    }
    return {
      firstHtml: [...blocks.slice(0, b), cut.pre].join(''),
      secondHtml: [cut.post, ...blocks.slice(b + 1)].join(''),
    };
  }
  return null;
}

/** 按各段 HTML 中 figure 的 alt（= imageRefId）分配图引用；两段都没有的归前段 */
function distributeImageRefs(firstHtml: string, secondHtml: string, imageRefIds: string[]): { first: string[]; second: string[] } {
  const first: string[] = [];
  const second: string[] = [];
  for (const id of imageRefIds) {
    const alt = `alt="${id}"`;
    if (secondHtml.includes(alt) && !firstHtml.includes(alt)) second.push(id);
    else first.push(id);
  }
  return { first, second };
}

function splitRawText(rawText: string, atText: string): { first: string; second: string } {
  const idx = rawText.indexOf(atText);
  if (idx === -1) return { first: rawText, second: '' };
  return { first: rawText.slice(0, idx), second: rawText.slice(idx) };
}

// ===== 公开 API =====

// 0046（qno nullable 适配，逐处申报）：newQno 允许 null（未编号草稿拆分 → 两半均未编号）
export function splitDraft(draft: ProofItem, atText: string, opts?: { newQno?: number | null }): SplitResult {
  if (!atText) return { ok: false, error: 'atText 为空' };

  const contentInner = unwrapQuestionRoot(draft.contentHtml);
  const contentSplit = splitFieldHtml(contentInner, atText);

  let firstContentInner: string;
  let secondContentInner: string;
  let firstAnswer = draft.answerHtml;
  let firstAnalysis = draft.analysisHtml;
  let secondAnswer: string | undefined;
  let secondAnalysis: string | undefined;

  if (contentSplit) {
    firstContentInner = contentSplit.firstHtml;
    secondContentInner = contentSplit.secondHtml;
    // 断点在题面：答案/解析留在前段
  } else if (draft.answerHtml) {
    const answerSplit = splitFieldHtml(draft.answerHtml, atText);
    if (answerSplit) {
      firstContentInner = contentInner;
      secondContentInner = '';
      firstAnswer = answerSplit.firstHtml || undefined;
      secondAnswer = answerSplit.secondHtml || undefined;
      // 解析整体随后段走
      secondAnalysis = draft.analysisHtml;
      firstAnalysis = undefined;
    } else if (draft.analysisHtml) {
      const analysisSplit = splitFieldHtml(draft.analysisHtml, atText);
      if (!analysisSplit) return { ok: false, error: `atText 未命中：${atText}` };
      firstContentInner = contentInner;
      secondContentInner = '';
      firstAnalysis = analysisSplit.firstHtml || undefined;
      secondAnalysis = analysisSplit.secondHtml || undefined;
    } else {
      return { ok: false, error: `atText 未命中：${atText}` };
    }
  } else if (draft.analysisHtml) {
    const analysisSplit = splitFieldHtml(draft.analysisHtml, atText);
    if (!analysisSplit) return { ok: false, error: `atText 未命中：${atText}` };
    firstContentInner = contentInner;
    secondContentInner = '';
    firstAnalysis = analysisSplit.firstHtml || undefined;
    secondAnalysis = analysisSplit.secondHtml || undefined;
  } else {
    return { ok: false, error: `atText 未命中：${atText}` };
  }

  const firstContentHtml = `${QUESTION_ROOT_OPEN}${firstContentInner}${QUESTION_ROOT_CLOSE}`;
  const secondContentHtml = `${QUESTION_ROOT_OPEN}${secondContentInner}${QUESTION_ROOT_CLOSE}`;

  const firstAll = firstContentHtml + (firstAnswer ?? '') + (firstAnalysis ?? '');
  const secondAll = secondContentHtml + (secondAnswer ?? '') + (secondAnalysis ?? '');
  const refs = distributeImageRefs(firstAll, secondAll, draft.imageRefIds);
  const raw = splitRawText(draft.rawText, atText);

  // 0046（qno nullable 适配，逐处申报）：未编号草稿（null）拆分 → 两半均为未编号，人工补号
  const newQno = opts?.newQno ?? (draft.qno === null ? null : draft.qno + 0.5);
  const first: ProofItem = {
    ...draft,
    contentHtml: firstContentHtml,
    ...(firstAnswer !== undefined ? { answerHtml: firstAnswer } : {}),
    ...(firstAnalysis !== undefined ? { analysisHtml: firstAnalysis } : {}),
    imageRefIds: refs.first,
    rawText: raw.first,
    status: 'pending',
  };
  if (firstAnswer === undefined) delete first.answerHtml;
  if (firstAnalysis === undefined) delete first.analysisHtml;

  const second: ProofItem = {
    draftId: `${draft.pageNo}-${newQno}`,
    pageNo: draft.pageNo,
    qno: newQno,
    source: 'manual',
    contentHtml: secondContentHtml,
    ...(secondAnswer !== undefined ? { answerHtml: secondAnswer } : {}),
    ...(secondAnalysis !== undefined ? { analysisHtml: secondAnalysis } : {}),
    imageRefIds: refs.second,
    status: 'pending',
    warnings: [],
    rawText: raw.second,
  };

  return { ok: true, first, second };
}

export interface MergeResult {
  merged: ProofItem;
  consumedIds: string[]; // 并入目标后被消费的条目（调用方置 delete）
}

export function mergeDrafts(items: ProofItem[], intoId: string): MergeResult {
  const target = items.find((it) => it.draftId === intoId);
  if (!target) throw new Error(`合并目标 ${intoId} 不在参与者中`);

  const contentInner = items.map((it) => unwrapQuestionRoot(it.contentHtml)).join('');
  const answers = items.map((it) => it.answerHtml).filter((h): h is string => h !== undefined);
  const analyses = items.map((it) => it.analysisHtml).filter((h): h is string => h !== undefined);
  const imageRefIds: string[] = [];
  for (const it of items) {
    for (const id of it.imageRefIds) {
      if (!imageRefIds.includes(id)) imageRefIds.push(id);
    }
  }

  const merged: ProofItem = {
    ...target,
    contentHtml: `${QUESTION_ROOT_OPEN}${contentInner}${QUESTION_ROOT_CLOSE}`,
    ...(answers.length > 0 ? { answerHtml: answers.join('') } : {}),
    ...(analyses.length > 0 ? { analysisHtml: analyses.join('') } : {}),
    imageRefIds,
    rawText: items.map((it) => it.rawText).join('\n'),
    warnings: items.flatMap((it) => it.warnings),
    status: 'pending',
  };
  if (answers.length === 0) delete merged.answerHtml;
  if (analyses.length === 0) delete merged.analysisHtml;

  return { merged, consumedIds: items.filter((it) => it.draftId !== intoId).map((it) => it.draftId) };
}

/** ProofItem → ScanDraft（对齐 C0 ingest 契约：buildIngestInputs 的入参形状） */
export function proofItemToScanDraft(item: ProofItem): ScanDraft {
  return {
    pageNo: item.pageNo,
    qno: item.qno,
    contentHtml: item.contentHtml,
    ...(item.answerHtml !== undefined ? { answerHtml: item.answerHtml } : {}),
    ...(item.analysisHtml !== undefined ? { analysisHtml: item.analysisHtml } : {}),
    imageRefIds: [...item.imageRefIds],
    rawText: item.rawText,
    warnings: [...item.warnings],
  };
}
