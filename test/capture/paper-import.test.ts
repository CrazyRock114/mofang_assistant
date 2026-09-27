// 0006 P4：成品卷装配（createPaperEx(composing) → 挂题 position 连续 → snapshot → done）
// 假服务注入，断言调用顺序与失败降级语义（真 SQLite 链路见 paper-import-db.test.ts）。

import { describe, it, expect } from 'vitest';
import { assemblePaper } from '../../src/capture/papers/paper-import.js';
import type { PaperAssemblyService } from '../../src/capture/papers/paper-import.js';

function makeService(overrides: Partial<PaperAssemblyService> = {}) {
  const calls: string[] = [];
  const service: PaperAssemblyService = {
    async createPaperEx(title, config, opts) {
      calls.push(`create:${title}:${opts?.status}:${JSON.stringify(config)}`);
      return { id: 'paper-1', title } as any;
    },
    async addQuestion(paperId, questionId) {
      calls.push(`add:${paperId}:${questionId}`);
    },
    async snapshotPaperQuestions(paperId) {
      calls.push(`snapshot:${paperId}`);
      return 2;
    },
    async updatePaperStatus(paperId, status) {
      calls.push(`status:${paperId}:${status}`);
    },
    ...overrides,
  };
  return { service, calls };
}

describe('assemblePaper（成品卷装配）', () => {
  it('顺序：composing 建卷 → 逐题挂卷 → 快照 → done；position 由服务层连续分配', async () => {
    const { service, calls } = makeService();
    const result = await assemblePaper(service, '某卷', ['q1', 'q2']);

    expect(calls).toEqual([
      'create:某卷:composing:{}',
      'add:paper-1:q1',
      'add:paper-1:q2',
      'snapshot:paper-1',
      'status:paper-1:done',
    ]);
    expect(result).toMatchObject({ paperId: 'paper-1', paperTitle: '某卷', added: 2, snapshotCount: 2, done: true });
    expect(result.warnings).toHaveLength(0);
  });

  it('单题挂卷失败不整批回滚：其余题照挂、快照照做、如实告警', async () => {
    const { service, calls } = makeService({
      async addQuestion(paperId, questionId) {
        calls.push(`add:${paperId}:${questionId}`);
        if (questionId === 'q2') throw new Error('already exists');
      },
    });
    const result = await assemblePaper(service, '某卷', ['q1', 'q2', 'q3']);

    expect(calls).toEqual([
      'create:某卷:composing:{}',
      'add:paper-1:q1',
      'add:paper-1:q2',
      'add:paper-1:q3',
      'snapshot:paper-1',
      'status:paper-1:done',
    ]);
    expect(result.added).toBe(2);
    expect(result.done).toBe(true);
    expect(result.warnings.join()).toContain('q2');
    expect(result.warnings.join()).toContain('already exists');
  });

  it('快照失败 → 不置 done（留 composing 待重试），如实告警', async () => {
    const { service, calls } = makeService({
      async snapshotPaperQuestions(paperId) {
        calls.push(`snapshot:${paperId}`);
        throw new Error('Question q2 not found');
      },
    });
    const result = await assemblePaper(service, '某卷', ['q1', 'q2']);

    expect(result.done).toBe(false);
    expect(result.paperId).toBe('paper-1');
    expect(calls).not.toContain('status:paper-1:done');
    expect(result.warnings.join()).toContain('快照失败');
    expect(result.warnings.join()).toContain('Question q2 not found');
  });

  it('状态置 done 失败 → done=false 且告警（快照已写，可人工置 done）', async () => {
    const { service } = makeService({
      async updatePaperStatus() {
        throw new Error('Illegal paper status transition: basket -> done');
      },
    });
    const result = await assemblePaper(service, '某卷', ['q1', 'q2']);
    expect(result.done).toBe(false);
    expect(result.snapshotCount).toBe(2);
    expect(result.warnings.join()).toContain('置 done 失败');
  });

  it('空题列表拒绝装配（不产生空卷）', async () => {
    const { service } = makeService();
    await expect(assemblePaper(service, '某卷', [])).rejects.toThrow(/空卷|无题/);
  });
});
