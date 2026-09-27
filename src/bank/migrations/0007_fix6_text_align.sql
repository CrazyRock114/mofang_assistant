-- 0004-fix-6 P1-1：文本内容块对齐（左/中/右）。
-- paper_questions 加列 text_align：kind='text' 行的对齐（'left'|'center'|'right'）；
-- NULL = 缺省（样式基线观感：section 居中 / note 左），读侧不输出对齐类，存量渲染零漂移。
-- 契约只增（PaperQuestionRef.align / PaperTextBlock.align）。

ALTER TABLE paper_questions ADD COLUMN text_align TEXT;
