// 0026 P3：试卷集在组卷侧暴露（需求一 1.2「接上不重建，只暴露」）——
// 组卷/试卷列表页显示试卷集分组（统一/定制错题两类）+ 手动新建试卷集 + 加卷/移出/删集；
// custom-mistake 每生一卷**只展示既有数据**（生成器属二期，P-06/D2）；batch_meta 只读展示（一期只定字段）。
//
// 数据面全部来自 0025 已接线通道（paper_set.list/getPapers/create/addPaper/removePaper/delete）：
// 本组件不含任何新通道、不写 batch_meta（写入口径仍归 createPaperSet 的校验层）。
// 类型文案与考试页同口径（避免同物两名）。

import { useCallback, useEffect, useState } from 'react';
import type { PaperSet, PaperSetPaperRef, PaperType, PaperSummary, Student } from '../../shared/contracts/bank-types.js';
import {
  ConfirmButton, MessageBanner, useExtPageServices,
  type ExtPageServices, type PageMessage,
} from './ExtUi.js';
import { batchMetaLines } from './mistake-loop.js';

/** 与 ExamsPage 同文案（同物同名；两处本地常量，改动需同步） */
const PAPER_SET_TYPE_LABEL: Record<PaperType, string> = {
  uniform: '统一卷集合',
  'custom-mistake': '定制错题卷集合',
};

interface SetView {
  set: PaperSet;
  refs: PaperSetPaperRef[];
}

export function PaperSetPanel({ svc: injected }: { svc?: ExtPageServices }) {
  const svc = useExtPageServices(injected);
  const [views, setViews] = useState<SetView[]>([]);
  const [summaries, setSummaries] = useState<PaperSummary[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<PageMessage | null>(null);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<PaperType>('uniform');
  const [addPick, setAddPick] = useState<Record<string, string>>({});
  const [addStudent, setAddStudent] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [sets, papers, studentList] = await Promise.all([
        svc.ext.paperSet.listPaperSets({}),
        svc.ext.paper.listPapersEx(),
        svc.ext.student.listStudents({ includeArchived: true }),
      ]);
      const built: SetView[] = [];
      for (const set of sets) {
        built.push({ set, refs: await svc.ext.paperSet.getSetPapers(set.id) });
      }
      setViews(built);
      setSummaries(papers);
      setStudents(studentList);
    } catch (err) {
      // 0025 口径：坏 batch_meta 读出显式抛错——面板局部降级为可见错误，不炸页面
      setMessage({ type: 'error', text: `试卷集加载失败：${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setLoading(false);
    }
  }, [svc]);

  useEffect(() => { void load(); }, [load]);

  const run = async (action: () => Promise<string>, failText: string) => {
    setBusy(true);
    try {
      setMessage({ type: 'success', text: await action() });
      await load();
    } catch (err) {
      setMessage({ type: 'error', text: `${failText}：${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setBusy(false);
    }
  };

  const paperTitle = (paperId: string): string =>
    summaries.find((s) => s.paper.id === paperId)?.paper.title ?? paperId;

  const studentName = (studentId: string): string =>
    students.find((s) => s.id === studentId)?.name ?? studentId;

  const createSet = () => run(async () => {
    const name = newName.trim();
    if (!name) throw new Error('先填试卷集名称');
    const created = await svc.ext.paperSet.createPaperSet({ name, type: newType });
    setNewName('');
    return `已新建试卷集：${created.name}`;
  }, '新建试卷集失败');

  const addPaper = (set: PaperSet) => run(async () => {
    const paperId = addPick[set.id] ?? '';
    if (!paperId) throw new Error('先选择要加入的已定稿卷');
    // 错题卷集：可同时指定这份卷是哪名学生的（不指派则留空）
    const studentId = set.type === 'custom-mistake' ? (addStudent[set.id] ?? '') : '';
    await svc.ext.paperSet.addPaper(set.id, paperId, ...(studentId ? [studentId] : []));
    setAddPick((current) => ({ ...current, [set.id]: '' }));
    setAddStudent((current) => ({ ...current, [set.id]: '' }));
    return studentId
      ? `已加入：${studentName(studentId)} → ${paperTitle(paperId)}`
      : `已加入：${paperTitle(paperId)}`;
  }, '加入试卷失败');

  const removePaper = (set: PaperSet, paperId: string) => run(async () => {
    await svc.ext.paperSet.removePaper(set.id, paperId);
    return `已移出：${paperTitle(paperId)}（卷本身保留）`;
  }, '移出试卷失败');

  const deleteSet = (set: PaperSet) => run(async () => {
    await svc.ext.paperSet.deletePaperSet(set.id);
    return `已删除试卷集：${set.name}（集内卷保留）`;
  }, '删除试卷集失败');

  if (loading) return <section data-testid="paper-set-section"><p style={{ color: 'var(--ink-3)' }}>试卷集加载中…</p></section>;

  return (
    <section data-testid="paper-set-section" style={{ marginBottom: '1.5rem' }}>
      <h2 className="section-title" style={{ fontSize: '1.1rem' }}>试卷集（{views.length}）</h2>

      <MessageBanner message={message} />

      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
        <input
          className="input"
          data-testid="paper-set-name-input"
          placeholder="新试卷集名称"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          style={{ width: 200 }}
        />
        <select
          className="select"
          data-testid="paper-set-type-select"
          value={newType}
          onChange={(e) => setNewType(e.target.value as PaperType)}
          style={{ width: 160 }}
        >
          {(['uniform', 'custom-mistake'] as PaperType[]).map((tp) => (
            <option key={tp} value={tp}>{PAPER_SET_TYPE_LABEL[tp]}</option>
          ))}
        </select>
        <button className="btn btn-primary btn-sm" data-testid="paper-set-create-btn" disabled={busy} onClick={() => void createSet()}>
          新建试卷集
        </button>
      </div>

      {views.length === 0 ? (
        <p data-testid="paper-set-empty" style={{ color: 'var(--ink-3)' }}>
          暂无试卷集（考试登记时自动编排，或在此手动新建）
        </p>
      ) : views.map(({ set, refs }) => {
        const inSet = new Set(refs.map((ref) => ref.paperId));
        const addable = summaries.filter((s) => s.paper.status === 'done' && !inSet.has(s.paper.id));
        const metaLines = batchMetaLines(set.batchMeta);
        // 目检返工：错题卷集要看得见「哪名学生的哪份卷」——按学生名排，未指派学生排最后
        const activeStudents = students.filter((s) => s.status === 'active');
        const linkedCount = new Set(refs.filter((ref) => ref.studentId).map((ref) => ref.studentId)).size;
        const orderedRefs = set.type === 'custom-mistake'
          ? refs.slice().sort((a, b) => {
            if (!a.studentId && !b.studentId) return 0;
            if (!a.studentId) return 1;
            if (!b.studentId) return -1;
            return studentName(a.studentId).localeCompare(studentName(b.studentId), 'zh-Hans-CN');
          })
          : refs;
        return (
          <div key={set.id} data-testid={`paper-set-card-${set.id}`} className="card" style={{ padding: '0.75rem', marginBottom: '0.5rem' }}>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <strong>{set.name}</strong>
              <span data-testid={`paper-set-type-${set.id}`} className="tag">{PAPER_SET_TYPE_LABEL[set.type]}</span>
              <span style={{ color: 'var(--ink-3)', fontSize: '0.85rem' }}>{refs.length} 卷</span>
              <span style={{ flex: 1 }} />
              <ConfirmButton
                label="删除试卷集"
                confirmLabel="确认删除"
                testid={`paper-set-delete-${set.id}`}
                onConfirm={() => void deleteSet(set)}
              />
            </div>

            {/* 每生一卷：卷与学生是谁配上的，摆在这一行（只读；生成器属二期 P-06/D2） */}
            {set.type === 'custom-mistake' && (
              <div
                data-testid={`paper-set-perstudent-hint-${set.id}`}
                className="m-hint"
                style={{ marginTop: 4 }}
              >
                每生一卷（只展示既有数据）：已入集 <strong>{linkedCount}</strong> 名学生的卷
                {activeStudents.length > 0 ? ` ／ 在册 ${activeStudents.length} 名学生` : ''}
              </div>
            )}

            {/* batch_meta 只读展示（一期只定字段，P-06）：无数据不占行，有数据才出 */}
            {metaLines.length > 0 && (
              <div data-testid={`paper-set-meta-${set.id}`} style={{ color: 'var(--ink-3)', fontSize: '0.82rem', marginTop: 4 }}>
                {metaLines.join(' · ')}
              </div>
            )}

            {refs.length === 0 ? (
              <p style={{ color: 'var(--ink-3)', fontSize: '0.85rem', margin: '0.4rem 0' }}>集内暂无卷</p>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: '0.4rem 0 0' }}>
                {orderedRefs.map((ref) => (
                  <li
                    key={`${ref.paperId}-${ref.studentId ?? ''}`}
                    data-testid={`paper-set-paper-${set.id}-${ref.paperId}`}
                    data-student={ref.studentId ?? ''}
                    className="mini-m-row"
                    style={{ gap: '0.5rem' }}
                  >
                    {set.type === 'custom-mistake' && (
                      <strong
                        data-testid={`paper-set-student-${set.id}-${ref.paperId}`}
                        style={{ flex: '0 0 auto', minWidth: 72 }}
                      >
                        {ref.studentId ? studentName(ref.studentId) : '未指派学生'}
                      </strong>
                    )}
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {paperTitle(ref.paperId)}
                    </span>
                    <button
                      className="btn btn-sm"
                      data-testid={`paper-set-remove-paper-${set.id}-${ref.paperId}`}
                      onClick={() => void removePaper(set, ref.paperId)}
                    >
                      移出该卷
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.5rem', flexWrap: 'wrap' }}>
              <select
                className="select"
                data-testid={`paper-set-add-select-${set.id}`}
                value={addPick[set.id] ?? ''}
                onChange={(e) => setAddPick((current) => ({ ...current, [set.id]: e.target.value }))}
                style={{ flex: 1, minWidth: 160 }}
              >
                <option value="">选择已定稿卷…</option>
                {addable.map((s) => <option key={s.paper.id} value={s.paper.id}>{s.paper.title}</option>)}
              </select>
              {/* 错题卷集：入集时指定这份卷是哪名学生的（配关系的手动通道） */}
              {set.type === 'custom-mistake' && (
                <select
                  className="select"
                  data-testid={`paper-set-add-student-${set.id}`}
                  value={addStudent[set.id] ?? ''}
                  onChange={(e) => setAddStudent((current) => ({ ...current, [set.id]: e.target.value }))}
                  style={{ width: 150 }}
                >
                  <option value="">（不指派学生）</option>
                  {activeStudents.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              )}
              <button
                className="btn btn-sm"
                data-testid={`paper-set-add-btn-${set.id}`}
                disabled={busy || addable.length === 0}
                onClick={() => void addPaper(set)}
              >
                加入试卷
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}
