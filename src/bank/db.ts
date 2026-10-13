// Phase 2: SQLite 数据库初始化、迁移执行器、user_version 管理

// 抑制 Node.js 22+ node:sqlite 的 ExperimentalWarning 控制台噪音
if (typeof process !== 'undefined' && typeof process.on === 'function') {
  process.on('warning', (warning) => {
    if (warning.name === 'ExperimentalWarning' && warning.message.includes('SQLite')) return;
    console.warn(warning);
  });
}

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export class Database {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    // 启用外键约束
    this.db.exec('PRAGMA foreign_keys = ON;');
  }

  getUserVersion(): number {
    const result = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    return result.user_version;
  }

  setUserVersion(version: number): void {
    this.db.exec(`PRAGMA user_version = ${version}`);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string) {
    return this.db.prepare(sql);
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN TRANSACTION');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  /**
   * 迁移执行器：事务内按序执行、更新版本号
   * 从 migrations/ 目录读取 SQL 文件
   */
  static runMigrations(db: Database, migrationsDir: string): void {
    const currentVersion = db.getUserVersion();
    const migrations: Array<{ version: number; path: string }> = [];

    // 硬编码迁移清单（避免运行时 fs.readdir 复杂性）
    migrations.push({ version: 1, path: join(migrationsDir, '0001_initial.sql') });
    // 0002 地基扩展：字典/树/学生班级/考试错题成绩/试卷集合/预设 + questions/papers 加列（0002 schema 草案）
    migrations.push({ version: 2, path: join(migrationsDir, '0002_bank_ext.sql') });
    // 0004 试题篮扩展：paper_questions 加 layout_json 列 + 内置预设种子 A3双列/A4（0004 任务书）
    migrations.push({ version: 3, path: join(migrationsDir, '0003_basket_ext.sql') });
    // 0004-fix-2 F2-A：内置预设种子 config 增 orientation（A3双列=landscape / A4=portrait）
    migrations.push({ version: 4, path: join(migrationsDir, '0004_a3_landscape.sql') });
    // 0005 课后反馈 M6：feedback_templates 表 + 内置默认模板种子（0005 任务书；
    // 任务书写作 version 4/0004_feedback.sql——version 4 已被 fix-2 迁移占用，依序顺延为 version 5）
    migrations.push({ version: 5, path: join(migrationsDir, '0005_feedback.sql') });
    // 0004-fix-4 2.3：paper_questions 加列 kind/text_body/style（大标题=文本内容块，不占题号）
    migrations.push({ version: 6, path: join(migrationsDir, '0006_fix4_text_block.sql') });
    // 0004-fix-6 P1-1：paper_questions 加列 text_align（文本内容块对齐 left/center/right；NULL=样式基线观感）
    migrations.push({ version: 7, path: join(migrationsDir, '0007_fix6_text_align.sql') });
    // 0023 模型配置体系：model_profiles 表（五角色档案 + Key 托管 + 测连通状态；0023 任务书 §一 P1.1）
    migrations.push({ version: 8, path: join(migrationsDir, '0008_model_profiles.sql') });
    // 0028 识别 run 基建：recog_runs + recog_run_pages（任务书 §一 P1；T-07 混合持久化）。
    // 文件名序号 0012 走预分配序列（0009=0027/0010=0030/0011=0031 已锚定），运行时 version 依序顺延为 9。
    migrations.push({ version: 9, path: join(migrationsDir, '0012_recog_runs.sql') });
    // 0044 试卷文件夹 + 回收站：paper_folders 表 + papers 重建（status CHECK 扩 'trashed' +
    // folder_id/trashed_from 两列；0044 任务书 §二.P1）。
    // 文件名序号 0013 走预分配序列（0013 原预占 0040、零迁移释放后改派），运行时 version=10。
    migrations.push({ version: 10, path: join(migrationsDir, '0013_paper_folders.sql') });
    // 0048 补回 papers.paper_type 的 CHECK：0013 重建 papers 时漏带 0002 的
    // CHECK (paper_type IN ('uniform','custom-mistake'))，按官方流程再重建一次补回
    // （0048 任务书 §一）。文件名 0014 走预分配序列，运行时 version=11。
    migrations.push({ version: 11, path: join(migrationsDir, '0014_paper_type_check.sql') });
    // 0030 反馈模块一期：feedback_records（双模式落档：批量关联档案 / 快速模式 student_id NULL 仅留痕）
    // + feedback_prompt_templates（AI 通道提示词模板，内置两条种子；0005 的 feedback_templates 继续承载
    // 离线通道，一字不动）。文件名序号 0010 走预分配序列（0009=0027/0011=0031 已锚定），
    // 运行时 version 依序顺延为 12（0030 任务书 头部「迁移授权」）。
    migrations.push({ version: 12, path: join(migrationsDir, '0010_feedback_records.sql') });
    // 0057 录题图资产化：无结构变更的口径占位迁移（存量题 content 内联 data URL 的真实回填在
    // 外壳启动期做——SQLite 无 base64 解码与文件写能力，见 0015 文件头）。
    // 文件名序号 0015 走预分配序列（D-070：0015=0057 / 0016=0059），运行时 version=13。
    migrations.push({ version: 13, path: join(migrationsDir, '0015_recog_image_assets.sql') });
    // 0059 反馈提示词优化（R-056）：内置 AI 提示词模板换代——通用/考后两条 UPDATE 重写、小学/高中两条
    // INSERT 新增（采用稿四条正文逐字入库）。已装库必须靠本迁移刷新：0010 已跑完且其种子带
    // WHERE NOT EXISTS，改 0010 正文对已装库零效果（见 0016 文件头）。
    // 文件名序号 0016 走预分配序列（D-070：0015=0057 / 0016=0059），运行时 version=14。
    migrations.push({ version: 14, path: join(migrationsDir, '0016_feedback_prompt_tune.sql') });
    // 0062 学段落库（R-066 / D-076② 翻案 B2）：questions.stage 加回（0002 DROP COLUMN 的翻案；
    // 采集链 73% 题无挂树链接，仅靠树 stage 筛题必然大面积失效）。运行时 version=15。
    // 文件名序号 0017 走预分配序列（D-076② 为本单预分配）。
    migrations.push({ version: 15, path: join(migrationsDir, '0017_question_stage.sql') });

    const pending = migrations.filter(m => m.version > currentVersion);

    if (pending.length === 0) {
      return;
    }

    // 0044 适配：0013 重建 papers 表（SQLite 改 CHECK 必须整表重建），官方 12 步流程要求
    // 重建期间关闭外键——而 PRAGMA foreign_keys 在事务内是 no-op，故在本层（事务外）对
    // 待执行迁移整体包裹 OFF/ON。既有迁移的事务边界与回滚语义零变化（每迁移一事务不变）；
    // 无待执行迁移时早退、连接外键状态不动。
    db.exec('PRAGMA foreign_keys = OFF;');
    try {
      for (const migration of pending) {
        db.transaction(() => {
          const sql = readFileSync(migration.path, 'utf8');
          db.exec(sql);
          db.setUserVersion(migration.version);
        });
      }
    } finally {
      db.exec('PRAGMA foreign_keys = ON;');
    }
  }
}

/**
 * 工厂函数：打开数据库并执行迁移
 */
export function openDatabase(path: string, migrationsDir: string): Database {
  const db = new Database(path);
  Database.runMigrations(db, migrationsDir);
  return db;
}
