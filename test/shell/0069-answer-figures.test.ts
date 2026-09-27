// 0069（R-075）：答案/解析整图靶抠图·主进程编排（DSO grounding 坐标腿 → 对账 → 裁剪落资产 → 拼回）。
//
// 锁四条产品口径（任务书 §一.1）：
//   ① 整图靶的双出文字里有 [图N] 占位 → 跑一次 DSO grounding 双模板 → 按 bbox 裁出配图落资产；
//   ② 抠图产物写进 images[]（type=figure、宽高回填），原整图条目按既有口径移除；
//   ③ grounding 失败/裁剪失败 → **显式告警** + 行为退化为 0065 现状（文字照旧落库，不静默、不阻塞）；
//   ④ 无 [图N] 占位（纯文字答案图）→ **零 grounding 调用**、产出与 0065 逐字节一致（成本与回归双保）。
//
// 环境：node + 真 fs 临时 dataDir（electron 全 mock，照 0065 同型）；裁剪器注入替身（真 canvas 在
// probe-0069 的 Electron 里跑）。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

import { previewQuestionAiClean, type AiCleanQuestionLike } from '../../src/shell/question-ai-clean.js';
import type { AiCleanCanvasItem, AiCleanCanvasOutcome } from '../../src/shell/ai-clean-canvas-raster.js';
import { DSO_GROUNDING_PROMPTS, ONESTEP_TRANSCRIBE_PROMPT, TWOSTAGE_STRUCTURE_PROMPT } from '../../src/recog/onestep/prompts.js';

let root: string;
let dataDir: string;

/** 1×1 真 PNG（IHDR 可解析；落资产层要按真 PNG 读宽高） */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);
/** 模型入参（原样过桥：prepareImages 替身直通字节） */
const PAGE = Buffer.concat([PNG, Buffer.from([0x00, 0x01])]);

const ANS = 'capture/zujuan/34585790-9.jpg';

function putAsset(rel: string, bytes: Buffer): void {
  const path = join(dataDir, 'assets', rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, bytes);
}

/** 整图答案字段（字段就是一张防采集图；真库 60 例同形态） */
function answerField(rel = ANS): string {
  return `<figure class="diagram" data-w="1768" data-h="968"><img class="q-figure" src="data-assets/${rel}"></figure>`;
}

function questionOf(partial: Partial<AiCleanQuestionLike>): AiCleanQuestionLike {
  return {
    id: 'q1',
    content: '<div class="question">纯文字题干<div class="options"></div></div>',
    answer: answerField(),
    analysis: '',
    images: [{ assetId: `data-assets/${ANS}`, type: 'answer-image' }],
    ...partial,
  };
}

function makeFakeBank(seed: AiCleanQuestionLike[]) {
  const rows = new Map(seed.map((q) => [q.id, { ...q }]));
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  return {
    rows, updates,
    getQuestion: async (id: string) => (rows.has(id) ? { ...rows.get(id)! } : null),
    updateQuestion: async (id: string, patch: Record<string, unknown>) => {
      updates.push({ id, patch });
      rows.set(id, { ...rows.get(id)!, ...patch });
      return rows.get(id);
    },
  };
}

/** DSO grounding 原始区域行（0-999；面积须过 MIN_FIGURE_AREA_999=1200） */
const GROUND_BOX = '<|ref|>image<|/ref|><|det|>[[100,200,400,600]]';

interface InvokeBehaviour {
  /** 转写腿回包（整图转写文本；含 [图N] 才触发配图链） */
  transcribe?: string | 'throw';
  /** 结构化腿回包（JSON 字符串） */
  structure?: string | 'throw';
  /** DSO grounding 双模板回包（按模板索引；'throw' = 该模板失败） */
  grounding?: [string | 'throw', string | 'throw'];
}

/**
 * 假 invoke（走真 provider 代码：`createTwoStageProvider` 两段式）——
 * 按「是否视觉腿 + 提示词」分流：DSO 模板 → grounding；转写提示词 → 转写；纯文本 → 结构化。
 * 记录每次调用（角色 / 提示词 / 形态），供断言调用序与调用次数。
 */
function makeInvoke(behaviour: InvokeBehaviour) {
  const calls: Array<{ role: string; vision: boolean; prompt: string }> = [];
  const invoke = async (payload: { role: string; messages: Array<{ content: unknown }> }) => {
    const first = payload.messages[0]?.content;
    const vision = Array.isArray(first);
    const prompt = vision
      ? (first as Array<{ type: string; text?: string }>).filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n')
      : String(first ?? '');
    calls.push({ role: payload.role, vision, prompt });
    if (vision && DSO_GROUNDING_PROMPTS.includes(prompt as never)) {
      const index = DSO_GROUNDING_PROMPTS.indexOf(prompt as never);
      const recipe = behaviour.grounding?.[index] ?? 'throw';
      if (recipe === 'throw') return { ok: false as const, error: `DSO 模板 ${index + 1} 失败（假）` };
      return { ok: true as const, content: recipe };
    }
    if (vision) {
      if (behaviour.transcribe === 'throw') return { ok: false as const, error: '转写腿失败（假）' };
      return { ok: true as const, content: behaviour.transcribe ?? '' };
    }
    if (behaviour.structure === 'throw') return { ok: false as const, error: '结构化腿失败（假）' };
    return { ok: true as const, content: behaviour.structure ?? '{}' };
  };
  return { invoke, calls };
}

function structureJson(answerMarkdown: string | null, analysisMarkdown: string | null): string {
  return JSON.stringify({
    questions: [{
      qno: null,
      questionType: '解答',
      stemMarkdown: '',
      options: null,
      answerMarkdown,
      analysisMarkdown,
      suggestedTags: [],
    }],
  });
}

/** 转写腿回包 + 结构化腿回包（双出：答案一行、解析带图占位） */
const TRANSCRIBE_WITH_FIGURE = '【详解】如图 [图1] 所示，由几何关系得 θ=37°。\n答案：0.6';
const STRUCT_WITH_FIGURE = structureJson('0.6', '【详解】如图 [图1] 所示，由几何关系得 $\\theta=37°$。');

/** prepareImages 替身：原样过桥（真机大位图路径），只补尺寸 */
const passthroughPrepare = async (requests: Array<{ key: string; bytes: Buffer; mime: string }>) =>
  new Map(requests.map((r) => [r.key, {
    dataBase64: r.bytes.toString('base64'),
    mime: 'image/jpeg',
    width: 1768,
    height: 968,
    note: '替身：原样过桥',
  }]));

/** 裁剪器替身：记录收到的画布项，逐项回固定 PNG 字节 */
function makeCropRenderer(png: Buffer = PNG, mode: 'ok' | 'fail' = 'ok') {
  const seen: AiCleanCanvasItem[][] = [];
  const renderCrop = async (items: AiCleanCanvasItem[]): Promise<AiCleanCanvasOutcome> => {
    seen.push(items);
    const outcome: AiCleanCanvasOutcome = { images: new Map(), failed: [] };
    for (const item of items) {
      if (mode === 'ok') outcome.images.set(item.key, png);
      else outcome.failed.push({ key: item.key, error: '画布产出为空（假）' });
    }
    return outcome;
  };
  return { renderCrop, seen };
}

beforeEach(() => {
  handlers.clear();
  root = mkdtempSync(join(tmpdir(), 'mofang-0069-fig-'));
  dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  putAsset(ANS, PAGE);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('0069 整图靶抠图：grounding 出图 → 裁剪落资产 → 拼回', () => {
  it('双出文字带 [图N] → 裁图落 data/assets/recog/、images 追加 figure 条目、HTML 引真图', async () => {
    const bank = makeFakeBank([questionOf({})]);
    const { invoke, calls } = makeInvoke({
      transcribe: TRANSCRIBE_WITH_FIGURE,
      structure: STRUCT_WITH_FIGURE,
      grounding: [`<|ref|>image<|/ref|><|det|>[[100,200,400,600]]`, ''],
    });
    const { renderCrop, seen } = makeCropRenderer();
    const items = await previewQuestionAiClean(
      {
        getQuestion: bank.getQuestion, updateQuestion: bank.updateQuestion, dataDir, invoke,
        prepareImages: passthroughPrepare as never, renderCrop,
      },
      ['q1'],
    );

    // ① 坐标腿真跑了（双模板并行）：两个模板各一次
    const groundCalls = calls.filter((c) => DSO_GROUNDING_PROMPTS.includes(c.prompt as never));
    expect(groundCalls).toHaveLength(2);
    expect(items[0]!.ok).toBe(true);

    // ② 裁剪请求：源 = 送模型的那份字节（原样过桥），矩形 = bbox 归一 + 外扩
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(1);
    const crop = seen[0]![0]!;
    expect(crop.source.base64).toBe(PAGE.toString('base64'));
    expect(crop.srcRect).toBeDefined();
    expect(crop.srcRect!.x).toBeCloseTo(0.1 - 0.004, 3);
    expect(crop.srcRect!.y).toBeCloseTo(0.2 - 0.004, 3);
    expect(crop.srcRect!.width).toBeCloseTo(0.3 + 0.008, 3);
    expect(crop.srcRect!.height).toBeCloseTo(0.4 + 0.008, 3);

    // ③ 落资产（内容寻址；真 fs）
    const digest = createHash('sha256').update(PNG).digest('hex').slice(0, 32);
    const savedPath = join(dataDir, 'assets', 'recog', `${digest}.png`);
    expect(existsSync(savedPath)).toBe(true);
    expect(readFileSync(savedPath).equals(PNG)).toBe(true);

    // ④ HTML 引真图（块级 figure.diagram + 尺寸）
    expect(items[0]!.after!.analysis).toContain(`src="data-assets/recog/${digest}.png"`);
    expect(items[0]!.after!.analysis).toContain('class="diagram"');
    expect(items[0]!.after!.analysis).toContain('data-w="1" data-h="1"');
    expect(items[0]!.after!.analysis).toContain('data-tex="\\theta=37°"');
    expect(items[0]!.after!.analysis).not.toContain('[图1]');

    // ⑤ images 记账：原整图条目移除 + 抠图产物入列（type=figure）
    expect(items[0]!.after!.images).toEqual([
      { assetId: `data-assets/recog/${digest}.png`, type: 'figure', width: 1, height: 1 },
    ]);

    // ⑥ 来源可见（弹层 warnings）
    expect(items[0]!.warnings.some((w) => w.includes('DeepSeek-OCR') && w.includes('1'))).toBe(true);
    expect(items[0]!.failedImages).toEqual([]);
    expect(bank.updates).toHaveLength(0);              // preview 零写库
  });

  it('grounding 双模板全失败 → 显式告警 + 文字链照常（退化 0065 现状，不阻塞）', async () => {
    const bank = makeFakeBank([questionOf({ id: 'q2' })]);
    const { invoke } = makeInvoke({
      transcribe: TRANSCRIBE_WITH_FIGURE,
      structure: STRUCT_WITH_FIGURE,
      grounding: ['throw', 'throw'],
    });
    const { renderCrop, seen } = makeCropRenderer();
    const items = await previewQuestionAiClean(
      {
        getQuestion: bank.getQuestion, updateQuestion: bank.updateQuestion, dataDir, invoke,
        prepareImages: passthroughPrepare as never, renderCrop,
      },
      ['q2'],
    );

    expect(items[0]!.ok).toBe(true);                    // 文字链不受影响
    expect(items[0]!.after!.analysis).toContain('37°');
    expect(seen).toHaveLength(0);                        // 无坐标 → 不裁图
    expect(items[0]!.after!.images).toEqual([]);         // 原整图条目仍按「已转文字」移除
    const warnings = items[0]!.warnings.join('\n');
    expect(warnings).toContain('grounding');             // 失败原因显式可见
    expect(warnings).toContain('图块坐标来源：无');
    expect(warnings).toContain('[图1]');                 // 未覆盖占位符显式告警
  });

  it('裁剪失败 → 告警 + [图N] 落空 src 占位（文字链完好，不静默吞）', async () => {
    const bank = makeFakeBank([questionOf({ id: 'q3' })]);
    const { invoke } = makeInvoke({
      transcribe: TRANSCRIBE_WITH_FIGURE,
      structure: STRUCT_WITH_FIGURE,
      grounding: [GROUND_BOX, ''],
    });
    const { renderCrop } = makeCropRenderer(PNG, 'fail');
    const items = await previewQuestionAiClean(
      {
        getQuestion: bank.getQuestion, updateQuestion: bank.updateQuestion, dataDir, invoke,
        prepareImages: passthroughPrepare as never, renderCrop,
      },
      ['q3'],
    );

    expect(items[0]!.ok).toBe(true);
    expect(items[0]!.after!.analysis).toContain('src=""');           // 空 src 占位（渲染层显示「待补图」）
    expect(items[0]!.after!.images).toEqual([]);                      // 无产物 → 不入列
    expect(items[0]!.warnings.some((w) => w.includes('抠图失败'))).toBe(true);
    expect(items[0]!.after!.analysis).toContain('37°');             // 正文照旧
  });

  it('[图2] 未配到图块 → 按答案/解析区口径告警（不是录题的「左栏手动框选」）', async () => {
    const bank = makeFakeBank([questionOf({ id: 'q4' })]);
    const { invoke } = makeInvoke({
      transcribe: '如图 [图1] 与 [图2]。',
      structure: structureJson(null, '如图 [图1] 与 [图2] 所示。'),
      grounding: [GROUND_BOX, ''],
    });
    const { renderCrop } = makeCropRenderer();
    const items = await previewQuestionAiClean(
      {
        getQuestion: bank.getQuestion, updateQuestion: bank.updateQuestion, dataDir, invoke,
        prepareImages: passthroughPrepare as never, renderCrop,
      },
      ['q4'],
    );
    const warnings = items[0]!.warnings.join('\n');
    expect(warnings).toContain('答案/解析区 [图2] 未配到图块');
    expect(warnings).not.toContain('左栏');
    expect(items[0]!.after!.analysis).toContain('src=""');            // 图2 落空占位
    expect(items[0]!.after!.images).toHaveLength(1);                   // 图1 照常入列
  });

  it('抠图产物已在 images 列（幂等重跑）→ 不重复追加', async () => {
    const digest = createHash('sha256').update(PNG).digest('hex').slice(0, 32);
    const bank = makeFakeBank([questionOf({
      id: 'q5',
      images: [
        { assetId: `data-assets/${ANS}`, type: 'answer-image' },
        { assetId: `data-assets/recog/${digest}.png`, type: 'figure', width: 1, height: 1 },
      ],
    })]);
    const { invoke } = makeInvoke({
      transcribe: TRANSCRIBE_WITH_FIGURE,
      structure: STRUCT_WITH_FIGURE,
      grounding: [GROUND_BOX, ''],
    });
    const { renderCrop } = makeCropRenderer();
    const items = await previewQuestionAiClean(
      {
        getQuestion: bank.getQuestion, updateQuestion: bank.updateQuestion, dataDir, invoke,
        prepareImages: passthroughPrepare as never, renderCrop,
      },
      ['q5'],
    );
    expect(items[0]!.after!.images).toEqual([
      { assetId: `data-assets/recog/${digest}.png`, type: 'figure', width: 1, height: 1 },
    ]);
  });
});

describe('0069 目检返工②：文字提到配图但模型没标 [图N] → 显式告警（不静默漏图）', () => {
  it('文字含「如图」+ 坐标腿出框但无占位 → 告警指明「模型未标 [图N]」，不裁图、不记账', async () => {
    const bank = makeFakeBank([questionOf({ id: 'f1' })]);
    const { invoke } = makeInvoke({
      transcribe: '【详解】如图所示，由几何关系得 θ=37°。',
      structure: structureJson('0.6', '【详解】如图所示，由几何关系得 $	heta=37°$。'),
      grounding: [GROUND_BOX, ''],
    });
    const { renderCrop, seen } = makeCropRenderer();
    const items = await previewQuestionAiClean(
      {
        getQuestion: bank.getQuestion, updateQuestion: bank.updateQuestion, dataDir, invoke,
        prepareImages: passthroughPrepare as never, renderCrop,
      },
      ['f1'],
    );
    expect(items[0]!.ok).toBe(true);
    expect(seen).toHaveLength(0);                                   // 没有占位符 → 不裁图（无落点）
    expect(items[0]!.after!.images).toEqual([]);
    expect(items[0]!.after!.analysis).toContain('几何关系');        // 正文照旧
    expect(items[0]!.warnings.some((w) => w.includes('未在答案/解析中留下') && w.includes('[图N]'))).toBe(true);
    expect(items[0]!.warnings.join('')).toContain('1 个图块');
  });

  it('文字含「如图」但本图确无图块 → 零告警（不误报）', async () => {
    const bank = makeFakeBank([questionOf({ id: 'f2' })]);
    const { invoke, calls } = makeInvoke({
      transcribe: '【详解】如图，由勾股定理得 0.6。',
      structure: structureJson('0.6', '【详解】如图，由勾股定理得 0.6。'),
      grounding: ['', ''],                                          // 双模板都回「无区域行」
    });
    const { renderCrop, seen } = makeCropRenderer();
    const items = await previewQuestionAiClean(
      {
        getQuestion: bank.getQuestion, updateQuestion: bank.updateQuestion, dataDir, invoke,
        prepareImages: passthroughPrepare as never, renderCrop,
      },
      ['f2'],
    );
    expect(calls.filter((c) => DSO_GROUNDING_PROMPTS.includes(c.prompt as never))).toHaveLength(2);
    expect(seen).toHaveLength(0);
    expect(items[0]!.warnings).toEqual([]);
  });

  it('文字含「如图」且坐标腿失败 → 告警说明无法确认（可重试）', async () => {
    const bank = makeFakeBank([questionOf({ id: 'f3' })]);
    const { invoke } = makeInvoke({
      transcribe: '【详解】如图，由勾股定理得 0.6。',
      structure: structureJson('0.6', '【详解】如图，由勾股定理得 0.6。'),
      grounding: ['throw', 'throw'],
    });
    const { renderCrop } = makeCropRenderer();
    const items = await previewQuestionAiClean(
      {
        getQuestion: bank.getQuestion, updateQuestion: bank.updateQuestion, dataDir, invoke,
        prepareImages: passthroughPrepare as never, renderCrop,
      },
      ['f3'],
    );
    expect(items[0]!.ok).toBe(true);
    expect(items[0]!.warnings.some((w) => w.includes('坐标腿') && w.includes('未出结果'))).toBe(true);
  });

  it('文字既无 [图N] 也无「如图」→ 零坐标腿调用（0065 成本口径不变）', async () => {
    const bank = makeFakeBank([questionOf({ id: 'f4' })]);
    const { invoke, calls } = makeInvoke({
      transcribe: '由勾股定理得 0.6。',
      structure: structureJson('0.6', '由勾股定理得 0.6。'),
      grounding: [GROUND_BOX, GROUND_BOX],
    });
    const { renderCrop } = makeCropRenderer();
    const items = await previewQuestionAiClean(
      {
        getQuestion: bank.getQuestion, updateQuestion: bank.updateQuestion, dataDir, invoke,
        prepareImages: passthroughPrepare as never, renderCrop,
      },
      ['f4'],
    );
    expect(calls.filter((c) => DSO_GROUNDING_PROMPTS.includes(c.prompt as never))).toHaveLength(0);
    expect(items[0]!.warnings).toEqual([]);
  });
});

describe('0069 零抠图退化：无 [图N] 的整图靶与 0065 逐字节一致', () => {
  it('纯文字答案图 → 零 grounding 调用、零裁剪、零新增告警、产出与 0065 同形', async () => {
    const bank = makeFakeBank([questionOf({ id: 't1' })]);
    const { invoke, calls } = makeInvoke({
      transcribe: '【详解】由勾股定理得 θ=37°。答案：0.6',
      structure: structureJson('0.6', '【详解】由勾股定理得 $\\theta=37°$。'),
      grounding: [GROUND_BOX, GROUND_BOX],   // 出图也不该被调用
    });
    const { renderCrop, seen } = makeCropRenderer();
    const items = await previewQuestionAiClean(
      {
        getQuestion: bank.getQuestion, updateQuestion: bank.updateQuestion, dataDir, invoke,
        prepareImages: passthroughPrepare as never, renderCrop,
      },
      ['t1'],
    );

    expect(calls.filter((c) => DSO_GROUNDING_PROMPTS.includes(c.prompt as never))).toHaveLength(0);
    expect(seen).toHaveLength(0);
    expect(items[0]!.warnings).toEqual([]);
    expect(items[0]!.after!.answer).toBe('<p>0.6</p>');
    expect(items[0]!.after!.analysis).toBe('<p>【详解】由勾股定理得 <span class="math" data-tex="\\theta=37°"></span>。</p>');
    expect(items[0]!.after!.images).toEqual([]);
    expect(items[0]!.converted).toBe(1);
    expect(items[0]!.fieldModes).toEqual({ answer: 'replace-field' });
  });

  it('未注入 invoke（provider 注入口径）但有 [图N] → 显式告警，不崩、不静默', async () => {
    const bank = makeFakeBank([questionOf({ id: 't2' })]);
    const provider = {
      name: 'fake-injected',
      async extract() {
        return [{
          qno: null, questionType: '解答', stemMarkdown: '', options: null,
          answerMarkdown: '0.6', analysisMarkdown: '如图 [图1]。',
          suggestedTags: [], figures: [], figureSource: 'none' as const, warnings: [],
        }];
      },
    };
    const items = await previewQuestionAiClean(
      { getQuestion: bank.getQuestion, updateQuestion: bank.updateQuestion, dataDir, provider: provider as never },
      ['t2'],
    );
    expect(items[0]!.ok).toBe(true);
    expect(items[0]!.after!.analysis).toContain('src=""');            // 留空占位
    expect(items[0]!.warnings.some((w) => w.includes('坐标腿'))).toBe(true);
  });
});

describe('0069 提示词：答案/解析链的占位要求只落在答案链（录题侧提示词不动）', () => {
  it('答案链结构提示词带 [图N] 占位要求，且与录题侧基础提示词不同', async () => {
    const { AI_CLEAN_ANSWER_STRUCTURE_PROMPT, AI_CLEAN_ANSWER_TRANSCRIBE_PROMPT } = await import('../../src/recog/onestep/prompts.js');
    expect(AI_CLEAN_ANSWER_STRUCTURE_PROMPT).not.toBe(TWOSTAGE_STRUCTURE_PROMPT);
    expect(AI_CLEAN_ANSWER_STRUCTURE_PROMPT).toContain('[图N]');
    expect(AI_CLEAN_ANSWER_STRUCTURE_PROMPT).toContain('答案/解析');
    expect(AI_CLEAN_ANSWER_TRANSCRIBE_PROMPT.startsWith(ONESTEP_TRANSCRIBE_PROMPT)).toBe(true);
    expect(AI_CLEAN_ANSWER_TRANSCRIBE_PROMPT).toContain('[图N]');
    // 录题侧常量逐字不变（只增不改）
    expect(TWOSTAGE_STRUCTURE_PROMPT).toContain('answerMarkdown / analysisMarkdown：只整理文字中实际存在的答案/解析');
  });
});
