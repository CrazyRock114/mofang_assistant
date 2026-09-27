// 0024 P2：锚点注入组装 + 后置校验（纯函数）——路径压缩序列化 / NONE 协议 prompt / 清单外拦截
// 对抗用例（任务书 §四）全含：伪造 ID 必拦 / NONE 识别 / 重复去重 / 畸形输出结构化失败不抛裸异常 /
// evidence 缺失或越界必拦。

import { describe, it, expect } from 'vitest';

import type { AnchorSnapshot } from '../../src/shared/contracts/ai-anchor.js';
import { serializeAnchorSnapshot, serializeAnchorNodes, serializeAnchorDict } from '../../src/recog/anchor/serialize.js';
import { buildAnchorPrompt, NONE_TOKEN } from '../../src/recog/anchor/prompt.js';
import { validateAnchorSuggestions } from '../../src/recog/anchor/validate.js';
import { estimateTokens } from '../../src/recog/anchor/budget.js';

function makeSnapshot(): AnchorSnapshot {
  return {
    query: { stage: '初中', subjectId: 'subj:physics' },
    trees: [{
      id: 't1', name: '组卷网·知识点·初中物理', type: 'knowledge',
      stage: '初中', subjectKey: 'physics',
    }],
    nodes: [
      { id: 'n-1', treeId: 't1', path: ['力学', '摩擦力'] },
      { id: 'n-2', treeId: 't1', path: ['电学'] },
    ],
    dict: {
      subjects: [{ id: 'subj:physics', kind: 'subject', code: 'physics', label: '物理' }],
      questionTypes: [{ id: 'qtype:single-choice', kind: 'question_type', code: 'single-choice', label: '单选题' }],
      difficulties: [{ id: 'diff:medium', kind: 'difficulty', code: 'medium', label: '中等' }],
    },
    empty: false,
    emptyReason: null,
    warnings: [],
  };
}

function emptySnapshot(): AnchorSnapshot {
  return {
    query: { stage: '初中', subjectId: 'chemistry' },
    trees: [],
    nodes: [],
    dict: { subjects: [], questionTypes: [], difficulties: [] },
    empty: true,
    emptyReason: '学段「初中」学科「chemistry」无树且字典锚为空：先跑 npm run collect:dict / collect:tree',
    warnings: [],
  };
}

/** 一条合法建议（tree-node 回指 n-1，evidence 同指） */
function goodSuggestionRaw(): string {
  return JSON.stringify({
    suggestions: [{
      kind: 'tree-node',
      targetId: 'n-1',
      confidence: 0.86,
      evidence: [{ kind: 'tree-node', nodeId: 'n-1' }],
    }],
  });
}

describe('0024 P2 路径压缩序列化', () => {
  it('节点行格式 = `节点ID | 一级 > 二级`（只给路径+ID，不给描述）', () => {
    const text = serializeAnchorNodes(makeSnapshot());
    expect(text).toContain('n-1 | 力学 > 摩擦力');
    expect(text).toContain('n-2 | 电学');
    const nodeLines = text.split('\n').filter((l) => l.startsWith('n-'));
    expect(nodeLines).toHaveLength(2);
    for (const line of nodeLines) {
      expect(line).toMatch(/^n-\d \| .+$/);
    }
  });

  it('字典腿按 kind 分节，行格式 = `ID | 名称`', () => {
    const text = serializeAnchorDict(makeSnapshot());
    expect(text).toContain('subj:physics | 物理');
    expect(text).toContain('qtype:single-choice | 单选题');
    expect(text).toContain('diff:medium | 中等');
  });

  it('整篇含树标题 + 空腿不输出空节；序列化是确定性的（两次结果一致）', () => {
    const snap = makeSnapshot();
    const a = serializeAnchorSnapshot(snap);
    const b = serializeAnchorSnapshot(snap);
    expect(a).toBe(b);
    expect(a).toContain('组卷网·知识点·初中物理');
    expect(a).toContain('n-1 | 力学 > 摩擦力');

    // 空快照：不输出任何锚点行（调用方不得据此放行 AI）
    const empty = serializeAnchorSnapshot(emptySnapshot());
    expect(empty.split('\n').filter((l) => l.includes(' | '))).toHaveLength(0);
  });
});

describe('0024 P2 NONE 协议 prompt 模板', () => {
  it('system 明示「只能从清单选取 ID，清单外一律 NONE」+ 输出格式', () => {
    const prompt = buildAnchorPrompt({ snapshot: makeSnapshot(), task: '为下列题目建议挂树节点' });
    expect(NONE_TOKEN).toBe('NONE');
    expect(prompt.system).toContain('NONE');
    expect(prompt.system).toContain('锚点清单');
    expect(prompt.system).toContain('suggestions');
    expect(prompt.system).toContain('evidence');
    expect(prompt.user).toContain('为下列题目建议挂树节点');
    expect(prompt.user).toContain('n-1 | 力学 > 摩擦力');
  });

  it('空锚点拒绝构建 prompt（P-11：空锚点=必然编词，不得放行 AI）', () => {
    expect(() => buildAnchorPrompt({ snapshot: emptySnapshot(), task: '挂树' })).toThrow(/空/);
  });

  it('分层注入：接口在位、未实现即明确报错（不静默回落全量）', () => {
    expect(() => buildAnchorPrompt({ snapshot: makeSnapshot(), task: '挂树', strategy: 'layered' }))
      .toThrow(/未实现|V-6/);
  });
});

describe('0024 P2 后置校验器（对抗用例）', () => {
  const snap = makeSnapshot();

  it('合法建议：通过并保留 evidence/confidence', () => {
    const res = validateAnchorSuggestions(goodSuggestionRaw(), snap);
    expect(res.ok).toBe(true);
    expect(res.parseError).toBeNull();
    expect(res.none).toBe(false);
    expect(res.failures).toEqual([]);
    expect(res.accepted).toHaveLength(1);
    expect(res.accepted[0]!.targetId).toBe('n-1');
    expect(res.accepted[0]!.confidence).toBe(0.86);
    expect(res.accepted[0]!.evidence).toEqual([{ kind: 'tree-node', nodeId: 'n-1' }]);
  });

  it('markdown 代码块包裹的 JSON 可解析', () => {
    const res = validateAnchorSuggestions('```json\n' + goodSuggestionRaw() + '\n```', snap);
    expect(res.ok).toBe(true);
    expect(res.accepted).toHaveLength(1);
  });

  it('NONE 正确识别（大小写/空白容忍）：合法输出而非失败', () => {
    for (const raw of ['NONE', ' none \n', 'None']) {
      const res = validateAnchorSuggestions(raw, snap);
      expect(res.none).toBe(true);
      expect(res.ok).toBe(true);
      expect(res.parseError).toBeNull();
      expect(res.accepted).toEqual([]);
      expect(res.failures).toEqual([]);
    }
  });

  it('清单外伪造节点 ID 必被拦（不静默丢弃：出失败项明细 + 原始条目）', () => {
    const raw = JSON.stringify({
      suggestions: [{ kind: 'tree-node', targetId: 'n-999-编造', evidence: [{ kind: 'tree-node', nodeId: 'n-1' }] }],
    });
    const res = validateAnchorSuggestions(raw, snap);
    expect(res.ok).toBe(false);
    expect(res.accepted).toEqual([]);
    expect(res.failures).toHaveLength(1);
    expect(res.failures[0]!.reason).toBe('unknown-id');
    expect(res.failures[0]!.detail).toContain('n-999-编造');
    expect(res.failures[0]!.raw).toContain('n-999-编造');
    expect(res.failures[0]!.index).toBe(0);
  });

  it('字典腿白名单按 kind 分治：题型 ID 用于 question-type 通过，用于 difficulty 被拦', () => {
    const ok = validateAnchorSuggestions(JSON.stringify({
      suggestions: [{ kind: 'question-type', targetId: 'qtype:single-choice', evidence: [{ kind: 'dict', entryId: 'qtype:single-choice' }] }],
    }), snap);
    expect(ok.ok).toBe(true);

    const bad = validateAnchorSuggestions(JSON.stringify({
      suggestions: [{ kind: 'difficulty', targetId: 'qtype:single-choice', evidence: [{ kind: 'dict', entryId: 'diff:medium' }] }],
    }), snap);
    expect(bad.ok).toBe(false);
    expect(bad.failures[0]!.reason).toBe('unknown-id');
  });

  it('重复 ID 去重：保留首条 + duplicates 记录被丢项（不静默）', () => {
    const raw = JSON.stringify({
      suggestions: [
        { kind: 'tree-node', targetId: 'n-1', confidence: 0.9, evidence: [{ kind: 'tree-node', nodeId: 'n-1' }] },
        { kind: 'tree-node', targetId: 'n-1', confidence: 0.4, evidence: [{ kind: 'tree-node', nodeId: 'n-2' }] },
      ],
    });
    const res = validateAnchorSuggestions(raw, snap);
    expect(res.ok).toBe(true);
    expect(res.accepted).toHaveLength(1);
    expect(res.accepted[0]!.confidence).toBe(0.9);
    expect(res.duplicates).toEqual(['tree-node:n-1']);
  });

  it('畸形输出：非 JSON / 缺 suggestions / 顶层非对象 → 结构化失败，不抛裸异常', () => {
    const cases = ['这不是 JSON', '{', '"NONE 但带引号"', '{"answer":[]}', '123'];
    for (const raw of cases) {
      const res = validateAnchorSuggestions(raw, snap);
      expect(res.ok).toBe(false);
      expect(res.parseError).toBeTruthy();
      expect(res.accepted).toEqual([]);
      expect(res.none).toBe(false);
    }
  });

  it('裸数组顶层：按建议数组校验（容忍模型只回数组）', () => {
    const res = validateAnchorSuggestions(JSON.stringify([
      { kind: 'tree-node', targetId: 'n-2', evidence: [{ kind: 'tree-node', nodeId: 'n-2' }] },
    ]), snap);
    expect(res.ok).toBe(true);
    expect(res.accepted[0]!.targetId).toBe('n-2');
  });

  it('evidence 缺失/为空 → missing-evidence；evidence 指向清单外 → evidence-out-of-anchor', () => {
    const missing = validateAnchorSuggestions(JSON.stringify({
      suggestions: [{ kind: 'tree-node', targetId: 'n-1' }],
    }), snap);
    expect(missing.failures[0]!.reason).toBe('missing-evidence');

    const empty = validateAnchorSuggestions(JSON.stringify({
      suggestions: [{ kind: 'tree-node', targetId: 'n-1', evidence: [] }],
    }), snap);
    expect(empty.failures[0]!.reason).toBe('missing-evidence');

    const outside = validateAnchorSuggestions(JSON.stringify({
      suggestions: [{ kind: 'tree-node', targetId: 'n-1', evidence: [{ kind: 'tree-node', nodeId: 'n-999' }] }],
    }), snap);
    expect(outside.failures[0]!.reason).toBe('evidence-out-of-anchor');
    expect(outside.failures[0]!.detail).toContain('n-999');
  });

  it('evidence 形态非法（kind 未知/缺 id 字段）→ evidence-out-of-anchor；题号/数据行 evidence 结构合法即通过', () => {
    const badKind = validateAnchorSuggestions(JSON.stringify({
      suggestions: [{ kind: 'tree-node', targetId: 'n-1', evidence: [{ kind: 'guess', nodeId: 'n-1' }] }],
    }), snap);
    expect(badKind.failures[0]!.reason).toBe('evidence-out-of-anchor');

    const question = validateAnchorSuggestions(JSON.stringify({
      suggestions: [{
        kind: 'tree-node', targetId: 'n-1',
        evidence: [{ kind: 'question', questionId: 'q-42' }, { kind: 'data-row', source: 'exam_scores', rowId: 'row-1' }],
      }],
    }), snap);
    expect(question.ok).toBe(true);
    expect(question.accepted[0]!.evidence).toHaveLength(2);
  });

  it('条目结构畸形（非对象/缺 kind/缺 targetId/非法 confidence）→ bad-shape 且逐条报', () => {
    const raw = JSON.stringify({
      suggestions: [
        'n-1',
        { targetId: 'n-1', evidence: [{ kind: 'tree-node', nodeId: 'n-1' }] },
        { kind: 'tree-node', evidence: [{ kind: 'tree-node', nodeId: 'n-1' }] },
        { kind: 'tree-node', targetId: 'n-1', confidence: 'high', evidence: [{ kind: 'tree-node', nodeId: 'n-1' }] },
        { kind: 'unknown-kind', targetId: 'n-1', evidence: [{ kind: 'tree-node', nodeId: 'n-1' }] },
      ],
    });
    const res = validateAnchorSuggestions(raw, snap);
    expect(res.ok).toBe(false);
    expect(res.failures.map((f) => f.reason)).toEqual(['bad-shape', 'bad-shape', 'bad-shape', 'bad-shape', 'bad-shape']);
    expect(res.failures.map((f) => f.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it('坑外建议不因同批中合法项而放行：混合批 = 合法进 accepted、非法进 failures', () => {
    const raw = JSON.stringify({
      suggestions: [
        { kind: 'tree-node', targetId: 'n-2', evidence: [{ kind: 'tree-node', nodeId: 'n-2' }] },
        { kind: 'tree-node', targetId: '编造节点', evidence: [{ kind: 'tree-node', nodeId: '编造节点' }] },
      ],
    });
    const res = validateAnchorSuggestions(raw, snap);
    expect(res.accepted.map((s) => s.targetId)).toEqual(['n-2']);
    expect(res.failures).toHaveLength(1);
    expect(res.failures[0]!.reason).toBe('unknown-id');
    expect(res.ok).toBe(false);
  });
});

describe('0024 P4 token 估算（保守口径）', () => {
  it('CJK 按 1 token/字、其他按 4 字符/token，向上取整（两腿都取保守方向）', () => {
    // '力学 > 摩擦力'：CJK 5 字 + 非 CJK 3 字符 → 5 + 0.75 → 6
    expect(estimateTokens('力学 > 摩擦力')).toBe(6);
    expect(estimateTokens('abcde')).toBe(2); // 5/4 → 向上取整 2（ASCII 侧亦保守）
    expect(estimateTokens('')).toBe(0);
  });

  it('估算单调：序列化全文估算 ≥ 单行估算之和（用于预算判定）', () => {
    const snap = makeSnapshot();
    const whole = estimateTokens(serializeAnchorSnapshot(snap));
    const parts = estimateTokens(serializeAnchorNodes(snap)) + estimateTokens(serializeAnchorDict(snap));
    expect(whole).toBeGreaterThanOrEqual(parts);
  });
});
