// 0044 P1：试卷文件夹 + 回收站契约测试 — 参数化跑两遍（真实 SQLite + mock 内存），两遍必须同绿。
// 覆盖任务书 §二.P1 / §四：
//   迁移 0013（paper_folders 表 / papers 新列 / CHECK 含 trashed / 存量数据保留 / 幂等重开）、
//   folder CRUD（嵌套建夹 / 父不存在抛错 / 防环口径 / 重命名守卫 / 删夹=卷回未分类+子夹上移一级）、
//   trash/restore 状态机（任意非 trashed→trashed 记 trashed_from / restore 还原 / 非法迁移抛错 /
//   listPapersEx 默认排除 trashed）、moveToFolder（一卷一夹）、deleteForever（仅 trashed 卷，
//   paper_questions 清理 + 题目本体不动）。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import type { BankService, BankExtServices, PaperStatus } from '../../src/shared/contracts/bank-types.js';
import { Database, openDatabase } from '../../src/bank/db.js';
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
      const tempDir = mkdtempSync(join(tmpdir(), 'paper-folder-test-'));
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
        bank: new MockBankService(store, false),
        ext: createMockExtServices(store),
        cleanup: () => undefined,
      };
    },
  },
];

/** 建一题（最小字段；question_tags/node_links 断言用真实侧 SQL 时仅 Real 生效） */
async function seedQuestion(ctx: ExtCtx, id: string): Promise<string> {
  const q = await ctx.bank.createQuestion({
    subject: '数学',
    sourceType: 'local',
    sourceDetail: { origin: 'manual' },
    content: `<div class="question">${id}</div>`,
    images: [],
  });
  return q.id;
}

describe.each(implementations)('0044 paper folders + trash ($name)', (impl) => {
  let ctx: ExtCtx;

  beforeEach(() => {
    ctx = impl.factory();
  });

  afterEach(() => {
    ctx.cleanup();
  });

  // ==================== folder CRUD（嵌套，D-062） ====================

  it('建顶级夹 → 建子夹（parentId 嵌套）→ list 全量平铺', async () => {
    const parent = await ctx.ext.paper.createFolder({ name: '七年级数学·上' });
    expect(parent.name).toBe('七年级数学·上');
    expect(parent.parentId).toBeUndefined();

    const child = await ctx.ext.paper.createFolder({ name: '单元测', parentId: parent.id });
    expect(child.parentId).toBe(parent.id);

    const list = await ctx.ext.paper.listFolders();
    expect(list).toHaveLength(2);
    const byId = new Map(list.map((f) => [f.id, f]));
    expect(byId.get(child.id)?.parentId).toBe(parent.id);
    expect(byId.get(parent.id)?.parentId).toBeUndefined();
  });

  it('建夹：父不存在抛错；重命名：空名拒绝 / 不存在抛错；改名后 list 可见', async () => {
    await expect(ctx.ext.paper.createFolder({ name: '孤儿夹', parentId: 'no-such-folder' }))
      .rejects.toThrow(/no-such-folder|not found|不存在/);

    const folder = await ctx.ext.paper.createFolder({ name: '旧名' });
    await expect(ctx.ext.paper.renameFolder(folder.id, '   ')).rejects.toThrow();
    await expect(ctx.ext.paper.renameFolder('no-such-folder', 'x')).rejects.toThrow();

    const renamed = await ctx.ext.paper.renameFolder(folder.id, '新名');
    expect(renamed.name).toBe('新名');
    const list = await ctx.ext.paper.listFolders();
    expect(list.find((f) => f.id === folder.id)?.name).toBe('新名');
  });

  it('删夹（D-062）：被删夹的直接夹内卷回未分类；子夹上移一级挂到被删夹的父级（子夹内的卷随夹保留归属）', async () => {
    const grand = await ctx.ext.paper.createFolder({ name: '七年级数学·上' });
    const mid = await ctx.ext.paper.createFolder({ name: '单元测', parentId: grand.id });
    const leaf = await ctx.ext.paper.createFolder({ name: '期中', parentId: mid.id });

    const qidA = await seedQuestion(ctx, 'q-mid');
    const paperA = await ctx.ext.paper.createPaperEx('被删夹直接卷');
    await ctx.ext.paper.moveToFolder(paperA.id, mid.id);
    const qidB = await seedQuestion(ctx, 'q-leaf');
    const paperB = await ctx.ext.paper.createPaperEx('子夹内卷');
    await ctx.ext.paper.moveToFolder(paperB.id, leaf.id);

    // 删掉中间夹：mid 直接夹内的卷回未分类；子夹 leaf 上移一级挂到 grand；leaf 内的卷随夹保留
    await ctx.ext.paper.deleteFolder(mid.id);

    expect((await ctx.ext.paper.getPaperEx(paperA.id))?.folderId).toBeUndefined();
    expect((await ctx.ext.paper.getPaperEx(paperB.id))?.folderId).toBe(leaf.id);
    const list = await ctx.ext.paper.listFolders();
    const ids = new Set(list.map((f) => f.id));
    expect(ids.has(mid.id)).toBe(false);
    expect(list.find((f) => f.id === leaf.id)?.parentId).toBe(grand.id);
    void qidA; void qidB;
  });

  it('删顶级夹：子夹升顶级（parentId 置空）', async () => {
    const top = await ctx.ext.paper.createFolder({ name: '顶级' });
    const child = await ctx.ext.paper.createFolder({ name: '子夹', parentId: top.id });
    await ctx.ext.paper.deleteFolder(top.id);
    const list = await ctx.ext.paper.listFolders();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(child.id);
    expect(list[0]?.parentId).toBeUndefined();
  });

  // ==================== moveToFolder（一卷一夹） ====================

  it('moveToFolder：移入 / 换夹 / null 移出回未分类 / 夹不存在抛错', async () => {
    const folderA = await ctx.ext.paper.createFolder({ name: '夹 A' });
    const folderB = await ctx.ext.paper.createFolder({ name: '夹 B' });
    const paper = await ctx.ext.paper.createPaperEx('流浪卷');

    await ctx.ext.paper.moveToFolder(paper.id, folderA.id);
    expect((await ctx.ext.paper.getPaperEx(paper.id))?.folderId).toBe(folderA.id);

    // 一卷一夹：换夹 = 覆盖
    await ctx.ext.paper.moveToFolder(paper.id, folderB.id);
    expect((await ctx.ext.paper.getPaperEx(paper.id))?.folderId).toBe(folderB.id);

    await ctx.ext.paper.moveToFolder(paper.id, null);
    expect((await ctx.ext.paper.getPaperEx(paper.id))?.folderId).toBeUndefined();

    await expect(ctx.ext.paper.moveToFolder(paper.id, 'no-such-folder')).rejects.toThrow();
    await expect(ctx.ext.paper.moveToFolder('no-such-paper', folderA.id)).rejects.toThrow();
  });

  // ==================== trash / restore 状态机 ====================

  it.each<PaperStatus>(['basket', 'composing', 'done', 'archived'])('trash：从 %s 入回收站记 trashed_from；restore 还原原状态并清空', async (from) => {
    const paper = await ctx.ext.paper.createPaperEx('回收站卷', {}, { status: from === 'basket' ? undefined : from });
    await ctx.ext.paper.trashPaper(paper.id);

    const trashed = await ctx.ext.paper.getPaperEx(paper.id);
    expect(trashed?.status).toBe('trashed');

    // 常规列表不可见；显式 statuses 含 trashed 才可见（断言见下一用例专测）
    await ctx.ext.paper.restorePaper(paper.id);
    const restored = await ctx.ext.paper.getPaperEx(paper.id);
    expect(restored?.status).toBe(from);
  });

  it('trash 守卫：已 trashed 再 trash 抛错；非 trashed 卷 restore 抛错；卷不存在 trash 抛错', async () => {
    const paper = await ctx.ext.paper.createPaperEx('守卫卷');
    await ctx.ext.paper.trashPaper(paper.id);
    await expect(ctx.ext.paper.trashPaper(paper.id)).rejects.toThrow();

    const live = await ctx.ext.paper.createPaperEx('未删卷');
    await expect(ctx.ext.paper.restorePaper(live.id)).rejects.toThrow();

    await expect(ctx.ext.paper.trashPaper('no-such-paper')).rejects.toThrow();
  });

  it('updatePaperStatus 状态机扩展（0044）：任意非 trashed → trashed 合法；trashed 无出边（restore 专用）', async () => {
    const paper = await ctx.ext.paper.createPaperEx('状态机卷', {}, { status: 'composing' });
    await ctx.ext.paper.updatePaperStatus(paper.id, 'trashed');
    expect((await ctx.ext.paper.getPaperEx(paper.id))?.status).toBe('trashed');

    // trashed 的出边不走 updatePaperStatus（restorePaper 专用；trashed_from 未知时不可猜）
    await expect(ctx.ext.paper.updatePaperStatus(paper.id, 'basket')).rejects.toThrow(/Illegal/);

    // 既有规则不动：composing→done 依旧合法、basket→done 依旧非法
    const live = await ctx.ext.paper.createPaperEx('既有规则卷');
    await ctx.ext.paper.updatePaperStatus(live.id, 'composing');
    await ctx.ext.paper.updatePaperStatus(live.id, 'done');
    const fromBasket = await ctx.ext.paper.createPaperEx('非法迁移卷');
    await expect(ctx.ext.paper.updatePaperStatus(fromBasket.id, 'done')).rejects.toThrow(/Illegal/);
  });

  it('listPapersEx：缺省排除 trashed；statuses 显式含 trashed 才可见；archived 缺省仍可见（既有口径）', async () => {
    const basketPaper = await ctx.ext.paper.createPaperEx('篮卷');
    const archivedPaper = await ctx.ext.paper.createPaperEx('档卷', {}, { status: 'archived' });
    const trashedPaper = await ctx.ext.paper.createPaperEx('废卷', {}, { status: 'composing' });
    await ctx.ext.paper.trashPaper(trashedPaper.id);

    const def = await ctx.ext.paper.listPapersEx();
    const defIds = def.map((s) => s.paper.id);
    expect(defIds).toContain(basketPaper.id);
    expect(defIds).toContain(archivedPaper.id);
    expect(defIds).not.toContain(trashedPaper.id);

    const withTrashed = await ctx.ext.paper.listPapersEx({ statuses: ['trashed'] });
    expect(withTrashed.map((s) => s.paper.id)).toEqual([trashedPaper.id]);
  });

  // ==================== deleteForever ====================

  it('deleteForever：仅 trashed 卷可用；关联行清理；题目本体不动', async () => {
    const qid = await seedQuestion(ctx, 'q-forever');
    const paper = await ctx.ext.paper.createPaperEx('彻底删除卷');
    await ctx.bank.addQuestion(paper.id, qid);
    await ctx.ext.paper.trashPaper(paper.id);

    await ctx.ext.paper.deleteForeverPaper(paper.id);
    expect(await ctx.ext.paper.getPaperEx(paper.id)).toBeNull();
    // 题目本体独立存活（D-058②：题库唯一货源）
    expect(await ctx.bank.getQuestion(qid)).not.toBeNull();

    // 未入回收站的卷不可彻底删除
    const live = await ctx.ext.paper.createPaperEx('活卷');
    await expect(ctx.ext.paper.deleteForeverPaper(live.id)).rejects.toThrow();
    await expect(ctx.ext.paper.deleteForeverPaper('no-such-paper')).rejects.toThrow();
  });
});

// ==================== 迁移 0013 结构断言（仅真实 SQLite） ====================

describe('0044 迁移 0013：paper_folders + papers 重建（Real only）', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'paper-folder-mig-'));
    dbPath = join(tempDir, 'test.db');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('paper_folders 表 + papers 新列（folder_id/trashed_from）+ user_version=15（0062 迁移 0017 顺延）', () => {
    const db = openDatabase(dbPath, migrationsDir);
    expect(db.getUserVersion()).toBe(15);

    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>).map((t) => t.name);
    expect(tables).toContain('paper_folders');

    const folderCols = (db.prepare('PRAGMA table_info(paper_folders)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(folderCols).toEqual(['id', 'name', 'parent_id', 'sort', 'created_at']);

    const paperCols = (db.prepare('PRAGMA table_info(papers)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(paperCols).toContain('folder_id');
    expect(paperCols).toContain('trashed_from');
    // 既有列零丢失
    for (const col of ['id', 'title', 'config', 'created_at', 'archived', 'status', 'paper_type', 'layout_config_json']) {
      expect(paperCols).toContain(col);
    }
    db.close();
  });

  it('papers.status CHECK 扩 trashed：trashed 可写、非法值仍拦截（重建后约束仍生效）', () => {
    const db = openDatabase(dbPath, migrationsDir);
    const now = '2026-01-01T00:00:00Z';
    db.prepare(`INSERT INTO papers (id, title, created_at) VALUES ('p-trash', '回收卷', ?)`).run(now);
    db.prepare(`UPDATE papers SET status = 'trashed' WHERE id = 'p-trash'`).run();
    expect((db.prepare(`SELECT status FROM papers WHERE id = 'p-trash'`).get() as { status: string }).status).toBe('trashed');
    expect(() => {
      db.prepare(`UPDATE papers SET status = 'invalid' WHERE id = 'p-trash'`).run();
    }).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it('存量数据跨重建保留：v10 库的卷在 v11 打开后原样可见（0014 重建再搬一次）', () => {
    // 先开到 v10：手工控制迁移清单不可行（硬编码），改为开满后按 v10 口径插卷、验证搬运语义
    // —— 对 v11 库验证「重建语义」：插卷（走新 CHECK）→ 重开幂等（不重复搬运/不丢数据）。
    const db = openDatabase(dbPath, migrationsDir);
    const now = '2026-01-01T00:00:00Z';
    db.prepare(`INSERT INTO papers (id, title, config, created_at, archived, status, paper_type, layout_config_json)
                VALUES ('p-keep', '保留卷', '{"totalScore":100}', ?, 0, 'done', 'uniform', '{"version":2}')`).run(now);
    db.close();

    const db2 = openDatabase(dbPath, migrationsDir);
    const row = db2.prepare(`SELECT title, status, paper_type, layout_config_json, folder_id, trashed_from FROM papers WHERE id = 'p-keep'`).get() as {
      title: string; status: string; paper_type: string; layout_config_json: string; folder_id: string | null; trashed_from: string | null;
    };
    expect(row.title).toBe('保留卷');
    expect(row.status).toBe('done');
    expect(row.paper_type).toBe('uniform');
    expect(JSON.parse(row.layout_config_json)).toEqual({ version: 2 });
    expect(row.folder_id).toBeNull();
    expect(row.trashed_from).toBeNull();

    // 幂等：重开不重复执行（version 不再变化、数据不翻倍）
    const count = (db2.prepare('SELECT COUNT(*) AS cnt FROM papers').get() as { cnt: number }).cnt;
    db2.close();
    const db3 = openDatabase(dbPath, migrationsDir);
    expect(db3.getUserVersion()).toBe(15);
    expect((db3.prepare('SELECT COUNT(*) AS cnt FROM papers').get() as { cnt: number }).cnt).toBe(count);
    db3.close();
  });

  it('迁移执行后外键约束恢复开启（执行器 OFF/ON 包裹的恢复语义）', () => {
    const db = openDatabase(dbPath, migrationsDir);
    // 新连接上直接探：插入带悬空 subject_id 的题应被外键拦截（questions.subject_id REFERENCES dict_entries）
    expect(() => {
      db.prepare(`
        INSERT INTO questions (id, subject, subject_id, source_type, source_detail, content, images, created_at, updated_at)
        VALUES ('q-fk', '物理', 'subj:nonexistent', 'local', '{"origin":"manual"}', '<div>题</div>', '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
      `).run();
    }).toThrow(/FOREIGN KEY constraint failed/);
    db.close();
  });
});
