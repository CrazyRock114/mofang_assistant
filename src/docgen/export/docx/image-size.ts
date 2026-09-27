// 0035：图片内在尺寸解析（PNG/JPEG/GIF/BMP）——纯函数，零依赖。
// 用途：figure 无 data-w/data-h 时按内在像素宽高落位（HTML 管线由浏览器量算，此处自解析补齐）。

export type DocxImageType = 'png' | 'jpg' | 'gif' | 'bmp';

export interface IntrinsicSize {
  type: DocxImageType;
  width: number;
  height: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngSize(buf: Buffer): IntrinsicSize | null {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { type: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** JPEG：扫 SOFn 段（C0–CF 除 C4/C8/CC）取精度后 4 字节 */
function jpegSize(buf: Buffer): IntrinsicSize | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buf[i + 1];
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    const length = buf.readUInt16BE(i + 2);
    if (isSof) return { type: 'jpg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }
    i += 2 + Math.max(length, 2);
  }
  return null;
}

function gifSize(buf: Buffer): IntrinsicSize | null {
  if (buf.length < 10) return null;
  const head = buf.toString('ascii', 0, 6);
  if (head !== 'GIF87a' && head !== 'GIF89a') return null;
  return { type: 'gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

function bmpSize(buf: Buffer): IntrinsicSize | null {
  if (buf.length < 26 || buf.toString('ascii', 0, 2) !== 'BM') return null;
  const width = buf.readInt32LE(18);
  const height = Math.abs(buf.readInt32LE(22));
  if (width <= 0 || height <= 0) return null;
  return { type: 'bmp', width, height };
}

/** 图片字节 → 内在尺寸；未知/损坏 → null（调用方显式降级，不猜尺寸） */
export function imageIntrinsicSize(buf: Buffer): IntrinsicSize | null {
  return pngSize(buf) ?? jpegSize(buf) ?? gifSize(buf) ?? bmpSize(buf);
}

/** 扩展名 → docx 支持类型（svg/webp 不在支持面：Word 兼容性/无第二依赖栅格器 → 显式降级） */
export function imageTypeOfExtension(name: string): DocxImageType | null {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'png') return 'png';
  if (ext === 'jpg' || ext === 'jpeg') return 'jpg';
  if (ext === 'gif') return 'gif';
  if (ext === 'bmp') return 'bmp';
  return null;
}
