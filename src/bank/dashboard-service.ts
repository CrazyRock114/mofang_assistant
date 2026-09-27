// 0037（只增）：首页沉淀统计聚合——只读查询 + 纯函数，零迁移零新表。
// 口径（任务书 §一 P1 + 设计稿 v1.1 §2 + 目检返工意见 #4/#5，2026-09-21）：
//   题库题目 = questions 未删除（deleted=0）；试卷库 = papers 不含回收站（status≠'trashed'）；
//   录入文档 = recog_runs 行数（录题工作台识别记录，每识别一份文件计一篇，不分状态；
//     返工 #4 换入，原「网络采集」指标撤下）；
//   错题沉淀 = mistakes 行数（「学生×题」记录条数，与错题本页「学生状态」口径一致）；
//   AI 用量 = operation_log 中 operation_type='ai.invoke' 且 status='succeeded' 的留痕
//     （写入点 shell/ai AiGateway，主进程直调），token = metadata_json.tokens（供应商未返回不计入）；
//     次数/token 为全期累计，30 天窗只作用趋势。
// 近 30 天时间窗过滤为纯函数（bucketInvocationsByDay）：本地日聚合 {次数, token} 双值、
//   零日补 0、升序、末位=今日（返工 #5：柱悬停弹窗需当日 token）。
//
// 0049（只增）：首页 v3「工作足迹」——流量口径（这段时间动了多少次），与 0037 的存量口径互不重复（D-068）：
//   六类工作动作映射表 WORK_CATEGORY_RULES + 纯函数 classifyWorkOperation / aggregateWorkActivity /
//   buildQuestionGrowth，聚合进 HomeDashboardStats.activity / streak / questionGrowth / recentPapers。
//   窗口：起点 = 本周一 −26 周（周一对齐），末日 = 今日；零日补全、升序（今日为周一时恰 183 天）。
//   连续天数：当日六类合计 > 0 计活跃；current 自今日向前、longest 取窗口内最长。
//   沉淀曲线：现存题按 created_at **本地日** 累计（任务书 §P2.4 举的 SQL 是 UTC 口径 date()，
//     与模块既有 localDateKey 本地日口径不一致，实现取本地日；申报见 0049 交付报告）。
//   最近试卷：papers 表**无 updated_at 列**（本单零迁移），按 created_at 降序（同既有 listPapers 口径），
//     字段名沿用契约授权字面 updatedAt。
//   采集与录题同源不可分：OperationLogger.wrap('question.create') 不携带 metadata（恒 '{}'），且
//     capture/ingest.ts 与 recog/ingest.ts 走同一 QuestionService.createQuestion → 按任务书 §P2.1
//     fallback「采集并入录题」，'capture' 桶保留但恒 0（图例五类，申报见 0049 交付报告）。

import type { Database } from './db.js';
import type {
  AiDailyCount,
  HomeActivityDay,
  HomeDashboardStats,
  HomeWorkCategory,
  PaperStatus,
} from '../shared/contracts/bank-types.js';

// 0049：接口定义在契约（bank-types）单一来源，本地仅转发类型名——避免双份漂移（7 既字段零改动）。
export type { AiDailyCount, HomeActivityDay, HomeDashboardStats, HomeWorkCategory } from '../shared/contracts/bank-types.js';

export const AI_DAILY_WINDOW_DAYS = 30;

/** 0049：足迹窗口长度（周）——起点 = 本周一 −26 周，末日 = 今日（今日为周一时恰 183 天） */
export const WORK_WINDOW_WEEKS = 26;

/** 本地时区日期键 YYYY-MM-DD（纯函数） */
export function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 留痕行 → 近 days 天按日 {次数, token}（纯函数：时间窗过滤 + 零日补齐）。
 * 窗口 = 本地今日起往前 days-1 天的 0 点（含两端）；started_at（UTC ISO）按本地日归桶。
 */
export function bucketInvocationsByDay(
  rows: Array<{ startedAt: string; tokens: number }>,
  now: Date,
  days: number = AI_DAILY_WINDOW_DAYS,
): AiDailyCount[] {
  const windowStartMs = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1), 0, 0, 0, 0).getTime();
  const counts = new Map<string, { count: number; tokens: number }>();
  for (const row of rows) {
    const t = Date.parse(row.startedAt);
    if (Number.isNaN(t) || t < windowStartMs) continue;
    const key = localDateKey(new Date(t));
    const bucket = counts.get(key) ?? { count: 0, tokens: 0 };
    bucket.count += 1;
    bucket.tokens += row.tokens;
    counts.set(key, bucket);
  }
  const out: AiDailyCount[] = [];
  for (let i = 0; i < days; i++) {
    const date = localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1 - i)));
    const bucket = counts.get(date);
    out.push({ date, count: bucket?.count ?? 0, tokens: bucket?.tokens ?? 0 });
  }
  return out;
}

interface InvokeLogRow {
  started_at: string;
  metadata_json: string;
}

/** 单条留痕的 token 计入：优先 totalTokens，缺省回退 prompt+completion；坏 metadata 兜底为 0 */
function tokensOfMetadata(metadataJson: string): number {
  try {
    const meta = JSON.parse(metadataJson) as {
      tokens?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
    };
    const t = meta.tokens;
    if (!t || typeof t !== 'object') return 0;
    if (typeof t.totalTokens === 'number') return t.totalTokens;
    const prompt = typeof t.promptTokens === 'number' ? t.promptTokens : 0;
    const completion = typeof t.completionTokens === 'number' ? t.completionTokens : 0;
    return prompt + completion;
  } catch {
    return 0;
  }
}

// ==================== 0049：工作足迹（流量口径） ====================

/**
 * 六类工作动作映射表（bank 层导出常量，测试直引）。
 * exact = 全等匹配；prefixes = 前缀匹配（前缀自带 `.`，故 'paper.' 不会误吃 'paperSet.*'）。
 * capture 规则为空 = 任务书 §P2.1 的 fallback（metadata 不可分 → 采集并入录题）；留作未来可分的占位。
 */
export const WORK_CATEGORY_RULES: Readonly<
  Record<HomeWorkCategory, { exact: readonly string[]; prefixes: readonly string[] }>
> = {
  proof: {
    exact: ['question.create', 'question.update', 'question.addTag', 'question.removeTag', 'recogRun.create'],
    prefixes: [],
  },
  capture: { exact: [], prefixes: [] },
  compose: { exact: [], prefixes: ['paper.', 'paperSet.'] },
  mistake: { exact: [], prefixes: ['mistake.'] },
  feedback: { exact: [], prefixes: ['feedback.'] },
  ai: { exact: ['ai.invoke'], prefixes: [] },
};

/** operation_type → 六类之一；未映射（学生/班级/考试/字典/树/预设/模型档案/备份恢复/删题…）返回 null */
export function classifyWorkOperation(operationType: string): HomeWorkCategory | null {
  for (const category of Object.keys(WORK_CATEGORY_RULES) as HomeWorkCategory[]) {
    const rule = WORK_CATEGORY_RULES[category];
    if (rule.exact.includes(operationType)) return category;
    if (rule.prefixes.some((p) => operationType.startsWith(p))) return category;
  }
  return null;
}

/** 窗口起点（本地零点）= 本周一 −26 周（周一对齐） */
export function workWindowStart(now: Date): Date {
  const mondayOffset = (now.getDay() + 6) % 7; // 周一=0 … 周日=6
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - mondayOffset - WORK_WINDOW_WEEKS * 7);
}

/**
 * 窗口日期键（升序，起点…今日逐日连续；今日为周一时恰 183 天、其余 184~189 天）。
 * 逐日推进用本地日期构造（非 +86400000 毫秒），免夏令时跳变。
 */
export function workWindowKeys(now: Date): string[] {
  const start = workWindowStart(now);
  const todayKey = localDateKey(now);
  const keys: string[] = [];
  for (let i = 0; ; i++) {
    const key = localDateKey(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
    keys.push(key);
    if (key >= todayKey) break;
  }
  return keys;
}

/** 足迹留痕行（调用方保证已按 status='succeeded' 过滤；tokens 仅 ai.invoke 有意义） */
export interface WorkLogRow {
  operationType: string;
  /** UTC ISO 时刻 */
  startedAt: string;
  tokens?: number;
}

function zeroByCategory(): Record<HomeWorkCategory, number> {
  return { proof: 0, capture: 0, compose: 0, mistake: 0, feedback: 0, ai: 0 };
}

function isActiveDay(day: HomeActivityDay): boolean {
  return Object.values(day.byCategory).some((n) => n > 0);
}

/**
 * 留痕行 → 窗口内按日足迹（零日补全、升序、末位=今日）+ 连续天数（纯函数）。
 * 窗外行（起点前/今日之后）不计；未映射类型不计；tokens 只累加 ai 桶当日值。
 */
export function aggregateWorkActivity(
  rows: readonly WorkLogRow[],
  now: Date,
): { activity: HomeActivityDay[]; streak: { current: number; longest: number } } {
  const keys = workWindowKeys(now);
  const index = new Map(keys.map((k, i) => [k, i] as const));
  const activity = keys.map<HomeActivityDay>((date) => ({ date, byCategory: zeroByCategory(), tokens: 0 }));

  for (const row of rows) {
    const category = classifyWorkOperation(row.operationType);
    if (!category) continue;
    const t = Date.parse(row.startedAt);
    if (Number.isNaN(t)) continue;
    const day = activity[index.get(localDateKey(new Date(t))) ?? -1];
    if (!day) continue;
    day.byCategory[category] += 1;
    if (category === 'ai' && row.tokens) day.tokens += row.tokens;
  }

  let longest = 0;
  let run = 0;
  for (const day of activity) {
    if (isActiveDay(day)) {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  let current = 0;
  for (let i = activity.length - 1; i >= 0 && isActiveDay(activity[i]!); i--) current += 1;

  return { activity, streak: { current, longest } };
}

/**
 * 现存题 created_at → 沉淀曲线（窗口内逐日累计存量；纯函数）。
 * 窗口前的题计入首日基线；终点恒等传入行数（= questions WHERE deleted=0 计数，与资产卡大数字同源）。
 * 单调不减：已删题不在入参中，故不回溯扣除。未来日期（时钟偏差）并入终点，保证终点恒等。
 */
export function buildQuestionGrowth(createdAts: readonly string[], now: Date): Array<{ date: string; total: number }> {
  const keys = workWindowKeys(now);
  const first = keys[0]!;
  const last = keys[keys.length - 1]!;
  const perDay = new Map<string, number>();
  let baseline = 0;
  let ahead = 0;
  for (const ts of createdAts) {
    const t = Date.parse(ts);
    if (Number.isNaN(t)) continue;
    const key = localDateKey(new Date(t));
    if (key < first) baseline += 1;
    else if (key > last) ahead += 1;
    else perDay.set(key, (perDay.get(key) ?? 0) + 1);
  }
  let acc = baseline;
  const out = keys.map((date) => {
    acc += perDay.get(date) ?? 0;
    return { date, total: acc };
  });
  if (ahead > 0) out[out.length - 1]!.total += ahead;
  return out;
}

/** 最近试卷（排除回收站；挂题计数照抄 listPapers 的 LEFT JOIN 口径；papers 无 updated_at → created_at 降序） */
function recentPapersOf(db: Database): HomeDashboardStats['recentPapers'] {
  const rows = db.prepare(`
    SELECT p.id, p.title, p.status, p.created_at, COUNT(pq.id) AS question_count
    FROM papers p
    LEFT JOIN paper_questions pq ON p.id = pq.paper_id
    WHERE p.status != 'trashed'
    GROUP BY p.id
    ORDER BY p.created_at DESC
    LIMIT 3
  `).all() as Array<{ id: string; title: string; status: string; created_at: string; question_count: number }>;
  return rows.map((r) => ({
    id: String(r.id),
    title: String(r.title),
    status: r.status as PaperStatus,
    questionCount: Number(r.question_count),
    updatedAt: String(r.created_at),
  }));
}

/** 聚合首页沉淀统计（只读；now 注入以便测试钉死时间窗） */
export function getHomeDashboard(db: Database, now: Date = new Date()): HomeDashboardStats {
  const questions = (db.prepare('SELECT COUNT(*) AS n FROM questions WHERE deleted = 0').get() as { n: number }).n;
  const papers = (db.prepare(`SELECT COUNT(*) AS n FROM papers WHERE status != 'trashed'`).get() as { n: number }).n;
  const documentsRecognized = (db.prepare('SELECT COUNT(*) AS n FROM recog_runs').get() as { n: number }).n;
  const mistakeRecords = (db.prepare('SELECT COUNT(*) AS n FROM mistakes').get() as { n: number }).n;

  const rawRows = db.prepare(
    `SELECT started_at, metadata_json FROM operation_log WHERE operation_type = 'ai.invoke' AND status = 'succeeded'`,
  ).all();
  const rows: InvokeLogRow[] = rawRows.map((r) => ({
    started_at: String(r.started_at),
    metadata_json: String(r.metadata_json),
  }));

  let aiTokens = 0;
  for (const row of rows) aiTokens += tokensOfMetadata(row.metadata_json);

  // 0049：足迹窗口内的成功留痕（起点 = 窗口首个本地零点；ISO 文本比较即时刻比较）
  const rawWorkRows = db.prepare(
    `SELECT operation_type, started_at, metadata_json FROM operation_log
     WHERE status = 'succeeded' AND started_at >= ?`,
  ).all(workWindowStart(now).toISOString()) as Array<{ operation_type: string; started_at: string; metadata_json: string }>;
  const workRows: WorkLogRow[] = rawWorkRows.map((r) => {
    const operationType = String(r.operation_type);
    const startedAt = String(r.started_at);
    // 只有 AI 桶用得上 tokens：其余类型不解析 metadata（省一遍 JSON.parse）
    return operationType === 'ai.invoke'
      ? { operationType, startedAt, tokens: tokensOfMetadata(String(r.metadata_json)) }
      : { operationType, startedAt };
  });
  const { activity, streak } = aggregateWorkActivity(workRows, now);

  const createdAts = (db.prepare('SELECT created_at FROM questions WHERE deleted = 0').all() as Array<{ created_at: string }>)
    .map((r) => String(r.created_at));

  return {
    questions,
    papers,
    documentsRecognized,
    mistakeRecords,
    aiInvocations: rows.length,
    aiTokens,
    aiDaily: bucketInvocationsByDay(
      rows.map((r) => ({ startedAt: r.started_at, tokens: tokensOfMetadata(r.metadata_json) })),
      now,
    ),
    activity,
    streak,
    questionGrowth: buildQuestionGrowth(createdAts, now),
    recentPapers: recentPapersOf(db),
  };
}
