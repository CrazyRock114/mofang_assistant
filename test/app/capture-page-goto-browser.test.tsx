// 0020 P2：整卷下载挑战自助跳转按钮（三处挂载点：paper-error / paper-preview-warnings / paper-import-warnings）
//
// 语义边界（任务书 §一 禁区）：按钮只做「切浏览器页 + 导航到整卷页」，人工过验证后由用户自己回来重试；
// 不自动绕过、不自动重试、不承诺「点后自动恢复」。
//
// 挑战消息文案：由单源常量拼装（与 collect.ts 同源；逐字原文由 test/capture/challenge-hint.test.ts 锚定真实产出）。
// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import { CapturePage } from '../../src/app/pages/CapturePage.js';
import { CaptureClient } from '../../src/app/services/capture-client.js';
import { PAPER_CHALLENGE_MARK } from '../../src/capture/papers/challenge-hint.js';
import { ZUJUAN_PAPER_URL_HINT } from '../../src/capture/papers/paper-url.js';
import type { MofangCaptureBridge } from '../../src/shared/contracts/bridge.js';
import type { PaperPreview } from '../../src/shared/contracts/capture-types.js';

const PAPER_URL = 'https://zujuan.xkw.com/4p2338916.html';
/** collect.ts:89 同源文案（经 challenge-hint 常量拼装） */
const PC_CHALLENGE_MSG = `组卷整卷页返回${PAPER_CHALLENGE_MARK}（滑块/验证码）：请在采集窗口打开该整卷页人工通过后再试（本工具不自动绕过）`;
/** collect.ts:118 同源文案 */
const BATCH_CHALLENGE_MSG = `题批接口遇${PAPER_CHALLENGE_MARK}（第 1/3 批）：请在采集窗口访问 mzujuan.xkw.com 人工通过后再重试（不自动绕过）`;
/** 非挑战告警（覆盖率缺口，同链路真实文案形态） */
const GAP_WARNING = '题批接口未返回 1 题（站点覆盖率缺口）：25064552';

let container: HTMLDivElement;
let root: Root | null = null;

function render(client: CaptureClient) {
  root?.unmount();
  root = null;
  container?.remove();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => {
    root!.render(<CapturePage capture={client} pollIntervalMs={100000} />);
  });
}

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  window.location.hash = '';
});

async function waitFor(assertion: () => void) {
  await vi.waitFor(assertion, { timeout: 2000, interval: 20 });
}

function testid(id: string): HTMLElement {
  const el = container.querySelector(`[data-testid="${id}"]`);
  if (!el) throw new Error(`找不到 testid: ${id}`);
  return el as HTMLElement;
}

function findTestid(id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
}

/** 切到「整卷下载」标签页（幂等） */
function openPaper() {
  const b = testid('capture-tab-paper') as HTMLButtonElement;
  if (!b.className.includes('btn-primary')) flushSync(() => b.click());
}

/** 填 URL 输入框（React 受控输入经原型 setter + input 事件） */
function setPaperUrl(value: string) {
  const input = testid('paper-url-input') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  flushSync(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** 点「整卷下载」（触发 preview） */
function clickPreview() {
  flushSync(() => (testid('paper-preview-button') as HTMLButtonElement).click());
}

function activeTab(): 'browser' | 'panel' | 'paper' {
  for (const t of ['browser', 'panel', 'paper'] as const) {
    if (testid(`capture-tab-${t}`).className.includes('btn-primary')) return t;
  }
  throw new Error('无激活页签');
}

function makePreview(overrides: Partial<PaperPreview> = {}): PaperPreview {
  return {
    url: PAPER_URL,
    bankId: '4',
    paperId: '2338916',
    title: '样本卷',
    total: 1,
    items: [{
      questionId: '22724580', bankType: '4', questionType: '单选题', difficulty: '较易',
      stemSummary: '样本题干', answerPresent: true, analysisPresent: true, childCount: 1,
    }] as PaperPreview['items'],
    missing: [],
    warnings: [],
    ...overrides,
  };
}

function makeBridge(opts: {
  preview?: () => Promise<PaperPreview>;
  importResult?: () => Promise<unknown>;
} = {}) {
  const navigate = vi.fn(async () => { /* 记录调用 */ });
  const bridge = {
    openWindow: async () => {},
    closeWindow: async () => {},
    navigate,
    getState: async () => ({ open: false, url: '', title: '', site: null, loggedIn: false, lastExtraction: null }),
    extractBasket: async () => ({ extracted: { url: '', mode: 'none', captured: [], warnings: [] } }),
    getLastExtraction: async () => ({ extracted: null }),
    collect: async () => ({ ok: 0, dup: 0, failed: [] }),
    setBounds: async () => {},
    onEvent: () => () => {},
    savePageHtml: async () => ({ ok: false, error: 'mock' }),
    paperPreview: opts.preview ?? (async () => makePreview()),
    paperImport: opts.importResult ?? (async () => ({
      target: 'paper', paperId: 'p1', paperTitle: '样本卷', snapshotCount: 1, done: true,
      ok: 1, dup: 0, failed: [], warnings: [],
    })),
  } as unknown as MofangCaptureBridge;
  return { bridge, navigate };
}

describe('0020 P2：挑战自助跳转按钮', () => {
  it('preview 抛挑战错 → paper-error 内出现按钮；点击切浏览器页并以整卷 URL 导航（via 缺省 url）', async () => {
    const { bridge, navigate } = makeBridge({
      preview: async () => { throw new Error(PC_CHALLENGE_MSG); },
    });
    render(new CaptureClient(bridge));
    openPaper();
    setPaperUrl(PAPER_URL);
    clickPreview();

    await waitFor(() => expect(testid('paper-error').textContent).toContain(PAPER_CHALLENGE_MARK));
    const goto = testid('paper-error-goto-browser') as HTMLButtonElement;
    expect(goto.textContent).toBe('去浏览器页打开本卷');
    expect(goto.disabled).toBe(false);
    // 不承诺自动恢复：title 提示人工过验证后自行重试
    expect(goto.title).toContain('人工');
    expect(goto.title).not.toContain('自动恢复');

    flushSync(() => goto.click());
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(navigate).toHaveBeenCalledWith({ url: PAPER_URL, via: 'url' });
    await waitFor(() => expect(activeTab()).toBe('browser'));
  });

  it('非挑战错误 → 无按钮（URL 非法 / 无题号两类）', async () => {
    const { bridge: badUrl } = makeBridge({
      preview: async () => { throw new Error(ZUJUAN_PAPER_URL_HINT); },
    });
    render(new CaptureClient(badUrl));
    openPaper();
    setPaperUrl('https://www.jyeoo.com/physics2/ques/detail/x');
    clickPreview();
    await waitFor(() => expect(testid('paper-error')).not.toBeNull());
    expect(findTestid('paper-error-goto-browser')).toBeNull();

    const { bridge: noEntries } = makeBridge({
      preview: async () => { throw new Error('未取到整卷题号（PC 详情页结构变化或页面未加载完成，请稍后重试）'); },
    });
    render(new CaptureClient(noEntries));
    openPaper();
    setPaperUrl(PAPER_URL);
    clickPreview();
    await waitFor(() => expect(testid('paper-error').textContent).toContain('未取到整卷题号'));
    expect(findTestid('paper-error-goto-browser')).toBeNull();
  });

  it('preview warnings 含挑战（题批接口段）→ 列表旁恰一个按钮；不含 → 无按钮', async () => {
    const { bridge, navigate } = makeBridge({
      preview: async () => makePreview({ warnings: [BATCH_CHALLENGE_MSG, GAP_WARNING] }),
    });
    render(new CaptureClient(bridge));
    openPaper();
    setPaperUrl(PAPER_URL);
    clickPreview();

    await waitFor(() => expect(testid('paper-preview-warnings')).not.toBeNull());
    // 任一 warning 命中即出现「一个」按钮（非逐条）
    expect(container.querySelectorAll('[data-testid="paper-preview-goto-browser"]')).toHaveLength(1);
    const goto = testid('paper-preview-goto-browser') as HTMLButtonElement;
    expect(goto.disabled).toBe(false);

    flushSync(() => goto.click());
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ url: PAPER_URL, via: 'url' }));
    await waitFor(() => expect(activeTab()).toBe('browser'));

    // 不含挑战的 warnings → 无按钮
    const { bridge: plain } = makeBridge({
      preview: async () => makePreview({ warnings: [GAP_WARNING] }),
    });
    render(new CaptureClient(plain));
    openPaper();
    setPaperUrl(PAPER_URL);
    clickPreview();
    await waitFor(() => expect(testid('paper-preview-warnings')).not.toBeNull());
    expect(findTestid('paper-preview-goto-browser')).toBeNull();
  });

  it('import warnings 含挑战 → 列表旁恰一个按钮并可跳转；不含 → 无按钮', async () => {
    const preview = makePreview();
    const { bridge, navigate } = makeBridge({
      preview: async () => preview,
      importResult: async () => ({
        target: 'bank', ok: 1, dup: 0, failed: [], warnings: [BATCH_CHALLENGE_MSG],
      }),
    });
    render(new CaptureClient(bridge));
    openPaper();
    setPaperUrl(PAPER_URL);
    clickPreview();
    await waitFor(() => expect(testid('paper-preview-panel')).not.toBeNull());

    flushSync(() => (testid('paper-import-button') as HTMLButtonElement).click());
    await waitFor(() => expect(testid('paper-import-warnings')).not.toBeNull());
    expect(container.querySelectorAll('[data-testid="paper-import-goto-browser"]')).toHaveLength(1);
    const goto = testid('paper-import-goto-browser') as HTMLButtonElement;
    expect(goto.disabled).toBe(false);

    flushSync(() => goto.click());
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ url: PAPER_URL, via: 'url' }));
    await waitFor(() => expect(activeTab()).toBe('browser'));

    // 不含挑战的 import warnings → 无按钮
    const { bridge: plain } = makeBridge({
      preview: async () => preview,
      importResult: async () => ({
        target: 'bank', ok: 1, dup: 0, failed: [],
        warnings: ['题批接口未返回 1 题（站点覆盖率缺口）：25064552'],
      }),
    });
    render(new CaptureClient(plain));
    openPaper();
    setPaperUrl(PAPER_URL);
    clickPreview();
    await waitFor(() => expect(testid('paper-preview-panel')).not.toBeNull());
    flushSync(() => (testid('paper-import-button') as HTMLButtonElement).click());
    await waitFor(() => expect(testid('paper-import-warnings')).not.toBeNull());
    expect(findTestid('paper-import-goto-browser')).toBeNull();
  });

  it('输入框脏值且无 preview → 按钮禁用（title 说明），点击不导航；有 preview 时以 preview.url 为准', async () => {
    // 脏值 + 挑战错（防御分支：真实链路脏值走 URL 校验错，此处注入挑战错以验禁用口径）
    const { bridge, navigate } = makeBridge({
      preview: async () => { throw new Error(PC_CHALLENGE_MSG); },
    });
    render(new CaptureClient(bridge));
    openPaper();
    setPaperUrl('https://zujuan.xkw.com/not-a-paper.html');
    clickPreview();

    await waitFor(() => expect(testid('paper-error')).not.toBeNull());
    const goto = findTestid('paper-error-goto-browser') as HTMLButtonElement | null;
    if (goto) {
      expect(goto.disabled).toBe(true);
      expect(goto.title).toContain('整卷');
      flushSync(() => goto.click());
      expect(navigate).not.toHaveBeenCalled();
    }
    await waitFor(() => expect(activeTab()).toBe('paper')); // 未切页

    // 有 preview 时目标以 preview.url 为准（输入框随后被改成脏值仍可跳转）
    const preview = makePreview({ warnings: [BATCH_CHALLENGE_MSG] });
    const { bridge: withPreview, navigate: nav2 } = makeBridge({ preview: async () => preview });
    render(new CaptureClient(withPreview));
    openPaper();
    setPaperUrl(PAPER_URL);
    clickPreview();
    await waitFor(() => expect(testid('paper-preview-warnings')).not.toBeNull());
    setPaperUrl('脏值 not a url');
    const goto2 = testid('paper-preview-goto-browser') as HTMLButtonElement;
    expect(goto2.disabled).toBe(false);
    flushSync(() => goto2.click());
    await waitFor(() => expect(nav2).toHaveBeenCalledWith({ url: PAPER_URL, via: 'url' }));
  });
});
