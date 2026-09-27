// 0057：录题图资产落盘（唯一实现）——`file.saveRecogImage` 通道与启动期存量 backfill 共用。
//
// 与 `file.pickLogoImage` 先例（`ipc.ts` saveImageToLogos）的两处差异（等价替代，交付报告申报）：
//   ① 入参是 data URL（渲染层 canvas 产物 / 存量库内联图），无对话框，故需解码 + 形验；
//   ② 命名用**内容 sha256 前 32 位**而非 randomUUID——同图重裁、backfill 重入天然命中同一文件
//      （零孤儿文件、天然幂等）；不同裁剪产出不同哈希，各占一文件（与先例同）。

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 字节上限：裁图长边 900px（crop.ts CROP_MAX_EDGE_PX）的 PNG 远小于此；防误用把超长串写盘 */
export const RECOG_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/** data URL 允许的图片类型（沿用 file.pickLogoImage 的 IMAGE_EXTENSIONS 口径；裁剪产物恒 png） */
const RECOG_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];

export interface SaveRecogImagePayloadLike {
  dataUrl: string;
  width?: number;
  height?: number;
}

export interface SaveRecogImageResult {
  /** 相对 data/assets 的路径，如 'recog/<sha256 前 32 位>.png' */
  relPath: string;
  width?: number;
  height?: number;
}

/** PNG 尺寸解析（IHDR：宽高各 4 字节大端；非 PNG 返回 undefined，字段可选） */
export function pngSizeOf(filePath: string): { width: number; height: number } | undefined {
  const buf = readFileSync(filePath);
  const isPng = buf.length > 24
    && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (!isPng) return undefined;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * data URL → 字节 + 扩展名；非 `data:image/<白名单>;base64,` 或空载 → null。
 * 调用方对 null **显式抛错**（不静默产坏图，`crop.ts` 同口径）。
 */
export function parseImageDataUrl(dataUrl: string): { bytes: Buffer; ext: string } | null {
  const match = /^data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) return null;
  const subtype = match[1]!.toLowerCase();
  const ext = subtype === 'jpeg' ? 'jpg' : subtype === 'svg+xml' ? 'svg' : subtype;
  if (!RECOG_IMAGE_EXTENSIONS.includes(ext)) return null;
  const bytes = Buffer.from(match[2]!, 'base64');
  if (bytes.length === 0) return null;
  return { bytes, ext };
}

/**
 * 裁图 dataUrl → 落 `data/assets/recog/` → relPath（相对 data/assets）。
 * 内容寻址：同字节已落盘则零写入（重入幂等、不动 mtime）。
 */
export function saveRecogImageDataUrl(dataDir: string, payload: SaveRecogImagePayloadLike): SaveRecogImageResult {
  const parsed = parseImageDataUrl(payload.dataUrl);
  if (!parsed) {
    throw new Error('saveRecogImage：dataUrl 必须是 data:image/<png|jpg|gif|webp>;base64,… 且字节非空');
  }
  if (parsed.bytes.length > RECOG_IMAGE_MAX_BYTES) {
    throw new Error(`saveRecogImage：图片 ${parsed.bytes.length} 字节超过 ${RECOG_IMAGE_MAX_BYTES} 字节上限`);
  }
  const dir = join(dataDir, 'assets', 'recog');
  mkdirSync(dir, { recursive: true });
  const digest = createHash('sha256').update(parsed.bytes).digest('hex').slice(0, 32);
  const fileName = `${digest}.${parsed.ext}`;
  const target = join(dir, fileName);
  if (!existsSync(target)) writeFileSync(target, parsed.bytes);
  const size = (payload.width !== undefined && payload.height !== undefined)
    ? { width: payload.width, height: payload.height }
    : pngSizeOf(target);
  return { relPath: `recog/${fileName}`, ...(size ?? {}) };
}
