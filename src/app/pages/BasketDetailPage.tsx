// 0004 Phase 2 + fix-1 C/D/F3：篮详情页（#/basket/:id）——status=basket 卷的题管理。
// 题列表（拖拽排序/设分值/移除/预览渲染同排版间）+ 从题库加题（BankBrowser pick 模式）+
// 新建题（QuestionEditor 弹层）+ 从网络题库加题（跳 #/capture?toBasket=<paperId>&from=basket/<paperId>，
// 0011 §一.5/§一.7）+ 进入组卷（basket→composing→跳排版间）+ 卷重命名（updatePaperTitle）。
// fix-1 F3：题列表 checkbox + 批量移除（确认「移出试题篮 N 题？」）+ 批量设分（弹层输入分值→逐题 setQuestionScore）。
// fix-1 E：页面标题「试题篮 · <卷标题>」。非 basket 状态进入时给出对应去向提示（不提供越态编辑）。

import { useEffect, useState, useCallback } from 'react';
import type { PaperStatus } from '../../shared/contracts/bank-types.js';
import {
  useExtPageServices, MessageBanner, Modal, PageHeader, InlineTitleEditor, EmptyState,
  type ExtPageServices, type PageMessage,
} from './ExtUi.js';
import { BankBrowser } from '../components/BankBrowser.js';
import { QuestionEditor } from '../../docgen/editor/QuestionEditor.js';
import { withFrom } from '../utils/nav.js';
import {
  loadPaperBundle, renderPaperQuestionHtml,
  PAPER_STATUS_LABEL, PAPER_STATUS_COLOR, type PaperQuestionItem,
} from './paper-actions.js';

export function BasketDetailPage({ paperId, svc: injected }: { paperId: string; svc?: ExtPageServices }) {
  const svc = useExtPageServices(injected);
  const [title, setTitle] = useState('');
  // 0044：PaperStatus 联合只增 'trashed' 的编译适配（本页篮详情直接链不产生 trashed 卷，行为零变化）
  const [status, setStatus] = useState<PaperStatus>('basket');
  const [questions, setQuestions] = useState<PaperQuestionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);

  const [showPickModal, setShowPickModal] = useState(false);
  const [showNewQuestionModal, setShowNewQuestionModal] = useState(false);
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [renameInput, setRenameInput] = useState('');
  const [editingScoreForId, setEditingScoreForId] = useState<string | null>(null);
  const [scoreInput, setScoreInput] = useState('');
  const [message, setMessage] = useState<PageMessage | null>(null);
  // fix-1 F3：批量移除 / 批量设分
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchRemoveOpen, setBatchRemoveOpen] = useState(false);
  const [batchScoreOpen, setBatchScoreOpen] = useState(false);
  const [batchScoreInput, setBatchScoreInput] = useState('');
  const [batchBusy, setBatchBusy] = useState(false);

  const loadPaper = useCallback(async () => {
    const bundle = await loadPaperBundle(svc.bank, svc.ext.paper, paperId);
    if (!bundle) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    setTitle(bundle.paper.title);
    setStatus(bundle.paper.status ?? 'basket');
    setQuestions(bundle.questions);
    setLoading(false);
  }, [svc, paperId]);

  useEffect(() => {
    loadPaper().catch((err) => {
      setMessage({ type: 'error', text: `加载失败：${err instanceof Error ? err.message : String(err)}` });
      setLoading(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadPaper]);

  const inBasket = status === 'basket';

  // ---------- 题管理 ----------

  const handlePick = async (questionId: string) => {
    try {
      await svc.bank.addQuestion(paperId, questionId);
      setShowPickModal(false);
      await loadPaper();
    } catch (err) {
      setMessage({ type: 'error', text: `加题失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  const handleNewQuestionSave = async (content: string) => {
    try {
      const newQuestion = await svc.bank.createQuestion({
        content,
        subject: '未分类',
        sourceType: 'local',
        sourceDetail: { origin: 'manual' },
        images: [],
      });
      await svc.bank.addQuestion(paperId, newQuestion.id);
      setShowNewQuestionModal(false);
      await loadPaper();
    } catch (err) {
      setMessage({ type: 'error', text: `新建题失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  const handleRemoveQuestion = async (questionId: string) => {
    try {
      await svc.bank.removeQuestion(paperId, questionId);
      await loadPaper();
    } catch (err) {
      setMessage({ type: 'error', text: `移除失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  const handleSetScoreSubmit = async (questionId: string) => {
    const score = parseFloat(scoreInput);
    setEditingScoreForId(null);
    if (isNaN(score)) {
      setMessage({ type: 'error', text: '无效分值' });
      return;
    }
    try {
      await svc.bank.setQuestionScore(paperId, questionId, score);
      await loadPaper();
    } catch (err) {
      setMessage({ type: 'error', text: `设分失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  // ---------- 拖拽排序（照旧排版间手势） ----------

  const handleDragStart = (index: number) => setDraggedIndex(index);

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (draggedIndex === null || draggedIndex === index) return;
    const next = [...questions];
    const [removed] = next.splice(draggedIndex, 1);
    next.splice(index, 0, removed);
    setQuestions(next);
    setDraggedIndex(index);
  };

  const handleDragEnd = async () => {
    if (draggedIndex === null) return;
    setDraggedIndex(null);
    try {
      await svc.bank.reorderQuestions(paperId, questions.map((item) => item.question.id));
    } catch (err) {
      setMessage({ type: 'error', text: `排序保存失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  // ---------- fix-1 F3：批量移除 / 批量设分（逐题循环既有通道，单题失败跳过） ----------

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const handleBatchRemove = async () => {
    const ids = [...selectedIds];
    setBatchRemoveOpen(false);
    setBatchBusy(true);
    let ok = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        await svc.bank.removeQuestion(paperId, id);
        ok++;
      } catch {
        failed++;
      }
    }
    setBatchBusy(false);
    setSelectedIds([]);
    await loadPaper().catch(() => {});
    setMessage({
      type: failed > 0 ? 'error' : 'success',
      text: `批量移除 ${ids.length} 题：成功 ${ok} 题，失败 ${failed} 题`,
    });
  };

  const handleBatchScore = async () => {
    const score = parseFloat(batchScoreInput);
    if (isNaN(score)) {
      setMessage({ type: 'error', text: '无效分值' });
      return;
    }
    const ids = [...selectedIds];
    setBatchScoreOpen(false);
    setBatchBusy(true);
    let ok = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        await svc.bank.setQuestionScore(paperId, id, score);
        ok++;
      } catch {
        failed++;
      }
    }
    setBatchBusy(false);
    setSelectedIds([]);
    setBatchScoreInput('');
    await loadPaper().catch(() => {});
    setMessage({
      type: failed > 0 ? 'error' : 'success',
      text: `批量设分（${score} 分）${ids.length} 题：成功 ${ok} 题，失败 ${failed} 题`,
    });
  };

  // ---------- 状态流 ----------

  const startCompose = async () => {
    try {
      await svc.ext.paper.updatePaperStatus(paperId, 'composing');
      window.location.hash = `#/compose/${paperId}`;
    } catch (err) {
      setMessage({ type: 'error', text: `进入排版失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  const handleRename = async () => {
    if (!renameInput.trim()) {
      setMessage({ type: 'error', text: '标题不能为空' });
      return;
    }
    try {
      const updated = await svc.ext.paper.updatePaperTitle(paperId, renameInput.trim());
      setTitle(updated.title);
      setShowRenameModal(false);
      setMessage({ type: 'success', text: '已重命名' });
    } catch (err) {
      setMessage({ type: 'error', text: `重命名失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  // 0004 Phase 5（fix-1 #1 转入）：标题就地编辑（与排版间同形态；保留重命名按钮并存）
  const saveTitleInline = async (next: string) => {
    const updated = await svc.ext.paper.updatePaperTitle(paperId, next);
    setTitle(updated.title);
    setMessage({ type: 'success', text: '已重命名' });
  };

  if (loading) return <div>加载中…</div>;
  if (notFound) {
    return (
      <div>
        <PageHeader title="试题篮" backHref="#/basket" backLabel="返回试卷列表" />
        <MessageBanner message={{ type: 'error', text: '试卷不存在' }} />
      </div>
    );
  }

  const allSelected = questions.length > 0 && selectedIds.length === questions.length;

  return (
    <div>
      <PageHeader title={`试题篮 · ${title}`} backHref="#/basket" backLabel="返回试卷列表" />

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0, fontSize: '1.4rem' }}>
          {/* Phase 5：点标题就地编辑（与排版间一致；「重命名」按钮保留并存）。
              testid 挂在可点击目标上（h1 外壳点击不落入内层 span） */}
          {inBasket ? (
            <InlineTitleEditor
              testid="basket-title"
              title={title}
              onSave={saveTitleInline}
              onEmpty={() => setMessage({ type: 'error', text: '标题不能为空' })}
            />
          ) : (
            <span data-testid="basket-title">{title}</span>
          )}
        </h1>
        <span
          data-testid="paper-status-badge"
          data-status={status}
          style={{
            fontSize: '0.8rem', padding: '0.15rem 0.6rem',
            borderRadius: '999px', color: 'white', backgroundColor: PAPER_STATUS_COLOR[status],
          }}
        >
          {PAPER_STATUS_LABEL[status]}
        </span>
        <span style={{ flex: 1 }} />
        {inBasket && (
          <>
            <button className="btn" data-testid="basket-rename-btn" onClick={() => { setRenameInput(title); setShowRenameModal(true); }}>重命名</button>
            {/* 0011 §一.5 双主入口（用户口径）：从题库加题 / 从网络题库加题；新建题保留为次级 */}
            <button className="btn" data-testid="basket-pick-btn" onClick={() => setShowPickModal(true)}>从题库加题</button>
            <button className="btn" data-testid="basket-new-question-btn" onClick={() => setShowNewQuestionModal(true)}>新建题</button>
            <button
              className="btn"
              data-testid="basket-capture-btn"
              onClick={() => { window.location.hash = withFrom(`#/capture?toBasket=${encodeURIComponent(paperId)}`, `basket/${paperId}`); }}
            >
              从网络题库加题
            </button>
            <button
              className="btn btn-primary"
              data-testid="basket-compose-btn"
              onClick={() => void startCompose()}
            >
              进入排版
            </button>
          </>
        )}
        {status === 'composing' && (
          <button className="btn" data-testid="basket-goto-compose-btn" onClick={() => { window.location.hash = `#/compose/${paperId}`; }}>
            去排版间
          </button>
        )}
      </div>

      {status === 'composing' && (
        <MessageBanner message={{ type: 'success', text: '该卷已进入排版中，编辑请前往排版间。' }} />
      )}
      {(status === 'done' || status === 'archived') && (
        <MessageBanner message={{ type: 'error', text: '该卷已定稿/归档，不能在此编辑；可在试题篮列表「重新编辑」复制出新篮。' }} />
      )}

      <MessageBanner message={message} />

      {questions.length === 0 ? (
        <div data-testid="basket-empty">
          <EmptyState>暂无题目，点「加题」/「新建题」开始</EmptyState>
        </div>
      ) : (
        <>
          {/* fix-1 F3：选中计数条（勾题后出现） */}
          {inBasket && selectedIds.length > 0 && (
            <div
              data-testid="basket-selection-bar"
              data-selected-count={selectedIds.length}
              className="selection-bar"
            >
              <span>已选 {selectedIds.length} 项</span>
              <span style={{ flex: 1 }} />
              <button className="btn btn-sm" data-testid="basket-batch-remove-btn" disabled={batchBusy} onClick={() => setBatchRemoveOpen(true)}>批量移除</button>
              <button className="btn btn-sm" data-testid="basket-batch-score-btn" disabled={batchBusy} onClick={() => setBatchScoreOpen(true)}>批量设分</button>
              <button className="btn btn-sm" data-testid="basket-batch-clear-btn" onClick={() => setSelectedIds([])}>取消选择</button>
            </div>
          )}
          {inBasket && (
            <label style={{ display: 'block', marginBottom: '0.4rem', color: 'var(--ink-2)' }}>
              <input
                type="checkbox"
                data-testid="basket-select-all"
                checked={allSelected}
                onChange={() => setSelectedIds(allSelected ? [] : questions.map((item) => item.question.id))}
              />
              {' '}全选（{questions.length} 题）
            </label>
          )}
          <ol data-testid="basket-question-list">
            {questions.map((item, index) => (
              <li
                key={item.question.id}
                draggable={inBasket}
                onDragStart={() => handleDragStart(index)}
                onDragOver={(e) => handleDragOver(e, index)}
                onDragEnd={() => void handleDragEnd()}
                className={draggedIndex === index ? 'basket-item dragging' : 'basket-item'}
                style={{ cursor: inBasket ? 'move' : 'default', marginBottom: '0.5rem' }}
              >
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
                  {inBasket && (
                    <input
                      type="checkbox"
                      data-testid={`basket-select-${item.question.id}`}
                      checked={selectedIds.includes(item.question.id)}
                      onChange={() => toggleSelected(item.question.id)}
                      style={{ marginTop: '0.25rem' }}
                    />
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div>
                      <strong>题干：</strong>
                      <span dangerouslySetInnerHTML={{ __html: renderPaperQuestionHtml(item.question.content) }} />
                    </div>
                    <div style={{ marginTop: '0.5rem' }}>
                      <strong>分值：</strong>
                      {inBasket && editingScoreForId === item.question.id ? (
                        <input
                          type="number"
                          data-testid={`score-input-${item.question.id}`}
                          value={scoreInput}
                          className="input"
                          onChange={(e) => setScoreInput(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && void handleSetScoreSubmit(item.question.id)}
                          onBlur={() => void handleSetScoreSubmit(item.question.id)}
                          autoFocus
                          style={{ width: '80px', marginLeft: '0.5rem' }}
                        />
                      ) : (
                        <>
                          {item.ref.score ?? '未设置'}
                          {inBasket && (
                            <button
                              data-testid={`score-btn-${item.question.id}`}
                              onClick={() => { setEditingScoreForId(item.question.id); setScoreInput(item.ref.score?.toString() ?? ''); }}
                              className="btn btn-sm"
                              style={{ marginLeft: '0.5rem' }}
                            >
                              设置分值
                            </button>
                          )}
                        </>
                      )}
                      {inBasket && (
                        <button
                          data-testid={`remove-btn-${item.question.id}`}
                          onClick={() => void handleRemoveQuestion(item.question.id)}
                          className="btn btn-sm"
                          style={{ marginLeft: '0.5rem', color: 'var(--brick)' }}
                        >
                          移除
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </>
      )}

      {/* fix-1 F3：批量移除确认（文案照任务书「移出试题篮 N 题？」） */}
      {batchRemoveOpen && (
        <Modal title="确认批量移除" onClose={() => setBatchRemoveOpen(false)}>
          <p data-testid="basket-batch-remove-text" style={{ marginTop: 0 }}>移出试题篮 {selectedIds.length} 题？</p>
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => setBatchRemoveOpen(false)}>取消</button>
            <button
              className="btn btn-danger"
              data-testid="basket-batch-remove-confirm"
              onClick={() => void handleBatchRemove()}
            >
              确认移除
            </button>
          </div>
        </Modal>
      )}

      {/* fix-1 F3：批量设分（弹层输入分值 → 逐题 setQuestionScore） */}
      {batchScoreOpen && (
        <Modal title="批量设置分值" onClose={() => setBatchScoreOpen(false)}>
          <p style={{ marginTop: 0 }}>将为已选 {selectedIds.length} 题设置同一分值。</p>
          <input
            className="input"
            data-testid="basket-batch-score-input"
            type="number"
            value={batchScoreInput}
            onChange={(e) => setBatchScoreInput(e.target.value)}
            placeholder="分值（如 5）"
            autoFocus
            style={{ width: '100%', marginBottom: '0.75rem' }}
          />
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => setBatchScoreOpen(false)}>取消</button>
            <button className="btn btn-primary" data-testid="basket-batch-score-confirm" onClick={() => void handleBatchScore()}>确认设置</button>
          </div>
        </Modal>
      )}

      {/* 加题：BankBrowser pick 模式（题库浏览器复用组件） */}
      {showPickModal && (
        <Modal title="从题库选题" onClose={() => setShowPickModal(false)}>
          <div style={{ minWidth: '560px' }}>
            <BankBrowser svc={svc} onPick={(questionId) => void handlePick(questionId)} excludeIds={questions.map((q) => q.question.id)} />
            <button className="btn" onClick={() => setShowPickModal(false)} style={{ marginTop: '0.75rem' }}>关闭</button>
          </div>
        </Modal>
      )}

      {/* 新建题弹层（原排版间逻辑迁入） */}
      {showNewQuestionModal && (
        <Modal title="新建题目" onClose={() => setShowNewQuestionModal(false)}>
          <div style={{ maxWidth: '760px' }}>
            <QuestionEditor onSave={(content: string) => void handleNewQuestionSave(content)} />
            <button className="btn" onClick={() => setShowNewQuestionModal(false)} style={{ marginTop: '1rem' }}>取消</button>
          </div>
        </Modal>
      )}

      {/* 重命名弹层 */}
      {showRenameModal && (
        <Modal title="重命名试题篮" onClose={() => setShowRenameModal(false)}>
          <input
            className="input"
            data-testid="basket-rename-input"
            value={renameInput}
            onChange={(e) => setRenameInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void handleRename()}
            autoFocus
            style={{ width: '100%', marginBottom: '0.75rem' }}
          />
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => setShowRenameModal(false)}>取消</button>
            <button className="btn btn-primary" data-testid="basket-rename-confirm" onClick={() => void handleRename()}>确定</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
