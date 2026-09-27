// 0004 Phase 2 + fix-1 A/C + Phase 5 + fix-2：排版间页（#/compose/:paperId）。
// 顶部工具条：返回试题篮（composing→basket）/ 归档（→archived）/ 状态徽标 / 定稿 /
// 预览学生·教师版（新窗）/ 导出 PDF。左控件列：版式预设 + 版式参数全套（ComposeLayoutControls）+
// 题序（拖拽）+ 图片 / 分值 / 移除。
// 0018 目检返工一（2026-09-15 用户拍板）：①全高壳层 .compose-page——整页不滚，左栏
// .compose-left-col 栏内滚动、右栏预览列自适应（照 bank-page 全高模式）；
// ②试题顺序行扁平单行（题干 line-clamp 1）。
// 0018 目检返工二（同日第二轮目检拍板）：①行内按钮收敛为「图片 / 分值 / 移除」三个——
// 分值并入按钮（未设置显「设置分值」、已设置显「n分」，只允许非负整数/小数），
// 「图片」打开题级图片设置弹层（列表+插图+保存）；②加题/新建题/从网络题库加题入口退役
// （加题归试题篮：返回试题篮 → 加题 → 再进排版），插入大标题（试卷结构编辑）保留。
// fix-2 F2-B：右栏升级为 iframe（srcdoc）引擎真渲染——buildPaperHtml.browser 全量
// （paper.css+katex.css+layout CSS+config 路径），控件/题序/图覆盖变更 → state → 防抖 300ms 重建；
// 学生版/教师版页内切换；全部版式要素生效（字号/页边距/显隐/作答区/Logo/选项块级分行）。
// fix-2 F2-D：iframe 交互层（图缩放/换位/对齐/Logo 拖拽/标题点编）经 preview-frame-protocol
// postMessage 回传 → 更新版式 state（题级 layout_json / config.logos / 标题）→ 防抖重建。
// Phase 5 定稿序列（config→快照→done）：① setPaperLayoutConfig（控件态序列化落库，version 归一 v2）
//   ② snapshotPaperQuestions（失败中止+报错，不置 done）③ updatePaperStatus('done') → 跳 #/basket。

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  Paper, Question, PaperLayoutConfig, QuestionFigureLayout, QuestionAnswerSpaceOverride,
  OptionsLayoutMode,
} from '../../shared/contracts/bank-types.js';
import { pageDimsMm, resolveLayout } from '../../docgen/render/layout.js';
import {
  useExtPageServices, MessageBanner, Modal, InlineTitleEditor,
  type ExtPageServices, type PageMessage,
} from './ExtUi.js';
import { ComposeLayoutControls } from './ComposeLayoutControls.js';
import { QuestionFigureSettings } from './QuestionFigureSettings.js';
import { PaperPreviewFrame } from './PaperPreviewFrame.js';
import { injectPreviewScript, type PreviewFrameContext } from './preview-frame-script.js';
import {
  figureOrderAfterMove, logoAfterDrag, logoAfterResize, upsertFigureEntry, removeFigureEntry,
  type PreviewFrameMessage,
} from './preview-frame-protocol.js';
import { figuresAfterAnchorMove } from './figure-anchors.js';
import { getUserDataAssetsRoot } from '../services/paths.js';
import { resolveBackHref, hashSearchOf } from '../utils/nav.js';
import {
  loadPaperBundle, previewPaper, exportPaperPdf, pdfOutcomeMessage, exportPaperDocx, docxOutcomeMessage, DOCX_REFLOW_NOTICE,
  renderPaperQuestionHtml,
  questionLayoutsFromItems, textBlocksFromItems, textBlockStatesFromItems,
  scoresFromItems, answerSpacesFromItems, optionsLayoutsFromItems,
  PAPER_STATUS_LABEL, PAPER_STATUS_COLOR, ARCHIVE_CONFIRM_TEXT, type PaperQuestionItem,
} from './paper-actions.js';

/**
 * 0064（R-061）：卷级版式的自动落库防抖窗。取值口径与页内预览重建（300ms）同档：
 * 用户连续调参（滑杆/多次点按）期间不写库，停手 ~0.4s 落一次；定稿仍照旧整量落库（幂等）。
 */
const LAYOUT_PERSIST_DEBOUNCE_MS = 400;

/**
 * fix-3 P0-1：各题外来图集合（覆盖含但 question.images 无引用的 assetId → 交互层「移除」按钮依据）。
 * 覆盖条目里 images 已引用的=题内图（移除=恢复文本流）；images 无引用的=外来图（移除=删条目）。
 */
function foreignAssetsOf(
  items: PaperQuestionItem[]
): Record<string, string[]> {
  const foreign: Record<string, string[]> = {};
  for (const item of items) {
    const known = new Set((item.question.images ?? []).map((img) => img.assetId));
    const ids = (item.ref.layout?.figures ?? []).map((f) => f.assetId).filter((id) => !known.has(id));
    if (ids.length > 0) foreign[item.question.id] = ids;
  }
  return foreign;
}

/**
 * 0004-fix-5 P1-3（用户拍板 C）：题级作答区控件从左栏退役——右栏题级操作条成为唯一入口
 * （点题 → 无答题区时「添加答题区」；有则「− / N 行 / ＋ / 样式 / 删除答题区」）。
 * 状态真源与换算见 paper-actions.answerSpacesFromItems（与引擎同规则）。
 */

/** 0063（R-067/D-077⑤）：读 <html> 三主题计算变量装 PreviewFrameContext.theme。
 *  jsdom/变量缺失时字段为空串 → 注入侧（themeRootCss）逐字段回退暖纸缺省。 */
function previewThemeOf(): NonNullable<PreviewFrameContext['theme']> {
  const cs = getComputedStyle(document.documentElement);
  const read = (name: string) => cs.getPropertyValue(name).trim();
  return {
    accent: read('--orange'),
    accentDeep: read('--orange-deep'),
    accentSoft: read('--orange-soft'),
    card: read('--card'),
    lineStrong: read('--line-strong'),
    ink2: read('--ink-2'),
    ink3: read('--ink-3'),
    brick: read('--brick'),
  };
}

/**
 * 0063（R-067 / D-077②）：工具条菜单（预览▾ / 导出▾ / ⋮）——ComposePage 本地小组件，不进 ExtUi 公共面。
 * 弹层**常挂载仅 hidden**（CtlSection 先例：菜单项 testid 恒在，docx-export-ui 直点零适配）；
 * 点触发钮开合、点外部 / Escape 关闭（open 时才挂监听）。开合状态由父级单值持有（三菜单互斥单开）。
 */
function ToolbarMenu({ id, label, open, onToggle, onClose, children }: {
  id: string;
  label: string;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    // 点外部关闭：触发钮在壳内（ref.contains 命中）时跳过，留给触发钮自身 click 走开合，防「关了又开」
    const onDocPointerDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onDocPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onDocPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose]);
  return (
    <span className="compose-menu" ref={ref}>
      <button
        type="button"
        className="btn"
        data-testid={`compose-menu-${id}-btn`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={onToggle}
      >
        {label}
      </button>
      <span className="compose-menu-pop" data-testid={`compose-menu-${id}-pop`} role="menu" hidden={!open}>
        {children}
      </span>
    </span>
  );
}

export function ComposePage({ paperId, svc: injected }: { paperId: string; svc?: ExtPageServices }) {  const svc = useExtPageServices(injected);
  const [paper, setPaper] = useState<Paper | null>(null);
  const [questions, setQuestions] = useState<PaperQuestionItem[]>([]);
  /** Phase 5：版式控件态（本地 state，不落库——落库在定稿与「存为我的预设」） */
  const [layout, setLayout] = useState<PaperLayoutConfig>({ version: 2 });
  const [snapshotMissing, setSnapshotMissing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  /** 0004-fix-4 2.3：插入/编辑大标题（文本内容块）弹层 */
  const [showTextBlockModal, setShowTextBlockModal] = useState(false);
  const [textBlockDraft, setTextBlockDraft] = useState('');
  /** 编辑目标（null=新增；否则=该文本块行 id） */
  const [textBlockEditing, setTextBlockEditing] = useState<string | null>(null);
  /** 插入位（null=题尾；否则=插到该行前——右栏「插入大标题」操作条用） */
  const [textBlockBeforeId, setTextBlockBeforeId] = useState<string | null>(null);
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  // 0063（R-067/D-077②）：工具条菜单单开互斥（preview/export/more）
  const [openMenu, setOpenMenu] = useState<'preview' | 'export' | 'more' | null>(null);
  const [editingScoreForId, setEditingScoreForId] = useState<string | null>(null);
  const [scoreInput, setScoreInput] = useState('');
  /** 题级图片设置弹层目标（questionId；0018 目检返工二：随行内「图片」按钮回归） */
  const [figureSettingsFor, setFigureSettingsFor] = useState<string | null>(null);
  const [message, setMessage] = useState<PageMessage | null>(null);
  /** fix-2 F2-B：页内预览（iframe 引擎真渲染） */
  const [previewHtml, setPreviewHtml] = useState('');
  const [previewMode, setPreviewMode] = useState<'student' | 'teacher'>('student');
  /** fix-4 2.1：预览视图（paged=分页纸流，缺省；continuous=连续单流） */
  const [previewView, setPreviewView] = useState<'paged' | 'continuous'>('paged');
  // 0063 返工③（2026-09-24 用户目检）：预览选中框/浮动条颜色随主题**实时**更新——
  // --mf-* 值在构建时注入 srcdoc，切主题后旧 iframe 保持旧色。观察 <html data-theme>，
  // 变化 → themeTick 入重建 deps（走既有 300ms 防抖链），新主题变量随下次构建注入。
  const [themeTick, setThemeTick] = useState(0);
  useEffect(() => {
    const observer = new MutationObserver(() => setThemeTick((t) => t + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  /** fix-2 F2-D：iframe 标题点编回传 → 触发对应编辑器（无自定义抬头=卷标题就地编辑；有=抬头文字输入框） */
  const [titleOpenSignal, setTitleOpenSignal] = useState(0);
  const [headerTitleFocusSignal, setHeaderTitleFocusSignal] = useState(0);
  /** 0009：卷头多行自定义模式（lines 已定义）——点编回传分流用（缺省值在归一化层落定） */
  const headerLinesMode = layout.header?.lines !== undefined;
  /** 题级图消息处理用最新 questions（postMessage 回调闭包防陈旧） */
  const questionsRef = useRef<PaperQuestionItem[]>([]);
  questionsRef.current = questions;
  /** fix-5：作答区/分值操作条消息处理用最新 layout（防闭包陈旧） */
  const layoutRef = useRef<PaperLayoutConfig>(layout);
  layoutRef.current = layout;
  /** fix-5 P1-3：重建后恢复的选中题（行数步进/样式切换后操作条不消失） */
  const [selectedQuestionId, setSelectedQuestionId] = useState<string | null>(null);
  /**
   * 0058（R-054）F3：图选中态记忆——**ref 承载**（消息分支写入，注入处读出），刻意不进重建 effect 的 deps：
   * 点图只更新 ref ⇒ 不触发防抖重建（零闪烁、零「点一下重建一次」的回路面）；
   * 重建由既有落库路径自然触发时，注入处读 ref 即完成恢复（缺省 null / 题内无匹配 assetId 静默跳过）。
   */
  const selectedFigureRef = useRef<{ questionId: string; assetId: string } | null>(null);

  /**
   * 0064（R-061）：卷级版式**防抖自动落库**的记账本。
   * hydratedRef：首挂载水合完成前不落库——初始 state 是 `{version:2}` 默认值，若挂载即写会把库上快照覆盖成默认；
   * lastPersistedLayoutRef：上次**已落库/库上已知**的 layout 浅序列化（比对守卫：值不变不写，零冗余 IPC）。
   */
  const hydratedRef = useRef(false);
  const lastPersistedLayoutRef = useRef<string | null>(null);

  /**
   * 0064（R-062）：拖图 resize 落库回环的整预览重建抑制（srcdoc 整替换 = iframe reload 白闪重排）。
   * skipRebuildOnceRef=本次 questions 变化是否为「纯 figure resize 回环」（只由 resize 分支置位一次即消费）；
   * builtInputsRef=**当前已渲染 HTML** 所用的非题输入（layout/预览档/选中题）——跳过只在「这些输入与
   * 已渲染的一致」时成立，否则（同防抖窗内叠加了其他版式变更）照常重建，不误吞。
   */
  const skipRebuildOnceRef = useRef(false);
  const builtInputsRef = useRef<{
    layout: PaperLayoutConfig;
    previewMode: 'student' | 'teacher';
    previewView: 'paged' | 'continuous';
    selectedQuestionId: string | null;
    themeSig: string;
  } | null>(null);

  /**
   * 0052（R-051①）：opts.resetLayout —— 只有**首次挂载**用库上快照初始化控件态。
   * 题行操作（插大标题/删题/设分/图片设置保存）后的重载保留内存态，否则下面 setLayout(DB 旧值)
   * 会把此前的左栏配置整体打回（对照：拖拽排序不调本函数，所以排序不丢配置——反证触发条件）。
   * 0064（R-061）：`layout` 不再是纯内存态——变更经防抖自动落库（见下方落库 effect），
   * 故这条「挂载才读库」的边界同时是**水合基准点**（hydratedRef/lastPersistedLayoutRef 在此记账）。
   */
  const loadPaper = useCallback(async (opts?: { resetLayout?: boolean }) => {
    const bundle = await loadPaperBundle(svc.bank, svc.ext.paper, paperId);
    if (!bundle) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    setPaper(bundle.paper);
    setQuestions(bundle.questions);
    // 控件态初始 = 卷上已存版式（克隆卷带出）；无则全默认（version 2）
    if (opts?.resetLayout) {
      const hydrated: PaperLayoutConfig = bundle.paper.layoutConfig ? { ...bundle.paper.layoutConfig } : { version: 2 };
      setLayout(hydrated);
      // 0064（R-061）：水合完成 + 记下「库上已知值」——防抖落库 effect 以它为基准（比对守卫）
      hydratedRef.current = true;
      lastPersistedLayoutRef.current = JSON.stringify(hydrated);
    }
    setSnapshotMissing(Boolean(bundle.snapshotMissing));
    setLoading(false);
  }, [svc, paperId]);

  useEffect(() => {
    // 首次挂载：控件态从卷上快照初始化（后续重载走 loadPaper() 不重置——见函数注释）
    loadPaper({ resetLayout: true }).catch((err) => {
      setMessage({ type: 'error', text: `加载失败：${err instanceof Error ? err.message : String(err)}` });
      setLoading(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadPaper]);

  // ---------- 状态流（正式状态流替代 fix-2 过渡按钮） ----------

  const backToBasket = async () => {
    try {
      await svc.ext.paper.updatePaperStatus(paperId, 'basket');
      // 0011 §一.7：from 参数优先（白名单校验）；无 from 保留原语义落本卷篮详情
      const fromHref = resolveBackHref(hashSearchOf(window.location.hash), '');
      window.location.hash = fromHref || `#/basket/${paperId}`;
    } catch (err) {
      setMessage({ type: 'error', text: `状态更新失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  /** 目检返工二：done/archived 只读视图内直接「生成副本重新编辑」（与列表卡「重新编辑」同通道） */
  const cloneFromCompose = async () => {
    try {
      const cloned = await svc.ext.paper.clonePaperToBasket(paperId);
      setMessage({ type: 'success', text: `已生成副本「${cloned.title}」并进入编辑` });
      window.location.hash = `#/basket/${cloned.id}`;
    } catch (err) {
      setMessage({ type: 'error', text: `生成副本失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  // fix-1 A：归档（原「放弃」统一动词；确认弹层文案=ARCHIVE_CONFIRM_TEXT）
  const archivePaper = async () => {
    setShowArchiveConfirm(false);
    try {
      await svc.ext.paper.updatePaperStatus(paperId, 'archived');
      window.location.hash = '#/basket';
    } catch (err) {
      setMessage({ type: 'error', text: `归档失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  /**
   * Phase 5 定稿序列（config→快照→done，任务书 §二-4）：
   * ① setPaperLayoutConfig —— 当前控件态序列化落库（fix-2 F2-E：version 统一归一 v2）
   * ② snapshotPaperQuestions —— 失败中止并报错，**绝不置 done**（绝不允许 done 卷无快照）
   * ③ updatePaperStatus('done') → 跳 #/basket
   */
  const finalizePaper = async () => {
    setFinalizing(true);
    setMessage(null);
    try {
      await svc.ext.paper.setPaperLayoutConfig(paperId, { ...layout, version: 2 });
    } catch (err) {
      setFinalizing(false);
      setMessage({
        type: 'error',
        text: `定稿中止：版式保存失败（卷未定稿，仍为排版中）——${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    try {
      await svc.ext.paper.snapshotPaperQuestions(paperId);
    } catch (err) {
      setFinalizing(false);
      setMessage({
        type: 'error',
        text: `定稿中止：快照失败（卷未定稿，仍为排版中）——${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    try {
      await svc.ext.paper.updatePaperStatus(paperId, 'done');
    } catch (err) {
      setFinalizing(false);
      setMessage({ type: 'error', text: `定稿失败：${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    setFinalizing(false);
    window.location.hash = '#/basket';
  };

  const startComposeFromBasket = async () => {
    try {
      await svc.ext.paper.updatePaperStatus(paperId, 'composing');
      await loadPaper();
    } catch (err) {
      setMessage({ type: 'error', text: `状态更新失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  // ---------- 题管理（与篮详情同语义；composing 允许改题，改题后仍可定稿） ----------

  /**
   * 0004-fix-4 2.3：插入/更新大标题（文本内容块，kind='text' 行；不占题号）。
   * 新增=合成 id `text:<uuid>` + addQuestion(..., textBlock)（既有通道 upsert 语义）；
   * beforeQuestionId 指定时插到该行前（追加 + reorderQuestions 复用既有重排通道）。
   */
  const saveTextBlock = async () => {
    const text = textBlockDraft.trim();
    if (!text) {
      setMessage({ type: 'error', text: '大标题内容不能为空' });
      return;
    }
    try {
      const id = textBlockEditing ?? `text:${crypto.randomUUID()}`;
      // fix-6 P1-1：编辑时保留该行现有对齐（弹层不提供对齐控件；对齐入口在右栏文本块操作条）
      const editingRow = textBlockEditing
        ? questionsRef.current.find((item) => item.question.id === textBlockEditing)
        : undefined;
      await svc.bank.addQuestion(paperId, id, undefined, undefined, {
        text,
        style: 'section',
        ...(editingRow?.ref.align ? { align: editingRow.ref.align } : {}),
      });
      if (!textBlockEditing && textBlockBeforeId) {
        const ids = questionsRef.current.map((item) => item.question.id);
        const at = ids.indexOf(textBlockBeforeId);
        const next = at >= 0 ? [...ids.slice(0, at), id, ...ids.slice(at)] : [...ids, id];
        await svc.bank.reorderQuestions(paperId, next);
      }
      setShowTextBlockModal(false);
      setTextBlockEditing(null);
      setTextBlockBeforeId(null);
      setTextBlockDraft('');
      await loadPaper();
      setMessage({ type: 'success', text: '已保存大标题（文本内容块，不占题号）' });
    } catch (err) {
      setMessage({ type: 'error', text: `大标题保存失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  const handleRemoveQuestion = async (questionId: string) => {
    try {
      await svc.bank.removeQuestion(paperId, questionId);
      await loadPaper();
    } catch (err) {
      setMessage({ type: 'error', text: `移除失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  const handleSetScoreSubmit = async (questionId: string) => {
    setEditingScoreForId(null);
    // 0018 目检返工三（用户拍板修订）：空白确认 = 清除分值，回「未设置」（按钮恢复「设置分值」）；
    // 非空白仍须为非负整数或小数
    const raw = scoreInput.trim();
    if (raw !== '' && !/^\d+(\.\d+)?$/.test(raw)) {
      setMessage({ type: 'error', text: '分值需为非负整数或小数' });
      return;
    }
    const score = raw === '' ? undefined : parseFloat(raw);
    try {
      await svc.bank.setQuestionScore(paperId, questionId, score);
      await loadPaper();
    } catch (err) {
      setMessage({ type: 'error', text: `设分失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  // 0063 返工②（2026-09-24 用户目检）：拖拽期**不再实时重排**——旧实现 dragOver 即 splice，
  // 列表边拖边跳 + 原生拖拽幻影叠加 = 视觉上「拖一道带着后面所有题一起动」。改为：拖拽期只记
  // 目标行（over）画插行指示线，dragEnd 一次性提交真实重排（from 摘出 → over 位插入）。
  const [dragState, setDragState] = useState<{ from: number; over: number | null } | null>(null);

  const handleDragStart = (index: number) => setDragState({ from: index, over: null });

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault(); // 允许 drop（否则浏览器显示禁放光标；提交在 dragEnd 统一做）
    setDragState((s) => (s && s.from !== index ? { ...s, over: index } : s));
  };

  const handleDragEnd = async () => {
    if (!dragState) return;
    const { from, over } = dragState;
    setDragState(null);
    if (over === null || over === from) return;
    const next = [...questions];
    const [removed] = next.splice(from, 1);
    next.splice(over, 0, removed);
    setQuestions(next); // 乐观更新 UI（拖拽期列表未动，此时才落新序）
    try {
      await svc.bank.reorderQuestions(paperId, next.map((item) => item.question.id));
    } catch (err) {
      setMessage({ type: 'error', text: `排序保存失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  // ---------- 题级图覆盖（弹层保存 → setQuestionLayouts → 刷新，预览即时反映） ----------
  // 0018 目检返工二：行内「图片」按钮回归，弹层（列表+插图+保存）重新接线

  const figureSettingsItem = questions.find((item) => item.question.id === figureSettingsFor) ?? null;

  const saveFigureLayouts = async (layoutValue: { figures?: QuestionFigureLayout[] }) => {
    const target = figureSettingsItem;
    if (!target) return;
    try {
      await svc.ext.paper.setQuestionLayouts(paperId, target.question.id, layoutValue);
      setFigureSettingsFor(null);
      await loadPaper();
      setMessage({ type: 'success', text: '图片排版已保存（该题覆盖）' });
    } catch (err) {
      setMessage({ type: 'error', text: `图片排版保存失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  // ---------- 预览 / 导出（config 驱动；pageSize 按版式） ----------

  const currentQuestions = (): Question[] => questions.map((item) => item.question);
  const layoutOpts = () => ({
    layoutConfig: layout,
    questionLayouts: questionLayoutsFromItems(questions),
    // 0004-fix-4 2.3：文本内容块（大标题）随题序列传入渲染层（不占题号）
    textBlocks: textBlocksFromItems(questions),
    // 0004-fix-5 P1-1：题分值（题头 (N分) 预览与导出同源）
    scores: scoresFromItems(questions),
  });

  // fix-2 F2-B：页内预览 = 引擎真渲染（防抖 300ms 重建 srcdoc）。
  // 渲染输入 = 控件态 layoutConfig + 题级覆盖（与「预览新窗/导出 PDF」同管线同输入）；
  // 资产根显式传入（srcdoc iframe 无 __mofangPaths）；注入交互层脚本（F2-D）后装载。
  useEffect(() => {
    if (!paper) return;
    // 0063 返工③：主题签名并入「已渲染输入」——skip 守卫（R-062）要求非题输入完全一致才跳过，
    // 主题变了（同题输入）不得误吞，否则切主题后的首次拖图回环会带着旧主题色
    const themeSig = Object.values(previewThemeOf()).join('|');
    const inputs = { layout, previewMode, previewView, selectedQuestionId, themeSig };
    const skipRequested = skipRebuildOnceRef.current;
    skipRebuildOnceRef.current = false;
    // 0064（R-062）：拖图 resize 的落库回环——拖中 iframe 内 DOM 已是终态（块宽已写 pct%，与落库值同源，
    // 0058 §四 A③ Δ≈0.04px 在案）⇒ 重建只会把 srcdoc 整替换一遍（iframe reload 白闪 + 文档重排）。
    // 跳过条件收紧：**已渲染 HTML 的非题输入与本次完全一致**（说明这次 questions 变化就是那条 resize 回环），
    // 否则（同防抖窗内叠加了卷级版式/预览档/主题变更）照常重建——不误吞其他变更。
    const built = builtInputsRef.current;
    if (skipRequested && built && built.layout === inputs.layout && built.previewMode === inputs.previewMode
      && built.previewView === inputs.previewView && built.selectedQuestionId === inputs.selectedQuestionId
      && built.themeSig === inputs.themeSig) {
      return;
    }
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const { buildPaperHtml } = await import('../../docgen/render/buildPaperHtml.browser.js');
          const assetsRoot = getUserDataAssetsRoot();
          const html = await buildPaperHtml(paper, questions.map((item) => item.question), {
            mode: previewMode,
            assetsRoot,
            layoutConfig: layout,
            questionLayouts: questionLayoutsFromItems(questions),
            textBlocks: textBlocksFromItems(questions),
            // fix-5 P1-1：题分值随渲染输入（题头 (N分) 即时生效）
            scores: scoresFromItems(questions),
            // fix-5 P0-2：段边界标记（落点吸附锚；仅交互预览开启，打印/导出路径零标记）
            segmentAnchors: true,
          });
          const dims = pageDimsMm(resolveLayout(layout));
          const resolved = resolveLayout(layout);
          setPreviewHtml(injectPreviewScript(html, {
            assetsRoot,
            pageWmm: dims.w,
            pageHmm: dims.h,
            questionIds: questions.map((item) => item.question.id),
            foreignAssets: foreignAssetsOf(questions),
            columns: resolved.columns,
            columnGapMm: resolved.columnGapMm,
            paginate: previewView === 'paged',
            // fix-5 P1-3：各题作答区现状（操作条三态）+ 恢复选中题
            answerSpaces: answerSpacesFromItems(questions, layout),
            selectedQuestionId,
            // 0058（R-054）F3：图选中态恢复输入（ref 读值，不进 deps → 点图零重建）
            selectedFigure: selectedFigureRef.current,
            // fix-6 P1-1：文本块行现状（右栏操作条文本块分支：编辑/对齐/删除）
            textBlocks: textBlockStatesFromItems(questions),
            // 0013：各题选项版式生效值（操作条「选项版式」按钮当前态与循环依据）
            optionsLayouts: optionsLayoutsFromItems(questions, layout),
            // 0063（R-067/D-077⑤）：三主题取值注入浮动条/选中框（读 <html> 计算变量；
            // jsdom/缺变量字段为空串 → 注入侧逐字段回退暖纸缺省；导出/新窗路径不传）
            theme: previewThemeOf(),
          }));
          // 0064（R-062）：记「当前已渲染 HTML 所用的非题输入」——下一次 skip 判据的基准
          builtInputsRef.current = inputs;
        } catch (err) {
          setMessage({ type: 'error', text: `页内预览构建失败：${err instanceof Error ? err.message : String(err)}` });
        }
      })();
    }, 300);
    return () => window.clearTimeout(timer);
  }, [paper, questions, layout, previewMode, previewView, selectedQuestionId, themeTick]);

  /**
   * 0064（R-061）：卷级版式**防抖自动落库**——左栏控件态不再是纯内存态（用户口径：改了设置
   * 「中途返回试题篮 → 再进排版」必须还在；旧设计只在定稿/存预设时落库，中途离开即丢）。
   * 双守卫：① 水合守卫（hydratedRef：首挂载 loadPaper 回填那次不写，防默认 {version:2} 覆盖库上快照）；
   * ② 比对守卫（浅序列化与 lastPersistedLayoutRef 比对，值不变不写，零冗余 IPC）。
   * done/archived 只读态不写（控件本身 disabled）。
   */
  useEffect(() => {
    if (!paper || !hydratedRef.current) return;
    const status = paper.status ?? 'basket';
    if (status !== 'composing' && status !== 'basket') return;
    const serialized = JSON.stringify(layout);
    if (serialized === lastPersistedLayoutRef.current) return;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          await svc.ext.paper.setPaperLayoutConfig(paperId, { ...layout, version: 2 });
          lastPersistedLayoutRef.current = serialized;
        } catch (err) {
          setMessage({ type: 'error', text: `版式自动保存失败：${err instanceof Error ? err.message : String(err)}` });
        }
      })();
    }, LAYOUT_PERSIST_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [layout, paper, paperId, svc]);

  // fix-2 F2-D + fix-3：iframe 交互层消息 → 版式 state 更新（题级 layout_json / config.logos / 标题编辑器）。
  // persistRefLayout：题级覆盖整体落库（figures 图排版 + answerSpace 题级作答区 + optionsLayout 选项版式，
  // setQuestionLayouts 整体覆盖式语义）；本地即时更新（防抖重建即时反映；不整卷重载），落库异步。
  const persistRefLayout = useCallback(async (
    questionId: string,
    next: { figures?: QuestionFigureLayout[]; answerSpace?: QuestionAnswerSpaceOverride; optionsLayout?: OptionsLayoutMode },
  ) => {
    setQuestions((prev) => prev.map((item) => (
      item.question.id === questionId ? { ...item, ref: { ...item.ref, layout: next } } : item
    )));
    try {
      await svc.ext.paper.setQuestionLayouts(paperId, questionId, next);
    } catch (err) {
      setMessage({ type: 'error', text: `题级排版保存失败：${err instanceof Error ? err.message : String(err)}` });
    }
  }, [svc, paperId]);

  /** 题级图覆盖更新（现覆盖的 answerSpace/optionsLayout 字段随行保留） */
  const persistQuestionLayout = useCallback(async (questionId: string, figures: QuestionFigureLayout[]) => {
    const target = questionsRef.current.find((item) => item.question.id === questionId);
    await persistRefLayout(questionId, {
      figures,
      answerSpace: target?.ref.layout?.answerSpace,
      optionsLayout: target?.ref.layout?.optionsLayout,
    });
  }, [persistRefLayout]);

  /**
   * fix-6 P1-1：文本块行更新（正文/样式保留，patch 落库）。
   * 本地即时更新（防抖重建即时反映），落库走 addQuestion upsert（不新增通道）。
   */
  const persistTextBlock = useCallback(async (
    questionId: string,
    patch: { align?: 'left' | 'center' | 'right' },
  ) => {
    const target = questionsRef.current.find((item) => item.question.id === questionId);
    if (!target) return;
    const next = {
      text: target.ref.textBody ?? '',
      style: target.ref.style ?? ('section' as const),
      ...patch,
    };
    setQuestions((prev) => prev.map((item) => (
      item.question.id === questionId ? { ...item, ref: { ...item.ref, ...patch } } : item
    )));
    try {
      await svc.bank.addQuestion(paperId, questionId, undefined, undefined, next);
    } catch (err) {
      setMessage({ type: 'error', text: `大标题保存失败：${err instanceof Error ? err.message : String(err)}` });
    }
  }, [svc, paperId]);

  const handleFrameMessage = useCallback((msg: PreviewFrameMessage) => {
    if (msg.t === 'mf-title-click') {
      // 0009：多行自定义模式（lines 已定义）→ 左栏行编辑器首行；否则沿旧三态（自定义标题输入框 / 卷标题就地编辑）
      if (headerLinesMode || layout.header?.title) setHeaderTitleFocusSignal((s) => s + 1);
      else setTitleOpenSignal((s) => s + 1);
      return;
    }
    if (msg.t === 'mf-logo-drag' || msg.t === 'mf-logo-resize') {
      setLayout((prev) => {
        const logos = [...(prev.logos ?? [])];
        if (msg.index < 0 || msg.index >= logos.length) return prev;
        logos[msg.index] = msg.t === 'mf-logo-drag'
          ? logoAfterDrag(logos[msg.index], msg.xRatio, msg.yRatio)
          : logoAfterResize(logos[msg.index], msg.widthRatio);
        return { ...prev, logos };
      });
      return;
    }
    if (msg.t === 'mf-preview-ready' || msg.t === 'mf-height') return;
    // 0058（R-054）F3：图选中态记忆（只写 ref，不 setState —— 不触发重建，防「点图 → 重建 → 恢复」自激回路）。
    // 必须早退：本分支之后是题级图消息的公共 target 查找（按字符串 questionId），半 null 形态会落到换位分支。
    if (msg.t === 'mf-figure-select') {
      selectedFigureRef.current = msg.questionId && msg.assetId
        ? { questionId: msg.questionId, assetId: msg.assetId }
        : null;
      return;
    }
    // fix-4 2.5 + fix-5 P1-3：右栏题级操作条 → 答题区三态（添加 / 行数 / 样式 / 删除）
    if (msg.t === 'mf-question-answer-space') {
      setSelectedQuestionId(msg.questionId);
      const action = msg.action ?? 'add';
      if (action === 'remove') {
        void setQuestionAnswerSpace(msg.questionId, { style: 'none' });
        return;
      }
      const state = answerSpacesFromItems(questionsRef.current, layoutRef.current)[msg.questionId];
      if (action === 'style') {
        void setQuestionAnswerSpace(msg.questionId, { style: msg.style ?? 'lines', lines: state?.lines ?? 3 });
        return;
      }
      const lines = Math.max(1, Math.round(msg.lines ?? (action === 'add' ? 3 : (state?.lines ?? 3))));
      void setQuestionAnswerSpace(msg.questionId, { style: state?.style ?? 'blank', lines });
      return;
    }
    // fix-5 P1-1：右栏操作条「分值」→ 左栏题卡分值行内输入（同一处编辑，避免双入口）
    if (msg.t === 'mf-question-score') {
      setSelectedQuestionId(msg.questionId);
      const target = questionsRef.current.find((item) => item.question.id === msg.questionId);
      setScoreInput(target?.ref.score?.toString() ?? '');
      setEditingScoreForId(msg.questionId);
      return;
    }
    if (msg.t === 'mf-question-insert-text') {
      setTextBlockEditing(null);
      setTextBlockBeforeId(msg.questionId);
      setTextBlockDraft('');
      setShowTextBlockModal(true);
      return;
    }
    // 0013：右栏操作条「选项版式」循环切换 → layout_json.optionsLayout 题级显式覆盖
    // （'auto' = 有意覆盖卷级档回自动；figures/answerSpace 随行保留）
    if (msg.t === 'mf-question-options-layout') {
      setSelectedQuestionId(msg.questionId);
      const target = questionsRef.current.find((item) => item.question.id === msg.questionId);
      if (!target) return;
      void persistRefLayout(msg.questionId, {
        figures: target.ref.layout?.figures,
        answerSpace: target.ref.layout?.answerSpace,
        optionsLayout: msg.mode,
      });
      return;
    }
    // fix-6 P1-1：右栏文本块操作条（编辑/对齐/删除）
    if (msg.t === 'mf-text-align') {
      setSelectedQuestionId(msg.questionId);
      void persistTextBlock(msg.questionId, { align: msg.align });
      return;
    }
    if (msg.t === 'mf-text-edit') {
      const target = questionsRef.current.find((item) => item.question.id === msg.questionId);
      if (!target) return;
      setTextBlockEditing(msg.questionId);
      setTextBlockBeforeId(null);
      setTextBlockDraft(target.ref.textBody ?? '');
      setShowTextBlockModal(true);
      return;
    }
    if (msg.t === 'mf-text-remove') {
      setSelectedQuestionId(null);
      void handleRemoveQuestion(msg.questionId);
      return;
    }
    // 题级图消息（缩放/对齐/版式/换位/移除）。
    // fix-3 P0-1：domOrder 基准放宽 = figure 语义图 ∪ 已覆盖条目（覆盖提升图/外来图可换位）
    const target = questionsRef.current.find((item) => item.question.id === msg.questionId);
    if (!target) return;
    const semanticAssets = (target.question.images ?? [])
      .filter((img) => img.type === 'figure')
      .map((img) => img.assetId);
    const coveredAssets = (target.ref.layout?.figures ?? []).map((f) => f.assetId);
    const domOrderAssets = [...semanticAssets, ...coveredAssets.filter((id) => !semanticAssets.includes(id))];
    const current = target.ref.layout?.figures;
    let figures: QuestionFigureLayout[];
    if (msg.t === 'mf-figure-resize') {
      // 0064（R-062）：拖中 DOM 已是终态（块宽已写 pct%）——置「跳过本次重建」标志，
      // 由重建 effect 在「非题输入未变」时消费（详见该 effect 注释）。落库照常。
      skipRebuildOnceRef.current = true;
      figures = upsertFigureEntry(current, msg.assetId, { widthPercent: Math.min(100, Math.max(5, Number(msg.widthPercent.toFixed(2)))) });
    } else if (msg.t === 'mf-figure-align') {
      figures = upsertFigureEntry(current, msg.assetId, { align: msg.align });
    } else if (msg.t === 'mf-figure-mode') {
      figures = upsertFigureEntry(current, msg.assetId, { mode: msg.mode });
    } else if (msg.t === 'mf-figure-remove') {
      figures = removeFigureEntry(current, msg.assetId);
    } else if (typeof msg.anchorIndex === 'number') {
      // fix-5 P0-2：段边界落点 → 引擎同源换算（物化锚点：全量条目写 anchorIndex + orderIndex=视觉序）
      figures = figuresAfterAnchorMove(target.question.content, target.question.images ?? [], current, msg.assetId, msg.anchorIndex);
    } else {
      figures = figureOrderAfterMove(domOrderAssets, current, msg.assetId, msg.beforeAssetId);
    }
    void persistQuestionLayout(target.question.id, figures);
  }, [headerLinesMode, layout.header?.title, persistQuestionLayout, persistRefLayout]);

  // ---------- fix-3 P1-2：题级作答区（每题独立设置；undefined=跟随卷级） ----------

  const setQuestionAnswerSpace = async (
    questionId: string,
    answerSpace: QuestionAnswerSpaceOverride | undefined,
  ) => {
    const target = questionsRef.current.find((item) => item.question.id === questionId);
    if (!target) return;
    const next: { figures?: QuestionFigureLayout[]; answerSpace?: QuestionAnswerSpaceOverride; optionsLayout?: OptionsLayoutMode } = {
      figures: target.ref.layout?.figures,
      optionsLayout: target.ref.layout?.optionsLayout,
    };
    if (answerSpace) next.answerSpace = answerSpace;
    await persistRefLayout(questionId, next);
  };

  // ---------- fix-3 P2-1：插图 ----------
  // 0018 目检返工一：「插图」按钮随题行扁平化退役（insertFigure 入口移除）；
  // 预览中对已有图的拖拽/缩放/移除交互不受影响。

  const handlePreview = async (mode: 'student' | 'teacher') => {
    if (!paper) return;
    try {
      await previewPaper(paper, currentQuestions(), mode, layoutOpts());
    } catch (err) {
      setMessage({ type: 'error', text: `预览失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  const handleExport = async (mode: 'student' | 'teacher') => {
    if (!paper) return;
    try {
      const outcome = await exportPaperPdf(paper, currentQuestions(), mode, layoutOpts());
      setMessage(pdfOutcomeMessage(outcome, paper.title, mode, layout.pageSize ?? 'A4'));
    } catch (err) {
      setMessage({ type: 'error', text: `导出失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  // 0035 P4：Word(DOCX) 导出——同源版式输入，主进程结构化组装（公式=图片，D-051）
  const handleExportDocx = async (mode: 'student' | 'teacher') => {
    if (!paper) return;
    try {
      const outcome = await exportPaperDocx(paper, currentQuestions(), mode, layoutOpts());
      setMessage(docxOutcomeMessage(outcome, paper.title, mode));
    } catch (err) {
      setMessage({ type: 'error', text: `Word 导出失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  // ---------- 标题就地编辑（fix-1 #1 转入） ----------

  const saveTitle = async (next: string) => {
    const updated = await svc.ext.paper.updatePaperTitle(paperId, next);
    setPaper((prev) => (prev ? { ...prev, title: updated.title } : prev));
    setMessage({ type: 'success', text: '已重命名' });
  };

  if (loading) return <div>加载中…</div>;
  if (notFound || !paper) {
    return (
      <div>
        <div style={{ marginBottom: 6 }}>
          <a className="page-back" href="#/basket">← 返回试卷列表</a>
        </div>
        <h1 className="section-title">排版间</h1>
        <MessageBanner message={{ type: 'error', text: '试卷不存在' }} />
      </div>
    );
  }

  const status = paper.status ?? 'basket';
  const editable = status === 'composing' || status === 'basket';

  // 页内预览纸张宽（mm；取向换算后，供 iframe 缩放基准）
  const previewPageWidthMm = pageDimsMm(resolveLayout(layout)).w;

  return (
    /* 0018 目检返工一：全高壳层——整页不滚（高=视口−.main 上下 padding 62px，同 bank-page 模式），
       顶栏/横幅 flex:0 0 auto，.compose-layout 占满余量，左右栏各自内滚 */
    <div className="compose-page">
      {/* 0011 目检返工三：组卷各页返回统一——左上角「← 返回试卷列表」（同篮详情 page-back 形态，纯导航不改状态） */}
      <div style={{ marginBottom: 6 }}>
        <a
          className="page-back"
          href="#/basket"
          onClick={(e) => {
            // from 优先（工具函数白名单校验）；无 from 保持 href 默认落组卷列表
            const fromHref = resolveBackHref(hashSearchOf(window.location.hash), '');
            if (fromHref) {
              e.preventDefault();
              window.location.hash = fromHref;
            }
          }}
        >
          ← 返回试卷列表
        </a>
      </div>
      {/* 0063（R-067/D-077）：顶栏工具条卡片化 + 五操作位（低频收菜单；h1 内联样式一字不动=
         basket-pages 0011 测试锚点；actions 内联 flex 0 0 auto 同为锚点锁；卡片观感在 theme.css .compose-toolbar） */}
      <div data-testid="compose-toolbar" className="compose-toolbar">
        <h1
          data-testid="compose-toolbar-title"
          style={{
            margin: 0, fontSize: '1.3rem', display: 'flex', alignItems: 'center', gap: '0.6rem',
            flex: '1 1 auto', minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap',
          }}
        >
          排版 ·{' '}
          {/* 标题承载 span：单行省略裁切（长卷名不挤压按钮组） */}
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {editable ? (
              <InlineTitleEditor
                testid="compose-title"
                title={paper.title}
                onSave={saveTitle}
                onEmpty={() => setMessage({ type: 'error', text: '标题不能为空' })}
                openSignal={titleOpenSignal}
              />
            ) : (
              <span data-testid="compose-title">{paper.title}</span>
            )}
          </span>
          <span
            data-testid="paper-status-badge"
            data-status={status}
            style={{
              fontSize: '0.8rem', fontWeight: 'normal', padding: '0.15rem 0.6rem', flex: '0 0 auto',
              borderRadius: '999px', color: 'white', backgroundColor: PAPER_STATUS_COLOR[status],
            }}
          >
            {PAPER_STATUS_LABEL[status]}
          </span>
        </h1>
        <div data-testid="compose-toolbar-actions" style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          {status === 'basket' && (
            <button className="btn btn-primary" data-testid="compose-start-btn" onClick={() => void startComposeFromBasket()}>进入排版</button>
          )}
          {status === 'composing' && (
            <>
              <button className="btn" data-testid="compose-back-basket-btn" onClick={() => void backToBasket()}>返回试题篮</button>
              <button
                className="btn btn-green"
                data-testid="compose-finalize-btn"
                onClick={() => void finalizePaper()}
                disabled={finalizing}
              >
                {finalizing ? '定稿中…' : '定稿'}
              </button>
            </>
          )}
          {(status === 'done' || status === 'archived') && (
            <button className="btn" data-testid="compose-clone-btn" onClick={() => void cloneFromCompose()}>生成副本重新编辑</button>
          )}
          {/* 0063：预览▾ / 导出▾ 菜单化（全状态恒在；弹层常挂载仅 hidden）——菜单项=原按钮搬家，onClick 与 testid 零改 */}
          <ToolbarMenu
            id="preview"
            label="预览 ▾"
            open={openMenu === 'preview'}
            onToggle={() => setOpenMenu(openMenu === 'preview' ? null : 'preview')}
            onClose={() => setOpenMenu(null)}
          >
            <button type="button" className="compose-menu-item" role="menuitem" data-testid="compose-preview-student-btn" onClick={() => { setOpenMenu(null); void handlePreview('student'); }}>预览学生版</button>
            <button type="button" className="compose-menu-item" role="menuitem" data-testid="compose-preview-teacher-btn" onClick={() => { setOpenMenu(null); void handlePreview('teacher'); }}>预览教师版</button>
          </ToolbarMenu>
          <ToolbarMenu
            id="export"
            label="导出 ▾"
            open={openMenu === 'export'}
            onToggle={() => setOpenMenu(openMenu === 'export' ? null : 'export')}
            onClose={() => setOpenMenu(null)}
          >
            <button type="button" className="compose-menu-item" role="menuitem" data-testid="compose-export-student-btn" onClick={() => { setOpenMenu(null); void handleExport('student'); }}>导出学生版 PDF</button>
            <button type="button" className="compose-menu-item" role="menuitem" data-testid="compose-export-teacher-btn" onClick={() => { setOpenMenu(null); void handleExport('teacher'); }}>导出教师版 PDF</button>
            <span className="compose-menu-msep" role="separator" aria-hidden="true" />
            <button type="button" className="compose-menu-item" role="menuitem" data-testid="compose-export-docx-student-btn" title={DOCX_REFLOW_NOTICE} onClick={() => { setOpenMenu(null); void handleExportDocx('student'); }}>导出学生版 Word<span className="compose-menu-item-warn" aria-hidden="true">！</span></button>
            <button type="button" className="compose-menu-item" role="menuitem" data-testid="compose-export-docx-teacher-btn" title={DOCX_REFLOW_NOTICE} onClick={() => { setOpenMenu(null); void handleExportDocx('teacher'); }}>导出教师版 Word<span className="compose-menu-item-warn" aria-hidden="true">！</span></button>
          </ToolbarMenu>
          {status === 'composing' && (
            <>
              {/* 0063（D-077②）：主行与低频/危险位之间的分隔竖线 */}
              <span className="compose-toolbar-sep" aria-hidden="true" />
              <ToolbarMenu
                id="more"
                label="⋮"
                open={openMenu === 'more'}
                onToggle={() => setOpenMenu(openMenu === 'more' ? null : 'more')}
                onClose={() => setOpenMenu(null)}
              >
                <button type="button" className="compose-menu-item compose-menu-item-danger" role="menuitem" data-testid="compose-archive-btn" onClick={() => { setOpenMenu(null); setShowArchiveConfirm(true); }}>归档…</button>
              </ToolbarMenu>
            </>
          )}
        </div>
      </div>

      <MessageBanner message={message} />

      {/* 0063 返工⑤（2026-09-24 用户目检拍板）：常驻说明行退役——「Word 为重排版式」提示
         移到导出菜单两个 Word 项的感叹号 hover（title）上（DOCX_REFLOW_NOTICE 文案零改） */}

      {/* 快照回落提示（done/archived 旧数据无快照，预览/导出已用当前题库内容） */}
      {snapshotMissing && (
        <MessageBanner message={{ type: 'error', text: '该卷无快照，已用当前题库内容' }} />
      )}

      <div className="compose-layout">
        {/* 左控件列：版式预设/参数全套（Phase 5）+ 题序（拖拽）+ 分值 + 移除 + 加题/新建题。
            0018 目检返工一：.compose-left-col 栏内滚动（适配窗口高度），不随整页滚 */}
        <div className="compose-left-col" style={{ minWidth: 0 }}>
          <ComposeLayoutControls
            svc={svc}
            layout={layout}
            onChange={setLayout}
            disabled={!editable}
            onNotify={setMessage}
            paperTitle={paper.title}
            headerTitleFocusSignal={headerTitleFocusSignal}
          />

          <h2 className="section-title" style={{ fontSize: '1.05rem', margin: '1rem 0 0.5rem' }}>试题顺序（拖拽排序）</h2>
          {/* 0018 目检返工二：加题/新建题/从网络题库加题入口退役（加题归试题篮——返回试题篮 → 加题 → 再进排版）；
              插入大标题属试卷结构编辑，保留在排版间 */}
          <div style={{ marginBottom: '0.75rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {editable && (
              <button
                className="btn"
                style={{ whiteSpace: 'nowrap' }}
                data-testid="compose-insert-text-block-btn"
                onClick={() => {
                  setTextBlockEditing(null);
                  setTextBlockBeforeId(null);
                  setTextBlockDraft('');
                  setShowTextBlockModal(true);
                }}
                title="插入大标题（文本内容块，如「一、单项选择题」；不占题号，可拖拽排序）"
              >
                插入大标题
              </button>
            )}
          </div>

          {questions.length === 0 ? (
            <p data-testid="compose-empty">暂无题目——点「返回试题篮」加题后，再进入排版</p>
          ) : (
            <ol
              data-testid="compose-question-list"
              style={{ padding: 0, margin: 0, listStyle: 'none' }}
            >
              {questions.map((item, index) => (
                <li
                  key={item.question.id}
                  draggable={editable}
                  onDragStart={() => handleDragStart(index)}
                  onDragOver={(e) => handleDragOver(e, index)}
                  onDragEnd={() => void handleDragEnd()}
                  className={
                    dragState?.from === index ? 'order-item dragging'
                    : dragState?.over === index ? 'order-item drop-target'
                    : 'order-item'
                  }
                  style={{ cursor: editable ? 'move' : 'default' }}
                >
                  {item.ref.kind === 'text' ? (
                    /* 0004-fix-4 2.3：文本内容块行（大标题）——无题号/分值/图片/作答区控件 */
                    <div data-testid={`text-block-row-${item.question.id}`}>
                      <strong>大标题：</strong>
                      <span data-testid={`text-block-text-${item.question.id}`}>{item.ref.textBody}</span>
                      {editable && (
                        <>
                          <button
                            data-testid={`text-block-edit-${item.question.id}`}
                            onClick={() => {
                              setTextBlockEditing(item.question.id);
                              setTextBlockBeforeId(null);
                              setTextBlockDraft(item.ref.textBody ?? '');
                              setShowTextBlockModal(true);
                            }}
                            className="btn btn-sm"
                            style={{ marginLeft: '0.5rem' }}
                          >
                            编辑
                          </button>
                          <button
                            data-testid={`text-block-remove-${item.question.id}`}
                            onClick={() => void handleRemoveQuestion(item.question.id)}
                            className="btn btn-sm"
                            style={{ marginLeft: '0.5rem', color: 'var(--brick)' }}
                          >
                            移除
                          </button>
                        </>
                      )}
                    </div>
                  ) : (
                    <>
                  {/* 0018 目检返工二：扁平行终版——题号+题干（单行截断）左对齐占满，行内三按钮：
                      图片（开图片设置弹层：列表+插图）/ 分值（未设置显「设置分值」、已设置显「n分」）/ 移除 */}
                  <div
                    className="compose-order-row"
                    style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', minWidth: 0, overflow: 'hidden' }}
                  >
                    <strong style={{ flex: '0 0 auto' }}>
                      {questions.slice(0, index).filter((x) => x.ref.kind !== 'text').length + 1}.
                    </strong>
                    <span
                      data-testid={`compose-stem-${item.question.id}`}
                      style={{ display: '-webkit-box', WebkitLineClamp: 1, WebkitBoxOrient: 'vertical', overflow: 'hidden', color: 'var(--ink)', lineHeight: 1.45, flex: 1, minWidth: 0 }}
                      dangerouslySetInnerHTML={{ __html: renderPaperQuestionHtml(item.question.content) }}
                    />
                    {editable && (
                      <button
                        data-testid={`figure-settings-btn-${item.question.id}`}
                        onClick={() => setFigureSettingsFor(item.question.id)}
                        className="btn btn-sm"
                        style={{ flex: '0 0 auto', whiteSpace: 'nowrap' }}
                      >
                        图片
                      </button>
                    )}
                    {editable && editingScoreForId === item.question.id ? (
                      <input
                        type="number"
                        data-testid={`score-input-${item.question.id}`}
                        value={scoreInput}
                        className="input"
                        onChange={(e) => setScoreInput(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && void handleSetScoreSubmit(item.question.id)}
                        onBlur={() => void handleSetScoreSubmit(item.question.id)}
                        autoFocus
                        style={{ width: 72, flex: '0 0 auto' }}
                      />
                    ) : editable ? (
                      <button
                        data-testid={`score-btn-${item.question.id}`}
                        onClick={() => { setEditingScoreForId(item.question.id); setScoreInput(item.ref.score?.toString() ?? ''); }}
                        className="btn btn-sm"
                        style={{ flex: '0 0 auto', whiteSpace: 'nowrap' }}
                      >
                        {item.ref.score === undefined ? '设置分值' : `${item.ref.score}分`}
                      </button>
                    ) : (
                      <span style={{ flex: '0 0 auto', color: 'var(--ink-3)', fontSize: '0.85rem', whiteSpace: 'nowrap' }}>
                        {item.ref.score === undefined ? '未设置' : `${item.ref.score}分`}
                      </span>
                    )}
                    {editable && (
                      <button
                        data-testid={`remove-btn-${item.question.id}`}
                        onClick={() => void handleRemoveQuestion(item.question.id)}
                        className="btn btn-sm"
                        style={{ flex: '0 0 auto', color: 'var(--brick)' }}
                      >
                        移除
                      </button>
                    )}
                  </div>
                    </>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>

        {/* 右纸张预览：iframe 引擎真渲染（fix-2 F2-B）——全版式要素生效 + 选项分行；
            交互层（F2-D）：拖图缩放/换位、点图 mini 条（对齐/随文/右栏/上下移）、拖 Logo、点标题编辑。
            0018 目检返工一：.compose-preview-col 高度锁定在栏内，预览区自身内滚 */}
        <div className="compose-preview-col" style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
            <strong style={{ fontSize: '0.95rem' }}>卷面实时预览</strong>
            <span style={{ color: 'var(--ink-3)', fontSize: '0.8rem' }}>引擎真渲染 · 图/Logo 可拖拽调节 · 点标题可编辑</span>
            <span style={{ flex: 1 }} />
            <button
              className={previewMode === 'student' ? 'tab-btn active' : 'tab-btn'}
              data-testid="compose-inline-mode-student"
              onClick={() => setPreviewMode('student')}
            >
              学生版
            </button>
            <button
              className={previewMode === 'teacher' ? 'tab-btn active' : 'tab-btn'}
              data-testid="compose-inline-mode-teacher"
              onClick={() => setPreviewMode('teacher')}
            >
              教师版
            </button>
          </div>
          {previewHtml ? (
            <PaperPreviewFrame
              html={previewHtml}
              pageWidthMm={previewPageWidthMm}
              onMessage={handleFrameMessage}
              viewMode={previewView}
              onViewModeChange={setPreviewView}
            />
          ) : (
            <div
              data-testid="compose-paper-preview-loading"
              className="preview-zone"
              style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ink-3)' }}
            >
              预览构建中…
            </div>
          )}
        </div>
      </div>

      {/* 0004-fix-4 2.3：插入/编辑大标题（文本内容块，kind='text' 行） */}
      {showTextBlockModal && (
        <Modal
          title={textBlockEditing ? '编辑大标题' : '插入大标题'}
          onClose={() => { setShowTextBlockModal(false); setTextBlockEditing(null); setTextBlockBeforeId(null); }}
        >
          <div style={{ minWidth: '420px' }}>
            <p style={{ color: 'var(--ink-3)', fontSize: '0.85rem', marginTop: 0 }}>
              大标题 = 文本内容块（如「一、单项选择题」）：不占题号，可拖拽排序、随卷克隆/导出。
            </p>
            <input
              className="input"
              data-testid="text-block-input"
              value={textBlockDraft}
              onChange={(e) => setTextBlockDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void saveTextBlock()}
              autoFocus
              placeholder="一、单项选择题"
              style={{ width: '100%' }}
            />
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '0.75rem' }}>
              <button className="btn" onClick={() => { setShowTextBlockModal(false); setTextBlockEditing(null); setTextBlockBeforeId(null); }}>取消</button>
              <button className="btn btn-primary" data-testid="text-block-save" onClick={() => void saveTextBlock()}>保存</button>
            </div>
          </div>
        </Modal>
      )}

      {/* 0018 目检返工二：加题/新建题弹层随入口退役（加题归试题篮详情页） */}

      {/* 题级图片设置弹层（0018 目检返工二：行内「图片」按钮打开——列表/插图/调参/保存） */}
      {figureSettingsItem && (
        <Modal title={`图片设置（第 ${questions.findIndex((q) => q.question.id === figureSettingsItem.question.id) + 1} 题）`} onClose={() => setFigureSettingsFor(null)}>
          <QuestionFigureSettings
            question={figureSettingsItem.question}
            current={figureSettingsItem.ref.layout?.figures}
            onCancel={() => setFigureSettingsFor(null)}
            onSave={(layoutValue) => saveFigureLayouts(layoutValue)}
          />
        </Modal>
      )}

      {/* 归档确认（自绘弹层，禁 confirm；fix-1 C：动词统一「归档」+ 定稿文案） */}
      {showArchiveConfirm && (
        <Modal title="归档试卷" onClose={() => setShowArchiveConfirm(false)}>
          <p data-testid="compose-archive-confirm-text" style={{ marginTop: 0 }}>{ARCHIVE_CONFIRM_TEXT}</p>
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => setShowArchiveConfirm(false)}>取消</button>
            <button
              className="btn btn-danger"
              data-testid="compose-archive-confirm"
              onClick={() => void archivePaper()}
            >
              确认归档
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
