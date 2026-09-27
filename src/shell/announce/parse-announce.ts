// 0072（只增）：announce.json 宽容解析（纯函数，零依赖，vitest 直测）。
//
// 口径（任务书 §一.2 结构校验定稿）：
//  - 顶层 { updatedAt, qrImage?, downloadUrl?, messages } —— updatedAt 缺/非串或 messages 缺/非数组 = 坏 JSON；
//  - messages 逐条宽容：坏条目（非对象 / id、title、body 任一非非空串）丢弃，好条目保留；
//    level 非法降 'info'；links 逐条校验（text/url 均非空串才留，坏 link 丢弃，剩空则省略字段）；
//  - messages 全坏 = 坏 JSON（null），回落链按坏 JSON 处理；
//  - qrImage 只接受「/」开头的站点内相对路径（渲染层拼 MF_DIST_BASE 成绝对 URL；防远程外链裂图/外站）；
//  - downloadUrl 只接受 http(s)（主进程 openExternal 同口径放行；防 file:// 等协议被动态下发）。

import type { AnnounceData, AnnounceLink, AnnounceLevel, AnnounceMessage } from '../../shared/contracts/distribution-types.js';

const LEVELS: ReadonlySet<string> = new Set(['info', 'warn', 'urgent']);

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/** 单条 link 校验：text/url 均非空串才留 */
function parseLink(raw: unknown): AnnounceLink | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  if (!isNonEmptyString(rec.text) || !isNonEmptyString(rec.url)) return null;
  return { text: rec.text, url: rec.url };
}

/** 单条公告校验：结构坏 = 丢弃；level 非法降 info；links 逐条宽容 */
function parseMessage(raw: unknown): AnnounceMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  if (!isNonEmptyString(rec.id) || !isNonEmptyString(rec.title) || !isNonEmptyString(rec.body)) return null;
  const level: AnnounceLevel = typeof rec.level === 'string' && LEVELS.has(rec.level) ? (rec.level as AnnounceLevel) : 'info';
  const message: AnnounceMessage = { id: rec.id, level, title: rec.title, body: rec.body };
  if (Array.isArray(rec.links)) {
    const links = rec.links.map(parseLink).filter((l): l is AnnounceLink => l !== null);
    if (links.length > 0) message.links = links;
  }
  return message;
}

/**
 * announce.json 文本 → AnnounceData；坏 JSON（语法错/必填缺/全坏）返回 null（不 throw）。
 */
export function parseAnnounceJson(raw: string): AnnounceData | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const rec = parsed as Record<string, unknown>;
  if (!isNonEmptyString(rec.updatedAt)) return null;
  if (!Array.isArray(rec.messages)) return null;

  const messages = rec.messages.map(parseMessage).filter((m): m is AnnounceMessage => m !== null);
  if (messages.length === 0 && rec.messages.length > 0) return null; // 全坏 = 坏 JSON

  const data: AnnounceData = { updatedAt: rec.updatedAt, messages };
  // qrImage：只收「/」开头的站点内相对路径（渲染层拼 MF_DIST_BASE；其余形态省略 = 缺省态占位文案）
  if (isNonEmptyString(rec.qrImage) && rec.qrImage.startsWith('/')) {
    data.qrImage = rec.qrImage;
  }
  // downloadUrl：只收 http(s)（openExternal 放行口径一致；缺省由消费方落发布页）
  if (isNonEmptyString(rec.downloadUrl) && /^https?:\/\//i.test(rec.downloadUrl)) {
    data.downloadUrl = rec.downloadUrl;
  }
  return data;
}
