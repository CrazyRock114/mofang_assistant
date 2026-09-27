// 0040 P2/P3：入口页 → 工作台的一次性图片交接（同 0036 putPendingPdf 思路：不序列化 File，不落路由）。
//
// 为什么需要：裁图（图块重裁 / 📋 复制框选）要在**送给模型的那张图**上做，且 canvas 只能导出
// 本次会话拖入的字节（file:// 读回的页图受 webSecurity 限制不可导出）。所以入口页把 File 原样
// 交给工作台，工作台按 runId 取用后即弃。

/** 入口页「默认归类」+ 卷名 → 工作台初始状态（2026-09-20 目检返工⑥：原先这条线没接通，
 *  工作台恒以空学科起步，挂树建议在 IPC 形验处就报「Invalid payload. subjectId」）。 */
export interface WorkbenchDefaults {
  stage: string;
  subjectId: string;
  paperTitle: string;
}

const pending = new Map<string, File[]>();
const pendingDefaults = new Map<string, WorkbenchDefaults>();

export function putPendingImages(runId: string, files: File[]): void {
  if (files.length === 0) return;
  pending.set(runId, [...files]);
}

export function putPendingDefaults(runId: string, defaults: WorkbenchDefaults): void {
  pendingDefaults.set(runId, defaults);
}

/** 取走默认归类（消费一次即清空：run 已落盘 workbench.json 后即由文件态接管） */
export function takePendingDefaults(runId: string): WorkbenchDefaults | null {
  const value = pendingDefaults.get(runId);
  if (!value) return null;
  pendingDefaults.delete(runId);
  return value;
}

export function takePendingImages(runId: string): File[] {
  const files = pending.get(runId);
  if (!files) return [];
  pending.delete(runId);
  return files;
}

export function peekPendingImages(runId: string): File[] {
  return pending.get(runId) ?? [];
}

/** 测试用：清空交接表（生产不调用） */
export function clearPendingImages(): void {
  pending.clear();
  pendingDefaults.clear();
}
