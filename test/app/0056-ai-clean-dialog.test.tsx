// 0056（R-041）：AI 整理入口与对照确认弹层。
//
// 锁四条产品口径（任务书 §一.1）：①题库页批量「AI 整理」+ 单题「整理本题」两个入口；
// ②整理前后对照并排、逐题勾选，确认才落库（D-050/P-07 必人确认）；③失败题可见标记 + 可重试；
// ④跳过题（子母题/无需整理）显式给原因、不进确认集。
// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import type { BankService, BankExtServices, Question } from '../../src/shared/contracts/bank-types.js';
import type { QuestionAiCleanPayload, QuestionAiCleanResult, QuestionAiCleanItem } from '../../src/shared/contracts/ipc-channels.js';
import { MockBankService } from '../../src/bank/mock/mock-bank.js';
import { createMockExtServices } from '../../src/bank/mock/mock-ext.js';
import { MockBankStore } from '../../src/bank/mock/mock-store.js';

import { AiCleanDialog } from '../../src/app/components/AiCleanDialog.js';
import { BankBrowser } from '../../src/app/components/BankBrowser.js';
import type { ExtPageServices } from '../../src/app/pages/ExtUi.js';

let store: MockBankStore;
let bank: BankService;
let ext: BankExtServices;
let svc: ExtPageServices;

beforeEach(() => {
  store = new MockBankStore();
  bank = new MockBankService(store, false);
  ext = createMockExtServices(store);
  svc = { bank, ext };
});

let container: HTMLDivElement;
let root: Root | null = null;

function render(ui: ReactElement): void {
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
  delete window.__mofangPaths;
  vi.restoreAllMocks();
});

function q<T extends Element>(testid: string): T | null {
  return container.querySelector<T>(`[data-testid="${testid}"]`);
}

function click(testid: string): void {
  const el = q(testid);
  if (!el) throw new Error(`找不到元素: ${testid}`);
  flushSync(() => { (el as HTMLElement).click(); });
}

async function waitFor(assertion: () => void): Promise<void> {
  await vi.waitFor(assertion, { timeout: 3000, interval: 20 });
}

function fields(content: string): QuestionAiCleanItem['before'] {
  return { content: `<div class="question">${content}</div>`, answer: '', analysis: '', images: [] };
}

function okItem(questionId: string): QuestionAiCleanItem {
  return {
    questionId,
    ok: true,
    before: fields(`原 ${questionId}`),
    after: fields(`整理后 ${questionId}`),
    converted: 1,
    failedImages: [],
    skipped: null,
    error: null,
    warnings: [],
  };
}

function failItem(questionId: string): QuestionAiCleanItem {
  return {
    questionId,
    ok: false,
    before: fields(`原 ${questionId}`),
    after: null,
    converted: 0,
    failedImages: [{ src: 'data-assets/capture/zujuan/f1.png', reason: '模型超时' }],
    skipped: null,
    error: '模型超时',
    warnings: [],
  };
}

function skipItem(questionId: string, reason: string): QuestionAiCleanItem {
  return {
    questionId,
    ok: false,
    before: fields(`原 ${questionId}`),
    after: null,
    converted: 0,
    failedImages: [],
    skipped: reason,
    error: null,
    warnings: [],
  };
}

/** 假运行面：按 questionIds 出条目；记录每次调用 */
function makeRunner(items: (id: string) => QuestionAiCleanItem) {
  const calls: QuestionAiCleanPayload[] = [];
  const runner = async (payload: QuestionAiCleanPayload): Promise<QuestionAiCleanResult> => {
    calls.push(payload);
    if (payload.mode === 'commit') {
      return { mode: 'commit', items: [], saved: payload.items?.length ?? 0, failed: [] };
    }
    return { mode: 'preview', items: payload.questionIds.map(items), saved: 0, failed: [] };
  };
  return { runner, calls };
}

describe('0056 对照确认弹层', () => {
  it('打开即跑 preview，逐题并排对照 + 默认勾选；取消不落库', async () => {
    const { runner, calls } = makeRunner(okItem);
    render(<AiCleanDialog questionIds={['qa', 'qb']} runner={runner} onClose={() => {}} />);
    await waitFor(() => expect(q('ai-clean-item-qa')).toBeTruthy());
    expect(q('ai-clean-before-qa')!.textContent).toContain('原 qa');
    expect(q('ai-clean-after-qa')!.textContent).toContain('整理后 qa');
    const check = q<HTMLInputElement>('ai-clean-check-qa')!;
    expect(check.checked).toBe(true);
    // 取消：只跑过 preview，零 commit
    click('ai-clean-cancel');
    expect(calls.filter((c) => c.mode === 'commit')).toHaveLength(0);
  });

  it('确认写入：只提交勾选项（取消勾选的题不进 commit）', async () => {
    const { runner, calls } = makeRunner(okItem);
    let written = 0;
    render(
      <AiCleanDialog
        questionIds={['qa', 'qb']}
        runner={runner}
        onClose={() => {}}
        onWritten={() => { written += 1; }}
      />,
    );
    await waitFor(() => expect(q('ai-clean-item-qb')).toBeTruthy());
    click('ai-clean-check-qb'); // 取消第二个
    click('ai-clean-confirm');
    await waitFor(() => expect(calls.some((c) => c.mode === 'commit')).toBe(true));
    const commit = calls.find((c) => c.mode === 'commit')!;
    expect(commit.items!.map((i) => i.questionId)).toEqual(['qa']);
    expect(written).toBe(1);
  });

  it('失败题：可见标记 + 重试按钮；重试再跑 preview；失败题不进确认集', async () => {
    let attempt = 0;
    const { runner, calls } = makeRunner((id) => {
      if (id === 'bad') return attempt === 0 ? failItem('bad') : okItem('bad');
      return okItem(id);
    });
    const failedSeen: string[][] = [];
    render(
      <AiCleanDialog
        questionIds={['good', 'bad']}
        runner={runner}
        onClose={() => {}}
        onResult={(ids) => failedSeen.push(ids)}
      />,
    );
    await waitFor(() => expect(q('ai-clean-fail-bad')).toBeTruthy());
    expect(q('ai-clean-check-bad')).toBeNull();
    expect(failedSeen.at(-1)).toEqual(['bad']);
    click('ai-clean-confirm');
    await waitFor(() => expect(calls.some((c) => c.mode === 'commit')).toBe(true));
    expect(calls.find((c) => c.mode === 'commit')!.items!.map((i) => i.questionId)).toEqual(['good']);
    // 重试
    attempt = 1;
    click('ai-clean-retry-bad');
    await waitFor(() => expect(q('ai-clean-fail-bad')).toBeNull());
    expect(q<HTMLInputElement>('ai-clean-check-bad')).toBeTruthy();
  });

  it('跳过题：显式给原因、不可勾选（子母题/无需整理不静默）', async () => {
    const { runner } = makeRunner((id) => (id === 'sub' ? skipItem('sub', '子母题暂不整理（等 R-042 结构批）') : okItem(id)));
    render(<AiCleanDialog questionIds={['ok1', 'sub']} runner={runner} onClose={() => {}} />);
    await waitFor(() => expect(q('ai-clean-skip-sub')).toBeTruthy());
    expect(q('ai-clean-skip-sub')!.textContent).toContain('子母题');
    expect(q('ai-clean-check-sub')).toBeNull();
  });

  it('返工④：需复核题（骨架矛盾）默认不勾选 + 标记可见 + 批次说明上屏', async () => {
    const runner = async (payload: QuestionAiCleanPayload): Promise<QuestionAiCleanResult> => {
      if (payload.mode === 'commit') return { mode: 'commit', items: [], saved: payload.items?.length ?? 0, failed: [] };
      return {
        mode: 'preview',
        saved: 0,
        failed: [],
        notes: ['本次为单模型结果（vision 档案）'],
        items: [
          { ...okItem('good') },
          { ...okItem('suspect'), needsReview: true, warnings: ['骨架里没有分数线，但结果含分式（\frac）——疑幻觉'] },
        ],
      };
    };
    render(<AiCleanDialog questionIds={['good', 'suspect']} runner={runner} onClose={() => {}} />);
    await waitFor(() => expect(q('ai-clean-item-suspect')).toBeTruthy());
    // 正常题默认勾选；需复核题**默认不勾**且有可见标记
    expect(q<HTMLInputElement>('ai-clean-check-good')!.checked).toBe(true);
    expect(q<HTMLInputElement>('ai-clean-check-suspect')!.checked).toBe(false);
    expect(q('ai-clean-review-suspect')!.textContent).toContain('需复核');
    expect(q('ai-clean-item-suspect')!.textContent).toContain('疑幻觉');
    // 批次说明可见
    expect(q('ai-clean-notes')!.textContent).toContain('单模型结果');
    // 底部统计体现「待复核」
    expect(q('ai-clean-dialog')!.textContent).toContain('待复核 1 题');
  });

  it('返工⑧：题级 ok 但有未转写图 → 失败清单按字段+资产名归并，且底部「重试未转写的图」可见', async () => {
    const runner = async (payload: QuestionAiCleanPayload): Promise<QuestionAiCleanResult> => {
      if (payload.mode === 'commit') return { mode: 'commit', items: [], saved: payload.items?.length ?? 0, failed: [] };
      return {
        mode: 'preview',
        saved: 0,
        failed: [],
        items: [{
          ...okItem('partial'),
          // 真机现场：8 张解析区图同因失败——旧口径会把原因原样重复 8 次、看着像程序坏了
          failedImages: Array.from({ length: 8 }, (_v, i) => ({
            src: `data-assets/capture/zujuan/17371192-${10 + i}.png`,
            field: 'analysis' as const,
            reason: 'OCR 转写腿返回空内容（该档案不具备转写能力域）（解析区图）',
          })),
          deferred: [{ src: 'data-assets/capture/zujuan/17371192-99.png', reason: '解析/答案区含正文的内嵌图：整字段替换会冲掉正文，归「答案解析链」另单处理' }],
        }],
      };
    };
    render(<AiCleanDialog questionIds={['partial']} runner={runner} onClose={() => {}} />);
    await waitFor(() => expect(q('ai-clean-failed-partial')).toBeTruthy());
    const summary = q('ai-clean-failed-partial')!.textContent ?? '';
    expect(summary).toContain('未转写的图 8 张');
    expect(summary).toContain('解析区');
    expect(summary).toContain('17371192-10.png');                 // 带资产名（一眼看出不是题面）
    expect(summary).toContain('等 8 张');                          // 同因归并（不再重复 8 遍原因）
    expect((summary.match(/OCR 转写腿返回空内容/g) ?? []).length).toBe(1);
    expect(q('ai-clean-deferred-partial')!.textContent).toContain('答案解析链');
    // 题级 ok 也要有重试入口（旧口径只在题级失败时给）
    expect(q('ai-clean-retry-partial')).toBeTruthy();
    await waitFor(() => expect(q('ai-clean-retry-failed')).toBeTruthy());
    expect(q('ai-clean-retry-failed')!.textContent).toContain('重试未转写的图（1 题）');
  });

  it('无 bridge 且未注入 runner：显式告警不静默（不死按钮）', async () => {
    render(<AiCleanDialog questionIds={['qa']} onClose={() => {}} />);
    await waitFor(() => expect(q('ai-clean-unavailable')).toBeTruthy());
  });
});

describe('0056 题库页入口', () => {
  const ASSETS_ROOT = 'D:\\mofang-test\\data\\assets';

  async function seed(): Promise<Question> {
    (window as unknown as { __mofangPaths?: { userDataAssets: string } }).__mofangPaths = { userDataAssets: ASSETS_ROOT };
    return bank.createQuestion({
      subject: '物理',
      sourceType: 'network',
      sourceDetail: { site: 'jujuan' },
      content: '<div class="question">题干<div class="options"></div></div>',
      images: [],
    });
  }

  it('批量条「AI 整理」入口 + 单题「整理本题」入口都在（共享 BankBrowser 段落分区：整理入口区）', async () => {
    const question = await seed();
    const { runner } = makeRunner(okItem);
    render(<BankBrowser svc={svc} aiClean={runner} />);
    await waitFor(() => expect(q(`bank-ai-clean-${question.id}`)).toBeTruthy());
    expect(q('bank-ai-clean-btn')).toBeTruthy();
    expect(q(`bank-ai-clean-${question.id}`)!.textContent).toContain('整理本题');
  });

  it('整理失败后题卡可见标记，再点「整理本题」可重进弹层（重试入口）', async () => {
    const question = await seed();
    const { runner } = makeRunner(() => failItem(question.id));
    render(<BankBrowser svc={svc} aiClean={runner} />);
    await waitFor(() => expect(q(`bank-item-${question.id}`)).toBeTruthy());
    click(`bank-ai-clean-${question.id}`);
    await waitFor(() => expect(q(`bank-ai-clean-failed-${question.id}`)).toBeTruthy());
    expect(q(`bank-ai-clean-failed-${question.id}`)!.textContent).toContain('整理失败');
    click('ai-clean-cancel');
    await waitFor(() => expect(q('ai-clean-dialog')).toBeNull());
    click(`bank-ai-clean-${question.id}`);
    await waitFor(() => expect(q('ai-clean-dialog')).toBeTruthy());
  });
});
