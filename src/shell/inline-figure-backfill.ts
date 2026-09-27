// 0056（R-064 P2）：存量「小图误判 inline-figure」一次性回填（外壳启动期跑，幂等可重入）。
//
// 为什么不在迁移 SQL 里做：回填要按「位图 + 高 >60px + 非选项区」重写 questions.content 的 HTML 结构，
// SQLite 没有 HTML 解析能力；且机制上 0057 已把「启动期 backfill」定成先例（reloadDatabase 内、幂等、
// 先备份、单题失败不中断、operation_log 留痕）——本模块照同一形状，故零迁移、零 db.ts 改动。
//
// 判据（任务书 §零.11，与采集侧 §零.10 新判定同口径）：
//   content 里被 `span.inline-figure` 包裹 **且** 位图（非 .svg）**且** 高 > 60px **且** 非选项区
//   → 还原块级 `figure.diagram`（data-w/data-h/src 逐字保留，只改包裹结构，不动资产文件与 images 列）。
//   选项区（`<div class="options">` 之后）保持行内——块级 figure 进 <span class="option"> 会破选项行版式。
//
// 纪律：本模块不碰 SQL（架构硬规则 2）——读/写一律经注入的 service 面。

import { copyFileSync, existsSync } from 'node:fs';

/** 存量题的最小读面（bank service `listQuestions` 的子集投影） */
export interface InlineFigureBackfillQuestionLike {
  id: string;
  content: string;
}

export interface InlineFigureBackfillDeps {
  listQuestions(): Promise<InlineFigureBackfillQuestionLike[]>;
  /** 题写面（只写 content 一个字段——本回填不触 assets/images/其它列） */
  updateQuestion(id: string, patch: { content?: string }): Promise<unknown>;
  /** 库文件路径（备份源） */
  dbPath: string;
  /** operation_log 面（与 bank `OperationLogger` 同名方法同签名，直接注入即可） */
  logger?: {
    logStart(operationType: string, description: string, metadata?: Record<string, unknown>): string;
    logSuccess(id: string, affectedCount: number): void;
    logFailure(id: string, error: Error): void;
  };
  warn?(message: string): void;
}

export interface InlineFigureBackfillReport {
  /** 扫到的题总数 */
  scanned: number;
  /** 含可回填 wrap 的题数 */
  candidates: number;
  /** 实际改写成功的题数 */
  changed: number;
  /** 还原为块级的图数 */
  convertedFigures: number;
  /** 选项区内保持行内的图数（拍板：不拽出文字流；只记账不动） */
  skippedOptionRegion: number;
  /** 失败题 [{ id, reason }] */
  failures: Array<{ id: string; reason: string }>;
  /** 本次是否做了备份 */
  backedUp: boolean;
}

const BACKFILL_OPERATION = 'capture.inlineFigureBackfill';

/** 行内图 wrap（形态见 question-content.ts：span.inline-figure 内恰一张 img） */
const INLINE_FIGURE_SPAN_RE = /<span\b[^>]*\bclass\s*=\s*"[^"]*\binline-figure\b[^"]*"[^>]*>\s*<img\b([^>]*)>\s*<\/span>/gi;
/** 选项区起点（契约壳 `<div class="options">`；无 = 全按题干区算） */
const OPTIONS_OPEN_RE = /<div\b[^>]*\bclass\s*=\s*"[^"]*\boptions\b[^"]*"[^>]*>/i;
/** 位图判据：非 .svg（矢量=公式类特征）即按位图处理（无扩展名同口径——不猜格式族） */
const SVG_SRC_RE = /\.svg(\?|#|$)/i;
/** 新判定阈值（与 capture/normalize.ts INLINE_IMAGE_MAX_HEIGHT_PX 同源口径） */
const INLINE_IMAGE_MAX_HEIGHT_PX = 60;

function attrOf(attrs: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attrs);
  return match ? (match[1] ?? match[2] ?? '') : null;
}

/** 单题 content 改写：命中判据的 inline-figure 还原为块级 figure.diagram（其余逐字不动） */
export function rewriteInlineFigureWraps(content: string): {
  html: string;
  converted: number;
  skippedOptionRegion: number;
} {
  if (!content || !content.includes('inline-figure')) {
    return { html: content, converted: 0, skippedOptionRegion: 0 };
  }
  const optionsAt = OPTIONS_OPEN_RE.exec(content)?.index ?? -1;
  let converted = 0;
  let skippedOptionRegion = 0;
  const html = content.replace(INLINE_FIGURE_SPAN_RE, (match, attrs: string, offset: number) => {
    const src = attrOf(attrs, 'src');
    const height = Number(attrOf(attrs, 'data-h'));
    if (!src || !Number.isFinite(height) || height <= INLINE_IMAGE_MAX_HEIGHT_PX) return match;
    if (SVG_SRC_RE.test(src)) return match;
    const next = `<figure class="diagram" data-w="${attrOf(attrs, 'data-w') ?? 0}" data-h="${height}"><img class="q-figure" src="${src}"></figure>`;
    if (optionsAt >= 0 && offset >= optionsAt) {
      skippedOptionRegion += 1; // 选项区：判定不对，但结构也不动（拍板：选项区恒行内）
      return match;
    }
    converted += 1;
    return next;
  });
  return { html, converted, skippedOptionRegion };
}

/**
 * 跑一次存量回填。返回台账（调用方打印/测试断言）。
 * 幂等：无待回填题 → 备份不落、库不写、operation_log 不写。
 */
export async function runInlineFigureBackfill(deps: InlineFigureBackfillDeps): Promise<InlineFigureBackfillReport> {
  const warn = deps.warn ?? ((message: string) => console.warn(message));

  const questions = await deps.listQuestions();
  const rewrites = questions.map((question) => ({ question, ...rewriteInlineFigureWraps(question.content ?? '') }));
  const candidates = rewrites.filter((entry) => entry.converted > 0);
  const report: InlineFigureBackfillReport = {
    scanned: questions.length,
    candidates: candidates.length,
    changed: 0,
    convertedFigures: 0,
    skippedOptionRegion: rewrites.reduce((sum, entry) => sum + entry.skippedOptionRegion, 0),
    failures: [],
    backedUp: false,
  };
  if (candidates.length === 0) return report;

  // 备份（仅在确认有待回填题后做；干净库启动不产冗余副本——0057 同口径）
  const backupPath = `${deps.dbPath}.bak-0056`;
  if (!existsSync(backupPath)) {
    copyFileSync(deps.dbPath, backupPath);
    report.backedUp = true;
  } else {
    warn(`0056 回填：备份已存在，沿用上一次的 ${backupPath}（不覆盖首个回填前快照）`);
  }

  const logId = deps.logger?.logStart(
    BACKFILL_OPERATION,
    '存量采集题小图误判回填（inline-figure → figure.diagram，位图且高 >60px 且非选项区）',
    { candidates: candidates.length, backup: backupPath },
  );

  for (const entry of candidates) {
    try {
      await deps.updateQuestion(entry.question.id, { content: entry.html });
      report.changed += 1;
      report.convertedFigures += entry.converted;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      report.failures.push({ id: entry.question.id, reason });
      warn(`0056 回填：题 ${entry.question.id} 未回填（不中断启动）：${reason}`);
    }
  }

  if (deps.logger && logId !== undefined) {
    if (report.failures.length > 0) {
      deps.logger.logFailure(logId, new Error(`${report.failures.length} 题回填失败：${report.failures.map((f) => `${f.id}: ${f.reason}`).join('；')}`));
    } else {
      deps.logger.logSuccess(logId, report.changed);
    }
  }
  return report;
}
