// Phase 1: 渲染层测试 — buildPaperHtml 结构化断言

import { describe, it, expect, beforeEach } from 'vitest';
import type { Paper, Question } from '../../src/shared/contracts/bank-types.js';
import { buildPaperHtml, rewriteKatexFontUrls } from '../../src/docgen/render/buildPaperHtml.js';
import { MockBankService } from '../../src/bank/mock/mock-bank.js';

describe('Paper Rendering', () => {
  let mockService: MockBankService;
  let mockQuestions: Question[];

  beforeEach(async () => {
    mockService = new MockBankService();
    // 使用 mock 预置的 5 道题（q1–q5）
    mockQuestions = await mockService.listQuestions();
  });

  it('学生版不含答案块和答案字段', async () => {
    const paper: Paper = {
      id: 'test-paper',
      title: '学生版测试卷',
      config: { duration: 90, totalScore: 100 },
      createdAt: '2026-01-01T00:00:00Z',
      archived: false,
    };

    // 取前 3 题（q1, q2, q3 都有答案）
    const questions = mockQuestions.slice(0, 3);
    const html = await buildPaperHtml(paper, questions, { mode: 'student' });

    // 学生版不应包含答案块
    expect(html).not.toContain('class="answer"');
    // 不应包含答案字段文本（q1 答案中含 "机械能守恒"）
    expect(html).not.toContain('机械能守恒');
    // 不应包含解析字段文本
    expect(html).not.toContain('本题考查');
  });

  it('教师版含红色答案', async () => {
    const paper: Paper = {
      id: 'test-paper',
      title: '教师版测试卷',
      config: { duration: 90, totalScore: 100 },
      createdAt: '2026-01-01T00:00:00Z',
      archived: false,
    };

    const questions = mockQuestions.slice(0, 2); // q1, q2
    const html = await buildPaperHtml(paper, questions, { mode: 'teacher' });

    // 教师版应包含答案（红色或带"答案："标记）
    expect(html).toContain('答案：');
    // q1 答案内容应该存在
    expect(html).toContain('机械能守恒');
    // q2 解析内容应该存在
    expect(html).toContain('本题考查');
  });

  // D1-fix-4 J-10（实站复验：答案公式正常、解析公式丢失）：
  // 教师版 q.answer 过 renderMath，q.analysis 漏了 → 解析内 span.math[data-tex] 空壳原样输出
  it('教师版解析字段的公式渲染为 KaTeX，无 data-tex 残留（与答案字段同管线）', async () => {
    const paper: Paper = {
      id: 'j10-paper',
      title: '解析公式测试卷',
      config: {},
      createdAt: '2026-01-01T00:00:00Z',
      archived: false,
    };
    const q: Question = {
      ...mockQuestions[0],
      id: 'j10-q',
      answer: '<span class="math" data-tex="B"></span>',
      analysis: '解：由 <span class="math" data-tex="\\frac{2v}{g}"></span> 可得。',
    };

    const html = await buildPaperHtml(paper, [q], { mode: 'teacher' });

    // 解析字段内不得残留未渲染的 data-tex 空壳
    expect(html).not.toContain('data-tex="\\frac{2v}{g}"');
    // 解析区内公式已 KaTeX 化
    const analysisPart = html.slice(html.indexOf('解析：'));
    expect(analysisPart).toContain('class="katex"');
  });

  it('公式渲染为 KaTeX 标记', async () => {
    const paper: Paper = {
      id: 'test-paper',
      title: '公式测试卷',
      config: {},
      createdAt: '2026-01-01T00:00:00Z',
      archived: false,
    };

    // q1 包含公式 E_k = \frac{1}{2}mv^2
    const questions = [mockQuestions[0]];
    const html = await buildPaperHtml(paper, questions, { mode: 'student' });

    // 应该包含 KaTeX 渲染后的 class
    expect(html).toContain('class="katex"');
    // 不应该有未渲染的 data-tex 残留
    expect(html).not.toContain('data-tex="E_k');
  });

  it('figure 的 data-w 转为 width style', async () => {
    const paper: Paper = {
      id: 'test-paper',
      title: 'Figure 测试卷',
      config: {},
      createdAt: '2026-01-01T00:00:00Z',
      archived: false,
    };

    // q3 包含 figure data-w="300"
    const questions = [mockQuestions[2]];
    const html = await buildPaperHtml(paper, questions, { mode: 'student' });

    // figure 应该有 width style
    expect(html).toMatch(/width:\s*300px/);
    // 应该有 break-inside: avoid
    expect(html).toContain('break-inside: avoid');
  });

  it('选项结构渲染完整', async () => {
    const paper: Paper = {
      id: 'test-paper',
      title: '选择题测试卷',
      config: {},
      createdAt: '2026-01-01T00:00:00Z',
      archived: false,
    };

    // q2 是选择题，有 options 结构
    const questions = [mockQuestions[1]];
    const html = await buildPaperHtml(paper, questions, { mode: 'student' });

    // 应该包含选项结构
    expect(html).toContain('class="options"');
    expect(html).toContain('class="option"');
    expect(html).toContain('A. 力是产生加速度的原因');
  });

  it('题号自动编号且分值显示', async () => {
    const paper: Paper = {
      id: 'test-paper',
      title: '编号测试卷',
      config: { totalScore: 60 },
      createdAt: '2026-01-01T00:00:00Z',
      archived: false,
    };

    // 模拟带分值的题目（手动创建，因为 mock 预置题没有 score）
    const q1 = mockQuestions[0];
    const q2 = mockQuestions[1];

    const html = await buildPaperHtml(paper, [q1, q2], { mode: 'student', scores: [20, 15] });

    // 应该有题号 1、2（不依赖题目内部的 data-qno）
    expect(html).toMatch(/>\s*1[.、]/);
    expect(html).toMatch(/>\s*2[.、]/);
    // 应该显示分值
    expect(html).toContain('(20分)');
    expect(html).toContain('(15分)');
  });

  it('试卷骨架包含标题栏和页脚', async () => {
    const paper: Paper = {
      id: 'test-paper',
      title: '骨架测试卷',
      config: { duration: 120, totalScore: 150 },
      createdAt: '2026-01-01T00:00:00Z',
      archived: false,
    };

    const html = await buildPaperHtml(paper, [mockQuestions[0]], { mode: 'student' });

    // 标题栏
    expect(html).toContain('骨架测试卷');
    expect(html).toContain('总分');
    expect(html).toContain('150');
    expect(html).toContain('时长');
    expect(html).toContain('120');
    // 页脚（页码占位）
    expect(html).toMatch(/pageNumber|totalPages|页码/);
  });
});

// B1-fix: 浏览器渲染漂移回归测试（RED → GREEN）
describe('B1-fix: Browser Rendering Fidelity', () => {
  let mockService: MockBankService;
  let mockQuestions: Question[];

  beforeEach(async () => {
    mockService = new MockBankService();
    mockQuestions = await mockService.listQuestions();
  });

  it('[A] 教师版公式渲染且无 data-tex 残留', async () => {
    const paper: Paper = {
      id: 'browser-test',
      title: '浏览器渲染测试',
      config: {},
      createdAt: '2026-01-01T00:00:00Z',
      archived: false,
    };

    // q1 包含公式
    const html = await buildPaperHtml(paper, [mockQuestions[0]], { mode: 'teacher' });

    // 公式必须渲染为 KaTeX
    expect(html).toContain('class="katex"');
    // 不应残留 data-tex 属性
    expect(html).not.toMatch(/data-tex="/);
  });

  it('[B] 学生版手录形态题无答案泄漏', async () => {
    // 模拟手录题（content 内含 <div class="answer">）
    const manualQuestion: Question = {
      id: 'manual-q1',
      content: `
        <div class="question stem">
          <p>简答题：请解释牛顿第一定律。</p>
          <div class="answer">
            <p>秘密答案XYZ：物体不受外力或受力平衡时，保持静止或匀速直线运动。</p>
          </div>
        </div>
      `,
      sourceType: 'local',
      sourceDetail: { origin: 'manual' },
      answer: '',
      analysis: '',
      createdAt: '2026-01-01T00:00:00Z',
    };

    const paper: Paper = {
      id: 'student-leak-test',
      title: '学生版泄漏测试',
      config: {},
      createdAt: '2026-01-01T00:00:00Z',
      archived: false,
    };

    const html = await buildPaperHtml(paper, [manualQuestion], { mode: 'student' });

    // 学生版不应包含答案块
    expect(html).not.toContain('class="answer"');
    // 不应泄漏答案文本
    expect(html).not.toContain('秘密答案XYZ');
  });
});

// B1-fix-2: PDF 输出质量回归测试
describe('B1-fix-2: PDF Output Quality', () => {
  let mockService: MockBankService;
  let mockQuestions: Question[];

  beforeEach(async () => {
    mockService = new MockBankService();
    mockQuestions = await mockService.listQuestions();
  });

  it('[N-2] KaTeX 字体 URL 改写为绝对路径', async () => {
    const paper: Paper = {
      id: 'font-path-test',
      title: 'KaTeX 字体路径测试',
      config: {},
      createdAt: '2026-01-01T00:00:00Z',
      archived: false,
    };

    const html = await buildPaperHtml(paper, [mockQuestions[0]], { mode: 'teacher' });

    // 不应存在相对路径 url(fonts/
    const relativeUrlCount = (html.match(/url\(fonts\//g) || []).length;
    expect(relativeUrlCount).toBe(0);

    // 应该包含绝对 file:// 路径
    expect(html).toMatch(/url\(file:\/\/\/.+\/fonts\//);
  });

  it('[N-3] 从任意 cwd 调用 buildPaperHtml 不抛异常', async () => {
    const paper: Paper = {
      id: 'cwd-test',
      title: 'CWD 独立性测试',
      config: {},
      createdAt: '2026-01-01T00:00:00Z',
      archived: false,
    };

    const originalCwd = process.cwd();

    try {
      // 切换到系统临时目录
      const tmpDir = require('node:os').tmpdir();
      process.chdir(tmpDir);

      // 应该能正常渲染
      const html = await buildPaperHtml(paper, [mockQuestions[0]], { mode: 'student' });
      expect(html).toContain('class="paper"');
      // KaTeX CSS 应该已内联（检查 KaTeX 特征）
      expect(html).toContain('font-family:KaTeX_Main');
    } finally {
      // 恢复原始 cwd
      process.chdir(originalCwd);
    }
  });

  it('[Q-1] rewriteKatexFontUrls 改写相对路径为绝对路径', () => {
    const inputWithRelative = `
      <style>
        @font-face { font-family: 'KaTeX_Main'; src: url(fonts/KaTeX_Main-Regular.woff2); }
        @font-face { font-family: 'KaTeX_Math'; src: url(fonts/KaTeX_Math-Italic.woff2); }
      </style>
    `;

    const result = rewriteKatexFontUrls(inputWithRelative);

    // 应该没有相对路径残留
    const relativeCount = (result.match(/url\(fonts\//g) || []).length;
    expect(relativeCount).toBe(0);

    // 应该包含绝对 file:// 路径
    expect(result).toMatch(/url\(file:\/\/\/.+katex\/dist\/fonts\//i);
  });

  it('[Q-1] rewriteKatexFontUrls 对无相对路径输入原样返回', () => {
    const inputWithoutRelative = `
      <style>
        body { font-family: sans-serif; }
      </style>
    `;

    const result = rewriteKatexFontUrls(inputWithoutRelative);
    expect(result).toBe(inputWithoutRelative);
  });

  it('[Q-1 用户路径回归] browser 风格 HTML 经改写后无相对路径残留', () => {
    // 模拟 browser 入口产物（vite 打包后的 katex.min.css 未改写）
    const browserStyleHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          /* katex.min.css 原始内容 */
          @font-face{font-family:KaTeX_AMS;font-style:normal;font-weight:400;src:url(fonts/KaTeX_AMS-Regular.woff2) format("woff2")}
          @font-face{font-family:KaTeX_Main;font-style:normal;font-weight:400;src:url(fonts/KaTeX_Main-Regular.woff2) format("woff2")}
          @font-face{font-family:KaTeX_Math;font-style:italic;font-weight:400;src:url(fonts/KaTeX_Math-Italic.woff2) format("woff2")}
        </style>
      </head>
      <body>
        <span class="katex">E=mc^2</span>
      </body>
      </html>
    `;

    const rewritten = rewriteKatexFontUrls(browserStyleHtml);

    // 防三犯：browser 路径也必须改写干净
    const relativeCount = (rewritten.match(/url\(fonts\//g) || []).length;
    expect(relativeCount).toBe(0);

    // 必须包含绝对路径
    expect(rewritten).toMatch(/url\(file:\/\/\/.+katex\/dist\/fonts\//i);
  });
});



describe('D1-fix R-5：inline-figure 渲染配套', () => {
  const paper: Paper = {
    id: 'p-inline',
    title: '行内公式图测试卷',
    config: {},
    createdAt: '2026-09-05T00:00:00Z',
    archived: false,
  };

  function makeQuestion(content: string): Question {
    return {
      id: 'q-inline',
      subject: '物理',
      sourceType: 'network',
      sourceDetail: { site: 'zujuan' },
      content,
      images: [],
      createdAt: '2026-09-05T00:00:00Z',
      updatedAt: '2026-09-05T00:00:00Z',
    };
  }

  it('inline-figure 小图：data-w 转 img 行内 width style，宽度受约束', async () => {
    const q = makeQuestion(
      '<div class="question">高度为<span class="inline-figure"><img class="q-figure" data-w="42" data-h="15" src="data-assets/capture/zujuan/q-1.svg"></span>，求速度。</div>',
    );
    const html = await buildPaperHtml(paper, [q], { mode: 'student', assetsRoot: '/tmp/assets' });

    // img 带宽度 style（再现网页预览大小）
    expect(html).toMatch(/<img class="q-figure"[^>]*style="width: 42px;"/);
    // 仍在文字流中（inline-figure 未被块级化）
    expect(html).toContain('<span class="inline-figure">');
  });

  it('figure data-w="0"（尺寸未知）不产生 width:0 样式，按 max-width 限', async () => {
    const q = makeQuestion(
      '<div class="question">如图<figure class="diagram" data-w="0" data-h="0"><img class="q-figure" src="data-assets/capture/zujuan/q-2.png"></figure></div>',
    );
    const html = await buildPaperHtml(paper, [q], { mode: 'student', assetsRoot: '/tmp/assets' });

    expect(html).not.toContain('width: 0px');
    expect(html).toContain('<figure class="diagram"');
  });

  it('块级大图 data-w=1031（实站木板题配图）：width 保留原值但 max-width:60% 封顶版心（0004 S4 默认观感档）', async () => {
    // D1-fix-2 实站复验：data-w 转 width:1031px 后无封顶，A4 版心（约 180mm≈680px）被撑爆；
    // D1-fix-3 J-3：封顶由 100% 收紧为 80%；0004 S4：按用户拍板收敛到 60%（对齐采集预览观感）
    const q = makeQuestion(
      '<div class="question">如图<figure class="diagram" data-w="1031" data-h="519"><img class="q-figure" src="data-assets/capture/zujuan/q-3.png"></figure></div>',
    );
    const html = await buildPaperHtml(paper, [q], { mode: 'student', assetsRoot: '/tmp/assets' });

    expect(html).toMatch(/<figure[^>]*style="[^"]*width:\s*1031px/);
    expect(html).toMatch(/<figure[^>]*style="[^"]*max-width:\s*60%/);
    expect(html).not.toMatch(/<figure[^>]*style="[^"]*max-width:\s*80%/);
  });

  it('paper.css 含 .inline-figure 行内样式规则（内联进渲染产物）', async () => {
    const q = makeQuestion('<div class="question">题干</div>');
    const html = await buildPaperHtml(paper, [q], { mode: 'student' });

    expect(html).toContain('.inline-figure');
    expect(html).toMatch(/\.inline-figure\s*\{[^}]*display:\s*inline-block/);
  });
});
