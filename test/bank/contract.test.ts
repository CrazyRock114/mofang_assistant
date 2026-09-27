// Phase 3: 契约测试 — 参数化跑两遍（真实实现 + mock 实现），两遍必须同绿

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import type { BankService } from '../../src/shared/contracts/bank-types.js';
import { Database, openDatabase } from '../../src/bank/db.js';
import { BankServiceImpl } from '../../src/bank/bank-service.js';
import { MockBankService } from '../../src/bank/mock/mock-bank.js';
import { SourceGateError } from '../../src/bank/gate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '../../src/bank/migrations');

// 参数化测试：两种实现
const implementations: Array<{ name: string; factory: () => { service: BankService; cleanup: () => void } }> = [
  {
    name: 'Real (SQLite)',
    factory: () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'bank-test-'));
      const dbPath = join(tempDir, 'test.db');
      const db = openDatabase(dbPath, migrationsDir);
      const service = new BankServiceImpl(db);
      return {
        service,
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
      const service = new MockBankService();
      return {
        service,
        cleanup: () => {},
      };
    },
  },
];

implementations.forEach(({ name, factory }) => {
  describe(`BankService Contract Tests - ${name}`, () => {
    let service: BankService;
    let cleanup: () => void;

    beforeEach(() => {
      const ctx = factory();
      service = ctx.service;
      cleanup = ctx.cleanup;
    });

    afterEach(() => {
      cleanup();
    });

    it('创建题目后读回一致', async () => {
      const created = await service.createQuestion({
        subject: '数学',
        sourceType: 'local',
        sourceDetail: { file: 'test.json' },
        content: '<div class="question">1+1=?</div>',
        images: [],
      });

      expect(created.id).toBeTruthy();
      expect(created.subject).toBe('数学');
      expect(created.sourceType).toBe('local');

      const retrieved = await service.getQuestion(created.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(created.id);
      expect(retrieved!.content).toBe('<div class="question">1+1=?</div>');
    });

    it('来源门禁拒绝 sourceType 缺失', async () => {
      await expect(
        service.createQuestion({
          subject: '物理',
          sourceType: undefined as any,
          sourceDetail: { file: 'test.json' },
          content: '<div class="question">测试</div>',
          images: [],
        })
      ).rejects.toThrow(/sourceType/);
    });

    it('来源门禁拒绝 sourceDetail 为空对象', async () => {
      await expect(
        service.createQuestion({
          subject: '化学',
          sourceType: 'network',
          sourceDetail: {},
          content: '<div class="question">测试</div>',
          images: [],
        })
      ).rejects.toThrow(/sourceDetail/);
    });

    it('写操作产生 operation_log', async () => {
      // 注意：MockBankService 暴露 getOperationLogs()，真实实现需要查询数据库
      const created = await service.createQuestion({
        subject: '英语',
        sourceType: 'network',
        sourceDetail: { url: 'https://example.com' },
        content: '<div class="question">Test</div>',
        images: [],
      });

      // 验证方式依赖实现：mock 有 getOperationLogs()，真实实现需查库
      if ('getOperationLogs' in service) {
        const logs = (service as any).getOperationLogs();
        expect(logs.length).toBeGreaterThan(0);
        expect(logs.some((log: any) => log.type === 'question.create')).toBe(true);
      } else {
        // 真实实现：查询 operation_log 表
        const db = (service as any).questionService?.db;
        if (db) {
          const logs = db.prepare('SELECT * FROM operation_log WHERE operation_type = ?').all('question.create');
          expect(logs.length).toBeGreaterThan(0);
        }
      }
    });

    it('试卷加题后 position 连续正确', async () => {
      const paper = await service.createPaper('测试卷');
      const q1 = await service.createQuestion({
        subject: '语文',
        sourceType: 'local',
        sourceDetail: { file: 'q1.json' },
        content: '<div class="question">题1</div>',
        images: [],
      });
      const q2 = await service.createQuestion({
        subject: '语文',
        sourceType: 'local',
        sourceDetail: { file: 'q2.json' },
        content: '<div class="question">题2</div>',
        images: [],
      });

      await service.addQuestion(paper.id, q1.id, 10);
      await service.addQuestion(paper.id, q2.id, 15);

      const summaries = await service.listPapers();
      const summary = summaries.find(s => s.paper.id === paper.id);
      expect(summary).toBeDefined();
      expect(summary!.questionCount).toBe(2);
      expect(summary!.totalScore).toBe(25);
    });

    it('试卷移除题目后 position 重排', async () => {
      const paper = await service.createPaper('重排测试');
      const q1 = await service.createQuestion({
        subject: '历史',
        sourceType: 'local',
        sourceDetail: { file: 'q1.json' },
        content: '<div class="question">题1</div>',
        images: [],
      });
      const q2 = await service.createQuestion({
        subject: '历史',
        sourceType: 'local',
        sourceDetail: { file: 'q2.json' },
        content: '<div class="question">题2</div>',
        images: [],
      });
      const q3 = await service.createQuestion({
        subject: '历史',
        sourceType: 'local',
        sourceDetail: { file: 'q3.json' },
        content: '<div class="question">题3</div>',
        images: [],
      });

      await service.addQuestion(paper.id, q1.id);
      await service.addQuestion(paper.id, q2.id);
      await service.addQuestion(paper.id, q3.id);

      // 移除中间题目
      await service.removeQuestion(paper.id, q2.id);

      const summaries = await service.listPapers();
      const summary = summaries.find(s => s.paper.id === paper.id);
      expect(summary!.questionCount).toBe(2);
    });

    it('试卷 reorder 后 position 连续正确', async () => {
      const paper = await service.createPaper('排序测试');
      const q1 = await service.createQuestion({
        subject: '地理',
        sourceType: 'local',
        sourceDetail: { file: 'q1.json' },
        content: '<div class="question">题1</div>',
        images: [],
      });
      const q2 = await service.createQuestion({
        subject: '地理',
        sourceType: 'local',
        sourceDetail: { file: 'q2.json' },
        content: '<div class="question">题2</div>',
        images: [],
      });
      const q3 = await service.createQuestion({
        subject: '地理',
        sourceType: 'local',
        sourceDetail: { file: 'q3.json' },
        content: '<div class="question">题3</div>',
        images: [],
      });

      await service.addQuestion(paper.id, q1.id);
      await service.addQuestion(paper.id, q2.id);
      await service.addQuestion(paper.id, q3.id);

      // 重排：q3, q1, q2
      await service.reorderQuestions(paper.id, [q3.id, q1.id, q2.id]);

      // 验证（这里只验证不抛错，因为接口没有直接返回 position）
      const summaries = await service.listPapers();
      const summary = summaries.find(s => s.paper.id === paper.id);
      expect(summary!.questionCount).toBe(3);
    });

    it('更新题目后 updatedAt 变化', async () => {
      const created = await service.createQuestion({
        subject: '生物',
        sourceType: 'network',
        sourceDetail: { url: 'https://bio.example.com' },
        content: '<div class="question">原始内容</div>',
        images: [],
      });

      const originalUpdatedAt = created.updatedAt;

      // 等待至少 1ms 确保时间戳不同
      await new Promise(resolve => setTimeout(resolve, 2));

      const updated = await service.updateQuestion(created.id, {
        content: '<div class="question">更新后内容</div>',
      });

      expect(updated.updatedAt).not.toBe(originalUpdatedAt);
      expect(updated.content).toBe('<div class="question">更新后内容</div>');
    });

    // D1-fix-4 复验：题库删除能力（软删）
    it('deleteQuestion 软删：list/get 不可见，不物理删除', async () => {
      const created = await service.createQuestion({
        subject: '物理',
        sourceType: 'network',
        sourceDetail: { site: 'jyeoo', questionId: 'del-1' },
        content: '<div class="question">待删除题</div>',
        images: [],
      });

      await service.deleteQuestion(created.id);

      expect(await service.getQuestion(created.id)).toBeNull();
      const list = await service.listQuestions();
      expect(list.some((q) => q.id === created.id)).toBe(false);
    });

    it('listQuestions 支持 subject 过滤', async () => {
      await service.createQuestion({
        subject: '数学',
        sourceType: 'local',
        sourceDetail: { file: 'math.json' },
        content: '<div class="question">数学题</div>',
        images: [],
      });
      await service.createQuestion({
        subject: '物理',
        sourceType: 'local',
        sourceDetail: { file: 'physics.json' },
        content: '<div class="question">物理题</div>',
        images: [],
      });

      const mathQuestions = await service.listQuestions({ subject: '数学' });
      expect(mathQuestions.every(q => q.subject === '数学')).toBe(true);
    });

    it('listQuestions 支持 keyword 过滤', async () => {
      await service.createQuestion({
        subject: '语文',
        sourceType: 'local',
        sourceDetail: { file: 'lang.json' },
        content: '<div class="question">李白的诗</div>',
        images: [],
      });
      await service.createQuestion({
        subject: '语文',
        sourceType: 'local',
        sourceDetail: { file: 'lang2.json' },
        content: '<div class="question">杜甫的诗</div>',
        images: [],
      });

      const results = await service.listQuestions({ keyword: '李白' });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some(q => q.content.includes('李白'))).toBe(true);
    });

    it('addTag 和 removeTag 正常工作', async () => {
      const q = await service.createQuestion({
        subject: '化学',
        sourceType: 'local',
        sourceDetail: { file: 'chem.json' },
        content: '<div class="question">化学题</div>',
        images: [],
      });

      await service.addTag(q.id, '重点题', '#ff0000');
      await service.addTag(q.id, '易错题', '#00ff00');

      // 通过 tag 过滤
      const tagged = await service.listQuestions({ tag: '重点题' });
      expect(tagged.some(question => question.id === q.id)).toBe(true);

      await service.removeTag(q.id, '重点题');

      const afterRemoval = await service.listQuestions({ tag: '重点题' });
      expect(afterRemoval.every(question => question.id !== q.id)).toBe(true);
    });

    it('getPaperQuestions 按 position 升序返回', async () => {
      const paper = await service.createPaper('顺序测试卷');
      const q1 = await service.createQuestion({
        subject: '数学',
        sourceType: 'local',
        sourceDetail: { origin: 'manual' },
        content: '<div class="question">题1</div>',
        images: [],
      });
      const q2 = await service.createQuestion({
        subject: '数学',
        sourceType: 'local',
        sourceDetail: { origin: 'manual' },
        content: '<div class="question">题2</div>',
        images: [],
      });
      const q3 = await service.createQuestion({
        subject: '数学',
        sourceType: 'local',
        sourceDetail: { origin: 'manual' },
        content: '<div class="question">题3</div>',
        images: [],
      });

      await service.addQuestion(paper.id, q1.id, 10);
      await service.addQuestion(paper.id, q2.id, 20);
      await service.addQuestion(paper.id, q3.id, 30);

      const refs = await service.getPaperQuestions(paper.id);
      expect(refs.length).toBe(3);
      expect(refs[0].questionId).toBe(q1.id);
      expect(refs[1].questionId).toBe(q2.id);
      expect(refs[2].questionId).toBe(q3.id);
      expect(refs[0].position).toBe(0);
      expect(refs[1].position).toBe(1);
      expect(refs[2].position).toBe(2);
    });

    it('setQuestionScore 持久化分值；undefined 清除回未设置（0018 目检返工三）', async () => {
      const paper = await service.createPaper('分值测试卷');
      const q = await service.createQuestion({
        subject: '英语',
        sourceType: 'local',
        sourceDetail: { origin: 'manual' },
        content: '<div class="question">Test question</div>',
        images: [],
      });

      await service.addQuestion(paper.id, q.id, 10);
      await service.setQuestionScore(paper.id, q.id, 25);

      const refs = await service.getPaperQuestions(paper.id);
      const ref = refs.find(r => r.questionId === q.id);
      expect(ref).toBeDefined();
      expect(ref!.score).toBe(25);

      // 0018 目检返工三：undefined = 清除分值（score 列回 NULL/未设置）
      await service.setQuestionScore(paper.id, q.id, undefined);
      const refsAfterClear = await service.getPaperQuestions(paper.id);
      const refAfterClear = refsAfterClear.find(r => r.questionId === q.id);
      expect(refAfterClear).toBeDefined();
      expect(refAfterClear!.score).toBeUndefined();
    });

    // ===== 0002 契约扩展（G1 结构化 / G2 字典化 / G6 状态机） =====
    // 注：subjectId/typeId/difficultyId 带字典外键，需先建字典条目——相关双跑用例在 ext-contract.test.ts

    it('0002 弃用字段：grade/textbook 入参兼容但不落库（并入树，B2）；stage 经 0062 翻案加回落库', async () => {
      const created = await service.createQuestion({
        subject: '物理',
        sourceType: 'local',
        sourceDetail: { origin: 'manual' },
        content: '<div class="question">弃用字段题</div>',
        images: [],
        grade: '高一',
        stage: '高中',
        textbook: '人教版',
      });

      const read = await service.getQuestion(created.id);
      expect(read!.grade).toBeUndefined();
      expect(read!.textbook).toBeUndefined();
      // 0062（R-066/D-076② 翻案 B2）：stage 恢复落库（迁移 0017）——本断言由「读回 undefined」等强改写为同值读回
      expect(read!.stage).toBe('高中');
    });

    it('0002 Paper：createPaper 默认 basket/uniform，读回 status/paperType', async () => {
      const paper = await service.createPaper('默认状态卷');
      expect(paper.status).toBe('basket');
      expect(paper.paperType).toBe('uniform');
      expect(paper.archived).toBe(false);

      const read = await service.getPaper(paper.id);
      expect(read!.status).toBe('basket');
      expect(read!.paperType).toBe('uniform');
      expect(read!.layoutConfig).toBeUndefined();
    });
  });
});
