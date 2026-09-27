// 0056 目检返工④：公式识别质量闸门（清洗 / 幻觉拦截 / SVG 骨架否定式校验）。
// 依据施工参考 2026-09-24 更新版 §2.2（输出清洗）/§2.4（骨架校验）/§2.5（幻觉形态清单）。
// 纯函数零 IO——骨架样本取自真库真实公式 SVG 的几何形态（`<line>`=分数线、`<path>`=字形、`<g transform>`=字符分组）。

import { describe, it, expect } from 'vitest';
import {
  checkFormulaAgainstSkeleton,
  hallucinationReason,
  parseFormulaSkeleton,
  sanitizeFormulaTex,
} from '../../src/recog/ai-clean/formula-qa.js';

/** 真库形态样本：`B = F/IL`（含 1 条**独立**分数线 + 4 个字符分组，无根号） */
const SVG_FRACTION = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="46" height="26">',
  '<g><g transform="translate(2,20)"><path d="M1 1"/></g>',
  '<g transform="translate(10,20)"><path d="M2 2"/></g>',
  '<line x1="18" y1="13" x2="40" y2="13"/>',
  '<g transform="translate(20,10)"><path d="M3 3"/></g>',
  '<g transform="translate(28,25)"><path d="M4 4"/></g></g></svg>',
].join('');

/**
 * 真库形态样本：`\sqrt{gd}`（组卷 35555640-6.svg 的**逐字节几何**）——
 * 斜杠 + 端部短笔 + 横梁**首尾相接**，横梁与斜杠并不同形于分数线。
 */
const SVG_RADICAL = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="29" height="23"><g>',
  '<line y2="22" x1="1.3333" x2="4.6889" y1="12.3"/>',
  '<line y2="0.7333" x1="4.6889" x2="8.0444" y1="22"/>',
  '<line y2="0.7333" x1="8.0444" x2="27.0819" y1="0.7333"/>',
  '<g transform="translate(9.8242,25.387)"><path d="M1 1"/></g>',
  '<g transform="translate(16.8257,18)"><path d="M2 2"/></g>',
  '</g></svg>',
].join('');

/** 真库形态样本：`\sqrt{d/g}`（组卷 35555640-5.svg）：根号横梁 + **内嵌**分数线各 1 条 */
const SVG_RADICAL_FRACTION = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="30"><g>',
  '<line y2="28.8401" x1="1.3333" x2="4.6889" y1="16.3"/>',
  '<line y2="0.7276" x1="4.6889" x2="8.0444" y1="28.8401"/>',
  '<line y2="0.7276" x1="8.0444" x2="22.4435" y1="0.7276"/>',
  '<line y2="16.3" x1="9.3867" x2="18.1679" y1="16.3"/>',
  '<g transform="translate(9.4492,14.1036)"><path d="M1 1"/></g>',
  '<g transform="translate(9.8242,25.387)"><path d="M2 2"/></g>',
  '</g></svg>',
].join('');

/** 660/760 张站点公式图的形态：根号/分式画成**路径** → 骨架里一条 `<line>` 都没有 */
const SVG_PATH_ONLY = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="12"><g><g transform="translate(2,10)"><path d="M1 1"/></g></g></svg>';

describe('0056 返工④：SVG 骨架解析（§2.4）', () => {
  it('分数线 / 字符分组 / 行数识别（真库 B=F/IL 形态）', () => {
    const skeleton = parseFormulaSkeleton(SVG_FRACTION);
    expect(skeleton.fractionBars).toBe(1);
    expect(skeleton.radical).toBe(false);
    expect(skeleton.glyphGroups).toBe(4);
    expect(skeleton.rows).toBe(3); // y=10/20/25 三行（分子/基线/分母）
  });

  it('根号骨架识别：横梁与斜/短笔**端点相接**（组卷真形态，斜杠并不竖直）', () => {
    const skeleton = parseFormulaSkeleton(SVG_RADICAL);
    expect(skeleton.radical).toBe(true);
    expect(skeleton.fractionBars).toBe(0);
    expect(skeleton.lineSignals).toBe(3);
  });

  it('根号里嵌分式：横梁算根号、独立横线算分数线（各 1）', () => {
    const skeleton = parseFormulaSkeleton(SVG_RADICAL_FRACTION);
    expect(skeleton.radical).toBe(true);
    expect(skeleton.fractionBars).toBe(1);
    expect(skeleton.lineSignals).toBe(4);
  });

  it('非公式 SVG / 空串 → 全零骨架（不误判）', () => {
    const empty = parseFormulaSkeleton('');
    expect(empty).toEqual({ fractionBars: 0, radical: false, glyphGroups: 0, rows: 0, lineSignals: 0 });
    expect(parseFormulaSkeleton('<svg width="10" height="10"><path d="M0 0"/></svg>').glyphGroups).toBe(0);
  });
});

describe('0056 返工④：否定式校验（骨架没有的不许出现）', () => {
  const fractionSkeleton = parseFormulaSkeleton(SVG_FRACTION);

  it('结果含 \\frac 而骨架（有线信号）无分数线 → 标记可疑 + 原因可读', () => {
    // 「有线信号、但只有根号没有独立横线」才是「骨架没有分数线」的场景
    const radicalOnly = parseFormulaSkeleton(SVG_RADICAL);
    const result = checkFormulaAgainstSkeleton('\\frac{a}{b}', radicalOnly);
    expect(result.flags).toHaveLength(1);
    expect(result.flags[0]).toContain('没有分数线');
  });

  it('结果含 \\sqrt 而骨架（有线信号）无根号 → 标记可疑', () => {
    const result = checkFormulaAgainstSkeleton('\\sqrt{x}', fractionSkeleton);
    expect(result.flags.some((f) => f.includes('没有根号'))).toBe(true);
  });

  it('骨架支持时（有分数线 + 用 \\frac）→ 不报', () => {
    expect(checkFormulaAgainstSkeleton('\\frac{F}{IL}', fractionSkeleton).flags).toEqual([]);
  });

  // ---- 返工⑥：几何否定式的前置开关（否则 660/760 张站点图会被集体误报） ----
  it('返工⑥回归：真库形态 `\\sqrt{gd}` / `2\\sqrt{gd}`（根号横梁）→ 不再误报「没有根号」', () => {
    expect(checkFormulaAgainstSkeleton('\\sqrt{gd}', parseFormulaSkeleton(SVG_RADICAL)).flags).toEqual([]);
    expect(checkFormulaAgainstSkeleton('\\sqrt{\\frac{d}{g}}', parseFormulaSkeleton(SVG_RADICAL_FRACTION)).flags).toEqual([]);
    expect(checkFormulaAgainstSkeleton('\\frac{9d}{20}', parseFormulaSkeleton(SVG_FRACTION)).flags).toEqual([]);
  });

  it('返工⑥：骨架无任何 <line> 信号（站点把根号/分式画成路径）→ 一概不做几何否定判断', () => {
    const pathOnly = parseFormulaSkeleton(SVG_PATH_ONLY);
    expect(pathOnly.lineSignals).toBe(0);
    expect(checkFormulaAgainstSkeleton('\\sqrt{a}', pathOnly).flags).toEqual([]);
    expect(checkFormulaAgainstSkeleton('\\frac{a}{b}', pathOnly).flags).toEqual([]);
  });

  it('长文本幻觉（结果规模远超骨架字符数）→ 标记可疑', () => {
    const result = checkFormulaAgainstSkeleton('a+b+c+d+e+f+g+h+i+j+k+l+m+n+o+p+q+r', fractionSkeleton);
    expect(result.flags.some((f) => f.includes('远超骨架字符分组数'))).toBe(true);
  });

  it('漏识别（骨架 6+ 分组而结果只有 1 字符）→ 标记可疑', () => {
    const wide = parseFormulaSkeleton([
      '<svg width="80" height="20"><g>',
      ...Array.from({ length: 8 }, (_v, i) => `<g transform="translate(${i * 9},15)"><path d="M1 1"/></g>`),
      '</g></svg>',
    ].join(''));
    expect(wide.glyphGroups).toBe(8);
    const result = checkFormulaAgainstSkeleton('x', wide);
    expect(result.flags.some((f) => f.includes('疑漏识别'))).toBe(true);
  });
});

describe('0056 返工④：输出清洗（§2.2 清洗顺序 + §2.5 幻觉剥离）', () => {
  it('去代码围栏', () => {
    expect(sanitizeFormulaTex('```latex\n\\frac{a}{b}\n```')).toEqual({ tex: '\\frac{a}{b}', notes: ['去代码围栏'] });
  });

  it('剥整体定界符（\\[ … \\] / \\( … \\)）', () => {
    expect(sanitizeFormulaTex('\\[ x^2 \\]').tex).toBe('x^2');
    expect(sanitizeFormulaTex('\\( \\sin 37°=0.6 \\)').tex).toBe('\\sin 37°=0.6');
  });

  it('MathML 回包取 alttext', () => {
    const mathml = '<math xmlns="http://www.w3.org/1998/Math/MathML" alttext="\\rho =\\frac{m}{V}"><mrow/></math>';
    expect(sanitizeFormulaTex(mathml).tex).toBe('\\rho =\\frac{m}{V}');
  });

  it('去 \\displaystyle 与尾部多余大括号', () => {
    expect(sanitizeFormulaTex('{\\displaystyle \\frac{a}{b}}').tex).toBe('{\\frac{a}{b}}');
    expect(sanitizeFormulaTex('\\frac{a}{b}}').tex).toBe('\\frac{a}{b}');
  });

  it('方括号幻觉（单字母 H 被写成 [H]）→ 剥括号', () => {
    expect(sanitizeFormulaTex('[H]')).toEqual({ tex: 'H', notes: ['剥方括号幻觉'] });
    expect(sanitizeFormulaTex('[a_{1}]').tex).toBe('a_{1}');
  });

  it('正常结果原样通过（零清洗动作）', () => {
    expect(sanitizeFormulaTex('\\frac{F}{IL}')).toEqual({ tex: '\\frac{F}{IL}', notes: [] });
  });

  // 返工⑧：真机现场（用户第二道样题）选项 `t'<t` 在对照弹层显示成 `t' &lt; t`——
  // 裸 `<` 写进 data-tex 被转义、渲染链读到的仍是实体原文。LaTeX 里改用 `\lt`/`\gt` 等价且无特殊字符。
  it('裸 < > → \\lt \\gt（HTML 转义不再污染渲染）', () => {
    const sanitized = sanitizeFormulaTex("t'<t");
    expect(sanitized.tex).toBe("t'\\lt t");
    expect(sanitized.notes).toContain('裸 < > 换 \\lt \\gt');
    expect(sanitizeFormulaTex('a>b').tex).toBe('a\\gt b');
    // 已用 \lt 的写法原样不动
    expect(sanitizeFormulaTex('t\\lt t').tex).toBe('t\\lt t');
  });
});

describe('0056 返工④：垃圾/幻觉形态判据（命中即判该图失败，绝不写进 data-tex）', () => {
  it('空 / 换行 / 描述性短语 / 提示词回显 / 超长 → 各有明确原因', () => {
    expect(hallucinationReason('')).toContain('空公式');
    expect(hallucinationReason('a\nb')).toContain('含换行');
    expect(hallucinationReason('[Image of a blackboard with formulas]')).toContain('描述性短语');
    expect(hallucinationReason('latex')).toContain('不是公式');
    expect(hallucinationReason('x'.repeat(81))).toContain('过长');
  });

  it('正常公式（含较长真公式）→ 通过', () => {
    expect(hallucinationReason('\\frac{1}{2} \\arcsin \\left( \\frac{a \\sin 2\\beta + b \\sin 2\\alpha}{a + b} \\right)')).toBeNull();
  });
});
