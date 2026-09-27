// 0054 目检反馈（2026-09-23 第三轮）：题库题卡要显示「标签 + 知识点」，且不区分来源。
//
// 背景：题库题卡原先只渲染 `questions.knowledge_points`（**采集链**写入的站点知识点原文）；
// 本地录入 / AI 建议产生的两类数据都落库但不上屏——
//   · 标签 → `question_tags`（addTag：AI 打标建议 / 批量打标 / 手动）
//   · 知识点 → `question_node_links`（linkQuestion：录题台采纳、AI 节点建议、采集挂树反查）
// 本用例锁读侧接口：`listQuestions` / `getQuestion` 回填 `Question.tags`（只增字段）。
// 真 SQLite（BankServiceImpl）；mock 镜像语义由 test/app 侧 UI 用例覆盖。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BankService } from '../../src/shared/contracts/bank-types.js';
import { openDatabase } from '../../src/bank/db.js';
import { BankServiceImpl } from '../../src/bank/bank-service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '../../src/bank/migrations');

function makeQuestionData(content: string) {
  return {
    subject: '物理',
    sourceType: 'local' as const,
    sourceDetail: { origin: 'test' },
    content,
    images: [],
  };
}

describe('0054 题目标签读侧（question_tags → Question.tags）', () => {
  let tempDir: string;
  let db: ReturnType<typeof openDatabase>;
  let bank: BankService;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mofang-0054-qtags-'));
    db = openDatabase(join(tempDir, 'test.db'), migrationsDir);
    bank = new BankServiceImpl(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('listQuestions 回填每题的标签（本地录入 / AI 建议写入的都算，无标签则不产生该字段）', async () => {
    const tagged = await bank.createQuestion(makeQuestionData('带标签题'));
    const bare = await bank.createQuestion(makeQuestionData('无标签题'));
    await bank.addTag(tagged.id, '受力分析');
    await bank.addTag(tagged.id, '蹦极');

    const list = await bank.listQuestions();
    const byId = new Map(list.map((q) => [q.id, q] as const));
    expect(byId.get(tagged.id)!.tags).toEqual(['蹦极', '受力分析'].sort());
    expect(byId.get(bare.id)!.tags).toBeUndefined();
  });

  it('getQuestion 同样回填（单题视图一致口径）', async () => {
    const q = await bank.createQuestion(makeQuestionData('单题'));
    await bank.addTag(q.id, '力学');

    const one = await bank.getQuestion(q.id);
    expect(one?.tags).toEqual(['力学']);
  });

  it('标签筛选（QuestionFilter.tag）与回填并存：命中题的 tags 是全量而非仅筛选词', async () => {
    const q = await bank.createQuestion(makeQuestionData('双标签题'));
    await bank.addTag(q.id, '力学');
    await bank.addTag(q.id, '易错');

    const hit = await bank.listQuestions({ tag: '力学' });
    expect(hit.map((x) => x.id)).toEqual([q.id]);
    expect(hit[0]!.tags).toEqual(['力学', '易错']);
  });

  it('removeTag 后回填随之减少；软删题不出现在列表（列表口径不变）', async () => {
    const q = await bank.createQuestion(makeQuestionData('增删题'));
    await bank.addTag(q.id, '甲');
    await bank.addTag(q.id, '乙');
    await bank.removeTag(q.id, '甲');
    expect((await bank.listQuestions()).find((x) => x.id === q.id)!.tags).toEqual(['乙']);

    await bank.deleteQuestion(q.id);
    expect((await bank.listQuestions()).some((x) => x.id === q.id)).toBe(false);
  });

  it('采集链写入的 knowledgePoints 与标签互不干扰（两个字段并存）', async () => {
    const q = await bank.createQuestion({ ...makeQuestionData('采集题'), knowledgePoints: ['动量守恒定律'] });
    await bank.addTag(q.id, 'AI建议标签');

    const row = (await bank.listQuestions()).find((x) => x.id === q.id)!;
    expect(row.knowledgePoints).toEqual(['动量守恒定律']);
    expect(row.tags).toEqual(['AI建议标签']);
  });
});
