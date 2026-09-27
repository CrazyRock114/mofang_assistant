// 0010 P2 观感项测试（任务书 §一 P2 / §三.4）：
// - P2-8 采集入库等待进度反馈：入库期间（collect 挂起）出现确定题数的不定态进度条 + 阶段文案，
//   完成后消失（渲染层 only，禁动采集逻辑/IPC —— 经 CaptureClient 桥注入驱动）。
// - P2-9 整卷预览加厚（契约边界内降级）：PaperPreviewItem 契约无完整题干/选项/配图字段
//   （src/shared/contracts/capture-types.ts 仅 stemSummary/knowledgePoints 等），
//   降级为「摘要行 + 逐题展开契约字段全文（知识点/子题/答案解析有无/题号）」交互。
// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import { CapturePage } from '../../src/app/pages/CapturePage.js';
import { CaptureClient } from '../../src/app/services/capture-client.js';
import type { MofangCaptureBridge } from '../../src/shared/contracts/bridge.js';
import type { PaperPreview } from '../../src/shared/contracts/capture-types.js';
import type { CaptureCollectPayload, CaptureCollectResult } from '../../src/shared/contracts/ipc-channels.js';

let container: HTMLDivElement;
let root: Root | null = null;

function render(client: CaptureClient) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => {
    root!.render(<CapturePage capture={client} pollIntervalMs={1000} />);
  });
}

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  window.location.hash = '';
});

/** 0012 目检返工：切到「采集界面」标签页（采集组件所在；幂等） */
function openPanel() {
  const b = container.querySelector('[data-testid="capture-tab-panel"]') as HTMLButtonElement | null;
  if (!b) throw new Error('找不到「采集界面」标签');
  if (!b.className.includes('btn-primary')) flushSync(() => b.click());
}

/** 切到「整卷下载」标签页（0012 目检返工 2；幂等） */
function openPaper() {
  const b = container.querySelector('[data-testid="capture-tab-paper"]') as HTMLButtonElement | null;
  if (!b) throw new Error('找不到「整卷下载」标签');
  if (!b.className.includes('btn-primary')) flushSync(() => b.click());
}

async function waitFor(assertion: () => void) {
  await vi.waitFor(assertion, { timeout: 2000, interval: 20 });
}

function btn(text: string): HTMLButtonElement {
  const b = [...container.querySelectorAll('button')].find((x) => x.textContent === text);
  if (!b) throw new Error(`找不到按钮: ${text}`);
  return b as HTMLButtonElement;
}

// ---------------- P2-8：入库进度反馈 ----------------

/** collect 挂起可控制的采集客户端（测试注入，不触碰页面/IPC 实现） */
class DeferredCollectClient extends CaptureClient {
  private resolvers: Array<(r: CaptureCollectResult) => void> = [];
  collect(_payload: CaptureCollectPayload): Promise<CaptureCollectResult> {
    return new Promise((resolve) => {
      this.resolvers.push(resolve);
    });
  }
  flush(result: CaptureCollectResult): void {
    const pending = this.resolvers;
    this.resolvers = [];
    pending.forEach((resolve) => resolve(result));
  }
}

describe('0010 P2-8：采集入库等待进度反馈', () => {
  it('入库请求挂起期间出现进度反馈（题数确定 + 动画轨道），完成后消失', async () => {
    const client = new DeferredCollectClient();
    render(client);

    // 走到「有提取结果」状态（mock 链路 3 题）
    flushSync(() => btn('组卷网').click());
    await waitFor(() => expect(container.querySelector('[data-testid="capture-site-badge"]')!.textContent).toContain('组卷网'));
    flushSync(() => btn('导出试题篮').click());
    openPanel();
    await waitFor(() => {
      expect(container.querySelectorAll('[data-testid^="capture-item-"]').length).toBe(3);
    });

    // 入库：collect 挂起 → 进度反馈出现，携带确定题数
    flushSync(() => btn('入库').click());
    const progress = await vi.waitFor(() => {
      const el = container.querySelector('[data-testid="collect-progress"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    }, { timeout: 2000, interval: 20 });
    expect(progress.getAttribute('data-count')).toBe('3');
    expect(progress.textContent).toContain('正在入库 3 题');

    // 完成后进度反馈消失，入库结果回显
    flushSync(() => client.flush({ ok: 3, dup: 0, failed: [] }));
    await waitFor(() => {
      expect(container.querySelector('[data-testid="collect-progress"]')).toBeNull();
    });
    expect(container.querySelector('[data-testid="collect-ok"]')!.textContent).toBe('3');
  });
});

// ---------------- P2-9：整卷预览逐题展开 ----------------

const PREVIEW_FIXTURE: PaperPreview = {
  url: 'https://zujuan.xkw.com/4p100.html',
  bankId: '4',
  paperId: '100',
  title: '力学综合练习卷',
  total: 2,
  items: [
    {
      questionId: 'q1',
      questionType: '计算题',
      difficulty: '★ 基础',
      stemSummary: '一物体质量为 2 kg，受到 6 N 的水平拉力，由静止开始运动，求加速度大小。',
      answerPresent: true,
      analysisPresent: false,
      childCount: 1,
      knowledgePoints: ['牛顿第二定律', '运动学公式'],
    },
    {
      questionId: 'q2',
      questionType: '选择题',
      stemSummary: '关于光的反射定律，下列说法正确的是（　　）',
      answerPresent: false,
      analysisPresent: false,
      childCount: 1,
    },
  ],
  missing: [],
  warnings: [],
};

function paperPreviewBridge(): MofangCaptureBridge {
  const base = CaptureClient.prototype;
  void base;
  return {
    openWindow: async () => {},
    closeWindow: async () => {},
    navigate: async () => {},
    getState: async () => ({
      open: false,
      url: '',
      site: null,
      loggedIn: false,
      lastExtraction: null,
    }),
    extractBasket: async () => ({ extracted: undefined as never }),
    getLastExtraction: async () => ({ extracted: null }),
    collect: async (payload: CaptureCollectPayload): Promise<CaptureCollectResult> => ({ ok: 0, dup: 0, failed: [] }),
    paperPreview: async () => PREVIEW_FIXTURE,
    paperImport: async () => ({ target: 'paper', paperTitle: PREVIEW_FIXTURE.title, done: true, snapshotCount: 2, ok: 0, dup: 0, failed: [], warnings: [] }),
  } as unknown as MofangCaptureBridge;
}

describe('0010 P2-9：整卷预览逐题展开（契约字段边界内加厚）', () => {
  it('默认收起显示摘要；展开后呈现题干全文 + 知识点等契约字段；再点收起', async () => {
    render(new CaptureClient(paperPreviewBridge()));
    openPaper();

    const input = container.querySelector('[data-testid="paper-url-input"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    flushSync(() => {
      setter.call(input, PREVIEW_FIXTURE.url);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    flushSync(() => (container.querySelector('[data-testid="paper-preview-button"]') as HTMLButtonElement).click());
    await waitFor(() => {
      expect(container.querySelector('[data-testid="paper-preview-panel"]')).not.toBeNull();
    });
    expect(container.querySelector('[data-testid="paper-preview-count"]')!.textContent).toContain('共 2 题');

    // 默认收起：明细区不在 DOM，摘要行可见
    expect(container.querySelector('[data-testid="paper-item-detail-q1"]')).toBeNull();
    expect(container.querySelector('[data-testid="paper-item-q1"]')!.textContent).toContain('求加速度大小');

    // 展开 q1：题干全文 + 知识点 + 答案/解析有无
    flushSync(() => (container.querySelector('[data-testid="paper-item-toggle-q1"]') as HTMLButtonElement).click());
    const detail = container.querySelector('[data-testid="paper-item-detail-q1"]');
    expect(detail).not.toBeNull();
    expect(detail!.textContent).toContain('一物体质量为 2 kg，受到 6 N 的水平拉力，由静止开始运动，求加速度大小。');
    expect(detail!.textContent).toContain('牛顿第二定律');
    expect(detail!.textContent).toContain('运动学公式');
    expect(detail!.textContent).toContain('答案：有');
    expect(detail!.textContent).toContain('解析：缺');

    // 收起
    flushSync(() => (container.querySelector('[data-testid="paper-item-toggle-q1"]') as HTMLButtonElement).click());
    expect(container.querySelector('[data-testid="paper-item-detail-q1"]')).toBeNull();
  });
});

// ==================== 0012 目检返工 5：整卷抓取/导入读条 ====================

describe('0012 目检返工 5：整卷下载读条', () => {
  it('「整卷下载」与「导入」抓取期间出现读条（区分阶段），完成后消失', async () => {
    let resolvePreview: (v: PaperPreview) => void = () => {};
    let resolveImport: (v: unknown) => void = () => {};
    const bridge: MofangCaptureBridge = {
      openWindow: async () => {},
      closeWindow: async () => {},
      navigate: async () => {},
      getState: async () => ({ open: false, url: '', title: '', site: null, loggedIn: false, lastExtraction: null }),
      extractBasket: async () => ({ extracted: { url: '', mode: 'none', captured: [], warnings: [] } }),
      collect: async () => ({ ok: 0, dup: 0, failed: [] }),
      getLastExtraction: async () => ({ extracted: null }),
      onEvent: () => () => {},
      setBounds: async () => {},
      savePageHtml: async () => ({ ok: false, error: 'mock' }),
      paperPreview: () => new Promise<PaperPreview>((r) => { resolvePreview = r; }),
      paperImport: () => new Promise<unknown>((r) => { resolveImport = r; }) as never,
    };
    render(new CaptureClient(bridge));
    openPaper();

    const input = container.querySelector('[data-testid="paper-url-input"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    flushSync(() => {
      setter.call(input, PREVIEW_FIXTURE.url);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    flushSync(() => (container.querySelector('[data-testid="paper-preview-button"]') as HTMLButtonElement).click());

    // 抓取阶段读条
    await waitFor(() => expect(container.querySelector('[data-testid="paper-progress"]')).not.toBeNull());
    expect(container.querySelector('[data-testid="paper-progress"]')!.getAttribute('data-phase')).toBe('preview');
    expect(container.querySelector('[data-testid="paper-progress"]')!.textContent).toContain('正在抓取整卷');

    resolvePreview(PREVIEW_FIXTURE);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="paper-progress"]')).toBeNull();
      expect(container.querySelector('[data-testid="paper-preview-panel"]')).not.toBeNull();
    });

    // 导入阶段读条
    flushSync(() => (container.querySelector('[data-testid="paper-import-button"]') as HTMLButtonElement).click());
    await waitFor(() => expect(container.querySelector('[data-testid="paper-progress"]')).not.toBeNull());
    expect(container.querySelector('[data-testid="paper-progress"]')!.getAttribute('data-phase')).toBe('import');
    expect(container.querySelector('[data-testid="paper-progress"]')!.textContent).toContain('正在导入整卷');

    resolveImport({
      target: 'paper', paperId: 'p1', paperTitle: PREVIEW_FIXTURE.title, snapshotCount: 1, done: true,
      ok: 1, dup: 0, failed: [], warnings: [],
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="paper-progress"]')).toBeNull();
      expect(container.querySelector('[data-testid="paper-import-result"]')).not.toBeNull();
    });
  });
});
