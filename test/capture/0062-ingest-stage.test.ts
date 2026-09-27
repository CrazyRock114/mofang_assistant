// 0062（任务书 §六.4）：采集链端到端——ingest 带 stage → 真库 listQuestions({ stage }) 命中该题。
// 补上既有 test/capture/ingest.test.ts 的盲区：那里 setQuestionService 是 mock，只断言 createQuestion
// 传参（options.stage → 入参），不验真库落列与读侧命中。本文件用真 SQLite + 真 BankServiceImpl。
// 任务书：0062 任务书

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CapturedQuestion } from '../../src/shared/contracts/capture-types.js';
import { openDatabase, type Database } from '../../src/bank/db.js';
import { BankServiceImpl } from '../../src/bank/bank-service.js';
import { ingestCaptured, setQuestionService, setTreeService } from '../../src/capture/ingest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '../../src/bank/migrations');

/** 采集题最小合法现场（无网络；字段口径照 test/capture/ingest.test.ts） */
function captured(siteQuestionId: string, stem: string): CapturedQuestion {
  return {
    questionId: siteQuestionId,
    site: 'jyeoo',
    sourceUrl: `https://www.jyeoo.com/math/report/detail/${siteQuestionId}`,
    stemHtml: `<p>${stem}</p>`,
    options: [],
    answerHtml: '<p>答案</p>',
    analysisHtml: '<p>解析</p>',
    images: [],
    meta: { questionType: '解答题', difficulty: '中等' },
    rect: null,
  };
}

describe('0062 采集链端到端：ingest stage 落库 → listQuestions({ stage }) 命中', () => {
  let dir: string;
  let db: Database;
  let bankService: BankServiceImpl;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), '0062-ingest-'));
    db = openDatabase(join(dir, 'bank.db'), migrationsDir);
    bankService = new BankServiceImpl(db);
    // 与 host 同形的 ingestion 服务适配（ingest 模块级注入；照 test/capture/paper-import-db.test.ts）
    setQuestionService({
      listQuestions: () => bankService.listQuestions(),
      createQuestion: ({ data }: { data: Parameters<BankServiceImpl['createQuestion']>[0] }) =>
        bankService.createQuestion(data),
      updateQuestion: (id: string, data: Parameters<BankServiceImpl['updateQuestion']>[1]) =>
        bankService.updateQuestion(id, data),
    });
    setTreeService(null);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a) 选「高中」采集入库：真库读回 stage + 按「高中」筛命中、按「初中」筛不命中', async () => {
    const result = await ingestCaptured([captured('qsenior', '高中采集题')], { subject: '物理', stage: '高中' });
    expect(result.ok).toBe(1);
    expect(result.failed).toHaveLength(0);
    const id = result.okIds![0]!;

    // 落库实证：题面读回与列读回同值
    expect((await bankService.getQuestion(id))!.stage).toBe('高中');
    const row = db.prepare('SELECT stage FROM questions WHERE id = ?').get(id) as { stage: string | null };
    expect(row.stage).toBe('高中');

    // 读侧命中（修复前：题面无 stage 列，筛「高中」零命中）
    expect((await bankService.listQuestions({ stage: '高中' })).map((q) => q.id)).toEqual([id]);
    expect(await bankService.listQuestions({ stage: '初中' })).toEqual([]);
  });

  it('b) 不选学段采集（无 stage 选项）：落 NULL，按「未分组」可见', async () => {
    const result = await ingestCaptured([captured('qnobody', '未选学段采集题')], { subject: '物理' });
    expect(result.ok).toBe(1);
    const id = result.okIds![0]!;

    expect((await bankService.getQuestion(id))!.stage).toBeUndefined();
    expect((await bankService.listQuestions({ stage: '未分组' })).map((q) => q.id)).toEqual([id]);
  });

  it('c) 同一批两种学段混采：各自只被同学段筛中（互不串台）', async () => {
    const junior = await ingestCaptured([captured('qjunior', '初中采集题')], { subject: '物理', stage: '初中' });
    const senior = await ingestCaptured([captured('qsenior2', '高中采集题')], { subject: '物理', stage: '高中' });
    const juniorId = junior.okIds![0]!;
    const seniorId = senior.okIds![0]!;

    expect((await bankService.listQuestions({ stage: '初中' })).map((q) => q.id)).toEqual([juniorId]);
    expect((await bankService.listQuestions({ stage: '高中' })).map((q) => q.id)).toEqual([seniorId]);
  });
});
