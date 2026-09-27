// 0039 P1：树收敛（每学段×学科一套权威树）——真实 SQLite 探针
// 夹具形态：同学科「知识树 A（权威）+ 重复来源知识树 B + 教材树 C」；
// 断言：权威树判定、links 路径匹配逐条重挂、源映射重指、孤儿 link 显式留档不静默丢、幂等重跑零变更、operation_log 留痕。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDatabase } from '../../src/bank/db.js';
import { DictServiceImpl } from '../../src/bank/dict-service.js';
import { TreeServiceImpl } from '../../src/bank/tree-service.js';
import { QuestionService } from '../../src/bank/question-service.js';
import {
  TREE_ARCHIVE_SUFFIX,
  isArchivedTreeName,
  archivedNameOf,
  pickAuthoritativeTree,
  buildTreeConsolidationPlan,
  applyTreeConsolidationPlan,
  restoreArchivedTrees,
  loadTreeConsolidationInput,
} from '../../src/bank/tree-consolidation.js';
import type { Tree, TreeNode, DictEntry } from '../../src/shared/contracts/bank-types.js';
import { setQuestionService, setTreeService, ingestCaptured } from '../../src/capture/ingest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '../../src/bank/migrations');

let tempDir: string;
let db: ReturnType<typeof openDatabase>;
let tree: TreeServiceImpl;
let questions: QuestionService;
let entries: DictEntry[];

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'tree-consolidation-'));
  db = openDatabase(join(tempDir, 'test.db'), migrationsDir);
  tree = new TreeServiceImpl(db);
  questions = new QuestionService(db);
  const dict = new DictServiceImpl(db);
  await dict.createEntry({ kind: 'subject', code: 'physics', label: '物理' });
  await dict.createEntry({ kind: 'subject', code: 'math', label: '数学' });
  // 站点行：菁优 segment / 组卷「学段+学科」原文（分组须与题库页同源归一）
  await dict.createEntry({ kind: 'subject', code: 'physics', label: 'physics2', site: 'jyeoo', sourceLabel: 'physics2' });
  await dict.createEntry({ kind: 'subject', code: 'physics', label: '初中物理', site: 'zujuan', sourceLabel: '初中物理' });
  entries = await dict.listEntries({ kind: 'subject' });
});

afterEach(() => {
  setTreeService(null);
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

/** 造一棵树：path 列表（每项为根到节点的名称数组）+ 每叶子站点 id；返回树与「名称路径 → 节点」索引 */
async function seedTree(data: {
  type: 'knowledge' | 'textbook';
  name: string;
  subjectId?: string;
  stage?: string;
  source?: string;
  paths: Array<{ path: string[]; siteNodeId: string }>;
}): Promise<{ tree: Tree; nodeByPath: Map<string, TreeNode> }> {
  const created = await tree.createTree({
    type: data.type,
    name: data.name,
    ...(data.subjectId ? { subjectId: data.subjectId } : {}),
    ...(data.stage ? { stage: data.stage } : {}),
    ...(data.source ? { source: data.source } : {}),
  });
  const nodeByPath = new Map<string, TreeNode>();
  for (const p of data.paths) {
    const parentPath = p.path.slice(0, -1);
    const name = p.path[p.path.length - 1];
    const parent = p.path.length > 1 ? nodeByPath.get(parentPath.join('\u0000')) : undefined;
    if (p.path.length > 1 && !parent) throw new Error(`夹具乱序：父未建 ${parentPath.join('/')}`);
    const node = await tree.createNode({
      treeId: created.id,
      name,
      ...(parent ? { parentId: parent.id } : {}),
      sourceMapping: { site: data.source ?? 'zujuan', siteNodeId: p.siteNodeId, siteNodeName: name },
    });
    nodeByPath.set(p.path.join('\u0000'), node);
  }
  return { tree: created, nodeByPath };
}

/** 造题（挂树前的最小合法题） */
async function seedQuestion(id: string): Promise<string> {
  const created = await questions.createQuestion({
    subject: '物理',
    subjectId: 'subj:physics',
    sourceType: 'local',
    sourceDetail: { site: 'local', url: `local://${id}`, questionId: id },
    content: `<p>${id}</p>`,
    images: [],
  });
  return created.id;
}

/**
 * 主夹具：初中×物理 三棵并存树
 *   A 组卷网·知识点·初中物理（权威，6 节点）
 *   B 菁优网·知识点·初中物理·人教版（2019）（重复来源知识树，5 节点：4 路径与 A 同名 + 1 孤儿）
 *   C 组卷网·教材·初中物理·人教版八年级上册（教材树，2 节点：根同名 + 1 孤儿章节）
 */
async function seedMultiTreeFixture() {
  const A = await seedTree({
    type: 'knowledge', name: '组卷网·知识点·初中物理', subjectId: 'subj:physics', stage: '初中', source: 'zujuan',
    paths: [
      { path: ['综合库'], siteNodeId: 'a-root' },
      { path: ['综合库', '力学'], siteNodeId: 'a-lx' },
      { path: ['综合库', '力学', '牛顿运动定律'], siteNodeId: 'a-nd' },
      { path: ['综合库', '力学', '牛顿运动定律', '牛顿第二定律'], siteNodeId: 'a-nd2' },
      { path: ['综合库', '力学', '长度和时间的测量'], siteNodeId: 'a-lc' },
      { path: ['综合库', '电学'], siteNodeId: 'a-el' },
      { path: ['综合库', '电学', '欧姆定律'], siteNodeId: 'a-om' },
    ],
  });
  const B = await seedTree({
    type: 'knowledge', name: '菁优网·知识点·初中物理·人教版（2019）', subjectId: 'physics2', stage: '初中', source: 'jyeoo',
    paths: [
      { path: ['综合库'], siteNodeId: 'b-root' },
      { path: ['综合库', '力学'], siteNodeId: 'b-lx' },
      { path: ['综合库', '力学', '牛顿运动定律'], siteNodeId: 'b-nd' },
      { path: ['综合库', '力学', '牛顿运动定律', '牛顿第二定律'], siteNodeId: 'b-nd2' },
      { path: ['综合库', '力学', '摩擦力的应用'], siteNodeId: 'b-fric' },
    ],
  });
  const C = await seedTree({
    type: 'textbook', name: '组卷网·教材·初中物理·人教版八年级上册', subjectId: 'subj:physics', stage: '初中', source: 'zujuan',
    paths: [
      { path: ['综合库'], siteNodeId: 'c-root' },
      { path: ['综合库', '第一章 力'], siteNodeId: 'c-ch1' },
    ],
  });
  return { A, B, C };
}

describe('pickAuthoritativeTree — 权威树判定（知识树优先 / 教材树升格 / 唯一即权威）', () => {
  const t = (id: string, type: 'knowledge' | 'textbook', name: string, createdAt: string): Tree => ({
    id, type, name, createdAt,
  });

  it('有知识树：取节点最多者（不按创建先后）', () => {
    const pick = pickAuthoritativeTree([
      { tree: t('t1', 'knowledge', '小知识树', '2026-01-01'), nodeCount: 10 },
      { tree: t('t2', 'knowledge', '大知识树', '2026-02-01'), nodeCount: 99 },
      { tree: t('t3', 'textbook', '大教材树', '2026-03-01'), nodeCount: 500 },
    ]);
    expect(pick).toMatchObject({ reason: 'knowledge-largest', nodeCount: 99 });
    expect(pick?.tree.id).toBe('t2');
  });

  it('无知识树：最大教材树升格（type 不改写——树性质仍是教材树）', () => {
    const pick = pickAuthoritativeTree([
      { tree: t('t1', 'textbook', '教材一', '2026-01-01'), nodeCount: 10 },
      { tree: t('t2', 'textbook', '教材二', '2026-01-01'), nodeCount: 20 },
    ]);
    expect(pick).toMatchObject({ reason: 'textbook-promoted', nodeCount: 20 });
    expect(pick?.tree.id).toBe('t2');
    expect(pick?.tree.type).toBe('textbook');
  });

  it('并列大小时稳定收敛（createdAt → id 定序，不依赖入参顺序）', () => {
    const forward = pickAuthoritativeTree([
      { tree: t('t2', 'knowledge', '乙', '2026-01-02'), nodeCount: 5 },
      { tree: t('t1', 'knowledge', '甲', '2026-01-01'), nodeCount: 5 },
    ]);
    const reversed = pickAuthoritativeTree([
      { tree: t('t1', 'knowledge', '甲', '2026-01-01'), nodeCount: 5 },
      { tree: t('t2', 'knowledge', '乙', '2026-01-02'), nodeCount: 5 },
    ]);
    expect(forward?.tree.id).toBe('t1');
    expect(reversed?.tree.id).toBe('t1');
  });

  it('单棵：reason=only；空候选 null', () => {
    const pick = pickAuthoritativeTree([{ tree: t('t1', 'knowledge', '独苗', '2026-01-01'), nodeCount: 3 }]);
    expect(pick).toMatchObject({ reason: 'only' });
    expect(pickAuthoritativeTree([])).toBeNull();
  });
});

describe('归档名约定（幂等后缀）', () => {
  it('archivedNameOf 二次调用不叠加；isArchivedTreeName 只认真后缀', () => {
    const once = archivedNameOf('组卷网·知识点·初中物理');
    expect(once).toBe(`组卷网·知识点·初中物理${TREE_ARCHIVE_SUFFIX}`);
    expect(archivedNameOf(once)).toBe(once);
    expect(isArchivedTreeName(once)).toBe(true);
    expect(isArchivedTreeName('组卷网·知识点·初中物理')).toBe(false);
    // 站名前缀（菁优网·/组卷网·）不受后缀影响——siteOfTree 按前缀定站仍可用
    expect(once.startsWith('组卷网·')).toBe(true);
  });
});

describe('buildTreeConsolidationPlan — 多树夹具（知识树+重复来源树+教材树）', () => {
  it('每（学段×学科）选定权威树；冗余树列档；links 路径匹配逐条重挂；孤儿 link 显式留档', async () => {
    const { A, B, C } = await seedMultiTreeFixture();
    const q1 = await seedQuestion('q1');
    const q2 = await seedQuestion('q2');
    const q3 = await seedQuestion('q3');
    const q4 = await seedQuestion('q4');

    // q1 同时挂在 A 与 B 的同名路径（重挂后应合并为 1 条）
    await tree.linkQuestion(q1, A.nodeByPath.get('综合库\u0000力学\u0000牛顿运动定律\u0000牛顿第二定律')!.id);
    await tree.linkQuestion(q1, B.nodeByPath.get('综合库\u0000力学\u0000牛顿运动定律\u0000牛顿第二定律')!.id);
    // q2 → B 的孤儿路径；q3 → C 的孤儿路径；q4 → A（本就权威树，不动）
    await tree.linkQuestion(q2, B.nodeByPath.get('综合库\u0000力学\u0000摩擦力的应用')!.id);
    await tree.linkQuestion(q3, C.nodeByPath.get('综合库\u0000第一章 力')!.id);
    await tree.linkQuestion(q4, A.nodeByPath.get('综合库\u0000力学\u0000长度和时间的测量')!.id);

    const plan = buildTreeConsolidationPlan(loadTreeConsolidationInput(db, entries));

    expect(plan.groups).toHaveLength(1);
    const group = plan.groups[0];
    expect(group).toMatchObject({ stage: '初中', subjectKey: 'physics', authoritativeTreeId: A.tree.id, reason: 'knowledge-largest' });
    // B 的学科原文 physics2 经站点行归一到 physics —— 与 A 同组（分组同源于 UI 归一）
    expect(group.redundant.map((r) => r.id).sort()).toEqual([B.tree.id, C.tree.id].sort());
    expect(plan.ungrouped).toEqual([]);

    // 逐条核对重挂：B 的 4 条同名路径 + C 的根（综合库）→ A 对应节点
    const remapByFrom = new Map(plan.remaps.map((r) => [r.fromNodeId, r]));
    const nd2From = B.nodeByPath.get('综合库\u0000力学\u0000牛顿运动定律\u0000牛顿第二定律')!.id;
    const nd2To = A.nodeByPath.get('综合库\u0000力学\u0000牛顿运动定律\u0000牛顿第二定律')!.id;
    expect(remapByFrom.get(nd2From)).toMatchObject({ toNodeId: nd2To, linkCount: 1, path: ['综合库', '力学', '牛顿运动定律', '牛顿第二定律'] });
    expect(remapByFrom.get(C.nodeByPath.get('综合库')!.id)).toMatchObject({ toNodeId: A.nodeByPath.get('综合库')!.id });
    expect(plan.remaps).toHaveLength(5); // A 无「摩擦力的应用」「第一章 力」→ 不重挂

    // 孤儿：路径在权威树无同名节点 → 留档（树名/路径/题号/站点映射俱全，不静默丢）
    const orphanByNode = new Map(plan.orphans.map((o) => [o.nodeId, o]));
    const fric = orphanByNode.get(B.nodeByPath.get('综合库\u0000力学\u0000摩擦力的应用')!.id);
    expect(fric).toMatchObject({ path: ['综合库', '力学', '摩擦力的应用'], questionIds: [q2] });
    expect(fric?.sourceMappings).toEqual([{ site: 'jyeoo', siteNodeId: 'b-fric' }]);
    const ch1 = orphanByNode.get(C.nodeByPath.get('综合库\u0000第一章 力')!.id);
    expect(ch1).toMatchObject({ path: ['综合库', '第一章 力'], questionIds: [q3] });

    expect(plan.summary).toMatchObject({
      groupCount: 1,
      keptTrees: 1,
      archivedTrees: 2,
      remappedNodes: 5,
      orphanNodes: 2,
      orphanLinks: 2,
      ungroupedTrees: 0,
    });
  });

  it('缺学段 / 学科不可解析 → 不并组（不猜不并，列 ungrouped）', async () => {
    await seedTree({
      type: 'knowledge', name: '组卷网·知识点·无学段物理', subjectId: 'subj:physics', source: 'zujuan',
      paths: [{ path: ['综合库'], siteNodeId: 'x1' }],
    });
    await seedTree({
      type: 'knowledge', name: '组卷网·知识点·未知学科一', subjectId: '未知学科', stage: '初中', source: 'zujuan',
      paths: [{ path: ['综合库'], siteNodeId: 'x2' }],
    });
    await seedTree({
      type: 'knowledge', name: '组卷网·知识点·未知学科二', subjectId: '未知学科', stage: '初中', source: 'zujuan',
      paths: [{ path: ['综合库'], siteNodeId: 'x3' }],
    });
    // 无学科（NULL）：subjectKey 落「未分科」，亦不并组
    await seedTree({
      type: 'knowledge', name: '组卷网·知识点·空学科', stage: '初中', source: 'zujuan',
      paths: [{ path: ['综合库'], siteNodeId: 'x4' }],
    });

    const plan = buildTreeConsolidationPlan(loadTreeConsolidationInput(db, entries));
    expect(plan.groups).toEqual([]);
    expect(plan.summary.archivedTrees).toBe(0);
    expect(plan.ungrouped.map((u) => [u.name, u.reason])).toEqual([
      ['组卷网·知识点·无学段物理', '缺学段'],
      ['组卷网·知识点·未知学科一', '学科不可解析'],
      ['组卷网·知识点·未知学科二', '学科不可解析'],
      ['组卷网·知识点·空学科', '学科不可解析'],
    ]);
  });
});

describe('applyTreeConsolidationPlan — 落库（归档改名 + 重挂 + 源映射重指 + 留痕）', () => {
  it('归档两棵冗余树；q1 合并且落权威树；孤儿 link 保留不丢；源映射重指；operation_log 留痕', async () => {
    const { A, B, C } = await seedMultiTreeFixture();
    const q1 = await seedQuestion('q1');
    const q2 = await seedQuestion('q2');
    const q3 = await seedQuestion('q3');
    const q4 = await seedQuestion('q4');
    const aNd2 = A.nodeByPath.get('综合库\u0000力学\u0000牛顿运动定律\u0000牛顿第二定律')!.id;
    const bNd2 = B.nodeByPath.get('综合库\u0000力学\u0000牛顿运动定律\u0000牛顿第二定律')!.id;
    const bFric = B.nodeByPath.get('综合库\u0000力学\u0000摩擦力的应用')!.id;
    const cCh1 = C.nodeByPath.get('综合库\u0000第一章 力')!.id;
    await tree.linkQuestion(q1, aNd2);
    await tree.linkQuestion(q1, bNd2);
    await tree.linkQuestion(q2, bFric);
    await tree.linkQuestion(q3, cCh1);
    await tree.linkQuestion(q4, A.nodeByPath.get('综合库\u0000力学\u0000长度和时间的测量')!.id);

    const plan = buildTreeConsolidationPlan(loadTreeConsolidationInput(db, entries));
    const report = applyTreeConsolidationPlan(db, plan);

    expect(report).toMatchObject({
      archivedTrees: 2, keptTrees: 1, remappedNodes: 5, movedLinks: 1, mergedLinks: 1,
      sourceMappingsRepointed: 5, orphanNodes: 2, orphanLinks: 2,
    });

    // 归档：软删（不物理删）——树与节点俱在，仅名字带后缀；权威树名不动
    const allTrees = await tree.listTrees({ includeArchived: true });
    expect(allTrees).toHaveLength(3);
    const byId = new Map(allTrees.map((t) => [t.id, t]));
    expect(byId.get(A.tree.id)!.name).toBe('组卷网·知识点·初中物理');
    expect(byId.get(B.tree.id)!.name).toBe(`菁优网·知识点·初中物理·人教版（2019）${TREE_ARCHIVE_SUFFIX}`);
    expect(byId.get(C.tree.id)!.name).toBe(`组卷网·教材·初中物理·人教版八年级上册${TREE_ARCHIVE_SUFFIX}`);
    expect((await tree.getNodes(B.tree.id)).length).toBe(5); // 节点未删

    // links：q1 仅剩权威树 1 条（旧链删除 + 已存在合并）；q4 未受影响；孤儿链原样保留
    const links = db.prepare('SELECT question_id, node_id FROM question_node_links ORDER BY question_id, node_id').all() as Array<{ question_id: string; node_id: string }>;
    const rowsOf = (qid: string) => links.filter((l) => l.question_id === qid).map((l) => l.node_id);
    expect(rowsOf(q1)).toEqual([aNd2]);
    expect(rowsOf(q2)).toEqual([bFric]); // 孤儿不静默丢：链仍在归档树节点上，报告留档
    expect(rowsOf(q3)).toEqual([cCh1]);
    expect(rowsOf(q4)).toEqual([A.nodeByPath.get('综合库\u0000力学\u0000长度和时间的测量')!.id]);

    // 源映射重指：冗余树站点 id 现反查到权威树节点（采集侧归一的机制）
    const resolved = await tree.resolveSourceNode('jyeoo', 'b-nd2');
    expect(resolved).toMatchObject({ id: aNd2, treeId: A.tree.id });
    expect(await tree.resolveSourceNode('jyeoo', 'b-fric')).toMatchObject({ id: bFric }); // 孤儿映射保留（不猜不并）

    // operation_log 留痕
    const logs = db.prepare("SELECT operation_type, status, affected_count FROM operation_log WHERE operation_type = 'tree.consolidate'").all() as Array<{ operation_type: string; status: string; affected_count: number }>;
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ status: 'succeeded' });
    expect(logs[0].affected_count).toBeGreaterThan(0);

    // 报告带孤儿清单（交 0027/人工，不静默丢）
    expect(report.orphans.map((o) => o.questionIds).flat().sort()).toEqual([q2, q3].sort());
  });

  it('幂等重跑：二次计划零归档零重挂，库与其他树名不变（后缀不叠加）', async () => {
    const { A, B, C } = await seedMultiTreeFixture();
    const q2 = await seedQuestion('q2');
    await tree.linkQuestion(q2, B.nodeByPath.get('综合库\u0000力学\u0000摩擦力的应用')!.id);

    applyTreeConsolidationPlan(db, buildTreeConsolidationPlan(loadTreeConsolidationInput(db, entries)));
    const snapshot = await tree.listTrees({ includeArchived: true });

    const plan2 = buildTreeConsolidationPlan(loadTreeConsolidationInput(db, entries));
    expect(plan2.groups).toHaveLength(1);
    expect(plan2.groups[0].redundant).toEqual([]);
    expect(plan2.remaps).toEqual([]);
    expect(plan2.summary).toMatchObject({ archivedTrees: 0, remappedNodes: 0, keptTrees: 1 });

    const report2 = applyTreeConsolidationPlan(db, plan2);
    expect(report2).toMatchObject({ archivedTrees: 0, remappedNodes: 0, movedLinks: 0 });
    expect(await tree.listTrees({ includeArchived: true })).toEqual(snapshot);
    void A; void C;
  });
});

describe('listTrees 归档过滤（契约只增 includeArchived）', () => {
  it('默认不含归档树（UI 目检每科一套）；显式 includeArchived 取全量', async () => {
    const { B } = await seedMultiTreeFixture();
    applyTreeConsolidationPlan(db, buildTreeConsolidationPlan(loadTreeConsolidationInput(db, entries)));

    const visible = await tree.listTrees();
    expect(visible.map((t) => t.name)).toEqual(['组卷网·知识点·初中物理']);
    expect(visible.some((t) => t.id === B.tree.id)).toBe(false);
    expect(await tree.listTrees({ includeArchived: true })).toHaveLength(3);
    // 类型过滤与归档过滤叠加
    expect((await tree.listTrees({ type: 'textbook' })).length).toBe(0);
  });
});

describe('P2 采集侧归一 — ingest 只挂权威树', () => {
  const captured = (sourceNodeIds: Array<{ site: string; siteNodeId: string }>) => ({
    questionId: `q-${sourceNodeIds[0]?.siteNodeId ?? 'x'}`,
    site: 'zujuan' as const,
    sourceUrl: 'https://zujuan.xkw.com/test',
    stemHtml: '<p>测试题干</p>',
    options: [],
    answerHtml: '',
    analysisHtml: '',
    images: [],
    meta: { sourceNodeIds },
    rect: null,
  });

  it('重指后的站点节点 → 新题挂权威树节点；归档树孤儿节点 → warning 跳过（不挂归档树）', async () => {
    const { A, B } = await seedMultiTreeFixture();
    applyTreeConsolidationPlan(db, buildTreeConsolidationPlan(loadTreeConsolidationInput(db, entries)));
    // ingest 的 bankService 调用形态：createQuestion 包 { data }，updateQuestion 直传（与既有接线一致）
    setQuestionService({
      listQuestions: () => questions.listQuestions(),
      createQuestion: ({ data }: { data: never }) => questions.createQuestion(data),
      updateQuestion: (id: string, data: never) => questions.updateQuestion(id, data),
    });
    setTreeService(tree);

    // 重指命中：b-nd2 → 权威树 a-nd2
    const hit = await ingestCaptured([captured([{ site: 'jyeoo', siteNodeId: 'b-nd2' }])] as never, { subject: '物理' });
    expect(hit.ok).toBe(1);
    expect(hit.warnings ?? []).toEqual([]);
    const hitQuestion = (await questions.listQuestions()).find((q) => q.sourceDetail.questionId === 'q-b-nd2')!;
    const hitNodes = await tree.getQuestionNodes(hitQuestion.id);
    expect(hitNodes.map((n) => n.treeId)).toEqual([A.tree.id]);

    // 孤儿映射（b-fric 仍指向归档树 B）：warning 显式跳过，不入归档树
    const orphan = await ingestCaptured([captured([{ site: 'jyeoo', siteNodeId: 'b-fric' }])] as never, { subject: '物理' });
    expect(orphan.ok).toBe(1);
    expect(orphan.warnings?.length).toBe(1);
    expect(orphan.warnings?.[0]).toContain('归档');
    const orphanQuestion = (await questions.listQuestions()).find((q) => q.sourceDetail.questionId === 'q-b-fric')!;
    expect(await tree.getQuestionNodes(orphanQuestion.id)).toEqual([]);
    void B;
  });
});

// 用户 2026-09-18 目检口径：章节树/知识点树功能重复、收敛合理，但「未来需要时可回归」
describe('restoreArchivedTrees — 归档可回归（章节挑题保险）', () => {
  it('恢复：剥后缀 → 树即刻重新可见；operation_log 留痕；未找到/未归档项不静默', async () => {
    const { A, B, C } = await seedMultiTreeFixture();
    applyTreeConsolidationPlan(db, buildTreeConsolidationPlan(loadTreeConsolidationInput(db, entries)));
    expect((await tree.listTrees()).map((t) => t.id)).toEqual([A.tree.id]);

    // 只恢复教材树 C（章节挑题回归的最小形态）
    const report = restoreArchivedTrees(db, [C.tree.id, 'no-such-tree', A.tree.id]);
    expect(report).toMatchObject({ restored: 1 });
    expect(report.trees[0]).toMatchObject({ id: C.tree.id, name: '组卷网·教材·初中物理·人教版八年级上册', type: 'textbook' });
    expect(report.skipped).toEqual([
      { key: 'no-such-tree', reason: '未找到' },
      { key: A.tree.id, reason: '未归档' },
    ]);

    const visible = await tree.listTrees();
    expect(visible.map((t) => t.id).sort()).toEqual([A.tree.id, C.tree.id].sort());
    expect(visible.find((t) => t.id === C.tree.id)!.name).toBe('组卷网·教材·初中物理·人教版八年级上册');
    expect((await tree.getNodes(C.tree.id)).length).toBe(2); // 节点/结构俱在（数据从未物理删）
    // B 仍归档（未请求恢复）
    expect((await tree.listTrees({ includeArchived: true })).find((t) => t.id === B.tree.id)!.name).toContain(TREE_ARCHIVE_SUFFIX);

    const logs = db.prepare("SELECT status, affected_count FROM operation_log WHERE operation_type = 'tree.restore'").all() as Array<{ status: string; affected_count: number }>;
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ status: 'succeeded', affected_count: 1 });
  });

  it('幂等：二次恢复零变更（同一棵已恢复 → 未归档跳过）；再次收敛会重新归档（显式操作，dry-run 先可见）', async () => {
    const { A, B } = await seedMultiTreeFixture();
    applyTreeConsolidationPlan(db, buildTreeConsolidationPlan(loadTreeConsolidationInput(db, entries)));
    expect(restoreArchivedTrees(db, [B.tree.id]).restored).toBe(1);
    const snapshot = await tree.listTrees();
    expect(snapshot.map((t) => t.id).sort()).toEqual([A.tree.id, B.tree.id].sort());

    // 二次恢复：零变更（树已非归档态）
    const again = restoreArchivedTrees(db, [B.tree.id]);
    expect(again).toMatchObject({ restored: 0 });
    expect(again.skipped).toEqual([{ key: B.tree.id, reason: '未归档' }]);
    expect(await tree.listTrees()).toEqual(snapshot);

    // 契约（如实）：恢复是「人工显式决策」，再次跑收敛计划会按 D-050① 口径重新归档 B——
    // 收敛脚本 dry-run 恒先打印待归档清单，故不静默；防误跑靠「显式 --apply」。
    const plan = buildTreeConsolidationPlan(loadTreeConsolidationInput(db, entries));
    expect(plan.groups[0].authoritativeTreeId).toBe(A.tree.id); // A：6 节点 > B：5 节点
    expect(plan.groups[0].redundant.map((r) => r.id)).toEqual([B.tree.id]);
  });
});
