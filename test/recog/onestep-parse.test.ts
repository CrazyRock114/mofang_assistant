// 0040 P1：一步到位响应解析测试（纯函数）。
// 覆盖 0042 实测失败模式：非法 JSON 转义（30b-think 的 `Invalid \escape`）、静默空数组、
// 围栏/杂文字/尾逗号等宽松形态；以及内联 grounding figures 的提取。

import { describe, it, expect } from 'vitest';

import {
  parseJsonLoose, parseOnestepResponse, repairInvalidEscapes, stripCodeFence, stripTrailingCommas,
} from '../../src/recog/onestep/parse.js';

describe('0040 P1：JSON 宽松解析', () => {
  it('标准 JSON 原样解析，无修复标记', () => {
    const result = parseJsonLoose('{"questions":[]}');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.escapeRepaired).toBe(false);
    expect(result.looseRepaired).toBe(false);
  });

  it('剥 Markdown 代码围栏后再解析', () => {
    const result = parseJsonLoose('```json\n{"questions":[{"qno":"17"}]}\n```');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(stripCodeFence('```json\n{}\n```')).toBe('{}');
  });

  it('前后杂文字（含模型自带标记）不干扰取最外层对象', () => {
    const result = parseOnestepResponse('<|begin_of_box|>{"questions":[{"qno":"2-17","questionType":"解答","stemMarkdown":"甲"}]}');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.questions).toHaveLength(1);
  });

  it('尾逗号兜底清理（首次 parse 失败后）', () => {
    const result = parseJsonLoose('{"questions":[{"qno":"17",},],}');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.looseRepaired).toBe(true);
    const commas = stripTrailingCommas('{"a":1,}');
    expect(commas.repaired).toBe(true);
    expect(commas.text).toBe('{"a":1}');
  });

  it('LaTeX 反斜杠非法转义被修复（0042 失败模式②）', () => {
    // 原始文本里是单个反斜杠（非法 JSON 转义），修复后双反斜杠
    const broken = '{"questions":[{"qno":"1","stemMarkdown":"求 \\alpha 与 \\beta"}]}';
    expect(() => JSON.parse(broken)).toThrow();
    const repaired = repairInvalidEscapes(broken);
    expect(repaired.repaired).toBe(true);
    const result = parseJsonLoose(broken);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.escapeRepaired).toBe(true);
  });

  it('合法转义不被误改（\\n / \\" / \\\\ / \\u4e2d）', () => {
    const good = '{"a":"line\\nbreak \\"q\\" \\\\ \\u4e2d"}';
    const repaired = repairInvalidEscapes(good);
    expect(repaired.repaired).toBe(false);
    expect(repaired.text).toBe(good);
  });

  it('\\u 后不足四位十六进制按非法转义修复', () => {
    const bad = '{"a":"\\u12"}';
    const repaired = repairInvalidEscapes(bad);
    expect(repaired.repaired).toBe(true);
  });

  it('无花括号 / 空内容 → 明确失败原因（不静默）', () => {
    expect(parseJsonLoose('   ').ok).toBe(false);
    expect(parseJsonLoose('hello world').ok).toBe(false);
  });

  it('顶层缺 questions 数组 → 结构性失败', () => {
    const result = parseOnestepResponse('{"items":[]}');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('questions');
  });

  it('questions 为空数组是「结构合法、内容为空」（由校验层规则①拒绝）', () => {
    const result = parseOnestepResponse('{\n  "questions": []\n}');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.questions).toHaveLength(0);
  });

  it('内联 grounding：顶层 figures 的 bboxNorm 被提取（0-999 口径）', () => {
    const raw = JSON.stringify({
      questions: [{ qno: '1', stemMarkdown: '如图[图1]' }],
      figures: [{ ref: '图1', bboxNorm: [100, 200, 300, 400] }],
    });
    const result = parseOnestepResponse(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.inlineFigures).toEqual([{ ref: '图1', bbox999: [100, 200, 300, 400] }]);
  });

  it('内联 grounding：坏框（缺值/非数值/长度不足）被丢弃', () => {
    const raw = JSON.stringify({
      questions: [],
      figures: [
        { ref: '图1', bboxNorm: [1, 2, 3] },
        { ref: '图2', bboxNorm: [1, 2, 'x', 4] },
        { ref: '', bboxNorm: [1, 2, 3, 4] },
        { ref: '图3', bboxNorm: [1, 2, 3, 4] },
      ],
    });
    const result = parseOnestepResponse(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.inlineFigures).toEqual([{ ref: '图3', bbox999: [1, 2, 3, 4] }]);
  });
});
