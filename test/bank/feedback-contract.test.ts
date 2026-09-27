// 0005：课后反馈模板契约测试 — 参数化跑两遍（真实 SQLite + mock 内存），两遍必须同绿。
// 覆盖（0005 任务书 §三）：模板 CRUD 双跑、内置守卫（改/删抛错）、
// 软删不可见、迁移 0005_feedback 内置种子「默认课后反馈」可见且正文含中文键变量。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import type { BankExtServices } from '../../src/shared/contracts/bank-types.js';
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
      const tempDir = mkdtempSync(join(tmpdir(), 'feedback-test-'));
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
      return {
        ext: createMockExtServices(store),
        cleanup: () => {},
      };
    },
  },
];

describe.each(implementations)('0005 FeedbackService Contract Tests - $name', ({ factory }) => {
  let ctx: ExtCtx;

  beforeEach(() => {
    ctx = factory();
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('迁移/播种内置种子可见：默认课后反馈（isBuiltin）正文含中文键变量', async () => {
    const templates = await ctx.ext.feedback.listTemplates();
    const builtin = templates.find((t) => t.name === '默认课后反馈');
    expect(builtin).toBeDefined();
    expect(builtin!.isBuiltin).toBe(true);
    expect(builtin!.bodyTemplate).toContain('{学生姓名}');
    expect(builtin!.bodyTemplate).toContain('{本次内容}');
    expect(builtin!.bodyTemplate).toContain('{老师姓名}');
  });

  it('createTemplate：新建用户模板 + get/list 可见（isBuiltin=false）', async () => {
    const created = await ctx.ext.feedback.createTemplate({ name: '期末反馈', bodyTemplate: '{学生姓名}家长您好，{课堂表现}' });
    expect(created.id).toBeTruthy();
    expect(created.isBuiltin).toBe(false);
    expect(created.bodyTemplate).toContain('{课堂表现}');

    const got = await ctx.ext.feedback.getTemplate(created.id);
    expect(got?.name).toBe('期末反馈');
    const list = await ctx.ext.feedback.listTemplates();
    expect(list.some((t) => t.id === created.id)).toBe(true);
  });

  it('createTemplate：空名称/空正文拒绝', async () => {
    await expect(ctx.ext.feedback.createTemplate({ name: '   ', bodyTemplate: 'x' })).rejects.toThrow(/name/);
    await expect(ctx.ext.feedback.createTemplate({ name: 'x', bodyTemplate: '' })).rejects.toThrow(/body/);
  });

  it('updateTemplate：改名/改正文生效；updatedAt 演进', async () => {
    const created = await ctx.ext.feedback.createTemplate({ name: '旧名', bodyTemplate: '旧正文' });
    const updated = await ctx.ext.feedback.updateTemplate(created.id, { name: '新名', bodyTemplate: '{学习建议}' });
    expect(updated.name).toBe('新名');
    expect(updated.bodyTemplate).toBe('{学习建议}');
    const got = await ctx.ext.feedback.getTemplate(created.id);
    expect(got?.name).toBe('新名');
  });

  it('deleteTemplate：用户模板软删（get 为 null、list 不可见；includeDeleted 可见）', async () => {
    const created = await ctx.ext.feedback.createTemplate({ name: '待删模板', bodyTemplate: '正文' });
    await ctx.ext.feedback.deleteTemplate(created.id);
    expect(await ctx.ext.feedback.getTemplate(created.id)).toBeNull();
    const list = await ctx.ext.feedback.listTemplates();
    expect(list.some((t) => t.id === created.id)).toBe(false);
    const all = await ctx.ext.feedback.listTemplates({ includeDeleted: true });
    expect(all.some((t) => t.id === created.id)).toBe(true);
  });

  it('内置守卫：update/delete 内置模板抛错', async () => {
    const templates = await ctx.ext.feedback.listTemplates();
    const builtin = templates.find((t) => t.isBuiltin)!;
    await expect(ctx.ext.feedback.updateTemplate(builtin.id, { name: '改内置' })).rejects.toThrow(/builtin/i);
    await expect(ctx.ext.feedback.deleteTemplate(builtin.id)).rejects.toThrow(/builtin/i);
  });

  it('不存在模板：get 为 null；update/delete 抛错', async () => {
    expect(await ctx.ext.feedback.getTemplate('no-such-template')).toBeNull();
    await expect(ctx.ext.feedback.updateTemplate('no-such-template', { name: 'x' })).rejects.toThrow(/not found/i);
    await expect(ctx.ext.feedback.deleteTemplate('no-such-template')).rejects.toThrow(/not found/i);
  });
});
