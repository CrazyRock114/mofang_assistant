// 0057 P4：存量录题内联图资产化 backfill（一次性；外壳启动期跑，幂等可重入）。
//
// 为什么不在迁移 SQL 里做（任务书 §0.6）：`data-assets` 是文件系统资产，SQLite 无 base64 解码与
// 文件写能力，存量题必须「取字节 → 写 data/assets/recog/ → 改库」三步，只有主进程能全程做。
// 故 0015 是口径占位迁移，真实回填在本模块——由 `main.ts reloadDatabase()`（openDatabase 之后）调用，
// 挂在这里才能覆盖「恢复旧备份后再升版」场景（guard restore 同样走 reloadDatabase）。
//
// 纪律：
//   - 本模块**不碰 SQL**（技术架构硬规则 2「bank-core 唯一碰 SQL」）：读/写一律经注入的 service 面；
//   - 幂等：全库扫不到内联 data URL 即 no-op——第二次启动零库写入、零文件写入、零 operation_log；
//   - 单题失败不中断启动：逐题 try/catch，失败记 warning 并计入台账（run 级 operation_log 记 failed）；
//   - 备份：仅在**确认有待迁移题**之后做文件级复制 data/bank.db.bak-0057（0039 先例口径），
//     干净库启动不产生 34MB 冗余副本；
//   - 新入库形态与录题链同口径：`data-assets/recog/<文件>` 相对引用 + `questions.images`
//     条目 `{assetId（带前缀）, type:'figure'}`（任务书 §一 P2.9）。

import { copyFileSync, existsSync } from 'node:fs';
import type { QuestionImage } from '../shared/contracts/bank-types.js';
import { saveRecogImageDataUrl, type SaveRecogImageResult } from './recog-image-store.js';

/** 存量题的最小读面（bank service `listQuestions` 的子集投影） */
export interface BackfillQuestionLike {
  id: string;
  content: string;
  answer?: string;
  analysis?: string;
  images?: QuestionImage[];
}

export interface BackfillDeps {
  /** 题读面（bank service；含 content/answer/analysis/images 全量） */
  listQuestions(): Promise<BackfillQuestionLike[]>;
  /** 题写面（一次 UPDATE 写全三字段 + images） */
  updateQuestion(id: string, patch: {
    content?: string;
    answer?: string;
    analysis?: string;
    images?: QuestionImage[];
  }): Promise<unknown>;
  /** userData/data 目录（资产落 assets/recog/） */
  dataDir: string;
  /** 库文件路径（备份源） */
  dbPath: string;
  /** 落盘注入（缺省用 recog-image-store 的真实实现；测试可换假实现） */
  saveImage?(dataUrl: string): SaveRecogImageResult;
  /** operation_log 留痕（无变更/无失败时零调用） */
  /** operation_log 面（与 bank `OperationLogger` 同名方法同签名，直接注入即可） */
  logger?: {
    logStart(operationType: string, description: string, metadata?: Record<string, unknown>): string;
    logSuccess(id: string, affectedCount: number): void;
    logFailure(id: string, error: Error): void;
  };
  warn?(message: string): void;
}

export interface BackfillReport {
  /** 扫到的题总数 */
  scanned: number;
  /** 含可迁移内联图（base64）的题数 */
  candidates: number;
  /** 含非 base64 内联图（如 mock 演示题的 `data:image/svg+xml,%3Csvg…`）被跳过的题数——不动，只记账 */
  skippedNonBase64: number;
  /** 实际改写成功的题数 */
  changed: number;
  /** 落盘图片数 */
  persistedFiles: number;
  /** 失败题 [{ id, reason }] */
  failures: Array<{ id: string; reason: string }>;
  /** 本次是否做了备份 */
  backedUp: boolean;
}

/**
 * 可迁移内联图：**必须是 base64 载荷**。录题链产物（canvas toDataURL / FileReader.readAsDataURL）
 * 恒为 base64；非 base64 的 data URL（mock 演示题那种 `%3Csvg…` 内联 SVG）不在迁移集（任务书 §0.4
 * 明确不动），也无法解码落盘——筛掉即不会走到失败分支，启动幂等不被它们污染。
 */
const INLINE_IMAGE_SRC_RE = /\bsrc\s*=\s*(?:"(data:image\/[a-zA-Z0-9.+-]+;base64,[^"]*)"|'(data:image\/[a-zA-Z0-9.+-]+;base64,[^']*)')/g;
/** 任意内联图（含非 base64）——只用于「被跳过的题」计数 */
const ANY_INLINE_IMAGE_SRC_RE = /\bsrc\s*=\s*(?:"(data:image\/[^"]*)"|'(data:image\/[^']*)')/g;
/** 改写后的存储形态引用（生成 images 条目用） */
const STORED_SRC_RE = /\bsrc\s*=\s*(?:"data-assets\/([^"]*)"|'data-assets\/([^']*)')/g;

const BACKFILL_OPERATION = 'recog.imageAssetsBackfill';

/** 单字段改写：把 HTML 里的内联 data URL 落资产并换成 `data-assets/recog/…` */
function rewriteField(
  html: string,
  saveImage: (dataUrl: string) => SaveRecogImageResult,
): { html: string; replaced: number; reasons: string[] } {
  const hits = [...html.matchAll(INLINE_IMAGE_SRC_RE)].map((m) => m[1] ?? m[2] ?? '');
  const unique = [...new Set(hits)];
  if (unique.length === 0) return { html, replaced: 0, reasons: [] };

  const byDataUrl = new Map<string, string>();
  const reasons: string[] = [];
  for (const dataUrl of unique) {
    try {
      const asset = saveImage(dataUrl);
      byDataUrl.set(dataUrl, `data-assets/${asset.relPath}`);
    } catch (err) {
      // 单图失败：该字段整体判失败（题级 catch 记账），不产出半截改写
      reasons.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (reasons.length > 0) return { html, replaced: 0, reasons };

  let out = html;
  for (const [dataUrl, src] of byDataUrl) {
    out = out.split(`"${dataUrl}"`).join(`"${src}"`).split(`'${dataUrl}'`).join(`'${src}'`);
  }
  return { html: out, replaced: byDataUrl.size, reasons: [] };
}

/** 从改写后的 content 里取资产引用 → `questions.images` 条目（与录题链同口径：assetId 带前缀、type='figure'） */
function imagesOfHtml(html: string, existing: QuestionImage[]): QuestionImage[] {
  const out = [...existing];
  for (const match of html.matchAll(STORED_SRC_RE)) {
    const rel = match[1] ?? match[2] ?? '';
    if (rel === '') continue;
    const assetId = `data-assets/${rel}`;
    if (!out.some((entry) => entry.assetId === assetId)) out.push({ assetId, type: 'figure' });
  }
  return out;
}

/** 该题的哪些字段含内联图（空数组 = 不需要迁移） */
function inlineFieldsOf(question: BackfillQuestionLike): Array<'content' | 'answer' | 'analysis'> {
  return fieldsMatching(question, INLINE_IMAGE_SRC_RE);
}

/** 该题是否含任意形态的内联图（含非 base64；用于「被跳过」计数） */
function hasAnyInlineFieldOf(question: BackfillQuestionLike): boolean {
  return fieldsMatching(question, ANY_INLINE_IMAGE_SRC_RE).length > 0;
}

function fieldsMatching(
  question: BackfillQuestionLike,
  pattern: RegExp,
): Array<'content' | 'answer' | 'analysis'> {
  const fields: Array<'content' | 'answer' | 'analysis'> = [];
  for (const field of ['content', 'answer', 'analysis'] as const) {
    const value = question[field];
    if (typeof value === 'string' && [...value.matchAll(pattern)].length > 0) {
      fields.push(field);
    }
  }
  return fields;
}

/**
 * 跑一次存量回填。返回台账（调用方打印/测试断言）。
 * 幂等：无待迁移题 → 备份不落、库不写、operation_log 不写。
 */
export async function runRecogImageBackfill(deps: BackfillDeps): Promise<BackfillReport> {
  const saveImage = deps.saveImage ?? ((dataUrl: string) => saveRecogImageDataUrl(deps.dataDir, { dataUrl }));
  const warn = deps.warn ?? ((message: string) => console.warn(message));

  const questions = await deps.listQuestions();
  const candidates = questions.filter((question) => inlineFieldsOf(question).length > 0);
  // 非 base64 内联图的题（mock 演示题）：明确不动，只计数（与候选集互斥）
  const skippedNonBase64 = questions.filter((question) => hasAnyInlineFieldOf(question) && inlineFieldsOf(question).length === 0).length;
  const report: BackfillReport = {
    scanned: questions.length,
    candidates: candidates.length,
    skippedNonBase64,
    changed: 0,
    persistedFiles: 0,
    failures: [],
    backedUp: false,
  };
  if (candidates.length === 0) return report;

  // 备份（仅在确认有待迁移题后做；干净库启动不产冗余副本）
  const backupPath = `${deps.dbPath}.bak-0057`;
  if (!existsSync(backupPath)) {
    copyFileSync(deps.dbPath, backupPath);
    report.backedUp = true;
  } else {
    warn(`0057 backfill：备份已存在，沿用上一次的 ${backupPath}（不覆盖首个迁移前快照）`);
  }

  const logId = deps.logger?.logStart(BACKFILL_OPERATION, '存量录题内联图资产化（content/answer/analysis → data-assets/recog）', {
    candidates: candidates.length,
    backup: backupPath,
  });

  for (const question of candidates) {
    try {
      const patch: Parameters<BackfillDeps['updateQuestion']>[1] = {};
      let replaced = 0;
      for (const field of inlineFieldsOf(question)) {
        const original = question[field] as string;
        const rewritten = rewriteField(original, saveImage);
        if (rewritten.reasons.length > 0) {
          throw new Error(`${field} 图落盘失败：${rewritten.reasons.join('；')}`);
        }
        if (rewritten.replaced > 0) {
          patch[field] = rewritten.html;
          replaced += rewritten.replaced;
        }
      }
      if (replaced === 0) continue;
      // images：保留既有条目，补上 content 里新出现的资产引用（题内图语义 type='figure'）
      const nextContent = patch.content ?? question.content;
      patch.images = imagesOfHtml(nextContent, question.images ?? []);
      await deps.updateQuestion(question.id, patch);
      report.changed += 1;
      report.persistedFiles += replaced;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      report.failures.push({ id: question.id, reason });
      warn(`0057 backfill：题 ${question.id} 未回填（不中断启动）：${reason}`);
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
