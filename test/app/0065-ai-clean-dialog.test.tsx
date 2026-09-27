// 0065（R-068）：对照确认弹层——analysis 对照区 + 403 占位图分组。
//
// 锁两条（任务书 §一.3/§一.4）：
//   ① answer/analysis **各自有对照区**（同构：原文/整理后并排），原位替换后正文可核对；
//   ② 403 占位图**独立分组**（「占位图（站点拒绝访问）」+「需到站点开通权限后重新采集」提示），
//      不混进失败清单、不给无意义的重试入口（重试也还是同一张权限图）。
// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import type { QuestionAiCleanPayload, QuestionAiCleanResult, QuestionAiCleanItem } from '../../src/shared/contracts/ipc-channels.js';

import { AiCleanDialog } from '../../src/app/components/AiCleanDialog.js';

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
  vi.restoreAllMocks();
});

function q<T extends Element>(testid: string): T | null {
  return container.querySelector<T>(`[data-testid="${testid}"]`);
}

async function waitFor(assertion: () => void): Promise<void> {
  await vi.waitFor(assertion, { timeout: 3000, interval: 20 });
}

function fields(content: string, answer = '', analysis = ''): QuestionAiCleanItem['before'] {
  return { content: `<div class="question">${content}</div>`, answer, analysis, images: [] };
}

/** 解析区原位替换成功题（正文守恒：before/after 正文一致，图位换公式） */
function inlineItem(questionId: string): QuestionAiCleanItem {
  return {
    questionId,
    ok: true,
    before: fields(
      `原 ${questionId}`,
      '<p>答案 0.6</p>',
      '<p>解析：由牛顿第二定律得</p><span class="inline-figure"><img src="data-assets/capture/zujuan/a1.png"></span>',
    ),
    after: fields(
      `整理后 ${questionId}`,
      '<p>答案 0.6</p>',
      '<p>解析：由牛顿第二定律得</p><span class="math" data-tex="\\frac{1}{2}mv^2"></span>',
    ),
    converted: 1,
    failedImages: [],
    skipped: null,
    error: null,
    warnings: [],
    fieldModes: { analysis: 'inline-figures' },
  };
}

/** 占位图题（真机形态：题级 skipped + placeholders 单列，零失败） */
function placeholderItem(questionId: string, count = 1): QuestionAiCleanItem {
  return {
    questionId,
    ok: false,
    before: fields(`原 ${questionId}`, '<figure class="diagram"><img src="data-assets/capture/zujuan/ans-1.png"></figure>'),
    after: null,
    converted: 0,
    failedImages: [],
    skipped: '答案区 1 张为站点占位图（403 无权限）——需到站点开通权限后重新采集（本批未送引擎）',
    error: null,
    warnings: [],
    fieldModes: { answer: 'replace-field' },
    placeholders: Array.from({ length: count }, (_v, i) => ({
      src: `data-assets/capture/zujuan/34154610-${5 + i}.png`,
      field: 'answer' as const,
      reason: '站点占位图（403 无权限）：414×30 · 5643B · 指纹 5c5b685fc500…',
    })),
  };
}

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

describe('0065 弹层：answer/analysis 各自对照区', () => {
  it('解析区对照区渲染（原文/整理后并排）——原位替换后正文可核对', async () => {
    const { runner } = makeRunner(inlineItem);
    render(<AiCleanDialog questionIds={['q1']} runner={runner} onClose={() => {}} />);
    await waitFor(() => expect(q('ai-clean-item-q1')).toBeTruthy());
    // answer 对照区（0056 既有）
    expect(q('ai-clean-before-answer-q1')!.textContent).toContain('答案 0.6');
    expect(q('ai-clean-after-answer-q1')!.textContent).toContain('答案 0.6');
    // analysis 对照区（0065 新增）——两侧正文都在
    expect(q('ai-clean-before-analysis-q1')).toBeTruthy();
    expect(q('ai-clean-after-analysis-q1')).toBeTruthy();
    expect(q('ai-clean-before-analysis-q1')!.textContent).toContain('由牛顿第二定律得');
    expect(q('ai-clean-after-analysis-q1')!.textContent).toContain('由牛顿第二定律得');
  });

  it('整理方式标签可见（解析区 原位替换 / 答案区 整字段替换）', async () => {
    const { runner } = makeRunner((id) => (id === 'ph' ? placeholderItem('ph') : inlineItem('q1')));
    render(<AiCleanDialog questionIds={['q1', 'ph']} runner={runner} onClose={() => {}} />);
    await waitFor(() => expect(q('ai-clean-item-q1')).toBeTruthy());
    const modes = q('ai-clean-modes-q1')!.textContent ?? '';
    expect(modes).toContain('解析区');
    expect(modes).toContain('原位替换');
    expect(q('ai-clean-modes-ph')!.textContent).toContain('整字段替换');
  });

  it('解析区为空（无该字段）时不渲染空白对照区（不造无意义框）', async () => {
    const { runner } = makeRunner((id) => ({
      ...inlineItem(id),
      before: fields('原 ' + id),
      after: fields('整理后 ' + id),
      fieldModes: { content: 'inline-figures' as const },
    }));
    render(<AiCleanDialog questionIds={['q2']} runner={runner} onClose={() => {}} />);
    await waitFor(() => expect(q('ai-clean-item-q2')).toBeTruthy());
    expect(q('ai-clean-before-analysis-q2')).toBeNull();
    expect(q('ai-clean-before-answer-q2')).toBeNull();
  });
});

describe('0065 弹层：403 占位图独立分组', () => {
  it('占位图分组可见 + 提示「需到站点开通权限后重新采集」+ 带资产名', async () => {
    const { runner } = makeRunner((id) => (id === 'ph' ? placeholderItem('ph', 3) : inlineItem(id)));
    render(<AiCleanDialog questionIds={['ok1', 'ph']} runner={runner} onClose={() => {}} />);
    await waitFor(() => expect(q('ai-clean-placeholders')).toBeTruthy());
    const block = q('ai-clean-placeholders')!;
    expect(block.textContent).toContain('占位图');
    expect(block.textContent).toContain('站点拒绝访问');
    expect(block.textContent).toContain('开通权限');
    expect(block.textContent).toContain('34154610-5.png');      // 资产短名（一眼知道是哪张）
    expect(block.textContent).toContain('3 张');
    expect(q('ai-clean-placeholder-ph')).toBeTruthy();
  });

  it('占位图**不进失败清单**、统计里不算失败、也不给重试入口', async () => {
    const { runner } = makeRunner((id) => (id === 'ph' ? placeholderItem('ph') : inlineItem(id)));
    render(<AiCleanDialog questionIds={['ok1', 'ph']} runner={runner} onClose={() => {}} />);
    await waitFor(() => expect(q('ai-clean-item-ph')).toBeTruthy());
    expect(q('ai-clean-fail-ph')).toBeNull();                    // 不画失败标
    expect(q('ai-clean-retry-ph')).toBeNull();                   // 不给无意义重试
    expect(q('ai-clean-retry-failed')).toBeNull();
    const footer = q('ai-clean-dialog')!.textContent ?? '';
    expect(footer).not.toContain('失败 1 题');
    // 跳过原因仍可见（题级 skipped 标签）
    expect(q('ai-clean-skip-ph')!.textContent).toContain('占位图');
  });

  it('无占位图时分组不渲染（零噪声）', async () => {
    const { runner } = makeRunner(inlineItem);
    render(<AiCleanDialog questionIds={['q1']} runner={runner} onClose={() => {}} />);
    await waitFor(() => expect(q('ai-clean-item-q1')).toBeTruthy());
    expect(q('ai-clean-placeholders')).toBeNull();
  });
});
