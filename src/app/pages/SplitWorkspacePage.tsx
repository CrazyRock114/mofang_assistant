// 0036 P1–P3：PDF 切题工作区（分治切段 → 手动框选 → 一题一 run → 校对入库）
//
// 形态取舍（对齐 D-052/D-053 的「打开即用 + 决策后置」）：
//   第一屏就是工作现场——拖 PDF 进来即建项目、按 15 页顺切、当场能画框；学段/学科沿用共享状态作默认值，
//   识别完成后与框一起锁定（状态词，不是错误词）。
//   框选全手动（对标竞品，不做 AI 自动切分）；识别一题一 run、复用 0028 编排与进度事件。
//
// 状态真相源分工：
//   工作区文件态（项目/段/框/run 关联）在主进程（split.* 通道），本页只是视图 + 1.5s 防抖回写；
//   识别进度走 0028 的 recog.event（不自建轮询）。
//
// 懒加载：pdfjs 与页图缓存走动态 import —— 不进首屏包，也不让路由单测去初始化 pdfjs worker。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MofangRecogBridge, MofangSplitBridge } from '../../shared/contracts/bridge.js';
import type { RecogEventPayload } from '../../shared/contracts/recog-run-types.js';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type {
  RecogRunLinkStatus, SplitBox, SplitBoxType, SplitDraft, SplitProjectMeta, SplitProjectSummary,
  SplitRunLink, SplitSegment,
} from '../../shared/contracts/split-types.js';
import {
  BOX_MIN_SIZE, createUndoStack, isQuestionLocked, makeBoxId, nextBoxSeq, nextQuestionId, questionIds,
  shortcutOf,
} from '../../recog/splitting/box-model.js';
import {
  SEGMENT_SUGGESTED_PAGES, defaultSegments, makeSegment, nextSegmentId, segmentDraftOf,
  segmentsBlockingSave, validateSegments, withSegmentDraft,
} from '../../recog/splitting/workspace-model.js';
import { createDebouncedSaver } from '../../recog/splitting/auto-save.js';
import { createRecogService } from '../services/RecogServiceFactory.js';
import { createSplitService } from '../services/SplitServiceFactory.js';
import { createBankExtServices } from '../services/BankExtServiceFactory.js';
import { useStageSubject } from '../state/use-stage-subject.js';
import { BoxCanvas } from '../splitting/BoxCanvas.js';
import type { PageImageStore } from '../splitting/page-images.js';
import { launchQuestionRun } from '../splitting/run-launch.js';
import { readSourceBytes, uploadSourceBytes } from '../splitting/source-io.js';
import { takePendingPdf } from '../splitting/handoff.js';
import { withFrom } from '../utils/nav.js';

const RUN_STATUS_LABEL: Record<RecogRunLinkStatus, string> = {
  creating: '发起中',
  queued: '排队中',
  ocr: '识别中',
  ai: '整理题卡',
  done: '已识别',
  error: '识别失败',
  cancelled: '已取消',
};

const BOX_TYPE_LABEL: Record<SplitBoxType, string> = { text: '题干文字', image: '题干配图', answer: '答案解析' };
const STAGES = ['小学', '初中', '高中'] as const;

/** recog 事件类型 → 题卡状态（'card' 属于 ai 阶段：题卡在逐题产出） */
function linkStatusOf(type: RecogEventPayload['type']): RecogRunLinkStatus {
  if (type === 'card') return 'ai';
  return type;
}

function stripExt(name: string): string {
  return name.replace(/\.[a-z0-9]+$/i, '');
}

interface Props {
  /** 路由 #/split/<projectId> 带入；缺省=导入首屏/项目列表 */
  projectId?: string;
  /** 测试注入；缺省 createSplitService() */
  split?: MofangSplitBridge;
  /** 测试注入；缺省 createRecogService() */
  recog?: MofangRecogBridge;
}

export function SplitWorkspacePage({ projectId: projectIdProp, split: splitProp, recog: recogProp }: Props) {
  const split = useMemo(() => splitProp ?? createSplitService(), [splitProp]);
  const recog = useMemo(() => recogProp ?? createRecogService(), [recogProp]);
  const stageSubject = useStageSubject();

  const [projectId, setProjectId] = useState<string | null>(projectIdProp ?? null);
  const [meta, setMeta] = useState<SplitProjectMeta | null>(null);
  const [draft, setDraft] = useState<SplitDraft | null>(null);
  const [projects, setProjects] = useState<SplitProjectSummary[]>([]);
  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [boxType, setBoxType] = useState<SplitBoxType>('text');
  const [activeQid, setActiveQid] = useState<string | null>(null);
  const [selectedBoxId, setSelectedBoxId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<string>('idle');
  const [pageSource, setPageSource] = useState<HTMLCanvasElement | null>(null);
  const [historyTick, setHistoryTick] = useState(0);
  const [subjectOptions, setSubjectOptions] = useState<Array<{ id: string; label: string }>>([]);

  const docRef = useRef<{ doc: PDFDocumentProxy; pageCount: number } | null>(null);
  const storeRef = useRef<PageImageStore | null>(null);
  /** 撤销栈持有整段框集快照（深度 50；任务书要求 ≥20 步） */
  const undoRef = useRef(createUndoStack<SplitBox[]>([]));
  const saverRef = useRef<ReturnType<typeof createDebouncedSaver<SplitDraft>> | null>(null);
  const draftRef = useRef<SplitDraft | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  /** 当前段 id 的 ref：异步流程里读最新值，避免闭包拿到旧段 */
  const activeSegmentRef = useRef<string | null>(null);
  /** 已尝试加载的项目 id（防重复加载/失败重试风暴；返回列表时复位） */
  const loadedProjectIdRef = useRef<string | null>(null);

  draftRef.current = draft;
  activeSegmentRef.current = activeSegmentId;

  const segments = meta?.segments ?? [];
  const activeSegment: SplitSegment | null = segments.find((s) => s.id === activeSegmentId) ?? null;
  const segmentDraft = draft && activeSegment ? segmentDraftOf(draft, activeSegment.id) : { boxes: [], runs: [] };
  const segIssues = useMemo(() => validateSegments(segments, meta?.pageCount ?? 0), [segments, meta]);
  // 0040 P6.2（锁定语义软化，D-054 并入）：识别完成的题不再是「改框须先删识别结果」——
  // 「解锁并重识别」一步把该题移出锁定集（框可改、课程可选），再点识别即覆盖旧结果。
  // 解锁态按段记（运行期状态，不落草稿）：切段天然各自生效，无需复位副作用；
  // 覆盖识别一发起，run 状态就回到 creating，锁自然重算。
  const [unlockedBySegment, setUnlockedBySegment] = useState<Record<string, string[]>>({});
  const unlockedQids = useMemo(
    () => new Set(activeSegmentId ? unlockedBySegment[activeSegmentId] ?? [] : []),
    [unlockedBySegment, activeSegmentId],
  );
  const lockedQids = useMemo(
    () => new Set(
      segmentDraft.runs
        .filter((r) => isQuestionLocked(segmentDraft.runs, r.qid) && !unlockedQids.has(r.qid))
        .map((r) => r.qid),
    ),
    [segmentDraft.runs, unlockedQids],
  );
  const qids = useMemo(() => questionIds(segmentDraft.boxes), [segmentDraft.boxes]);
  const pageBoxes = useMemo(() => segmentDraft.boxes.filter((b) => b.page === page), [segmentDraft.boxes, page]);
  const pendingQids = qids.filter((q) => !segmentDraft.runs.some((r) => r.qid === q));
  /** 0040 P6.2：已解锁待覆盖重识别的题（进「识别本段」的计数与启用条件） */
  const redoQids = qids.filter((q) => unlockedQids.has(q));

  // ---------- 学科下拉（字典归一行，与录题页/题库页同源） ----------
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
    return () => {
      alive = false;
    };
  }, []);

  // ---------- 草稿自动保存（1.5s 防抖；关页/切隐藏即 flush） ----------
  useEffect(() => {
    if (!projectId) return;
    const saver = createDebouncedSaver<SplitDraft>({
      save: async (value) => {
        await split.saveDraft({ projectId, draft: value });
      },
      onState: (state, error) => {
        setSaveState(state);
        if (state === 'error' && error) setNotice(`草稿保存失败：${error}`);
      },
    });
    saverRef.current = saver;
    const flush = (): void => {
      void saver.flush();
    };
    window.addEventListener('beforeunload', flush);
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', onVisibility);
      flush();
      saver.dispose();
      saverRef.current = null;
    };
  }, [projectId, split]);

  /** 段草稿提交（不可变更新 + 防抖落盘 + 撤销栈入栈） */
  const commitSegmentDraft = useCallback(
    (boxes: SplitBox[], runs?: SplitRunLink[], pushUndo = true): void => {
      const segmentId = activeSegmentRef.current;
      const current = draftRef.current;
      if (!segmentId || !current) return;
      if (pushUndo) undoRef.current.push(segmentDraftOf(current, segmentId).boxes);
      const seg = segmentDraftOf(current, segmentId);
      const next = withSegmentDraft(current, segmentId, { boxes, runs: runs ?? seg.runs }, new Date().toISOString());
      setDraft(next);
      setHistoryTick((t) => t + 1);
      saverRef.current?.schedule(next);
    },
    [],
  );

  // ---------- 打开项目 ----------
  const openProject = useCallback(
    async (id: string): Promise<void> => {
      setBusy(true);
      setNotice(null);
      try {
        const detail = await split.openProject({ projectId: id });
        setProjectId(id);
        setMeta(detail.meta);
        setDraft(detail.draft);
        const first = detail.meta.segments[0] ?? null;
        setActiveSegmentId(first ? first.id : null);
        setPage(first ? first.fromPage : 1);
        undoRef.current = createUndoStack<SplitBox[]>([]);
        setHistoryTick((t) => t + 1);
      } catch (err) {
        setNotice(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [split],
  );

  /**
   * 打开由路由带入的项目。用「已加载过的项目 id」做闸而不是比对本地 state：
   * 直接在 #/split/<id> 上挂载（刷新页面 / 从别处深链进来）时，本地 state 初值就等于 prop，
   * 按 state 比对会**跳过加载**，工作区只剩一个「0 页」空壳（2026-09-18 返工中由用例逼出）。
   * ref 同时保证加载失败也不会每次渲染都重试（失败原因由 notice 呈现）。
   */
  useEffect(() => {
    if (!projectIdProp) return;
    if (loadedProjectIdRef.current === projectIdProp) return;
    loadedProjectIdRef.current = projectIdProp;
    void openProject(projectIdProp);
  }, [projectIdProp, openProject]);

  /**
   * 路由回到 #/split（无项目 id）→ 复位本地项目态，回到导入首屏 + 项目列表。
   * 同一组件实例不会因 hash 变化而重挂载（main.tsx 里两个分支共用同一个元素类型），
   * 所以「返回上一级」必须显式复位——否则「返回项目列表」与浏览器后退都会卡在工作区
   * （2026-09-18 用户目检案底：按钮点了没反应、项目列表永远看不到）。
   */
  useEffect(() => {
    if (projectIdProp || projectId === null) return;
    setProjectId(null);
    setMeta(null);
    setDraft(null);
    setActiveSegmentId(null);
    setPage(1);
    setPageSource(null);
    setNotice(null);
    setBusy(false);
    setImporting(null);
    storeRef.current = null;
    docRef.current = null;
    loadedProjectIdRef.current = null;
    undoRef.current = createUndoStack<SplitBox[]>([]);
  }, [projectIdProp, projectId]);

  // ---------- 导入 PDF（建项目 → 分块上传 → 解析页数 → 默认顺切） ----------
  const importPdf = useCallback(
    async (file: File): Promise<void> => {
      setImporting(`正在导入 ${file.name}…`);
      setNotice(null);
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const created = await split.createProject({ name: stripExt(file.name), sourceName: file.name, sourceBytes: bytes.length });
        await uploadSourceBytes(split, created.id, bytes, {
          onProgress: (done, total) => setImporting(`上传 ${file.name}…${Math.round((done / total) * 100)}%`),
        });
        setImporting(`解析 ${file.name}…`);
        const { loadPdf } = await import('../splitting/pdf-raster.js');
        const loaded = await loadPdf(bytes);
        const nextSegments = defaultSegments(loaded.pageCount, new Date().toISOString());
        await split.saveMeta({ projectId: created.id, pageCount: loaded.pageCount, segments: nextSegments });
        docRef.current = { doc: loaded.doc, pageCount: loaded.pageCount };
        storeRef.current = null; // 换项目即换页图缓存（键内无项目维度，靠新实例隔离）
        // 项目态一律由路由驱动（#/split/<id>）：本地不直接置 projectId——
        // 「本地置态 + 同时改 hash」会在 hashchange 之前出现一个 state 与路由不一致的窗口，
        // 正是 2026-09-18 目检「返回列表无效」案底的温床。
        if (typeof window !== 'undefined') window.location.hash = `#/split/${created.id}`;
      } catch (err) {
        setNotice(`导入失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setImporting(null);
      }
    },
    [split],
  );

  // 首屏：列项目 + 接住录题页交接过来的 PDF（一次性消费）
  useEffect(() => {
    if (projectId) return;
    let alive = true;
    void (async () => {
      try {
        const list = await split.listProjects();
        if (alive) setProjects(list);
      } catch {
        if (alive) setProjects([]);
      }
    })();
    const handoff = takePendingPdf();
    if (handoff && handoff.files.length > 0) {
      if (handoff.notice) setNotice(handoff.notice);
      void importPdf(handoff.files[0]);
    }
    return () => {
      alive = false;
    };
  }, [projectId, split, importPdf]);

  // ---------- 页图（LRU / 工作区缓存 / 现场渲染 三级回落） ----------
  const ensureStore = useCallback(async (): Promise<PageImageStore> => {
    if (storeRef.current) return storeRef.current;
    if (!meta || !projectId) throw new Error('项目尚未打开');
    const { PageImageStore: Store } = await import('../splitting/page-images.js');
    const store = new Store({
      split,
      projectId,
      getDoc: async () => {
        if (docRef.current) return docRef.current.doc;
        const bytes = await readSourceBytes(split, projectId, meta.sourceBytes);
        const { loadPdf } = await import('../splitting/pdf-raster.js');
        const loaded = await loadPdf(bytes);
        docRef.current = { doc: loaded.doc, pageCount: loaded.pageCount };
        return loaded.doc;
      },
    });
    storeRef.current = store;
    return store;
  }, [meta, projectId, split]);

  useEffect(() => {
    if (!meta || !projectId || !activeSegment) return;
    let alive = true;
    void (async () => {
      try {
        const store = await ensureStore();
        const image = await store.get(page);
        if (alive) setPageSource(image.canvas);
      } catch (err) {
        if (alive) setNotice(`第 ${page} 页渲染失败：${err instanceof Error ? err.message : String(err)}`);
      }
    })();
    return () => {
      alive = false;
    };
  }, [meta, projectId, activeSegment, page, ensureStore]);

  // ---------- 识别进度（复用 0028 事件，按 runId 认领到题卡） ----------
  useEffect(() => {
    const off = recog.onEvent((payload: RecogEventPayload) => {
      const current = draftRef.current;
      if (!current) return;
      for (const [segmentId, seg] of Object.entries(current.segments)) {
        const idx = seg.runs.findIndex((r) => r.runId === payload.runId);
        if (idx < 0) continue;
        const runs = [...seg.runs];
        const status = linkStatusOf(payload.type);
        // 失败原因必须留住（目检案底：只显示「识别失败」等于没信息）；重新起跑/成功即清空旧原因
        const error = payload.type === 'error' ? (payload.message ?? '识别失败（未返回原因）') : null;
        runs[idx] = { ...runs[idx], status, error };
        const next = withSegmentDraft(current, segmentId, { boxes: seg.boxes, runs }, new Date().toISOString());
        setDraft(next);
        saverRef.current?.schedule(next);
        return;
      }
    });
    return off;
  }, [recog]);

  // ---------- 框编辑 ----------
  const drawBox = (type: SplitBoxType, rect: { x: number; y: number; w: number; h: number }): void => {
    const qid = activeQid && !lockedQids.has(activeQid) ? activeQid : nextQuestionId(segmentDraft.boxes);
    const box: SplitBox = { id: makeBoxId(page, nextBoxSeq(segmentDraft.boxes)), qid, type, page, ...rect };
    setActiveQid(qid);
    commitSegmentDraft([...segmentDraft.boxes, box]);
  };

  const moveBoxById = (boxId: string, dx: number, dy: number): void => {
    commitSegmentDraft(
      segmentDraft.boxes.map((b) => {
        if (b.id !== boxId || lockedQids.has(b.qid)) return b;
        const x = Math.min(Math.max(0, b.x + dx), Math.max(0, 1 - b.w));
        const y = Math.min(Math.max(0, b.y + dy), Math.max(0, 1 - b.h));
        return { ...b, x, y };
      }),
    );
  };

  const resizeBoxById = (boxId: string, rect: { x: number; y: number; w: number; h: number }): void => {
    commitSegmentDraft(
      segmentDraft.boxes.map((b) => {
        if (b.id !== boxId || lockedQids.has(b.qid)) return b;
        return { ...b, ...rect, w: Math.max(BOX_MIN_SIZE, rect.w), h: Math.max(BOX_MIN_SIZE, rect.h) };
      }),
    );
  };

  const deleteSelected = useCallback((): void => {
    const boxId = selectedBoxId;
    if (!boxId) return;
    const currentId = activeSegmentRef.current;
    const current = draftRef.current;
    if (!currentId || !current) return;
    const seg = segmentDraftOf(current, currentId);
    const box = seg.boxes.find((b) => b.id === boxId);
    // 0040 P6.2：锁定判据统一走 lockedQids（已解锁的题在这里也放行——否则「解锁并重识别」只解了半边）
    if (!box || lockedQids.has(box.qid)) return;
    commitSegmentDraft(seg.boxes.filter((b) => b.id !== boxId));
    setSelectedBoxId(null);
  }, [selectedBoxId, commitSegmentDraft, lockedQids]);

  const restoreBoxes = useCallback((boxes: SplitBox[] | null): void => {
    if (!boxes) return;
    commitSegmentDraft(boxes, undefined, false);
  }, [commitSegmentDraft]);

  /** 重试失败题：recog.resume 走 error→ocr 续跑边（已完成的页由文件 checkpoint 跳过，不重跑） */
  const retryRun = useCallback(async (qid: string): Promise<void> => {
    const segmentId = activeSegmentRef.current;
    const current = draftRef.current;
    if (!segmentId || !current) return;
    const seg = segmentDraftOf(current, segmentId);
    const link = seg.runs.find((r) => r.qid === qid);
    if (!link) return;
    setNotice(`正在重试 ${qid}…`);
    try {
      await recog.resume({ runId: link.runId });
      // 状态回到在跑语义（后续进度仍由 recog.event 覆盖）
      const runs = seg.runs.map((r) => (r.qid === qid ? { ...r, status: 'ocr' as const, error: null } : r));
      const next = withSegmentDraft(current, segmentId, { boxes: seg.boxes, runs }, new Date().toISOString());
      setDraft(next);
      if (projectId) {
        await split.saveDraft({ projectId, draft: next });
        setSaveState('saved');
      }
      setNotice(null);
    } catch (err) {
      setNotice(`${qid} 重试失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [recog, split, projectId]);

  const gotoQuestion = useCallback((delta: number): void => {
    const currentId = activeSegmentRef.current;
    const current = draftRef.current;
    if (!currentId || !current) return;
    const seg = segmentDraftOf(current, currentId);
    const ids = questionIds(seg.boxes);
    if (ids.length === 0) return;
    const idx = activeQid ? ids.indexOf(activeQid) : -1;
    const nextIdx = Math.min(ids.length - 1, Math.max(0, idx + delta));
    const nextQid = ids[nextIdx];
    setActiveQid(nextQid);
    const box = seg.boxes.find((b) => b.qid === nextQid);
    if (box) setPage(box.page);
  }, [activeQid]);

  // 快捷键：删除 / 撤销 / 重做 / 上下一题 / 取消（输入态放过）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) return;
      const action = shortcutOf({ key: event.key, ctrl: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey });
      if (!action) return;
      if (action === 'delete') {
        event.preventDefault();
        deleteSelected();
      } else if (action === 'undo') {
        event.preventDefault();
        restoreBoxes(undoRef.current.undo());
      } else if (action === 'redo') {
        event.preventDefault();
        restoreBoxes(undoRef.current.redo());
      } else if (action === 'next-question') {
        event.preventDefault();
        gotoQuestion(1);
      } else if (action === 'prev-question') {
        event.preventDefault();
        gotoQuestion(-1);
      } else if (action === 'escape') {
        setSelectedBoxId(null);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [deleteSelected, restoreBoxes, gotoQuestion]);

  // ---------- 识别本段（一题一 run；本段队列串行，避免免费通道被自己的并发打满） ----------
  const recognizeSegment = async (): Promise<void> => {
    const segmentId = activeSegmentRef.current;
    const current = draftRef.current;
    if (!segmentId || !current || !meta) return;
    const seg = segmentDraftOf(current, segmentId);
    // 0040：已解锁的题重新进 todo（重识别覆盖旧结果）；未解锁的已识别题仍跳过
    const todo = questionIds(seg.boxes).filter(
      (q) => !seg.runs.some((r) => r.qid === q) || unlockedQids.has(q),
    );
    if (todo.length === 0) {
      setNotice('本段的题都已发起过识别（要重识别请点该题「解锁并重识别」）');
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const store = await ensureStore();
      const { createCropper, createStitcher } = await import('../splitting/page-images.js');
      const cropper = createCropper(store);
      const stitcher = createStitcher();
      let done = 0;
      for (const qid of todo) {
        setNotice(`正在发起识别：${qid}（${done + 1}/${todo.length}）…`);
        try {
          const own = seg.boxes.filter((b) => b.qid === qid);
          const sizes = await store.resolvePageSizes([...new Set(own.map((b) => b.page))]);
          const created = await launchQuestionRun({
            boxes: seg.boxes, qid, pageSizes: sizes, crop: cropper, stitch: stitcher, recog,
          });
          await persistRunLink(qid, { runId: created.runId, status: 'creating', questionIds: [] });
          done++;
        } catch (err) {
          setNotice(`${qid} 识别发起失败：${err instanceof Error ? err.message : String(err)}`);
        }
      }
      setNotice(done > 0 ? `已发起 ${done} 题识别；进度见题卡状态（识别完成后框与课程锁定）` : null);
    } finally {
      setBusy(false);
    }
  };

  /** 写回 run 关联并立即落盘（runId 丢了就没法恢复轮询，这条不能等防抖） */
  const persistRunLink = async (qid: string, link: Omit<SplitRunLink, 'qid'>): Promise<void> => {
    const segmentId = activeSegmentRef.current;
    const current = draftRef.current;
    if (!segmentId || !current) return;
    const seg = segmentDraftOf(current, segmentId);
    const runs = [...seg.runs.filter((r) => r.qid !== qid), { qid, ...link }];
    const next = withSegmentDraft(current, segmentId, { boxes: seg.boxes, runs }, new Date().toISOString());
    setDraft(next);
    if (!projectId) return;
    try {
      await split.saveDraft({ projectId, draft: next });
      setSaveState('saved');
    } catch (err) {
      setNotice(`识别队列保存失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // ---------- 段操作 ----------
  const persistSegments = async (next: SplitSegment[], nextActiveId: string | null): Promise<void> => {
    if (!meta || !projectId) return;
    const blocking = segmentsBlockingSave(validateSegments(next, meta.pageCount));
    if (blocking.length > 0) {
      setNotice(blocking.join('；'));
      return;
    }
    try {
      const summary = await split.saveMeta({ projectId, pageCount: meta.pageCount, segments: next });
      setMeta({ ...meta, segments: next, updatedAt: summary.updatedAt });
      setActiveSegmentId(nextActiveId);
      const seg = next.find((s) => s.id === nextActiveId);
      if (seg) setPage(seg.fromPage);
      setNotice(null);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  };

  const addSegment = async (): Promise<void> => {
    if (!meta) return;
    const last = segments[segments.length - 1];
    const from = last ? Math.min(meta.pageCount, last.toPage + 1) : 1;
    const next = makeSegment(nextSegmentId(segments), from, Math.min(meta.pageCount, from + SEGMENT_SUGGESTED_PAGES - 1), new Date().toISOString());
    await persistSegments([...segments, next], next.id);
  };

  const removeSegment = async (id: string): Promise<void> => {
    // 段删掉会连带丢掉该段的框与识别队列（草稿按段存）：先说后果与范围，再动手
    if (typeof window !== 'undefined' && !window.confirm('删除该切段会同时丢弃这一段的框与识别记录，确定删除？')) return;
    const rest = segments.filter((s) => s.id !== id);
    await persistSegments(rest, rest[0]?.id ?? null);
  };

  const openRun = async (runId: string): Promise<void> => {
    try {
      await saverRef.current?.flush();
    } catch {
      /* 同上：落盘失败已由 saveState 呈现 */
    }
    // 带 from=split/<项目>：校对页据此显示「返回切题项目」（2026-09-18 目检案底：
    // 校对页原本只有返回首页，用户从切题过来后找不到回切题项目的路）
    const href = projectId ? withFrom(`#/proof/${runId}`, `split/${projectId}`) : `#/proof/${runId}`;
    if (typeof window !== 'undefined') window.location.hash = href;
  };

  /**
   * 返回项目列表：**先等草稿落盘再离开**。
   * 草稿是 1.5s 防抖的，若直接改 hash，紧接着点「继续切题」会读到还没写入的旧 draft.json，
   * 用户看到的是「刚画的框不见了」（2026-09-18 S-2 探针实测抓到的竞态）。
   */
  const backToList = async (): Promise<void> => {
    try {
      await saverRef.current?.flush();
    } catch {
      /* flush 内部已把失败记进 saveState/notice，这里不阻断返回 */
    }
    if (typeof window !== 'undefined') window.location.hash = '#/split';
  };

  // ---------- 渲染：首屏（导入 + 项目列表） ----------
  if (!projectId) {
    return (
      <div style={{ padding: '2rem' }}>
        <div className="page-head" style={{ marginBottom: 8 }}>
          {/* 返回上一级：切题首屏的上一级是首页（与采集页/排版页同一 page-head + page-back 形态） */}
          <a className="page-back" data-testid="split-back-home" href="#/">← 返回首页</a>
        </div>
        <h1 className="section-title">PDF 切题录题</h1>
        <div
          data-testid="split-dropzone"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const file = Array.from(e.dataTransfer.files).find((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
            if (file) void importPdf(file);
            else setNotice('请拖入 PDF 文件');
          }}
          onClick={() => fileInputRef.current?.click()}
          style={{ border: '2px dashed var(--line-strong)', borderRadius: '16px', padding: '3rem 2rem', textAlign: 'center', cursor: 'pointer', background: 'var(--card)' }}
        >
          <div style={{ fontSize: '2rem' }}>📄</div>
          <div data-testid="split-dropzone-title" style={{ fontSize: '1.05rem', marginTop: '0.5rem' }}>
            把整本教辅 / 整卷 PDF 拖到这里
          </div>
          <div style={{ color: 'var(--ink-2)', marginTop: '0.25rem' }}>
            导入后按每段 {SEGMENT_SUGGESTED_PAGES} 页顺切成段（可改），逐题框选后识别；草稿自动保存，关页可续
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,.pdf"
            data-testid="split-file-input"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void importPdf(file);
              e.target.value = '';
            }}
          />
        </div>
        {importing && <div data-testid="split-importing" style={{ marginTop: '1rem' }}>{importing}</div>}
        {notice && <div data-testid="notice" style={{ marginTop: '1rem' }}>{notice}</div>}

        {projects.length > 0 && (
          <div style={{ marginTop: '2rem' }}>
            <h2 className="section-title" style={{ fontSize: '1rem' }}>已有切题项目</h2>
            <ul data-testid="split-project-list" style={{ listStyle: 'none', padding: 0 }}>
              {projects.map((p) => (
                <li key={p.id} className="card" style={{ padding: '0.75rem', marginBottom: '0.5rem', display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                  <span style={{ flex: 1 }}>{p.name}（{p.sourceName}）— {p.pageCount} 页 / {p.segmentCount} 段</span>
                  <button className="btn" data-testid={`split-open-${p.id}`} onClick={() => { window.location.hash = `#/split/${p.id}`; }}>继续切题</button>
                  <button
                    className="btn"
                    data-testid={`split-remove-${p.id}`}
                    onClick={() => {
                      if (typeof window !== 'undefined' && !window.confirm(`删除项目「${p.name}」会连同工作区（PDF 副本 / 页图缓存 / 草稿）一起删除，确定？`)) return;
                      void (async () => {
                        await split.removeProject({ projectId: p.id });
                        setProjects(await split.listProjects());
                      })();
                    }}
                  >
                    删除
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }

  // ---------- 渲染：工作区 ----------
  const saveLabel = saveState === 'saved' ? '草稿已保存'
    : saveState === 'saving' ? '保存中…'
      : saveState === 'error' ? '草稿保存失败'
        : '草稿待保存';

  return (
    <div data-testid="split-workspace" style={{ padding: '1rem' }}>
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
        <h1 className="section-title" style={{ margin: 0, fontSize: '1.1rem' }}>{meta?.name ?? '切题工作区'}</h1>
        <span style={{ color: 'var(--ink-2)', fontSize: '12px' }}>{meta?.sourceName} · {meta?.pageCount ?? 0} 页</span>
        <span data-testid="split-save-state" data-state={saveState} style={{ fontSize: '12px', color: saveState === 'error' ? 'var(--danger, #c0392b)' : 'var(--ink-2)' }}>
          {saveLabel}
        </span>
        <a
          className="page-back"
          data-testid="split-back-to-list"
          href="#/split"
          onClick={(e) => {
            // preventDefault：先等草稿落盘再改 hash（见 backToList 注释），锚点只为拿到 house 风格与可访问性
            e.preventDefault();
            void backToList();
          }}
        >
          ← 返回项目列表
        </a>
      </div>

      {notice && <div data-testid="notice" style={{ marginBottom: '0.5rem' }}>{notice}</div>}
      {segIssues.filter((i) => i.level === 'warning').map((i, idx) => (
        <div key={idx} data-testid="split-segment-warning" style={{ color: 'var(--ink-2)', fontSize: '12px' }}>⚠ {i.message}</div>
      ))}

      <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
        <aside style={{ width: '18rem', flexShrink: 0 }}>
          <section className="card" style={{ padding: '0.75rem' }}>
            <h2 className="section-title" style={{ fontSize: '0.95rem', marginTop: 0 }}>切段</h2>
            <ul data-testid="split-segments" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {segments.map((s) => (
                <li key={s.id} style={{ marginBottom: '0.25rem', display: 'flex', gap: '0.25rem' }}>
                  <button
                    className="btn"
                    data-testid={`split-segment-${s.id}`}
                    data-active={s.id === activeSegmentId ? 'true' : 'false'}
                    onClick={() => {
                      setActiveSegmentId(s.id);
                      setPage(s.fromPage);
                      setActiveQid(null);
                      setSelectedBoxId(null);
                      undoRef.current = createUndoStack<SplitBox[]>([]);
                      setHistoryTick((t) => t + 1);
                    }}
                    style={{ flex: 1, textAlign: 'left', fontWeight: s.id === activeSegmentId ? 600 : 400 }}
                  >
                    {s.title}（p{s.fromPage}–p{s.toPage}）
                  </button>
                  <button data-testid={`split-segment-remove-${s.id}`} onClick={() => void removeSegment(s.id)}>删除</button>
                </li>
              ))}
            </ul>
            <button className="btn" data-testid="split-segment-add" onClick={() => void addSegment()} style={{ marginTop: '0.5rem' }}>加一段</button>
          </section>

          <section className="card" style={{ padding: '0.75rem', marginTop: '0.75rem' }}>
            <h2 className="section-title" style={{ fontSize: '0.95rem', marginTop: 0 }}>本段题目（{qids.length}）</h2>
            {qids.length === 0 && (
              <div style={{ color: 'var(--ink-2)', fontSize: '12px' }}>
                还没有画框：在右侧页面上拖拽画一个框，即建一题（同一题的文字/图片/答案框共用一个题号）。
              </div>
            )}
            <ul data-testid="split-questions" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {qids.map((qid) => {
                const run = segmentDraft.runs.find((r) => r.qid === qid);
                const locked = lockedQids.has(qid);
                return (
                  <li key={qid} data-testid={`split-q-${qid}`} data-locked={locked ? 'true' : 'false'} style={{ marginBottom: '0.25rem', display: 'flex', gap: '0.25rem', alignItems: 'center', flexWrap: 'wrap' }}>
                    <button
                      className="btn"
                      data-testid={`split-q-select-${qid}`}
                      data-active={qid === activeQid ? 'true' : 'false'}
                      onClick={() => {
                        setActiveQid(qid);
                        const first = segmentDraft.boxes.find((b) => b.qid === qid);
                        if (first) {
                          setPage(first.page);
                          setSelectedBoxId(first.id);
                        }
                      }}
                      style={{ textAlign: 'left', fontWeight: qid === activeQid ? 600 : 400 }}
                    >
                      {locked ? '🔒 ' : ''}{qid}（{segmentDraft.boxes.filter((b) => b.qid === qid).length} 框）
                    </button>
                    {run && <span data-testid={`split-run-status-${qid}`} style={{ fontSize: '12px' }}>{RUN_STATUS_LABEL[run.status]}</span>}
                    {locked && (
                      <button
                        data-testid={`split-run-unlock-${qid}`}
                        title="解锁后框可改、学段学科可选；再点「识别本段」即用新框覆盖重识别"
                        onClick={() => {
                          setUnlockedBySegment((prev) => {
                            const seg = activeSegmentId ?? '';
                            const list = prev[seg] ?? [];
                            return list.includes(qid) ? prev : { ...prev, [seg]: [...list, qid] };
                          });
                          setNotice(`${qid} 已解锁：可改框与课程，再点「识别本段」即覆盖重识别`);
                        }}
                      >
                        解锁并重识别
                      </button>
                    )}
                    {run && <button data-testid={`split-run-open-${qid}`} onClick={() => void openRun(run.runId)}>校对</button>}
                    {run && (run.status === 'error' || run.status === 'cancelled') && (
                      <button data-testid={`split-run-retry-${qid}`} onClick={() => void retryRun(qid)}>重试</button>
                    )}
                    {run?.error && (
                      <div
                        data-testid={`split-run-error-${qid}`}
                        style={{ flexBasis: '100%', fontSize: '12px', color: 'var(--danger, #c0392b)' }}
                        title={run.error}
                      >
                        {run.error}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            <button
              className="btn btn-primary"
              data-testid="split-recognize"
              disabled={busy || pendingQids.length + redoQids.length === 0}
              onClick={() => void recognizeSegment()}
              style={{ marginTop: '0.5rem' }}
            >
              识别本段（{pendingQids.length} 待发起{redoQids.length > 0 ? ` + ${redoQids.length} 重识别` : ''}）
            </button>
          </section>
        </aside>

        <main style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
            {(['text', 'image', 'answer'] as SplitBoxType[]).map((t) => (
              <button
                key={t}
                className="btn"
                data-testid={`split-type-${t}`}
                data-active={t === boxType ? 'true' : 'false'}
                onClick={() => setBoxType(t)}
                style={{ fontWeight: t === boxType ? 600 : 400 }}
              >
                {BOX_TYPE_LABEL[t]}
              </button>
            ))}
            <span data-testid="split-active-q" style={{ color: 'var(--ink-2)', fontSize: '12px' }}>
              当前题：{activeQid ?? '（下一框自动起新题）'}
            </span>
            <button className="btn" data-testid="split-undo" disabled={!undoRef.current.canUndo()} onClick={() => restoreBoxes(undoRef.current.undo())}>撤销</button>
            <button className="btn" data-testid="split-redo" disabled={!undoRef.current.canRedo()} onClick={() => restoreBoxes(undoRef.current.redo())}>重做</button>
            <button className="btn" data-testid="split-delete" disabled={!selectedBoxId} onClick={deleteSelected}>删除框</button>
            <button className="btn" data-testid="split-new-question" onClick={() => { setActiveQid(null); setSelectedBoxId(null); }}>起新题</button>
            <span data-hidden-tick={historyTick} />
          </div>

          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
            <button className="btn" data-testid="split-prev-page" disabled={!activeSegment || page <= activeSegment.fromPage} onClick={() => setPage(page - 1)}>上一页</button>
            <span data-testid="split-page-label">第 {page} 页{activeSegment ? `（段 ${activeSegment.fromPage}–${activeSegment.toPage}）` : ''}</span>
            <button className="btn" data-testid="split-next-page" disabled={!activeSegment || page >= activeSegment.toPage} onClick={() => setPage(page + 1)}>下一页</button>
            <label style={{ fontSize: '12px', color: 'var(--ink-2)' }}>
              学段：
              <select
                className="select"
                data-testid="split-stage-select"
                value={stageSubject.stage}
                onChange={(e) => stageSubject.setStage(e.target.value)}
              >
                <option value="">未设置</option>
                {STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label style={{ fontSize: '12px', color: 'var(--ink-2)' }}>
              学科：
              <select
                className="select"
                data-testid="split-subject-select"
                value={stageSubject.subjectId}
                onChange={(e) => stageSubject.setSubjectId(e.target.value)}
              >
                <option value="">未设置</option>
                {subjectOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </label>
            {lockedQids.size > 0 && (
              <span data-testid="split-lock-status" style={{ fontSize: '12px', color: 'var(--accent, #2563eb)' }}>
                本段有 {lockedQids.size} 题已识别完成（框与课程锁定）；点该题「解锁并重识别」即可改
              </span>
            )}
          </div>

          <BoxCanvas
            pageNo={page}
            source={pageSource}
            boxes={pageBoxes}
            lockedQids={lockedQids}
            drawType={boxType}
            selectedBoxId={selectedBoxId}
            onSelect={setSelectedBoxId}
            onDraw={drawBox}
            onMove={moveBoxById}
            onResize={resizeBoxById}
          />

          {segmentDraft.runs.length > 0 && (
            <div data-testid="split-run-queue" style={{ marginTop: '0.75rem', fontSize: '12px', color: 'var(--ink-2)' }}>
              识别队列：
              {segmentDraft.runs.map((r) => (
                <span key={r.qid} data-testid={`split-queue-${r.qid}`} style={{ marginRight: '0.75rem' }}>
                  {r.qid}={RUN_STATUS_LABEL[r.status]}
                  {r.status === 'done' && `（已入库 ${r.questionIds.length} 题）`}
                  {r.error ? `（${r.error}）` : ''}
                </span>
              ))}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
