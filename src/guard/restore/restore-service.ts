// Phase 2: 恢复服务 — staging 两阶段恢复 + 路径门禁 + 溯源门禁

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, renameSync, rmSync, copyFileSync } from 'node:fs';
import { join, dirname, isAbsolute, normalize, sep } from 'node:path';
import { Database } from '../../bank/db.js';
import { readZip, type ZipEntry } from '../zip-utils.js';
import type { BackupManifest } from '../backup/backup-service.js';
// 0071（只增）：递归复制提公共（0071 数据位置迁移共用同一实现；本文件行为零变化）
import { copyDirectory } from '../fs-utils.js';

export interface RestorePreview {
  manifest: BackupManifest;
  valid: boolean;
  errors: string[];
}

export interface RestoreResult {
  success: boolean;
  restored?: {
    questions: number;
    papers: number;
    assets: number;
  };
  error?: string;
  rollbackPath?: string;
}

/**
 * 预览备份内容（读取 manifest + 基础校验）
 */
export function previewBackup(backupPath: string): RestorePreview {
  const errors: string[] = [];

  try {
    const entries = readZip(backupPath);

    // 查找 manifest.json
    const manifestEntry = entries.find(e => e.path === 'manifest.json');
    if (!manifestEntry) {
      errors.push('manifest.json not found in backup');
      return { manifest: null as any, valid: false, errors };
    }

    const manifest: BackupManifest = JSON.parse(manifestEntry.content.toString('utf8'));

    // 格式校验
    if (manifest.format !== 'mofang-assistant-backup') {
      errors.push(`Invalid backup format: ${manifest.format}`);
    }

    if (manifest.format_version !== 1) {
      errors.push(`Unsupported format version: ${manifest.format_version}`);
    }

    // 路径门禁：检查所有条目路径
    for (const entry of entries) {
      if (isAbsolute(entry.path)) {
        errors.push(`Absolute path detected: ${entry.path}`);
      }

      const normalized = normalize(entry.path);
      if (normalized.includes('..') || normalized.startsWith('..' + sep)) {
        errors.push(`Path traversal detected: ${entry.path}`);
      }
    }

    // 检查重复路径
    const pathSet = new Set<string>();
    for (const entry of entries) {
      if (pathSet.has(entry.path)) {
        errors.push(`Duplicate path: ${entry.path}`);
      }
      pathSet.add(entry.path);
    }

    // 检查条目数量上限（防止 zip bomb）
    if (entries.length > 100000) {
      errors.push(`Too many entries: ${entries.length}`);
    }

    return {
      manifest,
      valid: errors.length === 0,
      errors,
    };
  } catch (err) {
    errors.push(`Failed to read backup: ${err instanceof Error ? err.message : String(err)}`);
    return { manifest: null as any, valid: false, errors };
  }
}

/**
 * 执行恢复（两阶段：staging + 验证 + 替换）
 */
export async function restoreBackup(
  backupPath: string,
  targetDataDir: string,
  currentSchemaVersion: number,
  migrationsDir: string,
  confirmed: boolean,
  /**
   * P0-2：真正替换 data/ 前的回调——由调用方（ipc 层）在此关闭活动库句柄。
   * Windows 上未关闭的 SQLite 句柄会阻塞目录删除；无论 restore 成功或失败，调用方都在 restore 后重开库，
   * 保证 main 持有的句柄始终可用。
   */
  onBeforeReplace?: () => void
): Promise<RestoreResult> {
  // 1. 预览校验
  const preview = previewBackup(backupPath);
  if (!preview.valid) {
    return {
      success: false,
      error: `Backup validation failed: ${preview.errors.join('; ')}`,
    };
  }

  const { manifest } = preview;

  // 2. Schema 版本检查
  if (manifest.schema_version > currentSchemaVersion) {
    return {
      success: false,
      error: `Backup schema version (${manifest.schema_version}) is higher than current (${currentSchemaVersion}). Please upgrade the app.`,
    };
  }

  // 3. 非空保护：检查当前库是否有数据
  const currentDbPath = join(targetDataDir, 'bank.db');
  let hasData = false;

  if (existsSync(currentDbPath)) {
    try {
      const currentDb = new Database(currentDbPath);
      const questionCount = currentDb.prepare('SELECT COUNT(*) as count FROM questions WHERE deleted = 0').get() as { count: number };
      const paperCount = currentDb.prepare('SELECT COUNT(*) as count FROM papers').get() as { count: number };
      currentDb.close();

      hasData = questionCount.count > 0 || paperCount.count > 0;
    } catch {
      // 如果无法打开当前库，视为无数据
      hasData = false;
    }
  }

  if (hasData && !confirmed) {
    return {
      success: false,
      error: 'Current database has data. Please confirm to overwrite.',
    };
  }

  const stagingDir = join(targetDataDir, `../.staging-restore-${randomUUID()}`);
  const rollbackDir = join(targetDataDir, `../.data-before-restore-${randomUUID()}`);

  try {
    // 4. 解压到 staging
    mkdirSync(stagingDir, { recursive: true });

    const entries = readZip(backupPath);

    for (const entry of entries) {
      if (entry.path === 'manifest.json') continue; // manifest 已读过

      const targetPath = join(stagingDir, entry.path);
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, entry.content);
    }

    // 5. 验证 staging 数据库
    const stagingDbPath = join(stagingDir, manifest.database.path);
    if (!existsSync(stagingDbPath)) {
      throw new Error('Database file not found in backup');
    }

    const stagingDb = new Database(stagingDbPath);

    // 完整性检查
    const integrityResult = stagingDb.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    if (integrityResult.integrity_check !== 'ok') {
      stagingDb.close();
      throw new Error(`Database integrity check failed: ${integrityResult.integrity_check}`);
    }

    // Schema 检查：表是否存在
    const tables = stagingDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    const requiredTables = ['questions', 'papers', 'paper_questions', 'question_tags', 'operation_log'];
    for (const required of requiredTables) {
      if (!tables.some(t => t.name === required)) {
        stagingDb.close();
        throw new Error(`Required table ${required} not found in backup database`);
      }
    }

    // 溯源门禁（P1-4）：语义校验——遍历活跃题，校验 source_type ∈ {'network','local'}、
    // source_detail 是合法 JSON 且含可追溯字段（network: site+questionId+url；local: managed_path /
    // 原始文件名 / 页码 / 录入方式(origin)，见 数据备份与迁移设计 §3.3 语义），不合法即拒并报题 id 清单
    const invalidQuestions = validateSourceTraceability(stagingDb);

    if (invalidQuestions.length > 0) {
      stagingDb.close();
      throw new Error(`Found ${invalidQuestions.length} questions with incomplete source traceability (溯源门禁): ${invalidQuestions.join(', ')}`);
    }

    // Schema 迁移（如果需要）
    if (manifest.schema_version < currentSchemaVersion) {
      Database.runMigrations(stagingDb, migrationsDir);
    }

    // 验证计数
    const restoredQuestionCount = stagingDb.prepare('SELECT COUNT(*) as count FROM questions WHERE deleted = 0').get() as { count: number };
    const restoredPaperCount = stagingDb.prepare('SELECT COUNT(*) as count FROM papers').get() as { count: number };

    stagingDb.close();

    // 6. 创建 rollback 副本（如果当前 data 存在）
    // P0-2：进入破坏性数据替换前，先回调调用方关闭活动库句柄（Windows 未关闭句柄会阻塞目录删除，
    //       且能让 rollback 副本是干净拷贝）
    if (onBeforeReplace) onBeforeReplace();

    if (existsSync(targetDataDir)) {
      copyDirectory(targetDataDir, rollbackDir);
    }

    // 7. 原子替换：删除旧 data，重命名 staging
    if (existsSync(targetDataDir)) {
      rmSync(targetDataDir, { recursive: true, force: true });
    }

    // 从 staging 移动文件到目标位置
    mkdirSync(targetDataDir, { recursive: true });

    // 移动数据库
    const targetDbPath = join(targetDataDir, 'bank.db');
    renameSync(stagingDbPath, targetDbPath);

    // 移动资产文件
    const stagingAssetsDir = join(stagingDir, 'files/assets');
    if (existsSync(stagingAssetsDir)) {
      const targetAssetsDir = join(targetDataDir, 'assets');
      copyDirectory(stagingAssetsDir, targetAssetsDir);
    }

    // 移动日志文件（如果有）
    const stagingLogPath = join(stagingDir, 'files/capture-collect.log');
    if (existsSync(stagingLogPath)) {
      const targetLogPath = join(targetDataDir, 'capture-collect.log');
      copyFileSync(stagingLogPath, targetLogPath);
    }

    // 8. 最终完整性检查
    const finalDb = new Database(targetDbPath);
    const finalIntegrityResult = finalDb.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    if (finalIntegrityResult.integrity_check !== 'ok') {
      finalDb.close();
      throw new Error('Final integrity check failed');
    }

    // 写入 operation_log（P0-1：真实 schema 列：operation_type/started_at/finished_at/status/affected_count/description/metadata_json）
    const now = new Date().toISOString();
    finalDb.prepare(
      'INSERT INTO operation_log (id, operation_type, started_at, finished_at, status, affected_count, description, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      randomUUID(),
      'restore',
      now,
      now,
      'succeeded',
      restoredQuestionCount.count + restoredPaperCount.count,
      `Restored from backup ${manifest.backup_id}: questions=${restoredQuestionCount.count}, papers=${restoredPaperCount.count}, assets=${manifest.counts.assets}`,
      JSON.stringify({ backup_path: backupPath, backup_id: manifest.backup_id, restored_at: now })
    );

    finalDb.close();

    // 9. 清理 staging
    if (existsSync(stagingDir)) {
      rmSync(stagingDir, { recursive: true, force: true });
    }

    return {
      success: true,
      restored: {
        questions: restoredQuestionCount.count,
        papers: restoredPaperCount.count,
        assets: manifest.counts.assets,
      },
      rollbackPath: rollbackDir,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    // 失败回滚
    let rolledBack = false;
    if (existsSync(rollbackDir) && !existsSync(targetDataDir)) {
      // 如果已删除 targetDataDir，从 rollback 恢复
      renameSync(rollbackDir, targetDataDir);
      rolledBack = true;
    }

    // 清理 staging 和 rollback
    if (existsSync(stagingDir)) {
      rmSync(stagingDir, { recursive: true, force: true });
    }

    if (existsSync(rollbackDir)) {
      rmSync(rollbackDir, { recursive: true, force: true });
    }

    // 操作留痕（P0-1）：restore 失败（+回滚）写 operation_log（真实 schema；尽力而为，不掩盖原始错误）
    try {
      const logDbPath = join(targetDataDir, 'bank.db');
      if (existsSync(logDbPath)) {
        const logDb = new Database(logDbPath);
        const now = new Date().toISOString();
        logDb.prepare(
          'INSERT INTO operation_log (id, operation_type, started_at, finished_at, status, affected_count, description, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(
          randomUUID(),
          'restore',
          now,
          now,
          'failed',
          0,
          `Restore failed${rolledBack ? ' and rolled back' : ''}: ${errorMessage}`,
          JSON.stringify({ backup_path: backupPath, error: errorMessage, rolled_back: rolledBack })
        );
        if (rolledBack) {
          logDb.prepare(
            'INSERT INTO operation_log (id, operation_type, started_at, finished_at, status, affected_count, description, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
          ).run(
            randomUUID(),
            'rollback',
            now,
            now,
            'succeeded',
            0,
            'Rolled back to previous data',
            JSON.stringify({ rollbackPath: rollbackDir })
          );
        }
        logDb.close();
      }
    } catch {
      // 日志写入失败不得掩盖恢复错误
    }

    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * 溯源门禁（P1-4）：语义校验（真实 schema 已保证列 NOT NULL，门禁校验可追溯语义，杜绝恒空）
 *
 * - source_type 必须 ∈ {'network','local'}
 * - source_detail 必须是合法 JSON 对象
 * - network：必须含 site + questionId + url（采集入库透传字段，见 src/capture/ingest.ts）
 * - local：含 managed_path / 原始文件名(file/filename/file_name/originalFile) / 页码(pageNo/page/page_num/pageNum) /
 *          录入方式(origin) 任一即通过（数据备份与迁移设计 §3.3 语义）
 *
 * 返回不合法题 id 清单；空数组 = 全部通过。
 */
function validateSourceTraceability(stagingDb: Database): string[] {
  const questions = stagingDb.prepare(
    'SELECT id, source_type, source_detail FROM questions WHERE deleted = 0'
  ).all() as Array<{ id: string; source_type: string; source_detail: string }>;

  const invalid: string[] = [];
  for (const q of questions) {
    if (q.source_type !== 'network' && q.source_type !== 'local') {
      invalid.push(q.id);
      continue;
    }

    let detail: unknown;
    try {
      detail = JSON.parse(q.source_detail);
    } catch {
      invalid.push(q.id); // 非法 JSON
      continue;
    }

    if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) {
      invalid.push(q.id);
      continue;
    }
    const d = detail as Record<string, unknown>;

    if (q.source_type === 'network') {
      const ok = typeof d.site === 'string' && d.site.length > 0
        && typeof d.questionId === 'string' && d.questionId.length > 0
        && typeof d.url === 'string' && d.url.length > 0;
      if (!ok) invalid.push(q.id);
    } else {
      const hasManagedPath = typeof d.managed_path === 'string' && d.managed_path.length > 0;
      const hasFilename = ['file', 'filename', 'file_name', 'originalFile'].some(
        (k) => typeof d[k] === 'string' && (d[k] as string).length > 0
      );
      const hasPage = ['pageNo', 'page', 'page_num', 'pageNum'].some(
        (k) => d[k] !== undefined && d[k] !== null && String(d[k]).length > 0
      );
      const hasOrigin = typeof d.origin === 'string' && d.origin.length > 0; // 录入方式（§3.3）
      if (!(hasManagedPath || hasFilename || hasPage || hasOrigin)) invalid.push(q.id);
    }
  }
  return invalid;
}
