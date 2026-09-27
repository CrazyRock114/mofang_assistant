/**
 * 题干归一化与防串题匹配（POC findings 实证：防止 id 错位采到错题答案）
 */

/**
 * 归一化题干文本用于匹配：移除全角括号、空白、题号前缀
 */
export function normalizeStem(stem: string): string {
  return stem
    .replace(/[（(]\d+[)）]/g, '') // 移除 (1) （1） 题号
    .replace(/^[\d]+\s*[.、]\s*/g, '') // 移除 1. 1、 题号前缀（含 "1 . " 实站带空格形态，D1-fix R-6）
    .replace(/^[【\[]\d+[】\]]\s*/g, '') // 移除 【1】 [1] 题号前缀
    .replace(/^[A-Z]\s*[.、]\s*/g, '') // 移除 A. 字母题号前缀
    .replace(/[（）()]/g, '') // 移除全角半角括号
    .replace(/\s+/g, ' ') // 多空白统一为单空格（在标点统一前）
    .replace(/[，,]/g, ',') // 统一逗号
    .replace(/[。.]/g, '.') // 统一句号
    .replace(/\s*([,.])\s*/g, '$1') // 移除标点前后空格
    .trim();
}

/**
 * 防串题校验：详情页题干须与篮内题干归一化匹配
 * D1-fix R-6：比较前剥离全部空白——篮内经 htmlToText（标签→空格）、详情页经 textContent（标签→无空白），
 * 行内公式图边界空白不对称曾致 3/3 误杀 mismatch；两侧同规则剥离不影响区分度
 */
export function isStemMatch(basketStem: string, detailStem: string): boolean {
  const normalizedBasket = normalizeStem(basketStem).replace(/\s+/g, '');
  const normalizedDetail = normalizeStem(detailStem).replace(/\s+/g, '');

  // 空题干不得匹配（篮内空 = 无匹配基准；详情页空 = 结构/加载问题，由调用方区分标记）
  if (!normalizedBasket || !normalizedDetail) {
    return false;
  }

  // 如果归一化后完全相同，直接匹配
  if (normalizedBasket === normalizedDetail) {
    return true;
  }

  // 详情页题干应包含篮内题干前缀（篮内可能截断，详情页完整）
  // 或者篮内题干是详情页的子串（考虑篮内可能只显示开头）
  return normalizedDetail.startsWith(normalizedBasket) ||
         normalizedDetail.includes(normalizedBasket.slice(0, Math.max(10, normalizedBasket.length / 2)));
}
