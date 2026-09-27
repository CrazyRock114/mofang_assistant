// 0054（R-045③④）：一题多知识节点——数据层前提与用户可见结果（真 SQLite）。
//
// 锁 0054 目检口径「入库后按任一已挂节点筛选都能找到该题」的数据链：
//   linkQuestion ×N → question_node_links 多行 → getQuestionNodes 全量回读 → listQuestions({treeNodeId}) 逐节点命中。
// 数据层本就支持多挂（0002 B3 / INSERT OR IGNORE），本单未改数据层；此用例是该语义的回归护栏。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BankExtServices, BankService } from '../../src/shared/contracts/bank-types.js';
import { openDatabase } from '../../src/bank/db.js';
import { BankServiceImpl } from '../../src/bank/bank-service.js';
import { createExtServices } from '../../src/bank/ext-services.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '../../src/bank/migrations');

function makeQuestionData(subject: string, content: string) {
  return {
    subject,
    sourceType: 'local' as const,
    sourceDetail: { origin: 'scan' },
    content,
    images: [],
  };
}

describe('0054 一题多知识节点 — 真 SQLite', () => {
  let tempDir: string;
  let db: ReturnType<typeof openDatabase>;
  let bank: BankService;
  let ext: BankExtServices;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mofang-0054-nodes-'));
    db = openDatabase(join(tempDir, 'test.db'), migrationsDir);
    bank = new BankServiceImpl(db);
    ext = createExtServices(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function seed(): Promise<{ qId: string; nodeA: string; nodeB: string; nodeC: string }> {
    const tree = await ext.tree.createTree({ type: 'knowledge', name: '组卷网·知识点·初中物理', stage: '初中' });
    const root = await ext.tree.createNode({ treeId: tree.id, name: '力学', sort: 0 });
    const child = await ext.tree.createNode({ treeId: tree.id, parentId: root.id, name: '浮力', sort: 0 });
    const other = await ext.tree.createNode({ treeId: tree.id, name: '电学', sort: 1 });
    const question = await bank.createQuestion(makeQuestionData('物理', '多节点题'));
    return { qId: question.id, nodeA: root.id, nodeB: child.id, nodeC: other.id };
  }

  it('linkQuestion ×2 → getQuestionNodes 回读两节点（有序）；未挂节点不在列', async () => {
    const { qId, nodeA, nodeB, nodeC } = await seed();
    await ext.tree.linkQuestion(qId, nodeA);
    await ext.tree.linkQuestion(qId, nodeB);

    const nodes = await ext.tree.getQuestionNodes(qId);
    expect(nodes.map((n) => n.id).sort()).toEqual([nodeA, nodeB].sort());
    expect(nodes.some((n) => n.id === nodeC)).toBe(false);
  });

  it('同节点重复挂 = 幂等（复合主键 + INSERT OR IGNORE，不留重复行）', async () => {
    const { qId, nodeA } = await seed();
    await ext.tree.linkQuestion(qId, nodeA);
    await ext.tree.linkQuestion(qId, nodeA);

    const nodes = await ext.tree.getQuestionNodes(qId);
    expect(nodes.filter((n) => n.id === nodeA)).toHaveLength(1);
  });

  it('任一已挂节点筛题都能命中原题（子树语义：父节点亦命中子节点挂的题）', async () => {
    const { qId, nodeA, nodeB, nodeC } = await seed();
    await ext.tree.linkQuestion(qId, nodeA);
    await ext.tree.linkQuestion(qId, nodeB);

    // 逐节点筛选：A（父）/ B（子，A 的子孙）都能找到该题
    expect((await bank.listQuestions({ treeNodeId: nodeA })).map((q) => q.id)).toEqual([qId]);
    expect((await bank.listQuestions({ treeNodeId: nodeB })).map((q) => q.id)).toEqual([qId]);
    // 未挂节点筛不到
    expect(await bank.listQuestions({ treeNodeId: nodeC })).toEqual([]);
  });

  it('撤销入库（软删）→ 筛题结果不再含该题；挂链行保留（软删可恢复语义，不级联）', async () => {
    const { qId, nodeA, nodeB } = await seed();
    await ext.tree.linkQuestion(qId, nodeA);
    await ext.tree.linkQuestion(qId, nodeB);

    // 0014/D1-fix-4：deleteQuestion = 软删（deleted=1，list/get 已过滤）——用户可见目标=「题库里找不到」
    await bank.deleteQuestion(qId);
    expect(await bank.listQuestions({ treeNodeId: nodeA })).toEqual([]);
    expect(await bank.listQuestions({ treeNodeId: nodeB })).toEqual([]);
    // 软删不级联删挂链（与标签同口径）：link 行仍在，恢复该题后挂载关系照旧
    expect((await ext.tree.getQuestionNodes(qId)).map((n) => n.id).sort()).toEqual([nodeA, nodeB].sort());
  });
});
