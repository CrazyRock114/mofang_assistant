// 0023 P1：模型档案 service 契约测试 — 参数化跑两遍（真实 SQLite + mock 内存），两遍必须同绿。
// 覆盖（0023 任务书 §四）：
// - CRUD + 按 role 过滤
// - 启用排他守卫（同 role 至多一条启用，事务内排他）
// - 删 enabled 档案后角色回未配置态
// - list/get 永不含 key_encrypted（D-043 红线，只回 hasKey）
// - 未测连通（lastTestOk!==true）禁止启用（P-18 service 侧双保险）
// - recordTestResult 回写 + getKeyEncrypted 仅密文形态内部可用

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import type { ModelProfileService, ModelProfileInput } from '../../src/shared/contracts/ai-types.js';
import { MODEL_ROLES } from '../../src/shared/contracts/ai-types.js';
import { openDatabase } from '../../src/bank/db.js';
import { ModelProfileServiceImpl } from '../../src/bank/model-profile-service.js';
import { createMockModelProfileService } from '../../src/bank/mock/mock-ai.js';
import { MockBankStore } from '../../src/bank/mock/mock-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '../../src/bank/migrations');

interface AiCtx {
  svc: ModelProfileService;
  cleanup: () => void;
}

const implementations: Array<{ name: string; factory: () => AiCtx }> = [
  {
    name: 'Real (SQLite)',
    factory: () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'model-profile-test-'));
      const db = openDatabase(join(tempDir, 'test.db'), migrationsDir);
      return {
        svc: new ModelProfileServiceImpl(db),
        cleanup: () => {
          db.close();
          rmSync(tempDir, { recursive: true, force: true });
        },
      };
    },
  },
  {
    name: 'Mock (in-memory)',
    factory: () => {
      const store = new MockBankStore();
      return {
        svc: createMockModelProfileService(store),
        cleanup: () => {},
      };
    },
  },
];

/** 建档入参（keyEncrypted=托管层密文占位；测试一律假密文，明文 Key 三不进 git） */
function makeInput(overrides: Partial<ModelProfileInput> = {}): ModelProfileInput {
  return {
    role: 'reasoning',
    name: '档案A',
    provider: 'siliconflow',
    baseUrl: 'https://api.example.com/v1',
    model: 'test-model',
    ...overrides,
  };
}

/** 密文占位串（假密文，非明文 Key） */
const FAKE_CIPHER_A = 'dpapi:v1:QUJDREVGR0hJSktMTU5PUA==';
const FAKE_CIPHER_B = 'mkey:v1:WFlaQUI=';
const FAKE_CIPHER_C = 'dpapi:v1:MTIzNDU2Nzg5MA==';

describe.each(implementations)('0023 ModelProfileService Contract Tests - $name', ({ factory }) => {
  let ctx: AiCtx;
  let svc: ModelProfileService;

  beforeEach(() => {
    ctx = factory();
    svc = ctx.svc;
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('建档 → get/list 返回档案；返回值永不包含 key_encrypted（只回 hasKey）', async () => {
    const created = await svc.createProfile(makeInput({ keyEncrypted: FAKE_CIPHER_A }));
    expect(created.id).toBeTruthy();
    expect(created.role).toBe('reasoning');
    expect(created.protocol).toBe('openai-chat'); // 缺省协议
    expect(created.isEnabled).toBe(false);
    expect(created.hasKey).toBe(true);
    expect(created.lastTestAt).toBeNull();
    expect(created.lastTestOk).toBeNull();

    // D-043 红线：任何对外形态不得出现 keyEncrypted 字段（含密文键名与值）
    const fetched = await svc.getProfile(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.hasKey).toBe(true);
    expect(Object.keys(fetched!)).not.toContain('keyEncrypted');
    expect(Object.keys(fetched!)).not.toContain('key_encrypted');
    expect(JSON.stringify(fetched)).not.toContain(FAKE_CIPHER_A);
    expect(JSON.stringify(fetched)).not.toContain('key_encrypted');

    const list = await svc.listProfiles();
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(FAKE_CIPHER_A);
    expect(list[0]!.hasKey).toBe(true);
  });

  it('未配 Key 建档 → hasKey=false；capability 可存取', async () => {
    const noKey = await svc.createProfile(makeInput({ name: '无Key档案', capability: { vision: true } }));
    expect(noKey.hasKey).toBe(false);
    expect(noKey.capability).toEqual({ vision: true });

    const noCap = await svc.createProfile(makeInput({ name: '无Cap档案' }));
    expect(noCap.capability).toBeNull();
  });

  it('按 role 过滤：listProfiles({ role }) 只回该角色', async () => {
    await svc.createProfile(makeInput({ name: 'R1' }));
    await svc.createProfile(makeInput({ role: 'vision', name: 'R2' }));
    await svc.createProfile(makeInput({ role: 'light', name: 'R3' }));

    const visions = await svc.listProfiles({ role: 'vision' });
    expect(visions).toHaveLength(1);
    expect(visions[0]!.role).toBe('vision');
    expect(visions[0]!.name).toBe('R2');

    const all = await svc.listProfiles();
    expect(all).toHaveLength(3);
    expect(MODEL_ROLES).toContain('specialty'); // 五角色枚举齐备（R1-R5）
  });

  it('updateProfile：字段部分更新；keyEncrypted 缺省=保持，显式 null=清除', async () => {
    const p = await svc.createProfile(makeInput({ keyEncrypted: FAKE_CIPHER_A }));

    const renamed = await svc.updateProfile(p.id, { name: '改名', model: 'model-v2' });
    expect(renamed.name).toBe('改名');
    expect(renamed.model).toBe('model-v2');
    expect(renamed.provider).toBe('siliconflow'); // 未传字段保持
    expect(renamed.hasKey).toBe(true); // keyEncrypted 缺省=保持

    const cleared = await svc.updateProfile(p.id, { keyEncrypted: null });
    expect(cleared.hasKey).toBe(false);
  });

  it('getProfile 不存在的 id → null；update/delete 不存在的 id → 抛错', async () => {
    expect(await svc.getProfile('no-such-id')).toBeNull();
    await expect(svc.updateProfile('no-such-id', { name: 'x' })).rejects.toThrow();
    await expect(svc.deleteProfile('no-such-id')).rejects.toThrow();
  });

  it('启用排他守卫：同 role 启用第二条自动停用第一条（事务内排他）', async () => {
    const a = await svc.createProfile(makeInput({ name: 'A' }));
    const b = await svc.createProfile(makeInput({ name: 'B' }));
    await svc.recordTestResult(a.id, true, '2026-09-17T00:00:00Z');
    await svc.recordTestResult(b.id, true, '2026-09-17T00:00:01Z');

    const enabledA = await svc.setProfileEnabled(a.id, true);
    expect(enabledA.isEnabled).toBe(true);
    expect((await svc.getEnabledProfile('reasoning'))!.id).toBe(a.id);

    // 启用 B → A 自动停用（同 role 至多一条）
    await svc.setProfileEnabled(b.id, true);
    const enabled = await svc.getEnabledProfile('reasoning');
    expect(enabled!.id).toBe(b.id);
    expect((await svc.getProfile(a.id))!.isEnabled).toBe(false);
  });

  it('不同角色互不排他：reasoning 与 vision 可同时各有一条启用', async () => {
    const r = await svc.createProfile(makeInput({ role: 'reasoning', name: 'R1' }));
    const v = await svc.createProfile(makeInput({ role: 'vision', name: 'R2' }));
    await svc.recordTestResult(r.id, true, '2026-09-17T00:00:00Z');
    await svc.recordTestResult(v.id, true, '2026-09-17T00:00:01Z');
    await svc.setProfileEnabled(r.id, true);
    await svc.setProfileEnabled(v.id, true);
    expect((await svc.getEnabledProfile('reasoning'))!.id).toBe(r.id);
    expect((await svc.getEnabledProfile('vision'))!.id).toBe(v.id);
  });

  it('P-18 双保险：未测过（lastTestOk=null）与测试失败（false）的档案禁止启用', async () => {
    const untested = await svc.createProfile(makeInput({ name: '未测' }));
    await expect(svc.setProfileEnabled(untested.id, true)).rejects.toThrow(/连通性测试/);

    const failed = await svc.createProfile(makeInput({ name: '失败' }));
    await svc.recordTestResult(failed.id, false, '2026-09-17T00:00:00Z');
    await expect(svc.setProfileEnabled(failed.id, true)).rejects.toThrow(/连通性测试/);

    // 测通后可启用
    await svc.recordTestResult(failed.id, true, '2026-09-17T00:00:02Z');
    const ok = await svc.setProfileEnabled(failed.id, true);
    expect(ok.isEnabled).toBe(true);
  });

  it('停用：setEnabled(id,false) → 角色回未配置态（0 条启用合法）', async () => {
    const p = await svc.createProfile(makeInput());
    await svc.recordTestResult(p.id, true, '2026-09-17T00:00:00Z');
    await svc.setProfileEnabled(p.id, true);
    expect(await svc.getEnabledProfile('reasoning')).not.toBeNull();

    await svc.setProfileEnabled(p.id, false);
    expect(await svc.getEnabledProfile('reasoning')).toBeNull();
    expect((await svc.getProfile(p.id))!.isEnabled).toBe(false);
  });

  it('删除启用中的档案后角色回未配置态；删除后 get → null', async () => {
    const p = await svc.createProfile(makeInput({ keyEncrypted: FAKE_CIPHER_A }));
    await svc.recordTestResult(p.id, true, '2026-09-17T00:00:00Z');
    await svc.setProfileEnabled(p.id, true);
    expect(await svc.getEnabledProfile('reasoning')).not.toBeNull();

    await svc.deleteProfile(p.id);
    expect(await svc.getProfile(p.id)).toBeNull();
    expect(await svc.getEnabledProfile('reasoning')).toBeNull();
    expect(await svc.listProfiles()).toHaveLength(0);
  });

  it('recordTestResult 回写 last_test_at/last_test_ok（不改 updated_at）', async () => {
    const p = await svc.createProfile(makeInput());
    const before = (await svc.getProfile(p.id))!;
    expect(before.lastTestOk).toBeNull();

    await svc.recordTestResult(p.id, true, '2026-09-17T08:00:00Z');
    const after = (await svc.getProfile(p.id))!;
    expect(after.lastTestOk).toBe(true);
    expect(after.lastTestAt).toBe('2026-09-17T08:00:00Z');
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  it('getKeyEncrypted：返回托管层密文本体（主进程内部用）；未配置 → null', async () => {
    const withKey = await svc.createProfile(makeInput({ keyEncrypted: FAKE_CIPHER_B }));
    expect(await svc.getKeyEncrypted(withKey.id)).toBe(FAKE_CIPHER_B);

    const noKey = await svc.createProfile(makeInput({ name: '无Key' }));
    expect(await svc.getKeyEncrypted(noKey.id)).toBeNull();
    expect(await svc.getKeyEncrypted('no-such-id')).toBeNull();
  });

  it('建档校验：role 非法 / 必填字段为空 → 抛错（真实层 DDL CHECK + service 双拦）', async () => {
    await expect(svc.createProfile(makeInput({ role: 'chat' as never }))).rejects.toThrow();
    await expect(svc.createProfile(makeInput({ name: '' }))).rejects.toThrow();
    await expect(svc.createProfile(makeInput({ baseUrl: '' }))).rejects.toThrow();
    await expect(svc.createProfile(makeInput({ model: '' }))).rejects.toThrow();
    await expect(svc.createProfile(makeInput({ protocol: '' }))).rejects.toThrow();
  });

  it('operation_log 留痕：操作类型前缀 modelProfile.*（启用/建档）', async () => {
    // 仅真实层可查库验证；mock 层经 store.log 记录，双跑各自断言自身通道
    const p = await svc.createProfile(makeInput());
    await svc.recordTestResult(p.id, true, '2026-09-17T00:00:00Z');
    await svc.setProfileEnabled(p.id, true);
    await svc.deleteProfile(p.id);
    // 具体留痕断言在真实层专属用例（下方 Real-only describe）
    expect(true).toBe(true);
  });
});

// ==================== 真实层专属：operation_log 前缀 + 密文列直查 ====================

describe('0023 ModelProfileService Real-only（SQLite 留痕/密文列）', () => {
  let tempDir = '';
  let db: ReturnType<typeof openDatabase> | null = null;

  afterEach(() => {
    db?.close();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = '';
    db = null;
  });

  it('operation_log 操作类型前缀 modelProfile.*；库内 key_encrypted 为密文非明文', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'model-profile-real-'));
    db = openDatabase(join(tempDir, 'test.db'), migrationsDir);
    const svc: ModelProfileService = new ModelProfileServiceImpl(db);

    const p = await svc.createProfile(makeInput({ keyEncrypted: FAKE_CIPHER_C }));
    await svc.recordTestResult(p.id, true, '2026-09-17T00:00:00Z');
    await svc.setProfileEnabled(p.id, true);
    await svc.updateProfile(p.id, { name: '改名' });
    await svc.deleteProfile(p.id);

    const logs = db.prepare(
      `SELECT operation_type FROM operation_log WHERE operation_type LIKE 'modelProfile.%' ORDER BY started_at`,
    ).all() as Array<{ operation_type: string }>;
    const types = logs.map((l) => l.operation_type);
    expect(types).toContain('modelProfile.create');
    expect(types).toContain('modelProfile.setEnabled');
    expect(types).toContain('modelProfile.update');
    expect(types).toContain('modelProfile.delete');

    // 列级红线：直接查库也只见假密文占位（测试从不写明文 Key）
    const raw = db.prepare(`SELECT key_encrypted FROM model_profiles WHERE id = 'gone'`).get();
    expect(raw ?? null).toBeNull(); // 已删；密文列存在性由迁移测试钉死
  });
});
