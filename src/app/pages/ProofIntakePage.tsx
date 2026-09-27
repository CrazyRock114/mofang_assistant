// 0040 P6.4（deprecated，仅注释）：入口首屏已由录题工作台入口页（#/intake）取代，导航条目退役；
// 本页保留为 **旧 run 直链兼容壳**（#/proof/<runId> 仍能开到 ProofPage）。新流程走 #/intake。
// 0028 P2：试题录入页 —— R-028「先拖进来」形态（D-053②）
// 第一屏=大拖放区（拖拽 / Ctrl+V 粘贴 / 点选三入口），**先收素材后配置**：
// 学段学科沿用共享状态（0024 同源）且只作默认值，识别完在校对页改；保存时才问目录。
// PDF 拖入即转交 PDF 切题工作区（0036 / R-027）；同批图片不静默丢。
//
// 进度=阶段进度条（D-052：不做字级流式），数据源=recog.event；关页回来按 #/proof/<runId> 续。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MofangRecogBridge } from '../../shared/contracts/bridge.js';
import type { RecogEventPayload, RecogRun, RecogRunDetail } from '../../shared/contracts/recog-run-types.js';
import type { ProofPageInput } from '../../shared/contracts/recog-ui-types.js';
import { classifyMaterials, MATERIAL_MAX_PAGES } from '../../recog/material.js';
import { scanDraftsToProofItems, runPagesToProofPages } from '../../recog/runs/to-proof-items.js';
import { createRecogService } from '../services/RecogServiceFactory.js';
import { createBankExtServices } from '../services/BankExtServiceFactory.js';
import { useStageSubject } from '../state/use-stage-subject.js';
import { filesFromDrop, filesFromInput, filesFromPaste, filesToMaterials, pastedFileName } from '../recog/intake.js';
// 0036：PDF 交给切题工作区（跨路由一次性交接，不序列化 File）
import { putPendingPdf } from '../splitting/handoff.js';
// 0036 目检返工：每屏都能返回上一级（从切题工作区过来 → 返回切题项目）
import { resolveBackHref, hashSearchOf, backLabelOf } from '../utils/nav.js';

/** from-aware 返回条（校对页由 ProofPage 自己渲染，这里覆盖录题页特有的三屏） */
function backBar(): React.ReactElement {
  const search = typeof window === 'undefined' ? '' : window.location.hash;
  return (
    <div className="page-head" style={{ marginBottom: 8 }}>
      <a className="page-back" data-testid="intake-back" href={resolveBackHref(hashSearchOf(search), '#/')}>
        ← {backLabelOf(hashSearchOf(search), '返回首页')}
      </a>
    </div>
  );
}
import { ProofPage, type ProofPageProps } from './ProofPage.js';

const STAGE_LABEL: Record<RecogRun['status'], string> = {
  queued: '排队中',
  ocr: '识别中',
  ai: '整理题卡',
  done: '已完成',
  error: '失败',
  cancelled: '已取消',
};

/** 进度条阶段文案以事件为准（事件先于状态回读到达；D-052 阶段进度条的数据源就是它） */
const EVENT_STAGE_LABEL: Record<RecogEventPayload['type'], string> = {
  queued: '排队中',
  ocr: '识别中',
  ai: '整理题卡',
  card: '整理题卡',
  done: '已完成',
  error: '识别失败',
  cancelled: '已取消',
};

interface Props {
  /** 路由 #/proof/<runId> 带入（关页回来续跑）；缺省=第一屏 */
  runId?: string;
  /** 测试注入；缺省 createRecogService() */
  recog?: MofangRecogBridge;
  /** 测试注入：透传给 ProofPage 的 bank（避免真 IPC） */
  bank?: ProofPageProps['bank'];
}

/** 学段选项：与采集页同一套三项（两处本地常量，改动需同步） */
const INTAKE_STAGES = ['小学', '初中', '高中'] as const;

/** 进度条百分比：页阶段按完成页数，ai/done 阶段满格 */
function progressPercent(event: RecogEventPayload | null): number {
  if (!event) return 0;
  if (event.type === 'done') return 100;
  if (event.type === 'ai' || event.type === 'card') return 100;
  if (event.type === 'queued') return 0;
  return Math.round((event.progress ?? 0) * 100);
}

export function ProofIntakePage({ runId: runIdProp, recog: recogProp, bank }: Props) {
  const recog = useMemo(() => recogProp ?? createRecogService(), [recogProp]);
  const stageSubject = useStageSubject();

  const [runId, setRunId] = useState<string | null>(runIdProp ?? null);
  const [detail, setDetail] = useState<RecogRunDetail | null>(null);
  const [event, setEvent] = useState<RecogEventPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [subjectLabel, setSubjectLabel] = useState('');
  const [subjectOptions, setSubjectOptions] = useState<Array<{ id: string; label: string }>>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // 学科下拉选项：字典归一行（site 为空），与题库页/采集页同源
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

  // 0024 共享状态同源：题库页选的学科（字典 id）解析成 label 作校对页默认值（可改，不阻断）
  useEffect(() => {
    const id = stageSubject.subjectId;
    if (!id) {
      setSubjectLabel('');
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const entry = await createBankExtServices().dict.getEntry(id);
        if (alive) setSubjectLabel(entry?.label ?? '');
      } catch {
        if (alive) setSubjectLabel('');
      }
    })();
    return () => { alive = false; };
  }, [stageSubject.subjectId]);
  // 路由带入的 runId 变化（前进/后退）时同步本地态
  useEffect(() => {
    if (runIdProp && runIdProp !== runId) setRunId(runIdProp);
  }, [runIdProp, runId]);

  /** Ctrl+V：挂在 document 上——用户不必先点一下拖放区（R-028 的「顺手」要求） */
  useEffect(() => {
    if (runId || busy) return;
    const onPaste = (e: ClipboardEvent): void => {
      const files = filesFromPaste(e.clipboardData);
      if (files.length > 0) {
        e.preventDefault();
        void startRun(files);
      }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  });

  const loadDetail = useCallback(async (id: string): Promise<void> => {
    const next = await recog.status({ runId: id });
    setDetail(next);
    return;
  }, [recog]);

  // 事件订阅：只认当前 run（多 run 并存时互不串台）
  useEffect(() => {
    const off = recog.onEvent((payload) => {
      setEvent((prev) => (prev && prev.runId === payload.runId && prev.type === payload.type && prev.pageIndex === payload.pageIndex ? prev : payload));
      if (payload.runId !== runId) return;
      if (payload.type === 'done' || payload.type === 'error' || payload.type === 'cancelled') {
        void loadDetail(payload.runId).catch(() => undefined);
      }
    });
    return off;
  }, [recog, runId, loadDetail]);

  // 挂载/换 run：回读真相源（关页回来可继续）
  useEffect(() => {
    if (!runId) return;
    let alive = true;
    void (async () => {
      try {
        const next = await recog.status({ runId });
        if (alive) setDetail(next);
      } catch (err) {
        if (alive) setNotice(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { alive = false; };
  }, [recog, runId]);

  const startRun = async (files: File[]): Promise<void> => {
    if (files.length === 0) {
      setNotice('没有收到文件（拖拽图片、Ctrl+V 粘贴截图，或点击选择文件）');
      return;
    }
    // 逐项候选：名字/类型/大小与 File 一一对应（分类器返回同一批对象的子集，用引用回指保序保真）
    const candidates = files.map((f, i) => ({
      name: f.name || pastedFileName(i + 1),
      type: f.type,
      size: f.size,
    }));
    const classified = classifyMaterials(candidates);
    // 0036（R-027）：PDF 不再是降级提示——交给切题工作区（#/split）现场切段画框识别。
    // 一次性交接（putPendingPdf）把 File 原样带过去；同批图片不静默丢，用 notice 说明去向。
    if (classified.pdf.length > 0) {
      const pdfFiles: File[] = [];
      files.forEach((f, i) => {
        if (classified.pdf.includes(candidates[i])) pdfFiles.push(f);
      });
      putPendingPdf(
        pdfFiles,
        classified.accepted.length > 0
          ? `同批拖入的 ${classified.accepted.length} 张图片未处理（切题工作区只处理 PDF）；需要识别请回到本页重新拖入。`
          : null,
      );
      if (typeof window !== 'undefined') window.location.hash = '#/split';
      return;
    }
    if (classified.accepted.length === 0) {
      setNotice(
        classified.rejected.length > 0
          ? `没有可识别的图片：${classified.rejected.map((r) => `${r.name}（${r.reason}）`).join('；')}`
          : '没有可识别的图片素材',
      );
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const acceptedSet = new Set(classified.accepted);
      const picked: File[] = [];
      const pickedNames: string[] = [];
      files.forEach((f, i) => {
        if (acceptedSet.has(candidates[i])) {
          picked.push(f);
          pickedNames.push(candidates[i].name);
        }
      });
      const materials = await filesToMaterials(picked, pickedNames);
      const created = await recog.create({ materials, sourceKind: 'image' });
      // 路由带上 runId：关页/刷新回来即接上（断点续跑入口）
      if (typeof window !== 'undefined' && !window.location.hash.includes(created.runId)) {
        window.location.hash = `#/proof/${created.runId}`;
      }
      setRunId(created.runId);
      setEvent({ runId: created.runId, type: 'queued', pageCount: created.pageCount, progress: 0 });
      if (classified.rejected.length > 0) {
        setNotice(`部分文件未受理：${classified.rejected.map((r) => `${r.name}（${r.reason}）`).join('；')}`);
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleCancel = async (): Promise<void> => {
    if (!runId) return;
    try {
      await recog.cancel({ runId });
      await loadDetail(runId);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  };

  const handleResume = async (): Promise<void> => {
    if (!runId) return;
    try {
      await recog.resume({ runId });
      await loadDetail(runId);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  };

  const proofInput: ProofPageInput | null = useMemo(() => {
    if (!detail || detail.drafts.length === 0) return null;
    return {
      pages: runPagesToProofPages(detail.pages),
      items: scanDraftsToProofItems(detail.drafts),
      warnings: detail.run.warnings,
    };
  }, [detail]);

  // 只认本 run 的事件（多 run 并存不串台）；阶段文案跟随事件的最新状态
  const activeEvent = event && runId && event.runId === runId ? event : null;
  const fullProgress = progressPercent(activeEvent);
  const status = detail?.run.status ?? 'queued';
  const stageLabel = activeEvent ? EVENT_STAGE_LABEL[activeEvent.type] : STAGE_LABEL[status];

  // ===== 第二屏：进度（阶段进度条；D-052 不做字级流式） =====
  const progressScreen = (
    <div data-testid="recog-progress" style={{ padding: '2rem' }}>
      {backBar()}
      <h1 className="section-title">正在识别</h1>
      <div style={{ marginBottom: '0.5rem' }} data-testid="recog-stage">
        阶段：{stageLabel}
        {activeEvent?.pageCount ? `（页 ${activeEvent.pageIndex ?? 0}/${activeEvent.pageCount}）` : ''}
        {activeEvent?.type === 'card' && activeEvent.draftCount !== undefined ? `（已出题卡 ${activeEvent.draftCount}）` : ''}
      </div>
      <div
        data-testid="recog-progressbar"
        data-percent={fullProgress}
        role="progressbar"
        aria-valuenow={fullProgress}
        aria-valuemin={0}
        aria-valuemax={100}
        style={{ height: '10px', background: 'var(--line)', borderRadius: '6px', overflow: 'hidden', maxWidth: '480px' }}
      >
        <div style={{ width: `${fullProgress}%`, height: '100%', background: 'var(--accent, var(--ink-2))', transition: 'width 200ms' }} />
      </div>
      <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem' }}>
        <button className="btn" data-testid="btn-recog-cancel" disabled={!runId} onClick={() => void handleCancel()}>
          取消识别
        </button>
      </div>
      {notice && <div data-testid="notice">{notice}</div>}
    </div>
  );

  // ===== 第三屏：校对工作台（识别产出齐备即接管） =====
  if (proofInput) {
    // 0036：来自切题工作区的 run（sourceKind='pdf-split'）入库要打 origin='pdf-split' 溯源；
    // 其素材名是合成的（q1-p3.png），不能当卷标题默认值用，故此处不给 defaultTitle。
    const fromSplit = detail?.run.sourceKind === 'pdf-split';
    return (
      <ProofPage
        initialInput={proofInput}
        {...(bank ? { bank } : {})}
        runId={runId ?? undefined}
        {...(!fromSplit && detail?.run.sourceName ? { defaultTitle: detail.run.sourceName.replace(/\.[a-z0-9]+$/i, '') } : {})}
        {...(subjectLabel ? { defaultSubject: subjectLabel } : {})}
        {...(fromSplit ? { ingestOrigin: 'pdf-split' as const } : {})}
      />
    );
  }

  if (busy) return progressScreen;
  if (!runId) {
    return firstScreen({
      stage: stageSubject.stage,
      subjectId: stageSubject.subjectId,
      subjectOptions,
      onStageChange: (v) => stageSubject.setStage(v),
      onSubjectChange: (v) => stageSubject.setSubjectId(v),
      notice,
      dragActive,
      setDragActive,
      fileInputRef,
      startRun,
    });
  }
  if (!detail) return progressScreen;

  // ===== 中断态：失败/取消 —— 明示 + 续跑（已完成页跳过） =====
  if (detail.run.status === 'error' || detail.run.status === 'cancelled') {
    return (
      <div data-testid="recog-interrupted" style={{ padding: '2rem' }}>
        {backBar()}
        <h1 className="section-title">识别中断</h1>
        <div data-testid="recog-interrupted-reason">
          状态：{STAGE_LABEL[detail.run.status]}
          {detail.run.error ? ` — ${detail.run.error}` : ''}
        </div>
        <div style={{ color: 'var(--ink-2)', marginTop: '0.5rem' }}>
          已完成 {detail.run.pagesDone}/{detail.run.pageCount} 页；续跑会跳过已完成的页，只补未完成的。
        </div>
        <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem' }}>
          <button className="btn btn-primary" data-testid="btn-recog-resume" onClick={() => void handleResume()}>
            继续识别
          </button>
          <button
            className="btn"
            data-testid="btn-recog-restart"
            onClick={() => {
              setRunId(null);
              setDetail(null);
              setEvent(null);
              setNotice(null);
              if (typeof window !== 'undefined') window.location.hash = '#/proof';
            }}
          >
            换一批图片
          </button>
        </div>
        {notice && <div data-testid="notice">{notice}</div>}
      </div>
    );
  }

  // 识别跑完但没切出题（无行首题号/纯图卷/识别质量不足）：明示原因而不是空白校对台
  if (detail.run.status === 'done') {
    return (
      <div data-testid="recog-empty" style={{ padding: '2rem' }}>
        {backBar()}
        <h1 className="section-title">识别完成，但没有切出题目</h1>
        <div style={{ color: 'var(--ink-2)' }}>
          共 {detail.run.pageCount} 页；识别到文字但无行首题号，或原图是纯图/清晰度不足。
          {detail.run.warnings.length === 0 && ' 请换带题号的清晰图片重试。'}
        </div>
        {detail.run.warnings.length > 0 && (
          <ul data-testid="recog-warnings">
            {detail.run.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        )}
        <button
          className="btn"
          data-testid="btn-recog-restart"
          style={{ marginTop: '1rem' }}
          onClick={() => {
            setRunId(null);
            setDetail(null);
            setEvent(null);
            if (typeof window !== 'undefined') window.location.hash = '#/proof';
          }}
        >
          换一批图片
        </button>
      </div>
    );
  }

  return progressScreen;
}

/**
 * 第一屏：大拖放区（R-028 硬要求——先收素材，配置后置）。
 * 抽成函数只为了让「渲染分支」在组件里一眼可读；所有状态仍由组件持有。
 *
 * 目检返工（2026-09-17）：删掉「学段/学科可稍后设置」提示行——矫枉过正；
 * 学段/学科控件回到页面上，但压在拖放区下方的次要位置（默认值来自共享状态，改这里即改本次识别结果的归类）。
 */
interface FirstScreenProps {
  stage: string;
  subjectId: string;
  subjectOptions: Array<{ id: string; label: string }>;
  onStageChange: (value: string) => void;
  onSubjectChange: (value: string) => void;
  notice: string | null;
  dragActive: boolean;
  setDragActive: (v: boolean) => void;
  fileInputRef: { current: HTMLInputElement | null };
  startRun: (files: File[]) => Promise<void>;
}

function firstScreen(props: FirstScreenProps) {
  const { stage, subjectId, subjectOptions, onStageChange, onSubjectChange } = props;
  const { notice, dragActive, setDragActive, fileInputRef, startRun } = props;

  return (
    <div style={{ padding: '2rem' }}>
      {/* 0036 目检返工（用户要求 1：每个界面都要有返回）：录题首屏补返回上一级 */}
      {backBar()}
      <h1 className="section-title">试题录入</h1>

      <div
        data-testid="recog-dropzone"
        data-drag-active={dragActive}
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragActive(false);
          void startRun(filesFromDrop(e.dataTransfer));
        }}
        onClick={() => fileInputRef.current?.click()}
        onPaste={(e) => {
          const files = filesFromPaste(e.clipboardData);
          if (files.length > 0) {
            e.preventDefault();
            void startRun(files);
          }
        }}
        style={{
          border: `2px dashed ${dragActive ? 'var(--accent, var(--ink))' : 'var(--line-strong)'}`,
          borderRadius: '16px',
          padding: '4rem 2rem',
          textAlign: 'center',
          cursor: 'pointer',
          background: dragActive ? 'var(--card-warm)' : 'var(--card)',
        }}
      >
        <div style={{ fontSize: '2rem' }}>🖼</div>
        <div style={{ fontSize: '1.05rem', marginTop: '0.5rem' }} data-testid="dropzone-title">
          把卷子图片拖到这里
        </div>
        <div style={{ color: 'var(--ink-2)', marginTop: '0.25rem' }}>
          也可以直接 Ctrl+V 粘贴截图，或点击此处选择文件；最多 {MATERIAL_MAX_PAGES} 页
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*"
          data-testid="recog-file-input"
          style={{ display: 'none' }}
          onChange={(e) => {
            void startRun(filesFromInput(e.target.files));
            e.target.value = '';
          }}
        />
      </div>

      {/* 次要位置：学段/学科（识别结果的默认归类；不挡拖放，也不要求先配再拖） */}
      <div
        data-testid="intake-context"
        style={{
          marginTop: '0.9rem', display: 'flex', flexWrap: 'wrap', alignItems: 'center',
          gap: '0.4rem 1rem', color: 'var(--ink-2)', fontSize: '0.9em',
        }}
      >
        <label>
          学段：
          <select
            className="select"
            data-testid="intake-stage-select"
            value={stage}
            onChange={(e) => onStageChange(e.target.value)}
          >
            <option value="">未设置</option>
            {INTAKE_STAGES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          学科：
          <select
            className="select"
            data-testid="intake-subject-select"
            value={subjectId}
            onChange={(e) => onSubjectChange(e.target.value)}
          >
            <option value="">未设置</option>
            {subjectOptions.map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
        </label>
        <span>识别结果的默认归类，可在校对页修改</span>
      </div>

      {notice && (
        <div data-testid="notice" style={{ marginTop: '1rem' }}>
          {notice}
        </div>
      )}
    </div>
  );
}
