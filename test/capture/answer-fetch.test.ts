import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  enrichAnswers,
  injectStoredBankids,
  zujuanDetailUrl,
  type HiddenPage,
  type AnswerFetchDeps,
} from '../../src/capture/browser/answer-fetch.js';
import {
  pollZujuanAnswer,
  findReportFieldsetTid,
  parseJyeooDetail,
} from '../../src/capture/adapters/detail-pages.js';
import type { CapturedQuestion } from '../../src/shared/contracts/capture-types.js';

function makeQuestion(overrides: Partial<CapturedQuestion>): CapturedQuestion {
  return {
    questionId: 'q1',
    site: 'zujuan',
    sourceUrl: 'https://zujuan.xkw.com/basket',
    stemHtml: '<p>一物体从高处自由下落，经过时间 t 落地</p>',
    options: [],
    answerHtml: '',
    analysisHtml: '',
    images: [],
    meta: {},
    rect: null,
    ...overrides,
  };
}

/** 用 jsdom doc 伪造 HiddenPage，call 直接派发真实纯函数（与注入 bundle 同一实现） */
function fakePage(html: string, finalUrl: string): HiddenPage {
  const doc = new JSDOM(html).window.document;
  return {
    finalUrl: () => finalUrl,
    call: async (fnName: string, ...args: any[]) => {
      switch (fnName) {
        case 'pollZujuanAnswer':
          return pollZujuanAnswer(doc, { timeoutMs: args[0], intervalMs: 1 });
        case 'findReportFieldsetTid':
          return findReportFieldsetTid(doc, args[0]);
        case 'parseJyeooDetail':
          return parseJyeooDetail(doc);
        default:
          throw new Error(`unknown fn ${fnName}`);
      }
    },
    close: async () => {},
  };
}

function depsWith(pages: Record<string, HiddenPage>): AnswerFetchDeps & { opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    openHiddenPage: async (url: string) => {
      opened.push(url);
      const page = pages[url];
      if (!page) throw new Error(`no fake page for ${url}`);
      return page;
    },
  };
}

describe('zujuanDetailUrl', () => {
  it('数字 qid 拼详情页 URL', () => {
    expect(zujuanDetailUrl('987654')).toBe('https://zujuan.xkw.com/13q987654.html');
  });

  it('qid 已含 13q 前缀时不重复拼接', () => {
    expect(zujuanDetailUrl('13q987654')).toBe('https://zujuan.xkw.com/13q987654.html');
  });
});

describe('zujuanDetailUrl — 题库前缀 = 该题 bankid（D1-fix-5，table-driven）', () => {
  // 规则：有 bankid 用 `{bankid}q{id}.html`；缺省回落 13q（老数据兼容）；qid 自带前缀幂等
  const cases: Array<[string, string, string | undefined, string]> = [
    ['非物理学科 bankid=14（高中化学 35355749 根因用例）', '35355749', '14', 'https://zujuan.xkw.com/14q35355749.html'],
    ['物理 bankid=13', '35337259', '13', 'https://zujuan.xkw.com/13q35337259.html'],
    ['初中物理 bankid=4', '31576438', '4', 'https://zujuan.xkw.com/4q31576438.html'],
    ['缺 bankid（老数据）→ 回落 13q', '987654', undefined, 'https://zujuan.xkw.com/13q987654.html'],
    ['bankid 空串 → 回落 13q', '987654', '', 'https://zujuan.xkw.com/13q987654.html'],
    ['qid 自带 13q 前缀 → 幂等不重复拼接', '13q987654', undefined, 'https://zujuan.xkw.com/13q987654.html'],
    ['qid 自带 14q 前缀且无 bankid → 幂等保留原前缀', '14q35355749', undefined, 'https://zujuan.xkw.com/14q35355749.html'],
    ['qid 自带前缀与 bankid 一致 → 幂等', '14q35355749', '14', 'https://zujuan.xkw.com/14q35355749.html'],
    ['qid 自带 13q 前缀而 bankid=14 → 以 bankid 为准（提取侧实测值优先）', '13q35355749', '14', 'https://zujuan.xkw.com/14q35355749.html'],
  ];

  it.each(cases)('%s', (_case, questionId, bankid, expected) => {
    expect(zujuanDetailUrl(questionId, bankid)).toBe(expected);
  });
});

describe('enrichAnswers — zujuan', () => {
  /** 详情页真实结构（D1-fix-2 F-1 实站取证）：主题干在 .quest-content .quest-cnt；推荐题在 .rec-tests 的 .exam-item__cnt */
  function zujuanDetailHtml(stemInner: string, answerInner = ''): string {
    return `
      <section class="quest-content">
        <div class="quesroot" questionid="987654" bankid="13">
          <div class="info-list"><span class="info-item">题型：多选题-1个小题</span></div>
          <div class="cnt-box"><div class="quest-cnt ">${stemInner}</div></div>
        </div>
      </section>
      <section class="answer-box">${answerInner}</section>
      <section class="rec-tests">
        <div class="tk-quest-item quesroot" questionid="13500331">
          <div class="exam-item__cnt"><p>【推荐1】如图，一轻弹簧原长为L的推荐题</p></div>
        </div>
      </section>
    `;
  }

  const detailHtml = zujuanDetailHtml(
    '<p>一物体从高处自由下落，经过时间 t 落地，求速度。</p>',
    '<div class="answer-txt"><img src="https://imzujuan.xkw.com/getAnswerAndParse/k1.png"></div>',
  );

  it('D1-fix-5：meta.bankid=14（高中化学）→ 按 14q 前缀取详情页并采到答案（旧实现硬编码 13q → stem-not-found）', async () => {
    const q = makeQuestion({ questionId: '35355749', meta: { bankid: '14' } });
    const detail = zujuanDetailHtml(
      '<p>一物体从高处自由下落，经过时间 t 落地，求速度。</p>',
      '<div class="answer-txt"><img src="https://imzujuan.xkw.com/getAnswerAndParse/hx14.png"></div>',
    );
    const deps = depsWith({
      'https://zujuan.xkw.com/14q35355749.html': fakePage(detail, 'https://zujuan.xkw.com/14q35355749.html'),
    });

    const warnings = await enrichAnswers([q], deps);

    expect(deps.opened).toEqual(['https://zujuan.xkw.com/14q35355749.html']);
    expect(q.answerHtml).toBe('<img src="https://imzujuan.xkw.com/getAnswerAndParse/hx14.png">');
    expect(q.meta.answerVia).toBe('hidden-window');
    expect(warnings).toHaveLength(0);
  });

  it('隐藏窗口详情页取答案图：answerHtml 为 img 契约，images 追加 answer 角色', async () => {
    const q = makeQuestion({ questionId: '987654' });
    const deps = depsWith({ 'https://zujuan.xkw.com/13q987654.html': fakePage(detailHtml, 'https://zujuan.xkw.com/13q987654.html') });

    const warnings = await enrichAnswers([q], deps);

    expect(deps.opened).toEqual(['https://zujuan.xkw.com/13q987654.html']);
    expect(q.answerHtml).toBe('<img src="https://imzujuan.xkw.com/getAnswerAndParse/k1.png">');
    expect(q.images).toContainEqual({ src: 'https://imzujuan.xkw.com/getAnswerAndParse/k1.png', alt: '答案与解析', role: 'answer' });
    expect(q.meta.answerVia).toBe('hidden-window');
    expect(warnings).toHaveLength(0);
  });

  it('详情页题干不匹配 → mismatch 拒绝采答案（推荐区文字与篮内一致也不采）', async () => {
    const q = makeQuestion({ questionId: '987654' });
    // 主题干区为无关题；推荐区 .exam-item__cnt 故意放与篮内一致的文字——正确实现不得取推荐区
    const wrong = `
      <section class="quest-content"><div class="quesroot"><div class="cnt-box"><div class="quest-cnt "><p>完全无关的另一道题目内容</p></div></div></div></section>
      <section class="answer-box"><div class="answer-txt"><img src="https://imzujuan.xkw.com/getAnswerAndParse/wrong.png"></div></section>
      <section class="rec-tests"><div class="tk-quest-item"><div class="exam-item__cnt"><p>一物体从高处自由下落，经过时间 t 落地</p></div></div></section>
    `;
    const deps = depsWith({ 'https://zujuan.xkw.com/13q987654.html': fakePage(wrong, 'https://zujuan.xkw.com/13q987654.html') });

    const warnings = await enrichAnswers([q], deps);

    expect(q.answerHtml).toBe('');
    expect(q.meta.answerVia).toBe('mismatch');
    expect(warnings.some((w) => w.includes('mismatch'))).toBe(true);
  });

  it('.answer-txt img 超时未出现 → answerVia timeout + warning', async () => {
    const q = makeQuestion({ questionId: '987654' });
    const noAnswer = zujuanDetailHtml('<p>一物体从高处自由下落，经过时间 t 落地</p>', '<div class="answer-txt"></div>');
    const deps = depsWith({ 'https://zujuan.xkw.com/13q987654.html': fakePage(noAnswer, 'https://zujuan.xkw.com/13q987654.html') });

    const warnings = await enrichAnswers([q], deps, { timeoutMs: 30 });

    expect(q.meta.answerVia).toBe('timeout');
    expect(q.answerHtml).toBe('');
    expect(warnings.some((w) => w.includes('timeout'))).toBe(true);
  });

  it('会员墙 → gated + vip-gated，不硬刚', async () => {
    const q = makeQuestion({ questionId: '987654' });
    const vip = zujuanDetailHtml('<p>一物体从高处自由下落，经过时间 t 落地</p>', '<div class="mustvip">开通会员查看</div>');
    const deps = depsWith({ 'https://zujuan.xkw.com/13q987654.html': fakePage(vip, 'https://zujuan.xkw.com/13q987654.html') });

    await enrichAnswers([q], deps);

    expect(q.meta.gated).toBe(true);
    expect(q.meta.answerVia).toBe('vip-gated');
    expect(q.answerHtml).toBe('');
  });

  it('未登录墙（.need-login）→ login-required，不空等不采答案', async () => {
    const q = makeQuestion({ questionId: '987654' });
    const needLogin = zujuanDetailHtml(
      '<p>一物体从高处自由下落，经过时间 t 落地</p>',
      '<div class="need-login"><span>抱歉! 您未登录, 不能查看答案和解析</span></div>',
    );
    const deps = depsWith({ 'https://zujuan.xkw.com/13q987654.html': fakePage(needLogin, 'https://zujuan.xkw.com/13q987654.html') });

    const warnings = await enrichAnswers([q], deps, { timeoutMs: 30 });

    expect(q.meta.answerVia).toBe('login-required');
    expect(q.answerHtml).toBe('');
    expect(warnings.some((w) => w.includes('login-required'))).toBe(true);
  });

  it('详情页加载失败 → warning，不抛错中断批量', async () => {
    const q = makeQuestion({ questionId: '404000' });
    const deps = depsWith({});

    const warnings = await enrichAnswers([q], deps);

    expect(q.meta.answerVia).toBe('error');
    expect(warnings.some((w) => w.includes('404000'))).toBe(true);
  });
});

describe('enrichAnswers — jyeoo（D1-fix-3 实站校准：token 轮换，两跳仅作答案来源，不改写 questionId）', () => {
  const basketStem = '<p>某电路电阻为 10Ω，电流为 2A。</p>';
  const reportHtml = `
    <fieldset class="quesborder" id="rotatingToken888">
      <div class="pt1"><p>2. 某电路电阻为 10Ω，电流为 2A。</p></div>
    </fieldset>
  `;
  const detailHtml = `
    <div class="pt1"><p>某电路电阻为 10Ω，电流为 2A。</p></div>
    <div class="pt3">考点：<a>欧姆定律</a></div>
    <div class="pt5">分析：由欧姆定律入手。</div>
    <div class="pt6">解答：U = IR = 20V。</div>
    <div class="pt11">B</div>
  `;
  // 实站形态：reportUrl token 为 50 位加密串，学科 physics2
  const reportUrl = 'https://www.jyeoo.com/physics2/report/detail/5SIRL6dZc4PfopyizaYHe899HJekvIgPzq4kSKQILKBaIuJ6g5AkSm';

  function jyeooQ(): CapturedQuestion {
    return makeQuestion({
      questionId: 'jh0123456789abcdef', // 提取层内容哈希（实站实证 token 轮换，不作主键）
      site: 'jyeoo',
      sourceUrl: 'https://www.jyeoo.com/basket',
      stemHtml: basketStem,
      meta: {
        reportId: '5SIRL6dZc4PfopyizaYHe899HJekvIgPzq4kSKQILKBaIuJ6g5AkSm',
        reportUrl,
        subject: 'physics2',
        answerVia: 'report-page-tid',
      },
    });
  }

  it('两跳链路 → 详情页取答案/解析/考点；questionId 保持内容哈希不被 token 改写', async () => {
    const q = jyeooQ();
    const deps = depsWith({
      [reportUrl]: fakePage(reportHtml, reportUrl),
      'https://www.jyeoo.com/physics2/ques/detail/rotatingToken888': fakePage(detailHtml, 'https://www.jyeoo.com/physics2/ques/detail/rotatingToken888'),
    });

    const warnings = await enrichAnswers([q], deps);

    expect(deps.opened).toEqual([
      reportUrl,
      'https://www.jyeoo.com/physics2/ques/detail/rotatingToken888',
    ]);
    expect(q.questionId).toBe('jh0123456789abcdef');
    expect(q.answerHtml).toContain('B');
    expect(q.analysisHtml).toContain('分析：由欧姆定律入手');
    expect(q.analysisHtml).toContain('解答：U = IR = 20V');
    expect(q.meta.knowledgePoints).toEqual(['欧姆定律']);
    expect(q.meta.answerVia).toBe('report-page-tid');
    // Phase 3（D1-fix-4）：隐藏窗路径取到答案/解析 → 分级投放抽字风险如实标记
    expect(warnings.some((w) => w.includes('analysis-unverified'))).toBe(true);
  });

  it('篮内联答案但缺解析的题 → 仍走两跳补解析；篮内联答案保留不被覆写，answerVia 不变', async () => {
    const q = jyeooQ();
    q.answerHtml = '<p>C</p>';
    q.meta.answerVia = 'basket-inline';
    const deps = depsWith({
      [reportUrl]: fakePage(reportHtml, reportUrl),
      'https://www.jyeoo.com/physics2/ques/detail/rotatingToken888': fakePage(detailHtml, 'https://www.jyeoo.com/physics2/ques/detail/rotatingToken888'),
    });

    const warnings = await enrichAnswers([q], deps);

    // 实站反馈（D1-fix-3 复验）：预览"有答案无解析"——basket-inline 不再短路两跳
    expect(deps.opened).toEqual([
      reportUrl,
      'https://www.jyeoo.com/physics2/ques/detail/rotatingToken888',
    ]);
    expect(q.answerHtml).toBe('<p>C</p>'); // 篮内联答案保留
    expect(q.analysisHtml).toContain('分析：由欧姆定律入手');
    expect(q.analysisHtml).toContain('解答：U = IR = 20V');
    expect(q.meta.answerVia).toBe('basket-inline');
    // Phase 3（D1-fix-4）：隐藏窗路径补到解析 → 分级投放抽字风险如实标记
    expect(warnings.some((w) => w.includes('analysis-unverified'))).toBe(true);
  });

  it('篮内联答案且解析已齐 → enrich 跳过，不开隐藏页', async () => {
    const q = jyeooQ();
    q.answerHtml = '<p>C</p>';
    q.analysisHtml = '<p>已有解析</p>';
    q.meta.answerVia = 'basket-inline';
    const deps = depsWith({});

    const warnings = await enrichAnswers([q], deps);

    expect(deps.opened).toHaveLength(0);
    expect(q.answerHtml).toBe('<p>C</p>');
    expect(q.meta.answerVia).toBe('basket-inline');
    expect(warnings).toHaveLength(0);
  });

  it('补解析时详情页题干不匹配 → 不采解析，篮内联答案与 answerVia 保留（防串题）', async () => {
    const q = jyeooQ();
    q.answerHtml = '<p>C</p>';
    q.meta.answerVia = 'basket-inline';
    const wrongDetail = `<div class="pt1"><p>另一道完全无关的题</p></div><div class="pt5">无关分析</div>`;
    const deps = depsWith({
      [reportUrl]: fakePage(reportHtml, reportUrl),
      'https://www.jyeoo.com/physics2/ques/detail/rotatingToken888': fakePage(wrongDetail, 'https://www.jyeoo.com/physics2/ques/detail/rotatingToken888'),
    });

    const warnings = await enrichAnswers([q], deps);

    expect(q.answerHtml).toBe('<p>C</p>');
    expect(q.analysisHtml).toBe('');
    expect(q.meta.answerVia).toBe('basket-inline');
    expect(warnings.some((w) => w.includes('mismatch'))).toBe(true);
  });

  it('详情页题干与篮内不一致 → mismatch 拒绝采答案，questionId 不变（防串题）', async () => {
    const q = jyeooQ();
    const wrongDetail = `<div class="pt1"><p>另一道完全无关的题</p></div><div class="pt11">C</div>`;
    const deps = depsWith({
      [reportUrl]: fakePage(reportHtml, reportUrl),
      'https://www.jyeoo.com/physics2/ques/detail/rotatingToken888': fakePage(wrongDetail, 'https://www.jyeoo.com/physics2/ques/detail/rotatingToken888'),
    });

    const warnings = await enrichAnswers([q], deps);

    expect(q.questionId).toBe('jh0123456789abcdef');
    expect(q.answerHtml).toBe('');
    expect(q.meta.answerVia).toBe('mismatch');
    expect(warnings.some((w) => w.includes('mismatch'))).toBe(true);
  });

  it('游客 302 跳登录 → guest-redirect，不绕过', async () => {
    const q = jyeooQ();
    const deps = depsWith({
      [reportUrl]: fakePage('<html><body>请登录</body></html>', 'https://www.jyeoo.com/login?return=%2Fphysics2'),
    });

    const warnings = await enrichAnswers([q], deps);

    expect(q.questionId).toBe('jh0123456789abcdef');
    expect(q.meta.answerVia).toBe('guest-redirect');
    expect(warnings.some((w) => w.includes('guest-redirect'))).toBe(true);
  });

  it('详情页会员墙 → vip-gated 标记（questionId 为提取层内容哈希，不依赖 tid）', async () => {
    const q = jyeooQ();
    const vipDetail = `<div class="pt1"><p>某电路电阻为 10Ω，电流为 2A。</p></div><div class="mustvip">会员专享</div>`;
    const deps = depsWith({
      [reportUrl]: fakePage(reportHtml, reportUrl),
      'https://www.jyeoo.com/physics2/ques/detail/rotatingToken888': fakePage(vipDetail, 'https://www.jyeoo.com/physics2/ques/detail/rotatingToken888'),
    });

    await enrichAnswers([q], deps);

    expect(q.meta.gated).toBe(true);
    expect(q.meta.answerVia).toBe('vip-gated');
    expect(q.questionId).toBe('jh0123456789abcdef');
    expect(q.answerHtml).toBe('');
  });

  it('无报告页链接（无 reportId）→ 跳过 + warning，questionId 保持内容哈希', async () => {
    const q = jyeooQ();
    q.meta = { answerVia: '' };
    const deps = depsWith({});

    const warnings = await enrichAnswers([q], deps);

    expect(deps.opened).toHaveLength(0);
    expect(q.questionId).toBe('jh0123456789abcdef');
    expect(warnings.some((w) => w.includes('report'))).toBe(true);
  });
});

describe('enrichAnswers — jyeoo 方案①登录态内执行（D1-fix-4：两跳优先采集窗会话，隐藏窗回落）', () => {
  const basketStem = '<p>某电路电阻为 10Ω，电流为 2A。</p>';
  const reportHtml = `
    <fieldset class="quesborder" id="rotatingToken888">
      <div class="pt1"><p>2. 某电路电阻为 10Ω，电流为 2A。</p></div>
    </fieldset>
  `;
  const detailHtml = `
    <div class="pt1"><p>某电路电阻为 10Ω，电流为 2A。</p></div>
    <div class="pt3">考点：<a>欧姆定律</a></div>
    <div class="pt5">分析：由欧姆定律入手。</div>
    <div class="pt6">解答：U = IR = 20V。</div>
    <div class="pt11">B</div>
  `;
  const reportUrl = 'https://www.jyeoo.com/physics2/report/detail/5SIRL6dZc4PfopyizaYHe899HJekvIgPzq4kSKQILKBaIuJ6g5AkSm';
  const detailUrl = 'https://www.jyeoo.com/physics2/ques/detail/rotatingToken888';

  function jyeooQ(): CapturedQuestion {
    return makeQuestion({
      questionId: 'jh0123456789abcdef',
      site: 'jyeoo',
      sourceUrl: 'https://www.jyeoo.com/basket',
      stemHtml: basketStem,
      meta: { reportId: 'r1', reportUrl, subject: 'physics2', answerVia: 'report-page-tid' },
    });
  }

  /** session 页假页表 + 行为开关；hiddenOpened/sessionOpened 分别记账 */
  function sessionDeps(
    sessionPages: Record<string, HiddenPage>,
    hiddenPages: Record<string, HiddenPage>,
    sessionBehavior: 'ok' | 'null' | 'throw' = 'ok',
  ): AnswerFetchDeps & { sessionOpened: string[]; hiddenOpened: string[] } {
    const sessionOpened: string[] = [];
    const hiddenOpened: string[] = [];
    return {
      sessionOpened,
      hiddenOpened,
      openHiddenPage: async (url: string) => {
        hiddenOpened.push(url);
        const page = hiddenPages[url];
        if (!page) throw new Error(`no fake page for ${url}`);
        return page;
      },
      openSessionPage: async (url: string) => {
        sessionOpened.push(url);
        if (sessionBehavior === 'null') return null;
        if (sessionBehavior === 'throw') throw new Error('CSP connect-src blocked');
        const page = sessionPages[url];
        if (!page) throw new Error(`no fake session page for ${url}`);
        return page;
      },
    };
  }

  it('采集窗会话可用 → 两跳全走 openSessionPage，不开隐藏窗，answerVia=session-fetch', async () => {
    const q = jyeooQ();
    const deps = sessionDeps(
      { [reportUrl]: fakePage(reportHtml, reportUrl), [detailUrl]: fakePage(detailHtml, detailUrl) },
      {},
    );

    const warnings = await enrichAnswers([q], deps);

    expect(deps.sessionOpened).toEqual([reportUrl, detailUrl]);
    expect(deps.hiddenOpened).toHaveLength(0);
    expect(q.answerHtml).toContain('B');
    expect(q.analysisHtml).toContain('分析：由欧姆定律入手');
    expect(q.meta.knowledgePoints).toEqual(['欧姆定律']);
    expect(q.meta.answerVia).toBe('session-fetch');
    // Phase 3（D1-fix-4 UA 定级后回缩）：session 路径为真实浏览器形态 + 登录态，数据可信不标记
    expect(warnings.some((w) => w.includes('analysis-unverified'))).toBe(false);
    expect(warnings).toHaveLength(0);
  });

  it('openSessionPage 返回 null（采集窗未开/不在 jyeoo 域）→ 回落隐藏窗，answerVia=report-page-tid', async () => {
    const q = jyeooQ();
    const deps = sessionDeps(
      {},
      { [reportUrl]: fakePage(reportHtml, reportUrl), [detailUrl]: fakePage(detailHtml, detailUrl) },
      'null',
    );

    const warnings = await enrichAnswers([q], deps);

    expect(deps.sessionOpened).toEqual([reportUrl, detailUrl]); // 每跳先试会话通道，null 后回落
    expect(deps.hiddenOpened).toEqual([reportUrl, detailUrl]);
    expect(q.answerHtml).toContain('B');
    expect(q.meta.answerVia).toBe('report-page-tid');
    // Phase 3：隐藏窗路径取到解析 → 分级投放抽字风险如实标记
    expect(warnings.some((w) => w.includes('analysis-unverified'))).toBe(true);
  });

  it('openSessionPage 抛错（CSP/网络拦截）→ 回落隐藏窗，不中断', async () => {
    const q = jyeooQ();
    const deps = sessionDeps(
      {},
      { [reportUrl]: fakePage(reportHtml, reportUrl), [detailUrl]: fakePage(detailHtml, detailUrl) },
      'throw',
    );

    const warnings = await enrichAnswers([q], deps);

    expect(deps.hiddenOpened).toEqual([reportUrl, detailUrl]);
    expect(q.answerHtml).toContain('B');
    expect(q.meta.answerVia).toBe('report-page-tid');
    expect(warnings.some((w) => w.includes('analysis-unverified'))).toBe(true);
  });

  it('session 路径游客 302 跳登录 → guest-redirect 如实标记，不回落不绕过', async () => {
    const q = jyeooQ();
    const deps = sessionDeps(
      { [reportUrl]: fakePage('<html><body>请登录</body></html>', 'https://www.jyeoo.com/account/loginform?t=&u=%2Fphysics2') },
      {},
    );

    const warnings = await enrichAnswers([q], deps);

    expect(q.meta.answerVia).toBe('guest-redirect');
    expect(deps.hiddenOpened).toHaveLength(0);
    expect(warnings.some((w) => w.includes('guest-redirect'))).toBe(true);
  });

  it('session 路径详情页题干不匹配 → mismatch 拒绝，warning 带两侧题干前 100 字证据', async () => {
    const q = jyeooQ();
    const wrongDetail = `<div class="pt1"><p>另一道完全无关的题</p></div><div class="pt11">C</div>`;
    const deps = sessionDeps(
      { [reportUrl]: fakePage(reportHtml, reportUrl), [detailUrl]: fakePage(wrongDetail, detailUrl) },
      {},
    );

    const warnings = await enrichAnswers([q], deps);

    expect(q.meta.answerVia).toBe('mismatch');
    expect(q.answerHtml).toBe('');
    const w = warnings.find((x) => x.includes('mismatch'));
    expect(w).toBeDefined();
    expect(w).toContain('篮内:');
    expect(w).toContain('详情:');
  });
});


describe('D1-fix R-6：zujuan 实站误杀修复', () => {
  it('真实库存形态（行内公式图被块级 figure 包裹）+ 详情页 textContent → 不再误杀，答案采到', async () => {
    // 篮内 stemHtml 真实形态（库 09bb 取证）：公式图块级 figure 包 img，htmlToText 产生标签边界空格
    const q = makeQuestion({
      questionId: '35150534',
      stemHtml:
        '<p>一本质量为<figure class="diagram"><img class="q-figure" src="data-assets/capture/zujuan/35150534-1.svg"></figure>的书平放在水平桌面上，' +
        '将一张A4纸夹在书页间，如图所示。</p>',
    });
    // 详情页主题干真实结构（.quest-content .quest-cnt）：img 无文本贡献，textContent 文字直接相连
    const detailHtml = `
      <section class="quest-content"><div class="quesroot"><div class="cnt-box"><div class="quest-cnt "><p>一本质量为<img src="https://img.xkw.com/f1.svg">的书平放在水平桌面上，将一张A4纸夹在书页间，如图所示。</p></div></div></div></section>
      <section class="answer-box"><div class="answer-txt"><img src="https://imzujuan.xkw.com/getAnswerAndParse/k9.png"></div></section>
    `;
    const deps = depsWith({
      'https://zujuan.xkw.com/13q35150534.html': fakePage(detailHtml, 'https://zujuan.xkw.com/13q35150534.html'),
    });

    const warnings = await enrichAnswers([q], deps);

    expect(q.meta.answerVia).toBe('hidden-window');
    expect(q.answerHtml).toBe('<img src="https://imzujuan.xkw.com/getAnswerAndParse/k9.png">');
    expect(warnings).toHaveLength(0);
  });

  it('详情页主题干元素缺失（.quest-cnt 不存在/未加载）→ stem-not-found，不采答案且区别于 mismatch', async () => {
    const q = makeQuestion({ questionId: '35150534' });
    const noStem = `<div class="question-body"><p>题干在别的结构里</p></div><section class="answer-box"><div class="answer-txt"><img src="https://imzujuan.xkw.com/getAnswerAndParse/k9.png"></div></section>`;
    const deps = depsWith({
      'https://zujuan.xkw.com/13q35150534.html': fakePage(noStem, 'https://zujuan.xkw.com/13q35150534.html'),
    });

    const warnings = await enrichAnswers([q], deps);

    expect(q.meta.answerVia).toBe('stem-not-found');
    expect(q.answerHtml).toBe('');
    expect(warnings.some((w) => w.includes('stem-not-found'))).toBe(true);
    expect(warnings.some((w) => w.includes('mismatch'))).toBe(false);
  });

  it('防串题能力保持：详情页为无关题干 → 仍 mismatch 拒绝', async () => {
    const q = makeQuestion({ questionId: '35150534' });
    const wrong = `
      <section class="quest-content"><div class="quesroot"><div class="cnt-box"><div class="quest-cnt "><p>一小球沿斜面由静止滚下，求加速度。</p></div></div></div></section>
      <section class="answer-box"><div class="answer-txt"><img src="https://imzujuan.xkw.com/getAnswerAndParse/wrong.png"></div></section>
    `;
    const deps = depsWith({
      'https://zujuan.xkw.com/13q35150534.html': fakePage(wrong, 'https://zujuan.xkw.com/13q35150534.html'),
    });

    await enrichAnswers([q], deps);

    expect(q.meta.answerVia).toBe('mismatch');
    expect(q.answerHtml).toBe('');
  });
});


// ==================== D1-fix-6：跨页持久篮——enrich 前注入库存 bankid ====================

describe('injectStoredBankids — 异页采集注入库存 bankid（D1-fix-6，table-driven）', () => {
  const cases: Array<{
    name: string;
    meta: CapturedQuestion['meta'];
    existing: Array<{ sourceDetail?: Record<string, unknown> }>;
    expected: string | undefined;
  }> = [
    {
      name: '本次未解析到 + 库存有（site:questionId 命中）→ 注入库存实测值',
      meta: {},
      existing: [{ sourceDetail: { site: 'zujuan', questionId: 'q1', bankid: '14' } }],
      expected: '14',
    },
    {
      name: '本次已解析到（14）→ 本次值优先，库存（13）不覆盖',
      meta: { bankid: '14' },
      existing: [{ sourceDetail: { site: 'zujuan', questionId: 'q1', bankid: '13' } }],
      expected: '14',
    },
    {
      name: '库存无 bankid → 不注入（enrich 回落 13q，行为同改造前）',
      meta: {},
      existing: [{ sourceDetail: { site: 'zujuan', questionId: 'q1' } }],
      expected: undefined,
    },
    {
      name: '异站同题号不命中 → 不注入',
      meta: {},
      existing: [{ sourceDetail: { site: 'jyeoo', questionId: 'q1', bankid: '14' } }],
      expected: undefined,
    },
    {
      name: '库存无该题号 → 不注入',
      meta: {},
      existing: [{ sourceDetail: { site: 'zujuan', questionId: 'other', bankid: '14' } }],
      expected: undefined,
    },
    {
      name: '库存 bankid 空串 → 不注入（不当有效值使用）',
      meta: {},
      existing: [{ sourceDetail: { site: 'zujuan', questionId: 'q1', bankid: '' } }],
      expected: undefined,
    },
    {
      name: '库存 sourceDetail 缺省/空数组 → 不注入',
      meta: {},
      existing: [{}, { sourceDetail: undefined }],
      expected: undefined,
    },
  ];

  it.each(cases)('$name', ({ meta, existing, expected }) => {
    const q = makeQuestion({ meta });

    injectStoredBankids([q], existing);

    expect(q.meta.bankid).toBe(expected);
  });

  it('注入后 enrich 走库存 bankid 开详情页（缺陷现场：首页重采异页加篮的高中化学题 35355749）', async () => {
    const q = makeQuestion({ questionId: '35355749', meta: {} });
    injectStoredBankids([q], [
      { sourceDetail: { site: 'zujuan', questionId: '35355749', bankid: '14' } },
    ]);
    const detail = `
      <section class="quest-content">
        <div class="quesroot" questionid="35355749" bankid="14">
          <div class="cnt-box"><div class="quest-cnt "><p>一物体从高处自由下落，经过时间 t 落地，求速度。</p></div></div>
        </div>
      </section>
      <section class="answer-box"><div class="answer-txt"><img src="https://imzujuan.xkw.com/getAnswerAndParse/hx14.png"></div></section>
    `;
    const deps = depsWith({
      'https://zujuan.xkw.com/14q35355749.html': fakePage(detail, 'https://zujuan.xkw.com/14q35355749.html'),
    });

    const warnings = await enrichAnswers([q], deps);

    expect(deps.opened).toEqual(['https://zujuan.xkw.com/14q35355749.html']);
    expect(q.answerHtml).toBe('<img src="https://imzujuan.xkw.com/getAnswerAndParse/hx14.png">');
    expect(q.meta.answerVia).toBe('hidden-window');
    expect(warnings).toHaveLength(0);
  });

  it('库存与本次都无 bankid → enrich 仍走 13q 回落（老数据/老页面零变化）', async () => {
    const q = makeQuestion({ questionId: '987654', meta: {} });
    injectStoredBankids([q], []);
    const detail = `
      <section class="quest-content">
        <div class="quesroot" questionid="987654"><div class="cnt-box"><div class="quest-cnt "><p>一物体从高处自由下落，经过时间 t 落地，求速度。</p></div></div></div>
      </section>
      <section class="answer-box"><div class="answer-txt"><img src="https://imzujuan.xkw.com/getAnswerAndParse/k1.png"></div></section>
    `;
    const deps = depsWith({
      'https://zujuan.xkw.com/13q987654.html': fakePage(detail, 'https://zujuan.xkw.com/13q987654.html'),
    });

    await enrichAnswers([q], deps);

    expect(deps.opened).toEqual(['https://zujuan.xkw.com/13q987654.html']);
    expect(q.meta.answerVia).toBe('hidden-window');
  });
});
