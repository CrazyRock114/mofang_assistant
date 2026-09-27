// 0071 自定义数据保存位置（R-043）：引导配置读写 + 启动解析（默认/配置/portable）+ 目标校验
// + pending 迁移全流程（备份→复制→校验→翻转）。
//
// 环境：node；文件走真 fs（临时目录），仅迁移的「备份产出」与「复制实现」两处注入——
// 用于逼出失败分支（备份失败/复制失败/半成品重试），复制注入的默认值即生产实现（guard/fs-utils.copyTree）。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Database } from '../../src/bank/db.js';
import { copyTree } from '../../src/guard/fs-utils.js';
import {
  DATA_LOCATION_CONFIG_FILE,
  MIGRATION_MARKER,
  cancelDataLocationChange,
  changeDataLocation,
  describeDataLocation,
  readDataLocationConfig,
  resolveBootstrapPlan,
  runPendingMigration,
  validateTargetDir,
  writeDataLocationConfig,
} from '../../src/shell/data-location.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const realMigrationsDir = join(__dirname, '../../src/bank/migrations');

let root: string;

/** 本机是否允许创建符号链接（Windows 需开发者模式/管理员；不允许则该用例跳过——口径由探针 junction 段兜底） */
const symlinkCapable = (() => {
  const probeDir = mkdtempSync(join(tmpdir(), 'mofang-0071-symlink-'));
  try {
    writeFileSync(join(probeDir, 't.txt'), 'x', 'utf8');
    symlinkSync(join(probeDir, 't.txt'), join(probeDir, 'l.txt'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
})();

/** 造一份「已装过用户」的 userData 树：data/bank.db（真迁移真 schema）+ assets + 一份日志 */
function seedUserData(userData: string, questionIds: string[]): string {
  const dataDir = join(userData, 'data');
  mkdirSync(join(dataDir, 'assets', 'capture'), { recursive: true });
  mkdirSync(join(userData, 'logs'), { recursive: true });
  const dbPath = join(dataDir, 'bank.db');
  const db = new Database(dbPath);
  Database.runMigrations(db, realMigrationsDir);
  const now = new Date().toISOString();
  for (const id of questionIds) {
    db.prepare(
      `INSERT INTO questions (id, subject, source_type, source_detail, content, images, created_at, updated_at, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, '数学', 'local', JSON.stringify({ origin: 'probe' }), '<div class="question">1+1=?</div>', '[]', now, now, 0);
  }
  db.close();
  writeFileSync(join(dataDir, 'assets', 'capture', 'figure.png'), Buffer.from('PNG-PROBE-BYTES'), 'utf8');
  writeFileSync(join(userData, 'logs', 'app.log'), '{"ts":"seed","level":"info"}\n', 'utf8');
  return dbPath;
}

const questionCountOf = (dbPath: string): number => {
  const db = new Database(dbPath);
  const row = db.prepare('SELECT COUNT(*) AS c FROM questions').get() as { c: number };
  db.close();
  return row.c;
};

/** 迁移成功链的注入层：真复制 + 合成「迁移前备份 zip」（不涉 SQLite，避免测试把备份实现本身再测一遍） */
const okDeps = () => ({
  copyTree,
  createPreMigrationBackup: ({ outputPath }: { dataDir: string; outputPath: string }) => {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, 'BACKUP-ZIP-PROBE', 'utf8');
  },
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mofang-0071-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('0071 引导配置读写', () => {
  it('缺文件 → 空配置且无错（首装/未设置过场景）', async () => {
    const read = readDataLocationConfig(join(root, 'nope', DATA_LOCATION_CONFIG_FILE));
    expect(read.config).toEqual({});
    expect(read.error).toBeNull();
  });

  it('坏 JSON → 空配置 + error（不抛：坏配置不许炸启动）', async () => {
    const configPath = join(root, 'data-location.json');
    writeFileSync(configPath, '{ 这不是 JSON', 'utf8');
    const read = readDataLocationConfig(configPath);
    expect(read.config).toEqual({});
    expect(read.error).toBeTruthy();
  });

  it('形态非法（数组 / 非字符串值 / 空串）→ 空配置 + error', async () => {
    const configPath = join(root, 'data-location.json');
    writeFileSync(configPath, '["D:/x"]', 'utf8');
    expect(readDataLocationConfig(configPath).error).toBeTruthy();
    writeFileSync(configPath, JSON.stringify({ dataRoot: 42 }), 'utf8');
    expect(readDataLocationConfig(configPath).error).toBeTruthy();
    writeFileSync(configPath, JSON.stringify({ dataRoot: '   ' }), 'utf8');
    expect(readDataLocationConfig(configPath).error).toBeTruthy();
  });

  it('写读往返：目录不存在自动建；临时文件不残留（写临时 + rename）', async () => {
    const configPath = join(root, 'appdata', 'mofang-assistant', DATA_LOCATION_CONFIG_FILE);
    writeDataLocationConfig(configPath, { dataRoot: 'D:\\mofang-data', pendingDataRoot: 'D:\\mofang-data2' });
    const read = readDataLocationConfig(configPath);
    expect(read.error).toBeNull();
    expect(read.config).toEqual({ dataRoot: 'D:\\mofang-data', pendingDataRoot: 'D:\\mofang-data2' });

    // 原子写：目录下只剩正式文件（无临时文件残留）
    expect(readdirSync(dirname(configPath))).toEqual([DATA_LOCATION_CONFIG_FILE]);
    expect(readFileSync(configPath, 'utf8')).toContain('mofang-data');
  });

  it('省略字段 = 删除字段（取消 pending 的写口径）', async () => {
    const configPath = join(root, 'data-location.json');
    writeDataLocationConfig(configPath, { dataRoot: 'D:\\a', pendingDataRoot: 'D:\\b' });
    writeDataLocationConfig(configPath, { dataRoot: 'D:\\a' });
    expect(readDataLocationConfig(configPath).config.pendingDataRoot).toBeUndefined();
  });
});

describe('0071 启动解析（default / config / portable）', () => {
  it('无配置 → 系统默认位置', async () => {
    const plan = resolveBootstrapPlan({
      configPath: join(root, 'cfg', DATA_LOCATION_CONFIG_FILE),
      defaultUserDataPath: join(root, 'sys-default'),
    });
    expect(plan.source).toBe('default');
    expect(plan.userDataPath).toBe(join(root, 'sys-default'));
    expect(plan.pendingDataRoot).toBeNull();
  });

  it('有配置且目录存在 → 配置位置（source=config）', async () => {
    const target = join(root, 'D-drive', 'mofang-data');
    mkdirSync(target, { recursive: true });
    const configPath = join(root, 'cfg', DATA_LOCATION_CONFIG_FILE);
    writeDataLocationConfig(configPath, { dataRoot: target });
    const plan = resolveBootstrapPlan({ configPath, defaultUserDataPath: join(root, 'sys-default') });
    expect(plan.source).toBe('config');
    expect(plan.userDataPath).toBe(target);
  });

  it('有配置但目录不存在 → 创建后照样用它（首次指向 = 全新空库正常初始化）', async () => {
    const target = join(root, 'D-drive', 'brand-new');
    const configPath = join(root, 'cfg', DATA_LOCATION_CONFIG_FILE);
    writeDataLocationConfig(configPath, { dataRoot: target });
    const plan = resolveBootstrapPlan({ configPath, defaultUserDataPath: join(root, 'sys-default') });
    expect(plan.source).toBe('config');
    expect(existsSync(target)).toBe(true);
  });

  it('坏配置 → 回退默认 + warning（不炸启动）', async () => {
    const configPath = join(root, 'cfg', DATA_LOCATION_CONFIG_FILE);
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, 'not-json-at-all', 'utf8');
    const plan = resolveBootstrapPlan({ configPath, defaultUserDataPath: join(root, 'sys-default') });
    expect(plan.source).toBe('default');
    expect(plan.warnings.join(' ')).toContain('配置');
  });

  it('dataRoot 非绝对路径 → 回退默认 + warning', async () => {
    const configPath = join(root, 'cfg', DATA_LOCATION_CONFIG_FILE);
    writeDataLocationConfig(configPath, { dataRoot: 'relative/data' });
    const plan = resolveBootstrapPlan({ configPath, defaultUserDataPath: join(root, 'sys-default') });
    expect(plan.source).toBe('default');
    expect(plan.warnings.length).toBeGreaterThan(0);
  });

  it('dataRoot 路径失效（父级是文件，建不出目录）→ 回退默认 + warning', async () => {
    const blocker = join(root, 'blocker');
    writeFileSync(blocker, 'i-am-a-file', 'utf8');
    const configPath = join(root, 'cfg', DATA_LOCATION_CONFIG_FILE);
    writeDataLocationConfig(configPath, { dataRoot: join(blocker, 'nested', 'mofang-data') });
    const plan = resolveBootstrapPlan({ configPath, defaultUserDataPath: join(root, 'sys-default') });
    expect(plan.source).toBe('default');
    expect(plan.warnings.join(' ')).toContain('回退');
  });

  it('portable：无配置 + PORTABLE_EXECUTABLE_DIR → 落 exe 旁 mofang-data', async () => {
    const portableDir = join(root, 'usb', 'app');
    mkdirSync(portableDir, { recursive: true });
    const plan = resolveBootstrapPlan({
      configPath: join(root, 'cfg', DATA_LOCATION_CONFIG_FILE),
      defaultUserDataPath: join(root, 'sys-default'),
      portableDir,
    });
    expect(plan.source).toBe('portable');
    expect(plan.userDataPath).toBe(join(portableDir, 'mofang-data'));
  });

  it('portable：exe 目录不可写（只读介质/Program Files）→ 回退默认 + warning', async () => {
    const blocker = join(root, 'readonly-exe');
    writeFileSync(blocker, 'i-am-a-file', 'utf8');
    const plan = resolveBootstrapPlan({
      configPath: join(root, 'cfg', DATA_LOCATION_CONFIG_FILE),
      defaultUserDataPath: join(root, 'sys-default'),
      portableDir: blocker,
    });
    expect(plan.source).toBe('default');
    expect(plan.warnings.join(' ')).toContain('便携');
  });

  it('引导配置优先于 portable 默认', async () => {
    const target = join(root, 'D-drive', 'mofang-data');
    const configPath = join(root, 'cfg', DATA_LOCATION_CONFIG_FILE);
    writeDataLocationConfig(configPath, { dataRoot: target });
    const plan = resolveBootstrapPlan({
      configPath,
      defaultUserDataPath: join(root, 'sys-default'),
      portableDir: join(root, 'usb'),
    });
    expect(plan.source).toBe('config');
    expect(plan.userDataPath).toBe(target);
  });

  it('pending 透出（本次启动待迁移目标）', async () => {
    const configPath = join(root, 'cfg', DATA_LOCATION_CONFIG_FILE);
    writeDataLocationConfig(configPath, { dataRoot: join(root, 'current'), pendingDataRoot: join(root, 'next') });
    const plan = resolveBootstrapPlan({ configPath, defaultUserDataPath: join(root, 'sys-default') });
    expect(plan.pendingDataRoot).toBe(join(root, 'next'));
  });

  it('pending == 生效位置 → 视为已完成：清 pending + warning（防自我迁移）', async () => {
    const current = join(root, 'current');
    const configPath = join(root, 'cfg', DATA_LOCATION_CONFIG_FILE);
    writeDataLocationConfig(configPath, { dataRoot: current, pendingDataRoot: current });
    const plan = resolveBootstrapPlan({ configPath, defaultUserDataPath: join(root, 'sys-default') });
    expect(plan.pendingDataRoot).toBeNull();
    expect(readDataLocationConfig(configPath).config.pendingDataRoot).toBeUndefined();
    expect(plan.warnings.length).toBeGreaterThan(0);
  });
});

describe('0071 目标目录校验', () => {
  const current = 'D:\\mofang-data';

  it('不存在 / 空目录 → 通过', async () => {
    const empty = join(root, 'empty');
    mkdirSync(empty, { recursive: true });
    expect(validateTargetDir(join(root, 'not-exists'), current)).toEqual({ ok: true });
    expect(validateTargetDir(empty, current)).toEqual({ ok: true });
  });

  it('非空目录 → 拒绝（文案说明原因）', async () => {
    const busy = join(root, 'busy');
    mkdirSync(busy, { recursive: true });
    writeFileSync(join(busy, 'user-file.txt'), 'x', 'utf8');
    const verdict = validateTargetDir(busy, current);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.error).toContain('非空');
  });

  it('相对路径 / 空串 → 拒绝', async () => {
    expect(validateTargetDir('relative/path', current).ok).toBe(false);
    expect(validateTargetDir('   ', current).ok).toBe(false);
  });

  it('与当前位置相同 → 拒绝', async () => {
    const verdict = validateTargetDir('D:\\mofang-data', current);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.error).toContain('当前');
  });

  it('在当前数据目录之内（含子目录）→ 拒绝（递归复制隐患）', async () => {
    expect(validateTargetDir('D:\\mofang-data\\inner', current).ok).toBe(false);
    expect(validateTargetDir(join(root, 'cur', 'inner'), join(root, 'cur')).ok).toBe(false);
  });

  it('当前数据目录在其之内（把数据根搬进自己的父级）→ 拒绝', async () => {
    expect(validateTargetDir(root, join(root, 'cur', 'data')).ok).toBe(false);
  });
});

describe('0071 pending 迁移（备份 → 复制 → 校验 → 翻转）', () => {
  it('成功链：文件齐 + 配置翻转（dataRoot=新 / 无 pending）+ 标记清除 + 备份 zip 落旧位置', async () => {
    const from = join(root, 'old-userdata');
    seedUserData(from, ['q1', 'q2', 'q3']);
    const to = join(root, 'D-drive', 'mofang-data');
    const configPath = join(root, 'cfg', DATA_LOCATION_CONFIG_FILE);
    // 前置：上一轮失败留痕，成功后必须一起清掉
    writeDataLocationConfig(configPath, {
      pendingDataRoot: to,
      lastMigrationError: { at: '2026-01-01T00:00:00.000Z', message: '上一轮失败' },
    });

    const result = await runPendingMigration({ configPath, fromUserData: from, toRoot: to }, okDeps());
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();

    // 数据落新位置（库可开 + 题目数一致）
    expect(questionCountOf(join(to, 'data', 'bank.db'))).toBe(3);
    expect(readFileSync(join(to, 'data', 'assets', 'capture', 'figure.png'), 'utf8')).toBe('PNG-PROBE-BYTES');
    expect(existsSync(join(to, 'logs', 'app.log'))).toBe(true);
    // 迁移标记已摘 + 配置翻转（失败留痕一并清）
    expect(existsSync(join(to, MIGRATION_MARKER))).toBe(false);
    expect(readDataLocationConfig(configPath).config).toEqual({ dataRoot: to });
    // 备份 zip 落旧位置（防迁移事故）
    const backups = readdirSync(join(from, 'backups'));
    expect(backups.length).toBe(1);
    expect(backups[0].startsWith('mofang-migrate-')).toBe(true);
    expect(backups[0].endsWith('.mofang-backup.zip')).toBe(true);
    // 旧目录保留不删（用户自删）
    expect(existsSync(join(from, 'data', 'bank.db'))).toBe(true);
  });

  it('源目录含顶层普通文件（真实 userData 必有 Preferences / Local State / DevToolsActivePort 之类）→ 迁移成功', async () => {
    // 回归（2026-09-24 用户真机打回）：初版按「每个顶层条目都是目录」逐项递归，
    // 撞上顶层文件即 ENOTDIR（readdir 非目录）→ 迁移失败。真实用户目录 ≠ smoke 造的空目录。
    const from = join(root, 'old-userdata');
    seedUserData(from, ['q1']);
    writeFileSync(join(from, 'Preferences'), '{"profile":{}}', 'utf8');
    writeFileSync(join(from, 'DevToolsActivePort'), 'DEVTOOLS-PORT-STALE-FILE', 'utf8');
    const to = join(root, 'new-root');
    const configPath = join(root, 'cfg', DATA_LOCATION_CONFIG_FILE);
    writeDataLocationConfig(configPath, { pendingDataRoot: to });

    const result = await runPendingMigration({ configPath, fromUserData: from, toRoot: to }, okDeps());
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    // 普通文件随之搬家（内容保真）
    expect(readFileSync(join(to, 'Preferences'), 'utf8')).toBe('{"profile":{}}');
    // 运行期易变条目 （端口/单例锁）不随迁移——写死一个过期端口只会误导下一次启动
    expect(existsSync(join(to, 'DevToolsActivePort'))).toBe(false);
    expect((result.skipped ?? []).join(' ')).toContain('DevToolsActivePort');
    expect(readDataLocationConfig(configPath).config).toEqual({ dataRoot: to });
  });

  it('备份排除：backups/ 与引导配置本体不随迁移复制（旧位置留档，不重复占空间）', async () => {
    const from = join(root, 'old-userdata');
    seedUserData(from, ['q1']);
    // 引导配置本体就落在默认 userData 内（<appData>/mofang-assistant/）
    const configPath = join(from, DATA_LOCATION_CONFIG_FILE);
    writeDataLocationConfig(configPath, { pendingDataRoot: join(root, 'new-root') });
    mkdirSync(join(from, 'backups'), { recursive: true });
    writeFileSync(join(from, 'backups', 'old-backup.zip'), 'OLD-BACKUP', 'utf8');

    const result = await runPendingMigration({ configPath, fromUserData: from, toRoot: join(root, 'new-root') }, okDeps());
    expect(result.ok).toBe(true);
    expect(existsSync(join(root, 'new-root', 'backups'))).toBe(false);
    expect(existsSync(join(root, 'new-root', DATA_LOCATION_CONFIG_FILE))).toBe(false);
    expect(existsSync(join(root, 'new-root', 'data', 'bank.db'))).toBe(true);
  });

  it('复制清单为准：复制后源目录再变化，不再误判为校验失败', async () => {
    const from = join(root, 'old-userdata');
    seedUserData(from, ['q1']);
    const to = join(root, 'new-root');
    const configPath = join(root, 'cfg', DATA_LOCATION_CONFIG_FILE);
    writeDataLocationConfig(configPath, { pendingDataRoot: to });

    const result = await runPendingMigration(
      { configPath, fromUserData: from, toRoot: to },
      {
        // 复制完再改源文件（真实场景：运行中的 Chromium 还在写日志/缓存）——
        // 校验以「复制时记录的清单」为准，源目录事后变化不得让迁移失败
        copyTree: (src, dest, options) => {
          const report = copyTree(src, dest, options);
          writeFileSync(join(src, 'logs', 'app.log'), 'CHANGED-AFTER-COPY', 'utf8');
          return report;
        },
        createPreMigrationBackup: okDeps().createPreMigrationBackup,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(readDataLocationConfig(configPath).config).toEqual({ dataRoot: to });
  });

  it.skipIf(!symlinkCapable)('符号链接：指向文件→按内容复制；指向目录/悬空→跳过并记录（不中断迁移）', async () => {
    const from = join(root, 'old-userdata');
    seedUserData(from, ['q1']);
    writeFileSync(join(from, 'data', 'link-source.txt'), 'LINK-TARGET-CONTENT', 'utf8');
    symlinkSync(join(from, 'data', 'link-source.txt'), join(from, 'link-to-file.txt'), 'file');
    symlinkSync(join(from, 'logs'), join(from, 'link-to-dir'), 'dir');
    symlinkSync(join(from, 'nope-does-not-exist'), join(from, 'link-dangling'), 'file');

    const to = join(root, 'new-root');
    const configPath = join(root, 'cfg', DATA_LOCATION_CONFIG_FILE);
    writeDataLocationConfig(configPath, { pendingDataRoot: to });

    const result = await runPendingMigration({ configPath, fromUserData: from, toRoot: to }, okDeps());
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    // 指向文件的链接：内容随行
    expect(readFileSync(join(to, 'link-to-file.txt'), 'utf8')).toBe('LINK-TARGET-CONTENT');
    // 指向目录/悬空的链接：不复制（避免递归环与无意义会话链接），且跳过项可查
    expect(existsSync(join(to, 'link-to-dir'))).toBe(false);
    expect(existsSync(join(to, 'link-dangling'))).toBe(false);
    const skipped = (result.skipped ?? []).join(' ');
    expect(skipped).toContain('link-to-dir');
    expect(skipped).toContain('link-dangling');
  });

  it('备份目录由流程保证存在（备份实现只管写文件，不负责建目录）', async () => {
    const from = join(root, 'old-userdata');
    seedUserData(from, ['q1']);
    const to = join(root, 'new-root');
    const configPath = join(root, 'cfg', DATA_LOCATION_CONFIG_FILE);
    writeDataLocationConfig(configPath, { pendingDataRoot: to });
    expect(existsSync(join(from, 'backups'))).toBe(false);

    const result = await runPendingMigration(
      { configPath, fromUserData: from, toRoot: to },
      {
        copyTree,
        createPreMigrationBackup: ({ outputPath }) => writeFileSync(outputPath, 'BACKUP-ZIP-PROBE', 'utf8'),
      },
    );
    expect(result.ok).toBe(true);
    expect(existsSync(join(from, 'backups'))).toBe(true);
    expect(result.backupPath !== undefined && existsSync(result.backupPath)).toBe(true);
  });

  it('备份失败 → 中止：配置不动、pending 保留、失败原因落档', async () => {
    const from = join(root, 'old-userdata');
    seedUserData(from, ['q1']);
    const to = join(root, 'new-root');
    const configPath = join(root, 'cfg', DATA_LOCATION_CONFIG_FILE);
    writeDataLocationConfig(configPath, { pendingDataRoot: to });

    const result = await runPendingMigration(
      { configPath, fromUserData: from, toRoot: to },
      { copyTree, createPreMigrationBackup: () => { throw new Error('磁盘已满'); } },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('磁盘已满');
    expect(readDataLocationConfig(configPath).config.pendingDataRoot).toBe(to);
    expect(readDataLocationConfig(configPath).config.dataRoot).toBeUndefined();
    // 失败原因落档（设置页可见），且不覆盖正式/待迁移字段
    expect(readDataLocationConfig(configPath).config.lastMigrationError?.message).toContain('磁盘已满');
    expect(existsSync(join(from, 'data', 'bank.db'))).toBe(true);
  });

  it('复制失败 → 中止：配置不动，半成品下次可重来（标记在）', async () => {
    const from = join(root, 'old-userdata');
    seedUserData(from, ['q1']);
    const to = join(root, 'new-root');
    const configPath = join(root, 'cfg', DATA_LOCATION_CONFIG_FILE);
    writeDataLocationConfig(configPath, { pendingDataRoot: to });

    const result = await runPendingMigration(
      { configPath, fromUserData: from, toRoot: to },
      {
        copyTree: () => { throw new Error('文件被占用'); },
        createPreMigrationBackup: okDeps().createPreMigrationBackup,
      },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('文件被占用');
    expect(readDataLocationConfig(configPath).config.pendingDataRoot).toBe(to);
    expect(existsSync(join(to, MIGRATION_MARKER))).toBe(true);
  });

  it('校验不过（文件少了一份）→ 配置不动（宁可不迁，不留半份数据）', async () => {
    const from = join(root, 'old-userdata');
    seedUserData(from, ['q1']);
    const to = join(root, 'new-root');
    const configPath = join(root, 'cfg', DATA_LOCATION_CONFIG_FILE);
    writeDataLocationConfig(configPath, { pendingDataRoot: to });

    const result = await runPendingMigration(
      { configPath, fromUserData: from, toRoot: to },
      {
        // 复制后抽掉一份资产（模拟搬丢）——逐文件字节比对必须抓住
        copyTree: (src, dest, options) => {
          const report = copyTree(src, dest, options);
          const stolen = join(dest, 'data', 'assets', 'capture', 'figure.png');
          if (existsSync(stolen)) rmSync(stolen, { force: true });
          return report;
        },
        createPreMigrationBackup: okDeps().createPreMigrationBackup,
      },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('校验');
    expect(readDataLocationConfig(configPath).config.pendingDataRoot).toBe(to);
    expect(readDataLocationConfig(configPath).config.dataRoot).toBeUndefined();
  });

  it('校验不过（库行数不符）→ 配置不动', async () => {
    const from = join(root, 'old-userdata');
    seedUserData(from, ['q1', 'q2']);
    const to = join(root, 'new-root');
    const configPath = join(root, 'cfg', DATA_LOCATION_CONFIG_FILE);
    writeDataLocationConfig(configPath, { pendingDataRoot: to });

    const result = await runPendingMigration(
      { configPath, fromUserData: from, toRoot: to },
      {
        // 复制完偷偷删掉目标库里的一题（模拟半途损坏）——bank.db 快速校验须咬合
        copyTree: (src, dest, options) => {
          const report = copyTree(src, dest, options);
          for (const candidate of [join(dest, 'bank.db'), join(dest, 'data', 'bank.db')]) {
            if (!existsSync(candidate)) continue;
            const db = new Database(candidate);
            db.prepare('DELETE FROM questions WHERE id = ?').run('q2');
            db.close();
          }
          return report;
        },
        createPreMigrationBackup: okDeps().createPreMigrationBackup,
      },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('校验');
  });

  it('目标非空且无迁移标记 → 拒绝并保留用户内容（绝不先删后迁）', async () => {
    const from = join(root, 'old-userdata');
    seedUserData(from, ['q1']);
    const to = join(root, 'occupied');
    mkdirSync(to, { recursive: true });
    writeFileSync(join(to, 'user-document.txt'), 'DO-NOT-DELETE', 'utf8');
    const configPath = join(root, 'cfg', DATA_LOCATION_CONFIG_FILE);
    writeDataLocationConfig(configPath, { pendingDataRoot: to });

    const result = await runPendingMigration({ configPath, fromUserData: from, toRoot: to }, okDeps());
    expect(result.ok).toBe(false);
    expect(readFileSync(join(to, 'user-document.txt'), 'utf8')).toBe('DO-NOT-DELETE');
    expect(readDataLocationConfig(configPath).config.pendingDataRoot).toBe(to);
  });

  it('迁移中断（有标记的半成品）→ 下次启动清空重来，幂等收敛', async () => {
    const from = join(root, 'old-userdata');
    seedUserData(from, ['q1', 'q2']);
    const to = join(root, 'new-root');
    const configPath = join(root, 'cfg', DATA_LOCATION_CONFIG_FILE);
    writeDataLocationConfig(configPath, { pendingDataRoot: to });

    // 半成品现场：标记在 + 上次没搬完的残片
    mkdirSync(to, { recursive: true });
    writeFileSync(join(to, MIGRATION_MARKER), '{"startedAt":"2026-01-01"}', 'utf8');
    writeFileSync(join(to, 'half-copied.bin'), 'PARTIAL', 'utf8');

    const result = await runPendingMigration({ configPath, fromUserData: from, toRoot: to }, okDeps());
    expect(result.ok).toBe(true);
    expect(existsSync(join(to, 'half-copied.bin'))).toBe(false);
    expect(questionCountOf(join(to, 'data', 'bank.db'))).toBe(2);
    expect(readDataLocationConfig(configPath).config).toEqual({ dataRoot: to });
  });

  it('完成后再次触发 = 无操作（目标已是迁移产物，标记已摘 → 拒绝而非重搬）', async () => {
    const from = join(root, 'old-userdata');
    seedUserData(from, ['q1']);
    const to = join(root, 'new-root');
    const configPath = join(root, 'cfg', DATA_LOCATION_CONFIG_FILE);
    writeDataLocationConfig(configPath, { pendingDataRoot: to });
    const first = await runPendingMigration({ configPath, fromUserData: from, toRoot: to }, okDeps());
    const second = await runPendingMigration({ configPath, fromUserData: from, toRoot: to }, okDeps());
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(questionCountOf(join(to, 'data', 'bank.db'))).toBe(1);
    const after = readDataLocationConfig(configPath).config;
    expect(after.dataRoot).toBe(to);
    expect(after.pendingDataRoot).toBeUndefined();
  });
});

describe('0071 设置页通道逻辑（get / change / cancel）', () => {
  const runtimeOf = (configPath: string, userDataPath: string) => ({
    configPath,
    userDataPath,
    source: 'config' as const,
    portable: false,
  });

  it('get：读配置（pending 动态）+ 生效位置与来源 + 失败留痕面', async () => {
    const configPath = join(root, 'cfg', DATA_LOCATION_CONFIG_FILE);
    writeDataLocationConfig(configPath, { dataRoot: 'D:\\mofang-data' });
    expect(describeDataLocation(runtimeOf(configPath, 'D:\\mofang-data'))).toEqual({
      userDataPath: 'D:\\mofang-data',
      source: 'config',
      dataRoot: 'D:\\mofang-data',
      pendingDataRoot: null,
      lastMigrationError: null,
      portable: false,
    });

    writeDataLocationConfig(configPath, { dataRoot: 'D:\\mofang-data', pendingDataRoot: 'E:\\mofang-data' });
    expect(describeDataLocation(runtimeOf(configPath, 'D:\\mofang-data')).pendingDataRoot).toBe('E:\\mofang-data');

    writeDataLocationConfig(configPath, {
      dataRoot: 'D:\\mofang-data',
      pendingDataRoot: 'E:\\mofang-data',
      lastMigrationError: { at: '2026-01-01T00:00:00.000Z', message: '目标目录已有内容' },
    });
    expect(describeDataLocation(runtimeOf(configPath, 'D:\\mofang-data')).lastMigrationError).toBe('目标目录已有内容');
  });

  it('change：合法目标 → 写 pending（保留 dataRoot）', async () => {
    const current = join(root, 'cur');
    seedUserData(current, ['q1']);
    const configPath = join(root, 'cfg', DATA_LOCATION_CONFIG_FILE);
    writeDataLocationConfig(configPath, { dataRoot: current });
    const target = join(root, 'D-drive', 'mofang-data');

    const result = changeDataLocation(runtimeOf(configPath, current), target);
    expect(result.success).toBe(true);
    expect(result.pendingDataRoot).toBe(target);
    expect(readDataLocationConfig(configPath).config).toEqual({ dataRoot: current, pendingDataRoot: target });
  });

  it('change：首次设置（此前无配置）→ 只写 pending，正式位置不动', async () => {
    const current = join(root, 'cur');
    seedUserData(current, ['q1']);
    const configPath = join(root, 'cfg', DATA_LOCATION_CONFIG_FILE);
    const target = join(root, 'D-drive', 'mofang-data');

    const result = changeDataLocation(runtimeOf(configPath, current), target);
    expect(result.success).toBe(true);
    expect(readDataLocationConfig(configPath).config).toEqual({ pendingDataRoot: target });
  });

  it('change：非法目标 → 拒（错误文案）+ 配置零改动', async () => {
    const current = join(root, 'cur');
    seedUserData(current, ['q1']);
    const configPath = join(root, 'cfg', DATA_LOCATION_CONFIG_FILE);
    writeDataLocationConfig(configPath, { dataRoot: current });

    const busy = join(root, 'busy');
    mkdirSync(busy, { recursive: true });
    writeFileSync(join(busy, 'x.txt'), 'x', 'utf8');
    const result = changeDataLocation(runtimeOf(configPath, current), busy);
    expect(result.success).toBe(false);
    expect(result.error).toContain('非空');
    expect(readDataLocationConfig(configPath).config).toEqual({ dataRoot: current });
  });

  it('cancel：清 pending、保留正式位置', async () => {
    const configPath = join(root, 'cfg', DATA_LOCATION_CONFIG_FILE);
    writeDataLocationConfig(configPath, { dataRoot: 'D:\\mofang-data', pendingDataRoot: 'E:\\mofang-data' });
    const result = cancelDataLocationChange(runtimeOf(configPath, 'D:\\mofang-data'));
    expect(result.success).toBe(true);
    expect(readDataLocationConfig(configPath).config).toEqual({ dataRoot: 'D:\\mofang-data' });
  });
});
