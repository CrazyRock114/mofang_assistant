// 0062 学段落库（R-066 / D-076② 翻案 B2）：迁移 0017 questions.stage ADD COLUMN / 运行时 version 15。
// 覆盖（任务书 §一.8 / §四）：
//   a) 迁移 v14 现场 → 重开库：questions 有 stage 列、存量行 stage 全 NULL、其余列逐行零漂移；
//   b) 写侧 createQuestion 落 stage → getQuestion/listQuestions 真库往返（mock 同构）；
//   c) 读侧 filter.stage 三态（题级命中 / 题级空回退树 / 题级空未挂树按「未分组」命中）
//      + 题级优先反向锁（题级='高中' 且挂初中学段树 → 筛「初中」不命中）。
// 任务书：0062 任务书

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BankExtServices, BankService, Question } from '../../src/shared/contracts/bank-types.js';
import { Database, openDatabase } from '../../src/bank/db.js';
import { BankServiceImpl } from '../../src/bank/bank-service.js';
import { createExtServices } from '../../src/bank/ext-services.js';
import { MockBankService } from '../../src/bank/mock/mock-bank.js';
import { createMockExtServices } from '../../src/bank/mock/mock-ext.js';
import { MockBankStore } from '../../src/bank/mock/mock-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '../../src/bank/migrations');

/** 0017 注册后的运行时 version（db.ts 末位顺延：…0015→13 / 0016→14 / 0017→15） */
const VERSION_0017 = 15;

/**
 * 0017 之前的执行器口径顺序（0001…0016）：迁移号与文件序号自 0011 后错位
 * （0012→v9 / 0013→v10 / 0014→v11 / 0010→v12 / 0015→v13 / 0016→v14），故不按文件名排。
 */
const V14_ORDER = [
  '0001_initial.sql', '0002_bank_ext.sql', '0003_basket_ext.sql', '0004_a3_landscape.sql',
  '0005_feedback.sql', '0006_fix4_text_block.sql', '0007_fix6_text_align.sql', '0008_model_profiles.sql',
  '0012_recog_runs.sql', '0013_paper_folders.sql', '0014_paper_type_check.sql', '0010_feedback_records.sql',
  '0015_recog_image_assets.sql', '0016_feedback_prompt_tune.sql',
];

function columnNames(db: Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

/** 造 v14 现场（0017 未应用的最后一版）：逐文件一事务应用 V14_ORDER，末尾锚 user_version=14 */
function createV14Database(path: string): Database {
  const db = new Database(path);
  db.exec('PRAGMA foreign_keys = OFF;');
  try {
    for (const file of V14_ORDER) {
      db.transaction(() => {
        db.exec(readFileSync(join(migrationsDir, file), 'utf8'));
      });
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }
  db.setUserVersion(VERSION_0017 - 1);
  return db;
}

/** v14 现场的最小存量行（NOT NULL 列全给；images 走 DEFAULT '[]'） */
const LEGACY_ROWS = [
  { id: 'legacy-1', subject: '物理', content: '<div class="question"><p>旧题一</p></div>' },
  { id: 'legacy-2', subject: '数学', content: '<div class="question"><p>旧题二</p></div>' },
];

function seedLegacyRows(db: Database): void {
  const insert = db.prepare(
    `INSERT INTO questions (id, subject, source_type, source_detail, content, created_at, updated_at)
     VALUES (?, ?, 'local', '{"origin":"manual"}', ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  );
  for (const row of LEGACY_ROWS) insert.run(row.id, row.subject, row.content);
}

/** 剔 stage 列后逐行比较（「加列之外零漂移」的判据） */
function withoutStage(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map((row) => {
    const { stage: _stage, ...rest } = row;
    return rest;
  });
}

describe('0062 迁移 0017：questions.stage 加回（v14→v15）', () => {
  let tempDir: string;
  /** 本用例打开过的库，afterEach 统一关闭（Windows 上不关句柄 rmSync 会 EBUSY） */
  let opened: Database[];

  const open = (): Database => {
    const db = openDatabase(join(tempDir, 'bank.db'), migrationsDir);
    opened.push(db);
    return db;
  };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), '0062-stage-'));
    opened = [];
  });

  afterEach(() => {
    for (const db of opened) {
      try {
        db.close();
      } catch {
        // 已关闭的库重复 close 抛错，忽略
      }
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('a) 空库全量迁移：version=15 + questions 有 stage 列（在 0002 删列之后加回）', () => {
    const db = open();
    expect(db.getUserVersion()).toBe(VERSION_0017);
    expect(columnNames(db, 'questions')).toContain('stage');
  });

  it('b) v14 现场 → 重开库：加列成功、存量行 stage 全 NULL、其余列逐行零漂移', () => {
    const legacy = createV14Database(join(tempDir, 'bank.db'));
    // 前提锁定：v14 的 questions 无 stage 列（0002:182 DROP COLUMN 的现场）
    expect(legacy.getUserVersion()).toBe(VERSION_0017 - 1);
    expect(columnNames(legacy, 'questions')).not.toContain('stage');
    seedLegacyRows(legacy);
    const before = legacy.prepare('SELECT * FROM questions ORDER BY id').all() as Array<Record<string, unknown>>;
    expect(before).toHaveLength(LEGACY_ROWS.length);
    legacy.close();
    opened = opened.filter((d) => d !== legacy);

    const db = open();
    expect(db.getUserVersion()).toBe(VERSION_0017);
    expect(columnNames(db, 'questions')).toContain('stage');

    const after = db.prepare('SELECT * FROM questions ORDER BY id').all() as Array<Record<string, unknown>>;
    expect(after).toHaveLength(before.length);
    // 存量行 stage 为 NULL（不回填口径：任务书 §一.7）
    expect(after.map((r) => r.stage)).toEqual(LEGACY_ROWS.map(() => null));
    // 除 stage 外零漂移（行数 + 逐行逐列）
    expect(withoutStage(after)).toEqual(withoutStage(before));
  });

  it('c) 重开幂等：v15 库再开一次不重复加列、version 不动', () => {
    const first = open();
    expect(first.getUserVersion()).toBe(VERSION_0017);
    first.close();
    opened = opened.filter((d) => d !== first);

    const second = open();
    expect(second.getUserVersion()).toBe(VERSION_0017);
    expect(columnNames(second, 'questions').filter((c) => c === 'stage')).toEqual(['stage']);
  });
});

// ---------------- 写侧 / 读侧：真库 + mock 同构参数化 ----------------

interface StageCtx {
  bank: BankService;
  ext: BankExtServices;
  cleanup: () => void;
}

const implementations: Array<{ name: string; factory: () => StageCtx }> = [
  {
    name: 'Real (SQLite)',
    factory: () => {
      const tempDir = mkdtempSync(join(tmpdir(), '0062-stage-svc-'));
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

/** 造题入参（content 必填；extra 覆盖 stage 等） */
function qData(content: string, extra: Partial<Omit<Question, 'id' | 'createdAt' | 'updatedAt'>> = {}) {
  return {
    subject: '物理',
    sourceType: 'local' as const,
    sourceDetail: { origin: 'manual' as const },
    content,
    images: [],
    ...extra,
  };
}

implementations.forEach(({ name, factory }) => {
  describe(`0062 学段落库与筛题 - ${name}`, () => {
    let ctx: StageCtx;
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

    it('写侧：带 stage 入库 → getQuestion/listQuestions 读回同值；不带 stage → undefined', async () => {
      const created = await bank.createQuestion(qData('<div class="question">高中题</div>', { stage: '高中' }));
      expect(created.stage).toBe('高中');

      const read = await bank.getQuestion(created.id);
      expect(read!.stage).toBe('高中');
      const listed = (await bank.listQuestions()).find((q) => q.id === created.id);
      expect(listed!.stage).toBe('高中');

      const bare = await bank.createQuestion(qData('<div class="question">未选学段题</div>'));
      expect((await bank.getQuestion(bare.id))!.stage).toBeUndefined();
    });

    it('读侧三态：题级命中 / 题级空回退树 / 题级空未挂树按「未分组」命中 + 题级优先反向锁', async () => {
      const junior = await ext.tree.createTree({ type: 'knowledge', name: '初中物理树', stage: '初中' });
      const blankTree = await ext.tree.createTree({ type: 'knowledge', name: '无学段树' });
      const jNode = await ext.tree.createNode({ treeId: junior.id, name: '初中节点', sort: 0 });
      const bNode = await ext.tree.createNode({ treeId: blankTree.id, name: '无学段节点', sort: 0 });

      // ① 题级='高中' 且挂初中学段树 —— 题级优先反向锁（树侧不参与）
      const qLevelSenior = await bank.createQuestion(qData('<div class="question">A 题级高中</div>', { stage: '高中' }));
      // ② 题级='初中' 且未挂树 —— 题级命中（不因未挂树而漏）
      const qLevelJunior = await bank.createQuestion(qData('<div class="question">B 题级初中</div>', { stage: '初中' }));
      // ③ 题级空 + 挂初中学段树 —— 回退树 stage
      const qTreeJunior = await bank.createQuestion(qData('<div class="question">C 空题级挂初中树</div>'));
      // ④ 题级空 + 从未挂树 —— 按「未分组」参与
      const qOrphan = await bank.createQuestion(qData('<div class="question">D 空题级未挂树</div>'));
      // ⑤ 题级空 + 挂无学段树 —— 回退树归一「未分组」
      const qTreeBlank = await bank.createQuestion(qData('<div class="question">E 空题级挂无学段树</div>'));

      await ext.tree.linkQuestion(qLevelSenior.id, jNode.id);
      await ext.tree.linkQuestion(qTreeJunior.id, jNode.id);
      await ext.tree.linkQuestion(qTreeBlank.id, bNode.id);

      const mine = new Set([qLevelSenior.id, qLevelJunior.id, qTreeJunior.id, qOrphan.id, qTreeBlank.id]);
      const pick = (questions: Question[]): string[] => questions.map((q) => q.id).filter((id) => mine.has(id)).sort();

      // 筛「初中」：题级命中 ② + 回退树 ③；题级='高中' 的 ① 不命中（反向锁）、④⑤ 不命中
      expect(pick(await bank.listQuestions({ stage: '初中' }))).toEqual([qLevelJunior.id, qTreeJunior.id].sort());
      // 筛「高中」：只中题级 ①（挂的是初中树也不影响）
      expect(pick(await bank.listQuestions({ stage: '高中' }))).toEqual([qLevelSenior.id]);
      // 筛「未分组」：题级空 + 未挂树 ④ + 回退树归一 ⑤；③（题级空 + 挂初中学段树）不在内
      //（§一.4 散文口径「挂了树回退树 stage」+ §六 目检清单「已挂树的旧题筛选行为不变」——
      //  该格与任务书 §一.4 的示意 SQL 块不同：块内首分支 COALESCE 会把挂树题也算进「未分组」，
      //  使「未分组」变成「全部题级空题」；本实现取分区口径，见交付报告 §申报.1）
      expect(pick(await bank.listQuestions({ stage: '未分组' }))).toEqual([qOrphan.id, qTreeBlank.id].sort());
      // 空串 = 不过滤（五题全在）
      expect(pick(await bank.listQuestions({ stage: '' }))).toHaveLength(5);
    });

    it('读侧分区不变式：每题恰好落一个学段筛（题级优先 / 空回退树 / 未挂树归「未分组」）', async () => {
      const junior = await ext.tree.createTree({ type: 'knowledge', name: '初中物理树', stage: '初中' });
      const senior = await ext.tree.createTree({ type: 'knowledge', name: '高中物理树', stage: '高中' });
      const blankTree = await ext.tree.createTree({ type: 'knowledge', name: '无学段树' });
      const jNode = await ext.tree.createNode({ treeId: junior.id, name: '初中节点', sort: 0 });
      const sNode = await ext.tree.createNode({ treeId: senior.id, name: '高中节点', sort: 0 });
      const bNode = await ext.tree.createNode({ treeId: blankTree.id, name: '无学段节点', sort: 0 });

      const cases: Array<[string, string | undefined, string | null]> = [
        ['题级高中挂初中树', '高中', jNode.id],
        ['题级初中挂高中树', '初中', sNode.id],
        ['题级空挂初中树', undefined, jNode.id],
        ['题级空挂无学段树', undefined, bNode.id],
        ['题级空未挂树', undefined, null],
      ];
      const made: Array<{ id: string; label: string }> = [];
      for (const [label, stage, nodeId] of cases) {
        const q = await bank.createQuestion(qData(`<div class="question">${label}</div>`, stage ? { stage } : {}));
        if (nodeId) await ext.tree.linkQuestion(q.id, nodeId);
        made.push({ id: q.id, label });
      }

      for (const { id, label } of made) {
        const hits: string[] = [];
        for (const stage of ['初中', '高中', '未分组']) {
          if ((await bank.listQuestions({ stage })).some((q) => q.id === id)) hits.push(stage);
        }
        // 恰一个学段命中；label 参与断言以便失败时定位是哪一格的语义破了
        expect([label, hits.length]).toEqual([label, 1]);
      }
    });

    it('读侧与 treeNodeId 叠加：题级优先口径下节点筛 + 学段筛同时成立才命中', async () => {
      const junior = await ext.tree.createTree({ type: 'knowledge', name: '初中物理树', stage: '初中' });
      const jNode = await ext.tree.createNode({ treeId: junior.id, name: '初中节点', sort: 0 });
      const jNode2 = await ext.tree.createNode({ treeId: junior.id, name: '初中节点二', sort: 1 });

      const qLevelJunior = await bank.createQuestion(qData('<div class="question">F</div>', { stage: '初中' }));
      const qLevelSenior = await bank.createQuestion(qData('<div class="question">G</div>', { stage: '高中' }));
      await ext.tree.linkQuestion(qLevelJunior.id, jNode.id);
      await ext.tree.linkQuestion(qLevelSenior.id, jNode2.id);

      const mine = new Set([qLevelJunior.id, qLevelSenior.id]);
      const pick = (questions: Question[]): string[] => questions.map((q) => q.id).filter((id) => mine.has(id));

      expect(pick(await bank.listQuestions({ stage: '初中', treeNodeId: jNode.id }))).toEqual([qLevelJunior.id]);
      expect(pick(await bank.listQuestions({ stage: '初中', treeNodeId: jNode2.id }))).toEqual([]);
    });
  });
});
