// 0040 P1：校验层六条规则测试（每条一反一正）。
// 规则来源：0042 纪要 §七/§9.3（实测失败模式反推）。
//   ① empty-output     空数组/空串拒绝
//   ② bad-json-escape  JSON 坏转义修复留痕
//   ③ subquestion-split 小题不拆分结构校验（非阻断）
//   ④ proof-answer-null 试证/证明题答案强制置空
//   ⑤ budget-exhausted 预算耗尽识别 + 提预算重试口径
//   ⑥ thinking-switch  思考开关按模型能力配置（provider/网关侧，见 onestep-provider 与 ai-thinking 测试）

import { describe, it, expect } from 'vitest';

import { parseOnestepResponse } from '../../src/recog/onestep/parse.js';
import {
  assignFigures, buildOnestepDrafts, detectSubquestionSplit, nextBudgetRetry,
  ONESTEP_BUDGET_RETRY_MAX_TOKENS, ONESTEP_RULE_IDS, shouldNullAnswer,
} from '../../src/recog/onestep/validate.js';
import type { OnestepFigure } from '../../src/shared/contracts/onestep-types.js';

function draftsFrom(raw: string, figures: OnestepFigure[] = []) {
  const parsed = parseOnestepResponse(raw);
  if (!parsed.ok) throw new Error(`fixture 不可解析：${parsed.reason}`);
  return buildOnestepDrafts({
    raw,
    parsed: parsed.value,
    pageNo: 1,
    figures,
    figureSource: figures.length > 0 ? 'dso' : 'none',
    figureWarnings: [],
  });
}

describe('0040 P1 规则①：空数组/空串拒绝', () => {
  it('反例：空串 → 硬失败且判为预算耗尽（retry=budget）', () => {
    const parsed = parseOnestepResponse('{"questions":[]}');
    if (!parsed.ok) throw new Error('fixture');
    const result = buildOnestepDrafts({
      raw: '   ', parsed: parsed.value, pageNo: 1, figures: [], figureSource: 'none', figureWarnings: [],
    });
    expect(result.drafts).toEqual([]);
    expect(result.failure).toContain('预算耗尽');
    expect(result.retry).toBe('budget');
  });

  it('反例：合规空数组（32b-Instruct 形态）→ 硬失败 retry=model', () => {
    const result = draftsFrom('{\n  "questions": []\n}');
    expect(result.drafts).toEqual([]);
    expect(result.failure).toContain('空题目数组');
    expect(result.retry).toBe('model');
  });

  it('正例：一题正常返回 → 无失败、不重试', () => {
    const result = draftsFrom(JSON.stringify({
      questions: [{ qno: '17', questionType: '单选', stemMarkdown: '题干', options: [{ label: 'A', content: '1 N' }], answerMarkdown: 'A', analysisMarkdown: null, suggestedTags: ['浮力'] }],
    }));
    expect(result.failure).toBeNull();
    expect(result.retry).toBe('none');
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]!.qno).toBe('17');
    expect(result.drafts[0]!.options).toEqual([{ label: 'A', content: '1 N' }]);
    expect(result.drafts[0]!.analysisMarkdown).toBeNull();
    expect(result.drafts[0]!.suggestedTags).toEqual(['浮力']);
  });
});

describe('0040 P1 规则②：JSON 坏转义修复留痕', () => {
  it('反例：坏转义修复后解析成功 → 页级告警留痕（不静默）', () => {
    const raw = '{"questions":[{"qno":"1","questionType":"解答","stemMarkdown":"求 \\alpha 的值"}]}';
    const result = draftsFrom(raw);
    expect(result.failure).toBeNull();
    expect(result.warnings.some((w) => w.includes('非法 JSON 转义'))).toBe(true);
    expect(result.drafts[0]!.stemMarkdown).toContain('\\alpha');
  });

  it('正例：转义合法 → 无该告警', () => {
    const raw = JSON.stringify({ questions: [{ qno: '1', questionType: '解答', stemMarkdown: '求 \\alpha 的值' }] });
    const result = draftsFrom(raw);
    expect(result.failure).toBeNull();
    expect(result.warnings.some((w) => w.includes('非法 JSON 转义'))).toBe(false);
  });
});

describe('0040 P1 规则③：小题不拆分结构校验（非阻断）', () => {
  it('反例：同基号小序号重复（2-1 / 2-2）→ 判为疑似小题被拆', () => {
    const parsed = parseOnestepResponse(JSON.stringify({
      questions: [
        { qno: '2-1', stemMarkdown: '（1）第一问' },
        { qno: '2-2', stemMarkdown: '（2）第二问' },
      ],
    }));
    if (!parsed.ok) throw new Error('fixture');
    expect(detectSubquestionSplit(parsed.value.questions)).toContain('疑似小题被拆');
    const result = draftsFrom(JSON.stringify({
      questions: [
        { qno: '2-1', questionType: '解答', stemMarkdown: '（1）第一问' },
        { qno: '2-2', questionType: '解答', stemMarkdown: '（2）第二问' },
      ],
    }));
    // 非阻断：草稿照出，只挂核验提示
    expect(result.failure).toBeNull();
    expect(result.drafts).toHaveLength(2);
    expect(result.warnings.some((w) => w.includes('疑似小题被拆'))).toBe(true);
  });

  it('正例：同章连续题号（2-17 / 2-18）不误判', () => {
    const parsed = parseOnestepResponse(JSON.stringify({
      questions: [{ qno: '2-17' }, { qno: '2-18' }, { qno: '2-19' }],
    }));
    if (!parsed.ok) throw new Error('fixture');
    expect(detectSubquestionSplit(parsed.value.questions)).toBeNull();
  });

  it('反例：同页重复题号 → 判为疑似拆分', () => {
    const parsed = parseOnestepResponse(JSON.stringify({ questions: [{ qno: '3-1' }, { qno: '3-1' }] }));
    if (!parsed.ok) throw new Error('fixture');
    expect(detectSubquestionSplit(parsed.value.questions)).toContain('重复题号');
  });

  it('正例：单题页面不做判定', () => {
    const parsed = parseOnestepResponse(JSON.stringify({ questions: [{ qno: '2-1' }] }));
    if (!parsed.ok) throw new Error('fixture');
    expect(detectSubquestionSplit(parsed.value.questions)).toBeNull();
  });
});

describe('0040 P1 规则④：试证/证明题答案强制置空', () => {
  it('反例：含「试证」且模型给了答案 → 答案清空 + 告警', () => {
    const result = draftsFrom(JSON.stringify({
      questions: [{
        qno: '2-17', questionType: '解答',
        stemMarkdown: '假定炮弹出口速度相同，空气阻力不计，试证击中目的物的适当仰角应为 $\\theta$',
        answerMarkdown: '$\\frac{1}{2}\\arcsin(\\cdot)$',
      }],
    }));
    expect(result.drafts[0]!.answerMarkdown).toBeNull();
    expect(result.drafts[0]!.warnings.some((w) => w.includes('证明'))).toBe(true);
  });

  it('正例：普通题答案保留', () => {
    const result = draftsFrom(JSON.stringify({
      questions: [{ qno: '1', questionType: '单选', stemMarkdown: '物体受到的浮力为（ ）', answerMarkdown: 'B' }],
    }));
    expect(result.drafts[0]!.answerMarkdown).toBe('B');
    expect(shouldNullAnswer('物体受到的浮力为（ ）')).toBe(false);
    expect(shouldNullAnswer('请证明该式成立')).toBe(true);
  });

  it('正例：证明题但模型没给答案 → 不产生无谓告警', () => {
    const result = draftsFrom(JSON.stringify({
      questions: [{ qno: '1', questionType: '解答', stemMarkdown: '试证：三角形内角和为 180°', answerMarkdown: null }],
    }));
    expect(result.drafts[0]!.answerMarkdown).toBeNull();
    expect(result.drafts[0]!.warnings.some((w) => w.includes('强制清空'))).toBe(false);
  });
});

describe('0040 P1 规则⑤：预算耗尽识别与重试口径', () => {
  it('反例：首次参（思考开、预算 4096）→ 关思考 + 预算**翻倍**（不一步到顶）', () => {
    const next = nextBudgetRetry({ thinking: 'enabled', maxTokens: 4096 });
    expect(next).toEqual({ thinking: 'disabled', maxTokens: 8192 });
  });

  it('逐级翻倍到上限：8192 → 16384', () => {
    expect(nextBudgetRetry({ thinking: 'disabled', maxTokens: 8192 })).toEqual({
      thinking: 'disabled', maxTokens: ONESTEP_BUDGET_RETRY_MAX_TOKENS,
    });
  });

  it('正例：已关思考且预算已到位 → 不再重试（返回 null，交给上层报错）', () => {
    expect(nextBudgetRetry({ thinking: 'disabled', maxTokens: ONESTEP_BUDGET_RETRY_MAX_TOKENS })).toBeNull();
  });

  it('已关思考且预算不足 → 仍翻倍（不越过上限）', () => {
    expect(nextBudgetRetry({ thinking: 'disabled', maxTokens: 4096 })).toEqual({ thinking: 'disabled', maxTokens: 8192 });
    expect(nextBudgetRetry({ thinking: 'disabled', maxTokens: 12288 })).toEqual({
      thinking: 'disabled', maxTokens: ONESTEP_BUDGET_RETRY_MAX_TOKENS,
    });
  });
});

describe('0040 P1：题内 [图N] 与页级图块的逐题分配', () => {
  const pageFigures: OnestepFigure[] = [
    { ref: '图1', bbox: [0.1, 0.1, 0.3, 0.3] },
    { ref: '图2', bbox: [0.4, 0.4, 0.6, 0.6] },
    { ref: '图3', bbox: [0.5, 0.5, 0.7, 0.7] },
  ];

  it('单题页：占位符各取对应编号图块，未被引用的图块显式告警', () => {
    const result = assignFigures([{ stemMarkdown: '如图[图1]与[图2]' }], pageFigures);
    expect(result.perDraft[0]!.map((f) => f.ref)).toEqual(['图1', '图2']);
    expect(result.warnings.some((w) => w.includes('未被引用的图块未分配'))).toBe(true);
  });

  it('无占位符的题不分配图块', () => {
    const result = assignFigures([{ stemMarkdown: '无图题' }], pageFigures);
    expect(result.perDraft[0]).toEqual([]);
  });

  it('全局编号（跨题唯一）：[图N] 一一对应页级第 N 张图块', () => {
    const result = assignFigures(
      [{ stemMarkdown: '甲[图1]' }, { stemMarkdown: '乙[图3]' }],
      pageFigures,
    );
    expect(result.perDraft[0]!.map((f) => f.ref)).toEqual(['图1']);
    expect(result.perDraft[1]!.map((f) => f.ref)).toEqual(['图3']);
    expect(result.warnings.some((w) => w.includes('只引用了 2 个'))).toBe(true);
  });

  it('题内编号（跨题重复 N）：按题序窗口切分并提示逐题核对', () => {
    const result = assignFigures(
      [{ stemMarkdown: '甲[图1]' }, { stemMarkdown: '乙[图1]' }],
      pageFigures,
    );
    expect(result.perDraft[0]![0]!.ref).toBe('图1');
    expect(result.perDraft[1]![0]!.ref).toBe('图2');
    expect(result.warnings.some((w) => w.includes('按题序窗口切分'))).toBe(true);
  });
});

describe('0040 P1：字段归一化与规则 id 口径', () => {
  it('题型不在枚举内 → 回落「解答」并告警', () => {
    const result = draftsFrom(JSON.stringify({
      questions: [{ qno: '1', questionType: '实验探究题', stemMarkdown: '甲' }],
    }));
    expect(result.drafts[0]!.questionType).toBe('解答');
    expect(result.drafts[0]!.warnings.some((w) => w.includes('不在枚举内'))).toBe(true);
  });

  it('qno 为 "null" 字符串 / 空串 → 归一为 null（不产出假题号）', () => {
    const result = draftsFrom(JSON.stringify({
      questions: [
        { qno: 'null', questionType: '解答', stemMarkdown: '甲' },
        { qno: '  ', questionType: '解答', stemMarkdown: '乙' },
      ],
    }));
    expect(result.drafts[0]!.qno).toBeNull();
    expect(result.drafts[1]!.qno).toBeNull();
  });

  it('空答案串归一为 null（0042 null 纪律）', () => {
    const result = draftsFrom(JSON.stringify({
      questions: [{ qno: '1', questionType: '解答', stemMarkdown: '甲', answerMarkdown: '   ' }],
    }));
    expect(result.drafts[0]!.answerMarkdown).toBeNull();
  });

  it('选项无效（空数组/缺 content）→ null 并告警', () => {
    const result = draftsFrom(JSON.stringify({
      questions: [{ qno: '1', questionType: '单选', stemMarkdown: '甲', options: [] }],
    }));
    expect(result.drafts[0]!.options).toBeNull();
    expect(result.drafts[0]!.warnings.some((w) => w.includes('options'))).toBe(true);
  });

  it('标签去重且上限 8', () => {
    const tags = ['a', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
    const result = draftsFrom(JSON.stringify({
      questions: [{ qno: '1', questionType: '解答', stemMarkdown: '甲', suggestedTags: tags }],
    }));
    expect(result.drafts[0]!.suggestedTags).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  });

  it('六条规则 id 齐备（口径锁定，防漂移）', () => {
    expect([...ONESTEP_RULE_IDS]).toEqual([
      'empty-output', 'bad-json-escape', 'subquestion-split', 'proof-answer-null',
      'budget-exhausted', 'thinking-switch',
    ]);
  });
});
