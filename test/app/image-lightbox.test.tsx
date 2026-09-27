// 0014 目检返工二：全局图片灯箱——各题目呈现区（题干/答案/解析）的图点击放大查看，
// ESC 或点击遮罩关闭；非题目区图片不触发。委托监听挂 document（捕获），AppShell 挂载一处全域生效。
// @vitest-environment jsdom

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ImageLightbox } from '../../src/app/components/ImageLightbox.js';

let container: HTMLDivElement;
let root: Root | null = null;

function render(ui: ReactElement) {
  root?.unmount();
  container?.remove();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => {
    root!.render(ui);
  });
}

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
});

const PROBE = (zone: string) => `
  <div class="${zone}">
    <img data-testid="probe-img" src="data-assets/capture/zujuan/a-1.png" />
  </div>
`;

function clickImg() {
  const img = container.querySelector('[data-testid="probe-img"]') as HTMLImageElement;
  if (!img) throw new Error('探针图未渲染');
  flushSync(() => img.click());
}

describe('0014 目检返工二：全局题目图片灯箱（ImageLightbox）', () => {
  beforeEach(() => {
    render(<><div dangerouslySetInnerHTML={{ __html: PROBE('question-content') }} /><ImageLightbox /></>);
  });

  it('点击题干区图片 → 灯箱打开并显示同源大图', () => {
    clickImg();
    const box = container.querySelector('[data-testid="image-lightbox"]') as HTMLElement | null;
    expect(box).not.toBeNull();
    const img = box!.querySelector('img') as HTMLImageElement;
    expect(img.getAttribute('src')).toContain('a-1.png');
  });

  it('答案/解析区图片同样触发（answer-field / analysis-field）', () => {
    for (const zone of ['answer-field', 'analysis-field']) {
      render(<><div dangerouslySetInnerHTML={{ __html: PROBE(zone) }} /><ImageLightbox /></>);
      clickImg();
      expect(container.querySelector('[data-testid="image-lightbox"]')).not.toBeNull();
    }
  });

  it('点击遮罩关闭；ESC 关闭', () => {
    clickImg();
    const box = () => container.querySelector('[data-testid="image-lightbox"]') as HTMLElement | null;
    expect(box()).not.toBeNull();
    flushSync(() => box()!.click());
    expect(box()).toBeNull();

    clickImg();
    expect(box()).not.toBeNull();
    flushSync(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(box()).toBeNull();
  });

  it('非题目区（无 question-content/answer-field 等容器）图片不触发灯箱', () => {
    render(<><div dangerouslySetInnerHTML={{ __html: PROBE('random-panel') }} /><ImageLightbox /></>);
    clickImg();
    expect(container.querySelector('[data-testid="image-lightbox"]')).toBeNull();
  });
});
