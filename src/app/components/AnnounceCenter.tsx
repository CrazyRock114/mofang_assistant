// 0072（只增）：公告中心（R-073 发布批 lane A；D-088 呈现层口径）——
// 左下固定区「公告」入口（设置上方，AppShell 挂载；无桥不渲染，折叠态图标+title 兜底，未读红点）+
// 公告弹窗（模态层复用 ExtUi.Modal——禁原生三件套）：公告列表（level 配色）/「加入用户群」二维码
//（qrImage 拼 MF_DIST_BASE；缺省占位文案不裂图）/ 条目 links（update.openExternal 出口，http(s) 校验在主进程）/
// 来源标记（remote/cache/builtin）/「今日不再提醒」/ 关闭。
//
// 自动弹出（启动后）：生效公告（remote/cache；纯内置兜底不弹——无真实公告不打扰）且未被抑制 → 弹一次；
// 抑制口径：勾选「今日不再提醒」记日历日 + 已读 id 集；mutedDate 只挡普通公告；**新 urgent id 破抑制仍弹**。
// 主进程启动后 ~30s 才首拉——本组件挂载即读（缓存命中态）+ 45s 轮询兜底（覆盖首拉完成态与新公告到达）。
// 「发现新版」合成条目：update available 时弹窗置顶一条本地生成条目（不入 announce.json 结构）。

import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Modal } from '../pages/ExtUi.js';
import { MF_DIST_BASE } from '../../shared/endpoints.js';
import type { AnnounceLevel, AnnounceMessage, AnnounceSnapshot } from '../../shared/contracts/distribution-types.js';

/** 「今日不再提醒」静音日（日历日本地时区；次日自动失效） */
export const ANNOUNCE_MUTED_DATE_KEY = 'mfa-announce-muted-date';
/** 已读公告 id 集（JSON 数组；跨「今日不再提醒」持久——普通公告读过不再自动弹） */
export const ANNOUNCE_READ_IDS_KEY = 'mfa-announce-read-ids';

function readMutedDate(): string | null {
  try {
    return localStorage.getItem(ANNOUNCE_MUTED_DATE_KEY);
  } catch {
    return null;
  }
}

function readReadIds(): string[] {
  try {
    const raw = localStorage.getItem(ANNOUNCE_READ_IDS_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function writeReadIds(ids: string[]): void {
  try {
    localStorage.setItem(ANNOUNCE_READ_IDS_KEY, JSON.stringify(ids));
  } catch {
    /* localStorage 不可用（隐私模式等）——已读仅本次会话生效 */
  }
}

/** 本地日历日 YYYY-MM-DD（「今日」口径） */
function todayStr(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * 自动弹出判据（D-088 定案口径）：
 *  - 纯内置兜底（builtin）不弹；空 messages 不弹；
 *  - ∃ 未读条目 m：m.level === 'urgent'（破 mutedDate 与 readIds 双抑制）或 mutedDate ≠ 今日。
 */
export function shouldAutoOpen(
  snap: AnnounceSnapshot,
  mutedDate: string | null,
  readIds: string[],
  today: string,
): boolean {
  if (snap.source === 'builtin') return false;
  if (snap.data.messages.length === 0) return false;
  return snap.data.messages.some((m) => !readIds.includes(m.id) && (m.level === 'urgent' || mutedDate !== today));
}

const SOURCE_LABEL: Record<AnnounceSnapshot['source'], string> = {
  remote: '远程',
  cache: '本地缓存',
  builtin: '内置',
};

/** level 配色（既有语义色变量内联——零新增 CSS 类）：info 默认 / warn 黄 / urgent 红 */
const LEVEL_COLOR: Record<AnnounceLevel, string> = {
  info: 'var(--ink-2)',
  warn: 'var(--gold-text)',
  urgent: 'var(--st-red)',
};

/** 16×16 线性喇叭图标（AppShell 同款 stroke 形态，currentColor 随主题） */
function Icon(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <path d="M2.5 6.5 H5 L9.5 3 V13 L5 9.5 H2.5 Z M11.5 5.5 A3.5 3.5 0 0 1 11.5 10.5" />
    </svg>
  );
}

export function AnnounceCenter({ collapsed = false }: { collapsed?: boolean }): ReactElement | null {
  const bridge = window.__mofangAnnounce;
  const [snap, setSnap] = useState<AnnounceSnapshot | null>(null);
  const [open, setOpen] = useState(false);
  const [muteChecked, setMuteChecked] = useState(false);
  const [unread, setUnread] = useState(false);
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  const openRef = useRef(false);
  const lastClosedAtRef = useRef<number | null>(null);

  const openModal = (next: AnnounceSnapshot): void => {
    // 打开即记已读（未读标消失；普通公告不再自动弹；urgent 新 id 到达仍会破抑制）
    const merged = Array.from(new Set([...readReadIds(), ...next.data.messages.map((m) => m.id)]));
    writeReadIds(merged);
    setUnread(false);
    setMuteChecked(false);
    openRef.current = true;
    setSnap(next);
    setOpen(true);
  };

  useEffect(() => {
    if (!bridge) return undefined;
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const next = await bridge.get();
        if (!alive) return;
        setSnap(next);
        const ids = readReadIds();
        setUnread(next.data.messages.some((m) => !ids.includes(m.id)));
        // 自动弹：未被抑制 + 未开着 + 关闭后 5 分钟防抖内不再弹
        const debounceOk = lastClosedAtRef.current === null || Date.now() - lastClosedAtRef.current > 5 * 60_000;
        if (!openRef.current && debounceOk && shouldAutoOpen(next, readMutedDate(), ids, todayStr())) {
          openModal(next);
        }
      } catch {
        /* 桥异常静默（通道未接线等）——公告非关键路径 */
      }
    };
    void load();
    // 主进程启动 ~30s 首拉 + 新公告到达——45s 轮询兜底（抑制判定内建，弹过即静）
    const timer = setInterval(() => {
      void load();
    }, 45_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [bridge]);

  useEffect(() => {
    const update = window.__mofangUpdate;
    if (!update) return undefined;
    let alive = true;
    update
      .getStatus()
      .then((s) => {
        if (alive) setUpdateVersion(s.phase === 'available' ? (s.version ?? null) : null);
      })
      .catch(() => {
        /* dev/自动化态通道未接线——无合成条目 */
      });
    const off = update.onStatus((s) => {
      setUpdateVersion(s.phase === 'available' ? (s.version ?? null) : null);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  if (!bridge) return null;

  const closeModal = (): void => {
    if (muteChecked) {
      try {
        localStorage.setItem(ANNOUNCE_MUTED_DATE_KEY, todayStr());
      } catch {
        /* localStorage 不可用——静音仅本次会话生效 */
      }
    }
    openRef.current = false;
    lastClosedAtRef.current = Date.now();
    setOpen(false);
  };

  const openExternal = (url: string): void => {
    void window.__mofangUpdate?.openExternal(url);
  };

  let linkIndex = 1; // 弹窗内全局序号（从 1 起；announce-link-1、announce-link-2…）

  return (
    <>
      <button
        type="button"
        className="foot-link"
        data-testid="nav-announce"
        title={collapsed ? '公告' : undefined}
        /* 目检返工①（用户 2026-09-25）：button 元素须重置 UA 默认底色/字体（foot-link 历来配 <a>，
           未声明 background——按钮形态与设置入口 <a class="foot-link"> 拉平，无边框无底色） */
        style={{ background: 'none', fontFamily: 'inherit' }}
        onClick={() => {
          if (snap) openModal(snap);
        }}
      >
        <Icon />
        <span className="nav-label">公告</span>
        {unread && (
          <span
            data-testid="announce-unread-dot"
            aria-label="有未读公告"
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: 'var(--brick)',
              marginLeft: 'auto',
              flexShrink: 0,
            }}
          />
        )}
      </button>

      {open && snap && (
        <Modal title="公告" onClose={closeModal}>
          <div data-testid="announce-modal">
            {updateVersion && (
              <div
                data-testid="announce-update-entry"
                style={{
                  marginBottom: '0.75rem',
                  padding: '0.5rem 0.75rem',
                  borderRadius: 6,
                  background: 'var(--note-yellow)',
                  color: 'var(--ink)',
                }}
              >
                <strong>新版本 v{updateVersion} 可用</strong>
                <div style={{ fontSize: 13, color: 'var(--ink-2)', marginTop: 2 }}>
                  可到「设置 → 关于」检查并下载更新；下载完成后重启应用即完成安装。
                </div>
              </div>
            )}

            {snap.data.messages.map((m: AnnounceMessage) => (
              <div
                key={m.id}
                data-testid={`announce-message-${m.level}`}
                style={{ borderLeft: `3px solid ${LEVEL_COLOR[m.level]}`, paddingLeft: '0.6rem', marginBottom: '0.75rem' }}
              >
                <div style={{ fontWeight: 700, color: LEVEL_COLOR[m.level] }}>{m.title}</div>
                <div style={{ whiteSpace: 'pre-wrap', marginTop: 2 }}>{m.body}</div>
                {m.links && m.links.length > 0 && (
                  <div style={{ marginTop: 4 }}>
                    {m.links.map((l) => {
                      const testid = `announce-link-${linkIndex++}`;
                      return (
                        <a
                          key={l.url}
                          data-testid={testid}
                          href={l.url}
                          onClick={(e) => {
                            e.preventDefault();
                            openExternal(l.url);
                          }}
                        >
                          {l.text}
                        </a>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}

            <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start', margin: '0.75rem 0' }}>
              {snap.data.qrImage ? (
                <img
                  data-testid="announce-qr"
                  src={`${MF_DIST_BASE}${snap.data.qrImage}`}
                  alt="用户群二维码"
                  style={{ width: 120, height: 120, borderRadius: 6 }}
                  draggable={false}
                />
              ) : (
                <div
                  data-testid="announce-qr-placeholder"
                  style={{
                    width: 120,
                    height: 120,
                    borderRadius: 6,
                    background: 'var(--paper-deep)',
                    color: 'var(--ink-3)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    textAlign: 'center',
                    fontSize: 12,
                    padding: 8,
                  }}
                >
                  暂无群二维码
                </div>
              )}
              <div style={{ fontSize: 13, color: 'var(--ink-2)' }}>
                扫码加入教师交流群，获取更新通知与使用帮助。
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '0.5rem' }}>
              <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>来源：{SOURCE_LABEL[snap.source]}</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <label style={{ fontSize: 13, color: 'var(--ink-2)', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <input
                    type="checkbox"
                    data-testid="announce-mute-today"
                    checked={muteChecked}
                    onChange={(e) => setMuteChecked(e.target.checked)}
                  />
                  今日不再提醒
                </label>
                <button type="button" className="btn" data-testid="announce-close" onClick={closeModal}>
                  关闭
                </button>
              </span>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
