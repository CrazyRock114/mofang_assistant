import { describe, it, expect } from 'vitest';
import {
  EMPTY_DICT_FALLBACK_OPTIONS,
  DEFAULT_CAPTURE_SUBJECT,
  splitStageSubject,
  subjectIdOf,
} from '../../src/capture/subject.js';
import type { DictEntry } from '../../src/shared/contracts/bank-types.js';

describe('采集学科空库兜底选项（P3-1：仅字典为空时回落）', () => {
  it('默认学科 = 高中数学，兜底含高/初中数学物理化学', () => {
    expect(DEFAULT_CAPTURE_SUBJECT).toBe('高中数学');
    expect(EMPTY_DICT_FALLBACK_OPTIONS).toContain('高中数学');
    expect(EMPTY_DICT_FALLBACK_OPTIONS).toContain('高中物理');
    expect(EMPTY_DICT_FALLBACK_OPTIONS).toContain('初中数学');
    expect(EMPTY_DICT_FALLBACK_OPTIONS).toContain('初中物理');
    expect(EMPTY_DICT_FALLBACK_OPTIONS).toHaveLength(6);
  });
});

describe('splitStageSubject — 学段+学科拆分（subject 与既有单学科取值一致，学段落 stage 字段）', () => {
  it('高中数学 → { stage: 高中, subject: 数学 }', () => {
    expect(splitStageSubject('高中数学')).toEqual({ stage: '高中', subject: '数学' });
  });

  it('初中物理 → { stage: 初中, subject: 物理 }', () => {
    expect(splitStageSubject('初中物理')).toEqual({ stage: '初中', subject: '物理' });
  });

  it('无学段前缀 → subject 原文，stage 缺省', () => {
    expect(splitStageSubject('数学')).toEqual({ subject: '数学' });
  });
});

// P3-2：学科字典解析单一真源（src/bank/subject-normalize.ts）的 capture 侧适配——
// 用户选择 label / 站点原文 → 题库归一 id（subj:{code}），未命中不落 id（§零.9 不新建不猜）
describe('subjectIdOf — 学科原文 → 字典归一 id（P3-2）', () => {
  const ENTRIES: DictEntry[] = [
    { id: 'subj:math', kind: 'subject', code: 'math', label: '数学', active: true },
    { id: 'subj:physics', kind: 'subject', code: 'physics', label: '物理', active: true },
    { id: 'subj:politics', kind: 'subject', code: 'politics', label: '政治', active: true },
    { id: 'subj:morality-law', kind: 'subject', code: 'morality-law', label: '道德与法治', active: true },
    { id: 'subj:jyeoo:physics2', kind: 'subject', code: 'physics', label: 'physics2', site: 'jyeoo', sourceLabel: 'physics2', active: true },
    // 菁优 segment politics = 初中道法（与归一码 politics=高中政治 撞名的歧义样本）
    { id: 'subj:jyeoo:politics', kind: 'subject', code: 'morality-law', label: 'politics', site: 'jyeoo', sourceLabel: 'politics', active: true },
    // 站点行 code 指向的归一行缺失（FK 防线样本）
    { id: 'subj:jyeoo:ghost0', kind: 'subject', code: 'ghost', label: 'ghost0', site: 'jyeoo', sourceLabel: 'ghost0', active: true },
  ];

  const cases: Array<[string, string | undefined, string | undefined, string | null]> = [
    ['归一行 label 命中（用户选择「数学」）', '数学', undefined, 'subj:math'],
    ['站点行命中（菁优 physics2）', 'physics2', 'jyeoo', 'subj:physics'],
    ['站点行优先破歧义（菁优 politics=初中道法，非归一 politics）', 'politics', 'jyeoo', 'subj:morality-law'],
    ['无站点时 politics 落归一码', 'politics', undefined, 'subj:politics'],
    ['subj: 前缀幂等（已归一值原样返回）', 'subj:math', undefined, 'subj:math'],
    ['未命中（不猜不并，返回 null）', '玄学', undefined, null],
    ['站点行 code 无归一行 → null（subject_id 外键防线）', 'ghost0', 'jyeoo', null],
    ['空值 → null', undefined, 'jyeoo', null],
  ];

  for (const [name, raw, site, expected] of cases) {
    it(`${name}：${JSON.stringify(raw)}@${site ?? '-'} → ${String(expected)}`, () => {
      expect(subjectIdOf(raw, site, ENTRIES)).toBe(expected);
    });
  }

  it('字典为空/undefined 条目 → null（不猜）', () => {
    expect(subjectIdOf('数学', undefined, [])).toBeNull();
  });
});
