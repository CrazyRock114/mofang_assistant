// 0029：AI 建议管线宿主（AiSuggestHost）——快照→≤4 层截断→prompt 组装→ai.invoke→后置校验→按题归属。
// 覆盖任务书 §四：注入组装（≤4 层/路径压缩/NONE 文案/token 估算）、后置校验联动（清单外拦截/
// NONE 归一/evidence 缺字段拒绝）、批量按题归属（跨题同名建议不互删——逐题分组校验）、
// 空锚点禁放行、AI 不可用明示原因、打标链解析清洗。invoke 用注入假件（真桥 wire 见 probe-0029）。

import { describe, it, expect } from 'vitest';

import type { AnchorSnapshot, AnchorSnapshotService, AnchorQuery } from '../../src/shared/contracts/ai-anchor.js';
import type { Question } from '../../src/shared/contracts/bank-types.js';
import type { AiInvokePayload, AiInvokeResult } from '../../src/shared/contracts/ai-types.js';
import {
  AiSuggestHost, htmlToPromptText, questionPromptBlock, parseTagSuggestions,
  AI_SUGGEST_MAX_OUTPUT_TOKENS,
} from '../../src/shell/ai/suggest-host.js';
import { estimateAnchorTokens, serializeAnchorSnapshot } from '../../src/recog/anchor/index.js';
import { truncateSnapshotToDepth } from '../../src/recog/anchor/depth.js';

// ---------- 测试夹具 ----------

function makeSnapshot(overrides?: Partial<AnchorSnapshot>): AnchorSnapshot {
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
      { id: 'n-deep', treeId: 't1', path: ['物理', '力学', '摩擦力', '滑动摩擦', '系数测量'] },
    ],
    dict: {
      subjects: [{ id: 'subj:physics', kind: 'subject', code: 'physics', label: '物理' }],
      questionTypes: [{ id: 'qtype:single-choice', kind: 'question_type', code: 'single-choice', label: '单选题' }],
      difficulties: [{ id: 'diff:medium', kind: 'difficulty', code: 'medium', label: '中等' }],
    },
    empty: false,
    emptyReason: null,
    warnings: ['当前学段-学科下没有可锚定的树（测试警告透传）'],
    ...overrides,
  };
}

function makeQuestions(): Question[] {
  return [
    {
      id: 'q1', subject: '物理', sourceType: 'network',
      sourceDetail: { origin: 'test' },
      content: '<div class="question">如图，木块在水平面滑动，<span class="math" data-tex="F=\\mu mg"></span> 求摩擦力。</div>',
      images: [], createdAt: '2026-09-18T00:00:00Z', updatedAt: '2026-09-18T00:00:00Z',
    },
    {
      id: 'q2', subject: '物理', sourceType: 'local',
      sourceDetail: { origin: 'test' },
      content: '<div class="question">摩擦力方向判断 &lt;重点&gt;。</div>',
      images: [], createdAt: '2026-09-18T00:00:00Z', updatedAt: '2026-09-18T00:00:00Z',
    },
  ];
}

interface InvokeSpy {
  calls: AiInvokePayload[];
  respond: (payload: AiInvokePayload) => AiInvokeResult;
}

function makeDeps(opts?: {
  snapshot?: AnchorSnapshot;
  questions?: Record<string, Question | null>;
  invoke?: (spy: InvokeSpy) => (payload: AiInvokePayload) => Promise<AiInvokeResult>;
}) {
  const snapshot = opts?.snapshot ?? makeSnapshot();
  const questions = opts?.questions ?? Object.fromEntries(makeQuestions().map((q) => [q.id, q]));
  const spy: InvokeSpy = { calls: [], respond: () => ({ ok: false, error: '未脚本化', latencyMs: 0 }) };
  const snapshots: AnchorSnapshotService = { getAnchorSnapshot: async (_q: AnchorQuery) => snapshot };
  const invoke = opts?.invoke
    ? opts.invoke(spy)
    : async (payload: AiInvokePayload) => { spy.calls.push(payload); return spy.respond(payload); };
  const host = new AiSuggestHost({
    snapshots,
    invoke,
    getQuestion: async (id) => questions[id] ?? null,
  });
  return { host, spy, snapshot };
}

const QUERY = { stage: '初中', subjectId: 'subj:physics' };

/** 合法批量响应：q1→n-3（带置信度）、q2→n-3（跨题同名）、q1→n-2（无置信度）、外加被拦/越界/无主三类 */
function treeScript(): string {
  return JSON.stringify({
    suggestions: [
      { kind: 'tree-node', targetId: 'n-3', confidence: 0.9, evidence: [{ kind: 'question', questionId: 'q1' }, { kind: 'tree-node', nodeId: 'n-3' }] },
      { kind: 'tree-node', targetId: 'n-3', confidence: 0.8, evidence: [{ kind: 'question', questionId: 'q2' }, { kind: 'tree-node', nodeId: 'n-3' }] },
      { kind: 'tree-node', targetId: 'n-2', evidence: [{ kind: 'question', questionId: 'q1' }, { kind: 'tree-node', nodeId: 'n-2' }] },
      { kind: 'tree-node', targetId: 'n-deep', confidence: 0.7, evidence: [{ kind: 'question', questionId: 'q1' }, { kind: 'tree-node', nodeId: 'n-deep' }] },
      { kind: 'question-type', targetId: 'qtype:single-choice', evidence: [{ kind: 'question', questionId: 'q1' }, { kind: 'dict', entryId: 'qtype:single-choice' }] },
      { kind: 'tree-node', targetId: 'n-1', evidence: [{ kind: 'tree-node', nodeId: 'n-1' }] },
    ],
  });
}

// ---------- 纯函数：题面注入文本 ----------

describe('0029 题面注入文本（htmlToPromptText / questionPromptBlock）', () => {
  it('剥 HTML 标签、data-tex 转 $…$、解码常见实体、折叠空白', () => {
    const text = htmlToPromptText('<div class="question">如图，<span class="math" data-tex="F=\\mu mg"></span> 求 &lt;摩擦力&gt;&nbsp;大小。</div>');
    expect(text).toContain('$F=\\mu mg$');
    expect(text).toContain('<摩擦力>');
    expect(text).not.toContain('<div');
    expect(text).not.toContain('class=');
    expect(text).not.toMatch(/\s{2,}/);
  });

  it('超长题面截断到 maxChars 并加省略号（批量注入 token 有界）', () => {
    const long = '长'.repeat(2000);
    const text = htmlToPromptText(`<p>${long}</p>`, 100);
    expect(text.length).toBe(101); // 100 + …
    expect(text.endsWith('…')).toBe(true);
  });

  it('questionPromptBlock：逐题一行【题目 <id>】标记（AI 回指题号的唯一锚）', () => {
    const block = questionPromptBlock(makeQuestions());
    expect(block).toContain('【题目 q1】');
    expect(block).toContain('【题目 q2】');
    expect(block).toContain('$F=\\mu mg$');
  });
});

// ---------- 挂树建议链 ----------

describe('0029 suggestTree：注入组装与调用', () => {
  it('注入口径：role=reasoning、system 带 NONE 协议、user 含题块与截断后清单（深层节点不注入）、token 回执与预算口径一致', async () => {
    const { host, spy } = makeDeps({ invoke: (s) => async (p) => { s.calls.push(p); return { ok: true, content: 'NONE', latencyMs: 12, usage: { promptTokens: 100, completionTokens: 3, totalTokens: 103 } }; } });
    const result = await host.suggestTree({ questionIds: ['q1', 'q2'], query: QUERY });

    expect(result.none).toBe(true);
    expect(result.status).toBe('ok');
    expect(result.latencyMs).toBe(12);
    expect(result.usage?.totalTokens).toBe(103);

    expect(spy.calls).toHaveLength(1);
    const payload = spy.calls[0];
    expect(payload.role).toBe('reasoning');
    expect(payload.maxTokens).toBe(AI_SUGGEST_MAX_OUTPUT_TOKENS);
    const system = payload.messages[0];
    const user = payload.messages[1];
    expect(system.role).toBe('system');
    expect(String(system.content)).toContain('只能从锚点清单中选取 ID');
    expect(String(system.content)).toContain('NONE');
    const userText = String(user.content);
    expect(userText).toContain('【题目 q1】');
    expect(userText).toContain('【题目 q2】');
    expect(userText).toContain('n-3 | 物理 > 力学 > 摩擦力');
    expect(userText).toContain('n-4 | 物理 > 力学 > 摩擦力 > 滑动摩擦');
    expect(userText).not.toContain('n-deep');
    expect(userText).toContain('清单内没有匹配项时只输出 NONE');

    const truncated = truncateSnapshotToDepth(makeSnapshot());
    expect(result.meta.injectedTokens).toBe(estimateAnchorTokens(truncated));
    expect(result.meta.injectedTokens).toBeGreaterThan(0);
  });

  it('meta 回执：total=5 / injected=4 / truncated=1 / treeCount=1 / questionCount=2；截断提示入 warnings；原 warnings 透传', async () => {
    const { host } = makeDeps({ invoke: () => async () => ({ ok: true, content: 'NONE', latencyMs: 1 }) });
    const result = await host.suggestTree({ questionIds: ['q1', 'q2'], query: QUERY });
    expect(result.meta).toMatchObject({
      stage: '初中', subjectId: 'subj:physics', questionCount: 2,
      treeCount: 1, totalNodeCount: 5, injectedNodeCount: 4, truncatedNodeCount: 1,
    });
    expect(result.warnings).toContain('当前学段-学科下没有可锚定的树（测试警告透传）');
    expect(result.warnings.some((w) => w.includes('≤4 层') && w.includes('1'))).toBe(true);
  });

  it('payload 题集去重 + 缺题即拒（getQuestion null → 明确报错，不发起 AI 调用）', async () => {
    const { host, spy } = makeDeps({
      questions: { q1: makeQuestions()[0] },
      invoke: (s) => async (p) => { s.calls.push(p); return { ok: true, content: 'NONE', latencyMs: 1 }; },
    });
    const dedup = await host.suggestTree({ questionIds: ['q1', 'q1'], query: QUERY });
    expect(dedup.meta.questionCount).toBe(1);
    expect(spy.calls).toHaveLength(1);

    await expect(host.suggestTree({ questionIds: ['q1', 'q404'], query: QUERY }))
      .rejects.toThrow('q404');
    expect(spy.calls).toHaveLength(1); // 缺题在调用前即拒：不新增 AI 调用
  });
});

describe('0029 suggestTree：后置校验联动与按题归属', () => {
  it('批量归属：跨题同名建议（q1/q2→n-3）都保留；深层回指=validation 草稿；缺题引用=unattributed 草稿；题型建议=out-of-scope 草稿', async () => {
    const { host } = makeDeps({ invoke: () => async () => ({ ok: true, content: treeScript(), latencyMs: 20 }) });
    const result = await host.suggestTree({ questionIds: ['q1', 'q2'], query: QUERY });

    expect(result.status).toBe('ok');
    expect(result.none).toBe(false);
    // 跨题同名建议不互删（逐题分组校验，0024 的组内去重语义只作用于同题）
    expect(result.suggestions).toHaveLength(3);
    const q1 = result.suggestions.filter((s) => s.questionId === 'q1');
    const q2 = result.suggestions.filter((s) => s.questionId === 'q2');
    expect(q1.map((s) => s.targetId).sort()).toEqual(['n-2', 'n-3']);
    expect(q2.map((s) => s.targetId)).toEqual(['n-3']);
    expect(q1.find((s) => s.targetId === 'n-3')?.confidence).toBe(0.9);
    expect(q1.find((s) => s.targetId === 'n-2')?.confidence).toBeUndefined();
    // 展示路径来自注入清单
    expect(q2[0]?.targetLabel).toBe('物理 > 力学 > 摩擦力');
    expect(q2[0]?.evidenceSummary).toContain('题目 q2');
    expect(q2[0]?.evidenceSummary).toContain('摩擦力');

    expect(result.drafts).toHaveLength(3);
    const reasons = result.drafts.map((d) => d.source);
    expect(reasons.filter((r) => r === 'validation')).toHaveLength(1); // n-deep unknown-id
    expect(reasons.filter((r) => r === 'unattributed')).toHaveLength(1); // 无题目引用
    expect(reasons.filter((r) => r === 'out-of-scope')).toHaveLength(1); // question-type 不落库
    const deepDraft = result.drafts.find((d) => d.source === 'validation');
    expect(deepDraft?.failure?.reason).toBe('unknown-id');
    expect(deepDraft?.failure?.detail).toContain('n-deep');
    expect(result.duplicates).toHaveLength(0);
  });

  it('空锚点禁放行（P-11）：status=empty-anchor、不发起 AI 调用、原因透传引导语', async () => {
    const empty = makeSnapshot({
      trees: [], nodes: [],
      dict: { subjects: [], questionTypes: [], difficulties: [] },
      empty: true,
      emptyReason: '学段「初中」学科「subj:physics」下无树节点且字典锚为空：先跑 npm run collect:dict / collect:tree',
      warnings: [],
    });
    const { host, spy } = makeDeps({ snapshot: empty, invoke: (s) => async (p) => { s.calls.push(p); return { ok: true, content: 'NONE', latencyMs: 0 }; } });
    const result = await host.suggestTree({ questionIds: ['q1'], query: QUERY });
    expect(result.status).toBe('empty-anchor');
    expect(result.reason).toContain('先跑');
    expect(result.suggestions).toHaveLength(0);
    expect(spy.calls).toHaveLength(0);
  });

  it('AI 不可用明示原因（P-3）：ok:false → status=unavailable + 原因透传（不隐藏不静默）', async () => {
    const { host } = makeDeps({ invoke: () => async () => ({ ok: false, error: '角色 reasoning 未配置启用的模型档案（设置 → 模型配置中启用）', latencyMs: 5 }) });
    const result = await host.suggestTree({ questionIds: ['q1'], query: QUERY });
    expect(result.status).toBe('unavailable');
    expect(result.reason).toContain('未配置启用的模型档案');
    expect(result.latencyMs).toBe(5);
  });

  it('整篇解析失败落草稿（不静默丢弃）：parseError → validation 草稿带原文截断', async () => {
    const { host } = makeDeps({ invoke: () => async () => ({ ok: true, content: '模型废话'.repeat(100), latencyMs: 3 }) });
    const result = await host.suggestTree({ questionIds: ['q1'], query: QUERY });
    expect(result.suggestions).toHaveLength(0);
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]?.source).toBe('validation');
    expect(result.drafts[0]?.reason).toContain('不是合法 JSON');
    expect(result.drafts[0]?.raw.length).toBeLessThanOrEqual(201);
  });

  it('组内去重不静默：同题重复建议 → 首条保留 + duplicates 记录', async () => {
    const dup = JSON.stringify({
      suggestions: [
        { kind: 'tree-node', targetId: 'n-2', evidence: [{ kind: 'question', questionId: 'q1' }, { kind: 'tree-node', nodeId: 'n-2' }] },
        { kind: 'tree-node', targetId: 'n-2', evidence: [{ kind: 'question', questionId: 'q1' }, { kind: 'tree-node', nodeId: 'n-2' }] },
      ],
    });
    const { host } = makeDeps({ invoke: () => async () => ({ ok: true, content: dup, latencyMs: 1 }) });
    const result = await host.suggestTree({ questionIds: ['q1'], query: QUERY });
    expect(result.suggestions).toHaveLength(1);
    expect(result.duplicates).toEqual(['tree-node:n-2']);
  });

  it('evidence 越界拒绝（P-13）：带题引用但落点证据指向清单外 → validation 草稿（evidence-out-of-anchor）；空 evidence 条目无法归属 → unattributed 草稿（均可见不写入）', async () => {
    const bad = JSON.stringify({
      suggestions: [
        { kind: 'tree-node', targetId: 'n-2', evidence: [{ kind: 'question', questionId: 'q1' }, { kind: 'tree-node', nodeId: 'n-deep' }] },
        { kind: 'tree-node', targetId: 'n-1', evidence: [] },
      ],
    });
    const { host } = makeDeps({ invoke: () => async () => ({ ok: true, content: bad, latencyMs: 1 }) });
    const result = await host.suggestTree({ questionIds: ['q1'], query: QUERY });
    // 首条：题引用合法 → 分组 → 0024 校验器拦 evidence 越界
    expect(result.suggestions.filter((s) => s.targetId === 'n-2')).toHaveLength(0);
    const outOfAnchor = result.drafts.find((d) => d.failure?.reason === 'evidence-out-of-anchor');
    expect(outOfAnchor).toBeDefined();
    expect(outOfAnchor?.source).toBe('validation');
    // 次条：空 evidence 无题引用可归属 → unattributed 草稿（不静默丢弃）
    const unattr = result.drafts.find((d) => d.source === 'unattributed');
    expect(unattr?.raw).toContain('n-1');
  });

  it('序列化确定性：同一快照两次注入的 user 文本逐字节一致（缓存与预算实测前提）', async () => {
    const snapshot = makeSnapshot();
    expect(serializeAnchorSnapshot(truncateSnapshotToDepth(snapshot)))
      .toBe(serializeAnchorSnapshot(truncateSnapshotToDepth(snapshot)));
  });
});

// ---------- 打标建议链 ----------

describe('0029 suggestTags：解析清洗与归属', () => {
  it('合法批量：trim 清洗、逐题归属；外部题号=unattributed、空标签=validation、同题同签去重', async () => {
    const script = JSON.stringify({
      tags: [
        { questionId: 'q1', tag: ' 易错 ' },
        { questionId: 'q2', tag: '力学' },
        { questionId: 'q9', tag: '外部题' },
        { questionId: 'q1', tag: '   ' },
        { questionId: 'q1', tag: '易错' },
      ],
    });
    const { host } = makeDeps({ invoke: () => async () => ({ ok: true, content: script, latencyMs: 8 }) });
    const result = await host.suggestTags({ questionIds: ['q1', 'q2'], query: QUERY });

    expect(result.status).toBe('ok');
    expect(result.suggestions).toHaveLength(0);
    expect(result.tagSuggestions).toEqual([{ questionId: 'q1', tag: '易错' }, { questionId: 'q2', tag: '力学' }]);
    expect(result.duplicates).toEqual(['q1:易错']);
    expect(result.drafts.map((d) => d.source).sort()).toEqual(['unattributed', 'validation']);
  });

  it('超长标签拒收（>24 字）落 validation 草稿；NONE 合法输出（独立脚本两跑）', async () => {
    const longHost = makeDeps({ invoke: () => async () => ({ ok: true, content: JSON.stringify({ tags: [{ questionId: 'q1', tag: '长'.repeat(30) }] }), latencyMs: 1 }) });
    const long = await longHost.host.suggestTags({ questionIds: ['q1'], query: QUERY });
    expect(long.tagSuggestions).toHaveLength(0);
    expect(long.drafts[0]?.reason).toContain('超长');

    const noneHost = makeDeps({ invoke: () => async () => ({ ok: true, content: 'NONE', latencyMs: 1 }) });
    const none = await noneHost.host.suggestTags({ questionIds: ['q1'], query: QUERY });
    expect(none.none).toBe(true);
    expect(none.tagSuggestions).toHaveLength(0);
  });

  it('裸数组与代码块包裹容忍；畸形条目落草稿不抛裸异常', () => {
    const parsed = parseTagSuggestions(
      '```json\n[{"questionId":"q1","tag":"期中考"}]\n```',
      new Set(['q1']),
    );
    expect(parsed.tags).toEqual([{ questionId: 'q1', tag: '期中考' }]);

    const malformed = parseTagSuggestions('{"tags":["not-an-object", 42]}', new Set(['q1']));
    expect(malformed.tags).toHaveLength(0);
    expect(malformed.drafts).toHaveLength(2);
    expect(malformed.parseError).toBeNull();
  });

  it('parseTagSuggestions：非 JSON → parseError；NONE 大小写空白容忍', () => {
    expect(parseTagSuggestions('完全不是 JSON', new Set(['q1'])).parseError).toContain('JSON');
    expect(parseTagSuggestions(' none ', new Set(['q1'])).none).toBe(true);
  });
});

// ---------- 锚点状态回执 ----------

describe('0029 anchorStatus：空锚点禁放行预检（无 AI 调用）', () => {
  it('非空快照：ok + 注入口径回执；空快照：empty-anchor + 引导语；均不发起 invoke', async () => {
    const { host, spy } = makeDeps({ invoke: (s) => async (p) => { s.calls.push(p); return { ok: true, content: 'NONE', latencyMs: 0 }; } });
    const ok = await host.anchorStatus({ query: QUERY });
    expect(ok.status).toBe('ok');
    expect(ok.meta.injectedNodeCount).toBe(4);
    expect(ok.meta.questionCount).toBe(0);
    expect(spy.calls).toHaveLength(0);

    const empty = makeSnapshot({
      trees: [], nodes: [],
      dict: { subjects: [], questionTypes: [], difficulties: [] },
      empty: true, emptyReason: '无树且字典锚为空：先采集', warnings: [],
    });
    const host2 = new AiSuggestHost({
      snapshots: { getAnchorSnapshot: async () => empty },
      invoke: async () => ({ ok: true, content: 'NONE', latencyMs: 0 }),
      getQuestion: async () => null,
    });
    const status = await host2.anchorStatus({ query: QUERY });
    expect(status.status).toBe('empty-anchor');
    expect(status.reason).toContain('先采集');
  });
});

// ---------- 0040 P5.2：工作台草稿挂树建议 ----------

describe('0040 treeForDraft：草稿直跑锚点链（返工⑥ 空学科口径）', () => {
  it('学科缺省/空白 → 明确报「先选学科」，不发调用（不再让空快照回一句空锚点）', async () => {
    const invoked: AiInvokePayload[] = [];
    const { host } = makeDeps({ invoke: () => async (p) => { invoked.push(p); return { ok: true, content: 'NONE', latencyMs: 0 }; } });
    await expect(host.treeForDraft({ subjectId: '', stemText: '木块在水平面滑动' })).rejects.toThrow(/学科范围/);
    await expect(host.treeForDraft({ subjectId: '   ', stemText: '木块在水平面滑动' })).rejects.toThrow(/学科范围/);
    expect(invoked).toHaveLength(0);
  });

  it('题干为空 → 仍先报题干问题（空学科不掩盖更前置的错）', async () => {
    const { host } = makeDeps();
    await expect(host.treeForDraft({ subjectId: '', stemText: '  ' })).rejects.toThrow(/stemText/);
  });

  it('正例：草稿以 draft-1 参与 evidence 归属，建议照常产出', async () => {
    const { host } = makeDeps({
      invoke: () => async () => ({
        ok: true, latencyMs: 0,
        content: JSON.stringify({
          suggestions: [{
            kind: 'tree-node', targetId: 'n-3', confidence: 0.9,
            evidence: [{ kind: 'question', questionId: 'draft-1' }, { kind: 'tree-node', nodeId: 'n-3' }],
          }],
        }),
      }),
    });
    const result = await host.treeForDraft({ subjectId: 'subj:physics', stage: '初中', stemText: '木块在水平面滑动，求摩擦力' });
    expect(result.status).toBe('ok');
    expect(result.suggestions.map((s) => s.targetId)).toEqual(['n-3']);
    expect(result.suggestions[0]!.questionId).toBe('draft-1');
  });
});
