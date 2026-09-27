// 0004-fix-1b 题库浏览器交互测试 — jsdom + Mock(in-memory) 注入单跑（照 basket-pages.test.tsx 模式）
// 覆盖：题卡直显（完整题干 + KaTeX + 图随内容流，data-assets 解析 file:///；无文本摘要/图计数徽标/两级展开）；
// 题干 stemHtml 优先回落 content；结构化 options → .options > .option（标号前置）；无选项题不渲染选项容器；
// 答案/解析折叠（默认收起、点开红字 #d32f2f、无内容钮灰显不可点）；
// 客户端分页 20/页 + 筛选重置第 1 页 + 选中跨页保留；批量删除/标签/标记错题（学生选择器）/加入试题篮（过滤已在篮）；
// 无处理中卷提示；pick 模式无批量面且题卡可点选入。
// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import type { BankService, BankExtServices, Question } from '../../src/shared/contracts/bank-types.js';
import { MockBankService } from '../../src/bank/mock/mock-bank.js';
import { createMockExtServices } from '../../src/bank/mock/mock-ext.js';
import { MockBankStore } from '../../src/bank/mock/mock-store.js';

import { BankBrowser } from '../../src/app/components/BankBrowser.js';
import type { ExtPageServices } from '../../src/app/pages/ExtUi.js';

interface Ctx {
  bank: BankService;
  ext: BankExtServices;
  store: MockBankStore;
}

let ctx: Ctx;
let svc: ExtPageServices;

/** fix-1b：题卡图走 data-assets 资产根解析 → 断言 file:///（照 paper-editor-render.test.tsx） */
const ASSETS_ROOT = 'D:\\mofang-test\\data\\assets';

beforeEach(() => {
  const store = new MockBankStore();
  // seedSampleData=false：本文件断言精确题数/空态/无处理中卷，不引入样例题与样例卷
  ctx = { bank: new MockBankService(store, false), ext: createMockExtServices(store), store };
  svc = { bank: ctx.bank, ext: ctx.ext };
});

let container: HTMLDivElement;
let root: Root | null = null;

function render(ui: ReactElement) {
  root?.unmount();
  container?.remove();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => {
    root!.render(ui);
  });
}

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  delete window.__mofangPaths;
  vi.restoreAllMocks();
});

function click(testid: string) {
  const el = container.querySelector(`[data-testid="${testid}"]`);
  if (!el) throw new Error(`找不到元素: ${testid}`);
  flushSync(() => (el as HTMLButtonElement).click());
}

function check(testid: string) {
  const el = container.querySelector(`[data-testid="${testid}"]`) as HTMLInputElement | null;
  if (!el) throw new Error(`找不到勾选框: ${testid}`);
  flushSync(() => el.click());
}

async function waitFor(assertion: () => void) {
  await vi.waitFor(assertion, { timeout: 3000, interval: 20 });
}

/** 造题：content 为纯文本题干，stemHtml/options/answer/analysis/images 按需补 */
async function makeQuestion(overrides: Partial<Omit<Question, 'id' | 'createdAt' | 'updatedAt'>> = {}): Promise<Question> {
  return ctx.bank.createQuestion({
    subject: '物理',
    sourceType: 'local',
    sourceDetail: { origin: 'test' },
    content: '<div class="question">默认题干</div>',
    images: [],
    ...overrides,
  });
}

/** 批量造 N 题（分页测试用），题干带序号便于断言 */
async function makeQuestions(n: number): Promise<Question[]> {
  const out: Question[] = [];
  for (let i = 1; i <= n; i++) {
    out.push(await makeQuestion({ content: `<div class="question">题目 ${i} 号</div>` }));
  }
  return out;
}

describe('0004-fix-1b 题卡形态：直显 / 选项 / 答案折叠 / 分页 / pick', () => {
  it('题卡直显：完整题干（KaTeX）+ 图随内容流（data-assets → file:///）；无摘要/图计数徽标/详情两级展开', async () => {
    window.__mofangPaths = { userDataAssets: ASSETS_ROOT };
    const q = await makeQuestion({
      content: '<div class="question"><p>光滑斜面上放一物块，求物块下滑加速度与斜面倾角的关系。</p>'
        + '<figure class="diagram" data-w="300"><img src="data-assets/capture/zujuan/a-1.png" alt="配图"></figure></div>',
      images: [
        { assetId: 'data-assets/capture/zujuan/a-1.png', type: 'figure' },
        { assetId: 'data-assets/capture/zujuan/a-2.png', type: 'formula-image' },
      ],
    });
    render(<BankBrowser svc={svc} />);
    await waitFor(() => expect(container.querySelector(`[data-testid="bank-item-${q.id}"]`)).not.toBeNull());

    // 题干容器 = .question-content（与采集预览同管线同容器）
    const stem = container.querySelector(`[data-testid="bank-stem-${q.id}"]`) as HTMLElement;
    expect(stem.className).toBe('question-content');
    // 完整题干直显（无截断省略号、无标签残留）
    expect(stem.textContent).toContain('光滑斜面上放一物块，求物块下滑加速度与斜面倾角的关系');
    expect(stem.textContent).not.toContain('…');
    expect(stem.textContent).not.toContain('<div');
    // 图随题内容流直显 + data-assets 解析为 file:///
    const img = stem.querySelector('img') as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.getAttribute('src')).toMatch(/^file:\/\/\/D:\/mofang-test\/data\/assets\/capture\/zujuan\/a-1\.png$/);
    // fix-1 B 形态全部消失：无摘要、无图计数徽标、无「详情」按钮、无分区详情面板
    expect(container.querySelector(`[data-testid="bank-summary-${q.id}"]`)).toBeNull();
    expect(container.querySelector(`[data-testid="bank-figure-badge-${q.id}"]`)).toBeNull();
    expect(container.querySelector(`[data-testid="bank-detail-${q.id}"]`)).toBeNull();
    expect(container.querySelector(`[data-testid="bank-item-detail-${q.id}"]`)).toBeNull();
    expect(container.querySelector('.bank-detail')).toBeNull();
  });

  it('题干 stemHtml 优先回落 content + 结构化 options → .options > .option（标号前置）；无选项题不渲染选项容器', async () => {
    const q = await makeQuestion({
      stemHtml: '<p>题干结构化：已知 <span class="math" data-tex="x^2=4"></span>，求 x。</p>',
      content: '<div class="question">派生 content 不应出现</div>',
      options: [
        { label: 'A', html: '<span class="math" data-tex="x=2"></span>' },
        { label: 'B', html: 'x=-2' },
      ],
    });
    const bare = await makeQuestion({ content: '<div class="question">判断题：无选项。</div>' });
    render(<BankBrowser svc={svc} />);
    await waitFor(() => expect(container.querySelector(`[data-testid="bank-item-${q.id}"]`)).not.toBeNull());

    const stem = container.querySelector(`[data-testid="bank-stem-${q.id}"]`) as HTMLElement;
    expect(stem.textContent).toContain('题干结构化');
    expect(stem.textContent).not.toContain('派生 content 不应出现');
    // KaTeX 公式已渲染（与题面渲染同源）
    expect(stem.querySelector('.katex')).not.toBeNull();
    // 选项容器 + 标号前置
    const options = stem.querySelector('.options') as HTMLElement;
    expect(options).not.toBeNull();
    const optionTexts = [...stem.querySelectorAll('.option')].map((el) => el.textContent);
    expect(optionTexts.length).toBe(2);
    expect(optionTexts[0]).toContain('A.');
    expect(optionTexts[1]).toContain('B.');

    // 无选项题：题卡照常渲染但不出现选项容器
    const bareStem = container.querySelector(`[data-testid="bank-stem-${bare.id}"]`) as HTMLElement;
    expect(bareStem.textContent).toContain('判断题：无选项');
    expect(bareStem.querySelector('.options')).toBeNull();
  });

  it('答案/解析折叠：默认收起 → 点开红字（教师版语义）→ 再点收起；无内容钮灰显不可点', async () => {
    const q = await makeQuestion({
      content: '<div class="question">折叠测试题</div>',
      answer: '<p>答案：A</p>',
      analysis: '<p>解析：开方即可。</p>',
    });
    const bare = await makeQuestion({ content: '<div class="question">无答案解析题</div>' });
    render(<BankBrowser svc={svc} />);
    await waitFor(() => expect(container.querySelector(`[data-testid="bank-item-${q.id}"]`)).not.toBeNull());

    // 默认收起：折叠内容不在 DOM
    expect(container.querySelector(`[data-testid="bank-answer-${q.id}"]`)).toBeNull();
    expect(container.querySelector(`[data-testid="bank-analysis-${q.id}"]`)).toBeNull();

    click(`bank-answer-toggle-${q.id}`);
    const answer = container.querySelector(`[data-testid="bank-answer-${q.id}"]`) as HTMLElement;
    expect(answer.textContent).toContain('答案：A');
    // 0010 换肤适配：答案红字改接主题变量 --brick（原写死 #d32f2f=rgb(211,47,47)，语义同为「展开红字」教师版标识）
    expect(answer.style.color).toBe('var(--brick)');
    // 解析独立折叠：仍收起
    expect(container.querySelector(`[data-testid="bank-analysis-${q.id}"]`)).toBeNull();

    click(`bank-analysis-toggle-${q.id}`);
    expect((container.querySelector(`[data-testid="bank-analysis-${q.id}"]`) as HTMLElement).textContent)
      .toContain('解析：开方即可');

    // 再点收起
    click(`bank-answer-toggle-${q.id}`);
    expect(container.querySelector(`[data-testid="bank-answer-${q.id}"]`)).toBeNull();

    // 无答案/解析题：钮灰显不可点
    const answerBtn = container.querySelector(`[data-testid="bank-answer-toggle-${bare.id}"]`) as HTMLButtonElement;
    const analysisBtn = container.querySelector(`[data-testid="bank-analysis-toggle-${bare.id}"]`) as HTMLButtonElement;
    expect(answerBtn.disabled).toBe(true);
    expect(analysisBtn.disabled).toBe(true);
  });

  it('分页：25 题 → 20/页，第 1/2 页；翻页保留选中；筛选变化重置第 1 页', async () => {
    const list = await makeQuestions(25);
    render(<BankBrowser svc={svc} />);
    await waitFor(() => expect(container.querySelector('[data-testid="bank-pager"]')).not.toBeNull());

    const pager = container.querySelector('[data-testid="bank-pager"]') as HTMLElement;
    expect((container.querySelector('[data-testid="bank-page-info"]') as HTMLElement).textContent)
      .toBe('共 25 题 · 第 1/2 页');
    expect(pager.getAttribute('data-total-pages')).toBe('2');
    expect(container.querySelectorAll('[data-testid^="bank-item-"]').length).toBe(20);
    expect(container.querySelector(`[data-testid="bank-item-${list[24].id}"]`)).toBeNull();

    // 第 1 页勾选第 1 题 → 翻到第 2 页仍保留选中
    check(`bank-select-${list[0].id}`);
    expect((container.querySelector('[data-testid="bank-selection-bar"]') as HTMLElement).getAttribute('data-selected-count')).toBe('1');
    click('bank-next-page');
    expect((container.querySelector('[data-testid="bank-page-info"]') as HTMLElement).textContent)
      .toBe('共 25 题 · 第 2/2 页');
    expect(container.querySelectorAll('[data-testid^="bank-item-"]').length).toBe(5);
    expect(container.querySelector(`[data-testid="bank-item-${list[24].id}"]`)).not.toBeNull();
    expect((container.querySelector('[data-testid="bank-selection-bar"]') as HTMLElement).getAttribute('data-selected-count')).toBe('1');

    // 筛选（关键词）变化 → 回到第 1 页
    const input = container.querySelector('[data-testid="bank-keyword-input"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    flushSync(() => {
      setter.call(input, '题目 25 号');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await waitFor(() => {
      expect((container.querySelector('[data-testid="bank-page-info"]') as HTMLElement).textContent).toBe('共 1 题 · 第 1/1 页');
    });
  });

  it('pick 模式：无多选列与选中计数条，题卡同形态且可点「选入」', async () => {
    const q = await makeQuestion({ content: '<div class="question">待选题</div>' });
    const picked: string[] = [];
    render(<BankBrowser svc={svc} onPick={(id) => picked.push(id)} />);
    await waitFor(() => expect(container.querySelector(`[data-testid="bank-item-${q.id}"]`)).not.toBeNull());

    expect(container.querySelector('[data-testid="bank-selection-bar"]')).toBeNull();
    expect(container.querySelector(`[data-testid="bank-select-${q.id}"]`)).toBeNull();
    // pick 模式同形态：完整题卡直显
    expect((container.querySelector(`[data-testid="bank-stem-${q.id}"]`) as HTMLElement).textContent).toContain('待选题');
    click(`bank-pick-${q.id}`);
    expect(picked).toEqual([q.id]);
  });
});

describe('0004-fix-1 F1 组：题库批量操作', () => {
  it('批量删除：确认弹层文案含 N，确认后逐题 deleteQuestion 并刷新', async () => {
    const [q1, q2, q3] = await makeQuestions(3);
    const delSpy = vi.spyOn(ctx.bank, 'deleteQuestion');
    render(<BankBrowser svc={svc} />);
    await waitFor(() => expect(container.querySelector(`[data-testid="bank-item-${q1.id}"]`)).not.toBeNull());

    check(`bank-select-${q1.id}`);
    check(`bank-select-${q2.id}`);
    check(`bank-select-${q3.id}`);
    click('bank-batch-delete-btn');
    expect((container.querySelector('[data-testid="bank-batch-delete-text"]') as HTMLElement).textContent)
      .toBe('删除 3 题？软删后不再出现在题库与选题列表（已组入试卷引用不受影响）');
    click('bank-batch-delete-confirm');

    await waitFor(() => {
      expect(delSpy).toHaveBeenCalledTimes(3);
      expect((container.querySelector('[data-testid="page-message"]') as HTMLElement).textContent)
        .toBe('批量删除 3 题：成功 3 题，失败 0 题');
    });
    // 软删后列表清空（listQuestions 已过滤）
    await waitFor(() => expect(container.querySelector('[data-testid="bank-empty"]')).not.toBeNull());
  });

  it('批量添加标签：弹层输入标签名 → 逐题 addTag，结果横幅计数正确', async () => {
    const [q1, q2] = await makeQuestions(2);
    const tagSpy = vi.spyOn(ctx.bank, 'addTag');
    render(<BankBrowser svc={svc} />);
    await waitFor(() => expect(container.querySelector(`[data-testid="bank-item-${q1.id}"]`)).not.toBeNull());

    check(`bank-select-${q1.id}`);
    check(`bank-select-${q2.id}`);
    click('bank-batch-tag-btn');
    const input = container.querySelector('[data-testid="bank-batch-tag-input"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    flushSync(() => {
      setter.call(input, '易错题');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    click('bank-batch-tag-confirm');

    await waitFor(() => {
      expect(tagSpy).toHaveBeenCalledTimes(2);
      expect((container.querySelector('[data-testid="page-message"]') as HTMLElement).textContent)
        .toBe('批量添加标签「易错题」2 题：成功 2 题，失败 0 题');
    });
    expect(tagSpy.mock.calls.map((c) => c[1])).toEqual(['易错题', '易错题']);
  });

  it('批量标记错题：学生选择器搜索+多选 → 逐题×逐生 recordWrong(occurredAt=now)', async () => {
    const [q1, q2] = await makeQuestions(2);
    const s1 = await ctx.ext.student.createStudent({ name: '张三', studentNo: '001' });
    const s2 = await ctx.ext.student.createStudent({ name: '李四', studentNo: '002' });
    const wrongSpy = vi.spyOn(ctx.ext.mistake, 'recordWrong');
    render(<BankBrowser svc={svc} />);
    await waitFor(() => expect(container.querySelector(`[data-testid="bank-item-${q1.id}"]`)).not.toBeNull());

    check(`bank-select-${q1.id}`);
    check(`bank-select-${q2.id}`);
    click('bank-batch-mistake-btn');
    await waitFor(() => expect(container.querySelector(`[data-testid="bank-student-${s1.name}"]`)).not.toBeNull());

    // 搜索过滤：输入「李」只剩李四
    const search = container.querySelector('[data-testid="bank-student-search"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    flushSync(() => {
      setter.call(search, '李');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.querySelector(`[data-testid="bank-student-${s1.name}"]`)).toBeNull();
    expect(container.querySelector(`[data-testid="bank-student-${s2.name}"]`)).not.toBeNull();

    // 清空搜索后勾两名学生
    flushSync(() => {
      setter.call(search, '');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const checkStudent = (name: string) => {
      const label = container.querySelector(`[data-testid="bank-student-${name}"]`) as HTMLElement;
      const box = label.querySelector('input') as HTMLInputElement;
      flushSync(() => box.click());
    };
    checkStudent('张三');
    checkStudent('李四');
    click('bank-batch-mistake-confirm');

    await waitFor(() => {
      // 2 题 × 2 生 = 4 次登记
      expect(wrongSpy).toHaveBeenCalledTimes(4);
      expect((container.querySelector('[data-testid="page-message"]') as HTMLElement).textContent)
        .toBe('标记 2 题 × 2 生：成功 4 项，失败 0 项');
    });
    const first = wrongSpy.mock.calls[0][0];
    expect([q1.id, q2.id]).toContain(first.questionId);
    expect([s1.id, s2.id]).toContain(first.studentId);
    // occurredAt=now（ISO 时间戳）
    expect(Number.isNaN(Date.parse(first.occurredAt))).toBe(false);
  });

  it('批量加入试题篮：点击弹窗选篮确认加入，过滤已在篮的题；无处理中卷时弹层照开（0055 等强适配）', async () => {
    const [q1, q2, q3] = await makeQuestions(3);
    // 0055（R-063）行为变更：0 篮不再早退——弹层照开（列表为空 + 新建行=唯一入口），
    // 未建篮直接确认才提示「请先新建试题篮」（弹层保持打开，可从新建行建一个再确认）
    render(<BankBrowser svc={svc} />);
    await waitFor(() => expect(container.querySelector(`[data-testid="bank-item-${q1.id}"]`)).not.toBeNull());
    check(`bank-select-${q1.id}`);
    click('bank-batch-add-basket-btn');
    await waitFor(() => {
      if (!container.querySelector('[data-testid="bank-batch-basket-modal"]')) throw new Error('0 篮态弹层未照开');
    });
    expect(container.querySelector('[data-testid="bank-batch-basket-empty"]')).not.toBeNull();
    expect(container.querySelectorAll('input[name="bank-basket-pick"]').length).toBe(0);
    click('bank-batch-basket-confirm');
    await waitFor(() => {
      expect((container.querySelector('[data-testid="page-message"]') as HTMLElement).textContent).toBe('请先新建试题篮');
    });
    expect(container.querySelector('[data-testid="bank-batch-basket-modal"]')).not.toBeNull();
    // 关掉弹层再走后面的既有链路（选篮加入）
    flushSync(() => ([...container.querySelectorAll('button')].find((b) => b.textContent === '取消') as HTMLButtonElement).click());
    await waitFor(() => expect(container.querySelector('[data-testid="bank-batch-basket-modal"]')).toBeNull());

    // 建有处理中卷，q1 已在篮 → 点击弹出选篮弹窗（唯一篮默认选中）→ 确认只加 q2/q3
    const paper = await ctx.bank.createPaper('加篮测试篮');
    await ctx.bank.addQuestion(paper.id, q1.id);
    const addSpy = vi.spyOn(ctx.bank, 'addQuestion');
    check(`bank-select-${q2.id}`);
    check(`bank-select-${q3.id}`);
    click('bank-batch-add-basket-btn');

    await waitFor(() => {
      if (!container.querySelector('[data-testid="bank-batch-basket-modal"]')) throw new Error('选篮弹窗未出现');
    });
    const picked = container.querySelector('input[name="bank-basket-pick"]:checked') as HTMLInputElement | null;
    expect(picked?.value).toBe(paper.id);

    click('bank-batch-basket-confirm');
    await waitFor(() => {
      expect((container.querySelector('[data-testid="page-message"]') as HTMLElement).textContent)
        .toBe('已加入试题篮「加篮测试篮」：成功 2 题，跳过已在篮 1 题');
    });
    expect(addSpy.mock.calls.map((c) => c[1]).sort()).toEqual([q2.id, q3.id].sort());
  });

  it('0014 目检返工：批量加入试题篮弹窗列出处理中卷，单选目标后加入该篮（内联目标下拉退役）', async () => {
    const [q1] = await makeQuestions(1);
    const pA = await ctx.bank.createPaper('目标甲');
    // 验收方顺手修复同类偶发（同 0014 capture-page 修复）：listPapersEx 契约=created_at DESC
    // （最新篮在前），两卷同毫秒创建时稳定排序保留插入序曾把断言养绿；显式错开毫秒使命中确定
    await new Promise((resolve) => setTimeout(resolve, 2));
    const pB = await ctx.bank.createPaper('目标乙');
    render(<BankBrowser svc={svc} />);
    await waitFor(() => expect(container.querySelector(`[data-testid="bank-item-${q1.id}"]`)).not.toBeNull());
    check(`bank-select-${q1.id}`);

    // 点击 → 弹窗列出两张处理中卷（卡片式单选，默认第一张）
    click('bank-batch-add-basket-btn');
    await waitFor(() => {
      if (!container.querySelector('[data-testid="bank-batch-basket-modal"]')) throw new Error('选篮弹窗未出现');
    });
    const modal = container.querySelector('[data-testid="bank-batch-basket-modal"]')!;
    expect(modal.textContent).toContain('目标甲');
    expect(modal.textContent).toContain('目标乙');
    // 0014 目检返工二：试题篮以卡片框呈现（长卷名截断有 title 全文，多篮时列表内滚）
    const cards = [...modal.querySelectorAll('label.basket-pick-card')] as HTMLLabelElement[];
    expect(cards.length).toBe(2);
    const titles = cards.map((c) => c.querySelector('.basket-pick-title') as HTMLElement);
    expect(titles.map((t) => t.textContent)).toEqual(['目标乙', '目标甲']);
    expect(titles[0]!.getAttribute('title')).toBe('目标乙');
    const radios = [...modal.querySelectorAll('input[name="bank-basket-pick"]')] as HTMLInputElement[];
    expect(radios.map((r) => r.value)).toEqual([pB.id, pA.id]);
    expect((modal.querySelector('input[name="bank-basket-pick"]:checked') as HTMLInputElement).value).toBe(pB.id);

    // 选「目标乙」→ 确认 → 加入乙；甲不受影响
    flushSync(() => (modal.querySelector(`input[name="bank-basket-pick"][value="${pB.id}"]`) as HTMLInputElement).click());
    click('bank-batch-basket-confirm');
    await waitFor(() => {
      expect((container.querySelector('[data-testid="page-message"]') as HTMLElement).textContent)
        .toBe('已加入试题篮「目标乙」：成功 1 题');
    });
    expect((await ctx.bank.getPaperQuestions(pB.id)).map((r) => r.questionId)).toEqual([q1.id]);
    expect((await ctx.bank.getPaperQuestions(pA.id)).length).toBe(0);
    // 弹窗已关闭、内联下拉形态不再存在
    expect(container.querySelector('[data-testid="bank-batch-basket-modal"]')).toBeNull();
    expect(container.querySelector('[data-testid="bank-basket-target-select"]')).toBeNull();
  });
});

// ===== 0004-fix-1c：A组 题卡列表限宽 700px 纸面版心语义 / C组 存量题题首孤图后移（显示层即时修复） =====
describe('0004-fix-1c 题卡限宽 + 题首孤图后移', () => {
  it('A组：题卡列表 ul 挂 .bank-question-list（app.css 限宽 700px 居中，管理/pick 两模式同享）', async () => {
    const q = await makeQuestion({ content: '<div class="question">限宽测试题</div>' });
    render(<BankBrowser svc={svc} />);
    await waitFor(() => expect(container.querySelector(`[data-testid="bank-item-${q.id}"]`)).not.toBeNull());
    const list = container.querySelector('ul.bank-question-list') as HTMLElement | null;
    expect(list).not.toBeNull();
    expect(list?.className).toContain('bank-question-list');
  });

  it('C组：存量菁优左文右图题（content 图冲题首）题库显示即恢复文本开头、图随后（无需重采）', async () => {
    window.__mofangPaths = { userDataAssets: ASSETS_ROOT };
    const q = await makeQuestion({
      sourceType: 'network',
      sourceDetail: { origin: 'test', site: 'jyeoo', questionId: '48e21ffd', url: '', collectedAt: '' },
      // 真库 48e21ffd 存量形态：题干首个节点即行内图 span，文本在后
      content: '<div class="question">'
        + '<span class="inline-figure"><img class="q-figure" data-w="192" data-h="188" src="data-assets/capture/jyeoo/48e21ffd-1.png"></span>'
        + '<p>如图，闭合开关 S 后，两灯均发光，则两灯是串联还是并联？</p>'
        + '<div class="options"></div></div>',
      images: [{ assetId: 'data-assets/capture/jyeoo/48e21ffd-1.png', type: 'figure' }],
    });
    render(<BankBrowser svc={svc} />);
    await waitFor(() => expect(container.querySelector(`[data-testid="bank-item-${q.id}"]`)).not.toBeNull());

    const stem = container.querySelector(`[data-testid="bank-stem-${q.id}"]`) as HTMLElement;
    const html = stem.innerHTML;
    // 文本在前、图随后（图不冲题首）
    expect(html.indexOf('如图，闭合开关 S 后')).toBeGreaterThanOrEqual(0);
    expect(html.indexOf('如图，闭合开关 S 后')).toBeLessThan(html.indexOf('<img'));
    // 图块契约结构原样保留（标签/类/尺寸）
    expect(html).toContain('class="inline-figure"');
    expect(html).toContain('data-w="192"');
    // 图在题干文本之后、仍在选项容器之前（题干区末尾，不越过选项）
    expect(html.indexOf('<img')).toBeGreaterThan(html.indexOf('两灯均发光'));
  });

  it('C组：stemHtml 裸图前置同样后移；文本在前的正常题顺序不乱（控制组）', async () => {
    window.__mofangPaths = { userDataAssets: ASSETS_ROOT };
    const relocated = await makeQuestion({
      stemHtml: '<figure class="diagram" data-w="300" data-h="200"><img src="data-assets/capture/zujuan/c-1.png"></figure><p>题干文本在后。</p>',
      content: '<div class="question">占位</div>',
    });
    const normal = await makeQuestion({
      content: '<div class="question"><p>正常题：文本在前。</p><figure class="diagram" data-w="300"><img src="data-assets/capture/zujuan/c-2.png"></figure></div>',
    });
    render(<BankBrowser svc={svc} />);
    await waitFor(() => expect(container.querySelector(`[data-testid="bank-item-${relocated.id}"]`)).not.toBeNull());

    const movedHtml = (container.querySelector(`[data-testid="bank-stem-${relocated.id}"]`) as HTMLElement).innerHTML;
    expect(movedHtml.indexOf('题干文本在后')).toBeLessThan(movedHtml.indexOf('<img'));

    const normalHtml = (container.querySelector(`[data-testid="bank-stem-${normal.id}"]`) as HTMLElement).innerHTML;
    expect(normalHtml.indexOf('正常题：文本在前')).toBeLessThan(normalHtml.indexOf('<img'));
  });
});

// ==================== 0045 目检返工⑤：编辑弹层三区（题面→答案→解析） ====================

describe('0045 目检返工⑤ 编辑弹层：题面/答案/解析三区均为编辑器', () => {
  it('顺序 = 题面 → 答案 → 解析；仅题面为 stem variant（有「插入选项」）', async () => {
    const q = await makeQuestion({
      content: '<div class="question"><p>原题干</p></div>',
      answer: '<p>原答案</p>',
      analysis: '<p>原解析</p>',
    });
    render(<BankBrowser svc={svc} />);
    await waitFor(() => expect(container.querySelector(`[data-testid="bank-edit-${q.id}"]`)).not.toBeNull());
    click(`bank-edit-${q.id}`);
    await waitFor(() => expect(container.querySelectorAll('[data-testid="qe-toolbar"]').length).toBe(3));

    // 字段顺序：题面在最上，然后答案、解析
    const labels = [...container.querySelectorAll('.field-label')].map((e) => e.textContent ?? '');
    expect(labels).toEqual(['题面', '答案（可空）', '解析（可空）']);

    // 三个编辑器；仅题面（第 1 个）为题面形态（有「插入选项」按钮，无「插入答案块」）
    const toolbars = [...container.querySelectorAll<HTMLElement>('[data-testid="qe-toolbar"]')];
    expect(toolbars[0]!.querySelector('[data-testid="qe-btn-options"]')).not.toBeNull();
    expect(toolbars[1]!.querySelector('[data-testid="qe-btn-options"]')).toBeNull();
    expect(toolbars[2]!.querySelector('[data-testid="qe-btn-options"]')).toBeNull();
    expect(container.querySelector('[data-testid="qe-btn-answer"]')).toBeNull();
  });

  it('三区共用保存：在答案区改内容 → 点该区 💾 → 整题（含答案新文案）落库', async () => {
    const q = await makeQuestion({
      content: '<div class="question"><p>原题干</p></div>',
      answer: '<p>原答案</p>',
      analysis: '<p>原解析</p>',
    });
    render(<BankBrowser svc={svc} />);
    await waitFor(() => expect(container.querySelector(`[data-testid="bank-edit-${q.id}"]`)).not.toBeNull());
    click(`bank-edit-${q.id}`);
    await waitFor(() => expect(container.querySelectorAll('[data-testid="qe-toolbar"]').length).toBe(3));

    const toolbars = [...container.querySelectorAll<HTMLElement>('[data-testid="qe-toolbar"]')];
    // 0045 返工（第三轮）：字段壳由 label 改 div——按编辑器根 div 定位（原 closest('label') 已不适用）
    const answerArea = toolbars[1]!.parentElement!.querySelector('.question-editor-content') as HTMLElement;
    expect(answerArea.textContent).toContain('原答案');

    // 向该编辑器粘贴文本（PM 默认文本粘贴通路；同 0043 伪造 clipboardData 手法）
    const event = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData?: unknown };
    Object.defineProperty(event, 'clipboardData', {
      value: { files: [], items: [], types: ['text/plain'], getData: (t: string) => (t === 'text/plain' ? '改答内容' : '') },
    });
    flushSync(() => answerArea.dispatchEvent(event));
    await waitFor(() => {
      if (!(answerArea.textContent ?? '').includes('改答内容')) throw new Error('粘贴未落编辑器');
    });

    // 0045 返工（第四轮）：三区工具条保存钮撤下 → 弹层右下角统一「保存」（彩色）
    expect(toolbars[1]!.querySelector('[data-testid="qe-btn-save"]')).toBeNull();
    const saveBtn = container.querySelector('[data-testid="bank-edit-save"]') as HTMLButtonElement;
    expect(saveBtn).not.toBeNull();
    expect(saveBtn.textContent).toBe('保存');
    expect(saveBtn.className).toContain('btn-primary'); // 有颜色（主色按钮）
    await vi.waitFor(async () => {
      flushSync(() => saveBtn.click());
      const saved = ctx.store.questions.get(q.id);
      if (!saved?.answer?.includes('改答内容')) throw new Error('答案未保存');
    });
    const saved = ctx.store.questions.get(q.id)!;
    expect(saved.content).toContain('原题干');
    expect(saved.answer).toContain('原答案');
    expect(saved.answer).toContain('改答内容');
    expect(saved.analysis).toContain('原解析');
  });
});

describe('0045 目检返工④：题库页表格渲染', () => {
  it('含表格的题在题卡中原样渲染（table 结构可见）', async () => {
    const q = await makeQuestion({
      content: '<div class="question"><p>读表回答：</p><table><tbody><tr><th>时间</th><th>速度</th></tr><tr><td>1s</td><td>2m/s</td></tr></tbody></table></div>',
    });
    render(<BankBrowser svc={svc} />);
    await waitFor(() => expect(container.querySelector(`[data-testid="bank-stem-${q.id}"]`)).not.toBeNull());
    const stem = container.querySelector(`[data-testid="bank-stem-${q.id}"]`) as HTMLElement;
    const table = stem.querySelector('table');
    expect(table).not.toBeNull();
    expect(table!.querySelectorAll('th')).toHaveLength(2);
    expect(table!.querySelectorAll('td')).toHaveLength(2);
    expect(stem.textContent).toContain('读表回答');
  });
});

describe('0045 目检返工（第三轮根因）：编辑弹层不得用 label 包编辑器', () => {
  it('三区编辑器字段是 div 壳（无 label 祖先）；点字段标签文字不弹公式编辑器', async () => {
    const q = await makeQuestion({ content: '<div class="question"><p>质量为 <span class="math" data-tex="m"></span> 的物体</p></div>' });
    render(<BankBrowser svc={svc} />);
    await waitFor(() => expect(container.querySelector(`[data-testid="bank-edit-${q.id}"]`)).not.toBeNull());
    click(`bank-edit-${q.id}`);
    await waitFor(() => expect(container.querySelectorAll('[data-testid="qe-toolbar"]').length).toBe(3));

    // 行为（先行断言=用户症状）：点「题面」字段标签文字（非交互区）——不得弹出公式编辑器
    const labelText = [...container.querySelectorAll('.field-label')].find((e) => (e.textContent ?? '').includes('题面'));
    expect(labelText).toBeTruthy();
    flushSync(() => labelText!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    await new Promise((r) => setTimeout(r, 30));
    expect(container.querySelector('[data-testid="qe-math-popup"]')).toBeNull();

    // 结构：三个编辑器都不在 <label> 内（label 会把区域内点击转发给第一个按钮 = ƒx）
    const toolbars = [...container.querySelectorAll<HTMLElement>('[data-testid="qe-toolbar"]')];
    for (const tb of toolbars) {
      expect(tb.closest('label')).toBeNull();
    }
  });
});
