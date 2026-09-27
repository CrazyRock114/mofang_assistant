// 0003 Phase 3: 学生管理页（#/students）
// 列表（检索 + 封存默认隐藏）+ 新建/编辑 + 封存/启用（B6）+ 详情抽屉（分班历史 + 时间线 events）

import { useCallback, useEffect, useState } from 'react';
import type {
  Student, StudentStatus, StudentEvent, StudentClassPeriod, StudentEventPayload,
} from '../../shared/contracts/bank-types.js';
import {
  useExtPageServices, MessageBanner, Modal, Field, PageHeader, ConfirmButton, EmptyState,
  type ExtPageServices, type PageMessage,
} from './ExtUi.js';

const EVENT_TYPE_LABEL: Record<StudentEvent['eventType'], string> = {
  exam_score: '考试成绩',
  performance: '课堂表现',
  note: '备注',
  photo_attach: '照片',
};

function eventText(payload: StudentEventPayload): string {
  switch (payload.eventType) {
    case 'exam_score':
      return payload.score !== undefined ? `分数 ${payload.score}` : '成绩登记';
    case 'performance':
      return payload.text;
    case 'note':
      return payload.title ? `${payload.title}：${payload.text}` : payload.text;
    case 'photo_attach':
      return payload.caption ? `照片：${payload.caption}` : `照片（${payload.assetId}）`;
  }
}

function formatTime(iso?: string): string {
  return iso ? new Date(iso).toLocaleString() : '—';
}

// ---------------- 新建/编辑弹层 ----------------

function StudentFormModal({
  svc, initial, onClose, onSaved,
}: { svc: ExtPageServices; initial: Student | null; onClose: () => void; onSaved: (text: string) => void }) {
  const [name, setName] = useState(initial?.name ?? '');
  const [studentNo, setStudentNo] = useState(initial?.studentNo ?? '');
  const [gender, setGender] = useState(initial?.gender ?? '');
  const [school, setSchool] = useState(initial?.school ?? '');
  const [remark, setRemark] = useState(initial?.remark ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!name.trim()) {
      setError('姓名必填');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const data = {
        name: name.trim(),
        studentNo: studentNo.trim() || undefined,
        gender: gender.trim() || undefined,
        school: school.trim() || undefined,
        remark: remark.trim() || undefined,
      };
      if (initial) {
        await svc.ext.student.updateStudent(initial.id, data);
        onSaved(`已更新学生「${data.name}」`);
      } else {
        await svc.ext.student.createStudent(data);
        onSaved(`已新建学生「${data.name}」`);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={initial ? '编辑学生' : '新建学生'} onClose={onClose}>
      <Field label="姓名 *">
        <input className="input" data-testid="student-name-input" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="学号">
        <input className="input" data-testid="student-no-input" value={studentNo} onChange={(e) => setStudentNo(e.target.value)} />
      </Field>
      <Field label="性别">
        <input className="input" data-testid="student-gender-input" value={gender} onChange={(e) => setGender(e.target.value)} />
      </Field>
      <Field label="学校">
        <input className="input" data-testid="student-school-input" value={school} onChange={(e) => setSchool(e.target.value)} />
      </Field>
      <Field label="备注">
        <input className="input" data-testid="student-remark-input" value={remark} onChange={(e) => setRemark(e.target.value)} />
      </Field>
      {error && <MessageBanner message={{ type: 'error', text: error }} />}
      <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn" data-testid="student-save-btn" onClick={save} disabled={saving}>
          {saving ? '保存中...' : '保存'}
        </button>
      </div>
    </Modal>
  );
}

// ---------------- 详情抽屉（分班历史 + 时间线） ----------------

function StudentDrawer({
  svc, studentId, onClose, onChanged,
}: { svc: ExtPageServices; studentId: string; onClose: () => void; onChanged: () => void }) {
  const [student, setStudent] = useState<Student | null>(null);
  const [classes, setClasses] = useState<Array<StudentClassPeriod & { className?: string }>>([]);
  const [events, setEvents] = useState<StudentEvent[]>([]);
  const [noteText, setNoteText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, cls, evts] = await Promise.all([
        svc.ext.student.getStudent(studentId),
        svc.ext.student.getStudentClasses(studentId),
        svc.ext.student.listEvents({ studentId }),
      ]);
      setStudent(s);
      setClasses(cls);
      setEvents([...evts].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [svc, studentId]);

  useEffect(() => { load(); }, [load]);

  const addNote = async () => {
    if (!noteText.trim()) return;
    try {
      await svc.ext.student.addEvent({
        studentId,
        eventType: 'note',
        occurredAt: new Date().toISOString(),
        payload: { eventType: 'note', text: noteText.trim() },
      });
      setNoteText('');
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div style={{
      position: 'fixed', top: 0, right: 0, bottom: 0, width: '420px',
      backgroundColor: 'var(--card)', borderLeft: '1px solid var(--line-strong)',
      boxShadow: 'var(--shadow-pop)', padding: '1.5rem', overflowY: 'auto', zIndex: 900,
    }}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <h2 style={{ margin: 0, flex: 1 }} data-testid="student-detail-title">
          {student ? student.name : '学生详情'}
        </h2>
        <button className="btn" onClick={onClose}>关闭</button>
      </div>
      {error && <MessageBanner message={{ type: 'error', text: error }} />}
      {student && (
        <div style={{ color: 'var(--ink-2)', margin: '0.75rem 0' }}>
          <div>学号：{student.studentNo ?? '—'}</div>
          <div>性别：{student.gender ?? '—'}</div>
          <div>学校：{student.school ?? '—'}</div>
          <div>状态：{student.status === 'active' ? '在读' : '已封存'}</div>
          {student.remark && <div>备注：{student.remark}</div>}
        </div>
      )}

      <h3 style={{ marginBottom: '0.5rem' }}>分班历史</h3>
      {classes.length === 0 ? (
        <p style={{ color: 'var(--ink-3)' }}>暂无分班记录，可在班级页为学生分班</p>
      ) : (
        <ul data-testid="student-classes" style={{ margin: '0 0 1rem', paddingLeft: '1.2rem' }}>
          {classes.map((c) => (
            <li key={`${c.studentId}:${c.classId}:${c.startedAt ?? ''}`}>
              {c.className ?? c.classId}
              （{formatTime(c.startedAt)} ~ {c.endedAt ? formatTime(c.endedAt) : '至今'}）
            </li>
          ))}
        </ul>
      )}

      <h3 style={{ marginBottom: '0.5rem' }}>时间线</h3>
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}>
        <input
          className="input"
          data-testid="student-note-input"
          placeholder="添加备注（时间线）"
          value={noteText}
          onChange={(e) => setNoteText(e.target.value)}
          style={{ flex: 1 }}
        />
        <button className="btn" data-testid="student-note-add-btn" onClick={addNote}>添加</button>
      </div>
      {events.length === 0 ? (
        <p style={{ color: 'var(--ink-3)' }} data-testid="student-events-empty">暂无事件</p>
      ) : (
        <ul data-testid="student-events" style={{ paddingLeft: '1.2rem' }}>
          {events.map((ev) => (
            <li key={ev.id} style={{ marginBottom: '0.4rem' }}>
              <span style={{ color: 'var(--ink-2)' }}>{formatTime(ev.occurredAt)}</span>
              {' '}
              <strong>{EVENT_TYPE_LABEL[ev.eventType]}</strong>
              {' '}
              {eventText(ev.payload)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------- 主页面 ----------------

export function StudentsPage({ services }: { services?: ExtPageServices }) {
  const svc = useExtPageServices(services);
  const [students, setStudents] = useState<Student[]>([]);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [message, setMessage] = useState<PageMessage | null>(null);
  const [formState, setFormState] = useState<{ mode: 'create' } | { mode: 'edit'; student: Student } | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await svc.ext.student.listStudents({
        keyword: keyword.trim() || undefined,
        includeArchived,
      });
      setStudents(list);
    } catch (err) {
      setMessage({ type: 'error', text: `加载学生列表失败：${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setLoading(false);
    }
  }, [svc, keyword, includeArchived]);

  useEffect(() => { load(); }, [load]);

  const setStatus = async (student: Student, status: StudentStatus) => {
    try {
      await svc.ext.student.setStudentStatus(student.id, status);
      setMessage({
        type: 'success',
        text: status === 'archived' ? `已封存「${student.name}」（列表默认隐藏，历史保留）` : `已启用「${student.name}」`,
      });
      await load();
    } catch (err) {
      setMessage({ type: 'error', text: `状态切换失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  return (
    <div>
      <PageHeader
        title="学生管理"
        backHref="#/"
        actions={(
          <button className="btn btn-primary" data-testid="student-create-btn" onClick={() => setFormState({ mode: 'create' })}>
            新建学生
          </button>
        )}
      />

      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', marginBottom: '1rem' }}>
        <input
          className="input"
          data-testid="student-keyword-input"
          placeholder="按姓名/学号检索"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          style={{ width: '220px' }}
        />
        <label style={{ color: 'var(--ink-2)' }}>
          <input
            data-testid="student-archived-toggle"
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
          />
          {' '}显示已封存
        </label>
      </div>

      <MessageBanner message={message} />

      {loading ? (
        <p>加载中...</p>
      ) : students.length === 0 ? (
        <div data-testid="students-empty">
          <EmptyState>
            暂无学生{keyword ? '（调整检索条件试试）' : '，点击右上角「新建学生」开始建档'}
          </EmptyState>
        </div>
      ) : (
        <table className="sheet" data-testid="students-table" style={{ width: '100%' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--line-strong)', color: 'var(--ink-2)' }}>
              <th style={{ padding: '0.5rem' }}>姓名</th>
              <th style={{ padding: '0.5rem' }}>学号</th>
              <th style={{ padding: '0.5rem' }}>性别</th>
              <th style={{ padding: '0.5rem' }}>学校</th>
              <th style={{ padding: '0.5rem' }}>状态</th>
              <th style={{ padding: '0.5rem' }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {students.map((s) => (
              <tr key={s.id} data-testid="student-row" data-name={s.name} style={{ borderBottom: '1px solid var(--line)' }}>
                <td style={{ padding: '0.5rem' }}>{s.name}</td>
                <td style={{ padding: '0.5rem' }}>{s.studentNo ?? '—'}</td>
                <td style={{ padding: '0.5rem' }}>{s.gender ?? '—'}</td>
                <td style={{ padding: '0.5rem' }}>{s.school ?? '—'}</td>
                <td style={{ padding: '0.5rem' }}>
                  {s.status === 'active'
                    ? <span style={{ color: 'var(--green-ink)' }}>在读</span>
                    : <span style={{ color: 'var(--ink-3)' }}>已封存</span>}
                </td>
                <td style={{ padding: '0.5rem', display: 'flex', gap: '0.4rem' }}>
                  <button data-testid={`student-detail-btn-${s.name}`} onClick={() => setDetailId(s.id)}>详情</button>
                  <button className="btn" onClick={() => setFormState({ mode: 'edit', student: s })}>编辑</button>
                  {s.status === 'active' ? (
                    <ConfirmButton
                      label="封存"
                      confirmLabel="确认封存"
                      testid={`student-archive-btn-${s.name}`}
                      onConfirm={() => setStatus(s, 'archived')}
                    />
                  ) : (
                    <button data-testid={`student-restore-btn-${s.name}`} onClick={() => setStatus(s, 'active')}>启用</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {formState && (
        <StudentFormModal
          svc={svc}
          initial={formState.mode === 'edit' ? formState.student : null}
          onClose={() => setFormState(null)}
          onSaved={(text) => {
            setMessage({ type: 'success', text });
            load();
          }}
        />
      )}

      {detailId && (
        <StudentDrawer svc={svc} studentId={detailId} onClose={() => setDetailId(null)} onChanged={load} />
      )}
    </div>
  );
}
