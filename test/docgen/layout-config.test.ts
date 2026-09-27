// 0004 Phase 4（乙路）渲染探针：config → HTML 数据级断言。
// 覆盖 §三探针清单：@page A3/双列容器/学生版无答案/显式覆盖/作答区高度/Logo 绝对定位/
// 题级 figure 覆盖优先/无 config 基线一致（既有 render.test.ts+paper-css.test.ts 为基线回归）。
// 注意：paper.css 与注入 CSS 均内联进 <head>，元素级断言一律用 bodyOf() 作用域，避免 CSS 类名污染。

import { describe, it, expect } from 'vitest';
import type { Paper, Question, PaperLayoutConfig } from '../../src/shared/contracts/bank-types.js';
import { buildPaperHtml } from '../../src/docgen/render/buildPaperHtml.js';
import {
  resolveLayout,
  normalizeOptionsLayout,
  effectiveContentVisibility,
  buildLayoutCss,
  PAGE_SIZE_MM,
} from '../../src/docgen/render/layout.js';
import {
  blockifyQuestionContent,
  relocateLeadingFigureSegments,
  buildRenderSegments,
  applyFigureOverrides,
  type FigureRenderSpec,
} from '../../src/docgen/render/figureBlocks.js';
import { validateLayoutConfig } from '../../src/app/services/layout-config-validate.js';

/** 截取 <body>…（CSS 全在 head，元素断言用本作用域） */
function bodyOf(html: string): string {
  const start = html.indexOf('<body>');
  return start >= 0 ? html.slice(start) : html;
}

function makePaper(config: Paper['config'] = {}): Paper {
  return {
    id: 'layout-paper',
    title: '版式测试卷',
    config,
    createdAt: '2026-09-08T00:00:00Z',
    archived: false,
  };
}

/** 双图题：fig-a(300px) 在前、fig-b(200px) 在后，中间夹文本；另有行内公式图（formula-image 语义） */
function makeFigureQuestion(): Question {
  return {
    id: 'fig-q',
    subject: '物理',
    sourceType: 'local',
    sourceDetail: {},
    content:
      '<div class="question">第一段文字。' +
      '<span class="inline-figure"><img class="q-formula" data-w="42" src="data-assets/capture/f1.svg"></span>' +
      '<figure class="fig-a" data-w="300"><img src="data-assets/capture/a.png"></figure>' +
      '第二段文字。' +
      '<figure class="fig-b" data-w="200"><img src="data-assets/capture/b.png"></figure>' +
      '</div>',
    answer: '<p>参考答案内容</p>',
    analysis: '<p>解析内容</p>',
    images: [{ assetId: 'capture/f1.svg', type: 'formula-image', width: 42 }],
    createdAt: '2026-09-08T00:00:00Z',
    updatedAt: '2026-09-08T00:00:00Z',
  };
}

/** 0004 §二-6 内置种子 A3双列（乙路自测样例） */
const A3_SEED: PaperLayoutConfig = {
  version: 2,
  pageSize: 'A3',
  columns: 2,
  columnGapMm: 8,
  fontSize: 12,
  lineHeight: 1.5,
  header: { style: 'exam' },
};

describe('0004 渲染探针 — resolveLayout 归一化', () => {
  it('缺省 config → 全默认（A4/单栏/gap 8/字号 12/基线页边距/exam 抬头/作答区关）', () => {
    const layout = resolveLayout(undefined);
    expect(layout.pageSize).toBe('A4');
    expect(layout.columns).toBe(1);
    expect(layout.columnGapMm).toBe(8);
    expect(layout.fontSize).toBe(12);
    expect(layout.lineHeight).toBeNull();
    expect(layout.pageMarginMm).toEqual({ top: 20, right: 15, bottom: 20, left: 15 });
    expect(layout.header).toEqual({ style: 'exam', title: null, lines: [] });
    expect(layout.answerSpace.enabled).toBe(false);
    // S5 基线演进：figureLayout 增全局图宽档 widthPercent（null=未配置 → 引擎默认观感档）
    expect(layout.figureLayout).toEqual({ mode: 'inline', align: 'center', widthPercent: null });
    expect(layout.logos).toEqual([]);
  });

  it('A3双列种子 config → A3/双列/gap 8/行距 1.5/exam', () => {
    const layout = resolveLayout(A3_SEED);
    expect(layout.pageSize).toBe('A3');
    expect(layout.columns).toBe(2);
    expect(layout.columnGapMm).toBe(8);
    expect(layout.lineHeight).toBe(1.5);
    expect(layout.header.style).toBe('exam');
  });

  it('v1 config（version:1）→ v2 新字段全默认，v1 值语义不变', () => {
    const layout = resolveLayout({ version: 1, fontSize: 14 });
    expect(layout.fontSize).toBe(14);
    expect(layout.pageSize).toBe('A4');
    expect(layout.columns).toBe(1);
    expect(layout.columnGapMm).toBe(8);
  });

  it('mode × fieldVisibility 语义表（§二-3）', () => {
    const base = resolveLayout(undefined).fieldVisibility;
    // student 基线 [隐/隐]；teacher 基线 [显/显]
    expect(effectiveContentVisibility(base, 'student')).toMatchObject({ answer: false, analysis: false });
    expect(effectiveContentVisibility(base, 'teacher')).toMatchObject({ answer: true, analysis: true });
    // 显式 true/false 覆盖两 mode 基线
    const showAll = resolveLayout({ version: 2, fieldVisibility: { answer: true, analysis: true } }).fieldVisibility;
    expect(effectiveContentVisibility(showAll, 'student')).toMatchObject({ answer: true, analysis: true });
    const hideAll = resolveLayout({ version: 2, fieldVisibility: { answer: false, analysis: false } }).fieldVisibility;
    expect(effectiveContentVisibility(hideAll, 'teacher')).toMatchObject({ answer: false, analysis: false });
    // questionNo/score 通用显隐（缺省显示，false 隐藏）
    expect(effectiveContentVisibility(base, 'student').questionNo).toBe(true);
    expect(effectiveContentVisibility({ questionNo: false, score: false }, 'teacher')).toMatchObject({
      questionNo: false,
      score: false,
    });
  });
});

describe('0004 渲染探针 — @page/出纸/分栏', () => {
  it('A3双列 config → @page size A3 + 列容器 column-count:2 + gap 8mm', async () => {
    const html = await buildPaperHtml(makePaper(), [makeFigureQuestion()], {
      mode: 'student',
      layoutConfig: A3_SEED,
    });
    expect(html).toContain('@page { size: A3;');
    expect(html).toContain('column-count: 2');
    expect(html).toContain('column-gap: 8mm');
  });

  // ==================== fix-2 F2-A：横竖版 ====================

  it('orientation 缺省 → portrait（@page 无 landscape 后缀）；landscape → size 后缀 + 版心宽互换', async () => {
    expect(resolveLayout(undefined).orientation).toBe('portrait');
    expect(resolveLayout({ version: 2 }).orientation).toBe('portrait');

    const portrait = await buildPaperHtml(makePaper(), [], {
      mode: 'student',
      layoutConfig: { version: 2, pageSize: 'A3' },
    });
    expect(portrait).toContain('@page { size: A3; margin:');
    expect(portrait).toContain('.paper { max-width: 297mm; }');

    const landscape = await buildPaperHtml(makePaper(), [], {
      mode: 'student',
      layoutConfig: { version: 2, pageSize: 'A3', orientation: 'landscape' },
    });
    expect(landscape).toContain('@page { size: A3 landscape; margin:');
    expect(landscape).toContain('.paper { max-width: 420mm; }'); // 横幅宽 = 竖版高
    expect(landscape).not.toContain('max-width: 297mm');
  });

  it('landscape Logo 比例坐标换算基准 = 取向换算后页宽高（A4 landscape：297×210）', async () => {
    const html = await buildPaperHtml(makePaper(), [], {
      mode: 'student',
      assetsRoot: '/tmp/assets',
      layoutConfig: {
        version: 2,
        orientation: 'landscape',
        logos: [{ assetId: 'logos/school.png', xRatio: 0.1, yRatio: 0.05, widthRatio: 0.2 }],
      },
    });
    const body = bodyOf(html);
    expect(body).toContain('left: 29.7mm;'); // 0.1 × 297（横版页宽 = A4 竖版高）
    expect(body).toContain('top: 10.5mm;'); // 0.05 × 210（横版页高 = A4 竖版宽）
    expect(body).toContain('width: 59.4mm;'); // 0.2 × 297
  });

  it('A3双列种子（迁移 4 后含 landscape）→ @page size A3 landscape + 双列（用户目检 #1 探针）', async () => {
    const html = await buildPaperHtml(makePaper(), [makeFigureQuestion()], {
      mode: 'student',
      layoutConfig: {
        version: 2,
        pageSize: 'A3',
        orientation: 'landscape',
        columns: 2,
        columnGapMm: 8,
        fontSize: 12,
        lineHeight: 1.5,
        header: { style: 'exam' },
      },
    });
    expect(html).toContain('@page { size: A3 landscape;');
    expect(html).toContain('column-count: 2');
    expect(html).toContain('column-gap: 8mm');
  });

  it('缺省 config → A4（沿用基线 @page），不注入分栏', async () => {
    const html = await buildPaperHtml(makePaper(), [makeFigureQuestion()], {
      mode: 'student',
      layoutConfig: { version: 2 },
    });
    expect(html).not.toContain('size: A3');
    expect(html).not.toContain('column-count');
  });

  it('字号/行距/字体变量注入 config 值', async () => {
    const html = await buildPaperHtml(makePaper(), [], {
      mode: 'student',
      layoutConfig: { version: 2, fontSize: 14, lineHeight: 1.6, fontFamily: "'SimHei', sans-serif" },
    });
    expect(html).toContain('--mf-font-size: 14pt');
    expect(html).toContain('--mf-line-height: 1.6');
    expect(html).toContain('--mf-question-line-height: 1.6');
    expect(html).toContain("--mf-font-family: 'SimHei', sans-serif");
  });

  it('pageMarginMm 驱动 @page margin', async () => {
    const html = await buildPaperHtml(makePaper(), [], {
      mode: 'student',
      layoutConfig: { version: 2, pageMarginMm: { top: 10, right: 12, bottom: 14, left: 16 } },
    });
    expect(html).toContain('@page { size: A4; margin: 10mm 12mm 14mm 16mm; }');
  });
});

describe('0004 渲染探针 — 内容显隐（mode × fieldVisibility）', () => {
  it('学生版无答案容器/答案字段（基线语义保持）', async () => {
    const body = bodyOf(
      await buildPaperHtml(makePaper(), [makeFigureQuestion()], {
        mode: 'student',
        layoutConfig: A3_SEED,
      })
    );
    expect(body).not.toContain('answer-field');
    expect(body).not.toContain('class="answer"');
    expect(body).not.toContain('参考答案内容');
    expect(body).not.toContain('解析内容');
  });

  it('教师版答案+解析红显', async () => {
    const body = bodyOf(
      await buildPaperHtml(makePaper(), [makeFigureQuestion()], {
        mode: 'teacher',
        layoutConfig: A3_SEED,
      })
    );
    expect(body).toContain('答案：');
    expect(body).toContain('参考答案内容');
    expect(body).toContain('解析内容');
    expect(body).toContain('style="color: #d32f2f;"');
  });

  it('teacher + fieldVisibility.answer=false → 答案隐藏、解析仍在', async () => {
    const body = bodyOf(
      await buildPaperHtml(makePaper(), [makeFigureQuestion()], {
        mode: 'teacher',
        layoutConfig: { version: 2, fieldVisibility: { answer: false } },
      })
    );
    expect(body).not.toContain('参考答案内容');
    expect(body).not.toContain('答案：');
    expect(body).toContain('解析内容');
  });

  it('student + fieldVisibility.analysis=true → 讲义形态（解析显示且不红显）', async () => {
    const body = bodyOf(
      await buildPaperHtml(makePaper(), [makeFigureQuestion()], {
        mode: 'student',
        layoutConfig: { version: 2, fieldVisibility: { analysis: true } },
      })
    );
    expect(body).toContain('解析内容');
    expect(body).toContain('analysis-field');
    expect(body).not.toContain('style="color: #d32f2f;"');
    expect(body).not.toContain('answer-field');
  });

  it('questionNo/score 显隐位（通用）', async () => {
    const hidden = bodyOf(
      await buildPaperHtml(makePaper(), [makeFigureQuestion()], {
        mode: 'student',
        scores: [20],
        layoutConfig: { version: 2, fieldVisibility: { questionNo: false, score: false } },
      })
    );
    expect(hidden).not.toContain('question-number');
    expect(hidden).not.toContain('(20分)');

    const shown = bodyOf(
      await buildPaperHtml(makePaper(), [makeFigureQuestion()], {
        mode: 'student',
        scores: [20],
        layoutConfig: { version: 2 },
      })
    );
    expect(shown).toContain('question-number');
    expect(shown).toContain('(20分)');
  });
});

describe('0004 渲染探针 — 抬头样式', () => {
  it('exam = 标题 + 总分时长行', async () => {
    const body = bodyOf(
      await buildPaperHtml(makePaper({ totalScore: 100, duration: 90 }), [], {
        mode: 'student',
        layoutConfig: { version: 2, header: { style: 'exam' } },
      })
    );
    expect(body).toContain('class="paper-header"');
    expect(body).toContain('总分：100分');
    expect(body).toContain('时长：90分钟');
  });

  it('simple = 仅标题；none = 无抬头', async () => {
    const simple = bodyOf(
      await buildPaperHtml(makePaper({ totalScore: 100 }), [], {
        mode: 'student',
        layoutConfig: { version: 2, header: { style: 'simple' } },
      })
    );
    expect(simple).toContain('paper-header--simple');
    expect(simple).toContain('版式测试卷');
    expect(simple).not.toContain('总分：');

    const none = bodyOf(
      await buildPaperHtml(makePaper({ totalScore: 100 }), [], {
        mode: 'student',
        layoutConfig: { version: 2, header: { style: 'none' } },
      })
    );
    expect(none).not.toContain('paper-header');
    expect(none).not.toContain('总分：');
  });
});

describe('0009 卷头多行自定义（header.lines）', () => {
  /** 卷头行内联样式序列（真实输出；行序 = lines 数组序） */
  const lineStyles = (body: string): string[] =>
    Array.from(body.matchAll(/<div class="paper-header-line" style="([^"]*)">/g), (m) => m[1]);
  /** 卷头行内容序列（转义后原文，含 \n→<br>） */
  const lineTexts = (body: string): string[] =>
    Array.from(body.matchAll(/<div class="paper-header-line"[^>]*>([\s\S]*?)<\/div>/g), (m) => m[1]);

  async function headerBody(
    header: NonNullable<PaperLayoutConfig['header']>,
    config: Partial<PaperLayoutConfig> = {}
  ): Promise<string> {
    return bodyOf(
      await buildPaperHtml(makePaper({ totalScore: 100, duration: 90 }), [], {
        mode: 'student',
        layoutConfig: { version: 2, ...config, header },
      })
    );
  }

  it('多行渲染：行序/字号 pt/对齐/加粗逐点输出（含缺省值与 6–72 界内收拢）', async () => {
    const body = await headerBody({
      style: 'exam',
      lines: [
        { text: '期中测试卷' },
        { text: '总分：100分　考试时间：90分钟' },
        { text: '超大字', sizePt: 200, align: 'right', bold: false },
        { text: '超小字', sizePt: 2 },
        { text: '左对齐加粗', align: 'left', bold: true },
      ],
    });
    expect(lineStyles(body)).toEqual([
      'font-size:18pt;text-align:center;font-weight:bold',
      'font-size:11pt;text-align:center;font-weight:normal',
      'font-size:72pt;text-align:right;font-weight:normal',
      'font-size:6pt;text-align:center;font-weight:normal',
      'font-size:11pt;text-align:left;font-weight:bold',
    ]);
    expect(lineTexts(body)).toEqual([
      '期中测试卷', '总分：100分　考试时间：90分钟', '超大字', '超小字', '左对齐加粗',
    ]);
    // 多行模式 = 全部自定义行：exam 旧观感（h1 标题 + 自动总分/时长行）不再输出
    expect(body).not.toContain('paper-title');
    expect(body).not.toContain('paper-meta');
  });

  it('多行渲染：文本转义（< & "）+ 行内换行 → <br>', async () => {
    const body = await headerBody({
      lines: [
        { text: 'A<B & C>"D"' },
        { text: '姓名：____\n班级：____' },
      ],
    });
    expect(body).toContain(
      '<div class="paper-header-line" style="font-size:18pt;text-align:center;font-weight:bold">A&lt;B &amp; C&gt;&quot;D&quot;</div>'
    );
    expect(body).toContain('姓名：____<br>班级：____');
    expect(body).not.toContain('A<B & C>');
  });

  it('lines 缺省 / 全空 → 旧三态逐点零回归', async () => {
    const exam = await headerBody({ style: 'exam' });
    expect(exam).toContain('<h1 class="paper-title">版式测试卷</h1>');
    expect(exam).toContain('总分：100分');
    expect(exam).toContain('时长：90分钟');

    const blank = await headerBody({ style: 'exam', lines: [{ text: '   ' }, { text: '' }, { text: '\n' }] });
    expect(lineStyles(blank)).toEqual([]);
    expect(blank).toContain('<h1 class="paper-title">版式测试卷</h1>');
    expect(blank).toContain('总分：100分');

    const simple = await headerBody({ style: 'simple', lines: [] });
    expect(simple).toContain('paper-header--simple');
    expect(simple).not.toContain('总分：');
  });

  it('style=none 无条件压制 lines（优先级最高）', async () => {
    const body = await headerBody({ style: 'none', lines: [{ text: '不该出现' }] });
    expect(body).not.toContain('paper-header');
    expect(body).not.toContain('不该出现');
  });

  it('归一化单源（resolveLayout）：剔纯空行、缺省值逐行落定、非数 sizePt 回缺省', () => {
    const resolved = resolveLayout({
      version: 2,
      header: { style: 'exam', lines: [{ text: '  ' }, { text: '标题' }, { text: '信息行', sizePt: Number.NaN }] },
    });
    expect(resolved.header.lines).toEqual([
      { text: '标题', sizePt: 18, align: 'center', bold: true },
      { text: '信息行', sizePt: 11, align: 'center', bold: false },
    ]);
    expect(resolveLayout(undefined).header.lines).toEqual([]);
    expect(resolveLayout({ version: 2, header: { style: 'exam' } }).header.lines).toEqual([]);
  });

  it('归一化单源：非法 align/bold 回缺省（校验器剔字段后同源归一）', () => {
    const config = validateLayoutConfig({
      version: 2,
      header: { lines: [{ text: '标题', sizePt: 30, align: 'justify', bold: 'yes' }] },
    });
    expect(resolveLayout(config).header.lines).toEqual([
      { text: '标题', sizePt: 30, align: 'center', bold: true },
    ]);
  });

  it('旧 title 路径补转义（exam/simple 双路；安全修复）', async () => {
    const exam = await headerBody({ style: 'exam', title: 'A<B & C>' });
    expect(exam).toContain('<h1 class="paper-title">A&lt;B &amp; C&gt;</h1>');
    const simple = await headerBody({ style: 'simple', title: 'X<Y' });
    expect(simple).toContain('<h1 class="paper-title">X&lt;Y</h1>');
    expect(simple).not.toContain('X<Y');
  });
});

describe('0004 渲染探针 — 作答区', () => {
  it('enabled lines + heightMm=30 → 每题后插线格作答区，高度 30mm', async () => {
    const questions = [makeFigureQuestion(), { ...makeFigureQuestion(), id: 'fig-q2' }];
    const body = bodyOf(
      await buildPaperHtml(makePaper(), questions, {
        mode: 'student',
        layoutConfig: { version: 2, answerSpace: { enabled: true, style: 'lines', heightMm: 30 } },
      })
    );
    expect((body.match(/class="answer-space answer-space--lines"/g) ?? []).length).toBe(2);
    expect(body).toContain('height: 30mm');
  });

  it('缺省关闭 → 无作答区元素、无作答区规则', async () => {
    const html = await buildPaperHtml(makePaper(), [makeFigureQuestion()], {
      mode: 'student',
      layoutConfig: { version: 2 },
    });
    expect(bodyOf(html)).not.toContain('answer-space');
    expect(html).not.toContain('.answer-space');
  });
});

describe('0004 渲染探针 — Logo 绝对定位', () => {
  it('比例坐标 × A4 页宽高 mm 换算 + data-assets 管线解析 + 绝对定位', async () => {
    const html = await buildPaperHtml(makePaper(), [], {
      mode: 'student',
      assetsRoot: '/tmp/assets',
      layoutConfig: {
        version: 2,
        logos: [{ assetId: 'logos/school.png', xRatio: 0.1, yRatio: 0.05, widthRatio: 0.2 }],
      },
    });
    const page = PAGE_SIZE_MM.A4; // 210 × 297
    expect(html).toContain('.paper-logo { position: absolute; }');
    expect(html).toContain('.paper { position: relative; }');
    const body = bodyOf(html);
    expect(body).toContain('class="paper-logo"');
    expect(body).toContain(`left: ${0.1 * page.w}mm;`); // 21mm
    expect(body).toContain(`top: ${Number((0.05 * page.h).toFixed(2))}mm;`); // 14.85mm
    expect(body).toContain(`width: ${0.2 * page.w}mm`); // 42mm
    expect(body).toContain('src="file:///tmp/assets/logos/school.png"');
  });

  it('A3 页宽换算 + 无 Logo 不注入定位规则与元素', async () => {
    const a3 = await buildPaperHtml(makePaper(), [], {
      mode: 'student',
      assetsRoot: '/tmp/assets',
      layoutConfig: {
        version: 2,
        pageSize: 'A3',
        logos: [{ assetId: 'logos/a.png', xRatio: 0.5, yRatio: 0.5, widthRatio: 0.1 }],
      },
    });
    expect(bodyOf(a3)).toContain('left: 148.5mm;');
    expect(bodyOf(a3)).toContain('top: 210mm;');

    const none = await buildPaperHtml(makePaper(), [], {
      mode: 'student',
      layoutConfig: { version: 2 },
    });
    expect(none).not.toContain('paper-logo');
  });
});

describe('0004 渲染探针 — 图排版块化 + 题级覆盖优先', () => {
  // fix-2 F2-C 基线演进：原「图块依原 DOM 序输出在文本后」断言锚定了 blockify 丢锚点缺陷，已删除；
  // 新断言 = 交错序四态（文中图原位/题首孤图后移/side-by-side 聚栏/覆盖重排）
  it('inline（全局）：文中图原位交错（文本前段-图-文本后段），公式图（formula-image）留文本流', async () => {
    const body = bodyOf(
      await buildPaperHtml(makePaper(), [makeFigureQuestion()], {
        mode: 'student',
        assetsRoot: '/tmp/assets',
        layoutConfig: { version: 2, figureLayout: { mode: 'inline', align: 'center' } },
      })
    );
    const posT1 = body.indexOf('第一段文字。');
    const posA = body.indexOf('file:///tmp/assets/capture/a.png');
    const posT2 = body.indexOf('第二段文字。');
    const posB = body.indexOf('file:///tmp/assets/capture/b.png');
    expect(posT1).toBeGreaterThan(0);
    expect(posA).toBeGreaterThan(posT1); // 图 a 在第一段文本后（原 DOM 位随文流）
    expect(posT2).toBeGreaterThan(posA); // 第二段文本紧随图 a（交错）
    expect(posB).toBeGreaterThan(posT2);
    expect(body).not.toContain('data-assets/capture/a.png'); // 块内不再残留相对引用
    expect(body).not.toContain('figure-flow'); // fix-2：尾聚容器不复存在
    // 公式图不参与块化，仍在行内 span 中
    expect(body).toContain('<span class="inline-figure"><img class="q-formula"');
  });

  it('题首孤图后移（存量菁优左文右图）：首图移至文本后、选项保持居尾', async () => {
    const q: Question = {
      id: 'lead-fig-q',
      subject: '物理',
      sourceType: 'network',
      sourceDetail: { site: 'jyeoo' },
      content:
        '<div class="question">' +
        '<figure data-w="300"><img src="data-assets/capture/a.png"></figure>' +
        '如图所示的装置，下列说法正确的是。' +
        '<div class="options"><span class="option">A. 甲</span><span class="option">B. 乙</span></div>' +
        '</div>',
      answer: '<p>略</p>',
      images: [{ assetId: 'capture/a.png', type: 'figure', width: 300 }],
      createdAt: '2026-09-08T00:00:00Z',
      updatedAt: '2026-09-08T00:00:00Z',
    };
    const body = bodyOf(
      await buildPaperHtml(makePaper(), [q], {
        mode: 'student',
        layoutConfig: { version: 2 },
      })
    );
    const posT = body.indexOf('如图所示的装置');
    const posFig = body.indexOf('data-assets/capture/a.png');
    const posOpt = body.indexOf('class="options"');
    expect(posT).toBeGreaterThan(0); // 文本回到句首（题首孤图不再冲首）
    expect(posFig).toBeGreaterThan(posT); // 图移至文本后
    expect(posOpt).toBeGreaterThan(posFig); // 选项保持居尾（图在选项前）
  });

  it('纯图题（题首图后无文本）保持原序不后移', async () => {
    const q: Question = {
      id: 'pure-fig-q',
      subject: '物理',
      sourceType: 'network',
      sourceDetail: { site: 'jyeoo' },
      content:
        '<div class="question">' +
        '<figure data-w="300"><img src="data-assets/capture/a.png"></figure>' +
        '<figure data-w="200"><img src="data-assets/capture/b.png"></figure>' +
        '</div>',
      images: [
        { assetId: 'capture/a.png', type: 'figure', width: 300 },
        { assetId: 'capture/b.png', type: 'figure', width: 200 },
      ],
      createdAt: '2026-09-08T00:00:00Z',
      updatedAt: '2026-09-08T00:00:00Z',
    };
    const body = bodyOf(
      await buildPaperHtml(makePaper(), [q], {
        mode: 'student',
        layoutConfig: { version: 2 },
      })
    );
    const posA = body.indexOf('data-assets/capture/a.png');
    const posB = body.indexOf('data-assets/capture/b.png');
    expect(posA).toBeGreaterThan(0);
    expect(posB).toBeGreaterThan(posA); // 纯图题原序
  });

  it('多图交错多段：三图三段文本全序（t1-a-t2-b-t3-c）', async () => {
    const q: Question = {
      id: 'multi-fig-q',
      subject: '物理',
      sourceType: 'local',
      sourceDetail: { origin: 'test' },
      content:
        '<div class="question">第一段。' +
        '<figure data-w="100"><img src="data-assets/capture/f1.png"></figure>' +
        '第二段。' +
        '<figure data-w="200"><img src="data-assets/capture/f2.png"></figure>' +
        '第三段。' +
        '<figure data-w="300"><img src="data-assets/capture/f3.png"></figure>' +
        '</div>',
      images: [
        { assetId: 'capture/f1.png', type: 'figure', width: 100 },
        { assetId: 'capture/f2.png', type: 'figure', width: 200 },
        { assetId: 'capture/f3.png', type: 'figure', width: 300 },
      ],
      createdAt: '2026-09-08T00:00:00Z',
      updatedAt: '2026-09-08T00:00:00Z',
    };
    const body = bodyOf(
      await buildPaperHtml(makePaper(), [q], {
        mode: 'student',
        layoutConfig: { version: 2 },
      })
    );
    const order = ['第一段。', 'capture/f1.png', '第二段。', 'capture/f2.png', '第三段。', 'capture/f3.png']
      .map((marker) => body.indexOf(marker));
    for (const pos of order) expect(pos).toBeGreaterThan(0);
    for (let i = 1; i < order.length; i++) {
      expect(order[i]).toBeGreaterThan(order[i - 1]); // 交错序成立
    }
  });

  it('题级覆盖 orderIndex 重排（交错槽位语义）：b 先 a 后，文本段原位不变', async () => {
    const body = bodyOf(
      await buildPaperHtml(makePaper(), [makeFigureQuestion()], {
        mode: 'student',
        assetsRoot: '/tmp/assets',
        layoutConfig: { version: 2 },
        questionLayouts: {
          'fig-q': {
            figures: [
              { assetId: 'capture/a.png', orderIndex: 1 },
              { assetId: 'capture/b.png', orderIndex: 0 },
            ],
          },
        },
      })
    );
    const posT1 = body.indexOf('第一段文字。');
    const posB = body.indexOf('file:///tmp/assets/capture/b.png');
    const posT2 = body.indexOf('第二段文字。');
    const posA = body.indexOf('file:///tmp/assets/capture/a.png');
    expect(posB).toBeGreaterThan(posT1); // 槽位1（原 a 位）填入 orderIndex 最小的 b
    expect(posT2).toBeGreaterThan(posB);
    expect(posA).toBeGreaterThan(posT2); // 槽位2（原 b 位）填入 a
  });

  it('题级 align/widthPercent 覆盖优先于全局（全局 left，a 覆盖 right+50%）', async () => {
    const body = bodyOf(
      await buildPaperHtml(makePaper(), [makeFigureQuestion()], {
        mode: 'student',
        assetsRoot: '/tmp/assets',
        layoutConfig: { version: 2, figureLayout: { mode: 'inline', align: 'left' } },
        questionLayouts: {
          'fig-q': {
            figures: [{ assetId: 'capture/a.png', align: 'right', widthPercent: 50 }],
          },
        },
      })
    );
    expect(body).toContain('figure-block--left'); // b 未覆盖 → 全局 left
    expect(body).toContain('figure-block--right'); // a 覆盖 → right
    // 0067（R-069 授权改写，原断言为 bug 现场）：覆盖档下块边距随 align——right → left:auto / right:0
    // （双 auto 会把块重新居中，压过 align 类 ⇒ 调宽后右对齐视觉失效）
    expect(body).toContain('style="width: 50%; margin-left: auto; margin-right: 0;"');
    expect(body).not.toContain('style="width: 50%; margin-left: auto; margin-right: auto;"');
    // 覆盖缩放后 a 的 data-w 像素宽被剥除（b 未覆盖保留 200px）
    const blockA = body.slice(body.indexOf('figure-block--right'));
    expect(blockA).not.toContain('width: 300px');
    expect(blockA).toContain('width: 100%');
    expect(blockA).toContain('margin-left: auto; margin-right: 0;'); // 断言咬在 a 块自身（非全篇任意命中）
    expect(body).toContain('width: 200px');
  });

  it('side-by-side（全局）→ 题内 flex 行：文本左、图块右栏', async () => {
    const body = bodyOf(
      await buildPaperHtml(makePaper(), [makeFigureQuestion()], {
        mode: 'student',
        layoutConfig: { version: 2, figureLayout: { mode: 'side-by-side', align: 'left' } },
      })
    );
    expect(body).toContain('class="question-row"');
    expect(body).toContain('class="question-content"');
    const sideStart = body.indexOf('class="question-side"');
    const figA = body.indexOf('data-assets/capture/a.png');
    expect(sideStart).toBeGreaterThan(0);
    expect(figA).toBeGreaterThan(sideStart); // 图块在右栏容器内
  });

  it('单图 mode 覆盖：全局 inline 下 a 改 side-by-side → 仅 a 进右栏', async () => {
    const body = bodyOf(
      await buildPaperHtml(makePaper(), [makeFigureQuestion()], {
        mode: 'student',
        layoutConfig: { version: 2 },
        questionLayouts: {
          'fig-q': { figures: [{ assetId: 'capture/a.png', mode: 'side-by-side' }] },
        },
      })
    );
    expect(body).toContain('class="question-row"');
    const sideStart = body.indexOf('class="question-side"');
    const sidePart = body.slice(sideStart);
    expect(sidePart).toContain('data-assets/capture/a.png');
    expect(sidePart).not.toContain('data-assets/capture/b.png'); // b 留文流
    expect(body.slice(0, sideStart)).toContain('data-assets/capture/b.png');
  });
});

describe('0004 渲染探针 — 块化纯函数', () => {
  it('blockify：figure 提取、显式非 figure 语义留文本流', () => {
    const content =
      '<p>题干</p>' +
      '<figure data-w="300"><img src="data-assets/capture/a.png"></figure>' +
      '<span><img data-w="40" src="data-assets/capture/formula.svg"></span>' +
      '<figure data-w="100"><img src="data-assets/capture/ans.png"></figure>';
    const blocks = blockifyQuestionContent(content, {
      'capture/formula.svg': 'formula-image',
      'capture/ans.png': 'answer-image',
    });
    expect(blocks.figures).toHaveLength(1); // 仅 a.png 参与
    expect(blocks.figures[0].assetId).toBe('capture/a.png');
    expect(blocks.textHtml).toContain('formula.svg');
    expect(blocks.textHtml).toContain('ans.png');
    expect(blocks.textHtml).not.toContain('<figure data-w="300"');
  });

  it('applyFigureOverrides：orderIndex 稳定排序（未指定者按 DOM 序排后）', () => {
    const blocks = blockifyQuestionContent(
      '<figure><img src="data-assets/capture/x.png"></figure>' +
        '<figure><img src="data-assets/capture/y.png"></figure>' +
        '<figure><img src="data-assets/capture/z.png"></figure>',
      {}
    );
    const specs = applyFigureOverrides(
      blocks.figures,
      { mode: 'inline', align: 'center' },
      [{ assetId: 'capture/z.png', orderIndex: 0 }]
    );
    expect(specs.map((s) => s.figure.assetId)).toEqual([
      'capture/z.png',
      'capture/x.png',
      'capture/y.png',
    ]);
    expect(specs[1].align).toBe('center');
    expect(specs[1].sideBySide).toBe(false);
  });

  it('blockify 交错段（fix-2 F2-C）：figures 与 segments 图块同序，textHtml = 文本段连接', () => {
    const content =
      '<p>前文。</p>' +
      '<figure><img src="data-assets/capture/a.png"></figure>' +
      '<p>中段。</p>' +
      '<figure><img src="data-assets/capture/b.png"></figure>' +
      '<p>尾段。</p>';
    const blocks = blockifyQuestionContent(content, {});
    expect(blocks.figures.map((f) => f.assetId)).toEqual(['capture/a.png', 'capture/b.png']);
    expect(blocks.segments.map((s) => s.kind)).toEqual(['text', 'figure', 'text', 'figure', 'text']);
    expect(blocks.textHtml).toContain('前文。');
    expect(blocks.textHtml).toContain('中段。');
    expect(blocks.textHtml).toContain('尾段。');
    expect(blocks.textHtml).not.toContain('<figure');
  });

  it('relocateLeadingFigureSegments：题首孤图后移（含选项尾拆分保持居尾）', () => {
    const blocks = blockifyQuestionContent(
      '<div class="question">' +
        '<figure><img src="data-assets/capture/a.png"></figure>' +
        '题干文字。' +
        '<div class="options"><span class="option">A</span></div></div>',
      {}
    );
    const relocated = relocateLeadingFigureSegments(blocks.segments);
    const kinds = relocated.map((s) => (s.kind === 'figure' ? 'F' : 'T'));
    // 首图群（1 图）移到题干文本后、选项段前：T(根开) T(题干) F T(选项+闭)
    expect(kinds).toEqual(['T', 'T', 'F', 'T']);
    const optSeg = relocated[3];
    expect(optSeg.kind === 'text' && optSeg.html.startsWith('<div class="options"')).toBe(true);
  });

  it('relocateLeadingFigureSegments：纯图题/首节点为文本 → 原样返回（同一引用）', () => {
    const pureFig = blockifyQuestionContent(
      '<figure><img src="data-assets/capture/a.png"></figure><figure><img src="data-assets/capture/b.png"></figure>',
      {}
    );
    expect(relocateLeadingFigureSegments(pureFig.segments)).toBe(pureFig.segments);

    const textFirst = blockifyQuestionContent(
      '文本在前。<figure><img src="data-assets/capture/a.png"></figure>',
      {}
    );
    expect(relocateLeadingFigureSegments(textFirst.segments)).toBe(textFirst.segments);
  });

  it('buildRenderSegments：覆盖重排按槽位填充（orderIndex 目标序），缺省原位原序', () => {
    const blocks = blockifyQuestionContent(
      't1<figure><img src="data-assets/capture/a.png"></figure>t2<figure><img src="data-assets/capture/b.png"></figure>t3',
      {}
    );
    const specs = applyFigureOverrides(blocks.figures, { mode: 'inline', align: 'center' }, [
      { assetId: 'capture/a.png', orderIndex: 1 },
      { assetId: 'capture/b.png', orderIndex: 0 },
    ]);
    const rendered = buildRenderSegments(blocks.segments, specs);
    const figureAssets = rendered
      .filter((s): s is { kind: 'figure'; spec: ReturnType<typeof applyFigureOverrides>[number] } => s.kind === 'figure')
      .map((s) => s.spec.figure.assetId);
    // 槽位1（原 a 位）填 b（orderIndex 0），槽位2（原 b 位）填 a（orderIndex 1）
    expect(figureAssets).toEqual(['capture/b.png', 'capture/a.png']);
    // 无覆盖时槽位=原位原序
    const specsDefault = applyFigureOverrides(blocks.figures, { mode: 'inline', align: 'center' });
    const renderedDefault = buildRenderSegments(blocks.segments, specsDefault);
    const defaultAssets = renderedDefault
      .filter((s): s is { kind: 'figure'; spec: FigureRenderSpec } => s.kind === 'figure')
      .map((s) => s.spec.figure.assetId);
    expect(defaultAssets).toEqual(['capture/a.png', 'capture/b.png']);
  });
});

describe('0004 S4 默认观感档 — 块级图 min(原像素宽 96dpi, 60% 版心/列宽)', () => {
  /** 大图题：1031px（实站木板题）+ 800px，另含一张未知尺寸图（data-w=0） */
  function makeBigFigureQuestion(): Question {
    return {
      id: 'big-fig-q',
      subject: '物理',
      sourceType: 'network',
      sourceDetail: { site: 'zujuan' },
      content:
        '<div class="question">如图。' +
        '<figure data-w="1031" data-h="519"><img src="data-assets/capture/big1.png"></figure>' +
        '<figure data-w="800" data-h="400"><img src="data-assets/capture/big2.png"></figure>' +
        '<figure data-w="0" data-h="0"><img src="data-assets/capture/unknown.png"></figure>' +
        '</div>',
      answer: '<p>参考答案内容</p>',
      images: [],
      createdAt: '2026-09-08T00:00:00Z',
      updatedAt: '2026-09-08T00:00:00Z',
    };
  }

  it('大图（1031px/800px）无覆盖 → width 保留原值 + max-width:60% 封顶（≤60% 版心），80% 档不复存在', async () => {
    const body = bodyOf(
      await buildPaperHtml(makePaper(), [makeBigFigureQuestion()], {
        mode: 'student',
        layoutConfig: { version: 2 },
      })
    );
    expect(body).toContain('style="width: 1031px; max-width: 60%; break-inside: avoid;"');
    expect(body).toContain('style="width: 800px; max-width: 60%; break-inside: avoid;"');
    expect(body).not.toContain('max-width: 80%');
  });

  it('小图（200px）无覆盖 → 原宽再现不放大（200px < 60% 档，封顶仅为兜底约束）', async () => {
    const body = bodyOf(
      await buildPaperHtml(makePaper(), [makeFigureQuestion()], {
        mode: 'student',
        layoutConfig: { version: 2 },
      })
    );
    // fig-b 原宽 200px 原样再现（A4 版心 60% ≈ 408px，未触档）；封顶同串存在但 width 主导
    expect(body).toContain('style="width: 200px; max-width: 60%; break-inside: avoid;"');
  });

  it('双列 config + 大图 → column-count:2 + 封顶 60%（CSS 多列下块级 % 宽天然相对列盒，不溢出列）', async () => {
    const html = await buildPaperHtml(makePaper(), [makeBigFigureQuestion()], {
      mode: 'student',
      layoutConfig: A3_SEED,
    });
    expect(html).toContain('column-count: 2');
    expect(html).toContain('column-gap: 8mm');
    const body = bodyOf(html);
    expect(body).toContain('style="width: 1031px; max-width: 60%; break-inside: avoid;"');
    // 块化图块结构在列容器内（.paper-questions 双列 → figure-block % 基准 = 列宽）
    const cols = html.indexOf('column-count: 2');
    const block = body.indexOf('figure-block');
    expect(cols).toBeGreaterThan(0);
    expect(block).toBeGreaterThan(0);
  });

  it('未知尺寸图（data-w=0）无内联样式 → 块化路径按 60% 默认档 CSS 封顶', async () => {
    const html = await buildPaperHtml(makePaper(), [makeBigFigureQuestion()], {
      mode: 'student',
      layoutConfig: { version: 2 },
    });
    // 注入规则：未知尺寸 figure 封顶 60%
    expect(html).toContain('.figure-block > figure:not([style]) { max-width: 60%; }');
    const body = bodyOf(html);
    // 元素无内联宽度样式，尺寸交 CSS 档位约束
    expect(body).toMatch(/<figure data-w="0" data-h="0"><img src="data-assets\/capture\/unknown.png"><\/figure>/);
  });

  it('题级 widthPercent 覆盖仍优先于默认档（大图 1031px 覆盖 30% → 像素宽剥除、块宽 30%）', async () => {
    const body = bodyOf(
      await buildPaperHtml(makePaper(), [makeBigFigureQuestion()], {
        mode: 'student',
        layoutConfig: { version: 2 },
        questionLayouts: {
          'big-fig-q': { figures: [{ assetId: 'capture/big1.png', widthPercent: 30 }] },
        },
      })
    );
    expect(body).toContain('style="width: 30%; margin-left: auto; margin-right: auto;"');
    const blockA = body.slice(body.indexOf('figure-block--center'));
    expect(blockA).not.toContain('width: 1031px');
    expect(blockA).toContain('width: 100%');
    // 未覆盖的 800px 图保持默认档
    expect(body).toContain('style="width: 800px; max-width: 60%; break-inside: avoid;"');
  });
});

describe('0004 渲染探针 — 无 config 基线一致', () => {
  it('无 layoutConfig/questionLayouts → 基线输出（无注入块/无结构类/figure 原位）', async () => {
    const html = await buildPaperHtml(makePaper(), [makeFigureQuestion()], { mode: 'student' });
    expect(html).not.toContain('size: A3');
    expect(html).not.toContain('column-count');
    expect(html).not.toContain('.figure-block');
    expect(html).not.toContain('paper-logo');
    expect(html).not.toContain('answer-space');
    expect(html).not.toContain('question-row');
    const body = bodyOf(html);
    expect(body).not.toContain('figure-block');
    expect(body).not.toContain('figure-flow');
    // 基线 figure 行为：data-w 转 px 宽 + 60% 默认观感档封顶（0004 S4 基线演进，原 80%），原位输出（不块化）
    expect(body).toMatch(/<figure class="fig-a"\s+style="width: 300px; max-width: 60%; break-inside: avoid;">/);
    expect(body.indexOf('第一段文字。')).toBeLessThan(body.indexOf('data-assets/capture/a.png'));
    expect(body.indexOf('第二段文字。')).toBeGreaterThan(body.indexOf('data-assets/capture/a.png'));
    expect(html).toContain('--mf-font-size: 12pt'); // paper.css 基础层变量默认值
  });

  it('空 questionLayouts（{}）→ config 路径激活但覆盖缺省=原位/全局值（fix-2：交错序）', async () => {
    const body = bodyOf(
      await buildPaperHtml(makePaper(), [makeFigureQuestion()], {
        mode: 'teacher',
        questionLayouts: {},
      })
    );
    const posT1 = body.indexOf('第一段文字。');
    const posA = body.indexOf('data-assets/capture/a.png');
    const posT2 = body.indexOf('第二段文字。');
    expect(posA).toBeGreaterThan(posT1); // 文中图原位
    expect(posT2).toBeGreaterThan(posA);
    expect(body).toContain('答案：'); // teacher 基线显答案
  });
});

describe('0004 渲染探针 — buildLayoutCss 值驱动项', () => {
  it('双列注入列规则；单栏不注入', () => {
    const two = buildLayoutCss(resolveLayout({ ...A3_SEED }));
    expect(two).toContain('column-count: 2');
    const one = buildLayoutCss(resolveLayout({ version: 2 }));
    expect(one).not.toContain('column-count');
  });

  // 0007 P4：column-count 收敛 @media screen——屏显连续视图保留浏览器分列；
  // 打印/导出一律走页化手工列盒（preview-frame-runtime planColumns），Chromium 打印断列路径退役
  it('0007 P4：双列 column-count 收敛屏显（打印不再依赖浏览器断列）', () => {
    const css = buildLayoutCss(resolveLayout({ ...A3_SEED }));
    expect(css).toContain('@media screen { .paper-questions { column-count: 2; column-gap: 8mm; } }');
    expect(css).not.toContain('@media print { .paper-questions');
  });

  it('lineHeight 缺省（null）不注入行距变量（保持基线双值 1.8/2）', () => {
    const css = buildLayoutCss(resolveLayout(undefined));
    expect(css).not.toContain('--mf-line-height');
    expect(css).toContain('--mf-font-size: 12pt');
  });

  it('作答区规则仅 enabled 时注入', () => {
    expect(buildLayoutCss(resolveLayout({ version: 2, answerSpace: { enabled: true, style: 'blank' } }))).toContain(
      '.answer-space'
    );
    expect(buildLayoutCss(resolveLayout({ version: 2 }))).not.toContain('.answer-space');
  });
});

// ==================== 0004 Phase 5（S5）：全局图宽档 + figure 块 src 重写防裂图 ====================

describe('0004 Phase 5 渲染探针 — 全局 figureLayout.widthPercent 档与 src 重写', () => {
  it('全局 widthPercent=40 → 题级未覆盖图缩放 40%；题级覆盖 25 优先于全局 40', async () => {
    const body = bodyOf(
      await buildPaperHtml(makePaper(), [makeFigureQuestion()], {
        mode: 'student',
        layoutConfig: { version: 2, figureLayout: { mode: 'inline', align: 'center', widthPercent: 40 } },
        questionLayouts: {
          'fig-q': { figures: [{ assetId: 'capture/a.png', widthPercent: 25 }] },
        },
      })
    );
    // a 题级覆盖 25 优先于全局 40（像素宽剥除、块宽 25%）
    expect(body).toContain('style="width: 25%; margin-left: auto; margin-right: auto;"');
    // b 未题级覆盖 → 全局 40 生效（原 200px 剥除）
    expect(body).toContain('style="width: 40%; margin-left: auto; margin-right: auto;"');
  });

  it('全局 widthPercent 缺省（undefined/null）→ 默认观感档（60% 封顶串在，无 % 缩放）', async () => {
    const body = bodyOf(
      await buildPaperHtml(makePaper(), [makeFigureQuestion()], {
        mode: 'student',
        layoutConfig: { version: 2, figureLayout: { mode: 'inline', align: 'center' } },
      })
    );
    // 无 % 块样式（默认档=保留 data-w 像素宽 + 60% 封顶）
    expect(body).not.toContain('margin-left: auto; margin-right: auto;"');
    expect(body).toContain('max-width: 60%');
  });

  it('resolveLayout：widthPercent 非法值（0/120/非数值）归一为 null（默认档）', () => {
    expect(resolveLayout({ version: 2, figureLayout: { widthPercent: 0 } }).figureLayout.widthPercent).toBeNull();
    expect(resolveLayout({ version: 2, figureLayout: { widthPercent: 120 } }).figureLayout.widthPercent).toBeNull();
    expect(resolveLayout({ version: 2 }).figureLayout.widthPercent).toBeNull();
    expect(resolveLayout({ version: 2, figureLayout: { widthPercent: 45 } }).figureLayout.widthPercent).toBe(45);
  });

  it('S4 遗留#1 防裂图：有资产根时 figure 块 src 重写为 file:///（config 路径导出/预览不再裂图）', async () => {
    const body = bodyOf(
      await buildPaperHtml(makePaper(), [makeFigureQuestion()], {
        mode: 'student',
        assetsRoot: '/tmp/assets',
        layoutConfig: { version: 2, figureLayout: { mode: 'side-by-side' } },
      })
    );
    // 题级覆盖（side-by-side 右栏）与文流两条路径的图块 src 都过 rewriteDataAssetSrcs
    expect(body).toContain('src="file:///tmp/assets/capture/a.png"');
    expect(body).toContain('src="file:///tmp/assets/capture/b.png"');
    expect(body).not.toContain('src="data-assets/');
  });

  it('S4 形态锚定保持：无资产根（vitest 缺省）时 figure 块保留 data-assets 原始形态', async () => {
    const body = bodyOf(
      await buildPaperHtml(makePaper(), [makeFigureQuestion()], {
        mode: 'student',
        layoutConfig: { version: 2 },
      })
    );
    expect(body).toContain('<img src="data-assets/capture/a.png">');
  });
});

// ==================== 0013 选项版式三态（auto 竖排 / 单行 1×N / 两行均分） ====================

/** 选择题 fixture：4 选项，B 含行内 KaTeX 公式（严格子代/公式完整性探针） */
function makeChoiceQuestion(): Question {
  return {
    id: 'choice-q',
    subject: '物理',
    sourceType: 'local',
    sourceDetail: { origin: 'test' },
    content:
      '<div class="question">下列单位与其对应物理量正确的是？' +
      '<div class="options">' +
      '<span class="option">A. 牛顿——力</span>' +
      '<span class="option">B. <span class="math" data-tex="\\mathrm{N}" data-display="false"></span>——压强</span>' +
      '<span class="option">C. 焦耳——功</span>' +
      '<span class="option">D. 瓦特——功率</span>' +
      '</div></div>',
    images: [],
    createdAt: '2026-09-13T00:00:00Z',
    updatedAt: '2026-09-13T00:00:00Z',
  };
}

/** 从渲染产物截取 .options 容器块（容器内无嵌套 div，首个 </div> 即容器闭合） */
function optionsBlockOf(body: string): string {
  const start = body.indexOf('<div class="options">');
  expect(start).toBeGreaterThan(-1);
  const end = body.indexOf('</div>', start);
  return body.slice(start, end + '</div>'.length);
}

describe('0013 选项版式 — 归一化单源（normalizeOptionsLayout / resolveLayout）', () => {
  it('normalizeOptionsLayout：三合法值透传，非法/缺省回 auto', () => {
    expect(normalizeOptionsLayout('auto')).toBe('auto');
    expect(normalizeOptionsLayout('single-line')).toBe('single-line');
    expect(normalizeOptionsLayout('two-lines')).toBe('two-lines');
    expect(normalizeOptionsLayout('bogus')).toBe('auto');
    expect(normalizeOptionsLayout(undefined)).toBe('auto');
    expect(normalizeOptionsLayout('')).toBe('auto');
  });

  it('resolveLayout 卷级：合法值落定；非法值（外部 JSON）归一 auto；缺省 auto', () => {
    expect(resolveLayout({ version: 2, optionsLayout: 'single-line' }).optionsLayout).toBe('single-line');
    expect(resolveLayout({ version: 2, optionsLayout: 'two-lines' }).optionsLayout).toBe('two-lines');
    expect(resolveLayout({ version: 2, optionsLayout: 'auto' }).optionsLayout).toBe('auto');
    const bad = JSON.parse('{"version":2,"optionsLayout":"bogus"}') as PaperLayoutConfig;
    expect(resolveLayout(bad).optionsLayout).toBe('auto');
    expect(resolveLayout(undefined).optionsLayout).toBe('auto');
    expect(resolveLayout({ version: 1 }).optionsLayout).toBe('auto');
  });
});

describe('0013 选项版式 — 渲染类名输出（题容器）', () => {
  it('单行 → question-item ol-single；两行 → question-item ol-two；缺省/auto 不加类（零回归）', async () => {
    const single = bodyOf(
      await buildPaperHtml(makePaper(), [makeChoiceQuestion()], {
        mode: 'student',
        layoutConfig: { version: 2, optionsLayout: 'single-line' },
      })
    );
    expect(single).toContain('<div class="question-item ol-single">');
    expect(single).not.toContain('ol-two');

    const two = bodyOf(
      await buildPaperHtml(makePaper(), [makeChoiceQuestion()], {
        mode: 'student',
        layoutConfig: { version: 2, optionsLayout: 'two-lines' },
      })
    );
    expect(two).toContain('<div class="question-item ol-two">');
    expect(two).not.toContain('ol-single');

    const auto = bodyOf(
      await buildPaperHtml(makePaper(), [makeChoiceQuestion()], {
        mode: 'student',
        layoutConfig: { version: 2 },
      })
    );
    expect(auto).toContain('<div class="question-item">');
    expect(auto).not.toContain('ol-single');
    expect(auto).not.toContain('ol-two');
  });

  it('基线路径（无 config 无覆盖）恒不加类（与历史逐字节一致）', async () => {
    const body = bodyOf(
      await buildPaperHtml(makePaper(), [makeChoiceQuestion()], { mode: 'student' })
    );
    expect(body).toContain('<div class="question-item">');
    expect(body).not.toContain('ol-single');
    expect(body).not.toContain('ol-two');
  });

  it('非法值三态回退：卷级非法 → 无类（auto）', async () => {
    const body = bodyOf(
      await buildPaperHtml(makePaper(), [makeChoiceQuestion()], {
        mode: 'student',
        layoutConfig: JSON.parse('{"version":2,"optionsLayout":"bogus"}') as PaperLayoutConfig,
      })
    );
    expect(body).toContain('<div class="question-item">');
    expect(body).not.toContain('ol-single');
    expect(body).not.toContain('ol-two');
  });
});

describe('0013 选项版式 — 生效值优先序（题级覆盖 ?? 卷级 ?? auto）', () => {
  it('题级胜卷级：题级 two-lines × 卷级 single-line → ol-two', async () => {
    const body = bodyOf(
      await buildPaperHtml(makePaper(), [makeChoiceQuestion()], {
        mode: 'student',
        layoutConfig: { version: 2, optionsLayout: 'single-line' },
        questionLayouts: { 'choice-q': { optionsLayout: 'two-lines' } },
      })
    );
    expect(body).toContain('<div class="question-item ol-two">');
    expect(body).not.toContain('ol-single');
  });

  it('题级缺省落卷级：覆盖条目存在但无 optionsLayout 键 → 卷级生效', async () => {
    const body = bodyOf(
      await buildPaperHtml(makePaper(), [makeChoiceQuestion()], {
        mode: 'student',
        layoutConfig: { version: 2, optionsLayout: 'two-lines' },
        questionLayouts: { 'choice-q': {} },
      })
    );
    expect(body).toContain('<div class="question-item ol-two">');
  });

  it('题级非法值归一 auto（显式覆盖回自动，不落卷级档）', async () => {
    const body = bodyOf(
      await buildPaperHtml(makePaper(), [makeChoiceQuestion()], {
        mode: 'student',
        layoutConfig: { version: 2, optionsLayout: 'single-line' },
        questionLayouts: JSON.parse(
          '{"choice-q":{"optionsLayout":"bogus"}}'
        ) as Record<string, { optionsLayout?: 'auto' | 'single-line' | 'two-lines' }>,
      })
    );
    expect(body).toContain('<div class="question-item">');
    expect(body).not.toContain('ol-single');
    expect(body).not.toContain('ol-two');
  });
});

describe('0013 选项版式 — 结构安全（无选项题不误伤 / 公式完整）', () => {
  it('阅读大题（无 .options 容器）天然不命中：题面原序零变化', async () => {
    const reading: Question = {
      id: 'reading-q',
      subject: '语文',
      sourceType: 'local',
      sourceDetail: { origin: 'test' },
      content: '<p>阅读下面文段。</p><p>第二段落原文。</p><table><tr><td>表格题干</td></tr></table>',
      images: [],
      createdAt: '2026-09-13T00:00:00Z',
      updatedAt: '2026-09-13T00:00:00Z',
    };
    const body = bodyOf(
      await buildPaperHtml(makePaper(), [reading], {
        mode: 'student',
        layoutConfig: { version: 2, optionsLayout: 'single-line' },
      })
    );
    // 无 .options 容器 → 分列规则无目标（零误伤）；题面内容原序
    expect(body).not.toContain('class="options"');
    expect(body.indexOf('阅读下面文段。')).toBeLessThan(body.indexOf('第二段落原文。'));
    expect(body).toContain('表格题干');
  });

  it('选项含 KaTeX 公式在单行横排下结构完整：.options 直接子代仍为 4 个 .option，公式在位', async () => {
    const body = bodyOf(
      await buildPaperHtml(makePaper(), [makeChoiceQuestion()], {
        mode: 'student',
        layoutConfig: { version: 2, optionsLayout: 'single-line' },
      })
    );
    const optionsBlock = optionsBlockOf(body);
    // 严格子代：容器直接以 option 开头、以最后一个 option 闭合（中间无层级破坏）
    expect(optionsBlock.startsWith('<div class="options"><span class="option">')).toBe(true);
    expect(optionsBlock.endsWith('</span></div>')).toBe(true);
    expect((optionsBlock.match(/<span class="option">/g) ?? []).length).toBe(4);
    // 公式已渲染（katex 输出）且仍在 B 选项内部（未被横排结构破坏）
    expect((optionsBlock.match(/class="katex"/g) ?? []).length).toBe(1);
    expect(optionsBlock.indexOf('class="katex"')).toBeGreaterThan(optionsBlock.indexOf('B. '));
  });
});

describe('0013 选项版式 — CSS 三处同步（paper.css 基础层 + buildLayoutCss 注入 + 严格子选择器）', () => {
  it('buildLayoutCss 注入三组规则（ol-single/ol-two/break-inside），全严格子选择器', () => {
    const css = buildLayoutCss(resolveLayout({ version: 2, optionsLayout: 'two-lines' }));
    expect(css).toContain('.options { break-inside: avoid; }');
    expect(css).toContain('.ol-single .options { display: flex; gap: 1.2em; }');
    expect(css).toContain('.ol-single .options > .option { display: block; flex: 1 1 0; padding-left: 0; }');
    expect(css).toContain('.ol-two .options { display: grid; grid-template-columns: 1fr 1fr; column-gap: 1.2em; }');
    expect(css).toContain('.ol-two .options > .option { display: block; padding-left: 0; }');
  });

  it('paper.css 基础层同步（config 路径产物内联可见；auto 缺省下规则在而类不在，观感零变化）', async () => {
    const html = await buildPaperHtml(makePaper(), [makeChoiceQuestion()], {
      mode: 'student',
      layoutConfig: { version: 2 },
    });
    expect(html).toContain('.options { break-inside: avoid; }');
    expect(html).toContain('.ol-single .options > .option');
    expect(html).toContain('.ol-two .options > .option');
    expect(bodyOf(html)).toContain('<div class="question-item">');
  });
});
