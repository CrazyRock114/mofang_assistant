// C0 Phase 2: 规则切分（决策 §5：规则为主，本 C0 无 AI）
// 规则启发式集中在本文件、常量表驱动（题号/选项/答案前缀/章节头正则），便于回归调整。
//
// 关键取舍（详见交付报告决策清单）：
// - RuleSegmenter.segment 单页无状态：页首内容/章节头进 skipped，题号按行首显式数字切。
// - segmentPaper 跨页 stitching：页首内容续接上一页末题；章节头前的编号段（注意事项）降级 skipped；
//   重复题号（解析区）按答案/解析合并进既有题；行内题号按「期望下一题号」序列约束拆分。

import type {
  OcrImageRef,
  PageSegmentation,
  QuestionBlock,
  QuestionBlockType,
  RecognizedQuestion,
  RuleSegmenter,
  SegmentationResult,
} from '../../shared/contracts/recog-types.js';
import { bboxEquals, bboxIoU, extractImageMarksFromLine } from '../image-refs.js';

// ===== 常量表 =====
/** 大题章节头（中文数字）：一、选择题 / ## 一、简答题 —— 不切题 */
const CHAPTER_RE = /^#*\s*[一二三四五六七八九十]+\s*、/;
const CHAPTER_INLINE_RE = /[一二三四五六七八九十]+\s*、/g;
/** 题号起始：行首 1. / 13．/ 2、（排除小数：点后不跟数字） */
const QSTART_RE = /^\s*(\d{1,2})\s*[.、．](?!\d)\s*/;
/** 行内题号（仅 . / 、 / ． 形式；「章-题号」形式一律不做行内拆分——正文里的「图2-3」太常见） */
const QSTART_INLINE_RE = /(\d{1,2})\s*[.、．](?!\d)\s*/g;
/**
 * 「章-题号」式行首题号：`2-17 题干…`（题集/教材/录题截图的常态编号）。
 * 只在行首认、且标记后必须紧跟题面内容——行首孤立的 `2-3`（页码/范围标注）不当题号。
 * 破折号变体覆盖 OCR 可能的输出：半角 - / en dash – / 减号 − / 全角 －（不含中文破折号 ——）。
 */
const QSTART_HYPHEN_RE = /^\s*(\d{1,3})\s*[-–−－]\s*(\d{1,3})\s*/;
/** 选项行：A. / B．（仅大写 A-E，行首） */
const OPTION_RE = /^\s*[A-E]\s*[.、．]\s*/;
/** 答案/解析段起始 */
const ANSWER_START_RE = /^(【答案】|答案\s*[:：]|【解析】|解析\s*[:：])/;
/** 题号后仅剩选项字母：解析区速答，如 "5.D" → 答案 'D' */
const BARE_ANSWER_RE = /^[A-E]{1,4}\s*$/;

export const SKIP_REASON = {
  FRONT: '页首未归属内容',
  CHAPTER: '大题章节头',
  PRE_CHAPTER_NUMBERED: '章节头前编号内容（注意事项等）',
} as const;

// ===== 页内解析（行级 → 有序 item 流）=====
type PageItem =
  | { kind: 'front'; blocks: QuestionBlock[]; rawLines: string[] }
  | { kind: 'chapter'; raw: string }
  | { kind: 'question'; qno: number; blocks: QuestionBlock[]; rawLines: string[] };

interface ParseCtx {
  pageNo: number;
  imageRefs: OcrImageRef[];
  consumedRefIds: Set<string>;
}

/** IoU 低于该值视为无重叠，回退顺序对齐（D7 图块绑定：先精确，再就近重叠，最后顺序回退） */
const BBOX_MATCH_IOU_FLOOR = 0.3;

/** 图位标记 → 图引用绑定：精确 bbox 全等优先；否则取未消费引用中 IoU 最大者（≥地板）；再回退顺序对齐 */
function bindImageRef(bbox: { x: number; y: number; w: number; h: number }, ctx: ParseCtx): string | undefined {
  const remaining = ctx.imageRefs.filter((r) => !ctx.consumedRefIds.has(r.id));
  if (remaining.length === 0) return undefined;

  let best = remaining.find((r) => bboxEquals(r.bbox, bbox));
  if (!best) {
    let bestIou = 0;
    for (const r of remaining) {
      const iou = bboxIoU(r.bbox, bbox);
      if (iou > bestIou) {
        bestIou = iou;
        best = r;
      }
    }
    if (bestIou < BBOX_MATCH_IOU_FLOOR) best = undefined;
  }
  best ??= remaining[0]; // 顺序回退
  ctx.consumedRefIds.add(best.id);
  return best.id;
}

function isAnalysisContext(block: QuestionBlock | undefined): boolean {
  return block !== undefined && (block.type === 'answer' || block.type === 'analysis');
}

function addBlock(holder: { blocks: QuestionBlock[] }, ctx: ParseCtx, qno: number | 'front', type: QuestionBlockType, text: string, imageRefId?: string): QuestionBlock {
  const idx = holder.blocks.filter((b) => b.type === type).length;
  const block: QuestionBlock = { id: `${ctx.pageNo}-${qno}-${type}-${idx}`, type, text };
  if (imageRefId !== undefined) block.imageRefId = imageRefId;
  holder.blocks.push(block);
  return block;
}

function parsePageLines(lines: string[], ctx: ParseCtx): PageItem[] {
  const items: PageItem[] = [];
  let front: Extract<PageItem, { kind: 'front' }> = { kind: 'front', blocks: [], rawLines: [] };
  let currentQ: Extract<PageItem, { kind: 'question' }> | null = null;
  let ctxBlock: QuestionBlock | undefined;

  const holder = (): { blocks: QuestionBlock[]; rawLines: string[] } => currentQ ?? front;

  for (const rawLine of lines) {
    const { marks, rest } = extractImageMarksFromLine(rawLine);
    const line = rest.trim();
    if (marks.length > 0) holder().rawLines.push(rawLine);
    for (const mark of marks) {
      const refId = bindImageRef(mark.bbox, ctx);
      const h = holder();
      addBlock(h, ctx, currentQ ? currentQ.qno : 'front', 'image', mark.raw, refId);
      ctxBlock = h.blocks[h.blocks.length - 1];
    }
    if (!line) continue;

    const chapterMatch = line.match(CHAPTER_RE);
    const dotStart = line.match(QSTART_RE);
    const chapterStart = dotStart ? null : line.match(QSTART_HYPHEN_RE);
    const chapterBody = chapterStart ? line.slice(chapterStart[0].length).trim() : '';
    // 题号两种形态二选一：主流试卷 `1.`/`1、`；题集截图「章-题号」`2-17`（须带题面内容）
    const qno = dotStart ? Number(dotStart[1]) : chapterBody ? Number(chapterStart![2]) : null;

    if (chapterMatch) {
      items.push(front);
      front = { kind: 'front', blocks: [], rawLines: [] };
      if (currentQ) items.push(currentQ);
      currentQ = null;
      ctxBlock = undefined;
      items.push({ kind: 'chapter', raw: line });
      continue;
    }

    if (qno !== null) {
      items.push(front);
      front = { kind: 'front', blocks: [], rawLines: [] };
      if (currentQ) items.push(currentQ);
      const content = dotStart ? line.slice(dotStart[0].length).trim() : chapterBody;
      currentQ = { kind: 'question', qno, blocks: [], rawLines: [rawLine] };
      ctxBlock = undefined;
      if (content) {
        if (ANSWER_START_RE.test(content)) {
          const type: QuestionBlockType = /^【?解析/.test(content) ? 'analysis' : 'answer';
          ctxBlock = addBlock(currentQ, ctx, qno, type, content);
        } else if (BARE_ANSWER_RE.test(content)) {
          ctxBlock = addBlock(currentQ, ctx, qno, 'answer', content);
        } else {
          ctxBlock = addBlock(currentQ, ctx, qno, 'question', content);
        }
      }
      continue;
    }

    const h = holder();
    h.rawLines.push(rawLine);

    if (OPTION_RE.test(line) && !isAnalysisContext(ctxBlock)) {
      ctxBlock = addBlock(h, ctx, currentQ ? currentQ.qno : 'front', 'option', line);
      continue;
    }
    if (ANSWER_START_RE.test(line)) {
      const type: QuestionBlockType = /^【?解析/.test(line) ? 'analysis' : 'answer';
      ctxBlock = addBlock(h, ctx, currentQ ? currentQ.qno : 'front', type, line);
      continue;
    }
    // 普通文本行：题面/答案/解析块续行；否则在页首或选项/图后开新题面块
    if (ctxBlock && (ctxBlock.type === 'question' || ctxBlock.type === 'answer' || ctxBlock.type === 'analysis')) {
      ctxBlock.text += '\n' + line;
      continue;
    }
    ctxBlock = addBlock(h, ctx, currentQ ? currentQ.qno : 'front', 'question', line);
  }

  items.push(front);
  if (currentQ) items.push(currentQ);
  return items.filter((it) => (it.kind === 'chapter' ? true : it.rawLines.length > 0));
}

function toRecognizedQuestion(item: Extract<PageItem, { kind: 'question' }>, pageNo: number): RecognizedQuestion {
  return {
    id: `${pageNo}-${item.qno}`,
    pageNo,
    qno: item.qno,
    blocks: item.blocks,
    imageRefIds: item.blocks.filter((b) => b.type === 'image' && b.imageRefId !== undefined).map((b) => b.imageRefId!),
    rawText: item.rawLines.join('\n'),
  };
}

// ===== 单页无状态切分（契约实现）=====
class RuleSegmenterImpl implements RuleSegmenter {
  segment(text: string, opts: { pageNo: number; imageRefs: OcrImageRef[] }): PageSegmentation {
    const items = parsePageLines(text.split('\n'), { pageNo: opts.pageNo, imageRefs: opts.imageRefs, consumedRefIds: new Set() });
    const questions: RecognizedQuestion[] = [];
    const skipped: { rawText: string; reason: string }[] = [];
    for (const item of items) {
      if (item.kind === 'question') {
        questions.push(toRecognizedQuestion(item, opts.pageNo));
      } else if (item.kind === 'chapter') {
        skipped.push({ rawText: item.raw, reason: SKIP_REASON.CHAPTER });
      } else if (item.rawLines.join('\n').trim()) {
        skipped.push({ rawText: item.rawLines.join('\n'), reason: SKIP_REASON.FRONT });
      }
    }
    return { pageNo: opts.pageNo, questions, skipped };
  }
}

export function createRuleSegmenter(): RuleSegmenter {
  return new RuleSegmenterImpl();
}

// ===== 跨页 stitching =====
interface AcceptedEntry {
  q: RecognizedQuestion;
  pageOut: PageSegmentation;
}

/** 行内题号/章节头拆分：仅按「期望下一题号」或「既有题号+答案/解析前缀」高置信拆分 */
function splitInline(
  lines: string[],
  state: { expected: number; acceptedQnos: ReadonlySet<number> },
): string[] {
  const chapterSplit: string[] = [];
  for (const line of lines) {
    let start = 0;
    for (const m of line.matchAll(CHAPTER_INLINE_RE)) {
      if (m.index === 0) continue;
      chapterSplit.push(line.slice(start, m.index));
      start = m.index;
    }
    chapterSplit.push(line.slice(start));
  }

  const out: string[] = [];
  for (const line of chapterSplit) {
    const segments: string[] = [];
    let start = 0;
    const head = line.match(QSTART_RE);
    let scanFrom = 0;
    if (head && Number(head[1]) === state.expected) {
      state.expected++;
      scanFrom = head[0].length;
    }
    QSTART_INLINE_RE.lastIndex = scanFrom;
    let m: RegExpExecArray | null;
    while ((m = QSTART_INLINE_RE.exec(line)) !== null) {
      const qno = Number(m[1]);
      const after = line.slice(m.index + m[0].length).trimStart();
      const isNext = qno === state.expected;
      const isAnswerZone = state.acceptedQnos.has(qno) && ANSWER_START_RE.test(after);
      if (!isNext && !isAnswerZone) continue;
      segments.push(line.slice(start, m.index));
      start = m.index;
      if (isNext) state.expected++;
      QSTART_INLINE_RE.lastIndex = m.index + m[0].length;
    }
    segments.push(line.slice(start));
    out.push(...segments);
  }
  return out;
}

/** 续接/合并块：按目标题重排块 id；目标处于答案/解析上下文时非图块统一转 analysis */
function appendBlocks(target: RecognizedQuestion, blocks: QuestionBlock[], sourcePageNo: number, forceAnalysis: boolean): void {
  const lastType = target.blocks[target.blocks.length - 1]?.type;
  const inAnalysis = forceAnalysis || lastType === 'answer' || lastType === 'analysis';
  for (const block of blocks) {
    const type: QuestionBlockType = inAnalysis && block.type !== 'image' ? 'analysis' : block.type;
    const idx = target.blocks.filter((b) => b.type === type).length;
    const next: QuestionBlock = { id: `${sourcePageNo}-${target.qno}-${type}-${idx}`, type, text: block.text };
    if (block.imageRefId !== undefined) next.imageRefId = block.imageRefId;
    target.blocks.push(next);
    if (next.type === 'image' && next.imageRefId !== undefined && !target.imageRefIds.includes(next.imageRefId)) {
      target.imageRefIds.push(next.imageRefId);
    }
  }
}

/**
 * 整卷 stitching：pages 按给定顺序处理。
 * - 页首内容（第一个题号之前）：上一页末题未闭合则续接（同 qno），否则进 skipped。
 * - 第一个章节头之前的编号段（注意事项等）：章节头出现时整段降级 skipped。
 * - 重复题号：内容以答案/解析前缀起始 → 块并入既有题；否则按解析区续文合并并记 warning。
 */
export function segmentPaper(pages: Array<{ text: string; pageNo: number; imageRefs: OcrImageRef[] }>): SegmentationResult {
  const warnings: string[] = [];
  const pagesOut: PageSegmentation[] = pages.map((p) => ({ pageNo: p.pageNo, questions: [], skipped: [] }));
  const accepted = new Map<number, AcceptedEntry>();
  let run: AcceptedEntry[] = [];
  let chapterCount = 0;
  let lastQno = 0;
  let lastQuestion: AcceptedEntry | null = null;

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const pageOut = pagesOut[i];
    const state = { expected: lastQno + 1, acceptedQnos: new Set(accepted.keys()) };
    const lines = splitInline(page.text.split('\n'), state);
    const items = parsePageLines(lines, { pageNo: page.pageNo, imageRefs: page.imageRefs, consumedRefIds: new Set() });

    for (const item of items) {
      if (item.kind === 'chapter') {
        chapterCount++;
        pageOut.skipped.push({ rawText: item.raw, reason: SKIP_REASON.CHAPTER });
        if (chapterCount === 1 && run.length > 0) {
          for (const entry of run) {
            entry.pageOut.questions = entry.pageOut.questions.filter((q) => q !== entry.q);
            entry.pageOut.skipped.push({ rawText: entry.q.rawText, reason: SKIP_REASON.PRE_CHAPTER_NUMBERED });
            accepted.delete(entry.q.qno);
          }
          warnings.push(`第${page.pageNo}页出现首个章节头，其前编号段 ${run.map((e) => e.q.qno).join('/')} 降级为 skipped（注意事项等）`);
          run = [];
          lastQno = 0;
          lastQuestion = null;
        }
        continue;
      }

      if (item.kind === 'front') {
        const raw = item.rawLines.join('\n');
        if (!raw.trim()) continue;
        if (lastQuestion) {
          appendBlocks(lastQuestion.q, item.blocks, page.pageNo, false);
          lastQuestion.q.rawText += '\n' + raw;
        } else {
          pageOut.skipped.push({ rawText: raw, reason: SKIP_REASON.FRONT });
        }
        continue;
      }

      const q = toRecognizedQuestion(item, page.pageNo);
      const existing = accepted.get(q.qno);
      if (existing) {
        const firstBlock = q.blocks[0];
        const answerZone = firstBlock !== undefined && (firstBlock.type === 'answer' || firstBlock.type === 'analysis');
        appendBlocks(existing.q, q.blocks, page.pageNo, !answerZone);
        existing.q.rawText += '\n' + q.rawText;
        if (!answerZone) {
          warnings.push(`第${page.pageNo}页题号 ${q.qno} 重复且非答案/解析前缀，按解析区续文合并`);
        }
        lastQuestion = existing;
        continue;
      }

      if (lastQno > 0 && q.qno !== lastQno + 1) {
        warnings.push(`题号不连续：第${page.pageNo}页 q${q.qno}，上一题 q${lastQno}`);
      }
      const entry: AcceptedEntry = { q, pageOut };
      accepted.set(q.qno, entry);
      pageOut.questions.push(q);
      run.push(entry);
      lastQno = q.qno;
      lastQuestion = entry;
    }
  }

  // 零题但确有文字：给出可诊断的告警（否则 UI 只显示「没有切出题目」，用户无从判断是识别失败还是切分失败）
  const totalQuestions = pagesOut.reduce((n, p) => n + p.questions.length, 0);
  const totalChars = pages.reduce((n, p) => n + p.text.trim().length, 0);
  if (totalQuestions === 0 && totalChars > 0) {
    warnings.push(
      `整卷未切出题目（识别到 ${totalChars} 字）：题号须在行首，当前支持「1.」「1、」「2-17」等；请确认原图是否含题号`,
    );
  }

  return { pages: pagesOut, warnings };
}
