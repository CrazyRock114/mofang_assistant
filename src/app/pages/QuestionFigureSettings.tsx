// 0004 Phase 5（U4 v1）：题级图排版覆盖设置弹层（排版间题卡「图片设置」入口打开）。
// fix-3 P0-1（目检 #2a）列表数据源放宽：题内全部"可参与图"（content 中非公式/答案/解析图，
// 含裸行内图）+ 已覆盖条目（含外来图）均显示。
// 0004-fix-4 #7（目检 #7「依旧只有部分图可调」）：引擎默认全可调（非公式/答案/解析语义图一律参与块化）
// → 弹层内条目恒为已参与，「未参与/加入排版」灰态机制退役；「移除」仅对外来图开放。
// 每图可调：版式（跟随全局/随文流/右栏）、对齐（跟随全局/左中右）、图宽（空=跟随全局/默认档）、
// 上移/下移（orderIndex=列表序）。
// 保存 = setQuestionLayouts 整体覆盖式写入（figures 全量 + orderIndex=数组序）。

import { useState } from 'react';
import type { Question, QuestionFigureLayout } from '../../shared/contracts/bank-types.js';
import { contentAssetIds, listAdjustableAssets } from './paper-actions.js';

export interface QuestionFigureSettingsProps {
  question: Question;
  /** 当前已保存的题级覆盖（ref.layout?.figures；undefined=未覆盖） */
  current?: QuestionFigureLayout[];
  onCancel: () => void;
  onSave: (layout: { figures: QuestionFigureLayout[] }) => Promise<void>;
}

/** 弹层内的条目（编辑态：空字符串=未覆盖该维度，保存时剔除） */
interface FigureEntry {
  assetId: string;
  /** 外来图（content 无引用，仅存在于覆盖中）：移除条目=整图移除；题内图移除条目无意义（引擎默认参与） */
  foreign: boolean;
  /** figure 语义图（题内已登记）：观感提示用 */
  semanticFigure: boolean;
  mode: '' | 'inline' | 'side-by-side';
  align: '' | 'left' | 'center' | 'right';
  widthText: string;
}

/**
 * 已保存覆盖 + 题内可参与图全集 → 编辑条目。
 * 0004-fix-4 #7（目检 #7）：引擎默认全可调（非公式/答案/解析语义图一律参与块化），
 * 故列表内条目**恒为已参与**——不再有「未参与/加入排版」灰态（该机制随默认全可调退役）。
 */
function toEntries(question: Question, current: QuestionFigureLayout[] | undefined): FigureEntry[] {
  const byAsset = new Map<string, QuestionFigureLayout>();
  for (const f of current ?? []) byAsset.set(f.assetId, f);
  const semanticById = new Map((question.images ?? []).map((img) => [img.assetId, img.type] as const));
  const contentAssets = new Set(contentAssetIds(question));
  return listAdjustableAssets(question, current).map((assetId) => {
    const f = byAsset.get(assetId);
    return {
      assetId,
      foreign: !contentAssets.has(assetId),
      semanticFigure: semanticById.get(assetId) === 'figure',
      mode: f?.mode ?? '',
      align: f?.align ?? '',
      widthText: f?.widthPercent === undefined ? '' : String(f.widthPercent),
    };
  });
}

export function QuestionFigureSettings({ question, current, onCancel, onSave }: QuestionFigureSettingsProps) {
  const [entries, setEntries] = useState<FigureEntry[]>(() => toEntries(question, current));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 参数调整即写覆盖（默认全可调后无「加入」概念，改值直接落条目） */
  const patchEntry = (index: number, p: Partial<FigureEntry>) => {
    setEntries((prev) => prev.map((e, i) => (i === index ? { ...e, ...p } : e)));
  };

  /** 移除外来图条目（题内图不提供移除：引擎默认参与，删条目也变不回文本流） */
  const remove = (index: number) => {
    setEntries((prev) => {
      const entry = prev[index];
      if (!entry || !entry.foreign) return prev;
      return prev.filter((_, i) => i !== index);
    });
  };

  /** 上移/下移（列表序 = orderIndex 序） */
  const move = (index: number, delta: -1 | 1) => {
    setEntries((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const save = async () => {
    // 0004-fix-4 #7：列表条目恒为已参与（引擎默认全可调）→ 全量落覆盖；orderIndex=列表序
    const figures: QuestionFigureLayout[] = entries.map((e, i) => {
      const fig: QuestionFigureLayout = { assetId: e.assetId, orderIndex: i };
      if (e.mode) fig.mode = e.mode;
      if (e.align) fig.align = e.align;
      if (e.widthText.trim() !== '') {
        const v = parseFloat(e.widthText);
        if (isNaN(v) || v <= 0 || v > 100) {
          setError(`第 ${i + 1} 张图的宽度需为 (0,100] 的数值，或清空表示默认`);
          throw new Error('invalid');
        }
        fig.widthPercent = v;
      }
      return fig;
    });
    setSaving(true);
    setError(null);
    try {
      await onSave({ figures });
    } finally {
      setSaving(false);
    }
  };

  const hasEntries = entries.length > 0;

  /** 0018 目检返工二：弹层内插入本地图（题尾追加为外来图条目，保存后落覆盖） */
  const hasFileBridge = typeof window !== 'undefined' && Boolean(window.__mofangFile);
  const insertImage = async () => {
    try {
      const asset = await window.__mofangFile!.pickLogoImage();
      if (!asset) return;
      setEntries((prev) => [
        ...prev,
        { assetId: asset.relPath, foreign: true, semanticFigure: false, mode: '', align: '', widthText: '' },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div data-testid="figure-settings">
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
        <span style={{ color: 'var(--ink-3)', fontSize: '0.8rem' }}>图片列表（调版式/图宽/排序，保存后生效）</span>
        <span style={{ flex: 1 }} />
        {hasFileBridge && (
          <button type="button" className="btn btn-sm" data-testid="figure-insert-btn" onClick={() => void insertImage()}>
            插入图片…
          </button>
        )}
      </div>
      {!hasEntries && (
        <p style={{ color: 'var(--ink-3)' }}>
          该题暂无配图条目——点「插入图片…」添加，或由题内图片自动参与（公式/答案/解析图留文本流）
        </p>
      )}
      {entries.length > 0 && (
        <ol style={{ padding: 0, margin: 0, listStyle: 'none' }}>
          {entries.map((entry, i) => (
            <li
              key={entry.assetId}
              data-testid={`figure-row-${i}`}
              style={{
                border: '1px solid var(--line)',
                borderRadius: '4px',
                padding: '0.5rem',
                marginBottom: '0.5rem',
                backgroundColor: 'var(--card)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.4rem' }}>
                <strong>图 {i + 1}</strong>
                {entry.foreign && (
                  <span data-testid={`figure-foreign-tag-${i}`} style={{ color: 'var(--orange-deep)', fontSize: '0.75rem' }}>外来图</span>
                )}
                <span style={{ color: 'var(--ink-2)', fontSize: '0.8rem', wordBreak: 'break-all' }}>{entry.assetId}</span>
                <span style={{ flex: 1 }} />
                <button data-testid={`figure-up-${i}`} disabled={i === 0} onClick={() => move(i, -1)} title="上移">↑</button>
                <button data-testid={`figure-down-${i}`} disabled={i === entries.length - 1} onClick={() => move(i, 1)} title="下移">↓</button>
                {entry.foreign && (
                  <button data-testid={`figure-remove-${i}`} onClick={() => remove(i)} title="移除外来图（题内图由引擎默认参与，删条目变不回文本流）" style={{ color: 'var(--brick)' }}>
                    移除
                  </button>
                )}
              </div>
              <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
                <label>
                  版式{' '}
                  <select className="select"
                    data-testid={`figure-mode-${i}`}
                    value={entry.mode}
                    onChange={(e) => patchEntry(i, { mode: e.target.value as FigureEntry['mode'] })}
                  >
                    <option value="">跟随全局</option>
                    <option value="inline">单独成行（插在文中）</option>
                    <option value="side-by-side">图文并排（文左图右）</option>
                  </select>
                </label>
                <label>
                  对齐{' '}
                  <select className="select"
                    data-testid={`figure-align-${i}`}
                    value={entry.align}
                    onChange={(e) => patchEntry(i, { align: e.target.value as FigureEntry['align'] })}
                  >
                    <option value="">跟随全局</option>
                    <option value="left">左</option>
                    <option value="center">居中</option>
                    <option value="right">右</option>
                  </select>
                </label>
                <label>
                  宽%{' '}
                  <input className="input"
                    data-testid={`figure-width-${i}`}
                    type="number"
                    value={entry.widthText}
                    placeholder="默认档"
                    onChange={(e) => patchEntry(i, { widthText: e.target.value })}
                    style={{ width: 72, padding: '0.2rem 0.35rem' }}
                  />
                </label>
              </div>
            </li>
          ))}
        </ol>
      )}
      {error && <p style={{ color: 'var(--brick)', margin: '0.4rem 0' }}>{error}</p>}
      <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
        <button onClick={onCancel}>取消</button>
        {entries.length > 0 && (
          <button
            data-testid="figure-save-btn"
            disabled={saving}
            onClick={() => {
              save().catch(() => {/* 校验错误已在表单内展示 */});
            }}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        )}
      </div>
    </div>
  );
}
