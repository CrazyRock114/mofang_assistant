// 0003 共享 UI 原子：4 个扩展页面（学生/班级/考试/错题本）共用的服务注入、消息条、弹层、红黄绿语义灯。
// 样式约束：沿用 app.css 现有风格 + 内联样式（主题落地是里程碑第 6 步，本任务功能优先）。

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  BankService, BankExtServices, MistakeStage, Student, StudentClassPeriod,
} from '../../shared/contracts/bank-types.js';
import { createBankService } from '../services/BankServiceFactory.js';
import { createBankExtServices } from '../services/BankExtServiceFactory.js';
import { renderMath, rewriteDataAssetSrcs } from '../../docgen/render/buildPaperHtml.core.js';
import { getUserDataAssetsRoot } from '../services/paths.js';
import { Mascot } from '../components/Mascot.js';

/** 页面服务集合：ext 走 0003 工厂，bank 走既有工厂（考试登记页勾错题需读题/卷） */
export interface ExtPageServices {
  bank: BankService;
  ext: BankExtServices;
}

/** 注入优先（测试双跑），否则按环境取真实 client（Electron）/mock（浏览器 demo） */
export function useExtPageServices(injected?: ExtPageServices): ExtPageServices {
  return useMemo(
    () => injected ?? { bank: createBankService(), ext: createBankExtServices() },
    [injected],
  );
}

export interface PageMessage {
  type: 'success' | 'error';
  text: string;
}

/** 消息提示条（0010 收编 notice 组件风格：success=notice-green / error=notice-red；IPC 失败必须可见，不允许静默） */
export function MessageBanner({ message }: { message: PageMessage | null }) {
  if (!message) return null;
  return (
    <div
      data-testid="page-message"
      data-type={message.type}
      role="status"
      className={message.type === 'success' ? 'notice notice-green' : 'notice notice-red'}
      style={{ margin: '0.75rem 0' }}
    >
      {message.text}
    </div>
  );
}

/** 轻量弹层（0010 收编 modal 组件风格：遮罩 + 便签卡 + 虚线分隔头/脚；点击遮罩关闭） */
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2 className="modal-title">{title}</h2>
          <button type="button" className="modal-close" aria-label="关闭" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

/**
 * 0046 P1：统一读条（theme.css `.progress-shell`/`.progress-track` 不定态动画，全站同一外观）。
 * label 自带阶段文案与「第 i/n」进度。样式零新增（复用全局类，不造自造条）。
 */
export function ProgressNote({ label, testid }: { label: string; testid: string }) {
  return (
    <div className="progress-shell" data-testid={testid} role="status">
      <span>{label}</span>
      <span className="progress-track"><i /></span>
    </div>
  );
}

/** 空状态（0010 统一收编 + 0010-merge P3.11 位图吉祥物：默认站立 stand，失败/异常场景可传 lost） */
export function EmptyState({ children, mood = 'stand' }: { children: ReactNode; mood?: 'stand' | 'lost' }) {
  return (
    <div className="empty">
      <Mascot mood={mood} size={64} />
      <div className="empty-text">{children}</div>
    </div>
  );
}

/** 表单字段（label + 控件纵排） */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: 'block', marginBottom: '0.75rem' }}>
      <div className="field-label">{label}</div>
      {children}
    </label>
  );
}

export const STAGE_LABEL: Record<MistakeStage, string> = { red: '红·未掌握', yellow: '黄·订正过', green: '绿·已掌握' };

/** 红黄绿状态灯（U2 语义：红=当前错题 / 黄=订正做对过一次 / 绿=已掌握；色值同 app.css .stage-lamp） */
export function StageLamp({ stage }: { stage: MistakeStage }) {
  return (
    <span data-testid="stage-lamp" data-stage={stage} className={`stage-lamp ${stage}`} title={STAGE_LABEL[stage]} />
  );
}

/** 错题快照 HTML 渲染：KaTeX 公式 + data-assets 资产根解析（照 CapturePage 预览同源管线） */
export function renderQuestionHtml(html: string): string {
  return rewriteDataAssetSrcs(renderMath(html), getUserDataAssetsRoot());
}

/**
 * 页头（返回链接 + 标题 + 动作区；0010 收编 page-head 组件风格，衬线标题）。
 * 0011 §一.7：backHref 增函数形态（动态化支持）——调用点可按运行时状态（如 from 参数）计算返回目标；
 * 字符串形态行为不变，既有调用点零破坏。
 * 0011 目检返工三：backLabel 可定制返回文案（组卷各页统一「← 返回试卷列表」），缺省仍「← 返回」。
 */
export function PageHeader({ title, backHref, backLabel, actions }: { title: string; backHref?: string | (() => string); backLabel?: string; actions?: ReactNode }) {
  const resolvedBackHref = typeof backHref === 'function' ? backHref() : backHref;
  return (
    <div className="page-head">
      <div>
        {resolvedBackHref && (
          <div style={{ marginBottom: 6 }}>
            <a className="page-back" href={resolvedBackHref}>← {backLabel ?? '返回'}</a>
          </div>
        )}
        <h1 className="page-title" style={{ fontSize: '1.5rem' }}>{title}</h1>
      </div>
      {actions && <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>{actions}</div>}
    </div>
  );
}

/**
 * 班级名册组合查询：getClassStudents 在 renderer 桥上无独立通道（0002 冻结的 student.* 仅 10 通道），
 * 经 student.list({classId}) + student.getClasses 两通道组合还原「成员 + 各自在该班的时期」。
 * 真实桥（IpcExtClient）与 mock 双跑一致。
 */
export interface ClassMemberEntry {
  student: Student;
  /** 该学生在本班的全部时期（endedAt 空 = 在读） */
  periods: StudentClassPeriod[];
}

export async function loadClassMembers(svc: ExtPageServices, classId: string): Promise<ClassMemberEntry[]> {
  const members = await svc.ext.student.listStudents({ classId, includeArchived: true });
  return Promise.all(
    members.map(async (student) => ({
      student,
      periods: (await svc.ext.student.getStudentClasses(student.id)).filter((p) => p.classId === classId),
    })),
  );
}

/** 两步确认按钮：第一次点击进入待确认态，再点执行（Electron renderer 禁 confirm()）。
 * 0010：待确认态改走 .btn-confirm.armed 类（theme.css 接 --brick 变量），不再写死颜色 */
export function ConfirmButton({
  label, confirmLabel, onConfirm, disabled, testid,
}: { label: string; confirmLabel: string; onConfirm: () => void; disabled?: boolean; testid?: string }) {
  const confirmState = useMemo(
    () => ({ armed: false }),
    [],
  );
  return (
    <button
      data-testid={testid}
      disabled={disabled}
      className="btn btn-sm btn-confirm"
      onClick={(e) => {
        const btn = e.currentTarget;
        if (!confirmState.armed) {
          confirmState.armed = true;
          btn.textContent = confirmLabel;
          btn.classList.add('armed');
        } else {
          onConfirm();
        }
      }}
    >
      {label}
    </button>
  );
}

/**
 * 0004 Phase 5（fix-1 返工单 #1 转入）：卷标题就地编辑——点标题变输入框，失焦/回车保存，
 * 样式不跳出页面（不用弹层）。保存走调用方传入的 onSave（updatePaperTitle 通道）；
 * 空标题拒绝保存并回调 onEmpty（UI 提示），输入框复原为当前标题。
 * 篮详情/排版间两处共用（交互形态一致）。
 * 0004-fix-2（只增）：openSignal 递增触发进入编辑态（页内 iframe 标题点编回传用）；
 * Esc 取消后焦点还原到标题（S5 §6-5 观感收口）。
 */
export function InlineTitleEditor({
  title, onSave, onEmpty, testid, openSignal,
}: {
  title: string;
  onSave: (next: string) => Promise<void> | void;
  onEmpty?: () => void;
  testid?: string;
  /** 递增信号：每次递增自动进入编辑态（0/undefined = 不启用） */
  openSignal?: number;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const [saving, setSaving] = useState(false);
  const titleRef = useRef<HTMLSpanElement | null>(null);
  const lastSignalRef = useRef(openSignal ?? 0);

  const startEdit = () => {
    setValue(title);
    setEditing(true);
  };

  useEffect(() => {
    const signal = openSignal ?? 0;
    if (signal > 0 && signal !== lastSignalRef.current) {
      lastSignalRef.current = signal;
      startEdit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSignal]);

  const commit = async () => {
    const next = value.trim();
    if (!next) {
      setEditing(false);
      onEmpty?.();
      return;
    }
    if (next === title) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onSave(next);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const cancelAndRestoreFocus = () => {
    setEditing(false);
    // S5 §6-5：Esc 取消后焦点还原标题（下一帧等输入框卸载后聚焦）
    window.setTimeout(() => titleRef.current?.focus(), 0);
  };

  if (editing) {
    return (
      <input
        className="input"
        data-testid={testid ? `${testid}-input` : undefined}
        value={value}
        disabled={saving}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commit();
          if (e.key === 'Escape') cancelAndRestoreFocus();
        }}
        autoFocus
        style={{ fontSize: '1.3rem', fontWeight: 'bold', padding: '0.1rem 0.4rem', width: 'min(420px, 60vw)' }}
      />
    );
  }
  return (
    <span
      ref={titleRef}
      data-testid={testid}
      title="点击重命名"
      onClick={() => startEdit()}
      tabIndex={-1}
      style={{ cursor: 'text', borderBottom: '1px dashed var(--line-strong)', outline: 'none' }}
    >
      {title}
    </span>
  );
}
