// 0046 P4：rAF 节流器（SourcePane 拖动逐帧 setState 的减速带；纯逻辑，时钟可注入）。
//
// 语义（任务书 P4）：leading（拖动起点立即响应）+ trailing（帧回调补最后一值，帧间至多一次）；
// flush() 收尾同步落地 pending（pointerup 末帧必达）；dispose() 丢弃 pending——
// 收尾动作自带终值时（SourcePane 的 onUp 全部用事件坐标现算）用它防止滞后一帧的补帧覆盖终态。

export interface RafThrottle<A extends unknown[]> {
  (...args: A): void;
  /** pending 帧立即落地（收尾提交前调用：末帧必须不受节流影响） */
  flush(): void;
  /** 丢弃 pending 但**保持可用**（收尾自带终值时防补帧覆盖；下一次调用照常节流） */
  cancel(): void;
  /** 丢弃 pending 且永久停用（组件卸载/一次性拖拽会话收尾） */
  dispose(): void;
}

export interface RafThrottleClock {
  schedule(cb: () => void): number;
  cancel(id: number): void;
}

const RAF_CLOCK: RafThrottleClock = {
  schedule: (cb) => window.requestAnimationFrame(cb),
  cancel: (id) => window.cancelAnimationFrame(id),
};

export function createRafThrottle<A extends unknown[]>(
  fn: (...args: A) => void,
  clock: RafThrottleClock = RAF_CLOCK,
): RafThrottle<A> {
  let frameId: number | null = null;
  let lastArgs: A | null = null;
  let disposed = false;

  const invoke = (): void => {
    frameId = null;
    const args = lastArgs;
    lastArgs = null;
    if (args) fn(...args);
  };

  const throttle = (...args: A): void => {
    if (disposed) return;
    lastArgs = args;
    if (frameId === null) {
      // leading：帧起点立即执行一次，同时排下一帧兜底 trailing（帧内后续调用只更新 lastArgs）
      fn(...args);
      lastArgs = null;
      frameId = clock.schedule(invoke);
    }
  };

  throttle.flush = (): void => {
    if (disposed || frameId === null) return;
    clock.cancel(frameId);
    invoke();
  };

  throttle.cancel = (): void => {
    if (frameId !== null) clock.cancel(frameId);
    frameId = null;
    lastArgs = null;
  };

  throttle.dispose = (): void => {
    throttle.cancel();
    disposed = true;
  };

  return throttle as RafThrottle<A>;
}
