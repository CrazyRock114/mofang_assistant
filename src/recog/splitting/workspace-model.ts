// 0036 P1：工作区模型（切段 meta 校验 / 草稿结构 / 草稿净化）——纯函数域，渲染层与主进程共用同一真源
//
// 「同一份校验两端共用」是刻意的：渲染层用它做即时红字反馈，主进程 saveMeta 用它做硬校验，
// 不存在「前端放行、后端拒绝」的双轨漂移。

import type {
  SplitBox, SplitDraft, SplitProjectMeta, SplitProjectSummary, SplitRunLink, SplitSegment, SplitSegmentDraft,
} from '../../shared/contracts/split-types.js';

/** 每段建议页数（任务书 §一 P1：每段建议 ≤15 页，允许重叠）——超了是 warning 不是 error */
export const SEGMENT_SUGGESTED_PAGES = 15;

export interface SegmentIssue {
  /** 关联段 id（整体性问题上缺省） */
  segmentId?: string;
  level: 'error' | 'warning';
  message: string;
}

/**
 * 切段校验（草稿/保存两端共用）。
 * error 会拦住保存：页码越界/区间倒置/编号重复会让「段 3 = 第 40–30 页」这种数据进库（工作区文件态）。
 * 段间**重叠允许**（跨页题两端各留余量是常态），故不做互斥校验。
 */
export function validateSegments(segments: SplitSegment[], pageCount: number): SegmentIssue[] {
  const issues: SegmentIssue[] = [];
  if (segments.length === 0) {
    issues.push({ level: 'error', message: '至少要有一个切段（按章节/页码区间切，每段建议 ≤15 页）' });
    return issues;
  }
  if (pageCount > 0) {
    for (const seg of segments) {
      if (seg.fromPage < 1 || seg.toPage > pageCount) {
        issues.push({
          segmentId: seg.id,
          level: 'error',
          message: `段「${seg.title}」页码越界：${seg.fromPage}–${seg.toPage}（总页数 ${pageCount}）`,
        });
      }
    }
  }
  for (const seg of segments) {
    if (seg.fromPage > seg.toPage) {
      issues.push({ segmentId: seg.id, level: 'error', message: `段「${seg.title}」起始页大于结束页` });
    }
  }
  const seen = new Set<string>();
  for (const seg of segments) {
    if (seen.has(seg.id)) {
      issues.push({ segmentId: seg.id, level: 'error', message: `段编号重复：${seg.id}` });
    }
    seen.add(seg.id);
  }
  for (const seg of segments) {
    const pages = seg.toPage - seg.fromPage + 1;
    if (pages > SEGMENT_SUGGESTED_PAGES) {
      issues.push({
        segmentId: seg.id,
        level: 'warning',
        message: `段「${seg.title}」共 ${pages} 页，超过建议的 ${SEGMENT_SUGGESTED_PAGES} 页（识别慢且校对费劲，建议再切细）`,
      });
    }
  }
  return issues;
}

export function segmentsBlockingSave(issues: SegmentIssue[]): string[] {
  return issues.filter((i) => i.level === 'error').map((i) => i.message);
}

export function segmentPageCount(segment: SplitSegment): number {
  return Math.max(0, segment.toPage - segment.fromPage + 1);
}

export function segmentsOfPage(segments: SplitSegment[], page: number): SplitSegment[] {
  return segments.filter((s) => page >= s.fromPage && page <= s.toPage);
}

export function nextSegmentId(segments: SplitSegment[]): string {
  let max = 0;
  for (const s of segments) {
    const m = s.id.match(/^seg(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `seg${max + 1}`;
}

export function defaultSegmentTitle(fromPage: number, toPage: number): string {
  return fromPage === toPage ? `第 ${fromPage} 页` : `第 ${fromPage}–${toPage} 页`;
}

export function makeSegment(id: string, fromPage: number, toPage: number, createdAt: string, title?: string): SplitSegment {
  return {
    id,
    title: title?.trim() ? title.trim() : defaultSegmentTitle(fromPage, toPage),
    fromPage,
    toPage,
    createdAt,
  };
}

/**
 * 导入 PDF 后的默认切段：按 SEGMENT_SUGGESTED_PAGES 顺切。
 * 「按章节」需要人读目录，机器猜不准——默认给出机器能保证正确的页码顺切，章节名由用户改。
 */
export function defaultSegments(pageCount: number, createdAt: string, chunk = SEGMENT_SUGGESTED_PAGES): SplitSegment[] {
  const out: SplitSegment[] = [];
  if (pageCount <= 0) return out;
  for (let from = 1; from <= pageCount; from += chunk) {
    const to = Math.min(pageCount, from + chunk - 1);
    const id = `seg${out.length + 1}`;
    out.push(makeSegment(id, from, to, createdAt));
  }
  return out;
}

// ==================== 草稿 ====================

export function emptySegmentDraft(): SplitSegmentDraft {
  return { boxes: [], runs: [] };
}

export function createEmptyDraft(now: string): SplitDraft {
  return { version: 1, segments: {}, updatedAt: now };
}

/** 取段草稿（缺省给空草稿，不写回——读路径不产生副作用） */
export function segmentDraftOf(draft: SplitDraft, segmentId: string): SplitSegmentDraft {
  return draft.segments[segmentId] ?? emptySegmentDraft();
}

/** 写回段草稿（不可变更新；updatedAt 由调用方给的 now 决定，便于测试） */
export function withSegmentDraft(
  draft: SplitDraft,
  segmentId: string,
  next: SplitSegmentDraft,
  now: string,
): SplitDraft {
  return {
    ...draft,
    segments: { ...draft.segments, [segmentId]: next },
    updatedAt: now,
  };
}

export function upsertRun(runs: SplitRunLink[], link: SplitRunLink): SplitRunLink[] {
  const idx = runs.findIndex((r) => r.qid === link.qid);
  if (idx < 0) return [...runs, link];
  const next = [...runs];
  next[idx] = link;
  return next;
}

export function patchRun(runs: SplitRunLink[], qid: string, patch: Partial<SplitRunLink>): SplitRunLink[] {
  const idx = runs.findIndex((r) => r.qid === qid);
  if (idx < 0) return runs;
  const next = [...runs];
  next[idx] = { ...next[idx], ...patch };
  return next;
}

export function runOf(runs: SplitRunLink[], qid: string): SplitRunLink | null {
  return runs.find((r) => r.qid === qid) ?? null;
}

/** 段内框（按页、按画框顺序） */
export function boxesInSegment(boxes: SplitBox[], segment: SplitSegment): SplitBox[] {
  return boxes.filter((b) => b.page >= segment.fromPage && b.page <= segment.toPage);
}

export function countRunsByStatus(runs: SplitRunLink[], status: SplitRunLink['status']): number {
  return runs.filter((r) => r.status === status).length;
}

// ==================== 读取净化（draft.json 可能被手改/写坏） ====================

/** project.json / draft.json 的宽结构（JSON.parse 的落地形态；不引入 any/unknown） */
export interface RawSplitDraft {
  version?: number;
  segments?: Record<string, { boxes?: RawBox[]; runs?: RawRun[] }>;
  updatedAt?: string;
}
interface RawBox {
  id?: string;
  qid?: string;
  type?: string;
  page?: number;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}
interface RawRun {
  qid?: string;
  runId?: string;
  status?: string;
  questionIds?: string[];
  error?: string | null;
}

const BOX_TYPES = ['text', 'image', 'answer'];
const RUN_STATUSES = ['creating', 'queued', 'ocr', 'ai', 'done', 'error', 'cancelled'];

function num(value: number | undefined, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function sanitizeBox(raw: RawBox): SplitBox | null {
  if (typeof raw.id !== 'string' || raw.id === '') return null;
  if (typeof raw.qid !== 'string' || raw.qid === '') return null;
  if (typeof raw.type !== 'string' || !BOX_TYPES.includes(raw.type)) return null;
  const page = Math.round(num(raw.page));
  if (page < 1) return null;
  const x = num(raw.x);
  const y = num(raw.y);
  const w = num(raw.w);
  const h = num(raw.h);
  if (w <= 0 || h <= 0) return null;
  return { id: raw.id, qid: raw.qid, type: raw.type as SplitBox['type'], page, x, y, w, h };
}

function sanitizeRun(raw: RawRun): SplitRunLink | null {
  if (typeof raw.qid !== 'string' || raw.qid === '') return null;
  if (typeof raw.runId !== 'string' || raw.runId === '') return null;
  if (typeof raw.status !== 'string' || !RUN_STATUSES.includes(raw.status)) return null;
  const ids = Array.isArray(raw.questionIds) ? raw.questionIds.filter((v) => typeof v === 'string' && v !== '') : [];
  const error = typeof raw.error === 'string' && raw.error ? raw.error : null;
  return { qid: raw.qid, runId: raw.runId, status: raw.status as SplitRunLink['status'], questionIds: ids, error };
}

/**
 * 草稿净化：**逐条丢弃**坏数据而不是整份判失败——手改坏一个框不该让整份草稿（以及用户的现场）消失。
 * 丢弃数量由调用方记录（诊断可见），这里只保证返回值永远结构合法。
 */
export function sanitizeDraft(parsed: RawSplitDraft, fallbackNow: string): SplitDraft {
  const segments: Record<string, SplitSegmentDraft> = {};
  const rawSegments = parsed.segments ?? {};
  for (const key of Object.keys(rawSegments)) {
    const raw = rawSegments[key];
    if (!raw || typeof raw !== 'object') continue;
    const boxes: SplitBox[] = [];
    for (const b of raw.boxes ?? []) {
      const box = sanitizeBox(b);
      if (box) boxes.push(box);
    }
    const runs: SplitRunLink[] = [];
    for (const r of raw.runs ?? []) {
      const run = sanitizeRun(r);
      if (run) runs.push(run);
    }
    segments[key] = { boxes, runs };
  }
  return {
    version: 1,
    segments,
    updatedAt: typeof parsed.updatedAt === 'string' && parsed.updatedAt ? parsed.updatedAt : fallbackNow,
  };
}

export function parseDraftJson(text: string, fallbackNow: string): SplitDraft {
  return sanitizeDraft(JSON.parse(text) as RawSplitDraft, fallbackNow);
}

/** 草稿概览（列表页/状态条用） */
export function draftSummary(draft: SplitDraft): { boxCount: number; questionCount: number; runCount: number } {
  let boxCount = 0;
  const qids = new Set<string>();
  let runCount = 0;
  for (const seg of Object.values(draft.segments)) {
    boxCount += seg.boxes.length;
    for (const b of seg.boxes) qids.add(b.qid);
    runCount += seg.runs.length;
  }
  return { boxCount, questionCount: qids.size, runCount };
}

export function toSummary(meta: SplitProjectMeta): SplitProjectSummary {
  return {
    id: meta.id,
    name: meta.name,
    sourceName: meta.sourceName,
    pageCount: meta.pageCount,
    segmentCount: meta.segments.length,
    updatedAt: meta.updatedAt,
  };
}
