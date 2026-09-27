// 0036 P1：工作区模型 / 草稿防抖存取 / 页图缓存 LRU 单测（任务书 §四 TDD 第二项）
// @vitest-environment node

import { describe, it, expect, vi } from 'vitest';
import {
  SEGMENT_SUGGESTED_PAGES, boxesInSegment, createEmptyDraft, defaultSegmentTitle, defaultSegments,
  draftSummary, makeSegment, nextSegmentId, parseDraftJson, patchRun, runOf, sanitizeDraft,
  segmentDraftOf, segmentPageCount, segmentsBlockingSave, segmentsOfPage, toSummary, upsertRun,
  validateSegments, withSegmentDraft,
} from '../../src/recog/splitting/workspace-model.js';
import { DRAFT_SAVE_DEBOUNCE_MS, createDebouncedSaver, type SaveState } from '../../src/recog/splitting/auto-save.js';
import {
  PAGE_CACHE_LIMIT, createLruCache, createPageImageCache, renderPolicyKey,
} from '../../src/recog/splitting/page-cache.js';
import type { SplitBox, SplitProjectMeta, SplitRunLink, SplitSegment } from '../../src/shared/contracts/split-types.js';

const NOW = '2026-09-18T10:00:00.000Z';

function seg(id: string, from: number, to: number, title?: string): SplitSegment {
  return makeSegment(id, from, to, NOW, title);
}

function box(id: string, qid: string, page: number): SplitBox {
  return { id, qid, type: 'text', page, x: 0.1, y: 0.1, w: 0.2, h: 0.1 };
}

describe('0036 P1：切段 meta 校验', () => {
  it('空段集是 error（没有段就没有工作区）', () => {
    const issues = validateSegments([], 30);
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe('error');
  });

  it('页码越界是 error', () => {
    const issues = validateSegments([seg('seg1', 1, 20), seg('seg2', 25, 40)], 30);
    expect(issues.filter((i) => i.level === 'error').map((i) => i.segmentId)).toEqual(['seg2']);
  });

  it('起始页大于结束页是 error', () => {
    const issues = validateSegments([seg('seg1', 20, 10)], 30);
    expect(issues.some((i) => i.level === 'error' && i.message.includes('起始页大于结束页'))).toBe(true);
  });

  it('段编号重复是 error', () => {
    const issues = validateSegments([seg('seg1', 1, 5), seg('seg1', 6, 10)], 30);
    expect(issues.some((i) => i.level === 'error' && i.message.includes('编号重复'))).toBe(true);
  });

  it('超过建议页数只是 warning（任务书：每段「建议」≤15 页，不是硬上限）', () => {
    const issues = validateSegments([seg('seg1', 1, 16)], 30);
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe('warning');
    expect(segmentsBlockingSave(issues)).toEqual([]);
  });

  it('段间页码重叠合法（跨页题两端各留余量是常态，不做互斥校验）', () => {
    expect(validateSegments([seg('seg1', 1, 15), seg('seg2', 14, 28)], 30)).toEqual([]);
  });

  it('页数未知（0=尚未确认）时跳过越界校验，但仍查结构问题', () => {
    expect(validateSegments([seg('seg1', 1, 10)], 0)).toEqual([]);
    expect(validateSegments([seg('seg1', 5, 1)], 0).some((i) => i.level === 'error')).toBe(true);
  });

  it('默认按建议页数顺切（32 页 → 15/15/2）', () => {
    const segs = defaultSegments(32, NOW);
    expect(SEGMENT_SUGGESTED_PAGES).toBe(15);
    expect(segs.map((s) => [s.fromPage, s.toPage])).toEqual([[1, 15], [16, 30], [31, 32]]);
    expect(segs.map((s) => s.id)).toEqual(['seg1', 'seg2', 'seg3']);
    expect(segs[2].title).toBe('第 31–32 页');
  });

  it('0 页不产生段', () => {
    expect(defaultSegments(0, NOW)).toEqual([]);
  });

  it('段标题与页码工具', () => {
    expect(defaultSegmentTitle(7, 7)).toBe('第 7 页');
    expect(segmentPageCount(seg('seg1', 1, 15))).toBe(15);
    expect(segmentsOfPage([seg('seg1', 1, 15), seg('seg2', 14, 28)], 14).map((s) => s.id)).toEqual(['seg1', 'seg2']);
    expect(segmentsOfPage([seg('seg1', 1, 15)], 20)).toEqual([]);
  });

  it('新段编号续号不复用', () => {
    expect(nextSegmentId([seg('seg1', 1, 5), seg('seg3', 6, 9)])).toBe('seg4');
    expect(nextSegmentId([])).toBe('seg1');
  });
});

describe('0036 P1：草稿结构（按段独立）', () => {
  it('缺省段草稿是空框空队列（读路径不写回，不产生副作用）', () => {
    const draft = createEmptyDraft(NOW);
    expect(segmentDraftOf(draft, 'seg1')).toEqual({ boxes: [], runs: [] });
    expect(draft.segments).toEqual({});
  });

  it('写回段草稿是不可变更新（旧引用不被改，updatedAt 前进）', () => {
    const draft = createEmptyDraft(NOW);
    const nextAt = '2026-09-18T10:00:05.000Z';
    const next = withSegmentDraft(draft, 'seg1', { boxes: [box('p1-b1', 'q1', 1)], runs: [] }, nextAt);
    expect(draft.segments).toEqual({});
    expect(next.segments.seg1.boxes).toHaveLength(1);
    expect(next.updatedAt).toBe(nextAt);
  });

  it('段与段之间草稿隔离（各段独立识别队列）', () => {
    const draft = withSegmentDraft(
      withSegmentDraft(createEmptyDraft(NOW), 'seg1', { boxes: [box('p1-b1', 'q1', 1)], runs: [] }, NOW),
      'seg2',
      { boxes: [box('p20-b2', 'q1', 20)], runs: [] },
      NOW,
    );
    expect(draft.segments.seg1.boxes.map((b) => b.page)).toEqual([1]);
    expect(draft.segments.seg2.boxes.map((b) => b.page)).toEqual([20]);
  });

  it('run 关联 upsert / patch / 查询', () => {
    const r1: SplitRunLink = { qid: 'q1', runId: 'run-1', status: 'creating', questionIds: [] };
    let runs = upsertRun([], r1);
    expect(runOf(runs, 'q1')).toEqual(r1);
    runs = upsertRun(runs, { ...r1, questionIds: ['a'] });
    expect(runs).toHaveLength(1);
    runs = patchRun(runs, 'q1', { status: 'done', questionIds: ['a', 'b'] });
    expect(runOf(runs, 'q1')?.status).toBe('done');
    expect(runOf(runs, 'q1')?.questionIds).toEqual(['a', 'b']);
    // 未知 qid 原样返回（不新增脏记录）
    expect(patchRun(runs, 'q9', { status: 'done' })).toBe(runs);
    expect(runOf(runs, 'q9')).toBeNull();
  });

  it('按段取框（段区间外的框不进本段草稿视图）', () => {
    const boxes = [box('p1-b1', 'q1', 1), box('p16-b2', 'q2', 16), box('p30-b3', 'q3', 30)];
    expect(boxesInSegment(boxes, seg('seg1', 1, 15)).map((b) => b.id)).toEqual(['p1-b1']);
    expect(boxesInSegment(boxes, seg('seg2', 16, 30)).map((b) => b.id)).toEqual(['p16-b2', 'p30-b3']);
  });

  it('草稿概览统计框/题/run 数', () => {
    const draft = withSegmentDraft(
      createEmptyDraft(NOW),
      'seg1',
      {
        boxes: [box('p1-b1', 'q1', 1), box('p1-b2', 'q1', 1), box('p1-b3', 'q2', 1)],
        runs: [{ qid: 'q1', runId: 'run-1', status: 'done', questionIds: [] }],
      },
      NOW,
    );
    expect(draftSummary(draft)).toEqual({ boxCount: 3, questionCount: 2, runCount: 1 });
  });
});

describe('0036 P1：草稿读取净化（手改坏一个框不该让整份现场消失）', () => {
  it('逐条丢弃非法框，合法框与 run 保留', () => {
    const raw = {
      version: 1,
      updatedAt: NOW,
      segments: {
        seg1: {
          boxes: [
            { id: 'p1-b1', qid: 'q1', type: 'text', page: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.1 },
            { id: 'bad-type', qid: 'q1', type: 'sticker', page: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.1 },
            { id: 'zero-area', qid: 'q1', type: 'text', page: 1, x: 0.1, y: 0.1, w: 0, h: 0.1 },
            { id: 'no-qid', type: 'text', page: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.1 },
            { id: 'bad-page', qid: 'q1', type: 'text', page: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.1 },
          ],
          runs: [
            { qid: 'q1', runId: 'run-1', status: 'ocr', questionIds: ['a', ''] },
            { qid: 'q2', runId: 'run-2', status: 'wat', questionIds: [] },
          ],
        },
      },
    };
    const draft = sanitizeDraft(raw, NOW);
    expect(draft.segments.seg1.boxes.map((b) => b.id)).toEqual(['p1-b1']);
    expect(draft.segments.seg1.runs).toHaveLength(1);
    expect(draft.segments.seg1.runs[0].questionIds).toEqual(['a']);
    expect(draft.version).toBe(1);
  });

  it('缺 updatedAt 时回落给定时刻；segments 缺失给空表', () => {
    const draft = sanitizeDraft({ version: 1 }, NOW);
    expect(draft.updatedAt).toBe(NOW);
    expect(draft.segments).toEqual({});
  });

  it('parseDraftJson 走同一净化路径', () => {
    const draft = parseDraftJson(JSON.stringify({ segments: { seg1: { boxes: [], runs: [] } } }), NOW);
    expect(draft.segments.seg1).toEqual({ boxes: [], runs: [] });
  });

  it('项目元 → 列表项摘要', () => {
    const meta: SplitProjectMeta = {
      id: 'p1', name: '教辅 A', sourceName: 'a.pdf', sourceBytes: 10, pageCount: 30,
      segments: [seg('seg1', 1, 15)], createdAt: NOW, updatedAt: NOW,
    };
    expect(toSummary(meta)).toEqual({
      id: 'p1', name: '教辅 A', sourceName: 'a.pdf', pageCount: 30, segmentCount: 1, updatedAt: NOW,
    });
  });
});

describe('0036 P1：草稿防抖自动存（1.5s）', () => {
  it('防抖窗口 1.5s（任务书口径）', () => {
    expect(DRAFT_SAVE_DEBOUNCE_MS).toBe(1500);
  });

  it('窗口内多次改动只落盘一次，且存的是最后值', async () => {
    vi.useFakeTimers();
    try {
      const save = vi.fn(async (_v: string) => undefined);
      const saver = createDebouncedSaver<string>({ save, now: () => NOW });
      saver.schedule('v1');
      vi.advanceTimersByTime(1000);
      saver.schedule('v2');
      vi.advanceTimersByTime(1000);
      expect(save).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(600);
      expect(save).toHaveBeenCalledTimes(1);
      expect(save).toHaveBeenCalledWith('v2');
      expect(saver.state()).toBe('saved');
      expect(saver.lastSavedAt()).toBe(NOW);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flush 立即落盘（切段/关页/失焦用），且幂等', async () => {
    vi.useFakeTimers();
    try {
      const save = vi.fn(async (_v: string) => undefined);
      const saver = createDebouncedSaver<string>({ save });
      saver.schedule('v1');
      expect(saver.pending()).toBe(true);
      await saver.flush();
      expect(save).toHaveBeenCalledTimes(1);
      expect(saver.pending()).toBe(false);
      await saver.flush();
      expect(save).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('保存中又来新值 → 串行排队（不并发写盘，防后写覆盖前写）', async () => {
    vi.useFakeTimers();
    try {
      const order: string[] = [];
      const gate: Array<() => void> = [];
      const save = vi.fn(async (v: string) => {
        order.push(`start:${v}`);
        await new Promise<void>((resolve) => {
          gate.push(resolve);
        });
        order.push(`end:${v}`);
      });
      const saver = createDebouncedSaver<string>({ save, delayMs: 10 });
      saver.schedule('v1');
      await vi.advanceTimersByTimeAsync(20);
      // v1 正在写盘，此时又排入 v2
      saver.schedule('v2');
      await vi.advanceTimersByTimeAsync(20);
      expect(order).toEqual(['start:v1']);
      gate.shift()?.();
      await vi.advanceTimersByTimeAsync(20);
      expect(order).toEqual(['start:v1', 'end:v1', 'start:v2']);
      gate.shift()?.();
      await vi.advanceTimersByTimeAsync(20);
      expect(order).toEqual(['start:v1', 'end:v1', 'start:v2', 'end:v2']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('保存失败不吞：状态停 error 并带上原因', async () => {
    const states: SaveState[] = [];
    const saver = createDebouncedSaver<string>({
      save: async () => {
        throw new Error('磁盘满了');
      },
      onState: (s) => states.push(s),
    });
    saver.schedule('v1');
    await saver.flush();
    expect(saver.state()).toBe('error');
    expect(saver.lastError()).toBe('磁盘满了');
    expect(states).toEqual(['pending', 'saving', 'error']);
  });

  it('dispose 后不再触发落盘', async () => {
    vi.useFakeTimers();
    try {
      const save = vi.fn(async (_v: string) => undefined);
      const saver = createDebouncedSaver<string>({ save });
      saver.schedule('v1');
      saver.dispose();
      await vi.advanceTimersByTimeAsync(5000);
      expect(save).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('0036 P1：页图 LRU 缓存', () => {
  it('上限即 PAGE_CACHE_LIMIT，超出逐出最久未用', () => {
    const lru = createLruCache<string, number>(PAGE_CACHE_LIMIT);
    for (let i = 1; i <= PAGE_CACHE_LIMIT + 2; i++) lru.set(`p${i}`, i);
    expect(lru.size()).toBe(PAGE_CACHE_LIMIT);
    expect(lru.has('p1')).toBe(false);
    expect(lru.has('p2')).toBe(false);
    expect(lru.has(`p${PAGE_CACHE_LIMIT + 2}`)).toBe(true);
  });

  it('get 命中刷新使用序（被读过的页不会被新页挤掉）', () => {
    const lru = createLruCache<string, number>(3);
    lru.set('a', 1);
    lru.set('b', 2);
    lru.set('c', 3);
    expect(lru.get('a')).toBe(1);
    lru.set('d', 4);
    expect(lru.has('b')).toBe(false);
    expect(lru.has('a')).toBe(true);
    expect(lru.keys()).toEqual(['c', 'a', 'd']);
  });

  it('渲染档变更即失效（换缩放不误命中原位图）', () => {
    const cache = createPageImageCache<{ bytes: number; key: string }>();
    cache.set(3, 2, { bytes: 100, key: renderPolicyKey(3, 2) });
    expect(cache.get(3, 2)).toEqual({ bytes: 100, key: 'p3@s2' });
    expect(cache.get(3, 1)).toBeUndefined();
    expect(renderPolicyKey(3, 1)).toBe('p3@s1');
  });

  it('字节预算超限也逐出（一页超大图不吃光全部额度）', () => {
    const cache = createPageImageCache<{ bytes: number; key: string }>(6, 250);
    cache.set(1, 1, { bytes: 100, key: renderPolicyKey(1, 1) });
    cache.set(2, 1, { bytes: 100, key: renderPolicyKey(2, 1) });
    expect(cache.bytes()).toBe(200);
    cache.set(3, 1, { bytes: 100, key: renderPolicyKey(3, 1) });
    expect(cache.bytes()).toBeLessThanOrEqual(250);
    expect(cache.get(1, 1)).toBeUndefined();
    expect(cache.get(3, 1)).toBeDefined();
  });
});
