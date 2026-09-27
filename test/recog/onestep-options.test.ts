// 0040 返工④：选项结构化兜底（题干正文里的「A．… B．…」→ options 数组）。
// 反例优先：宁可让选项平铺在题干里（用户看得见、能自己改），也不许错拆改题面语义。

import { describe, it, expect } from 'vitest';

import { extractOptionsFromStem } from '../../src/recog/onestep/options.js';
import { parseOnestepResponse } from '../../src/recog/onestep/parse.js';
import { buildOnestepDrafts } from '../../src/recog/onestep/validate.js';

describe('0040 返工④：选项还原（extractOptionsFromStem）', () => {
  it('正例：换行分列 + 全角顿点（整卷扫描的常态）', () => {
    const stem = '下列判断正确的是（  ）\nA．浸在液体中的物体受到向上的浮力\nB．浮力的大小等于物体排开液体所受的重力\nC．浮力随深度增加而增大\nD．物体的体积越大浮力一定越大';
    const got = extractOptionsFromStem(stem);
    expect(got).not.toBeNull();
    expect(got!.stem).toBe('下列判断正确的是（  ）');
    expect(got!.options).toEqual([
      { label: 'A', content: '浸在液体中的物体受到向上的浮力' },
      { label: 'B', content: '浮力的大小等于物体排开液体所受的重力' },
      { label: 'C', content: '浮力随深度增加而增大' },
      { label: 'D', content: '物体的体积越大浮力一定越大' },
    ]);
  });

  it('正例：单行横排（A. … B. … D.）', () => {
    const stem = '下列说法正确的是（  ） A. 力是物体对物体的作用 B. 只有相互接触的物体才有力的作用 C. 力可以离开物体独立存在 D. 力的作用是相互的';
    const got = extractOptionsFromStem(stem);
    expect(got).not.toBeNull();
    expect(got!.stem).toBe('下列说法正确的是（  ）');
    expect(got!.options.map((o) => o.label)).toEqual(['A', 'B', 'C', 'D']);
    expect(got!.options[0]!.content).toBe('力是物体对物体的作用');
    expect(got!.options[3]!.content).toBe('力的作用是相互的');
  });

  it('正例：全角标号 Ａ．… Ｂ．…（中文卷面/OCR 常态）', () => {
    const got = extractOptionsFromStem('下列说法正确的是（  ）\nＡ．甲　Ｂ．乙　Ｃ．丙');
    expect(got).not.toBeNull();
    expect(got!.stem).toBe('下列说法正确的是（  ）');
    expect(got!.options).toEqual([
      { label: 'A', content: '甲' }, { label: 'B', content: '乙' }, { label: 'C', content: '丙' },
    ]);
  });

  it('正例：全角括号标号（A）… （B）…，公式原样留在选项内容里', () => {
    const stem = '下列各式中正确的是（  ）\n（A）$v = v_0 + at$\n（B）$s = \\frac{1}{2}at^2$\n（C）$a = vt$';
    const got = extractOptionsFromStem(stem);
    expect(got).not.toBeNull();
    expect(got!.options.map((o) => o.label)).toEqual(['A', 'B', 'C']);
    expect(got!.options[1]!.content).toBe('$s = \\frac{1}{2}at^2$');
  });

  it('反例：只有一个标号 → 不还原（正文里的孤例字母不算选项）', () => {
    expect(extractOptionsFromStem('如图 A．所示，物体沿斜面下滑')).toBeNull();
  });

  it('反例：标号不连续 → 不还原（半个选项块比没有更糟）', () => {
    expect(extractOptionsFromStem('题干 A．甲 C．丙')).toBeNull();
  });

  it('反例：从 B 起编号 → 不还原（链一定要从 A 起）', () => {
    expect(extractOptionsFromStem('题干 B．乙 C．丙 D．丁')).toBeNull();
  });

  it('反例：选项之前没有题干 → 不还原（拆完题干就空了，按规则①反而是坏数据）', () => {
    expect(extractOptionsFromStem('A．甲 B．乙 C．丙')).toBeNull();
  });

  it('反例：公式内部的「A. B.」不算选项标号（$…$ 内的字母一律跳过）', () => {
    // 去掉 inMath 守卫时这条会被读成 A/B 两个选项，因此它锁的是守卫本身
    expect(extractOptionsFromStem('化简 $2 A. x + 3 B. y$ 得（  ）')).toBeNull();
    expect(extractOptionsFromStem('已知点 $A．$ 与点 $B．$ 的距离为 3')).toBeNull();
  });

  it('反例：单项内容超长 → 不还原（说明把后文段落也吞进来了）', () => {
    const long = 'x'.repeat(500);
    expect(extractOptionsFromStem(`题干 A．${long} B．乙`)).toBeNull();
  });
});

describe('0040 返工④：进校验层（模型没给 options 时兜底，给了就不动）', () => {
  function draftsFrom(raw: string) {
    const parsed = parseOnestepResponse(raw);
    if (!parsed.ok) throw new Error(`fixture 不可解析：${parsed.reason}`);
    return buildOnestepDrafts({
      raw, parsed: parsed.value, pageNo: 1, figures: [], figureSource: 'none', figureWarnings: [],
    });
  }

  it('模型把选项写进题干 → 题干去选项行 + options 结构化 + 留痕告警', () => {
    const result = draftsFrom(JSON.stringify({
      questions: [{
        qno: '3',
        questionType: '单选',
        stemMarkdown: '下列判断正确的是（  ）\nA．甲\nB．乙\nC．丙\nD．丁',
        options: null,
        answerMarkdown: 'A',
        analysisMarkdown: null,
        suggestedTags: ['浮力'],
      }],
    }));
    const draft = result.drafts[0]!;
    expect(draft.stemMarkdown).toBe('下列判断正确的是（  ）');
    expect(draft.options).toEqual([
      { label: 'A', content: '甲' }, { label: 'B', content: '乙' },
      { label: 'C', content: '丙' }, { label: 'D', content: '丁' },
    ]);
    expect(draft.warnings.some((w) => w.includes('选项由题干正文还原'))).toBe(true);
    expect(draft.answerMarkdown).toBe('A');
  });

  it('模型给了结构化 options 且题干没有选项行 → 原样采用，题干不动', () => {
    const stem = '下列判断正确的是（  ）';
    const result = draftsFrom(JSON.stringify({
      questions: [{
        qno: '3', questionType: '单选', stemMarkdown: stem,
        options: [{ label: 'A', content: '模型给的甲' }, { label: 'B', content: '模型给的乙' }],
        answerMarkdown: null, analysisMarkdown: null, suggestedTags: [],
      }],
    }));
    const draft = result.drafts[0]!;
    expect(draft.options).toEqual([{ label: 'A', content: '模型给的甲' }, { label: 'B', content: '模型给的乙' }]);
    expect(draft.stemMarkdown).toBe(stem);
    expect(draft.warnings.some((w) => w.includes('选项由题干正文还原'))).toBe(false);
    expect(draft.warnings.some((w) => w.includes('选择题'))).toBe(false);
  });

  it('模型给了结构化 options、题干末尾又留了一份同样的选项行 → 去重（题卡里不显示两遍）', () => {
    const result = draftsFrom(JSON.stringify({
      questions: [{
        qno: '3', questionType: '单选',
        stemMarkdown: '下列判断正确的是（  ）\nA．甲\nB．乙',
        options: [{ label: 'A', content: '甲' }, { label: 'B', content: '乙' }],
        answerMarkdown: null, analysisMarkdown: null, suggestedTags: [],
      }],
    }));
    expect(result.drafts[0]!.stemMarkdown).toBe('下列判断正确的是（  ）');
    expect(result.drafts[0]!.options).toEqual([{ label: 'A', content: '甲' }, { label: 'B', content: '乙' }]);
  });

  it('题干里的选项行与结构化 options 标号不同 → 不动题干（只认逐个相同的重复尾巴）', () => {
    const stem = '下列判断正确的是（  ）\nC．丙\nD．丁';
    const result = draftsFrom(JSON.stringify({
      questions: [{
        qno: '3', questionType: '单选', stemMarkdown: stem,
        options: [{ label: 'A', content: '甲' }, { label: 'B', content: '乙' }],
        answerMarkdown: null, analysisMarkdown: null, suggestedTags: [],
      }],
    }));
    expect(result.drafts[0]!.stemMarkdown).toBe(stem);
  });

  it('选择题却没有选项 → 明确告警（模型可能用了本地认不出的选项形态）', () => {
    const result = draftsFrom(JSON.stringify({
      questions: [{
        qno: '5', questionType: '单选', stemMarkdown: '下列说法正确的是（  ）',
        options: null, answerMarkdown: null, analysisMarkdown: null, suggestedTags: [],
      }],
    }));
    expect(result.drafts[0]!.options).toBeNull();
    expect(result.drafts[0]!.warnings.some((w) => w.includes('选择题但没拿到选项'))).toBe(true);
  });

  it('还原不成立（无标号）→ 题干原样保留、options 仍为 null（不猜）', () => {
    const stem = '试证明浮力等于物体排开液体所受的重力。';
    const result = draftsFrom(JSON.stringify({
      questions: [{
        qno: '4', questionType: '解答', stemMarkdown: stem,
        options: null, answerMarkdown: null, analysisMarkdown: null, suggestedTags: [],
      }],
    }));
    expect(result.drafts[0]!.stemMarkdown).toBe(stem);
    expect(result.drafts[0]!.options).toBeNull();
  });
});
