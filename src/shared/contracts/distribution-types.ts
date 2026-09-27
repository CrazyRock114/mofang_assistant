// 0072（只增）：公告与版本更新的对外形态类型（R-073 发布批 lane A；0072 独占契约文件，0040 onestep-types 先例）。
// AnnounceData 形态 = announce.json 顶层口径（任务书 §一.2）：updatedAt + messages[] 必备，
// qrImage / downloadUrl 顶层可选；解析为逐字段宽容（坏条目丢弃留好条目，全坏=坏 JSON），
// 本文件只声明**解析后**的形态，wire 容错规则在 shell/announce/parse-announce.ts。

/** 公告级别：info 默认 / warn 黄 / urgent 红（渲染层配色；urgent 新 id 不受「今日不再提醒」抑制） */
export type AnnounceLevel = 'info' | 'warn' | 'urgent';

/** 公告条目外链（点击经 update.openExternal 打开系统浏览器，主进程校验 http(s)） */
export interface AnnounceLink {
  text: string;
  url: string;
}

export interface AnnounceMessage {
  id: string;
  level: AnnounceLevel;
  title: string;
  body: string;
  links?: AnnounceLink[];
}

export interface AnnounceData {
  updatedAt: string;
  /** 群二维码：站点内相对路径（/assets/...，拼 MF_DIST_BASE 成绝对 URL）；缺省/非法 = 占位文案不裂图 */
  qrImage?: string;
  /** 更新链失败兜底下载地址（动态下发；缺省 = 发布页 MF_RELEASE_PAGE_URL；仅接受 http(s)） */
  downloadUrl?: string;
  messages: AnnounceMessage[];
}

/** 公告来源：remote=本次拉取成功 / cache=回落到本地缓存 / builtin=内置兜底（兜底不自动弹窗） */
export type AnnounceSource = 'remote' | 'cache' | 'builtin';

/** announce.get / announce.refresh 返回：当前生效公告 + 来源标记 */
export interface AnnounceSnapshot {
  source: AnnounceSource;
  data: AnnounceData;
}

/** 更新状态机相位（checking → available → downloading(progress) → downloaded → error / not-available） */
export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error'
  | 'not-available';

/** update.getStatus 返回 + update.onStatus 推送体（主进程每次状态变化都推全量快照） */
export interface UpdateStatus {
  phase: UpdatePhase;
  /** available/downloaded 的新版本号 */
  version?: string;
  /** downloading 进度 0..100 */
  percent?: number;
  /** downloading 滚动速度（字节/秒；download-progress 事件的滚动窗口口径） */
  speedBps?: number;
  /** 慢速提示：持续 <150KB/s 满 30s（不自动取消、不自动转向，仅 UI 非阻塞提示） */
  slowHint?: boolean;
  /** error 相位的失败原因（静默记 app.log；UI 仅在用户主动检查时可见，见 manual） */
  error?: string;
  /** 本次失败是否发生在用户主动检查（checkNow）之后的首次落定上——true 才允许 UI 提示失败 */
  manual?: boolean;
}

/** update.checkNow 返回：started=false = 已有检查/下载在进行，本次忽略（忽略节流是本通道语义） */
export interface UpdateCheckNowResult {
  started: boolean;
}
