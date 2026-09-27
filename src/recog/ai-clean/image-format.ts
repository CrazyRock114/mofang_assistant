// 0056 目检返工①：图片字节嗅探（纯函数，零 IO）。
//
// 为什么不信任扩展名：采集链的资产名来自站点 URL，历史上出现过「.png 实为 WAF HTML 页」的裂图形态
// （ingest 的 broken-image refs 修复链在案）；且视觉端点对**格式**是硬校验（HTTP 400 code 20015
// 「image_url provided is not a valid image.」就是它）。发出去的 mime 必须来自**真身**。

export type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp' | 'svg' | 'unknown';

/** 扩展名 → mime（兜底用；实际发送一律以 sniffImageType 的结论为准） */
export function mimeOfFormat(format: ImageFormat): string {
  switch (format) {
    case 'png': return 'image/png';
    case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'svg': return 'image/svg+xml';
    default: return 'application/octet-stream';
  }
}

/** 扩展名猜 mime（仅用于「文件都没读到/无法嗅探」的兜底路径） */
export function mimeOfPath(assetRelPath: string): string {
  const ext = assetRelPath.toLowerCase().split('.').pop() ?? '';
  if (ext === 'svg') return 'image/svg+xml';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  return 'image/png';
}

/**
 * 字节真身识别（魔数 + SVG 文本签名）。识别不出 = 'unknown'——调用方按「不是图片」显式记账，
 * 绝不猜着发（发错格式就是 HTTP 400 的那个坑）。
 */
export function sniffImageType(bytes: Buffer | Uint8Array): ImageFormat {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 6) {
    const head6 = buf.subarray(0, 6).toString('latin1');
    if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'gif';
  }
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'webp';
  }
  // SVG：文本签名（含 XML 声明 / DOCTYPE / 前导 BOM 与空白；只看前 1KB，避免大文件全量解码）
  const text = buf.subarray(0, 1024).toString('utf8').replace(/^\uFEFF/, '').trimStart().toLowerCase();
  if (text.startsWith('<svg') || (text.startsWith('<?xml') && text.includes('<svg'))) return 'svg';
  if (text.startsWith('<!doctype svg')) return 'svg';
  return 'unknown';
}
