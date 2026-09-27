// 0023 P2：shell 侧 AI 网关测试 — Key 托管（machine-key 回退形态）、ai.invoke 代理（本地 mock HTTP）、
// 测连通（文本短请求 / 视觉必发随包小图）、payload 三分支校验、错误信息不带回 Key（构造注入）。
// 任务书 §一 P2 / §四；D-043（Key 三不进）/ D-044（safeStorage，否 keytar）。

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MachineKeyVault } from '../../src/shell/ai/key-vault.js';
import { AiGateway } from '../../src/shell/ai/ai-gateway.js';
import { createDefaultKeyVault } from '../../src/shell/ai/dpapi-vault.js';
import { createMockModelProfileService } from '../../src/bank/mock/mock-ai.js';
import { MockBankStore } from '../../src/bank/mock/mock-store.js';
import type { ModelProfileService } from '../../src/shared/contracts/ai-types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const TEST_IMAGE = join(REPO_ROOT, 'build', 'ai-test-image.png');

/** 假 Key（仅测试内存；三不进 git/日志/返回值） */
const FAKE_KEY = 'sk-fake-test-key-0023';

// ---------------- 测试用本地 OpenAI 兼容 mock 服务 ----------------

interface SeenRequest {
  url: string;
  auth: string | undefined;
  body: {
    model: string;
    messages: Array<{ role: string; content: unknown }>;
    max_tokens?: number;
    temperature?: number;
  };
}

type Responder = (seen: Omit<SeenRequest, never>) => { status: number; payload: unknown };

function startMockServer(responder: Responder): Promise<{ server: Server; port: number; seen: SeenRequest[]; close: () => Promise<void> }> {
  const seen: SeenRequest[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => { raw += c.toString('utf8'); });
    req.on('end', () => {
      const record: SeenRequest = {
        url: req.url ?? '',
        auth: req.headers.authorization,
        body: raw ? JSON.parse(raw) : {},
      };
      seen.push(record);
      const { status, payload } = responder(record);
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = status;
      res.end(JSON.stringify(payload));
    });
  });
  const close = () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as AddressInfo).port, seen, close });
    });
  });
}

interface GwCtx {
  svc: ModelProfileService;
  gw: AiGateway;
  cleanup: () => void;
}

function makeGateway(testImagePath: string | null = TEST_IMAGE): GwCtx {
  const store = new MockBankStore();
  const svc = createMockModelProfileService(store);
  const gw = new AiGateway({ profiles: svc, vault: new MachineKeyVault(), testImagePath: testImagePath ?? undefined });
  return { svc, gw, cleanup: () => {} };
}

const okPayload = (content: string) => ({
  status: 200,
  payload: {
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
  },
});

afterEach(() => { vi.restoreAllMocks(); });

// ==================== Key 托管：machine-key 回退形态（纯 Node 可测） ====================

describe('0023 P2 MachineKeyVault（safeStorage 不可用回退形态）', () => {
  it('encrypt 产出 mkey:v1: 前缀密文；decrypt 原样还原；同明文两次密文不同（随机 salt/iv）', async () => {
    const vault = new MachineKeyVault();
    const stored = await vault.encrypt(FAKE_KEY);
    expect(stored.startsWith('mkey:v1:')).toBe(true);
    expect(stored).not.toContain(FAKE_KEY); // 密文形态不含明文

    const stored2 = await vault.encrypt(FAKE_KEY);
    expect(stored2).not.toBe(stored); // 随机 salt/iv → 密文不重样

    expect(await vault.decrypt(stored)).toBe(FAKE_KEY);
    expect(await vault.decrypt(stored2)).toBe(FAKE_KEY);
  });

  it('decrypt 无法识别的前缀 → 明确报错（不静默）', async () => {
    const vault = new MachineKeyVault();
    await expect(vault.decrypt('unknown:v1:QUJD')).rejects.toThrow(/无法识别/);
  });
});

// ==================== dpapi 形态 + 工厂（vi.mock electron safeStorage） ====================

const safeStorageMock = vi.hoisted(() => ({
  available: true,
  calls: [] as Array<{ op: string; arg?: unknown }>,
}));

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => safeStorageMock.available,
    encryptString: (plain: string) => {
      safeStorageMock.calls.push({ op: 'encrypt', arg: plain });
      return Buffer.from(`DPAPI(${plain})`, 'utf8');
    },
    decryptString: (buf: Buffer) => {
      safeStorageMock.calls.push({ op: 'decrypt' });
      const m = /DPAPI\((.*)\)/s.exec(buf.toString('utf8'));
      if (!m) throw new Error('bad dpapi buffer');
      return m[1]!;
    },
  },
}));

describe('0023 P2 dpapi 形态与默认工厂（D-044：safeStorage 优先）', () => {
  it('dpapi 加密走 safeStorage（dpapi:v1: 前缀）并原样解密', async () => {
    const { DpapiKeyVault } = await import('../../src/shell/ai/dpapi-vault.js');
    const vault = new DpapiKeyVault();
    const stored = await vault.encrypt(FAKE_KEY);
    expect(stored.startsWith('dpapi:v1:')).toBe(true);
    expect(await vault.decrypt(stored)).toBe(FAKE_KEY);
    expect(safeStorageMock.calls.some((c) => c.op === 'encrypt')).toBe(true);
  });

  it('工厂：isEncryptionAvailable()=true → dpapi；false → 机器密钥回退（两形态对 service 透明）', async () => {
    safeStorageMock.available = true;
    expect(createDefaultKeyVault().kind).toBe('dpapi');
    safeStorageMock.available = false;
    expect(createDefaultKeyVault().kind).toBe('machine-key');
    safeStorageMock.available = true;
  });
});

// ==================== ai.invoke：三分支 payload 校验 + 代理行为 ====================

describe('0023 P2 ai.invoke 三分支 payload 校验（任务书 §四）', () => {
  it('分支一：缺 role（或非法 role）→ 拒绝且报错指明 role', async () => {
    const { gw } = makeGateway();
    await expect(gw.invoke({ messages: [{ role: 'user', content: 'hi' }] } as Parameters<AiGateway['invoke']>[0]))
      .rejects.toThrow(/role/);
    await expect(gw.invoke({ role: 'chat' as never, messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toThrow(/role/);
  });

  it('分支二：该角色无启用档案 → 拒绝且报错指明未配置', async () => {
    const { gw } = makeGateway();
    await expect(gw.invoke({ role: 'reasoning', messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toThrow(/未配置启用/);
  });

  it('分支三：启用档案协议非 openai-chat（R5 配置位）→ 拒绝且报错指明协议未实现', async () => {
    const { svc, gw } = makeGateway();
    const p = await svc.createProfile({
      role: 'specialty', name: 'R5', provider: 'x', baseUrl: 'https://x.example/v1',
      model: 'm', protocol: 'http-custom',
      keyEncrypted: 'dpapi:v1:QUJD',
    });
    await svc.recordTestResult(p.id, true, '2026-09-17T00:00:00Z');
    await svc.setProfileEnabled(p.id, true);

    await expect(gw.invoke({ role: 'specialty', messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toThrow(/协议.*尚未实现/);
  });
});

describe('0023 P2 ai.invoke 代理行为（本地 mock OpenAI 服务）', () => {
  it('带出正确 base_url/model/Authorization；返回 content/latency/usage', async () => {
    const { server, port, seen, close } = await startMockServer(() => okPayload('pong'));
    const { gw } = makeGateway();
    try {
      const p = await gw.createProfile({
        data: { role: 'reasoning', name: 'R1', provider: 'sf', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'test-model', apiKey: FAKE_KEY },
      });
      await gw.testConnection({ profileId: p.id });
      await gw.setEnabled({ id: p.id, enabled: true });

      const result = await gw.invoke({ role: 'reasoning', messages: [{ role: 'user', content: '你好' }] });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.content).toBe('pong');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.usage).toEqual({ promptTokens: 5, completionTokens: 2, totalTokens: 7 });

      expect(seen).toHaveLength(2); // testConnection + invoke
      expect(seen[0]!.url).toBe('/v1/chat/completions');
      expect(seen[0]!.auth).toBe(`Bearer ${FAKE_KEY}`);
      expect(seen[0]!.body.model).toBe('test-model');
      expect(seen[0]!.body.messages[0]!.role).toBe('user');
    } finally {
      await close();
      void server;
    }
  });

  it('vision 消息形态：text/image_url 分片映射为 wire 格式 image_url.url', async () => {
    const { port, seen, close } = await startMockServer(() => okPayload('看到图了'));
    const { gw } = makeGateway();
    try {
      const p = await gw.createProfile({
        data: { role: 'vision', name: 'R2', provider: 'sf', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'vl-model', apiKey: FAKE_KEY },
      });
      await gw.testConnection({ profileId: p.id });
      await gw.setEnabled({ id: p.id, enabled: true });

      const result = await gw.invoke({
        role: 'vision',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '图中文字？' },
            { type: 'image_url', imageUrl: { url: 'data:image/png;base64,aGVsbG8=' } },
          ],
        }],
      });
      expect(result.ok).toBe(true);

      const wireContent = seen[1]!.body.messages[0]!.content as Array<{ type: string; image_url?: { url: string } }>;
      expect(Array.isArray(wireContent)).toBe(true);
      expect(wireContent[0]!.type).toBe('text');
      expect(wireContent[1]!.type).toBe('image_url');
      expect(wireContent[1]!.image_url!.url).toBe('data:image/png;base64,aGVsbG8=');
    } finally {
      await close();
    }
  });

  it('HTTP 500 + 响应体回显 Authorization（构造注入）→ 错误信息不包含 Key', async () => {
    const { port, close } = await startMockServer((seen) => ({
      status: 500,
      payload: { error: { message: `bad request auth=${seen.auth} key=${FAKE_KEY}` } },
    }));
    const { svc, gw } = makeGateway();
    try {
      const p = await gw.createProfile({
        data: { role: 'reasoning', name: 'R1', provider: 'sf', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm', apiKey: FAKE_KEY },
      });
      await gw.setEnabled({ id: p.id, enabled: true }).catch(() => undefined); // 未测通会被 P-18 拦——目标仅错误脱敏
      // 直接经 service 造启用态（绕过 P-18 不影响本用例目标：错误脱敏）
      await svc.recordTestResult(p.id, true, '2026-09-17T00:00:00Z');
      await svc.setProfileEnabled(p.id, true);

      const result = await gw.invoke({ role: 'reasoning', messages: [{ role: 'user', content: 'hi' }], retries: 0 });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      // 红线：Key 本体不得出现（回显的 "Bearer ***" 恰是脱敏生效的证明）
      expect(result.error).not.toContain(FAKE_KEY);
      expect(result.error).not.toContain('sk-fake-test-key');
      expect(result.error.length).toBeGreaterThan(0);
    } finally {
      await close();
    }
  });

  it('断网（连接拒绝）→ ok:false 且错误信息不泄露 Key', async () => {
    const { gw, svc } = makeGateway();
    // 先占一个端口再关掉 → 稳定的 connection refused
    const { port, close } = await startMockServer(() => okPayload('x'));
    await close();

    const p = await gw.createProfile({
      data: { role: 'light', name: 'R3', provider: 'sf', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm', apiKey: FAKE_KEY },
    });
    await svc.recordTestResult(p.id, true, '2026-09-17T00:00:00Z');
    await svc.setProfileEnabled(p.id, true);

    const result = await gw.invoke({ role: 'light', messages: [{ role: 'user', content: 'hi' }], retries: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).not.toContain(FAKE_KEY);
  });

  it('超时（timeoutMs 到期无响应）→ ok:false；retries=1 时第二次成功（有限重试）', async () => {
    let attempts = 0;
    let failAll = false;
    const { port, close } = await startMockServer(() => {
      attempts += 1;
      if (failAll || attempts === 1) {
        // 首次：可重试失败（503）；failAll 阶段：恒 503（验证重试上限）
        return { status: 503, payload: { error: { message: 'slow' } } };
      }
      return okPayload('ok-after-retry');
    });
    const { svc, gw } = makeGateway();
    try {
      const p = await gw.createProfile({
        data: { role: 'reasoning', name: 'R1', provider: 'sf', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm', apiKey: FAKE_KEY },
      });
      await svc.recordTestResult(p.id, true, '2026-09-17T00:00:00Z');
      await svc.setProfileEnabled(p.id, true);

      const result = await gw.invoke({ role: 'reasoning', messages: [{ role: 'user', content: 'hi' }], retries: 1 });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.content).toBe('ok-after-retry');
      expect(attempts).toBe(2);

      // retries 上限 2：传 99 也只重试 2 次（恒 503 阶段）
      failAll = true;
      attempts = 0;
      const failAllResult = await gw.invoke({ role: 'reasoning', messages: [{ role: 'user', content: 'hi' }], retries: 99 });
      expect(failAllResult.ok).toBe(false);
      expect(attempts).toBe(3); // 1 次首发 + 2 次重试上限
    } finally {
      await close();
    }
  });

  it('启用档案被清 Key 后 invoke → ok:false 明确报「未配置 API Key」（不静默、不崩）', async () => {
    const { port, close } = await startMockServer(() => okPayload('x'));
    const { svc, gw } = makeGateway();
    try {
      const p = await gw.createProfile({
        data: { role: 'reasoning', name: 'R1', provider: 'sf', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm', apiKey: FAKE_KEY },
      });
      await gw.testConnection({ profileId: p.id });
      await gw.setEnabled({ id: p.id, enabled: true });
      await svc.updateProfile(p.id, { keyEncrypted: null }); // 启用中清 Key（边缘态）

      const result = await gw.invoke({ role: 'reasoning', messages: [{ role: 'user', content: 'hi' }] });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.error).toContain('API Key');
    } finally {
      await close();
    }
  });
});

// ==================== 测连通：文本短请求 / 视觉必发随包小图 ====================

describe('0023 P2 testConnection（任务书 P2.2）', () => {
  it('文本角色：短请求成功 → ok:true + latency + reply；service 回写 lastTestOk=true/lastTestAt', async () => {
    const { port, seen, close } = await startMockServer(() => okPayload('pong'));
    const { svc, gw } = makeGateway();
    try {
      const p = await gw.createProfile({
        data: { role: 'reasoning', name: 'R1', provider: 'sf', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm', apiKey: FAKE_KEY },
      });
      const result = await gw.testConnection({ profileId: p.id });
      expect(result.ok).toBe(true);
      expect(result.reply).toBe('pong');
      expect(result.latencyMs).not.toBeNull();

      expect(seen).toHaveLength(1);
      expect(seen[0]!.body.messages.length).toBeLessThanOrEqual(2); // 短请求

      const after = await svc.getProfile(p.id);
      expect(after!.lastTestOk).toBe(true);
      expect(after!.lastTestAt).not.toBeNull();
    } finally {
      await close();
    }
  });

  it('视觉角色：必须发随包小图（data:image/png;base64，来自 build/ai-test-image.png）', async () => {
    const { port, seen, close } = await startMockServer(() => okPayload('MOFANG AI-TEST 2026 / E=mc^2'));
    const { gw } = makeGateway(TEST_IMAGE);
    try {
      const p = await gw.createProfile({
        data: { role: 'vision', name: 'R2', provider: 'sf', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'vl', apiKey: FAKE_KEY },
      });
      const result = await gw.testConnection({ profileId: p.id });
      expect(result.ok).toBe(true);

      const content = seen[0]!.body.messages[0]!.content;
      expect(Array.isArray(content)).toBe(true);
      const parts = content as Array<{ type: string; image_url?: { url: string } }>;
      const imageParts = parts.filter((x) => x.type === 'image_url');
      expect(imageParts).toHaveLength(1);
      expect(imageParts[0]!.image_url!.url.startsWith('data:image/png;base64,')).toBe(true);
      // base64 解码后确为 PNG magic + 尺寸量级（几 KB 资产）
      const b64 = imageParts[0]!.image_url!.url.slice('data:image/png;base64,'.length);
      const bytes = Buffer.from(b64, 'base64');
      expect(bytes.length).toBeGreaterThan(500);
      expect(bytes.length).toBeLessThan(20 * 1024);
      expect(bytes[0]).toBe(0x89);
      expect(bytes.toString('ascii', 1, 4)).toBe('PNG');
    } finally {
      await close();
    }
  });

  it('失败路径：HTTP 401 → ok:false + service 回写 lastTestOk=false；错误信息不含 Key', async () => {
    const { port, close } = await startMockServer((seen) => ({
      status: 401,
      payload: { error: { message: `invalid api key ${seen.auth}` } },
    }));
    const { svc, gw } = makeGateway();
    try {
      const p = await gw.createProfile({
        data: { role: 'reasoning', name: 'R1', provider: 'sf', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm', apiKey: FAKE_KEY },
      });
      const result = await gw.testConnection({ profileId: p.id });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).not.toContain(FAKE_KEY);

      const after = await svc.getProfile(p.id);
      expect(after!.lastTestOk).toBe(false);
    } finally {
      await close();
    }
  });

  it('未配置 Key 的档案测连通 → ok:false 明确提示（不发请求）', async () => {
    const { gw } = makeGateway();
    const p = await gw.createProfile({
      data: { role: 'reasoning', name: 'R1', provider: 'sf', baseUrl: 'http://127.0.0.1:9/v1', model: 'm' },
    });
    const result = await gw.testConnection({ profileId: p.id });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('API Key');
  });
});

// ==================== 临时目录卫生（防止 Windows 句柄残留告警） ====================

describe('0023 P2 工作区卫生', () => {
  it('mkdtemp 可用性自检（与真实层联跑时的临时目录前缀一致）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'model-profile-test-'));
    expect(dir).toBeTruthy();
    rmSync(dir, { recursive: true, force: true });
  });
});

// ==================== 返工 R3：获取模型列表（GET /models；未建档可凭 baseUrl+Key 直拉） ====================

describe('0023 返工：ai.models.list（获取模型列表）', () => {
  it('经 profileId：取档案 baseUrl + 解密存量 Key，GET {base}/models 带出 Authorization，返回模型 id 列表', async () => {
    const { port, seen, close } = await startMockServer(() => ({
      status: 200,
      payload: { data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] },
    }));
    const { gw } = makeGateway();
    try {
      const p = await gw.createProfile({
        data: { role: 'reasoning', name: 'R1', provider: 'deepseek', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'deepseek-chat', apiKey: FAKE_KEY },
      });
      const result = await gw.listModels({ profileId: p.id });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.models).toEqual(['deepseek-chat', 'deepseek-reasoner']);
      expect(seen[0]!.url).toBe('/v1/models');
      expect(seen[0]!.auth).toBe(`Bearer ${FAKE_KEY}`);
    } finally {
      await close();
    }
  });

  it('未建档（新建表单态）：直传 baseUrl+apiKey 也可拉取；Key 不落库', async () => {
    const { port, seen, close } = await startMockServer(() => ({
      status: 200,
      payload: { data: [{ id: 'deepseek-chat' }] },
    }));
    const { svc, gw } = makeGateway();
    try {
      const before = await svc.listProfiles();
      const result = await gw.listModels({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: FAKE_KEY });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.models).toEqual(['deepseek-chat']);
      expect(seen[0]!.url).toBe('/v1/models');
      expect(seen[0]!.auth).toBe(`Bearer ${FAKE_KEY}`);
      // 直传形态不产生任何档案（Key 仅此一瞬）
      expect(await svc.listProfiles()).toHaveLength(before.length);
    } finally {
      await close();
    }
  });

  it('HTTP 401 → ok:false 且错误信息不含 Key； Neither profileId nor baseUrl → ok:false 明确提示', async () => {
    const { port, close } = await startMockServer((seen) => ({
      status: 401,
      payload: { error: { message: `invalid key ${seen.auth}` } },
    }));
    const { gw } = makeGateway();
    try {
      const fail = await gw.listModels({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: FAKE_KEY });
      expect(fail.ok).toBe(false);
      if (!fail.ok) expect(fail.error).not.toContain(FAKE_KEY);
    } finally {
      await close();
    }

    const none = await gw.listModels({});
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.error).toContain('Base URL');
  });

  it('编辑态 Key 留空：profileId + 空 apiKey → 回落存量 Key（与不换 Key 语义衔接）', async () => {
    const { port, seen, close } = await startMockServer(() => ({
      status: 200,
      payload: { data: [{ id: 'm1' }] },
    }));
    const { gw } = makeGateway();
    try {
      const p = await gw.createProfile({
        data: { role: 'reasoning', name: 'R1', provider: 'deepseek', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm1', apiKey: FAKE_KEY },
      });
      const result = await gw.listModels({ profileId: p.id, apiKey: '' });
      expect(result.ok).toBe(true);
      expect(seen[0]!.auth).toBe(`Bearer ${FAKE_KEY}`);
    } finally {
      await close();
    }
  });
});
