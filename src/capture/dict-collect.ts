/**
 * 0006 P1：字典采集解析与归一计划（纯函数，浏览器/jsdom 双环境可执行）
 *
 * 结构依据：0006 实站侦察纪要（2026-09-10 P0 实站取证）
 * - 组卷网学科导航：.subject-nav 内 tabs（学段）× tab-box（data-subject-id=bankId）
 * - 组卷网筛选区：a[data-type=selectQuesType]（qyid）/ a[data-type=selectQuesDiff]（data-id）
 * - 菁优学科导航：#subjectNav > li（.sub-tlt b=学段）> .sub-list li（span=学科、a[href]=segment、a[title]=全名）
 * - 菁优筛选区：a[onclick*=setParam]（'ct' 题型 / 'dg' 难度）
 * 归一规则（G2/U12）：归一行=人工拍板标准集（拍板建议随交付报告审）；站点行记 site+source_label+code；
 * 未知值存原样 active=0 待设置页指认。
 */

import type { DictService } from '../shared/contracts/bank-types.js';

/** dict_entries.kind（bank-types DictKind 同款，本地重声明避免 jsdom 环境值导入） */
export type DictKind = 'subject' | 'question_type' | 'difficulty';

export interface ZujuanSubjectItem {
  /** data-subject-id（=bankId，站点权威 id） */
  bankId: string;
  /** 导航项原文（如 物理） */
  label: string;
  /** 学段分组名（小学/初中/高中/中职） */
  stage: string;
}

export interface JyeooSubjectItem {
  /** URL 学科段（如 physics2 / tech6 / math0——站点原文，非学科名时如实保留） */
  segment: string;
  /** 导航短名（如 道法/信息） */
  label: string;
  /** title 属性全名（如 道德与法治；缺省=短名） */
  fullLabel: string;
  stage: string;
}

export interface EnumItem {
  /** 站点原文标签 */
  sourceLabel: string;
  /** 站点值（组卷 qyid/data-id；菁优 ct/dg 值） */
  value: string;
}

/** doc 参数用 any：浏览器 DOMParser 与 jsdom Document 双环境（detail-pages.ts 同款约定） */

/** 组卷网学科导航 → 学段×学科清单 */
export function parseZujuanSubjects(doc: any): ZujuanSubjectItem[] {
  const out: ZujuanSubjectItem[] = [];
  const tabs = doc.querySelectorAll('.subject-nav .tabs a[data-action="selectPhase"]');
  const stageByTab = new Map<string, string>();
  tabs.forEach?.((t: any) => {
    const tab = t.getAttribute('data-tab');
    if (tab) stageByTab.set(tab, (t.textContent || '').trim());
  });
  doc.querySelectorAll('.subject-nav .tab-box[data-tab]').forEach?.((box: any) => {
    const stage = stageByTab.get(box.getAttribute('data-tab')) || '';
    box.querySelectorAll('a[data-subject-id]').forEach?.((a: any) => {
      const bankId = a.getAttribute('data-subject-id') || '';
      const label = (a.textContent || '').trim();
      if (bankId && label) out.push({ bankId, label, stage });
    });
  });
  return out;
}

/** 组卷网筛选区题型（selectQuesType；「全部」data-id=0 排除） */
export function parseZujuanQuesTypes(doc: any): EnumItem[] {
  return parseZujuanTypeItems(doc, 'selectQuesType');
}

/** 组卷网筛选区难度（selectQuesDiff；「全部」排除） */
export function parseZujuanDifficulties(doc: any): EnumItem[] {
  return parseZujuanTypeItems(doc, 'selectQuesDiff');
}

function parseZujuanTypeItems(doc: any, dataType: string): EnumItem[] {
  const out: EnumItem[] = [];
  const seen = new Set<string>();
  doc.querySelectorAll(`a[data-type="${dataType}"]`).forEach?.((a: any) => {
    const value = a.getAttribute('data-id') || '';
    const sourceLabel = (a.textContent || '').trim();
    if (!value || value === '0' || !sourceLabel || seen.has(value)) return;
    seen.add(value);
    out.push({ sourceLabel, value });
  });
  return out;
}

/** 菁优学科导航（#subjectNav）→ segment×学科清单 */
export function parseJyeooSubjects(doc: any): JyeooSubjectItem[] {
  const out: JyeooSubjectItem[] = [];
  const seen = new Set<string>();
  doc.querySelectorAll('#subjectNav > li').forEach?.((li: any) => {
    const stage = (li.querySelector('.sub-tlt b')?.textContent || '').trim();
    li.querySelectorAll('.sub-list li').forEach?.((item: any) => {
      const a = item.querySelector('a[href]');
      if (!a) return;
      const href = a.getAttribute('href') || '';
      const m = /^\/([a-z0-9]+)\//.exec(href);
      const segment = m ? m[1] : '';
      const label = (item.querySelector('span')?.textContent || '').trim();
      const title = a.getAttribute('title') || '';
      // title 形如「初中物理试题」/「道德与法治试题」——剥学段前缀与「试题」后缀取全名
      const fullLabel = title.replace(new RegExp(`^${stage}`), '').replace(/试题$/, '').trim() || label;
      if (!segment || !label || seen.has(segment)) return;
      seen.add(segment);
      out.push({ segment, label, fullLabel, stage });
    });
  });
  return out;
}

/** 菁优筛选区题型（setParam 'ct'；'0'=全部 排除） */
export function parseJyeooQuesTypes(doc: any): EnumItem[] {
  return parseJyeooSetParamItems(doc, 'ct');
}

/** 菁优筛选区难度（setParam 'dg'；'0'=全部 排除） */
export function parseJyeooDifficulties(doc: any): EnumItem[] {
  return parseJyeooSetParamItems(doc, 'dg');
}

function parseJyeooSetParamItems(doc: any, param: string): EnumItem[] {
  const out: EnumItem[] = [];
  const seen = new Set<string>();
  const re = new RegExp(`setParam\\(this,'${param}','([\\w.]+)'\\)`);
  doc.querySelectorAll('a[onclick]').forEach?.((a: any) => {
    const m = re.exec(a.getAttribute('onclick') || '');
    if (!m) return;
    const value = m[1];
    const sourceLabel = (a.textContent || '').trim();
    if (!sourceLabel || value === '0' || seen.has(value)) return;
    seen.add(value);
    out.push({ sourceLabel, value });
  });
  return out;
}

// ---------- 归一映射（人工拍板先行集；拍板建议随 0006 交付报告审） ----------

const SUBJECT_MAP: Record<string, string> = {
  '语文': 'chinese',
  '数学': 'math',
  '英语': 'english',
  '物理': 'physics',
  '化学': 'chemistry',
  '生物': 'biology',
  '科学': 'science',
  '地理': 'geography',
  '历史': 'history',
  '政治': 'politics',
  '道德与法治': 'morality-law',
  '历史与社会': 'history-society',
  '信息技术': 'it',
  '信息科技': 'it',
  '信息': 'it',
  '通用技术': 'general-technology',
  '通用': 'general-technology',
  '日语': 'japanese',
  // 用户拍板 2026-09-10（0006 目检）：菁优奥数归入数学（学段由 stage 承载——math0 段即小学）
  '奥数': 'math',
};

const QUES_TYPE_MAP: Record<string, string> = {
  '单选题': 'single-choice',
  '多选题': 'multi-choice',
  '选择题': 'choice',
  '填空题': 'fill-blank',
  '课内填空': 'in-class-fill',
  '判断题': 'true-false',
  '解答题': 'solution',
  '实验题': 'experiment',
  '计算题': 'calculation',
  '作图题': 'drawing',
  '简答题': 'short-answer',
  '综合题': 'comprehensive',
  '科普阅读题': 'science-reading',
};

const DIFFICULTY_MAP: Record<string, string> = {
  '容易': 'easy',
  '简单': 'easy',
  '易': 'easy',
  '较易': 'easy',
  '适中': 'medium',
  '中等': 'medium',
  '中档': 'medium',
  '较难': 'hard',
  '困难': 'expert',
  '很难': 'expert',
  '难': 'expert',
};

/** 学科原文 → 标准码；未知 → undefined（站点行 active=0 待指认） */
export function normalizeSubjectCode(label: string): string | undefined {
  return SUBJECT_MAP[label.trim()];
}

/**
 * 0067（R-070）：学科原文词表（SUBJECT_MAP 键全集，单一真源）——页面文本「学段+学科」模式匹配用，
 * 调用方按需排序（最长优先破「信息/信息技术」前缀歧义）。禁在解析模块另立映射表副本。
 */
export function subjectSourceLabels(): string[] {
  return Object.keys(SUBJECT_MAP);
}

/** 题型原文 → 标准码 */
export function normalizeQuesTypeCode(label: string): string | undefined {
  return QUES_TYPE_MAP[label.trim()];
}

/** 难度原文 → 标准码 */
export function normalizeDifficultyCode(label: string): string | undefined {
  return DIFFICULTY_MAP[label.trim()];
}

// ---------- 计划构建 ----------

export interface DictPlanRow {
  kind: DictKind;
  /** 缺省=归一行；站点行必填 */
  site?: 'zujuan' | 'jyeoo';
  /** 站点原文（站点行必填；菁优学科=URL segment，组卷学科=学段+学科组合名） */
  sourceLabel?: string;
  /** 归一行=标准码；站点行=指向归一 code；未知=undefined */
  code?: string;
  /** 归一行=标准显示名；站点行=站点原文 */
  label: string;
}

/** 归一行显示名（code → 中文标准名；拍板可改，站点行不受影响） */
const NORMALIZED_SUBJECT_LABEL: Record<string, string> = {
  chinese: '语文', math: '数学', english: '英语', physics: '物理', chemistry: '化学',
  biology: '生物', science: '科学', geography: '地理', history: '历史', politics: '政治',
  'morality-law': '道德与法治', 'history-society': '历史与社会', it: '信息技术',
  'general-technology': '通用技术', japanese: '日语',
};
const NORMALIZED_QTYPE_LABEL: Record<string, string> = {
  'single-choice': '单选题', 'multi-choice': '多选题', choice: '选择题', 'fill-blank': '填空题',
  'in-class-fill': '课内填空', 'true-false': '判断题', solution: '解答题', experiment: '实验题',
  calculation: '计算题', drawing: '作图题', 'short-answer': '简答题', comprehensive: '综合题',
  'science-reading': '科普阅读题',
};
const NORMALIZED_DIFFICULTY_LABEL: Record<string, string> = {
  easy: '容易', medium: '中等', hard: '较难', expert: '困难',
};

export interface DictCollectInput {
  zujuanSubjects?: ZujuanSubjectItem[];
  zujuanQuesTypes?: EnumItem[];
  zujuanDifficulties?: EnumItem[];
  jyeooSubjects?: JyeooSubjectItem[];
  jyeooQuesTypes?: EnumItem[];
  jyeooDifficulties?: EnumItem[];
}

/**
 * 两站采集产物 → dict 计划（纯数据，无 IO；落库走 applyDictPlan）
 * 归一行：计划中用到的标准码各一条（去重）。
 * 站点行：组卷学科 sourceLabel=学段+学科（站点以「高中→物理」组合呈现）；菁优学科 sourceLabel=segment。
 */
export function buildDictPlan(input: DictCollectInput): DictPlanRow[] {
  const plan: DictPlanRow[] = [];
  const usedCodes: Record<DictKind, Set<string>> = {
    subject: new Set(), question_type: new Set(), difficulty: new Set(),
  };
  // 站点行计划内去重（组卷首页导航在 DOM 出现两份——页头/悬浮菜单，解析产物 ×2）
  const usedSiteKeys = new Set<string>();

  const pushNormalized = (kind: DictKind, code: string) => {
    if (!usedCodes[kind].has(code)) {
      usedCodes[kind].add(code);
      const label = kind === 'subject'
        ? NORMALIZED_SUBJECT_LABEL[code]
        : kind === 'question_type' ? NORMALIZED_QTYPE_LABEL[code] : NORMALIZED_DIFFICULTY_LABEL[code];
      plan.push({ kind, code, label: label || code });
    }
  };

  const pushSite = (kind: DictKind, site: 'zujuan' | 'jyeoo', sourceLabel: string, code: string | undefined) => {
    const key = `${kind}|${site}|${sourceLabel}`;
    if (usedSiteKeys.has(key)) return;
    usedSiteKeys.add(key);
    plan.push({ kind, site, sourceLabel, code, label: sourceLabel });
    if (code) pushNormalized(kind, code);
  };

  for (const s of input.zujuanSubjects ?? []) {
    const sourceLabel = s.stage ? `${s.stage}${s.label}` : s.label;
    pushSite('subject', 'zujuan', sourceLabel, normalizeSubjectCode(s.label));
  }
  for (const s of input.jyeooSubjects ?? []) {
    pushSite('subject', 'jyeoo', s.segment, normalizeSubjectCode(s.fullLabel || s.label));
  }
  for (const t of input.zujuanQuesTypes ?? []) {
    pushSite('question_type', 'zujuan', t.sourceLabel, normalizeQuesTypeCode(t.sourceLabel));
  }
  for (const t of input.jyeooQuesTypes ?? []) {
    pushSite('question_type', 'jyeoo', t.sourceLabel, normalizeQuesTypeCode(t.sourceLabel));
  }
  for (const d of input.zujuanDifficulties ?? []) {
    pushSite('difficulty', 'zujuan', d.sourceLabel, normalizeDifficultyCode(d.sourceLabel));
  }
  for (const d of input.jyeooDifficulties ?? []) {
    pushSite('difficulty', 'jyeoo', d.sourceLabel, normalizeDifficultyCode(d.sourceLabel));
  }
  return plan;
}

// ---------- 幂等落库 ----------

export interface DictApplyReport {
  normalizedCreated: number;
  normalizedSkipped: number;
  siteCreated: number;
  /** 已存在即跳过——含人工指认过的 code 改动，一律不覆盖 */
  siteSkipped: number;
  /** 未知值行（active=0 待指认）新建数 */
  unknownActive0: number;
}

const KIND_ID_PREFIX: Record<DictKind, string> = {
  subject: 'subj', question_type: 'qtype', difficulty: 'diff',
};

/**
 * 计划落库（幂等）：归一行按 id 查存在跳过；站点行按 UNIQUE(kind,site,source_label) 查存在跳过。
 * 重跑零增量、不覆盖任何既有行（含人工指认过的 code/active 改动）。
 */
export async function applyDictPlan(service: DictService, plan: DictPlanRow[]): Promise<DictApplyReport> {
  const report: DictApplyReport = {
    normalizedCreated: 0, normalizedSkipped: 0, siteCreated: 0, siteSkipped: 0, unknownActive0: 0,
  };

  // 既有行索引：归一行按 code；站点行按 kind|site|sourceLabel
  const all = await service.listEntries();
  const normalizedByKey = new Map<string, (typeof all)[number]>();
  const siteByKey = new Map<string, (typeof all)[number]>();
  for (const e of all) {
    if (e.site === undefined || e.site === null) {
      normalizedByKey.set(`${e.kind}|${e.code}`, e);
    } else {
      siteByKey.set(`${e.kind}|${e.site}|${e.sourceLabel ?? ''}`, e);
    }
  }

  // 先归一行后站点行（站点行 code 引用归一行）
  for (const row of plan.filter((r) => !r.site)) {
    const key = `${row.kind}|${row.code}`;
    if (normalizedByKey.has(key) || (await service.getEntry(`${KIND_ID_PREFIX[row.kind]}:${row.code}`))) {
      report.normalizedSkipped++;
      continue;
    }
    normalizedByKey.set(key, {} as (typeof all)[number]);
    await service.createEntry({ kind: row.kind, code: row.code!, label: row.label } as never);
    report.normalizedCreated++;
  }
  for (const row of plan.filter((r) => r.site)) {
    const key = `${row.kind}|${row.site}|${row.sourceLabel}`;
    if (siteByKey.has(key)) {
      report.siteSkipped++;
      continue;
    }
    // 计划内二次出现（上游未去重防线）：按已存在处理，不触发 UNIQUE 冲突
    siteByKey.set(key, {} as (typeof all)[number]);
    await service.createEntry({
      kind: row.kind,
      code: row.code ?? '',
      label: row.label,
      site: row.site,
      sourceLabel: row.sourceLabel,
      ...(row.code ? {} : { active: false }),
    } as never);
    if (row.code) report.siteCreated++; else report.unknownActive0++;
  }
  return report;
}
