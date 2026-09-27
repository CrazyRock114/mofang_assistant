// 0003 Phase 2: IpcExtClient — renderer 侧 BankExtServices 实现（包装 window.__mofangBankExt）
//
// 只包装已接线通道（0003 接线 35 个 + fix-2 只增 2 个 + 0004 只增：paper 试题篮 6 个、tree 查询 4 个
// + 0004 Phase 5 只增：paper.setLayoutConfig/setQuestionLayouts、preset 5 个 + 0016 只增：dict.update/
// tree.getSourceMappings + 0025 只增：8 条既有 unwired 补线（dict.create、paperSet.removePaper/delete、
// tree 写 5）+ 错题闭环 4 个）；
// 尚未接线的方法（无对应契约通道）仍在本类中显式 throw——UI 不得调用。
// 0025 后仍未接线：tree.getTree（无 TREE_GET 通道）、student.getClassStudents（无独立通道）、
// class.closeClass（R-014）、paper.createPaperEx（无通道，成品卷走 capture/bank 侧）。

import type {
  BankExtServices,
  DictService, TreeService, StudentService, ClassService, ExamService,
  MistakeService, PaperSetService, PresetService, PaperExtService, FeedbackService,
  // 0030（只增）：AI 通道提示词模板 + 反馈记录落档
  FeedbackPromptTemplateService, FeedbackRecordService,
} from '../../shared/contracts/bank-types.js';
import type { MofangBankExtBridge } from '../../shared/contracts/bridge.js';

/** 未接线通道统一报错（无对应契约通道，UI 调用即失败可见，不允许静默） */
function unwired(namespace: string, method: string): never {
  throw new Error(`bank-ext IPC 通道未定义（无契约通道）: ${namespace}.${method}`);
}

export class IpcExtClient implements BankExtServices {
  private bridge: MofangBankExtBridge;

  readonly dict: DictService;
  readonly student: StudentService;
  readonly class: ClassService;
  readonly exam: ExamService;
  readonly mistake: MistakeService;
  readonly paperSet: PaperSetService;
  readonly tree: TreeService;
  readonly preset: PresetService;
  readonly feedback: FeedbackService;
  // 0030（只增）
  readonly feedbackPrompt: FeedbackPromptTemplateService;
  readonly feedbackRecord: FeedbackRecordService;
  readonly paper: PaperExtService;

  constructor() {
    if (!window.__mofangBankExt) {
      throw new Error('IpcExtClient requires window.__mofangBankExt (Electron environment)');
    }
    this.bridge = window.__mofangBankExt;

    // dict（list/get 已接线；0016 补线 update——U12 未知值指认；0025 补线 create）
    this.dict = {
      listEntries: (filter) => this.bridge.dict.list({ filter }),
      getEntry: (id) => this.bridge.dict.get({ id }),
      createEntry: (data) => this.bridge.dict.create({ data }),
      updateEntry: (id, data) => this.bridge.dict.update({ id, data }),
    };

    // student（10 全）
    this.student = {
      createStudent: (data) => this.bridge.student.create({ data }),
      getStudent: (id) => this.bridge.student.get({ id }),
      listStudents: (filter) => this.bridge.student.list({ filter }),
      updateStudent: (id, data) => this.bridge.student.update({ id, data }),
      setStudentStatus: (id, status) => this.bridge.student.setStatus({ id, status }),
      enrollStudent: (studentId, classId, startedAt) => this.bridge.student.enroll({ studentId, classId, startedAt }),
      endEnrollment: (studentId, classId, endedAt) => this.bridge.student.endEnrollment({ studentId, classId, endedAt }),
      getStudentClasses: (id) => this.bridge.student.getClasses({ id }),
      // 班级名册无独立通道（0002 冻结的 student.* 仅 10 通道）——UI 经 student.list({classId}) + getClasses 组合查询
      getClassStudents: () => unwired('student', 'getClassStudents'),
      addEvent: (data) => this.bridge.student.addEvent({ data }),
      listEvents: (filter) => this.bridge.student.listEvents({ filter }),
    };

    // class（4 全；closeClass 无通道——0002 冻结未定义 class.close，不接）
    this.class = {
      createClass: (data) => this.bridge.class.create({ data }),
      getClass: (id) => this.bridge.class.get({ id }),
      listClasses: (filter) => this.bridge.class.list({ filter }),
      updateClass: (id, data) => this.bridge.class.update({ id, data }),
      closeClass: () => unwired('class', 'closeClass'),
    };

    // exam（7 全）
    this.exam = {
      createExam: (data) => this.bridge.exam.create({ data }),
      getExam: (id) => this.bridge.exam.get({ id }),
      listExams: (filter) => this.bridge.exam.list({ filter }),
      recordScores: (examId, entries) => this.bridge.exam.recordScores({ examId, entries }),
      getExamScores: (examId) => this.bridge.exam.getScores({ examId }),
      getStudentScores: (studentId) => this.bridge.exam.getStudentScores({ studentId }),
      recordResults: (examId, entries) => this.bridge.exam.recordResults({ examId, entries }),
    };

    // mistake（7 全 + 0025 只增 4：聚合/批量删/批量改档/题 id 集导出）
    this.mistake = {
      recordWrong: (data) => this.bridge.mistake.recordWrong({ data }),
      getMistake: (id) => this.bridge.mistake.get({ id }),
      listMistakes: (filter) => this.bridge.mistake.list({ filter }),
      setStage: (id, stage) => this.bridge.mistake.setStage({ id, stage }),
      cycleStage: (id) => this.bridge.mistake.cycleStage({ id }),
      setNote: (id, note) => this.bridge.mistake.setNote({ id, note }),
      deleteMistake: (id) => this.bridge.mistake.delete({ id }),
      aggregateByQuestion: (filter) => this.bridge.mistake.aggregateByQuestion({ filter }),
      deleteMistakes: (ids) => this.bridge.mistake.batchDelete({ ids }),
      setStages: (ids, stage) => this.bridge.mistake.batchSetStage({ ids, stage }),
      exportQuestionIds: (filter) => this.bridge.mistake.exportQuestionIds({ filter }),
    };

    // paperSet（0025 补线后 8 全：查询 5 + 写入 addPaper/removePaper/delete）
    this.paperSet = {
      createPaperSet: (data) => this.bridge.paperSet.create({ data }),
      getPaperSet: (id) => this.bridge.paperSet.get({ id }),
      listPaperSets: (filter) => this.bridge.paperSet.list({ filter }),
      addPaper: (paperSetId, paperId, studentId) => this.bridge.paperSet.addPaper({ paperSetId, paperId, studentId }),
      removePaper: (paperSetId, paperId) => this.bridge.paperSet.removePaper({ paperSetId, paperId }),
      getSetPapers: (paperSetId) => this.bridge.paperSet.getPapers({ paperSetId }),
      getStudentPaper: (paperSetId, studentId) => this.bridge.paperSet.getStudentPaper({ paperSetId, studentId }),
      deletePaperSet: (id) => this.bridge.paperSet.delete({ id }),
    };

    // 0004：tree 查询 4 通道接线（listTrees/getNodes/getDescendants/getQuestionNodes——
    // 仅为知识树空态判定与未来数据就绪，数据未采集 UI 显示「待采集」）；
    // 0025：写通道 5 条补齐（createTree/createNode/linkQuestion/unlinkQuestion/resolveSourceNode）
    this.tree = {
      createTree: (data) => this.bridge.tree.createTree({ data }),
      listTrees: (filter) => this.bridge.tree.listTrees({ filter }),
      getTree: () => unwired('tree', 'getTree'),
      getNodes: (treeId) => this.bridge.tree.getNodes({ treeId }),
      getDescendants: (nodeId) => this.bridge.tree.getDescendants({ nodeId }),
      createNode: (data) => this.bridge.tree.createNode({ data }),
      linkQuestion: (questionId, nodeId) => this.bridge.tree.linkQuestion({ questionId, nodeId }),
      unlinkQuestion: (questionId, nodeId) => this.bridge.tree.unlinkQuestion({ questionId, nodeId }),
      getQuestionNodes: (questionId) => this.bridge.tree.getQuestionNodes({ questionId }),
      resolveSourceNode: (site, siteNodeId) => this.bridge.tree.resolveSourceNode({ site, siteNodeId }),
      // 0016 补线：站点映射只读查看（节点级查询；树级聚合在渲染层组合）
      getSourceMappings: (nodeId) => this.bridge.tree.getSourceMappings({ nodeId }),
    };
    // 0004 Phase 5：preset 5 通道接线（内置预设只读守卫在服务层——应用可、改/删不可）
    this.preset = {
      createPreset: (data) => this.bridge.preset.create({ data }),
      getPreset: (id) => this.bridge.preset.get({ id }),
      listPresets: (filter) => this.bridge.preset.list({ filter }),
      updatePreset: (id, data) => this.bridge.preset.update({ id, data }),
      deletePreset: (id) => this.bridge.preset.delete({ id }),
    };
    // 0005：feedback 4 通道接线（模板 CRUD；内置只读守卫在服务层）
    this.feedback = {
      createTemplate: (data) => this.bridge.feedback.create({ data }),
      getTemplate: (id) => this.bridge.feedback.get({ id }),
      listTemplates: (filter) => this.bridge.feedback.list({ filter }),
      updateTemplate: (id, data) => this.bridge.feedback.update({ id, data }),
      deleteTemplate: (id) => this.bridge.feedback.delete({ id }),
    };
    // 0030（只增）：反馈记录 5 通道 + AI 通道提示词模板 5 通道（双模式落档语义在服务层）
    this.feedbackRecord = {
      createRecord: (data) => this.bridge.feedbackRecord.create({ data }),
      getRecord: (id) => this.bridge.feedbackRecord.get({ id }),
      listRecords: (query) => this.bridge.feedbackRecord.list({ query }),
      updateRecord: (id, data) => this.bridge.feedbackRecord.update({ id, data }),
      deleteRecord: (id) => this.bridge.feedbackRecord.delete({ id }),
    };
    this.feedbackPrompt = {
      createTemplate: (data) => this.bridge.feedbackPrompt.create({ data }),
      getTemplate: (id) => this.bridge.feedbackPrompt.get({ id }),
      listTemplates: (filter) => this.bridge.feedbackPrompt.list({ filter }),
      updateTemplate: (id, data) => this.bridge.feedbackPrompt.update({ id, data }),
      deleteTemplate: (id) => this.bridge.feedbackPrompt.delete({ id }),
    };
    this.paper = {
      createPaperEx: () => unwired('bank.paper', 'createPaperEx'),
      updatePaperStatus: (id, status) => this.bridge.paper.updatePaperStatus({ id, status }),
      // 0004 Phase 5：版式定稿落库（定稿序列第①步）
      setPaperLayoutConfig: (id, layoutConfig) => this.bridge.paper.setLayoutConfig({ id, layoutConfig }),
      // 0004（只增）：试题篮 6 通道（桥桥直通；payload 类型见 ipc-channels.ts）
      listPapersEx: (filter) => this.bridge.paper.listPapersEx({ filter }),
      getPaperEx: (id) => this.bridge.paper.getPaperEx({ id }),
      snapshotPaperQuestions: (paperId) => this.bridge.paper.snapshotPaperQuestions({ paperId }),
      listPaperSnapshotQuestions: (paperId) => this.bridge.paper.listPaperSnapshotQuestions({ paperId }),
      clonePaperToBasket: (sourcePaperId, title) => this.bridge.paper.clonePaperToBasket({ sourcePaperId, title }),
      updatePaperTitle: (id, title) => this.bridge.paper.updatePaperTitle({ id, title }),
      // 0004 Phase 5：题级图排版覆盖写入
      setQuestionLayouts: (paperId, questionId, layout) => this.bridge.paper.setQuestionLayouts({ paperId, questionId, layout }),
      // 0044（只增）：文件夹嵌套 CRUD + 移卷 + 回收站三动作（试卷管理页数据面）
      listFolders: () => this.bridge.paper.folder.list(),
      createFolder: (data) => this.bridge.paper.folder.create({ data }),
      renameFolder: (id, name) => this.bridge.paper.folder.rename({ id, name }),
      deleteFolder: (id) => this.bridge.paper.folder.delete({ id }),
      moveToFolder: (paperId, folderId) => this.bridge.paper.moveToFolder({ paperId, folderId }),
      trashPaper: (id) => this.bridge.paper.trash({ id }),
      restorePaper: (id) => this.bridge.paper.restore({ id }),
      deleteForeverPaper: (id) => this.bridge.paper.deleteForever({ id }),
    };
  }
}
