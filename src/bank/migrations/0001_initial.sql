CREATE TABLE questions (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('network','local')),
  source_detail TEXT NOT NULL,
  question_type TEXT,
  difficulty REAL,
  grade TEXT, stage TEXT,
  textbook TEXT, version TEXT,
  chapter TEXT, knowledge_points TEXT,
  content TEXT NOT NULL,
  answer TEXT,
  analysis TEXT,
  images TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE question_tags (
  question_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  color TEXT,
  PRIMARY KEY (question_id, tag)
);
CREATE TABLE papers (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE paper_questions (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  score REAL,
  frozen INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE paper_snapshots (
  paper_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  content_snapshot TEXT NOT NULL
);
CREATE TABLE operation_log (
  id TEXT PRIMARY KEY,
  operation_type TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('started','succeeded','failed')),
  affected_count INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_questions_subject ON questions(subject);
CREATE INDEX idx_paper_questions_paper ON paper_questions(paper_id, position);
CREATE INDEX idx_operation_log_started ON operation_log(started_at);
