// 0057 P5：图资产落盘（真 fs 临时目录）+ 存量 backfill（备份/幂等/失败隔离/跳过非 base64）
// + file.saveRecogImage 通道注册与形验。
//
// 环境：node。electron 全 mock（模式照 test/shell/recog-ipc.test.ts）；落盘走真 fs，
// 故「往返」「二次运行零改动」是文件级实证而非打桩。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
  },
  BrowserWindow: class {},
  dialog: {},
  safeStorage: { isEncryptionAvailable: () => false },
}));

import { parseImageDataUrl, pngSizeOf, saveRecogImageDataUrl } from '../../src/shell/recog-image-store.js';
import { runRecogImageBackfill, type BackfillQuestionLike } from '../../src/shell/recog-image-backfill.js';
import { registerFileIpcHandlers } from '../../src/shell/ipc.js';
import { IPC_CHANNELS } from '../../src/shared/contracts/ipc-channels.js';

/** 1×1 PNG（真字节，含 IHDR：宽高各 1） */
const PNG_1x1_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const PNG_1x1 = `data:image/png;base64,${PNG_1x1_B64}`;
/** 另一张图（内容不同 → 不同 sha256）——取真 PNG 的字节尾部替换，仍解为合法 base64 */
const PNG_B = 'data:image/png;base64,QUJDREVG';

let root: string;
let dataDir: string;
let dbPath: string;

beforeEach(() => {
  handlers.clear();
  root = mkdtempSync(join(tmpdir(), 'mofang-0057-'));
  dataDir = join(root, 'data');
  mkdirSync(join(dataDir, 'assets'), { recursive: true });
  dbPath = join(dataDir, 'bank.db');
  writeFileSync(dbPath, 'FAKE-DB-BYTES-v1');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const recogDir = (): string => join(dataDir, 'assets', 'recog');
const recogFiles = (): string[] => (existsSync(recogDir()) ? readdirSync(recogDir()).sort() : []);

/** 假 bank 面（内存表；只记调用，不碰 SQL） */
function makeFakeBank(seed: BackfillQuestionLike[]) {
  const rows = new Map(seed.map((question) => [question.id, { ...question }]));
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const logs: Array<{ op: string; kind: 'start' | 'success' | 'failure'; detail: unknown }> = [];
  return {
    rows, updates, logs,
    listQuestions: async () => [...rows.values()].map((row) => ({ ...row })),
    updateQuestion: async (id: string, patch: Record<string, unknown>) => {
      updates.push({ id, patch });
      rows.set(id, { ...rows.get(id)!, ...patch });
      return rows.get(id);
    },
    logger: {
      logStart: (op: string) => { logs.push({ op, kind: 'start', detail: null }); return `log-${logs.length}`; },
      logSuccess: (id: string, affected: number) => { logs.push({ op: 'success', kind: 'success', detail: { id, affected } }); },
      logFailure: (id: string, error: Error) => { logs.push({ op: 'failure', kind: 'failure', detail: { id, message: error.message } }); },
    },
  };
}

describe('0057 P1：落资产（data URL → data/assets/recog/<sha256 前 32>.png）', () => {
  it('往返：dataUrl 落盘 → relPath 指向真文件、字节非空、扩展名按 mime', () => {
    const asset = saveRecogImageDataUrl(dataDir, { dataUrl: PNG_1x1, width: 1, height: 1 });
    expect(asset.relPath).toMatch(/^recog\/[0-9a-f]{32}\.png$/);
    const file = join(dataDir, 'assets', asset.relPath);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file).length).toBeGreaterThan(0);
    expect(asset).toMatchObject({ width: 1, height: 1 });
  });

  it('内容寻址：同字节二次落盘零写入（文件名同、mtime 不动），不同字节各占一名', () => {
    const first = saveRecogImageDataUrl(dataDir, { dataUrl: PNG_1x1 });
    const mtimeBefore = readFileSync(join(dataDir, 'assets', first.relPath));
    const second = saveRecogImageDataUrl(dataDir, { dataUrl: PNG_1x1 });
    expect(second.relPath).toBe(first.relPath);
    expect(recogFiles()).toHaveLength(1);
    expect(readFileSync(join(dataDir, 'assets', second.relPath))).toEqual(mtimeBefore);
    saveRecogImageDataUrl(dataDir, { dataUrl: PNG_B });
    expect(recogFiles()).toHaveLength(2);
  });

  it('宽高缺省时按 PNG IHDR 解析（真实尺寸，非猜）', () => {
    const asset = saveRecogImageDataUrl(dataDir, { dataUrl: PNG_1x1 });
    expect(asset.width).toBe(1);
    expect(asset.height).toBe(1);
    expect(pngSizeOf(join(dataDir, 'assets', asset.relPath))).toEqual({ width: 1, height: 1 });
  });

  it('形验：非 base64 / 非白名单 mime / 空载荷 → parseImageDataUrl 返 null（调用方显式抛错）', () => {
    expect(parseImageDataUrl('data:image/svg+xml,%3Csvg xmlns=…%3C/svg%3E')).toBeNull();
    expect(parseImageDataUrl('data:image/bmp;base64,QUJD')).toBeNull();
    expect(parseImageDataUrl('data:image/png;base64,')).toBeNull();
    expect(parseImageDataUrl('https://example.com/a.png')).toBeNull();
  });

  it('形验失败显式抛错（不静默产坏图）', () => {
    expect(() => saveRecogImageDataUrl(dataDir, { dataUrl: 'data:image/bmp;base64,QUJD' }))
      .toThrow(/dataUrl 必须是/);
    expect(recogFiles()).toHaveLength(0);
  });

  it('svg+xml base64 → .svg（白名单沿用 logos 口径）', () => {
    const asset = saveRecogImageDataUrl(dataDir, { dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' });
    expect(asset.relPath).toMatch(/\.svg$/);
  });
});

describe('0057 P4：存量 backfill（幂等 / 备份 / 失败隔离 / 跳过非 base64）', () => {
  const inlineQuestion = (id: string): BackfillQuestionLike => ({
    id,
    content: `<div class="question"><p>如图</p><figure class="diagram" data-w="320"><img class="q-figure" src="${PNG_1x1}"></figure></div>`,
    answer: '<p>A</p>',
    analysis: '',
    images: [],
  });

  it('有内联图的题：content 改写为 data-assets 引用 + images 填上 + 落盘一次', async () => {
    const bank = makeFakeBank([inlineQuestion('q-1')]);
    const report = await runRecogImageBackfill({
      listQuestions: bank.listQuestions,
      updateQuestion: bank.updateQuestion,
      dataDir, dbPath, logger: bank.logger,
    });

    expect(report).toMatchObject({ scanned: 1, candidates: 1, changed: 1, persistedFiles: 1, failures: [], backedUp: true });
    expect(bank.updates).toHaveLength(1);
    const patch = bank.updates[0]!.patch;
    expect(patch['content']).toContain('src="data-assets/recog/');
    expect(patch['content']).not.toContain('data:image');
    expect(patch['images']).toEqual([expect.objectContaining({ type: 'figure' })]);
    const assetId = (patch['images'] as Array<{ assetId: string }>)[0]!.assetId;
    expect(assetId).toMatch(/^data-assets\/recog\/[0-9a-f]{32}\.png$/);
    expect(String(patch['content'])).toContain(`"${assetId}"`);
    // 备份落盘且内容是迁移前字节
    expect(readFileSync(`${dbPath}.bak-0057`, 'utf-8')).toBe('FAKE-DB-BYTES-v1');
    // 台账：start + success（affectedCount=改写题数）
    expect(bank.logs).toHaveLength(2);
    expect(bank.logs[1]).toMatchObject({ kind: 'success', detail: { affected: 1 } });
  });

  it('幂等：连跑两次，第二次零更新、零写盘、零 operation_log', async () => {
    const bank = makeFakeBank([inlineQuestion('q-1')]);
    await runRecogImageBackfill({ listQuestions: bank.listQuestions, updateQuestion: bank.updateQuestion, dataDir, dbPath, logger: bank.logger });
    const filesAfterFirst = recogFiles();
    const logsAfterFirst = bank.logs.length;
    const updatesAfterFirst = bank.updates.length;

    const second = await runRecogImageBackfill({ listQuestions: bank.listQuestions, updateQuestion: bank.updateQuestion, dataDir, dbPath, logger: bank.logger });
    expect(second).toMatchObject({ candidates: 0, changed: 0, persistedFiles: 0, failures: [], backedUp: false });
    expect(bank.updates).toHaveLength(updatesAfterFirst);
    expect(bank.logs).toHaveLength(logsAfterFirst);
    expect(recogFiles()).toEqual(filesAfterFirst);
  });

  it('干净库（无内联图）→ no-op：不备份、不写库、不留痕', async () => {
    const bank = makeFakeBank([{ id: 'q-clean', content: '<div class="question"><p>无图</p></div>', images: [] }]);
    const report = await runRecogImageBackfill({ listQuestions: bank.listQuestions, updateQuestion: bank.updateQuestion, dataDir, dbPath, logger: bank.logger });
    expect(report).toMatchObject({ scanned: 1, candidates: 0, changed: 0, backedUp: false });
    expect(existsSync(`${dbPath}.bak-0057`)).toBe(false);
    expect(bank.updates).toHaveLength(0);
    expect(bank.logs).toHaveLength(0);
  });

  it('非 base64 内联图（mock 演示题形态）→ 跳过并计数，零更新（明确不动）', async () => {
    const mockContent = '<div class="question"><img src="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\'%3E%3C/svg%3E"></div>';
    const bank = makeFakeBank([{ id: '1ccfe3bf', content: mockContent, images: [] }]);
    const report = await runRecogImageBackfill({ listQuestions: bank.listQuestions, updateQuestion: bank.updateQuestion, dataDir, dbPath, logger: bank.logger });
    expect(report).toMatchObject({ candidates: 0, skippedNonBase64: 1, changed: 0, backedUp: false });
    expect(bank.updates).toHaveLength(0);
    expect(bank.rows.get('1ccfe3bf')!.content).toBe(mockContent);
  });

  it('单题失败不中断：坏图题记失败、其余题照常改写，run 级留痕记 failed', async () => {
    const bad: BackfillQuestionLike = {
      id: 'q-bad',
      content: '<div class="question"><img src="data:image/png;base64,%%%%"></div>', // 载荷非法 → 解码后空/形验不过
      images: [],
    };
    const bank = makeFakeBank([bad, inlineQuestion('q-good')]);
    const report = await runRecogImageBackfill({
      listQuestions: bank.listQuestions,
      updateQuestion: bank.updateQuestion,
      dataDir, dbPath, logger: bank.logger,
      warn: () => undefined,
    });
    expect(report.changed).toBe(1);
    expect(report.failures.map((f) => f.id)).toEqual(['q-bad']);
    expect(bank.rows.get('q-good')!.content).toContain('data-assets/recog/');
    expect(bank.rows.get('q-bad')!.content).toContain('%%%%');
    expect(bank.logs.map((l) => l.kind)).toEqual(['start', 'failure']);
  });

  it('同题多字段（content+answer）各落各图，images 只收 content 的资产引用', async () => {
    const bank = makeFakeBank([{
      id: 'q-two',
      content: `<div class="question"><img src="${PNG_1x1}"></div>`,
      answer: `<p>过程</p><img src="${PNG_B}">`,
      images: [],
    }]);
    const report = await runRecogImageBackfill({ listQuestions: bank.listQuestions, updateQuestion: bank.updateQuestion, dataDir, dbPath, logger: bank.logger });
    expect(report.persistedFiles).toBe(2);
    const patch = bank.updates[0]!.patch;
    expect(String(patch['content'])).not.toContain('data:image');
    expect(String(patch['answer'])).not.toContain('data:image');
    expect(patch['images']).toHaveLength(1); // 只有 content 里的那张进 images
  });
});

describe('0057 P1：file.saveRecogImage 通道（注册 + 形验 + 落盘）', () => {
  it('注册即齐备且通道名逐字（契约不许漂移）', () => {
    registerFileIpcHandlers({ dataDir });
    expect(IPC_CHANNELS.FILE_SAVE_RECOG_IMAGE).toBe('file.saveRecogImage');
    expect(handlers.has(IPC_CHANNELS.FILE_SAVE_RECOG_IMAGE)).toBe(true);
  });

  it('合法 payload → relPath 相对 data/assets 且文件落盘', () => {
    registerFileIpcHandlers({ dataDir });
    const result = handlers.get(IPC_CHANNELS.FILE_SAVE_RECOG_IMAGE)!(null, { dataUrl: PNG_1x1, width: 1, height: 1 }) as { relPath: string };
    expect(result.relPath).toMatch(/^recog\//);
    expect(existsSync(join(dataDir, 'assets', result.relPath))).toBe(true);
  });

  it('形验：缺 dataUrl / 类型不对 → 抛错（不产坏图）', () => {
    registerFileIpcHandlers({ dataDir });
    const call = handlers.get(IPC_CHANNELS.FILE_SAVE_RECOG_IMAGE)!;
    expect(() => call(null, {})).toThrow(/Invalid payload/);
    expect(() => call(null, { dataUrl: PNG_1x1, width: '1' })).toThrow(/Invalid payload.width/);
    expect(() => call(null, { dataUrl: 'not-a-data-url' })).toThrow(/dataUrl 必须是/);
  });
});
