// D1 P3: data-assets/ 渲染层解析 — 纯函数 + Node 入口（buildPaperHtml）断言
// 纯函数：src="data-assets/..." → file:///<资产根>/...；无资产根 → 可读占位

import { describe, it, expect } from 'vitest';
import type { Paper, Question } from '../../src/shared/contracts/bank-types.js';
import { rewriteDataAssetSrcs } from '../../src/docgen/render/buildPaperHtml.core.js';
import { buildPaperHtml } from '../../src/docgen/render/buildPaperHtml.js';

const IMG = '<figure class="diagram" data-align="center" data-w="300" data-h="200"><img src="data-assets/capture/zujuan/13q900002-1.png" alt="几何配图"></figure>';

function makeQuestion(content: string, extra: Partial<Question> = {}): Question {
  return {
    id: 'q-net-1',
    subject: '数学',
    sourceType: 'network',
    sourceDetail: { site: 'zujuan', questionId: '13q900002' },
    content,
    images: ['data-assets/capture/zujuan/13q900002-1.png'],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...extra,
  };
}

const PAPER: Paper = {
  id: 'p1',
  title: '网络题卷',
  config: {},
  createdAt: '2026-01-01T00:00:00Z',
  archived: false,
};

describe('rewriteDataAssetSrcs 纯函数', () => {
  it('Windows 资产根（反斜杠）→ file:/// 正斜杠绝对路径', () => {
    const out = rewriteDataAssetSrcs(IMG, 'C:\\Users\\t\\AppData\\Roaming\\mofang\\data\\assets');
    expect(out).toContain('src="file:///C:/Users/t/AppData/Roaming/mofang/data/assets/capture/zujuan/13q900002-1.png"');
    expect(out).not.toContain('data-assets/');
  });

  it('POSIX 资产根 → file:/// 绝对路径；尾斜杠归一', () => {
    const out = rewriteDataAssetSrcs(IMG, '/home/u/data/assets/');
    expect(out).toContain('src="file:///home/u/data/assets/capture/zujuan/13q900002-1.png"');
  });

  it('单引号 src 同样改写', () => {
    const out = rewriteDataAssetSrcs("<img src='data-assets/capture/jyeoo/t-1.jpg'>", '/r/data/assets');
    expect(out).toContain("src='file:///r/data/assets/capture/jyeoo/t-1.jpg'");
  });

  it('资产根缺失（浏览器 dev 回落）→ 可读占位，不再残留 data-assets src', () => {
    const out = rewriteDataAssetSrcs(IMG, null);
    expect(out).not.toContain('src="data-assets/');
    expect(out).toContain('class="asset-placeholder"');
    expect(out).toContain('capture/zujuan/13q900002-1.png');
  });

  it('非 data-assets 的 src（http/data-uri）不受影响', () => {
    const html = '<img src="https://img.xkw.com/a.png"><img src="data:image/png;base64,AAAA">';
    expect(rewriteDataAssetSrcs(html, '/r')).toBe(html);
  });
});

describe('buildPaperHtml（Node 入口）data-assets 改写', () => {
  it('options.assetsRoot 提供时：题目 content 的 data-assets src 改写为 file:///', async () => {
    const q = makeQuestion(`<div class="question"><p>如图。</p>${IMG}</div>`);
    const html = await buildPaperHtml(PAPER, [q], { mode: 'student', assetsRoot: '/root/data/assets' });
    expect(html).toContain('src="file:///root/data/assets/capture/zujuan/13q900002-1.png"');
    expect(html).not.toContain('src="data-assets/');
  });

  it('教师版 answer/analysis 内的 data-assets 同样改写', async () => {
    const q = makeQuestion('<div class="question"><p>题面</p></div>', {
      answer: '<p><img src="data-assets/capture/zujuan/13q900002-2.png"></p>',
      analysis: '<p><img src="data-assets/capture/zujuan/13q900002-3.png"></p>',
    });
    const html = await buildPaperHtml(PAPER, [q], { mode: 'teacher', assetsRoot: '/root/data/assets' });
    expect(html).toContain('src="file:///root/data/assets/capture/zujuan/13q900002-2.png"');
    expect(html).toContain('src="file:///root/data/assets/capture/zujuan/13q900002-3.png"');
  });

  it('assetsRoot 缺省且非 Electron 环境（vitest）→ 占位回落，不残留 data-assets src', async () => {
    const q = makeQuestion(`<div class="question"><p>如图。</p>${IMG}</div>`);
    const html = await buildPaperHtml(PAPER, [q], { mode: 'student' });
    expect(html).not.toContain('src="data-assets/');
    expect(html).toContain('class="asset-placeholder"');
  });
});
