// 0004 Phase 5（S5）页面组件测试 — jsdom + Mock(in-memory) 注入单跑（照 basket-pages.test.tsx 模式）
// 覆盖：排版间版式控件（内置预设应用/参数联动）、定稿序列升级（config→快照→done，快照失败中止）、
// 题级图覆盖弹层（列表/调参/保存 setQuestionLayouts）、卷标题就地编辑（排版间+篮详情）、
// 快照走读（loadPaperBundle 对 done/archived 取快照、无快照回落+标记）、预设导入校验。
// 真实 SQLite 服务语义由 test/bank/basket-contract.test.ts 双跑覆盖。
// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { BankService, BankExtServices } from '../../src/shared/contracts/bank-types.js';
import { MockBankService } from '../../src/bank/mock/mock-bank.js';
import { createMockExtServices } from '../../src/bank/mock/mock-ext.js';
import { MockBankStore } from '../../src/bank/mock/mock-store.js';

import { ComposePage } from '../../src/app/pages/ComposePage.js';
import { QuestionFigureSettings } from '../../src/app/pages/QuestionFigureSettings.js';
import { BasketDetailPage } from '../../src/app/pages/BasketDetailPage.js';
import { loadPaperBundle } from '../../src/app/pages/paper-actions.js';
import { parseLayoutConfigJson, validateLayoutConfig } from '../../src/app/services/layout-config-validate.js';
import { InlineTitleEditor, type ExtPageServices } from '../../src/app/pages/ExtUi.js';

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

// ---------------- 渲染/交互辅助（照 basket-pages 模式） ----------------

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

function clickBtn(selector: string) {
  const el = container.querySelector(selector);
  if (!el) throw new Error(`找不到元素: ${selector}`);
  flushSync(() => (el as HTMLButtonElement).click());
}

function setInput(selector: string, value: string) {
  const el = container.querySelector(selector);
  if (!el) throw new Error(`找不到输入框: ${selector}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  (el as HTMLInputElement).dispatchEvent(new Event('input', { bubbles: true }));
}

/** 数值输入（ComposeLayoutControls 的草稿态 NumberField：input 后 blur 才提交；
 *  jsdom 中未聚焦元素 blur 是 no-op——先 focus 再 blur 才触发 React onBlur） */
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

function setSelect(selector: string, value: string) {
  const el = container.querySelector(selector);
  if (!(el instanceof HTMLSelectElement)) throw new Error(`找不到下拉: ${selector}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/** jsdom 无 iframe.srcDoc IDL 属性——统一经 attribute 读 srcdoc */
function srcdocOf(selector = '[data-testid="compose-preview-iframe"]'): string {
  const el = container.querySelector(selector);
  return el?.getAttribute('srcdoc') ?? '';
}

async function waitFor(assertion: () => void) {
  await vi.waitFor(assertion, { timeout: 3000, interval: 20 });
}

/** fix-5 P1-3：模拟预览 iframe 注入脚本回传（source 必须等于预览 iframe 的 contentWindow，否则被过滤） */
async function postFromFrame(data: object) {
  await new Promise((resolve) => setTimeout(resolve, 400));
  const iframe = container.querySelector('[data-testid="compose-preview-iframe"]') as HTMLIFrameElement;
  const win = iframe?.contentWindow;
  if (!win) throw new Error('预览 iframe contentWindow 不存在');
  const event = new MessageEvent('message', { data });
  Object.defineProperty(event, 'source', { value: win });
  flushSync(() => {
    window.dispatchEvent(event);
  });
}

/** 预览就绪（srcdoc 含段边界标记）后再投递，断言成立为止重投（jsdom + React 时序偶发丢失） */
async function postUntil(data: object, predicate: () => boolean) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await waitFor(() => {
      if (!srcdocOf().includes('mf-seg')) throw new Error('预览未就绪');
    });
    await postFromFrame(data);
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (predicate()) return;
  }
}

/** 造题辅助 */
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

/** 造带图题：images 一张 figure 语义图（题级图设置弹层的数据基准） */
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

// ==================== 版式控件 + 定稿序列 ====================

describe('0004 Phase 5 排版间：版式控件与定稿序列', () => {
  it('内置模板可见可应用：管理弹层列出 A3双列/A4，应用 A3双列 → 纸张下拉变 A3', async () => {
    const q1 = await makeQuestion('版式题一');
    const paperId = await makePaperAtStatus('版式卷', 'composing', [q1]);
    render(<ComposePage paperId={paperId} svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="layout-controls"]')) throw new Error('控件区未渲染');
    });

    clickBtn('[data-testid="preset-manage-btn"]');
    await waitFor(() => {
      if (!container.querySelector('[data-testid="preset-row-preset-builtin-a3-2col"]')) throw new Error('内置模板未列出');
    });
    expect(container.querySelector('[data-testid="preset-row-preset-builtin-a4"]')).not.toBeNull();

    clickBtn('[data-testid="preset-apply-preset-builtin-a3-2col"]');
    await waitFor(() => {
      const pageSize = container.querySelector('[data-testid="layout-page-size"]') as HTMLSelectElement | null;
      if (!pageSize || pageSize.value !== 'A3') throw new Error('应用 A3双列未生效');
    });
    // 双列列间距输入出现（联动控件）
    expect(container.querySelector('[data-testid="layout-column-gap"]')).not.toBeNull();
  });

  it('定稿序列（config→快照→done）：调版式 → 定稿 → layoutConfig 落库为 A3 + 状态 done', async () => {
    const q1 = await makeQuestion('定稿序列题');
    const paperId = await makePaperAtStatus('定稿序列卷', 'composing', [q1]);
    render(<ComposePage paperId={paperId} svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="compose-finalize-btn"]')) throw new Error('定稿按钮未渲染');
    });

    // 先应用 A3双列预设（应用=整体替换控件态），再改字号（控件态变化）
    clickBtn('[data-testid="preset-manage-btn"]');
    await waitFor(() => {
      if (!container.querySelector('[data-testid="preset-apply-preset-builtin-a3-2col"]')) throw new Error('管理弹层未开');
    });
    clickBtn('[data-testid="preset-apply-preset-builtin-a3-2col"]');
    setNumberAndBlur('[data-testid="layout-font-size"]', '14');
    // 0064（R-061）授权改写（任务书 §一.2）：旧断言 =「未定稿不写库」toBeUndefined()。
    // 设计前提已变更：左栏卷级版式改为**防抖 400ms 自动落库**（用户口径：中途离开再进排版设置还在）。
    // 等强改写 = 防抖落库后读回等值（比旧断言更强：不仅要求写了，还要求写的是当前控件态全量）。
    await waitFor(() => {
      const auto = ctx.store.papers.get(paperId)?.layoutConfig;
      if (!auto || auto.pageSize !== 'A3' || auto.fontSize !== 14) {
        throw new Error(`防抖落库未读回等值：${JSON.stringify(auto)}`);
      }
    });

    clickBtn('[data-testid="compose-finalize-btn"]');
    await waitFor(() => {
      expect(window.location.hash).toBe('#/basket');
    });
    const stored = ctx.store.papers.get(paperId);
    expect(stored?.status).toBe('done');
    expect(stored?.layoutConfig).toMatchObject({ version: 2, pageSize: 'A3', fontSize: 14 });
    // 快照已写（定稿序列第②步）
    const snapshots = await svc.ext.paper.listPaperSnapshotQuestions(paperId);
    expect(snapshots.length).toBe(1);
  });

  it('快照失败 → 中止定稿：setLayoutConfig 可先成功但绝不置 done，报错可见', async () => {
    const q1 = await makeQuestion('快照失败题');
    const paperId = await makePaperAtStatus('快照失败卷', 'composing', [q1]);
    const snapSpy = vi.spyOn(svc.ext.paper, 'snapshotPaperQuestions').mockRejectedValue(new Error('注入快照失败'));
    render(<ComposePage paperId={paperId} svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="compose-finalize-btn"]')) throw new Error('定稿按钮未渲染');
    });
    clickBtn('[data-testid="compose-finalize-btn"]');
    await waitFor(() => {
      const banner = container.querySelector('[data-testid="page-message"]');
      if (!banner || !banner.textContent?.includes('快照失败')) throw new Error('快照失败未报错');
    });
    expect(snapSpy).toHaveBeenCalled();
    expect(ctx.store.papers.get(paperId)?.status).toBe('composing'); // 绝不置 done
  });
});

// ==================== 题级图覆盖 ====================
// 0018 目检返工一：「图片设置」行内入口退役（题行扁平化）——弹层逻辑改直挂
// QuestionFigureSettings 组件断言 onSave 回调（组件契约），父级接线随入口退役。

describe('0004 Phase 5 排版间：题级图设置（0018 返工：直挂组件）', () => {
  it('图片设置弹层：列出 figure 语义图 → 调宽 30 + 版式右栏 → 保存回调携带 figures', async () => {
    const question = await ctx.bank.createQuestion({
      subject: '物理',
      sourceType: 'local',
      sourceDetail: { origin: 'test' },
      content: '<div class="question">带图题<figure data-w="300"><img src="data-assets/capture/a.png"></figure></div>',
      images: [{ assetId: 'capture/a.png', type: 'figure', width: 300 }],
    });
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<QuestionFigureSettings question={question} onCancel={() => {}} onSave={onSave} />);

    await waitFor(() => {
      if (!container.querySelector('[data-testid="figure-row-0"]')) throw new Error('图行未渲染');
    });
    expect(container.querySelector('[data-testid="figure-row-0"]')!.textContent).toContain('capture/a.png');

    setInput('[data-testid="figure-width-0"]', '30');
    setSelect('[data-testid="figure-mode-0"]', 'side-by-side');
    clickBtn('[data-testid="figure-save-btn"]');

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({
        figures: [
          { assetId: 'capture/a.png', mode: 'side-by-side', widthPercent: 30, orderIndex: 0 },
        ],
      });
    });
  });

  it('上移调序：第二张图上移 → onSave figures 按新序携带 orderIndex', async () => {
    const question = await ctx.bank.createQuestion({
      subject: '物理',
      sourceType: 'local',
      sourceDetail: { origin: 'test' },
      content: '<div class="question">双图题<figure data-w="300"><img src="data-assets/capture/a.png"></figure>'
        + '<figure data-w="200"><img src="data-assets/capture/b.png"></figure></div>',
      images: [
        { assetId: 'capture/a.png', type: 'figure', width: 300 },
        { assetId: 'capture/b.png', type: 'figure', width: 200 },
      ],
    });
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<QuestionFigureSettings question={question} onCancel={() => {}} onSave={onSave} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="figure-row-1"]')) throw new Error('第二图行未渲染');
    });
    clickBtn('[data-testid="figure-down-0"]'); // 图1 与图2 交换（等价图2 上移）
    clickBtn('[data-testid="figure-save-btn"]');
    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({
        figures: [
          { assetId: 'capture/b.png', orderIndex: 0 },
          { assetId: 'capture/a.png', orderIndex: 1 },
        ],
      });
    });
  });
});

// ==================== 卷标题就地编辑 ====================

describe('0004 Phase 5：卷标题就地编辑（fix-1 #1 转入）', () => {
  it('排版间：点标题变输入框 → 回车保存 updatePaperTitle', async () => {
    const q1 = await makeQuestion('就地编辑题');
    const paperId = await makePaperAtStatus('旧标题卷', 'composing', [q1]);
    render(<ComposePage paperId={paperId} svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="compose-title"]')) throw new Error('标题未渲染');
    });

    clickBtn('[data-testid="compose-title"]');
    await waitFor(() => {
      if (!container.querySelector('[data-testid="compose-title-input"]')) throw new Error('输入框未出现');
    });
    setInput('[data-testid="compose-title-input"]', '新标题卷');
    flushSync(() => {
      (container.querySelector('[data-testid="compose-title-input"]') as HTMLInputElement)
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await waitFor(() => {
      const title = container.querySelector('[data-testid="compose-title"]');
      if (!title || !title.textContent?.includes('新标题卷')) throw new Error('标题未更新');
    });
    expect(ctx.store.papers.get(paperId)?.title).toBe('新标题卷');
  });

  it('排版间：空标题拒绝保存（提示且不改库）', async () => {
    const q1 = await makeQuestion('空标题题');
    const paperId = await makePaperAtStatus('保留标题卷', 'composing', [q1]);
    render(<ComposePage paperId={paperId} svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="compose-title"]')) throw new Error('标题未渲染');
    });
    clickBtn('[data-testid="compose-title"]');
    await waitFor(() => {
      if (!container.querySelector('[data-testid="compose-title-input"]')) throw new Error('输入框未出现');
    });
    setInput('[data-testid="compose-title-input"]', '   ');
    flushSync(() => {
      (container.querySelector('[data-testid="compose-title-input"]') as HTMLInputElement).blur();
    });
    await waitFor(() => {
      const banner = container.querySelector('[data-testid="page-message"]');
      if (!banner || !banner.textContent?.includes('标题不能为空')) throw new Error('空标题未报错');
    });
    expect(ctx.store.papers.get(paperId)?.title).toBe('保留标题卷');
  });

  it('篮详情：basket 态标题就地编辑生效（保留重命名按钮并存）', async () => {
    const q1 = await makeQuestion('篮详情标题题');
    const paperId = await makePaperAtStatus('篮详情旧标题', 'basket', [q1]);
    render(<BasketDetailPage paperId={paperId} svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="basket-title"]')) throw new Error('标题未渲染');
    });
    expect(container.querySelector('[data-testid="basket-rename-btn"]')).not.toBeNull(); // 按钮保留

    clickBtn('[data-testid="basket-title"]');
    await waitFor(() => {
      if (!container.querySelector('[data-testid="basket-title-input"]')) throw new Error('输入框未出现');
    });
    setInput('[data-testid="basket-title-input"]', '篮详情新标题');
    flushSync(() => {
      (container.querySelector('[data-testid="basket-title-input"]') as HTMLInputElement)
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await waitFor(() => {
      const title = container.querySelector('[data-testid="basket-title"]');
      if (!title || !title.textContent?.includes('篮详情新标题')) throw new Error('标题未更新');
    });
    expect(ctx.store.papers.get(paperId)?.title).toBe('篮详情新标题');
  });
});

// ==================== 快照走读（loadPaperBundle） ====================

describe('0004 Phase 5：done/archived 快照走读', () => {
  it('done 卷改题后装载走快照（内容不漂移）；basket 卷取现题', async () => {
    const q = await ctx.bank.createQuestion({
      subject: '物理',
      sourceType: 'local',
      sourceDetail: { origin: 'test' },
      content: '<div class="question">快照题</div>',
      answer: '<p>原始答案</p>',
      images: [],
    });
    const doneId = await makePaperAtStatus('快照卷', 'done', [q.id]);
    const basketId = await makePaperAtStatus('现题卷', 'basket', [q.id]);

    // 出卷后改题库
    await ctx.bank.updateQuestion(q.id, { answer: '<p>改后答案</p>' });

    const doneBundle = await loadPaperBundle(ctx.bank, ctx.ext.paper, doneId);
    expect(doneBundle).not.toBeNull();
    expect(doneBundle!.questions[0].question.answer).toBe('<p>原始答案</p>'); // 快照
    expect(doneBundle!.snapshotMissing).toBeFalsy();

    const basketBundle = await loadPaperBundle(ctx.bank, ctx.ext.paper, basketId);
    expect(basketBundle!.questions[0].question.answer).toBe('<p>改后答案</p>'); // 现题
  });

  it('done 卷无快照（旧数据）→ 回落现题 + snapshotMissing 标记', async () => {
    const q = await makeQuestion('无快照题');
    // 直造 done 卷但不快照（对齐「旧数据未快照」场景）
    const paper = await ctx.ext.paper.createPaperEx('旧数据卷');
    await ctx.bank.addQuestion(paper.id, q, 5);
    await ctx.ext.paper.updatePaperStatus(paper.id, 'composing');
    await ctx.ext.paper.updatePaperStatus(paper.id, 'done');

    const bundle = await loadPaperBundle(ctx.bank, ctx.ext.paper, paper.id);
    expect(bundle).not.toBeNull();
    expect(bundle!.questions.length).toBe(1); // 回落现题
    expect(bundle!.snapshotMissing).toBe(true);
  });
});

// ==================== 预设导入校验（layout-config-validate） ====================

describe('0004 Phase 5：预设导入校验（非法报错不静默）', () => {
  it('合法 v2 config 全字段收（白名单外字段丢弃）', () => {
    const config = validateLayoutConfig({
      version: 2,
      pageSize: 'A3',
      columns: 2,
      columnGapMm: 10,
      fontSize: 12.5,
      lineHeight: 1.6,
      fontFamily: "'SimHei', sans-serif",
      pageMarginMm: { top: 18, right: 14, bottom: 18, left: 14 },
      header: { style: 'exam', title: '期末考试' },
      fieldVisibility: { questionNo: true, score: false, answer: true, analysis: false },
      answerSpace: { enabled: true, style: 'lines', heightMm: 30 },
      figureLayout: { mode: 'inline', align: 'center', widthPercent: 50 },
      logos: [{ assetId: 'logos/x.png', xRatio: 0.1, yRatio: 0.1, widthRatio: 0.2 }],
      hackerField: 'should-drop',
    });
    expect(config).toMatchObject({
      version: 2, pageSize: 'A3', columns: 2, columnGapMm: 10, fontSize: 12.5, lineHeight: 1.6,
    });
    expect(config.header).toEqual({ style: 'exam', title: '期末考试' });
    expect(config.fieldVisibility).toEqual({ questionNo: true, score: false, answer: true, analysis: false });
    expect(config.figureLayout).toEqual({ mode: 'inline', align: 'center', widthPercent: 50 });
    expect(config.logos).toEqual([{ assetId: 'logos/x.png', xRatio: 0.1, yRatio: 0.1, widthRatio: 0.2 }]);
    expect((config as Record<string, object | string | number | boolean | undefined>).hackerField).toBeUndefined();
  });

  it('非法结构逐项报错（version 缺失/枚举非法/logos 结构坏/非对象根）', () => {
    expect(() => validateLayoutConfig({ fontSize: 12 })).toThrow(/version/);
    expect(() => validateLayoutConfig({ version: 2, pageSize: 'A5' })).toThrow(/pageSize/);
    expect(() => validateLayoutConfig({ version: 2, columns: 3 })).toThrow(/columns/);
    expect(() => validateLayoutConfig({ version: 2, figureLayout: { widthPercent: 150 } })).toThrow(/widthPercent/);
    expect(() => validateLayoutConfig({ version: 2, logos: 'nope' })).toThrow(/logos/);
    expect(() => validateLayoutConfig({ version: 2, logos: [{ xRatio: 0.1 }] })).toThrow(/assetId/);
    expect(() => validateLayoutConfig({ version: 2, pageMarginMm: { top: 1 } })).toThrow(/pageMarginMm/);
    // 非对象根经 parse 收窄后同样报错（字符串根）
    expect(() => parseLayoutConfigJson('"just-a-string"')).toThrow(/根节点/);
  });

  it('parseLayoutConfigJson：非 JSON 文本报错；合法文本收窄为 config', () => {
    expect(() => parseLayoutConfigJson('{ this is not json')).toThrow(/合法 JSON/);
    const config = parseLayoutConfigJson('{"version":2,"pageSize":"A4","columns":1}');
    expect(config).toEqual({ version: 2, pageSize: 'A4', columns: 1 });
  });

  it('orientation 白名单（fix-2 F2-A）：landscape/portrait 收窄，白名单外报错', () => {
    const config = validateLayoutConfig({ version: 2, pageSize: 'A3', orientation: 'landscape' });
    expect(config.orientation).toBe('landscape');
    expect(() => validateLayoutConfig({ version: 2, orientation: 'diagonal' })).toThrow(/orientation/);
  });
});

// ==================== 0009：header.lines 预设校验白名单 ====================

describe('0009 预设导入校验：header.lines 白名单（逐行逐字段）', () => {
  it('合法 lines 全字段放行（行序保持 + 其余字段同源放行）', () => {
    const config = validateLayoutConfig({
      version: 2,
      header: {
        style: 'exam',
        lines: [
          { text: '标题', sizePt: 18, align: 'center', bold: true },
          { text: '总分：100分 考试时间：90分钟', sizePt: 11, align: 'left', bold: false },
        ],
      },
    });
    expect(config.header).toEqual({
      style: 'exam',
      lines: [
        { text: '标题', sizePt: 18, align: 'center', bold: true },
        { text: '总分：100分 考试时间：90分钟', sizePt: 11, align: 'left', bold: false },
      ],
    });
  });

  it('非法行剔除 / 非法字段剔除 / 未知字段丢弃（不静默透传）', () => {
    const config = validateLayoutConfig({
      version: 2,
      header: {
        lines: [
          { text: '合法行', sizePt: 12.5, align: 'right', bold: true, hackerField: 'drop-me' },
          { text: 42 },                                  // text 非 string → 剔行
          { sizePt: 12 },                                // 缺 text → 剔行
          'not-an-object',                               // 行非对象 → 剔行
          { text: '坏字段行', sizePt: 'big', align: 'justify', bold: 'yes' },  // 三字段非法 → 剔字段
          { text: '界外字号', sizePt: 200 },              // 字号越界 → 剔字段（渲染侧回缺省）
        ],
      },
    });
    expect(config.header?.lines).toEqual([
      { text: '合法行', sizePt: 12.5, align: 'right', bold: true },
      { text: '坏字段行' },
      { text: '界外字号' },
    ]);
  });

  it('lines 非数组 → 剔字段（不抛错、不静默塞入）', () => {
    const config = validateLayoutConfig({ version: 2, header: { style: 'exam', title: '卷标题', lines: 'nope' } });
    expect(config.header).toEqual({ style: 'exam', title: '卷标题' });
    expect(config.header?.lines).toBeUndefined();
  });

  it('lines 非空 → 解析产物落库路径可见（roundtrip：校验 → JSON → 再校验逐点一致）', () => {
    const lines = [{ text: '三行卷头第一行', sizePt: 18, align: 'center' as const, bold: true }];
    const first = validateLayoutConfig({ version: 2, header: { lines } });
    const roundtrip = parseLayoutConfigJson(JSON.stringify(first));
    expect(roundtrip.header?.lines).toEqual(lines);
  });
});

// ==================== fix-2 F2-B：页内预览 = 引擎真渲染 iframe ====================

describe('fix-2 F2-B：页内预览 iframe（防抖 srcdoc，引擎产物关键标记）', () => {
  it('srcdoc 含引擎真渲染标记：@page/katex 全量/选项块级规则/图块结构/交互层注入/题序注入', async () => {
    const q = await makeFigureQuestion('真渲染带图题');
    const paperId = await makePaperAtStatus('真渲染卷', 'composing', [q]);
    render(<ComposePage paperId={paperId} svc={svc} />);
    await waitFor(() => {
      const doc = srcdocOf();
      if (!doc) throw new Error('iframe srcdoc 未生成');
      if (!doc.includes('@page { size: A4;')) throw new Error('srcdoc 缺 @page 出纸规则');
    });
    const srcdoc = srcdocOf();
    // 三个样式层标签齐全（katex css + paper.css 基础层 + layout 增量层；vitest 中 ?raw CSS 为空串，
    // 真实构建含全量——CSS 内容回归由 test/docgen/paper-css.test.ts 与 render-browser.test.ts 覆盖）
    expect((srcdoc.match(/<style>/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(srcdoc).toContain('--mf-font-size: 12pt'); // 引擎 layout 层字号变量（config 驱动）
    expect(srcdoc).toContain('.options > .option'); // 选项块级规则（fix-2 选项分行，layout 层保底）
    expect(srcdoc).toContain('figure-block'); // 带图题图块结构（引擎块化产物）
    expect(srcdoc).toContain('mf-title-click'); // F2-D 交互层注入标记
    expect(srcdoc).toContain(`"${q}"`); // questionIds 注入（题块↔题 id 映射）
  });

  it('页内学生/教师版切换：teacher 版 srcdoc 出答案、student 版不出（同管线防抖重渲）', async () => {
    const q = await ctx.bank.createQuestion({
      subject: '物理',
      sourceType: 'local',
      sourceDetail: { origin: 'test' },
      content: '<div class="question">预览显隐题</div>',
      answer: '<p>参考答案内容</p>',
      images: [],
    });
    const paperId = await makePaperAtStatus('显隐预览卷', 'composing', [q.id]);
    render(<ComposePage paperId={paperId} svc={svc} />);
    await waitFor(() => {
      if (!srcdocOf()) throw new Error('iframe srcdoc 未生成');
    });
    expect(srcdocOf()).not.toContain('参考答案内容'); // student 基线隐答案

    clickBtn('[data-testid="compose-inline-mode-teacher"]');
    await waitFor(() => {
      if (!srcdocOf().includes('参考答案内容')) throw new Error('teacher 版答案未出现');
    });
    expect(srcdocOf()).toContain('answer-field');

    clickBtn('[data-testid="compose-inline-mode-student"]');
    await waitFor(() => {
      if (srcdocOf().includes('参考答案内容')) throw new Error('student 版答案未隐藏');
    });
  });

  it('A3双列预设应用 → srcdoc @page A3 landscape（fix-2 F2-A 用户目检 #1 程序化锚点）', async () => {
    const q = await makeQuestion('横版预览题');
    const paperId = await makePaperAtStatus('横版预览卷', 'composing', [q]);
    render(<ComposePage paperId={paperId} svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="preset-manage-btn"]')) throw new Error('控件区未渲染');
    });
    clickBtn('[data-testid="preset-manage-btn"]');
    await waitFor(() => {
      if (!container.querySelector('[data-testid="preset-apply-preset-builtin-a3-2col"]')) throw new Error('管理弹层未开');
    });
    clickBtn('[data-testid="preset-apply-preset-builtin-a3-2col"]');

    // 方向下拉联动为 landscape（种子 orientation）
    await waitFor(() => {
      const orient = container.querySelector('[data-testid="layout-orientation"]') as HTMLSelectElement | null;
      if (!orient || orient.value !== 'landscape') throw new Error('方向下拉未联动 landscape');
    });
    await waitFor(() => {
      if (!srcdocOf().includes('@page { size: A3 landscape;')) throw new Error('srcdoc 缺 A3 landscape');
    });
  });
});

// ==================== fix-2 F2-A：出纸 payload 按 layoutConfig 传 orientation ====================

describe('fix-2 F2-A：导出 PDF payload（pageSize/landscape）', () => {
  it('A3双列（landscape 种子）→ exportPdf payload 含 pageSize A3 + landscape true', async () => {
    const q = await makeQuestion('出纸取向题');
    const paperId = await makePaperAtStatus('出纸取向卷', 'composing', [q]);
    const exportPdf = vi.fn().mockResolvedValue({ filePath: null });
    (window as unknown as { __mofangBank?: unknown }).__mofangBank = { exportPdf };
    try {
      render(<ComposePage paperId={paperId} svc={svc} />);
      await waitFor(() => {
        if (!container.querySelector('[data-testid="preset-manage-btn"]')) throw new Error('控件区未渲染');
      });
      clickBtn('[data-testid="preset-manage-btn"]');
      await waitFor(() => {
        if (!container.querySelector('[data-testid="preset-apply-preset-builtin-a3-2col"]')) throw new Error('管理弹层未开');
      });
      clickBtn('[data-testid="preset-apply-preset-builtin-a3-2col"]');

      clickBtn('[data-testid="compose-export-student-btn"]');
      await waitFor(() => {
        if (exportPdf.mock.calls.length === 0) throw new Error('exportPdf 未被调用');
      });
      const payload = exportPdf.mock.calls[0][0] as {
        pageSize?: string;
        landscape?: boolean;
        paginate?: { pageWmm: number; pageHmm: number; columns: number; columnGapMm: number };
      };
      expect(payload.pageSize).toBe('A3');
      expect(payload.landscape).toBe(true);
      // 0007 P5：旧 footerTemplate 导出路径已退役——导出必带页化参数（缺 paginate 即 IPC 拒绝）
      expect(payload.paginate).toEqual({ pageWmm: 420, pageHmm: 297, columns: 2, columnGapMm: 8 });
    } finally {
      delete (window as unknown as { __mofangBank?: unknown }).__mofangBank;
    }
  });
});

// ==================== 0004-fix-3：图片可调面放宽 + 题级作答区 + 插图 + 交互层标记 ====================

describe('fix-4 #7：图片设置弹层（默认全可调，灰态机制退役；0018 返工：直挂组件）', () => {
  it('裸图与语义图均直接可调 → 保存回调按列表序携带 orderIndex', async () => {
    const question = await ctx.bank.createQuestion({
      subject: '物理',
      sourceType: 'local',
      sourceDetail: { origin: 'test' },
      content: '<div class="question">裸图题<p><img src="data-assets/capture/bare.png"></p>'
        + '<figure data-w="300"><img src="data-assets/capture/a.png"></figure></div>',
      images: [{ assetId: 'capture/a.png', type: 'figure', width: 300 }],
    });
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<QuestionFigureSettings question={question} onCancel={() => {}} onSave={onSave} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="figure-row-1"]')) throw new Error('图行未渲染');
    });
    // fix-4 #7：默认全可调——两行都直接可调，不再有「未参与/加入排版」灰态
    expect(container.querySelector('[data-testid="figure-unjoined-tag-0"]')).toBeNull();
    expect(container.querySelector('[data-testid="figure-join-0"]')).toBeNull();
    expect(container.querySelector('[data-testid="figure-row-0"]')!.textContent).toContain('capture/bare.png');
    expect(container.querySelector('[data-testid="figure-row-1"]')!.textContent).toContain('capture/a.png');
    clickBtn('[data-testid="figure-save-btn"]');
    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({
        figures: [
          { assetId: 'capture/bare.png', orderIndex: 0 },
          { assetId: 'capture/a.png', orderIndex: 1 },
        ],
      });
    });
  });

  it('题内图无「移除」按钮（引擎默认参与）；外来图可移除 → onSave 条目删除', async () => {
    const question = await ctx.bank.createQuestion({
      subject: '物理',
      sourceType: 'local',
      sourceDetail: { origin: 'test' },
      content: '<div class="question">移除题<p><img src="data-assets/capture/bare.png"></p></div>',
      images: [],
    });
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <QuestionFigureSettings
        question={question}
        current={[
          { assetId: 'capture/bare.png', orderIndex: 0, widthPercent: 40 },
          { assetId: 'logos/foreign.png', orderIndex: 1 },
        ]}
        onCancel={() => {}}
        onSave={onSave}
      />
    );
    await waitFor(() => {
      if (!container.querySelector('[data-testid="figure-remove-1"]')) throw new Error('外来图移除按钮未渲染');
    });
    expect(container.querySelector('[data-testid="figure-remove-0"]')).toBeNull();
    expect(container.querySelector('[data-testid="figure-foreign-tag-1"]')).not.toBeNull();
    clickBtn('[data-testid="figure-remove-1"]');
    await waitFor(() => {
      if (container.querySelector('[data-testid="figure-row-1"]')) throw new Error('外来图行未删除');
    });
    clickBtn('[data-testid="figure-save-btn"]');
    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({
        figures: [{ assetId: 'capture/bare.png', orderIndex: 0, widthPercent: 40 }],
      });
    });
  });
});

    it('预览 iframe 外来图集合与移除消息：覆盖含 content 无引用图 → srcdoc 注入 foreignAssets + 选中框体系', async () => {
    const q = await makeFigureQuestion('外来图预览题');
    const paperId = await makePaperAtStatus('外来图预览卷', 'composing', [q]);
    await svc.ext.paper.setQuestionLayouts(paperId, q, {
      figures: [{ assetId: 'logos/foreign.png', orderIndex: 0 }],
    });
    render(<ComposePage paperId={paperId} svc={svc} />);
    await waitFor(() => {
      const doc = srcdocOf();
      if (!doc.includes('foreignAssets')) throw new Error('foreignAssets 未注入');
    });
    const srcdoc = srcdocOf();
    expect(srcdoc).toContain('"foreignAssets"');
    expect(srcdoc).toContain('logos/foreign.png');
    // 选中框体系 + scale 补偿 + 移除消息（交互层注入标记）
    expect(srcdoc).toContain('mf-selection-box');
    expect(srcdoc).toContain('--mf-inv-scale');
    expect(srcdoc).toContain('mf-figure-remove');
    // 屏显页边距模拟（P1-1）
    expect(srcdoc).toContain('@media screen { .paper { box-sizing: border-box; padding: 20mm 15mm 20mm 15mm; } }');
  });

describe('fix-5 P1-3：题级作答区入口在右栏操作条（左栏控件退役，用户拍板 C）', () => {
  it('左栏题级控件与摘要行均已退役（0018 目检返工一）；三态消息落库（添加/行数/样式/删除）', async () => {
    const q1 = await makeQuestion('作答区行数题');
    const paperId = await makePaperAtStatus('作答区行数卷', 'composing', [q1]);
    render(<ComposePage paperId={paperId} svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector(`[data-testid="score-btn-${q1}"]`)) throw new Error('题行未渲染');
    });

    // 目检 #6：全局作答区控件组已删；fix-5：左栏题级控件退役（入口=右栏操作条）；
    // 0018 目检返工一：摘要行随题行扁平化退役（入口仍在右栏操作条）
    expect(container.querySelector('[data-testid="layout-answer-section"]')).toBeNull();
    expect(container.querySelector('[data-testid="layout-answer-enabled"]')).toBeNull();
    expect(container.querySelector(`[data-testid="answer-space-style-${q1}"]`)).toBeNull();
    expect(container.querySelector(`[data-testid="answer-space-lines-${q1}"]`)).toBeNull();
    expect(container.querySelector(`[data-testid="answer-space-summary-${q1}"]`)).toBeNull();

    // 「添加答题区」→ 3 行空白落库
    const added = () => {
      const layout = ctx.store.paperQuestions.get(paperId)![0].layout;
      return layout?.answerSpace?.style === 'blank' && layout?.answerSpace?.lines === 3;
    };
    await postUntil({ t: 'mf-question-answer-space', questionId: q1, action: 'add' }, added);
    await waitFor(() => {
      if (!added()) throw new Error('添加未落库');
    });

    // 行数步进（action=lines）
    await postUntil({ t: 'mf-question-answer-space', questionId: q1, action: 'lines', lines: 5 }, () => ctx.store.paperQuestions.get(paperId)![0].layout?.answerSpace?.lines === 5);
    await waitFor(() => {
      if (ctx.store.paperQuestions.get(paperId)![0].layout?.answerSpace?.lines !== 5) throw new Error('行数未落库');
    });
    // 样式切换（action=style，行数保留）
    await postUntil({ t: 'mf-question-answer-space', questionId: q1, action: 'style', style: 'lines' }, () => {
      const layout = ctx.store.paperQuestions.get(paperId)![0].layout;
      return layout?.answerSpace?.style === 'lines' && layout?.answerSpace?.lines === 5;
    });
    await waitFor(() => {
      const layout = ctx.store.paperQuestions.get(paperId)![0].layout;
      if (layout?.answerSpace?.style !== 'lines' || layout?.answerSpace?.lines !== 5) throw new Error('样式未落库');
    });
    // 删除（action=remove → style none）
    await postUntil({ t: 'mf-question-answer-space', questionId: q1, action: 'remove' }, () => ctx.store.paperQuestions.get(paperId)![0].layout?.answerSpace?.style === 'none');
    await waitFor(() => {
      if (ctx.store.paperQuestions.get(paperId)![0].layout?.answerSpace?.style !== 'none') throw new Error('删除未落库');
    });
  });
});

// ==================== fix-2 F2-D/E：标题点编信号 + Esc 焦点还原 ====================

describe('fix-2 F2-D/E：InlineTitleEditor openSignal + Esc 焦点还原', () => {
  it('openSignal 递增 → 自动进入编辑态（iframe 标题点编回传的原子行为）', async () => {
    let saved: string | null = null;
    const { createRoot: cr } = await import('react-dom/client');
    void cr;
    const holder = document.createElement('div');
    document.body.appendChild(holder);
    const root = createRoot(holder);
    const renderEditor = (signal: number) => {
      flushSync(() => {
        root.render(
          <InlineTitleEditor
            title="信号标题"
            onSave={(next) => { saved = next; }}
            openSignal={signal}
          />,
        );
      });
    };
    renderEditor(0);
    expect(holder.querySelector('input')).toBeNull();
    renderEditor(1);
    await waitFor(() => {
      if (!holder.querySelector('input')) throw new Error('信号未触发进入编辑态');
    });
    renderEditor(2);
    await waitFor(() => {
      if (!holder.querySelector('input')) throw new Error('持续编辑态丢失');
    });
    // 改值后失焦提交（值未变时 commit 走无变化早退）
    const input = holder.querySelector('input') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    flushSync(() => {
      setter.call(input, '改名信号');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.blur();
    });
    await waitFor(() => {
      if (holder.querySelector('input')) throw new Error('失焦未退出编辑');
    });
    expect(saved).toBe('改名信号');
    root.unmount();
    holder.remove();
  });

  it('排版间 Esc 取消就地编辑 → 回到标题展示态（焦点还原实现随行）', async () => {
    const q1 = await makeQuestion('Esc 焦点题');
    const paperId = await makePaperAtStatus('Esc 焦点卷', 'composing', [q1]);
    render(<ComposePage paperId={paperId} svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="compose-title"]')) throw new Error('标题未渲染');
    });
    clickBtn('[data-testid="compose-title"]');
    await waitFor(() => {
      if (!container.querySelector('[data-testid="compose-title-input"]')) throw new Error('输入框未出现');
    });
    flushSync(() => {
      (container.querySelector('[data-testid="compose-title-input"]') as HTMLInputElement)
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await waitFor(() => {
      if (container.querySelector('[data-testid="compose-title-input"]')) throw new Error('Esc 未退出编辑');
    });
    expect(container.querySelector('[data-testid="compose-title"]')?.textContent).toContain('Esc 焦点卷');
  });
});

// ==================== 0009：卷头多行自定义（行编辑器 + 转多行 + 点编聚焦） ====================

describe('0009 卷头多行自定义：顶部样式区行编辑器', () => {
  // jsdom 无 scrollIntoView 实现（点编聚焦链路调用处会 TypeError）——本域测试打桩，测后还原原型缺失态
  beforeEach(() => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: () => {} });
  });
  afterEach(() => {
    Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
  });

  /** 预热：进排版间并等顶部样式区就绪 */
  async function openHeaderSection(title = '卷头多行卷'): Promise<string> {
    const q1 = await makeQuestion('卷头行题');
    const paperId = await makePaperAtStatus(title, 'composing', [q1]);
    render(<ComposePage paperId={paperId} svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="layout-header-section"]')) throw new Error('顶部样式区未渲染');
    });
    return paperId;
  }

  async function toLinesMode() {
    clickBtn('[data-testid="header-to-lines-btn"]');
    await waitFor(() => {
      if (!container.querySelector('[data-testid="header-line-row-0"]')) throw new Error('行编辑器未出现');
    });
  }

  const valueOf = (testid: string): string =>
    (container.querySelector(`[data-testid="${testid}"]`) as HTMLInputElement | HTMLSelectElement | null)?.value ?? '';

  it('转为多行自定义：初始化 = 卷标题 18pt 居中加粗一行；旧单行输入框退役；预览同步多行卷头', async () => {
    await openHeaderSection('卷头多行卷');
    expect(container.querySelector('[data-testid="layout-header-title"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="header-line-row-0"]')).toBeNull();

    await toLinesMode();
    expect(container.querySelector('[data-testid="layout-header-title"]')).toBeNull();
    expect(valueOf('header-line-text-0')).toBe('卷头多行卷'); // title ?? 卷标题
    expect(valueOf('header-line-size-0')).toBe('18');
    expect(valueOf('header-line-align-0')).toBe('center');
    expect((container.querySelector('[data-testid="header-line-bold-0"]') as HTMLInputElement).checked).toBe(true);

    await waitFor(() => {
      if (!srcdocOf().includes('<div class="paper-header-line"')) throw new Error('预览未出多行卷头行');
    });
    expect(srcdocOf()).toContain(
      '<div class="paper-header-line" style="font-size:18pt;text-align:center;font-weight:bold">卷头多行卷</div>'
    );
    expect(srcdocOf()).not.toContain('<h1 class="paper-title">'); // exam 旧观感行被多行模式取代
  });

  it('行编辑回调：改文本/字号/对齐/加粗即时进预览；加行 = 缺省 11pt 居中常规；删行同步', async () => {
    await openHeaderSection();
    await toLinesMode();

    setInput('[data-testid="header-line-text-0"]', '期中测试卷');
    setNumberAndBlur('[data-testid="header-line-size-0"]', '20');
    setSelect('[data-testid="header-line-align-0"]', 'left');
    flushSync(() => (container.querySelector('[data-testid="header-line-bold-0"]') as HTMLInputElement).click());

    await waitFor(() => {
      if (!srcdocOf().includes(
        '<div class="paper-header-line" style="font-size:20pt;text-align:left;font-weight:normal">期中测试卷</div>'
      )) throw new Error('行 0 改值未即时反映到预览');
    });

    clickBtn('[data-testid="header-line-add-btn"]');
    await waitFor(() => {
      if (!container.querySelector('[data-testid="header-line-row-1"]')) throw new Error('添加行未出现');
    });
    expect(valueOf('header-line-size-1')).toBe('11');   // 非首行缺省字号
    expect((container.querySelector('[data-testid="header-line-bold-1"]') as HTMLInputElement).checked).toBe(false);
    setInput('[data-testid="header-line-text-1"]', '总分：100分　考试时间：90分钟');
    await waitFor(() => {
      if (!srcdocOf().includes(
        '<div class="paper-header-line" style="font-size:11pt;text-align:center;font-weight:normal">总分：100分　考试时间：90分钟</div>'
      )) throw new Error('行 1 未即时反映到预览');
    });

    clickBtn('[data-testid="header-line-remove-1"]');
    await waitFor(() => {
      if (container.querySelector('[data-testid="header-line-row-1"]')) throw new Error('删行未生效');
    });
    await waitFor(() => {
      if (srcdocOf().includes('总分：100分')) throw new Error('预览未同步删行');
    });
  });

  it('定稿落库：行编辑器内容写入 layoutConfig.header.lines（多行模式持久化）', async () => {
    const paperId = await openHeaderSection('落库卷头卷');
    await toLinesMode();
    setInput('[data-testid="header-line-text-0"]', '落库标题行');
    clickBtn('[data-testid="header-line-add-btn"]');
    await waitFor(() => {
      if (!container.querySelector('[data-testid="header-line-row-1"]')) throw new Error('添加行未出现');
    });
    setInput('[data-testid="header-line-text-1"]', '落库信息行');

    clickBtn('[data-testid="compose-finalize-btn"]');
    await waitFor(() => {
      expect(window.location.hash).toBe('#/basket');
    });
    const lines = ctx.store.papers.get(paperId)?.layoutConfig?.header?.lines;
    expect(lines?.[0]).toEqual({ text: '落库标题行', sizePt: 18, align: 'center', bold: true });
    expect(lines?.[1]).toEqual({ text: '落库信息行' });
  });

  it('预览点卷头行 → 左栏聚焦行编辑器首行（协议不变，mf-title-click 既有链路）', async () => {
    await openHeaderSection();
    await toLinesMode();

    await waitFor(() => {
      if (!srcdocOf().includes('mf-seg')) throw new Error('预览未就绪');
    });
    await postFromFrame({ t: 'mf-title-click' });
    await waitFor(() => {
      if (document.activeElement !== container.querySelector('[data-testid="header-line-text-0"]')) {
        throw new Error('焦点未落到卷头首行输入框');
      }
    });
  });
});

// ==================== 0013 选项版式：校验器 + 卷级默认档 UI ====================

describe('0013 校验器：optionsLayout 白名单', () => {
  it('合法值放行（三态）；非法值剔字段回缺省；未知字段仍丢弃', () => {
    expect(validateLayoutConfig({ version: 2, optionsLayout: 'single-line' }).optionsLayout).toBe('single-line');
    expect(validateLayoutConfig({ version: 2, optionsLayout: 'two-lines' }).optionsLayout).toBe('two-lines');
    expect(validateLayoutConfig({ version: 2, optionsLayout: 'auto' }).optionsLayout).toBe('auto');

    const cleaned = validateLayoutConfig(
      JSON.parse('{"version":2,"optionsLayout":"bogus","mysteryField":true}') as object
    );
    expect(cleaned.optionsLayout).toBeUndefined();
    expect('mysteryField' in cleaned).toBe(false);

    // 缺省不产生键（存量预设零漂移）
    expect('optionsLayout' in validateLayoutConfig({ version: 2 })).toBe(false);
  });
});

describe('0013 卷级默认档 fieldset（选项版式三态下拉）', () => {
  it('三态回调写控件态 → 预览类名同步（single-line/ol-single、two-lines/ol-two、auto 无类）', async () => {
    const q = await ctx.bank.createQuestion({
      subject: '物理',
      sourceType: 'local',
      sourceDetail: { origin: 'test' },
      content:
        '<div class="question">下列说法正确的是？' +
        '<div class="options"><span class="option">A. 甲</span><span class="option">B. 乙</span>' +
        '<span class="option">C. 丙</span><span class="option">D. 丁</span></div></div>',
      images: [],
    });
    const paperId = await makePaperAtStatus('选项版式卷', 'composing', [q.id]);
    render(<ComposePage paperId={paperId} svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="layout-options-layout"]')) throw new Error('选项版式下拉未渲染');
    });
    expect((container.querySelector('[data-testid="layout-options-layout"]') as HTMLSelectElement).value).toBe('auto');

    await waitFor(() => {
      if (!srcdocOf().includes('class="question-item"')) throw new Error('预览未就绪');
    });
    setSelect('[data-testid="layout-options-layout"]', 'single-line');
    await waitFor(() => {
      if (!srcdocOf().includes('class="question-item ol-single"')) throw new Error('单行档未反映到预览');
    });
    // 注意：paper.css 内联进 head 也含 ol-two 字样——负断言锚定类属性而非裸子串
    expect(srcdocOf()).not.toContain('class="question-item ol-two"');

    setSelect('[data-testid="layout-options-layout"]', 'two-lines');
    await waitFor(() => {
      if (!srcdocOf().includes('class="question-item ol-two"')) throw new Error('两行档未反映到预览');
    });
    expect(srcdocOf()).not.toContain('class="question-item ol-single"');

    setSelect('[data-testid="layout-options-layout"]', 'auto');
    await waitFor(() => {
      const doc = srcdocOf();
      if (doc.includes('class="question-item ol-')) throw new Error('回自动档仍有类名残留');
      if (!doc.includes('class="question-item"')) throw new Error('预览丢失');
    });
  });
});

// ==================== 0018 P2：排版左栏紧凑 + 预设操作归堆 ====================

describe('0018 排版左栏紧凑 + 预设操作归堆', () => {
  /** 渲染出左栏控件区的公共前置 */
  async function renderControls(title: string) {
    const q1 = await makeQuestion(title + '题');
    const paperId = await makePaperAtStatus(title, 'composing', [q1]);
    render(<ComposePage paperId={paperId} svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="layout-controls"]')) throw new Error('控件区未渲染');
    });
    return paperId;
  }

  it('9 个 fieldset 全在场且排距 class 化（ctl-section 上类名、内联 0.65rem 退役）', async () => {
    await renderControls('左栏排距卷');

    const sectionIds = [
      'preset-section', 'layout-page-section', 'layout-type-section', 'layout-header-section',
      'layout-visibility-section', 'layout-options-section', 'layout-figure-section',
      'layout-logo-section', 'layout-actions-section',
    ];
    for (const id of sectionIds) {
      const fs = container.querySelector(`[data-testid="${id}"]`) as HTMLElement;
      expect(fs, `${id} 在场`).not.toBeNull();
      expect(fs.className, `${id} 挂 ctl-section`).toContain('ctl-section');
      expect(fs.style.marginBottom, `${id} 内联排距退役`).toBe('');
    }
  });

  it('预设四操作归堆一处（layout-actions-section 内）且全部可点', async () => {
    await renderControls('预设归堆卷');

    const actionsSection = container.querySelector('[data-testid="layout-actions-section"]')!;
    for (const id of ['preset-manage-btn', 'preset-save-btn', 'preset-import-btn', 'preset-export-btn']) {
      const btn = actionsSection.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement;
      expect(btn, `${id} 归入版式操作区`).not.toBeNull();
      expect(btn.className, `${id} 紧凑档`).toContain('btn-sm');
    }
    // 顶部 preset-section 不再散落预设操作按钮（归堆后此处只有下拉）
    const presetSection = container.querySelector('[data-testid="preset-section"]')!;
    expect(presetSection.querySelector('[data-testid="preset-manage-btn"]')).toBeNull();

    // 可点性实证：存预设弹层、预设管理弹层能被打开
    clickBtn('[data-testid="preset-save-btn"]');
    expect(container.querySelector('[data-testid="preset-save-input"]')).not.toBeNull();
    (container.querySelector('.modal-close') as HTMLButtonElement).click();
    clickBtn('[data-testid="preset-manage-btn"]');
    expect(container.querySelector('.modal-title')!.textContent).toBe('版式预设管理');
  });
});

// ==================== 0018 目检返工一：左栏折叠分组 + 排版页全高锁定 + 试题顺序扁平行 ====================
// 用户目检拍板（2026-09-15）：左栏配置分类折叠；左栏栏内滚动、排版页整页不滚；
// 试题顺序行扁平单行、行内只留「设置分值 + 移除」（图片设置/插图/作答区摘要入口随之退役）。

describe('0018 目检返工一：左栏折叠分组 + 排版页全高锁定 + 试题顺序扁平行', () => {
  const themeCss = () => readFileSync(resolve(process.cwd(), 'src/app/theme.css'), 'utf-8');

  async function renderComposing(title: string) {
    const q1 = await makeQuestion(title + '题');
    const paperId = await makePaperAtStatus(title, 'composing', [q1]);
    render(<ComposePage paperId={paperId} svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="layout-controls"]')) throw new Error('控件区未渲染');
    });
    return { q1, paperId };
  }

  it('左栏 9 分区可折叠：缺省全折叠（0063 返工①用户拍板 2026-09-24，原默认 3 开退役），点头部切换，内容常挂载（hidden 隐藏非卸载）', async () => {
    await renderComposing('折叠分组卷');

    const allSections = [
      'preset-section', 'layout-page-section', 'layout-type-section', 'layout-header-section',
      'layout-visibility-section', 'layout-options-section', 'layout-figure-section',
      'layout-logo-section', 'layout-actions-section',
    ];
    for (const id of allSections) {
      const toggle = container.querySelector(`[data-testid="ctl-toggle-${id}"]`) as HTMLElement;
      expect(toggle, `${id} 折叠头在场`).not.toBeNull();
      const body = container.querySelector(`[data-testid="${id}"] > .ctl-body`) as HTMLElement;
      expect(body, `${id} 折叠体在场`).not.toBeNull();
      // 缺省全折叠（0063 返工①）
      expect(toggle.getAttribute('aria-expanded'), `${id} 缺省态`).toBe('false');
      expect(body.hidden, `${id} 缺省可见性`).toBe(true);
    }

    // 折叠区内容常挂载：Logo 区合着，其控件仍可在 DOM 查到（hidden 而非卸载）
    expect(container.querySelector('[data-testid="logo-add-demo-input"]')).not.toBeNull();

    // 点头部切换：合 → 开 → 合
    const logoToggle = container.querySelector('[data-testid="ctl-toggle-layout-logo-section"]') as HTMLButtonElement;
    flushSync(() => logoToggle.click());
    expect(logoToggle.getAttribute('aria-expanded')).toBe('true');
    expect((container.querySelector('[data-testid="layout-logo-section"] > .ctl-body') as HTMLElement).hidden).toBe(false);
    flushSync(() => logoToggle.click());
    expect(logoToggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('排版页全高锁定：根挂 compose-page、左右栏各自内滚、整页不随内容滚（DOM + theme.css 源级）', async () => {
    await renderComposing('全高锁定卷');

    const root = container.querySelector('.compose-page');
    expect(root, '排版页根挂 .compose-page').not.toBeNull();
    expect(container.querySelector('.compose-page .compose-left-col'), '左栏滚动容器').not.toBeNull();
    expect(container.querySelector('.compose-page .compose-preview-col'), '右栏预览列').not.toBeNull();

    const css = themeCss();
    expect(css).toMatch(/\.compose-page\s*\{[^}]*height:\s*calc\(100vh\s*-\s*62px\)/);
    expect(css).toMatch(/\.compose-page\s*>\s*\*\s*\{[^}]*flex:\s*0\s+0\s+auto/);
    expect(css).toMatch(/\.compose-page\s*>\s*\.compose-layout\s*\{[^}]*flex:\s*1/);
    expect(css).toMatch(/\.compose-page\s*>\s*\.compose-layout\s*\{[^}]*align-items:\s*stretch/);
    expect(css).toMatch(/\.compose-page\s*>\s*\.compose-layout\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\)/);
    expect(css).toMatch(/\.compose-page\s+\.compose-left-col\s*\{[^}]*overflow-y:\s*auto/);
    expect(css).toMatch(/\.compose-page\s+\.compose-preview-col\s*\{[^}]*min-height:\s*0/);
    expect(css).toMatch(/\.preview-frame-root\s*\{[^}]*flex:\s*1/);
    expect(css).toMatch(/\.preview-frame-root\s*\{[^}]*min-height:\s*0/);
  });

  it('试题顺序扁平单行：题干单行截断，行内三按钮（图片/分值/移除）；行内插图与作答区摘要退役', async () => {
    const { q1 } = await renderComposing('扁平行卷');

    const li = container.querySelector('[data-testid="compose-question-list"] li') as HTMLElement;
    expect(li, '题行在场').not.toBeNull();
    const orderRow = li.querySelector('.compose-order-row') as HTMLElement;
    expect(orderRow, '题行内层为扁平行容器').not.toBeNull();
    expect(orderRow.style.display).toBe('flex');

    const stem = container.querySelector(`[data-testid="compose-stem-${q1}"]`) as HTMLElement;
    expect(stem).not.toBeNull();
    expect(stem.style.webkitLineClamp, '题干单行截断（line-clamp 1）').toBe('1');

    // 行内按钮：图片 / 分值 / 移除 在（0018 目检返工二收敛为三按钮）；行内插图与作答区摘要退役
    expect(container.querySelector(`[data-testid="figure-settings-btn-${q1}"]`)).not.toBeNull();
    expect(container.querySelector(`[data-testid="score-btn-${q1}"]`)).not.toBeNull();
    expect(container.querySelector(`[data-testid="remove-btn-${q1}"]`)).not.toBeNull();
    expect(container.querySelector(`[data-testid="figure-insert-btn-${q1}"]`)).toBeNull();
    expect(container.querySelector(`[data-testid="answer-space-summary-${q1}"]`)).toBeNull();
  });
});

// ==================== 0018 目检返工二：试题顺序区打磨（分值并入按钮 / 图片按钮 / 加题退役 / 左对齐） ====================

describe('0018 目检返工二：分值并入按钮 + 图片按钮 + 加题入口退役', () => {
  it('分值并入按钮：未设置显「设置分值」、已设置显「n分」；小数可落库、负数报错不落库', async () => {
    const q1 = await makeQuestion('分值按钮题');
    const paper = await ctx.ext.paper.createPaperEx('分值按钮卷');
    await ctx.ext.paper.updatePaperStatus(paper.id, 'composing');
    await ctx.bank.addQuestion(paper.id, q1); // 不设分值 → undefined（显「设置分值」）
    const paperId = paper.id;
    render(<ComposePage paperId={paperId} svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector(`[data-testid="score-btn-${q1}"]`)) throw new Error('题行未渲染');
    });
    const btn = () => container.querySelector(`[data-testid="score-btn-${q1}"]`) as HTMLButtonElement;
    expect(btn().textContent).toBe('设置分值');
    // 独立「分值：」文本退役（并入按钮文案）
    expect(container.querySelector('[data-testid="compose-question-list"]')!.textContent).not.toContain('分值：');

    // 小数可落库
    clickBtn(`[data-testid="score-btn-${q1}"]`);
    setInput(`[data-testid="score-input-${q1}"]`, '12.5');
    flushSync(() => (container.querySelector(`[data-testid="score-input-${q1}"]`) as HTMLInputElement).blur());
    await waitFor(() => {
      if (ctx.store.paperQuestions.get(paperId)![0].score !== 12.5) throw new Error('小数分值未落库');
    });
    await waitFor(() => {
      if (btn().textContent !== '12.5分') throw new Error('按钮文案未更新为 n 分');
    });

    // 负数报错不落库
    clickBtn(`[data-testid="score-btn-${q1}"]`);
    setInput(`[data-testid="score-input-${q1}"]`, '-3');
    flushSync(() => (container.querySelector(`[data-testid="score-input-${q1}"]`) as HTMLInputElement).blur());
    await waitFor(() => {
      const banner = container.querySelector('[data-testid="page-message"]');
      if (!banner || !banner.textContent?.includes('非负整数或小数')) throw new Error('负数未报错');
    });
    expect(ctx.store.paperQuestions.get(paperId)![0].score).toBe(12.5);
  });

  it('图片按钮：开图片设置弹层（列表在）→ 保存落库；加题三入口退役、仅留插入大标题', async () => {
    const qid = await makeFigureQuestion('带图题');
    const paperId = await makePaperAtStatus('图片按钮卷', 'composing', [qid]);
    render(<ComposePage paperId={paperId} svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector(`[data-testid="figure-settings-btn-${qid}"]`)) throw new Error('图片按钮未渲染');
    });
    clickBtn(`[data-testid="figure-settings-btn-${qid}"]`);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="figure-row-0"]')) throw new Error('弹层图行未渲染');
    });
    expect(container.querySelector('[data-testid="figure-row-0"]')!.textContent).toContain('capture/a.png');
    clickBtn('[data-testid="figure-save-btn"]');
    await waitFor(() => {
      const figures = ctx.store.paperQuestions.get(paperId)![0].layout?.figures ?? [];
      if (figures.length !== 1) throw new Error('图覆盖未落库');
    });

    // 加题三入口退役（加题归试题篮）；插入大标题保留
    expect(container.querySelector('[data-testid="compose-pick-btn"]')).toBeNull();
    expect(container.querySelector('[data-testid="compose-new-question-btn"]')).toBeNull();
    expect(container.querySelector('[data-testid="compose-capture-btn"]')).toBeNull();
    expect(container.querySelector('[data-testid="compose-insert-text-block-btn"]')).not.toBeNull();
  });

  it('弹层内插入图片：pickLogoImage → 条目追加 → 保存落库含新图', async () => {
    const pickLogoImage = vi.fn().mockResolvedValue({ relPath: 'logos/inserted.png', width: 200 });
    (window as unknown as { __mofangFile?: unknown }).__mofangFile = { pickLogoImage };
    try {
      const qid = await makeFigureQuestion('插图弹层题');
      const paperId = await makePaperAtStatus('插图弹层卷', 'composing', [qid]);
      render(<ComposePage paperId={paperId} svc={svc} />);
      await waitFor(() => {
        if (!container.querySelector(`[data-testid="figure-settings-btn-${qid}"]`)) throw new Error('图片按钮未渲染');
      });
      clickBtn(`[data-testid="figure-settings-btn-${qid}"]`);
      await waitFor(() => {
        if (!container.querySelector('[data-testid="figure-insert-btn"]')) throw new Error('弹层插入按钮未渲染');
      });
      clickBtn('[data-testid="figure-insert-btn"]');
      await waitFor(() => {
        if (!container.querySelector('[data-testid="figure-row-1"]')) throw new Error('插入条目未出现');
      });
      expect(container.querySelector('[data-testid="figure-row-1"]')!.textContent).toContain('logos/inserted.png');
      clickBtn('[data-testid="figure-save-btn"]');
      await waitFor(() => {
        const figures = ctx.store.paperQuestions.get(paperId)![0].layout?.figures ?? [];
        if (!figures.some((f) => f.assetId === 'logos/inserted.png')) throw new Error('插入图未落库');
      });
      expect(pickLogoImage).toHaveBeenCalled();
    } finally {
      delete (window as unknown as { __mofangFile?: unknown }).__mofangFile;
    }
  });

  it('试题框左对齐：列表去缩进（padding 0）+ 行容器防溢出（minWidth 0 / overflow hidden）', async () => {
    const q1 = await makeQuestion('左对齐题');
    const paperId = await makePaperAtStatus('左对齐卷', 'composing', [q1]);
    render(<ComposePage paperId={paperId} svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="compose-question-list"]')) throw new Error('列表未渲染');
    });
    const ol = container.querySelector('[data-testid="compose-question-list"]') as HTMLElement;
    expect(ol.style.padding).toBe('0px');
    const row = ol.querySelector('.compose-order-row') as HTMLElement;
    expect(row.style.overflow).toBe('hidden');
    expect(row.style.minWidth).toBe('0px');
  });
});

// ==================== 0018 目检返工三：0 分照常显示 + 空白确认回「未设置」 ====================

describe('0018 目检返工三：0 分照常显示 + 空白确认回归未设置', () => {
  it('分值 0 → 按钮「0分」+ 预览题头渲染 (0分)（引擎不再吞 0）', async () => {
    const q1 = await makeQuestion('零分题');
    const paper = await ctx.ext.paper.createPaperEx('零分卷');
    await ctx.ext.paper.updatePaperStatus(paper.id, 'composing');
    await ctx.bank.addQuestion(paper.id, q1, 0);
    render(<ComposePage paperId={paper.id} svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector(`[data-testid="score-btn-${q1}"]`)) throw new Error('题行未渲染');
    });
    expect((container.querySelector(`[data-testid="score-btn-${q1}"]`) as HTMLButtonElement).textContent).toBe('0分');
    await waitFor(() => {
      if (!srcdocOf().includes('(0分)')) throw new Error('预览未渲染 (0分)');
    });
  });

  it('空白确认 → 清除分值回「未设置」（store 回 undefined，按钮恢复「设置分值」）', async () => {
    const q1 = await makeQuestion('空白分值题');
    const paper = await ctx.ext.paper.createPaperEx('空白分值卷');
    await ctx.ext.paper.updatePaperStatus(paper.id, 'composing');
    await ctx.bank.addQuestion(paper.id, q1);
    render(<ComposePage paperId={paper.id} svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector(`[data-testid="score-btn-${q1}"]`)) throw new Error('题行未渲染');
    });
    clickBtn(`[data-testid="score-btn-${q1}"]`);
    // 不输入，直接回车确认 → 清除分值
    flushSync(() => {
      (container.querySelector(`[data-testid="score-input-${q1}"]`) as HTMLInputElement)
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await waitFor(() => {
      if (ctx.store.paperQuestions.get(paper.id)![0].score !== undefined) throw new Error('空白未清除分值');
    });
    await waitFor(() => {
      if ((container.querySelector(`[data-testid="score-btn-${q1}"]`) as HTMLButtonElement).textContent !== '设置分值') {
        throw new Error('按钮未恢复「设置分值」');
      }
    });
  });
});

// ==================== 0018 目检返工三补：未设置 ≠ 0（预览端区分 NULL 与 0） ====================

describe('0018 目检返工三补：未设置分值预览不渲染题头（NULL 与 0 区分）', () => {
  it('未设置题不出分值题头；已设题照常（20分）', async () => {
    const q1 = await makeQuestion('未设分值题');
    const q2 = await makeQuestion('二十分题');
    const paper = await ctx.ext.paper.createPaperEx('分值区分卷');
    await ctx.ext.paper.updatePaperStatus(paper.id, 'composing');
    await ctx.bank.addQuestion(paper.id, q1);      // 未设置
    await ctx.bank.addQuestion(paper.id, q2, 20);  // 20 分
    render(<ComposePage paperId={paper.id} svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector(`[data-testid="score-btn-${q1}"]`)) throw new Error('题行未渲染');
    });
    await waitFor(() => {
      if (!srcdocOf().includes('(20分)')) throw new Error('预览未渲染 (20分)');
    });
    // 未设置（NULL）≠ 0：不渲染分值题头
    expect(srcdocOf()).not.toContain('(0分)');
  });
});

// ==================== 0052 / R-051①：题行操作不得重置左栏配置 ====================
// 根因（0052 任务书 §零.F2）：左栏 layout 是「本地 state，不落库——落库在定稿与存预设」，
// 但 saveTextBlock / handleRemoveQuestion / handleSetScoreSubmit / saveFigureLayouts 四条题行操作
// 结束后无条件 loadPaper()，而 loadPaper 里 setLayout(bundle.paper.layoutConfig ?? {version:2})
// 用 DB 快照**整体覆盖**内存态 → 此前所有未定稿的左栏配置被打回旧值（对照：拖拽排序不调
// loadPaper 所以不丢——反证触发条件）。

describe('0052 / R-051①：题行操作后左栏配置不丢（loadPaper 不得覆盖未定稿控件态）', () => {
  /** 改左栏配置（字号 14）→ 控件态与预览双确认已生效 */
  async function tweakLayout() {
    setNumberAndBlur('[data-testid="layout-font-size"]', '14');
    await waitFor(() => {
      const el = container.querySelector('[data-testid="layout-font-size"]') as HTMLInputElement | null;
      if (!el || el.value !== '14') throw new Error('字号控件未提交');
    });
    await waitFor(() => {
      if (!srcdocOf().includes('--mf-font-size: 14pt')) throw new Error('预览未反映字号 14');
    });
  }

  /**
   * 等 loadPaper 异步链 + 预览防抖（300ms）落定再断言——否则会在**陈旧窗口**里假通过
   * （题行操作后立即读：控件态/预览都还是操作前的值，重置随后才落地）。
   * 实证：不加等待时四条用例里只有「插入大标题」抓到回退（弹层交互给了额外渲染轮次）。
   */
  async function settleAfterReload() {
    await new Promise((resolve) => setTimeout(resolve, 600));
  }

  /** 断言配置仍为改后值：控件态 + 预览 + 库上三口径（0064/R-061 授权改写，见下） */
  async function expectLayoutKept(paperId: string, after: string) {
    await waitFor(() => {
      const el = container.querySelector('[data-testid="layout-font-size"]') as HTMLInputElement | null;
      if (!el || el.value !== '14') throw new Error(`${after}后控件态回退为 ${JSON.stringify(el?.value)}`);
    });
    await waitFor(() => {
      if (!srcdocOf().includes('--mf-font-size: 14pt')) throw new Error(`${after}后预览回退`);
    });
    // 0064（R-061）授权改写（任务书 §一.2）：旧断言 =「未定稿不写库」toBeUndefined()。
    // 新前提：左栏卷级版式防抖 400ms 自动落库（用户口径：中途离开再去排版设置还在）——
    // 等强改写 = 库上读回「当前控件态等值」（三条用例的语义从「内存态没被打回」升级为
    // 「内存态与库上态都没被打回」，咬合力只增不减）。
    await waitFor(() => {
      const stored = ctx.store.papers.get(paperId)?.layoutConfig;
      if (!stored || stored.fontSize !== 14) throw new Error(`${after}后库上版式回退为 ${JSON.stringify(stored)}`);
    });
  }

  async function mountCompose(paperId: string, readySelector: string) {
    render(<ComposePage paperId={paperId} svc={svc} />);
    await waitFor(() => {
      if (!container.querySelector(readySelector)) throw new Error('排版页未就绪');
    });
  }

  it('插入大标题（saveTextBlock → loadPaper）后配置保持', async () => {
    const q1 = await makeQuestion('大标题前置题');
    const paperId = await makePaperAtStatus('配置保持·大标题卷', 'composing', [q1]);
    await mountCompose(paperId, '[data-testid="compose-insert-text-block-btn"]');
    await tweakLayout();

    clickBtn('[data-testid="compose-insert-text-block-btn"]');
    await waitFor(() => {
      if (!container.querySelector('[data-testid="text-block-input"]')) throw new Error('大标题弹层未开');
    });
    setInput('[data-testid="text-block-input"]', '一、单项选择题');
    clickBtn('[data-testid="text-block-save"]');
    await waitFor(() => {
      const list = container.querySelector('[data-testid="compose-question-list"]');
      if (!list || !list.textContent?.includes('一、单项选择题')) throw new Error('大标题未插入');
    });
    await settleAfterReload();

    await expectLayoutKept(paperId, '插入大标题');
  });

  it('移除题（handleRemoveQuestion → loadPaper）后配置保持', async () => {
    const q1 = await makeQuestion('待移除题');
    const q2 = await makeQuestion('保留题');
    const paperId = await makePaperAtStatus('配置保持·移除卷', 'composing', [q1, q2]);
    await mountCompose(paperId, `[data-testid="remove-btn-${q1}"]`);
    await tweakLayout();

    clickBtn(`[data-testid="remove-btn-${q1}"]`);
    await waitFor(() => {
      if (ctx.store.paperQuestions.get(paperId)?.some((r) => r.questionId === q1) !== false) {
        throw new Error('题未移除');
      }
    });
    await settleAfterReload();

    await expectLayoutKept(paperId, '移除题');
  });

  it('设分（handleSetScoreSubmit → loadPaper）后配置保持', async () => {
    const q1 = await makeQuestion('设分题');
    const paperId = await makePaperAtStatus('配置保持·设分卷', 'composing', [q1]);
    await mountCompose(paperId, `[data-testid="score-btn-${q1}"]`);
    await tweakLayout();

    clickBtn(`[data-testid="score-btn-${q1}"]`);
    setInput(`[data-testid="score-input-${q1}"]`, '12');
    flushSync(() => (container.querySelector(`[data-testid="score-input-${q1}"]`) as HTMLInputElement).blur());
    await waitFor(() => {
      if (ctx.store.paperQuestions.get(paperId)![0].score !== 12) throw new Error('分值未落库');
    });
    await settleAfterReload();

    await expectLayoutKept(paperId, '设分');
  });

  it('图片设置保存（saveFigureLayouts → loadPaper）后配置保持', async () => {
    const qid = await makeFigureQuestion('图片设置题');
    const paperId = await makePaperAtStatus('配置保持·图片卷', 'composing', [qid]);
    await mountCompose(paperId, `[data-testid="figure-settings-btn-${qid}"]`);
    await tweakLayout();

    clickBtn(`[data-testid="figure-settings-btn-${qid}"]`);
    await waitFor(() => {
      if (!container.querySelector('[data-testid="figure-save-btn"]')) throw new Error('图片弹层未开');
    });
    clickBtn('[data-testid="figure-save-btn"]');
    await waitFor(() => {
      const figures = ctx.store.paperQuestions.get(paperId)![0].layout?.figures ?? [];
      if (figures.length !== 1) throw new Error('图覆盖未落库');
    });
    await settleAfterReload();

    await expectLayoutKept(paperId, '图片设置保存');
  });

  // 反向守卫：resetLayout 守卫只把「重置」收窄到挂载——挂载仍须从库上版式读出
  // （用户目检清单「定稿后配置正常落库、重进卷配置正确读出」；若把挂载路径也改成不重置，本用例即红）
  it('定稿 → 重进卷：控件态与预览从库上版式读出（挂载读写不因本修失效）', async () => {
    const q1 = await makeQuestion('重进卷题');
    const paperId = await makePaperAtStatus('重进卷', 'composing', [q1]);
    await mountCompose(paperId, '[data-testid="compose-finalize-btn"]');

    setNumberAndBlur('[data-testid="layout-font-size"]', '14');
    setSelect('[data-testid="layout-page-size"]', 'A3');
    await waitFor(() => {
      if (!srcdocOf().includes('--mf-font-size: 14pt')) throw new Error('预览未反映字号 14');
    });
    clickBtn('[data-testid="compose-finalize-btn"]');
    await waitFor(() => {
      expect(window.location.hash).toBe('#/basket');
    });
    // 定稿落库（Phase 5 第①步）
    expect(ctx.store.papers.get(paperId)?.layoutConfig).toMatchObject({ fontSize: 14, pageSize: 'A3' });

    // 重进卷 = 新实例重新挂载：控件态与预览都必须用库上版式
    await mountCompose(paperId, '[data-testid="layout-font-size"]');
    await waitFor(() => {
      const el = container.querySelector('[data-testid="layout-font-size"]') as HTMLInputElement | null;
      if (!el || el.value !== '14') throw new Error(`重进卷字号未从库读出（${JSON.stringify(el?.value)}）`);
    });
    expect((container.querySelector('[data-testid="layout-page-size"]') as HTMLSelectElement).value).toBe('A3');
    await waitFor(() => {
      if (!srcdocOf().includes('--mf-font-size: 14pt')) throw new Error('重进卷预览未用库上版式');
    });
  });
});
