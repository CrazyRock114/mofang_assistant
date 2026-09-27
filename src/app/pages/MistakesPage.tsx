// 0026 P1-P4：错题本页（#/mistakes）——两栏（左控件栏 + 右试题栏）+ 题库式题卡 + 右侧吸附悬浮试题篮。
//
// 布局（目检返工版）：
//   左控件栏（筛选 + 班级错题集 + 成册）｜右试题栏（题库式题卡，占满剩余宽度）
//   试题篮 = 右侧吸附悬浮图标（点击展开抽屉；组件在 components/FloatingBasket，题库后续可复用同形态）
//
// 一张题卡（与题库同款：显示完整题面，公式/图/选项随内容流）：
//   ┌ 左窄列：勾选 / 序号 / 错误人次「错 7/12 人」/ 学生状态分布（未掌握 N·订正过 N·已掌握 N）
//   └ 主区：完整题面 + 元信息（学科·题型·难度·最近错于）+ 右下角操作（查看详情 / 加入试题篮 | 移出试题篮）
//
// 口径：
// - 红黄绿三态是**学生**对这道题的状态（0025：stage 在 mistakes 行上，一行=一名学生一道题）；
//   故题卡上显示的是「几名未掌握 / 几名订正过 / 几名已掌握」，不是"这道题是红色的"。
// - 四道聚合口：总数口（人次降序 + 出现哪些题）+ 红/黄/绿三态口（各状态人数），合并见 mergeStageBreakdown。
// - 入篮是显式动作（目检：直接单击入篮不妥）——卡片右下角按钮，加入后按钮变「移出试题篮」。
// - 筛选/时间窗/摘要/排序仍全部来自 0025，本页不另算人次。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ClassInfo, Mistake, MistakeAggregateRow, MistakeStage, PaperLayoutConfig, PaperQuestionRef,
  PaperSummary, Question, Student,
} from '../../shared/contracts/bank-types.js';
import {
  ConfirmButton, EmptyState, MessageBanner, Modal, PageHeader, StageLamp, STAGE_LABEL,
  renderQuestionHtml, useExtPageServices,
  type ExtPageServices, type PageMessage,
} from './ExtUi.js';
import { FloatingBasket } from '../components/FloatingBasket.js';
import { questionCardHtml } from '../components/BankBrowser.js';
import {
  MISTAKE_PAGE_SIZE, MISTAKE_TOP_N_DEFAULT, STUDENT_STAGE_LABEL,
  classMistakeTitle, clampPage, describeScopeTotal, describeWrongCount, difficultyLabel, inScope, localDate,
  mergeStageBreakdown, mergeSubjects, mistakeBookHeaderLines, mistakeBookTitle, normalizeTopN, pageCount,
  pageSlice, pickDefaultClassId, planAddToBasket, scopeMistakeIds, studentStageEntries, toAggregateFilter,
  topN, weekWindow,
  type MistakeScope, type MistakeWindow, type StudentStageCounts,
} from './mistake-loop.js';
// 0055（R-044）：学科筛选默认取设置页偏好（本页无学段选择器——:39 STAGE_OPTIONS 是错题三态，勿接学段）
import { readDefaultStageSubject } from '../state/default-stage-subject.js';

const STAGE_OPTIONS: MistakeStage[] = ['red', 'yellow', 'green'];
const STAGE_SHORT: Record<MistakeStage, string> = { red: '红', yellow: '黄', green: '绿' };
/** 试题篮持久化键（渲染层 localStorage：篮 id 复用 0011 多篮资产，不新增通道） */
const BASKET_KEY = 'mofang.mistakeBasketId';
const CLASS_KEY = 'mofang.mistakeClassId';
/** 缺省卷名（≡ 试题篮：同 papers 模型，出现在组卷列表「处理中」区） */
const BASKET_TITLE = '错题篮（试题篮）';
const NEW_BASKET_VALUE = '__new__';

interface BasketItem {
  questionId: string;
  summary: string;
}

interface DetailState {
  row: MistakeAggregateRow;
  mistakes: Mistake[];
  loading: boolean;
}

/** 错题快照正文（0003 U10 哲学：原题被改/软删后仍可读——读 mistake.snapshot，不读实时题库） */
function SnapshotBody({ mistake }: { mistake: Mistake }) {
  const snap = mistake.snapshot;
  const optionsHtml = snap.options.length > 0 ? (
    <div style={{ margin: '0.5rem 0' }}>
      {snap.options.map((o) => (
        <div key={o.label} style={{ display: 'flex', gap: '0.4rem' }}>
          <strong>{o.label}.</strong>
          <span dangerouslySetInnerHTML={{ __html: renderQuestionHtml(o.html) }} />
        </div>
      ))}
    </div>
  ) : null;

  return (
    <div className="question-content" data-testid="mistake-snapshot">
      <div dangerouslySetInnerHTML={{ __html: renderQuestionHtml(snap.stemHtml) }} />
      {optionsHtml}
      {(snap.answer || snap.analysis) && (
        <details style={{ marginTop: '0.5rem' }}>
          <summary style={{ cursor: 'pointer', color: 'var(--ink-2)' }}>答案 / 解析</summary>
          {snap.answer && (
            <div className="answer-field" style={{ marginTop: '0.4rem' }}>
              <strong>答案：</strong>
              <span dangerouslySetInnerHTML={{ __html: renderQuestionHtml(snap.answer) }} />
            </div>
          )}
          {snap.analysis && (
            <div className="analysis-field" style={{ marginTop: '0.4rem' }}>
              <strong>解析：</strong>
              <span dangerouslySetInnerHTML={{ __html: renderQuestionHtml(snap.analysis) }} />
            </div>
          )}
        </details>
      )}
    </div>
  );
}

/** 按生明细行：三色灯 + 状态灯切换 + 状态选择 + 备注（失焦即存）+ 删除（两步确认）——0003 能力原样保留 */
function DetailStudentRow({
  svc, mistake, studentName, onChanged, onMessage,
}: {
  svc: ExtPageServices;
  mistake: Mistake;
  studentName: string;
  onChanged: () => void;
  onMessage: (m: PageMessage) => void;
}) {
  const [noteDraft, setNoteDraft] = useState(mistake.note ?? '');
  const [noteDirty, setNoteDirty] = useState(false);

  const run = async (action: () => Promise<unknown>, successText: string) => {
    try {
      await action();
      onMessage({ type: 'success', text: successText });
      onChanged();
    } catch (err) {
      onMessage({ type: 'error', text: `操作失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  return (
    <div
      data-testid={`mistake-detail-row-${studentName}`}
      data-stage={mistake.stage}
      className="mini-m-row"
      style={{ gap: '0.5rem' }}
    >
      <StageLamp stage={mistake.stage} />
      <span className={`st-pill ${mistake.stage}`}>{STAGE_SHORT[mistake.stage]}</span>
      <strong style={{ flex: '0 0 auto' }}>{studentName}</strong>
      <span style={{ color: 'var(--ink-3)', flex: '0 0 auto' }}>{STUDENT_STAGE_LABEL[mistake.stage]} · 最近错于 {localDate(new Date(mistake.occurredAt))}</span>
      <button
        className="btn btn-sm"
        data-testid={`mistake-cycle-btn-${studentName}`}
        onClick={() => void run(() => svc.ext.mistake.cycleStage(mistake.id), '状态灯已切换')}
      >
        状态灯切换
      </button>
      <select
        className="select"
        data-testid={`mistake-stage-select-${studentName}`}
        value={mistake.stage}
        onChange={(e) => void run(() => svc.ext.mistake.setStage(mistake.id, e.target.value as MistakeStage), '状态已更新')}
        style={{ width: '72px', flex: '0 0 auto' }}
      >
        {STAGE_OPTIONS.map((st) => <option key={st} value={st}>{STAGE_SHORT[st]}</option>)}
      </select>
      <input
        className="input"
        data-testid={`mistake-note-input-${studentName}`}
        placeholder="备注（掌握情况/订正记录）"
        value={noteDirty ? noteDraft : (mistake.note ?? '')}
        onChange={(e) => { setNoteDraft(e.target.value); setNoteDirty(true); }}
        style={{ flex: 1, minWidth: '120px' }}
      />
      <button
        className="btn btn-sm"
        data-testid={`mistake-note-save-btn-${studentName}`}
        disabled={!noteDirty}
        onClick={() => {
          setNoteDirty(false);
          void run(() => svc.ext.mistake.setNote(mistake.id, noteDraft), '备注已保存');
        }}
      >
        保存备注
      </button>
      <ConfirmButton
        label="删除"
        confirmLabel="确认删除"
        testid={`mistake-delete-btn-${studentName}`}
        onConfirm={() => void run(() => svc.ext.mistake.deleteMistake(mistake.id), '错题已删除（宁可多标，多出的在此人工删）')}
      />
    </div>
  );
}

/** 一张题卡（题库式：左窄列状态 + 主区完整题面 + 右下角操作） */
interface MistakeCardProps {
  row: MistakeAggregateRow;
  no: number;
  counts: StudentStageCounts | undefined;
  scopeCount: number;
  question: Question | undefined;
  selected: boolean;
  active: boolean;
  inBasket: boolean;
  onToggleSelected: (questionId: string) => void;
  onOpenDetail: (row: MistakeAggregateRow) => void;
  onAdd: (questionId: string) => void;
  onRemove: (questionId: string) => void;
}

function MistakeCard({
  row, no, counts, scopeCount, question, selected, active, inBasket,
  onToggleSelected, onOpenDetail, onAdd, onRemove,
}: MistakeCardProps) {
  const stageEntries = counts ? studentStageEntries(counts) : [];
  const typeText = row.questionType ?? '—';
  const difficultyText = difficultyLabel(row.difficulty) ?? '—';

  return (
    <li
      data-testid={`mistake-card-${row.questionId}`}
      data-wrong-count={row.wrongCount}
      data-selected={selected}
      data-active={active}
      data-in-basket={inBasket}
      className={`m-card-row${active ? ' active' : ''}${selected ? ' selected' : ''}`}
    >
      {/* 左窄列：勾选 + 序号 + 错误人次 + 学生状态分布 */}
      <div className="m-card-side">
        <input
          type="checkbox"
          data-testid={`mistake-select-${row.questionId}`}
          checked={selected}
          onChange={() => onToggleSelected(row.questionId)}
        />
        <span className="m-card-no">{no}.</span>
        <strong
          data-testid={`mistake-wrongcount-${row.questionId}`}
          className={`wrong-count${row.wrongCount > 1 ? ' hot' : ''}`}
        >
          {describeWrongCount(row.wrongCount, scopeCount)}
        </strong>
        <ul
          className="m-stage-chips"
          data-testid={`mistake-stages-${row.questionId}`}
          title="红黄绿是学生对这道题的掌握状态（红=未掌握，黄=订正过，绿=已掌握）"
        >
          {stageEntries.length === 0 ? (
            <li className="m-stage-chip none">—</li>
          ) : stageEntries.map((entry) => (
            <li key={entry.stage} className={`m-stage-chip ${entry.stage}`} data-stage={entry.stage}>
              {entry.label} {entry.count}
            </li>
          ))}
        </ul>
      </div>

      {/* 主区：完整题面（公式/图/选项随内容流，与题库同管线）+ 元信息 + 右下角操作 */}
      <div className="m-card-body">
        <div
          className="question-content"
          data-testid={`mistake-stem-${row.questionId}`}
          dangerouslySetInnerHTML={{ __html: question ? questionCardHtml(question) : renderQuestionHtml(row.stemSummary) }}
        />
        <div className="q-meta">
          <span className="tag tag-orange">{row.subject || '未标学科'}</span>
          <span className="tag">{typeText}</span>
          <span className="tag">{difficultyText}</span>
          <span className="m-meta-time">最近错于 {localDate(new Date(row.lastOccurredAt))}</span>
        </div>
        <div className="m-card-actions">
          <button
            className="btn btn-sm"
            data-testid={`mistake-detail-btn-${row.questionId}`}
            onClick={() => onOpenDetail(row)}
          >
            查看详情
          </button>
          {inBasket ? (
            <button
              className="btn btn-sm"
              data-testid={`mistake-basket-remove-${row.questionId}`}
              onClick={() => onRemove(row.questionId)}
            >
              移出试题篮
            </button>
          ) : (
            <button
              className="btn btn-primary btn-sm"
              data-testid={`mistake-basket-add-${row.questionId}`}
              onClick={() => onAdd(row.questionId)}
            >
              加入试题篮
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

export function MistakesPage({ services }: { services?: ExtPageServices }) {
  const svc = useExtPageServices(services);

  // ---------- 筛选态（默认本周；班级在班级列表载入后落「本班」） ----------
  const initialWindow = useMemo(() => weekWindow(new Date()), []);
  const [window_, setWindow] = useState<MistakeWindow>(initialWindow);
  const [classId, setClassId] = useState('');
  const [studentId, setStudentId] = useState('');
  const [stageFilter, setStageFilter] = useState<MistakeStage | ''>('');
  const [subjectFilter, setSubjectFilter] = useState('');
  const [subjectOptions, setSubjectOptions] = useState<string[]>([]);

  const [classes, setClasses] = useState<ClassInfo[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [members, setMembers] = useState<Student[]>([]);
  /** 就绪门（1）：班级列表已载入 → 默认班级（本班）已落定 */
  const [classReady, setClassReady] = useState(false);
  /** 就绪门（2）：已载入名单对应的班级 id（null=未载入）——按 classId 对齐，
   * 避免「上一态名单已就绪」在切班首帧被误判为就绪（会闪一屏未过滤数据） */
  const [membersForClass, setMembersForClass] = useState<string | null>(null);
  const [rows, setRows] = useState<MistakeAggregateRow[]>([]);
  const [stageCounts, setStageCounts] = useState<Map<string, StudentStageCounts>>(new Map());
  const [questions, setQuestions] = useState<Map<string, Question>>(new Map());
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<PageMessage | null>(null);

  const [selected, setSelected] = useState<string[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [detail, setDetail] = useState<DetailState | null>(null);

  const [basketId, setBasketId] = useState<string | null>(null);
  const [basketItems, setBasketItems] = useState<BasketItem[]>([]);
  const [basketTargets, setBasketTargets] = useState<PaperSummary[]>([]);
  const [mergeTarget, setMergeTarget] = useState(NEW_BASKET_VALUE);
  const [topNInput, setTopNInput] = useState(String(MISTAKE_TOP_N_DEFAULT));
  const [busy, setBusy] = useState(false);

  /** 统计口径：班级 → 其成员；未选班级 → 全部在册学生（分母「错 7/12 人」的 12） */
  const scope: MistakeScope = useMemo(() => ({
    ...(studentId ? { studentIds: [studentId] } : classId ? { studentIds: members.map((s) => s.id) } : {}),
    ...(stageFilter ? { stage: stageFilter } : {}),
    ...(subjectFilter ? { subject: subjectFilter } : {}),
    ...(window_.from ? { occurredFrom: window_.from } : {}),
    ...(window_.to ? { occurredTo: window_.to } : {}),
  }), [studentId, classId, members, stageFilter, subjectFilter, window_]);

  const scopeCount = studentId ? 1 : classId ? members.length : students.filter((s) => s.status === 'active').length;

  const studentName = useCallback(
    (id: string) => students.find((s) => s.id === id)?.name ?? id,
    [students],
  );

  // ---------- 载入：班级/学生（一次）+ 聚合行（筛选变更即重查，人次降序由 0025 保证） ----------

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [classList, allStudents] = await Promise.all([
          svc.ext.class.listClasses({ status: 'all' }),
          svc.ext.student.listStudents({ includeArchived: true }),
        ]);
        if (cancelled) return;
        setClasses(classList);
        setStudents(allStudents);
        setClassId((current) => current || pickDefaultClassId(classList, localStorage.getItem(CLASS_KEY) ?? ''));
      } catch (err) {
        if (!cancelled) setMessage({ type: 'error', text: `班级/学生加载失败：${err instanceof Error ? err.message : String(err)}` });
      } finally {
        if (!cancelled) setClassReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, [svc]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!classId) { setMembers([]); setMembersForClass(''); return; }
      setMembersForClass(null);
      try {
        const list = await svc.ext.student.listStudents({ classId, includeArchived: true });
        if (!cancelled) setMembers(list);
      } catch (err) {
        if (!cancelled) setMessage({ type: 'error', text: `班级名单加载失败：${err instanceof Error ? err.message : String(err)}` });
      } finally {
        if (!cancelled) setMembersForClass(classId);
      }
    })();
    return () => { cancelled = true; };
  }, [svc, classId]);

  useEffect(() => {
    localStorage.setItem(CLASS_KEY, classId);
  }, [classId]);

  /**
   * 拉取聚合行 + 学生状态分布 + 学科选项。
   * 四道聚合口：总数口（决定出现哪些题与人次降序）+ 红/黄/绿三态口（各状态人数）——
   * 三态是学生口径，逐题「未掌握 N/订正过 N/已掌握 N」由 mergeStageBreakdown 合并。
   * 不触碰 loading：入篮/批量后的刷新不得把列表打回加载态。
   */
  const refreshRows = useCallback(async () => {
    const filter = toAggregateFilter(scope);
    const baseFilter = toAggregateFilter({ ...scope, stage: undefined });
    const [list, red, yellow, green] = await Promise.all([
      // 列表本体吃完整筛选（含状态：选红就只列「有学生未掌握」的题，人次也只算这批学生）
      svc.ext.mistake.aggregateByQuestion(filter),
      // 状态分布按**不筛状态**的口径取：卡片上要看到全貌（未掌握 N·订正过 N·已掌握 N）
      svc.ext.mistake.aggregateByQuestion({ ...baseFilter, stage: 'red' }),
      svc.ext.mistake.aggregateByQuestion({ ...baseFilter, stage: 'yellow' }),
      svc.ext.mistake.aggregateByQuestion({ ...baseFilter, stage: 'green' }),
    ]);
    setRows(list);
    setStageCounts(mergeStageBreakdown(list, [
      { stage: 'red', rows: red },
      { stage: 'yellow', rows: yellow },
      { stage: 'green', rows: green },
    ]));
    // 学科选项：字典归一学科 ∪ 已见学科（单调并集——切换学科后选项不消失）
    setSubjectOptions((current) => mergeSubjects(current, list.map((row) => row.subject)));
    setSelected((current) => current.filter((id) => list.some((row) => row.questionId === id)));
    setPage((current) => clampPage(current, list.length));
  }, [svc, scope]);

  /** 筛选驱动的整轮加载（首载/改筛选：显示加载态，失败必可见） */
  const loadRows = useCallback(async () => {
    setLoading(true);
    try {
      await refreshRows();
    } catch (err) {
      setMessage({ type: 'error', text: `错题聚合加载失败：${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setLoading(false);
    }
  }, [refreshRows]);

  /** 就绪门：本班落定（classReady）+ 其名单落定（membersForClass === classId）后才有真实口径的列表 */
  const scopeReady = classReady && membersForClass === classId;

  useEffect(() => {
    if (!scopeReady) { setLoading(true); return; }
    void loadRows();
  }, [loadRows, scopeReady]);

  /** 当前页的行 + 其完整题面（题库式卡片要显示完整题面：聚合行只有 80 字摘要） */
  const pageRows = useMemo(() => pageSlice(rows, page), [rows, page]);
  const totalPages = pageCount(rows.length);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ids = pageRows.map((row) => row.questionId);
      const loaded = await Promise.all(ids.map(async (id) => [id, await svc.bank.getQuestion(id)] as const));
      if (cancelled) return;
      setQuestions((current) => {
        const next = new Map(current);
        for (const [id, question] of loaded) if (question) next.set(id, question);
        return next;
      });
    })();
    return () => { cancelled = true; };
  }, [svc, pageRows]);

  // 学科字典（归一学科去重集；与已见学科并集后供筛选）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const entries = await svc.ext.dict.listEntries({ kind: 'subject', activeOnly: true });
        if (cancelled) return;
        const normalized = entries.filter((e) => !e.site);
        setSubjectOptions((current) => mergeSubjects(current, normalized.map((e) => e.label)));
        // 0055（R-044）：学科筛选默认取设置页偏好（本页筛选口径=label；字典命中才落，用户已选不动）；
        // 学段筛选恒为红黄绿（学生状态）三态语义，不接「默认学段」
        const stored = readDefaultStageSubject();
        const label = stored.subjectId ? normalized.find((e) => e.id === stored.subjectId)?.label : undefined;
        if (label) setSubjectFilter((cur) => cur || label);
      } catch {
        // 字典不可用不阻塞错题本（学科选项回落为已见学科）
      }
    })();
    return () => { cancelled = true; };
  }, [svc]);

  // ---------- 试题篮（≡ 组卷的试题篮：papers 模型）----------

  const refreshBasket = useCallback(async (id: string) => {
    const refs = await svc.bank.getPaperQuestions(id);
    const items = await Promise.all(refs
      .filter((ref): ref is PaperQuestionRef & { kind?: undefined } => ref.kind !== 'text')
      .map(async (ref) => {
        const question = await svc.bank.getQuestion(ref.questionId);
        return { questionId: ref.questionId, summary: summarize(question?.stemHtml, question?.content, ref.questionId) };
      }));
    setBasketItems(items);
  }, [svc]);

  const loadBasketTargets = useCallback(async () => {
    const list = await svc.ext.paper.listPapersEx();
    setBasketTargets(list.filter((s) => (s.paper.status ?? 'basket') === 'basket' && s.paper.id !== basketId));
  }, [svc, basketId]);

  // 首屏：恢复上次的篮（失效则清键）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = localStorage.getItem(BASKET_KEY);
      if (!stored) return;
      try {
        const paper = await svc.ext.paper.getPaperEx(stored);
        if (cancelled) return;
        if (paper && (paper.status ?? 'basket') === 'basket') {
          setBasketId(paper.id);
          await refreshBasket(paper.id);
        } else {
          localStorage.removeItem(BASKET_KEY);
        }
      } catch {
        localStorage.removeItem(BASKET_KEY);
      }
    })();
    return () => { cancelled = true; };
  }, [svc, refreshBasket]);

  useEffect(() => { void loadBasketTargets(); }, [loadBasketTargets]);

  /**
   * 篮操作串行队列：连点两张卡时第二次必须等第一次落库（否则会各建一个篮 / 后写覆盖前写）。
   * 队列只串行篮子写操作，不阻塞筛选与列表。
   */
  const basketQueueRef = useRef<Promise<void>>(Promise.resolve());
  const enqueueBasketOp = <T,>(task: () => Promise<T>): Promise<T> => {
    const next = basketQueueRef.current.then(task, task);
    basketQueueRef.current = next.then(() => undefined, () => undefined);
    return next;
  };

  /** 篮 id 的队列内权威值（state 在队列任务闭包里已是旧值，不能用来判重） */
  const basketIdRef = useRef<string | null>(null);
  useEffect(() => { basketIdRef.current = basketId; }, [basketId]);

  /** 惰性建篮：首次入篮才落库，不给未用篮的用户留下空篮（队列内调用） */
  const ensureBasket = async (): Promise<string> => {
    if (basketIdRef.current) return basketIdRef.current;
    const paper = await svc.bank.createPaper(BASKET_TITLE);
    basketIdRef.current = paper.id;
    localStorage.setItem(BASKET_KEY, paper.id);
    setBasketId(paper.id);
    return paper.id;
  };

  const run = async (action: () => Promise<string>, failText: string) => {
    setBusy(true);
    try {
      setMessage({ type: 'success', text: await action() });
      await refreshRows();
      await loadBasketTargets();
    } catch (err) {
      setMessage({ type: 'error', text: `${failText}：${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setBusy(false);
    }
  };

  /** 卡片按钮：加入试题篮（幂等：已在篮即提示，不重复加） */
  const addToBasket = (questionId: string) => run(async () => enqueueBasketOp(async () => {
    const id = await ensureBasket();
    const existing = await svc.bank.getPaperQuestions(id);
    const { toAdd, skipped } = planAddToBasket(existing.map((ref) => ref.questionId), [questionId]);
    if (toAdd.length === 0) return `已在试题篮（跳过 ${skipped}）`;
    for (const qid of toAdd) await svc.bank.addQuestion(id, qid);
    await refreshBasket(id);
    return '已加入试题篮';
  }), '入篮失败');

  const removeFromBasket = (questionId: string) => run(async () => {
    if (!basketId) return '试题篮为空';
    await svc.bank.removeQuestion(basketId, questionId);
    await refreshBasket(basketId);
    return '已移出试题篮';
  }, '移出失败');

  const clearBasket = () => run(async () => {
    if (!basketId || basketItems.length === 0) return '试题篮已空';
    for (const item of basketItems) await svc.bank.removeQuestion(basketId, item.questionId);
    await refreshBasket(basketId);
    return '试题篮已清空';
  }, '清空失败');

  /** D1：篮子 → 并入既有篮（去重）→ 跳组卷 */
  const mergeIntoBasket = () => run(async () => enqueueBasketOp(async () => {
    const items = basketIdRef.current ? await svc.bank.getPaperQuestions(basketIdRef.current) : [];
    const questionIds = items.filter((ref) => ref.kind !== 'text').map((ref) => ref.questionId);
    if (questionIds.length === 0) throw new Error('试题篮为空，先点卡片上的「加入试题篮」');
    const targetId = mergeTarget === NEW_BASKET_VALUE
      ? (await svc.bank.createPaper('错题集（并入新建）')).id
      : mergeTarget;
    const existing = await svc.bank.getPaperQuestions(targetId);
    const { toAdd, skipped } = planAddToBasket(existing.map((ref) => ref.questionId), questionIds);
    for (const qid of toAdd) await svc.bank.addQuestion(targetId, qid);
    window.location.hash = `#/basket/${targetId}`;
    return `已并入试题篮（新增 ${toAdd.length} 题，跳过 ${skipped} 题）`;
  }), '并入试题篮失败');

  /** D1 直通：打开这个篮自己去组卷（篮本身即一张 papers 卷） */
  const openBasketPaper = () => {
    if (!basketId) { setMessage({ type: 'error', text: '试题篮为空，先点卡片上的「加入试题篮」' }); return; }
    window.location.hash = `#/basket/${basketId}`;
  };

  /** D3：按错误人次 Top N 出卷（整班一份；忽略单生筛选） */
  const buildClassTopN = () => run(async () => {
    const n = normalizeTopN(topNInput);
    const classScope: MistakeScope = {
      ...(classId ? { studentIds: members.map((s) => s.id) } : {}),
      ...(stageFilter ? { stage: stageFilter } : {}),
      ...(subjectFilter ? { subject: subjectFilter } : {}),
      ...(window_.from ? { occurredFrom: window_.from } : {}),
      ...(window_.to ? { occurredTo: window_.to } : {}),
    };
    const ids = topN(await svc.ext.mistake.exportQuestionIds(toAggregateFilter(classScope)), n);
    if (ids.length === 0) throw new Error('当前筛选下没有错题');
    const className = classes.find((c) => c.id === classId)?.name ?? '';
    const paper = await svc.bank.createPaper(classMistakeTitle(className, n));
    for (const qid of ids) await svc.bank.addQuestion(paper.id, qid);
    window.location.hash = `#/basket/${paper.id}`;
    return `已出卷：${paper.title}（${ids.length} 题）`;
  }, 'Top N 出卷失败');

  /**
   * P4：成册——选生错题集 → 生成「错题本」卷（题/卷头已备）→ **送到组卷**，不替用户定稿。
   * 目检返工二（用户口径）：成册「退一级」——导出到试卷（组卷页），经人工排版微调后由教师自行导出 PDF 等文档；
   * 故本动作止于「排版中」的卷并跳过去，不再自动快照/定稿/导出（导出能力仍在组卷侧，未丢）。
   */
  const buildBook = () => run(async () => {
    if (!studentId) throw new Error('先选择学生');
    const student = students.find((s) => s.id === studentId);
    if (!student) throw new Error('学生不存在');
    const ids = await svc.ext.mistake.exportQuestionIds(toAggregateFilter(scope));
    if (ids.length === 0) throw new Error('该生在当前筛选下没有错题');
    const title = mistakeBookTitle(student.name, window_);
    // 组卷管线状态机：basket→done 非法（G6），须经 composing 中转。
    // 建卷必须走有契约通道的 bank.createPaper——ext.paper 的成品卷建卷口在渲染层客户端是
    // unwired（成品卷走 capture/bank 侧），走它真桥必炸（目检事件：成册失败·通道未定义）。
    const paper = await svc.bank.createPaper(title);
    await svc.ext.paper.updatePaperStatus(paper.id, 'composing');
    for (const qid of ids) await svc.bank.addQuestion(paper.id, qid);
    const layoutConfig: PaperLayoutConfig = {
      version: 2,
      header: { style: 'exam', lines: mistakeBookHeaderLines(student.name, window_, ids.length) },
    };
    await svc.ext.paper.setPaperLayoutConfig(paper.id, layoutConfig);
    window.location.hash = `#/basket/${paper.id}`;
    await loadBasketTargets();
    return `已送到组卷：${title}（${ids.length} 题）——排版微调后自行导出 PDF/Word`;
  }, '成册失败');

  // ---------- 批量（0025 批量口：聚合行 → 筛选内 mistakes 行 id）----------

  /** 聚合行 id 集 → 当前筛选内的 mistakes 行 id（批量口只认行 id；班外/窗口外行不误伤） */
  const collectScopedMistakeIds = async (questionIds: string[]): Promise<string[]> => {
    const out: string[] = [];
    for (const questionId of questionIds) {
      const list = await svc.ext.mistake.listMistakes({ questionId });
      out.push(...scopeMistakeIds(list, scope));
    }
    return out;
  };

  const batchSetStage = (stage: MistakeStage) => run(async () => {
    const ids = await collectScopedMistakeIds(selected);
    if (ids.length === 0) throw new Error('选中行在当前筛选下没有错题行');
    const result = await svc.ext.mistake.setStages(ids, stage);
    setSelected([]);
    return `已改学生状态：${result.affectedCount} 条（${STUDENT_STAGE_LABEL[stage]}）`;
  }, '批量改状态失败');

  const batchDelete = () => run(async () => {
    const ids = await collectScopedMistakeIds(selected);
    if (ids.length === 0) throw new Error('选中行在当前筛选下没有错题行');
    const result = await svc.ext.mistake.deleteMistakes(ids);
    setSelected([]);
    setDetail(null);
    return `已删除 ${result.affectedCount} 条错题（宁可多标，多出的在此人工删）`;
  }, '批量删除失败');

  // ---------- 详情（按钮/键盘）----------

  const openDetail = async (row: MistakeAggregateRow) => {
    setDetail({ row, mistakes: [], loading: true });
    try {
      const list = await svc.ext.mistake.listMistakes({ questionId: row.questionId });
      setDetail({ row, mistakes: list.filter((m) => inScope(m, scope)), loading: false });
    } catch (err) {
      setDetail(null);
      setMessage({ type: 'error', text: `详情加载失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  const reloadDetail = async () => {
    if (!detail) return;
    await refreshRows();
    const list = await svc.ext.mistake.listMistakes({ questionId: detail.row.questionId });
    setDetail({ ...detail, mistakes: list.filter((m) => inScope(m, scope)) });
  };

  const toggleSelected = (questionId: string) => {
    setSelected((current) => (current.includes(questionId) ? current.filter((id) => id !== questionId) : [...current, questionId]));
  };

  /** 键盘流（需求八 §8.2-5）：↑↓ 游标 / Space 勾选 / Enter 详情（入篮改为显式按钮） */
  const onListKeyDown = (event: { key: string; ctrlKey: boolean; preventDefault: () => void }) => {
    if (pageRows.length === 0) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((current) => {
        const next = event.key === 'ArrowDown' ? current + 1 : current - 1;
        return Math.max(0, Math.min(pageRows.length - 1, next));
      });
      return;
    }
    if (activeIndex < 0) return;
    const row = pageRows[activeIndex];
    if (!row) return;
    if (event.key === ' ') {
      event.preventDefault();
      toggleSelected(row.questionId);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      void openDetail(row);
    }
  };

  // ---------- 渲染 ----------

  const optionsWithSeen = mergeSubjects(subjectOptions, rows.map((row) => row.subject));
  const bookDisabled = !studentId || loading || busy;
  const basketIds = new Set(basketItems.map((item) => item.questionId));
  // 序号起点按页大小算（不能乘「本页实际条数」——末页短，会算成 10 而不是 40）
  const pageStart = (clampPage(page, rows.length) - 1) * MISTAKE_PAGE_SIZE;

  return (
    <div data-testid="mistakes-page" className="mistake-page">
      <PageHeader
        title="错题本"
        backHref="#/"
        actions={(
          <span data-testid="mistake-scope-total" style={{ color: 'var(--ink-3)', fontSize: '0.85rem' }}>
            {describeScopeTotal(rows.reduce((sum, row) => sum + row.wrongCount, 0), rows.length)}
          </span>
        )}
      />

      <MessageBanner message={message} />

      <div className="mistake-layout">
        {/* ---------- 左：控件栏（筛选 + 出卷动作） ---------- */}
        <aside data-testid="mistake-filter-panel" className="mistake-side">
          <div className="card" style={{ padding: '0.75rem' }}>
            <h2 className="section-title" style={{ fontSize: '1rem', marginTop: 0 }}>筛选</h2>
            <label className="field-label">班级
              <select
                className="select"
                data-testid="mistake-class-filter"
                value={classId}
                onChange={(e) => { setClassId(e.target.value); setStudentId(''); setPage(1); }}
                style={{ width: '100%', marginTop: 4 }}
              >
                <option value="">全部班级</option>
                {classes.filter((c) => c.status === 'active').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <label className="field-label">学生
              <select
                className="select"
                data-testid="mistake-student-filter"
                value={studentId}
                onChange={(e) => { setStudentId(e.target.value); setPage(1); }}
                style={{ width: '100%', marginTop: 4 }}
              >
                <option value="">全部学生</option>
                {(classId ? members : students).map((s) => (
                  <option key={s.id} value={s.id}>{s.name}{s.status === 'archived' ? '（已封存）' : ''}</option>
                ))}
              </select>
            </label>
            <label className="field-label">学科
              <select
                className="select"
                data-testid="mistake-subject-filter"
                value={subjectFilter}
                onChange={(e) => { setSubjectFilter(e.target.value); setPage(1); }}
                style={{ width: '100%', marginTop: 4 }}
              >
                <option value="">全部学科</option>
                {optionsWithSeen.map((subject) => <option key={subject} value={subject}>{subject}</option>)}
              </select>
            </label>
            <label className="field-label" title="红黄绿是**学生**对题的状态：红=还没掌握，黄=订正过一次，绿=已掌握">
              学生状态（红黄绿）
              <select
                className="select"
                data-testid="mistake-stage-filter"
                value={stageFilter}
                onChange={(e) => { setStageFilter(e.target.value as MistakeStage | ''); setPage(1); }}
                style={{ width: '100%', marginTop: 4 }}
              >
                <option value="">全部状态</option>
                {STAGE_OPTIONS.map((st) => <option key={st} value={st}>{st === 'red' ? '红' : st === 'yellow' ? '黄' : '绿'}·{STUDENT_STAGE_LABEL[st]}</option>)}
              </select>
            </label>
            <p className="m-hint" data-testid="mistake-stage-hint">
              选中某状态后，人次只计该状态的学生（红黄绿按学生算，不是给题打标签）
            </p>

            <div className="field-label" style={{ marginTop: 8 }}>时间窗</div>
            <div className="m-window-fields">
              <label className="m-window-field">
                <span>起</span>
                <input
                  className="input"
                  type="date"
                  data-testid="mistake-from-input"
                  value={window_.from}
                  onChange={(e) => { setWindow((w) => ({ ...w, from: e.target.value })); setPage(1); }}
                />
              </label>
              <label className="m-window-field">
                <span>止</span>
                <input
                  className="input"
                  type="date"
                  data-testid="mistake-to-input"
                  value={window_.to}
                  onChange={(e) => { setWindow((w) => ({ ...w, to: e.target.value })); setPage(1); }}
                />
              </label>
            </div>
            <button
              className="btn btn-sm"
              data-testid="mistake-week-btn"
              onClick={() => { setWindow(weekWindow(new Date())); setPage(1); }}
              style={{ marginTop: 6, width: '100%' }}
            >
              回到本周
            </button>
          </div>

          {/* D3：整班一份 */}
          <div className="card" style={{ padding: '0.75rem', marginTop: '0.75rem' }}>
            <h2 className="section-title" style={{ fontSize: '1rem', marginTop: 0 }}>班级错题集</h2>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{ color: 'var(--ink-2)', fontSize: '0.85rem' }}>按错误人次 Top</span>
              <input
                className="input"
                data-testid="mistake-topn-input"
                value={topNInput}
                onChange={(e) => setTopNInput(e.target.value)}
                style={{ width: 60 }}
              />
            </div>
            <button
              className="btn btn-primary btn-sm"
              data-testid="mistake-topn-btn"
              disabled={busy}
              onClick={() => void buildClassTopN()}
              style={{ marginTop: 6, width: '100%' }}
            >
              一键出卷（整班）
            </button>
          </div>

          {/* P4：成册 */}
          <div className="card" style={{ padding: '0.75rem', marginTop: '0.75rem' }}>
            <h2 className="section-title" style={{ fontSize: '1rem', marginTop: 0 }}>错题本成册</h2>
            <p style={{ color: 'var(--ink-3)', fontSize: '0.8rem', margin: '0 0 6px' }}>
              {studentId
                ? `对象：${studentName(studentId)}（时间窗内错题）· 生成「错题本」卷送到组卷`
                : '先在「学生」里选一名学生'}
            </p>
            <button
              className="btn btn-sm"
              data-testid="mistake-book-btn"
              disabled={bookDisabled}
              onClick={() => void buildBook()}
              style={{ width: '100%' }}
            >
              一键成册到组卷
            </button>
          </div>
        </aside>

        {/* ---------- 右：试题栏（题库式题卡列表，占满剩余宽度） ---------- */}
        <main className="mistake-main">
          {selected.length > 0 && (
            <div data-testid="mistake-batch-bar" data-selected-count={selected.length} className="selection-bar">
              <span>已选 {selected.length} 题</span>
              <select
                className="select"
                data-testid="mistake-batch-stage-select"
                defaultValue=""
                onChange={(e) => {
                  if (!e.target.value) return;
                  void batchSetStage(e.target.value as MistakeStage);
                  e.target.value = '';
                }}
                style={{ width: 130 }}
              >
                <option value="">批量改学生状态…</option>
                {STAGE_OPTIONS.map((st) => <option key={st} value={st}>{STUDENT_STAGE_LABEL[st]}</option>)}
              </select>
              <button className="btn btn-sm" data-testid="mistake-batch-apply-btn" disabled={busy} onClick={() => void batchSetStage('yellow')}>
                标记订正过
              </button>
              <ConfirmButton
                label="批量删除"
                confirmLabel="确认删除"
                testid="mistake-batch-delete-btn"
                onConfirm={() => void batchDelete()}
              />
              <button className="btn btn-sm" data-testid="mistake-batch-clear-btn" onClick={() => setSelected([])}>取消选择</button>
            </div>
          )}

          {loading ? (
            <p data-testid="mistakes-loading" style={{ color: 'var(--ink-3)' }}>加载中…</p>
          ) : rows.length === 0 ? (
            <div data-testid="mistakes-empty">
              <EmptyState>
                暂无错题{stageFilter || studentId || classId || subjectFilter ? '（调整筛选条件试试）' : '——通过考试登记勾错题即可自动入本'}
              </EmptyState>
            </div>
          ) : (
            <>
              <div className="m-list-head">
                <span>共 {rows.length} 题</span>
                <span style={{ flex: 1 }} />
                <span>第 {clampPage(page, rows.length)} / {totalPages} 页</span>
                <button
                  className="btn btn-sm"
                  data-testid="mistake-prev-page"
                  disabled={clampPage(page, rows.length) <= 1}
                  onClick={() => setPage((p) => clampPage(p - 1, rows.length))}
                >
                  上一页
                </button>
                <button
                  className="btn btn-sm"
                  data-testid="mistake-next-page"
                  disabled={clampPage(page, rows.length) >= totalPages}
                  onClick={() => setPage((p) => clampPage(p + 1, rows.length))}
                >
                  下一页
                </button>
              </div>

              <div className="m-cards-scroll">
              <ul
                data-testid="mistake-card-list"
                className="m-cards"
                tabIndex={0}
                onKeyDown={onListKeyDown}
              >
                {pageRows.map((row, index) => (
                  <MistakeCard
                    key={row.questionId}
                    row={row}
                    no={pageStart + index + 1}
                    counts={stageCounts.get(row.questionId)}
                    scopeCount={scopeCount}
                    question={questions.get(row.questionId)}
                    selected={selected.includes(row.questionId)}
                    active={index === activeIndex}
                    inBasket={basketIds.has(row.questionId)}
                    onToggleSelected={toggleSelected}
                    onOpenDetail={(r) => void openDetail(r)}
                    onAdd={(id) => void addToBasket(id)}
                    onRemove={(id) => void removeFromBasket(id)}
                  />
                ))}
              </ul>
              </div>
            </>
          )}
        </main>
      </div>

      {/* ---------- 右侧吸附悬浮试题篮（B2；组件可复用，题库后续迁同形态） ---------- */}
      <FloatingBasket title="试题篮" count={basketItems.length} testid="mistake-basket">
        {basketItems.length === 0 ? (
          <p data-testid="mistake-basket-empty" style={{ color: 'var(--ink-3)', fontSize: '0.85rem', margin: 0 }}>
            篮里还空着——点题卡右下角的「加入试题篮」把题放进来
          </p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {basketItems.map((item) => (
              <li key={item.questionId} data-testid={`mistake-basket-item-${item.questionId}`} className="mini-m-row" style={{ gap: 6 }}>
                <span className="m-summary" style={{ flex: 1 }}>{item.summary}</span>
                <button
                  className="btn btn-sm"
                  data-testid={`mistake-basket-item-remove-${item.questionId}`}
                  onClick={() => void removeFromBasket(item.questionId)}
                >
                  移出
                </button>
              </li>
            ))}
          </ul>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
          <button
            className="btn btn-primary btn-sm"
            data-testid="mistake-basket-open-btn"
            disabled={basketItems.length === 0}
            onClick={openBasketPaper}
          >
            去组卷（打开这个篮）
          </button>
          <select
            className="select"
            data-testid="mistake-basket-target-select"
            value={mergeTarget}
            onChange={(e) => setMergeTarget(e.target.value)}
            style={{ width: '100%' }}
          >
            <option value={NEW_BASKET_VALUE}>＋ 并入新建试题篮</option>
            {basketTargets.map((s) => <option key={s.paper.id} value={s.paper.id}>{s.paper.title}（{s.questionCount} 题）</option>)}
          </select>
          <button
            className="btn btn-sm"
            data-testid="mistake-basket-merge-btn"
            disabled={busy || basketItems.length === 0}
            onClick={() => void mergeIntoBasket()}
          >
            并入该篮并去组卷
          </button>
          <ConfirmButton
            label="清空试题篮"
            confirmLabel="确认清空"
            testid="mistake-basket-clear-btn"
            disabled={basketItems.length === 0}
            onConfirm={() => void clearBasket()}
          />
        </div>
      </FloatingBasket>

      {/* ---------- 详情弹层：快照 + 按生明细 ---------- */}
      {detail && (
        <Modal title="错题详情" onClose={() => setDetail(null)}>
          <div data-testid="mistake-detail-modal">
            {detail.loading ? (
              <p style={{ color: 'var(--ink-3)' }}>加载中…</p>
            ) : (
              <>
                <div style={{ marginBottom: '0.5rem', color: 'var(--ink-2)', fontSize: '0.9rem' }}>
                  {describeWrongCount(detail.row.wrongCount, scopeCount)} · {detail.row.subject}
                  {detail.row.questionType ? ` · ${detail.row.questionType}` : ''} · 最近错于 {localDate(new Date(detail.row.lastOccurredAt))}
                </div>
                {/* 题面读快照（U10：原题改/删后仍可读；无错题行时回落聚合摘要） */}
                {detail.mistakes.length > 0 ? (
                  <SnapshotBody mistake={detail.mistakes[0]} />
                ) : (
                  <div className="question-content" data-testid="mistake-snapshot" style={{ marginBottom: '0.75rem' }}>
                    <div dangerouslySetInnerHTML={{ __html: renderQuestionHtml(detail.row.stemSummary) }} />
                  </div>
                )}
                <h3 className="section-title" style={{ fontSize: '0.95rem' }}>错题学生（{detail.mistakes.length}）</h3>
                {detail.mistakes.length === 0 ? (
                  <p style={{ color: 'var(--ink-3)' }}>当前筛选下无错题行</p>
                ) : (
                  detail.mistakes
                    .slice()
                    .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0))
                    .map((mistake) => (
                      <DetailStudentRow
                        key={mistake.id}
                        svc={svc}
                        mistake={mistake}
                        studentName={studentName(mistake.studentId)}
                        onChanged={() => void reloadDetail()}
                        onMessage={setMessage}
                      />
                    ))
                )}
              </>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

/** 题干摘要（题被软删/缺失时用 id 占位，不静默空白） */
function summarize(stemHtml: string | undefined, content: string | undefined, fallback: string): string {
  const text = (stemHtml || content || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return fallback;
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}
