// 0063 排版页外观重做（R-067 三合一：顶栏五操作位 / 左栏卡片化 / 预览浮动条主题化）。
// ① composing 五操作位序（返回试题篮→定稿→预览▾→导出▾→⋮）；② 菜单常挂载 hidden + 开合行为
// （CtlSection 先例：弹层 testid 恒在，docx-export-ui 直点零适配的前提）；③ basket/done 主 CTA 换位
//（D-077②⑥）；④ FRAME_CSS 主题化（无 #1971c2、var(--mf-accent、ctx.theme 注入、缺省暖纸 fallback，
// D-077⑤）；⑤ 左栏 CtlSection 卡片化（结构回归 + theme.css 新块文本断言，照 0060 测试范式）。
// DOM 侧照 compose-layout/basket-pages 测试范式（Mock in-memory + jsdom）。
// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { BankService, BankExtServices } from '../../src/shared/contracts/bank-types.js';
import { MockBankService } from '../../src/bank/mock/mock-bank.js';
import { createMockExtServices } from '../../src/bank/mock/mock-ext.js';
import { MockBankStore } from '../../src/bank/mock/mock-store.js';

import { ComposePage } from '../../src/app/pages/ComposePage.js';
import { injectPreviewScript } from '../../src/app/pages/preview-frame-script.js';
import type { ExtPageServices } from '../../src/app/pages/ExtUi.js';

// ---------------- 测试世界（Mock in-memory 单跑，注入 svc） ----------------

interface Ctx {
  bank: BankService;
  ext: BankExtServices;
  store: MockBankStore;
}

function createCtx(): Ctx {
  const store = new MockBankStore();
  return {
    bank: new MockBankService(store),
    ext: createMockExtServices(store),
    store,
  };
}

let ctx: Ctx;
let svc: ExtPageServices;

beforeEach(() => {
  ctx = createCtx();
  svc = { bank: ctx.bank, ext: ctx.ext };
});

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
  vi.restoreAllMocks();
  window.location.hash = '';
});

async function waitFor(assertion: () => void) {
  await vi.waitFor(assertion, { timeout: 3000, interval: 20 });
}

function clickBtn(selector: string) {
  const el = container.querySelector(selector);
  if (!el) throw new Error(`找不到元素: ${selector}`);
  flushSync(() => (el as HTMLButtonElement).click());
}

async function makeQuestion(stem: string): Promise<string> {
  const q = await ctx.bank.createQuestion({
    subject: '物理',
    sourceType: 'local',
    sourceDetail: { origin: 'test' },
    content: `<div class="question">${stem}</div>`,
    images: [],
  });
  return q.id;
}

async function makePaperAtStatus(
  title: string,
  status: 'basket' | 'composing' | 'done' | 'archived',
  questionIds: string[] = []
): Promise<string> {
  const paper = await ctx.ext.paper.createPaperEx(title);
  for (const qid of questionIds) await ctx.bank.addQuestion(paper.id, qid, 5);
  if (status !== 'basket') {
    await ctx.ext.paper.updatePaperStatus(paper.id, 'composing');
    if (status === 'done' || status === 'archived') {
      await ctx.ext.paper.snapshotPaperQuestions(paper.id);
      await ctx.ext.paper.updatePaperStatus(paper.id, 'done');
    }
    if (status === 'archived') await ctx.ext.paper.updatePaperStatus(paper.id, 'archived');
  }
  return paper.id;
}

async function mountCompose(paperId: string, readySelector: string) {
  render(<ComposePage paperId={paperId} svc={svc} />);
  await waitFor(() => {
    if (!container.querySelector(readySelector)) throw new Error('排版页未就绪');
  });
}

/** actions 直属操作位序：直属 button + 菜单壳直属触发 button（弹层内菜单项不计入） */
function actionSeq(): string[] {
  const actions = container.querySelector('[data-testid="compose-toolbar-actions"]') as HTMLElement;
  if (!actions) throw new Error('compose-toolbar-actions 不在');
  return [...actions.querySelectorAll(':scope > button, :scope > span > button')].map((b) =>
    b.getAttribute('data-testid')
  );
}

// ==================== ① composing 五操作位 ====================

describe('0063 ①：composing 态五操作位（D-077②）', () => {
  it('操作位序 = 返回试题篮 → 定稿 → 预览▾ → 导出▾ → ⋮（归档收进 ⋮）', async () => {
    const qid = await makeQuestion('0063 五操作位题');
    const paperId = await makePaperAtStatus('0063 排版中卷', 'composing', [qid]);
    await mountCompose(paperId, '[data-testid="compose-toolbar-actions"]');
    expect(actionSeq()).toEqual([
      'compose-back-basket-btn',
      'compose-finalize-btn',
      'compose-menu-preview-btn',
      'compose-menu-export-btn',
      'compose-menu-more-btn',
    ]);
    // 归档不再平铺在主行（收进 ⋮ 菜单弹层内）
    const actions = container.querySelector('[data-testid="compose-toolbar-actions"]') as HTMLElement;
    expect([...actions.querySelectorAll(':scope > button')].map((b) => b.getAttribute('data-testid')))
      .not.toContain('compose-archive-btn');
    expect(container.querySelector('[data-testid="compose-archive-btn"]')).not.toBeNull();
  });
});

// ==================== ② 菜单常挂载 hidden + 开合 ====================

describe('0063 ②：菜单常挂载 hidden（docx-export-ui 直点前提）', () => {
  it('未开时六个预览/导出 testid 在 DOM 且弹层 hidden；点触发钮可见；点项后关闭', async () => {
    const qid = await makeQuestion('0063 菜单题');
    const paperId = await makePaperAtStatus('0063 菜单卷', 'composing', [qid]);
    await mountCompose(paperId, '[data-testid="compose-toolbar-actions"]');

    // 常挂载：未开菜单时六个既有 testid 全在 DOM（jsdom 直点派发的前提）
    for (const testid of [
      'compose-preview-student-btn',
      'compose-preview-teacher-btn',
      'compose-export-student-btn',
      'compose-export-teacher-btn',
      'compose-export-docx-student-btn',
      'compose-export-docx-teacher-btn',
    ]) {
      expect(container.querySelector(`[data-testid="${testid}"]`)).not.toBeNull();
    }
    // 弹层恒在且 hidden
    const popOf = (id: string) =>
      container.querySelector(`[data-testid="compose-menu-${id}-pop"]`) as HTMLElement;
    for (const id of ['preview', 'export', 'more']) {
      expect(popOf(id)).not.toBeNull();
      expect(popOf(id).hidden).toBe(true);
    }

    // 点触发钮 → 可见；Escape → 关闭（项点击关闭走下方归档项：预览/导出项会启动真渲染管线，
    // jsdom 无 window.open，异步尾部 setMessage 落在卸载后成 unhandled rejection 噪音，故不用）
    clickBtn('[data-testid="compose-menu-preview-btn"]');
    expect(popOf('preview').hidden).toBe(false);
    flushSync(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(popOf('preview').hidden).toBe(true);

    // ⋮ 菜单：点归档项 → 关闭 + 归档确认弹层在（走既有确认流）
    clickBtn('[data-testid="compose-menu-more-btn"]');
    expect(popOf('more').hidden).toBe(false);
    clickBtn('[data-testid="compose-archive-btn"]');
    expect(popOf('more').hidden).toBe(true);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="compose-archive-confirm"]')) {
        throw new Error('归档确认弹层未出现');
      }
    });
  });

  it('Escape 关闭当前菜单；点外部关闭', async () => {
    const qid = await makeQuestion('0063 菜单关闭题');
    const paperId = await makePaperAtStatus('0063 菜单关闭卷', 'composing', [qid]);
    await mountCompose(paperId, '[data-testid="compose-toolbar-actions"]');
    const pop = () => container.querySelector('[data-testid="compose-menu-export-pop"]') as HTMLElement;

    clickBtn('[data-testid="compose-menu-export-btn"]');
    expect(pop().hidden).toBe(false);
    // Escape 关闭
    flushSync(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(pop().hidden).toBe(true);

    // 点外部关闭（触发 preview 后在工具条标题区派发 pointerdown）
    clickBtn('[data-testid="compose-menu-preview-btn"]');
    const previewPop = () => container.querySelector('[data-testid="compose-menu-preview-pop"]') as HTMLElement;
    expect(previewPop().hidden).toBe(false);
    flushSync(() => {
      document.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    expect(previewPop().hidden).toBe(true);
  });
});

// ==================== ③ basket / done 主 CTA 换位 ====================

describe('0063 ③：basket/done 态主 CTA 换位（D-077⑥）', () => {
  it('basket 态 = 进入排版（主 CTA）+ 预览▾ + 导出▾；无定稿/返回试题篮/⋮', async () => {
    const paperId = await makePaperAtStatus('0063 草稿卷', 'basket');
    await mountCompose(paperId, '[data-testid="compose-toolbar-actions"]');
    expect(actionSeq()).toEqual([
      'compose-start-btn',
      'compose-menu-preview-btn',
      'compose-menu-export-btn',
    ]);
    expect(container.querySelector('[data-testid="compose-finalize-btn"]')).toBeNull();
    expect(container.querySelector('[data-testid="compose-back-basket-btn"]')).toBeNull();
    expect(container.querySelector('[data-testid="compose-menu-more-btn"]')).toBeNull();
  });

  it('done 态 = 生成副本重新编辑 + 预览▾ + 导出▾；无定稿位无 ⋮', async () => {
    const qid = await makeQuestion('0063 已定稿题');
    const paperId = await makePaperAtStatus('0063 已定稿卷', 'done', [qid]);
    await mountCompose(paperId, '[data-testid="compose-toolbar-actions"]');
    expect(actionSeq()).toEqual([
      'compose-clone-btn',
      'compose-menu-preview-btn',
      'compose-menu-export-btn',
    ]);
    expect(container.querySelector('[data-testid="compose-finalize-btn"]')).toBeNull();
    expect(container.querySelector('[data-testid="compose-menu-more-btn"]')).toBeNull();
  });
});

// ==================== ④ FRAME_CSS 主题化（D-077⑤） ====================

describe('0063 ④：预览浮动条主题化（注入产物断言）', () => {
  const baseCtx = { assetsRoot: null, pageWmm: 210, pageHmm: 297, questionIds: [] as string[] };

  it('FRAME_CSS 不再含硬编码蓝 #1971c2，改走 var(--mf-accent 系', () => {
    const out = injectPreviewScript('<html><body><main></main></body></html>', { ...baseCtx });
    // 断言域=FRAME_CSS 段（注入产物最后一个 <style> 块）：runtime 打包文本内联样式自带 #1971c2
    //（禁区零改动），样式表硬编码蓝退役的判据落在 FRAME_CSS 自身
    const frameCss = out.slice(out.lastIndexOf('<style>'));
    expect(frameCss).not.toContain('#1971c2');
    expect(out).toContain('var(--mf-accent');
    // 软光环 + 实线选中框（虚线退役）
    expect(frameCss).toContain('var(--mf-accent-soft');
  });

  it('传 ctx.theme 时注入 :root 块含主题值', () => {
    const out = injectPreviewScript('<html><body></body></html>', {
      ...baseCtx,
      theme: {
        accent: '#112233',
        accentDeep: '#223344',
        accentSoft: '#334455',
        card: '#445566',
        lineStrong: '#556677',
        ink2: '#667788',
        ink3: '#778899',
        brick: '#889900',
      },
    });
    expect(out).toContain('--mf-accent:#112233');
    expect(out).toContain('--mf-accent-deep:#223344');
    expect(out).toContain('--mf-card:#445566');
    expect(out).toContain('--mf-brick:#889900');
  });

  it('缺省（导出/新窗路径不传）时暖纸 fallback 在场', () => {
    const out = injectPreviewScript('<html><body></body></html>', { ...baseCtx });
    expect(out).toContain('#E8734A');
  });
});

// ==================== ⑤ 左栏 CtlSection 卡片化 ====================

describe('0063 ⑤：左栏卡片化（结构回归 + theme.css 新块）', () => {
  const themeCss = readFileSync(join(__dirname, '../../src/app/theme.css'), 'utf-8');

  it('CtlSection 结构在场：fieldset.ctl-section 分区卡（DOM 回归）', async () => {
    const qid = await makeQuestion('0063 左栏题');
    const paperId = await makePaperAtStatus('0063 左栏卷', 'composing', [qid]);
    await mountCompose(paperId, '[data-testid="ctl-toggle-preset-section"]');
    const sections = container.querySelectorAll('fieldset.ctl-section');
    expect(sections.length).toBeGreaterThanOrEqual(9);
  });

  it('theme.css：.compose-toolbar 卡片块 + 菜单皮肤 + ctl-section 卡片化 + 竖条头在场', () => {
    // 顶栏卡片块（内联 flex 收编 + 卡片皮肤）
    expect(themeCss).toMatch(/\.compose-toolbar\s*\{[^}]*background:\s*var\(--card\)/);
    expect(themeCss).toMatch(/\.compose-toolbar\s*\{[^}]*border-radius:\s*12px/);
    // 菜单弹层皮肤（常挂载 hidden 的 display 守卫必须在）
    expect(themeCss).toMatch(/\.compose-menu-pop\s*\{[^}]*position:\s*absolute/);
    expect(themeCss).toMatch(/\.compose-menu-pop\[hidden\]\s*\{\s*display:\s*none;/);
    // 左栏 fieldset 归零 + 标准卡片
    expect(themeCss).toMatch(/\.ctl-section\s*\{[^}]*min-inline-size:\s*0/);
    expect(themeCss).toMatch(/\.ctl-section\s*\{[^}]*background:\s*var\(--card\)/);
    // 分区头主题色竖条
    expect(themeCss).toMatch(/\.ctl-section \.ctl-head::before\s*\{[^}]*background:\s*var\(--orange\)/);
  });

  it('theme.css：0060 内滚段退役——actions 不再有 overflow-x:auto（D-077③）', () => {
    expect(themeCss).not.toMatch(/\[data-testid="compose-toolbar-actions"\]\s*\{[^}]*overflow-x:\s*auto/);
    // 不折行配方保留（五操作位保险）
    expect(themeCss).toMatch(/\[data-testid="compose-toolbar-actions"\][^{]*\{[^}]*white-space:\s*nowrap/);
  });
});

// ==================== 返工轮（2026-09-24 用户目检五条） ====================

/** 预览 iframe 的 srcdoc 全文（注入产物断言用，同 compose-layout srcdocOf 范式） */
function srcdocHtml(): string {
  const frame = container.querySelector('[data-testid="compose-preview-iframe"]') as HTMLIFrameElement;
  if (!frame) throw new Error('预览 iframe 不在');
  return frame.getAttribute('srcdoc') ?? '';
}

describe('0063 返工轮：目检五条落地', () => {
  it('返工②：拖拽期不改列表序（只画指示线），dragEnd 一次性提交真实重排', async () => {
    const reorderSpy = vi.spyOn(ctx.bank, 'reorderQuestions');
    const qids: string[] = [];
    for (const stem of ['拖拽甲题', '拖拽乙题', '拖拽丙题']) qids.push(await makeQuestion(stem));
    const paperId = await makePaperAtStatus('0063 拖拽卷', 'composing', qids);
    await mountCompose(paperId, '[data-testid="compose-question-list"]');

    const rows = () => [...container.querySelectorAll('[data-testid="compose-question-list"] > li')];
    const orderText = () => rows().map((r) => r.textContent);

    // 拖拽甲题（index 0）悬到丙题（index 2）。
    // 注意：React 对 dragover（continuous 优先级）的 setState 不吃 flushSync 同步渲染——
    // dispatch 后等一个宏任务 tick 再断言（探针实证，2026-09-24）
    const before = orderText();
    flushSync(() => rows()[0].dispatchEvent(new Event('dragstart', { bubbles: true })));
    rows()[2].dispatchEvent(new Event('dragover', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 拖拽期：列表序**未变**（旧实现此处已实时重排=「带着后面题一起动」的根因）
    expect(orderText()).toEqual(before);
    expect(rows()[0].className).toContain('dragging');
    expect(rows()[2].className).toContain('drop-target');

    // dragEnd → 一次性提交：甲题移到丙题位（[乙,丙,甲]），reorder 调一次
    flushSync(() => rows()[0].dispatchEvent(new Event('dragend', { bubbles: true })));
    await waitFor(() => {
      if (reorderSpy.mock.calls.length === 0) throw new Error('reorderQuestions 未调用');
    });
    expect(reorderSpy.mock.calls[0][1]).toEqual([qids[1], qids[2], qids[0]]);
    await waitFor(() => {
      if (rows()[0].textContent?.includes('拖拽甲题')) throw new Error('UI 未反映新序');
    });
    expect(rows()[2].className).not.toContain('drop-target');
    expect(reorderSpy).toHaveBeenCalledTimes(1);
  });

  it('返工③：切主题（data-theme 变化）触发预览重建，新主题变量随构建注入', async () => {
    const themeValue = { v: '#111111' };
    const csStub = vi.spyOn(window, 'getComputedStyle').mockImplementation(() => ({
      getPropertyValue: (name: string) => (name === '--orange' ? themeValue.v : ''),
    }) as unknown as CSSStyleDeclaration);
    try {
      const qid = await makeQuestion('0063 主题重染题');
      const paperId = await makePaperAtStatus('0063 主题重染卷', 'composing', [qid]);
      await mountCompose(paperId, '[data-testid="compose-preview-iframe"]');
      await waitFor(() => {
        if (!srcdocHtml().includes('--mf-accent:#111111')) throw new Error('首建未注入主题 A');
      });

      // 切主题：改 data-theme（观察者触发 themeTick → 防抖重建），变量值同步换
      themeValue.v = '#222222';
      flushSync(() => {
        document.documentElement.setAttribute('data-theme', 'dark');
      });
      await waitFor(() => {
        if (!srcdocHtml().includes('--mf-accent:#222222')) throw new Error('切主题未重建/未注入主题 B');
      });
    } finally {
      csStub.mockRestore();
      document.documentElement.setAttribute('data-theme', 'warm');
    }
  });

  it('返工⑤：常驻「Word 为重排版式」说明行退役，两个 Word 菜单项带感叹号 + title 提示', async () => {
    const qid = await makeQuestion('0063 返工⑤题');
    const paperId = await makePaperAtStatus('0063 返工⑤卷', 'composing', [qid]);
    await mountCompose(paperId, '[data-testid="compose-toolbar-actions"]');

    expect(container.querySelector('[data-testid="docx-reflow-notice"]')).toBeNull();
    for (const testid of ['compose-export-docx-student-btn', 'compose-export-docx-teacher-btn']) {
      const btn = container.querySelector(`[data-testid="${testid}"]`) as HTMLElement;
      expect(btn).not.toBeNull();
      expect(btn.getAttribute('title')).toContain('Word 为重排版式');
      expect(btn.querySelector('.compose-menu-item-warn')).not.toBeNull();
    }
    // PDF 项不带感叹号（提示只属 Word 出口）
    const pdfBtn = container.querySelector('[data-testid="compose-export-student-btn"]') as HTMLElement;
    expect(pdfBtn.getAttribute('title')).toBeNull();
    expect(pdfBtn.querySelector('.compose-menu-item-warn')).toBeNull();
  });

  it('返工④：图版式选项文案语义化——「单独成行（插在文中）/图文并排（文左图右）」在场', async () => {
    const qid = await makeQuestion('0063 返工④题');
    const paperId = await makePaperAtStatus('0063 返工④卷', 'composing', [qid]);
    await mountCompose(paperId, '[data-testid="layout-figure-mode"]');
    const select = container.querySelector('[data-testid="layout-figure-mode"]') as HTMLSelectElement;
    const texts = [...select.querySelectorAll('option')].map((o) => o.textContent);
    expect(texts).toContain('单独成行（插在文中）');
    expect(texts).toContain('图文并排（文左图右）');
    expect(texts).not.toContain('随文流');
  });
});

// ==================== 返工轮三（2026-09-24 用户授权 runtime 改动） ====================

/** 最小图选中夹具（照 0058 runRuntime 范式）：图块预标 mf data 属性 → 注入执行 runtime → 返回图浮动条。
 *  blockInSide=图块置于 .question-side（右栏态）；否则文流态（成行）。 */
function runFigureToolbar(blockInSide: boolean): HTMLElement {
  const assetId = 'capture/a.png';
  const figBlock = `<div class="figure-block figure-block--center" data-mf-question-id="q1" data-mf-asset-id="${assetId}"><figure style="width: 300px; max-width: 60%;"><img src="data-assets/${assetId}"></figure></div>`;
  const bodyInner = blockInSide
    ? `<div class="question-row"><div class="question-content"><p>题干文字</p></div><div class="question-side">${figBlock}</div></div>`
    : `<div class="question-content">${figBlock}</div>`;
  const html = `<!DOCTYPE html><html><head><title>0063</title></head><body><div class="paper"><div class="paper-questions"><div class="question-item"><div class="mf-question-body">${bodyInner}</div></div></div></div></body></html>`;
  document.body.innerHTML = html.slice(html.indexOf('<body>') + '<body>'.length, html.indexOf('</body>'));
  const injected = injectPreviewScript(html, {
    assetsRoot: null, pageWmm: 210, pageHmm: 297, questionIds: ['q1'],
    paginate: false, interactive: true, answerSpaces: {}, textBlocks: {},
    selectedFigure: { questionId: 'q1', assetId },
  });
  const script = injected.slice(injected.indexOf('<script>') + '<script>'.length, injected.indexOf('</script>'));
  // eslint-disable-next-line no-new-func
  new Function(script)();
  const bar = document.querySelector('.mf-figure-toolbar') as HTMLElement;
  expect(bar).not.toBeNull();
  return bar;
}

describe('0063 返工轮三：图浮动条「成行」改名 + 当前版式态高亮（授权 runtime 改动）', () => {
  const byText = (bar: HTMLElement, t: string) =>
    [...bar.querySelectorAll('button')].find((b) => b.textContent === t) as HTMLElement;

  it('文流图：「成行」钮高亮当前版式、右栏钮不高亮；「随文」文案退役', () => {
    const bar = runFigureToolbar(false);
    expect(byText(bar, '随文')).toBeUndefined();
    expect(byText(bar, '成行').classList.contains('mf-toolbar-active')).toBe(true);
    expect(byText(bar, '右栏').classList.contains('mf-toolbar-active')).toBe(false);
  });

  it('右栏图：右栏钮高亮、成行钮不高亮；高亮皮肤规则随注入在场', () => {
    const bar = runFigureToolbar(true);
    expect(byText(bar, '右栏').classList.contains('mf-toolbar-active')).toBe(true);
    expect(byText(bar, '成行').classList.contains('mf-toolbar-active')).toBe(false);
    const out = injectPreviewScript('<html><body></body></html>', { assetsRoot: null, pageWmm: 210, pageHmm: 297, questionIds: [] });
    expect(out).toContain('.mf-figure-toolbar > button.mf-toolbar-active');
  });
});
