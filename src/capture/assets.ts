/**
 * 采集图片资产：同 session 下载 → 落盘 → HTML src 改写本地相对路径
 *
 * 落盘约定：userData/data/assets/capture/<site>/<questionId>-<idx>.<ext>
 * 库内/HTML 内存 data-assets/ 前缀相对 POSIX 路径（渲染层解析 data-assets → userData/data/assets，B1 落地）
 * 扩展名归一（POC 实证坑）：svg+xml→svg、jpeg→jpg、content-type 缺失按 URL 后缀兜底、两头都无→bin
 * 落盘前内容校验（0006-P4-fix-1 P2）：Content-Type 主类型 / 扩展名白名单 / 魔数三重把关，
 * 非图片响应（WAF 200 text/html 等）拒收——不落盘、不改写 src，仅记 warning
 *
 * 下载器实站冒烟在 D1；Node 测试只测命名/清洗纯函数 + fetchFn 注入的下载编排
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CapturedQuestion } from '../shared/contracts/capture-types.js';

/** HTML/库内引用的虚拟前缀：渲染层解析为 userData/data/assets/ */
export const DATA_ASSETS_PREFIX = 'data-assets/';

export interface DownloadedAsset {
  localPath: string;
  origSrc: string;
  role: 'content' | 'answer';
  /** 真实像素宽（D1-fix R-4，读不到时缺省） */
  width?: number;
  /** 真实像素高 */
  height?: number;
}

export interface AssetFetchResponse {
  ok: boolean;
  status: number;
  contentType: string | null;
  bytes: Uint8Array;
}

/** 同 session 抓取（Electron 侧 = session.fetch，登录后 CDN 图带 cookie） */
export type AssetFetchFn = (url: string) => Promise<AssetFetchResponse>;

export interface AssetDownloadDeps {
  /** userData/data 根目录 */
  dataRoot: string;
  fetchFn: AssetFetchFn;
}

/**
 * 扩展名归一：content-type 优先，缺失按 URL 后缀兜底
 */
export function normalizeExtension(contentType: string | null | undefined, url: string): string {
  const fromType = (contentType || '').split(';')[0].trim().split('/')[1] || '';
  let ext = fromType;
  if (!ext) {
    try {
      const pathname = new URL(url).pathname;
      const dot = pathname.lastIndexOf('.');
      if (dot >= 0) ext = pathname.slice(dot + 1);
    } catch {
      // 保留空
    }
  }
  ext = ext.toLowerCase().replace('+xml', '');
  if (ext === 'jpeg') ext = 'jpg';
  if (!/^[a-z0-9]+$/.test(ext)) ext = '';
  return ext || 'bin';
}

/** questionId 清洗：文件系统不安全字符 → _ */
function sanitizeFileKey(questionId: string): string {
  return questionId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** 图片扩展名白名单（P2）：归一后不在此列（含 `text/html`→html、兜底 bin）一律拒收 */
const IMAGE_EXTENSIONS = new Set(['svg', 'png', 'jpg', 'jpeg', 'gif', 'webp']);

/**
 * 魔数判据（P2）：声明图片类型但正文不符 → 拒（WAF 挑战页错标 image/* 也不落盘）
 */
function looksLikeImageBytes(bytes: Uint8Array, ext: string): boolean {
  const startsWith = (sig: number[]): boolean => sig.length <= bytes.length && sig.every((b, i) => bytes[i] === b);
  switch (ext) {
    case 'png':
      return startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'jpg':
    case 'jpeg':
      return startsWith([0xff, 0xd8]);
    case 'gif':
      return startsWith([0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61;
    case 'webp':
      return startsWith([0x52, 0x49, 0x46, 0x46]) && bytes.length >= 12
        && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
    case 'svg': {
      const head = new TextDecoder().decode(bytes.slice(0, 1024)).replace(/^\uFEFF/, '').trimStart();
      return /^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)?(?:<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(head);
    }
    default:
      return false;
  }
}

/**
 * 落盘前内容校验（0006-P4-fix-1 P2）：返回拒绝依据；null = 通过。
 * ① Content-Type 主类型非 `image/`（声明时）→ 拒；② 归一扩展名不在图片白名单 → 拒；
 * ③ 声明图片类型但魔数不符 → 拒。拒收语义：不落盘、不改写 src（HTML 保留原始远端 URL，裂在明处）。
 */
function imageRejectReason(contentType: string | null, ext: string, bytes: Uint8Array): string | null {
  const mainType = (contentType || '').split(';')[0].trim().toLowerCase();
  if (mainType && !mainType.startsWith('image/')) return `Content-Type 非图片（${mainType}）`;
  if (!IMAGE_EXTENSIONS.has(ext)) return `扩展名 .${ext} 不在图片白名单（${[...IMAGE_EXTENSIONS].join('/')}）`;
  if (!looksLikeImageBytes(bytes, ext)) return `正文魔数与 .${ext} 不符（非图片内容）`;
  return null;
}

/** 裂图形态判定（0006-P4-fix-1 P3，纯函数）：`.html` WAF 资产引用 或 mzujuan 错误域死链 */
export function hasBrokenImageRefs(html: string | undefined | null): boolean {
  const text = String(html ?? '');
  if (!text) return false;
  if (/data-assets\/capture\/[^\s"'<>?#]*\.html(?![\w.])/i.test(text)) return true;
  return /https:\/\/mzujuan\.xkw\.com\/Upload\/formula\//i.test(text);
}

export interface ImageDimensions {
  width: number;
  height: number;
}

/** SVG 文本读尺寸：width/height 属性优先，缺失回落 viewBox */
function readSvgDimensions(text: string): ImageDimensions | null {
  const tag = /<svg\b[^>]*>/i.exec(text)?.[0];
  if (!tag) return null;
  const attr = (name: string): number | null => {
    const m = new RegExp(`\\b${name}\\s*=\\s*["']([0-9.]+)[a-z]*["']`, 'i').exec(tag);
    return m ? Math.round(parseFloat(m[1])) : null;
  };
  const w = attr('width');
  const h = attr('height');
  if (w && h && w > 0 && h > 0) return { width: w, height: h };
  const vb = /\bviewBox\s*=\s*["']\s*[-0-9.]+\s+[-0-9.]+\s+([0-9.]+)\s+([0-9.]+)\s*["']/i.exec(tag);
  if (vb) {
    const vw = Math.round(parseFloat(vb[1]));
    const vh = Math.round(parseFloat(vb[2]));
    if (vw > 0 && vh > 0) return { width: vw, height: vh };
  }
  return null;
}

/** PNG：签名 + IHDR 头，宽高大端位于字节 16-23 */
function readPngDimensions(bytes: Uint8Array): ImageDimensions | null {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || !SIG.every((b, i) => bytes[i] === b)) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = dv.getUint32(16);
  const height = dv.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** JPEG：扫描段标记找 SOF0/1/2（0xFFC0-C2），高/宽在段体偏移 +1/+3 */
function readJpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 2;
  while (pos + 9 < bytes.length) {
    if (bytes[pos] !== 0xff) return null;
    const marker = bytes[pos + 1];
    if (marker >= 0xc0 && marker <= 0xc2) {
      const height = dv.getUint16(pos + 5);
      const width = dv.getUint16(pos + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    pos += 2 + dv.getUint16(pos + 2);
  }
  return null;
}

/**
 * 读取图片真实像素尺寸（手写解析，零第三方依赖）：
 * SVG 读 width/height 或 viewBox；PNG 读 IHDR；JPEG 读 SOF。读不到 → null
 */
export function readImageDimensions(bytes: Uint8Array, ext: string): ImageDimensions | null {
  try {
    if (ext === 'svg') return readSvgDimensions(new TextDecoder().decode(bytes));
    if (ext === 'png') return readPngDimensions(bytes);
    if (ext === 'jpg') return readJpegDimensions(bytes);
    return null;
  } catch {
    return null;
  }
}

/** 库内/HTML 相对 POSIX 路径：data-assets/capture/<site>/<questionId>-<idx>.<ext> */
export function assetRelativePath(site: string, questionId: string, idx: number, ext: string): string {
  return `${DATA_ASSETS_PREFIX}capture/${site}/${sanitizeFileKey(questionId)}-${idx}.${ext}`;
}

/** data-assets 相对路径 → 磁盘绝对路径（userData/data/assets/...） */
export function assetDiskPath(dataRoot: string, localPath: string): string {
  const rel = localPath.startsWith(DATA_ASSETS_PREFIX) ? localPath.slice(DATA_ASSETS_PREFIX.length) : localPath;
  return join(dataRoot, 'assets', ...rel.split('/'));
}

/**
 * 内容/答案 HTML 的 img src 改写为本地相对路径（字面替换，对齐 POC replaceAll 做法）
 */
export function rewriteImageSources(html: string, assets: DownloadedAsset[]): string {
  let out = html;
  for (const asset of assets) {
    out = out.split(asset.origSrc).join(asset.localPath);
  }
  return out;
}

/**
 * 下载一题的全部图片（内容图 + 答案图），落盘并就地改写 q 的 HTML 字段 src
 * 单图失败降级 warning，不中断其他图
 */
export async function downloadQuestionImages(
  q: CapturedQuestion,
  deps: AssetDownloadDeps
): Promise<{ images: DownloadedAsset[]; warnings: string[] }> {
  const images: DownloadedAsset[] = [];
  const warnings: string[] = [];

  let idx = 0;
  for (const img of q.images) {
    idx++;
    if (!img.src || img.src.startsWith('data:')) {
      warnings.push(`${q.site}:${q.questionId} image#${idx} skipped 非 http 图（${(img.src || '').slice(0, 40)}）`);
      continue;
    }
    try {
      const resp = await deps.fetchFn(img.src);
      if (!resp.ok) {
        warnings.push(`${q.site}:${q.questionId} image#${idx} http-${resp.status} ${img.src.slice(0, 80)}`);
        continue;
      }
      const ext = normalizeExtension(resp.contentType, img.src);
      // P2：非图片响应（WAF 挑战页/错误域 HTML）拒收——不落盘、不改写 src，仅记 warning
      const reject = imageRejectReason(resp.contentType, ext, resp.bytes);
      if (reject) {
        warnings.push(`${q.site}:${q.questionId} image#${idx} 非图片响应已拒（${reject}） ${img.src.slice(0, 80)}`);
        continue;
      }
      const localPath = assetRelativePath(q.site, q.questionId, idx, ext);
      const file = assetDiskPath(deps.dataRoot, localPath);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, resp.bytes);
      // R-4：读真实像素尺寸随资产返回（归一化层据此分流行内公式图/块级配图并写 data-w/h）
      const dims = readImageDimensions(resp.bytes, ext);
      if (!dims) {
        warnings.push(`${q.site}:${q.questionId} image#${idx} 尺寸不可读，降级块级配图（${ext}）`);
      }
      images.push({ localPath, origSrc: img.src, role: img.role, ...(dims ?? {}) });
    } catch (error: any) {
      warnings.push(`${q.site}:${q.questionId} image#${idx} error ${error?.message || String(error)} ${img.src.slice(0, 80)}`);
    }
  }

  if (images.length > 0) {
    q.stemHtml = rewriteImageSources(q.stemHtml, images);
    q.options = q.options.map((opt) => rewriteImageSources(opt, images));
    if (q.answerHtml) q.answerHtml = rewriteImageSources(q.answerHtml, images);
    if (q.analysisHtml) q.analysisHtml = rewriteImageSources(q.analysisHtml, images);
  }

  return { images, warnings };
}
