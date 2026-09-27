// 0070（R-052）：多帧合并录题——「先拼后识」。
//
// 本文件用**受控画布垫片**让真裁图（workbench/crop.ts）与真拼接器（splitting/page-images.createStitcher）
// 在 jsdom 里真跑：画布不产像素，只把「画布尺寸 + 绘制指令序列」编进 data URL；断言因此能逐条核对
// 「哪张图被画在哪、画布多大、页缝在哪、回填从哪张图裁」——这正是多帧拼接链的契约面
// （逐像素证据在 probe-0070 侧，见该探针头注）。
//
// 覆盖：多帧跨页卡（一次调用 / 送图=两帧纵向拼接 / 画布取最宽 / 页缝 12px / 回填裁拼接图 / 首帧溯源）
//      ∥ 单帧卡逐字节回归 ∥ 三帧跨页 ∥ 某帧页图未就绪 → 明确失败且零模型调用。
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { act } from 'react';

import type { MofangAiBridge, MofangRecogBridge } from '../../src/shared/contracts/bridge.js';
import type { BankExtServices, BankService, DictEntry, Question } from '../../src/shared/contracts/bank-types.js';
import type { AiChatMessage, AiInvokeResult } from '../../src/shared/contracts/ai-types.js';
import type { RecogRun, RecogRunDetail } from '../../src/shared/contracts/recog-run-types.js';
import type { WorkbenchCard, WorkbenchFrame, WorkbenchState } from '../../src/shared/contracts/onestep-types.js';
import type { PageImageLike } from '../../src/app/workbench/crop.js';
import { createMockExtServices } from '../../src/bank/mock/mock-ext.js';
import { MockBankStore } from '../../src/bank/mock/mock-store.js';
import { MockBankService } from '../../src/bank/mock/mock-bank.js';
import { makeFrame, newPendingCard } from '../../src/recog/onestep/workbench.js';

const NOW = '2026-09-25T10:00:00.000Z';
const RUN_ID = 'run-0070-1';

// ==================== 受控画布垫片 ====================

interface DrawOp { kind: 'draw'; src: string; sx: number; sy: number; sw: number; sh: number; dx: number; dy: number; dw: number; dh: number }
interface FillOp { kind: 'fill'; color: string; x: number; y: number; w: number; h: number }
type Op = DrawOp | FillOp;
interface FakePayload { id: number; w: number; h: number; ops: Op[] }

let canvasSeq = 0;
/** id → 画布产物（垫片里同时充当位图登记簿：三参 drawImage 要取源图自身尺寸） */
const payloads = new Map<number, FakePayload>();

function encodePayload(payload: FakePayload): string {
  payloads.set(payload.id, payload);
  return `data:image/png;base64,${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')}`;
}

function decodePayload(dataUrl: string): FakePayload {
  const comma = dataUrl.indexOf(',');
  return JSON.parse(Buffer.from(dataUrl.slice(comma + 1), 'base64').toString('utf8')) as FakePayload;
}

class FakeCanvas {
  readonly id = ++canvasSeq;
  readonly ops: Op[] = [];
  constructor(public width = 0, public height = 0) {}
  getContext(): FakeCtx { return new FakeCtx(this); }
  toDataURL(): string {
    return encodePayload({ id: this.id, w: this.width, h: this.height, ops: this.ops });
  }
}

class FakeCtx {
  fillStyle = '#000000';
  constructor(private readonly canvas: FakeCanvas) {}
  drawImage(src: unknown, ...args: number[]): void {
    const label = (src as { __label?: string }).__label ?? 'unknown';
    // 应用真代码两种形态都用：拼接器三参（dx,dy，尺寸取源图自身）、裁图九参（sx,sy,sw,sh,dx,dy,dw,dh）
    const source = payloads.get(Number(label.replace('canvas#', '')));
    const op: DrawOp = args.length === 2
      ? { kind: 'draw', src: label, sx: 0, sy: 0, sw: source?.w ?? -1, sh: source?.h ?? -1, dx: args[0]!, dy: args[1]!, dw: source?.w ?? -1, dh: source?.h ?? -1 }
      : { kind: 'draw', src: label, sx: args[0]!, sy: args[1]!, sw: args[2]!, sh: args[3]!, dx: args[4]!, dy: args[5]!, dw: args[6]!, dh: args[7]! };
    this.canvas.ops.push(op);
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.canvas.ops.push({ kind: 'fill', color: String(this.fillStyle), x, y, w, h });
  }
}

const PAGE_SIZE: Record<number, { w: number; h: number }> = { 1: { w: 1000, h: 1400 }, 2: { w: 1200, h: 1600 } };

function pageImageOf(pageNo: number): PageImageLike {
  const size = PAGE_SIZE[pageNo] ?? PAGE_SIZE[1]!;
  return {
    naturalWidth: size.w,
    naturalHeight: size.h,
    source: { __label: `page#${pageNo}` } as unknown as CanvasImageSource,
    origin: 'memory',
  };
}

function pageNoOfUrl(url: string): number {
  const m = /p0*(\d+)\.png/.exec(url);
  return m ? Number(m[1]) : 1;
}

/** data URL = 画布产物（裁剪图 / 拼接图）→ 解出可裁源；其余 = 页图 */
function imageFromUrl(url: string): PageImageLike {
  if (!url.startsWith('data:')) return pageImageOf(pageNoOfUrl(url));
  const payload = decodePayload(url);
  return {
    naturalWidth: payload.w,
    naturalHeight: payload.h,
    source: { __label: `canvas#${payload.id}` } as unknown as CanvasImageSource,
    origin: 'memory',
  };
}

// crop.js 只替 loadPageImage（jsdom 不能解码图片）；cropNormalizedRect / rectToPixels 保持真实现
vi.mock('../../src/app/workbench/crop.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/app/workbench/crop.js')>();
  return {
    ...actual,
    loadPageImage: async (url: string): Promise<PageImageLike> => imageFromUrl(url),
    loadFileImage: async (): Promise<PageImageLike> => pageImageOf(1),
  };
});

import { WorkbenchPage } from '../../src/app/pages/WorkbenchPage.js';

// ==================== 桥面假实现 ====================

const DSO_RAW = '<|ref|>image<|/ref|><|det|>[[100, 200, 400, 400]]<|/det|>';
const MAIN_JSON = JSON.stringify({
  questions: [{
    qno: '17', questionType: '解答',
    stemMarkdown: '如图[图1]，一题被分页切成两半，求 $F$。',
    options: null, answerMarkdown: null, analysisMarkdown: null, suggestedTags: ['浮力'],
  }],
  figures: [{ ref: '图1', bboxNorm: [100, 200, 400, 400] }],
});

interface Invocation { role: string; text: string; imageUrl: string | null }
interface Spies { invocations: Invocation[]; savedStates: WorkbenchState[] }

function makeSpies(): Spies { return { invocations: [], savedStates: [] }; }

function messageText(content: AiChatMessage['content']): string {
  if (typeof content === 'string') return content;
  return content.map((part) => (part.type === 'text' ? part.text : '')).join(' ');
}

function messageImageUrl(content: AiChatMessage['content']): string | null {
  if (typeof content === 'string') return null;
  const part = content.find((p) => p.type === 'image_url');
  return part && part.type === 'image_url' ? part.imageUrl.url : null;
}

function isDsoCall(text: string): boolean {
  return text.includes('<|ref|>image<|/ref|>') || text.includes('Convert the document to markdown');
}

function makeAi(spies: Spies, mainJson: string = MAIN_JSON, dsoRaw: string = DSO_RAW): MofangAiBridge {
  const invoke = async (payload: { role: string; messages: AiChatMessage[] }): Promise<AiInvokeResult> => {
    const text = payload.messages.map((m) => messageText(m.content)).join(' ');
    const imageUrl = payload.messages.map((m) => messageImageUrl(m.content)).find((u) => u !== null) ?? null;
    spies.invocations.push({ role: payload.role, text, imageUrl });
    if (isDsoCall(text)) return { ok: true, content: dsoRaw, latencyMs: 3 };
    return { ok: true, content: mainJson, latencyMs: 40 };
  };
  return {
    profile: {
      list: async () => [{
        id: 'p1', role: 'vision' as const, name: 'OCR', provider: 'x', protocol: 'openai-chat',
        baseUrl: 'https://x', model: 'deepseek-ocr', capability: null, isEnabled: true, hasKey: true,
        lastTestAt: NOW, lastTestOk: true, createdAt: NOW, updatedAt: NOW,
      }],
      create: async () => { throw new Error('unused'); },
      update: async () => { throw new Error('unused'); },
      delete: async () => undefined,
      setEnabled: async () => { throw new Error('unused'); },
      testConnection: async () => ({ ok: false, latencyMs: null, error: 'unused' }),
    },
    invoke: invoke as MofangAiBridge['invoke'],
    models: { list: async () => ({ ok: false, models: [], error: 'unused' }) },
    suggest: {
      anchorStatus: async () => { throw new Error('unused'); },
      treeLink: async () => { throw new Error('unused'); },
      tags: async () => { throw new Error('unused'); },
      treeForDraft: async () => { throw new Error('unused'); },
    },
  };
}

function makeState(cards: WorkbenchCard[], pages: number[]): WorkbenchState {
  return {
    version: 1, runId: RUN_ID, mode: 'auto', stage: '初中', subjectId: 'subj:physics', paperTitle: '跨页练习',
    pages: pages.map((pageNo) => ({
      pageNo,
      name: `p${String(pageNo).padStart(3, '0')}.png`,
      width: PAGE_SIZE[pageNo]!.w,
      height: PAGE_SIZE[pageNo]!.h,
    })),
    cards, nextSeq: 100, updatedAt: NOW,
  };
}

function makeRecog(spies: Spies, state: WorkbenchState | null): MofangRecogBridge {
  const pages = (state?.pages ?? []).map((page) => ({
    runId: RUN_ID, pageNo: page.pageNo, imageFile: `pages/p${String(page.pageNo).padStart(3, '0')}.png`,
    ocrFile: null, status: 'done' as const, textChars: 0, imageRefCount: 0, error: null, updatedAt: NOW,
    imagePath: `C:/tmp/run/pages/p${String(page.pageNo).padStart(3, '0')}.png`, ocrText: '',
  }));
  const run: RecogRun = {
    id: RUN_ID, status: 'done', stage: 'done', sourceKind: 'image', sourceName: '跨页练习.png',
    pageCount: pages.length, pagesDone: pages.length, error: null, warnings: [], questionIds: [],
    createdAt: NOW, updatedAt: NOW, finishedAt: NOW,
  };
  return {
    create: async () => ({ runId: RUN_ID, pageCount: pages.length }),
    status: async (): Promise<RecogRunDetail> => ({ run, runDir: 'C:/tmp/run', pages, drafts: [] }),
    cancel: async () => run,
    history: async () => [run],
    attachQuestions: async () => run,
    resume: async () => run,
    onEvent: () => () => undefined,
    workbench: {
      load: async () => state,
      save: async (payload) => { spies.savedStates.push(payload.state); return { savedAt: NOW }; },
    },
    draftWrite: async (payload) => ({ savedAt: NOW, draftCount: payload.drafts.length, warnings: [] }),
  };
}

function makeBank(): BankService {
  const base = new MockBankService(new MockBankStore(), false);
  return {
    ...base,
    createQuestion: async (data) => ({ ...data, id: 'q-1', createdAt: NOW, updatedAt: NOW } as Question),
  } as BankService;
}

function makeExt(): BankExtServices {
  const base = createMockExtServices(new MockBankStore());
  const subjects: DictEntry[] = [{ id: 'subj:physics', kind: 'subject', code: 'physics', label: '物理', site: null, active: true }];
  const types: DictEntry[] = [{ id: 'qtype:answer', kind: 'question_type', code: 'answer', label: '解答题', site: null, active: true }];
  return {
    ...base,
    dict: {
      ...base.dict,
      listEntries: async (filter) => (filter?.kind === 'subject' ? subjects : filter?.kind === 'question_type' ? types : []),
    },
  } as BankExtServices;
}

// ==================== 渲染/交互 ====================

let container: HTMLDivElement;
let root: Root | null = null;
let originalCreateElement: typeof document.createElement;

function q<T extends Element = Element>(testId: string): T | null {
  return container.querySelector<T>(`[data-testid="${testId}"]`);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

function click(el: Element | null): void {
  if (!el) throw new Error('找不到可点元素');
  flushSync(() => { (el as HTMLElement).click(); });
}

function renderWorkbench(state: WorkbenchState, mainJson?: string, dsoRaw?: string): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => {
    root!.render(
      <WorkbenchPage
        runId={RUN_ID}
        recog={makeRecog(spies, state)}
        ai={makeAi(spies, mainJson ?? MAIN_JSON, dsoRaw ?? DSO_RAW)}
        bank={makeBank()}
        ext={makeExt()}
        defaults={{ stage: '初中', subjectId: 'subj:physics', paperTitle: '跨页练习' }}
      />,
    );
  });
}

let spies: Spies = makeSpies();

/** 主调用（排除 DSO 坐标腿） */
function mainCalls(): Invocation[] {
  return spies.invocations.filter((c) => !isDsoCall(c.text));
}

/** 主调用送出的那张图（解出画布垫片的绘制清单） */
function sentImage(): FakePayload {
  const call = mainCalls()[0];
  if (!call?.imageUrl) throw new Error('没有捕获到主调用送出的图');
  return decodePayload(call.imageUrl);
}

/** 卸载强制落盘（草稿保存 1.5s 防抖，卸载即 flush）→ 取最近一次落盘的题卡 */
async function flushedCard(cardId: string): Promise<WorkbenchCard> {
  root?.unmount();
  root = null;
  await settle();
  const state = spies.savedStates.at(-1);
  const card = state?.cards.find((c) => c.id === cardId);
  if (!card) throw new Error(`落盘状态里没有题卡 ${cardId}`);
  return card;
}

/** 题卡内容里的图块裁图（内联降级形态）→ 解出它的绘制清单（draw.src = 裁图源） */
function figureCropPayloadOf(card: WorkbenchCard): FakePayload {
  const match = /src="(data:image\/png;base64,[^"]+)"/.exec(card.contentHtml);
  if (!match) throw new Error('题卡内容里没有图块裁图');
  return decodePayload(match[1]!);
}

beforeEach(() => {
  canvasSeq = 0;
  spies = makeSpies();
  originalCreateElement = document.createElement.bind(document);
  document.createElement = ((tagName: string, options?: ElementCreationOptions): HTMLElement => (
    tagName === 'canvas' ? (new FakeCanvas() as unknown as HTMLElement) : originalCreateElement(tagName, options)
  )) as typeof document.createElement;
  (globalThis as { createImageBitmap?: unknown }).createImageBitmap = async (blob: Blob): Promise<unknown> => {
    const payload = JSON.parse(Buffer.from(await blob.arrayBuffer()).toString('utf8')) as FakePayload;
    return { width: payload.w, height: payload.h, __label: `canvas#${payload.id}`, close: () => undefined };
  };
});

afterEach(() => {
  root?.unmount();
  root = null;
  document.createElement = originalCreateElement;
  container?.remove();
  delete (globalThis as { createImageBitmap?: unknown }).createImageBitmap;
});

// ==================== 用例 ====================

const FRAME_1: WorkbenchFrame = makeFrame('c1-f1', { pageNo: 1, rect: { x: 0, y: 0.5, w: 1, h: 0.5 } });
const FRAME_2: WorkbenchFrame = makeFrame('c1-f2', { pageNo: 2, rect: { x: 0, y: 0, w: 0.5, h: 0.25 } });
const FRAME_3: WorkbenchFrame = makeFrame('c1-f3', { pageNo: 1, rect: { x: 0, y: 0.25, w: 1, h: 0.5 } });

function pendingCard(frames: WorkbenchFrame[]): WorkbenchCard {
  return newPendingCard({ id: 'c1', frames, source: 'manual' });
}

describe('0070 多帧合并录题：先拼后识', () => {
  it('多帧跨页卡：一次模型调用 + 送图为两帧纵向拼接图（帧序 / 画布取最宽 / 页缝 12px）', async () => {
    renderWorkbench(makeState([pendingCard([FRAME_1, FRAME_2])], [1, 2]));
    await settle();
    click(q('wb-recognize-c1'));
    await settle();

    // 主调用恰一次（坐标腿是 DSO 双模板，不计入）
    expect(mainCalls()).toHaveLength(1);

    // 帧1：页1（1000×1400）下半 → 1000×700 → 上限 900 缩比 0.9 → 900×630
    // 帧2：页2（1200×1600）左上 1/4 → 600×400（未触上限）→ 画布取最宽 900、左对齐
    // 拼接高 = 630 + 400 + 12（页缝）
    const sent = sentImage();
    expect({ w: sent.w, h: sent.h }).toEqual({ w: 900, h: 1042 });

    const draws = sent.ops.filter((op): op is DrawOp => op.kind === 'draw');
    const fills = sent.ops.filter((op): op is FillOp => op.kind === 'fill');
    expect(draws.map((d) => ({ dy: d.dy, dw: d.dw, dh: d.dh }))).toEqual([
      { dy: 0, dw: 900, dh: 630 },
      { dy: 642, dw: 600, dh: 400 },
    ]);
    // 帧序 = 数组顺序：两块裁剪来自两张不同的页图（跨页帧各取自己的页）
    expect(draws[0]!.src).toMatch(/^canvas#/);
    expect(draws[0]!.src).not.toBe(draws[1]!.src);
    // 底色白（拼接器先铺底）+ 页缝：h1 + gap/2 = 636 处一道 1px 灰线
    expect(fills).toEqual([
      { kind: 'fill', color: '#ffffff', x: 0, y: 0, w: 900, h: 1042 },
      { kind: 'fill', color: '#c9c9c9', x: 0, y: 636, w: 900, h: 1 },
    ]);
  });

  it('多帧跨页卡：图块坐标换算回帧所在页（题卡存页坐标，重裁从该页走）', async () => {
    renderWorkbench(makeState([pendingCard([FRAME_1, FRAME_2])], [1, 2]));
    await settle();
    click(q('wb-recognize-c1'));
    await settle();

    const sent = sentImage();
    const card = await flushedCard('c1');
    expect(card.status).toBe('question');
    expect(card.figures).toHaveLength(1);
    // 模型给的 bbox（0-999 → 拼接图归一）换算回页1 坐标：块1 铺满宽 → x 不变；y = 0.5 + v×0.5
    expect(card.figures[0]!.pageNo).toBe(1);
    expect(card.figures[0]!.bbox[0]).toBeCloseTo(0.1, 3);
    expect(card.figures[0]!.bbox[1]).toBeCloseTo(0.66556, 3);
    expect(card.figures[0]!.bbox[3]).toBeCloseTo(0.83112, 3);
    void sent;

    // 裁图源 = 该图块所在页（页1），尺寸按页坐标换算（padding 0.004）
    const crop = figureCropPayloadOf(card);
    expect(crop.ops).toHaveLength(1);
    const op = crop.ops[0] as DrawOp;
    expect(op.src).toBe('page#1');
    expect({ sx: op.sx, sy: op.sy, sw: op.sw, sh: op.sh }).toEqual({ sx: 96, sy: 926, sw: 308, sh: 243 });
  });

  it('多帧跨页卡：落在第二帧的图块归到第二页（红框画在页2、重裁也从页2走）', async () => {
    const dsoInSecondFrame = '<|ref|>image<|/ref|><|det|>[[100, 700, 400, 900]]<|/det|>';
    renderWorkbench(makeState([pendingCard([FRAME_1, FRAME_2])], [1, 2]), undefined, dsoInSecondFrame);
    await settle();
    click(q('wb-recognize-c1'));
    await settle();

    const card = await flushedCard('c1');
    expect(card.figures).toHaveLength(1);
    // 换算：块2（页2）半宽块 → x 按 900/600 折算再乘框宽；y 落进页2 顶部 1/4
    expect(card.figures[0]!.pageNo).toBe(2);
    expect(card.figures[0]!.bbox[0]).toBeCloseTo(0.075075, 3);
    expect(card.figures[0]!.bbox[1]).toBeCloseTo(0.055081, 3);
    expect(card.figures[0]!.bbox[2]).toBeCloseTo(0.3003, 3);
    expect(card.figures[0]!.bbox[3]).toBeCloseTo(0.185463, 3);

    // 裁图源 = 页2（不是首帧页，也不是拼接图）
    const crop = figureCropPayloadOf(card);
    const op = crop.ops[0] as DrawOp;
    expect(op.src).toBe('page#2');
    expect({ sx: op.sx, sy: op.sy, sw: op.sw, sh: op.sh }).toEqual({ sx: 85, sy: 82, sw: 280, sh: 221 });
  });

  it('多帧卡：题卡保留全部框用于溯源（2026-09-25 目检返工①：原先只留首帧，用户指出不符合设计逻辑）', async () => {
    renderWorkbench(makeState([pendingCard([FRAME_1, FRAME_2])], [1, 2]));
    await settle();
    click(q('wb-recognize-c1'));
    await settle();

    // 左栏溯源框：两个框都在（都是「已并入」语义），不因识别而消失
    expect(q('wb-frame-mark-c1-0')).not.toBeNull();
    expect(q('wb-frame-mark-c1-1')).not.toBeNull();

    const card = await flushedCard('c1');
    expect(card.status).toBe('question');
    expect(card.frames.map((f) => f.id)).toEqual(['c1-f1', 'c1-f2']);
  });

  it('一次识别出多题：框只挂在首卡上（同一批框不在左栏重复叠加）', async () => {
    const twoQuestions = JSON.stringify({
      questions: [
        {
          qno: '17', questionType: '解答', stemMarkdown: '（上一页下半）物体沿斜面下滑。',
          options: null, answerMarkdown: null, analysisMarkdown: null, suggestedTags: [],
        },
        {
          qno: '18', questionType: '解答', stemMarkdown: '（下一页上半）求滑到底端的速度 $v$。',
          options: null, answerMarkdown: null, analysisMarkdown: null, suggestedTags: [],
        },
      ],
      figures: [],
    });
    renderWorkbench(makeState([pendingCard([FRAME_1, FRAME_2])], [1, 2]), twoQuestions);
    await settle();
    click(q('wb-recognize-c1'));
    await settle();

    // 左栏只有这一批框（2 个），不是每张卡各画一遍（4 个）
    expect(container.querySelectorAll('[data-testid^="wb-frame-mark-"]')).toHaveLength(2);
    const state = await (async () => {
      root?.unmount();
      root = null;
      await settle();
      return spies.savedStates.at(-1);
    })();
    const cards = (state?.cards ?? []).filter((c) => c.status === 'question');
    expect(cards.map((c) => c.id).sort()).toEqual(['c1', 'c100']);
    expect(cards.find((c) => c.id === 'c1')!.frames.map((f) => f.id)).toEqual(['c1-f1', 'c1-f2']);
    expect(cards.find((c) => c.id === 'c100')!.frames).toEqual([]);
  });

  it('单帧卡逐字节回归：送图 = 该帧裁剪图本身（无拼接、无页缝）+ 回填仍取原页图', async () => {
    renderWorkbench(makeState([pendingCard([FRAME_1])], [1]));
    await settle();
    click(q('wb-recognize-c1'));
    await settle();

    expect(mainCalls()).toHaveLength(1);
    const sent = sentImage();
    // 单帧 = 原路径：一张 900×630 的裁剪图，零拼接、零页缝
    expect({ w: sent.w, h: sent.h }).toEqual({ w: 900, h: 630 });
    expect(sent.ops.filter((op) => op.kind === 'fill')).toEqual([]);
    const draws = sent.ops.filter((op): op is DrawOp => op.kind === 'draw');
    expect(draws).toHaveLength(1);
    expect(draws[0]!.src).toBe('page#1'); // 送出的就是页图上的这一块

    const card = await flushedCard('c1');
    // 回填源 = 该图块所在页（页1），坐标已换算回页坐标：页1 下半里的图 → 96,835 起 308×291→151
    const crop = figureCropPayloadOf(card);
    const op = crop.ops[0] as DrawOp;
    expect(op.src).toBe('page#1');
    expect({ sx: op.sx, sy: op.sy, sw: op.sw, sh: op.sh }).toEqual({ sx: 96, sy: 835, sw: 308, sh: 151 });
    // 单帧卡的框同样保留（溯源口径与多帧一致）
    expect(card.frames.map((f) => f.id)).toEqual(['c1-f1']);
  });

  it('三帧（跨页）：尺寸 = 三帧叠加 + 两段页缝，仍只调一次模型', async () => {
    renderWorkbench(makeState([pendingCard([FRAME_1, FRAME_2, FRAME_3])], [1, 2]));
    await settle();
    click(q('wb-recognize-c1'));
    await settle();

    expect(mainCalls()).toHaveLength(1);
    const sent = sentImage();
    // 630 + 400 + 630 + 12×2 = 1684
    expect({ w: sent.w, h: sent.h }).toEqual({ w: 900, h: 1684 });
    const fills = sent.ops.filter((op): op is FillOp => op.kind === 'fill');
    expect(fills.map((f) => f.y)).toEqual([0, 636, 1048]); // 0 = 白底，其余两处 = 页缝
  });

  it('多帧卡某帧页图未就绪：明确人读原因 + 零模型调用（不静默丢帧）', async () => {
    // 卡里第二帧指到第 2 页，但本次 run 只有第 1 页（页图未就绪的现场）
    renderWorkbench(makeState([pendingCard([FRAME_1, FRAME_2])], [1]));
    await settle();
    click(q('wb-recognize-c1'));
    await settle();

    expect(mainCalls()).toHaveLength(0);
    const err = q('wb-error-c1')?.textContent ?? '';
    expect(err).toContain('第 2 页');
    expect(q('wb-recognize-c1')).not.toBeNull(); // 回退待识别，可重试
  });
});
