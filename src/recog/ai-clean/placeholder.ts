// 0065（R-068）：403 占位图识别（纯函数，零 IO）。
//
// 背景：组卷网对**无权限的答案解析**返回的不是答案，而是一张横幅图——文案恒为
// 「（403）您没有权限查看组卷网答案解析，请直接访问站点查看！」。它长得像「一张整答案图」，
// 于是 0056 的整理链会把它当答案图送给视觉模型：烧 token、拿回一坨「用户没有权限」的文本，
// 再原样写进 answer 字段（用户真机会看到答案区变成「请开通权限」）。
//
// 判据（任务书 §零.13/§一.3，口径「宁漏不误杀」）：
//   ① 前置（零 token）：**逐字节 SHA-256 撞库内已知占位图样本** ∧ **小尺寸**（长边 ≤ 512 且尺寸认得出来）；
//   ② 事后（已付费）：转写文本命中「无权限 / 暂未开通 / 403」类文案 → 同样按占位图处理（保留原图、不写字段）。
// 两条判据**只用于「跳过 AI 调用 + 弹层单列分组」**：不删图、不改库、不写任何内容。
//
// 为什么决定性信号是逐字节指纹而不是几何（真库 256 题实测，2026-09-24）：
// 横幅是 414×30（另有 417×29 的第二次渲染），而真库里 `d=v₀sin37°·t₁-½gcos37°·t₁²=…`
// 这类**长公式图**是 461×27 / 382×27 / 417×29 —— 几何特征与横幅几乎重合；
// 只用「小尺寸 + 长宽比」判据会在真库误杀真公式图（实测松口径 11 张、紧口径 4 张）。
// 故几何只作**前置条件与诊断信息**，命中必须靠指纹。
//
// 变体登记（真库全扫描得，三个字节变体）：见 `PLACEHOLDER_SHA256`。
// 站点是**每次现场渲染**该横幅的（同文案已出现三种字节），故指纹表天生是快照：
// 未登记的新变体会走 ② 的事后兜底（多花一次调用，但不误杀、不写错字段）——见交付报告 §残余项。

import { createHash } from 'node:crypto';

/** 「小尺寸」前置条件的上限（长边 px）：横幅 414×30 远小于它，整页答案图（如 1768×664）远大于它 */
export const PLACEHOLDER_MAX_LONG_EDGE_PX = 512;

/**
 * 库内已知占位图样本的 SHA-256（逐字节指纹）。
 * 三个变体均取自用户真库只读副本（`test/recog/0065-placeholder-bytes.ts` 存原始字节留档）：
 *   A: 414×30 · 5643B · 12 处引用（0056 §7.5 登记的那 12 道）
 *   B: 414×30 · 5643B ·  6 处引用（与 A 仅 3 个像素字节之差）
 *   C: 417×29 · 5349B ·  2 处引用（另一次渲染）
 */
export const PLACEHOLDER_SHA256: ReadonlySet<string> = new Set([
  '5c5b685fc5002925af58214e87c3c782baf4b20b4025dce927c94e3e2af888eb',
  'f7e5f24de45dcdd7d97f2e73f413527312e7f49d37809ba02b3d2a2c25c0f286',
  'abbff7b77dc7f157339ac3d736f20cb1cdccc73440f95a099fba5291d7e94ba4',
]);

export interface ImageSize {
  width: number;
  height: number;
}

/** 字节指纹（登记表比对用；也供测试/探针自算） */
export function sha256Hex(bytes: Uint8Array | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * 图片内在尺寸（零依赖嗅探 PNG/JPEG/GIF；认不出 → null，不猜）。
 * 只读文件头：PNG 的 IHDR、JPEG 的 SOF 帧头、GIF 的逻辑屏幕描述符。
 */
export function imageSizeOf(bytes: Uint8Array | Buffer): ImageSize | null {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buf.length < 10) return null;

  // PNG：8 字节签名 + IHDR 前 8 字节即宽高
  if (buf.length >= 24 && buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  // GIF：逻辑屏幕描述符（LE）
  if (buf.length >= 10) {
    const head6 = buf.subarray(0, 6).toString('latin1');
    if (head6 === 'GIF87a' || head6 === 'GIF89a') {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
  }

  // JPEG：SOI 后逐段走到 SOF（帧头里才有宽高）
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) {
        off += 1;
        continue;
      }
      const marker = buf[off + 1] ?? 0;
      // SOF0~SOF15（跳过 DHT/JPG/DAC 三个非帧头）
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: buf.readUInt16BE(off + 7), height: buf.readUInt16BE(off + 5) };
      }
      const len = buf.readUInt16BE(off + 2);
      if (len < 2) return null;
      off += 2 + len;
    }
  }

  return null;
}

/**
 * 前置判据：这是不是「站点占位图」。命中 → 人读原因（含尺寸/字节/指纹前缀，供弹层与台账）；
 * 不命中 → null（照常送引擎）。
 *
 * `fingerprints` 默认取登记表；显式传参只用于测试注入（生产调用方一律用缺省）。
 */
export function placeholderReasonOf(
  bytes: Uint8Array | Buffer,
  fingerprints: ReadonlySet<string> = PLACEHOLDER_SHA256,
): string | null {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const digest = sha256Hex(buf);
  if (!fingerprints.has(digest)) return null;
  const size = imageSizeOf(buf);
  // 「小尺寸」是前置条件：尺寸认不出、或超出小尺寸上限 → 不当占位图（宁漏不误杀）
  if (size === null) return null;
  if (Math.max(size.width, size.height) > PLACEHOLDER_MAX_LONG_EDGE_PX) return null;
  return `站点占位图（403 无权限）：${size.width}×${size.height} · ${buf.length}B · 指纹 ${digest.slice(0, 12)}…`;
}

/** 权限提示文案（真库横幅原文含「您没有权限查看组卷网答案解析」；各站点措辞不同，取保守集合） */
const PERMISSION_COPY_RE = /(没有权限|无权限|暂无权限|权限查看|未开通|开通后|forbidden)/i;
/** 裸 403（单独出现）：只有整段就是「403 / 403 Forbidden」才算——「答案=403」这类数字不能被误判 */
const BARE_403_RE = /^\s*[（(]?\s*403\s*[)）]?\s*(forbidden)?\s*[!！。.]?\s*$/i;

/**
 * 事后兜底判据（已付费路径）：转写文本本身就是权限提示 → 该图按占位图处理
 * （**保留原图**、不写字段、进占位图分组），不让「请开通权限」被当成答案写进库。
 *
 * 未登记变体的唯一兜底：横幅文案固定，转写必然撞上这组词。代价是多一次调用（可接受，
 * 见 §残余项「指纹表是快照」）。
 */
export function placeholderTextReason(text: string): string | null {
  const trimmed = (text ?? '').trim();
  if (trimmed === '') return null;
  if (BARE_403_RE.test(trimmed)) return '转写结果即站点权限提示（403）——按占位图处理，原图保留';
  if (PERMISSION_COPY_RE.test(trimmed)) {
    const hit = /403/.test(trimmed) ? '403 无权限' : '权限提示';
    return `转写结果即站点${hit}文案——按占位图处理，原图保留（需到站点开通权限后重新采集）`;
  }
  return null;
}
