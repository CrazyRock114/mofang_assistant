// 0071 自定义数据保存位置（R-043）：dataLocation.* 通道接线 ——
// get 透出启动态 / change 弹框分支与直给分支 / 校验拒绝 / 取消 / cancel 撤销。
//
// 环境：node；electron 全 mock（ipcMain.handle 收进本地 Map，dialog.showOpenDialog 可编程），
// 文件与配置走真 fs（临时目录）。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const openDialog = vi.fn();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
  },
  dialog: {
    showOpenDialog: (...args: unknown[]) => openDialog(...args),
  },
}));

import { registerDataLocationIpcHandlers } from '../../src/shell/ipc.js';
import { IPC_CHANNELS } from '../../src/shared/contracts/ipc-channels.js';
import { readDataLocationConfig, writeDataLocationConfig } from '../../src/shell/data-location.js';

let root: string;
let current: string;
let configPath: string;

const invokeGet = () => handlers.get(IPC_CHANNELS.DATA_LOCATION_GET)!(null) as Promise<Record<string, unknown>>;
const invokeChange = (payload?: unknown) =>
  handlers.get(IPC_CHANNELS.DATA_LOCATION_CHANGE)!(null, payload) as Promise<Record<string, unknown>>;
const invokeCancel = () => handlers.get(IPC_CHANNELS.DATA_LOCATION_CANCEL)!(null) as Promise<Record<string, unknown>>;

function register(overrides: { source?: 'config' | 'portable' | 'default'; portable?: boolean } = {}): void {
  registerDataLocationIpcHandlers({
    configPath,
    userDataPath: current,
    source: overrides.source ?? 'default',
    portable: overrides.portable ?? false,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mofang-0071-ipc-'));
  current = join(root, 'current-userdata');
  mkdirSync(join(current, 'data'), { recursive: true });
  configPath = join(root, 'appdata', 'mofang-assistant', 'data-location.json');
  handlers.clear();
  openDialog.mockReset();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('0071 dataLocation.* 通道', () => {
  it('get：透出启动态（生效位置/来源/portable）+ 配置态（无配置 = 全 null）', async () => {
    register({ source: 'config' });
    const info = await invokeGet();
    expect(info).toEqual({
      userDataPath: current,
      source: 'config',
      dataRoot: null,
      pendingDataRoot: null,
      lastMigrationError: null,
      portable: false,
    });
  });

  it('get：读的是实时配置（pending / 失败留痕随文件走）', async () => {
    register();
    writeDataLocationConfig(configPath, {
      dataRoot: 'D:\\mofang-data',
      pendingDataRoot: 'E:\\mofang-data',
      lastMigrationError: { at: '2026-01-01T00:00:00.000Z', message: '目标目录已有内容' },
    });
    const info = await invokeGet();
    expect(info.dataRoot).toBe('D:\\mofang-data');
    expect(info.pendingDataRoot).toBe('E:\\mofang-data');
    expect(info.lastMigrationError).toBe('目标目录已有内容');
  });

  it('change（直给 targetDir）：校验通过 → 写 pending、正式位置不动、返回目标', async () => {
    register();
    const target = join(root, 'D-drive', 'mofang-data');
    const result = await invokeChange({ targetDir: target });
    expect(result.success).toBe(true);
    expect(result.pendingDataRoot).toBe(target);
    expect(readDataLocationConfig(configPath).config).toEqual({ pendingDataRoot: target });
    // 直给路径时不弹框
    expect(openDialog).not.toHaveBeenCalled();
  });

  it('change（弹框分支）：取消 → {canceled:true} 且不写配置', async () => {
    register();
    openDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    const result = await invokeChange();
    expect(result).toEqual({ success: false, canceled: true });
    expect(openDialog).toHaveBeenCalledTimes(1);
    expect(readDataLocationConfig(configPath).config).toEqual({});
  });

  it('change（弹框分支）：选中目录 → 写 pending', async () => {
    register();
    const target = join(root, 'picked', 'mofang-data');
    openDialog.mockResolvedValue({ canceled: false, filePaths: [target] });
    const result = await invokeChange();
    expect(result.success).toBe(true);
    expect(readDataLocationConfig(configPath).config.pendingDataRoot).toBe(target);
  });

  it('change：空串 targetDir → 拒（不弹框、不写配置）', async () => {
    register();
    const result = await invokeChange({ targetDir: '   ' });
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('不能为空');
    expect(openDialog).not.toHaveBeenCalled();
    expect(readDataLocationConfig(configPath).config).toEqual({});
  });

  it('change：非空目标 / 与当前位置相同 → 拒绝且配置零改动（错误文案回渲染层）', async () => {
    register();
    const busy = join(root, 'busy');
    mkdirSync(busy, { recursive: true });
    writeFileSync(join(busy, 'user-file.txt'), 'x', 'utf8');

    const rejectedBusy = await invokeChange({ targetDir: busy });
    expect(rejectedBusy.success).toBe(false);
    expect(String(rejectedBusy.error)).toContain('非空');

    const rejectedSame = await invokeChange({ targetDir: current });
    expect(rejectedSame.success).toBe(false);
    expect(String(rejectedSame.error)).toContain('当前');

    expect(readDataLocationConfig(configPath).config).toEqual({});
  });

  it('cancel：清 pending、保留正式位置；再次 get 反映新状态', async () => {
    register({ source: 'config' });
    writeDataLocationConfig(configPath, { dataRoot: 'D:\\mofang-data', pendingDataRoot: 'E:\\mofang-data' });
    const result = await invokeCancel();
    expect(result.success).toBe(true);
    expect(readDataLocationConfig(configPath).config).toEqual({ dataRoot: 'D:\\mofang-data' });
    expect((await invokeGet()).pendingDataRoot).toBeNull();
  });

  it('portable 透出（便携版运行标记）', async () => {
    register({ source: 'portable', portable: true });
    const info = await invokeGet();
    expect(info.source).toBe('portable');
    expect(info.portable).toBe(true);
  });

  it('配置写入失败（父路径被文件占位）→ change 返回错误而不是抛（渲染层可见）', async () => {
    const blocker = join(root, 'blocked');
    writeFileSync(blocker, 'i-am-a-file', 'utf8');
    registerDataLocationIpcHandlers({
      configPath: join(blocker, 'nested', 'data-location.json'),
      userDataPath: current,
      source: 'default',
      portable: false,
    });
    const result = await invokeChange({ targetDir: join(root, 'D-drive', 'mofang-data') });
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('写入引导配置失败');
    expect(existsSync(join(blocker, 'nested'))).toBe(false);
  });

  it('通道注册齐三件（get/change/cancel 均挂在 IPC_CHANNELS 常量上）', () => {
    register();
    expect(handlers.has(IPC_CHANNELS.DATA_LOCATION_GET)).toBe(true);
    expect(handlers.has(IPC_CHANNELS.DATA_LOCATION_CHANGE)).toBe(true);
    expect(handlers.has(IPC_CHANNELS.DATA_LOCATION_CANCEL)).toBe(true);
    expect(IPC_CHANNELS.DATA_LOCATION_GET).toBe('dataLocation.get');
    expect(IPC_CHANNELS.DATA_LOCATION_CHANGE).toBe('dataLocation.change');
    expect(IPC_CHANNELS.DATA_LOCATION_CANCEL).toBe('dataLocation.cancel');
  });
});
