// 0020 P1：整卷下载反爬挑战提示的单源判定
// 锚定策略：两条挑战消息**经 collect.ts 真实代码路径产出**（假 HiddenPage 注入，无网络/无 Electron），
// 再交给谓词判定——不复制原文、不硬编码，避免文案与判定各写一份后静默漂移。
// 出处：src/capture/papers/collect.ts:89（PC 索引段抛错）/ :118（题批接口 warning）。

import { describe, it, expect } from 'vitest';
import { collectPaperQuestions } from '../../src/capture/papers/collect.js';
import type { PaperCollectDeps } from '../../src/capture/papers/collect.js';
import type { HiddenPage } from '../../src/capture/browser/answer-fetch.js';
import { isPaperChallengeMessage, PAPER_CHALLENGE_MARK } from '../../src/capture/papers/challenge-hint.js';

const URL_PAPER = 'https://zujuan.xkw.com/4p2338916.html';

interface FakePage extends HiddenPage {
  url: string;
}

function fakePage(url: string, handler: (fn: string, args: unknown[]) => any): FakePage {
  return {
    url,
    finalUrl: () => url,
    async call(fn, ...args) { return handler(fn, args); },
    async close() { /* no-op */ },
  };
}

/** 注入 deps：PC 页返回 index（可挑战）；移动页返回 batch 响应（可挑战/失败） */
function makeDeps(opts: {
  index?: { title: string; questions: Array<{ questionId: string; bankid?: string }>; challenge?: boolean };
  batch?: () => any;
} = {}): PaperCollectDeps {
  const ids = ['22724580', '22724581', '22724582'];
  const index = opts.index ?? { title: '样本卷', questions: ids.map((id) => ({ questionId: id, bankid: '4' })) };
  return {
    async openPage(url) {
      if (url.includes('mzujuan.xkw.com')) {
        return fakePage(url, (fn) => {
          if (fn !== 'fetchPaperQuestions') throw new Error(`未知页内函数 ${fn}`);
          if (opts.batch) return opts.batch();
          return {
            status: 200, code: '0', challenge: false, total: ids.length,
            childCount: 0, warnings: [],
            questions: ids.map((id) => ({
              questionId: id, site: 'zujuan', sourceUrl: 'https://mzujuan.xkw.com/',
              stemHtml: `<p>${id}</p>`, options: [], answerHtml: '', analysisHtml: '',
              images: [], meta: { bankid: '4' }, rect: null,
            })),
          };
        });
      }
      return fakePage(url, (fn) => {
        if (fn !== 'extractPaperIndex') throw new Error(`未知页内函数 ${fn}`);
        return { ...index, challenge: index.challenge ?? false };
      });
    },
    sleep: async () => { /* no-op */ },
  };
}

/** 经真实链路产出：PC 索引段挑战 → 抛错消息 */
async function pcChallengeMessage(): Promise<string> {
  const deps = makeDeps({ index: { title: '安全验证', questions: [], challenge: true } });
  return collectPaperQuestions(URL_PAPER, deps).then(
    () => { throw new Error('预期抛错但成功返回'); },
    (e: unknown) => (e as Error).message,
  );
}

/** 经真实链路产出：题批接口挑战 → warning 消息 */
async function batchChallengeMessage(): Promise<string> {
  const deps = makeDeps({ batch: () => ({ status: 200, code: '', challenge: true, total: 0, childCount: 0, warnings: [], questions: [] }) });
  const result = await collectPaperQuestions(URL_PAPER, deps);
  return result.warnings[0];
}

describe('0020 P1：挑战消息判定单源', () => {
  it('公共标识子串 = 「反爬挑战」（两条现有消息共有的字样）', () => {
    expect(PAPER_CHALLENGE_MARK).toBe('反爬挑战');
  });

  it('PC 索引段挑战消息（collect.ts:89 真实产出）→ 命中，且含公共标识', async () => {
    const msg = await pcChallengeMessage();
    expect(isPaperChallengeMessage(msg)).toBe(true);
    expect(msg).toContain(PAPER_CHALLENGE_MARK);
    // 人工处理语义（不自动绕过）逐字保留
    expect(msg).toContain('人工通过后再试');
  });

  it('题批接口挑战消息（collect.ts:118 真实产出）→ 命中，且含公共标识', async () => {
    const msg = await batchChallengeMessage();
    expect(isPaperChallengeMessage(msg)).toBe(true);
    expect(msg).toContain(PAPER_CHALLENGE_MARK);
  });

  it('非挑战消息不误判（同链路真实产出的错误/告警原文）', async () => {
    // URL 非法（paper-url 提示）
    const badUrl = await collectPaperQuestions('https://www.jyeoo.com/physics2/ques/detail/x', makeDeps())
      .then(() => '', (e: unknown) => (e as Error).message);
    // PC 页无题号（结构变化）
    const noEntries = await collectPaperQuestions(URL_PAPER, makeDeps({ index: { title: '空', questions: [] } }))
      .then(() => '', (e: unknown) => (e as Error).message);
    // 题批接口 http-404
    const http404 = await collectPaperQuestions(URL_PAPER, makeDeps({
      batch: () => ({ status: 404, code: '', challenge: false, total: 0, childCount: 0, warnings: [], questions: [] }),
    })).then((r) => r.warnings[0]);
    // 覆盖率缺口
    const gap = await collectPaperQuestions(URL_PAPER, makeDeps({
      batch: () => ({ status: 200, code: '0', challenge: false, total: 1, childCount: 0, warnings: [], questions: [] }),
    })).then((r) => r.warnings.join('|'));

    for (const [label, msg] of [['URL 非法', badUrl], ['无题号', noEntries], ['http-404', http404], ['覆盖率缺口', gap]] as const) {
      expect(msg, label).toBeTruthy();
      expect(isPaperChallengeMessage(msg), label).toBe(false);
    }
  });

  it('边界输入（空串/非字符串）不命中、不抛', () => {
    expect(isPaperChallengeMessage('')).toBe(false);
    expect(isPaperChallengeMessage('普通告警：题批接口未返回 1 题')).toBe(false);
    expect(isPaperChallengeMessage(null as unknown as string)).toBe(false);
    expect(isPaperChallengeMessage(undefined as unknown as string)).toBe(false);
  });
});
