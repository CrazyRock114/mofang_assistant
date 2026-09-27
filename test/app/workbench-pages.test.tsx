// 0040 P2~P5：录题工作台页面测试（入口页三入口 / 工作台卡流 / 框选 / AI 建议 / 入库与撤销）。
// 服务全部注入假桥（不摸真 IPC）；裁图模块被替换（jsdom 无 canvas），页图尺寸固定便于断言几何。
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { act } from 'react';

import type { MofangAiBridge, MofangRecogBridge } from '../../src/shared/contracts/bridge.js';
import type { BankExtServices, BankService, DictEntry, Question } from '../../src/shared/contracts/bank-types.js';
import type { AiInvokeResult } from '../../src/shared/contracts/ai-types.js';
import type { RecogRun, RecogRunDetail } from '../../src/shared/contracts/recog-run-types.js';
import type { WorkbenchState } from '../../src/shared/contracts/onestep-types.js';
import type { PageImageLike } from '../../src/app/workbench/crop.js';
import { createMockExtServices } from '../../src/bank/mock/mock-ext.js';
import { MockBankStore } from '../../src/bank/mock/mock-store.js';
import { MockBankService } from '../../src/bank/mock/mock-bank.js';

// jsdom 无 canvas：裁图与页图加载整体替换（像素换算另有 workbench-logic 测试覆盖）
const FAKE_IMAGE: PageImageLike = { naturalWidth: 1000, naturalHeight: 1400, source: {} as CanvasImageSource, origin: 'memory' };
vi.mock('../../src/app/workbench/crop.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/app/workbench/crop.js')>();
  return {
    ...actual,
    loadPageImage: async (): Promise<PageImageLike> => FAKE_IMAGE,
    loadFileImage: async (): Promise<PageImageLike> => FAKE_IMAGE,
    cropNormalizedRect: () => ({ ok: true as const, dataUrl: 'data:image/png;base64,QUJD', width: 320, height: 200 }),
  };
});

import { IntakePage } from '../../src/app/pages/IntakePage.js';
import { WorkbenchPage } from '../../src/app/pages/WorkbenchPage.js';
import { clearPendingImages, peekPendingImages } from '../../src/app/workbench/handoff.js';
import { clearPendingPdf, peekPendingPdf } from '../../src/app/splitting/handoff.js';
import { INITIAL_STAGE_SUBJECT, setStageSubject } from '../../src/app/state/stage-subject.js';

const NOW = '2026-09-19T10:00:00.000Z';
const RUN_ID = 'run-0040-1';

const MAIN_JSON = JSON.stringify({
  questions: [{
    qno: '2-17',
    questionType: '填空',
    stemMarkdown: '如图[图1]，将物体放入液体中，求 $F_\\text{浮}$。',
    options: null,
    answerMarkdown: null,
    analysisMarkdown: null,
    suggestedTags: ['浮力', '阿基米德原理'],
  }],
  figures: [{ ref: '图1', bboxNorm: [100, 200, 400, 400] }],
});

const DSO_RAW = '<|ref|>image<|/ref|><|det|>[[100, 200, 400, 400]]<|/det|>';

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((part) => {
      const p = part as { type?: string; text?: string };
      return p.type === 'text' ? (p.text ?? '') : '';
    }).join(' ');
  }
  return '';
}

interface Spies {
  invites: string[];
  createdQuestions: Array<Record<string, unknown>>;
  addedTags: Array<[string, string]>;
  linkedNodes: Array<[string, string]>;
  attached: string[];
  deleted: string[];
  treeForDraft: number;
  treeForDraftSubjects: string[];
  savedStates: WorkbenchState[];
  invokeRoles: string[];
  /** 0046 P5.1（只增）：识别成功后的 Onestep 草稿写回 */
  draftWrites: Array<{ runId: string; drafts: unknown[] }>;
  /** 0053 返工（只增）：新建试题篮（title 记录）与逐题加篮（[paperId, questionId]）断言用 */
  createdPapers: string[];
  addedToBasket: Array<[string, string]>;
}

function makeRecog(
  spies: Spies,
  detail?: Partial<RecogRunDetail>,
  /** 0053（只增）：history 注入（翻页用例）+ workbench 文件态注入（加篮/入库用例） */
  opts?: { history?: RecogRun[]; state?: WorkbenchState | null },
): MofangRecogBridge {
  const run: RecogRun = {
    id: RUN_ID, status: 'done', stage: 'done', sourceKind: 'image', sourceName: '浮力练习.png',
    pageCount: 1, pagesDone: 1, error: null, warnings: [], questionIds: [],
    createdAt: NOW, updatedAt: NOW, finishedAt: NOW,
  };
  return {
    create: async () => { spies.invites.push('create'); return { runId: RUN_ID, pageCount: 1 }; },
    status: async (): Promise<RecogRunDetail> => ({
      run,
      runDir: 'C:/tmp/run',
      pages: [{ runId: RUN_ID, pageNo: 1, imageFile: 'pages/p001.png', ocrFile: null, status: 'done', textChars: 0, imageRefCount: 0, error: null, updatedAt: NOW, imagePath: 'C:/tmp/run/pages/p001.png', ocrText: '' }],
      drafts: [],
      ...detail,
    }),
    cancel: async () => run,
    history: async () => opts?.history ?? [run],
    attachQuestions: async (_p) => { spies.attached.push(..._p.questionIds); return run; },
    resume: async () => run,
    onEvent: () => () => undefined,
    workbench: {
      load: async () => opts?.state ?? null,
      save: async (p) => { spies.savedStates.push(p.state); return { savedAt: NOW }; },
    },
    // 0046 P5.1（只增）：recog.draft.write mock——识别成功后写回 Onestep 草稿（调用链必需）
    draftWrite: async (p) => {
      spies.draftWrites.push({ runId: p.runId, drafts: p.drafts });
      return { savedAt: NOW, draftCount: p.drafts.length, warnings: [] };
    },
  };
}

function makeAi(spies: Spies, opts?: { enabled?: boolean; reasoning?: boolean; mainJson?: string }): MofangAiBridge {
  const invoke = async (payload: { role: string; messages: Array<{ content: unknown }> }): Promise<AiInvokeResult> => {
    spies.invokeRoles.push(payload.role);
    const text = payload.messages.map((m) => textOf(m.content)).join(' ');
    if (text.includes('<|ref|>image<|/ref|>') || text.includes('Convert the document to markdown')) {
      return { ok: true, content: DSO_RAW, latencyMs: 3 };
    }
    return { ok: true, content: opts?.mainJson ?? MAIN_JSON, latencyMs: 40 };
  };
  return {
    profile: {
      list: async () => {
        if (opts?.enabled === false) return [];
        const vision = {
          id: 'p1', role: 'vision' as const, name: 'OCR', provider: 'x', protocol: 'openai-chat',
          baseUrl: 'https://x', model: 'deepseek-ocr', capability: null, isEnabled: true, hasKey: true,
          lastTestAt: NOW, lastTestOk: true, createdAt: NOW, updatedAt: NOW,
        };
        if (!opts?.reasoning) return [vision];
        return [vision, {
          id: 'p2', role: 'reasoning' as const, name: 'VLM', provider: 'x', protocol: 'openai-chat',
          baseUrl: 'https://x', model: 'deepseek-flash', capability: null, isEnabled: true, hasKey: true,
          lastTestAt: NOW, lastTestOk: true, createdAt: NOW, updatedAt: NOW,
        }];
      },
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
      treeForDraft: async (payload) => {
        spies.treeForDraft += 1;
        spies.treeForDraftSubjects.push(payload.subjectId ?? '');
        return {
          status: 'ok', reason: null,
          meta: { stage: '初中', subjectId: 'subj:physics', questionCount: 1, treeCount: 1, totalNodeCount: 5, injectedNodeCount: 5, truncatedNodeCount: 0, injectedTokens: 100 },
          warnings: [], none: false,
          suggestions: [{ questionId: 'draft-1', kind: 'tree-node', targetId: 'n-floating', targetLabel: '力学 > 浮力', confidence: 0.86, evidenceSummary: '题目 draft-1' }],
          tagSuggestions: [], drafts: [], duplicates: [], latencyMs: 120,
        };
      },
    },
  };
}

function makeBank(spies: Spies): BankService {
  const base = new MockBankService(new MockBankStore(), false);
  return {
    ...base,
    createQuestion: async (data) => {
      spies.createdQuestions.push(data as unknown as Record<string, unknown>);
      return {
        ...data, id: `q-${spies.createdQuestions.length}`, createdAt: NOW, updatedAt: NOW,
      } as Question;
    },
    addTag: async (questionId, tag) => { spies.addedTags.push([questionId, tag]); },
    deleteQuestion: async (id) => { spies.deleted.push(id); },
    // 0053 返工（只增）：试题篮通道记录（createPaper/addQuestion 记账后透传真实现，行为保真）
    // 注：{...base} 展开不携带类原型方法——页面会调用的原型方法需在此逐个透传（listPapers 为加篮下拉数据源）
    createPaper: async (title, config) => {
      spies.createdPapers.push(title);
      return base.createPaper(title, config);
    },
    addQuestion: async (paperId, questionId, score, layout, textBlock) => {
      spies.addedToBasket.push([paperId, questionId]);
      return base.addQuestion(paperId, questionId, score, layout, textBlock);
    },
    listPapers: async () => base.listPapers(),
  } as BankService;
}

function makeExt(spies: Spies): BankExtServices {
  const base = createMockExtServices(new MockBankStore());
  const subjects: DictEntry[] = [{ id: 'subj:physics', kind: 'subject', code: 'physics', label: '物理', site: null, active: true }];
  const types: DictEntry[] = [{ id: 'qtype:blank', kind: 'question_type', code: 'fill', label: '填空题', site: null, active: true }];
  return {
    ...base,
    dict: {
      ...base.dict,
      listEntries: async (filter) => (filter?.kind === 'subject' ? subjects : filter?.kind === 'question_type' ? types : []),
    },
    tree: {
      ...base.tree,
      listTrees: async () => [{
        id: 't1', type: 'knowledge', subjectId: 'subj:physics', stage: '初中', name: '初中物理知识点',
        createdAt: NOW,
      }],
      getNodes: async () => [
        { id: 'n-mech', treeId: 't1', parentId: null, name: '力学', sort: 1, createdAt: NOW },
        { id: 'n-floating', treeId: 't1', parentId: 'n-mech', name: '浮力', sort: 1, createdAt: NOW },
      ],
      linkQuestion: async (questionId, nodeId) => { spies.linkedNodes.push([questionId, nodeId]); },
    },
  } as BankExtServices;
}

let container: HTMLDivElement;
let root: Root | null = null;

function render(node: React.ReactElement): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => { root!.render(node); });
}

/** 等异步链收敛（装载 → 识别 → 落盘）：多轮宏任务 + React 冲刷 */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

/** 等到条件成立（题卡编辑器是 lazy 组件，不靠固定轮次猜它什么时候加载完） */
async function settleUntil(predicate: () => boolean, rounds = 60): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    if (predicate()) return;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }
}

function click(el: Element | null): void {
  if (!el) throw new Error('找不到可点元素');
  flushSync(() => { (el as HTMLElement).click(); });
}

function setInput(selector: string, value: string): void {
  const el = container.querySelector(selector);
  if (!el) throw new Error(`找不到输入框: ${selector}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function q<T extends Element>(testid: string): T | null {
  return container.querySelector<T>(`[data-testid="${testid}"]`);
}

function qa<T extends Element>(testid: string): T[] {
  return [...container.querySelectorAll<T>(`[data-testid="${testid}"]`)];
}

beforeEach(() => {
  clearPendingImages();
  clearPendingPdf();
  setStageSubject(INITIAL_STAGE_SUBJECT);
  window.location.hash = '';
});

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
});

function makeSpies(): Spies {
  return {
    invites: [], createdQuestions: [], addedTags: [], linkedNodes: [], attached: [], deleted: [],
    treeForDraft: 0, treeForDraftSubjects: [], savedStates: [], invokeRoles: [], draftWrites: [],
    createdPapers: [], addedToBasket: [],
  };
}

/** 入口页交给工作台的默认归类（返工⑥：学科没接通时挂树建议在 IPC 形验处就炸） */
const DEFAULTS = { stage: '初中', subjectId: 'subj:physics', paperTitle: '浮力练习.png' };

// ==================== 入口页（P2） ====================

describe('0040 P2：入口页', () => {
  // 0053 目检返工：拖放条升唯一主入口后，切题旧链入口亦随用户拍板退役；断言从「存在」反转为「不存在」，等强不降级
  it('0053：两卡撤下、拖放条唯一主入口、无旧链入口 + 最近识别记录（含继续处理）', async () => {
    const spies = makeSpies();
    render(<IntakePage recog={makeRecog(spies)} />);
    await settle();
    expect(q('intake-card-pick')).toBeNull();
    expect(q('intake-card-pdf')).toBeNull();
    expect(q('intake-dropzone')).not.toBeNull();
    expect(q('intake-pdf-legacy')).toBeNull();
    expect(q('intake-run-' + RUN_ID)).not.toBeNull();
    expect(q('intake-run-open-' + RUN_ID)?.textContent).toContain('查看');
  });

  it('图片拖入 → 建 run + 图片字节交接给工作台 + 跳 #/intake/<runId>', async () => {
    const spies = makeSpies();
    render(<IntakePage recog={makeRecog(spies)} />);
    await settle();
    const file = new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' });
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [file] } });
    act(() => { q('intake-dropzone')!.dispatchEvent(drop); });
    await settle();
    expect(spies.invites).toContain('create');
    expect(peekPendingImages(RUN_ID)).toHaveLength(1);
    expect(window.location.hash).toBe(`#/intake/${RUN_ID}`);
  });

  // 2026-09-20 返工③：PDF 不再被赶去旧切题工作区，本地逐页转图后进同一个工作台
  it('PDF 拖入 → 逐页转图建 run + 页图与默认归类交接 + 跳 #/intake/<runId>', async () => {
    const spies = makeSpies();
    const seen: string[] = [];
    render(
      <IntakePage
        recog={makeRecog(spies)}
        rasterize={async (file) => {
          seen.push(file.name);
          return {
            materials: [{ name: '卷-p001.png', mime: 'image/png', dataBase64: 'QUJD' }],
            files: [new File([new Uint8Array([1])], '卷-p001.png', { type: 'image/png' })],
            totalPages: 1, importedPages: 1, notice: null,
          };
        }}
      />,
    );
    await settle();
    const pdf = new File([new Uint8Array([1, 2, 3])], '卷.pdf', { type: 'application/pdf' });
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [pdf] } });
    act(() => { q('intake-dropzone')!.dispatchEvent(drop); });
    await settle();

    expect(seen).toEqual(['卷.pdf']);
    expect(spies.invites).toContain('create');
    expect(peekPendingImages(RUN_ID)).toHaveLength(1);
    expect(peekPendingPdf()).toBeNull();          // 不再走 0036 交接
    expect(window.location.hash).toBe(`#/intake/${RUN_ID}`);
  });

  it('PDF 超页数截断 → 明确告知；同批其它素材不静默丢', async () => {
    const spies = makeSpies();
    render(
      <IntakePage
        recog={makeRecog(spies)}
        rasterize={async () => ({
          materials: [{ name: '厚卷-p001.png', mime: 'image/png', dataBase64: 'QUJD' }],
          files: [new File([new Uint8Array([1])], '厚卷-p001.png', { type: 'image/png' })],
          totalPages: 42, importedPages: 30, notice: '这份 PDF 共 42 页，本次只转入前 30 页（单次上限 30 页）；其余页请分次导入',
        })}
      />,
    );
    await settle();
    const pdf = new File([new Uint8Array([1])], '厚卷.pdf', { type: 'application/pdf' });
    const png = new File([new Uint8Array([2])], 'a.png', { type: 'image/png' });
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [pdf, png] } });
    act(() => { q('intake-dropzone')!.dispatchEvent(drop); });
    await settle();
    expect(container.textContent).toContain('42 页');
    expect(container.textContent).toContain('1 张图片未处理');
  });

  // 0053 目检返工（用户拍板：切题工作区功能没用，可见入口全撤）：改写自「旧链小字迁位保留」——
  // 录题页不再出现旧链小字，页面文案零「切题工作区」字样；#/split 路由本体保留（不算可见入口）
  it('0053 返工：录题页无切题工作区可见入口（旧链小字退役）', async () => {
    const spies = makeSpies();
    render(<IntakePage recog={makeRecog(spies)} />);
    await settle();
    expect(q('intake-pdf-legacy')).toBeNull();
    expect(container.textContent).not.toContain('切题工作区');
    expect(peekPendingPdf()).toBeNull();
  });

  // 0053：识别记录客户端翻页（全量取回 + 纯前端切片，页大小 10）
  it('0053：识别记录 >10 条出翻页器——翻页切内容、总量页码可见', async () => {
    const spies = makeSpies();
    const rows: RecogRun[] = Array.from({ length: 12 }, (_unused, i) => ({
      id: `run-0053-${i}`, status: 'done' as const, stage: 'done' as const, sourceKind: 'image' as const,
      sourceName: `第${i}份扫描.png`, pageCount: 1, pagesDone: 1, error: null, warnings: [], questionIds: [],
      createdAt: NOW, updatedAt: NOW, finishedAt: NOW,
    }));
    render(<IntakePage recog={makeRecog(spies, undefined, { history: rows })} />);
    await settle();
    // 首页只渲染 10 行 + 翻页器 + 总量页码
    expect(container.querySelectorAll('.wb-run-row')).toHaveLength(10);
    expect(q('intake-runs-pager')).not.toBeNull();
    expect(q('intake-runs-pager-info')?.textContent).toContain('共 12 条');
    expect(q('intake-runs-pager-info')?.textContent).toContain('第 1 / 2 页');
    // 翻页切内容：第二页出第 11/12 条，首页行不在
    click(q('intake-runs-next')!);
    expect(q('intake-run-run-0053-10')).not.toBeNull();
    expect(q('intake-run-run-0053-11')).not.toBeNull();
    expect(q('intake-run-run-0053-0')).toBeNull();
    expect(q('intake-runs-pager-info')?.textContent).toContain('第 2 / 2 页');
  });

  it('0053：识别记录 ≤10 条不出翻页器（现状回归）', async () => {
    const spies = makeSpies();
    render(<IntakePage recog={makeRecog(spies)} />);
    await settle();
    expect(q('intake-runs-pager')).toBeNull();
  });

  // 0053：录题页 AI 配置入口（唯一一处）→ #/settings?view=ai 深链
  it('0053：AI 配置入口有且仅有一处，点击直达 #/settings?view=ai', async () => {
    const spies = makeSpies();
    render(<IntakePage recog={makeRecog(spies)} />);
    await settle();
    expect(qa('intake-ai-config')).toHaveLength(1);
    click(q('intake-ai-config')!);
    expect(window.location.hash).toBe('#/settings?view=ai');
  });

  // 返工⑥ 的真实链路：入口页选的默认归类 → handoff → 工作台（此前这条线断着，学科恒为空）
  it('入口页默认归类经交接贯通到工作台（学科不再是空）', async () => {
    const spies = makeSpies();
    render(
      <IntakePage
        recog={makeRecog(spies)}
        rasterize={async () => ({
          materials: [{ name: '卷-p001.png', mime: 'image/png', dataBase64: 'QUJD' }],
          files: [new File([new Uint8Array([1])], '卷-p001.png', { type: 'image/png' })],
          totalPages: 1, importedPages: 1, notice: null,
        })}
      />,
    );
    await settle();
    act(() => { setStageSubject({ stage: '初中', subjectId: 'subj:physics' }); });
    const pdf = new File([new Uint8Array([1])], '期末卷.pdf', { type: 'application/pdf' });
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [pdf] } });
    act(() => { q('intake-dropzone')!.dispatchEvent(drop); });
    await settle();

    // 换页：入口页卸载（共享状态随之复位），工作台不带 defaults 起步 → 只能靠交接
    root?.unmount();
    root = null;
    container.remove();
    render(
      <WorkbenchPage
        runId={RUN_ID}
        recog={makeRecog(spies)}
        ai={makeAi(spies)}
        bank={makeBank(spies)}
        ext={makeExt(spies)}
      />,
    );
    await settle();
    expect(q<HTMLSelectElement>('wb-subject-select')?.value).toBe('subj:physics');
    expect(q<HTMLSelectElement>('wb-stage-select')?.value).toBe('初中');
    expect(q('wb-title')?.textContent).toBe('期末卷');
  });

  it('默认归类下拉由共享状态驱动（学段/学科）', async () => {
    const spies = makeSpies();
    render(<IntakePage recog={makeRecog(spies)} />);
    await settle();
    const stage = q<HTMLSelectElement>('intake-stage-select')!;
    flushSync(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
      setter.call(stage, '高中');
      stage.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(stage.value).toBe('高中');
    expect(q('intake-subject-select')).not.toBeNull();
  });
});

// ==================== 0053 返工：入库同时加入试题篮 ====================

/** 0053：已识别题卡（工作台文件态注入用；形态照 workbench-save-as-paper.test.tsx makeCard） */
function make0053Card(id: string, qno: string, checked: boolean): WorkbenchState['cards'][number] {
  return {
    id,
    status: 'question',
    source: 'ai',
    checked,
    frames: [{ id: `${id}-f1`, pageNo: 1, rect: { x: 0.1, y: 0.1, w: 0.8, h: 0.3 } }],
    error: null,
    qno,
    typeCode: '',
    contentHtml: `<div class="question"><p>第 ${qno} 题题干</p></div>`,
    answerHtml: '<p>A</p>',
    analysisHtml: '',
    figures: [],
    figureSource: 'dso',
    warnings: [],
    tags: [],
    adoptedTags: [],
    treeSuggestions: [],
    adoptedNode: null,
    committedQuestionId: null,
  };
}

function make0053State(cards: WorkbenchState['cards']): WorkbenchState {
  return {
    version: 1,
    runId: RUN_ID,
    mode: 'auto',
    stage: '',
    subjectId: '',
    paperTitle: '来源卷.pdf',
    pages: [],
    cards,
    nextSeq: cards.length + 1,
    updatedAt: NOW,
  };
}

// 0053 目检返工（用户拍板）：「同时存为试卷」勾选项退役（与「存为试卷」按钮重合），
// 改为「加入试题篮」按钮——点击弹窗选篮/新建（可取消），**弹窗点「确定」即一步完成入库+加篮**
//（返工③补定稿：与「存为试卷」弹层同型，无需再返回点「入库」）；工具条「入库」恒为纯入库
describe('0053 返工：加入试题篮（弹窗确定即入库+加篮）', () => {
  function render0053(spies: Spies, state: WorkbenchState, bank?: BankService): void {
    render(
      <WorkbenchPage
        runId={RUN_ID}
        recog={makeRecog(spies, undefined, { state })}
        ai={makeAi(spies)}
        bank={bank ?? makeBank(spies)}
        ext={makeExt(spies)}
        defaults={{ stage: '', subjectId: '', paperTitle: '' }}
      />,
    );
  }

  /** 打开加篮弹窗（公共前段） */
  function openBasketPicker(): void {
    click(q('wb-add-to-basket')!);
    expect(q('wb-basket-picker')).not.toBeNull();
  }

  it('弹窗选定现有试题篮 → 点「确定」一步完成：题入库且逐题加入该篮（消息带篮名；不新建）', async () => {
    const spies = makeSpies();
    const bank = makeBank(spies);
    // 注：makeBank 的 {...base} 展开不携带原型方法，listPapers 未透传——basket id 从 createPaper 返回值取
    const basket = await bank.createPaper('浮力题篮');
    const basketId = basket.id;
    const seededPapers = spies.createdPapers.length;
    render0053(spies, make0053State([make0053Card('c1', '1', true), make0053Card('c2', '2', true)]), bank);
    await settle();
    openBasketPicker();
    // 弹窗列表能看到现有试题篮（按标题）
    expect(q('wb-basket-list')!.textContent).toContain('浮力题篮');
    click(q(`wb-basket-opt-${basketId}`)!);
    click(q('wb-basket-apply')!);
    await settle();
    // 弹窗关、一步完成（无需再点「入库」）：题入库 + 逐题加篮
    expect(q('wb-basket-picker')).toBeNull();
    expect(spies.createdQuestions).toHaveLength(2);
    expect(spies.createdPapers).toHaveLength(seededPapers);
    expect(spies.addedToBasket).toEqual([[basketId, 'q-1'], [basketId, 'q-2']]);
    expect(container.textContent).toContain('浮力题篮');
  });

  it('弹窗默认选中「＋ 新建试题篮」→ 命名 → 点「确定」一步完成：建篮 + 逐题加入新篮', async () => {
    const spies = makeSpies();
    render0053(spies, make0053State([make0053Card('c1', '1', true)]));
    await settle();
    openBasketPicker();
    // 默认选中新建（与「存为试卷」默认建新卷同型语义）
    expect((q<HTMLInputElement>('wb-basket-opt-new') as HTMLInputElement).checked).toBe(true);
    // 名称输入框出现且可改
    expect(q<HTMLInputElement>('wb-basket-new-name')).not.toBeNull();
    setInput('[data-testid="wb-basket-new-name"]', '期中收纳篮');
    click(q('wb-basket-apply')!);
    await settle();
    expect(q('wb-basket-picker')).toBeNull();
    expect(spies.createdPapers).toEqual(['期中收纳篮']);
    expect(spies.addedToBasket).toHaveLength(1);
    expect(spies.addedToBasket[0]![1]).toBe('q-1');
    expect(container.textContent).toContain('期中收纳篮');
  });

  it('弹窗点「取消」→ 零动作；工具条「入库」恒为纯入库', async () => {
    const spies = makeSpies();
    const bank = makeBank(spies);
    const basket = await bank.createPaper('浮力题篮');
    render0053(spies, make0053State([make0053Card('c1', '1', true)]), bank);
    await settle();
    openBasketPicker();
    click(q(`wb-basket-opt-${basket.id}`)!);
    click(q('wb-basket-cancel')!);
    expect(q('wb-basket-picker')).toBeNull();
    expect(spies.createdQuestions).toHaveLength(0);
    expect(spies.addedToBasket).toHaveLength(0);
    // 「入库」按钮本身与弹窗无关：纯入库、零加篮
    click(q('wb-batch-commit')!);
    await settle();
    expect(spies.createdQuestions).toHaveLength(1);
    expect(spies.addedToBasket).toHaveLength(0);
  });

  // 0053 目检返工②（用户截图）：弹窗列表不限宽会被长名撑爆——行文本超长截断 + 行 title 完整名；
  // 选中按完整 id 生效，消息文案用完整名
  it('试题篮名过长 → 弹窗列表行截断显示（title 全名提示；确定后消息用全名）', async () => {
    const spies = makeSpies();
    const bank = makeBank(spies);
    const longTitle = '二〇二六学年第一学期期末教学质量检测物理试卷整理';
    const basket = await bank.createPaper(longTitle);
    render0053(spies, make0053State([make0053Card('c1', '1', true)]), bank);
    await settle();
    openBasketPicker();
    const row = container.querySelector<HTMLLabelElement>(`[data-testid="wb-basket-opt-${basket.id}"]`)!;
    expect(row).not.toBeNull();
    // 截断 ≤17 字符（16 字 + 省略号），完整名进行 title 悬停提示
    expect(row.textContent!.length).toBeLessThanOrEqual(17);
    expect(row.textContent!.endsWith('…')).toBe(true);
    expect(row.getAttribute('title')).toBe(longTitle);
    click(q(`wb-basket-opt-${basket.id}`)!);
    click(q('wb-basket-apply')!);
    await settle();
    expect(spies.addedToBasket).toEqual([[basket.id, 'q-1']]);
    expect(container.textContent).toContain(longTitle);
  });
});

// ==================== 工作台（P4/P5） ====================

function renderWorkbench(
  spies: Spies,
  opts?: { aiEnabled?: boolean; reasoning?: boolean; defaults?: typeof DEFAULTS | null; mainJson?: string },
): void {
  render(
    <WorkbenchPage
      runId={RUN_ID}
      recog={makeRecog(spies)}
      ai={makeAi(spies, {
        enabled: opts?.aiEnabled, reasoning: opts?.reasoning,
        ...(opts?.mainJson ? { mainJson: opts.mainJson } : {}),
      })}
      bank={makeBank(spies)}
      ext={makeExt(spies)}
      // 默认归类由入口页交接（生产走 handoff）；显式传 null 复现「学科未定」起步态
      {...(opts?.defaults === null
        ? { defaults: { stage: '', subjectId: '', paperTitle: '' } }
        : { defaults: opts?.defaults ?? DEFAULTS })}
    />,
  );
}

describe('0040 P4/P5：工作台卡流与入库', () => {
  it('auto 档：AI 一键录入 → 出题卡（题号/题型/图块/告警）', async () => {
    const spies = makeSpies();
    renderWorkbench(spies);
    await settle();
    expect(q('wb-mode-pill')?.textContent).toContain('AI 自动识别');
    expect(q('wb-ai-one-click')).not.toBeNull();
    expect(q('wb-cards-empty')).not.toBeNull();

    click(q('wb-ai-one-click')!);
    await settle();
    await settle();

    const cards = qa('wb-card-c1');
    expect(cards).toHaveLength(1);
    expect(q('wb-qno-c1')?.textContent).toBe('第 1 题');
    expect(q<HTMLSelectElement>('wb-type-c1')?.value).toBe('qtype:blank');
    // 图块自动定位 → 提示人工确认；答案解析皆空 → 黄条
    expect(q('wb-warn-c1')?.textContent).toContain('建议逐图确认');
    expect(q('wb-warn-c1')?.textContent).toContain('未识别到答案/解析');
    // 图块叠加到左栏原图
    expect(q('wb-figure-c1-0')).not.toBeNull();
  });

  it('双模型档位：配了 reasoning 档案 → 一步到位主调用走 reasoning，坐标腿走 vision', async () => {
    const spies = makeSpies();
    renderWorkbench(spies, { reasoning: true });
    await settle();
    click(q('wb-settings-btn'));   // 档位信息在「识别设置」弹层里（点开才渲染）
    expect(q('wb-active-model')?.textContent).toContain('reasoning 档');
    expect(q('wb-active-model')?.textContent).toContain('deepseek-flash');
    click(q('wb-ai-one-click')!);
    await settle();
    await settle();
    expect(spies.invokeRoles).toContain('reasoning');
    expect(spies.invokeRoles).toContain('vision'); // 坐标腿仍走 vision（OCR 档）
    expect(qa('wb-card-c1')).toHaveLength(1);
  });

  it('双模型档位：只有 vision 档案 → 主调用回落 vision（单模型也能用）', async () => {
    const spies = makeSpies();
    renderWorkbench(spies);
    await settle();
    click(q('wb-settings-btn'));
    expect(q('wb-active-model')?.textContent).toContain('vision 档');
    click(q('wb-ai-one-click')!);
    await settle();
    await settle();
    expect(spies.invokeRoles.every((r) => r === 'vision')).toBe(true);
    expect(qa('wb-card-c1')).toHaveLength(1);
  });

  it('失败文案带档位与模型名（本次定位困难的直接教训）', async () => {
    const spies = makeSpies();
    const failing: MofangAiBridge = {
      ...makeAi(spies, { reasoning: true }),
      invoke: (async () => ({ ok: false, error: 'HTTP 400：Value error, current model does not support parameter `enable_thinking`.', latencyMs: 5 })) as MofangAiBridge['invoke'],
    };
    render(
      <WorkbenchPage runId={RUN_ID} recog={makeRecog(spies)} ai={failing} bank={makeBank(spies)} ext={makeExt(spies)} />,
    );
    await settle();
    click(q('wb-ai-one-click')!);
    await settle();
    await settle();
    const err = q('wb-error-c1')?.textContent ?? '';
    expect(err).toContain('reasoning 档');
    expect(err).toContain('deepseek-flash');
    expect(err).toContain('enable_thinking');
  });

  it('入库此题：createQuestion 写全 sourceDetail + 采纳标签/知识节点 + run 回写 + 锁定', async () => {
    const spies = makeSpies();
    renderWorkbench(spies);
    await settle();
    click(q('wb-ai-one-click')!);
    await settle();
    await settle();

    // 标签默认全选（2026-09-23 目检反馈）→ 点掉「浮力」只留「阿基米德原理」；
    // 知识节点同样已默认选中（0054：识别完成自动出建议，无需点「出建议」按钮）
    click(q('wb-tag-c1-浮力')!);
    expect(spies.treeForDraft).toBe(1);
    expect(q('wb-tree-adopted-c1-n-floating')).not.toBeNull();

    click(q('wb-commit-c1')!);
    await settle();

    expect(spies.createdQuestions).toHaveLength(1);
    const input = spies.createdQuestions[0]!;
    expect(input['sourceType']).toBe('local');
    expect(input['sourceId']).toBeUndefined();
    expect(input['sourceDetail']).toEqual({ origin: 'scan', pageNo: 1, qno: '2-17', paperTitle: '浮力练习.png' });
    expect(input['typeId']).toBe('qtype:blank');
    expect(input['content']).toContain('data:image/png;base64,QUJD');
    expect(spies.addedTags).toEqual([['q-1', '阿基米德原理']]);
    expect(spies.linkedNodes).toEqual([['q-1', 'n-floating']]);
    expect(spies.attached).toEqual(['q-1']);
    expect(q('wb-committed-c1')?.textContent).toContain('已入库');
    expect(q('wb-committed-c1')?.textContent).toContain('标签 ×1');
  });

  // 2026-09-20 返工⑥：学科没接通 → 建议在 IPC 形验处吃「Invalid payload. subjectId」
  it('默认归类贯通：学科取自入口页交接，知识节点建议带该学科下发', async () => {
    const spies = makeSpies();
    renderWorkbench(spies);
    await settle();
    expect(q<HTMLSelectElement>('wb-subject-select')?.value).toBe('subj:physics');
    expect(q<HTMLSelectElement>('wb-stage-select')?.value).toBe('初中');

    click(q('wb-ai-one-click')!);
    await settle();
    await settle();
    // 0054：识别完成即自动出建议（无需点按钮）
    expect(spies.treeForDraft).toBe(1);
    expect(spies.treeForDraftSubjects).toEqual(['subj:physics']);
  });

  it('学科未定 → 明确说清去哪儿选，且不发这次建议调用（不再吃 Invalid payload）', async () => {
    const spies = makeSpies();
    renderWorkbench(spies, { defaults: null });
    await settle();
    click(q('wb-ai-one-click')!);
    await settle();
    await settle();
    // 0054：自动档遇学科未定静默降级（不刷屏）；手动兜底按钮点下去才给明确指引
    click(q('wb-tree-suggest-btn-c1')!);
    await settle();
    expect(spies.treeForDraft).toBe(0);
    expect(container.textContent).toContain('知识节点建议需要学科范围');
  });

  it('工作台内改默认归类 → 落进草稿状态（入库与建议都用它）', async () => {
    const spies = makeSpies();
    renderWorkbench(spies, { defaults: null });
    await settle();
    const select = q<HTMLSelectElement>('wb-subject-select')!;
    flushSync(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
      setter.call(select, 'subj:physics');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    expect(select.value).toBe('subj:physics');
    // 落盘：0053 返工删「存草稿」按钮（录题状态本就防抖实时保存）——卸载即触发 flush 兜底，不靠时序猜
    const before = spies.savedStates.length;
    root?.unmount();
    root = null;
    await settleUntil(() => spies.savedStates.length > before);
    expect(spies.savedStates.at(-1)?.subjectId).toBe('subj:physics');
  });

  it('撤销入库：题目删除 + 题卡解锁回可编辑态', async () => {
    const spies = makeSpies();
    renderWorkbench(spies);
    await settle();
    click(q('wb-ai-one-click')!);
    await settle();
    await settle();
    click(q('wb-commit-c1')!);
    await settle();

    // ConfirmButton 两步：首点进入确认态，再点执行
    click(q('wb-uncommit-c1')!);
    click(q('wb-uncommit-c1')!);
    await settle();
    expect(spies.deleted).toEqual(['q-1']);
    expect(q('wb-commit-c1')).not.toBeNull();
    expect(q('wb-committed-c1')).toBeNull();
  });

  it('半自动档：无 vision 档案 → 横幅 + 无 AI 一键按钮 + 档位回落 semi', async () => {
    const spies = makeSpies();
    renderWorkbench(spies, { aiEnabled: false });
    await settle();
    expect(q('wb-semi-banner')).not.toBeNull();
    expect(q('wb-ai-one-click')).toBeNull();
    expect(q('wb-mode-pill')?.textContent).toContain('半自动');
    expect(q('wb-page')?.getAttribute('data-mode')).toBe('semi');
  });

  it('识别失败：红条显示原因且回退为待识别（可重试）', async () => {
    const spies = makeSpies();
    const failing: MofangAiBridge = {
      ...makeAi(spies),
      invoke: (async () => ({ ok: false, error: 'HTTP 429：rate limited', latencyMs: 5 })) as MofangAiBridge['invoke'],
    };
    render(
      <WorkbenchPage runId={RUN_ID} recog={makeRecog(spies)} ai={failing} bank={makeBank(spies)} ext={makeExt(spies)} />,
    );
    await settle();
    click(q('wb-ai-one-click')!);
    await settle();
    await settle();
    const err = q('wb-error-c1');
    expect(err).not.toBeNull();
    expect(err?.textContent).toContain('HTTP 429');
    expect(q('wb-recognize-c1')).not.toBeNull();
  });

  it('批量入库：点击即入库（0046 目检返工④ 用户拍板去掉二次确认弹窗；进度条给反馈）', async () => {
    const spies = makeSpies();
    renderWorkbench(spies);
    await settle();
    click(q('wb-ai-one-click')!);
    await settle();
    await settle();
    expect(q('wb-selected-count')?.textContent).toBe('1');
    click(q('wb-batch-commit')!);
    expect(q('wb-confirm-batch-commit')).toBeNull(); // 弹层不再出现
    await settle();
    expect(spies.createdQuestions).toHaveLength(1);  // 直接落库
  });
});

// ==================== 2026-09-20 目检返工 ====================

describe('0040 返工：左栏滚动区 / 选项结构化', () => {
  function pointer(type: string, x: number, y: number): MouseEvent {
    return new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  }

  it('① 左栏拆两层：缩放工具栏不在滚动容器内（滚动只滚页图区）', async () => {
    const spies = makeSpies();
    renderWorkbench(spies);
    await settle();
    const col = q('wb-source-col')!;
    const tools = q('wb-src-tools');
    const scroll = q('wb-pages-scroll')!;
    expect(tools).not.toBeNull();
    // 工具栏与页图区是同级：工具栏在滚动容器之外（在容器内就会被一起滚走）
    expect(scroll.contains(tools!)).toBe(false);
    expect(tools!.parentElement).toBe(scroll.parentElement);
    expect(col.contains(scroll)).toBe(true);
    // 滚动容器就是页图区本身
    expect(scroll.className).toContain('wb-src-pages');
  });

  it('② 左栏叠加层随缩放变化（图块红框：缩放后位置按显示尺寸换算，不是原图尺寸）', async () => {
    const spies = makeSpies();
    renderWorkbench(spies);
    await settle();
    click(q('wb-ai-one-click')!);
    await settle();
    await settle();
    const mark = q('wb-figure-c1-0') as HTMLElement | null;
    expect(mark).not.toBeNull();
    const leftAt = (): number => Number.parseFloat(mark!.style.left);
    // 图块 bbox 归一化 [0.1,0.2,0.4,0.4]（DSO 留档 0-999 口径）→ 页宽 1000px × zoom
    expect(leftAt()).toBeCloseTo(100, 0);
    click(q('wb-zoom-in')!);
    expect(leftAt()).toBeCloseTo(120, 0);          // 1.2 倍：位置跟着缩放走
    expect(Number.parseFloat(mark!.style.width)).toBeCloseTo(360, 0);
  });

  it('② 拖动图块框 → 题卡里的图实时换（松手前内容态不动）', async () => {
    const spies = makeSpies();
    renderWorkbench(spies);
    await settle();
    click(q('wb-ai-one-click')!);
    await settle();
    await settleUntil(() => q('wb-editor-wrap-c1')?.querySelector('figure.diagram img.q-figure') != null);

    const img = () => q('wb-editor-wrap-c1')!.querySelector<HTMLImageElement>('figure.diagram img.q-figure')!;
    expect(img().dataset['livePreview']).toBeUndefined();
    // 返工①：图块宽高来自本次裁图（mock 320×200），不是 FigureNode 的兜底 220×120（那会压扁图）
    expect(Number.parseFloat(img().style.width)).toBe(320);
    expect(Number.parseFloat(img().style.height)).toBe(200);
    const savedBefore = spies.savedStates.length;

    const mark = q('wb-figure-c1-0') as HTMLElement;
    await act(async () => {
      mark.dispatchEvent(pointer('pointerdown', 120, 220));
      window.dispatchEvent(pointer('pointermove', 200, 300));
    });
    expect(img().dataset['livePreview']).toBe('1');       // 拖动中：题卡里的图已被实时替换
    expect(Number.parseFloat(img().style.width)).toBe(320); // 尺寸来自本次裁图（mock: 320×200）

    await act(async () => { window.dispatchEvent(pointer('pointerup', 200, 300)); });
    await settle();
    expect(spies.savedStates.length).toBeGreaterThanOrEqual(savedBefore);
  });

  it('④ 模型把选项写进题干 → 题卡里出结构化选项（.options > .option），题干不再平铺选项行', async () => {
    const spies = makeSpies();
    const inlineOptions = JSON.stringify({
      questions: [{
        qno: '3',
        questionType: '单选',
        stemMarkdown: '下列判断正确的是（  ）\nA．甲．物体受浮力\nB．乙．浮力随深度增大\nC．丙．与体积无关\nD．丁．以上都对',
        options: null,
        answerMarkdown: null,
        analysisMarkdown: null,
        suggestedTags: ['浮力'],
      }],
      figures: [],
    });
    renderWorkbench(spies, { mainJson: inlineOptions });
    await settle();
    click(q('wb-ai-one-click')!);
    await settle();
    await settleUntil(() => container.querySelector('.options .option') !== null);

    const optionNodes = [...container.querySelectorAll('.options .option')];
    // 0045 P4：选项行 NodeView 行尾带 ✕ 删除控件（hover 出现）——textContent 剥离控件字符后断言内容不变
    expect(optionNodes.map((n) => (n.textContent ?? '').replace(/✕$/, ''))).toEqual([
      'A. 甲．物体受浮力', 'B. 乙．浮力随深度增大', 'C. 丙．与体积无关', 'D. 丁．以上都对',
    ]);
    // 题干段落只剩题干（选项行已移出正文）
    const stemParas = [...container.querySelectorAll('.q-content > p')].map((p) => p.textContent ?? '');
    expect(stemParas.join('|')).toContain('下列判断正确的是');
    expect(stemParas.join('|')).not.toContain('甲．物体受浮力');
    // 还原是留痕的（核验黄条）
    expect(q('wb-warn-c1')?.textContent).toContain('选项由题干正文还原');
  });
});

// ==================== 手动框选（P3，垫底档） ====================

describe('0040 P3：手动框选（不依赖任何模型）', () => {
  function pointer(type: string, x: number, y: number): MouseEvent {
    return new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  }

  it('拖出框 → 四动作条 → 「加入右侧待识别」出待识别卡', async () => {
    const spies = makeSpies();
    render(
      <WorkbenchPage runId={RUN_ID} recog={makeRecog(spies)} ai={makeAi(spies, { enabled: false })} bank={makeBank(spies)} ext={makeExt(spies)} />,
    );
    await settle();
    // 半自动档也应有框选能力（垫底档不受模型配置影响）
    click(q('wb-frame-toggle')!);
    const page = q('wb-page-1')!;
    await act(async () => {
      page.dispatchEvent(pointer('pointerdown', 100, 200));
      window.dispatchEvent(pointer('pointermove', 500, 800));
      window.dispatchEvent(pointer('pointerup', 500, 800));
    });
    expect(q('wb-frame-draft')).not.toBeNull();
    expect(q('wb-frame-to-new')).not.toBeNull();
    expect(q('wb-frame-merge')).not.toBeNull();
    expect(q('wb-frame-copy')).not.toBeNull();

    click(q('wb-frame-to-new')!);
    expect(container.textContent).toContain('已加入右侧待识别');
    expect(q('wb-recognize-c1')).not.toBeNull();
  });

  it('无待识别卡时「并入最新待识别」→ 明确提示（不静默）', async () => {
    const spies = makeSpies();
    render(
      <WorkbenchPage runId={RUN_ID} recog={makeRecog(spies)} ai={makeAi(spies, { enabled: false })} bank={makeBank(spies)} ext={makeExt(spies)} />,
    );
    await settle();
    click(q('wb-frame-toggle')!);
    const page = q('wb-page-1')!;
    await act(async () => {
      page.dispatchEvent(pointer('pointerdown', 100, 200));
      window.dispatchEvent(pointer('pointermove', 500, 800));
      window.dispatchEvent(pointer('pointerup', 500, 800));
    });
    click(q('wb-frame-merge')!);
    expect(container.textContent).toContain('没有待识别题');
  });

  it('「📋 复制」→ 剪贴板条出现并给出题卡粘贴入口', async () => {
    const spies = makeSpies();
    render(
      <WorkbenchPage runId={RUN_ID} recog={makeRecog(spies)} ai={makeAi(spies, { enabled: false })} bank={makeBank(spies)} ext={makeExt(spies)} />,
    );
    await settle();
    click(q('wb-frame-toggle')!);
    const page = q('wb-page-1')!;
    await act(async () => {
      page.dispatchEvent(pointer('pointerdown', 100, 200));
      window.dispatchEvent(pointer('pointermove', 500, 800));
      window.dispatchEvent(pointer('pointerup', 500, 800));
    });
    click(q('wb-frame-copy')!);
    expect(q('wb-clip-bar')).not.toBeNull();
    expect(container.textContent).toContain('已复制框选内容');
    click(q('wb-clip-clear')!);
    expect(q('wb-clip-bar')).toBeNull();
  });
});

// ==================== 知识节点弹层（P5.3） ====================

describe('0040 P5：知识节点选择弹层（搜索 + 任意层级）', () => {
  it('打开弹层 → 树/节点加载 → 搜索过滤 → 选中任意层级并确认挂载', async () => {
    const spies = makeSpies();
    render(
      <WorkbenchPage runId={RUN_ID} recog={makeRecog(spies)} ai={makeAi(spies)} bank={makeBank(spies)} ext={makeExt(spies)} />,
    );
    await settle();
    click(q('wb-ai-one-click')!);
    await settle();
    await settle();

    click(q('wb-tree-picker-c1')!);
    await settle();
    expect(q('wb-tree-picker')).not.toBeNull();
    expect(q('wb-tm-stage')?.textContent).toContain('不限学段');
    // 0054 R-049③：默认展开一级——第一级「力学」已展开，其子节点直接可见
    expect(q('wb-tree-node-n-mech')).not.toBeNull();
    expect(q('wb-tree-node-n-floating')).not.toBeNull();
    // 折叠/展开交互照旧
    click(q('wb-tree-toggle-n-mech')!);
    expect(q('wb-tree-node-n-floating')).toBeNull();
    click(q('wb-tree-toggle-n-mech')!);
    expect(q('wb-tree-node-n-floating')).not.toBeNull();

    setInput('[data-testid="wb-tm-search"]', '浮力');
    expect(q('wb-tree-node-n-floating')).not.toBeNull();

    click(q('wb-tree-node-n-floating')!);
    expect(q('wb-tm-path')?.textContent).toContain('浮力');
    click(q('wb-tm-confirm')!);
    expect(q('wb-tree-picker')).toBeNull();
    expect(q('wb-tree-adopted-c1')?.textContent).toContain('浮力');
  });
});
