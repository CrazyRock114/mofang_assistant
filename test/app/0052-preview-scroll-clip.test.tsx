// 0052 目检追加（用户 2026-09-22 拍板「修预览区滚动条」）：预览缩放不得污染父层滚动范围。
//
// 根因：预览用 `transform: scale()` 缩放 iframe——transform 只改视觉、**不改 iframe 的布局盒**
// （布局盒恒为「纸宽 × 内容高」未缩放值）。包裹盒若不裁剪，父容器的滚动范围就按未缩放盒算：
//   ① 适配档（纸恰好填满）也冒横向滚动条（真机实测 容器 scrollW 818 vs clientW 577）；
//   ② 垂直/水平都能多滚一截空档（80% 态可多滚 ≈219px / ≈135px）；
//   ③ 容器滚动条因此压在纸的可视右缘上（用户目检「纸张内部也有一个滚动条」）。
// 修法：包裹盒裁掉未缩放布局盒（盒尺寸=视觉尺寸）；阴影从被裁的 iframe 移到包裹盒（不被裁）。
//
// jsdom 无布局引擎 → 本测试锚定「保证裁剪的 DOM/内联样式结构」；
// 真实滚动范围与滚动条由 scripts/probe-0052-preview-scroll.mjs（Electron 真机 + 真库副本）复跑。
// @vitest-environment jsdom

import { describe, it, expect, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { PaperPreviewFrame, mmToPx, stepZoom } from '../../src/app/pages/PaperPreviewFrame.js';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(pageWidthMm = 210): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => {
    root!.render(
      <PaperPreviewFrame
        html="<!DOCTYPE html><html><body><div class='paper'>预览</div></body></html>"
        pageWidthMm={pageWidthMm}
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

const iframe = (): HTMLIFrameElement => container!.querySelector('[data-testid="compose-preview-iframe"]') as HTMLIFrameElement;
/** 承载缩放的包裹盒 = iframe 的父元素 */
const scaler = (): HTMLElement => iframe().parentElement as HTMLElement;

function clickZoom(testid: 'preview-zoom-in' | 'preview-zoom-out' | 'preview-zoom-100' | 'preview-zoom-fit'): void {
  const btn = container!.querySelector(`[data-testid="${testid}"]`) as HTMLButtonElement;
  flushSync(() => btn.click());
}

/** 当前缩放倍率（从 iframe 的 transform 读，避免与内部 state 实现耦合） */
function scaleOf(el: HTMLIFrameElement): number {
  const m = /scale\(([\d.]+)\)/.exec(el.style.transform);
  if (!m) throw new Error(`iframe 无 scale transform：${el.style.transform}`);
  return Number(m[1]);
}

describe('0052 预览缩放：包裹盒裁剪未缩放布局盒（父层滚动范围=视觉尺寸）', () => {
  it('包裹盒尺寸=视觉尺寸（纸宽×scale / 内容高×scale）且裁掉未缩放布局盒', () => {
    mount();
    const paperPx = mmToPx(210);
    const k = scaleOf(iframe());
    const box = scaler();
    // ★ 关键不变量（本项修复本体）：裁剪——否则父容器按未缩放的 iframe 布局盒算滚动范围
    expect(box.style.overflow).toBe('hidden');
    // 视觉尺寸（未取整：取整会让盒比纸小 0.5px，裁剪时反切掉纸边）
    expect(Number.parseFloat(box.style.width)).toBeCloseTo(paperPx * k, 1);
    expect(Number.parseFloat(box.style.height)).toBeCloseTo(900 * k, 1);
    // 居中保持（React 会把 0 归一成 0px）
    expect(box.style.margin).toMatch(/^0(px)? auto$/);
  });

  it('缩放机制本身不变：iframe 仍是未缩放盒（纸宽/内容高）+ transform scale + origin 0 0', () => {
    mount();
    const frame = iframe();
    expect(Number.parseFloat(frame.style.width)).toBeCloseTo(mmToPx(210), 1);
    expect(Number.parseFloat(frame.style.height)).toBe(900, 1);
    expect(frame.style.transform).toMatch(/^scale\(/);
    expect(frame.style.transformOrigin).toBe('0 0');
  });

  it('缩放变化后包裹盒跟着走（滚动范围随视觉尺寸），裁剪不失效', () => {
    mount();
    const paperPx = mmToPx(210);
    for (const testid of ['preview-zoom-out', 'preview-zoom-in'] as const) {
      clickZoom(testid);
      const k = scaleOf(iframe());
      const box = scaler();
      expect(Number.parseFloat(box.style.width)).toBeCloseTo(paperPx * k, 1);
      expect(Number.parseFloat(box.style.height)).toBeCloseTo(900 * k, 1);
      expect(box.style.overflow).toBe('hidden');
    }
    // 100% 档（k=1）与适应档（jsdom 容器宽 0 → fit=1）同值，走一遍确保档位切换不破坏不变量
    clickZoom('preview-zoom-100');
    expect(scaleOf(iframe())).toBe(1);
    expect(Number.parseFloat(scaler().style.width)).toBeCloseTo(paperPx, 1);
    expect(scaler().style.overflow).toBe('hidden');
    clickZoom('preview-zoom-fit');
    expect(scaler().style.overflow).toBe('hidden');
  });

  it('阴影挂在包裹盒（盒=视觉尺寸，不被裁剪）；iframe 不再自带阴影（防双层）', () => {
    mount();
    expect(scaler().style.boxShadow).not.toBe('');
    expect(iframe().style.boxShadow).toBe('');
  });

  it('缩放步进口径不变（回归：stepZoom 纯函数仍被用作按钮步进）', () => {
    mount();
    const before = scaleOf(iframe());
    clickZoom('preview-zoom-out');
    expect(scaleOf(iframe())).toBeCloseTo(stepZoom(before, -1), 5);
  });
});

// ==================== 0052 目检追加二：高度未落定前不显示纸（纸内滚动条闪现） ====================
// 机理：iframe 缺省高 900 而文档实高由注入脚本上报（首报可能在图/字体就位前偏小）——这段窗口里
// iframe 内部文档高于 iframe → 纸内滚动条闪一下。门控=最近一次上报后静默 150ms 才显示。
describe('0052 预览高度门控：上报落定前整块不可见（防纸内滚动条闪现）', () => {
  /** 从预览 iframe 回投高度上报（source 必须是该 iframe 的 contentWindow，否则父层过滤） */
  function postHeight(height: number): void {
    const frame = iframe();
    const event = new MessageEvent('message', { data: { t: 'mf-height', height } });
    Object.defineProperty(event, 'source', { value: frame.contentWindow });
    flushSync(() => {
      window.dispatchEvent(event);
    });
  }

  it('初始不可见 → 收到高度上报并静默 150ms 后可见', async () => {
    mount();
    expect(scaler().style.visibility).toBe('hidden');

    postHeight(1202);
    // 上报后立刻仍不可见（还没静默够）
    expect(scaler().style.visibility).toBe('hidden');
    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(scaler().style.visibility).toBe('visible');
  });

  it('首次落定后再跳变不重新隐藏（编辑期不闪），尺寸跟随新高', async () => {
    mount();
    postHeight(1202);
    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(scaler().style.visibility).toBe('visible');

    // 编辑期纸高变化（如加题/改字号）→ 保持可见（二次门控会让预览每改一下闪一次），尺寸跟随
    postHeight(1500);
    expect(scaler().style.visibility).toBe('visible');
    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(scaler().style.visibility).toBe('visible');
    expect(Number.parseFloat(scaler().style.height)).toBeCloseTo(1500 * scaleOf(iframe()), 1);
  });

  it('首报连跳多下（883 → 1202）：以最后一次为准显示，不显示半路尺寸', async () => {
    mount();
    postHeight(883);
    await new Promise((resolve) => setTimeout(resolve, 60));  // 静默期未满
    expect(scaler().style.visibility).toBe('hidden');
    postHeight(1202);                                          // 跳变 → 重新计时
    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(scaler().style.visibility).toBe('visible');
    expect(Number.parseFloat(scaler().style.height)).toBeCloseTo(1202 * scaleOf(iframe()), 1);
  });
});
