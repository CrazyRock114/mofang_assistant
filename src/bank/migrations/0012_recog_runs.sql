-- 0028 P1：识别 run 任务表（状态机 + 阶段 + 页进度 + 结果题目 id 集 + 错误 + 时间戳）
-- 0028 任务书 §一 P1；决策锚点 D-052 / 规划 T-07（混合持久化）
--
-- 文件序号 0012 按预分配序列（0009=0027 / 0010=0030 / 0011=0031），运行时 version=9（db.ts 硬编码清单）。
-- 混合持久化（T-07）：大产物（页 PNG / OCR 原文 / 草稿 JSON）落 userData/data/recog/runs/<runId>/，
-- 本表只存状态机与索引——「文件存在即 checkpoint」的语义由 shell 侧收发，表内 ocr_file 是目录指纹镜像。
-- 断点续跑 = 读本表恢复状态 + 跳过已存在页文件（既不清表也不重跑已完成页）。

CREATE TABLE recog_runs (
  id TEXT PRIMARY KEY,
  -- 状态机六态（前向边 queued→ocr→ai→done；任一步可 →error/cancelled；error/cancelled→ocr = 续跑边）
  status TEXT NOT NULL CHECK (status IN ('queued','ocr','ai','done','error','cancelled')),
  -- 阶段（进度条文案用；与 status 同值起步，后续任务可细分，故不加 CHECK）
  stage TEXT NOT NULL,
  -- 素材形态：image（拖拽/点选图片文件）/ clipboard（Ctrl+V 粘贴位图）；0036 的 pdf 走新值
  source_kind TEXT NOT NULL,
  source_name TEXT,
  page_count INTEGER NOT NULL DEFAULT 0,
  pages_done INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  warnings TEXT NOT NULL DEFAULT '[]',
  -- 结果题目 id 集（JSON 数组；校对页入库成功后回写，去重并集）
  question_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX idx_recog_runs_status ON recog_runs(status);
CREATE INDEX idx_recog_runs_created ON recog_runs(created_at);

-- 页级进度与 checkpoint 索引（"文件存在即跳过"的目录指纹镜像；resume 只读本表 + 探文件）
CREATE TABLE recog_run_pages (
  run_id TEXT NOT NULL REFERENCES recog_runs(id) ON DELETE CASCADE,
  page_no INTEGER NOT NULL,
  image_file TEXT NOT NULL,
  ocr_file TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','ocr','done','error')),
  text_chars INTEGER,
  image_ref_count INTEGER,
  error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, page_no)
);

CREATE INDEX idx_recog_run_pages_run ON recog_run_pages(run_id);
