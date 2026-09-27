// 0072（只增）：分发端点常量——公告、更新、兜底下载链接的单一真源（F-07 端点收敛）。
// 换域名/换形态只改本文件（MF_DIST_BASE 一处）。纯常量、零依赖、零副作用，主进程与渲染层共用
//（渲染层公告弹窗把 announce.qrImage 站点相对路径拼成绝对 URL 也从这里取基址）。
// 范围纪律：既有采集业务站点 URL（组卷/菁优）不在本收敛面——业务站点地址，非分发端点。
//
// 【开源构建版】MF_DIST_BASE 置空：本副本不含官方更新与公告通道（「开源仓与官方发行版是两码事」）。
// 置空后运行时自动降级——更新：feed URL 非 http(s) 绝对地址，主进程守卫改走不可用适配器（设置页更新区
// 恒「已是最新」）；公告：拉取失败回落内置文案。语义详见 README「与官方发行版的差异」一节。

export const MF_DIST_BASE = '';
export const MF_UPDATE_FEED_URL = `${MF_DIST_BASE}/dl/`; // electron-updater generic feed（latest.yml 同目录）
export const MF_ANNOUNCE_URL = `${MF_DIST_BASE}/announce.json`;
export const MF_RELEASE_PAGE_URL = MF_DIST_BASE + '/'; // downloadUrl 缺省兜底（下载页）
