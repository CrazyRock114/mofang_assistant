// C1 Phase 0: 校对页 UI 契约（依据任务书 C1 锚定清单冻结，只读既有契约类型，不改既有文件）

// ===== 校对会话 =====
export interface ProofSession {
  // 一份卷的一次校对会话（状态在 renderer 内存，不落库）
  paperId: string; // bank Paper.id（入库目标试卷）
  paperTitle: string;
  sourcePages: number[]; // 参与页（1-based，可切片）
  drafts: ProofItem[]; // 当前校对列表（顺序 = 题号）
  warnings: string[]; // 引擎级警告（页级异常/页眉噪声）
}

// ===== 校对条目（一项 = 一道题的草稿 + 校对状态）=====
export interface ProofItem {
  draftId: string; // 稳定 id：`{pageNo}-{qno}`（对齐 RecognizedQuestion.id）
  pageNo: number;
  /**
   * 0046（只增放宽 number → number | null，逐处申报）：ScanDraft.qno 同步放 null 后，
   * 一步到位草稿（recog.draft.write 写回）的题号原文无法映射数字时为 null（显示「未编号」，
   * 不造假号）。0036 规则链产物恒为 number，行为不变。
   */
  qno: number | null;
  source: 'rule' | 'manual'; // rule=规则切分草稿；manual=校对页内新起题
  contentHtml: string; // 对齐 question-content 契约（<div class="question">…）
  answerHtml?: string;
  analysisHtml?: string;
  imageRefIds: string[]; // 本题目图引用（pageNo 来自 imageRef）
  score?: number;
  status: 'pending' | 'ok' | 'split' | 'merge' | 'delete';
  warnings: string[]; // 本条目级警告
  rawText: string; // 原始 OCR 文本（诊断/审计，readonly）
}

// ===== 校对页动作（renderer 内部状态迁移，不落库；只有「入库」走 bank）=====
// item 状态机：pending → ok/split/merge/delete；split/merge 产生新 ProofItem（source:'manual'）
export type ProofAction =
  | { type: 'split'; draftId: string; atText: string; newQno?: number; intoDraftId?: string } // 在某文本处拆出子题；newQno=用户填的原卷题号，缺省保持 +0.5 兜底；断点落在解析区时拆出的是"下一题的解析"：intoDraftId 提供则并入该已有条目（不新建、不校验撞号），缺省则新建条目且解析落 analysisHtml
  | { type: 'merge'; draftIds: string[]; intoId: string } // 合并多项
  | { type: 'delete'; draftId: string }
  | { type: 'markOk'; draftId: string; ok: boolean } // 校对通过/撤销
  | { type: 'rescore'; draftId: string; score?: number };

// ===== 校对页渲染输入 =====
export interface ProofPageInput {
  // 一份卷的完整校对输入（recog 管线输出）
  pages: Array<{ pageNo: number; imagePath: string; ocrText: string }>; // 原卷页图路径 + 页 OCR 文本
  items: ProofItem[]; // 预置草稿（规则切分结果；无则空）
  warnings: string[];
}

// ===== 入库（对齐 C0 ingest 契约）=====
// ProofItem 经确认后 → src/recog/ingest.ts buildIngestInputs 同款映射 → bank createQuestion
