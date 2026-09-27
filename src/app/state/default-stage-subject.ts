// 0055（R-044 / D-074 批）：默认学段-学科设置——localStorage 单键偏好，仿 theme.ts 形态（零契约零迁移）。
//
// 用途：多数老师只教一个学段的一个科目（如高中物理）——设置一次，各页学段/学科选择器默认取该值（仍可改）。
// 优先级（任务书 §一.1 拍板②）：设置值 > 上次值（stage-subject 共享状态在会话内保留用户改动）> 空；
// 未设置 = 空（不打扰未设置用户，所有页面行为与改造前一致）。
// 生效时点：消费方**挂载/复位时**读取（不推送）——设置页改选影响之后进入的页面，避免正在编辑的页面被偷改。

export const DEFAULT_STAGE_SUBJECT_KEY = 'mfa-default-stage-subject';

export interface DefaultStageSubject {
  /** 学段自由文本（''=不设置） */
  stage: string;
  /** 字典归一学科条目 id（'subj:{code}'；''=不设置） */
  subjectId: string;
}

export const EMPTY_DEFAULT_STAGE_SUBJECT: DefaultStageSubject = { stage: '', subjectId: '' };

/** 解析缓存：以「原始串」为键——同值同引用（useSyncExternalStore 快照必须稳定，禁每次新对象） */
let cachedRaw: string | null | undefined;
let cachedValue: DefaultStageSubject = EMPTY_DEFAULT_STAGE_SUBJECT;

/** 任意存储值 → 合法设置（非法 JSON / 非对象 / 字段非字符串 → 空兜底，不抛） */
export function normalizeDefaultStageSubject(raw: string | null | undefined): DefaultStageSubject {
  if (!raw) return EMPTY_DEFAULT_STAGE_SUBJECT;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_DEFAULT_STAGE_SUBJECT;
  }
  if (typeof parsed !== 'object' || parsed === null) return EMPTY_DEFAULT_STAGE_SUBJECT;
  const { stage, subjectId } = parsed as { stage?: unknown; subjectId?: unknown };
  return {
    stage: typeof stage === 'string' ? stage : '',
    subjectId: typeof subjectId === 'string' ? subjectId : '',
  };
}

/** 当前设置（无存储/坏值/localStorage 不可用 → 空）；同存储串恒返回同一引用 */
export function readDefaultStageSubject(): DefaultStageSubject {
  try {
    if (typeof localStorage === 'undefined') return EMPTY_DEFAULT_STAGE_SUBJECT;
    const raw = localStorage.getItem(DEFAULT_STAGE_SUBJECT_KEY);
    if (raw === cachedRaw) return cachedValue;
    cachedRaw = raw;
    cachedValue = normalizeDefaultStageSubject(raw);
    return cachedValue;
  } catch {
    return EMPTY_DEFAULT_STAGE_SUBJECT;
  }
}

const listeners = new Set<() => void>();

/** 订阅设置变更（设置页改选后同会话内读数方可见；消费方按「挂载时读」口径取用） */
export function subscribeDefaultStageSubject(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** 写入设置（设置页改选即写；纯偏好不留痕）。localStorage 不可用 = 写不进（同 theme.ts 取舍） */
export function writeDefaultStageSubject(next: { stage: string; subjectId: string }): DefaultStageSubject {
  const value: DefaultStageSubject = { stage: next.stage, subjectId: next.subjectId };
  try {
    localStorage.setItem(DEFAULT_STAGE_SUBJECT_KEY, JSON.stringify(value));
  } catch {
    /* localStorage 不可用：本次改选仅停留在本页控件上 */
  }
  for (const listener of [...listeners]) listener();
  return value;
}

/**
 * 学段选项补全：把「选择器列表里没有的当前值」补进选项——设置默认「中职」等四值硬编码外的学段时，
 * 各页 select 不至于有值无项（显示成空档）；仅在确有该值时多一项，其余形态零变化。
 */
export function stageOptionsWith(options: readonly string[], current: string): string[] {
  return current && !options.includes(current) ? [...options, current] : [...options];
}
