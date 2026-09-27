// 0025 P1：错误人次聚合口径的纯函数与 SQL 构造（无 IO、不引 db/服务——真实实现与 mock 单一来源；
// 照 event-payload.ts 先例独立成模块，避免 mock 侧经服务链把 db 拉进 renderer 编译图）。
// 口径：错误人次 = COUNT(DISTINCT student_id)；默认人次降序、同人次按题号升序；时间窗含边界。

import type {
  MistakeStage, MistakeAggregateFilter, MistakeAggregateRow,
} from '../shared/contracts/bank-types.js';

/** 题干摘要截断上限（UTF-16 码元） */
export const STEM_SUMMARY_MAX = 80;

/** 题干摘要：优先 stem_html 回落 content → strip HTML → 折叠空白 → 超长截断加省略号 */
export function summarizeStem(stemHtml: string | null | undefined, content: string | null | undefined): string {
  const text = (stemHtml || content || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > STEM_SUMMARY_MAX ? `${text.slice(0, STEM_SUMMARY_MAX)}…` : text;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** 时间窗下界归一：date-only → 当日 00:00:00.000Z（含全天）；其余按 ISO 原样字典序比较 */
export function normalizeOccurredFrom(value: string): string {
  return DATE_ONLY.test(value) ? `${value}T00:00:00.000Z` : value;
}

/** 时间窗上界归一：date-only → 当日 23:59:59.999Z（含全天）；其余按 ISO 原样字典序比较 */
export function normalizeOccurredTo(value: string): string {
  return DATE_ONLY.test(value) ? `${value}T23:59:59.999Z` : value;
}

/** 批量入参守卫：非空字符串数组（空集抛错——不静默返回 0，也不留无效日志） */
export function assertBatchIds(ids: string[]): void {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error('Invalid ids: mistake batch requires a non-empty id list');
  }
  if (ids.some((id) => typeof id !== 'string' || !id)) {
    throw new Error('Invalid ids: every mistake id must be a non-empty string');
  }
}

/** stage 运行期守卫（契约层是字面量联合，服务层再兜一道） */
export function assertMistakeStage(stage: MistakeStage): void {
  if (stage !== 'red' && stage !== 'yellow' && stage !== 'green') {
    throw new Error(`Invalid stage: ${String(stage)}`);
  }
}

/**
 * 查询行形态（SELECT 别名直对齐列名；取值一律经下方判型访问器）。
 * 值域自持、不引 node:sqlite 类型——本模块经 mock 侧被 renderer 编译图引用，不得拉入 node 专用类型。
 */
type RowValue = string | number | bigint | boolean | Uint8Array | null | undefined;
export type AggregateRow = Record<string, RowValue>;

const readString = (row: AggregateRow, key: string): string => {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`错误人次聚合行字段 ${key} 期望字符串`);
  return value;
};

const readOptionalString = (row: AggregateRow, key: string): string | undefined => {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`错误人次聚合行字段 ${key} 期望字符串或 NULL`);
  return value;
};

const readNumber = (row: AggregateRow, key: string): number => {
  const value = row[key];
  if (typeof value === 'bigint') return Number(value);
  if (typeof value !== 'number') throw new Error(`错误人次聚合行字段 ${key} 期望数值`);
  return value;
};

const readOptionalNumber = (row: AggregateRow, key: string): number | undefined => {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value !== 'number') throw new Error(`错误人次聚合行字段 ${key} 期望数值或 NULL`);
  return value;
};

/**
 * 聚合 SQL（真实实现单点；mock 侧按同一口径内存复刻，见 MockMistakeService.aggregateByQuestion）。
 * INNER JOIN questions：错题行恒有题行（FK 约束）；软删题不排除（题/错题快照哲学：题软删后错题仍可显示）。
 */
export function buildAggregateSql(filter: MistakeAggregateFilter): { sql: string; params: string[] } {
  let where = 'WHERE 1=1';
  const params: string[] = [];
  if (filter.stage) { where += ' AND m.stage = ?'; params.push(filter.stage); }
  if (filter.subject) { where += ' AND q.subject = ?'; params.push(filter.subject); }
  if (filter.occurredFrom) { where += ' AND m.occurred_at >= ?'; params.push(normalizeOccurredFrom(filter.occurredFrom)); }
  if (filter.occurredTo) { where += ' AND m.occurred_at <= ?'; params.push(normalizeOccurredTo(filter.occurredTo)); }
  if (filter.studentIds && filter.studentIds.length > 0) {
    where += ` AND m.student_id IN (${filter.studentIds.map(() => '?').join(', ')})`;
    params.push(...filter.studentIds);
  }

  const sql = `
    SELECT m.question_id, COUNT(DISTINCT m.student_id) AS wrong_count,
           MIN(m.occurred_at) AS first_occurred_at, MAX(m.occurred_at) AS last_occurred_at,
           q.stem_html, q.content, q.question_type, q.difficulty, q.subject
    FROM mistakes m
    JOIN questions q ON q.id = m.question_id
    ${where}
    GROUP BY m.question_id
    ORDER BY wrong_count DESC, m.question_id ASC
  `;
  return { sql, params };
}

/** 查询行 → 聚合行（逐字段判型；列名漂移即显式报错，不静默给 undefined） */
export function rowToAggregate(row: AggregateRow): MistakeAggregateRow {
  return {
    questionId: readString(row, 'question_id'),
    wrongCount: readNumber(row, 'wrong_count'),
    stemSummary: summarizeStem(readOptionalString(row, 'stem_html'), readOptionalString(row, 'content')),
    subject: readString(row, 'subject'),
    questionType: readOptionalString(row, 'question_type'),
    difficulty: readOptionalNumber(row, 'difficulty'),
    firstOccurredAt: readString(row, 'first_occurred_at'),
    lastOccurredAt: readString(row, 'last_occurred_at'),
  };
}
