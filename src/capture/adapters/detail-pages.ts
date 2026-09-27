/**
 * 详情页/报告页 页内解析（纯函数，浏览器/ jsdom 双环境可执行）
 *
 * 这些函数与注入 bundle（inject-entry.ts）共用同一实现，经 esbuild 打包后
 * 由主进程 executeJavaScript 在页面上下文调用；Node 测试直接 import。
 *
 * 注：函数在浏览器环境执行，doc 参数用 any 避免 DOM 类型依赖
 */

import { normalizeStem, isStemMatch } from './stem-match.js';
import { replaceMathJyeWithTex } from './mathjye.js';

/**
 * HTML → 纯文本（剥离标签、解码常见实体、收敛空白）
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 会员墙标识（jyeoo .mustvip 为 POC 实证；其余为保守推断，待 D1 实站校准） */
const VIP_SELECTORS = ['.mustvip', '.vip-answer-lock', '.answer-vip', '.member-only'];

export function detectVipGated(doc: any): boolean {
  return VIP_SELECTORS.some((sel) => !!doc.querySelector(sel));
}

/** 游客 302 跳登录识别（不绕过，仅标记）；实站形态含 jyeoo /account/loginform（D1-fix-3 第三轮取证） */
export function isLoginPageUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname.toLowerCase().startsWith('login.') || /\/login(form)?\b/i.test(u.pathname);
  } catch {
    return false;
  }
}

export interface ZujuanAnswerParse {
  stemText: string;
  answerImg?: string;
  answerText?: string;
  gated: boolean;
  /** 详情页未登录墙（.need-login，D1-fix-2 F-1 实站取证）：答案区服务端不渲染，空等无意义 */
  loginRequired: boolean;
}

/**
 * zujuan 详情页主题干容器（D1-fix-2 F-1 实站取证 fixtures/live 3/3 一致）：
 * 主题干在 `.quest-content .quest-cnt`；`.exam-item__cnt` 在详情页只出现在【推荐N】区
 * （.rec-tests 内），全页 querySelector('.exam-item__cnt') 必误取推荐题——严禁回退。
 */
const ZUJUAN_DETAIL_STEM_SELECTORS = ['.quest-content .quest-cnt', '.quest-cnt'];

/**
 * zujuan 详情页解析：.answer-box .answer-txt img（防采集图，JS 异步注入）+ 主题干文本（防串题用）
 */
export function parseZujuanAnswer(doc: any): ZujuanAnswerParse {
  let stemText = '';
  for (const sel of ZUJUAN_DETAIL_STEM_SELECTORS) {
    const el = doc.querySelector(sel);
    if (el) {
      stemText = (el.textContent || '').replace(/\s+/g, ' ').trim();
      break;
    }
  }

  const gated = detectVipGated(doc);
  const loginRequired = !!doc.querySelector('.need-login');

  // 答案区限定主内容 .answer-box（推荐区若含同名结构不误入）；兼容旧结构回落全页
  const box = doc.querySelector('.answer-box .answer-txt') || doc.querySelector('.answer-txt');
  const img = box ? box.querySelector('img') : null;
  const imgSrc = img?.getAttribute('src') || '';
  const answerImg = imgSrc || undefined;

  const text = box ? (box.textContent || '').replace(/\s+/g, ' ').trim() : '';
  const answerText = !answerImg && text ? text : undefined;

  return { stemText, answerImg, answerText, gated, loginRequired };
}

export interface ZujuanAnswerPollResult extends ZujuanAnswerParse {
  timedOut: boolean;
}

/**
 * 轮询 .answer-txt img 出现（POC 实证：原始 HTML 无此 img，JS 异步注入，页内 fetch 拿不到）
 * 会员墙页不空等，立即返回
 */
export function pollZujuanAnswer(
  doc: any,
  opts: { timeoutMs: number; intervalMs: number }
): Promise<ZujuanAnswerPollResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const parsed = parseZujuanAnswer(doc);
      if (parsed.gated || parsed.loginRequired || parsed.answerImg) {
        resolve({ ...parsed, timedOut: false });
        return;
      }
      if (Date.now() - started >= opts.timeoutMs) {
        resolve({ ...parsed, timedOut: true });
        return;
      }
      setTimeout(tick, opts.intervalMs);
    };
    tick();
  });
}

export interface JyeooDetailParse {
  stemText: string;
  gated: boolean;
  answerHtml: string;
  analysisHtml: string;
  knowledgePoints: string[];
}

/**
 * jyeoo 题干文本对称化（防串题匹配专用）：克隆 pt1 → 剥 .qseq 题号 / .ques-source 来源链接 →
 * 剥 .sanwser 内联答案、.quizPutTag 占位格 → ____（与篮内提取 extractJyeooBasket 同序同规则）→
 * MathJye div 汤替换为无文本 span.math，取 textContent。
 * 篮内提取（extractJyeooBasket）产出的 stemHtml 经 htmlToText 后正是此形态；
 * 报告页/详情页侧同规则处理，避免来源前缀与公式字符汤造成 mismatch 误杀（D1-fix-3 第三轮实站定级）。
 * D1-fix-4 J-7：详情页填空题 pt1 内嵌 <!--BA-->.quizPutTag<!--EA-->.sanwser（占位格+答案相邻），
 * 不剥则题干流含答案重复（实站快照 detail-b "4-64-6"）→ mismatch 误杀。
 */
export function jyeooStemTextForMatch(stemEl: any): string {
  if (!stemEl) return '';
  const clone = stemEl.cloneNode(true);
  clone.querySelectorAll('.qseq, .ques-source').forEach((el: any) => el.parentNode.removeChild(el));
  // 填空对称化（与篮内提取同规则）：内联答案剥除，作答占位格 → ____
  clone.querySelectorAll('.sanwser').forEach((el: any) => el.parentNode.removeChild(el));
  clone.querySelectorAll('.quizPutTag').forEach((el: any) => {
    el.parentNode.replaceChild(clone.ownerDocument.createTextNode('____'), el);
  });
  replaceMathJyeWithTex(clone);
  return (clone.textContent || '').replace(/\s+/g, ' ').trim();
}

/**
 * jyeoo 详情页解析（服务端渲染文本，POC 实证 2/2）：
 * .pt11【答案】/.pt5,.pt6（,.pt7,.pt8）【分析/解答】/.pt3 a【考点】/.pt1【题干】
 * stemText 为对称化匹配文本（jyeooStemTextForMatch），非展示用 HTML
 * D1-fix-4 复验 J-9：答案/解析 innerHTML 与题干/选项同管线——克隆后 MathJye div 汤
 * 转 span.math[data-tex]（KaTeX 管线），否则导出试卷公式全丢
 */
/** 元素 innerHTML（克隆加工，不动页面 DOM）：MathJye div 汤 → span.math[data-tex] */
function innerHtmlWithMathTex(el: any): string {
  if (!el) return '';
  const clone = el.cloneNode(true);
  replaceMathJyeWithTex(clone);
  return (clone.innerHTML || '').trim();
}

export function parseJyeooDetail(doc: any): JyeooDetailParse {
  const stemText = jyeooStemTextForMatch(doc.querySelector('.pt1'));

  const gated = detectVipGated(doc);

  const answerHtml = innerHtmlWithMathTex(doc.querySelector('.pt11'));

  const analysisParts: string[] = [];
  doc.querySelectorAll('.pt5,.pt6,.pt7,.pt8').forEach((el: any) => {
    const html = innerHtmlWithMathTex(el);
    if (html) analysisParts.push(html);
  });

  const knowledgePoints: string[] = [];
  doc.querySelectorAll('.pt3 a').forEach((a: any) => {
    const t = (a.textContent || '').trim();
    if (t) knowledgePoints.push(t);
  });

  return { stemText, gated, answerHtml, analysisHtml: analysisParts.join(''), knowledgePoints };
}

/**
 * jyeoo 报告页：按篮内题干匹配服务端渲染 fieldset，返回其 DOM id（真实 tid）
 * 防串题：用 stem-match 的归一化匹配，不匹配返回 null
 */
export function findReportFieldsetTid(doc: any, basketStemText: string): string | null {
  const fieldsets = doc.querySelectorAll('fieldset.quesborder');
  let hit: string | null = null;
  fieldsets.forEach((f: any) => {
    if (hit) return;
    const stemText = jyeooStemTextForMatch(f.querySelector('.pt1'));
    if (stemText && isStemMatch(normalizeStem(basketStemText), normalizeStem(stemText))) {
      const id = f.getAttribute('id');
      if (id) hit = id;
    }
  });
  return hit;
}
