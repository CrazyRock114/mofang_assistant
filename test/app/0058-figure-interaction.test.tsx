// 0058 预览图交互升级：注入运行时几何 + 选中态跨重建 + 协议增量 + 同源护栏（jsdom + 布局打桩）。
// 依据 0058 任务书 §四（TDD 先 RED 后 GREEN）。
// 打桩口径（照 paginate-dom.test.ts 先例）：jsdom 无布局引擎 → getBoundingClientRect 按「内联样式 + 自然宽」
// 推导三盒宽（块 → 内容宽 × width%；figure → min(原像素宽, 60% 块宽) 或 style 覆盖；img → min(自然宽, figure 宽)
// 或 style 覆盖），clientWidth 用 defineProperty 打桩。断言一律落在 rect/样式/消息三面。
// @vitest-environment jsdom

import { describe, it, expect, afterEach } from 'vitest';
import { injectPreviewScript, type PreviewFrameContext } from '../../src/app/pages/preview-frame-script.js';
import { parsePreviewMessage } from '../../src/app/pages/preview-frame-protocol.js';

/** 内容宽（= figure-block 的父容器客户宽；widthPercent 的语义分母） */
const PARENT_W = 648;
/** 图中自然像素宽（情形 A：figure 内联固定宽 300；情形 B：无内联宽） */
const NATURAL_W = 300;

interface StubOpts { figureStyle?: string | null; imgStyle?: string | null; imgNatural?: number; assetId?: string }
const restores: Array<() => void> = [];

/**
 * 布局打桩：figure-block / figure / img 三盒宽按上表推导（其余元素 0 盒）。
 * 语义对标真实 CSS：`.figure-block{width:100%}` + 内联覆盖；`figure:not([style])` 命中 60% 档；
 * `.figure-block > figure > img{max-width:100%}`（figure 有 style 时 60% 档不再命中）。
 */
function stubLayout(opts: StubOpts = {}) {
  const imgNatural = opts.imgNatural ?? NATURAL_W;
  const px = (el: Element) => parseFloat((el as HTMLElement).style.width) || 0;
  const styleOf = (el: Element) => (el as HTMLElement).style;
  const widthOf = (el: Element): number => {
    if (el.classList.contains('question-content')) return PARENT_W;
    if (el.classList.contains('figure-block')) {
      const s = styleOf(el);
      return s.width.endsWith('%') ? (parseFloat(s.width) / 100) * PARENT_W : PARENT_W;
    }
    if (el.tagName === 'FIGURE') {
      const block = el.closest('.figure-block');
      const blockW = block ? widthOf(block) : PARENT_W;
      const s = styleOf(el);
      if (s.width.endsWith('%')) return (parseFloat(s.width) / 100) * blockW;      // 拖中：内层被拉满
      // 有 style（含 max-width:60% 的既有形态）→ 取 min(原像素宽, 60% 块宽)；无 style → 同 60% 档
      return Math.min(s.width.endsWith('px') ? px(el) : imgNatural, 0.6 * blockW);
    }
    if (el.tagName === 'IMG') {
      const fig = el.closest('figure');
      const figW = fig ? widthOf(fig) : (el.closest('.figure-block') ? widthOf(el.closest('.figure-block') as Element) : imgNatural);
      const s = styleOf(el);
      if (s.width.endsWith('%')) return (parseFloat(s.width) / 100) * figW;
      if (s.width.endsWith('px')) return Math.min(px(el), figW);
      return Math.min(imgNatural, figW);
    }
    return 0;
  };
  const rectOf = (el: Element): DOMRect => {
    const w = widthOf(el);
    const h = el.tagName === 'IMG' ? Math.round(w * 0.3) : w;
    return { width: w, height: h, top: 0, left: 0, right: w, bottom: h, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
  const origRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) { return rectOf(this); };
  restores.push(() => { Element.prototype.getBoundingClientRect = origRect; });
  const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) { return this.classList.contains('question-content') ? PARENT_W : 0; },
  });
  restores.push(() => {
    if (desc) Object.defineProperty(HTMLElement.prototype, 'clientWidth', desc);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
  });
}

/** 最小卷面：单题 + 单图块（figure 内联宽形态由 opts 决定） */
function fixture(opts: StubOpts = {}): string {
  const figStyle = opts.figureStyle === undefined ? 'width: 300px; max-width: 60%; break-inside: avoid;' : opts.figureStyle;
  const imgStyle = opts.imgStyle ?? null;
  const assetId = opts.assetId ?? 'capture/a.png';
  const figAttr = figStyle === null ? '' : ` style="${figStyle}"`;
  const imgAttr = imgStyle === null ? '' : ` style="${imgStyle}"`;
  return '<!DOCTYPE html><html><head><title>0058 运行时探针</title></head><body>' +
    '<div class="paper"><div class="paper-questions">' +
    '<div class="question-item"><div class="question-header"><span class="question-number">1.</span></div>' +
    '<div class="mf-question-body"><div class="question-content">' +
    `<div class="figure-block figure-block--center"><figure${figAttr}><img class="q-figure"${imgAttr} src="data-assets/${assetId}"></figure></div>` +
    '</div></div></div>' +
    '</div></div></body></html>';
}

interface RuntimeResult {
  posted: Array<Record<string, unknown>>;
  figBlock: HTMLElement;
  figure: HTMLElement;
  img: HTMLElement;
}
const hashRestores: Array<() => void> = [];

/** 注入并执行运行时（interactive 开、paginate 关），返回消息收集器与三个目标盒 */
function runRuntime(ctx: Partial<PreviewFrameContext> = {}, opts: StubOpts = {}): RuntimeResult {
  const html = fixture(opts);
  document.body.innerHTML = html.slice(html.indexOf('<body>') + '<body>'.length, html.indexOf('</body>'));
  const posted: Array<Record<string, unknown>> = [];
  const collector = (ev: MessageEvent) => {
    const data = ev.data as Record<string, unknown> | null;
    if (data && typeof data.t === 'string' && (data.t as string).startsWith('mf-')) posted.push(data);
  };
  window.addEventListener('message', collector);
  hashRestores.push(() => window.removeEventListener('message', collector));   // 逐例摘除（防跨例累积）
  stubLayout(opts);
  const injected = injectPreviewScript(html, {
    assetsRoot: null,
    pageWmm: 210,
    pageHmm: 297,
    questionIds: ['q1'],
    paginate: false,
    interactive: true,
    answerSpaces: {},
    textBlocks: {},
    selectedQuestionId: null,
    ...ctx,
  });
  const script = injected.slice(injected.indexOf('<script>') + '<script>'.length, injected.indexOf('</script>'));
  // eslint-disable-next-line no-new-func
  new Function(script)();
  const figBlock = document.querySelector('.figure-block') as HTMLElement;
  const figure = document.querySelector('.figure-block figure') as HTMLElement;
  const img = document.querySelector('.figure-block img') as HTMLElement;
  return { posted, figBlock, figure, img };
}

function clickEl(el: Element) {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}
function mouseDown(el: Element, clientX = 0) {
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX }));
}
function mouseMove(el: EventTarget, clientX: number) {
  el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, button: 0, clientX }));
}
function mouseUp(el: EventTarget, clientX: number) {
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX }));
}
/** jsdom 的 postMessage 异步投递 → 断言消息前先放行一个宏任务（几何断言可同步） */
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  while (restores.length > 0) restores.pop()!();
  while (hashRestores.length > 0) hashRestores.pop()!();
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-mf-sheets');
  document.documentElement.removeAttribute('data-mf-overflow');
});

// ==================== F1：缩放基准取图盒（分子与 clamp 挂图，分母语义基准不变） ====================

describe('0058 F1 缩放基准取图盒', () => {
  it('小图外拖 +120 布局 px：回发 pct ≈ (图宽+dx)/父宽，且块宽被写为该 pct', async () => {
    const r = runRuntime();
    const imgW0 = r.img.getBoundingClientRect().width;
    // 起手：块满栏（648）、图 300（图只有块的 46%）——旧实现 w0 取块宽 ⇒ 起手 pct 已 100 ⇒ 外拖零效果
    expect(r.figBlock.getBoundingClientRect().width).toBe(PARENT_W);
    expect(imgW0).toBe(NATURAL_W);

    clickEl(r.img);
    const handle = document.querySelector('.mf-selection-handle') as HTMLElement;
    expect(handle).not.toBeNull();
    mouseDown(handle, 400);
    mouseMove(document, 520);      // dx = +120
    mouseUp(document, 520);
    await flush();

    const resize = r.posted.filter((m) => m.t === 'mf-figure-resize');
    expect(resize).toHaveLength(1);
    const expected = ((NATURAL_W + 120) / PARENT_W) * 100;   // ≈ 64.81%
    expect(resize[0].widthPercent as number).toBeGreaterThan(expected - 0.5);
    expect(resize[0].widthPercent as number).toBeLessThan(expected + 0.5);
    // 拖中块宽 = 该 pct（拖中视觉与落库同构的前提）
    expect(parseFloat(r.figBlock.style.width)).toBeCloseTo(expected, 1);
    expect(r.figBlock.style.marginLeft).toBe('auto');
  });

  it('内拖 -100 布局 px：按图盒粒度收窄（不再按整块粒度跳变）', async () => {
    const r = runRuntime();
    clickEl(r.img);
    const handle = document.querySelector('.mf-selection-handle') as HTMLElement;
    mouseDown(handle, 400);
    mouseMove(document, 300);
    mouseUp(document, 300);
    await flush();
    const resize = r.posted.filter((m) => m.t === 'mf-figure-resize')[0];
    expect(resize.widthPercent as number).toBeCloseTo(((NATURAL_W - 100) / PARENT_W) * 100, 1);   // ≈ 30.86%
  });

  it('clamp 上界 100 保留（拖到远超版心仍回发 100）', async () => {
    const r = runRuntime();
    clickEl(r.img);
    const handle = document.querySelector('.mf-selection-handle') as HTMLElement;
    mouseDown(handle, 10);
    mouseMove(document, 5000);
    mouseUp(document, 5000);
    await flush();
    expect(r.posted.filter((m) => m.t === 'mf-figure-resize')[0].widthPercent).toBe(100);
  });

  it('情形 B（figure 无内联宽）：基准同样取图盒，且拖中内层拉满', async () => {
    const r = runRuntime({}, { figureStyle: null, imgStyle: null, imgNatural: 600 });
    const imgW0 = r.img.getBoundingClientRect().width;   // 无 style → 60% 档：min(600, 0.6×648=388.8)
    expect(imgW0).toBeCloseTo(388.8, 1);
    clickEl(r.img);
    const handle = document.querySelector('.mf-selection-handle') as HTMLElement;
    mouseDown(handle, 200);
    mouseMove(document, 260);
    mouseUp(document, 260);
    await flush();
    expect(r.posted.filter((m) => m.t === 'mf-figure-resize')[0].widthPercent as number)
      .toBeCloseTo(((388.8 + 60) / PARENT_W) * 100, 1);
    // 拖中：figure/img 内层被拉满（与引擎覆盖档形态同构）
    expect(r.figure.style.width).toBe('100%');
    expect(r.img.style.width).toBe('100%');
  });
});

// ==================== F2：按下不跳版（内层拉满挪到首次移动） ====================

describe('0058 F2 按下零 DOM 变更', () => {
  it('mousedown 未移动：img rect 与内联样式均未变（figure/img 都不得被拉满）', () => {
    const r = runRuntime();
    const before = r.img.getBoundingClientRect().width;
    const beforeFigStyle = r.figure.getAttribute('style');
    clickEl(r.img);
    const handle = document.querySelector('.mf-selection-handle') as HTMLElement;
    mouseDown(handle, 400);
    // 按下后、未移动：几何与样式都应原样（旧实现在此处就 stretchFigureInner → img 拉满 + 样式被改）
    expect(r.img.getBoundingClientRect().width).toBe(before);
    expect(r.figure.getAttribute('style')).toBe(beforeFigStyle);
    expect(r.img.getAttribute('style')).toBeNull();
    mouseUp(document, 400);
  });

  it('首次移动才拉满内层（与块宽写 pct 同帧）', () => {
    const r = runRuntime();
    clickEl(r.img);
    const handle = document.querySelector('.mf-selection-handle') as HTMLElement;
    mouseDown(handle, 400);
    expect(r.figure.style.width).toBe('300px');   // 未移动 → 原内联宽原样未动（未被拉满）
    mouseMove(document, 410);
    expect(r.figure.style.width).toBe('100%');   // 移动 → 拉满
    expect(r.img.style.width).toBe('100%');
    mouseUp(document, 410);
  });
});

// ==================== F3：选中态跨 srcdoc 重建保持 ====================

describe('0058 F3 选中态跨重建保持（CFG selectedFigure + 恢复路径）', () => {
  it('CFG 注入了 selectedFigure 字段（缺省 null，只增不改既有字段）', () => {
    const html = fixture();
    const injected = injectPreviewScript(html, {
      assetsRoot: null, pageWmm: 210, pageHmm: 297, questionIds: ['q1'], paginate: false, interactive: true,
      selectedFigure: { questionId: 'q1', assetId: 'capture/a.png' },
    });
    expect(injected).toContain('"selectedFigure"');
    expect(injected).toContain('capture/a.png');
    const injectedDefault = injectPreviewScript(html, {
      assetsRoot: null, pageWmm: 210, pageHmm: 297, questionIds: ['q1'], paginate: false, interactive: true,
    });
    expect(injectedDefault).toContain('"selectedFigure":null');
    // 既有字段零改（抽样锁：题序/交互开关/选中题仍在）
    expect(injectedDefault).toContain('"interactive":true');
    expect(injectedDefault).toContain('"selectedQuestionId":null');
  });

  it('以 selectedFigure 注入执行 → 重建后框/手柄/浮动条按 assetId 自动恢复且贴图四边', () => {
    const r = runRuntime({ selectedFigure: { questionId: 'q1', assetId: 'capture/a.png' } });
    const box = document.querySelector('.mf-selection-box') as HTMLElement;
    const toolbar = document.querySelector('.mf-figure-toolbar') as HTMLElement;
    expect(box).not.toBeNull();
    expect(toolbar).not.toBeNull();
    const imgRect = r.img.getBoundingClientRect();
    expect(parseFloat(box.style.width)).toBeCloseTo(imgRect.width, 1);
    expect(parseFloat(box.style.height)).toBeCloseTo(imgRect.height, 1);
  });

  it('恢复路径不回发 mf-figure-select（防自激回路：消息收集器为零）', () => {
    const r = runRuntime({ selectedFigure: { questionId: 'q1', assetId: 'capture/a.png' } });
    expect(r.posted.filter((m) => m.t === 'mf-figure-select')).toHaveLength(0);
  });

  it('CFG 里 assetId 不匹配（换卷/题内无此图）→ 静默跳过，不炸不选错图', () => {
    const r = runRuntime({ selectedFigure: { questionId: 'q1', assetId: 'capture/ghost.png' } });
    expect(document.querySelector('.mf-selection-box')).toBeNull();
    expect(r.posted.filter((m) => m.t === 'mf-figure-select')).toHaveLength(0);
  });

  it('点图回发 mf-figure-select（选中）；点空白回发双 null（取消）', async () => {
    // 每例用唯一 assetId：此前用例的运行时实例挂在同一 document 上、且消息异步投递，
    // 唯一 id 让「本实例的消息」可精确识别（不数总数、不靠时序）
    const UNIQUE = 'capture/select-probe.png';
    const r = runRuntime({}, { assetId: UNIQUE });
    clickEl(r.img);
    await flush();
    // 本用例实例的选中消息以 assetId 唯一标识（此前用例的运行时实例仍挂在 document 上，
    // 其 Esc/点空白处理会各自回发「清空」→ 故清空断言取尾部而不数总数）
    const mine = r.posted.filter((m) => m.t === 'mf-figure-select' && m.assetId === UNIQUE);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ questionId: 'q1' });
    // 点空白（非图块/非框体）→ 取消选中并入 CFG 清空（本用例实例是最后注册者 ⇒ 其消息在尾部）
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await flush();
    const all = r.posted.filter((m) => m.t === 'mf-figure-select');
    expect(all[all.length - 1]).toMatchObject({ questionId: null, assetId: null });
  });

  it('Esc 取消选中同样回发双 null', async () => {
    const UNIQUE = 'capture/esc-probe.png';
    const r = runRuntime({}, { assetId: UNIQUE });
    clickEl(r.img);
    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    await flush();
    const all = r.posted.filter((m) => m.t === 'mf-figure-select');
    expect(all[all.length - 1]).toMatchObject({ questionId: null, assetId: null });
    // 选中消息只此一条（assetId 唯一标识本实例）
    expect(r.posted.filter((m) => m.t === 'mf-figure-select' && m.assetId === UNIQUE)).toHaveLength(1);
  });
});

// ==================== 协议：mf-figure-select 只增收窄 ====================

describe('0058 parsePreviewMessage：mf-figure-select 白名单', () => {
  it('合法形态收窄（选中 + 双 null 取消）', () => {
    expect(parsePreviewMessage({ t: 'mf-figure-select', questionId: 'q1', assetId: 'capture/a.png' }))
      .toEqual({ t: 'mf-figure-select', questionId: 'q1', assetId: 'capture/a.png' });
    expect(parsePreviewMessage({ t: 'mf-figure-select', questionId: null, assetId: null }))
      .toEqual({ t: 'mf-figure-select', questionId: null, assetId: null });
  });

  it('非法形态一律拒收（缺字段/半 null/坏类型/多余字段不宽收）', () => {
    expect(parsePreviewMessage({ t: 'mf-figure-select' })).toBeNull();
    expect(parsePreviewMessage({ t: 'mf-figure-select', questionId: 'q1' })).toBeNull();
    expect(parsePreviewMessage({ t: 'mf-figure-select', assetId: 'a' })).toBeNull();
    expect(parsePreviewMessage({ t: 'mf-figure-select', questionId: 'q1', assetId: null })).toBeNull();
    expect(parsePreviewMessage({ t: 'mf-figure-select', questionId: null, assetId: 'a' })).toBeNull();
    expect(parsePreviewMessage({ t: 'mf-figure-select', questionId: 1, assetId: 'a' })).toBeNull();
    expect(parsePreviewMessage({ t: 'mf-figure-select', questionId: 'q1', assetId: { a: 1 } })).toBeNull();
  });

  it('既有 case 零改（图缩放/移动/移除抽样复跑）', () => {
    expect(parsePreviewMessage({ t: 'mf-figure-resize', questionId: 'q1', assetId: 'a', widthPercent: 42 }))
      .toEqual({ t: 'mf-figure-resize', questionId: 'q1', assetId: 'a', widthPercent: 42 });
    expect(parsePreviewMessage({ t: 'mf-figure-remove', questionId: 'q1', assetId: 'a' }))
      .toEqual({ t: 'mf-figure-remove', questionId: 'q1', assetId: 'a' });
    expect(parsePreviewMessage({ t: 'mf-figure-move', questionId: 'q1', assetId: 'a', beforeAssetId: null }))
      .toEqual({ t: 'mf-figure-move', questionId: 'q1', assetId: 'a', beforeAssetId: null });
  });
});

// ==================== 同源护栏（非 RED，锁 interactive 门不被挪出门外） ====================

describe('0058 同源护栏：interactive:false 不挂交互层', () => {
  function runInjectedGuard(interactive: boolean) {
    const html = fixture();
    document.body.innerHTML = html.slice(html.indexOf('<body>') + '<body>'.length, html.indexOf('</body>'));
    stubLayout();
    const injected = injectPreviewScript(html, {
      assetsRoot: null, pageWmm: 210, pageHmm: 297, questionIds: ['q1'], paginate: true, interactive,
    });
    const script = injected.slice(injected.indexOf('<script>') + '<script>'.length, injected.indexOf('</script>'));
    // eslint-disable-next-line no-new-func
    new Function(script)();
  }

  it('interactive:false → 框/手柄/浮动条/增强标记计数 0，且页化与图块仍在', () => {
    runInjectedGuard(false);
    expect(document.querySelectorAll('.mf-selection-box')).toHaveLength(0);
    expect(document.querySelectorAll('.mf-selection-handle')).toHaveLength(0);
    expect(document.querySelectorAll('.mf-figure-toolbar')).toHaveLength(0);
    expect(document.querySelectorAll('[data-mf-enhanced]')).toHaveLength(0);
    expect(document.querySelectorAll('.figure-block').length).toBeGreaterThan(0);
    expect(document.documentElement.getAttribute('data-mf-sheets')).not.toBeNull();
  });

  it('interactive:true（对照）→ 增强标记在（证明上门断言不是恒真）', () => {
    runInjectedGuard(true);
    expect(document.querySelectorAll('[data-mf-enhanced]').length).toBeGreaterThan(0);
    expect(document.documentElement.getAttribute('data-mf-sheets')).not.toBeNull();
  });
});
