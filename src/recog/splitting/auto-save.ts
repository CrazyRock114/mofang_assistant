// 0036 P1：草稿自动保存（1.5s 防抖）——纯逻辑（注入 save/timer，可直接单测，不依赖 DOM）
//
// 语义要点：
//   - **同值不重存**由调用方决定（这里只管节流），但「保存中又来新值」必须排队而不是并发写盘（防后写覆盖前写）。
//   - flush() 是幂等的：没有待存值时返回当前写链，调用方在切段/关页/失焦时都能安全调用。
//   - 失败不吞：状态停在 error 并把原因交给 UI（草稿写不进去必须让用户看见，否则工作成果静默蒸发）。

/** 任务书 §一 P1：草稿 1.5s 防抖自动存 */
export const DRAFT_SAVE_DEBOUNCE_MS = 1500;

export type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

export interface DebouncedSaverOptions<T> {
  save(value: T): Promise<void>;
  delayMs?: number;
  /** 注入时钟（测试与「最后保存时刻」展示用） */
  now?: () => string;
  onState?: (state: SaveState, error: string | null) => void;
}

export interface DebouncedSaver<T> {
  /** 排入待存值（覆盖上一个待存值，重新计时） */
  schedule(value: T): void;
  /** 立刻落盘并可等待（切段/关页/失焦） */
  flush(): Promise<void>;
  /** 有待存值或计时器在跑 */
  pending(): boolean;
  state(): SaveState;
  lastError(): string | null;
  /** 最近一次保存成功时刻（ISO；UI「已保存」文案用） */
  lastSavedAt(): string | null;
  dispose(): void;
}

export function createDebouncedSaver<T>(options: DebouncedSaverOptions<T>): DebouncedSaver<T> {
  const delay = options.delayMs ?? DRAFT_SAVE_DEBOUNCE_MS;
  const now = options.now ?? ((): string => new Date().toISOString());

  let latest: T | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();
  let currentState: SaveState = 'idle';
  let lastError: string | null = null;
  let lastSaved: string | null = null;

  const setState = (next: SaveState, error: string | null = null): void => {
    currentState = next;
    lastError = error;
    options.onState?.(next, error);
  };

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const enqueue = (value: T): Promise<void> => {
    setState('saving');
    chain = chain.then(async () => {
      try {
        await options.save(value);
        lastSaved = now();
        setState('saved');
      } catch (err) {
        setState('error', err instanceof Error ? err.message : String(err));
      }
    });
    return chain;
  };

  const flush = (): Promise<void> => {
    clearTimer();
    if (latest !== null) {
      const value = latest;
      latest = null;
      void enqueue(value);
    }
    return chain;
  };

  return {
    schedule(value: T): void {
      latest = value;
      setState('pending');
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        void flush();
      }, delay);
    },
    flush,
    pending: () => latest !== null || timer !== null,
    state: () => currentState,
    lastError: () => lastError,
    lastSavedAt: () => lastSaved,
    dispose(): void {
      clearTimer();
    },
  };
}
