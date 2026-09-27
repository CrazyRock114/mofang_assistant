// 0002: 快照恒定探针（数据级，不碰 docgen 红线）— 仅真实 SQLite
// 验收口径：题库改题/软删后，done 卷 paper_snapshots 数据原样不变；
// 错题快照同哲学（snapshot_json 登记时定格，题改后仍显示旧内容）。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { openDatabase } from '../../src/bank/db.js';
import type { Database } from '../../src/bank/db.js';
import { BankServiceImpl } from '../../src/bank/bank-service.js';
import { createExtServices } from '../../src/bank/ext-services.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '../../src/bank/migrations');

describe('Snapshot Constancy Probe (Real SQLite, data-level)', () => {
  let tempDir: string;
  let db: Database;
  let bank: BankServiceImpl;
  let ext: ReturnType<typeof createExtServices>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'snapshot-probe-'));
    db = openDatabase(join(tempDir, 'test.db'), migrationsDir);
    bank = new BankServiceImpl(db);
    ext = createExtServices(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('题库改题/软删后，done 卷 paper_snapshots 数据原样不变', async () => {
    const q1 = await bank.createQuestion({
      subject: '物理',
      sourceType: 'local',
      sourceDetail: { origin: 'manual' },
      content: '<div class="question">原始题干一</div>',
      images: [],
    });
    const q2 = await bank.createQuestion({
      subject: '物理',
      sourceType: 'local',
      sourceDetail: { origin: 'manual' },
      content: '<div class="question">原始题干二</div>',
      images: [],
    });

    const paper = await bank.createPaper('恒定探针卷');
    await bank.addQuestion(paper.id, q1.id, 10);
    await bank.addQuestion(paper.id, q2.id, 20);

    // 数据级：模拟出卷时的内容快照落库（快照写入方为出卷链路，本探针只验证恒定性）
    const snapshotRows = [
      { paper_id: paper.id, question_id: q1.id, content_snapshot: '{"stemHtml":"<div class=\\"question\\">原始题干一</div>"}' },
      { paper_id: paper.id, question_id: q2.id, content_snapshot: '{"stemHtml":"<div class=\\"question\\">原始题干二</div>"}' },
    ];
    for (const row of snapshotRows) {
      db.prepare('INSERT INTO paper_snapshots (paper_id, question_id, content_snapshot) VALUES (?, ?, ?)')
        .run(row.paper_id, row.question_id, row.content_snapshot);
    }

    // 出卷定稿：basket → composing → done
    await ext.paper.updatePaperStatus(paper.id, 'composing');
    await ext.paper.updatePaperStatus(paper.id, 'done');

    const before = db.prepare('SELECT * FROM paper_snapshots ORDER BY question_id').all();

    // 题库侧变动：q1 改题、q2 软删
    await bank.updateQuestion(q1.id, { content: '<div class="question">被改动的题干一</div>' });
    await bank.deleteQuestion(q2.id);

    const after = db.prepare('SELECT * FROM paper_snapshots ORDER BY question_id').all();
    expect(after).toEqual(before); // 数据原样不变

    // 且软删不影响 done 卷身份
    expect(db.prepare('SELECT status FROM papers WHERE id = ?').get(paper.id) as any).toEqual({ status: 'done' });
  });

  it('错题快照：题改后 mistakes.snapshot_json 保持登记时内容（同哲学）', async () => {
    const q = await bank.createQuestion({
      subject: '物理',
      sourceType: 'local',
      sourceDetail: { origin: 'manual' },
      content: '<div class="question">登记时题干</div>',
      images: [],
    });
    const student = await ext.student.createStudent({ name: '探针学生' });

    const { mistake } = await ext.mistake.recordWrong({
      questionId: q.id,
      studentId: student.id,
      occurredAt: '2026-05-01T00:00:00Z',
    });
    expect(mistake.snapshot.stemHtml).toBe('<div class="question">登记时题干</div>');

    // 题库改题后，错题快照不漂移
    await bank.updateQuestion(q.id, { content: '<div class="question">改版后题干</div>' });

    const list = await ext.mistake.listMistakes({ studentId: student.id });
    expect(list.length).toBe(1);
    expect(list[0].snapshot.stemHtml).toBe('<div class="question">登记时题干</div>');
  });
});
