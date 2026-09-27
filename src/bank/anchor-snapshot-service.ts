// 0024 P1：锚点快照导出（P-10 字典并集口径：trees/tree_nodes + dict_entries）
//
// 只读服务：全部路径为 SELECT，不写 operation_log、不动 schema（dict_entries.kind 的 CHECK 保持原样，
// 知识点继续走树腿——任务书 §〇）。空锚点显式化：调用方据此拒绝放行 AI（P-11「空锚点=必然编词」）。
//
// 学科匹配复用 src/bank/subject-normalize.ts：实库 trees.subject_id 存在三种格式
// （'subj:physics' / 站点 segment 'physics2' / 中文 '物理'），快照必须与题库页顶栏同源归一，否则选化学却命中物理树。
//
// 取数边界：node:sqlite 的结果是 Record<string, SQLOutputValue>，本文件用列取值器显式收窄
//（列缺失/类型不符即抛错），不用 any/unknown 断言——SQLite 无列类型约束，静默取错值比抛错更贵。

import type { SQLOutputValue } from 'node:sqlite';

import type {
  AnchorDictGroups, AnchorDictRef, AnchorNodeRef, AnchorQuery, AnchorSnapshot,
  AnchorSnapshotService, AnchorTreeRef,
} from '../shared/contracts/ai-anchor.js';
import type { DictEntry, DictKind, TreeType } from '../shared/contracts/bank-types.js';
import type { Database } from './db.js';
import { groupKeyOfSubject, resolveSubjectKey, siteOfTree } from './subject-normalize.js';
import { isArchivedTreeName } from './tree-archive.js';

type SqlRow = Record<string, SQLOutputValue>;

function sqlString(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`锚点快照取数异常：列 ${key} 非文本（实得 ${typeof value}）`);
  return value;
}

function sqlStringOrNull(row: SqlRow, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' ? value : null;
}

function sqlSort(row: SqlRow): number {
  const value = row['sort'];
  return typeof value === 'number' ? value : 0;
}

function sqlDictKind(row: SqlRow): DictKind {
  const value = row['kind'];
  if (value === 'subject' || value === 'question_type' || value === 'difficulty') return value;
  throw new Error(`dict_entries.kind 非法值：${String(value)}（schema CHECK 之外的脏数据，不静默忽略）`);
}

function sqlTreeType(row: SqlRow): TreeType {
  const value = row['type'];
  if (value === 'textbook' || value === 'knowledge') return value;
  throw new Error(`trees.type 非法值：${String(value)}（schema CHECK 之外的脏数据，不静默忽略）`);
}

/** 列行 → 契约实体（subject-normalize 的纯函数吃 camelCase：sourceLabel 漏映射会让站点行反查失效） */
function toDictEntry(row: SqlRow): DictEntry {
  const site = sqlStringOrNull(row, 'site');
  const sourceLabel = sqlStringOrNull(row, 'source_label');
  return {
    id: sqlString(row, 'id'),
    kind: sqlDictKind(row),
    code: sqlString(row, 'code'),
    label: sqlString(row, 'label'),
    ...(site !== null ? { site } : {}),
    ...(sourceLabel !== null ? { sourceLabel } : {}),
    active: true,
  };
}

function toDictRef(entry: DictEntry): AnchorDictRef {
  return { id: entry.id, kind: entry.kind, code: entry.code, label: entry.label };
}

export class AnchorSnapshotServiceImpl implements AnchorSnapshotService {
  constructor(private db: Database) {}

  async getAnchorSnapshot(query: AnchorQuery): Promise<AnchorSnapshot> {
    const stage = (query.stage ?? '').trim();
    const edition = (query.edition ?? '').trim();
    const subjectRaw = (query.subjectId ?? '').trim();
    const echoQuery: AnchorQuery = {
      ...(stage ? { stage } : {}),
      subjectId: subjectRaw,
      ...(edition ? { edition } : {}),
    };

    const allDict = this.listActiveDictEntries();
    const dict = this.groupDict(allDict);
    const dictTotal = dict.subjects.length + dict.questionTypes.length + dict.difficulties.length;
    const warnings: string[] = [];

    // 无学科 = 快照无法定格：显式空态（P-12 要求人工选学段-学科后才可用 AI）
    if (!subjectRaw) {
      return {
        query: echoQuery, trees: [], nodes: [], dict,
        empty: true,
        emptyReason: '未选择学科：学段-学科是锚点的定格维度（P-12），请先选择后再调用 AI',
        warnings,
      };
    }

    const subjectKey = resolveSubjectKey(subjectRaw, undefined, allDict) ?? subjectRaw.replace(/^subj:/, '');
    const trees = this.listTrees().filter((row) => {
      if (stage && (row.stage ?? '') !== stage) return false;
      if (edition && row.edition !== null && row.edition !== edition) return false;
      const treeKey = groupKeyOfSubject(row.subjectId, siteOfTree(row.source, row.name), allDict);
      return treeKey === subjectKey;
    });

    const nodes: AnchorNodeRef[] = [];
    const treeRefs: AnchorTreeRef[] = [];
    for (const row of trees) {
      treeRefs.push({
        id: row.id,
        name: row.name,
        type: row.type,
        ...(row.stage !== null ? { stage: row.stage } : {}),
        ...(row.edition !== null ? { edition: row.edition } : {}),
        ...(row.source !== null ? { source: row.source } : {}),
        subjectKey,
      });
      nodes.push(...this.flattenTree(row.id, this.listNodes(row.id)));
    }

    const empty = nodes.length === 0 && dictTotal === 0;
    if (nodes.length === 0) {
      warnings.push('当前学段-学科下没有可锚定的知识点/章节树节点：挂树类建议将全部回落 NONE（先跑 npm run collect:tree）');
    }
    if (dictTotal === 0) {
      warnings.push('字典锚（学科/题型/难度）为空：题型/难度类建议将全部回落 NONE（先跑 npm run collect:dict）');
    }

    return {
      query: echoQuery,
      trees: treeRefs,
      nodes,
      dict,
      empty,
      emptyReason: empty
        ? `学段「${stage || '不限'}」学科「${subjectRaw}」下无树节点且字典锚为空：先跑 npm run collect:dict / collect:tree`
        : null,
      warnings,
    };
  }

  /** 归一行进白名单（站点同义行不参与：它是「站点原文→标准码」映射腿，不是可回指的锚点） */
  private groupDict(entries: DictEntry[]): AnchorDictGroups {
    const normalized = entries.filter((e) => e.site === undefined);
    const of = (kind: DictKind) => normalized.filter((e) => e.kind === kind).map(toDictRef);
    return {
      subjects: of('subject'),
      questionTypes: of('question_type'),
      difficulties: of('difficulty'),
    };
  }

  private listActiveDictEntries(): DictEntry[] {
    const rows = this.db.prepare(`
      SELECT id, kind, code, label, site, source_label
      FROM dict_entries WHERE active = 1
      ORDER BY kind, code
    `).all();
    return rows.map(toDictEntry);
  }

  private listTrees(): Array<{
    id: string; type: TreeType; subjectId: string | undefined; edition: string | null;
    stage: string | null; name: string; source: string | undefined;
  }> {
    const rows = this.db.prepare(`
      SELECT id, type, subject_id, edition, stage, name, source
      FROM trees
      ORDER BY created_at, name, id
    `).all();
    return rows.map((row) => ({
      id: sqlString(row, 'id'),
      type: sqlTreeType(row),
      subjectId: sqlStringOrNull(row, 'subject_id') ?? undefined,
      edition: sqlStringOrNull(row, 'edition'),
      stage: sqlStringOrNull(row, 'stage'),
      name: sqlString(row, 'name'),
      source: sqlStringOrNull(row, 'source') ?? undefined,
      // 0039：已归档树不进锚点清单（D-050① 多来源/教材树在采集侧归一，注入只用权威树）
    })).filter((row) => !isArchivedTreeName(row.name));
  }

  private listNodes(treeId: string): Array<{ id: string; parentId: string | null; name: string; sort: number }> {
    const rows = this.db.prepare(`
      SELECT id, parent_id, name, sort
      FROM tree_nodes WHERE tree_id = ?
    `).all(treeId);
    return rows.map((row) => ({
      id: sqlString(row, 'id'),
      parentId: sqlStringOrNull(row, 'parent_id'),
      name: sqlString(row, 'name'),
      sort: sqlSort(row),
    }));
  }

  /**
   * 树内平铺节点 → 全路径行（先序：父在前、同级按 sort/name）。
   * 父不在本树 / 父为空 = 根（与题库页树面板的悬空父处理同源）；带 visited 守卫防数据环导致的死循环。
   */
  private flattenTree(treeId: string, rows: Array<{ id: string; parentId: string | null; name: string; sort: number }>): AnchorNodeRef[] {
    const byId = new Set(rows.map((r) => r.id));
    const children = new Map<string, typeof rows>();
    for (const row of rows) {
      const parentKey = row.parentId !== null && byId.has(row.parentId) ? row.parentId : '';
      const list = children.get(parentKey);
      if (list) list.push(row); else children.set(parentKey, [row]);
    }
    for (const list of children.values()) list.sort((a, b) => (a.sort - b.sort) || a.name.localeCompare(b.name, 'zh'));

    const out: AnchorNodeRef[] = [];
    const visited = new Set<string>();
    const walk = (parentKey: string, prefix: string[]): void => {
      for (const row of children.get(parentKey) ?? []) {
        if (visited.has(row.id)) continue;
        visited.add(row.id);
        const path = [...prefix, row.name];
        out.push({ id: row.id, treeId, path });
        walk(row.id, path);
      }
    };
    walk('', []);

    // 环等异常数据下的兜底：未走到的节点按原序补齐（不静默丢节点；路径退化为自身名）
    for (const row of rows) {
      if (visited.has(row.id)) continue;
      visited.add(row.id);
      out.push({ id: row.id, treeId, path: [row.name] });
    }
    return out;
  }
}
