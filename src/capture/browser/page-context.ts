/**
 * 0012 P4：采集页语境信号采集（只读 DOM，页内/测试双环境）
 *
 * 信号勘察台账（真实快照锚定，禁臆造）：0012 P0 探针报告
 * - 组卷：现役学科 = .subject-nav a.subject-nav-item.selected[data-subject-id]（值=bankid）；
 *   现役学段 = .subject-nav .tabs a.tab.selected 文本；题块 bankid 属性（D1-fix-5/6 同源）；
 *   学科映射复用 dict-collect.parseZujuanSubjects（单一来源，禁手工复制）。
 * - 菁优：URL path segment + #subjectNav 学科映射（parseJyeooSubjects 单一来源）。
 * 信号不可得的页面形态 → 双侧 null（调用方不预填保持现状）。
 *
 * doc 参数用 any：浏览器 DOMParser 与 jsdom Document 双环境（detail-pages.ts 同款约定）
 */

import { parseZujuanSubjects, parseJyeooSubjects } from '../dict-collect.js';

/** 组卷侧信号（.subject-nav 不在场 = null） */
export interface CaptureZujuanSignals {
  /** 现役学科标记 data-subject-id（=bankid）；无标记 null */
  activeSubjectBankId: string | null;
  /** 现役学段 tab 文本（高中/初中/小学…）；无标记 null */
  activeStageText: string | null;
  /** 学科导航全量映射（bankId→学科 label+学段；parseZujuanSubjects 单一来源） */
  navItems: Array<{ bankId: string; label: string; stage: string }>;
  /** 题块 bankid 属性去重采样（上限 8，防超长页）；>1 个唯一值=歧义不预填 */
  bankids: string[];
}

/** 菁优侧信号（#subjectNav 不在场 = navItems 空） */
export interface CaptureJyeooSignals {
  /** URL 首段 path segment（如 physics2/math0）；解析失败 null */
  segment: string | null;
  /** 学科导航映射（segment→学科全名+学段；parseJyeooSubjects 单一来源） */
  navItems: Array<{ segment: string; label: string; fullLabel: string; stage: string }>;
  /**
   * 0067（R-070 只增）：页面自带文本采样（`<title>` + `meta[itemprop="name"]` + `meta[name="keywords"]`，
   * 以 '\n' 分隔防跨条拼接误命中）。采集实际发生的**试题篮/搜索页不含 #subjectNav**（真 fixture 0 命中）
   * ⇒ navItems 恒空，学段学科只能从页面文本解析（如「高中物理试卷真题…」）。
   */
  pageText?: string;
}

/** 0067：页面文本单条截断上限（title/短 meta 量级，防超长页把信号体撑大） */
const PAGE_TEXT_MAX = 200;

/** 0067：菁优页面文本采样（只读 DOM；无 title/meta 返回空串=不构成信号） */
export function collectJyeooPageText(doc: any): string {
  const texts: string[] = [];
  const title = (doc.title || '').trim();
  if (title) texts.push(title);
  doc.querySelectorAll('meta[itemprop="name"], meta[name="keywords"]').forEach?.((m: any) => {
    const content = (m.getAttribute('content') || '').trim();
    if (content) texts.push(content);
  });
  return texts.map((t) => t.slice(0, PAGE_TEXT_MAX)).join('\n');
}

export interface CapturePageSignals {
  url: string;
  zujuan: CaptureZujuanSignals | null;
  jyeoo: CaptureJyeooSignals | null;
}

/** 页内信号采集入口（inject-entry.pageContext 包装；jsdom 测试直调） */
export function collectCapturePageSignals(doc: any, url: string): CapturePageSignals {
  const g = globalThis as { URL?: typeof URL };
  const signals: CapturePageSignals = { url, zujuan: null, jyeoo: null };

  try {
    const nav = doc.querySelector('.subject-nav');
    const bankidNodes = doc.querySelectorAll('[bankid]');
    // 组卷信号：导航或题块 bankid 至少其一在场（题块 bankid 可独立于导航存在）
    if (nav || bankidNodes.length > 0) {
      const active = nav ? nav.querySelector('a.subject-nav-item.selected[data-subject-id]') : null;
      const activeStageTab = nav ? nav.querySelector('.tabs a.tab.selected') : null;
      const uniqueBankids: string[] = [];
      const seen = new Set<string>();
      for (let i = 0; i < bankidNodes.length && uniqueBankids.length < 8; i++) {
        const v = bankidNodes[i].getAttribute('bankid');
        if (v && !seen.has(v)) {
          seen.add(v);
          uniqueBankids.push(v);
        }
      }
      signals.zujuan = {
        activeSubjectBankId: active ? active.getAttribute('data-subject-id') : null,
        activeStageText: activeStageTab ? (activeStageTab.textContent || '').trim() || null : null,
        navItems: parseZujuanSubjects(doc),
        bankids: uniqueBankids,
      };
    }
  } catch { /* 信号采集失败=不预填，不打扰采集主流程 */ }

  try {
    let segment: string | null = null;
    const URLCtor = g.URL;
    if (URLCtor) {
      const m = /^\/([a-z0-9]+)\//.exec(new URLCtor(url).pathname);
      segment = m ? m[1] : null;
    }
    const navItems = parseJyeooSubjects(doc);
    // 0067（R-070）：页面文本信号——篮/搜索页无 #subjectNav，站点原文落在 title/meta
    const pageText = collectJyeooPageText(doc);
    // 菁优信号：segment / 导航映射 / 页面文本至少其一在场，否则视为无信号
    if (segment !== null || navItems.length > 0 || pageText) {
      signals.jyeoo = { segment, navItems, pageText };
    }
  } catch { /* 同上 */ }

  return signals;
}
