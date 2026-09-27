-- 0044 P1：试卷文件夹 + 回收站（D-060①③ / D-062）
-- 0044 任务书 §二.P1；契约锚点 bank-types.ts（PaperStatus 只增 'trashed'）。
--
-- 文件序号 0013 按预分配序列（0009=0027 / 0010=0030 / 0011=0031 已锚定；0013 原预占给 0040、
-- 0040 零迁移释放后改派 0044），运行时 version=10（db.ts 硬编码清单）。
--
-- 注意：papers.status 列在 0002 带 CHECK (IN basket/composing/done/archived)，SQLite 不能
-- ALTER 修改 CHECK——本迁移按官方 12 步流程重建 papers 表（新 CHECK 含 'trashed' + 新增
-- folder_id/trashed_from 两列）。重建期间的外键关闭由迁移执行器（db.ts runMigrations）在
-- 事务外统一处理（PRAGMA foreign_keys 在事务内是 no-op），本文件只做表/索引/数据搬运。

-- 1) 文件夹表（D-062：parent_id 自引用嵌套，NULL=顶级；papers.folder_id 无外键约束、应用层维护）
CREATE TABLE paper_folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT NULL REFERENCES paper_folders(id),
  sort INTEGER,
  created_at TEXT
);

CREATE INDEX idx_paper_folders_parent ON paper_folders(parent_id);

-- 2) papers 重建：列序与既有结构一致（0001 四列 + archived + 0002 三列），
--    仅 status 的 CHECK 扩 'trashed'，并追加 folder_id / trashed_from（均 NULL=未分类/无回收站来源）
CREATE TABLE papers_0013_new (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'basket' CHECK (status IN ('basket','composing','done','archived','trashed')),
  paper_type TEXT NOT NULL DEFAULT 'uniform',
  layout_config_json TEXT,
  folder_id TEXT,
  trashed_from TEXT
);

INSERT INTO papers_0013_new (id, title, config, created_at, archived, status, paper_type, layout_config_json)
SELECT id, title, config, created_at, archived, status, paper_type, layout_config_json FROM papers;

DROP TABLE papers;
ALTER TABLE papers_0013_new RENAME TO papers;

-- DROP TABLE 带走了 status 索引，重建（0002 既有口径同名）
CREATE INDEX idx_papers_status ON papers(status);
CREATE INDEX idx_papers_folder ON papers(folder_id);
