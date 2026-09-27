// D1 P1: CaptureClient 服务封装测试 — 桥透传 / mock 回落 / 工厂分路
// mock 数据须与 capture-types 契约同构（type-check 即验证），断言结构化（精确字段）
// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { MofangCaptureBridge } from '../../src/shared/contracts/bridge.js';
import type { CaptureExtraction, CaptureWindowState } from '../../src/shared/contracts/capture-types.js';
import { CaptureClient } from '../../src/app/services/capture-client.js';
import { createCaptureService } from '../../src/app/services/CaptureServiceFactory.js';

afterEach(() => {
  delete window.__mofangCapture;
});

describe('CaptureClient mock 回落（构造无桥）', () => {
  it('初始状态：窗口未打开、无站点、未登录', async () => {
    const client = new CaptureClient();
    const s = await client.getState();
    expect(s.open).toBe(false);
    expect(s.site).toBeNull();
    expect(s.loggedIn).toBe(false);
    expect(s.lastExtraction).toBeNull();
  });

  it('openWindow → navigate 组卷网：open=true、site=zujuan、loggedIn=true', async () => {
    const client = new CaptureClient();
    await client.openWindow();
    await client.navigate({ url: 'https://zujuan.xkw.com' });
    const s = await client.getState();
    expect(s.open).toBe(true);
    expect(s.url).toBe('https://zujuan.xkw.com');
    expect(s.site).toBe('zujuan');
    expect(s.loggedIn).toBe(true);
  });

  it('navigate 菁优网：site=jyeoo', async () => {
    const client = new CaptureClient();
    await client.openWindow();
    await client.navigate({ url: 'https://www.jyeoo.com' });
    const s = await client.getState();
    expect(s.site).toBe('jyeoo');
  });

  it('extractBasket（zujuan）：mode=zujuan-basket，3 题结构完整', async () => {
    const client = new CaptureClient();
    await client.openWindow();
    await client.navigate({ url: 'https://zujuan.xkw.com' });
    const { extracted } = await client.extractBasket();
    expect(extracted.mode).toBe('zujuan-basket');
    expect(extracted.captured.length).toBe(3);
    expect(Array.isArray(extracted.warnings)).toBe(true);
    const q1 = extracted.captured[0];
    expect(q1.questionId).toBe('13q900001');
    expect(q1.site).toBe('zujuan');
    expect(q1.stemHtml).toContain('data-tex=');
    expect(q1.options.length).toBe(4);
    expect(q1.answerHtml.length).toBeGreaterThan(0);
    expect(q1.meta.questionType).toBe('单选题');
    expect(q1.rect).toBeNull();
  });

  it('extractBasket（jyeoo）：gated 题 answerHtml 为空且 meta.gated=true，告警非空', async () => {
    const client = new CaptureClient();
    await client.openWindow();
    await client.navigate({ url: 'https://www.jyeoo.com' });
    const { extracted } = await client.extractBasket();
    expect(extracted.mode).toBe('jyeoo-basket');
    expect(extracted.captured.length).toBe(3);
    const gated = extracted.captured.find((q) => q.questionId === 'jyeoo-tid-900002');
    expect(gated).toBeDefined();
    expect(gated!.answerHtml).toBe('');
    expect(gated!.meta.gated).toBe(true);
    expect(gated!.meta.answerVia).toBe('vip-gated');
    expect(extracted.warnings.length).toBeGreaterThan(0);
  });

  it('collect 首次 ok=3 dup=0，二次同数据 dup=3（内存去重对齐真实链路；fix-1 D 增 okIds）', async () => {
    const client = new CaptureClient();
    await client.openWindow();
    await client.navigate({ url: 'https://zujuan.xkw.com' });
    const { extracted } = await client.extractBasket();

    const r1 = await client.collect({ extracted });
    expect(r1.ok).toBe(3);
    expect(r1.dup).toBe(0);
    expect(r1.failed).toEqual([]);
    // 0004-fix-1 D：首次新建的题 id 全量回传（供采集进篮联动逐个加篮）
    expect(r1.okIds).toHaveLength(3);
    expect(r1.okIds!.every((id) => id.startsWith('mock-q-zujuan:'))).toBe(true);

    const r2 = await client.collect({ extracted });
    expect(r2.ok).toBe(0);
    expect(r2.dup).toBe(3);
    expect(r2.failed).toEqual([]);
    // dup 不属本批新建 → okIds 空（语义与真实 ingest 一致）
    expect(r2.okIds).toEqual([]);
  });

  it('closeWindow 后状态归零', async () => {
    const client = new CaptureClient();
    await client.openWindow();
    await client.navigate({ url: 'https://zujuan.xkw.com' });
    await client.closeWindow();
    const s = await client.getState();
    expect(s.open).toBe(false);
    expect(s.url).toBe('');
    expect(s.site).toBeNull();
  });
});

describe('CaptureClient 桥模式（六方法一一透传）', () => {
  it('每个方法调用桥对应方法并原样传参/返回', async () => {
    const state: CaptureWindowState = {
      open: true,
      url: 'https://zujuan.xkw.com/basket',
      title: '试题篮',
      site: 'zujuan',
      loggedIn: true,
      lastExtraction: null,
    };
    const extraction: CaptureExtraction = { url: state.url, mode: 'zujuan-basket', captured: [], warnings: [] };
    const bridge: MofangCaptureBridge = {
      openWindow: vi.fn(async () => {}),
      closeWindow: vi.fn(async () => {}),
      navigate: vi.fn(async () => {}),
      getState: vi.fn(async () => state),
      extractBasket: vi.fn(async () => ({ extracted: extraction })),
      collect: vi.fn(async () => ({ ok: 1, dup: 2, failed: [{ questionId: 'q', error: 'e' }] })),
    };
    const client = new CaptureClient(bridge);

    await client.openWindow();
    expect(bridge.openWindow).toHaveBeenCalledTimes(1);

    await client.closeWindow();
    expect(bridge.closeWindow).toHaveBeenCalledTimes(1);

    await client.navigate({ url: 'https://example.com' });
    expect(bridge.navigate).toHaveBeenCalledWith({ url: 'https://example.com' });

    const s = await client.getState();
    expect(bridge.getState).toHaveBeenCalledTimes(1);
    expect(s).toBe(state);

    const e = await client.extractBasket();
    expect(bridge.extractBasket).toHaveBeenCalledTimes(1);
    expect(e.extracted).toBe(extraction);

    const r = await client.collect({ extracted: extraction });
    expect(bridge.collect).toHaveBeenCalledWith({ extracted: extraction });
    expect(r).toEqual({ ok: 1, dup: 2, failed: [{ questionId: 'q', error: 'e' }] });
  });
});

describe('createCaptureService 分路', () => {
  it('window.__mofangCapture 存在 → 走真实桥', async () => {
    const bridge: MofangCaptureBridge = {
      openWindow: vi.fn(async () => {}),
      closeWindow: vi.fn(async () => {}),
      navigate: vi.fn(async () => {}),
      getState: vi.fn(async () => ({
        open: false, url: '', title: '', site: null, loggedIn: false, lastExtraction: null,
      })),
      extractBasket: vi.fn(async () => ({ extracted: { url: '', mode: 'none', captured: [], warnings: [] } })),
      collect: vi.fn(async () => ({ ok: 0, dup: 0, failed: [] })),
    };
    window.__mofangCapture = bridge;
    const client = createCaptureService();
    await client.getState();
    expect(bridge.getState).toHaveBeenCalledTimes(1);
  });

  it('window.__mofangCapture 缺失 → 回落内存 mock', async () => {
    delete window.__mofangCapture;
    const client = createCaptureService();
    const s = await client.getState();
    expect(s.open).toBe(false);
    await client.openWindow();
    await client.navigate({ url: 'https://zujuan.xkw.com' });
    const { extracted } = await client.extractBasket();
    expect(extracted.mode).toBe('zujuan-basket');
  });
});
