/**
 * 0006-fix-2：树学科归一（trees.subject_id 三格式并存 → 归一 code）
 *
 * 实库三种格式（2026-09-10 实查，证据 0006 验收探针留痕）：
 *   1) `subj:{code}`  规范（组卷教材树走 dict 反查）
 *   2) 站点原文 segment（菁优知识点树：physics2/math7/tech1…）
 *   3) 中文学科名原文（组卷知识点树：物理/道德与法治…）
 *
 * 歧义雷区：菁优 segment `politics` = 初中道法（归一 morality-law），与归一码 `politics`（高中政治）撞名。
 * 故解析顺序必须是「站点行优先」：站点点已知时先查该站站点行 sourceLabel，再回落归一 code/label——
 * 且 `subj:` 前缀值视为已归一，直接剥前缀返回（幂等：已矫正的树二次解析不因站点行而改判）。
 *
 * 纯函数模块：UI 分组（防线，不依赖 DB 已矫正）与 DB 一次性矫正共用同一解析。
 */

import type { DictEntry } from '../shared/contracts/bank-types.js';

export const SUBJ_PREFIX = 'subj:';

/** 站点来源：显式 source 优先，缺失按树名前缀兜底（组卷网· / 菁优网·） */
export function siteOfTree(source: string | undefined, name: string): string | undefined {
  if (source) return source;
  if (name.startsWith('菁优网·')) return 'jyeoo';
  if (name.startsWith('组卷网·')) return 'zujuan';
  return undefined;
}

/**
 * 学科原文 → 归一 code；查不到返回 null（不猜不并）。
 * 解析顺序：subj: 前缀剥除 → 站点行 sourceLabel（站点已知）→ 归一 code → 归一 label。
 */
export function resolveSubjectKey(
  raw: string | undefined,
  site: string | undefined,
  entries: DictEntry[],
): string | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  if (value.startsWith(SUBJ_PREFIX)) {
    const code = value.slice(SUBJ_PREFIX.length);
    return code || null;
  }
  if (site) {
    const siteRow = entries.find((e) => e.site === site && e.sourceLabel === value);
    if (siteRow?.code) return siteRow.code;
  }
  const normalized = entries.filter((e) => !e.site);
  if (normalized.some((e) => e.code === value)) return value;
  return normalized.find((e) => e.label === value)?.code ?? null;
}

/** UI 分组键：命中归一 → code；未命中 → 剥 subj: 的原文独立成组（不静默并错）；空 → 未分科 */
export function groupKeyOfSubject(
  raw: string | undefined,
  site: string | undefined,
  entries: DictEntry[],
): string {
  const code = resolveSubjectKey(raw, site, entries);
  if (code) return code;
  const value = (raw ?? '').trim();
  const stripped = value.startsWith(SUBJ_PREFIX) ? value.slice(SUBJ_PREFIX.length) : value;
  return stripped || '未分科';
}

/** 显示名 = 归一行 label（回落 undefined 由调用方决定兜底文案） */
export function subjectLabelOf(code: string, entries: DictEntry[]): string | undefined {
  return entries.find((e) => !e.site && e.code === code)?.label;
}
