// 0023 P3：设置页「模型配置」板块验收测试（jsdom；注入 fake ai 桥，模式照 settings-page.test.tsx）
// 覆盖（任务书 §一 P3 + §六目检清单 + 2026-09-17 目检返工 R1-R4）：
// - R1：R2 角色语义明确为 OCR（识别切分），R1 推理声明需支持图片输入
// - R3：表单字段顺序 名称→供应商→BaseURL→协议→API Key→模型；占位符统一 deepseek；
//        协议为下拉（含自定义）；模型为 datalist 输入 + 「获取模型列表」按钮（可手输 id）
// - R4：档案行四按钮（启用/停用、检测、编辑、删除）；未检测启用置灰；启用后左侧出现
//        「当前使用中」且按钮变「停用」；档案间切换原使用中状态跟随
// - 基线：新建/Key 只写不回显/编辑留空不换 Key/两击确认删除/工厂回落

// @vitest-environment jsdom

import { describe, it, expect, afterEach } from 'vitest';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import { SettingsPage } from '../../src/app/pages/SettingsPage.js';
import type { MofangAiBridge } from '../../src/shared/contracts/bridge.js';
import type { AiModelsListPayload, AiModelsListResult, AiInvokePayload, AiInvokeResult, AiProfileCreatePayload, AiProfileUpdatePayload, AiTestConnectionResult } from '../../src/shared/contracts/ai-types.js';
import { createMockModelProfileService } from '../../src/bank/mock/mock-ai.js';
import { MockBankStore } from '../../src/bank/mock/mock-store.js';

let container: HTMLDivElement;
let root: Root | null = null;

function render(ui: ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => root!.render(ui));
}

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
});

/** 受控 fake 桥：内存 service + 可编排的测连通结果 + update/create payload 记录（断言 Key 只写不回显） */
function makeFakeAi(opts: { testResult?: AiTestConnectionResult; modelsResult?: AiModelsListResult } = {}): {
  bridge: MofangAiBridge;
  svc: ReturnType<typeof createMockModelProfileService>;
  updates: AiProfileUpdatePayload[];
  creates: AiProfileCreatePayload[];
  invokes: AiInvokePayload[];
  modelsCalls: AiModelsListPayload[];
} {
  const store = new MockBankStore();
  const svc = createMockModelProfileService(store);
  const updates: AiProfileUpdatePayload[] = [];
  const creates: AiProfileCreatePayload[] = [];
  const invokes: AiInvokePayload[] = [];
  const modelsCalls: AiModelsListPayload[] = [];
  const bridge: MofangAiBridge = {
    profile: {
      list: (payload = {}) => svc.listProfiles(payload.filter),
      create: async (payload) => { creates.push(payload); return svc.createProfile({ ...payload.data, keyEncrypted: payload.data.apiKey ? `cipher:${payload.data.apiKey}` : null }); },
      update: async (payload) => { updates.push(payload); return svc.updateProfile(payload.id, { ...payload.data, keyEncrypted: payload.data.apiKey === undefined ? undefined : `cipher:${payload.data.apiKey}` }); },
      delete: (payload) => svc.deleteProfile(payload.id),
      setEnabled: (payload) => svc.setProfileEnabled(payload.id, payload.enabled),
      testConnection: async (payload) => {
        const p = await svc.getProfile(payload.profileId);
        if (!p) throw new Error('no profile');
        const result = opts.testResult ?? { ok: true, latencyMs: 234, reply: 'pong' };
        await svc.recordTestResult(payload.profileId, result.ok, '2026-09-17T12:00:00Z');
        return result;
      },
    },
    invoke: async (payload) => { invokes.push(payload); return { ok: false, error: 'unused', latencyMs: 0 } satisfies AiInvokeResult; },
    models: {
      list: async (payload) => { modelsCalls.push(payload); return opts.modelsResult ?? { ok: true, models: ['deepseek-chat', 'deepseek-reasoner'] }; },
    },
  };
  return { bridge, svc, updates, creates, invokes, modelsCalls };
}

function q(testid: string): HTMLElement {
  const el = container.querySelector(`[data-testid="${testid}"]`);
  if (!el) throw new Error(`element not found: ${testid}`);
  return el;
}

function qAll(testid: string): HTMLElement[] {
  return [...container.querySelectorAll(`[data-testid="${testid}"]`)];
}

function click(el: HTMLElement): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

function input(el: HTMLInputElement, value: string): void {
  // React 受控输入须经原生 value setter（绕过 _valueTracker 去重），否则 onChange 不触发（照 bank-browser.test 模式）
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

const tick = () => new Promise<void>((r) => setTimeout(r, 20));

async function openAiDetail(bridge: MofangAiBridge): Promise<void> {
  render(<SettingsPage ai={bridge} />);
  click(q('settings-ai-open'));
  await tick();
}

describe('0023 P3 设置页「模型配置」板块（基线）', () => {
  it('入口卡：概要统计 + 点击进入详情；详情含返回与五角色分组', async () => {
    const { bridge } = makeFakeAi();
    render(<SettingsPage ai={bridge} />);
    await tick();

    expect(q('settings-ai-entry')).toBeTruthy();
    expect(q('settings-ai-summary').textContent).toContain('0');
    click(q('settings-ai-open'));
    await tick();

    expect(q('settings-ai-detail')).toBeTruthy();
    expect(q('settings-ai-back')).toBeTruthy();
    const roles = qAll('settings-ai-role').map((el) => el.getAttribute('data-role'));
    expect(roles).toEqual(['reasoning', 'vision', 'light', 'embedding', 'specialty']);
    // 中文角色名（R1-R5）与用途一句话齐备
    expect(q('settings-ai-detail').textContent).toContain('推理');
    expect(q('settings-ai-detail').textContent).toContain('OCR');
    expect(q('settings-ai-detail').textContent).toContain('轻量');
    expect(q('settings-ai-detail').textContent).toContain('向量');
    expect(q('settings-ai-detail').textContent).toContain('专用');

    click(q('settings-ai-back'));
    await tick();
    expect(q('settings-ai-entry')).toBeTruthy();
  });

  it('返工 R1：R2 分组语义明确为 OCR；返工 R2：R1 推理声明需支持图片输入', async () => {
    const { bridge } = makeFakeAi();
    await openAiDetail(bridge);
    const groups = Object.fromEntries(qAll('settings-ai-role').map((el) => [el.getAttribute('data-role'), el.textContent ?? '']));

    // R2：OCR 语义（识别切分），不再是含混的「视觉」
    expect(groups['vision']).toContain('R2 OCR');
    expect(groups['vision']).toContain('识别');
    expect(groups['vision']).toContain('需要支持图片输入的模型');
    // R1：主推理模型需声明支持图片输入
    expect(groups['reasoning']).toContain('图片输入');
  });

  it('新建档案：表单提交 → 桥收到明文 Key（仅此一次）→ 行出现且 Key 只写不回显（已配置（••••））', async () => {
    const { bridge, creates } = makeFakeAi();
    await openAiDetail(bridge);

    click(q('settings-ai-create'));
    await tick();
    // 返工 R5：新建/编辑以弹窗呈现（遮罩 + 居中卡片）
    expect(q('settings-ai-modal')).toBeTruthy();
    expect(q('settings-ai-form')).toBeTruthy();

    input(q('settings-ai-field-name') as HTMLInputElement, '硅基R1');
    input(q('settings-ai-field-provider') as HTMLInputElement, 'siliconflow');
    input(q('settings-ai-field-base-url') as HTMLInputElement, 'https://api.siliconflow.cn/v1');
    input(q('settings-ai-field-model') as HTMLInputElement, 'deepseek-ai/DeepSeek-V3');
    input(q('settings-ai-field-api-key') as HTMLInputElement, 'sk-demo-fake-key');

    click(q('settings-ai-save'));
    await tick();

    expect(creates).toHaveLength(1);
    expect(creates[0]!.data.apiKey).toBe('sk-demo-fake-key');
    expect(creates[0]!.data.role).toBe('reasoning');
    // 保存成功 → 弹窗关闭
    expect(container.querySelector('[data-testid="settings-ai-modal"]')).toBeNull();

    // 行渲染；Key 状态为掩码（不回显明文）
    const rows = qAll('settings-ai-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain('硅基R1');
    expect(rows[0]!.textContent).toContain('deepseek-ai/DeepSeek-V3');
    const keyState = rows[0]!.querySelector('[data-testid="settings-ai-key-state"]')!;
    expect(keyState.getAttribute('data-configured')).toBe('true');
    expect(keyState.textContent).toContain('已配置（••••）');
    expect(container.innerHTML).not.toContain('sk-demo-fake-key'); // 明文不进 DOM
  });

  it('编辑档案：表单预填；Key 留空提交 → update payload 不含 apiKey（不换 Key 语义）', async () => {
    const { bridge, svc, updates } = makeFakeAi();
    const p = await svc.createProfile({ role: 'reasoning', name: '原名', provider: 'sf', baseUrl: 'https://x/v1', model: 'm1', keyEncrypted: 'c' });
    await openAiDetail(bridge);

    click(q('settings-ai-edit'));
    await tick();
    expect(q('settings-ai-form')).toBeTruthy();
    expect((q('settings-ai-field-name') as HTMLInputElement).value).toBe('原名');
    expect((q('settings-ai-field-model') as HTMLInputElement).value).toBe('m1');
    // Key 输入框不回显既有 Key（值恒空）
    expect((q('settings-ai-field-api-key') as HTMLInputElement).value).toBe('');

    input(q('settings-ai-field-model') as HTMLInputElement, 'm2');
    click(q('settings-ai-save'));
    await tick();

    expect(updates).toHaveLength(1);
    expect(updates[0]!.id).toBe(p.id);
    expect(updates[0]!.data.apiKey).toBeUndefined(); // 留空=不换 Key
    expect(updates[0]!.data.model).toBe('m2');
    expect((await svc.getProfile(p.id))!.hasKey).toBe(true);
  });

  it('删除：两击确认后删除（禁 confirm()），行消失', async () => {
    const { bridge, svc } = makeFakeAi();
    const p = await svc.createProfile({ role: 'reasoning', name: '待删', provider: 'sf', baseUrl: 'https://x/v1', model: 'm' });
    await openAiDetail(bridge);
    expect(qAll('settings-ai-row')).toHaveLength(1);

    click(q('settings-ai-delete')); // 第一击：进入待确认态
    await tick();
    expect(qAll('settings-ai-row')).toHaveLength(1); // 未删
    click(q('settings-ai-delete')); // 第二击：确认删除
    await tick();

    expect(qAll('settings-ai-row')).toHaveLength(0);
    expect(await svc.getProfile(p.id)).toBeNull();
  });

  it('工厂：无 __mofangAi 时回落 mock（不抛错；CRUD 可用）', async () => {
    const { createAiServices } = await import('../../src/app/services/AiServiceFactory.js');
    const ai = createAiServices();
    expect(typeof ai.profile.list).toBe('function');
    expect(typeof ai.models.list).toBe('function');
    const created = await ai.profile.create({ data: { role: 'specialty', name: 'R5', provider: 'x', baseUrl: 'https://x/v1', model: 'm' } });
    expect(created.protocol).toBe('openai-chat');
    const result = await ai.profile.testConnection({ profileId: created.id });
    expect(result.ok).toBe(false); // demo 环境如实失败（不静默造假）
    const models = await ai.models.list({ baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-x' });
    expect(models.ok).toBe(false); // demo 环境如实失败
  });
});

describe('0023 返工 R3：表单形态（顺序/占位符/协议下拉/模型列表）', () => {
  async function openForm(): Promise<void> {
    const { bridge } = makeFakeAi();
    render(<SettingsPage ai={bridge} />);
    click(q('settings-ai-open'));
    await tick();
    click(q('settings-ai-create'));
    await tick();
  }

  it('字段顺序：名称 → 供应商 → Base URL → 协议 → API Key → 模型（DOM 顺序断言）', async () => {
    await openForm();
    const ids = [
      'settings-ai-field-name', 'settings-ai-field-provider', 'settings-ai-field-base-url',
      'settings-ai-field-protocol', 'settings-ai-field-api-key', 'settings-ai-field-model',
    ];
    const els = ids.map((id) => q(id));
    for (let i = 0; i < els.length - 1; i++) {
      // eslint-disable-next-line no-bitwise
      expect(els[i]!.compareDocumentPosition(els[i + 1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('未输入占位符统一 deepseek 示例（Base URL / 模型 / 供应商）', async () => {
    await openForm();
    expect((q('settings-ai-field-base-url') as HTMLInputElement).placeholder).toMatch(/deepseek\.com/i);
    expect((q('settings-ai-field-model') as HTMLInputElement).placeholder).toMatch(/deepseek/i);
    expect((q('settings-ai-field-provider') as HTMLInputElement).placeholder).toMatch(/deepseek/i);
    expect((q('settings-ai-field-name') as HTMLInputElement).placeholder).toMatch(/deepseek/i);
  });

  it('协议类型为下拉选框：默认 openai-chat；选「自定义」出现手动输入框（R5 预留）', async () => {
    await openForm();
    const select = q('settings-ai-field-protocol') as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    expect(select.value).toBe('openai-chat');
    // 切到「自定义」分支 → 出现手动输入框
    select.value = 'custom';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    expect(q('settings-ai-field-protocol-custom')).toBeTruthy();
    // 输入自定义协议后可保存路径使用（此处只验证输入框受控）
    input(q('settings-ai-field-protocol-custom') as HTMLInputElement, 'http-custom');
    expect((q('settings-ai-field-protocol-custom') as HTMLInputElement).value).toBe('http-custom');
  });

  it('模型：自绘下拉全量展示（已填内容不裁剪选项——返工 R7）+ 可手输 id +「获取模型列表」', async () => {
    const { bridge, modelsCalls } = makeFakeAi();
    render(<SettingsPage ai={bridge} />);
    click(q('settings-ai-open'));
    await tick();
    click(q('settings-ai-create'));
    await tick();

    // 先手填模型 id（复现缺陷前置：原生 datalist 会按输入过滤裁剪）
    input(q('settings-ai-field-model') as HTMLInputElement, 'deepseek-chat');
    input(q('settings-ai-field-base-url') as HTMLInputElement, 'https://api.deepseek.com/v1');
    input(q('settings-ai-field-api-key') as HTMLInputElement, 'sk-demo-fake-key');

    // 获取成功 → 下拉自动展开 → 全量选项（不被当前输入裁剪）
    click(q('settings-ai-fetch-models'));
    await tick();

    expect(modelsCalls).toHaveLength(1);
    const options = qAll('settings-ai-model-option').map((o) => o.getAttribute('data-id'));
    expect(options).toEqual(['deepseek-chat', 'deepseek-reasoner']);

    // 点选项 → 回填输入框并收起下拉
    click(qAll('settings-ai-model-option').find((o) => o.getAttribute('data-id') === 'deepseek-reasoner')!);
    await tick();
    expect((q('settings-ai-field-model') as HTMLInputElement).value).toBe('deepseek-reasoner');
    expect(container.querySelector('[data-testid="settings-ai-model-options"]')).toBeNull();

    // 右侧箭头可手动开合
    click(q('settings-ai-model-toggle'));
    await tick();
    expect(q('settings-ai-model-options')).toBeTruthy();
    click(q('settings-ai-model-toggle'));
    await tick();
    expect(container.querySelector('[data-testid="settings-ai-model-options"]')).toBeNull();
  });

  it('模型下拉空态：未获取过点箭头 → 出现提示项而非空白/报错', async () => {
    const { bridge } = makeFakeAi();
    render(<SettingsPage ai={bridge} />);
    click(q('settings-ai-open'));
    await tick();
    click(q('settings-ai-create'));
    await tick();

    click(q('settings-ai-model-toggle'));
    await tick();
    expect(q('settings-ai-model-options')).toBeTruthy();
    expect(qAll('settings-ai-model-option')).toHaveLength(0);
    expect(q('settings-ai-model-options').textContent).toContain('获取模型列表');
  });

  it('返工 R5：弹窗形态——遮罩变暗、输入框宽度一致（全部 100%）；X/遮罩/ESC 均可关闭', async () => {
    const { bridge } = makeFakeAi();
    render(<SettingsPage ai={bridge} />);
    click(q('settings-ai-open'));
    await tick();

    // X 关闭
    click(q('settings-ai-create'));
    await tick();
    const overlay = q('settings-ai-modal') as HTMLElement;
    expect(overlay.style.background).toContain('rgba(24, 18, 12'); // 与图片放大遮罩同色系（外部背景变暗）
    // 输入框长度一致：文本输入与下拉均为 100% 宽
    for (const id of ['name', 'provider', 'base-url', 'api-key', 'model']) {
      expect((q(`settings-ai-field-${id}`) as HTMLElement).style.width).toBe('100%');
    }
    expect((q('settings-ai-field-protocol') as HTMLElement).style.width).toBe('100%');

    click(q('settings-ai-modal-close'));
    await tick();
    expect(container.querySelector('[data-testid="settings-ai-modal"]')).toBeNull();

    // 遮罩点击关闭
    click(q('settings-ai-create'));
    await tick();
    click(q('settings-ai-modal'));
    await tick();
    expect(container.querySelector('[data-testid="settings-ai-modal"]')).toBeNull();

    // ESC 关闭（与图片放大预览一致）
    click(q('settings-ai-create'));
    await tick();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick();
    expect(container.querySelector('[data-testid="settings-ai-modal"]')).toBeNull();
  });

  it('模型失败路径：HTTP 401 → 表单级错误可见', async () => {
    const { bridge } = makeFakeAi({ modelsResult: { ok: false, models: [], error: 'HTTP 401：密钥无效' } });
    render(<SettingsPage ai={bridge} />);
    click(q('settings-ai-open'));
    await tick();
    click(q('settings-ai-create'));
    await tick();
    input(q('settings-ai-field-base-url') as HTMLInputElement, 'https://api.deepseek.com/v1');
    input(q('settings-ai-field-api-key') as HTMLInputElement, 'sk-bad');
    click(q('settings-ai-fetch-models'));
    await tick();
    expect(q('settings-ai-form-error').textContent).toContain('401');
  });
});

describe('0023 返工 R4：档案行按钮形态（启用/停用 + 当前使用中 + 切换联动）', () => {
  it('未检测档案：「启用」置灰不可点；测连通成功后可点；启用后左侧出现「当前使用中」且按钮变「停用」', async () => {
    const { bridge, svc } = makeFakeAi();
    const p = await svc.createProfile({ role: 'reasoning', name: 'R1档案', provider: 'sf', baseUrl: 'https://x/v1', model: 'm', keyEncrypted: 'c' });
    await openAiDetail(bridge);

    let enableBtn = q('settings-ai-enable') as HTMLButtonElement;
    expect(enableBtn.tagName).toBe('BUTTON');
    expect(enableBtn.getAttribute('data-id')).toBe(p.id);
    expect(enableBtn.textContent).toContain('启用');
    expect(enableBtn.disabled).toBe(true); // 未检测 → 置灰
    expect(qAll('settings-ai-in-use')).toHaveLength(0); // 无「当前使用中」
    expect(q('settings-ai-light').getAttribute('data-state')).toBe('none');

    click(q('settings-ai-test'));
    await tick();

    const result = q('settings-ai-test-result');
    expect(result.getAttribute('data-ok')).toBe('true');
    expect(result.textContent).toContain('234'); // 成功显示延迟 ms

    enableBtn = q('settings-ai-enable') as HTMLButtonElement;
    expect(enableBtn.disabled).toBe(false); // 测通 → 可启用
    expect(q('settings-ai-light').getAttribute('data-state')).toBe('ok');

    click(enableBtn);
    await tick();

    const inUse = q('settings-ai-in-use');
    expect(inUse.textContent).toContain('当前使用中');
    // 「当前使用中」位于按钮组（启用）之前
    // eslint-disable-next-line no-bitwise
    expect(inUse.compareDocumentPosition(q('settings-ai-enable')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    enableBtn = q('settings-ai-enable') as HTMLButtonElement;
    expect(enableBtn.textContent).toContain('停用');
    expect((await svc.getProfile(p.id))!.isEnabled).toBe(true);
  });

  it('测连通失败：显示失败原因；启用仍置灰；状态灯红', async () => {
    const { bridge, svc } = makeFakeAi({
      testResult: { ok: false, latencyMs: 88, error: 'HTTP 401：invalid api key' },
    });
    const p = await svc.createProfile({ role: 'light', name: 'R3档案', provider: 'sf', baseUrl: 'https://x/v1', model: 'm', keyEncrypted: 'c' });
    await openAiDetail(bridge);

    click(q('settings-ai-test'));
    await tick();

    const result = q('settings-ai-test-result');
    expect(result.getAttribute('data-ok')).toBe('false');
    expect(result.textContent).toContain('HTTP 401');
    expect(q('settings-ai-light').getAttribute('data-state')).toBe('fail');
    expect((q('settings-ai-enable') as HTMLButtonElement).disabled).toBe(true);
    expect((await svc.getProfile(p.id))!.lastTestOk).toBe(false);
  });

  it('档案间切换：启用 B 后，A 的「当前使用中」消失、按钮回「启用」（service 排他 + UI 跟随）', async () => {
    const { bridge, svc } = makeFakeAi();
    const a = await svc.createProfile({ role: 'reasoning', name: 'A', provider: 'sf', baseUrl: 'https://x/v1', model: 'm', keyEncrypted: 'c' });
    const b = await svc.createProfile({ role: 'reasoning', name: 'B', provider: 'sf', baseUrl: 'https://x/v1', model: 'm2', keyEncrypted: 'c' });
    await svc.recordTestResult(a.id, true, '2026-09-17T00:00:00Z');
    await svc.recordTestResult(b.id, true, '2026-09-17T00:00:01Z');
    await openAiDetail(bridge);

    const rowOf = (id: string) => qAll('settings-ai-row').find((r) => r.getAttribute('data-id') === id)!;
    const enableBtnOf = (id: string) => rowOf(id).querySelector('[data-testid="settings-ai-enable"]') as HTMLButtonElement;
    const inUseOf = (id: string) => rowOf(id).querySelector('[data-testid="settings-ai-in-use"]');

    // 启用 A
    expect(enableBtnOf(a.id).disabled).toBe(false);
    click(enableBtnOf(a.id));
    await tick();
    expect(inUseOf(a.id)).toBeTruthy();
    expect(enableBtnOf(a.id).textContent).toContain('停用');
    expect(inUseOf(b.id)).toBeNull();

    // 切换到 B：A 状态跟随回退
    click(enableBtnOf(b.id));
    await tick();
    expect(inUseOf(b.id)).toBeTruthy();
    expect(enableBtnOf(b.id).textContent).toContain('停用');
    expect(inUseOf(a.id)).toBeNull();
    expect(enableBtnOf(a.id).textContent).toContain('启用');
    expect((await svc.getProfile(a.id))!.isEnabled).toBe(false);

    // 停用 B：全部回未配置态
    click(enableBtnOf(b.id));
    await tick();
    expect(inUseOf(b.id)).toBeNull();
    expect((await svc.getProfile(b.id))!.isEnabled).toBe(false);
  });
});
