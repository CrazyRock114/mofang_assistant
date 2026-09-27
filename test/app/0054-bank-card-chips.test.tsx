// 0054 目检反馈（第三轮）：题库题卡上「标签 + 知识点」两行都要显示，且不分来源——
// AI 建议/手动打的标签（question_tags）与已挂知识树节点（question_node_links）都要上屏，
// 与采集链写入的站点知识点原文（knowledge_points）并存。
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import type { BankExtServices, BankService } from '../../src/shared/contracts/bank-types.js';
import { MockBankService } from '../../src/bank/mock/mock-bank.js';
import { createMockExtServices } from '../../src/bank/mock/mock-ext.js';
import { MockBankStore } from '../../src/bank/mock/mock-store.js';
import { BankPage } from '../../src/app/pages/BankPage.js';
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

function render(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => { root!.render(<BankPage svc={svc} />); });
}

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  vi.restoreAllMocks();
});

async function waitFor(assertion: () => void): Promise<void> {
  await vi.waitFor(assertion, { timeout: 3000, interval: 20 });
}

function q<T extends Element>(testid: string): T | null {
  return container.querySelector<T>(`[data-testid="${testid}"]`);
}

/** 造题（可带采集链写入的站点知识点原文） */
async function makeQuestion(content: string, knowledgePoints?: string[]): Promise<string> {
  const question = await bank.createQuestion({
    subject: '物理', sourceType: 'local', sourceDetail: { origin: 'test' },
    content: `<div class="question">${content}</div>`, images: [],
    ...(knowledgePoints ? { knowledgePoints } : {}),
  });
  return question.id;
}

describe('0054 目检反馈：题库题卡显示标签与知识点（不分来源）', () => {
  it('AI/手动打的标签（question_tags）显示为「标签」行；已挂知识树节点显示为「知识点」行', async () => {
    const id = await makeQuestion('带标签与节点的题');
    // 模拟「AI 打标建议已确认」写入的两条标签
    await bank.addTag(id, '受力分析');
    await bank.addTag(id, '蹦极');
    // 模拟「AI 节点建议已确认 / 录题台采纳」写入的树节点
    const tree = await ext.tree.createTree({ type: 'knowledge', name: '组卷网·知识点·高中物理', subjectId: 'subj:physics', stage: '高中' });
    const node = await ext.tree.createNode({ treeId: tree.id, name: '动量守恒定律', sort: 0 });
    await ext.tree.linkQuestion(id, node.id);

    render();
    await waitFor(() => {
      if (!q(`bank-qtag-${id}-受力分析`)) throw new Error('标签 chip 未渲染');
    });

    // 标签行：本地录入/AI 建议写入的标签可见
    expect(q(`bank-qtag-${id}-受力分析`)!.textContent).toContain('受力分析');
    expect(q(`bank-qtag-${id}-蹦极`)).not.toBeNull();
    // 知识点行：已挂的树节点可见（testid 以 nodeId 结尾，稳定）
    expect(q(`bank-qnode-${id}-${node.id}`)!.textContent).toContain('动量守恒定律');
    // 行标（人读）
    expect(container.textContent).toContain('标签');
    expect(container.textContent).toContain('知识点');
  });

  it('采集链写入的站点知识点原文仍照旧显示（两行并存，零回归）', async () => {
    const id = await makeQuestion('采集题', ['一元二次方程']);
    render();
    await waitFor(() => {
      if (!q(`bank-kp-${id}-一元二次方程`)) throw new Error('采集知识点 chip 未渲染');
    });
    expect(q(`bank-kp-${id}-一元二次方程`)!.textContent).toContain('一元二次方程');
  });

  it('无标签无节点：不渲染空的「标签 / 知识点」行（版面不被空行占位）', async () => {
    const id = await makeQuestion('素题');
    render();
    await waitFor(() => {
      if (!q(`bank-item-${id}`)) throw new Error('题卡未渲染');
    });
    const card = q(`bank-item-${id}`)!;
    expect(card.querySelector(`[data-testid^="bank-qtag-${id}-"]`)).toBeNull();
    expect(card.querySelector(`[data-testid^="bank-qnode-${id}-"]`)).toBeNull();
    // 两个新行容器本身也不渲染（不占版面）
    expect(q(`bank-qtags-${id}`)).toBeNull();
    expect(q(`bank-qnodes-${id}`)).toBeNull();
  });

  it('节点显示为已挂全量（一题多节点都上屏）', async () => {
    const id = await makeQuestion('多节点题');
    const tree = await ext.tree.createTree({ type: 'knowledge', name: '组卷网·知识点·高中物理', stage: '高中' });
    const n1 = await ext.tree.createNode({ treeId: tree.id, name: '力学', sort: 0 });
    const n2 = await ext.tree.createNode({ treeId: tree.id, name: '相互作用', sort: 1 });
    await ext.tree.linkQuestion(id, n1.id);
    await ext.tree.linkQuestion(id, n2.id);

    render();
    await waitFor(() => {
      if (!q(`bank-qnode-${id}-${n2.id}`)) throw new Error('第二个节点未渲染');
    });
    expect(q(`bank-qnode-${id}-${n1.id}`)).not.toBeNull();
    expect(q(`bank-qnode-${id}-${n2.id}`)).not.toBeNull();
  });
});
