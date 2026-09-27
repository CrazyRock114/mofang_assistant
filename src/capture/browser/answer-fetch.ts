/**
 * 答案/解析获取链路（主进程编排层）
 *
 * - zujuan：同 session 隐藏 BrowserWindow 加载详情页，轮询 .answer-txt img（POC 实证 3/3）
 * - jyeoo：篮内联答案（basket-inline，实站实证选择 label.s.sh / 填空 .sanwser）优先；
 *   无内联答案的题走两跳：报告页题干匹配 fieldset → 详情页 .pt11/.pt5-8/.pt3。
 *   两跳取页优先方案①采集窗登录态会话内 fetch（openSessionPage，D1-fix-4：隐藏窗被服务端
 *   分级投放 302/抽字，采集窗页内 fetch 与用户真人浏览等效），不可用回落隐藏窗；
 *   隐藏窗路径取到答案/解析打 analysis-unverified 抽字风险标记（D1-fix-4 实站定级：根因为
 *   UA 分级投放，采集窗标准 Chrome UA + 登录态数据完整可信，隐藏窗非真实浏览器形态仍可能被抽字），
 *   不静默当完整解析入库。
 *   实站实证（D1-fix-3）：report/detail token 每渲染轮换，两跳结果仅作答案来源，
 *   questionId 一律用提取层内容哈希，本层不改写
 * - 双站强制防串题：详情页题干须与篮内题干归一化匹配，否则 answerVia='mismatch' 拒绝
 * - 会员墙 gated / 游客 302 跳登录 guest-redirect：如实标记，不绕过
 *
 * 页内解析纯函数在 adapters/detail-pages.ts（与注入 bundle 同一实现）；
 * 本层只依赖 HiddenPage 抽象，Electron 接线在 host.ts，测试用 jsdom 假页。
 */

import type { CapturedQuestion } from '../../shared/contracts/capture-types.js';
import { htmlToText, isLoginPageUrl, type ZujuanAnswerPollResult, type JyeooDetailParse } from '../adapters/detail-pages.js';
import { isStemMatch } from '../adapters/stem-match.js';

const DEFAULT_TIMEOUT_MS = 15000;
const POLL_INTERVAL_MS = 250;

/** 隐藏页抽象：Electron 隐藏 BrowserWindow 或测试假页 */
export interface HiddenPage {
  /** 最终 URL（重定向后），用于游客 302 跳登录识别 */
  finalUrl(): string;
  /** 调用页内 bundle 暴露的解析函数（__mofangCapturePage.<fnName>） */
  call(fnName: string, ...args: unknown[]): Promise<any>;
  close(): Promise<void>;
}

export interface AnswerFetchDeps {
  openHiddenPage(url: string): Promise<HiddenPage>;
  /**
   * D1-fix-4 方案①：jyeoo 两跳优先在采集窗登录态会话内执行（页内同源 fetch，真实浏览器形态 +
   * 完整会话 cookie，消除「无头/隐藏窗被服务端分级投放」嫌疑）。
   * 返回 null 或抛错 = 不可用（采集窗未开/不在 jyeoo 域/页面 CSP 拦截），由编排层回落隐藏窗。
   */
  openSessionPage?: (url: string) => Promise<HiddenPage | null>;
}

/** jyeoo 两跳取页路径：session-fetch = 采集窗登录态内执行；hidden-window = 隐藏窗回落 */
type JyeooPagePath = 'session-fetch' | 'hidden-window';

/** jyeoo 取页：方案①采集窗会话优先，不可用回落隐藏窗（防串题/标记逻辑与路径无关） */
async function openJyeooPage(deps: AnswerFetchDeps, url: string): Promise<{ page: HiddenPage; via: JyeooPagePath }> {
  if (deps.openSessionPage) {
    try {
      const sessionPage = await deps.openSessionPage(url);
      if (sessionPage) return { page: sessionPage, via: 'session-fetch' };
    } catch { /* 采集窗不可用/跨域/CSP 拦截 → 回落隐藏窗 */ }
  }
  return { page: await deps.openHiddenPage(url), via: 'hidden-window' };
}

export interface EnrichOptions {
  timeoutMs?: number;
}

/**
 * zujuan 详情页 URL（实站形态：zujuan.xkw.com/{bankid}q{qid}.html，qid 可能自带前缀）
 *
 * D1-fix-5：题库前缀 = 该题 bankid（13=物理、14=高中化学…… 不枚举映射表，直接用题块属性值）；
 * 缺 bankid 回落 13q（历史行为，老数据/老页面无该字段）；qid 自带 `{bankid}q` 前缀时幂等不重复拼接。
 */
export function zujuanDetailUrl(questionId: string, bankid?: string): string {
  const prefixMatch = /^(\d+)q/i.exec(questionId);
  const numeric = prefixMatch ? questionId.slice(prefixMatch[0].length) : questionId;
  const prefix = bankid || prefixMatch?.[1] || '13';
  return `https://zujuan.xkw.com/${prefix}q${numeric}.html`;
}

/** jyeoo 详情页 URL：/{subject}/ques/detail/{tid} */
export function jyeooDetailUrl(subject: string, tid: string): string {
  return `https://www.jyeoo.com/${subject}/ques/detail/${encodeURIComponent(tid)}`;
}

/**
 * D1-fix-6（只增）：enrich 前注入库存 bankid——组卷试题篮跨页持久，异页采集时当前页 DOM
 * 可能无从解析（①②③④ 全落空），而该题首次入库时已把实测 bankid 落进 sourceDetail。
 * 按去重键 site:questionId 命中已有题且库存 bankid 有值、本次未解析到 → 注入 meta.bankid。
 * 优先序：本次解析值 > 库存实测值 > zujuanDetailUrl 的 13q 回落（本次有值一律不覆盖）。
 * 无值/键不齐一律不注入（不猜），由 enrich 沿用既有回落行为。
 */
export function injectStoredBankids(
  captured: CapturedQuestion[],
  existing: Array<{ sourceDetail?: Record<string, unknown> }>,
): void {
  const stored = new Map<string, string>();
  for (const q of existing) {
    const detail = q.sourceDetail;
    if (!detail) continue;
    const { site, questionId, bankid } = detail;
    if (typeof site !== 'string' || typeof questionId !== 'string') continue;
    if (typeof bankid !== 'string' || !bankid) continue;
    stored.set(`${site}:${questionId}`, bankid);
  }
  for (const q of captured) {
    if (q.meta.bankid) continue;
    const bankid = stored.get(`${q.site}:${q.questionId}`);
    if (bankid) q.meta.bankid = bankid;
  }
}

async function enrichZujuan(q: CapturedQuestion, deps: AnswerFetchDeps, timeoutMs: number, warnings: string[]): Promise<void> {
  if (!q.questionId) {
    warnings.push(`zujuan:${q.questionId || '(empty)'} missing-question-id`);
    q.meta.answerVia = 'error';
    return;
  }

  let page: HiddenPage | null = null;
  try {
    page = await deps.openHiddenPage(zujuanDetailUrl(q.questionId, q.meta.bankid));
    const result: ZujuanAnswerPollResult = await page.call('pollZujuanAnswer', timeoutMs, POLL_INTERVAL_MS);

    if (result.gated) {
      q.meta.gated = true;
      q.meta.answerVia = 'vip-gated';
      return;
    }

    // 未登录墙（.need-login，实站取证）：答案区服务端不渲染，空等只会 timeout，直接标记提示登录后重采
    if (result.loginRequired) {
      q.meta.answerVia = 'login-required';
      warnings.push(`zujuan:${q.questionId} login-required 详情页提示未登录，不能查看答案和解析；请在采集窗口登录后重新采集`);
      return;
    }

    // 详情页题干未取到（结构变化/未加载）≠ 串题：单独标记，防串题无法校验时宁缺毋滥不采答案（D1-fix R-6）
    if (!result.stemText) {
      q.meta.answerVia = 'stem-not-found';
      warnings.push(`zujuan:${q.questionId} stem-not-found 详情页题干未取到（.quest-content .quest-cnt 缺失或未加载），防串题无法校验，跳过答案`);
      return;
    }

    // 防串题：详情页题干须与篮内题干归一化匹配
    const basketText = htmlToText(q.stemHtml);
    if (!isStemMatch(basketText, result.stemText)) {
      q.meta.answerVia = 'mismatch';
      // 诊断详情（D1-fix 复验期加）：两侧题干前 100 字入 warning，供实站差异取证
      warnings.push(
        `zujuan:${q.questionId} mismatch 详情页题干与篮内题干不一致，拒绝采答案 | 篮内:${basketText.slice(0, 100)} | 详情:${(result.stemText || '').slice(0, 100)}`
      );
      return;
    }

    if (result.timedOut) {
      q.meta.answerVia = 'timeout';
      warnings.push(`zujuan:${q.questionId} timeout .answer-txt img ${timeoutMs}ms 内未出现`);
      return;
    }

    if (result.answerImg) {
      q.answerHtml = `<img src="${result.answerImg}">`;
      q.images.push({ src: result.answerImg, alt: '答案与解析', role: 'answer' });
      q.meta.answerVia = 'hidden-window';
    } else if (result.answerText) {
      q.answerHtml = result.answerText;
      q.meta.answerVia = 'hidden-window';
    } else {
      q.meta.answerVia = 'timeout';
      warnings.push(`zujuan:${q.questionId} timeout 答案区域为空`);
    }
  } catch (error: any) {
    q.meta.answerVia = 'error';
    warnings.push(`zujuan:${q.questionId} error ${error?.message || String(error)}`);
  } finally {
    if (page) await page.close();
  }
}

async function enrichJyeoo(q: CapturedQuestion, deps: AnswerFetchDeps, warnings: string[]): Promise<void> {
  const reportUrl = q.meta.reportUrl as string | undefined;
  const reportId = q.meta.reportId as string | undefined;
  const subject = (q.meta.subject as string | undefined) || 'math';
  // 篮内联答案（basket-inline）只覆盖答案；解析/考点仍需两跳补抓（D1-fix-3 复验：有答案无解析）
  const needAnswer = !q.answerHtml;
  const needAnalysis = !q.analysisHtml;

  if (!reportId || !reportUrl) {
    warnings.push(`jyeoo:${q.questionId || '(no-id)'} no-report-link 无报告页链接，跳过两跳补抓`);
    if (needAnswer) q.meta.answerVia = '';
    return;
  }

  const basketStemText = htmlToText(q.stemHtml);

  // 第一跳：报告页 → 题干匹配 fieldset，取其 DOM id 作详情页 URL 中间键
  // （实站实证 D1-fix-3：该 id 为每次渲染轮换的加密 token，仅当次可拼详情页，不作题库主键）
  // D1-fix-4 方案①：优先采集窗登录态会话内 fetch（真实浏览器形态），不可用回落隐藏窗
  let reportPage: HiddenPage | null = null;
  let tid: string | null = null;
  let via: JyeooPagePath = 'hidden-window';
  try {
    const hop = await openJyeooPage(deps, reportUrl);
    reportPage = hop.page;
    via = hop.via;
    if (isLoginPageUrl(reportPage.finalUrl())) {
      if (needAnswer) q.meta.answerVia = 'guest-redirect';
      warnings.push(`jyeoo:report-${reportId} guest-redirect 游客 302 跳登录，不绕过`);
      return;
    }
    tid = await reportPage.call('findReportFieldsetTid', basketStemText);
  } catch (error: any) {
    if (needAnswer) q.meta.answerVia = 'error';
    warnings.push(`jyeoo:report-${reportId} error ${error?.message || String(error)}`);
    return;
  } finally {
    if (reportPage) await reportPage.close();
  }

  if (!tid) {
    if (needAnswer) q.meta.answerVia = 'mismatch';
    warnings.push(`jyeoo:report-${reportId} report-tid-not-found 报告页无题干匹配 fieldset | 篮内:${basketStemText.slice(0, 100)}`);
    return;
  }

  // 第二跳：详情页（同会话路径）→ .pt11/.pt5-8/.pt3
  let detailPage: HiddenPage | null = null;
  try {
    const hop = await openJyeooPage(deps, jyeooDetailUrl(subject, tid));
    detailPage = hop.page;
    via = hop.via;
    if (isLoginPageUrl(detailPage.finalUrl())) {
      if (needAnswer) q.meta.answerVia = 'guest-redirect';
      warnings.push(`jyeoo:${tid} guest-redirect 游客 302 跳登录，不绕过`);
      return;
    }
    const parsed: JyeooDetailParse = await detailPage.call('parseJyeooDetail');

    if (parsed.gated) {
      // 题干归属已由报告页匹配证实；questionId 保持提取层内容哈希（token 不作主键）
      q.meta.gated = true;
      if (needAnswer) q.meta.answerVia = 'vip-gated';
      return;
    }

    // 防串题：详情页题干须与篮内题干一致
    if (!isStemMatch(basketStemText, parsed.stemText || '')) {
      if (needAnswer) q.meta.answerVia = 'mismatch';
      warnings.push(
        `jyeoo:${tid} mismatch 详情页题干与篮内题干不一致，拒绝采答案 | 篮内:${basketStemText.slice(0, 100)} | 详情:${(parsed.stemText || '').slice(0, 100)}`
      );
      return;
    }

    if (needAnswer && parsed.answerHtml) {
      q.answerHtml = parsed.answerHtml;
      q.meta.answerVia = via === 'session-fetch' ? 'session-fetch' : 'report-page-tid';
    }
    if (needAnalysis && parsed.analysisHtml) {
      q.analysisHtml = parsed.analysisHtml;
    }
    if (parsed.knowledgePoints.length > 0) {
      q.meta.knowledgePoints = parsed.knowledgePoints;
    }
    // Phase 3（D1-fix-4）：隐藏窗路径取到的答案/解析如实标记抽字风险——实站定级根因为 UA 分级
    // 投放，采集窗标准 Chrome UA + 登录态数据完整可信（ua-login-probe 用户肉眼复验无缺字/不错位），
    // 隐藏窗非真实浏览器形态仍可能被抽字，不静默当完整解析入库；防串题 mismatch 已拒绝错位数据（不入库）。
    if (via === 'hidden-window' && ((needAnswer && parsed.answerHtml) || (needAnalysis && parsed.analysisHtml))) {
      warnings.push(
        `jyeoo:${tid} analysis-unverified 隐藏窗路径两跳答案/解析可能被服务端分级投放（解析区抽字风险），已入库，请以实站复核`
      );
    }
  } catch (error: any) {
    if (needAnswer) q.meta.answerVia = 'error';
    warnings.push(`jyeoo:${tid} error ${error?.message || String(error)}`);
  } finally {
    if (detailPage) await detailPage.close();
  }
}

/**
 * 批量补抓答案/解析（就地填充 CapturedQuestion；失败降级为 warning，不中断批量）
 * 合规红线：不自动登录、不绕过会员墙/反爬，gated/redirect 如实标记
 */
export async function enrichAnswers(
  captured: CapturedQuestion[],
  deps: AnswerFetchDeps,
  options: EnrichOptions = {}
): Promise<string[]> {
  const warnings: string[] = [];
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  for (const q of captured) {
    if (q.site === 'zujuan') {
      if (q.answerHtml) continue; // 已有答案不重复补抓
      await enrichZujuan(q, deps, timeoutMs, warnings);
    } else if (q.site === 'jyeoo') {
      if (q.answerHtml && q.analysisHtml) continue; // 答案与解析都齐才跳过
      await enrichJyeoo(q, deps, warnings);
    }
    // generic：无答案链路，保持空
  }

  return warnings;
}
