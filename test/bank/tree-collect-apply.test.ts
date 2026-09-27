// 0006 P2：树计划落库 — 真实 SQLite（TreeServiceImpl）
// 探针四场景：3 层后代展开 / resolveSourceNode 反查 / 幂等重采零增量 / ingest 挂树链路

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
  buildTreeConsolidationPlan, applyTreeConsolidationPlan, loadTreeConsolidationInput, restoreArchivedTrees,
} from '../../src/bank/tree-consolidation.js';
import { applyTreePlan, type TreePlanGroup } from '../../src/capture/tree-collect.js';
import { ingestCaptured, setQuestionService, setTreeService } from '../../src/capture/ingest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '../../src/bank/migrations');

/** 力学三层小样（结构同实抓：根→L1→L2→L3） */
function zujuanSample(): TreePlanGroup {
  return {
    name: '组卷网·知识点·初中物理',
    type: 'knowledge',
    subjectId: 'subj:physics',
    stage: '初中',
    site: 'zujuan',
    nodes: [
      { siteNodeId: '18194', name: '初中物理综合库', parentSiteNodeId: null, sort: 0 },
      { siteNodeId: '18195', name: '力学', parentSiteNodeId: '18194', sort: 0 },
      { siteNodeId: '18203', name: '长度和时间的测量', parentSiteNodeId: '18195', sort: 0 },
      { siteNodeId: '18210', name: '长度的单位', parentSiteNodeId: '18203', sort: 0 },
    ],
  };
}

describe('applyTreePlan — 真实 SQLite（0006 P2）', () => {
  let tempDir: string;
  let db: ReturnType<typeof openDatabase>;
  let tree: TreeServiceImpl;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'tree-apply-test-'));
    db = openDatabase(join(tempDir, 'test.db'), migrationsDir);
    tree = new TreeServiceImpl(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('首建：树+4 节点（root→L1→L2→L3），3 层后代展开正确', async () => {
    const report = await applyTreePlan(tree, [zujuanSample()]);
    expect(report.treesCreated).toBe(1);
    expect(report.nodesCreated).toBe(4);
    expect(report.nodesSkipped).toBe(0);

    const trees = await tree.listTrees({ type: 'knowledge' });
    expect(trees.length).toBe(1);
    const created = trees[0];
    expect(created).toMatchObject({ name: '组卷网·知识点·初中物理', subjectId: 'subj:physics', stage: '初中', source: 'zujuan' });

    // 力学后代展开（含自身，depth 分层）
    const byId = new Map((await tree.getNodes(created.id)).map((n) => [n.name, n]));
    const lx = byId.get('力学')!;
    const descendants = await tree.getDescendants(lx.id);
    expect(descendants.map((d) => `${d.depth}:${d.name}`)).toEqual(['0:力学', '1:长度和时间的测量', '2:长度的单位']);
  });

  it('resolveSourceNode 反查：site+siteNodeId → 本地节点（跨站对齐的基础）', async () => {
    await applyTreePlan(tree, [zujuanSample()]);
    const lx = await tree.resolveSourceNode('zujuan', '18195');
    expect(lx).toMatchObject({ name: '力学' });
    expect(await tree.resolveSourceNode('zujuan', '999999')).toBeNull();
    expect(await tree.resolveSourceNode('jyeoo', '18195')).toBeNull(); // 站点隔离
  });

  it('幂等重采：同计划重跑零增量；只增节点不删既有', async () => {
    const plan = [zujuanSample()];
    const first = await applyTreePlan(tree, plan);
    // 扩一个节点（增量采集形态）
    plan[0].nodes.push({ siteNodeId: '18213', name: '长度单位及换算', parentSiteNodeId: '18210', sort: 1 });
    const second = await applyTreePlan(tree, plan);
    expect(second.treesCreated).toBe(0);
    expect(second.treesReused).toBe(1);
    expect(second.nodesSkipped).toBe(4); // 既有 4 节点全部复用
    expect(second.nodesCreated).toBe(1); // 只增新节点

    const trees = await tree.listTrees({ type: 'knowledge' });
    expect(trees.length).toBe(1); // 不重建树
    expect((await tree.getNodes(trees[0].id)).length).toBe(5);
    void first;
  });

  it('同名不同 id 兄弟：第二个记 nameConflict 跳过（UNIQUE tree_id+parent_id+name 实撞）', async () => {
    const plan: TreePlanGroup = {
      name: '组卷网·教材·测试册',
      type: 'textbook',
      site: 'zujuan',
      nodes: [
        { siteNodeId: 'zj1', name: '第一章', parentSiteNodeId: null, sort: 0 },
        { siteNodeId: 'zsd1', name: '小结', parentSiteNodeId: 'zj1', sort: 0 },
        { siteNodeId: 'zsd2', name: '小结', parentSiteNodeId: 'zj1', sort: 1 }, // 同父同名不同 id
      ],
    };
    const report = await applyTreePlan(tree, [plan]);
    expect(report.nodesCreated).toBe(2);
    expect(report.nodesNameConflict).toBe(1);
    const treeRow = (await tree.listTrees({ type: 'textbook' }))[0];
    expect((await tree.getNodes(treeRow.id)).length).toBe(2);
  });
});

describe('ingest 挂树链路 — 真实 SQLite（meta.sourceNodeIds → question_node_links）', () => {
  let tempDir: string;
  let db: ReturnType<typeof openDatabase>;
  let tree: TreeServiceImpl;
  let questions: QuestionService;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ingest-link-test-'));
    db = openDatabase(join(tempDir, 'test.db'), migrationsDir);
    tree = new TreeServiceImpl(db);
    questions = new QuestionService(db);
    setTreeService(tree);
  });

  afterEach(() => {
    setTreeService(null); // 不污染其他测试的模块级注入
    setQuestionService(null as unknown as never);
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const captured = (sourceNodeIds: Array<{ site: string; siteNodeId: string }> | undefined) => ({
    questionId: '100',
    site: 'zujuan' as const,
    sourceUrl: 'https://zujuan.xkw.com/test',
    stemHtml: '<p>测试题干</p>',
    options: [],
    answerHtml: '',
    analysisHtml: '',
    images: [],
    meta: sourceNodeIds ? { sourceNodeIds } : {},
    rect: null,
  });

  it('题带站点节点 id：入库自动挂树（question_node_links 落行）', async () => {
    await applyTreePlan(tree, [zujuanSample()]);
    setQuestionService({
      listQuestions: () => questions.listQuestions(),
      createQuestion: ({ data }: { data: never }) => questions.createQuestion(data),
      updateQuestion: (id: string, data: never) => questions.updateQuestion(id, data),
    });

    const result = await ingestCaptured([captured([{ site: 'zujuan', siteNodeId: '18203' }])] as never, {
      subject: '物理',
    });
    expect(result.ok).toBe(1);
    expect(result.warnings ?? []).toEqual([]);

    const created = (await questions.listQuestions()).find((q) => q.sourceType === 'network')!;
    const linked = await tree.getQuestionNodes(created.id);
    expect(linked.map((n) => n.name)).toEqual(['长度和时间的测量']);
  });

  it('站点节点未建：warning 降级，入库不受阻', async () => {
    await applyTreePlan(tree, [zujuanSample()]);
    setQuestionService({
      listQuestions: () => questions.listQuestions(),
      createQuestion: ({ data }: { data: never }) => questions.createQuestion(data),
      updateQuestion: (id: string, data: never) => questions.updateQuestion(id, data),
    });

    const result = await ingestCaptured([captured([{ site: 'zujuan', siteNodeId: '000000' }])] as never, {
      subject: '物理',
    });
    expect(result.ok).toBe(1);
    expect(result.warnings?.length).toBe(1);
    expect(result.warnings?.[0]).toContain('站点节点未建');
  });

  it('题无 sourceNodeIds / 树服务未注入：无挂树动作零告警', async () => {
    setQuestionService({
      listQuestions: () => questions.listQuestions(),
      createQuestion: ({ data }: { data: never }) => questions.createQuestion(data),
      updateQuestion: (id: string, data: never) => questions.updateQuestion(id, data),
    });
    setTreeService(null);

    const result = await ingestCaptured([captured([{ site: 'zujuan', siteNodeId: '18195' }])] as never, {
      subject: '物理',
    });
    expect(result.ok).toBe(1);
    expect(result.warnings ?? []).toEqual([]);
  });
});

// 0039 P2：采集侧归一——建树目标收敛到（学段×学科）权威树（不再按来源另立树）
describe('0039 P2 采集侧归一 — 目标树按（学段×学科）权威树收敛', () => {
  let tempDir: string;
  let db: ReturnType<typeof openDatabase>;
  let tree: TreeServiceImpl;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'tree-converge-test-'));
    db = openDatabase(join(tempDir, 'test.db'), migrationsDir);
    tree = new TreeServiceImpl(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const consolidate = async () => {
    const dict = new DictServiceImpl(db);
    const entries = await dict.listEntries({ kind: 'subject' });
    const plan = buildTreeConsolidationPlan(loadTreeConsolidationInput(db, entries));
    return applyTreeConsolidationPlan(db, plan);
  };

  it('已有权威树（异源异名）：采集落权威树，不另立同名新树', async () => {
    await tree.createTree({ type: 'knowledge', name: '菁优网·知识点·初中物理·人教版（2019）', subjectId: 'subj:physics', stage: '初中', source: 'jyeoo' });
    const jyTree = (await tree.listTrees())[0];
    const jyRoot = await tree.createNode({ treeId: jyTree.id, name: '综合库', sourceMapping: { site: 'jyeoo', siteNodeId: 'jy-root' } });

    const report = await applyTreePlan(tree, [zujuanSample()]);
    expect(report).toMatchObject({ treesCreated: 0, treesReused: 1, nodesCreated: 4, nodesSkippedCrossTree: 0 });

    const trees = await tree.listTrees();
    expect(trees).toHaveLength(1);
    expect(trees[0].name).toBe('菁优网·知识点·初中物理·人教版（2019）'); // 权威树不被改名
    const nodes = await tree.getNodes(jyTree.id);
    expect(nodes).toHaveLength(5); // 既有 1 + 新采 4（组卷网的节点进菁优树，源映射记 zujuan）
    expect(await tree.resolveSourceNode('zujuan', '18203')).toMatchObject({ treeId: jyTree.id });
    void jyRoot;
  });

  it('同名树已归档：重跑采集落权威树（不重立同名树）；既有节点复用零增量', async () => {
    await applyTreePlan(tree, [zujuanSample()]); // A：组卷知识树（权威）
    const auth = (await tree.listTrees())[0];
    await tree.createTree({ type: 'knowledge', name: '菁优网·知识点·初中物理·人教版（2019）', subjectId: 'subj:physics', stage: '初中', source: 'jyeoo' });
    const redundant = (await tree.listTrees()).find((t) => t.source === 'jyeoo')!;
    await tree.createNode({ treeId: redundant.id, name: '综合库', sourceMapping: { site: 'jyeoo', siteNodeId: 'jy-root' } });
    const report0 = await consolidate();
    expect(report0).toMatchObject({ archivedTrees: 1, keptTrees: 1 });

    const plan = [zujuanSample()];
    plan[0].nodes.push({ siteNodeId: '18213', name: '长度单位及换算', parentSiteNodeId: '18210', sort: 1 });
    const report = await applyTreePlan(tree, plan);
    expect(report).toMatchObject({ treesCreated: 0, treesReused: 1, nodesCreated: 1, nodesSkipped: 4 });
    expect(await tree.listTrees()).toHaveLength(1);
    expect((await tree.getNodes(auth.id)).length).toBe(5);
  });

  it('父节点映射落在归档树：跨树挂载跳过并计数（不产生跨树父子）', async () => {
    await applyTreePlan(tree, [zujuanSample()]); // A：组卷知识树（权威）
    const auth = (await tree.listTrees())[0];
    const jy = await tree.createTree({ type: 'knowledge', name: '菁优网·知识点·初中物理·人教版（2019）', subjectId: 'subj:physics', stage: '初中', source: 'jyeoo' });
    const jyFric = await tree.createNode({ treeId: jy.id, name: '摩擦力的应用', parentId: undefined, sourceMapping: { site: 'jyeoo', siteNodeId: 'jy-fric' } });
    await consolidate();

    const report = await applyTreePlan(tree, [{
      name: '菁优网·知识点·初中物理·人教版（2019）',
      type: 'knowledge',
      subjectId: 'subj:physics',
      stage: '初中',
      site: 'jyeoo',
      nodes: [{ siteNodeId: 'jy-fric-child', name: '静摩擦力', parentSiteNodeId: 'jy-fric', sort: 0 }],
    }]);
    expect(report).toMatchObject({ treesCreated: 0, treesReused: 1, nodesCreated: 0, nodesSkippedCrossTree: 1 });
    const nodes = await tree.getNodes(auth.id);
    expect(nodes.some((n) => n.name === '静摩擦力')).toBe(false);
    void jyFric;
  });
});

// 0039 回归口径（用户目检 2026-09-18）：恢复教材树后，教材采集按类型优先回教材树（不被知识树吞掉）
describe('0039 回归 — 恢复教材树后采集按类型优先落树', () => {
  let tempDir: string;
  let db: ReturnType<typeof openDatabase>;
  let tree: TreeServiceImpl;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'tree-restore-collect-'));
    db = openDatabase(join(tempDir, 'test.db'), migrationsDir);
    tree = new TreeServiceImpl(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('教材树归档 → 恢复 → 教材计划落回教材树（新章节不并入知识树）', async () => {
    await applyTreePlan(tree, [zujuanSample()]); // 知识树（既有）
    const knowledge = (await tree.listTrees())[0];
    // 历史遗留教材树（0039 前按来源立树形态：直接经 service 种下，含源映射）
    const legacy = await tree.createTree({ type: 'textbook', name: '组卷网·教材·初中物理·人教版八年级上册', subjectId: 'subj:physics', stage: '初中', source: 'zujuan' });
    const legacyRoot = await tree.createNode({ treeId: legacy.id, name: '综合库', sourceMapping: { site: 'zujuan', siteNodeId: 'zj-root', siteNodeName: '综合库' } });
    await tree.createNode({ treeId: legacy.id, name: '第一章 机械运动', parentId: legacyRoot.id, sourceMapping: { site: 'zujuan', siteNodeId: 'zj-ch1', siteNodeName: '第一章 机械运动' } });

    // 收敛：知识树留、教材树归档
    const dict = new DictServiceImpl(db);
    const entries = await dict.listEntries({ kind: 'subject' });
    const report0 = applyTreeConsolidationPlan(db, buildTreeConsolidationPlan(loadTreeConsolidationInput(db, entries)));
    expect(report0).toMatchObject({ archivedTrees: 1, keptTrees: 1 });
    expect(await tree.listTrees()).toHaveLength(1);

    // 回归：恢复教材树（章节挑题功能回来）
    const restored = restoreArchivedTrees(db, [legacy.id]);
    expect(restored).toMatchObject({ restored: 1 });
    expect((await tree.listTrees()).map((t) => t.id).sort()).toEqual([knowledge.id, legacy.id].sort());

    // 再采集教材树：新章节落回教材树（同类型优先），不并入知识树
    const addChapter = await applyTreePlan(tree, [{
      name: '组卷网·教材·初中物理·人教版八年级上册',
      type: 'textbook',
      subjectId: 'subj:physics',
      stage: '初中',
      site: 'zujuan',
      nodes: [{ siteNodeId: 'zj-ch2', name: '第二章 声现象', parentSiteNodeId: 'zj-root', sort: 1 }],
    }]);
    expect(addChapter).toMatchObject({ treesCreated: 0, treesReused: 1, nodesCreated: 1 });
    const textbookNodes = await tree.getNodes(legacy.id);
    expect(textbookNodes.some((n) => n.name === '第二章 声现象')).toBe(true);
    const knowledgeNodes = await tree.getNodes(knowledge.id);
    expect(knowledgeNodes.some((n) => n.name === '第二章 声现象')).toBe(false);

    // 知识树采集仍走知识树（同类型优先不改变知识侧口径）
    const addKnowledge = await applyTreePlan(tree, [zujuanSample()]);
    expect(addKnowledge).toMatchObject({ treesCreated: 0, treesReused: 1, nodesCreated: 0, nodesSkipped: 4 });
  });
});
