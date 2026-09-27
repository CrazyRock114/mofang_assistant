// 0014 验收方独立探针（Kimi 程序化验收，2026-09-14）——与施工方测试样本零重复：
// 自建树/自命题面/自定断言角度，双跑真实 SQLite 与 mock 内存（同 ext-contract 双跑手法）。
// 覆盖：listQuestions 树过滤（子孙派生/未挂题空集/×typeIds 叠加）、typeIds 多值 IN 与 typeId 优先、
// stage 间接筛（挂树命中/未挂树不可见/空串不过滤）、app.css 与 theme.css 源码级断言。
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BankService, BankExtServices } from '../../src/shared/contracts/bank-types.js';
import { openDatabase } from '../../src/bank/db.js';
import { BankServiceImpl } from '../../src/bank/bank-service.js';
import { createExtServices } from '../../src/bank/ext-services.js';
import { MockBankService } from '../../src/bank/mock/mock-bank.js';
import { createMockExtServices } from '../../src/bank/mock/mock-ext.js';
import { MockBankStore } from '../../src/bank/mock/mock-store.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '../../src/bank/migrations');
const appCss = readFileSync(join(here, '../../src/app/app.css'), 'utf8');
const themeCss = readFileSync(join(here, '../../src/app/theme.css'), 'utf8');

/** 探针自用建题入参（不传字典 id 时零 FK 依赖） */
function qc(content: string, extra: Record<string, unknown> = {}) {
  return {
    subject: '物理',
    sourceType: 'local' as const,
    sourceDetail: { origin: 'manual' as const },
    content: `<div class="question">${content}</div>`,
    images: [],
    ...extra,
  };
}

interface ProbeCtx {
  bank: BankService;
  ext: BankExtServices;
  cleanup: () => void;
}

const impls: Array<{ name: string; factory: () => ProbeCtx }> = [
  {
    name: 'Real (SQLite)',
    factory: () => {
      const dir = mkdtempSync(join(tmpdir(), 'accept-0014-'));
      const db = openDatabase(join(dir, 'probe.db'), migrationsDir);
      return {
        bank: new BankServiceImpl(db),
        ext: createExtServices(db),
        cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); },
      };
    },
  },
  {
    name: 'Mock (in-memory)',
    factory: () => {
      const store = new MockBankStore();
      return { bank: new MockBankService(store), ext: createMockExtServices(store), cleanup: () => {} };
    },
  },
];

impls.forEach(({ name, factory }) => {
  describe(`0014 验收探针 - ${name}`, () => {
    // ---------- AC-P1：树过滤（子孙派生 / 旁支隔离 / 未挂题空集 / ×typeIds 叠加） ----------
    it('AC-P1 树过滤：父命中子孙、旁支不受累、未挂题节点空集、treeNodeId×typeIds 叠加', async () => {
      const ctx = factory();
      try {
        const { bank, ext } = ctx;
        await ext.dict.createEntry({ kind: 'question_type', code: 'single-choice', label: '单选题' });
        await ext.dict.createEntry({ kind: 'question_type', code: 'multi-choice', label: '多选题' });

        const tree = await ext.tree.createTree({ type: 'knowledge', name: '验收探针树-甲' });
        const root = await ext.tree.createNode({ treeId: tree.id, name: '验收一级' });
        const mid = await ext.tree.createNode({ treeId: tree.id, parentId: root.id, name: '验收二级' });
        const leaf = await ext.tree.createNode({ treeId: tree.id, parentId: mid.id, name: '验收三级' });
        const side = await ext.tree.createNode({ treeId: tree.id, parentId: root.id, name: '验收旁支' });
        const bare = await ext.tree.createNode({ treeId: tree.id, name: '验收无题节点' });

        const qLeaf = await bank.createQuestion(qc('验收探针题-叶挂', { typeId: 'qtype:single-choice' }));
        const qRoot = await bank.createQuestion(qc('验收探针题-根挂', { typeId: 'qtype:multi-choice' }));
        const qSide = await bank.createQuestion(qc('验收探针题-旁挂', { typeId: 'qtype:multi-choice' }));
        await ext.tree.linkQuestion(qLeaf.id, leaf.id);
        await ext.tree.linkQuestion(qRoot.id, root.id);
        await ext.tree.linkQuestion(qSide.id, side.id);

        const trio = new Set([qLeaf.id, qRoot.id, qSide.id]);
        const ids = (list: Array<{ id: string }>) => list.map((q) => q.id).sort();

        // 根节点命中自身+全部后代挂题；且不混入组外题
        const byRoot = await bank.listQuestions({ treeNodeId: root.id });
        expect(ids(byRoot)).toEqual([...trio].sort());
        // 中间节点：命中深层叶挂题，不含挂在祖先(根)自身与旁支的题
        const byMid = await bank.listQuestions({ treeNodeId: mid.id });
        expect(ids(byMid)).toEqual([qLeaf.id]);
        // 叶节点精确命中
        expect(ids(await bank.listQuestions({ treeNodeId: leaf.id }))).toEqual([qLeaf.id]);
        // 未挂题节点 → 空集
        expect(await bank.listQuestions({ treeNodeId: bare.id })).toEqual([]);
        // treeNodeId × typeIds 叠加：根子树 ∩ 多值多选题 = 根挂+旁挂
        expect(ids(await bank.listQuestions({ treeNodeId: root.id, typeIds: ['qtype:multi-choice'] })))
          .toEqual([qRoot.id, qSide.id].sort());
        expect(ids(await bank.listQuestions({ treeNodeId: root.id, typeIds: ['qtype:single-choice'] })))
          .toEqual([qLeaf.id]);
      } finally {
        ctx.cleanup();
      }
    });

    // ---------- AC-P2：typeIds 多值 IN / typeId 兼容 / 同现 typeId 优先 ----------
    it('AC-P2 typeIds 多值 IN、typeId 兼容零回归、同现时 typeId 优先（含反向组合）', async () => {
      const ctx = factory();
      try {
        const { bank, ext } = ctx;
        await ext.dict.createEntry({ kind: 'question_type', code: 'single-choice', label: '单选题' });
        await ext.dict.createEntry({ kind: 'question_type', code: 'multi-choice', label: '多选题' });
        await ext.dict.createEntry({ kind: 'question_type', code: 'solution', label: '解答题' });

        const tSingle = await bank.createQuestion(qc('验收题型-单选', { typeId: 'qtype:single-choice' }));
        const tMulti = await bank.createQuestion(qc('验收题型-多选', { typeId: 'qtype:multi-choice' }));
        const tSolution = await bank.createQuestion(qc('验收题型-解答', { typeId: 'qtype:solution' }));

        const mine = new Set([tSingle.id, tMulti.id, tSolution.id]);
        const mineIds = (list: Array<{ id: string }>) => list.filter((q) => mine.has(q.id)).map((q) => q.id).sort();

        const both = await bank.listQuestions({ typeIds: ['qtype:single-choice', 'qtype:multi-choice'] });
        expect(mineIds(both)).toEqual([tSingle.id, tMulti.id].sort());
        expect(both.every((q) => mine.has(q.id))).toBe(true); // 组外题（如 mock 种子题）不得混入

        expect(mineIds(await bank.listQuestions({ typeIds: ['qtype:solution'] }))).toEqual([tSolution.id]);

        // typeId 兼容路径零回归
        expect(mineIds(await bank.listQuestions({ typeId: 'qtype:multi-choice' }))).toEqual([tMulti.id]);

        // 同现（合同 JSDoc 记档口径：typeId 优先、typeIds 忽略）——正反两向都验
        expect(mineIds(await bank.listQuestions({ typeId: 'qtype:solution', typeIds: ['qtype:single-choice'] })))
          .toEqual([tSolution.id]);
        expect(mineIds(await bank.listQuestions({ typeId: 'qtype:single-choice', typeIds: ['qtype:multi-choice'] })))
          .toEqual([tSingle.id]);
        // 空数组 = 不过滤（不误当「全部排除」）
        const emptyArr = await bank.listQuestions({ typeIds: [] });
        expect(mineIds(emptyArr)).toEqual([tSingle.id, tMulti.id, tSolution.id].sort());
      } finally {
        ctx.cleanup();
      }
    });

    // ---------- AC-P3：stage 筛（题级优先 / 空回退树 / 空未挂树归「未分组」；0062 改口径） ----------
    it('AC-P3 stage 筛选：题级优先、空回退树、空未挂树归「未分组」、首项空串不过滤、树 stage 空归一未分组', async () => {
      const ctx = factory();
      try {
        const { bank, ext } = ctx;
        const tJunior = await ext.tree.createTree({ type: 'knowledge', name: '验收树-乙', stage: '初中' });
        const tSenior = await ext.tree.createTree({ type: 'knowledge', name: '验收树-丙', stage: '高中' });
        const tBlank = await ext.tree.createTree({ type: 'knowledge', name: '验收树-丁' });
        const nJunior = await ext.tree.createNode({ treeId: tJunior.id, name: '初中节点' });
        const nSenior = await ext.tree.createNode({ treeId: tSenior.id, name: '高中节点' });
        const nBlank = await ext.tree.createNode({ treeId: tBlank.id, name: '未分组节点' });

        const qJunior = await bank.createQuestion(qc('验收学段-初中挂树'));
        const qSenior = await bank.createQuestion(qc('验收学段-高中挂树'));
        const qBlank = await bank.createQuestion(qc('验收学段-无学段挂树'));
        const qFree = await bank.createQuestion(qc('验收学段-从未挂树'));
        // 0062（R-066/D-076② 翻案 B2）：题级学段落库——题级优先，挂初中树也只按题级算
        const qLevel = await bank.createQuestion({ ...qc('验收学段-题级高中挂初中树'), stage: '高中' });
        await ext.tree.linkQuestion(qJunior.id, nJunior.id);
        await ext.tree.linkQuestion(qSenior.id, nSenior.id);
        await ext.tree.linkQuestion(qBlank.id, nBlank.id);
        await ext.tree.linkQuestion(qLevel.id, nJunior.id);

        const ids = (list: Array<{ id: string }>) => list.map((q) => q.id).sort();
        const mine = [qJunior.id, qSenior.id, qBlank.id, qFree.id, qLevel.id];
        const pick = (list: Array<{ id: string }>) => ids(list).filter((id) => mine.includes(id));

        expect(pick(await bank.listQuestions({ stage: '初中' }))).toEqual([qJunior.id]);
        expect(pick(await bank.listQuestions({ stage: '高中' }))).toEqual([qLevel.id, qSenior.id].sort());
        // 树 stage 空值归一「未分组」可筛中；从未挂树题同归「未分组」（0062 新口径——不再隐藏，
        // 旧断言「未挂树题在任何学段下不可见」随 questions.stage 落库作废）
        expect(pick(await bank.listQuestions({ stage: '未分组' }))).toEqual([qBlank.id, qFree.id].sort());
        // 空串 / 缺省 = 不过滤：五题全可见（含从未挂树题）
        for (const list of [await bank.listQuestions({ stage: '' }), await bank.listQuestions({})]) {
          expect(pick(list)).toEqual([...mine].sort());
        }
        // 与 treeNodeId 叠加（两维度独立 AND）：题级高中 ∧ 挂初中节点 → qLevel（题级与节点互不干扰）；
        // 高中 ∧ 高中节点 → qSenior（qLevel 没挂该节点，节点筛不因题级命中而放行）
        expect(pick(await bank.listQuestions({ stage: '高中', treeNodeId: nJunior.id }))).toEqual([qLevel.id]);
        expect(ids(await bank.listQuestions({ stage: '高中', treeNodeId: nSenior.id }))).toEqual([qSenior.id]);
      } finally {
        ctx.cleanup();
      }
    });
  });
});

// ---------- AC-P4/P5：CSS 源码级断言（任务书 §一.1/§一.6 授权落点） ----------
describe('0014 验收探针 - CSS 源码级', () => {
  const block = (css: string, selectorRe: RegExp): string => {
    const m = css.match(selectorRe);
    if (!m) throw new Error(`未匹配到规则块：${selectorRe}`);
    return m[0];
  };

  it('AC-P4a app.css：块图两处硬限 min(48%, 240px)、80% 旧档已替、行内公式图规则原文未动', () => {
    const figBlock = block(appCss, /^figure\.diagram \{[\s\S]*?\}/m);
    expect(figBlock).toMatch(/max-width:\s*min\(48%,\s*240px\)/);
    expect(figBlock).not.toMatch(/80%/);

    const bareImg = block(appCss, /^img\.q-figure \{[\s\S]*?\}/m);
    expect(bareImg).toMatch(/max-width:\s*min\(48%,\s*240px\)/);
    expect(bareImg).not.toMatch(/80%/);

    // 行内公式图规则（0041 口径，2026-09-18 用户拍板对齐采集预览）：200px 封顶 + width:auto !important，
    // **无** min-height 下限档（按内在尺寸出图 = 采集预览/原站观感）
    const inline = block(appCss, /^\.inline-figure > img \{[\s\S]*?\}/m);
    expect(inline).not.toMatch(/min-height/);
    expect(inline).toMatch(/max-width:\s*200px/);
    expect(inline).toMatch(/width:\s*auto !important/);

    // figure 容器内 img 相对容器 100%（容器自身已封顶）
    const figImg = block(appCss, /^figure\.diagram > img,[\r\n\s]*figure\.diagram img\.q-figure \{[\s\S]*?\}/m);
    expect(figImg).toMatch(/max-width:\s*100%/);
  });

  it('AC-P4b app.css：答案/解析区放开（裸图 100% + figure.diagram 100% 覆盖全局档）', () => {
    const ansImg = block(appCss, /^\.answer-field img,\s*\r?\n\.analysis-field img \{[\s\S]*?\}/m);
    expect(ansImg).toMatch(/max-width:\s*100%/);
    const ansFig = block(appCss, /^\.answer-field figure\.diagram,\s*\r?\n\.analysis-field figure\.diagram \{[\s\S]*?\}/m);
    expect(ansFig).toMatch(/max-width:\s*100%/);
  });

  it('AC-P5 theme.css：.bank-layout 两栏 260px+1fr、行高 minmax(0,1fr) 钉死、≤900px 降级单列', () => {
    const layout = block(themeCss, /^\.bank-layout \{[\s\S]*?\}/m);
    expect(layout).toMatch(/display:\s*grid/);
    const cols = layout.match(/grid-template-columns:\s*260px 1fr/);
    expect(cols).not.toBeNull();
    // 授权区间核验：左栏 240–280px（任务书 §一.1）
    const px = Number(/(\d+)px/.exec(layout.match(/grid-template-columns:[^;]*/)![0])![1]);
    expect(px).toBeGreaterThanOrEqual(240);
    expect(px).toBeLessThanOrEqual(280);

    const pageLayout = block(themeCss, /^\.bank-page \.bank-layout \{[\s\S]*?\}/m);
    expect(pageLayout).toMatch(/grid-template-rows:\s*minmax\(0,\s*1fr\)/);

    const mediaBlock = block(themeCss, /^@media screen and \(max-width: 900px\) \{[\s\S]*?\r?\n\}/m);
    expect(mediaBlock).toMatch(/\.bank-layout \{ grid-template-columns: 1fr; \}/);
    expect(mediaBlock).toMatch(/grid-template-rows:\s*auto/);
  });
});
