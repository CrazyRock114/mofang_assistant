// 0006-fix-2 P1：trees.subject_id 三格式并存 → 归一 subj:{code} 一次性矫正
// 真实 SQLite 探针：临时库造三格式树 + 真 dict（归一/站点行）→ 计划 → 落库 → 复查 → 重跑零变更。
// 歧义雷区锚定：菁优 segment `politics`=初中道法（morality-law）≠ 归一码 politics（高中政治）。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDatabase } from '../../src/bank/db.js';
import { DictServiceImpl } from '../../src/bank/dict-service.js';
import { TreeServiceImpl } from '../../src/bank/tree-service.js';
import {
  resolveSubjectKey, groupKeyOfSubject, subjectLabelOf, siteOfTree,
} from '../../src/bank/subject-normalize.js';
import {
  buildTreeSubjectFixPlan, applyTreeSubjectFixPlan, summarizeTreeSubjectFixPlan, applySubjectAssignments,
} from '../../src/bank/tree-subject-fix.js';
import type { DictEntry, Tree } from '../../src/shared/contracts/bank-types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '../../src/bank/migrations');

let tempDir: string;
let db: ReturnType<typeof openDatabase>;
let dict: DictServiceImpl;
let tree: TreeServiceImpl;
let entries: DictEntry[];

/** 真 dict 形态：归一行（site=NULL）+ 站点行（sourceLabel 原文 → code） */
async function seedDict() {
  await dict.createEntry({ kind: 'subject', code: 'physics', label: '物理' });
  await dict.createEntry({ kind: 'subject', code: 'politics', label: '政治' });
  await dict.createEntry({ kind: 'subject', code: 'morality-law', label: '道德与法治' });
  await dict.createEntry({ kind: 'subject', code: 'math', label: '数学' });
  // 站点行：菁优 segment（含与归一码撞名的 politics）与组卷「学段+学科」原文
  await dict.createEntry({ kind: 'subject', code: 'physics', label: 'physics2', site: 'jyeoo', sourceLabel: 'physics2' });
  await dict.createEntry({ kind: 'subject', code: 'morality-law', label: 'politics', site: 'jyeoo', sourceLabel: 'politics' });
  await dict.createEntry({ kind: 'subject', code: 'politics', label: 'politics2', site: 'jyeoo', sourceLabel: 'politics2' });
  await dict.createEntry({ kind: 'subject', code: 'math', label: 'math7', site: 'jyeoo', sourceLabel: 'math7' });
  await dict.createEntry({ kind: 'subject', code: 'physics', label: '初中物理', site: 'zujuan', sourceLabel: '初中物理' });
  entries = await dict.listEntries({ kind: 'subject' });
}

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'tree-subject-fix-'));
  db = openDatabase(join(tempDir, 'test.db'), migrationsDir);
  dict = new DictServiceImpl(db);
  tree = new TreeServiceImpl(db);
  await seedDict();
});

afterEach(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('resolveSubjectKey — 三格式 → 归一 code（歧义雷区）', () => {
  it('subj: 前缀 / 归一 code / 归一 label / 站点行原文 四种命中', () => {
    expect(resolveSubjectKey('subj:physics', 'zujuan', entries)).toBe('physics');
    expect(resolveSubjectKey('physics', 'zujuan', entries)).toBe('physics');
    expect(resolveSubjectKey('道德与法治', 'zujuan', entries)).toBe('morality-law');
    expect(resolveSubjectKey('初中物理', 'zujuan', entries)).toBe('physics');
  });

  it('politics 歧义：菁优 segment（道法）按站点行归 morality-law，不按归一码 politics', () => {
    expect(resolveSubjectKey('politics', 'jyeoo', entries)).toBe('morality-law');
    expect(resolveSubjectKey('politics2', 'jyeoo', entries)).toBe('politics');
    // 组卷站点上下文下同一原文 'politics' 无站点行 → 回落归一码（站点行优先的前提是站点已知）
    expect(resolveSubjectKey('politics', 'zujuan', entries)).toBe('politics');
  });

  it('站点行命中（segment）与查不到 → null（不猜不并）', () => {
    expect(resolveSubjectKey('physics2', 'jyeoo', entries)).toBe('physics');
    expect(resolveSubjectKey('math7', 'jyeoo', entries)).toBe('math');
    expect(resolveSubjectKey('未知学科', 'jyeoo', entries)).toBeNull();
    expect(resolveSubjectKey('未知学科', 'zujuan', entries)).toBeNull();
    expect(resolveSubjectKey(undefined, 'jyeoo', entries)).toBeNull();
  });

  it('站点来源：显式 source 优先，缺失按树名前缀兜底（歧义树 source 缺失也不并错）', () => {
    expect(siteOfTree('jyeoo', '组卷网·知识点·高中物理')).toBe('jyeoo');
    expect(siteOfTree(undefined, '菁优网·知识点·初中道法·统编版')).toBe('jyeoo');
    expect(siteOfTree(undefined, '组卷网·知识点·高中物理')).toBe('zujuan');
    expect(siteOfTree(undefined, '无站点前缀树')).toBeUndefined();
    // 树名定站后，segment 'politics' 仍按站点行归 morality-law
    expect(resolveSubjectKey('politics', siteOfTree(undefined, '菁优网·知识点·初中道法·统编版'), entries)).toBe('morality-law');
  });

  it('UI 分组键：命中归一 → code；未命中 → 剥 subj: 原文独立成组；显示名回落 code', () => {
    expect(groupKeyOfSubject('physics2', 'jyeoo', entries)).toBe('physics');
    expect(groupKeyOfSubject('物理', 'zujuan', entries)).toBe('physics');
    expect(groupKeyOfSubject('subj:physics', undefined, entries)).toBe('physics');
    expect(groupKeyOfSubject('subj:unknown-code', undefined, entries)).toBe('unknown-code');
    expect(subjectLabelOf('physics', entries)).toBe('物理');
    expect(subjectLabelOf('unknown-code', entries)).toBeUndefined();
  });
});

describe('buildTreeSubjectFixPlan / applyTreeSubjectFixPlan — 真实 SQLite 矫正探针', () => {
  /** 三格式 + 边界（已是 subj: / NULL / 查不到）混合样本 */
  async function seedTrees() {
    const t1 = await tree.createTree({ type: 'knowledge', name: '组卷网·知识点·初中物理', subjectId: 'subj:physics', stage: '初中', source: 'zujuan' });
    const t2 = await tree.createTree({ type: 'knowledge', name: '菁优网·知识点·初中物理·人教版（2024）八年级上', subjectId: 'physics2', stage: '初中', source: 'jyeoo' });
    const t3 = await tree.createTree({ type: 'knowledge', name: '组卷网·知识点·高中物理', subjectId: '物理', stage: '高中', source: 'zujuan' });
    const t4 = await tree.createTree({ type: 'knowledge', name: '菁优网·知识点·初中道法·统编版（2024）七年级上', subjectId: 'politics', stage: '初中', source: 'jyeoo' });
    const t5 = await tree.createTree({ type: 'knowledge', name: '菁优网·知识点·高中政治·统编版必修1', subjectId: 'politics2', stage: '高中', source: 'jyeoo' });
    const t6 = await tree.createTree({ type: 'knowledge', name: '组卷网·知识点·初中道德与法治', subjectId: '道德与法治', stage: '初中', source: 'zujuan' });
    const t7 = await tree.createTree({ type: 'knowledge', name: '菁优网·知识点·未知学科·某版', subjectId: '未知学科', stage: '初中', source: 'jyeoo' });
    const t8 = await tree.createTree({ type: 'textbook', name: '组卷网·教材·初中物理·人教版八年级上册', subjectId: undefined, stage: '初中', source: 'zujuan' });
    return { t1, t2, t3, t4, t5, t6, t7, t8 };
  }

  const subjectIdsOf = async (): Promise<Record<string, string | null>> => Object.fromEntries(
    (await tree.listTrees()).map((t) => [t.name, t.subjectId ?? null]),
  );

  it('三格式统一 subj:code：subj: 跳过 / 站点原文与中文名归一 / 查不到置 NULL 并出清单', async () => {
    const { t1, t2, t3, t4, t5, t6, t7, t8 } = await seedTrees();
    const trees = await tree.listTrees();
    const plan = buildTreeSubjectFixPlan(trees, entries);
    const byId = new Map(plan.map((p) => [p.id, p]));

    expect(byId.get(t1.id)).toMatchObject({ action: 'skip' });
    expect(byId.get(t2.id)).toMatchObject({ action: 'fix', to: 'subj:physics' });
    expect(byId.get(t3.id)).toMatchObject({ action: 'fix', to: 'subj:physics' });
    // 歧义雷区：jyeoo politics（道法）→ morality-law，politics2（高中政治）→ politics
    expect(byId.get(t4.id)).toMatchObject({ action: 'fix', to: 'subj:morality-law' });
    expect(byId.get(t5.id)).toMatchObject({ action: 'fix', to: 'subj:politics' });
    expect(byId.get(t6.id)).toMatchObject({ action: 'fix', to: 'subj:morality-law' });
    expect(byId.get(t7.id)).toMatchObject({ action: 'null', to: null });
    expect(byId.get(t8.id)).toMatchObject({ action: 'skip' }); // 本就 NULL

    const report = applyTreeSubjectFixPlan(db, plan);
    expect(report).toMatchObject({ fixed: 5, nulled: 1, nulledNames: ['菁优网·知识点·未知学科·某版'] });

    const after = await subjectIdsOf();
    expect(after['组卷网·知识点·初中物理']).toBe('subj:physics');
    expect(after['菁优网·知识点·初中物理·人教版（2024）八年级上']).toBe('subj:physics');
    expect(after['组卷网·知识点·高中物理']).toBe('subj:physics');
    expect(after['菁优网·知识点·初中道法·统编版（2024）七年级上']).toBe('subj:morality-law');
    expect(after['菁优网·知识点·高中政治·统编版必修1']).toBe('subj:politics');
    expect(after['组卷网·知识点·初中道德与法治']).toBe('subj:morality-law');
    expect(after['菁优网·知识点·未知学科·某版']).toBeNull();
    expect(after['组卷网·教材·初中物理·人教版八年级上册']).toBeNull();
    // 全库仅剩 subj: 前缀或 NULL（任务书验收标准）
    expect(Object.values(after).every((v) => v === null || v.startsWith('subj:'))).toBe(true);
  });

  it('幂等：二次构建全 skip、二次落库零变更', async () => {
    await seedTrees();
    applyTreeSubjectFixPlan(db, buildTreeSubjectFixPlan(await tree.listTrees(), entries));
    const snapshot = await subjectIdsOf();

    const plan2 = buildTreeSubjectFixPlan(await tree.listTrees(), entries);
    expect(plan2.every((p) => p.action === 'skip')).toBe(true);
    expect(summarizeTreeSubjectFixPlan(plan2)).toMatchObject({ fixed: 0, nulled: 0 });
    expect(applyTreeSubjectFixPlan(db, plan2)).toMatchObject({ fixed: 0, nulled: 0 });
    expect(await subjectIdsOf()).toEqual(snapshot);
  });

  it('树名定站点兜底：source 缺失时按「菁优网·/组卷网·」前缀定站（歧义仍按站点行解）', async () => {
    const t = await tree.createTree({ type: 'knowledge', name: '菁优网·知识点·初中道法·统编版', subjectId: 'politics', stage: '初中' });
    const plan = buildTreeSubjectFixPlan(await tree.listTrees(), entries);
    expect(plan.find((p) => p.id === t.id)).toMatchObject({ action: 'fix', to: 'subj:morality-law' });
  });

  // 人工指认：NULL 项（查不到的树）不会因补字典行自动归位（from===null 恒 skip），
  // 重采也只按树名复用不更新 subject_id——故须显式指认通道（禁脚本猜）
  it('显式指认 assign：改写 NULL/未命中项的 code（须为已建归一行）', async () => {
    const t1 = await tree.createTree({ type: 'knowledge', name: '组卷网·知识点·未知学科', subjectId: '未知学科', stage: '初中', source: 'zujuan' });
    const t2 = await tree.createTree({ type: 'knowledge', name: '组卷网·知识点·待指认', subjectId: undefined, stage: '初中', source: 'zujuan' });
    let plan = buildTreeSubjectFixPlan(await tree.listTrees(), entries);
    expect(plan.find((p) => p.id === t1.id)).toMatchObject({ action: 'null' });
    expect(plan.find((p) => p.id === t2.id)).toMatchObject({ action: 'skip' });

    plan = applySubjectAssignments(plan, [
      { tree: '组卷网·知识点·未知学科', code: 'physics' },
      { tree: t2.id, code: 'morality-law' },
    ], entries);
    expect(plan.find((p) => p.id === t1.id)).toMatchObject({ action: 'fix', to: 'subj:physics' });
    expect(plan.find((p) => p.id === t2.id)).toMatchObject({ action: 'fix', to: 'subj:morality-law' });

    const report = applyTreeSubjectFixPlan(db, plan);
    expect(report).toMatchObject({ fixed: 2, nulled: 0 });
    const after = await subjectIdsOf();
    expect(after['组卷网·知识点·未知学科']).toBe('subj:physics');
    expect(after['组卷网·知识点·待指认']).toBe('subj:morality-law');
  });

  it('显式指认守卫：code 非归一行 / 树不存在 / 树已归一 → 抛错（不静默）', () => {
    const base = buildTreeSubjectFixPlan([], entries);
    expect(() => applySubjectAssignments(base, [{ tree: '任意', code: '不存在码' }], entries))
      .toThrow(/未知归一学科码/);
    expect(() => applySubjectAssignments(base, [{ tree: '任意', code: 'physics' }], entries))
      .toThrow(/未找到树/);
  });
});
