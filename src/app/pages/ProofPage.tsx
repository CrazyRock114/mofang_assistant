// 0040 P6.4（deprecated，仅注释）：本页为 0028 旧呈现层，**保留不删、语义不变**——
// 录题工作台 v2（#/intake）已接管新录题流程；旧 run 直链 #/proof/<runId> 仍可打开本页读旧数据。
// 新功能一律不再加到本页（编辑逻辑细节按用户口径并入 0040 工作台）。
// C1 Phase 1: 校对工作台 — 左屏原卷页图参照 + 右栏校对条目列表
// 黑白功能级（视觉稿 pending 为已知架构缺口）。会话状态在内存，刷新即失（首版不持久化）。
// 编辑器复用 docgen QuestionEditor（lazy 加载，识别草稿与手录题同构）；入库走 bankService。

import { lazy, Suspense, useMemo, useState } from 'react';
import 'katex/dist/katex.min.css';
import type { BankService } from '../../shared/contracts/bank-types.js';
import type { ProofItem, ProofPageInput } from '../../shared/contracts/recog-ui-types.js';
import { renderMath, rewriteDataAssetSrcs } from '../../docgen/render/buildPaperHtml.core.js';
import { getUserDataAssetsRoot } from '../services/paths.js';
import { createBankService } from '../services/BankServiceFactory.js';
import { applyProofAction, collectOkItems, moveItem } from '../proof/proof-session.js';
import { MOCK_PROOF_INPUT } from '../proof/mock-proof-input.js';
import { MOCK_PROOF_INPUT_CHUTIAN } from '../proof/mock-proof-input-chutian.js';
import { buildIngestInputs, type IngestOrigin } from '../../recog/ingest.js';
import { proofItemToScanDraft } from '../../recog/proof.js';
// 0028 P3：核验清单 V1-V5 + V8 人签门禁（纯函数，随条目变化实时复算）
import { ingestGate, verifyProofItems, type VerifyReport } from '../../recog/verify/checklist.js';
import { createRecogService } from '../services/RecogServiceFactory.js';
// 0036（只增）：from-aware 返回（校对页可能由切题工作区进入，上一级是切题项目而非首页）
import { resolveBackHref, hashSearchOf, backLabelOf } from '../utils/nav.js';
// 0029（只增）：录题侧 AI 建议最小入口（0040 收口后随新工作台迁移；非验收阻塞项）
import { AiSuggestDialog } from '../components/AiSuggestDialog.js';

const QuestionEditor = lazy(() =>
  import('../../docgen/editor/QuestionEditor.js').then((m) => ({ default: m.QuestionEditor })),
);

const QUESTION_ROOT_OPEN = '<div class="question">';
const QUESTION_ROOT_CLOSE = '</div>';

/** 答案/解析片段进 QuestionEditor 时包 question 根（编辑器以 question 块为骨架），存回时剥掉 */
function wrapForEditor(html: string | undefined): string {
  return `${QUESTION_ROOT_OPEN}${html ?? ''}${QUESTION_ROOT_CLOSE}`;
}

function unwrapFromEditor(html: string): string {
  const trimmed = html.trim();
  if (trimmed.startsWith(QUESTION_ROOT_OPEN) && trimmed.endsWith(QUESTION_ROOT_CLOSE)) {
    return trimmed.slice(QUESTION_ROOT_OPEN.length, trimmed.length - QUESTION_ROOT_CLOSE.length);
  }
  return trimmed;
}

/** 页图路径 → <img> src：绝对路径转 file:///；相对仓库根路径按 dist/renderer 上溯两级（浏览器回落时图不显示） */
function resolveImageSrc(imagePath: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(imagePath)) return `file:///${imagePath.replace(/\\/g, '/')}`;
  if (imagePath.startsWith('/')) return `file://${imagePath}`;
  return `../../${imagePath}`;
}

/** 空 src 图引用占位：alt 即 imageRefId（形如 p10-img-0），页码优先取 id 内 pN，跨页续接时以 id 为准 */
function figurePlaceholder(imageRefId: string, itemPageNo: number): string {
  const m = imageRefId.match(/^p(\d+)-/);
  const page = m ? Number(m[1]) : itemPageNo;
  return (
    `<span class="figure-placeholder" data-image-ref="${imageRefId}"` +
    ` style="display:inline-block;padding:0.25rem 0.5rem;border:1px dashed var(--line-strong);color:var(--ink-2);">` +
    `🖼 图 ${imageRefId}（见左屏第 ${page} 页）</span>`
  );
}

/** 条目只读视图 HTML：KaTeX 渲染公式 + 空 src 图引用转可读占位 + data-assets 资产根解析（D1 P3） */
function renderProofCardHtml(html: string, itemPageNo: number): string {
  return rewriteDataAssetSrcs(
    renderMath(html).replace(
      /<figure[^>]*>\s*<img\b(?=[^>]*\bsrc="")(?=[^>]*\balt="([^"]*)")[^>]*>\s*<\/figure>/g,
      (_match, imageRefId: string) => figurePlaceholder(imageRefId, itemPageNo),
    ),
    getUserDataAssetsRoot(),
  );
}

const STATUS_LABEL: Record<ProofItem['status'], string> = {
  pending: '待校对',
  ok: '已通过',
  split: '已拆分',
  merge: '已合并',
  delete: '已删除',
};

const STATUS_CLASS: Record<ProofItem['status'], string> = {
  pending: 'st-pending',
  ok: 'st-ok',
  split: 'st-split',
  merge: 'st-merge',
  delete: 'st-delete',
};

/** 核验项标题（与 checklist.ts 的 code 一一对应） */
const VERIFY_TITLE: Record<'V1' | 'V2' | 'V3' | 'V4' | 'V5', string> = {
  V1: '题号连续性与层级',
  V2: '题干完整性',
  V3: '公式编译',
  V4: '配图绑定',
  V5: '答案解析完整',
};

interface EditTarget {
  draftId: string;
  field: 'content' | 'answer' | 'analysis';
}

export interface ProofPageProps {
  initialInput?: ProofPageInput; // 测试/直接注入；缺省走导入台
  bank?: BankService; // 测试注入；缺省 createBankService()
  /** 0028：本批草稿所属识别 run —— 入库成功后回写结果题目 id 集（迁移 0012 question_ids） */
  runId?: string;
  /** 0028：素材文件名去扩展名，作 targetPaperTitle 的默认值（保存时才问目录，此处只是预填） */
  defaultTitle?: string;
  /** 0028：共享状态的学科默认值（0024 同源；可改，不阻断） */
  defaultSubject?: string;
  /** 0036：入库来源标记（缺省 'scan'；PDF 切题工作区传 'pdf-split'，溯源可区分来路） */
  ingestOrigin?: IngestOrigin;
}

export function ProofPage({ initialInput, bank: bankProp, runId, defaultTitle, defaultSubject, ingestOrigin }: ProofPageProps) {
  const bank = useMemo(() => bankProp ?? createBankService(), [bankProp]);
  const recog = useMemo(() => createRecogService(), []);

  const [input, setInput] = useState<ProofPageInput | null>(initialInput ?? null);
  const [items, setItems] = useState<ProofItem[]>(initialInput?.items ?? []);
  const [paperTitle, setPaperTitle] = useState('');
  const [subject, setSubject] = useState(defaultSubject?.trim() || '未分类');
  const [targetPaperTitle, setTargetPaperTitle] = useState(defaultTitle ?? '');
  const [excludedPages, setExcludedPages] = useState<Set<number>>(new Set());
  const [splitFor, setSplitFor] = useState<string | null>(null);
  const [splitText, setSplitText] = useState('');
  const [splitQno, setSplitQno] = useState('');
  const [splitInto, setSplitInto] = useState('');
  const [mergeMode, setMergeMode] = useState(false);
  const [mergeSel, setMergeSel] = useState<Set<string>>(new Set());
  const [mergeInto, setMergeInto] = useState('');
  const [scoreFor, setScoreFor] = useState<string | null>(null);
  const [scoreText, setScoreText] = useState('');
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [ingested, setIngested] = useState<Record<string, string>>({}); // draftId → bank Question.id
  const [notice, setNotice] = useState<string | null>(null);
  // 0029（只增）：录题侧 AI 建议弹层（对已入库题目出建议；确认随入库链路走既有通道）
  const [aiSuggestOpen, setAiSuggestOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');

  const dispatch = (action: Parameters<typeof applyProofAction>[1]) => {
    const result = applyProofAction(items, action);
    if (result.error) {
      setNotice(result.error);
      return;
    }
    setItems(result.items);
  };

  const loadInput = (data: ProofPageInput) => {
    setInput(data);
    setItems(data.items.map((it) => ({ ...it })));
    setIngested({});
    setExcludedPages(new Set());
    setMergeSel(new Set());
    setMergeMode(false);
    setNotice(null);
  };

  const loadPasteJson = () => {
    try {
      const data = JSON.parse(pasteText) as ProofPageInput;
      if (!Array.isArray(data.pages) || !Array.isArray(data.items)) throw new Error('缺少 pages/items 数组');
      loadInput(data);
    } catch (err) {
      setNotice(`JSON 解析失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const loadFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result)) as ProofPageInput;
        if (!Array.isArray(data.pages) || !Array.isArray(data.items)) throw new Error('缺少 pages/items 数组');
        loadInput(data);
      } catch (err) {
        setNotice(`JSON 解析失败：${err instanceof Error ? err.message : String(err)}`);
      }
    };
    reader.readAsText(file);
  };

  const handleSplitConfirm = (draftId: string) => {
    if (!splitText.trim()) {
      setNotice('断点文本不能为空');
      return;
    }
    const parsedQno = parseInt(splitQno.trim(), 10);
    dispatch({
      type: 'split',
      draftId,
      atText: splitText,
      ...(Number.isNaN(parsedQno) ? {} : { newQno: parsedQno }),
      ...(splitInto ? { intoDraftId: splitInto } : {}),
    });
    setSplitFor(null);
    setSplitText('');
    setSplitQno('');
    setSplitInto('');
  };

  const handleMergeConfirm = () => {
    if (mergeSel.size < 2) {
      setNotice('合并至少选择 2 条');
      return;
    }
    if (!mergeInto || !mergeSel.has(mergeInto)) {
      setNotice('请选择合并目标（须在所选条目中）');
      return;
    }
    dispatch({ type: 'merge', draftIds: [...mergeSel], intoId: mergeInto });
    setMergeMode(false);
    setMergeSel(new Set());
    setMergeInto('');
  };

  const handleScoreSubmit = (draftId: string) => {
    const score = parseFloat(scoreText);
    if (Number.isNaN(score)) {
      setNotice('无效分值');
      return;
    }
    dispatch({ type: 'rescore', draftId, score });
    setScoreFor(null);
    setScoreText('');
  };

  const handleEditSave = (html: string) => {
    if (!editTarget) return;
    setItems(
      items.map((it) => {
        if (it.draftId !== editTarget.draftId) return it;
        // 编辑后重新入 pending 校对态
        if (editTarget.field === 'content') return { ...it, contentHtml: html, status: 'pending' };
        if (editTarget.field === 'answer') return { ...it, answerHtml: unwrapFromEditor(html), status: 'pending' };
        return { ...it, analysisHtml: unwrapFromEditor(html), status: 'pending' };
      }),
    );
    setEditTarget(null);
  };

  // 校对预览：右栏草稿（剔除已删除）经 render 层 buildPaperHtml 渲染，与导出共用
  const handlePreview = async () => {
    const { buildPaperHtml } = await import('../../docgen/render/buildPaperHtml.browser.js');
    const visible = items.filter((it) => it.status !== 'delete');
    const paper = {
      id: 'proof-preview',
      title: paperTitle.trim() || '校对预览',
      config: {},
      createdAt: new Date().toISOString(),
      archived: false,
    };
    const questions = visible.map((it) => ({
      id: it.draftId,
      subject: subject.trim() || '未分类',
      sourceType: 'local' as const,
      sourceDetail: { origin: 'scan', pageNo: it.pageNo, qno: it.qno },
      content: it.contentHtml,
      ...(it.answerHtml !== undefined ? { answer: it.answerHtml } : {}),
      ...(it.analysisHtml !== undefined ? { analysis: it.analysisHtml } : {}),
      // 0002 契约：images 结构化（校对链路为 OCR 题干插图，默认 figure）
      images: it.imageRefIds.map((assetId) => ({ assetId, type: 'figure' as const })),
      createdAt: '',
      updatedAt: '',
    }));
    const html = await buildPaperHtml(paper, questions, { mode: 'teacher' });
    const win = window.open('', '_blank');
    if (win) {
      win.document.write(html);
      win.document.close();
    }
  };

  // 0028 P3：核验随条目实时复算（编辑即重判），V8 门禁据此放行/拦截入库
  const verifyReport: VerifyReport = useMemo(() => verifyProofItems(items), [items]);
  const gate = useMemo(() => ingestGate(items, verifyReport), [items, verifyReport]);
  const failingDraftIds = useMemo(
    () => new Set(Object.entries(verifyReport.byItem).filter(([, v]) => !v.ok).map(([id]) => id)),
    [verifyReport],
  );

  const handleIngest = async () => {
    // V8 人签门禁（双保险：按钮置灰 + 此处再判，防绕过）
    if (!gate.allowed) {
      setNotice(`入库被门禁拦截：${gate.reasons.join('；')}`);
      return;
    }
    const okItems = collectOkItems(items).filter((it) => !(it.draftId in ingested));
    if (okItems.length === 0) {
      setNotice('没有可入库的已通过题目（须先标记「校对通过」，已入库条目不重复入库）');
      return;
    }
    const ingestInputs = buildIngestInputs(okItems.map(proofItemToScanDraft), {
      subject: subject.trim() || '未分类',
      ...(paperTitle.trim() ? { paperTitle: paperTitle.trim() } : {}),
      ...(ingestOrigin ? { origin: ingestOrigin } : {}),
    });

    let paperId: string | null = null;
    if (targetPaperTitle.trim()) {
      const paper = await bank.createPaper(targetPaperTitle.trim());
      paperId = paper.id;
    }

    const successes: Array<{ draftId: string; questionId: string }> = [];
    const failures: string[] = [];
    for (let k = 0; k < okItems.length; k++) {
      try {
        const q = await bank.createQuestion(ingestInputs[k]);
        if (paperId) await bank.addQuestion(paperId, q.id, okItems[k].score);
        successes.push({ draftId: okItems[k].draftId, questionId: q.id });
      } catch (err) {
        failures.push(`${okItems[k].draftId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    setIngested((prev) => {
      const next = { ...prev };
      for (const s of successes) next[s.draftId] = s.questionId;
      return next;
    });
    setNotice(
      `入库完成：成功 ${successes.length} 题，失败 ${failures.length} 题` +
        (paperId ? `，已加入试卷「${targetPaperTitle.trim()}」` : '') +
        (failures.length > 0 ? `；失败明细：${failures.join('；')}` : ''),
    );
    // 0028：结果题目 id 集回写 run（去重并集；失败不影响入库结论，故 catch 后只提示）
    if (runId && successes.length > 0) {
      try {
        await recog.attachQuestions({ runId, questionIds: successes.map((s) => s.questionId) });
      } catch (err) {
        setNotice(
          (prev) =>
            `${prev ?? ''}；run 结果回写失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  };

  // ===== 导入台（无输入时）=====
  if (!input) {
    return (
      <div>
        {/* 0010-merge P2.5：页面标题命名统一（校对工作台 → 试题录入） */}
        <h1 className="section-title">试题录入</h1>
        <div style={{ marginBottom: '1rem' }}>
          {/* 0036 目检返工：从切题工作区过来时（?from=split/<项目>）返回切题项目，否则返回首页 */}
        <a
          className="page-back"
          data-testid="proof-back"
          href={resolveBackHref(hashSearchOf(typeof window === 'undefined' ? '' : window.location.hash), '#/')}
        >
          ← {backLabelOf(hashSearchOf(typeof window === 'undefined' ? '' : window.location.hash), '返回首页')}
        </a>
        </div>
        <div className="card" style={{ padding: '1rem', marginBottom: '1rem' }}>
          <h2 style={{ marginTop: 0 }} className="section-title">导入校对输入</h2>
          <button className="btn" data-testid="btn-load-mock" onClick={() => loadInput(MOCK_PROOF_INPUT)}>
            加载 mock 演示（上海 2024 前 3 页）
          </button>
          <button className="btn" data-testid="btn-load-mock-chutian" onClick={() => loadInput(MOCK_PROOF_INPUT_CHUTIAN)} style={{ marginLeft: '0.5rem' }}>
            加载 mock 演示（楚天 2025-12 全 11 页）
          </button>
          <div style={{ marginTop: '1rem' }}>
            <label>
              从文件导入（build-proof-input 产物 JSON）：
              <input
                type="file"
                accept=".json"
                data-testid="input-file"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) loadFile(f);
                }}
              />
            </label>
          </div>
          <div style={{ marginTop: '1rem' }}>
            <div>或粘贴 ProofPageInput JSON：</div>
            <textarea
              className="input"
              data-testid="input-paste"
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              style={{ width: '100%', height: '120px' }}
            />
            <button onClick={loadPasteJson} disabled={!pasteText.trim()}>
              加载粘贴内容
            </button>
          </div>
        </div>
        {notice && <div data-testid="notice">{notice}</div>}
      </div>
    );
  }

  // ===== 校对工作台 =====
  const visiblePages = input.pages.filter((p) => !excludedPages.has(p.pageNo));
  const okCount = collectOkItems(items).length;
  const editingItem = editTarget ? items.find((it) => it.draftId === editTarget.draftId) : undefined;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* 顶部工具条 */}
      <div style={{ padding: '0.5rem 1rem', borderBottom: '1px solid var(--line-strong)', display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn" onClick={() => (window.location.hash = '#/')}>返回首页</button>
        <label>
          卷标题：
          <input className="input" data-testid="input-title" value={paperTitle} onChange={(e) => setPaperTitle(e.target.value)} placeholder="入库 sourceDetail 用" />
        </label>
        <label>
          学科：
          <input className="input" data-testid="input-subject" value={subject} onChange={(e) => setSubject(e.target.value)} style={{ width: '6em' }} />
        </label>
        <span>
          页选择：
          {input.pages.map((p) => (
            <label key={p.pageNo} style={{ marginLeft: '0.25rem' }}>
              <input
                type="checkbox"
                checked={!excludedPages.has(p.pageNo)}
                onChange={(e) => {
                  const next = new Set(excludedPages);
                  if (e.target.checked) next.delete(p.pageNo);
                  else next.add(p.pageNo);
                  setExcludedPages(next);
                }}
              />
              p{p.pageNo}
            </label>
          ))}
        </span>
        <button className="btn" data-testid="btn-reset" onClick={() => loadInput(input)}>
          重置
        </button>
        <label>
          目标试卷标题：
          <input className="input" data-testid="input-target-paper" value={targetPaperTitle} onChange={(e) => setTargetPaperTitle(e.target.value)} placeholder="留空则只入题库" />
        </label>
        <button
          className="btn btn-primary"
          data-testid="btn-ingest"
          data-gate={gate.allowed ? 'open' : 'closed'}
          disabled={!gate.allowed}
          title={gate.allowed ? '核验全绿，可入库' : gate.reasons.join('；')}
          onClick={handleIngest}
        >
          入库已通过题目（{okCount}）
        </button>
        <button className="btn" data-testid="btn-preview" onClick={handlePreview}>
          校对预览
        </button>
        {/* 0029（只增）：录题侧最小入口——仅已入库题目可出建议（空锚点/未配置 AI 由弹层明示引导） */}
        {Object.keys(ingested).length > 0 && (
          <button className="btn" data-testid="proof-ai-suggest-btn" onClick={() => setAiSuggestOpen(true)}>
            AI 知识节点/打标建议（已入库 {Object.keys(ingested).length} 题）
          </button>
        )}
      </div>

      {/* 页级警告条 */}
      {input.warnings.length > 0 && (
        <div data-testid="warnings-bar" style={{ padding: '0.25rem 1rem', borderBottom: '1px solid var(--line-strong)', background: 'var(--card-warm)' }}>
          ⚠ 引擎警告 {input.warnings.length} 条（hover 查看）
          <div style={{ display: 'none' }} />
          <details>
            <summary>展开警告明细</summary>
            <ul>
              {input.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </details>
        </div>
      )}

      {notice && (
        <div data-testid="notice" style={{ padding: '0.25rem 1rem', borderBottom: '1px solid var(--line-strong)' }}>
          {notice}
        </div>
      )}

      {/* 合并工具条 */}
      <div style={{ padding: '0.25rem 1rem', borderBottom: '1px solid var(--line-strong)' }}>
        <button
          data-testid="btn-merge-mode"
          onClick={() => {
            setMergeMode(!mergeMode);
            setMergeSel(new Set());
            setMergeInto('');
          }}
        >
          {mergeMode ? '退出合并' : '合并模式'}
        </button>
        {mergeMode && (
          <span style={{ marginLeft: '0.5rem' }}>
            已选 {mergeSel.size} 条，合并进：
            <select className="select" data-testid="merge-into" value={mergeInto} onChange={(e) => setMergeInto(e.target.value)}>
              <option value="">选择目标</option>
              {[...mergeSel].map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
            <button data-testid="btn-merge-confirm" onClick={handleMergeConfirm} style={{ marginLeft: '0.5rem' }}>
              确认合并
            </button>
          </span>
        )}
      </div>

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* 左屏：原卷页图参照（非编辑器） */}
        <div data-testid="page-pane" style={{ flex: 1, overflow: 'auto', borderRight: '1px solid var(--line-strong)', padding: '1rem' }}>
          {visiblePages.map((p) => (
            <div key={p.pageNo} style={{ marginBottom: '1.5rem' }}>
              <div>第 {p.pageNo} 页</div>
              <img src={resolveImageSrc(p.imagePath)} alt={`第 ${p.pageNo} 页原卷图`} style={{ maxWidth: '100%', border: '1px solid var(--line)' }} />
              <details>
                <summary>OCR 原文</summary>
                <pre style={{ whiteSpace: 'pre-wrap', fontSize: '12px' }}>{p.ocrText}</pre>
              </details>
            </div>
          ))}
        </div>

        {/* 0028 P3：核验清单卡（P-08：V1-V5 自动核验 + V8 人签门禁） */}
        <aside
          data-testid="verify-panel"
          data-gate={gate.allowed ? 'open' : 'closed'}
          style={{ width: '19rem', flexShrink: 0, overflow: 'auto', borderRight: '1px solid var(--line-strong)', padding: '1rem' }}
        >
          <h2 style={{ marginTop: 0, fontSize: '1rem' }} className="section-title">
            核验清单
          </h2>
          <div data-testid="gate-status" style={{ marginBottom: '0.5rem', fontWeight: 600, color: gate.allowed ? 'var(--ok, #2e7d32)' : 'var(--danger, #c0392b)' }}>
            {gate.allowed ? '✓ 全绿，可入库' : '⛔ 未全绿，禁止入库'}
          </div>
          {gate.reasons.length > 0 && (
            <ul data-testid="gate-reasons" style={{ margin: '0 0 0.75rem 1rem', padding: 0, color: 'var(--ink-2)', fontSize: '12px' }}>
              {gate.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}
          {(['V1', 'V2', 'V3', 'V4', 'V5'] as const).map((code) => {
            const own = verifyReport.findings.filter((f) => f.code === code);
            const fails = own.filter((f) => f.level === 'fail').length;
            const warns = own.length - fails;
            return (
              <div key={code} data-testid={`verify-${code}`} data-fail={fails} style={{ fontSize: '12px', marginBottom: '0.25rem' }}>
                <strong>{code}</strong> {VERIFY_TITLE[code]}：
                {fails > 0 ? <span style={{ color: 'var(--danger, #c0392b)' }}>不通过 ×{fails}</span> : '通过'}
                {warns > 0 && <span style={{ color: 'var(--ink-3)' }}>（提示 ×{warns}）</span>}
              </div>
            );
          })}
          {verifyReport.fails.length > 0 && (
            <div data-testid="verify-fails" style={{ marginTop: '0.75rem', fontSize: '12px' }}>
              <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>待修正：</div>
              <ul style={{ margin: 0, paddingLeft: '1rem' }}>
                {verifyReport.fails.map((f, i) => (
                  <li key={i}>
                    <code>{f.draftId}</code> {f.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {verifyReport.fails.length === 0 && verifyReport.warnings.length > 0 && (
            <details style={{ marginTop: '0.75rem', fontSize: '12px' }}>
              <summary>提示 {verifyReport.warnings.length} 条（不阻断入库）</summary>
              <ul style={{ margin: 0, paddingLeft: '1rem' }}>
                {verifyReport.warnings.map((f, i) => (
                  <li key={i}>
                    <code>{f.draftId}</code> {f.message}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </aside>

        {/* 右栏：校对条目列表 */}
        <div data-testid="item-pane" style={{ flex: 1, overflow: 'auto', padding: '1rem' }}>
          {items.map((it, index) => {
            const deleted = it.status === 'delete';
            return (
              <div
                key={it.draftId}
                data-testid={`proof-item-${it.draftId}`}
                data-verify={failingDraftIds.has(it.draftId) ? 'fail' : 'ok'}
                className="card"
                style={{
                  marginBottom: '0.75rem',
                  padding: '0.75rem',
                  opacity: deleted ? 0.5 : 1,
                  ...(failingDraftIds.has(it.draftId) && !deleted
                    ? { borderLeft: '4px solid var(--danger, #c0392b)', background: 'var(--card-warm)' }
                    : {}),
                }}
              >
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                  {mergeMode && !deleted && (
                    <input
                      type="checkbox"
                      data-testid={`merge-check-${it.draftId}`}
                      checked={mergeSel.has(it.draftId)}
                      onChange={(e) => {
                        const next = new Set(mergeSel);
                        if (e.target.checked) next.add(it.draftId);
                        else next.delete(it.draftId);
                        setMergeSel(next);
                      }}
                    />
                  )}
                  <strong>{it.qno === null ? '未编号' : `q${it.qno}`}</strong>
                  <span data-testid={`status-${it.draftId}`} className={`proof-status ${STATUS_CLASS[it.status]}`}>
                    ● {STATUS_LABEL[it.status]}
                  </span>
                  <span style={{ color: 'var(--ink-2)' }}>{it.source === 'rule' ? '规则切分' : '手动新起'}</span>
                  {it.warnings.length > 0 && <span title={it.warnings.join('\n')}>⚠{it.warnings.length}</span>}
                  {failingDraftIds.has(it.draftId) && (
                    <span data-testid={`verify-fail-${it.draftId}`} style={{ color: 'var(--danger, #c0392b)' }}>
                      ✗ 核验不过
                    </span>
                  )}
                  {it.score !== undefined && <span>分值 {it.score}</span>}
                  {ingested[it.draftId] && <span data-testid={`ingested-${it.draftId}`}>已入库（{ingested[it.draftId]}）</span>}
                </div>

                <div style={{ margin: '0.5rem 0' }}>
                  <div dangerouslySetInnerHTML={{ __html: renderProofCardHtml(it.contentHtml, it.pageNo) }} />
                  {it.answerHtml && (
                    <div style={{ color: 'var(--ink-2)' }}>
                      答案：<span dangerouslySetInnerHTML={{ __html: renderProofCardHtml(it.answerHtml, it.pageNo) }} />
                    </div>
                  )}
                  {it.analysisHtml && (
                    <div style={{ color: 'var(--ink-2)' }}>
                      解析：<span dangerouslySetInnerHTML={{ __html: renderProofCardHtml(it.analysisHtml, it.pageNo) }} />
                    </div>
                  )}
                </div>

                <details>
                  <summary>rawText（诊断/审计）</summary>
                  <pre style={{ whiteSpace: 'pre-wrap', fontSize: '12px' }}>{it.rawText}</pre>
                </details>

                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
                  {deleted ? (
                    <button data-testid={`btn-restore-${it.draftId}`} onClick={() => dispatch({ type: 'markOk', draftId: it.draftId, ok: false })}>
                      恢复
                    </button>
                  ) : (
                    <>
                      <button data-testid={`btn-edit-content-${it.draftId}`} onClick={() => setEditTarget({ draftId: it.draftId, field: 'content' })}>
                        编辑题面
                      </button>
                      <button data-testid={`btn-edit-answer-${it.draftId}`} onClick={() => setEditTarget({ draftId: it.draftId, field: 'answer' })}>
                        编辑答案
                      </button>
                      <button data-testid={`btn-edit-analysis-${it.draftId}`} onClick={() => setEditTarget({ draftId: it.draftId, field: 'analysis' })}>
                        编辑解析
                      </button>
                      <button
                        data-testid={`btn-split-${it.draftId}`}
                        onClick={() => {
                          setSplitFor(splitFor === it.draftId ? null : it.draftId);
                          setSplitText('');
                          setSplitQno('');
                          setSplitInto('');
                        }}
                      >
                        拆分
                      </button>
                      <button data-testid={`btn-delete-${it.draftId}`} onClick={() => dispatch({ type: 'delete', draftId: it.draftId })}>
                        删除
                      </button>
                      {scoreFor === it.draftId ? (
                        <span>
                          <input
                            className="input"
                            type="number"
                            data-testid={`score-input-${it.draftId}`}
                            value={scoreText}
                            onChange={(e) => setScoreText(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleScoreSubmit(it.draftId)}
                            style={{ width: '5em' }}
                          />
                          <button data-testid={`btn-score-confirm-${it.draftId}`} onClick={() => handleScoreSubmit(it.draftId)}>
                            定
                          </button>
                        </span>
                      ) : (
                        <button
                          data-testid={`btn-score-${it.draftId}`}
                          onClick={() => {
                            setScoreFor(it.draftId);
                            setScoreText(it.score?.toString() ?? '');
                          }}
                        >
                          分值
                        </button>
                      )}
                      {it.status === 'ok' ? (
                        <button data-testid={`btn-unok-${it.draftId}`} onClick={() => dispatch({ type: 'markOk', draftId: it.draftId, ok: false })}>
                          撤销通过
                        </button>
                      ) : (
                        <button data-testid={`btn-ok-${it.draftId}`} onClick={() => dispatch({ type: 'markOk', draftId: it.draftId, ok: true })}>
                          校对通过
                        </button>
                      )}
                      <button data-testid={`btn-up-${it.draftId}`} disabled={index === 0} onClick={() => setItems(moveItem(items, it.draftId, -1))}>
                        上移
                      </button>
                      <button
                        data-testid={`btn-down-${it.draftId}`}
                        disabled={index === items.length - 1}
                        onClick={() => setItems(moveItem(items, it.draftId, 1))}
                      >
                        下移
                      </button>
                    </>
                  )}
                </div>

                {splitFor === it.draftId && (
                  <div style={{ marginTop: '0.5rem', borderTop: '1px dashed var(--line-strong)', paddingTop: '0.5rem' }}>
                    <input
                      className="input"
                      data-testid={`split-input-${it.draftId}`}
                      value={splitText}
                      onChange={(e) => setSplitText(e.target.value)}
                      placeholder="断点文本（OCR 原文，首次出现处断开）"
                      style={{ width: '70%' }}
                    />
                    <input
                      className="input"
                      data-testid={`split-qno-input-${it.draftId}`}
                      value={splitQno}
                      onChange={(e) => setSplitQno(e.target.value)}
                      placeholder="新题号（原卷题号）"
                      style={{ width: '9rem', marginLeft: '0.5rem' }}
                      inputMode="numeric"
                    />
                    <button data-testid={`btn-split-confirm-${it.draftId}`} onClick={() => handleSplitConfirm(it.draftId)} style={{ marginLeft: '0.5rem' }}>
                      确认拆分
                    </button>
                    <select
                      className="select"
                      data-testid={`split-into-${it.draftId}`}
                      value={splitInto}
                      onChange={(e) => setSplitInto(e.target.value)}
                      style={{ marginLeft: '0.5rem' }}
                    >
                      <option value="">并入已有题（选填，留空则新建）</option>
                      {items
                        .filter((x) => x.draftId !== it.draftId && x.status !== 'delete')
                        .map((x) => (
                          <option key={x.draftId} value={x.draftId}>
                            {x.qno === null ? '未编号' : `q${x.qno}`}（{x.draftId}）
                          </option>
                        ))}
                    </select>
                    <div style={{ color: 'var(--ink-3)', fontSize: '12px', marginTop: '0.25rem' }}>
                      新题号填原卷真实题号（如 11）；留空则自动编号（+0.5 兜底）。断点若在解析区，拆出的是下一题的解析——可并入已有题（仅解析区拆分可用），留空则新建条目。
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* 编辑弹层（QuestionEditor lazy 加载） */}
      {editTarget && editingItem && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'var(--mask)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
          onClick={() => setEditTarget(null)}
        >
          <div
            style={{ backgroundColor: 'var(--card)', color: 'var(--ink)', padding: '1rem', width: '80vw', height: '80vh', overflow: 'auto', borderRadius: '16px' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 style={{ marginTop: 0 }}>
              编辑 {editTarget.field === 'content' ? '题面' : editTarget.field === 'answer' ? '答案' : '解析'}（{editingItem.qno === null ? '未编号' : `q${editingItem.qno}`}）
            </h2>
            <Suspense fallback={<div>编辑器加载中...</div>}>
              <QuestionEditor
                variant={editTarget.field === 'content' ? 'stem' : 'plain'}
                initialContent={
                  editTarget.field === 'content'
                    ? editingItem.contentHtml
                    : wrapForEditor(editTarget.field === 'answer' ? editingItem.answerHtml : editingItem.analysisHtml)
                }
                onSave={handleEditSave}
              />
            </Suspense>
            <button onClick={() => setEditTarget(null)} style={{ marginTop: '0.5rem' }}>
              取消
            </button>
          </div>
        </div>
      )}

      {/* 0029（只增）：AI 建议人确认弹层（录题侧最小形态；定格=页面学科，无学段维度） */}
      {aiSuggestOpen && (
        <AiSuggestDialog
          questionIds={Object.values(ingested)}
          query={{ subjectId: subject.trim() || '未分类' }}
          subjectLabel={subject.trim()}
          onClose={() => setAiSuggestOpen(false)}
          onMessage={(m) => setNotice(m.text)}
        />
      )}
    </div>
  );
}
