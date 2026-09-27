// 0028 P1：识别 run 主进程宿主（素材收件 → 编排 → 事件广播 → 状态回读）
// 职责边界：
//   - 本层是「接线层」：素材落盘（fs）、编排器（recog/runs）、状态口（bank service）、事件推送（webContents）
//   - 识别引擎（src/recog）不碰 SQL、不碰 electron；bank 不碰编排——两侧都只经本层组合（架构硬规则 1/2）
//   - Key 红线（D-043）：本层只持 ai.invoke 函数引用，Key 解密与脱敏全在 AiGateway 内
//
// 生命周期：createRun 立即返回 runId（queued），识别在后台跑；渲染层靠 recog.event 进度 + recog.run.status 回读。

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserWindow } from 'electron';

import type { AiInvokePayload, AiInvokeResult } from '../../shared/contracts/ai-types.js';
import type {
  RecogDraftWritePayload, RecogDraftWriteResult, RecogEventPayload, RecogRun, RecogRunCreatePayload,
  RecogRunCreateResult, RecogRunDetail, RecogRunDetailPage, RecogRunService,
} from '../../shared/contracts/recog-run-types.js';
import { IPC_CHANNELS } from '../../shared/contracts/ipc-channels.js';
import { PDF_SPLIT_REDIRECT_NOTICE, classifyMaterials } from '../../recog/material.js';
import { createGate, runRecogPipeline, type RecogGate } from '../../recog/runs/pipeline.js';
import { createFsRunStore, ensureRunDir, readDraftsFile, writeDraftsFile, writePageImage } from '../../recog/runs/fs-store.js';
// 0046（只增）：Onestep → ScanDraft 转换（P6.3 换档落地，D-064）
import { onestepToScanDrafts } from '../../recog/onestep/to-scan-drafts.js';
// 0040（只增）：工作台卡流文件态（run 目录 workbench.json）
import { readWorkbenchFile, writeWorkbenchFile } from '../../recog/runs/workbench-store.js';
import type {
  RecogWorkbenchLoadPayload, RecogWorkbenchSavePayload, RecogWorkbenchSaveResult, WorkbenchState,
} from '../../shared/contracts/onestep-types.js';
import { createVisionOcrProvider, VISION_OCR_TIMEOUT_MS } from '../../recog/providers/vision.js';

/** 跨 run 全局闸：免费/慢速视觉通道的并发上限（防 429；规划 T-09） */
export const RECOG_GLOBAL_GATE = 3;
/** 单 run 页级并发 */
export const RECOG_PAGE_CONCURRENCY = 2;

/**
 * 0046：draftWrite 状态同步的合法迁移链（到 done 为止；done 已是终态则空）。
 * 0036 状态机（recog-run-service ALLOWED_TRANSITIONS）：queued→ocr→ai→done，error/cancelled→ocr。
 */
const PATH_TO_DONE: Record<RecogRun['status'], RecogRun['status'][]> = {
  queued: ['ocr', 'ai', 'done'],
  ocr: ['ai', 'done'],
  ai: ['done'],
  done: [],
  error: ['ocr', 'ai', 'done'],
  cancelled: ['ocr', 'ai', 'done'],
};

export interface RecogHostDeps {
  runs: RecogRunService;
  /** ai.invoke（AiGateway 绑定；Key 解密/超时/脱敏都在网关内） */
  invoke(payload: AiInvokePayload): Promise<AiInvokeResult>;
  /** 产物根目录（<userData>/data/recog/runs） */
  runsRoot: string;
  /** 主→渲染事件推送；缺省广播全部存活窗口 */
  broadcast?: (payload: RecogEventPayload) => void;
  /** 单页超时（测试可缩短；缺省 120s，见 providers/vision.ts 的 S-4 依据） */
  timeoutMs?: number;
  now?: () => string;
}

export class RecogHost {
  private readonly controllers = new Map<string, AbortController>();
  private readonly gate: RecogGate = createGate(RECOG_GLOBAL_GATE);

  constructor(private readonly deps: RecogHostDeps) {
    mkdirSync(deps.runsRoot, { recursive: true });
  }

  /** 素材 → run：落盘页图 + 建表（queued）+ 后台起跑；返回 runId 让渲染层立刻进进度界面 */
  async createRun(payload: RecogRunCreatePayload): Promise<RecogRunCreateResult> {
    const buffers = payload.materials.map((m) => Buffer.from(m.dataBase64, 'base64'));
    const classified = classifyMaterials(
      payload.materials.map((m, i) => ({ name: m.name, type: m.mime, size: buffers[i].length })),
    );
    if (classified.accepted.length === 0) {
      const why = [
        ...classified.pdf.map((p) => `${p.name}：${PDF_SPLIT_REDIRECT_NOTICE}`),
        ...classified.rejected.map((r) => `${r.name}：${r.reason}`),
      ];
      throw new Error(`没有可识别的图片素材${why.length > 0 ? `（${why.join('；')}）` : ''}`);
    }

    const runId = randomUUID();
    const runDir = join(this.deps.runsRoot, runId);
    ensureRunDir(runDir);

    const indexByName = new Map(payload.materials.map((m, i) => [m.name, i]));
    const pages = classified.accepted.map((c, i) => {
      const sourceIndex = indexByName.get(c.name);
      if (sourceIndex === undefined) throw new Error(`素材索引错位：${c.name}`);
      return { pageNo: i + 1, imageFile: writePageImage(runDir, i + 1, buffers[sourceIndex]) };
    });

    await this.deps.runs.createRun({
      id: runId,
      sourceKind: payload.sourceKind,
      // 0046 P5.2：payload.sourceName 优先（整卷 PDF 显示卷名）；缺省沿用单素材文件名口径
      sourceName: payload.sourceName
        ?? (payload.materials.length === 1 ? classified.accepted[0].name : undefined),
      pages,
      now: this.now(),
    });

    this.emit({ runId, type: 'queued', pageCount: pages.length, progress: 0 });
    // 后台起跑：create 立即返回，进度靠事件 + status 回读（任务书 §一 P1）
    void this.process(runId).catch(() => undefined);
    return { runId, pageCount: pages.length };
  }

  /**
   * 断点续跑：error/cancelled 的 run 重跑（已完成页由文件 checkpoint 跳过），done/在跑的不动。
   * 素材已在首跑时落盘，续跑不重传——这正是混合持久化（T-07）的收益点。
   */
  async resume(runId: string): Promise<RecogRun> {
    const run = await this.requireRun(runId);
    if (run.status === 'queued' || run.status === 'ocr' || run.status === 'ai' || run.status === 'done') {
      return run; // 在跑或已完：幂等返回，不重复起跑
    }
    this.emit({ runId, type: 'queued', pageCount: run.pageCount, progress: 0, message: '续跑' });
    void this.process(runId).catch(() => undefined);
    return run;
  }

  async status(runId: string): Promise<RecogRunDetail> {
    const run = await this.requireRun(runId);
    const runDir = join(this.deps.runsRoot, runId);
    const pageRows = await this.deps.runs.listPages(runId);
    const pages: RecogRunDetailPage[] = pageRows.map((p) => ({
      ...p,
      imagePath: join(runDir, p.imageFile),
      ocrText: this.readOcrText(runDir, p.ocrFile),
    }));
    const draftsFile = existsSync(runDir) ? readDraftsFile(runDir) : null;
    return { run, runDir, pages, drafts: draftsFile?.drafts ?? [] };
  }

  async cancel(runId: string): Promise<RecogRun> {
    // 编排器负责把状态落成 cancelled；此处只发出中止信号（在飞页跑完即止，不开新页）
    this.controllers.get(runId)?.abort();
    return this.requireRun(runId);
  }

  async history(limit?: number): Promise<RecogRun[]> {
    return this.deps.runs.listRuns(limit);
  }

  async attachQuestions(runId: string, questionIds: string[]): Promise<RecogRun> {
    return this.deps.runs.attachQuestions(runId, questionIds, this.now());
  }

  /**
   * 0040（只增）：读工作台卡流状态（run 目录 `workbench.json`）。
   * 无文件 = 首次进入该 run 的工作台 → null；文件损坏/版本不符同样按 null（不炸、不静默篡改）。
   */
  async loadWorkbench(payload: RecogWorkbenchLoadPayload): Promise<WorkbenchState | null> {
    await this.requireRun(payload.runId);
    return readWorkbenchFile(join(this.deps.runsRoot, payload.runId), payload.runId);
  }

  /** 0040（只增）：写工作台卡流状态（渲染层防抖后调用；原子替换落盘） */
  async saveWorkbench(payload: RecogWorkbenchSavePayload): Promise<RecogWorkbenchSaveResult> {
    await this.requireRun(payload.runId);
    const savedAt = writeWorkbenchFile(
      join(this.deps.runsRoot, payload.runId),
      payload.state,
      this.now(),
    );
    return { savedAt };
  }

  /**
   * 0046（只增）：Onestep 草稿写回 run（recog.draft.write；P6.3 换档落地，D-064）。
   * 转换在主进程侧完成（OnestepDraft → ScanDraft，qno 降级 + 降级告警）；落 drafts.json 后
   * run 状态同步落 done + warnings 回写——否则 run 永停 queued，历史 pill 骗人（任务书 P5.1）。
   * 状态同步走 0036 状态机的合法迁移链（error/cancelled 只有 →ocr 续跑边，逐跳到 done）。
   */
  async draftWrite(payload: RecogDraftWritePayload): Promise<RecogDraftWriteResult> {
    const run = await this.requireRun(payload.runId);
    const runDir = join(this.deps.runsRoot, payload.runId);
    const drafts = onestepToScanDrafts(payload.drafts);
    const warnings = [...new Set(drafts.flatMap((d) => d.warnings))];
    writeDraftsFile(runDir, drafts, warnings);
    const savedAt = this.now();
    for (const status of PATH_TO_DONE[run.status] ?? []) {
      await this.deps.runs.setStatus(payload.runId, { status, stage: status, now: savedAt });
    }
    await this.deps.runs.setWarnings(payload.runId, warnings, savedAt);
    return { savedAt, draftCount: drafts.length, warnings };
  }

  /** 在跑 run 数（探针/诊断用） */
  runningCount(): number {
    return this.controllers.size;
  }

  // ---------- 内部 ----------

  private async process(runId: string): Promise<void> {
    const run = await this.deps.runs.getRun(runId);
    if (!run) return;
    const runDir = join(this.deps.runsRoot, runId);
    const pages = await this.deps.runs.listPages(runId);
    const controller = new AbortController();
    this.controllers.set(runId, controller);

    const provider = createVisionOcrProvider({
      invoke: this.deps.invoke,
      timeoutMs: this.deps.timeoutMs ?? VISION_OCR_TIMEOUT_MS,
    });

    try {
      await runRecogPipeline({
        runId,
        store: createFsRunStore({ runId, runDir, pages, runs: this.deps.runs }),
        ocrPage: (image) => provider.ocrPage(image),
        emit: (event) => this.emit(event),
        signal: controller.signal,
        pageConcurrency: RECOG_PAGE_CONCURRENCY,
        gate: this.gate,
      });
    } finally {
      this.controllers.delete(runId);
    }
  }

  private async requireRun(runId: string): Promise<RecogRun> {
    const run = await this.deps.runs.getRun(runId);
    if (!run) throw new Error(`recog run 不存在：${runId}`);
    return run;
  }

  private readOcrText(runDir: string, ocrFile: string | null): string {
    if (!ocrFile) return '';
    const path = join(runDir, ocrFile);
    if (!existsSync(path)) return '';
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { text?: unknown };
      return typeof parsed.text === 'string' ? parsed.text : '';
    } catch {
      return '';
    }
  }

  private emit(event: RecogEventPayload): void {
    if (this.deps.broadcast) {
      this.deps.broadcast(event);
      return;
    }
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC_CHANNELS.RECOG_EVENT, event);
    }
  }

  private now(): string {
    return this.deps.now ? this.deps.now() : new Date().toISOString();
  }
}
