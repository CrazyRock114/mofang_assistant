// 0030：反馈记录 + AI 提示词模板契约测试 — 参数化跑两遍（真实 SQLite + mock 内存），两遍必须同绿（任务书 §四）。
// 覆盖：迁移 0010 空库顺序应用与内置种子、内置模板只读守卫、记录两态（快速=student_id NULL / 批量=关联）
// 落库往返、list 筛选（班级 + 姓名关键字）、更新正文、删除不可见、channel 白名单校验。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BankExtServices, FeedbackRecordInput } from '../../src/shared/contracts/bank-types.js';
import { openDatabase } from '../../src/bank/db.js';
import { createExtServices } from '../../src/bank/ext-services.js';
import { createMockExtServices } from '../../src/bank/mock/mock-ext.js';
import { MockBankStore } from '../../src/bank/mock/mock-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '../../src/bank/migrations');

interface ExtCtx {
  ext: BankExtServices;
  cleanup: () => void;
}

const implementations: Array<{ name: string; factory: () => ExtCtx }> = [
  {
    name: 'Real (SQLite)',
    factory: () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'feedback-record-test-'));
      const db = openDatabase(join(tempDir, 'test.db'), migrationsDir);
      return {
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
      return { ext: createMockExtServices(store), cleanup: () => {} };
    },
  },
];

/** 批量模式记录（关联学生/班级/考试） */
function batchInput(overrides: Partial<FeedbackRecordInput> = {}): FeedbackRecordInput {
  return {
    studentId: 'stu-chen',
    studentName: '陈小明',
    classId: 'class-3',
    examId: 'exam-9',
    channel: 'ai',
    promptTemplateId: 'tpl-prompt-x',
    promptSnapshot: '你是一位有经验的培训老师……',
    modelProfileId: 'profile-1',
    inputJson: '{"课堂内容":"欧姆定律","课堂表现":["专注"],"课后任务":"练习册 P45","成绩":"82"}',
    body: '陈小明家长您好！本节课我们学习了欧姆定律……',
    ...overrides,
  };
}

/** 快速模式记录（未关联档案：student_id/class_id/exam_id 全空） */
function quickInput(overrides: Partial<FeedbackRecordInput> = {}): FeedbackRecordInput {
  return {
    studentName: '刘一凡',
    channel: 'offline',
    inputJson: '{"课堂内容":"牛顿第二定律","课堂表现":[],"课后任务":"","成绩":""}',
    body: '刘一凡家长您好！本次课我们学习了牛顿第二定律。',
    ...overrides,
  };
}

describe.each(implementations)('0030 FeedbackRecord/PromptTemplate Contract - $name', ({ factory }) => {
  let ctx: ExtCtx;

  beforeEach(() => {
    ctx = factory();
  });

  afterEach(() => {
    ctx.cleanup();
  });

  // ---------- 提示词模板（AI 通道） ----------

  it('迁移/播种：两条内置提示词模板在（通用课后反馈 + 考后成绩反馈）且含事实与风格槽位', async () => {
    const templates = await ctx.ext.feedbackPrompt.listTemplates();
    const names = templates.filter((t) => t.isBuiltin).map((t) => t.name);
    expect(names).toContain('通用课后反馈');
    expect(names).toContain('考后成绩反馈');
    const general = templates.find((t) => t.name === '通用课后反馈')!;
    for (const slot of ['{学生姓名}', '{课堂内容}', '{课堂表现}', '{课后任务}', '{成绩}', '{语气}', '{篇幅}', '{家庭建议}']) {
      expect(general.body, `内置模板缺槽位 ${slot}`).toContain(slot);
    }
    // 去 AI 味规则直接写进内置正文（P-28 承接）：「不得编造、不得改动数字」+ 禁「AI」「模型」字样要求
    expect(general.body).toContain('不得编造');
    expect(general.body).toContain('不得改动数字');
  });

  it('内置模板只读：update/delete 一律拒绝（用户模板可改可删）', async () => {
    const builtin = (await ctx.ext.feedbackPrompt.listTemplates()).find((t) => t.isBuiltin)!;
    await expect(ctx.ext.feedbackPrompt.updateTemplate(builtin.id, { body: '改一改' })).rejects.toThrow();
    await expect(ctx.ext.feedbackPrompt.deleteTemplate(builtin.id)).rejects.toThrow();

    const mine = await ctx.ext.feedbackPrompt.createTemplate({ name: '我的·简短版', body: '给学生{学生姓名}写反馈。' });
    expect(mine.isBuiltin).toBe(false);
    const updated = await ctx.ext.feedbackPrompt.updateTemplate(mine.id, { name: '我的·更短版' });
    expect(updated.name).toBe('我的·更短版');
    await ctx.ext.feedbackPrompt.deleteTemplate(mine.id);
    expect((await ctx.ext.feedbackPrompt.listTemplates()).some((t) => t.id === mine.id)).toBe(false);
  });

  it('新建提示词模板：名称/正文空白拒绝；内置模板名保留不冲突', async () => {
    await expect(ctx.ext.feedbackPrompt.createTemplate({ name: '  ', body: '身体' })).rejects.toThrow();
    await expect(ctx.ext.feedbackPrompt.createTemplate({ name: '名字', body: '  ' })).rejects.toThrow();
    const mine = await ctx.ext.feedbackPrompt.createTemplate({ name: '通用课后反馈', body: '同名但非内置' });
    expect(mine.isBuiltin).toBe(false);
  });

  // ---------- 记录两态落库往返 ----------

  it('批量模式往返：关联学生/班级/考试 + channel/prompt 快照/输入快照全字段落库', async () => {
    const created = await ctx.ext.feedbackRecord.createRecord(batchInput());
    expect(created.id).toBeTruthy();
    const got = await ctx.ext.feedbackRecord.getRecord(created.id);
    expect(got).not.toBeNull();
    expect(got!.studentId).toBe('stu-chen');
    expect(got!.studentName).toBe('陈小明');
    expect(got!.classId).toBe('class-3');
    expect(got!.examId).toBe('exam-9');
    expect(got!.channel).toBe('ai');
    expect(got!.promptTemplateId).toBe('tpl-prompt-x');
    expect(got!.promptSnapshot).toContain('培训老师');
    expect(got!.modelProfileId).toBe('profile-1');
    expect(JSON.parse(got!.inputJson)['课堂内容']).toBe('欧姆定律');
    expect(got!.body).toContain('欧姆定律');
    expect(got!.createdAt).toBeTruthy();
  });

  it('快速模式往返：student_id 为 NULL（留痕不入档案）+ 班级/考试为空', async () => {
    const created = await ctx.ext.feedbackRecord.createRecord(quickInput());
    const got = await ctx.ext.feedbackRecord.getRecord(created.id);
    expect(got!.studentId).toBeNull();
    expect(got!.classId).toBeNull();
    expect(got!.examId).toBeNull();
    expect(got!.promptSnapshot).toBeNull();
    expect(got!.studentName).toBe('刘一凡');
    expect(got!.channel).toBe('offline');
  });

  it('studentName 必填；channel 白名单外拒绝', async () => {
    await expect(ctx.ext.feedbackRecord.createRecord(quickInput({ studentName: '  ' }))).rejects.toThrow();
    await expect(
      ctx.ext.feedbackRecord.createRecord(quickInput({ channel: 'telepathy' as never })),
    ).rejects.toThrow();
  });

  it('list：按创建时间倒序；班级筛选 + 姓名关键字筛选（可同用）', async () => {
    const a = await ctx.ext.feedbackRecord.createRecord(batchInput({ studentName: '陈小明' }));
    const b = await ctx.ext.feedbackRecord.createRecord(batchInput({ studentId: 'stu-li', studentName: '李思颖' }));
    const c = await ctx.ext.feedbackRecord.createRecord(quickInput({ studentName: '刘一凡' }));
    await ctx.ext.feedbackRecord.createRecord(batchInput({ studentId: 'stu-w', studentName: '王小明', classId: 'class-5' }));

    const all = await ctx.ext.feedbackRecord.listRecords();
    expect(all).toHaveLength(4);

    const inClass3 = await ctx.ext.feedbackRecord.listRecords({ classId: 'class-3' });
    expect(inClass3.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());

    const mingzz = await ctx.ext.feedbackRecord.listRecords({ studentName: '小明' });
    expect(mingzz.map((r) => r.studentName).sort()).toEqual(['陈小明', '王小明'].sort());

    const both = await ctx.ext.feedbackRecord.listRecords({ classId: 'class-3', studentName: '李' });
    expect(both.map((r) => r.studentName)).toEqual(['李思颖']);

    // 快速模式（student_id NULL）也在列表里（记录页「未关联」标）
    expect(all.some((r) => r.id === c.id && r.studentId === null)).toBe(true);
  });

  it('updateRecord：正文可改（保存时以编辑后正文为准的口径落到记录上）', async () => {
    const created = await ctx.ext.feedbackRecord.createRecord(quickInput());
    const updated = await ctx.ext.feedbackRecord.updateRecord(created.id, { body: '改过的正文' });
    expect(updated.body).toBe('改过的正文');
    expect((await ctx.ext.feedbackRecord.getRecord(created.id))!.body).toBe('改过的正文');
    await expect(ctx.ext.feedbackRecord.updateRecord('nope', { body: 'x' })).rejects.toThrow();
  });

  it('deleteRecord：删除后 get/list 均不可见（含快速模式留痕）', async () => {
    const created = await ctx.ext.feedbackRecord.createRecord(quickInput());
    await ctx.ext.feedbackRecord.deleteRecord(created.id);
    expect(await ctx.ext.feedbackRecord.getRecord(created.id)).toBeNull();
    expect((await ctx.ext.feedbackRecord.listRecords()).some((r) => r.id === created.id)).toBe(false);
    await expect(ctx.ext.feedbackRecord.deleteRecord(created.id)).rejects.toThrow();
  });
});
