// 0036 P1：页图 LRU 缓存（纯逻辑）——大 PDF 内存上限的落点（规划 T7 风险项「大 PDF 内存」）
//
// 为什么必须限：A4@scale2 的 PNG 解码位图约 12–20MB（2480×3508×4B），整本教辅 200 页无上限缓存
// 必然把渲染进程撑爆。竞品只缓存 4 张 base64；这里取 6 张并按字节双限（防止页图尺寸差异过大时失控）。
//
// 缓存键带 **renderPolicy**（页号@缩放档）：换缩放档/渲染策略时旧位图自动失效，不会被误当命中
// （对标竞品的 renderPolicy id 失效语义）。

/** 页图缓存条数上限（同时受 PAGE_CACHE_MAX_BYTES 约束） */
export const PAGE_CACHE_LIMIT = 6;
/** 页图缓存字节上限（约 3 张满幅 A4@scale2 位图；超出即逐出最久未用） */
export const PAGE_CACHE_MAX_BYTES = 96 * 1024 * 1024;

export interface LruCache<K, V> {
  get(key: K): V | undefined;
  set(key: K, value: V): void;
  has(key: K): boolean;
  delete(key: K): boolean;
  size(): number;
  /** 由旧到新（诊断/测试用） */
  keys(): K[];
  clear(): void;
}

/**
 * 经典 LRU：Map 的插入序即最近使用序，get 命中时先删后插把它提到最新。
 * 不引第三方库——20 行能写对的东西不值得多一个依赖（任务书 §二：除 pdfjs-dist 零新依赖）。
 */
export function createLruCache<K, V>(limit: number): LruCache<K, V> {
  const cap = Math.max(1, Math.floor(limit));
  const map = new Map<K, V>();
  return {
    get(key: K): V | undefined {
      if (!map.has(key)) return undefined;
      const value = map.get(key);
      map.delete(key);
      map.set(key, value as V);
      return value;
    },
    set(key: K, value: V): void {
      if (map.has(key)) map.delete(key);
      map.set(key, value);
      while (map.size > cap) {
        const oldest = map.keys().next();
        if (oldest.done) break;
        map.delete(oldest.value);
      }
    },
    has: (key: K) => map.has(key),
    delete: (key: K) => map.delete(key),
    size: () => map.size,
    keys: () => [...map.keys()],
    clear: () => map.clear(),
  };
}

/** 页图缓存键：页号 @ 渲染档（缩放档变更即失效） */
export function renderPolicyKey(page: number, scale: number): string {
  return `p${page}@s${scale}`;
}

export interface CachedPageImage {
  /** 该页位图字节（PNG 字节数，用于内存水位与 S-2 实测记录） */
  bytes: number;
  /** 渲染档签名（page@scale） */
  key: string;
}

export interface PageImageCache<V extends CachedPageImage> {
  get(page: number, scale: number): V | undefined;
  set(page: number, scale: number, value: V): void;
  /** 当前缓存字节合计（S-2 内存曲线采样点） */
  bytes(): number;
  /** 当前缓存条数 */
  size(): number;
  clear(): void;
}

/**
 * 页图缓存：条数 + 字节双限。字节优先逐出（一次 get 之后重新计数），
 * 这样「一页超大图把额度吃光」不会变成「缓存里只剩一页但也不释放」。
 */
export function createPageImageCache<V extends CachedPageImage>(
  limit = PAGE_CACHE_LIMIT,
  maxBytes = PAGE_CACHE_MAX_BYTES,
): PageImageCache<V> {
  const lru = createLruCache<string, V>(limit);

  const evictToBudget = (): void => {
    while (lru.size() > 1) {
      let total = 0;
      for (const key of lru.keys()) total += lru.get(key)?.bytes ?? 0;
      if (total <= maxBytes) return;
      const oldest = lru.keys()[0];
      lru.delete(oldest);
    }
  };

  return {
    get(page: number, scale: number): V | undefined {
      return lru.get(renderPolicyKey(page, scale));
    },
    set(page: number, scale: number, value: V): void {
      lru.set(renderPolicyKey(page, scale), value);
      evictToBudget();
    },
    bytes(): number {
      let total = 0;
      for (const key of lru.keys()) total += lru.get(key)?.bytes ?? 0;
      return total;
    },
    size: () => lru.size(),
    clear: () => lru.clear(),
  };
}
