// 0056（R-041）：采集题 AI 整理·对照确认弹层（题库页批量入口 + 单题「整理本题」共用）。
// 0065（R-068）：补 ①解析区对照块（与答案区同构）②整理方式标签 ③403 占位图独立分组。
//
// D-050 / P-07 铁律：本弹层是 AI 整理结果的**唯一写入闸门**——preview 只产出对照（零写库），
// 逐题勾选后点「确认写入」才经 `bank.question.aiClean`(mode='commit') 落库。
// 失败题给可见标记与「重试」（重跑 preview）；跳过题（子母题/无需整理/403 占位图）显式给原因、不进确认集。
//
// 桥取用（0016 口径）：无 `window.__mofangBank.questionAiClean`（浏览器 demo/未注入）时**不做死按钮**，
// 直接以不可用态说明原因；测试注入 runner 走同一组件面。

import { useEffect, useMemo, useState } from 'react';
import type {
  QuestionAiCleanApplyMode,
  QuestionAiCleanItem,
  QuestionAiCleanResult,
} from '../../shared/contracts/ipc-channels.js';
import { createAiCleanRunner, type AiCleanRunner } from '../services/question-ai-clean-client.js';
import { renderPaperQuestionHtml } from '../pages/paper-actions.js';
import type { PageMessage } from '../pages/ExtUi.js';
import { Modal, ProgressNote } from '../pages/ExtUi.js';

export interface AiCleanDialogProps {
  questionIds: string[];
  onClose: () => void;
  /** 确认写入成功后的回调（题库页刷新列表） */
  onWritten?: () => void;
  /** 结果消息（宿主页面消息条展示；不传则弹层内自显） */
  onMessage?: (message: PageMessage) => void;
  /** 注入优先（测试双跑）；缺省取 window.__mofangBank.questionAiClean */
  runner?: AiCleanRunner;
  /** 每轮整理结束的回调（失败题 id 集）——宿主据此在题卡挂「整理失败」标记 */
  onResult?: (failedIds: string[]) => void;
}

/** 题面摘要（弹层列表标题用；纯文本，不渲图） */
function excerpt(html: string, max = 42): string {
  const text = html
    .replace(/<span\b[^>]*\sdata-tex="([^"]*)"[^>]*>\s*<\/span>/g, (_m, tex: string) => `$${tex}$`)
    .replace(/<[^>]+>/g, '')
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (m) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' }[m] ?? m))
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 资产短名（失败清单里给人看「是哪张图」） */
function shortName(src: string): string {
  const name = src.split('/').pop() ?? src;
  return name.split('?')[0] ?? name;
}

/** 0065：整理方式人读名（与契约 `QuestionAiCleanApplyMode` 一一对应） */
const MODE_LABEL: Record<QuestionAiCleanApplyMode, string> = {
  'inline-figures': '原位替换',
  'replace-field': '整字段替换',
};

/** 0065：字段人读名（弹层标签与占位图分组用） */
function fieldLabelOf(field: 'content' | 'answer' | 'analysis'): string {
  return field === 'content' ? '题面' : field === 'answer' ? '答案区' : '解析区';
}

/**
 * 0065：该题的整理方式标签串（如「解析区 原位替换 · 答案区 整字段替换」）。
 * 空串 = 无标签可显示（不该出现：有靶才有 item）。
 */
function modeSummary(item: QuestionAiCleanItem): string {
  const modes = item.fieldModes;
  if (!modes) return '';
  return (['content', 'answer', 'analysis'] as const)
    .filter((field) => modes[field] !== undefined)
    .map((field) => `${fieldLabelOf(field)} ${MODE_LABEL[modes[field]!]}`)
    .join(' · ');
}

/** 占位图人读摘要（按字段 + 资产短名 + 张数） */
function placeholderSummary(item: QuestionAiCleanItem): string {
  const list = item.placeholders ?? [];
  const groups = new Map<string, string[]>();
  for (const entry of list) {
    const field = fieldLabelOf(entry.field ?? 'answer');
    const names = groups.get(field) ?? [];
    names.push(shortName(entry.src));
    groups.set(field, names);
  }
  return [...groups.entries()]
    .map(([field, names]) => `${field} ${names.length <= 2 ? names.join('、') : `${names.slice(0, 2).join('、')} 等 ${names.length} 张`}`)
    .join('；');
}

/**
 * 返工⑧：失败清单人读摘要——**按字段分组、同因合并、带上资产短名**。
 * 真机教训（用户第二道样题）：旧的「未转写的图 8 张（保持原图）：原因；原因；原因…」把
 * 解析区 8 张图的原因原样重复 8 次，看着像程序坏了，也看不出到底是题面还是解析区。
 */
export function failureSummary(failures: Array<{ src: string; field?: 'content' | 'answer' | 'analysis'; reason: string }>): string {
  const fieldLabel = (field?: 'content' | 'answer' | 'analysis'): string =>
    field === 'analysis' ? '解析区' : field === 'answer' ? '答案区' : '题面';
  const groups = new Map<string, { field: string; names: string[]; reason: string }>();
  for (const failure of failures) {
    const field = fieldLabel(failure.field);
    const reason = failure.reason.length > 60 ? `${failure.reason.slice(0, 60)}…` : failure.reason;
    const key = `${field}\u0000${reason}`;
    const group = groups.get(key) ?? { field, names: [], reason };
    group.names.push(shortName(failure.src));
    groups.set(key, group);
  }
  const parts = [...groups.values()].map((group) => {
    const names = group.names.length <= 3
      ? group.names.join('、')
      : `${group.names.slice(0, 3).join('、')} 等 ${group.names.length} 张`;
    return `${group.field} ${names}：${group.reason}`;
  });
  return `未转写的图 ${failures.length} 张（保持原图）：${parts.join('；')}`;
}

/** 整理前后对照块（同一渲染管线：renderMath + data-assets 资产根解析） */
function FieldsBlock({ label, html, testid }: { label: string; html: string; testid: string }) {
  return (
    <div style={{ flex: '1 1 0', minWidth: 0 }}>
      <div className="field-label">{label}</div>
      <div
        className="question-content"
        data-testid={testid}
        style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '0.4rem', maxHeight: '26vh', overflowY: 'auto' }}
        dangerouslySetInnerHTML={{ __html: renderPaperQuestionHtml(html) }}
      />
    </div>
  );
}

export function AiCleanDialog(props: AiCleanDialogProps) {
  const { questionIds, onClose, onWritten, onMessage, onResult } = props;
  const runner = useMemo(() => props.runner ?? createAiCleanRunner(), [props.runner]);

  const [items, setItems] = useState<QuestionAiCleanItem[]>([]);
  const [running, setRunning] = useState(false);
  const [writing, setWriting] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  /** 返工④：批次级说明（handler 侧产出；当前一般为空） */
  const [notes, setNotes] = useState<string[]>([]);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  /** 待整理题集（重试会收窄为失败题；确认写入后不再重跑） */
  const [pending, setPending] = useState<string[]>(questionIds);
  const [attempt, setAttempt] = useState(0);

  // preview：产出逐题对照（零写库）。依赖 attempt——重试即再跑一轮
  useEffect(() => {
    if (!runner) return;
    if (pending.length === 0) return;
    let cancelled = false;
    setRunning(true);
    setFatal(null);
    runner({ mode: 'preview', questionIds: pending })
      .then((result: QuestionAiCleanResult) => {
        if (cancelled) return;
        setItems(result.items);
        setNotes(result.notes ?? []);
        // 返工④：需人工复核的题（骨架矛盾等质量闸门起疑）**默认不勾选**（人工定夺，不静默采信）
        setPicked(new Set(result.items.filter((item) => item.ok && item.needsReview !== true).map((item) => item.questionId)));
        onResult?.(result.items.filter((item) => !item.ok && item.error !== null).map((item) => item.questionId));
      })
      .catch((err) => {
        if (!cancelled) setFatal(err instanceof Error ? err.message : String(err));
      })
      .finally(() => { if (!cancelled) setRunning(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runner, attempt, pending.join('\u0000')]);

  if (!runner) {
    return (
      <Modal title="AI 整理" onClose={onClose}>
        <div data-testid="ai-clean-dialog">
          <p data-testid="ai-clean-unavailable" className="notice notice-red">
            当前环境没有 AI 整理通道（仅桌面端可用，且需先在设置页配置可用的模型档案）。
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn" data-testid="ai-clean-cancel" onClick={onClose}>关闭</button>
          </div>
        </div>
      </Modal>
    );
  }

  const failedIds = items.filter((item) => !item.ok && item.error !== null).map((item) => item.questionId);
  /**
   * 返工⑧：**需要重试的题** = 题级失败 **或** 有单图未转写——真机现场（用户第二道样题）里
   * 题级是 ok 的（8 张题面公式都转了）却有 8 张解析图未转写，旧的「仅题级失败才给重试」于是没有按钮。
   */
  const retryIds = items
    .filter((item) => (!item.ok && item.error !== null) || item.failedImages.length > 0)
    .map((item) => item.questionId);
  const reviewCount = items.filter((item) => item.ok && item.needsReview === true).length;
  const okItems = items.filter((item) => item.ok);
  const skipped = items.filter((item) => item.skipped !== null);
  /** 0065：403 占位图（站点拒绝访问）——独立分组，不混进失败清单 */
  const placeholderItems = items.filter((item) => (item.placeholders?.length ?? 0) > 0);
  const placeholderCount = placeholderItems.reduce((sum, item) => sum + (item.placeholders?.length ?? 0), 0);

  const toggle = (id: string) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const handleConfirm = async () => {
    const patches = items
      .filter((item) => item.ok && item.after !== null && picked.has(item.questionId))
      .map((item) => ({
        questionId: item.questionId,
        content: item.after!.content,
        answer: item.after!.answer,
        analysis: item.after!.analysis,
        images: item.after!.images,
      }));
    setWriting(true);
    try {
      const result = await runner({ mode: 'commit', questionIds: patches.map((p) => p.questionId), items: patches });
      const text = `AI 整理：写入 ${result.saved} 题`
        + (result.failed.length > 0 ? `，失败 ${result.failed.length} 题（${result.failed.map((f) => f.reason).join('；')}）` : '');
      onMessage?.({ type: result.failed.length > 0 ? 'error' : 'success', text });
      if (result.saved > 0) onWritten?.();
      onClose();
    } catch (err) {
      setFatal(err instanceof Error ? err.message : String(err));
    } finally {
      setWriting(false);
    }
  };

  const handleRetry = () => {
    // 重试范围 = 本轮**有失败/有未转写图**的题（返工⑧：不再只看题级失败）；没有失败题时重跑全部
    setPending(retryIds.length > 0 ? retryIds : questionIds);
    setAttempt((n) => n + 1);
  };

  return (
    <Modal title="AI 整理（整理前后对照）" onClose={onClose}>
      <div data-testid="ai-clean-dialog" style={{ maxWidth: '860px' }}>
        <p style={{ marginTop: 0, color: 'var(--ink-2)', fontSize: '0.9rem' }}>
          将题内**公式图 / 答案图**转写为文字（公式进 LaTeX），逐题确认后才落库；未勾选的题保持原样。
        </p>
        {running && <ProgressNote label={`整理中…（${pending.length} 题，逐题串行）`} testid="ai-clean-running" />}
        {notes.length > 0 && (
          <p data-testid="ai-clean-notes" className="notice" style={{ fontSize: '0.85rem' }}>
            {notes.map((note) => <span key={note}>{note}</span>)}
          </p>
        )}
        {fatal && <p data-testid="ai-clean-fatal" className="notice notice-red">{fatal}</p>}
        {/* 0065：403 占位图独立分组（站点拒绝访问）——不送引擎、不计失败，提示去站点开通权限 */}
        {placeholderItems.length > 0 && (
          <div data-testid="ai-clean-placeholders" className="notice" style={{ fontSize: '0.85rem' }}>
            <div style={{ fontWeight: 600 }}>
              占位图（站点拒绝访问）：{placeholderCount} 张 · {placeholderItems.length} 题
            </div>
            <div style={{ color: 'var(--ink-2)' }}>
              站点未返回答案/解析内容，只回了一张权限提示图——**需到站点开通权限后重新采集**
              （已跳过 AI 调用，未消耗额度；原图保持不动）。
            </div>
            <ul style={{ margin: '0.25rem 0 0 1rem' }}>
              {placeholderItems.map((item) => (
                <li key={item.questionId} data-testid={`ai-clean-placeholder-${item.questionId}`}>
                  {excerpt(item.before?.content ?? '')}：{placeholderSummary(item)}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div style={{ maxHeight: '52vh', overflowY: 'auto' }}>
          {items.map((item) => (
            <div
              key={item.questionId}
              data-testid={`ai-clean-item-${item.questionId}`}
              style={{ borderTop: '1px solid var(--line)', paddingTop: '0.5rem', marginTop: '0.5rem' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                {item.ok ? (
                  <>
                    <input
                      type="checkbox"
                      data-testid={`ai-clean-check-${item.questionId}`}
                      checked={picked.has(item.questionId)}
                      onChange={() => toggle(item.questionId)}
                    />
                    <span className="tag tag-green">转写 {item.converted} 图</span>
                    {item.needsReview === true && (
                      <span className="tag tag-brick" data-testid={`ai-clean-review-${item.questionId}`}>
                        需复核（默认未勾选）
                      </span>
                    )}
                  </>
                ) : item.skipped !== null ? (
                  <span className="tag" data-testid={`ai-clean-skip-${item.questionId}`}>跳过：{item.skipped}</span>
                ) : (
                  <span className="tag tag-brick" data-testid={`ai-clean-fail-${item.questionId}`}>
                    整理失败：{item.error}
                  </span>
                )}
                <span style={{ flex: 1, minWidth: 0, color: 'var(--ink-2)', fontSize: '0.85rem' }}>
                  {excerpt(item.before?.content ?? '')}
                </span>
                {/* 0065：整理方式标签（解析区 原位替换 / 答案区 整字段替换）——让人知道这次动了什么 */}
                {modeSummary(item) !== '' && (
                  <span className="tag" data-testid={`ai-clean-modes-${item.questionId}`}>{modeSummary(item)}</span>
                )}
                {((!item.ok && item.error !== null) || item.failedImages.length > 0) && (
                  <button
                    className="btn btn-sm"
                    data-testid={`ai-clean-retry-${item.questionId}`}
                    title="重试本轮有失败/有未转写图的题（重新跑一遍整理）"
                    onClick={handleRetry}
                    disabled={running}
                  >
                    重试
                  </button>
                )}
              </div>
              {item.failedImages.length > 0 && (
                <div data-testid={`ai-clean-failed-${item.questionId}`} style={{ color: 'var(--ink-3)', fontSize: '0.8rem', marginTop: '0.25rem' }}>
                  {failureSummary(item.failedImages)}
                </div>
              )}
              {item.deferred !== undefined && item.deferred.length > 0 && (
                <div data-testid={`ai-clean-deferred-${item.questionId}`} style={{ color: 'var(--ink-3)', fontSize: '0.8rem', marginTop: '0.25rem' }}>
                  本批未处理 {item.deferred.length} 张（保持原图）：{item.deferred[0]?.reason ?? ''}
                </div>
              )}
              {item.warnings.map((text) => (
                <div key={text} style={{ color: 'var(--brick)', fontSize: '0.8rem', marginTop: '0.25rem' }}>⚠ {text}</div>
              ))}
              {item.ok && item.after && (
                <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.35rem' }}>
                  <FieldsBlock label="整理前" html={item.before?.content ?? ''} testid={`ai-clean-before-${item.questionId}`} />
                  <FieldsBlock label="整理后（题干）" html={item.after.content} testid={`ai-clean-after-${item.questionId}`} />
                </div>
              )}
              {item.ok && item.after && (item.after.answer || item.before?.answer) && (
                <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.35rem' }}>
                  <FieldsBlock label="整理前（答案）" html={item.before?.answer ?? ''} testid={`ai-clean-before-answer-${item.questionId}`} />
                  <FieldsBlock label="整理后（答案）" html={item.after.answer} testid={`ai-clean-after-answer-${item.questionId}`} />
                </div>
              )}
              {/* 0065：解析区对照块（与答案区同构）——原位替换后正文可逐字核对 */}
              {item.ok && item.after && (item.after.analysis || item.before?.analysis) && (
                <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.35rem' }}>
                  <FieldsBlock label="整理前（解析）" html={item.before?.analysis ?? ''} testid={`ai-clean-before-analysis-${item.questionId}`} />
                  <FieldsBlock label="整理后（解析）" html={item.after.analysis} testid={`ai-clean-after-analysis-${item.questionId}`} />
                </div>
              )}
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '0.75rem' }}>
          <span style={{ flex: 1, color: 'var(--ink-3)', fontSize: '0.85rem' }}>
            {running
              ? '整理中…'
              : `待写入 ${okItems.filter((i) => picked.has(i.questionId)).length} 题`
                + (reviewCount > 0 ? ` · 待复核 ${reviewCount} 题` : '')
                + (failedIds.length > 0 ? ` · 失败 ${failedIds.length} 题` : '')
                + (skipped.length > 0 ? ` · 跳过 ${skipped.length} 题` : '')}
          </span>
          {retryIds.length > 0 && (
            <button
              className="btn"
              data-testid="ai-clean-retry-failed"
              title="重试本轮有失败/有未转写图的题（重新跑一遍整理）"
              onClick={handleRetry}
              disabled={running}
            >
              重试未转写的图（{retryIds.length} 题）
            </button>
          )}
          <button className="btn" data-testid="ai-clean-cancel" onClick={onClose}>取消</button>
          <button
            className="btn btn-primary"
            data-testid="ai-clean-confirm"
            disabled={running || writing || okItems.filter((i) => picked.has(i.questionId)).length === 0}
            onClick={() => void handleConfirm()}
          >
            确认写入
          </button>
        </div>
      </div>
    </Modal>
  );
}
