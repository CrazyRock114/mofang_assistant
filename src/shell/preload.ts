// Phase 3: preload — contextBridge 白名单 API

import { contextBridge, ipcRenderer } from 'electron';
import { join } from 'node:path';
import type {
  QuestionCreatePayload,
  QuestionGetPayload,
  QuestionListPayload,
  QuestionUpdatePayload,
  QuestionDeletePayload,
  QuestionAddTagPayload,
  QuestionRemoveTagPayload,
  // 0056（只增）：采集题 AI 整理 payload
  QuestionAiCleanPayload,
  PaperCreatePayload,
  PaperGetPayload,
  PaperAddQuestionPayload,
  PaperRemoveQuestionPayload,
  PaperReorderQuestionsPayload,
  PaperGetQuestionsPayload,
  PaperSetScorePayload,
  CaptureNavigatePayload,
  CaptureCollectPayload,
  // 0012（只增）：内嵌 view bounds/事件推送 payload
  CaptureSetBoundsPayload,
  CaptureEventPayload,
} from '../shared/contracts/ipc-channels.js';
// 0028（只增）：识别 run payload / 事件（类型单源 recog-run-types.ts，经 ipc-channels 再导出）
import type { RecogEventPayload } from '../shared/contracts/ipc-channels.js';
import { IPC_CHANNELS } from '../shared/contracts/ipc-channels.js';
import type { MofangCaptureBridge, MofangPaths, MofangGuardBridge, MofangBankExtBridge, MofangFileBridge, MofangAiBridge, MofangRecogBridge, MofangSplitBridge, ExportPdfPayload, ExportDocxPayload } from '../shared/contracts/bridge.js';
// 0066（只增）：诊断包导出桥（单列一行——与上一行 bridge.js 类型同源，保持既有行零改动）
import type { MofangDiagBridge } from '../shared/contracts/bridge.js';
// 0071（只增）：数据保存位置桥 + 通道 payload（同源 bridge/ipc-channels，既有行零改动）
import type { MofangDataLocationBridge } from '../shared/contracts/bridge.js';
import type { DataLocationChangePayload } from '../shared/contracts/ipc-channels.js';
// 0072（只增）：公告与版本更新桥 + payload（同源 bridge/ipc-channels，既有行零改动）
import type { MofangAnnounceBridge, MofangUpdateBridge } from '../shared/contracts/bridge.js';
import type { AnnounceSnapshot, UpdateStatus, UpdateOpenExternalResult } from '../shared/contracts/ipc-channels.js';
// 0036（只增）：切题工作区载荷类型（类型单源 split-types.ts，经 ipc-channels 再导出）
import type {
  SplitProjectCreatePayload, SplitProjectSaveMetaPayload, SplitProjectSaveDraftPayload,
  SplitProjectIdPayload, SplitSourceAppendPayload, SplitSourceReadPayload,
  SplitPageWritePayload, SplitPageReadPayload,
} from '../shared/contracts/ipc-channels.js';

// 白名单 API
const mofangBridge = {
  // Question operations
  createQuestion: (payload: QuestionCreatePayload) =>
    ipcRenderer.invoke(IPC_CHANNELS.QUESTION_CREATE, payload),
  getQuestion: (payload: QuestionGetPayload) =>
    ipcRenderer.invoke(IPC_CHANNELS.QUESTION_GET, payload),
  listQuestions: (payload: QuestionListPayload) =>
    ipcRenderer.invoke(IPC_CHANNELS.QUESTION_LIST, payload),
  updateQuestion: (payload: QuestionUpdatePayload) =>
    ipcRenderer.invoke(IPC_CHANNELS.QUESTION_UPDATE, payload),
  deleteQuestion: (payload: QuestionDeletePayload) =>
    ipcRenderer.invoke(IPC_CHANNELS.QUESTION_DELETE, payload),
  addTag: (payload: QuestionAddTagPayload) =>
    ipcRenderer.invoke(IPC_CHANNELS.QUESTION_ADD_TAG, payload),
  removeTag: (payload: QuestionRemoveTagPayload) =>
    ipcRenderer.invoke(IPC_CHANNELS.QUESTION_REMOVE_TAG, payload),
  // 0056（只增）：采集题 AI 整理（preview 对照 / commit 落库）
  questionAiClean: (payload: QuestionAiCleanPayload) =>
    ipcRenderer.invoke(IPC_CHANNELS.QUESTION_AI_CLEAN, payload),

  // Paper operations
  createPaper: (payload: PaperCreatePayload) =>
    ipcRenderer.invoke(IPC_CHANNELS.PAPER_CREATE, payload),
  getPaper: (payload: PaperGetPayload) =>
    ipcRenderer.invoke(IPC_CHANNELS.PAPER_GET, payload),
  listPapers: () =>
    ipcRenderer.invoke(IPC_CHANNELS.PAPER_LIST),
  addQuestion: (payload: PaperAddQuestionPayload) =>
    ipcRenderer.invoke(IPC_CHANNELS.PAPER_ADD_QUESTION, payload),
  removeQuestion: (payload: PaperRemoveQuestionPayload) =>
    ipcRenderer.invoke(IPC_CHANNELS.PAPER_REMOVE_QUESTION, payload),
  reorderQuestions: (payload: PaperReorderQuestionsPayload) =>
    ipcRenderer.invoke(IPC_CHANNELS.PAPER_REORDER_QUESTIONS, payload),
  getPaperQuestions: (payload: PaperGetQuestionsPayload) =>
    ipcRenderer.invoke(IPC_CHANNELS.PAPER_GET_QUESTIONS, payload),
  setQuestionScore: (payload: PaperSetScorePayload) =>
    ipcRenderer.invoke(IPC_CHANNELS.PAPER_SET_SCORE, payload),

  // PDF export（0004 Phase 5：pageSize 透传——A3/A4 出纸按 layoutConfig.pageSize，缺省 A4；
  // fix-2 F2-A：landscape 透传——横版出纸按 layoutConfig.orientation；
  // 0007 P2：paginate 透传——导出页化入参，类型以契约 ExportPdfPayload 为准）
  exportPdf: (payload: ExportPdfPayload) =>
    ipcRenderer.invoke('doc.exportPdf', payload),

  // 0035（只增）：Word(DOCX) 导出透传（结构化卷数据；主进程组装 + 保存对话框）
  exportDocx: (payload: ExportDocxPayload) =>
    ipcRenderer.invoke(IPC_CHANNELS.DOC_EXPORT_DOCX, payload),
};

contextBridge.exposeInMainWorld('__mofangBank', mofangBridge);

// capture 白名单 API（D0-fix R-3：channel 白名单 + invoke 实现）
const mofangCaptureBridge: MofangCaptureBridge = {
  openWindow: () =>
    ipcRenderer.invoke(IPC_CHANNELS.CAPTURE_OPEN_WINDOW),
  closeWindow: () =>
    ipcRenderer.invoke(IPC_CHANNELS.CAPTURE_CLOSE_WINDOW),
  navigate: (payload: CaptureNavigatePayload) =>
    ipcRenderer.invoke(IPC_CHANNELS.CAPTURE_NAVIGATE, payload),
  getState: () =>
    ipcRenderer.invoke(IPC_CHANNELS.CAPTURE_GET_STATE),
  extractBasket: () =>
    ipcRenderer.invoke(IPC_CHANNELS.CAPTURE_EXTRACT_BASKET),
  collect: (payload: CaptureCollectPayload) =>
    ipcRenderer.invoke(IPC_CHANNELS.CAPTURE_COLLECT, payload),
  getLastExtraction: () =>
    ipcRenderer.invoke(IPC_CHANNELS.CAPTURE_GET_LAST_EXTRACTION),
  // 0006 P4（只增）：整卷下载（预览 + 去向二选一导入）
  paperPreview: (payload) =>
    ipcRenderer.invoke(IPC_CHANNELS.CAPTURE_PAPER_PREVIEW, payload),
  paperImport: (payload) =>
    ipcRenderer.invoke(IPC_CHANNELS.CAPTURE_PAPER_IMPORT, payload),
  // 0012（只增）：内嵌 view bounds 上报 + 状态事件订阅 + 保存当前页 HTML（取证）
  setBounds: (payload: CaptureSetBoundsPayload) =>
    ipcRenderer.invoke(IPC_CHANNELS.CAPTURE_SET_BOUNDS, payload),
  onEvent: (callback: (payload: CaptureEventPayload) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: CaptureEventPayload) => callback(payload);
    ipcRenderer.on(IPC_CHANNELS.CAPTURE_EVENT, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.CAPTURE_EVENT, listener);
    };
  },
  savePageHtml: () =>
    ipcRenderer.invoke(IPC_CHANNELS.CAPTURE_SAVE_PAGE_HTML),
};

contextBridge.exposeInMainWorld('__mofangCapture', mofangCaptureBridge);

// E1（只增）：guard 白名单 API（数据备份与恢复）
const mofangGuardBridge: MofangGuardBridge = {
  createBackup: () =>
    ipcRenderer.invoke(IPC_CHANNELS.GUARD_CREATE_BACKUP),
  restoreBackup: (payload: { confirmed: boolean }) =>
    ipcRenderer.invoke(IPC_CHANNELS.GUARD_RESTORE_BACKUP, payload),
  getStats: () =>
    ipcRenderer.invoke(IPC_CHANNELS.GUARD_GET_STATS),
  // 0037（只增）：首页沉淀统计聚合（含 AI 用量，读 operation_log 留痕）
  getDashboard: () =>
    ipcRenderer.invoke(IPC_CHANNELS.GUARD_GET_DASHBOARD),
};

contextBridge.exposeInMainWorld('__mofangGuard', mofangGuardBridge);

// 0066（只增）：diag 白名单 API（可运维性一期：设置页一键导出诊断包）
const mofangDiagBridge: MofangDiagBridge = {
  exportDiagnostics: () =>
    ipcRenderer.invoke(IPC_CHANNELS.DIAG_EXPORT_DIAGNOSTICS),
};

contextBridge.exposeInMainWorld('__mofangDiag', mofangDiagBridge);

// 0071（只增）：dataLocation 白名单 API（自定义数据保存位置 / R-043）
// 语义：get 读当前位置与配置态；change 选新位置（缺 targetDir 时主进程弹目录选择框）——
// 变更只在**下次启动**迁移生效（本进程不热切换）；cancel 撤销待迁移。
const mofangDataLocationBridge: MofangDataLocationBridge = {
  get: () => ipcRenderer.invoke(IPC_CHANNELS.DATA_LOCATION_GET),
  change: (payload?: DataLocationChangePayload) => ipcRenderer.invoke(IPC_CHANNELS.DATA_LOCATION_CHANGE, payload),
  cancel: () => ipcRenderer.invoke(IPC_CHANNELS.DATA_LOCATION_CANCEL),
};

contextBridge.exposeInMainWorld('__mofangDataLocation', mofangDataLocationBridge);

// 0072（只增）：公告白名单 API（R-073 发布批 lane A）
// 语义：get 读当前生效公告（主进程三级回落 remote→cache→builtin 后的快照，含来源标记）；
// refresh 手动刷新（设置页/弹窗共用；失败回落不 throw）。
const mofangAnnounceBridge: MofangAnnounceBridge = {
  get: (): Promise<AnnounceSnapshot> => ipcRenderer.invoke(IPC_CHANNELS.ANNOUNCE_GET),
  refresh: (): Promise<AnnounceSnapshot> => ipcRenderer.invoke(IPC_CHANNELS.ANNOUNCE_REFRESH),
};

contextBridge.exposeInMainWorld('__mofangAnnounce', mofangAnnounceBridge);

// 0072（只增）：版本更新白名单 API（electron-updater generic；主进程 isPackaged 才接线真 handler，
// dev 态接线降级 handler 恒 not-available（目检返工②）；自动化态 invoke 拒绝——UI 按「无桥」同口径不渲染更新区）。
// onStatus 照 recog.onEvent 范式（同 0012）：订阅型通道，退订函数随返回值给出，组件卸载即断。
const mofangUpdateBridge: MofangUpdateBridge = {
  getStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_GET_STATUS),
  checkNow: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_CHECK_NOW),
  openExternal: (url: string): Promise<UpdateOpenExternalResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.UPDATE_OPEN_EXTERNAL, url),
  quitAndInstall: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_QUIT_AND_INSTALL),
  onStatus: (callback: (status: UpdateStatus) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: UpdateStatus) => callback(status);
    ipcRenderer.on(IPC_CHANNELS.UPDATE_ON_STATUS, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.UPDATE_ON_STATUS, listener);
    };
  },
};

contextBridge.exposeInMainWorld('__mofangUpdate', mofangUpdateBridge);

// 0003：bank 扩展白名单 API（student/class/exam/mistake 全量 + dict/paper_set 查询子集，
// fix-2（只增）补 paperSet.addPaper + paper.updatePaperStatus；
// 0004（只增）补试题篮 6 通道 + tree 查询 4 通道；
// 0004 Phase 5（只增）补 paper.setLayoutConfig/setQuestionLayouts + preset 5 通道；
// 0005（只增）补 feedback 课后反馈模板 4 通道；
// 通道子集见 bridge.ts MofangBankExtBridge 注释；既有 __mofangBank 等零改动）
const mofangBankExtBridge: MofangBankExtBridge = {
  dict: {
    list: (payload) => ipcRenderer.invoke(IPC_CHANNELS.DICT_LIST, payload),
    get: (payload) => ipcRenderer.invoke(IPC_CHANNELS.DICT_GET, payload),
    // 0016（只增补线）：U12 未知值指认（守卫在 service 层）
    update: (payload) => ipcRenderer.invoke(IPC_CHANNELS.DICT_UPDATE, payload),
    // 0025（只增补线）：dict.create（重名守卫在 service 层）
    create: (payload) => ipcRenderer.invoke(IPC_CHANNELS.DICT_CREATE, payload),
  },
  student: {
    create: (payload) => ipcRenderer.invoke(IPC_CHANNELS.STUDENT_CREATE, payload),
    get: (payload) => ipcRenderer.invoke(IPC_CHANNELS.STUDENT_GET, payload),
    list: (payload) => ipcRenderer.invoke(IPC_CHANNELS.STUDENT_LIST, payload),
    update: (payload) => ipcRenderer.invoke(IPC_CHANNELS.STUDENT_UPDATE, payload),
    setStatus: (payload) => ipcRenderer.invoke(IPC_CHANNELS.STUDENT_SET_STATUS, payload),
    enroll: (payload) => ipcRenderer.invoke(IPC_CHANNELS.STUDENT_ENROLL, payload),
    endEnrollment: (payload) => ipcRenderer.invoke(IPC_CHANNELS.STUDENT_END_ENROLLMENT, payload),
    getClasses: (payload) => ipcRenderer.invoke(IPC_CHANNELS.STUDENT_GET_CLASSES, payload),
    addEvent: (payload) => ipcRenderer.invoke(IPC_CHANNELS.STUDENT_ADD_EVENT, payload),
    listEvents: (payload) => ipcRenderer.invoke(IPC_CHANNELS.STUDENT_LIST_EVENTS, payload),
  },
  class: {
    create: (payload) => ipcRenderer.invoke(IPC_CHANNELS.CLASS_CREATE, payload),
    get: (payload) => ipcRenderer.invoke(IPC_CHANNELS.CLASS_GET, payload),
    list: (payload) => ipcRenderer.invoke(IPC_CHANNELS.CLASS_LIST, payload),
    update: (payload) => ipcRenderer.invoke(IPC_CHANNELS.CLASS_UPDATE, payload),
  },
  exam: {
    create: (payload) => ipcRenderer.invoke(IPC_CHANNELS.EXAM_CREATE, payload),
    get: (payload) => ipcRenderer.invoke(IPC_CHANNELS.EXAM_GET, payload),
    list: (payload) => ipcRenderer.invoke(IPC_CHANNELS.EXAM_LIST, payload),
    recordScores: (payload) => ipcRenderer.invoke(IPC_CHANNELS.EXAM_RECORD_SCORES, payload),
    getScores: (payload) => ipcRenderer.invoke(IPC_CHANNELS.EXAM_GET_SCORES, payload),
    getStudentScores: (payload) => ipcRenderer.invoke(IPC_CHANNELS.EXAM_GET_STUDENT_SCORES, payload),
    recordResults: (payload) => ipcRenderer.invoke(IPC_CHANNELS.EXAM_RECORD_RESULTS, payload),
  },
  mistake: {
    recordWrong: (payload) => ipcRenderer.invoke(IPC_CHANNELS.MISTAKE_RECORD_WRONG, payload),
    get: (payload) => ipcRenderer.invoke(IPC_CHANNELS.MISTAKE_GET, payload),
    list: (payload) => ipcRenderer.invoke(IPC_CHANNELS.MISTAKE_LIST, payload),
    setStage: (payload) => ipcRenderer.invoke(IPC_CHANNELS.MISTAKE_SET_STAGE, payload),
    cycleStage: (payload) => ipcRenderer.invoke(IPC_CHANNELS.MISTAKE_CYCLE_STAGE, payload),
    setNote: (payload) => ipcRenderer.invoke(IPC_CHANNELS.MISTAKE_SET_NOTE, payload),
    delete: (payload) => ipcRenderer.invoke(IPC_CHANNELS.MISTAKE_DELETE, payload),
    // 0025（只增）：错题闭环数据层四通道
    aggregateByQuestion: (payload) => ipcRenderer.invoke(IPC_CHANNELS.MISTAKE_AGGREGATE, payload),
    batchDelete: (payload) => ipcRenderer.invoke(IPC_CHANNELS.MISTAKE_BATCH_DELETE, payload),
    batchSetStage: (payload) => ipcRenderer.invoke(IPC_CHANNELS.MISTAKE_BATCH_SET_STAGE, payload),
    exportQuestionIds: (payload) => ipcRenderer.invoke(IPC_CHANNELS.MISTAKE_EXPORT_QUESTION_IDS, payload),
  },
  paperSet: {
    create: (payload) => ipcRenderer.invoke(IPC_CHANNELS.PAPER_SET_CREATE, payload),
    get: (payload) => ipcRenderer.invoke(IPC_CHANNELS.PAPER_SET_GET, payload),
    list: (payload) => ipcRenderer.invoke(IPC_CHANNELS.PAPER_SET_LIST, payload),
    addPaper: (payload) => ipcRenderer.invoke(IPC_CHANNELS.PAPER_SET_ADD_PAPER, payload),
    // 0025（只增补线）：写通道 removePaper/delete
    removePaper: (payload) => ipcRenderer.invoke(IPC_CHANNELS.PAPER_SET_REMOVE_PAPER, payload),
    getPapers: (payload) => ipcRenderer.invoke(IPC_CHANNELS.PAPER_SET_GET_PAPERS, payload),
    getStudentPaper: (payload) => ipcRenderer.invoke(IPC_CHANNELS.PAPER_SET_GET_STUDENT_PAPER, payload),
    delete: (payload) => ipcRenderer.invoke(IPC_CHANNELS.PAPER_SET_DELETE, payload),
  },
  paper: {
    updatePaperStatus: (payload) => ipcRenderer.invoke(IPC_CHANNELS.PAPER_UPDATE_STATUS, payload),
    // 0004（只增）：试题篮 6 通道
    listPapersEx: (payload) => ipcRenderer.invoke(IPC_CHANNELS.BANK_PAPER_LIST_EX, payload),
    getPaperEx: (payload) => ipcRenderer.invoke(IPC_CHANNELS.BANK_PAPER_GET_EX, payload),
    snapshotPaperQuestions: (payload) => ipcRenderer.invoke(IPC_CHANNELS.BANK_PAPER_SNAPSHOT, payload),
    listPaperSnapshotQuestions: (payload) => ipcRenderer.invoke(IPC_CHANNELS.BANK_PAPER_SNAPSHOT_LIST, payload),
    clonePaperToBasket: (payload) => ipcRenderer.invoke(IPC_CHANNELS.BANK_PAPER_CLONE_TO_BASKET, payload),
    updatePaperTitle: (payload) => ipcRenderer.invoke(IPC_CHANNELS.BANK_PAPER_UPDATE_TITLE, payload),
    // 0004 Phase 5（只增）：版式定稿 + 题级图排版覆盖
    setLayoutConfig: (payload) => ipcRenderer.invoke(IPC_CHANNELS.PAPER_SET_LAYOUT_CONFIG, payload),
    setQuestionLayouts: (payload) => ipcRenderer.invoke(IPC_CHANNELS.BANK_PAPER_SET_QUESTION_LAYOUTS, payload),
    // 0044（只增）：文件夹嵌套 CRUD + 移卷 + 回收站三动作（试卷管理页 #/papers 数据面）
    folder: {
      list: () => ipcRenderer.invoke(IPC_CHANNELS.PAPER_FOLDER_LIST),
      create: (payload) => ipcRenderer.invoke(IPC_CHANNELS.PAPER_FOLDER_CREATE, payload),
      rename: (payload) => ipcRenderer.invoke(IPC_CHANNELS.PAPER_FOLDER_RENAME, payload),
      delete: (payload) => ipcRenderer.invoke(IPC_CHANNELS.PAPER_FOLDER_DELETE, payload),
    },
    moveToFolder: (payload) => ipcRenderer.invoke(IPC_CHANNELS.PAPER_MOVE_TO_FOLDER, payload),
    trash: (payload) => ipcRenderer.invoke(IPC_CHANNELS.PAPER_TRASH, payload),
    restore: (payload) => ipcRenderer.invoke(IPC_CHANNELS.PAPER_RESTORE, payload),
    deleteForever: (payload) => ipcRenderer.invoke(IPC_CHANNELS.PAPER_DELETE_FOREVER, payload),
  },
  // 0004（只增）：tree 查询 4 通道（空态判定）；0016（只增补线）：getSourceMappings 站点映射只读查看
  // 0025（只增补线）：树写入 5 通道（手工挂树）
  tree: {
    listTrees: (payload) => ipcRenderer.invoke(IPC_CHANNELS.TREE_LIST, payload),
    getNodes: (payload) => ipcRenderer.invoke(IPC_CHANNELS.TREE_GET_NODES, payload),
    getDescendants: (payload) => ipcRenderer.invoke(IPC_CHANNELS.TREE_GET_DESCENDANTS, payload),
    getQuestionNodes: (payload) => ipcRenderer.invoke(IPC_CHANNELS.TREE_GET_QUESTION_NODES, payload),
    getSourceMappings: (payload) => ipcRenderer.invoke(IPC_CHANNELS.TREE_GET_SOURCE_MAPPINGS, payload),
    createTree: (payload) => ipcRenderer.invoke(IPC_CHANNELS.TREE_CREATE, payload),
    createNode: (payload) => ipcRenderer.invoke(IPC_CHANNELS.TREE_CREATE_NODE, payload),
    linkQuestion: (payload) => ipcRenderer.invoke(IPC_CHANNELS.TREE_LINK_QUESTION, payload),
    unlinkQuestion: (payload) => ipcRenderer.invoke(IPC_CHANNELS.TREE_UNLINK_QUESTION, payload),
    resolveSourceNode: (payload) => ipcRenderer.invoke(IPC_CHANNELS.TREE_RESOLVE_SOURCE_NODE, payload),
  },
  // 0004 Phase 5（只增）：版式预设 5 通道（内置守卫在服务层：update/delete 对 isBuiltin 抛错）
  preset: {
    create: (payload) => ipcRenderer.invoke(IPC_CHANNELS.PRESET_CREATE, payload),
    get: (payload) => ipcRenderer.invoke(IPC_CHANNELS.PRESET_GET, payload),
    list: (payload) => ipcRenderer.invoke(IPC_CHANNELS.PRESET_LIST, payload),
    update: (payload) => ipcRenderer.invoke(IPC_CHANNELS.PRESET_UPDATE, payload),
    delete: (payload) => ipcRenderer.invoke(IPC_CHANNELS.PRESET_DELETE, payload),
  },
  // 0005（只增）：课后反馈模板 4 通道（照 preset 模式；内置守卫在服务层）
  feedback: {
    create: (payload) => ipcRenderer.invoke(IPC_CHANNELS.FEEDBACK_CREATE, payload),
    get: (payload) => ipcRenderer.invoke(IPC_CHANNELS.FEEDBACK_GET, payload),
    list: (payload) => ipcRenderer.invoke(IPC_CHANNELS.FEEDBACK_LIST, payload),
    update: (payload) => ipcRenderer.invoke(IPC_CHANNELS.FEEDBACK_UPDATE, payload),
    delete: (payload) => ipcRenderer.invoke(IPC_CHANNELS.FEEDBACK_DELETE, payload),
  },
  // 0030（只增）：反馈记录落档 5 通道 + AI 通道提示词模板 5 通道（D-065 双模式；守卫在服务层）
  feedbackRecord: {
    create: (payload) => ipcRenderer.invoke(IPC_CHANNELS.FEEDBACK_RECORD_CREATE, payload),
    get: (payload) => ipcRenderer.invoke(IPC_CHANNELS.FEEDBACK_RECORD_GET, payload),
    list: (payload) => ipcRenderer.invoke(IPC_CHANNELS.FEEDBACK_RECORD_LIST, payload),
    update: (payload) => ipcRenderer.invoke(IPC_CHANNELS.FEEDBACK_RECORD_UPDATE, payload),
    delete: (payload) => ipcRenderer.invoke(IPC_CHANNELS.FEEDBACK_RECORD_DELETE, payload),
  },
  feedbackPrompt: {
    create: (payload) => ipcRenderer.invoke(IPC_CHANNELS.FEEDBACK_PROMPT_CREATE, payload),
    get: (payload) => ipcRenderer.invoke(IPC_CHANNELS.FEEDBACK_PROMPT_GET, payload),
    list: (payload) => ipcRenderer.invoke(IPC_CHANNELS.FEEDBACK_PROMPT_LIST, payload),
    update: (payload) => ipcRenderer.invoke(IPC_CHANNELS.FEEDBACK_PROMPT_UPDATE, payload),
    delete: (payload) => ipcRenderer.invoke(IPC_CHANNELS.FEEDBACK_PROMPT_DELETE, payload),
  },
};

contextBridge.exposeInMainWorld('__mofangBankExt', mofangBankExtBridge);

// 0004（只增）：file 白名单 API（Logo 本地图片 + 剪贴板图片 + 预设导入导出；主进程独占磁盘 IO）
// 0005（只增）：exportTextFile（反馈 txt）+ exportCards（feedback.exportCards 通道，批量 PNG）
const mofangFileBridge: MofangFileBridge = {
  pickLogoImage: () => ipcRenderer.invoke(IPC_CHANNELS.FILE_PICK_LOGO_IMAGE),
  // 0057（只增）：录题裁图产物落 assets/recog/（与 pickLogoImage 同型，入参为 data URL）
  saveRecogImage: (payload) => ipcRenderer.invoke(IPC_CHANNELS.FILE_SAVE_RECOG_IMAGE, payload),
  readClipboardImage: () => ipcRenderer.invoke(IPC_CHANNELS.FILE_READ_CLIPBOARD_IMAGE),
  importPresetFile: () => ipcRenderer.invoke(IPC_CHANNELS.FILE_IMPORT_PRESET_FILE),
  exportPresetFile: (payload) => ipcRenderer.invoke(IPC_CHANNELS.FILE_EXPORT_PRESET_FILE, payload),
  exportTextFile: (payload) => ipcRenderer.invoke(IPC_CHANNELS.FILE_EXPORT_TEXT_FILE, payload),
  // 0030（只增）：文本文件导入（提示词模板 pack；选文件与读文本在主进程，解析在 UI 层）
  importTextFile: () => ipcRenderer.invoke(IPC_CHANNELS.FILE_IMPORT_TEXT_FILE),
  // 0061（只增）：废图清理（扫描预览 + 移入回收目录；判定与移动全在主进程，渲染层只见 relPath/字节数）
  scanRecogAssetGarbage: () => ipcRenderer.invoke(IPC_CHANNELS.FILE_SCAN_RECOG_ASSET_GARBAGE),
  trashRecogAssets: (payload) => ipcRenderer.invoke(IPC_CHANNELS.FILE_TRASH_RECOG_ASSETS, payload),
  exportCards: (payload) => ipcRenderer.invoke(IPC_CHANNELS.FEEDBACK_EXPORT_CARDS, payload),
};

contextBridge.exposeInMainWorld('__mofangFile', mofangFileBridge);

// 0023（只增）：ai 白名单 API（模型配置体系；七通道，类型以契约 MofangAiBridge 为准）
// Key 红线：明文 apiKey 仅在 profile.create/update payload 中出现一次（主进程加密即弃）；
// list/get 返回值无 key_encrypted（只回 hasKey），密文永不出主进程。
const mofangAiBridge: MofangAiBridge = {
  profile: {
    list: (payload) => ipcRenderer.invoke(IPC_CHANNELS.AI_PROFILE_LIST, payload),
    create: (payload) => ipcRenderer.invoke(IPC_CHANNELS.AI_PROFILE_CREATE, payload),
    update: (payload) => ipcRenderer.invoke(IPC_CHANNELS.AI_PROFILE_UPDATE, payload),
    delete: (payload) => ipcRenderer.invoke(IPC_CHANNELS.AI_PROFILE_DELETE, payload),
    setEnabled: (payload) => ipcRenderer.invoke(IPC_CHANNELS.AI_PROFILE_SET_ENABLED, payload),
    testConnection: (payload) => ipcRenderer.invoke(IPC_CHANNELS.AI_PROFILE_TEST_CONNECTION, payload),
  },
  invoke: (payload) => ipcRenderer.invoke(IPC_CHANNELS.AI_INVOKE, payload),
  // 0023 目检返工 R3（只增）：获取模型列表
  models: {
    list: (payload) => ipcRenderer.invoke(IPC_CHANNELS.AI_MODELS_LIST, payload),
  },
  // 0029（只增）：AI 挂树/打标建议（D-050；纯读面——锚点状态回执 + 建议产出；
  // 确认写入由 renderer 回走 ext.tree.linkQuestion / bank.addTag，P-07 无直写面）
  suggest: {
    anchorStatus: (payload) => ipcRenderer.invoke(IPC_CHANNELS.AI_ANCHOR_STATUS, payload),
    treeLink: (payload) => ipcRenderer.invoke(IPC_CHANNELS.AI_SUGGEST_TREE, payload),
    tags: (payload) => ipcRenderer.invoke(IPC_CHANNELS.AI_SUGGEST_TAGS, payload),
    // 0040（只增）：工作台草稿挂树建议（同 0024 锚点链，题面来源换成草稿文本）
    treeForDraft: (payload) => ipcRenderer.invoke(IPC_CHANNELS.AI_SUGGEST_TREE_FOR_DRAFT, payload),
  },
};

contextBridge.exposeInMainWorld('__mofangAi', mofangAiBridge);

// 0028（只增）：recog 白名单 API（识别 run 任务化；六通道 + 一个事件订阅，类型以契约 MofangRecogBridge 为准）
// Key 红线：识别经 ai.invoke（vision 角色）走网关，本桥面不出现任何 Key/凭据字段；
// 大产物（页图/OCR 原文/草稿）只落主进程磁盘，过桥的只有 base64 素材上行与状态/草稿下行。
const mofangRecogBridge: MofangRecogBridge = {
  create: (payload) => ipcRenderer.invoke(IPC_CHANNELS.RECOG_RUN_CREATE, payload),
  status: (payload) => ipcRenderer.invoke(IPC_CHANNELS.RECOG_RUN_STATUS, payload),
  cancel: (payload) => ipcRenderer.invoke(IPC_CHANNELS.RECOG_RUN_CANCEL, payload),
  history: (payload) => ipcRenderer.invoke(IPC_CHANNELS.RECOG_RUN_HISTORY, payload),
  attachQuestions: (payload) => ipcRenderer.invoke(IPC_CHANNELS.RECOG_RUN_ATTACH_QUESTIONS, payload),
  resume: (payload) => ipcRenderer.invoke(IPC_CHANNELS.RECOG_RUN_RESUME, payload),
  // 照 capture.onEvent 范式（同 0012）：退订函数随返回值给出，组件卸载即断
  onEvent: (callback: (payload: RecogEventPayload) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: RecogEventPayload) => callback(payload);
    ipcRenderer.on(IPC_CHANNELS.RECOG_EVENT, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.RECOG_EVENT, listener);
    };
  },
  // 0040（只增）：工作台卡流文件态读/写（run 目录 workbench.json；卡流状态落主进程磁盘）
  workbench: {
    load: (payload) => ipcRenderer.invoke(IPC_CHANNELS.RECOG_WORKBENCH_LOAD, payload),
    save: (payload) => ipcRenderer.invoke(IPC_CHANNELS.RECOG_WORKBENCH_SAVE, payload),
  },
  // 0044（只增）：「存为试卷」主进程一步编排（逐题入库→建卷 composing→保序挂题→run 回写）
  saveAsPaper: (payload) => ipcRenderer.invoke(IPC_CHANNELS.RECOG_SAVE_AS_PAPER, payload),
  // 0046（只增）：Onestep 草稿写回 run（recog.draft.write；P6.3 换档落地）
  draftWrite: (payload) => ipcRenderer.invoke(IPC_CHANNELS.RECOG_DRAFT_WRITE, payload),
};

contextBridge.exposeInMainWorld('__mofangRecog', mofangRecogBridge);

// 0036（只增）：split 白名单 API（PDF 切题工作区；十通道，类型以契约 MofangSplitBridge 为准）
// 工作区文件态只在主进程磁盘，过桥的只有小载荷；源 PDF 分块 append/read（不整本进单条消息）。
const mofangSplitBridge: MofangSplitBridge = {
  createProject: (payload: SplitProjectCreatePayload) => ipcRenderer.invoke(IPC_CHANNELS.SPLIT_PROJECT_CREATE, payload),
  appendSource: (payload: SplitSourceAppendPayload) => ipcRenderer.invoke(IPC_CHANNELS.SPLIT_SOURCE_APPEND, payload),
  readSource: (payload: SplitSourceReadPayload) => ipcRenderer.invoke(IPC_CHANNELS.SPLIT_SOURCE_READ, payload),
  saveMeta: (payload: SplitProjectSaveMetaPayload) => ipcRenderer.invoke(IPC_CHANNELS.SPLIT_PROJECT_SAVE_META, payload),
  saveDraft: (payload: SplitProjectSaveDraftPayload) => ipcRenderer.invoke(IPC_CHANNELS.SPLIT_PROJECT_SAVE_DRAFT, payload),
  listProjects: () => ipcRenderer.invoke(IPC_CHANNELS.SPLIT_PROJECT_LIST),
  openProject: (payload: SplitProjectIdPayload) => ipcRenderer.invoke(IPC_CHANNELS.SPLIT_PROJECT_OPEN, payload),
  removeProject: (payload: SplitProjectIdPayload) => ipcRenderer.invoke(IPC_CHANNELS.SPLIT_PROJECT_REMOVE, payload),
  writePage: (payload: SplitPageWritePayload) => ipcRenderer.invoke(IPC_CHANNELS.SPLIT_PAGE_WRITE, payload),
  readPage: (payload: SplitPageReadPayload) => ipcRenderer.invoke(IPC_CHANNELS.SPLIT_PAGE_READ, payload),
};

contextBridge.exposeInMainWorld('__mofangSplit', mofangSplitBridge);

// D1 Phase 0：从 additionalArguments 读 userData 根，暴露只读资产路径（data-assets/ 前缀渲染解析用）
const userDataArg = process.argv.find((a) => a.startsWith('--mofang-user-data='));
if (userDataArg) {
  const userDataPath = userDataArg.slice('--mofang-user-data='.length);
  const mofangPaths: MofangPaths = {
    userDataAssets: join(userDataPath, 'data', 'assets'),
  };
  contextBridge.exposeInMainWorld('__mofangPaths', mofangPaths);
}

