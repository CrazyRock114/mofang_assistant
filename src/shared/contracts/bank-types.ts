// Phase 1: 题库数据模型与服务契约
// 0002 地基扩展（0002 schema 草案 v0.2 + 决策稿 v2.3）：新增实体类型 + Question 结构化 + Paper 扩展。
// 契约变更原则：只增不改——存量字段/方法签名保持兼容（deprecated 字段仅保留编译兼容，服务端不再落库）。

/**
 * D1-fix-6（只增）：采集来源明细（questions.source_detail 的采集侧形态）。
 * 结构保持 Record<string, unknown> 兼容（非采集链路自由键不受约束）；本接口只声明采集链写入的键，
 * 读侧一律按可选容错取值。
 */
export interface QuestionSourceDetail extends Record<string, unknown> {
  site?: string;
  url?: string;
  questionId?: string;
  collectedAt?: string;
  gated?: boolean;
  answerVia?: string;
  /** D1-fix-6（只增）：题的题库 id（zujuan 题块/篮缓存实测值）——详情页 URL 前缀兜底（语义同 meta.bankid） */
  bankid?: string;
}

export interface Question {
  id: string;
  subject: string;
  /** 0002 G2 字典化：dict_entries(kind='subject') 标准码；存量 subject 列保留（站点原文/显示名兼容渲染） */
  subjectId?: string;
  sourceType: 'network' | 'local';
  sourceDetail: QuestionSourceDetail;
  questionType?: string;
  /** 0002 G2 字典化：dict_entries(kind='question_type') */
  typeId?: string;
  difficulty?: number;
  /** 0002 G2 字典化：dict_entries(kind='difficulty') */
  difficultyId?: string;
  /** 0002 G1 结构化：题干 HTML（采集链直落结构化；content 降派生兼容字段） */
  stemHtml?: string;
  /** 0002 G1 结构化：选项（html 可含公式 data-tex/图） */
  options?: QuestionOption[];
  /** @deprecated 0002 起并入树（B2 拍板），DB 列已删；仅保留调用方编译兼容，服务端忽略不落库 */
  grade?: string;
  /** 0062（R-066/D-076② 翻案 B2）：恢复落库（迁移 0017）；题级优先，空回退树 stage */
  stage?: string;
  /** @deprecated 0002 起并入树（B2 拍板），DB 列已删；仅保留调用方编译兼容，服务端忽略不落库 */
  textbook?: string;
  /** @deprecated 0002 起并入树（B2 拍板），DB 列已删；仅保留调用方编译兼容，服务端忽略不落库 */
  version?: string;
  /** @deprecated 0002 起并入树（B2 拍板），DB 列已删；仅保留调用方编译兼容，服务端忽略不落库 */
  chapter?: string;
  knowledgePoints?: string[];
  /**
   * 0054（只增，可选）：题目标签（question_tags 汇总；**读侧回填**——listQuestions/getQuestion 带上，
   * 写入路径不消费本字段，打标仍走 addTag/removeTag）。来源不分：AI 打标建议 / 批量打标 / 手动；
   * 与采集链写入的 `knowledgePoints`（站点知识点原文）并存互不干扰。
   */
  tags?: string[];
  content: string;
  answer?: string;
  analysis?: string;
  /** 0002 G3/U4：结构化图片元素（语义类型分流转死，不得 any/unknown） */
  images: QuestionImage[];
  createdAt: string;
  updatedAt: string;
}

/** G3/U4：图片语义类型（采集按站点区域/图源域名自动判定；校对/编辑可人工改；导入自带；获取路径见 schema 草案 §7） */
export type QuestionImageType = 'figure' | 'formula-image' | 'answer-image' | 'analysis-image';

/** Question.images 结构化元素（拍板 §6-9：元素结构定死） */
export interface QuestionImage {
  /** 资产引用 id（data-assets 相对路径 / recog imageRefId 等） */
  assetId: string;
  type: QuestionImageType;
  width?: number;
  height?: number;
}

/** G1：题面结构化选项元素 */
export interface QuestionOption {
  /** 选项标号（A/B/C/D…） */
  label: string;
  /** 选项内容 HTML（可含公式 span.math[data-tex]/内嵌图） */
  html: string;
}

export interface Tag {
  name: string;
  color?: string;
}

/**
 * G6/U8：试卷状态机（basket→composing→done→archived；composing↔basket 可返）。
 * 0044（只增）：`'trashed'` = 回收站（D-060③）——任意非 trashed 状态可入（服务层记
 * `trashed_from`=原状态）；恢复只能走专用的 `restorePaper`（读 trashed_from 还原并清空），
 * 不作为 updatePaperStatus 的出边。列表缺省不可见（listPapersEx 默认排除）。
 */
export type PaperStatus = 'basket' | 'composing' | 'done' | 'archived' | 'trashed';

/**
 * 0044（只增）：试卷文件夹（D-060①/D-062）——`paper_folders` 表行；`parent_id` 自引用实现嵌套
 * （NULL=顶级，防环校验在服务层）；一卷一夹（papers.folder_id，NULL=未分类）。
 */
export interface PaperFolder {
  id: string;
  name: string;
  /** null=顶级文件夹（D-062）；undefined 与 null 同义（序列化兼容） */
  parentId?: string;
  /** 同级排序（缺省 0；树渲染按 sort 升序） */
  sort: number;
  createdAt: string;
}

/** U7：统一卷 / 定制错题卷（paper_sets.type 同域复用） */
export type PaperType = 'uniform' | 'custom-mistake';

/**
 * 0009（只增）：卷头自定义行（header.lines 单行模型）。
 * lines 存在且含非空行 → 卷头多行自定义模式（逐行渲染，不再自动输出 h1/exam meta）；
 * 缺省/全空 → 旧三态（simple/exam/none）逐点零回归；缺省值（字号/对齐/加粗）在归一化层落定。
 */
export interface PaperHeaderLine {
  text: string;
  /** 字号 pt（缺省：首行 18 / 其余 11；界内收拢 6–72） */
  sizePt?: number;
  /** 对齐（缺省 center） */
  align?: 'left' | 'center' | 'right';
  /** 加粗（缺省：仅首行 true） */
  bold?: boolean;
}

/**
 * G7/U4/U3：版式受控配置（少参数，不做自由 JSON；version 化）。
 * paper.layoutConfig = 出卷定稿时的 config 拷贝（预设改动不影响已出卷）；layout_presets.config 同构。
 * 0004 v2（乙路 Phase 4）：version 1→2，新增 pageSize/columns/columnGapMm；
 * v1/缺省读侧=全默认（pageSize A4 / columns 1 / gap 8mm），v1 值语义不变。
 * 0009：header.lines 只增（多行自定义卷头；见 PaperHeaderLine）。
 */
export interface PaperLayoutConfig {
  version: 1 | 2;
  /** 正文字号 pt */
  fontSize?: number;
  fontFamily?: string;
  lineHeight?: number;
  /** 页边距 mm */
  pageMarginMm?: { top: number; right: number; bottom: number; left: number };
  /** 顶部信息样式（0009：lines 非空时为多行自定义模式，style 仅 none 仍有压制效果） */
  header?: { style?: 'simple' | 'exam' | 'none'; title?: string; lines?: PaperHeaderLine[] };
  /** 内容显隐（题号/分值/答案/解析） */
  fieldVisibility?: { questionNo?: boolean; score?: boolean; answer?: boolean; analysis?: boolean };
  /** 作答区（预留空白/线格；对齐 yiguodu answerSpace） */
  answerSpace?: { enabled?: boolean; style?: 'blank' | 'lines'; heightMm?: number };
  /**
   * 图片排版（只作用于 figure；G3 类型分流，公式图/答案图/解析图不参与）。
   * 0004 Phase 5（只增）：widthPercent=全局图宽档（版心内容宽百分比，题级覆盖优先于它、
   * 二者均缺省=引擎默认观感档 min(原宽, 60% 版心/列宽)，见 0004-S4 交付报告优先级链）
   */
  figureLayout?: { mode?: 'inline' | 'side-by-side'; align?: 'left' | 'center' | 'right'; widthPercent?: number };
  /** Logo 引用+位置（存引用，复用资产机制；比例坐标相对页宽高） */
  logos?: Array<{ assetId: string; xRatio: number; yRatio: number; widthRatio: number }>;
  /** 0004 v2：出纸尺寸（缺省 A4） */
  pageSize?: 'A4' | 'A3';
  /** 0004-fix-2 F2-A（只增）：横竖版（缺省 portrait；landscape=A3 横幅等横版出纸） */
  orientation?: 'portrait' | 'landscape';
  /** 0004 v2：栏数（缺省 1；2=双栏分栏） */
  columns?: 1 | 2;
  /** 0004 v2：栏间距 mm（缺省 8；columns=2 时生效） */
  columnGapMm?: number;
  /** 0013（只增）：选择题选项版式卷级默认档（缺省 auto=竖排；单题可经 layout_json.optionsLayout 覆盖） */
  optionsLayout?: OptionsLayoutMode;
}

/**
 * 0004 U4 v1：题级图排版覆盖（paper_questions.layout_json 与渲染输入 questionLayouts 同构）。
 * 仅语义 type=figure 的题内图参与（G3 分流：formula-image/answer-image/analysis-image 不参与）；
 * 题级覆盖优先于全局 figureLayout；全字段可选，缺省=原 DOM 顺序/全局值。
 */
export interface QuestionFigureLayout {
  /** 资产引用 id（data-assets 相对路径），对应题内 <figure>/<img> 的 src */
  assetId: string;
  /** 单图版式覆盖：inline=随文流 / side-by-side=右栏（缺省=全局 figureLayout.mode） */
  mode?: 'inline' | 'side-by-side';
  /** 对齐（side-by-side 时忽略；缺省=全局 figureLayout.align） */
  align?: 'left' | 'center' | 'right';
  /** 图块宽 = 版心内容宽度百分比 */
  widthPercent?: number;
  /** 图块输出顺序（小者先；缺省=原 DOM 序，稳定排序） */
  orderIndex?: number;
  /**
   * 0004-fix-5 P0-2（只增）：任意段边界锚位——插入点在**题内交错段序列**中的下标（0..段数）。
   * 语义：边界 k = 第 k 段之前；k=段数 = 题尾。存在时优先于 orderIndex（拖拽落点写此字段）；
   * 缺省 = 沿用 orderIndex 槽位序（存量数据零迁移）。assetId 按去 `data-assets/` 前缀归一匹配。
   */
  anchorIndex?: number;
}

/**
 * 0004-fix-3（只增）：题级作答区覆盖（layout_json.answerSpace 与渲染输入 questionLayouts 同构）。
 * 题级存在即启用该题作答区（style 'none'=该题不插）；style/heightMm 缺省逐项回落卷级值。
 */
export interface QuestionAnswerSpaceOverride {
  /** none=该题不插作答区；blank/lines 缺省=卷级 style */
  style?: 'blank' | 'lines' | 'none';
  /**
   * 0004-fix-4 #6（只增）：作答区行数（0=该题不留作答区）。
   * 引擎换算 = 行数 × 行高（行高 = config 字号 pt × 行距[缺省 1.8] × 0.3528 mm/pt，
   * 见 layout.answerSpaceLineHeightMm）；lines 存在时优先于 heightMm（heightMm 保留兼容存量覆盖）。
   */
  lines?: number;
  /** 缺省=卷级 heightMm */
  heightMm?: number;
}

export interface Paper {
  id: string;
  title: string;
  config: Record<string, unknown>;
  createdAt: string;
  /**
   * @deprecated 0002 拍板 §6-2 并入 status（单轨）：读侧恒等于 status==='archived'，写入走 updatePaperStatus；
   * 字段保留仅为存量调用方编译兼容
   */
  archived: boolean;
  /** 状态机（读侧必有值：服务层保证；可选性仅为存量构造方编译兼容） */
  status?: PaperStatus;
  paperType?: PaperType;
  /** 出卷定稿的版式 config 拷贝（version 化） */
  layoutConfig?: PaperLayoutConfig;
  /**
   * 0044（只增）：归属文件夹（D-060① 一卷一夹；NULL/undefined=未分类）。
   * 删夹时服务层把夹内卷回未分类（D-062），列无外键约束（应用层维护）。
   */
  folderId?: string;
}

/**
 * 0004-fix-4 2.3（只增）：paper_questions 行类型——'text' = 文本内容块（大标题/备注等），不占题号。
 * 缺省/undefined = 题目行（题号按题目行递增）。
 */
export type PaperQuestionKind = 'question' | 'text';

/** 0004-fix-4 2.3：文本块样式（section=节标题观感，缺省；note=普通说明文字） */
export type PaperTextBlockStyle = 'section' | 'note';

/**
 * 0004-fix-6 P1-1（只增）：文本块对齐（左/中/右）。
 * 缺省（undefined）= 样式基线观感（section 居中 / note 左），不输出对齐类，存量渲染零漂移；
 * 显式值输出对齐类覆盖基线（渲染 .mf-text-item--align-*）。
 */
export type PaperTextBlockAlign = 'left' | 'center' | 'right';

/**
 * 0004-fix-4 2.3：文本内容块（渲染输入 textBlocks 的条目；行内数据在 PaperQuestionRef.textBody）。
 * 复用题序列的 position/重排/克隆机制，渲染为节标题块（不参与题号）。
 */
export interface PaperTextBlock {
  /** 行 id（= PaperQuestionRef.questionId，合成 `text:<uuid>`） */
  id: string;
  text: string;
  style?: PaperTextBlockStyle;
  /** 0004-fix-6 P1-1（只增）：对齐（缺省=样式基线观感） */
  align?: PaperTextBlockAlign;
}

/**
 * 0013（只增）：选择题选项版式三态。
 * auto=竖排（缺省基线，渲染输出零回归）；single-line=单行 1×N 均分横排；two-lines=两行均分。
 * 生效值解析：题级覆盖（PaperQuestionRef.layout.optionsLayout）?? 卷级默认档
 * （PaperLayoutConfig.optionsLayout）?? 'auto'；非法值统一归一 auto（渲染侧归一化单源，
 * 见 docgen/render/layout.ts normalizeOptionsLayout）。题级显式 'auto' = 有意覆盖卷级档回自动
 * （预览操作条循环切换 auto→单行→两行→auto 的落库形态）。
 */
export type OptionsLayoutMode = 'auto' | 'single-line' | 'two-lines';

export interface PaperQuestionRef {
  id: string;
  paperId: string;
  questionId: string;
  position: number;
  score?: number;
  frozen: boolean;
  /**
   * 0004-fix-4 2.3（只增）：行类型（'text'=文本内容块；缺省/undefined=题目行）。
   * text 行的 questionId 为合成 id（`text:<uuid>`），不指向 questions 表。
   */
  kind?: PaperQuestionKind;
  /** kind='text' 的正文（纯文本，渲染侧转义后输出） */
  textBody?: string;
  /** kind='text' 的样式（缺省 section） */
  style?: PaperTextBlockStyle;
  /** 0004-fix-6 P1-1（只增）：kind='text' 的对齐（缺省=样式基线观感） */
  align?: PaperTextBlockAlign;
  /**
   * 0004 Phase 5（只增）：题级图排版覆盖（paper_questions.layout_json 解析值；
   * 缺省/无列值 = 未覆盖，渲染走全局 figureLayout/默认档）。
   * 0004-fix-3（只增）：扩题级作答区覆盖 answerSpace。
   * 0013（只增）：扩题级选项版式覆盖 optionsLayout（见 OptionsLayoutMode；缺省/非法=回落卷级档）。
   */
  layout?: { figures?: QuestionFigureLayout[]; answerSpace?: QuestionAnswerSpaceOverride; optionsLayout?: OptionsLayoutMode };
}

export interface QuestionFilter {
  subject?: string;
  /** 0002 B5 四维筛选：字典维度 */
  subjectId?: string;
  typeId?: string;
  /**
   * 0014（只增）：题型多值（IN 查询；「选择题」聚合=单选+多选字典行展开走此字段）。
   * 与 typeId 同现时 typeId 优先、typeIds 忽略——同一维度两参数同现属调用方错误，
   * 取单值口径保守不炸（0014 任务书 §一.4 授权口径，施工定 typeId 优先并记档）。
   */
  typeIds?: string[];
  difficultyId?: string;
  /** 0002 B5：树节点维度（子树派生——含该节点全部后代的挂接题）；0014 题库页节点筛题接通 UI */
  treeNodeId?: string;
  /**
   * 0014 目检返工（只增）：学段维度——题面无学段列，经「挂树链接→树」间接筛
   * （命中挂在该学段任何树节点上的题；未挂树题不命中）。空串/缺省=不过滤。
   * 匹配口径 COALESCE(NULLIF(stage,''),'未分组')（树面板学段集合同源）。
   */
  stage?: string;
  tag?: string;
  keyword?: string;
}

export interface PaperSummary {
  paper: Paper;
  questionCount: number;
  totalScore: number;
}

export interface BankService {
  // Question operations
  createQuestion(data: Omit<Question, 'id' | 'createdAt' | 'updatedAt'>): Promise<Question>;
  getQuestion(id: string): Promise<Question | null>;
  listQuestions(filter?: QuestionFilter): Promise<Question[]>;
  updateQuestion(id: string, data: Partial<Omit<Question, 'id' | 'createdAt'>>): Promise<Question>;
  /** D1-fix-4 复验（只增）：软删（deleted=1），list/get 已过滤；试卷内引用保留但取题自然消失，不级联 */
  deleteQuestion(id: string): Promise<void>;
  addTag(questionId: string, tag: string, color?: string): Promise<void>;
  removeTag(questionId: string, tag: string): Promise<void>;

  // Paper operations
  createPaper(title: string, config?: Record<string, unknown>): Promise<Paper>;
  getPaper(id: string): Promise<Paper | null>;
  listPapers(): Promise<PaperSummary[]>;
  /**
   * 0004-fix-4 2.3（只增）：第 5 参 textBlock = 文本内容块（kind='text' 行，不占题号）。
   * 语义：同 (paperId, questionId) 行已存在且为文本块 → 更新正文/样式（upsert，复用本通道，
   * 不新增 IPC 通道面）；不存在 → 追加为文本块行。questionId 用合成 id（`text:<uuid>`）。
   * 0004-fix-6 P1-1（只增）：textBlock 扩 align。
   * 第 4 参 layout = 题级图排版覆盖（clone 内部随行拷贝用，与 PaperService 实现同形）。
   */
  addQuestion(
    paperId: string,
    questionId: string,
    score?: number,
    layout?: PaperQuestionRef['layout'],
    textBlock?: { text: string; style?: PaperTextBlockStyle; align?: PaperTextBlockAlign }
  ): Promise<void>;
  removeQuestion(paperId: string, questionId: string): Promise<void>;
  reorderQuestions(paperId: string, questionIds: string[]): Promise<void>;
  getPaperQuestions(paperId: string): Promise<PaperQuestionRef[]>;
  /** 0018 目检返工三：score = undefined 表示清除分值（回未设置；paper_questions.score 列置 NULL） */
  setQuestionScore(paperId: string, questionId: string, score: number | undefined): Promise<void>;
}

// ====================================================================
// 0002 新增实体契约（bank 服务扩展：dict/tree/student/class/exam/mistake/paper_set/preset）
// ====================================================================

// ---------- 字典（G2/U6/U12） ----------

export type DictKind = 'subject' | 'question_type' | 'difficulty';

/** 元信息字典条目：归一行 site=null；站点同义行 site+sourceLabel（code=标准码，映射查看走 U12 设置页） */
export interface DictEntry {
  /** 服务端按 kind 前缀生成：归一行 'subj:phy' 式；站点行含 site 段 */
  id: string;
  kind: DictKind;
  /** 标准码（归一后） */
  code: string;
  /** 标准显示名 */
  label: string;
  /** 来源站（归一行=null） */
  site?: string;
  /** 站点原文标签（站点行） */
  sourceLabel?: string;
  active: boolean;
}

export interface DictEntryInput {
  kind: DictKind;
  code: string;
  label: string;
  site?: string;
  sourceLabel?: string;
  active?: boolean;
}

export interface DictService {
  listEntries(filter?: { kind?: DictKind; activeOnly?: boolean }): Promise<DictEntry[]>;
  getEntry(id: string): Promise<DictEntry | null>;
  /** 拍板 §6-10 重名守卫：归一行（site=null）同 kind 同 label 重名抛错（SQLite 唯一约束不拦 NULL 列） */
  createEntry(data: DictEntryInput): Promise<DictEntry>;
  /** U12 未知值人工指认归一 = 更新 code；active 开关也走此处 */
  updateEntry(id: string, data: { code?: string; label?: string; active?: boolean }): Promise<DictEntry>;
}

// ---------- 树（B3/B4/U5/U12） ----------

export type TreeType = 'textbook' | 'knowledge';

export interface Tree {
  id: string;
  type: TreeType;
  subjectId?: string;
  /** 教材版本（textbook 树用：人教/鲁教…）；新教材=新树，旧树保留 */
  edition?: string;
  stage?: string;
  name: string;
  /** 采集来源站 */
  source?: string;
  createdAt: string;
}

export interface TreeNode {
  id: string;
  treeId: string;
  /** null=根（顶层） */
  parentId?: string;
  name: string;
  sort: number;
}

/** 多挂（B3）：一题可挂多章节/知识点节点，跨树/同树多节点均可 */
export interface QuestionNodeLink {
  questionId: string;
  nodeId: string;
}

/** 站点→标准对应关系（U12：只读查看 + 建树先对齐） */
export interface TreeSourceMapping {
  nodeId: string;
  site: string;
  siteNodeId: string;
  siteNodeName?: string;
}

export interface TreeService {
  createTree(data: { type: TreeType; name: string; subjectId?: string; edition?: string; stage?: string; source?: string }): Promise<Tree>;
  /**
   * 0039（只增）：默认只返回未归档树——树收敛后每学段×学科一套权威树，冗余来源/教材树
   * 以「（已归档·0039）」后缀软删；includeArchived: true 取全量（治理/审计/重跑计划用）。
   */
  listTrees(filter?: { type?: TreeType; subjectId?: string; includeArchived?: boolean }): Promise<Tree[]>;
  getTree(id: string): Promise<Tree | null>;
  /** 树内全部节点平铺（parentId 组织层级；同级按 sort） */
  getNodes(treeId: string): Promise<TreeNode[]>;
  /** 后代展开（递归 CTE）：含自身与全部后代，先序 + 深度 */
  getDescendants(nodeId: string): Promise<Array<TreeNode & { depth: number }>>;
  /** 采集建树/后台更新加节点（B4：无用户编辑；id 稳定，不删有链接节点） */
  createNode(data: { treeId: string; parentId?: string; name: string; sort?: number; sourceMapping?: { site: string; siteNodeId: string; siteNodeName?: string } }): Promise<TreeNode>;
  /** 拍板 §6-10 重名守卫：根节点（parentId=null）同树重名抛错 */
  linkQuestion(questionId: string, nodeId: string): Promise<void>;
  unlinkQuestion(questionId: string, nodeId: string): Promise<void>;
  getQuestionNodes(questionId: string): Promise<TreeNode[]>;
  /** 站点节点 → 本地节点（建树幂等导入） */
  resolveSourceNode(site: string, siteNodeId: string): Promise<TreeNode | null>;
  getSourceMappings(nodeId: string): Promise<TreeSourceMapping[]>;
}

// ---------- 学生/班级/时间线（B6） ----------

export type StudentStatus = 'active' | 'archived';
export type ClassStatus = 'active' | 'closed';

/** 学生档案：id 唯一标识；name 非唯一（重名常态） */
export interface Student {
  id: string;
  studentNo?: string;
  name: string;
  gender?: string;
  school?: string;
  remark?: string;
  status: StudentStatus;
  createdAt: string;
  updatedAt: string;
}

/** 班级生命周期：active=当前分班 / closed=历史分班 */
export interface ClassInfo {
  id: string;
  name: string;
  school?: string;
  gradeLevel?: string;
  term?: string;
  status: ClassStatus;
  createdAt: string;
}

/** 多对多 + 时期（转班/多班；endedAt null=至今） */
export interface StudentClassPeriod {
  studentId: string;
  classId: string;
  startedAt?: string;
  endedAt?: string;
}

export type StudentEventType = 'exam_score' | 'performance' | 'note' | 'photo_attach';

/** 时间线事件 payload（按 eventType 收敛，service 校验；不得 any/unknown） */
export type StudentEventPayload =
  | { eventType: 'exam_score'; examId?: string; score?: number; subjectId?: string }
  | { eventType: 'performance'; text: string }
  | { eventType: 'note'; text: string; title?: string }
  | { eventType: 'photo_attach'; assetId: string; caption?: string };

/** G4 统一时间线事件 */
export interface StudentEvent {
  id: string;
  studentId: string;
  eventType: StudentEventType;
  /** 事件发生时间（非录入时间） */
  occurredAt: string;
  payload: StudentEventPayload;
  createdAt: string;
}

export interface StudentService {
  createStudent(data: { name: string; studentNo?: string; gender?: string; school?: string; remark?: string }): Promise<Student>;
  getStudent(id: string): Promise<Student | null>;
  /** 默认只回 active（封存列表默认隐藏，B6）；includeArchived=true 全量可查 */
  listStudents(filter?: { includeArchived?: boolean; classId?: string; keyword?: string }): Promise<Student[]>;
  updateStudent(id: string, data: Partial<Omit<Student, 'id' | 'createdAt' | 'updatedAt' | 'status'>>): Promise<Student>;
  /** 封存/恢复（B6：信息保留、列表默认隐藏、历史不丢） */
  setStudentStatus(id: string, status: StudentStatus): Promise<Student>;
  /** 入班（多对多+时期）；同班存在未结束时期时拒绝 */
  enrollStudent(studentId: string, classId: string, startedAt?: string): Promise<StudentClassPeriod>;
  /** 结束时期（转班/毕业） */
  endEnrollment(studentId: string, classId: string, endedAt: string): Promise<void>;
  getStudentClasses(studentId: string): Promise<Array<StudentClassPeriod & { className?: string }>>;
  /** 班级名册（某班学生时期） */
  getClassStudents(classId: string): Promise<StudentClassPeriod[]>;
  /** payload 与 eventType 不匹配抛错（service 校验） */
  addEvent(data: { studentId: string; eventType: StudentEventType; occurredAt: string; payload: StudentEventPayload }): Promise<StudentEvent>;
  /** B6 筛选：类别 × 时间范围 × 班级时期（班级时期=occurredAt 落在 [startedAt, endedAt]） */
  listEvents(filter: { studentId: string; eventType?: StudentEventType; from?: string; to?: string; classId?: string }): Promise<StudentEvent[]>;
}

export interface ClassService {
  createClass(data: { name: string; school?: string; gradeLevel?: string; term?: string }): Promise<ClassInfo>;
  getClass(id: string): Promise<ClassInfo | null>;
  listClasses(filter?: { status?: ClassStatus | 'all' }): Promise<ClassInfo[]>;
  updateClass(id: string, data: Partial<Omit<ClassInfo, 'id' | 'createdAt'>>): Promise<ClassInfo>;
  /** 闭班（结课） */
  closeClass(id: string): Promise<ClassInfo>;
}

// ---------- 考试/错题/成绩（B7/U2/U7/U9/U10/U14） ----------

/** B7：考试独立实体（可关联组卷集合，可无卷=校外登记） */
export interface Exam {
  id: string;
  title: string;
  classId?: string;
  subjectId?: string;
  occurredAt: string;
  paperSetId?: string;
  remark?: string;
  createdAt: string;
}

/** U14：成绩独立落表（exam_id+student_id 唯一；score 可空=缺考/未录） */
export interface ExamScore {
  id: string;
  examId: string;
  studentId: string;
  score?: number;
  /** 大题分明细等扩展 */
  detail?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ScoreEntry {
  studentId: string;
  score?: number;
  detail?: Record<string, unknown>;
}

/** U7/U10：登记结果条目（wrongQuestionIds = 大题号上游映射后的该大题全部 question_id） */
export interface ExamResultEntry extends ScoreEntry {
  wrongQuestionIds?: string[];
}

export interface ExamRecordSummary {
  scoresUpserted: number;
  mistakesCreated: number;
  mistakesUpdated: number;
  /** U9 红自动升黄数（黄题重复做对只刷 lastCorrectAt 不计） */
  autoPromotedToYellow: number;
  /** 触发自动升黄的学生数（0=无卷考试/该生无卷） */
  promotedStudents: number;
}

export interface ExamService {
  createExam(data: { title: string; classId?: string; subjectId?: string; occurredAt: string; paperSetId?: string; remark?: string }): Promise<Exam>;
  getExam(id: string): Promise<Exam | null>;
  listExams(filter?: { classId?: string; subjectId?: string }): Promise<Exam[]>;
  /** 成绩批量 upsert；同时写 student_events.exam_score（仅作时间线展示流，U14） */
  recordScores(examId: string, entries: ScoreEntry[]): Promise<number>;
  getExamScores(examId: string): Promise<ExamScore[]>;
  getStudentScores(studentId: string): Promise<Array<ExamScore & { examTitle?: string }>>;
  /**
   * G5 全量登记（拍板 §6-7/§6-8）：
   * 成绩 upsert + 勾错题自动标红入本（存在则刷新 occurredAt 回红）+ U9 自动升黄——
   * 考试关联卷时该生卷中未被勾错的题视为做对：存量红题升黄、黄题刷新 lastCorrectAt（黄不自动升绿）；
   * 无卷考试（或该生在 custom-mistake 集合中无卷）不触发。
   */
  recordResults(examId: string, entries: ExamResultEntry[]): Promise<ExamRecordSummary>;
}

// ---------- 错题本（U2/U9/U10） ----------

export type MistakeStage = 'red' | 'yellow' | 'green';

/** 题快照（题改/软删后错题仍可显示，与 paper_snapshots 同哲学） */
export interface MistakeQuestionSnapshot {
  /** 优先 stemHtml，回落 content */
  stemHtml: string;
  options: QuestionOption[];
  answer?: string;
  analysis?: string;
  images: QuestionImage[];
}

/** 错题 = 一生一题的关系（拍板 §6-1：(question_id, student_id) 全局唯一；多次错=更新同一关系） */
export interface Mistake {
  id: string;
  questionId: string;
  studentId: string;
  /** 来源考试（null=手动登记） */
  examId?: string;
  sourcePaperId?: string;
  occurredAt: string;
  stage: MistakeStage;
  /** 最近做对时间（U9 自动升级依据） */
  lastCorrectAt?: string;
  snapshot: MistakeQuestionSnapshot;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MistakeService {
  /** 登记错题：新关系标红；已存在则刷新 occurredAt/examId/sourcePaperId、stage 回红、快照刷新（历史留痕走 student_events） */
  recordWrong(data: { questionId: string; studentId: string; examId?: string; sourcePaperId?: string; occurredAt: string; note?: string }): Promise<{ mistake: Mistake; created: boolean }>;
  getMistake(id: string): Promise<Mistake | null>;
  listMistakes(filter?: { studentId?: string; stage?: MistakeStage; questionId?: string; examId?: string }): Promise<Mistake[]>;
  /** 手动切换（U2：黄→绿只能手动；可回退红） */
  setStage(id: string, stage: MistakeStage): Promise<Mistake>;
  /** 点状态灯循环：red→yellow→green→red */
  cycleStage(id: string): Promise<Mistake>;
  setNote(id: string, note: string): Promise<void>;
  /** U10：宁可多标，多出的人工删 */
  deleteMistake(id: string): Promise<void>;

  // ==================== 0025 P1（只增）：错题闭环聚合/批量/导出 ====================

  /** 按题聚合错误人次（默认人次降序；同人次按题号升序，稳定次序） */
  aggregateByQuestion(filter?: MistakeAggregateFilter): Promise<MistakeAggregateRow[]>;
  /** 批量删除（幂等：不存在 id 跳过、只计实际删除数；ids 空 → 抛错；operation_log 记 affectedCount） */
  deleteMistakes(ids: string[]): Promise<MistakeBatchResult>;
  /** 批量改 stage（幂等/空集语义同 deleteMistakes） */
  setStages(ids: string[], stage: MistakeStage): Promise<MistakeBatchResult>;
  /** 按筛选导出题目 id 集（去重，次序同 aggregateByQuestion——0026 入篮按序切片） */
  exportQuestionIds(filter?: MistakeAggregateFilter): Promise<string[]>;
}

// ==================== 0025 P1（只增）：错误人次聚合类型 ====================

/**
 * 错误人次聚合过滤（三过滤器可单用/可组合；全部缺省 = 全量）。
 * 时间窗按 occurred_at 字典序比较（ISO 串）：date-only（YYYY-MM-DD）下界视为当日 00:00:00.000、
 * 上界视为当日 23:59:59.999（含全天）。
 */
export interface MistakeAggregateFilter {
  /** 错题状态（红/黄/绿）；缺省=全部 */
  stage?: MistakeStage;
  /** 学科（questions.subject 精确匹配）；缺省=全部 */
  subject?: string;
  /** 时间窗下界（含）：ISO 串或 date-only */
  occurredFrom?: string;
  /** 时间窗上界（含）：ISO 串或 date-only */
  occurredTo?: string;
  /** 限定学生集合（OR 语义；D1 勾选学生导出用）；缺省或空数组=全部学生 */
  studentIds?: string[];
}

/** 按题聚合的错误人次行（0026 错题本 / 班情报表消费） */
export interface MistakeAggregateRow {
  questionId: string;
  /** 错误人次 = COUNT(DISTINCT student_id)（一生一题唯一关系，重复登记不叠加） */
  wrongCount: number;
  /** 题干摘要（strip HTML 后截断 80 字加省略号；来源 questions.stem_html → content） */
  stemSummary: string;
  /** 题面学科（questions.subject） */
  subject: string;
  questionType?: string;
  difficulty?: number;
  /** 该题在筛选口径下的最早/最近一次错误时间（ISO） */
  firstOccurredAt: string;
  lastOccurredAt: string;
}

/** 错题批量操作结果（affectedCount = 实际影响条数，同时为 operation_log 留痕口径） */
export interface MistakeBatchResult {
  affectedCount: number;
}

// ---------- 试卷集合（U7） ----------

/**
 * 0025 P3（只增）：paper_sets.batch_meta 一期字段集（P-06：一期只定字段，二期生成器消费）。
 * 存储仍为 TEXT JSON（列已在，零迁移）；写入时按本字段集校验（非法拒绝），读出时解析（坏数据显式报错）。
 * 未登记键按既有语义原样保留（历史兼容），但不属本契约字段集。
 */
export interface PaperSetBatchMeta {
  /** 每生上限（生成器按此截断该生题目数）；正整数 */
  perStudentLimit?: number;
  /** 时间窗天数（生成器取近 N 天错题）；正数 */
  timeWindowDays?: number;
  /** 来源规则串（一期只登记不解释，二期生成器解析）；非空串 */
  sourceRule?: string;
}

export interface PaperSet {
  id: string;
  name: string;
  type: PaperType;
  /** 生成批次信息（来源 exam/筛选条件）；结构见 PaperSetBatchMeta（未登记键兼容保留） */
  batchMeta?: Record<string, unknown>;
  createdAt: string;
}

export interface PaperSetPaperRef {
  paperSetId: string;
  paperId: string;
  /** custom-mistake：每生一卷；uniform：null */
  studentId?: string;
}

export interface PaperSetService {
  createPaperSet(data: { name: string; type: PaperType; batchMeta?: Record<string, unknown> }): Promise<PaperSet>;
  getPaperSet(id: string): Promise<PaperSet | null>;
  listPaperSets(filter?: { type?: PaperType }): Promise<PaperSet[]>;
  addPaper(paperSetId: string, paperId: string, studentId?: string): Promise<void>;
  removePaper(paperSetId: string, paperId: string): Promise<void>;
  getSetPapers(paperSetId: string): Promise<PaperSetPaperRef[]>;
  /** custom-mistake：查某生在集合中的卷 */
  getStudentPaper(paperSetId: string, studentId: string): Promise<PaperSetPaperRef | null>;
  /** 删集合；引用的 papers 保留不动（B11） */
  deletePaperSet(id: string): Promise<void>;
}

// ---------- 版式预设（G7） ----------

export interface LayoutPreset {
  id: string;
  name: string;
  config: PaperLayoutConfig;
  isBuiltin: boolean;
  createdAt: string;
}

export interface PresetService {
  createPreset(data: { name: string; config: PaperLayoutConfig; isBuiltin?: boolean }): Promise<LayoutPreset>;
  getPreset(id: string): Promise<LayoutPreset | null>;
  /** 默认不含软删；includeDeleted=true 全量 */
  listPresets(filter?: { includeDeleted?: boolean }): Promise<LayoutPreset[]>;
  updatePreset(id: string, data: { name?: string; config?: PaperLayoutConfig }): Promise<LayoutPreset>;
  /** B11：内置不可删（抛错）；用户预设软删；已出卷 config 拷贝不受影响 */
  deletePreset(id: string): Promise<void>;
}

// ---------- Paper 状态机/版式扩展操作（走 papers 新列；随 bank.paper.* 通道暴露） ----------

export interface PaperCreateOptions {
  status?: PaperStatus;
  paperType?: PaperType;
}

export interface PaperExtService {
  createPaperEx(title: string, config?: Record<string, unknown>, opts?: PaperCreateOptions): Promise<Paper>;
  /** 状态机切换（见 PaperStatus 合法迁移），非法迁移抛错 */
  updatePaperStatus(id: string, status: PaperStatus): Promise<void>;
  /** 出卷定稿：写入 version 化版式 config 拷贝 */
  setPaperLayoutConfig(id: string, layoutConfig: PaperLayoutConfig): Promise<void>;

  // ==================== 0004（只增）：试题篮/快照/克隆/重命名 ====================

  /** 全状态卷列表（不过滤 archived；statuses 缺省=除 trashed 外全部）；历史卷查看/克隆需要读 archived。
   *  0044（只增）：缺省**排除 trashed**（回收站不在常规列表）；显式含 trashed 走 statuses 传入。 */
  listPapersEx(filter?: { statuses?: PaperStatus[] }): Promise<PaperSummary[]>;
  /** 单卷详情，含 archived 卷（预览/导出/克隆/恢复入口）；不存在返回 null */
  getPaperEx(id: string): Promise<Paper | null>;
  /**
   * 出卷定稿前置步骤：对当前 paper_questions 每行 upsert 写 paper_snapshots
   * （content_snapshot = Question 全字段 JSON；题不存在/已软删抛错）；返回写入行数。
   * UI 必须快照成功后才允许置 done。
   */
  snapshotPaperQuestions(paperId: string): Promise<number>;
  /** 读快照还原 Question[]（按 paper_questions.position 序；无快照行返回空） */
  listPaperSnapshotQuestions(paperId: string): Promise<Question[]>;
  /**
   * 复制为 status=basket 新卷：标题缺省=`原标题+复制`；题引用(position/score)与 config/layoutConfig 拷贝。
   * 题源规则：快照有行 → 原题仍存在（未软删）则引用原 id，否则从快照重建新题再引用；
   * 快照无行（旧卷未快照）→ 逐题取现题引用，缺失题跳过。
   */
  clonePaperToBasket(sourcePaperId: string, title?: string): Promise<Paper>;
  /** 卷重命名（空/空白标题拒绝）；返回更新后的 Paper */
  updatePaperTitle(id: string, title: string): Promise<Paper>;
  /**
   * 0004 Phase 5（只增）：题级图排版覆盖写入（整体覆盖式：layout 为该题最终覆盖态，
   * 空覆盖 figures:[] = 清除）。UPDATE paper_questions.layout_json；卷-题引用不存在抛错。
   * 放入 PaperExtService 的理由：操作对象是 paper_questions 行（与 setQuestionScore/reorderQuestions
   * 同族），复用既有 paper 命名空间通道，不另开服务面。
   * 0004-fix-3（只增）：layout 扩题级作答区覆盖 answerSpace。
   * 0013（只增）：layout 扩题级选项版式覆盖 optionsLayout（与 PaperQuestionRef.layout 同构只增）。
   */
  setQuestionLayouts(paperId: string, questionId: string, layout: { figures?: QuestionFigureLayout[]; answerSpace?: QuestionAnswerSpaceOverride; optionsLayout?: OptionsLayoutMode }): Promise<void>;

  // ==================== 0044（只增）：试卷文件夹 + 回收站（D-060~D-063） ====================

  /** 文件夹全量平铺（渲染层建父子索引复用共享 TreeRows/buildParentIndex，D-063） */
  listFolders(): Promise<PaperFolder[]>;
  /** 建夹（可带 parentId 嵌套；父不存在抛错；父链防环校验在服务层） */
  createFolder(data: { name: string; parentId?: string }): Promise<PaperFolder>;
  /** 夹重命名（空/空白名拒绝；夹不存在抛错） */
  renameFolder(id: string, name: string): Promise<PaperFolder>;
  /**
   * 删夹（D-062 口径）：夹内卷 `folder_id` 置 NULL 回未分类；子夹 `parent_id` 上移一级
   * （挂到被删夹的父级，被删夹为顶级则子夹升顶级）；夹不存在抛错。
   */
  deleteFolder(id: string): Promise<void>;
  /** 移卷入夹（一卷一夹；folderId=null=移出回未分类；夹/卷不存在抛错） */
  moveToFolder(paperId: string, folderId: string | null): Promise<void>;
  /** 入回收站（任意非 trashed → trashed；服务层记 trashed_from=原状态；已 trashed 再 trash 抛错） */
  trashPaper(id: string): Promise<void>;
  /** 恢复（读 trashed_from 还原原状态并清空；非 trashed 卷抛错；trashed_from 缺失=数据异常抛错不猜） */
  restorePaper(id: string): Promise<void>;
  /**
   * 彻底删除（仅 trashed 卷可用，否则抛错）：paper_questions 关联行级联清理（题目本体不动——
   * 题在题库独立存活）；paper_snapshots / paper_set_papers 孤儿关联行一并清理（服务端申报口径）。
   */
  deleteForeverPaper(id: string): Promise<void>;
}

// ---------- 0005 课后反馈（M6）：文本反馈模板（照 preset 模式：内置只读守卫 + 用户软删） ----------

export interface FeedbackTemplate {
  id: string;
  name: string;
  /** 模板正文（中文键变量插值：{学生姓名}{科目}{日期}{考试名称}{成绩}{错题情况}{课堂表现}{本次内容}{学习建议}{老师姓名}） */
  bodyTemplate: string;
  isBuiltin: boolean;
  createdAt: string;
  updatedAt: string;
}

export type FeedbackTemplateInput = {
  name: string;
  bodyTemplate: string;
};

export interface FeedbackService {
  createTemplate(data: FeedbackTemplateInput): Promise<FeedbackTemplate>;
  getTemplate(id: string): Promise<FeedbackTemplate | null>;
  /** 默认不含软删；includeDeleted=true 全量 */
  listTemplates(filter?: { includeDeleted?: boolean }): Promise<FeedbackTemplate[]>;
  updateTemplate(id: string, data: Partial<FeedbackTemplateInput>): Promise<FeedbackTemplate>;
  /** 内置不可删（抛错）；用户模板软删 */
  deleteTemplate(id: string): Promise<void>;
}

// ---------- 0030 反馈模块一期：AI 通道提示词模板 + 反馈记录（D-065 双模式） ----------
//
// 与 0005 的分工（两条通道互不替代）：
//   • 离线通道 = `feedback`（0005）：feedback_templates 正文插值，无 Key 可用，语义不动；
//   • AI 通道  = `feedbackPrompt`（本单）：提示词模板（内置 + 自定义，全文可见可改可导出/导入）；
//   • 落档     = `feedbackRecord`（本单）：一次「保存记录」一条，双模式（快速=student_id NULL 留痕 /
//               批量=关联学生与班级）；**无「已发」状态**（D-065⑥：只有保存一个动作，不跟踪发没发）。

/** 0030（只增）：生成通道（离线插值 / AI 润色）——落档时记录「当时怎么生成的」 */
export type FeedbackChannel = 'offline' | 'ai';

/** 0030（只增）：提示词模板（AI 通道；正文含 {变量} 槽位，事实五项 + 风格三项） */
export interface FeedbackPromptTemplate {
  id: string;
  name: string;
  /** 提示词全文（含槽位）——组装器按槽位填真实数据与风格档位，见 src/app/feedback/prompt.ts */
  body: string;
  isBuiltin: boolean;
  createdAt: string;
  updatedAt: string;
}

export type FeedbackPromptTemplateInput = {
  name: string;
  body: string;
};

export interface FeedbackPromptTemplateService {
  createTemplate(data: FeedbackPromptTemplateInput): Promise<FeedbackPromptTemplate>;
  getTemplate(id: string): Promise<FeedbackPromptTemplate | null>;
  /** 默认不含软删；includeDeleted=true 全量；内置在前 */
  listTemplates(filter?: { includeDeleted?: boolean }): Promise<FeedbackPromptTemplate[]>;
  /** 内置只读：is_builtin=1 拒绝（抛错）；用户模板可改 */
  updateTemplate(id: string, data: Partial<FeedbackPromptTemplateInput>): Promise<FeedbackPromptTemplate>;
  /** 内置只读：is_builtin=1 拒绝（抛错）；用户模板软删 */
  deleteTemplate(id: string): Promise<void>;
}

/** 0030（只增）：一条反馈记录（含快速模式留痕） */
export interface FeedbackRecord {
  id: string;
  /** NULL = 快速模式留痕（不关联学生档案） */
  studentId: string | null;
  studentName: string;
  classId: string | null;
  examId: string | null;
  channel: FeedbackChannel;
  /** AI 通道所用提示词模板 id（离线通道为空） */
  promptTemplateId: string | null;
  /** AI 通道实际使用的提示词全文快照（离线通道为空） */
  promptSnapshot: string | null;
  /** 生成时 reasoning 角色档案 id（离线通道为空） */
  modelProfileId: string | null;
  /** 四项输入快照（JSON 文本：{课堂内容,课堂表现[],课后任务,成绩}） */
  inputJson: string;
  /** 保存时以编辑后正文为准 */
  body: string;
  createdAt: string;
  updatedAt: string;
}

export type FeedbackRecordInput = {
  /** 缺省/null = 快速模式留痕 */
  studentId?: string | null;
  studentName: string;
  classId?: string | null;
  examId?: string | null;
  channel: FeedbackChannel;
  promptTemplateId?: string | null;
  promptSnapshot?: string | null;
  modelProfileId?: string | null;
  inputJson: string;
  body: string;
};

/** 记录页筛选（均缺省=全量，创建时间倒序） */
export interface FeedbackRecordQuery {
  /** 班级 chip 筛选 */
  classId?: string;
  /** 学生姓名关键字（模糊匹配） */
  studentName?: string;
}

/** 0030（只增）：记录更新面——只允许改正文与姓名（时间/通道/快照属留痕，不可改） */
export type FeedbackRecordPatch = {
  body?: string;
  studentName?: string;
};

export interface FeedbackRecordService {
  createRecord(data: FeedbackRecordInput): Promise<FeedbackRecord>;
  getRecord(id: string): Promise<FeedbackRecord | null>;
  listRecords(query?: FeedbackRecordQuery): Promise<FeedbackRecord[]>;
  updateRecord(id: string, data: FeedbackRecordPatch): Promise<FeedbackRecord>;
  deleteRecord(id: string): Promise<void>;
}

/**
 * 0002 新增 bank 服务集合。
 * 真实实现走 SQLite（src/bank/ext-services.ts 组装）；mock 实现内存对齐（契约测试双跑同绿）。
 * 不并入 BankService 接口——bridge.ts（renderer 桥）0002 冻结，接线随 UI 里程碑。
 */
export interface BankExtServices {
  dict: DictService;
  tree: TreeService;
  student: StudentService;
  class: ClassService;
  exam: ExamService;
  mistake: MistakeService;
  paperSet: PaperSetService;
  preset: PresetService;
  paper: PaperExtService;
  /** 0005（只增）：课后反馈模板 CRUD（渲染纯函数/卡片 IO 不在服务面——服务侧不存） */
  feedback: FeedbackService;
  /** 0030（只增）：AI 通道提示词模板（内置只读 + 自定义；与 0005 离线模板并存） */
  feedbackPrompt: FeedbackPromptTemplateService;
  /** 0030（只增）：反馈记录落档（双模式；快速模式 student_id=NULL 仅留痕） */
  feedbackRecord: FeedbackRecordService;
}

/**
 * 0037（只增）：首页沉淀统计聚合（guard.getDashboard 返回）。
 * 口径见 home-dashboard 设计稿 §2 与 0037 任务书 §一 P1，
 * 及目检返工意见 #4/#5（2026-09-21）：题库题目=未删除题数；试卷库=不含回收站；
 * 录入文档=recog_runs 识别记录数（每识别一份文件计一篇；返工 #4 换入，原「网络采集」撤下）；
 * 错题沉淀=mistakes「学生×题」条数（与错题本页学生口径一致）；
 * AI 次数/token=operation_log 'ai.invoke' 成功留痕累计（零新表）。
 */
export interface AiDailyCount {
  /** 本地日期键 YYYY-MM-DD */
  date: string;
  count: number;
  /** 该日成功调用 token 累计（供应商未返回 usage 不计入；返工 #5：柱悬停弹窗用） */
  tokens: number;
}

/**
 * 0049（只增）：六类工作动作（流量口径；与设计稿 home-dashboard-v3 设计稿 图例一一对应）。
 * 口径 = 操作日志里的「动手次数」，与教学资产（存量：现有多少）互不重复（D-068 存量/流量分层）。
 * 实现侧映射表见 src/bank/dashboard-service.ts（WORK_CATEGORY_RULES）；本单采集与录题同源不可分，
 * 采集并入录题（图例五类，申报见 0049 交付报告）——'capture' 保留为
 * 未来可分的占位口径，当前恒 0。
 */
export type HomeWorkCategory = 'proof' | 'capture' | 'compose' | 'mistake' | 'feedback' | 'ai';

/** 0049（只增）：足迹按日一行（零日补 0） */
export interface HomeActivityDay {
  /** 本地日期键 YYYY-MM-DD */
  date: string;
  /** 当日六类动作次数（零补 0） */
  byCategory: Record<HomeWorkCategory, number>;
  /** 当日 ai.invoke tokens（供应商未返回 usage 不计） */
  tokens: number;
}

export interface HomeDashboardStats {
  questions: number;
  papers: number;
  documentsRecognized: number;
  mistakeRecords: number;
  aiInvocations: number;
  aiTokens: number;
  /** 近 30 天按日 AI 调用 {次数, token}（零日补 0、升序、末位=今日） */
  aiDaily: AiDailyCount[];
  /**
   * 0049（只增）：工作足迹近 26 周窗口（周一始、今日止，零日补全、升序）——流量口径。
   * 起点 = 本周一 −26 周（今日为周一时恰 183 天，其余 184~189 天，多出的是本周已过日）。
   */
  activity: HomeActivityDay[];
  /** 0049（只增）：连续活跃天数（当日六类合计 >0 计活跃；只计 status='succeeded' 留痕） */
  streak: { current: number; longest: number };
  /** 0049（只增）：沉淀曲线——现存题按 created_at 累计（终点恒等 questions 计数；已删题不回溯计入） */
  questionGrowth: Array<{ date: string; total: number }>;
  /**
   * 0049（只增）：最近试卷 ≤3 份（排除回收站 status≠'trashed'）。
   * 注：papers 表无 updated_at 列（本单零迁移约束），updatedAt 实际取 papers.created_at（与既有
   * listPapers/listPapersEx 同口径）；字段名沿用任务书授权字面，语义申报见交付报告。
   */
  recentPapers: Array<{ id: string; title: string; status: PaperStatus; questionCount: number; updatedAt: string }>;
}
