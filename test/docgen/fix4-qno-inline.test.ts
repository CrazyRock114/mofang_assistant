// 0004-fix-4 #5（目检 #5）：题号与题干同行 + 续行/选项/答案/解析对齐首行文字左缘。
// 机制：.question-header 浮动（宽度自适应题号/分值），.mf-question-body 建立 BFC 整体避开浮动
// → 首行紧接题号、其余行从同一左缘起（悬挂缩进）；单列/双列、基线/config 双路径、学生/教师版同治。
// 本探针锚定结构 + CSS 规则（观感由用户目检；基线演进声明见交付报告）。

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Paper, Question } from '../../src/shared/contracts/bank-types.js';
import { buildPaperHtml } from '../../src/docgen/render/buildPaperHtml.js';

const paper: Paper = {
  id: 'fix4-qno',
  title: '题号同行探针卷',
  config: { totalScore: 100 },
  createdAt: '2026-09-09T00:00:00Z',
  archived: false,
};

const question: Question = {
  id: 'fix4-qno-q1',
  content: '<div class="question">题干第一行很长很长很长很长很长很长很长很长</div>',
  subject: '物理',
  sourceType: 'local',
  sourceDetail: { origin: 'test' },
  images: [],
  answer: 'B',
  analysis: '解析内容',
};

function bodyOf(html: string): string {
  return html.slice(html.indexOf('<body>'), html.indexOf('</body>'));
}

describe('fix-4 #5 题号同行（结构）', () => {
  it('基线路径：题号 header 在题体前，题体包裹 .mf-question-body', async () => {
    const html = await buildPaperHtml(paper, [question], { mode: 'teacher' });
    expect(html).toContain('<div class="mf-question-body">');
    expect(html.indexOf('question-header')).toBeLessThan(html.indexOf('mf-question-body'));
    // 题干内容与答案/解析都在题体内（与首行文字同左缘）
    expect(html.indexOf('mf-question-body')).toBeLessThan(html.indexOf('question-content'));
    expect(html.indexOf('mf-question-body')).toBeLessThan(html.indexOf('answer-field'));
    expect(html.indexOf('mf-question-body')).toBeLessThan(html.indexOf('analysis-field'));
    // 题体数 = 题数（CSS 里的 .mf-question-body 规则不计）
    expect(html.match(/class="mf-question-body"/g)).toHaveLength(1);
  });

  it('config 路径：同结构；显隐位关闭题号/分值时 header 为空（:empty 不缩进）', async () => {
    const shown = bodyOf(await buildPaperHtml(paper, [question], {
      mode: 'student',
      scores: [20],
      layoutConfig: { version: 2 },
    }));
    expect(shown).toContain('<div class="mf-question-body">');
    expect(shown).toContain('question-number');
    expect(shown).toContain('(20分)');
    expect(shown.indexOf('question-header')).toBeLessThan(shown.indexOf('mf-question-body'));

    const hidden = bodyOf(await buildPaperHtml(paper, [question], {
      mode: 'student',
      scores: [20],
      layoutConfig: { version: 2, fieldVisibility: { questionNo: false, score: false } },
    }));
    expect(hidden).toContain('<div class="question-header"></div>');
    expect(hidden).not.toContain('question-number');
    expect(hidden).toContain('<div class="mf-question-body">');
  });
});

describe('fix-4 #5 题号同行（paper.css 机制）', () => {
  const css = readFileSync(join(__dirname, '../../src/docgen/render/paper.css'), 'utf-8');

  it('.question-header 浮动 + 宽度自适应（不写死缩进量）', () => {
    expect(css).toMatch(/\.question-header\s*\{[^}]*float:\s*left/);
    expect(css).not.toMatch(/\.question-header\s*\{[^}]*display:\s*flex/);
  });

  it('.mf-question-body 建立 BFC 避开浮动（悬挂缩进）；空 header 不缩进', () => {
    expect(css).toMatch(/\.mf-question-body\s*\{[^}]*display:\s*flow-root/);
    expect(css).toMatch(/\.question-header:empty\s*\{[^}]*display:\s*none/);
  });

  it('.question-item 建立 BFC 关住浮动（浮动不溢出到下一题）', () => {
    expect(css).toMatch(/\.question-item\s*\{[^}]*display:\s*flow-root/);
  });

  it('.question-content 不再自带 margin-left（缩进由题体 BFC 承担）', () => {
    expect(css).not.toMatch(/\.question-content\s*\{[^}]*margin-left/);
  });
});

// ==================== 0052 / R-050：首块顶边距归零（fix-4 盲区回归锁） ====================
// 回归复现：fix-4 的 BFC 悬挂缩进**阻止子元素外边距折出**——题干首块自带顶外边距时
// （识别链/编辑器链 `<p>`=UA 1em；识别链 figure=1em；0050 起 table=0.6em），首行被整块顶到
// 题号下一行。原回归锁 fixture 只有裸文本（无 <p>→无外边距），故从未抓到。
// 本组锁两件事：① 产物里确实存在这些「首块带顶边距」形态（渲染管线不改结构 → 锁不失效）；
// ② paper.css 确有归零规则，且规则能覆盖产物**实际**产出的层级（含交互预览 .mf-seg 标记在首块前）。
// 像素级证据在 scripts/probe-0052-qno-inline.mjs（Electron 真渲染，|Δ|≤6px）；jsdom 无布局引擎。

/** 形态变体复用基线（仅 content 不同） */
const questionBase = question;

/** CSS 里所有「margin-top: 0」规则的选择器（去注释、按逗号展开） */
function zeroTopMarginSelectors(stylesheet: string): string[] {
  const bare = stylesheet.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];
  for (const rule of bare.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!/margin-top:\s*0\s*(;|$)/.test(rule[2])) continue;
    for (const selector of rule[1].split(',')) out.push(selector.trim().replace(/\s+/g, ' '));
  }
  return out;
}

const MARKER = /^<span class="mf-seg" data-mf-seg="\d+"><\/span>\s*/;

interface FirstBlockShape {
  /** 题面首个在流节点是文本（裸文本题：无块级首元素 → 无顶边距可归零） */
  textFirst: boolean;
  /** 首个在流块级元素标签（textFirst=true 时为 null） */
  tag: string | null;
  /** 首块之前有 .mf-seg 标记（交互预览段边界；绝对定位不占流，但占据 :first-child 位） */
  markerBefore: boolean;
  /** 题面容器首孩子是 .mf-seg 标记（边界 0；交互预览恒在，打印/导出恒无） */
  topMarker: boolean;
  /** 首块的父层是 .question 包裹层（渲染管线常规形态） */
  wrapped: boolean;
}

/**
 * 取产物「.question-content 内首个在流块」的形态（跳过 .mf-seg —— 绝对定位标记不占流）。
 * 只认渲染管线产出的两种层级：.question-content > .question > 块 / .question-content > 块。
 */
function firstBlockShape(html: string): FirstBlockShape {
  const body = bodyOf(html);
  const open = '<div class="question-content">';
  const at = body.indexOf(open);
  if (at < 0) throw new Error('产物无 .question-content');
  let rest = body.slice(at + open.length);

  const topMarker = rest.match(MARKER);
  if (topMarker) rest = rest.slice(topMarker[0].length);

  const questionOpen = '<div class="question">';
  const wrapped = rest.startsWith(questionOpen);
  if (wrapped) rest = rest.slice(questionOpen.length);

  const innerMarker = rest.match(MARKER);
  if (innerMarker) rest = rest.slice(innerMarker[0].length);

  const element = rest.match(/^<([a-z][a-z0-9]*)/);
  return {
    textFirst: element === null,
    tag: element ? element[1] : null,
    markerBefore: Boolean(innerMarker),
    topMarker: Boolean(topMarker),
    wrapped,
  };
}

/** 形态 → 覆盖它的归零选择器（null = 无需归零：首节点是文本） */
function coveringSelector(shape: FirstBlockShape): string | null {
  if (shape.textFirst) return null;
  if (!shape.wrapped) return shape.markerBefore ? '.question-content > .mf-seg:first-child + *' : '.question-content > :first-child';
  return shape.markerBefore
    ? '.question-content > .question > .mf-seg:first-child + *'
    : '.question-content > .question > :first-child';
}

describe('0052 / R-050：首块顶边距归零（题号与题面同行，fix-4 盲区）', () => {
  const css = readFileSync(join(__dirname, '../../src/docgen/render/paper.css'), 'utf-8');
  const zeroed = zeroTopMarginSelectors(css);

  /** 五种内容形态（对应 scripts/probe-0052-qno-inline.mjs 的探针矩阵）；tag = 各路径下产物首块标签 */
  const PATHS = ['baseline', 'paper', 'preview'] as const;
  const SHAPES: { label: string; content: string; tag: Record<(typeof PATHS)[number], string | null> }[] = [
    {
      label: '① 裸文本（采集链）',
      content: '<div class="question">一物体做匀速直线运动，速度为 2m/s，求 5 秒内的位移。'
        + '<div class="options"><span class="option">A. 10m</span><span class="option">B. 20m</span></div></div>',
      tag: { baseline: null, paper: null, preview: null },
    },
    {
      label: '② <p> 首块（识别链/编辑器链）',
      content: '<div class="question"><p>一物体做匀速直线运动，速度为 2m/s，求 5 秒内的位移。</p>'
        + '<div class="options"><span class="option">A. 10m</span></div></div>',
      tag: { baseline: 'p', paper: 'p', preview: 'p' },
    },
    {
      label: '③ 首块为图（figure 1em 顶边距）',
      // config 路径图块外包 .figure-block（margin 0）：首块=包装 div；基线路径裸 figure（顶边距 1em）
      content: '<div class="question"><figure data-w="300"><img src="data-assets/capture/fig.png"></figure></div>',
      tag: { baseline: 'figure', paper: 'div', preview: 'div' },
    },
    {
      label: '④ 首块为表（0050 table 0.6em 顶边距）',
      content: '<div class="question"><table><thead><tr><th>物理量</th><th>数值</th></tr></thead>'
        + '<tbody><tr><td>速度</td><td>3</td></tr></tbody></table></div>',
      tag: { baseline: 'table', paper: 'table', preview: 'table' },
    },
    {
      label: '⑤ 图在文前（题首孤图）',
      // 基线路径无「题首孤图后移」→ 首块=figure；config 路径后移到段尾 → 首块=p（且标记在 p 之前）
      content: '<div class="question"><figure data-w="300"><img src="data-assets/capture/fig.png"></figure>'
        + '<p>如图所示，求该物体的位移大小与方向。</p></div>',
      tag: { baseline: 'figure', paper: 'p', preview: 'p' },
    },
  ];

  for (const shape of SHAPES) {
    it(`${shape.label}：产物首块形态成立 + 归零规则覆盖（基线与交互预览两口径）`, async () => {
      const question: Question = { ...questionBase, id: 'fix4-qno-shape', content: shape.content };
      const seen: (FirstBlockShape & { path: string })[] = [];
      // 三条真实渲染路径（与探针矩阵同口径）：基线（无 config）/ 打印导出 / 交互预览（段边界标记）
      const combos = [
        { path: 'baseline', layoutConfig: undefined, segmentAnchors: false },
        { path: 'paper', layoutConfig: { version: 2 }, segmentAnchors: false },
        { path: 'preview', layoutConfig: { version: 2 }, segmentAnchors: true },
      ] as const;
      for (const combo of combos) {
        const html = await buildPaperHtml(paper, [question], {
          mode: 'teacher',
          scores: [5],
          layoutConfig: combo.layoutConfig,
          segmentAnchors: combo.segmentAnchors,
        });
        const found = { ...firstBlockShape(html), path: combo.path };
        seen.push(found);
        // 形态成立：管线结构未变（变了则本锁的覆盖推导失效，须同步复核 paper.css）
        expect(found.wrapped).toBe(true);
        expect(found.tag).toBe(shape.tag[combo.path]);
        // 交互预览口径：段边界标记确在题面之前（fix-5 P0-2 语义不变）；打印/导出口径零标记
        expect(found.topMarker).toBe(combo.segmentAnchors);
      }
      // 归零覆盖：产物各口径（含标记在前的层级）都要能命中 paper.css 的规则
      for (const found of seen) {
        const selector = coveringSelector(found);
        if (selector === null) continue;
        expect(zeroed, `${shape.label} / ${found.path} 首块 ${found.tag} 缺归零规则`).toContain(selector);
      }
    });
  }

  it('归零只作用于首块：非首块间距策略不变（选项/图/表 margin 声明原样）', () => {
    // 防「一刀切清零」把题内其它间距也吃掉：三条既有间距声明必须还在
    expect(css).toMatch(/\.question-content > \.question > \.options\s*\{[^}]*margin-top:\s*0\.5em/);
    expect(css).toMatch(/\.question-content figure\s*\{[^}]*margin:\s*1em 0/);
    expect(css).toMatch(/\.question-content table[\s\S]*?\{[^}]*margin:\s*0\.6em 0/);
    // 所有归零规则都必须是「首块」选择器（:first-child 或紧跟 .mf-seg 首标记的兄弟）
    for (const selector of zeroed) {
      expect(selector).toMatch(/(:first-child|\.mf-seg:first-child \+ \*)$/);
    }
  });

  it('归零规则带 0052/R-050 锚点注释（可追溯到题号同行机制）', () => {
    expect(css).toMatch(/0052[\s\S]{0,200}R-050|R-050[\s\S]{0,200}0052/);
  });
});
