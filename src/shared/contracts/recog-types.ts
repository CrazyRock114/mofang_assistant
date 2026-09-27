// C0 Phase 0: recognition 识别管线契约（依据任务书 C0 锚定清单冻结，只增不改既有契约）

// ===== OCR provider 抽象（决策 §4）=====
export interface OcrPageResult {
  pageNo: number;          // 1-based
  text: string;            // 页面 markdown 文本（含 LaTeX 与图位标记，原样透传）
  images: OcrImageRef[];   // 页内图片引用（bbox + 原卷裁图载体）
  model?: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  raw?: unknown;           // provider 原始响应（诊断用，不参与契约逻辑）
}
export interface OcrImageRef {
  id: string;              // 稳定 id，供题目图片引用
  pageNo: number;
  bbox: { x: number; y: number; w: number; h: number };  // 原卷坐标（px @150dpi）
  alt?: string;
}
export interface OcrProvider {
  readonly name: string;              // 'siliconflow-deepseek' | 'siliconflow-paddle' | 'mock'
  ocrPage(image: { data: Uint8Array; pageNo: number; mime?: string }): Promise<OcrPageResult>;
  dispose?(): Promise<void>;
}
export interface OcrProviderFactory {
  create(opts: { apiKey?: string; model?: string; baseUrl?: string }): OcrProvider;
}

// ===== 切分（决策 §5：规则为主 + AI 精修；本 C0 只做规则切分）=====
export type QuestionBlockType = 'question' | 'option' | 'answer' | 'analysis' | 'image';
export interface QuestionBlock {
  id: string;                    // 页内稳定 id：`{pageNo}-{qno}-{kind}-{idx}`
  type: QuestionBlockType;
  text: string;                  // markdown/LaTeX 文本
  imageRefId?: string;           // type==='image' 时指向 OcrImageRef.id
}
export interface RecognizedQuestion {
  id: string;                    // `{pageNo}-{qno}`
  pageNo: number;
  qno: number;                   // 卷内题号（可跨页）
  blocks: QuestionBlock[];       // 有序（题面→选项→…）
  imageRefIds: string[];         // 本题目全部图引用
  rawText: string;               // 本题规则切分的原始文本（诊断/审计）
}
export interface PageSegmentation {
  pageNo: number;
  questions: RecognizedQuestion[];
  skipped: { rawText: string; reason: string }[];   // 无法归入任何题的文本（页眉/页脚/说明）
}
export interface SegmentationResult {
  pages: PageSegmentation[];
  warnings: string[];
}
export interface RuleSegmenter {
  /** 输入：页面 OCR 文本（决策 §5 已定：规则为主，AI 仅精修，本 C0 无 AI） */
  segment(text: string, opts: { pageNo: number; imageRefs: OcrImageRef[] }): PageSegmentation;
}

// ===== 结构输出 / 入库草稿（决策 §7）=====
export interface ScanDraft {
  pageNo: number;
  /**
   * 卷内题号（可跨页）。0046（只增放宽 number → number | null）：一步到位引擎的题号原文
   * 是 string | null（含 "2-17" 复合形态），无法可靠映射为单一数字时落 null（不猜）。
   * 下游对 null 的显示/算术适配点：to-proof-items / proof-session / ProofPage（0046 逐处申报）。
   */
  qno: number | null;
  contentHtml: string;           // 对齐 question-content.ts：<div class="question">…KaTeX data-tex…</div>
  answerHtml?: string;
  analysisHtml?: string;
  imageRefIds: string[];
  rawText: string;
  warnings: string[];
}
export interface DraftBuilder {
  build(q: RecognizedQuestion): ScanDraft;
}
