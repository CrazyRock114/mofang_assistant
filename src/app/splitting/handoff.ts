// 0036 P4：录题页 → 切题工作区的素材交接（跨路由一次性传递）
//
// 为什么不用路由参数：拖进来的是 File 对象（含字节），塞进 hash 要么序列化爆长度、要么落盘绕一圈。
// 一次性的内存交接最简单也最诚实——**取走即清空**，避免下次手动进工作区时把上次的 PDF 又翻出来。
//
// 同批拖入的图片不静默丢：notice 把「哪些没被处理」带给工作区显示（R-028 的「不静默失败」原则）。

/** 交接有效期：超时视为过期（用户中途走开又回来，不该突然冒出一个 PDF） */
export const HANDOFF_TTL_MS = 10 * 60 * 1000;

export interface SplitHandoff {
  files: File[];
  /** 同批拖入但本工作区不处理的素材说明（如混在其中的图片）；null = 没有 */
  notice: string | null;
  at: number;
}

let pending: SplitHandoff | null = null;
let now: () => number = () => Date.now();

/** 测试注入时钟（避免用例依赖真实时间） */
export function setHandoffClock(clock: () => number): void {
  now = clock;
}

export function putPendingPdf(files: File[], notice: string | null = null): void {
  pending = { files, notice, at: now() };
}

/** 查看但不消费（工作区挂载时先看一眼，决定是否显示导入提示） */
export function peekPendingPdf(): SplitHandoff | null {
  if (!pending) return null;
  if (now() - pending.at > HANDOFF_TTL_MS) {
    pending = null;
    return null;
  }
  return pending;
}

/** 取走（消费一次即清空） */
export function takePendingPdf(): SplitHandoff | null {
  const value = peekPendingPdf();
  pending = null;
  return value;
}

export function clearPendingPdf(): void {
  pending = null;
}
