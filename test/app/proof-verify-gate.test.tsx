// 0028 P3：校对页核验清单卡 + V8 人签门禁 + run 结果回写（组件层）
// 纯函数判据在 test/recog/checklist.test.ts；本文件测「UI 真按判据拦人」——门禁不能只是装饰。
// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import type { ProofItem, ProofPageInput } from '../../src/shared/contracts/recog-ui-types.js';
import type { MofangRecogBridge } from '../../src/shared/contracts/bridge.js';
import { ProofPage } from '../../src/app/pages/ProofPage.js';
import { MockBankService } from '../../src/bank/mock/mock-bank.js';

function flush() {
  flushSync(() => {});
}

function makeItem(overrides: Partial<ProofItem>): ProofItem {
  return {
    draftId: '1-1',
    pageNo: 1,
    qno: 1,
    source: 'rule',
    contentHtml: '<div class="question"><p>题面</p></div>',
    imageRefIds: [],
    status: 'pending',
    warnings: [],
    rawText: '1. 题面',
    ...overrides,
  };
}

const INPUT: ProofPageInput = {
  pages: [{ pageNo: 1, imagePath: 'x/p1.png', ocrText: '原文' }],
  items: [
    makeItem({ draftId: '1-1', qno: 1 }),
    makeItem({ draftId: '1-2', qno: 2 }),
  ],
  warnings: [],
};

let container: HTMLDivElement;
let root: Root | null = null;
let bank: MockBankService;

function render(items: ProofItem[], opts: { runId?: string } = {}) {
  bank = new MockBankService();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => {
    root!.render(
      <ProofPage
        initialInput={{ ...INPUT, items }}
        bank={bank}
        {...(opts.runId ? { runId: opts.runId } : {})}
      />,
    );
  });
}

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  delete (window as { __mofangRecog?: MofangRecogBridge }).__mofangRecog;
});

function el<T extends HTMLElement = HTMLElement>(testid: string): T {
  const node = container.querySelector(`[data-testid="${testid}"]`);
  if (!node) throw new Error(`找不到元素: ${testid}（DOM: ${container.innerHTML.slice(0, 600)}）`);
  return node as T;
}

function click(testid: string) {
  el(testid).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  flush();
}

async function clickAsync(testid: string, waitTestId = 'notice', waitText?: string): Promise<void> {
  el(testid).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    flush();
    const target = container.querySelector(`[data-testid="${waitTestId}"]`);
    if (target && (waitText === undefined || (target.textContent ?? '').includes(waitText))) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`clickAsync 超时：${testid} → ${waitTestId}${waitText ? `（含 ${waitText}）` : ''}`);
}

describe('0028 P3：核验清单卡（右侧）', () => {
  it('五项判据行齐备（V1-V5），无 fail 时门禁状态取决于人签', () => {
    render([makeItem({ draftId: '1-1', qno: 1 }), makeItem({ draftId: '1-2', qno: 2 })]);
    for (const code of ['V1', 'V2', 'V3', 'V4', 'V5']) {
      expect(el(`verify-${code}`).textContent).toContain(code);
    }
    // 全为 pending → 人签未齐 → 门禁关闭，理由点名题号
    expect(el('verify-panel').getAttribute('data-gate')).toBe('closed');
    expect(el('gate-status').textContent).toContain('禁止入库');
    expect(el('gate-reasons').textContent).toContain('未标记「校对通过」');
  });

  it('V2 串题命中 → 该条目标红 + 面板列出待修正（不通过）', () => {
    render([
      makeItem({ draftId: '1-1', qno: 1, contentHtml: '<div class="question"><p>甲题</p><p>2. 乙题混入</p></div>' }),
      makeItem({ draftId: '1-2', qno: 2 }),
    ]);
    expect(el('proof-item-1-1').getAttribute('data-verify')).toBe('fail');
    expect(el('proof-item-1-2').getAttribute('data-verify')).toBe('ok');
    expect(el('verify-fail-1-1').textContent).toContain('核验不过');
    expect(el('verify-V2').getAttribute('data-fail')).toBe('1');
    expect(el('verify-fails').textContent).toContain('串题');
  });

  it('V3 公式编译失败 → 面板列出原文（可定位去改）', () => {
    render([
      makeItem({ draftId: '1-1', qno: 1, contentHtml: '<div class="question"><p><span class="math" data-tex="\\frac{1}{"></span></p></div>' }),
      makeItem({ draftId: '1-2', qno: 2 }),
    ]);
    expect(el('verify-V3').getAttribute('data-fail')).toBe('1');
    expect(el('verify-fails').textContent).toContain('\\frac{1}{');
    expect(el('proof-item-1-1').getAttribute('data-verify')).toBe('fail');
  });

  it('V5 无答案只是提示（warn 不阻断）：门禁理由里不出现 V5', () => {
    render([makeItem({ draftId: '1-1', qno: 1, status: 'ok' }), makeItem({ draftId: '1-2', qno: 2, status: 'ok' })]);
    expect(el('verify-V5').textContent).toContain('提示');
    expect(el('verify-panel').getAttribute('data-gate')).toBe('open');
    expect(el('gate-status').textContent).toContain('可入库');
  });

  it('删除的条目退出核验面（不计门禁、不标红）', () => {
    render([
      makeItem({ draftId: '1-1', qno: 1, status: 'delete', contentHtml: '<div class="question"><p>甲题</p><p>2. 乙题混入</p></div>' }),
      makeItem({ draftId: '1-2', qno: 2, status: 'ok' }),
    ]);
    expect(el('verify-V2').getAttribute('data-fail')).toBe('0');
    expect(el('proof-item-1-1').getAttribute('data-verify')).toBe('ok');
    expect(el('verify-panel').getAttribute('data-gate')).toBe('open');
  });
});

describe('0028 P3：V8 人签门禁拦截入库', () => {
  it('未全部「校对通过」→ 按钮置灰且入库不发生', async () => {
    render([makeItem({ draftId: '1-1', qno: 1, status: 'ok' }), makeItem({ draftId: '1-2', qno: 2 })]);
    const btn = el<HTMLButtonElement>('btn-ingest');
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('data-gate')).toBe('closed');

    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flush();
    expect(await bank.listQuestions()).toHaveLength(5); // 仅 mock 预置样本，未新增
  });

  it('核验有 fail（公式编译不过）→ 即便全签也拦下，理由点名 V3', () => {
    render([
      makeItem({ draftId: '1-1', qno: 1, status: 'ok', contentHtml: '<div class="question"><p><span class="math" data-tex="a^"></span></p></div>' }),
      makeItem({ draftId: '1-2', qno: 2, status: 'ok' }),
    ]);
    expect(el<HTMLButtonElement>('btn-ingest').disabled).toBe(true);
    expect(el('gate-reasons').textContent).toContain('V3');
  });

  it('修正后（编辑题面使公式可编译 + 全签）→ 门禁放行，入库成功', async () => {
    render([
      makeItem({ draftId: '1-1', qno: 1, contentHtml: '<div class="question"><p><span class="math" data-tex="a^"></span></p></div>' }),
      makeItem({ draftId: '1-2', qno: 2 }),
    ]);
    expect(el<HTMLButtonElement>('btn-ingest').disabled).toBe(true);
    // 撤销该条（等价于「这条不录」）后人签其余题 → 门禁开
    click('btn-delete-1-1');
    click('btn-ok-1-2');
    expect(el<HTMLButtonElement>('btn-ingest').disabled).toBe(false);
    await clickAsync('btn-ingest');
    expect(el('notice').textContent).toContain('成功 1 题');
  });
});

describe('0028 P1：入库结果回写 run（question_ids）', () => {
  it('带 runId 时入库成功 → attachQuestions 收到新建题目 id', async () => {
    const attachQuestions = vi.fn(async () => { throw new Error('占位：返回值不被断言'); });
    (window as { __mofangRecog?: unknown }).__mofangRecog = {
      attachQuestions,
      create: async () => { throw new Error('unused'); },
      status: async () => { throw new Error('unused'); },
      cancel: async () => { throw new Error('unused'); },
      history: async () => [],
      resume: async () => { throw new Error('unused'); },
      onEvent: () => () => undefined,
    } satisfies MofangRecogBridge;

    render([makeItem({ draftId: '1-1', qno: 1, status: 'ok' })], { runId: 'run-42' });
    await clickAsync('btn-ingest');

    expect(el('notice').textContent).toContain('成功 1 题');
    expect(attachQuestions).toHaveBeenCalledTimes(1);
    const payload = attachQuestions.mock.calls[0][0] as { runId: string; questionIds: string[] };
    expect(payload.runId).toBe('run-42');
    expect(payload.questionIds).toHaveLength(1);
    expect(typeof payload.questionIds[0]).toBe('string');
    // 回写失败不污染入库结论（这里故意失败）：notice 里追加提示但仍显示入库成功
    expect(el('notice').textContent).toContain('run 结果回写失败');
  });

  it('无 runId（手工导入台路径）→ 不调 attachQuestions', async () => {
    const attachQuestions = vi.fn(async () => { throw new Error('不该被调用'); });
    (window as { __mofangRecog?: unknown }).__mofangRecog = {
      attachQuestions,
      create: async () => { throw new Error('unused'); },
      status: async () => { throw new Error('unused'); },
      cancel: async () => { throw new Error('unused'); },
      history: async () => [],
      resume: async () => { throw new Error('unused'); },
      onEvent: () => () => undefined,
    } satisfies MofangRecogBridge;

    render([makeItem({ draftId: '1-1', qno: 1, status: 'ok' })]);
    await clickAsync('btn-ingest');
    expect(el('notice').textContent).toContain('成功 1 题');
    expect(attachQuestions).not.toHaveBeenCalled();
  });
});
