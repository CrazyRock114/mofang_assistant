-- 0004：试题篮扩展迁移（依据 0004 任务书 §一-1.2b / §二-5/§二-6）
-- 仅两类授权变更：paper_questions 加列 + 内置 preset 种子；其余表结构零改动。
-- 种子幂等：已存在同名内置预设则跳过（开发库可能已有用户自建数据）。

-- ============================================================
-- 1. paper_questions 加列：题级图排版覆盖（U4 块化模型）
--    JSON 结构 = { figures?: { assetId, mode?, align?, widthPercent?, orderIndex? }[] }；
--    本迁移只加列，读写接线随 Phase 5（类型 QuestionFigureLayout 归乙路授权区）
-- ============================================================
ALTER TABLE paper_questions ADD COLUMN layout_json TEXT;

-- ============================================================
-- 2. 内置预设种子 ×2（用户拍板 §二-1/§二-6：仅 A3双列 / A4 两套；
--    pageSize/columns 定死，其余数值为基准）
-- ============================================================
INSERT INTO layout_presets (id, name, config_json, is_builtin, created_at)
SELECT 'preset-builtin-a3-2col', 'A3双列',
       '{"version":2,"pageSize":"A3","columns":2,"columnGapMm":8,"fontSize":12,"lineHeight":1.5,"header":{"style":"exam"}}',
       1, '2026-09-08T00:00:00Z'
WHERE NOT EXISTS (
  SELECT 1 FROM layout_presets WHERE is_builtin = 1 AND name = 'A3双列'
);

INSERT INTO layout_presets (id, name, config_json, is_builtin, created_at)
SELECT 'preset-builtin-a4', 'A4',
       '{"version":2,"pageSize":"A4","columns":1,"fontSize":12,"lineHeight":1.5,"header":{"style":"exam"}}',
       1, '2026-09-08T00:00:00Z'
WHERE NOT EXISTS (
  SELECT 1 FROM layout_presets WHERE is_builtin = 1 AND name = 'A4'
);
