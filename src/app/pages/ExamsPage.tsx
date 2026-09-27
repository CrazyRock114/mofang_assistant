// 0003 Phase 3: 考试页（#/exams 列表）+ 考试登记页（#/exams/:id）
// 列表：建考试（选班级/学科/卷集合，可无卷=校外登记）；详情：学生名单 → 逐生录成绩 + 勾错题
// → recordResults（成绩+错题标红+U9 自动升黄一次完成）→ 摘要展示 + 成绩列表（exam_scores）。
// fix-2：新建表单补「关联已定稿试卷」入口——选定 done 卷提交时编排 单卷集合（查复用→建集合+addPaper）
// → createExam 带 paperSetId（决策稿 G6：统一卷=单卷集合；错题登记只关联 done 卷）。

import { useCallback, useEffect, useState } from 'react';
import type { ClassInfo, DictEntry, Exam, ExamRecordSummary, ExamScore, PaperSet, PaperSetPaperRef, PaperSummary, Student } from '../../shared/contracts/bank-types.js';
import {
  useExtPageServices, MessageBanner, Modal, Field, PageHeader, EmptyState, loadClassMembers,
  type ExtPageServices, type PageMessage,
} from './ExtUi.js';
// 0055（R-044）：新建考试的学科默认取设置页偏好（本页无学段选择器，不接学段）
import { readDefaultStageSubject } from '../state/default-stage-subject.js';

const PAPER_SET_TYPE_LABEL = { uniform: '统一卷集合', 'custom-mistake': '定制错题卷集合' } as const;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 去标签取纯文本（勾错题选项摘要用） */
function textExcerpt(html: string | undefined, max = 40): string {
  if (!html) return '';
  const text = html.replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

interface QuestionMeta {
  id: string;
  /** 卷内位置（题号） */
  no: number;
  excerpt: string;
}

// ---------------- 新建考试弹层 ----------------

function ExamCreateModal({
  svc, onClose, onCreated,
}: { svc: ExtPageServices; onClose: () => void; onCreated: (examId: string) => void }) {
  const [title, setTitle] = useState('');
  const [classId, setClassId] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [occurredAt, setOccurredAt] = useState(todayIso());
  const [paperSetId, setPaperSetId] = useState('');
  const [remark, setRemark] = useState('');
  const [classes, setClasses] = useState<ClassInfo[]>([]);
  const [subjects, setSubjects] = useState<DictEntry[]>([]);
  const [paperSets, setPaperSets] = useState<PaperSet[]>([]);
  // fix-2：应用内已定稿（done）卷——默认优先的关联入口
  const [donePapers, setDonePapers] = useState<PaperSummary[]>([]);
  const [donePaperId, setDonePaperId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      svc.ext.class.listClasses({ status: 'active' }),
      svc.ext.dict.listEntries({ kind: 'subject', activeOnly: true }),
      svc.ext.paperSet.listPaperSets({}),
      svc.bank.listPapers(),
    ]).then(([cls, subj, sets, papers]) => {
      setClasses(cls);
      const normalized = subj.filter((e) => !e.site);
      setSubjects(normalized);
      setPaperSets(sets);
      setDonePapers(papers.filter((p) => p.paper.status === 'done'));
      // 0055（R-044）：学科默认取设置页偏好（字典命中才落，避免悬空 id）；用户已手选则不动
      const stored = readDefaultStageSubject();
      if (stored.subjectId && normalized.some((e) => e.id === stored.subjectId)) {
        setSubjectId((cur) => cur || stored.subjectId);
      }
    }).catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [svc]);

  /**
   * fix-2 提交编排：选定 done 卷 → 「统一卷=单卷集合」自动落库（client 多步，失败经 MessageBanner 可见）。
   * 1) 查复用：uniform 集合逐个 getPapers，已含该卷 → 复用其 id（防重复建垃圾集合）；
   * 2) 无复用 → paperSet.create({ name: 卷标题, type: 'uniform' }) + paperSet.addPaper(setId, paperId)。
   */
  const resolveOrCreateUniformSet = async (donePaper: PaperSummary): Promise<string> => {
    const sets = await svc.ext.paperSet.listPaperSets({});
    for (const ps of sets) {
      if (ps.type !== 'uniform') continue;
      const refs: PaperSetPaperRef[] = await svc.ext.paperSet.getSetPapers(ps.id);
      if (refs.some((r) => r.paperId === donePaper.paper.id)) return ps.id;
    }
    const created = await svc.ext.paperSet.createPaperSet({ name: donePaper.paper.title, type: 'uniform' });
    await svc.ext.paperSet.addPaper(created.id, donePaper.paper.id);
    return created.id;
  };

  const save = async () => {
    if (!title.trim()) {
      setError('考试名称必填');
      return;
    }
    if (!classId) {
      setError('请选择班级（登记页按班级出学生名单）');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const donePaper = donePapers.find((p) => p.paper.id === donePaperId);
      const linkedSetId = donePaper ? await resolveOrCreateUniformSet(donePaper) : paperSetId || undefined;
      const exam = await svc.ext.exam.createExam({
        title: title.trim(),
        classId,
        subjectId: subjectId || undefined,
        occurredAt,
        paperSetId: linkedSetId,
        remark: remark.trim() || undefined,
      });
      onCreated(exam.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="新建考试" onClose={onClose}>
      <Field label="考试名称 *">
        <input className="input" data-testid="exam-title-input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="班级 *（登记页按班级出名单）">
        <select className="select" data-testid="exam-class-select" value={classId} onChange={(e) => setClassId(e.target.value)} style={{ width: '100%' }}>
          <option value="">选择班级…</option>
          {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </Field>
      <Field label="学科">
        <select className="select" data-testid="exam-subject-select" value={subjectId} onChange={(e) => setSubjectId(e.target.value)} style={{ width: '100%' }}>
          <option value="">（不指定）</option>
          {subjects.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </Field>
      <Field label="考试日期 *">
        <input className="input" data-testid="exam-date-input" type="date" value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} />
      </Field>
      {/* fix-2：卷选择两行——① 关联已定稿试卷（默认优先，选卷提交时自动编排单卷集合）；② 或选择已有卷集合。两行互斥 */}
      <Field label="关联已定稿试卷（优先；关联后支持勾错题 + 自动升黄）">
        {donePapers.length === 0 ? (
          <span data-testid="exam-donepaper-empty" style={{ color: 'var(--ink-3)' }}>
            暂无已定稿试卷——先在组卷页把卷定稿（done），或直接选卷集合
          </span>
        ) : (
          <select
            className="select"
            data-testid="exam-donepaper-select"
            value={donePaperId}
            onChange={(e) => { setDonePaperId(e.target.value); if (e.target.value) setPaperSetId(''); }}
            style={{ width: '100%' }}
          >
            <option value="">（不关联应用内试卷）</option>
            {donePapers.map((p) => <option key={p.paper.id} value={p.paper.id}>{p.paper.title}</option>)}
          </select>
        )}
      </Field>
      <Field label="或选择已有卷集合（custom-mistake 等既有集合走这里）">
        <select
          className="select"
          data-testid="exam-paperset-select"
          value={paperSetId}
          onChange={(e) => { setPaperSetId(e.target.value); if (e.target.value) setDonePaperId(''); }}
          style={{ width: '100%' }}
        >
          <option value="">（无卷 = 校外登记）</option>
          {paperSets.map((ps) => <option key={ps.id} value={ps.id}>{ps.name}（{PAPER_SET_TYPE_LABEL[ps.type]}）</option>)}
        </select>
      </Field>
      <Field label="备注">
        <input className="input" data-testid="exam-remark-input" value={remark} onChange={(e) => setRemark(e.target.value)} />
      </Field>
      {error && <MessageBanner message={{ type: 'error', text: error }} />}
      <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn" data-testid="exam-save-btn" onClick={save} disabled={saving}>
          {saving ? '保存中...' : '创建并进入登记'}
        </button>
      </div>
    </Modal>
  );
}

// ---------------- 考试列表页 ----------------

export function ExamsPage({ services }: { services?: ExtPageServices }) {
  const svc = useExtPageServices(services);
  const [exams, setExams] = useState<Exam[]>([]);
  const [classes, setClasses] = useState<Record<string, ClassInfo>>({});
  const [paperSets, setPaperSets] = useState<Record<string, PaperSet>>({});
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [message, setMessage] = useState<PageMessage | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [examList, classList, setList] = await Promise.all([
        svc.ext.exam.listExams({}),
        svc.ext.class.listClasses({ status: 'all' }),
        svc.ext.paperSet.listPaperSets({}),
      ]);
      setExams(examList);
      setClasses(Object.fromEntries(classList.map((c) => [c.id, c])));
      setPaperSets(Object.fromEntries(setList.map((s) => [s.id, s])));
    } catch (err) {
      setMessage({ type: 'error', text: `加载考试列表失败：${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setLoading(false);
    }
  }, [svc]);

  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <PageHeader
        title="考试登记"
        backHref="#/"
        actions={<button className="btn" data-testid="exam-create-btn" onClick={() => setShowCreate(true)}>新建考试</button>}
      />

      <MessageBanner message={message} />

      {loading ? (
        <p>加载中...</p>
      ) : exams.length === 0 ? (
        <div data-testid="exams-empty">
          <EmptyState>暂无考试，点击右上角「新建考试」开始登记</EmptyState>
        </div>
      ) : (
        <table className="sheet" data-testid="exams-table" style={{ width: '100%' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--line-strong)', color: 'var(--ink-2)' }}>
              <th style={{ padding: '0.5rem' }}>考试</th>
              <th style={{ padding: '0.5rem' }}>日期</th>
              <th style={{ padding: '0.5rem' }}>班级</th>
              <th style={{ padding: '0.5rem' }}>卷集合</th>
            </tr>
          </thead>
          <tbody>
            {exams.map((e) => (
              <tr key={e.id} data-testid="exam-row" style={{ borderBottom: '1px solid var(--line)' }}>
                <td style={{ padding: '0.5rem' }}>
                  <a href={`#/exams/${encodeURIComponent(e.id)}`} data-testid={`exam-link-${e.title}`}>{e.title}</a>
                  {e.remark && <span style={{ color: 'var(--ink-3)', marginLeft: '0.5rem' }}>{e.remark}</span>}
                </td>
                <td style={{ padding: '0.5rem' }}>{e.occurredAt.slice(0, 10)}</td>
                <td style={{ padding: '0.5rem' }}>{e.classId ? classes[e.classId]?.name ?? '—' : '—'}</td>
                <td style={{ padding: '0.5rem' }}>
                  {e.paperSetId
                    ? `${paperSets[e.paperSetId]?.name ?? '—'}`
                    : <span style={{ color: 'var(--ink-3)' }}>无卷（校外登记）</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showCreate && (
        <ExamCreateModal
          svc={svc}
          onClose={() => setShowCreate(false)}
          onCreated={(examId) => { window.location.hash = `#/exams/${encodeURIComponent(examId)}`; }}
        />
      )}
    </div>
  );
}

// ---------------- 考试登记详情页 ----------------

type DraftMap = Record<string, { score: string; wrong: string[] }>;

export function ExamDetailPage({
  examId, services,
}: { examId: string; services?: ExtPageServices }) {
  const svc = useExtPageServices(services);
  const [exam, setExam] = useState<Exam | null>(null);
  const [paperSet, setPaperSet] = useState<PaperSet | null>(null);
  const [roster, setRoster] = useState<Student[]>([]);
  const [draft, setDraft] = useState<DraftMap>({});
  /** uniform：整卷集合共享题目；custom-mistake：studentId → 该生卷 id（null=该生无卷） */
  const [sharedQuestions, setSharedQuestions] = useState<QuestionMeta[] | null>(null);
  const [perStudentPaper, setPerStudentPaper] = useState<Record<string, string | null> | null>(null);
  const [scores, setScores] = useState<ExamScore[]>([]);
  const [summary, setSummary] = useState<ExamRecordSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<PageMessage | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const e = await svc.ext.exam.getExam(examId);
      if (!e) {
        setMessage({ type: 'error', text: `考试不存在（${examId}）` });
        setLoading(false);
        return;
      }
      setExam(e);

      // 名单：班级在读学生（组合查询还原开期成员；getClassStudents 无 renderer 通道）
      let rosterStudents: Student[] = [];
      if (e.classId) {
        const entries = await loadClassMembers(svc, e.classId);
        rosterStudents = entries
          .filter((en) => en.student.status === 'active' && en.periods.some((p) => !p.endedAt))
          .map((en) => en.student);
      }
      setRoster(rosterStudents);

      // 勾错题数据：关联卷集合时加载（uniform 共享卷 / custom-mistake 每生一卷）
      if (e.paperSetId) {
        const ps = await svc.ext.paperSet.getPaperSet(e.paperSetId);
        setPaperSet(ps);
        const refs: PaperSetPaperRef[] = await svc.ext.paperSet.getSetPapers(e.paperSetId);
        const metaById: Record<string, QuestionMeta> = {};
        const loadPaperQuestions = async (paperId: string): Promise<QuestionMeta[]> => {
          const qrefs = await svc.bank.getPaperQuestions(paperId);
          return Promise.all(qrefs.map(async (qr) => {
            if (!metaById[qr.questionId]) {
              const q = await svc.bank.getQuestion(qr.questionId);
              metaById[qr.questionId] = {
                id: qr.questionId,
                no: qr.position,
                excerpt: textExcerpt(q?.stemHtml ?? q?.content),
              };
            }
            return metaById[qr.questionId];
          }));
        };
        if (ps?.type === 'uniform') {
          const paperIds = [...new Set(refs.map((r) => r.paperId))];
          const merged: QuestionMeta[] = [];
          for (const pid of paperIds) merged.push(...await loadPaperQuestions(pid));
          setSharedQuestions(merged.sort((a, b) => a.no - b.no));
        } else {
          const byStudent: Record<string, string | null> = {};
          for (const s of rosterStudents) {
            const ref = await svc.ext.paperSet.getStudentPaper(e.paperSetId, s.id);
            byStudent[s.id] = ref?.paperId ?? null;
          }
          setPerStudentPaper(byStudent);
        }
      } else {
        setPaperSet(null);
        setSharedQuestions(null);
        setPerStudentPaper(null);
      }

      setScores(await svc.ext.exam.getExamScores(examId));
    } catch (err) {
      setMessage({ type: 'error', text: `加载考试详情失败：${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setLoading(false);
    }
  }, [svc, examId]);

  useEffect(() => { load(); }, [load]);

  // custom-mistake 每生题目预载（uniform 已在 load 中合并）
  const [perStudentQuestions, setPerStudentQuestions] = useState<Record<string, QuestionMeta[]>>({});
  useEffect(() => {
    if (!perStudentPaper) return;
    let cancelled = false;
    (async () => {
      const metaCache: Record<string, QuestionMeta> = {};
      const result: Record<string, QuestionMeta[]> = {};
      for (const [studentId, pid] of Object.entries(perStudentPaper)) {
        if (!pid) continue;
        const qrefs = await svc.bank.getPaperQuestions(pid);
        result[studentId] = (await Promise.all(qrefs.map(async (qr) => {
          if (!metaCache[qr.questionId]) {
            const q = await svc.bank.getQuestion(qr.questionId);
            metaCache[qr.questionId] = { id: qr.questionId, no: qr.position, excerpt: textExcerpt(q?.stemHtml ?? q?.content) };
          }
          return metaCache[qr.questionId];
        }))).sort((a, b) => a.no - b.no);
      }
      if (!cancelled) setPerStudentQuestions(result);
    })();
    return () => { cancelled = true; };
  }, [svc, perStudentPaper]);

  const questionsFor = (studentId: string): QuestionMeta[] | null => {
    if (sharedQuestions) return sharedQuestions;
    if (perStudentPaper) {
      if (!perStudentPaper[studentId]) return null;
      return perStudentQuestions[studentId] ?? [];
    }
    return null;
  };

  const setDraftScore = (studentId: string, score: string) => {
    setDraft((d) => ({ ...d, [studentId]: { wrong: d[studentId]?.wrong ?? [], score } }));
  };

  const toggleWrong = (studentId: string, questionId: string) => {
    setDraft((d) => {
      const current = d[studentId] ?? { score: '', wrong: [] };
      const wrong = current.wrong.includes(questionId)
        ? current.wrong.filter((q) => q !== questionId)
        : [...current.wrong, questionId];
      return { ...d, [studentId]: { ...current, wrong } };
    });
  };

  const submit = async () => {
    if (!exam) return;
    setSubmitting(true);
    try {
      const entries = roster.map((s) => {
        const d = draft[s.id];
        const scoreText = d?.score?.trim() ?? '';
        return {
          studentId: s.id,
          ...(scoreText !== '' ? { score: Number(scoreText) } : {}),
          wrongQuestionIds: d?.wrong ?? [],
        };
      });
      const result = await svc.ext.exam.recordResults(examId, entries);
      setSummary(result);
      setScores(await svc.ext.exam.getExamScores(examId));
      setMessage({ type: 'success', text: '登记完成' });
    } catch (err) {
      setMessage({ type: 'error', text: `登记失败：${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setSubmitting(false);
    }
  };

  const studentName = (studentId: string) => roster.find((s) => s.id === studentId)?.name ?? studentId;

  return (
    <div>
      <PageHeader title={exam ? `考试登记：${exam.title}` : '考试登记'} backHref="#/exams" />

      {exam && (
        <div style={{ color: 'var(--ink-2)', marginBottom: '1rem' }}>
          日期：{exam.occurredAt.slice(0, 10)} ｜ 卷集合：{exam.paperSetId ? `${paperSet?.name ?? '…'}（${paperSet ? PAPER_SET_TYPE_LABEL[paperSet.type] : ''}）` : '无卷（校外登记）'}
        </div>
      )}

      <MessageBanner message={message} />

      {loading ? (
        <p>加载中...</p>
      ) : exam && (
        <>
          {summary && (
            <div
              data-testid="record-summary"
              className="notice notice-green"
              style={{ marginBottom: '1rem', alignItems: 'flex-start' }}
            >
              <strong>登记摘要：</strong>
              成绩写入 {summary.scoresUpserted} 条 ｜ 新标红 {summary.mistakesCreated} 题 ｜ 重复错回红 {summary.mistakesUpdated} 题 ｜ 自动升黄 {summary.autoPromotedToYellow} 题（{summary.promotedStudents} 名学生）
              {!exam.paperSetId && (
                <div data-testid="no-paperset-hint" style={{ marginTop: '0.5rem' }}>
                  本次登记未关联卷集合：勾错已标红入本，但不触发红题自动升黄（U9 仅对关联卷的考试生效）。
                </div>
              )}
            </div>
          )}

          <h2 style={{ fontSize: '1.1rem' }}>成绩与错题登记（{roster.length} 名学生）</h2>
          {!exam.classId && (
            <p style={{ color: 'var(--ink-3)' }}>该考试未关联班级，无法生成名单（建考试时请选择班级）。</p>
          )}
          {exam.classId && roster.length === 0 && (
            <div data-testid="exam-roster-empty">
              <EmptyState>班级暂无在读学生，先到班级页完成分班。</EmptyState>
            </div>
          )}

          {roster.length > 0 && (
            <table className="sheet" data-testid="exam-roster-table" style={{ width: '100%', marginBottom: '1rem' }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--line-strong)', color: 'var(--ink-2)' }}>
                  <th style={{ padding: '0.5rem', width: '120px' }}>学生</th>
                  <th style={{ padding: '0.5rem', width: '100px' }}>成绩（空=缺考）</th>
                  <th style={{ padding: '0.5rem' }}>错题勾选</th>
                </tr>
              </thead>
              <tbody>
                {roster.map((s) => {
                  const questions = questionsFor(s.id);
                  const d = draft[s.id];
                  return (
                    <tr key={s.id} data-testid={`exam-student-row-${s.name}`}>
                      <td style={{ padding: '0.5rem' }}>{s.name}</td>
                      <td style={{ padding: '0.5rem' }}>
                        <input
                          className="input"
                          data-testid={`score-input-${s.name}`}
                          type="number"
                          value={d?.score ?? ''}
                          onChange={(e) => setDraftScore(s.id, e.target.value)}
                          style={{ width: '80px' }}
                        />
                      </td>
                      <td style={{ padding: '0.5rem' }}>
                        {questions === null ? (
                          <span style={{ color: 'var(--ink-3)' }}>（该生无卷，不参与勾错）</span>
                        ) : questions.length === 0 ? (
                          <span style={{ color: 'var(--ink-3)' }}>（卷内暂无题目）</span>
                        ) : (
                          <details>
                            <summary style={{ cursor: 'pointer' }}>勾错题（{d?.wrong.length ?? 0}/{questions.length}）</summary>
                            <div style={{ padding: '0.5rem 0 0 1rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                              {questions.map((q) => (
                                <label key={q.id} style={{ fontWeight: 'normal' }}>
                                  <input
                                    data-testid={`wrong-checkbox-${s.name}-${q.no}`}
                                    type="checkbox"
                                    checked={d?.wrong.includes(q.id) ?? false}
                                    onChange={() => toggleWrong(s.id, q.id)}
                                  />
                                  {' '}第 {q.no} 题：{q.excerpt || '（无题面文本）'}
                                </label>
                              ))}
                            </div>
                          </details>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {roster.length > 0 && (
            <button
              className="btn btn-primary"
              data-testid="record-submit-btn"
              onClick={submit}
              disabled={submitting}
              style={{ marginBottom: '1.5rem' }}
            >
              {submitting ? '提交中...' : '提交登记'}
            </button>
          )}

          <h2 style={{ fontSize: '1.1rem' }}>已录成绩（{scores.length}）</h2>
          {scores.length === 0 ? (
            <div data-testid="exam-scores-empty">
              <EmptyState>暂无成绩记录</EmptyState>
            </div>
          ) : (
            <table className="sheet" data-testid="exam-scores-table">
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--line-strong)', color: 'var(--ink-2)' }}>
                  <th style={{ padding: '0.5rem' }}>学生</th>
                  <th style={{ padding: '0.5rem' }}>成绩</th>
                  <th style={{ padding: '0.5rem' }}>更新时间</th>
                </tr>
              </thead>
              <tbody>
                {scores.map((sc) => (
                  <tr key={sc.id}>
                    <td style={{ padding: '0.5rem' }}>{studentName(sc.studentId)}</td>
                    <td style={{ padding: '0.5rem' }}>{sc.score ?? '缺考'}</td>
                    <td style={{ padding: '0.5rem', color: 'var(--ink-3)' }}>{new Date(sc.updatedAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
