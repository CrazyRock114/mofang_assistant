// 0046 P5.1：一步到位草稿 → 0028 校对草稿转换（OnestepDraft[] → ScanDraft[]，纯函数无 IO）。
//
// 用途（P6.3 换档落地，D-064）：AI 工作台识别出的 Onestep 草稿经 recog.draft.write 写回 run
// 目录 drafts.json 后，#/proof/<runId>（0036 呈现层，零改动目标）经既有 recog.run.status 读口
// 即可读出草稿。渲染一律复用 `markdown.ts` 的渲染件（与 draftToCard 同源，不引第二套），
// 故题干公式/块级图/选项行内图的落法与题卡完全一致。
//
// qno 降级口径（任务书 P5.1 逐字）：取首个整数，取不到（如 "2-17"、null）落 null——
// ScanDraft.qno 契约已放宽为 number | null（recog-types.ts，0046 授权清单内）；
// 降级发生时在该题 warnings 明示（0042 null 纪律：显式降级不静默）。

import type { ScanDraft } from '../../shared/contracts/recog-types.js';
import type { OnestepDraft } from '../../shared/contracts/onestep-types.js';
import {
  composeCardContentHtml,
  stemMarkdownToHtml,
  textMarkdownToHtml,
  type MarkdownRenderOptions,
} from './markdown.js';

/**
 * 题号原文 → 数字卷内题号。
 * 「取首个整数」= 整串恰只含一个整数段时取它（"17" / "第17题" / "17." → 17）；
 * 复合形态（"2-17"，两段数字无法唯一定位卷内题号）与 null / 无数字 → null，不猜。
 */
export function qnoToNumber(qno: string | null): number | null {
  if (qno === null) return null;
  const segments = qno.match(/\d+/g);
  if (!segments || segments.length !== 1) return null;
  const n = Number(segments[0]);
  return Number.isSafeInteger(n) ? n : null;
}

export interface ToScanDraftsOptions extends MarkdownRenderOptions {
  /** 草稿归属页号（ScanDraft.pageNo 必填；Onestep 草稿本身不带页号，由调用方按框选/页上下文给） */
  pageNo?: number;
}

/** 单题转换（qno 降级告警并入该题 warnings） */
export function onestepToScanDraft(draft: OnestepDraft, options: ToScanDraftsOptions = {}): ScanDraft {
  const renderOptions: MarkdownRenderOptions = {
    ...(options.figureSrc ? { figureSrc: options.figureSrc } : {}),
    ...(options.figureSize ? { figureSize: options.figureSize } : {}),
  };
  const stemHtml = stemMarkdownToHtml(draft.stemMarkdown, renderOptions);
  const contentHtml = composeCardContentHtml(stemHtml, draft.options, renderOptions);
  const answerHtml = draft.answerMarkdown === null ? undefined : textMarkdownToHtml(draft.answerMarkdown);
  const analysisHtml = draft.analysisMarkdown === null ? undefined : textMarkdownToHtml(draft.analysisMarkdown);
  const qno = qnoToNumber(draft.qno);
  const warnings = [...draft.warnings];
  if (draft.qno !== null && qno === null) {
    warnings.push(`原卷题号「${draft.qno}」无法映射为数字题号，校对页显示为未编号`);
  }
  // 诊断/审计原始文本：题干 + 选项 + 答案/解析聚合（Onestep 层没有逐块 rawText，此处保真聚合）
  const rawText = [
    draft.stemMarkdown,
    ...(draft.options ?? []).map((o) => `${o.label}. ${o.content}`),
    ...(draft.answerMarkdown !== null ? [draft.answerMarkdown] : []),
    ...(draft.analysisMarkdown !== null ? [draft.analysisMarkdown] : []),
  ].join('\n');
  return {
    pageNo: options.pageNo ?? 1,
    qno,
    contentHtml,
    ...(answerHtml !== undefined ? { answerHtml } : {}),
    ...(analysisHtml !== undefined ? { analysisHtml } : {}),
    imageRefIds: draft.figures.map((f) => f.ref),
    rawText,
    warnings,
  };
}

/** 批量转换（host 侧 recog.draft.write 用；renderer 复用同一口径） */
export function onestepToScanDrafts(drafts: OnestepDraft[], options: ToScanDraftsOptions = {}): ScanDraft[] {
  return drafts.map((draft) => onestepToScanDraft(draft, options));
}
