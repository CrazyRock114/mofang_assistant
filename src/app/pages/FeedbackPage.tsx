// 0030 反馈工作台：`#/feedback` 原位升级（D-065 重规划 + 设计稿 feedback-workbench 设计稿 v1）。
//
// 四个视图（同一路由内的 tab，不新开路由）：
//   ① 快速模式 .fbw-qk    —— 一次性使用，不关联档案；四项输入 + 风格三维 → 生成 → 复制/换一版/保存记录（留痕）
//   ② 班级批量 .fbw-bt    —— 公共信息填一次、逐人点表现、可关联考试带成绩；逐人进度 + 草稿自动存可续；
//                            底部唯一动作「保存记录（N）→ 计入学生档案」
//   ③ 反馈记录 .fbw-rc    —— 列表（时间/学生/班级/摘要）+ 班级 chip + 姓名搜索；快速留痕带「未关联」标
//   ④ 提示词模板 .fbw-tp  —— 内置只读 + 自定义可改可删；全文可见可改；导出/导入文本（prompt pack）
//
// 两条通道（D-065 ⑦ + 任务书 §一 P2）：AI 档 = 组装器 → ai.invoke(reasoning) → 红线守卫；
// 离线档 = 0005 renderFeedback 插值（无 Key 可用）。**失败是结果不是异常**：失败卡显示原因可重试，
// 不静默回落。守卫命中标红提醒、保存时弹层提示 N 条待核对，**不硬拦**（教师判断）。
//
// 取消「标记已发」：全页只有「保存记录」一个落档动作；发没发过不跟踪（设计稿视图三说明）。
// 保留 0005 既有能力：离线模板管理（弹层）+ txt/卡片 PNG 导出（D-065 未列入不做清单，不倒退）。

import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AiInvokePayload, AiInvokeResult, ModelProfile } from '../../shared/contracts/ai-types.js';
import type { MofangAiBridge } from '../../shared/contracts/bridge.js';
import type {
  ClassInfo, Exam, FeedbackChannel, FeedbackPromptTemplate, FeedbackRecord, FeedbackTemplate, Student,
} from '../../shared/contracts/bank-types.js';
import {
  useExtPageServices, MessageBanner, Modal, Field, PageHeader, ConfirmButton, ProgressNote,
  type ExtPageServices, type PageMessage,
} from './ExtUi.js';
import { FEEDBACK_VARS } from '../feedback/render.js';
import {
  DEFAULT_STYLE, LENGTH_OPTIONS, TONE_OPTIONS, FEEDBACK_FACT_VARS, FEEDBACK_STYLE_VARS,
  type FeedbackInputs, type FeedbackLength, type FeedbackStyle, type FeedbackTone,
} from '../feedback/prompt.js';
import { feedbackInputSnapshot, generateFeedback, type GenerateOutcome } from '../feedback/engine.js';
import { formatPromptPack, parsePromptPack } from '../feedback/prompt-pack.js';
import type { FeedbackGuardFailure } from '../feedback/guard.js';
import { createAiServices } from '../services/AiServiceFactory.js';

/** 0005 遗留键：离线模板默认选择（沿用旧口径，老用户设置不失效） */
const DEFAULT_TEMPLATE_KEY = 'mofang-feedback-default-template-id';
/** 0030：批量模式草稿（关页重开可续——任务书 §一 P4「吃 R-031 螃蟹的最小口径」） */
const BATCH_DRAFT_KEY = 'mofang-feedback-batch-draft-v1';
/** 草稿落盘防抖（连续编辑/逐人生成期间不写中间态；安静这么久才写一次） */
const BATCH_DRAFT_DEBOUNCE_MS = 300;

/** 表现标签（第二轮返工④：标签库条目——tone 决定页面上的颜色语义） */
export interface PerformanceTag {
  label: string;
  tone: 'pos' | 'neg';
}

/** 自定义标签库的持久化键（零契约零迁移：与 0055 手感包同口径，localStorage 承载偏好类数据） */
const TAG_LIBRARY_KEY = 'mofang-feedback-perf-tags-v1';

/** 读取自定义标签库（耐脏：坏数据当作空库，不炸页面） */
function readTagLibrary(): PerformanceTag[] {
  try {
    const raw = window.localStorage.getItem(TAG_LIBRARY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is { label: string; tone?: string } => (
        typeof item === 'object' && item !== null && typeof (item as { label?: unknown }).label === 'string'
      ))
      .map((item) => ({ label: item.label, tone: item.tone === 'neg' ? 'neg' as const : 'pos' as const }))
      .filter((item) => item.label.trim() !== '');
  } catch {
    return [];
  }
}

/** 内置通用表现标签集（任务书 §一 P4；FB-02 允许的「通用基本模板」，非个人教学资产） */
export const PERFORMANCE_TAGS: ReadonlyArray<PerformanceTag> = [
  { label: '专注', tone: 'pos' },
  { label: '积极', tone: 'pos' },
  { label: '理解很快', tone: 'pos' },
  { label: '进步明显', tone: 'pos' },
  { label: '走神', tone: 'neg' },
  { label: '练习不足', tone: 'neg' },
  { label: '薄弱', tone: 'neg' },
];

/**
 * 页面需要的 AI 面（只两件事：档案列表 + 通用代理）。窄接口便于注入假桥测试，
 * 也把「本页能用 AI 做什么」写死在一处。
 */
export interface FeedbackAiAccess {
  listProfiles(): Promise<ModelProfile[]>;
  invoke(payload: AiInvokePayload): Promise<AiInvokeResult>;
}

/** 真实桥 → 页面 AI 面（reasoning 档优先，回落 vision；都没有=离线档） */
export function feedbackAiAccess(bridge: MofangAiBridge): FeedbackAiAccess {
  return {
    listProfiles: () => bridge.profile.list(),
    invoke: (payload) => bridge.invoke(payload),
  };
}

/** 生成档位选择（照 0040 recognize.ts 回落口径：reasoning 优先，其次 vision；均无 → 离线档） */
export function pickFeedbackProfile(profiles: ModelProfile[]): ModelProfile | null {
  return profiles.find((p) => p.role === 'reasoning' && p.isEnabled)
    ?? profiles.find((p) => p.role === 'vision' && p.isEnabled)
    ?? null;
}

function todayText(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 记录页时间列：ISO → 本地 `MM-DD HH:mm`（解析失败原样回显，不猜） */
function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 在正文末尾插入变量（设置页内联编辑器用；无 ref 时退回追加） */
function insertOfflineVar(
  variable: string,
  setState: (next: { id: string | null; name: string; body: string }) => void,
  current: { id: string | null; name: string; body: string },
): void {
  setState({ ...current, body: `${current.body}{${variable}}` });
}

/** 「先建再填」的新模板默认正文（与内置模板同构：事实段 + 写作要求，变量面板可查） */
const DEFAULT_PROMPT_BODY = [
  '你是一位有经验的培训老师，正在给学生{学生姓名}的家长写课后反馈。',
  '',
  '【事实信息——只允许使用以下内容，不得编造、不得改动数字】',
  '课程主题：{课程主题}',
  '课堂内容：{课堂内容}',
  '课堂表现：{课堂表现}',
  '课后任务：{课后任务}',
  '测试成绩：{成绩}',
  '备注：{备注}',
  '',
  '【写作要求】',
  '语气：{语气}。篇幅：{篇幅}。{家庭建议}',
].join('\n');

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toggle(list: string[], value: string, on: boolean): string[] {
  if (on) return list.includes(value) ? list : [...list, value];
  return list.filter((v) => v !== value);
}

/** 批量模式逐人可编辑行 */
interface BatchRowState {
  selected: boolean;
  score: string;
  /** 个别备注：给 AI 的补充说明（独立事实，不是表现标签） */
  note: string;
  /** 勾选的模板标签（来自标签库） */
  tags: string[];
  /** 一次性的具体表现（只属于这位学生这一次，第二轮返工④） */
  extras: string[];
}

/** 批量模式逐卡状态（生成 → 完成/失败，可重试） */
interface BatchCardState {
  studentId: string;
  studentName: string;
  status: 'pending' | 'generating' | 'done' | 'failed';
  text: string;
  error?: string;
  failures: FeedbackGuardFailure[];
  channel?: FeedbackChannel;
  prompt?: string | null;
  promptTemplateId?: string | null;
  modelProfileId?: string | null;
}

interface BatchDraft {
  savedAt: string;
  classId: string;
  examId: string;
  /** 课程主题（目检返工③：批量公共信息） */
  topic: string;
  content: string;
  homework: string;
  style: FeedbackStyle;
  promptTemplateId: string;
  offlineTemplateId: string;
  rows: Record<string, BatchRowState>;
  cards: BatchCardState[];
}

/**
 * 页面级错误边界（白屏兜底）：渲染期任何异常都在这里接住，给出可读提示 + 一键清理本地草稿后重试，
 * 而不是留一个死白屏（本次白屏事故的教训：旧草稿形态 incompat 时用户没有任何自救手段）。
 */
export class FeedbackPageErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  private resetLocalState = (): void => {
    try {
      window.localStorage.removeItem(BATCH_DRAFT_KEY);
      window.localStorage.removeItem(TAG_LIBRARY_KEY);
    } catch {
      // 清不掉也要能重试（隐私模式等）
    }
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return (
      <div className="fbw-scope">
        <div className="notice notice-red" data-testid="fb-page-error" style={{ margin: '1rem 0' }}>
          <strong>反馈页出错了：</strong>{this.state.error}
        </div>
        <p className="fbw-muted">已保存的记录不受影响。</p>
        <div className="fbw-row">
          <button className="btn btn-primary" data-testid="fb-page-error-reset" onClick={this.resetLocalState}>
            清理本地草稿并重试
          </button>
          <button className="btn" onClick={() => window.location.reload()}>刷新页面</button>
        </div>
      </div>
    );
  }
}

function FeedbackPageInner({ svc: injected, ai: injectedAi }: { svc?: ExtPageServices; ai?: FeedbackAiAccess }) {
  const svc = useExtPageServices(injected);
  const ai = useMemo(
    () => injectedAi ?? feedbackAiAccess(createAiServices()),
    [injectedAi],
  );
  const hasFileBridge = typeof window !== 'undefined' && Boolean(window.__mofangFile);

  // 有未保存的批量草稿 → 直接落在「班级批量」（关页重开能接着来，不用自己找回来）
  const [tab, setTab] = useState<'quick' | 'batch' | 'records' | 'settings'>(() => (
    typeof window !== 'undefined' && window.localStorage.getItem(BATCH_DRAFT_KEY) ? 'batch' : 'quick'
  ));
  const [message, setMessage] = useState<PageMessage | null>(null);

  // ---------- 共用数据 ----------
  const [classes, setClasses] = useState<ClassInfo[]>([]);
  /** 0005 离线模板（无 AI 时的兜底正文）+ 0030 AI 提示词模板 */
  const [offlineTemplates, setOfflineTemplates] = useState<FeedbackTemplate[]>([]);
  const [offlineTemplateId, setOfflineTemplateId] = useState('');
  const [promptTemplates, setPromptTemplates] = useState<FeedbackPromptTemplate[]>([]);
  const [promptTemplateId, setPromptTemplateId] = useState('');
  const [aiProfile, setAiProfile] = useState<ModelProfile | null>(null);

  // ---------- 快速模式 ----------
  const [quickName, setQuickName] = useState('');
  const [quickTopic, setQuickTopic] = useState('');
  const [quickContent, setQuickContent] = useState('');
  const [quickPerformance, setQuickPerformance] = useState<string[]>([]);
  const [quickHomework, setQuickHomework] = useState('');
  const [quickScore, setQuickScore] = useState('');
  const [quickScoreTitle, setQuickScoreTitle] = useState('');
  const [quickNote, setQuickNote] = useState('');
  const [quickText, setQuickText] = useState('');
  const [quickOutcome, setQuickOutcome] = useState<GenerateOutcome | null>(null);
  const [quickBusy, setQuickBusy] = useState(false);

  // ---------- 风格三维（两模式共用一份：批量是「全班共享」的公共信息） ----------
  const [style, setStyle] = useState<FeedbackStyle>(DEFAULT_STYLE);

  // ---------- 班级批量 ----------
  const [classId, setClassId] = useState('');
  const [exams, setExams] = useState<Exam[]>([]);
  const [examId, setExamId] = useState('');
  const [students, setStudents] = useState<Student[]>([]);
  const [rows, setRows] = useState<Record<string, BatchRowState>>({});
  const [batchTopic, setBatchTopic] = useState('');
  const [batchContent, setBatchContent] = useState('');
  const [batchHomework, setBatchHomework] = useState('');
  const [cards, setCards] = useState<BatchCardState[]>([]);
  const [batchBusy, setBatchBusy] = useState(false);
  const [progress, setProgress] = useState<{ index: number; total: number } | null>(null);
  const [draftBanner, setDraftBanner] = useState<string | null>(null);
  const restoringDraft = useRef(false);

  // ---------- 反馈记录 ----------
  const [records, setRecords] = useState<FeedbackRecord[]>([]);
  const [recordsClassId, setRecordsClassId] = useState('');
  const [recordsKeyword, setRecordsKeyword] = useState('');
  const [recordDetail, setRecordDetail] = useState<FeedbackRecord | null>(null);

  // ---------- 提示词模板 ----------
  const [tplId, setTplId] = useState('');
  /** 编辑草稿（仅当 id 与当前选中项一致时生效——选中项一变即自动回到列表里的最新正文） */
  const [tplDraft, setTplDraft] = useState<{ id: string; name: string; body: string } | null>(null);

  // ---------- 反馈设置页：主从结构（左侧选中一条 → 右侧只展开它，第三轮返工） ----------
  /**
   * 当前选中的条目。null = 还没点过（默认落"第一条提示词模板"）；`id === null` = 新建（右侧空表单，先填再建）。
   * 三类共用一份选择：提示词模板 / 离线模板 / 课堂表现标签——右侧只显示选中那一类的内容。
   */
  const [settingsSel, setSettingsSel] = useState<{ kind: 'prompt' | 'offline' | 'tag'; id: string | null } | null>(null);
  /** 提示词模板「先建再填」的草稿（点「＋新建提示词模板」后填写；点「新建」才落库） */
  const [newPromptDraft, setNewPromptDraft] = useState<{ name: string; body: string }>(
    { name: '', body: DEFAULT_PROMPT_BODY },
  );
  /** 离线模板编辑草稿（选中某条或新建时填充；内置条目只读展示） */
  const [offlineDraft, setOfflineDraft] = useState<{ id: string | null; name: string; body: string }>(
    { id: null, name: '', body: '' },
  );
  /** 标签行内编辑草稿（original=null 表示当前没有行在编辑） */
  const [tagDraft, setTagDraft] = useState<{ original: string | null; label: string; tone: 'pos' | 'neg' }>(
    { original: null, label: '', tone: 'pos' },
  );
  /** 标签面板顶部「新增」表单 */
  const [newTagLabel, setNewTagLabel] = useState('');
  const [newTagTone, setNewTagTone] = useState<'pos' | 'neg'>('pos');

  // ---------- 生成方式（目检返工④：显式 AI 开关）与自定义标签（返工②） ----------
  /** AI 润色开关：配了 reasoning/vision 档案则默认开；关掉即用模板生成（不偷偷换通道） */
  const [aiOn, setAiOn] = useState(false);
  /**
   * 课堂表现「标签库」：内置七条（代码常量，不可删）+ 自定义（在「反馈设置」里维护，localStorage 持久化）。
   * 与「其他课堂表现」区分：标签是可复用的模板标签；其他表现只属于这一次、这一位学生（见 quickExtras/row.extras）。
   */
  const [libraryTags, setLibraryTags] = useState<PerformanceTag[]>(() => readTagLibrary());
  /** 快速模式「加一条具体表现」输入缓冲 */
  const [extraDraft, setExtraDraft] = useState('');
  /** 一次性的具体表现（快速模式，仅这位学生这一次） */
  const [quickExtras, setQuickExtras] = useState<string[]>([]);
  /** 批量模式正在为哪位学生加一条具体表现（null=没有行处于输入态） */
  const [extraFor, setExtraFor] = useState<string | null>(null);

  // ---------- 守卫不硬拦：待确认保存 ----------
  const [pendingSave, setPendingSave] = useState<{ failures: FeedbackGuardFailure[]; run: () => void } | null>(null);

  /** 页面标签行 = 内置七条 + 标签库自定义（去重；自定义在后） */
  const allTags: PerformanceTag[] = [
    ...PERFORMANCE_TAGS.map((t) => ({ label: t.label, tone: t.tone })),
    ...libraryTags.filter((t) => !PERFORMANCE_TAGS.some((b) => b.label === t.label)),
  ];

  /** 实际走的通道：开关开着且确有可用档案才是 AI（否则明示模板生成） */
  const channel: FeedbackChannel = aiOn && aiProfile ? 'ai' : 'offline';
  const currentPromptTemplate = promptTemplates.find((t) => t.id === promptTemplateId) ?? null;
  const currentOfflineTemplate = offlineTemplates.find((t) => t.id === offlineTemplateId) ?? null;
  /** 有效选择：没点过左侧时默认落第一条提示词模板 */
  const settingsSelEff = settingsSel
    ?? { kind: 'prompt' as const, id: promptTemplates[0]?.id ?? null };

  // 提示词模板编辑器：选中项（未选时落内置第一条）+ 编辑草稿（同 id 才生效，避免中间一帧错位）
  const currentTpl = promptTemplates.find((t) => t.id === tplId) ?? promptTemplates[0] ?? null;
  const tplDraftActive = tplDraft !== null && tplDraft.id === currentTpl?.id;
  const tplName = tplDraftActive ? tplDraft.name : currentTpl?.name ?? '';
  const tplBody = tplDraftActive ? tplDraft.body : currentTpl?.body ?? '';
  const editTplName = (value: string) => {
    if (currentTpl) setTplDraft({ id: currentTpl.id, name: value, body: tplBody });
  };
  const editTplBody = (value: string) => {
    if (currentTpl) setTplDraft({ id: currentTpl.id, name: tplName, body: value });
  };

  const reloadPromptTemplates = async (): Promise<FeedbackPromptTemplate[]> => {
    const list = await svc.ext.feedbackPrompt.listTemplates();
    setPromptTemplates(list);
    const builtin = list.find((t) => t.isBuiltin);
    setPromptTemplateId((prev) => (list.some((t) => t.id === prev) ? prev : builtin?.id ?? list[0]?.id ?? ''));
    return list;
  };

  const reloadOfflineTemplates = async (): Promise<FeedbackTemplate[]> => {
    const list = await svc.ext.feedback.listTemplates();
    setOfflineTemplates(list);
    return list;
  };

  const reloadRecords = async (filter?: { classId?: string; keyword?: string }): Promise<void> => {
    const nextClassId = filter?.classId ?? recordsClassId;
    const nextKeyword = filter?.keyword ?? recordsKeyword;
    const list = await svc.ext.feedbackRecord.listRecords({
      ...(nextClassId ? { classId: nextClassId } : {}),
      ...(nextKeyword.trim() ? { studentName: nextKeyword.trim() } : {}),
    });
    setRecords(list);
  };

  // 初始装载：班级 + 两个模板体系 + AI 档案 + 批量草稿
  useEffect(() => {
    void (async () => {
      try {
        const [, offline] = await Promise.all([reloadPromptTemplates(), reloadOfflineTemplates()]);
        const savedDefault = window.localStorage.getItem(DEFAULT_TEMPLATE_KEY);
        const initialOffline = offline.find((t) => t.id === savedDefault)
          ?? offline.find((t) => t.isBuiltin) ?? offline[0];
        setOfflineTemplateId((prev) => prev || initialOffline?.id || '');
        setClasses(await svc.ext.class.listClasses({ status: 'active' }));
      } catch (err) {
        setMessage({ type: 'error', text: `数据加载失败：${errorText(err)}` });
      }
      try {
        const profile = pickFeedbackProfile(await ai.listProfiles());
        setAiProfile(profile);
        setAiOn(Boolean(profile));
      } catch {
        // 浏览器 demo/未配置：AI 面不可用 → 明示走离线档（不弹错，AI 是可选能力）
        setAiProfile(null);
      }
      const draft = readBatchDraft();
      if (draft) {
        restoringDraft.current = true;
        setClassId(draft.classId);
        setExamId(draft.examId);
        setBatchTopic(draft.topic);
        setBatchContent(draft.content);
        setBatchHomework(draft.homework);
        setStyle(draft.style);
        setPromptTemplateId((prev) => draft.promptTemplateId || prev);
        setOfflineTemplateId((prev) => draft.offlineTemplateId || prev);
        setRows(draft.rows);
        setCards(draft.cards);
        setDraftBanner(draft.savedAt);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 班级变化 → 考试 + 在班学生（草稿恢复时不覆盖已恢复的勾选与卡片）
  useEffect(() => {
    if (!classId) {
      setExams([]);
      setStudents([]);
      return;
    }
    void (async () => {
      try {
        setExams(await svc.ext.exam.listExams({ classId }));
        const members = await svc.ext.student.listStudents({ classId, includeArchived: false });
        setStudents(members);
        if (restoringDraft.current) {
          restoringDraft.current = false;
          return;
        }
        setRows(Object.fromEntries(members.map((s) => [s.id, { selected: true, score: '', note: '', tags: [], extras: [] }])));
        setCards([]);
      } catch (err) {
        setMessage({ type: 'error', text: `班级数据加载失败：${errorText(err)}` });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classId]);

  // 草稿自动存（关页重开可续）：防抖落盘——连续编辑/逐人生成期间只在「安静 300ms」后写一次，
  // 天然避开逐卡中间态（排队中/生成中），也不会把每次击键都写盘。
  // 恢复侧另有兜底：万一在生成中途落盘，未完成卡按「可重试的失败卡」恢复（见 readBatchDraft）。
  useEffect(() => {
    if (!classId) return;
    const handle = window.setTimeout(() => {
      const draft: BatchDraft = {
        savedAt: new Date().toISOString(),
        classId, examId, topic: batchTopic, content: batchContent, homework: batchHomework, style,
        promptTemplateId, offlineTemplateId, rows, cards,
      };
      try {
        window.localStorage.setItem(BATCH_DRAFT_KEY, JSON.stringify(draft));
      } catch {
        // 配额/隐私模式失败不阻塞主流程（草稿是伴生能力）
      }
    }, BATCH_DRAFT_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [classId, examId, batchTopic, batchContent, batchHomework, style, promptTemplateId, offlineTemplateId, rows, cards]);

  // 记录页：切到该 tab 或筛选变化时拉取
  useEffect(() => {
    if (tab !== 'records') return;
    void reloadRecords().catch((err) => setMessage({ type: 'error', text: `记录加载失败：${errorText(err)}` }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, recordsClassId, recordsKeyword]);

  // ---------- 生成 ----------

  /** 组装一次生成的公共参数（两模式共用）：通道 + 模板 + 档位 */
  const generationBase = (inputs: FeedbackInputs): Parameters<typeof generateFeedback>[0] => ({
    inputs,
    style,
    channel,
    ...(currentPromptTemplate ? { promptTemplate: { id: currentPromptTemplate.id, body: currentPromptTemplate.body } } : {}),
    ...(currentOfflineTemplate ? { offlineTemplateBody: currentOfflineTemplate.bodyTemplate } : {}),
    offlineExtra: { date: todayText() },
    modelProfileId: aiProfile?.id ?? null,
    invoke: (payload) => ai.invoke(payload),
  });

  const quickInputs = (): FeedbackInputs => ({
    studentName: quickName,
    topic: quickTopic,
    lessonContent: quickContent,
    performance: [...quickPerformance, ...quickExtras],
    homework: quickHomework,
    score: quickScore,
    scoreTitle: quickScoreTitle,
    note: quickNote,
  });

  /** 选中设置页左侧某条：右侧随之只展开这一项（tag 类是一个"全部标签"面板，不再有单条选中） */
  const selectSettings = (kind: 'prompt' | 'offline' | 'tag', id: string | null): void => {
    setSettingsSel({ kind, id });
    if (kind === 'prompt') {
      if (id) setTplId(id);
      else setNewPromptDraft({ name: '', body: DEFAULT_PROMPT_BODY }); // 新建：先填再建
    }
    if (kind === 'offline') {
      const template = id ? offlineTemplates.find((t) => t.id === id) : undefined;
      setOfflineDraft(template
        ? { id: template.id, name: template.name, body: template.bodyTemplate }
        : { id: null, name: '', body: '' });
    }
    if (kind === 'tag') {
      setTagDraft({ original: null, label: '', tone: 'pos' }); // 切到标签面板时收起行内编辑
    }
  };

  /** 标签库写入（反馈设置页维护；localStorage 持久化） */
  const persistLibraryTags = (next: PerformanceTag[]): void => {
    setLibraryTags(next);
    try {
      window.localStorage.setItem(TAG_LIBRARY_KEY, JSON.stringify(next));
    } catch {
      // 隐私模式/配额失败：本次会话内仍可用（标签库是偏好数据，不阻塞主流程）
    }
  };

  /** 新增自定义标签（重名拒绝；内置同名拒绝） */
  const addLibraryTag = (raw: string, tone: 'pos' | 'neg'): void => {
    const label = raw.trim();
    if (label === '') return;
    if (allTags.some((t) => t.label === label)) {
      setMessage({ type: 'error', text: `标签「${label}」已存在` });
      return;
    }
    persistLibraryTags([...libraryTags, { label, tone }]);
    setMessage({ type: 'success', text: `已添加标签「${label}」` });
  };

  /** 改自定义标签的名字/色系（页面上已选中的同名标签与草稿行同步改名，不留悬空选中） */
  const renameLibraryTag = (original: string, nextLabel: string, tone: 'pos' | 'neg'): void => {
    const label = nextLabel.trim();
    if (label === '') {
      setMessage({ type: 'error', text: '标签名不能为空' });
      return;
    }
    const conflict = allTags.some((t) => t.label === label && t.label !== original);
    if (conflict) {
      setMessage({ type: 'error', text: `标签「${label}」已存在` });
      return;
    }
    persistLibraryTags(libraryTags.map((t) => (t.label === original ? { label, tone } : t)));
    if (label !== original) {
      const swap = (list: string[]): string[] => list.map((v) => (v === original ? label : v));
      setQuickPerformance(swap);
      setRows((prev) => Object.fromEntries(Object.entries(prev).map(([id, row]) => (
        [id, { ...row, tags: swap(row.tags ?? []) }]
      ))));
    }
    setTagDraft({ original: null, label: '', tone });
    setMessage({ type: 'success', text: `已保存标签「${label}」` });
  };

  const removeLibraryTag = (label: string): void => {
    persistLibraryTags(libraryTags.filter((t) => t.label !== label));
    // 标签从库里删掉后，页面选中态里的同名条目一并清掉（不留悬空选中）
    setQuickPerformance((prev) => prev.filter((v) => v !== label));
    setRows((prev) => Object.fromEntries(Object.entries(prev).map(([id, row]) => (
      [id, { ...row, tags: row.tags.filter((v) => v !== label) }]
    ))));
    if (tagDraft.original === label) setTagDraft({ original: null, label: '', tone: 'pos' });
    setMessage({ type: 'success', text: `已删除标签「${label}」` });
  };

  /** 一次性的具体表现（第二轮返工④）：只属于这一次、这一位学生，不进标签库 */
  const addExtra = (raw: string, studentId?: string): void => {
    const text = raw.trim();
    if (text === '') return;
    if (studentId === undefined) {
      setQuickExtras((prev) => [...prev, text]);
    } else {
      setRows((prev) => {
        const row = prev[studentId] ?? { selected: true, score: '', note: '', tags: [], extras: [] };
        return { ...prev, [studentId]: { ...row, extras: [...row.extras, text] } };
      });
    }
  };

  const removeExtra = (index: number, studentId?: string): void => {
    if (studentId === undefined) {
      setQuickExtras((prev) => prev.filter((_, i) => i !== index));
      return;
    }
    setRows((prev) => {
      const row = prev[studentId];
      if (!row) return prev;
      return { ...prev, [studentId]: { ...row, extras: row.extras.filter((_, i) => i !== index) } };
    });
  };

  const runQuickGenerate = async () => {
    if (!quickName.trim() || !quickContent.trim()) {
      setMessage({ type: 'error', text: '请先填写学生姓名与课堂内容' });
      return;
    }
    setQuickBusy(true);
    try {
      const outcome = await generateFeedback(generationBase(quickInputs()));
      setQuickOutcome(outcome);
      if (!outcome.ok) {
        setMessage({ type: 'error', text: `生成失败：${outcome.error}` });
        return;
      }
      setQuickText(outcome.text);
      setMessage(
        outcome.failures.length > 0
          ? { type: 'error', text: `${outcome.failures.length} 条待核对` }
          : { type: 'success', text: outcome.channel === 'ai' ? '已生成（AI 润色）' : '已生成（模板生成）' },
      );
    } finally {
      setQuickBusy(false);
    }
  };

  const studentInputs = (student: Student, row: BatchRowState): FeedbackInputs => ({
    studentName: student.name,
    topic: batchTopic,
    lessonContent: batchContent,
    performance: [...(row.tags ?? []), ...(row.extras ?? [])],
    homework: batchHomework,
    score: row.score.trim(),
    scoreTitle: exams.find((e) => e.id === examId)?.title ?? '',
    note: row.note,
  });

  const selectedStudents = (): Student[] => students.filter((s) => rows[s.id]?.selected);

  const generateOne = async (student: Student, row: BatchRowState): Promise<void> => {
    setCards((prev) => prev.map((c) => (
      c.studentId === student.id
        ? { ...c, status: 'generating', error: undefined }
        : c
    )));
    const outcome = await generateFeedback(generationBase(studentInputs(student, row)));
    setCards((prev) => prev.map((c) => {
      if (c.studentId !== student.id) return c;
      return outcome.ok
        ? {
          ...c, status: 'done', text: outcome.text, error: undefined, failures: outcome.failures,
          channel: outcome.channel, prompt: outcome.prompt,
          promptTemplateId: outcome.promptTemplateId, modelProfileId: outcome.modelProfileId,
        }
        : { ...c, status: 'failed', error: outcome.error, failures: [] };
    }));
  };

  /** 逐人生成（顺序执行：一次一位、进度可见，也避免对小站网关连打） */
  const runBatchGenerate = async () => {
    if (!batchContent.trim()) {
      setMessage({ type: 'error', text: '请填写课堂内容' });
      return;
    }
    const targets = selectedStudents();
    if (targets.length === 0) {
      setMessage({ type: 'error', text: '请先勾选学生' });
      return;
    }
    setBatchBusy(true);
    setCards(targets.map((s) => ({
      studentId: s.id, studentName: s.name, status: 'pending', text: '', failures: [],
    })));
    try {
      for (let i = 0; i < targets.length; i += 1) {
        const student = targets[i]!;
        setProgress({ index: i + 1, total: targets.length });
        await generateOne(student, rows[student.id] ?? { selected: true, score: '', note: '', tags: [] });
      }
      setMessage({ type: 'success', text: `已生成 ${targets.length} 张` });
    } finally {
      setProgress(null);
      setBatchBusy(false);
    }
  };

  // ---------- 保存记录（唯一落档动作；无「已发」状态） ----------

  const requestSave = (failures: FeedbackGuardFailure[], run: () => void) => {
    if (failures.length > 0) {
      setPendingSave({ failures, run });
      return;
    }
    run();
  };

  const recordCommon = (outcome: GenerateOutcome | null, inputs: FeedbackInputs) => ({
    channel: outcome && outcome.ok ? outcome.channel : channel,
    promptTemplateId: outcome && outcome.ok ? outcome.promptTemplateId : currentPromptTemplate?.id ?? null,
    promptSnapshot: outcome && outcome.ok ? outcome.prompt : null,
    modelProfileId: outcome && outcome.ok ? outcome.modelProfileId : aiProfile?.id ?? null,
    inputJson: feedbackInputSnapshot(inputs),
  });

  const saveQuickRecord = () => {
    const inputs = quickInputs();
    void (async () => {
      try {
        await svc.ext.feedbackRecord.createRecord({
          studentName: inputs.studentName.trim(),
          ...recordCommon(quickOutcome, inputs),
          body: quickText,
        });
        setMessage({ type: 'success', text: '已保存记录（未关联学生档案）' });
      } catch (err) {
        setMessage({ type: 'error', text: `保存失败：${errorText(err)}` });
      }
    })();
  };

  const saveBatchRecords = () => {
    const done = cards.filter((c) => c.status === 'done' && c.text.trim() !== '');
    void (async () => {
      const exam = exams.find((e) => e.id === examId);
      let saved = 0;
      const failed: string[] = [];
      for (const card of done) {
        const student = students.find((s) => s.id === card.studentId);
        const row = rows[card.studentId] ?? { selected: true, score: '', note: '', tags: [], extras: [] };
        try {
          await svc.ext.feedbackRecord.createRecord({
            studentId: card.studentId,
            studentName: card.studentName,
            classId: classId || null,
            examId: exam?.id ?? null,
            channel: card.channel ?? channel,
            promptTemplateId: card.promptTemplateId ?? currentPromptTemplate?.id ?? null,
            promptSnapshot: card.prompt ?? null,
            modelProfileId: card.modelProfileId ?? aiProfile?.id ?? null,
            inputJson: feedbackInputSnapshot(student ? studentInputs(student, row) : {
              studentName: card.studentName, lessonContent: batchContent, performance: row.tags, homework: batchHomework,
            }),
            body: card.text,
          });
          saved += 1;
        } catch (err) {
          failed.push(`${card.studentName}（${errorText(err)}）`);
        }
      }
      if (failed.length === 0) {
        window.localStorage.removeItem(BATCH_DRAFT_KEY);
        setDraftBanner(null);
        setMessage({ type: 'success', text: `已保存 ${saved} 条记录（计入学生档案）` });
      } else {
        setMessage({
          type: 'error',
          text: `已保存 ${saved} 条、失败 ${failed.length} 条：${failed.join('；')}`,
        });
      }
      if (tab === 'records') await reloadRecords();
    })();
  };

  // ---------- 离线模板（反馈设置页内联维护；0005 语义保留） ----------

  const saveOfflineTemplate = async () => {
    const draft = offlineDraft;
    const name = draft.name.trim();
    const body = draft.body.trim();
    if (name === '' || body === '') {
      setMessage({ type: 'error', text: '离线模板的名称与正文都要填' });
      return;
    }
    try {
      if (draft.id) {
        await svc.ext.feedback.updateTemplate(draft.id, { name, bodyTemplate: body });
        await reloadOfflineTemplates();
        setMessage({ type: 'success', text: `已保存离线模板「${name}」` });
      } else {
        const created = await svc.ext.feedback.createTemplate({ name, bodyTemplate: body });
        await reloadOfflineTemplates();
        setOfflineTemplateId(created.id);
        setMessage({ type: 'success', text: `已新建离线模板「${created.name}」` });
      }
      setSettingsSel({ kind: 'offline', id: draft.id ?? null });
    } catch (err) {
      setMessage({ type: 'error', text: `保存离线模板失败：${errorText(err)}` });
    }
  };

  /** 选用离线模板（= 同时记为默认，下次进页沿用；键沿用 0005 的 DEFAULT_TEMPLATE_KEY） */
  const chooseOfflineTemplate = (template: FeedbackTemplate): void => {
    setOfflineTemplateId(template.id);
    try {
      window.localStorage.setItem(DEFAULT_TEMPLATE_KEY, template.id);
    } catch {
      // 隐私模式失败不阻塞（默认选择是偏好数据）
    }
  };

  /** 内置离线模板 → 另存为自定义副本（随后选中副本，右侧即可编辑） */
  const saveAsOfflineTemplate = async (template: FeedbackTemplate): Promise<void> => {
    try {
      const created = await svc.ext.feedback.createTemplate({
        name: `${template.name}（副本）`,
        bodyTemplate: template.bodyTemplate,
      });
      await reloadOfflineTemplates();
      setMessage({ type: 'success', text: `已另存为「${created.name}」，可直接改` });
      setSettingsSel({ kind: 'offline', id: created.id });
      setOfflineDraft({ id: created.id, name: created.name, body: created.bodyTemplate });
    } catch (err) {
      setMessage({ type: 'error', text: `另存失败：${errorText(err)}` });
    }
  };

  const removeOfflineTemplate = async (template: FeedbackTemplate): Promise<void> => {
    try {
      await svc.ext.feedback.deleteTemplate(template.id);
      const list = await reloadOfflineTemplates();
      const fallback = list.find((t) => t.isBuiltin) ?? list[0];
      setOfflineTemplateId(fallback?.id ?? '');
      setSettingsSel({ kind: 'offline', id: fallback?.id ?? null });
      setMessage({ type: 'success', text: `已删除离线模板「${template.name}」` });
    } catch (err) {
      setMessage({ type: 'error', text: `删除失败：${errorText(err)}` });
    }
  };

  // ---------- 复制 / 导出（0005 保留） ----------

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setMessage({ type: 'success', text: '已复制到剪贴板' });
    } catch {
      setMessage({ type: 'error', text: '复制失败（当前环境剪贴板不可用）' });
    }
  };

  const exportTargets = (): Array<{ name: string; text: string }> => {
    const fromCards = cards.filter((c) => c.status === 'done' && c.text.trim() !== '')
      .map((c) => ({ name: c.studentName, text: c.text }));
    if (fromCards.length > 0) return fromCards;
    return quickText.trim() ? [{ name: quickName, text: quickText }] : [];
  };

  // ---------- 提示词模板（AI 通道）操作 ----------

  const savePromptTemplate = async () => {
    if (!currentTpl) return;
    if (currentTpl.isBuiltin) {
      setMessage({ type: 'error', text: '内置模板只读——用「另存为我的模板」复制一份再改' });
      return;
    }
    try {
      const updated = await svc.ext.feedbackPrompt.updateTemplate(currentTpl.id, { name: tplName, body: tplBody });
      setTplDraft(null);
      await reloadPromptTemplates();
      setTplId(updated.id);
      setMessage({ type: 'success', text: `已保存模板「${updated.name}」` });
    } catch (err) {
      setMessage({ type: 'error', text: `保存失败：${errorText(err)}` });
    }
  };

  const saveAsPromptTemplate = async () => {
    if (!currentTpl) return;
    try {
      const created = await svc.ext.feedbackPrompt.createTemplate({
        name: `${currentTpl.name}（副本）`,
        body: currentTpl.body,
      });
      setTplDraft(null);
      await reloadPromptTemplates();
      setTplId(created.id);
      setSettingsSel({ kind: 'prompt', id: created.id });
      setMessage({ type: 'success', text: `已另存为「${created.name}」，可直接改` });
    } catch (err) {
      setMessage({ type: 'error', text: `另存失败：${errorText(err)}` });
    }
  };

  /** 「先建再填」的落库动作：右侧新建表单填完点这里才真正建模板 */
  const createPromptTemplate = async () => {
    const name = newPromptDraft.name.trim();
    const body = newPromptDraft.body.trim();
    if (name === '' || body === '') {
      setMessage({ type: 'error', text: '模板名称与正文都要填' });
      return;
    }
    try {
      const created = await svc.ext.feedbackPrompt.createTemplate({ name, body });
      setTplDraft(null);
      await reloadPromptTemplates();
      setTplId(created.id);
      setSettingsSel({ kind: 'prompt', id: created.id });
      setMessage({ type: 'success', text: `已新建模板「${created.name}」（可继续改后保存）` });
    } catch (err) {
      setMessage({ type: 'error', text: `新建失败：${errorText(err)}` });
    }
  };

  const deletePromptTemplate = async () => {
    if (!currentTpl) return;
    try {
      await svc.ext.feedbackPrompt.deleteTemplate(currentTpl.id);
      setTplDraft(null);
      const list = await reloadPromptTemplates();
      const fallback = list.find((t) => t.isBuiltin) ?? list[0];
      setTplId(fallback?.id ?? '');
      setSettingsSel(fallback ? { kind: 'prompt', id: fallback.id } : null);
      setMessage({ type: 'success', text: `已删除模板「${currentTpl.name}」` });
    } catch (err) {
      setMessage({ type: 'error', text: `删除失败：${errorText(err)}` });
    }
  };

  const exportPromptTemplate = async () => {
    const pack = formatPromptPack(tplName, tplBody);
    const suggestedName = `提示词模板-${tplName.trim() || '未命名'}.txt`;
    try {
      if (hasFileBridge) {
        const res = await window.__mofangFile!.exportTextFile({ suggestedName, content: pack });
        setMessage(res.filePath ? { type: 'success', text: `已导出：${res.filePath}` } : { type: 'success', text: '已取消导出' });
        return;
      }
      const blob = new Blob([pack], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = suggestedName;
      a.click();
      URL.revokeObjectURL(url);
      setMessage({ type: 'success', text: '已导出（浏览器下载）' });
    } catch (err) {
      setMessage({ type: 'error', text: `导出失败：${errorText(err)}` });
    }
  };

  const importPromptTemplate = async () => {
    if (!hasFileBridge) {
      setMessage({ type: 'error', text: '导入需要桌面端（浏览器演示环境无文件对话框）' });
      return;
    }
    try {
      const file = await window.__mofangFile!.importTextFile();
      if (!file) return;
      const parsed = parsePromptPack(file.content, file.fileName);
      const created = await svc.ext.feedbackPrompt.createTemplate({ name: parsed.name, body: parsed.body });
      setTplDraft(null);
      await reloadPromptTemplates();
      setTplId(created.id);
      setMessage({ type: 'success', text: `已导入模板「${created.name}」（可改可删）` });
    } catch (err) {
      setMessage({ type: 'error', text: `导入失败：${errorText(err)}` });
    }
  };

  // ---------- 记录页操作 ----------

  const deleteRecord = async (record: FeedbackRecord) => {
    try {
      await svc.ext.feedbackRecord.deleteRecord(record.id);
      await reloadRecords();
      setMessage({ type: 'success', text: `已删除「${record.studentName}」的记录` });
    } catch (err) {
      setMessage({ type: 'error', text: `删除失败：${errorText(err)}` });
    }
  };

  const classNameOf = (id: string | null): string => {
    if (!id) return '—';
    return classes.find((c) => c.id === id)?.name ?? '—';
  };

  /** 关联考试 → 按学生带出成绩（可手改；缺考留空不猜） */
  async function fillScoresFromExam(nextExamId: string): Promise<void> {
    try {
      const scores = await svc.ext.exam.getExamScores(nextExamId);
      setRows((prev) => {
        const next = { ...prev };
        for (const score of scores) {
          const row = next[score.studentId];
          if (!row) continue;
          if (score.score === undefined || score.score === null) continue;
          next[score.studentId] = { ...row, score: String(score.score) };
        }
        return next;
      });
      setMessage({ type: 'success', text: '已把该考试成绩带到名单（可逐个手改）' });
    } catch (err) {
      setMessage({ type: 'error', text: `成绩带入失败：${errorText(err)}` });
    }
  }

  /**
 * 草稿行升级归一（白屏回归修复）：老版本草稿的行可能缺后来新增的字段
 *（如返工轮二的 `extras`）——直接透传会让渲染层 `row.extras.map` 抛异常、整页白屏。
 * 这里按当前形态逐字段补齐（缺的给默认值，类型不对的回落默认值），旧草稿因此可继续用。
 */
function normalizeDraftRows(rows: unknown): Record<string, BatchRowState> {
  if (typeof rows !== 'object' || rows === null) return {};
  const out: Record<string, BatchRowState> = {};
  for (const [id, raw] of Object.entries(rows as Record<string, unknown>)) {
    const row = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<BatchRowState>;
    out[id] = {
      selected: typeof row.selected === 'boolean' ? row.selected : true,
      score: typeof row.score === 'string' ? row.score : '',
      note: typeof row.note === 'string' ? row.note : '',
      tags: Array.isArray(row.tags) ? row.tags.filter((t): t is string => typeof t === 'string') : [],
      extras: Array.isArray(row.extras) ? row.extras.filter((t): t is string => typeof t === 'string') : [],
    };
  }
  return out;
}

/** 批量草稿读取（耐脏：JSON 坏/字段缺 → 当作没有草稿，不炸页面） */
  function readBatchDraft(): BatchDraft | null {
    try {
      const raw = window.localStorage.getItem(BATCH_DRAFT_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<BatchDraft>;
      if (!parsed || typeof parsed.classId !== 'string' || parsed.classId === '') return null;
      return {
        savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : new Date().toISOString(),
        classId: parsed.classId,
        examId: typeof parsed.examId === 'string' ? parsed.examId : '',
        topic: typeof parsed.topic === 'string' ? parsed.topic : '',
        content: typeof parsed.content === 'string' ? parsed.content : '',
        homework: typeof parsed.homework === 'string' ? parsed.homework : '',
        style: parsed.style ?? DEFAULT_STYLE,
        promptTemplateId: typeof parsed.promptTemplateId === 'string' ? parsed.promptTemplateId : '',
        offlineTemplateId: typeof parsed.offlineTemplateId === 'string' ? parsed.offlineTemplateId : '',
        rows: normalizeDraftRows(parsed.rows),
        // 未完成态（排队中/生成中）是上次关页时的半截现场 → 恢复为可重试的失败卡（给出原因，不静默留空）
        cards: (Array.isArray(parsed.cards) ? parsed.cards : []).map((card) => (
          card.status === 'done'
            ? card
            : { ...card, status: 'failed' as const, text: '', error: card.error ?? '上次没生成完（可重试）' }
        )),
      };
    } catch {
      return null;
    }
  }

  // ---------- 渲染 ----------

  const styleEditor = (scope: 'quick' | 'batch') => (
    <div className="fbw-card">
      <h3>② 怎么说</h3>
      <div className="fbw-style-row">
        <span className="k">语气</span>
        <div className="fbw-chips">
          {TONE_OPTIONS.map((option) => (
            <span
              key={option.code}
              data-testid={`fb-${scope}-tone-${option.code}`}
              className={style.tone === option.code ? 'fbw-chip on' : 'fbw-chip'}
              onClick={() => setStyle((prev) => ({ ...prev, tone: option.code as FeedbackTone }))}
            >
              {option.text}
            </span>
          ))}
        </div>
      </div>
      <div className="fbw-style-row">
        <span className="k">篇幅</span>
        <div className="fbw-chips">
          {LENGTH_OPTIONS.map((option) => (
            <span
              key={option.code}
              data-testid={`fb-${scope}-length-${option.code}`}
              className={style.length === option.code ? 'fbw-chip on' : 'fbw-chip'}
              onClick={() => setStyle((prev) => ({ ...prev, length: option.code as FeedbackLength }))}
            >
              {option.text}
            </span>
          ))}
        </div>
      </div>
      <div className="fbw-style-row">
        <span className="k">家庭建议</span>
        <div className="fbw-chips">
          <span
            data-testid={`fb-${scope}-family-on`}
            className={style.familyAdvice ? 'fbw-chip on' : 'fbw-chip'}
            onClick={() => setStyle((prev) => ({ ...prev, familyAdvice: true }))}
          >
            要带
          </span>
          <span
            data-testid={`fb-${scope}-family-off`}
            className={!style.familyAdvice ? 'fbw-chip on' : 'fbw-chip'}
            onClick={() => setStyle((prev) => ({ ...prev, familyAdvice: false }))}
          >
            不带
          </span>
        </div>
      </div>
      <div className="fbw-style-row">
        <span className="k">生成方式</span>
        <div className="fbw-chips">
          <span
            data-testid={`fb-${scope}-engine-ai`}
            className={aiOn && aiProfile ? 'fbw-chip on' : 'fbw-chip'}
            title={aiProfile ? '用 AI 润色后输出' : '未配置 AI 档案（到设置页配置后可用）'}
            onClick={() => {
              if (!aiProfile) {
                setMessage({ type: 'error', text: '未配置 AI 档案：先到「设置 → AI 模型」配置并启用一个档案' });
                return;
              }
              setAiOn(true);
            }}
          >
            AI 润色
          </span>
          <span
            data-testid={`fb-${scope}-engine-template`}
            className={aiOn && aiProfile ? 'fbw-chip' : 'fbw-chip on'}
            onClick={() => setAiOn(false)}
          >
            模板生成
          </span>
        </div>
      </div>
      {aiOn && aiProfile ? (
        <div className="fbw-style-row">
          <span className="k">提示词</span>
          <select
            className="select"
            data-testid={`fb-${scope}-prompt-select`}
            value={promptTemplateId}
            onChange={(e) => setPromptTemplateId(e.target.value)}
            style={{ flex: 1, minWidth: 180, padding: '0.3rem' }}
          >
            {promptTemplates.map((t) => (
              <option key={t.id} value={t.id}>{t.name}{t.isBuiltin ? '（内置）' : ''}</option>
            ))}
          </select>
          <button className="btn btn-sm" data-testid={`fb-${scope}-prompt-manage`} onClick={() => setTab('settings')}>管理…</button>
        </div>
      ) : (
        <div className="fbw-style-row">
          <span className="k">模板</span>
          <select
            className="select"
            data-testid={`fb-${scope}-template-select`}
            value={offlineTemplateId}
            onChange={(e) => setOfflineTemplateId(e.target.value)}
            style={{ flex: 1, minWidth: 180, padding: '0.3rem' }}
          >
            {offlineTemplates.map((t) => (
              <option key={t.id} value={t.id}>{t.name}{t.isBuiltin ? '（内置）' : ''}</option>
            ))}
          </select>
          <button className="btn btn-sm" data-testid={`fb-${scope}-template-manage`} onClick={() => setTab('settings')}>管理…</button>
        </div>
      )}
      <p className="fbw-muted" data-testid={`fb-${scope}-channel-note`} style={{ marginTop: 8 }}>
        {aiOn && aiProfile
          ? `AI 润色：${aiProfile.role} · ${aiProfile.model}`
          : aiProfile ? '模板生成' : '模板生成（未配置 AI 档案）'}
      </p>
    </div>
  );

  const guardBadge = (failures: FeedbackGuardFailure[], testid: string) => (
    failures.length === 0
      ? <span className={`fbw-guard ok`} data-testid={testid}>✓ 红线检查通过</span>
      : <span className={`fbw-guard hit`} data-testid={testid}>⚠ {failures.length} 条待核对</span>
  );

  const batchDoneCards = cards.filter((c) => c.status === 'done' && c.text.trim() !== '');
  const batchFailures = batchDoneCards.flatMap((c) => c.failures);

  return (
    <div className="fbw-scope">
      <PageHeader title="课后反馈" backHref="#/" />
      <MessageBanner message={message} />

      <div className="fbw-tabs">
        {([
          ['quick', '快速模式', 'fb-tab-quick'],
          ['batch', '班级批量', 'fb-tab-batch'],
          ['records', '反馈记录', 'fb-tab-records'],
          ['settings', '反馈设置', 'fb-tab-settings'],
        ] as const).map(([key, label, testid]) => (
          <button
            key={key}
            className={tab === key ? 'tab-btn active' : 'tab-btn'}
            data-testid={testid}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ============ ① 快速模式 ============ */}
      {tab === 'quick' && (
        <div className="fbw-qk">
          <div className="fbw-card fbw-qk-form">
            <h3>① 这节课的情况</h3>
            <Field label="学生姓名（必填）">
              <input className="input" data-testid="fb-quick-name" value={quickName} onChange={(e) => setQuickName(e.target.value)} style={{ width: '100%', padding: '0.3rem' }} />
            </Field>
            <Field label="课程主题（可选）">
              <input className="input" data-testid="fb-quick-topic" value={quickTopic} onChange={(e) => setQuickTopic(e.target.value)} style={{ width: '100%', padding: '0.3rem' }} />
            </Field>
            <Field label="课堂内容（必填）">
              <textarea className="input" data-testid="fb-quick-content" rows={2} value={quickContent} onChange={(e) => setQuickContent(e.target.value)} style={{ width: '100%', padding: '0.3rem' }} />
            </Field>
            <Field label="课堂表现标签（可选）">
              <div className="fbw-chips">
                {allTags.map((tag) => (
                  <span
                    key={tag.label}
                    data-testid={`fb-quick-perf-${tag.label}`}
                    className={quickPerformance.includes(tag.label) ? `fbw-chip on-${tag.tone}` : 'fbw-chip'}
                    onClick={() => setQuickPerformance((prev) => toggle(prev, tag.label, !prev.includes(tag.label)))}
                  >
                    {tag.label}
                  </span>
                ))}
              </div>
            </Field>
            <Field label="其他课堂表现（可选）">
              {quickExtras.length > 0 && (
                <div className="fbw-chips" style={{ marginBottom: 6 }}>
                  {quickExtras.map((text, index) => (
                    <span key={`${text}-${index}`} className="fbw-chip on fbw-extra" data-testid={`fb-quick-extra-${index}`}>
                      {text}
                      <button
                        type="button"
                        data-testid={`fb-quick-extra-del-${index}`}
                        aria-label={`删除「${text}」`}
                        onClick={() => removeExtra(index)}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="fbw-row">
                <input
                  className="input"
                  data-testid="fb-quick-extra-input"
                  value={extraDraft}
                  placeholder=""
                  onChange={(e) => setExtraDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return;
                    e.preventDefault();
                    addExtra(extraDraft);
                    setExtraDraft('');
                  }}
                  style={{ flex: 1, padding: '0.3rem' }}
                />
                <button
                  className="btn btn-sm"
                  data-testid="fb-quick-extra-add"
                  disabled={extraDraft.trim() === ''}
                  onClick={() => {
                    addExtra(extraDraft);
                    setExtraDraft('');
                  }}
                >
                  加一条
                </button>
              </div>
            </Field>
            <Field label="课后任务（可选）">
              <textarea className="input" data-testid="fb-quick-homework" rows={2} value={quickHomework} onChange={(e) => setQuickHomework(e.target.value)} style={{ width: '100%', padding: '0.3rem' }} />
            </Field>
            <Field label="测试成绩（可选）">
              <div className="fbw-row">
                <input className="input" data-testid="fb-quick-score" value={quickScore} placeholder="分数" onChange={(e) => setQuickScore(e.target.value)} style={{ width: 110, padding: '0.3rem' }} />
                <input className="input" data-testid="fb-quick-score-title" value={quickScoreTitle} placeholder="考试/测验名称（可选）" onChange={(e) => setQuickScoreTitle(e.target.value)} style={{ flex: 1, padding: '0.3rem' }} />
              </div>
            </Field>
            <Field label="备注（可选）">
              <textarea className="input" data-testid="fb-quick-note" rows={2} value={quickNote} onChange={(e) => setQuickNote(e.target.value)} style={{ width: '100%', padding: '0.3rem' }} />
            </Field>
          </div>

          <div className="fbw-qk-right">
            {styleEditor('quick')}
            <div className="fbw-card">
              <div className="fh fbw-row">
                <strong>生成结果</strong>
                {quickText.trim() !== '' && guardBadge(quickOutcome && quickOutcome.ok ? quickOutcome.failures : [], 'fb-quick-guard')}
                <span className="fbw-sp" />
              </div>
              {quickBusy && (
                <div style={{ marginBottom: 8 }}>
                  <ProgressNote
                    label={channel === 'ai'
                      ? `生成中：AI 正在写（${aiProfile?.role ?? ''} · ${aiProfile?.model ?? ''}）…`
                      : '生成中：按离线模板拼写…'}
                    testid="fb-quick-progress"
                  />
                </div>
              )}
              <textarea
                className="input fbw-out-body"
                data-testid="fb-quick-result-text"
                value={quickText}
                rows={7}
                placeholder="生成后在这里编辑"
                onChange={(e) => setQuickText(e.target.value)}
                style={{ width: '100%' }}
              />
              {quickOutcome && quickOutcome.ok && quickOutcome.failures.length > 0 && (
                <div className="fbw-hit-list" data-testid="fb-quick-hit-list">
                  {quickOutcome.failures.map((f) => <div key={`${f.rule}-${f.detail}`}>⚠ {f.detail}</div>)}
                </div>
              )}
              <div className="fbw-row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
                <button className="btn" data-testid="fb-quick-copy" onClick={() => void copyText(quickText)}>复制</button>
                <button
                  className="btn"
                  data-testid="fb-quick-reroll"
                  disabled={channel !== 'ai' || quickBusy || quickText.trim() === ''}
                  title={channel === 'ai' ? '重新生成一版' : '离线档为固定插值，换一版结果相同'}
                  onClick={() => void runQuickGenerate()}
                >
                  {quickBusy ? '生成中…' : '换一版'}
                </button>
                <span className="fbw-sp" />
                <button
                  className="btn btn-primary"
                  data-testid="fb-quick-save"
                  disabled={quickText.trim() === ''}
                  onClick={() => requestSave(
                    quickOutcome && quickOutcome.ok ? quickOutcome.failures : [],
                    saveQuickRecord,
                  )}
                >
                  保存记录
                </button>
              </div>
              {quickText.trim() === '' && (
                <div className="fbw-row" style={{ marginTop: 10 }}>
                  <button className="btn btn-primary" data-testid="fb-quick-generate" disabled={quickBusy} onClick={() => void runQuickGenerate()}>
                    {quickBusy ? '生成中…' : '生成反馈'}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ============ ② 班级批量 ============ */}
      {tab === 'batch' && (
        <div>
          {draftBanner && (
            <div className="notice notice-warm" data-testid="fb-batch-draft-banner" style={{ marginBottom: 12 }}>
              已恢复上次未保存的草稿（{formatTime(draftBanner)}）
              <button
                className="btn btn-sm"
                data-testid="fb-batch-draft-discard"
                style={{ marginLeft: 10 }}
                onClick={() => {
                  window.localStorage.removeItem(BATCH_DRAFT_KEY);
                  setDraftBanner(null);
                  setCards([]);
                  setRows({});
                  setBatchContent('');
                  setBatchHomework('');
                  setMessage({ type: 'success', text: '已丢弃草稿' });
                }}
              >
                丢弃草稿
              </button>
            </div>
          )}

          <div className="fbw-card fbw-bt-config" style={{ marginBottom: 14 }}>
            <div className="fbw-grid2">
              <div>
                <Field label="班级">
                  <select className="select" data-testid="fb-batch-class" value={classId} onChange={(e) => setClassId(e.target.value)} style={{ width: '100%', padding: '0.3rem' }}>
                    <option value="">选择班级…</option>
                    {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </Field>
                <Field label="课程主题（可选）">
                  <input className="input" data-testid="fb-batch-topic" value={batchTopic} onChange={(e) => setBatchTopic(e.target.value)} style={{ width: '100%', padding: '0.3rem' }} />
                </Field>
                <Field label="课堂内容（必填）">
                  <textarea className="input" data-testid="fb-batch-content" rows={2} value={batchContent} onChange={(e) => setBatchContent(e.target.value)} style={{ width: '100%', padding: '0.3rem' }} />
                </Field>
                <Field label="课后任务（可选）">
                  <textarea className="input" data-testid="fb-batch-homework" rows={2} value={batchHomework} onChange={(e) => setBatchHomework(e.target.value)} style={{ width: '100%', padding: '0.3rem' }} />
                </Field>
              </div>
              <div>
                <Field label="关联考试（可选）">
                  <select
                    className="select"
                    data-testid="fb-batch-exam"
                    value={examId}
                    onChange={(e) => {
                      const next = e.target.value;
                      setExamId(next);
                      if (next) void fillScoresFromExam(next);
                    }}
                    style={{ width: '100%', padding: '0.3rem' }}
                  >
                    <option value="">不带入成绩</option>
                    {exams.map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}
                  </select>
                </Field>
              </div>
            </div>
          </div>

          {classId && (
            <div className="fbw-card" style={{ marginBottom: 14, padding: '8px 6px' }}>
              <div className="fbw-row" style={{ padding: '0 10px 8px' }}>
                <strong>学生名单（{selectedStudents().length}/{students.length}）</strong>
                <button className="btn btn-sm" data-testid="fb-batch-select-all" onClick={() => setRows((prev) => Object.fromEntries(students.map((s) => [s.id, { ...(prev[s.id] ?? { score: '', note: '', tags: [], extras: [] }), selected: true }])))}>全选</button>
                <button className="btn btn-sm" onClick={() => setRows((prev) => Object.fromEntries(students.map((s) => [s.id, { ...(prev[s.id] ?? { score: '', note: '', tags: [], extras: [] }), selected: false }])))}>清空</button>
              </div>
              {students.length === 0 ? (
                <p className="fbw-muted" style={{ padding: '0 10px' }}>该班暂无在读学生（先到学生管理页建档/分班）</p>
              ) : (
                <>
                  <div className="fbw-stu-head">
                    <span>选</span><span>学生</span><span>成绩（可改）</span><span>课堂表现（逐人点选）</span><span>个别备注</span>
                  </div>
                  {students.map((student) => {
                    const row = rows[student.id] ?? { selected: true, score: '', note: '', tags: [], extras: [] };
                    const patch = (next: Partial<BatchRowState>) => setRows((prev) => ({ ...prev, [student.id]: { ...row, ...next } }));
                    return (
                      <div key={student.id} className="fbw-stu" data-testid={`fb-batch-row-${student.id}`}>
                        <span>
                          <input
                            type="checkbox"
                            data-testid={`fb-batch-student-${student.id}`}
                            checked={row.selected}
                            onChange={(e) => patch({ selected: e.target.checked })}
                          />
                        </span>
                        <span className="name">{student.name}</span>
                        <span className="fbw-row">
                          <input
                            type="text"
                            className="input fbw-score-input"
                            data-testid={`fb-batch-score-${student.id}`}
                            value={row.score}
                            onChange={(e) => patch({ score: e.target.value })}
                          />
                          <span className="fbw-muted">分</span>
                        </span>
                        <span className="fbw-chips">
                          {allTags.map((tag) => (
                            <span
                              key={tag.label}
                              data-testid={`fb-batch-perf-${student.id}-${tag.label}`}
                              className={row.tags.includes(tag.label) ? `fbw-chip on-${tag.tone}` : 'fbw-chip'}
                              onClick={() => patch({ tags: toggle(row.tags, tag.label, !row.tags.includes(tag.label)) })}
                            >
                              {tag.label}
                            </span>
                          ))}
                          {(row.extras ?? []).map((text, index) => (
                            <span key={`${text}-${index}`} className="fbw-chip on fbw-extra" data-testid={`fb-batch-extra-${student.id}-${index}`}>
                              {text}
                              <button type="button" data-testid={`fb-batch-extra-del-${student.id}-${index}`} aria-label={`删除「${text}」`} onClick={() => removeExtra(index, student.id)}>
                                ×
                              </button>
                            </span>
                          ))}
                          {extraFor === student.id ? (
                            <span className="fbw-chip fbw-chip-custom">
                              ＋<input
                                data-testid={`fb-batch-extra-input-${student.id}`}
                                autoFocus
                                placeholder=""
                                onKeyDown={(e) => {
                                  if (e.key !== 'Enter') return;
                                  e.preventDefault();
                                  addExtra(e.currentTarget.value, student.id);
                                  setExtraFor(null);
                                }}
                              />
                            </span>
                          ) : (
                            <span
                              className="fbw-chip fbw-chip-custom"
                              data-testid={`fb-batch-extra-add-${student.id}`}
                              onClick={() => setExtraFor(student.id)}
                            >
                              ＋其他表现
                            </span>
                          )}
                        </span>
                        <span>
                          <input
                            type="text"
                            className="input"
                            data-testid={`fb-batch-note-${student.id}`}
                            value={row.note}
                            placeholder="可选"
                            onChange={(e) => patch({ note: e.target.value })}
                            style={{ width: '100%' }}
                          />
                        </span>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          )}

          {styleEditor('batch')}

          {progress && (
            <div style={{ marginTop: 12 }}>
              <ProgressNote label={`正在生成（${progress.index}/${progress.total}）…`} testid="fb-batch-progress" />
            </div>
          )}

          {cards.length > 0 && (
            <div className="fbw-cards" style={{ marginTop: 14 }}>
              {cards.map((card) => (
                <div
                  key={card.studentId}
                  className={card.status === 'done' && card.failures.length > 0 ? 'fbw-card fbw-fb-card warn' : 'fbw-card fbw-fb-card'}
                  data-testid={`fb-batch-card-${card.studentId}`}
                >
                  <div className="fh">
                    <span className="n">{card.studentName}</span>
                    {card.status === 'generating' && <span className="fbw-muted" data-testid={`fb-batch-card-status-${card.studentId}`}>生成中…</span>}
                    {card.status === 'pending' && <span className="fbw-muted" data-testid={`fb-batch-card-status-${card.studentId}`}>排队中</span>}
                    {card.status === 'failed' && <span className="fbw-badge quick" data-testid={`fb-batch-card-status-${card.studentId}`}>生成失败</span>}
                    {card.status === 'done' && guardBadge(card.failures, `fb-batch-card-guard-${card.studentId}`)}
                  </div>
                  {card.status === 'failed' ? (
                    <div className="fbw-hit-list" data-testid={`fb-batch-card-error-${card.studentId}`}>
                      {card.error}
                      <button className="btn btn-sm" style={{ marginLeft: 8 }} data-testid={`fb-batch-card-retry-${card.studentId}`} onClick={() => void generateOne(students.find((s) => s.id === card.studentId)!, rows[card.studentId] ?? { selected: true, score: '', note: '', tags: [], extras: [] })}>
                        重试
                      </button>
                    </div>
                  ) : (
                    <textarea
                      data-testid={`fb-batch-card-text-${card.studentId}`}
                      value={card.text}
                      rows={5}
                      disabled={card.status !== 'done'}
                      onChange={(e) => setCards((prev) => prev.map((c) => (c.studentId === card.studentId ? { ...c, text: e.target.value } : c)))}
                    />
                  )}
                  {card.status === 'done' && card.failures.length > 0 && (
                    <div className="fbw-hit-list" data-testid={`fb-batch-card-hit-${card.studentId}`}>
                      {card.failures.map((f) => <div key={`${card.studentId}-${f.rule}-${f.detail}`}>⚠ {f.detail}</div>)}
                    </div>
                  )}
                  <div className="fa">
                    <button className="btn btn-sm" data-testid={`fb-batch-card-copy-${card.studentId}`} disabled={card.text.trim() === ''} onClick={() => void copyText(card.text)}>复制</button>
                    <button
                      className="btn btn-sm"
                      data-testid={`fb-batch-card-reroll-${card.studentId}`}
                      disabled={channel !== 'ai' || batchBusy || card.status === 'generating'}
                      title={channel === 'ai' ? '重新生成这一位' : '离线档为固定插值，换一版结果相同'}
                      onClick={() => void generateOne(students.find((s) => s.id === card.studentId)!, rows[card.studentId] ?? { selected: true, score: '', note: '', tags: [], extras: [] })}
                    >
                      换一版
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="fbw-card fbw-bar">
            <span className="fbw-muted" data-testid="fb-batch-summary">
              已生成 <b>{batchDoneCards.length}</b> / {selectedStudents().length} 人
              {batchFailures.length > 0 ? <> · <b>{batchFailures.length}</b> 条需核对</> : null}
            </span>
            <span className="fbw-sp" />
            <button className="btn" data-testid="fb-batch-generate" disabled={batchBusy} onClick={() => void runBatchGenerate()}>
              {batchBusy ? '生成中…' : '生成反馈'}
            </button>
            <button
              className="btn"
              data-testid="fb-batch-copy-all"
              disabled={batchDoneCards.length === 0}
              onClick={() => void copyText(exportTargets().map((t) => `【${t.name}】\n${t.text}`).join('\n\n————————\n\n'))}
            >
              全部复制
            </button>
            <button
              className="btn btn-primary"
              data-testid="fb-batch-save"
              disabled={batchDoneCards.length === 0}
              onClick={() => requestSave(batchFailures, saveBatchRecords)}
            >
              保存记录（{batchDoneCards.length}）
            </button>
          </div>
        </div>
      )}

      {/* ============ ③ 反馈记录 ============ */}
      {tab === 'records' && (
        <div>
          <div className="fbw-card fbw-rc-tools">
            <input
              className="input"
              data-testid="fb-records-search"
              placeholder="搜索学生姓名…"
              value={recordsKeyword}
              onChange={(e) => setRecordsKeyword(e.target.value)}
            />
            <div className="fbw-chips">
              <span
                data-testid="fb-records-filter-all"
                className={recordsClassId === '' ? 'fbw-chip on' : 'fbw-chip'}
                onClick={() => setRecordsClassId('')}
              >
                全部
              </span>
              {classes.map((c) => (
                <span
                  key={c.id}
                  data-testid={`fb-records-filter-${c.id}`}
                  className={recordsClassId === c.id ? 'fbw-chip on' : 'fbw-chip'}
                  onClick={() => setRecordsClassId(c.id)}
                >
                  {c.name}
                </span>
              ))}
            </div>
            <span className="fbw-sp" />
            <span className="fbw-muted" data-testid="fb-records-count">共 {records.length} 条</span>
          </div>

          <div className="fbw-card" style={{ padding: '6px 4px' }}>
            <div className="fbw-rec-row head">
              <span>时间</span><span>学生</span><span className="cls">班级</span><span>内容摘要</span><span className="ops">操作</span>
            </div>
            {records.length === 0 ? (
              <p className="fbw-muted" style={{ padding: '10px 12px' }}>暂无记录</p>
            ) : records.map((record, index) => (
              <div key={record.id} className="fbw-rec-row" data-testid={`fb-record-row-${index}`}>
                <span className="fbw-muted">{formatTime(record.createdAt)}</span>
                <span>
                  {record.studentName}
                  {record.studentId === null && <> <span className="fbw-badge unlinked" data-testid={`fb-record-unlinked-${index}`}>未关联</span></>}
                </span>
                <span className="cls fbw-muted">{classNameOf(record.classId)}</span>
                <span className="sum">
                  {record.body.slice(0, 40)}{record.body.length > 40 ? '…' : ''}
                  {record.channel === 'ai' ? '（AI 润色）' : ''}
                </span>
                <span className="ops fbw-row">
                  <button className="btn btn-sm" data-testid={`fb-record-view-${index}`} onClick={() => setRecordDetail(record)}>查看</button>
                  <button className="btn btn-sm" data-testid={`fb-record-copy-${index}`} onClick={() => void copyText(record.body)}>复制</button>
                  <ConfirmButton
                    label="删除"
                    confirmLabel="确认删除？"
                    testid={`fb-record-delete-${index}`}
                    onConfirm={() => void deleteRecord(record)}
                  />
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ============ ④ 反馈设置（主从：左侧选中一条 → 右侧只展开它；第三/四轮返工） ============ */}
      {tab === 'settings' && (
        <div className="fbw-tp">
          {/* 左：条目（提示词模板 / 离线模板 逐条列；课堂表现标签只留一个入口，内容在右侧） */}
          <div className="fbw-card fbw-tp-list">
            <h4>提示词模板</h4>
            {promptTemplates.map((t) => (
              <div
                key={t.id}
                data-testid={`fb-prompt-item-${t.id}`}
                className={settingsSelEff.kind === 'prompt' && settingsSelEff.id === t.id ? 'fbw-tp-item on' : 'fbw-tp-item'}
                onClick={() => selectSettings('prompt', t.id)}
              >
                {t.name}<span className="tag">{t.isBuiltin ? '内置' : '自定义'}</span>
              </div>
            ))}
            <div
              className={settingsSelEff.kind === 'prompt' && settingsSelEff.id === null ? 'fbw-tp-item on' : 'fbw-tp-item'}
              data-testid="fb-prompt-new"
              style={{ justifyContent: 'center', color: 'var(--ink-3)' }}
              onClick={() => selectSettings('prompt', null)}
            >
              ＋ 新建提示词模板
            </div>

            <h4 style={{ marginTop: 14 }}>离线模板</h4>
            {offlineTemplates.map((t) => (
              <div
                key={t.id}
                data-testid={`feedback-template-row-${t.id}`}
                className={settingsSelEff.kind === 'offline' && settingsSelEff.id === t.id ? 'fbw-tp-item on' : 'fbw-tp-item'}
                onClick={() => selectSettings('offline', t.id)}
              >
                {t.name}<span className="tag">{t.isBuiltin ? '内置' : '自定义'}</span>
              </div>
            ))}
            <div
              className={settingsSelEff.kind === 'offline' && settingsSelEff.id === null ? 'fbw-tp-item on' : 'fbw-tp-item'}
              data-testid="feedback-template-create-btn"
              style={{ justifyContent: 'center', color: 'var(--ink-3)' }}
              onClick={() => selectSettings('offline', null)}
            >
              ＋ 新建离线模板
            </div>

            <h4 style={{ marginTop: 14 }}>课堂表现标签</h4>
            <div
              data-testid="fb-settings-tags-entry"
              className={settingsSelEff.kind === 'tag' ? 'fbw-tp-item on' : 'fbw-tp-item'}
              onClick={() => selectSettings('tag', null)}
            >
              课堂表现标签（{allTags.length}）
            </div>
          </div>

          {/* 右：只展开左侧选中的那一类内容 */}
          <div className="fbw-tp-edit">
            {settingsSelEff.kind === 'prompt' && (() => {
              const isNew = settingsSelEff.id === null;
              const name = isNew ? newPromptDraft.name : tplName;
              const body = isNew ? newPromptDraft.body : tplBody;
              const readOnly = isNew ? false : Boolean(currentTpl?.isBuiltin);
              const setName = (v: string) => {
                if (isNew) setNewPromptDraft({ ...newPromptDraft, name: v });
                else editTplName(v);
              };
              const setBody = (v: string) => {
                if (isNew) setNewPromptDraft({ ...newPromptDraft, body: v });
                else editTplBody(v);
              };
              return (
                <div className="fbw-card" data-testid="fb-settings-panel-prompt">
                  <h3>{isNew ? '新建提示词模板' : `提示词模板：${currentTpl?.name ?? ''}`}</h3>
                  <Field label={currentTpl?.isBuiltin && !isNew ? '模板名称（内置只读）' : '模板名称'}>
                    <input
                      className="input"
                      data-testid="fb-prompt-name"
                      value={name}
                      readOnly={readOnly}
                      onChange={(e) => setName(e.target.value)}
                      style={{ width: '100%', padding: '0.3rem' }}
                    />
                  </Field>
                  <div className="fbw-vars" data-testid="fb-prompt-vars">
                    可用变量：<br />
                    事实：{FEEDBACK_FACT_VARS.map((v) => <code key={v}>{`{${v}}`}</code>)}<br />
                    风格：{FEEDBACK_STYLE_VARS.map((v) => <code key={v}>{`{${v}}`}</code>)}
                  </div>
                  <Field label="提示词全文">
                    <textarea
                      data-testid="fb-prompt-body"
                      value={body}
                      readOnly={readOnly}
                      onChange={(e) => setBody(e.target.value)}
                    />
                  </Field>
                  <div className="fbw-row" style={{ flexWrap: 'wrap' }}>
                    {isNew ? (
                      <>
                        <span className="fbw-sp" />
                        <button className="btn btn-primary" data-testid="fb-prompt-create" onClick={() => void createPromptTemplate()}>新建</button>
                      </>
                    ) : (
                      <>
                        <button className="btn" data-testid="fb-prompt-export" onClick={() => void exportPromptTemplate()}>导出模板</button>
                        <button className="btn" data-testid="fb-prompt-import" onClick={() => void importPromptTemplate()}>导入…</button>
                        <span className="fbw-sp" />
                        {currentTpl?.isBuiltin ? (
                          <>
                            <span className="fbw-muted">内置只读</span>
                            <button className="btn btn-primary" data-testid="fb-prompt-save-as" onClick={() => void saveAsPromptTemplate()}>另存为我的模板</button>
                          </>
                        ) : (
                          <>
                            <button className="btn" data-testid="fb-prompt-delete" onClick={() => void deletePromptTemplate()}>删除</button>
                            <button className="btn btn-primary" data-testid="fb-prompt-save" onClick={() => void savePromptTemplate()}>保存</button>
                          </>
                        )}
                      </>
                    )}
                  </div>
                </div>
              );
            })()}

            {settingsSelEff.kind === 'offline' && (() => {
              const selected = settingsSelEff.id ? offlineTemplates.find((t) => t.id === settingsSelEff.id) : undefined;
              const isBuiltin = Boolean(selected?.isBuiltin);
              return (
                <div className="fbw-card" data-testid="fb-settings-panel-offline">
                  <h3>{selected ? `离线模板：${selected.name}` : '新建离线模板'}</h3>
                  <Field label="模板名称">
                    <input
                      className="input"
                      data-testid="feedback-template-name-input"
                      value={offlineDraft.name}
                      readOnly={isBuiltin}
                      onChange={(e) => setOfflineDraft({ ...offlineDraft, name: e.target.value })}
                      style={{ width: '100%', padding: '0.3rem' }}
                    />
                  </Field>
                  <Field label="模板正文">
                    <textarea
                      className="input"
                      data-testid="feedback-template-body-input"
                      value={offlineDraft.body}
                      readOnly={isBuiltin}
                      onChange={(e) => setOfflineDraft({ ...offlineDraft, body: e.target.value })}
                      rows={7}
                      style={{ width: '100%', padding: '0.3rem' }}
                    />
                  </Field>
                  {!isBuiltin && (
                    <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap', marginBottom: '0.6rem' }}>
                      {FEEDBACK_VARS.map((v) => (
                        <button
                          key={v}
                          data-testid={`feedback-var-${v}`}
                          onClick={() => insertOfflineVar(v, setOfflineDraft, offlineDraft)}
                          style={{ fontSize: '0.8rem', padding: '0.1rem 0.4rem' }}
                        >
                          {v}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="fbw-row" style={{ flexWrap: 'wrap' }}>
                    {isBuiltin && selected ? (
                      <>
                        <span className="fbw-muted">内置只读</span>
                        <span className="fbw-sp" />
                        <button className="btn btn-primary" data-testid="fb-offline-save-as" onClick={() => void saveAsOfflineTemplate(selected)}>另存为我的模板</button>
                      </>
                    ) : (
                      <>
                        {selected && (
                          <ConfirmButton
                            label="删除"
                            confirmLabel="确认删除？"
                            testid="fb-offline-delete"
                            onConfirm={() => void removeOfflineTemplate(selected)}
                          />
                        )}
                        <span className="fbw-sp" />
                        <button className="btn btn-primary" data-testid="feedback-template-save-btn" onClick={() => void saveOfflineTemplate()}>
                          {selected ? '保存' : '新建'}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })()}

            {settingsSelEff.kind === 'tag' && (
              <div className="fbw-card" data-testid="fb-settings-panel-tag">
                <h3>课堂表现标签</h3>

                <div className="fbw-row" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
                  <input
                    className="input"
                    data-testid="fb-tag-new-input"
                    value={newTagLabel}
                    placeholder=""
                    onChange={(e) => setNewTagLabel(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter') return;
                      e.preventDefault();
                      addLibraryTag(newTagLabel, newTagTone);
                      setNewTagLabel('');
                    }}
                    style={{ flex: 1, minWidth: 200, padding: '0.3rem' }}
                  />
                  <span
                    data-testid="fb-tag-new-tone-pos"
                    className={newTagTone === 'pos' ? 'fbw-chip on-pos' : 'fbw-chip'}
                    onClick={() => setNewTagTone('pos')}
                  >
                    正面
                  </span>
                  <span
                    data-testid="fb-tag-new-tone-neg"
                    className={newTagTone === 'neg' ? 'fbw-chip on-neg' : 'fbw-chip'}
                    onClick={() => setNewTagTone('neg')}
                  >
                    待改进
                  </span>
                  <button
                    className="btn btn-primary"
                    data-testid="fb-tag-new-add"
                    disabled={newTagLabel.trim() === ''}
                    onClick={() => {
                      addLibraryTag(newTagLabel, newTagTone);
                      setNewTagLabel('');
                    }}
                  >
                    添加标签
                  </button>
                </div>

                {allTags.map((tag) => {
                  const isBuiltin = PERFORMANCE_TAGS.some((b) => b.label === tag.label);
                  const editing = tagDraft.original === tag.label;
                  if (editing) {
                    return (
                      <div key={tag.label} className="fbw-tag-row editing" data-testid={`fb-tag-edit-row-${tag.label}`}>
                        <input
                          className="input"
                          data-testid="fb-tag-edit-name"
                          value={tagDraft.label}
                          onChange={(e) => setTagDraft({ ...tagDraft, label: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key !== 'Enter') return;
                            e.preventDefault();
                            renameLibraryTag(tagDraft.original ?? tagDraft.label, tagDraft.label, tagDraft.tone);
                          }}
                          style={{ flex: 1, minWidth: 160, padding: '0.25rem 0.4rem' }}
                        />
                        <span
                          data-testid="fb-tag-edit-tone-pos"
                          className={tagDraft.tone === 'pos' ? 'fbw-chip on-pos' : 'fbw-chip'}
                          onClick={() => setTagDraft({ ...tagDraft, tone: 'pos' })}
                        >
                          正面
                        </span>
                        <span
                          data-testid="fb-tag-edit-tone-neg"
                          className={tagDraft.tone === 'neg' ? 'fbw-chip on-neg' : 'fbw-chip'}
                          onClick={() => setTagDraft({ ...tagDraft, tone: 'neg' })}
                        >
                          待改进
                        </span>
                        <button className="btn btn-sm" data-testid="fb-tag-edit-cancel" onClick={() => setTagDraft({ original: null, label: '', tone: 'pos' })}>取消</button>
                        <button
                          className="btn btn-sm btn-primary"
                          data-testid="fb-tag-edit-save"
                          onClick={() => renameLibraryTag(tagDraft.original ?? tagDraft.label, tagDraft.label, tagDraft.tone)}
                        >
                          保存
                        </button>
                      </div>
                    );
                  }
                  return (
                    <div key={tag.label} className="fbw-tag-row" data-testid={`fb-tag-row-${tag.label}`}>
                      <span className={tag.tone === 'neg' ? 'tag tag-brick' : 'tag tag-green'}>{tag.tone === 'neg' ? '待改进' : '正面'}</span>
                      <span style={{ fontWeight: 600 }}>{tag.label}</span>
                      <span className="tag">{isBuiltin ? '内置' : '自定义'}</span>
                      <span className="fbw-sp" />
                      {isBuiltin ? (
                        <span className="fbw-muted">不可修改</span>
                      ) : (
                        <>
                          <button className="btn btn-sm" data-testid={`fb-tag-edit-${tag.label}`} onClick={() => setTagDraft({ original: tag.label, label: tag.label, tone: tag.tone })}>
                            编辑
                          </button>
                          <ConfirmButton
                            label="删除"
                            confirmLabel="确认删除？"
                            testid={`fb-tag-del-${tag.label}`}
                            onConfirm={() => removeLibraryTag(tag.label)}
                          />
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 守卫不硬拦：保存前提示 N 条待核对（应用内弹层，禁 window.confirm） */}
      {pendingSave && (
        <Modal title={`有 ${pendingSave.failures.length} 条待核对`} onClose={() => setPendingSave(null)}>
          <div style={{ minWidth: 420 }} data-testid="fb-guard-save-modal">
            <p style={{ marginTop: 0 }}>红线检查发现 {pendingSave.failures.length} 条待核对，建议核对后再发；也可以直接保存。</p>
            <div className="fbw-hit-list">
              {pendingSave.failures.map((f) => <div key={`${f.rule}-${f.detail}`}>⚠ {f.detail}</div>)}
            </div>
            <div className="fbw-row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
              <button className="btn" data-testid="fb-guard-save-cancel" onClick={() => setPendingSave(null)}>返回修改</button>
              <button
                className="btn btn-primary"
                data-testid="fb-guard-save-anyway"
                onClick={() => {
                  const run = pendingSave.run;
                  setPendingSave(null);
                  run();
                }}
              >
                仍然保存
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* 记录详情 */}
      {recordDetail && (
        <Modal title={`反馈记录 · ${recordDetail.studentName}`} onClose={() => setRecordDetail(null)}>
          <div style={{ minWidth: 520 }} data-testid="fb-record-detail">
            <p className="fbw-muted" style={{ marginTop: 0 }}>
              {formatTime(recordDetail.createdAt)} · {recordDetail.channel === 'ai' ? 'AI 润色' : '离线模板'} ·
              {' '}{classNameOf(recordDetail.classId)}
              {recordDetail.studentId === null ? ' · 未关联学生档案' : ''}
            </p>
            <div className="fbw-out-body" style={{ whiteSpace: 'pre-wrap' }}>{recordDetail.body}</div>
            <details style={{ marginTop: 10 }}>
              <summary className="fbw-muted">填写内容快照与提示词</summary>
              <pre className="fbw-muted" style={{ whiteSpace: 'pre-wrap' }}>{recordDetail.inputJson}</pre>
              {recordDetail.promptSnapshot && <pre className="fbw-muted" style={{ whiteSpace: 'pre-wrap' }}>{recordDetail.promptSnapshot}</pre>}
            </details>
            <div className="fbw-row" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
              <button className="btn" onClick={() => void copyText(recordDetail.body)}>复制正文</button>
              <button className="btn" onClick={() => setRecordDetail(null)}>关闭</button>
            </div>
          </div>
        </Modal>
      )}

    </div>
  );
}

/** 对外入口：页面级错误边界包一层（见 FeedbackPageErrorBoundary 的说明） */
export function FeedbackPage(props: { svc?: ExtPageServices; ai?: FeedbackAiAccess }) {
  return (
    <FeedbackPageErrorBoundary>
      <FeedbackPageInner {...props} />
    </FeedbackPageErrorBoundary>
  );
}
