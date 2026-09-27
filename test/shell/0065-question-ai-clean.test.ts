// 0065（R-068）：组卷网答案解析链·主进程编排（双出 / 原位 / 403 占位图）。
//
// 锁三条产品口径（任务书 §一.1~§一.3）：
//   ① 整图字段（字段=一张图）→ 引擎双出 answer/analysis；引擎判不出归属时整图内容归解析区 + warning；
//   ② 含正文字段 → 逐图原位替换（正文守恒，见 recog 层用例）；
//   ③ 403 占位图 → **不烧 token**（前置指纹判据）、弹层单列分组、不进失败清单；
//      未登记变体走事后文案兜底（多一次调用，但不写错字段）。
//
// 环境：node + 真 fs 临时 dataDir（electron 全 mock，照 0056 同型）。
// 占位图字节用**真库样本**（test/recog/0065-placeholder-bytes.ts）。

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
import { previewQuestionAiClean, type AiCleanQuestionLike } from '../../src/shell/question-ai-clean.js';
import {
  PLACEHOLDER_A_BASE64,
  PLACEHOLDER_C_BASE64,
} from '../recog/0065-placeholder-bytes.js';

let root: string;
let dataDir: string;

function putAsset(rel: string, bytes: Buffer | string): void {
  const path = join(dataDir, 'assets', rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, bytes);
}

const PNG_A = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);
const PNG_B = Buffer.concat([PNG_A, Buffer.from([0x00])]);

/** 真库 403 占位图（414×30 横幅：您没有权限查看组卷网答案解析） */
const PLACEHOLDER = Buffer.from(PLACEHOLDER_A_BASE64, 'base64');
const PLACEHOLDER_C = Buffer.from(PLACEHOLDER_C_BASE64, 'base64');

const F1 = 'capture/zujuan/f1.png';
const ANSPH = 'capture/zujuan/ans-placeholder.png';
const ANSJPG = 'capture/zujuan/ans-page.jpg';

function contentWith(targets: string[]): string {
  return `<div class="question">题${targets.map((t) => `<span class="inline-figure"><img class="q-figure" data-w="84" data-h="20" src="data-assets/${t}"></span>`).join('')}<div class="options"></div></div>`;
}

beforeEach(() => {
  handlers.clear();
  root = mkdtempSync(join(tmpdir(), 'mofang-0065-clean-'));
  dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  putAsset(F1, PNG_A);
  putAsset(ANSPH, PLACEHOLDER);
  putAsset(ANSJPG, PNG_B);
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

/** 假引擎：按输入图字节 base64 出草稿；记录调用序 */
function makeProvider(recipes: Record<string, Partial<OnestepDraft> | 'throw'>) {
  const calls: string[] = [];
  const provider: OnestepProvider = {
    name: 'fake-0065',
    async extract(input: OnestepExtractInput): Promise<OnestepDraft[]> {
      const text = input.image.dataBase64;
      calls.push(text);
      const recipe = recipes[text];
      if (recipe === undefined) throw new Error(`无该图配方（${text.slice(0, 12)}…）`);
      if (recipe === 'throw') throw new Error('模型调用失败（假）');
      return [draft(recipe)];
    },
  };
  return { provider, calls };
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

/** 纯图答案字段（真库 403 占位图的真实形态：figure.diagram 包裹的整张横幅） */
function placeholderAnswerField(rel = ANSJPG): string {
  return `<figure class="diagram" data-w="414" data-h="30"><img class="q-figure" src="data-assets/${rel}"></figure>`;
}

describe('0065 403 占位图：不烧 token、单列分组、不进失败清单', () => {
  it('answer 是占位图 → 零引擎调用 + 题级 skipped(占位图) + placeholders 单列 + 零写库', async () => {
    const bank = makeFakeBank([{
      id: 'ph1',
      content: '<div class="question">纯文字题干<div class="options"></div></div>',
      answer: placeholderAnswerField(ANSPH),
      analysis: '',
      images: [{ assetId: `data-assets/${ANSPH}`, type: 'answer-image' }],
    }]);
    const { provider, calls } = makeProvider({});
    const items = await previewQuestionAiClean(
      { getQuestion: bank.getQuestion, updateQuestion: bank.updateQuestion, dataDir, provider },
      ['ph1'],
    );
    expect(calls).toHaveLength(0);                       // 关键：零 token
    expect(items[0]!.ok).toBe(false);
    expect(items[0]!.skipped).toContain('占位图');
    expect(items[0]!.skipped).toContain('开通权限');      // 提示文案（弹层可见）
    expect(items[0]!.error).toBeNull();                  // 不是失败
    expect(items[0]!.failedImages).toEqual([]);          // 不进失败清单
    expect(items[0]!.placeholders).toHaveLength(1);
    expect(items[0]!.placeholders![0]!.field).toBe('answer');
    expect(items[0]!.placeholders![0]!.reason).toContain('403');
    expect(items[0]!.placeholders![0]!.reason).toContain('414×30');
    expect(items[0]!.after).toBeNull();
    expect(bank.updates).toHaveLength(0);                // preview 零写库
  });

  it('真库第二变体（417×29）同样命中（覆盖多个字节变体）', async () => {
    putAsset('capture/zujuan/ans-ph-c.png', PLACEHOLDER_C);
    const bank = makeFakeBank([{
      id: 'ph2',
      content: '<div class="question">纯文字题干<div class="options"></div></div>',
      answer: placeholderAnswerField('capture/zujuan/ans-ph-c.png'),
      analysis: '',
      images: [],
    }]);
    const { provider, calls } = makeProvider({});
    const items = await previewQuestionAiClean(
      { getQuestion: bank.getQuestion, updateQuestion: bank.updateQuestion, dataDir, provider },
      ['ph2'],
    );
    expect(calls).toHaveLength(0);
    expect(items[0]!.placeholders![0]!.reason).toContain('417×29');
  });

  it('混合：题面公式照转 + 答案区占位图单列（占位字段原样保留，不被清空）', async () => {
    const bank = makeFakeBank([{
      id: 'mix',
      content: contentWith([F1]),
      answer: placeholderAnswerField(ANSPH),
      analysis: '',
      images: [{ assetId: `data-assets/${ANSPH}`, type: 'answer-image' }],
    }]);
    const { provider, calls } = makeProvider({
      [PNG_A.toString('base64')]: { stemMarkdown: '$\\sin 37°=0.6$' },
    });
    const items = await previewQuestionAiClean(
      { getQuestion: bank.getQuestion, updateQuestion: bank.updateQuestion, dataDir, provider },
      ['mix'],
    );
    expect(calls).toHaveLength(1);                       // 只有题面那张真送了引擎
    expect(items[0]!.ok).toBe(true);
    expect(items[0]!.converted).toBe(1);
    expect(items[0]!.placeholders).toHaveLength(1);
    expect(items[0]!.placeholders![0]!.field).toBe('answer');
    expect(items[0]!.failedImages).toEqual([]);
    expect(items[0]!.after!.content).toContain('data-tex="\\sin 37°=0.6"');
    // 占位图所在的答案区**原样保留**（不写、不清空）
    expect(items[0]!.after!.answer).toBe(placeholderAnswerField(ANSPH));
    expect(items[0]!.fieldModes).toEqual({ content: 'inline-figures', answer: 'replace-field' });
  });

  it('未登记变体（事后文案兜底）：转写回「无权限」文案 → 判占位，不写进公式位', async () => {
    const bank = makeFakeBank([{
      id: 'guard',
      content: contentWith([F1]),
      answer: '',
      analysis: '',
      images: [],
    }]);
    const { provider, calls } = makeProvider({
      [PNG_A.toString('base64')]: { stemMarkdown: '（403）您没有权限查看组卷网答案解析，请直接访问站点查看！' },
    });
    const items = await previewQuestionAiClean(
      { getQuestion: bank.getQuestion, updateQuestion: bank.updateQuestion, dataDir, provider },
      ['guard'],
    );
    expect(calls).toHaveLength(1);                       // 事后兜底：已付费一次
    expect(items[0]!.ok).toBe(false);
    expect(items[0]!.skipped).toContain('占位图');
    expect(items[0]!.error).toBeNull();
    expect(items[0]!.failedImages).toEqual([]);
    expect(items[0]!.placeholders![0]!.reason).toContain('权限');
    expect(items[0]!.after).toBeNull();                  // 权限文案绝不写进 data-tex
  });
});

describe('0065 整图双出：归属判别与回退', () => {
  it('引擎正常双出 → answer/analysis 各自成形（replace-field）', async () => {
    const bank = makeFakeBank([{
      id: 'd1',
      content: '<div class="question">纯文字题干<div class="options"></div></div>',
      answer: `<img src="data-assets/${ANSJPG}">`,
      analysis: '',
      images: [],
    }]);
    const { provider } = makeProvider({
      [PNG_B.toString('base64')]: { answerMarkdown: '0.6', analysisMarkdown: '由勾股定理得 $a^2+b^2=c^2$' },
    });
    const items = await previewQuestionAiClean(
      { getQuestion: bank.getQuestion, updateQuestion: bank.updateQuestion, dataDir, provider },
      ['d1'],
    );
    expect(items[0]!.ok).toBe(true);
    expect(items[0]!.after!.answer).toBe('<p>0.6</p>');
    expect(items[0]!.after!.analysis).toContain('勾股定理');
    expect(items[0]!.warnings).toEqual([]);
    expect(items[0]!.fieldModes).toEqual({ answer: 'replace-field' });
  });

  it('引擎判不出归属（内容只落在题面字段）→ 整图内容归解析区、答案区留空 + warning 可见', async () => {
    const bank = makeFakeBank([{
      id: 'd2',
      content: '<div class="question">纯文字题干<div class="options"></div></div>',
      answer: `<img src="data-assets/${ANSJPG}">`,
      analysis: '',
      images: [],
    }]);
    const { provider } = makeProvider({
      [PNG_B.toString('base64')]: { stemMarkdown: '整体转写：由勾股定理得 0.6' },
    });
    const items = await previewQuestionAiClean(
      { getQuestion: bank.getQuestion, updateQuestion: bank.updateQuestion, dataDir, provider },
      ['d2'],
    );
    expect(items[0]!.ok).toBe(true);
    expect(items[0]!.after!.analysis).toContain('整体转写');
    expect(items[0]!.after!.answer).toBe('');            // 答案区留空（不猜成答案）
    expect(items[0]!.warnings.some((w) => w.includes('归属'))).toBe(true);
  });

  it('两侧皆空且题面字段也空 → 仍判失败（不把字段写成空）', async () => {
    const bank = makeFakeBank([{
      id: 'd3',
      content: '<div class="question">纯文字题干<div class="options"></div></div>',
      answer: `<img src="data-assets/${ANSJPG}">`,
      analysis: '',
      images: [],
    }]);
    const { provider } = makeProvider({ [PNG_B.toString('base64')]: {} });
    const items = await previewQuestionAiClean(
      { getQuestion: bank.getQuestion, updateQuestion: bank.updateQuestion, dataDir, provider },
      ['d3'],
    );
    expect(items[0]!.ok).toBe(false);
    expect(items[0]!.error).toContain('两侧皆空');
    expect(items[0]!.after).toBeNull();
  });
});

describe('0065 拼图路径：占位图行不按单图重试', () => {
  const MONTAGE_PNG = Buffer.concat([PNG_B, Buffer.from('montage')]);
  const MONTAGE_B64 = MONTAGE_PNG.toString('base64');

  function seedSized() {
    return async (requests: Array<{ key: string; assetRelPath: string }>) => new Map(requests.map((r) => [r.key, {
      dataBase64: Buffer.from(`TXT:${r.assetRelPath}`).toString('base64'),
      mime: 'image/png',
      width: 100,
      height: 50,
    }]));
  }

  it('拼图回包某行是权限文案 → 该片段判占位（不单图重试、不计失败），其余行照常采用', async () => {
    const bank = makeFakeBank([{
      id: 'm1',
      content: contentWith([F1, F1.replace('f1.png', 'f9.png')]),
      answer: '',
      analysis: '',
      images: [],
    }]);
    putAsset('capture/zujuan/f9.png', Buffer.concat([PNG_A, Buffer.from([1])]));
    const calls: string[] = [];
    const provider = {
      name: 'fake-layered-0065',
      async extract(): Promise<[]> { throw new Error('公式靶不应走 extract'); },
      async transcribe(input: { image: { dataBase64: string } }): Promise<string> {
        calls.push(input.image.dataBase64);
        if (input.image.dataBase64 === MONTAGE_B64) {
          return '1: （403）您没有权限查看组卷网答案解析，请直接访问站点查看！\n2: \\frac{9d}{20}';
        }
        throw new Error('占位图不该按单图重试');
      },
    };
    const render = async () => ({ ok: true as const, png: MONTAGE_PNG });
    const items = await previewQuestionAiClean(
      {
        getQuestion: bank.getQuestion, updateQuestion: bank.updateQuestion, dataDir,
        provider: provider as never, prepareImages: seedSized() as never, renderMontage: render as never,
      },
      ['m1'],
    );
    expect(calls).toEqual([MONTAGE_B64]);                // 只有拼图那一次（占位行没有回退单图）
    expect(items[0]!.ok).toBe(true);
    expect(items[0]!.converted).toBe(1);                 // 只有正常那行被替换
    expect(items[0]!.placeholders).toHaveLength(1);
    expect(items[0]!.placeholders![0]!.reason).toContain('公式拼图第 1 行');
    expect(items[0]!.failedImages).toEqual([]);
    expect(items[0]!.after!.content).toContain('data-tex="\\frac{9d}{20}"');
    expect(items[0]!.after!.content).toContain('inline-figure');   // 占位那张原样留着
  });
});

describe('0065 目检返工①：整图靶腿链（真机：vision 槽 = DeepSeek-OCR + 中文通用提示词 → 空返回）', () => {
  /** 纯图答案字段题（no inline targets） */
  function wholeFieldQuestion(id = 'w1'): AiCleanQuestionLike {
    return {
      id,
      content: '<div class="question">纯文字题干<div class="options"></div></div>',
      answer: `<figure class="diagram" data-w="1768" data-h="968"><img class="q-figure" src="data-assets/${ANSJPG}"></figure>`,
      analysis: '',
      images: [],
    };
  }

  const STRUCT_JSON = JSON.stringify({
    questions: [{
      qno: null,
      questionType: '解答',
      stemMarkdown: '（整图）',
      options: null,
      answerMarkdown: 'A．0.6',
      analysisMarkdown: '由勾股定理得 $v=at$',
      suggestedTags: [],
    }],
  });

  /**
   * 假 invoke（走真 provider 代码：`createTwoStageProvider` 的两段式）——
   * 按**角色**与**是否转写腿**分流，记录每次调用的角色/提示词/是否视觉腿。
   */
  function makeLayeredInvoke(behaviour: {
    transcribe?: (ctx: { role: string; prompt: string }) => string;
    structure?: string;
  }) {
    const calls: Array<{ role: string; vision: boolean; prompt: string }> = [];
    const invoke = async (payload: {
      role: string;
      messages: Array<{ content: unknown }>;
    }) => {
      const vision = Array.isArray(payload.messages[0]?.content);
      const first = payload.messages[0]?.content;
      const prompt = vision
        ? (first as Array<{ type: string; text?: string }>).filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n')
        : String(first ?? '');
      calls.push({ role: payload.role, vision, prompt });
      if (vision) {
        const text = behaviour.transcribe?.({ role: payload.role, prompt }) ?? '';
        return text === '' ? { ok: true, content: '' } : { ok: true, content: text };
      }
      return { ok: true, content: behaviour.structure ?? STRUCT_JSON };
    };
    return { invoke, calls };
  }

  it('主腿（reasoning）空产出 → 自动退下一腿（vision）并产出双出 + 可见回退告警', async () => {
    const bank = makeFakeBank([wholeFieldQuestion()]);
    // reasoning 腿：转写回空；vision 腿：正常转写
    const { invoke, calls } = makeLayeredInvoke({
      transcribe: ({ role }) => (role === 'reasoning' ? '' : '转写：答案页正文 A．0.6'),
    });
    const items = await previewQuestionAiClean(
      { getQuestion: bank.getQuestion, updateQuestion: bank.updateQuestion, dataDir, invoke,
        prepareImages: async (requests) => new Map(requests.map((r) => [r.key, { dataBase64: PNG_B.toString('base64'), mime: 'image/png' }])) },
      ['w1'],
    );
    expect(items[0]!.ok).toBe(true);
    expect(items[0]!.after!.answer).toContain('0.6');                 // 双出成形
    expect(items[0]!.after!.analysis).toContain('勾股定理');
    // 两条腿都试过：reasoning 先（空）→ vision 后（成）
    expect(calls.filter((c) => c.vision).map((c) => c.role)).toEqual(['reasoning', 'vision']);
    // 回退对用户可见（弹层 warn），不静默换模型
    expect(items[0]!.warnings.some((w) => w.includes('回退') && w.includes('vision'))).toBe(true);
  });

  it('vision 腿挂 DSO 备用模板（专用 OCR 只认自家模板，中文通用指令空返回）', async () => {
    const bank = makeFakeBank([wholeFieldQuestion('w2')]);
    // 两条腿的第一次调用都空；vision 腿的**备用模板**调用出内容
    const { invoke, calls } = makeLayeredInvoke({
      transcribe: ({ role, prompt }) => (role === 'vision' && /grounding|Layout|OCR/i.test(prompt) ? '转写：答案页正文' : ''),
    });
    const items = await previewQuestionAiClean(
      { getQuestion: bank.getQuestion, updateQuestion: bank.updateQuestion, dataDir, invoke,
        prepareImages: async (requests) => new Map(requests.map((r) => [r.key, { dataBase64: PNG_B.toString('base64'), mime: 'image/png' }])) },
      ['w2'],
    );
    const visionCalls = calls.filter((c) => c.role === 'vision' && c.vision);
    expect(visionCalls.length).toBeGreaterThanOrEqual(2);             // 通用提示词空 → 备用模板再试一次
    expect(new Set(visionCalls.map((c) => c.prompt)).size).toBeGreaterThanOrEqual(2);
    expect(items[0]!.ok).toBe(true);
    expect(items[0]!.after!.answer).toContain('0.6');
  });

  it('全腿无产出 → 失败原因**报出各腿**（不再只报一句「不具备转写能力域」）', async () => {
    const bank = makeFakeBank([wholeFieldQuestion('w3')]);
    const { invoke } = makeLayeredInvoke({ transcribe: () => '' });
    const items = await previewQuestionAiClean(
      { getQuestion: bank.getQuestion, updateQuestion: bank.updateQuestion, dataDir, invoke,
        prepareImages: async (requests) => new Map(requests.map((r) => [r.key, { dataBase64: PNG_B.toString('base64'), mime: 'image/png' }])) },
      ['w3'],
    );
    expect(items[0]!.ok).toBe(false);
    const reason = items[0]!.error ?? '';
    expect(reason).toContain('全部转写腿未通过');
    expect(reason).toContain('reasoning');
    expect(reason).toContain('vision');
    expect(reason).toContain('（答案区图）');
  });

  it('权限文案落在双出侧（answerMarkdown）→ 判占位图，不写进答案区', async () => {
    const bank = makeFakeBank([wholeFieldQuestion('w4')]);
    const permission = JSON.stringify({
      questions: [{
        qno: null,
        questionType: '解答',
        stemMarkdown: '',
        options: null,
        answerMarkdown: '（403）您没有权限查看组卷网答案解析，请直接访问站点查看！',
        analysisMarkdown: null,
        suggestedTags: [],
      }],
    });
    const { invoke } = makeLayeredInvoke({ transcribe: () => '转写：任意正文', structure: permission });
    const items = await previewQuestionAiClean(
      { getQuestion: bank.getQuestion, updateQuestion: bank.updateQuestion, dataDir, invoke,
        prepareImages: async (requests) => new Map(requests.map((r) => [r.key, { dataBase64: PNG_B.toString('base64'), mime: 'image/png' }])) },
      ['w4'],
    );
    expect(items[0]!.ok).toBe(false);
    expect(items[0]!.error).toBeNull();                                // 不是失败
    expect(items[0]!.failedImages).toEqual([]);
    expect(items[0]!.skipped).toContain('占位图');
    expect(items[0]!.placeholders![0]!.field).toBe('answer');
    expect(items[0]!.after).toBeNull();                                // 权限文案绝不落库
  });
});

describe('0065 与 0056 口径的保持项', () => {
  it('子母题仍跳过（零调用 + 原因可见）', async () => {
    const bank = makeFakeBank([{
      id: 'sub',
      content: contentWith([F1]),
      answer: '',
      analysis: '',
      images: [],
      sourceDetail: { childQuestionCount: 3 },
    }]);
    const { provider, calls } = makeProvider({});
    const items = await previewQuestionAiClean(
      { getQuestion: bank.getQuestion, updateQuestion: bank.updateQuestion, dataDir, provider },
      ['sub'],
    );
    expect(calls).toHaveLength(0);
    expect(items[0]!.skipped).toContain('子母题');
  });
});
