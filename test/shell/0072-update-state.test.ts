// 0072（R-073 发布批 lane A）：更新链纯逻辑 ——
// 节流判定（lastCheckAt 边界）+ 慢速判定（滚动窗口速度，<150KB/s 满 30s）+
// 状态机归约（事件 → UpdateStatus；manual 标志口径：仅用户主动检查后的失败对 UI 可见）。
// 版本比较语义不自实现（electron-updater 自带——探针面覆盖），此处零重复实现。
//
// 环境：node；纯函数/类直测。

import { describe, it, expect } from 'vitest';

import {
  UPDATE_CHECK_INTERVAL_MS,
  shouldCheckNow,
  SpeedTracker,
  UpdateStateMachine,
} from '../../src/shell/update/update-state.js';

const HOUR = 60 * 60 * 1000;

// ---------------- 节流判定 ----------------

describe('0072 shouldCheckNow（24h 节流边界）', () => {
  it('无记录（null/undefined）→ 查', () => {
    expect(shouldCheckNow(null, 1_000_000)).toBe(true);
    expect(shouldCheckNow(undefined, 1_000_000)).toBe(true);
  });

  it('坏串（不可解析）→ 查（宽容重启）', () => {
    expect(shouldCheckNow('not-a-date', 1_000_000)).toBe(true);
  });

  it('刚查过（<24h）→ 跳过', () => {
    const now = 10 * HOUR;
    expect(shouldCheckNow(new Date(now - 1 * HOUR).toISOString(), now)).toBe(false);
  });

  it('超过 24h → 查', () => {
    const now = 30 * HOUR;
    expect(shouldCheckNow(new Date(now - 25 * HOUR).toISOString(), now)).toBe(true);
  });

  it('恰好 24h（== 间隔）→ 查（不欠账）', () => {
    const now = 24 * HOUR;
    expect(shouldCheckNow(new Date(0).toISOString(), now)).toBe(true);
  });

  it('间隔常量 = 24h', () => {
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(24 * HOUR);
  });

  it('未来时间戳（时钟回拨）→ 跳过（不连环查）', () => {
    const now = 10 * HOUR;
    expect(shouldCheckNow(new Date(now + 5 * HOUR).toISOString(), now)).toBe(false);
  });
});

// ---------------- 慢速判定（滚动窗口） ----------------

describe('0072 SpeedTracker（持续 <150KB/s 满 30s → slow）', () => {
  const KB = 1024;
  const SLOW_BPS = 150 * KB;

  it('快速下载（>150KB/s）→ 不 slow（即便窗口未满）', () => {
    const t = new SpeedTracker();
    t.sample(0, 0);
    t.sample(4000 * KB, 10_000); // 400KB/s > 150KB/s
    expect(t.isSlow()).toBe(false);
  });

  it('慢速不足 30s → 不 slow（未满窗口）', () => {
    const t = new SpeedTracker();
    t.sample(0, 0);
    t.sample(1 * KB, 29_000); // ~35B/s 但窗口未满 30s
    expect(t.isSlow()).toBe(false);
  });

  it('慢速满 30s → slow', () => {
    const t = new SpeedTracker();
    t.sample(0, 0);
    t.sample(1500 * KB, 31_000); // 1500KB/31s ≈ 48KB/s < 150KB/s
    expect(t.isSlow()).toBe(true);
  });

  it('先慢后快（窗口内均速恢复超阈值）→ 恢复不 slow', () => {
    const t = new SpeedTracker();
    t.sample(0, 0);
    t.sample(100 * KB, 10_000); // 慢
    t.sample(5_000 * KB, 31_000); // 窗口 0→31s 均速 ≈161KB/s > 150KB/s
    expect(t.isSlow()).toBe(false);
  });

  it('样本稀疏（30s 只有两个点）也成立', () => {
    const t = new SpeedTracker();
    t.sample(0, 0);
    t.sample(1 * KB, 30_500);
    expect(t.isSlow()).toBe(true);
  });

  it('零进度（卡死不动）满窗口 → slow', () => {
    const t = new SpeedTracker();
    t.sample(100 * KB, 0);
    t.sample(100 * KB, 31_000);
    expect(t.isSlow()).toBe(true);
  });
});

// ---------------- 状态机归约 ----------------

describe('0072 UpdateStateMachine', () => {
  it('初始态 idle', () => {
    const m = new UpdateStateMachine();
    expect(m.status.phase).toBe('idle');
  });

  it('checking → available（version 记录）', () => {
    const m = new UpdateStateMachine();
    m.apply({ type: 'checking' });
    expect(m.status.phase).toBe('checking');
    m.apply({ type: 'available', version: '1.0.1' });
    expect(m.status.phase).toBe('available');
    expect(m.status.version).toBe('1.0.1');
  });

  it('available → downloading（progress 带 percent/speedBps；slowHint 初始 false）', () => {
    const m = new UpdateStateMachine();
    m.apply({ type: 'available', version: '1.0.1' });
    const s = m.apply({ type: 'progress', percent: 12.5, bytesPerSecond: 900 * 1024, transferred: 100, total: 800 });
    expect(s.phase).toBe('downloading');
    expect(s.percent).toBe(12.5);
    expect(s.speedBps).toBe(900 * 1024);
    expect(s.slowHint).toBe(false);
    expect(s.version).toBe('1.0.1');
  });

  it('progress 慢速满窗口 → slowHint=true（不改变相位，不自动停）', () => {
    const m = new UpdateStateMachine();
    m.apply({ type: 'available', version: '1.0.1' });
    const slow = m.apply({ type: 'progress', percent: 1, bytesPerSecond: 40 * 1024, transferred: 0, total: 800 }, 0);
    expect(slow.slowHint).toBe(false);
    const stillDownloading = m.apply(
      { type: 'progress', percent: 2, bytesPerSecond: 40 * 1024, transferred: 16, total: 800 },
      31_000,
    );
    expect(stillDownloading.phase).toBe('downloading');
    expect(stillDownloading.slowHint).toBe(true);
  });

  it('downloaded 落定（version 保留）', () => {
    const m = new UpdateStateMachine();
    m.apply({ type: 'available', version: '1.0.1' });
    m.apply({ type: 'progress', percent: 99, bytesPerSecond: 1e6, transferred: 799, total: 800 });
    const s = m.apply({ type: 'downloaded', version: '1.0.1' });
    expect(s.phase).toBe('downloaded');
    expect(s.version).toBe('1.0.1');
  });

  it('not-available 落定', () => {
    const m = new UpdateStateMachine();
    m.apply({ type: 'checking' });
    const s = m.apply({ type: 'not-available' });
    expect(s.phase).toBe('not-available');
  });

  it('error：自动检查失败 manual=false（UI 不可见），manual 检查失败 manual=true', () => {
    const m = new UpdateStateMachine();
    m.apply({ type: 'checking' });
    const autoFail = m.apply({ type: 'error', message: 'net down' });
    expect(autoFail.phase).toBe('error');
    expect(autoFail.manual).toBe(false);
    // 用户主动检查
    m.markManual();
    m.apply({ type: 'checking' });
    const manualFail = m.apply({ type: 'error', message: 'net down' });
    expect(manualFail.manual).toBe(true);
  });

  it('manual 标志在落定事件（available/not-available）后清零，不泄漏到下一轮', () => {
    const m = new UpdateStateMachine();
    m.markManual();
    m.apply({ type: 'checking' });
    m.apply({ type: 'not-available' });
    // 下一轮自动检查再失败 → manual=false
    m.apply({ type: 'checking' });
    const s = m.apply({ type: 'error', message: 'x' });
    expect(s.manual).toBe(false);
  });

  it('新一轮 checking 清旧 version/error/slowHint', () => {
    const m = new UpdateStateMachine();
    m.apply({ type: 'available', version: '1.0.1' });
    m.apply({ type: 'progress', percent: 5, bytesPerSecond: 10, transferred: 1, total: 10 }, 31_000);
    m.apply({ type: 'error', message: 'x' });
    const s = m.apply({ type: 'checking' });
    expect(s.phase).toBe('checking');
    expect(s.version).toBeUndefined();
    expect(s.error).toBeUndefined();
    expect(s.slowHint).toBeUndefined(); // 「清」= 不携带字段（UI 按真值判）
  });
});
