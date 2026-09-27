// 0030 P2：红线守卫纯函数单测（任务书 §四：数字篡改必拦 / 新增数字 / 禁词逐条 / 缺称呼与「该生」/ 放行用例）。
// 守卫返回 failures 明细列表、不抛异常（模式参照 0024 validate.ts，逻辑全新）——「标红提醒不硬拦」由 UI 层承接。

import { describe, it, expect } from 'vitest';
import {
  FEEDBACK_BANNED_WORDS, checkFeedbackText, type FeedbackGuardFailure,
} from '../../src/app/feedback/guard.js';
import type { FeedbackInputs } from '../../src/app/feedback/prompt.js';

const INPUTS: FeedbackInputs = {
  studentName: '王浩',
  lessonContent: '欧姆定律 I=U/R，串并联电路计算；课堂练习 5 道',
  performance: ['走神', '练习不足'],
  homework: '练习册 P45 第 1-8 题',
  score: '61',
  scoreTitle: '第九章单元测',
};

function rules(failures: FeedbackGuardFailure[]): string[] {
  return failures.map((f) => f.rule).sort();
}

describe('0030 守卫：数字一致（AI 改数字必拦）', () => {
  it('61 写成 91 → 拦（number-mismatch，detail 带上被改的数字）', () => {
    const body = '王浩家长您好！本次单元测他得了 91 分，基础还需巩固。';
    const { failures } = checkFeedbackText(INPUTS, body);
    expect(rules(failures)).toContain('number-mismatch');
    const hit = failures.find((f) => f.rule === 'number-mismatch')!;
    expect(hit.detail).toContain('91');
  });

  it('新增数字（输入里没有 120）→ 拦', () => {
    const body = '王浩家长您好！本次单元测 61 分，另外我给他加了 120 道练习。';
    const { failures } = checkFeedbackText(INPUTS, body);
    expect(rules(failures)).toContain('number-mismatch');
  });

  it('输入里的成绩数字必须保持原值出现（只字未提 → score-missing 提醒）', () => {
    const body = '王浩家长您好！这节课他有些走神，练习也偏少，需要多巩固。';
    const { failures } = checkFeedbackText(INPUTS, body);
    expect(rules(failures)).toContain('score-missing');
  });

  it('数字全部来自输入（含课堂内容/课后任务里的数字）→ 数字规则全过', () => {
    const body = '王浩家长您好！这节课我们讲了欧姆定律 I=U/R，做了 5 道练习，本次单元测 61 分。'
      + '课后请完成练习册 P45 第 1-8 题，注意串并联电路的计算。';
    const { failures } = checkFeedbackText(INPUTS, body);
    expect(rules(failures)).not.toContain('number-mismatch');
    expect(rules(failures)).not.toContain('score-missing');
  });

  it('输入没填成绩时不产生 score-missing（成绩本就是可选项）', () => {
    const { failures } = checkFeedbackText({ ...INPUTS, score: '', scoreTitle: '' }, '王浩家长您好！这节课他有些走神。');
    expect(rules(failures)).not.toContain('score-missing');
  });
});

describe('0030 守卫：禁词逐条', () => {
  it('内置清单五条逐条命中（AI 词大小写不敏感）', () => {
    expect(FEEDBACK_BANNED_WORDS).toEqual(['AI', '人工智能', '模型', '大模型', '数据驱动']);
    const cases: Array<[string, string]> = [
      ['AI', '王浩家长您好！本次由 AI 生成反馈。'],
      ['人工智能', '王浩家长您好！人工智能分析显示他 61 分。'],
      ['模型', '王浩家长您好！模型判断他基础薄弱。'],
      ['大模型', '王浩家长您好！大模型给出了这次反馈。'],
      ['数据驱动', '王浩家长您好！数据驱动地看，本次 61 分。'],
    ];
    for (const [word, body] of cases) {
      const { failures } = checkFeedbackText(INPUTS, body);
      const hit = failures.find((f) => f.rule === 'banned-word');
      expect(hit, `未拦禁词：${word}`).toBeDefined();
      expect(hit!.detail).toContain(word);
    }
  });

  it('长词内含短词只报长词（大模型 ≠ 模型 + 大模型 两条）', () => {
    const { failures } = checkFeedbackText(INPUTS, '王浩家长您好！大模型说本次 61 分。');
    expect(failures.filter((f) => f.rule === 'banned-word')).toHaveLength(1);
    expect(failures.find((f) => f.rule === 'banned-word')!.detail).toContain('大模型');
  });

  it('小写 ai 也算（英文词边界内，不误伤单词内部）', () => {
    expect(checkFeedbackText(INPUTS, '王浩家长您好！This ai wrote it, 61 分。').failures)
      .toContainEqual(expect.objectContaining({ rule: 'banned-word' }));
    expect(checkFeedbackText(INPUTS, '王浩家长您好！他把 said 读成 61 分。').failures)
      .not.toContainEqual(expect.objectContaining({ rule: 'banned-word' }));
  });
});

describe('0030 守卫：称呼', () => {
  it('正文未出现学生姓名 → missing-name', () => {
    const { failures } = checkFeedbackText(INPUTS, '家长您好！本次单元测 61 分，基础还需巩固。');
    expect(rules(failures)).toContain('missing-name');
  });

  it('出现「该生」→ impolite-address', () => {
    const { failures } = checkFeedbackText(INPUTS, '王浩家长您好！该生本次单元测 61 分。');
    expect(rules(failures)).toContain('impolite-address');
  });
});

describe('0030 守卫：放行与健壮性', () => {
  it('干净正文 → failures 为空（含姓名、成绩原值、无禁词无「该生」）', () => {
    const body = '王浩家长您好！这节课我们讲了欧姆定律 I=U/R 和串并联电路计算，课堂上他有些走神，'
      + '练习也偏少。本次单元测 61 分，公式记忆不牢是主要失分点。课后请完成练习册 P45 第 1-8 题，'
      + '并整理本章公式卡片，在家可以让他把公式讲给您听。';
    expect(checkFeedbackText(INPUTS, body).failures).toEqual([]);
  });

  it('空正文/空输入不抛异常（返回明细，交给 UI 标红）', () => {
    expect(() => checkFeedbackText(INPUTS, '')).not.toThrow();
    expect(checkFeedbackText(INPUTS, '').failures.length).toBeGreaterThan(0);
    expect(() => checkFeedbackText({ ...INPUTS, studentName: '' }, '')).not.toThrow();
  });
});
