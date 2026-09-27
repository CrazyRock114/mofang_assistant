// 0003 Phase 3: 班级列表页（#/classes）+ 班级详情页（#/classes/:id）
// 列表：新建班级 + 打开详情；详情：班级信息（可编辑）+ 在班学生名单 + 分班操作（入班/结课时期）

import { useCallback, useEffect, useState } from 'react';
import type { ClassInfo, ClassStatus, Student, StudentClassPeriod } from '../../shared/contracts/bank-types.js';
import {
  useExtPageServices, MessageBanner, Modal, Field, PageHeader, ConfirmButton, EmptyState, loadClassMembers,
  type ExtPageServices, type PageMessage,
} from './ExtUi.js';

function formatDay(iso?: string): string {
  return iso ? iso.slice(0, 10) : '—';
}

// ---------------- 新建/编辑班级弹层 ----------------

function ClassFormModal({
  svc, initial, onClose, onSaved,
}: { svc: ExtPageServices; initial: ClassInfo | null; onClose: () => void; onSaved: (text: string) => void }) {
  const [name, setName] = useState(initial?.name ?? '');
  const [school, setSchool] = useState(initial?.school ?? '');
  const [gradeLevel, setGradeLevel] = useState(initial?.gradeLevel ?? '');
  const [term, setTerm] = useState(initial?.term ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!name.trim()) {
      setError('班级名必填');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const data = {
        name: name.trim(),
        school: school.trim() || undefined,
        gradeLevel: gradeLevel.trim() || undefined,
        term: term.trim() || undefined,
      };
      if (initial) {
        await svc.ext.class.updateClass(initial.id, data);
        onSaved(`已更新班级「${data.name}」`);
      } else {
        await svc.ext.class.createClass(data);
        onSaved(`已新建班级「${data.name}」`);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={initial ? '编辑班级' : '新建班级'} onClose={onClose}>
      <Field label="班级名 *">
        <input className="input" data-testid="class-name-input" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="学校">
        <input className="input" data-testid="class-school-input" value={school} onChange={(e) => setSchool(e.target.value)} />
      </Field>
      <Field label="年级">
        <input className="input" data-testid="class-grade-input" value={gradeLevel} onChange={(e) => setGradeLevel(e.target.value)} />
      </Field>
      <Field label="学期">
        <input className="input" data-testid="class-term-input" value={term} onChange={(e) => setTerm(e.target.value)} />
      </Field>
      {error && <MessageBanner message={{ type: 'error', text: error }} />}
      <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn" data-testid="class-save-btn" onClick={save} disabled={saving}>
          {saving ? '保存中...' : '保存'}
        </button>
      </div>
    </Modal>
  );
}

// ---------------- 班级列表页 ----------------

export function ClassesPage({ services }: { services?: ExtPageServices }) {
  const svc = useExtPageServices(services);
  const [classes, setClasses] = useState<ClassInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<ClassStatus | 'all'>('active');
  const [showCreate, setShowCreate] = useState(false);
  const [message, setMessage] = useState<PageMessage | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await svc.ext.class.listClasses({ status: statusFilter });
      setClasses(list);
    } catch (err) {
      setMessage({ type: 'error', text: `加载班级列表失败：${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setLoading(false);
    }
  }, [svc, statusFilter]);

  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <PageHeader
        title="班级管理"
        backHref="#/"
        actions={(
          <button className="btn btn-primary" data-testid="class-create-btn" onClick={() => setShowCreate(true)}>新建班级</button>
        )}
      />

      <div style={{ marginBottom: '1rem' }}>
        <label style={{ color: 'var(--ink-2)' }}>
          状态：
          <select
            className="select"
            data-testid="class-status-filter"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as ClassStatus | 'all')}
            style={{ marginLeft: '0.5rem' }}
          >
            <option value="active">进行中</option>
            <option value="closed">已结课</option>
            <option value="all">全部</option>
          </select>
        </label>
      </div>

      <MessageBanner message={message} />

      {loading ? (
        <p>加载中...</p>
      ) : classes.length === 0 ? (
        <div data-testid="classes-empty">
          <EmptyState>暂无班级，点击右上角「新建班级」开始分班管理</EmptyState>
        </div>
      ) : (
        <ul data-testid="classes-list" style={{ listStyle: 'none', padding: 0 }}>
          {classes.map((c) => (
            <li
              key={c.id}
              data-testid="class-item"
              data-name={c.name}
              style={{ padding: '0.75rem', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: '1rem' }}
            >
              <a href={`#/classes/${encodeURIComponent(c.id)}`} style={{ fontWeight: 'bold' }}>{c.name}</a>
              <span style={{ color: 'var(--ink-2)' }}>
                {c.gradeLevel ?? ''} {c.term ?? ''} {c.school ?? ''}
              </span>
              {c.status === 'closed' && <span style={{ color: 'var(--ink-3)' }}>（已结课）</span>}
              <span style={{ flex: 1 }} />
              <span style={{ color: 'var(--ink-3)', fontSize: '0.85rem' }}>建于 {formatDay(c.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}

      {showCreate && (
        <ClassFormModal
          svc={svc}
          initial={null}
          onClose={() => setShowCreate(false)}
          onSaved={(text) => {
            setMessage({ type: 'success', text });
            load();
          }}
        />
      )}
    </div>
  );
}

// ---------------- 班级详情页 ----------------

export function ClassDetailPage({
  classId, services,
}: { classId: string; services?: ExtPageServices }) {
  const svc = useExtPageServices(services);
  const [clazz, setClazz] = useState<ClassInfo | null>(null);
  const [openPeriods, setOpenPeriods] = useState<Array<StudentClassPeriod & { student?: Student }>>([]);
  const [endedPeriods, setEndedPeriods] = useState<Array<StudentClassPeriod & { student?: Student }>>([]);
  const [candidates, setCandidates] = useState<Student[]>([]);
  const [enrollStudentId, setEnrollStudentId] = useState('');
  const [loading, setLoading] = useState(true);
  const [showEdit, setShowEdit] = useState(false);
  const [message, setMessage] = useState<PageMessage | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const c = await svc.ext.class.getClass(classId);
      setClazz(c);
      if (!c) {
        setMessage({ type: 'error', text: `班级不存在（${classId}）` });
        return;
      }
      // 名册组合查询（getClassStudents 无 renderer 通道）：成员 + 各自在该班的时期
      const entries = await loadClassMembers(svc, classId);
      const openList: Array<StudentClassPeriod & { student?: Student }> = [];
      const endedList: Array<StudentClassPeriod & { student?: Student }> = [];
      for (const e of entries) {
        for (const p of e.periods) {
          (p.endedAt ? endedList : openList).push({ ...p, student: e.student });
        }
      }
      setOpenPeriods(openList);
      setEndedPeriods(endedList);
      // 入班候选：全部在读学生 − 已在本班在读的学生
      const all = await svc.ext.student.listStudents({});
      const inClass = new Set(entries.filter((e) => e.periods.some((p) => !p.endedAt)).map((e) => e.student.id));
      setCandidates(all.filter((s) => !inClass.has(s.id)));
    } catch (err) {
      setMessage({ type: 'error', text: `加载班级详情失败：${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setLoading(false);
    }
  }, [svc, classId]);

  useEffect(() => { load(); }, [load]);

  const enroll = async () => {
    if (!enrollStudentId) return;
    const student = candidates.find((s) => s.id === enrollStudentId);
    try {
      await svc.ext.student.enrollStudent(enrollStudentId, classId);
      setMessage({ type: 'success', text: `已将「${student?.name ?? enrollStudentId}」编入本班` });
      setEnrollStudentId('');
      await load();
    } catch (err) {
      setMessage({ type: 'error', text: `入班失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  const endEnrollment = async (period: StudentClassPeriod & { student?: Student }) => {
    try {
      await svc.ext.student.endEnrollment(period.studentId, classId, new Date().toISOString());
      setMessage({ type: 'success', text: `已结束「${period.student?.name ?? period.studentId}」在本班的时期（历史保留）` });
      await load();
    } catch (err) {
      setMessage({ type: 'error', text: `结课失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  const periodRow = (p: StudentClassPeriod & { student?: Student }, ended: boolean) => (
    <tr key={`${p.studentId}:${p.startedAt ?? ''}`} data-testid={ended ? 'ended-student-row' : 'class-student-row'}>
      <td style={{ padding: '0.5rem' }}>{p.student?.name ?? p.studentId}</td>
      <td style={{ padding: '0.5rem' }}>{p.student?.studentNo ?? '—'}</td>
      <td style={{ padding: '0.5rem' }}>{formatDay(p.startedAt)}</td>
      <td style={{ padding: '0.5rem' }}>{p.endedAt ? formatDay(p.endedAt) : '至今'}</td>
      <td style={{ padding: '0.5rem' }}>
        {!ended && (
          <ConfirmButton
            label="结课/移出"
            confirmLabel="确认结课"
            testid={`end-enrollment-btn-${p.student?.name ?? p.studentId}`}
            onConfirm={() => endEnrollment(p)}
          />
        )}
      </td>
    </tr>
  );

  return (
    <div>
      <PageHeader
        title={clazz ? `班级：${clazz.name}` : '班级详情'}
        backHref="#/classes"
        actions={clazz ? <button className="btn" onClick={() => setShowEdit(true)}>编辑班级信息</button> : undefined}
      />

      {clazz && (
        <div style={{ color: 'var(--ink-2)', marginBottom: '1rem' }}>
          学校：{clazz.school ?? '—'} ｜ 年级：{clazz.gradeLevel ?? '—'} ｜ 学期：{clazz.term ?? '—'} ｜ 状态：
          {clazz.status === 'active' ? <span style={{ color: 'var(--green-ink)' }}>进行中</span> : <span style={{ color: 'var(--ink-3)' }}>已结课</span>}
        </div>
      )}

      <MessageBanner message={message} />

      {loading ? (
        <p>加载中...</p>
      ) : (
        <>
          <h2 style={{ fontSize: '1.1rem' }}>在班学生（{openPeriods.length}）</h2>
          {openPeriods.length === 0 ? (
            <div data-testid="class-roster-empty">
              <EmptyState>本班暂无在读学生，从下方选择学生编入</EmptyState>
            </div>
          ) : (
            <table className="sheet" data-testid="class-roster" style={{ width: '100%', marginBottom: '1.5rem' }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--line-strong)', color: 'var(--ink-2)' }}>
                  <th style={{ padding: '0.5rem' }}>姓名</th>
                  <th style={{ padding: '0.5rem' }}>学号</th>
                  <th style={{ padding: '0.5rem' }}>入班时间</th>
                  <th style={{ padding: '0.5rem' }}>状态</th>
                  <th style={{ padding: '0.5rem' }}>操作</th>
                </tr>
              </thead>
              <tbody>{openPeriods.map((p) => periodRow(p, false))}</tbody>
            </table>
          )}

          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '1.5rem' }}>
            <select
              className="select"
              data-testid="enroll-student-select"
              value={enrollStudentId}
              onChange={(e) => setEnrollStudentId(e.target.value)}
              style={{ minWidth: '180px' }}
            >
              <option value="">选择学生编入本班…</option>
              {candidates.map((s) => (
                <option key={s.id} value={s.id}>{s.name}{s.studentNo ? `（${s.studentNo}）` : ''}</option>
              ))}
            </select>
            <button className="btn" data-testid="enroll-btn" onClick={enroll} disabled={!enrollStudentId}>入班</button>
            {candidates.length === 0 && <span style={{ color: 'var(--ink-3)' }}>（没有可编入的在读学生，先到学生管理页建档）</span>}
          </div>

          {endedPeriods.length > 0 && (
            <>
              <h2 style={{ fontSize: '1.1rem' }}>历史分班（{endedPeriods.length}）</h2>
              <table className="sheet" style={{ width: '100%' }}>
                <thead>
                  <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--line-strong)', color: 'var(--ink-2)' }}>
                    <th style={{ padding: '0.5rem' }}>姓名</th>
                    <th style={{ padding: '0.5rem' }}>学号</th>
                    <th style={{ padding: '0.5rem' }}>入班</th>
                    <th style={{ padding: '0.5rem' }}>结课</th>
                    <th style={{ padding: '0.5rem' }}>操作</th>
                  </tr>
                </thead>
                <tbody>{endedPeriods.map((p) => periodRow(p, true))}</tbody>
              </table>
            </>
          )}
        </>
      )}

      {showEdit && clazz && (
        <ClassFormModal
          svc={svc}
          initial={clazz}
          onClose={() => setShowEdit(false)}
          onSaved={(text) => {
            setMessage({ type: 'success', text });
            load();
          }}
        />
      )}
    </div>
  );
}
