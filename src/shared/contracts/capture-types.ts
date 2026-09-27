// ===== 站点识别与去重键 =====
export const CAPTURE_SITES = ['zujuan', 'jyeoo', 'generic'] as const;
export type CaptureSite = typeof CAPTURE_SITES[number];

// ===== 一条已提取题目（DOM 提取层归一化输出；对齐 POC normalizeQuestionPayload）=====
export interface CapturedQuestion {
  questionId: string;                    // 站点稳定 id（zujuan 详情页 qid / jyeoo 报告页真实 tid；去重键 site+tid）
  site: CaptureSite;
  sourceUrl: string;                     // 题卡所在页（采集时）
  stemHtml: string;                      // 题干原始 HTML（未清洗，归一化时清洗）
  options: string[];                     // 选项原始 HTML（无选项题型为空数组）
  answerHtml: string;                    // 答案原始 HTML（可空——如防采集图未补到）
  analysisHtml: string;                  // 解析原始 HTML（可空）
  images: Array<{ src: string; alt?: string; role: 'content' | 'answer' }>;  // 题内远端图片（公式图/配图；src 已 absolutize）
  meta: {                                // 站点元信息（原始保留，入库映射见 Phase 3）
    [k: string]: unknown;
    questionType?: string;               // 站点题型原文（如"单选题/解答题"）
    difficulty?: string;                 // 站点难度原文
    /** D1-fix-5（只增）：题的题库 id（zujuan 题块 bankid 属性值，如 13=物理、14=高中化学）→ 详情页 URL 前缀 `{bankid}q{id}.html` */
    bankid?: string;
    knowledgePoints?: string[];          // 知识点原文
    /** 0006 P2（只增）：站点树节点 id（题与站点知识点/章节的关联，入库时经 tree_source_map 反查挂树） */
    sourceNodeIds?: Array<{ site: string; siteNodeId: string }>;
    source?: string;                     // 出处原文（如"2023 武汉中考"）
    gated?: boolean;                     // 答案被会员墙挡住
    answerVia?: string;                  // 答案来源路径（'report-page-tid'|'hidden-window'|'vip-gated'|'paper-api'|''）
    /** 0006 P4（只增）：整卷下载——子母题数（>1 = 母题，v1 不拆子题，按母题整题入库） */
    childQuestionCount?: number;
    /** 0006 P4（只增）：整卷下载溯源（卷名/卷 URL/来源卷 from+paperTitle）→ ingest 合并入 sourceDetail.paper */
    paperRef?: { title: string; url: string; from?: string; paperTitle?: string };
  };
  rect: { x: number; y: number; width: number; height: number } | null;  // 题卡可视区矩形（截图兜底预留，D0 可不填）
}

// ===== DOM 提取结果（注入脚本输出，采集会话一次收篮）=====
export interface CaptureExtraction {
  url: string;
  mode: string;                          // 'zujuan-basket' | 'jyeoo-basket' | 'generic' | 'none'
  captured: CapturedQuestion[];
  warnings: string[];                    // 提取告警（会员墙/串题失败/元素缺失等）
}

// ===== 归一化后入库题（结构已对齐 question-content 契约）=====
export interface NormalizedCaptureQuestion extends CapturedQuestion {
  contentHtml: string;                   // <div class="question">…题干…<div class="options"><span class="option">…</div>…</div>
  normalizedImages: Array<{ localPath: string; origSrc: string; role: 'content' | 'answer' }>;  // 下载后本地相对路径
}

// ===== 采集窗口与会话（主进程状态，经 capture.* IPC 暴露）=====
export interface CaptureWindowState {
  open: boolean;
  url: string;
  title: string;
  site: CaptureSite | null;              // 当前 URL 识别的站点；null=不在已知站
  loggedIn: boolean;                     // 站点登录态（zujuan: 首页有"我的存档"等登录特征）
  lastExtraction: { at: string; count: number } | null;
  /** 0012（只增）：内嵌 view/独立窗 导航栈后退可用（React 顶部栏按钮态；mock/旧实现缺省 undefined=不可用） */
  canGoBack?: boolean;
  /** 0012（只增）：内嵌 view/独立窗 导航栈前进可用（同上） */
  canGoForward?: boolean;
}

// ===== capture.* IPC 通道（增补 ipc-channels.ts / bridge.ts，命名空间 capture.）=====
// capture.openWindow            → 打开/聚焦采集窗口（持久会话 persist:mofang-capture）
// capture.closeWindow           → 关闭采集窗口
// capture.navigate(url)         → 窗口内导航
// capture.getState              → CaptureWindowState
// capture.extractBasket         → 跑注入采集试题篮 → { extracted: CaptureExtraction }
// capture.collect(extracted, subject?) → 归一化+图片落盘+入库（mock/bank 门禁）→ { ok: number; dup: number; failed: Array<{questionId;error}> }（L-1：subject 可选）
// capture.getLastExtraction     → 最近一次提取结果（L-2：控件条提取后主窗拉取）
// capture.paperPreview(url)     → 整卷下载预览（0006 P4 只增：PC SSR 题号 + 移动批量 API 全字段）
// capture.paperImport({url, questionIds, target}) → 去向二选一（'paper' 成品卷 | 'bank' 散题入题库）

// ===== 0006 P4（只增）：整卷下载（组卷网 zujuan.xkw.com）=====
/** 预览条目：题号/题型/题干摘要/答案解析有无/子母题标注（勾选与去向在 UI 层） */
export interface PaperPreviewItem {
  questionId: string;
  bankid?: string;
  questionType?: string;
  difficulty?: string;
  stemSummary: string;                   // 题干纯文本摘要（截断）
  answerPresent: boolean;
  analysisPresent: boolean;
  childCount: number;                    // >1 = 子母题（v1 不拆子题）
  knowledgePoints?: string[];
}

export interface PaperPreview {
  url: string;                           // 归一后的组卷整卷详情页 URL
  bankId: string;
  paperId: string;
  title: string;                         // 卷名（PC <title> 剥站名后缀）
  total: number;                         // PC SSR 题号总数（== 实卷题数）
  items: PaperPreviewItem[];             // 按卷面题序
  missing: string[];                     // 站点未返回字段的题号（覆盖率缺口，如实列出）
  warnings: string[];
}

/** 去向二选一：'paper' 成品卷（done+快照） | 'bank' 散题入题库（复用 ingest 去重/回填） */
export type PaperImportTarget = 'paper' | 'bank';

export interface PaperImportRequest {
  url: string;
  questionIds: string[];                 // 勾选题号（卷面顺序由本数组顺序决定）
  target: PaperImportTarget;
}

export interface PaperImportResult {
  target: PaperImportTarget;
  /** target='paper' 且有结果时回传成品卷信息 */
  paperId?: string;
  paperTitle?: string;
  snapshotCount?: number;
  done?: boolean;
  ok: number;
  dup: number;
  updated?: number;
  failed: Array<{ questionId: string; error: string }>;
  warnings: string[];
}
