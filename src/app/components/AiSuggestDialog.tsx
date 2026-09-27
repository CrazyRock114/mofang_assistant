// 0029：AI 知识节点/打标建议人确认弹层（题库页批量入口 + 录题侧最小入口共用）。
//
// P-07 铁律：本组件是 AI 建议的**唯一写入闸门**——建议全部默认呈现、逐条可接受/拒绝（部分接受可），
// 点击「确认写入」才经既有通道落库（知识节点=ext.tree.linkQuestion，打标=bank.addTag）；
// 校验失败/无法归属条目只进「未采信」区，永不写入。
// 空锚点（P-11）禁放行：建议钮置灰并引导先采集；AI 不可用明示原因（P-3），不静默不隐藏。
//
// 2026-09-23 目检反馈（呈现层重做）：
//   - 标签与知识节点**同页呈现**，两行都按录题页的 chips 口径（点一下选中/取消，无勾选框）；
//   - 标签可手动输入、知识节点可走树选择弹层，手动增项与 AI 建议同列、同样要人确认才写入；
//   - AI 调用期间给统一动画读条（progress-shell）；
//   - 文字求干净（第一轮）：注入口径/token/warnings/未采信原文先收进折叠块；
//     第二轮按用户口径**整块移除**（含顶部说明行），底部只剩「取消 / 确认写入」。

import { useEffect, useMemo, useState } from 'react';
import type { AnchorQuery } from '../../shared/contracts/ai-anchor.js';
import type { BankService, BankExtServices } from '../../shared/contracts/bank-types.js';
import type { MofangAiBridge } from '../../shared/contracts/bridge.js';
import type { AiAnchorStatusResult, AiSuggestResult, AiTagSuggestion, AiTreeSuggestion } from '../../shared/contracts/ai-suggest-types.js';
import { createBankService } from '../services/BankServiceFactory.js';
import { createBankExtServices } from '../services/BankExtServiceFactory.js';
import { createAiServices } from '../services/AiServiceFactory.js';
import { useStageSubject } from '../state/use-stage-subject.js';
import type { PageMessage } from '../pages/ExtUi.js';
import { Modal, ProgressNote } from '../pages/ExtUi.js';
import { TreePickerModal, type TreePickerSelection } from '../workbench/TreePickerModal.js';

export interface AiSuggestDialogProps {
  questionIds: string[];
  onClose: () => void;
  /** 确认写入成功后回调（题库页刷新列表；录题侧刷新入库徽标） */
  onWritten?: () => void;
  /** 写入结果消息（宿主页面消息条展示；不传则弹层内自显） */
  onMessage?: (message: PageMessage) => void;
  /** 注入优先（测试双跑）；缺省按环境取工厂 */
  bank?: BankService;
  ext?: BankExtServices;
  ai?: MofangAiBridge;
  /** 学段-学科定格覆盖（录题侧传页面学科）；缺省=共享状态（题库页顶栏单真源） */
  query?: AnchorQuery;
  /** 学科显示名（手动加节点的树选择弹层过滤用；缺省留空） */
  subjectLabel?: string;
}

/** 待写入的知识节点条目（AI 建议 + 手动添加同一列表；source 只影响展示口径） */
interface PendingNode {
  questionId: string;
  nodeId: string;
  label: string;
  confidence: number | null;
  source: 'ai' | 'manual';
}

/** 待写入的标签条目（同上） */
interface PendingTag {
  questionId: string;
  tag: string;
  source: 'ai' | 'manual';
}

const nodeKey = (n: { questionId: string; nodeId: string }): string => `${n.questionId}:${n.nodeId}`;
const tagKey = (t: { questionId: string; tag: string }): string => `${t.questionId}:${t.tag}`;

/** 题干摘要（弹层展示用；与注入纯文本同手法但不限量） */
function excerpt(html: string, max = 48): string {
  const text = html
    .replace(/<[^>]*\sdata-tex="([^"]*)"[^>]*>/g, (_m, tex: string) => `$${tex}$`)
    .replace(/<[^>]+>/g, '')
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (m) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' }[m] ?? m))
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** AI 节点建议 → 待写入条目 */
function toPendingNodes(questionId: string, items: AiTreeSuggestion[]): PendingNode[] {
  return items.map((s) => ({
    questionId, nodeId: s.targetId, label: s.targetLabel, confidence: s.confidence ?? null, source: 'ai' as const,
  }));
}

function toPendingTags(questionId: string, items: AiTagSuggestion[]): PendingTag[] {
  return items.map((t) => ({ questionId, tag: t.tag, source: 'ai' as const }));
}

export function AiSuggestDialog(props: AiSuggestDialogProps) {
  const { questionIds, onClose, onWritten, onMessage, subjectLabel } = props;
  const bankSvc = useMemo(() => props.bank ?? createBankService(), [props.bank]);
  const extSvc = useMemo(() => props.ext ?? createBankExtServices(), [props.ext]);
  const aiSvc = useMemo(() => props.ai ?? createAiServices(), [props.ai]);
  const stageSubject = useStageSubject();
  const effectiveQuery: AnchorQuery = props.query ?? {
    ...(stageSubject.stage ? { stage: stageSubject.stage } : {}),
    subjectId: stageSubject.subjectId,
  };

  const [status, setStatus] = useState<AiAnchorStatusResult | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [treeResult, setTreeResult] = useState<AiSuggestResult | null>(null);
  const [tagResult, setTagResult] = useState<AiSuggestResult | null>(null);
  const [excerpts, setExcerpts] = useState<Record<string, string>>({});
  /** AI 建议条目（每次调用结果整批替换；手动增项另存，见 manualNodes/manualTags） */
  const [aiNodes, setAiNodes] = useState<PendingNode[]>([]);
  const [aiTags, setAiTags] = useState<PendingTag[]>([]);
  const [manualNodes, setManualNodes] = useState<PendingNode[]>([]);
  const [manualTags, setManualTags] = useState<PendingTag[]>([]);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [keptTags, setKeptTags] = useState<ReadonlySet<string>>(new Set());
  const [tagDraft, setTagDraft] = useState<Record<string, string>>({});
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [running, setRunning] = useState<'tree' | 'tags' | null>(null);
  const [writing, setWriting] = useState(false);

  // 锚点预检 + 题干摘要（挂载期一次；预检不做任何 AI 调用）
  useEffect(() => {
    let cancelled = false;
    if (!effectiveQuery.subjectId) {
      // 未选学科 = P-12 禁放行（IPC 层 subjectId 必填，渲染层先行拦截并引导）
      setStatus({
        status: 'empty-anchor',
        reason: '未选择学科：学段-学科是锚点的定格维度（P-12），请先在顶栏选择学科后再使用 AI 建议',
        meta: {
          stage: effectiveQuery.stage ?? '', subjectId: '', questionCount: 0,
          treeCount: 0, totalNodeCount: 0, injectedNodeCount: 0, truncatedNodeCount: 0, injectedTokens: 0,
        },
        warnings: [],
      });
      return;
    }
    aiSvc.suggest.anchorStatus({ query: effectiveQuery })
      .then((s) => { if (!cancelled) setStatus(s); })
      .catch((err) => { if (!cancelled) setFatal(err instanceof Error ? err.message : String(err)); });
    for (const id of questionIds) {
      bankSvc.getQuestion(id)
        .then((q) => { if (!cancelled && q) setExcerpts((prev) => ({ ...prev, [id]: excerpt(q.stemHtml ?? q.content) })); })
        .catch(() => { /* 摘要失败不影响主流程（题序仍显示） */ });
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const nodes = useMemo(() => [...aiNodes, ...manualNodes], [aiNodes, manualNodes]);
  const tags = useMemo(() => [...aiTags, ...manualTags], [aiTags, manualTags]);

  const runSuggest = (mode: 'tree' | 'tags') => {
    setRunning(mode);
    setFatal(null);
    const call = mode === 'tree' ? aiSvc.suggest.treeLink : aiSvc.suggest.tags;
    call({ questionIds, query: effectiveQuery })
      .then((r) => {
        if (mode === 'tree') {
          setTreeResult(r);
          const next = r.suggestions.flatMap((s) => toPendingNodes(s.questionId, [s]));
          setAiNodes(next);
          // 建议到达即默认全选（人可逐个点掉）
          setPicked((prev) => new Set([...prev, ...next.map(nodeKey)]));
        } else {
          setTagResult(r);
          const next = r.tagSuggestions.flatMap((t) => toPendingTags(t.questionId, [t]));
          setAiTags(next);
          setKeptTags((prev) => new Set([...prev, ...next.map(tagKey)]));
        }
      })
      .catch((err) => { setFatal(err instanceof Error ? err.message : String(err)); })
      .finally(() => { setRunning(null); });
  };

  const toggleNode = (n: PendingNode) => {
    setPicked((prev) => {
      const next = new Set(prev);
      const key = nodeKey(n);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const toggleTag = (t: PendingTag) => {
    setKeptTags((prev) => {
      const next = new Set(prev);
      const key = tagKey(t);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const addManualTag = (questionId: string) => {
    const value = (tagDraft[questionId] ?? '').trim();
    if (!value) return;
    const entry: PendingTag = { questionId, tag: value, source: 'manual' };
    setManualTags((prev) => (prev.some((t) => tagKey(t) === tagKey(entry)) ? prev : [...prev, entry]));
    setKeptTags((prev) => new Set([...prev, tagKey(entry)]));
    setTagDraft((prev) => ({ ...prev, [questionId]: '' }));
  };

  const addManualNode = (questionId: string, selection: TreePickerSelection) => {
    const entry: PendingNode = { questionId, nodeId: selection.nodeId, label: selection.label, confidence: null, source: 'manual' };
    setManualNodes((prev) => (prev.some((n) => nodeKey(n) === nodeKey(entry)) ? prev : [...prev, entry]));
    setPicked((prev) => new Set([...prev, nodeKey(entry)]));
    setPickerFor(null);
  };

  /** 一次确认同时落两类（节点 linkQuestion 逐条 + 标签 addTag 逐条）；未选中的不写（P-07） */
  const confirmWrite = async () => {
    const nodeTargets = nodes.filter((n) => picked.has(nodeKey(n)));
    const tagTargets = tags.filter((t) => keptTags.has(tagKey(t)));
    if (nodeTargets.length === 0 && tagTargets.length === 0) return;
    setWriting(true);
    let okNodes = 0;
    let okTags = 0;
    let failed = 0;
    for (const n of nodeTargets) {
      try {
        await extSvc.tree.linkQuestion(n.questionId, n.nodeId);
        okNodes += 1;
      } catch {
        failed += 1;
      }
    }
    for (const t of tagTargets) {
      try {
        await bankSvc.addTag(t.questionId, t.tag);
        okTags += 1;
      } catch {
        failed += 1;
      }
    }
    onMessage?.({
      type: failed > 0 ? 'error' : 'success',
      text: `已写入：知识节点 ${okNodes} 个、标签 ${okTags} 个` + (failed > 0 ? `（失败 ${failed} 条）` : ''),
    });
    onWritten?.();
    onClose();
  };

  const emptyAnchor = status?.status === 'empty-anchor';
  const busy = running !== null || writing;
  const selectedCount = picked.size + keptTags.size;
  const hasResults = treeResult !== null || tagResult !== null || manualNodes.length > 0 || manualTags.length > 0;

  return (
    <Modal title="AI 建议（知识节点 / 打标）" onClose={onClose}>
      <div data-testid="ai-suggest-dialog" style={{ width: '100%' }}>
        {fatal && (
          <div className="notice notice-red" data-testid="ai-suggest-fatal" style={{ marginBottom: '0.75rem' }}>{fatal}</div>
        )}

        {emptyAnchor && status && (
          <div data-testid="ai-suggest-empty" className="notice notice-red" style={{ marginBottom: '0.75rem' }}>
            <strong>AI 入口不可用（空锚点）：</strong>{status.reason}
            <div style={{ marginTop: 4, color: 'var(--ink-2)' }}>请先到「采集」页采集字典/知识树后再使用 AI 建议。</div>
          </div>
        )}

        {running && (
          <ProgressNote
            label={running === 'tree' ? 'AI 正在读题与知识树，生成知识节点建议…' : 'AI 正在读题，生成标签建议…'}
            testid="ai-suggest-working"
          />
        )}

        {treeResult?.status === 'unavailable' && (
          <div data-testid="ai-suggest-unavailable" className="notice notice-red" style={{ marginBottom: '0.5rem' }}>
            AI 不可用：{treeResult.reason}
          </div>
        )}
        {treeResult?.none && (
          <div data-testid="ai-suggest-none" className="notice" style={{ marginBottom: '0.5rem' }}>
            AI 没在本学科树里找到合适的知识节点。
          </div>
        )}
        {tagResult?.status === 'unavailable' && (
          <div data-testid="ai-suggest-unavailable" className="notice notice-red" style={{ marginBottom: '0.5rem' }}>
            AI 不可用：{tagResult.reason}
          </div>
        )}
        {tagResult?.none && (
          <div data-testid="ai-suggest-none" className="notice" style={{ marginBottom: '0.5rem' }}>
            AI 没给出合适的标签。
          </div>
        )}

        {/* 建议区：每题一段，标签行 + 知识节点行（录题页同款 chips 口径） */}
        {hasResults && questionIds.map((questionId, index) => {
          const qNodes = nodes.filter((n) => n.questionId === questionId);
          const qTags = tags.filter((t) => t.questionId === questionId);
          if (qNodes.length === 0 && qTags.length === 0 && !treeResult && !tagResult) return null;
          return (
            <div key={questionId} data-testid={`ai-suggest-q-${questionId}`} className="wb-ai-zone" style={{ margin: '0 0 0.6rem' }}>
              <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: 8 }}>
                第 {index + 1} 题 · {excerpts[questionId] ?? '（题干加载中）'}
              </div>

              <div className="wb-ai-row">
                <span className="wb-rl">标签</span>
                {qTags.map((t) => (
                  <button
                    key={tagKey(t)}
                    type="button"
                    className={keptTags.has(tagKey(t)) ? 'wb-chip wb-chip-tag ok' : 'wb-chip wb-chip-tag'}
                    data-testid={`ai-suggest-tag-${t.questionId}-${t.tag}`}
                    aria-pressed={keptTags.has(tagKey(t))}
                    disabled={busy}
                    onClick={() => toggleTag(t)}
                  >
                    {t.tag}
                  </button>
                ))}
                {tagResult !== null && qTags.length === 0 && !tagResult.none && (
                  <span className="wb-muted wb-mini">模型未给标签建议</span>
                )}
                <input
                  className="wb-chip-input"
                  placeholder="+ 手动加"
                  aria-label="手动加标签"
                  data-testid={`ai-suggest-tag-input-${questionId}`}
                  value={tagDraft[questionId] ?? ''}
                  disabled={busy}
                  onChange={(e) => setTagDraft((prev) => ({ ...prev, [questionId]: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === 'Enter') addManualTag(questionId); }}
                />
              </div>

              <div className="wb-ai-row">
                <span className="wb-rl">知识节点</span>
                {qNodes.map((n) => (
                  <button
                    key={nodeKey(n)}
                    type="button"
                    className={picked.has(nodeKey(n)) ? 'wb-chip wb-chip-tree ok' : 'wb-chip wb-chip-tree'}
                    data-testid={`ai-suggest-item-${n.questionId}-${n.nodeId}`}
                    aria-pressed={picked.has(nodeKey(n))}
                    title={n.confidence === null ? '手动添加' : `AI 置信 ${Math.round(n.confidence * 100)}%`}
                    disabled={busy}
                    onClick={() => toggleNode(n)}
                  >
                    {n.label}
                  </button>
                ))}
                {treeResult !== null && qNodes.length === 0 && !treeResult.none && (
                  <span className="wb-muted wb-mini">模型未给节点建议</span>
                )}
                <button
                  type="button"
                  className="wb-chip wb-chip-add"
                  data-testid={`ai-suggest-node-pick-${questionId}`}
                  disabled={busy}
                  onClick={() => setPickerFor(questionId)}
                >
                  + 手动加节点
                </button>
              </div>
            </div>
          );
        })}

        {/* 两条建议入口（未生成/想重出时点；建议到齐后可继续点掉不需要的）。
            P-11：空锚点时钮置灰但**仍可见**（引导先采集，不隐藏功能面）。 */}
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
          <button className="btn" data-testid="ai-suggest-tags-btn" disabled={busy || emptyAnchor} onClick={() => runSuggest('tags')}>
            {tagResult === null ? 'AI 出标签建议' : '重出标签建议'}
          </button>
          <button className="btn" data-testid="ai-suggest-tree-btn" disabled={busy || emptyAnchor} onClick={() => runSuggest('tree')}>
            {treeResult === null ? 'AI 出知识节点建议' : '重出知识节点建议'}
          </button>
        </div>

        {/* 技术信息块已于 2026-09-23 目检反馈第二轮按用户口径整块移除（注入口径 token / warnings /
            未采信原文都不再上屏）。数据仍在 result 里（host 照旧回传，未写入任何条目），
            若后续排查需要，可在本处按同一 result.meta / warnings / drafts 重新挂回。 */}

        {hasResults && (
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '0.75rem' }}>
            <button className="btn" data-testid="ai-suggest-reject" disabled={busy} onClick={onClose}>取消</button>
            <button className="btn btn-primary" data-testid="ai-suggest-confirm" disabled={busy || selectedCount === 0} onClick={() => void confirmWrite()}>
              确认写入（{selectedCount}）
            </button>
          </div>
        )}
      </div>

      {/* 手动加节点：复用录题台的树选择弹层（任意层级可选，确认即加入待写入列表） */}
      {pickerFor && (
        <TreePickerModal
          ext={extSvc}
          stage={effectiveQuery.stage ?? ''}
          subjectId={effectiveQuery.subjectId}
          subjectLabel={subjectLabel ?? ''}
          onClose={() => setPickerFor(null)}
          onConfirm={(selection) => addManualNode(pickerFor, selection)}
        />
      )}
    </Modal>
  );
}
