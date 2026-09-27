/**
 * 内容哈希 questionId（D1-fix-3 J-1）
 *
 * 实站实证：菁优网 fieldset id / report token / detail token 均每次渲染轮换
 * （同一题两次快照 token 全换），无任何可作题库主键的稳定 id。
 * 改用「归一化题干 + 选项文本」的 FNV-1a 64 位哈希作确定性问题标识：
 * 同题重采 → 同 id（去重生效）；内容不同 → 不同 id（防串题天然成立）。
 */

/** FNV-1a 64 位哈希 → 16 位 hex（确定性，浏览器/Node 双环境） */
export function fnv1a64Hex(text: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i) & 0xff);
    hash = (hash * prime) & mask;
    // charCodeAt 取 UTF-16 码元，高低字节混合以增强散布
    hash ^= BigInt(text.charCodeAt(i) >> 8);
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

/** jyeoo 内容哈希 questionId：jh + 16 hex */
export function jyeooContentId(stemText: string, optionsText: string): string {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  return 'jh' + fnv1a64Hex(norm(stemText) + '|' + norm(optionsText));
}
