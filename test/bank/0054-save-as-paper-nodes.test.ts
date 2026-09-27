// 0054（R-045④）：recog.saveAsPaper 多知识节点落链（契约只增 adoptedNodes?，adoptedNode 回落兼容）。
//
// 锁三件事：① adoptedNodes 多值 → 逐节点 linkQuestion（保序）；
//          ② 旧调用方（只有 adoptedNode）→ 单链零影响；③ adoptedNodes 为空数组时不回落到单值。

import { describe, it, expect } from 'vitest';

import type { BankService, Paper, PaperExtService, TreeService } from '../../src/shared/contracts/bank-types.js';
import type { RecogSaveAsPaperPayload } from '../../src/shared/contracts/ipc-channels.js';
import { SaveAsPaperService, type SaveAsPaperDeps } from '../../src/bank/save-as-paper-service.js';

interface CallLog {
  op: string;
  [key: string]: unknown;
}

function makeDeps() {
  const log: CallLog[] = [];
  let seq = 0;
  const bank = {
    createQuestion: async () => {
      seq += 1;
      log.push({ op: 'createQuestion' });
      return {
        id: `q-${seq}`, subject: '数学', sourceType: 'local' as const, sourceDetail: {}, content: '',
        images: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      };
    },
    addTag: async () => undefined,
    addQuestion: async () => undefined,
  } satisfies Pick<BankService, 'createQuestion' | 'addTag' | 'addQuestion'>;
  const tree = {
    linkQuestion: async (questionId: string, nodeId: string) => {
      log.push({ op: 'linkQuestion', questionId, nodeId });
    },
  } satisfies Pick<TreeService, 'linkQuestion'>;
  const paper = {
    createPaperEx: async (title: string): Promise<Paper> => ({
      id: 'paper-1', title, config: {}, createdAt: '2026-01-01T00:00:00Z', archived: false, status: 'composing',
    }),
    moveToFolder: async () => undefined,
  } satisfies Pick<PaperExtService, 'createPaperEx' | 'moveToFolder'>;
  const runs = { attachQuestions: async () => undefined };
  const tx = { begin: () => undefined, commit: () => undefined, rollback: () => undefined };
  const deps: SaveAsPaperDeps = { bank, tree, paper, runs, tx };
  return { deps, log };
}

function card(overrides: Partial<RecogSaveAsPaperPayload['cards'][number]> = {}): RecogSaveAsPaperPayload['cards'][number] {
  return {
    qno: '1', typeCode: '', contentHtml: '<div class="question">第 1 题</div>',
    answerHtml: '', analysisHtml: '', pageNo: 1, adoptedTags: [], adoptedNode: null,
    ...overrides,
  };
}

function payload(cards: RecogSaveAsPaperPayload['cards']): RecogSaveAsPaperPayload {
  return { runId: 'run-1', title: '期中卷', subject: '数学', cards };
}

describe('0054 R-045④：saveAsPaper 多知识节点落链', () => {
  it('adoptedNodes 多值 → 逐节点 linkQuestion（按数组序，不丢不重）', async () => {
    const { deps, log } = makeDeps();
    const svc = new SaveAsPaperService(deps);
    await svc.saveAsPaper(payload([card({
      adoptedNodes: [{ nodeId: 'n-1', label: '一次函数' }, { nodeId: 'n-2', label: '函数图像' }, { nodeId: 'n-3', label: '待定系数法' }],
    })]));

    expect(log.filter((c) => c.op === 'linkQuestion')).toEqual([
      { op: 'linkQuestion', questionId: 'q-1', nodeId: 'n-1' },
      { op: 'linkQuestion', questionId: 'q-1', nodeId: 'n-2' },
      { op: 'linkQuestion', questionId: 'q-1', nodeId: 'n-3' },
    ]);
  });

  it('旧调用方（只有 adoptedNode 单值）→ 单链零影响（回落兼容）', async () => {
    const { deps, log } = makeDeps();
    const svc = new SaveAsPaperService(deps);
    await svc.saveAsPaper(payload([card({ adoptedNode: { nodeId: 'n-1', label: '一次函数' } })]));

    expect(log.filter((c) => c.op === 'linkQuestion')).toEqual([
      { op: 'linkQuestion', questionId: 'q-1', nodeId: 'n-1' },
    ]);
  });

  it('adoptedNodes=[] 优先于残留的 adoptedNode 单值（多值为准，不回落重复挂）', async () => {
    const { deps, log } = makeDeps();
    const svc = new SaveAsPaperService(deps);
    await svc.saveAsPaper(payload([card({
      adoptedNodes: [],
      adoptedNode: { nodeId: 'n-1', label: '一次函数' },
    })]));

    expect(log.filter((c) => c.op === 'linkQuestion')).toEqual([]);
  });

  it('未采纳（两字段皆空）→ 不产生挂链（P-07 不点不写）', async () => {
    const { deps, log } = makeDeps();
    const svc = new SaveAsPaperService(deps);
    await svc.saveAsPaper(payload([card(), card({ qno: '2', adoptedNodes: [] })]));

    expect(log.filter((c) => c.op === 'linkQuestion')).toEqual([]);
    expect(log.filter((c) => c.op === 'createQuestion')).toHaveLength(2);
  });
});
