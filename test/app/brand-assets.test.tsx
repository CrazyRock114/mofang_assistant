// 0010-merge P3：品牌资产验收——吉祥物位图映射（表情名 → 裁图文件）、裁图产物契约、
// 空状态默认站立、Logo 资产在库。vite import 的 png 在 vitest 下解析为资产 URL（路径含文件名）。
// @vitest-environment jsdom

import { describe, it, expect, afterEach } from 'vitest';
import type { ReactElement } from 'react';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import { Mascot, type MascotMood } from '../../src/app/components/Mascot.js';
import { EmptyState } from '../../src/app/pages/ExtUi.js';

const BRAND_DIR = resolve(process.cwd(), 'src/app/assets/brand');
const MOODS: MascotMood[] = ['stand', 'happy', 'like', 'work', 'lost', 'cheer', 'bye'];

let container: HTMLDivElement;
let root: Root | null = null;

function render(ui: ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => root!.render(ui));
}

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
});

describe('0010-merge P3 吉祥物位图组件（Mascot）', () => {
  it.each(MOODS)('mood=%s 渲染出对应 <img>，src 解析到 brand 资产 mascot-%s.png', (mood) => {
    render(<Mascot mood={mood} size={64} />);
    const img = container.querySelector('img[data-mascot]') as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.getAttribute('data-mascot')).toBe(mood);
    expect(img.getAttribute('src')).toContain(`mascot-${mood}`);
    expect(img.getAttribute('alt')).toBe('小方同学');
  });

  it('缺省 mood=stand；height 属性取 size，宽随内在比例（width:auto）', () => {
    render(<Mascot />);
    const img = container.querySelector('img[data-mascot]') as HTMLImageElement;
    expect(img.getAttribute('data-mascot')).toBe('stand');
    expect(img.getAttribute('height')).toBe('72');
    expect(img.style.width).toBe('auto');
  });

  it('空状态组件默认站立（stand）；可传 lost（失败/异常场景）', () => {
    render(<EmptyState>暂无内容</EmptyState>);
    expect(container.querySelector('img[data-mascot="stand"]')).not.toBeNull();

    render(<EmptyState mood="lost">加载失败</EmptyState>);
    expect(container.querySelector('img[data-mascot="lost"]')).not.toBeNull();
  });
});

describe('0010-merge P3 裁图产物契约（scripts/crop-brand-assets.mjs 输出）', () => {
  it('brand 目录资产齐备：7 表情 + 方块标 + 完整横版', () => {
    for (const mood of MOODS) {
      expect(existsSync(resolve(BRAND_DIR, `mascot-${mood}.png`)), `mascot-${mood}.png`).toBe(true);
    }
    expect(existsSync(resolve(BRAND_DIR, 'logo-mark.png'))).toBe(true);
    expect(existsSync(resolve(BRAND_DIR, 'logo-full.png'))).toBe(true);
  });

  it('表情图统一高度 512px（PNG IHDR 实测）', () => {
    for (const mood of MOODS) {
      const buf = readFileSync(resolve(BRAND_DIR, `mascot-${mood}.png`));
      // PNG 签名 8B + IHDR 长度/类型 8B → 宽在 offset 16、高在 offset 20（大端）
      expect(buf.readUInt32BE(20), `mascot-${mood}.png 高度`).toBe(512);
      expect(buf.readUInt32BE(16)).toBeGreaterThan(0);
    }
  });

  it('方块标/横版为合法 PNG；横版与 品牌源图同尺寸（2000×681）', () => {
    const mark = readFileSync(resolve(BRAND_DIR, 'logo-mark.png'));
    expect(mark[0]).toBe(0x89);
    expect(mark.subarray(1, 4).toString('ascii')).toBe('PNG');
    const full = readFileSync(resolve(BRAND_DIR, 'logo-full.png'));
    expect(full.readUInt32BE(16)).toBe(2000);
    expect(full.readUInt32BE(20)).toBe(681);
  });
});
