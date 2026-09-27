// 0044 P3：recog.saveAsPaper 主进程一步编排 — 注入式单测（任务书 §四）。
// 覆盖：逐题入库顺序（题卡序）、挂树/标签沿用透传、建卷 composing + folder 归属、
// 保序挂题、run 回写、半失败「题保留、卷不建」（建卷+挂题单事务）、失败明示步骤。

import { describe, it, expect } from 'vitest';

import type { BankService, PaperExtService, TreeService, Paper } from '../../src/shared/contracts/bank-types.js';
import type { RecogSaveAsPaperPayload } from '../../src/shared/contracts/ipc-channels.js';
import { SaveAsPaperService, type SaveAsPaperDeps } from '../../src/bank/save-as-paper-service.js';

// ---------- fake 记录器：按序记录调用，支持逐步注入失败 ----------

interface CallLog {
  op: string;
  at?: string;
  [key: string]: unknown;
}

function makeDeps(options: {
  failCreateQuestionAt?: number;
  failAddQuestionAt?: number;
  failAttach?: boolean;
} = {}) {
  const log: CallLog[] = [];
  const createdQuestions: string[] = [];
  const attachedQuestionsByPaper = new Map<string, string[]>();
  let paperSeq = 0;
  const papersById = new Map<string, Paper>();
  let beginCount = 0;
  let commitCount = 0;
  let rollbackCount = 0;

  const bank = {
    createQuestion: async (data: Parameters<BankService['createQuestion']>[0]) => {
      log.push({ op: 'createQuestion', subject: data.subject, subjectId: data.subjectId, sourceDetail: data.sourceDetail, typeId: data.typeId, questionType: data.questionType, images: data.images });
      const seq = createdQuestions.length + 1;
      if (options.failCreateQuestionAt === seq) throw new Error('simulated create failure');
      createdQuestions.push(`q-${seq}`);
      return {
        id: `q-${seq}`,
        subject: data.subject,
        sourceType: 'local' as const,
        sourceDetail: data.sourceDetail,
        content: data.content,
        images: data.images,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      };
    },
    addTag: async (questionId: string, tag: string) => {
      log.push({ op: 'addTag', questionId, tag });
    },
    addQuestion: async (paperId: string, questionId: string) => {
      log.push({ op: 'addQuestion', paperId, questionId });
      const seq = Number(questionId.split('-')[1]);
      if (options.failAddQuestionAt === seq) throw new Error('simulated addQuestion failure');
      attachedQuestionsByPaper.set(paperId, [...(attachedQuestionsByPaper.get(paperId) ?? []), questionId]);
    },
  } satisfies Pick<BankService, 'createQuestion' | 'addTag' | 'addQuestion'>;

  const tree = {
    linkQuestion: async (questionId: string, nodeId: string) => {
      log.push({ op: 'linkQuestion', questionId, nodeId });
    },
  } satisfies Pick<TreeService, 'linkQuestion'>;

  const paper = {
    createPaperEx: async (title: string, _config: Record<string, unknown>, opts: { status?: string }) => {
      log.push({ op: 'createPaperEx', title, status: opts.status });
      paperSeq += 1;
      const p: Paper = { id: `paper-${paperSeq}`, title, config: {}, createdAt: '2026-01-01T00:00:00Z', archived: false, status: 'basket' };
      papersById.set(p.id, p);
      return p;
    },
    moveToFolder: async (paperId: string, folderId: string | null) => {
      log.push({ op: 'moveToFolder', paperId, folderId });
    },
  } satisfies Pick<PaperExtService, 'createPaperEx' | 'moveToFolder'>;

  const runs = {
    attachQuestions: async (id: string, questionIds: string[], now: string) => {
      log.push({ op: 'attachQuestions', runId: id, questionIds, now });
      if (options.failAttach) throw new Error('simulated attach failure');
    },
  };

  const tx = {
    begin: () => {
      beginCount += 1;
      log.push({ op: 'tx.begin' });
    },
    commit: () => {
      commitCount += 1;
      log.push({ op: 'tx.commit' });
    },
    rollback: () => {
      rollbackCount += 1;
      log.push({ op: 'tx.rollback' });
    },
  };

  const deps: SaveAsPaperDeps = { bank, tree, paper, runs, tx };
  return { deps, log, createdQuestions, attachedQuestionsByPaper, papersById, counts: { get begin() { return beginCount; }, get commit() { return commitCount; }, get rollback() { return rollbackCount; } } };
}

function makePayload(overrides: Partial<RecogSaveAsPaperPayload> = {}): RecogSaveAsPaperPayload {
  return {
    runId: 'run-0044',
    title: '2024 秋季期中卷',
    subject: '数学',
    cards: [
      {
        qno: '1',
        typeCode: '',
        contentHtml: '<div class="question">第 1 题</div>',
        answerHtml: '<p>A</p>',
        analysisHtml: '',
        pageNo: 1,
        adoptedTags: ['期中'],
        adoptedNode: { nodeId: 'node-1', label: '一次函数' },
      },
      {
        qno: '2',
        typeCode: 'qt-choice',
        contentHtml: '<div class="question">第 2 题</div>',
        answerHtml: '',
        analysisHtml: '<p>解析</p>',
        pageNo: 2,
        adoptedTags: [],
        adoptedNode: null,
      },
    ],
    ...overrides,
  };
}

describe('0044 saveAsPaper 编排（注入式）', () => {
  it('成功路径：逐题入库（题卡序）→ 挂树/标签沿用 → 事务内建卷 composing + 移夹 + 保序挂题 → run 回写', async () => {
    const { deps, log, counts } = makeDeps();
    const svc = new SaveAsPaperService(deps);

    const result = await svc.saveAsPaper(makePayload({ folderId: 'folder-1', subjectId: 'subj:math', paperTitle: '来源卷.pdf' }));

    expect(result.paperId).toBe('paper-1');
    expect(result.questionIds).toEqual(['q-1', 'q-2']);

    // 逐题入库顺序：q1 全套（入库→打标→挂树）先于 q2
    const createIdx = log.map((c) => c.op).indexOf('createQuestion');
    const tagIdx = log.map((c) => c.op).indexOf('addTag');
    const linkIdx = log.map((c) => c.op).indexOf('linkQuestion');
    const create2Idx = log.map((c) => c.op).lastIndexOf('createQuestion');
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(tagIdx).toBeGreaterThan(createIdx);
    expect(linkIdx).toBeGreaterThan(tagIdx);
    expect(create2Idx).toBeGreaterThan(linkIdx);

    // 挂树沿用透传（adoptedNode.nodeId）；标签沿用（q1 一条；q2 无采纳不产生 addTag）
    expect(log.filter((c) => c.op === 'linkQuestion')).toEqual([{ op: 'linkQuestion', questionId: 'q-1', nodeId: 'node-1' }]);
    expect(log.filter((c) => c.op === 'addTag')).toEqual([{ op: 'addTag', questionId: 'q-1', tag: '期中' }]);

    // 入库字段：subject/subjectId/typeId/sourceDetail（origin=scan、pageNo、qno、paperTitle）
    const q2 = log.filter((c) => c.op === 'createQuestion')[1] as CallLog;
    expect(q2.subject).toBe('数学');
    expect(q2.subjectId).toBe('subj:math');
    expect(q2.typeId).toBe('qt-choice');
    expect(q2.sourceDetail).toEqual({ origin: 'scan', pageNo: 2, qno: '2', paperTitle: '来源卷.pdf' });

    // 建卷在事务内：begin < createPaperEx(status=composing) < moveToFolder < addQuestion×2 < commit
    const ops = log.map((c) => c.op);
    const beginIdx = ops.indexOf('tx.begin');
    const commitIdx = ops.indexOf('tx.commit');
    const createPaperIdx = ops.indexOf('createPaperEx');
    expect(beginIdx).toBeGreaterThan(create2Idx);
    expect(createPaperIdx).toBeGreaterThan(beginIdx);
    expect(commitIdx).toBeGreaterThan(createPaperIdx);
    expect(counts.begin).toBe(1);
    expect(counts.commit).toBe(1);
    expect(counts.rollback).toBe(0);

    const createPaper = log[createPaperIdx] as CallLog;
    expect(createPaper.status).toBe('composing');
    expect(log.filter((c) => c.op === 'moveToFolder')).toEqual([{ op: 'moveToFolder', paperId: 'paper-1', folderId: 'folder-1' }]);

    // 保序挂题
    expect(log.filter((c) => c.op === 'addQuestion').map((c) => c.questionId)).toEqual(['q-1', 'q-2']);

    // run 回写（事务外，最后一步）
    const attach = log.filter((c) => c.op === 'attachQuestions');
    expect(attach).toHaveLength(1);
    expect(ops.indexOf('attachQuestions')).toBeGreaterThan(commitIdx);
  });

  // 0057：第二条入库腿不再恒 images: []——卡上带 images 时原样落库（渲染层按 content 资产引用生成）
  it('0057：题卡带 images → 逐题落库（缺省卡 = 空数组，旧调用方零影响）', async () => {
    const { deps, log } = makeDeps();
    const svc = new SaveAsPaperService(deps);
    const payload = makePayload();
    const images = [
      { assetId: 'data-assets/recog/a1.png', type: 'figure' as const },
      { assetId: 'data-assets/recog/a2.png', type: 'figure' as const },
    ];
    await svc.saveAsPaper({
      ...payload,
      cards: [
        { ...payload.cards[0]!, images },
        { ...payload.cards[1]! }, // 缺省：不带 images
      ],
    });

    const creates = log.filter((c) => c.op === 'createQuestion');
    expect(creates).toHaveLength(2);
    expect(creates[0]!['images']).toEqual(images);
    expect(creates[1]!['images']).toEqual([]);
  });

  it('folderId 缺省：不调 moveToFolder（未分类），事务语义不变', async () => {
    const { deps, log } = makeDeps();
    const svc = new SaveAsPaperService(deps);
    await svc.saveAsPaper(makePayload());
    expect(log.some((c) => c.op === 'moveToFolder')).toBe(false);
    expect(log.some((c) => c.op === 'tx.commit')).toBe(true);
  });

  it('半失败·题入库阶段（第 2 题 createQuestion 抛错）：题保留、卷不建（createPaperEx 零调用）、报错明示位置', async () => {
    const { deps, log, createdQuestions } = makeDeps({ failCreateQuestionAt: 2 });
    const svc = new SaveAsPaperService(deps);

    await expect(svc.saveAsPaper(makePayload())).rejects.toThrow(/第 2 题/);
    // 题保留：第 1 题已入库（fake 记录在案）
    expect(createdQuestions).toEqual(['q-1']);
    // 卷不建：编排未进入事务、未建卷
    expect(log.some((c) => c.op === 'createPaperEx')).toBe(false);
    expect(log.some((c) => c.op === 'tx.begin')).toBe(false);
  });

  it('半失败·挂题阶段（addQuestion 抛错）：事务回滚（卷不建）、报错明示挂题步骤', async () => {
    const { deps, log, counts } = makeDeps({ failAddQuestionAt: 2 });
    const svc = new SaveAsPaperService(deps);

    await expect(svc.saveAsPaper(makePayload())).rejects.toThrow(/挂题|addQuestion/);
    expect(counts.begin).toBe(1);
    expect(counts.rollback).toBe(1);
    expect(counts.commit).toBe(0);
    expect(log.some((c) => c.op === 'attachQuestions')).toBe(false);
  });

  it('run 回写失败：卷已完整落库（题+卷不回滚），抛错明示「回写失败」（与 0040 入库同口径，交付申报）', async () => {
    const { deps, log, counts, attachedQuestionsByPaper } = makeDeps({ failAttach: true });
    const svc = new SaveAsPaperService(deps);

    await expect(svc.saveAsPaper(makePayload())).rejects.toThrow(/回写/);
    expect(counts.commit).toBe(1);
    expect(counts.rollback).toBe(0);
    expect(attachedQuestionsByPaper.get('paper-1')).toEqual(['q-1', 'q-2']);
    expect(log.some((c) => c.op === 'tx.commit')).toBe(true);
  });

  it('空卡清单：直接拒绝（不建卷不入库）', async () => {
    const { deps, log } = makeDeps();
    const svc = new SaveAsPaperService(deps);
    await expect(svc.saveAsPaper(makePayload({ cards: [] }))).rejects.toThrow();
    expect(log).toHaveLength(0);
  });

  it('卷名空白：拒绝（默认名兜底是渲染层职责，编排层守最后一道）', async () => {
    const { deps } = makeDeps();
    const svc = new SaveAsPaperService(deps);
    await expect(svc.saveAsPaper(makePayload({ title: '   ' }))).rejects.toThrow();
  });
});
