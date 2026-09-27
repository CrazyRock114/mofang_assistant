// 0029：AI 挂树/打标建议 UI——BankBrowser 批量入口 + AiSuggestDialog 人确认流。
// 覆盖任务书 §四「人确认流」：空锚点禁放行 / AI 不可用明示原因 / 建议分组逐条接受（部分接受可）
// / 确认写入参数断言（tree.linkQuestion / bank.addTag 既有通道）/ 校验失败草稿高亮可见 /
// 新标签「待治理」徽标（全库既有标签经 listQuestions({tag}) 探测）。

// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import type { BankService, BankExtServices, Question } from '../../src/shared/contracts/bank-types.js';
import type { MofangAiBridge } from '../../src/shared/contracts/bridge.js';
import type { AiSuggestPayload, AiSuggestResult, AiSuggestMeta, AiAnchorStatusPayload, AiAnchorStatusResult } from '../../src/shared/contracts/ai-suggest-types.js';
import { MockBankService } from '../../src/bank/mock/mock-bank.js';
import { createMockExtServices } from '../../src/bank/mock/mock-ext.js';
import { MockBankStore } from '../../src/bank/mock/mock-store.js';

import { BankBrowser } from '../../src/app/components/BankBrowser.js';
import { AiSuggestDialog } from '../../src/app/components/AiSuggestDialog.js';
import { setStageSubject } from '../../src/app/state/stage-subject.js';
import type { ExtPageServices } from '../../src/app/pages/ExtUi.js';

let store: MockBankStore;
let bank: BankService;
let ext: BankExtServices;
let svc: ExtPageServices;

beforeEach(() => {
  store = new MockBankStore();
  bank = new MockBankService(store, false);
  ext = createMockExtServices(store);
  svc = { bank, ext };
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
  delete window.__mofangAi;
  vi.restoreAllMocks();
});

function click(testid: string) {
  const el = container.querySelector(`[data-testid="${testid}"]`);
  if (!el) throw new Error(`找不到元素: ${testid}`);
  flushSync(() => (el as HTMLButtonElement).click());
}

function check(testid: string) {
  const el = container.querySelector(`[data-testid="${testid}"]`) as HTMLInputElement | null;
  if (!el) throw new Error(`找不到勾选框: ${testid}`);
  flushSync(() => el.click());
}

async function waitFor(assertion: () => void) {
  await vi.waitFor(assertion, { timeout: 3000, interval: 20 });
}

async function makeQuestion(overrides: Partial<Omit<Question, 'id' | 'createdAt' | 'updatedAt'>> = {}): Promise<Question> {
  return bank.createQuestion({
    subject: '物理',
    sourceType: 'local',
    sourceDetail: { origin: 'test' },
    content: '<div class="question">默认题干</div>',
    images: [],
    ...overrides,
  });
}

// ---------- AI 桥假件（全类型面，无 cast） ----------

function makeMeta(overrides: Partial<AiSuggestMeta> = {}): AiSuggestMeta {
  return {
    stage: '初中', subjectId: 'subj:physics', questionCount: 2,
    treeCount: 1, totalNodeCount: 4, injectedNodeCount: 4,
    truncatedNodeCount: 0, injectedTokens: 1234,
    ...overrides,
  };
}

interface AiCalls {
  anchorStatus: Array<AiAnchorStatusPayload>;
  treeLink: Array<AiSuggestPayload>;
  tags: Array<AiSuggestPayload>;
}

function makeFakeAi(opts: {
  status?: AiAnchorStatusResult;
  tree?: AiSuggestResult;
  tags?: AiSuggestResult;
}) {
  const calls: AiCalls = { anchorStatus: [], treeLink: [], tags: [] };
  const ai: MofangAiBridge = {
    profile: {
      list: async () => [],
      create: async () => { throw new Error('unused'); },
      update: async () => { throw new Error('unused'); },
      delete: async () => {},
      setEnabled: async () => { throw new Error('unused'); },
      testConnection: async () => ({ ok: false, latencyMs: null, error: 'unused' }),
    },
    invoke: async () => ({ ok: false, error: 'unused', latencyMs: 0 }),
    models: { list: async () => ({ ok: false, models: [], error: 'unused' }) },
    suggest: {
      anchorStatus: async (payload) => { calls.anchorStatus.push(payload); return opts.status ?? { status: 'ok', reason: null, meta: makeMeta(), warnings: [] }; },
      treeLink: async (payload) => { calls.treeLink.push(payload); return opts.tree ?? unavailable(); },
      tags: async (payload) => { calls.tags.push(payload); return opts.tags ?? unavailable(); },
    },
  };
  return { ai, calls };
}

function unavailable(): AiSuggestResult {
  return {
    status: 'unavailable', reason: '角色 reasoning 未配置启用的模型档案', meta: makeMeta(), warnings: [],
    none: false, suggestions: [], tagSuggestions: [], drafts: [], duplicates: [], latencyMs: 3,
  };
}

const QUERY = { stage: '初中', subjectId: 'subj:physics' };

// ---------- BankBrowser 入口 ----------

describe('0029 题库页 AI 建议入口', () => {
  it('选中条出现「AI 建议」钮：无选中禁用；选中启用；点击开弹层并发起锚点预检（含未选学科守卫）', async () => {
    // 学科字典行（subjectId 外键 + 顶栏筛题依赖；id 归一为 subj:physics）
    await ext.dict.createEntry({ kind: 'subject', code: 'physics', label: '物理' });
    const q = await makeQuestion({ subjectId: 'subj:physics' });
    const { ai, calls } = makeFakeAi({});
    window.__mofangAi = ai;

    // 未选学科（共享状态默认）打开弹层：P-12 本地禁放行，不发起预检调用
    render(<BankBrowser svc={svc} />);
    await waitFor(() => expect(container.querySelector(`[data-testid="bank-item-${q.id}"]`)).not.toBeNull());
    const aiBtn = () => container.querySelector('[data-testid="bank-ai-suggest-btn"]') as HTMLButtonElement;
    expect(aiBtn().disabled).toBe(true); // 无选中禁用
    check(`bank-select-${q.id}`);
    expect(aiBtn().disabled).toBe(false); // 选中启用
    click('bank-ai-suggest-btn');
    await waitFor(() => expect(container.querySelector('[data-testid="ai-suggest-empty"]')).not.toBeNull());
    expect(container.querySelector('[data-testid="ai-suggest-empty"]')!.textContent).toContain('未选择学科');
    expect(calls.anchorStatus).toHaveLength(0);
    // 模拟顶栏选择学科（共享状态单真源）后重开弹层：预检照常发起
    root?.unmount();
    setStageSubject({ subjectId: 'subj:physics' });
    render(<BankBrowser svc={svc} />);
    await waitFor(() => expect(container.querySelector(`[data-testid="bank-item-${q.id}"]`)).not.toBeNull());
    check(`bank-select-${q.id}`);
    click('bank-ai-suggest-btn');
    await waitFor(() => expect(container.querySelector('[data-testid="ai-suggest-dialog"]')).not.toBeNull());
    await waitFor(() => expect(calls.anchorStatus).toHaveLength(1));
    expect(calls.anchorStatus[0].query).toEqual({ subjectId: 'subj:physics' }); // 空 stage 按 AnchorQuery 口径省略
  });
});

// ---------- AiSuggestDialog 人确认流 ----------

describe('0029 AiSuggestDialog：状态与禁放行', () => {
  it('空锚点禁放行：引导语可见 + 两个建议钮 disabled（P-11）', async () => {
    const { ai } = makeFakeAi({
      status: { status: 'empty-anchor', reason: '学段「初中」学科「subj:physics」下无树节点且字典锚为空：先跑 npm run collect:dict / collect:tree', meta: makeMeta({ treeCount: 0, totalNodeCount: 0, injectedNodeCount: 0, injectedTokens: 0 }), warnings: [] },
    });
    render(<AiSuggestDialog bank={bank} ext={ext} ai={ai} query={QUERY} questionIds={['q1']} onClose={() => {}} />);
    await waitFor(() => expect(container.querySelector('[data-testid="ai-suggest-empty"]')).not.toBeNull());
    expect(container.querySelector('[data-testid="ai-suggest-empty"]')!.textContent).toContain('先跑');
    expect((container.querySelector('[data-testid="ai-suggest-tree-btn"]') as HTMLButtonElement).disabled).toBe(true);
    expect((container.querySelector('[data-testid="ai-suggest-tags-btn"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('AI 不可用明示原因（P-3）：unavailable 结果原因全文可见，不静默不隐藏', async () => {
    const { ai } = makeFakeAi({});
    render(<AiSuggestDialog bank={bank} ext={ext} ai={ai} query={QUERY} questionIds={['q1']} onClose={() => {}} />);
    await waitFor(() => expect((container.querySelector('[data-testid="ai-suggest-tree-btn"]') as HTMLButtonElement).disabled).toBe(false));
    click('ai-suggest-tree-btn');
    await waitFor(() => expect(container.querySelector('[data-testid="ai-suggest-unavailable"]')).not.toBeNull());
    expect(container.querySelector('[data-testid="ai-suggest-unavailable"]')!.textContent).toContain('未配置启用的模型档案');
  });
});

describe('0029 AiSuggestDialog：挂树人确认流', () => {
  function treeResult(): AiSuggestResult {
    return {
      status: 'ok', reason: null, meta: makeMeta(), warnings: ['已按 D-050 ≤4 层截断：剔除 1 个深层节点（不进注入清单，AI 回指即被拦）'],
      none: false,
      suggestions: [
        { questionId: 'q1', kind: 'tree-node', targetId: 'n-1', targetLabel: '物理 > 力学', confidence: 0.9, evidenceSummary: '题目 q1 · 节点 物理 > 力学' },
        { questionId: 'q1', kind: 'tree-node', targetId: 'n-2', targetLabel: '物理 > 电学', evidenceSummary: '题目 q1 · 节点 物理 > 电学' },
        { questionId: 'q2', kind: 'tree-node', targetId: 'n-3', targetLabel: '物理 > 光学', confidence: 0.7, evidenceSummary: '题目 q2 · 节点 物理 > 光学' },
      ],
      tagSuggestions: [],
      drafts: [
        { source: 'validation', reason: 'unknown-id: tree-node 建议 ID「n-deep」不在锚点清单内', raw: '{"kind":"tree-node","targetId":"n-deep"}' },
        { source: 'unattributed', reason: 'evidence 缺题目引用或题号不在本次题集内（无法归属，不写入）', raw: '{"kind":"tree-node","targetId":"n-9"}' },
      ],
      duplicates: [],
      latencyMs: 42,
    };
  }

  it('建议按题分组逐条可勾选（默认全选）；取消一条后确认 → 只写保留项（linkQuestion 参数断言）+ 收尾回调', async () => {
    const q1 = await makeQuestion({ content: '<div class="question">力学题</div>' });
    const q2 = await makeQuestion({ content: '<div class="question">光学题</div>' });
    // mock-ext 挂树守卫要求节点存在（与真实 service 同语义）：预置建议涉及的目标节点
    for (const id of ['n-1', 'n-2', 'n-3']) {
      store.treeNodes.set(id, { id, treeId: 't-fake', parentId: null, name: id, sort: 0 });
    }
    const { ai } = makeFakeAi({ tree: treeResult() });
    const linkSpy = vi.spyOn(ext.tree, 'linkQuestion');
    const onWritten = vi.fn();
    const onMessage = vi.fn();
    let closed = false;

    render(
      <AiSuggestDialog bank={bank} ext={ext} ai={ai} query={QUERY} questionIds={[q1.id, q2.id]}
        onClose={() => { closed = true; }} onWritten={onWritten} onMessage={onMessage} />,
    );
    // 状态预检完成后发起挂树建议
    await waitFor(() => expect((container.querySelector('[data-testid="ai-suggest-tree-btn"]') as HTMLButtonElement).disabled).toBe(false));
    click('ai-suggest-tree-btn');
    await waitFor(() => expect(container.querySelector(`[data-testid="ai-suggest-q-${q1.id}"]`)).not.toBeNull());
    // 分组：q1 两条 / q2 一条（技术信息块已按用户口径移除，注入口径不再上屏）
    expect(container.querySelector('[data-testid="ai-suggest-meta"]')).toBeNull();
    expect(container.querySelector(`[data-testid="ai-suggest-item-${q1.id}-n-1"]`)).not.toBeNull();
    expect(container.querySelector(`[data-testid="ai-suggest-item-${q1.id}-n-2"]`)).not.toBeNull();
    expect(container.querySelector(`[data-testid="ai-suggest-item-${q2.id}-n-3"]`)).not.toBeNull();
    // 默认全选（2026-09-23 目检反馈：chip 选中态，无勾选框）
    expect(container.querySelector(`[data-testid="ai-suggest-item-${q1.id}-n-1"]`)!.getAttribute('aria-pressed')).toBe('true');
    // 部分接受：点掉 q1→n-2
    click(`ai-suggest-item-${q1.id}-n-2`);
    expect(container.querySelector(`[data-testid="ai-suggest-item-${q1.id}-n-2"]`)!.getAttribute('aria-pressed')).toBe('false');
    expect((container.querySelector('[data-testid="ai-suggest-confirm"]') as HTMLButtonElement).textContent).toContain('（2）');

    click('ai-suggest-confirm');
    await waitFor(() => expect(closed).toBe(true));
    expect(linkSpy).toHaveBeenCalledTimes(2);
    expect(linkSpy).toHaveBeenCalledWith(q1.id, 'n-1');
    expect(linkSpy).toHaveBeenCalledWith(q2.id, 'n-3');
    expect(onWritten).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('校验失败条目永不写入；其原文展示面已按用户口径移除（2026-09-23 目检第二轮）', async () => {
    const q1 = await makeQuestion();
    const { ai } = makeFakeAi({ tree: treeResult() });
    const linkSpy = vi.spyOn(ext.tree, 'linkQuestion');

    render(<AiSuggestDialog bank={bank} ext={ext} ai={ai} query={QUERY} questionIds={[q1.id]} onClose={() => {}} />);
    await waitFor(() => expect((container.querySelector('[data-testid="ai-suggest-tree-btn"]') as HTMLButtonElement).disabled).toBe(false));
    click('ai-suggest-tree-btn');
    await waitFor(() => expect(container.querySelector(`[data-testid="ai-suggest-item-${q1.id}-n-1"]`)).not.toBeNull());
    // 未采信原文（source/reason/raw）不再上屏——技术信息块已整块移除；
    // P-07 的硬要求（永不写入）由下面两条断言继续守
    expect(container.querySelector('[data-testid="ai-suggest-drafts"]')).toBeNull();
    expect(container.querySelector('[data-testid="ai-suggest-item-q1-n-deep"]')).toBeNull();
    expect(linkSpy).not.toHaveBeenCalled();
  });

  it('NONE：清单内无匹配提示可见，无确认写入面', async () => {
    const q1 = await makeQuestion();
    const { ai } = makeFakeAi({
      tree: { status: 'ok', reason: null, meta: makeMeta(), warnings: [], none: true, suggestions: [], tagSuggestions: [], drafts: [], duplicates: [], latencyMs: 5 },
    });
    render(<AiSuggestDialog bank={bank} ext={ext} ai={ai} query={QUERY} questionIds={[q1.id]} onClose={() => {}} />);
    await waitFor(() => expect((container.querySelector('[data-testid="ai-suggest-tree-btn"]') as HTMLButtonElement).disabled).toBe(false));
    click('ai-suggest-tree-btn');
    await waitFor(() => expect(container.querySelector('[data-testid="ai-suggest-none"]')).not.toBeNull());
    // 无建议可写：确认钮禁用（无写入面）
    expect((container.querySelector('[data-testid="ai-suggest-confirm"]') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('0029 AiSuggestDialog：打标人确认流', () => {
  function tagResult(ids: Array<{ questionId: string; tag: string }>): AiSuggestResult {
    return {
      status: 'ok', reason: null, meta: makeMeta(), warnings: [], none: false,
      suggestions: [], tagSuggestions: ids, drafts: [], duplicates: [], latencyMs: 9,
    };
  }

  it('标签 chips 渲染；全库新标签带「待治理」徽标（listQuestions({tag}) 探测）；确认 → addTag 只写保留项', async () => {
    const q1 = await makeQuestion();
    const q2 = await makeQuestion();
    await bank.addTag(q2.id, '力学'); // 「力学」全库已有 → 非新标签
    const { ai } = makeFakeAi({ tags: tagResult([{ questionId: q1.id, tag: '力学' }, { questionId: q1.id, tag: '易错' }]) });
    const addTagSpy = vi.spyOn(bank, 'addTag');

    render(<AiSuggestDialog bank={bank} ext={ext} ai={ai} query={QUERY} questionIds={[q1.id]} onClose={() => {}} />);
    await waitFor(() => expect((container.querySelector('[data-testid="ai-suggest-tags-btn"]') as HTMLButtonElement).disabled).toBe(false));
    click('ai-suggest-tags-btn');
    await waitFor(() => expect(container.querySelector(`[data-testid="ai-suggest-tag-${q1.id}-易错"]`)).not.toBeNull());
    // 2026-09-23 目检反馈：标签 chip 同款选中态（默认全选、点一下取消）；「待治理」徽标退场（文字求干净）
    expect(container.querySelector(`[data-testid="ai-suggest-tag-${q1.id}-力学"]`)!.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector(`[data-testid="ai-suggest-tag-${q1.id}-易错"]`)!.getAttribute('aria-pressed')).toBe('true');
    // 同页同时有标签行与知识节点行（未被本轮选中的那一类为空行 + 手动入口）
    expect(container.textContent).toContain('知识节点');
    expect(container.querySelector(`[data-testid="ai-suggest-node-pick-${q1.id}"]`)).not.toBeNull();

    // 部分接受：点掉「力学」，仅确认「易错」
    click(`ai-suggest-tag-${q1.id}-力学`);
    expect(container.querySelector(`[data-testid="ai-suggest-tag-${q1.id}-力学"]`)!.getAttribute('aria-pressed')).toBe('false');
    click('ai-suggest-confirm');
    await waitFor(() => expect(addTagSpy).toHaveBeenCalledTimes(1));
    expect(addTagSpy).toHaveBeenCalledWith(q1.id, '易错');
  });
});
