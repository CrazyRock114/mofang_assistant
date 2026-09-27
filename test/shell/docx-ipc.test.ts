// 0035 P4：doc.exportDocx 通道 handler 单测（mock ipcMain 层，模式照 test/shell/recog-ipc.test.ts）
// - 通道注册齐备 + 通道名逐字（契约不许漂移）
// - payload 校验（缺字段/类型不对 → 拒绝，不落盘）
// - 无公式卷真管线走通：组装 → 落盘（smoke 固定路径，不经对话框）→ 返回 stats
// - 用户取消保存对话框 → filePath=null（不落盘、stats 仍回传，UI 才能如实提示）
// 覆盖不到的部分在验收探针（scripts/probe-0035-docx.mjs）：公式栅格需真 Electron 隐藏窗。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const showSaveDialog = vi.fn();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
  },
  BrowserWindow: class {},
  dialog: { showSaveDialog: (...args: unknown[]) => showSaveDialog(...args) },
  safeStorage: { isEncryptionAvailable: () => false },
}));

import { registerIpcHandlers } from '../../src/shell/ipc.js';
import { IPC_CHANNELS } from '../../src/shared/contracts/ipc-channels.js';
import type { BankService } from '../../src/shared/contracts/bank-types.js';

function makeFakeBank(): BankService {
  return {} as unknown as BankService;
}

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`通道未注册: ${channel}`);
  return fn(null, ...args) as Promise<unknown>;
}

/** 无公式题（避开真 Electron 栅格窗；公式路径由验收探针覆盖） */
const paper = {
  id: 'p-0035',
  title: 'IPC 单测卷',
  config: { totalScore: 100, duration: 60 },
  createdAt: '2026-09-17T00:00:00Z',
  archived: false,
  status: 'done',
} as const;

const question = {
  id: 'q-0035',
  subject: '物理',
  sourceType: 'local',
  sourceDetail: { origin: 'ipc-test' },
  content: '<div class="question">一道没有公式的题</div>',
  images: [],
  createdAt: '2026-09-17T00:00:00Z',
  updatedAt: '2026-09-17T00:00:00Z',
} as const;

function payloadOf(over: Record<string, unknown> = {}) {
  return { paper, questions: [question], mode: 'student', suggestedName: 'IPC 单测卷-学生版.docx', ...over };
}

let tmpDir: string;

beforeEach(() => {
  handlers.clear();
  showSaveDialog.mockReset();
  tmpDir = mkdtempSync(join(tmpdir(), 'mf-docx-ipc-'));
});

describe('0035 P4：doc.exportDocx 通道', () => {
  it('注册即齐备，通道名逐字（契约不许漂移）', () => {
    registerIpcHandlers(makeFakeBank);
    expect(handlers.has(IPC_CHANNELS.DOC_EXPORT_DOCX)).toBe(true);
    expect(IPC_CHANNELS.DOC_EXPORT_DOCX).toBe('doc.exportDocx');
  });

  it('payload 校验：缺字段/类型不对一律拒绝，不落盘', async () => {
    registerIpcHandlers(makeFakeBank);
    const bad = [
      null,
      'not-an-object',
      payloadOf({ suggestedName: '' }),
      payloadOf({ suggestedName: undefined }),
      payloadOf({ mode: 'preview' }),
      payloadOf({ mode: undefined }),
      payloadOf({ paper: undefined }),
      payloadOf({ paper: {} }),
      payloadOf({ questions: 'nope' }),
    ];
    for (const item of bad) {
      await expect(invoke(IPC_CHANNELS.DOC_EXPORT_DOCX, item)).rejects.toThrow();
    }
    // 非法入参不得触达保存对话框
    expect(showSaveDialog).not.toHaveBeenCalled();
  });

  it('无公式卷真管线：组装 → 落盘（smoke 固定路径）→ 回传 stats', async () => {
    const outPath = join(tmpDir, 'via-ipc.docx');
    registerIpcHandlers(makeFakeBank, { smoke: { docxExportPath: outPath } });

    const result = await invoke(IPC_CHANNELS.DOC_EXPORT_DOCX, payloadOf()) as {
      filePath: string | null;
      stats: { mathTotal: number; imagesTotal: number; mathFailed: number; imagesMissing: number };
    };

    expect(result.filePath).toBe(outPath);
    expect(existsSync(outPath)).toBe(true);
    // docx = zip（PK 头）；且 stats 如实回传（0 公式 0 图）
    const bytes = readFileSync(outPath);
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(result.stats.mathTotal).toBe(0);
    expect(result.stats.mathFailed).toBe(0);
    expect(result.stats.imagesTotal).toBe(0);
    expect(result.stats.imagesMissing).toBe(0);
    // smoke 分支不经对话框
    expect(showSaveDialog).not.toHaveBeenCalled();
  });

  it('用户取消保存对话框 → filePath=null 且不落盘（stats 仍回传供 UI 呈现）', async () => {
    registerIpcHandlers(makeFakeBank);
    showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined });

    const result = await invoke(IPC_CHANNELS.DOC_EXPORT_DOCX, payloadOf()) as { filePath: string | null; stats: unknown };
    expect(result.filePath).toBeNull();
    expect(result.stats).toBeDefined();
    expect(showSaveDialog).toHaveBeenCalledTimes(1);
  });

  it('对话框返回路径 → 落盘到该路径', async () => {
    const chosen = join(tmpDir, 'chosen.docx');
    registerIpcHandlers(makeFakeBank);
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: chosen });

    const result = await invoke(IPC_CHANNELS.DOC_EXPORT_DOCX, payloadOf({ mode: 'teacher' })) as { filePath: string | null };
    expect(result.filePath).toBe(chosen);
    expect(existsSync(chosen)).toBe(true);
  });
});

// 清理（用例间独立临时目录）
process.on('exit', () => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
});
