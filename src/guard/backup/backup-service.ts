// Phase 1: 备份服务 — 将 data/ 打包成 .mofang-backup.zip

import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Database } from '../../bank/db.js';
import { createZip, type ZipEntry } from '../zip-utils.js';

/**
 * 备份清单（manifest.json）
 */
export interface BackupManifest {
  format: 'mofang-assistant-backup';
  format_version: 1;
  backup_id: string;
  created_at: string;
  app_version: string;
  schema_version: number;
  counts: {
    questions: number;
    papers: number;
    assets: number;
  };
  database: {
    path: string; // ZIP 内路径
    size: number;
  };
  files: Array<{
    path: string; // ZIP 内路径
    kind: 'asset' | 'log';
    size: number;
  }>;
}

export interface BackupResult {
  success: boolean;
  backupPath?: string;
  manifest?: BackupManifest;
  error?: string;
}

/**
 * 创建备份
 *
 * @param db - 数据库实例
 * @param dataDir - data/ 目录路径
 * @param outputPath - 输出的备份文件路径
 * @param appVersion - 应用版本号
 */
export async function createBackup(
  db: Database,
  dataDir: string,
  outputPath: string,
  appVersion: string
): Promise<BackupResult> {
  const tempPath = `${outputPath}.tmp`;

  try {
    // 1. 创建数据库快照（使用 VACUUM INTO）
    const dbPath = join(dataDir, 'bank.db');
    const tempDbPath = join(dataDir, `bank-snapshot-${randomUUID()}.db`);

    try {
      db.exec(`VACUUM INTO '${tempDbPath.replace(/'/g, "''")}'`);
    } catch (err) {
      // VACUUM INTO 可能不支持（旧版 SQLite），回退到文件复制
      // 注意：需要先关闭数据库句柄再复制，或使用在线备份 API
      // 这里假设 VACUUM INTO 可用，如果不可用需要调用者处理
      throw new Error(`VACUUM INTO failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const dbSnapshot = readFileSync(tempDbPath);
    unlinkSync(tempDbPath); // 清理临时文件

    // 2. 读取 schema_version
    const schemaVersion = db.getUserVersion();

    // 3. 统计数据量
    const questionCount = db.prepare('SELECT COUNT(*) as count FROM questions WHERE deleted = 0').get() as { count: number };
    const paperCount = db.prepare('SELECT COUNT(*) as count FROM papers').get() as { count: number };

    // 4. 收集资产文件
    const assetsDir = join(dataDir, 'assets');
    const assetFiles: Array<{ relativePath: string; fullPath: string; size: number }> = [];

    if (existsSync(assetsDir)) {
      collectFiles(assetsDir, assetsDir, assetFiles);
    }

    // 5. 可选：包含 capture-collect.log（非业务数据，但可能有诊断价值）
    const logPath = join(dataDir, 'capture-collect.log');
    const logFiles: Array<{ relativePath: string; fullPath: string; size: number }> = [];
    if (existsSync(logPath)) {
      const logStat = statSync(logPath);
      logFiles.push({
        relativePath: 'capture-collect.log',
        fullPath: logPath,
        size: logStat.size,
      });
    }

    // 6. 构建 manifest
    const manifest: BackupManifest = {
      format: 'mofang-assistant-backup',
      format_version: 1,
      backup_id: randomUUID(),
      created_at: new Date().toISOString(),
      app_version: appVersion,
      schema_version: schemaVersion,
      counts: {
        questions: questionCount.count,
        papers: paperCount.count,
        assets: assetFiles.length,
      },
      database: {
        path: 'db/mofang.sqlite',
        size: dbSnapshot.length,
      },
      files: [
        ...assetFiles.map(f => ({
          path: `files/assets/${f.relativePath.replace(/\\/g, '/')}`,
          kind: 'asset' as const,
          size: f.size,
        })),
        ...logFiles.map(f => ({
          path: `files/${f.relativePath}`,
          kind: 'log' as const,
          size: f.size,
        })),
      ],
    };

    // 7. 组装 ZIP 条目
    const entries: ZipEntry[] = [
      {
        path: 'manifest.json',
        content: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'),
      },
      {
        path: 'db/mofang.sqlite',
        content: dbSnapshot,
      },
    ];

    for (const asset of assetFiles) {
      entries.push({
        path: `files/assets/${asset.relativePath.replace(/\\/g, '/')}`,
        content: readFileSync(asset.fullPath),
      });
    }

    for (const log of logFiles) {
      entries.push({
        path: `files/${log.relativePath}`,
        content: readFileSync(log.fullPath),
      });
    }

    // 8. 创建 ZIP（先写临时文件）
    createZip(entries, tempPath);

    // 9. 校验临时文件存在且非空
    if (!existsSync(tempPath)) {
      throw new Error('Failed to create backup ZIP file');
    }

    const tempStat = statSync(tempPath);
    if (tempStat.size === 0) {
      throw new Error('Backup ZIP file is empty');
    }

    // 10. 原子 rename
    renameSync(tempPath, outputPath);

    // 操作留痕（P0-1）：备份成功写 operation_log（真实 schema；db 是应用正在用的句柄，写日志用同一实例，别关它）
    try {
      const now = new Date().toISOString();
      db.prepare(
        'INSERT INTO operation_log (id, operation_type, started_at, finished_at, status, affected_count, description, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        randomUUID(),
        'backup',
        now,
        now,
        'succeeded',
        questionCount.count + paperCount.count,
        `Backup to ${outputPath}: questions=${questionCount.count}, papers=${paperCount.count}, assets=${assetFiles.length}`,
        JSON.stringify({ backup_path: outputPath, backup_id: manifest.backup_id, created_at: manifest.created_at })
      );
    } catch {
      // 日志写入失败不阻断备份成功返回
    }

    return {
      success: true,
      backupPath: outputPath,
      manifest,
    };
  } catch (err) {
    // 清理临时文件
    if (existsSync(tempPath)) {
      unlinkSync(tempPath);
    }

    // 操作留痕（P0-1）：备份失败写 operation_log（status='failed'，尽力而为）
    try {
      const now = new Date().toISOString();
      db.prepare(
        'INSERT INTO operation_log (id, operation_type, started_at, finished_at, status, affected_count, description, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        randomUUID(),
        'backup',
        now,
        now,
        'failed',
        0,
        `Backup failed: ${err instanceof Error ? err.message : String(err)}`,
        JSON.stringify({ output_path: outputPath, error: err instanceof Error ? err.message : String(err) })
      );
    } catch {
      // 日志写入失败不得掩盖原始备份错误
    }

    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 递归收集目录下所有文件
 */
function collectFiles(
  dir: string,
  baseDir: string,
  result: Array<{ relativePath: string; fullPath: string; size: number }>
): void {
  const items = readdirSync(dir);

  for (const item of items) {
    const fullPath = join(dir, item);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      collectFiles(fullPath, baseDir, result);
    } else if (stat.isFile()) {
      const relativePath = relative(baseDir, fullPath);
      result.push({ relativePath, fullPath, size: stat.size });
    }
  }
}
