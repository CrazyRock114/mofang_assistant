// 0054（R-045③④）：工作台多知识节点——契约字段、读侧归一（旧草稿单值）、写侧镜像。
//
// 锁三件事：
//   ① `WorkbenchCard.adoptedNodes?` 只增（`adoptedNode` 保留作首节点兼容）；
//   ② 读侧归一 helper：旧 workbench.json（只有 adoptedNode）加载后仍呈现为单元素；
//   ③ 写侧 patch：两字段恒同步（多值为准、adoptedNode 镜像首节点）。

import { describe, it, expect } from 'vitest';

import {
  adoptedNodesOf, adoptedNodesPatch, draftToCard, newPendingCard, parseWorkbenchState,
} from '../../src/recog/onestep/workbench.js';
import type { WorkbenchCard, WorkbenchState } from '../../src/shared/contracts/onestep-types.js';
import { createWorkbenchState } from '../../src/recog/onestep/workbench.js';

const DRAFT = {
  qno: '2-17',
  questionType: '填空',
  stemMarkdown: '如图，求浮力。',
  options: null,
  answerMarkdown: '2 N',
  analysisMarkdown: null,
  suggestedTags: [],
  figures: [],
  figureSource: 'none' as const,
  warnings: [],
};

function stateWith(card: WorkbenchCard): WorkbenchState {
  const state = createWorkbenchState({
    runId: 'run-1', mode: 'auto', stage: '初中', subjectId: 'subj:physics',
    paperTitle: '浮力练习', pages: [{ pageNo: 1, name: 'p001.png', width: 1200, height: 1600 }],
    now: '2026-09-23T10:00:00.000Z',
  });
  return { ...state, cards: [card], nextSeq: 2 };
}

describe('0054 读侧归一：adoptedNodesOf（新字段优先，旧单值回落）', () => {
  it('旧草稿（只有 adoptedNode）→ 单元素数组（无损）', () => {
    const legacy = { adoptedNode: { nodeId: 'n1', label: '力学 › 浮力' } } as WorkbenchCard;
    expect(adoptedNodesOf(legacy)).toEqual([{ nodeId: 'n1', label: '力学 › 浮力' }]);
  });

  it('新卡（adoptedNodes 为空数组）+ adoptedNode=null → 空', () => {
    const empty = { adoptedNode: null, adoptedNodes: [] } as WorkbenchCard;
    expect(adoptedNodesOf(empty)).toEqual([]);
  });

  it('新字段优先于旧单值（多值时不再看 adoptedNode）', () => {
    const multi = {
      adoptedNode: { nodeId: 'n1', label: '甲' },
      adoptedNodes: [{ nodeId: 'n1', label: '甲' }, { nodeId: 'n2', label: '乙' }],
    } as WorkbenchCard;
    expect(adoptedNodesOf(multi).map((n) => n.nodeId)).toEqual(['n1', 'n2']);
  });
});

describe('0054 写侧：adoptedNodesPatch（两字段恒同步，首节点镜像）', () => {
  it('多值 → adoptedNodes=全量 + adoptedNode=首节点', () => {
    const patch = adoptedNodesPatch([{ nodeId: 'n1', label: '甲' }, { nodeId: 'n2', label: '乙' }]);
    expect(patch.adoptedNodes).toEqual([{ nodeId: 'n1', label: '甲' }, { nodeId: 'n2', label: '乙' }]);
    expect(patch.adoptedNode).toEqual({ nodeId: 'n1', label: '甲' });
  });

  it('空 → 两字段同清（不留残值）', () => {
    const patch = adoptedNodesPatch([]);
    expect(patch.adoptedNodes).toEqual([]);
    expect(patch.adoptedNode).toBeNull();
  });
});

describe('0054 落盘往返：adoptedNodes 持久化 + 旧草稿兼容', () => {
  it('draftToCard 产出 adoptedNodes:[]（新卡零采纳起步）', () => {
    const card = draftToCard(DRAFT, { id: 'c1', source: 'ai', pageNo: 1 });
    expect(card.adoptedNodes).toEqual([]);
    expect(card.adoptedNode).toBeNull();
  });

  it('newPendingCard 同口径（待识别卡零采纳）', () => {
    const card = newPendingCard({ id: 'c1', frames: [], source: 'manual' });
    expect(card.adoptedNodes).toEqual([]);
    expect(card.adoptedNode).toBeNull();
  });

  it('多值往返：序列化 → 反序列化后仍是同序多值', () => {
    const state = stateWith({
      ...draftToCard(DRAFT, { id: 'c1', source: 'ai', pageNo: 1 }),
      ...adoptedNodesPatch([{ nodeId: 'n1', label: '甲' }, { nodeId: 'n2', label: '乙' }]),
    });
    const restored = parseWorkbenchState(JSON.stringify(state), 'run-1');
    expect(adoptedNodesOf(restored!.cards[0]!).map((n) => n.nodeId)).toEqual(['n1', 'n2']);
    expect(restored!.cards[0]!.adoptedNode).toEqual({ nodeId: 'n1', label: '甲' });
  });

  it('旧草稿 JSON（0054 之前落盘，无 adoptedNodes 键）→ 加载后单值照旧可用', () => {
    const state = stateWith(draftToCard(DRAFT, { id: 'c1', source: 'ai', pageNo: 1 }));
    const raw = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
    const cards = raw['cards'] as Array<Record<string, unknown>>;
    delete cards[0]!['adoptedNodes'];
    cards[0]!['adoptedNode'] = { nodeId: 'n-legacy', label: '旧草稿节点' };

    const restored = parseWorkbenchState(JSON.stringify(raw), 'run-1');
    expect(restored).not.toBeNull();
    expect(adoptedNodesOf(restored!.cards[0]!)).toEqual([{ nodeId: 'n-legacy', label: '旧草稿节点' }]);
    expect(restored!.cards[0]!.adoptedNode).toEqual({ nodeId: 'n-legacy', label: '旧草稿节点' });
  });

  it('脏数据（adoptedNodes 非数组 / 条目缺 nodeId）→ 按保守默认忽略，不炸', () => {
    const state = stateWith(draftToCard(DRAFT, { id: 'c1', source: 'ai', pageNo: 1 }));
    const raw = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
    const cards = raw['cards'] as Array<Record<string, unknown>>;
    cards[0]!['adoptedNodes'] = [{ label: '缺 id' }, 'not-an-object', { nodeId: 'n-ok', label: '保留' }];
    const restored = parseWorkbenchState(JSON.stringify(raw), 'run-1');
    expect(adoptedNodesOf(restored!.cards[0]!)).toEqual([{ nodeId: 'n-ok', label: '保留' }]);
  });
});
