// C0 Phase 4: bank 入库适配薄层（决策 §7）
// recognition 不碰 SQL：只产出可入库的 Omit<Question,'id'|'createdAt'|'updatedAt'>，
// 由上层走 bank-core service（createQuestion）。sourceType 固定 'local'（schema CHECK 约束），
// sourceDetail 记 { origin, pageNo, qno, paperTitle? }（对齐 B1 手录题 { origin: 'manual' } 模式）。
//
// 0036（只增）：origin 由调用方指定——校对页同一条链服务两条来路：
//   'scan'     = 拍照/截图识别（0028 原口径，缺省值，行为零变化）
//   'pdf-split'= PDF 切题工作区（0036 / R-027；溯源要能区分「拍的」与「整本 PDF 里切的」）

import type { Question } from '../shared/contracts/bank-types.js';
import type { ScanDraft } from '../shared/contracts/recog-types.js';

export type IngestInput = Omit<Question, 'id' | 'createdAt' | 'updatedAt'>;

/** 入库来源标记（sourceDetail.origin 的自由键取值；新增取值不违反契约「只增」） */
export type IngestOrigin = 'scan' | 'pdf-split';

export interface IngestOptions {
  subject: string;
  paperTitle?: string;
  /** 缺省 'scan'（0028 口径）；PDF 切题工作区传 'pdf-split' */
  origin?: IngestOrigin;
}

export function buildIngestInputs(drafts: ScanDraft[], opts: IngestOptions): IngestInput[] {
  return drafts.map((draft) => ({
    subject: opts.subject,
    sourceType: 'local',
    sourceDetail: {
      origin: opts.origin ?? 'scan',
      pageNo: draft.pageNo,
      qno: draft.qno,
      ...(opts.paperTitle !== undefined ? { paperTitle: opts.paperTitle } : {}),
    },
    content: draft.contentHtml,
    ...(draft.answerHtml !== undefined ? { answer: draft.answerHtml } : {}),
    ...(draft.analysisHtml !== undefined ? { analysis: draft.analysisHtml } : {}),
    // 0002 契约：images 结构化。OCR 链路无图语义差异，校对页默认题干插图 figure（schema 草案 §7）
    images: draft.imageRefIds.map((id) => ({ assetId: id, type: 'figure' as const })),
  }));
}
