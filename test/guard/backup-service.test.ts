// Phase 1 测试：backup-service.ts
// P1-3：guard 测试 setup 改用真实 migrations（new Database + Database.runMigrations(realMigrationsDir)），
//       禁手写 CREATE TABLE；backup 操作留痕断言打在真实 schema 上。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Database } from '../../src/bank/db.js';
import { createBackup } from '../../src/guard/backup/backup-service.js';
import { readZip } from '../../src/guard/zip-utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const realMigrationsDir = join(__dirname, '../../src/bank/migrations');

/** 用仓库真实迁移（src/bank/migrations）创建真实 schema 的数据库 */
function createRealDb(path: string): Database {
  const db = new Database(path);
  Database.runMigrations(db, realMigrationsDir);
  return db;
}

/** 插入网络题（真实列名；source_detail 为合法网络 JSON） */
function insertNetworkQuestion(db: Database, id: string, deleted = 0): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO questions (id, subject, source_type, source_detail, content, answer, images, created_at, updated_at, deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    '数学',
    'network',
    JSON.stringify({ site: 'jyeoo', url: `https://jyeoo.com/${id}`, questionId: id, collectedAt: now }),
    '<div class="question">1+1=?</div>',
    '<div>2</div>',
    '[]',
    now,
    now,
    deleted
  );
}

function insertPaper(db: Database, id: string): void {
  const now = new Date().toISOString();
  db.prepare('INSERT INTO papers (id, title, config, created_at, archived) VALUES (?, ?, ?, ?, ?)').run(id, '测试试卷', '{}', now, 0);
}

describe('backup-service', () => {
  let testDir: string;
  let dataDir: string;
  let db: Database;

  beforeEach(() => {
    // 创建临时测试目录
    testDir = join(tmpdir(), `mofang-test-backup-${Date.now()}`);
    dataDir = join(testDir, 'data');
    mkdirSync(dataDir, { recursive: true });

    // 真实 schema 测试数据库
    const dbPath = join(dataDir, 'bank.db');
    db = createRealDb(dbPath);
  });

  afterEach(() => {
    if (db) {
      try {
        db.close();
      } catch {
        // 数据库可能已关闭
      }
    }
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should create a valid backup with empty database', async () => {
    const backupPath = join(testDir, 'backup.mofang-backup.zip');

    const result = await createBackup(db, dataDir, backupPath, '0.0.0-test');

    expect(result.success).toBe(true);
    expect(result.backupPath).toBe(backupPath);
    expect(result.manifest).toBeDefined();
    expect(result.manifest?.format).toBe('mofang-assistant-backup');
    expect(result.manifest?.format_version).toBe(1);
    expect(result.manifest?.counts.questions).toBe(0);
    expect(result.manifest?.counts.papers).toBe(0);
    expect(existsSync(backupPath)).toBe(true);
  });

  it('should include database and manifest in backup', async () => {
    const backupPath = join(testDir, 'backup.mofang-backup.zip');

    await createBackup(db, dataDir, backupPath, '0.0.0-test');

    // 读取 ZIP 并检查内容
    const entries = readZip(backupPath);
    const paths = entries.map(e => e.path);

    expect(paths).toContain('manifest.json');
    expect(paths).toContain('db/mofang.sqlite');

    // 检查 manifest
    const manifestEntry = entries.find(e => e.path === 'manifest.json');
    const manifest = JSON.parse(manifestEntry!.content.toString('utf8'));

    expect(manifest.format).toBe('mofang-assistant-backup');
    // 迁移版本联动：…0012_recog_runs→v9、0013_paper_folders→v10、0014_paper_type_check→v11、
    // 0010_feedback_records→v12、0015_recog_image_assets→v13、0016_feedback_prompt_tune→v14、
    // 0017_question_stage→v15（0028/0044/0048/0030/0057/0059/0062 任务书授权测试联动）；
    // 并与库内实际 user_version 联动，防两处各写各的
    expect(manifest.schema_version).toBe(db.getUserVersion());
    expect(manifest.schema_version).toBe(15);
  });

  it('should backup database with questions and papers and record operation_log', async () => {
    insertNetworkQuestion(db, 'q1');
    insertNetworkQuestion(db, 'q2');
    insertPaper(db, 'p1');

    const backupPath = join(testDir, 'backup.mofang-backup.zip');
    const result = await createBackup(db, dataDir, backupPath, '0.0.0-test');

    expect(result.success).toBe(true);
    expect(result.manifest?.counts.questions).toBe(2);
    expect(result.manifest?.counts.papers).toBe(1);

    // P1-3/P0-1：备份成功后写 operation_log（真实 schema，同一 db 实例）
    const backupLog = db.prepare(
      `SELECT * FROM operation_log WHERE operation_type = 'backup'`
    ).get() as any;
    expect(backupLog).toBeDefined();
    expect(backupLog.status).toBe('succeeded');
    expect(backupLog.affected_count).toBe(3); // 2 questions + 1 paper
    expect(backupLog.description).toContain('questions=2');
    expect(backupLog.metadata_json).toContain('backup_path');

    // 验证备份的数据库可以独立打开
    const entries = readZip(backupPath);
    const dbEntry = entries.find(e => e.path === 'db/mofang.sqlite');
    expect(dbEntry).toBeDefined();

    const tempDbPath = join(testDir, 'restored.db');
    writeFileSync(tempDbPath, dbEntry!.content);

    const restoredDb = new Database(tempDbPath);
    const integrityResult = restoredDb.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    expect(integrityResult.integrity_check).toBe('ok');

    const questionCount = restoredDb.prepare('SELECT COUNT(*) as count FROM questions WHERE deleted = 0').get() as { count: number };
    expect(questionCount.count).toBe(2);

    restoredDb.close();
  });

  it('should include assets in backup', async () => {
    // 创建测试资产文件
    const assetsDir = join(dataDir, 'assets', 'capture', 'jyeoo');
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, 'test-image.png'), Buffer.from('fake image data'));

    const backupPath = join(testDir, 'backup.mofang-backup.zip');
    const result = await createBackup(db, dataDir, backupPath, '0.0.0-test');

    expect(result.success).toBe(true);
    expect(result.manifest?.counts.assets).toBe(1);

    const entries = readZip(backupPath);
    const assetEntry = entries.find(e => e.path === 'files/assets/capture/jyeoo/test-image.png');
    expect(assetEntry).toBeDefined();
    expect(assetEntry!.content.toString()).toBe('fake image data');
  });

  it('should exclude deleted questions from count', async () => {
    insertNetworkQuestion(db, 'q1');
    insertNetworkQuestion(db, 'q2', 1); // deleted

    const backupPath = join(testDir, 'backup.mofang-backup.zip');
    const result = await createBackup(db, dataDir, backupPath, '0.0.0-test');

    expect(result.success).toBe(true);
    expect(result.manifest?.counts.questions).toBe(1); // 只计数 deleted=0
  });

  it('should fail gracefully, clean up and record failed operation_log', async () => {
    const backupPath = '/invalid/path/backup.zip';

    const result = await createBackup(db, dataDir, backupPath, '0.0.0-test');

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(existsSync(backupPath + '.tmp')).toBe(false); // 临时文件应被清理

    // P0-1：失败也写 operation_log（status='failed'，真实 schema）
    const failedLog = db.prepare(
      `SELECT * FROM operation_log WHERE operation_type = 'backup'`
    ).get() as any;
    expect(failedLog).toBeDefined();
    expect(failedLog.status).toBe('failed');
  });
});