// 0056（R-041）：采集题 AI 整理·主进程编排（preview 对照 / commit 落库）+ 通道 handler 形验。
//
// 链路（任务书 §一.1）：读 data/assets 图字节 → createTwoStageProvider 系引擎（测试注入假 provider）
// → 合回契约 HTML → 逐题串行（AI 成本口径，无并发）→ preview 零写库 / commit 逐题 update + 台账留痕。
// P-07 同口径：AI 只产出建议，人确认（对照弹层）后才落库。
//
// 环境：node + 真 fs 临时 dataDir（electron 全 mock，模式照 test/shell/recog-image-assets.test.ts）。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
  },
  BrowserWindow: class {},
  dialog: {},
  safeStorage: { isEncryptionAvailable: () => false },
}));

import type { OnestepDraft, OnestepExtractInput, OnestepProvider } from '../../src/shared/contracts/onestep-types.js';
import type { QuestionImage } from '../../src/shared/contracts/bank-types.js';
import { previewQuestionAiClean, commitQuestionAiClean, type AiCleanQuestionLike } from '../../src/shell/question-ai-clean.js';
import { registerQuestionAiCleanIpcHandlers } from '../../src/shell/ipc.js';
import { IPC_CHANNELS } from '../../src/shared/contracts/ipc-channels.js';

let root: string;
let dataDir: string;

/** 资产落盘：data/assets/<rel> */
function putAsset(rel: string, bytes: Buffer | string): void {
  const path = join(dataDir, 'assets', rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, bytes);
}

/** 真图片字节（目检返工①后本层按**字节真身**判格式：假文本会被判「不是图片」——夹具必须真） */
const PNG_A = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);
/** 第二张位图（尾部多一字节 → 不同 sha/不同 base64，仍是合法 PNG） */
const PNG_B = Buffer.concat([PNG_A, Buffer.from([0x00])]);
const SVG_F2 = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="84" height="20"><text>x</text></svg>', 'utf8');

const F1 = 'capture/zujuan/f1.png';
const F2 = 'capture/zujuan/f2.svg';
const ANS = 'capture/zujuan/ans-1.png';

function contentWith(targets: string[]): string {
  return `<div class="question">题${targets.map((t) => `<span class="inline-figure"><img class="q-figure" data-w="84" data-h="20" src="data-assets/${t}"></span>`).join('')}<div class="options"></div></div>`;
}

beforeEach(() => {
  handlers.clear();
  root = mkdtempSync(join(tmpdir(), 'mofang-0056-clean-'));
  dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  putAsset(F1, PNG_A);
  putAsset(F2, SVG_F2);
  putAsset(ANS, PNG_B);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function draft(partial: Partial<OnestepDraft>): OnestepDraft {
  return {
    qno: null,
    questionType: '解答',
    stemMarkdown: '',
    options: null,
    answerMarkdown: null,
    analysisMarkdown: null,
    suggestedTags: [],
    figures: [],
    figureSource: 'none',
    warnings: [],
    ...partial,
  };
}

/** 假引擎：按输入图字节（base64 → 原文）出草稿；记录调用序与并发峰值 */
function makeProvider(recipes: Record<string, Partial<OnestepDraft> | 'throw'>) {
  const calls: string[] = [];
  let active = 0;
  let maxActive = 0;
  const provider: OnestepProvider = {
    name: 'fake-ai-clean',
    async extract(input: OnestepExtractInput): Promise<OnestepDraft[]> {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const text = input.image.dataBase64;
      calls.push(text);
      await new Promise((r) => setTimeout(r, 1));
      active -= 1;
      const recipe = recipes[text];
      if (recipe === undefined) throw new Error(`无该图配方（${text.slice(0, 12)}…）`);
      if (recipe === 'throw') throw new Error('模型调用失败（假）');
      return [draft(recipe)];
    },
  };
  return { provider, calls, maxActiveOf: () => maxActive };
}

/** 假 bank 面（内存表；只记调用，不碰 SQL） */
function makeFakeBank(seed: AiCleanQuestionLike[]) {
  const rows = new Map(seed.map((q) => [q.id, { ...q }]));
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const logs: Array<{ kind: 'start' | 'success' | 'failure'; op: string; detail: unknown }> = [];
  return {
    rows, updates, logs,
    getQuestion: async (id: string) => (rows.has(id) ? { ...rows.get(id)! } : null),
    updateQuestion: async (id: string, patch: Record<string, unknown>) => {
      updates.push({ id, patch });
      rows.set(id, { ...rows.get(id)!, ...patch });
      return rows.get(id);
    },
    logger: {
      logStart: (op: string) => { logs.push({ kind: 'start', op, detail: null }); return `log-${logs.length}`; },
      logSuccess: (id: string, affected: number) => { logs.push({ kind: 'success', op: id, detail: { affected } }); },
      logFailure: (id: string, error: Error) => { logs.push({ kind: 'failure', op: id, detail: { message: error.message } }); },
    },
  };
}

const questions: AiCleanQuestionLike[] = [
  {
    id: 'q1',
    content: contentWith([F1]),
    answer: `<img src="data-assets/${ANS}">`,
    analysis: '',
    images: [
      { assetId: `data-assets/${F1}`, type: 'figure' },
      { assetId: `data-assets/${ANS}`, type: 'answer-image' },
    ],
    sourceDetail: { site: 'zujuan', questionId: '1' },
  },
  {
    id: 'q2',
    content: contentWith([F2]),
    answer: '0.6',
    analysis: '',
    images: [{ assetId: `data-assets/${F2}`, type: 'figure' }],
    sourceDetail: { site: 'zujuan', questionId: '2' },
  },
  {
    id: 'q3',
    content: '<div class="question">纯文字题<div class="options"></div></div>',
    answer: '',
    analysis: '',
    images: [],
    sourceDetail: { site: 'zujuan', questionId: '3' },
  },
  {
    id: 'q4',
    content: contentWith([F1]),
    answer: '',
    analysis: '',
    images: [],
    // 子母题标记（采集层 quesChildNum>1 链；本批不整理，等 R-042 结构批）
    sourceDetail: { site: 'zujuan', questionId: '4', childQuestionCount: 3 },
  },
];

const RECIPES = {
  [PNG_A.toString('base64')]: { stemMarkdown: '$\\sin 37°=0.6$' },
  [SVG_F2.toString('base64')]: { stemMarkdown: '$\\cos 60°=0.5$' },
  [PNG_B.toString('base64')]: { answerMarkdown: '0.6', analysisMarkdown: '由勾股定理得' },
};

describe('0056 preview：只产出对照（零写库）', () => {
  it('全链：公式图 → math span、答案图 → answer/analysis 双出、images 列同步维护', async () => {
    const bank = makeFakeBank(questions);
    const { provider } = makeProvider(RECIPES);
    const items = await previewQuestionAiClean(
      { getQuestion: bank.getQuestion, updateQuestion: bank.updateQuestion, dataDir, provider },
      ['q1'],
    );
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.ok).toBe(true);
    expect(item.skipped).toBeNull();
    expect(item.converted).toBe(2);
    expect(item.after!.content).toContain('<span class="math" data-tex="\\sin 37°=0.6"></span>');
    expect(item.after!.content).not.toContain('inline-figure');
    expect(item.after!.answer).toBe('<p>0.6</p>');
    expect(item.after!.analysis).toBe('<p>由勾股定理得</p>');
    expect(item.after!.images.map((i) => i.assetId)).toEqual([]);
    // 对照面：before 是原值（弹层并排用）
    expect(item.before!.content).toContain('inline-figure');
    expect(item.before!.answer).toBe(`<img src="data-assets/${ANS}">`);
    // P-07：preview 零写库
    expect(bank.updates).toHaveLength(0);
  });

  it('逐题串行无并发（AI 成本口径），且无图题不发调用', async () => {
    const bank = makeFakeBank(questions);
    const { provider, calls, maxActiveOf } = makeProvider(RECIPES);
    const items = await previewQuestionAiClean(
      {
        getQuestion: bank.getQuestion,
        updateQuestion: bank.updateQuestion,
        dataDir,
        provider,
        // 目检返工①：真机上 SVG 由图片准备器栅格化；此处用「原样转发」替身保 3 个图位都进模型
        prepareImages: async (requests) => new Map(requests.map((r) => [r.key, { dataBase64: r.bytes.toString('base64'), mime: 'image/png' }])),
      },
      ['q1', 'q2', 'q3'],
    );
    expect(maxActiveOf()).toBe(1);
    // q1 = 公式图F1 + 答案图ANS；q2 = 公式图F2；q3 无图
    expect(calls).toHaveLength(3);
    const q3 = items.find((i) => i.questionId === 'q3')!;
    expect(q3.ok).toBe(false);
    expect(q3.skipped).toBeTruthy();
  });

  it('同图去重：同一 src 在同一轮只调一次引擎（多题共用）', async () => {
    const bank = makeFakeBank([
      { ...questions[0]!, id: 'a', answer: '', images: [] },
      { ...questions[0]!, id: 'b', answer: '', images: [] },
    ]);
    const { provider, calls } = makeProvider(RECIPES);
    await previewQuestionAiClean(
      { getQuestion: bank.getQuestion, updateQuestion: bank.updateQuestion, dataDir, provider },
      ['a', 'b'],
    );
    expect(calls).toEqual([PNG_A.toString('base64')]);
  });

  it('子母题跳过：provider 零调用、原因可见（R-042 批再做）', async () => {
    const bank = makeFakeBank(questions);
    const { provider, calls } = makeProvider(RECIPES);
    const items = await previewQuestionAiClean(
      { getQuestion: bank.getQuestion, updateQuestion: bank.updateQuestion, dataDir, provider },
      ['q4'],
    );
    expect(items[0]!.ok).toBe(false);
    expect(items[0]!.skipped).toContain('小题');
    expect(calls).toEqual([]);
  });

  it('引擎抛错 → 该题 ok=false + 原因；资产缺失 → 该题失败不中断整批', async () => {
    const bank = makeFakeBank([
      { ...questions[0]!, id: 'bad-engine', answer: '', images: [] },
      { ...questions[0]!, id: 'missing-asset', answer: '', images: [] },
    ]);
    // missing-asset 用不存在的资产路径
    bank.rows.set('missing-asset', {
      ...bank.rows.get('missing-asset')!,
      content: contentWith(['capture/zujuan/ghost.png']),
    });
    const { provider } = makeProvider({ [PNG_A.toString('base64')]: 'throw' });
    const items = await previewQuestionAiClean(
      { getQuestion: bank.getQuestion, updateQuestion: bank.updateQuestion, dataDir, provider },
      ['bad-engine', 'missing-asset'],
    );
    expect(items[0]!.ok).toBe(false);
    expect(items[0]!.error).toContain('模型调用失败');
    expect(items[1]!.ok).toBe(false);
    expect(items[1]!.error).toBeTruthy();
    expect(items).toHaveLength(2);
  });

  it('整理后重跑 → 无行内图可转，判跳过（幂等语义）', async () => {
    const bank = makeFakeBank(questions);
    const { provider } = makeProvider(RECIPES);
    const first = await previewQuestionAiClean(
      { getQuestion: bank.getQuestion, updateQuestion: bank.updateQuestion, dataDir, provider },
      ['q1'],
    );
    bank.rows.set('q1', { ...bank.rows.get('q1')!, ...first[0]!.after! });
    const second = await previewQuestionAiClean(
      { getQuestion: bank.getQuestion, updateQuestion: bank.updateQuestion, dataDir, provider },
      ['q1'],
    );
    expect(second[0]!.skipped).toBeTruthy();
    expect(second[0]!.after).toBeNull();
  });
});

describe('0056 commit：人确认后落库 + 台账', () => {
  it('落库三字段 + images；台账 start/success（affected=成功题数）', async () => {
    const bank = makeFakeBank(questions);
    const { provider } = makeProvider(RECIPES);
    const passPrep = async (requests: Array<{ key: string; bytes: Buffer }>) =>
      new Map(requests.map((r) => [r.key, { dataBase64: r.bytes.toString('base64'), mime: 'image/png' }]));
    const items = await previewQuestionAiClean(
      { getQuestion: bank.getQuestion, updateQuestion: bank.updateQuestion, dataDir, provider, prepareImages: passPrep },
      ['q1', 'q2'],
    );
    const patches = items.filter((i) => i.ok).map((i) => ({
      questionId: i.questionId,
      content: i.after!.content,
      answer: i.after!.answer,
      analysis: i.after!.analysis,
      images: i.after!.images,
    }));
    const result = await commitQuestionAiClean(
      { getQuestion: bank.getQuestion, updateQuestion: bank.updateQuestion, dataDir, provider, logger: bank.logger },
      patches,
    );
    expect(result.saved).toBe(2);
    expect(result.failed).toEqual([]);
    expect(bank.logs.filter((l) => l.kind === 'start')).toHaveLength(1);
    expect(bank.logs.find((l) => l.kind === 'success')).toEqual({ kind: 'success', op: 'log-1', detail: { affected: 2 } });
    expect(bank.rows.get('q1')!.content).toContain('<span class="math"');
    expect(bank.rows.get('q2')!.content).toContain('data-tex="\\cos 60°=0.5"');
  });

  it('单题落库失败 → 记账并继续（不整批回滚）；台账 failed 分支', async () => {
    const bank = makeFakeBank(questions);
    const { provider } = makeProvider(RECIPES);
    const passPrep = async (requests: Array<{ key: string; bytes: Buffer }>) =>
      new Map(requests.map((r) => [r.key, { dataBase64: r.bytes.toString('base64'), mime: 'image/png' }]));
    const items = await previewQuestionAiClean(
      { getQuestion: bank.getQuestion, updateQuestion: bank.updateQuestion, dataDir, provider, prepareImages: passPrep },
      ['q1', 'q2'],
    );
    const patches = items.filter((i) => i.ok).map((i) => ({
      questionId: i.questionId,
      content: i.after!.content,
      answer: i.after!.answer,
      analysis: i.after!.analysis,
      images: i.after!.images,
    }));
    const updateQuestion = vi.fn(async (id: string, patch: Record<string, unknown>) => {
      if (id === 'q1') throw new Error('库锁');
      return bank.updateQuestion(id, patch);
    });
    const result = await commitQuestionAiClean(
      { getQuestion: bank.getQuestion, updateQuestion, dataDir, provider, logger: bank.logger },
      patches,
    );
    expect(result.saved).toBe(1);
    expect(result.failed).toEqual([{ questionId: 'q1', reason: '库锁' }]);
    expect(bank.logs.some((l) => l.kind === 'failure')).toBe(true);
  });

  it('零条待落库：不写台账（不产空账）', async () => {
    const bank = makeFakeBank(questions);
    const { provider } = makeProvider(RECIPES);
    const result = await commitQuestionAiClean(
      { getQuestion: bank.getQuestion, updateQuestion: bank.updateQuestion, dataDir, provider, logger: bank.logger },
      [],
    );
    expect(result.saved).toBe(0);
    expect(bank.logs).toHaveLength(0);
  });
});

describe('0056 目检返工①：SVG 靶必须栅格化后才送模型（真机 400 根因）', () => {

  it('未注入准备器时：SVG 靶判失败并给「需栅格化」原因，**不把 SVG 发给模型**', async () => {
    const bank = makeFakeBank([{ ...questions[1]!, id: 'svg-q', answer: '', images: [] }]);
    const { provider, calls } = makeProvider(RECIPES);
    const items = await previewQuestionAiClean(
      { getQuestion: bank.getQuestion, updateQuestion: bank.updateQuestion, dataDir, provider },
      ['svg-q'],
    );
    expect(calls).toEqual([]); // 零模型调用
    expect(items[0]!.ok).toBe(false);
    expect(items[0]!.failedImages[0]!.reason).toContain('栅格化');
  });

  it('注入真口径准备器：模型收到的是 PNG（mime=image/png），不再是 image/svg+xml', async () => {
    const bank = makeFakeBank([{ ...questions[1]!, id: 'svg-q', answer: '', images: [] }]);
    const seen: Array<{ mime: string; base64: string }> = [];
    const provider = {
      name: 'spy',
      extract: async (input: { image: { mime: string; dataBase64: string } }) => {
        seen.push({ mime: input.image.mime, base64: input.image.dataBase64 });
        return [draft({ stemMarkdown: '$\\cos 60°=0.5$' })];
      },
    };
    const prepareCalls: string[][] = [];
    const items = await previewQuestionAiClean(
      {
        getQuestion: bank.getQuestion,
        updateQuestion: bank.updateQuestion,
        dataDir,
        provider,
        prepareImages: async (requests) => {
          prepareCalls.push(requests.map((r) => r.key));
          return new Map(requests.map((r) => [r.key, { dataBase64: 'UE5HQllURVM=', mime: 'image/png', note: 'SVG 栅格化' }]));
        },
      },
      ['svg-q'],
    );
    expect(prepareCalls).toEqual([['formula:capture/zujuan/f2.svg']]);
    expect(seen).toEqual([{ mime: 'image/png', base64: 'UE5HQllURVM=' }]);
    expect(items[0]!.ok).toBe(true);
  });

  it('位图靶按真身嗅探 mime（.png 里装的是 JPEG → 发 image/jpeg）；每题只准备一次（批量）', async () => {
    putAsset('capture/zujuan/lie.png', '\u00ff\u00d8\u00ffJPEGDATA'); // 扩展名 png、字节是 JPEG
    const bank = makeFakeBank([
      { ...questions[0]!, id: 'multi', answer: '', images: [] },
    ]);
    bank.rows.set('multi', {
      ...bank.rows.get('multi')!,
      content: contentWith([F1, 'capture/zujuan/lie.png', F1]),
    });
    const seenMimes: string[] = [];
    const provider = {
      name: 'spy2',
      extract: async (input: { image: { mime: string } }) => {
        seenMimes.push(input.image.mime);
        return [draft({ stemMarkdown: '$x$' })];
      },
    };
    const prepareCalls: string[][] = [];
    await previewQuestionAiClean(
      {
        getQuestion: bank.getQuestion,
        updateQuestion: bank.updateQuestion,
        dataDir,
        provider,
        prepareImages: async (requests) => {
          prepareCalls.push(requests.map((r) => r.key));
          return new Map(requests.map((r) => [r.key, { dataBase64: 'AAA=', mime: r.assetRelPath.endsWith('lie.png') ? 'image/jpeg' : 'image/png' }]));
        },
      },
      ['multi'],
    );
    expect(prepareCalls).toHaveLength(1); // 一次批量（3 个图位 → 2 个唯一资产）
    expect(prepareCalls[0]!.sort()).toEqual(['formula:capture/zujuan/f1.png', 'formula:capture/zujuan/lie.png']);
    expect(seenMimes.sort()).toEqual(['image/jpeg', 'image/png']);
  });

  it('准备失败的靶记账但其余靶照转（单图失败不拖垮整题）', async () => {
    putAsset('capture/zujuan/broken.svg', '<svg width="8" height="8"></svg>');
    const bank = makeFakeBank([{ ...questions[0]!, id: 'partial', answer: '', images: [] }]);
    bank.rows.set('partial', {
      ...bank.rows.get('partial')!,
      content: contentWith([F1, 'capture/zujuan/broken.svg']),
    });
    const { provider } = makeProvider(RECIPES);
    const items = await previewQuestionAiClean(
      {
        getQuestion: bank.getQuestion,
        updateQuestion: bank.updateQuestion,
        dataDir,
        provider,
        prepareImages: async (requests) => new Map(requests.map((r) => [
          r.key,
          r.assetRelPath.endsWith('.svg') ? { error: 'SVG 栅格化失败：载入超时' } : { dataBase64: PNG_A.toString('base64'), mime: 'image/png' },
        ])),
      },
      ['partial'],
    );
    expect(items[0]!.ok).toBe(true);
    expect(items[0]!.converted).toBe(1);
    expect(items[0]!.failedImages).toEqual([{ src: 'data-assets/capture/zujuan/broken.svg', field: 'content', reason: 'SVG 栅格化失败：载入超时' }]);
  });

  it('答案靶「空内容」失败 → 原因补一句占位图提示（真库 12 道组卷 403 占位图在案）', async () => {
    const bank = makeFakeBank([{ ...questions[0]!, id: 'ans-only', content: '<div class="question">题<div class="options"></div></div>' }]);
    const provider = {
      name: 'empty-ocr',
      extract: async () => {
        throw new Error('OCR 转写腿返回空内容（该档案不具备转写能力域）');
      },
    };
    const items = await previewQuestionAiClean(
      {
        getQuestion: bank.getQuestion,
        updateQuestion: bank.updateQuestion,
        dataDir,
        provider,
        prepareImages: async (requests) => new Map(requests.map((r) => [r.key, { dataBase64: PNG_B.toString('base64'), mime: 'image/png' }])),
      },
      ['ans-only'],
    );
    expect(items[0]!.failedImages[0]!.reason).toContain('不具备转写能力域');
    // 返工⑧：不再猜「403 占位图」（用户第二道样题里它被重复 8 次、看着像程序坏了），改为标清字段
    expect(items[0]!.failedImages[0]!.reason).toContain('（答案区图）');
    expect(items[0]!.failedImages[0]!.field).toBe('answer');
  });

  // 【0065（R-068）等强改写，登记在案】口径变更：含正文字段的图**不再进 deferred 挡门**，
  // 改为走「原位替换」（`mode='inline-figures'`）——该图会**送引擎**（原口径是零调用挡门），
  // 转写成功则正文一字不动、图位变 span.math。断言只强不弱：原断言「零调用 + 进 deferred」，
  // 现断言「该图确实转写 + 正文守恒 + deferred 空 + fieldModes 标 inline-figures」。
  it('0065 改写：解析区含正文 → 内嵌图原位替换（题级 ok、正文守恒、deferred 空、零失败）', async () => {
    const ANA = 'capture/zujuan/ans-analysis.png';
    putAsset(ANA, PNG_A);
    const bank = makeFakeBank([{
      ...questions[1]!,
      id: 'ana-text',
      // 题面纯文字（无公式图）→ 本题只有 1 张靶（解析区那张），单图路径，不进拼图
      content: '<div class="question">纯文字题干<div class="options"></div></div>',
      answer: '0.6',
      analysis: `<p>解析：由牛顿第二定律可得</p><img src="data-assets/${ANA}">`,
      images: [],
    }]);
    const { provider, calls } = makeProvider(RECIPES);
    const items = await previewQuestionAiClean(
      {
        getQuestion: bank.getQuestion, updateQuestion: bank.updateQuestion, dataDir, provider,
        prepareImages: async (requests) => new Map(requests.map((r) => [r.key, { dataBase64: PNG_A.toString('base64'), mime: 'image/png' }])),
      },
      ['ana-text'],
    );
    expect(calls).toHaveLength(1);                       // 解析区那张：真的送了引擎（旧口径是零调用挡门）
    expect(items[0]!.ok).toBe(true);
    expect(items[0]!.failedImages).toEqual([]);          // 不是失败
    expect(items[0]!.deferred ?? []).toEqual([]);        // 挡门退役
    expect(items[0]!.fieldModes).toEqual({ analysis: 'inline-figures' });
    const after = items[0]!.after!;
    expect(after.analysis).toContain('牛顿第二定律');     // 正文逐字保留
    expect(after.analysis).not.toContain('<img');
    expect(after.analysis).toContain('<span class="math" data-tex="\\sin 37°=0.6"></span>');
    expect(items[0]!.before!.analysis).toContain('牛顿第二定律');
  });
});

describe('0056 返工⑦：公式靶「拼大图」主路径 + 转写腿链（推理主腿 / 专用 OCR 兜底）', () => {
  const MONTAGE_PNG = Buffer.concat([PNG_B, Buffer.from('montage')]);
  const MONTAGE_B64 = MONTAGE_PNG.toString('base64');

  /** 准备器替身：给出尺寸（拼图排版要用）——base64 用「资产路径原文」编码以便识别 */
  function seedSized(): (requests: Array<{ key: string; assetRelPath: string }>) => Promise<Map<string, unknown>> {
    return async (requests) => new Map(requests.map((r) => [r.key, {
      dataBase64: Buffer.from(`TXT:${r.assetRelPath}`).toString('base64'),
      mime: 'image/png',
      width: 100,
      height: 50,
    }]));
  }

  /** 拼图渲染替身（记录入参） */
  function makeRenderer(outcome?: { fail?: string }) {
    const calls: Array<{ keys: string[]; plan: { cols: number; rows: number; width: number; height: number } }> = [];
    const render = async (fragments: Array<{ key: string }>, plan: { cols: number; rows: number; width: number; height: number }) => {
      calls.push({ keys: fragments.map((f) => f.key), plan });
      if (outcome?.fail !== undefined) return { ok: false as const, error: outcome.fail };
      return { ok: true as const, png: MONTAGE_PNG };
    };
    return { render, calls };
  }

  /** 假 provider：拼图调用（认得 MONTAGE_B64）回编号行；单图调用按资产路径回文本 */
  function makeLayered(montageRows: string, perAsset: Record<string, string>) {
    const calls: string[] = [];
    const provider = {
      name: 'fake-layered',
      async extract(): Promise<[]> { throw new Error('公式靶不应走 extract'); },
      async transcribe(input: { image: { dataBase64: string } }): Promise<string> {
        calls.push(input.image.dataBase64);
        if (input.image.dataBase64 === MONTAGE_B64) return montageRows;
        const rel = Buffer.from(input.image.dataBase64, 'base64').toString('utf8').replace(/^TXT:/, '');
        return perAsset[rel] ?? '';
      },
    };
    return { provider, calls };
  }

  it('一题两张公式 → 恰一次拼图调用取回全部（不再逐图调）', async () => {
    const bank = makeFakeBank([{ ...questions[1]!, id: 'm2', content: contentWith([F2, F1]), answer: '', images: [] }]);
    const { render, calls: renders } = makeRenderer();
    const { provider, calls } = makeLayered('1: \\sqrt{gd}\n2: \\frac{9d}{20}', {});
    const items = await previewQuestionAiClean(
      {
        getQuestion: bank.getQuestion, updateQuestion: bank.updateQuestion, dataDir,
        provider: provider as never, prepareImages: seedSized() as never, renderMontage: render as never,
      },
      ['m2'],
    );
    expect(renders).toHaveLength(1);
    expect(renders[0]!.keys).toEqual([`formula:${F2}`, `formula:${F1}`]);
    expect(renders[0]!.plan).toMatchObject({ cols: 2, rows: 1 });          // 两张 → 单行两列
    expect(calls).toEqual([MONTAGE_B64]);                                  // 全程只有拼图这一次模型调用
    expect(items[0]!.ok).toBe(true);
    expect(items[0]!.converted).toBe(2);
    expect(items[0]!.after!.content).toContain('data-tex="\\sqrt{gd}"');
    expect(items[0]!.after!.content).toContain('data-tex="\\frac{9d}{20}"');
    expect(items[0]!.needsReview).toBeUndefined();
  });

  it('拼图某行不过闸门（幻觉形态）→ **只该行**回退单图，其余行照常采用', async () => {
    const bank = makeFakeBank([{ ...questions[1]!, id: 'm2b', content: contentWith([F2, F1]), answer: '', images: [] }]);
    const { render } = makeRenderer();
    const { provider, calls } = makeLayered('1: \\sqrt{gd}\n2: [Image of a blackboard with equations]', {
      [F1]: '\\frac{9d}{20}',
    });
    const items = await previewQuestionAiClean(
      {
        getQuestion: bank.getQuestion, updateQuestion: bank.updateQuestion, dataDir,
        provider: provider as never, prepareImages: seedSized() as never, renderMontage: render as never,
      },
      ['m2b'],
    );
    expect(calls).toHaveLength(2);                                         // 拼图 1 次 + 第 2 行单图重试 1 次
    expect(items[0]!.ok).toBe(true);
    expect(items[0]!.converted).toBe(2);
    expect(items[0]!.warnings.some((w) => w.includes('拼图第 2 行') && w.includes('已按单图重试'))).toBe(true);
  });

  it('拼图回包不能按编号对齐 → 整片作废，全部走单图兜底（可见告警）', async () => {
    const bank = makeFakeBank([{ ...questions[1]!, id: 'm2c', content: contentWith([F2, F1]), answer: '', images: [] }]);
    const { render } = makeRenderer();
    const { provider, calls } = makeLayered('banana\nkiwi', { [F1]: '\\frac{9d}{20}', [F2]: '\\sqrt{gd}' });
    const items = await previewQuestionAiClean(
      {
        getQuestion: bank.getQuestion, updateQuestion: bank.updateQuestion, dataDir,
        provider: provider as never, prepareImages: seedSized() as never, renderMontage: render as never,
      },
      ['m2c'],
    );
    expect(calls).toHaveLength(3);                                         // 拼图 1 次 + 两图各单图 1 次
    expect(items[0]!.ok).toBe(true);
    expect(items[0]!.converted).toBe(2);
    expect(items[0]!.warnings.some((w) => w.includes('拼图未通过') && w.includes('已按单图重试'))).toBe(true);
  });

  it('拼图渲染失败 → 全部走单图兜底（不阻断整题）', async () => {
    const bank = makeFakeBank([{ ...questions[1]!, id: 'm2d', content: contentWith([F2, F1]), answer: '', images: [] }]);
    const { render } = makeRenderer({ fail: '画布炸了（假）' });
    const { provider, calls } = makeLayered('1: \\sqrt{gd}\n2: \\frac{9d}{20}', { [F1]: '\\frac{9d}{20}', [F2]: '\\sqrt{gd}' });
    const items = await previewQuestionAiClean(
      {
        getQuestion: bank.getQuestion, updateQuestion: bank.updateQuestion, dataDir,
        provider: provider as never, prepareImages: seedSized() as never, renderMontage: render as never,
      },
      ['m2d'],
    );
    expect(calls).toHaveLength(2);                                         // 拼图没发模型调用，只有两次单图
    expect(items[0]!.ok).toBe(true);
    expect(items[0]!.warnings.some((w) => w.includes('拼图渲染失败'))).toBe(true);
  });

  it('模型忘编号但行数对齐 → 按行序采用 + 挂「建议人工核对」告警', async () => {
    const bank = makeFakeBank([{ ...questions[1]!, id: 'm2e', content: contentWith([F2, F1]), answer: '', images: [] }]);
    const { render } = makeRenderer();
    const { provider } = makeLayered('\\sqrt{gd}\n\\frac{9d}{20}', {});
    const items = await previewQuestionAiClean(
      {
        getQuestion: bank.getQuestion, updateQuestion: bank.updateQuestion, dataDir,
        provider: provider as never, prepareImages: seedSized() as never, renderMontage: render as never,
      },
      ['m2e'],
    );
    expect(items[0]!.converted).toBe(2);
    expect(items[0]!.after!.content).toContain('data-tex="\\sqrt{gd}"');
    expect(items[0]!.warnings.some((w) => w.includes('未编号') && w.includes('人工核对'))).toBe(true);
  });

  it('单张公式不拼图（拼图至少两张）', async () => {
    const bank = makeFakeBank([{ ...questions[1]!, id: 'm1', answer: '', images: [] }]);
    const { render, calls: renders } = makeRenderer();
    const { provider, calls } = makeLayered('1: x', { [F2]: '\\sqrt{gd}' });
    const items = await previewQuestionAiClean(
      {
        getQuestion: bank.getQuestion, updateQuestion: bank.updateQuestion, dataDir,
        provider: provider as never, prepareImages: seedSized() as never, renderMontage: render as never,
      },
      ['m1'],
    );
    expect(renders).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(items[0]!.ok).toBe(true);
  });

  it('大图不进拼图（>520px 门槛）：只剩 1 张小图 → 不拼，两张各走单图', async () => {
    const bank = makeFakeBank([{ ...questions[1]!, id: 'm-big', content: contentWith([F2, F1]), answer: '', images: [] }]);
    const { render, calls: renders } = makeRenderer();
    const { provider, calls } = makeLayered('1: x\n2: y', { [F1]: '\\frac{9d}{20}', [F2]: '\\sqrt{gd}' });
    const sized = async (requests: Array<{ key: string; assetRelPath: string }>) => new Map(requests.map((r) => [r.key, {
      dataBase64: Buffer.from(`TXT:${r.assetRelPath}`).toString('base64'),
      mime: 'image/png',
      width: r.assetRelPath === F1 ? 1768 : 100,
      height: r.assetRelPath === F1 ? 968 : 50,
    }]));
    const items = await previewQuestionAiClean(
      {
        getQuestion: bank.getQuestion, updateQuestion: bank.updateQuestion, dataDir,
        provider: provider as never, prepareImages: sized as never, renderMontage: render as never,
      },
      ['m-big'],
    );
    expect(renders).toHaveLength(0);                                      // 只剩 1 张可拼 → 不拼
    expect(calls).toHaveLength(2);                                        // 两张各单图
    expect(items[0]!.converted).toBe(2);
  });

  it('转写腿链：主腿（reasoning）通过 → 只调一次、无回退告警', async () => {
    const bank = makeFakeBank([{ ...questions[1]!, id: 'chain-a', answer: '', images: [] }]);
    const roles: string[] = [];
    const invoke = async (payload: { role: string }): Promise<{ ok: boolean; content: string }> => {
      roles.push(payload.role);
      return { ok: true, content: '\\sqrt{gd}' };
    };
    const items = await previewQuestionAiClean(
      { getQuestion: bank.getQuestion, updateQuestion: bank.updateQuestion, dataDir, invoke: invoke as never, prepareImages: seedSized() as never },
      ['chain-a'],
    );
    expect(roles).toEqual(['reasoning']);
    expect(items[0]!.after!.content).toContain('data-tex="\\sqrt{gd}"');
    expect(items[0]!.warnings.some((w) => w.includes('回退'))).toBe(false);
  });

  it('转写腿链：主腿不可用 → 回退专用 OCR 腿并在告警里写明', async () => {
    const bank = makeFakeBank([{ ...questions[1]!, id: 'chain-b', answer: '', images: [] }]);
    const roles: string[] = [];
    const invoke = async (payload: { role: string }): Promise<{ ok: boolean; content?: string; error?: string; code?: string }> => {
      roles.push(payload.role);
      if (payload.role === 'reasoning') return { ok: false, error: '未配置启用档案（reasoning）', code: 'config' };
      return { ok: true, content: '\\sqrt{gd}' };
    };
    const items = await previewQuestionAiClean(
      { getQuestion: bank.getQuestion, updateQuestion: bank.updateQuestion, dataDir, invoke: invoke as never, prepareImages: seedSized() as never },
      ['chain-b'],
    );
    expect(roles).toEqual(['reasoning', 'vision']);
    expect(items[0]!.ok).toBe(true);
    expect(items[0]!.after!.content).toContain('data-tex="\\sqrt{gd}"');
    expect(items[0]!.warnings.some((w) => w.includes('回退到「vision」腿'))).toBe(true);
  });
});

describe('0056 返工④/⑥：公式纯转写 / 骨架校验（单模型，不做第二意见腿）', () => {
  const SVG_ASSET = 'capture/zujuan/f2.svg';

  /** 假 provider：transcribe 直出（记录调用），extract 不该被公式靶用到 */
  function makeTranscriber(texts: Record<string, string>, calls: string[] = []) {
    return {
      name: 'fake-transcribe',
      async extract(): Promise<[] > { throw new Error('公式靶不应走 extract（返工④：转写文本直用）'); },
      async transcribe(input: { image: { dataBase64: string } }): Promise<string> {
        const rel = Object.entries(assetsByPayload).find(([, b64]) => b64 === input.image.dataBase64)?.[0] ?? '?';
        calls.push(rel);
        return texts[rel] ?? '';
      },
    };
  }
  const assetsByPayload: Record<string, string> = {};

  function seedAssets(): void {
    // 让 payload → 资产 的映射可解：准备器替身把「资产相对路径」原文编出来
    for (const rel of [SVG_ASSET, F1, ANS]) assetsByPayload[rel] = Buffer.from(`TXT:${rel}`).toString('base64');
    const prep = async (requests: Array<{ key: string; assetRelPath: string }>) => new Map(requests.map((r) => [
      r.key,
      { dataBase64: assetsByPayload[r.assetRelPath] ?? Buffer.from('?').toString('base64'), mime: 'image/png' },
    ]));
    return prep;
  }

  it('公式靶走 transcribe（不走 extract）+ 结果为清洗后的 LaTeX', async () => {
    const bank = makeFakeBank([{ ...questions[1]!, id: 'f-only', answer: '', images: [] }]);
    const calls: string[] = [];
    const provider = makeTranscriber({ [SVG_ASSET]: '```latex\n\\frac{m}{qBL}\n```' }, calls);
    const items = await previewQuestionAiClean(
      { getQuestion: bank.getQuestion, updateQuestion: bank.updateQuestion, dataDir, provider: provider as never, prepareImages: seedAssets() },
      ['f-only'],
    );
    expect(calls).toEqual([SVG_ASSET]);
    expect(items[0]!.ok).toBe(true);
    expect(items[0]!.after!.content).toContain('data-tex="\\frac{m}{qBL}"');
    expect(items[0]!.warnings.some((w) => w.includes('结果已清洗'))).toBe(true);
  });

  it('骨架矛盾（真 SVG 有线信号但无分数线，结果含 \frac）→ 标可疑且 needsReview（默认不勾选）', async () => {
    // 有线信号（根号形态：斜笔 + 短笔 + 首尾相接的横梁）但**没有独立横线** → 结果里的 \frac 属幻觉
    putAsset(SVG_ASSET, [
      '<svg xmlns="http://www.w3.org/2000/svg" width="29" height="23"><g>',
      '<line y2="22" x1="1.3333" x2="4.6889" y1="12.3"/>',
      '<line y2="0.7333" x1="4.6889" x2="8.0444" y1="22"/>',
      '<line y2="0.7333" x1="8.0444" x2="27.0819" y1="0.7333"/>',
      '<g transform="translate(8,18)"><path d="M1 1"/></g></g></svg>',
    ].join(''));
    const bank = makeFakeBank([{ ...questions[1]!, id: 'suspect', answer: '', images: [] }]);
    const provider = makeTranscriber({ [SVG_ASSET]: '\\frac{a}{b}' });
    const items = await previewQuestionAiClean(
      { getQuestion: bank.getQuestion, updateQuestion: bank.updateQuestion, dataDir, provider: provider as never, prepareImages: seedAssets() },
      ['suspect'],
    );
    expect(items[0]!.ok).toBe(true);
    expect(items[0]!.needsReview).toBe(true);
    expect(items[0]!.warnings.some((w) => w.includes('没有分数线'))).toBe(true);
  });

  it('垃圾形态（长文本幻觉）→ 判该图失败、保留原图，绝不写进 data-tex', async () => {
    const bank = makeFakeBank([{ ...questions[1]!, id: 'garbage', answer: '', images: [] }]);
    const provider = makeTranscriber({ [SVG_ASSET]: '[Image of a blackboard with equations]' });
    const items = await previewQuestionAiClean(
      { getQuestion: bank.getQuestion, updateQuestion: bank.updateQuestion, dataDir, provider: provider as never, prepareImages: seedAssets() },
      ['garbage'],
    );
    expect(items[0]!.ok).toBe(false);
    expect(items[0]!.failedImages[0]!.reason).toContain('非公式');
    expect(items[0]!.after).toBeNull();
  });

  it('返工⑥（用户拍板）：单模型——结果无骨架矛盾就不带 needsReview，也不再有第二意见腿', async () => {
    const bank = makeFakeBank([{ ...questions[1]!, id: 'single', answer: '', images: [] }]);
    // 单个 provider 只被调一次（转写腿）；编排层不再向任何「第二次」调用伸手
    const calls: string[] = [];
    const provider = makeTranscriber({ [SVG_ASSET]: '\\cos 60°=0.5' }, calls);
    const items = await previewQuestionAiClean(
      { getQuestion: bank.getQuestion, updateQuestion: bank.updateQuestion, dataDir, provider: provider as never, prepareImages: seedAssets() },
      ['single'],
    );
    expect(calls).toEqual([SVG_ASSET]);          // 恰一次转写（无第二腿）
    expect(items[0]!.ok).toBe(true);
    expect(items[0]!.needsReview).toBeUndefined();
    expect(items[0]!.after!.content).toContain('data-tex="\\cos 60°=0.5"');
  });
});

describe('0056 handler：bank.question.aiClean 形验 + 透传', () => {
  function register(bank: ReturnType<typeof makeFakeBank>, invoke: (...args: unknown[]) => unknown) {
    registerQuestionAiCleanIpcHandlers({
      getBank: () => bank as unknown as never,
      invoke: invoke as never,
      dataDir,
      logger: () => bank.logger,
    });
  }

  it('preview：payload 透传、返回 items；questionIds 非数组即拒', async () => {
    const bank = makeFakeBank(questions);
    register(bank, () => { throw new Error('不应走到引擎'); });
    const handler = handlers.get(IPC_CHANNELS.QUESTION_AI_CLEAN)!;
    expect(handler).toBeTypeOf('function');
    const result = await handler({}, { mode: 'preview', questionIds: ['q3'] }) as { mode: string; items: unknown[] };
    expect(result.mode).toBe('preview');
    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items).toHaveLength(1);
    await expect(handler({}, { mode: 'preview' })).rejects.toThrow(/questionIds/);
    await expect(handler({}, { mode: 'nope', questionIds: [] })).rejects.toThrow(/mode/);
    await expect(handler({}, null)).rejects.toThrow(/payload/);
  });

  it('commit：items 形验（缺字段即拒）并逐条落库', async () => {
    const bank = makeFakeBank(questions);
    register(bank, () => { throw new Error('不应走到引擎'); });
    const handler = handlers.get(IPC_CHANNELS.QUESTION_AI_CLEAN)!;
    const result = await handler({}, {
      mode: 'commit',
      questionIds: ['q1'],
      items: [{ questionId: 'q1', content: '<div class="question">x</div>', answer: '', analysis: '', images: [] }],
    }) as { saved: number };
    expect(result.saved).toBe(1);
    await expect(handler({}, { mode: 'commit', questionIds: ['q1'], items: [{ questionId: 'q1' }] })).rejects.toThrow(/items/);
  });
});
