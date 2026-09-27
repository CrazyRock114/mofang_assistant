// 0024 P3（D-049 / P-12）：学段-学科共享状态（手写轻量模块，get/set/subscribe，零依赖不引 zustand）
//
// 用途：题库页顶栏的学段/学科是「AI 入口同源单状态」的唯一真源——挂树/打标/试卷分析/反馈等入口
// 后续都读这里（0028/0029/0030），不再各自建选择器。
//
// 生命周期（「行为零变化」的落点）：调用方挂载时 acquire、卸载时释放；最后一个持有者释放即复位默认。
// 等价于改造前的组件内 useState（离开题库页再回来仍是默认筛选），同时允许同页多个消费者共享同一状态。
// 该复位是刻意的：跨页残留会让「筛选态」泄漏到别的入口，也会让用例互相污染。
//
// 0055（R-044）：复位基准与起始值从「空」改为读设置页的默认学段学科（未设置仍回落空，行为不变）。
// 优先级（任务书 §一.1 拍板②）：设置值 > 上次值（会话内用户改动，持有者存活期间不动）> 空。

import { readDefaultStageSubject } from './default-stage-subject.js';

export interface StageSubjectState {
  stage: string;
  /** 字典条目 id（'subj:{code}'）；''=全部学科 */
  subjectId: string;
}

export const INITIAL_STAGE_SUBJECT: StageSubjectState = { stage: '', subjectId: '' };

/** 复位/起挂基准：设置页的默认学段学科（未设置 → 空常量本身，引用稳定） */
function defaultSlot(): StageSubjectState {
  const stored = readDefaultStageSubject();
  if (stored.stage === '' && stored.subjectId === '') return INITIAL_STAGE_SUBJECT;
  return { stage: stored.stage, subjectId: stored.subjectId };
}

let state: StageSubjectState = defaultSlot();
const listeners = new Set<() => void>();
let holders = 0;
/** 当前值是否仍处于「基准态」（=释放复位后的值）：只有基准态才在起挂时重读设置，
 *  否则会清掉空闲期被显式设置的值（「上次值」口径，见 0029 顶栏单真源用例） */
let atBaseline = true;

function emit(): void {
  for (const listener of [...listeners]) listener();
}

/** 回到基准（设置值或空）；同值不动引用、不发通知 */
function resetToDefaultSlot(): void {
  const target = defaultSlot();
  atBaseline = true;
  if (target.stage === state.stage && target.subjectId === state.subjectId) return;
  state = target;
  emit();
}

export function getStageSubject(): StageSubjectState {
  return state;
}

/** 局部更新：同值不动引用、不发通知（useSyncExternalStore 要求快照引用稳定） */
export function setStageSubject(patch: { stage?: string; subjectId?: string }): void {
  const next: StageSubjectState = {
    stage: patch.stage ?? state.stage,
    subjectId: patch.subjectId ?? state.subjectId,
  };
  if (next.stage === state.stage && next.subjectId === state.subjectId) return;
  state = next;
  atBaseline = false;
  emit();
}

export function subscribeStageSubject(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** 取用：返回释放函数（幂等）。最后一个持有者释放时状态复位 */
export function acquireStageSubject(): () => void {
  const idle = holders === 0;
  holders++;
  // 从零起挂且仍处基准态：重读一次设置（空闲期间用户在设置页改过默认 → 新页面即生效）
  if (idle && atBaseline) resetToDefaultSlot();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders = Math.max(0, holders - 1);
    if (holders > 0) return;
    resetToDefaultSlot();
  };
}
