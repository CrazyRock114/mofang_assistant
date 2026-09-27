// C1-fix-3: 解析区拆分语义（P1-4）— 断点落在 analysisHtml 时拆出"下一题的解析"，
// 可并入已有条目（intoDraftId）或新建条目（解析落 analysisHtml，不落 contentHtml）
// 断言结构化（精确相等 + data-testid 定位），禁止 toContain 降级
// @vitest-environment jsdom

import { describe, it, expect, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import type { ProofItem, ProofPageInput } from '../../src/shared/contracts/recog-ui-types.js';
import { applyProofAction } from '../../src/app/proof/proof-session.js';
import { ProofPage } from '../../src/app/pages/ProofPage.js';
import { MockBankService } from '../../src/bank/mock/mock-bank.js';

const Q10_ANALYSIS = '<p>q10 自己的解析</p><p>11. 下一题解析内容</p>';
const Q10_ANALYSIS_FRONT = '<p>q10 自己的解析</p>';
const Q10_ANALYSIS_BACK = '<p>11. 下一题解析内容</p>';

function makeItem(overrides: Partial<ProofItem>): ProofItem {
  return {
    draftId: '10-10',
    pageNo: 10,
    qno: 10,
    source: 'rule',
    contentHtml: '<div class="question"><p>q10 题面</p></div>',
    imageRefIds: [],
    status: 'pending',
    warnings: [],
    rawText: '10. q10 题面',
    ...overrides,
  };
}

/** 楚天 q10 形态：analysisHtml 误并入下一题解析；q11 题面已独立存在 */
const ITEMS: ProofItem[] = [
  makeItem({ analysisHtml: Q10_ANALYSIS }),
  makeItem({ draftId: '10-11', qno: 11, contentHtml: '<div class="question"><p>q11 题面</p></div>', rawText: '11. q11 题面' }),
];

// ===== reducer：解析区拆分语义 =====

describe('applyProofAction 解析区拆分（P1-4）', () => {
  it('断点在 analysisHtml + intoDraftId → 后段并入目标 analysisHtml，源只留前段，无新条目', () => {
    const result = applyProofAction(ITEMS, { type: 'split', draftId: '10-10', atText: '11. 下一题解析内容', intoDraftId: '10-11' });
    expect(result.error).toBeUndefined();
    expect(result.items).toHaveLength(2);

    const source = result.items.find((it) => it.draftId === '10-10')!;
    const target = result.items.find((it) => it.draftId === '10-11')!;
    expect(source.analysisHtml).toBe(Q10_ANALYSIS_FRONT);
    expect(source.contentHtml).toBe('<div class="question"><p>q10 题面</p></div>');
    expect(target.analysisHtml).toBe(Q10_ANALYSIS_BACK);
    expect(target.status).toBe('pending');
    // 未产生新条目
    expect(result.items.map((it) => it.draftId).sort()).toEqual(['10-10', '10-11']);
  });

  it('并入已有条目时不校验题号撞号（newQno 撞号也不报错）', () => {
    const result = applyProofAction(ITEMS, {
      type: 'split',
      draftId: '10-10',
      atText: '11. 下一题解析内容',
      intoDraftId: '10-11',
      newQno: 11, // 与现有 q11 撞号，但并入路径不新建条目
    });
    expect(result.error).toBeUndefined();
    expect(result.items).toHaveLength(2);
    expect(result.items.find((it) => it.draftId === '10-11')!.analysisHtml).toBe(Q10_ANALYSIS_BACK);
  });

  it('断点在 analysisHtml + 不带 intoDraftId → 新条目 analysisHtml=后段，content 不含解析文本', () => {
    const result = applyProofAction(ITEMS, { type: 'split', draftId: '10-10', atText: '11. 下一题解析内容' });
    expect(result.error).toBeUndefined();
    expect(result.items).toHaveLength(3);

    const second = result.items[1];
    expect(second.qno).toBe(10.5);
    expect(second.analysisHtml).toBe(Q10_ANALYSIS_BACK);
    expect(second.contentHtml).toBe('<div class="question"></div>');
    expect(result.items[0].analysisHtml).toBe(Q10_ANALYSIS_FRONT);
  });

  it('断点在 contentHtml → 保持现状：拆出物落新条目 contentHtml', () => {
    const items = [makeItem({ contentHtml: '<div class="question"><p>q10 题面前段</p><p>11. 后段题面</p></div>' })];
    const result = applyProofAction(items, { type: 'split', draftId: '10-10', atText: '11. 后段题面', newQno: 12 });
    expect(result.error).toBeUndefined();
    expect(result.items).toHaveLength(2);
    expect(result.items[1].qno).toBe(12);
    expect(result.items[1].contentHtml).toBe('<div class="question"><p>11. 后段题面</p></div>');
    expect(result.items[1].analysisHtml).toBeUndefined();
  });

  it('intoDraftId 目标不存在 → error 且 items 不变', () => {
    const result = applyProofAction(ITEMS, { type: 'split', draftId: '10-10', atText: '11. 下一题解析内容', intoDraftId: '10-99' });
    expect(result.error).toBe('并入目标 10-99 不存在');
    expect(result.items).toBe(ITEMS);
  });

  it('intoDraftId 为拆分源自身 → error 且 items 不变', () => {
    const result = applyProofAction(ITEMS, { type: 'split', draftId: '10-10', atText: '11. 下一题解析内容', intoDraftId: '10-10' });
    expect(result.error).toBe('并入目标不能是拆分源自身');
    expect(result.items).toBe(ITEMS);
  });

  it('intoDraftId + 断点在 contentHtml（非解析区）→ error 且 items 不变', () => {
    const items = [makeItem({}), makeItem({ draftId: '10-11', qno: 11 })];
    const result = applyProofAction(items, { type: 'split', draftId: '10-10', atText: 'q10 题面', intoDraftId: '10-11' });
    expect(result.error).toBe('断点不在解析区，无法并入已有题（并入仅用于解析区拆分）');
    expect(result.items).toBe(items);
  });
});

// ===== UI：拆分面板并入已有题 =====

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

function setSelectValue(testid: string, value: string) {
  const select = el<HTMLSelectElement>(testid);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!;
  setter.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
  flushSync(() => {});
}

function itemCards(): HTMLElement[] {
  return Array.from(container.querySelectorAll('[data-testid^="proof-item-"]'));
}

/** 卡片内"解析：<后段>"渲染行的精确文本（无解析则 null） */
function analysisLineText(draftId: string): string | null {
  const card = el(`proof-item-${draftId}`);
  const rows = Array.from(card.querySelectorAll('div')).filter((d) => d.textContent?.startsWith('解析：'));
  return rows.length > 0 ? rows[0].textContent : null;
}

describe('ProofPage 拆分面板并入已有题（P1-4）', () => {
  it('解析区断点 + 选择并入 q11 → q11 解析出现该段、q10 只留前段、无新条目', () => {
    render();
    click('btn-split-10-10');
    // 并入下拉列出其他条目（排除自身）
    const select = el<HTMLSelectElement>('split-into-10-10');
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['', '10-11']);

    setInputValue('split-input-10-10', '11. 下一题解析内容');
    setSelectValue('split-into-10-10', '10-11');
    click('btn-split-confirm-10-10');

    expect(itemCards().map((c) => c.getAttribute('data-testid'))).toEqual(['proof-item-10-10', 'proof-item-10-11']);
    expect(analysisLineText('10-11')).toBe('解析：11. 下一题解析内容');
    expect(analysisLineText('10-10')).toBe('解析：q10 自己的解析');
  });

  it('并入下拉的断点不在解析区 → notice 报错且条目不变', () => {
    render();
    click('btn-split-10-10');
    setInputValue('split-input-10-10', 'q10 题面');
    setSelectValue('split-into-10-10', '10-11');
    click('btn-split-confirm-10-10');

    expect(el('notice').textContent).toBe('断点不在解析区，无法并入已有题（并入仅用于解析区拆分）');
    expect(itemCards()).toHaveLength(2);
  });
});
