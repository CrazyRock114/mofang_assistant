// 0025 P3：paper_sets.batch_meta 结构校验与解析（纯函数，无 IO）。
// 依据：0025 任务书 §一 P3（P-06：一期只定字段，二期生成器消费）。
// 口径：
//   写入 = 已知字段非法即抛错（不静默吞、不静默截断）；未登记键原样保留（历史兼容，既有
//          ext-contract 用例 `batchMeta: { exam: '期末' }` 语义不容破坏）。
//   读出 = 坏 JSON / 坏结构显式报错（不静默回落 undefined）。
// 手法照 src/app/services/layout-config-validate.ts：JSON 结果收窄为记录后逐字段判型，
// 不做整体类型断言；新增文件自检口径=不写类型逃逸（grep 探针照 layout-config-validate 先例）。

import type { PaperSetBatchMeta } from '../shared/contracts/bank-types.js';

/** JSON 可承载的值域（不含数组语义，数组单列校验） */
type JsonScalar = string | number | boolean | null | undefined;
type JsonValue = JsonScalar | object;
type MetaRecord = Record<string, JsonValue>;

const asMetaRecord = (value: object): MetaRecord | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as MetaRecord;
};

const isFiniteNumber = (value: JsonValue): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** 可选正整数（缺省/显式 null 视为未登记） */
const optionalPositiveInt = (rec: MetaRecord, key: string): number | undefined => {
  const raw = rec[key];
  if (raw === undefined || raw === null) return undefined;
  if (!isFiniteNumber(raw) || !Number.isInteger(raw) || raw < 1) {
    throw new Error(`batch_meta 校验失败：${key} 必须是 ≥1 的整数`);
  }
  return raw;
};

/** 可选正数（缺省/显式 null 视为未登记） */
const optionalPositiveNumber = (rec: MetaRecord, key: string): number | undefined => {
  const raw = rec[key];
  if (raw === undefined || raw === null) return undefined;
  if (!isFiniteNumber(raw) || raw <= 0) {
    throw new Error(`batch_meta 校验失败：${key} 必须是正数`);
  }
  return raw;
};

/** 可选非空串（缺省/显式 null 视为未登记） */
const optionalNonEmptyString = (rec: MetaRecord, key: string): string | undefined => {
  const raw = rec[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(`batch_meta 校验失败：${key} 必须是非空字符串`);
  }
  return raw;
};

/**
 * 写入校验：结构非法即抛错（错误文案直接可示人）；返回一期字段集的类型化视图。
 * 未登记键不参与校验也不丢弃——落库以调用方传入的整对象为准。
 */
export function validateBatchMeta(input: object): PaperSetBatchMeta {
  const rec = asMetaRecord(input);
  if (!rec) throw new Error('batch_meta 校验失败：必须是 JSON 对象（非数组、非标量）');

  return {
    perStudentLimit: optionalPositiveInt(rec, 'perStudentLimit'),
    timeWindowDays: optionalPositiveNumber(rec, 'timeWindowDays'),
    sourceRule: optionalNonEmptyString(rec, 'sourceRule'),
  };
}

/** 解析存储列：NULL/空串 → undefined（未登记）；坏 JSON / 坏结构 → 显式抛错 */
export function parseBatchMeta(raw: string | null | undefined): MetaRecord | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined;

  let value: object;
  try {
    value = JSON.parse(raw) as object;
  } catch {
    throw new Error(`batch_meta 解析失败：非法 JSON（原文前 60 字：${raw.slice(0, 60)}）`);
  }

  const rec = asMetaRecord(value);
  if (!rec) throw new Error('batch_meta 解析失败：必须是 JSON 对象（非数组、非标量）');
  validateBatchMeta(rec);
  return rec;
}
