// 0024 P4：注入 token 预算估算（保守口径，供 V-6 实测与超预算判定使用）
//
// 估算方法（两腿都往「高估」方向取，宁可误报超标也不漏报）：
//   CJK/全角字符：1 token/字（多数分词器对常用汉字约 0.6~1 token，取上限）
//   其余字符（ASCII/公式/ID）：4 字符/token（英文与 ID 的经验值，短词更接近 2，取 4 属保守）
//   结果向上取整。
// 说明：不引分词器（零新增依赖，任务书 §二）；如需精确值，可在上层用真实分词器复核。

import type { AnchorSnapshot } from '../../shared/contracts/ai-anchor.js';
import { serializeAnchorSnapshot } from './serialize.js';

/** CJK 汉字 / 中日韩标点 / 全角字符区间（按码点判定，逐字符计数） */
function isWideChar(code: number): boolean {
  return (
    (code >= 0x2e80 && code <= 0x9fff)   // 部首扩展~CJK 统一表意文字
    || (code >= 0xf900 && code <= 0xfaff) // CJK 兼容表意文字
    || (code >= 0xfe30 && code <= 0xfe4f) // CJK 兼容形式
    || (code >= 0xff00 && code <= 0xffef) // 全角字符
    || (code >= 0x3000 && code <= 0x303f) // CJK 标点
  );
}

/** 文本 token 估算（保守上界） */
export function estimateTokens(text: string): number {
  let wide = 0;
  let narrow = 0;
  for (const ch of text) {
    if (isWideChar(ch.codePointAt(0) ?? 0)) wide++; else narrow++;
  }
  return Math.ceil(wide + narrow / 4);
}

/** 快照整篇注入的 token 估算（口径 = serializeAnchorSnapshot 的实际注入文本） */
export function estimateAnchorTokens(snapshot: AnchorSnapshot): number {
  return estimateTokens(serializeAnchorSnapshot(snapshot));
}
