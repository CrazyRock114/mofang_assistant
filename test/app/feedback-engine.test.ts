// 0030 P2：生成管线编排（双通道）+ 提示词模板 pack（导出/导入文本）单测。
// 引擎侧不摸 window：invoke 由调用方注入（UI 传 ai.invoke 白名单桥），故可纯测。

import { describe, it, expect, vi } from 'vitest';
import type { AiInvokePayload, AiInvokeResult } from '../../src/shared/contracts/ai-types.js';
import {
  offlineVars, renderOfflineFeedback, generateFeedback, AI_FEEDBACK_ROLE,
  FEEDBACK_MAX_TOKENS, FEEDBACK_TEMPERATURE, FEEDBACK_TIMEOUT_MS,
  type FeedbackInputs,
} from '../../src/app/feedback/engine.js';
import { formatPromptPack, parsePromptPack, PROMPT_PACK_HEADER } from '../../src/app/feedback/prompt-pack.js';
import type { FeedbackStyle } from '../../src/app/feedback/prompt.js';

const INPUTS: FeedbackInputs = {
  studentName: '陈小明',
  topic: '牛顿第二定律',
  lessonContent: '牛顿第二定律：F=ma 的理解与简单计算，做了 4 道课堂练习',
  performance: ['专注投入', '积极举手'],
  homework: '完成练习册 P32 第 1-6 题',
  score: '82',
  scoreTitle: '课堂小测',
  note: '今天有点咳嗽，别写太重',
};

const STYLE: FeedbackStyle = { tone: 'warm', length: 'medium', familyAdvice: true };

/** 0005 内置离线模板正文（与迁移 0005 种子一字不差） */
const OFFLINE_TPL = '{学生姓名}家长您好！本次{科目}课我们学习了{本次内容}。{课堂表现}{成绩}{错题情况}{学习建议}如有疑问欢迎与我沟通。——{老师姓名}';

const PROMPT_TPL = [
  '你是一位有经验的培训老师，正在给学生{学生姓名}的家长写课后反馈。',
  '课堂内容：{课堂内容}',
  '测试成绩：{成绩}',
  '语气：{语气}。篇幅：{篇幅}。{家庭建议}',
].join('\n');

describe('0030 离线档：四项输入 → 0005 槽位映射与正文', () => {
  it('槽位映射：内容/表现/成绩/课后任务各归其位；不收集的键留空', () => {
    const vars = offlineVars(INPUTS, { date: '2026-09-22' });
    expect(vars['学生姓名']).toBe('陈小明');
    // 课程主题：内容里已经提到它 → 不重复说（离线档不新增槽位，0005 十键里没有主题键）
    expect(vars['本次内容']).toBe('牛顿第二定律：F=ma 的理解与简单计算，做了 4 道课堂练习');
    expect(vars['课堂表现']).toBe('上课时专注投入、积极举手。');
    expect(vars['成绩']).toBe('本次课堂小测得 82 分。');
    expect(vars['学习建议']).toBe('课后安排：完成练习册 P32 第 1-6 题。');
    expect(vars['日期']).toBe('2026-09-22');
    // 科目/老师姓名工作台不收集（设计稿表单无此两项）；错题情况不做（D-065①）
    expect(vars['科目']).toBe('');
    expect(vars['老师姓名']).toBe('');
    expect(vars['错题情况']).toBe('');
    // 备注是「给 AI 的补充说明」，不进离线正文（无对应槽位；UI 文案已注明）
    expect(Object.values(vars).join('')).not.toContain('咳嗽');
  });

  it('课程主题为空 → 只写课堂内容；内容没提到主题 → 主题作前缀（信息不丢也不重复）', () => {
    expect(offlineVars({ ...INPUTS, topic: '' })['本次内容']).toBe('牛顿第二定律：F=ma 的理解与简单计算，做了 4 道课堂练习');
    expect(offlineVars({ ...INPUTS, topic: '受力分析专题' })['本次内容'])
      .toBe('受力分析专题：牛顿第二定律：F=ma 的理解与简单计算，做了 4 道课堂练习');
  });

  it('成绩空 → 成绩段为空串（不留「本次测试得 分」）；表现空 → 空串', () => {
    const vars = offlineVars({ ...INPUTS, score: '', scoreTitle: '', performance: [] });
    expect(vars['成绩']).toBe('');
    expect(vars['课堂表现']).toBe('');
  });

  it('离线正文：可读成句、结尾空签名不留残迹、数字与输入一致', () => {
    const text = renderOfflineFeedback(OFFLINE_TPL, INPUTS);
    expect(text).toBe(
      '陈小明家长您好！本次课我们学习了牛顿第二定律：F=ma 的理解与简单计算，做了 4 道课堂练习。'
      + '上课时专注投入、积极举手。本次课堂小测得 82 分。课后安排：完成练习册 P32 第 1-6 题。'
      + '如有疑问欢迎与我沟通。',
    );
  });
});

describe('0030 生成编排：通道选择与失败是结果不是异常', () => {
  it('离线档：不出网、不打 invoke；给出正文与守卫结果；通道标记 offline', async () => {
    const invoke = vi.fn();
    const outcome = await generateFeedback({
      inputs: INPUTS, style: STYLE, channel: 'offline',
      offlineTemplateBody: OFFLINE_TPL, invoke,
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.channel).toBe('offline');
    expect(outcome.prompt).toBeNull();
    expect(outcome.modelProfileId).toBeNull();
    expect(outcome.text).toContain('陈小明');
    expect(outcome.failures).toEqual([]);
  });

  it('AI 档：组装提示词 → invoke(reasoning) → 正文与守卫；快照与档案 id 回传落档用', async () => {
    const invoke = vi.fn(async (payload: AiInvokePayload): Promise<AiInvokeResult> => ({
      ok: true,
      content: '陈小明家长您好！这节课我们学习了牛顿第二定律，本次课堂小测得 82 分，值得表扬。',
      latencyMs: 12,
      usage: { promptTokens: 100, completionTokens: 40, totalTokens: 140 },
    }));
    const outcome = await generateFeedback({
      inputs: INPUTS, style: STYLE, channel: 'ai',
      promptTemplate: { id: 'tpl-1', body: PROMPT_TPL },
      modelProfileId: 'profile-9', invoke,
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    const payload = invoke.mock.calls[0]![0] as AiInvokePayload;
    expect(payload.role).toBe(AI_FEEDBACK_ROLE);
    expect(payload.role).toBe('reasoning');
    expect(payload.messages).toHaveLength(1);
    const sent = payload.messages[0]!.content as string;
    expect(sent).toContain('课堂内容：牛顿第二定律');
    expect(sent).toContain('语气：温和鼓励。篇幅：约 200 字。');
    expect(payload.maxTokens).toBe(FEEDBACK_MAX_TOKENS);
    expect(payload.temperature).toBe(FEEDBACK_TEMPERATURE);
    expect(payload.timeoutMs).toBe(FEEDBACK_TIMEOUT_MS);
    expect(payload.thinking).toBeUndefined(); // 思考开关不显式设置（走供应商默认，报告申报）

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.channel).toBe('ai');
    expect(outcome.text).toContain('82 分');
    expect(outcome.prompt).toBe(sent);
    expect(outcome.modelProfileId).toBe('profile-9');
    expect(outcome.promptTemplateId).toBe('tpl-1');
  });

  it('AI 档失败（网关 ok:false）→ 结果形态回传原因，不抛异常', async () => {
    const outcome = await generateFeedback({
      inputs: INPUTS, style: STYLE, channel: 'ai',
      promptTemplate: { id: 'tpl-1', body: PROMPT_TPL },
      invoke: async () => ({ ok: false, error: '网关超时（30000ms）', latencyMs: 30000 }),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.channel).toBe('ai');
    expect(outcome.error).toContain('网关超时');
  });

  it('AI 档缺必填（课堂内容空）→ 组装期报错转结果形态（不静默出草稿）', async () => {
    const invoke = vi.fn();
    const outcome = await generateFeedback({
      inputs: { ...INPUTS, lessonContent: '' }, style: STYLE, channel: 'ai',
      promptTemplate: { id: 'tpl-1', body: PROMPT_TPL }, invoke,
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('课堂内容');
  });

  it('AI 档守卫：AI 把 82 写成 92 → 正文照出但 failures 命中（UI 标红，不硬拦）', async () => {
    const outcome = await generateFeedback({
      inputs: INPUTS, style: STYLE, channel: 'ai',
      promptTemplate: { id: 'tpl-1', body: PROMPT_TPL },
      invoke: async () => ({ ok: true, content: '陈小明家长您好！本次课堂小测得 92 分。', latencyMs: 8 }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.failures.map((f) => f.rule)).toContain('number-mismatch');
  });
});

describe('0030 提示词 pack：导出/导入文本（分享形态）', () => {
  it('formatPromptPack：头部 + name 行 + 分隔线 + 正文', () => {
    const pack = formatPromptPack('我的·简短版', '给学生{学生姓名}写反馈。');
    expect(pack.startsWith(PROMPT_PACK_HEADER)).toBe(true);
    expect(pack).toContain('name: 我的·简短版');
    expect(pack).toContain('---\n给学生{学生姓名}写反馈。');
  });

  it('往返：format → parse 一字不差（正文含多行与花括号槽位）', () => {
    const body = '给学生{学生姓名}写反馈。\n\n【事实信息】\n课堂内容：{课堂内容}\n语气：{语气}。';
    const parsed = parsePromptPack(formatPromptPack('期末版', body));
    expect(parsed.name).toBe('期末版');
    expect(parsed.body).toBe(body);
  });

  it('parsePromptPack：无头部/无分隔线时按纯正文导入（回落文件名作名）', () => {
    const parsed = parsePromptPack('只给学生{学生姓名}写反馈。', '导入的模板.txt');
    expect(parsed.name).toBe('导入的模板（导入）');
    expect(parsed.body).toBe('只给学生{学生姓名}写反馈。');
  });

  it('parsePromptPack：空正文拒绝（抛错，不建空模板）', () => {
    expect(() => parsePromptPack('   \n  ')).toThrow();
  });
});
