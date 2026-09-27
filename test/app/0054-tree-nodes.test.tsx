// 0054（R-045③④⑤①②）：工作台一题多知识节点 + 建议默认开启/默认选中 + 术语「知识节点」。
// 服务全部注入假桥（不摸真 IPC）；裁图模块被替换（jsdom 无 canvas）。
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { act } from 'react';

import type { MofangAiBridge, MofangRecogBridge } from '../../src/shared/contracts/bridge.js';
import type { BankExtServices, BankService, DictEntry, Question } from '../../src/shared/contracts/bank-types.js';
import type { AiInvokeResult } from '../../src/shared/contracts/ai-types.js';
import type { RecogRun, RecogRunDetail } from '../../src/shared/contracts/recog-run-types.js';
import type { RecogSaveAsPaperPayload, RecogSaveAsPaperResult } from '../../src/shared/contracts/ipc-channels.js';
import type { WorkbenchState } from '../../src/shared/contracts/onestep-types.js';
import type { PageImageLike } from '../../src/app/workbench/crop.js';
import { createMockExtServices } from '../../src/bank/mock/mock-ext.js';
import { MockBankStore } from '../../src/bank/mock/mock-store.js';
import { MockBankService } from '../../src/bank/mock/mock-bank.js';

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

import { WorkbenchPage } from '../../src/app/pages/WorkbenchPage.js';
import { clearPendingImages } from '../../src/app/workbench/handoff.js';
import { clearPendingPdf } from '../../src/app/splitting/handoff.js';
import { INITIAL_STAGE_SUBJECT, setStageSubject } from '../../src/app/state/stage-subject.js';

const NOW = '2026-09-23T10:00:00.000Z';
const RUN_ID = 'run-0054';

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

/** 建议夹具：两条（浮力=叶子 / 力学=第一级）——覆盖「一题多节点」与逐个取消/追加 */
const SUGGESTIONS = [
  { questionId: 'draft-1', kind: 'tree-node', targetId: 'n-floating', targetLabel: '力学 › 浮力', confidence: 0.86, evidenceSummary: '题目 draft-1' },
  { questionId: 'draft-1', kind: 'tree-node', targetId: 'n-mech', targetLabel: '力学', confidence: 0.71, evidenceSummary: '题目 draft-1' },
];

interface Harness {
  /** 预置工作台状态（草稿恢复路径；缺省 null = 新 run） */
  state?: WorkbenchState | null;
  /** 第 1 次 treeForDraft 抛错（复现「自动建议静默降级 → 手动兜底」） */
  suggestFailFirst?: boolean;
  /**
   * 识别调用开关（可变闸门）：`fail=true` 期间所有识别调用失败（造出「待识别失败卡」以走单卡识别路径），
   * 置回 false 后再点该卡「▶ 识别」即成功——单卡识别链路的入口。
   */
  invokeGate?: { fail: boolean };
}

interface Spies {
  linkedNodes: Array<[string, string]>;
  createdQuestions: Array<Record<string, unknown>>;
  attached: string[];
  treeForDraft: number;
  treeForDraftSubjects: string[];
  savePayloads: RecogSaveAsPaperPayload[];
  savedStates: WorkbenchState[];
  invokeRoles: string[];
}

function makeSpies(): Spies {
  return {
    linkedNodes: [], createdQuestions: [], attached: [], treeForDraft: 0,
    treeForDraftSubjects: [], savePayloads: [], savedStates: [], invokeRoles: [],
  };
}

function makeRecog(spies: Spies, h: Harness): MofangRecogBridge {
  const run: RecogRun = {
    id: RUN_ID, status: 'done', stage: 'done', sourceKind: 'image', sourceName: '浮力练习.png',
    pageCount: 1, pagesDone: 1, error: null, warnings: [], questionIds: [],
    createdAt: NOW, updatedAt: NOW, finishedAt: NOW,
  };
  let state = h.state ?? null;
  return {
    create: async () => ({ runId: RUN_ID, pageCount: 1 }),
    status: async (): Promise<RecogRunDetail> => ({
      run,
      runDir: 'C:/tmp/run',
      pages: [{ runId: RUN_ID, pageNo: 1, imageFile: 'pages/p001.png', ocrFile: null, status: 'done', textChars: 0, imageRefCount: 0, error: null, updatedAt: NOW, imagePath: 'C:/tmp/run/pages/p001.png', ocrText: '' }],
      drafts: [],
    }),
    cancel: async () => run,
    history: async () => [run],
    attachQuestions: async (p) => { spies.attached.push(...p.questionIds); return run; },
    resume: async () => run,
    onEvent: () => () => undefined,
    workbench: {
      load: async () => state,
      save: async (p) => { state = p.state; spies.savedStates.push(p.state); return { savedAt: NOW }; },
    },
    draftWrite: async (p) => ({ savedAt: NOW, draftCount: p.drafts.length, warnings: [] }),
    saveAsPaper: async (p): Promise<RecogSaveAsPaperResult> => {
      spies.savePayloads.push(p);
      return { paperId: 'paper-1', questionIds: p.cards.map((_c, i) => `q-${i + 1}`) };
    },
  };
}

function makeAi(spies: Spies, h: Harness): MofangAiBridge {
  const invoke = async (payload: { role: string; messages: Array<{ content: unknown }> }): Promise<AiInvokeResult> => {
    spies.invokeRoles.push(payload.role);
    if (h.invokeGate?.fail) return { ok: false, error: 'simulated invoke failure', latencyMs: 5 };
    const text = payload.messages.map((m) => textOf(m.content)).join(' ');
    if (text.includes('<|ref|>image<|/ref|>') || text.includes('Convert the document to markdown')) {
      return { ok: true, content: DSO_RAW, latencyMs: 3 };
    }
    return { ok: true, content: MAIN_JSON, latencyMs: 40 };
  };
  return {
    profile: {
      list: async () => [
        { id: 'p1', role: 'vision' as const, name: 'OCR', provider: 'x', protocol: 'openai-chat', baseUrl: 'https://x', model: 'deepseek-ocr', capability: null, isEnabled: true, hasKey: true, lastTestAt: NOW, lastTestOk: true, createdAt: NOW, updatedAt: NOW },
        { id: 'p2', role: 'reasoning' as const, name: 'VLM', provider: 'x', protocol: 'openai-chat', baseUrl: 'https://x', model: 'deepseek-flash', capability: null, isEnabled: true, hasKey: true, lastTestAt: NOW, lastTestOk: true, createdAt: NOW, updatedAt: NOW },
      ],
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
        if (h.suggestFailFirst && spies.treeForDraft === 1) throw new Error('simulated suggest failure');
        return {
          status: 'ok', reason: null,
          meta: { stage: '初中', subjectId: 'subj:physics', questionCount: 1, treeCount: 1, totalNodeCount: 5, injectedNodeCount: 5, truncatedNodeCount: 0, injectedTokens: 100 },
          warnings: [], none: false,
          suggestions: SUGGESTIONS,
          tagSuggestions: [], drafts: [], duplicates: [], latencyMs: 120,
        };
      },
    },
  } as unknown as MofangAiBridge;
}

function makeBank(spies: Spies): BankService {
  const base = new MockBankService(new MockBankStore(), false);
  return {
    ...base,
    createQuestion: async (data) => {
      spies.createdQuestions.push(data as unknown as Record<string, unknown>);
      return { ...data, id: `q-${spies.createdQuestions.length}`, createdAt: NOW, updatedAt: NOW } as Question;
    },
    addTag: async () => undefined,
    deleteQuestion: async () => undefined,
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
        id: 't1', type: 'knowledge', subjectId: 'subj:physics', stage: '初中', name: '组卷网·知识点·初中物理',
        createdAt: NOW,
      }],
      getNodes: async () => [
        { id: 'n-mech', treeId: 't1', parentId: null, name: '力学', sort: 1, createdAt: NOW },
        { id: 'n-floating', treeId: 't1', parentId: 'n-mech', name: '浮力', sort: 1, createdAt: NOW },
        { id: 'n-pressure', treeId: 't1', parentId: 'n-mech', name: '压强', sort: 2, createdAt: NOW },
      ],
      linkQuestion: async (questionId, nodeId) => { spies.linkedNodes.push([questionId, nodeId]); },
    },
  } as unknown as BankExtServices;
}

let container: HTMLDivElement;
let root: Root | null = null;

function render(node: React.ReactElement): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => { root!.render(node); });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

function click(el: Element | null): void {
  if (!el) throw new Error('找不到可点元素');
  flushSync(() => { (el as HTMLElement).click(); });
}

function q<T extends Element>(testid: string): T | null {
  return container.querySelector<T>(`[data-testid="${testid}"]`);
}

async function waitFor(assertion: () => void): Promise<void> {
  await vi.waitFor(assertion, { timeout: 3000, interval: 20 });
}

/** 打开知识节点弹层并等树节点就绪（默认展开一级 → 子级可见） */
async function openPicker(cardId: string, expectedNodeId: string): Promise<void> {
  click(q(`wb-tree-picker-${cardId}`));
  await waitFor(() => {
    if (!q(`wb-tree-node-${expectedNodeId}`)) throw new Error('弹层节点未就绪');
  });
}

const DEFAULTS = { stage: '初中', subjectId: 'subj:physics', paperTitle: '浮力练习.png' };

function renderWorkbench(spies: Spies, h: Harness = {}): void {
  render(
    <WorkbenchPage
      runId={RUN_ID}
      recog={makeRecog(spies, h)}
      ai={makeAi(spies, h)}
      bank={makeBank(spies)}
      ext={makeExt(spies)}
      defaults={DEFAULTS}
    />,
  );
}

/** AI 一键录入 → 出题卡（识别完成） */
async function aiRecognize(spies: Spies, h: Harness = {}): Promise<void> {
  renderWorkbench(spies, h);
  await settle();
  click(q('wb-ai-one-click'));
  await settle();
  await settle();
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

// ==================== 自动出建议 + 默认选中（R-045①②） ====================

describe('0054 R-045①②：识别完成自动出知识节点建议并默认选中（确认层不跳过）', () => {
  it('识别完成后：AI 生成标签默认选中（可逐个点掉），知识节点同样默认选中', async () => {
    const spies = makeSpies();
    await aiRecognize(spies);

    // 2026-09-23 目检反馈：AI 生成的标签也默认选中（与知识节点同口径），点一下即取消
    expect(q('wb-tag-c1-浮力')?.getAttribute('aria-pressed')).toBe('true');
    expect(q('wb-tag-c1-阿基米德原理')?.getAttribute('aria-pressed')).toBe('true');
    click(q('wb-tag-c1-浮力'));
    expect(q('wb-tag-c1-浮力')?.getAttribute('aria-pressed')).toBe('false');
    expect(q('wb-tag-c1-阿基米德原理')?.getAttribute('aria-pressed')).toBe('true');
    click(q('wb-tag-c1-浮力'));
    expect(q('wb-tag-c1-浮力')?.getAttribute('aria-pressed')).toBe('true');

    // 知识节点同口径
    expect(q('wb-tree-adopted-c1-n-floating')).not.toBeNull();
    expect(q('wb-tree-adopted-c1-n-mech')).not.toBeNull();
  });

  it('AI 一键录入后：无需点按钮即出建议，且多节点默认已选中', async () => {
    const spies = makeSpies();
    await aiRecognize(spies);

    // 自动触发一次（人没点任何按钮）
    expect(spies.treeForDraft).toBe(1);
    expect(spies.treeForDraftSubjects).toEqual(['subj:physics']);

    // 默认选中：两条建议都已在 adoptedNodes（chip 呈选中态）
    expect(q('wb-tree-adopted-c1-n-floating')?.textContent).toContain('浮力');
    expect(q('wb-tree-adopted-c1-n-mech')?.textContent).toContain('力学');
    // 组容器（保号 testid）内容是全部已采纳节点
    expect(q('wb-tree-adopted-c1')?.textContent).toContain('浮力');
    expect(q('wb-tree-adopted-c1')?.textContent).toContain('力学');
    // 建议非空 → 兜底按钮不出现；手动入口恒在
    expect(q('wb-tree-suggest-btn-c1')).toBeNull();
    expect(q('wb-tree-picker-c1')).not.toBeNull();
    // 识别完成的消息不被建议流程冲掉（自动路径静默）
    expect(container.textContent).toContain('AI 一键录入完成');
  });

  it('单卡识别（待识别卡 ▶ 识别）同样自动出建议并默认选中', async () => {
    const spies = makeSpies();
    // 识别闸门先关死 → 落「待识别失败卡」；开闸后再点该卡 ▶ 识别 走单卡识别路径（recognizeCard）
    const gate = { fail: true };
    await aiRecognize(spies, { invokeGate: gate });
    const errEl = container.querySelector('[data-testid^="wb-error-"]');
    expect(errEl).not.toBeNull();
    expect(spies.treeForDraft).toBe(0); // 识别未成功 → 不触发建议
    const cardId = errEl!.getAttribute('data-testid')!.replace('wb-error-', '');

    gate.fail = false;
    click(q(`wb-recognize-${cardId}`));
    await settle();
    await settle();

    expect(spies.treeForDraft).toBe(1);
    expect(q(`wb-tree-adopted-${cardId}-n-floating`)).not.toBeNull();
    expect(q(`wb-tree-adopted-${cardId}-n-mech`)).not.toBeNull();
  });
});

// ==================== 自动建议静默降级 + 手动兜底 ====================

describe('0054 R-045①②：自动建议失败静默降级，手动按钮兜底（不阻塞识别主流程）', () => {
  it('自动失败：不弹错、建议为空、兜底按钮可点；点它 → 读条 → chips 待选（不自动采纳）', async () => {
    const spies = makeSpies();
    await aiRecognize(spies, { suggestFailFirst: true });

    expect(spies.treeForDraft).toBe(1);
    // 静默：识别完成消息仍在，未出现建议失败红条
    expect(container.textContent).toContain('AI 一键录入完成');
    expect(container.textContent).not.toContain('simulated suggest failure');
    // 建议为空 → 兜底按钮（文案已换「知识节点」）
    expect(q('wb-tree-suggest-btn-c1')?.textContent).toContain('出知识节点建议');
    expect(q('wb-tree-adopted-c1-n-floating')).toBeNull();

    click(q('wb-tree-suggest-btn-c1'));
    expect(q('wb-tree-prog-c1')?.textContent).toContain('知识节点建议生成中');
    await settle();
    expect(q('wb-tree-prog-c1')).toBeNull();
    // 手动路径 = 只出建议不自动采纳（P-07 人确认）
    expect(q('wb-tree-suggest-c1-n-floating')?.textContent).toContain('浮力');
    expect(q('wb-tree-adopted-c1-n-floating')).toBeNull();

    // 点建议 chip → 采纳（追加语义）
    click(q('wb-tree-suggest-c1-n-floating'));
    expect(q('wb-tree-adopted-c1-n-floating')?.textContent).toContain('浮力');
  });
});

// ==================== 多节点：追加 / 去重 / 逐个取消 / 落库 ====================

describe('0054 R-045③④：一题多知识节点（追加 / 逐个取消 / 去重 / 落库循环）', () => {
  it('逐个取消 → 建议 chip 复现 → 再点追加；弹层手动加节点为追加且同节点去重', async () => {
    const spies = makeSpies();
    await aiRecognize(spies, { suggestFailFirst: true });
    click(q('wb-tree-suggest-btn-c1'));
    await settle();
    click(q('wb-tree-suggest-c1-n-floating'));
    click(q('wb-tree-suggest-c1-n-mech'));
    expect(q('wb-tree-adopted-c1-n-floating')).not.toBeNull();
    expect(q('wb-tree-adopted-c1-n-mech')).not.toBeNull();

    // 逐个取消：点 chip 一次只取消它自己
    click(q('wb-tree-adopted-c1-n-mech'));
    expect(q('wb-tree-adopted-c1-n-mech')).toBeNull();
    expect(q('wb-tree-adopted-c1-n-floating')).not.toBeNull();
    // 取消后该条建议 chip 复现（可再挂）
    expect(q('wb-tree-suggest-c1-n-mech')).not.toBeNull();
    click(q('wb-tree-suggest-c1-n-mech'));
    expect(q('wb-tree-adopted-c1-n-mech')).not.toBeNull();

    // 弹层手动加节点：追加（不替换已采纳）
    await openPicker('c1', 'n-pressure');
    click(q('wb-tree-node-n-pressure'));
    click(q('wb-tm-confirm'));
    expect(q('wb-tree-adopted-c1-n-pressure')?.textContent).toContain('压强');
    expect(q('wb-tree-adopted-c1-n-floating')).not.toBeNull();

    // 同节点去重：再确认一次已采纳节点 → 不新增
    await openPicker('c1', 'n-pressure');
    click(q('wb-tree-node-n-pressure'));
    click(q('wb-tm-confirm'));
    expect(container.querySelectorAll('[data-testid^="wb-tree-adopted-c1-"]').length).toBe(3);
  });

  it('普通入库：逐节点 linkQuestion（3 个节点全落链）+ 锁定条按实数显示', async () => {
    const spies = makeSpies();
    await aiRecognize(spies);
    // 自动采纳两条 → 弹层再加一条，凑三个节点
    await openPicker('c1', 'n-pressure');
    click(q('wb-tree-node-n-pressure'));
    click(q('wb-tm-confirm'));

    click(q('wb-commit-c1'));
    await settle();

    const nodeIds = spies.linkedNodes.map(([, nodeId]) => nodeId).sort();
    expect(nodeIds).toEqual(['n-floating', 'n-mech', 'n-pressure']);
    expect(spies.linkedNodes.every(([qid]) => qid === 'q-1')).toBe(true);
    expect(q('wb-committed-c1')?.textContent).toContain('知识节点 ×3');
  });

  it('存为试卷链：payload 带 adoptedNodes 多值（adoptedNode 保首节点兼容）', async () => {
    const spies = makeSpies();
    await aiRecognize(spies);
    click(q('wb-save-as-paper'));
    await settle();
    click(q('wb-save-as-paper-save'));
    await settle();

    expect(spies.savePayloads).toHaveLength(1);
    const card = spies.savePayloads[0]!.cards[0]!;
    expect(card.adoptedNodes?.map((n) => n.nodeId)).toEqual(['n-floating', 'n-mech']);
    expect(card.adoptedNode?.nodeId).toBe('n-floating');
  });
});

// ==================== 读侧归一：旧草稿（单值 adoptedNode） ====================

describe('0054 R-045③：旧 workbench.json 草稿（只有 adoptedNode）无损加载', () => {
  it('旧草稿单值照常呈现为已采纳 chip，取消后落多值空态', async () => {
    const spies = makeSpies();
    const legacyState: WorkbenchState = {
      version: 1, runId: RUN_ID, mode: 'auto', stage: '初中', subjectId: 'subj:physics',
      paperTitle: '浮力练习.png', pages: [{ pageNo: 1, name: 'p001.png', width: 1000, height: 1400 }],
      cards: [{
        id: 'c1', status: 'question', source: 'ai', checked: true, frames: [],
        error: null, qno: '2-17', typeCode: 'qtype:blank',
        contentHtml: '<div class="question"><p>甲</p></div>', answerHtml: '<p>B</p>', analysisHtml: '',
        figures: [], figureSource: 'none', warnings: [], tags: [], adoptedTags: [],
        treeSuggestions: [],
        // 旧字段：只有单值（0054 之前落盘的草稿形态）
        adoptedNode: { nodeId: 'n-legacy', label: '旧草稿节点' },
        committedQuestionId: null,
      }],
      nextSeq: 2, updatedAt: NOW,
    };
    renderWorkbench(spies, { state: legacyState });
    await settle();

    expect(q('wb-tree-adopted-c1-n-legacy')?.textContent).toContain('旧草稿节点');
    // 取消（写侧落多值空态）后不再呈现
    click(q('wb-tree-adopted-c1-n-legacy'));
    expect(q('wb-tree-adopted-c1-n-legacy')).toBeNull();
  });
});

// ==================== 术语（R-045⑤） ====================

describe('0054 R-045⑤：UI 文案统一「知识节点」（不再出现「挂树」）', () => {
  it('识别→建议→入库全流程的工作台 UI 文案零「挂树」', async () => {
    const spies = makeSpies();
    await aiRecognize(spies);
    click(q('wb-commit-c1'));
    await settle();
    expect(container.textContent).not.toContain('挂树');
    // 「知识节点」在采纳行出现
    expect(container.textContent).toContain('知识节点');
  });

  it('树选择弹层标题与确认钮文案已换（选择知识节点 / 确认挂载→追加语义保留）', async () => {
    const spies = makeSpies();
    await aiRecognize(spies);
    await openPicker('c1', 'n-mech');
    // 弹层标题由 Modal 头渲染（不在 wb-tree-picker 容器内）→ 全页断言
    expect(container.textContent).toContain('选择知识节点');
    expect(container.textContent).toContain('确认挂载');
    expect(container.textContent).not.toContain('挂树');
  });
});
