// 0005：课后反馈纯函数单测 —— renderFeedback（中文键插值/缺失留空/多余忽略）、
// 卡片自绘 HTML 构建器（尺寸/转义/款式/徽标）。
// 0030：（退役）「学生数据卡变量聚合」段随 D-065① 口径下线——错题红黄/近期表现不再进反馈，
// 工作台的取数改为四项输入（新人话模板映射见 test/app/feedback-engine.test.ts 的 offlineVars 用例）。
// 本文件其余部分（插值/卡片）为 0030 离线档与卡片导出继续使用的既有能力，逐字保留。

import { describe, it, expect } from 'vitest';
import type { Exam, ExamScore, Mistake, StudentEvent } from '../../src/shared/contracts/bank-types.js';
import { FEEDBACK_VARS, renderFeedback, truncateText, mistakeSummary } from '../../src/app/feedback/render.js';
import { buildFeedbackCardHtml, FEEDBACK_CARD_WIDTH, FEEDBACK_CARD_HEIGHT } from '../../src/app/feedback/card.js';

describe('0005 renderFeedback：中文键插值', () => {
  it('基本插值：{中文键} 替换为变量值', () => {
    const body = '{学生姓名}家长您好！本次{科目}课学习了{本次内容}。——{老师姓名}';
    const out = renderFeedback(body, {
      学生姓名: '张三', 科目: '数学', 本次内容: '分数运算', 老师姓名: '李老师',
    });
    expect(out).toBe('张三家长您好！本次数学课学习了分数运算。——李老师');
  });

  it('缺失变量留空不炸；空白值同样留空', () => {
    const out = renderFeedback('A{成绩}B{错题情况}C', {});
    expect(out).toBe('ABC');
    expect(renderFeedback('A{成绩}B', { 成绩: '   ' })).toBe('AB');
  });

  it('多余变量忽略；非变量花括号文本原样保留', () => {
    const out = renderFeedback('正文{学生姓名}结束', { 学生姓名: '张三', 成绩: '99', 无关键: 'x' });
    expect(out).toBe('正文张三结束');
  });

  it('同一变量多次出现全部替换；变量集常量含任务书全量 10 键', () => {
    expect(renderFeedback('{科目}/{科目}', { 科目: '物理' })).toBe('物理/物理');
    expect(FEEDBACK_VARS).toEqual([
      '学生姓名', '科目', '日期', '考试名称', '成绩',
      '错题情况', '课堂表现', '本次内容', '学习建议', '老师姓名',
    ]);
  });

  it('truncateText/mistakeSummary：截断与红黄摘要（查无=空）', () => {
    expect(truncateText('a'.repeat(61))).toBe(`${'a'.repeat(60)}…`);
    expect(truncateText('短文本')).toBe('短文本');
    expect(mistakeSummary({ red: 2, yellow: 1, green: 0 })).toBe('当前红题 2、黄题 1');
    expect(mistakeSummary({ red: 0, yellow: 0, green: 3 })).toBe('');
  });
});

function makeEvent(id: string, eventType: 'performance' | 'note' | 'exam_score' | 'photo_attach', occurredAt: string, text: string, title?: string): StudentEvent {
  if (eventType === 'exam_score') {
    return { id, studentId: 's1', eventType, occurredAt, payload: { eventType, score: 90 }, createdAt: occurredAt };
  }
  if (eventType === 'photo_attach') {
    return { id, studentId: 's1', eventType, occurredAt, payload: { eventType, assetId: 'a.png' }, createdAt: occurredAt };
  }
  return {
    id, studentId: 's1', eventType, occurredAt,
    payload: eventType === 'note' ? { eventType, text, title } : { eventType, text },
    createdAt: occurredAt,
  };
}

function makeMistake(id: string, stage: 'red' | 'yellow' | 'green'): Mistake {
  return {
    id, questionId: `q-${id}`, studentId: 's1', occurredAt: '2026-09-01T00:00:00Z', stage,
    snapshot: { stemHtml: '<div>x</div>', options: [], answer: '', analysis: '', images: [] },
    createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
  };
}

describe('0005 卡片自绘 HTML 构建器', () => {
  it('固定像素容器 750×1000 + body margin 0（exportCards 无白边的构建侧保障）', () => {
    const card = buildFeedbackCardHtml({ bodyText: '本周表现优秀。' });
    expect(card.width).toBe(FEEDBACK_CARD_WIDTH);
    expect(card.height).toBe(FEEDBACK_CARD_HEIGHT);
    expect(card.html).toContain('html, body { margin: 0; padding: 0; }');
    expect(card.html).toContain('width: 750px; height: 1000px');
  });

  it('正文/姓名/科目/日期/落款渲染 + HTML 转义（XSS 输入不逃逸）', () => {
    const card = buildFeedbackCardHtml({
      bodyText: '第一行\n第二行 <script>alert(1)</script>',
      studentName: '张三',
      subject: '数学',
      date: '2026-09-09',
      teacherName: '李老师',
      title: '课后反馈',
    });
    expect(card.html).toContain('致 张三 家长');
    expect(card.html).toContain('科目：数学　·　日期：2026-09-09');
    expect(card.html).toContain('第一行<br>第二行');
    expect(card.html).toContain('&lt;script&gt;');
    expect(card.html).not.toContain('<script>');
    expect(card.html).toContain('—— 李老师');
  });

  it('两款样式参数化：简洁（白底）/暖色（米底棕字）+ 自定义主色', () => {
    const clean = buildFeedbackCardHtml({ bodyText: 'x', style: 'clean' });
    expect(clean.html).toContain('background: #ffffff');
    const warm = buildFeedbackCardHtml({ bodyText: 'x', style: 'warm' });
    expect(warm.html).toContain('background: #fdf6ec');
    expect(warm.html).toContain('color: #8b5a2b');
    const custom = buildFeedbackCardHtml({ bodyText: 'x', style: 'warm', accentColor: '#0b7285' });
    expect(custom.html).toContain('color: #0b7285');
  });

  it('徽标：data-assets 相对引用（导出时主进程改写 file:// 绝对路径）；缺省无 img', () => {
    const withLogo = buildFeedbackCardHtml({ bodyText: 'x', logoRelPath: 'logos/abc.png' });
    expect(withLogo.html).toContain('src="data-assets/logos/abc.png"');
    const noLogo = buildFeedbackCardHtml({ bodyText: 'x' });
    expect(noLogo.html).not.toContain('<img');
  });
});
