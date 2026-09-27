// 0004-fix-4 2.1：分页注入脚本运行时探针（jsdom + 布局度量打桩）。
// jsdom 无布局引擎 → 用 getter 桩模拟「题块 300px / 页内容高 971px」，
// 真实跑一遍注入脚本（collectBlocks → 测量 → 装箱 → sheet 组装 → 二次校验），
// 断言：sheet 数 >1、块序完整、data-mf-sheets 与实际一致、差异标注在、无异常。
// 0004-fix-5 §二：卷面改为**固定 html fixture**（手写最小卷面）——不再依赖 buildPaperHtml(Node 入口)
// 的 node:fs 读 CSS 路径（该依赖在 jsdom 环境曾整例挂掉；本机基线虽 777/777，仍按任务书硬化）。
// @vitest-environment jsdom

import { describe, it, expect, afterEach } from 'vitest';
import { injectPreviewScript } from '../../src/app/pages/preview-frame-script.js';
import { buildHtmlDocument } from '../../src/docgen/render/buildPaperHtml.core.js';
import { resolveLayout } from '../../src/docgen/render/layout.js';
import type { Paper } from '../../src/shared/contracts/bank-types.js';

const QUESTION_PX = 300;
const HEADER_PX = 100;
const PAGE_W_MM = 210;
const PAGE_H_MM = 297;

/** 固定卷面 fixture（手写最小卷：抬头 + N 题；屏显页边距内联模拟引擎 @media screen 注入值） */
function fixtureHtml(count: number, padTB = 75.59, logo = false, itemCls = ''): string {
  const items = Array.from({ length: count }, (_, i) => (
    `<div class="question-item${itemCls}"><div class="question-header"><span class="question-number">${i + 1}.</span></div>` +
    `<div class="mf-question-body"><div class="question-content">第 ${i + 1} 题题干文字</div></div></div>`
  )).join('\n');
  const logoHtml = logo
    ? '<img class="paper-logo" src="data-assets/logos/pixel.png" style="left: 21mm; top: 14.85mm; width: 42mm;">'
    : '';
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>分页运行时探针卷</title></head><body>` +
    `<div class="paper" style="box-sizing: border-box; padding: ${padTB}px 56.69px;">` +
    `<div class="paper-header"><h1 class="paper-title">分页运行时探针卷</h1></div>` +
    `<div class="paper-questions">${items}</div>` +
    `<div class="paper-footer"><span class="pageNumber"></span> / <span class="totalPages"></span></div>` +
    logoHtml +
    `</div></body></html>`;
}

/** 0007 P1：题块外边距打桩（题 mt=10/mb=30；getComputedStyle 包装，其余委派 jsdom） */
function stubMargins() {
  const orig = window.getComputedStyle.bind(window);
  window.getComputedStyle = ((el: Element) => {
    const base = orig(el);
    if (el.classList.contains('question-item')) {
      return new Proxy(base, {
        get: (target, prop) => {
          if (prop === 'marginTop') return '10px';
          if (prop === 'marginBottom') return '30px';
          const value = (target as unknown as Record<string | symbol, unknown>)[prop];
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as CSSStyleDeclaration;
    }
    return base;
  }) as typeof window.getComputedStyle;
  restores.push(() => { window.getComputedStyle = orig; });
}

/** 布局度量打桩：题块/抬头有高度，sheet 的 scrollHeight=子块和、clientHeight=内容区高。
 *  0007 P4 扩展：题高可参数化（questionPx）；.mf-col 列盒 clientHeight=style.height−slack
 *  （slack 模拟真实布局与装箱口径的残差，用于触发二次校验回平衡），scrollHeight=子块和。 */
const restores: Array<() => void> = [];

function stubLayout(questionPx = QUESTION_PX, colClientSlackPx = 0, olTwoPx?: number) {
  const heightOf = (el: Element): number => {
    if (el.classList.contains('mf-sheet')) {
      return Array.from(el.children).reduce((sum, child) => sum + heightOf(child), 0);
    }
    if (el.classList.contains('mf-sheet-cols')) {
      return Array.from(el.children).reduce((max, child) => Math.max(max, heightOf(child)), 0);
    }
    if (el.classList.contains('mf-col')) {
      return Array.from(el.children).reduce((sum, child) => sum + heightOf(child), 0);
    }
    if (el.classList.contains('mf-text-item')) return questionPx;
    if (el.classList.contains('question-item')) {
      // 0013：两行版式题块实测高可参数化（ol-two 类块按 olTwoPx 量高——真实浏览器中 grid 均分变矮）
      if (olTwoPx !== undefined && el.classList.contains('ol-two')) return olTwoPx;
      return questionPx;
    }
    // 0007 P5：行内串单元（题内容纯文本 → 单元=连续行内节点）量高包盒
    if (el.classList.contains('mf-unit-wrap')) {
      // 0013：单元高随所属题块版式档（装箱量的是叶块单元，非题根）
      const qRoot = el.closest('.question-item');
      if (olTwoPx !== undefined && qRoot?.classList.contains('ol-two')) return olTwoPx;
      return questionPx;
    }
    if (el.classList.contains('paper-header')) return HEADER_PX;
    if (el.classList.contains('mf-paged-note') || el.classList.contains('paper-footer')) return 20;
    return 0;
  };
  const rect = (el: Element) => {
    const h = heightOf(el);
    return { width: 600, height: h, top: 0, left: 0, right: 600, bottom: h, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
  const origRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) { return rect(this); };
  restores.push(() => { Element.prototype.getBoundingClientRect = origRect; });

  const define = (prop: 'offsetHeight' | 'scrollHeight' | 'clientHeight', get: (el: HTMLElement) => number) => {
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get(this: HTMLElement) { return get(this); } });
    restores.push(() => {
      if (desc) Object.defineProperty(HTMLElement.prototype, prop, desc);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
    });
  };

  define('offsetHeight', (el) => heightOf(el));
  define('scrollHeight', (el) => heightOf(el));
  define('clientHeight', (el) => {
    if (el.classList.contains('mf-col')) {
      return Math.max(1, (parseFloat(el.style.height) || 0) - colClientSlackPx);
    }
    if (!el.classList.contains('mf-sheet')) return heightOf(el);
    const style = (el as HTMLElement).style;
    const height = parseFloat(style.height) || 0;
    const padT = parseFloat(style.paddingTop) || 0;
    const padB = parseFloat(style.paddingBottom) || 0;
    return Math.max(1, height - padT - padB);
  });
}

/** fixture → 注入脚本 → 执行（jsdom 不自动执行 srcdoc 内脚本） */
function runInjected(
  count: number,
  paginate: boolean,
  padTB = 75.59,
  opts?: { columns?: 1 | 2; columnGapMm?: number; logo?: boolean; questionPx?: number; colSlackPx?: number; olTwo?: boolean; olTwoPx?: number },
) {
  const html = fixtureHtml(count, padTB, opts?.logo ?? false, opts?.olTwo === true ? ' ol-two' : '');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + '<body>'.length, html.indexOf('</body>'));
  stubLayout(opts?.questionPx ?? QUESTION_PX, opts?.colSlackPx ?? 0, opts?.olTwoPx);
  const injected = injectPreviewScript(html, {
    assetsRoot: null,
    pageWmm: PAGE_W_MM,
    pageHmm: PAGE_H_MM,
    questionIds: Array.from({ length: count }, (_, i) => `q${i + 1}`),
    paginate,
    interactive: false,
    ...(opts?.columns !== undefined ? { columns: opts.columns } : {}),
    ...(opts?.columnGapMm !== undefined ? { columnGapMm: opts.columnGapMm } : {}),
  });
  const script = injected.slice(injected.indexOf('<script>') + '<script>'.length, injected.indexOf('</script>'));
  // eslint-disable-next-line no-new-func
  new Function(script)();
  return document.querySelector('.paper') as HTMLElement;
}
afterEach(() => {
  while (restores.length > 0) restores.pop()!();
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-mf-sheets');
  document.documentElement.removeAttribute('data-mf-overflow');
});

describe('fix-4 2.1 分页注入脚本运行时（jsdom + 度量打桩 + 固定 fixture）', () => {
  it('10 题 + 抬头 → 多页纸流；块序完整；data-mf-sheets 与 DOM 一致；差异标注在', () => {
    const paperEl = runInjected(10, true);

    const sheets = document.querySelectorAll('.mf-sheet');
    expect(sheets.length).toBeGreaterThan(1);
    expect(document.documentElement.getAttribute('data-mf-sheets')).toBe(String(sheets.length));
    expect(document.documentElement.getAttribute('data-mf-overflow')).toBe('0');
    // 块序完整：10 个题块全部在纸流内且文档序不变
    const items = Array.from(document.querySelectorAll('.question-item'));
    expect(items).toHaveLength(10);
    items.forEach((el, i) => {
      expect(el.textContent).toContain(`第 ${i + 1} 题题干文字`);
    });
    // 差异标注（诚实 UI；0007 P2 起分页=导出 PDF 实际分页，语义同步更新）
    expect(document.querySelector('.mf-paged-note')?.textContent).toContain('分页视图 = 导出 PDF 实际分页');
    // 页化标记（.paper 归零内边距 + 题容器移除）
    expect(paperEl.classList.contains('mf-paged')).toBe(true);
    expect(document.querySelector('.paper-questions')).toBeNull();
  });

  it('连续视图（paginate:false）→ 不页化（零 mf-sheet）', () => {
    runInjected(3, false);

    expect(document.querySelectorAll('.mf-sheet')).toHaveLength(0);
    expect(document.querySelector('.paper-questions')).not.toBeNull();
  });

  // 0007 P1 单源一致性：注入运行时装箱结果必须逐点等于 paginate.planPages（同一份实现）。
  // 卷面：抬头 100px（边距 0）+ 10 题 × 300px（mt=10/mb=30），页内容高 = 1122.52 − 60.75×2 ≈ 1001.02px。
  // 折叠口径分布：[抬头+1+2][3+4+5][6+7+8][9+10] = 4 页；旧求和口径（块高 340 累加）= 5 页（分歧样本）。
  it('0007 P1 装箱单源：带外边距卷面 == planPages 折叠口径（页数 + 逐页题号序列）', async () => {
    const { planPages, mmToPx } = await import('../../src/app/pages/paginate.js');
    stubMargins();
    runInjected(10, true, 60.75);

    const capacity = mmToPx(PAGE_H_MM) - 60.75 * 2;
    const specs = [
      { key: 'HEADER', heightPx: HEADER_PX, marginTopPx: 0, marginBottomPx: 0 },
      ...Array.from({ length: 10 }, (_, i) => ({ key: `${i + 1}.`, heightPx: QUESTION_PX, marginTopPx: 10, marginBottomPx: 30 })),
    ];
    const plan = planPages(specs, capacity);
    // 分歧样本自检：折叠口径必须 4 页（若为 5 页说明容量落在非分歧区，样本失效）
    expect(plan.pages).toHaveLength(4);

    const sheets = Array.from(document.querySelectorAll('.mf-sheet'));
    expect(sheets).toHaveLength(plan.pages.length);
    const keysOf = (sheet: Element) =>
      Array.from(sheet.querySelectorAll('.question-item .question-number')).map((el) => el.textContent?.trim());
    expect(sheets.map(keysOf)).toEqual(
      plan.pages.map((p) => p.blocks.map((b) => b.key).filter((k) => k !== 'HEADER'))
    );
  });
});

// 0007 P2：页化导出能力（导出链路同构核心——页化 DOM 自带打印所需的全部结构/样式/页码，
// 导出窗 printToPDF 只负责照 sheet 分页；footerTemplate 退役、@page margin 归零、边距=sheet padding 单一真源）
describe('0007 P2 页化导出能力', () => {
  it('页码内容化：每 sheet 页脚渲染真实页码「第 N 页 / 共 M 页」', () => {
    runInjected(10, true);
    const sheets = Array.from(document.querySelectorAll('.mf-sheet'));
    expect(sheets.length).toBeGreaterThan(1);
    sheets.forEach((sheet, i) => {
      const footer = sheet.querySelector('.mf-sheet-footer');
      expect(footer?.textContent).toBe(`第 ${i + 1} 页 / 共 ${sheets.length} 页`);
    });
  });

  it('HTML 页码死占位 .paper-footer 从页化 DOM 移除（footerTemplate 退役配套）', () => {
    runInjected(3, true);
    expect(document.querySelector('.paper-footer')).toBeNull();
  });

  it('页化注入打印页样式：@page margin 归零（边距=sheet padding 单一真源）+ sheet 结构规则', () => {
    runInjected(3, true);
    const styles = Array.from(document.querySelectorAll('style')).map((s) => s.textContent ?? '');
    const printCss = styles.find((t) => t.includes('@page'));
    expect(printCss).toBeDefined();
    expect(printCss).toContain('margin: 0');
    // sheet 结构规则随运行时注入（导出路径不经 FRAME_CSS，打印正确性不得依赖它）
    expect(printCss).toContain('.mf-sheet');
    expect(printCss).toContain('.mf-sheet-footer');
  });

  it('CFG.deferSetup=true → 不自动页化；window.__mofangPaginate.setup() 手动触发后页化', () => {
    const html = fixtureHtml(3);
    document.body.innerHTML = html.slice(html.indexOf('<body>') + '<body>'.length, html.indexOf('</body>'));
    stubLayout();
    const injected = injectPreviewScript(html, {
      assetsRoot: null, pageWmm: PAGE_W_MM, pageHmm: PAGE_H_MM,
      questionIds: ['q1', 'q2', 'q3'], paginate: true, interactive: false, deferSetup: true,
    });
    const script = injected.slice(injected.indexOf('<script>') + '<script>'.length, injected.indexOf('</script>'));
    // eslint-disable-next-line no-new-func
    new Function(script)();
    // deferSetup：注入后未页化
    expect(document.querySelectorAll('.mf-sheet')).toHaveLength(0);
    // 手动触发（导出窗在字体/图片就绪后调用）
    const api = (window as unknown as { __mofangPaginate?: { setup: () => void } }).__mofangPaginate;
    expect(api).toBeDefined();
    api!.setup();
    expect(document.querySelectorAll('.mf-sheet').length).toBeGreaterThan(0);
  });
});

// 0007 P3：Logo 逐页内容化（装箱阶段克隆进每页 sheet，坐标基准统一=纸面；
// 屏显=打印同一绝对定位，@media print position:fixed 双态落点差清偿）
describe('0007 P3 Logo 逐页内容化', () => {
  it('每 sheet 恰好 1 个 Logo：首页原件 + 其余页克隆（data-mf-clone），坐标 inline 样式逐点保持', () => {
    runInjected(10, true, 75.59, { logo: true });

    const sheets = Array.from(document.querySelectorAll('.mf-sheet'));
    // 1 列 300px 题 ×10 + 抬头：容量 971.34 → [h,1,2][3,4,5][6,7,8][9,10] = 4 页
    expect(sheets).toHaveLength(4);

    const logos = Array.from(document.querySelectorAll('.paper-logo')) as HTMLImageElement[];
    expect(logos).toHaveLength(sheets.length);
    sheets.forEach((sheet, i) => {
      const inSheet = Array.from(sheet.querySelectorAll('.paper-logo')) as HTMLImageElement[];
      expect(inSheet).toHaveLength(1);
      // Logo 直挂 sheet（坐标基准=纸面），不在内容流内
      expect(inSheet[0].parentElement).toBe(sheet);
      // 坐标/尺寸 inline 样式逐点保持（克隆不失真）
      expect(inSheet[0].style.left).toBe('21mm');
      expect(inSheet[0].style.top).toBe('14.85mm');
      expect(inSheet[0].style.width).toBe('42mm');
      // 首页=原件（交互层只绑原件），其余页=克隆标记
      expect(inSheet[0].hasAttribute('data-mf-clone')).toBe(i !== 0);
    });
  });
});

// 0007 P4：双列手工列盒装箱（退役 Chromium column-count 打印断列；
// 列内容量逐列由装箱器控制，列盒=与页内容等高的窄盒，块不跨列）
describe('0007 P4 双列手工列盒', () => {
  it('双列页化：sheet > .mf-sheet-cols > 2×.mf-col；抬头通栏（sheet 直接子级）；分布 == planColumns 单源', async () => {
    const { planColumns, mmToPx } = await import('../../src/app/pages/paginate.js');
    runInjected(10, true, 75.59, { columns: 2, columnGapMm: 8 });

    const contentH = mmToPx(PAGE_H_MM) - 75.59 * 2;
    const specs = Array.from({ length: 10 }, (_, i) => ({ key: `${i + 1}.`, heightPx: QUESTION_PX }));
    const expected = planColumns(specs, contentH, {
      columnsPerSheet: 2,
      firstSheetColumnCapacityPx: contentH - HEADER_PX,
    });
    // 分歧锚点：2 sheet（sheet0 压缩容量 [1,2][3,4]，sheet1 [5,6,7][8,9,10]）
    expect(expected.sheets).toHaveLength(2);

    const sheets = Array.from(document.querySelectorAll('.mf-sheet'));
    expect(sheets).toHaveLength(expected.sheets.length);
    expect(document.documentElement.getAttribute('data-mf-sheets')).toBe('2');
    expect(document.documentElement.getAttribute('data-mf-overflow')).toBe('0');

    sheets.forEach((sheet, si) => {
      const colsWrap = sheet.querySelector('.mf-sheet-cols');
      expect(colsWrap).not.toBeNull();
      // 手工列盒：不再走 column-count 内联（Chromium 断列路径退役）
      expect((colsWrap as HTMLElement).style.columnCount).toBe('');
      const cols = Array.from(colsWrap!.querySelectorAll('.mf-col'));
      expect(cols).toHaveLength(2);
      cols.forEach((col, ci) => {
        const keys = Array.from(col.querySelectorAll('.question-item .question-number'))
          .map((el) => el.textContent?.trim());
        expect(keys).toEqual(expected.sheets[si].columns[ci].map((b) => b.key));
      });
      if (si === 0) {
        // 抬头通栏：sheet 直接子级，不在任何列盒内
        const header = sheet.querySelector(':scope > .paper-header');
        expect(header).not.toBeNull();
        expect(sheet.querySelector('.mf-col .paper-header')).toBeNull();
      }
    });
  });

  it('双列二次校验：列盒真实溢出 → 末块沿流盒链后推（跨列→跨页），页码随回平衡重计', () => {
    // 题高 320：装箱口径 3/列（960 ≤ 971.34）；列盒 clientHeight 桩 −25 模拟布局残差 → 960 > 946 触发回平衡
    runInjected(10, true, 75.59, { columns: 2, columnGapMm: 8, questionPx: 320, colSlackPx: 25 });

    const sheets = Array.from(document.querySelectorAll('.mf-sheet'));
    expect(sheets).toHaveLength(3);
    expect(document.documentElement.getAttribute('data-mf-sheets')).toBe('3');
    const keysOfCol = (col: Element) =>
      Array.from(col.querySelectorAll('.question-item .question-number')).map((el) => el.textContent?.trim());
    const distribution = sheets.map((sheet) =>
      Array.from(sheet.querySelectorAll('.mf-col')).map(keysOfCol));
    expect(distribution).toEqual([
      [['1.', '2.'], ['3.', '4.']],
      [['5.', '6.'], ['7.', '8.']],
      [['9.', '10.'], []],
    ]);
    // 页码随回平衡后的 sheet 数重计
    sheets.forEach((sheet, i) => {
      expect(sheet.querySelector('.mf-sheet-footer')?.textContent).toBe(`第 ${i + 1} 页 / 共 3 页`);
    });
  });
});

// 0007 P5：段级装箱（装箱粒度题级→段级）。题内 <p> 段块 = 单元（图块/作答区/公式容器原子不变）；
// 题首（.question-header，浮动同行）与首段绑定（防孤），断页只发生在段边界；
// 续页片段 = .question-item.mf-continued（同 data-mf-qindex，承载同题后续段）；
// 「纸张结束」提示逐 sheet 落在内容区底边（屏显物，打印隐藏）。
const PARA_PX = 100;
const PARA_FIXTURE_HEADER_PX = 100;
const mmToPxOf = (mm: number): number => (mm * 96) / 25.4;
/** 0007 P6：行盒桩字符口径（每行 10 字 × 100px 行高；与 stubParaLayout 的 <p> 量高自洽） */
const LONG_LINE_CHARS = 10;

/** 多段落卷面 fixture（题 = 题首 + N 段；段块即装箱单元；withHeader=带卷抬头，默认不带以便逐容器复算容量） */
function paraFixtureHtml(questionCount: number, parasPerQuestion: number, padTB: number, withHeader = false): string {
  const items = Array.from({ length: questionCount }, (_, qi) => {
    const paras = Array.from({ length: parasPerQuestion }, (_, pi) => `<p>第 ${qi + 1} 题第 ${pi + 1} 段</p>`).join('');
    return `<div class="question-item"><div class="question-header"><span class="question-number">${qi + 1}.</span></div>`
      + `<div class="mf-question-body"><div class="question-content"><div class="question">${paras}</div></div></div></div>`;
  }).join('\n');
  const headerHtml = withHeader ? '<div class="paper-header"><h1 class="paper-title">P5 段级装箱探针卷</h1></div>' : '';
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>P5 段级装箱探针卷</title></head><body>`
    + `<div class="paper" style="box-sizing: border-box; padding: ${padTB}px 56.69px;">`
    + headerHtml
    + `<div class="paper-questions">${items}</div>`
    + `<div class="paper-footer"><span class="pageNumber"></span> / <span class="totalPages"></span></div>`
    + `</div></body></html>`;
}

/** 段级布局度量打桩：<p> = 行数 × PARA_PX（0007 P6：按 textContent 长度折算行数，段内拆分后前半/残段各自量高自洽）；
 *  题高=段和（二次校验口径）；sheet 客户端高=高−上下 padding */
function stubParaLayout() {
  const sumKids = (el: Element): number =>
    Array.from(el.children).reduce((sum, child) => sum + heightOfEl(child), 0);
  const heightOfEl = (el: Element): number => {
    if (el.classList.contains('mf-sheet')) return sumKids(el);
    if (el.classList.contains('mf-sheet-cols')) {
      return Array.from(el.children).reduce((max, child) => Math.max(max, heightOfEl(child)), 0);
    }
    if (el.classList.contains('mf-col')) return sumKids(el);
    // 0007 P6：行高口径（10 字/行 × 100px；既有 P5 短段 8 字 → 1 行 = PARA_PX，旧例零漂移）
    if (el.tagName === 'P') return Math.max(1, Math.ceil((el.textContent ?? '').length / LONG_LINE_CHARS)) * PARA_PX;
    if (el.classList.contains('question-item')) return sumKids(el);
    if (el.classList.contains('question-header')) return 0;
    if (el.classList.contains('paper-header')) return PARA_FIXTURE_HEADER_PX;
    if (el.classList.contains('mf-paged-note') || el.classList.contains('paper-footer')) return 20;
    return 0;
  };
  const rect = (el: Element) => {
    const h = heightOfEl(el);
    return { width: 600, height: h, top: 0, left: 0, right: 600, bottom: h, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
  const origRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) { return rect(this); };
  restores.push(() => { Element.prototype.getBoundingClientRect = origRect; });
  const define = (prop: 'offsetHeight' | 'scrollHeight' | 'clientHeight', get: (el: HTMLElement) => number) => {
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get(this: HTMLElement) { return get(this); } });
    restores.push(() => {
      if (desc) Object.defineProperty(HTMLElement.prototype, prop, desc);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
    });
  };
  define('offsetHeight', (el) => heightOfEl(el));
  define('scrollHeight', (el) => heightOfEl(el));
  define('clientHeight', (el) => {
    if (!el.classList.contains('mf-sheet')) return heightOfEl(el);
    const style = (el as HTMLElement).style;
    const height = parseFloat(style.height) || 0;
    const padT = parseFloat(style.paddingTop) || 0;
    const padB = parseFloat(style.paddingBottom) || 0;
    return Math.max(1, height - padT - padB);
  });
}

/** 段级外边距打桩：题块 mt=10/mb=30；段块无外边距（折叠口径可在测试内逐点复算） */
function stubParaMargins() {
  const orig = window.getComputedStyle.bind(window);
  window.getComputedStyle = ((el: Element) => {
    const base = orig(el);
    if (el.classList.contains('question-item') || el.tagName === 'P') {
      return new Proxy(base, {
        get: (target, prop) => {
          if (prop === 'marginTop') return el.classList.contains('question-item') ? '10px' : '0px';
          if (prop === 'marginBottom') return el.classList.contains('question-item') ? '30px' : '0px';
          const value = (target as unknown as Record<string | symbol, unknown>)[prop];
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as CSSStyleDeclaration;
    }
    return base;
  }) as typeof window.getComputedStyle;
  restores.push(() => { window.getComputedStyle = orig; });
}

/** 段级卷面 → 注入脚本 → 执行 */
function runParaInjected(questionCount: number, parasPerQuestion: number, padTB: number, withHeader = false) {
  const html = paraFixtureHtml(questionCount, parasPerQuestion, padTB, withHeader);
  document.body.innerHTML = html.slice(html.indexOf('<body>') + '<body>'.length, html.indexOf('</body>'));
  stubParaLayout();
  stubParaMargins();
  const injected = injectPreviewScript(html, {
    assetsRoot: null,
    pageWmm: PAGE_W_MM,
    pageHmm: PAGE_H_MM,
    questionIds: Array.from({ length: questionCount }, (_, i) => `q${i + 1}`),
    paginate: true,
    interactive: false,
  });
  const script = injected.slice(injected.indexOf('<script>') + '<script>'.length, injected.indexOf('</script>'));
  // eslint-disable-next-line no-new-func
  new Function(script)();
  return injected;
}

/** sheet 内片段元素（文档序；过滤页脚/纸张结束提示等绝对定位件） */
function fragmentsOf(box: Element): Element[] {
  return Array.from(box.children).filter((el) => el.classList.contains('question-item'));
}
const paraTextsOf = (frag: Element): string[] =>
  Array.from(frag.querySelectorAll('p')).map((p) => p.textContent ?? '');

describe('0007 P5 段级装箱（段级断页 + 防孤绑定 + 纸张结束提示）', () => {
  it('题内段落跨页切分：片边界=段边界（续页片段 .mf-continued 承载同题后续段，段序完整）', () => {
    // 容量 = 1122.52 − 2×386.26 ≈ 350px；题=题首+8 段×100px（题尾 mb 30）
    const padTB = (mmToPxOf(297) - 350) / 2;
    runParaInjected(1, 8, padTB);

    const sheets = Array.from(document.querySelectorAll('.mf-sheet'));
    // 段级装箱：首片 题首+p1..p3（10+300=310 ≤ 350）→ 续片 p4..p6 → 续片 p7,p8
    expect(sheets).toHaveLength(3);
    expect(document.documentElement.getAttribute('data-mf-sheets')).toBe('3');
    expect(document.documentElement.getAttribute('data-mf-overflow')).toBe('0');

    // 首片=原题元素（非续片段），含题首 + 前 3 段
    const first = fragmentsOf(sheets[0]);
    expect(first).toHaveLength(1);
    expect(first[0].classList.contains('mf-continued')).toBe(false);
    expect(first[0].querySelector('.question-header .question-number')?.textContent).toBe('1.');
    expect(paraTextsOf(first[0])).toEqual(['第 1 题第 1 段', '第 1 题第 2 段', '第 1 题第 3 段']);

    // 续页片段：类/题序标记 + 同题后续段
    const second = fragmentsOf(sheets[1]);
    expect(second).toHaveLength(1);
    expect(second[0].classList.contains('mf-continued')).toBe(true);
    expect(second[0].getAttribute('data-mf-qindex')).toBe('0');
    expect(paraTextsOf(second[0])).toEqual(['第 1 题第 4 段', '第 1 题第 5 段', '第 1 题第 6 段']);
    const third = fragmentsOf(sheets[2]);
    expect(third).toHaveLength(1);
    expect(paraTextsOf(third[0])).toEqual(['第 1 题第 7 段', '第 1 题第 8 段']);

    // 段序完整（不丢段不重段）：全纸流段文本 == 原卷段序列
    const all = sheets.flatMap((s) => fragmentsOf(s).flatMap((f) => paraTextsOf(f)));
    expect(all).toEqual(Array.from({ length: 8 }, (_, i) => `第 1 题第 ${i + 1} 段`));
  });

  it('段级装箱单源：运行时逐 sheet 逐片 == planFlow（单元高/边距同桩，含题尾边距归属）', async () => {
    const { planFlow, mmToPx } = await import('../../src/app/pages/paginate.js');
    const padTB = (mmToPxOf(297) - 350) / 2;
    runParaInjected(1, 8, padTB);

    const capacity = mmToPx(297) - padTB * 2;
    const specs = [
      { key: 'h', heightPx: 0, marginTopPx: 10, marginBottomPx: 0, group: '0', keepWithNext: true },
      ...Array.from({ length: 8 }, (_, i) => ({
        key: `p${i + 1}`, heightPx: PARA_PX, marginTopPx: 0, marginBottomPx: i === 7 ? 30 : 0, group: '0',
      })),
    ];
    const plan = planFlow(specs, { capacityPx: capacity });
    // 分歧锚点自检：段级必须跨 3 容器（若 1-2 容器说明容量落在非分歧区，样本失效）
    expect(plan.containers).toHaveLength(3);

    const sheets = Array.from(document.querySelectorAll('.mf-sheet'));
    expect(sheets).toHaveLength(plan.containers.length);
    plan.containers.forEach((container, ci) => {
      const frags = fragmentsOf(sheets[ci]);
      expect(frags).toHaveLength(container.fragments.length);
      container.fragments.forEach((frag, fi) => {
        const expectedKeys = frag.units.map((u) => u.key);
        const actual: string[] = [];
        if (frags[fi].querySelector('.question-header')) actual.push('h');
        paraTextsOf(frags[fi]).forEach((t) => actual.push(`p${t.match(/第 (\d+) 段/)?.[1]}`));
        expect(actual).toEqual(expectedKeys);
        expect(frags[fi].classList.contains('mf-continued')).toBe(frag.continued);
      });
    });
  });

  it('防孤绑定：题首不落页尾——首段放不下时题首随绑定推到次页（题首与首段同片）', () => {
    // 容量 ≈ 460px；题1=题首+4 段+题尾 mb=30 → 440 恰好一页；题2 题首挤进页尾（+10 → 450），首段放不下 → 同推次页
    const padTB = (mmToPxOf(297) - 460) / 2;
    runParaInjected(2, 4, padTB);

    const sheets = Array.from(document.querySelectorAll('.mf-sheet'));
    expect(sheets.length).toBeGreaterThanOrEqual(2);
    // 题首与首段从不分离：含 .question-header 的片段必含 ≥1 段（且题首必然不是片段末元素）
    const allFrags = sheets.flatMap((s) => fragmentsOf(s));
    const headerFrags = allFrags.filter((f) => f.querySelector('.question-header'));
    expect(headerFrags).toHaveLength(2);
    headerFrags.forEach((f) => { expect(paraTextsOf(f).length).toBeGreaterThan(0); });

    // 页 1 只有题 1（题 2 的题首被推走，不落页尾）
    expect(fragmentsOf(sheets[0])).toHaveLength(1);
    expect(paraTextsOf(fragmentsOf(sheets[0])[0])).toEqual([
      '第 1 题第 1 段', '第 1 题第 2 段', '第 1 题第 3 段', '第 1 题第 4 段',
    ]);
    // 页 2 首片 = 题 2 首片（含题首）+ 首段同片
    const firstOfSecond = fragmentsOf(sheets[1])[0];
    expect(firstOfSecond.querySelector('.question-header .question-number')?.textContent).toBe('2.');
    expect(firstOfSecond.classList.contains('mf-continued')).toBe(false);
    expect(paraTextsOf(firstOfSecond)).toEqual([
      '第 2 题第 1 段', '第 2 题第 2 段', '第 2 题第 3 段', '第 2 题第 4 段',
    ]);
  });

  it('「纸张结束」提示：逐 sheet 一个、落在内容区底边、打印隐藏规则随运行时注入', () => {
    const padTB = 75.59;
    const injected = runParaInjected(6, 2, padTB, true);

    const sheets = Array.from(document.querySelectorAll('.mf-sheet'));
    expect(sheets.length).toBeGreaterThan(1);
    const expectedTop = `${Math.round(mmToPxOf(PAGE_H_MM) - padTB)}px`;
    sheets.forEach((sheet) => {
      const ends = Array.from(sheet.children).filter((el) => el.classList.contains('mf-sheet-end'));
      expect(ends).toHaveLength(1);
      const end = ends[0] as HTMLElement;
      expect(end.textContent).toContain('纸张结束');
      // 内容区底边（纸高 − 下边距）= 页边界位置；绝对定位不占流内高度（不产多余页）
      expect(end.style.top).toBe(expectedTop);
    });
    // 屏显物：打印隐藏（随运行时打印样式；否则 PDF 每页多一条纸边提示）
    expect(injected).toContain('@media print');
    expect(injected).toMatch(/@media print \{[\s\S]*?\.mf-sheet-end \{[^}]*display: none/);
    // 页化 DOM 差异标注同步段级语义
    expect(document.querySelector('.mf-paged-note')?.textContent).toContain('段级');
    expect(document.querySelector('.mf-paged-note')?.textContent).toContain('纸张结束');
  });
});

// 0007 P6：长文段内行级拆分（Range 行盒懒测量 + 行边界断点 + 防孤行 orphans=widows=2）。
// 行盒桩：Range.getClientRects 按「每行 10 字 × 100px」模型出行盒（selectNodeContents=全量行数，
// 前缀 range=累计字符折算行数），与 stubParaLayout 的 <p> 量高口径自洽（拆分后前半/残段各自量高=行数×100）。
// 长文 fixture：段文本 = 10 字/行的编号块序列（PnLmm#####），逐字断言可精确定位丢字/重字。
const longChunk = (p: number, l: number): string => `P${p}L${String(l).padStart(2, '0')}#####`.slice(0, LONG_LINE_CHARS);
const longParaText = (p: number, lineCount: number): string =>
  Array.from({ length: lineCount }, (_, l) => longChunk(p, l)).join('');

/** 长文卷面 fixture：单题 = 题首 + N 段（段 = 行数 或 原始 innerHTML——行内元素跨界用例） */
function longTextFixtureHtml(paras: Array<number | string>, padTB: number): string {
  const parasHtml = paras
    .map((spec, pi) => (typeof spec === 'number' ? `<p>${longParaText(pi + 1, spec)}</p>` : `<p>${spec}</p>`))
    .join('');
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>P6 行级拆分探针卷</title></head><body>`
    + `<div class="paper" style="box-sizing: border-box; padding: ${padTB}px 56.69px;">`
    + `<div class="paper-questions">`
    + `<div class="question-item"><div class="question-header"><span class="question-number">1.</span></div>`
    + `<div class="mf-question-body"><div class="question-content"><div class="question">${parasHtml}</div></div></div></div>`
    + `</div>`
    + `<div class="paper-footer"><span class="pageNumber"></span> / <span class="totalPages"></span></div>`
    + `</div></body></html>`;
}

/** 0007 P6：Range 行盒桩（jsdom 无布局——getClientRects 原生缺失；按字符模型出行盒矩形）。
 *  throwOnText：命中文本即抛错（降级安全用例——行盒测量异常须回退段级路径）。 */
function stubLineBoxes(opts?: { throwOnText?: string }) {
  const proto = Range.prototype as unknown as { getClientRects?: (this: Range) => DOMRect[] };
  const had = proto.getClientRects;
  const lineRect = (i: number): DOMRect =>
    ({ width: 600, height: PARA_PX, top: i * PARA_PX, bottom: (i + 1) * PARA_PX, left: 0, right: 600, x: 0, y: i * PARA_PX, toJSON: () => ({}) }) as DOMRect;
  const charsWithin = (host: Element, node: Node, offset: number): number => {
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    let sum = 0;
    let n = walker.nextNode();
    while (n) {
      if (n === node) return sum + offset;
      sum += (n.textContent ?? '').length;
      n = walker.nextNode();
    }
    return sum;
  };
  proto.getClientRects = function (this: Range): DOMRect[] {
    const sc = this.startContainer;
    const host = (sc.nodeType === 1 ? sc : sc.parentElement) as Element | null;
    if (!host) return [];
    if (opts?.throwOnText && (host.textContent ?? '').includes(opts.throwOnText)) {
      throw new Error('stub: 行盒测量失败（降级路径探针）');
    }
    const chars =
      this.startContainer === this.endContainer && sc.nodeType === 1
        ? (host.textContent ?? '').length
        : charsWithin(host, this.endContainer, this.endOffset);
    const n = Math.ceil(chars / LONG_LINE_CHARS);
    return Array.from({ length: n }, (_, i) => lineRect(i));
  };
  restores.push(() => {
    if (had) proto.getClientRects = had;
    else delete proto.getClientRects;
  });
}

/** 长文卷面 → 注入脚本 → 执行（段级桩 + 行盒桩） */
function runLongTextInjected(paras: Array<number | string>, padTB: number, opts?: { throwOnText?: string }) {
  const html = longTextFixtureHtml(paras, padTB);
  document.body.innerHTML = html.slice(html.indexOf('<body>') + '<body>'.length, html.indexOf('</body>'));
  stubParaLayout();
  stubParaMargins();
  stubLineBoxes(opts);
  const injected = injectPreviewScript(html, {
    assetsRoot: null,
    pageWmm: PAGE_W_MM,
    pageHmm: PAGE_H_MM,
    questionIds: ['q1'],
    paginate: true,
    interactive: false,
  });
  const script = injected.slice(injected.indexOf('<script>') + '<script>'.length, injected.indexOf('</script>'));
  // eslint-disable-next-line no-new-func
  new Function(script)();
}

/** 纸流阅读序全部 <p>（跨 sheet/跨片段）文本序列 */
function allParaTexts(): string[] {
  return Array.from(document.querySelectorAll('.mf-sheets .question-item p')).map((p) => p.textContent ?? '');
}

describe('0007 P6 段内行级拆分（长文 Range 行盒懒测量 + 防孤行 + 降级安全）', () => {
  const CAP = 1100;   // 内容高 1100px = 11 行/页（行高 100px 桩）
  const padTB = (mmToPxOf(PAGE_H_MM) - CAP) / 2;

  it('超长单段跨页拆分：40 行 → 4 页（10+11+11+8），逐字一致 + 续片段标记 + 页码逐页', () => {
    runLongTextInjected([40], padTB);
    const original = longParaText(1, 40);

    const sheets = Array.from(document.querySelectorAll('.mf-sheet'));
    expect(sheets).toHaveLength(4);
    expect(document.documentElement.getAttribute('data-mf-sheets')).toBe('4');
    // 拆得掉的超长段不再标溢出（overflowWarn 语义收窄）
    expect(document.documentElement.getAttribute('data-mf-overflow')).toBe('0');

    // 逐页行数（10+11+11+8 = 40：首页题首占位 10px → 首段少带 1 行）
    const perSheetChars = sheets.map((s) =>
      Array.from(s.querySelectorAll('.question-item p')).reduce((sum, p) => sum + (p.textContent ?? '').length, 0));
    expect(perSheetChars).toEqual([100, 110, 110, 80]);

    // 首片 = 原题元素（非续），后续页 = .mf-continued 续片段（P5 同款标记）
    sheets.forEach((s, i) => {
      const frags = fragmentsOf(s);
      expect(frags).toHaveLength(1);
      expect(frags[0].classList.contains('mf-continued')).toBe(i !== 0);
      expect(frags[0].getAttribute('data-mf-qindex')).toBe('0');
      expect(s.querySelector('.mf-sheet-footer')?.textContent).toBe(`第 ${i + 1} 页 / 共 4 页`);
    });

    // 不丢字不重字：全纸流段文本逐字 == 原文（含 40 个编号块各恰好一次）
    expect(allParaTexts().join('')).toBe(original);
    const chunks = allParaTexts().join('').match(/P1L\d\d#####/g) ?? [];
    expect(new Set(chunks).size).toBe(40);
  });

  it('阅读篇多段连续跨页：8+8+8 行 → 3 页，段内断点前后文字无缝衔接、段序不乱', () => {
    runLongTextInjected([8, 8, 8], padTB);
    const sheets = Array.from(document.querySelectorAll('.mf-sheet'));
    expect(sheets).toHaveLength(3);
    expect(document.documentElement.getAttribute('data-mf-overflow')).toBe('0');

    // 分布：s1 = p1(8 行) + p2 前 2 行；s2 = p2 残 6 行 + p3 前 5 行；s3 = p3 残 3 行
    const texts = allParaTexts();
    expect(texts.map((t) => t.length)).toEqual([80, 20, 60, 50, 30]);
    // 逐段无缝衔接（拆分前后每段逐字一致；段序 = 原段序）
    expect(texts[0]).toBe(longParaText(1, 8));
    expect(texts[1] + texts[2]).toBe(longParaText(2, 8));
    expect(texts[3] + texts[4]).toBe(longParaText(3, 8));
    // 断点在段内（同段前后片在不同 sheet）：s1 末片与 s2 首片同属第 2 段
    expect(fragmentsOf(sheets[0])[0].classList.contains('mf-continued')).toBe(false);
    expect(fragmentsOf(sheets[1])[0].classList.contains('mf-continued')).toBe(true);
    expect(fragmentsOf(sheets[2])[0].classList.contains('mf-continued')).toBe(true);
  });

  it('行内元素跨界完整归属：<b>/<sub> 拆分两侧逐字守恒、元素各自完整不拦腰截断', () => {
    // 80 字 = 20 A + 40 B(b) + 10 S(sub) + 10 C；容量 400 − 题首 10 → 断在第 3 行后（字 30，落在 <b> 内）；
    // 残段 5 行(500+题尾 30) 仍超容量 400 → 链式再拆 3+2（行级拆分对残段沿链生效）→ 3 页 [30, 30, 20] 字
    const inlinePara = `${'A'.repeat(20)}<b>${'B'.repeat(40)}</b><sub>${'S'.repeat(10)}</sub>${'C'.repeat(10)}`;
    const padNarrow = (mmToPxOf(PAGE_H_MM) - 400) / 2;
    runLongTextInjected([inlinePara], padNarrow);

    const sheets = Array.from(document.querySelectorAll('.mf-sheet'));
    expect(sheets).toHaveLength(3);
    expect(document.documentElement.getAttribute('data-mf-overflow')).toBe('0');
    const texts = allParaTexts();
    expect(texts.map((t) => t.length)).toEqual([30, 30, 20]);
    // 逐字守恒（跨 <b> 边界拆分不丢字不重字）
    expect(texts.join('')).toBe('A'.repeat(20) + 'B'.repeat(40) + 'S'.repeat(10) + 'C'.repeat(10));
    // 前段 30 字（20 A + 10 B），中段 30 字（30 B），末段 20 字（10 S + 10 C）
    expect(texts[0]).toBe('A'.repeat(20) + 'B'.repeat(10));
    expect(texts[1]).toBe('B'.repeat(30));
    expect(texts[2]).toBe('S'.repeat(10) + 'C'.repeat(10));
    // 元素完整归属：前段 <b> 含前 10 个 B；中段 <b> 含后 30 个 B；<sub> 完整在末段
    const headP = sheets[0].querySelector('.question-item p');
    const midP = sheets[1].querySelector('.question-item p');
    const tailP = sheets[2].querySelector('.question-item p');
    expect(headP?.querySelector('b')?.textContent).toBe('B'.repeat(10));
    expect(headP?.querySelector('sub')).toBeNull();
    expect(midP?.querySelector('b')?.textContent).toBe('B'.repeat(30));
    expect(midP?.querySelector('sub')).toBeNull();
    expect(tailP?.querySelector('b')).toBeNull();
    expect(tailP?.querySelector('sub')?.textContent).toBe('S'.repeat(10));
    // 续片段标记：首片非续，中/末片为续
    sheets.forEach((s, i) => {
      expect(fragmentsOf(s)[0].classList.contains('mf-continued')).toBe(i !== 0);
    });
  });

  it('防孤行：剩余空间不足 2 行 → 整段推下一页（不硬拆、无拆片段）', () => {
    // 题首 10 + p1 9 行(900) = 910；剩余 190 < 2 行 → p2（4 行）整段推次页
    runLongTextInjected([9, 4], padTB);
    const sheets = Array.from(document.querySelectorAll('.mf-sheet'));
    expect(sheets).toHaveLength(2);
    const texts = allParaTexts();
    expect(texts).toEqual([longParaText(1, 9), longParaText(2, 4)]);
    // p2 完整在次页（整段，无拆分）；续片段标记来自段级跨页（P5 语义）
    const second = fragmentsOf(sheets[1]);
    expect(second).toHaveLength(1);
    expect(second[0].classList.contains('mf-continued')).toBe(true);
    expect(second[0].querySelectorAll('p')).toHaveLength(1);
    expect(document.documentElement.getAttribute('data-mf-overflow')).toBe('0');
  });

  it('降级安全：行盒测量异常 → 回退段级（整段独占 + ⚠ 溢出标记），不丢字不白屏', () => {
    runLongTextInjected([40], padTB, { throwOnText: 'P1L' });
    const sheets = Array.from(document.querySelectorAll('.mf-sheet'));
    // 回退 P5 段级：题首随绑定链与整段同页，独占标溢出
    expect(sheets).toHaveLength(1);
    expect(document.documentElement.getAttribute('data-mf-overflow')).toBe('1');
    expect(sheets[0].classList.contains('mf-sheet--overflow')).toBe(true);
    // 内容零丢失：全文 40 行逐字在（单 <p> 完整，无拆片段）
    expect(allParaTexts()).toEqual([longParaText(1, 40)]);
  });
});

// 0009：卷头多行自定义（变高卷头）——卷头高由既有运行时实测 + 首页容量压缩自动消化，装箱零改动。
// 卷头 HTML 由真渲染器 core 路径产出（`.paper-header` + N×`.paper-header-line` 与生产同形）；
// 题块/屏显页边距沿既有 fixture 约定（padding 内联模拟 @media screen 注入值）。
const HEADER_LINE_PX = 60;

function headerLinesFixtureHtml(lineCount: number, questionCount: number, padTB = 75.59): string {
  const paper: Paper = {
    id: 'header-lines-paper',
    title: '卷头行数探针卷',
    config: {},
    createdAt: '2026-09-11T00:00:00Z',
    archived: false,
  };
  const lines = Array.from({ length: lineCount }, (_, i) => ({
    text: `卷头第 ${i + 1} 行`,
    sizePt: i === 0 ? 18 : 11,
    align: 'center' as const,
    bold: i === 0,
  }));
  const questionsHtml = Array.from({ length: questionCount }, (_, i) => (
    `<div class="question-item"><div class="question-header"><span class="question-number">${i + 1}.</span></div>` +
    `<div class="mf-question-body"><div class="question-content">第 ${i + 1} 题题干文字</div></div></div>`
  )).join('\n');
  const doc = buildHtmlDocument(paper, questionsHtml, '', '', {
    resolved: resolveLayout({ version: 2, header: { style: 'exam', lines } }),
    assetsRoot: null,
  });
  return doc.replace('<div class="paper">', `<div class="paper" style="box-sizing: border-box; padding: ${padTB}px 56.69px;">`);
}

/** 变高卷头度量桩：`.paper-header` 高 = 各行高之和（行 = HEADER_LINE_PX）；其余口径同既有 stubLayout */
function stubHeaderLinesLayout() {
  const sumKids = (el: Element): number =>
    Array.from(el.children).reduce((sum, child) => sum + heightOfEl(child), 0);
  const heightOfEl = (el: Element): number => {
    if (el.classList.contains('mf-sheet')) return sumKids(el);
    if (el.classList.contains('mf-sheet-cols')) {
      return Array.from(el.children).reduce((max, child) => Math.max(max, heightOfEl(child)), 0);
    }
    if (el.classList.contains('mf-col')) return sumKids(el);
    if (el.classList.contains('question-item') || el.classList.contains('mf-text-item')) return QUESTION_PX;
    if (el.classList.contains('mf-unit-wrap')) return QUESTION_PX;
    if (el.classList.contains('paper-header-line')) return HEADER_LINE_PX;
    if (el.classList.contains('paper-header')) return sumKids(el);
    if (el.classList.contains('mf-paged-note') || el.classList.contains('paper-footer')) return 20;
    return 0;
  };
  const rect = (el: Element) => {
    const h = heightOfEl(el);
    return { width: 600, height: h, top: 0, left: 0, right: 600, bottom: h, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
  const origRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) { return rect(this); };
  restores.push(() => { Element.prototype.getBoundingClientRect = origRect; });

  const define = (prop: 'offsetHeight' | 'scrollHeight' | 'clientHeight', get: (el: HTMLElement) => number) => {
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get(this: HTMLElement) { return get(this); } });
    restores.push(() => {
      if (desc) Object.defineProperty(HTMLElement.prototype, prop, desc);
      else Reflect.deleteProperty(HTMLElement.prototype, prop);
    });
  };

  define('offsetHeight', (el) => heightOfEl(el));
  define('scrollHeight', (el) => heightOfEl(el));
  define('clientHeight', (el) => {
    if (el.classList.contains('mf-col')) {
      return Math.max(1, parseFloat(el.style.height) || 0);
    }
    if (!el.classList.contains('mf-sheet')) return heightOfEl(el);
    const style = (el as HTMLElement).style;
    const height = parseFloat(style.height) || 0;
    const padT = parseFloat(style.paddingTop) || 0;
    const padB = parseFloat(style.paddingBottom) || 0;
    return Math.max(1, height - padT - padB);
  });
}

/** 卷头行数卷面 → 注入脚本 → 执行 */
function runHeaderLinesInjected(
  lineCount: number,
  questionCount: number,
  padTB = 75.59,
  opts?: { columns?: 1 | 2; columnGapMm?: number; interactive?: boolean },
) {
  const html = headerLinesFixtureHtml(lineCount, questionCount, padTB);
  document.body.innerHTML = html.slice(html.indexOf('<body>') + '<body>'.length, html.indexOf('</body>'));
  stubHeaderLinesLayout();
  const injected = injectPreviewScript(html, {
    assetsRoot: null,
    pageWmm: PAGE_W_MM,
    pageHmm: PAGE_H_MM,
    questionIds: Array.from({ length: questionCount }, (_, i) => `q${i + 1}`),
    paginate: true,
    interactive: opts?.interactive === true,
    ...(opts?.columns !== undefined ? { columns: opts.columns } : {}),
    ...(opts?.columnGapMm !== undefined ? { columnGapMm: opts.columnGapMm } : {}),
  });
  const script = injected.slice(injected.indexOf('<script>') + '<script>'.length, injected.indexOf('</script>'));
  // eslint-disable-next-line no-new-func
  new Function(script)();
  return injected;
}

/** 当前纸流逐页题数（单列 sheet 序 = 页序） */
const sheetQuestionCounts = (): number[] =>
  Array.from(document.querySelectorAll('.mf-sheet')).map((s) => s.querySelectorAll('.question-item').length);

describe('0009 卷头多行：变高卷头由既有实测 + 首页容量压缩自动消化（装箱零改动）', () => {
  const CONTENT_H = (PAGE_H_MM * 96) / 25.4 - 75.59 * 2;   // 971.34px
  const firstSheetCapacity = (lineCount: number): number => CONTENT_H - lineCount * HEADER_LINE_PX;
  const questionSpecs = () => Array.from({ length: 10 }, (_, i) => ({
    key: `g${i}:0`, heightPx: QUESTION_PX, marginTopPx: 0, marginBottomPx: 0, group: `g${i}`,
  }));
  /** 单列装箱规格：卷头=流入单元（独立 group），其高=行数 × 行高 */
  const planSpecs = (lineCount: number) => [
    { key: 'header', heightPx: lineCount * HEADER_LINE_PX, marginTopPx: 0, marginBottomPx: 0 },
    ...questionSpecs(),
  ];

  it('单列：双行卷头首页压缩量 −（一行高），首页题数 3 → 2；逐页题数 == planFlow 单源', async () => {
    const { planFlow } = await import('../../src/app/pages/paginate.js');

    runHeaderLinesInjected(1, 10);
    const single = sheetQuestionCounts();
    runHeaderLinesInjected(2, 10);
    const double = sheetQuestionCounts();

    // 单行卷头：卷头 60 + 3 题(900) ≤ 971.34；双行卷头：卷头 120 → 首页让出 1 题
    expect(single[0]).toBe(3);
    expect(double[0]).toBe(2);
    expect(double[0]).toBeLessThan(single[0]);
    expect(document.documentElement.getAttribute('data-mf-overflow')).toBe('0');
    // 纸流完整：10 题不丢不重
    expect(single.reduce((a, b) => a + b, 0)).toBe(10);
    expect(double.reduce((a, b) => a + b, 0)).toBe(10);

    // 装箱单源：首页容量 = 内容高 − 卷头实测总高（行数 × 行高），逐页分布与运行时逐点一致
    const planCounts = (lineCount: number) => {
      const plan = planFlow(planSpecs(lineCount), { capacityPx: CONTENT_H });
      return plan.containers.map((c) =>
        c.fragments.flatMap((f) => f.units).filter((u) => u.group !== undefined).length);
    };
    expect(firstSheetCapacity(2)).toBeLessThan(firstSheetCapacity(1));
    expect(planCounts(1)).toEqual(single);
    expect(planCounts(2)).toEqual(double);
    expect(single[0]).toBe(Math.floor(firstSheetCapacity(1) / QUESTION_PX));
    expect(double[0]).toBe(Math.floor(firstSheetCapacity(2) / QUESTION_PX));
  });

  it('双列：双行卷头通栏（sheet 直接子级）→ 首页列容量压缩量增大，首张 sheet 每列题数 3 → 2', async () => {
    const { planColumns } = await import('../../src/app/pages/paginate.js');

    runHeaderLinesInjected(1, 10, 75.59, { columns: 2, columnGapMm: 8 });
    const single = document.querySelectorAll('.mf-sheet')[0];
    const singleFirst = Array.from(single.querySelectorAll('.mf-col'))
      .map((col) => col.querySelectorAll('.question-item').length);
    runHeaderLinesInjected(2, 10, 75.59, { columns: 2, columnGapMm: 8 });
    const sheets = Array.from(document.querySelectorAll('.mf-sheet'));
    const doubleFirst = Array.from(sheets[0].querySelectorAll('.mf-col'))
      .map((col) => col.querySelectorAll('.question-item').length);

    expect(singleFirst).toEqual([3, 3]);
    expect(doubleFirst).toEqual([2, 2]);
    expect(doubleFirst[0]).toBeLessThan(singleFirst[0]);

    // 卷头通栏：双行卷头（2 行）是 sheet 直接子级、不进任何列盒
    const header = sheets[0].querySelector(':scope > .paper-header');
    expect(header).not.toBeNull();
    expect(header!.querySelectorAll('.paper-header-line')).toHaveLength(2);
    expect(sheets[0].querySelector('.mf-col .paper-header')).toBeNull();
    expect(document.documentElement.getAttribute('data-mf-overflow')).toBe('0');

    // 单源核对：planColumns 首页列容量 = 内容高 − 卷头实测总高（卷头通栏不进列流）
    const expected = planColumns(questionSpecs(), CONTENT_H, {
      columnsPerSheet: 2,
      firstSheetColumnCapacityPx: firstSheetCapacity(2),
    });
    expect(expected.sheets).toHaveLength(2);
    expect(expected.sheets[0].columns.map((col) => col.length)).toEqual([2, 2]);
    expect(sheets).toHaveLength(expected.sheets.length);
    expected.sheets.forEach((sheet, si) => {
      const cols = Array.from(sheets[si].querySelectorAll('.mf-col'));
      sheet.columns.forEach((col, ci) => {
        expect(cols[ci].querySelectorAll('.question-item').length).toBe(col.length);
      });
    });
  });

  it('注入层点编：旧 .paper-title 与多行 .paper-header-line 同机制（标可点 + 点击回传 mf-title-click）', async () => {
    const clickHeaderTargets = async (): Promise<string[]> => {
      const seen: string[] = [];
      const onMsg = (e: Event) => {
        const data = (e as MessageEvent).data as { t?: string } | null;
        if (data && typeof data.t === 'string') seen.push(data.t);
      };
      window.addEventListener('message', onMsg);
      try {
        document.querySelectorAll<HTMLElement>('.paper-title, .paper-header-line').forEach((el) => el.click());
        await new Promise((resolve) => setTimeout(resolve, 0));
      } finally {
        window.removeEventListener('message', onMsg);
      }
      return seen;
    };

    // 旧三态卷头（lines 空 → exam 路径）：.paper-title 仍可点回传（零回归）
    runHeaderLinesInjected(0, 3, 75.59, { interactive: true });
    const legacy = document.querySelector<HTMLElement>('.paper-title');
    expect(legacy).not.toBeNull();
    expect(legacy!.style.cursor).toBe('pointer');
    expect(await clickHeaderTargets()).toContain('mf-title-click');

    // 多行自定义卷头：逐行可点，点任意一行同回传（协议不变）
    runHeaderLinesInjected(2, 3, 75.59, { interactive: true });
    const lines = Array.from(document.querySelectorAll<HTMLElement>('.paper-header-line'));
    expect(lines).toHaveLength(2);
    lines.forEach((el) => expect(el.style.cursor).toBe('pointer'));
    expect(await clickHeaderTargets()).toContain('mf-title-click');
  });
});

// ==================== 0013 选项版式：页化装箱如实反映实测高变化 ====================

describe('0013 两行版式题块实测高变小 → 装箱容量变化如实反映', () => {
  it('同一页面容量下：ol-two 题块按实测矮盒装箱 → 首页容量增加、sheet 数减少（paginate 规则零改动）', () => {
    // 同一 fixture 同一容量，唯一差异 = 题块实测高（竖排 300px / 两行 grid 均分 150px）
    runInjected(10, true, 60.75, { questionPx: 300 });
    const plainSheets = document.querySelectorAll('.mf-sheet').length;
    const plainFirstPage = document.querySelectorAll('.mf-sheet')[0].querySelectorAll('.question-item').length;
    expect(plainSheets).toBeGreaterThan(1);

    runInjected(10, true, 60.75, { questionPx: 300, olTwo: true, olTwoPx: 150 });
    const olTwoSheets = document.querySelectorAll('.mf-sheet').length;
    const olTwoFirstPage = document.querySelectorAll('.mf-sheet')[0].querySelectorAll('.question-item').length;

    // 实测高变小 → 装箱容量如实放大（首页装得更多、总 sheet 数变少）；块序完整
    expect(olTwoFirstPage).toBeGreaterThan(plainFirstPage);
    expect(olTwoSheets).toBeLessThan(plainSheets);
    const items = Array.from(document.querySelectorAll('.question-item'));
    expect(items).toHaveLength(10);
    items.forEach((el, i) => {
      expect(el.textContent).toContain(`第 ${i + 1} 题题干文字`);
    });
  });
});

// ==================== 0013 实机反馈修复：跨页续片继承题容器版式类 ====================

describe('0013 跨页续片继承题容器版式类（mf-continued 不再丢 ol-*/mf-text-item 类）', () => {
  /** 单题 fixture：高题干(900px) + 选项组(120px) → 页内容高≈1001px，选项组被切到下一页成续片 */
  function splitFixtureHtml(itemCls: string): string {
    return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>0013 续片探针</title></head><body>' +
      '<div class="paper" style="box-sizing: border-box; padding: 60.75px 56.69px;">' +
      '<div class="paper-header"><h1 class="paper-title">0013 续片探针卷</h1></div>' +
      '<div class="paper-questions">' +
      '<div class="question-item ' + itemCls + '">' +
      '<div class="question-header"><span class="question-number">1.</span></div>' +
      '<div class="mf-question-body"><div class="question-content">' +
      '<p class="ol-tall">长题干文字（占满首页剩余容量）</p>' +
      '<div class="options"><span class="option">A. 甲</span><span class="option">B. 乙</span></div>' +
      '</div></div></div>' +
      '</div></div></body></html>';
  }

  function runSplitInjected(itemCls: string): void {
    const html = splitFixtureHtml(itemCls);
    document.body.innerHTML = html.slice(html.indexOf('<body>') + '<body>'.length, html.indexOf('</body>'));
    const heightOf = (el: Element): number => {
      if (el.classList.contains('paper-header')) return 100;
      if (el.classList.contains('question-header')) return 20;
      if (el.classList.contains('ol-tall')) return 900;
      if (el.classList.contains('options')) return 120;
      if (el.classList.contains('mf-paged-note') || el.classList.contains('paper-footer')) return 20;
      return 0;
    };
    const rect = (el: Element) => {
      const h = heightOf(el);
      return { width: 600, height: h, top: 0, left: 0, right: 600, bottom: h, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    };
    const origRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) { return rect(this); };
    restores.push(() => { Element.prototype.getBoundingClientRect = origRect; });
    const define = (prop: 'offsetHeight' | 'scrollHeight' | 'clientHeight', get: (el: HTMLElement) => number) => {
      const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
      Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get(this: HTMLElement) { return get(this); } });
      restores.push(() => {
        if (desc) Object.defineProperty(HTMLElement.prototype, prop, desc);
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
      });
    };
    define('offsetHeight', (el) => heightOf(el));
    define('scrollHeight', (el) => heightOf(el));
    define('clientHeight', (el) => {
      if (!el.classList.contains('mf-sheet')) return heightOf(el);
      const style = (el as HTMLElement).style;
      return Math.max(1, (parseFloat(style.height) || 0) - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0));
    });
    const injected = injectPreviewScript(html, {
      assetsRoot: null,
      pageWmm: PAGE_W_MM,
      pageHmm: PAGE_H_MM,
      questionIds: ['q1'],
      paginate: true,
      interactive: false,
    });
    const script = injected.slice(injected.indexOf('<script>') + '<script>'.length, injected.indexOf('</script>'));
    // eslint-disable-next-line no-new-func
    new Function(script)();
  }

  it('ol-single 题跨页：选项所在续片继承 ol-single（否则横排 CSS 打不中续片内选项——用户实机「点了没变化」根因）', () => {
    runSplitInjected('ol-single');

    const frags = document.querySelectorAll('.mf-continued');
    expect(frags.length).toBe(1);
    const frag = frags[0];
    // 续片携带选项组（切分发生且选项原子移动）
    expect(frag.querySelector('.options')).not.toBeNull();
    // 核心断言：续片继承题容器版式类
    expect(frag.classList.contains('ol-single')).toBe(true);
    expect(frag.classList.contains('question-item')).toBe(true);
    // 题序映射不受影响；首片保留版式类并获得 mf-split 标记
    expect(frag.getAttribute('data-mf-qindex')).toBe('0');
    const firstFrag = document.querySelectorAll('.question-item')[0];
    expect(firstFrag.classList.contains('ol-single')).toBe(true);
    expect(firstFrag.classList.contains('mf-split')).toBe(true);
  });

  it('题容器其余类（mf-text-item 系）同样继承（同一修复点，文本块续片样式不再丢）', () => {
    runSplitInjected('mf-text-item mf-text-item--note');
    const frag = document.querySelector('.mf-continued');
    expect(frag).not.toBeNull();
    expect(frag!.classList.contains('mf-text-item')).toBe(true);
    expect(frag!.classList.contains('mf-text-item--note')).toBe(true);
  });
});
