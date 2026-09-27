// 0040 P2~P5：录题工作台（一步到位引擎 + WYSIWYG 操作层）主页面。
//
// 呈现依据：`recog-workbench-v2 设计稿` 视图二/三（v4 冻结稿）。
// 一页三档（D-057）：
//   ✨ AI 自动（auto）  ：一步到位 VLM 出结构化草稿（图块走 DeepSeek-OCR 对账）
//   ◐ 半自动（semi）    ：两段式（OCR 转写 → 文本推理结构化）+ 顶部横幅 + 无 AI 一键按钮
//   ✂ 手动框选（垫底）  ：始终可用，零模型依赖（无模型时框选图可直接入题卡当图）
//
// 装配纪律：引擎（src/recog）在渲染层以注入式 invoke 运行，模型调用一律走 `ai.invoke` 白名单桥
// （Key 不出主进程，D-043）；本地裁图只送小图（0036「裁剪本地做」同口径）。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BankExtServices, BankService, DictEntry } from '../../shared/contracts/bank-types.js';
import type { MofangAiBridge, MofangRecogBridge, MofangSplitBridge } from '../../shared/contracts/bridge.js';
import type { RecogEventPayload } from '../../shared/contracts/recog-run-types.js';
import type {
  OnestepDraft, WorkbenchCard, WorkbenchFigure, WorkbenchFrame, WorkbenchRect, WorkbenchState,
  WorkbenchTreeSuggestion,
} from '../../shared/contracts/onestep-types.js';
// 0044（只增）：试卷文件夹类型（存为试卷弹层归属选择）
import type { PaperFolder } from '../../shared/contracts/bank-types.js';
import { SaveAsPaperModal } from '../workbench/SaveAsPaperModal.js';
import { allocateCardId, adoptedNodesOf, adoptedNodesPatch, draftToCard, makeFrame, newPendingCard, residualFigureRefs, verifyWarnings } from '../../recog/onestep/workbench.js';
import { countFigureNodes, replaceFigureSrc } from '../../recog/onestep/markdown.js';
import { cropNormalizedRect, type PageImageLike } from '../workbench/crop.js';
// 0057（只增）：图字节落 data-assets 资产 + content 资产引用 → 入库 images（两腿同口径）
import {
  normalizeHtmlAssets, persistImageSrc, persistImageSrcs, questionImagesFromHtml,
  displaySrcOf, toDisplayHtml,
} from '../workbench/asset-src.js';
import { takePendingDefaults, takePendingImages, type WorkbenchDefaults } from '../workbench/handoff.js';
// 0055（R-044）：默认学段学科（设置页偏好，无入口交接时的默认归类来源）
import { readDefaultStageSubject, stageOptionsWith } from '../state/default-stage-subject.js';
import { mapQuestionTypeToDict, typeOptionsOf } from '../workbench/question-types.js';
import { FULL_PAGE_RECT, recognizeRegion, type RecognizeOutcome } from '../workbench/recognize.js';
// 0070（R-052）：多帧卡「先拼后识」——逐帧裁剪 → 纵向拼接（0036 同一拼接器）→ 单图识别
import { recognizeStitchedFrames } from '../workbench/multiframe.js';
// 0070 乙方案：图块坐标换算（模型给的「相对送图」归一 → 题卡口径的「相对页」归一）
import { buildSentMap, mapBboxToPage, type SentMap } from '../workbench/figure-map.js';
import { createStitcher } from '../splitting/page-images.js';
import { CardFlow } from '../workbench/CardFlow.js';
import type { QuestionEditorApi } from '../../docgen/editor/QuestionEditor.js';
import { SourcePane, type FrameActionPayload, type SourceFigureMark, type SourceFrameMark } from '../workbench/SourcePane.js';
import { TreePickerModal, type TreePickerSelection } from '../workbench/TreePickerModal.js';
import { useWorkbench } from '../workbench/use-workbench.js';
import { createAiServices } from '../services/AiServiceFactory.js';
import { createBankExtServices } from '../services/BankExtServiceFactory.js';
import { createBankService } from '../services/BankServiceFactory.js';
import { createRecogService } from '../services/RecogServiceFactory.js';
// 0053 目检返工：切题工作区可见入口退役，createSplitService/putPendingPdf 随页脚删除（split? prop 保留兼容传入方）
// 0057（只增）：资产根只读取（线上插入用显示形态——编辑器按 file:// 载入，相对引用会裂图）
import { getUserDataAssetsRoot } from '../services/paths.js';
import { ProgressNote, type PageMessage } from './ExtUi.js';

const STAGE_OPTIONS = ['小学', '初中', '高中'] as const;

/** 0055（R-044）：无入口交接时的默认归类 = 设置页的默认学段学科（未设置=空） */
function defaultWorkbenchDefaults(): WorkbenchDefaults {
  const stored = readDefaultStageSubject();
  return { stage: stored.stage, subjectId: stored.subjectId, paperTitle: '' };
}

/** 图块拖动中的实时裁图（题卡内联刷新用；不进状态、不落盘） */
export interface LiveFigurePreview {
  cardId: string;
  index: number;
  dataUrl: string;
  width: number;
  height: number;
}

/**
 * 0046 P3：黄条「去处理」的跳转目标（页面持有、props 下传，禁全局事件总线）。
 * action='answer'：展开该卡答案区；action='figure'：左栏定位图块框（index<0 或无对应图块时定位页）。
 * seq 自增：同一目标重复点击也重新触发定位。
 */
export interface WarnJumpTarget {
  cardId: string;
  action: 'answer' | 'figure';
  figureIndex: number;
  pageNo: number;
  seq: number;
}

/** 框选内容复制到内部剪贴板（📋 通路；P3.4 的「复制 → 题干粘贴为图芯片」） */
interface WorkbenchClip {
  dataUrl: string | null;
  width: number;
  height: number;
  label: string;
}

export interface WorkbenchPageProps {
  runId: string;
  recog?: MofangRecogBridge;
  ai?: MofangAiBridge;
  bank?: BankService;
  ext?: BankExtServices;
  split?: MofangSplitBridge;
  /** 测试注入：跳过 File 交接（生产由入口页经 handoff 传递） */
  files?: File[];
  /** 测试注入：跳过默认归类交接（生产由入口页经 handoff 传递） */
  defaults?: WorkbenchDefaults;
}

export function WorkbenchPage(props: WorkbenchPageProps) {
  const { runId } = props;
  const recog = useMemo(() => props.recog ?? createRecogService(), [props.recog]);
  const ai = useMemo(() => props.ai ?? createAiServices(), [props.ai]);
  const bank = useMemo(() => props.bank ?? createBankService(), [props.bank]);
  const ext = useMemo(() => props.ext ?? createBankExtServices(), [props.ext]);

  const files = useMemo(() => props.files ?? takePendingImages(runId), [props.files, runId]);
  // 默认归类来自入口页（首次进入这一 run 时有效；此后以 workbench.json 里的值为准）
  // 0055（R-044）：无入口交接时回落设置页默认学段学科（未设置=空，行为与改造前一致）
  const defaults = useMemo(
    () => props.defaults ?? takePendingDefaults(runId) ?? defaultWorkbenchDefaults(),
    [props.defaults, runId],
  );

  const [message, setMessage] = useState<PageMessage | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [clip, setClip] = useState<WorkbenchClip | null>(null);
  const [lightbox, setLightbox] = useState<WorkbenchFrame | null>(null);
  const [treePickerFor, setTreePickerFor] = useState<string | null>(null);
  // 0046 目检返工④：批量入库去掉二次确认弹窗（用户拍板：点击即入库，与单卡口径一致）
  const [saveAsPaperOpen, setSaveAsPaperOpen] = useState(false);
  const [saveAsPaperFolders, setSaveAsPaperFolders] = useState<PaperFolder[]>([]);
  const [saveAsPaperTitle, setSaveAsPaperTitle] = useState('');
  const [saveAsPaperSource, setSaveAsPaperSource] = useState('');
  const [saveAsPaperBusy, setSaveAsPaperBusy] = useState(false);
  // 0053 目检返工：可选试题篮清单（status='basket' 的试卷）——「入库同时加入试题篮」下拉数据源
  const [basketOptions, setBasketOptions] = useState<Array<{ id: string; title: string }>>([]);
  const [editorEpoch, setEditorEpoch] = useState<Record<string, number>>({});
  /** 0045 P1：题卡题干编辑器的受控插入句柄（「📋 复制 → 粘贴」在光标处插图，不再重挂丢改动） */
  const stemEditors = useRef(new Map<string, QuestionEditorApi>());
  /** 图块拖动中的实时裁图（题卡里那张图跟着走；松手后由提交值接管） */
  const [liveFigure, setLiveFigure] = useState<LiveFigurePreview | null>(null);
  const [subjectEntries, setSubjectEntries] = useState<DictEntry[]>([]);
  const [typeEntries, setTypeEntries] = useState<DictEntry[]>([]);
  const inFlight = useRef<Set<string>>(new Set());
  // ---------- 0046 P1：统一读条（点位 2/3/5/6/7 的数据源） ----------
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null);
  const [aiProgress, setAiProgress] = useState<{ done: number; total: number } | null>(null);
  const [commitProgress, setCommitProgress] = useState<{ done: number; total: number } | null>(null);
  /** 后台转写阶段文案（recog.onEvent 驱动；终态/非本 run → null） */
  const [bgStageLabel, setBgStageLabel] = useState<string | null>(null);
  // ---------- 0046 P3：黄条「去处理」跳转目标 ----------
  const [warnJump, setWarnJump] = useState<WarnJumpTarget | null>(null);
  const warnJumpSeq = useRef(0);
  /** 0046 目检返工②：知识节点建议生成中（cardId；完成/失败即清） */
  const [treeBusyFor, setTreeBusyFor] = useState<string | null>(null);
  // ---------- 0054（R-045①②）：识别产出新卡自动出知识节点建议 ----------
  /** 识别完成标记（recognizeCard / aiOneClick 落卡前置位）——只有识别产出触发，拆题/插入空题不触发 */
  const autoSuggestWanted = useRef(false);
  /** 上一轮卡 id → status 快照（null = 首次装载：草稿恢复不自动发建议，避免一进页面就批量调 AI） */
  const seenCardStatus = useRef<Map<string, string> | null>(null);
  // ---------- 0046 P5.1：本会话识别出的 Onestep 草稿（draftWrite 整批覆盖写回） ----------
  const onestepDraftsRef = useRef<OnestepDraft[]>([]);

  const controller = useWorkbench({
    runId,
    mode: 'auto',
    stage: defaults.stage,
    subjectId: defaults.subjectId,
    ...(defaults.paperTitle ? { paperTitle: defaults.paperTitle } : {}),
    recog,
    ai,
  });
  const { state, update } = controller;

  // 学段/学科/题型字典（默认归类与入库用；空表不造假）
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [subjects, types] = await Promise.all([
          ext.dict.listEntries({ kind: 'subject', activeOnly: true }),
          ext.dict.listEntries({ kind: 'question_type', activeOnly: true }),
        ]);
        if (!alive) return;
        setSubjectEntries(subjects.filter((e) => !e.site));
        setTypeEntries(types.filter((e) => !e.site));
      } catch {
        if (alive) { setSubjectEntries([]); setTypeEntries([]); }
      }
    })();
    return () => { alive = false; };
  }, [ext]);

  // 0053 目检返工：「入库同时加入试题篮」下拉数据源——status='basket' 的试卷（试题篮）；加篮成功后刷新
  const loadBaskets = useCallback(async () => {
    try {
      const rows = await bank.listPapers();
      setBasketOptions(rows
        .filter((r) => r.paper.status === 'basket')
        .map((r) => ({ id: r.paper.id, title: r.paper.title })));
    } catch {
      setBasketOptions([]);
    }
  }, [bank]);

  useEffect(() => { void loadBaskets(); }, [loadBaskets]);

  const subjectLabel = useMemo(
    () => subjectEntries.find((e) => e.id === state?.subjectId)?.label ?? '',
    [subjectEntries, state?.subjectId],
  );
  const typeOptions = useMemo(() => typeOptionsOf(typeEntries), [typeEntries]);
  const typeLabelOf = useCallback(
    (typeCode: string) => typeEntries.find((e) => e.id === typeCode)?.label ?? '',
    [typeEntries],
  );

  const aiReady = controller.aiReady;
  const mode = state?.mode ?? 'auto';

  // 档位回落：没有 vision 档案时自动落到半自动（并保留用户手选能力）
  useEffect(() => {
    if (!state) return;
    if (!aiReady && state.mode === 'auto') update((draft) => ({ ...draft, mode: 'semi' }));
  }, [aiReady, state, update]);

  // ---------- 卡片工具 ----------

  const patchCard = useCallback((cardId: string, patch: Partial<WorkbenchCard>) => {
    update((draft) => ({
      ...draft,
      cards: draft.cards.map((c) => (c.id === cardId ? { ...c, ...patch } : c)),
    }));
  }, [update]);

  const removeCard = useCallback((cardId: string) => {
    update((draft) => ({ ...draft, cards: draft.cards.filter((c) => c.id !== cardId) }));
  }, [update]);

  // 注意：id 必须在 setState 之外算出（recipe 由 React 在提交期才执行，闭包变量拿不到返回值）
  const addPendingCard = useCallback((frames: WorkbenchFrame[], source: WorkbenchCard['source']): string | null => {
    if (!state) return null;
    const { id, nextSeq } = allocateCardId(state);
    update((draft) => ({ ...draft, nextSeq, cards: [...draft.cards, newPendingCard({ id, frames, source })] }));
    return id;
  }, [state, update]);

  // ---------- 识别 ----------

  /**
   * 0046 P5.1（换档落地，D-064）：识别产出的 Onestep 草稿整批写回 run（recog.draft.write）。
   * 写回后 run 状态落 done，#/proof/<runId> 即可读出草稿（0036 呈现层零改动）。
   * 失败静默（草稿回写是伴生能力，不阻塞录题主流程）。
   */
  const writeBackDrafts = useCallback((drafts: OnestepDraft[]) => {
    onestepDraftsRef.current = [...onestepDraftsRef.current, ...drafts];
    void recog.draftWrite({ runId, drafts: onestepDraftsRef.current }).catch(() => undefined);
  }, [recog, runId]);

  /** 0046 P1.5：后台转写事件 → 读条文案（queued/ocr/ai 驱动；终态撤下） */
  useEffect(() => {
    const off = recog.onEvent((payload: RecogEventPayload) => {
      if (payload.runId !== runId) return;
      if (payload.type === 'queued') {
        setBgStageLabel('后台转写排队中…');
        return;
      }
      if (payload.type === 'ocr') {
        setBgStageLabel(`后台转写 第 ${payload.pageIndex ?? 0}/${payload.pageCount ?? 0} 页`);
        return;
      }
      if (payload.type === 'ai') {
        setBgStageLabel('后台转写完成，整理题卡中…');
        return;
      }
      if (payload.type === 'done' || payload.type === 'error' || payload.type === 'cancelled') {
        setBgStageLabel(null);
      }
    });
    return off;
  }, [recog, runId]);

  /**
   * 草稿的图块逐个裁一次：refIndex → {dataUrl, width, height}。
   * 宽高必须与 data URL 一起交给题卡（2026-09-20 目检返工①）——编辑器 FigureNode 会把
   * `data-w/data-h` 写成图片的行内宽高，给 0 就回落到默认 220×120，图被压扁。
   * 0070 乙方案：图块 bbox 已换算回**页坐标**，故逐图按自己那一页取源（跨页卡的图块可能落在不同页）。
   */
  const cropFiguresOf = useCallback((
    figures: OnestepDraft['figures'],
    pageOf: (refIndex: number) => PageImageLike | undefined,
  ): Map<number, { dataUrl: string; width: number; height: number }> => {
    const out = new Map<number, { dataUrl: string; width: number; height: number }>();
    figures.forEach((figure, index) => {
      const page = pageOf(index + 1);
      if (!page) return;
      const rect: WorkbenchRect = {
        x: figure.bbox[0],
        y: figure.bbox[1],
        w: Math.max(0, figure.bbox[2] - figure.bbox[0]),
        h: Math.max(0, figure.bbox[3] - figure.bbox[1]),
      };
      const cropped = cropNormalizedRect(page, rect, { padding: 0.004 });
      if (cropped.ok) out.set(index + 1, { dataUrl: cropped.dataUrl, width: cropped.width, height: cropped.height });
    });
    return out;
  }, []);

  /**
   * 0070 乙方案（2026-09-25 用户授权）：把模型给的图块坐标（归一基准 = **送图**：单帧框裁剪图 /
   * 多帧拼接图）换算成**页坐标**归一——题卡契约里 `WorkbenchFigure.pageNo/bbox` 是页坐标语义
   * （左栏红框按页画、拖动微调从该页重裁）。换算不可用时原样保留并回一条告警（不静默）。
   */
  const mapFiguresToPage = useCallback((
    item: OnestepDraft,
    sentMap: SentMap | null,
  ): { figures: OnestepDraft['figures']; pageNos: Map<number, number>; warnings: string[] } => {
    const pageNos = new Map<number, number>();
    if (!sentMap) {
      return {
        figures: item.figures,
        pageNos,
        warnings: item.figures.length > 0 ? ['图块坐标未能换算回页坐标（送图布局不可用）——已按原坐标保留，请人工确认位置'] : [],
      };
    }
    let unmapped = 0;
    const figures = item.figures.map((figure, index) => {
      const mapped = mapBboxToPage(sentMap, figure.bbox);
      if (!mapped) {
        unmapped += 1;
        return figure;
      }
      pageNos.set(index + 1, mapped.pageNo);
      return { ref: figure.ref, bbox: mapped.bbox };
    });
    return {
      figures,
      pageNos,
      warnings: unmapped > 0 ? [`${unmapped} 个图块坐标未能换算回页坐标——已按原坐标保留，请人工确认位置`] : [],
    };
  }, []);

  /**
   * 0057：裁图集 → 先批量落资产（存储形态 src），再造 draftToCard 需要的**同步**映射。
   * draftToCard 的 figureSrc 是同步回调（`workbench.ts`），故落盘必须前置到 update 之外。
   * 降级（无桥/落盘失败）回落内联 dataUrl 并计数；入库前 normalizeHtmlAssets 会再兜底一次。
   */
  const persistCrops = useCallback(async (
    crops: Map<number, { dataUrl: string; width: number; height: number }>,
  ): Promise<{ srcOf: Map<number, string>; degradedCount: number }> => {
    const { srcOf, degraded } = await persistImageSrcs(
      [...crops.entries()].map(([key, crop]) => ({ key, dataUrl: crop.dataUrl, width: crop.width, height: crop.height })),
    );
    return { srcOf, degradedCount: degraded.length };
  }, []);

  /**
   * 识别单卡：成功 → 逐题落题卡；失败 → 回退待识别 + 红条原因（可重试）。
   * 0070（R-052）：多帧卡走「先拼后识」——逐帧裁剪（各取自己的页）→ 纵向拼成一张 → 单图识别；
   * 单帧卡走原路（行为零变化）。图块回填的裁图源随识别图走（单帧=原页图，多帧=拼接图），
   * 坐标口径与模型所见始终自洽。
   */
  const recognizeCard = useCallback(async (cardId: string) => {
    if (inFlight.current.has(cardId)) return;
    const current = state?.cards.find((c) => c.id === cardId);
    if (!current || current.frames.length === 0) return;
    const frame = current.frames[0]!;
    const multiFrame = current.frames.length > 1;
    const pageImage = controller.pageImages.get(frame.pageNo);
    if (!multiFrame && !pageImage) {
      patchCard(cardId, { status: 'failed', error: '该页图尚未就绪（或本会话没有可裁的原始图片字节）' });
      return;
    }
    inFlight.current.add(cardId);
    patchCard(cardId, { status: 'recognizing', error: null });
    const mode4Recognize = current.source === 'semi' ? 'semi' : mode;
    const context = current.qno !== null ? { pageNo: frame.pageNo, prevQno: current.qno } : { pageNo: frame.pageNo };
    let outcome: RecognizeOutcome;
    /** 图块回填的**退化**裁图源（换算不可用时用）：单帧 = 原页图；多帧 = 拼接图（坐标与送图同源） */
    let figurePage: PageImageLike | undefined = pageImage;
    /** 送图布局（乙方案换算锚；null = 拿不到布局 → 原坐标保留 + 告警） */
    let sentMap: SentMap | null = null;
    if (multiFrame) {
      const stitched = await recognizeStitchedFrames({
        frames: current.frames,
        pageImageOf: (pageNo) => controller.pageImages.get(pageNo),
        stitch: createStitcher(),
        mode: mode4Recognize,
        invoke: (payload) => ai.invoke(payload),
        roles: controller.modelChoice,
        context,
      });
      outcome = stitched.ok
        ? { ok: true, drafts: stitched.drafts, sentWidth: stitched.sentWidth, sentHeight: stitched.sentHeight }
        : { ok: false, error: stitched.error };
      if (stitched.ok) {
        figurePage = stitched.sentImage;
        sentMap = stitched.sentMap;
      }
    } else {
      outcome = await recognizeRegion({
        pageImage: pageImage!,
        pageNo: frame.pageNo,
        rect: frame.rect,
        mode: mode4Recognize,
        invoke: (payload) => ai.invoke(payload),
        roles: controller.modelChoice,
        context,
      });
      // 单帧：送图 = 该帧裁剪图，布局由同一份几何（cropOutputGeometry）推算——与真裁剪同口径，无需再裁一次对账
      sentMap = buildSentMap(current.frames, (pageNo) => {
        const page = controller.pageImages.get(pageNo);
        return page ? { width: page.naturalWidth, height: page.naturalHeight } : undefined;
      });
    }
    inFlight.current.delete(cardId);
    if (!outcome.ok) {
      patchCard(cardId, { status: 'failed', error: outcome.error });
      return;
    }
    writeBackDrafts(outcome.drafts);
    // 0057：先批量落资产（做题卡的同步 figureSrc 映射），再进 update
    // 0070 乙方案：图块坐标先换算回页坐标，再按「图块自己那一页」裁图（跨页卡的图块可能落在不同页）
    const persisted = await Promise.all(outcome.drafts.map(async (item) => {
      const mapped = mapFiguresToPage(item, sentMap);
      const crops = cropFiguresOf(mapped.figures, (refIndex) => {
        const pageNo = mapped.pageNos.get(refIndex);
        if (pageNo !== undefined) return controller.pageImages.get(pageNo);
        return figurePage; // 未换算（布局不可用 / 该框无效）→ 退回送图，坐标与源同源
      });
      return { crops, mapped, ...(await persistCrops(crops)) };
    }));
    const degradedCount = persisted.reduce((sum, p) => sum + p.degradedCount, 0);
    autoSuggestWanted.current = true; // 0054：识别产出的新卡待自动出知识节点建议
    update((draft) => {
      const index = draft.cards.findIndex((c) => c.id === cardId);
      if (index === -1) return draft;
      const source = draft.cards[index]!.source;
      const replacement: WorkbenchCard[] = [];
      let nextSeq = draft.nextSeq;
      outcome.drafts.forEach((draftItem: OnestepDraft, i: number) => {
        const id = i === 0 ? cardId : `c${nextSeq}`;
        if (i > 0) nextSeq += 1;
        const entry = persisted[i]!;
        // 0070 乙方案：图块 bbox 已换算为页坐标（换算失败者保留原坐标，附一条可见告警）
        const mappedItem: OnestepDraft = {
          ...draftItem,
          figures: entry.mapped.figures,
          ...(entry.mapped.warnings.length > 0 ? { warnings: [...draftItem.warnings, ...entry.mapped.warnings] } : {}),
        };
        replacement.push(draftToCard(mappedItem, {
          id,
          source,
          pageNo: frame.pageNo,
          // 0070：框挂到首张产出卡上（其余卡是同一次识别里的兄弟题，画同一批框会在左栏重复叠加）
          ...(i === 0 ? { frames: [...current.frames] } : {}),
          // 0070 乙方案：图块各归自己的页（跨页卡：框 1 的图在页 1、框 2 的图在页 2）
          figurePageNo: (refIndex) => entry.mapped.pageNos.get(refIndex),
          typeCode: mapQuestionTypeToDict(draftItem.questionType, typeEntries),
          figureSrc: (refIndex) => entry.srcOf.get(refIndex),
          figureSize: (refIndex) => {
            const crop = entry.crops.get(refIndex);
            return crop ? { width: crop.width, height: crop.height } : undefined;
          },
          ...(i === 0 ? { qno: draftItem.qno } : {}),
        }));
      });
      const cards = [...draft.cards];
      cards.splice(index, 1, ...replacement);
      return { ...draft, nextSeq, cards };
    });
    setMessage(degradedCount > 0
      ? { type: 'error', text: `识别完成：出 ${outcome.drafts.length} 题；${degradedCount} 张图未落为资产（入库前会再试一次，失败则入库后不可调位）` }
      : { type: 'success', text: `识别完成：出 ${outcome.drafts.length} 题（可逐题修改后入库）` });
  }, [state, controller.pageImages, controller.modelChoice, mode, ai, patchCard, update, typeEntries, writeBackDrafts, cropFiguresOf, persistCrops]);

  const recognizeAllPending = useCallback(async () => {
    const pending = (state?.cards ?? []).filter((c) => c.status === 'pending' || c.status === 'failed');
    if (pending.length === 0) return;
    setMessage({ type: 'success', text: `已发起 ${pending.length} 张待识别卡的识别（谁先出谁先变题卡）` });
    // 0046 P1.2：批量识别聚合读条（完成数递增；后端并发不限，谁先出谁先计）
    setBatchProgress({ done: 0, total: pending.length });
    let done = 0;
    await Promise.all(pending.map(async (c) => {
      await recognizeCard(c.id);
      done += 1;
      setBatchProgress({ done, total: pending.length });
    }));
    setBatchProgress(null);
  }, [state?.cards, recognizeCard]);

  /** ✨ AI 一键录入：逐页整页识别 → 多题落卡（半自动档不显示该按钮） */
  const aiOneClick = useCallback(async () => {
    if (!aiReady) return;
    const pages = state?.pages ?? [];
    if (pages.length === 0) {
      setMessage({ type: 'error', text: '没有可识别的页图' });
      return;
    }
    setMessage({ type: 'success', text: `AI 一键录入：${pages.length} 页整页识别中…` });
    // 0046 P1.3：AI 一键读条「第 i/n 页」
    setAiProgress({ done: 0, total: pages.length });
    let pageDone = 0;
    /** 0057：未落为资产的图张数（逐页累计；>0 时收尾给红条） */
    let degradedTotal = 0;
    for (const page of pages) {
      const pageImage = controller.pageImages.get(page.pageNo);
      if (!pageImage) {
        setMessage({ type: 'error', text: `第 ${page.pageNo} 页图未就绪，无法识别` });
        pageDone += 1;
        setAiProgress({ done: pageDone, total: pages.length });
        continue;
      }
      const outcome = await recognizeRegion({
        pageImage,
        pageNo: page.pageNo,
        rect: FULL_PAGE_RECT,
        mode: mode === 'semi' ? 'semi' : 'auto',
        invoke: (payload) => ai.invoke(payload),
        roles: controller.modelChoice,
      });
      if (!outcome.ok) {
        const created = addPendingCard([makeFrame(`f-${Date.now()}`, { pageNo: page.pageNo, rect: FULL_PAGE_RECT })], 'ai');
        if (created) patchCard(created, { status: 'failed', error: outcome.error });
        pageDone += 1;
        setAiProgress({ done: pageDone, total: pages.length });
        continue;
      }
      writeBackDrafts(outcome.drafts);
      // 0057：同 recognizeCard——先落资产再落卡（题卡内 src = 存储形态）
      // 整页档：送图 = 整页（框 = 整页 → 送图归一 ≡ 页归一），图块按本页裁（乙方案换算在此退化为恒等）
      const persisted = await Promise.all(outcome.drafts.map(async (item) => {
        const crops = cropFiguresOf(item.figures, () => pageImage);
        return { crops, ...(await persistCrops(crops)) };
      }));
      degradedTotal += persisted.reduce((sum, p) => sum + p.degradedCount, 0);
      autoSuggestWanted.current = true; // 0054：识别产出的新卡待自动出知识节点建议
      update((draft) => {
        let nextSeq = draft.nextSeq;
        const cards = [...draft.cards];
        outcome.drafts.forEach((item, i) => {
          const id = `c${nextSeq}`;
          nextSeq += 1;
          const entry = persisted[i]!;
          cards.push(draftToCard(item, {
            id,
            source: 'ai',
            pageNo: page.pageNo,
            typeCode: mapQuestionTypeToDict(item.questionType, typeEntries),
            figureSrc: (refIndex) => entry.srcOf.get(refIndex),
            figureSize: (refIndex) => {
              const crop = entry.crops.get(refIndex);
              return crop ? { width: crop.width, height: crop.height } : undefined;
            },
          }));
        });
        return { ...draft, nextSeq, cards };
      });
      pageDone += 1;
      setAiProgress({ done: pageDone, total: pages.length });
    }
    setAiProgress(null);
    setMessage(degradedTotal > 0
      ? { type: 'error', text: `AI 一键录入完成：${degradedTotal} 张图未落为资产（入库前会再试一次，失败则入库后不可调位）` }
      : { type: 'success', text: 'AI 一键录入完成：结果已进右栏题卡流（逐题确认后入库）' });
  }, [aiReady, state?.pages, controller.pageImages, controller.modelChoice, mode, ai, addPendingCard, patchCard, update, cropFiguresOf, persistCrops, typeEntries, writeBackDrafts]);

  // ---------- 框选动作（P3） ----------

  const onFrameAction = useCallback(async (action: 'toNew' | 'mergeLatest' | 'copy' | 'discard', payload: FrameActionPayload) => {
    const frame = makeFrame(`f-${Date.now()}-${Math.round(payload.rect.x * 10000)}`, {
      pageNo: payload.pageNo,
      rect: payload.rect,
    });
    if (action === 'toNew') {
      addPendingCard([frame], 'manual');
      setMessage({ type: 'success', text: '已加入右侧待识别（点卡上「▶ 识别」，或顶部批量识别）' });
      return;
    }
    if (action === 'mergeLatest') {
      const pending = (state?.cards ?? []).filter((c) => c.status === 'pending' || c.status === 'failed');
      const latest = pending[pending.length - 1];
      if (!latest) {
        setMessage({ type: 'error', text: '没有待识别题：请先用「✓ 加入右侧待识别」' });
        return;
      }
      update((draft) => ({
        ...draft,
        cards: draft.cards.map((c) => (c.id === latest.id ? { ...c, frames: [...c.frames, frame] } : c)),
      }));
      return;
    }
    // 📋 复制：框选内容进剪贴板（选框消失）→ 可在题卡上粘贴为图芯片
    // 0057：clip 保持内存 dataUrl（不进状态不落盘），落资产推迟到粘贴那一刻——
    // 复制十次只粘一次不产孤儿文件；系统剪贴板仍拿 dataUrl（外部应用可用）。
    const pageImage = controller.pageImages.get(payload.pageNo);
    if (!pageImage) {
      setMessage({ type: 'error', text: '该页图尚未就绪，无法复制框选内容' });
      return;
    }
    const cropped = cropNormalizedRect(pageImage, payload.rect, { padding: 0.004 });
    if (!cropped.ok) {
      setMessage({ type: 'error', text: cropped.reason });
      return;
    }
    setClip({ dataUrl: cropped.dataUrl, width: cropped.width, height: cropped.height, label: `框选图 · 第 ${payload.pageNo} 页` });
    void copyToSystemClipboard(cropped.dataUrl).catch(() => undefined);
    setMessage({ type: 'success', text: '已复制框选内容 · 到右侧题卡点「📋 粘贴框选图」即可插入' });
  }, [state?.cards, controller.pageImages, addPendingCard, update]);

  // ---------- 图块微调（P4.2：拖动/缩放 → 拖动中实时重裁 + 松手提交） ----------

  /**
   * 拖动中的实时腿（2026-09-20 目检返工②）：左栏框每动一次就在原图上重裁一次，
   * 结果交给 CardFlow 直接刷题卡里那张图（不动编辑器文档——题卡编辑器是 lazy + 非受控，
   * 每帧重挂会卡且丢光标）。松手时 onFigureChange 才把新内容写进卡状态，成为权威值。
   */
  const onFigureDrag = useCallback((cardId: string, index: number, rect: WorkbenchRect | null) => {
    if (rect === null) {
      setLiveFigure(null);
      return;
    }
    const card = state?.cards.find((c) => c.id === cardId);
    const figure = card?.figures[index];
    if (!figure) return;
    const pageImage = controller.pageImages.get(figure.pageNo);
    if (!pageImage) return;
    const cropped = cropNormalizedRect(pageImage, rect, { padding: 0.004 });
    if (!cropped.ok) return;
    setLiveFigure({
      cardId, index,
      dataUrl: cropped.dataUrl,
      width: cropped.width,
      height: cropped.height,
    });
  }, [state?.cards, controller.pageImages]);

  const onFigureChange = useCallback(async (cardId: string, index: number, rect: WorkbenchRect) => {
    const card = state?.cards.find((c) => c.id === cardId);
    if (!card) return;
    const figure = card.figures[index];
    if (!figure) return;
    const pageImage = controller.pageImages.get(figure.pageNo);
    if (!pageImage) {
      setMessage({ type: 'error', text: '该页图尚未就绪，无法重裁图块' });
      return;
    }
    const cropped = cropNormalizedRect(pageImage, rect, { padding: 0.004 });
    if (!cropped.ok) {
      setMessage({ type: 'error', text: cropped.reason });
      return;
    }
    const nextFigures: WorkbenchFigure[] = card.figures.map((f, i) => (
      i === index ? { ...f, bbox: [rect.x, rect.y, rect.x + rect.w, rect.y + rect.h], adjusted: true } : f
    ));
    // 0057：重裁产物先落资产（题卡 state 存存储形态；编辑器重挂时经 toDisplayHtml 转显示形态）
    const persisted = await persistImageSrc(cropped.dataUrl, { width: cropped.width, height: cropped.height });
    if (!persisted.ok) {
      setMessage({ type: 'error', text: `重裁图未落为资产（${persisted.reason}）——题卡内仍显示，但入库后预览里不可调位` });
    }
    const contentHtml = replaceFigureSrc(card.contentHtml, index, persisted.src, { width: cropped.width, height: cropped.height });
    setLiveFigure(null); // 实时预览退场：权威值来自下面这次提交（编辑器重挂后即为准）
    patchCard(cardId, { figures: nextFigures, contentHtml });
    bumpEpoch(cardId);
  }, [state?.cards, controller.pageImages, patchCard]);

  const bumpEpoch = useCallback((cardId: string) => {
    setEditorEpoch((prev) => ({ ...prev, [cardId]: (prev[cardId] ?? 0) + 1 }));
  }, []);

  /**
   * 📋 粘贴框选图到题干（0045 P1：优先走编辑器受控插入 API 在光标处插图——不重挂、不丢未保存改动；
   * 句柄未就绪（编辑器尚未加载完）回落旧的整卡 HTML 追加 + 重挂路径，行为与 0040 版本一致）。
   * 0057：粘贴是 clip 的落资产时刻——题卡 state 写存储形态，线上插入写显示形态（编辑器按 file:// 载入）。
   */
  const pasteClipToCard = useCallback(async (cardId: string) => {
    if (!clip?.dataUrl) return;
    const card = state?.cards.find((c) => c.id === cardId);
    if (!card) return;
    const persisted = await persistImageSrc(clip.dataUrl, { width: clip.width, height: clip.height });
    if (!persisted.ok) {
      setMessage({ type: 'error', text: `粘贴图未落为资产（${persisted.reason}）——入库前会再试一次，失败则入库后不可调位` });
    }
    const api = stemEditors.current.get(cardId);
    if (api) {
      api.insertFigure({ src: displaySrcOf(persisted.src, getUserDataAssetsRoot()), w: clip.width, h: clip.height });
      setMessage({ type: 'success', text: '已插入框选图到光标处（图随题走；编辑器内容未重载）' });
      return;
    }
    const node = `<figure class="diagram" data-align="center" data-w="${clip.width}" data-h="${clip.height}"><img class="q-figure" src="${persisted.src}"></figure>`;
    const html = card.contentHtml.includes('</div>')
      ? card.contentHtml.replace(/<\/div>\s*$/, `${node}</div>`)
      : `${card.contentHtml}${node}`;
    patchCard(cardId, { contentHtml: html });
    bumpEpoch(cardId);
    setMessage({ type: 'success', text: '已插入框选图（图随题走；编辑器已重载，若刚有未保存的改动请重新编辑）' });
  }, [clip, state?.cards, patchCard, bumpEpoch]);

  /** 0045 P1：题卡题干编辑器句柄登记/注销（CardFlow 经 QuestionEditor ref 上抛） */
  const handleStemEditorReady = useCallback((cardId: string, api: QuestionEditorApi | null) => {
    if (api) stemEditors.current.set(cardId, api);
    else stemEditors.current.delete(cardId);
  }, []);

  // ---------- 卡片结构操作（seam） ----------

  const splitCard = useCallback((cardId: string) => {
    update((draft) => {
      const index = draft.cards.findIndex((c) => c.id === cardId);
      if (index === -1) return draft;
      const card = draft.cards[index]!;
      const second = draftToEmptyCard(`c${draft.nextSeq}`, card);
      const cards = [...draft.cards];
      cards.splice(index + 1, 0, { ...second, checked: card.checked });
      return { ...draft, nextSeq: draft.nextSeq + 1, cards };
    });
    setMessage({ type: 'success', text: '已拆成两题：新题卡为空，请把后半段内容移过去并修正图块' });
  }, [update]);

  const mergeUp = useCallback((cardId: string) => {
    update((draft) => {
      const index = draft.cards.findIndex((c) => c.id === cardId);
      if (index <= 0) return draft;
      const current = draft.cards[index]!;
      const prev = draft.cards[index - 1]!;
      const merged: WorkbenchCard = {
        ...prev,
        contentHtml: `${prev.contentHtml.replace(/<\/div>\s*$/, '')}\n${current.contentHtml}</div>`,
        answerHtml: [prev.answerHtml, current.answerHtml].filter((h) => h.trim() !== '').join('\n'),
        analysisHtml: [prev.analysisHtml, current.analysisHtml].filter((h) => h.trim() !== '').join('\n'),
        figures: [...prev.figures, ...current.figures],
        warnings: [...prev.warnings, ...current.warnings],
        tags: [...new Set([...prev.tags, ...current.tags])],
      };
      const cards = [...draft.cards];
      cards.splice(index - 1, 2, merged);
      return { ...draft, cards };
    });
    bumpEpoch(cardId);
  }, [update, bumpEpoch]);

  const insertAfter = useCallback((cardId: string) => {
    update((draft) => {
      const index = draft.cards.findIndex((c) => c.id === cardId);
      if (index === -1) return draft;
      const blank = newPendingCard({ id: `c${draft.nextSeq}`, frames: [], source: 'manual' });
      const cards = [...draft.cards];
      cards.splice(index + 1, 0, { ...blank, status: 'question', checked: true, contentHtml: '<div class="question"><p></p></div>' });
      return { ...draft, nextSeq: draft.nextSeq + 1, cards };
    });
  }, [update]);

  // ---------- 入库与撤销（P5.4） ----------

  // 0053 目检返工：返回成功入库的题 id（供「入库同时加入试题篮」逐题加篮）；体逻辑零动
  const commitCards = useCallback(async (cardIds: string[]): Promise<string[]> => {
    if (!state) return [];
    const targets = state.cards.filter((c) => cardIds.includes(c.id) && c.status === 'question');
    if (targets.length === 0) return [];
    // 0046 P1.6：批量入库聚合读条（逐题递增）
    setCommitProgress({ done: 0, total: targets.length });
    let committedCount = 0;
    const created: string[] = [];
    const failures: string[] = [];
    /** 0057：入库前兜底仍没落成资产的图（题卡可显示，但库里是内联图 → 显式记账不让它静默） */
    const degradedReasons: string[] = [];
    /** 0054：知识节点逐节点挂接失败（宁多勿漏——单条失败不阻塞其余，收尾汇总明说） */
    const linkFailures: string[] = [];
    for (const card of targets) {
      try {
        const pageNo = card.frames[0]?.pageNo ?? card.figures[0]?.pageNo ?? 1;
        // 0057：入库前兜底把残余内联 data URL（编辑器自带上传/粘贴、落资产降级）就地资产化——
        // 落库 content 里零内联图（禁区 6）；正常路径此处无内联图，零改写。
        const storedContent = await normalizeHtmlAssets(card.contentHtml);
        const storedAnswer = card.answerHtml.trim() !== '' ? await normalizeHtmlAssets(card.answerHtml) : null;
        const storedAnalysis = card.analysisHtml.trim() !== '' ? await normalizeHtmlAssets(card.analysisHtml) : null;
        const assetDebt = [...storedContent.degraded, ...(storedAnswer?.degraded ?? []), ...(storedAnalysis?.degraded ?? [])];
        if (assetDebt.length > 0) degradedReasons.push(`${card.qno ?? card.id}: ${assetDebt.join('；')}`);
        // images 以**题卡 contentHtml 实际出现的资产引用**为准（不依赖题卡 figures 与 content 是否同步）
        const images = questionImagesFromHtml(storedContent.html);
        const question = await bank.createQuestion({
          subject: subjectLabel || '未分类',
          ...(state.subjectId ? { subjectId: state.subjectId } : {}),
          // 0062（R-066/D-076②）：默认归类里的学段落题级列（「学段不限」= 空串，不写）
          ...(state.stage ? { stage: state.stage } : {}),
          sourceType: 'local',
          // 写全 sourceDetail 为后续去重留数据（P5.5：A11 去重缺口不在本单修）
          sourceDetail: {
            origin: 'scan',
            pageNo,
            qno: card.qno ?? '',
            ...(state.paperTitle ? { paperTitle: state.paperTitle } : {}),
          },
          ...(typeLabelOf(card.typeCode) ? { questionType: typeLabelOf(card.typeCode) } : {}),
          ...(card.typeCode ? { typeId: card.typeCode } : {}),
          content: storedContent.html,
          stemHtml: storedContent.html,
          ...(storedAnswer ? { answer: storedAnswer.html } : {}),
          ...(storedAnalysis ? { analysis: storedAnalysis.html } : {}),
          images,
        });
        for (const tag of card.adoptedTags) {
          await bank.addTag(question.id, tag);
        }
        // 0054（R-045③）：知识节点多值逐节点落链（读侧归一：旧草稿单值同样覆盖）；
        // 单条失败只记账不中断（宁多勿漏），收尾汇总提示
        for (const node of adoptedNodesOf(card)) {
          try {
            await ext.tree.linkQuestion(question.id, node.nodeId);
          } catch (err) {
            linkFailures.push(`${card.qno ?? card.id}·${node.label}：${err instanceof Error ? err.message : String(err)}`);
          }
        }
        created.push(question.id);
        // 0057：题卡 state 同步为落库形态（兜底改写过的内容回写卡面，避免「卡上还是内联图、库里已是资产」）
        patchCard(card.id, {
          status: 'committed',
          committedQuestionId: question.id,
          checked: false,
          contentHtml: storedContent.html,
          ...(storedAnswer ? { answerHtml: storedAnswer.html } : {}),
          ...(storedAnalysis ? { analysisHtml: storedAnalysis.html } : {}),
        });
      } catch (err) {
        failures.push(`${card.qno ?? card.id}: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        committedCount += 1;
        setCommitProgress({ done: committedCount, total: targets.length });
      }
    }
    setCommitProgress(null);
    if (created.length > 0) {
      try {
        await recog.attachQuestions({ runId, questionIds: created });
      } catch (err) {
        setMessage({ type: 'error', text: `入库成功但 run 回写失败：${err instanceof Error ? err.message : String(err)}` });
        return created;
      }
    }
    // 0054：知识节点挂接失败汇总（宁多勿漏——已入库成功但个别节点没挂上，必须明说）
    const linkSuffix = linkFailures.length > 0
      ? `；${linkFailures.length} 个知识节点未挂上（${linkFailures.join('；')}）`
      : '';
    if (degradedReasons.length > 0) {
      setMessage({
        type: 'error',
        text: `入库完成：成功 ${created.length} 题，失败 ${failures.length} 题；其中 ${degradedReasons.length} 题的图未落为资产（${degradedReasons.join('；')}）${linkSuffix}`,
      });
      return created;
    }
    setMessage(failures.length > 0 || linkFailures.length > 0
      ? {
        type: 'error',
        text: `入库完成：成功 ${created.length} 题，失败 ${failures.length} 题${failures.length > 0 ? `（${failures.join('；')}）` : ''}${linkSuffix}`,
      }
      : { type: 'success', text: `入库完成：${created.length} 题已进题库（题卡已锁定）` });
    return created;
  }, [state, bank, ext, recog, runId, subjectLabel, typeLabelOf, patchCard]);

  const uncommitCard = useCallback(async (cardId: string) => {
    const card = state?.cards.find((c) => c.id === cardId);
    if (!card?.committedQuestionId) return;
    const questionId = card.committedQuestionId;
    // 0047：存为试卷链的题已挂卷，必须**先摘卷**（失败则中止，不删题不删卷）
    if (card.committedPaperId) {
      try {
        await bank.removeQuestion(card.committedPaperId, questionId);
      } catch (err) {
        setMessage({
          type: 'error',
          text: `撤销入库失败：从试卷摘除失败，题目未删除（${err instanceof Error ? err.message : String(err)}）`,
        });
        return;
      }
    }
    try {
      await bank.deleteQuestion(questionId);
      patchCard(cardId, { status: 'question', committedQuestionId: null, committedPaperId: null, checked: false });
      setMessage({ type: 'success', text: '已撤销入库：题目已从题库移除，题卡解锁可继续编辑' });
    } catch (err) {
      setMessage({ type: 'error', text: `撤销入库失败：${err instanceof Error ? err.message : String(err)}` });
    }
  }, [state?.cards, bank, patchCard]);

  // ---------- 存为试卷（0044 P3：双出口第二出口；主进程一步编排） ----------

  /**
   * 弹层默认值准备（D-060④）：卷名默认=workbench paperTitle → run sourceName →「未命名试卷」；
   * 文件夹清单（树选择器）。打开弹层时尽力取，取不到不阻塞弹层。
   */
  const ensureSaveAsPaperDefaults = useCallback(async () => {
    ext.paper.listFolders().then((folders) => setSaveAsPaperFolders(folders)).catch(() => setSaveAsPaperFolders([]));
    const sourceFromWorkbench = state?.paperTitle ?? '';
    if (sourceFromWorkbench) {
      setSaveAsPaperSource(sourceFromWorkbench);
      setSaveAsPaperTitle(sourceFromWorkbench);
      return;
    }
    // workbench 未带卷名 → 尽力从 run 状态取 sourceName（status 是幂等真相源；取不到静默兜底）
    try {
      const detail = await recog.status({ runId });
      const name = detail.run?.sourceName ?? '';
      setSaveAsPaperSource(name);
      setSaveAsPaperTitle(name || '未命名试卷');
    } catch {
      setSaveAsPaperSource('');
      setSaveAsPaperTitle('未命名试卷');
    }
  }, [state?.paperTitle, recog, runId, ext]);

  const submitSaveAsPaper = useCallback(async (title: string, folderId: string | null) => {
    if (!state) return;
    const targets = state.cards.filter((c) => c.checked && c.status === 'question');
    if (targets.length === 0) return;
    setSaveAsPaperBusy(true);
    try {
      // 0057：与 commitCards 同口径——入库前兜底资产化，payload 带 images（契约 0057 只增字段）。
      // 降级不阻塞建卷（题先保下来），但收尾红条明说（禁静默）。
      const degradedReasons: string[] = [];
      const cards = await Promise.all(targets.map(async (card) => {
        const storedContent = await normalizeHtmlAssets(card.contentHtml);
        const storedAnswer = card.answerHtml.trim() !== '' ? await normalizeHtmlAssets(card.answerHtml) : null;
        const storedAnalysis = card.analysisHtml.trim() !== '' ? await normalizeHtmlAssets(card.analysisHtml) : null;
        const assetDebt = [...storedContent.degraded, ...(storedAnswer?.degraded ?? []), ...(storedAnalysis?.degraded ?? [])];
        if (assetDebt.length > 0) degradedReasons.push(`${card.qno ?? card.id}: ${assetDebt.join('；')}`);
        return {
          qno: card.qno,
          typeCode: card.typeCode,
          contentHtml: storedContent.html,
          answerHtml: storedAnswer ? storedAnswer.html : card.answerHtml,
          analysisHtml: storedAnalysis ? storedAnalysis.html : card.analysisHtml,
          pageNo: card.frames[0]?.pageNo ?? card.figures[0]?.pageNo ?? 1,
          adoptedTags: card.adoptedTags,
          adoptedNode: card.adoptedNode,
          // 0054（R-045③）：多值知识节点随卡下发（读侧归一含旧草稿单值）；adoptedNode 保首节点兼容
          adoptedNodes: adoptedNodesOf(card),
          images: questionImagesFromHtml(storedContent.html),
        };
      }));
      const result = await recog.saveAsPaper({
        runId,
        title,
        subject: subjectLabel || '未分类',
        cards,
        ...(state.subjectId ? { subjectId: state.subjectId } : {}),
        ...(state.paperTitle ? { paperTitle: state.paperTitle } : {}),
        ...(folderId ? { folderId } : {}),
        // 0062（R-066/D-076②）：默认归类里的学段随批次落题级列
        ...(state.stage ? { stage: state.stage } : {}),
      });
      // 保存成功：已存题卡落锁定态（与已入库同态）；留在工作台 + toast（D-061⑩ 不设直达钮）
      // 0047：记回真实题 id + 所属卷 id —— 撤销入库要先按卷摘除再删题，不能丢 id
      for (let i = 0; i < targets.length; i += 1) {
        const card = targets[i]!;
        patchCard(card.id, {
          status: 'committed',
          committedQuestionId: result.questionIds[i]!,
          committedPaperId: result.paperId,
          checked: false,
          warnings: card.warnings,
          contentHtml: cards[i]!.contentHtml,
          answerHtml: cards[i]!.answerHtml,
          analysisHtml: cards[i]!.analysisHtml,
        });
      }
      setSaveAsPaperOpen(false);
      setMessage(degradedReasons.length > 0
        ? { type: 'error', text: `已保存为试卷「${title}」；其中 ${degradedReasons.length} 题的图未落为资产（${degradedReasons.join('；')}）` }
        : { type: 'success', text: `已保存为试卷「${title}」（${result.questionIds.length} 题已入库）——可在「试卷管理」继续排版` });
    } catch (err) {
      // 失败口径（任务书 P3.4）：题保留、卷不建；题卡状态不变可重试
      setMessage({ type: 'error', text: `存为试卷失败：${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setSaveAsPaperBusy(false);
    }
  }, [state, recog, runId, subjectLabel, patchCard]);

  // ---------- 黄条「去处理」（0046 P3：按告警类别定跳转目标；props 下传，禁事件总线） ----------

  const handleWarnFix = useCallback((cardId: string) => {
    const card = state?.cards.find((c) => c.id === cardId);
    if (!card) return;
    // 类别判定与 verifyWarnings 的产出顺序一致：答案空 → 残留[图N] → 图块位>坐标 → 图块未确认
    if (card.answerHtml.trim() === '' && card.analysisHtml.trim() === '') {
      warnJumpSeq.current += 1;
      setWarnJump({ cardId, action: 'answer', figureIndex: -1, pageNo: card.figures[0]?.pageNo ?? card.frames[0]?.pageNo ?? 1, seq: warnJumpSeq.current });
      return;
    }
    // 图块类：优先定位第一个待确认图块；无坐标图块（残留[图N]/位多）时定位其所属页
    const unconfirmed = card.figures.findIndex((f) => !f.adjusted);
    warnJumpSeq.current += 1;
    setWarnJump({
      cardId,
      action: 'figure',
      figureIndex: unconfirmed,
      pageNo: card.figures[unconfirmed]?.pageNo ?? card.figures[0]?.pageNo ?? card.frames[0]?.pageNo ?? 1,
      seq: warnJumpSeq.current,
    });
  }, [state?.cards]);

  // ---------- 知识节点建议（0040 P5.2 挂树建议；0054 扩 auto 档，走 0024 锚点链） ----------

  /**
   * 知识节点建议（0040 P5.2；0054 扩 auto 档）。
   * - 手动档（缺省）：写 treeSuggestions、chips 待用户点选采纳（P-07 人确认），失败/空态如实报红条；
   * - 自动档（识别完成后触发）：建议到达即**默认全采纳**（chip 呈选中态，人可逐个点取消），
   *   失败静默降级为「可手动点」（不阻塞识别主流程、不刷屏）；合并不覆盖期间的人工增项。
   */
  const suggestTreeForCard = useCallback(async (cardId: string, opts?: { auto?: boolean }) => {
    const auto = opts?.auto === true;
    const card = state?.cards.find((c) => c.id === cardId);
    if (!card) return;
    const stemText = plainTextOf(card.contentHtml);
    if (stemText.trim() === '') {
      if (!auto) setMessage({ type: 'error', text: '题干为空，无法出知识节点建议' });
      return;
    }
    // 返工⑥：学科是树侧过滤的必填定格（P-12）——没选学科时明确说清去哪儿选，不把空学科发下去
    const subjectForTree = state!.subjectId || subjectLabel;
    if (subjectForTree.trim() === '') {
      if (!auto) {
        setMessage({
          type: 'error',
          text: '知识节点建议需要学科范围：请先在顶部「默认归类」选学科；也可直接用「+ 手动加节点」手动挂载',
        });
      }
      return;
    }
    // 0046 目检返工②：建议生成是秒级 AI 调用，期间给读条（统一 progress-shell 口径）
    setTreeBusyFor(cardId);
    try {
      const result = await ai.suggest.treeForDraft({
        subjectId: subjectForTree,
        ...(state!.stage ? { stage: state!.stage } : {}),
        stemText,
      });
      if (result.status === 'empty-anchor') {
        if (!auto) setMessage({ type: 'error', text: result.reason ?? '锚点为空：先采集字典/树' });
        return;
      }
      if (result.status === 'unavailable') {
        if (!auto) setMessage({ type: 'error', text: result.reason ?? 'AI 不可用' });
        return;
      }
      const suggestions: WorkbenchTreeSuggestion[] = result.suggestions.map((s) => ({
        nodeId: s.targetId,
        label: s.targetLabel,
        confidence: s.confidence ?? null,
      }));
      if (auto) {
        // 0054：默认选中——建议到达即写 adoptedNodes（并集去重：不吞掉此期间用户手动加的节点）
        const current = adoptedNodesOf(card);
        const merged = [...current];
        for (const s of suggestions) {
          if (!merged.some((n) => n.nodeId === s.nodeId)) merged.push({ nodeId: s.nodeId, label: s.label });
        }
        patchCard(cardId, { treeSuggestions: suggestions, ...adoptedNodesPatch(merged) });
        return;
      }
      patchCard(cardId, { treeSuggestions: suggestions });
      setMessage(suggestions.length > 0
        ? { type: 'success', text: `知识节点建议 ${suggestions.length} 条（点 chip 采纳，不点不入库）` }
        : { type: 'error', text: `模型未给出匹配节点${result.none ? '（明示清单内无匹配）' : ''}` });
    } catch (err) {
      // 自动档静默降级（可手动点兜底）；手动档如实报错
      if (!auto) setMessage({ type: 'error', text: `知识节点建议失败：${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setTreeBusyFor(null);
    }
  }, [state, ai, subjectLabel, patchCard]);

  /**
   * 0054（R-045①②）：识别产出的题卡 → 自动出知识节点建议（逐卡；失败静默降级）。
   *
   * 触发口径 = 识别完成标记 + 卡状态快照差分，而非识别函数内直调（id 由落卡时自增分配，
   * 函数内拿不到权威 id——recipe 在提交期才执行）。差分覆盖两种落卡形态：
   *   · 新增卡（AI 一键录入：多出新的卡 id）；
   *   · 原地换卡（单卡识别：pending/failed 卡同 id 变为 question）。
   * 已是题卡/已入库的卡不触发（撤销入库、拆题、插入空题不打扰）；草稿恢复（首次装载）不触发。
   */
  useEffect(() => {
    if (!state) return;
    const prev = seenCardStatus.current;
    seenCardStatus.current = new Map(state.cards.map((c) => [c.id, c.status]));
    if (prev === null) return;
    if (!autoSuggestWanted.current) return;
    autoSuggestWanted.current = false;
    if (!aiReady) return;
    for (const card of state.cards) {
      if (card.status !== 'question') continue;
      const prevStatus = prev.get(card.id);
      if (prevStatus === 'question' || prevStatus === 'committed') continue;
      void suggestTreeForCard(card.id, { auto: true });
    }
  }, [state, aiReady, suggestTreeForCard]);

  // ---------- 派生视图数据 ----------

  const frameMarks: SourceFrameMark[] = useMemo(() => {
    const out: SourceFrameMark[] = [];
    for (const card of state?.cards ?? []) {
      card.frames.forEach((frame, index) => {
        out.push({
          id: `${card.id}-${index}`,
          pageNo: frame.pageNo,
          rect: frame.rect,
          kind: card.status === 'pending' || card.status === 'recognizing' || card.status === 'failed' ? 'pending' : 'attached',
        });
      });
    }
    return out;
  }, [state?.cards]);

  const figureMarks: SourceFigureMark[] = useMemo(() => {
    const out: SourceFigureMark[] = [];
    for (const card of state?.cards ?? []) {
      if (card.status !== 'question' && card.status !== 'committed') continue;
      card.figures.forEach((figure, index) => {
        out.push({
          cardId: card.id,
          index,
          pageNo: figure.pageNo,
          rect: { x: figure.bbox[0], y: figure.bbox[1], w: figure.bbox[2] - figure.bbox[0], h: figure.bbox[3] - figure.bbox[1] },
          adjusted: figure.adjusted,
          source: card.figureSource,
          locked: card.status === 'committed',
        });
      });
    }
    return out;
  }, [state?.cards]);

  const selectedCount = (state?.cards ?? []).filter((c) => c.checked && c.status === 'question').length;

  // 关窗前落盘
  useEffect(() => {
    const onBeforeUnload = (): void => { void controller.flush().catch(() => undefined); };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [controller]);

  if (controller.loading) {
    return (
      <div className="wb-page" data-testid="wb-loading" style={{ padding: '2rem' }}>
        工作台加载中…
        {controller.pageLoadProgress && (
          <ProgressNote
            label={`页图加载 第 ${controller.pageLoadProgress.done}/${controller.pageLoadProgress.total} 页`}
            testid="wb-page-prog"
          />
        )}
      </div>
    );
  }
  if (controller.loadError) {
    return (
      <div className="wb-page" data-testid="wb-load-error" style={{ padding: '2rem' }}>
        <div className="notice notice-red">工作台打不开：{controller.loadError}</div>
        <a className="btn btn-ghost btn-sm" href="#/intake" style={{ marginTop: 12 }}>← 返回入口页</a>
      </div>
    );
  }
  if (!state) return null;

  return (
    <div className={mode === 'semi' ? 'wb-page semi' : 'wb-page'} data-testid="wb-page" data-mode={mode}>
      {/* 0046 目检返工③ 顶栏两段式：左=导航（返回+卷名）；右=默认归类 + 保存态（弱化）+ 识别模式（原档位 pill 与「识别设置」合并为一个按钮）。
          「✨ AI 一键录入」移到左栏预览工具条（与「✂ 手动框选」同排：手动框选在左、AI 一键在右——功能定位同族）。 */}
      <div className="wb-top">
        <div className="wb-top-left">
          <a className="wb-back" data-testid="wb-back" href="#/intake">← 返回入口</a>
          <h1 className="wb-title" data-testid="wb-title">{state.paperTitle || `识别 run ${runId.slice(0, 8)}`}</h1>
        </div>
        <div className="wb-top-right">
          {/* 默认归类（返工⑥）：识别结果先按此归类，入库时写 subjectId；知识节点建议也用它定格学科 */}
          <span className="wb-classify" data-testid="wb-classify">
            <span className="wb-muted wb-mini">默认归类</span>
            <select
              className="wb-select"
              aria-label="默认学段"
              data-testid="wb-stage-select"
              value={state.stage}
              onChange={(e) => update((draft) => ({ ...draft, stage: e.target.value }))}
            >
              <option value="">学段不限</option>
              {/* 0055（R-044）：设置默认学段可含四值外的学段（如中职）→ 有值即补项，不显示为空档 */}
              {stageOptionsWith(STAGE_OPTIONS, state.stage).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <select
              className="wb-select"
              aria-label="默认学科"
              data-testid="wb-subject-select"
              value={state.subjectId}
              onChange={(e) => update((draft) => ({ ...draft, subjectId: e.target.value }))}
            >
              <option value="">学科未定</option>
              {subjectEntries.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </span>
          <span className="wb-muted wb-mini" data-testid="wb-save-state">
            {controller.saveState === 'saving' ? '草稿保存中…' : controller.saveState === 'error' ? '草稿保存失败' : controller.saveState === 'saved' ? '草稿已保存' : ''}
          </span>
          <button type="button" className="btn btn-ghost btn-sm" data-testid="wb-settings-btn" onClick={() => setSettingsOpen((v) => !v)}>
            识别模式：<span className="wb-mode-pill" data-testid="wb-mode-pill">
              {mode === 'semi' ? '◐ 半自动识别' : '✨ AI 自动识别'}
            </span> ▾
          </button>
        </div>
        {settingsOpen && (
          <div className="wb-set-pop" data-testid="wb-settings-pop">
            <h4>识别方式</h4>
            <label className={mode === 'auto' ? 'on' : ''}>
              <input
                type="radio"
                name="wb-mode"
                data-testid="wb-mode-auto"
                checked={mode === 'auto'}
                disabled={!aiReady}
                onChange={() => update((draft) => ({ ...draft, mode: 'auto' }))}
              />
              <span>
                <b>AI 自动识别</b>{aiReady ? '（需推理模型）' : '（未配置 vision 模型，不可用）'}<br />
                <span className="wb-d">一次产出题干/选项/答案/解析结构 + 图块裁切 + 标签/知识节点建议，入库前逐题确认。</span>
              </span>
            </label>
            <label className={mode === 'semi' ? 'on' : ''}>
              <input
                type="radio"
                name="wb-mode"
                data-testid="wb-mode-semi"
                checked={mode === 'semi'}
                onChange={() => update((draft) => ({ ...draft, mode: 'semi' }))}
              />
              <span>
                <b>半自动识别</b>（OCR + 手动微调）<br />
                <span className="wb-d">只识别文字公式，切分与结构手动调整；无推理模型时的降级档。</span>
              </span>
            </label>
            <div className="wb-set-foot">
              当前使用：<b data-testid="wb-active-model">{controller.modelChoice.label}</b>（一步到位走 reasoning 档，
              插图坐标走 {controller.modelChoice.groundingRole} 档）<br />
              模型档案在「设置 → 模型配置」维护；手动框选录入不受此设置影响，始终可用。
            </div>
          </div>
        )}
      </div>

      {/* 0046 P1：页级统一读条（后台转写 / 批量识别 / AI 一键 / 批量入库 / 页图加载） */}
      {bgStageLabel && <ProgressNote label={bgStageLabel} testid="wb-bg-prog" />}
      {batchProgress && <ProgressNote label={`批量识别 第 ${batchProgress.done}/${batchProgress.total} 题`} testid="wb-batch-prog" />}
      {aiProgress && <ProgressNote label={`AI 一键录入 第 ${aiProgress.done}/${aiProgress.total} 页`} testid="wb-ai-prog" />}
      {commitProgress && <ProgressNote label={`批量入库 第 ${commitProgress.done}/${commitProgress.total} 题`} testid="wb-commit-prog" />}
      {!controller.loading && controller.pageLoadProgress && (
        <ProgressNote
          label={`页图加载 第 ${controller.pageLoadProgress.done}/${controller.pageLoadProgress.total} 页`}
          testid="wb-page-prog"
        />
      )}

      {mode === 'semi' && (
        <div className="wb-semi-banner" data-testid="wb-semi-banner">
          ⚠️ 当前为 <b>半自动识别</b>（OCR + 手动微调）：已用 OCR 识别文字公式，切分与结构请手动调整；
          也可用左侧「✂ 手动框选」指哪打哪。配置推理模型后可在「识别设置」切回 AI 自动。
        </div>
      )}

      <div className="wb-main">
        <SourcePane
          pages={state.pages}
          pageUrls={controller.pageUrls}
          pageImages={controller.pageImages}
          frameMarks={frameMarks}
          figureMarks={figureMarks}
          figureFocus={warnJump?.action === 'figure' ? warnJump : null}
          aiOneClickSlot={aiReady ? { aiReady, aiBusy: !!aiProgress, onClick: () => void aiOneClick() } : undefined}
          onFrameAction={(action, payload) => void onFrameAction(action, payload)}
          onFigureChange={onFigureChange}
          onFigureDrag={onFigureDrag}
        />
        <CardFlow
          cards={state.cards}
          typeOptions={typeOptions}
          aiReady={aiReady}
          liveFigure={liveFigure}
          basketOptions={basketOptions}
          message={message}
          warnJump={warnJump?.action === 'answer' ? warnJump : null}
          onWarnFix={handleWarnFix}
          treeBusyFor={treeBusyFor}
          onOpenSettings={() => setSettingsOpen(true)}
          onStemEditorReady={handleStemEditorReady}
          onToggleChecked={(cardId, checked) => patchCard(cardId, { checked })}
          onToggleAll={(checked) => update((draft) => ({
            ...draft,
            cards: draft.cards.map((c) => (c.status === 'question' ? { ...c, checked } : c)),
          }))}
          onPatchCard={patchCard}
          onRemoveCard={removeCard}
          onRetryCard={(cardId) => void recognizeCard(cardId)}
          onCopyFrame={(cardId) => {
            const card = state.cards.find((c) => c.id === cardId);
            const frame = card?.frames[0];
            if (!frame) return;
            void onFrameAction('copy', { pageNo: frame.pageNo, rect: frame.rect });
          }}
          onOpenFrame={(cardId, frameId) => {
            const card = state.cards.find((c) => c.id === cardId);
            const index = Number(frameId.split('-').pop());
            const frame = card?.frames[index];
            if (frame) setLightbox(frame);
          }}
          onRecognizePending={() => void recognizeAllPending()}
          onRecognizeAll={() => void recognizeAllPending()}
          onSplitCard={splitCard}
          onMergeUp={mergeUp}
          onInsertAfter={insertAfter}
          onCommitCard={(cardId) => void commitCards([cardId])}
          onUncommitCard={(cardId) => void uncommitCard(cardId)}
          onBatchCommit={() => {
            // 0046 目检返工④：点击即入库（去掉二次确认弹窗；进度条已给反馈）
            // 0053 目检返工③补：工具条「入库」恒为纯入库；入库+加篮一步编排走 onAddToBasket 弹窗
            const ids = state.cards.filter((c) => c.checked && c.status === 'question').map((c) => c.id);
            void commitCards(ids);
          }}
          onAddToBasket={async (target) => {
            // 0053 目检返工③补：弹窗「确定」一步完成——先纯入库拿到题 id，再建篮（或选定）逐题加入；
            // 加篮失败不回滚入库（题已进库），红条明说。整体 try/catch 兜底（CardFlow 侧 await 后关弹窗）
            const ids = state.cards.filter((c) => c.checked && c.status === 'question').map((c) => c.id);
            const created = await commitCards(ids);
            if (created.length === 0) return;
            try {
              const paperId = 'paperId' in target
                ? target.paperId
                : (await bank.createPaper(target.newTitle)).id;
              const addFailures: string[] = [];
              for (const qid of created) {
                try {
                  await bank.addQuestion(paperId, qid);
                } catch (err) {
                  addFailures.push(`${err instanceof Error ? err.message : String(err)}`);
                }
              }
              const basketLabel = 'paperId' in target
                ? basketOptions.find((b) => b.id === target.paperId)?.title ?? '选定试题篮'
                : target.newTitle;
              void loadBaskets();
              const failedCommit = ids.length - created.length;
              setMessage(addFailures.length > 0
                ? {
                  type: 'error',
                  text: `已入库 ${created.length} 题；加入试题篮时 ${addFailures.length} 题失败（${addFailures.join('；')}）`,
                }
                : {
                  type: 'success',
                  text: `入库完成：成功 ${created.length} 题${failedCommit > 0 ? `、失败 ${failedCommit} 题` : ''}，已加入试题篮「${basketLabel}」——可在「试卷管理」继续排版`,
                });
            } catch (err) {
              setMessage({
                type: 'error',
                text: `题已入库，但试题篮${'paperId' in target ? '不存在或不可用' : '新建失败'}：${err instanceof Error ? err.message : String(err)}`,
              });
            }
          }}
          onSaveAsPaper={() => { void ensureSaveAsPaperDefaults().then(() => setSaveAsPaperOpen(true)); }}
          onToggleTag={(cardId, tag) => {
            const card = state.cards.find((c) => c.id === cardId);
            if (!card) return;
            const adopted = card.adoptedTags.includes(tag)
              ? card.adoptedTags.filter((t) => t !== tag)
              : [...card.adoptedTags, tag];
            patchCard(cardId, { adoptedTags: adopted });
          }}
          onAddTag={(cardId, tag) => {
            const card = state.cards.find((c) => c.id === cardId);
            if (!card) return;
            patchCard(cardId, {
              tags: card.tags.includes(tag) ? card.tags : [...card.tags, tag],
              adoptedTags: card.adoptedTags.includes(tag) ? card.adoptedTags : [...card.adoptedTags, tag],
            });
          }}
          // 0054（R-045③）：建议 chip 点选=**追加**采纳（同节点去重），不再单值替换
          onAdoptTree={(cardId, suggestion) => {
            const card = state.cards.find((c) => c.id === cardId);
            if (!card) return;
            const current = adoptedNodesOf(card);
            if (current.some((n) => n.nodeId === suggestion.nodeId)) return;
            patchCard(cardId, adoptedNodesPatch([...current, { nodeId: suggestion.nodeId, label: suggestion.label }]));
          }}
          onOpenTreePicker={(cardId) => setTreePickerFor(cardId)}
          onSuggestTree={(cardId) => void suggestTreeForCard(cardId)}
        />
      </div>

      {/* 题卡粘图入口（📋 通路）：有剪贴内容时才出现 */}
      {clip && (
        <div className="wb-clip-bar" data-testid="wb-clip-bar">
          📋 剪贴板：{clip.label}（{clip.width}×{clip.height}）
          {state.cards.filter((c) => c.status === 'question').map((c) => (
            <button key={c.id} type="button" className="btn btn-ghost btn-sm" data-testid={`wb-paste-${c.id}`} onClick={() => { void pasteClipToCard(c.id); }}>
              粘贴到「{c.qno ?? c.id}」
            </button>
          ))}
          <button type="button" className="btn btn-ghost btn-sm" data-testid="wb-clip-clear" onClick={() => setClip(null)}>清空</button>
        </div>
      )}

      {lightbox && (
        <div className="wb-lb-mask" data-testid="wb-lightbox" onClick={() => setLightbox(null)}>
          <div className="wb-lb-box" onClick={(e) => e.stopPropagation()}>
            <div>框选快照 · 第 {lightbox.pageNo} 页（点遮罩关闭）</div>
            {controller.pageUrls.get(lightbox.pageNo) && (
              <img
                src={controller.pageUrls.get(lightbox.pageNo)}
                alt={`第 ${lightbox.pageNo} 页`}
                style={{ width: '100%', marginTop: 8 }}
              />
            )}
          </div>
        </div>
      )}

      {treePickerFor && (
        <TreePickerModal
          ext={ext}
          stage={state.stage}
          subjectId={state.subjectId}
          subjectLabel={subjectLabel}
          onClose={() => setTreePickerFor(null)}
          onConfirm={(selection: TreePickerSelection) => {
            // 0054（R-045③）：手动加节点=追加（同节点去重），已采纳的节点不再重复挂
            const card = state.cards.find((c) => c.id === treePickerFor);
            const current = card ? adoptedNodesOf(card) : [];
            if (!current.some((n) => n.nodeId === selection.nodeId)) {
              patchCard(treePickerFor, adoptedNodesPatch([...current, { nodeId: selection.nodeId, label: selection.label }]));
            }
            setTreePickerFor(null);
          }}
        />
      )}

      {/* 0044（只增）：「存为试卷」弹层（视图二；D-060④/D-061⑨⑩/D-062/D-063） */}
      {saveAsPaperOpen && (
        <SaveAsPaperModal
          count={selectedCount}
          sourceTitle={saveAsPaperSource}
          defaultTitle={saveAsPaperTitle}
          folders={saveAsPaperFolders}
          submitting={saveAsPaperBusy}
          onCreateFolder={async (name, parentId) => {
            const folder = await ext.paper.createFolder({ name, ...(parentId ? { parentId } : {}) });
            setSaveAsPaperFolders(await ext.paper.listFolders().catch(() => []));
            return folder.id;
          }}
          onSubmit={(title, folderId) => { void submitSaveAsPaper(title, folderId); }}
          onClose={() => setSaveAsPaperOpen(false)}
        />
      )}
    </div>
  );
}

/** 空题卡（拆题/插入空题用；带最小合法契约壳，编辑器可直接打开） */
function draftToEmptyCard(id: string, from: WorkbenchCard): WorkbenchCard {
  return {
    ...newPendingCard({ id, frames: [], source: from.source }),
    status: 'question',
    checked: from.checked,
    typeCode: from.typeCode,
    contentHtml: '<div class="question"><p></p></div>',
  };
}

/** 契约 HTML → 纯文本（知识节点建议的题面注入；与 recog/onestep/workbench 的 cardStemText 同口径） */
function plainTextOf(html: string): string {
  return html
    .replace(/<[^>]*\sdata-tex="([^"]*)"[^>]*>/g, (_m, tex: string) => `$${tex}$`)
    .replace(/<figure\b[\s\S]*?<\/figure>/g, ' [图] ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (m) => (
      { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' }[m] ?? m
    ))
    .replace(/\s+/g, ' ')
    .trim();
}

/** 尽力写入系统剪贴板（失败不报错：内部 clip 已可用，用户可在本页完成粘贴） */
async function copyToSystemClipboard(dataUrl: string): Promise<void> {
  const clipboard = globalThis.navigator?.clipboard;
  if (!clipboard?.write || typeof ClipboardItem === 'undefined') return;
  const blob = await (await fetch(dataUrl)).blob();
  await clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

/** 未使用导出占位（保持 type-only import 的显式引用，避免 lint 误报） */
export type { WorkbenchState };
