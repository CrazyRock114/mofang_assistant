// 0075 A6（只增）：feed URL 可用性守卫（纯函数，零依赖）。
//
// 背景（任务书 §零.1 阻断级发现）：分发基址置空（开源构建 overlay）时 MF_UPDATE_FEED_URL 退化为
// 相对路径 '/dl/'，electron-updater GenericProvider 构造 new URL('/dl/') 直接抛 TypeError 且无
// try/catch——异常沿 initDatabase 冒泡致打包态无主窗。接线处（main.ts）以本谓词守门：
// 不可用 → 改走 createNotAvailableAdapter() 降级，与 dev 口径同型。

/** feed URL 可用 = 能解析为绝对 URL 且协议为 http(s) */
export function isUsableFeedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
