/**
 * 0006-fix-2 P1：trees.subject_id 一次性矫正（三格式 → `subj:{code}`）
 *
 * 纯计划（buildTreeSubjectFixPlan，可单测/可 dry-run 报告）+ 落库（applyTreeSubjectFixPlan，单事务）。
 * 规则（任务书 §P1-2）：已是 `subj:` 或本就 NULL → 跳过；站点原文/中文名 → 按站点解析归一；
 * 查不到 → 置 NULL 且出清单（不猜不并，待人工指认）。
 *
 * 人工指认通道（applySubjectAssignments）：置 NULL / 查不到的树需显式指定 code 才能归位——
 * from===null 恒 skip（补字典行不会自动归位）、重采按树名复用不更新 subject_id，故必须显式改动；
 * code 须为已建归一行，否则抛错（不静默写脏值）。
 */

import type { DictEntry, Tree } from '../shared/contracts/bank-types.js';
import type { Database } from './db.js';
import { resolveSubjectKey, siteOfTree, SUBJ_PREFIX } from './subject-normalize.js';

export interface TreeSubjectFixItem {
  id: string;
  name: string;
  /** 矫正前值（NULL 表示原本无学科） */
  from: string | null;
  /** 矫正后写入值（`subj:{code}`；nulled 项为 null） */
  to: string | null;
  action: 'skip' | 'fix' | 'null';
}

export interface TreeSubjectFixReport {
  fixed: number;
  skipped: number;
  nulled: number;
  /** 置 NULL 清单（查不到归一的树名，交人工指认） */
  nulledNames: string[];
}

export function buildTreeSubjectFixPlan(trees: Tree[], entries: DictEntry[]): TreeSubjectFixItem[] {
  return trees.map((t) => {
    const from = t.subjectId ?? null;
    if (from === null || from.startsWith(SUBJ_PREFIX)) {
      return { id: t.id, name: t.name, from, to: from, action: 'skip' };
    }
    const code = resolveSubjectKey(from, siteOfTree(t.source, t.name), entries);
    if (!code) return { id: t.id, name: t.name, from, to: null, action: 'null' };
    return { id: t.id, name: t.name, from, to: `${SUBJ_PREFIX}${code}`, action: 'fix' };
  });
}

/** 人工指认项：tree 可为树 id 或树名（名须唯一命中） */
export interface TreeSubjectAssignment {
  tree: string;
  code: string;
}

/**
 * 应用人工指认（覆盖自动判定）：把指定树改为 `subj:{code}`。纯函数（返回新计划，不改入参）。
 * 守卫：code 必须是已建归一行；tree 必须命中计划内一棵树——任一不满足即抛错，不静默跳过。
 */
export function applySubjectAssignments(
  plan: TreeSubjectFixItem[],
  assignments: TreeSubjectAssignment[],
  entries: DictEntry[],
): TreeSubjectFixItem[] {
  const normalizedCodes = new Set(entries.filter((e) => !e.site).map((e) => e.code));
  const byKey = new Map<string, TreeSubjectFixItem>();
  for (const item of plan) { byKey.set(item.id, item); byKey.set(item.name, item); }

  const patches = new Map<string, string>();
  for (const { tree, code } of assignments) {
    if (!normalizedCodes.has(code)) {
      throw new Error(`未知归一学科码 "${code}"（须为已建归一行；先建字典行再指认）`);
    }
    const target = byKey.get(tree);
    if (!target) throw new Error(`未找到树 "${tree}"（id 或名称均未命中）`);
    patches.set(target.id, `${SUBJ_PREFIX}${code}`);
  }

  return plan.map((item) => {
    const to = patches.get(item.id);
    return to === undefined ? item : { ...item, to, action: 'fix' };
  });
}

export function summarizeTreeSubjectFixPlan(plan: TreeSubjectFixItem[]): TreeSubjectFixReport {
  const report: TreeSubjectFixReport = { fixed: 0, skipped: 0, nulled: 0, nulledNames: [] };
  for (const item of plan) {
    if (item.action === 'skip') report.skipped += 1;
    else if (item.action === 'fix') report.fixed += 1;
    else {
      report.nulled += 1;
      report.nulledNames.push(item.name);
    }
  }
  return report;
}

/** 落库（单事务）；幂等：对全 skip 计划为零变更 */
export function applyTreeSubjectFixPlan(db: Database, plan: TreeSubjectFixItem[]): TreeSubjectFixReport {
  const report: TreeSubjectFixReport = { fixed: 0, skipped: 0, nulled: 0, nulledNames: [] };
  const update = db.prepare('UPDATE trees SET subject_id = ? WHERE id = ?');
  db.transaction(() => {
    for (const item of plan) {
      if (item.action === 'skip') { report.skipped += 1; continue; }
      update.run(item.to, item.id);
      if (item.action === 'fix') report.fixed += 1;
      else {
        report.nulled += 1;
        report.nulledNames.push(item.name);
      }
    }
  });
  return report;
}
