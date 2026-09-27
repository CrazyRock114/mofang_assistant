// Phase 2: operation_log 管理器

import type { Database } from './db.js';

export interface OperationLog {
  id: string;
  operationType: string;
  startedAt: string;
  finishedAt?: string;
  status: 'started' | 'succeeded' | 'failed';
  affectedCount: number;
  description: string;
  metadataJson: Record<string, unknown>;
}

export class OperationLogger {
  constructor(private db: Database) {}

  /**
   * 记录操作开始
   */
  logStart(operationType: string, description: string, metadata: Record<string, unknown> = {}): string {
    const id = crypto.randomUUID();
    const startedAt = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO operation_log (id, operation_type, started_at, status, description, metadata_json)
      VALUES (?, ?, ?, 'started', ?, ?)
    `).run(id, operationType, startedAt, description, JSON.stringify(metadata));

    return id;
  }

  /**
   * 记录操作成功
   */
  logSuccess(id: string, affectedCount: number): void {
    const finishedAt = new Date().toISOString();
    this.db.prepare(`
      UPDATE operation_log
      SET status = 'succeeded', finished_at = ?, affected_count = ?
      WHERE id = ?
    `).run(finishedAt, affectedCount, id);
  }

  /**
   * 记录操作失败
   */
  logFailure(id: string, error: Error): void {
    const finishedAt = new Date().toISOString();
    this.db.prepare(`
      UPDATE operation_log
      SET status = 'failed', finished_at = ?, metadata_json = json_set(metadata_json, '$.error', ?)
      WHERE id = ?
    `).run(finishedAt, error.message, id);
  }

  /**
   * 简便方法：包装同步操作并自动记录
   */
  wrap<T>(operationType: string, description: string, fn: () => T, metadata: Record<string, unknown> = {}): T {
    const logId = this.logStart(operationType, description, metadata);
    try {
      const result = fn();
      // 尝试从结果推断 affectedCount（如果是数字或有 affectedCount 属性）
      let affectedCount = 0;
      if (typeof result === 'number') {
        affectedCount = result;
      } else if (result && typeof result === 'object' && 'affectedCount' in result) {
        affectedCount = (result as any).affectedCount;
      }
      this.logSuccess(logId, affectedCount);
      return result;
    } catch (err) {
      this.logFailure(logId, err as Error);
      throw err;
    }
  }
}
