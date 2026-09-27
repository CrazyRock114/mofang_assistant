// 0040:「录题工作台 v2」契约（一步到位引擎 OnestepProvider + 工作台文件态 + 新增通道 payload）
//
// 本文件为 0040 独占新建契约（与 0028 recog-run-types.ts / 0029 ai-suggest-types.ts 同款
// 「新建契约文件 = 只增」范畴；任务书 §三.1 授权清单第 ③ 条）。
//
// 分工（任务书 §〇 / 0042 纪要 §八）：
//   - 转写与坐标 = OCR 的活（视觉得到的坐标不可控）→ 图块 bbox 只来自 DeepSeek-OCR grounding
//   - 理解与判断 = 推理模型的活 → qno/题型/字段结构/标签由一步到位 VLM 或文本推理模型产出
//   - 两侧的失败模式由同一层规则校验接住（src/recog/onestep/validate.ts）
//
// 坐标口径：本文件所有 bbox 一律 **0~1 归一**（左上原点，[x1,y1,x2,y2]），与 0036
// `src/recog/splitting/box-model.ts` 的 normalizeRect 同口径；模型侧的 0-999 归一在解析层换算。

// ==================== 引擎层：一步到位草稿 ====================

/** 题型取值（0042 提示词资产固定枚举；与字典码的映射在操作层做） */
export const ONESTEP_QUESTION_TYPES = ['单选', '多选', '填空', '解答', '判断'] as const;
export type OnestepQuestionType = (typeof ONESTEP_QUESTION_TYPES)[number];

/**
 * 选项（label 不带冒号点号，content 为 Markdown/LaTeX 文本）。
 * 0045（只增，JSDoc 口径）：content 允许 `[图N]` 占位符引用该题 `figures` 里的图块
 * （与题干 [图N] 同号同源）；操作层渲染时占位符转为选项内的行内图
 * （`span.inline-figure`，形态见 question-content.ts），不落块级 figure。
 */
export interface OnestepOption {
  label: string;
  content: string;
}

/** 归一化包围盒 [x1, y1, x2, y2]，0~1（左上原点） */
export type OnestepBBox = [number, number, number, number];

/**
 * 图块坐标来源（0042 §十第四轮的对账口径，用于显式降级不静默）：
 *  dso    = DeepSeek-OCR grounding 定位（默认，坐标口径受控）
 *  inline = 主模型内联 bbox 补齐（强模型可用；弱模型禁用，见 0042 §9.3）
 *  none   = 两侧都没出框（题面若有 [图N] 必须显式告警）
 *  mixed  = DSO 为主 + 内联按序补齐（兜底链）
 */
export const ONESTEP_FIGURE_SOURCES = ['dso', 'inline', 'none', 'mixed'] as const;
export type OnestepFigureSource = (typeof ONESTEP_FIGURE_SOURCES)[number];

/** 图块（ref 形如「图1」，与题面 [图N] 占位符同号） */
export interface OnestepFigure {
  ref: string;
  bbox: OnestepBBox;
}

/**
 * 引擎产出的单题草稿 —— 与题库 Question 同构的中间形态（尚未落库、尚未人工确认）。
 * `stemMarkdown` 里的插图位置保留 `[图N]` 占位符，由操作层用 `figures` 裁出的真图替换。
 */
export interface OnestepDraft {
  /** 卷内题号原文（保「章-题号」形态如 "2-17"；图中确无题号 = null，不猜跨页题号） */
  qno: string | null;
  questionType: OnestepQuestionType;
  stemMarkdown: string;
  /** 无选项 = null（不用空数组蒙混，0042 null 纪律） */
  options: OnestepOption[] | null;
  /** 只抄录图中实际印出的答案；图中没有 = null（绝不自行作答） */
  answerMarkdown: string | null;
  analysisMarkdown: string | null;
  suggestedTags: string[];
  /** 与本题相关的图块（已过滤/去重/按阅读序重编号） */
  figures: OnestepFigure[];
  figureSource: OnestepFigureSource;
  /** 校验层与对账产出的人读告警（含图块来源与未配平占位符；不静默） */
  warnings: string[];
}

/** 送入引擎的图像（base64 与 mime；pageNo/尺寸供坐标与诊断） */
export interface OnestepExtractImage {
  dataBase64: string;
  mime: string;
  pageNo?: number;
  width?: number;
  height?: number;
}

/**
 * 提取上下文（跨页题号衔接的唯一信息来源——单页提取不猜跨页题号，0042 §2.1）：
 * 由操作层按框选/分段上下文补全，引擎只据实使用，不推断。
 */
export interface OnestepExtractContext {
  pageNo?: number;
  /** 上一题题号原文（跨页续题时的接续锚；缺省 = 无上下文） */
  prevQno?: string | null;
  paperTitle?: string;
}

export interface OnestepExtractInput {
  image: OnestepExtractImage;
  context?: OnestepExtractContext;
}

/**
 * 录题识别 Provider 窄接口（供应商/模型无关；对模型名与供应商零假设）。
 * 主档 = 一步到位 VLM；降级档 = 免费 OCR 转写 + 文本推理结构化两段式。
 * 实现只经注入的 `invoke` 调用模型（走 ai.invoke 网关），自身不触 Key、不读档案（D-043）。
 */
export interface OnestepProvider {
  readonly name: string;
  extract(input: OnestepExtractInput): Promise<OnestepDraft[]>;
  /**
   * 0056（只增，可选）：**纯转写**——只跑 OCR 转写腿，返回图中文字/公式原文（不结构化、不过第二腿）。
   * 用途：公式图转文字属**转写域**（0042 §8 分工红线：OCR 模型只做转写、不做结构化），
   * 且文本模型改写的第二腿对单公式是净损失（0042 §8 + 施工参考 §2.1/§2.5：禁止用推理为 OCR 结论背书）。
   * 未实现该方法的 provider（如一步到位 VLM）→ 调用方退回 extract 路径。
   */
  transcribe?(input: OnestepExtractInput): Promise<string>;
}

// ==================== 操作层：工作台文件态（run 目录 workbench.json） ====================

/** 工作台状态文件版本（结构变更时递增；读取遇到未来版本按不识别处理） */
export const WORKBENCH_STATE_VERSION = 1;

/** 工作台识别档（D-057）：auto = AI 自动（需推理模型）；semi = 半自动（OCR + 手动微调） */
export const WORKBENCH_MODES = ['auto', 'semi'] as const;
export type WorkbenchMode = (typeof WORKBENCH_MODES)[number];

/** 题卡状态机（pending/failed 是「待识别卡」的两个面；committed = 已入库锁定态） */
export const WORKBENCH_CARD_STATUSES = ['pending', 'recognizing', 'question', 'failed', 'committed'] as const;
export type WorkbenchCardStatus = (typeof WORKBENCH_CARD_STATUSES)[number];

/** 卡来源：manual = 手动框选；ai = AI 一键/单卡一步到位；semi = 半自动 OCR 链 */
export type WorkbenchCardSource = 'manual' | 'ai' | 'semi';

/** 归一化矩形（0~1，与 box-model normalizeRect 同口径） */
export interface WorkbenchRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 框选快照（待识别卡的一张框选图；并入 = 同一张卡多帧） */
export interface WorkbenchFrame {
  id: string;
  pageNo: number;
  rect: WorkbenchRect;
  /** 该帧对应页的像素尺寸（裁图口径；页图加载后回填） */
  pageWidth?: number;
  pageHeight?: number;
}

/** 工作台图块（ref 对题面 [图N]；bbox 0~1 归一同口径，可人工拖动微调后重裁） */
export interface WorkbenchFigure {
  ref: string;
  pageNo: number;
  bbox: OnestepBBox;
  /** 人工微调过（UI 标注「人工确认」）。0042 §十第四轮：人工调整是一等公民 */
  adjusted: boolean;
}

/** 挂树建议 chip（0029 锚点链产出；点击采纳，不点不入库） */
export interface WorkbenchTreeSuggestion {
  nodeId: string;
  label: string;
  confidence: number | null;
}

/** 工作台题卡 */
export interface WorkbenchCard {
  id: string;
  status: WorkbenchCardStatus;
  source: WorkbenchCardSource;
  /** 勾选制（批量入库用；committed 卡不可勾） */
  checked: boolean;
  /** 待识别卡的框选帧（多张并列；question 卡保留首帧用于溯源） */
  frames: WorkbenchFrame[];
  /** 失败原因（status='failed' 时非空，UI 红条展示 + 可重试） */
  error: string | null;
  /** 原卷题号原文（"2-17"；null = 图中无题号） */
  qno: string | null;
  /** 题型字典码（question_type 归一行 code；'' = 未定） */
  typeCode: string;
  /** 题干（编辑器契约 HTML，含 .options；答案/解析分列不离体） */
  contentHtml: string;
  answerHtml: string;
  analysisHtml: string;
  /** 图块（题面 [图N] 与之一一对应） */
  figures: WorkbenchFigure[];
  figureSource: OnestepFigureSource;
  /** 核验提示（黄条；不硬拦） */
  warnings: string[];
  /** 引擎建议标签（chips 候选） */
  tags: string[];
  /** 已采纳标签（随入库写入 question_tags；不采纳不写） */
  adoptedTags: string[];
  /** 挂树建议（chips 候选） */
  treeSuggestions: WorkbenchTreeSuggestion[];
  /** 已采纳挂树节点（随入库写 question_node_links） */
  adoptedNode: { nodeId: string; label: string } | null;
  /**
   * 0054（R-045③④，只增，可选）：已采纳知识节点**多值**（随入库逐节点写 question_node_links）。
   * 与 `adoptedNode` 的关系：`adoptedNodes` 为准、`adoptedNode` 保留作**首节点兼容**——
   * 写侧恒同步（多值全量 + 首节点镜像），读侧归一 helper `adoptedNodesOf` 兼容
   * 0054 之前落盘的旧草稿（只有单值 → 归一为单元素数组）。
   */
  adoptedNodes?: Array<{ nodeId: string; label: string }>;
  /** 入库后的题目 id（锁定态依据；撤销入库即清空） */
  committedQuestionId: string | null;
  /** 0047（只增）：存为试卷链的题所属卷 id（普通入库路径不写；撤销入库须先按此摘卷再删题） */
  committedPaperId?: string | null;
}

/** 工作台页图元信息（归一坐标 → 像素裁图用；尺寸来自实际解码的图） */
export interface WorkbenchPage {
  pageNo: number;
  name: string;
  width: number;
  height: number;
}

/**
 * 工作台文件态（run 目录 `workbench.json`；草稿恢复 = 入口页「继续处理」）。
 * 与 `drafts.json`（0028 规则链产物）并存互不干扰：本文件是工作台的**卡流状态**。
 */
export interface WorkbenchState {
  version: number;
  runId: string;
  mode: WorkbenchMode;
  /** 默认归类：学段 + 学科（识别结果先按此归类，题卡可逐题改 subjectId 走入库） */
  stage: string;
  subjectId: string;
  paperTitle: string;
  pages: WorkbenchPage[];
  cards: WorkbenchCard[];
  /** 卡 id 自增序号（跨会话稳定，避免重开后 id 撞车） */
  nextSeq: number;
  updatedAt: string;
}

// ==================== 新增通道 payload ====================

/** recog.workbench.load：读工作台文件态；无文件返回 null（首次进入） */
export interface RecogWorkbenchLoadPayload {
  runId: string;
}

/** recog.workbench.save：写工作台文件态（渲染层防抖后调用） */
export interface RecogWorkbenchSavePayload {
  runId: string;
  state: WorkbenchState;
}

export interface RecogWorkbenchSaveResult {
  savedAt: string;
}

/**
 * ai.suggest.treeForDraft：对**尚未入库**的工作台草稿直跑 0024 锚点链（≤4 层注入 + NONE + 后置校验）。
 * 与 0029 的 ai.suggest.tree 同链同口径，唯一差别是题面来源是草稿文本而非库内题目。
 */
export interface AiSuggestTreeForDraftPayload {
  /** 学段（trees.stage 精确匹配）；''/缺省 = 不限 */
  stage?: string;
  /**
   * 学科（dict id / 归一 code / 中文标签三形态，同 AnchorQuery.subjectId）。
   * 2026-09-20 目检返工⑥：改可选——工作台草稿允许「学科未定」起步，此前的必填形验
   * 让用户在 IPC 处直接吃「Invalid payload. subjectId」（业务层见 AiSuggestHost 的显式拒绝）。
   */
  subjectId?: string;
  /** 草稿题干纯文本（由操作层从编辑器 HTML 抽，超长截断） */
  stemText: string;
}
