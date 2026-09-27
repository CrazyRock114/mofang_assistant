// 0020 目检返工：整卷下载结果呈现位置与形态
//  返工 1（首轮）：结果应显示在试卷内容预览上方，而非页面底部。
//  返工 4（二轮）：结果改为**单独框**呈现，位置与「下载中」读条（paper-progress）相同——
//    即整卷下载卡片之前的同一槽位，不再挤在试卷标题下当一行文字。
// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import { CapturePage } from '../../src/app/pages/CapturePage.js';
import { CaptureClient } from '../../src/app/services/capture-client.js';
import type { MofangCaptureBridge } from '../../src/shared/contracts/bridge.js';
import type { PaperPreview } from '../../src/shared/contracts/capture-types.js';

const PAPER_URL = 'https://zujuan.xkw.com/4p2338916.html';

const PREVIEW: PaperPreview = {
  url: PAPER_URL,
  bankId: '4',
  paperId: '2338916',
  title: '样本卷',
  total: 2,
  items: [
    {
      questionId: '22724580', bankType: '4', questionType: '单选题', difficulty: '较易',
      stemSummary: '样本题干一', answerPresent: true, analysisPresent: true, childCount: 1,
    },
    {
      questionId: '22724581', bankType: '4', questionType: '填空题', difficulty: '适中',
      stemSummary: '样本题干二', answerPresent: true, analysisPresent: false, childCount: 1,
    },
  ] as PaperPreview['items'],
  missing: [],
  warnings: [],
};

let container: HTMLDivElement;
let root: Root | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  window.location.hash = '';
});

function testid(id: string): HTMLElement {
  const el = container.querySelector(`[data-testid="${id}"]`);
  if (!el) throw new Error(`找不到 testid: ${id}`);
  return el as HTMLElement;
}

async function waitFor(assertion: () => void) {
  await vi.waitFor(assertion, { timeout: 2000, interval: 20 });
}

function makeBridge(): MofangCaptureBridge {
  return {
    openWindow: async () => {},
    closeWindow: async () => {},
    navigate: async () => {},
    getState: async () => ({ open: false, url: '', title: '', site: null, loggedIn: false, lastExtraction: null }),
    extractBasket: async () => ({ extracted: { url: '', mode: 'none', captured: [], warnings: [] } }),
    getLastExtraction: async () => ({ extracted: null }),
    collect: async () => ({ ok: 0, dup: 0, failed: [] }),
    setBounds: async () => {},
    onEvent: () => () => {},
    savePageHtml: async () => ({ ok: false, error: 'mock' }),
    paperPreview: async () => PREVIEW,
    paperImport: async () => ({
      target: 'bank', ok: 2, dup: 0, failed: [], warnings: [],
    }),
  } as unknown as MofangCaptureBridge;
}

/** 渲染 → 切整卷页 → 预览 → 导入，返回结果框元素 */
async function runImportFlow(): Promise<HTMLElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => {
    root!.render(<CapturePage capture={new CaptureClient(makeBridge())} pollIntervalMs={100000} />);
  });

  flushSync(() => (testid('capture-tab-paper') as HTMLButtonElement).click());

  const input = testid('paper-url-input') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  flushSync(() => {
    setter.call(input, PAPER_URL);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  flushSync(() => (testid('paper-preview-button') as HTMLButtonElement).click());
  await waitFor(() => expect(container.querySelector('[data-testid="paper-preview-panel"]')).not.toBeNull());

  flushSync(() => (testid('paper-import-button') as HTMLButtonElement).click());
  await waitFor(() => expect(container.querySelector('[data-testid="paper-import-result"]')).not.toBeNull());
  return testid('paper-import-result');
}

describe('0020 目检返工：整卷下载结果位置与形态', () => {
  it('结果以单独框呈现，且位置与「下载中」读条相同（整卷下载卡片之前的同槽位）', async () => {
    const result = await runImportFlow();

    // 形态：单独框（复用读条同款壳样式），不再是试卷标题下的一行文字
    expect(result.className).toContain('progress-shell');

    // 位置：与 paper-progress 同槽位——整卷下载卡片之前；且不再挂在预览面板内
    const download = testid('paper-download');
    expect(result.compareDocumentPosition(download) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(testid('paper-preview-panel').contains(result)).toBe(false);

    // 结果语义仍完整（去向结果 + 计数）
    expect(result.textContent).toContain('成功');
    expect(result.textContent).toContain('2');
  });
});
