/**
 * 0006 P4：组卷整卷详情页 URL 识别（整卷下载通路入口）
 *
 * 形态：`https://zujuan.xkw.com/{bankId}p{paperId}.html`
 * - bankId = 题库前缀（与 D1-fix-5/6 的 meta.bankid 同源；URL 里天然可得）
 * - 仅组卷网 PC 站；mzujuan（移动站）/菁优/知识点页一律拒绝（不猜、不重定向）
 */

export interface ZujuanPaperRef {
  bankId: string;
  paperId: string;
  /** 归一后的详情页 URL（去 query/hash；bankId/paperId 已剥前导零） */
  url: string;
}

export const ZUJUAN_PAPER_URL_HINT =
  '仅支持组卷网整卷详情页 URL（https://zujuan.xkw.com/{bankId}p{paperId}.html）';

const PAPER_URL_RE = /^https?:\/\/(?:www\.)?zujuan\.xkw\.com\/(\d+)p(\d+)\.html$/i;

/** 识别整卷 URL；非此形态返回 null（调用方按 ZUJUAN_PAPER_URL_HINT 提示） */
export function parseZujuanPaperUrl(input: unknown): ZujuanPaperRef | null {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  if (!value) return null;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  const path = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  const matched = PAPER_URL_RE.exec(path);
  if (!matched) return null;

  const bankId = matched[1];
  const paperId = matched[2];
  return { bankId, paperId, url: `https://zujuan.xkw.com/${bankId}p${paperId}.html` };
}
