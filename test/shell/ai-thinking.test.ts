// 0040 P1 规则⑥：ai.invoke 思考开关透传与降级（不外溢到其它失败语义）。
// - thinking 透传到 wire 请求体顶层 `{"thinking":{"type":…}}`（deepseek-flash/mimo 实测口径）
// - 供应商不识别该参数（400/422 且报文点名 thinking）→ 省略该参数重试一次，降级不报错
// - 非 thinking 类 400 不触发省略重试（不许把参数错误当服务抖动乱重试）

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import { AddressInfo } from 'node:net';

import { AiGateway } from '../../src/shell/ai/ai-gateway.js';
import { MachineKeyVault } from '../../src/shell/ai/key-vault.js';
import { createMockModelProfileService } from '../../src/bank/mock/mock-ai.js';
import { MockBankStore } from '../../src/bank/mock/mock-store.js';
import { AiHttpError, isUnsupportedThinkingError } from '../../src/shell/ai/proxy.js';
import type { ModelProfileService } from '../../src/shared/contracts/ai-types.js';

const FAKE_KEY = 'sk-fake-thinking-key-0040';

interface SeenRequest {
  url: string;
  body: { model: string; thinking?: { type?: string }; enable_thinking?: boolean; max_tokens?: number };
}

function startMockServer(responder: (seen: SeenRequest, index: number) => { status: number; payload: unknown }) {
  const seen: SeenRequest[] = [];
  const server: Server = createServer((req: IncomingMessage, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => { raw += c.toString('utf8'); });
    req.on('end', () => {
      const record: SeenRequest = { url: req.url ?? '', body: raw ? JSON.parse(raw) as SeenRequest['body'] : { model: '' } };
      const { status, payload } = responder(record, seen.length);
      seen.push(record);
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = status;
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise<{ seen: SeenRequest[]; port: number; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        seen,
        port: (server.address() as AddressInfo).port,
        close: () => new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))),
      });
    });
  });
}

const ok = (content = '{"questions":[]}') => ({
  status: 200,
  payload: { choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
});

afterEach(() => { vi.restoreAllMocks(); });

describe('0040 P1：thinking 透传', () => {
  it("thinking='disabled' → wire 顶层 thinking.type='disabled'；缺省则不发该字段", async () => {
    const mock = await startMockServer(() => ok());
    try {
      const gw = await gatewayTo(mock.port, 'deepseek-flash');
      await gw.invoke({ role: 'vision', messages: [{ role: 'user', content: 'hi' }], thinking: 'disabled' });
      await gw.invoke({ role: 'vision', messages: [{ role: 'user', content: 'hi' }], thinking: 'enabled' });
      await gw.invoke({ role: 'vision', messages: [{ role: 'user', content: 'hi' }] });

      expect(mock.seen[0]!.body.thinking).toEqual({ type: 'disabled' });
      expect(mock.seen[1]!.body.thinking).toEqual({ type: 'enabled' });
      expect(mock.seen[2]!.body.thinking).toBeUndefined();
    } finally {
      await mock.close();
    }
  });
});

/** 建一个「已启用 + 有 Key」的 vision 档案并返回网关（三条阶梯用例共用） */
async function gatewayTo(port: number, model = 'm'): Promise<AiGateway> {
  const svc = createMockModelProfileService(new MockBankStore());
  const profile = await svc.createProfile({
    role: 'vision', name: 'VLM', provider: 'mock', baseUrl: `http://127.0.0.1:${port}/v1`, model,
  });
  await createProfileWithKey(svc, profile.id);
  await svc.recordTestResult(profile.id, true, new Date().toISOString());
  await svc.setProfileEnabled(profile.id, true);
  return new AiGateway({ profiles: svc, vault: new MachineKeyVault() });
}

async function createProfileWithKey(svc: ModelProfileService, id: string): Promise<void> {
  await svc.updateProfile(id, { keyEncrypted: await new MachineKeyVault().encrypt(FAKE_KEY) });
}

describe('0040 P1：不识别 thinking 的供应商降级（规则⑥「不识别的供应商自动省略」）', () => {
  it('首次 400 点名 thinking → 自动省略该参数重试一次并成功（不占 retries 配额）', async () => {
    const mock = await startMockServer((seen) =>
      seen.body.thinking
        ? { status: 400, payload: { error: { message: 'Unrecognized field: thinking' } } }
        : ok('{"questions":[{"qno":"1"}]}'),
    );
    try {
      const gw = await gatewayTo(mock.port, 'unknown-provider');
      const result = await gw.invoke({
        role: 'vision', messages: [{ role: 'user', content: 'hi' }], thinking: 'disabled', retries: 0,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.content).toContain('questions');
      expect(mock.seen).toHaveLength(2);
      expect(mock.seen[0]!.body.thinking).toEqual({ type: 'disabled' });
      expect(mock.seen[1]!.body.thinking).toBeUndefined();
    } finally {
      await mock.close();
    }
  });

  it('非 thinking 类 400 → 不触发省略重试（保持原失败语义）', async () => {
    const mock = await startMockServer(() => ({ status: 400, payload: { error: { message: 'model not found' } } }));
    try {
      const gw = await gatewayTo(mock.port);
      const result = await gw.invoke({
        role: 'vision', messages: [{ role: 'user', content: 'hi' }], thinking: 'disabled', retries: 0,
      });
      expect(result.ok).toBe(false);
      expect(mock.seen).toHaveLength(1);
    } finally {
      await mock.close();
    }
  });

  it('用户实测报错（enable_thinking 不支持）→ 换 `enable_thinking` 形态重试并成功', async () => {
    // 案底（2026-09-19 用户实测）：SiliconFlow 某模型回
    //   HTTP 400 {"code":20015,"message":"Value error, current model does not support parameter `enable_thinking`."}
    // 原判据 thinking 匹配不到 `enable_thinking`（`_` 是单词字符，没有词边界）→ 未降级、错误直冒到界面。
    const mock = await startMockServer((seen) => {
      if (seen.body.thinking) {
        return { status: 400, payload: { code: 20015, message: 'Value error, current model does not support parameter `enable_thinking`.' } };
      }
      if (seen.body.enable_thinking !== undefined) {
        return { status: 400, payload: { code: 20015, message: 'Value error, current model does not support parameter `enable_thinking`.' } };
      }
      return ok('{"questions":[]}');
    });
    try {
      const gw = await gatewayTo(mock.port);
      const result = await gw.invoke({ role: 'vision', messages: [{ role: 'user', content: 'hi' }], thinking: 'disabled', retries: 0 });
      expect(result.ok).toBe(true);
      expect(mock.seen).toHaveLength(3);
      expect(mock.seen[0]!.body.thinking).toEqual({ type: 'disabled' });
      expect(mock.seen[1]!.body.enable_thinking).toBe(false);
      expect(mock.seen[2]!.body.thinking).toBeUndefined();
      expect(mock.seen[2]!.body.enable_thinking).toBeUndefined();
    } finally {
      await mock.close();
    }
  });

  it('阶梯只走一次：换到 enable_thinking 即成 → 不再试第三格', async () => {
    const mock = await startMockServer((seen) =>
      seen.body.thinking
        ? { status: 400, payload: { message: 'current model does not support parameter `thinking`' } }
        : ok('{"questions":[]}'),
    );
    try {
      const gw = await gatewayTo(mock.port);
      const result = await gw.invoke({ role: 'vision', messages: [{ role: 'user', content: 'hi' }], thinking: 'disabled', retries: 0 });
      expect(result.ok).toBe(true);
      expect(mock.seen).toHaveLength(2);
      expect(mock.seen[1]!.body.enable_thinking).toBe(false);
      expect(mock.seen[1]!.body.thinking).toBeUndefined();
    } finally {
      await mock.close();
    }
  });

  it('用户实测报错（token 超过上限）→ 丢掉 max_tokens 重试并成功', async () => {
    // 案底（2026-09-19 用户实测第二轮）：思考模型关不掉思考 → 正文吐空 → 上层提预算到 16384
    // → 供应商回「token 超过上限」→ 原实现把 400 直接抛给用户。修法：丢 max_tokens 走供应商默认。
    const mock = await startMockServer((seen) =>
      seen.body.max_tokens && seen.body.max_tokens > 8192
        ? { status: 400, payload: { code: 20012, message: 'max_tokens is too large: this model supports at most 8192 tokens' } }
        : ok('{"questions":[]}'),
    );
    try {
      const gw = await gatewayTo(mock.port);
      const result = await gw.invoke({ role: 'vision', messages: [{ role: 'user', content: 'hi' }], maxTokens: 16384, retries: 0 });
      expect(result.ok).toBe(true);
      expect(mock.seen).toHaveLength(2);
      expect(mock.seen[0]!.body.max_tokens).toBe(16384);
      expect(mock.seen[1]!.body.max_tokens).toBeUndefined();
    } finally {
      await mock.close();
    }
  });

  it('中文口径的 token 上限报错同样识别（「token 超过上限」）', async () => {
    const mock = await startMockServer((seen) =>
      seen.body.max_tokens ? { status: 400, payload: { message: 'max_tokens token 超过上限' } } : ok('{"questions":[]}'),
    );
    try {
      const gw = await gatewayTo(mock.port);
      const result = await gw.invoke({ role: 'vision', messages: [{ role: 'user', content: 'hi' }], maxTokens: 16384, retries: 0 });
      expect(result.ok).toBe(true);
      expect(mock.seen[1]!.body.max_tokens).toBeUndefined();
    } finally {
      await mock.close();
    }
  });

  it('判据：单词边界不再是坑（`enable_thinking` 必须命中；不含 thinking 的 400 不命中）', () => {
    expect(isUnsupportedThinkingError(new AiHttpError(400, 'HTTP 400：Value error, current model does not support parameter `enable_thinking`.'))).toBe(true);
    expect(isUnsupportedThinkingError(new AiHttpError(400, 'HTTP 400：unknown field thinking'))).toBe(true);
    expect(isUnsupportedThinkingError(new AiHttpError(400, 'HTTP 400：model not found'))).toBe(false);
    expect(isUnsupportedThinkingError(new AiHttpError(500, 'HTTP 500：thinking overloaded'))).toBe(false);
  });

  it('判据只认 400/422 且报文点名 thinking（构造注入，防误伤）', () => {
    const httpError = (status: number, message: string) => new AiHttpError(status, message);
    expect(isUnsupportedThinkingError(httpError(400, 'HTTP 400：Unrecognized field: thinking'))).toBe(true);
    expect(isUnsupportedThinkingError(httpError(422, 'HTTP 422：unknown parameter thinking'))).toBe(true);
    expect(isUnsupportedThinkingError(httpError(400, 'HTTP 400：model not found'))).toBe(false);
    expect(isUnsupportedThinkingError(httpError(500, 'HTTP 500：thinking server error'))).toBe(false);
    expect(isUnsupportedThinkingError(new Error('网络错误：fetch failed'))).toBe(false);
  });
});
