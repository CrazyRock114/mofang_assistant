// 0005 课后反馈 M6：模板渲染纯函数（app 侧独立模块，域隔离红线：零依赖 docgen/render）。
// 变量插值 `{中文键}` 式：缺变量留空不炸、多余变量忽略；正文即模板（教师直接写中文键）。

/** 模板可插变量集（中文键，任务书 §二-3 定案） */
export const FEEDBACK_VARS = [
  '学生姓名', '科目', '日期', '考试名称', '成绩',
  '错题情况', '课堂表现', '本次内容', '学习建议', '老师姓名',
] as const;

export type FeedbackVars = Record<string, string>;

/**
 * 模板正文渲染：`{变量名}` → vars 值。
 * - vars 缺该键/值为空白 → 替换为空串（留空不炸）；
 * - vars 中多余键忽略；非变量花括号文本原样保留。
 */
export function renderFeedback(bodyTemplate: string, vars: FeedbackVars): string {
  return bodyTemplate.replace(/\{([^{}]+)\}/g, (match, key: string) => {
    const value = vars[key];
    return value !== undefined && String(value).trim() !== '' ? String(value) : '';
  });
}

/** 事件摘要截断（课堂表现最近 N 条每条截断 60 字） */
export function truncateText(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 错题红黄绿计数摘要（红黄均无 → 空串；绿题=已掌握不进摘要） */
export function mistakeSummary(counts: { red: number; yellow: number; green: number }): string {
  if (counts.red + counts.yellow === 0) return '';
  return `当前红题 ${counts.red}、黄题 ${counts.yellow}`;
}
