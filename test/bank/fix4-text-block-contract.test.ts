// 0004-fix-4 2.3：大标题=文本内容块（kind='text' 行）——双跑契约探针（真实 SQLite + mock 内存同绿）。
// 覆盖验收：CRUD（插入/upsert 更新/重排/移除）+ 快照跳过（不炸、不产快照行）+ 克隆随行带出 +
// 题号跳过（渲染侧，见 test/docgen/fix4-text-block.test.ts）。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BankService, BankExtServices, Question } from '../../src/shared/contracts/bank-types.js';
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
      const tempDir = mkdtempSync(join(tmpdir(), 'fix4-textblock-'));
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

function makeQuestionData(stem: string): Omit<Question, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    subject: '物理',
    sourceType: 'local',
    sourceDetail: { origin: 'test' },
    content: `<div class="question">${stem}</div>`,
    images: [],
  };
}

for (const impl of implementations) {
  describe(`fix-4 2.3 文本内容块契约 - ${impl.name}`, () => {
    let ctx: ExtCtx;

    beforeEach(() => {
      ctx = impl.factory();
    });

    afterEach(() => {
      ctx.cleanup();
    });

    it('插入 → getPaperQuestions 带出 kind/textBody/style（不占题号行位）', async () => {
      const q1 = await ctx.bank.createQuestion(makeQuestionData('题一'));
      const q2 = await ctx.bank.createQuestion(makeQuestionData('题二'));
      const paper = await ctx.ext.paper.createPaperEx('文本块卷');
      await ctx.bank.addQuestion(paper.id, q1.id);
      await ctx.bank.addQuestion(paper.id, 'text:t1', undefined, undefined, { text: '一、单项选择题', style: 'section' });
      await ctx.bank.addQuestion(paper.id, q2.id);

      const refs = await ctx.bank.getPaperQuestions(paper.id);
      expect(refs.map((r) => r.questionId)).toEqual([q1.id, 'text:t1', q2.id]);
      expect(refs[1].kind).toBe('text');
      expect(refs[1].textBody).toBe('一、单项选择题');
      expect(refs[1].style).toBe('section');
      expect(refs[0].kind).toBeUndefined();
      expect(refs[0].textBody).toBeUndefined();
      // position 连续（行机制不变）
      expect(refs.map((r) => r.position)).toEqual([0, 1, 2]);
    });

    it('upsert：同 id 再次写入 = 更新正文/样式（复用 addQuestion 通道，不新增 IPC）', async () => {
      const paper = await ctx.ext.paper.createPaperEx('upsert 卷');
      await ctx.bank.addQuestion(paper.id, 'text:t1', undefined, undefined, { text: '一、选择题' });
      await ctx.bank.addQuestion(paper.id, 'text:t1', undefined, undefined, { text: '一、单项选择题（每题 3 分）', style: 'note' });

      const refs = await ctx.bank.getPaperQuestions(paper.id);
      expect(refs).toHaveLength(1);
      expect(refs[0].textBody).toBe('一、单项选择题（每题 3 分）');
      expect(refs[0].style).toBe('note');
    });

    it('重排（题序拖拽语义）+ 移除：文本块与题目行同机制', async () => {
      const q1 = await ctx.bank.createQuestion(makeQuestionData('题一'));
      const paper = await ctx.ext.paper.createPaperEx('重排卷');
      await ctx.bank.addQuestion(paper.id, q1.id);
      await ctx.bank.addQuestion(paper.id, 'text:t1', undefined, undefined, { text: '二、填空题' });

      await ctx.bank.reorderQuestions(paper.id, ['text:t1', q1.id]);
      const reordered = await ctx.bank.getPaperQuestions(paper.id);
      expect(reordered.map((r) => r.questionId)).toEqual(['text:t1', q1.id]);
      expect(reordered.map((r) => r.position)).toEqual([0, 1]);

      await ctx.bank.removeQuestion(paper.id, 'text:t1');
      const after = await ctx.bank.getPaperQuestions(paper.id);
      expect(after.map((r) => r.questionId)).toEqual([q1.id]);
      expect(after[0].position).toBe(0);
    });

    it('快照：文本块行跳过题快照（不抛错、不产快照行），题目行照常快照', async () => {
      const q1 = await ctx.bank.createQuestion(makeQuestionData('题一'));
      const paper = await ctx.ext.paper.createPaperEx('快照卷');
      await ctx.bank.addQuestion(paper.id, q1.id);
      await ctx.bank.addQuestion(paper.id, 'text:t1', undefined, undefined, { text: '三、解答题' });

      const count = await ctx.ext.paper.snapshotPaperQuestions(paper.id);
      expect(count).toBe(1); // 仅题目行
      const snapshotQuestions = await ctx.ext.paper.listPaperSnapshotQuestions(paper.id);
      expect(snapshotQuestions.map((q) => q.id)).toEqual([q1.id]);
    });

    it('克隆：文本块随行拷贝（kind/textBody/style 保留，无 questions 行也不丢）', async () => {
      const q1 = await ctx.bank.createQuestion(makeQuestionData('题一'));
      const paper = await ctx.ext.paper.createPaperEx('克隆源卷');
      await ctx.bank.addQuestion(paper.id, q1.id);
      await ctx.bank.addQuestion(paper.id, 'text:t1', undefined, undefined, { text: '一、单项选择题', style: 'section' });

      const cloned = await ctx.ext.paper.clonePaperToBasket(paper.id, '克隆目标卷');
      const refs = await ctx.bank.getPaperQuestions(cloned.id);
      expect(refs.map((r) => r.questionId)).toEqual([q1.id, 'text:t1']);
      expect(refs[1].kind).toBe('text');
      expect(refs[1].textBody).toBe('一、单项选择题');
      expect(refs[1].style).toBe('section');
    });

    // 0004-fix-6 P1-1：文本块对齐（text_align 列 / ref.align；缺省=样式基线观感）
    it('对齐：写入 align 带出；缺省清回基线（undefined）；克隆随行拷贝', async () => {
      const paper = await ctx.ext.paper.createPaperEx('对齐卷');
      await ctx.bank.addQuestion(paper.id, 'text:t1', undefined, undefined, { text: '一、单项选择题', align: 'center' });
      let refs = await ctx.bank.getPaperQuestions(paper.id);
      expect(refs[0].align).toBe('center');

      // 对齐改右 → upsert 更新；再写不带 align = 清回缺省（undefined）
      await ctx.bank.addQuestion(paper.id, 'text:t1', undefined, undefined, { text: '一、单项选择题', align: 'right' });
      refs = await ctx.bank.getPaperQuestions(paper.id);
      expect(refs[0].align).toBe('right');
      await ctx.bank.addQuestion(paper.id, 'text:t1', undefined, undefined, { text: '一、单项选择题' });
      refs = await ctx.bank.getPaperQuestions(paper.id);
      expect(refs[0].align).toBeUndefined();

      // 克隆随行拷贝
      await ctx.bank.addQuestion(paper.id, 'text:t1', undefined, undefined, { text: '一、单项选择题', align: 'left' });
      const cloned = await ctx.ext.paper.clonePaperToBasket(paper.id, '对齐克隆卷');
      const clonedRefs = await ctx.bank.getPaperQuestions(cloned.id);
      expect(clonedRefs[0].align).toBe('left');
    });
  });
}
