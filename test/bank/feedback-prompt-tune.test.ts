// 0059：反馈提示词换代测试（R-056；迁移 0016 / 运行时 version 14）。
// 0062 顺延：运行时顶层 version=15（0017_question_stage）——本文件「重开库」后的版本断言改锚 VERSION_TOP。
// 覆盖（任务书 §一 P4）：四条内置在表（a）/ 已装库旧正文刷新（b）/ is_builtin=0 一字节不动（c）/
// 0016 幂等重跑（d）/ 必保留子串硬约束（e）/ mock↔真实迁移逐字一致防漂移锁（f）/ 新增两条内置只读（g）。
// (c)(f) 是防漂移锁：改前改后都绿，不是 RED 来源（任务书 §四）；(f) 的字面锚 = mock 常量（真实库 body toBe 常量）。
// 任务书：0059 任务书

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BankExtServices, FeedbackPromptTemplate } from '../../src/shared/contracts/bank-types.js';
import { openDatabase, type Database } from '../../src/bank/db.js';
import { createExtServices } from '../../src/bank/ext-services.js';
import {
  createMockExtServices,
} from '../../src/bank/mock/mock-ext.js';
import {
  BUILTIN_PROMPT_GENERAL, BUILTIN_PROMPT_EXAM, MockBankStore,
} from '../../src/bank/mock/mock-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '../../src/bank/migrations');

/** 0016 自身的运行时 version（db.ts 末位顺延：…0010→12 / 0015→13 / 0016→14） */
const VERSION_0016 = 14;
/** 0062 顺延后的运行时顶层 version（0017_question_stage；重开库后的天花板断言锚此值） */
const VERSION_TOP = 15;

const ID_GENERAL = 'feedback-prompt-builtin-general';
const ID_EXAM = 'feedback-prompt-builtin-exam';
const ID_PRIMARY = 'feedback-prompt-builtin-primary';
const ID_SENIOR = 'feedback-prompt-builtin-senior';

/** 任务书 §0.3/探针 B2：事实 7 项 + 风格 3 项，四条正文一条不许少 */
const TEN_SLOTS = [
  '{学生姓名}', '{课程主题}', '{课堂内容}', '{课堂表现}', '{课后任务}', '{成绩}', '{备注}',
  '{语气}', '{篇幅}', '{家庭建议}',
];
/** 任务书 §0.7：备注槽标签升级后的整串（「备注：{备注}」不再连续出现） */
const NEW_REMARK_LABEL = '备注（只用来把握语气和详略，不要照抄进正文）：';
const EXAMPLE_HEADING = '【范例——只示范语气、结构和详略，内容与此例无关，不要照抄】';
const OUTPUT_HEADING = '【输出格式】';

/** 0010 旧正文（造「已装库」现场用，逐字取自 src/bank/migrations/0010_feedback_records.sql 两条种子） */
const OLD_GENERAL_BODY = [
  '你是一位有经验的培训老师，正在给学生{学生姓名}的家长写课后反馈。',
  '',
  '【事实信息——只允许使用以下内容，不得编造、不得改动数字】',
  '课程主题：{课程主题}',
  '课堂内容：{课堂内容}',
  '课堂表现：{课堂表现}',
  '课后任务：{课后任务}',
  '测试成绩：{成绩}',
  '备注：{备注}',
  '',
  '【写作要求】',
  '语气：{语气}。篇幅：{篇幅}。{家庭建议}',
  '直接输出反馈正文，不要开场白和客套话，不要出现「AI」「模型」等词，称呼家长为「xx家长」。',
].join('\n');
const OLD_EXAM_BODY = [
  '你是一位有经验的培训老师，正在给学生{学生姓名}的家长写这次考试的成绩反馈。',
  '',
  '【事实信息——只允许使用以下内容，不得编造、不得改动数字】',
  '本次成绩：{成绩}',
  '课程主题：{课程主题}',
  '课堂内容：{课堂内容}',
  '课堂表现：{课堂表现}',
  '课后任务：{课后任务}',
  '备注：{备注}',
  '',
  '【写作要求】',
  '语气：{语气}。篇幅：{篇幅}。{家庭建议}',
  '直接输出反馈正文，不要开场白和客套话，不要出现「AI」「模型」等词，称呼家长为「xx家长」；成绩只讲事实、不做排名比较。',
].join('\n');

/**
 * git autocrlf=true 的仓库里，SQL 文件在全新 checkout 会被 smudge 成 CRLF，字面量换行随之带 \r 进库。
 * 逐字比较按 LF 归一——判据是内容恒等（迁移与 mock 镜像一致），不是 git 行尾工件。
 */
const asLF = (s: string): string => s.replace(/\r\n/g, '\n');

/** 0062 顺延：造「0016 之前的已装库」现场——版本退回 13，**并把 0017 加回的 stage 列撤掉**。
 *  结构迁移不可重入（0017 是 ADD COLUMN，重复执行报 duplicate column），只退版本号会污染现场；
 *  故退回版本与退回结构必须成对，才是自洽的 v13 库。 */
function regressToPre0016(db: Database): void {
  db.exec('ALTER TABLE questions DROP COLUMN stage;');
  db.setUserVersion(VERSION_0016 - 1);
}

describe('0059 反馈提示词换代（迁移 0016 / version 14）', () => {
  let tempDir: string;
  let dbPath: string;
  /** 本用例打开过的库，afterEach 统一关闭（Windows 上不关句柄 rmSync 会 EBUSY） */
  let opened: Database[];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'feedback-prompt-tune-'));
    dbPath = join(tempDir, 'test.db');
    opened = [];
  });

  afterEach(() => {
    // 手动 close 过的库已从 opened 移除；用例中途抛错时在此兜底关闭（Windows 不关句柄 rmSync 会 EBUSY）
    for (const db of opened) {
      try {
        db.close();
      } catch {
        // 已关闭的库重复 close 抛错，忽略
      }
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  function open(path: string = dbPath): Database {
    const db = openDatabase(path, migrationsDir);
    opened.push(db);
    return db;
  }

  function realExt(db: Database): BankExtServices {
    return createExtServices(db);
  }

  async function builtinById(ext: BankExtServices, id: string): Promise<FeedbackPromptTemplate> {
    const tpl = (await ext.feedbackPrompt.listTemplates()).find((t) => t.id === id);
    expect(tpl, `内置模板 ${id} 应在表中`).toBeDefined();
    return tpl!;
  }

  it('a) 新库：四条内置在（id/名/is_builtin 对表 + 新正文特征 + 新档排后）', async () => {
    const db = open();
    const ext = realExt(db);

    const builtins = (await ext.feedbackPrompt.listTemplates()).filter((t) => t.isBuiltin);
    expect(builtins.map((t) => [t.id, t.name])).toEqual([
      [ID_GENERAL, '通用课后反馈'],
      [ID_EXAM, '考后成绩反馈'],
      [ID_PRIMARY, '通用课后反馈·小学'],
      [ID_SENIOR, '通用课后反馈·高中'],
    ]);

    for (const id of [ID_GENERAL, ID_EXAM]) {
      const body = (await builtinById(ext, id)).body;
      expect(body).toContain(OUTPUT_HEADING);
      expect(body).toContain(EXAMPLE_HEADING);
      expect(body).toContain(`${NEW_REMARK_LABEL}{备注}`);
      expect(body).not.toContain('备注：{备注}');
    }
    expect(db.getUserVersion()).toBe(VERSION_TOP);
  });

  it('b) 已装库刷新：0010 旧正文 + version 13 → 重开库正文=新正文、version=15（0062 顺延）', async () => {
    // 造「已装库」现场（任务书 §一 P4b：完整库上把两条内置退回 0010 旧文本，版本退到 0016 的 version−1）
    const installed = open();
    installed.prepare(
      `UPDATE feedback_prompt_templates SET body = ? WHERE id = ? AND is_builtin = 1`,
    ).run(OLD_GENERAL_BODY, ID_GENERAL);
    installed.prepare(
      `UPDATE feedback_prompt_templates SET body = ? WHERE id = ? AND is_builtin = 1`,
    ).run(OLD_EXAM_BODY, ID_EXAM);
    regressToPre0016(installed);
    installed.close();
    opened = opened.filter((d) => d !== installed);

    const reopened = open();
    expect(reopened.getUserVersion()).toBe(VERSION_TOP);
    const ext = realExt(reopened);
    expect((await builtinById(ext, ID_GENERAL)).body).toBe(asLF(BUILTIN_PROMPT_GENERAL));
    expect((await builtinById(ext, ID_EXAM)).body).toBe(asLF(BUILTIN_PROMPT_EXAM));
    expect((await builtinById(ext, ID_GENERAL)).body).not.toBe(OLD_GENERAL_BODY);
  });

  it('c) is_builtin=0 一字节不动：同名「通用课后反馈」自定义模板与另一条自定义，重跑 0016 后逐字节不变', async () => {
    const first = open();
    const ext1 = realExt(first);
    // 同名自定义（模拟「另存为我的模板」副本）：正文用旧文本，验证它不被 0016 误刷
    const sameName = await ext1.feedbackPrompt.createTemplate({ name: '通用课后反馈', body: OLD_GENERAL_BODY });
    const other = await ext1.feedbackPrompt.createTemplate({ name: '我的·快版', body: '给{学生姓名}的短反馈：{课堂内容}' });
    expect(sameName.isBuiltin).toBe(false);

    regressToPre0016(first);
    first.close();
    opened = opened.filter((d) => d !== first);

    const second = open();
    expect(second.getUserVersion()).toBe(VERSION_TOP);
    const ext2 = realExt(second);

    const rereadSame = await ext2.feedbackPrompt.getTemplate(sameName.id);
    expect(rereadSame, '同名自定义模板应在').toBeDefined();
    expect(rereadSame!.body).toBe(OLD_GENERAL_BODY);
    expect(rereadSame!.updatedAt).toBe(sameName.updatedAt);
    expect(rereadSame!.isBuiltin).toBe(false);

    const rereadOther = await ext2.feedbackPrompt.getTemplate(other.id);
    expect(rereadOther!.body).toBe('给{学生姓名}的短反馈：{课堂内容}');
    expect(rereadOther!.updatedAt).toBe(other.updatedAt);

    // 内置四条照常在，且与同名自定义并存（同名不互斥：幂等 INSERT 只看 is_builtin=1 的同名）
    const all = await ext2.feedbackPrompt.listTemplates();
    expect(all.filter((t) => t.isBuiltin)).toHaveLength(4);
    expect(all.filter((t) => !t.isBuiltin && t.name === '通用课后反馈')).toHaveLength(1);
  });

  it('d) 幂等：0016 连跑两次，内置仍 4 条、id/名无重复、正文与 updated_at 逐字节一致', () => {
    const db1 = open();
    const read = (db: Database) => db.prepare(
      `SELECT id, name, body, updated_at FROM feedback_prompt_templates WHERE is_builtin = 1 AND deleted = 0 ORDER BY id`,
    ).all();
    const first = read(db1);
    expect(first).toHaveLength(4);

    regressToPre0016(db1);
    db1.close();
    opened = opened.filter((d) => d !== db1);

    const db2 = open();
    expect(db2.getUserVersion()).toBe(VERSION_TOP);
    const second = read(db2);
    expect(second).toEqual(first);
    const ids = second.map((r) => r.id);
    const names = second.map((r) => r.name);
    expect(new Set(ids).size).toBe(4);
    expect(new Set(names).size).toBe(4);
  });

  it('e) 硬约束：四条各含全部 10 槽位；general/exam 含去 AI 味四子串；零英文单引号', async () => {
    const ext = realExt(open());
    for (const id of [ID_GENERAL, ID_EXAM, ID_PRIMARY, ID_SENIOR]) {
      const body = (await builtinById(ext, id)).body;
      for (const slot of TEN_SLOTS) {
        expect(body, `${id} 缺槽位 ${slot}`).toContain(slot);
      }
      // §0.5：SQL 字面量安全性——正文出现英文单引号即说明有人动了正文（迁移会语法崩）
      expect(body.includes("'"), `${id} 出现英文单引号`).toBe(false);
    }
    for (const id of [ID_GENERAL, ID_EXAM]) {
      const body = (await builtinById(ext, id)).body;
      expect(body).toContain('不得编造');
      expect(body).toContain('不得改动数字');
      expect(body).toContain('「AI」「模型」');
      expect(body).toContain('xx家长');
    }
  });

  it('f) 防漂移锁：真库四条内置 body 与 mock 播种逐字一致；既有两条与 mock 常量严格 toBe；模板名序列相等', async () => {
    const ext = realExt(open());
    const realBuiltins = (await ext.feedbackPrompt.listTemplates()).filter((t) => t.isBuiltin);

    const mockExt = createMockExtServices(new MockBankStore());
    const mockBuiltins = (await mockExt.feedbackPrompt.listTemplates()).filter((t) => t.isBuiltin);

    // 两实现的内置顺位一致（顺序断言防 created_at 并列退化；新档靠 12:00 时间戳排在旧档后）
    expect(realBuiltins.map((t) => t.id)).toEqual(mockBuiltins.map((t) => t.id));
    expect(realBuiltins.map((t) => t.name)).toEqual(mockBuiltins.map((t) => t.name));

    const mockById = new Map(mockBuiltins.map((t) => [t.id, t]));
    for (const t of realBuiltins) {
      expect(asLF(t.body), `${t.id} 真库正文与 mock 播种不一致`).toBe(mockById.get(t.id)?.body);
    }

    // 字面锚：改迁移必须同步改 mock 常量（任务书 §0.4 口径），反之亦然
    const realById = new Map(realBuiltins.map((t) => [t.id, t]));
    expect(asLF(realById.get(ID_GENERAL)?.body ?? '')).toBe(BUILTIN_PROMPT_GENERAL);
    expect(asLF(realById.get(ID_EXAM)?.body ?? '')).toBe(BUILTIN_PROMPT_EXAM);
  });

  it('g) 新增两条内置只读：update/delete 一律抛错（与既有两条同口径）', async () => {
    const ext = realExt(open());
    for (const id of [ID_PRIMARY, ID_SENIOR]) {
      const tpl = await builtinById(ext, id);
      expect(tpl.isBuiltin).toBe(true);
      await expect(ext.feedbackPrompt.updateTemplate(tpl.id, { body: '改一改' })).rejects.toThrow();
      await expect(ext.feedbackPrompt.deleteTemplate(tpl.id)).rejects.toThrow();
    }
  });
});
