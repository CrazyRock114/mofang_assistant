// 0040 P1：工作台卡流模型 + 文件态落盘测试。
// - 状态构造/分配 id/反序列化（损坏、版本不符、runId 不一致一律 null——不炸不篡改）
// - 引擎草稿 → 题卡（Markdown 落契约 HTML、[图N] 换图、核验提示）
// - 落盘：run 目录 workbench.json 原子写 + 读回

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  allocateCardId, cardStemText, checkedCommittableIds, createWorkbenchState, draftToCard,
  isCommittable, makeFrame, newPendingCard, parseWorkbenchState, verifyWarnings,
} from '../../src/recog/onestep/workbench.js';
import { readWorkbenchFile, WORKBENCH_REL, writeWorkbenchFile } from '../../src/recog/runs/workbench-store.js';
import type { OnestepDraft, WorkbenchState } from '../../src/shared/contracts/onestep-types.js';

const NOW = '2026-09-19T10:00:00.000Z';

function baseState(): WorkbenchState {
  return createWorkbenchState({
    runId: 'run-1', mode: 'auto', stage: '初中', subjectId: 'subj:physics',
    paperTitle: '浮力练习', pages: [{ pageNo: 1, name: 'p001.png', width: 1200, height: 1600 }], now: NOW,
  });
}

const DRAFT: OnestepDraft = {
  qno: '2-17',
  questionType: '填空',
  stemMarkdown: '如图[图1]，将物体放入液体中，求 $F_\\text{浮}$。',
  options: null,
  answerMarkdown: '2 N',
  analysisMarkdown: null,
  suggestedTags: ['浮力', '阿基米德原理'],
  figures: [{ ref: '图1', bbox: [0.1, 0.2, 0.5, 0.6] }],
  figureSource: 'dso',
  warnings: ['图块坐标来源：DeepSeek-OCR 定位 1 个'],
};

describe('0040 P1：工作台状态构造与反序列化', () => {
  it('新建状态：版本号/序号/空卡流', () => {
    const state = baseState();
    expect(state.version).toBe(1);
    expect(state.cards).toEqual([]);
    expect(state.nextSeq).toBe(1);
    expect(state.updatedAt).toBe(NOW);
  });

  it('卡 id 分配递增（跨会话语义由 nextSeq 保证）', () => {
    const state = baseState();
    const first = allocateCardId(state);
    expect(first.id).toBe('c1');
    const second = allocateCardId({ ...state, nextSeq: first.nextSeq });
    expect(second.id).toBe('c2');
  });

  it('往返：序列化 → 反序列化 语义等价（含卡片全字段）', () => {
    const state = baseState();
    const card = draftToCard(DRAFT, {
      id: 'c1', source: 'ai', pageNo: 1,
      figureSrc: () => 'data:image/png;base64,AAA',
      figureSize: () => ({ width: 100, height: 80 }),
    });
    card.adoptedTags = ['浮力'];
    card.adoptedNode = { nodeId: 'n1', label: '力学 > 浮力' };
    card.treeSuggestions = [{ nodeId: 'n1', label: '力学 > 浮力', confidence: 0.86 }];
    state.cards = [card];
    state.nextSeq = 2;

    const restored = parseWorkbenchState(JSON.stringify(state), 'run-1');
    expect(restored).toEqual(state);
  });

  it('损坏 JSON / 版本不符 / runId 不一致 → null（按首次进入处理）', () => {
    expect(parseWorkbenchState('{ 不是 json', 'run-1')).toBeNull();
    expect(parseWorkbenchState(JSON.stringify({ ...baseState(), version: 99 }), 'run-1')).toBeNull();
    expect(parseWorkbenchState(JSON.stringify(baseState()), 'run-2')).toBeNull();
  });

  it('缺字段的卡片行按保守默认值补齐（不整档丢弃）', () => {
    const raw = JSON.stringify({
      version: 1, runId: 'run-1', mode: 'auto', stage: '', subjectId: '', paperTitle: '',
      pages: [], nextSeq: 3, updatedAt: NOW,
      cards: [{ id: 'c1', status: 'unknown-status', source: 'weird', frames: [{ pageNo: 1, rect: { x: 0, y: 0, w: 1, h: 1 } }] }],
    });
    const restored = parseWorkbenchState(raw, 'run-1');
    expect(restored).not.toBeNull();
    const card = restored!.cards[0]!;
    expect(card.status).toBe('pending');
    expect(card.source).toBe('manual');
    expect(card.figures).toEqual([]);
    expect(card.committedQuestionId).toBeNull();
  });
});

describe('0040 P1：引擎草稿 → 题卡', () => {
  it('Markdown 落契约 HTML；[图N] 换成真图块节点；答案/解析分列', () => {
    const card = draftToCard(DRAFT, {
      id: 'c1', source: 'ai', pageNo: 1,
      figureSrc: () => 'data:image/png;base64,FIG',
      figureSize: () => ({ width: 320, height: 200 }),
    });
    expect(card.status).toBe('question');
    expect(card.checked).toBe(true);
    expect(card.qno).toBe('2-17');
    expect(card.typeCode).toBe('填空');
    expect(card.contentHtml.startsWith('<div class="question">')).toBe(true);
    expect(card.contentHtml).toContain('data:image/png;base64,FIG');
    expect(card.contentHtml).not.toContain('[图1]');
    expect(card.contentHtml).toContain('data-tex="F_\\text{浮}"');
    expect(card.answerHtml).toContain('2 N');
    expect(card.analysisHtml).toBe('');
    expect(card.figures).toEqual([{ ref: '图1', pageNo: 1, bbox: [0.1, 0.2, 0.5, 0.6], adjusted: false }]);
    expect(card.figureSource).toBe('dso');
    expect(card.tags).toEqual(['浮力', '阿基米德原理']);
    // 2026-09-23 目检反馈：识别产出的建议标签默认全部采纳（chip 选中态，人可逐个点掉）
    expect(card.adoptedTags).toEqual(['浮力', '阿基米德原理']);
  });

  it('无裁图源时 [图N] 落空 src 占位（不消失、不静默）', () => {
    const card = draftToCard(DRAFT, { id: 'c1', source: 'ai', pageNo: 1 });
    expect(card.contentHtml).toContain('class="diagram"');
    expect(card.contentHtml).toContain('src=""');
  });

  it('操作层可覆盖原卷题号（跨页衔接补全）', () => {
    const card = draftToCard({ ...DRAFT, qno: null }, { id: 'c1', source: 'manual', pageNo: 2, qno: '2-18' });
    expect(card.qno).toBe('2-18');
  });
});

describe('0040 P1：核验提示与提交判定', () => {
  it('答案与解析皆缺 → 黄条提示（不硬拦）', () => {
    const card = draftToCard({ ...DRAFT, answerMarkdown: null }, { id: 'c1', source: 'ai', pageNo: 1 });
    expect(verifyWarnings(card).some((w) => w.includes('未识别到答案/解析'))).toBe(true);
  });

  it('图块位多于图块坐标 → 提示人工补图（不静默留占位）', () => {
    const card = draftToCard({ ...DRAFT, figures: [] }, { id: 'c1', source: 'ai', pageNo: 1 });
    const warnings = verifyWarnings(card);
    expect(warnings.some((w) => w.includes('只配到 0 个图块坐标'))).toBe(true);
  });

  it('题面残留未替换的 [图N] → 显式告警', () => {
    const card = draftToCard(DRAFT, { id: 'c1', source: 'ai', pageNo: 1 });
    const withResidual = { ...card, contentHtml: '<div class="question"><p>如图[图2]所示</p></div>' };
    expect(verifyWarnings(withResidual).some((w) => w.includes('未替换的 [图2]'))).toBe(true);
  });

  it('图块未人工确认 → 提示逐图确认（人工调整是一等公民）', () => {
    const card = draftToCard(DRAFT, { id: 'c1', source: 'ai', pageNo: 1 });
    expect(verifyWarnings(card).some((w) => w.includes('建议逐图确认'))).toBe(true);
    const adjusted = { ...card, figures: card.figures.map((f) => ({ ...f, adjusted: true })) };
    expect(verifyWarnings(adjusted).some((w) => w.includes('建议逐图确认'))).toBe(false);
  });

  it('待识别卡不产生题卡核验提示', () => {
    const pending = newPendingCard({ id: 'c1', frames: [makeFrame('f1', { pageNo: 1, rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } })], source: 'manual' });
    expect(pending.status).toBe('pending');
    expect(verifyWarnings(pending)).toEqual([]);
  });

  it('批量入库勾选集只含未入库的题卡', () => {
    const state = baseState();
    const a = draftToCard(DRAFT, { id: 'c1', source: 'ai', pageNo: 1 });
    const b = { ...draftToCard(DRAFT, { id: 'c2', source: 'ai', pageNo: 1 }), checked: false };
    const c = { ...draftToCard(DRAFT, { id: 'c3', source: 'ai', pageNo: 1 }), status: 'committed' as const };
    const d = newPendingCard({ id: 'c4', frames: [], source: 'manual' });
    state.cards = [a, b, c, d];
    expect(isCommittable(a)).toBe(true);
    expect(isCommittable(c)).toBe(false);
    expect(checkedCommittableIds(state)).toEqual(['c1']);
  });

  it('题干纯文本抽取：公式转 $…$、图块转 [图]、剥标签与实体', () => {
    const card = draftToCard(DRAFT, { id: 'c1', source: 'ai', pageNo: 1, figureSrc: () => 'x' });
    const text = cardStemText(card);
    expect(text).toContain('$F_\\text{浮}$');
    expect(text).toContain('[图]');
    expect(text).not.toContain('<');
  });
});

describe('0040 P1：工作台文件态落盘（run 目录 workbench.json）', () => {
  let dir = '';
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mofang-wb-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('写后读回语义一致，且无临时文件残留', () => {
    const state = baseState();
    const card = draftToCard(DRAFT, { id: 'c1', source: 'ai', pageNo: 1 });
    state.cards = [card];
    const savedAt = writeWorkbenchFile(dir, state, NOW);
    expect(savedAt).toBe(NOW);
    expect(existsSync(join(dir, WORKBENCH_REL))).toBe(true);
    expect(existsSync(join(dir, `${WORKBENCH_REL}.tmp`))).toBe(false);

    const restored = readWorkbenchFile(dir, 'run-1');
    expect(restored?.runId).toBe('run-1');
    expect(restored?.cards).toHaveLength(1);
    expect(restored?.cards[0]!.contentHtml).toBe(card.contentHtml);
  });

  it('文件不存在 → null（首次进入）；文件损坏 → null（不抛）', () => {
    expect(readWorkbenchFile(dir, 'run-1')).toBeNull();
    writeFileSync(join(dir, WORKBENCH_REL), '{ 半截 json', 'utf8');
    expect(readWorkbenchFile(dir, 'run-1')).toBeNull();
  });

  it('落盘内容带 updatedAt（写入时刻），runId 与目录归属一致', () => {
    const state = baseState();
    writeWorkbenchFile(dir, state, '2026-09-19T11:00:00.000Z');
    const raw = JSON.parse(readFileSync(join(dir, WORKBENCH_REL), 'utf8')) as { updatedAt: string; runId: string };
    expect(raw.updatedAt).toBe('2026-09-19T11:00:00.000Z');
    expect(raw.runId).toBe('run-1');
  });

  it('0047：往返不丢 committedPaperId（存为试卷链的撤销摘卷依据；丢则重进工作台后退化为「只删题不摘卷」）', () => {
    const state = baseState();
    const card = {
      ...draftToCard(DRAFT, { id: 'c1', source: 'ai', pageNo: 1 }),
      status: 'committed' as const,
      checked: false,
      committedQuestionId: 'q-1',
      committedPaperId: 'paper-1',
    };
    state.cards = [card];
    writeWorkbenchFile(dir, state, NOW);

    const restored = readWorkbenchFile(dir, 'run-1');
    const back = restored?.cards[0];
    expect(back?.status).toBe('committed');
    expect(back?.committedQuestionId).toBe('q-1');
    expect(back?.committedPaperId).toBe('paper-1');
  });
});
