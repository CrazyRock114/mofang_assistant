// 0036 P1：源 PDF 的分块传输（渲染层侧）——bytes ⇄ base64 与分段循环
//
// 为什么要分块：整本教辅 PDF 常有数十 MB，一次性 base64 过桥会把一条 IPC 消息撑到百 MB 级
// （结构化克隆 + 字符串编码的峰值内存是文件体积的数倍）。分块把单条消息钉在 4MB，
// 且天然可续（offset 由宿主校验，错位即拒绝）。
//
// 浏览器 demo 与 Electron 走同一条路径：base64 编解码只用 atob/btoa，不依赖 Node Buffer。

import type { MofangSplitBridge } from '../../shared/contracts/bridge.js';

/** 单块字节数（与主进程 SOURCE_*_MAX_BYTES=8MB 留一倍余量：块小则进度粒度细） */
export const SOURCE_CHUNK_BYTES = 4 * 1024 * 1024;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000; // 分块避免 apply 参数上限（同 app/recog/intake.ts 的 toBase64）
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(dataBase64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(dataBase64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export type ProgressFn = (doneBytes: number, totalBytes: number) => void;

/** 分块参数（测试注入小块避免真的编 4MB base64；生产恒用 SOURCE_CHUNK_BYTES） */
export interface ChunkOptions {
  chunkBytes?: number;
  onProgress?: ProgressFn;
}

/** 分块上传源 PDF（顺序 append；宿主侧 offset 校验保证不乱序） */
export async function uploadSourceBytes(
  split: MofangSplitBridge,
  projectId: string,
  bytes: Uint8Array,
  options: ChunkOptions = {},
): Promise<void> {
  const chunkBytes = options.chunkBytes ?? SOURCE_CHUNK_BYTES;
  if (bytes.length === 0) throw new Error('源 PDF 为空（0 字节文件不是有效素材）');
  let offset = 0;
  while (offset < bytes.length) {
    const end = Math.min(bytes.length, offset + chunkBytes);
    await split.appendSource({
      projectId,
      offset,
      dataBase64: bytesToBase64(bytes.subarray(offset, end)),
    });
    offset = end;
    options.onProgress?.(offset, bytes.length);
  }
}

/**
 * 分块读回源 PDF（重开项目后重新栅格化用）。
 * 完整性双向校验：宿主给的字节总数必须等于项目登记的 sourceBytes——截断的 PDF 渲染出来会静默少页，
 * 那比直接报错难查得多。
 */
export async function readSourceBytes(
  split: MofangSplitBridge,
  projectId: string,
  expectedBytes: number,
  options: ChunkOptions = {},
): Promise<Uint8Array> {
  const chunkBytes = options.chunkBytes ?? SOURCE_CHUNK_BYTES;
  const parts: Uint8Array[] = [];
  let offset = 0;
  for (;;) {
    const chunk = await split.readSource({ projectId, offset, length: chunkBytes });
    const bytes = base64ToBytes(chunk.dataBase64);
    if (bytes.length === 0) break;
    parts.push(bytes);
    offset += bytes.length;
    options.onProgress?.(offset, expectedBytes > 0 ? expectedBytes : offset);
    if (chunk.eof) break;
  }
  if (offset === 0) throw new Error('工作区里没有源文件（source.pdf 缺失或为空），请重新导入 PDF');
  if (expectedBytes > 0 && offset !== expectedBytes) {
    throw new Error(`源文件不完整：登记 ${expectedBytes} 字节，实际读到 ${offset} 字节（请重新导入）`);
  }
  const out = new Uint8Array(offset);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}
