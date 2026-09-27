// 0028 P1：识别 run 契约（状态机 / 页进度 / 事件通道 / recog.run.* payload）
// 单源在本文件；ipc-channels.ts 只增引用，bridge.ts 只增挂载（任务书 §三：契约只增不改）。
//
// 与既有 recog-types.ts 的分工：recog-types.ts 是「单页 OCR / 切分 / 草稿」的引擎契约（冻结不动）；
// 本文件是「一次录题任务（run）」的编排契约——多页生命周期、进度事件、结果索引。
// 混合持久化（T-07）：大产物（页 PNG / OCR 原文 / 草稿 JSON）只在主进程落盘，不过桥。

import type { ScanDraft } from './recog-types.js';
// 0046（只增）：draft.write 载荷携带一步到位引擎草稿（类型单源 onestep-types.ts）
import type { OnestepDraft } from './onestep-types.js';

/** run 状态机六态（与迁移 0012 的 CHECK 逐字一致） */
export const RECOG_RUN_STATUSES = ['queued', 'ocr', 'ai', 'done', 'error', 'cancelled'] as const;
export type RecogRunStatus = (typeof RECOG_RUN_STATUSES)[number];

/**
 * 阶段（进度条文案）：起步与 status 同值；error/cancelled 落在终态值上。
 * 表列无 CHECK（自由文本），后续任务可细分（如 0036 的 pdf-split），不锁死。
 */
export type RecogRunStage = 'queued' | 'ocr' | 'ai' | 'done' | 'error' | 'cancelled';

/** 页状态：pending（未处理）/ ocr（处理中）/ done（产物已落）/ error */
export type RecogRunPageStatus = 'pending' | 'ocr' | 'done' | 'error';

/**
 * 素材形态：图片文件（拖拽/点选）/ 剪贴板位图（Ctrl+V）/ 0036 PDF 切题工作区的裁剪小图。
 * 迁移 0012 的 source_kind 列无 CHECK（自由文本），新增取值无需迁移。
 */
export type RecogSourceKind = 'image' | 'clipboard' | 'pdf-split';

/** run 对外形态（SQL 行 → 契约；warnings/questionIds 已 JSON 解析） */
export interface RecogRun {
  id: string;
  status: RecogRunStatus;
  stage: RecogRunStage;
  sourceKind: RecogSourceKind;
  sourceName: string | null;
  pageCount: number;
  /** 已落产物的页数（status='done' 计数，非「已尝试」数） */
  pagesDone: number;
  error: string | null;
  /** 切分/引擎警告（多页汇总） */
  warnings: string[];
  /** 结果题目 id 集（校对页入库成功后回写，去重并集） */
  questionIds: string[];
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

/** 页记录（含 checkpoint 文件索引） */
export interface RecogRunPage {
  runId: string;
  pageNo: number;
  /** run 目录内相对路径，如 pages/p001.png */
  imageFile: string;
  /** OCR 产物相对路径（null=未产出；存在即续跑时跳过） */
  ocrFile: string | null;
  status: RecogRunPageStatus;
  textChars: number | null;
  imageRefCount: number | null;
  error: string | null;
  updatedAt: string;
}

// ==================== 进度事件（主进程 → 渲染层，照 CAPTURE_EVENT 范式） ====================

/**
 * 事件类型（规划 T-08 精简版）：queued / ocr（页 i/n）/ ai（结构整理阶段）/ card（逐题卡产出）/
 * done / error；cancelled 为中断收尾（补充态，不作独立阶段）。
 */
export type RecogEventType = 'queued' | 'ocr' | 'ai' | 'card' | 'done' | 'error' | 'cancelled';

export interface RecogEventPayload {
  runId: string;
  type: RecogEventType;
  /** 本事件对应的页号（ocr 事件；续跑跳过的页也带） */
  pageNo?: number;
  /** 已完成页序（1-based 完成计数；与 pageCount 组成「页 i/n」） */
  pageIndex?: number;
  pageCount?: number;
  /** 本页为 checkpoint 命中而跳过（续跑恢复） */
  skipped?: boolean;
  /** 已产出题卡数（card/done 事件） */
  draftCount?: number;
  /** 0..1 总进度（页阶段按完成页数比例，ai 阶段 1，done=1） */
  progress?: number;
  /** error/cancelled 文案（cancelled 为「已取消」） */
  message?: string;
}

// ==================== recog.run.* 通道 payload ====================

/** 素材项：渲染层读取 File/Blob 字节后 base64 过桥（主进程独占磁盘 IO；不传路径，跨环境一致） */
export interface RecogMaterial {
  name: string;
  mime: string;
  dataBase64: string;
}

export interface RecogRunCreatePayload {
  materials: RecogMaterial[];
  sourceKind: RecogSourceKind;
  /**
   * 0046（只增）：run 展示名（「最近识别记录」与工作台默认卷名）。
   * 缺省沿用既有口径：单素材 = 素材文件名，多素材 = null。渲染层显式传入时优先
   * （0040 §六.h：整卷 PDF run 显示卷名而非 run id 前 8 位）。
   */
  sourceName?: string;
}

export interface RecogRunCreateResult {
  runId: string;
  pageCount: number;
}

export interface RecogRunIdPayload {
  runId: string;
}

/**
 * status 回读：run 状态 + 页记录 + 草稿。
 * 用于挂载即恢复（关页回来续跑）与进度轮询兜底（事件为主，此口是幂等真相源）。
 * pages 已由 shell 侧补齐渲染所需的两项：绝对图路径与 OCR 原文（renderer 不碰磁盘）。
 */
export interface RecogRunDetailPage extends RecogRunPage {
  /** 页图绝对路径（runDir 已拼接，渲染层直接当 src） */
  imagePath: string;
  /** 页 OCR 原文（诊断可见；未产出页为空串） */
  ocrText: string;
}

export interface RecogRunDetail {
  run: RecogRun;
  /** run 产物目录绝对路径（溯源/诊断用；渲染层一般只用 pages[].imagePath） */
  runDir: string;
  pages: RecogRunDetailPage[];
  /** 未到 ai 阶段或产物缺失时为空数组；原因见 run.error / run.warnings */
  drafts: ScanDraft[];
}

export interface RecogRunHistoryPayload {
  limit?: number;
}

/** 入库成功后回写结果题目 id 集（去重并集；供溯源与 0029/0036 复用） */
export interface RecogRunAttachQuestionsPayload {
  runId: string;
  questionIds: string[];
}

/**
 * 0046（只增）：recog.draft.write——一步到位（Onestep）草稿写回 run 目录 drafts.json。
 * 转换（OnestepDraft → ScanDraft，含 qno 降级）在主进程侧完成；写回后 run 状态同步落 done
 * 并回写 warnings（引擎级告警合并），#/proof/<runId> 经 recog.run.status 读出（呈现层零改动）。
 */
export interface RecogDraftWritePayload {
  runId: string;
  /** 本 run 识别产出的全部 Onestep 草稿（整批覆盖式写回；空数组 = 清空草稿，同样落 done） */
  drafts: OnestepDraft[];
}

export interface RecogDraftWriteResult {
  savedAt: string;
  /** 实际落盘的 ScanDraft 数 */
  draftCount: number;
  /** 回写 run 的引擎级告警（逐题告警合并去重 + qno 降级告警） */
  warnings: string[];
}

// ==================== service 面（bank-core 唯一 SQL 入口；照 ModelProfileService 先例放契约层） ====================

export interface RecogRunCreateInput {
  id: string;
  sourceKind: RecogSourceKind;
  sourceName?: string;
  pages: Array<{ pageNo: number; imageFile: string }>;
  now: string;
}

export interface RecogRunStatusPatch {
  status: RecogRunStatus;
  /** 缺省 = 与 status 同值（阶段起步口径） */
  stage?: RecogRunStage;
  error?: string | null;
  /** 缺省 = now（进入终态时自动落定）；显式 null 表示清空 */
  finishedAt?: string | null;
  now: string;
}

export interface RecogRunPagePatch {
  status?: RecogRunPageStatus;
  ocrFile?: string;
  textChars?: number;
  imageRefCount?: number;
  error?: string | null;
  now: string;
}

/**
 * 识别 run 状态口（bank 真实 SQLite + 编排器注入同一份接口）。
 * 状态机：queued→ocr→ai→done；任一步可 →error/cancelled；error/cancelled→ocr 为续跑边。
 */
export interface RecogRunService {
  createRun(input: RecogRunCreateInput): Promise<RecogRun>;
  getRun(id: string): Promise<RecogRun | null>;
  listRuns(limit?: number): Promise<RecogRun[]>;
  setStatus(id: string, patch: RecogRunStatusPatch): Promise<RecogRun>;
  listPages(runId: string): Promise<RecogRunPage[]>;
  markPage(runId: string, pageNo: number, patch: RecogRunPagePatch): Promise<void>;
  setWarnings(id: string, warnings: string[], now: string): Promise<RecogRun>;
  attachQuestions(id: string, questionIds: string[], now: string): Promise<RecogRun>;
}
