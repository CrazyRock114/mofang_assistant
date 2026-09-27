// 0028 P1: 识别 run service（真实 SQLite 实现）——recog_runs / recog_run_pages
// bank-core 是唯一碰 SQL 的模块（架构硬规则 2）：编排器只经本接口读写状态，绝不直接拼 SQL。
//
// 状态机（任务书 §一 P1）：queued→ocr→ai→done；任一步可 →error/cancelled；
// error/cancelled→ocr 为**续跑边**（断点续跑复用同一 runId，不新开 run）。
// done 是唯一终态中的终局（error/cancelled 可续跑，done 不可回退）。

import type {
  RecogRun, RecogRunCreateInput, RecogRunPage, RecogRunPagePatch,
  RecogRunService, RecogRunStatus, RecogRunStatusPatch, RecogRunStage,
  RecogSourceKind,
} from '../shared/contracts/recog-run-types.js';
import type { Database } from './db.js';
import { OperationLogger } from './operation-log.js';

// 状态机六态常量随 service 再导出（消费方单点 import；单源仍在 recog-run-types.ts）
export { RECOG_RUN_STATUSES } from '../shared/contracts/recog-run-types.js';

/** recog_runs 行形态 */
interface RecogRunRow {
  id: string;
  status: string;
  stage: string;
  source_kind: string;
  source_name: string | null;
  page_count: number;
  pages_done: number;
  error: string | null;
  warnings: string;
  question_ids: string;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

/** recog_run_pages 行形态 */
interface RecogRunPageRow {
  run_id: string;
  page_no: number;
  image_file: string;
  ocr_file: string | null;
  status: string;
  text_chars: number | null;
  image_ref_count: number | null;
  error: string | null;
  updated_at: string;
}

function parseStringArray(json: string, field: string): string[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error(`recog_runs.${field} 不是 JSON 数组`);
  return parsed.map((v) => String(v));
}

function rowToRun(row: RecogRunRow): RecogRun {
  return {
    id: row.id,
    status: row.status as RecogRunStatus,
    stage: row.stage as RecogRunStage,
    sourceKind: row.source_kind as RecogSourceKind,
    sourceName: row.source_name,
    pageCount: row.page_count,
    pagesDone: row.pages_done,
    error: row.error,
    warnings: parseStringArray(row.warnings, 'warnings'),
    questionIds: parseStringArray(row.question_ids, 'question_ids'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

function rowToPage(row: RecogRunPageRow): RecogRunPage {
  return {
    runId: row.run_id,
    pageNo: row.page_no,
    imageFile: row.image_file,
    ocrFile: row.ocr_file,
    status: row.status as RecogRunPage['status'],
    textChars: row.text_chars,
    imageRefCount: row.image_ref_count,
    error: row.error,
    updatedAt: row.updated_at,
  };
}

/** 前向边 + 中断边 + 续跑边（error/cancelled → ocr） */
const ALLOWED_TRANSITIONS: Record<RecogRunStatus, readonly RecogRunStatus[]> = {
  queued: ['ocr', 'error', 'cancelled'],
  ocr: ['ai', 'error', 'cancelled'],
  ai: ['done', 'error', 'cancelled'],
  done: [],
  error: ['ocr'],
  cancelled: ['ocr'],
};

const TERMINAL: readonly RecogRunStatus[] = ['done', 'error', 'cancelled'];

export class RecogRunServiceImpl implements RecogRunService {
  private logger: OperationLogger;

  constructor(private db: Database) {
    this.logger = new OperationLogger(db);
  }

  async createRun(input: RecogRunCreateInput): Promise<RecogRun> {
    if (input.pages.length === 0) {
      throw new Error('createRun：页素材不能为空（至少 1 页）');
    }
    const seen = new Set<number>();
    for (const p of input.pages) {
      if (!Number.isInteger(p.pageNo) || p.pageNo < 1) throw new Error(`createRun：非法页号 ${p.pageNo}`);
      if (seen.has(p.pageNo)) throw new Error(`createRun：页号重复 ${p.pageNo}`);
      seen.add(p.pageNo);
    }

    const name = input.sourceName ?? (input.pages.length === 1 ? null : `${input.pages.length} 张图片`);
    return this.logger.wrap('recogRun.create', `Create recog run ${input.id}（${input.pages.length} 页）`, () => {
      this.db.transaction(() => {
        this.db.prepare(`
          INSERT INTO recog_runs (id, status, stage, source_kind, source_name, page_count, pages_done,
                                  warnings, question_ids, created_at, updated_at)
          VALUES (?, 'queued', 'queued', ?, ?, ?, 0, '[]', '[]', ?, ?)
        `).run(input.id, input.sourceKind, name, input.pages.length, input.now, input.now);
        const stmt = this.db.prepare(`
          INSERT INTO recog_run_pages (run_id, page_no, image_file, status, updated_at)
          VALUES (?, ?, ?, 'pending', ?)
        `);
        for (const p of input.pages) stmt.run(input.id, p.pageNo, p.imageFile, input.now);
      });
      return this.requireRun(input.id);
    });
  }

  async getRun(id: string): Promise<RecogRun | null> {
    const row = this.db.prepare('SELECT * FROM recog_runs WHERE id = ?').get(id) as RecogRunRow | undefined;
    return row ? rowToRun(row) : null;
  }

  async listRuns(limit?: number): Promise<RecogRun[]> {
    const rows = (limit === undefined
      ? this.db.prepare('SELECT * FROM recog_runs ORDER BY created_at DESC, rowid DESC').all()
      : this.db.prepare('SELECT * FROM recog_runs ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit)) as unknown as RecogRunRow[];
    return rows.map(rowToRun);
  }

  async setStatus(id: string, patch: RecogRunStatusPatch): Promise<RecogRun> {
    const current = this.requireRun(id);
    if (current.status === patch.status) {
      throw new Error(`非法状态迁移：${id} 已是 ${patch.status}`);
    }
    if (!ALLOWED_TRANSITIONS[current.status].includes(patch.status)) {
      throw new Error(`非法状态迁移：${id} ${current.status} → ${patch.status}`);
    }
    const finishedAt = TERMINAL.includes(patch.status)
      ? (patch.finishedAt === undefined ? patch.now : patch.finishedAt)
      : (patch.finishedAt ?? null);
    this.db.prepare(`
      UPDATE recog_runs SET status = ?, stage = ?, error = ?, updated_at = ?, finished_at = ? WHERE id = ?
    `).run(
      patch.status,
      patch.stage ?? patch.status,
      patch.error === undefined ? current.error : patch.error,
      patch.now,
      finishedAt,
      id,
    );
    return this.requireRun(id);
  }

  async listPages(runId: string): Promise<RecogRunPage[]> {
    const rows = this.db.prepare('SELECT * FROM recog_run_pages WHERE run_id = ? ORDER BY page_no').all(runId) as unknown as RecogRunPageRow[];
    return rows.map(rowToPage);
  }

  async markPage(runId: string, pageNo: number, patch: RecogRunPagePatch): Promise<void> {
    const existing = this.db.prepare('SELECT * FROM recog_run_pages WHERE run_id = ? AND page_no = ?').get(runId, pageNo) as
      | RecogRunPageRow
      | undefined;
    if (!existing) throw new Error(`页不存在：run ${runId} 第 ${pageNo} 页`);
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE recog_run_pages
        SET status = ?, ocr_file = ?, text_chars = ?, image_ref_count = ?, error = ?, updated_at = ?
        WHERE run_id = ? AND page_no = ?
      `).run(
        patch.status ?? existing.status,
        patch.ocrFile ?? existing.ocr_file,
        patch.textChars ?? existing.text_chars,
        patch.imageRefCount ?? existing.image_ref_count,
        patch.error === undefined ? existing.error : patch.error,
        patch.now,
        runId,
        pageNo,
      );
      this.refreshPagesDone(runId, patch.now);
    });
  }

  async setWarnings(id: string, warnings: string[], now: string): Promise<RecogRun> {
    this.requireRun(id);
    this.db.prepare('UPDATE recog_runs SET warnings = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(warnings), now, id);
    return this.requireRun(id);
  }

  /** 结果题目 id 集回写（去重并集，顺序=首次入集顺序） */
  async attachQuestions(id: string, questionIds: string[], now: string): Promise<RecogRun> {
    const current = this.requireRun(id);
    const next = [...current.questionIds];
    for (const qid of questionIds) {
      if (!next.includes(qid)) next.push(qid);
    }
    this.db.prepare('UPDATE recog_runs SET question_ids = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(next), now, id);
    return this.requireRun(id);
  }

  // ---------- 内部 ----------

  private requireRun(id: string): RecogRun {
    const row = this.db.prepare('SELECT * FROM recog_runs WHERE id = ?').get(id) as RecogRunRow | undefined;
    if (!row) throw new Error(`recog run 不存在：${id}`);
    return rowToRun(row);
  }

  /** pagesDone = status='done' 的页数（error 页不计「已完成」，续跑时仍会重试） */
  private refreshPagesDone(runId: string, now: string): void {
    this.db.prepare(`
      UPDATE recog_runs
      SET pages_done = (SELECT COUNT(*) FROM recog_run_pages WHERE run_id = ? AND status = 'done'),
          updated_at = ?
      WHERE id = ?
    `).run(runId, now, runId);
  }
}
