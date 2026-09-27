// 0057 P5：录题图资产化——显示形态 ⇄ 存储形态双侧归一、content 资产引用 → QuestionImage、落资产封装。
//
// 环境：node（无 DOM）。asset-src 的显示形态归一按 assetsRoot 显式取值，故不需要 jsdom；
// 「无桥」降级路径在 node 下天然成立（`typeof window === 'undefined'` → recogImageBridge() = null）。

import { describe, it, expect, vi } from 'vitest';
import {
  DATA_ASSETS_PREFIX, contentAssetRefs, displaySrcOf, fileUrlRootOf, normalizeHtmlAssets,
  persistImageSrc, persistImageSrcs, questionImagesFromHtml, toDisplayHtml, toStoredHtml,
  type RecogImageBridgeLike,
} from '../../src/app/workbench/asset-src.js';

const ROOT_WIN = 'C:\\Users\\u\\AppData\\Roaming\\mofang-assistant\\data\\assets';
const ROOT_WIN_URL = 'file:///C:/Users/u/AppData/Roaming/mofang-assistant/data/assets';
const ROOT_POSIX = '/home/u/.config/mofang-assistant/data/assets';
const ROOT_POSIX_URL = 'file:///home/u/.config/mofang-assistant/data/assets';

const PNG_A = 'data:image/png;base64,QUJD';
const PNG_B = 'data:image/png;base64,REVG';

/** 假桥（只记账、不写盘） */
function fakeBridge(relPathFor: (dataUrl: string) => string): RecogImageBridgeLike & { calls: Array<{ dataUrl: string; width?: number; height?: number }> } {
  const calls: Array<{ dataUrl: string; width?: number; height?: number }> = [];
  return {
    calls,
    saveRecogImage: async (payload) => {
      calls.push(payload);
      return { relPath: relPathFor(payload.dataUrl), width: payload.width, height: payload.height };
    },
  };
}

describe('0057 资产根 URL（与 buildPaperHtml.rewriteDataAssetSrcs 同口径）', () => {
  it('Windows 绝对路径 → file:///C:/…（反斜杠归一、尾斜杠剔除）', () => {
    expect(fileUrlRootOf(ROOT_WIN)).toBe(ROOT_WIN_URL);
    expect(fileUrlRootOf(`${ROOT_WIN}\\`)).toBe(ROOT_WIN_URL);
  });

  it('POSIX 绝对路径 → file:///home/…（file:// + 前导斜杠）', () => {
    expect(fileUrlRootOf(ROOT_POSIX)).toBe(ROOT_POSIX_URL);
  });
});

describe('0057 显示形态 ⇄ 存储形态双侧归一', () => {
  it('存储 → 显示：双引号与单引号两种 src 都改写成 file:// 绝对路径', () => {
    const stored = '<div class="question"><figure class="diagram" data-w="320"><img class="q-figure" src="data-assets/recog/a1.png"></figure>'
      + "<span class='inline-figure'><img src='data-assets/capture/zujuan/x-1.svg'></span></div>";
    const display = toDisplayHtml(stored, ROOT_WIN);
    expect(display).toContain(`src="${ROOT_WIN_URL}/recog/a1.png"`);
    expect(display).toContain(`src='${ROOT_WIN_URL}/capture/zujuan/x-1.svg'`);
    expect(display).not.toContain('data-assets/');
  });

  it('显示 → 存储：只改写落在资产根之下的引用，外链与内联 data URL 原样保留', () => {
    const display = `<img src="${ROOT_WIN_URL}/recog/a1.png"><img src="https://example.com/x.png"><img src="${PNG_A}">`;
    const stored = toStoredHtml(display, ROOT_WIN);
    expect(stored).toContain('src="data-assets/recog/a1.png"');
    expect(stored).toContain('src="https://example.com/x.png"');
    expect(stored).toContain(`src="${PNG_A}"`);
  });

  it('往返恒等：toStoredHtml(toDisplayHtml(x)) === x（编辑器回写后题卡 state 仍是相对引用）', () => {
    const stored = '<div class="question"><p>如图</p><figure class="diagram" data-w="320" data-h="200">'
      + '<img class="q-figure" src="data-assets/recog/aaa.png"></figure></div>';
    expect(toStoredHtml(toDisplayHtml(stored, ROOT_WIN), ROOT_WIN)).toBe(stored);
    expect(toStoredHtml(toDisplayHtml(stored, ROOT_POSIX), ROOT_POSIX)).toBe(stored);
  });

  it('根路径不匹配的 file:// 引用不改写（不经手别人的绝对路径）', () => {
    const html = '<img src="file:///D:/other/assets/recog/x.png">';
    expect(toStoredHtml(html, ROOT_WIN)).toBe(html);
  });

  it('无资产根（浏览器 demo / vitest）：两侧归一均为恒等，绝不产占位节点', () => {
    const stored = '<img src="data-assets/recog/a1.png">';
    expect(toDisplayHtml(stored, null)).toBe(stored);
    expect(toStoredHtml('<img src="file:///x/a1.png">', null)).toBe('<img src="file:///x/a1.png">');
  });

  it('displaySrcOf：单条存储引用 → 显示形态；非资产引用原样', () => {
    expect(displaySrcOf('data-assets/recog/a1.png', ROOT_WIN)).toBe(`${ROOT_WIN_URL}/recog/a1.png`);
    expect(displaySrcOf(PNG_A, ROOT_WIN)).toBe(PNG_A);
    expect(displaySrcOf('data-assets/recog/a1.png', null)).toBe('data-assets/recog/a1.png');
  });
});

describe('0057 content 资产引用 → questions.images', () => {
  it('按出现序去重取相对路径', () => {
    const html = '<img src="data-assets/recog/a1.png"><img src="data-assets/recog/a2.png"><img src="data-assets/recog/a1.png">';
    expect(contentAssetRefs(html)).toEqual(['recog/a1.png', 'recog/a2.png']);
  });

  it('assetId 写带 data-assets/ 前缀的完整引用串，type 恒 figure（与真机既有 196 道同形态）', () => {
    const html = '<figure class="diagram"><img class="q-figure" src="data-assets/recog/a1.png"></figure>';
    expect(questionImagesFromHtml(html)).toEqual([
      { assetId: 'data-assets/recog/a1.png', type: 'figure' },
    ]);
  });

  it('无资产引用（含内联图 / 空）→ 空数组（内联图不是资产，不计入）', () => {
    expect(questionImagesFromHtml(`<img src="${PNG_A}">`)).toEqual([]);
    expect(questionImagesFromHtml('<div class="question"><p>无图</p></div>')).toEqual([]);
  });
});

describe('0057 落资产封装（persistImageSrc / persistImageSrcs）', () => {
  it('有桥：dataUrl 落资产 → 存储形态 src（相对引用）', async () => {
    const bridge = fakeBridge(() => 'recog/sha32.png');
    const outcome = await persistImageSrc(PNG_A, { width: 320, height: 200 }, bridge);
    expect(outcome).toEqual({ ok: true, src: `${DATA_ASSETS_PREFIX}recog/sha32.png`, relPath: 'recog/sha32.png' });
    expect(bridge.calls).toEqual([{ dataUrl: PNG_A, width: 320, height: 200 }]);
  });

  it('无桥（浏览器 demo / 测试）→ 显式降级回落 dataUrl 并给原因（禁静默）', async () => {
    const outcome = await persistImageSrc(PNG_A, {}, null);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.src).toBe(PNG_A);
    expect(outcome.reason).toContain('无 file 桥');
  });

  it('非 data:image 形态 → 降级（不把外链塞给落盘面）', async () => {
    const outcome = await persistImageSrc('https://example.com/x.png', {}, fakeBridge(() => 'recog/x.png'));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.src).toBe('https://example.com/x.png');
    expect(outcome.reason).toContain('非 data:image');
  });

  it('桥抛错（形验/写盘失败）→ 降级并带上原错误信息', async () => {
    const bridge: RecogImageBridgeLike = {
      saveRecogImage: vi.fn(async () => { throw new Error('saveRecogImage：dataUrl 必须是 data:image/…'); }),
    };
    const outcome = await persistImageSrc(PNG_A, {}, bridge);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.src).toBe(PNG_A);
    expect(outcome.reason).toContain('dataUrl 必须是');
  });

  it('批量：成功项给存储形态、失败项回落原值并逐条记账', async () => {
    const bridge: RecogImageBridgeLike = {
      saveRecogImage: async (payload) => {
        if (payload.dataUrl === PNG_B) throw new Error('落盘失败：磁盘满');
        return { relPath: 'recog/ok.png' };
      },
    };
    const result = await persistImageSrcs([
      { key: 1, dataUrl: PNG_A, width: 320, height: 200 },
      { key: 2, dataUrl: PNG_B },
    ], bridge);
    expect(result.srcOf.get(1)).toBe('data-assets/recog/ok.png');
    expect(result.srcOf.get(2)).toBe(PNG_B);
    expect(result.degraded).toEqual([{ key: 2, reason: '落盘失败：磁盘满' }]);
  });
});

describe('0057 入库前兜底 normalizeHtmlAssets（禁区 6：新入库数据禁内联 data URL）', () => {
  it('残余内联图 → 就地资产化改写（编辑器自带上传/粘贴走的就是这条）', async () => {
    const bridge = fakeBridge((dataUrl) => (dataUrl === PNG_A ? 'recog/a.png' : 'recog/b.png'));
    const html = `<div class="question"><img src="${PNG_A}"><img src="${PNG_B}"></div>`;
    const result = await normalizeHtmlAssets(html, bridge);
    expect(result.persisted).toBe(2);
    expect(result.degraded).toEqual([]);
    expect(result.html).toBe('<div class="question"><img src="data-assets/recog/a.png"><img src="data-assets/recog/b.png"></div>');
    expect(result.html).not.toContain('data:image');
  });

  it('无内联图 → 零改写零写盘（正常路径的恒等返回）', async () => {
    const bridge = fakeBridge(() => 'recog/x.png');
    const html = '<div class="question"><img src="data-assets/recog/a.png"></div>';
    const result = await normalizeHtmlAssets(html, bridge);
    expect(result).toEqual({ html, persisted: 0, degraded: [] });
    expect(bridge.calls).toHaveLength(0);
  });

  it('落盘失败 → 原样保留并给原因（不静默、不产半截改写）', async () => {
    const result = await normalizeHtmlAssets(`<img src="${PNG_A}">`, null);
    expect(result.persisted).toBe(0);
    expect(result.html).toBe(`<img src="${PNG_A}">`);
    expect(result.degraded.length).toBe(1);
  });

  it('同图出现两次只落一次盘（内容寻址前的一次去重）', async () => {
    const bridge = fakeBridge(() => 'recog/same.png');
    const result = await normalizeHtmlAssets(`<img src="${PNG_A}"><img src="${PNG_A}">`, bridge);
    expect(bridge.calls).toHaveLength(1);
    expect(result.persisted).toBe(1);
    expect(result.html).toBe('<img src="data-assets/recog/same.png"><img src="data-assets/recog/same.png">');
  });
});
