// 0002: 扩展服务契约测试 — 参数化跑两遍（真实 SQLite + mock 内存），两遍必须同绿
// 覆盖验收探针：tree 后代展开 / student 封存 / mistake 状态机（红→黄→绿 + U9 自动升黄）/
// exam 关联卷与无卷 / exam_scores 批量录入与查询 / 重名守卫（拍板 §6-10）/ 内置预设不可删（B11）

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import type { BankService, BankExtServices } from '../../src/shared/contracts/bank-types.js';
import { openDatabase } from '../../src/bank/db.js';
import { BankServiceImpl } from '../../src/bank/bank-service.js';
import { createExtServices } from '../../src/bank/ext-services.js';
import { MockBankService } from '../../src/bank/mock/mock-bank.js';
import { createMockExtServices } from '../../src/bank/mock/mock-ext.js';
import { MockBankStore } from '../../src/bank/mock/mock-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '../../src/bank/migrations');

interface ExtCtx {
  bank: BankService;
  ext: BankExtServices;
  cleanup: () => void;
}

const implementations: Array<{ name: string; factory: () => ExtCtx }> = [
  {
    name: 'Real (SQLite)',
    factory: () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'bank-ext-test-'));
      const db = openDatabase(join(tempDir, 'test.db'), migrationsDir);
      return {
        bank: new BankServiceImpl(db),
        ext: createExtServices(db),
        cleanup: () => {
          db.close();
          rmSync(tempDir, { recursive: true, force: true });
        },
      };
    },
  },
  {
    name: 'Mock (in-memory)',
    factory: () => {
      const store = new MockBankStore();
      return {
        bank: new MockBankService(store),
        ext: createMockExtServices(store),
        cleanup: () => {},
      };
    },
  },
];

/** 造题辅助：两实现共用的入库入参（content 必填；stemHtml 可选） */
function makeQuestionData(subject: string, content: string) {
  return {
    subject,
    sourceType: 'local' as const,
    sourceDetail: { origin: 'manual' },
    content,
    images: [],
  };
}

implementations.forEach(({ name, factory }) => {
  describe(`BankExtServices Contract Tests - ${name}`, () => {
    let ctx: ExtCtx;
    let bank: BankService;
    let ext: BankExtServices;

    beforeEach(() => {
      ctx = factory();
      bank = ctx.bank;
      ext = ctx.ext;
    });

    afterEach(() => {
      ctx.cleanup();
    });

    // ==================== Question 结构化扩展（G1/G2，需先建字典条目满足 FK） ====================

    it('0002 结构化字段：stemHtml/options/字典 id/结构化 images 读写一致', async () => {
      // 字典条目先行（questions.subject_id/type_id/difficulty_id 外键）
      await ext.dict.createEntry({ kind: 'subject', code: 'physics', label: '物理' });
      await ext.dict.createEntry({ kind: 'question_type', code: 'single', label: '单选题' });
      await ext.dict.createEntry({ kind: 'difficulty', code: '3', label: '中等' });

      const created = await bank.createQuestion({
        subject: '物理',
        subjectId: 'subj:physics',
        sourceType: 'local',
        sourceDetail: { origin: 'manual' },
        content: '<div class="question">拍扁的兼容题干</div>',
        stemHtml: '<div class="question">结构化题干</div>',
        options: [
          { label: 'A', html: '<span class="option">选项甲</span>' },
          { label: 'B', html: '<span class="option">选项乙</span>' },
        ],
        typeId: 'qtype:single',
        difficultyId: 'diff:3',
        images: [{ assetId: 'data-assets/a.png', type: 'figure', width: 100, height: 80 }],
      });

      const read = await bank.getQuestion(created.id);
      expect(read!.stemHtml).toBe('<div class="question">结构化题干</div>');
      expect(read!.options).toEqual([
        { label: 'A', html: '<span class="option">选项甲</span>' },
        { label: 'B', html: '<span class="option">选项乙</span>' },
      ]);
      expect(read!.subjectId).toBe('subj:physics');
      expect(read!.typeId).toBe('qtype:single');
      expect(read!.difficultyId).toBe('diff:3');
      expect(read!.images).toEqual([{ assetId: 'data-assets/a.png', type: 'figure', width: 100, height: 80 }]);

      // 更新回写
      const updated = await bank.updateQuestion(created.id, {
        options: [{ label: 'A', html: '<span class="option">改</span>' }],
      });
      expect(updated.options).toEqual([{ label: 'A', html: '<span class="option">改</span>' }]);
    });

    it('0002 字典外键：未知 subjectId 入库被拒（引用完整性）', async () => {
      await expect(bank.createQuestion({
        subject: '物理',
        subjectId: 'subj:nonexistent',
        sourceType: 'local',
        sourceDetail: { origin: 'manual' },
        content: '<div class="question">坏引用</div>',
        images: [],
      })).rejects.toThrow(/FOREIGN KEY|not found/i);
    });

    it('0002 QuestionFilter：subjectId / typeId 字典维度过滤（B5）', async () => {
      await ext.dict.createEntry({ kind: 'subject', code: 'physics', label: '物理' });
      await ext.dict.createEntry({ kind: 'question_type', code: 'single', label: '单选题' });
      await ext.dict.createEntry({ kind: 'question_type', code: 'calc', label: '计算题' });

      await bank.createQuestion({
        subject: '物理', subjectId: 'subj:physics', typeId: 'qtype:single',
        sourceType: 'local', sourceDetail: { origin: 'manual' },
        content: '<div class="question">字典筛选甲</div>', images: [],
      });
      await bank.createQuestion({
        subject: '物理', subjectId: 'subj:physics', typeId: 'qtype:calc',
        sourceType: 'local', sourceDetail: { origin: 'manual' },
        content: '<div class="question">字典筛选乙</div>', images: [],
      });

      const singles = await bank.listQuestions({ subjectId: 'subj:physics', typeId: 'qtype:single' });
      expect(singles.length).toBeGreaterThanOrEqual(1);
      expect(singles.every(q => q.typeId === 'qtype:single')).toBe(true);

      const none = await bank.listQuestions({ subjectId: 'subj:nonexistent' });
      expect(none).toEqual([]);
    });

    // 0014：题型多值（选择题聚合后端口径）+ 树/题型维度叠加 + typeId 兼容
    it('0014 QuestionFilter.typeIds：多值 IN + typeId 同现优先 + treeNodeId 叠加（B5 兼容）', async () => {
      await ext.dict.createEntry({ kind: 'subject', code: 'physics', label: '物理' });
      await ext.dict.createEntry({ kind: 'question_type', code: 'single-choice', label: '单选题' });
      await ext.dict.createEntry({ kind: 'question_type', code: 'multi-choice', label: '多选题' });
      await ext.dict.createEntry({ kind: 'question_type', code: 'solution', label: '解答题' });

      const makeTyped = (content: string, typeId: string) => bank.createQuestion({
        subject: '物理', subjectId: 'subj:physics', typeId,
        sourceType: 'local', sourceDetail: { origin: 'manual' },
        content: `<div class="question">${content}</div>`, images: [],
      });
      const q1 = await makeTyped('单选甲', 'qtype:single-choice');
      const q2 = await makeTyped('单选乙', 'qtype:single-choice');
      const q3 = await makeTyped('多选甲', 'qtype:multi-choice');
      await makeTyped('解答甲', 'qtype:solution');

      // 多值 IN：单选+多选命中，解答题不命中
      const both = await bank.listQuestions({ typeIds: ['qtype:single-choice', 'qtype:multi-choice'] });
      expect(both.map(q => q.id).sort()).toEqual([q1.id, q2.id, q3.id].sort());

      // 单值数组与 typeId 等价
      const onlyMulti = await bank.listQuestions({ typeIds: ['qtype:multi-choice'] });
      expect(onlyMulti.map(q => q.id)).toEqual([q3.id]);

      // typeId 兼容不回归
      const byTypeId = await bank.listQuestions({ typeId: 'qtype:single-choice' });
      expect(byTypeId.map(q => q.id).sort()).toEqual([q1.id, q2.id].sort());

      // typeId 与 typeIds 同现：typeId 优先、typeIds 忽略（0014 记档口径）
      const conflict = await bank.listQuestions({ typeId: 'qtype:multi-choice', typeIds: ['qtype:single-choice'] });
      expect(conflict.map(q => q.id)).toEqual([q3.id]);

      // 与学科维度叠加（交集）
      const crossSubject = await bank.listQuestions({ subjectId: 'subj:physics', typeIds: ['qtype:multi-choice'] });
      expect(crossSubject.map(q => q.id)).toEqual([q3.id]);

      // 与树维度叠加：子树派生 × 题型多值
      const tree = await ext.tree.createTree({ type: 'knowledge', name: '物理知识点0014' });
      const root = await ext.tree.createNode({ treeId: tree.id, name: '电学', sort: 0 });
      const child = await ext.tree.createNode({ treeId: tree.id, parentId: root.id, name: '电路', sort: 0 });
      await ext.tree.linkQuestion(q1.id, child.id); // 挂子节点
      await ext.tree.linkQuestion(q3.id, root.id);  // 挂父节点

      const byTreeMulti = await bank.listQuestions({ treeNodeId: root.id, typeIds: ['qtype:single-choice', 'qtype:multi-choice'] });
      expect(byTreeMulti.map(q => q.id).sort()).toEqual([q1.id, q3.id].sort());
      const byTreeSingle = await bank.listQuestions({ treeNodeId: root.id, typeIds: ['qtype:multi-choice'] });
      expect(byTreeSingle.map(q => q.id)).toEqual([q3.id]);

      // 未挂题节点 → 空集
      const emptyNode = await ext.tree.createNode({ treeId: tree.id, name: '空节点', sort: 1 });
      expect(await bank.listQuestions({ treeNodeId: emptyNode.id })).toEqual([]);
    });

    // 0014 目检返工 → 0062 改口径（R-066/D-076②）：学段筛题 = 题级优先、空回退树 stage、
    // 题级空未挂树归「未分组」（分区语义；旧口径「未挂树题一律隐藏」已随 questions.stage 落库作废）
    it('0014/0062 QuestionFilter.stage：题级优先 + 空回退树 + 空未挂树归「未分组」+ 与 treeNodeId 叠加 + 空串不过滤', async () => {
      const junior = await ext.tree.createTree({ type: 'knowledge', name: '初中物理树', stage: '初中' });
      const senior = await ext.tree.createTree({ type: 'knowledge', name: '高中物理树', stage: '高中' });
      const blank = await ext.tree.createTree({ type: 'knowledge', name: '未分组学段树' });
      const jNode = await ext.tree.createNode({ treeId: junior.id, name: '初中节点', sort: 0 });
      const sNode = await ext.tree.createNode({ treeId: senior.id, name: '高中节点', sort: 0 });
      const bNode = await ext.tree.createNode({ treeId: blank.id, name: '未分组节点', sort: 0 });

      const qJ = await bank.createQuestion(makeQuestionData('物理', '初中挂树题'));
      const qS = await bank.createQuestion(makeQuestionData('物理', '高中挂树题'));
      const qB = await bank.createQuestion(makeQuestionData('物理', '未分组挂树题'));
      const qNever = await bank.createQuestion(makeQuestionData('物理', '从未挂树题'));
      // 0062 新增：题级学段（挂初中树也只看题级）
      const qLevel = await bank.createQuestion({ ...makeQuestionData('物理', '题级高中挂初中树'), stage: '高中' });
      await ext.tree.linkQuestion(qJ.id, jNode.id);
      await ext.tree.linkQuestion(qS.id, sNode.id);
      await ext.tree.linkQuestion(qB.id, bNode.id);
      await ext.tree.linkQuestion(qLevel.id, jNode.id);

      const mine = new Set([qJ.id, qS.id, qB.id, qNever.id, qLevel.id]);
      const pick = (qs: Question[]): string[] => qs.map(q => q.id).filter(id => mine.has(id)).sort();

      // 题级空→回退树：初中中 qJ、高中中 qS；题级='高中' 的 qLevel 只中高中（题级优先，挂初中树不影响）
      expect(pick(await bank.listQuestions({ stage: '初中' }))).toEqual([qJ.id]);
      expect(pick(await bank.listQuestions({ stage: '高中' }))).toEqual([qLevel.id, qS.id].sort());

      // stage 为空串/缺省 = 不过滤（含未挂树题；总数不写死——mock 种子题额外存在）
      const allEmpty = await bank.listQuestions({});
      expect(allEmpty.map(q => q.id)).toContain(qNever.id);
      expect(allEmpty.length).toBeGreaterThanOrEqual(5);
      expect((await bank.listQuestions()).map(q => q.id)).toContain(qNever.id);

      // 树 stage 空值归一「未分组」：blank 树（stage 缺省）→ qB；从未挂树 → qNever 同归「未分组」
      //（mock 种子题同为「题级空 + 未挂树」，故比对本用例自造题集合；old 口径下未挂树题不命中）
      expect(pick(await bank.listQuestions({ stage: '未分组' }))).toEqual([qB.id, qNever.id].sort());

      // 与 treeNodeId 叠加：初中 ∧ 挂初中节点 → qJ；初中 ∧ 挂高中节点 → 空集
      expect(pick(await bank.listQuestions({ stage: '初中', treeNodeId: jNode.id }))).toEqual([qJ.id]);
      expect(await bank.listQuestions({ stage: '初中', treeNodeId: sNode.id })).toEqual([]);
    });

    // ==================== dict ====================

    it('字典：归一行 + 站点同义行共用标准 code，kind 过滤与激活开关', async () => {
      const subj = await ext.dict.createEntry({ kind: 'subject', code: 'physics', label: '物理' });
      const syn = await ext.dict.createEntry({ kind: 'subject', code: 'physics', label: '物理', site: 'jyeoo', sourceLabel: '物理' });

      expect(subj.site).toBeUndefined();
      expect(syn.site).toBe('jyeoo');
      expect(syn.sourceLabel).toBe('物理');

      const subjects = await ext.dict.listEntries({ kind: 'subject' });
      expect(subjects.some(e => e.id === subj.id)).toBe(true);
      expect(subjects.some(e => e.id === syn.id)).toBe(true);

      await ext.dict.updateEntry(subj.id, { active: false });
      const activeOnly = await ext.dict.listEntries({ kind: 'subject', activeOnly: true });
      expect(activeOnly.some(e => e.id === subj.id)).toBe(false);

      // U12 未知值指认归一 = 改 code（0016 P1-3 守卫适配：code 须指向已建归一行，
      // 原 'physics-new' 非归一行 → 新建归一行 'chem' 后指认；断言强度不变：仍验证 code patch 生效）
      await ext.dict.createEntry({ kind: 'subject', code: 'chem', label: '化学' });
      const updated = await ext.dict.updateEntry(syn.id, { code: 'chem' });
      expect(updated.code).toBe('chem');
    });

    it('字典：归一行 label 重名守卫 + code 部分唯一 + 站点行唯一（拍板 §6-10）', async () => {
      await ext.dict.createEntry({ kind: 'difficulty', code: '3', label: '中等' });

      // 归一行同 kind 同 label 重名 → service 守卫拒绝
      await expect(ext.dict.createEntry({ kind: 'difficulty', code: 'mid', label: '中等' }))
        .rejects.toThrow(/Duplicate normalized/);

      // 归一行同 kind 同 code（不同 label）→ 部分唯一索引拒绝
      await expect(ext.dict.createEntry({ kind: 'difficulty', code: '3', label: '中档' }))
        .rejects.toThrow(/UNIQUE|already/i);

      // 站点同义行与归一行共用 code：允许
      await expect(ext.dict.createEntry({ kind: 'difficulty', code: '3', label: '中等', site: 'xkw', sourceLabel: '中等难度' }))
        .resolves.toBeTruthy();

      // 站点行 (kind, site, source_label) 重复 → 拒绝
      await expect(ext.dict.createEntry({ kind: 'difficulty', code: '3', label: '中等', site: 'xkw', sourceLabel: '中等难度' }))
        .rejects.toThrow(/UNIQUE/i);
    });

    // ==================== tree ====================

    it('树：建树/建节点/层级组织（显式 sort 排序），根节点重名守卫', async () => {
      const tree = await ext.tree.createTree({ type: 'textbook', name: '人教版物理', subjectId: 'subj:physics', edition: '人教', stage: '高中' });

      const root = await ext.tree.createNode({ treeId: tree.id, name: '必修一', sort: 0 });
      const childA = await ext.tree.createNode({ treeId: tree.id, parentId: root.id, name: '第二章', sort: 2 });
      await ext.tree.createNode({ treeId: tree.id, parentId: root.id, name: '第一章', sort: 1 });

      const nodes = await ext.tree.getNodes(tree.id);
      expect(nodes.map(n => n.name)).toEqual(['必修一', '第一章', '第二章']); // 同级按 sort

      // 拍板 §6-10：根节点重名守卫（parent_id=NULL 时 UNIQUE 约束失效）
      await expect(ext.tree.createNode({ treeId: tree.id, name: '必修一' }))
        .rejects.toThrow(/Duplicate root/);

      // 非根节点：不同父节点下同名允许
      await expect(ext.tree.createNode({ treeId: tree.id, parentId: childA.id, name: '第二章' }))
        .resolves.toBeTruthy();
    });

    it('树：后代展开（递归，深度分层）含自身与全部后代', async () => {
      const tree = await ext.tree.createTree({ type: 'knowledge', name: '物理知识点' });
      const root = await ext.tree.createNode({ treeId: tree.id, name: '力学', sort: 0 });
      const a = await ext.tree.createNode({ treeId: tree.id, parentId: root.id, name: '牛顿定律', sort: 0 });
      await ext.tree.createNode({ treeId: tree.id, parentId: a.id, name: '连接体', sort: 0 });
      await ext.tree.createNode({ treeId: tree.id, parentId: root.id, name: '功和能', sort: 1 });

      const descendants = await ext.tree.getDescendants(root.id);
      expect(descendants.map(d => d.name)).toEqual(['力学', '牛顿定律', '功和能', '连接体']);
      expect(descendants.map(d => d.depth)).toEqual([0, 1, 1, 2]);

      const leaf = await ext.tree.getDescendants(descendants[3].id);
      expect(leaf.map(d => d.name)).toEqual(['连接体']);
    });

    it('树：题目多挂 + B5 子树派生筛选（父节点筛出子节点挂接题）', async () => {
      const tree = await ext.tree.createTree({ type: 'knowledge', name: '知识点树B' });
      const root = await ext.tree.createNode({ treeId: tree.id, name: '电学' });
      const child = await ext.tree.createNode({ treeId: tree.id, parentId: root.id, name: '电路' });

      const q1 = await bank.createQuestion(makeQuestionData('物理', '<div class="question">电学题</div>'));
      const q2 = await bank.createQuestion(makeQuestionData('物理', '<div class="question">电路题</div>'));

      // 多挂：一题挂两节点
      await ext.tree.linkQuestion(q1.id, root.id);
      await ext.tree.linkQuestion(q1.id, child.id);
      await ext.tree.linkQuestion(q2.id, child.id);

      const q1Nodes = await ext.tree.getQuestionNodes(q1.id);
      expect(q1Nodes.length).toBe(2);

      // 子树派生：筛父节点「电学」应同时命中挂在其自身与后代「电路」的题
      const byRoot = await bank.listQuestions({ treeNodeId: root.id });
      expect(byRoot.some(q => q.id === q1.id)).toBe(true);
      expect(byRoot.some(q => q.id === q2.id)).toBe(true);

      // 只筛子节点「电路」：不命中仅挂在父节点的题
      const byChild = await bank.listQuestions({ treeNodeId: child.id });
      expect(byChild.some(q => q.id === q1.id)).toBe(true);
      expect(byChild.some(q => q.id === q2.id)).toBe(true);

      await ext.tree.unlinkQuestion(q1.id, child.id);
      const afterUnlink = await ext.tree.getQuestionNodes(q1.id);
      expect(afterUnlink.length).toBe(1);
    });

    it('树：站点源映射解析 + (site, siteNodeId) 唯一（U12）', async () => {
      const tree = await ext.tree.createTree({ type: 'textbook', name: '鲁教版化学', source: 'jyeoo' });
      await ext.tree.createNode({
        treeId: tree.id, name: '第一章',
        sourceMapping: { site: 'jyeoo', siteNodeId: 'ch-1', siteNodeName: '第一章 化学反应' },
      });

      const resolved = await ext.tree.resolveSourceNode('jyeoo', 'ch-1');
      expect(resolved).not.toBeNull();
      expect(resolved!.name).toBe('第一章');

      expect(await ext.tree.resolveSourceNode('jyeoo', 'missing')).toBeNull();

      await expect(ext.tree.createNode({
        treeId: tree.id, name: '重复源节点',
        sourceMapping: { site: 'jyeoo', siteNodeId: 'ch-1' },
      })).rejects.toThrow(/UNIQUE/i);
    });

    // ==================== student / class ====================

    it('学生：封存后默认列表隐藏、可查、历史保留（B6 探针）', async () => {
      const s = await ext.student.createStudent({ name: '张三', studentNo: '2026001' });

      await ext.student.addEvent({
        studentId: s.id,
        eventType: 'note',
        occurredAt: '2026-03-01T00:00:00Z',
        payload: { eventType: 'note', text: '进步明显' },
      });

      // 封存
      const archived = await ext.student.setStudentStatus(s.id, 'archived');
      expect(archived.status).toBe('archived');

      const defaultList = await ext.student.listStudents();
      expect(defaultList.some(x => x.id === s.id)).toBe(false);

      const all = await ext.student.listStudents({ includeArchived: true });
      expect(all.some(x => x.id === s.id)).toBe(true);

      // 封存后历史不丢
      const events = await ext.student.listEvents({ studentId: s.id });
      expect(events.length).toBe(1);
      expect(events[0].payload).toEqual({ eventType: 'note', text: '进步明显' });

      // 恢复
      const restored = await ext.student.setStudentStatus(s.id, 'active');
      expect(restored.status).toBe('active');
    });

    it('分班：时期管理，开放时期拒绝重复入班，结课筛选', async () => {
      const s = await ext.student.createStudent({ name: '李四' });
      const c1 = await ext.class.createClass({ name: '高一(1)班', gradeLevel: '高一' });
      const c2 = await ext.class.createClass({ name: '高一(2)班' });

      await ext.student.enrollStudent(s.id, c1.id, '2026-02-01T00:00:00Z');
      // 同班未结束时期：拒绝重复入班
      await expect(ext.student.enrollStudent(s.id, c1.id)).rejects.toThrow(/open enrollment/);

      // 转班：结束旧时期 → 入新班
      await ext.student.endEnrollment(s.id, c1.id, '2026-06-30T00:00:00Z');
      await ext.student.enrollStudent(s.id, c2.id, '2026-07-01T00:00:00Z');

      const periods = await ext.student.getStudentClasses(s.id);
      expect(periods.length).toBe(2);
      expect(periods[0].endedAt).toBe('2026-06-30T00:00:00Z');
      expect(periods[1].className).toBe('高一(2)班');

      const roster = await ext.student.getClassStudents(c2.id);
      expect(roster.some(r => r.studentId === s.id)).toBe(true);

      await ext.class.closeClass(c1.id);
      const closed = await ext.class.listClasses({ status: 'closed' });
      expect(closed.some(c => c.id === c1.id)).toBe(true);
    });

    it('时间线：payload 类型校验 + 类别/时间范围/班级时期筛选（B6）', async () => {
      const s = await ext.student.createStudent({ name: '王五' });
      const c = await ext.class.createClass({ name: '高三(5)班' });
      await ext.student.enrollStudent(s.id, c.id, '2026-03-01T00:00:00Z');

      await ext.student.addEvent({
        studentId: s.id, eventType: 'performance', occurredAt: '2026-03-15T00:00:00Z',
        payload: { eventType: 'performance', text: '上课走神' },
      });
      await ext.student.addEvent({
        studentId: s.id, eventType: 'note', occurredAt: '2026-04-01T00:00:00Z',
        payload: { eventType: 'note', text: '家长沟通' },
      });
      // 入班之前的事件：班级时期筛除
      await ext.student.addEvent({
        studentId: s.id, eventType: 'note', occurredAt: '2026-01-01T00:00:00Z',
        payload: { eventType: 'note', text: '入班前记录' },
      });

      // payload/eventType 错配拒绝（service 校验）
      await expect(ext.student.addEvent({
        studentId: s.id, eventType: 'performance', occurredAt: '2026-04-02T00:00:00Z',
        payload: { eventType: 'note', text: '错配' },
      })).rejects.toThrow(/mismatch/);

      // 必填缺失拒绝
      await expect(ext.student.addEvent({
        studentId: s.id, eventType: 'performance', occurredAt: '2026-04-02T00:00:00Z',
        payload: { eventType: 'performance', text: '' },
      })).rejects.toThrow(/text/);

      const byType = await ext.student.listEvents({ studentId: s.id, eventType: 'note' });
      expect(byType.length).toBe(2);

      const byRange = await ext.student.listEvents({ studentId: s.id, from: '2026-03-01T00:00:00Z', to: '2026-03-31T23:59:59Z' });
      expect(byType.length).toBeGreaterThanOrEqual(1);
      expect(byRange.length).toBe(1);
      expect(byRange[0].eventType).toBe('performance');

      // 班级时期：排除入班前事件
      const byClass = await ext.student.listEvents({ studentId: s.id, classId: c.id });
      expect(byClass.length).toBe(2);
      expect(byClass.every(e => e.occurredAt >= '2026-03-01T00:00:00Z')).toBe(true);
    });

    // ==================== mistake 状态机 ====================

    it('错题：一生一题 upsert——二次登记更新同一关系并回红（拍板 §6-1）', async () => {
      const q = await bank.createQuestion({
        ...makeQuestionData('物理', '<div class="question">旧题干</div>'),
        answer: '<p>A</p>',
        analysis: '<p>解析</p>',
      });
      const s = await ext.student.createStudent({ name: '赵六' });

      const first = await ext.mistake.recordWrong({ questionId: q.id, studentId: s.id, occurredAt: '2026-05-01T00:00:00Z' });
      expect(first.created).toBe(true);
      expect(first.mistake.stage).toBe('red');
      expect(first.mistake.snapshot.stemHtml).toBe('<div class="question">旧题干</div>');
      expect(first.mistake.snapshot.answer).toBe('<p>A</p>');

      const second = await ext.mistake.recordWrong({ questionId: q.id, studentId: s.id, occurredAt: '2026-06-01T00:00:00Z', examId: 'exam-x' });
      expect(second.created).toBe(false);
      expect(second.mistake.id).toBe(first.mistake.id); // 同一关系
      expect(second.mistake.occurredAt).toBe('2026-06-01T00:00:00Z'); // 刷新为最近一次错
      expect(second.mistake.stage).toBe('red'); // 回红
      expect(second.mistake.examId).toBe('exam-x');

      const list = await ext.mistake.listMistakes({ studentId: s.id });
      expect(list.length).toBe(1);
    });

    it('错题：状态机红→黄→绿循环切换 + 黄→绿仅手动 + 备注/删除（U2/U10）', async () => {
      const q = await bank.createQuestion(makeQuestionData('物理', '<div class="question">状态机题</div>'));
      const s = await ext.student.createStudent({ name: '孙七' });
      const { mistake } = await ext.mistake.recordWrong({ questionId: q.id, studentId: s.id, occurredAt: '2026-05-01T00:00:00Z' });

      // 点状态灯循环：red→yellow→green→red
      const yellow = await ext.mistake.cycleStage(mistake.id);
      expect(yellow.stage).toBe('yellow');
      const green = await ext.mistake.cycleStage(mistake.id);
      expect(green.stage).toBe('green');
      const backToRed = await ext.mistake.cycleStage(mistake.id);
      expect(backToRed.stage).toBe('red');

      // 手动直达（含黄→绿）
      const manualGreen = await ext.mistake.setStage(mistake.id, 'green');
      expect(manualGreen.stage).toBe('green');

      await ext.mistake.setNote(mistake.id, '计算粗心');
      const withNote = await ext.mistake.getMistake(mistake.id);
      expect(withNote!.note).toBe('计算粗心');

      await ext.mistake.deleteMistake(mistake.id);
      expect(await ext.mistake.getMistake(mistake.id)).toBeNull();

      const stageFiltered = await ext.mistake.listMistakes({ studentId: s.id, stage: 'red' });
      expect(stageFiltered.every(m => m.stage === 'red')).toBe(true);
    });

    // ==================== exam + scores + U9 ====================

    it('成绩：批量 upsert + 按考试查全班 + 缺考可空 + 事件展示流（U14 探针）', async () => {
      const s1 = await ext.student.createStudent({ name: '甲' });
      const s2 = await ext.student.createStudent({ name: '乙' });
      const exam = await ext.exam.createExam({ title: '月考一', occurredAt: '2026-04-20T00:00:00Z' });

      const count = await ext.exam.recordScores(exam.id, [
        { studentId: s1.id, score: 88, detail: { 大题1: 40 } },
        { studentId: s2.id }, // 缺考/未录
      ]);
      expect(count).toBe(2);

      // 重复批量录入：upsert 不产生重复行
      await ext.exam.recordScores(exam.id, [{ studentId: s1.id, score: 92 }]);

      const scores = await ext.exam.getExamScores(exam.id);
      expect(scores.length).toBe(2);
      expect(scores.find(x => x.studentId === s1.id)!.score).toBe(92);
      expect(scores.find(x => x.studentId === s1.id)!.detail).toEqual({ 大题1: 40 });
      expect(scores.find(x => x.studentId === s2.id)!.score).toBeUndefined();

      const studentScores = await ext.exam.getStudentScores(s1.id);
      expect(studentScores.length).toBe(1);
      expect(studentScores[0].examTitle).toBe('月考一');

      // 时间线展示流仍写 exam_score 事件（两次录入各一条，含最新成绩）
      const events = await ext.student.listEvents({ studentId: s1.id, eventType: 'exam_score' });
      expect(events.length).toBe(2);
      expect(events.some(e => e.payload.eventType === 'exam_score' && e.payload.examId === exam.id && e.payload.score === 92)).toBe(true);
    });

    it('考试登记：无卷考试——错题标红但不触发自动升黄（U9 探针）', async () => {
      const q = await bank.createQuestion(makeQuestionData('物理', '<div class="question">无卷考试题</div>'));
      const s = await ext.student.createStudent({ name: '周八' });

      const exam = await ext.exam.createExam({ title: '校外联考', occurredAt: '2026-05-10T00:00:00Z' });
      const summary = await ext.exam.recordResults(exam.id, [
        { studentId: s.id, score: 70, wrongQuestionIds: [q.id] },
      ]);

      expect(summary.scoresUpserted).toBe(1);
      expect(summary.mistakesCreated).toBe(1);
      expect(summary.autoPromotedToYellow).toBe(0);
      expect(summary.promotedStudents).toBe(0); // 无卷不触发

      const mistakes = await ext.mistake.listMistakes({ studentId: s.id });
      expect(mistakes.length).toBe(1);
      expect(mistakes[0].stage).toBe('red');
      expect(mistakes[0].examId).toBe(exam.id);
    });

    it('考试登记：关联统一卷——未勾错视为做对，红升黄、黄只刷时间不升绿（U9 探针）', async () => {
      // 题目 ×3
      const q1 = await bank.createQuestion(makeQuestionData('物理', '<div class="question">Q1</div>'));
      const q2 = await bank.createQuestion(makeQuestionData('物理', '<div class="question">Q2</div>'));
      const q3 = await bank.createQuestion(makeQuestionData('物理', '<div class="question">Q3</div>'));

      // 统一卷：q1+q2+q3
      const paper = await bank.createPaper('期中统一卷');
      await bank.addQuestion(paper.id, q1.id);
      await bank.addQuestion(paper.id, q2.id);
      await bank.addQuestion(paper.id, q3.id);

      // 集合 + 考试关联
      const set = await ext.paperSet.createPaperSet({ name: '期中卷集合', type: 'uniform' });
      await ext.paperSet.addPaper(set.id, paper.id);
      const exam = await ext.exam.createExam({ title: '期中考试', occurredAt: '2026-06-01T00:00:00Z', paperSetId: set.id });

      const s = await ext.student.createStudent({ name: '吴九' });

      // 预置：q2=红（旧错题）、q3=黄（上次已订正）
      await ext.mistake.recordWrong({ questionId: q2.id, studentId: s.id, occurredAt: '2026-03-01T00:00:00Z' });
      const oldYellow = await ext.mistake.recordWrong({ questionId: q3.id, studentId: s.id, occurredAt: '2026-03-01T00:00:00Z' });
      await ext.mistake.setStage(oldYellow.mistake.id, 'yellow');

      const summary = await ext.exam.recordResults(exam.id, [
        { studentId: s.id, score: 85, wrongQuestionIds: [q1.id] }, // 只勾 q1
      ]);

      expect(summary.scoresUpserted).toBe(1);
      expect(summary.mistakesCreated).toBe(1); // q1 新红
      expect(summary.autoPromotedToYellow).toBe(1); // q2 红→黄
      expect(summary.promotedStudents).toBe(1);

      const mistakes = await ext.mistake.listMistakes({ studentId: s.id });
      const mQ1 = mistakes.find(m => m.questionId === q1.id)!;
      const mQ2 = mistakes.find(m => m.questionId === q2.id)!;
      const mQ3 = mistakes.find(m => m.questionId === q3.id)!;

      // q1：本次勾错 → 红 + 来源卷
      expect(mQ1.stage).toBe('red');
      expect(mQ1.sourcePaperId).toBe(paper.id);
      expect(mQ1.examId).toBe(exam.id);

      // q2：卷中未勾错=做对 → 红自动升黄 + lastCorrectAt
      expect(mQ2.stage).toBe('yellow');
      expect(mQ2.lastCorrectAt).toBe('2026-06-01T00:00:00Z');

      // q3：已黄且未勾错 → 重复做对不升级（保持黄），仅刷新 lastCorrectAt
      expect(mQ3.stage).toBe('yellow');
      expect(mQ3.lastCorrectAt).toBe('2026-06-01T00:00:00Z');
    });

    it('考试登记：定制错题卷集合——每生只按各自卷判定，无卷学生不触发（U7/U9）', async () => {
      const q1 = await bank.createQuestion(makeQuestionData('物理', '<div class="question">甲卷题</div>'));
      const q3 = await bank.createQuestion(makeQuestionData('物理', '<div class="question">乙卷题</div>'));

      const paperA = await bank.createPaper('甲定制卷');
      await bank.addQuestion(paperA.id, q1.id);
      const paperB = await bank.createPaper('乙定制卷');
      await bank.addQuestion(paperB.id, q3.id);

      const stuA = await ext.student.createStudent({ name: '甲生' });
      const stuB = await ext.student.createStudent({ name: '乙生' });
      const stuC = await ext.student.createStudent({ name: '丙生（无卷）' });

      const set = await ext.paperSet.createPaperSet({ name: '错题定制集合', type: 'custom-mistake' });
      await ext.paperSet.addPaper(set.id, paperA.id, stuA.id);
      await ext.paperSet.addPaper(set.id, paperB.id, stuB.id);

      const exam = await ext.exam.createExam({ title: '错题重测', occurredAt: '2026-07-01T00:00:00Z', paperSetId: set.id });

      // 丙生对乙卷题有历史红错题，但丙生在该集合中无卷 → 不触发升黄
      await ext.mistake.recordWrong({ questionId: q3.id, studentId: stuC.id, occurredAt: '2026-05-01T00:00:00Z' });

      const summary = await ext.exam.recordResults(exam.id, [
        { studentId: stuA.id, wrongQuestionIds: [q1.id] },
        { studentId: stuC.id, score: 60 },
      ]);

      expect(summary.mistakesCreated).toBe(1); // 仅甲生 q1
      expect(summary.autoPromotedToYellow).toBe(0);
      expect(summary.promotedStudents).toBe(0);

      const cMistake = await ext.mistake.listMistakes({ studentId: stuC.id });
      expect(cMistake[0].stage).toBe('red'); // 未被触发升级

      const ref = await ext.paperSet.getStudentPaper(set.id, stuA.id);
      expect(ref!.paperId).toBe(paperA.id);
    });

    // ==================== paper set / paper ext / preset ====================

    it('试卷集合：加/移除/查询/删集合不伤卷（U7/B11）', async () => {
      const paper = await bank.createPaper('集合内测卷');
      const set = await ext.paperSet.createPaperSet({ name: '集合A', type: 'uniform', batchMeta: { exam: '期末' } });

      await ext.paperSet.addPaper(set.id, paper.id);
      await ext.paperSet.addPaper(set.id, paper.id); // 幂等

      let refs = await ext.paperSet.getSetPapers(set.id);
      expect(refs.length).toBe(1);
      expect(refs[0].studentId).toBeUndefined();

      await ext.paperSet.removePaper(set.id, paper.id);
      refs = await ext.paperSet.getSetPapers(set.id);
      expect(refs.length).toBe(0);

      await ext.paperSet.addPaper(set.id, paper.id);
      await ext.paperSet.deletePaperSet(set.id);
      expect(await ext.paperSet.getPaperSet(set.id)).toBeNull();
      // 引用的卷保留
      expect((await bank.getPaper(paper.id))!.id).toBe(paper.id);
    });

    it('Paper 状态机：合法流转 + 非法迁移拒绝 + archived 单轨（拍板 §6-2）', async () => {
      const paper = await ext.paper.createPaperEx('状态机卷', {}, { paperType: 'custom-mistake' });
      expect(paper.status).toBe('basket');
      expect(paper.paperType).toBe('custom-mistake');
      expect(paper.archived).toBe(false);

      await ext.paper.updatePaperStatus(paper.id, 'composing');
      await ext.paper.updatePaperStatus(paper.id, 'basket'); // composing↔basket 可返
      await ext.paper.updatePaperStatus(paper.id, 'composing');
      await ext.paper.updatePaperStatus(paper.id, 'done');
      await ext.paper.updatePaperStatus(paper.id, 'archived');

      // archived 单轨：读侧派生
      expect((await bank.getPaper(paper.id))).toBeNull(); // archived 默认不可见
      const summaries = await bank.listPapers();
      expect(summaries.some(s => s.paper.id === paper.id)).toBe(false);

      // 非法迁移：basket → done
      const paper2 = await ext.paper.createPaperEx('非法迁移卷');
      await expect(ext.paper.updatePaperStatus(paper2.id, 'done')).rejects.toThrow(/Illegal paper status/);
    });

    it('版式定稿：layoutConfig 写入后读回一致（version 化拷贝）', async () => {
      const paper = await ext.paper.createPaperEx('版式卷');
      const config = {
        version: 1 as const,
        fontSize: 11,
        fieldVisibility: { questionNo: true, score: true, answer: false, analysis: false },
        figureLayout: { mode: 'side-by-side' as const },
      };
      await ext.paper.setPaperLayoutConfig(paper.id, config);
      const readBack = await bank.getPaper(paper.id);
      expect(readBack!.layoutConfig).toEqual(config);
    });

    it('预设：CRUD + 内置不可删 + 用户预设软删（G7/B11）', async () => {
      const builtin = await ext.preset.createPreset({
        name: '内置-标准考试卷',
        isBuiltin: true,
        config: { version: 1, fontSize: 10.5 },
      });
      const user = await ext.preset.createPreset({
        name: '我的讲义版式',
        config: { version: 1, fontSize: 12, answerSpace: { enabled: true, style: 'lines', heightMm: 30 } },
      });

      let presets = await ext.preset.listPresets();
      expect(presets.some(p => p.id === builtin.id)).toBe(true);
      expect(presets.some(p => p.id === user.id)).toBe(true);

      const updated = await ext.preset.updatePreset(user.id, { name: '我的讲义版式v2' });
      expect(updated.name).toBe('我的讲义版式v2');

      // 内置不可删（B11）
      await expect(ext.preset.deletePreset(builtin.id)).rejects.toThrow(/Built-in/);

      // 用户预设软删：默认不可见、includeDeleted 可查
      await ext.preset.deletePreset(user.id);
      expect(await ext.preset.getPreset(user.id)).toBeNull();
      presets = await ext.preset.listPresets();
      expect(presets.some(p => p.id === user.id)).toBe(false);
      const withDeleted = await ext.preset.listPresets({ includeDeleted: true });
      expect(withDeleted.some(p => p.id === user.id)).toBe(true);
    });
  });
});
