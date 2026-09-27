// Phase 3: MofangBridge 接口 — renderer 可见的 window.__mofangBank 类型定义

import type {
  Question, Paper, PaperSummary, PaperQuestionRef,
  // 0035（只增）：DOCX 导出入参用到的版式类型（与渲染引擎同源，避免第二套定义）
  PaperLayoutConfig, QuestionFigureLayout, QuestionAnswerSpaceOverride, OptionsLayoutMode, PaperTextBlock,
} from './bank-types.js';
import type { CaptureWindowState, CaptureExtraction, PaperPreview, PaperImportResult, PaperImportTarget } from './capture-types.js';
// 0003（只增）：bank 扩展桥 payload 复用 ipc-channels 既有 payload 类型（与通道一一对应）
import type {
  DictEntry, Student, StudentEvent, StudentClassPeriod, ClassInfo, Exam, ExamScore,
  ExamRecordSummary, Mistake, PaperSet, PaperSetPaperRef,
  // 0025（只增）：错题闭环聚合/批量返回类型
  MistakeAggregateRow, MistakeBatchResult,
  // 0044（只增）：试卷文件夹行类型（paper_folders）
  PaperFolder,
  // 0037（只增）：首页沉淀统计聚合（guard.getDashboard 返回）
  HomeDashboardStats,
  // 0004（只增）：tree 查询 4 通道返回类型；0016（只增）：tree.getSourceMappings 返回类型
  Tree, TreeNode, TreeSourceMapping,
  // 0004 Phase 5（只增）：preset 返回类型
  LayoutPreset,
  // 0005（只增）：feedback 模板返回类型
  FeedbackTemplate,
  // 0030（只增）：反馈记录 + AI 通道提示词模板返回类型
  FeedbackRecord, FeedbackPromptTemplate,
} from './bank-types.js';
import type {
  DictListPayload, DictIdPayload,
  StudentCreatePayload, StudentIdPayload, StudentListPayload, StudentUpdatePayload,
  StudentSetStatusPayload, StudentEnrollPayload, StudentEndEnrollmentPayload,
  StudentEventAddPayload, StudentEventListPayload,
  ClassCreatePayload, ClassIdPayload, ClassListPayload, ClassUpdatePayload,
  ExamCreatePayload, ExamIdPayload, ExamListPayload, ExamRecordScoresPayload,
  ExamScoresPayload, ExamStudentScoresPayload, ExamRecordResultsPayload,
  MistakeRecordWrongPayload, MistakeIdPayload, MistakeListPayload,
  MistakeSetStagePayload, MistakeSetNotePayload, MistakeRecordWrongResult,
  // 0025（只增）：错题闭环数据层 payload（聚合/批量/题 id 集导出）
  MistakeAggregatePayload, MistakeBatchIdsPayload, MistakeBatchSetStagePayload,
  PaperSetCreatePayload, PaperSetIdPayload, PaperSetListPayload,
  PaperSetGetPapersPayload, PaperSetStudentPaperPayload,
  // 0025（只增）：paper_set 写通道补线 payload（removePaper/delete；addPaper 见 fix-2）
  PaperSetRemovePaperPayload,
  // 0025（只增）：dict.create + tree 写通道补线 payload
  DictCreatePayload, TreeCreatePayload, TreeNodeCreatePayload, TreeLinkPayload, TreeResolveSourcePayload,
  // fix-2（只增）：paper_set.addPaper / bank.paper.setStatus 接线（考试关联已定稿卷）
  PaperSetAddPaperPayload, PaperUpdateStatusPayload,
  // 0004（只增）：试题篮/快照/克隆/重命名 + tree 查询 4 通道（BankBrowser 空态判定） + file.*
  PaperListExPayload, PaperGetPayload, PaperSnapshotPayload, PaperSnapshotListPayload,
  PaperCloneToBasketPayload, PaperUpdateTitlePayload,
  TreeListPayload, TreeNodesPayload, TreeDescendantsPayload, TreeQuestionNodesPayload,
  // 0016（只增）：dict.update 指认 + tree.getSourceMappings 站点映射查看（payload 既有类型补线）
  DictUpdatePayload, TreeSourceMappingsPayload,
  FileImageAsset, FileImportPresetResult, FileExportPresetPayload,
  // 0057（只增）：file.saveRecogImage 入参（录题裁图产物落 recog/）
  FileSaveRecogImagePayload,
  // 0004 Phase 5（只增）：版式定稿/题级图覆盖/版式预设 5 通道
  PaperSetLayoutConfigPayload, PaperSetQuestionLayoutsPayload,
  PresetCreatePayload, PresetIdPayload, PresetListPayload, PresetUpdatePayload,
  // 0005（只增）：feedback 模板 4 通道 + 输出 IO
  FeedbackCreatePayload, FeedbackIdPayload, FeedbackListPayload, FeedbackUpdatePayload,
  // 0030（只增）：feedback.records.* / feedback.promptTemplates.* payload
  FeedbackRecordCreatePayload, FeedbackRecordListPayload, FeedbackRecordUpdatePayload, FeedbackRecordIdPayload,
  FeedbackPromptCreatePayload, FeedbackPromptListPayload, FeedbackPromptUpdatePayload, FeedbackPromptIdPayload,
  FileExportTextPayload, FeedbackExportCardsPayload, FeedbackExportCardsResult,
  // 0030（只增）：文本文件导入结果（提示词模板 pack）
  FileImportTextResult,
  // 0061（只增）：废图清理两通道（扫描预览 + 移入回收目录）
  FileScanRecogAssetGarbageResult, FileTrashRecogAssetsPayload, FileTrashRecogAssetsResult,
  // 0056（只增）：采集题 AI 整理（preview 对照 / commit 落库）
  QuestionAiCleanPayload, QuestionAiCleanResult,
  // 0012（只增）：内嵌 view bounds/事件推送/保存页 HTML payload
  CaptureSetBoundsPayload, CaptureEventPayload, CaptureSavePageHtmlResult,
  // 0023（只增）：ai.* 模型配置体系 payload
  AiProfileCreatePayload, AiProfileUpdatePayload, AiProfileIdPayload,
  AiProfileSetEnabledPayload, AiProfileListPayload, AiProfileTestConnectionPayload,
  AiInvokePayload, AiInvokeResult, AiTestConnectionResult,
  AiModelsListPayload, AiModelsListResult,
  // 0036（只增）：split.* 切题工作区 payload
  SplitProjectCreatePayload, SplitProjectSaveMetaPayload, SplitProjectSaveDraftPayload,
  SplitProjectSaveDraftResult, SplitProjectIdPayload, SplitProjectSummary, SplitProjectDetail,
  SplitSourceAppendPayload, SplitSourceAppendResult, SplitSourceReadPayload, SplitSourceReadResult,
  SplitPageWritePayload, SplitPageWriteResult, SplitPageReadPayload, SplitPageReadResult,
  // 0029（只增）：ai.suggest.* 挂树/打标建议 payload
  AiAnchorStatusPayload, AiAnchorStatusResult, AiSuggestPayload, AiSuggestResult,
  // 0040（只增）：工作台文件态 payload/状态 + 草稿挂树建议 payload
  RecogWorkbenchLoadPayload, RecogWorkbenchSavePayload, RecogWorkbenchSaveResult,
  WorkbenchState, AiSuggestTreeForDraftPayload,
  // 0044（只增）：paper.folder.*/回收站/移卷 payload + 存为试卷 payload/结果
  PaperFolderCreatePayload, PaperFolderRenamePayload, PaperFolderIdPayload,
  PaperMoveToFolderPayload, PaperIdActionPayload,
  RecogSaveAsPaperPayload, RecogSaveAsPaperResult,
  // 0071（只增）：数据保存位置查询/更改/撤销（类型单源，本文件不另立一套）
  DataLocationInfo, DataLocationChangePayload, DataLocationChangeResult, DataLocationCancelResult,
  // 0072（只增）：公告与版本更新（类型单源 distribution-types.ts，经 ipc-channels 再导出）
  AnnounceSnapshot, UpdateStatus, UpdateCheckNowResult, UpdateOpenExternalResult,
} from './ipc-channels.js';
// 0023（只增）：模型档案对外形态（不含 key_encrypted，D-043）
import type { ModelProfile } from './ai-types.js';
// 0028（只增）：识别 run 任务化 payload / 对外形态（类型单源在 recog-run-types.ts）
import type {
  RecogDraftWritePayload, RecogDraftWriteResult, RecogEventPayload, RecogRun,
  RecogRunAttachQuestionsPayload, RecogRunCreatePayload,
  RecogRunCreateResult, RecogRunDetail, RecogRunHistoryPayload, RecogRunIdPayload,
} from './recog-run-types.js';

export interface MofangBridge {
  // Question operations
  createQuestion(payload: { data: Omit<Question, 'id' | 'createdAt' | 'updatedAt'> }): Promise<Question>;
  getQuestion(payload: { id: string }): Promise<Question | null>;
  listQuestions(payload: { filter?: { subject?: string; tag?: string; keyword?: string } }): Promise<Question[]>;
  updateQuestion(payload: { id: string; data: Partial<Omit<Question, 'id' | 'createdAt'>> }): Promise<Question>;
  // D1-fix-4 复验（只增）：题目软删
  deleteQuestion(payload: { id: string }): Promise<void>;
  addTag(payload: { questionId: string; tag: string; color?: string }): Promise<void>;
  removeTag(payload: { questionId: string; tag: string }): Promise<void>;
  // 0056（只增）：采集题 AI 整理（R-041）——preview 产出逐题整理前后对照（零写库），
  // commit 落库弹层确认后的改写（主进程逐题 update + operation_log 台账）
  questionAiClean(payload: QuestionAiCleanPayload): Promise<QuestionAiCleanResult>;

  // Paper operations
  createPaper(payload: { title: string; config?: Record<string, unknown> }): Promise<Paper>;
  getPaper(payload: { id: string }): Promise<Paper | null>;
  listPapers(): Promise<PaperSummary[]>;
  /**
   * 0004-fix-5 P1-2（只增）：payload 增可选 textBlock —— 文本内容块（kind='text' 行）经本通道落库。
   * 此前 renderer 侧 IpcBankClient 只透传 3 参，textBlock 在真机路径被丢弃（「插入大标题无效果」根因）。
   * layout 为 BankService.addQuestion 的第 4 参（clone 内部随行拷贝用），桥侧透传但不经 IPC 消费。
   * 0004-fix-6 P1-1（只增）：textBlock 扩 align。
   */
  addQuestion(payload: {
    paperId: string;
    questionId: string;
    score?: number;
    layout?: PaperQuestionRef['layout'];
    textBlock?: { text: string; style?: 'section' | 'note'; align?: 'left' | 'center' | 'right' };
  }): Promise<void>;
  removeQuestion(payload: { paperId: string; questionId: string }): Promise<void>;
  reorderQuestions(payload: { paperId: string; questionIds: string[] }): Promise<void>;
  getPaperQuestions(payload: { paperId: string }): Promise<PaperQuestionRef[]>;
  /** 0018 目检返工三：score = undefined 表示清除分值，回未设置 */
  setQuestionScore(payload: { paperId: string; questionId: string; score: number | undefined }): Promise<void>;

  // PDF export
  // 0004（乙路 Phase 4 只增）：payload 增可选 pageSize（A3/A4 出纸；缺省 A4 语义不变）
  // 0004-fix-2 F2-A（只增）：payload 增可选 landscape（横版出纸；按 layoutConfig.orientation 传参）
  // 0007 P2（只增，拍板①②）：payload 增可选 paginate（导出隐藏窗跑与预览同一套测量+装箱，
  // 写回分页 sheet DOM 再 printToPDF——预览=PDF 同构）；返回值只增 pagination（页数/溢出统计）。
  exportPdf(payload: ExportPdfPayload): Promise<ExportPdfResult>;

  // 0035（只增）：Word(DOCX) 导出——结构化数据（Question[] + 版式）直接组装，不走 HTML→DOM；
  // 公式=图片（D-051）。保存对话框在主进程；filePath=null 表示用户取消。
  exportDocx(payload: ExportDocxPayload): Promise<ExportDocxResult>;
}

/** 0007 P2（只增，拍板①）：导出页化入参——页物理尺寸（取向换算后）+ 栏数/列间距 */
export interface ExportPdfPaginateConfig {
  pageWmm: number;
  pageHmm: number;
  columns?: 1 | 2;
  columnGapMm?: number;
}

export interface ExportPdfPayload {
  html: string;
  suggestedName: string;
  pageSize?: 'A3' | 'A4';
  landscape?: boolean;
  /** 页化导出参数（sheet 写回 + 页码内容化）。0007 P5 起旧 footerTemplate 路径已删除，IPC 运行期必填（缺即拒）；契约层仍标可选（只增不改），调用方一律传 */
  paginate?: ExportPdfPaginateConfig;
}

export interface ExportPdfResult {
  filePath: string | null;
  /** 只增可选：页化导出时的装箱统计（对拍探针/诚实 UI 用） */
  pagination?: { sheets: number; overflow: number };
}

/**
 * 0035（只增）：Word(DOCX) 导出入参——结构化卷面数据（主进程自建计划，**不接受预渲染 HTML**；
 * 路线定案：不做 HTML→DOM 序列化）。公式=图片（D-051）：span.math[data-tex] 经 KaTeX 栅格为 PNG。
 */
export interface ExportDocxPayload {
  paper: Paper;
  questions: Question[];
  mode: 'student' | 'teacher';
  suggestedName: string;
  /** 版式配置（缺省 → 回落 paper.layoutConfig，再缺省 = 引擎全默认） */
  layoutConfig?: PaperLayoutConfig;
  /** 题级覆盖（图排版/作答区/选项版式；与渲染引擎 questionLayouts 同构） */
  questionLayouts?: Record<string, {
    figures?: QuestionFigureLayout[];
    answerSpace?: QuestionAnswerSpaceOverride;
    optionsLayout?: OptionsLayoutMode;
  }>;
  /** 文本内容块（key=行 id；渲染为节标题/备注，不占题号） */
  textBlocks?: Record<string, PaperTextBlock>;
  /** 题分值（按题目行序；undefined=未设置分值，不渲染题头分值） */
  scores?: (number | undefined)[];
}

/** 0035（只增）：导出统计——缺口如实回传（公式栅格失败/缺图/清单外标签降级），UI 不假装完美 */
export interface ExportDocxStats {
  mathTotal: number;
  mathRasterized: number;
  mathFailed: number;
  imagesTotal: number;
  imagesEmbedded: number;
  imagesMissing: number;
  /** 清单外标签降级汇总（tag → 次数） */
  degradations: Array<{ tag: string; count: number }>;
  /** 组装期资源问题明细 */
  issues: string[];
}

export interface ExportDocxResult {
  filePath: string | null;
  stats: ExportDocxStats;
}

export interface MofangCaptureBridge {
  // Capture window operations
  openWindow(): Promise<void>;
  closeWindow(): Promise<void>;
  navigate(payload: { url: string }): Promise<void>;
  getState(): Promise<CaptureWindowState>;
  extractBasket(): Promise<{ extracted: CaptureExtraction }>;
  // D1-fix-3 L-1（只增）：payload 增可选 subject（用户选择学科，学段+学科组合串）
  collect(payload: { extracted: CaptureExtraction; subject?: string }): Promise<{ ok: number; dup: number; failed: Array<{ questionId: string; error: string }> }>;
  // D1-fix-3 L-2（只增）：控件条提取后主窗拉取最近一次提取结果
  getLastExtraction(): Promise<{ extracted: CaptureExtraction | null }>;
  /**
   * 0006 P4（只增）：整卷下载预览——粘贴组卷整卷 URL（zujuan.xkw.com/{bankId}p{paperId}.html）
   * → PC SSR 全量题号 + 移动批量 API 全字段（题干/答案解析/题型/难度/知识点标签）。
   * 只读抓取，不占试题篮、不自动登录。
   */
  paperPreview(payload: { url: string }): Promise<PaperPreview>;
  /**
   * 0006 P4（只增）：整卷导入（预览勾选 + 去向二选一）。
   * target='paper'：新建成品卷（createPaperEx → 挂题 → 快照 → done）；
   * target='bank'：散题入题库（复用 ingest 去重/回填语义）。
   */
  paperImport(payload: { url: string; questionIds: string[]; target: PaperImportTarget }): Promise<PaperImportResult>;
  // ==================== 0012（只增）：内嵌 WebContentsView 形态 ====================
  /** 渲染层上报内嵌 view bounds（视口坐标；零宽高=遮挡/隐藏编排，P0 探针定稿） */
  setBounds(payload: CaptureSetBoundsPayload): Promise<void>;
  /** 订阅采集状态事件推送（CAPTURE_EVENT）；返回退订函数。mock 侧 no-op 订阅（语义等价） */
  onEvent(callback: (payload: CaptureEventPayload) => void): () => void;
  /** 保存当前页 HTML（取证；原 toolbar-preload「保存HTML」能力迁主进程通道） */
  savePageHtml(): Promise<CaptureSavePageHtmlResult>;
}

// D1 Phase 0 授权增补（只增）：renderer 解析 data-assets/ 前缀所需的资产磁盘根（只读常量，无方法）
export interface MofangPaths {
  /** userData/data/assets 磁盘根目录（主进程经 additionalArguments 单点注入，preload 只读转发） */
  readonly userDataAssets: string;
}

// E1（只增）：数据备份与恢复
export interface MofangGuardBridge {
  createBackup(): Promise<{ success: boolean; backupPath?: string; manifest?: { backup_id: string; created_at: string; counts: { questions: number; papers: number; assets: number } }; error?: string }>;
  restoreBackup(payload: { confirmed: boolean }): Promise<{ success: boolean; restored?: { questions: number; papers: number; assets: number }; error?: string; needsConfirmation?: boolean }>;
  getStats(): Promise<{ questions: number; papers: number; assets: number }>;
  /** 0037（只增）：首页沉淀统计聚合（含 AI 用量，读 operation_log 留痕；零新表） */
  getDashboard(): Promise<HomeDashboardStats>;
}

// 0066（只增）：可运维性一期——诊断包导出（R-002；包内硬排除清单见 src/shell/diag；
// 返回形态与 ipc-channels.ts 的 DiagExportResult 同构，此处按 guard 桥先例内联）
export interface MofangDiagBridge {
  exportDiagnostics(): Promise<{ success: boolean; path?: string; canceled?: boolean; error?: string }>;
}

// 0071（只增）：自定义数据保存位置（R-043）——查询当前位置 / 选新位置（重启后迁移）/ 撤销待迁移；
// 类型单源 ipc-channels.ts（DataLocationInfo / …ChangePayload / …Result），本处只做白名单桥声明。
export interface MofangDataLocationBridge {
  get(): Promise<DataLocationInfo>;
  /** targetDir 缺省 = 主进程弹系统目录选择框（正常 UI 路径） */
  change(payload?: DataLocationChangePayload): Promise<DataLocationChangeResult>;
  cancel(): Promise<DataLocationCancelResult>;
}

// 0072（只增）：公告栏（R-073 发布批 lane A）——读当前生效公告（含来源标记）/ 手动刷新（设置页同用）。
export interface MofangAnnounceBridge {
  get(): Promise<AnnounceSnapshot>;
  refresh(): Promise<AnnounceSnapshot>;
}

// 0072（只增）：版本更新通道（electron-updater generic；主进程 isPackaged 才接线真 handler，
// dev 态接线降级 handler 恒 not-available（目检返工②）；自动化态 invoke 会拒绝——UI 按「无桥」同口径不渲染更新区）。
// onStatus 为订阅型通道（recog.onEvent 同范式：ipcRenderer.on 包装，退订函数随返回值给出）。
export interface MofangUpdateBridge {
  getStatus(): Promise<UpdateStatus>;
  /** 手动检查更新（忽略 24h 节流；started=false = 已有检查/下载在进行） */
  checkNow(): Promise<UpdateCheckNowResult>;
  /** 打开更新/公告相关外链（主进程 shell.openExternal，仅放行 http(s)——downloadUrl/条目 links 同出口） */
  openExternal(url: string): Promise<UpdateOpenExternalResult>;
  /** downloaded 后「立即重启」：NSIS 覆盖安装（userData 保留；便携版主进程侧拦截不装） */
  quitAndInstall(): Promise<void>;
  onStatus(callback: (status: UpdateStatus) => void): () => void;
}

/**
 * 0003（只增）：bank 扩展服务 renderer 桥 — preload 经 `__mofangBankExt` 白名单暴露。
 * 命名空间与 ipc-channels.ts 0002 通道一一对应，仅含 0003 接线子集（student/class/exam/mistake
 * 全量 + dict/paper_set 查询子集）；fix-2（只增）补 paperSet.addPaper 与 paper.updatePaperStatus
 * （考试关联已定稿卷）；0004（只增）补 paper 试题篮 6 通道 + tree 查询 4；
 * 0004 Phase 5（只增）补 paper.setLayoutConfig/setQuestionLayouts + preset 5 通道。
 * 既有 MofangBridge/MofangCaptureBridge/MofangPaths/MofangGuardBridge 字段零改动（0002 冻结 spirit）。
 */
export interface MofangBankExtBridge {
  dict: {
    list(payload: DictListPayload): Promise<DictEntry[]>;
    get(payload: DictIdPayload): Promise<DictEntry | null>;
    // 0016（只增补线）：U12 未知值指认 = updateEntry（code 指向守卫在 service 层；create 仍未接）
    update(payload: DictUpdatePayload): Promise<DictEntry>;
    // 0025（只增补线）：DICT_CREATE 接线（重名守卫在 service 层；归一/站点行语义同 createEntry）
    create(payload: DictCreatePayload): Promise<DictEntry>;
  };
  student: {
    create(payload: StudentCreatePayload): Promise<Student>;
    get(payload: StudentIdPayload): Promise<Student | null>;
    list(payload: StudentListPayload): Promise<Student[]>;
    update(payload: StudentUpdatePayload): Promise<Student>;
    setStatus(payload: StudentSetStatusPayload): Promise<Student>;
    enroll(payload: StudentEnrollPayload): Promise<StudentClassPeriod>;
    endEnrollment(payload: StudentEndEnrollmentPayload): Promise<void>;
    getClasses(payload: StudentIdPayload): Promise<Array<StudentClassPeriod & { className?: string }>>;
    addEvent(payload: StudentEventAddPayload): Promise<StudentEvent>;
    listEvents(payload: StudentEventListPayload): Promise<StudentEvent[]>;
  };
  class: {
    create(payload: ClassCreatePayload): Promise<ClassInfo>;
    get(payload: ClassIdPayload): Promise<ClassInfo | null>;
    list(payload: ClassListPayload): Promise<ClassInfo[]>;
    update(payload: ClassUpdatePayload): Promise<ClassInfo>;
  };
  exam: {
    create(payload: ExamCreatePayload): Promise<Exam>;
    get(payload: ExamIdPayload): Promise<Exam | null>;
    list(payload: ExamListPayload): Promise<Exam[]>;
    recordScores(payload: ExamRecordScoresPayload): Promise<number>;
    getScores(payload: ExamScoresPayload): Promise<ExamScore[]>;
    getStudentScores(payload: ExamStudentScoresPayload): Promise<Array<ExamScore & { examTitle?: string }>>;
    recordResults(payload: ExamRecordResultsPayload): Promise<ExamRecordSummary>;
  };
  mistake: {
    recordWrong(payload: MistakeRecordWrongPayload): Promise<MistakeRecordWrongResult>;
    get(payload: MistakeIdPayload): Promise<Mistake | null>;
    list(payload: MistakeListPayload): Promise<Mistake[]>;
    setStage(payload: MistakeSetStagePayload): Promise<Mistake>;
    cycleStage(payload: MistakeIdPayload): Promise<Mistake>;
    setNote(payload: MistakeSetNotePayload): Promise<void>;
    delete(payload: MistakeIdPayload): Promise<void>;
    // 0025（只增）：错题闭环数据层——聚合/批量删/批量改档/题 id 集导出
    aggregateByQuestion(payload: MistakeAggregatePayload): Promise<MistakeAggregateRow[]>;
    batchDelete(payload: MistakeBatchIdsPayload): Promise<MistakeBatchResult>;
    batchSetStage(payload: MistakeBatchSetStagePayload): Promise<MistakeBatchResult>;
    exportQuestionIds(payload: MistakeAggregatePayload): Promise<string[]>;
  };
  paperSet: {
    create(payload: PaperSetCreatePayload): Promise<PaperSet>;
    get(payload: PaperSetIdPayload): Promise<PaperSet | null>;
    list(payload: PaperSetListPayload): Promise<PaperSet[]>;
    // fix-2（只增）：考试关联已定稿卷时挂卷入集合
    addPaper(payload: PaperSetAddPaperPayload): Promise<void>;
    // 0025（只增补线）：removePaper/delete 写入接线（U7/B11：删集合不伤卷）
    removePaper(payload: PaperSetRemovePaperPayload): Promise<void>;
    getPapers(payload: PaperSetGetPapersPayload): Promise<PaperSetPaperRef[]>;
    getStudentPaper(payload: PaperSetStudentPaperPayload): Promise<PaperSetPaperRef | null>;
    delete(payload: PaperSetIdPayload): Promise<void>;
  };
  // fix-2（只增）：paper 状态机接线子集；0004（只增）补试题篮 6 通道；
  // 0004 Phase 5（只增）补 setLayoutConfig（版式定稿）+ setQuestionLayouts（题级图覆盖）；
  // 0044（只增）补 folder 嵌套 CRUD + moveToFolder + 回收站三动作（试卷管理页 #/papers 数据面）
  paper: {
    updatePaperStatus(payload: PaperUpdateStatusPayload): Promise<void>;
    setLayoutConfig(payload: PaperSetLayoutConfigPayload): Promise<void>;
    listPapersEx(payload: PaperListExPayload): Promise<PaperSummary[]>;
    getPaperEx(payload: PaperGetPayload): Promise<Paper | null>;
    snapshotPaperQuestions(payload: PaperSnapshotPayload): Promise<number>;
    listPaperSnapshotQuestions(payload: PaperSnapshotListPayload): Promise<Question[]>;
    clonePaperToBasket(payload: PaperCloneToBasketPayload): Promise<Paper>;
    updatePaperTitle(payload: PaperUpdateTitlePayload): Promise<Paper>;
    setQuestionLayouts(payload: PaperSetQuestionLayoutsPayload): Promise<void>;
    // 0044（只增）：文件夹嵌套 CRUD（全量平铺 list——渲染层建父子索引，D-063）
    folder: {
      list(): Promise<PaperFolder[]>;
      create(payload: PaperFolderCreatePayload): Promise<PaperFolder>;
      rename(payload: PaperFolderRenamePayload): Promise<PaperFolder>;
      delete(payload: PaperFolderIdPayload): Promise<void>;
    };
    /** 0044（只增）：移卷入夹（folderId=null=未分类；一卷一夹 D-060②） */
    moveToFolder(payload: PaperMoveToFolderPayload): Promise<void>;
    /** 0044（只增）：回收站三动作（trash 记 trashed_from / restore 还原 / deleteForever 仅 trashed 卷） */
    trash(payload: PaperIdActionPayload): Promise<void>;
    restore(payload: PaperIdActionPayload): Promise<void>;
    deleteForever(payload: PaperIdActionPayload): Promise<void>;
  };
  // 0004 Phase 5（只增）：版式预设 5 通道（内置=只读展示应用可改不可；守卫在服务层）
  preset: {
    create(payload: PresetCreatePayload): Promise<LayoutPreset>;
    get(payload: PresetIdPayload): Promise<LayoutPreset | null>;
    list(payload: PresetListPayload): Promise<LayoutPreset[]>;
    update(payload: PresetUpdatePayload): Promise<LayoutPreset>;
    delete(payload: PresetIdPayload): Promise<void>;
  };
  // 0004（只增）：tree 查询 4 通道（仅为知识树空态判定与未来数据就绪；数据未采集 UI 显示「待采集」）
  // 0025（只增补线）：写通道接线——挂树/建树/建节点/源节点解析（手工挂树 = 闭环第②步的数据前提）
  tree: {
    listTrees(payload: TreeListPayload): Promise<Tree[]>;
    getNodes(payload: TreeNodesPayload): Promise<TreeNode[]>;
    getDescendants(payload: TreeDescendantsPayload): Promise<Array<TreeNode & { depth: number }>>;
    getQuestionNodes(payload: TreeQuestionNodesPayload): Promise<TreeNode[]>;
    // 0016（只增补线）：站点映射只读查看（节点级查询；树级聚合在渲染层组合）
    getSourceMappings(payload: TreeSourceMappingsPayload): Promise<TreeSourceMapping[]>;
    // 0025（只增补线）：树写入 5 通道（重名守卫/幂等语义在 service 层）
    createTree(payload: TreeCreatePayload): Promise<Tree>;
    createNode(payload: TreeNodeCreatePayload): Promise<TreeNode>;
    linkQuestion(payload: TreeLinkPayload): Promise<void>;
    unlinkQuestion(payload: TreeLinkPayload): Promise<void>;
    resolveSourceNode(payload: TreeResolveSourcePayload): Promise<TreeNode | null>;
  };
  // 0005（只增）：课后反馈模板 4 通道（内置只读守卫在服务层；渲染纯函数/卡片 IO 不在服务面）
  feedback: {
    create(payload: FeedbackCreatePayload): Promise<FeedbackTemplate>;
    get(payload: FeedbackIdPayload): Promise<FeedbackTemplate | null>;
    list(payload: FeedbackListPayload): Promise<FeedbackTemplate[]>;
    update(payload: FeedbackUpdatePayload): Promise<FeedbackTemplate>;
    delete(payload: FeedbackIdPayload): Promise<void>;
  };
  /**
   * 0030（只增）：反馈记录落档（D-065 双模式——快速模式 student_id 置空仅留痕 / 批量关联学生与班级）。
   * 无「已发」状态：只有 create（保存记录）一个写动作，update 仅限正文/姓名订正。
   */
  feedbackRecord: {
    create(payload: FeedbackRecordCreatePayload): Promise<FeedbackRecord>;
    get(payload: FeedbackRecordIdPayload): Promise<FeedbackRecord | null>;
    /** classId / 学生姓名关键字筛选（均缺省=全量，创建时间倒序） */
    list(payload: FeedbackRecordListPayload): Promise<FeedbackRecord[]>;
    update(payload: FeedbackRecordUpdatePayload): Promise<FeedbackRecord>;
    delete(payload: FeedbackRecordIdPayload): Promise<void>;
  };
  /** 0030（只增）：AI 通道提示词模板（内置只读；自定义可改可删可另存） */
  feedbackPrompt: {
    create(payload: FeedbackPromptCreatePayload): Promise<FeedbackPromptTemplate>;
    get(payload: FeedbackPromptIdPayload): Promise<FeedbackPromptTemplate | null>;
    list(payload: FeedbackPromptListPayload): Promise<FeedbackPromptTemplate[]>;
    update(payload: FeedbackPromptUpdatePayload): Promise<FeedbackPromptTemplate>;
    delete(payload: FeedbackPromptIdPayload): Promise<void>;
  };
}

/**
 * 0004（只增）：file.* 白名单桥 — Logo 本地图片 + 剪贴板图片 + 预设导入导出的磁盘 IO。
 * dialog/剪贴板/文件读写只在 Electron 主进程；浏览器 demo 无 __mofangFile，UI 层降级（Phase 5）。
 */
export interface MofangFileBridge {
  /** 本地图片选择 → 复制进 data/assets/logos/；取消 → null */
  pickLogoImage(): Promise<FileImageAsset | null>;
  /**
   * 0057（只增）：录题裁图产物（PNG data URL）落 data/assets/recog/ → relPath（相对 data/assets）。
   * 题干按 `data-assets/<relPath>` 写入（与采集链同形态）；形验失败/写盘失败显式抛错，不静默产坏图。
   */
  saveRecogImage(payload: FileSaveRecogImagePayload): Promise<FileImageAsset>;
  /** 剪贴板图片落盘；剪贴板无图 → null */
  readClipboardImage(): Promise<FileImageAsset | null>;
  /** 预设 .json 文件读取文本（JSON 结构校验在 UI 层）；取消 → null */
  importPresetFile(): Promise<FileImportPresetResult | null>;
  /** 预设文件导出（保存对话框 + 写文本）；取消 → { filePath: null } */
  exportPresetFile(payload: FileExportPresetPayload): Promise<{ filePath: string | null }>;
  /** 0005（只增）：文本文件导出（保存对话框 + 写文本；反馈 txt 用）；取消 → { filePath: null } */
  exportTextFile(payload: FileExportTextPayload): Promise<{ filePath: string | null }>;
  /**
   * 0030（只增）：文本文件导入（提示词模板 pack 分享形态；对话框选 .txt/.md）；取消 → null。
   * 解析（头部 name + 正文）在 UI 层（纯函数），主进程只负责选文件与读文本。
   */
  importTextFile(): Promise<FileImportTextResult | null>;
  /**
   * 0061（只增）：扫描 recog 图资产孤儿（设置页「存储清理」预览步；只读库 + 只读目录，零写盘）。
   * 引用判定面=题目三字段/images 列/卷内 layout_json/试卷快照/录题草稿/错题快照；每次全量重扫。
   */
  scanRecogAssetGarbage(): Promise<FileScanRecogAssetGarbageResult>;
  /**
   * 0061（只增）：把孤儿资产移入 `data/assets/_trash/<日期>/recog/`（可撤销回收；主进程形验 + 执行前重扫）。
   * 被引用者/已恢复引用者一律跳过；单文件失败（占用）跳过不整批失败。
   */
  trashRecogAssets(payload: FileTrashRecogAssetsPayload): Promise<FileTrashRecogAssetsResult>;
  /**
   * 0005（只增）：卡片图片批量导出（通道名 feedback.exportCards；选目录 → 逐卡临时 html →
   * capturePage → PNG 落盘；卡片 html 内 data-assets 相对引用由主进程改写 file:// 绝对路径）
   */
  exportCards(payload: FeedbackExportCardsPayload): Promise<FeedbackExportCardsResult>;
}

/**
 * 0023（只增）：ai.* 白名单桥 — 模型配置体系（五角色档案 + Key 托管 + invoke 代理）。
 * Key 红线（D-043）：renderer 只见 hasKey 布尔与掩码，keyEncrypted/明文永不出主进程；
 * 明文 apiKey 仅在 create/update payload 中跨 IPC 一次（主进程加密即弃）。
 * 浏览器 demo 无 __mofangAi，UI 层回落 mock（AiServiceFactory）。
 */
export interface MofangAiBridge {
  profile: {
    list(payload?: AiProfileListPayload): Promise<ModelProfile[]>;
    create(payload: AiProfileCreatePayload): Promise<ModelProfile>;
    update(payload: AiProfileUpdatePayload): Promise<ModelProfile>;
    delete(payload: AiProfileIdPayload): Promise<void>;
    setEnabled(payload: AiProfileSetEnabledPayload): Promise<ModelProfile>;
    /** 文本角色发短请求；视觉角色必发随包小图（build/ai-test-image.png） */
    testConnection(payload: AiProfileTestConnectionPayload): Promise<AiTestConnectionResult>;
  };
  /** 通用代理：按 role 解析启用档案（缺档案/协议未实现 → IPC 拒绝；网络/HTTP 失败 → 结果形态） */
  invoke(payload: AiInvokePayload): Promise<AiInvokeResult>;
  /** 0023 目检返工 R3（只增）：获取模型列表（编辑态传 profileId；新建态直传 baseUrl+apiKey） */
  models: {
    list(payload: AiModelsListPayload): Promise<AiModelsListResult>;
  };
  /**
   * 0029（只增）：AI 挂树/打标建议（D-050：≤4 层单次注入 + NONE 协议 + 必人确认）。
   * 纯读面：锚点状态回执（空锚点禁放行预检）+ 建议产出（0024 后置校验后按题归属）；
   * 确认写入一律回走既有通道（挂树 ext.tree.linkQuestion / 打标 bank.addTag）——P-07 无直写面。
   */
  suggest: {
    /** 空锚点/注入口径预检（不做任何 AI 调用）；UI 据此禁放行并引导先采集 */
    anchorStatus(payload: AiAnchorStatusPayload): Promise<AiAnchorStatusResult>;
    /** 挂树建议（reasoning 角色，单次注入一次出建议；清单外一律拦截不静默） */
    treeLink(payload: AiSuggestPayload): Promise<AiSuggestResult>;
    /** 打标建议（同链 reasoning；新标签「待治理」徽标由 UI 侧既有通道探测展示） */
    tags(payload: AiSuggestPayload): Promise<AiSuggestResult>;
    /**
     * 0040（只增）：对**尚未入库**的工作台草稿直跑 0024 锚点链（≤4 层注入 + NONE + 后置校验）。
     * 与 treeLink 同链同口径，仅题面来源换成草稿文本；仍是纯读面（P-07 只建议、必人确认）。
     */
    treeForDraft(payload: AiSuggestTreeForDraftPayload): Promise<AiSuggestResult>;
  };
}

/**
 * 0028（只增）：recog.* 白名单桥 — 识别 run 任务化（素材收件 + 编排 + 进度事件 + 状态回读）。
 * T-07 混合持久化：页图/OCR 原文/草稿只在主进程磁盘，过桥的只有 base64 素材上行与状态/草稿下行；
 * Key 红线（D-043）：识别经 ai.invoke（vision 角色）走网关，桥面不出现任何 Key 字段。
 * 浏览器 demo 无 __mofangRecog，UI 层回落 mock（RecogServiceFactory）。
 */
export interface MofangRecogBridge {
  /** 素材（base64）→ run：立即返回 runId，识别在后台跑（进度看 onEvent） */
  create(payload: RecogRunCreatePayload): Promise<RecogRunCreateResult>;
  /** 状态回读（关页回来恢复现场；事件为主，此口为幂等真相源） */
  status(payload: RecogRunIdPayload): Promise<RecogRunDetail>;
  /** 取消（在飞页跑完即止，不开新页；状态落 cancelled） */
  cancel(payload: RecogRunIdPayload): Promise<RecogRun>;
  /** 历史（倒序；limit 缺省全部） */
  history(payload?: RecogRunHistoryPayload): Promise<RecogRun[]>;
  /** 入库成功后回写结果题目 id 集（去重并集） */
  attachQuestions(payload: RecogRunAttachQuestionsPayload): Promise<RecogRun>;
  /** 断点续跑：error/cancelled 的 run 重跑，已完成页由 checkpoint 跳过 */
  resume(payload: RecogRunIdPayload): Promise<RecogRun>;
  /** 订阅识别进度事件（RECOG_EVENT）；返回退订函数 */
  onEvent(callback: (payload: RecogEventPayload) => void): () => void;
  /**
   * 0040（只增）：工作台卡流文件态（run 目录 workbench.json）读/写。
   * 读：无文件 = 首次进入该 run 的工作台 → null；写：渲染层防抖后调用（原子替换）。
   */
  workbench: {
    load(payload: RecogWorkbenchLoadPayload): Promise<WorkbenchState | null>;
    save(payload: RecogWorkbenchSavePayload): Promise<RecogWorkbenchSaveResult>;
  };
  /**
   * 0044（只增）：「存为试卷」主进程一步编排（R-036/D-058）——逐题入库（沿用题卡已采纳
   * 挂树/标签）→ 建卷（composing + folder_id）→ 保序挂题 → run 回写。
   * 失败口径：题保留、卷不建（建卷+挂题单事务，半态卷不出现），报错明示失败步骤。
   */
  saveAsPaper(payload: RecogSaveAsPaperPayload): Promise<RecogSaveAsPaperResult>;
  /**
   * 0046（只增）：Onestep 草稿写回 run（recog.draft.write；P6.3 换档落地，D-064）。
   * 转换与落盘在主进程，写回后 run 状态落 done；#/proof/<runId> 经 status 读出。
   */
  draftWrite(payload: RecogDraftWritePayload): Promise<RecogDraftWriteResult>;
}

/**
 * 0036（只增）：split.* 白名单桥 — PDF 切题工作区（D-051 / R-027）。
 * 工作区文件态（项目元/切段/框/草稿/页图缓存）只落主进程磁盘，过桥的只有小载荷；
 * 源 PDF **分块** append/read（默认 4MB/块），整本教辅不进单条 IPC 消息。
 * 浏览器 demo 无 __mofangSplit，UI 层回落 mock（SplitServiceFactory）。
 */
export interface MofangSplitBridge {
  /** 建项目（只带元信息；PDF 字节走 appendSource 分块上传） */
  createProject(payload: SplitProjectCreatePayload): Promise<SplitProjectSummary>;
  /** 分块追加源 PDF（offset 必须等于当前已收字节数，错位拒绝） */
  appendSource(payload: SplitSourceAppendPayload): Promise<SplitSourceAppendResult>;
  /** 分块读源 PDF（渲染层栅格化拼装用） */
  readSource(payload: SplitSourceReadPayload): Promise<SplitSourceReadResult>;
  /** 保存项目元（页数 + 切段；顺带校验 source.pdf 副本字节数一致） */
  saveMeta(payload: SplitProjectSaveMetaPayload): Promise<SplitProjectSummary>;
  /** 保存草稿（渲染层 1.5s 防抖后调用） */
  saveDraft(payload: SplitProjectSaveDraftPayload): Promise<SplitProjectSaveDraftResult>;
  /** 项目列表（最近更新在前） */
  listProjects(): Promise<SplitProjectSummary[]>;
  /** 打开项目（元 + 草稿一次给全；关页回来即恢复现场） */
  openProject(payload: SplitProjectIdPayload): Promise<SplitProjectDetail>;
  /** 删除项目（连同工作区目录；调用方必须先经用户确认） */
  removeProject(payload: SplitProjectIdPayload): Promise<void>;
  /** 页图缓存写入（pdfjs 栅格化产物） */
  writePage(payload: SplitPageWritePayload): Promise<SplitPageWriteResult>;
  /** 页图缓存读取；未缓存 dataBase64: null（渲染层回落重新栅格化） */
  readPage(payload: SplitPageReadPayload): Promise<SplitPageReadResult>;
}

declare global {
  interface Window {
    __mofangBank?: MofangBridge;
    __mofangCapture?: MofangCaptureBridge;
    __mofangPaths?: MofangPaths;
    __mofangGuard?: MofangGuardBridge;
    // 0003（只增）：bank 扩展桥
    __mofangBankExt?: MofangBankExtBridge;
    // 0004（只增）：file 白名单桥（Logo/剪贴板/预设导入导出）
    __mofangFile?: MofangFileBridge;
    // 0023（只增）：ai 白名单桥（模型配置）
    __mofangAi?: MofangAiBridge;
    // 0028（只增）：recog 白名单桥（识别 run）
    __mofangRecog?: MofangRecogBridge;
    // 0036（只增）：split 白名单桥（PDF 切题工作区）
    __mofangSplit?: MofangSplitBridge;
    // 0066（只增）：diag 白名单桥（诊断包导出）
    __mofangDiag?: MofangDiagBridge;
    // 0071（只增）：dataLocation 白名单桥（自定义数据保存位置）
    __mofangDataLocation?: MofangDataLocationBridge;
    // 0072（只增）：公告与版本更新白名单桥（R-073 发布批 lane A）
    __mofangAnnounce?: MofangAnnounceBridge;
    __mofangUpdate?: MofangUpdateBridge;
  }
}
