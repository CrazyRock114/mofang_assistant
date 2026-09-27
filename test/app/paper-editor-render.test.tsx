// 0004: ComposePage（原 PaperEditor 排版间重构体）渲染入口探针（R-1 复核 + R-2 修复沿用）
// 主列表/选题弹层：data-assets → file:/// 绝对路径 + data-tex → KaTeX HTML
// 预览窗：assetsRoot 必须显式传入 buildPaperHtml（不依赖新窗 __mofangPaths）
// 断言结构化（querySelector 定位 + 精确属性），禁止 toContain 堆砌
// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { Paper, PaperQuestionRef, Question } from '../../src/shared/contracts/bank-types.js';

const ASSETS_ROOT = 'D:\\mofang-test\\data\\assets';

/** 采集题真实形态：data-tex 公式 + 行内公式小图（inline-figure）+ 块级配图（figure）均为 data-assets 引用 */
const CAPTURED_CONTENT =
  '<div class="question">已知重力加速度 <span class="math" data-tex="g=9.8"></span>，' +
  '距离地面高度为<span class="inline-figure"><img class="q-figure" data-w="11" data-h="12" src="data-assets/capture/zujuan/q1-1.svg"></span>，' +
  '如图所示<figure class="diagram" data-w="300" data-h="200"><img class="q-figure" src="data-assets/capture/zujuan/q1-2.png"></figure></div>';

const Q_IN_PAPER: Question = {
  id: 'q1',
  subject: '物理',
  sourceType: 'network',
  sourceDetail: { site: 'zujuan', questionId: '35169061' },
  content: CAPTURED_CONTENT,
  images: [],
  createdAt: '2026-09-05T00:00:00Z',
  updatedAt: '2026-09-05T00:00:00Z',
};

const Q_AVAILABLE: Question = { ...Q_IN_PAPER, id: 'q2' };

const PAPER: Paper = {
  id: 'p1',
  title: '采集题测试卷',
  config: {},
  createdAt: '2026-09-05T00:00:00Z',
  archived: false,
  status: 'composing',
};

const PAPER_REFS: PaperQuestionRef[] = [
  { id: 'r1', paperId: 'p1', questionId: 'q1', position: 0, frozen: false },
];

/** buildPaperHtml.browser 动态 import 拦截：记录调用入参（R-2 探针） */
const browserRender = vi.hoisted(() => ({
  buildPaperHtml: vi.fn(async (_paper: Paper, _questions: Question[], _options: unknown) => '<html><body>preview</body></html>'),
}));

vi.mock('../../src/docgen/render/buildPaperHtml.browser.js', () => ({
  buildPaperHtml: browserRender.buildPaperHtml,
}));

vi.mock('../../src/app/services/BankServiceFactory.js', () => ({
  createBankService: () => ({
    getPaper: async (id: string) => (id === 'p1' ? PAPER : null),
    getPaperQuestions: async () => PAPER_REFS,
    getQuestion: async (id: string) => (id === 'q1' ? Q_IN_PAPER : id === 'q2' ? Q_AVAILABLE : null),
    listQuestions: async () => [Q_IN_PAPER, Q_AVAILABLE],
    createQuestion: async () => Q_IN_PAPER,
    addQuestion: async () => {},
    removeQuestion: async () => {},
    reorderQuestions: async () => {},
    setQuestionScore: async () => {},
  }),
}));

// 0004：ComposePage 经 useExtPageServices 注入 ext 服务（排版间消费 getPaperEx/updatePaperStatus）
vi.mock('../../src/app/services/BankExtServiceFactory.js', () => ({
  createBankExtServices: () => ({
    paper: {
      getPaperEx: async (id: string) => (id === 'p1' ? PAPER : null),
      updatePaperStatus: async () => {},
      listPapersEx: async () => [],
    },
  }),
}));

import { ComposePage } from '../../src/app/pages/ComposePage.js';
import { BankBrowser } from '../../src/app/components/BankBrowser.js';

let container: HTMLDivElement;
let root: Root | null = null;

async function renderEditor() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => {
    root!.render(<ComposePage paperId="p1" />);
  });
  // 等 loadPaper 异步链落定（左列题序列表渲染）
  await vi.waitFor(() => {
    if (!container.querySelector('ol > li')) throw new Error('主列表未渲染');
  });
}

function btn(text: string): HTMLButtonElement {
  const b = [...container.querySelectorAll('button')].find((x) => x.textContent === text);
  if (!b) throw new Error(`找不到按钮: ${text}`);
  return b as HTMLButtonElement;
}

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  delete window.__mofangPaths;
  browserRender.buildPaperHtml.mockClear();
});

describe('R-1 复核：主列表/选题弹层解析 data-assets + data-tex', () => {
  it('主列表：data-assets 图 → file:/// 绝对路径，公式 → KaTeX HTML，无 data-assets 残留', async () => {
    window.__mofangPaths = { userDataAssets: ASSETS_ROOT };
    await renderEditor();

    const listImgs = [...container.querySelectorAll('ol img')] as HTMLImageElement[];
    expect(listImgs.length).toBe(2);
    for (const img of listImgs) {
      expect(img.getAttribute('src')).toMatch(/^file:\/\/\/D:\/mofang-test\/data\/assets\/capture\/zujuan\/q1-/);
    }
    // 公式已渲染为 KaTeX
    expect(container.querySelector('ol .katex')).not.toBeNull();
    // 无未解析的 data-assets 残留
    expect(container.querySelector('ol')!.innerHTML).not.toContain('data-assets/');
  });

  it('选题列表（BankBrowser pick 模式；0018 返工二起由试题篮承载，排版间入口退役）：题卡直显，data-assets 解析 → file:/// + KaTeX', async () => {
    window.__mofangPaths = { userDataAssets: ASSETS_ROOT };
    // 0018 目检返工二：排版间「加题」入口退役 → 直挂 BankBrowser（pick 模式）验证其渲染契约
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => {
      root!.render(<BankBrowser onPick={() => {}} excludeIds={['q1']} />);
    });
    // 排除已在卷内的 q1，仅 q2 可选
    await vi.waitFor(() => {
      if (!container.querySelector('[data-testid="bank-item-q2"]')) throw new Error('选题列表未渲染');
    });

    // 0004-fix-1b：题卡直显（无收起摘要/无两级展开）——题干容器 .question-content + 完整文本
    const pickerItem = container.querySelector('[data-testid="bank-item-q2"]') as HTMLElement;
    const stem = pickerItem.querySelector('[data-testid="bank-stem-q2"]') as HTMLElement;
    expect(stem).not.toBeNull();
    expect(stem.className).toBe('question-content');
    expect(pickerItem.textContent).toContain('已知重力加速度');
    expect(pickerItem.querySelector('[data-testid="bank-detail-q2"]')).toBeNull();
    expect(pickerItem.querySelector('[data-testid="bank-item-detail-q2"]')).toBeNull();

    // 图随题内容流直显：data-assets → file:///；公式已渲染 KaTeX
    const imgs = [...pickerItem.querySelectorAll('img')] as HTMLImageElement[];
    expect(imgs.length).toBe(2);
    for (const img of imgs) {
      expect(img.getAttribute('src')).toMatch(/^file:\/\/\/D:\/mofang-test\/data\/assets\/capture\/zujuan\/q1-/);
    }
    expect(pickerItem.querySelector('.katex')).not.toBeNull();
  });
});

describe('R-2：预览窗 assetsRoot 显式传入（不依赖新窗 __mofangPaths）', () => {
  it('handlePreview 调用 buildPaperHtml 时显式携带 assetsRoot = 主窗 userDataAssets', async () => {
    window.__mofangPaths = { userDataAssets: ASSETS_ROOT };
    const written: string[] = [];
    const fakeWin = { document: { write: (s: string) => written.push(s), close: () => {} } };
    vi.stubGlobal('open', vi.fn(() => fakeWin));
    await renderEditor();

    flushSync(() => btn('预览学生版').click());
    await vi.waitFor(() => {
      if (browserRender.buildPaperHtml.mock.calls.length === 0) throw new Error('buildPaperHtml 未调用');
    });

    const options = browserRender.buildPaperHtml.mock.calls[0][2] as { assetsRoot?: string | null };
    expect(options.assetsRoot).toBe(ASSETS_ROOT);
    vi.unstubAllGlobals();
  });

  it('handleExport 同样显式携带 assetsRoot', async () => {
    window.__mofangPaths = { userDataAssets: ASSETS_ROOT };
    (window as any).__mofangBank = { exportPdf: vi.fn(async () => ({ filePath: null })) };
    await renderEditor();

    flushSync(() => btn('导出学生版 PDF').click());
    await vi.waitFor(() => {
      if (browserRender.buildPaperHtml.mock.calls.length === 0) throw new Error('buildPaperHtml 未调用');
    });

    const options = browserRender.buildPaperHtml.mock.calls[0][2] as { assetsRoot?: string | null };
    expect(options.assetsRoot).toBe(ASSETS_ROOT);
    delete (window as any).__mofangBank;
  });
});
