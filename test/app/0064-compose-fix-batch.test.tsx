// 0064 排版域批（四合一）测试 —— R-065 纸内滚动条 ∥ R-061 卷级版式不保存 ∥ R-062 拖图整页刷新 ∥ R-059 选中框滞留。
//
// 口径（任务书 §一/§四）：
//   R-061：layout 防抖自动落库（水合守卫 + 比对守卫双保险）——「改控件 → 防抖后落库且读回等值」
//          + 「首挂载水合不误写（库上快照不被默认 {version:2} 覆盖）」；
//   R-062：figure resize 落库回环不得整预览重建（srcdoc 不替换）且落库照常；同窗叠加其他版式变更不误吞；
//   R-065/R-059：jsdom 无布局引擎（无亚像素/无滚动条/无 ResizeObserver 真触发）→ 单测只做
//          **runtime 源码级判据**（0052 probe-0052-preview-scroll.mjs / 0058-figure-interaction.test.tsx 同型先例），
//          真机像素判据由 scripts/probe-0052-preview-scroll.mjs 新「视口挤窄」档 + probe-0058 复核档承担。
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

/** 真实时间等待（防抖 400ms / 预览重建 300ms 均走真计时器——不用假计时器，避免与 React 调度互相干扰） */
async function settle(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** 数值输入（ComposeLayoutControls 的 NumberField：input 后 blur 才提交；jsdom 中先 focus 再 blur 才触发 onBlur） */
function setNumberAndBlur(selector: string, value: string) {
  const el = container.querySelector(selector);
  if (!el) throw new Error(`找不到数值输入框: ${selector}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  flushSync(() => {
    setter.call(el, value);
    (el as HTMLInputElement).dispatchEvent(new Event('input', { bubbles: true }));
  });
  flushSync(() => {
    (el as HTMLInputElement).focus();
    (el as HTMLInputElement).blur();
  });
}

/** jsdom 无 iframe.srcDoc IDL 属性——统一经 attribute 读 srcdoc */
function srcdocOf(selector = '[data-testid="compose-preview-iframe"]'): string {
  const el = container.querySelector(selector);
  return el?.getAttribute('srcdoc') ?? '';
}

/** 模拟预览 iframe 注入脚本回传（source 必须等于预览 iframe 的 contentWindow，否则被 PaperPreviewFrame 过滤） */
async function postFromFrame(data: object) {
  await settle(300);
  const iframe = container.querySelector('[data-testid="compose-preview-iframe"]') as HTMLIFrameElement;
  const win = iframe?.contentWindow;
  if (!win) throw new Error('预览 iframe contentWindow 不存在');
  const event = new MessageEvent('message', { data });
  Object.defineProperty(event, 'source', { value: win });
  flushSync(() => {
    window.dispatchEvent(event);
  });
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

/** 造带图题：images 一张 figure 语义图（R-062 的 resize 消息目标） */
async function makeFigureQuestion(stem: string): Promise<string> {
  const q = await ctx.bank.createQuestion({
    subject: '物理',
    sourceType: 'local',
    sourceDetail: { origin: 'test' },
    content: `<div class="question">${stem}<figure data-w="300"><img src="data-assets/capture/a.png"></figure></div>`,
    images: [{ assetId: 'capture/a.png', type: 'figure', width: 300 }],
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

const FIGURE_ASSET = 'capture/a.png';

// ==================== R-061：卷级版式设置防抖自动落库 ====================

describe('0064 / R-061：卷级版式设置不再丢（layout 防抖自动落库）', () => {
  it('改控件 → 防抖后 setPaperLayoutConfig 被调且读回等值；重复提交同值不重写（比对守卫）', async () => {
    const q1 = await makeQuestion('落库题');
    const paperId = await makePaperAtStatus('防抖落库卷', 'composing', [q1]);

    const spy = vi.spyOn(svc.ext.paper, 'setPaperLayoutConfig');
    await mountCompose(paperId, '[data-testid="layout-font-size"]');
    // 挂载期：水合（库上无 layoutConfig → {version:2} 默认）不得写库
    await settle(700);
    expect(spy).not.toHaveBeenCalled();

    // 改卷级设置：字号 14
    setNumberAndBlur('[data-testid="layout-font-size"]', '14');
    await waitFor(() => {
      const stored = ctx.store.papers.get(paperId)?.layoutConfig;
      if (!stored || stored.fontSize !== 14) throw new Error(`防抖后未落库：${JSON.stringify(stored)}`);
    });
    expect(ctx.store.papers.get(paperId)?.layoutConfig).toMatchObject({ version: 2, fontSize: 14 });
    expect(spy).toHaveBeenCalledTimes(1);

    // 比对守卫：同值再提交一次（新增一次 onChange / 新 layout 对象引用）→ 序列化相等 → 不重写
    setNumberAndBlur('[data-testid="layout-font-size"]', '14');
    await settle(700);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('用户场景：改设置 → 中途离开（重挂载）→ 设置还在', async () => {
    const q1 = await makeQuestion('往返题');
    const paperId = await makePaperAtStatus('往返卷', 'composing', [q1]);
    await mountCompose(paperId, '[data-testid="layout-font-size"]');

    setNumberAndBlur('[data-testid="layout-font-size"]', '14');
    await waitFor(() => {
      if (ctx.store.papers.get(paperId)?.layoutConfig?.fontSize !== 14) throw new Error('未落库');
    });

    // 重进排版 = 新实例重新挂载：控件态必须从库上版式读出（R-051① 的挂载读取路径不得因本修失效）
    await mountCompose(paperId, '[data-testid="layout-font-size"]');
    await waitFor(() => {
      const el = container.querySelector('[data-testid="layout-font-size"]') as HTMLInputElement | null;
      if (!el || el.value !== '14') throw new Error(`重进卷字号未从库读出（${JSON.stringify(el?.value)}）`);
    });
    await waitFor(() => {
      if (!srcdocOf().includes('--mf-font-size: 14pt')) throw new Error('重进卷预览未用库上版式');
    });
  });

  it('首挂载水合不误写：库上已有版式 → 挂载/水合零写入，库上快照原样保留', async () => {
    const q1 = await makeQuestion('水合题');
    const paperId = await makePaperAtStatus('水合卷', 'composing', [q1]);
    await ctx.ext.paper.setPaperLayoutConfig(paperId, { version: 2, fontSize: 12, pageSize: 'A3' });

    const spy = vi.spyOn(svc.ext.paper, 'setPaperLayoutConfig');
    await mountCompose(paperId, '[data-testid="layout-font-size"]');
    await waitFor(() => {
      const el = container.querySelector('[data-testid="layout-font-size"]') as HTMLInputElement | null;
      if (!el || el.value !== '12') throw new Error('控件态未从库上快照水合');
    });
    await settle(700);
    expect(spy).not.toHaveBeenCalled();
    expect(ctx.store.papers.get(paperId)?.layoutConfig).toEqual({ version: 2, fontSize: 12, pageSize: 'A3' });
  });

  it('只读态（done）不写库：控件禁用 + 无落库调用', async () => {
    const q1 = await makeQuestion('只读题');
    const paperId = await makePaperAtStatus('只读卷', 'done', [q1]);
    const spy = vi.spyOn(svc.ext.paper, 'setPaperLayoutConfig');
    await mountCompose(paperId, '[data-testid="compose-clone-btn"]');
    await settle(700);
    expect(spy).not.toHaveBeenCalled();
  });
});

// ==================== R-062：拖图落库后不整预览重建 ====================

describe('0064 / R-062：拖图 resize 落库回环不重建预览（无 srcdoc 白闪）', () => {
  it('mf-figure-resize：widthPercent 落库照常 + 预览 srcdoc 不替换（重建计数为 0）', async () => {
    const q1 = await makeFigureQuestion('拖图题');
    const paperId = await makePaperAtStatus('拖图卷', 'composing', [q1]);
    await mountCompose(paperId, '[data-testid="layout-font-size"]');
    await waitFor(() => {
      if (!srcdocOf().includes('mf-seg')) throw new Error('预览未就绪');
    });

    const before = srcdocOf();
    // 反证前置：本次 resize 若真重建，产物 HTML 必变（否则「srcdoc 相等」是假通过）
    expect(before).not.toContain('width: 70%');

    // 重建探测：srcdoc 属性被改写 = srcdoc 整替换 = iframe reload 白闪
    const iframe = container.querySelector('[data-testid="compose-preview-iframe"]') as HTMLIFrameElement;
    let srcdocWrites = 0;
    const observer = new MutationObserver((records) => {
      for (const rec of records) if (rec.attributeName === 'srcdoc') srcdocWrites += 1;
    });
    observer.observe(iframe, { attributes: true, attributeFilter: ['srcdoc'] });

    await postFromFrame({ t: 'mf-figure-resize', questionId: q1, assetId: FIGURE_ASSET, widthPercent: 70 });
    // 落库照常（不因跳过重建而丢写入）
    await waitFor(() => {
      const figures = ctx.store.paperQuestions.get(paperId)![0].layout?.figures ?? [];
      if (!figures.some((f) => f.assetId === FIGURE_ASSET && f.widthPercent === 70)) {
        throw new Error(`resize 未落库：${JSON.stringify(figures)}`);
      }
    });
    // 越过预览防抖窗（300ms）+ 余量：若重建发生，此时 srcdoc 已换
    await settle(900);
    observer.disconnect();
    expect(srcdocWrites).toBe(0);
    expect(srcdocOf()).toBe(before);
  });

  it('叠加守卫：同防抖窗内另有卷级版式变更 → 照常重建（不被拖图回环误吞）', async () => {
    const q1 = await makeFigureQuestion('叠加题');
    const paperId = await makePaperAtStatus('叠加卷', 'composing', [q1]);
    await mountCompose(paperId, '[data-testid="layout-font-size"]');
    await waitFor(() => {
      if (!srcdocOf().includes('mf-seg')) throw new Error('预览未就绪');
    });
    expect(srcdocOf()).not.toContain('--mf-font-size: 14pt');

    // 同窗叠加：先改字号（版式变更，待重建），紧接着拖图回环落库
    setNumberAndBlur('[data-testid="layout-font-size"]', '14');
    await postFromFrame({ t: 'mf-figure-resize', questionId: q1, assetId: FIGURE_ASSET, widthPercent: 70 });
    await settle(900);
    // 版式变更必须照常体现在预览里（skip 只豁免「纯 figure resize 回环」）
    expect(srcdocOf()).toContain('--mf-font-size: 14pt');
  });
});

// ==================== R-065 / R-059：runtime 源码级判据（真机像素判据在探针） ====================

const runtimeSrc = readFileSync(join(__dirname, '../../src/app/pages/preview-frame-runtime.js'), 'utf-8');
const reportHeightBody = runtimeSrc.slice(
  runtimeSrc.indexOf('function reportHeight'),
  runtimeSrc.indexOf('if (typeof ResizeObserver')
);
const selectElBody = runtimeSrc.slice(
  runtimeSrc.indexOf('function selectEl'),
  runtimeSrc.indexOf('// ---------- 图块交互')
);

describe('0064 / R-065：高度上报端保留亚像素（不再把 1202.0997 上报成 1202）', () => {
  it('上报值取 documentElement 布局盒高（getBoundingClientRect，浮点）+ Math.ceil 收敛', () => {
    expect(reportHeightBody).toMatch(/getBoundingClientRect\(\)\.height/);
    expect(reportHeightBody).toMatch(/Math\.ceil\(/);
    // 地板保留：body.scrollHeight（内容短于视口时仍能收缩——老口径的收缩能力不丢；
    // documentElement.scrollHeight 不再作地板：它对根元素恒 ≥ 视口高，会把高度锁死只能涨）
    expect(reportHeightBody).toMatch(/body\.scrollHeight/);
  });

  it('父层 ceil 成幂等 no-op：PaperPreviewFrame 尺寸门控与 0052 裁剪机制零改动（只读口径锁）', () => {
    const frameSrc = readFileSync(join(__dirname, '../../src/app/pages/PaperPreviewFrame.tsx'), 'utf-8');
    expect(frameSrc).toMatch(/Math\.max\(200, Math\.ceil\(msg\.height\)\)/);
  });
});

describe('0064 / R-059：选中框重贴触发面扩到 documentElement（滚动条切换=视口宽变）', () => {
  it('selRO 在观察 target 之外兼观察 document.documentElement；target 观察不退役（尺寸变化触发面保留）', () => {
    expect(selectElBody).toMatch(/selRO\.observe\(target\)/);
    expect(selectElBody).toMatch(/selRO\.observe\(document\.documentElement\)/);
    // 重贴口径不变（getBoundingClientRect + scrollXY，逐边贴）
    expect(selectElBody).toMatch(/getBoundingClientRect\(\)/);
  });
});
