/**
 * 采集入库学科（D1-fix-3 L-1；0006-fix-3 P3 字典化）
 *
 * 产品决策（用户 2026-09-06 拍板）：CapturePage 入库前学科下拉，默认「高中数学」，
 * 提交学段+学科组合串（host 侧拆分 subject/stage）。入库粒度与既有题库数据一致：
 * subject 存单学科中文（既有 mock 样本取值为「物理」），学段拆出但 0002-B2 后不再落库。
 *
 * 0006-fix-3 P3：学科选项改由 dict 归一行驱动（CapturePage 查询），站点原文解析不再硬编码
 * 映射表（SITE_SUBJECT_MAP/mapSiteSubject 退役）——一律复用 src/bank/subject-normalize.ts
 * 的 resolveSubjectKey 单一真源（subj: 前缀短路 → 站点行优先 → 归一 code → 归一 label）。
 */

import type { DictEntry } from '../shared/contracts/bank-types.js';
import { resolveSubjectKey, SUBJ_PREFIX } from '../bank/subject-normalize.js';
import { subjectSourceLabels } from './dict-collect.js';
import { detectSite } from './browser/state.js';
import { parseZujuanPaperUrl } from './papers/paper-url.js';
import type { CapturePageSignals } from './browser/page-context.js';

// 0012 P4（只增）：渲染层预填归一需要同一前缀常量（单一真源仍是 subject-normalize）
export { SUBJ_PREFIX };

/**
 * 空库兜底选项（仅 dict 无归一行时使用：新装库/开发流/无桥环境），
 * 正常环境由 dict.list({kind:'subject'}) 归一行驱动，此常量不参与字典漂移。
 */
export const EMPTY_DICT_FALLBACK_OPTIONS = [
  '高中数学',
  '高中物理',
  '高中化学',
  '初中数学',
  '初中物理',
  '初中化学',
] as const;

export const DEFAULT_CAPTURE_SUBJECT: string = EMPTY_DICT_FALLBACK_OPTIONS[0];

/** 学段+学科组合串拆分；无学段前缀时 stage 缺省 */
export function splitStageSubject(value: string): { subject: string; stage?: string } {
  const m = /^(小学|初中|高中)(.+)$/.exec(value.trim());
  if (!m) return { subject: value.trim() };
  return { stage: m[1], subject: m[2] };
}

/**
 * 学科原文（用户选择中文 label / 站点原文 segment）→ 题库归一 id `subj:{code}`；未见命中返回 null。
 *
 * - site 已知（站点原文路径）时站点行优先，破菁优 politics=初中道法 与归一 politics=高中政治 的歧义；
 * - 命中的 code 必须在归一行里存在——否则 subject_id 外键必挂（§零.7 FK 防线），视为未命中；
 * - 未命中不新建字典行、不猜不并（§零.9），由调用方落原文 + warning。
 */
export function subjectIdOf(
  raw: string | undefined,
  site: string | undefined,
  entries: DictEntry[],
): string | null {
  const code = resolveSubjectKey(raw, site, entries);
  if (!code) return null;
  const normalized = entries.find((e) => !e.site && e.code === code);
  if (!normalized) return null;
  return `${SUBJ_PREFIX}${code}`;
}

// ==================== 0012 P4（只增）：自动识别年级学科 ====================

/** 预填合法学段（采集页下拉三值；中职等不入下拉 → 不预填） */
const CAPTURE_PREFILL_STAGES = ['小学', '初中', '高中'] as const;

/** 预填学段闸（两条解析路径共用口径） */
function prefillStageOk(stage: string): boolean {
  return (CAPTURE_PREFILL_STAGES as readonly string[]).includes(stage);
}

// ==================== 0067（R-070）：菁优页面文本「学段+学科」解析 ====================

/**
 * 学段词表 = 学段基准值（0012 采集下拉 ∪ 0055 设置页 BASE_STAGE_OPTIONS 四值；「中职」真库有树故入表，
 * 命中后由 CAPTURE_PREFILL_STAGES 挡回不预填——与组卷「中职 tab」口径一致）。
 */
const STAGE_WORDS = ['小学', '初中', '高中', '中职'] as const;

/** 学科词表 = dict-collect 归一字典原文词表（单一真源）；最长优先——破「信息/信息技术」「通用/通用技术」前缀歧义 */
const SUBJECT_WORDS: readonly string[] = subjectSourceLabels().slice().sort((a, b) => b.length - a.length);

/**
 * 页面文本 → {学段, 学科原文}；不成对 / 多解 / 词表外 → null（不猜，调用方维持现状兜底）。
 *
 * 只认**紧邻连写**（如「高中物理」）：「学段」「学科」分隔出现不成立（防首页「小学初中高中试卷…」
 * 与关键词串「数学试卷,英语试卷…」这类全站文案误命中，真 fixture 已核 0 命中）；
 * 同一页出现两个不同组合=歧义（如「高中物理」+「初中数学」）→ null。
 * 禁硬编码 segment→学段映射表（§零.4）：本函数不接触 URL/segment，只读页面原文。
 */
function parseStageSubjectFromText(text: string): { stage: string; subject: string } | null {
  const hits = new Map<string, { stage: string; subject: string }>();
  for (const stage of STAGE_WORDS) {
    let from = text.indexOf(stage);
    while (from >= 0) {
      const tail = from + stage.length;
      for (const subject of SUBJECT_WORDS) {
        if (text.startsWith(subject, tail)) {
          hits.set(`${stage}${subject}`, { stage, subject });
          break;
        }
      }
      from = text.indexOf(stage, from + 1);
    }
  }
  return hits.size === 1 ? [...hits.values()][0] : null;
}

export interface ResolvedStageSubject {
  stage: string;
  subject: string;
  /** 识别来源（事件 payload.subjectVia 透传，调试记档用） */
  via: 'nav-active' | 'bankid' | 'paper-url' | 'segment';
}

/**
 * 页面语境（URL + 页内信号）→ {学段, 学科原文}；信号不可得/歧义 → null（不预填，不猜）。
 *
 * 解析序（组卷）：① 整卷 URL {bankId}p{paperId}.html → bankId 导航映射；
 * ② 现役学科标记（.subject-nav-item.selected）；③ 唯一题块 bankid → 导航映射。
 * 解析序（菁优）：① URL segment → #subjectNav 映射（禁硬编码 segment 映射表）；
 * ② 0067（R-070）页面文本「学段+学科」——试题篮/搜索页无 #subjectNav 时唯一可得信号。
 * subject 为站点原文 label；归一由渲染层 subjectIdOf（站点行优先破 politics 歧义）。
 */
export function resolveCaptureStageSubject(
  url: string,
  signals: CapturePageSignals | null | undefined,
): ResolvedStageSubject | null {
  if (!signals) return null;
  const site = detectSite(url);

  if (site === 'zujuan') {
    const z = signals.zujuan;
    if (!z) return null;
    const byBankId = new Map(z.navItems.map((i) => [i.bankId, i]));
    const stageOk = prefillStageOk;

    // ① 整卷 URL 形态：bankId 天然可得
    const paperRef = parseZujuanPaperUrl(url);
    if (paperRef) {
      const item = byBankId.get(paperRef.bankId);
      return item && stageOk(item.stage) ? { stage: item.stage, subject: item.label, via: 'paper-url' } : null;
    }
    // ② 现役学科标记（章节页/首页/列表页）
    if (z.activeSubjectBankId) {
      const item = byBankId.get(z.activeSubjectBankId);
      if (!item) return null;
      const stage = z.activeStageText && stageOk(z.activeStageText)
        ? z.activeStageText
        : (stageOk(item.stage) ? item.stage : null);
      return stage ? { stage, subject: item.label, via: 'nav-active' } : null;
    }
    // ③ 唯一题块 bankid（多 bankid 并存=歧义不预填）
    if (z.bankids.length === 1) {
      const item = byBankId.get(z.bankids[0]);
      return item && stageOk(item.stage) ? { stage: item.stage, subject: item.label, via: 'bankid' } : null;
    }
    return null;
  }

  if (site === 'jyeoo') {
    const j = signals.jyeoo;
    if (!j) return null;
    // ① 导航映射在场即以站点导航为准（学段越界=null 的既有口径不变，不被页面文本二次猜测）
    if (j.segment) {
      const item = j.navItems.find((i) => i.segment === j.segment);
      if (item) {
        return prefillStageOk(item.stage)
          ? { stage: item.stage, subject: item.fullLabel || item.label, via: 'segment' }
          : null;
      }
    }
    // ② 0067（R-070）：页面文本「学段+学科」——试题篮/搜索页 navItems 恒空，此路是唯一信号源。
    // via 沿用 'segment'：CaptureEventPayload['subjectVia'] 的取值域定在 ipc-channels 契约（本单零改动），
    // 该字段仅调试记档用；识别来源=菁优站点原文信号（非 URL segment）一事见交付报告 §R-070 登记。
    const fromText = parseStageSubjectFromText(j.pageText ?? '');
    if (!fromText || !prefillStageOk(fromText.stage)) return null;
    return { stage: fromText.stage, subject: fromText.subject, via: 'segment' };
  }

  return null;
}
