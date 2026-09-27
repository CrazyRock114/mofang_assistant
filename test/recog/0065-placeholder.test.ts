// 0065（R-068）：403 占位图识别（纯函数，零 IO）。
//
// 判据（任务书 §零.13 + §一.3，口径「宁漏不误杀」）：
//   ① 前置（零 token）：**逐字节 SHA-256 撞库内已知占位图样本** ∧ **小尺寸**（长边 ≤ 512，尺寸认得出来）；
//   ② 事后（已付费）：转写文本命中「无权限 / 暂未开通 / 403」类文案 → 也算占位图（不写字段、保留原图）。
// 判据**只用于「跳过 AI 调用 + 弹层单列分组」**，不删图、不改库。
//
// 为什么不单用「尺寸/长宽比」判据（真库实测，2026-09-24）：414×30 的 403 横幅与
// `d=v₀sin37°·t₁-½gcos37°·t₁²=…` 这类长公式（461×27 / 382×27）几何特征几乎重合——
// 单用几何判据会在真库误杀真公式图（实测 4~9 张，见交付报告 §探针 对照档）。

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';

import {
  PLACEHOLDER_MAX_LONG_EDGE_PX,
  PLACEHOLDER_SHA256,
  imageSizeOf,
  placeholderReasonOf,
  placeholderTextReason,
  sha256Hex,
} from '../../src/recog/ai-clean/placeholder.js';
import {
  PLACEHOLDER_A_BASE64,
  PLACEHOLDER_A_BYTES,
  PLACEHOLDER_A_SHA256,
  PLACEHOLDER_B_BASE64,
  PLACEHOLDER_B_SHA256,
  PLACEHOLDER_C_BASE64,
  PLACEHOLDER_C_SHA256,
} from './0065-placeholder-bytes.js';

const buf = (b64: string): Buffer => Buffer.from(b64, 'base64');

/** 合成 PNG（只有签名 + IHDR + IEND）：用于构造「几何与横幅相近但非占位图」的对照样本 */
function syntheticPng(width: number, height: number): Buffer {
  const sig = Buffer.from('89504e470d0a1a0a', 'hex');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // color type = RGB
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(0, 0);
    return Buffer.concat([head, data, crc]);
  };
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IEND', Buffer.alloc(0))]);
}

describe('0065 占位图指纹（真库样本）', () => {
  it('真库三个字节变体全部命中（识别率 100%）', () => {
    for (const [name, b64, sha] of [
      ['A', PLACEHOLDER_A_BASE64, PLACEHOLDER_A_SHA256],
      ['B', PLACEHOLDER_B_BASE64, PLACEHOLDER_B_SHA256],
      ['C', PLACEHOLDER_C_BASE64, PLACEHOLDER_C_SHA256],
    ] as const) {
      const bytes = buf(b64);
      expect(sha256Hex(bytes), `夹具 ${name} 的 sha 应与登记值一致`).toBe(sha);
      expect(placeholderReasonOf(bytes), `变体 ${name} 应命中`).toContain('403');
    }
  });

  it('命中原因带尺寸/字节特征（人读诊断，不只是一个「是」）', () => {
    const reason = placeholderReasonOf(buf(PLACEHOLDER_A_BASE64))!;
    expect(reason).toContain('414×30');
    expect(reason).toContain(`${PLACEHOLDER_A_BYTES}B`);
  });

  it('注册表登记值 = 真库样本实测 sha（防登记值被误改）', () => {
    expect(PLACEHOLDER_A_SHA256).toBe('5c5b685fc5002925af58214e87c3c782baf4b20b4025dce927c94e3e2af888eb');
    expect(PLACEHOLDER_B_SHA256).toBe('f7e5f24de45dcdd7d97f2e73f413527312e7f49d37809ba02b3d2a2c25c0f286');
    expect(PLACEHOLDER_C_SHA256).toBe('abbff7b77dc7f157339ac3d736f20cb1cdccc73440f95a099fba5291d7e94ba4');
    expect(PLACEHOLDER_SHA256.size).toBe(3);
  });

  it('零误杀：几何与横幅几乎重合的长公式图不命中（真库同形态对照）', () => {
    // 真库实测：461×27 / 382×27 / 417×29 这类长公式图与 414×30 横幅几何特征重合，
    // 只靠几何判据必误杀——故决定性信号是逐字节指纹。
    expect(placeholderReasonOf(syntheticPng(461, 27))).toBeNull();
    expect(placeholderReasonOf(syntheticPng(414, 30))).toBeNull();
    expect(placeholderReasonOf(Buffer.from('not an image at all'))).toBeNull();
  });

  it('小尺寸是前置条件：指纹命中但尺寸不符/尺寸认不出 → 不判占位', () => {
    // 注入「同字节的大图」场景：指纹在册，但尺寸超出小尺寸上限 → 不判占位
    const big = syntheticPng(2000, 800);
    const registry = new Set([sha256Hex(big)]);
    expect(placeholderReasonOf(big, registry)).toBeNull();
    // 尺寸认不出（非图片字节）同样不判——宁漏不误杀
    const junk = Buffer.from('junk-bytes-not-an-image');
    expect(placeholderReasonOf(junk, new Set([sha256Hex(junk)]))).toBeNull();
    // 同样的注入注册表在**小尺寸**真图上照常命中（证明分支不是恒假）
    expect(placeholderReasonOf(syntheticPng(414, 30), new Set([sha256Hex(syntheticPng(414, 30))]))).toContain('403');
  });
});

describe('0065 占位图：事后文案兜底（未登记变体）', () => {
  it('转写文本命中「无权限」文案 → 判占位（真库横幅原文）', () => {
    expect(placeholderTextReason('（403）您没有权限查看组卷网答案解析，请直接访问站点查看！')).toContain('403');
    expect(placeholderTextReason('您没有权限查看该题答案')).toBeTruthy();
    expect(placeholderTextReason('抱歉，该内容暂未开通，请开通后查看')).toBeTruthy();
    expect(placeholderTextReason('403 Forbidden')).toBeTruthy();
  });

  it('正常 LaTeX / 中文转写不误判', () => {
    expect(placeholderTextReason('\\frac{1}{2}mv^2')).toBeNull();
    expect(placeholderTextReason('由牛顿第二定律得 a=2\\,\\mathrm{m/s^2}')).toBeNull();
    expect(placeholderTextReason('故选A。')).toBeNull();
    expect(placeholderTextReason('')).toBeNull();
  });
});

describe('0065 图片尺寸嗅探（零依赖）', () => {
  it('PNG：IHDR 宽高', () => {
    expect(imageSizeOf(buf(PLACEHOLDER_C_BASE64))).toEqual({ width: 417, height: 29 });
    expect(imageSizeOf(buf(PLACEHOLDER_A_BASE64))).toEqual({ width: 414, height: 30 });
  });

  it('JPEG：SOF 帧头宽高', () => {
    // SOI + APP0 + SOF0(基线) 手工拼装：宽 414 高 30
    const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x1e, 0x01, 0x9e, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00]);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])]);
    expect(imageSizeOf(jpeg)).toEqual({ width: 414, height: 30 });
  });

  it('非图片/过短字节 → null（不猜）', () => {
    expect(imageSizeOf(Buffer.from('not an image'))).toBeNull();
    expect(imageSizeOf(Buffer.alloc(0))).toBeNull();
  });

  it('sha256Hex / 小尺寸上限是显式常量（口径可核）', () => {
    expect(sha256Hex(Buffer.from('abc'))).toBe(createHash('sha256').update('abc').digest('hex'));
    expect(PLACEHOLDER_MAX_LONG_EDGE_PX).toBe(512);
  });
});
