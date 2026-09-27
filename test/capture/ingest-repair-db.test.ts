// 0006-P4-fix-1 P3：dup 命中时的裂图字段修复性回填（真 SQLite + 真 BankService + 真资产管线）
// 语义（任务书 §一 P3 定向扩张）：库存字段损坏 且 本次归一化产物不再含裂图形态 → 覆盖该字段并同步刷新 images；
// 库存健康 / 本次仍裂 / 本次无产物 → 不动（保护健康内容与用户编辑）。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDatabase, type Database } from '../../src/bank/db.js';
import { BankServiceImpl } from '../../src/bank/bank-service.js';
import { ingestCaptured, setQuestionService, setTreeService } from '../../src/capture/ingest.js';
import { downloadQuestionImages } from '../../src/capture/assets.js';
import type { CapturedQuestion } from '../../src/shared/contracts/capture-types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '../../src/bank/migrations');

/** 有效 PNG 头（300x200；真图校验过魔数，尺寸可读） */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x01, 0x2c, 0x00, 0x00, 0x00, 0xc8,
  0x08, 0x06, 0x00, 0x00, 0x00,
]);

const ANSWER_SRC = 'https://staticzujuan.xkw.com/quesimg/Upload/formula/a3e8b5e08812f92622f79e7b17a5a78d.png';
const ANALYSIS_SRC = 'https://staticzujuan.xkw.com/quesimg/Upload/formula/cbc97c14fdba72ec1f155100a500f44e.png';
/** 存量裂图形态（实站实锤）：WAF 挑战页被落成 `.html` 资产 / 拼错基准留下的 mzujuan 死链 */
const BROKEN_HTML_ASSET = 'data-assets/capture/zujuan/23268476-3.html';
const BROKEN_DEAD_LINK = 'https://mzujuan.xkw.com/Upload/formula/b57f6047e618345b8809478e08fd7935.png';

/** 归一化后的题干契约结构（无图题：题干 + 空选项容器） */
const CONTENT_AFTER_NORMALIZE = '<div class="question"><p>题干</p><div class="options"></div></div>';

/** 真图下载（每条 src 都返回 PNG）；fail 时返回 404（本次仍裂场景） */
function assetResolver(dataRoot: string, ok: boolean) {
  return (q: CapturedQuestion) =>
    downloadQuestionImages(q, {
      dataRoot,
      fetchFn: async () => (ok
        ? { ok: true, status: 200, contentType: 'image/png', bytes: PNG_BYTES }
        : { ok: false, status: 404, contentType: null, bytes: new Uint8Array() }),
    });
}

/** 整卷 zujuan 题的采集产物（答案/解析区各一张公式图） */
function captured(over: Partial<CapturedQuestion> = {}): CapturedQuestion {
  return {
    questionId: '23268476',
    site: 'zujuan',
    sourceUrl: 'https://zujuan.xkw.com/4p2338916.html',
    stemHtml: '<p>题干</p>',
    options: [],
    answerHtml: `<p>【答案】C</p><img src="${ANSWER_SRC}">`,
    analysisHtml: `<p>【详解】</p><img src="${ANALYSIS_SRC}">`,
    images: [
      { src: ANSWER_SRC, role: 'answer' },
      { src: ANALYSIS_SRC, role: 'answer' },
    ],
    meta: { questionType: '单选题', difficulty: '较易', bankid: '4' },
    rect: null,
    ...over,
  };
}

describe('0006-P4-fix-1 P3：裂图字段修复性回填（真 SQLite）', () => {
  let dir: string;
  let db: Database;
  let bankService: BankServiceImpl;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'p4fix1-repair-'));
    db = openDatabase(join(dir, 'bank.db'), migrationsDir);
    bankService = new BankServiceImpl(db);
    setQuestionService({
      listQuestions: () => bankService.listQuestions(),
      createQuestion: ({ data }: any) => bankService.createQuestion(data),
      updateQuestion: (id: string, data: any) => bankService.updateQuestion(id, data),
    });
    setTreeService(null);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** 预置一条存量裂图题（answer/analysis 双裂；content 健康） */
  async function seedBroken(fields: { content?: string; answer?: string; analysis?: string } = {}) {
    const created = await bankService.createQuestion({
      subject: '物理',
      sourceType: 'network',
      sourceDetail: { site: 'zujuan', url: 'https://zujuan.xkw.com/4p2338916.html', questionId: '23268476', collectedAt: '', bankid: '4' },
      content: fields.content ?? CONTENT_AFTER_NORMALIZE,
      answer: fields.answer ?? `<p>【答案】C</p><img src="${BROKEN_HTML_ASSET}">`,
      analysis: fields.analysis ?? `<p>【详解】</p><img src="${BROKEN_DEAD_LINK}">`,
      images: [
        { assetId: BROKEN_HTML_ASSET, type: 'answer-image' },
        { assetId: 'data-assets/capture/zujuan/23268476-4.html', type: 'answer-image' },
      ],
    });
    return created.id;
  }

  it('① 库存裂图字段 + 本次真修好 → 逐字段覆盖 + images 列同步刷新（清 `.html` 引用）', async () => {
    const id = await seedBroken();

    const result = await ingestCaptured([captured()], { subject: '物理', assetResolver: assetResolver(dir, true) });

    expect(result.ok).toBe(0);
    expect(result.dup).toBe(0);
    expect(result.updated).toBe(1);

    const after = (await bankService.listQuestions())[0];
    expect(after.id).toBe(id);
    // answer/analysis 被本次归一化产物覆盖：`.html` 资产与 mzujuan 死链均清除，改为本地真图
    expect(after.answer).toBe(`<p>【答案】C</p><figure class="diagram" data-w="300" data-h="200"><img class="q-figure" src="data-assets/capture/zujuan/23268476-1.png"></figure>`);
    expect(after.analysis).toBe(`<p>【详解】</p><figure class="diagram" data-w="300" data-h="200"><img class="q-figure" src="data-assets/capture/zujuan/23268476-2.png"></figure>`);
    // images 列 = 本次归一化结果（不再引用 `.html` 资产）
    expect(after.images).toEqual([
      { assetId: 'data-assets/capture/zujuan/23268476-1.png', type: 'answer-image' },
      { assetId: 'data-assets/capture/zujuan/23268476-2.png', type: 'answer-image' },
    ]);
  });

  it('② 库存字段健康 → 不覆盖（本次产物不同也不动，保护健康内容/用户编辑）', async () => {
    const healthyAnswer = '<p>【答案】C</p><img src="data-assets/capture/zujuan/23268476-9.png">';
    const healthyAnalysis = '<p>【详解】</p><img src="data-assets/capture/zujuan/23268476-8.png">';
    await seedBroken({ answer: healthyAnswer, analysis: healthyAnalysis });

    const result = await ingestCaptured([captured()], { subject: '物理', assetResolver: assetResolver(dir, true) });

    expect(result.updated ?? 0).toBe(0);
    expect(result.dup).toBe(1);
    const after = (await bankService.listQuestions())[0];
    expect(after.answer).toBe(healthyAnswer);
    expect(after.analysis).toBe(healthyAnalysis);
    expect(after.images).toEqual([
      { assetId: BROKEN_HTML_ASSET, type: 'answer-image' },
      { assetId: 'data-assets/capture/zujuan/23268476-4.html', type: 'answer-image' },
    ]);
  });

  it('③ 本次仍裂（下载失败 → 死链留在归一化产物里）→ 三字段全不动（不拿新的裂图覆盖存量）', async () => {
    const brokenContent = `<div class="question"><p>题干</p><img src="${BROKEN_HTML_ASSET}"><div class="options"></div></div>`;
    await seedBroken({ content: brokenContent });

    const stillBroken = captured({
      stemHtml: `<p>题干</p><img src="${BROKEN_DEAD_LINK}">`,
      answerHtml: `<p>【答案】C</p><img src="${BROKEN_DEAD_LINK}">`,
      analysisHtml: `<p>【详解】</p><img src="${BROKEN_DEAD_LINK}">`,
      images: [{ src: BROKEN_DEAD_LINK, role: 'answer' }],
    });
    const result = await ingestCaptured([stillBroken], { subject: '物理', assetResolver: assetResolver(dir, false) });

    expect(result.updated ?? 0).toBe(0);
    expect(result.dup).toBe(1);
    const after = (await bankService.listQuestions())[0];
    expect(after.content).toBe(brokenContent);
    expect(after.answer).toBe(`<p>【答案】C</p><img src="${BROKEN_HTML_ASSET}">`);
    expect(after.analysis).toBe(`<p>【详解】</p><img src="${BROKEN_DEAD_LINK}">`);
    expect(after.images).toEqual([
      { assetId: BROKEN_HTML_ASSET, type: 'answer-image' },
      { assetId: 'data-assets/capture/zujuan/23268476-4.html', type: 'answer-image' },
    ]);
  });
});
