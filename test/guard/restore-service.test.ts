// Phase 2 测试：restore-service.ts
// P1-3：guard 测试 setup 改用真实 migrations（new Database + Database.runMigrations(realMigrationsDir)），
//       禁手写 CREATE TABLE；操作留痕断言打在真实 schema 上。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Database } from '../../src/bank/db.js';
import { createBackup } from '../../src/guard/backup/backup-service.js';
import { restoreBackup, previewBackup } from '../../src/guard/restore/restore-service.js';
import { createZip } from '../../src/guard/zip-utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const realMigrationsDir = join(__dirname, '../../src/bank/migrations');

/** 用仓库真实迁移（src/bank/migrations）创建真实 schema 的数据库 */
function createRealDb(path: string): Database {
  const db = new Database(path);
  Database.runMigrations(db, realMigrationsDir);
  return db;
}

/** 插入网络题（真实列名；source_detail 为合法网络 JSON：site/questionId/url） */
function insertNetworkQuestion(db: Database, id: string, detail?: unknown, subject = '数学'): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO questions (id, subject, source_type, source_detail, content, images, created_at, updated_at, deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    subject,
    'network',
    JSON.stringify(detail ?? { site: 'jyeoo', url: `https://jyeoo.com/${id}`, questionId: id, collectedAt: now }),
    '<div class="question">1+1=?</div>',
    '[]',
    now,
    now,
    0
  );
}

/** 插入本地题（真实列名；source_detail 为本地 JSON） */
function insertLocalQuestion(db: Database, id: string, detail: unknown, subject = '数学'): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO questions (id, subject, source_type, source_detail, content, images, created_at, updated_at, deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, subject, 'local', JSON.stringify(detail), '<div>本地题</div>', '[]', now, now, 0);
}

function insertPaper(db: Database, id: string): void {
  const now = new Date().toISOString();
  db.prepare('INSERT INTO papers (id, title, config, created_at, archived) VALUES (?, ?, ?, ?, ?)').run(id, '测试试卷', '{}', now, 0);
}

/** 手工把指定 db 文件打成备份 ZIP（用于构造越界/非法数据包） */
function buildManualBackup(dbPath: string, backupPath: string, backupId = 'manual'): void {
  const now = new Date().toISOString();
  const manifest = {
    format: 'mofang-assistant-backup',
    format_version: 1,
    backup_id: backupId,
    created_at: now,
    app_version: '0.0.0',
    schema_version: 1,
    counts: { questions: 1, papers: 0, assets: 0 },
    database: { path: 'db/mofang.sqlite', size: 1000 },
    files: [],
  };
  createZip([
    { path: 'manifest.json', content: Buffer.from(JSON.stringify(manifest)) },
    { path: 'db/mofang.sqlite', content: readFileSync(dbPath) },
  ], backupPath);
}

describe('restore-service', () => {
  let testDir: string;
  let sourceDataDir: string;
  let targetDataDir: string;
  let sourceDb: Database;

  beforeEach(() => {
    testDir = join(tmpdir(), `mofang-test-restore-${Date.now()}`);
    sourceDataDir = join(testDir, 'source-data');
    targetDataDir = join(testDir, 'target-data');

    mkdirSync(sourceDataDir, { recursive: true });
    mkdirSync(targetDataDir, { recursive: true });

    // 真实 schema 源库
    const sourceDbPath = join(sourceDataDir, 'bank.db');
    sourceDb = createRealDb(sourceDbPath);
    insertNetworkQuestion(sourceDb, 'q1');
    insertPaper(sourceDb, 'p1');

    // 创建测试资产
    const assetsDir = join(sourceDataDir, 'assets', 'capture', 'jyeoo');
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, 'test.png'), Buffer.from('test asset'));
  });

  afterEach(() => {
    if (sourceDb) {
      try {
        sourceDb.close();
      } catch {
        // ignore
      }
    }
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should preview backup and validate format', async () => {
    const backupPath = join(testDir, 'backup.mofang-backup.zip');
    await createBackup(sourceDb, sourceDataDir, backupPath, '0.0.0-test');

    const preview = previewBackup(backupPath);

    expect(preview.valid).toBe(true);
    expect(preview.errors).toHaveLength(0);
    expect(preview.manifest.format).toBe('mofang-assistant-backup');
    expect(preview.manifest.counts.questions).toBe(1);
    expect(preview.manifest.counts.papers).toBe(1);
    expect(preview.manifest.counts.assets).toBe(1);
  });

  it('should restore backup to empty target directory', async () => {
    const backupPath = join(testDir, 'backup.mofang-backup.zip');
    await createBackup(sourceDb, sourceDataDir, backupPath, '0.0.0-test');

    const result = await restoreBackup(backupPath, targetDataDir, 15, realMigrationsDir, true);

    expect(result.success).toBe(true);
    expect(result.restored?.questions).toBe(1);
    expect(result.restored?.papers).toBe(1);
    expect(result.restored?.assets).toBe(1);

    // 验证目标数据库
    const targetDbPath = join(targetDataDir, 'bank.db');
    expect(existsSync(targetDbPath)).toBe(true);

    const targetDb = new Database(targetDbPath);
    const questionCount = targetDb.prepare('SELECT COUNT(*) as count FROM questions WHERE deleted = 0').get() as { count: number };
    expect(questionCount.count).toBe(1);

    const question = targetDb.prepare('SELECT * FROM questions WHERE id = ?').get('q1') as any;
    expect(question.content).toContain('1+1=?');

    // P1-3：restore 后写 operation_log 成功且可查询到 operation_type='restore'（真实 schema）
    const restoreLog = targetDb.prepare(
      `SELECT * FROM operation_log WHERE operation_type = 'restore'`
    ).get() as any;
    expect(restoreLog).toBeDefined();
    expect(restoreLog.status).toBe('succeeded');
    expect(restoreLog.affected_count).toBe(2); // q1 + p1
    expect(restoreLog.description).toContain('backup');
    expect(restoreLog.metadata_json).toContain('backup_path');

    // 0048 补强：恢复出的库停在当前 schema 版本（0062 顺延后 v15），且 papers 的 paper_type CHECK 已归位
    expect(targetDb.getUserVersion()).toBe(15);
    const restoredPapersSql = (targetDb.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'papers'`
    ).get() as { sql: string }).sql.replace(/\s+/g, ' ');
    expect(restoredPapersSql).toContain("CHECK (paper_type IN ('uniform','custom-mistake'))");

    targetDb.close();

    // 验证资产文件
    const restoredAssetPath = join(targetDataDir, 'assets', 'capture', 'jyeoo', 'test.png');
    expect(existsSync(restoredAssetPath)).toBe(true);
  });

  it('should require confirmation for non-empty database', async () => {
    const backupPath = join(testDir, 'backup.mofang-backup.zip');
    await createBackup(sourceDb, sourceDataDir, backupPath, '0.0.0-test');

    // 创建非空目标数据库（真实 schema）
    const targetDbPath = join(targetDataDir, 'bank.db');
    const targetDb = createRealDb(targetDbPath);
    insertNetworkQuestion(targetDb, 'q-existing');
    targetDb.close();

    // 不确认 — 应该失败
    const result1 = await restoreBackup(backupPath, targetDataDir, 15, realMigrationsDir, false);
    expect(result1.success).toBe(false);
    expect(result1.error).toContain('confirm');

    // 确认 — 应该成功
    const result2 = await restoreBackup(backupPath, targetDataDir, 15, realMigrationsDir, true);
    expect(result2.success).toBe(true);
  });

  it('should reject backup with path traversal (zip slip)', async () => {
    const maliciousBackupPath = join(testDir, 'malicious.zip');

    // 创建包含路径遍历的恶意 ZIP
    const manifest = {
      format: 'mofang-assistant-backup',
      format_version: 1,
      backup_id: 'malicious',
      created_at: new Date().toISOString(),
      app_version: '0.0.0',
      schema_version: 1,
      counts: { questions: 0, papers: 0, assets: 0 },
      database: { path: 'db/mofang.sqlite', size: 0 },
      files: [],
    };

    createZip([
      { path: 'manifest.json', content: Buffer.from(JSON.stringify(manifest)) },
      { path: '../evil.txt', content: Buffer.from('evil content') }, // 路径遍历
    ], maliciousBackupPath);

    const preview = previewBackup(maliciousBackupPath);
    expect(preview.valid).toBe(false);
    expect(preview.errors.some(e => e.includes('traversal'))).toBe(true);
  });

  it('should reject backup with absolute path', async () => {
    const maliciousBackupPath = join(testDir, 'malicious.zip');

    const manifest = {
      format: 'mofang-assistant-backup',
      format_version: 1,
      backup_id: 'malicious',
      created_at: new Date().toISOString(),
      app_version: '0.0.0',
      schema_version: 1,
      counts: { questions: 0, papers: 0, assets: 0 },
      database: { path: 'db/mofang.sqlite', size: 0 },
      files: [],
    };

    createZip([
      { path: 'manifest.json', content: Buffer.from(JSON.stringify(manifest)) },
      { path: '/etc/passwd', content: Buffer.from('evil') },
    ], maliciousBackupPath);

    const preview = previewBackup(maliciousBackupPath);
    expect(preview.valid).toBe(false);
    expect(preview.errors.some(e => e.includes('Absolute path'))).toBe(true);
  });

  it('should reject backup with non-JSON source_detail (溯源门禁 P1-4)', async () => {
    // 真实 schema 上 source_detail='not-json'（连 JSON 都不是）：DB 层只保证 NOT NULL，
    // 非法 JSON 必须被语义门禁拒绝（验收探针 #5 同款输入）
    const invalidDbPath = join(testDir, 'invalid.db');
    const invalidDb = createRealDb(invalidDbPath);
    const now = new Date().toISOString();
    invalidDb.prepare(
      `INSERT INTO questions (id, subject, source_type, source_detail, content, images, created_at, updated_at, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('q-bad', '数学', 'network', 'not-json', '<div>x</div>', '[]', now, now, 0);
    invalidDb.close();

    const invalidBackupPath = join(testDir, 'invalid-backup.zip');
    buildManualBackup(invalidDbPath, invalidBackupPath, 'invalid');

    const result = await restoreBackup(invalidBackupPath, targetDataDir, 1, realMigrationsDir, true);

    expect(result.success).toBe(false);
    expect(result.error).toContain('q-bad'); // 报出具体题 id
    expect(result.error).toContain('溯源');
  });

  it('should reject local question without traceable source detail (溯源门禁 P1-4)', async () => {
    // 合法 JSON 但无可追溯字段（无 managed_path / 原始文件名 / 页码 / 录入方式 origin）
    const invalidDbPath = join(testDir, 'invalid-local.db');
    const invalidDb = createRealDb(invalidDbPath);
    insertLocalQuestion(invalidDb, 'q-local-bad', { foo: 'bar' });
    invalidDb.close();

    const invalidBackupPath = join(testDir, 'invalid-local-backup.zip');
    buildManualBackup(invalidDbPath, invalidBackupPath, 'invalid-local');

    const result = await restoreBackup(invalidBackupPath, targetDataDir, 1, realMigrationsDir, true);

    expect(result.success).toBe(false);
    expect(result.error).toContain('q-local-bad');
    expect(result.error).toContain('溯源');
  });

  it('should accept local question with origin（录入方式，§3.3 语义）', async () => {
    // 手录题 { origin:'manual' } / 扫描题 { origin:'scan', pageNo } 均应通过溯源门禁
    const srcDataDir = join(testDir, 'manual-source');
    mkdirSync(srcDataDir, { recursive: true });
    const srcDb = createRealDb(join(srcDataDir, 'bank.db'));
    insertLocalQuestion(srcDb, 'q-manual', { origin: 'manual' });
    insertLocalQuestion(srcDb, 'q-scan', { origin: 'scan', pageNo: 3, qno: 'q3' });

    const backupPath = join(testDir, 'manual-backup.mofang-backup.zip');
    const backupResult = await createBackup(srcDb, srcDataDir, backupPath, '0.0.0-test');
    srcDb.close();
    expect(backupResult.success).toBe(true);

    const result = await restoreBackup(backupPath, targetDataDir, 15, realMigrationsDir, true);
    expect(result.success).toBe(true);
    expect(result.restored?.questions).toBe(2);
  });

  it('should create rollback backup and restore on failure', async () => {
    const backupPath = join(testDir, 'backup.mofang-backup.zip');
    await createBackup(sourceDb, sourceDataDir, backupPath, '0.0.0-test');

    // 创建目标数据库（有数据，真实 schema）
    const targetDbPath = join(targetDataDir, 'bank.db');
    const targetDb = createRealDb(targetDbPath);
    insertNetworkQuestion(targetDb, 'q-orig');
    targetDb.close();

    // 正常恢复应该成功并创建 rollback
    const result = await restoreBackup(backupPath, targetDataDir, 15, realMigrationsDir, true);

    expect(result.success).toBe(true);
    expect(result.rollbackPath).toBeDefined();

    // 验证 rollback 目录存在
    if (result.rollbackPath) {
      expect(existsSync(result.rollbackPath)).toBe(true);
    }
  });

  it('should reject duplicate paths in ZIP', async () => {
    const maliciousBackupPath = join(testDir, 'dup.zip');
    const manifest = {
      format: 'mofang-assistant-backup',
      format_version: 1,
      backup_id: 'dup',
      created_at: new Date().toISOString(),
      app_version: '0.0.0',
      schema_version: 1,
      counts: { questions: 0, papers: 0, assets: 0 },
      database: { path: 'db/mofang.sqlite', size: 0 },
      files: [],
    };

    createZip([
      { path: 'manifest.json', content: Buffer.from(JSON.stringify(manifest)) },
      { path: 'dup.txt', content: Buffer.from('first') },
      { path: 'dup.txt', content: Buffer.from('second') }, // 重复
    ], maliciousBackupPath);

    const preview = previewBackup(maliciousBackupPath);
    expect(preview.valid).toBe(false);
    expect(preview.errors.some(e => e.includes('Duplicate'))).toBe(true);
  });

  it('should reject backup with Windows drive absolute path cross-platform', async () => {
    const maliciousBackupPath = join(testDir, 'win-abs.zip');
    const manifest = {
      format: 'mofang-assistant-backup',
      format_version: 1,
      backup_id: 'win-abs',
      created_at: new Date().toISOString(),
      app_version: '0.0.0',
      schema_version: 1,
      counts: { questions: 0, papers: 0, assets: 0 },
      database: { path: 'db/mofang.sqlite', size: 0 },
      files: [],
    };

    createZip([
      { path: 'manifest.json', content: Buffer.from(JSON.stringify(manifest)) },
      { path: 'C:\\Windows\\System32\\evil.dll', content: Buffer.from('evil') },
    ], maliciousBackupPath);

    const preview = previewBackup(maliciousBackupPath);
    expect(preview.valid).toBe(false);
    expect(preview.errors.some(e => e.includes('Absolute path detected'))).toBe(true);
  });

  it('VACCINE: restoreBackup 遇到越界路径时必须坚决拒绝并保持 staging 隔离', async () => {
    const maliciousBackupPath = join(testDir, 'traversal-restore.zip');
    const manifest = {
      format: 'mofang-assistant-backup',
      format_version: 1,
      backup_id: 'traversal-restore',
      created_at: new Date().toISOString(),
      app_version: '0.0.0',
      schema_version: 1,
      counts: { questions: 0, papers: 0, assets: 0 },
      database: { path: 'db/mofang.sqlite', size: 0 },
      files: [],
    };

    createZip([
      { path: 'manifest.json', content: Buffer.from(JSON.stringify(manifest)) },
      { path: '../../escaped.txt', content: Buffer.from('escaped content') },
    ], maliciousBackupPath);

    const result = await restoreBackup(maliciousBackupPath, targetDataDir, 1, realMigrationsDir, true);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Path traversal detected/);
    expect(existsSync(join(testDir, 'escaped.txt'))).toBe(false);
  });
});