// 0046 P5.1：recog.draft.write 宿主 + 通道 handler 测试（P6.3 换档落地）。
// - RecogHost.draftWrite（真文件系统 tmp 隔离）：Onestep 草稿 → 转换 → drafts.json 落盘
//   → run 状态同步 done + warnings 回写（否则 run 永停 queued，历史 pill 骗人）
// - 写回后 recog.status 读出 drafts（#/proof/<runId> 呈现层零改动的读口）
// - 通道注册 / 通道名逐字 / payload 形验 / 透传

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

import { RecogHost } from '../../src/shell/recog/recog-host.js';
import { registerRecogIpcHandlers } from '../../src/shell/ipc.js';
import { IPC_CHANNELS } from '../../src/shared/contracts/ipc-channels.js';
import { DRAFTS_REL, readDraftsFile } from '../../src/recog/runs/fs-store.js';
import type { RecogDraftWritePayload } from '../../src/shared/contracts/recog-run-types.js';
import type { RecogEventPayload, RecogRun, RecogRunService, RecogRunStatus, RecogRunStage } from '../../src/shared/contracts/recog-run-types.js';
import type { OnestepDraft } from '../../src/shared/contracts/onestep-types.js';

const NOW = '2026-09-22T10:00:00.000Z';
const RUN_ID = 'run-0046';

interface StatusCalls { status: RecogRunStatus; stage: RecogRunStage }
interface ServiceSpy {
  setStatusCalls: StatusCalls[];
  warningCalls: string[][];
}

function makeRunsService(runId: string, spy: ServiceSpy): RecogRunService {
  const run: RecogRun = {
    id: runId, status: 'queued', stage: 'queued', sourceKind: 'image', sourceName: '整卷.pdf',
    pageCount: 1, pagesDone: 0, error: null, warnings: [], questionIds: [],
    createdAt: NOW, updatedAt: NOW, finishedAt: null,
  };
  return {
    createRun: async () => run,
    getRun: async (id) => (id === runId ? run : null),
    listRuns: async () => [run],
    setStatus: async (_id, patch) => {
      spy.setStatusCalls.push({ status: patch.status, stage: patch.stage ?? patch.status });
      return run;
    },
    listPages: async () => [],
    markPage: async () => undefined,
    setWarnings: async (_id, warnings) => {
      spy.warningCalls.push(warnings);
      return run;
    },
    attachQuestions: async () => run,
  };
}

function onestepDraftOf(over: Partial<OnestepDraft> = {}): OnestepDraft {
  return {
    qno: '5',
    questionType: '填空',
    stemMarkdown: '求 $F_\\text{浮}$。',
    options: null,
    answerMarkdown: '10N',
    analysisMarkdown: null,
    suggestedTags: [],
    figures: [],
    figureSource: 'none',
    warnings: ['图块来源 none'],
    ...over,
  };
}

let root = '';
let host: RecogHost;
let spy: ServiceSpy;

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`通道未注册: ${channel}`);
  return fn(null, ...args) as Promise<unknown>;
}

beforeEach(() => {
  handlers.clear();
  root = mkdtempSync(join(tmpdir(), 'mofang-0046-host-'));
  spy = { setStatusCalls: [], warningCalls: [] };
  host = new RecogHost({
    runs: makeRunsService(RUN_ID, spy),
    invoke: async () => ({ ok: false, error: '未脚本化', latencyMs: 0 }),
    runsRoot: root,
    broadcast: () => undefined,
    now: () => NOW,
  });
});

afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('0046 P5.1：RecogHost.draftWrite', () => {
  it('写回 → drafts.json 落盘（字节可读、字段齐备）；qno 降级 2-17 → null', async () => {
    const payload: RecogDraftWritePayload = {
      runId: RUN_ID,
      drafts: [onestepDraftOf(), onestepDraftOf({ qno: '2-17', stemMarkdown: '第二题。' })],
    };
    const result = await host.draftWrite(payload);
    expect(result.draftCount).toBe(2);

    const runDir = join(root, RUN_ID);
    expect(existsSync(join(runDir, DRAFTS_REL))).toBe(true);
    const file = readDraftsFile(runDir);
    expect(file).toBeTruthy();
    expect(file!.drafts).toHaveLength(2);
    expect(file!.drafts[0]!.qno).toBe(5);
    expect(file!.drafts[1]!.qno).toBeNull();
    expect(file!.drafts[0]!.contentHtml).toContain('data-tex');
    expect(JSON.parse(readFileSync(join(runDir, DRAFTS_REL), 'utf8'))).toBeTruthy();
  });

  it('状态同步：setStatus 走合法迁移链（error → ocr → ai → done）+ setWarnings 回写', async () => {
    // 前置把 run 落成 error（探针/真实场景：createRun 后台管线失败）——用真迁移语义的桩
    const chain: RecogRunStatus[] = [];
    const errorRun = makeRunsService(RUN_ID, spy);
    const localHost = new RecogHost({
      runs: {
        ...errorRun,
        getRun: async () => ({ ...(await errorRun.getRun(RUN_ID))!, status: 'error' as RecogRunStatus, stage: 'error' as RecogRunStage }),
        setStatus: async (_id, patch) => { chain.push(patch.status); return errorRun.getRun(RUN_ID) as Promise<RecogRun>; },
      },
      invoke: async () => ({ ok: false, error: 'x', latencyMs: 0 }),
      runsRoot: root,
      broadcast: () => undefined,
      now: () => NOW,
    });
    await localHost.draftWrite({ runId: RUN_ID, drafts: [onestepDraftOf()] });
    expect(chain).toEqual(['ocr', 'ai', 'done']);
    expect(spy.warningCalls.at(-1)).toContain('图块来源 none');
  });

  it('状态同步：已 done 的 run 幂等（不再空转迁移）', async () => {
    const chain: RecogRunStatus[] = [];
    const localHost = new RecogHost({
      runs: {
        ...makeRunsService(RUN_ID, spy),
        getRun: async () => ({ ...(await makeRunsService(RUN_ID, spy).getRun(RUN_ID))!, status: 'done' as RecogRunStatus, stage: 'done' as RecogRunStage }),
        setStatus: async (_id, patch) => { chain.push(patch.status); return null as unknown as RecogRun; },
      },
      invoke: async () => ({ ok: false, error: 'x', latencyMs: 0 }),
      runsRoot: root,
      broadcast: () => undefined,
      now: () => NOW,
    });
    await localHost.draftWrite({ runId: RUN_ID, drafts: [onestepDraftOf()] });
    expect(chain).toEqual([]);
  });

  it('写回后 recog.status 读出 drafts（#/proof/<runId> 读口；0036 呈现层零改动）', async () => {
    await host.draftWrite({ runId: RUN_ID, drafts: [onestepDraftOf({ qno: null })] });
    const detail = await host.status(RUN_ID);
    expect(detail.drafts).toHaveLength(1);
    expect(detail.drafts[0]!.qno).toBeNull();
  });

  it('未知 run → 拒绝（不静默建目录）', async () => {
    await expect(host.draftWrite({ runId: 'nope', drafts: [onestepDraftOf()] })).rejects.toThrow(/不存在/);
  });
});

describe('0046 P5.1：recog.draft.write 通道', () => {
  it('通道名逐字 + 注册即达；合法 payload 透传 host.draftWrite', async () => {
    expect(IPC_CHANNELS.RECOG_DRAFT_WRITE).toBe('recog.draft.write');
    registerRecogIpcHandlers(() => host);
    const payload = { runId: RUN_ID, drafts: [onestepDraftOf()] };
    await invoke(IPC_CHANNELS.RECOG_DRAFT_WRITE, payload);
    expect(handlers.has(IPC_CHANNELS.RECOG_DRAFT_WRITE)).toBe(true);
  });

  it('注册时机：注册前 invoke → 通道未注册（不静默吞）', async () => {
    expect(handlers.has(IPC_CHANNELS.RECOG_DRAFT_WRITE)).toBe(false);
  });

  it('payload 形验：缺 runId / drafts 缺失或非数组 → 拒绝且不触 host', async () => {
    const spy2: ServiceSpy = { setStatusCalls: [], warningCalls: [] };
    const localHost = new RecogHost({
      runs: makeRunsService(RUN_ID, spy2),
      invoke: async () => ({ ok: false, error: 'x', latencyMs: 0 }),
      runsRoot: root,
      broadcast: () => undefined,
      now: () => NOW,
    });
    const draftWrite = vi.spyOn(localHost, 'draftWrite');
    registerRecogIpcHandlers(() => localHost);
    await expect(invoke(IPC_CHANNELS.RECOG_DRAFT_WRITE, {})).rejects.toThrow(/runId/);
    await expect(invoke(IPC_CHANNELS.RECOG_DRAFT_WRITE, { runId: RUN_ID })).rejects.toThrow(/drafts/);
    await expect(invoke(IPC_CHANNELS.RECOG_DRAFT_WRITE, { runId: RUN_ID, drafts: 'x' })).rejects.toThrow(/drafts/);
    await expect(invoke(IPC_CHANNELS.RECOG_DRAFT_WRITE, { runId: RUN_ID, drafts: [5] })).rejects.toThrow(/drafts\[0\]/);
    expect(draftWrite).not.toHaveBeenCalled();
  });

  it('合法透传：host.draftWrite 收到原 payload', async () => {
    registerRecogIpcHandlers(() => host);
    const payload: RecogDraftWritePayload = { runId: RUN_ID, drafts: [onestepDraftOf()] };
    await invoke(IPC_CHANNELS.RECOG_DRAFT_WRITE, payload);
    const file = readDraftsFile(join(root, RUN_ID));
    expect(file?.drafts).toHaveLength(1);
  });
});
