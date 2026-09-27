// 0028 P1：识别编排器（页级有界并发 + 全局闸 + 文件级 checkpoint + 取消）
// 规划 T-09：页级有界并发（单 run 2-3 页并行）；全局串行闸防免费通道 429。
// 规划 T-07：断点续跑 = 读表恢复 + 跳过已存在页文件（ocr-batch 已验证的「文件存在即跳过」语义）。
//
// 纯编排层（不碰 SQLite / electron / fs）：状态口与产物口全注入，故可在 vitest 里直测并发与取消。

import type { OcrImageRef, OcrPageResult, ScanDraft } from '../../shared/contracts/recog-types.js';
import type { RecogEventPayload, RecogRunStage, RecogRunStatus } from '../../shared/contracts/recog-run-types.js';
import { createDraftBuilder } from '../draft.js';
import { segmentPaper } from '../segmentation/rule.js';

/** 全局闸（跨 run 共享；大小 = 免费通道可承受的在飞请求数） */
export interface RecogGate {
  acquire(): Promise<() => void>;
}

/** 信号量实现：超过闸位排队，释放幂等 */
export function createGate(limit: number): RecogGate {
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`闸位须为正整数：${limit}`);
  let active = 0;
  const waiters: Array<() => void> = [];
  return {
    acquire: () =>
      new Promise<() => void>((resolve) => {
        const grant = (): void => {
          active++;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            active--;
            const next = waiters.shift();
            if (next) next();
          });
        };
        if (active < limit) grant();
        else waiters.push(grant);
      }),
  };
}

/** 页产物与状态口（shell 侧由 fs + RecogRunService 组合实现） */
export interface RecogPipelineStore {
  listPages(runId: string): Array<{ pageNo: number; imageFile: string; ocrFile: string | null }>;
  readImage(runId: string, pageNo: number): { data: Uint8Array; mime: string };
  /** checkpoint 命中则返回已落盘结果（续跑跳过该页） */
  readOcr(runId: string, pageNo: number): OcrPageResult | null;
  /** 落盘 OCR 原文，返回 run 目录内相对路径 */
  writeOcr(runId: string, pageNo: number, result: OcrPageResult): string;
  writeDrafts(runId: string, drafts: ScanDraft[], warnings: string[]): void;
  /** 切分/引擎告警回写 run（UI 的「识别完成但没有切出题目」靠它给出原因，不静默） */
  setWarnings(runId: string, warnings: string[]): void | Promise<void>;
  updateRun(runId: string, patch: { status: RecogRunStatus; stage: RecogRunStage; error?: string | null }): void | Promise<void>;
  markPage(runId: string, pageNo: number, patch: {
    status?: 'pending' | 'ocr' | 'done' | 'error';
    ocrFile?: string;
    textChars?: number;
    imageRefCount?: number;
    error?: string | null;
  }): void | Promise<void>;
}

export interface RecogPipelineDeps {
  runId: string;
  store: RecogPipelineStore;
  ocrPage(image: { data: Uint8Array; pageNo: number; mime?: string }): Promise<OcrPageResult>;
  emit(event: RecogEventPayload): void;
  signal: AbortSignal;
  /** 单 run 页并发（缺省 2） */
  pageConcurrency?: number;
  /** 跨 run 全局闸（缺省不设：单 run 场景） */
  gate?: RecogGate;
}

export interface RecogPipelineOutcome {
  status: 'done' | 'error' | 'cancelled';
  error?: string;
  drafts: ScanDraft[];
  warnings: string[];
}

const DEFAULT_PAGE_CONCURRENCY = 2;

/** 终态落库的兜底：终态写失败不得吞掉原始错误（原始错误信息更可诊断） */
async function settle(
  store: RecogPipelineStore,
  runId: string,
  patch: { status: RecogRunStatus; stage: RecogRunStage; error: string | null },
): Promise<void> {
  try {
    await store.updateRun(runId, patch);
  } catch {
    // 终态未落库只影响回读，不影响本次调用的返回与事件
  }
}

/** 中断哨兵：与业务错误区分（不写 error 文案，落 cancelled） */
class PipelineCancelled extends Error {
  constructor() {
    super('已取消');
    this.name = 'PipelineCancelled';
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 有界并发映射：worker 池（页级并发上限），任一 worker 失败即整体拒绝（首错即停）。
 * 取消经 signal 在取下一项时检查——在飞页跑完即止，不发新请求。
 */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  signal: AbortSignal,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (signal.aborted) throw new PipelineCancelled();
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  };
  const size = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: size }, () => worker()));
  return results;
}

/**
 * 跑一次识别：OCR 阶段（页级 checkpoint）→ 结构整理阶段（切分 → 草稿 → 逐题卡事件）。
 * 终态由本函数落定（done / error / cancelled），并保证语义上只发一次终态事件。
 */
export async function runRecogPipeline(deps: RecogPipelineDeps): Promise<RecogPipelineOutcome> {
  const { runId, store, emit, signal } = deps;
  const pageConcurrency = deps.pageConcurrency ?? DEFAULT_PAGE_CONCURRENCY;
  const pages = store.listPages(runId);
  const pageCount = pages.length;

  try {
    // ---------- 阶段一：OCR（页级有界并发 + 全局闸 + checkpoint） ----------
    await store.updateRun(runId, { status: 'ocr', stage: 'ocr' });
    let completed = 0;
    const pageResults = await mapLimit(pages, pageConcurrency, signal, async (page) => {
      const existing = store.readOcr(runId, page.pageNo);
      if (existing) {
        completed++;
        emit({
          runId, type: 'ocr', pageNo: page.pageNo, pageIndex: completed, pageCount,
          skipped: true, progress: pageCount === 0 ? 1 : completed / pageCount,
        });
        return existing;
      }
      const release = deps.gate ? await deps.gate.acquire() : undefined;
      let result: OcrPageResult;
      try {
        const image = store.readImage(runId, page.pageNo);
        await store.markPage(runId, page.pageNo, { status: 'ocr' });
        result = await deps.ocrPage({ data: image.data, pageNo: page.pageNo, mime: image.mime });
      } catch (err) {
        await store.markPage(runId, page.pageNo, { status: 'error', error: errMessage(err) });
        throw new Error(`第 ${page.pageNo} 页识别失败：${errMessage(err)}`);
      } finally {
        release?.();
      }
      const ocrFile = store.writeOcr(runId, page.pageNo, result);
      await store.markPage(runId, page.pageNo, {
        status: 'done',
        ocrFile,
        textChars: result.text.length,
        imageRefCount: result.images.length,
        error: null,
      });
      completed++;
      emit({
        runId, type: 'ocr', pageNo: page.pageNo, pageIndex: completed, pageCount,
        progress: pageCount === 0 ? 1 : completed / pageCount,
      });
      return result;
    });

    if (signal.aborted) throw new PipelineCancelled();

    // ---------- 阶段二：结构整理（切分 → 草稿 → 题卡事件） ----------
    await store.updateRun(runId, { status: 'ai', stage: 'ai' });
    emit({ runId, type: 'ai', pageCount, progress: 1 });

    const seg = segmentPaper(
      pageResults.map((r) => ({ text: r.text, pageNo: r.pageNo, imageRefs: r.images as OcrImageRef[] })),
    );
    const builder = createDraftBuilder();
    const drafts: ScanDraft[] = [];
    for (const pageSeg of seg.pages) {
      for (const q of pageSeg.questions) {
        drafts.push(builder.build(q));
        emit({ runId, type: 'card', draftCount: drafts.length, pageNo: q.pageNo, pageCount, progress: 1 });
      }
    }

    if (signal.aborted) throw new PipelineCancelled();

    store.writeDrafts(runId, drafts, seg.warnings);
    await store.setWarnings(runId, seg.warnings);
    await store.updateRun(runId, { status: 'done', stage: 'done' });
    emit({ runId, type: 'done', draftCount: drafts.length, pageCount, progress: 1 });
    return { status: 'done', drafts, warnings: seg.warnings };
  } catch (err) {
    if (err instanceof PipelineCancelled || signal.aborted) {
      await settle(store, runId, { status: 'cancelled', stage: 'cancelled', error: null });
      emit({ runId, type: 'cancelled', pageCount, message: '已取消' });
      return { status: 'cancelled', drafts: [], warnings: [] };
    }
    const message = errMessage(err);
    await settle(store, runId, { status: 'error', stage: 'error', error: message });
    emit({ runId, type: 'error', pageCount, message });
    return { status: 'error', error: message, drafts: [], warnings: [] };
  }
}
