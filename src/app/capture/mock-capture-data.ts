// D1 P1: 浏览器 dev 环境 mock 采集数据 + 内存 mock 桥
// 数据结构与 capture-types 契约同构（type-check 防漂移）；行为对齐真实链路：
// navigate 自动开窗、jyeoo gated 题 answerHtml 空、collect 内存去重（首 ok / 再 dup）

import type { MofangCaptureBridge } from '../../shared/contracts/bridge.js';
import type {
  CaptureExtraction,
  CaptureSite,
  CaptureWindowState,
  PaperPreview,
} from '../../shared/contracts/capture-types.js';
import { parseZujuanPaperUrl, ZUJUAN_PAPER_URL_HINT } from '../../capture/papers/paper-url.js';

// 1px PNG data-uri（浏览器 dev 无资产根时的图占位回落演示）
export const PIXEL_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

export const MOCK_ZUJUAN_EXTRACTION: CaptureExtraction = {
  url: 'https://zujuan.xkw.com',
  mode: 'zujuan-basket',
  warnings: [],
  captured: [
    {
      questionId: '13q900001',
      site: 'zujuan',
      sourceUrl: 'https://zujuan.xkw.com',
      stemHtml: '<p>已知 <span class="math" data-tex="x^2-5x+6=0"></span>，则 x 的值为（ ）</p>',
      options: [
        '<span class="math" data-tex="x=2"></span> 或 <span class="math" data-tex="x=3"></span>',
        'x=1 或 x=6',
        'x=-2 或 x=-3',
        'x=0 或 x=5',
      ],
      answerHtml: '<p>A</p>',
      analysisHtml: '<p>因式分解得 <span class="math" data-tex="(x-2)(x-3)=0"></span>。</p>',
      images: [],
      meta: {
        questionType: '单选题',
        difficulty: '中等',
        knowledgePoints: ['一元二次方程'],
        source: '2023 武汉中考',
        answerVia: 'hidden-window',
      },
      rect: null,
    },
    {
      questionId: '13q900002',
      site: 'zujuan',
      sourceUrl: 'https://zujuan.xkw.com',
      stemHtml:
        '<p>如图，在△ABC中，AB=AC，D 为 BC 中点，求证 AD⊥BC。</p>' +
        '<figure class="diagram" data-align="center" data-w="300" data-h="200">' +
        '<img src="data-assets/capture/zujuan/13q900002-1.png" alt="几何配图"></figure>',
      options: [],
      answerHtml: '<p>证明见解析。</p>',
      analysisHtml: '<p>等腰三角形三线合一。</p>',
      images: [
        { src: 'data-assets/capture/zujuan/13q900002-1.png', alt: '几何配图', role: 'content' },
      ],
      meta: {
        questionType: '解答题',
        difficulty: '较难',
        knowledgePoints: ['等腰三角形'],
        answerVia: 'hidden-window',
      },
      rect: null,
    },
    {
      questionId: '13q900003',
      site: 'zujuan',
      sourceUrl: 'https://zujuan.xkw.com',
      stemHtml: `<p>二次函数 <span class="math" data-tex="y=x^2-2x-3"></span> 的顶点坐标为____。<img src="${PIXEL_DATA_URI}" alt="函数图像"></p>`,
      options: [],
      answerHtml: '<p>(1, -4)</p>',
      analysisHtml: '',
      images: [{ src: PIXEL_DATA_URI, alt: '函数图像', role: 'content' }],
      meta: { questionType: '填空题', difficulty: '容易', answerVia: 'hidden-window' },
      rect: null,
    },
  ],
};

export const MOCK_JYEOO_EXTRACTION: CaptureExtraction = {
  url: 'https://www.jyeoo.com',
  mode: 'jyeoo-basket',
  warnings: ['jyeoo-tid-900002 答案被会员墙挡住（vip-gated）'],
  captured: [
    {
      questionId: 'jyeoo-tid-900001',
      site: 'jyeoo',
      sourceUrl: 'https://www.jyeoo.com',
      stemHtml: '<p>掷一枚均匀骰子，点数为偶数的概率是（ ）</p>',
      options: [
        '<span class="math" data-tex="\\frac{1}{6}"></span>',
        '<span class="math" data-tex="\\frac{1}{2}"></span>',
        '<span class="math" data-tex="\\frac{1}{3}"></span>',
        '<span class="math" data-tex="\\frac{2}{3}"></span>',
      ],
      answerHtml: '<p>B</p>',
      analysisHtml: '<p>偶数点 2/4/6 共 3 种，概率 <span class="math" data-tex="\\frac{3}{6}=\\frac{1}{2}"></span>。</p>',
      images: [],
      meta: {
        questionType: '单选题',
        difficulty: '容易',
        knowledgePoints: ['概率'],
        answerVia: 'report-page-tid',
      },
      rect: null,
    },
    {
      questionId: 'jyeoo-tid-900002',
      site: 'jyeoo',
      sourceUrl: 'https://www.jyeoo.com',
      stemHtml: '<p>已知等差数列前 n 项和公式，求通项。</p>',
      options: [],
      answerHtml: '',
      analysisHtml: '',
      images: [],
      meta: { questionType: '解答题', gated: true, answerVia: 'vip-gated' },
      rect: null,
    },
    {
      questionId: 'jyeoo-tid-900003',
      site: 'jyeoo',
      sourceUrl: 'https://www.jyeoo.com',
      stemHtml: '<p>解不等式 <span class="math" data-tex="2x-1>3"></span>。</p>',
      options: [],
      answerHtml: '<p><span class="math" data-tex="x>2"></span></p>',
      analysisHtml: '<p>移项得 2x&gt;4。</p>',
      images: [],
      meta: { questionType: '解答题', difficulty: '中等', answerVia: 'report-page-tid' },
      rect: null,
    },
  ],
};

const MOCK_EXTRACTIONS: Record<'zujuan' | 'jyeoo', CaptureExtraction> = {
  zujuan: MOCK_ZUJUAN_EXTRACTION,
  jyeoo: MOCK_JYEOO_EXTRACTION,
};

function detectMockSite(url: string): CaptureSite | null {
  // 与引擎 detectSite 对齐：学科网系组卷网 = *.xkw.com（裸域 zujuan.com 是第三方站，不误判）
  if (/xkw\.com/.test(url)) return 'zujuan';
  if (/jyeoo\.com/.test(url)) return 'jyeoo';
  return null;
}

/** 0006 P4（浏览器 dev 回落）：整卷下载预览样本（与真实链路同构：题号/题型/摘要/子母题/覆盖率告警） */
export const MOCK_PAPER_PREVIEW: PaperPreview = {
  url: 'https://zujuan.xkw.com/4p2338916.html',
  bankId: '4',
  paperId: '2338916',
  title: '广东省东莞市东华初级中学2024-2025学年八年级上学期11月期中物理试题',
  total: 3,
  items: [
    {
      questionId: '22724580', bankid: '4', questionType: '单选题', difficulty: '较易',
      stemSummary: '探究物体吸收太阳能的能力与什么有关', answerPresent: true, analysisPresent: true,
      childCount: 1, knowledgePoints: ['提出可以探究的假设'],
    },
    {
      questionId: '23283767', bankid: '4', questionType: '单选题', difficulty: '适中',
      stemSummary: '光的反射实验现象', answerPresent: true, analysisPresent: true, childCount: 1,
    },
    {
      questionId: '21875127', bankid: '4', questionType: '解答题', difficulty: '适中',
      stemSummary: '含 2 小题的母题（v1 不拆子题）', answerPresent: true, analysisPresent: false, childCount: 2,
    },
  ],
  missing: [],
  warnings: ['题批接口未返回 1 题（站点覆盖率缺口）：25064552'],
};

function cloneExtraction(e: CaptureExtraction, url: string): CaptureExtraction {
  return { ...e, url, captured: e.captured.map((q) => ({ ...q })), warnings: [...e.warnings] };
}

/** 内存 mock 桥（纯浏览器 dev）：行为对齐真实链路，供 CaptureClient 回落与组件测试 */
export function createMockCaptureBridge(): MofangCaptureBridge {
  const state: CaptureWindowState = {
    open: false,
    url: '',
    title: '',
    site: null,
    loggedIn: false,
    lastExtraction: null,
  };
  // 内存去重（对齐 ingest 的 site:questionId 键），跨 collect 调用保持
  const collected = new Set<string>();
  // L-2：最近一次提取结果（getLastExtraction 与真实链路对齐）
  let lastExtractionData: CaptureExtraction | null = null;

  return {
    async openWindow() {
      state.open = true;
    },
    async closeWindow() {
      state.open = false;
      state.url = '';
      state.title = '';
      state.site = null;
      state.loggedIn = false;
    },
    async navigate({ url }) {
      // 真实链路 navigate 自动开窗（host.navigate → openWindow）
      state.open = true;
      state.url = url;
      state.site = detectMockSite(url);
      state.title = state.site ? `${state.site} 页面` : url;
      state.loggedIn = state.site !== null;
    },
    async getState() {
      return { ...state };
    },
    // 0012：内嵌 view 形态 mock 语义等价——bounds 记忆不渲染、事件订阅 no-op、保存HTML 如实不支持
    async setBounds() { /* mock 无原生 view，no-op */ },
    onEvent() {
      // mock 无导航事件流（轮询兜底驱动状态刷新），返回 no-op 退订
      return () => { /* no-op */ };
    },
    async savePageHtml() {
      return { ok: false, error: 'mock 环境不支持保存页面 HTML（真实链路落盘 userData/data/capture-html-snapshots/）' };
    },
    async extractBasket() {
      if (!state.open) throw new Error('capture window not open（先 openWindow）');
      const preset = state.site === 'zujuan' || state.site === 'jyeoo' ? MOCK_EXTRACTIONS[state.site] : null;
      const extracted: CaptureExtraction = preset
        ? cloneExtraction(preset, state.url)
        : { url: state.url, mode: 'none', captured: [], warnings: ['当前页面未识别为支持的试题篮'] };
      state.lastExtraction = { at: new Date().toISOString(), count: extracted.captured.length };
      lastExtractionData = extracted;
      return { extracted };
    },
    async getLastExtraction() {
      return { extracted: lastExtractionData };
    },
    // 0006 P4：整卷下载（浏览器 dev 回落；URL 校验/错误文案与真实链路同源）
    async paperPreview({ url }) {
      const ref = parseZujuanPaperUrl(url);
      if (!ref) throw new Error(ZUJUAN_PAPER_URL_HINT);
      return { ...MOCK_PAPER_PREVIEW, url: ref.url, bankId: ref.bankId, paperId: ref.paperId };
    },
    async paperImport({ url, questionIds, target }) {
      const ref = parseZujuanPaperUrl(url);
      if (!ref) throw new Error(ZUJUAN_PAPER_URL_HINT);
      if (target !== 'paper' && target !== 'bank') throw new Error(`非法去向：${String(target)}`);
      const ids = questionIds.filter((id) => MOCK_PAPER_PREVIEW.items.some((i) => i.questionId === id));
      if (ids.length === 0) throw new Error('未选择任何题目');
      return {
        target,
        ...(target === 'paper'
          ? { paperId: 'mock-paper-p4', paperTitle: MOCK_PAPER_PREVIEW.title, snapshotCount: ids.length, done: true }
          : {}),
        ok: ids.length,
        dup: 0,
        updated: 0,
        failed: [],
        warnings: [],
      };
    },
    async collect({ extracted }) {
      const result = { ok: 0, dup: 0, failed: [] as Array<{ questionId: string; error: string }>, okIds: [] as string[] };
      for (const q of extracted.captured) {
        if (!q.questionId || /^temp-/i.test(q.questionId)) {
          result.failed.push({ questionId: q.questionId || '(empty)', error: 'missing real questionId（真实 tid 未解析，不入库）' });
          continue;
        }
        const key = `${q.site}:${q.questionId}`;
        if (collected.has(key)) {
          result.dup++;
          continue;
        }
        collected.add(key);
        result.ok++;
        // 0004-fix-1 D：mock 同步返回 okIds（对齐真实链路语义：ok 新建计入；dup 不含）
        result.okIds.push(`mock-q-${key}`);
      }
      return result;
    },
  };
}
