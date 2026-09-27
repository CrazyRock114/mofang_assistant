-- 0002：地基扩展迁移（依据 0002 schema 草案 v0.2 + 地基设计决策稿 v2.3）
-- 开发库随 0002 整体重置（拍板 B13）：纯 DDL，无存量数据搬运。
-- 先建新表（供 questions/papers 外键引用），再加列。

-- ============================================================
-- 1. 字典（G2/U6：subject/question_type/difficulty；同义词不单独建表）
--    归一行 site=null；站点同义行 site+source_label，code=标准码
-- ============================================================
CREATE TABLE dict_entries (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('subject','question_type','difficulty')),
  code TEXT NOT NULL,
  label TEXT NOT NULL,
  site TEXT,
  source_label TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (kind, site, source_label)
);
-- 草案 UNIQUE(kind, code) 落地为部分唯一索引：归一行内 (kind,code) 唯一；
-- 站点同义行与归一行共用标准 code（内联 UNIQUE(kind,code) 会与同义行并存矛盾）
CREATE UNIQUE INDEX uq_dict_normalized_code ON dict_entries(kind, code) WHERE site IS NULL;

-- ============================================================
-- 2. 树（B3/U5/U12：章节树 + 知识点树平行；多挂；站点源映射）
-- ============================================================
CREATE TABLE trees (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('textbook','knowledge')),
  subject_id TEXT,
  edition TEXT,
  stage TEXT,
  name TEXT NOT NULL,
  source TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE tree_nodes (
  id TEXT PRIMARY KEY,
  tree_id TEXT NOT NULL REFERENCES trees(id),
  parent_id TEXT,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  UNIQUE (tree_id, parent_id, name)
);
CREATE TABLE question_node_links (
  question_id TEXT NOT NULL REFERENCES questions(id),
  node_id TEXT NOT NULL REFERENCES tree_nodes(id),
  PRIMARY KEY (question_id, node_id)
);
CREATE TABLE tree_source_map (
  node_id TEXT NOT NULL REFERENCES tree_nodes(id),
  site TEXT NOT NULL,
  site_node_id TEXT NOT NULL,
  site_node_name TEXT,
  PRIMARY KEY (site, site_node_id)
);
CREATE INDEX idx_tree_nodes_tree ON tree_nodes(tree_id, parent_id, sort);
CREATE INDEX idx_tree_nodes_parent ON tree_nodes(parent_id);
CREATE INDEX idx_question_node_links_node ON question_node_links(node_id);

-- ============================================================
-- 3. 学生/班级/时间线（B6/U6）
-- ============================================================
CREATE TABLE students (
  id TEXT PRIMARY KEY,
  student_no TEXT,
  name TEXT NOT NULL,
  gender TEXT,
  school TEXT,
  remark TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE classes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  school TEXT,
  grade_level TEXT,
  term TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  created_at TEXT NOT NULL
);
CREATE TABLE student_classes (
  student_id TEXT NOT NULL REFERENCES students(id),
  class_id TEXT NOT NULL REFERENCES classes(id),
  started_at TEXT,
  ended_at TEXT,
  PRIMARY KEY (student_id, class_id, started_at)
);
CREATE INDEX idx_student_classes_class ON student_classes(class_id);
CREATE TABLE student_events (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES students(id),
  event_type TEXT NOT NULL CHECK (event_type IN
    ('exam_score','performance','note','photo_attach')),
  occurred_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_student_events_student_time ON student_events(student_id, occurred_at);

-- ============================================================
-- 4. 考试/错题/成绩（B7/U2/U7/U9/U10/U14）
-- ============================================================
CREATE TABLE exams (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  class_id TEXT,
  subject_id TEXT,
  occurred_at TEXT NOT NULL,
  paper_set_id TEXT,
  remark TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE mistakes (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES questions(id),
  student_id TEXT NOT NULL REFERENCES students(id),
  exam_id TEXT,
  source_paper_id TEXT,
  occurred_at TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'red' CHECK (stage IN ('red','yellow','green')),
  last_correct_at TEXT,
  snapshot_json TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (question_id, student_id)
);
CREATE INDEX idx_mistakes_student ON mistakes(student_id, stage);
CREATE INDEX idx_mistakes_question ON mistakes(question_id);
CREATE TABLE exam_scores (
  id TEXT PRIMARY KEY,
  exam_id TEXT NOT NULL REFERENCES exams(id),
  student_id TEXT NOT NULL REFERENCES students(id),
  score REAL,
  detail_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (exam_id, student_id)
);
CREATE INDEX idx_exam_scores_student ON exam_scores(student_id);

-- ============================================================
-- 5. 试卷集合（U7：uniform 统一卷集合 / custom-mistake 每生一卷集合）
-- ============================================================
CREATE TABLE paper_sets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('uniform','custom-mistake')),
  batch_meta TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE paper_set_papers (
  paper_set_id TEXT NOT NULL REFERENCES paper_sets(id),
  paper_id TEXT NOT NULL REFERENCES papers(id),
  student_id TEXT,
  PRIMARY KEY (paper_set_id, paper_id)
);

-- ============================================================
-- 6. 版式预设（G7/U4：受控 config；deleted 列落 B11「用户预设软删」拍板）
-- ============================================================
CREATE TABLE layout_presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  config_json TEXT NOT NULL,
  is_builtin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);

-- ============================================================
-- 7. questions 加列（G1 结构化 + G2 字典化）+ 弃列（并入树/字典，B2）
-- ============================================================
ALTER TABLE questions ADD COLUMN stem_html TEXT;
ALTER TABLE questions ADD COLUMN options_json TEXT;
ALTER TABLE questions ADD COLUMN subject_id TEXT REFERENCES dict_entries(id);
ALTER TABLE questions ADD COLUMN type_id TEXT REFERENCES dict_entries(id);
ALTER TABLE questions ADD COLUMN difficulty_id TEXT REFERENCES dict_entries(id);
ALTER TABLE questions DROP COLUMN grade;
ALTER TABLE questions DROP COLUMN stage;
ALTER TABLE questions DROP COLUMN textbook;
ALTER TABLE questions DROP COLUMN version;
ALTER TABLE questions DROP COLUMN chapter;
CREATE INDEX idx_questions_subject_id ON questions(subject_id);

-- ============================================================
-- 8. papers 加列（G6 状态机 + U7 类型 + G7 版式定稿）
--    archived 旧列废弃（拍板 §6-2 单轨 status），列保留不再使用
-- ============================================================
ALTER TABLE papers ADD COLUMN status TEXT NOT NULL DEFAULT 'basket' CHECK (status IN ('basket','composing','done','archived'));
ALTER TABLE papers ADD COLUMN paper_type TEXT NOT NULL DEFAULT 'uniform' CHECK (paper_type IN ('uniform','custom-mistake'));
ALTER TABLE papers ADD COLUMN layout_config_json TEXT;
CREATE INDEX idx_papers_status ON papers(status);
