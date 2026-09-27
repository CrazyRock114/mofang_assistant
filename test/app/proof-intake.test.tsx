// 0028 P2：录题页「先拖进来」形态（R-028 / D-053②）——三入口 + 进度 + 关页续跑
// @vitest-environment jsdom

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import type { MofangRecogBridge } from '../../src/shared/contracts/bridge.js';
import type {
  RecogEventPayload, RecogRun, RecogRunCreatePayload, RecogRunDetail,
} from '../../src/shared/contracts/recog-run-types.js';
import type { ScanDraft } from '../../src/shared/contracts/recog-types.js';
import { ProofIntakePage } from '../../src/app/pages/ProofIntakePage.js';
import { getStageSubject } from '../../src/app/state/stage-subject.js';
import { clearPendingPdf, peekPendingPdf } from '../../src/app/splitting/handoff.js';
import { getSharedMockBankStore } from '../../src/app/services/BankExtServiceFactory.js';
import { MockBankService } from '../../src/bank/mock/mock-bank.js';
import { MockBankStore } from '../../src/bank/mock/mock-store.js';
import { createMockExtServices } from '../../src/bank/mock/mock-ext.js';

// 不用 React.act（见 proof.test.tsx 案底）；flushSync 强制冲刷更新队列
function flush() {
  flushSync(() => {});
}

function baseRun(overrides: Partial<RecogRun> = {}): RecogRun {
  return {
    id: 'run-1',
    status: 'ocr',
    stage: 'ocr',
    sourceKind: 'image',
    sourceName: 'a.png',
    pageCount: 2,
    pagesDone: 0,
    error: null,
    warnings: [],
    questionIds: [],
    createdAt: '2026-09-17T00:00:00.000Z',
    updatedAt: '2026-09-17T00:00:00.000Z',
    finishedAt: null,
    ...overrides,
  };
}

const DRAFT: ScanDraft = {
  pageNo: 1,
  qno: 1,
  contentHtml: '<div class="question"><p>甲题题面</p></div>',
  imageRefIds: [],
  rawText: '1. 甲题题面',
  warnings: [],
};

interface FakeRecog {
  bridge: MofangRecogBridge;
  emit: (payload: RecogEventPayload) => void;
  calls: { create: RecogRunCreatePayload[]; cancel: string[]; resume: string[] };
  setRun: (patch: Partial<RecogRun>) => void;
  setDrafts: (drafts: ScanDraft[]) => void;
}

function makeFakeRecog(initial: Partial<RecogRun> = {}, pages = 2): FakeRecog {
  const listeners = new Set<(p: RecogEventPayload) => void>();
  let run = baseRun({ pageCount: pages, ...initial });
  let drafts: ScanDraft[] = [];
  const calls: FakeRecog['calls'] = { create: [], cancel: [], resume: [] };

  const detail = (): RecogRunDetail => ({
    run,
    runDir: 'C:\\tmp\\recog\\runs\\run-1',
    pages: Array.from({ length: run.pageCount }, (_, i) => ({
      runId: run.id,
      pageNo: i + 1,
      imageFile: `pages/p00${i + 1}.png`,
      ocrFile: i < run.pagesDone ? `ocr/p00${i + 1}.json` : null,
      status: i < run.pagesDone ? 'done' : 'pending',
      textChars: 10,
      imageRefCount: 0,
      error: null,
      updatedAt: run.updatedAt,
      imagePath: `C:\\tmp\\recog\\runs\\run-1\\pages\\p00${i + 1}.png`,
      ocrText: `${i + 1}. 原文`,
    })),
    drafts,
  });

  return {
    calls,
    setRun: (patch) => { run = { ...run, ...patch }; },
    setDrafts: (next) => { drafts = next; },
    // 事件回调在真实环境是 IPC 推送（非 React 事件）——用 flushSync 同步冲刷，等效 act
    emit: (payload) => {
      flushSync(() => {
        for (const l of [...listeners]) l(payload);
      });
    },
    bridge: {
      create: async (payload) => {
        calls.create.push(payload);
        return { runId: 'run-1', pageCount: payload.materials.length };
      },
      status: async () => detail(),
      cancel: async ({ runId }) => {
        calls.cancel.push(runId);
        return run;
      },
      resume: async ({ runId }) => {
        calls.resume.push(runId);
        return run;
      },
      history: async () => [],
      attachQuestions: async () => run,
      onEvent: (cb) => {
        listeners.add(cb);
        return () => { listeners.delete(cb); };
      },
    },
  };
}

let container: HTMLDivElement;
let root: Root | null = null;

function render(node: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => root!.render(node));
}

/** 渲染录题页（默认注入 mock bank/ext，避免真 IPC） */
function renderPage(fake: FakeRecog, runId?: string) {
  const bank = new MockBankService(new MockBankStore());
  render(
    <ProofIntakePage
      recog={fake.bridge}
      bank={bank}
      {...(runId ? { runId } : {})}
    />,
  );
}

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  window.location.hash = '';
});

beforeEach(() => {
  // 共享状态（0024）跨用例复位：acquire/release 生命周期在组件挂载期生效
  window.location.hash = '';
});

function el<T extends HTMLElement = HTMLElement>(testid: string): T {
  const node = container.querySelector(`[data-testid="${testid}"]`);
  if (!node) throw new Error(`找不到元素: ${testid}（DOM: ${container.innerHTML.slice(0, 600)}）`);
  return node as T;
}

function has(testid: string): boolean {
  return container.querySelector(`[data-testid="${testid}"]`) !== null;
}

function makePng(name = 'a.png', bytes = [1, 2, 3]): File {
  return new File([new Uint8Array(bytes)], name, { type: 'image/png' });
}

async function dropFiles(files: File[]): Promise<void> {
  const zone = el('recog-dropzone');
  const event = new Event('drop', { bubbles: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files } });
  zone.dispatchEvent(event);
  // 上传是 async（File.arrayBuffer → create）：轮询等结果落定（建 run 或给出 notice）
  await waitFor(() => has('notice') || has('recog-progress'));
}

/** 只投递、不等落定：PDF 走「交接 + 跳工作区」分支，不产生 run/notice，等不到也没关系 */
async function dropFilesNoWait(files: File[]): Promise<void> {
  const zone = el('recog-dropzone');
  const event = new Event('drop', { bubbles: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files } });
  zone.dispatchEvent(event);
  await new Promise((r) => setTimeout(r, 20));
  flush();
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    flush();
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor 超时：${container.innerHTML.slice(0, 800)}`);
}

/** document 级 Ctrl+V（粘贴事件无处可挂焦点，只有 document 收得到） */
async function pasteFiles(files: File[]): Promise<void> {
  const event = new Event('paste', { bubbles: true }) as Event & { clipboardData: unknown };
  Object.defineProperty(event, 'clipboardData', {
    value: { items: files.map((f) => ({ kind: 'file', type: f.type, getAsFile: () => f })) },
  });
  document.dispatchEvent(event);
  await waitFor(() => has('recog-progress') || has('notice'));
}

/** 等建 run 落定（dropFiles/pasteFiles 只保证进屏，create 是 upload 完成才发生） */
async function waitCreated(fake: FakeRecog, n = 1): Promise<void> {
  await waitFor(() => fake.calls.create.length >= n, 3000);
}

describe('0028 P2：第一屏=大拖放区（先素材后配置）', () => {
  it('无 runId 时第一屏即拖放区：三入口提示齐备（主位）', () => {
    const fake = makeFakeRecog();
    renderPage(fake);
    expect(has('recog-dropzone')).toBe(true);
    const zone = el('recog-dropzone');
    expect(zone.textContent).toContain('拖');
    expect(zone.textContent).toContain('Ctrl+V');
    expect(zone.textContent).toContain('选择文件');
    expect(has('recog-file-input')).toBe(true);
  });

  it('目检返工：删掉「学段/学科可稍后设置」提示行；控件在次要位置（拖放区之后）', () => {
    const fake = makeFakeRecog();
    renderPage(fake);
    // 矫枉过正的提示行已删
    expect(has('intake-hint')).toBe(false);
    expect(container.textContent).not.toContain('可稍后');
    expect(container.textContent).not.toContain('不必先配置');
    // 控件回来了：学段/学科各一个下拉，排在拖放区之后（不占主位）
    expect(has('intake-context')).toBe(true);
    expect(has('intake-stage-select')).toBe(true);
    expect(has('intake-subject-select')).toBe(true);
    const html = container.innerHTML;
    expect(html.indexOf('recog-dropzone')).toBeLessThan(html.indexOf('intake-context'));
    // 学段三档与采集页同源
    const stageOptions = Array.from(el<HTMLSelectElement>('intake-stage-select').options).map((o) => o.value);
    expect(stageOptions).toEqual(['', '小学', '初中', '高中']);
  });

  it('目检返工：改学段/学科 → 写 0024 共享状态（供校对页默认值）', async () => {
    // mock 字典默认空表：先播种学科归一行（走真实 mock 服务写入，与页面取同一 store）
    const ext = createMockExtServices(getSharedMockBankStore());
    if ((await ext.dict.listEntries({ kind: 'subject' })).length === 0) {
      await ext.dict.createEntry({ kind: 'subject', code: 'phy', label: '物理' });
      await ext.dict.createEntry({ kind: 'subject', code: 'math', label: '数学' });
    }

    const fake = makeFakeRecog();
    renderPage(fake);
    await waitFor(() => el<HTMLSelectElement>('intake-subject-select').options.length > 1);

    const stageSelect = el<HTMLSelectElement>('intake-stage-select');
    const subjectSelect = el<HTMLSelectElement>('intake-subject-select');
    const subjectIds = Array.from(subjectSelect.options).map((o) => o.value).filter((v) => v !== '');
    expect(subjectIds.length).toBeGreaterThan(0);

    stageSelect.value = '初中';
    stageSelect.dispatchEvent(new Event('change', { bubbles: true }));
    subjectSelect.value = subjectIds[0];
    subjectSelect.dispatchEvent(new Event('change', { bubbles: true }));
    flush();

    expect(getStageSubject()).toEqual({ stage: '初中', subjectId: subjectIds[0] });
    // 回读控件（受控组件，值来自共享状态）
    expect(el<HTMLSelectElement>('intake-stage-select').value).toBe('初中');
    expect(el<HTMLSelectElement>('intake-subject-select').value).toBe(subjectIds[0]);
  });

  it('拖入图片 → 建 run 并进进度屏（素材已上行，页数=图片数）', async () => {
    const fake = makeFakeRecog();
    renderPage(fake);
    await dropFiles([makePng('a.png'), makePng('b.png', [4, 5])]);
    await waitCreated(fake);

    expect(fake.calls.create).toHaveLength(1);
    expect(fake.calls.create[0].materials.map((m) => m.name)).toEqual(['a.png', 'b.png']);
    expect(fake.calls.create[0].sourceKind).toBe('image');
    expect(has('recog-progress')).toBe(true);
  });

  it('首屏有「返回首页」（0036 目检返工：每个界面都要能返回上一级）', async () => {
    const fake = makeFakeRecog();
    renderPage(fake);
    const back = el('intake-back');
    expect(back.getAttribute('href')).toBe('#/');
    expect(back.textContent).toContain('返回首页');
  });

  it('从切题工作区过来（?from=split/<项目>）时返回切题项目（0036 目检返工：校对页要有回切题的入口）', async () => {
    const fake = makeFakeRecog();
    window.location.hash = '#/proof/run-1?from=split/11111111-2222-4333-8444-555555555555';
    renderPage(fake);
    const back = el('intake-back');
    expect(back.getAttribute('href')).toBe('#/split/11111111-2222-4333-8444-555555555555');
    expect(back.textContent).toContain('返回切题项目');
    window.location.hash = '';
  });

  it('PDF 拖入 → 交接给切题工作区并跳转（0036 / R-027，不再降级为「先转图片」）', async () => {
    const fake = makeFakeRecog();
    renderPage(fake);
    const pdf = new File([new Uint8Array([1])], '整卷.pdf', { type: 'application/pdf' });
    await dropFilesNoWait([pdf]);

    expect(window.location.hash).toBe('#/split');
    expect(fake.calls.create).toHaveLength(0);
    const handed = peekPendingPdf();
    expect(handed?.files.map((f) => f.name)).toEqual(['整卷.pdf']);
    expect(handed?.notice).toBeNull();
    clearPendingPdf();
    window.location.hash = '';
  });

  it('PDF 与图片混合拖入 → PDF 去工作区、图片去向在提示里说清（不静默丢）', async () => {
    const fake = makeFakeRecog();
    renderPage(fake);
    const pdf = new File([new Uint8Array([1])], '整卷.pdf', { type: 'application/pdf' });
    await dropFilesNoWait([pdf, makePng('页1.png')]);

    expect(window.location.hash).toBe('#/split');
    expect(fake.calls.create).toHaveLength(0);
    const handed = peekPendingPdf();
    expect(handed?.files.map((f) => f.name)).toEqual(['整卷.pdf']);
    expect(handed?.notice).toContain('1 张图片未处理');
    clearPendingPdf();
    window.location.hash = '';
  });

  it('不支持类型 → 提示理由且不建 run', async () => {
    const fake = makeFakeRecog();
    renderPage(fake);
    await dropFiles([new File([new Uint8Array([1])], '笔记.docx')]);
    expect(el('notice').textContent).toContain('没有可识别的图片');
    expect(fake.calls.create).toHaveLength(0);
  });

  it('Ctrl+V 粘贴 → 取剪贴板图片建 run（免点击直接进）', async () => {
    const fake = makeFakeRecog();
    renderPage(fake);
    await pasteFiles([makePng('', [9])]);
    await waitCreated(fake);
    expect(fake.calls.create).toHaveLength(1);
    expect(fake.calls.create[0].materials.map((m) => m.name)).toEqual(['粘贴图片-1.png']);
  });

  it('点选 input[type=file]：multiple 且 accept 限图片', () => {
    const fake = makeFakeRecog();
    renderPage(fake);
    const input = el<HTMLInputElement>('recog-file-input');
    expect(input.multiple).toBe(true);
    expect(input.accept).toBe('image/*');
  });
});

describe('0028 P2：阶段进度条（消费 recog.event）', () => {
  it('页事件推进「页 i/n」与百分比；done 时进校对页', async () => {
    const fake = makeFakeRecog({ pageCount: 3, pagesDone: 0, status: 'ocr' });
    renderPage(fake, 'run-1');
    await waitFor(() => has('recog-progress') && el('recog-stage').textContent!.includes('识别中'));

    fake.emit({ runId: 'run-1', type: 'ocr', pageNo: 1, pageIndex: 1, pageCount: 3, progress: 1 / 3 });
    flush();
    expect(el('recog-stage').textContent).toContain('页 1/3');
    expect(el('recog-progressbar').getAttribute('data-percent')).toBe('33');

    fake.emit({ runId: 'run-1', type: 'ai', pageCount: 3, progress: 1 });
    flush();
    expect(el('recog-stage').textContent).toContain('整理题卡');

    // 完成：drafts 就绪后进校对台
    fake.setDrafts([DRAFT]);
    fake.setRun({ status: 'done', stage: 'done', pagesDone: 3, finishedAt: '2026-09-17T00:01:00.000Z' });
    fake.emit({ runId: 'run-1', type: 'done', pageCount: 3, draftCount: 1, progress: 1 });
    await waitFor(() => has('item-pane'));
    expect(container.querySelector('[data-testid="proof-item-1-1"]')).not.toBeNull();
  });

  it('别的 run 的事件不串台（多 run 并存）', async () => {
    const fake = makeFakeRecog({ pageCount: 2 });
    renderPage(fake, 'run-1');
    await waitFor(() => has('recog-progress'));
    fake.emit({ runId: 'other-run', type: 'ocr', pageNo: 1, pageIndex: 1, pageCount: 9, progress: 1 / 9 });
    flush();
    expect(el('recog-stage').textContent).not.toContain('页 1/9');
  });

  it('取消按钮 → 调 recog.cancel(runId)', async () => {
    const fake = makeFakeRecog({ status: 'ocr' });
    renderPage(fake, 'run-1');
    await waitFor(() => has('btn-recog-cancel'));
    el('btn-recog-cancel').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await waitFor(() => fake.calls.cancel.length > 0);
    expect(fake.calls.cancel).toEqual(['run-1']);
  });
});

describe('0028 P2：关页回来续跑（#/proof/<runId>）', () => {
  it('带 runId 挂载 → 回读状态直接进校对台（草稿已就绪）', async () => {
    const fake = makeFakeRecog({ status: 'done', stage: 'done', pagesDone: 2 });
    fake.setDrafts([DRAFT]);
    renderPage(fake, 'run-1');
    await waitFor(() => has('item-pane'));
    expect(container.querySelector('[data-testid="proof-item-1-1"]')).not.toBeNull();
  });

  it('中断态（error）→ 明示失败原因与已完成页数 + 「继续识别」触发 resume', async () => {
    const fake = makeFakeRecog({ status: 'error', stage: 'error', pagesDone: 1, error: '第 2 页识别失败：超时' });
    renderPage(fake, 'run-1');
    await waitFor(() => has('recog-interrupted'));
    expect(el('recog-interrupted-reason').textContent).toContain('超时');
    expect(el('recog-interrupted').textContent).toContain('1/2 页');

    el('btn-recog-resume').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await waitFor(() => fake.calls.resume.length > 0);
    expect(fake.calls.resume).toEqual(['run-1']);
  });

  it('cancelled 同样可续跑；识别完成但零草稿给明示而不是空白台', async () => {
    const fake = makeFakeRecog({ status: 'cancelled', stage: 'cancelled', pagesDone: 0 });
    renderPage(fake, 'run-1');
    await waitFor(() => has('recog-interrupted'));

    fake.setRun({ status: 'done', stage: 'done', pagesDone: 2 });
    fake.emit({ runId: 'run-1', type: 'done', pageCount: 2, draftCount: 0, progress: 1 });
    await waitFor(() => has('recog-empty'));
    expect(el('recog-empty').textContent).toContain('没有切出题目');
  });
});
