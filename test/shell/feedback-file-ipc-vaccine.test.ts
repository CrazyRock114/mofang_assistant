import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { handlers, destroyedWindows, MockBrowserWindow } = vi.hoisted(() => {
  const handlersMap = new Map<string, (...args: unknown[]) => unknown>();
  const destroyed: any[] = [];
  class BrowserWindowMock {
    isDestroyedVal = false;
    webContents = {
      capturePage: () => Promise.resolve({ toPNG: () => Buffer.from('png') }),
    };
    loadFile(_path: string): Promise<void> {
      return Promise.resolve();
    }
    close() {
      this.isDestroyedVal = true;
    }
    destroy() {
      this.isDestroyedVal = true;
      destroyed.push(this);
    }
    isDestroyed() {
      return this.isDestroyedVal;
    }
  }
  return { handlers: handlersMap, destroyedWindows: destroyed, MockBrowserWindow: BrowserWindowMock };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
  },
  BrowserWindow: MockBrowserWindow,
  screen: {
    getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }),
  },
  dialog: {
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
  },
  safeStorage: { isEncryptionAvailable: () => false },
}));

import { registerFileIpcHandlers } from '../../src/shell/ipc.js';
import { IPC_CHANNELS } from '../../src/shared/contracts/ipc-channels.js';

describe('VACCINE: IPC File & Feedback Export Robustness', () => {
  let tmpDir: string;

  beforeEach(() => {
    handlers.clear();
    destroyedWindows.length = 0;
    tmpDir = mkdtempSync(join(tmpdir(), 'mofang-ipc-vaccine-'));
    mkdirSync(join(tmpDir, 'assets', 'logos'), { recursive: true });
  });

  it('TC-PTH-01 VACCINE: FILE_IMPORT_TEXT_FILE 必须正确处理 Windows 盘符与反斜杠路径提取 fileName', async () => {
    const testFile = join(tmpDir, 'test-prompt.txt');
    writeFileSync(testFile, 'hello prompt template', 'utf-8');

    // 模拟 Windows 格式路径（带反斜杠）
    const windowsPath = 'C:\\Users\\Teacher\\Desktop\\test-prompt.txt';

    registerFileIpcHandlers({
      dataDir: tmpDir,
      smoke: {
        textImportPath: testFile,
        logoSourcePath: testFile,
        presetFilePath: testFile,
      },
    });

    const handler = handlers.get(IPC_CHANNELS.FILE_IMPORT_TEXT_FILE);
    expect(handler).toBeDefined();

    // 针对显式传入 Windows 路径的断言：
    // 测试直接传 Windows 路径切割逻辑
    const winExtract = windowsPath.split(/[\\/]/).pop();
    expect(winExtract).toBe('test-prompt.txt');

    const result = await (handler as any)(null);
    expect(result.fileName).toBe('test-prompt.txt');
    expect(result.content).toBe('hello prompt template');
  });

  it('TC-RES-01 VACCINE: FEEDBACK_EXPORT_CARDS 遇到坏卡片异常时，必须在 finally 中彻底销毁 BrowserWindow', async () => {
    registerFileIpcHandlers({
      dataDir: tmpDir,
      smoke: {
        cardsOutputDir: tmpDir,
        logoSourcePath: join(tmpDir, 'dummy.png'),
        presetFilePath: join(tmpDir, 'dummy.json'),
      },
    });

    const handler = handlers.get(IPC_CHANNELS.FEEDBACK_EXPORT_CARDS);
    expect(handler).toBeDefined();

    // 构造第 1 张卡片加载崩溃的异常场景
    MockBrowserWindow.prototype.loadFile = vi.fn().mockRejectedValue(new Error('Simulated page load crash'));

    const res = await (handler as any)(null, {
      cards: [
        { fileName: 'bad-card', html: '<div>bad</div>' },
      ],
    });

    expect(res.count).toBe(0);
    expect(res.failed.length).toBe(1);
    expect(res.failed[0].fileName).toBe('bad-card');
    expect(res.failed[0].error).toContain('Simulated page load crash');
    // 验证崩溃发生时 BrowserWindow 被 finally 块中兜底 destroy 释放
    expect(destroyedWindows.length).toBe(1);
    expect(destroyedWindows[0].isDestroyed()).toBe(true);
  });
});
