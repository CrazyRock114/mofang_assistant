// 0056 图片准备层：靶资产 → **模型可读、且看得清**的 data。
//
// 版本脉络（每条都是真机实证换来的）：
//   ①2026-09-23 真机 400 `code 20015 image_url provided is not a valid image.`：公式图是 SVG，
//     视觉端点不收 `image/svg+xml` → 必须栅格化；位图按**嗅探真身**定 mime（不信扩展名）。
//   ③施工参考 §2.2：DeepSeek-OCR 硬门槛最短边 >28px（线上口径 ≥56px）→ 小位图先放大。
//   ⑤用户假设：字形紧贴声明框 → 送模型前加白边。
//   ⑥2026-09-24 真机探针（scripts/probe-0056-volleyball.mjs）：⑤ 的实现在真机上有三个硬伤——
//     · 留白只扩画布、内容仍按声明尺寸画（13×28 就是 13×28px）＝ 把公式缩小后丢进大白框；
//     · 栅格器 `capturePage(rect)` 依赖窗口可见区 → 页尾行截空（答案图整张失败＝用户看到的「未转写」）、
//       跨下沿的行截回灰底半张（`9d/20` 只剩分子 → 模型必然读错）；
//     · 下发尺寸被系统显示缩放再乘一遍（76×96 CSS 在 1.5× 机器上出图 351×206 或 441 不定长）。
//   ⇒ 本版：尺寸全按**最终像素**算（`planCanvasBox`），渲染走 canvas（注入面 `renderCanvas`）。
//
// 环境：node（electron 全 mock——真实 canvas 栅格走真机探针 scripts/probe-0056-volleyball.mjs）。

import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: class {},
  app: { whenReady: () => Promise.resolve() },
  // 非 Electron 环境（单测）：默认位图量尺退化为 null → 走原样过桥并记账；本文件用替身注入
  nativeImage: undefined,
}));

import { sniffImageType } from '../../src/recog/ai-clean/image-format.js';
import {
  AI_CLEAN_CONTENT_LONG_EDGE_PX,
  AI_CLEAN_MAX_LONG_EDGE_PX,
  AI_CLEAN_PAD_MAX_CONTENT_PX,
  createAiCleanImagePreparer,
  planCanvasBox,
  svgContentSize,
} from '../../src/shell/ai-clean-image-prep.js';
import type { AiCleanImageRequest } from '../../src/shell/ai-clean-image-prep.js';
import type { AiCleanCanvasItem } from '../../src/shell/ai-clean-canvas-raster.js';

/** 1×1 PNG（真字节） */
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const GIF = Buffer.from('GIF89a' + 'x'.repeat(20), 'binary');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="13" height="28"><path d="M0 0"/></svg>', 'utf8');
const HTML = Buffer.from('<!DOCTYPE html><html><head><title>WAF</title></head><body>blocked</body></html>', 'utf8');
const OUT_PNG = Buffer.concat([PNG_1x1, Buffer.from('pad')]);

describe('0056 返工①：字节嗅探（不看扩展名，看真身）', () => {
  it('png / jpeg / gif / webp / svg 各自识别', () => {
    expect(sniffImageType(PNG_1x1)).toBe('png');
    expect(sniffImageType(JPEG)).toBe('jpeg');
    expect(sniffImageType(GIF)).toBe('gif');
    expect(sniffImageType(WEBP)).toBe('webp');
    expect(sniffImageType(SVG)).toBe('svg');
  });

  it('HTML/WAF 页与空字节 → unknown（不冒充图片）', () => {
    expect(sniffImageType(HTML)).toBe('unknown');
    expect(sniffImageType(Buffer.alloc(0))).toBe('unknown');
    expect(sniffImageType(Buffer.from([0x00, 0x01, 0x02, 0x03]))).toBe('unknown');
  });

  it('前导 BOM/空白的 SVG 也算 svg（站点产物带声明）', () => {
    expect(sniffImageType(Buffer.from('<?xml version="1.0"?>\n<svg width="10" height="10"></svg>', 'utf8'))).toBe('svg');
  });
});

describe('0056 返工⑥：下发方案 planCanvasBox（尺寸全按最终像素）', () => {
  it('小公式图（13×28）→ 内容长边放大到 300px + 18% 留白（先前是 13×28 原尺寸）', () => {
    const plan = planCanvasBox({ width: 13, height: 28 }, { label: '公式图' });
    expect(plan.draw.width).toBe(139);
    expect(plan.draw.height).toBe(AI_CLEAN_CONTENT_LONG_EDGE_PX);
    expect(plan.pad).toBe(54);                       // round(300*0.18)
    expect(plan.width).toBe(139 + 108);
    expect(plan.height).toBe(300 + 108);
    expect(plan.scale).toBeCloseTo(300 / 28, 2);
    expect(plan.note).toContain('留白');
  });

  it('内容长边 > 阈值的大图不加留白（自带留白；加边=白增体积）', () => {
    const plan = planCanvasBox({ width: 600, height: 200 });
    expect(plan.pad).toBe(0);
    expect(plan.scale).toBe(1);
    expect(plan.width).toBe(600);
  });

  it('超上限（长边 >1800）→ 与留白同比例收敛到上限', () => {
    const plan = planCanvasBox({ width: 3000, height: 2000 });
    expect(Math.max(plan.width, plan.height)).toBeLessThanOrEqual(AI_CLEAN_MAX_LONG_EDGE_PX);
    expect(plan.scale).toBeCloseTo(0.6, 1);
    expect(plan.pad).toBe(0);
  });

  it('留白阈值边界：≤400 加，>400 不加', () => {
    expect(planCanvasBox({ width: 400, height: 100 }).pad).toBeGreaterThan(0);
    expect(planCanvasBox({ width: AI_CLEAN_PAD_MAX_CONTENT_PX + 1, height: 100 }).pad).toBe(0);
  });

  it('位图放大倍数封顶（maxUpscale）：5×2 这种极端细长不拉成怪物尺寸', () => {
    const plan = planCanvasBox({ width: 5, height: 2 }, { maxUpscale: 6, label: '位图' });
    expect(plan.draw.width).toBe(30);
    expect(plan.draw.height).toBe(12);
    expect(plan.pad).toBe(18);                        // 夹取下限
    expect(plan.note).toContain('位图');
  });
});

describe('0056 返工⑥：SVG 内在尺寸兜底', () => {
  it('站点产物缺失尺寸时退回版式声明尺寸，再退 300×150', () => {
    expect(svgContentSize('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>', { width: 40, height: 20 }))
      .toEqual({ width: 40, height: 20 });
    expect(svgContentSize('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>'))
      .toEqual({ width: 300, height: 150 });
    expect(svgContentSize('<svg xmlns="http://www.w3.org/2000/svg" width="13" height="28"/>'))
      .toEqual({ width: 13, height: 28 });
  });
});

function requestOf(key: string, assetRelPath: string, bytes: Buffer, mime: string, width = 0, height = 0): AiCleanImageRequest {
  return { key, assetRelPath, bytes, mime, width, height };
}

/** canvas 栅格器替身：记录入批项，回一张固定 PNG */
function makePreparer(
  sizeOf: (bytes: Buffer) => { width: number; height: number } | null = () => ({ width: 100, height: 80 }),
  canvasOutcome?: { fail?: boolean },
) {
  const calls: Array<AiCleanCanvasItem[]> = [];
  const preparer = createAiCleanImagePreparer({
    renderCanvas: async (items) => {
      calls.push(items.map((item) => ({ ...item, draw: { ...item.draw }, source: { ...item.source } })));
      if (canvasOutcome?.fail) {
        return { images: new Map(), failed: items.map((item) => ({ key: item.key, error: '画布炸了（假）' })) };
      }
      return { images: new Map(items.map((item) => [item.key, OUT_PNG])), failed: [] };
    },
    measureRaster: { sizeOf },
  });
  return { preparer, calls };
}

describe('0056 返工⑥：图片准备器', () => {
  it('SVG 靶 → 进 canvas 批（源是 SVG 原文，SVG 绝不出门）+ 回 PNG', async () => {
    const { preparer, calls } = makePreparer();
    const out = await preparer([requestOf('formula:capture/zujuan/f1.svg', 'capture/zujuan/f1.svg', SVG, 'image/svg+xml', 13, 28)]);
    const ready = out.get('formula:capture/zujuan/f1.svg');
    expect(ready).toBeTruthy();
    expect('error' in ready!).toBe(false);
    expect((ready as { mime: string }).mime).toBe('image/png');
    expect(Buffer.from((ready as { dataBase64: string }).dataBase64, 'base64').equals(OUT_PNG)).toBe(true);
    expect(calls).toHaveLength(1);
    const item = calls[0]![0]!;
    expect(item.source.mime).toBe('image/svg+xml');
    expect(Buffer.from(item.source.base64, 'base64').equals(SVG)).toBe(true);
    // 尺寸：13×28 → 内容 139×300 + 留白 54 → 画布 247×408
    expect(item.width).toBe(247);
    expect(item.height).toBe(408);
    expect(item.draw).toEqual({ x: 54, y: 54, width: 139, height: 300 });
  });

  it('小位图 → 放大 + 留白进 canvas；源 mime 用**嗅探真身**（扩展名骗人时按真身发）', async () => {
    const { preparer, calls } = makePreparer(() => ({ width: 19, height: 16 }));
    await preparer([requestOf('formula:capture/jyeoo/a.png', 'capture/jyeoo/a.png', JPEG, 'image/png')]);
    const item = calls[0]![0]!;
    expect(item.source.mime).toBe('image/jpeg');       // 真身是 JPEG
    expect(item.draw.width).toBeGreaterThan(19);       // 已放大
    expect(item.draw.width).toBe(114);                 // 19×16 → ×6（封顶）
    expect(item.draw.height).toBe(96);
  });

  it('大位图（1768×968）→ **原样过桥**：字节逐字节一致、mime 嗅探真身、零重编码', async () => {
    const { preparer, calls } = makePreparer(() => ({ width: 1768, height: 968 }));
    const out = await preparer([requestOf('answer:capture/zujuan/a.jpg', 'capture/zujuan/a.jpg', JPEG, 'image/jpeg')]);
    const ready = out.get('answer:capture/zujuan/a.jpg') as { dataBase64: string; mime: string; note?: string };
    expect(Buffer.from(ready.dataBase64, 'base64').equals(JPEG)).toBe(true);
    expect(ready.mime).toBe('image/jpeg');
    expect(ready.note).toContain('原样过桥');
    expect(calls).toHaveLength(0);                     // 不进 canvas：不重编码
  });

  it('超长位图（>1800）→ 收敛进 canvas，长边不超上限', async () => {
    const { preparer, calls } = makePreparer(() => ({ width: 3000, height: 2000 }));
    await preparer([requestOf('answer:capture/zujuan/big.jpg', 'capture/zujuan/big.jpg', JPEG, 'image/jpeg')]);
    const item = calls[0]![0]!;
    expect(Math.max(item.width, item.height)).toBeLessThanOrEqual(AI_CLEAN_MAX_LONG_EDGE_PX);
    expect(item.draw.x).toBe(0);                       // 大图不留白
  });

  it('取不到位图尺寸（环境无 nativeImage）→ 原样过桥并记账（不静默丢图）', async () => {
    const preparer = createAiCleanImagePreparer({ renderCanvas: async () => ({ images: new Map(), failed: [] }), measureRaster: null });
    const out = await preparer([requestOf('formula:x/a.png', 'x/a.png', PNG_1x1, 'image/png')]);
    const ready = out.get('formula:x/a.png') as { dataBase64: string; mime: string; note?: string };
    expect(Buffer.from(ready.dataBase64, 'base64').equals(PNG_1x1)).toBe(true);
    expect(ready.note).toContain('原样送出');
  });

  it('同批混合：全部靶一次批量交给 canvas（一次开窗/一次调用，不逐图开）', async () => {
    const { preparer, calls } = makePreparer(() => ({ width: 19, height: 16 }));
    await preparer([
      requestOf('formula:x/f1.svg', 'x/f1.svg', SVG, 'image/svg+xml'),
      requestOf('formula:x/f2.svg', 'x/f2.svg', SVG, 'image/svg+xml'),
      requestOf('formula:x/f3.png', 'x/f3.png', PNG_1x1, 'image/png'),
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.map((item) => item.key)).toEqual(['formula:x/f1.svg', 'formula:x/f2.svg', 'formula:x/f3.png']);
  });

  it('栅格失败 → 该靶 error（不静默、不把 SVG 原样发出去）', async () => {
    const { preparer } = makePreparer(undefined, { fail: true });
    const out = await preparer([requestOf('formula:x/f1.svg', 'x/f1.svg', SVG, 'image/svg+xml')]);
    expect(out.get('formula:x/f1.svg')).toEqual({ error: expect.stringContaining('栅格化失败') });
  });

  it('非图片字节（WAF/HTML 页）→ error（明确记账，不冒充图片）', async () => {
    const { preparer } = makePreparer();
    const out = await preparer([requestOf('formula:x/waf.png', 'x/waf.png', HTML, 'image/png')]);
    expect(out.get('formula:x/waf.png')).toEqual({ error: expect.stringContaining('不是图片') });
  });

  it('留白/放大说明进 note（人可追因）：公式图带「留白」、小位图带放大倍数', async () => {
    const { preparer } = makePreparer(() => ({ width: 19, height: 16 }));
    const out = await preparer([
      requestOf('formula:x/f1.svg', 'x/f1.svg', SVG, 'image/svg+xml'),
      requestOf('formula:x/f2.png', 'x/f2.png', PNG_1x1, 'image/png'),
    ]);
    expect((out.get('formula:x/f1.svg') as { note?: string }).note).toContain('留白');
    expect((out.get('formula:x/f2.png') as { note?: string }).note).toContain('位图');
  });
});
