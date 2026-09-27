// 0054 目检反馈返工（2026-09-23 用户三条）：题库页 AI 建议弹层重做。
// 锁四条产品口径：①一页同时呈现标签与知识节点（对齐录题页 chips）②点 chip 即选中/取消（无勾选框）
// ③两类都可手动添加（标签输入框 / 节点走树选择弹层）④AI 工作中有动画进度条；技术信息默认折叠不占版面。
// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import type { BankService, BankExtServices, Question } from '../../src/shared/contracts/bank-types.js';
import type { MofangAiBridge } from '../../src/shared/contracts/bridge.js';
import type { AiSuggestPayload, AiSuggestResult, AiAnchorStatusResult } from '../../src/shared/contracts/ai-suggest-types.js';
import { MockBankService } from '../../src/bank/mock/mock-bank.js';
import { createMockExtServices } from '../../src/bank/mock/mock-ext.js';
import { MockBankStore } from '../../src/bank/mock/mock-store.js';

import { AiSuggestDialog } from '../../src/app/components/AiSuggestDialog.js';

let store: MockBankStore;
let bank: BankService;
let ext: BankExtServices;

beforeEach(() => {
  store = new MockBankStore();
  bank = new MockBankService(store, false);
  ext = createMockExtServices(store);
});

let container: HTMLDivElement;
let root: Root | null = null;

function render(ui: ReactElement): void {
  root?.unmount();
  container?.remove();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => { root!.render(ui); });
}

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  vi.restoreAllMocks();
});

function q<T extends Element>(testid: string): T | null {
  return container.querySelector<T>(`[data-testid="${testid}"]`);
}

function click(testid: string): void {
  const el = q(testid);
  if (!el) throw new Error(`找不到元素: ${testid}`);
  flushSync(() => { (el as HTMLElement).click(); });
}

async function waitFor(assertion: () => void): Promise<void> {
  await vi.waitFor(assertion, { timeout: 3000, interval: 20 });
}

async function makeQuestion(content = '<div class="question">儿童蹦极题干</div>'): Promise<Question> {
  return bank.createQuestion({
    subject: '物理', sourceType: 'local', sourceDetail: { origin: 'test' }, content, images: [],
  });
}

const QUERY = { stage: '初中', subjectId: 'subj:physics' };

function okStatus(): AiAnchorStatusResult {
  return {
    status: 'ok', reason: null,
    meta: { stage: '初中', subjectId: 'subj:physics', questionCount: 1, treeCount: 1, totalNodeCount: 4, injectedNodeCount: 4, truncatedNodeCount: 0, injectedTokens: 1234 },
    warnings: [],
  };
}

function meta() {
  return { stage: '初中', subjectId: 'subj:physics', questionCount: 1, treeCount: 1, totalNodeCount: 4, injectedNodeCount: 4, truncatedNodeCount: 960, injectedTokens: 7234 };
}

function treeResult(questionId: string): AiSuggestResult {
  return {
    status: 'ok', reason: null, meta: meta(), warnings: ['已按 D-050 ≤4 层截断：剔除 960 个深层节点'],
    none: false,
    suggestions: [
      { questionId, kind: 'tree-node', targetId: 'n-1', targetLabel: '力学 › 共点力的平衡', confidence: 0.95, evidenceSummary: `题目 ${questionId} · 节点 力学 › 共点力的平衡` },
      { questionId, kind: 'tree-node', targetId: 'n-2', targetLabel: '力学 › 牛顿第二定律', confidence: 0.9, evidenceSummary: `题目 ${questionId} · 节点 力学 › 牛顿第二定律` },
    ],
    tagSuggestions: [],
    drafts: [{ source: 'validation', reason: 'unknown-id: 建议 ID 不在清单内', raw: '{"kind":"tree-node","targetId":"n-deep"}' }],
    duplicates: [], latencyMs: 41,
  };
}

function tagResult(questionId: string): AiSuggestResult {
  return {
    status: 'ok', reason: null, meta: meta(), warnings: [], none: false,
    suggestions: [],
    tagSuggestions: [{ questionId, tag: '受力分析' }, { questionId, tag: '蹦极' }],
    drafts: [], duplicates: [], latencyMs: 12,
  };
}

/** 假 AI：treeLink/tags 可被测试挂起（观察进度条） */
function makeFakeAi(opts?: { holdTree?: boolean; tree?: AiSuggestResult; tags?: AiSuggestResult }) {
  const calls: { treeLink: AiSuggestPayload[]; tags: AiSuggestPayload[] } = { treeLink: [], tags: [] };
  let releaseTree: ((r: AiSuggestResult) => void) | null = null;
  const ai: MofangAiBridge = {
    profile: {
      list: async () => [], create: async () => { throw new Error('unused'); }, update: async () => { throw new Error('unused'); },
      delete: async () => undefined, setEnabled: async () => { throw new Error('unused'); },
      testConnection: async () => ({ ok: false, latencyMs: null, error: 'unused' }),
    },
    invoke: async () => ({ ok: false, error: 'unused', latencyMs: 0 }),
    models: { list: async () => ({ ok: false, models: [], error: 'unused' }) },
    suggest: {
      anchorStatus: async () => okStatus(),
      treeLink: async (payload) => {
        calls.treeLink.push(payload);
        const result = opts?.tree ?? treeResult(payload.questionIds[0]!);
        if (opts?.holdTree) return new Promise<AiSuggestResult>((resolve) => { releaseTree = resolve; });
        return result;
      },
      tags: async (payload) => {
        calls.tags.push(payload);
        return opts?.tags ?? tagResult(payload.questionIds[0]!);
      },
    },
  };
  return { ai, calls, releaseTree: () => releaseTree };
}

// ==================== ④ AI 工作中的动画进度条 ====================

describe('0054 目检返工：AI 建议弹层 · 动画进度条', () => {
  it('AI 调用期间出现带进度轨（.progress-track > i，含 CSS 动画）的统一读条；返回后撤下', async () => {
    const question = await makeQuestion();
    const { ai, releaseTree } = makeFakeAi({ holdTree: true });
    render(<AiSuggestDialog bank={bank} ext={ext} ai={ai} query={QUERY} questionIds={[question.id]} onClose={() => undefined} />);
    await waitFor(() => expect((q('ai-suggest-tree-btn') as HTMLButtonElement).disabled).toBe(false));

    click('ai-suggest-tree-btn');
    // 读条 + 动画轨（.progress-track i 由 theme.css mfa-progress-slide 驱动）
    expect(q('ai-suggest-working')).not.toBeNull();
    expect(q('ai-suggest-working')!.querySelector('.progress-track > i')).not.toBeNull();

    releaseTree()!(treeResult(question.id));
    await waitFor(() => expect(q('ai-suggest-working')).toBeNull());
  });
});

// ==================== ① 一页两类 + ② chip 选中/取消 ====================

describe('0054 目检返工：标签与知识节点同页呈现 + 点 chip 选中/取消', () => {
  it('同一页里既有标签行也有知识节点行；chip 点击切换选中态（无勾选框）', async () => {
    const question = await makeQuestion();
    const { ai } = makeFakeAi({});
    render(<AiSuggestDialog bank={bank} ext={ext} ai={ai} query={QUERY} questionIds={[question.id]} onClose={() => undefined} />);
    await waitFor(() => expect((q('ai-suggest-tags-btn') as HTMLButtonElement).disabled).toBe(false));

    // 先出标签建议，再出节点建议（两次调用结果同页共存）
    click('ai-suggest-tags-btn');
    await waitFor(() => expect(q(`ai-suggest-tag-${question.id}-受力分析`)).not.toBeNull());
    click('ai-suggest-tree-btn');
    await waitFor(() => expect(q(`ai-suggest-item-${question.id}-n-1`)).not.toBeNull());

    // 同页：标签行与节点行同时在
    const group = q(`ai-suggest-q-${question.id}`)!;
    expect(group.textContent).toContain('标签');
    expect(group.textContent).toContain('知识节点');
    expect(q(`ai-suggest-tag-${question.id}-蹦极`)).not.toBeNull();
    expect(q(`ai-suggest-item-${question.id}-n-2`)).not.toBeNull();

    // 无勾选框（呈现方式对齐录题页 chips）
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();

    // 点 chip = 取消选中；再点 = 选中（默认全选中）
    const nodeChip = q<HTMLElement>(`ai-suggest-item-${question.id}-n-1`)!;
    expect(nodeChip.getAttribute('aria-pressed')).toBe('true');
    click(`ai-suggest-item-${question.id}-n-1`);
    expect(q<HTMLElement>(`ai-suggest-item-${question.id}-n-1`)!.getAttribute('aria-pressed')).toBe('false');
    click(`ai-suggest-item-${question.id}-n-1`);
    expect(q<HTMLElement>(`ai-suggest-item-${question.id}-n-1`)!.getAttribute('aria-pressed')).toBe('true');

    const tagChip = q<HTMLElement>(`ai-suggest-tag-${question.id}-蹦极`)!;
    expect(tagChip.getAttribute('aria-pressed')).toBe('true');
    click(`ai-suggest-tag-${question.id}-蹦极`);
    expect(q<HTMLElement>(`ai-suggest-tag-${question.id}-蹦极`)!.getAttribute('aria-pressed')).toBe('false');
  });
});

// ==================== ③ 手动添加 ====================

describe('0054 目检返工：手动加标签 / 手动加节点', () => {
  it('手动加标签：输入回车 → chip 出现且已选中 → 确认写入落 addTag', async () => {
    const question = await makeQuestion();
    const { ai } = makeFakeAi({ tags: { ...tagResult(question.id), tagSuggestions: [] } });
    const addTagSpy = vi.spyOn(bank, 'addTag');
    render(<AiSuggestDialog bank={bank} ext={ext} ai={ai} query={QUERY} questionIds={[question.id]} onClose={() => undefined} />);
    await waitFor(() => expect((q('ai-suggest-tags-btn') as HTMLButtonElement).disabled).toBe(false));
    click('ai-suggest-tags-btn');
    await waitFor(() => expect(q('ai-suggest-confirm')).not.toBeNull());

    const input = q<HTMLInputElement>(`ai-suggest-tag-input-${question.id}`)!;
    expect(input).not.toBeNull();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    flushSync(() => {
      setter.call(input, '动手实验');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    flushSync(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(q<HTMLElement>(`ai-suggest-tag-${question.id}-动手实验`)?.getAttribute('aria-pressed')).toBe('true');

    click('ai-suggest-confirm');
    await waitFor(() => expect(addTagSpy).toHaveBeenCalledWith(question.id, '动手实验'));
  });

  it('手动加节点：「+ 手动加节点」开树选择弹层 → 确认 → chip 出现且已选中 → 写入落 linkQuestion', async () => {
    const question = await makeQuestion();
    // 树选择弹层数据（弹层按学段/学科取树）
    const tree = await ext.tree.createTree({ type: 'knowledge', name: '组卷网·知识点·初中物理', subjectId: 'subj:physics', stage: '初中' });
    const node = await ext.tree.createNode({ treeId: tree.id, name: '机械能', sort: 0 });
    const { ai } = makeFakeAi({ tree: { ...treeResult(question.id), suggestions: [] } });
    const linkSpy = vi.spyOn(ext.tree, 'linkQuestion');

    render(
      <AiSuggestDialog bank={bank} ext={ext} ai={ai} query={QUERY} subjectLabel="物理" questionIds={[question.id]} onClose={() => undefined} />,
    );
    await waitFor(() => expect((q('ai-suggest-tree-btn') as HTMLButtonElement).disabled).toBe(false));
    click('ai-suggest-tree-btn');
    await waitFor(() => expect(q('ai-suggest-confirm')).not.toBeNull());

    click(`ai-suggest-node-pick-${question.id}`);
    await waitFor(() => expect(q('wb-tree-picker')).not.toBeNull());
    await waitFor(() => expect(q(`wb-tree-node-${node.id}`)).not.toBeNull());
    click(`wb-tree-node-${node.id}`);
    click('wb-tm-confirm');

    expect(q('wb-tree-picker')).toBeNull();
    expect(q<HTMLElement>(`ai-suggest-item-${question.id}-${node.id}`)?.getAttribute('aria-pressed')).toBe('true');

    click('ai-suggest-confirm');
    await waitFor(() => expect(linkSpy).toHaveBeenCalledWith(question.id, node.id));
  });

  it('确认写入一次同时落两类（节点 linkQuestion + 标签 addTag）', async () => {
    const question = await makeQuestion();
    // mock-ext 挂树守卫要求节点存在（与真实 service 同语义）：预置 AI 建议涉及的目标节点
    for (const id of ['n-1', 'n-2']) {
      store.treeNodes.set(id, { id, treeId: 't-fake', parentId: null, name: id, sort: 0 });
    }
    const { ai } = makeFakeAi({});
    const linkSpy = vi.spyOn(ext.tree, 'linkQuestion');
    const addTagSpy = vi.spyOn(bank, 'addTag');
    const onMessage = vi.fn();
    let closed = false;
    render(
      <AiSuggestDialog bank={bank} ext={ext} ai={ai} query={QUERY} questionIds={[question.id]}
        onClose={() => { closed = true; }} onMessage={onMessage} />,
    );
    await waitFor(() => expect((q('ai-suggest-tags-btn') as HTMLButtonElement).disabled).toBe(false));
    click('ai-suggest-tags-btn');
    await waitFor(() => expect(q(`ai-suggest-tag-${question.id}-受力分析`)).not.toBeNull());
    click('ai-suggest-tree-btn');
    await waitFor(() => expect(q(`ai-suggest-item-${question.id}-n-1`)).not.toBeNull());

    click('ai-suggest-confirm');
    await waitFor(() => expect(closed).toBe(true));
    expect(linkSpy).toHaveBeenCalledTimes(2);
    expect(addTagSpy).toHaveBeenCalledTimes(2);
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'success',
      text: expect.stringContaining('知识节点 2 个、标签 2 个'),
    }));
  });
});

// ==================== 纯净化：技术信息整块移除、题干不露 UUID ====================

describe('0054 目检返工（第二轮）：弹层只留人话（技术信息整块移除）', () => {
  it('注入口径/warnings/未采信草稿一律不上屏；说明行也去掉；弹层文字面只剩题、chips、按钮', async () => {
    const question = await makeQuestion();
    const { ai } = makeFakeAi({});
    render(<AiSuggestDialog bank={bank} ext={ext} ai={ai} query={QUERY} questionIds={[question.id]} onClose={() => undefined} />);
    await waitFor(() => expect((q('ai-suggest-tree-btn') as HTMLButtonElement).disabled).toBe(false));
    click('ai-suggest-tree-btn');
    await waitFor(() => expect(q(`ai-suggest-item-${question.id}-n-1`)).not.toBeNull());

    // 技术信息块（含折叠形态）已整块移除
    expect(q('ai-suggest-diagnostics')).toBeNull();
    expect(q('ai-suggest-meta')).toBeNull();
    expect(q('ai-suggest-drafts')).toBeNull();
    // 顶部说明行去掉（用户口径：这几句是废话）
    expect(q('ai-suggest-dialog')!.textContent).not.toContain('AI 只给建议');
    // 调试串一律不上屏
    const text = q('ai-suggest-dialog')!.textContent!;
    expect(text).not.toContain('token');
    expect(text).not.toContain('D-050');
    expect(text).not.toContain('未采信');
    expect(text).not.toContain('注入口径');
  });

  it('底部动作只有「取消 / 确认写入（N）」（原「全部不采纳」改「取消」）', async () => {
    const question = await makeQuestion();
    const { ai } = makeFakeAi({});
    let closed = false;
    render(<AiSuggestDialog bank={bank} ext={ext} ai={ai} query={QUERY} questionIds={[question.id]} onClose={() => { closed = true; }} />);
    await waitFor(() => expect((q('ai-suggest-tree-btn') as HTMLButtonElement).disabled).toBe(false));
    click('ai-suggest-tree-btn');
    await waitFor(() => expect(q(`ai-suggest-item-${question.id}-n-1`)).not.toBeNull());

    const reject = q('ai-suggest-reject')!;
    expect(reject.textContent).toBe('取消');
    expect(container.textContent).not.toContain('全部不采纳');
    click('ai-suggest-reject');
    expect(closed).toBe(true);
  });

  it('题干标题用「第 N 题 + 摘要」，不显示题目 id（UUID）', async () => {
    const question = await makeQuestion();
    const { ai } = makeFakeAi({});
    render(<AiSuggestDialog bank={bank} ext={ext} ai={ai} query={QUERY} questionIds={[question.id]} onClose={() => undefined} />);
    await waitFor(() => expect((q('ai-suggest-tree-btn') as HTMLButtonElement).disabled).toBe(false));
    click('ai-suggest-tree-btn');
    await waitFor(() => expect(q(`ai-suggest-item-${question.id}-n-1`)).not.toBeNull());

    const head = q(`ai-suggest-q-${question.id}`)!.textContent!;
    expect(head).toContain('第 1 题');
    expect(head).toContain('儿童蹦极题干');
    expect(head).not.toContain(question.id);
  });

  it('节点 chip 不再重复显示「题目 id · 节点路径」证据串（置信度改走 title 提示）', async () => {
    const question = await makeQuestion();
    const { ai } = makeFakeAi({});
    render(<AiSuggestDialog bank={bank} ext={ext} ai={ai} query={QUERY} questionIds={[question.id]} onClose={() => undefined} />);
    await waitFor(() => expect((q('ai-suggest-tree-btn') as HTMLButtonElement).disabled).toBe(false));
    click('ai-suggest-tree-btn');
    await waitFor(() => expect(q(`ai-suggest-item-${question.id}-n-1`)).not.toBeNull());

    const chip = q<HTMLElement>(`ai-suggest-item-${question.id}-n-1`)!;
    expect(chip.textContent).toBe('力学 › 共点力的平衡');
    expect(chip.getAttribute('title')).toContain('95');
    expect(q(`ai-suggest-q-${question.id}`)!.textContent).not.toContain('evidenceSummary');
  });
});
