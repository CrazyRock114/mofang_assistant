// 0029 P1：≤4 层截断（D-050②）——注入组装前对锚点快照做深度截断（纯函数，不改 0024 既有文件）。
// 关键联动：截断后的快照同时作为 buildAnchorPrompt 与 validateAnchorSuggestions 的白名单——
// 深层节点既不注入、回指即被拦（unknown-id），这是「≤4 层口径」的落地保证。

import { describe, it, expect } from 'vitest';

import type { AnchorSnapshot } from '../../src/shared/contracts/ai-anchor.js';
import { ANCHOR_INJECTION_MAX_DEPTH } from '../../src/shared/contracts/ai-suggest-types.js';
import { truncateSnapshotToDepth } from '../../src/recog/anchor/depth.js';
import { validateAnchorSuggestions } from '../../src/recog/anchor/validate.js';

function makeSnapshot(): AnchorSnapshot {
  return {
    query: { stage: '初中', subjectId: 'subj:physics' },
    trees: [{
      id: 't1', name: '知识点·初中物理（权威）', type: 'knowledge',
      stage: '初中', subjectKey: 'physics',
    }],
    nodes: [
      { id: 'n-1', treeId: 't1', path: ['物理'] },
      { id: 'n-2', treeId: 't1', path: ['物理', '力学'] },
      { id: 'n-3', treeId: 't1', path: ['物理', '力学', '摩擦力'] },
      { id: 'n-4', treeId: 't1', path: ['物理', '力学', '摩擦力', '滑动摩擦'] },
      { id: 'n-5', treeId: 't1', path: ['物理', '力学', '摩擦力', '滑动摩擦', '系数测量'] },
    ],
    dict: {
      subjects: [{ id: 'subj:physics', kind: 'subject', code: 'physics', label: '物理' }],
      questionTypes: [{ id: 'qtype:single-choice', kind: 'question_type', code: 'single-choice', label: '单选题' }],
      difficulties: [],
    },
    empty: false,
    emptyReason: null,
    warnings: [],
  };
}

describe('0029 D-050② 层数口径常量', () => {
  it('ANCHOR_INJECTION_MAX_DEPTH = 4（如需调整须新决策修订 D-050，任务书 §三.1）', () => {
    expect(ANCHOR_INJECTION_MAX_DEPTH).toBe(4);
  });
});

describe('0029 ≤4 层截断', () => {
  it('默认按 4 层截断：保留 depth≤4，剔除深层节点；trees/dict/query 原样保留', () => {
    const snapshot = makeSnapshot();
    const truncated = truncateSnapshotToDepth(snapshot);

    expect(truncated.nodes.map((n) => n.id)).toEqual(['n-1', 'n-2', 'n-3', 'n-4']);
    expect(truncated.nodes.at(-1)?.path).toEqual(['物理', '力学', '摩擦力', '滑动摩擦']);
    expect(truncated.trees).toEqual(snapshot.trees);
    expect(truncated.dict).toEqual(snapshot.dict);
    expect(truncated.query).toEqual(snapshot.query);
    expect(truncated.empty).toBe(false);
  });

  it('不变异原快照（调用方可继续用全量快照做统计）', () => {
    const snapshot = makeSnapshot();
    truncateSnapshotToDepth(snapshot);
    expect(snapshot.nodes).toHaveLength(5);
    expect(snapshot.nodes.at(-1)?.id).toBe('n-5');
  });

  it('显式 maxDepth 生效（2 层 → 只留两级以内）；无截断时逐字段等值', () => {
    const snapshot = makeSnapshot();
    expect(truncateSnapshotToDepth(snapshot, 2).nodes.map((n) => n.id)).toEqual(['n-1', 'n-2']);
    const untouched = truncateSnapshotToDepth(snapshot, 5);
    expect(untouched.nodes).toEqual(snapshot.nodes);
  });

  it('全深层快照：截断后 nodes 为空但 trees/dict 保留（不判 empty——字典锚仍在，树类建议回落 NONE）', () => {
    const snapshot = makeSnapshot();
    const truncated = truncateSnapshotToDepth(snapshot, 0);
    expect(truncated.nodes).toHaveLength(0);
    expect(truncated.trees).toHaveLength(1);
    expect(truncated.dict.questionTypes).toHaveLength(1);
    expect(truncated.empty).toBe(false);
  });
});

describe('0029 截断与后置校验联动（深层回指必拦）', () => {
  it('AI 回指 depth≤4 清单内节点 → 通过；回指被截断的深层节点 → unknown-id', () => {
    const truncated = truncateSnapshotToDepth(makeSnapshot());

    const keep = validateAnchorSuggestions(
      JSON.stringify({
        suggestions: [{
          kind: 'tree-node', targetId: 'n-4', confidence: 0.9,
          evidence: [{ kind: 'question', questionId: 'q1' }, { kind: 'tree-node', nodeId: 'n-4' }],
        }],
      }),
      truncated,
    );
    expect(keep.accepted).toHaveLength(1);
    expect(keep.accepted[0]?.targetId).toBe('n-4');

    const deep = validateAnchorSuggestions(
      JSON.stringify({
        suggestions: [{
          kind: 'tree-node', targetId: 'n-5', confidence: 0.9,
          evidence: [{ kind: 'question', questionId: 'q1' }, { kind: 'tree-node', nodeId: 'n-5' }],
        }],
      }),
      truncated,
    );
    expect(deep.accepted).toHaveLength(0);
    expect(deep.failures).toHaveLength(1);
    expect(deep.failures[0]?.reason).toBe('unknown-id');
    expect(deep.failures[0]?.detail).toContain('n-5');
  });
});
