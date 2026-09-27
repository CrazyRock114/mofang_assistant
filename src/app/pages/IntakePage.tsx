// 0040 P2：录题工作台入口页（设计稿视图一）。
//
// 0053（R-053）：入口收敛——「录入题目」「录入整卷 PDF」两卡撤下，拖放条升唯一主入口
//（点选/拖拽/Ctrl+V 三入同流；分流能力内置：classifyMaterials 自动分流 PDF/图片）；
// 0053 目检返工：切题工作区可见入口随用户拍板全部退役（#/split 路由本体保留）；AI 配置深链 #/settings?view=ai。
// 默认归类：学段/学科只作识别结果的**默认值**（题卡上可逐题改），与题库页同源共享状态；
// 最近识别记录：recog.run.history 全量 + 客户端翻页（页大小 10）+ 状态 pill + 「继续处理」（草稿恢复入口）。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MofangRecogBridge } from '../../shared/contracts/bridge.js';
import type { RecogEventPayload, RecogRun } from '../../shared/contracts/recog-run-types.js';
import { classifyMaterials } from '../../recog/material.js';
import { filesFromDrop, filesFromInput, filesFromPaste, filesToMaterials, pastedFileName } from '../recog/intake.js';
import { putPendingDefaults, putPendingImages } from '../workbench/handoff.js';
import { pdfPaperTitle, rasterizePdf, type PdfIntakeResult, type RasterizeProgress } from '../workbench/pdf-intake.js';
import { createBankExtServices } from '../services/BankExtServiceFactory.js';
import { createRecogService } from '../services/RecogServiceFactory.js';
import { useStageSubject } from '../state/use-stage-subject.js';
import type { PageMessage } from './ExtUi.js';
import { MessageBanner, ProgressNote } from './ExtUi.js';

const STAGE_OPTIONS = ['小学', '初中', '高中'] as const;

/** 0053：识别记录翻页页大小（拍板口径③=10） */
const INTAKE_RUNS_PAGE_SIZE = 10;

const RUN_STATUS_LABEL: Record<RecogRun['status'], string> = {
  queued: '排队中',
  ocr: '识别中',
  ai: '整理题卡',
  done: '已完成',
  error: '中断',
  cancelled: '已取消',
};

/** 状态 pill 语气：done=绿 / 进行中=黄 / error,cancelled=红 */
function statusTone(status: RecogRun['status']): 'done' | 'part' | 'bad' {
  if (status === 'done') return 'done';
  if (status === 'error' || status === 'cancelled') return 'bad';
  return 'part';
}

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const diff = Date.now() - then;
  const minute = 60_000;
  if (diff < minute) return '刚刚';
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))} 小时前`;
  return `${Math.floor(diff / (24 * 60 * minute))} 天前`;
}

export interface IntakePageProps {
  recog?: MofangRecogBridge;
  /** 测试注入：PDF 逐页转图（jsdom 无 pdfjs worker / 无真 canvas）；0046 P1.4 进度回调随参 */
  rasterize?: (file: File, onProgress?: RasterizeProgress) => Promise<PdfIntakeResult>;
}

/** 0046 P1.5：recog 事件类型 → run 状态（card 事件不改变状态） */
const EVENT_STATUS: Partial<Record<RecogEventPayload['type'], RecogRun['status']>> = {
  queued: 'queued', ocr: 'ocr', ai: 'ai', done: 'done', error: 'error', cancelled: 'cancelled',
};

export function IntakePage({ recog: recogProp, rasterize }: IntakePageProps) {
  const recog = useMemo(() => recogProp ?? createRecogService(), [recogProp]);
  const rasterizePdfFile = useMemo(
    () => rasterize ?? ((file: File, onProgress?: RasterizeProgress) => rasterizePdf(file, undefined, onProgress)),
    [rasterize],
  );
  const stageSubject = useStageSubject();

  const [subjectOptions, setSubjectOptions] = useState<Array<{ id: string; label: string }>>([]);
  const [runs, setRuns] = useState<RecogRun[]>([]);
  // 0053：识别记录客户端翻页——当前页（0 基）；记录数变化时渲染层按页数钳制回落末页
  const [runsPage, setRunsPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [message, setMessage] = useState<PageMessage | null>(null);
  // 0046 P1.4：PDF 逐页栅格化读条
  const [pdfProgress, setPdfProgress] = useState<{ done: number; total: number } | null>(null);
  // 0046 P1.5：后台转写中的 run（事件驱动；runId → 最新 i/n）
  const [runProgress, setRunProgress] = useState<Map<string, { done: number; total: number }>>(new Map());
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pdfInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const rows = await createBankExtServices().dict.listEntries({ kind: 'subject', activeOnly: true });
        if (alive) setSubjectOptions(rows.filter((r) => !r.site).map((r) => ({ id: r.id, label: r.label })));
      } catch {
        if (alive) setSubjectOptions([]);
      }
    })();
    return () => { alive = false; };
  }, []);

  // 0053：全量取回（契约不动：limit 不传即无上限），翻页在渲染层客户端切片
  const loadRuns = useCallback(async () => {
    try {
      setRuns(await recog.history());
    } catch {
      setRuns([]);
    }
  }, [recog]);

  useEffect(() => { void loadRuns(); }, [loadRuns]);

  // 0046 P1.5：订阅识别事件流——「最近识别记录」状态 pill 实时化 + 在跑 run 行内读条
  useEffect(() => {
    const off = recog.onEvent((payload: RecogEventPayload) => {
      setRuns((prev) => {
        const index = prev.findIndex((r) => r.id === payload.runId);
        if (index < 0) return prev;
        const status = EVENT_STATUS[payload.type];
        const current = prev[index]!;
        const next = [...prev];
        next[index] = {
          ...current,
          ...(status ? { status } : {}),
          ...(payload.type === 'ocr' ? { pagesDone: payload.pageIndex ?? current.pagesDone } : {}),
        };
        return next;
      });
      setRunProgress((prev) => {
        const next = new Map(prev);
        if (payload.type === 'done' || payload.type === 'error' || payload.type === 'cancelled') {
          next.delete(payload.runId);
          return next;
        }
        if (payload.type === 'card') return prev;
        next.set(payload.runId, { done: payload.pageIndex ?? 0, total: payload.pageCount ?? 0 });
        return next;
      });
    });
    return off;
  }, [recog]);

  /**
   * PDF → 同一工作台（返工③）：本地逐页栅格化成 PNG → 普通图片素材建 run。
   * 超页数截断、同批多份 PDF 只取一份、同批图片未处理——三件事都明确说出来（不静默丢）。
   */
  const startPdfRun = useCallback(async (pdfFile: File, extras: string[]) => {
    setBusy(true);
    setMessage({ type: 'success', text: `正在本地把「${pdfFile.name}」逐页转成图片…` });
    setPdfProgress({ done: 0, total: 0 });
    try {
      // 0046 P1.4：逐页进度 → 统一读条（原来只有一条静态文案）
      const onProgress: RasterizeProgress = (done, total) => setPdfProgress({ done, total });
      const result = await rasterizePdfFile(pdfFile, onProgress);
      // 0046 P5.2：整卷 PDF run 带卷名（「最近识别记录」显示卷名而非 run id 前 8 位）
      const created = await recog.create({
        materials: result.materials,
        sourceKind: 'image',
        sourceName: pdfPaperTitle(pdfFile.name),
      });
      putPendingImages(created.runId, result.files);
      putPendingDefaults(created.runId, {
        stage: stageSubject.stage,
        subjectId: stageSubject.subjectId,
        paperTitle: pdfPaperTitle(pdfFile.name),
      });
      if (typeof window !== 'undefined') window.location.hash = `#/intake/${created.runId}`;
      const notices = [...extras, ...(result.notice ? [result.notice] : [])];
      setMessage(notices.length > 0 ? { type: 'error', text: notices.join('；') } : null);
    } catch (err) {
      setMessage({ type: 'error', text: `PDF 转图失败：${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setBusy(false);
      setPdfProgress(null);
    }
  }, [rasterizePdfFile, recog, stageSubject.stage, stageSubject.subjectId]);

  const startRun = useCallback(async (files: File[]) => {
    if (files.length === 0) {
      setMessage({ type: 'error', text: '没有收到文件（拖拽图片/PDF、Ctrl+V 粘贴截图，或点击选择文件）' });
      return;
    }
    const candidates = files.map((f, i) => ({ name: f.name || pastedFileName(i + 1), type: f.type, size: f.size }));
    const classified = classifyMaterials(candidates);

    // PDF 进同一个工作台（返工③）：本地逐页转图 → 图片素材建 run；同批其它素材不静默丢
    if (classified.pdf.length > 0) {
      const pdfFile = files[candidates.findIndex((c) => classified.pdf.includes(c))];
      if (!pdfFile) return;
      const extras: string[] = [];
      if (classified.pdf.length > 1) extras.push(`同批拖入的另外 ${classified.pdf.length - 1} 份 PDF 未处理（一次一份，请分次导入）`);
      if (classified.accepted.length > 0) extras.push(`同批拖入的 ${classified.accepted.length} 张图片未处理（一次一批，请分次导入）`);
      for (const item of classified.rejected) extras.push(`${item.name}（${item.reason}）`);
      await startPdfRun(pdfFile, extras);
      return;
    }
    if (classified.accepted.length === 0) {
      setMessage({
        type: 'error',
        text: classified.rejected.length > 0
          ? `没有可识别的图片：${classified.rejected.map((r) => `${r.name}（${r.reason}）`).join('；')}`
          : '没有可识别的图片素材',
      });
      return;
    }

    setBusy(true);
    setMessage(null);
    try {
      const acceptedSet = new Set(classified.accepted);
      const picked: File[] = [];
      const pickedNames: string[] = [];
      files.forEach((f, i) => {
        if (acceptedSet.has(candidates[i]!)) { picked.push(f); pickedNames.push(candidates[i]!.name); }
      });
      const materials = await filesToMaterials(picked, pickedNames);
      // 0046 P5.2：单图 run 也带净名（去扩展名）；多图不造假名（host 落 null）
      const created = await recog.create({
        materials,
        sourceKind: 'image',
        ...(pickedNames.length === 1 ? { sourceName: pdfPaperTitle(pickedNames[0]!) } : {}),
      });
      // 图片字节交给工作台（可裁图源；工作台取用后即弃）+ 默认归类（挂树建议要用它定格学科）
      putPendingImages(created.runId, picked);
      putPendingDefaults(created.runId, {
        stage: stageSubject.stage,
        subjectId: stageSubject.subjectId,
        paperTitle: pickedNames.length === 1 ? (pickedNames[0] ?? '') : '',
      });
      if (typeof window !== 'undefined') window.location.hash = `#/intake/${created.runId}`;
      if (classified.rejected.length > 0) {
        setMessage({ type: 'error', text: `部分文件未受理：${classified.rejected.map((r) => `${r.name}（${r.reason}）`).join('；')}` });
      }
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }, [recog, startPdfRun, stageSubject.stage, stageSubject.subjectId]);

  // Ctrl+V：挂在 document 上（用户不必先点拖放区；R-028 的「顺手」要求）
  useEffect(() => {
    const onPaste = (e: ClipboardEvent): void => {
      const files = filesFromPaste(e.clipboardData);
      if (files.length === 0) return;
      e.preventDefault();
      void startRun(files);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [startRun]);

  return (
    <div className="wb-entry" data-testid="intake-page">
      <div className="wb-entry-head">
        <div>
          <h1 className="wb-entry-title">录题工作台</h1>
          <div className="wb-entry-sub">把题目从照片、截图、PDF 搬进题库 —— 先丢进来，剩下的边认边改。</div>
        </div>
        <div className="wb-stage-pick" data-testid="intake-stage-subject">
          <span className="wb-muted">默认归类</span>
          <select
            className="wb-select"
            aria-label="默认学段"
            data-testid="intake-stage-select"
            value={stageSubject.stage}
            onChange={(e) => stageSubject.setStage(e.target.value)}
          >
            {STAGE_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select
            className="wb-select"
            aria-label="默认学科"
            data-testid="intake-subject-select"
            value={stageSubject.subjectId}
            onChange={(e) => stageSubject.setSubjectId(e.target.value)}
          >
            <option value="">学科未定</option>
            {subjectOptions.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
          <span className="wb-muted wb-mini">识别结果先按此归类，题卡上可逐题改</span>
        </div>
      </div>

      <MessageBanner message={message} />

      <div
        className={dragActive ? 'wb-drop-strip active' : 'wb-drop-strip'}
        data-testid="intake-dropzone"
        onClick={() => fileInputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragActive(false);
          void startRun(filesFromDrop(e.dataTransfer));
        }}
      >
        📥 把图片 / 整卷 PDF 拖到这里，或 <kbd>Ctrl</kbd>+<kbd>V</kbd> 粘贴截图 ·
        <button type="button" className="btn btn-ghost btn-sm" data-testid="intake-pick-files">点选文件…</button>
        支持多图（PDF 一次一份）
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,application/pdf"
          data-testid="intake-file-input"
          style={{ display: 'none' }}
          onChange={(e) => { void startRun(filesFromInput(e.target.files)); e.target.value = ''; }}
        />
        <input
          ref={pdfInputRef}
          type="file"
          accept="application/pdf"
          data-testid="intake-pdf-input"
          style={{ display: 'none' }}
          onChange={(e) => {
            const picked = e.target.files?.[0];
            e.target.value = '';
            if (picked) void startPdfRun(picked, []);
          }}
        />
        {busy && <span className="wb-muted wb-mini" data-testid="intake-busy">　受理中…</span>}
      </div>

      {/* 0053 目检返工：切题工作区可见入口随用户拍板退役（路由本体保留）；AI 配置深链为唯一小字（唯一一处） */}
      <div className="wb-entry-foot">
        <span>
          AI 识别需在设置页配置模型 ·{' '}
          <button
            type="button"
            className="wb-link"
            data-testid="intake-ai-config"
            onClick={() => { window.location.hash = '#/settings?view=ai'; }}
          >
            去配置 →
          </button>
        </span>
      </div>

      {/* 0046 P1.4：PDF 逐页栅格化读条（栅格化进行中显示） */}
      {pdfProgress && (
        <ProgressNote
          label={`逐页转图中 第 ${pdfProgress.done}/${pdfProgress.total} 页`}
          testid="intake-pdf-prog"
        />
      )}

      <div className="wb-runs" data-testid="intake-runs">
        <h2>最近识别记录（中断可续跑）</h2>
        {runs.length === 0 && <div className="wb-muted" data-testid="intake-runs-empty">还没有识别记录 —— 拖一张图进来试试。</div>}
        {/* 0053：客户端翻页（拍板口径③ 页大小=10）；记录数缩小时钳到末页（回落语义在渲染层达成） */}
        {(() => {
          const pageCount = Math.max(1, Math.ceil(runs.length / INTAKE_RUNS_PAGE_SIZE));
          const current = Math.min(runsPage, pageCount - 1);
          const visible = runs.slice(current * INTAKE_RUNS_PAGE_SIZE, (current + 1) * INTAKE_RUNS_PAGE_SIZE);
          return (
            <>
              {visible.map((run) => {
                const tone = statusTone(run.status);
                return (
                  <div className="wb-run-row" key={run.id} data-testid={`intake-run-${run.id}`}>
                    <span className="wb-run-name">{run.sourceName ?? run.id.slice(0, 8)}</span>
                    <span className="wb-run-meta">
                      {relativeTime(run.updatedAt)} · {run.pageCount} 图
                      {run.questionIds.length > 0 ? ` · 已出 ${run.questionIds.length} 题` : ''}
                    </span>
                    <span className="wb-sp" />
                    <span className={`wb-st-pill ${tone}`} data-testid={`intake-run-status-${run.id}`} data-status={run.status}>
                      {RUN_STATUS_LABEL[run.status]}
                    </span>
                    {runProgress.get(run.id) && (
                      <span className="wb-run-prog" data-testid={`intake-run-prog-${run.id}`}>
                        第 {runProgress.get(run.id)!.done}/{runProgress.get(run.id)!.total} 页
                        <span className="progress-track"><i /></span>
                      </span>
                    )}
                    <button
                      type="button"
                      className={tone === 'part' ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm'}
                      data-testid={`intake-run-open-${run.id}`}
                      onClick={() => { window.location.hash = `#/intake/${run.id}`; }}
                    >
                      {tone === 'part' ? '继续处理' : '查看'}
                    </button>
                  </div>
                );
              })}
              {pageCount > 1 && (
                <div className="wb-pager" data-testid="intake-runs-pager">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    data-testid="intake-runs-prev"
                    disabled={current === 0}
                    onClick={() => setRunsPage(Math.max(0, current - 1))}
                  >
                    ‹ 上一页
                  </button>
                  <span className="wb-pager-info" data-testid="intake-runs-pager-info">
                    共 {runs.length} 条 · 第 {current + 1} / {pageCount} 页
                  </span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    data-testid="intake-runs-next"
                    disabled={current >= pageCount - 1}
                    onClick={() => setRunsPage(Math.min(pageCount - 1, current + 1))}
                  >
                    下一页 ›
                  </button>
                </div>
              )}
            </>
          );
        })()}
      </div>
    </div>
  );
}
