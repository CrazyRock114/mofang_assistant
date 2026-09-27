// B1-fix: 浏览器渲染漂移回归测试
// 测试 buildPaperHtml.browser.ts 的行为（UI 实际路径）

import { describe, it, expect, beforeEach } from 'vitest';
import type { Paper, Question } from '../../src/shared/contracts/bank-types.js';
import { MockBankService } from '../../src/bank/mock/mock-bank.js';

describe('Browser Rendering Fidelity (buildPaperHtml.browser.ts)', () => {
  let mockService: MockBankService;
  let mockQuestions: Question[];

  beforeEach(async () => {
    mockService = new MockBankService();
    mockQuestions = await mockService.listQuestions();
  });

  it('[A] 教师版公式必须渲染为 KaTeX（不能残留 data-tex）', async () => {
    // 动态导入浏览器版本
    const { buildPaperHtml } = await import('../../src/docgen/render/buildPaperHtml.browser.js');

    const paper: Paper = {
      id: 'browser-test',
      title: '浏览器公式测试',
      config: {},
      createdAt: '2026-01-01T00:00:00Z',
      archived: false,
    };

    // q1 包含契约格式公式：<span class="math" data-tex="E_k = \frac{1}{2}mv^2">
    const html = await buildPaperHtml(paper, [mockQuestions[0]], { mode: 'teacher' });

    // 公式必须渲染为 KaTeX
    expect(html, 'browser 版必须渲染公式为 class="katex"').toContain('class="katex"');
    // 不应残留未处理的 data-tex 属性
    expect(html, 'browser 版不应残留 data-tex 属性').not.toMatch(/data-tex="/);
  });

  it('[B] 学生版手录形态题不能泄漏答案', async () => {
    // 动态导入浏览器版本
    const { buildPaperHtml } = await import('../../src/docgen/render/buildPaperHtml.browser.js');

    // 模拟手录题（content 内含 <div class="answer">）
    const manualQuestion: Question = {
      id: 'manual-q1',
      content: `
        <div class="stem">
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
    expect(html, 'browser 版学生版不应包含答案块').not.toContain('class="answer"');
    // 不应泄漏答案文本
    expect(html, 'browser 版学生版不应泄漏答案内容').not.toContain('秘密答案XYZ');
  });

  it('[C] prompt/alert 不应在渲染逻辑中出现', async () => {
    // 这个测试确保渲染函数本身不调用 prompt/alert
    // 实际的 prompt 替换在 Phase 2 处理（UI 组件层面）
    const { buildPaperHtml } = await import('../../src/docgen/render/buildPaperHtml.browser.js');

    const paper: Paper = {
      id: 'prompt-test',
      title: 'Prompt 测试',
      config: {},
      createdAt: '2026-01-01T00:00:00Z',
      archived: false,
    };

    // 渲染不应抛异常（如果内部有 prompt 调用会抛）
    await expect(
      buildPaperHtml(paper, [mockQuestions[0]], { mode: 'student' })
    ).resolves.toBeTruthy();
  });
});
