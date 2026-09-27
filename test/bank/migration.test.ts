// Phase 3: 迁移测试（仅真实实现）— 幂等性、事务回滚
// 0002：空库顺序应用 0001+0002 + schema 校验（开发库整体重置，无存量数据搬运）
// 0048：补「v10 库升 v11」的带数据搬运断言（createV10Database 造现场，见文件末 0048 段）
// 0030：迁移序列再顺延一格——文件名 0010_feedback_records.sql 运行时 version=12（版本天花板断言联动）
// 0057：再顺延一格——文件名 0015_recog_image_assets.sql（口径占位，无结构变更）运行时 version=13
// 0059：再顺延一格——文件名 0016_feedback_prompt_tune.sql（内置提示词换代 UPDATE×2+INSERT×2）运行时 version=14
// 0062：再顺延一格——文件名 0017_question_stage.sql（questions 加回 stage 列）运行时 version=15
//（0062 翻案 B2：0002 删掉的 stage 列加回，采集链学段筛选靠它；见 0062 任务书 §一.1）

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { Database, openDatabase } from '../../src/bank/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '../../src/bank/migrations');

function tableNames(db: Database): string[] {
  return (db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' ORDER BY name
  `).all() as Array<{ name: string }>).map(t => t.name);
}

function columnNames(db: Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name);
}

function indexNames(db: Database): string[] {
  return (db.prepare(`
    SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name
  `).all() as Array<{ name: string }>).map(i => i.name);
}

/** papers 建表语句（重建后以 "papers" 名落库；CHECK 约束只此一处可查） */
function tableSql(db: Database, table: string): string {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name = ?`).get(table) as
    | { sql: string }
    | undefined;
  if (!row) throw new Error(`table ${table} not found`);
  return row.sql.replace(/\s+/g, ' ').trim();
}

/**
 * 构造 v10 现场（0048 搬运测试用）：按执行器口径顺序应用 0001…0013 各文件一事务，
 * 末尾锚 user_version=10——迁移号与文件序号在 0011 之后错位（0012→v9 / 0013→v10），
 * 不按文件序号写版本。0013 整表重建，故同执行器在事务外包裹外键 OFF/ON。
 */
function createV10Database(path: string): Database {
  const files = readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  const lastIndex = files.indexOf('0013_paper_folders.sql');
  if (lastIndex < 0) throw new Error('0013_paper_folders.sql not found in migrations dir');

  // 0030：0010_feedback_records.sql 的文件名序号排在 0012 之前，但运行时版本是 12（v10 之后）——
  // 造 v10 现场必须剔除它，否则「v10 库」凭空多出两张当时不存在的表，搬运断言的前提失真。
  const appliedFiles = files.slice(0, lastIndex + 1).filter(f => f !== '0010_feedback_records.sql');

  const db = new Database(path);
  db.exec('PRAGMA foreign_keys = OFF;');
  try {
    for (const file of appliedFiles) {
      db.transaction(() => {
        db.exec(readFileSync(join(migrationsDir, file), 'utf8'));
      });
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }
  db.setUserVersion(10);
  return db;
}

describe('Migration Tests (Real SQLite only)', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'migration-test-'));
    dbPath = join(tempDir, 'test.db');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('空库顺序应用 0001…0014 + 0010 + 0015 + 0016 + 0017，user_version=15', () => {
    const db = openDatabase(dbPath, migrationsDir);

    expect(db.getUserVersion()).toBe(15);

    const tables = tableNames(db);
    // 0001 基线
    expect(tables).toContain('questions');
    expect(tables).toContain('papers');
    expect(tables).toContain('paper_questions');
    expect(tables).toContain('paper_snapshots');
    expect(tables).toContain('operation_log');
    // 0002 新表
    expect(tables).toContain('dict_entries');
    expect(tables).toContain('trees');
    expect(tables).toContain('tree_nodes');
    expect(tables).toContain('question_node_links');
    expect(tables).toContain('tree_source_map');
    expect(tables).toContain('students');
    expect(tables).toContain('classes');
    expect(tables).toContain('student_classes');
    expect(tables).toContain('student_events');
    expect(tables).toContain('exams');
    expect(tables).toContain('mistakes');
    expect(tables).toContain('exam_scores');
    expect(tables).toContain('paper_sets');
    expect(tables).toContain('paper_set_papers');
    expect(tables).toContain('layout_presets');
    // 0005 课后反馈
    expect(tables).toContain('feedback_templates');
    // 0023 模型档案
    expect(tables).toContain('model_profiles');
    // 0028 识别 run 基建
    expect(tables).toContain('recog_runs');
    expect(tables).toContain('recog_run_pages');
    // 0044 试卷文件夹（papers 表重建后新表与新列见下方专项断言）
    expect(tables).toContain('paper_folders');
    // 0030 反馈模块一期（迁移 0010 / 运行时 v12）；0057 口径占位迁移 0015 / 运行时 v13 不改结构
    expect(tables).toContain('feedback_records');
    expect(tables).toContain('feedback_prompt_templates');

    // 0048 迁移 0014 重建后：papers 十列与列序不动 + 建表语句整体等于 0014 定稿（含两处 CHECK）
    expect(columnNames(db, 'papers')).toEqual([
      'id', 'title', 'config', 'created_at', 'archived', 'status', 'paper_type',
      'layout_config_json', 'folder_id', 'trashed_from',
    ]);
    expect(tableSql(db, 'papers')).toBe(
      'CREATE TABLE "papers" ( id TEXT PRIMARY KEY, title TEXT NOT NULL, config TEXT NOT NULL DEFAULT \'{}\', '
      + 'created_at TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, '
      + "status TEXT NOT NULL DEFAULT 'basket' CHECK (status IN ('basket','composing','done','archived','trashed')), "
      + "paper_type TEXT NOT NULL DEFAULT 'uniform' CHECK (paper_type IN ('uniform','custom-mistake')), "
      + 'layout_config_json TEXT, folder_id TEXT, trashed_from TEXT )',
    );

    db.close();
  });

  // ==================== 0023（模型配置体系） ====================

  it('0023：model_profiles 表结构 + role CHECK + protocol 默认值 + 角色索引', () => {
    const db = openDatabase(dbPath, migrationsDir);

    const cols = columnNames(db, 'model_profiles');
    expect(cols).toEqual([
      'id', 'role', 'name', 'provider', 'protocol', 'base_url', 'model',
      'key_encrypted', 'capability', 'is_enabled', 'last_test_at', 'last_test_ok',
      'created_at', 'updated_at',
    ]);

    const now = '2026-01-01T00:00:00Z';
    db.prepare(`
      INSERT INTO model_profiles (id, role, name, provider, base_url, model, created_at, updated_at)
      VALUES ('mp1', 'reasoning', '档案A', 'siliconflow', 'https://api.example.com/v1', 'test-model', ?, ?)
    `).run(now, now);
    const row = db.prepare(
      `SELECT protocol, is_enabled, key_encrypted, capability FROM model_profiles WHERE id = 'mp1'`,
    ).get() as { protocol: string; is_enabled: number; key_encrypted: string | null; capability: string | null };
    // protocol 缺省 openai-chat；is_enabled 缺省 0；key/capability 可空
    expect(row.protocol).toBe('openai-chat');
    expect(row.is_enabled).toBe(0);
    expect(row.key_encrypted).toBeNull();
    expect(row.capability).toBeNull();

    // role CHECK：五角色之外被 DDL 拦截
    expect(() => {
      db.prepare(`
        INSERT INTO model_profiles (id, role, name, provider, base_url, model, created_at, updated_at)
        VALUES ('mp-bad', 'chat', 'x', 'p', 'https://x/v1', 'm', ?, ?)
      `).run(now, now);
    }).toThrow(/CHECK constraint failed/);

    // 角色索引（0023 P1：角色维度查询/启用排他）
    expect(indexNames(db)).toContain('idx_model_profiles_role');

    db.close();
  });

  it('questions 加列与弃列（G1/G2/B2）', () => {
    const db = openDatabase(dbPath, migrationsDir);

    const cols = columnNames(db, 'questions');
    expect(cols).toContain('stem_html');
    expect(cols).toContain('options_json');
    expect(cols).toContain('subject_id');
    expect(cols).toContain('type_id');
    expect(cols).toContain('difficulty_id');
    // 弃字段（并入树/字典）已删；stage 属 0062（R-066/D-076②）翻案 B2 加回——0002 删、0017 加，
    // 故此处断言它在（与 grade/textbook/version/chapter 四个仍删除的字段区分）
    expect(cols).not.toContain('grade');
    expect(cols).toContain('stage');
    expect(cols).not.toContain('textbook');
    expect(cols).not.toContain('version');
    expect(cols).not.toContain('chapter');

    db.close();
  });

  it('papers 加列：status 默认 basket + paper_type 默认 uniform + layout_config_json', () => {
    const db = openDatabase(dbPath, migrationsDir);

    const cols = columnNames(db, 'papers');
    expect(cols).toContain('status');
    expect(cols).toContain('paper_type');
    expect(cols).toContain('layout_config_json');

    db.prepare(`INSERT INTO papers (id, title, created_at) VALUES ('p1', '测试卷', '2026-01-01T00:00:00Z')`).run();
    const row = db.prepare(`SELECT status, paper_type, layout_config_json FROM papers WHERE id = 'p1'`).get() as any;
    expect(row.status).toBe('basket');
    expect(row.paper_type).toBe('uniform');
    expect(row.layout_config_json).toBeNull();

    db.close();
  });

  // ==================== 0003（0004 试题篮扩展） ====================

  it('0003：paper_questions 加 layout_json 列（题级图排版覆盖，Phase 5 接线读写）', () => {
    const db = openDatabase(dbPath, migrationsDir);

    const cols = columnNames(db, 'paper_questions');
    expect(cols).toContain('layout_json');

    db.prepare(`
      INSERT INTO questions (id, subject, source_type, source_detail, content, images, created_at, updated_at)
      VALUES ('q1', '物理', 'local', '{"origin":"manual"}', '<div>题</div>', '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
    `).run();
    db.prepare(`INSERT INTO papers (id, title, created_at) VALUES ('p1', '卷', '2026-01-01T00:00:00Z')`).run();
    db.prepare(`
      INSERT INTO paper_questions (id, paper_id, question_id, position, frozen, layout_json)
      VALUES ('pq1', 'p1', 'q1', 0, 0, '{"figures":[]}')
    `).run();
    const row = db.prepare(`SELECT layout_json FROM paper_questions WHERE id = 'pq1'`).get() as any;
    expect(row.layout_json).toBe('{"figures":[]}');

    db.close();
  });

  it('0006：paper_questions 加 kind/text_body/style 列（大标题=文本内容块，不占题号）', () => {
    const db = openDatabase(dbPath, migrationsDir);

    const cols = columnNames(db, 'paper_questions');
    expect(cols).toContain('kind');
    expect(cols).toContain('text_body');
    expect(cols).toContain('style');

    db.prepare(`INSERT INTO papers (id, title, created_at) VALUES ('p1', '卷', '2026-01-01T00:00:00Z')`).run();
    db.prepare(`
      INSERT INTO paper_questions (id, paper_id, question_id, position, frozen, kind, text_body, style)
      VALUES ('pq-text', 'p1', 'text:t1', 0, 0, 'text', '一、单项选择题', 'section')
    `).run();
    const row = db.prepare(`SELECT kind, text_body, style FROM paper_questions WHERE id = 'pq-text'`).get() as any;
    expect(row.kind).toBe('text');
    expect(row.text_body).toBe('一、单项选择题');
    expect(row.style).toBe('section');

    db.close();
  });

  it('0003+0004：内置预设种子 A3双列/A4 落库（含 orientation）+ 幂等（重开不重复）', () => {
    const db = openDatabase(dbPath, migrationsDir);

    const rows = db.prepare(`
      SELECT name, config_json, is_builtin FROM layout_presets WHERE is_builtin = 1 ORDER BY name
    `).all() as Array<{ name: string; config_json: string; is_builtin: number }>;

    const a3 = rows.find(r => r.name === 'A3双列');
    const a4 = rows.find(r => r.name === 'A4');
    expect(a3).toBeDefined();
    expect(a4).toBeDefined();
    // 0003 种子 + 0004_a3_landscape UPDATE（fix-2 F2-A：A3双列=landscape / A4 显式 portrait）
    expect(JSON.parse(a3!.config_json)).toEqual({
      version: 2, pageSize: 'A3', orientation: 'landscape', columns: 2, columnGapMm: 8, fontSize: 12, lineHeight: 1.5, header: { style: 'exam' },
    });
    expect(JSON.parse(a4!.config_json)).toEqual({
      version: 2, pageSize: 'A4', orientation: 'portrait', columns: 1, fontSize: 12, lineHeight: 1.5, header: { style: 'exam' },
    });
    expect(rows.filter(r => r.name === 'A3双列').length).toBe(1);
    expect(rows.filter(r => r.name === 'A4').length).toBe(1);

    db.close();

    // 重开：种子幂等，不产生重复内置行
    const db2 = openDatabase(dbPath, migrationsDir);
    const again = db2.prepare(`
      SELECT COUNT(*) as cnt FROM layout_presets WHERE is_builtin = 1
    `).get() as { cnt: number };
    expect(again.cnt).toBe(2);
    db2.close();
  });

  it('0005：feedback_templates 表 + 内置默认课后反馈模板种子（幂等重开不重复）', () => {
    const db = openDatabase(dbPath, migrationsDir);

    const rows = db.prepare(`
      SELECT id, name, body_template, is_builtin FROM feedback_templates WHERE is_builtin = 1
    `).all() as Array<{ id: string; name: string; body_template: string; is_builtin: number }>;
    const builtin = rows.find(r => r.name === '默认课后反馈');
    expect(builtin).toBeDefined();
    expect(builtin!.id).toBe('feedback-tpl-builtin-default');
    expect(builtin!.body_template).toContain('{学生姓名}');
    expect(builtin!.body_template).toContain('{本次内容}');

    db.close();

    // 重开：种子幂等，不产生重复内置行
    const db2 = openDatabase(dbPath, migrationsDir);
    const again = db2.prepare(`
      SELECT COUNT(*) as cnt FROM feedback_templates WHERE is_builtin = 1
    `).get() as { cnt: number };
    expect(again.cnt).toBe(1);
    db2.close();
  });

  it('重复启动不重复执行迁移', () => {
    // 首次初始化
    const db1 = openDatabase(dbPath, migrationsDir);
    expect(db1.getUserVersion()).toBe(15);

    // 插入测试数据（0002 后的列结构）
    db1.prepare(`
      INSERT INTO questions (
        id, subject, source_type, source_detail, content, images, stem_html, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('test-q1', '数学', 'local', '{"file":"test.json"}', '<div class="question">测试</div>', '[]', '<div class="question">测试</div>', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');

    const countBefore = db1.prepare('SELECT COUNT(*) as cnt FROM questions').get() as { cnt: number };
    expect(countBefore.cnt).toBe(1);

    db1.close();

    // 重新打开，不应重复执行迁移
    const db2 = openDatabase(dbPath, migrationsDir);
    expect(db2.getUserVersion()).toBe(15);

    const countAfter = db2.prepare('SELECT COUNT(*) as cnt FROM questions').get() as { cnt: number };
    expect(countAfter.cnt).toBe(1); // 数据未被清除，说明迁移未重复执行

    db2.close();
  });

  it('损坏迁移时事务回滚且版本不变（0001 已提交、0002 整体回滚）', () => {
    const badMigrationsDir = mkdtempSync(join(tmpdir(), 'bad-migrations-'));
    writeFileSync(join(badMigrationsDir, '0001_initial.sql'),
      readFileSync(join(migrationsDir, '0001_initial.sql'), 'utf8'));
    writeFileSync(join(badMigrationsDir, '0002_broken.sql'),
      'CREATE TABLE test_table (id TEXT PRIMARY KEY);\nTHIS IS INVALID SQL SYNTAX;');

    const db = new Database(dbPath);
    expect(() => Database.runMigrations(db, badMigrationsDir)).toThrow();
    // 0001 已提交生效
    expect(db.getUserVersion()).toBe(1);
    expect(tableNames(db)).toContain('questions');
    // 0002 已回滚：新表与 test_table 都不存在
    expect(tableNames(db)).not.toContain('test_table');
    expect(tableNames(db)).not.toContain('dict_entries');

    db.close();
    rmSync(badMigrationsDir, { recursive: true, force: true });
  });

  it('迁移创建所有必需的索引', () => {
    const db = openDatabase(dbPath, migrationsDir);

    const indices = indexNames(db);
    // 0001
    expect(indices).toContain('idx_questions_subject');
    expect(indices).toContain('idx_paper_questions_paper');
    expect(indices).toContain('idx_operation_log_started');
    // 0002
    expect(indices).toContain('idx_tree_nodes_tree');
    expect(indices).toContain('idx_tree_nodes_parent');
    expect(indices).toContain('idx_question_node_links_node');
    expect(indices).toContain('idx_student_classes_class');
    expect(indices).toContain('idx_student_events_student_time');
    expect(indices).toContain('idx_mistakes_student');
    expect(indices).toContain('idx_mistakes_question');
    expect(indices).toContain('idx_exam_scores_student');
    expect(indices).toContain('idx_questions_subject_id');
    expect(indices).toContain('idx_papers_status');
    // 归一行 (kind,code) 部分唯一索引
    expect(indices).toContain('uq_dict_normalized_code');
    // 0028 run 索引
    expect(indices).toContain('idx_recog_runs_status');
    expect(indices).toContain('idx_recog_runs_created');
    expect(indices).toContain('idx_recog_run_pages_run');

    db.close();
  });

  it('questions 表约束生效：source_type 只能是 network 或 local', () => {
    const db = openDatabase(dbPath, migrationsDir);

    expect(() => {
      db.prepare(`
        INSERT INTO questions (
          id, subject, source_type, source_detail, content, images, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('q1', '数学', 'invalid_type', '{"test":1}', '<div>test</div>', '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    }).toThrow(/CHECK constraint failed/);

    db.close();
  });

  it('operation_log 表约束生效：status 只能是 started/succeeded/failed', () => {
    const db = openDatabase(dbPath, migrationsDir);

    expect(() => {
      db.prepare(`
        INSERT INTO operation_log (id, operation_type, started_at, status, description)
        VALUES (?, ?, ?, ?, ?)
      `).run('log1', 'test', '2026-01-01T00:00:00Z', 'invalid_status', 'test');
    }).toThrow(/CHECK constraint failed/);

    db.close();
  });

  it('papers.status CHECK 约束生效', () => {
    const db = openDatabase(dbPath, migrationsDir);

    db.prepare(`INSERT INTO papers (id, title, created_at) VALUES ('p1', '合法卷', '2026-01-01T00:00:00Z')`).run();
    expect(() => {
      db.prepare(`UPDATE papers SET status = 'invalid' WHERE id = 'p1'`).run();
    }).toThrow(/CHECK constraint failed/);

    db.close();
  });

  it('mistakes 约束：stage CHECK + (question_id, student_id) 全局唯一（拍板 §6-1）', () => {
    const db = openDatabase(dbPath, migrationsDir);
    const now = '2026-01-01T00:00:00Z';

    db.prepare(`
      INSERT INTO questions (id, subject, source_type, source_detail, content, images, created_at, updated_at)
      VALUES ('q1', '物理', 'local', '{"origin":"manual"}', '<div>题</div>', '[]', ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO students (id, name, status, created_at, updated_at)
      VALUES ('s1', '张三', 'active', ?, ?)
    `).run(now, now);

    db.prepare(`
      INSERT INTO mistakes (id, question_id, student_id, occurred_at, stage, snapshot_json, created_at, updated_at)
      VALUES ('m1', 'q1', 's1', ?, 'red', '{}', ?, ?)
    `).run(now, now, now);

    // 全局唯一：同 (question_id, student_id) 二次插入被 DDL 拦截
    expect(() => {
      db.prepare(`
        INSERT INTO mistakes (id, question_id, student_id, occurred_at, stage, snapshot_json, created_at, updated_at)
        VALUES ('m2', 'q1', 's1', ?, 'red', '{}', ?, ?)
      `).run(now, now, now);
    }).toThrow(/UNIQUE constraint failed/);

    // stage CHECK
    expect(() => {
      db.prepare(`
        INSERT INTO mistakes (id, question_id, student_id, occurred_at, stage, snapshot_json, created_at, updated_at)
        VALUES ('m3', 'q1', 's1', ?, 'blue', '{}', ?, ?)
      `).run(now, now, now);
    }).toThrow(/CHECK constraint failed/);

    db.close();
  });

  it('exam_scores (exam_id, student_id) 唯一（U14）', () => {
    const db = openDatabase(dbPath, migrationsDir);
    const now = '2026-01-01T00:00:00Z';

    db.prepare(`INSERT INTO exams (id, title, occurred_at, created_at) VALUES ('e1', '期中考试', ?, ?)`).run(now, now);
    db.prepare(`
      INSERT INTO students (id, name, status, created_at, updated_at)
      VALUES ('s1', '张三', 'active', ?, ?)
    `).run(now, now);

    db.prepare(`
      INSERT INTO exam_scores (id, exam_id, student_id, created_at, updated_at)
      VALUES ('sc1', 'e1', 's1', ?, ?)
    `).run(now, now);
    expect(() => {
      db.prepare(`
        INSERT INTO exam_scores (id, exam_id, student_id, created_at, updated_at)
        VALUES ('sc2', 'e1', 's1', ?, ?)
      `).run(now, now);
    }).toThrow(/UNIQUE constraint failed/);

    db.close();
  });

  it('dict_entries 约束：kind CHECK + 站点行唯一 + 归一行部分唯一索引', () => {
    const db = openDatabase(dbPath, migrationsDir);
    const now = '2026-01-01T00:00:00Z';

    db.prepare(`
      INSERT INTO dict_entries (id, kind, code, label, site, source_label, active)
      VALUES ('subj:physics', 'subject', 'physics', '物理', NULL, NULL, 1)
    `).run();

    // 归一行同 (kind, code) 被部分唯一索引拦截
    expect(() => {
      db.prepare(`
        INSERT INTO dict_entries (id, kind, code, label, site, source_label, active)
        VALUES ('subj:physics2', 'subject', 'physics', '物理学', NULL, NULL, 1)
      `).run();
    }).toThrow(/UNIQUE constraint failed/);

    // 站点同义行与归一行共用标准 code：允许
    db.prepare(`
      INSERT INTO dict_entries (id, kind, code, label, site, source_label, active)
      VALUES ('subj:jyeoo:物理', 'subject', 'physics', '物理', 'jyeoo', '物理', 1)
    `).run();

    // 站点行 (kind, site, source_label) 唯一
    expect(() => {
      db.prepare(`
        INSERT INTO dict_entries (id, kind, code, label, site, source_label, active)
        VALUES ('subj:jyeoo:物理2', 'subject', 'physics', '物理', 'jyeoo', '物理', 1)
      `).run();
    }).toThrow(/UNIQUE constraint failed/);

    // kind CHECK
    expect(() => {
      db.prepare(`
        INSERT INTO dict_entries (id, kind, code, label, active)
        VALUES ('x:1', 'grade', 'g1', '高一', 1)
      `).run();
    }).toThrow(/CHECK constraint failed/);

    void now;
    db.close();
  });

  it('questions.subject_id 外键生效（字典 FK）', () => {
    const db = openDatabase(dbPath, migrationsDir);
    const now = '2026-01-01T00:00:00Z';

    expect(() => {
      db.prepare(`
        INSERT INTO questions (id, subject, subject_id, source_type, source_detail, content, images, created_at, updated_at)
        VALUES ('q1', '物理', 'subj:nonexistent', 'local', '{"origin":"manual"}', '<div>题</div>', '[]', ?, ?)
      `).run(now, now);
    }).toThrow(/FOREIGN KEY constraint failed/);

    db.close();
  });

  it('students.status / classes.status CHECK 约束生效', () => {
    const db = openDatabase(dbPath, migrationsDir);
    const now = '2026-01-01T00:00:00Z';

    expect(() => {
      db.prepare(`
        INSERT INTO students (id, name, status, created_at, updated_at)
        VALUES ('s1', '张三', 'deleted', ?, ?)
      `).run(now, now);
    }).toThrow(/CHECK constraint failed/);

    expect(() => {
      db.prepare(`
        INSERT INTO classes (id, name, status, created_at)
        VALUES ('c1', '一班', 'archived', ?)
      `).run(now);
    }).toThrow(/CHECK constraint failed/);

    db.close();
  });

  // ==================== 0048（0014 paper_type CHECK 恢复） ====================

  it('0048 / 0014：paper_type 越界值被拒（0013 丢失的 CHECK 已补回），status CHECK 含 trashed 不回归', () => {
    const db = openDatabase(dbPath, migrationsDir);

    const now = '2026-09-21T00:00:00Z';
    // 缺省值 + 两个合法值均放行
    db.prepare(`INSERT INTO papers (id, title, created_at) VALUES ('p-ok', '合法卷', ?)`).run(now);
    expect((db.prepare(`SELECT paper_type FROM papers WHERE id = 'p-ok'`).get() as { paper_type: string }).paper_type)
      .toBe('uniform');
    db.prepare(`INSERT INTO papers (id, title, created_at, paper_type) VALUES ('p-custom', '错题卷', ?, 'custom-mistake')`).run(now);
    expect((db.prepare(`SELECT paper_type FROM papers WHERE id = 'p-custom'`).get() as { paper_type: string }).paper_type)
      .toBe('custom-mistake');

    // 0013 重建时丢掉的 CHECK：越界值 INSERT / UPDATE 都被 DDL 拦回
    expect(() => {
      db.prepare(`INSERT INTO papers (id, title, created_at, paper_type) VALUES ('p-bad', '越界卷', ?, 'bogus')`).run(now);
    }).toThrow(/CHECK constraint failed/);
    expect(() => {
      db.prepare(`UPDATE papers SET paper_type = 'bogus' WHERE id = 'p-ok'`).run();
    }).toThrow(/CHECK constraint failed/);

    // status 扩态不回归：trashed 合法（含 trashed_from 同写）、五态之外仍拦
    db.prepare(`UPDATE papers SET status = 'trashed', trashed_from = 'done' WHERE id = 'p-ok'`).run();
    const trashed = db.prepare(`SELECT status, trashed_from FROM papers WHERE id = 'p-ok'`)
      .get() as { status: string; trashed_from: string | null };
    expect(trashed.status).toBe('trashed');
    expect(trashed.trashed_from).toBe('done');
    expect(() => {
      db.prepare(`UPDATE papers SET status = 'invalid' WHERE id = 'p-ok'`).run();
    }).toThrow(/CHECK constraint failed/);

    // 0013 建的两索引随 0014 重建归位（DROP 会带走，必须显式重建）
    expect(indexNames(db)).toContain('idx_papers_status');
    expect(indexNames(db)).toContain('idx_papers_folder');

    // 上述行为发生在 0014 跑完的库上（0062 顺延后 version 天花板=15）
    expect(db.getUserVersion()).toBe(15);

    db.close();
  });

  it('0048 / 0014：真·携带数据迁移——v10 库（folder_id/trashed_from 非空、五种 status）升 v15 后十列逐字段原样', () => {
    const now = '2026-09-21T00:00:00Z';

    // v10 现场：两种 paper_type、五种 status（含 trashed）、folder_id/trashed_from 非空、config/layout 非默认
    const v10 = createV10Database(dbPath);
    expect(v10.getUserVersion()).toBe(10);
    v10.prepare(`INSERT INTO paper_folders (id, name, parent_id, sort, created_at) VALUES ('f-gaoer', '高二物理', NULL, 1, ?)`).run(now);
    v10.prepare(`INSERT INTO paper_folders (id, name, parent_id, sort, created_at) VALUES ('f-wuli', '物理错题', 'f-gaoer', 2, ?)`).run(now);

    const insertV10Paper = `INSERT INTO papers
      (id, title, config, created_at, archived, status, paper_type, layout_config_json, folder_id, trashed_from)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    v10.prepare(insertV10Paper).run('p-basket', '篮中卷', '{"totalScore":100}', now, 0, 'basket', 'uniform', '{"version":2}', null, null);
    v10.prepare(insertV10Paper).run('p-composing', '排版中卷', '{"totalScore":120}', now, 0, 'composing', 'custom-mistake', '{"version":2,"columns":2}', 'f-gaoer', null);
    v10.prepare(insertV10Paper).run('p-done', '已完卷', '{}', now, 1, 'done', 'uniform', null, 'f-wuli', null);
    v10.prepare(insertV10Paper).run('p-archived', '归档卷', '{"note":"x"}', now, 1, 'archived', 'custom-mistake', '{"version":1}', 'f-gaoer', null);
    v10.prepare(insertV10Paper).run('p-trashed', '回收卷', '{}', now, 0, 'trashed', 'uniform', null, null, 'done');

    // 子表行（paper_set_papers 对 papers 有外键、paper_questions 无）：整表重建不得丢行
    v10.prepare(`INSERT INTO paper_sets (id, name, type, batch_meta, created_at) VALUES ('ps1', '高二统一卷', 'uniform', '{}', ?)`).run(now);
    v10.prepare(`INSERT INTO paper_set_papers (paper_set_id, paper_id, student_id) VALUES ('ps1', 'p-done', NULL)`).run();
    v10.prepare(`INSERT INTO paper_questions (id, paper_id, question_id, position, score, frozen) VALUES ('pq1', 'p-done', 'q-x', 0, 5, 1)`).run();
    v10.close();

    // 升 v15：执行器只见 0014 / 0010_feedback_records / 0015 / 0016 / 0017 待跑
    //（0030/0057/0059/0062 顺延），0014 走整表重建 + 十列搬运
    const db = openDatabase(dbPath, migrationsDir);
    expect(db.getUserVersion()).toBe(15);
    // 确认搬运真走了 0014 的整表重建（没重建则建表语句里不会有 paper_type 的 CHECK）
    expect(tableSql(db, 'papers')).toContain("CHECK (paper_type IN ('uniform','custom-mistake'))");

    const rows = db.prepare(`
      SELECT id, title, config, created_at, archived, status, paper_type, layout_config_json, folder_id, trashed_from
      FROM papers ORDER BY id
    `).all();
    expect(rows).toEqual([
      { id: 'p-archived', title: '归档卷', config: '{"note":"x"}', created_at: now, archived: 1, status: 'archived', paper_type: 'custom-mistake', layout_config_json: '{"version":1}', folder_id: 'f-gaoer', trashed_from: null },
      { id: 'p-basket', title: '篮中卷', config: '{"totalScore":100}', created_at: now, archived: 0, status: 'basket', paper_type: 'uniform', layout_config_json: '{"version":2}', folder_id: null, trashed_from: null },
      { id: 'p-composing', title: '排版中卷', config: '{"totalScore":120}', created_at: now, archived: 0, status: 'composing', paper_type: 'custom-mistake', layout_config_json: '{"version":2,"columns":2}', folder_id: 'f-gaoer', trashed_from: null },
      { id: 'p-done', title: '已完卷', config: '{}', created_at: now, archived: 1, status: 'done', paper_type: 'uniform', layout_config_json: null, folder_id: 'f-wuli', trashed_from: null },
      { id: 'p-trashed', title: '回收卷', config: '{}', created_at: now, archived: 0, status: 'trashed', paper_type: 'uniform', layout_config_json: null, folder_id: null, trashed_from: 'done' },
    ]);

    // 行数与子表引用不因重建丢失/悬空
    expect((db.prepare('SELECT COUNT(*) AS cnt FROM papers').get() as { cnt: number }).cnt).toBe(5);
    expect((db.prepare(`SELECT COUNT(*) AS cnt FROM paper_set_papers WHERE paper_id = 'p-done'`).get() as { cnt: number }).cnt).toBe(1);
    expect((db.prepare(`SELECT COUNT(*) AS cnt FROM paper_questions WHERE paper_id = 'p-done'`).get() as { cnt: number }).cnt).toBe(1);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    // 子表外键仍指向重建后的 papers（换名若不达，悬空 paper_id 就插得进去）
    expect(() => {
      db.prepare(`INSERT INTO paper_set_papers (paper_set_id, paper_id, student_id) VALUES ('ps1', 'p-nonexistent', NULL)`).run();
    }).toThrow(/FOREIGN KEY constraint failed/);

    // 搬运后的行仍受恢复的 CHECK 约束
    expect(() => {
      db.prepare(`INSERT INTO papers (id, title, created_at, paper_type) VALUES ('p-bad2', '越界卷', ?, 'bogus')`).run(now);
    }).toThrow(/CHECK constraint failed/);

    db.close();
  });
});
