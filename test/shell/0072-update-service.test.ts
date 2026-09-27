// 0072（R-073 发布批 lane A）：UpdateService 编排 ——
// 启动检查节流（<24h 跳过 / >24h 查 / 查后写 lastCheckAt）、checkNow 忽略节流、
// 非便携 available 后自动下载、便携降级（available 停住不下载、downloadUpdate 拒绝）、
// quitAndInstall 转发、状态订阅推送。
//
// 环境：node；adapter 用内存 stub（事件手动驱动），statePath 走真 fs 临时目录。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { UpdateService, createNotAvailableAdapter } from '../../src/shell/update/update-service.js';
import type { UpdaterAdapter, UpdaterEvent } from '../../src/shell/update/update-service.js';
import type { UpdateStatus } from '../../src/shared/contracts/distribution-types.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mofang-0072-update-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 内存 stub adapter：事件由测试显式 emit（模拟 electron-updater 的事件序） */
function makeStubAdapter() {
  const handlers: Array<(event: UpdaterEvent) => void> = [];
  const calls: string[] = [];
  const adapter: UpdaterAdapter = {
    checkForUpdates: async () => {
      calls.push('checkForUpdates');
    },
    downloadUpdate: async () => {
      calls.push('downloadUpdate');
    },
    quitAndInstall: () => {
      calls.push('quitAndInstall');
    },
    onEvent: (handler) => {
      handlers.push(handler);
      return () => {
        const i = handlers.indexOf(handler);
        if (i >= 0) handlers.splice(i, 1);
      };
    },
  };
  const emit = (event: UpdaterEvent) => {
    for (const h of [...handlers]) h(event);
  };
  return { adapter, emit, calls };
}

const statePath = () => join(root, 'update-state.json');
const HOUR = 60 * 60 * 1000;

async function makeService(opts: { portable?: boolean } = {}) {
  const stub = makeStubAdapter();
  const svc = new UpdateService({
    adapter: stub.adapter,
    statePath: statePath(),
    isPortable: opts.portable ?? false,
    now: () => 100 * HOUR,
    log: () => {},
  });
  return { svc, ...stub };
}

describe('0072 UpdateService 启动节流', () => {
  it('无 lastCheckAt → 启动检查并写 lastCheckAt', async () => {
    const { svc, emit, calls } = await makeService();
    const done = svc.maybeCheckOnStartup();
    expect(calls).toContain('checkForUpdates');
    emit({ type: 'checking' });
    emit({ type: 'not-available' });
    await done;
    expect(existsSync(statePath())).toBe(true);
    const persisted = JSON.parse(readFileSync(statePath(), 'utf8')) as { lastCheckAt?: string };
    expect(typeof persisted.lastCheckAt).toBe('string');
    expect(new Date(persisted.lastCheckAt!).getTime()).toBe(100 * HOUR);
  });

  it('<24h 前查过 → 启动不检查', async () => {
    const { svc, calls } = await makeService();
    const { writeFileSync: wf } = await import('node:fs');
    wf(statePath(), JSON.stringify({ lastCheckAt: new Date((100 * HOUR) - 1 * HOUR).toISOString() }), 'utf8');
    await svc.maybeCheckOnStartup();
    expect(calls).not.toContain('checkForUpdates');
  });

  it('>24h 前查过 → 启动检查', async () => {
    const { svc, calls } = await makeService();
    const { writeFileSync: wf } = await import('node:fs');
    wf(statePath(), JSON.stringify({ lastCheckAt: new Date((100 * HOUR) - 25 * HOUR).toISOString() }), 'utf8');
    await svc.maybeCheckOnStartup();
    expect(calls).toContain('checkForUpdates');
  });

  it('节流文件坏 JSON → 照查（宽容重启）', async () => {
    const { svc, calls } = await makeService();
    const { writeFileSync: wf } = await import('node:fs');
    wf(statePath(), '{broken', 'utf8');
    await svc.maybeCheckOnStartup();
    expect(calls).toContain('checkForUpdates');
  });
});

describe('0072 UpdateService checkNow（手动，忽略节流）', () => {
  it('刚查过也立即检查', async () => {
    const { svc, emit, calls } = await makeService();
    const { writeFileSync: wf } = await import('node:fs');
    wf(statePath(), JSON.stringify({ lastCheckAt: new Date(100 * HOUR).toISOString() }), 'utf8');
    const done = svc.checkNow();
    const result = await done;
    expect(result.started).toBe(true);
    expect(calls).toContain('checkForUpdates');
    emit({ type: 'checking' });
    emit({ type: 'not-available' });
  });

  it('手动检查置 manual 标志：失败后 status.manual=true', async () => {
    const { svc, emit } = await makeService();
    const done = svc.checkNow();
    emit({ type: 'checking' });
    emit({ type: 'error', message: 'net down' });
    await done;
    expect(svc.getStatus().phase).toBe('error');
    expect(svc.getStatus().manual).toBe(true);
  });
});

describe('0072 UpdateService 便携降级（L1+L2：检查+提示+打开下载页，不自动下载不装）', () => {
  it('available 后不自动 downloadUpdate，相位停在 available', async () => {
    const { svc, emit, calls } = await makeService({ portable: true });
    const done = svc.maybeCheckOnStartup();
    emit({ type: 'checking' });
    emit({ type: 'available', version: '9.9.9' });
    await done;
    expect(svc.getStatus().phase).toBe('available');
    expect(calls).not.toContain('downloadUpdate');
  });

  it('便携态 downloadUpdate 被拒（不做自动下载语义）', async () => {
    const { svc, calls } = await makeService({ portable: true });
    await expect(svc.downloadUpdate()).rejects.toThrow();
    expect(calls).not.toContain('downloadUpdate');
  });
});

describe('0072 UpdateService 非便携自动下载与安装', () => {
  it('available 后自动 downloadUpdate（autoDownload 编排在 service 层，真/stub adapter 一致）', async () => {
    const { svc, emit, calls } = await makeService();
    const done = svc.maybeCheckOnStartup();
    emit({ type: 'checking' });
    emit({ type: 'available', version: '9.9.9' });
    await done;
    expect(calls).toContain('downloadUpdate');
    emit({ type: 'progress', percent: 50, bytesPerSecond: 1e6, transferred: 5, total: 10 });
    emit({ type: 'downloaded', version: '9.9.9' });
    expect(svc.getStatus().phase).toBe('downloaded');
  });

  it('downloaded 后 quitAndInstall 转发 adapter（NSIS 覆盖安装）', async () => {
    const { svc, calls } = await makeService();
    svc.quitAndInstall();
    expect(calls).toContain('quitAndInstall');
  });
});

describe('0072 UpdateService 状态订阅', () => {
  it('onStatus 收到每次状态变化（含全量快照），退订后不再收', async () => {
    const { svc, emit } = await makeService();
    const seen: UpdateStatus[] = [];
    const off = svc.onStatus((s) => seen.push(s));
    emit({ type: 'checking' });
    emit({ type: 'available', version: '1.0.1' });
    off();
    emit({ type: 'downloaded' });
    expect(seen.map((s) => s.phase)).toEqual(['checking', 'available']);
    expect(seen[1].version).toBe('1.0.1');
  });

  it('getStatus 水合（进设置页拉当前态）', async () => {
    const { svc, emit } = await makeService();
    emit({ type: 'checking' });
    emit({ type: 'available', version: '2.0.0' });
    expect(svc.getStatus().phase).toBe('available');
    expect(svc.getStatus().version).toBe('2.0.0');
  });
});

describe('0072 dev 目检态 adapter（createNotAvailableAdapter，恒已是最新）', () => {
  it('checkNow → checking → not-available（不 throw）', async () => {
    const svc = new UpdateService({
      adapter: createNotAvailableAdapter(),
      statePath: join(root, 'dev-state.json'),
      isPortable: false,
      log: () => {},
    });
    const result = await svc.checkNow();
    expect(result.started).toBe(true);
    expect(svc.getStatus().phase).toBe('not-available');
  });

  it('downloadUpdate 拒绝（dev 无下载语义）', async () => {
    const svc = new UpdateService({
      adapter: createNotAvailableAdapter(),
      statePath: join(root, 'dev-state.json'),
      isPortable: false,
      log: () => {},
    });
    await expect(svc.downloadUpdate()).rejects.toThrow();
  });
});
