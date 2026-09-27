// Phase 1: IPC 通道名常量与 payload 类型（定义，不接线）

import type { Question, Paper, QuestionFilter, PaperSummary } from './bank-types.js';
import type {
  DictEntry, DictEntryInput, DictKind, DictService,
  Tree, TreeType, TreeNode, TreeSourceMapping, TreeService,
  Student, StudentStatus, StudentEvent, StudentEventType, StudentEventPayload, StudentClassPeriod, StudentService,
  ClassInfo, ClassStatus, ClassService,
  Exam, ExamScore, ScoreEntry, ExamResultEntry, ExamRecordSummary, ExamService,
  Mistake, MistakeStage, MistakeService,
  /** 0025（只增）：错题聚合/批量结果类型（聚合与导出口的返回面） */
  MistakeAggregateFilter, MistakeAggregateRow, MistakeBatchResult,
  PaperSet, PaperType, PaperSetPaperRef, PaperSetService,
  LayoutPreset, PresetService,
  PaperStatus, PaperLayoutConfig, PaperExtService,
  /** 0044（只增）：试卷文件夹（paper_folders 行形态） */
  PaperFolder,
  /** 0004 Phase 5（只增）：题级图排版覆盖结构 */
  QuestionFigureLayout,
  /** 0004-fix-3（只增）：题级作答区覆盖结构 */
  QuestionAnswerSpaceOverride,
  /** 0005（只增）：课后反馈模板 */
  FeedbackTemplateInput,
  /** 0030（只增）：反馈记录 + AI 通道提示词模板（落档与提示词管理） */
  FeedbackRecordInput, FeedbackRecordPatch, FeedbackRecordQuery, FeedbackPromptTemplateInput,
  /** 0057（只增）：结构化图片元素类型（录题图资产化后入库 images 的条目形态） */
  QuestionImage,
} from './bank-types.js';
import type { CaptureExtraction, CaptureWindowState, CapturedQuestion } from './capture-types.js';
// 0006 P4（只增）：整卷下载预览/导入类型
import type { PaperPreview, PaperImportResult, PaperImportTarget } from './capture-types.js';
// 0023（只增）：ai.* 模型配置体系 payload（类型单源在 ai-types.ts——0023 独占契约文件）
import type {
  AiProfileCreatePayload, AiProfileUpdatePayload, AiProfileIdPayload,
  AiProfileSetEnabledPayload, AiProfileListPayload, AiProfileTestConnectionPayload,
  AiInvokePayload, AiInvokeResult, AiTestConnectionResult, ModelProfile,
  AiModelsListPayload, AiModelsListResult,
} from './ai-types.js';
// 0028（只增）：recog.run.* 识别 run 任务化 payload（类型单源在 recog-run-types.ts——0028 独占契约文件）
import type {
  RecogRunCreatePayload, RecogRunCreateResult, RecogRunDetail, RecogRunHistoryPayload,
  RecogRunAttachQuestionsPayload, RecogRunIdPayload, RecogRun, RecogEventPayload,
} from './recog-run-types.js';
// 0036（只增）：split.* 切题工作区 payload（类型单源在 split-types.ts——0036 独占契约文件）
import type {
  SplitProjectCreatePayload, SplitProjectSaveMetaPayload, SplitProjectSaveDraftPayload,
  SplitProjectSaveDraftResult, SplitProjectIdPayload, SplitProjectSummary, SplitProjectDetail,
  SplitSourceAppendPayload, SplitSourceAppendResult, SplitSourceReadPayload, SplitSourceReadResult,
  SplitPageWritePayload, SplitPageWriteResult, SplitPageReadPayload, SplitPageReadResult,
  SplitBox, SplitBoxType, SplitSegment, SplitDraft, SplitSegmentDraft, SplitRunLink,
  SplitProjectMeta, RecogRunLinkStatus,
} from './split-types.js';
// 0040（只增）：录题工作台 v2 payload/状态（类型单源在 onestep-types.ts——0040 独占契约文件）
import type {
  RecogWorkbenchLoadPayload, RecogWorkbenchSavePayload, RecogWorkbenchSaveResult,
  WorkbenchState, WorkbenchCard, WorkbenchCardStatus, WorkbenchCardSource, WorkbenchMode,
  WorkbenchFrame, WorkbenchFigure, WorkbenchPage, WorkbenchRect, WorkbenchTreeSuggestion,
  OnestepDraft, OnestepFigure, OnestepFigureSource, OnestepOption, OnestepQuestionType,
  OnestepBBox, OnestepProvider, OnestepExtractInput, OnestepExtractImage, OnestepExtractContext,
  AiSuggestTreeForDraftPayload,
} from './onestep-types.js';
// 0029（只增）：ai.suggest.* 挂树/打标建议 payload（类型单源在 ai-suggest-types.ts——0029 独占契约文件）
import type {
  AiAnchorStatusPayload, AiAnchorStatusResult, AiSuggestPayload, AiSuggestResult,
} from './ai-suggest-types.js';
// 0072（只增）：announce.*/update.* 公告与版本更新 payload（类型单源在 distribution-types.ts——0072 独占契约文件）
import type {
  AnnounceSnapshot, UpdateStatus, UpdateCheckNowResult,
} from './distribution-types.js';

/**
 * IPC 通道名常量（命名空间形式）
 */
export const IPC_CHANNELS = {
  // Question operations
  QUESTION_CREATE: 'bank.question.create',
  QUESTION_GET: 'bank.question.get',
  QUESTION_LIST: 'bank.question.list',
  QUESTION_UPDATE: 'bank.question.update',
  // D1-fix-4 复验（只增）：题目软删
  QUESTION_DELETE: 'bank.question.delete',
  QUESTION_ADD_TAG: 'bank.question.addTag',
  QUESTION_REMOVE_TAG: 'bank.question.removeTag',

  // Paper operations
  PAPER_CREATE: 'bank.paper.create',
  PAPER_GET: 'bank.paper.get',
  PAPER_LIST: 'bank.paper.list',
  PAPER_ADD_QUESTION: 'bank.paper.addQuestion',
  PAPER_REMOVE_QUESTION: 'bank.paper.removeQuestion',
  PAPER_REORDER_QUESTIONS: 'bank.paper.reorderQuestions',
  PAPER_GET_QUESTIONS: 'bank.paper.getQuestions',
  PAPER_SET_SCORE: 'bank.paper.setScore',

  // Capture operations
  CAPTURE_OPEN_WINDOW: 'capture.openWindow',
  CAPTURE_CLOSE_WINDOW: 'capture.closeWindow',
  CAPTURE_NAVIGATE: 'capture.navigate',
  CAPTURE_GET_STATE: 'capture.getState',
  CAPTURE_EXTRACT_BASKET: 'capture.extractBasket',
  CAPTURE_COLLECT: 'capture.collect',
  // D1-fix-3 L-2（只增）：控件条「提取试题篮」后主窗拉取最近一次提取结果
  CAPTURE_GET_LAST_EXTRACTION: 'capture.getLastExtraction',
  // 0006 P4（只增）：组卷整卷下载（预览 + 去向二选一导入）
  CAPTURE_PAPER_PREVIEW: 'capture.paperPreview',
  CAPTURE_PAPER_IMPORT: 'capture.paperImport',
  // 0012（只增）：内嵌 WebContentsView bounds 上报（渲染层视口坐标；零宽高=遮挡/隐藏编排，P0 探针定稿）
  CAPTURE_SET_BOUNDS: 'capture.setBounds',
  // 0012（只增）：采集状态事件推送（主进程 → 渲染层；导航/title/登录态/P4 页面语境，替代 1s 轮询快路径，轮询保留兜底）
  CAPTURE_EVENT: 'capture.event',
  // 0012 P2（只增）：保存当前页 HTML（取证；原 toolbar-preload「保存HTML」能力迁主进程通道）
  CAPTURE_SAVE_PAGE_HTML: 'capture.savePageHtml',

  // E1（只增）：数据备份与恢复
  GUARD_CREATE_BACKUP: 'guard.createBackup',
  GUARD_RESTORE_BACKUP: 'guard.restoreBackup',
  GUARD_GET_STATS: 'guard.getStats',
  // 0037（只增）：首页沉淀统计聚合（含 AI 用量，读 operation_log 留痕；bank/dashboard-service）
  GUARD_GET_DASHBOARD: 'guard.getDashboard',

  // 0066（只增）：可运维性一期——设置页一键导出诊断包（R-002；包内硬排除清单见 shell/diag）
  DIAG_EXPORT_DIAGNOSTICS: 'diag.exportDiagnostics',

  // 0071（只增）：自定义数据保存位置（R-043）——查询当前位置 / 指定新的保存位置（重启后迁移）/ 撤销待迁移
  DATA_LOCATION_GET: 'dataLocation.get',
  DATA_LOCATION_CHANGE: 'dataLocation.change',
  DATA_LOCATION_CANCEL: 'dataLocation.cancel',

  // 0072（只增）：公告与版本更新（R-073 发布批 lane A）——公告读取/手动刷新；
  // 更新状态拉取（进设置页水合）/ 手动检查（忽略节流）/ 状态订阅（订阅型通道，recog.onEvent 同范式）/
  // 打开更新/公告相关外链（主进程 shell.openExternal，仅放行 http(s)）
  ANNOUNCE_GET: 'announce.get',
  ANNOUNCE_REFRESH: 'announce.refresh',
  UPDATE_GET_STATUS: 'update.getStatus',
  UPDATE_CHECK_NOW: 'update.checkNow',
  UPDATE_ON_STATUS: 'update.onStatus',
  UPDATE_OPEN_EXTERNAL: 'update.openExternal',
  UPDATE_QUIT_AND_INSTALL: 'update.quitAndInstall',

  // ==================================================================
  // 0002 新增命名空间（schema 草案 §5；定义先行，接线随 UI 里程碑——bridge.ts 本轮冻结）
  // ==================================================================

  // dict.* 字典
  DICT_LIST: 'dict.list',
  DICT_GET: 'dict.get',
  DICT_CREATE: 'dict.create',
  DICT_UPDATE: 'dict.update',

  // tree.* 知识组织树
  TREE_CREATE: 'tree.createTree',
  TREE_LIST: 'tree.listTrees',
  TREE_GET_NODES: 'tree.getNodes',
  TREE_GET_DESCENDANTS: 'tree.getDescendants',
  TREE_CREATE_NODE: 'tree.createNode',
  TREE_LINK_QUESTION: 'tree.linkQuestion',
  TREE_UNLINK_QUESTION: 'tree.unlinkQuestion',
  TREE_GET_QUESTION_NODES: 'tree.getQuestionNodes',
  TREE_RESOLVE_SOURCE_NODE: 'tree.resolveSourceNode',
  TREE_GET_SOURCE_MAPPINGS: 'tree.getSourceMappings',

  // student.* 学生档案/分班/时间线
  STUDENT_CREATE: 'student.create',
  STUDENT_GET: 'student.get',
  STUDENT_LIST: 'student.list',
  STUDENT_UPDATE: 'student.update',
  STUDENT_SET_STATUS: 'student.setStatus',
  STUDENT_ENROLL: 'student.enroll',
  STUDENT_END_ENROLLMENT: 'student.endEnrollment',
  STUDENT_GET_CLASSES: 'student.getClasses',
  STUDENT_ADD_EVENT: 'student.addEvent',
  STUDENT_LIST_EVENTS: 'student.listEvents',

  // class.* 班级
  CLASS_CREATE: 'class.create',
  CLASS_GET: 'class.get',
  CLASS_LIST: 'class.list',
  CLASS_UPDATE: 'class.update',

  // exam.* 考试/成绩（U14 独立 exam_scores）
  EXAM_CREATE: 'exam.create',
  EXAM_GET: 'exam.get',
  EXAM_LIST: 'exam.list',
  EXAM_RECORD_SCORES: 'exam.recordScores',
  EXAM_GET_SCORES: 'exam.getScores',
  EXAM_GET_STUDENT_SCORES: 'exam.getStudentScores',
  EXAM_RECORD_RESULTS: 'exam.recordResults',

  // mistake.* 错题本（红黄绿状态机）
  MISTAKE_RECORD_WRONG: 'mistake.recordWrong',
  MISTAKE_GET: 'mistake.get',
  MISTAKE_LIST: 'mistake.list',
  MISTAKE_SET_STAGE: 'mistake.setStage',
  MISTAKE_CYCLE_STAGE: 'mistake.cycleStage',
  MISTAKE_SET_NOTE: 'mistake.setNote',
  MISTAKE_DELETE: 'mistake.delete',
  // 0025（只增）：错题闭环数据层——聚合/批量/题 id 集导出（0026 错题本·班情消费）
  MISTAKE_AGGREGATE: 'mistake.aggregateByQuestion',
  MISTAKE_BATCH_DELETE: 'mistake.batchDelete',
  MISTAKE_BATCH_SET_STAGE: 'mistake.batchSetStage',
  MISTAKE_EXPORT_QUESTION_IDS: 'mistake.exportQuestionIds',

  // paper_set.* 试卷集合
  PAPER_SET_CREATE: 'paper_set.create',
  PAPER_SET_GET: 'paper_set.get',
  PAPER_SET_LIST: 'paper_set.list',
  PAPER_SET_ADD_PAPER: 'paper_set.addPaper',
  PAPER_SET_REMOVE_PAPER: 'paper_set.removePaper',
  PAPER_SET_GET_PAPERS: 'paper_set.getPapers',
  PAPER_SET_GET_STUDENT_PAPER: 'paper_set.getStudentPaper',
  PAPER_SET_DELETE: 'paper_set.delete',

  // preset.* 版式预设
  PRESET_CREATE: 'preset.create',
  PRESET_GET: 'preset.get',
  PRESET_LIST: 'preset.list',
  PRESET_UPDATE: 'preset.update',
  PRESET_DELETE: 'preset.delete',

  // 0005（只增）：feedback.* 课后反馈模板（照 preset 5 通道模式；4 通道）
  FEEDBACK_CREATE: 'feedback.createTemplate',
  FEEDBACK_GET: 'feedback.getTemplate',
  FEEDBACK_LIST: 'feedback.listTemplates',
  FEEDBACK_UPDATE: 'feedback.updateTemplate',
  FEEDBACK_DELETE: 'feedback.deleteTemplate',

  // 0030（只增）：feedback.records.* / feedback.promptTemplates.* —— 反馈模块一期数据面
  //（记录落档双模式：快速=student_id NULL 仅留痕 / 批量=关联学生与班级；提示词模板内置只读 +
  // 自定义可改可删。与 0005 的 feedback.*（离线模板）并存，互不改语义。）
  FEEDBACK_RECORD_CREATE: 'feedback.records.create',
  FEEDBACK_RECORD_GET: 'feedback.records.get',
  FEEDBACK_RECORD_LIST: 'feedback.records.list',
  FEEDBACK_RECORD_UPDATE: 'feedback.records.update',
  FEEDBACK_RECORD_DELETE: 'feedback.records.delete',
  FEEDBACK_PROMPT_CREATE: 'feedback.promptTemplates.create',
  FEEDBACK_PROMPT_GET: 'feedback.promptTemplates.get',
  FEEDBACK_PROMPT_LIST: 'feedback.promptTemplates.list',
  FEEDBACK_PROMPT_UPDATE: 'feedback.promptTemplates.update',
  FEEDBACK_PROMPT_DELETE: 'feedback.promptTemplates.delete',

  // bank.paper.* 扩展（状态机/版式定稿）
  PAPER_UPDATE_STATUS: 'bank.paper.setStatus',
  PAPER_SET_LAYOUT_CONFIG: 'bank.paper.setLayoutConfig',

  // 0004（只增）：试题篮/快照/克隆/重命名（走 PaperExtService 0004 扩展方法）
  BANK_PAPER_LIST_EX: 'bank.paper.listPapersEx',
  BANK_PAPER_GET_EX: 'bank.paper.getPaperEx',
  BANK_PAPER_SNAPSHOT: 'bank.paper.snapshotPaperQuestions',
  BANK_PAPER_SNAPSHOT_LIST: 'bank.paper.listPaperSnapshotQuestions',
  BANK_PAPER_CLONE_TO_BASKET: 'bank.paper.clonePaperToBasket',
  BANK_PAPER_UPDATE_TITLE: 'bank.paper.updatePaperTitle',
  // 0004 Phase 5（只增）：题级图排版覆盖写入（paper_questions.layout_json）
  BANK_PAPER_SET_QUESTION_LAYOUTS: 'bank.paper.setQuestionLayouts',

  // ==================================================================
  // 0044（只增）：paper.folder.* / paper.moveToFolder / paper.trash|restore|deleteForever——
  // 试卷管理页（#/papers）数据面（D-060~D-063：文件夹嵌套 + 一卷一夹 + 回收站）。
  // 回收站语义：trash=记 trashed_from 入回收站；restore=读 trashed_from 还原；deleteForever=仅
  // trashed 卷可彻底删除（paper_questions 级联清理，题目本体不动）。
  // ==================================================================
  PAPER_FOLDER_LIST: 'paper.folder.list',
  PAPER_FOLDER_CREATE: 'paper.folder.create',
  PAPER_FOLDER_RENAME: 'paper.folder.rename',
  PAPER_FOLDER_DELETE: 'paper.folder.delete',
  PAPER_MOVE_TO_FOLDER: 'paper.moveToFolder',
  PAPER_TRASH: 'paper.trash',
  PAPER_RESTORE: 'paper.restore',
  PAPER_DELETE_FOREVER: 'paper.deleteForever',

  // 0044（只增）：recog.saveAsPaper——录题台「存为试卷」主进程一步编排（R-036/D-058）：
  // 逐题入库（沿用题卡已采纳挂树/标签）→ 建卷（status='composing' + folder_id）→ 保序挂题 →
  // run 回写。失败口径：题保留、卷不建（建卷+挂题在单事务，半态卷不出现）。
  RECOG_SAVE_AS_PAPER: 'recog.saveAsPaper',

  // 0004（只增）：file.* 命名空间（Logo 本地文件 + 剪贴板图片 + 预设导入导出的磁盘 IO；
  // dialog/剪贴板/文件读写只在主进程，服务层无 file 概念、不经 SQLite）
  FILE_PICK_LOGO_IMAGE: 'file.pickLogoImage',
  FILE_READ_CLIPBOARD_IMAGE: 'file.readClipboardImage',
  FILE_IMPORT_PRESET_FILE: 'file.importPresetFile',
  FILE_EXPORT_PRESET_FILE: 'file.exportPresetFile',

  // 0057（只增）：录题图资产化——渲染层裁图产物（PNG data URL）落 data/assets/recog/，
  // 返回 relPath 供题干写成 `data-assets/recog/…` 相对引用（图片设置/预览交互/迁移三处解析的共同前提）。
  // 与 file.pickLogoImage 同域同型，区别只在落盘子目录与入参是 data URL 而非对话框选文件。
  FILE_SAVE_RECOG_IMAGE: 'file.saveRecogImage',

  // 0005（只增）：课后反馈输出 IO（主进程独占；exportCards=选目录→临时 html→capturePage→PNG 批量落盘）
  FILE_EXPORT_TEXT_FILE: 'file.exportTextFile',
  FEEDBACK_EXPORT_CARDS: 'feedback.exportCards',

  // 0030（只增）：提示词模板导入（prompt pack 分享形态）——读文本文件；导出复用 file.exportTextFile。
  // 不复用 file.importPresetFile：那条通道的对话框标题/筛选器写死为 JSON 版式预设。
  FILE_IMPORT_TEXT_FILE: 'file.importTextFile',

  // 0061（只增）：录题图资产废图清理（R-057 / D-072）——设置页手动「扫描废图 → 预览 → 移入回收目录」。
  // 扫描（引用判定）与移动都在主进程（渲染层无 fs 权）；执行前每次全量重扫（D-072⑤ 禁增量缓存）；
  // 移动目标= data/assets/_trash/<日期>/recog/（可撤销，D-072③）；只读库 + 只移动文件，零 UPDATE/DELETE。
  FILE_SCAN_RECOG_ASSET_GARBAGE: 'file.scanRecogAssetGarbage',
  FILE_TRASH_RECOG_ASSETS: 'file.trashRecogAssets',

  // 0035（只增）：doc.* 命名空间补齐——Word(DOCX) 导出（与既有 doc.exportPdf 同域。
  // 公式=图片定案 D-051：主进程 KaTeX 渲染 → 隐藏窗栅格 PNG → docx 组装 → 保存对话框）
  DOC_EXPORT_DOCX: 'doc.exportDocx',

  // ==================================================================
  // 0023（只增）：ai.* 命名空间——模型配置体系（五角色档案 + Key 托管 + invoke 代理）。
  // D-043：Key 明文只在创建/更新瞬间跨 IPC，密文永不回 renderer；list 返回无 key_encrypted。
  // ==================================================================
  AI_PROFILE_LIST: 'ai.profile.list',
  AI_PROFILE_CREATE: 'ai.profile.create',
  AI_PROFILE_UPDATE: 'ai.profile.update',
  AI_PROFILE_DELETE: 'ai.profile.delete',
  AI_PROFILE_SET_ENABLED: 'ai.profile.setEnabled',
  AI_PROFILE_TEST_CONNECTION: 'ai.profile.testConnection',
  AI_INVOKE: 'ai.invoke',
  // 0023 目检返工 R3（只增）：获取模型列表（OpenAI 兼容 GET {base_url}/models 主进程代理）
  AI_MODELS_LIST: 'ai.models.list',

  // ==================================================================
  // 0028（只增）：recog.* 命名空间——识别 run 任务化（素材收件 + 编排 + 进度事件 + 状态回读）。
  // T-07 混合持久化：大产物（页图/OCR 原文/草稿）只落主进程磁盘，过桥的只有状态与草稿；
  // T-08 进度推送照 CAPTURE_EVENT 范式（RECOG_EVENT + preload onEvent），renderer 不轮询。
  // 通道面除任务书点名的 create/status/cancel/history 外，另有两条由同任务书硬要求导出的写口：
  //   attachQuestions（迁移 0012 的「结果题目 id 集」需回写）、resume（「断点续跑」需触发）。
  // ==================================================================
  RECOG_RUN_CREATE: 'recog.run.create',
  RECOG_RUN_STATUS: 'recog.run.status',
  RECOG_RUN_CANCEL: 'recog.run.cancel',
  RECOG_RUN_HISTORY: 'recog.run.history',
  RECOG_RUN_ATTACH_QUESTIONS: 'recog.run.attachQuestions',
  RECOG_RUN_RESUME: 'recog.run.resume',
  // 0028（只增）：识别进度事件推送（主进程 → 渲染层）
  RECOG_EVENT: 'recog.event',

  // ==================================================================
  // 0036（只增）：split.* 命名空间——PDF 切题工作区（D-051 / R-027）。
  // 工作区固定 userData/data/splitting/<项目>/（规避 file.* 通用文件通道，二期再议）；
  // 文件态（项目元/切段/框/草稿/页图缓存）全在主进程磁盘，渲染层只见契约类型。
  // 大文件不过单条消息：源 PDF 走 append/read 分块（默认 4MB/块），不一次性 base64 过桥。
  // ==================================================================
  SPLIT_PROJECT_CREATE: 'split.project.create',
  SPLIT_PROJECT_SAVE_META: 'split.project.saveMeta',
  SPLIT_PROJECT_SAVE_DRAFT: 'split.project.saveDraft',
  SPLIT_PROJECT_LIST: 'split.project.list',
  SPLIT_PROJECT_OPEN: 'split.project.open',
  SPLIT_PROJECT_REMOVE: 'split.project.remove',
  SPLIT_SOURCE_APPEND: 'split.source.append',
  SPLIT_SOURCE_READ: 'split.source.read',
  SPLIT_PAGE_WRITE: 'split.page.write',
  SPLIT_PAGE_READ: 'split.page.read',

  // ==================================================================
  // 0029（只增）：ai.suggest.* 命名空间——AI 挂树/打标建议（D-050：≤4 层单次注入 + NONE + 必人确认）。
  // P-07：AI 只建议、必人确认——本命名空间是纯读面（锚点状态回执 + 建议产出），无任何直写库通道；
  // 确认写入一律回走既有通道（挂树 tree.linkQuestion / 打标 bank.question.addTag）。
  // 类型单源在 ai-suggest-types.ts（0029 独占契约文件，只增范畴）。
  // ==================================================================
  AI_ANCHOR_STATUS: 'ai.suggest.anchorStatus',
  AI_SUGGEST_TREE: 'ai.suggest.tree',
  AI_SUGGEST_TAGS: 'ai.suggest.tags',

  // ==================================================================
  // 0040（只增）：录题工作台 v2——工作台文件态两通道 + 草稿挂树建议一通道。
  // 类型单源在 onestep-types.ts（0040 独占契约文件，只增范畴）。
  //   RECOG_WORKBENCH_LOAD/SAVE：run 目录 workbench.json 的读/写（卡流状态：待识别卡/题卡/勾选/采纳态）；
  //   AI_SUGGEST_TREE_FOR_DRAFT：对尚未入库的工作台草稿直跑 0024 锚点链（≤4 层注入 + NONE + 后置校验，
  //     与 ai.suggest.tree 同链同口径，仅题面来源换成草稿文本）；仍是纯读面（P-07：AI 只建议、必人确认）。
  // ==================================================================
  RECOG_WORKBENCH_LOAD: 'recog.workbench.load',
  RECOG_WORKBENCH_SAVE: 'recog.workbench.save',
  AI_SUGGEST_TREE_FOR_DRAFT: 'ai.suggest.treeForDraft',

  // ==================================================================
  // 0046（只增）：P6.3 换档落地——Onestep 草稿写回 run（drafts.json）。
  // 写回后 run 状态同步落 done + warnings 回写（否则 run 永停 queued，历史 pill 失真）；
  // #/proof/<runId>（0036 呈现层）经既有 recog.run.status 读口读出草稿，呈现层零改动目标。
  // 类型单源在 recog-run-types.ts（RecogDraftWritePayload/Result）。
  // ==================================================================
  RECOG_DRAFT_WRITE: 'recog.draft.write',

  // ==================================================================
  // 0056（只增）：采集题 AI 整理（R-041）——「手动启用」的一轮整理：公式图/答案图转文字。
  // 编排全在主进程（读 data/assets 图字节 → 两段式 provider → 合回契约 HTML → 逐题 update + 台账）；
  // 渲染层只见 before/after 对照与成败口径。P-07/D-050 同口径：preview 纯读（零写库），
  // 人确认后 commit 才落库（AI 只整理、不擅自改写用户题库）。
  // payload/结果类型与通道同文件（本条通道自带面，不新增契约文件）。
  // ==================================================================
  QUESTION_AI_CLEAN: 'bank.question.aiClean',
} as const;

/**
 * IPC Payload 类型
 */
export interface QuestionCreatePayload {
  data: Omit<Question, 'id' | 'createdAt' | 'updatedAt'>;
}

export interface QuestionGetPayload {
  id: string;
}

export interface QuestionListPayload {
  filter?: QuestionFilter;
}

export interface QuestionUpdatePayload {
  id: string;
  data: Partial<Omit<Question, 'id' | 'createdAt'>>;
}

/** D1-fix-4 复验（只增）：题目软删 */
export interface QuestionDeletePayload {
  id: string;
}

export interface QuestionAddTagPayload {
  questionId: string;
  tag: string;
  color?: string;
}

export interface QuestionRemoveTagPayload {
  questionId: string;
  tag: string;
}

// ==================== 0056（只增）：采集题 AI 整理（R-041） ====================

/** 整理模式：preview = 只产出对照（零写库）；commit = 落库用户在对照弹层确认的改写 */
export const QUESTION_AI_CLEAN_MODES = ['preview', 'commit'] as const;
export type QuestionAiCleanMode = (typeof QUESTION_AI_CLEAN_MODES)[number];

/** 题面三字段 + images 列（对照弹层 before/after 的完整面） */
export interface QuestionAiCleanFields {
  content: string;
  answer: string;
  analysis: string;
  images: QuestionImage[];
}

/** commit 的逐题改写（= preview 产出的 after 原样回传，主进程校验形验后 update） */
export interface QuestionAiCleanItemPatch {
  questionId: string;
  content: string;
  answer: string;
  analysis: string;
  images: QuestionImage[];
}

/**
 * 0065（R-068，只增）：该字段本次的整理方式（弹层人读标签）。
 *   · `inline-figures`：字段里是「正文 + 混排图」→ 逐图**原位替换**为公式位，正文一字不动；
 *   · `replace-field`：字段就是一张整图 → **整字段替换**（引擎 answer/analysis 双出）。
 * 与 `src/recog/ai-clean/plan.ts` 的 `AiCleanApplyMode` 同源口径（契约层不引 recog 内部类型，故此处重声明）。
 */
export type QuestionAiCleanApplyMode = 'replace-field' | 'inline-figures';

/**
 * 0065（R-068，只增）：403 占位图（站点拒绝访问）——**未送引擎**，弹层单列分组提示。
 * 判据见 `src/recog/ai-clean/placeholder.ts`：逐字节指纹（前置，零 token）+ 转写文本命中权限文案（事后兜底）。
 * 只用于「跳过调用 + 单列展示」：不删图、不改库。
 */
export interface QuestionAiCleanPlaceholder {
  src: string;
  field?: 'content' | 'answer' | 'analysis';
  /** 人读原因（含尺寸/字节/指纹前缀，或「转写结果即权限文案」） */
  reason: string;
}

export interface QuestionAiCleanPayload {
  mode: QuestionAiCleanMode;
  /** preview：待整理题 id（逐题串行，无并发）；commit：弹层确认的题 id（与 items 对齐） */
  questionIds: string[];
  /** commit 专用：preview 产出并被人确认的改写字段 */
  items?: QuestionAiCleanItemPatch[];
}

/** 逐题结果：ok=false 时分两种情况——skipped（未送引擎，如子母题/无需整理）与 error（送引擎后失败） */
export interface QuestionAiCleanItem {
  questionId: string;
  ok: boolean;
  /** 整理前（原值；弹层并排展示用） */
  before: QuestionAiCleanFields | null;
  /** 整理后（ok=true 才有；commit 直接回传这一份） */
  after: QuestionAiCleanFields | null;
  /** 成功转写的图数（公式图 + 答案图） */
  converted: number;
  /** 单图失败（未替换、保留原图）；`field` = 图所在字段（返工⑧：让人一眼看出是题面还是解析区） */
  failedImages: Array<{ src: string; field?: 'content' | 'answer' | 'analysis'; reason: string }>;
  /**
   * 0056 返工⑧（只增，可选）：本批**未处理**的图（不是失败）——原本只有「解析/答案区含正文的内嵌图」，
   * 整字段替换会冲掉正文。**0065（R-068）起该挡门退役**（含正文字段改走 `inline-figures` 原位替换），
   * 本字段恒为空数组；保留以兼容既有弹层与只增纪律。
   */
  deferred?: Array<{ src: string; reason: string }>;
  /**
   * 0065（R-068，只增，可选）：各字段本次的整理方式（弹层标签，如「解析区 原位替换」/「答案区 整字段替换」）。
   * 只列本次**确有靶**的字段。
   */
  fieldModes?: Partial<Record<'content' | 'answer' | 'analysis', QuestionAiCleanApplyMode>>;
  /**
   * 0065（R-068，只增，可选）：403 占位图（站点拒绝访问）——**未送引擎、不计失败**，
   * 弹层单列「占位图」分组并提示「需到站点开通权限后重新采集」。
   */
  placeholders?: QuestionAiCleanPlaceholder[];
  /** 跳过原因（子母题/无需整理；非空 = 未送引擎） */
  skipped: string | null;
  /** 失败原因（ok=false 且 non-skipped 时非空） */
  error: string | null;
  /** 人读告警（如「答案区原有文字被整体替换」） */
  warnings: string[];
  /**
   * 0056 返工④（只增，可选）：需人工复核 —— 质量闸门起疑（骨架校验矛盾/长文本幻觉等）。
   * 弹层据此**默认不勾选**该题（人工定夺，不静默采信）。返工⑥起转写固定单模型（vision 档案），
   * 不再有「双模型投票不一致」这一来源。
   */
  needsReview?: boolean;
}

export interface QuestionAiCleanResult {
  mode: QuestionAiCleanMode;
  /** preview 产出（commit 模式为空数组） */
  items: QuestionAiCleanItem[];
  /** 0056 返工④（只增，可选）：批次级说明（如「未启用第二 OCR 档案 → 本次为单模型结果」） */
  notes?: string[];
  /** commit：成功落库题数 */
  saved: number;
  /** commit：落库失败题 */
  failed: Array<{ questionId: string; reason: string }>;
}

export interface PaperCreatePayload {
  title: string;
  config?: Record<string, unknown>;
}

export interface PaperGetPayload {
  id: string;
}

export interface PaperAddQuestionPayload {
  paperId: string;
  questionId: string;
  score?: number;
  /**
   * 0004-fix-4 2.3（只增）：文本内容块（kind='text' 行；不占题号）。
   * 复用本通道实现插入/更新（同 id 已存在且为文本块 → 更新正文/样式），不新增 IPC 通道面。
   * 0004-fix-6 P1-1（只增）：扩 align。
   */
  textBlock?: { text: string; style?: 'section' | 'note'; align?: 'left' | 'center' | 'right' };
}

export interface PaperRemoveQuestionPayload {
  paperId: string;
  questionId: string;
}

export interface PaperReorderQuestionsPayload {
  paperId: string;
  questionIds: string[];
}

export interface PaperGetQuestionsPayload {
  paperId: string;
}

export interface PaperSetScorePayload {
  paperId: string;
  questionId: string;
  /** 0018 目检返工三：缺省（undefined）= 清除分值，回未设置 */
  score?: number;
}

export interface CaptureNavigatePayload {
  url: string;
  /**
   * 0012 P2（只增）：导航方式——缺省 'url'=载入地址；'back'/'forward'=webContents 导航栈
   * （React 顶部栏 ⟵⟶）；'reload'=原地刷新。url 字段在非 'url' 方式下仅作回显用途。
   */
  via?: 'url' | 'back' | 'forward' | 'reload';
}

export interface CaptureCollectPayload {
  extracted: CaptureExtraction;
  /** D1-fix-3 L-1（只增）：用户选择学科（学段+学科组合串，如「高中数学」）；缺省回落 meta.subject → 'unknown' */
  subject?: string;
}

export interface CaptureCollectResult {
  ok: number;
  dup: number;
  /** D1-fix-4 复验 R-U（只增）：重采回填更新的已有题目数（缺答案/解析/考点的旧条目被补缺） */
  updated?: number;
  failed: Array<{ questionId: string; error: string }>;
  /**
   * D1-fix-4 复验（只增）：答案/解析补抓（enrich）后的 enriched 题目，供采集预览刷新徽标。
   * 主进程 collect 填充；mock/旧桥缺省时预览保持入库前状态（行为兼容）
   */
  captured?: CapturedQuestion[];
  /**
   * 0004-fix-1 D 组（只增）：本次采集入库后**现在本地题库中**的题目 id。
   * 语义 = ok 新建 + updated 补缺；dup（本次无新建也无回填）不属本批，故不含（注释见 ingest.ts IngestResult.okIds）。
   * 供 CapturePage「采集进篮联动」逐个 addQuestion 到目标试题篮（先过滤已在篮）。
   */
  okIds?: string[];
}

/** D1-fix-3 L-2（只增）：最近一次提取结果（无提取过则为 null） */
export interface CaptureGetLastExtractionResult {
  extracted: CaptureExtraction | null;
}

/** 0006 P4（只增）：整卷下载预览入参（非整卷 URL 由主进程按提示拒绝） */
export interface CapturePaperPreviewPayload {
  url: string;
}

/** 0006 P4（只增）：整卷导入入参（勾选题号 + 去向二选一） */
export interface CapturePaperImportPayload {
  url: string;
  questionIds: string[];
  target: PaperImportTarget;
}

export type CapturePaperPreviewResult = PaperPreview;
export type CapturePaperImportResult = PaperImportResult;

export interface CaptureExtractResult {
  extracted: CaptureExtraction;
}

// ==================== 0012（只增）：内嵌 WebContentsView 形态 ====================

/** 0012（只增）：内嵌 view bounds（渲染层视口坐标 = 主窗 content view 坐标；x/y 可为负=滚动滚出，P0 A3 实证） */
export interface CaptureSetBoundsPayload {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 0012（只增）：采集状态事件推送 payload（CAPTURE_EVENT 通道，主进程 → 渲染层）。
 * loggedIn=null 表示本次未检测（渲染层保持轮询兜底结果）；
 * stage/subject 为 P4 页面语境预填素材（站点原文，未识别时缺省=不预填），解析单源见 src/capture/subject.ts。
 */
export interface CaptureEventPayload {
  url: string;
  title: string;
  loggedIn: boolean | null;
  /** 0012 P4（只增）：学段原文（小学/初中/高中；缺省=未识别不预填） */
  stage?: string;
  /** 0012 P4（只增）：站点学科原文 label（如 化学/道法；渲染层经 subjectIdOf 归一后预填下拉） */
  subject?: string;
  /** 0012 P4（只增）：识别来源（调试记档用） */
  subjectVia?: 'nav-active' | 'bankid' | 'paper-url' | 'segment';
}

/** 0012 P2（只增）：保存当前页 HTML 结果（取证落盘 userData/data/capture-html-snapshots；失败如实回传） */
export interface CaptureSavePageHtmlResult {
  ok: boolean;
  path?: string;
  error?: string;
}

/** E1（只增）：数据备份结果 */
export interface GuardCreateBackupResult {
  success: boolean;
  backupPath?: string;
  manifest?: {
    backup_id: string;
    created_at: string;
    counts: {
      questions: number;
      papers: number;
      assets: number;
    };
  };
  error?: string;
}

/** E1（只增）：数据恢复结果 */
export interface GuardRestoreBackupResult {
  success: boolean;
  restored?: {
    questions: number;
    papers: number;
    assets: number;
  };
  error?: string;
  needsConfirmation?: boolean;
}

/** E1（只增）：数据统计 */
export interface GuardStatsResult {
  questions: number;
  papers: number;
  assets: number;
}

/** 0066（只增）：诊断包导出结果（canceled=用户取消，无产物无报错） */
export interface DiagExportResult {
  success: boolean;
  path?: string;
  canceled?: boolean;
  error?: string;
}

// ---------- 0071（只增）：自定义数据保存位置（R-043） ----------

/** 数据位置来源：config=用户自定义 / portable=便携版默认（exe 旁）/ default=系统默认 */
export type DataLocationSource = 'config' | 'portable' | 'default';

/** dataLocation.get：当前位置与配置态（pending 与失败留痕为实时读引导配置的结果） */
export interface DataLocationInfo {
  /** 本进程生效的 userData 根（数据落 <userDataPath>/data） */
  userDataPath: string;
  source: DataLocationSource;
  /** 引导配置里的正式值（无配置 = null；与 userDataPath 相同即可自定义生效） */
  dataRoot: string | null;
  /** 待迁移目标（写入后重启执行；无 = null） */
  pendingDataRoot: string | null;
  /** 上次迁移失败原因（成功即清；null = 无失败记录） */
  lastMigrationError: string | null;
  /** 便携版运行（exe 旁数据目录） */
  portable: boolean;
}

/** dataLocation.change：选目录（targetDir 缺省 = 主进程弹目录选择框）→ 校验 → 写 pending */
export interface DataLocationChangePayload {
  /** 目标目录（绝对路径）；缺省走系统目录选择对话框（正常 UI 路径） */
  targetDir?: string;
}

export interface DataLocationChangeResult {
  success: boolean;
  /** 用户取消目录选择（无 pending 写入、无报错） */
  canceled?: boolean;
  /** 已写入的待迁移目标（重启后执行） */
  pendingDataRoot?: string;
  error?: string;
}

export interface DataLocationCancelResult {
  success: boolean;
  error?: string;
}

// ---------- 0072（只增）：公告与版本更新（类型单源 distribution-types.ts，此处按惯例再导出） ----------

/** announce.get / announce.refresh 返回（当前生效公告 + 来源标记 remote/cache/builtin） */
export type { AnnounceSnapshot };

/** update.getStatus 返回 + update.onStatus 推送体（状态机全量快照） */
export type { UpdateStatus };

/** update.checkNow 返回（started=false = 已有检查/下载在进行） */
export type { UpdateCheckNowResult };

/** update.openExternal 入参（url）与返回（ok=false = 未放行 http(s) 或打开失败） */
export interface UpdateOpenExternalResult {
  ok: boolean;
  error?: string;
}


// ====================================================================
// 0002 新增通道 Payload 类型（与 bank-types.ts 服务方法一一对应）
// ====================================================================

// ---------- dict.* ----------
export interface DictListPayload { filter?: { kind?: DictKind; activeOnly?: boolean } }
export interface DictIdPayload { id: string }
export interface DictCreatePayload { data: DictEntryInput }
export interface DictUpdatePayload { id: string; data: { code?: string; label?: string; active?: boolean } }

// ---------- tree.* ----------
export interface TreeCreatePayload { data: { type: TreeType; name: string; subjectId?: string; edition?: string; stage?: string; source?: string } }
export interface TreeListPayload { filter?: { type?: TreeType; subjectId?: string } }
export interface TreeIdPayload { id: string }
export interface TreeNodesPayload { treeId: string }
export interface TreeDescendantsPayload { nodeId: string }
export interface TreeNodeCreatePayload { data: { treeId: string; parentId?: string; name: string; sort?: number; sourceMapping?: { site: string; siteNodeId: string; siteNodeName?: string } } }
export interface TreeLinkPayload { questionId: string; nodeId: string }
export interface TreeQuestionNodesPayload { questionId: string }
export interface TreeResolveSourcePayload { site: string; siteNodeId: string }
export interface TreeSourceMappingsPayload { nodeId: string }

// ---------- student.* ----------
export interface StudentCreatePayload { data: { name: string; studentNo?: string; gender?: string; school?: string; remark?: string } }
export interface StudentIdPayload { id: string }
export interface StudentListPayload { filter?: { includeArchived?: boolean; classId?: string; keyword?: string } }
export interface StudentUpdatePayload { id: string; data: Partial<Omit<Student, 'id' | 'createdAt' | 'updatedAt' | 'status'>> }
export interface StudentSetStatusPayload { id: string; status: StudentStatus }
export interface StudentEnrollPayload { studentId: string; classId: string; startedAt?: string }
export interface StudentEndEnrollmentPayload { studentId: string; classId: string; endedAt: string }
export interface StudentEventAddPayload { data: { studentId: string; eventType: StudentEventType; occurredAt: string; payload: StudentEventPayload } }
export interface StudentEventListPayload { filter: { studentId: string; eventType?: StudentEventType; from?: string; to?: string; classId?: string } }

// ---------- class.* ----------
export interface ClassCreatePayload { data: { name: string; school?: string; gradeLevel?: string; term?: string } }
export interface ClassIdPayload { id: string }
export interface ClassListPayload { filter?: { status?: ClassStatus | 'all' } }
export interface ClassUpdatePayload { id: string; data: Partial<Omit<ClassInfo, 'id' | 'createdAt'>> }

// ---------- exam.* ----------
export interface ExamCreatePayload { data: { title: string; classId?: string; subjectId?: string; occurredAt: string; paperSetId?: string; remark?: string } }
export interface ExamIdPayload { id: string }
export interface ExamListPayload { filter?: { classId?: string; subjectId?: string } }
export interface ExamRecordScoresPayload { examId: string; entries: ScoreEntry[] }
export interface ExamScoresPayload { examId: string }
export interface ExamStudentScoresPayload { studentId: string }
export interface ExamRecordResultsPayload { examId: string; entries: ExamResultEntry[] }
export type ExamRecordResultsResult = ExamRecordSummary;

// ---------- mistake.* ----------
export interface MistakeRecordWrongPayload { data: { questionId: string; studentId: string; examId?: string; sourcePaperId?: string; occurredAt: string; note?: string } }
export interface MistakeIdPayload { id: string }
export interface MistakeListPayload { filter?: { studentId?: string; stage?: MistakeStage; questionId?: string; examId?: string } }
export interface MistakeSetStagePayload { id: string; stage: MistakeStage }
export interface MistakeSetNotePayload { id: string; note: string }
export type MistakeRecordWrongResult = { mistake: Mistake; created: boolean };
/** 0025（只增）：聚合/导出入参（filter 缺省=全量；过滤语义见 MistakeAggregateFilter） */
export interface MistakeAggregatePayload { filter?: MistakeAggregateFilter }
/** 0025（只增）：批量删除入参（ids 非空——handler 层即拒，非空集语义见 MistakeService.deleteMistakes） */
export interface MistakeBatchIdsPayload { ids: string[] }
/** 0025（只增）：批量改档入参 */
export interface MistakeBatchSetStagePayload { ids: string[]; stage: MistakeStage }
export type MistakeAggregateResult = MistakeAggregateRow[];
export type MistakeBatchResultPayload = MistakeBatchResult;
export type MistakeExportQuestionIdsResult = string[];

// ---------- paper_set.* ----------
export interface PaperSetCreatePayload { data: { name: string; type: PaperType; batchMeta?: Record<string, unknown> } }
export interface PaperSetIdPayload { id: string }
export interface PaperSetListPayload { filter?: { type?: PaperType } }
export interface PaperSetAddPaperPayload { paperSetId: string; paperId: string; studentId?: string }
export interface PaperSetRemovePaperPayload { paperSetId: string; paperId: string }
export interface PaperSetGetPapersPayload { paperSetId: string }
export interface PaperSetStudentPaperPayload { paperSetId: string; studentId: string }

// ---------- preset.* ----------
export interface PresetCreatePayload { data: { name: string; config: PaperLayoutConfig; isBuiltin?: boolean } }
export interface PresetIdPayload { id: string }
export interface PresetListPayload { filter?: { includeDeleted?: boolean } }
export interface PresetUpdatePayload { id: string; data: { name?: string; config?: PaperLayoutConfig } }

// ---------- bank.paper.* 扩展 ----------
export interface PaperUpdateStatusPayload { id: string; status: PaperStatus }
export interface PaperSetLayoutConfigPayload { id: string; layoutConfig: PaperLayoutConfig }

// ---------- 0004（只增）：试题篮/快照/克隆/重命名 ----------
export interface PaperListExPayload { filter?: { statuses?: PaperStatus[] } }
/** 单卷详情（getPaperEx）——与既有 PaperGetPayload 同构，复用之 */
export interface PaperSnapshotPayload { paperId: string }
export interface PaperSnapshotListPayload { paperId: string }
export interface PaperCloneToBasketPayload { sourcePaperId: string; title?: string }
export interface PaperUpdateTitlePayload { id: string; title: string }
/** 0004 Phase 5（只增）：题级图排版覆盖（整体覆盖式写入；figures:[] = 清除该题覆盖） */
/**
 * 0004 Phase 5（只增）：题级图排版覆盖（整体覆盖式写入；figures:[] = 清除该题覆盖）。
 * 0004-fix-3（只增）：layout 扩题级作答区覆盖 answerSpace。
 */
export interface PaperSetQuestionLayoutsPayload {
  paperId: string;
  questionId: string;
  layout: { figures?: QuestionFigureLayout[]; answerSpace?: QuestionAnswerSpaceOverride };
}

// ---------- 0044（只增）：试卷文件夹 + 回收站 + 存为试卷 payload ----------

export interface PaperFolderListPayload { /* 全量平铺，无过滤参数 */ }

export interface PaperFolderCreatePayload {
  data: {
    name: string;
    /** 缺省=顶级（D-062：parent_id 自引用嵌套；父不存在由服务层抛错） */
    parentId?: string;
  };
}

export interface PaperFolderRenamePayload {
  id: string;
  name: string;
}

export interface PaperFolderIdPayload {
  id: string;
}

/** 移卷入夹（folderId=null=移出回未分类；一卷一夹 D-060②） */
export interface PaperMoveToFolderPayload {
  paperId: string;
  folderId: string | null;
}

/** 单卷动作（trash/restore/deleteForever 共用形态） */
export interface PaperIdActionPayload {
  id: string;
}

/**
 * recog.saveAsPaper 单卡入参（渲染层按题卡顺序给出；主进程保序落库）。
 * 口径 = 0040 WorkbenchPage.commitCards 的入库字段集（origin 恒 'scan'）。
 * 0057：`images` 随「录题图资产化」不再恒空——渲染层按题卡 contentHtml 里实际出现的
 * `data-assets/…` 引用生成（两条入库腿同口径），缺省/undefined 时主进程按空数组落库。
 */
export interface RecogSaveAsPaperCard {
  qno: string | null;
  /** 题型字典 code（'' = 未定，不入库该字段） */
  typeCode: string;
  contentHtml: string;
  answerHtml: string;
  analysisHtml: string;
  /** 题卡首帧页号（sourceDetail.pageNo；无帧缺省 1） */
  pageNo: number;
  /** 已采纳标签（随题写入 question_tags） */
  adoptedTags: string[];
  /** 已采纳挂树节点（null=未采纳不挂） */
  adoptedNode: { nodeId: string; label: string } | null;
  /**
   * 0054（R-045③，只增，可选）：已采纳知识节点**多值**（adoptedNodes 为准、adoptedNode 回落；
   * 缺省/undefined → 主进程按单值 adoptedNode 口径落链，旧调用方零影响）。
   */
  adoptedNodes?: Array<{ nodeId: string; label: string }>;
  /** 0057（只增，可选）：题内图片条目（assetId 带 `data-assets/` 前缀，与 content 内 src 同串） */
  images?: QuestionImage[];
}

export interface RecogSaveAsPaperPayload {
  runId: string;
  /** 卷名（默认=来源文件名，弹层可改，D-060④；空/空白拒绝在 handler 层） */
  title: string;
  /** 归属文件夹（缺省/undefined=未分类） */
  folderId?: string;
  /** 学科显示名（题 subject；与 0040 入库同兜底口径） */
  subject: string;
  /** 学科字典 id（缺省不写，同 0040） */
  subjectId?: string;
  /** 来源卷名（sourceDetail.paperTitle，缺省不写） */
  paperTitle?: string;
  /**
   * 0062（R-066/D-076②，只增，可选）：学段（题级落库，迁移 0017）。
   * 缺省/undefined → 不下发该键（旧调用方零影响；该批题读侧按「未分组」归一）。
   */
  stage?: string;
  /** 题卡（按题卡顺序 = 卷内题序） */
  cards: RecogSaveAsPaperCard[];
}

export interface RecogSaveAsPaperResult {
  paperId: string;
  /** 入库题目 id（按题卡顺序） */
  questionIds: string[];
}

// ---------- 0004（只增）：file.*（主进程独占磁盘 IO；demo/无桥环境由 UI 层降级） ----------
/** 落盘图片资产（logos/ 相对路径，复用 data-assets 加载管线解析） */
export interface FileImageAsset {
  /** 相对 data/assets 的路径，如 'logos/<uuid>.png' */
  relPath: string;
  width?: number;
  height?: number;
}
/**
 * 0057（只增）：file.saveRecogImage 入参——渲染层裁图产物落 assets/recog/。
 * dataUrl 必须是 `data:image/…;base64,` 形态（形验在主进程 handler，失败显式抛错不产坏图）；
 * width/height 由渲染层裁剪时已知（可选，仅回填返回值供调用方对账）。
 */
export interface FileSaveRecogImagePayload {
  dataUrl: string;
  width?: number;
  height?: number;
}
/** 0030（只增）：文本文件导入结果（提示词模板 pack；用户取消对话框 → null） */
export interface FileImportTextResult {
  content: string;
  fileName?: string;
}

/**
 * 0061（只增）：file.scanRecogAssetGarbage 返回——recog 图资产孤儿预览（D-072④「宁留不误删」口径）。
 * orphans：本次扫描判定「不被任何题目/试卷/草稿引用」的资产文件（relPath 相对 data/assets，
 * 形如 `recog/<32hex>.<ext>`）；totalBytes：孤儿字节合计（= 预计释放空间）；
 * scannedCount：`data/assets/recog/` 下参与判定的资产文件总数（非资产形态文件不参与）；
 * referencedCount：其中确认仍被引用者数量（= scannedCount − orphans.length）。
 * 每次调用全新全量重扫（无缓存：恢复旧备份/编辑题面后引用会重现，缓存会误删）。
 */
export interface FileScanRecogAssetGarbageResult {
  orphans: Array<{ relPath: string; bytes: number }>;
  totalBytes: number;
  referencedCount: number;
  scannedCount: number;
}

/**
 * 0061（只增）：file.trashRecogAssets 入参——待回收资产（须为 scan 结果的子集语义）。
 * 逐条形验须匹配 `^recog/[0-9a-f]{32}\.(png|jpe?g|gif|webp|svg)$`（防路径逃逸：`..`/绝对路径/
 * 非白名单扩展名一律拒绝）；主进程执行前重扫一次，只移动「入参 ∩ 最新孤儿集」（已恢复引用者跳过不误删）。
 */
export interface FileTrashRecogAssetsPayload {
  relPaths: string[];
}

/**
 * 0061（只增）：回收结果。moved 只计成功数（Windows 占用 EPERM/EBUSY 逐文件跳过，不整批失败）；
 * bytes = 实际移走的字节合计；trashDir = 本次回收日期目录绝对路径
 * （`<userData>/data/assets/_trash/<YYYYMMDD-HHmmss>`，moved=0 时该目录未创建）。
 */
export interface FileTrashRecogAssetsResult {
  moved: number;
  bytes: number;
  trashDir: string;
}

/** 预设文件导入结果（用户取消对话框 → null） */
export interface FileImportPresetResult {
  content: string;
  fileName?: string;
}
export interface FileExportPresetPayload {
  suggestedName: string;
  content: string;
}

// ---------- 0005（只增）：feedback 模板 4 通道 + 输出 IO payload ----------
export interface FeedbackCreatePayload { data: FeedbackTemplateInput }
export interface FeedbackIdPayload { id: string }
export interface FeedbackListPayload { filter?: { includeDeleted?: boolean } }
export interface FeedbackUpdatePayload { id: string; data: Partial<FeedbackTemplateInput> }
/** 文本导出（保存对话框 + 写文本；取消 → { filePath: null }） */
export interface FileExportTextPayload { suggestedName: string; content: string }
/** 卡片图片批量导出（选目录 → 逐卡 临时 html → capturePage → PNG；width/height = 卡片设计尺寸 px，
 *  主进程按其设定窗口内容尺寸保证输出图=卡片完整无白边；缺省 750×1000） */
export interface FeedbackExportCardsPayload {
  cards: Array<{ fileName: string; html: string; width?: number; height?: number }>;
}
export interface FeedbackExportCardsResult { dir: string; count: number; failed: Array<{ fileName: string; error: string }> }

// ---------- 0030（只增）：反馈记录 + AI 通道提示词模板 payload ----------
export interface FeedbackRecordCreatePayload { data: FeedbackRecordInput }
export interface FeedbackRecordListPayload { query?: FeedbackRecordQuery }
export interface FeedbackRecordUpdatePayload { id: string; data: FeedbackRecordPatch }
export interface FeedbackRecordIdPayload { id: string }
export interface FeedbackPromptCreatePayload { data: FeedbackPromptTemplateInput }
export interface FeedbackPromptListPayload { filter?: { includeDeleted?: boolean } }
export interface FeedbackPromptUpdatePayload { id: string; data: Partial<FeedbackPromptTemplateInput> }
export interface FeedbackPromptIdPayload { id: string }

/**
 * 0002 通道→服务方法对应表（接线参考，UI 里程碑实施）：
 * dict.*→DictService / tree.*→TreeService / student.*→StudentService / class.*→ClassService /
 * exam.*→ExamService / mistake.*→MistakeService / paper_set.*→PaperSetService / preset.*→PresetService /
 * bank.paper.setStatus|setLayoutConfig→PaperExtService
 * 服务方法签名见 bank-types.ts 各接口；payload 字段与方法入参一一对应。
 */
export type BankExtChannelServiceMap =
  | { namespace: 'dict'; service: DictService }
  | { namespace: 'tree'; service: TreeService }
  | { namespace: 'student'; service: StudentService }
  | { namespace: 'class'; service: ClassService }
  | { namespace: 'exam'; service: ExamService }
  | { namespace: 'mistake'; service: MistakeService }
  | { namespace: 'paper_set'; service: PaperSetService }
  | { namespace: 'preset'; service: PresetService }
  | { namespace: 'bank.paper'; service: PaperExtService };

// 0023（只增）：ai.* payload 类型单源于 ai-types.ts；此处按惯例再导出，消费方（bridge/preload/app）单点 import
export type {
  AiProfileCreatePayload, AiProfileUpdatePayload, AiProfileIdPayload,
  AiProfileSetEnabledPayload, AiProfileListPayload, AiProfileTestConnectionPayload,
  AiInvokePayload, AiInvokeResult, AiTestConnectionResult, ModelProfile,
  AiModelsListPayload, AiModelsListResult,
};

// 0028（只增）：recog.* payload 类型单源于 recog-run-types.ts；此处按惯例再导出
export type {
  RecogRunCreatePayload, RecogRunCreateResult, RecogRunDetail, RecogRunHistoryPayload,
  RecogRunAttachQuestionsPayload, RecogRunIdPayload, RecogRun, RecogEventPayload,
};

// 0036（只增）：split.* payload 类型单源于 split-types.ts；此处按惯例再导出
export type {
  SplitProjectCreatePayload, SplitProjectSaveMetaPayload, SplitProjectSaveDraftPayload,
  SplitProjectSaveDraftResult, SplitProjectIdPayload, SplitProjectSummary, SplitProjectDetail,
  SplitSourceAppendPayload, SplitSourceAppendResult, SplitSourceReadPayload, SplitSourceReadResult,
  SplitPageWritePayload, SplitPageWriteResult, SplitPageReadPayload, SplitPageReadResult,
  SplitBox, SplitBoxType, SplitSegment, SplitDraft, SplitSegmentDraft, SplitRunLink,
  SplitProjectMeta, RecogRunLinkStatus,
};

// 0029（只增）：ai.suggest.* payload 类型单源于 ai-suggest-types.ts；此处按惯例再导出
export type {
  AiAnchorStatusPayload, AiAnchorStatusResult, AiSuggestPayload, AiSuggestResult,
};

// 0040（只增）：工作台 payload/状态类型单源于 onestep-types.ts；此处按惯例再导出
export type {
  RecogWorkbenchLoadPayload, RecogWorkbenchSavePayload, RecogWorkbenchSaveResult,
  WorkbenchState, WorkbenchCard, WorkbenchCardStatus, WorkbenchCardSource, WorkbenchMode,
  WorkbenchFrame, WorkbenchFigure, WorkbenchPage, WorkbenchRect, WorkbenchTreeSuggestion,
  OnestepDraft, OnestepFigure, OnestepFigureSource, OnestepOption, OnestepQuestionType,
  OnestepBBox, OnestepProvider, OnestepExtractInput, OnestepExtractImage, OnestepExtractContext,
  AiSuggestTreeForDraftPayload,
};

// 0044（只增）：paper.folder.* / 回收站 / 存为试卷——PaperFolder 单源 bank-types.ts，按惯例再导出
// （其余 0044 payload 类型为本文件本地声明，无需再导出）
export type {
  PaperFolder,
};

