// 0062（任务书 §一.3）：recog.saveAsPaper 形验白名单只增 stage 分支 + 透传落库
// （录题链③「存为试卷」的 stage 端到端——handler → SaveAsPaperService → createQuestion → 真库读回）。
// 环境：node + 真 SQLite；electron 全 mock（模式照 test/shell/recog-image-assets.test.ts）。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
  },
  BrowserWindow: class {},
  dialog: {},
  safeStorage: { isEncryptionAvailable: () => false },
}));

import { registerRecogIpcHandlers } from '../../src/shell/ipc.js';
import type { RecogHost } from '../../src/shell/recog/recog-host.js';
import { IPC_CHANNELS } from '../../src/shared/contracts/ipc-channels.js';
import { openDatabase, type Database } from '../../src/bank/db.js';
import { BankServiceImpl } from '../../src/bank/bank-service.js';
import { createExtServices } from '../../src/bank/ext-services.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '../../src/bank/migrations');

/** 单题卡最小合法载荷（形验逐字段过；stage 由各用例覆盖） */
function payload(stage: unknown) {
  return {
    runId: 'run-0062',
    title: '0062 学段落库卷',
    subject: '物理',
    ...(stage === undefined ? {} : { stage }),
    cards: [
      {
        qno: '1',
        typeCode: '',
        contentHtml: '<div class="question"><p>存为试卷题</p></div>',
        answerHtml: '',
        analysisHtml: '',
        pageNo: 1,
        adoptedTags: [],
        adoptedNode: null,
      },
    ],
  };
}

let root: string;
let db: Database;
let bank: BankServiceImpl;
let saveAsPaper: (payload: unknown) => Promise<{ paperId: string; questionIds: string[] }>;

beforeEach(() => {
  handlers.clear();
  root = mkdtempSync(join(tmpdir(), '0062-save-as-paper-'));
  db = openDatabase(join(root, 'bank.db'), migrationsDir);
  bank = new BankServiceImpl(db);
  const ext = createExtServices(db);
  registerRecogIpcHandlers(
    () => ({ attachQuestions: async () => {} }) as unknown as RecogHost,
    { getDb: () => db, getBank: () => bank, getExt: () => ext },
  );
  const handler = handlers.get(IPC_CHANNELS.RECOG_SAVE_AS_PAPER);
  if (!handler) throw new Error('RECOG_SAVE_AS_PAPER handler 未注册');
  saveAsPaper = (p: unknown) => Promise.resolve(handler({}, p)) as Promise<{ paperId: string; questionIds: string[] }>;
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('0062 recog.saveAsPaper：stage 形验 + 透传落库', () => {
  it('a) 带 stage 存为试卷：入参落列 + 按该学段筛命中', async () => {
    const result = await saveAsPaper(payload('高中'));
    expect(result.questionIds).toHaveLength(1);
    const questionId = result.questionIds[0]!;

    const row = db.prepare('SELECT stage FROM questions WHERE id = ?').get(questionId) as { stage: string | null };
    expect(row.stage).toBe('高中');
    expect((await bank.listQuestions({ stage: '高中' })).map((q) => q.id)).toEqual([questionId]);
    expect(await bank.listQuestions({ stage: '初中' })).toEqual([]);
  });

  it('b) 缺省 stage（旧调用方）：落 NULL，不报错（零影响）', async () => {
    const result = await saveAsPaper(payload(undefined));
    const questionId = result.questionIds[0]!;

    const row = db.prepare('SELECT stage FROM questions WHERE id = ?').get(questionId) as { stage: string | null };
    expect(row.stage).toBeNull();
    expect((await bank.listQuestions({ stage: '未分组' })).map((q) => q.id)).toEqual([questionId]);
  });

  it('c) 形验：stage 非字符串 → 显式拒绝，零入库（不静默丢弃）', async () => {
    await expect(saveAsPaper(payload(123))).rejects.toThrow('Invalid payload.stage');
    const questions = db.prepare('SELECT COUNT(*) AS n FROM questions').get() as { n: number };
    const papers = db.prepare('SELECT COUNT(*) AS n FROM papers').get() as { n: number };
    expect(questions.n).toBe(0);
    expect(papers.n).toBe(0);
  });
});
