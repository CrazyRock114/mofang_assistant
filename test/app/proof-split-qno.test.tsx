// C1-fix-2: 拆分子题手动题号（P1-3）— reducer newQno 校验 + 拆分面板 UI
// 断言结构化（data-testid 定位 + 精确文本/数量断言），禁止 toContain 降级
// @vitest-environment jsdom

import { describe, it, expect, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import type { ProofItem, ProofPageInput } from '../../src/shared/contracts/recog-ui-types.js';
import { applyProofAction } from '../../src/app/proof/proof-session.js';
import { ProofPage } from '../../src/app/pages/ProofPage.js';
import { MockBankService } from '../../src/bank/mock/mock-bank.js';

function makeItem(overrides: Partial<ProofItem>): ProofItem {
  return {
    draftId: '10-10',
    pageNo: 10,
    qno: 10,
    source: 'rule',
    contentHtml: '<div class="question"><p>题面前段</p><p>11. 后段题面</p></div>',
    imageRefIds: [],
    status: 'pending',
    warnings: [],
    rawText: '题面前段\n11. 后段题面',
    ...overrides,
  };
}

const ITEMS: ProofItem[] = [
  makeItem({}),
  makeItem({ draftId: '10-11', qno: 11, contentHtml: '<div class="question"><p>已有十一题</p></div>', rawText: '11. 已有十一题' }),
];

// ===== reducer：applyProofAction split newQno =====

describe('applyProofAction split newQno（P1-3）', () => {
  it('带 newQno=12 → 后段 qno=12、draftId=10-12，内容不丢', () => {
    const result = applyProofAction(ITEMS, { type: 'split', draftId: '10-10', atText: '11. 后段题面', newQno: 12 });
    expect(result.error).toBeUndefined();
    expect(result.items).toHaveLength(3);
    const second = result.items[1];
    expect(second.qno).toBe(12);
    expect(second.draftId).toBe('10-12');
    expect(second.source).toBe('manual');
    expect(second.contentHtml).toBe('<div class="question"><p>11. 后段题面</p></div>');
    expect(result.items[0].contentHtml).toBe('<div class="question"><p>题面前段</p></div>');
  });

  it('不带 newQno → 保持 +0.5 兜底', () => {
    const result = applyProofAction(ITEMS, { type: 'split', draftId: '10-10', atText: '11. 后段题面' });
    expect(result.error).toBeUndefined();
    expect(result.items[1].qno).toBe(10.5);
    expect(result.items[1].draftId).toBe('10-10.5');
  });

  it('newQno 与现有条目撞号 → error 且 items 不变', () => {
    const result = applyProofAction(ITEMS, { type: 'split', draftId: '10-10', atText: '11. 后段题面', newQno: 11 });
    expect(result.error).toBe('新题号 q11 已存在（可改题号；若断点在解析区，可选择并入已有题）');
    expect(result.items).toBe(ITEMS);
  });

  it.each([
    ['零', 0],
    ['负数', -3],
    ['小数', 11.5],
    ['非数字', NaN],
  ])('newQno 非法（%s）→ error 且 items 不变', (_label, bad) => {
    const result = applyProofAction(ITEMS, { type: 'split', draftId: '10-10', atText: '11. 后段题面', newQno: bad });
    expect(result.error).toBe(`新题号须为正整数：${bad}`);
    expect(result.items).toBe(ITEMS);
  });
});

// ===== UI：拆分面板新题号输入框 =====

const INPUT: ProofPageInput = {
  pages: [{ pageNo: 10, imagePath: 'poc-ocr-free/images/shanghai-2024/shanghai_001.png', ocrText: '第十页原文' }],
  items: ITEMS.map((it) => ({ ...it })),
  warnings: [],
};

let container: HTMLDivElement;
let root: Root | null = null;

function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => {
    root!.render(<ProofPage initialInput={INPUT} bank={new MockBankService()} />);
  });
}

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
});

function el<T extends HTMLElement = HTMLElement>(testid: string): T {
  const node = container.querySelector(`[data-testid="${testid}"]`);
  if (!node) throw new Error(`找不到元素: ${testid}`);
  return node as T;
}

function click(testid: string) {
  el(testid).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  flushSync(() => {});
}

function setInputValue(testid: string, value: string) {
  const input = el<HTMLInputElement>(testid);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync(() => {});
}

function itemCards(): HTMLElement[] {
  return Array.from(container.querySelectorAll('[data-testid^="proof-item-"]'));
}

describe('ProofPage 拆分面板手动题号（P1-3）', () => {
  it('填新题号 12 拆分 → 新条目显示 q12（draftId 10-12），插在原位', () => {
    render();
    click('btn-split-10-10');
    setInputValue('split-input-10-10', '11. 后段题面');
    setInputValue('split-qno-input-10-10', '12');
    click('btn-split-confirm-10-10');

    expect(itemCards().map((c) => c.getAttribute('data-testid'))).toEqual([
      'proof-item-10-10',
      'proof-item-10-12',
      'proof-item-10-11',
    ]);
    const newCard = el('proof-item-10-12');
    expect(newCard.querySelector('strong')!.textContent).toBe('q12');
    expect((newCard.querySelector('.question') as HTMLElement).textContent).toBe('11. 后段题面');
  });

  it('新题号留空 → 仍 +0.5 兜底', () => {
    render();
    click('btn-split-10-10');
    setInputValue('split-input-10-10', '11. 后段题面');
    click('btn-split-confirm-10-10');

    const newCard = el('proof-item-10-10.5');
    expect(newCard.querySelector('strong')!.textContent).toBe('q10.5');
  });

  it('填撞号题号 11 → notice 显示错误，条目不变', () => {
    render();
    click('btn-split-10-10');
    setInputValue('split-input-10-10', '11. 后段题面');
    setInputValue('split-qno-input-10-10', '11');
    click('btn-split-confirm-10-10');

    expect(el('notice').textContent).toBe('新题号 q11 已存在（可改题号；若断点在解析区，可选择并入已有题）');
    expect(itemCards()).toHaveLength(2);
  });

  it('填非数字 → 不传 newQno，按 +0.5 兜底', () => {
    render();
    click('btn-split-10-10');
    setInputValue('split-input-10-10', '11. 后段题面');
    setInputValue('split-qno-input-10-10', 'abc');
    click('btn-split-confirm-10-10');

    expect(el('proof-item-10-10.5').querySelector('strong')!.textContent).toBe('q10.5');
  });
});
