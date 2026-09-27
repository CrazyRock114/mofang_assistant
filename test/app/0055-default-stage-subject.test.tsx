// 0055（R-044）：默认学段-学科设置——localStorage 真源 + 设置页卡片 + 各页默认值接线。
// 口径（任务书 §一.1，拍板①②③按规划建议值）：优先级 = 设置值 > 上次值 > 空；设置值读取=挂载/复位时；
// CapturePage 的「高中数学」硬编码默认让位设置值（未设置时维持现默认）；
// ExamsPage/MistakesPage 仅接学科默认（其学段选择器是错题三态，勿接）。
// @vitest-environment jsdom

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import type { MofangAiBridge, MofangRecogBridge } from '../../src/shared/contracts/bridge.js';
import type { RecogRun, RecogRunDetail } from '../../src/shared/contracts/recog-run-types.js';
import type { AiInvokeResult } from '../../src/shared/contracts/ai-types.js';

import { SettingsPage } from '../../src/app/pages/SettingsPage.js';
import { WorkbenchPage } from '../../src/app/pages/WorkbenchPage.js';
import { CapturePage } from '../../src/app/pages/CapturePage.js';
import { ExamsPage } from '../../src/app/pages/ExamsPage.js';
import { MistakesPage } from '../../src/app/pages/MistakesPage.js';
import { CaptureClient } from '../../src/app/services/capture-client.js';
import { MockBankService } from '../../src/bank/mock/mock-bank.js';
import { createMockExtServices } from '../../src/bank/mock/mock-ext.js';
import { MockBankStore } from '../../src/bank/mock/mock-store.js';
import type { ExtPageServices } from '../../src/app/pages/ExtUi.js';

/** 设置项 localStorage key（任务书 §零.3 建议值） */
const DEFAULT_KEY = 'mfa-default-stage-subject';

const NOW = '2026-09-23T10:00:00.000Z';
const RUN_ID = 'run-0055-1';

function storeDefault(value: { stage?: string; subjectId?: string } | string): void {
  localStorage.setItem(DEFAULT_KEY, typeof value === 'string' ? value : JSON.stringify(value));
}

// ---------------- 测试世界 ----------------

interface World {
  svc: ExtPageServices;
  store: MockBankStore;
}

/** mock 世界：字典含归一学科「物理」（id=subj:physics），与真实字典归一行同构 */
async function seedWorld(): Promise<World> {
  const store = new MockBankStore();
  const bank = new MockBankService(store, false);
  const ext = createMockExtServices(store);
  await ext.dict.createEntry({ kind: 'subject', code: 'physics', label: '物理' });
  return { svc: { bank, ext }, store };
}

let container: HTMLDivElement;
let root: Root | null = null;

function render(ui: ReactElement) {
  root?.unmount();
  container?.remove();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => { root!.render(ui); });
}

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  localStorage.removeItem(DEFAULT_KEY);
  window.location.hash = '';
  delete window.__mofangPaths;
});

beforeEach(() => {
  localStorage.removeItem(DEFAULT_KEY);
});

function q<T extends HTMLElement>(testid: string): T | null {
  return container.querySelector(`[data-testid="${testid}"]`) as T | null;
}

function click(testid: string) {
  const el = q<HTMLButtonElement>(testid);
  if (!el) throw new Error(`找不到元素: ${testid}`);
  flushSync(() => el.click());
}

function setSelect(testid: string, value: string) {
  const el = q<HTMLSelectElement>(testid);
  if (!el) throw new Error(`找不到下拉: ${testid}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  flushSync(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function optionTexts(testid: string): string[] {
  const el = q<HTMLSelectElement>(testid);
  if (!el) throw new Error(`找不到下拉: ${testid}`);
  return [...el.options].map((o) => o.text);
}

async function waitFor(assertion: () => void) {
  await vi.waitFor(assertion, { timeout: 3000, interval: 20 });
}

// ---------------- 工作台假桥（照 workbench-pages.test.tsx 最小形态） ----------------

function makeRecog(): MofangRecogBridge {
  const run: RecogRun = {
    id: RUN_ID, status: 'done', stage: 'done', sourceKind: 'image', sourceName: null,
    pageCount: 0, pagesDone: 0, error: null, warnings: [], questionIds: [],
    createdAt: NOW, updatedAt: NOW, finishedAt: NOW,
  };
  return {
    create: async () => ({ runId: RUN_ID, pageCount: 0 }),
    status: async (): Promise<RecogRunDetail> => ({ run, runDir: 'C:/tmp/run-0055', pages: [], drafts: [] }),
    cancel: async () => run,
    history: async () => [run],
    attachQuestions: async () => run,
    resume: async () => run,
    onEvent: () => () => undefined,
    workbench: {
      load: async () => null,
      save: async () => ({ savedAt: NOW }),
    },
    saveAsPaper: async () => { throw new Error('unused'); },
    draftWrite: async (p) => ({ savedAt: NOW, draftCount: p.drafts.length, warnings: [] }),
  };
}

function makeAi(): MofangAiBridge {
  return {
    profile: {
      list: async () => [],
      create: async () => { throw new Error('unused'); },
      update: async () => { throw new Error('unused'); },
      delete: async () => undefined,
      setEnabled: async () => { throw new Error('unused'); },
      testConnection: async () => ({ ok: false, latencyMs: null, error: 'unused' }),
    },
    invoke: (async () => ({ ok: false, error: 'unused' })) as unknown as MofangAiBridge['invoke'],
    models: { list: async () => ({ ok: false, models: [], error: 'unused' }) },
    suggest: {
      anchorStatus: async () => { throw new Error('unused'); },
      treeLink: async () => { throw new Error('unused'); },
      tags: async () => { throw new Error('unused'); },
      treeForDraft: async () => { throw new Error('unused'); },
    },
  } satisfies MofangAiBridge;
}

describe('0055 R-044 默认学段-学科：设置页卡片', () => {
  it('设置页主视图有「默认学段学科」卡：学段选项=trees.stage ∪ 四值硬编码（去重保序），学科=字典归一行', async () => {
    const store = new MockBankStore();
    const ext = createMockExtServices(store);
    await ext.dict.createEntry({ kind: 'subject', code: 'physics', label: '物理' });
    // 真库含中职（r025-tree-stats 在案）：两棵树同为中职 → 去重为一档
    await ext.tree.createTree({ type: 'knowledge', name: '中职数学知识点', stage: '中职', subjectId: 'subj:physics' });
    await ext.tree.createTree({ type: 'knowledge', name: '中职数学知识点（二）', stage: '中职', subjectId: 'subj:physics' });

    render(<SettingsPage ext={ext} />);
    await waitFor(() => { if (!q('settings-default-stage-subject')) throw new Error('默认学段学科卡未出现'); });

    expect(optionTexts('settings-default-stage-select')).toEqual(['（不设置）', '小学', '初中', '高中', '中职']);
    await waitFor(() => {
      expect(optionTexts('settings-default-subject-select')).toEqual(['（不设置）', '物理']);
    });
    // 默认值=空（不打扰未设置用户）
    expect(q<HTMLSelectElement>('settings-default-stage-select')!.value).toBe('');
    expect(q<HTMLSelectElement>('settings-default-subject-select')!.value).toBe('');
  });

  it('改选即写 localStorage（拍板：保存即写，纯偏好不留痕）；清除回落空值', async () => {
    const store = new MockBankStore();
    const ext = createMockExtServices(store);
    await ext.dict.createEntry({ kind: 'subject', code: 'physics', label: '物理' });
    render(<SettingsPage ext={ext} />);
    await waitFor(() => { if (!q('settings-default-stage-subject')) throw new Error('默认学段学科卡未出现'); });

    setSelect('settings-default-stage-select', '高中');
    setSelect('settings-default-subject-select', 'subj:physics');
    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem(DEFAULT_KEY) ?? 'null')).toEqual({ stage: '高中', subjectId: 'subj:physics' });
    });

    setSelect('settings-default-stage-select', '');
    setSelect('settings-default-subject-select', '');
    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem(DEFAULT_KEY) ?? 'null')).toEqual({ stage: '', subjectId: '' });
    });
  });
});

describe('0055 R-044 共享状态：设置值 > 上次值 > 空', () => {
  it('设默认后共享消费方挂载即读设置值；用户临时改再释放 → 复位回设置值（不是空）', async () => {
    storeDefault({ stage: '高中', subjectId: 'subj:physics' });
    const { acquireStageSubject, getStageSubject, setStageSubject } = await import('../../src/app/state/stage-subject.js');

    const release = acquireStageSubject();
    expect(getStageSubject()).toEqual({ stage: '高中', subjectId: 'subj:physics' });

    setStageSubject({ stage: '初中' }); // 上次值：本页内改动仍以用户为准
    expect(getStageSubject()).toEqual({ stage: '初中', subjectId: 'subj:physics' });

    release();
    expect(getStageSubject()).toEqual({ stage: '高中', subjectId: 'subj:physics' }); // 释放复位回设置值
  });

  it('未设置默认（无存储/坏值）→ 复位回空，行为与现状一致（不打扰）', async () => {
    storeDefault('{ 坏 JSON');
    const { acquireStageSubject, getStageSubject, setStageSubject } = await import('../../src/app/state/stage-subject.js');

    const release = acquireStageSubject();
    expect(getStageSubject()).toEqual({ stage: '', subjectId: '' });
    setStageSubject({ stage: '初中', subjectId: 'subj:physics' });
    release();
    expect(getStageSubject()).toEqual({ stage: '', subjectId: '' });
  });

  it('起挂重读有界（0029 顶栏单真源护栏）：空闲期显式设定过的值不被重读清掉；基准态才重读设置', async () => {
    const { acquireStageSubject, getStageSubject, setStageSubject } = await import('../../src/app/state/stage-subject.js');

    const r1 = acquireStageSubject();
    r1(); // 释放 → 基准态（无默认=空）
    setStageSubject({ subjectId: 'subj:physics' }); // 空闲期显式设定 = 上次值
    const r2 = acquireStageSubject();
    expect(getStageSubject()).toEqual({ stage: '', subjectId: 'subj:physics' }); // 不被重读清掉
    r2();

    storeDefault({ stage: '高中', subjectId: 'subj:physics' }); // 空闲期在设置页改默认
    const r3 = acquireStageSubject(); // 基准态 → 重读设置
    expect(getStageSubject()).toEqual({ stage: '高中', subjectId: 'subj:physics' });
    r3();
  });
});

describe('0055 R-044 默认设置模块：读写 / 缺省回退 / 坏值兜底 / 订阅', () => {
  it('无存储 → 空；写入 → 读回（本地存储为真源）；订阅者在写入时收到通知、退订后不再收', async () => {
    const mod = await import('../../src/app/state/default-stage-subject.js');
    expect(mod.readDefaultStageSubject()).toEqual({ stage: '', subjectId: '' });

    const seen: string[] = [];
    const unsubscribe = mod.subscribeDefaultStageSubject(() => seen.push(mod.readDefaultStageSubject().stage));
    mod.writeDefaultStageSubject({ stage: '初中', subjectId: 'subj:physics' });
    expect(mod.readDefaultStageSubject()).toEqual({ stage: '初中', subjectId: 'subj:physics' });
    expect(JSON.parse(localStorage.getItem(DEFAULT_KEY) ?? 'null')).toEqual({ stage: '初中', subjectId: 'subj:physics' });
    expect(seen).toEqual(['初中']);

    unsubscribe();
    mod.writeDefaultStageSubject({ stage: '小学', subjectId: '' });
    expect(seen).toEqual(['初中']);
    // 同存储串恒同一引用（useSyncExternalStore 快照稳定）
    expect(mod.readDefaultStageSubject()).toBe(mod.readDefaultStageSubject());
  });

  it('坏值兜底：非法 JSON / 非对象 / 字段类型不对 → 空（不抛、不污染）；单字段坏只回落该字段', async () => {
    const mod = await import('../../src/app/state/default-stage-subject.js');
    for (const raw of ['{ 坏 JSON', 'null', '"高中"', '123', '[]']) {
      localStorage.setItem(DEFAULT_KEY, raw);
      expect(mod.readDefaultStageSubject(), raw).toEqual({ stage: '', subjectId: '' });
    }
    localStorage.setItem(DEFAULT_KEY, JSON.stringify({ stage: '高中', subjectId: 42 }));
    expect(mod.readDefaultStageSubject()).toEqual({ stage: '高中', subjectId: '' });
  });

  it('stageOptionsWith：当前值不在列表才补项（有值有项）；在列表/空值则零变化', async () => {
    const mod = await import('../../src/app/state/default-stage-subject.js');
    expect(mod.stageOptionsWith(['小学', '初中', '高中'], '')).toEqual(['小学', '初中', '高中']);
    expect(mod.stageOptionsWith(['小学', '初中', '高中'], '初中')).toEqual(['小学', '初中', '高中']);
    expect(mod.stageOptionsWith(['小学', '初中', '高中'], '中职')).toEqual(['小学', '初中', '高中', '中职']);
  });
});

describe('0055 R-044 各页默认值接线', () => {
  it('录题工作台：无入口交接时初始默认归类=设置值（学段+学科选择器同时生效）', async () => {
    storeDefault({ stage: '高中', subjectId: 'subj:physics' });
    const world = await seedWorld();
    render(
      <WorkbenchPage runId={RUN_ID} recog={makeRecog()} ai={makeAi()} bank={world.svc.bank} ext={world.svc.ext} />,
    );
    await waitFor(() => {
      if (!q('wb-stage-select')) throw new Error('工作台未就绪');
      expect(q<HTMLSelectElement>('wb-stage-select')!.value).toBe('高中');
    });
    await waitFor(() => { expect(q<HTMLSelectElement>('wb-subject-select')!.value).toBe('subj:physics'); });
  });

  it('采集页：学段/学科让位设置值（拍板③）；未设置时维持现默认「高中数学」', async () => {
    const world = await seedWorld();
    storeDefault({ stage: '初中', subjectId: 'subj:physics' });
    render(<CapturePage capture={new CaptureClient()} pollIntervalMs={1000} svc={world.svc} />);
    flushSync(() => click('capture-tab-panel'));
    await waitFor(() => {
      if (!q('stage-select')) throw new Error('采集面板未就绪');
      expect(q<HTMLSelectElement>('stage-select')!.value).toBe('初中');
    });
    await waitFor(() => { expect(q<HTMLSelectElement>('subject-select')!.value).toBe('物理'); });

    // 未设置（清掉设置项）：维持现状默认「高中数学」
    localStorage.removeItem(DEFAULT_KEY);
    render(<CapturePage capture={new CaptureClient()} pollIntervalMs={1000} svc={world.svc} />);
    flushSync(() => click('capture-tab-panel'));
    await waitFor(() => {
      if (!q('stage-select')) throw new Error('采集面板未就绪');
      expect(q<HTMLSelectElement>('stage-select')!.value).toBe('高中');
    });
    await waitFor(() => { expect(q<HTMLSelectElement>('subject-select')!.value).toBe('数学'); });
  });

  it('考试页：新建考试弹层学科默认=设置值（仅学科，无学段选择器）', async () => {
    storeDefault({ stage: '高中', subjectId: 'subj:physics' });
    const world = await seedWorld();
    render(<ExamsPage services={world.svc} />);
    await waitFor(() => { if (!q('exam-create-btn')) throw new Error('考试页未就绪'); });
    click('exam-create-btn');
    await waitFor(() => { expect(q<HTMLSelectElement>('exam-subject-select')!.value).toBe('subj:physics'); });
  });

  it('错题本：学科筛选默认=设置学科（label 口径）；学段筛选恒为错题三态语义、不被接默认', async () => {
    storeDefault({ stage: '高中', subjectId: 'subj:physics' });
    const world = await seedWorld();
    render(<MistakesPage services={world.svc} />);
    await waitFor(() => {
      if (!q('mistake-subject-filter')) throw new Error('错题本未就绪');
      expect(q<HTMLSelectElement>('mistake-subject-filter')!.value).toBe('物理');
    });
    // 学段筛选=红黄绿（学生状态），不接「默认学段」
    expect(q<HTMLSelectElement>('mistake-stage-filter')!.value).toBe('');
    expect(optionTexts('mistake-stage-filter').some((t) => t.includes('高中'))).toBe(false);
  });
});
