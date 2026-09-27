// 0026 P4 真桥接线测试 —— 用**真实 IpcExtClient / IpcBankClient**（不是 mock 服务）驱动错题本页，
// 锁住「页面用到的每个 ext 方法在渲染层客户端上都有通道」。
//
// 为什么必须有这一层：`test/app/mistake-loop-page.test.tsx` 注入的是 mock 服务、
// `test/bank/mistake-loop-derive.test.ts` 注入的是真库服务层——两者都在 IPC 之下，
// 于是「页面调了 IpcExtClient 上 unwired 的方法」这条路径无人覆盖，目检才炸出
// 「成册失败：bank-ext IPC 通道未定义（无契约通道）: bank.paper.createPaperEx」。
// 本文件把这一层补上：桥是假的、客户端是真的、页面是真的。
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { MistakesPage } from '../../src/app/pages/MistakesPage.js';
import { IpcExtClient } from '../../src/app/services/IpcExtClient.js';
import { IpcBankClient } from '../../src/app/services/IpcBankClient.js';
import type { ExtPageServices } from '../../src/app/pages/ExtUi.js';

/** 过桥调用留痕（ns.method + payload） */
interface BridgeCall { ns: string; method: string; payload: unknown }

/** 假桥（ext 命名空间式：bridge.<ns>.<method>(payload)） */
function makeNamespaceBridge(handler: (ns: string, method: string, payload: unknown) => unknown): object {
  return new Proxy({}, {
    get: (_target, ns: string) => new Proxy({}, {
      get: (_t, method: string) => (payload?: unknown) => Promise.resolve(handler(ns, method, payload)),
    }),
  });
}

/** 假桥（bank 扁平式：bridge.<method>(payload)——与 MofangBridge 形状一致） */
function makeFlatBridge(handler: (ns: string, method: string, payload: unknown) => unknown): object {
  return new Proxy({}, {
    get: (_target, method: string) => (payload?: unknown) => Promise.resolve(handler('bank', method, payload)),
  });
}

function installBridge(name: '__mofangBank' | '__mofangBankExt', value: object): void {
  Object.defineProperty(window, name, { value, configurable: true, writable: true });
}

const T0 = '2026-09-15T10:00:00.000Z';
const PAPER_ID = 'paper-book-1';
const QUESTION_ID = 'q1';

/** 页面成册链路需要的固定数据（只给页面真正读的字段） */
function makeHandler(calls: BridgeCall[], opts: { unwiredProbe?: string[] } = {}) {
  return (ns: string, method: string, payload: unknown): unknown => {
    const key = `${ns}.${method}`;
    calls.push({ ns, method, payload });
    opts.unwiredProbe?.push(key);
    switch (key) {
      case 'class.list':
        return [{ id: 'c1', name: '初二一班', status: 'active', createdAt: T0 }];
      case 'student.list':
        return [{ id: 's1', name: '王小明', status: 'active', createdAt: T0, updatedAt: T0 }];
      case 'mistake.aggregateByQuestion':
        return [{
          questionId: QUESTION_ID, wrongCount: 1, stemSummary: '自由落体求落地速度',
          subject: '物理', firstOccurredAt: T0, lastOccurredAt: T0,
        }];
      case 'mistake.exportQuestionIds':
        return [QUESTION_ID];
      case 'dict.list':
        return [];
      case 'paper.listPapersEx':
        return [];
      case 'paper.createPaperEx':
        // 真客户端上这是 unwired（无契约通道）——走到这里说明页面调了它，直接失败可见
        throw new Error('本假桥不该收到 createPaperEx：真 IpcExtClient 上它是 unwired');
      case 'bank.createPaper':
        return { id: PAPER_ID, title: '错题本·王小明', config: {}, createdAt: T0, status: 'basket', paperType: 'uniform' };
      case 'paper.updatePaperStatus':
        return { id: PAPER_ID, title: '错题本·王小明', config: {}, createdAt: T0, status: 'done', paperType: 'uniform' };
      case 'paper.setLayoutConfig':
      case 'paper.snapshotPaperQuestions':
        return {};
      case 'paper.getPaperEx':
        return { id: PAPER_ID, title: '错题本·王小明', config: {}, createdAt: T0, status: 'done', paperType: 'uniform' };
      case 'paper.listPaperSnapshotQuestions':
        return [{
          id: QUESTION_ID, subject: '物理', sourceType: 'local', sourceDetail: { origin: 'test' },
          content: '<div class="question">自由落体求落地速度</div>',
          stemHtml: '<div class="question">自由落体求落地速度</div>', images: [],
          createdAt: T0, updatedAt: T0,
        }];
      case 'bank.addQuestion':
        return {};
      case 'bank.getPaperQuestions':
        return [{ id: 'r1', paperId: PAPER_ID, questionId: QUESTION_ID, position: 1, frozen: false }];
      case 'bank.exportPdf':
        return { filePath: 'C:/tmp/错题本.pdf' };
      default:
        return {};
    }
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  flushSync(() => root?.unmount());
  container.remove();
  Reflect.deleteProperty(window, '__mofangBank');
  Reflect.deleteProperty(window, '__mofangBankExt');
});

async function renderPage(services: ExtPageServices): Promise<void> {
  root = createRoot(container);
  flushSync(() => root.render(<MistakesPage services={services} />));
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 5));
    if (container.querySelector('[data-testid="mistake-card-q1"], [data-testid="mistake-row-q1"]')) return;
  }
}

function clickTestId(id: string): void {
  const el = container.querySelector(`[data-testid="${id}"]`);
  if (!el) throw new Error(`找不到 ${id}；实际 DOM：${container.innerHTML.slice(0, 400)}`);
  flushSync(() => (el as HTMLElement).click());
}

async function settle(times = 30): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 5));
}

// ==================== 1. 成册链路（目检炸出来的缺陷） ====================

describe('0026 P4 真桥：成册送组卷链路必须全链有通道（IpcExtClient，不是 mock）', () => {
  it('选生 → 一键成册到组卷：createPaper→composing→挂题→版式，且不调 unwired 方法', async () => {
    const calls: BridgeCall[] = [];
    installBridge('__mofangBankExt', makeNamespaceBridge(makeHandler(calls)));
    installBridge('__mofangBank', makeFlatBridge(makeHandler(calls)));
    const services: ExtPageServices = { bank: new IpcBankClient(), ext: new IpcExtClient() };

    await renderPage(services);

    // 选学生（成册按学生出）
    const studentSelect = container.querySelector('[data-testid="mistake-student-filter"]') as HTMLSelectElement;
    flushSync(() => {
      studentSelect.value = 's1';
      studentSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    clickTestId('mistake-book-btn');
    await settle();

    const seq = calls.map((c) => `${c.ns}.${c.method}`);
    // 建卷 → 转 composing（basket→done 非法，必须中转）→ 挂题 → 版式 → 交给组卷
    // （目检返工二「退一级」：不再替用户快照/定稿/导出文档）
    expect(seq).toContain('bank.createPaper');
    expect(seq).toContain('paper.updatePaperStatus');
    expect(seq).toContain('bank.addQuestion');
    expect(seq).toContain('paper.setLayoutConfig');
    expect(seq).not.toContain('paper.createPaperEx');
    expect(seq).not.toContain('paper.snapshotPaperQuestions');
    expect(seq).not.toContain('bank.exportPdf');

    // 状态迁移只到 composing（定稿权留给教师在排版间用）
    const statusPayloads = calls
      .filter((c) => `${c.ns}.${c.method}` === 'paper.updatePaperStatus')
      .map((c) => (c.payload as { status?: string }).status);
    expect(statusPayloads).toEqual(['composing']);

    // 页面不得报「通道未定义」
    const msg = container.querySelector('[data-testid="page-message"]')?.textContent ?? '';
    expect(msg).not.toContain('通道未定义');
    expect(msg).toContain('已送到组卷');
  });
});

// ==================== 2. 接线清单：页面用到的 ext 方法逐个可调 ====================

describe('0026 接线清单：本单用到的每个 ext 方法在 IpcExtClient 上均已接线', () => {
  it('逐个调用不抛「无契约通道」（新增调用前先在此登记）', async () => {
    installBridge('__mofangBankExt', makeNamespaceBridge(() => ({})));
    const ext = new IpcExtClient();

    const probes: Array<[string, () => Promise<unknown>]> = [
      ['class.listClasses', () => ext.class.listClasses({ status: 'all' })],
      ['student.listStudents', () => ext.student.listStudents({ includeArchived: true })],
      ['dict.listEntries', () => ext.dict.listEntries({ kind: 'subject', activeOnly: true })],
      ['mistake.aggregateByQuestion', () => ext.mistake.aggregateByQuestion({})],
      ['mistake.listMistakes', () => ext.mistake.listMistakes({ questionId: QUESTION_ID })],
      ['mistake.setStages', () => ext.mistake.setStages(['m1'], 'yellow')],
      ['mistake.deleteMistakes', () => ext.mistake.deleteMistakes(['m1'])],
      ['mistake.exportQuestionIds', () => ext.mistake.exportQuestionIds({})],
      ['paper.listPapersEx', () => ext.paper.listPapersEx()],
      ['paper.getPaperEx', () => ext.paper.getPaperEx(PAPER_ID)],
      ['paper.updatePaperStatus', () => ext.paper.updatePaperStatus(PAPER_ID, 'composing')],
      ['paper.setPaperLayoutConfig', () => ext.paper.setPaperLayoutConfig(PAPER_ID, { version: 2 })],
      ['paper.snapshotPaperQuestions', () => ext.paper.snapshotPaperQuestions(PAPER_ID)],
      ['paper.listPaperSnapshotQuestions', () => ext.paper.listPaperSnapshotQuestions(PAPER_ID)],
      ['paperSet.listPaperSets', () => ext.paperSet.listPaperSets({})],
      ['paperSet.getSetPapers', () => ext.paperSet.getSetPapers('ps1')],
      ['paperSet.createPaperSet', () => ext.paperSet.createPaperSet({ name: '集合', type: 'uniform' })],
      ['paperSet.addPaper', () => ext.paperSet.addPaper('ps1', PAPER_ID)],
      ['paperSet.removePaper', () => ext.paperSet.removePaper('ps1', PAPER_ID)],
      ['paperSet.deletePaperSet', () => ext.paperSet.deletePaperSet('ps1')],
    ];

    const failures: string[] = [];
    for (const [label, call] of probes) {
      try {
        await call();
      } catch (err) {
        failures.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

// ==================== 3. 源码锁定：页面不得回退到无通道方法 ====================

describe('0026 源码锁定：页面不得调用 unwired 的 ext 方法', () => {
  const read = (rel: string): string => readFileSync(resolve(process.cwd(), rel), 'utf-8');

  it('MistakesPage / PaperSetPanel 不出现 createPaperEx（无契约通道，真桥必炸）', () => {
    const page = read('src/app/pages/MistakesPage.tsx');
    const panel = read('src/app/pages/PaperSetPanel.tsx');
    expect(page).not.toContain('createPaperEx');
    expect(panel).not.toContain('createPaperEx');
    // 成册建卷走有通道的 bank.createPaper + 显式状态迁移
    expect(page).toContain('svc.bank.createPaper');
  });
});
