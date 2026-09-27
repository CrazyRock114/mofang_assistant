// 0026 P1-P4：错题闭环产品层纯函数测试（node 环境，无 DOM）。
// 口径单源：scope 过滤 / 时间窗归一 与 0025 数据层同规则（复用 mistake-aggregate 的归一对函数），
// 本文件锁定「UI 展示与入篮派生」这一层的算术与文本，真桥双跑见 test/bank/mistake-loop-derive.test.ts。

import { describe, it, expect } from 'vitest';
import type { ClassInfo, Mistake, MistakeAggregateRow, MistakeStage } from '../../src/shared/contracts/bank-types.js';
import {
  MISTAKE_PAGE_SIZE, MISTAKE_TOP_N_DEFAULT,
  batchMetaLines, clampPage, classMistakeTitle, difficultyLabel, describeScopeTotal, describeWrongCount,
  inScope, localDate, mergeStageBreakdown, mergeSubjects, pageCount, pageSlice, studentStageEntries,
  mistakeBookHeaderLines, mistakeBookTitle, normalizeTopN, pickDefaultClassId,
  planAddToBasket, scopeMistakeIds, toAggregateFilter, topN, weekWindow,
  type MistakeScope,
} from '../../src/app/pages/mistake-loop.js';

function mistake(id: string, questionId: string, studentId: string, occurredAt: string, stage: MistakeStage = 'red'): Mistake {
  return {
    id,
    questionId,
    studentId,
    occurredAt,
    stage,
    snapshot: { stemHtml: `<div class="question">${id}</div>`, options: [], images: [] },
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
}

function clazz(id: string, name: string, status: ClassInfo['status'] = 'active'): ClassInfo {
  return { id, name, status, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' };
}

describe('0026 时间窗：本周（周一~周日，本地日期）', () => {
  it('localDate 取本地日期（不受 UTC 偏移影响）', () => {
    expect(localDate(new Date(2026, 8, 17, 10, 30))).toBe('2026-09-17');
    expect(localDate(new Date(2026, 8, 17, 0, 0))).toBe('2026-09-17');
    expect(localDate(new Date(2026, 8, 17, 23, 59, 59))).toBe('2026-09-17');
  });

  it('weekWindow：周四 → 本周一~本周日', () => {
    expect(weekWindow(new Date(2026, 8, 17, 10, 30))).toEqual({ from: '2026-09-14', to: '2026-09-20' });
  });

  it('weekWindow：周一当天 → 其所在周', () => {
    expect(weekWindow(new Date(2026, 8, 14, 0, 0))).toEqual({ from: '2026-09-14', to: '2026-09-20' });
  });

  it('weekWindow：周日 → 仍归本周（不跳下周）', () => {
    expect(weekWindow(new Date(2026, 8, 20, 23, 0))).toEqual({ from: '2026-09-14', to: '2026-09-20' });
  });

  it('weekWindow：跨月边界（10-01 周四 → 09-28 ~ 10-04）', () => {
    expect(weekWindow(new Date(2026, 9, 1, 8, 0))).toEqual({ from: '2026-09-28', to: '2026-10-04' });
  });
});

describe('0026 scope → 聚合筛选（0025 契约透传）', () => {
  it('空 scope → 空 filter（全部不过滤）', () => {
    expect(toAggregateFilter({})).toEqual({});
  });

  it('逐字段透传：stage/subject/时间窗/学生集', () => {
    const filter = toAggregateFilter({
      studentIds: ['s1', 's2'], stage: 'yellow', subject: '物理', occurredFrom: '2026-09-14', occurredTo: '2026-09-20',
    });
    expect(filter).toEqual({
      studentIds: ['s1', 's2'], stage: 'yellow', subject: '物理', occurredFrom: '2026-09-14', occurredTo: '2026-09-20',
    });
  });

  it('空学生集 = 不过滤（不产生 studentIds 键）', () => {
    expect(toAggregateFilter({ studentIds: [] })).toEqual({});
  });
});

describe('0026 scope 内错题行过滤（与 0025 同口径）', () => {
  const rows = [
    mistake('m1', 'q1', 's1', '2026-09-14T08:00:00.000Z', 'red'),
    mistake('m2', 'q1', 's2', '2026-09-20T23:00:00.000Z', 'yellow'),
    mistake('m3', 'q2', 's2', '2026-09-21T01:00:00.000Z', 'red'),
  ];

  it('时间窗 date-only 含当日全天（上界当日 23:59:59.999Z 内仍在范围）', () => {
    const scope: MistakeScope = { occurredFrom: '2026-09-14', occurredTo: '2026-09-20' };
    expect(rows.filter((m) => inScope(m, scope)).map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('stage 精确过滤', () => {
    expect(scopeMistakeIds(rows, { stage: 'yellow' })).toEqual(['m2']);
  });

  it('studentIds 为 OR 语义（空集=全部）', () => {
    expect(scopeMistakeIds(rows, { studentIds: ['s1'] })).toEqual(['m1']);
    expect(scopeMistakeIds(rows, { studentIds: [] })).toEqual(['m1', 'm2', 'm3']);
  });

  it('组合过滤取交集（学生集 + 时间窗 + stage）', () => {
    const ids = scopeMistakeIds(rows, {
      studentIds: ['s2'], occurredFrom: '2026-09-01', occurredTo: '2026-09-20', stage: 'yellow',
    });
    expect(ids).toEqual(['m2']);
  });
});

describe('0026 入篮派生：去重与跳过计数', () => {
  it('已在篮的题被跳过并计入 skipped，次序沿用候选序', () => {
    expect(planAddToBasket(['q1', 'q2'], ['q2', 'q3', 'q4'])).toEqual({ toAdd: ['q3', 'q4'], skipped: 1 });
  });

  it('候选内重复只入一次，重复计入 skipped', () => {
    expect(planAddToBasket([], ['q1', 'q1', 'q2'])).toEqual({ toAdd: ['q1', 'q2'], skipped: 1 });
  });

  it('空串剔除且计入 skipped（不产生空 id 请求）', () => {
    expect(planAddToBasket([''], ['', 'q1'])).toEqual({ toAdd: ['q1'], skipped: 1 });
  });

  it('全量重复 → toAdd 空、skipped=候选数', () => {
    expect(planAddToBasket(['q1'], ['q1', 'q1'])).toEqual({ toAdd: [], skipped: 2 });
  });
});

describe('0026 Top N（D3）', () => {
  it('normalizeTopN：缺省回落 20；非法/非正数回落；小数取整', () => {
    expect(MISTAKE_TOP_N_DEFAULT).toBe(20);
    expect(normalizeTopN('')).toBe(20);
    expect(normalizeTopN('abc')).toBe(20);
    expect(normalizeTopN('0')).toBe(20);
    expect(normalizeTopN('-3')).toBe(20);
    expect(normalizeTopN('12')).toBe(12);
    expect(normalizeTopN('12.7')).toBe(12);
    expect(normalizeTopN('7', 5)).toBe(7);
    expect(normalizeTopN('', 5)).toBe(5);
  });

  it('topN 取聚合序前 N（人次降序由 0025 保证，本层只截断）', () => {
    expect(topN(['a', 'b', 'c'], 2)).toEqual(['a', 'b']);
    expect(topN(['a'], 5)).toEqual(['a']);
    expect(topN([], 5)).toEqual([]);
  });
});

describe('0026 人次展示（P-30「错 7/12 人」）', () => {
  it('有在册人数 → 分数形态', () => {
    expect(describeWrongCount(7, 12)).toBe('错 7/12 人');
  });

  it('无在册人数 → 只报人次（不编造分母）', () => {
    expect(describeWrongCount(7, 0)).toBe('错 7 人');
  });
});

describe('0026 列表口径合计（页头：人次合计不冒充「人」）', () => {
  // wrongCount 是「每题去重学生数」（0025 契约），逐题相加得到的是人次，不是去重人数：
  // 同一生错 3 题会被计 3 次。页头必须按人次报，避免「错 12 人」而实际只有 4 人。
  it('人次合计 + 题量（不报「人」）', () => {
    expect(describeScopeTotal(12, 5)).toBe('共 12 人次 · 5 题');
  });

  it('单题单人次也逐字可读', () => {
    expect(describeScopeTotal(1, 1)).toBe('共 1 人次 · 1 题');
  });

  it('空列表报 0 而不省略（空态旁仍可读）', () => {
    expect(describeScopeTotal(0, 0)).toBe('共 0 人次 · 0 题');
  });
});

describe('0026 学生状态分布（红黄绿是学生对题的状态，不是题的状态）', () => {
  const row = (questionId: string, wrongCount: number): MistakeAggregateRow => ({
    questionId, wrongCount, stemSummary: questionId, subject: '物理',
    firstOccurredAt: '2026-09-15T10:00:00.000Z', lastOccurredAt: '2026-09-15T10:00:00.000Z',
  });
  const total = [row('q1', 4), row('q2', 2), row('q3', 1)];

  it('按题归并三道状态口的计数；某状态无人的题记 0', () => {
    const map = mergeStageBreakdown(total, [
      { stage: 'red', rows: [row('q1', 2), row('q3', 1)] },
      { stage: 'yellow', rows: [row('q1', 1), row('q2', 2)] },
      { stage: 'green', rows: [row('q1', 1)] },
    ]);
    expect(map.get('q1')).toEqual({ red: 2, yellow: 1, green: 1 });
    expect(map.get('q2')).toEqual({ red: 0, yellow: 2, green: 0 });
    expect(map.get('q3')).toEqual({ red: 1, yellow: 0, green: 0 });
  });

  it('总数口里没有的题不出现（不凭空造行）', () => {
    const map = mergeStageBreakdown(total, [{ stage: 'red', rows: [row('q9', 3)] }]);
    expect(map.has('q9')).toBe(false);
    expect(map.size).toBe(3);
  });

  it('三态人数之和 = 该题人次（(question_id, student_id) 唯一，每人每题只占一态）', () => {
    const map = mergeStageBreakdown(total, [
      { stage: 'red', rows: [row('q1', 2)] },
      { stage: 'yellow', rows: [row('q1', 1)] },
      { stage: 'green', rows: [row('q1', 1)] },
    ]);
    const c = map.get('q1')!;
    expect(c.red + c.yellow + c.green).toBe(4);
  });

  it('展示条目：只列非零状态，次序恒为 未掌握→订正过→已掌握；全零为空', () => {
    expect(studentStageEntries({ red: 2, yellow: 0, green: 1 })).toEqual([
      { stage: 'red', label: '未掌握', count: 2 },
      { stage: 'green', label: '已掌握', count: 1 },
    ]);
    expect(studentStageEntries({ red: 0, yellow: 3, green: 0 })).toEqual([
      { stage: 'yellow', label: '订正过', count: 3 },
    ]);
    expect(studentStageEntries({ red: 0, yellow: 0, green: 0 })).toEqual([]);
  });
});

describe('0026 分页预算（题库式卡片列表：卡片高度不固定，改按页切）', () => {
  it('页大小缺省 20；页数向上取整，空列表 1 页', () => {
    expect(MISTAKE_PAGE_SIZE).toBe(20);
    expect(pageCount(0)).toBe(1);
    expect(pageCount(20)).toBe(1);
    expect(pageCount(21)).toBe(2);
    expect(pageCount(45)).toBe(3);
  });

  it('切页取件 + 页码夹取（越界回到边界页，不抛错也不空屏）', () => {
    const items = Array.from({ length: 45 }, (_, i) => i + 1);
    expect(pageSlice(items, 1)).toEqual(items.slice(0, 20));
    expect(pageSlice(items, 3)).toEqual(items.slice(40, 45));
    expect(pageSlice(items, 4)).toEqual(items.slice(40, 45)); // 越界夹到末页
    expect(pageSlice(items, 0)).toEqual(items.slice(0, 20)); // 越界夹到首页
    expect(clampPage(9, 45)).toBe(3);
    expect(clampPage(2, 45)).toBe(2);
  });
});

describe('0026 成册卷头（P4：学生名/时间窗/题量）', () => {
  const window = { from: '2026-09-14', to: '2026-09-20' };

  it('标题含学生名与时间窗', () => {
    expect(mistakeBookTitle('王小明', window)).toBe('错题本·王小明·2026-09-14~2026-09-20');
  });

  it('卷头逐行：学生名 / 时间窗 / 题量', () => {
    expect(mistakeBookHeaderLines('王小明', window, 7)).toEqual([
      { text: '错题本 · 王小明', sizePt: 16, align: 'center', bold: true },
      { text: '错题范围：2026-09-14 ~ 2026-09-20', sizePt: 10, align: 'center' },
      { text: '共 7 题', sizePt: 10, align: 'center' },
    ]);
  });

  it('时间窗缺省时不编造范围行（只留学生名/题量）', () => {
    expect(mistakeBookHeaderLines('王小明', {}, 3)).toEqual([
      { text: '错题本 · 王小明', sizePt: 16, align: 'center', bold: true },
      { text: '共 3 题', sizePt: 10, align: 'center' },
    ]);
  });

  it('班级错题集卷名（D3）：班级名 + Top N；无班级名回落「全班」', () => {
    expect(classMistakeTitle('初二一班', 2)).toBe('初二一班错题集 Top 2');
    expect(classMistakeTitle('', 5)).toBe('全班错题集 Top 5');
  });
});

describe('0026 试卷集 batch_meta 只读展示（P3）', () => {
  it('已登记三键 → 中文行', () => {
    expect(batchMetaLines({ perStudentLimit: 10, timeWindowDays: 30, sourceRule: '按错误人次' }))
      .toEqual(['每人上限：10 题', '时间窗：30 天', '选题来源：按错误人次']);
  });

  it('未登记键原样保留展示（不吞数据）', () => {
    expect(batchMetaLines({ exam: '期末' })).toEqual(['exam：期末']);
  });

  it('空/缺省 → 空数组（UI 显示「未设置」由调用方决定）', () => {
    expect(batchMetaLines(undefined)).toEqual([]);
    expect(batchMetaLines({})).toEqual([]);
  });

  it('类型不符的登记键不冒充数字（原样回显）', () => {
    expect(batchMetaLines({ perStudentLimit: '10' })).toEqual(['perStudentLimit：10']);
  });
});

describe('0026 默认班级（本班）与学科选项并集', () => {
  it('记住的班级仍在册 → 沿用', () => {
    expect(pickDefaultClassId([clazz('c1', '一班'), clazz('c2', '二班')], 'c2')).toBe('c2');
  });

  it('记住的班级已结课/不存在 → 唯一在册班级兜底', () => {
    expect(pickDefaultClassId([clazz('c1', '一班', 'closed'), clazz('c2', '二班')], 'c1')).toBe('c2');
  });

  it('多个在册班级且无记忆 → 不替用户猜（空=全部）', () => {
    expect(pickDefaultClassId([clazz('c1', '一班'), clazz('c2', '二班')], '')).toBe('');
  });

  it('无班级 → 空', () => {
    expect(pickDefaultClassId([], '')).toBe('');
  });

  it('学科选项单调并集：去重、保序、剔空（切换学科后选项不消失）', () => {
    expect(mergeSubjects(['数学'], ['物理', '', '数学', '化学'])).toEqual(['数学', '物理', '化学']);
  });
});

describe('0026 难度展示（与题库页同文案）', () => {
  it('1-5 档 → 文案；越界/缺省 → undefined', () => {
    expect(difficultyLabel(1)).toBe('很容易');
    expect(difficultyLabel(5)).toBe('很难');
    expect(difficultyLabel(9)).toBeUndefined();
    expect(difficultyLabel(undefined)).toBeUndefined();
  });
});
