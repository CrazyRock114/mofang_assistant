-- 0048：补回 papers.paper_type 的 CHECK（0044/0013 整表重建时漏带）
-- 0048 任务书 §一.1；约束口径取 0002_bank_ext.sql:193 原文。
--
-- 文件序号 0014 按预分配序列（0009=0027 / 0010=0030 / 0011=0031 已锚定；0013=0044 已用），
-- 运行时 version=11（db.ts 硬编码清单）。
--
-- 根因：0013（0044）重建 papers 时新表只写了 `paper_type TEXT NOT NULL DEFAULT 'uniform'`，
-- 未带入 0002 的 `CHECK (paper_type IN ('uniform','custom-mistake'))` → 约束被放宽（数据无损）。
-- SQLite 不能 ALTER 修改 CHECK，且既有迁移 0001~0013 禁改，故按官方 12 步流程再重建一次。
-- 重建期间的外键关闭由迁移执行器（db.ts runMigrations）在事务外统一处理，本文件只做表/索引/
-- 数据搬运；搬运若遇 v10 窗口期写坏的越界 paper_type，CHECK 会让本迁移整体回滚（版本留在 10，
-- 既有数据不动），不静默改数。

-- 1) 新表：10 列与 0013 重建后结构逐列一致（列序不动），仅补回 paper_type 的 CHECK；
--    status 的 CHECK 保持含 'trashed'（0013 扩态不回归）
CREATE TABLE papers_0014_new (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'basket' CHECK (status IN ('basket','composing','done','archived','trashed')),
  paper_type TEXT NOT NULL DEFAULT 'uniform' CHECK (paper_type IN ('uniform','custom-mistake')),
  layout_config_json TEXT,
  folder_id TEXT,
  trashed_from TEXT
);

-- 2) 十列全显式列出搬运（含 0013 新增的 folder_id / trashed_from，不许漏列）
INSERT INTO papers_0014_new (id, title, config, created_at, archived, status, paper_type, layout_config_json, folder_id, trashed_from)
SELECT id, title, config, created_at, archived, status, paper_type, layout_config_json, folder_id, trashed_from FROM papers;

-- 3) DROP 旧表 + 换名；DROP 带走 idx_papers_status / idx_papers_folder（0013 建的），随后按同名重建
DROP TABLE papers;
ALTER TABLE papers_0014_new RENAME TO papers;

CREATE INDEX idx_papers_status ON papers(status);
CREATE INDEX idx_papers_folder ON papers(folder_id);
