import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 主界面图限宽样式存在性（D1-fix-2 F-3）：React 产品页不加载 paper.css，
 * 题目 HTML 图约束由 src/app/app.css 提供；规则缺失 = 大图撑爆版心回归
 */
describe('app.css — 主界面图限宽（D1-fix-2 F-3）', () => {
  const css = readFileSync(join(__dirname, '../../src/app/app.css'), 'utf-8');
  const mainTsx = readFileSync(join(__dirname, '../../src/app/main.tsx'), 'utf-8');

  it('main.tsx 引入 app.css（全局生效）', () => {
    expect(mainTsx).toContain("import './app.css'");
  });

  it('行内公式图规则：.inline-figure 内联 + img 限宽 200（与 F-4 阈值一致）', () => {
    expect(css).toMatch(/\.inline-figure\s*\{[^}]*display:\s*inline-block/);
    expect(css).toMatch(/\.inline-figure\s*>\s*img\s*\{[^}]*max-width:\s*200px/);
  });

  it('0041 对齐采集预览：app 侧与 paper.css 同步撤下限档——行内公式图按内在尺寸出图', () => {
    expect(css).not.toMatch(/\.inline-figure\s*>\s*img\s*\{[^}]*min-height/);
    expect(css).toMatch(/\.inline-figure\s*>\s*img\s*\{[^}]*width:\s*auto\s*!important/);
    expect(css).toMatch(/\.inline-figure\s*>\s*img\s*\{[^}]*max-width:\s*200px/);
    // figure.diagram / 裸 q-figure 本就不做下限放大（选择器边界，零回归）
    expect(css).not.toMatch(/figure\.diagram\s*\{[^}]*min-height/);
    expect(css).not.toMatch(/^img\.q-figure\s*\{[^}]*min-height/m);
  });

  it('块级配图限宽：figure.diagram 与裸 img.q-figure 封顶（0014 目检返工终档 min(48%,240px)，封顶意图不变）', () => {
    expect(css).toMatch(/figure\.diagram\s*\{[^}]*max-width:\s*min\(48%,\s*240px\)/);
    // 裸 img.q-figure（不在 figure 内）独立成行，同档封顶
    expect(css).toMatch(/^img\.q-figure\s*\{[^}]*max-width:\s*min\(48%,\s*240px\)/m);
    // figure 容器内 img 保持 100%（相对已封顶的容器）
    expect(css).toMatch(/figure\.diagram\s+img[^{]*\{[^}]*max-width:\s*100%/);
  });

  it('答案/解析字段图放开到容器 100%（0014 目检返工：组卷网答案整图 80% 缩放不可读；行内小图源序靠后仍 200px）', () => {
    expect(css).toMatch(/\.answer-field\s+img[^{]*\{[^}]*max-width:\s*100%/);
    expect(css).toMatch(/\.analysis-field\s+img[^{]*\{[^}]*max-width:\s*100%/);
    // .answer-field img 与 .inline-figure > img 同为 0-1-1 特异性，
    // 必须让 .inline-figure > img 规则在源序上靠后，保证行内小图仍 200px 封顶
    expect(css.indexOf('.inline-figure > img {')).toBeGreaterThan(css.indexOf('.answer-field img,'));
  });

  it('裸题内图兜底：.question-content/.question 内 img max-width:100%', () => {
    expect(css).toMatch(/\.question-content\s+img[\s\S]*?max-width:\s*100%/);
  });

  it('KaTeX 字号规则存在且不限 img（KaTeX 无 img，不误伤）', () => {
    expect(css).toMatch(/\.katex\s*\{[^}]*font-size/);
    const katexBlock = css.match(/\.katex[\s\S]*?\}/g) || [];
    expect(katexBlock.every((b) => !b.includes('img'))).toBe(true);
  });
});

describe('app.css — 题库题卡列表宽度（0014 目检返工：参照学科网铺满右栏，纸面版心限宽退役）', () => {
  const css = readFileSync(join(__dirname, '../../src/app/app.css'), 'utf-8');

  it('题卡列表铺满容器（width:100%），不再有 700px 版心限宽', () => {
    expect(css).toMatch(/\.bank-question-list\s*\{[^}]*width:\s*100%/);
    expect(css).not.toMatch(/\.bank-question-list\s*\{[^}]*max-width:\s*700px/);
  });
});

describe('app.css — 题卡图片硬限（0014 R18 + 目检返工，实测定档 min(48%,240px)）', () => {
  const css = readFileSync(join(__dirname, '../../src/app/app.css'), 'utf-8');

  it('块图新档：figure.diagram 与裸 img.q-figure 封顶 min(48%, 240px)（目检返工 320→240，实测表见 0014 交付报告）', () => {
    expect(css).toMatch(/figure\.diagram\s*\{[^}]*max-width:\s*min\(48%,\s*240px\)/);
    expect(css).toMatch(/^img\.q-figure\s*\{[^}]*max-width:\s*min\(48%,\s*240px\)/m);
  });

  it('80% 旧档已替：块图两选择器与答案/解析字段图均不再 80%（答案/解析已放开到容器 100%）', () => {
    expect(css).not.toMatch(/figure\.diagram\s*\{[^}]*max-width:\s*80%/);
    expect(css).not.toMatch(/^img\.q-figure\s*\{[^}]*max-width:\s*80%/m);
    expect(css).toMatch(/\.answer-field\s+img[^{]*\{[^}]*max-width:\s*100%/);
    expect(css).toMatch(/\.analysis-field\s+img[^{]*\{[^}]*max-width:\s*100%/);
  });

  it('行内公式图规则（0041 口径：200px 封顶 + 内在尺寸，无下限档，源码级原文断言）', () => {
    expect(css).toMatch(/\.inline-figure\s*>\s*img\s*\{[^}]*max-width:\s*200px/);
    expect(css).not.toMatch(/\.inline-figure\s*>\s*img\s*\{[^}]*min-height/);
  });
});

describe('app.css — 答案/解析块图放开（0014 目检返工二：组卷网答案=figure.diagram 整图吃 240px 档）', () => {
  const css = readFileSync(join(__dirname, '../../src/app/app.css'), 'utf-8');

  it('answer/analysis 区内的 figure.diagram 放开到容器 100%（覆盖全局块图档）', () => {
    expect(css).toMatch(/\.answer-field\s+figure\.diagram[^{]*\{[^}]*max-width:\s*100%/);
    expect(css).toMatch(/\.analysis-field\s+figure\.diagram[^{]*\{[^}]*max-width:\s*100%/);
  });
});

/**
 * 0026 目检返工二：错题本全高两栏——左控件栏固定不随页面滚动，右题卡栏「固定页码条 + 滚动体」。
 * 口径与题库页同源（.bank-page 的 0014 返工结论）：flex 链逐层连通 + grid 行高钉 minmax(0,1fr)
 * + 两个 item min-height:0，缺一条就会出现「左栏跟着整页滚」或「内容撑破布局」。
 */
describe('theme.css — 0026 错题本全高两栏（左栏固定 / 右栏内滚）', () => {
  const css = readFileSync(join(__dirname, '../../src/app/theme.css'), 'utf-8');
  const page = readFileSync(join(__dirname, '../../src/app/pages/MistakesPage.tsx'), 'utf-8');

  it('页面根挂全高类，高度口径与题库页一致（视口 − .main 上下 padding）', () => {
    expect(page).toContain('className="mistake-page"');
    expect(css).toMatch(/\.mistake-page\s*\{[^}]*height:\s*calc\(100vh - 62px\)/);
  });

  it('两栏 grid 行高钉 minmax(0,1fr)，两栏 min-height:0（否则内容把行撑高、左栏随页滚）', () => {
    expect(css).toMatch(/\.mistake-layout\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\)/);
    expect(css).toMatch(/\.mistake-layout\s*\{[^}]*flex:\s*1/);
    expect(css).toMatch(/\.mistake-side\s*\{[^}]*min-height:\s*0/);
    expect(css).toMatch(/\.mistake-main\s*\{[^}]*min-height:\s*0/);
  });

  it('左栏自身内滚；右栏 overflow:hidden，滚动只发生在题卡滚动体', () => {
    expect(css).toMatch(/\.mistake-side\s*\{[^}]*overflow-y:\s*auto/);
    expect(css).toMatch(/\.mistake-main\s*\{[^}]*overflow:\s*hidden/);
    expect(css).toMatch(/\.m-cards-scroll\s*\{[^}]*overflow-y:\s*auto/);
    expect(page).toContain('className="m-cards-scroll"');
  });

  it('极矮视口回落整页滚动（全高钉死会把两栏挤成一条缝）', () => {
    expect(css).toMatch(/@media screen and \(max-height:\s*560px\)\s*\{[^}]*\.mistake-page\s*\{[^}]*height:\s*auto/);
  });
});
