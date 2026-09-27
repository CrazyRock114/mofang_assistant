// 0035 修复批 F1：SVG 资产支持（真题复现：采集站的公式/符号图多为 SVG，
// 旧实现只认 PNG/JPEG/GIF/BMP → 整幅落 [图缺失]，用户目检即此项）。
// 取向：SVG 走**栅格化**（渲染依赖注入；主进程 = 隐藏窗，测试注入替身），零新依赖。
// 覆盖：
//   ① 有栅格器：SVG → PNG 资产入卷（type=png），统计里不再计缺图；
//   ② 无栅格器（纯 node 环境/未接线）：显式记缺图 + 明确原因，不静默；
//   ③ 混合卷：位图直读 + SVG 栅格，两类都在；
//   ④ 栅格器失败：该图显式记缺图，其余照常出卷（不中断整卷）。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Paper, Question } from '../../src/shared/contracts/bank-types.js';
import { buildDocxBuffer, type DocxExportDeps } from '../../src/docgen/export/docx/index.js';
import type { AssetEntry } from '../../src/docgen/export/docx/assemble.js';
import type { MathItem } from '../../src/docgen/export/docx/plan.js';

/** 最小合法 PNG（1×1 灰点；zm 校验用） */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
);

const SVG_MARKUP = '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="39" viewBox="0 0 22 39">'
  + '<line x1="1" y1="38" x2="21" y2="1" stroke="black" stroke-width="2"/></svg>';

let assetsRoot: string;

beforeEach(() => {
  assetsRoot = mkdtempSync(join(tmpdir(), 'mf-docx-svg-'));
  mkdirSync(join(assetsRoot, 'capture'), { recursive: true });
  writeFileSync(join(assetsRoot, 'capture', 'diagram.png'), PNG_1PX);
  writeFileSync(join(assetsRoot, 'capture', 'symbol.svg'), SVG_MARKUP, 'utf-8');
});

afterEach(() => {
  rmSync(assetsRoot, { recursive: true, force: true });
});

function makePaper(): Paper {
  return { id: 'p1', title: 'SVG 卷', config: {}, createdAt: '2026-09-17T00:00:00Z', archived: false };
}

const CONTENT = '<div class="question">如图<span class="inline-figure">'
  + '<img class="q-figure" data-w="22" data-h="39" src="data-assets/capture/symbol.svg">'
  + '</span>所示<figure class="diagram" data-w="120"><img src="data-assets/capture/diagram.png"></figure></div>';

function makeQuestion(): Question {
  return {
    id: 'q1',
    subject: '物理',
    sourceType: 'local',
    sourceDetail: {},
    content: CONTENT,
    images: [
      { assetId: 'data-assets/capture/symbol.svg', type: 'figure' },
      { assetId: 'data-assets/capture/diagram.png', type: 'figure' },
    ],
    createdAt: '2026-09-17T00:00:00Z',
    updatedAt: '2026-09-17T00:00:00Z',
  };
}

const noMath = async (): Promise<{ images: Map<string, never>; failed: never[] }> => ({ images: new Map(), failed: [] });

/** SVG 栅格替身：把 SVG 字节换成 PNG（真实实现见 src/docgen/export/docx/svg-raster.ts） */
function stubSvgRasterizer(over: Partial<DocxExportDeps> = {}): DocxExportDeps {
  return {
    rasterize: noMath,
    assetsRoot,
    rasterizeSvg: async (items) => {
      const images = new Map<string, AssetEntry>();
      for (const item of items) {
        images.set(item.key, {
          kind: 'image',
          data: PNG_1PX,
          type: 'png',
          width: item.widthPx ?? 22,
          height: item.heightPx ?? 39,
        });
      }
      return { images, failed: [] };
    },
    ...over,
  };
}

const input = () => ({ paper: makePaper(), questions: [makeQuestion()], mode: 'student' as const });

describe('0035 修复批 F1：SVG 资产栅格入卷', () => {
  it('有栅格器：SVG 转 PNG 入卷，统计不再计缺图', async () => {
    const result = await buildDocxBuffer(input(), stubSvgRasterizer());
    expect(result.images.total).toBe(2);
    expect(result.images.embedded).toBe(2);
    expect(result.images.missing).toEqual([]);
    // SVG 也进了读盘/栅格清单（供主进程栅格器消费）
    expect(result.plan.imageSrcs).toContain('data-assets/capture/symbol.svg');
  });

  it('栅格器收到的是 SVG 原始字节 + 版式给的显示尺寸（data-w/data-h）', async () => {
    const seen: Array<{ key: string; bytes: number; widthPx: number | null; heightPx: number | null }> = [];
    const deps = stubSvgRasterizer({
      rasterizeSvg: async (items) => {
        for (const item of items) seen.push({ key: item.key, bytes: item.svg.length, widthPx: item.widthPx, heightPx: item.heightPx });
        const images = new Map<string, AssetEntry>();
        for (const item of items) images.set(item.key, { kind: 'image', data: PNG_1PX, type: 'png', width: 22, height: 39 });
        return { images, failed: [] };
      },
    });
    await buildDocxBuffer(input(), deps);
    expect(seen).toHaveLength(1);
    expect(seen[0].key).toBe('data-assets/capture/symbol.svg');
    expect(seen[0].bytes).toBeGreaterThan(0);
    expect(seen[0].widthPx).toBe(22);
    expect(seen[0].heightPx).toBe(39);
  });

  it('无栅格器：显式记缺图 + 明确原因（不静默、不假装成功）', async () => {
    const result = await buildDocxBuffer(input(), { rasterize: noMath, assetsRoot });
    expect(result.images.missing).toHaveLength(1);
    expect(result.images.missing[0]).toContain('symbol.svg');
    expect(result.images.missing[0]).toContain('SVG');
    // 位图不受影响
    expect(result.images.embedded).toBe(1);
  });

  it('栅格失败：该图记缺图并如实入账，其余照常出卷', async () => {
    const deps = stubSvgRasterizer({
      rasterizeSvg: async () => ({ images: new Map(), failed: [{ key: 'data-assets/capture/symbol.svg', error: '渲染超时' }] }),
    });
    const result = await buildDocxBuffer(input(), deps);
    expect(result.buffer.length).toBeGreaterThan(0);
    expect(result.images.embedded).toBe(1);
    expect(result.images.missing[0]).toContain('渲染超时');
  });

  it('无资产根：SVG 记缺图并说明环境（不误报为格式不支持）', async () => {
    const result = await buildDocxBuffer(input(), { rasterize: noMath, assetsRoot: null, rasterizeSvg: stubSvgRasterizer().rasterizeSvg });
    expect(result.images.missing[0]).toContain('资产根');
  });
});

// 保护：公式路径不受本次改动影响（零回归）
describe('0035 修复批 F1：公式路径零回归', () => {
  it('span.math 仍走 KaTeX 栅格注入（与 SVG 栅格互不干扰）', async () => {
    const q = makeQuestion();
    q.content = '<div class="question">速度 <span class="math" data-tex="v=\\sqrt{2gh}"></span></div>';
    q.images = [];
    const calls: MathItem[][] = [];
    const result = await buildDocxBuffer(
      { paper: makePaper(), questions: [q], mode: 'student' },
      {
        rasterize: async (items) => {
          calls.push(items);
          const images = new Map();
          for (const item of items) images.set(item.key, { png: PNG_1PX, widthPx: 40, heightPx: 14, depthPx: 3 });
          return { images, failed: [] };
        },
        assetsRoot,
        rasterizeSvg: stubSvgRasterizer().rasterizeSvg,
      }
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(1);
    expect(result.math.total).toBe(1);
    expect(result.math.rasterized).toBe(1);
  });
});
