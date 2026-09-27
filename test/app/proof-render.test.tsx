// C1-fix-1: 校对页右栏条目卡片 — 公式 KaTeX 渲染 + 空 src 图引用可读占位
// 断言结构化（querySelector 定位 .katex / .figure-placeholder + 精确文本），禁止 toContain 降级
// @vitest-environment jsdom

import { describe, it, expect, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import type { ProofItem, ProofPageInput } from '../../src/shared/contracts/recog-ui-types.js';
import { ProofPage } from '../../src/app/pages/ProofPage.js';
import { MockBankService } from '../../src/bank/mock/mock-bank.js';

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
  pages: [{ pageNo: 1, imagePath: 'poc-ocr-free/images/shanghai-2024/shanghai_001.png', ocrText: '第一页原文' }],
  items: [
    makeItem({
      draftId: '1-1',
      pageNo: 10,
      contentHtml:
        '<div class="question"><p>已知 <span class="math" data-tex="x^2+1"></span>，求值。</p>' +
        '<figure class="diagram" data-align="center" data-w="0" data-h="0"><img src="" alt="p10-img-0"></figure></div>',
      answerHtml: '<span class="math" data-tex="y=2x" data-display="true"></span>',
      analysisHtml: '由 <span class="math" data-tex="a+b"></span> 可得。',
    }),
  ],
  warnings: [],
};

let container: HTMLDivElement;
let root: Root | null = null;

function render(input: ProofPageInput = INPUT) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => {
    root!.render(<ProofPage initialInput={input} bank={new MockBankService()} />);
  });
}

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
});

function card(): HTMLElement {
  const node = container.querySelector('[data-testid="proof-item-1-1"]');
  if (!node) throw new Error('找不到条目卡片');
  return node as HTMLElement;
}

describe('ProofPage 条目卡片公式渲染（P1-1）', () => {
  it('contentHtml 的 data-tex 空 span 渲染为 .katex 产物，不再以空 span 残留', () => {
    render();
    const c = card();
    expect(c.querySelectorAll('.katex').length).toBeGreaterThanOrEqual(3); // content + answer + analysis
    expect(c.querySelector('span.math[data-tex]')).toBeNull();
  });

  it('answerHtml / analysisHtml 同样渲染为 KaTeX', () => {
    render();
    const c = card();
    // content 行内 1 + answer 行间 1 + analysis 行内 1，恰好 3 个 .katex（answer/analysis 缺失则数量不足）
    expect(c.querySelectorAll('.katex').length).toBe(3);
    // 行间公式（data-display="true"）产生 .katex-display
    expect(c.querySelectorAll('.katex-display').length).toBe(1);
  });
});

describe('ProofPage 条目图引用可读占位（P1-2）', () => {
  it('空 src 的 figure 替换为可读占位，含 imageRefId 与左屏页码', () => {
    render();
    const c = card();
    expect(c.querySelector('figure img[src=""]')).toBeNull();
    const ph = c.querySelector('.figure-placeholder');
    expect(ph).not.toBeNull();
    expect(ph!.getAttribute('data-image-ref')).toBe('p10-img-0');
    expect(ph!.textContent).toBe('🖼 图 p10-img-0（见左屏第 10 页）');
  });

  it('imageRefId 无 pN 前缀时回落到条目 pageNo', () => {
    render({
      ...INPUT,
      items: [
        makeItem({
          draftId: '1-1',
          pageNo: 2,
          contentHtml: '<div class="question"><figure class="diagram"><img src="" alt="img-0"></figure></div>',
        }),
      ],
    });
    const ph = card().querySelector('.figure-placeholder');
    expect(ph).not.toBeNull();
    expect(ph!.textContent).toBe('🖼 图 img-0（见左屏第 2 页）');
  });
});

describe('ProofPage 条目 data-assets 资产根解析（D1 P3 消费点 A）', () => {
  const DATA_ASSETS_ITEM = makeItem({
    draftId: '1-1',
    contentHtml:
      '<div class="question"><p>如图。</p>' +
      '<figure class="diagram" data-align="center" data-w="300" data-h="200">' +
      '<img src="data-assets/capture/zujuan/13q900002-1.png" alt="几何配图"></figure></div>',
  });

  it('__mofangPaths.userDataAssets 存在 → img src 改写为 file:/// 绝对路径', () => {
    window.__mofangPaths = { userDataAssets: 'C:\\ud\\data\\assets' };
    try {
      render({ ...INPUT, items: [DATA_ASSETS_ITEM] });
      const img = card().querySelector('img[src^="file:///"]');
      expect(img).not.toBeNull();
      expect(img!.getAttribute('src')).toBe('file:///C:/ud/data/assets/capture/zujuan/13q900002-1.png');
    } finally {
      delete window.__mofangPaths;
    }
  });

  it('__mofangPaths 缺失（浏览器 dev）→ 占位回落，不残留 data-assets src', () => {
    delete window.__mofangPaths;
    render({ ...INPUT, items: [DATA_ASSETS_ITEM] });
    const c = card();
    expect(c.querySelector('img[src^="data-assets/"]')).toBeNull();
    expect(c.querySelector('.asset-placeholder')).not.toBeNull();
  });
});
