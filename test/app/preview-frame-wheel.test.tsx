// 0004-fix-4 #1（目检 #1）：预览 Ctrl+滚轮/触控板捏合缩放。
// 根因（验收方代码级确认）：wheel 监听只挂在容器 div 上——iframe 内的手势事件不跨文档冒泡到容器，
// 纸面上 Ctrl+双指/捏合完全无响应（按钮缩放正常）。修复=iframe load 后在 contentWindow 上另挂一份。
// 本测试断言两条链路都生效：①容器灰边区；②iframe contentWindow（srcdoc 同源）。
// @vitest-environment jsdom

import { describe, it, expect, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { PaperPreviewFrame, wheelZoom } from '../../src/app/pages/PaperPreviewFrame.js';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => {
    root!.render(
      <PaperPreviewFrame
        html="<!DOCTYPE html><html><body><div class='paper'>预览</div></body></html>"
        pageWidthMm={210}
        onMessage={() => undefined}
      />
    );
  });
}

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
});

function zoomLabel(): string {
  return container!.querySelector('[data-testid="preview-zoom-label"]')!.textContent ?? '';
}

function fireWheel(target: EventTarget, deltaY: number, ctrlKey = true): WheelEvent {
  const event = new WheelEvent('wheel', { deltaY, ctrlKey, bubbles: true, cancelable: true });
  flushSync(() => {
    target.dispatchEvent(event);
  });
  return event;
}

describe('fix-4 #1 wheelZoom 纯函数', () => {
  it('deltaY<0 放大 / deltaY>0 缩小，钳到 [0.3,3]', () => {
    expect(wheelZoom(1, -100)).toBe(1.1);
    expect(wheelZoom(1, 100)).toBe(0.91);
    expect(wheelZoom(0.3, 100)).toBe(0.3);
    expect(wheelZoom(3, -100)).toBe(3);
  });
});

describe('fix-4 #1 预览 Ctrl+滚轮缩放（两条监听链路）', () => {
  it('容器（纸外灰边区）Ctrl+滚轮 → 缩放生效并可 preventDefault', () => {
    mount();
    expect(zoomLabel()).toBe('100%');
    const event = fireWheel(container!.querySelector('[data-testid="compose-paper-preview"]')!, -100);
    expect(zoomLabel()).toBe('110%');
    expect(event.defaultPrevented).toBe(true);
  });

  it('非 Ctrl 滚轮不缩放（保持页面正常滚动）', () => {
    mount();
    const event = fireWheel(container!.querySelector('[data-testid="compose-paper-preview"]')!, -100, false);
    expect(zoomLabel()).toBe('100%');
    expect(event.defaultPrevented).toBe(false);
  });

  it('iframe 内文档（纸面上手势）Ctrl+滚轮 → 缩放生效（旧实现此路径完全无响应）', () => {
    mount();
    const iframe = container!.querySelector('[data-testid="compose-preview-iframe"]') as HTMLIFrameElement;
    const win = iframe.contentWindow;
    expect(win).toBeTruthy();
    // 触发 React onLoad（jsdom 不自动装载 srcdoc 文档）
    flushSync(() => {
      iframe.dispatchEvent(new Event('load'));
    });
    expect(zoomLabel()).toBe('100%');
    const event = fireWheel(win!, -100);
    expect(zoomLabel()).toBe('110%');
    expect(event.defaultPrevented).toBe(true);
  });
});

// ---------------- 0011 §一.8：预览 fit 自适应真化（ResizeObserver 监听容器宽） ----------------

describe('0011 预览 ResizeObserver：容器宽变化触发 fit 重算', () => {
  /** jsdom 无 ResizeObserver——注入可手动触发的 stub（模拟侧栏折叠/拖宽后的容器宽变化） */
  class ResizeObserverStub {
    static instances: ResizeObserverStub[] = [];
    callback: (entries: unknown[]) => void;
    observed: Element | null = null;
    constructor(cb: (entries: unknown[]) => void) {
      this.callback = cb;
      ResizeObserverStub.instances.push(this);
    }
    observe(el: Element): void {
      this.observed = el;
    }
    unobserve(): void {}
    disconnect(): void {}
    trigger(): void {
      this.callback([]);
    }
  }

  afterEach(() => {
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  });

  it('观察目标是预览容器本身；容器宽变窄 → fit 缩放重算（旧实现只挂 window resize 不触发）', () => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
    ResizeObserverStub.instances = [];
    mount();
    const el = container!.querySelector('[data-testid="compose-paper-preview"]') as HTMLElement;
    const ro = ResizeObserverStub.instances.at(-1)!;
    expect(ro.observed).toBe(el);
    // 初始 clientWidth=0（jsdom）→ fit=100%
    expect(zoomLabel()).toBe('100%');

    // 模拟侧栏折叠后容器变窄（500px）
    Object.defineProperty(el, 'clientWidth', { configurable: true, value: 500 });
    flushSync(() => ro.trigger());
    const expected = `${Math.round(((500 - 48) / ((210 * 96) / 25.4)) * 100)}%`;
    expect(zoomLabel()).toBe(expected);

    // 手动缩放后容器再变化：手动模式不联动（保持既有语义）
    flushSync(() => fireWheel(el, -100));
    const manual = zoomLabel();
    Object.defineProperty(el, 'clientWidth', { configurable: true, value: 800 });
    flushSync(() => ro.trigger());
    expect(zoomLabel()).toBe(manual);
  });
});
