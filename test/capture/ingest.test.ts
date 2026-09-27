import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ingestCaptured, setQuestionService } from '../../src/capture/ingest.js';
import type { CapturedQuestion } from '../../src/shared/contracts/capture-types.js';
import type { DictEntry, Question } from '../../src/shared/contracts/bank-types.js';

// Mock bankService
const mockBankService = {
  listQuestions: vi.fn(),
  createQuestion: vi.fn(),
  updateQuestion: vi.fn(),
};

// P3：学科字典样本（归一行 + 站点行；politics 为「站点行优先破歧义」样本）
const SUBJECT_DICT: DictEntry[] = [
  { id: 'subj:math', kind: 'subject', code: 'math', label: '数学', active: true },
  { id: 'subj:physics', kind: 'subject', code: 'physics', label: '物理', active: true },
  { id: 'subj:politics', kind: 'subject', code: 'politics', label: '政治', active: true },
  { id: 'subj:morality-law', kind: 'subject', code: 'morality-law', label: '道德与法治', active: true },
  { id: 'subj:jyeoo:physics2', kind: 'subject', code: 'physics', label: 'physics2', site: 'jyeoo', sourceLabel: 'physics2', active: true },
  { id: 'subj:jyeoo:politics', kind: 'subject', code: 'morality-law', label: 'politics', site: 'jyeoo', sourceLabel: 'politics', active: true },
];

describe('ingestCaptured', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBankService.listQuestions.mockResolvedValue([]);
    setQuestionService(mockBankService);
  });

  it('应将 CapturedQuestion 映射为 createQuestion 入参字段', async () => {
    const captured: CapturedQuestion[] = [
      {
        questionId: 'q123',
        site: 'zujuan',
        sourceUrl: 'https://zujuan.xkw.com/basket',
        stemHtml: '<div>题干</div>',
        options: ['<td>A. 选项1</td>'],
        answerHtml: '<div>A</div>',
        analysisHtml: '<div>解析</div>',
        images: [],
        meta: {
          questionType: '单选题',
          difficulty: '中等',
          knowledgePoints: ['力学', '运动学'],
          source: '2023 武汉中考',
        },
        rect: null,
      },
    ];

    mockBankService.createQuestion.mockResolvedValue({ id: 'q123', createdAt: new Date().toISOString() });

    const result = await ingestCaptured(captured, { subject: 'physics' });

    expect(result.ok).toBe(1);
    expect(result.dup).toBe(0);
    expect(result.failed).toHaveLength(0);

    expect(mockBankService.createQuestion).toHaveBeenCalledTimes(1);
    const callArg = mockBankService.createQuestion.mock.calls[0][0];

    // sourceType = 'network'
    expect(callArg.data.sourceType).toBe('network');

    // sourceDetail 包含 site/url/questionId/collectedAt
    expect(callArg.data.sourceDetail).toMatchObject({
      site: 'zujuan',
      url: 'https://zujuan.xkw.com/basket',
      questionId: 'q123',
    });
    expect(callArg.data.sourceDetail.collectedAt).toBeDefined();

    // subject
    expect(callArg.data.subject).toBe('physics');

    // knowledgePoints 映射
    expect(callArg.data.knowledgePoints).toEqual(['力学', '运动学']);

    // content 结构
    expect(callArg.data.content).toBeDefined();
  });

  it('应去重：预置 listQuestions 含同 site+questionId 则跳过', async () => {
    const captured: CapturedQuestion[] = [
      {
        questionId: 'q123',
        site: 'zujuan',
        sourceUrl: 'https://zujuan.xkw.com/basket',
        stemHtml: '<div>题干</div>',
        options: [],
        answerHtml: '',
        analysisHtml: '',
        images: [],
        meta: {},
        rect: null,
      },
    ];

    const existingQuestions: Partial<Question>[] = [
      {
        id: 'existing-1',
        sourceType: 'network',
        sourceDetail: { site: 'zujuan', questionId: 'q123', url: '', collectedAt: '' },
      },
    ];

    mockBankService.listQuestions.mockResolvedValue(existingQuestions);

    const result = await ingestCaptured(captured, { subject: 'physics' });

    expect(mockBankService.createQuestion).not.toHaveBeenCalled();
    expect(result.ok).toBe(0);
    expect(result.dup).toBe(1);
  });

  // D1-fix-4 复验 R-U：重采更新——此前采集缺答案/解析的题，重采抓到后回填已有条目，
  // 不再整条跳过（题库只增不减、旧脏数据永远得不到修复的问题）
  describe('重采回填（dup 命中时补缺字段）', () => {
    const recap = (answerHtml: string, analysisHtml: string, knowledgePoints: string[] = []): CapturedQuestion => ({
      questionId: 'q123',
      site: 'jyeoo',
      sourceUrl: 'https://www.jyeoo.com/basket',
      stemHtml: '<div>题干</div>',
      options: [],
      answerHtml,
      analysisHtml,
      images: [],
      meta: { knowledgePoints },
      rect: null,
    });

    const existingWith = (fields: Partial<Question>): Partial<Question>[] => [
      {
        id: 'existing-1',
        sourceType: 'network',
        sourceDetail: { site: 'jyeoo', questionId: 'q123', url: '', collectedAt: '' },
        ...fields,
      },
    ];

    it('已有题缺答案/解析 + 重采抓到 → updateQuestion 回填，updated=1，不新建不算 dup', async () => {
      mockBankService.listQuestions.mockResolvedValue(existingWith({ answer: undefined, analysis: undefined }));
      mockBankService.updateQuestion.mockResolvedValue({});

      const result = await ingestCaptured([recap('<p>B</p>', '<p>解析：由欧姆定律入手</p>', ['欧姆定律'])], {});

      expect(mockBankService.createQuestion).not.toHaveBeenCalled();
      expect(mockBankService.updateQuestion).toHaveBeenCalledTimes(1);
      const [id, patch] = mockBankService.updateQuestion.mock.calls[0];
      expect(id).toBe('existing-1');
      expect(patch.answer).toContain('B');
      expect(patch.analysis).toContain('由欧姆定律入手');
      expect(patch.knowledgePoints).toEqual(['欧姆定律']);
      expect(result.updated).toBe(1);
      expect(result.dup).toBe(0);
      expect(result.ok).toBe(0);
    });

    it('已有字段一律不覆盖：有答案无解析 → 只回填 analysis', async () => {
      mockBankService.listQuestions.mockResolvedValue(existingWith({ answer: '<p>用户改过的答案</p>', analysis: undefined }));
      mockBankService.updateQuestion.mockResolvedValue({});

      const result = await ingestCaptured([recap('<p>B</p>', '<p>新解析</p>')], {});

      const [, patch] = mockBankService.updateQuestion.mock.calls[0];
      expect(patch.answer).toBeUndefined();
      expect(patch.analysis).toContain('新解析');
      expect(result.updated).toBe(1);
    });

    it('已有题字段齐全 → 不 update，dup=1', async () => {
      mockBankService.listQuestions.mockResolvedValue(
        existingWith({ answer: '<p>A</p>', analysis: '<p>旧解析</p>', knowledgePoints: ['力学'] }),
      );

      const result = await ingestCaptured([recap('<p>B</p>', '<p>新解析</p>', ['欧姆定律'])], {});

      expect(mockBankService.updateQuestion).not.toHaveBeenCalled();
      expect(result.updated ?? 0).toBe(0);
      expect(result.dup).toBe(1);
    });

    it('重采仍无答案/解析（如 gated）→ 不 update，dup=1', async () => {
      mockBankService.listQuestions.mockResolvedValue(existingWith({ answer: undefined, analysis: undefined }));

      const result = await ingestCaptured([recap('', '')], {});

      expect(mockBankService.updateQuestion).not.toHaveBeenCalled();
      expect(result.dup).toBe(1);
    });

    it('回填失败 → 计入 failed 不中断', async () => {
      mockBankService.listQuestions.mockResolvedValue(existingWith({ answer: undefined }));
      mockBankService.updateQuestion.mockRejectedValue(new Error('DB locked'));

      const result = await ingestCaptured([recap('<p>B</p>', '')], {});

      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].questionId).toBe('q123');
      expect(result.failed[0].error).toContain('DB locked');
    });
  });

  it('应去重：不同站点的相同 questionId 不算重复', async () => {
    const captured: CapturedQuestion[] = [
      {
        questionId: 'q123',
        site: 'jyeoo',
        sourceUrl: 'https://www.jyeoo.com/basket',
        stemHtml: '<div>题干</div>',
        options: [],
        answerHtml: '',
        analysisHtml: '',
        images: [],
        meta: {},
        rect: null,
      },
    ];

    const existingQuestions: Partial<Question>[] = [
      {
        id: 'existing-1',
        sourceType: 'network',
        sourceDetail: { site: 'zujuan', questionId: 'q123', url: '', collectedAt: '' },
      },
    ];

    mockBankService.listQuestions.mockResolvedValue(existingQuestions);
    mockBankService.createQuestion.mockResolvedValue({ id: 'new-1', createdAt: new Date().toISOString() });

    const result = await ingestCaptured(captured, { subject: 'physics' });

    expect(mockBankService.createQuestion).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(1);
    expect(result.dup).toBe(0);
  });

  it('应批量失败收集不中断', async () => {
    const captured: CapturedQuestion[] = [
      {
        questionId: 'q1',
        site: 'zujuan',
        sourceUrl: 'https://zujuan.xkw.com/basket',
        stemHtml: '<div>题干1</div>',
        options: [],
        answerHtml: '',
        analysisHtml: '',
        images: [],
        meta: {},
        rect: null,
      },
      {
        questionId: 'q2',
        site: 'zujuan',
        sourceUrl: 'https://zujuan.xkw.com/basket',
        stemHtml: '<div>题干2</div>',
        options: [],
        answerHtml: '',
        analysisHtml: '',
        images: [],
        meta: {},
        rect: null,
      },
    ];

    mockBankService.createQuestion
      .mockResolvedValueOnce({ id: 'q1', createdAt: new Date().toISOString() })
      .mockRejectedValueOnce(new Error('入库失败'));

    const result = await ingestCaptured(captured, { subject: 'physics' });

    expect(result.ok).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].questionId).toBe('q2');
    expect(result.failed[0].error).toContain('入库失败');
  });

  it('应映射 meta.questionType/difficulty 文本为数值', async () => {
    const captured: CapturedQuestion[] = [
      {
        questionId: 'q123',
        site: 'zujuan',
        sourceUrl: 'https://zujuan.xkw.com/basket',
        stemHtml: '<div>题干</div>',
        options: [],
        answerHtml: '',
        analysisHtml: '',
        images: [],
        meta: {
          questionType: '单选题',
          difficulty: '困难',
        },
        rect: null,
      },
    ];

    mockBankService.createQuestion.mockResolvedValue({ id: 'q123', createdAt: new Date().toISOString() });

    await ingestCaptured(captured, { subject: 'physics' });

    const callArg = mockBankService.createQuestion.mock.calls[0][0];

    // difficulty 映射为数值（困难 -> 0.8-1.0 范围）
    expect(typeof callArg.data.difficulty).toBe('number');
    expect(callArg.data.difficulty).toBeGreaterThan(0);
    expect(callArg.data.difficulty).toBeLessThanOrEqual(1);
  });

  it('应处理无法映射的 meta 值留 undefined', async () => {
    const captured: CapturedQuestion[] = [
      {
        questionId: 'q123',
        site: 'zujuan',
        sourceUrl: 'https://zujuan.xkw.com/basket',
        stemHtml: '<div>题干</div>',
        options: [],
        answerHtml: '',
        analysisHtml: '',
        images: [],
        meta: {
          questionType: '未知类型',
          difficulty: '未知难度',
        },
        rect: null,
      },
    ];

    mockBankService.createQuestion.mockResolvedValue({ id: 'q123', createdAt: new Date().toISOString() });

    await ingestCaptured(captured, { subject: 'physics' });

    const callArg = mockBankService.createQuestion.mock.calls[0][0];

    expect(callArg.data.difficulty).toBeUndefined();
  });
});


describe('ingestCaptured — R-2/R-4 联动', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBankService.listQuestions.mockResolvedValue([]);
    setQuestionService(mockBankService);
  });

  function baseCaptured(overrides: Partial<CapturedQuestion>): CapturedQuestion {
    return {
      questionId: 'q1',
      site: 'zujuan',
      sourceUrl: 'https://zujuan.xkw.com/basket',
      stemHtml: '<div>题干</div>',
      options: [],
      answerHtml: '',
      analysisHtml: '',
      images: [],
      meta: {},
      rect: null,
      ...overrides,
    };
  }

  it('temp-* / 空 questionId 拒绝入库（jyeoo 真实 tid 未解析不得产生脏数据）', async () => {
    const captured: CapturedQuestion[] = [
      baseCaptured({ questionId: '', site: 'jyeoo', meta: { answerVia: '' } }),
      baseCaptured({ questionId: 'temp-0', site: 'jyeoo' }),
      baseCaptured({ questionId: 'realtid-1', site: 'jyeoo' }),
    ];
    mockBankService.createQuestion.mockResolvedValue({ id: 'new-1', createdAt: new Date().toISOString() });

    const result = await ingestCaptured(captured, { subject: 'math' });

    expect(mockBankService.createQuestion).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(1);
    expect(result.failed).toHaveLength(2);
    expect(result.failed.map((f) => f.questionId)).toEqual(['(empty)', 'temp-0']);
    expect(result.failed[0].error).toContain('questionId');
  });

  it('assetResolver 下载结果填充 Question.images（0002 结构化：assetId+语义类型）', async () => {
    const captured: CapturedQuestion[] = [baseCaptured({ questionId: 'q-img' })];
    mockBankService.createQuestion.mockResolvedValue({ id: 'new-1', createdAt: new Date().toISOString() });

    const assetResolver = async () => ({
      images: [
        { localPath: 'data-assets/capture/zujuan/q-img-1.png', origSrc: 'https://img.xkw.com/a.png', role: 'content' as const },
        { localPath: 'data-assets/capture/zujuan/q-img-2.png', origSrc: 'https://imzujuan.xkw.com/b.png', role: 'answer' as const },
      ],
      warnings: [],
    });

    const result = await ingestCaptured(captured, { subject: 'physics', assetResolver });

    expect(result.ok).toBe(1);
    const callArg = mockBankService.createQuestion.mock.calls[0][0];
    // 0002 契约：images 元素结构化，采集侧按区域分域判定（题干→figure，答案→answer-image）
    expect(callArg.data.images).toEqual([
      { assetId: 'data-assets/capture/zujuan/q-img-1.png', type: 'figure' },
      { assetId: 'data-assets/capture/zujuan/q-img-2.png', type: 'answer-image' },
    ]);
  });

  it('用户选择 subject 覆盖 jyeoo meta.subject（L-1：用户选择优先）', async () => {
    const captured: CapturedQuestion[] = [
      baseCaptured({ questionId: 'tid-1', site: 'jyeoo', meta: { subject: 'math' } }),
    ];
    mockBankService.createQuestion.mockResolvedValue({ id: 'new-1', createdAt: new Date().toISOString() });

    await ingestCaptured(captured, { subject: '数学' });

    const callArg = mockBankService.createQuestion.mock.calls[0][0];
    expect(callArg.data.subject).toBe('数学');
  });

  it('无用户选择时 jyeoo meta.subject 经站点行解析入库（physics2→物理 + subjectId）', async () => {
    const captured: CapturedQuestion[] = [
      baseCaptured({ questionId: 'tid-1', site: 'jyeoo', meta: { subject: 'physics2' } }),
    ];
    mockBankService.createQuestion.mockResolvedValue({ id: 'new-1', createdAt: new Date().toISOString() });

    await ingestCaptured(captured, { dictEntries: SUBJECT_DICT });

    const callArg = mockBankService.createQuestion.mock.calls[0][0];
    expect(callArg.data.subject).toBe('物理');
    expect(callArg.data.subjectId).toBe('subj:physics');
  });

  it('无用户选择且无 meta.subject 时回落 unknown（L-1 探针：不带 subject 回落默认）', async () => {
    const captured: CapturedQuestion[] = [baseCaptured({ questionId: 'q-no-subj' })];
    mockBankService.createQuestion.mockResolvedValue({ id: 'new-1', createdAt: new Date().toISOString() });

    await ingestCaptured(captured, {});

    const callArg = mockBankService.createQuestion.mock.calls[0][0];
    expect(callArg.data.subject).toBe('unknown');
  });

  it('options.stage 透传入库（学段+学科拆分后学段落 stage 字段）', async () => {
    const captured: CapturedQuestion[] = [baseCaptured({ questionId: 'q-stage' })];
    mockBankService.createQuestion.mockResolvedValue({ id: 'new-1', createdAt: new Date().toISOString() });

    await ingestCaptured(captured, { subject: '数学', stage: '高中' });

    const callArg = mockBankService.createQuestion.mock.calls[0][0];
    expect(callArg.data.subject).toBe('数学');
    expect(callArg.data.stage).toBe('高中');
  });
});


// 0004-fix-1c B组：重采回填 content 整体刷新——重采即修复存量旧题（题首孤图后移等新归一化语义）
describe('ingestCaptured — 重采回填 content 刷新（0004-fix-1c B组）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBankService.listQuestions.mockResolvedValue([]);
    setQuestionService(mockBankService);
  });

  const FIXED_CONTENT = '<div class="question">如图所示，闭合开关后两灯均发光。'
    + '<figure class="diagram" data-w="873" data-h="491"><img class="q-figure" src="data-assets/capture/jyeoo/q123-1.png"></figure>'
    + '<div class="options"></div></div>';
  const LEGACY_CONTENT = '<div class="question">'
    + '<figure class="diagram" data-w="0" data-h="0"><img class="q-figure" src="data-assets/capture/jyeoo/q123-1.png"></figure>'
    + '如图所示，闭合开关后两灯均发光。<div class="options"></div></div>';

  const recap = (): CapturedQuestion => ({
    questionId: 'q123',
    site: 'jyeoo',
    sourceUrl: 'https://www.jyeoo.com/basket',
    stemHtml: '<img src="data-assets/capture/jyeoo/q123-1.png">如图所示，闭合开关后两灯均发光。',
    options: [],
    answerHtml: '',
    analysisHtml: '',
    images: [],
    meta: {},
    rect: null,
  });

  const resolver = async () => ({
    images: [
      { localPath: 'data-assets/capture/jyeoo/q123-1.png', origSrc: 'https://img.jyeoo.com/1.png', role: 'content' as const, width: 873, height: 491 },
    ],
    warnings: [],
  });

  const existingWith = (fields: Partial<Question>): Partial<Question>[] => [
    {
      id: 'existing-1',
      sourceType: 'network',
      sourceDetail: { site: 'jyeoo', questionId: 'q123', url: '', collectedAt: '' },
      ...fields,
    },
  ];

  it('存量旧序 content（图冲题首）+ 重采 → content 以新归一化结果刷新：文本回句首、图居尾、src 本地', async () => {
    mockBankService.listQuestions.mockResolvedValue(
      existingWith({ content: LEGACY_CONTENT, answer: '<p>A</p>', analysis: '<p>解析</p>' }),
    );
    mockBankService.updateQuestion.mockResolvedValue({});

    const result = await ingestCaptured([recap()], { assetResolver: resolver });

    expect(mockBankService.createQuestion).not.toHaveBeenCalled();
    expect(mockBankService.updateQuestion).toHaveBeenCalledTimes(1);
    const [id, patch] = mockBankService.updateQuestion.mock.calls[0];
    expect(id).toBe('existing-1');
    expect(patch.content).toBe(FIXED_CONTENT);
    expect(result.updated).toBe(1);
    expect(result.dup).toBe(0);
    // 补缺字段齐全时不误回填
    expect(patch.answer).toBeUndefined();
    expect(patch.analysis).toBeUndefined();
  });

  it('content 已是新管线产物（与库内一致）→ 不写不虚增 updated，dup=1', async () => {
    mockBankService.listQuestions.mockResolvedValue(
      existingWith({ content: FIXED_CONTENT, answer: '<p>A</p>', analysis: '<p>解析</p>' }),
    );

    const result = await ingestCaptured([recap()], { assetResolver: resolver });

    expect(mockBankService.updateQuestion).not.toHaveBeenCalled();
    expect(result.updated ?? 0).toBe(0);
    expect(result.dup).toBe(1);
  });

  it('无资产管线（resolver 缺省）→ 不刷新 content（远程 src 归一化产物会劣化库内引用），纯 dup 保持 dup', async () => {
    mockBankService.listQuestions.mockResolvedValue(
      existingWith({ content: LEGACY_CONTENT, answer: '<p>A</p>', analysis: '<p>解析</p>' }),
    );

    const result = await ingestCaptured([recap()], {});

    expect(mockBankService.updateQuestion).not.toHaveBeenCalled();
    expect(result.dup).toBe(1);
  });

  it('无资产管线 + 缺答案 → 只回填答案，patch 不含 content（保护库内本地引用不退化为远程 src）', async () => {
    mockBankService.listQuestions.mockResolvedValue(
      existingWith({ content: LEGACY_CONTENT, answer: undefined }),
    );
    mockBankService.updateQuestion.mockResolvedValue({});

    const recapWithAnswer = { ...recap(), answerHtml: '<p>B</p>' };
    const result = await ingestCaptured([recapWithAnswer], {});

    expect(result.updated).toBe(1);
    const [, patch] = mockBankService.updateQuestion.mock.calls[0];
    expect(patch.answer).toContain('B');
    expect(patch.content).toBeUndefined();
  });
});


// ==================== P3（0006-fix-3）：学科字典化 ====================

describe('ingestCaptured — P3 学科字典化（subjectId 落库 + 站点行解析）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBankService.listQuestions.mockResolvedValue([]);
    setQuestionService(mockBankService);
  });

  const cap = (meta: CapturedQuestion['meta'], site: 'zujuan' | 'jyeoo' = 'jyeoo'): CapturedQuestion => ({
    questionId: 'tid-p3',
    site,
    sourceUrl: 'https://www.jyeoo.com/basket',
    stemHtml: '<div>题干</div>',
    options: [],
    answerHtml: '',
    analysisHtml: '',
    images: [],
    meta,
    rect: null,
  });

  const createdData = () => mockBankService.createQuestion.mock.calls[0][0].data;

  it('用户选择命中（host 已解析）：subject 落用户选择、subjectId 落归一 id', async () => {
    mockBankService.createQuestion.mockResolvedValue({ id: 'n1', createdAt: '' });
    await ingestCaptured([cap({ subject: 'physics2' })], {
      subject: '数学',
      subjectId: 'subj:math',
      dictEntries: SUBJECT_DICT,
    });
    expect(createdData().subject).toBe('数学');
    expect(createdData().subjectId).toBe('subj:math');
  });

  it('用户选择未命中：subject 落用户选择、subjectId 不传（不新建不猜）', async () => {
    mockBankService.createQuestion.mockResolvedValue({ id: 'n1', createdAt: '' });
    await ingestCaptured([cap({ subject: 'physics2' })], { subject: '玄学', dictEntries: SUBJECT_DICT });
    expect(createdData().subject).toBe('玄学');
    expect(createdData().subjectId).toBeUndefined();
  });

  it('站点行命中：meta.subject physics2 → 归一 label 物理 + subjectId', async () => {
    mockBankService.createQuestion.mockResolvedValue({ id: 'n1', createdAt: '' });
    await ingestCaptured([cap({ subject: 'physics2' })], { dictEntries: SUBJECT_DICT });
    expect(createdData().subject).toBe('物理');
    expect(createdData().subjectId).toBe('subj:physics');
  });

  it('站点行优先破歧义：菁优 politics → 初中道法（morality-law），非归一 politics', async () => {
    mockBankService.createQuestion.mockResolvedValue({ id: 'n1', createdAt: '' });
    await ingestCaptured([cap({ subject: 'politics' })], { dictEntries: SUBJECT_DICT });
    expect(createdData().subject).toBe('道德与法治');
    expect(createdData().subjectId).toBe('subj:morality-law');
  });

  it('站点原文未命中：subject 落原文 + subjectId 不传 + warning（不阻塞入库）', async () => {
    mockBankService.createQuestion.mockResolvedValue({ id: 'n1', createdAt: '' });
    const result = await ingestCaptured([cap({ subject: '玄学' })], { dictEntries: SUBJECT_DICT });
    expect(result.ok).toBe(1);
    expect(createdData().subject).toBe('玄学');
    expect(createdData().subjectId).toBeUndefined();
    expect(result.warnings?.length).toBe(1);
    expect(result.warnings?.[0]).toContain('未命中字典');
  });

  it('字典未注入（向后兼容）：站点原文直通、无 subjectId、零告警', async () => {
    mockBankService.createQuestion.mockResolvedValue({ id: 'n1', createdAt: '' });
    const result = await ingestCaptured([cap({ subject: 'physics2' })], {});
    expect(createdData().subject).toBe('physics2');
    expect(createdData().subjectId).toBeUndefined();
    expect(result.warnings ?? []).toEqual([]);
  });

  it('字典注入但无站点原文：回落 unknown、零告警（无值可解析不算未命中）', async () => {
    mockBankService.createQuestion.mockResolvedValue({ id: 'n1', createdAt: '' });
    const result = await ingestCaptured([cap({})], { dictEntries: SUBJECT_DICT });
    expect(createdData().subject).toBe('unknown');
    expect(createdData().subjectId).toBeUndefined();
    expect(result.warnings ?? []).toEqual([]);
  });
});


// ==================== D1-fix-6：bankid 落库 + 重采回填（跨页持久篮兜底） ====================

describe('ingestCaptured — sourceDetail.bankid 落库与回填（D1-fix-6）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBankService.listQuestions.mockResolvedValue([]);
    setQuestionService(mockBankService);
  });

  const recap = (bankid?: string): CapturedQuestion => ({
    questionId: '35355749',
    site: 'zujuan',
    sourceUrl: 'https://zujuan.xkw.com/',
    stemHtml: '<div>题干</div>',
    options: [],
    answerHtml: '',
    analysisHtml: '',
    images: [],
    meta: bankid ? { bankid } : {},
    rect: null,
  });

  /** 库存条目：sourceDetail 除 bankid 外键齐（回填合并时须原样保留） */
  const existingWith = (sourceDetail: Record<string, unknown>, fields: Partial<Question> = {}): Partial<Question>[] => [
    {
      id: 'existing-1',
      sourceType: 'network',
      sourceDetail,
      answer: '<p>库内答案</p>',
      analysis: '<p>库内解析</p>',
      knowledgePoints: ['酸碱中和滴定原理的应用'],
      ...fields,
    },
  ];

  const createdData = () => mockBankService.createQuestion.mock.calls[0][0].data;

  it('新建：meta.bankid 落 sourceDetail.bankid（与 meta.gated/answerVia 同层）', async () => {
    mockBankService.createQuestion.mockResolvedValue({ id: 'n1', createdAt: '' });

    await ingestCaptured([recap('14')], {});

    expect(createdData().sourceDetail).toMatchObject({
      site: 'zujuan',
      url: 'https://zujuan.xkw.com/',
      questionId: '35355749',
      bankid: '14',
    });
  });

  it('新建：无 bankid（老页面/异页未解析）→ 不落该键，sourceDetail 形状与改造前一致', async () => {
    mockBankService.createQuestion.mockResolvedValue({ id: 'n1', createdAt: '' });

    await ingestCaptured([recap()], {});

    expect(createdData().sourceDetail.bankid).toBeUndefined();
  });

  it('dup 回填：库存无 bankid + 本次采到 → 读出现有 sourceDetail 合并写回（其他键原样保留），updated=1', async () => {
    mockBankService.listQuestions.mockResolvedValue(
      existingWith({ site: 'zujuan', url: 'https://zujuan.xkw.com/gzhx/zsd43452/', questionId: '35355749', collectedAt: '2026-09-10T00:00:00.000Z', answerVia: 'hidden-window' }),
    );
    mockBankService.updateQuestion.mockResolvedValue({});

    const result = await ingestCaptured([recap('14')], {});

    expect(mockBankService.createQuestion).not.toHaveBeenCalled();
    expect(mockBankService.updateQuestion).toHaveBeenCalledTimes(1);
    const [id, patch] = mockBankService.updateQuestion.mock.calls[0];
    expect(id).toBe('existing-1');
    expect(patch.sourceDetail).toEqual({
      site: 'zujuan',
      url: 'https://zujuan.xkw.com/gzhx/zsd43452/',
      questionId: '35355749',
      collectedAt: '2026-09-10T00:00:00.000Z',
      answerVia: 'hidden-window',
      bankid: '14',
    });
    expect(result.updated).toBe(1);
    expect(result.dup).toBe(0);
  });

  it('dup 回填：库存与本次都有 bankid → 不覆盖库存值（无其他缺项则不 update，dup=1）', async () => {
    mockBankService.listQuestions.mockResolvedValue(
      existingWith({ site: 'zujuan', url: '', questionId: '35355749', collectedAt: '', bankid: '13' }),
    );

    const result = await ingestCaptured([recap('14')], {});

    expect(mockBankService.updateQuestion).not.toHaveBeenCalled();
    expect(result.updated ?? 0).toBe(0);
    expect(result.dup).toBe(1);
  });

  it('dup 回填：库存有 bankid 而本次未采到 → 保持库存值不动（不写 sourceDetail）', async () => {
    mockBankService.listQuestions.mockResolvedValue(
      existingWith({ site: 'zujuan', url: '', questionId: '35355749', collectedAt: '', bankid: '14' }),
    );

    const result = await ingestCaptured([recap()], {});

    expect(mockBankService.updateQuestion).not.toHaveBeenCalled();
    expect(result.dup).toBe(1);
  });
});
