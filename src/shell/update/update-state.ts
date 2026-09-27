// 0072（只增）：更新链纯逻辑（零 electron、零 electron-updater 依赖——vitest 直测）。
//  - 节流判定：update-state.json 记 lastCheckAt，<24h 跳过启动自动检查（手动 checkNow 不经此判）；
//  - 慢速判定：download-progress 事件喂 SpeedTracker 滚动窗口——持续 <150KB/s 满 30s → slowHint
//   （2026-09-25 用户拍板：不自动取消、不自动转向，仅 UI 非阻塞提示）；
//  - 状态机：adapter 事件 → UpdateStatus 归约。manual 口径：仅「用户主动检查（checkNow）之后、
//   尚未落定（available/not-available/error/downloaded）」期间发生的失败对 UI 可见
//   （连续自动检查失败不提示）；落定即清标志，不泄漏到下一轮。
// 版本比较语义不自实现（electron-updater 自带，任务书 §一.5）。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { UpdatePhase, UpdateStatus } from '../../shared/contracts/distribution-types.js';

/** 启动自动检查的最小间隔（24h） */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** 慢速阈值：150KB/s */
export const SLOW_SPEED_THRESHOLD_BPS = 150 * 1024;
/** 慢速判定窗口：持续满 30s 才置 slowHint */
export const SLOW_WINDOW_MS = 30_000;

/** update-state.json 形态（<userData>/update-state.json；坏/缺文件 = {} 宽容重启） */
export interface UpdatePersistState {
  lastCheckAt?: string;
}

/** 节流判定：无记录/坏串 → 查；<24h → 跳过；>=24h → 查；未来时间戳（时钟回拨）→ 跳过（不连环查） */
export function shouldCheckNow(
  lastCheckAt: string | null | undefined,
  now: number,
  intervalMs: number = UPDATE_CHECK_INTERVAL_MS,
): boolean {
  if (typeof lastCheckAt !== 'string' || lastCheckAt === '') return true;
  const last = Date.parse(lastCheckAt);
  if (Number.isNaN(last)) return true;
  return now - last >= intervalMs;
}

/** 读节流持久化（缺文件/坏 JSON/非对象 → {}） */
export function readUpdatePersistState(path: string): UpdatePersistState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null) return parsed as UpdatePersistState;
    return {};
  } catch {
    return {};
  }
}

/** 写节流持久化（临时文件 + rename 防半截，0071 先例） */
export function writeUpdatePersistState(path: string, state: UpdatePersistState): void {
  const tmpPath = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf8');
  renameSync(tmpPath, path);
}

/** electron-updater 事件语义 → 中立事件形态（adapter 负责映射，状态机只认本形态） */
export type UpdaterEvent =
  | { type: 'checking' }
  | { type: 'available'; version: string }
  | { type: 'not-available' }
  | { type: 'progress'; percent: number; bytesPerSecond: number; transferred: number; total: number }
  | { type: 'downloaded'; version?: string }
  | { type: 'error'; message: string };

/**
 * 滚动窗口速度追踪：sample(累计字节, 时刻) 由 download-progress 事件喂；
 * isSlow() = 窗口（最近 SLOW_WINDOW_MS）已填满 且 窗口内平均速度 < SLOW_SPEED_THRESHOLD_BPS。
 * 样本稀疏（30s 只有两个点）同样成立；零进度（卡死）满窗口判慢。
 */
export class SpeedTracker {
  private samples: Array<{ at: number; bytes: number }> = [];

  sample(totalBytes: number, atMs: number): void {
    this.samples.push({ at: atMs, bytes: totalBytes });
    // 只留窗口（含一小段余量）内样本，防长下载内存无界
    const cutoff = atMs - SLOW_WINDOW_MS - 60_000;
    while (this.samples.length > 2 && this.samples[0].at < cutoff) this.samples.shift();
  }

  isSlow(): boolean {
    if (this.samples.length < 2) return false;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const elapsed = last.at - first.at;
    if (elapsed < SLOW_WINDOW_MS) return false;
    const bytes = last.bytes - first.bytes;
    return bytes / (elapsed / 1000) < SLOW_SPEED_THRESHOLD_BPS;
  }

  reset(): void {
    this.samples = [];
  }
}

/** 更新状态机：adapter 事件 → UpdateStatus 归约 + manual 标志管理。 */
export class UpdateStateMachine {
  private current: UpdateStatus = { phase: 'idle' };
  /** 内部 manual 标志：markManual 置位，任一落定事件清零 */
  private manualFlag = false;
  private readonly tracker = new SpeedTracker();

  get status(): UpdateStatus {
    return this.current;
  }

  get phase(): UpdatePhase {
    return this.current.phase;
  }

  /** 用户主动检查开始（checkNow）——本轮落定前的失败标记 manual=true（UI 判据） */
  markManual(): void {
    this.manualFlag = true;
  }

  apply(event: UpdaterEvent, atMs?: number): UpdateStatus {
    switch (event.type) {
      case 'checking':
        this.tracker.reset();
        // 新一轮检查：清上一轮残留（version/error/slowHint）；manual 标志保留（本轮是否用户触发）
        this.current = { phase: 'checking', manual: this.manualFlag };
        break;
      case 'available':
        this.current = { phase: 'available', version: event.version };
        this.manualFlag = false;
        break;
      case 'not-available':
        this.current = { phase: 'not-available' };
        this.manualFlag = false;
        break;
      case 'progress': {
        this.tracker.sample(event.transferred, atMs ?? 0);
        this.current = {
          phase: 'downloading',
          version: this.current.version,
          percent: event.percent,
          speedBps: event.bytesPerSecond,
          slowHint: this.tracker.isSlow(),
        };
        break;
      }
      case 'downloaded':
        this.current = { phase: 'downloaded', version: event.version ?? this.current.version };
        this.manualFlag = false;
        break;
      case 'error':
        // error 的 status.manual = 标志值本身（UI 仅在 true 时提示失败）；落定即清标志
        this.current = { phase: 'error', error: event.message, manual: this.manualFlag };
        this.manualFlag = false;
        break;
    }
    return this.current;
  }
}
