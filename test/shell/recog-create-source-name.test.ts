// 0046 P5.2：recog.create sourceName 优先级（整卷 PDF run 显示卷名，0040 §六.h / D-064）。
// - payload.sourceName 显式传入时优先（渲染层传 pdfPaperTitle(file.name)）
// - 缺省沿用既有口径：单素材 = 素材文件名，多素材 = null（不造假名）

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('electron', () => ({
  ipcMain: { handle: () => undefined },
  BrowserWindow: class {},
  dialog: {},
  safeStorage: { isEncryptionAvailable: () => false },
}));

import { RecogHost } from '../../src/shell/recog/recog-host.js';
import type { RecogRunCreateInput, RecogRunService } from '../../src/shared/contracts/recog-run-types.js';

const NOW = '2026-09-22T10:00:00.000Z';

function materialOf(name: string): { name: string; mime: string; dataBase64: string } {
  // 1x1 PNG（内容不重要：classify 按 name/mime 判定，字节只落盘）
  return { name, mime: 'image/png', dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' };
}

function makeRunsSpy(): { created: RecogRunCreateInput[]; service: RecogRunService } {
  const created: RecogRunCreateInput[] = [];
  const run = {
    id: 'x', status: 'queued' as const, stage: 'queued' as const, sourceKind: 'image' as const,
    sourceName: null, pageCount: 0, pagesDone: 0, error: null, warnings: [], questionIds: [],
    createdAt: NOW, updatedAt: NOW, finishedAt: null,
  };
  return {
    created,
    service: {
      createRun: async (input) => { created.push(input); return run; },
      getRun: async () => run,
      listRuns: async () => [run],
      setStatus: async () => run,
      listPages: async () => [],
      markPage: async () => undefined,
      setWarnings: async () => run,
      attachQuestions: async () => run,
    },
  };
}

let root = '';
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mofang-0046-source-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function makeHost(service: RecogRunService): RecogHost {
  return new RecogHost({
    runs: service,
    invoke: async () => ({ ok: false, error: '未脚本化', latencyMs: 0 }),
    runsRoot: root,
    broadcast: () => undefined,
    now: () => NOW,
  });
}

describe('0046 P5.2：createRun sourceName 优先级', () => {
  it('单素材 + payload.sourceName → sourceName 优先（不落素材文件名）', async () => {
    const spy = makeRunsSpy();
    await makeHost(spy.service).createRun({
      materials: [materialOf('photo.jpg')],
      sourceKind: 'image',
      sourceName: '浮力练习卷',
    });
    expect(spy.created).toHaveLength(1);
    expect(spy.created[0]!.sourceName).toBe('浮力练习卷');
  });

  it('单素材无 sourceName → 沿用素材文件名（既有口径不回归）', async () => {
    const spy = makeRunsSpy();
    await makeHost(spy.service).createRun({ materials: [materialOf('photo.jpg')], sourceKind: 'image' });
    expect(spy.created[0]!.sourceName).toBe('photo.jpg');
  });

  it('多素材 + payload.sourceName → sourceName（整卷 PDF 场景：页图多张、卷名一个）', async () => {
    const spy = makeRunsSpy();
    await makeHost(spy.service).createRun({
      materials: [materialOf('卷-p001.png'), materialOf('卷-p002.png')],
      sourceKind: 'image',
      sourceName: '期中物理',
    });
    expect(spy.created[0]!.sourceName).toBe('期中物理');
  });

  it('多素材无 sourceName → null（不造假名，既有口径）', async () => {
    const spy = makeRunsSpy();
    await makeHost(spy.service).createRun({
      materials: [materialOf('a.png'), materialOf('b.png')],
      sourceKind: 'image',
    });
    expect(spy.created[0]!.sourceName).toBeUndefined();
  });
});
