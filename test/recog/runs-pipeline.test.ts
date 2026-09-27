// 0028 P1：runs 编排器（页级有界并发 / 全局闸 / 中断恢复 / 取消 / 事件序列）
// 任务书 §四：编排器——mock provider 断言并发上限、取消、事件序列；中断恢复=预置部分页文件后重跑，断言跳过已有页
// 纯函数域：不碰 SQLite/electron，store 与 provider 全注入

import { describe, it, expect } from 'vitest';
import { createGate, runRecogPipeline, type RecogPipelineStore } from '../../src/recog/runs/pipeline.js';
import type { OcrPageResult } from '../../src/shared/contracts/recog-types.js';
import type { ScanDraft } from '../../src/shared/contracts/recog-types.js';

// ===== 内存 store（模拟「表状态 + 文件 checkpoint」的混合持久化语义）=====
interface PageState { pageNo: number; imageFile: string; ocrFile: string | null; status: string; error: string | null }

function makeStore(pageNos: number[], preDone: number[] = []) {
  const files = new Map<string, OcrPageResult>();
  const pages: PageState[] = pageNos.map((n) => ({
    pageNo: n,
    imageFile: `pages/p${String(n).padStart(3, '0')}.png`,
    ocrFile: null,
    status: 'pending',
    error: null,
  }));
  for (const n of preDone) {
    const key = `ocr/p${n}.json`;
    files.set(key, { pageNo: n, text: `${n}. 预置页 ${n}`, images: [] });
    pages[n - 1].ocrFile = key;
    pages[n - 1].status = 'done';
  }
  const runPatches: Array<Record<string, unknown>> = [];
  const pagePatches: Array<{ pageNo: number; patch: Record<string, unknown> }> = [];
  const draftsWrites: Array<{ count: number; warnings: string[] }> = [];
  const warningsWrites: string[][] = [];
  /** 写入时序（告警须先于终态落库，否则 UI 在 done 上回读看不到原因） */
  const order: string[] = [];

  const store: RecogPipelineStore = {
    listPages: () => pages.map((p) => ({ pageNo: p.pageNo, imageFile: p.imageFile, ocrFile: p.ocrFile })),
    readImage: (_runId, pageNo) => ({ data: new Uint8Array([pageNo]), mime: 'image/png' }),
    readOcr: (_runId, pageNo) => pages[pageNo - 1].ocrFile ? files.get(pages[pageNo - 1].ocrFile!) ?? null : null,
    writeOcr: (_runId, pageNo, result) => {
      const key = `ocr/p${pageNo}.json`;
      files.set(key, result);
      pages[pageNo - 1].ocrFile = key;
      return key;
    },
    writeDrafts: (_runId, drafts: ScanDraft[], warnings: string[]) => { draftsWrites.push({ count: drafts.length, warnings }); },
    setWarnings: (_runId, warnings: string[]) => { warningsWrites.push([...warnings]); order.push(`warnings:${warnings.length}`); },
    updateRun: (_runId, patch) => { runPatches.push({ ...patch }); order.push(`run:${patch.status}`); },
    markPage: (_runId, pageNo, patch) => {
      pagePatches.push({ pageNo, patch: { ...patch } });
      Object.assign(pages[pageNo - 1], patch);
    },
  };
  return { store, files, pages, runPatches, pagePatches, draftsWrites, warningsWrites, order };
}

interface CallLogEntry { pageNo: number; startedAt: number }

/** mock provider：记录时间窗内的并发峰值 */
function makeProvider(opts: { delayMs?: number; failOn?: number[] } = {}) {
  const log: CallLogEntry[] = [];
  let inFlight = 0;
  let peak = 0;
  const clock = () => Date.now();
  const provider = {
    log,
    peak: () => peak,
    inFlightNow: () => inFlight,
    callCount: () => log.length,
    ocrPage: async (image: { data: Uint8Array; pageNo: number }): Promise<OcrPageResult> => {
      log.push({ pageNo: image.pageNo, startedAt: clock() });
      inFlight++;
      peak = Math.max(peak, inFlight);
      try {
        await new Promise((r) => setTimeout(r, opts.delayMs ?? 5));
        if (opts.failOn?.includes(image.pageNo)) throw new Error(`模拟页 ${image.pageNo} OCR 失败`);
        return { pageNo: image.pageNo, text: `${image.pageNo}. 第${image.pageNo}题 题干`, images: [] };
      } finally {
        inFlight--;
      }
    },
  };
  return provider;
}

describe('0028 P1：runRecogPipeline', () => {
  it('全路径：queued→ocr→ai→done；页事件 i/n 递增、card 数=草稿数、done 收尾', async () => {
    const { store, runPatches, draftsWrites } = makeStore([1, 2, 3]);
    const provider = makeProvider();
    const events: string[] = [];
    const pageEvents: Array<{ i: number; n: number; pageNo: number }> = [];
    const cardEvents: number[] = [];

    const outcome = await runRecogPipeline({
      runId: 'r1',
      store,
      ocrPage: provider.ocrPage,
      signal: new AbortController().signal,
      emit: (ev) => {
        events.push(ev.type);
        if (ev.type === 'ocr') pageEvents.push({ i: ev.pageIndex!, n: ev.pageCount!, pageNo: ev.pageNo! });
        if (ev.type === 'card') cardEvents.push(ev.draftCount!);
      },
    });

    expect(outcome.status).toBe('done');
    expect(outcome.drafts.map((d) => d.qno)).toEqual([1, 2, 3]);
    // 事件序列：ocr(3) → ai → card(3) → done
    expect(events).toEqual(['ocr', 'ocr', 'ocr', 'ai', 'card', 'card', 'card', 'done']);
    expect(pageEvents.map((e) => [e.i, e.n])).toEqual([[1, 3], [2, 3], [3, 3]]);
    expect(pageEvents.map((e) => e.pageNo).sort()).toEqual([1, 2, 3]);
    expect(cardEvents).toEqual([1, 2, 3]);
    // 状态机落库：ocr → ai → done
    expect(runPatches.map((p) => p.status)).toEqual(['ocr', 'ai', 'done']);
    expect(draftsWrites).toEqual([{ count: 3, warnings: [] }]);
  });

  it('切分告警回写 run（落库先于终态）：无题卷的「未切出题目」原因不再静默', async () => {
    // provider 返回无行首题号的文本 → 切分 0 题 → 告警须进 store（UI 的 done 回读可展示）
    const { store, warningsWrites, order } = makeStore([1]);
    const NO_QNO_TEXT = '本页只有一段说明文字，没有任何行首题号。';
    const noQnoProvider = {
      ocrPage: async (image: { pageNo: number }): Promise<OcrPageResult> => ({
        pageNo: image.pageNo,
        text: NO_QNO_TEXT,
        images: [],
      }),
    };
    const outcome = await runRecogPipeline({
      runId: 'r-warn',
      store,
      ocrPage: noQnoProvider.ocrPage,
      signal: new AbortController().signal,
      emit: () => {},
    });

    expect(outcome.status).toBe('done');
    expect(outcome.drafts).toEqual([]);
    expect(warningsWrites).toEqual([
      [`整卷未切出题目（识别到 ${NO_QNO_TEXT.length} 字）：题号须在行首，当前支持「1.」「1、」「2-17」等；请确认原图是否含题号`],
    ]);
    // 时序：告警先落、终态后落（否则 done 上回读到空警告）
    expect(order.indexOf('warnings:1')).toBeLessThan(order.indexOf('run:done'));
  });

  it('有题时告警为空数组也回写（清掉上一轮残留，不留脏）', async () => {
    const { store, warningsWrites } = makeStore([1, 2]);
    const provider = makeProvider();
    await runRecogPipeline({
      runId: 'r-clean',
      store,
      ocrPage: provider.ocrPage,
      signal: new AbortController().signal,
      emit: () => {},
    });
    expect(warningsWrites).toEqual([[]]);
  });

  it('页级有界并发：pageConcurrency=2 → provider 并发峰值恰 2（不串行也不放飞）', async () => {
    const { store } = makeStore([1, 2, 3, 4, 5, 6]);
    const provider = makeProvider({ delayMs: 15 });
    let live = 0;
    let peak = 0;
    const outcome = await runRecogPipeline({
      runId: 'r1',
      store,
      pageConcurrency: 2,
      signal: new AbortController().signal,
      ocrPage: async (img) => { live++; peak = Math.max(peak, live); try { return await provider.ocrPage(img); } finally { live--; } },
      emit: () => {},
    });
    expect(outcome.status).toBe('done');
    expect(peak).toBe(2);
    expect(provider.callCount()).toBe(6);
  });

  it('全局闸：两个 run 同时跑 → 合计并发不超闸位（免费通道 429 防护）', async () => {
    const gate = createGate(3);
    const provider = makeProvider({ delayMs: 15 });
    let live = 0;
    let peak = 0;
    const wrapped = async (img: { data: Uint8Array; pageNo: number }) => {
      live++; peak = Math.max(peak, live);
      try { return await provider.ocrPage(img); } finally { live--; }
    };

    const [a, b] = await Promise.all([
      runRecogPipeline({ runId: 'ra', store: makeStore([1, 2, 3, 4]).store, gate, pageConcurrency: 2, signal: new AbortController().signal, ocrPage: wrapped, emit: () => {} }),
      runRecogPipeline({ runId: 'rb', store: makeStore([1, 2, 3, 4]).store, gate, pageConcurrency: 2, signal: new AbortController().signal, ocrPage: wrapped, emit: () => {} }),
    ]);
    expect([a.status, b.status]).toEqual(['done', 'done']);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it('中断恢复：预置 1/2 页产物 → 重跑跳过已有页（provider 只被调 3 次）且不重复写档', async () => {
    const { store, runPatches, draftsWrites } = makeStore([1, 2, 3], [1, 2]);
    const provider = makeProvider();
    const skipped: number[] = [];
    const events: string[] = [];

    const outcome = await runRecogPipeline({
      runId: 'r1',
      store,
      ocrPage: provider.ocrPage,
      signal: new AbortController().signal,
      emit: (ev) => { events.push(ev.type); if (ev.type === 'ocr' && ev.skipped) skipped.push(ev.pageNo!); },
    });

    expect(outcome.status).toBe('done');
    expect(provider.callCount()).toBe(1);
    expect(provider.log.map((l) => l.pageNo)).toEqual([3]);
    expect(skipped).toEqual([1, 2]);
    // 已完成页不再写状态
    expect(runPatches.map((p) => p.status)).toEqual(['ocr', 'ai', 'done']);
    // 跳过页仍参与切分（3 题齐）
    expect(outcome.drafts.map((d) => d.qno)).toEqual([1, 2, 3]);
    expect(draftsWrites).toEqual([{ count: 3, warnings: [] }]);
  });

  it('取消：AbortController 触发后不再开新页，状态落 cancelled 且不发 done', async () => {
    const { store, runPatches } = makeStore([1, 2, 3, 4, 5, 6]);
    const controller = new AbortController();
    const provider = makeProvider({ delayMs: 10 });
    const events: string[] = [];

    const outcome = await runRecogPipeline({
      runId: 'r1',
      store,
      pageConcurrency: 1,
      signal: controller.signal,
      ocrPage: async (img) => {
        const r = await provider.ocrPage(img);
        if (img.pageNo === 1) controller.abort();
        return r;
      },
      emit: (ev) => { events.push(ev.type); },
    });

    expect(outcome.status).toBe('cancelled');
    expect(provider.callCount()).toBe(1);
    expect(events).toEqual(['ocr', 'cancelled']);
    expect(runPatches.at(-1)).toMatchObject({ status: 'cancelled' });
    expect(runPatches.some((p) => p.status === 'done')).toBe(false);
  });

  it('页失败：首错即停（error 落库 + error 事件 + 报错文案带页号），已成功页保留可续跑', async () => {
    const { store, runPatches, pages } = makeStore([1, 2, 3]);
    const provider = makeProvider({ failOn: [2] });
    const events: Array<{ type: string; message?: string }> = [];

    const outcome = await runRecogPipeline({
      runId: 'r1',
      store,
      pageConcurrency: 1,
      signal: new AbortController().signal,
      ocrPage: provider.ocrPage,
      emit: (ev) => { events.push({ type: ev.type, ...(ev.message !== undefined ? { message: ev.message } : {}) }); },
    });

    expect(outcome.status).toBe('error');
    expect(outcome.error).toContain('第 2 页');
    expect(events.at(-1)!.type).toBe('error');
    expect(events.at(-1)!.message).toContain('第 2 页');
    expect(runPatches.at(-1)).toMatchObject({ status: 'error' });
    expect(runPatches.at(-1)!.error).toContain('第 2 页');
    // 第 1 页产物已落（续跑只需重试第 2 页）
    expect(pages[0].ocrFile).toBe('ocr/p1.json');
    expect(pages[1].ocrFile).toBeNull();
  });

  it('进度单调：ocr 事件的 progress 随完成页递增到 1 前的稳定值，done 时 progress=1', async () => {
    const { store } = makeStore([1, 2]);
    const progress: Array<{ type: string; p: number | undefined }> = [];
    await runRecogPipeline({
      runId: 'r1',
      store,
      pageConcurrency: 1,
      signal: new AbortController().signal,
      ocrPage: makeProvider().ocrPage,
      emit: (ev) => progress.push({ type: ev.type, p: ev.progress }),
    });
    const ocrP = progress.filter((e) => e.type === 'ocr').map((e) => e.p!);
    expect(ocrP).toEqual([0.5, 1]);
    expect(progress.at(-1)).toEqual({ type: 'done', p: 1 });
  });

  it('零页 run：不调 provider，直接 ai→done（空卷不炸）', async () => {
    const { store } = makeStore([]);
    const provider = makeProvider();
    const outcome = await runRecogPipeline({
      runId: 'r1', store, ocrPage: provider.ocrPage, signal: new AbortController().signal, emit: () => {},
    });
    expect(outcome.status).toBe('done');
    expect(provider.callCount()).toBe(0);
    expect(outcome.drafts).toEqual([]);
  });
});

describe('0028 P1：createGate', () => {
  it('闸位耗尽时排队，释放后放行；释放幂等', async () => {
    const gate = createGate(2);
    const r1 = await gate.acquire();
    const r2 = await gate.acquire();
    let third = false;
    const p3 = gate.acquire().then((rel) => { third = true; return rel; });
    await new Promise((r) => setTimeout(r, 10));
    expect(third).toBe(false);
    r1();
    const r3 = await p3;
    expect(third).toBe(true);
    r2();
    r3();
    r3(); // 幂等：重复释放不额外放行
    let fourth = false;
    const r4 = await gate.acquire().then((rel) => { fourth = true; return rel; });
    expect(fourth).toBe(true);
    r4();
  });
});
