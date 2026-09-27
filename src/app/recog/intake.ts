// 0028 P2：录题页素材入口的取值层（拖拽 / Ctrl+V 粘贴 / 点选三入口 → 统一文件列表）
// 只做「DOM 事件 → File[] → base64 素材」的翻译；分类判定在 src/recog/material.ts（与主进程同一真源）。
// 用 File.arrayBuffer() 读字节（不依赖 Electron 的 File.path —— Electron 32 起已移除），
// 因而浏览器 demo 与 Electron 走同一条代码路径，不存在双轨漂移。

import type { RecogMaterial } from '../../shared/contracts/recog-run-types.js';

/** 粘贴进来的位图没有文件名：给稳定名（含序号）便于页序与错误定位 */
export function pastedFileName(index: number): string {
  return `粘贴图片-${index}.png`;
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/gif': 'gif',
};

/** 剪贴板等无名来源补扩展名（分类器按扩展名兜底 mime，缺名会判成不支持类型） */
export function withExtension(name: string, type: string): string {
  if (/\.[a-z0-9]+$/i.test(name)) return name;
  const ext = EXT_BY_MIME[type.toLowerCase()];
  return ext ? `${name}.${ext}` : name;
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000; // 分块避免 apply 参数上限（大图 3MB+ 会炸栈）
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** File/Blob → 过桥素材（base64）；mime 缺省按 image/png（粘贴位图常态）；名字缺省用 fallbackName */
export async function fileToMaterial(file: File, fallbackName: string): Promise<RecogMaterial> {
  const type = file.type || 'image/png';
  return {
    name: withExtension(file.name || fallbackName, type),
    mime: type,
    dataBase64: toBase64(await file.arrayBuffer()),
  };
}

/** DataTransfer 最小结构（便于 jsdom 用纯对象造夹具；DataTransfer 在 jsdom 不可构造） */
export interface DropLike {
  files?: ArrayLike<File>;
}

/** 粘贴近剪贴板数据结构（items 里 kind==='file' 且 type 为图片者） */
export interface PasteLike {
  items?: ArrayLike<{ kind: string; type: string; getAsFile(): File | null }>;
}

/** 拖拽/点选：取 DataTransfer.files（图片与 PDF 都收，分类交给分类器） */
export function filesFromDrop(data: DropLike | null | undefined): File[] {
  if (!data?.files) return [];
  return Array.from(data.files);
}

/** Ctrl+V：只取图片项（复制的文字/HTML 不参与），跳过取不到 File 的项 */
export function filesFromPaste(data: PasteLike | null | undefined): File[] {
  if (!data?.items) return [];
  const out: File[] = [];
  for (const item of Array.from(data.items)) {
    if (item.kind !== 'file' || !item.type.toLowerCase().startsWith('image/')) continue;
    const file = item.getAsFile();
    if (file) out.push(file);
  }
  return out;
}

/** 点选：input[type=file] 的 FileList → 数组（保序=用户选择顺序） */
export function filesFromInput(files: ArrayLike<File> | null | undefined): File[] {
  return files ? Array.from(files) : [];
}

/** 批量读字节（顺序读；顺序与入参一致，页序=用户给的顺序）；fallbackNames 供无名来源（粘贴）用 */
export async function filesToMaterials(files: File[], fallbackNames: string[] = []): Promise<RecogMaterial[]> {
  const out: RecogMaterial[] = [];
  for (let i = 0; i < files.length; i++) {
    out.push(await fileToMaterial(files[i], fallbackNames[i] ?? pastedFileName(i + 1)));
  }
  return out;
}
