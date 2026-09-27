// 0030 反馈工作台页组件测试（jsdom + Mock(in-memory) 注入单跑；照 compose-layout / 0005 feedback-page 模式）。
// 覆盖（任务书 §六 用户目检清单的程序化锚点）：
//   快速模式：未配 AI 走离线档出草稿；配 AI 后润色（注入假桥）；守卫命中标红 + 保存时提示但不硬拦
//   班级批量：5 名学生走通（公共信息填一次、关联考试带成绩、逐人进度、逐卡可编辑）；保存记录计入档案
//   草稿：批量填一半关页，重开能接着来；丢弃草稿
//   提示词模板：内置只读、另存自定义可改、导出/导入文本走通
//   反馈记录：快速=「未关联」标；班级筛选 + 姓名搜索
// 卡片 PNG / txt 磁盘导出走 file.* 通道（本文件只断言通道调用），真桥由探针/smoke 覆盖。

// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import type { BankService, BankExtServices } from '../../src/shared/contracts/bank-types.js';
import type { AiInvokePayload, AiInvokeResult, ModelProfile } from '../../src/shared/contracts/ai-types.js';
import type { FileImportTextResult, MofangFileBridge } from '../../src/shared/contracts/bridge.js';
import { MockBankService } from '../../src/bank/mock/mock-bank.js';
import { createMockExtServices } from '../../src/bank/mock/mock-ext.js';
import { MockBankStore } from '../../src/bank/mock/mock-store.js';

import { FeedbackPage, FeedbackPageErrorBoundary, type FeedbackAiAccess } from '../../src/app/pages/FeedbackPage.js';
import type { ExtPageServices } from '../../src/app/pages/ExtUi.js';

interface Ctx {
  bank: BankService;
  ext: BankExtServices;
  store: MockBankStore;
}

function createCtx(): Ctx {
  const store = new MockBankStore();
  return { bank: new MockBankService(store), ext: createMockExtServices(store), store };
}

let ctx: Ctx;
let svc: ExtPageServices;

beforeEach(() => {
  ctx = createCtx();
  svc = { bank: ctx.bank, ext: ctx.ext };
  window.localStorage.clear();
  delete window.__mofangFile;
});

let container: HTMLDivElement;
let root: Root | null = null;

function render(ui: ReactElement) {
  root?.unmount();
  container?.remove();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => {
    root!.render(ui);
  });
}

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  vi.restoreAllMocks();
});

function clickBtn(selector: string) {
  const el = container.querySelector(selector);
  if (!el) throw new Error(`找不到元素: ${selector}`);
  flushSync(() => (el as HTMLButtonElement).click());
}

function setInput(selector: string, value: string) {
  const el = container.querySelector(selector);
  if (!el) throw new Error(`找不到输入框: ${selector}`);
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  setter.call(el, value);
  (el as HTMLInputElement).dispatchEvent(new Event('input', { bubbles: true }));
}

function setSelect(selector: string, value: string) {
  const el = container.querySelector(selector);
  if (!(el instanceof HTMLSelectElement)) throw new Error(`找不到下拉: ${selector}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/** 在输入框上回车（自填标签的提交方式） */
function clickEnter(selector: string) {
  const el = container.querySelector(selector);
  if (!el) throw new Error(`找不到输入框: ${selector}`);
  flushSync(() => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
}

function textOf(selector: string): string {
  const el = container.querySelector(selector);
  if (!el) throw new Error(`找不到元素: ${selector}`);
  return el.textContent ?? '';
}

function valueOf(selector: string): string {
  const el = container.querySelector(selector);
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
    throw new Error(`找不到输入框: ${selector}`);
  }
  return el.value;
}

async function waitFor(assertion: () => void) {
  await vi.waitFor(assertion, { timeout: 4000, interval: 20 });
}

/** 假 AI 面：档案列表 + 可注入正文的 invoke（记录收到的 payload 供提示词断言） */
function makeAi(invokeImpl: (payload: AiInvokePayload) => Promise<AiInvokeResult>): {
  ai: FeedbackAiAccess;
  calls: AiInvokePayload[];
} {
  const calls: AiInvokePayload[] = [];
  const profile: ModelProfile = {
    id: 'profile-reasoning', role: 'reasoning', name: '测试档', provider: 'siliconflow',
    protocol: 'openai-chat', baseUrl: 'https://api.example.com/v1', model: 'test-model',
    capability: null, isEnabled: true, hasKey: true, lastTestAt: null, lastTestOk: null,
    createdAt: '2026-09-22T00:00:00Z', updatedAt: '2026-09-22T00:00:00Z',
  };
  return {
    ai: {
      listProfiles: async () => [profile],
      invoke: async (payload) => {
        calls.push(payload);
        return invokeImpl(payload);
      },
    },
    calls,
  };
}

/** 建班 + 5 名学生 + 考试（3 人带分）+ 表现事件（班级批量全链数据） */
async function seedClassScenario(): Promise<{ classId: string; classId2: string; ids: string[] }> {
  const cls = await ctx.ext.class.createClass({ name: '初二（3）班' });
  const cls2 = await ctx.ext.class.createClass({ name: '初二（5）班' });
  const ids: string[] = [];
  for (const name of ['陈小明', '李思颖', '王浩', '赵雨桐', '周天']) {
    const s = await ctx.ext.student.createStudent({ name });
    await ctx.ext.student.enrollStudent(s.id, cls.id);
    ids.push(s.id);
  }
  const exam = await ctx.ext.exam.createExam({ title: '第九章单元测', classId: cls.id, occurredAt: '2026-09-19T00:00:00Z' });
  await ctx.ext.exam.recordScores(exam.id, [
    { studentId: ids[0]!, score: 82 },
    { studentId: ids[1]!, score: 95 },
    { studentId: ids[2]!, score: 61 },
  ]);
  await ctx.ext.student.addEvent({
    studentId: ids[0]!, eventType: 'performance', occurredAt: '2026-09-19T00:00:00Z',
    payload: { eventType: 'performance', text: '课上积极发言' },
  });
  return { classId: cls.id, classId2: cls2.id, ids };
}

/** 选班级（等下拉装载） */
async function pickClass(classId: string) {
  await waitFor(() => {
    const select = container.querySelector('[data-testid="fb-batch-class"]') as HTMLSelectElement | null;
    if (!select || ![...select.options].some((o) => o.value !== '')) throw new Error('班级下拉未装载');
  });
  setSelect('[data-testid="fb-batch-class"]', classId);
  await waitFor(() => {
    const rows = container.querySelectorAll('[data-testid^="fb-batch-row-"]');
    if (rows.length !== 5) throw new Error(`名单未渲染: ${rows.length}`);
  });
}

describe('0030 页头动作（第二轮②）：无「提示词模板」按钮', () => {
  it('页头动作区不再有跳设置页的按钮（入口只留页签）', async () => {
    render(<FeedbackPage svc={svc} ai={{ listProfiles: async () => [], invoke: async () => ({ ok: false, error: 'n/a', latencyMs: 0 }) }} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="fb-quick-name"]')) throw new Error('页面未就绪');
    });
    expect(container.querySelector('[data-testid="fb-open-prompts"]')).toBeNull();
    expect(container.querySelector('[data-testid="fb-tab-settings"]')).not.toBeNull();
  });
});

describe('0030 快速模式：离线档（未配 AI）', () => {
  it('填四项 → 生成草稿（离线模板）→ 可编辑 → 保存记录（未关联留痕）', async () => {
    render(<FeedbackPage svc={svc} ai={{ listProfiles: async () => [], invoke: async () => ({ ok: false, error: '不应被调用', latencyMs: 0 }) }} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="fb-quick-name"]')) throw new Error('页面未就绪');
    });
    // 未配置 AI → 生成方式默认「模板生成」，并明示原因（目检返工④：显式开关）
    await waitFor(() => {
      if (!textOf('[data-testid="fb-quick-channel-note"]').includes('未配置 AI')) throw new Error('未明示离线档');
    });
    expect(container.querySelector('[data-testid="fb-quick-engine-template"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="fb-quick-template-select"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="fb-quick-prompt-select"]')).toBeNull();

    setInput('[data-testid="fb-quick-name"]', '陈小明');
    setInput('[data-testid="fb-quick-topic"]', '牛顿第二定律');
    setInput('[data-testid="fb-quick-content"]', '牛顿第二定律：F=ma 的理解与简单计算，做了 4 道课堂练习');
    setInput('[data-testid="fb-quick-homework"]', '完成练习册 P32 第 1-6 题');
    setInput('[data-testid="fb-quick-score"]', '82');
    setInput('[data-testid="fb-quick-score-title"]', '课堂小测');
    setInput('[data-testid="fb-quick-note"]', '今天有点咳嗽，别写太重');
    clickBtn('[data-testid="fb-quick-perf-专注"]');
    // 一次性具体表现（第二轮返工④：不进标签库、不显示成标签 chip，只作为这位学生这一次的事实）
    setInput('[data-testid="fb-quick-extra-input"]', '自己检查了错题');
    clickBtn('[data-testid="fb-quick-extra-add"]');
    await waitFor(() => {
      if (!container.querySelector('[data-testid="fb-quick-extra-0"]')) throw new Error('一次性表现未加入');
    });
    expect(textOf('[data-testid="fb-quick-extra-0"]')).toContain('自己检查了错题');
    // 它不是标签：标签行里没有它
    expect(container.querySelector('[data-testid="fb-quick-perf-自己检查了错题"]')).toBeNull();

    clickBtn('[data-testid="fb-quick-generate"]');
    await waitFor(() => {
      if (valueOf('[data-testid="fb-quick-result-text"]').trim() === '') throw new Error('未生成');
    });
    const text = valueOf('[data-testid="fb-quick-result-text"]');
    expect(text).toContain('陈小明家长您好');
    expect(text).toContain('牛顿第二定律');
    expect(text).toContain('上课时专注、自己检查了错题。');
    expect(text).toContain('本次课堂小测得 82 分。');
    expect(text).toContain('课后安排：完成练习册 P32 第 1-6 题。');
    // 备注是「给 AI 的补充说明」，不进离线正文
    expect(text).not.toContain('咳嗽');
    // 未收集的键留空不留残迹（0005 模板尾部 ——{老师姓名}）
    expect(text).not.toContain('——');
    // 离线档确定性输出 → 红线检查通过
    expect(textOf('[data-testid="fb-quick-guard"]')).toContain('通过');

    // 可编辑（以编辑后正文为准）
    setInput('[data-testid="fb-quick-result-text"]', '改过的正文');
    await waitFor(() => {
      if (valueOf('[data-testid="fb-quick-result-text"]') !== '改过的正文') throw new Error('编辑未生效');
    });

    clickBtn('[data-testid="fb-quick-save"]');
    await waitFor(() => {
      if (!textOf('[data-testid="page-message"]').includes('已保存记录')) throw new Error('未提示保存成功');
    });

    const saved = await ctx.ext.feedbackRecord.listRecords();
    expect(saved).toHaveLength(1);
    expect(saved[0]!.studentId).toBeNull();
    expect(saved[0]!.studentName).toBe('陈小明');
    expect(saved[0]!.body).toBe('改过的正文');
    expect(saved[0]!.channel).toBe('offline');
    expect(JSON.parse(saved[0]!.inputJson)['成绩']).toBe('82分（课堂小测）');

    // 记录页可见 + 「未关联」标
    clickBtn('[data-testid="fb-tab-records"]');
    await waitFor(() => {
      if (!container.querySelector('[data-testid="fb-record-row-0"]')) throw new Error('记录页未列出');
    });
    expect(container.querySelector('[data-testid="fb-record-unlinked-0"]')).not.toBeNull();
    expect(textOf('[data-testid="fb-record-row-0"]')).toContain('陈小明');
    expect(textOf('[data-testid="fb-records-count"]')).toContain('共 1 条');
  });
});

describe('0030 快速模式：AI 档 + 红线守卫不硬拦', () => {
  it('配 AI → 提示词带四项事实与风格档位；AI 把 82 写成 92 → 标红；保存弹层提示后可仍然保存', async () => {
    const { ai, calls } = makeAi(async () => ({
      ok: true,
      content: '陈小明家长您好！这节课我们学习了牛顿第二定律，本次课堂小测得 92 分，值得表扬。',
      latencyMs: 9,
    }));
    render(<FeedbackPage svc={svc} ai={ai} />);
    await waitFor(() => {
      if (!textOf('[data-testid="fb-quick-channel-note"]').includes('AI 润色')) throw new Error('AI 档未就绪');
    });
    expect(container.querySelector('[data-testid="fb-quick-prompt-select"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="fb-quick-template-select"]')).toBeNull();

    setInput('[data-testid="fb-quick-name"]', '陈小明');
    setInput('[data-testid="fb-quick-topic"]', '牛顿第二定律');
    setInput('[data-testid="fb-quick-content"]', '牛顿第二定律：F=ma 的理解与简单计算，做了 4 道课堂练习');
    setInput('[data-testid="fb-quick-note"]', '今天有点咳嗽，别写太重');
    setInput('[data-testid="fb-quick-score"]', '82');
    setInput('[data-testid="fb-quick-score-title"]', '课堂小测');
    clickBtn('[data-testid="fb-quick-perf-专注"]');
    clickBtn('[data-testid="fb-quick-tone-objective"]');
    clickBtn('[data-testid="fb-quick-length-long"]');
    clickBtn('[data-testid="fb-quick-family-off"]');

    clickBtn('[data-testid="fb-quick-generate"]');
    await waitFor(() => {
      if (!valueOf('[data-testid="fb-quick-result-text"]').includes('92 分')) throw new Error('AI 正文未回填');
    });
    // 提示词：事实注入 + 风格三维逐档
    expect(calls).toHaveLength(1);
    const prompt = calls[0]!.messages[0]!.content as string;
    expect(calls[0]!.role).toBe('reasoning');
    expect(prompt).toContain('课程主题：牛顿第二定律');
    expect(prompt).toContain('课堂内容：牛顿第二定律');
    expect(prompt).toContain('课堂表现：专注');
    expect(prompt).toContain('测试成绩：82分（课堂小测）');
    // 0059：备注槽标签升级为「只用来把握语气和详略」整串（组装器只替换槽位本身，标签+值连续出现）
    expect(prompt).toContain('备注（只用来把握语气和详略，不要照抄进正文）：今天有点咳嗽，别写太重');
    expect(prompt).toContain('语气：专业客观。篇幅：约 350 字。不要写家庭建议。');

    // 守卫标红可见（数字 92 与登记 82 不一致）
    await waitFor(() => {
      if (!textOf('[data-testid="fb-quick-guard"]').includes('待核对')) throw new Error('守卫未标红');
    });
    expect(textOf('[data-testid="fb-quick-hit-list"]')).toContain('92');

    // 保存 → 弹层提示 N 条待核对（不硬拦）→ 仍然保存
    clickBtn('[data-testid="fb-quick-save"]');
    await waitFor(() => {
      if (!container.querySelector('[data-testid="fb-guard-save-modal"]')) throw new Error('未弹提示层');
    });
    expect(textOf('[data-testid="fb-guard-save-modal"]')).toContain('待核对');
    expect(await ctx.ext.feedbackRecord.listRecords()).toHaveLength(0); // 未确认前不落库
    clickBtn('[data-testid="fb-guard-save-anyway"]');
    await waitFor(async () => {
      if ((await ctx.ext.feedbackRecord.listRecords()).length !== 1) throw new Error('未落库');
    });
    const record = (await ctx.ext.feedbackRecord.listRecords())[0]!;
    expect(record.channel).toBe('ai');
    expect(record.modelProfileId).toBe('profile-reasoning');
    expect(record.promptSnapshot).toContain('语气：专业客观');
  });

  it('AI 失败（网关 ok:false）→ 错误可见、不出草稿、不静默回落离线档', async () => {
    const { ai } = makeAi(async () => ({ ok: false, error: '网关超时（60000ms）', latencyMs: 60000 }));
    render(<FeedbackPage svc={svc} ai={ai} />);
    await waitFor(() => {
      if (!textOf('[data-testid="fb-quick-channel-note"]').includes('AI 润色')) throw new Error('AI 档未就绪');
    });
    setInput('[data-testid="fb-quick-name"]', '陈小明');
    setInput('[data-testid="fb-quick-content"]', '牛顿第二定律');
    clickBtn('[data-testid="fb-quick-generate"]');
    await waitFor(() => {
      if (!textOf('[data-testid="page-message"]').includes('网关超时')) throw new Error('失败未可见');
    });
    expect(valueOf('[data-testid="fb-quick-result-text"]')).toBe('');
  });
});

describe('0030 一次性表现条目（第二轮返工④）：可加可删、不进标签库', () => {
  it('加入一条具体表现 → 出现在条目区并可删除；标签行不含它', async () => {
    render(<FeedbackPage svc={svc} ai={{ listProfiles: async () => [], invoke: async () => ({ ok: false, error: 'n/a', latencyMs: 0 }) }} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="fb-quick-extra-input"]')) throw new Error('页面未就绪');
    });
    setInput('[data-testid="fb-quick-extra-input"]', '今天主动帮同学讲题');
    clickBtn('[data-testid="fb-quick-extra-add"]');
    await waitFor(() => {
      if (!container.querySelector('[data-testid="fb-quick-extra-0"]')) throw new Error('未加入');
    });
    expect(valueOf('[data-testid="fb-quick-extra-input"]')).toBe(''); // 输入框清空，可接着加下一条
    expect(container.querySelector('[data-testid="fb-quick-perf-今天主动帮同学讲题"]')).toBeNull();

    clickBtn('[data-testid="fb-quick-extra-del-0"]');
    await waitFor(() => {
      if (container.querySelector('[data-testid="fb-quick-extra-0"]')) throw new Error('未删除');
    });
  });
});

describe('0030 生成方式开关（目检返工④）：开着用 AI、关掉用模板', () => {
  it('配了 AI 档案但手动关掉 → 走离线模板生成，且不调用 ai.invoke', async () => {
    const invoke = vi.fn(async (): Promise<AiInvokeResult> => ({ ok: true, content: '不应被用到', latencyMs: 1 }));
    render(<FeedbackPage svc={svc} ai={{
      listProfiles: async () => [{
        id: 'p1', role: 'reasoning', name: '档', provider: 'x', protocol: 'openai-chat',
        baseUrl: 'https://x/v1', model: 'm', capability: null, isEnabled: true, hasKey: true,
        lastTestAt: null, lastTestOk: null, createdAt: '2026-09-22T00:00:00Z', updatedAt: '2026-09-22T00:00:00Z',
      }],
      invoke,
    }} />);
    await waitFor(() => {
      if (!textOf('[data-testid="fb-quick-channel-note"]').includes('AI 润色')) throw new Error('AI 档未就绪');
    });
    clickBtn('[data-testid="fb-quick-engine-template"]');
    await waitFor(() => {
      if (!textOf('[data-testid="fb-quick-channel-note"]').includes('模板生成')) throw new Error('未切到模板生成');
    });
    expect(container.querySelector('[data-testid="fb-quick-template-select"]')).not.toBeNull();

    setInput('[data-testid="fb-quick-name"]', '陈小明');
    setInput('[data-testid="fb-quick-content"]', '欧姆定律 I=U/R');
    clickBtn('[data-testid="fb-quick-generate"]');
    await waitFor(() => {
      if (!valueOf('[data-testid="fb-quick-result-text"]').includes('陈小明家长您好')) throw new Error('未生成');
    });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('0030 快速模式进度提示（第二轮返工③）：AI 生成中有动进度条', () => {
  it('生成中显示读条与「生成中」文案，返回后消失', async () => {
    let release: (r: AiInvokeResult) => void = () => {};
    const pending = new Promise<AiInvokeResult>((resolve) => { release = resolve; });
    const profile = {
      id: 'p1', role: 'reasoning' as const, name: '档', provider: 'x', protocol: 'openai-chat',
      baseUrl: 'https://x/v1', model: 'm', capability: null, isEnabled: true, hasKey: true,
      lastTestAt: null, lastTestOk: null, createdAt: '2026-09-22T00:00:00Z', updatedAt: '2026-09-22T00:00:00Z',
    };
    render(<FeedbackPage svc={svc} ai={{ listProfiles: async () => [profile], invoke: () => pending }} />);
    await waitFor(() => {
      if (!textOf('[data-testid="fb-quick-channel-note"]').includes('AI 润色')) throw new Error('AI 档未就绪');
    });
    setInput('[data-testid="fb-quick-name"]', '陈小明');
    setInput('[data-testid="fb-quick-content"]', '欧姆定律');
    clickBtn('[data-testid="fb-quick-generate"]');
    await waitFor(() => {
      const note = container.querySelector('[data-testid="fb-quick-progress"]');
      if (!note || !(note.textContent ?? '').includes('生成中')) throw new Error('生成中没有进度提示');
    });
    release({ ok: true, content: '陈小明家长您好！本节课我们学习了欧姆定律，状态不错。', latencyMs: 5 });
    await waitFor(() => {
      if (container.querySelector('[data-testid="fb-quick-progress"]')) throw new Error('返回后进度提示未消失');
      if (!valueOf('[data-testid="fb-quick-result-text"]').includes('欧姆定律')) throw new Error('正文未回填');
    });
  });
});

describe('0030 班级批量：5 名学生走通 + 保存计入档案', () => {
  it('公共信息填一次、关联考试带成绩、逐人点表现、逐卡可编辑、一键落档', async () => {
    const { classId, ids } = await seedClassScenario();
    render(<FeedbackPage svc={svc} ai={{ listProfiles: async () => [], invoke: async () => ({ ok: false, error: 'n/a', latencyMs: 0 }) }} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="fb-tab-batch"]')) throw new Error('页面未就绪');
    });
    clickBtn('[data-testid="fb-tab-batch"]');
    await pickClass(classId);

    // 公共信息（全班共享填一次）
    setInput('[data-testid="fb-batch-topic"]', '欧姆定律');
    setInput('[data-testid="fb-batch-content"]', '欧姆定律 I=U/R，串并联电路计算；课堂练习 5 道');
    setInput('[data-testid="fb-batch-homework"]', '练习册 P45 第 1-8 题');

    // 关联考试 → 自动带出每人成绩（可手改）
    await waitFor(() => {
      const select = container.querySelector('[data-testid="fb-batch-exam"]') as HTMLSelectElement | null;
      if (!select || select.options.length < 2) throw new Error('考试未列出');
    });
    const examSelect = container.querySelector('[data-testid="fb-batch-exam"]') as HTMLSelectElement;
    setSelect('[data-testid="fb-batch-exam"]', examSelect.options[1]!.value);
    await waitFor(() => {
      if (valueOf(`[data-testid="fb-batch-score-${ids[0]}"]`) !== '82') throw new Error('成绩未带入');
    });
    expect(valueOf(`[data-testid="fb-batch-score-${ids[2]}"]`)).toBe('61');
    expect(valueOf(`[data-testid="fb-batch-score-${ids[3]}"]`)).toBe(''); // 缺考 → 留空不猜

    // 逐人点表现 + 个别备注（独立事实，不再当表现标签）+ 行内自填标签
    clickBtn(`[data-testid="fb-batch-perf-${ids[2]}-走神"]`);
    setInput(`[data-testid="fb-batch-note-${ids[2]}"]`, '公式记忆不牢');
    clickBtn(`[data-testid="fb-batch-extra-add-${ids[0]}"]`);
    setInput(`[data-testid="fb-batch-extra-input-${ids[0]}"]`, '自己整理笔记');
    clickEnter(`[data-testid="fb-batch-extra-input-${ids[0]}"]`);
    await waitFor(() => {
      if (!container.querySelector(`[data-testid="fb-batch-extra-${ids[0]}-0"]`)) throw new Error('一次性表现未加入');
    });
    expect(container.querySelector(`[data-testid="fb-batch-perf-${ids[0]}-自己整理笔记"]`)).toBeNull();
    // 一位不勾选（请假不生成）
    clickBtn(`[data-testid="fb-batch-student-${ids[4]}"]`);

    clickBtn('[data-testid="fb-batch-generate"]');
    await waitFor(() => {
      // 4 张卡（1 位未勾选）
      const cards = container.querySelectorAll('[data-testid^="fb-batch-card-text-"]');
      if (cards.length !== 4) throw new Error(`卡片数不符: ${cards.length}`);
      for (const card of cards) {
        if ((card as HTMLTextAreaElement).disabled) throw new Error('仍有卡片未生成完');
      }
    });
    const first = valueOf(`[data-testid="fb-batch-card-text-${ids[0]}"]`);
    expect(first).toContain('陈小明家长您好');
    expect(first).toContain('欧姆定律 I=U/R');
    expect(first).toContain('本次第九章单元测得 82 分。');
    expect(first).toContain('课后安排：练习册 P45 第 1-8 题。');
    expect(first).toContain('上课时自己整理笔记。');
    const third = valueOf(`[data-testid="fb-batch-card-text-${ids[2]}"]`);
    expect(third).toContain('上课时走神。');
    expect(third).toContain('本次第九章单元测得 61 分。');
    // 备注不进离线正文（给 AI 的补充说明）
    expect(third).not.toContain('公式记忆不牢');
    // 缺考学生：成绩段整体剔除
    expect(valueOf(`[data-testid="fb-batch-card-text-${ids[3]}"]`)).not.toContain('得 分');
    // 未勾选的学生不出卡
    expect(container.querySelector(`[data-testid="fb-batch-card-${ids[4]}"]`)).toBeNull();

    // 逐卡可编辑
    setInput(`[data-testid="fb-batch-card-text-${ids[1]}"]`, '李思颖家长您好！自定义文本。');
    await waitFor(() => {
      if (!valueOf(`[data-testid="fb-batch-card-text-${ids[1]}"]`).includes('自定义文本')) throw new Error('编辑未生效');
    });

    // 底部汇总 + 保存记录（4）
    expect(textOf('[data-testid="fb-batch-summary"]')).toContain('已生成');
    expect(textOf('[data-testid="fb-batch-save"]')).toContain('保存记录（4）');
    clickBtn('[data-testid="fb-batch-save"]');
    await waitFor(async () => {
      if ((await ctx.ext.feedbackRecord.listRecords()).length !== 4) throw new Error('未落档');
    });
    const saved = await ctx.ext.feedbackRecord.listRecords();
    const linked = saved.filter((r) => r.studentId !== null);
    expect(linked).toHaveLength(4);
    expect(linked.every((r) => r.classId === classId)).toBe(true);
    expect(linked.every((r) => r.examId !== null)).toBe(true);
    const edited = saved.find((r) => r.studentName === '李思颖')!;
    expect(edited.body).toContain('自定义文本');
    // 草稿随保存清空
    expect(window.localStorage.getItem('mofang-feedback-batch-draft-v1')).toBeNull();
  });

  it('缺「课堂内容」→ 拦截并报错；未勾学生 → 拦截', async () => {
    const { classId, ids } = await seedClassScenario();
    render(<FeedbackPage svc={svc} ai={{ listProfiles: async () => [], invoke: async () => ({ ok: false, error: 'n/a', latencyMs: 0 }) }} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="fb-tab-batch"]')) throw new Error('页面未就绪');
    });
    clickBtn('[data-testid="fb-tab-batch"]');
    await pickClass(classId);

    clickBtn('[data-testid="fb-batch-generate"]');
    await waitFor(() => {
      if (!textOf('[data-testid="page-message"]').includes('课堂内容')) throw new Error('未拦截生成');
    });
    expect(container.querySelectorAll('[data-testid^="fb-batch-card-"]')).toHaveLength(0);

    setInput('[data-testid="fb-batch-content"]', '复习课');
    for (const id of ids) clickBtn(`[data-testid="fb-batch-student-${id}"]`);
    clickBtn('[data-testid="fb-batch-generate"]');
    await waitFor(() => {
      if (!textOf('[data-testid="page-message"]').includes('勾选')) throw new Error('未拦截未勾选');
    });
  });
});

describe('0030 批量草稿：填一半关页，重开能接着来', () => {
  it('卸载重挂后恢复公共信息、勾选与已生成卡片；可丢弃草稿', async () => {
    const { classId, ids } = await seedClassScenario();
    const noAi: FeedbackAiAccess = { listProfiles: async () => [], invoke: async () => ({ ok: false, error: 'n/a', latencyMs: 0 }) };
    render(<FeedbackPage svc={svc} ai={noAi} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="fb-tab-batch"]')) throw new Error('页面未就绪');
    });
    clickBtn('[data-testid="fb-tab-batch"]');
    await pickClass(classId);
    setInput('[data-testid="fb-batch-content"]', '欧姆定律复习');
    clickBtn(`[data-testid="fb-batch-perf-${ids[0]}-积极"]`);
    clickBtn(`[data-testid="fb-batch-student-${ids[1]}"]`); // 取消勾选一位
    clickBtn('[data-testid="fb-batch-generate"]');
    await waitFor(() => {
      if (container.querySelectorAll('[data-testid^="fb-batch-card-text-"]').length !== 4) throw new Error('未生成完');
    });
    await waitFor(() => {
      const raw = window.localStorage.getItem('mofang-feedback-batch-draft-v1');
      if (!raw) throw new Error('草稿未落盘');
      const cards = (JSON.parse(raw) as { cards: Array<{ status: string; text: string }> }).cards;
      if (cards.length !== 4 || !cards.every((c) => c.status === 'done' && c.text.includes('欧姆定律复习'))) {
        throw new Error(`草稿未落到稳定态: ${cards.map((c) => c.status).join(',')}`);
      }
    });

    // 关页重开（同一 localStorage）
    render(<FeedbackPage svc={svc} ai={noAi} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="fb-batch-draft-banner"]')) throw new Error('草稿横幅未出现');
    });
    await waitFor(() => {
      if (container.querySelectorAll('[data-testid^="fb-batch-card-text-"]').length !== 4) throw new Error('卡片未恢复');
    });
    await waitFor(() => {
      if (container.querySelectorAll('[data-testid^="fb-batch-row-"]').length !== 5) throw new Error('名单未恢复');
    });
    expect(valueOf('[data-testid="fb-batch-content"]')).toBe('欧姆定律复习');
    expect((container.querySelector(`[data-testid="fb-batch-student-${ids[1]}"]`) as HTMLInputElement).checked).toBe(false);
    expect((container.querySelector(`[data-testid="fb-batch-student-${ids[0]}"]`) as HTMLInputElement).checked).toBe(true);
    expect(valueOf(`[data-testid="fb-batch-card-text-${ids[0]}"]`)).toContain('欧姆定律复习');

    clickBtn('[data-testid="fb-batch-draft-discard"]');
    await waitFor(() => {
      if (container.querySelector('[data-testid="fb-batch-draft-banner"]')) throw new Error('丢弃后横幅仍在');
    });
    expect(window.localStorage.getItem('mofang-feedback-batch-draft-v1')).toBeNull();
  });
});

describe('0030 旧版草稿兼容（白屏回归）', () => {
  it('上一版草稿（行里没有 extras/topic 字段）→ 打开页面不崩，行照常可用', async () => {
    const { classId, ids } = await seedClassScenario();
    // 模拟用户机器上的旧草稿（返工轮一写入的形态：行里只有 selected/score/note/tags，无 extras）
    window.localStorage.setItem('mofang-feedback-batch-draft-v1', JSON.stringify({
      savedAt: '2026-09-22T09:00:00Z',
      classId,
      examId: '',
      content: '旧内容：欧姆定律',
      homework: '旧作业',
      style: { tone: 'warm', length: 'medium', familyAdvice: true },
      promptTemplateId: '',
      offlineTemplateId: '',
      rows: Object.fromEntries(ids.map((id) => [id, { selected: true, score: '80', note: '旧备注', tags: ['专注'] }])),
      cards: [],
    }));

    render(<FeedbackPage svc={svc} ai={{ listProfiles: async () => [], invoke: async () => ({ ok: false, error: 'n/a', latencyMs: 0 }) }} />);
    // 有草稿 → 直接落班级批量；关键：旧行缺 extras 也不能崩（白屏回归）
    await waitFor(() => {
      if (!container.querySelector('[data-testid="fb-batch-draft-banner"]')) throw new Error('草稿未恢复');
    });
    await waitFor(() => {
      if (container.querySelectorAll('[data-testid^="fb-batch-row-"]').length !== 5) throw new Error('名单未渲染');
    });
    expect(valueOf('[data-testid="fb-batch-content"]')).toBe('旧内容：欧姆定律');
    expect(valueOf(`[data-testid="fb-batch-score-${ids[0]}"]`)).toBe('80');
    expect((container.querySelector(`[data-testid="fb-batch-student-${ids[0]}"]`) as HTMLInputElement).checked).toBe(true);
    // 旧行的标签仍在；一次性表现区为空（升级后补齐空数组）
    expect(container.querySelector(`[data-testid="fb-batch-perf-${ids[0]}-专注"]`)).not.toBeNull();
    expect(container.querySelector(`[data-testid="fb-batch-extra-${ids[0]}-0"]`)).toBeNull();

    // 旧行照常能加一次性表现并生成
    clickBtn(`[data-testid="fb-batch-extra-add-${ids[0]}"]`);
    setInput(`[data-testid="fb-batch-extra-input-${ids[0]}"]`, '今天状态不错');
    clickEnter(`[data-testid="fb-batch-extra-input-${ids[0]}"]`);
    await waitFor(() => {
      if (!container.querySelector(`[data-testid="fb-batch-extra-${ids[0]}-0"]`)) throw new Error('旧行不能加一次性表现');
    });
    clickBtn('[data-testid="fb-batch-generate"]');
    await waitFor(() => {
      const cards = container.querySelectorAll('[data-testid^="fb-batch-card-text-"]');
      if (cards.length !== 5) throw new Error('未生成');
      for (const card of cards) {
        if ((card as HTMLTextAreaElement).disabled) throw new Error('未生成完');
      }
    });
    expect(valueOf(`[data-testid="fb-batch-card-text-${ids[0]}"]`)).toContain('旧内容：欧姆定律');
  });
});

describe('0030 白屏兜底（错误边界）', () => {
  it('子组件抛错 → 显示可读提示 + 一键清理本地草稿，而非死白屏', async () => {
    // 造一份草稿，验证重置按钮真的清掉了它
    window.localStorage.setItem('mofang-feedback-batch-draft-v1', '{"classId":"c1"}');
    window.localStorage.setItem('mofang-feedback-perf-tags-v1', '[{"label":"x","tone":"pos"}]');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {}); // 边界会打印 React 错误，测试里静音

    // 只抛一次：模拟「旧数据形态导致的一次性崩溃」，重试后应恢复正常渲染
    let shouldThrow = true;
    function Boom(): ReactElement {
      if (shouldThrow) throw new Error('模拟渲染期异常');
      return <div data-testid="fb-page-recovered">恢复正常</div>;
    }
    render(
      <FeedbackPageErrorBoundary>
        <Boom />
      </FeedbackPageErrorBoundary>,
    );
    expect(textOf('[data-testid="fb-page-error"]')).toContain('模拟渲染期异常');
    shouldThrow = false;
    clickBtn('[data-testid="fb-page-error-reset"]');
    await waitFor(() => {
      if (container.querySelector('[data-testid="fb-page-error"]')) throw new Error('未复原');
    });
    expect(window.localStorage.getItem('mofang-feedback-batch-draft-v1')).toBeNull();
    expect(window.localStorage.getItem('mofang-feedback-perf-tags-v1')).toBeNull();
    spy.mockRestore();
  });
});

describe('0030 反馈记录页：筛选与操作', () => {
  it('班级 chip + 姓名搜索；查看详情；删除（两步确认）', async () => {
    const { classId, classId2, ids } = await seedClassScenario();
    await ctx.ext.feedbackRecord.createRecord({
      studentId: ids[0]!, studentName: '陈小明', classId, channel: 'ai', inputJson: '{}', body: '陈小明的反馈正文',
    });
    await ctx.ext.feedbackRecord.createRecord({
      studentName: '刘一凡', channel: 'offline', inputJson: '{}', body: '刘一凡的反馈正文',
    });
    void classId2;
    render(<FeedbackPage svc={svc} ai={{ listProfiles: async () => [], invoke: async () => ({ ok: false, error: 'n/a', latencyMs: 0 }) }} />);
    clickBtn('[data-testid="fb-tab-records"]');
    await waitFor(() => {
      if (container.querySelectorAll('[data-testid^="fb-record-row-"]').length !== 2) throw new Error('记录未列出');
    });

    // 班级筛选
    clickBtn(`[data-testid="fb-records-filter-${classId}"]`);
    await waitFor(() => {
      if (container.querySelectorAll('[data-testid^="fb-record-row-"]').length !== 1) throw new Error('班级筛选未生效');
    });
    expect(textOf('[data-testid="fb-record-row-0"]')).toContain('陈小明');

    // 姓名搜索（清掉班级筛选）
    clickBtn('[data-testid="fb-records-filter-all"]');
    await waitFor(() => {
      if (container.querySelectorAll('[data-testid^="fb-record-row-"]').length !== 2) throw new Error('未回到全量');
    });
    setInput('[data-testid="fb-records-search"]', '刘一凡');
    await waitFor(() => {
      if (container.querySelectorAll('[data-testid^="fb-record-row-"]').length !== 1) throw new Error('姓名搜索未生效');
    });
    expect(container.querySelector('[data-testid="fb-record-unlinked-0"]')).not.toBeNull();

    // 查看详情 → 正文可见
    clickBtn('[data-testid="fb-record-view-0"]');
    await waitFor(() => {
      if (!textOf('[data-testid="fb-record-detail"]').includes('刘一凡的反馈正文')) throw new Error('详情未展开');
    });
    clickBtn('.modal-close');

    // 删除（两步确认：第一次进入待确认态，第二次执行）
    clickBtn('[data-testid="fb-record-delete-0"]');
    clickBtn('[data-testid="fb-record-delete-0"]');
    await waitFor(async () => {
      if ((await ctx.ext.feedbackRecord.listRecords()).length !== 1) throw new Error('删除未生效');
    });
  });
});

describe('0030 提示词模板：内置只读 + 另存自定义 + 导出/导入', () => {
  it('内置只读（无保存/删除，有另存）；另存后可改可保存；导出通道收到 pack 文本', async () => {
    const exportTextFile = vi.fn(async () => ({ filePath: 'D:/tmp/x.txt' }));
    const importFile = vi.fn(async (): Promise<FileImportTextResult | null> => null);
    window.__mofangFile = {
      exportTextFile,
      importTextFile: importFile,
    } as unknown as MofangFileBridge;

    render(<FeedbackPage svc={svc} ai={{ listProfiles: async () => [], invoke: async () => ({ ok: false, error: 'n/a', latencyMs: 0 }) }} />);
    clickBtn('[data-testid="fb-tab-settings"]');
    await waitFor(() => {
      if (!container.querySelector('[data-testid="fb-prompt-item-feedback-prompt-builtin-general"]')) throw new Error('内置模板未列出');
    });
    // 内置只读
    expect((container.querySelector('[data-testid="fb-prompt-name"]') as HTMLInputElement).readOnly).toBe(true);
    expect((container.querySelector('[data-testid="fb-prompt-body"]') as HTMLTextAreaElement).readOnly).toBe(true);
    expect(container.querySelector('[data-testid="fb-prompt-save"]')).toBeNull();
    expect(container.querySelector('[data-testid="fb-prompt-delete"]')).toBeNull();
    expect(textOf('[data-testid="fb-prompt-vars"]')).toContain('{学生姓名}');
    expect(textOf('[data-testid="fb-prompt-vars"]')).toContain('{课程主题}');
    expect(textOf('[data-testid="fb-prompt-vars"]')).toContain('{备注}');
    expect(textOf('[data-testid="fb-prompt-vars"]')).toContain('{语气}');

    // ＋新建提示词模板 → 右侧空表单（先建再填），填完点「新建」才落库
    clickBtn('[data-testid="fb-prompt-new"]');
    await waitFor(() => {
      if (!container.querySelector('[data-testid="fb-prompt-create"]')) throw new Error('新建表单未展开');
    });
    expect(valueOf('[data-testid="fb-prompt-name"]')).toBe('');
    expect(valueOf('[data-testid="fb-prompt-body"]')).toContain('{学生姓名}');
    expect(container.querySelector('[data-testid="fb-prompt-save"]')).toBeNull(); // 新建态没有「保存」
    setInput('[data-testid="fb-prompt-name"]', '我的·新建版');
    setInput('[data-testid="fb-prompt-body"]', '给学生{学生姓名}写反馈：{课堂内容}。语气：{语气}。');
    clickBtn('[data-testid="fb-prompt-create"]');
    await waitFor(async () => {
      const list = await ctx.ext.feedbackPrompt.listTemplates();
      if (!list.some((t) => t.name === '我的·新建版')) throw new Error('新建未落库');
    });
    await waitFor(() => {
      if (!container.querySelector('[data-testid="fb-prompt-save"]')) throw new Error('新建后未切到编辑态');
    });

    // 另存为我的模板（先选回内置那条）→ 副本可改可保存
    clickBtn('[data-testid="fb-prompt-item-feedback-prompt-builtin-general"]');
    await waitFor(() => {
      if (!container.querySelector('[data-testid="fb-prompt-save-as"]')) throw new Error('内置模板面板未展开');
    });
    clickBtn('[data-testid="fb-prompt-save-as"]');
    await waitFor(() => {
      if (container.querySelector('[data-testid="fb-prompt-save"]') === null) throw new Error('另存后仍不可编辑');
    });
    expect(valueOf('[data-testid="fb-prompt-name"]')).toContain('副本');
    setInput('[data-testid="fb-prompt-body"]', '给学生{学生姓名}写反馈：{课堂内容}。语气：{语气}。');
    clickBtn('[data-testid="fb-prompt-save"]');
    await waitFor(async () => {
      const list = await ctx.ext.feedbackPrompt.listTemplates();
      if (!list.some((t) => t.body.includes('写反馈：{课堂内容}'))) throw new Error('自定义模板未保存');
    });

    // 导出（pack 文本进 file 通道）
    clickBtn('[data-testid="fb-prompt-export"]');
    await waitFor(() => {
      if (exportTextFile.mock.calls.length === 0) throw new Error('未走导出通道');
    });
    const exported = exportTextFile.mock.calls[0]![0] as { suggestedName: string; content: string };
    expect(exported.content).toContain('name: ');
    expect(exported.content).toContain('写反馈：{课堂内容}');

    // 导入（file 通道回 pack → 解析建模板 → 选中）
    importFile.mockResolvedValueOnce({
      fileName: '考后版.txt',
      content: '# 魔方助教 · 反馈提示词模板\nname: 考后版\n---\n给学生{学生姓名}写考后反馈。{成绩}\n',
    });
    clickBtn('[data-testid="fb-prompt-import"]');
    await waitFor(async () => {
      const list = await ctx.ext.feedbackPrompt.listTemplates();
      if (!list.some((t) => t.name === '考后版')) throw new Error('导入未建模板');
    });
    expect(valueOf('[data-testid="fb-prompt-body"]')).toContain('写考后反馈');
  });

  it('内置模板守卫：直接改内置正文不可保存（保存按钮不存在）+ 服务层拒绝（契约双跑覆盖）', async () => {
    render(<FeedbackPage svc={svc} ai={{ listProfiles: async () => [], invoke: async () => ({ ok: false, error: 'n/a', latencyMs: 0 }) }} />);
    clickBtn('[data-testid="fb-tab-settings"]');
    await waitFor(() => {
      if (!container.querySelector('[data-testid="fb-prompt-item-feedback-prompt-builtin-general"]')) throw new Error('内置模板未列出');
    });
    const builtin = (await ctx.ext.feedbackPrompt.listTemplates()).find((t) => t.isBuiltin)!;
    await expect(ctx.ext.feedbackPrompt.updateTemplate(builtin.id, { body: 'x' })).rejects.toThrow();
    expect(container.querySelector('[data-testid="fb-prompt-save"]')).toBeNull();
    expect(container.querySelector('[data-testid="fb-prompt-save-as"]')).not.toBeNull();
  });
});

describe('0030 导出区整体隐藏（目检返工⑤ + 第二轮①）', () => {
  it('导出面板（txt/卡片 PNG/样式/徽标）全部不出现；快速与批量两页签都没有', async () => {
    render(<FeedbackPage svc={svc} ai={{ listProfiles: async () => [], invoke: async () => ({ ok: false, error: 'n/a', latencyMs: 0 }) }} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="fb-quick-name"]')) throw new Error('页面未就绪');
    });
    expect(container.querySelector('[data-testid="feedback-export-txt"]')).toBeNull();
    expect(container.querySelector('[data-testid="feedback-export-cards"]')).toBeNull();
    expect(container.querySelector('[data-testid="feedback-card-style"]')).toBeNull();
    expect(container.querySelector('[data-testid="feedback-logo-demo-input"]')).toBeNull();
    clickBtn('[data-testid="fb-tab-batch"]');
    await waitFor(() => {
      if (!container.querySelector('[data-testid="fb-batch-class"]')) throw new Error('批量页未就绪');
    });
    expect(container.querySelector('[data-testid="feedback-export-txt"]')).toBeNull();
    // 批量「全部复制」仍在（导出没了不等于复制没了）
    expect(container.querySelector('[data-testid="fb-batch-copy-all"]')).not.toBeNull();
  });
});

describe('0030 反馈设置：主从结构（左侧选中 → 右侧展开该项）', () => {
  it('右侧同时只显示一类内容；点不同条目右侧跟着换', async () => {
    render(<FeedbackPage svc={svc} ai={{ listProfiles: async () => [], invoke: async () => ({ ok: false, error: 'n/a', latencyMs: 0 }) }} />);
    clickBtn('[data-testid="fb-tab-settings"]');
    await waitFor(() => {
      if (!container.querySelector('[data-testid="fb-prompt-item-feedback-prompt-builtin-general"]')) throw new Error('设置页未就绪');
    });

    // 默认：右侧是「提示词模板」编辑区（三块不再并排）
    expect(container.querySelector('[data-testid="fb-prompt-name"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="feedback-template-name-input"]')).toBeNull();
    expect(container.querySelector('[data-testid="fb-tag-edit-name"]')).toBeNull();
    expect(container.querySelector('[data-testid="fb-tag-new-input"]')).toBeNull();

    // 点左侧某条离线模板 → 右侧换成离线模板编辑区
    clickBtn('[data-testid="feedback-template-row-feedback-tpl-builtin-default"]');
    await waitFor(() => {
      if (!container.querySelector('[data-testid="feedback-template-body-input"]')) throw new Error('右侧未展开离线模板');
    });
    expect(container.querySelector('[data-testid="fb-prompt-name"]')).toBeNull();
    expect(container.querySelector('[data-testid="fb-tag-edit-name"]')).toBeNull();

    // 左侧「课堂表现标签」是一个入口（标签不铺在左栏）→ 右侧出全部标签的管理面板
    expect(container.querySelector('[data-testid="fb-tag-row-专注"]')).toBeNull(); // 未点开时左栏没有标签行
    clickBtn('[data-testid="fb-settings-tags-entry"]');
    await waitFor(() => {
      if (!container.querySelector('[data-testid="fb-settings-panel-tag"]')) throw new Error('右侧未展开标签面板');
    });
    expect(container.querySelector('[data-testid="feedback-template-name-input"]')).toBeNull();
    expect(container.querySelector('[data-testid="fb-prompt-name"]')).toBeNull();
    // 面板里有全部标签（内置 + 自定义）；内置行无编辑/删除
    expect(container.querySelector('[data-testid="fb-tag-row-专注"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="fb-tag-row-走神"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="fb-tag-edit-专注"]')).toBeNull();
    expect(container.querySelector('[data-testid="fb-tag-del-专注"]')).toBeNull();
    // 左栏不再是标签列表（只此一个入口）
    expect(container.querySelectorAll('[data-testid^="fb-tag-row-"]').length).toBe(
      container.querySelectorAll('[data-testid="fb-settings-panel-tag"] [data-testid^="fb-tag-row-"]').length,
    );

    // 回提示词模板 → 右侧换回去
    clickBtn('[data-testid="fb-prompt-item-feedback-prompt-builtin-general"]');
    await waitFor(() => {
      if (!container.querySelector('[data-testid="fb-prompt-name"]')) throw new Error('右侧未换回提示词');
    });
    expect(container.querySelector('[data-testid="fb-tag-edit-name"]')).toBeNull();
  });

  it('标签面板：新增 → 列表出现；行内改名/换色 → 页面标签行同步；删除（两步）', async () => {
    render(<FeedbackPage svc={svc} ai={{ listProfiles: async () => [], invoke: async () => ({ ok: false, error: 'n/a', latencyMs: 0 }) }} />);
    clickBtn('[data-testid="fb-tab-settings"]');
    await waitFor(() => {
      if (!container.querySelector('[data-testid="fb-settings-tags-entry"]')) throw new Error('设置页未就绪');
    });
    clickBtn('[data-testid="fb-settings-tags-entry"]');
    await waitFor(() => {
      if (!container.querySelector('[data-testid="fb-tag-new-input"]')) throw new Error('标签面板未展开');
    });

    // 新增
    setInput('[data-testid="fb-tag-new-input"]', '听课认真');
    clickBtn('[data-testid="fb-tag-new-tone-neg"]');
    clickBtn('[data-testid="fb-tag-new-add"]');
    await waitFor(() => {
      if (!container.querySelector('[data-testid="fb-tag-row-听课认真"]')) throw new Error('新标签未入列表');
    });
    expect(valueOf('[data-testid="fb-tag-new-input"]')).toBe('');

    // 行内编辑：改名 + 改色
    clickBtn('[data-testid="fb-tag-edit-听课认真"]');
    await waitFor(() => {
      if (!container.querySelector('[data-testid="fb-tag-edit-name"]')) throw new Error('未进入行内编辑');
    });
    setInput('[data-testid="fb-tag-edit-name"]', '听课很认真');
    clickBtn('[data-testid="fb-tag-edit-tone-pos"]');
    clickBtn('[data-testid="fb-tag-edit-save"]');
    await waitFor(() => {
      if (!container.querySelector('[data-testid="fb-tag-row-听课很认真"]')) throw new Error('改名未生效');
    });
    expect(container.querySelector('[data-testid="fb-tag-row-听课认真"]')).toBeNull();
    // 页面标签行同步
    clickBtn('[data-testid="fb-tab-quick"]');
    await waitFor(() => {
      if (!container.querySelector('[data-testid="fb-quick-perf-听课很认真"]')) throw new Error('页面标签行未同步改名');
    });

    // 删除（两步确认）
    clickBtn('[data-testid="fb-tab-settings"]');
    clickBtn('[data-testid="fb-settings-tags-entry"]');
    await waitFor(() => {
      if (!container.querySelector('[data-testid="fb-tag-del-听课很认真"]')) throw new Error('自定义标签无删除入口');
    });
    clickBtn('[data-testid="fb-tag-del-听课很认真"]');
    clickBtn('[data-testid="fb-tag-del-听课很认真"]');
    await waitFor(() => {
      if (container.querySelector('[data-testid="fb-tag-row-听课很认真"]')) throw new Error('删除未生效');
    });
  });
});

describe('0030 反馈设置·课堂表现标签库（第二轮④）', () => {
  it('内置标签只读（无删除）；新增自定义标签 → 快速模式标签行出现该 chip → 可删除', async () => {
    render(<FeedbackPage svc={svc} ai={{ listProfiles: async () => [], invoke: async () => ({ ok: false, error: 'n/a', latencyMs: 0 }) }} />);
    clickBtn('[data-testid="fb-tab-settings"]');
    await waitFor(() => {
      if (!container.querySelector('[data-testid="fb-settings-tags-entry"]')) throw new Error('设置页未就绪');
    });
    clickBtn('[data-testid="fb-settings-tags-entry"]');
    await waitFor(() => {
      if (!container.querySelector('[data-testid="fb-tag-row-专注"]')) throw new Error('内置标签未列出');
    });
    expect(container.querySelector('[data-testid="fb-tag-del-专注"]')).toBeNull(); // 内置不可删
    expect(container.querySelector('[data-testid="fb-tag-edit-专注"]')).toBeNull(); // 内置不可改

    setInput('[data-testid="fb-tag-new-input"]', '听课认真');
    clickBtn('[data-testid="fb-tag-new-tone-neg"]');
    clickBtn('[data-testid="fb-tag-new-add"]');
    await waitFor(() => {
      if (!container.querySelector('[data-testid="fb-tag-row-听课认真"]')) throw new Error('自定义标签未加入');
    });

    // 回到快速模式：标签行里出现该自定义标签（跨会话持久化的标签库）
    clickBtn('[data-testid="fb-tab-quick"]');
    await waitFor(() => {
      if (!container.querySelector('[data-testid="fb-quick-perf-听课认真"]')) throw new Error('标签库里没有该标签');
    });

    // 删除自定义标签（面板里的两步确认）→ 标签行消失
    clickBtn('[data-testid="fb-tab-settings"]');
    await waitFor(() => {
      if (!container.querySelector('[data-testid="fb-tag-row-听课认真"]')) throw new Error('标签行不见了');
    });
    clickBtn('[data-testid="fb-tag-del-听课认真"]');
    clickBtn('[data-testid="fb-tag-del-听课认真"]');
    await waitFor(() => {
      if (container.querySelector('[data-testid="fb-tag-row-听课认真"]')) throw new Error('删除未生效');
    });
    clickBtn('[data-testid="fb-tab-quick"]');
    await waitFor(() => {
      if (container.querySelector('[data-testid="fb-quick-perf-听课认真"]')) throw new Error('标签行未同步删除');
    });
  });
});

describe('0030 离线模板（0005 能力保留，返工轮二搬进反馈设置页）：内置只读 + 新建 + 选用联动', () => {
  it('内置行无编辑/删除；新建用户模板（变量插入）→ 选用联动离线档', async () => {
    render(<FeedbackPage svc={svc} ai={{ listProfiles: async () => [], invoke: async () => ({ ok: false, error: 'n/a', latencyMs: 0 }) }} />);
    await waitFor(() => {
      // 未配 AI → 生成方式=模板生成 → 模板行是「离线模板 + 管理…」
      if (!container.querySelector('[data-testid="fb-quick-template-manage"]')) throw new Error('页面未就绪');
    });
    clickBtn('[data-testid="fb-quick-template-manage"]'); // 该按钮现在跳「反馈设置」页
    await waitFor(() => {
      if (!container.querySelector('[data-testid^="feedback-template-row-"]')) throw new Error('离线模板未列出');
    });
    // 内置离线模板：右侧只读面板（无保存/删除按钮）
    clickBtn('[data-testid="feedback-template-row-feedback-tpl-builtin-default"]');
    await waitFor(() => {
      if (!container.querySelector('[data-testid="feedback-template-body-input"]')) throw new Error('内置离线模板未展开');
    });
    expect((container.querySelector('[data-testid="feedback-template-body-input"]') as HTMLTextAreaElement).readOnly).toBe(true);
    expect(container.querySelector('[data-testid="feedback-template-save-btn"]')).toBeNull();
    expect(container.querySelector('[data-testid="fb-offline-delete"]')).toBeNull();

    clickBtn('[data-testid="feedback-template-create-btn"]'); // 左侧「＋新建离线模板」→ 右侧空表单
    await waitFor(() => {
      if (!container.querySelector('[data-testid="feedback-template-name-input"]')) throw new Error('新建表单未展开');
    });
    setInput('[data-testid="feedback-template-name-input"]', '我的离线模板');
    setInput('[data-testid="feedback-template-body-input"]', '致：');
    clickBtn('[data-testid="feedback-var-学生姓名"]');
    expect(valueOf('[data-testid="feedback-template-body-input"]')).toBe('致：{学生姓名}');
    clickBtn('[data-testid="feedback-template-save-btn"]');
    await waitFor(() => {
      // 新建后左侧列表出现该模板（第二轮返工④：离线模板也搬进反馈设置，行内点选即选用）
      if (!container.querySelector('[data-testid="feedback-template-row-feedback-tpl-2"]')) throw new Error('新模板未出现');
    });
    clickBtn('[data-testid="feedback-template-row-feedback-tpl-2"]');
    clickBtn('[data-testid="fb-tab-quick"]');

    setInput('[data-testid="fb-quick-name"]', '陈小明');
    setInput('[data-testid="fb-quick-content"]', '复习课');
    clickBtn('[data-testid="fb-quick-generate"]');
    await waitFor(() => {
      if (!valueOf('[data-testid="fb-quick-result-text"]').includes('致：陈小明')) throw new Error('离线模板未生效');
    });
  });
});
