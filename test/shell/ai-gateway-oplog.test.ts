// 0037 P1：ai.invoke 成功调用写 operation_log 留痕（任务书 §一 P1：写入点在 shell/ai，
// 主进程直调 bank service，不经 IPC；零新表）。断言：
// - operation_type='ai.invoke'，status 经 logStart→logSuccess 落 'succeeded'
// - metadata：role / 模型档案名 / model / latencyMs；tokens 仅 provider 返回 usage 时携带
// - 失败调用（ok:false）不写留痕；留痕写库失败不影响调用结果（吞错不炸调用）
// - 跨层咬合：真 OperationLogger（真 SQLite）落行后，getHomeDashboard 聚合可见

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MachineKeyVault } from '../../src/shell/ai/key-vault.js';
import { AiGateway } from '../../src/shell/ai/ai-gateway.js';
import type { AiInvokeOpLogger } from '../../src/shell/ai/ai-gateway.js';
import { createMockModelProfileService } from '../../src/bank/mock/mock-ai.js';
import { MockBankStore } from '../../src/bank/mock/mock-store.js';
import { openDatabase, type Database } from '../../src/bank/db.js';
import { OperationLogger } from '../../src/bank/operation-log.js';
import { getHomeDashboard } from '../../src/bank/dashboard-service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '../../src/bank/migrations');
const FAKE_KEY = 'sk-fake-test-key-0037';

// ---------------- 本地 OpenAI 兼容 mock（同 0023 网关测试形态） ----------------

interface MockServer {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

function startMockServer(responder: () => { status: number; payload: unknown }): Promise<MockServer> {
  const server = createServer((req: IncomingMessage, res) => {
    req.resume();
    req.on('end', () => {
      const { status, payload } = responder();
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = status;
      res.end(JSON.stringify(payload));
    });
  });
  const close = () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port, close }));
  });
}

const okPayload = (content: string, withUsage = true) => ({
  status: 200,
  payload: {
    choices: [{ message: { content } }],
    ...(withUsage ? { usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } } : {}),
  },
});

// ---------------- 留痕 fake ----------------

interface LoggedCall {
  op: 'start' | 'success';
  operationType?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  id?: string;
  affectedCount?: number;
}

function makeFakeLogger(): { logger: AiInvokeOpLogger; calls: LoggedCall[] } {
  const calls: LoggedCall[] = [];
  return {
    calls,
    logger: {
      logStart(operationType: string, description: string, metadata: Record<string, unknown> = {}) {
        calls.push({ op: 'start', operationType, description, metadata: { ...metadata } });
        return 'log-id-0037';
      },
      logSuccess(id: string, affectedCount: number) {
        calls.push({ op: 'success', id, affectedCount });
      },
    },
  };
}

interface GwCtx {
  gw: AiGateway;
  close: () => Promise<void>;
}

async function makeGateway(
  responder: () => { status: number; payload: unknown },
  logger?: AiInvokeOpLogger,
): Promise<GwCtx> {
  const ms = await startMockServer(responder);
  const store = new MockBankStore();
  const gw = new AiGateway({
    profiles: createMockModelProfileService(store),
    vault: new MachineKeyVault(),
    ...(logger ? { opLogger: logger } : {}),
  });
  const p = await gw.createProfile({
    data: { role: 'reasoning', name: 'R1-档案', provider: 'sf', baseUrl: `http://127.0.0.1:${ms.port}/v1`, model: 'test-model', apiKey: FAKE_KEY },
  });
  await gw.testConnection({ profileId: p.id });
  await gw.setEnabled({ id: p.id, enabled: true });
  return { gw, close: ms.close };
}

afterEach(() => { /* 各用例自管 close */ });

describe('0037 P1：ai.invoke 成功留痕（operation_log 复用，写入点 shell/ai）', () => {
  it('成功调用 → logStart+logSuccess 各一次：type=ai.invoke，metadata 带 role/档案名/model/耗时/tokens', async () => {
    const { logger, calls } = makeFakeLogger();
    const { gw, close } = await makeGateway(() => okPayload('pong'), logger);
    try {
      const result = await gw.invoke({ role: 'reasoning', messages: [{ role: 'user', content: '你好' }] });
      expect(result.ok).toBe(true);

      expect(calls).toHaveLength(2);
      const start = calls[0]!;
      expect(start.op).toBe('start');
      expect(start.operationType).toBe('ai.invoke');
      expect(start.metadata).toBeTruthy();
      expect(start.metadata!.role).toBe('reasoning');
      expect(start.metadata!.profileName).toBe('R1-档案');
      expect(start.metadata!.model).toBe('test-model');
      expect(typeof start.metadata!.latencyMs).toBe('number');
      // provider 返回了 usage → tokens 原样入 metadata
      expect(start.metadata!.tokens).toEqual({ promptTokens: 5, completionTokens: 2, totalTokens: 7 });
      // start 在前，success 在后且指向同一条留痕
      const success = calls[1]!;
      expect(success.op).toBe('success');
      expect(success.id).toBe('log-id-0037');
    } finally {
      await close();
    }
  });

  it('provider 未返回 usage → metadata 不带 tokens 键（不计入口径）', async () => {
    const { logger, calls } = makeFakeLogger();
    const { gw, close } = await makeGateway(() => okPayload('pong', false), logger);
    try {
      const result = await gw.invoke({ role: 'reasoning', messages: [{ role: 'user', content: '你好' }] });
      expect(result.ok).toBe(true);
      expect(calls).toHaveLength(2);
      expect(calls[0]!.metadata).toBeTruthy();
      expect('tokens' in calls[0]!.metadata!).toBe(false);
    } finally {
      await close();
    }
  });

  it('失败调用（ok:false 结果形态）→ 零留痕', async () => {
    const { logger, calls } = makeFakeLogger();
    // P-18：启用需先通过测连通 → mock 第 1 次（测连通）成功、其后（invoke）失败
    let httpCalls = 0;
    const { gw, close } = await makeGateway(
      () => (++httpCalls === 1 ? okPayload('pong') : { status: 500, payload: { error: { message: 'boom' } } }),
      logger,
    );
    try {
      const result = await gw.invoke({ role: 'reasoning', messages: [{ role: 'user', content: '你好' }] });
      expect(result.ok).toBe(false);
      expect(calls).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it('留痕写库失败不影响调用结果（吞错，invoke 仍 ok:true）', async () => {
    const throwingLogger: AiInvokeOpLogger = {
      logStart: () => { throw new Error('log write failed'); },
      logSuccess: () => { throw new Error('log write failed'); },
    };
    const { gw, close } = await makeGateway(() => okPayload('pong'), throwingLogger);
    try {
      const result = await gw.invoke({ role: 'reasoning', messages: [{ role: 'user', content: '你好' }] });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.content).toBe('pong');
    } finally {
      await close();
    }
  });

  it('跨层咬合：真库留痕 → operation_log 落 succeeded 行 → getHomeDashboard 聚合可见', async () => {
    const ms = await startMockServer(() => okPayload('pong'));
    const tempDir = mkdtempSync(join(tmpdir(), 'dash-0037-gw-'));
    const db: Database = openDatabase(join(tempDir, 'test.db'), migrationsDir);
    try {
      const store = new MockBankStore();
      const gw = new AiGateway({
        profiles: createMockModelProfileService(store),
        vault: new MachineKeyVault(),
        opLogger: new OperationLogger(db),
      });
      const p = await gw.createProfile({
        data: { role: 'reasoning', name: 'R-真库', provider: 'sf', baseUrl: `http://127.0.0.1:${ms.port}/v1`, model: 'test-model', apiKey: FAKE_KEY },
      });
      await gw.testConnection({ profileId: p.id });
      await gw.setEnabled({ id: p.id, enabled: true });

      const result = await gw.invoke({ role: 'reasoning', messages: [{ role: 'user', content: '你好' }] });
      expect(result.ok).toBe(true);

      const row = db.prepare(
        `SELECT operation_type, status, metadata_json FROM operation_log WHERE operation_type='ai.invoke'`,
      ).get() as { operation_type: string; status: string; metadata_json: string } | undefined;
      expect(row, 'operation_log 未落 ai.invoke 留痕').toBeTruthy();
      expect(row!.status).toBe('succeeded');
      const meta = JSON.parse(row!.metadata_json) as { role?: string; profileName?: string; model?: string; tokens?: { totalTokens?: number } };
      expect(meta.role).toBe('reasoning');
      expect(meta.profileName).toBe('R-真库');
      expect(meta.model).toBe('test-model');
      expect(meta.tokens?.totalTokens).toBe(7);

      const dash = getHomeDashboard(db, new Date());
      expect(dash.aiInvocations).toBe(1);
      expect(dash.aiTokens).toBe(7);
      expect(dash.aiDaily.reduce((s, b) => s + b.count, 0)).toBe(1);
    } finally {
      db.close();
      rmSync(tempDir, { recursive: true, force: true });
      await ms.close();
    }
  });
});
