// 0011 §一.7：hash 导航小工具 —— 返回机制（Q1-3 拍板 = hash `?from=` 显式参数）。
// 约定：from 值为**去 #/ 前缀的内部路由路径段**（如 `basket/p1`、`compose/p9`）；
// 解析时统一补 `#/` 前缀并做白名单校验（只放行路由安全字符），拒绝外链 scheme / query 注入，
// 防开放跳转。纯函数无依赖，供篮详情→采集、排版页→采集、采集页返回等接点共用。

/** from 值白名单：仅路由路径安全字符（字母/数字/下划线/连字符/斜杠）。
 * 排除 `:`（scheme）、`.`、`?`、`&`、`%`、`#` 等注入面。 */
const FROM_ROUTE_RE = /^[A-Za-z0-9_\-/]+$/;

/**
 * 给内部 href 追加 from 参数：已有 query 用 `&`，否则用 `?`。
 * from 为空或未过白名单时原样返回（不拼外链）。
 */
export function withFrom(href: string, from: string): string {
  if (!from || !FROM_ROUTE_RE.test(from)) return href;
  const sep = href.includes('?') ? '&' : '?';
  return `${href}${sep}from=${from}`;
}

/**
 * 从 hash 的 query 串解析返回目标：from 合法 → `#/<from>`；缺失/空/非法 → fallback。
 * search 兼容带/不带前导 `?`（`hashSearchOf` 产物与 `URLSearchParams` 原始串均可）。
 */
export function resolveBackHref(search: string, fallback: string): string {
  const raw = search.startsWith('?') ? search.slice(1) : search;
  const from = new URLSearchParams(raw).get('from');
  if (!from || !FROM_ROUTE_RE.test(from)) return fallback;
  return `#/${from}`;
}

/** hash → query 串（`#/capture?toBasket=p1` → `toBasket=p1`；无 `?` → 空串） */
export function hashSearchOf(hash: string): string {
  const at = hash.indexOf('?');
  return at >= 0 ? hash.slice(at + 1) : '';
}

/**
 * 返回按钮文案按 from 指名去向（0011 目检返工二：返回要一眼看出回到哪）：
 * from=basket/* → 返回试题篮；from=compose/* → 返回排版；from=split/* → 返回切题项目；
 * 无/非法 from → fallback（缺省「返回组卷」，采集页那套的既有口径）。
 *
 * 0036（只增参数）：fallback 可传——录题/校对页的上一级是首页（不是组卷），
 * 用同一个函数但换兜底文案，避免为「文案」再抄一份正则。
 */
export function backLabelOf(search: string, fallback = '返回组卷'): string {
  // 传整串 hash 也认（`#/proof/r1?from=split/x` 直接丢进来时，先切出 query 段）：
  // 这个坑踩过一次——href 用了 hashSearchOf 而文案忘了，结果「返回链接对、文案是兜底」，
  // 静默错到用户脸上；与其要求每个调用点都记得转一次，不如这里容错。
  const scoped = search.includes('#') ? hashSearchOf(search) : search;
  const raw = scoped.startsWith('?') ? scoped.slice(1) : scoped;
  const from = new URLSearchParams(raw).get('from') ?? '';
  if (FROM_ROUTE_RE.test(from) && from.startsWith('basket/')) return '返回试题篮';
  if (FROM_ROUTE_RE.test(from) && from.startsWith('compose/')) return '返回排版';
  if (FROM_ROUTE_RE.test(from) && from.startsWith('split/')) return '返回切题项目';
  return fallback;
}
