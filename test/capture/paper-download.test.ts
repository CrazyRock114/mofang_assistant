// 0006 P4：整卷抓取编排（PC SSR 取题号 → 移动 UA 隐藏窗批量 API → 合并）
// 全部用假 HiddenPage 注入，无网络、无 Electron。

import { describe, it, expect } from 'vitest';
import {
  collectPaperQuestions,
  MOBILE_UA,
  PAPER_BATCH_SIZE,
  PAPER_BATCH_THROTTLE_MS,
} from '../../src/capture/papers/collect.js';
import type { PaperCollectDeps } from '../../src/capture/papers/collect.js';
import type { HiddenPage } from '../../src/capture/browser/answer-fetch.js';
import type { CapturedQuestion } from '../../src/shared/contracts/capture-types.js';

const URL_PAPER = 'https://zujuan.xkw.com/4p2338916.html';

function q(id: string): CapturedQuestion {
  return {
    questionId: id,
    site: 'zujuan',
    sourceUrl: 'https://mzujuan.xkw.com/',
    stemHtml: `<p>题干 ${id}</p>`,
    options: [],
    answerHtml: '<p>A</p>',
    analysisHtml: '',
    images: [],
    meta: { bankid: '4' },
    rect: null,
  };
}

interface FakePage extends HiddenPage {
  url: string;
  options?: { userAgent?: string };
  calls: Array<{ fn: string; args: unknown[] }>;
  closed: boolean;
}

function fakePage(url: string, options: { userAgent?: string } | undefined, handler: (fn: string, args: unknown[]) => any): FakePage {
  const page: FakePage = {
    url,
    options,
    calls: [],
    closed: false,
    finalUrl: () => url,
    async call(fn, ...args) {
      page.calls.push({ fn, args });
      return handler(fn, args);
    },
    async close() {
      page.closed = true;
    },
  };
  return page;
}

/** 默认探针：PC 页 26 题（真实 fixture 题号）；移动页按请求 ids 返回（可注入失败/挑战） */
function makeDeps(overrides: {
  index?: { title: string; questions: Array<{ questionId: string; bankid?: string }>; challenge?: boolean };
  batch?: (ids: string[], callIndex: number) => any;
  sleepLog?: number[];
} = {}) {
  const ids26 = Array.from({ length: 26 }, (_, i) => String(22724580 + i));
  const index = overrides.index ?? {
    title: '广东省东莞市东华初级中学2024-2025学年八年级上学期11月期中物理试题',
    questions: ids26.map((id) => ({ questionId: id, bankid: '4' })),
    subject: '初中物理',
  };
  const pages: FakePage[] = [];
  let batchCall = 0;
  const deps: PaperCollectDeps = {
    async openPage(url, options) {
      if (url.includes('mzujuan.xkw.com')) {
        const page = fakePage(url, options, (fn, args) => {
          if (fn !== 'fetchPaperQuestions') throw new Error(`未知页内函数 ${fn}`);
          const ids = String(args[1]).split(',').filter(Boolean);
          batchCall++;
          if (overrides.batch) return overrides.batch(ids, batchCall);
          return {
            status: 200,
            code: '0',
            challenge: false,
            total: ids.length,
            childCount: 0,
            warnings: [],
            questions: ids.filter((id) => ids26.includes(id)).map((id) => q(id)),
          };
        });
        pages.push(page);
        return page;
      }
      const page = fakePage(url, options, (fn) => {
        if (fn !== 'extractPaperIndex') throw new Error(`未知页内函数 ${fn}`);
        return { ...index, challenge: index.challenge ?? false };
      });
      pages.push(page);
      return page;
    },
    sleep: async (ms) => { overrides.sleepLog?.push(ms); },
  };
  return { deps, pages };
}

describe('collectPaperQuestions（编排）', () => {
  it('10 题/批 + 批间节流 ≥1s + 移动 UA 只覆盖移动窗 + 窗口复用（不新建）', async () => {
    const sleepLog: number[] = [];
    const { deps, pages } = makeDeps({ sleepLog });
    const result = await collectPaperQuestions(URL_PAPER, deps);

    expect(PAPER_BATCH_SIZE).toBe(10);
    expect(result.batches).toBe(3);
    expect(result.total).toBe(26);
    expect(result.questions).toHaveLength(26);
    expect(result.missing).toHaveLength(0);

    // 节流：3 批之间 2 次，均 ≥1s
    expect(sleepLog).toHaveLength(2);
    expect(Math.min(...sleepLog)).toBeGreaterThanOrEqual(PAPER_BATCH_THROTTLE_MS);

    // 窗口：PC 1 个（session 标准 UA，无 UA 覆盖）+ 移动 1 个（iPhone UA），全部关闭
    expect(pages).toHaveLength(2);
    const pc = pages.find((p) => p.url.startsWith('https://zujuan.xkw.com/'))!;
    const mobile = pages.find((p) => p.url.includes('mzujuan'))!;
    expect(pc.options?.userAgent).toBeUndefined();
    expect(mobile.options?.userAgent).toBe(MOBILE_UA);
    expect(mobile.calls).toHaveLength(3);
    expect(mobile.closed).toBe(true);
    expect(pc.closed).toBe(true);

    // 批次参数：ids 逗号串 + ctx（bankid/paperUrl/paperTitle）
    expect(mobile.calls[0].args[0]).toBe('4');
    expect(String(mobile.calls[0].args[1]).split(',')).toHaveLength(10);
    expect(String(mobile.calls[2].args[1]).split(',')).toHaveLength(6);
    expect(mobile.calls[0].args[2]).toMatchObject({ bankid: '4', paperUrl: URL_PAPER, subject: '初中物理' });
    expect(String((mobile.calls[0].args[2] as any).paperTitle)).toContain('东华初级中学');
    // PC SSR 题号与卷级学科随结果回传（预览/入库共用）
    expect(result.entries).toHaveLength(26);
    expect(result.subject).toBe('初中物理');
  });

  it('合并按 SSR 题号顺序；API 未返回的题号如实入 missing 并告警', async () => {
    const { deps } = makeDeps({
      batch: (ids) => ({
        status: 200,
        code: '0',
        challenge: false,
        total: ids.length,
        childCount: 0,
        warnings: [],
        // 只返回第 1/2 批的部分题（模拟真实卷覆盖率缺口）
        questions: ids.filter((_, i) => i % 3 === 0).map((id) => q(id)),
      }),
    });
    const result = await collectPaperQuestions(URL_PAPER, deps);

    // SSR 顺序归并：批内 idx%3==0 命中（10 题/批 → 0,3,6,9 | 10,13,16,19 | 20,23）
    const expectIds = [0, 3, 6, 9, 10, 13, 16, 19, 20, 23].map((i) => String(22724580 + i));
    expect(result.questions.map((x) => x.questionId)).toEqual(expectIds);
    expect(result.missing).toHaveLength(16);
    expect(result.warnings.join()).toContain('未返回');
    // 返回题均来自 PC SSR 题号集合
    const ssrIds = new Set(Array.from({ length: 26 }, (_, i) => String(22724580 + i)));
    expect(result.questions.every((x) => ssrIds.has(x.questionId))).toBe(true);
  });

  it('API 返回重复题号去重（同一题只保留一次）', async () => {
    const { deps } = makeDeps({
      batch: (ids) => ({
        status: 200,
        code: '0',
        challenge: false,
        total: ids.length * 2,
        childCount: 0,
        warnings: [],
        questions: [...ids, ...ids].map((id) => q(id)),
      }),
    });
    const result = await collectPaperQuestions(URL_PAPER, deps);
    expect(result.questions).toHaveLength(26);
    expect(new Set(result.questions.map((x) => x.questionId)).size).toBe(26);
  });

  it('遇挑战如实停止后续批次并告警人工处理（不自动绕）', async () => {
    const { deps, pages } = makeDeps({
      batch: (ids, callIndex) => callIndex === 2
        ? { status: 200, code: '', challenge: true, total: 0, childCount: 0, warnings: ['challenge'], questions: [] }
        : { status: 200, code: '0', challenge: false, total: ids.length, childCount: 0, warnings: [], questions: ids.map((id) => q(id)) },
    });
    const result = await collectPaperQuestions(URL_PAPER, deps);

    const mobile = pages.find((p) => p.url.includes('mzujuan'))!;
    expect(mobile.calls).toHaveLength(2); // 第 3 批不再发起
    expect(result.warnings.join()).toContain('挑战');
    expect(result.warnings.join()).toContain('人工');
    expect(result.questions).toHaveLength(10);
    expect(result.missing).toHaveLength(16);
  });

  it('批次 http-status 非 200 / code 非 0 如实告警且不中断其余批次', async () => {
    const { deps } = makeDeps({
      batch: (ids, callIndex) => callIndex === 1
        ? { status: 404, code: '', challenge: false, total: 0, childCount: 0, warnings: [], questions: [] }
        : { status: 200, code: '0', challenge: false, total: ids.length, childCount: 0, warnings: [], questions: ids.map((id) => q(id)) },
    });
    const result = await collectPaperQuestions(URL_PAPER, deps);
    expect(result.questions).toHaveLength(16);
    expect(result.warnings.join()).toContain('404');
    expect(result.batches).toBe(3);
  });

  it('非整卷 URL 拒绝；PC 页无题号时抛错（结构变化/挑战）', async () => {
    const { deps } = makeDeps();
    await expect(collectPaperQuestions('https://www.jyeoo.com/physics2/ques/detail/x', deps)).rejects.toThrow(/zujuan\.xkw\.com/);

    const empty = makeDeps({ index: { title: '空卷', questions: [] } });
    await expect(collectPaperQuestions(URL_PAPER, empty.deps)).rejects.toThrow(/题号/);

    const challenge = makeDeps({ index: { title: '安全验证', questions: [], challenge: true } });
    await expect(collectPaperQuestions(URL_PAPER, challenge.deps)).rejects.toThrow(/挑战/);
  });
});
