// 0004：试题篮扩展服务契约测试 — 参数化跑两遍（真实 SQLite + mock 内存），两遍必须同绿
// 覆盖验收探针（0004 任务书 §三）：
// listPapersEx/getPaperEx 的 archived 可见性、快照 upsert 幂等、快照恒定（改题不漂移）、
// clone 题源三分支（原题在引用原 id / 原题软删从快照重建 / 快照缺失跳过）、
// 重命名空标题拒绝、内置预设 updatePreset 守卫（0004 补全）。

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
      const tempDir = mkdtempSync(join(tmpdir(), 'basket-ext-test-'));
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

/** 造题辅助：两实现共用的入库入参 */
function makeQuestionData(stem: string, answer?: string) {
  return {
    subject: '物理',
    sourceType: 'local' as const,
    sourceDetail: { origin: 'basket-contract' },
    content: `<div class="question">${stem}</div>`,
    stemHtml: `<div class="question">${stem}</div>`,
    ...(answer !== undefined ? { answer } : {}),
    images: [] as never[],
  };
}

/** 推进状态机 basket→composing→done（→archived 可选） */
async function advanceStatus(ext: BankExtServices, paperId: string, toArchived = false): Promise<void> {
  await ext.paper.updatePaperStatus(paperId, 'composing');
  await ext.paper.updatePaperStatus(paperId, 'done');
  if (toArchived) await ext.paper.updatePaperStatus(paperId, 'archived');
}

implementations.forEach(({ name, factory }) => {
  describe(`0004 PaperExtService Basket Contract Tests - ${name}`, () => {
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

    // ==================== listPapersEx / getPaperEx（archived 可见性） ====================

    it('listPapersEx：不过滤 archived + statuses 过滤；旧 listPapers 仍排除 archived', async () => {
      const donePaper = await ext.paper.createPaperEx('已出卷甲');
      await advanceStatus(ext, donePaper.id, true); // basket→composing→done→archived

      const basketPaper = await ext.paper.createPaperEx('处理中乙');

      // 旧 listPapers：archived 不可见（语义不回归）
      const oldList = await bank.listPapers();
      expect(oldList.some(s => s.paper.id === donePaper.id)).toBe(false);
      expect(oldList.some(s => s.paper.id === basketPaper.id)).toBe(true);

      // listPapersEx 缺省：全部可见（含 archived）
      const all = await ext.paper.listPapersEx();
      expect(all.some(s => s.paper.id === donePaper.id)).toBe(true);
      expect(all.some(s => s.paper.id === basketPaper.id)).toBe(true);

      // statuses 过滤
      const archivedOnly = await ext.paper.listPapersEx({ statuses: ['archived'] });
      expect(archivedOnly.every(s => s.paper.status === 'archived')).toBe(true);
      expect(archivedOnly.some(s => s.paper.id === donePaper.id)).toBe(true);

      const basketOnly = await ext.paper.listPapersEx({ statuses: ['basket', 'composing'] });
      expect(basketOnly.some(s => s.paper.id === basketPaper.id)).toBe(true);
      expect(basketOnly.some(s => s.paper.id === donePaper.id)).toBe(false);
    });

    it('getPaperEx：archived 卷可读（预览/导出/克隆/恢复入口），旧 getPaper 仍返回 null', async () => {
      const paper = await ext.paper.createPaperEx('归档卷');
      await advanceStatus(ext, paper.id, true);

      expect(await bank.getPaper(paper.id)).toBeNull();
      const exPaper = await ext.paper.getPaperEx(paper.id);
      expect(exPaper).not.toBeNull();
      expect(exPaper!.status).toBe('archived');
      expect(exPaper!.archived).toBe(true);
      expect(await ext.paper.getPaperEx('nonexistent')).toBeNull();
    });

    // ==================== 快照：upsert 幂等 + 恒定 + 失败中止 ====================

    it('snapshotPaperQuestions：写入行数 + 重复快照幂等（无重复行）+ 按 position 序还原', async () => {
      const q1 = await bank.createQuestion(makeQuestionData('快照甲', '<p>答甲</p>'));
      const q2 = await bank.createQuestion(makeQuestionData('快照乙'));
      const paper = await ext.paper.createPaperEx('快照卷');
      await bank.addQuestion(paper.id, q1.id, 5);
      await bank.addQuestion(paper.id, q2.id, 3);

      const first = await ext.paper.snapshotPaperQuestions(paper.id);
      expect(first).toBe(2);

      // upsert 幂等：二次快照不产生重复行（若 insert 重复，JOIN 会还原出 4 条）
      const second = await ext.paper.snapshotPaperQuestions(paper.id);
      expect(second).toBe(2);
      const restored = await ext.paper.listPaperSnapshotQuestions(paper.id);
      expect(restored.length).toBe(2);
      expect(restored.map(q => q.id)).toEqual([q1.id, q2.id]);
      expect(restored[0].answer).toBe('<p>答甲</p>');

      // 还原的 Question 全字段保真
      expect(restored[0].content).toBe(q1.content);
      expect(restored[1].stemHtml).toBe(q2.stemHtml);

      // 空卷快照 = 0 行；无快照卷读侧 = 空
      const emptyPaper = await ext.paper.createPaperEx('空卷');
      expect(await ext.paper.snapshotPaperQuestions(emptyPaper.id)).toBe(0);
      expect(await ext.paper.listPaperSnapshotQuestions(emptyPaper.id)).toEqual([]);
    });

    it('快照恒定：快照后改题/软删题 → listPaperSnapshotQuestions 内容原样', async () => {
      const q1 = await bank.createQuestion(makeQuestionData('恒定甲', '<p>原答案</p>'));
      const q2 = await bank.createQuestion(makeQuestionData('恒定乙'));
      const paper = await ext.paper.createPaperEx('恒定卷');
      await bank.addQuestion(paper.id, q1.id);
      await bank.addQuestion(paper.id, q2.id);
      await ext.paper.snapshotPaperQuestions(paper.id);

      // 出卷后改题库题 + 软删另一题
      await bank.updateQuestion(q1.id, { answer: '<p>改后答案</p>' });
      await bank.deleteQuestion(q2.id);

      const restored = await ext.paper.listPaperSnapshotQuestions(paper.id);
      expect(restored.length).toBe(2);
      expect(restored[0].answer).toBe('<p>原答案</p>');
      expect(restored[1].content).toBe('<div class="question">恒定乙</div>');
    });

    it('snapshotPaperQuestions：题不存在/软删抛错（快照失败中止）；卷不存在抛错', async () => {
      const q1 = await bank.createQuestion(makeQuestionData('会消失的题'));
      const paper = await ext.paper.createPaperEx('缺题卷');
      await bank.addQuestion(paper.id, q1.id);
      await bank.deleteQuestion(q1.id);

      await expect(ext.paper.snapshotPaperQuestions(paper.id)).rejects.toThrow(/not found.*snapshot aborted|deleted/i);
      await expect(ext.paper.snapshotPaperQuestions('nonexistent-paper')).rejects.toThrow(/Paper.*not found/);

      // 失败后不留半截快照（该卷无快照行）
      expect(await ext.paper.listPaperSnapshotQuestions(paper.id)).toEqual([]);
    });

    // ==================== clonePaperToBasket：题源三分支 ====================

    it('clone：快照有行——原题在引用原 id，原题软删从快照重建；标题/分值/config/layoutConfig 拷贝', async () => {
      const qKeep = await bank.createQuestion(makeQuestionData('克隆留存题', '<p>留存答</p>'));
      const qDel = await bank.createQuestion(makeQuestionData('克隆被删题', '<p>被删答</p>'));
      const paper = await ext.paper.createPaperEx('被克隆卷', { duration: 90 });
      await bank.addQuestion(paper.id, qKeep.id, 5);
      await bank.addQuestion(paper.id, qDel.id, 3);
      await ext.paper.setPaperLayoutConfig(paper.id, { version: 1, fontSize: 12 });
      await ext.paper.snapshotPaperQuestions(paper.id);
      await advanceStatus(ext, paper.id, true); // done→archived 也能克隆（历史卷改编）

      // 软删一题后克隆：原题在 → 引用原 id；原题失 → 快照重建
      await bank.deleteQuestion(qDel.id);
      const cloned = await ext.paper.clonePaperToBasket(paper.id);

      expect(cloned.status).toBe('basket');
      expect(cloned.archived).toBe(false);
      expect(cloned.title).toBe('被克隆卷复制');
      expect(cloned.config).toEqual({ duration: 90 });
      expect(cloned.layoutConfig).toEqual({ version: 1, fontSize: 12 });

      const refs = await bank.getPaperQuestions(cloned.id);
      expect(refs.map(r => r.questionId)).toEqual([qKeep.id, expect.any(String)]);
      expect(refs[0].questionId).toBe(qKeep.id);
      expect(refs[0].score).toBe(5);
      expect(refs[1].score).toBe(3);

      // 重建题内容 = 快照内容（与被删题一致），且新卷可正常走状态机
      const rebuilt = await bank.getQuestion(refs[1].questionId);
      expect(rebuilt).not.toBeNull();
      expect(rebuilt!.content).toBe('<div class="question">克隆被删题</div>');
      expect(rebuilt!.answer).toBe('<p>被删答</p>');
      await expect(ext.paper.updatePaperStatus(cloned.id, 'composing')).resolves.toBeUndefined();

      // 原卷不动（仍 archived、引用不变）
      const source = await ext.paper.getPaperEx(paper.id);
      expect(source!.status).toBe('archived');
      expect((await bank.getPaperQuestions(paper.id)).length).toBe(2);
    });

    it('clone：快照无行（旧卷未快照）——逐题取现题，缺失题跳过并记录；自定义标题生效', async () => {
      const qKeep = await bank.createQuestion(makeQuestionData('无快照留存题'));
      const qMissing = await bank.createQuestion(makeQuestionData('无快照缺失题'));
      const paper = await ext.paper.createPaperEx('旧卷未快照');
      await bank.addQuestion(paper.id, qKeep.id, 4);
      await bank.addQuestion(paper.id, qMissing.id, 6);
      // 不快照，直接软删一题 → 克隆时该题跳过
      await bank.deleteQuestion(qMissing.id);

      const cloned = await ext.paper.clonePaperToBasket(paper.id, '自定义新卷');
      expect(cloned.title).toBe('自定义新卷');

      const refs = await bank.getPaperQuestions(cloned.id);
      expect(refs.length).toBe(1);
      expect(refs[0].questionId).toBe(qKeep.id);
      expect(refs[0].score).toBe(4);
    });

    it('clone：源卷不存在抛错', async () => {
      await expect(ext.paper.clonePaperToBasket('nonexistent-paper')).rejects.toThrow(/not found/);
    });

    // ==================== updatePaperTitle ====================

    it('updatePaperTitle：重命名生效（含 archived 卷）；空/空白标题拒绝；卷不存在拒绝', async () => {
      const paper = await ext.paper.createPaperEx('旧标题');
      const renamed = await ext.paper.updatePaperTitle(paper.id, '新标题');
      expect(renamed.title).toBe('新标题');
      expect((await ext.paper.getPaperEx(paper.id))!.title).toBe('新标题');

      // archived 卷也要能重命名（篮详情/排版间/列表三处入口）
      await advanceStatus(ext, paper.id, true);
      const renamedArchived = await ext.paper.updatePaperTitle(paper.id, '归档后改名');
      expect(renamedArchived.title).toBe('归档后改名');

      await expect(ext.paper.updatePaperTitle(paper.id, '')).rejects.toThrow(/title cannot be empty/i);
      await expect(ext.paper.updatePaperTitle(paper.id, '   ')).rejects.toThrow(/title cannot be empty/i);
      await expect(ext.paper.updatePaperTitle('nonexistent', '任意')).rejects.toThrow(/not found/);
    });

    // ==================== 内置预设守卫（0004 补全：updatePreset 拒改内置） ====================

    it('内置预设：updatePreset 拒绝（deletePreset 已有守卫不回归）', async () => {
      const builtin = await ext.preset.createPreset({
        name: '内置守卫测试',
        isBuiltin: true,
        config: { version: 1, fontSize: 10.5 },
      });
      await expect(ext.preset.updatePreset(builtin.id, { name: '改内置' })).rejects.toThrow(/Built-in/);
      await expect(ext.preset.deletePreset(builtin.id)).rejects.toThrow(/Built-in/);

      // 用户预设不受影响
      const user = await ext.preset.createPreset({ name: '用户预设', config: { version: 1 } });
      const updated = await ext.preset.updatePreset(user.id, { name: '用户预设v2' });
      expect(updated.name).toBe('用户预设v2');
    });

    // ==================== setQuestionLayouts（0004 Phase 5：题级图覆盖） ====================

    it('setQuestionLayouts：写入 → getPaperQuestions 带出 layout；覆盖式更新；空 figures=清除', async () => {
      const paper = await ext.paper.createPaperEx('图覆盖卷');
      const q1 = await bank.createQuestion(makeQuestionData('图覆盖一'));
      const q2 = await bank.createQuestion(makeQuestionData('图覆盖二'));
      await bank.addQuestion(paper.id, q1.id);
      await bank.addQuestion(paper.id, q2.id);

      // 未写入时无 layout 键
      let refs = await bank.getPaperQuestions(paper.id);
      expect(refs[0].layout).toBeUndefined();

      // 写入 → 读出 roundtrip（字段全保留）
      await ext.paper.setQuestionLayouts(paper.id, q1.id, {
        figures: [{ assetId: 'capture/a.png', mode: 'side-by-side', align: 'right', widthPercent: 35, orderIndex: 0 }],
      });
      refs = await bank.getPaperQuestions(paper.id);
      expect(refs[0].layout).toEqual({
        figures: [{ assetId: 'capture/a.png', mode: 'side-by-side', align: 'right', widthPercent: 35, orderIndex: 0 }],
      });
      // 未覆盖题不受影响
      expect(refs[1].layout).toBeUndefined();

      // 覆盖式更新（整体替换非合并）
      await ext.paper.setQuestionLayouts(paper.id, q1.id, {
        figures: [{ assetId: 'capture/b.png', widthPercent: 60, orderIndex: 0 }],
      });
      refs = await bank.getPaperQuestions(paper.id);
      expect(refs[0].layout).toEqual({
        figures: [{ assetId: 'capture/b.png', widthPercent: 60, orderIndex: 0 }],
      });

      // 空 figures = 清除该题覆盖
      await ext.paper.setQuestionLayouts(paper.id, q1.id, { figures: [] });
      refs = await bank.getPaperQuestions(paper.id);
      expect(refs[0].layout).toEqual({ figures: [] });
    });

    // ==================== setQuestionLayouts（0004-fix-3：题级作答区覆盖） ====================

    it('setQuestionLayouts（fix-3）：answerSpace 写入/带出/清除；figures 与 answerSpace 同体覆盖式写入', async () => {
      const paper = await ext.paper.createPaperEx('作答区覆盖卷');
      const q1 = await bank.createQuestion(makeQuestionData('作答区题一'));
      const q2 = await bank.createQuestion(makeQuestionData('作答区题二'));
      await bank.addQuestion(paper.id, q1.id);
      await bank.addQuestion(paper.id, q2.id);

      // 写入 → 读出 roundtrip
      await ext.paper.setQuestionLayouts(paper.id, q1.id, {
        figures: [{ assetId: 'capture/a.png', orderIndex: 0 }],
        answerSpace: { style: 'lines', heightMm: 30 },
      });
      let refs = await bank.getPaperQuestions(paper.id);
      expect(refs[0].layout?.figures).toEqual([{ assetId: 'capture/a.png', orderIndex: 0 }]);
      expect(refs[0].layout?.answerSpace).toEqual({ style: 'lines', heightMm: 30 });
      // 未覆盖题不受影响
      expect(refs[1].layout).toBeUndefined();

      // style none（该题不插作答区）+ figures 随行
      await ext.paper.setQuestionLayouts(paper.id, q1.id, {
        figures: [{ assetId: 'capture/a.png', orderIndex: 0 }],
        answerSpace: { style: 'none' },
      });
      refs = await bank.getPaperQuestions(paper.id);
      expect(refs[0].layout?.answerSpace).toEqual({ style: 'none' });

      // figures:[] = 清除该题覆盖（answerSpace 字段随之消失，整体覆盖式语义）
      await ext.paper.setQuestionLayouts(paper.id, q1.id, { figures: [] });
      refs = await bank.getPaperQuestions(paper.id);
      expect(refs[0].layout).toEqual({ figures: [] });
      expect(refs[0].layout?.answerSpace).toBeUndefined();

      // 仅 answerSpace（无 figures 键）也可写入
      await ext.paper.setQuestionLayouts(paper.id, q2.id, { answerSpace: { heightMm: 55 } });
      refs = await bank.getPaperQuestions(paper.id);
      expect(refs[1].layout).toEqual({ answerSpace: { heightMm: 55 } });
    });

    it('clone（fix-3）：题级覆盖 layout_json（含 answerSpace）随行拷贝到克隆卷', async () => {
      const q = await bank.createQuestion(makeQuestionData('克隆带作答区题'));
      const paper = await ext.paper.createPaperEx('克隆源卷');
      await bank.addQuestion(paper.id, q.id, 4);
      await ext.paper.setQuestionLayouts(paper.id, q.id, {
        figures: [{ assetId: 'capture/a.png', orderIndex: 0 }],
        answerSpace: { style: 'lines', heightMm: 35 },
      });
      await ext.paper.snapshotPaperQuestions(paper.id);
      await advanceStatus(ext, paper.id); // basket→composing→done

      const cloned = await ext.paper.clonePaperToBasket(paper.id);
      await advanceStatus(ext, cloned.id); // 克隆卷可正常走状态机（内容+覆盖已带出）
      const refs = await bank.getPaperQuestions(cloned.id);
      expect(refs[0].layout).toEqual({
        figures: [{ assetId: 'capture/a.png', orderIndex: 0 }],
        answerSpace: { style: 'lines', heightMm: 35 },
      });
    });

    it('setQuestionLayouts：卷-题引用不存在抛错（卷不存在/题不在卷内）', async () => {      const paper = await ext.paper.createPaperEx('图覆盖缺失卷');
      const other = await bank.createQuestion(makeQuestionData('不在卷内'));
      await expect(ext.paper.setQuestionLayouts('nonexistent-paper', other.id, { figures: [] }))
        .rejects.toThrow(/not found/);
      await expect(ext.paper.setQuestionLayouts(paper.id, other.id, { figures: [] }))
        .rejects.toThrow(/not found/);
    });

    it('内置预设种子可见（mock 播种对齐真实迁移）：A3双列/A4 在列且 isBuiltin=true', async () => {
      const presets = await ext.preset.listPresets();
      const a3 = presets.find((p) => p.name === 'A3双列');
      const a4 = presets.find((p) => p.name === 'A4');
      expect(a3).toBeDefined();
      expect(a4).toBeDefined();
      expect(a3!.isBuiltin).toBe(true);
      expect(a4!.isBuiltin).toBe(true);
      expect(a3!.config).toMatchObject({ version: 2, pageSize: 'A3', columns: 2, columnGapMm: 8, fontSize: 12, lineHeight: 1.5, header: { style: 'exam' } });
      expect(a4!.config).toMatchObject({ version: 2, pageSize: 'A4', columns: 1, fontSize: 12, lineHeight: 1.5, header: { style: 'exam' } });
    });

    it('内置预设种子 orientation（fix-2 F2-A 迁移 4 后真实库与 mock 逐字段一致）：A3双列=landscape / A4=portrait', async () => {
      const presets = await ext.preset.listPresets();
      const a3 = presets.find((p) => p.name === 'A3双列');
      const a4 = presets.find((p) => p.name === 'A4');
      expect(a3!.config.orientation).toBe('landscape');
      expect(a4!.config.orientation).toBe('portrait');
    });

    it('clone 拷贝题级图覆盖（fix-2 F2-E：layout_json 随行拷贝，新卷覆盖不丢）', async () => {
      const paper = await ext.paper.createPaperEx('克隆带覆盖源卷');
      const q = await bank.createQuestion(makeQuestionData('覆盖克隆题'));
      await bank.addQuestion(paper.id, q.id, 5);
      await ext.paper.setQuestionLayouts(paper.id, q.id, {
        figures: [{ assetId: 'capture/a.png', mode: 'inline', align: 'center', widthPercent: 40, orderIndex: 0 }],
      });

      const cloned = await ext.paper.clonePaperToBasket(paper.id);
      expect(cloned.status).toBe('basket');
      const refs = await bank.getPaperQuestions(cloned.id);
      expect(refs).toHaveLength(1);
      expect(refs[0].layout).toEqual({
        figures: [{ assetId: 'capture/a.png', mode: 'inline', align: 'center', widthPercent: 40, orderIndex: 0 }],
      });
      // 原卷覆盖不动
      const sourceRefs = await bank.getPaperQuestions(paper.id);
      expect(sourceRefs[0].layout?.figures).toHaveLength(1);
    });
  });
});
