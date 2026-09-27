// 0028 P1：recog_runs 迁移 + service 全状态机（真实 SQLite；状态机/页进度/结果题目 id 集/错误/时间戳）
// 任务书 §四：runs 状态机——迁移+service 全路径（queued→ocr→ai→done/error/cancelled）

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDatabase, type Database } from '../../src/bank/db.js';
import { RecogRunServiceImpl, RECOG_RUN_STATUSES } from '../../src/bank/recog-run-service.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '../../src/bank/migrations');
const T0 = '2026-09-17T00:00:00.000Z';

describe('0028 P1：recog_runs 迁移（0012 / user_version=11——0044 迁移 0013、0048 迁移 0014、0057 迁移 0015、0059 迁移 0016、0062 迁移 0017 顺延）', () => {
  let tempDir: string;
  let db: Database;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'recog-run-'));
    db = openDatabase(join(tempDir, 'test.db'), migrationsDir);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('版本推进到 15（0062 学段落库迁移顺延），recog_runs / recog_run_pages 两表就位', () => {
    expect(db.getUserVersion()).toBe(15);
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as Array<{ name: string }>)
      .map((r) => r.name);
    expect(tables).toContain('recog_runs');
    expect(tables).toContain('recog_run_pages');

    // 0048 补强：0014 重建 papers 后两索引仍在（DROP 会带走，重建漏了即在此暴露）
    const paperIndexes = (db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='papers'`).all() as Array<{ name: string }>)
      .map((r) => r.name);
    expect(paperIndexes).toContain('idx_papers_status');
    expect(paperIndexes).toContain('idx_papers_folder');
  });

  it('recog_runs 列结构与默认值（状态机/阶段/页进度/结果题目 id 集/错误/时间戳）', () => {
    const cols = (db.prepare(`PRAGMA table_info(recog_runs)`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual([
      'id', 'status', 'stage', 'source_kind', 'source_name', 'page_count', 'pages_done',
      'error', 'warnings', 'question_ids', 'created_at', 'updated_at', 'finished_at',
    ]);

    db.prepare(`INSERT INTO recog_runs (id, status, stage, source_kind, created_at, updated_at) VALUES ('r1','queued','queued','image',?,?)`)
      .run(T0, T0);
    const row = db.prepare(`SELECT page_count, pages_done, warnings, question_ids, error, finished_at FROM recog_runs WHERE id='r1'`)
      .get() as { page_count: number; pages_done: number; warnings: string; question_ids: string; error: string | null; finished_at: string | null };
    expect(row.page_count).toBe(0);
    expect(row.pages_done).toBe(0);
    expect(row.warnings).toBe('[]');
    expect(row.question_ids).toBe('[]');
    expect(row.error).toBeNull();
    expect(row.finished_at).toBeNull();
  });

  it('status CHECK：六态之外被 DDL 拦截；status/created_at 索引就位', () => {
    expect(() => {
      db.prepare(`INSERT INTO recog_runs (id, status, stage, source_kind, created_at, updated_at) VALUES ('bad','running','queued','image',?,?)`)
        .run(T0, T0);
    }).toThrow(/CHECK constraint failed/);

    const indices = (db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'`).all() as Array<{ name: string }>)
      .map((i) => i.name);
    expect(indices).toContain('idx_recog_runs_status');
    expect(indices).toContain('idx_recog_runs_created');
    expect(indices).toContain('idx_recog_run_pages_run');
  });

  it('recog_run_pages：页状态 CHECK + (run_id, page_no) 主键 + 级联删除', () => {
    db.prepare(`INSERT INTO recog_runs (id, status, stage, source_kind, created_at, updated_at) VALUES ('r1','queued','queued','image',?,?)`).run(T0, T0);
    db.prepare(`INSERT INTO recog_run_pages (run_id, page_no, image_file, status, updated_at) VALUES ('r1',1,'pages/p001.png','pending',?)`).run(T0);

    expect(() => {
      db.prepare(`INSERT INTO recog_run_pages (run_id, page_no, image_file, status, updated_at) VALUES ('r1',2,'pages/p002.png','bogus',?)`).run(T0);
    }).toThrow(/CHECK constraint failed/);
    expect(() => {
      db.prepare(`INSERT INTO recog_run_pages (run_id, page_no, image_file, status, updated_at) VALUES ('r1',1,'pages/p001b.png','pending',?)`).run(T0);
    }).toThrow(/UNIQUE constraint failed/);

    // 外键：不存在的 run 拒绝
    expect(() => {
      db.prepare(`INSERT INTO recog_run_pages (run_id, page_no, image_file, status, updated_at) VALUES ('ghost',1,'pages/p001.png','pending',?)`).run(T0);
    }).toThrow(/FOREIGN KEY constraint failed/);

    // 级联：删 run 连带删页
    db.prepare(`DELETE FROM recog_runs WHERE id='r1'`).run();
    const cnt = db.prepare(`SELECT COUNT(*) AS c FROM recog_run_pages`).get() as { c: number };
    expect(cnt.c).toBe(0);
  });

  it('RECOG_RUN_STATUSES 与迁移 CHECK 逐字一致（六态）', () => {
    expect([...RECOG_RUN_STATUSES]).toEqual(['queued', 'ocr', 'ai', 'done', 'error', 'cancelled']);
  });
});

describe('0028 P1：RecogRunServiceImpl 状态机与页进度', () => {
  let tempDir: string;
  let db: Database;
  let svc: RecogRunServiceImpl;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'recog-run-svc-'));
    db = openDatabase(join(tempDir, 'test.db'), migrationsDir);
    svc = new RecogRunServiceImpl(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function newRun(pages = 3) {
    return svc.createRun({
      id: 'run-1',
      sourceKind: 'image',
      sourceName: 'paper.png',
      pages: Array.from({ length: pages }, (_, i) => ({ pageNo: i + 1, imageFile: `pages/p00${i + 1}.png` })),
      now: T0,
    });
  }

  it('createRun：queued 落库 + 页行 pending + pageCount', async () => {
    const run = await newRun(3);
    expect(run.status).toBe('queued');
    expect(run.stage).toBe('queued');
    expect(run.pageCount).toBe(3);
    expect(run.pagesDone).toBe(0);
    expect(run.sourceKind).toBe('image');
    expect(run.createdAt).toBe(T0);

    const pages = await svc.listPages('run-1');
    expect(pages.map((p) => [p.pageNo, p.status, p.imageFile])).toEqual([
      [1, 'pending', 'pages/p001.png'], [2, 'pending', 'pages/p002.png'], [3, 'pending', 'pages/p003.png'],
    ]);
  });

  it('全路径 queued→ocr→ai→done（stage 同步 + finishedAt 落定）', async () => {
    await newRun();
    const a = await svc.setStatus('run-1', { status: 'ocr', stage: 'ocr', now: T0 });
    expect([a.status, a.stage, a.finishedAt]).toEqual(['ocr', 'ocr', null]);
    const b = await svc.setStatus('run-1', { status: 'ai', stage: 'ai', now: T0 });
    expect([b.status, b.stage]).toEqual(['ai', 'ai']);
    const c = await svc.setStatus('run-1', { status: 'done', now: '2026-09-17T00:01:00.000Z' });
    expect([c.status, c.stage, c.finishedAt]).toEqual(['done', 'done', '2026-09-17T00:01:00.000Z']);
  });

  it('非法迁移被拒：done 是终态，不可回到 ocr；queued 不可直接 done', async () => {
    await newRun();
    await expect(svc.setStatus('run-1', { status: 'done', now: T0 })).rejects.toThrow(/非法状态迁移/);
    await svc.setStatus('run-1', { status: 'ocr', stage: 'ocr', now: T0 });
    await svc.setStatus('run-1', { status: 'ai', stage: 'ai', now: T0 });
    await svc.setStatus('run-1', { status: 'done', now: T0 });
    await expect(svc.setStatus('run-1', { status: 'ocr', stage: 'ocr', now: T0 })).rejects.toThrow(/非法状态迁移/);
  });

  it('中断三态：ocr→cancelled、ocr→error（带错误文案）、error 终态', async () => {
    await newRun();
    await svc.setStatus('run-1', { status: 'ocr', stage: 'ocr', now: T0 });
    const cancelled = await svc.setStatus('run-1', { status: 'cancelled', now: T0 });
    expect([cancelled.status, cancelled.finishedAt]).toEqual(['cancelled', T0]);
    await expect(svc.setStatus('run-1', { status: 'error', error: 'x', now: T0 })).rejects.toThrow(/非法状态迁移/);

    await svc.createRun({ id: 'run-2', sourceKind: 'clipboard', pages: [{ pageNo: 1, imageFile: 'pages/p001.png' }], now: T0 });
    await svc.setStatus('run-2', { status: 'ocr', stage: 'ocr', now: T0 });
    const errored = await svc.setStatus('run-2', { status: 'error', error: 'OCR HTTP 500', now: T0 });
    expect([errored.status, errored.error, errored.finishedAt]).toEqual(['error', 'OCR HTTP 500', T0]);
  });

  it('页进度：markPage 落 ocrFile/字数/图数，pagesDone 随 done 页递增', async () => {
    await newRun(3);
    await svc.markPage('run-1', 1, { status: 'done', ocrFile: 'ocr/p001.json', textChars: 120, imageRefCount: 1, now: T0 });
    await svc.markPage('run-1', 2, { status: 'done', ocrFile: 'ocr/p002.json', textChars: 80, imageRefCount: 0, now: T0 });
    let run = await svc.getRun('run-1');
    expect(run!.pagesDone).toBe(2);

    const pages = await svc.listPages('run-1');
    expect(pages[0].ocrFile).toBe('ocr/p001.json');
    expect(pages[0].textChars).toBe(120);
    expect(pages[0].imageRefCount).toBe(1);
    expect(pages[2].status).toBe('pending');

    // 页错误不清零已 done 数
    await svc.markPage('run-1', 3, { status: 'error', error: 'timeout', now: T0 });
    run = await svc.getRun('run-1');
    expect(run!.pagesDone).toBe(2);
    expect((await svc.listPages('run-1'))[2].error).toBe('timeout');
  });

  it('markPage 对不存在的页抛错（防静默丢进度）', async () => {
    await newRun(2);
    await expect(svc.markPage('run-1', 9, { status: 'done', now: T0 })).rejects.toThrow(/页不存在/);
    await expect(svc.markPage('ghost', 1, { status: 'done', now: T0 })).rejects.toThrow(/页不存在/);
  });

  it('结果题目 id 集：attachQuestions 去重并集 + 回读一致', async () => {
    await newRun();
    await svc.setStatus('run-1', { status: 'ocr', stage: 'ocr', now: T0 });
    await svc.setStatus('run-1', { status: 'ai', stage: 'ai', now: T0 });
    await svc.setStatus('run-1', { status: 'done', now: T0 });

    const a = await svc.attachQuestions('run-1', ['q-1', 'q-2'], T0);
    expect(a.questionIds).toEqual(['q-1', 'q-2']);
    const b = await svc.attachQuestions('run-1', ['q-2', 'q-3'], T0);
    expect(b.questionIds).toEqual(['q-1', 'q-2', 'q-3']);
    expect((await svc.getRun('run-1'))!.questionIds).toEqual(['q-1', 'q-2', 'q-3']);
    await expect(svc.attachQuestions('ghost', ['q-1'], T0)).rejects.toThrow(/不存在/);
  });

  it('warnings 落库（切分告警回写）+ history 倒序 + limit', async () => {
    await svc.createRun({ id: 'run-1', sourceKind: 'image', pages: [{ pageNo: 1, imageFile: 'pages/p001.png' }], now: '2026-09-17T00:00:00.000Z' });
    await svc.createRun({ id: 'run-2', sourceKind: 'image', pages: [{ pageNo: 1, imageFile: 'pages/p001.png' }], now: '2026-09-17T00:05:00.000Z' });
    await svc.createRun({ id: 'run-3', sourceKind: 'image', pages: [{ pageNo: 1, imageFile: 'pages/p001.png' }], now: '2026-09-17T00:10:00.000Z' });
    await svc.setWarnings('run-2', ['第1页题号 3 重复'], T0);

    const all = await svc.listRuns();
    expect(all.map((r) => r.id)).toEqual(['run-3', 'run-2', 'run-1']);
    expect(all[1].warnings).toEqual(['第1页题号 3 重复']);
    expect((await svc.listRuns(2)).map((r) => r.id)).toEqual(['run-3', 'run-2']);
  });

  it('setStatus/markPage/addRun 未知 run 抛错（不静默）', async () => {
    await expect(svc.setStatus('ghost', { status: 'ocr', stage: 'ocr', now: T0 })).rejects.toThrow(/不存在/);
    await expect(svc.listPages('ghost')).resolves.toEqual([]);
    await expect(svc.getRun('ghost')).resolves.toBeNull();
    await expect(svc.setWarnings('ghost', [], T0)).rejects.toThrow(/不存在/);
    // 重复 id 插入被主键拦截
    await newRun(1);
    await expect(newRun(1)).rejects.toThrow(/UNIQUE|PRIMARY/i);
  });
});
