// 0030 交付物证据：双通道样例输出对照（模板生成 vs AI 润色）+ 守卫命中样例（含「61→91」用例）。
// 目检返工③后输入为七项事实（含课程主题/备注）；返工④后通道由显式开关决定（本样例按「开=AI / 关=模板」两条口径各出一份）。
//
// 本文件是「可复跑的样例生成器」：断言 + 打印，命令输出重定向即得
//   0030 双通道样本留痕
// （见交付报告 §四「复现命令」）。
//
// 诚实口径（重要，勿误读日志）：
//   • 离线档正文 = 真实离线通道（src/app/feedback/engine.ts renderOfflineFeedback）对真实模板的运行结果，逐字可复现；
//   • AI 档「模型返回」= **回放样例**（按内置提示词跑通后的预期形态人工留档；本机无 Key，链路由
//     feedback-engine.test.ts 的注入式 invoke 桩验证，真调由验收方持 Key 在应用内复跑，见用户目检清单）；
//   • 守卫命中样例 = 真实守卫函数对上述正文的实算输出（不是手写文案）。

import { describe, it, expect, beforeAll } from 'vitest';
import { BUILTIN_PROMPT_GENERAL } from '../../src/bank/mock/mock-store.js';
import { checkFeedbackText } from '../../src/app/feedback/guard.js';
import { buildPrompt, type FeedbackInputs, type FeedbackStyle } from '../../src/app/feedback/prompt.js';
import { feedbackInputSnapshot, renderOfflineFeedback } from '../../src/app/feedback/engine.js';

/** 0005 内置离线模板正文（与迁移 0005_feedback.sql 种子一字不差） */
const OFFLINE_BUILTIN = '{学生姓名}家长您好！本次{科目}课我们学习了{本次内容}。{课堂表现}{成绩}{错题情况}{学习建议}如有疑问欢迎与我沟通。——{老师姓名}';

const STYLE: FeedbackStyle = { tone: 'warm', length: 'medium', familyAdvice: true };

/** 样例一（正常档）：七项事实齐全 */
const INPUTS: FeedbackInputs = {
  studentName: '陈小明',
  topic: '牛顿第二定律',
  lessonContent: '牛顿第二定律：F=ma 的理解与简单计算，做了 4 道课堂练习',
  performance: ['专注投入', '积极举手', '自己检查了错题'],
  homework: '完成练习册 P32 第 1-6 题',
  score: '82',
  scoreTitle: '课堂小测',
  note: '他今天嗓子不太舒服，语气别太用力',
};

/** 样例二（守卫命中档）：61 分被写成 91 分（任务书 §四点名的用例） */
const INPUTS_MISMATCH: FeedbackInputs = {
  studentName: '王浩',
  topic: '欧姆定律',
  lessonContent: '欧姆定律 I=U/R，串并联电路计算；课堂练习 5 道',
  performance: ['走神', '练习不足'],
  homework: '练习册 P45 第 1-8 题',
  score: '61',
  scoreTitle: '第九章单元测',
  note: '公式记忆不牢，多给一点可执行的小步骤',
};

const AI_REPLAY_TEXT = '陈小明家长您好！这节课我们学习了牛顿第二定律 F=ma，并通过 4 道课堂练习巩固了公式的应用。'
  + '小明上课时专注投入、举手积极，能主动说出公式的含义，值得表扬。本次课堂小测他得了 82 分，基础掌握得不错，'
  + '个别计算还可以再细心一些。课后请督促他完成练习册 P32 第 1-6 题，并预习第三节。'
  + '在家可以让他把今天的公式讲给您听，能讲清楚就是真懂了。';

const AI_REPLAY_TEXT_MISMATCH = '王浩家长您好！这节课我们学习了欧姆定律 I=U/R 与串并联电路计算，课堂练习 5 道。'
  + '他上课时有些走神，练习也偏少一些。本次单元测他得了 91 分，公式记忆还需加强。'
  + '课后请督促他完成练习册 P45 第 1-8 题，并整理本章的公式卡片。';

function box(title: string, body: string): string {
  return `\n${'='.repeat(78)}\n${title}\n${'-'.repeat(78)}\n${body}\n`;
}

describe('0030 交付物样例：双通道对照 + 守卫命中', () => {
  let offlineSample = '';
  let aiPrompt = '';
  let mismatchPrompt = '';

  beforeAll(() => {
    offlineSample = renderOfflineFeedback(OFFLINE_BUILTIN, INPUTS, { date: '2026-09-22' });
    aiPrompt = buildPrompt(BUILTIN_PROMPT_GENERAL, INPUTS, STYLE);
    mismatchPrompt = buildPrompt(BUILTIN_PROMPT_GENERAL, INPUTS_MISMATCH, STYLE);
  });

  it('样例一：同一份输入 → 模板生成正文 与 AI 润色提示词/回放正文对照', () => {
    const offlineGuard = checkFeedbackText(INPUTS, offlineSample);
    const aiGuard = checkFeedbackText(INPUTS, AI_REPLAY_TEXT);

    console.log(box('【样例一 · 七项事实（同一份输入喂两条通道）】', JSON.stringify({
      学生姓名: INPUTS.studentName,
      课程主题: INPUTS.topic,
      课堂内容: INPUTS.lessonContent,
      课堂表现: INPUTS.performance,
      课后任务: INPUTS.homework,
      成绩: `${INPUTS.score}（${INPUTS.scoreTitle}）`,
      备注: INPUTS.note,
      风格: '温和鼓励 / 约 200 字 / 带家庭建议',
      落档快照: feedbackInputSnapshot(INPUTS),
    }, null, 2)));

    console.log(box('【通道 A · 模板生成】开关关掉时用（0005 模板插值，逐字可复现；备注不进正文）', offlineSample));
    console.log(box('【通道 A · 模板生成 · 守卫结果】', JSON.stringify(offlineGuard.failures, null, 2) || '[]'));

    console.log(box('【通道 B · AI 润色 · 实际发出的提示词全文】', aiPrompt));
    console.log(box(
      '【通道 B · AI 润色 · 模型返回（回放样例，非真调）】',
      '(注：备注是给模型的补充说明，模型按它调语气即可，不必逐字出现在正文里。)\n' + AI_REPLAY_TEXT,
    ));
    console.log(box('【通道 B · AI 润色 · 守卫结果】', JSON.stringify(aiGuard.failures)));

    expect(offlineSample).toContain('陈小明家长您好');
    expect(offlineSample).not.toContain('嗓子'); // 备注不进模板正文
    // 0059：备注槽标签升级为「只用来把握语气和详略」整串（组装器只替换槽位本身，标签+值连续出现）
    expect(aiPrompt).toContain('备注（只用来把握语气和详略，不要照抄进正文）：他今天嗓子不太舒服，语气别太用力');
    expect(offlineGuard.failures).toEqual([]);
    expect(aiGuard.failures).toEqual([]);
    expect(aiPrompt).not.toContain('{学生姓名}');
  });

  it('样例二：守卫命中——AI 把登记的 61 改写成 91（必拦，标红提醒不硬拦）', () => {
    const guard = checkFeedbackText(INPUTS_MISMATCH, AI_REPLAY_TEXT_MISMATCH);

    console.log(box('【样例二 · 登记事实】', JSON.stringify({
      学生姓名: INPUTS_MISMATCH.studentName,
      课程主题: INPUTS_MISMATCH.topic,
      课堂内容: INPUTS_MISMATCH.lessonContent,
      课堂表现: INPUTS_MISMATCH.performance,
      课后任务: INPUTS_MISMATCH.homework,
      成绩: `${INPUTS_MISMATCH.score}（${INPUTS_MISMATCH.scoreTitle}）`,
      备注: INPUTS_MISMATCH.note,
    }, null, 2)));
    console.log(box('【样例二 · 实际发出的提示词全文】', mismatchPrompt));
    console.log(box('【样例二 · 模型返回（回放样例：分数被写错）】', AI_REPLAY_TEXT_MISMATCH));
    console.log(box('【样例二 · 守卫实算输出】', JSON.stringify(guard.failures, null, 2)));

    expect(guard.failures.map((f) => f.rule)).toContain('number-mismatch');
    expect(guard.failures.find((f) => f.rule === 'number-mismatch')!.detail).toContain('91');
  });

  it('样例三：禁词与称呼样例（AI 口吻失控时逐条点名）', () => {
    const bad = '该生本次单元测 61 分，由 AI 模型分析后给出建议。';
    const guard = checkFeedbackText(INPUTS_MISMATCH, bad);
    console.log(box('【样例三 · 失控正文（含禁词与「该生」）】', bad));
    console.log(box('【样例三 · 守卫实算输出】', JSON.stringify(guard.failures, null, 2)));
    // 「AI」「模型」两条禁词 + 未称呼姓名 + 出现「该生」；61 分原值在正文里，故不报数字问题
    expect(guard.failures.map((f) => f.rule).sort()).toEqual(
      ['banned-word', 'banned-word', 'impolite-address', 'missing-name'].sort(),
    );
  });
});
