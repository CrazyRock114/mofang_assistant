-- 0005 课后反馈 M6：文本反馈模板表 + 内置默认模板种子（0005 任务书 §一 P1）
-- 域隔离：本迁移只建 feedback 新域表，零触碰 docgen/render 与排版 config 路径。
-- 种子幂等：已存在同名内置模板则跳过。变量用中文键（教师直接在正文里写 {学生姓名} 等）。

CREATE TABLE feedback_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  body_template TEXT NOT NULL,
  is_builtin INTEGER DEFAULT 0,
  deleted INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT
);

INSERT INTO feedback_templates (id, name, body_template, is_builtin, created_at, updated_at)
SELECT 'feedback-tpl-builtin-default', '默认课后反馈',
       '{学生姓名}家长您好！本次{科目}课我们学习了{本次内容}。{课堂表现}{成绩}{错题情况}{学习建议}如有疑问欢迎与我沟通。——{老师姓名}',
       1, '2026-09-09T00:00:00Z', '2026-09-09T00:00:00Z'
WHERE NOT EXISTS (
  SELECT 1 FROM feedback_templates WHERE is_builtin = 1 AND name = '默认课后反馈'
);
