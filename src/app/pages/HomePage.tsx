// 0049 首页 v3：存量/流量分层落地（R-040）。
// 呈现唯一依据：home-dashboard-v3 设计稿（v3 定稿，D-068）。
// 结构四段：页头带（标题+小方+日期+🔥连续天数）→ 快捷入口通栏四卡 →
//   双主角 5:7（左 📚教学资产=存量 / 右 📊工作足迹=流量）→ 📝最近试卷条。
// 口径红线（设计定案，不在施工层糊掉）：
//   · 资产卡只出现存量（4 大数字 + 题库累计沉淀曲线）；足迹卡只出现流量（半年动作总数/热力图/
//     五类次数/近 30 日堆叠条/连续天数/AI tokens）——两卡数字零重复（用户明确拍板点）。
//   · 说明性文字一律收进 ⓘ tooltip（低数据态提示条除外）。
//   · 采集与录题同源不可分（operation_log 的 question.create 不带 metadata，capture/ingest 与
//     recog/ingest 走同一 QuestionService）→ 按任务书 §P2.1 fallback 采集并入录题，图例五类；
//     契约 HomeWorkCategory 保留 'capture' 为未来占位（申报见交付报告）。
//   · 导出/打印留痕不在本单（D-068 挂账）——足迹 ⓘ 文案不声称含导出。
// 0037 血脉：入口四卡 testid（home-*-link / home-compose-entry）、四指标 testid（home-stat-*）、
//   home-dash-stats、home-empty-hero 全部等价保留；AI 用量条随 v3 撤下（契约字段不删，前端不再消费）。
// 小方出现位（0037 既有口径）：页头 cheer 42 / 空库引导 stand 96。
// 类名沿用设计稿（.hero/.quick/.qentry/.duo/.asset/.grow/.heat*/.flow*/.pcard…），全部由
//   home.css 以 `.home-v3` 作用域落地，主题 token 取 theme.css 既有变量（theme.css 本单零改动）。
// 目检意见（2026-09-22）①：页头「开始组卷」按钮撤下——与快捷入口「组卷」卡重复；页头右侧只留 🔥 徽章。

import { useEffect, useState } from 'react';
import { Mascot } from '../components/Mascot.js';
import { PAPER_STATUS_LABEL } from './paper-actions.js';
import type {
  HomeActivityDay,
  HomeDashboardStats,
  HomeWorkCategory,
  PaperStatus,
} from '../../shared/contracts/bank-types.js';

/** 千分位整数（1,247） */
function fmtInt(n: number): string {
  return n.toLocaleString('en-US');
}

/** token 展示：≥1 万显示「N.N 万」（0037 口径沿用），否则原数 */
function tokenText(n: number): string {
  return n >= 10000 ? `${(n / 10000).toFixed(1)} 万` : fmtInt(n);
}

const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** '2026-09-21' → '9月21日'（悬停弹层标题用，全式） */
function dateLabel(dateKey: string): string {
  const parts = dateKey.split('-');
  return `${Number(parts[1])}月${Number(parts[2])}日`;
}

/** '2026-09-21' → '9/21'（堆叠条轴/最活跃日脚注用，短式） */
function shortDateLabel(dateKey: string): string {
  const parts = dateKey.split('-');
  return `${Number(parts[1])}/${Number(parts[2])}`;
}

/** '2026-09-21' → '周一' */
function weekdayLabel(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  return WEEKDAY_NAMES[new Date(y!, m! - 1, d!).getDay()]!;
}

/**
 * ISO 时刻 → 相对时间短标（最近试卷卡用）：刚刚 / N 分钟前 / N 小时前 / 昨天 HH:MM / M/D。
 * now 可注入（纯函数，测试钉死时钟）。
 */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const then = new Date(t);
  const diffMin = Math.floor((now.getTime() - t) / 60000);
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const sameDay = then.getFullYear() === now.getFullYear() && then.getMonth() === now.getMonth() && then.getDate() === now.getDate();
  if (sameDay) return `${Math.floor(diffMin / 60)} 小时前`;
  const hh = `${then.getHours()}`.padStart(2, '0');
  const mm = `${then.getMinutes()}`.padStart(2, '0');
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (then.getFullYear() === yesterday.getFullYear() && then.getMonth() === yesterday.getMonth() && then.getDate() === yesterday.getDate()) {
    return `昨天 ${hh}:${mm}`;
  }
  return `${then.getMonth() + 1}/${then.getDate()}`;
}

/** 口径 tooltip（纯 CSS 悬停展开；说明性文字只进这里，页面不留解释句） */
function InfoTip({ text }: { text: string }) {
  return (
    <i className="info-tip">
      i<span className="itip">{text}</span>
    </i>
  );
}

// ---------------- 足迹纯计算 ----------------

/** 五类图例（采集并入录题 → 图例五类）；色值为内容固定色（同 paper-sheet 例外口径，三主题不换色） */
const LEGEND_CATEGORIES: ReadonlyArray<{ key: HomeWorkCategory; name: string; color: string }> = [
  { key: 'proof', name: '录题', color: '#E8734A' },
  { key: 'compose', name: '组卷', color: '#D9A441' },
  { key: 'mistake', name: '错题', color: '#B5493A' },
  { key: 'feedback', name: '反馈', color: '#7C6AAE' },
  { key: 'ai', name: 'AI', color: '#707A8A' },
];

function dayTotal(day: HomeActivityDay): number {
  return Object.values(day.byCategory).reduce((s, n) => s + n, 0);
}

/** 热力图档级：0 / 1-2 / 3-4 / 5-7 / ≥8（设计稿定档） */
function levelOf(total: number): number {
  if (total <= 0) return 0;
  if (total <= 2) return 1;
  if (total <= 4) return 2;
  if (total <= 7) return 3;
  return 4;
}

function categoryTotals(activity: HomeActivityDay[]): Record<HomeWorkCategory, number> {
  const totals: Record<HomeWorkCategory, number> = { proof: 0, capture: 0, compose: 0, mistake: 0, feedback: 0, ai: 0 };
  for (const day of activity) {
    for (const key of Object.keys(totals) as HomeWorkCategory[]) totals[key] += day.byCategory[key];
  }
  return totals;
}

/** 最活跃日（并列取最早，与设计稿同口径） */
function bestDay(activity: HomeActivityDay[]): { date: string; total: number } | null {
  let best: { date: string; total: number } | null = null;
  for (const day of activity) {
    const total = dayTotal(day);
    if (!best || total > best.total) best = { date: day.date, total };
  }
  return best && best.total > 0 ? best : null;
}

/** 本月新增（沉淀曲线用）：终点 − 本月起点前一日；窗口未覆盖月初时回退为终点值 */
function monthDelta(growth: HomeDashboardStats['questionGrowth']): number {
  if (growth.length === 0) return 0;
  const last = growth[growth.length - 1]!;
  const [y, m] = last.date.split('-').map(Number);
  const monthStartKey = `${y}-${`${m}`.padStart(2, '0')}-01`;
  const idx = growth.findIndex((p) => p.date >= monthStartKey);
  if (idx <= 0) return last.total;
  return last.total - growth[idx - 1]!.total;
}

/** Catmull-Rom → 三次贝塞尔（设计稿同款平滑；纯函数） */
function smoothPath(pts: ReadonlyArray<readonly [number, number]>): string {
  let d = `M${pts[0]![0].toFixed(1)},${pts[0]![1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[Math.min(pts.length - 1, i + 2)]!;
    d += `C${(p1[0] + (p2[0] - p0[0]) / 6).toFixed(1)},${(p1[1] + (p2[1] - p0[1]) / 6).toFixed(1)} ${(p2[0] - (p3[0] - p1[0]) / 6).toFixed(1)},${(p2[1] - (p3[1] - p1[1]) / 6).toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

/** 当日悬停明细 HTML 结构（热力图与堆叠条共用）：日期 + 条数 + 各类明细 */
function DayTip({ day }: { day: HomeActivityDay }) {
  const total = dayTotal(day);
  const rows = LEGEND_CATEGORIES.filter((c) => day.byCategory[c.key] > 0);
  return (
    <span className="tip">
      <span className="tt">
        {dateLabel(day.date)} {weekdayLabel(day.date)} · {total} 次
      </span>
      {rows.length === 0 ? (
        <span className="tr">休息</span>
      ) : (
        rows.map((c) => (
          <span className="tr" key={c.key}>
            <i style={{ background: c.color }} />
            {c.name}
            <em>
              {day.byCategory[c.key]}
              {c.key === 'ai' && day.tokens ? ` · ${fmtInt(day.tokens)} tokens` : ''}
            </em>
          </span>
        ))
      )}
    </span>
  );
}

// ---------------- 快捷入口 ----------------

const ENTRY_ICONS = {
  proof: 'M3 2.5 H11 L13 4.5 V13.5 H3 Z M5.5 6 H10.5 M5.5 8.5 H10.5 M5.5 11 H8.5',
  capture: 'M8 2 A6 6 0 1 0 8 14 A6 6 0 1 0 8 2 M2 8 H14 M8 2 C10 4.5 10 11.5 8 14 C6 11.5 6 4.5 8 2',
  compose: 'M4 2 H12 V14 H4 Z M6.5 5.5 H9.5 M6.5 8 H9.5 M6.5 10.5 H9.5',
  feedback: 'M2.5 3.5 H13.5 V10.5 H8 L5 13 V10.5 H2.5 Z',
} as const;

type EntryTint = 'orange' | 'green' | 'gold' | 'violet';

const ENTRIES: ReadonlyArray<{ testid: string; icon: keyof typeof ENTRY_ICONS; tint: EntryTint; name: string; desc: string; to: string }> = [
  { testid: 'home-proof-link', icon: 'proof', tint: 'orange', name: '录题', desc: '从图片或文档中录入试题', to: '#/proof' },
  { testid: 'home-capture-link', icon: 'capture', tint: 'green', name: '采集', desc: '从网络题库采集', to: '#/capture' },
  { testid: 'home-compose-entry', icon: 'compose', tint: 'gold', name: '组卷', desc: '选题、排版、导出', to: '#/basket' },
  { testid: 'home-feedback-link', icon: 'feedback', tint: 'violet', name: '反馈', desc: '课堂表现一键写反馈', to: '#/feedback' },
];

/** 快捷入口卡（通栏横条之一；testid 字面量取自 ENTRIES，等价保留 0037 清单） */
function EntryCard({ entry }: { entry: (typeof ENTRIES)[number] }) {
  return (
    <button
      type="button"
      className="qentry"
      data-tint={entry.tint}
      data-testid={entry.testid}
      onClick={() => (window.location.hash = entry.to)}
    >
      <span className="qicon">
        <svg width="21" height="21" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
          <path d={ENTRY_ICONS[entry.icon]} />
        </svg>
      </span>
      <span className="qtext">
        <span className="qname">{entry.name}</span>
        <span className="qdesc">{entry.desc}</span>
      </span>
      <span className="qarrow" aria-hidden="true">
        →
      </span>
    </button>
  );
}

// ---------------- 资产卡（存量） ----------------

/** 4 大数字口径（0037 口径文案沿用；含回收站/识别记录/学生×题等既有措辞） */
const ASSET_STATS: ReadonlyArray<{ testid: string; key: 'questions' | 'papers' | 'documentsRecognized' | 'mistakeRecords'; unit: string; label: string; tip: string }> = [
  {
    testid: 'home-stat-questions',
    key: 'questions',
    unit: '题',
    label: '题库题目',
    tip: '题库中未删除的试题总数（含采集与手动录入），来自题库表实时计数。',
  },
  {
    testid: 'home-stat-papers',
    key: 'papers',
    unit: '份',
    label: '试卷库',
    tip: '试卷管理中的试卷总数（不含回收站），含处理中与已出卷。',
  },
  {
    testid: 'home-stat-documents',
    key: 'documentsRecognized',
    unit: '篇',
    label: '录入文档',
    tip: '录题工作台的识别记录总数；每次识别一份文件（图片/粘贴/PDF）计一篇。',
  },
  {
    testid: 'home-stat-mistakes',
    key: 'mistakeRecords',
    unit: '题次',
    label: '错题沉淀',
    tip: '错题本中「学生×题」的记录总条数；同一道题多名学生错各计一条。',
  },
];

/** 沉淀曲线：纯 SVG 平滑面积图（Catmull-Rom + 渐变填充 + 终点圆点 + 月份刻度） */
function GrowthChart({ growth }: { growth: HomeDashboardStats['questionGrowth'] }) {
  const W = 560;
  const H = 96;
  const PAD = 4;
  const max = Math.max(...growth.map((p) => p.total), 1) * 1.06;
  const xOf = (i: number) => PAD + (i / Math.max(growth.length - 1, 1)) * (W - PAD * 2);
  const yOf = (v: number) => H - PAD - (v / max) * (H - PAD * 2);
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < growth.length; i += 3) pts.push([xOf(i), yOf(growth[i]!.total)]);
  pts.push([W - PAD, yOf(growth[growth.length - 1]!.total)]);
  const line = smoothPath(pts);
  const area = `${line}L${W - PAD},${H}L${PAD},${H}Z`;
  const last = pts[pts.length - 1]!;
  // 月份刻度：起点月 + 每月 1 日的真实位置（绝对定位）；与次刻度过近时舍起点月防重叠
  let ticks = [{ x: 0, m: Number(growth[0]!.date.split('-')[1]) }];
  for (let i = 1; i < growth.length; i++) {
    const [, m, d] = growth[i]!.date.split('-').map(Number);
    if (d === 1) ticks.push({ x: (i / Math.max(growth.length - 1, 1)) * 100, m: m! });
  }
  if (ticks.length > 1 && ticks[1]!.x < 7) ticks = ticks.slice(1);
  return (
    <>
      <div className="grow-chart" data-testid="home-growth-chart">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
          <defs>
            <linearGradient id="home-growth-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--green-ink)" stopOpacity=".28" />
              <stop offset="1" stopColor="var(--green-ink)" stopOpacity=".02" />
            </linearGradient>
          </defs>
          <path d={area} fill="url(#home-growth-fill)" />
          <path d={line} fill="none" stroke="var(--green-deep)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinecap="round" />
          <circle cx={last[0]} cy={last[1]} r="3.5" fill="var(--green-deep)" />
        </svg>
        {/* 终点数字 = 资产卡「题库题目」同源数字（目检清单：终点数字=题库题目数） */}
        <span className="grow-end" data-testid="home-growth-end" style={{ bottom: `${(1 - last[1] / H) * 100}%` }}>
          {fmtInt(growth[growth.length - 1]!.total)}
        </span>
      </div>
      <div className="grow-axis">
        {ticks.map((t, i) => (
          <span key={`${t.m}-${i}`} style={{ left: `${t.x}%` }}>
            {t.m}月
          </span>
        ))}
      </div>
    </>
  );
}

function AssetCard({ dash }: { dash: HomeDashboardStats }) {
  return (
    <section className="card" data-testid="home-dash-stats">
      <div className="zone-title">
        📚 教学资产
        <InfoTip text="存量口径：现在库里有多少。右侧「工作足迹」是流量口径（这段时间动了多少次），两者不重复。" />
      </div>
      <div className="asset-grid">
        {ASSET_STATS.map((s) => (
          <div className="asset" key={s.testid}>
            <div className="num" data-testid={s.testid}>
              {fmtInt(dash[s.key])}
              <span className="unit">{s.unit}</span>
            </div>
            <div className="lbl">
              {s.label}
              <InfoTip text={s.tip} />
            </div>
          </div>
        ))}
      </div>
      <div className="grow">
        <div className="grow-head">
          题库累计 · 近半年
          <span className="grow-delta" data-testid="home-growth-delta">
            +{fmtInt(monthDelta(dash.questionGrowth))} 本月
          </span>
        </div>
        <GrowthChart growth={dash.questionGrowth} />
      </div>
    </section>
  );
}

function EmptyAssetCard() {
  return (
    <section className="card" data-testid="home-empty-hero">
      <div className="zone-title">📚 教学资产</div>
      <div className="empty-hero">
        {/* 小方出现位之二：空库引导 stand（96px，各页空状态=stand） */}
        <Mascot mood="stand" size={96} />
        <h3>题库还是空的，从第一批题开始沉淀</h3>
        <p>采集或录入的题目会实时累计到这里。</p>
        <div className="empty-acts">
          <button className="btn btn-primary" data-testid="home-empty-capture-btn" onClick={() => (window.location.hash = '#/capture')}>
            去采集题目
          </button>
          <button className="btn btn-ghost" data-testid="home-empty-proof-btn" onClick={() => (window.location.hash = '#/proof')}>
            录一道题
          </button>
        </div>
      </div>
    </section>
  );
}

// ---------------- 足迹卡（流量） ----------------

/** 低数据态阈值（设计稿定档：半年动作总数 <100 且题库 <50 → 提示条） */
export const LOW_DATA_ACTIONS = 100;
export const LOW_DATA_QUESTIONS = 50;

const BAR_W = 600;
const BAR_H = 112;
const BAR_BASE = 100;
const BAR_MAX_H = 88;

function FootprintCard({ dash }: { dash: HomeDashboardStats }) {
  const { activity } = dash;
  const totals = categoryTotals(activity);
  const grand = LEGEND_CATEGORIES.reduce((s, c) => s + totals[c.key], 0);
  const isEmpty = grand === 0;
  const [focus, setFocus] = useState<HomeWorkCategory | null>(null);

  const weeks: HomeActivityDay[][] = [];
  for (let i = 0; i < activity.length; i += 7) weeks.push(activity.slice(i, i + 7));
  const best = bestDay(activity);
  const last30 = activity.slice(-30);
  const max30 = Math.max(...last30.map(dayTotal), 1);
  const slot = BAR_W / Math.max(last30.length, 1);
  const barW = 11;
  const lowData = !isEmpty && grand < LOW_DATA_ACTIONS && dash.questions < LOW_DATA_QUESTIONS;

  return (
    <section className="card" data-testid="home-footprint">
      <div className="flow-head">
        <span className="zone-title">
          📊 工作足迹
          <InfoTip text="流量口径：这段时间动手多少次（录题/组卷/错题/反馈/AI 调用），来自操作日志（operation_log）。采集入库与录题同源，一并计入录题；两卡数字口径不同不会重复。" />
        </span>
        {!isEmpty && (
          <span className="flow-total">
            <span className="u">近半年</span>
            <span className="n" data-testid="home-footprint-total">
              {fmtInt(grand)}
            </span>
            <span className="u">次动作</span>
          </span>
        )}
      </div>
      {lowData && <div className="notice notice-warm">🌱 数据还不多——继续录入，这里会长出你的工作节奏。</div>}
      <div className="heat-zone">
        <div className="heat-wk">
          <span>一</span>
          <span />
          <span>三</span>
          <span />
          <span>五</span>
          <span />
          <span />
        </div>
        <div className="heat-main">
          <div className="heat-months">
            {weeks.map((week, w) => {
              const firstMonth = Number(week[0]!.date.split('-')[1]);
              const prevMonth = w > 0 ? Number(weeks[w - 1]![0]!.date.split('-')[1]) : -1;
              return <span key={week[0]!.date}>{firstMonth !== prevMonth ? `${firstMonth}月` : ''}</span>;
            })}
          </div>
          <div className="heat" data-testid="home-heatmap">
            {activity.map((day, i) => {
              const total = dayTotal(day);
              const level = levelOf(total);
              return (
                <i
                  key={day.date}
                  className={`hcell${level ? ` lv${level}` : ''}${i === activity.length - 1 && !isEmpty ? ' today' : ''}`}
                  data-level={level}
                  data-date={day.date}
                >
                  <DayTip day={day} />
                </i>
              );
            })}
          </div>
          {isEmpty && (
            <div className="heat-empty-veil">
              <span>还没有足迹——从录第一道题开始</span>
            </div>
          )}
          <div className="heat-foot">
            {best && <span>最活跃 {shortDateLabel(best.date)}（{best.total} 次）</span>}
            <span className="heat-scale">
              少
              <i />
              <i />
              <i />
              <i />
              <i />
              多
            </span>
          </div>
        </div>
      </div>
      {!isEmpty && (
        <div className="flow-bottom">
          <div>
            <div className="bars-head">近 30 日节奏</div>
            <div className="bars-chart">
              <svg className={focus ? 'bars-svg dim' : 'bars-svg'} viewBox={`0 0 ${BAR_W} ${BAR_H}`}>
                {[0.25, 0.5, 0.75].map((f) => (
                  <line
                    key={f}
                    x1="0"
                    x2={BAR_W}
                    y1={(BAR_BASE - f * BAR_MAX_H).toFixed(1)}
                    y2={(BAR_BASE - f * BAR_MAX_H).toFixed(1)}
                    stroke="var(--line-strong)"
                    strokeWidth="0.6"
                    strokeDasharray="3 4"
                  />
                ))}
                {last30.map((day, k) => {
                  let y = BAR_BASE;
                  const x = (k * slot + (slot - barW) / 2).toFixed(1);
                  return LEGEND_CATEGORIES.map((c) => {
                    const v = day.byCategory[c.key];
                    if (!v) return null;
                    const h = Math.max((v / max30) * BAR_MAX_H, 2.5);
                    y -= h;
                    return (
                      <rect
                        key={`${day.date}-${c.key}`}
                        className={focus === c.key ? 'seg keep' : 'seg'}
                        data-cat={c.key}
                        x={x}
                        y={y.toFixed(1)}
                        width={barW}
                        height={h.toFixed(1)}
                        fill={c.color}
                      />
                    );
                  });
                })}
              </svg>
              {last30.map((day, k) => (
                <span key={day.date} className="bar-hot" style={{ left: `${(k / Math.max(last30.length, 1)) * 100}%`, width: `${100 / Math.max(last30.length, 1)}%` }}>
                  <DayTip day={day} />
                </span>
              ))}
            </div>
            <div className="bars-axis">
              <span>{shortDateLabel(last30[0]!.date)}</span>
              <span>{shortDateLabel(last30[last30.length - 1]!.date)}</span>
            </div>
          </div>
          <div className="legend">
            {LEGEND_CATEGORIES.map((c) => (
              <button
                type="button"
                key={c.key}
                className={focus && focus !== c.key ? 'lg off' : 'lg'}
                data-cat={c.key}
                onClick={() => setFocus((cur) => (cur === c.key ? null : c.key))}
              >
                <i className="dot" style={{ background: c.color }} />
                {c.name}
                <span className="n">{fmtInt(totals[c.key])}</span>
              </button>
            ))}
            <div className="ai-line">
              AI 消耗 <b>{tokenText(activity.reduce((s, d) => s + d.tokens, 0))} tokens</b>
              <InfoTip text="各模型返回的 prompt+completion tokens 累计（近半年窗口）；供应商未返回 usage 时不计入。" />
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------- 最近试卷 ----------------

function RecentPapers({ papers }: { papers: HomeDashboardStats['recentPapers'] }) {
  if (papers.length === 0) return null;
  return (
    <section className="card" data-testid="home-recent-papers">
      <div className="zone-title">
        📝 最近试卷
        <button type="button" className="more" data-testid="home-recent-more" onClick={() => (window.location.hash = '#/papers')}>
          查看全部 →
        </button>
      </div>
      <div className="recent-row">
        {papers.map((p, i) => (
          <div
            className={`pcard${i === 0 ? ' star tape' : ''}`}
            key={p.id}
            data-testid={`home-recent-${p.id}`}
            role="button"
            tabIndex={0}
            // 落点沿用试卷管理页既有口径（0044）：试题篮→#/basket/:id，其余→#/compose/:id
            onClick={() => {
              window.location.hash = p.status === 'basket' ? `#/basket/${p.id}` : `#/compose/${p.id}`;
            }}
          >
            <div className="pt">{p.title}</div>
            <div className="pm">
              <span className={`st-pill ${pillTone(p.status)}`}>{PAPER_STATUS_LABEL[p.status]}</span>
              <span>{p.questionCount} 题</span>
              <span className="t">{relativeTime(p.updatedAt)}</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** 状态 pill 色调（设计稿两态：排版中=yellow / 已完成=green）：已定稿=green，其余（草稿/排版中/已归档）走 yellow */
function pillTone(status: PaperStatus): 'yellow' | 'green' {
  return status === 'done' ? 'green' : 'yellow';
}

// ---------------- 页装 ----------------

export function HomePage() {
  // 渲染时读取桥（preload 注入先于首渲染；测试可注入假桥）
  const guard = window.__mofangGuard;
  const [dash, setDash] = useState<HomeDashboardStats | null>(null);

  useEffect(() => {
    if (guard) {
      guard.getDashboard().then(setDash).catch(() => setDash(null));
    }
  }, [guard]);

  const today = new Date();
  const todayLabel = `${today.getMonth() + 1}月${today.getDate()}日 · ${WEEKDAY_NAMES[today.getDay()]}`;
  const isEmpty = dash !== null && dash.questions === 0;
  const showStreak = dash !== null && dash.streak.current > 0;

  return (
    <div className="home-v3">
      <header className="hero">
        <h1>工作台</h1>
        {/* 小方出现位之一：页头 cheer（42px），沉淀成就感暗示；不进导航（组件纪律） */}
        <Mascot mood="cheer" size={42} />
        <span className="hero-sub">
          <span className="hero-date" data-testid="home-today">
            {todayLabel}
          </span>
          {'　'}你的教学资产都在沉淀
        </span>
        <span className="hero-right">
          {showStreak && (
            <span className="streak" data-testid="home-streak" title={`最长连续 ${dash.streak.longest} 天`}>
              🔥 连续 {dash.streak.current} 天
            </span>
          )}
        </span>
      </header>

      <section className="quick">
        {ENTRIES.map((e) => (
          <EntryCard key={e.testid} entry={e} />
        ))}
      </section>

      {dash !== null && (
        <>
          <section className="duo">
            {isEmpty ? <EmptyAssetCard /> : <AssetCard dash={dash} />}
            <FootprintCard dash={dash} />
          </section>
          {!isEmpty && <RecentPapers papers={dash.recentPapers} />}
        </>
      )}
    </div>
  );
}
