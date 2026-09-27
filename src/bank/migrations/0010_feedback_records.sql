-- 0010 反馈模块一期（0030）：feedback_records 反馈记录 + feedback_prompt_templates AI 通道提示词模板。
-- 文件名序号 0010 走预分配序列（0009=0027 / 0011=0031 已锚定）；运行时 version 依 db.ts 注册顺序顺延为 12
--（0012→9 / 0013→10 / 0014→11 之后；口径见 0030 任务书 头部「迁移授权」）。
--
-- 口径（D-065，2026-09-20 用户拍板）：
--   双模式 —— 快速模式（一次性、不关联档案：student_id/class_id/exam_id 留空）+
--             班级批量模式（关联学生/班级，可关联考试带成绩，保存即计入档案）；
--   取消「标记已发」状态机 —— 只有「保存记录」一个动作：本表记「当时怎么生成的」
--   （channel/prompt_snapshot/model_profile_id/input_json）+ 最终正文 body，不跟踪发没发。
--
-- 域隔离：只建 feedback 新域两张表；既有 feedback_templates（0005 离线模板）一字不动——
-- 那张表继续承载「离线通道」正文插值，本表承载 AI 通道提示词与落档记录。

CREATE TABLE feedback_records (
  id TEXT PRIMARY KEY,
  student_id TEXT,                          -- NULL = 快速模式留痕（不关联学生档案）
  student_name TEXT NOT NULL,               -- 冗余存姓名：快速模式无 student_id 也要有名字
  class_id TEXT,
  exam_id TEXT,
  channel TEXT NOT NULL CHECK (channel IN ('offline', 'ai')),
  prompt_template_id TEXT,                  -- AI 通道所用的提示词模板 id（离线通道为空）
  prompt_snapshot TEXT,                     -- AI 通道实际使用的提示词全文快照（离线通道为空）
  model_profile_id TEXT,                    -- 生成时 reasoning 角色档案 id（离线通道为空）
  input_json TEXT NOT NULL,                 -- 四项输入快照 {课堂内容,课堂表现[],课后任务,成绩}
  body TEXT NOT NULL,                       -- 保存时以编辑后正文为准
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 记录页按时间倒序 + 班级 chip / 姓名搜索（任务书 §一 P5）
CREATE INDEX idx_feedback_records_created_at ON feedback_records (created_at DESC);
CREATE INDEX idx_feedback_records_class_id ON feedback_records (class_id);
CREATE INDEX idx_feedback_records_student_id ON feedback_records (student_id);

CREATE TABLE feedback_prompt_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  body TEXT NOT NULL,                       -- 提示词全文，含 {变量} 槽位（事实五项 + 风格三项）
  is_builtin INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT,
  updated_at TEXT
);

-- 内置两条（D-065②：内置 + 自定义并存，全文可见可改可导出/导入）：
--   ① 通用课后反馈（默认）：日常课后反馈；去 AI 味规则直接写进正文（承接 P-28）——
--      「不得编造、不得改动数字」+ 禁「AI」「模型」字样 + 称呼「xx家长」；
--   ② 考后成绩反馈：以成绩为事实锚点的考后沟通。
-- 正文含事实槽位（含目检返工③新增的 {课程主题}/{备注}）与风格三维槽位 {语气}/{篇幅}/{家庭建议}
--（组装器按档位填，见 src/app/feedback/prompt.ts；模板缺某个事实槽位时会由组装器补一段【补充事实】）。
-- 种子幂等：已存在同名内置则跳过（照 0005_feedback.sql 口径）。

INSERT INTO feedback_prompt_templates (id, name, body, is_builtin, created_at, updated_at)
SELECT 'feedback-prompt-builtin-general', '通用课后反馈',
       '你是一位有经验的培训老师，正在给学生{学生姓名}的家长写课后反馈。

【事实信息——只允许使用以下内容，不得编造、不得改动数字】
课程主题：{课程主题}
课堂内容：{课堂内容}
课堂表现：{课堂表现}
课后任务：{课后任务}
测试成绩：{成绩}
备注：{备注}

【写作要求】
语气：{语气}。篇幅：{篇幅}。{家庭建议}
直接输出反馈正文，不要开场白和客套话，不要出现「AI」「模型」等词，称呼家长为「xx家长」。',
       1, '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z'
WHERE NOT EXISTS (
  SELECT 1 FROM feedback_prompt_templates WHERE is_builtin = 1 AND name = '通用课后反馈'
);

INSERT INTO feedback_prompt_templates (id, name, body, is_builtin, created_at, updated_at)
SELECT 'feedback-prompt-builtin-exam', '考后成绩反馈',
       '你是一位有经验的培训老师，正在给学生{学生姓名}的家长写这次考试的成绩反馈。

【事实信息——只允许使用以下内容，不得编造、不得改动数字】
本次成绩：{成绩}
课程主题：{课程主题}
课堂内容：{课堂内容}
课堂表现：{课堂表现}
课后任务：{课后任务}
备注：{备注}

【写作要求】
语气：{语气}。篇幅：{篇幅}。{家庭建议}
直接输出反馈正文，不要开场白和客套话，不要出现「AI」「模型」等词，称呼家长为「xx家长」；成绩只讲事实、不做排名比较。',
       1, '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z'
WHERE NOT EXISTS (
  SELECT 1 FROM feedback_prompt_templates WHERE is_builtin = 1 AND name = '考后成绩反馈'
);
