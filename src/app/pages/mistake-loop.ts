// 0026 P1-P4：错题闭环产品层的纯函数层（无 IO、无 React）。
//
// 单源口径：错题行过滤 / 时间窗归一与 0025 数据层完全同规则——直接复用 bank 侧
// mistake-aggregate 的 normalizeOccurredFrom/To（该模块本就被 mock 侧引入渲染编译图，
// 不拉 node 专用类型），避免 UI 侧另写一套时间比较。
//
// 分工：本模块只做「筛选入参拼装 / 派生算术 / 展示文本 / 卷头装配」；
// 真库读写一律经 ExtPageServices（0025 已接线通道），本模块不含任何 IPC。

import type {
  ClassInfo, Mistake, MistakeAggregateFilter, MistakeAggregateRow, MistakeStage, PaperHeaderLine, PaperSet,
} from '../../shared/contracts/bank-types.js';
import { normalizeOccurredFrom, normalizeOccurredTo } from '../../bank/mistake-aggregate.js';

/** 错题本左侧筛选态 → 0025 聚合筛选（studentIds 空数组 = 不过滤，与契约同义） */
export interface MistakeScope {
  /** 学生范围（班级 = 其成员 id 集）；undefined/空集 = 全部学生 */
  studentIds?: string[];
  stage?: MistakeStage;
  /** questions.subject 标签精确匹配（0025 口径，非 subject_id） */
  subject?: string;
  /** 时间窗下界（date-only=当日 00:00:00.000Z 起，含全天） */
  occurredFrom?: string;
  /** 时间窗上界（date-only=当日 23:59:59.999Z 止，含全天） */
  occurredTo?: string;
}

export interface MistakeWindow {
  from: string;
  to: string;
}

/** scope → 0025 聚合/导出口 filter（空值不下发，避免「空数组=全量」被误读为筛选） */
export function toAggregateFilter(scope: MistakeScope): MistakeAggregateFilter {
  const filter: MistakeAggregateFilter = {};
  if (scope.stage) filter.stage = scope.stage;
  if (scope.subject) filter.subject = scope.subject;
  if (scope.occurredFrom) filter.occurredFrom = scope.occurredFrom;
  if (scope.occurredTo) filter.occurredTo = scope.occurredTo;
  if (scope.studentIds && scope.studentIds.length > 0) filter.studentIds = [...scope.studentIds];
  return filter;
}

/** 本地日期（YYYY-MM-DD）；不引时区库，按运行环境本地时区取年月日 */
export function localDate(date: Date): string {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, '0');
  const d = `${date.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 本周（周一 00:00 ~ 周日 23:59:59 的本地日期，date-only 交给 0025 归一为当日全含） */
export function weekWindow(now: Date): MistakeWindow {
  const day = now.getDay(); // 0=周日
  const offsetToMonday = (day + 6) % 7;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offsetToMonday);
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  return { from: localDate(monday), to: localDate(sunday) };
}

/**
 * 错题行是否落在 scope 内（与 0025 聚合过滤逐条同规则）：
 * stage 精确、studentIds 空=全部（OR）、时间窗含边界（date-only 归一后字典序比较）。
 */
export function inScope(mistake: Mistake, scope: MistakeScope): boolean {
  if (scope.stage && mistake.stage !== scope.stage) return false;
  if (scope.studentIds && scope.studentIds.length > 0 && !scope.studentIds.includes(mistake.studentId)) return false;
  if (scope.occurredFrom && mistake.occurredAt < normalizeOccurredFrom(scope.occurredFrom)) return false;
  if (scope.occurredTo && mistake.occurredAt > normalizeOccurredTo(scope.occurredTo)) return false;
  return true;
}

/** scope 内错题行 id（批量口入参：0025 的批量只接受 mistakes 行 id，聚合行需先摊平到行） */
export function scopeMistakeIds(mistakes: Mistake[], scope: MistakeScope): string[] {
  return mistakes.filter((m) => inScope(m, scope)).map((m) => m.id);
}

/**
 * 入篮计划：已在篮的题与候选内重复、空串一律跳过。
 * skipped = 候选数 - 实际入篮数（既有三处内联实现的共同口径，抽为纯函数供错题篮复用）。
 */
export function planAddToBasket(existingIds: string[], candidateIds: string[]): { toAdd: string[]; skipped: number } {
  const taken = new Set(existingIds.filter((id) => id !== ''));
  const toAdd: string[] = [];
  let skipped = 0;
  for (const id of candidateIds) {
    if (!id || taken.has(id)) {
      skipped++;
      continue;
    }
    taken.add(id);
    toAdd.push(id);
  }
  return { toAdd, skipped };
}

/** D3 出卷题量缺省（「按错误人次 Top N 出卷」） */
export const MISTAKE_TOP_N_DEFAULT = 20;

/** Top N 输入归一：正整数；空/非法/非正 → fallback；小数向下取整 */
export function normalizeTopN(raw: string, fallback: number = MISTAKE_TOP_N_DEFAULT): number {
  const value = Number.parseFloat(raw.trim());
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}

/** 取前 N（聚合序已由 0025 保证人次降序，本层只截断） */
export function topN(ids: string[], n: number): string[] {
  return ids.slice(0, Math.max(0, n));
}

/** 人次文案（P-30「错 7/12 人」；分母未知时不编造） */
export function describeWrongCount(wrongCount: number, scopeCount: number): string {
  return scopeCount > 0 ? `错 ${wrongCount}/${scopeCount} 人` : `错 ${wrongCount} 人`;
}

/**
 * 筛选口径下的列表明细合计（页头）。
 * 行内 wrongCount 是「每题去重学生数」，逐题相加得的是**人次**而不是去重人数
 * （一生错 3 题计 3 次）——故此处只报人次，不冒充「人」。
 */
export function describeScopeTotal(totalWrongCount: number, questionCount: number): string {
  return `共 ${totalWrongCount} 人次 · ${questionCount} 题`;
}

/** 每页题数（题库式卡片：高度随题面/图/选项浮动，一屏行数不再固定，改按页切） */
export const MISTAKE_PAGE_SIZE = 20;

/** 总页数（空列表记为 1 页，空态与页控件语义一致） */
export function pageCount(total: number, size: number = MISTAKE_PAGE_SIZE): number {
  if (size <= 0) return 1;
  return Math.max(1, Math.ceil(total / size));
}

/** 页码夹取到 [1, 页数]（越界不抛错、不空屏） */
export function clampPage(page: number, total: number, size: number = MISTAKE_PAGE_SIZE): number {
  const max = pageCount(total, size);
  if (!Number.isFinite(page)) return 1;
  return Math.min(Math.max(Math.floor(page), 1), max);
}

/** 取第 page 页（页码先夹取） */
export function pageSlice<T>(items: T[], page: number, size: number = MISTAKE_PAGE_SIZE): T[] {
  const start = (clampPage(page, items.length, size) - 1) * size;
  return items.slice(start, start + size);
}

/** 每题的学生状态人数（红/黄/绿各多少名学生） */
export interface StudentStageCounts {
  red: number;
  yellow: number;
  green: number;
}

/** 学生状态文案（红黄绿是**学生**对这道题的掌握状态；与 ExtUi.STAGE_LABEL 的短名同义） */
export const STUDENT_STAGE_LABEL: Record<MistakeStage, string> = {
  red: '未掌握',
  yellow: '订正过',
  green: '已掌握',
};

/**
 * 三道状态口的返回 → 每题学生状态分布。
 * 三态是学生口径（0025 契约里 stage 在 mistakes 行上，一行=一名学生对一道题），
 * 逐题显示「未掌握 N / 订正过 N / 已掌握 N」才是这张表的本义；
 * 总数口（total）决定出现哪些题——状态口里多出的题不凭空造行。
 */
export function mergeStageBreakdown(
  total: MistakeAggregateRow[],
  stageRows: Array<{ stage: MistakeStage; rows: MistakeAggregateRow[] }>,
): Map<string, StudentStageCounts> {
  const map = new Map<string, StudentStageCounts>();
  for (const row of total) map.set(row.questionId, { red: 0, yellow: 0, green: 0 });
  for (const { stage, rows } of stageRows) {
    for (const row of rows) {
      const counts = map.get(row.questionId);
      if (counts) counts[stage] = row.wrongCount;
    }
  }
  return map;
}

/** 卡片上的状态条目：只列非零状态，次序恒为 未掌握→订正过→已掌握（不随数据跳动） */
export function studentStageEntries(
  counts: StudentStageCounts,
): Array<{ stage: MistakeStage; label: string; count: number }> {
  const order: MistakeStage[] = ['red', 'yellow', 'green'];
  const out: Array<{ stage: MistakeStage; label: string; count: number }> = [];
  for (const stage of order) {
    const count = counts[stage];
    if (count > 0) out.push({ stage, label: STUDENT_STAGE_LABEL[stage], count });
  }
  return out;
}

/** 班级错题集卷名（D3 整班一份） */
export function classMistakeTitle(className: string, n: number): string {
  return `${className || '全班'}错题集 Top ${n}`;
}

/** 成册卷名（P4；时间窗紧凑无空格，便于列表单行显示） */
export function mistakeBookTitle(studentName: string, window: MistakeWindow | {}): string {
  const range = windowRangeText(window, '~');
  return range ? `错题本·${studentName}·${range}` : `错题本·${studentName}`;
}

/** 成册卷头多行（0009 header.lines 路径：学生名 / 时间窗 / 题量；零 docgen 改动） */
export function mistakeBookHeaderLines(
  studentName: string,
  window: MistakeWindow | {},
  questionCount: number,
): PaperHeaderLine[] {
  const lines: PaperHeaderLine[] = [
    { text: `错题本 · ${studentName}`, sizePt: 16, align: 'center', bold: true },
  ];
  const range = windowRangeText(window, ' ~ ');
  if (range) lines.push({ text: `错题范围：${range}`, sizePt: 10, align: 'center' });
  lines.push({ text: `共 ${questionCount} 题`, sizePt: 10, align: 'center' });
  return lines;
}

function windowRangeText(window: MistakeWindow | {}, separator: string): string | undefined {
  const from = 'from' in window ? window.from : undefined;
  const to = 'to' in window ? window.to : undefined;
  if (!from && !to) return undefined;
  return `${from ?? '最早'}${separator}${to ?? '最新'}`;
}

const DIFFICULTY_TEXT: Record<number, string> = { 1: '很容易', 2: '较易', 3: '中等', 4: '较难', 5: '很难' };

/** 难度文案（与题库页 BankBrowser 同表；越界/缺省不显示） */
export function difficultyLabel(difficulty: number | undefined): string | undefined {
  if (difficulty === undefined) return undefined;
  return DIFFICULTY_TEXT[difficulty];
}

/**
 * 试卷集 batch_meta 只读展示（P3/P-06：一期只定字段，UI 不写）。
 * 已登记三键出中文行；未登记键原样回显（不吞数据）；类型不符不冒充数字。
 */
export function batchMetaLines(meta: PaperSet['batchMeta']): string[] {
  if (!meta) return [];
  const lines: string[] = [];
  const push = (key: string, label: string): void => {
    const value = meta[key];
    if (value === undefined || value === null) return;
    if (key === 'perStudentLimit' && typeof value === 'number') { lines.push(`${label}：${value} 题`); return; }
    if (key === 'timeWindowDays' && typeof value === 'number') { lines.push(`${label}：${value} 天`); return; }
    if (key === 'sourceRule' && typeof value === 'string') { lines.push(`${label}：${value}`); return; }
    lines.push(`${key}：${String(value)}`);
  };
  push('perStudentLimit', '每人上限');
  push('timeWindowDays', '时间窗');
  push('sourceRule', '选题来源');
  for (const key of Object.keys(meta)) {
    if (key === 'perStudentLimit' || key === 'timeWindowDays' || key === 'sourceRule') continue;
    push(key, key);
  }
  return lines;
}

/** 默认班级（「本班」）：记忆值仍在册则沿用；否则唯一在册班级；再否则不替用户猜（空=全部） */
export function pickDefaultClassId(classes: ClassInfo[], remembered: string): string {
  const active = classes.filter((c) => c.status === 'active');
  if (remembered && active.some((c) => c.id === remembered)) return remembered;
  return active.length === 1 ? active[0].id : '';
}

/** 学科选项单调并集：去重、保出现序、剔空（切换学科后选项不因当前结果集收缩而消失） */
export function mergeSubjects(current: string[], incoming: string[]): string[] {
  const out = [...current];
  for (const value of incoming) {
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}
