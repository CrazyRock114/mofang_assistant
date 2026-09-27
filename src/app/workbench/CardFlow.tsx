// 0040 P4/P5 右栏：题卡流（待识别卡 / 题卡 / seam 操作条 / 核验提示条 / AI 建议区 / 入库）。
//
// 渲染依据：`recog-workbench-v2 设计稿` 视图二（v4 冻结稿）。
// 编辑器纪律（任务书 §一）：题干/选项/答案/解析一律用 `QuestionEditor`（唯一编辑器，禁引第二套），
// 答案/解析片段进出编辑器包/剥 `<div class="question">` 壳（ProofPage wrapForEditor 同款口径）。
//
// 交互纪律：禁 window.confirm/alert/prompt——二次确认走 ConfirmButton / 应用内弹层。

import { Suspense, lazy, useEffect, useState } from 'react';
import type { WorkbenchCard, WorkbenchTreeSuggestion } from '../../shared/contracts/onestep-types.js';
import type { QuestionEditorApi } from '../../docgen/editor/QuestionEditor.js';
import type { LiveFigurePreview, WarnJumpTarget } from '../pages/WorkbenchPage.js';
import type { PageMessage } from '../pages/ExtUi.js';
import { ConfirmButton, MessageBanner, Modal, ProgressNote } from '../pages/ExtUi.js';
import { verifyWarnings } from '../../recog/onestep/workbench.js';
// 0054（R-045③④）：已采纳知识节点多值——读侧归一（旧草稿单值回落）+ 写侧两字段同步补丁
import { adoptedNodesOf, adoptedNodesPatch } from '../../recog/onestep/workbench.js';
import { unwrapFromEditor, wrapForEditor } from '../../recog/onestep/markdown.js';
// 0057（只增）：题卡 contentHtml 的显示形态 ⇄ 存储形态双侧归一（存储=data-assets 相对引用，
// 编辑器内=file:// 绝对引用——渲染层页面是 file:// 载入，相对引用在编辑器里会裂图）
import { toDisplayHtml, toStoredHtml } from './asset-src.js';
import { getUserDataAssetsRoot } from '../services/paths.js';
import type { TypeOption } from './question-types.js';

const QuestionEditor = lazy(async () => {
  const mod = await import('../../docgen/editor/QuestionEditor.js');
  return { default: mod.QuestionEditor };
});

export interface PendingFrame {
  id: string;
  pageNo: number;
  label: string;
}

export interface CardFlowHandlers {
  onToggleChecked: (cardId: string, checked: boolean) => void;
  onToggleAll: (checked: boolean) => void;
  onPatchCard: (cardId: string, patch: Partial<WorkbenchCard>) => void;
  onRemoveCard: (cardId: string) => void;
  onRetryCard: (cardId: string) => void;
  onCopyFrame: (cardId: string, frameId: string) => void;
  onOpenFrame: (cardId: string, frameId: string) => void;
  onRecognizePending: () => void;
  onRecognizeAll: () => void;
  onSplitCard: (cardId: string) => void;
  onMergeUp: (cardId: string) => void;
  onInsertAfter: (cardId: string) => void;
  onCommitCard: (cardId: string) => void;
  onUncommitCard: (cardId: string) => void;
  /** 0053 目检返工③补：批量纯入库（加篮走 onAddToBasket 弹窗一步完成，与本按钮无关） */
  onBatchCommit: () => void;
  /**
   * 0053 目检返工③补：弹窗「确定」一步完成入库+加篮——
   * `{ paperId }` = 加入选定现有篮；`{ newTitle }` = 新建篮后加入。Promise 结束即编排收敛（弹窗关闭）。
   */
  onAddToBasket: (target: { paperId: string } | { newTitle: string }) => Promise<void> | void;
  /** 0044（只增，可选）：「存为试卷」第二出口（缺省不渲染该按钮——旧调用方零影响） */
  onSaveAsPaper?: () => void;
  onToggleTag: (cardId: string, tag: string) => void;
  onAddTag: (cardId: string, tag: string) => void;
  onAdoptTree: (cardId: string, suggestion: WorkbenchTreeSuggestion) => void;
  onOpenTreePicker: (cardId: string) => void;
  onSuggestTree: (cardId: string) => void;
  /**
   * 0045 P1（只增，可选）：题卡题干编辑器就绪回调（受控插入句柄）。
   * 「📋 复制 → 粘贴」改走该 API 在光标处插图（不再重挂编辑器丢改动）；
   * api=null = 编辑器卸载（卡移除/回退待识别）。缺省不接（旧调用方零影响）。
   */
  onStemEditorReady?: (cardId: string, api: QuestionEditorApi | null) => void;
  /** 0046 P3（只增，可选）：黄条「去处理」点击（页面按告警类别算跳转目标） */
  onWarnFix?: (cardId: string) => void;
  /** 0046 P3（只增，可选）：目标=本卡且 action='answer' 时下发（展开答案区） */
  warnJump?: WarnJumpTarget | null;
  /** 0046 目检返工②（只增，可选）：正在生成知识节点建议的卡 id（行内读条） */
  treeBusyFor?: string | null;
}

interface CardFlowProps extends CardFlowHandlers {
  cards: WorkbenchCard[];
  typeOptions: TypeOption[];
  aiReady: boolean;
  /** 识别设置弹层开关（由页面持有） */
  onOpenSettings: () => void;
  message: PageMessage | null;
  /** 图块拖动中的实时裁图（2026-09-20 目检返工②）；undefined/null = 无实时态 */
  liveFigure?: LiveFigurePreview | null;
  /** 0053 目检返工（只增，可选）：可选试题篮清单（页面从 listPapers 过滤 status='basket'；缺省空） */
  basketOptions?: Array<{ id: string; title: string }>;
}

function questionNoOf(cards: WorkbenchCard[], index: number): number {
  let n = 0;
  for (let i = 0; i <= index; i++) if (cards[i]!.status !== 'pending' && cards[i]!.status !== 'failed' && cards[i]!.status !== 'recognizing') n += 1;
  return n;
}

/** 0053 目检返工②：原生 option 不支持换行，超长篮名截断显示（完整名进 title 悬停提示；消息用全名） */
const BASKET_LABEL_MAX = 16;
function basketLabelOf(title: string): string {
  return title.length > BASKET_LABEL_MAX ? `${title.slice(0, BASKET_LABEL_MAX)}…` : title;
}

/**
 * 拖动中的图块实时刷新（2026-09-20 目检返工②）。
 *
 * 为什么不改 state：题卡编辑器是 lazy + **非受控**（QuestionEditor 只在挂载时读一次内容），
 * 每帧重挂会卡顿并丢光标；所以这里直接改那张图的 DOM，松手时由 onFigureChange 提交权威值
 * （卡片随即重挂，DOM 与文档重新一致）。图节点是 atom + `ignoreMutation: true`，
 * ProseMirror 不会因这次 DOM 改动而报错或回滚。
 */
function useLiveFigure(live: LiveFigurePreview | null | undefined): void {
  useEffect(() => {
    if (!live) return;
    const wrap = document.querySelector(`[data-testid="wb-editor-wrap-${live.cardId}"]`);
    const img = wrap?.querySelectorAll<HTMLImageElement>('figure.diagram img.q-figure')[live.index];
    if (!img) return;
    img.setAttribute('src', live.dataUrl);
    img.style.width = `${live.width}px`;
    img.style.height = `${live.height}px`;
    img.dataset['livePreview'] = '1';
  }, [live]);
}

export function CardFlow(props: CardFlowProps) {
  const {
    cards, typeOptions, aiReady, message, onOpenSettings, liveFigure, basketOptions,
    onToggleChecked, onToggleAll, onPatchCard, onRemoveCard, onRetryCard,
    onCopyFrame, onOpenFrame, onRecognizePending, onRecognizeAll,
    onSplitCard, onMergeUp, onInsertAfter, onCommitCard, onUncommitCard, onBatchCommit, onAddToBasket,
    onSaveAsPaper,
    onToggleTag, onAddTag, onAdoptTree, onOpenTreePicker, onSuggestTree,
    onStemEditorReady, onWarnFix, warnJump, treeBusyFor,
  } = props;

  useLiveFigure(liveFigure);

  // 0053 目检返工③补：加篮弹窗——点「确定」即一步完成入库+加篮（与「存为试卷」弹层同型）；
  // 默认选中「＋ 新建试题篮」（对应存为试卷默认建新卷的语义）；「取消」零动作；工具条「入库」恒为纯入库。
  const [basketPickOpen, setBasketPickOpen] = useState(false);
  /** 弹窗内选择：'__new__' = 新建（默认）/ 其余 = 现有篮 id */
  const [basketChoice, setBasketChoice] = useState<'__new__' | string>('__new__');
  const [newBasketTitle, setNewBasketTitle] = useState('未命名试题篮');
  const [basketBusy, setBasketBusy] = useState(false);

  const pendingCount = cards.filter((c) => c.status === 'pending' || c.status === 'failed').length;
  const checkedCount = cards.filter((c) => c.checked && c.status === 'question').length;
  const selectableCards = cards.filter((c) => c.status === 'question');
  const allChecked = selectableCards.length > 0 && checkedCount === selectableCards.length;

  return (
    <div className="wb-col" data-testid="wb-cards-col">
      {/* 0046 P2：全选 + 批量操作一组靠左；低频（存草稿/存为试卷）靠右弱化，唯一主色=批量入库 */}
      <div className="wb-cards-tools">
        <input
          type="checkbox"
          data-testid="wb-select-all"
          aria-label="全选"
          checked={allChecked}
          onChange={(e) => onToggleAll(e.target.checked)}
        />
        <span>全选 · 已选 <b className="wb-cnt" data-testid="wb-selected-count">{checkedCount}</b> 题</span>
        {pendingCount > 0 && (
          <button type="button" className="btn btn-ghost btn-sm" data-testid="wb-recognize-all" onClick={onRecognizeAll}>
            ▶ 识别全部待识别（<span data-testid="wb-pending-count">{pendingCount}</span>）
          </button>
        )}
        <span className="wb-sp" />
        {/* 0044（只增）：第二出口「存为试卷」——0046 P2 降为次按钮（工具条唯一主色=入库）；0053 返工③去箭头与题数 */}
        {onSaveAsPaper && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            data-testid="wb-save-as-paper"
            disabled={checkedCount === 0}
            onClick={onSaveAsPaper}
          >
            存为试卷
          </button>
        )}
        {/* 0053 目检返工③补：点「加入试题篮」弹窗选篮，弹窗内「确定」一步完成入库+加篮；工具条「入库」恒为纯入库 */}
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          data-testid="wb-add-to-basket"
          disabled={checkedCount === 0}
          onClick={() => { setBasketChoice('__new__'); setBasketPickOpen(true); }}
        >
          加入试题篮
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          data-testid="wb-batch-commit"
          disabled={checkedCount === 0}
          onClick={onBatchCommit}
        >
          入库（{checkedCount}）
        </button>
      </div>

      <MessageBanner message={message} />

      <div data-testid="wb-card-flow">
        {cards.length === 0 && (
          <div className="wb-empty" data-testid="wb-cards-empty">
            还没有题卡：左栏「✂ 手动框选」框出题目区域，或点顶部
            {aiReady ? '「✨ AI 一键录入」' : '（配置推理模型后可 AI 一键录入）'}
            ，也可以直接
            <button type="button" className="wb-link" onClick={onOpenSettings}>切换识别设置</button>。
          </div>
        )}

        {cards.map((card, index) => {
          const isPending = card.status === 'pending' || card.status === 'failed' || card.status === 'recognizing';
          return (
            <div key={card.id}>
              {isPending ? (
                <PendingCardView
                  card={card}
                  onRemove={() => onRemoveCard(card.id)}
                  onRetry={() => onRetryCard(card.id)}
                  onCopyFrame={(frameId) => onCopyFrame(card.id, frameId)}
                  onOpenFrame={(frameId) => onOpenFrame(card.id, frameId)}
                />
              ) : (
                <QuestionCardView
                  card={card}
                  index={questionNoOf(cards, index)}
                  typeOptions={typeOptions}
                  aiReady={aiReady}
                  onPatch={(patch) => onPatchCard(card.id, patch)}
                  onRemove={() => onRemoveCard(card.id)}
                  onCommit={() => onCommitCard(card.id)}
                  onUncommit={() => onUncommitCard(card.id)}
                  onToggleTag={(tag) => onToggleTag(card.id, tag)}
                  onAddTag={(tag) => onAddTag(card.id, tag)}
                  onAdoptTree={(s) => onAdoptTree(card.id, s)}
                  onOpenTreePicker={() => onOpenTreePicker(card.id)}
                  onSuggestTree={() => onSuggestTree(card.id)}
                  onToggleChecked={(checked) => onToggleChecked(card.id, checked)}
                  onStemEditorReady={onStemEditorReady ? (api) => onStemEditorReady(card.id, api) : undefined}
                  onWarnFix={onWarnFix ? () => onWarnFix(card.id) : undefined}
                  warnJump={warnJump && warnJump.cardId === card.id ? warnJump : null}
                  treeBusy={treeBusyFor === card.id}
                />
              )}
              <div className="wb-seam" data-testid={`wb-seam-${card.id}`}>
                <span className="wb-seam-line" />
                {!isPending && (
                  <>
                    <button type="button" data-testid={`wb-split-${card.id}`} onClick={() => onSplitCard(card.id)}>✂ 拆成两题</button>
                    <button type="button" data-testid={`wb-merge-up-${card.id}`} onClick={() => onMergeUp(card.id)}>↑ 并入上一题</button>
                  </>
                )}
                <button type="button" data-testid={`wb-insert-${card.id}`} onClick={() => onInsertAfter(card.id)}>+ 插入空题</button>
                <span className="wb-seam-line" />
              </div>
            </div>
          );
        })}
      </div>

      {/* 0053 目检返工③补：加入试题篮弹窗——新建（默认选中，命名）/ 现有篮（列表滚动+超长截断+悬停全名）；
          「确定」一步完成入库+加篮，「取消」零动作 */}
      {basketPickOpen && (
        <Modal title="加入试题篮" onClose={() => { if (!basketBusy) setBasketPickOpen(false); }}>
          <div data-testid="wb-basket-picker">
            <label className="wb-basket-row">
              <input
                type="radio"
                name="wb-basket-pick"
                data-testid="wb-basket-opt-new"
                checked={basketChoice === '__new__'}
                onChange={() => setBasketChoice('__new__')}
              />
              ＋ 新建试题篮…
            </label>
            {basketChoice === '__new__' && (
              <input
                className="wb-basket-name wb-basket-new"
                data-testid="wb-basket-new-name"
                value={newBasketTitle}
                placeholder="试题篮名称"
                onChange={(e) => setNewBasketTitle(e.target.value)}
              />
            )}
            {(basketOptions ?? []).length > 0 && (
              <div className="wb-basket-list" data-testid="wb-basket-list">
                {(basketOptions ?? []).map((b) => (
                  <label key={b.id} className="wb-basket-row" data-testid={`wb-basket-opt-${b.id}`} title={b.title}>
                    <input
                      type="radio"
                      name="wb-basket-pick"
                      checked={basketChoice === b.id}
                      onChange={() => setBasketChoice(b.id)}
                    />
                    <span className="wb-basket-row-title">{basketLabelOf(b.title)}</span>
                  </label>
                ))}
              </div>
            )}
            <div className="wb-basket-foot">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                data-testid="wb-basket-cancel"
                disabled={basketBusy}
                onClick={() => setBasketPickOpen(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                data-testid="wb-basket-apply"
                disabled={basketBusy}
                onClick={() => {
                  setBasketBusy(true);
                  void (async () => {
                    await onAddToBasket(basketChoice === '__new__'
                      ? { newTitle: newBasketTitle.trim() || '未命名试题篮' }
                      : { paperId: basketChoice });
                    setBasketBusy(false);
                    setBasketPickOpen(false);
                  })();
                }}
              >
                确定
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ==================== 待识别卡（手动框选产物） ====================

function PendingCardView({ card, onRemove, onRetry, onCopyFrame, onOpenFrame }: {
  card: WorkbenchCard;
  onRemove: () => void;
  onRetry: () => void;
  onCopyFrame: (frameId: string) => void;
  onOpenFrame: (frameId: string) => void;
}) {
  const recognizing = card.status === 'recognizing';
  return (
    <div className={card.status === 'failed' ? 'wb-qcard pending failed' : 'wb-qcard pending'} data-testid={`wb-card-${card.id}`} data-status={card.status}>
      <div className="wb-q-head">
        <input type="checkbox" disabled aria-label="待识别卡不可勾选" />
        <span className="wb-q-no">待识别</span>
        <span className="wb-muted wb-mini">手动框选 · {card.frames.length} 张框选图</span>
        <span className="wb-sp" />
        <button type="button" className="wb-mini-btn" data-testid={`wb-remove-${card.id}`} onClick={onRemove}>移除</button>
      </div>
      {card.status === 'failed' && card.error !== null && (
        <div className="wb-q-err" data-testid={`wb-error-${card.id}`}>✕ 识别失败：{card.error}。已回退为待识别，可修改后重试。</div>
      )}
      {recognizing ? (
        <>
          {/* 0046 P1.1：统一读条（theme.css progress-shell，消灭自造条；保留阶段文案） */}
          <ProgressNote
            label={card.source === 'semi' ? 'OCR 识别中：文字公式 + 结构整理' : 'AI 识别中：文字公式 · 结构 · 图块 · 标签/知识节点建议'}
            testid={`wb-prog-${card.id}`}
          />
        </>
      ) : (
        <>
          <div className="wb-q-body">
            <div className="wb-pend-thumbs">
              {card.frames.map((frame, i) => (
                <div key={frame.id} className="wb-pend-thumb" data-testid={`wb-thumb-${card.id}-${i}`} onClick={() => onOpenFrame(frame.id)}>
                  <div>框选 {i + 1}</div>
                  <div className="wb-muted wb-mini">第 {frame.pageNo} 页</div>
                  <button
                    type="button"
                    className="wb-link"
                    data-testid={`wb-thumb-copy-${card.id}-${i}`}
                    onClick={(e) => { e.stopPropagation(); onCopyFrame(frame.id); }}
                  >
                    📋 复制
                  </button>
                </div>
              ))}
            </div>
          </div>
          <div className="wb-pend-act">
            <button type="button" className="btn btn-primary btn-sm" data-testid={`wb-recognize-${card.id}`} onClick={onRetry}>▶ 识别</button>
            <span className="wb-muted wb-mini">点击快照可放大 · 也可顶部一键批量识别</span>
          </div>
        </>
      )}
    </div>
  );
}

// ==================== 题卡 ====================

function QuestionCardView({
  card, index, typeOptions, aiReady, onPatch, onRemove, onCommit, onUncommit,
  onToggleTag, onAddTag, onAdoptTree, onOpenTreePicker, onSuggestTree, onToggleChecked, onStemEditorReady,
  onWarnFix, warnJump, treeBusy,
}: {
  card: WorkbenchCard;
  index: number;
  typeOptions: TypeOption[];
  aiReady: boolean;
  onPatch: (patch: Partial<WorkbenchCard>) => void;
  onRemove: () => void;
  onCommit: () => void;
  onUncommit: () => void;
  onToggleTag: (tag: string) => void;
  onAddTag: (tag: string) => void;
  onAdoptTree: (s: WorkbenchTreeSuggestion) => void;
  onOpenTreePicker: () => void;
  onSuggestTree: () => void;
  onToggleChecked: (checked: boolean) => void;
  /** 0045 P1（可选）：题干编辑器受控插入句柄上抛 */
  onStemEditorReady?: (api: QuestionEditorApi | null) => void;
  /** 0046 P3（可选）：黄条「去处理」 */
  onWarnFix?: () => void;
  /** 0046 P3（可选）：answer 类跳转目标（展开答案区；seq 变化重复触发） */
  warnJump?: WarnJumpTarget | null;
  /** 0046 目检返工②（可选）：挂树建议生成中（读条替代建议按钮行） */
  treeBusy?: boolean;
}) {
  const committed = card.status === 'committed';
  const [answerOpen, setAnswerOpen] = useState(false);
  const [tagDraft, setTagDraft] = useState('');
  const warnings = verifyWarnings(card);
  const knownTypes = new Set(typeOptions.map((o) => o.value));
  const typeValue = knownTypes.has(card.typeCode) ? card.typeCode : '';
  /** 0057：资产根（null=浏览器 demo/测试——两侧归一自动退化为恒等，行为与改动前一致） */
  const assetsRoot = getUserDataAssetsRoot();
  // 0054（R-045③）：已采纳知识节点（多值；旧草稿单值经 adoptedNodesOf 归一）
  const adoptedNodes = adoptedNodesOf(card);
  // 建议 chips 只列「尚未采纳」的候选（已采纳的同节点不出第二个可点项；取消后自动复现）
  const openSuggestions = card.treeSuggestions.filter((s) => !adoptedNodes.some((n) => n.nodeId === s.nodeId));

  // 0046 P3：黄条「去处理」→ 展开答案区并滚动可见（编辑器 lazy，滚动目标在展开渲染后尽力找）
  useEffect(() => {
    if (!warnJump || warnJump.action !== 'answer') return;
    setAnswerOpen(true);
    const timer = setTimeout(() => {
      const area = document.querySelector(`[data-testid="wb-ans-area-${card.id}"]`);
      area?.scrollIntoView?.({ block: 'center' });
    }, 60);
    return () => clearTimeout(timer);
  }, [warnJump, card.id]);

  return (
    <div
      className={[
        'wb-qcard',
        committed ? 'committed' : '',
        card.checked && !committed ? 'checked' : '',
      ].filter(Boolean).join(' ')}
      data-testid={`wb-card-${card.id}`}
      data-status={card.status}
      data-committed={committed ? '1' : '0'}
    >
      <div className="wb-q-head">
        <input
          type="checkbox"
          aria-label="选中此题"
          data-testid={`wb-check-${card.id}`}
          checked={card.checked && !committed}
          disabled={committed}
          onChange={(e) => onToggleChecked(e.target.checked)}
        />
        <span className="wb-q-no" data-testid={`wb-qno-${card.id}`}>第 {index} 题</span>
        <select
          className="wb-q-type"
          aria-label="题型"
          data-testid={`wb-type-${card.id}`}
          value={typeValue}
          disabled={committed}
          onChange={(e) => onPatch({ typeCode: e.target.value })}
        >
          <option value="">题型未定</option>
          {typeOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <span className="wb-muted wb-mini">
          {card.qno ? `原卷题号 ${card.qno}` : card.frames.length > 0 ? `来源：手动框选（第 ${card.frames[0]!.pageNo} 页）` : '来源：AI 识别'}
        </span>
        <span className="wb-sp" />
        {committed
          ? <ConfirmButton testid={`wb-uncommit-${card.id}`} label="撤销入库" confirmLabel="确认撤销？" onConfirm={onUncommit} />
          : <button type="button" className="wb-mini-btn" data-testid={`wb-remove-${card.id}`} onClick={onRemove}>删除</button>}
      </div>

      {warnings.length > 0 && !committed && (
        <div className="wb-q-warn" data-testid={`wb-warn-${card.id}`}>
          <span className="wb-q-warn-text">⚠️ {warnings.join('；')}</span>
          {/* 0046 P3：设计稿 .q-warn .fix 落地——按告警类别跳转（答案区/左栏图块定位） */}
          {onWarnFix && (
            <button type="button" className="wb-warn-fix" data-testid={`wb-warn-fix-${card.id}`} onClick={onWarnFix}>
              去处理
            </button>
          )}
        </div>
      )}

      <div className="wb-q-body">
        <div className="wb-sec-label">题干（图文同窗口，图可拖动调位；支持粘贴框选图）</div>
        <div className="wb-wysiwyg" data-testid={`wb-editor-wrap-${card.id}`}>
          <Suspense fallback={<div className="wb-muted wb-mini">编辑器加载中…</div>}>
            <QuestionEditor
              ref={onStemEditorReady ?? undefined}
              variant="stem"
              initialContent={toDisplayHtml(card.contentHtml, assetsRoot)}
              onSave={(html) => onPatch({ contentHtml: toStoredHtml(html, assetsRoot) })}
            />
          </Suspense>
        </div>

        <button
          type="button"
          className="wb-ans-toggle"
          data-testid={`wb-ans-toggle-${card.id}`}
          aria-expanded={answerOpen}
          onClick={() => setAnswerOpen((v) => !v)}
        >
          {answerOpen ? '▾' : '▸'} 答案 / 解析{card.answerHtml === '' && card.analysisHtml === '' ? '（空 · 点击补充）' : '（已识别）'}
        </button>
        {answerOpen && (
          <div className="wb-ans-area" data-testid={`wb-ans-area-${card.id}`}>
            <div className="wb-sec-label">答案</div>
            <div className="wb-wysiwyg">
              <Suspense fallback={null}>
                <QuestionEditor variant="plain" initialContent={wrapForEditor(card.answerHtml)} onSave={(html) => onPatch({ answerHtml: unwrapFromEditor(html) })} />
              </Suspense>
            </div>
            <div className="wb-sec-label">解析</div>
            <div className="wb-wysiwyg">
              <Suspense fallback={null}>
                <QuestionEditor variant="plain" initialContent={wrapForEditor(card.analysisHtml)} onSave={(html) => onPatch({ analysisHtml: unwrapFromEditor(html) })} />
              </Suspense>
            </div>
          </div>
        )}
      </div>

      {/* AI 建议区：点一下采纳，不点不入库（P-07） */}
      <div className="wb-ai-zone" data-testid={`wb-ai-zone-${card.id}`} style={aiReady ? undefined : { display: 'none' }}>
        <div className="wb-az-title"><span className="wb-dot" />AI 建议 · 点一下采纳，不点不入库</div>
        <div className="wb-ai-row">
          <span className="wb-rl">标签</span>
          {card.tags.map((tag) => (
            <button
              key={tag}
              type="button"
              className={card.adoptedTags.includes(tag) ? 'wb-chip wb-chip-tag ok' : 'wb-chip wb-chip-tag'}
              data-testid={`wb-tag-${card.id}-${tag}`}
              aria-pressed={card.adoptedTags.includes(tag)}
              onClick={() => onToggleTag(tag)}
            >
              {tag}
            </button>
          ))}
          {card.tags.length === 0 && <span className="wb-muted wb-mini">无标签建议</span>}
          <input
            className="wb-chip-input"
            placeholder="+ 手动加"
            aria-label="手动加标签"
            data-testid={`wb-tag-input-${card.id}`}
            value={tagDraft}
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              const value = tagDraft.trim();
              if (value) onAddTag(value);
              setTagDraft('');
            }}
          />
        </div>
        {treeBusy ? (
          /* 0046 目检返工②：秒级 AI 调用期间给统一读条（原「出知识节点建议」零反馈） */
          <ProgressNote label="知识节点建议生成中…" testid={`wb-tree-prog-${card.id}`} />
        ) : (
          <div className="wb-ai-row">
            <span className="wb-rl">知识节点</span>
            {adoptedNodes.length > 0 && (
              /* 0054 R-045③：已采纳组容器（保号 testid）+ 组内每节点一个可单独取消的 chip */
              <span
                data-testid={`wb-tree-adopted-${card.id}`}
                style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 7 }}
              >
                {adoptedNodes.map((node) => (
                  <button
                    key={node.nodeId}
                    type="button"
                    className="wb-chip wb-chip-tree ok"
                    data-testid={`wb-tree-adopted-${card.id}-${node.nodeId}`}
                    onClick={() => onPatch({ ...adoptedNodesPatch(adoptedNodes.filter((n) => n.nodeId !== node.nodeId)) })}
                    title="再点一次取消采纳"
                  >
                    {node.label}
                  </button>
                ))}
              </span>
            )}
            {openSuggestions.map((s) => (
              <button
                key={s.nodeId}
                type="button"
                className="wb-chip wb-chip-tree"
                data-testid={`wb-tree-suggest-${card.id}-${s.nodeId}`}
                onClick={() => onAdoptTree(s)}
              >
                {s.label}
              </button>
            ))}
            {card.treeSuggestions.length === 0 && (
              <button type="button" className="wb-chip wb-chip-add" data-testid={`wb-tree-suggest-btn-${card.id}`} onClick={onSuggestTree}>
                ✨ 出知识节点建议
              </button>
            )}
            <button type="button" className="wb-chip wb-chip-add" data-testid={`wb-tree-picker-${card.id}`} onClick={onOpenTreePicker}>
              + 手动加节点
            </button>
            {card.treeSuggestions.length > 0 && (
              <span className="wb-ai-note" data-testid={`wb-tree-conf-${card.id}`}>
                置信 {card.treeSuggestions[0]!.confidence === null ? '—' : card.treeSuggestions[0]!.confidence!.toFixed(2)}
                {card.treeSuggestions[0]!.confidence !== null && card.treeSuggestions[0]!.confidence! < 0.75 ? ' · 偏低，建议人工看一眼' : ''}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="wb-q-foot">
        {committed ? (
          <span className="wb-done-tag" data-testid={`wb-committed-${card.id}`}>
            ✓ 已入库 · 题卡已锁定（随题写入：标签 ×{card.adoptedTags.length} · 知识节点 ×{adoptedNodes.length}）
          </span>
        ) : (
          <>
            <span className="wb-muted wb-mini">采纳的标签/知识节点随入库写入；未采纳不写</span>
            <span className="wb-sp" />
            <button type="button" className="btn btn-green btn-sm" data-testid={`wb-commit-${card.id}`} onClick={onCommit}>
              入库此题 →
            </button>
          </>
        )}
      </div>
    </div>
  );
}
