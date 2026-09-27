// 0066 可运维性一期（R-002）：diag.exportDiagnostics 通道 —— dialog 分支 / smoke 分支 / 台账留痕。
//
// 环境：node；electron 全 mock（ipcMain.handle 收进本地 Map，dialog.showSaveDialog 可编程），
// 文件与库走真 fs + 真 SQLite 真迁移（台账断言打在真 operation_log 上）。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const saveDialog = vi.fn();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
  },
  dialog: {
    showSaveDialog: (...args: unknown[]) => saveDialog(...args),
  },
}));

import { Database } from '../../src/bank/db.js';
import { registerDiagIpcHandlers } from '../../src/shell/ipc.js';
import { IPC_CHANNELS } from '../../src/shared/contracts/ipc-channels.js';
import { readZip } from '../../src/guard/zip-utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const realMigrationsDir = join(__dirname, '../../src/bank/migrations');

let root: string;
let userData: string;
let dataDir: string;
let db: Database;
let smokeOut: string;

const invoke = () => handlers.get(IPC_CHANNELS.DIAG_EXPORT_DIAGNOSTICS)!(null) as Promise<Record<string, unknown>>;

function register(smokeOutputPath?: string): void {
  registerDiagIpcHandlers({
    getDb: () => db,
    userDataPath: userData,
    dataDir,
    appVersion: '0.1.0-test',
    electronVersion: '38.8.6-test',
    smokeOutputPath,
  });
}

const exportRows = () =>
  db.prepare("SELECT status, affected_count, metadata_json FROM operation_log WHERE operation_type = 'diag.export'").all() as Array<{
    status: string;
    affected_count: number;
    metadata_json: string;
  }>;

beforeEach(() => {
  handlers.clear();
  saveDialog.mockReset();
  root = mkdtempSync(join(tmpdir(), 'mofang-0066-ipc-'));
  userData = join(root, 'userData');
  dataDir = join(userData, 'data');
  smokeOut = join(root, 'out', 'diag.zip');
  mkdirSync(join(userData, 'logs'), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(root, 'out'), { recursive: true });
  writeFileSync(join(userData, 'logs', 'app.log'), '{"ts":"t","level":"info","module":"diag","message":"启动"}\n', 'utf8');

  db = new Database(join(dataDir, 'bank.db'));
  Database.runMigrations(db, realMigrationsDir);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* 已关闭 */
  }
  rmSync(root, { recursive: true, force: true });
});

describe('0066 diag.exportDiagnostics 通道', () => {
  it('契约字面：通道名 = diag.exportDiagnostics', () => {
    expect(IPC_CHANNELS.DIAG_EXPORT_DIAGNOSTICS).toBe('diag.exportDiagnostics');
  });

  it('dialog 分支：用户选路径 → 写 zip + 返回 {success,path} + 台账 diag.export succeeded', async () => {
    const target = join(root, 'out', 'picked.zip');
    saveDialog.mockResolvedValue({ canceled: false, filePath: target });
    register();

    const result = await invoke();

    expect(result.success).toBe(true);
    expect(result.path).toBe(target);
    expect(existsSync(target)).toBe(true);
    expect(readZip(target).some((e) => e.path === 'manifest.json')).toBe(true);
    expect(saveDialog).toHaveBeenCalledTimes(1);

    const rows = exportRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('succeeded');
    expect((JSON.parse(rows[0].metadata_json) as { path: string }).path).toBe(target);
  });

  it('dialog 分支：取消 → {success:false,canceled:true} 且零台账零产物', async () => {
    saveDialog.mockResolvedValue({ canceled: true, filePath: undefined });
    register();

    const result = await invoke();

    expect(result).toEqual({ success: false, canceled: true });
    expect(exportRows()).toHaveLength(0);
  });

  it('smoke 分支：--smoke-diag 指定输出路径 → 不经 dialog', async () => {
    register(smokeOut);

    const result = await invoke();

    expect(result.success).toBe(true);
    expect(result.path).toBe(smokeOut);
    expect(existsSync(smokeOut)).toBe(true);
    expect(saveDialog).not.toHaveBeenCalled();
    expect(exportRows()[0].status).toBe('succeeded');
  });

  it('组装失败 → {success:false,error} + 台账 failed（不抛）', async () => {
    register(join(root, 'no-such-dir', 'x.zip'));

    const result = await invoke();

    expect(result.success).toBe(false);
    expect(String(result.error).length).toBeGreaterThan(0);
    const rows = exportRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('failed');
  });

  it('台账 metadata 记 affected_count=包内文件数（可追溯导出规模）', async () => {
    register(smokeOut);
    await invoke();

    const rows = exportRows();
    expect(rows[0].affected_count).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(rows[0].metadata_json) as Record<string, unknown>).toHaveProperty('entries');
  });
});
