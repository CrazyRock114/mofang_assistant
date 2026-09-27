// C1 Phase 1: 校对页组件测试（jsdom）— 初始渲染 + 状态迁移 + 入库收集
// 断言结构化（data-testid 定位 + 精确文本/数量断言），纯样式不测
// @vitest-environment jsdom

import { describe, it, expect, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import type { ProofItem, ProofPageInput } from '../../src/shared/contracts/recog-ui-types.js';
import { ProofPage } from '../../src/app/pages/ProofPage.js';
import { MockBankService } from '../../src/bank/mock/mock-bank.js';
import type { MofangRecogBridge } from '../../src/shared/contracts/bridge.js';

// 不用 React.act：其 named export 在部分 ESM/CJS 解析链路下解析不到（复验必现
// React.act is not a function），react-dom/test-utils 的 act 同样只是转发。
// 改用 react-dom 长期稳定导出 flushSync 强制同步冲刷更新队列，等效 act 的同步段。

/** 冲刷 React 待处理更新（等效 act 同步段） */
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
  pages: [
    { pageNo: 1, imagePath: 'poc-ocr-free/images/shanghai-2024/shanghai_001.png', ocrText: '第一页原文' },
    { pageNo: 2, imagePath: 'poc-ocr-free/images/shanghai-2024/shanghai_002.png', ocrText: '第二页原文' },
  ],
  items: [
    makeItem({
      draftId: '1-1',
      qno: 1,
      contentHtml: '<div class="question"><p>甲题题面前段</p><p>10. 乙题混入题面</p></div>',
      rawText: '甲题题面前段\n10. 乙题混入题面',
    }),
    makeItem({ draftId: '1-2', qno: 2, contentHtml: '<div class="question"><p>丙题题面</p></div>', rawText: '2. 丙题题面' }),
    makeItem({ draftId: '2-3', pageNo: 2, qno: 3, contentHtml: '<div class="question"><p>丁题题面</p></div>', rawText: '3. 丁题题面' }),
  ],
  warnings: ['页眉噪声示例'],
};

let container: HTMLDivElement;
let root: Root | null = null;
let bank: MockBankService;

function render(opts: { runId?: string; input?: ProofPageInput } = {}) {
  bank = new MockBankService();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => {
    root!.render(
      <ProofPage
        initialInput={opts.input ?? INPUT}
        bank={bank}
        {...(opts.runId ? { runId: opts.runId } : {})}
      />,
    );
  });
}

/**
 * 无 V2 串题问题的干净夹具（入库链用例走它）。
 * 0028 V8 门禁要求「全绿才允许入库」——本夹具三道题皆可标通过，故入库用例须全部人签。
 */
const CLEAN_INPUT: ProofPageInput = {
  pages: INPUT.pages,
  items: [
    makeItem({ draftId: '1-1', qno: 1, contentHtml: '<div class="question"><p>甲题题面</p></div>', rawText: '1. 甲题题面' }),
    makeItem({ draftId: '2-2', pageNo: 2, qno: 2, contentHtml: '<div class="question"><p>丙题题面</p></div>', rawText: '2. 丙题题面' }),
    makeItem({ draftId: '2-3', pageNo: 2, qno: 3, contentHtml: '<div class="question"><p>丁题题面</p></div>', rawText: '3. 丁题题面' }),
  ],
  warnings: INPUT.warnings,
};

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  delete (window as { __mofangRecog?: MofangRecogBridge }).__mofangRecog;
});

function el<T extends HTMLElement = HTMLElement>(testid: string): T {
  const node = container.querySelector(`[data-testid="${testid}"]`);
  if (!node) throw new Error(`找不到元素: ${testid}`);
  return node as T;
}

function click(testid: string) {
  el(testid).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  flush();
}

/** 异步动作（入库等含动态 import 的链路）：派发后轮询等待目标元素出现（默认 notice；给 waitText 则同时要求文本命中，用于前次 notice 残留场景），超时抛错附 DOM 快照 */
async function clickAsync(testid: string, waitTestId = 'notice', waitText?: string, timeoutMs = 2000) {
  el(testid).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    flush();
    const target = container.querySelector(`[data-testid="${waitTestId}"]`);
    if (target && (waitText === undefined || (target.textContent ?? '').includes(waitText))) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  const snapshot = container.innerHTML.slice(0, 2000);
  throw new Error(`clickAsync 超时（${timeoutMs}ms）：点击 ${testid} 后未等到 ${waitTestId}${waitText ? `（文本含 ${waitText}）` : ''}\nDOM 快照：${snapshot}`);
}

function setInputValue(testid: string, value: string) {
  const input = el<HTMLInputElement>(testid);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flush();
}

function setSelectValue(testid: string, value: string) {
  const select = el<HTMLSelectElement>(testid);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!;
  setter.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
  flush();
}

function itemCards(): HTMLElement[] {
  return Array.from(container.querySelectorAll('[data-testid^="proof-item-"]'));
}

function statusText(draftId: string): string {
  return el(`status-${draftId}`).textContent ?? '';
}

describe('ProofPage 校对页', () => {
  it('初始渲染：条目列表 + 左屏页图 + 页级警告条', () => {
    render();
    expect(itemCards()).toHaveLength(3);
    expect(statusText('1-1')).toBe('● 待校对');
    expect(statusText('1-2')).toBe('● 待校对');
    expect(statusText('2-3')).toBe('● 待校对');
    expect(container.querySelectorAll('[data-testid="page-pane"] img')).toHaveLength(2);
    expect(el('warnings-bar').textContent).toContain('引擎警告 1 条');
    // 拆分/合并前条目顺序即题号顺序
    expect(itemCards().map((c) => c.getAttribute('data-testid'))).toEqual([
      'proof-item-1-1',
      'proof-item-1-2',
      'proof-item-2-3',
    ]);
  });

  it('状态迁移：pending → ok → 撤销回 pending', () => {
    render();
    click('btn-ok-1-1');
    expect(statusText('1-1')).toBe('● 已通过');
    click('btn-unok-1-1');
    expect(statusText('1-1')).toBe('● 待校对');
  });

  it('删除：状态置 delete 且可恢复', () => {
    render();
    click('btn-delete-1-2');
    expect(statusText('1-2')).toBe('● 已删除');
    click('btn-restore-1-2');
    expect(statusText('1-2')).toBe('● 待校对');
  });

  it('拆分：atText 断点产生新条目（source manual，题号 +0.5，插在原位）', () => {
    render();
    click('btn-split-1-1');
    setInputValue('split-input-1-1', '10. 乙题混入题面');
    click('btn-split-confirm-1-1');

    expect(itemCards().map((c) => c.getAttribute('data-testid'))).toEqual([
      'proof-item-1-1',
      'proof-item-1-1.5',
      'proof-item-1-2',
      'proof-item-2-3',
    ]);
    expect(statusText('1-1.5')).toBe('● 待校对');
    const newCard = el('proof-item-1-1.5');
    expect(newCard.textContent).toContain('手动新起');
    // 内容不丢：前段保留原题面，后段为断点后文本
    const firstContent = el('proof-item-1-1').querySelector('.question') as HTMLElement;
    const secondContent = newCard.querySelector('.question') as HTMLElement;
    expect(firstContent.textContent).toBe('甲题题面前段');
    expect(secondContent.textContent).toBe('10. 乙题混入题面');
  });

  it('拆分 atText 未命中：提示错误且条目不变', () => {
    render();
    click('btn-split-1-1');
    setInputValue('split-input-1-1', '不存在的文本');
    click('btn-split-confirm-1-1');
    expect(el('notice').textContent).toBe('atText 未命中：不存在的文本');
    expect(itemCards()).toHaveLength(3);
  });

  it('合并：多选合并进目标，其余置 delete', () => {
    render();
    click('btn-merge-mode');
    click('merge-check-1-2');
    click('merge-check-2-3');
    setSelectValue('merge-into', '1-2');
    click('btn-merge-confirm');

    expect(statusText('1-2')).toBe('● 待校对');
    expect(statusText('2-3')).toBe('● 已删除');
    const mergedContent = el('proof-item-1-2').querySelector('.question') as HTMLElement;
    expect(mergedContent.textContent).toBe('丙题题面丁题题面');
  });

  it('入库已通过：只收集 status===ok 条目，MockBankService 往返字段一致；重复入库防护', async () => {
    render({ input: CLEAN_INPUT });
    click('btn-ok-1-1');
    click('btn-ok-2-2');
    click('btn-ok-2-3');
    setInputValue('input-title', '测试卷');
    expect(el('btn-ingest').getAttribute('data-gate')).toBe('open');
    await clickAsync('btn-ingest');

    expect(el('notice').textContent).toContain('入库完成：成功 3 题，失败 0 题');
    expect(el('ingested-1-1').textContent).toContain('已入库');
    expect(el('ingested-2-3').textContent).toContain('已入库');

    const all = await bank.listQuestions();
    const seeded = 5; // MockBankService 预置样本数
    expect(all).toHaveLength(seeded + 3);
    const scanned = all.slice(seeded);
    expect(scanned[0].sourceType).toBe('local');
    expect(scanned[0].sourceDetail).toEqual({ origin: 'scan', pageNo: 1, qno: 1, paperTitle: '测试卷' });
    expect(scanned[0].content).toBe('<div class="question"><p>甲题题面</p></div>');
    expect(scanned[1].sourceDetail).toEqual({ origin: 'scan', pageNo: 2, qno: 2, paperTitle: '测试卷' });
    expect(scanned[2].sourceDetail).toEqual({ origin: 'scan', pageNo: 2, qno: 3, paperTitle: '测试卷' });

    // 重复入库防护：已入库条目不重复收（前次 notice 残留，须等新文本落定）
    await clickAsync('btn-ingest', 'notice', '没有可入库');
    expect(el('notice').textContent).toBe('没有可入库的已通过题目（须先标记「校对通过」，已入库条目不重复入库）');
    expect(await bank.listQuestions()).toHaveLength(seeded + 3);
  });

  it('入库 + 目标试卷：createPaper 后 addQuestion 入卷并带分值', async () => {
    render({ input: CLEAN_INPUT });
    click('btn-delete-2-2');
    click('btn-delete-2-3');
    click('btn-ok-1-1');
    click('btn-score-1-1');
    setInputValue('score-input-1-1', '8');
    click('btn-score-confirm-1-1');
    setInputValue('input-target-paper', '校对入库卷');
    await clickAsync('btn-ingest');

    expect(el('notice').textContent).toContain('成功 1 题');
    expect(el('notice').textContent).toContain('已加入试卷「校对入库卷」');
    const papers = await bank.listPapers();
    const target = papers.find((p) => p.paper.title === '校对入库卷');
    expect(target).toBeDefined();
    const refs = await bank.getPaperQuestions(target!.paper.id);
    expect(refs).toHaveLength(1);
    expect(refs[0].score).toBe(8);
  });
});
