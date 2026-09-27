// 0067（R-069 顺手项，§零.10）：图浮动条「对齐态高亮」——当前对齐直读块 class `figure-block--{align}`，
// 复用 0063 落地的 `mf-toolbar-active` 机制（预览协议零扩展：preview-frame-protocol.ts 零改动）。
// 夹具照 0063-compose-v2 的 runFigureToolbar 范式（注入 runtime → new Function 执行 → 取浮动条）。
// @vitest-environment jsdom

import { describe, it, expect } from 'vitest';

import { injectPreviewScript } from '../../src/app/pages/preview-frame-script.js';

const ASSET_ID = 'capture/a.png';

/** 注入 runtime 并触发图选中 → 返回图浮动条（align 决定块 class，即运行时读到的当前对齐） */
function runFigureToolbar(align: 'left' | 'center' | 'right'): HTMLElement {
  const figBlock = `<div class="figure-block figure-block--${align}" data-mf-question-id="q1" data-mf-asset-id="${ASSET_ID}"><figure style="width: 300px; max-width: 60%;"><img src="data-assets/${ASSET_ID}"></figure></div>`;
  const html = `<!DOCTYPE html><html><head><title>0067</title></head><body><div class="paper"><div class="paper-questions"><div class="question-item"><div class="mf-question-body"><div class="question-content">${figBlock}</div></div></div></div></div></body></html>`;
  document.body.innerHTML = html.slice(html.indexOf('<body>') + '<body>'.length, html.indexOf('</body>'));
  const injected = injectPreviewScript(html, {
    assetsRoot: null, pageWmm: 210, pageHmm: 297, questionIds: ['q1'],
    paginate: false, interactive: true, answerSpaces: {}, textBlocks: {},
    selectedFigure: { questionId: 'q1', assetId: ASSET_ID },
  });
  const script = injected.slice(injected.indexOf('<script>') + '<script>'.length, injected.indexOf('</script>'));
  // eslint-disable-next-line no-new-func
  new Function(script)();
  const bar = document.querySelector('.mf-figure-toolbar') as HTMLElement;
  expect(bar).not.toBeNull();
  return bar;
}

const byText = (bar: HTMLElement, t: string) =>
  [...bar.querySelectorAll('button')].find((b) => b.textContent === t) as HTMLElement;

const activeOf = (bar: HTMLElement, t: string) => byText(bar, t).classList.contains('mf-toolbar-active');

describe('0067 R-069 图浮动条对齐态高亮（三态各高亮对应按钮、其余不高亮）', () => {
  for (const align of ['left', 'center', 'right'] as const) {
    const label = { left: '左', center: '中', right: '右' }[align];
    it(`块 class=figure-block--${align} → 「${label}」钮高亮，另两钮不高亮`, () => {
      const bar = runFigureToolbar(align);
      for (const t of ['左', '中', '右']) {
        expect(activeOf(bar, t)).toBe(t === label);
      }
    });
  }

  it('对齐钮与版式钮高亮互不串位（文流态下「成行」同时高亮，右栏不高亮）', () => {
    const bar = runFigureToolbar('right');
    expect(activeOf(bar, '右')).toBe(true);
    expect(activeOf(bar, '成行')).toBe(true);
    expect(activeOf(bar, '右栏')).toBe(false);
  });

  it('高亮皮肤规则随注入在场（mf-toolbar-active，三态共用）', () => {
    const out = injectPreviewScript('<html><body></body></html>', {
      assetsRoot: null, pageWmm: 210, pageHmm: 297, questionIds: [],
    });
    expect(out).toContain('.mf-figure-toolbar > button.mf-toolbar-active');
  });
});
