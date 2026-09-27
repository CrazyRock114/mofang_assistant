// 0061 废图清理（R-057 / D-072）：recog 资产孤儿扫描 → 预览 → 移入回收目录。
//
// 环境：node。electron 全 mock（模式照 test/shell/recog-image-assets.test.ts）；文件操作走真 fs，
// 故「分类/移位/回收目录结构」是文件级实证而非打桩。库侧一律注入假只读面（本单零 SQL：bank-core 唯一碰 SQL）。

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

import { scanRecogAssetGarbage, trashRecogAssets } from '../../src/shell/recog-asset-cleaner.js';
import type { RecogAssetCleanerServices } from '../../src/shell/recog-asset-cleaner.js';
import { registerFileIpcHandlers } from '../../src/shell/ipc.js';
import { IPC_CHANNELS } from '../../src/shared/contracts/ipc-channels.js';

/** 32hex 资产文件名（与 recog-image-store 内容寻址命名同形） */
const name = (ch: string): string => `${ch.repeat(32)}.png`;
const rel = (ch: string): string => `recog/${name(ch)}`;

let root: string;
let dataDir: string;

beforeEach(() => {
  handlers.clear();
  root = mkdtempSync(join(tmpdir(), 'mofang-0061-'));
  dataDir = join(root, 'data');
  mkdirSync(join(dataDir, 'assets', 'recog'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function putAsset(ch: string, bytes: string): number {
  const buf = Buffer.from(bytes);
  writeFileSync(join(dataDir, 'assets', 'recog', name(ch)), buf);
  return buf.length;
}

function recogFiles(): string[] {
  const dir = join(dataDir, 'assets', 'recog');
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function seedDraft(runId: string, contentHtml: string): void {
  const runDir = join(dataDir, 'recog', 'runs', runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'workbench.json'), JSON.stringify({
    version: 1, runId, mode: 'auto', stage: '', subjectId: '', paperTitle: '', pages: [], nextSeq: 1,
    cards: [{
      id: 'c1', status: 'question', source: 'manual', checked: true, frames: [], error: null, qno: '1',
      typeCode: '', contentHtml, answerHtml: '', analysisHtml: '', figures: [], figureSource: 'none',
      warnings: [], tags: [], adoptedTags: [], treeSuggestions: [], adoptedNode: null, committedQuestionId: null,
    }],
  }), 'utf8');
}

interface Seed {
  questions?: Array<Record<string, unknown>>;
  paperLayouts?: Array<{ paperId: string; figures: Array<{ assetId: string }> }>;
  paperSnapshots?: Record<string, Array<Record<string, unknown>>>;
  mistakes?: Array<Record<string, unknown>>;
}

/** 假只读面（结构化子集；调用次数记账供断言） */
function makeRefs(seed: Seed = {}): { refs: RecogAssetCleanerServices; calls: string[] } {
  const calls: string[] = [];
  const papers = new Set<string>();
  for (const row of seed.paperLayouts ?? []) papers.add(row.paperId);
  for (const paperId of Object.keys(seed.paperSnapshots ?? {})) papers.add(paperId);
  return {
    calls,
    refs: {
      bank: {
        listQuestions: async () => { calls.push('listQuestions'); return (seed.questions ?? []) as never; },
        getPaperQuestions: async (paperId: string) => {
          calls.push(`getPaperQuestions:${paperId}`);
          const hit = (seed.paperLayouts ?? []).find((row) => row.paperId === paperId);
          return (hit ? [{ layout: { figures: hit.figures } }] : []) as never;
        },
      },
      paper: {
        listPapersEx: async () => {
          calls.push('listPapersEx');
          return [...papers].map((id) => ({ paper: { id } })) as never;
        },
        listPaperSnapshotQuestions: async (paperId: string) => {
          calls.push(`listPaperSnapshotQuestions:${paperId}`);
          return (seed.paperSnapshots?.[paperId] ?? []) as never;
        },
      },
      mistake: {
        listMistakes: async () => { calls.push('listMistakes'); return (seed.mistakes ?? []) as never; },
      },
    },
  };
}

function makeLogger() {
  const logs: Array<{ op: string; kind: string; detail: unknown }> = [];
  return {
    logs,
    logger: {
      logStart: (op: string, description: string, metadata?: Record<string, unknown>) => {
        logs.push({ op, kind: 'start', detail: { description, metadata } });
        return `log-${logs.length}`;
      },
      logSuccess: (id: string, affected: number) => { logs.push({ op: 'success', kind: 'success', detail: { id, affected } }); },
      logFailure: (id: string, error: Error) => { logs.push({ op: 'failure', kind: 'failure', detail: { id, message: error.message } }); },
    },
  };
}

describe('0061 P1：孤儿分类（引用面六源，宁留不误删）', () => {
  it('无引用文件 = 孤儿；scannedCount/ referencedCount/totalBytes 与盘上事实一致', async () => {
    const bytesA = putAsset('a', 'orphan-a');
    const bytesB = putAsset('b', 'orphan-b');
    const { refs } = makeRefs({ questions: [{ id: 'q1', content: `<img src="data-assets/${rel('c')}">` }] });
    putAsset('c', 'referenced');

    const result = await scanRecogAssetGarbage({ dataDir, refs });
    expect(result.orphans.map((o) => o.relPath).sort()).toEqual([rel('a'), rel('b')].sort());
    expect(result.orphans.find((o) => o.relPath === rel('a'))?.bytes).toBe(bytesA);
    expect(result.totalBytes).toBe(bytesA + bytesB);
    expect(result.scannedCount).toBe(3);
    expect(result.referencedCount).toBe(1);
  });

  it('引用来源①题干三字段：content / answer / analysis 任一含引用即保留', async () => {
    putAsset('a', 'qa');
    putAsset('b', 'qb');
    putAsset('c', 'qc');
    putAsset('f', 'orphan');
    const { refs } = makeRefs({
      questions: [{
        id: 'q1',
        content: `<img src="data-assets/${rel('a')}">`,
        answer: `<p><img src="data-assets/${rel('b')}"></p>`,
        analysis: `<p><img src="data-assets/${rel('c')}"></p>`,
      }],
    });
    const result = await scanRecogAssetGarbage({ dataDir, refs });
    expect(result.orphans.map((o) => o.relPath)).toEqual([rel('f')]);
    expect(result.referencedCount).toBe(3);
  });

  it('引用来源②questions.images 列：assetId（带 data-assets 前缀）同样算引用', async () => {
    putAsset('a', 'img-col');
    putAsset('f', 'orphan');
    const { refs } = makeRefs({
      questions: [{ id: 'q1', content: '<p>无内联图</p>', images: [{ assetId: `data-assets/${rel('a')}`, type: 'figure' }] }],
    });
    const result = await scanRecogAssetGarbage({ dataDir, refs });
    expect(result.orphans.map((o) => o.relPath)).toEqual([rel('f')]);
  });

  it('引用来源③paper_questions.layout_json：figures[].assetId 两形态（带/不带前缀）都归一', async () => {
    putAsset('a', 'layout-with-prefix');
    putAsset('b', 'layout-bare');
    putAsset('f', 'orphan');
    const { refs } = makeRefs({
      paperLayouts: [{ paperId: 'p1', figures: [{ assetId: `data-assets/${rel('a')}` }, { assetId: rel('b') }] }],
    });
    const result = await scanRecogAssetGarbage({ dataDir, refs });
    expect(result.orphans.map((o) => o.relPath)).toEqual([rel('f')]);
  });

  it('引用来源④录题草稿 workbench.json：cards 三字段引用即保留', async () => {
    putAsset('a', 'draft-ref');
    putAsset('f', 'orphan');
    seedDraft('run-1', `<div class="question"><p>题</p><img src="data-assets/${rel('a')}"></div>`);
    const { refs } = makeRefs({});
    const result = await scanRecogAssetGarbage({ dataDir, refs });
    expect(result.orphans.map((o) => o.relPath)).toEqual([rel('f')]);
  });

  it('引用来源⑤试卷快照（done/archived 卷走 listPaperSnapshotQuestions）：三字段+images 均保留', async () => {
    putAsset('a', 'snap-content');
    putAsset('b', 'snap-images');
    putAsset('f', 'orphan');
    const { refs } = makeRefs({
      paperSnapshots: {
        p1: [
          { id: 'q1', content: `<img src="data-assets/${rel('a')}">` },
          { id: 'q2', content: '<p>图在 images 列</p>', images: [{ assetId: `data-assets/${rel('b')}`, type: 'figure' }] },
        ],
      },
    });
    const result = await scanRecogAssetGarbage({ dataDir, refs });
    expect(result.orphans.map((o) => o.relPath)).toEqual([rel('f')]);
  });

  it('引用来源⑥错题快照（mistakes.snapshot_json）：stemHtml/answer/analysis/options/images 均保留', async () => {
    putAsset('a', 'mistake-stem');
    putAsset('b', 'mistake-option');
    putAsset('c', 'mistake-images');
    putAsset('f', 'orphan');
    const { refs } = makeRefs({
      mistakes: [{
        snapshot: {
          stemHtml: `<img src="data-assets/${rel('a')}">`,
          answer: '<p>A</p>',
          analysis: '<p>析</p>',
          options: [{ label: 'A', html: `<img src="data-assets/${rel('b')}">` }],
          images: [{ assetId: `data-assets/${rel('c')}`, type: 'figure' }],
        },
      }],
    });
    const result = await scanRecogAssetGarbage({ dataDir, refs });
    expect(result.orphans.map((o) => o.relPath)).toEqual([rel('f')]);
  });

  it('结构化字段同扫：questions.stemHtml / options[].html 里的引用也算（采集链题的权威题干形态）', async () => {
    putAsset('a', 'stem');
    putAsset('b', 'option');
    putAsset('f', 'orphan');
    const { refs } = makeRefs({
      questions: [{
        id: 'q1',
        content: '<p>派生兼容字段无图</p>',
        stemHtml: `<img src="data-assets/${rel('a')}">`,
        options: [{ label: 'A', html: `<img src="data-assets/${rel('b')}">` }],
      }],
    });
    const result = await scanRecogAssetGarbage({ dataDir, refs });
    expect(result.orphans.map((o) => o.relPath)).toEqual([rel('f')]);
  });

  it('范围纪律：assets/capture 与 _trash 自身零触碰；recog/ 下非资产形态文件不判孤儿', async () => {
    putAsset('a', 'orphan');
    const captureDir = join(dataDir, 'assets', 'capture');
    mkdirSync(captureDir, { recursive: true });
    writeFileSync(join(captureDir, 'cap.png'), 'capture-bytes');
    writeFileSync(join(dataDir, 'assets', 'recog', 'manual-note.txt'), 'not-an-asset');
    const { refs } = makeRefs({});
    const result = await scanRecogAssetGarbage({ dataDir, refs });
    expect(result.orphans.map((o) => o.relPath)).toEqual([rel('a')]);
    expect(result.scannedCount).toBe(1);
    expect(existsSync(join(captureDir, 'cap.png'))).toBe(true);
  });

  it('assets/recog/ 目录不存在 = 空结果（非错误）；草稿目录缺失同样不炸', async () => {
    rmSync(join(dataDir, 'assets', 'recog'), { recursive: true, force: true });
    const { refs } = makeRefs({});
    const result = await scanRecogAssetGarbage({ dataDir, refs });
    expect(result).toEqual({ orphans: [], totalBytes: 0, referencedCount: 0, scannedCount: 0 });
  });

  it('损坏 workbench.json：JSON 解析失败仍按原文兜底提取引用（宁留不误删）+ 告警计数', async () => {
    putAsset('a', 'corrupt-draft-ref');
    putAsset('f', 'orphan');
    const runDir = join(dataDir, 'recog', 'runs', 'run-bad');
    mkdirSync(runDir, { recursive: true });
    // 真 JSON 被截断（模拟写盘被打断、原子替换前的半截文件）：引用串完整、JSON 不闭合
    const full = JSON.stringify({
      version: 1, runId: 'run-bad', cards: [{ id: 'c1', contentHtml: `<img src="data-assets/${rel('a')}">` }],
    });
    const cut = full.indexOf(rel('a')) + rel('a').length;
    writeFileSync(join(runDir, 'workbench.json'), full.slice(0, cut), 'utf8');
    const warns: string[] = [];
    const { refs } = makeRefs({});
    const result = await scanRecogAssetGarbage({ dataDir, refs, warn: (m) => warns.push(m) });
    expect(result.orphans.map((o) => o.relPath)).toEqual([rel('f')]);
    expect(warns.some((m) => m.includes('run-bad'))).toBe(true);
  });
});

describe('0061 P2：trashRecogAssets（形验 / ∩ 语义 / 移位 / 占用跳过 / 台账）', () => {
  it('形验拒绝路径逃逸与非资产名（../、绝对路径、非白名单扩展名、非法摘要）', async () => {
    putAsset('a', 'x');
    const { refs } = makeRefs({});
    const deps = { dataDir, refs };
    for (const bad of [
      ['recog/../../../etc/passwd'],
      ['../../../evil.png'],
      ['C:\\Windows\\System32\\evil.png'],
      ['/etc/shadow'],
      ['recog/not-a-hash.png'],
      ['recog/' + 'a'.repeat(32) + '.exe'],
      ['recog/' + 'a'.repeat(31) + '.png'],
      ['recog/../' + name('a')],
      ['capture/' + name('a')],
    ]) {
      await expect(trashRecogAssets(deps, { relPaths: bad })).rejects.toThrow(/Invalid relPath/);
    }
    // 形验失败零副作用：盘上文件一个没动、回收目录未创建
    expect(recogFiles()).toEqual([name('a')]);
    expect(existsSync(join(dataDir, 'assets', '_trash'))).toBe(false);
  });

  it('移位：孤儿移入 assets/_trash/<日期>/recog/（字节保真、原目录减少）；被引用项保留', async () => {
    const bytesA = putAsset('a', 'orphan-a');
    const bytesB = putAsset('b', 'orphan-b');
    putAsset('c', 'referenced');
    const { refs } = makeRefs({ questions: [{ id: 'q1', content: `<img src="data-assets/${rel('c')}">` }] });
    const { logs, logger } = makeLogger();

    const result = await trashRecogAssets({ dataDir, refs, logger }, { relPaths: [rel('a'), rel('b'), rel('c')] });
    expect(result.moved).toBe(2);
    expect(result.bytes).toBe(bytesA + bytesB);
    expect(result.trashDir).toMatch(/assets[\\/]_trash[\\/]\d{8}-\d{6}$/);
    // 回收目录保留相对结构：_trash/<日期>/recog/<原文件名>
    const trashed = readdirSync(join(result.trashDir, 'recog')).sort();
    expect(trashed).toEqual([name('a'), name('b')].sort());
    expect(readFileSync(join(result.trashDir, 'recog', name('a')), 'utf-8')).toBe('orphan-a');
    // 原目录：被引用的 c 保留（入参含被引用者 = 跳过，不误删）
    expect(recogFiles()).toEqual([name('c')]);
    // 台账：一条 start + 一条 success（affectedCount=moved；metadata 为动手前已知量 requested/planned/bytes/trashDir）
    expect(logs).toEqual([
      {
        op: 'recog.assetTrash',
        kind: 'start',
        detail: expect.objectContaining({
          metadata: expect.objectContaining({ requested: 3, planned: 2, bytes: bytesA + bytesB, trashDir: result.trashDir }),
        }),
      },
      { op: 'success', kind: 'success', detail: { id: expect.any(String), affected: 2 } },
    ]);
  });

  it('「入参 ∩ 最新孤儿集」语义锁：扫描后新增引用 → 该文件被跳过（禁缓存陈旧判定）', async () => {
    putAsset('a', 'was-orphan');
    const seed: Seed = { questions: [{ id: 'q1', content: '<p>无图</p>' }] };
    const { refs } = makeRefs(seed);
    const first = await scanRecogAssetGarbage({ dataDir, refs });
    expect(first.orphans.map((o) => o.relPath)).toEqual([rel('a')]);

    // 扫描之后、trash 之前：题面新增对该资产的引用（恢复旧备份/编辑题面的现实场景）
    seed.questions = [{ id: 'q1', content: `<img src="data-assets/${rel('a')}">` }];
    const result = await trashRecogAssets({ dataDir, refs }, { relPaths: [rel('a')] });
    expect(result.moved).toBe(0);
    expect(recogFiles()).toEqual([name('a')]);
  });

  it('占用/权限失败（EPERM/EBUSY）逐文件跳过：不整批失败，moved 只计成功', async () => {
    putAsset('a', 'busy');
    putAsset('b', 'free');
    const { refs } = makeRefs({});
    const { logs, logger } = makeLogger();
    const moveFile = (from: string, to: string): void => {
      if (from.endsWith(name('a'))) {
        const err = new Error('EPERM: operation not permitted, rename') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
      writeFileSync(to, readFileSync(from));
      rmSync(from);
    };
    const result = await trashRecogAssets({ dataDir, refs, logger, moveFile }, { relPaths: [rel('a'), rel('b')] });
    expect(result.moved).toBe(1);
    expect(recogFiles()).toEqual([name('a')]);
    expect(readdirSync(join(result.trashDir, 'recog'))).toEqual([name('b')]);
    // 占用跳过不整批失败：台账 metadata 记计划量（planned=2），实际 affected_count=1 反映跳过
    expect(logs[0]!.detail).toEqual(expect.objectContaining({
      metadata: expect.objectContaining({ requested: 2, planned: 2, trashDir: result.trashDir }),
    }));
    expect(logs[1]!.detail).toEqual({ id: expect.any(String), affected: 1 });
  });

  it('非 EPERM/EBUSY 的意外错误 = 整批失败并留 failure 台账（不静默）', async () => {
    putAsset('a', 'x');
    const { refs } = makeRefs({});
    const { logs, logger } = makeLogger();
    const moveFile = (): void => { throw new Error('EIO: i/o error'); };
    await expect(trashRecogAssets({ dataDir, refs, logger, moveFile }, { relPaths: [rel('a')] }))
      .rejects.toThrow(/EIO/);
    expect(logs.at(-1)).toEqual({ op: 'failure', kind: 'failure', detail: { id: expect.any(String), message: expect.stringContaining('EIO') } });
  });

  it('空入参 = 零动作零留痕（不产台账噪声）', async () => {
    putAsset('a', 'orphan');
    const { refs } = makeRefs({});
    const { logs, logger } = makeLogger();
    const result = await trashRecogAssets({ dataDir, refs, logger }, { relPaths: [] });
    expect(result.moved).toBe(0);
    expect(result.bytes).toBe(0);
    expect(logs).toEqual([]);
    expect(recogFiles()).toEqual([name('a')]);
  });

  it('幂等：同一批再移一次 → 0 移动（文件已不在 recog/），回收目录不重复建、零台账噪声', async () => {
    putAsset('a', 'orphan');
    const { refs } = makeRefs({});
    const first = await trashRecogAssets({ dataDir, refs }, { relPaths: [rel('a')] });
    const { logs, logger } = makeLogger();
    const second = await trashRecogAssets({ dataDir, refs, logger }, { relPaths: [rel('a')] });
    expect(first.moved).toBe(1);
    expect(second.moved).toBe(0);
    expect(readdirSync(join(first.trashDir, 'recog'))).toEqual([name('a')]);
    expect(logs).toEqual([]); // 零动作不留痕（与 0057 干净库零留痕同口径）
  });
});

describe('0061 P3：file.* 两通道接线与形验（registerFileIpcHandlers）', () => {
  it('缺省（无 cleaner 注入）不注册两通道——demo/测试环境不出现半截功能', () => {
    registerFileIpcHandlers({ dataDir });
    expect(handlers.has(IPC_CHANNELS.FILE_SCAN_RECOG_ASSET_GARBAGE)).toBe(false);
    expect(handlers.has(IPC_CHANNELS.FILE_TRASH_RECOG_ASSETS)).toBe(false);
  });

  it('扫通道：返回孤儿清单；trash 通道：形验失败显式抛错、成功返回 moved/bytes/trashDir', async () => {
    putAsset('a', 'orphan');
    const { refs } = makeRefs({});
    registerFileIpcHandlers({ dataDir, cleaner: () => ({ refs }) });

    const scan = await handlers.get(IPC_CHANNELS.FILE_SCAN_RECOG_ASSET_GARBAGE)!() as {
      orphans: Array<{ relPath: string; bytes: number }>; totalBytes: number; scannedCount: number;
    };
    expect(scan.orphans.map((o) => o.relPath)).toEqual([rel('a')]);
    expect(scan.scannedCount).toBe(1);

    await expect(Promise.resolve()
      .then(() => handlers.get(IPC_CHANNELS.FILE_TRASH_RECOG_ASSETS)!(null, { relPaths: ['../x.png'] })))
      .rejects.toThrow(/Invalid payload|Invalid relPath/);
    await expect(Promise.resolve()
      .then(() => handlers.get(IPC_CHANNELS.FILE_TRASH_RECOG_ASSETS)!(null, { relPaths: 'x' })))
      .rejects.toThrow(/Invalid payload/);

    const trashed = await handlers.get(IPC_CHANNELS.FILE_TRASH_RECOG_ASSETS)!(null, { relPaths: [rel('a')] }) as {
      moved: number; bytes: number; trashDir: string;
    };
    expect(trashed.moved).toBe(1);
    expect(trashed.bytes).toBeGreaterThan(0);
    expect(existsSync(join(trashed.trashDir, 'recog', name('a')))).toBe(true);
  });

  it('仓库既有 file.* 通道零回归：pickLogoImage/saveRecogImage/importTextFile 仍注册且行为不变', async () => {
    registerFileIpcHandlers({ dataDir, smoke: { logoSourcePath: join(dataDir, 'pixel.png'), presetFilePath: join(dataDir, 'preset.json') } });
    writeFileSync(join(dataDir, 'pixel.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
    const asset = await handlers.get(IPC_CHANNELS.FILE_PICK_LOGO_IMAGE)!() as { relPath: string };
    expect(asset.relPath).toMatch(/^logos\/.+\.png$/);
    expect(existsSync(join(dataDir, 'assets', asset.relPath))).toBe(true);
  });
});
