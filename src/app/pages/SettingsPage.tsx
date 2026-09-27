// 0010-merge P2.8：设置页 v0（#/settings，用户拍板授权新增路由，覆盖 0010「不新增页面」条）。
// 0016 P2/P3 扩 + 目检返工 1/2：设置页只留「字典 / 树映射」一张入口卡（概要统计），
// 点击进入详情视图（组件内页间态切换，**零新路由**）；树映射降级节点级浏览——
// 点树 1 次 getNodes 出节点层级，点节点 1 次 getSourceMappings 出该节点映射
//（原 1+N 逐节点聚合经真实库目检实测卡顿，任务书 §二 P3.2 预留降级路径，报告记档）。
// 字典指认 = dict.update(id, { code, active: true })；code 指向守卫在 service 层（dict-service.ts P1-3）。
// 样式零新增 CSS 规则：复用 .settings-card 语义类 + --brick 等既有变量内联（theme.css 零改动）。

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import pkg from '../../../package.json';
import { ThemeSwitch } from '../components/ThemeSwitch.js';
import { Mascot } from '../components/Mascot.js';
import logoFull from '../assets/brand/logo-full.png';
import type {
  BankExtServices, DictEntry, DictKind, Tree, TreeNode, TreeSourceMapping,
} from '../../shared/contracts/bank-types.js';
import type { MofangAiBridge, MofangGuardBridge } from '../../shared/contracts/bridge.js';
import type { FileScanRecogAssetGarbageResult } from '../../shared/contracts/ipc-channels.js';
// 0071（R-043）：数据保存位置卡（当前位置/更改/待迁移展示；桥类型单源 bridge.ts）
import type { DataLocationInfo } from '../../shared/contracts/ipc-channels.js';
// 0072（只增）：关于卡更新区（版本更新通道；类型单源 distribution-types，端点常量单源 endpoints）
import type { UpdateStatus } from '../../shared/contracts/distribution-types.js';
import { MF_RELEASE_PAGE_URL } from '../../shared/endpoints.js';
import type { ReactElement } from 'react';
import type {
  AiTestConnectionResult, ModelProfile, ModelRole,
} from '../../shared/contracts/ai-types.js';
import { createBankExtServices } from '../services/BankExtServiceFactory.js';
import { createAiServices } from '../services/AiServiceFactory.js';
import { MessageBanner, Modal, type PageMessage } from './ExtUi.js';
import { siteOfTree, groupKeyOfSubject, subjectLabelOf } from '../../bank/subject-normalize.js';
// 0055（R-044）：默认学段学科（localStorage 偏好；消费方挂载时读）
import {
  readDefaultStageSubject, subscribeDefaultStageSubject, writeDefaultStageSubject, stageOptionsWith,
} from '../state/default-stage-subject.js';

const KIND_LABEL: Record<DictKind, string> = {
  subject: '学科',
  question_type: '题型',
  difficulty: '难度',
};
const KIND_ORDER: DictKind[] = ['subject', 'question_type', 'difficulty'];

export function SettingsPage({ ext: injectedExt, ai: injectedAi, guard: injectedGuard, initialView }: { ext?: BankExtServices; ai?: MofangAiBridge; guard?: MofangGuardBridge; /** 0053：#/settings?view=ai 深链初始视图（缺省 main，现状不变） */ initialView?: 'main' | 'mapping' | 'ai' } = {}) {
  const ext = useMemo(() => injectedExt ?? createBankExtServices(), [injectedExt]);
  const ai = useMemo(() => injectedAi ?? createAiServices(), [injectedAi]);
  // 0037 目检返工 #6：数据备份自首页迁入（渲染时读取桥，注入优先；无桥=测试/异常环境不渲染该卡）
  const guard = injectedGuard ?? window.__mofangGuard;
  // 目检返工 1：main=入口卡；mapping=映射详情（页内态，零新路由）
  // 0023：ai=模型配置详情（同模式：入口卡 + 页内详情，零新路由）
  // 0053：深链初始视图（#/settings?view=ai 直达；缺省 main）
  const [view, setView] = useState<'main' | 'mapping' | 'ai'>(initialView ?? 'main');

  if (view === 'mapping') {
    return (
      <div>
        <div className="page-head">
          <div>
            <div className="page-title">设置</div>
            <div className="page-desc">字典映射 · 树映射（只读查看 + 未知值指认）</div>
          </div>
        </div>
        <div data-testid="settings-mapping-detail">
          <button
            type="button"
            className="btn btn-sm"
            data-testid="settings-mapping-back"
            onClick={() => setView('main')}
          >
            ← 返回设置
          </button>
          <div style={{ height: '0.75rem' }} />
          <DictMappingCard ext={ext} />
          <TreeMappingCard ext={ext} />
        </div>
      </div>
    );
  }

  if (view === 'ai') {
    return (
      <div>
        <div className="page-head">
          <div>
            <div className="page-title">设置</div>
            <div className="page-desc">模型配置（五角色档案 · Key 托管 · 测连通）</div>
          </div>
        </div>
        <div data-testid="settings-ai-detail">
          <button
            type="button"
            className="btn btn-sm"
            data-testid="settings-ai-back"
            onClick={() => setView('main')}
          >
            ← 返回设置
          </button>
          <div style={{ height: '0.75rem' }} />
          <AiConfigCard ai={ai} />
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="page-title">设置</div>
          <div className="page-desc">外观 · 模型配置 · 字典 / 树映射 · 数据位置 · 诊断 · 关于</div>
        </div>
      </div>

      <div className="card settings-card">
        <div className="card-title">外观</div>
        <div className="settings-appearance">
          <ThemeSwitch testid="settings-theme-switch" />
          <span className="settings-appearance-hint">暖纸 / 澄光 / 夜航，重启后保持</span>
        </div>
      </div>

      <AiEntryCard ai={ai} onOpen={() => setView('ai')} />

      <MappingEntryCard ext={ext} onOpen={() => setView('mapping')} />

      {/* 0055（R-044）：默认学段学科——单学段单学科老师的「打开即对」偏好（localStorage，零契约） */}
      <DefaultStageSubjectCard ext={ext} />

      {/* 0037 目检返工 #6：数据备份自首页迁入设置页 */}
      {guard && <BackupCard guard={guard} />}

      {/* 0061：存储清理（R-057 / D-072①）：手动扫描废图 → 预览 → 移入回收目录；无 file 桥环境整卡不渲染 */}
      <StorageCleanerCard />

      {/* 0066：诊断（R-002 可运维性一期）：一键导出脱敏诊断包（日志 + 版本 + 各表行数）；无 diag 桥不渲染 */}
      <DiagnosticsCard />

      {/* 0071（R-043）：数据保存位置（不默认存 C 盘）——显示当前位置 + 更改（重启后迁移）；无桥不渲染 */}
      <DataLocationCard />

      <div className="card settings-card">
        <div className="card-title">关于</div>
        <div className="about-row">
          {/* 完整横版 Logo（任务书 P3.10：设置页关于块 = 完整 logo-full.png） */}
          <img
            className="about-logo-full"
            data-testid="about-logo-full"
            src={logoFull}
            alt="魔方助教 — 让每一位老师更轻松"
            draggable={false}
          />
          <div className="about-meta">
            <div className="about-line">产品名：魔方助教</div>
            <div className="about-line">标语：让每一位老师更轻松</div>
            <div className="about-line" data-testid="about-version">版本：{pkg.version}</div>
          </div>
          <Mascot mood="like" size={56} />
        </div>
        {/* 0072（只增）：更新区并入关于卡（D-088）——检查更新/状态/进度/慢速提示/重启安装/手动下载；
            无桥或通道未接线（dev/自动化态）整区不渲染，关于卡其余照旧 */}
        <UpdateArea />
      </div>
    </div>
  );
}

// ==================== 目检返工 1：映射入口卡（概要统计 = 2 次轻查询，不预取节点） ====================

function MappingEntryCard({ ext, onOpen }: { ext: BankExtServices; onOpen: () => void }) {
  const [summary, setSummary] = useState<{ dictRows: number; unknown: number; trees: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [entries, trees] = await Promise.all([ext.dict.listEntries(), ext.tree.listTrees({})]);
        if (cancelled) return;
        setSummary({
          dictRows: entries.length,
          unknown: entries.filter((e) => e.site && e.code === '' && !e.active).length,
          trees: trees.length,
        });
      } catch {
        // 概要失败不阻塞入口（点击进入后各块仍有各自的错误展示）
        if (!cancelled) setSummary(null);
      }
    })();
    return () => { cancelled = true; };
  }, [ext]);

  return (
    <div className="card settings-card" data-testid="settings-mapping-entry">
      <div className="card-title">字典 / 树映射</div>
      <div style={{ color: 'var(--ink-3)', fontSize: '12px', marginBottom: '0.5rem' }}>
        采集来源站同义值 → 标准码映射、知识树站点来源的只读查看；未识别的字典值可在此指认归位。
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <span data-testid="settings-mapping-summary" style={{ fontSize: '13px' }}>
          {summary ? `字典 ${summary.dictRows} 行 · 未知值 ${summary.unknown} · 树 ${summary.trees} 棵` : '概要加载中…'}
        </span>
        <button type="button" className="btn btn-sm" data-testid="settings-mapping-open" onClick={onOpen}>
          查看映射
        </button>
      </div>
    </div>
  );
}

// ==================== 0055（R-044）：默认学段-学科卡 ====================

/** 学段基准四值（拍板①按规划建议值：含「中职」——真库有中职树，r025-tree-stats 在案） */
const BASE_STAGE_OPTIONS = ['小学', '初中', '高中', '中职'];

/** 学段选项 = 基准四值 ∪ 已建树的 distinct stage（去重保序：四值在前，树上新学段追加在后） */
function mergeStageOptions(treeStages: Array<string | undefined>): string[] {
  const out = [...BASE_STAGE_OPTIONS];
  for (const stage of treeStages) {
    if (stage && !out.includes(stage)) out.push(stage);
  }
  return out;
}

/**
 * 默认学段-学科卡：改选即写 localStorage（纯偏好，不留痕）；改选对**之后进入**的页面生效
 * （各页/共享状态按「挂载时读」取用，不偷改正在编辑的页面）。
 * 学科选项 = 字典归一行（与题库页/采集页同一学科源）；空 = 不设置（不打扰）。
 */
function DefaultStageSubjectCard({ ext }: { ext: BankExtServices }) {
  const stored = useSyncExternalStore(subscribeDefaultStageSubject, readDefaultStageSubject);
  const [stages, setStages] = useState<string[]>(BASE_STAGE_OPTIONS);
  const [subjects, setSubjects] = useState<DictEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [trees, entries] = await Promise.all([
          ext.tree.listTrees({}),
          ext.dict.listEntries({ kind: 'subject', activeOnly: true }),
        ]);
        if (cancelled) return;
        setStages(mergeStageOptions(trees.map((t) => t.stage)));
        setSubjects(entries.filter((e) => !e.site));
      } catch {
        // 选项加载失败不阻塞：学段仍给基准四值，学科留空（值本身不被清）
        if (!cancelled) setStages(BASE_STAGE_OPTIONS);
      }
    })();
    return () => { cancelled = true; };
  }, [ext]);

  return (
    <div className="card settings-card" data-testid="settings-default-stage-subject">
      <div className="card-title">默认学段学科</div>
      <div style={{ color: 'var(--ink-3)', fontSize: '12px', marginBottom: '0.5rem' }}>
        大多数老师只教一个学段的一个科目——设一次，录题 / 采集 / 题库 / 考试 / 错题本的学段学科默认取此值（仍可随时改）。
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <label style={{ fontSize: '13px' }}>
          学段
          <select
            className="select"
            data-testid="settings-default-stage-select"
            value={stored.stage}
            onChange={(e) => writeDefaultStageSubject({ stage: e.target.value, subjectId: stored.subjectId })}
            style={{ marginLeft: 6 }}
          >
            <option value="">（不设置）</option>
            {stageOptionsWith(stages, stored.stage).map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label style={{ fontSize: '13px' }}>
          学科
          <select
            className="select"
            data-testid="settings-default-subject-select"
            value={stored.subjectId}
            onChange={(e) => writeDefaultStageSubject({ stage: stored.stage, subjectId: e.target.value })}
            style={{ marginLeft: 6 }}
          >
            <option value="">（不设置）</option>
            {subjects.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
        <span style={{ color: 'var(--ink-3)', fontSize: '12px' }}>选「（不设置）」即恢复不打扰</span>
      </div>
    </div>
  );
}

// ==================== 0016 P2：字典映射块（只读查看 + 未知值指认） ====================

function DictMappingCard({ ext }: { ext: BankExtServices }) {
  const [entries, setEntries] = useState<DictEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 未知行 id → 已选归一 code（指认交互本地态）
  const [picks, setPicks] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    ext.dict.listEntries()
      .then((es) => { if (!cancelled) setEntries(es); })
      .catch((err) => { if (!cancelled) setError(errMessage(err)); });
    return () => { cancelled = true; };
  }, [ext]);

  const assign = async (row: DictEntry) => {
    const code = picks[row.id];
    if (!code) return;
    try {
      const updated = await ext.dict.updateEntry(row.id, { code, active: true });
      setError(null);
      // 本地刷新该行（不整页重载）：未知行 → 已指认站点行，归组随 code 变化
      setEntries((prev) => (prev ?? []).map((e) => (e.id === updated.id ? updated : e)));
      setPicks((prev) => {
        const next = { ...prev };
        delete next[row.id];
        return next;
      });
    } catch (err) {
      // 失败（守卫拒绝/IPC 错）原样显示，不静默吞
      setError(errMessage(err));
    }
  };

  if (entries === null && error === null) {
    return (
      <div className="card settings-card" data-testid="settings-dict-card">
        <div className="card-title">字典映射</div>
        <div style={{ color: 'var(--ink-3)', fontSize: '13px' }}>字典加载中…</div>
      </div>
    );
  }

  return (
    <div className="card settings-card" data-testid="settings-dict-card">
      <div className="card-title">字典映射</div>
      <div style={{ color: 'var(--ink-3)', fontSize: '12px', marginBottom: '0.5rem' }}>
        采集来源站同义值 → 标准码的映射查看；未知值（未指认）可在此归位。归一行只读。
      </div>
      {error !== null && (
        <div data-testid="settings-dict-error" className="notice notice-red" style={{ margin: '0.5rem 0' }}>
          {error}
        </div>
      )}
      {entries !== null && entries.length === 0 && (
        <div data-testid="settings-dict-empty" style={{ color: 'var(--ink-3)', fontSize: '13px' }}>
          （暂无字典数据，先运行采集）
        </div>
      )}
      {entries !== null && entries.length > 0 && KIND_ORDER.map((kind) => {
        const kindRows = entries.filter((e) => e.kind === kind);
        const norms = kindRows.filter((e) => !e.site);
        const unknowns = kindRows.filter((e) => e.site && e.code === '');
        return (
          <div key={kind} data-testid="settings-dict-kind" data-kind={kind} style={{ marginBottom: '0.75rem' }}>
            <div style={{ fontWeight: 600, margin: '0.25rem 0' }}>{KIND_LABEL[kind]}</div>
            {norms.length === 0 && unknowns.length === 0 && (
              <div style={{ color: 'var(--ink-3)', fontSize: '12px' }}>（待采集）</div>
            )}
            {norms.map((norm) => (
              <div key={norm.id} data-testid="settings-dict-norm" style={{ padding: '0.35rem 0.5rem', border: '1px solid var(--line, #ddd8cf)', borderRadius: '6px', marginBottom: '0.35rem' }}>
                <div>
                  <code>{norm.code}</code> · {norm.label}
                </div>
                {kindRows.filter((e) => e.site && e.code === norm.code).map((row) => (
                  <div key={row.id} data-testid="settings-dict-site" style={{ color: 'var(--ink-3)', fontSize: '12px', paddingLeft: '1rem' }}>
                    {row.site} · {row.sourceLabel ?? row.label} → {row.code}
                  </div>
                ))}
              </div>
            ))}
            {unknowns.map((row) => (
              <div
                key={row.id}
                data-testid="settings-dict-unknown"
                data-unknown="true"
                data-id={row.id}
                style={{
                  display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
                  padding: '0.35rem 0.5rem', marginBottom: '0.35rem', borderRadius: '6px',
                  background: 'var(--brick-soft)', color: 'var(--brick)',
                }}
              >
                <span>{row.site} · {row.sourceLabel ?? row.label} → 未指认</span>
                <select
                  className="select"
                  data-testid="settings-dict-assign-select"
                  value={picks[row.id] ?? ''}
                  disabled={norms.length === 0}
                  onChange={(e) => setPicks((prev) => ({ ...prev, [row.id]: e.target.value }))}
                >
                  <option value="">{norms.length === 0 ? `${KIND_LABEL[kind]}（待采集）` : '选择归一值'}</option>
                  {norms.map((n) => (
                    <option key={n.code} value={n.code}>{n.label}（{n.code}）</option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn btn-sm"
                  data-testid="settings-dict-assign-btn"
                  disabled={!picks[row.id]}
                  onClick={() => assign(row)}
                >
                  指认
                </button>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

// ==================== 0016 P3：树映射块（只读；目检返工 2 降级节点级浏览） ====================

function TreeMappingCard({ ext }: { ext: BankExtServices }) {
  const [trees, setTrees] = useState<Tree[] | null>(null);
  const [subjectDict, setSubjectDict] = useState<DictEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [nodes, setNodes] = useState<TreeNode[] | null>(null);
  // nodeId → 已查映射（数组=有映射；'none'=已查无映射；undefined=未展开）；点开才查（1 次/节点）
  const [expanded, setExpanded] = useState<Record<string, TreeSourceMapping[] | 'none'>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [ts, subjDict] = await Promise.all([
          ext.tree.listTrees({}),
          ext.dict.listEntries({ kind: 'subject' }),
        ]);
        if (cancelled) return;
        setSubjectDict(subjDict);
        setTrees(ts);
      } catch (err) {
        if (!cancelled) setError(errMessage(err));
      }
    })();
    return () => { cancelled = true; };
  }, [ext]);

  const selectTree = async (id: string) => {
    setSelectedId(id);
    setNodes(null);
    setExpanded({});
    try {
      // 1 次 getNodes 出全树节点（原 1+N 逐节点聚合已移除——真实库实测卡顿根因）
      const ns = await ext.tree.getNodes(id);
      setNodes(ns);
    } catch (err) {
      setError(errMessage(err));
    }
  };

  const toggleNode = async (node: TreeNode) => {
    if (expanded[node.id] !== undefined) {
      setExpanded((prev) => {
        const next = { ...prev };
        delete next[node.id];
        return next;
      });
      return;
    }
    try {
      const mappings = await ext.tree.getSourceMappings(node.id);
      setExpanded((prev) => ({ ...prev, [node.id]: mappings.length > 0 ? mappings : 'none' }));
    } catch (err) {
      setError(errMessage(err));
    }
  };

  // 节点层级：byParent 组织 + 深度（parentId 悬空按根）；子序按 (sort, name) 稳定
  const nodeRows = useMemo(() => {
    if (nodes === null) return [] as Array<{ node: TreeNode; depth: number }>;
    const ids = new Set(nodes.map((n) => n.id));
    const byParent = new Map<string, TreeNode[]>();
    for (const n of nodes) {
      const pid = n.parentId && ids.has(n.parentId) ? n.parentId : '';
      if (!byParent.has(pid)) byParent.set(pid, []);
      byParent.get(pid)!.push(n);
    }
    for (const list of byParent.values()) list.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
    const rows: Array<{ node: TreeNode; depth: number }> = [];
    const walk = (pid: string, depth: number) => {
      for (const n of byParent.get(pid) ?? []) {
        rows.push({ node: n, depth });
        walk(n.id, depth + 1);
      }
    };
    walk('', 0);
    return rows;
  }, [nodes]);

  return (
    <div className="card settings-card" data-testid="settings-tree-card">
      <div className="card-title">树映射</div>
      <div style={{ color: 'var(--ink-3)', fontSize: '12px', marginBottom: '0.5rem' }}>
        知识组织树只读查看：类型 / 学科 / 名称 / 站点来源；选中树展开节点，点节点查看其站点映射。
      </div>
      {error !== null && (
        <div data-testid="settings-tree-error" className="notice notice-red" style={{ margin: '0.5rem 0' }}>
          {error}
        </div>
      )}
      {trees !== null && trees.length === 0 && (
        <div data-testid="settings-tree-empty" style={{ color: 'var(--ink-3)', fontSize: '13px' }}>
          （暂无树数据，先运行采集）
        </div>
      )}
      {trees !== null && trees.length > 0 && (
        <div data-testid="settings-tree-list">
          {trees.map((t) => {
            const groupKey = groupKeyOfSubject(t.subjectId, siteOfTree(t.source, t.name), subjectDict);
            const subjectLabel = subjectLabelOf(groupKey, subjectDict) ?? groupKey;
            const selected = t.id === selectedId;
            return (
              <button
                key={t.id}
                type="button"
                data-testid="settings-tree-row"
                data-tree-id={t.id}
                onClick={() => selectTree(t.id)}
                style={{
                  display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
                  padding: '0.35rem 0.5rem', marginBottom: '0.25rem', borderRadius: '6px',
                  border: '1px solid var(--line, #ddd8cf)',
                  background: selected ? 'var(--brick-soft)' : 'transparent',
                  color: selected ? 'var(--brick)' : 'inherit',
                }}
              >
                {t.type === 'textbook' ? '章节' : '知识点'} ｜ {subjectLabel} ｜ {t.name}
                ｜ 站点 {t.source ?? siteOfTree(t.source, t.name) ?? '—'}
              </button>
            );
          })}
        </div>
      )}
      {selectedId !== '' && (
        <div data-testid="settings-tree-nodes" style={{ marginTop: '0.5rem' }}>
          <div style={{ fontWeight: 600, margin: '0.25rem 0' }}>
            节点{nodes === null ? '加载中…' : `（共 ${nodes.length} 节点，点节点查看站点映射）`}
          </div>
          {nodeRows.map(({ node, depth }) => (
            <div key={node.id}>
              <button
                type="button"
                data-testid="settings-tree-node"
                data-node-id={node.id}
                data-name={node.name}
                data-depth={depth}
                onClick={() => toggleNode(node)}
                style={{
                  display: 'flex', alignItems: 'center', gap: '4px', width: '100%', cursor: 'pointer',
                  border: 'none', background: 'none', textAlign: 'left',
                  padding: '0.15rem 0.25rem', paddingLeft: `calc(${depth} * 1rem + 4px)`,
                }}
              >
                <span style={{ color: 'var(--ink-3)', flex: '0 0 auto' }}>
                  {expanded[node.id] !== undefined ? '▾' : '▸'}
                </span>
                {/* 长文本适配：文本项 min-width:0 + ellipsis（题库页树面板同类缺陷已在 0016 报告立案） */}
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {node.name}
                </span>
              </button>
              {expanded[node.id] !== undefined && (
                <div style={{ paddingLeft: `calc(${depth + 1} * 1rem + 4px)` }}>
                  {expanded[node.id] === 'none' && (
                    <div data-testid="settings-tree-node-empty" style={{ color: 'var(--ink-3)', fontSize: '12px', padding: '0.1rem 0.25rem' }}>
                      （该节点暂无站点映射）
                    </div>
                  )}
                  {expanded[node.id] !== 'none' && (expanded[node.id] as TreeSourceMapping[]).map((m, i) => (
                    <div
                      key={`${m.nodeId}:${m.site}:${m.siteNodeId}:${i}`}
                      data-testid="settings-tree-mapping"
                      style={{ color: 'var(--ink-3)', fontSize: '12px', padding: '0.1rem 0.25rem' }}
                    >
                      {m.site} · {m.siteNodeId}{m.siteNodeName ? ` · ${m.siteNodeName}` : ''}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ==================== 0023 P3：模型配置板块（入口卡 + 五角色详情；零新路由，同映射块模式） ====================
// 2026-09-17 目检返工 R1-R4：
// R1 R2 角色语义明确为「OCR」（识别切分主用），不再用含混的「视觉」；
// R2 R1 推理声明需支持图片输入（识别切分主力通道）；
// R3 表单对齐常见 AI 产品：名称→供应商→BaseURL→协议(下拉)→API Key→模型(手输+获取列表)；
//    占位符统一 deepseek 示例；R4 档案行四按钮（启用/停用、检测、编辑、删除）+「当前使用中」标记，
//    未测通「启用」置灰，档案间启用切换状态跟随（service 排他 + 列表重载）。

/** 五角色（P-14）：中文名 + 用途一句话；R2=OCR 语义、R1 声明图片输入（目检返工 R1/R2，D-045） */
const AI_ROLE_ORDER: ModelRole[] = ['reasoning', 'vision', 'light', 'embedding', 'specialty'];
const AI_ROLE_META: Record<ModelRole, { label: string; desc: string }> = {
  reasoning: { label: 'R1 推理', desc: '主力分析与生成（讲义、解析、批改）·同样需要支持图片输入的模型（识别切分主力通道）' },
  vision: { label: 'R2 OCR', desc: 'OCR 识别与看图理解：题目识别切分、试卷分析、图题理解·需要支持图片输入的模型' },
  light: { label: 'R3 轻量', desc: '高频轻任务（打标、分类、短文本生成）' },
  embedding: { label: 'R4 向量', desc: '相似题检索与去重的向量化' },
  specialty: { label: 'R5 专用', desc: '第三方专用接口预留位（可建档；非 openai-chat 协议调用将提示未实装）' },
};

function AiEntryCard({ ai, onOpen }: { ai: MofangAiBridge; onOpen: () => void }) {
  const [summary, setSummary] = useState<{ total: number; enabledRoles: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await ai.profile.list({});
        if (cancelled) return;
        const enabledRoles = new Set(list.filter((p) => p.isEnabled).map((p) => p.role));
        setSummary({ total: list.length, enabledRoles: enabledRoles.size });
      } catch {
        // 概要失败不阻塞入口（详情内仍有各自错误展示）
        if (!cancelled) setSummary(null);
      }
    })();
    return () => { cancelled = true; };
  }, [ai]);

  return (
    <div className="card settings-card" data-testid="settings-ai-entry">
      <div className="card-title">模型配置</div>
      <div style={{ color: 'var(--ink-3)', fontSize: '12px', marginBottom: '0.5rem' }}>
        接入你自己的模型 API Key——全部 AI 能力的总开关。Key 加密托管于本机，界面只写不回显。
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <span data-testid="settings-ai-summary" style={{ fontSize: '13px' }}>
          {summary ? `${summary.total} 个档案 · ${summary.enabledRoles}/5 个角色已启用` : '概要加载中…'}
        </span>
        <button type="button" className="btn btn-sm" data-testid="settings-ai-open" onClick={onOpen}>
          配置模型
        </button>
      </div>
    </div>
  );
}

interface AiFormState {
  mode: 'create' | 'edit';
  role: ModelRole;
  profile: ModelProfile | null;
  name: string;
  provider: string;
  protocol: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  visionCap: boolean;
}

function AiConfigCard({ ai }: { ai: MofangAiBridge }) {
  const [profiles, setProfiles] = useState<ModelProfile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  // 测连通结果（瞬态展示；service 侧已回写 lastTestOk/lastTestAt）
  const [testResults, setTestResults] = useState<Record<string, AiTestConnectionResult>>({});
  const [form, setForm] = useState<AiFormState | null>(null);
  // 两击确认删除（禁 confirm()；其余动作自动解除待确认态）
  const [armedDeleteId, setArmedDeleteId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await ai.profile.list({});
        if (!cancelled) {
          setProfiles(list);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(errMessage(err));
      }
    })();
    return () => { cancelled = true; };
  }, [ai]);

  const reload = async () => {
    try {
      const list = await ai.profile.list({});
      setProfiles(list);
      setError(null);
    } catch (err) {
      setError(errMessage(err));
    }
  };

  const withError = async (fn: () => Promise<void>) => {
    try {
      await fn();
      setError(null);
    } catch (err) {
      setError(errMessage(err));
    }
  };

  const openCreate = (role: ModelRole) => {
    setArmedDeleteId(null);
    setForm({
      mode: 'create', role, profile: null,
      name: '', provider: '', protocol: 'openai-chat', baseUrl: '', model: '', apiKey: '', visionCap: true,
    });
  };

  const openEdit = (p: ModelProfile) => {
    setArmedDeleteId(null);
    setForm({
      mode: 'edit', role: p.role, profile: p,
      name: p.name, provider: p.provider, protocol: p.protocol, baseUrl: p.baseUrl, model: p.model,
      apiKey: '', visionCap: p.capability?.vision ?? true,
    });
  };

  const save = () => withError(async () => {
    if (!form) return;
    const capability = form.role === 'vision' || form.role === 'reasoning' ? { vision: form.visionCap } : undefined;
    if (form.mode === 'create') {
      await ai.profile.create({
        data: {
          role: form.role, name: form.name.trim(), provider: form.provider.trim(), protocol: form.protocol.trim() || 'openai-chat',
          baseUrl: form.baseUrl.trim(), model: form.model.trim(), capability,
          apiKey: form.apiKey || undefined,
        },
      });
    } else if (form.profile) {
      await ai.profile.update({
        id: form.profile.id,
        data: {
          name: form.name.trim(), provider: form.provider.trim(), protocol: form.protocol.trim() || 'openai-chat',
          baseUrl: form.baseUrl.trim(), model: form.model.trim(), capability,
          // Key 只写不回显：留空=不换 Key（undefined）；非空=换 Key
          apiKey: form.apiKey || undefined,
        },
      });
    }
    setForm(null);
    await reload();
  });

  const runTest = (p: ModelProfile) => withError(async () => {
    setTestingId(p.id);
    try {
      const result = await ai.profile.testConnection({ profileId: p.id });
      setTestResults((prev) => ({ ...prev, [p.id]: result }));
      await reload();
    } finally {
      setTestingId(null);
    }
  });

  const setEnabled = (p: ModelProfile, enabled: boolean) => withError(async () => {
    await ai.profile.setEnabled({ id: p.id, enabled });
    // 整表重载：同角色排他后其余档案（含原先使用中的）状态随之刷新（返工 R4 切换联动）
    await reload();
  });

  const removeProfile = (p: ModelProfile) => withError(async () => {
    if (armedDeleteId !== p.id) {
      setArmedDeleteId(p.id); // 第一击：待确认态
      return;
    }
    await ai.profile.delete({ id: p.id });
    setArmedDeleteId(null);
    await reload();
  });

  const byRole = (role: ModelRole) => (profiles ?? []).filter((p) => p.role === role);

  return (
    <div className="card settings-card" data-testid="settings-ai-card">
      <div className="card-title">模型配置</div>
      <div style={{ color: 'var(--ink-3)', fontSize: '12px', marginBottom: '0.5rem' }}>
        五个角色各至多启用一个档案；新档案须先测连通才能启用。Key 加密存本机（safeStorage），编辑时留空即不换 Key。
      </div>
      {error !== null && (
        <div data-testid="settings-ai-error" className="notice notice-red" style={{ margin: '0.5rem 0' }}>
          {error}
        </div>
      )}
      {form !== null && (
        <AiProfileModal
          ai={ai}
          form={form}
          onChange={(patch) => setForm((prev) => (prev ? { ...prev, ...patch } : prev))}
          onSave={save}
          onCancel={() => setForm(null)}
        />
      )}
      {profiles === null && error === null && (
        <div style={{ color: 'var(--ink-3)', fontSize: '13px' }}>档案加载中…</div>
      )}
      {AI_ROLE_ORDER.map((role) => {
        const meta = AI_ROLE_META[role];
        const rows = byRole(role);
        return (
          <div key={role} data-testid="settings-ai-role" data-role={role} style={{ marginBottom: '1rem' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 600 }}>{meta.label}</span>
              <span style={{ color: 'var(--ink-3)', fontSize: '12px' }}>{meta.desc}</span>
              <span style={{ flex: '1 1 auto' }} />
              <button
                type="button"
                className="btn btn-sm"
                data-testid="settings-ai-create"
                data-role={role}
                onClick={() => openCreate(role)}
              >
                新建档案
              </button>
            </div>
            {rows.length === 0 && (
              <div style={{ color: 'var(--ink-3)', fontSize: '12px', padding: '0.25rem 0.5rem' }}>
                （该角色暂无档案，未配置态）
              </div>
            )}
            {rows.map((p) => {
              const testResult = testResults[p.id];
              const lightState = p.lastTestOk === true ? 'ok' : p.lastTestOk === false ? 'fail' : 'none';
              const lightColor = lightState === 'ok' ? '#2e7d32' : lightState === 'fail' ? '#c62828' : 'var(--ink-3, #999)';
              return (
                <div
                  key={p.id}
                  data-testid="settings-ai-row"
                  data-id={p.id}
                  style={{
                    border: '1px solid var(--line, #ddd8cf)', borderRadius: '6px',
                    padding: '0.4rem 0.5rem', marginBottom: '0.4rem',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 600 }}>{p.name}</span>
                    <span style={{ color: 'var(--ink-3)', fontSize: '12px' }}>
                      {p.provider} · {p.model} · {p.protocol}
                    </span>
                    <span
                      data-testid="settings-ai-key-state"
                      data-configured={String(p.hasKey)}
                      style={{ color: 'var(--ink-3)', fontSize: '12px' }}
                    >
                      {p.hasKey ? '已配置（••••）' : '未配置 Key'}
                    </span>
                    <span style={{ flex: '1 1 auto' }} />
                    {/* 测连通状态灯 */}
                    <span
                      data-testid="settings-ai-light"
                      data-state={lightState}
                      title={lightState === 'ok' ? `测通 ${p.lastTestAt ?? ''}` : lightState === 'fail' ? '最近一次测试失败' : '未测试'}
                      style={{ color: lightColor, fontSize: '13px' }}
                    >
                      ●
                    </span>
                    {/* 返工 R4：使用中标记位于按钮组左侧 */}
                    {p.isEnabled && (
                      <span data-testid="settings-ai-in-use" style={{ color: '#2e7d32', fontSize: '12px', fontWeight: 600 }}>
                        当前使用中
                      </span>
                    )}
                    {/* 返工 R4：启用/停用同位按钮；P-18 未测通启用置灰（service 双保险） */}
                    <button
                      type="button"
                      className="btn btn-sm"
                      data-testid="settings-ai-enable"
                      data-id={p.id}
                      disabled={!p.isEnabled && p.lastTestOk !== true}
                      title={!p.isEnabled && p.lastTestOk !== true ? '须先测连通成功才能启用' : undefined}
                      onClick={() => setEnabled(p, !p.isEnabled)}
                    >
                      {p.isEnabled ? '停用' : '启用'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      data-testid="settings-ai-test"
                      disabled={testingId === p.id}
                      onClick={() => runTest(p)}
                    >
                      {testingId === p.id ? '测试中…' : '测连通'}
                    </button>
                    <button type="button" className="btn btn-sm" data-testid="settings-ai-edit" onClick={() => openEdit(p)}>
                      编辑
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      data-testid="settings-ai-delete"
                      onClick={() => removeProfile(p)}
                    >
                      {armedDeleteId === p.id ? '确认删除' : '删除'}
                    </button>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <span style={{ color: 'var(--ink-3)', fontSize: '12px' }}>
                      {lightState === 'ok' && p.lastTestAt ? `测通于 ${p.lastTestAt.replace('T', ' ').slice(0, 19)}` : lightState === 'fail' ? '最近一次测试失败' : '未测试'}
                    </span>
                    {testResult && (
                      <span data-testid="settings-ai-test-result" data-ok={String(testResult.ok)} style={{ fontSize: '12px', color: testResult.ok ? '#2e7d32' : '#c62828' }}>
                        {testResult.ok
                          ? `测连通成功 · 延迟 ${testResult.latencyMs}ms${testResult.reply ? ` · 回复：${testResult.reply.slice(0, 40)}` : ''}`
                          : `测连通失败：${testResult.error ?? '未知错误'}`}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/**
 * 0023 目检返工 R5/R6/R7（2026-09-17 二轮）：新建/编辑档案改为弹窗（与图片放大预览同手法定时遮罩变暗），
 * 字段改「标签在上、输入框全宽等长」的常见 AI 产品形态；模型字段用自绘下拉（箭头观感对齐协议 select），
 * 修复原生 datalist 按输入裁剪选项的缺陷——下拉恒展示全量已拉取模型，无论输入框是否已填/填了什么；
 * ESC / 点遮罩 / 点 X 均可关闭（与 ImageLightbox 交互一致）。
 */
/**
 * 0037 目检返工 #6：数据备份卡（自首页迁入，能力等强移植）——立即备份 / 从备份恢复
 * （0004 两段式：先预览规模弹层再确认，禁 confirm）/ 结果消息条（IPC 失败必须可见）。
 */
function BackupCard({ guard }: { guard: MofangGuardBridge }) {
  const [stats, setStats] = useState<{ questions: number; papers: number; assets: number } | null>(null);
  const [backupInProgress, setBackupInProgress] = useState(false);
  const [restoreInProgress, setRestoreInProgress] = useState(false);
  const [message, setMessage] = useState<PageMessage | null>(null);
  // 0004：恢复确认走自绘弹层（禁 confirm；展示备份规模 → 确认后执行）
  const [restorePreview, setRestorePreview] = useState<{ questions: number; papers: number } | null>(null);

  useEffect(() => {
    guard.getStats().then(setStats).catch(() => setStats(null));
  }, [guard]);

  const handleBackup = async () => {
    setBackupInProgress(true);
    setMessage(null);
    try {
      const result = await guard.createBackup();
      if (result.success && result.manifest) {
        setMessage({
          type: 'success',
          text: `备份成功！题目 ${result.manifest.counts.questions} 个，试卷 ${result.manifest.counts.papers} 个，资产 ${result.manifest.counts.assets} 个`,
        });
      } else {
        setMessage({ type: 'error', text: result.error || '备份失败' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBackupInProgress(false);
    }
  };

  const handleRestore = async () => {
    setRestoreInProgress(true);
    setMessage(null);
    try {
      // 第一步：预览（不确认）→ 自绘弹层展示规模，用户确认后走第二步
      const previewResult = await guard.restoreBackup({ confirmed: false });
      if (previewResult.needsConfirmation) {
        // guard 桥返回类型未声明 manifest（既有冻结），真机 IPC 实际携带——局部窄化读取，不动契约
        const previewManifest = (previewResult as { manifest?: { counts?: { questions?: number; papers?: number } } }).manifest;
        setRestorePreview({
          questions: previewManifest?.counts?.questions ?? 0,
          papers: previewManifest?.counts?.papers ?? 0,
        });
        setRestoreInProgress(false);
        return;
      }
      if (!previewResult.success) {
        setMessage({ type: 'error', text: previewResult.error || '恢复失败' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setRestoreInProgress(false);
    }
  };

  const confirmRestore = async () => {
    setRestorePreview(null);
    setRestoreInProgress(true);
    try {
      // 第二步：确认恢复
      const restoreResult = await guard.restoreBackup({ confirmed: true });
      if (restoreResult.success && restoreResult.restored) {
        setMessage({
          type: 'success',
          text: `恢复成功！题目 ${restoreResult.restored.questions} 个，试卷 ${restoreResult.restored.papers} 个，资产 ${restoreResult.restored.assets} 个。数据已重建，可继续使用。`,
        });
      } else {
        setMessage({ type: 'error', text: restoreResult.error || '恢复失败' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setRestoreInProgress(false);
    }
  };

  return (
    <div className="card settings-card" data-testid="settings-backup-card">
      <div className="card-title">数据备份</div>
      {stats && (
        <div style={{ marginBottom: '0.75rem', color: 'var(--ink-2)', fontSize: 13 }}>
          当前数据：题目 {stats.questions} 个，试卷 {stats.papers} 个，资产 {stats.assets} 个
        </div>
      )}
      <div style={{ display: 'flex', gap: '1rem' }}>
        <button className="btn" data-testid="settings-backup-btn" onClick={handleBackup} disabled={backupInProgress}>
          {backupInProgress ? '备份中...' : '立即备份'}
        </button>
        <button className="btn" data-testid="settings-restore-btn" onClick={handleRestore} disabled={restoreInProgress}>
          {restoreInProgress ? '恢复中...' : '从备份恢复'}
        </button>
      </div>
      <MessageBanner message={message} />
      {restorePreview && (
        <Modal title="确认恢复数据" onClose={() => setRestorePreview(null)}>
          <p style={{ marginTop: 0 }}>
            即将从备份恢复数据，当前数据将被替换。<br />
            备份包含：题目 {restorePreview.questions} 个，试卷 {restorePreview.papers} 个。
          </p>
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
            <button className="btn" data-testid="restore-cancel-btn" onClick={() => setRestorePreview(null)}>取消</button>
            <button className="btn btn-danger" data-testid="restore-confirm-btn" onClick={() => void confirmRestore()}>
              确认恢复
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function AiProfileModal({ ai, form, onChange, onSave, onCancel }: {
  ai: MofangAiBridge;
  form: AiFormState;
  onChange: (patch: Partial<AiFormState>) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const meta = AI_ROLE_META[form.role];
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [modelListOpen, setModelListOpen] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const protocolIsBuiltin = form.protocol === 'openai-chat';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const fetchModels = async () => {
    setFetchingModels(true);
    setFormError(null);
    try {
      const result = await ai.models.list({
        baseUrl: form.baseUrl.trim() || undefined,
        apiKey: form.apiKey || undefined,
        profileId: form.mode === 'edit' ? form.profile?.id : undefined,
      });
      if (result.ok) {
        setModelOptions(result.models);
        // 获取成功即展开全量下拉（R7：无论输入框当前填了什么，选项恒全量）
        setModelListOpen(true);
        if (result.models.length === 0) setFormError('该服务未返回任何模型');
      } else {
        setFormError(result.error ?? '获取模型列表失败');
      }
    } catch (err) {
      setFormError(errMessage(err));
    } finally {
      setFetchingModels(false);
    }
  };

  const fieldWrap = { marginBottom: '0.7rem' } as const;
  const fullInput = { width: '100%' } as const;

  return (
    <div
      data-testid="settings-ai-modal"
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(24, 18, 12, 0.82)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        data-testid="settings-ai-form"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(520px, 92vw)', maxHeight: '86vh', overflowY: 'auto',
          background: 'var(--card)', borderRadius: 10,
          boxShadow: '0 12px 48px rgba(0, 0, 0, .45)',
          padding: '1.1rem 1.25rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.9rem' }}>
          <div style={{ fontWeight: 600, fontSize: '15px' }}>
            {form.mode === 'create' ? `新建档案 · ${meta.label}` : `编辑档案 · ${meta.label}`}
          </div>
          <button
            type="button"
            className="btn btn-sm"
            data-testid="settings-ai-modal-close"
            aria-label="关闭"
            onClick={onCancel}
            style={{ border: 'none', background: 'none', fontSize: '16px', color: 'var(--ink-3)', cursor: 'pointer', lineHeight: 1 }}
          >
            ×
          </button>
        </div>

        <div style={fieldWrap}>
          <span className="field-label">名称</span>
          <input className="input" style={fullInput} data-testid="settings-ai-field-name" value={form.name} onChange={(e) => onChange({ name: e.target.value })} placeholder="如：DeepSeek 官方" />
        </div>
        <div style={fieldWrap}>
          <span className="field-label">供应商</span>
          <input className="input" style={fullInput} data-testid="settings-ai-field-provider" value={form.provider} onChange={(e) => onChange({ provider: e.target.value })} placeholder="如：deepseek" />
        </div>
        <div style={fieldWrap}>
          <span className="field-label">Base URL</span>
          <input className="input" style={fullInput} data-testid="settings-ai-field-base-url" value={form.baseUrl} onChange={(e) => onChange({ baseUrl: e.target.value })} placeholder="https://api.deepseek.com/v1" />
        </div>
        <div style={fieldWrap}>
          <span className="field-label">协议类型</span>
          <select
            className="select"
            style={fullInput}
            data-testid="settings-ai-field-protocol"
            value={protocolIsBuiltin ? 'openai-chat' : 'custom'}
            onChange={(e) => onChange({ protocol: e.target.value === 'openai-chat' ? 'openai-chat' : '' })}
          >
            <option value="openai-chat">openai-chat（OpenAI 兼容）</option>
            <option value="custom">自定义（预留）</option>
          </select>
          {!protocolIsBuiltin && (
            <div style={{ marginTop: '0.4rem' }}>
              <input
                className="input"
                style={fullInput}
                data-testid="settings-ai-field-protocol-custom"
                value={form.protocol}
                onChange={(e) => onChange({ protocol: e.target.value })}
                placeholder="自定义协议标识（如 http-custom）"
              />
            </div>
          )}
        </div>
        <div style={fieldWrap}>
          <span className="field-label">API Key</span>
          {/* 只写不回显：密码框 + 恒空值；已配置显示掩码提示，留空=不换 Key */}
          <input
            className="input"
            style={fullInput}
            type="password"
            data-testid="settings-ai-field-api-key"
            value={form.apiKey}
            onChange={(e) => onChange({ apiKey: e.target.value })}
            placeholder={form.mode === 'edit' && form.profile?.hasKey ? '已配置（••••），留空=不换 Key' : '粘贴 API Key（sk-…，加密托管于本机）'}
            autoComplete="off"
          />
        </div>
        <div style={fieldWrap}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span className="field-label">模型</span>
            <button
              type="button"
              className="btn btn-sm"
              data-testid="settings-ai-fetch-models"
              disabled={fetchingModels}
              onClick={fetchModels}
            >
              {fetchingModels ? '获取中…' : '获取模型列表'}
            </button>
          </div>
          {/* R6/R7：自绘下拉——箭头观感对齐协议 select；恒展示全量选项（不被输入裁剪），也可直接手输 id */}
          <div style={{ position: 'relative' }}>
            <input
              className="input"
              style={{ ...fullInput, paddingRight: '2.2rem' }}
              data-testid="settings-ai-field-model"
              value={form.model}
              onChange={(e) => onChange({ model: e.target.value })}
              placeholder="如：deepseek-chat（可直接输入 id）"
            />
            <button
              type="button"
              data-testid="settings-ai-model-toggle"
              aria-label="展开模型列表"
              onClick={() => setModelListOpen((o) => !o)}
              style={{
                position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
                border: 'none', background: 'none', cursor: 'pointer',
                color: 'var(--ink-3)', fontSize: '11px', padding: '2px 5px', lineHeight: 1,
              }}
            >
              ▼
            </button>
            {modelListOpen && (
              <div
                data-testid="settings-ai-model-options"
                style={{
                  position: 'absolute', top: 'calc(100% + 2px)', left: 0, right: 0, zIndex: 20,
                  background: 'var(--card)', border: '1px solid var(--line-strong)', borderRadius: 8,
                  maxHeight: 200, overflowY: 'auto', boxShadow: '0 8px 24px rgba(0, 0, 0, .18)',
                }}
              >
                {modelOptions.length === 0 && (
                  <div style={{ padding: '8px 11px', color: 'var(--ink-3)', fontSize: '12.5px' }}>
                    暂无选项——先点「获取模型列表」，或直接输入模型 id
                  </div>
                )}
                {modelOptions.map((id) => (
                  <div
                    key={id}
                    data-testid="settings-ai-model-option"
                    data-id={id}
                    onClick={() => { onChange({ model: id }); setModelListOpen(false); setFormError(null); }}
                    style={{ padding: '7px 11px', fontSize: '13px', cursor: 'pointer', borderBottom: '1px solid var(--line)' }}
                  >
                    {id}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        {(form.role === 'vision' || form.role === 'reasoning') && (
          <div style={fieldWrap}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px' }}>
              <input
                type="checkbox"
                data-testid="settings-ai-field-vision-cap"
                checked={form.visionCap}
                onChange={(e) => onChange({ visionCap: e.target.checked })}
              />
              该模型支持图片输入（{form.role === 'reasoning' ? 'R1 识别切分需要' : 'R2 OCR 需要'}）
            </label>
          </div>
        )}
        {formError !== null && (
          <div data-testid="settings-ai-form-error" className="notice notice-red" style={{ margin: '0.4rem 0 0.6rem' }}>
            {formError}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '0.9rem' }}>
          <button type="button" className="btn btn-sm" data-testid="settings-ai-cancel" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="btn btn-sm" data-testid="settings-ai-save" onClick={onSave}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

// ==================== 0061：存储清理卡（设置页手动废图扫描 → 回收；R-057 / D-072） ====================

/** 字节 → 人类可读（弹层与结果条同口径；≥1MB 一位小数 MB） */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/**
 * 0061（D-072①~③）：存储清理卡——扫描 `data/assets/recog/` 中「不再被任何题目/试卷/草稿引用」的
 * 录题图资产 → 预览（几个文件 / 多少 MB / 前 10 条）→ 确认后移入 `assets/_trash/<日期>/recog/`（可撤销）。
 * 全手动：不做启动期自动清理、不做定时任务；判定与移动全在主进程（渲染层只见 relPath 与字节数）。
 * 无 file 桥（浏览器 demo/测试环境）整卡不渲染——不出现死按钮（0016 口径）。
 */
function StorageCleanerCard() {
  // 桥取用与 guard 同口径（line 38）：渲染时从 window 读全局桥；无桥（浏览器 demo/测试）整卡不渲染
  const file = window.__mofangFile;
  const [scanning, setScanning] = useState(false);
  const [trashing, setTrashing] = useState(false);
  const [preview, setPreview] = useState<FileScanRecogAssetGarbageResult | null>(null);
  const [message, setMessage] = useState<PageMessage | null>(null);
  if (!file || typeof file.scanRecogAssetGarbage !== 'function') return null;

  const handleScan = async () => {
    setScanning(true);
    setMessage(null);
    setPreview(null);
    try {
      const result = await file.scanRecogAssetGarbage();
      if (result.orphans.length === 0) {
        setMessage({ type: 'success', text: `未发现未引用文件，无需清理（已扫描 ${result.scannedCount} 个资产文件）` });
      } else {
        setPreview(result);
      }
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setScanning(false);
    }
  };

  const handleTrash = async () => {
    if (!preview) return;
    setTrashing(true);
    setMessage(null);
    try {
      const result = await file.trashRecogAssets({ relPaths: preview.orphans.map((orphan) => orphan.relPath) });
      setPreview(null);
      setMessage({
        type: 'success',
        text: result.moved > 0
          ? `已移入回收目录 ${result.moved} 个文件，释放 ${formatBytes(result.bytes)}，回收目录：${result.trashDir}`
          : '没有文件需要移入回收目录（文件已被引用或占用）',
      });
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setTrashing(false);
    }
  };

  return (
    <div className="card settings-card" data-testid="settings-cleaner-card">
      <div className="card-title">存储清理</div>
      <div style={{ marginBottom: '0.75rem', color: 'var(--ink-2)', fontSize: 13 }}>
        扫描录题图片资产中不再被任何题目/试卷/草稿引用的文件，移入回收目录（可手动拷回）。
      </div>
      <button
        className="btn"
        data-testid="settings-cleaner-scan"
        onClick={() => void handleScan()}
        disabled={scanning}
      >
        {scanning ? '扫描中...' : '扫描废图'}
      </button>
      <MessageBanner message={message} />
      {preview && (
        <Modal title="确认清理废图" onClose={() => setPreview(null)}>
          <div data-testid="settings-cleaner-preview">
            <p style={{ marginTop: 0 }}>
              发现 {preview.orphans.length} 个未引用文件，共 {formatBytes(preview.totalBytes)}。
              <br />
              移入回收目录不删除文件，正在使用的图片不受影响。
            </p>
            <ul style={{ margin: '0.5rem 0', paddingLeft: '1.1rem', color: 'var(--ink-2)', fontSize: 13 }}>
              {preview.orphans.slice(0, 10).map((orphan) => (
                <li key={orphan.relPath}>{orphan.relPath}（{formatBytes(orphan.bytes)}）</li>
              ))}
            </ul>
            {preview.orphans.length > 10 && (
              <div style={{ color: 'var(--ink-2)', fontSize: 13 }}>…等共 {preview.orphans.length} 个</div>
            )}
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button className="btn" data-testid="settings-cleaner-cancel" onClick={() => setPreview(null)}>取消</button>
              <button
                className="btn btn-danger"
                data-testid="settings-cleaner-confirm"
                onClick={() => void handleTrash()}
                disabled={trashing}
              >
                {trashing ? '回收中...' : '移入回收目录'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ==================== 0066（R-002）：诊断卡（一键导出诊断包） ====================
// 桥取用同 StorageCleanerCard：渲染时从 window 读 __mofangDiag，无桥（浏览器 demo/测试）整卡不渲染。
// 导出内容由主进程 shell/diag 组装：manifest（版本/平台/时间戳/各表行数）+ 日志；题库原库、图片资产、
// 登录态与密钥密文一律不进包——卡片文案只承诺「脱敏」，细节以包内 manifest.excluded 为准。
function DiagnosticsCard() {
  const diag = window.__mofangDiag;
  const [exporting, setExporting] = useState(false);
  const [message, setMessage] = useState<PageMessage | null>(null);
  if (!diag || typeof diag.exportDiagnostics !== 'function') return null;

  const handleExport = async () => {
    setExporting(true);
    setMessage(null);
    try {
      const result = await diag.exportDiagnostics();
      if (result.canceled) return; // 用户取消：无产物即无提示（不报错打扰）
      if (result.success) {
        setMessage({ type: 'success', text: `诊断包已导出：${result.path ?? ''}` });
      } else {
        setMessage({ type: 'error', text: result.error || '诊断包导出失败' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="card settings-card" data-testid="settings-diagnostics-card">
      <div className="card-title">诊断</div>
      <div style={{ marginBottom: '0.75rem', color: 'var(--ink-2)', fontSize: 13 }}>
        导出运行日志与脱敏统计（版本/平台/各表行数），用于排查问题。不含题库内容、图片资产、登录态与密钥。
      </div>
      <button
        className="btn"
        data-testid="settings-diagnostics-export"
        onClick={() => void handleExport()}
        disabled={exporting}
      >
        {exporting ? '导出中...' : '导出诊断包'}
      </button>
      <MessageBanner message={message} />
    </div>
  );
}

// ==================== 0071（R-043）：数据保存位置卡（不默认存 C 盘） ====================
// 桥取用同 DiagnosticsCard：渲染时从 window 读 __mofangDataLocation，无桥（浏览器 demo/测试）整卡不渲染。
// 语义：位置变更一律「重启后迁移」——本进程不热切换；目标必须是空目录或不存在的路径（校验在主进程）；
// 迁移前自动出一份完整备份、旧位置与备份都保留（用户自删），失败则继续用旧位置启动。
const DATA_LOCATION_SOURCE_LABEL: Record<DataLocationInfo['source'], string> = {
  config: '自定义位置',
  portable: '便携版（exe 旁）',
  default: '系统默认位置',
};

function DataLocationCard() {
  const bridge = window.__mofangDataLocation;
  const [info, setInfo] = useState<DataLocationInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [message, setMessage] = useState<PageMessage | null>(null);

  const refresh = async () => {
    if (!bridge || typeof bridge.get !== 'function') return;
    try {
      setInfo(await bridge.get());
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  };

  useEffect(() => {
    void refresh();
    // 仅挂载时读一次（位置变更需重启生效，本进程内不会自变）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!bridge || typeof bridge.get !== 'function') return null;

  const handleChange = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await bridge.change();
      if (result.canceled) return; // 用户取消：无变更即无提示
      if (result.success) {
        setMessage({
          type: 'success',
          text: `已登记：重启应用后把数据迁移到 ${result.pendingDataRoot ?? ''}（迁移前会自动备份，旧位置保留）`,
        });
        await refresh();
      } else {
        setMessage({ type: 'error', text: result.error || '更改数据保存位置失败' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const handleCancel = async () => {
    setCanceling(true);
    setMessage(null);
    try {
      const result = await bridge.cancel();
      if (result.success) {
        setMessage({ type: 'success', text: '已取消待迁移，数据继续保存在当前位置' });
        await refresh();
      } else {
        setMessage({ type: 'error', text: result.error || '取消失败' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setCanceling(false);
    }
  };

  return (
    <div className="card settings-card" data-testid="settings-data-location-card">
      <div className="card-title">数据保存位置</div>
      <div style={{ marginBottom: '0.5rem', color: 'var(--ink-2)', fontSize: 13 }}>
        题库、图片与本应用的数据都保存在下面的位置（默认在系统用户目录）。
        <br />
        更改后需重启应用完成迁移：迁移前会自动生成一份完整备份，原位置与备份都会保留（可确认无误后自行清理）。
        目标目录需为空目录或不存在的路径。
      </div>
      <div style={{ marginBottom: '0.75rem', fontSize: 13 }} data-testid="settings-data-location-current">
        当前：{info ? info.userDataPath : '读取中…'}
        {info && <span style={{ color: 'var(--ink-2)' }}>（{DATA_LOCATION_SOURCE_LABEL[info.source]}）</span>}
      </div>
      {info?.pendingDataRoot && (
        <div
          style={{ marginBottom: '0.75rem', fontSize: 13, color: 'var(--brick)' }}
          data-testid="settings-data-location-pending"
        >
          已登记：重启应用后迁移到 {info.pendingDataRoot}
        </div>
      )}
      {info?.lastMigrationError && (
        <div
          style={{ marginBottom: '0.75rem', fontSize: 13, color: 'var(--brick)' }}
          data-testid="settings-data-location-last-error"
        >
          上次迁移未完成（仍使用当前位置）：{info.lastMigrationError}
        </div>
      )}
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button
          className="btn"
          data-testid="settings-data-location-change"
          onClick={() => void handleChange()}
          disabled={busy}
        >
          {busy ? '处理中...' : '更改…'}
        </button>
        {info?.pendingDataRoot && (
          <button
            className="btn"
            data-testid="settings-data-location-cancel"
            onClick={() => void handleCancel()}
            disabled={canceling}
          >
            {canceling ? '处理中...' : '取消迁移'}
          </button>
        )}
      </div>
      <MessageBanner message={message} />
    </div>
  );
}

// ==================== 0072（R-073 / D-088）：关于卡更新区 ====================
// 桥取用同 DiagnosticsCard：渲染时从 window 读 __mofangUpdate；无桥、或 dev/自动化态通道未接线
//（getStatus reject）都不渲染——关于卡其余照旧。状态经 onStatus 订阅实时跟随（主进程每次变化推全量快照）。
// 口径：慢速提示非阻塞（下载不自动停）；失败仅在用户主动检查后的本轮可见（status.manual，主进程判）；
// 手动下载目标 = announce.downloadUrl 动态下发，缺省发布页（update.openExternal 出口，http(s) 校验在主进程）。
function UpdateArea() {
  const bridge = window.__mofangUpdate;
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!bridge) return undefined;
    let alive = true;
    bridge
      .getStatus()
      .then((s) => {
        if (!alive) return;
        setAvailable(true);
        setStatus(s);
      })
      .catch(() => {
        /* 通道未接线（dev/自动化运行）——更新区不渲染，同无桥口径 */
      });
    const announce = window.__mofangAnnounce;
    if (announce) {
      announce
        .get()
        .then((s) => {
          if (alive) setDownloadUrl(s.data.downloadUrl ?? null);
        })
        .catch(() => {
          /* 公告不可得 → 手动下载落发布页缺省 */
        });
    }
    const off = bridge.onStatus((s) => {
      if (alive) setStatus(s);
    });
    return () => {
      alive = false;
      off();
    };
  }, [bridge]);

  if (!bridge || !available || status === null) return null;

  const handleCheckNow = async (): Promise<void> => {
    setBusy(true);
    try {
      await bridge.checkNow();
    } catch {
      /* 检查结果经 onStatus 回流（错误在主进程已记 app.log） */
    } finally {
      setBusy(false);
    }
  };

  const targetUrl = downloadUrl ?? MF_RELEASE_PAGE_URL;

  let stateView: ReactElement;
  switch (status.phase) {
    case 'checking':
      stateView = <span>检查中…</span>;
      break;
    case 'not-available':
      stateView = <span>已是最新版本</span>;
      break;
    case 'available':
      stateView = (
        <span>
          发现新版本 v{status.version ?? ''}
          <a
            data-testid="settings-update-manual-download"
            href={targetUrl}
            style={{ marginLeft: '0.5rem' }}
            onClick={(e) => {
              e.preventDefault();
              void bridge.openExternal(targetUrl);
            }}
          >
            手动下载
          </a>
        </span>
      );
      break;
    case 'downloading': {
      const percent = typeof status.percent === 'number' ? Math.max(0, Math.min(100, status.percent)) : 0;
      stateView = (
        <span>
          <span data-testid="settings-update-progress">正在下载更新… {Math.round(percent)}%</span>
          <span
            style={{ display: 'block', height: 6, borderRadius: 3, background: 'var(--paper-deep)', marginTop: 4, maxWidth: 320 }}
          >
            <span
              style={{ display: 'block', height: 6, borderRadius: 3, width: `${percent}%`, background: 'var(--orange)' }}
            />
          </span>
          {status.slowHint && (
            <span
              data-testid="settings-update-slow-hint"
              style={{ display: 'block', marginTop: 4, fontSize: 13, color: 'var(--gold-text)' }}
            >
              网络较慢，可继续等待自动下载，也可改用「手动下载」获取安装包。
            </span>
          )}
        </span>
      );
      break;
    }
    case 'downloaded':
      stateView = (
        <span>
          更新已就绪，重启以完成更新。
          <button
            type="button"
            className="btn"
            data-testid="settings-update-restart"
            style={{ marginLeft: '0.5rem' }}
            onClick={() => bridge.quitAndInstall()}
          >
            立即重启
          </button>
        </span>
      );
      break;
    case 'error':
      // 失败可见性：仅用户主动检查后的本轮（manual）；连续自动检查失败不提示（静默记 app.log）
      stateView =
        status.manual === true ? (
          <span style={{ color: 'var(--st-red)' }}>更新失败：{status.error ?? '未知原因'}</span>
        ) : (
          <span>自动检查未完成，可点「检查更新」再试。</span>
        );
      break;
    default:
      stateView = <span>点「检查更新」查看是否有新版本。</span>;
      break;
  }

  return (
    <div data-testid="settings-update-area" style={{ borderTop: '1px solid var(--line)', marginTop: '0.75rem', paddingTop: '0.75rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn"
          data-testid="settings-update-check"
          onClick={() => void handleCheckNow()}
          disabled={busy || status.phase === 'checking' || status.phase === 'downloading'}
        >
          检查更新
        </button>
        {stateView}
      </div>
      <div style={{ marginTop: '0.5rem', fontSize: 13, color: 'var(--ink-2)' }}>
        更新异常？可在「诊断」卡导出诊断包发给群主，便于定位问题。
      </div>
    </div>
  );
}
