-- 0004-fix-4 2.3：大标题 = 同等级文本内容块（D-2026-09-09-04）。
-- paper_questions 行扩 kind/text_body/style：kind='text' 的行承载「一、单项选择题」类节标题块，
-- 不占题号（题号按 kind<>'text' 的行递增），克隆/快照/重排/导出复用既有行机制。
-- 契约只增（PaperQuestionRef.kind/textBody/style）；存量行 kind 为 NULL → 读侧按题目行处理。

ALTER TABLE paper_questions ADD COLUMN kind TEXT;
ALTER TABLE paper_questions ADD COLUMN text_body TEXT;
ALTER TABLE paper_questions ADD COLUMN style TEXT;
