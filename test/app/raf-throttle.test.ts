// 0046 P4：rAF 节流纯逻辑（SourcePane 两处拖动逐帧 setState 的节流器）。
// 语义（任务书 P4）：leading（首帧立即）+ trailing（帧回调补最后值）；flush 收尾同步落地（末帧必达）；
// dispose 丢弃 pending（收尾自带终值时不许再补帧）。时钟可注入（测试不依赖真 rAF）。

import { describe, it, expect } from 'vitest';
import { createRafThrottle } from '../../src/app/workbench/raf-throttle.js';

/** 假 rAF 时钟：手动推进帧回调（每帧一个待执行回调队列） */
function makeClock() {
  let seq = 0;
  const queue = new Map<number, () => void>();
  return {
    schedule: (cb: () => void): number => {
      seq += 1;
      queue.set(seq, cb);
      return seq;
    },
    cancel: (id: number): void => { queue.delete(id); },
    /** 推进一帧：执行当前所有待回调（含帧内新排的留给下一帧） */
    tick: (): void => {
      const batch = [...queue.entries()];
      queue.clear();
      for (const [, cb] of batch) cb();
    },
    get pending(): number { return queue.size; },
  };
}

describe('0046 P4：createRafThrottle', () => {
  it('leading：首次调用立即执行（不等帧回调）', () => {
    const clock = makeClock();
    const seen: number[] = [];
    const throttle = createRafThrottle<number>((v) => seen.push(v), clock);
    throttle(1);
    expect(seen).toEqual([1]);
    clock.tick();
    expect(seen).toEqual([1]); // leading 已执行，不再重复
    throttle.dispose();
  });

  it('trailing：同帧多次调用只保留最后值，帧回调执行一次', () => {
    const clock = makeClock();
    const seen: number[] = [];
    const throttle = createRafThrottle<number>((v) => seen.push(v), clock);
    throttle(1);          // leading 执行
    throttle(2);          // 同帧：记下，不执行
    throttle(3);          // 同帧：覆盖
    expect(seen).toEqual([1]);
    expect(clock.pending).toBe(1);
    clock.tick();
    expect(seen).toEqual([1, 3]);
    throttle.dispose();
  });

  it('连发多帧：每帧至多一次，逐帧落地（拖动流畅不丢中间态）', () => {
    const clock = makeClock();
    const seen: number[] = [];
    const throttle = createRafThrottle<number>((v) => seen.push(v), clock);
    throttle(1);
    throttle(2);
    clock.tick();          // 帧1：落 2
    throttle(3);
    clock.tick();          // 帧2：落 3
    throttle(4);
    clock.tick();          // 帧3：落 4
    expect(seen).toEqual([1, 2, 3, 4]);
    throttle.dispose();
  });

  it('flush：pending 帧取消、最后值同步落地（pointerup 收尾末帧必达）', () => {
    const clock = makeClock();
    const seen: number[] = [];
    const throttle = createRafThrottle<number>((v) => seen.push(v), clock);
    throttle(1);
    throttle(9);
    expect(seen).toEqual([1]);
    throttle.flush();
    expect(seen).toEqual([1, 9]);
    expect(clock.pending).toBe(0);
    clock.tick();
    expect(seen).toEqual([1, 9]); // 帧回调不再重复
    throttle.dispose();
  });

  it('dispose：pending 丢弃不执行（收尾自带终值时防补帧覆盖）', () => {
    const clock = makeClock();
    const seen: number[] = [];
    const throttle = createRafThrottle<number>((v) => seen.push(v), clock);
    throttle(1);
    throttle(2);
    throttle.dispose();
    expect(clock.pending).toBe(0);
    clock.tick();
    expect(seen).toEqual([1]);
    // dispose 后再调用不执行不排帧
    throttle(3);
    expect(clock.pending).toBe(0);
    expect(seen).toEqual([1]);
  });

  it('cancel：丢弃 pending 但保持可用——下一次拖动照常节流（目检返工①：第二次拖框失效根因）', () => {
    const clock = makeClock();
    const seen: number[] = [];
    const throttle = createRafThrottle<number>((v) => seen.push(v), clock);
    throttle(1);
    throttle(2);
    throttle.cancel();          // 第一次拖动收尾：丢滞后帧
    expect(clock.pending).toBe(0);
    clock.tick();
    expect(seen).toEqual([1]);
    throttle(3);                // 第二次拖动：leading 照常立即执行
    expect(seen).toEqual([1, 3]);
    throttle(4);                // 同帧 trailing 照常
    clock.tick();
    expect(seen).toEqual([1, 3, 4]);
    throttle.dispose();
  });

  it('无 pending 时 flush / dispose 幂等无害', () => {
    const clock = makeClock();
    const seen: number[] = [];
    const throttle = createRafThrottle<number>((v) => seen.push(v), clock);
    throttle(1);
    throttle.flush();
    throttle.flush();
    throttle.dispose();
    throttle.dispose();
    expect(seen).toEqual([1]);
  });
});
