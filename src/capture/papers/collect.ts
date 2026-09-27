/**
 * 0006 P4：整卷抓取编排（主进程；网络与 DOM 全部经注入 deps，纯逻辑可单测）
 *
 * 通路（侦察 §3 实锤，勿另起炉灶）：
 *  ① PC 详情页隐藏窗（同 session `persist:mofang-capture`，标准 Chrome UA）→ SSR 全量题号 + 卷名，免登录；
 *  ② 同 session 另一隐藏窗 + **webContents 级移动 UA 覆盖（iPhone）** + 页内同源 fetch POST →
 *     mzujuan 批量 API（桌面 UA 下 404；session 级 UA 不动，不威胁菁优 UA 绑定）；
 *  ③ 10 题/批、批间节流 ≥1s、移动窗**只开一次复用**；遇滑块/挑战如实标记交用户人工处理，不自动绕。
 */

import type { CapturedQuestion } from '../../shared/contracts/capture-types.js';
import type { HiddenPage } from '../browser/answer-fetch.js';
import { parseZujuanPaperUrl, ZUJUAN_PAPER_URL_HINT, type ZujuanPaperRef } from './paper-url.js';
import { PAPER_CHALLENGE_MARK } from './challenge-hint.js';

export const PAPER_BATCH_SIZE = 10;
export const PAPER_BATCH_THROTTLE_MS = 1000;
export const MOBILE_SITE_URL = 'https://mzujuan.xkw.com/';
/** 移动站 UA（0006-recon3 实证：桌面 UA 下 API 路由 404，移动 UA 可达；仅隐藏窗 webContents 级覆盖） */
export const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

export interface PaperCollectDeps {
  /** 打开同 session 隐藏页；options.userAgent = webContents 级 UA 覆盖（不改 session 级 UA） */
  openPage(url: string, options?: { userAgent?: string }): Promise<HiddenPage>;
  /** 批间节流（测试注入；缺省真实等待） */
  sleep?(ms: number): Promise<void>;
}

export interface PaperCollectOptions {
  batchSize?: number;
  throttleMs?: number;
}

export interface PaperCollectResult {
  ref: ZujuanPaperRef;
  title: string;
  /** PC SSR 题号总数（== 实卷题数） */
  total: number;
  /** PC SSR 题号（含站点未返回者；卷面顺序权威） */
  entries: Array<{ questionId: string; bankid?: string }>;
  /** 批量接口映射成功题（按 SSR 题号顺序） */
  questions: CapturedQuestion[];
  /** 站点未返回的题号（覆盖率缺口，如实列出） */
  missing: string[];
  /** 卷级学科原文（PC SSR 侧栏，如「初中物理」；缺失为空） */
  subject?: string;
  warnings: string[];
  /** 实际发起的批次数（挑战中断/批失败也计入） */
  batches: number;
}

function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * 抓全卷：PC SSR 题号 → 移动批量 API 全字段 → 按 SSR 顺序归并。
 * 失败语义：URL 非法/PC 无题号/PC 遇挑战抛错（用户可读提示）；批级失败降级 warning 不中断其余批次。
 */
export async function collectPaperQuestions(
  url: string,
  deps: PaperCollectDeps,
  options: PaperCollectOptions = {},
): Promise<PaperCollectResult> {
  const ref = parseZujuanPaperUrl(url);
  if (!ref) throw new Error(ZUJUAN_PAPER_URL_HINT);

  const batchSize = options.batchSize ?? PAPER_BATCH_SIZE;
  const throttleMs = options.throttleMs ?? PAPER_BATCH_THROTTLE_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const warnings: string[] = [];

  // ① PC 详情页：SSR 题号 + 卷名
  const pcPage = await deps.openPage(ref.url);
  let index: {
    title?: string;
    questions?: Array<{ questionId: string; bankid?: string }>;
    challenge?: boolean;
    subject?: string;
  };
  try {
    index = await pcPage.call('extractPaperIndex');
  } finally {
    await pcPage.close();
  }
  if (index?.challenge) {
    throw new Error(`组卷整卷页返回${PAPER_CHALLENGE_MARK}（滑块/验证码）：请在采集窗口打开该整卷页人工通过后再试（本工具不自动绕过）`);
  }
  const entries = Array.isArray(index?.questions) ? index.questions : [];
  if (entries.length === 0) {
    throw new Error('未取到整卷题号（PC 详情页结构变化或页面未加载完成，请稍后重试）');
  }
  const title = String(index.title ?? '').trim() || `${ref.bankId}p${ref.paperId}`;
  const subject = String(index.subject ?? '').trim() || undefined;

  // ② 移动批量 API：同 session 隐藏窗（移动 UA 覆盖）+ 页内同源 fetch，10 题/批
  const batches = chunk(entries.map((e) => e.questionId), batchSize);
  const byId = new Map<string, CapturedQuestion>();
  let batchCount = 0;

  if (batches.length > 0) {
    const mobilePage = await deps.openPage(MOBILE_SITE_URL, { userAgent: MOBILE_UA });
    try {
      for (let i = 0; i < batches.length; i++) {
        if (i > 0) await sleep(throttleMs);
        batchCount++;
        const response = await mobilePage.call('fetchPaperQuestions', ref.bankId, batches[i].join(','), {
          bankid: ref.bankId,
          paperUrl: ref.url,
          paperTitle: title,
          ...(subject ? { subject } : {}),
        });

        if (response?.challenge) {
          warnings.push(
            `题批接口遇${PAPER_CHALLENGE_MARK}（第 ${i + 1}/${batches.length} 批）：请在采集窗口访问 mzujuan.xkw.com 人工通过后再重试（不自动绕过）`,
          );
          break;
        }
        const status = Number(response?.status ?? 0);
        if (status !== 200) {
          warnings.push(`题批接口第 ${i + 1}/${batches.length} 批 http-${status || '(无)'}，本批 ${batches[i].length} 题未取到`);
          continue;
        }
        if (String(response?.code ?? '') !== '0') {
          warnings.push(`题批接口第 ${i + 1}/${batches.length} 批 code=${String(response?.code ?? '') || '(空)'}，本批未产出题目`);
          continue;
        }
        for (const q of (response?.questions ?? []) as CapturedQuestion[]) {
          if (!q?.questionId || byId.has(q.questionId)) continue;
          byId.set(q.questionId, q);
        }
        warnings.push(...((response?.warnings ?? []) as string[]));
      }
    } finally {
      await mobilePage.close();
    }
  }

  // ③ 按 SSR 顺序归并：PC 页题号是卷面顺序权威，接口多返回的题号忽略
  const questions: CapturedQuestion[] = [];
  const missing: string[] = [];
  for (const entry of entries) {
    const q = byId.get(entry.questionId);
    if (q) questions.push(q);
    else missing.push(entry.questionId);
  }
  if (missing.length > 0) {
    warnings.push(`题批接口未返回 ${missing.length} 题（站点覆盖率缺口）：${missing.join(',')}`);
  }

  return {
    ref,
    title,
    total: entries.length,
    entries,
    questions,
    missing,
    ...(subject ? { subject } : {}),
    warnings,
    batches: batchCount,
  };
}
