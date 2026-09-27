/**
 * 采集注入 bundle 入口（页内执行）
 *
 * 经 scripts/build-capture-inject.mjs（esbuild）打包为 dist/capture/inject.js 单文件 IIFE，
 * 由 CaptureHost.executeJavaScript 注入采集窗口/隐藏详情页窗口。
 * 页内逻辑与主进程/测试共用 src/capture 纯函数同一实现，禁止手工复制漂移。
 */

import { extractZujuanBasket, extractJyeooBasket } from '../adapters/zujuan.js';
import { detectSite, detectLoggedIn } from './state.js';
import { pollZujuanAnswer, findReportFieldsetTid, parseJyeooDetail } from '../adapters/detail-pages.js';
import { extractPaperIndex, parsePaperBatch, type PaperBatchContext } from '../adapters/paper-pages.js';
import { isStemMatch } from '../adapters/stem-match.js';
import { collectCapturePageSignals } from './page-context.js';
import type { CaptureExtraction, CapturedQuestion } from '../../shared/contracts/capture-types.js';

/**
 * 试题篮提取：按当前 URL 识别站点 → 对应适配器
 * 合规红线：只读 DOM 提取，不自动登录/找题/加篮/绕过反爬
 */
function extractBasket(): CaptureExtraction {
  // 页内全局（注入 bundle 在浏览器上下文执行；tsc main 无 DOM lib，经 globalThis 访问）
  const g = globalThis as any;
  const loc = g.location;
  const doc = g.document;
  const url: string = loc.href;
  const site = detectSite(url);
  const warnings: string[] = [];

  let captured: CapturedQuestion[] = [];
  let mode = 'none';

  if (site === 'zujuan') {
    mode = 'zujuan-basket';
    captured = extractZujuanBasket(doc, url);
  } else if (site === 'jyeoo') {
    mode = 'jyeoo-basket';
    captured = extractJyeooBasket(doc, url);
  } else {
    warnings.push(`unknown-site 未识别站点: ${url}`);
  }

  if (site && captured.length === 0) {
    warnings.push('no-questions-found 篮面板未命中（可能未展开或篮内无题）');
  }

  if (site && !detectLoggedIn(url, doc.documentElement?.innerHTML || '')) {
    warnings.push('not-logged-in 未检测到站点登录态');
  }

  return { url, mode, captured, warnings };
}

/**
 * 0006 P4：整卷下载页内函数
 *
 * - extractPaperIndex：PC 详情页 SSR 题号（class 选择器 .tk-quest-item[questionid]）+ <title> 卷名。
 * - parsePaperBatchText：批量 API 响应文本 → CapturedQuestion[]（页内 DOMParser，与主进程/测试同实现）。
 * - fetchPaperQuestions：mzujuan 页内同源 fetch POST（/server_api/ques/ids/{bankId}?ids=…）——
 *   桌面 UA 下该路由 404，必须由隐藏窗 webContents 级移动 UA 覆盖（0006 侦察 §3 实锤）；
 *   10 题/批与批间节流由 papers/collect.ts 编排，本函数只发一次请求、不做重试/绕过。
 */
function pageDocFor(html: string): any {
  const g = globalThis as any;
  return new g.DOMParser().parseFromString(html, 'text/html');
}

(globalThis as any).__mofangCapturePage = {
  extractBasket,
  // 0012 P4：页面语境信号采集（P4 预填素材；只读 DOM，signal 不可得=双侧 null）
  pageContext: () => collectCapturePageSignals((globalThis as any).document, (globalThis as any).location.href),
  // 包装：页内函数隐式绑定 document（主进程 call 只传业务参数，与 answer-fetch 的 HiddenPage 协议一致）
  pollZujuanAnswer: (timeoutMs: number, intervalMs: number) =>
    pollZujuanAnswer((globalThis as any).document, { timeoutMs, intervalMs }),
  findReportFieldsetTid: (basketStemText: string) =>
    findReportFieldsetTid((globalThis as any).document, basketStemText),
  parseJyeooDetail: () => parseJyeooDetail((globalThis as any).document),
  // 0006 P4：PC 整卷详情页 SSR 题号 + 卷名
  extractPaperIndex: () => extractPaperIndex((globalThis as any).document),
  // 0006 P4：批量 API 响应文本解析（页内 DOMParser）
  parsePaperBatchText: (jsonText: string, ctx: PaperBatchContext) => parsePaperBatch(jsonText, ctx, pageDocFor),
  // 0006 P4：批量 API 页内同源 fetch（移动 UA 隐藏窗内执行）
  fetchPaperQuestions: async (bankId: string, ids: string, ctx: PaperBatchContext) => {
    const g = globalThis as any;
    try {
      const resp = await g.fetch(`/server_api/ques/ids/${encodeURIComponent(bankId)}?ids=${encodeURIComponent(ids)}`, {
        method: 'POST',
        credentials: 'include',
      });
      const text = await resp.text();
      return { status: resp.status, ...parsePaperBatch(text, ctx, pageDocFor) };
    } catch (error: any) {
      return {
        status: 0,
        code: '',
        questions: [],
        warnings: [`题批接口请求失败：${String(error?.message || error)}`],
        total: 0,
        childCount: 0,
        challenge: false,
      };
    }
  },
  /**
   * D1-fix-4 方案①：两跳在采集窗登录态会话内执行——页内同源 fetch（自动携带完整会话 cookie，
   * 含仅内存的会话级 cookie；真实浏览器 UA/Referer），原始 HTML 暂存页内全局供 parseSessionPage 解析。
   * 报告页/详情页均为服务端渲染（POC 实证），DOMParser 解析原始 HTML 即可，无需执行页内脚本。
   */
  sessionFetchPage: async (url: string, referrer?: string) => {
    const g = globalThis as any;
    const resp = await g.fetch(url, {
      credentials: 'include',
      redirect: 'follow',
      // D1-fix-4 对照实验：真人路径「报告页点题→详情页」带 Referer，Fetch API 以 referrer 选项传递
      ...(referrer ? { referrer } : {}),
    });
    const html = await resp.text();
    g.__mofangSessionPageSnapshot = { url, finalUrl: resp.url, status: resp.status, html };
    return { finalUrl: resp.url, status: resp.status, length: html.length };
  },
  /** 解析最近一次 sessionFetchPage 暂存的 HTML（fnName 白名单派发，与 HiddenPage.call 协议对齐） */
  parseSessionPage: (fnName: string, ...args: any[]) => {
    const g = globalThis as any;
    const snap = g.__mofangSessionPageSnapshot;
    if (!snap) throw new Error('no session page snapshot（先 sessionFetchPage）');
    const doc = new g.DOMParser().parseFromString(snap.html, 'text/html');
    if (fnName === 'findReportFieldsetTid') return findReportFieldsetTid(doc, args[0]);
    if (fnName === 'parseJyeooDetail') return parseJyeooDetail(doc);
    // 探针判定用：暴露真实防串题匹配器（isStemMatch(篮内题干, 详情题干)）
    if (fnName === 'isStemMatch') return isStemMatch(String(args[0] ?? ''), String(args[1] ?? ''));
    throw new Error(`parseSessionPage unknown fn: ${fnName}`);
  },
};
