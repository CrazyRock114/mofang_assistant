// 0004 Phase 2 + fix-1 C/F2：组卷列表页（#/basket）——三区（处理中/已出卷/已归档）+ 新建试题篮。
// 0011 §一.1 多篮正式化：B8 新建拦截全链删除（requestCreate 拦截弹层/discardAndCreate/「先定稿归档再新建」
// 文案），新建直接建；处理中区顶部状态条改计数形态（0 张不显示，≥1 张显示「N 张处理中」，无单卷特写）。
// 列表卡片与操作封装为 PaperSections 共享组件，HomePage 试卷列表同构复用（§一 Phase 2 HomePage 改造）。
// fix-1 C：动词统一「归档」（确认文案=ARCHIVE_CONFIRM_TEXT）+ 已归档卡「恢复为已定稿」。
// fix-1 F2：已出卷区批量归档（→archived）/ 已归档区批量恢复（→done）——checkbox 列 + 选中计数条。
// 0018 P1：卡片行单行化（照 0011 工具条先例）——行容器去 flexWrap:wrap、卷名 min-width:0+ellipsis
// 裁切（悬停 title 见全名）、按钮组 flex:'0 0 auto' 不被长卷名挤换行；testid 前缀 paper-row-* 纯增
// （避开既有 paper-card-* 前缀查询），`.basket-item` 共享类零改动（BasketDetailPage 同用）。
// 预览/导出 = paper-actions 公共 helper（卡片直开，不要求先开排版页）；
// done/archived 卷走快照渲染（适配点在 loadPaperBundle）。

import { useEffect, useState, useCallback } from 'react';
import type { PaperSummary, PaperStatus } from '../../shared/contracts/bank-types.js';
import {
  useExtPageServices, MessageBanner, Modal, PageHeader,
  type ExtPageServices, type PageMessage,
} from './ExtUi.js';
import {
  loadPaperBundle, previewPaper, exportPaperPdf, pdfOutcomeMessage, exportPaperDocx, docxOutcomeMessage,
  questionLayoutsFromItems, textBlocksFromItems, scoresFromItems,
  PAPER_STATUS_LABEL, PAPER_STATUS_COLOR, isPaperInFlight,
  transitionMessage, ARCHIVE_CONFIRM_TEXT,
} from './paper-actions.js';
import { PaperSetPanel } from './PaperSetPanel.js';

export interface PaperSectionsProps {
  /** 注入优先（测试双跑） */
  svc?: ExtPageServices;
  /** 创建/克隆/状态迁移后由父级感知（HomePage 无需刷新页面级数据，缺省跳转即可） */
  onNotify?: (msg: PageMessage | null) => void;
  /** 0026 P3：组卷侧暴露试卷集分组（缺省关——HomePage 复用 PaperSections 零变化，只在 #/basket 打开） */
  showPaperSets?: boolean;
}

function StatusBadge({ status }: { status: PaperStatus }) {
  return (
    <span
      data-testid="paper-status-badge"
      data-status={status}
      style={{
        fontSize: '0.75rem', padding: '0.1rem 0.55rem',
        borderRadius: '999px', color: 'white', backgroundColor: PAPER_STATUS_COLOR[status],
        whiteSpace: 'nowrap', flex: '0 0 auto',
      }}
    >
      {PAPER_STATUS_LABEL[status]}
    </span>
  );
}

export function PaperSections({ svc: injected, onNotify, showPaperSets }: PaperSectionsProps) {
  const svc = useExtPageServices(injected);
  const [summaries, setSummaries] = useState<PaperSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const [message, setMessage] = useState<PageMessage | null>(null);
  // fix-1 C：归档确认弹层（单卡与批量共用一套文案）
  const [archiveTarget, setArchiveTarget] = useState<{ ids: string[]; label: string } | null>(null);
  // fix-1 F2：done / archived 两区各自的多选集合
  const [selectedDone, setSelectedDone] = useState<string[]>([]);
  const [selectedArchived, setSelectedArchived] = useState<string[]>([]);

  const notify = onNotify ?? setMessage;

  const loadList = useCallback(async () => {
    const list = await svc.ext.paper.listPapersEx();
    setSummaries(list);
    setLoading(false);
  }, [svc]);

  useEffect(() => {
    loadList().catch((err) => {
      notify({ type: 'error', text: `试卷列表加载失败：${err instanceof Error ? err.message : String(err)}` });
      setLoading(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [svc, loadList]);

  const inFlight = summaries.filter((s) => isPaperInFlight(s.paper.status));
  const done = summaries.filter((s) => s.paper.status === 'done');
  const archived = summaries.filter((s) => s.paper.status === 'archived');

  // ---------- 新建（0011 §一.1：多篮正式化——直接建，无拦截） ----------

  const createBasket = async () => {
    try {
      const paper = await svc.bank.createPaper('未命名试题篮');
      window.location.hash = `#/basket/${paper.id}`;
    } catch (err) {
      notify({ type: 'error', text: `新建失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  // ---------- 卡片动作 ----------

  const continuePaper = (summary: PaperSummary) => {
    window.location.hash = summary.paper.status === 'composing'
      ? `#/compose/${summary.paper.id}`
      : `#/basket/${summary.paper.id}`;
  };

  const previewCard = async (summary: PaperSummary, mode: 'student' | 'teacher') => {
    try {
      const bundle = await loadPaperBundle(svc.bank, svc.ext.paper, summary.paper.id);
      if (!bundle) {
        notify({ type: 'error', text: '试卷不存在' });
        return;
      }
      // Phase 5：快照走读（loadPaperBundle 对 done/archived 取快照）+ config 驱动渲染
      if (bundle.snapshotMissing) {
        notify({ type: 'error', text: `「${summary.paper.title}」该卷无快照，已用当前题库内容` });
      }
      await previewPaper(
        bundle.paper,
        bundle.questions.map((item) => item.question),
        mode,
        {
          layoutConfig: bundle.paper.layoutConfig,
          questionLayouts: questionLayoutsFromItems(bundle.questions),
        }
      );
    } catch (err) {
      notify({ type: 'error', text: `预览失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  const exportCard = async (summary: PaperSummary, mode: 'student' | 'teacher') => {
    try {
      const bundle = await loadPaperBundle(svc.bank, svc.ext.paper, summary.paper.id);
      if (!bundle) {
        notify({ type: 'error', text: '试卷不存在' });
        return;
      }
      if (bundle.snapshotMissing) {
        notify({ type: 'error', text: `「${summary.paper.title}」该卷无快照，已用当前题库内容` });
      }
      const outcome = await exportPaperPdf(
        bundle.paper,
        bundle.questions.map((item) => item.question),
        mode,
        {
          layoutConfig: bundle.paper.layoutConfig,
          questionLayouts: questionLayoutsFromItems(bundle.questions),
        }
      );
      // 0035 修复批：取消态中性提示（旧状丢弃 filePath → 取消也报「已提交导出」）
      notify(pdfOutcomeMessage(outcome, summary.paper.title, mode, bundle.paper.layoutConfig?.pageSize ?? 'A4'));
    } catch (err) {
      notify({ type: 'error', text: `导出失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  // 0035 P4：卡片直出 Word（快照卷同走 loadPaperBundle；版式/文本块/分值同源聚合）
  const exportDocxCard = async (summary: PaperSummary, mode: 'student' | 'teacher') => {
    try {
      const bundle = await loadPaperBundle(svc.bank, svc.ext.paper, summary.paper.id);
      if (!bundle) {
        notify({ type: 'error', text: '试卷不存在' });
        return;
      }
      if (bundle.snapshotMissing) {
        notify({ type: 'error', text: `「${summary.paper.title}」该卷无快照，已用当前题库内容` });
      }
      const outcome = await exportPaperDocx(bundle.paper, bundle.questions.map((item) => item.question), mode, {
        layoutConfig: bundle.paper.layoutConfig,
        questionLayouts: questionLayoutsFromItems(bundle.questions),
        // 0035：文本块/分值同源聚合（卡片直出与排版间同输入；PDF 卡片路径的既有缺口不在此扩改）
        textBlocks: textBlocksFromItems(bundle.questions),
        scores: scoresFromItems(bundle.questions),
      });
      notify(docxOutcomeMessage(outcome, summary.paper.title, mode));
    } catch (err) {
      notify({ type: 'error', text: `Word 导出失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  const cloneCard = async (summary: PaperSummary) => {
    try {
      const cloned = await svc.ext.paper.clonePaperToBasket(summary.paper.id);
      notify({ type: 'success', text: `已复制为新试题篮：${cloned.title}` });
      window.location.hash = `#/basket/${cloned.id}`;
    } catch (err) {
      notify({ type: 'error', text: `重新编辑失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  const transitionCard = async (summary: PaperSummary, next: PaperStatus) => {
    try {
      await svc.ext.paper.updatePaperStatus(summary.paper.id, next);
      // 非法迁移等失败由服务层抛错（MessageBanner 可见，不静默）
      await loadList();
      notify({ type: 'success', text: transitionMessage(next, summary.paper.title) });
    } catch (err) {
      notify({ type: 'error', text: `状态更新失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  // ---------- fix-1 F2：批量归档 / 批量恢复（逐卷循环既有通道，单卷失败跳过并计入提示） ----------

  const toggleSelected = (list: string[], setList: (v: string[]) => void, id: string) => {
    setList(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  };

  const runBatchTransition = async (ids: string[], next: PaperStatus) => {
    let ok = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        await svc.ext.paper.updatePaperStatus(id, next);
        ok++;
      } catch {
        failed++;
      }
    }
    setSelectedDone([]);
    setSelectedArchived([]);
    await loadList().catch(() => {});
    notify({
      type: failed > 0 ? 'error' : 'success',
      text: next === 'archived'
        ? `批量归档 ${ids.length} 卷：成功 ${ok} 卷，失败 ${failed} 卷`
        : `批量恢复为已定稿 ${ids.length} 卷：成功 ${ok} 卷，失败 ${failed} 卷`,
    });
  };

  const confirmArchive = async () => {
    const target = archiveTarget;
    if (!target) return;
    setArchiveTarget(null);
    await runBatchTransition(target.ids, 'archived');
  };

  // ---------- 卡片渲染 ----------

  function renderCard(summary: PaperSummary, actions: 'inflight' | 'done' | 'archived') {
    const { paper, questionCount, totalScore } = summary;
    const status = paper.status ?? 'basket';
    const selectable = actions === 'done' || actions === 'archived';
    const selectedList = actions === 'done' ? selectedDone : selectedArchived;
    return (
      <li
        key={paper.id}
        data-testid={`paper-card-${paper.id}`}
        className="basket-item"
      >
        {/* 0018 P1：行容器去 wrap——长卷名经卷名承载元素收缩截断，按钮组恒在同行 */}
        <div
          data-testid={`paper-row-${paper.id}`}
          style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flex: 1, minWidth: 0 }}
        >
          {selectable && (
            <input
              type="checkbox"
              data-testid={`card-select-${paper.id}`}
              checked={selectedList.includes(paper.id)}
              onChange={() => toggleSelected(selectedList, actions === 'done' ? setSelectedDone : setSelectedArchived, paper.id)}
            />
          )}
          <strong
            data-testid={`paper-row-title-${paper.id}`}
            title={paper.title}
            style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {paper.title}
          </strong>
          <StatusBadge status={status} />
          {/* 0018 P1：徽章/计数 nowrap——收缩全部由卷名承载元素吸收，行内其余字段不竖排 */}
          <span style={{ color: 'var(--ink-3)', fontSize: '0.85rem', whiteSpace: 'nowrap', flex: '0 0 auto' }}>{questionCount} 题 · 总分 {totalScore}</span>
          <span style={{ flex: 1 }} />
          {actions === 'inflight' && (
            <div data-testid={`paper-row-actions-${paper.id}`} style={{ display: 'flex', gap: '0.35rem', flex: '0 0 auto' }}>
              <button className="btn btn-sm" data-testid={`card-continue-${paper.id}`} onClick={() => continuePaper(summary)}>
                {status === 'composing' ? '继续排版' : '继续'}
              </button>
            </div>
          )}
          {actions === 'done' && (
            <div data-testid={`paper-row-actions-${paper.id}`} style={{ display: 'flex', gap: '0.35rem', flex: '0 0 auto' }}>
              {/* 0011-fix：done 卷「打开」= 进排版间只读视图（快照走读，不可编辑） */}
              <button className="btn btn-sm" data-testid={`card-open-${paper.id}`} onClick={() => { window.location.hash = `#/compose/${paper.id}`; }}>打开</button>
              <button className="btn btn-sm" data-testid={`card-preview-${paper.id}`} onClick={() => void previewCard(summary, 'student')}>预览</button>
              <button className="btn btn-sm" data-testid={`card-export-${paper.id}`} onClick={() => void exportCard(summary, 'student')}>导出 PDF</button>
              <button className="btn btn-sm" data-testid={`card-export-docx-${paper.id}`} onClick={() => void exportDocxCard(summary, 'student')}>导出 Word</button>
              <button className="btn btn-sm" data-testid={`card-clone-${paper.id}`} onClick={() => void cloneCard(summary)}>重新编辑</button>
              <button className="btn btn-sm" data-testid={`card-archive-${paper.id}`} onClick={() => setArchiveTarget({ ids: [paper.id], label: paper.title })}>归档</button>
            </div>
          )}
          {actions === 'archived' && (
            <div data-testid={`paper-row-actions-${paper.id}`} style={{ display: 'flex', gap: '0.35rem', flex: '0 0 auto' }}>
              <button className="btn btn-sm" data-testid={`card-open-${paper.id}`} onClick={() => { window.location.hash = `#/compose/${paper.id}`; }}>打开</button>
              <button className="btn btn-sm" data-testid={`card-preview-${paper.id}`} onClick={() => void previewCard(summary, 'student')}>预览</button>
              <button className="btn btn-sm" data-testid={`card-export-${paper.id}`} onClick={() => void exportCard(summary, 'student')}>导出 PDF</button>
              <button className="btn btn-sm" data-testid={`card-clone-${paper.id}`} onClick={() => void cloneCard(summary)}>重新编辑</button>
              <button className="btn btn-sm" data-testid={`card-restore-${paper.id}`} onClick={() => void transitionCard(summary, 'done')}>恢复为已定稿</button>
            </div>
          )}
        </div>
      </li>
    );
  }

  function renderSection(title: string, testid: string, list: PaperSummary[], actions: 'inflight' | 'done' | 'archived', emptyText: string) {
    const selectable = actions === 'done' || actions === 'archived';
    const selectedList = actions === 'done' ? selectedDone : selectedArchived;
    return (
      <section data-testid={testid} style={{ marginBottom: '1.5rem' }}>
        <h2 className="section-title" style={{ fontSize: '1.1rem' }}>
          {title}（{list.length}）
        </h2>
        {/* fix-1 F2：批量动作条（选中后出现，逐卷循环既有通道） */}
        {selectable && selectedList.length > 0 && (
          <div
            data-testid={actions === 'done' ? 'done-batch-bar' : 'archived-batch-bar'}
            data-selected-count={selectedList.length}
            className="selection-bar"
          >
            <span>已选 {selectedList.length} 项</span>
            <span style={{ flex: 1 }} />
            {actions === 'done' ? (
              <button
                className="btn btn-sm"
                data-testid="batch-archive-btn"
                onClick={() => setArchiveTarget({ ids: [...selectedList], label: `${selectedList.length} 卷` })}
              >
                批量归档
              </button>
            ) : (
              <button className="btn btn-sm" data-testid="batch-restore-btn" onClick={() => void runBatchTransition(selectedList, 'done')}>
                批量恢复为已定稿
              </button>
            )}
            <button className="btn btn-sm" data-testid="batch-clear-btn" onClick={() => (actions === 'done' ? setSelectedDone([]) : setSelectedArchived([]))}>取消选择</button>
          </div>
        )}
        {list.length === 0 ? (
          <p style={{ color: 'var(--ink-3)' }}>{emptyText}</p>
        ) : (
          <ul style={{ padding: 0, margin: 0 }}>{list.map((s) => renderCard(s, actions))}</ul>
        )}
      </section>
    );
  }

  if (loading) return <div>加载中…</div>;

  return (
    <div>
      <div style={{ marginBottom: '1rem' }}>
        <button className="btn btn-primary" data-testid="create-basket-btn" onClick={() => void createBasket()}>新建试题篮</button>
      </div>

      <MessageBanner message={onNotify ? null : message} />

      {/* 0011 §一.1：处理中区顶部状态条（计数形态）——0 张不显示；≥1 张「N 张处理中」，无单卷特写 */}
      {inFlight.length > 0 && (
        <div
          data-testid="inflight-status-bar"
          data-has-inflight="true"
          className="selection-bar"
          style={{ marginBottom: '0.75rem' }}
        >
          <strong data-testid="inflight-status-text">{inFlight.length} 张处理中</strong>
          <span style={{ flex: 1 }} />
        </div>
      )}

      {renderSection('处理中', 'section-inflight', inFlight, 'inflight', '暂无进行中的卷，点「新建试题篮」开始')}
      {renderSection('已出卷', 'section-done', done, 'done', '暂无已出卷（排版间定稿后出现在这里）')}

      {/* 0026 P3：试卷集分组（组卷侧暴露；考试页仍是编排入口） */}
      {showPaperSets && <PaperSetPanel svc={injected} />}

      {/* 已归档：折叠显示 */}
      <section data-testid="section-archived" style={{ marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <h2 className="section-title" style={{ fontSize: '1.1rem', margin: 0 }}>已归档（{archived.length}）</h2>
          <button className="btn btn-sm" data-testid="archived-toggle" onClick={() => setShowArchived(!showArchived)}>
            {showArchived ? '收起' : '展开'}
          </button>
        </div>
        {showArchived && renderSection('已归档', 'section-archived-list', archived, 'archived', '暂无归档卷')}
      </section>

      {/* fix-1 C：归档确认弹层（单卡/批量共用文案；动词统一「归档」） */}
      {archiveTarget && (
        <Modal title="归档试卷" onClose={() => setArchiveTarget(null)}>
          <p data-testid="archive-confirm-text" style={{ marginTop: 0 }}>
            {archiveTarget.ids.length === 1 ? `将归档「${archiveTarget.label}」。` : `将批量归档 ${archiveTarget.ids.length} 卷。`}
            {ARCHIVE_CONFIRM_TEXT}
          </p>
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => setArchiveTarget(null)}>取消</button>
            <button className="btn btn-danger" data-testid="archive-confirm-btn" onClick={() => void confirmArchive()}>
              确认归档
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** #/basket 组卷列表页（HomePage 试卷区直接复用 PaperSections；试卷集面板仅本页打开） */
export function BasketListPage({ services }: { services?: ExtPageServices } = {}) {
  return (
    <div>
      {/* 0011 §一.4：页面标题定名「组卷」（导航合并后与条目语义一致）；详情页仍「试题篮 · <标题>」 */}
      <PageHeader title="组卷" backHref="#/" />
      <PaperSections svc={services} showPaperSets />
    </div>
  );
}
