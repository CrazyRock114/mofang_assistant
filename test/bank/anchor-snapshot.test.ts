// 0024 P1：锚点快照导出（真库 SQLite 只读）——路径完整性/ID 携带/学段学科版本过滤/显式空态/只读不落日志
// 口径依据：任务书 §一 P1 + §四 TDD；P-10 并集口径（dict_entries + tree_nodes），不改 schema。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDatabase, type Database } from '../../src/bank/db.js';
import { DictServiceImpl } from '../../src/bank/dict-service.js';
import { TreeServiceImpl } from '../../src/bank/tree-service.js';
import { AnchorSnapshotServiceImpl } from '../../src/bank/anchor-snapshot-service.js';
import { TREE_ARCHIVE_SUFFIX } from '../../src/bank/tree-consolidation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '../../src/bank/migrations');

interface Ctx {
  tempDir: string;
  db: Database;
  dict: DictServiceImpl;
  tree: TreeServiceImpl;
  anchor: AnchorSnapshotServiceImpl;
  cleanup: () => void;
}

/** 种子字典（可关：空字典态用例需要「有树无字典」） */
async function seedDict(dict: DictServiceImpl): Promise<void> {
  await dict.createEntry({ kind: 'subject', code: 'physics', label: '物理' });
  await dict.createEntry({ kind: 'subject', code: 'physics', label: 'physics2', site: 'jyeoo', sourceLabel: 'physics2' });
  await dict.createEntry({ kind: 'question_type', code: 'single-choice', label: '单选题' });
  await dict.createEntry({ kind: 'difficulty', code: 'medium', label: '中等' });
}

function createCtx(seed = true): Ctx {
  const tempDir = mkdtempSync(join(tmpdir(), 'anchor-snapshot-'));
  const db = openDatabase(join(tempDir, 'test.db'), migrationsDir);
  const ctx: Ctx = {
    tempDir,
    db,
    dict: new DictServiceImpl(db),
    tree: new TreeServiceImpl(db),
    anchor: new AnchorSnapshotServiceImpl(db),
    cleanup: () => {
      db.close();
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
  return ctx;
}

function logCount(db: Database): number {
  const row = db.prepare('SELECT COUNT(*) AS c FROM operation_log').get() as { c: number };
  return row.c;
}

describe('0024 P1 锚点快照导出', () => {
  let ctx: Ctx;
  let dict: DictServiceImpl;
  let tree: TreeServiceImpl;
  let anchor: AnchorSnapshotServiceImpl;

  beforeEach(async () => {
    ctx = createCtx();
    dict = ctx.dict;
    tree = ctx.tree;
    anchor = ctx.anchor;
    await seedDict(dict);
  });

  afterEach(() => ctx.cleanup());

  it('多层级树：全路径（根→叶名称链）+ 节点 ID 逐一携带 + 只读不写 operation_log', async () => {
    const t1 = await tree.createTree({
      type: 'knowledge', name: '组卷网·知识点·初中物理', subjectId: 'subj:physics',
      stage: '初中', edition: '人教版（2024）', source: 'zujuan',
    });
    const root = await tree.createNode({ treeId: t1.id, name: '力学', sort: 0 });
    const child = await tree.createNode({ treeId: t1.id, parentId: root.id, name: '摩擦力', sort: 0 });
    const grand = await tree.createNode({ treeId: t1.id, parentId: child.id, name: '静摩擦力', sort: 0 });
    const second = await tree.createNode({ treeId: t1.id, name: '电学', sort: 1 });

    const before = logCount(ctx.db);
    const snap = await anchor.getAnchorSnapshot({ stage: '初中', subjectId: 'subj:physics' });
    expect(logCount(ctx.db)).toBe(before); // 只读：不写 operation_log

    expect(snap.empty).toBe(false);
    expect(snap.emptyReason).toBeNull();
    expect(snap.trees.map((t) => t.id)).toEqual([t1.id]);
    expect(snap.trees[0]!.subjectKey).toBe('physics');

    const byId = new Map(snap.nodes.map((n) => [n.id, n]));
    expect([...byId.keys()].sort()).toEqual([root.id, child.id, grand.id, second.id].sort());
    expect(byId.get(grand.id)!.path).toEqual(['力学', '摩擦力', '静摩擦力']);
    expect(byId.get(child.id)!.path).toEqual(['力学', '摩擦力']);
    expect(byId.get(root.id)!.path).toEqual(['力学']);
    expect(byId.get(second.id)!.path).toEqual(['电学']);
    expect(byId.get(grand.id)!.treeId).toBe(t1.id);

    // 字典腿：归一行进白名单，站点同义行不进（原文→标准映射不是锚点）
    expect(snap.dict.subjects.map((e) => e.id)).toEqual(['subj:physics']);
    expect(snap.dict.questionTypes.map((e) => e.id)).toEqual(['qtype:single-choice']);
    expect(snap.dict.difficulties.map((e) => e.id)).toEqual(['diff:medium']);
  });

  it('学科归一：dict id / 归一 code / 中文标签 三种用户可选形态命中同一批树（含站点行反查）', async () => {
    const t = await tree.createTree({
      type: 'knowledge', name: '菁优网·知识点·初中物理·人教版（2024）八年级上',
      subjectId: 'physics2', stage: '初中', source: 'jyeoo',
    });
    await tree.createNode({ treeId: t.id, name: '机械运动', sort: 0 });

    for (const subjectId of ['subj:physics', 'physics', '物理']) {
      const snap = await anchor.getAnchorSnapshot({ stage: '初中', subjectId });
      expect(snap.trees.map((x) => x.id)).toEqual([t.id]);
      expect(snap.nodes).toHaveLength(1);
    }
  });

  it('歧义守卫：站点 segment 原文（physics2）不是用户可选形态 → 不命中（避免 politics 那类撞名并错）', async () => {
    const t = await tree.createTree({
      type: 'knowledge', name: '菁优网·知识点·初中物理·人教版（2024）八年级上',
      subjectId: 'physics2', stage: '初中', source: 'jyeoo',
    });
    await tree.createNode({ treeId: t.id, name: '机械运动', sort: 0 });

    const snap = await anchor.getAnchorSnapshot({ stage: '初中', subjectId: 'physics2' });
    expect(snap.trees).toEqual([]);
  });

  it('学段过滤：给了学段只出该学段树；不给学段=不限（各学段并集）', async () => {
    const junior = await tree.createTree({ type: 'knowledge', name: '初中物理树', subjectId: 'subj:physics', stage: '初中' });
    const senior = await tree.createTree({ type: 'knowledge', name: '高中物理树', subjectId: 'subj:physics', stage: '高中' });
    const jn = await tree.createNode({ treeId: junior.id, name: '声现象', sort: 0 });
    const sn = await tree.createNode({ treeId: senior.id, name: '牛顿运动定律', sort: 0 });

    const j = await anchor.getAnchorSnapshot({ stage: '初中', subjectId: 'subj:physics' });
    expect(j.trees.map((t) => t.id)).toEqual([junior.id]);
    expect(j.nodes.map((n) => n.id)).toEqual([jn.id]);

    const all = await anchor.getAnchorSnapshot({ subjectId: 'subj:physics' });
    expect(all.trees.map((t) => t.id).sort()).toEqual([junior.id, senior.id].sort());
    expect(all.nodes.map((n) => n.id).sort()).toEqual([jn.id, sn.id].sort());
  });

  it('版本过滤：指定版本保留「同版本 + 未标注版本」树，标注了其他版本的树被排除', async () => {    const v2024 = await tree.createTree({ type: 'knowledge', name: '物理·2024版', subjectId: 'subj:physics', stage: '初中', edition: '人教版（2024）' });
    const noEdition = await tree.createTree({ type: 'knowledge', name: '物理·未标注版本', subjectId: 'subj:physics', stage: '初中' });
    const v2012 = await tree.createTree({ type: 'knowledge', name: '物理·2012版', subjectId: 'subj:physics', stage: '初中', edition: '人教版（2012）' });
    await tree.createNode({ treeId: v2024.id, name: 'A', sort: 0 });
    await tree.createNode({ treeId: noEdition.id, name: 'B', sort: 0 });
    await tree.createNode({ treeId: v2012.id, name: 'C', sort: 0 });

    const snap = await anchor.getAnchorSnapshot({ stage: '初中', subjectId: 'subj:physics', edition: '人教版（2024）' });
    expect(snap.trees.map((t) => t.id).sort()).toEqual([v2024.id, noEdition.id].sort());
    expect(snap.nodes.map((n) => n.path[0]).sort()).toEqual(['A', 'B']);
  });

  it('0039 归档树不进锚点清单：同组合多树收敛后只注入权威树', async () => {
    const auth = await tree.createTree({ type: 'knowledge', name: '组卷网·知识点·初中物理', subjectId: 'subj:physics', stage: '初中', source: 'zujuan' });
    const archived = await tree.createTree({ type: 'knowledge', name: `菁优网·知识点·初中物理·人教版${TREE_ARCHIVE_SUFFIX}`, subjectId: 'subj:physics', stage: '初中', source: 'jyeoo' });
    const authNode = await tree.createNode({ treeId: auth.id, name: '力学', sort: 0 });
    const archivedNode = await tree.createNode({ treeId: archived.id, name: '运动的描述', sort: 0 });

    const snap = await anchor.getAnchorSnapshot({ stage: '初中', subjectId: 'subj:physics' });
    expect(snap.trees.map((t) => t.id)).toEqual([auth.id]);
    expect(snap.nodes.map((n) => n.id)).toEqual([authNode.id]);
    expect(snap.nodes.some((n) => n.id === archivedNode.id)).toBe(false);
  });

  it('空锚点显式态：树节点为空且字典锚全空 → empty=true + 人读原因（不得静默空数组充数）', async () => {
    const bare = createCtx(false); // 新装库：未跑 collect:dict / collect:tree
    try {
      const snap = await bare.anchor.getAnchorSnapshot({ stage: '初中', subjectId: 'chemistry' });
      expect(snap.empty).toBe(true);
      expect(snap.emptyReason).toBeTruthy();
      expect(snap.emptyReason!).toContain('chemistry');
      expect(snap.emptyReason!).toContain('collect');
      expect(snap.nodes).toEqual([]);
      expect(snap.trees).toEqual([]);
      expect(snap.dict).toEqual({ subjects: [], questionTypes: [], difficulties: [] });
    } finally {
      bare.cleanup();
    }
  });

  it('空学科入参：显式空态不抛异常（调用方据此拒绝放行 AI）', async () => {
    const snap = await anchor.getAnchorSnapshot({ subjectId: '   ' });
    expect(snap.empty).toBe(true);
    expect(snap.emptyReason).toContain('学科');
  });

  it('树腿在、字典腿空：非空态但出 warnings（引导先跑 collect:dict）', async () => {
    const bare = createCtx(false);
    try {
      const t = await bare.tree.createTree({ type: 'knowledge', name: '无字典物理树', subjectId: 'subj:physics', stage: '初中' });
      await bare.tree.createNode({ treeId: t.id, name: '力学', sort: 0 });
      const snap = await bare.anchor.getAnchorSnapshot({ stage: '初中', subjectId: 'subj:physics' });
      expect(snap.empty).toBe(false);
      expect(snap.nodes).toHaveLength(1);
      expect(snap.warnings.join('')).toContain('字典');
    } finally {
      bare.cleanup();
    }
  });

  it('树腿空、字典腿在：非空态（字典锚仍在）+ warnings 提示无树', async () => {
    const snap = await anchor.getAnchorSnapshot({ stage: '初中', subjectId: 'physics' });
    expect(snap.empty).toBe(false);
    expect(snap.nodes).toEqual([]);
    expect(snap.dict.subjects).toHaveLength(1);
    expect(snap.warnings.join('')).toContain('树');
  });
});
