// 0030 P2：提示词组装器纯函数单测（任务书 §四：变量插值 / 成绩为空槽位段剔除 / 风格三维逐档 / 缺值显式报错）。
// 组装器只做「事实注入 + 风格注入」，不碰 IO；AI 通道调用在 engine.ts（本文件零 IPC）。

import { describe, it, expect } from 'vitest';
import {
  FEEDBACK_FACT_VARS, FEEDBACK_STYLE_VARS, FEEDBACK_PROMPT_VARS,
  TONE_OPTIONS, LENGTH_OPTIONS,
  styleSlotValues, styleRequirementBlock, hasStyleSlots,
  feedbackNumbers, performanceText,
  buildPrompt, type FeedbackInputs, type FeedbackStyle,
} from '../../src/app/feedback/prompt.js';

/** 去掉模板里指定事实的行（模拟「老模板未含新槽位」） */
function dropFacts(template: string, keys: string[]): string {
  return template.split('\n').filter((line) => !keys.some((key) => line.startsWith(`${key}：`))).join('\n');
}

const BASE_STYLE: FeedbackStyle = { tone: 'warm', length: 'medium', familyAdvice: true };

const BASE_INPUTS: FeedbackInputs = {
  studentName: '陈小明',
  topic: '牛顿第二定律',
  lessonContent: '牛顿第二定律：F=ma 的理解与简单计算，做了 4 道课堂练习',
  performance: ['专注投入', '积极举手'],
  homework: '完成练习册 P32 第 1-6 题',
  score: '82',
  scoreTitle: '课堂小测',
  note: '今天有点咳嗽，别写太重',
};

/** 内置模板同款形态（含事实段 + 风格槽位） */
const BUILTIN_LIKE = [
  '你是一位有经验的培训老师，正在给学生{学生姓名}的家长写课后反馈。',
  '',
  '【事实信息——只允许使用以下内容，不得编造、不得改动数字】',
  '课程主题：{课程主题}',
  '课堂内容：{课堂内容}',
  '课堂表现：{课堂表现}',
  '课后任务：{课后任务}',
  '测试成绩：{成绩}',
  '备注：{备注}',
  '',
  '【写作要求】',
  '语气：{语气}。篇幅：{篇幅}。{家庭建议}',
].join('\n');

describe('0030 组装器：变量集与风格档位常量', () => {
  it('事实变量五项 + 风格变量三项（顺序即 UI 展示序）', () => {
    expect(FEEDBACK_FACT_VARS).toEqual(['学生姓名', '课程主题', '课堂内容', '课堂表现', '课后任务', '成绩', '备注']);
    expect(FEEDBACK_STYLE_VARS).toEqual(['语气', '篇幅', '家庭建议']);
    expect(FEEDBACK_PROMPT_VARS).toEqual([...FEEDBACK_FACT_VARS, ...FEEDBACK_STYLE_VARS]);
  });

  it('语气 4 档 / 篇幅 3 档（值为可直接写进提示词的短语，档位码与 UI 解耦）', () => {
    expect(TONE_OPTIONS.map((o) => o.code)).toEqual(['warm', 'objective', 'lively', 'concise']);
    expect(TONE_OPTIONS.map((o) => o.text)).toEqual(['温和鼓励', '专业客观', '热情活泼', '简明扼要']);
    expect(LENGTH_OPTIONS.map((o) => o.code)).toEqual(['short', 'medium', 'long']);
    expect(LENGTH_OPTIONS.map((o) => o.text)).toEqual(['约 100 字', '约 200 字', '约 350 字']);
  });

  it('styleSlotValues：三维逐档取值（家庭建议开关两态句）', () => {
    expect(styleSlotValues({ tone: 'lively', length: 'long', familyAdvice: false })).toEqual({
      语气: '热情活泼',
      篇幅: '约 350 字',
      家庭建议: '不要写家庭建议。',
    });
    expect(styleSlotValues(BASE_STYLE)).toEqual({
      语气: '温和鼓励',
      篇幅: '约 200 字',
      家庭建议: '结尾带一条在家可执行的小建议。',
    });
  });

  it('styleRequirementBlock：模板无风格槽位时的追加段（三维全带）', () => {
    const block = styleRequirementBlock(BASE_STYLE);
    expect(block).toContain('【写作要求】');
    expect(block).toContain('语气：温和鼓励');
    expect(block).toContain('篇幅：约 200 字');
    expect(block).toContain('家庭建议：结尾带一条在家可执行的小建议。');
    expect(hasStyleSlots(BUILTIN_LIKE)).toBe(true);
    expect(hasStyleSlots('只有{学生姓名}和{课堂内容}')).toBe(false);
  });
});

describe('0030 组装器：变量插值', () => {
  it('五项事实变量全部替换为真实数据', () => {
    const prompt = buildPrompt(BUILTIN_LIKE, BASE_INPUTS, BASE_STYLE);
    expect(prompt).toContain('正在给学生陈小明的家长写课后反馈');
    expect(prompt).toContain('课堂内容：牛顿第二定律：F=ma 的理解与简单计算，做了 4 道课堂练习');
    expect(prompt).toContain('课堂表现：专注投入、积极举手');
    expect(prompt).toContain('课后任务：完成练习册 P32 第 1-6 题');
    expect(prompt).toContain('测试成绩：82分（课堂小测）');
    expect(prompt).not.toContain('{学生姓名}');
    expect(prompt).not.toContain('{课堂内容}');
  });

  it('成绩无名称时槽位值不带括号；风格槽位同期注入（不留 {语气} 等原样槽位）', () => {
    const prompt = buildPrompt(BUILTIN_LIKE, { ...BASE_INPUTS, scoreTitle: '' }, BASE_STYLE);
    expect(prompt).toContain('测试成绩：82分\n');
    expect(prompt).toContain('语气：温和鼓励。篇幅：约 200 字。结尾带一条在家可执行的小建议。');
    for (const v of FEEDBACK_PROMPT_VARS) expect(prompt).not.toContain(`{${v}}`);
  });

  it('情绪/表现多标签与自填一字不改地带入（不加工、不概括）', () => {
    const prompt = buildPrompt(BUILTIN_LIKE, {
      ...BASE_INPUTS,
      performance: ['专注', '走神', '课间主动擦黑板'],
    }, BASE_STYLE);
    expect(prompt).toContain('课堂表现：专注、走神、课间主动擦黑板');
    expect(performanceText([])).toBe('');
  });
});

describe('0030 组装器：课程主题与备注（目检返工③）', () => {
  it('两项新事实按槽位注入（主题在事实段、备注原样带入）', () => {
    const prompt = buildPrompt(BUILTIN_LIKE, BASE_INPUTS, BASE_STYLE);
    expect(prompt).toContain('课程主题：牛顿第二定律');
    expect(prompt).toContain('备注：今天有点咳嗽，别写太重');
    expect(prompt).not.toContain('{课程主题}');
    expect(prompt).not.toContain('{备注}');
  });

  it('老模板（未含新槽位）→ 缺失事实自动补一段【补充事实】，不漏信息', () => {
    const legacy = dropFacts(BUILTIN_LIKE, ['课程主题', '备注']);
    const prompt = buildPrompt(legacy, BASE_INPUTS, BASE_STYLE);
    expect(prompt).toContain('【补充事实');
    expect(prompt).toContain('课程主题：牛顿第二定律');
    expect(prompt).toContain('备注：今天有点咳嗽，别写太重');
    // 模板已有的槽位不重复补（只补缺失项）
    expect(prompt.match(/课堂内容：牛顿第二定律/g)).toHaveLength(1);
  });

  it('值为空的新事实不补（不出现「备注：」空行）', () => {
    const legacy = dropFacts(BUILTIN_LIKE, ['课程主题', '备注']);
    const prompt = buildPrompt(legacy, { ...BASE_INPUTS, topic: '', note: '' }, BASE_STYLE);
    expect(prompt).not.toContain('【补充事实');
    expect(prompt).not.toContain('备注：');
  });

  it('模板完全不含事实槽位（纯自由提示词，无任何变量）→ 尊重意图，不追加补充段', () => {
    const prompt = buildPrompt('写一段给家长的反馈，自由发挥。', BASE_INPUTS, BASE_STYLE);
    expect(prompt).not.toContain('【补充事实');
  });

  it('只用 {学生姓名} 的模板仍算「事实驱动」→ 其余事实照补（宁可多给、不让 AI 编）', () => {
    const prompt = buildPrompt('写一段给{学生姓名}家长的反馈，自由发挥。', BASE_INPUTS, BASE_STYLE);
    expect(prompt).toContain('【补充事实');
    expect(prompt).toContain('课堂内容：牛顿第二定律');
    expect(prompt).toContain('备注：今天有点咳嗽，别写太重');
  });
});

describe('0030 组装器：成绩为空 → 槽位段整体剔除', () => {
  it('整行只剩该槽位（含标签）时删整行——不留「测试成绩：」空行', () => {
    const prompt = buildPrompt(BUILTIN_LIKE, { ...BASE_INPUTS, score: '', scoreTitle: '' }, BASE_STYLE);
    expect(prompt).not.toContain('测试成绩');
    expect(prompt).not.toMatch(/\n\s*\n\s*\n/); // 不因删行留出连续空行
    expect(prompt).toContain('课后任务：完成练习册 P32 第 1-6 题');
  });

  it('槽位与其他内容同行时只删槽位本身（不误删整行）', () => {
    const tpl = '一行两项：{课堂表现}｜{成绩}';
    const prompt = buildPrompt(tpl, { ...BASE_INPUTS, score: '' }, BASE_STYLE);
    expect(prompt).toContain('一行两项：专注投入、积极举手｜');
    expect(prompt).not.toContain('{成绩}');
  });

  it('课后任务/课堂表现为空同样按行剔除（与成绩同规则，报告申报）', () => {
    const prompt = buildPrompt(BUILTIN_LIKE, { ...BASE_INPUTS, homework: '', performance: [] }, BASE_STYLE);
    expect(prompt).not.toContain('课后任务');
    expect(prompt).not.toContain('课堂表现');
    expect(prompt).toContain('课堂内容：牛顿第二定律');
  });
});

describe('0030 组装器：风格槽位缺失时的兜底追加', () => {
  it('模板不含风格槽位 → 追加【写作要求】段（风格三维仍生效）', () => {
    const tpl = '给学生{学生姓名}写反馈。\n课堂内容：{课堂内容}';
    const prompt = buildPrompt(tpl, BASE_INPUTS, { tone: 'concise', length: 'short', familyAdvice: false });
    expect(prompt).toContain('给学生陈小明写反馈。');
    expect(prompt).toContain('【写作要求】');
    expect(prompt).toContain('语气：简明扼要');
    expect(prompt).toContain('篇幅：约 100 字');
    expect(prompt).toContain('家庭建议：不要写家庭建议。');
  });

  it('模板自带风格槽位 → 不追加（避免重复两段写作要求）', () => {
    const prompt = buildPrompt(BUILTIN_LIKE, BASE_INPUTS, BASE_STYLE);
    expect(prompt.match(/【写作要求】/g)).toHaveLength(1);
  });
});

describe('0030 组装器：缺值显式报错（不静默出草稿）', () => {
  it('学生姓名缺失/空白 → 抛错且指明字段', () => {
    expect(() => buildPrompt(BUILTIN_LIKE, { ...BASE_INPUTS, studentName: '  ' }, BASE_STYLE))
      .toThrow(/学生姓名/);
  });

  it('课堂内容缺失 → 抛错且指明字段', () => {
    expect(() => buildPrompt(BUILTIN_LIKE, { ...BASE_INPUTS, lessonContent: '' }, BASE_STYLE))
      .toThrow(/课堂内容/);
  });
});

describe('0030 组装器：数字取样（守卫共用同一取数口径）', () => {
  it('feedbackNumbers 汇总四项输入里出现的阿拉伯数字（含成绩/内容/任务/表现）', () => {
    const numbers = feedbackNumbers(BASE_INPUTS);
    expect(numbers).toContain('4');
    expect(numbers).toContain('82');
    expect(numbers).toContain('1');
    expect(numbers).toContain('6');
    expect(numbers).toContain('32');
  });

  it('成绩为空时不产生成绩数字', () => {
    expect(feedbackNumbers({ ...BASE_INPUTS, score: '', scoreTitle: '', lessonContent: '今天讲概念', homework: '' }))
      .toEqual([]);
  });
});
