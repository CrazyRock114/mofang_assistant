// 0036 P1：PDF 切题工作区契约（项目 / 切段 / 框模型 / 草稿 / split.* payload）
// 单源在本文件；ipc-channels.ts 只增引用，bridge.ts 只增挂载（任务书 §三：契约只增不改）。
//
// 与 0028 runs 契约的分工：recog-run-types.ts 是「一次识别任务」的编排契约（本单复用，语义不动）；
// 本文件是「切题工作区的文件态」——项目 / 切段 / 框 / 草稿，全部落工作区目录，不进 SQL（无迁移）。
//
// 存储形态（D-051：一期固定 userData/data/splitting/<项目>/，规避通用文件通道 file.* 三件套）：
//   project.json   项目元（源 PDF 名 + 页数 + 切段 meta）
//   source.pdf     源 PDF 副本（自包含：源文件被移动/删除不影响已建项目，也不留外部路径依赖）
//   draft.json     草稿（**按段独立**：框 + 每题 run 关联），渲染层 1.5s 防抖自动存，关页可续
//   pages/pNNN.png 页图缓存（pdfjs 栅格化产物；重开项目直接读缓存，不必重新栅格化）

/** 框类型：题干文字 / 题干配图 / 答案解析（三类可混用、可跨页） */
export const SPLIT_BOX_TYPES = ['text', 'image', 'answer'] as const;
export type SplitBoxType = (typeof SPLIT_BOX_TYPES)[number];

/**
 * 框模型（任务书 §一 P2）。x/y/w/h 为**页内归一化坐标**（0..1，相对该页图像素尺寸）——
 * 页图缩放、渲染策略变更、DPI 差异都不影响已画框；裁剪时再乘回像素。
 *
 * qid = 题目组标识：一题 = 一组框（题干/配图/答案），**一题一 run**（任务书 §一 P3）。
 * 任务书的模型字面是 {type,page,x,y,w,h}，qid 是达成「一题一 run」所必需的分组键（只增字段）。
 */
export interface SplitBox {
  id: string;
  qid: string;
  type: SplitBoxType;
  /** 1-based 页号 */
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 切段（章节/页码区间）。每段独立草稿 + 独立识别队列；
 * 段间**允许页码重叠**（跨页题两端各留一点余量是常态），故不校验区间互斥。
 */
export interface SplitSegment {
  id: string;
  /** 章节名（用户可改；缺省「第 a–b 页」） */
  title: string;
  /** 起始页（1-based，含） */
  fromPage: number;
  /** 结束页（1-based，含） */
  toPage: number;
  createdAt: string;
}

/** 一道题对应的识别任务关联（一题一 run；runId 落草稿支持断点续跑/恢复轮询） */
export interface SplitRunLink {
  qid: string;
  runId: string;
  /** 'creating' = 已发起、runId 尚未回；其余为 recog run 状态机原值 */
  status: RecogRunLinkStatus;
  /** 入库成功的题目 id（去重并集；来自 recog.run.attachQuestions 的回读） */
  questionIds: string[];
  /**
   * 失败原因（error/cancelled 时来自 recog.event 的 message 或 run.error）。
   * 2026-09-18 目检案底：原来题卡只显示「识别失败」三个字，用户与验收方都无从判断原因；
   * 落草稿是为了关页回来仍能看到上次为什么失败（否则只剩一个无解释的失败态）。
   */
  error?: string | null;
}

/** run 关联状态：recog 六态 + 本地 'creating'（发起瞬时态，防重复点识别） */
export type RecogRunLinkStatus = 'creating' | 'queued' | 'ocr' | 'ai' | 'done' | 'error' | 'cancelled';

/** 单段草稿：框集合 + 本题段的识别队列 */
export interface SplitSegmentDraft {
  boxes: SplitBox[];
  runs: SplitRunLink[];
}

/** 草稿文件（draft.json）：按段独立存，版本号留给后续结构演进 */
export interface SplitDraft {
  version: 1;
  segments: Record<string, SplitSegmentDraft>;
  updatedAt: string;
}

/** 项目元（project.json） */
export interface SplitProjectMeta {
  id: string;
  /** 项目显示名（缺省取源文件名去扩展名） */
  name: string;
  /** 源 PDF 原始文件名（仅展示与溯源；实际读取走工作区内 source.pdf 副本） */
  sourceName: string;
  /** 源 PDF 字节数（校验副本完整性；-1 = 尚未上传完） */
  sourceBytes: number;
  /** 总页数（0 = 尚未栅格化确认） */
  pageCount: number;
  segments: SplitSegment[];
  createdAt: string;
  updatedAt: string;
}

/** 列表项（不带 segments 与草稿，列表页够用） */
export interface SplitProjectSummary {
  id: string;
  name: string;
  sourceName: string;
  pageCount: number;
  segmentCount: number;
  updatedAt: string;
}

/** 打开项目：元 + 草稿一次给全（关页回来即恢复现场） */
export interface SplitProjectDetail {
  meta: SplitProjectMeta;
  draft: SplitDraft;
}

// ==================== split.* 通道 payload ====================

/**
 * 建项目：只带元信息，**不带 PDF 字节**——PDF 由 split.source.append 分块上传。
 * 整本教辅 PDF 可达数十 MB，一次性 base64 过桥会把 IPC 消息撑到百 MB 级；
 * 分块（默认 4MB/块）把单条消息钉在可控水位，且断点可续传。
 */
export interface SplitProjectCreatePayload {
  /** 缺省取 sourceName 去扩展名 */
  name?: string;
  sourceName: string;
  /** 源 PDF 字节数（saveMeta 时校验副本完整性） */
  sourceBytes: number;
}

/** 分块追加源 PDF（offset 必须等于当前已收字节数；错位即拒绝，防乱序写坏文件） */
export interface SplitSourceAppendPayload {
  projectId: string;
  offset: number;
  dataBase64: string;
}
export interface SplitSourceAppendResult {
  /** 追加后已收字节数 */
  size: number;
}

/** 分块读源 PDF（渲染层栅格化时按需拼装；offset+length 越界即截断到文件尾） */
export interface SplitSourceReadPayload {
  projectId: string;
  offset: number;
  length: number;
}
export interface SplitSourceReadResult {
  dataBase64: string;
  /** 本次读到文件尾 */
  eof: boolean;
}

/** 保存项目元（页数 + 切段；上传完成后调用，顺带校验 source.pdf 字节数一致） */
export interface SplitProjectSaveMetaPayload {
  projectId: string;
  pageCount: number;
  segments: SplitSegment[];
}

/** 保存草稿（渲染层防抖后调用；主进程只落盘不解释内容） */
export interface SplitProjectSaveDraftPayload {
  projectId: string;
  draft: SplitDraft;
}
export interface SplitProjectSaveDraftResult {
  savedAt: string;
}

/** 页图缓存写入（栅格化产物；mime 固定 image/png） */
export interface SplitPageWritePayload {
  projectId: string;
  pageNo: number;
  dataBase64: string;
}
export interface SplitPageWriteResult {
  /** 工作区内相对路径，如 pages/p001.png */
  file: string;
}

/** 页图缓存读取；未缓存返回 dataBase64: null（渲染层回落重新栅格化） */
export interface SplitPageReadPayload {
  projectId: string;
  pageNo: number;
}
export interface SplitPageReadResult {
  dataBase64: string | null;
}

export interface SplitProjectIdPayload {
  projectId: string;
}
