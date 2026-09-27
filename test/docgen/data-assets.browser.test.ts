// D1 P3: data-assets/ 渲染层解析 — renderer 入口（buildPaperHtml.browser）断言
// 消费点 A：renderer 组卷预览/导出共用入口按 __mofangPaths.userDataAssets 改写
// @vitest-environment jsdom

import { describe, it, expect, afterEach } from 'vitest';
import type { Paper, Question } from '../../src/shared/contracts/bank-types.js';
import { buildPaperHtml } from '../../src/docgen/render/buildPaperHtml.browser.js';

const IMG = '<img src="data-assets/capture/zujuan/13q900002-1.png" alt="几何配图">';

const PAPER: Paper = {
  id: 'p1',
  title: '网络题卷',
  config: {},
  createdAt: '2026-01-01T00:00:00Z',
  archived: false,
};

const QUESTION: Question = {
  id: 'q-net-1',
  subject: '数学',
  sourceType: 'network',
  sourceDetail: { site: 'zujuan', questionId: '13q900002' },
  content: `<div class="question"><p>如图。</p><figure class="diagram" data-align="center" data-w="300" data-h="200">${IMG}</figure></div>`,
  images: ['data-assets/capture/zujuan/13q900002-1.png'],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

afterEach(() => {
  delete window.__mofangPaths;
});

describe('buildPaperHtml.browser（renderer 入口）data-assets 改写', () => {
  it('__mofangPaths.userDataAssets 存在 → src 改写为 file:/// 绝对路径', async () => {
    window.__mofangPaths = { userDataAssets: 'C:\\ud\\data\\assets' };
    const html = await buildPaperHtml(PAPER, [QUESTION], { mode: 'student' });
    expect(html).toContain('src="file:///C:/ud/data/assets/capture/zujuan/13q900002-1.png"');
    expect(html).not.toContain('src="data-assets/');
  });

  it('__mofangPaths 缺失（浏览器 dev）→ 占位回落，不残留 data-assets src', async () => {
    delete window.__mofangPaths;
    const html = await buildPaperHtml(PAPER, [QUESTION], { mode: 'student' });
    expect(html).not.toContain('src="data-assets/');
    expect(html).toContain('class="asset-placeholder"');
  });
});
