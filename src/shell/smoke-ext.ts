/**
 * --smoke-ext：0003 bank 扩展通道（window.__mofangBankExt）真接线验证（Electron 模式）
 *
 * 流程：真实 preload → driver 页 executeJavaScript 驱动 __mofangBankExt 全链：
 * 建生→建班→分班→建考试（关联卷集合）→recordResults（勾错标红）→查错题红
 * →二次登记 U9 红自动升黄→状态灯循环/回退/备注→成绩查询→封存→错题删除
 * →fix-2 新通道真桥调用（paper.updatePaperStatus 状态机 + paperSet.addPaper 挂卷）。
 * 题目/卷/集合（主进程侧预置）由服务直调；主进程侧再对库行做独立断言
 * （学生封存/成绩落表/错题删除/fix-2 状态与集合落库）。
 */

import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import type { BankService } from '../shared/contracts/bank-types.js';
import type { BankExtServices } from '../shared/contracts/bank-types.js';

export async function runExtSmoke(bankService: BankService, extServices: BankExtServices): Promise<void> {
  try {
    const repoRoot = process.cwd();

    // ---------- 主进程侧预置：题 + 卷 + 统一卷集合（addPaper 非 0003 接线子集） ----------
    const q1 = await bankService.createQuestion({
      subject: '物理',
      sourceType: 'local',
      sourceDetail: { origin: 'smoke-ext' },
      content: '<div class="question">smoke-ext 第一题：自由落体求速度</div>',
      stemHtml: '<div class="question">smoke-ext 第一题：自由落体求速度</div>',
      answer: '<p>v = gt</p>',
      images: [],
    });
    const q2 = await bankService.createQuestion({
      subject: '物理',
      sourceType: 'local',
      sourceDetail: { origin: 'smoke-ext' },
      content: '<div class="question">smoke-ext 第二题：牛顿第二定律</div>',
      stemHtml: '<div class="question">smoke-ext 第二题：牛顿第二定律</div>',
      images: [],
    });
    const paper = await bankService.createPaper('smoke-ext 统一卷');
    await bankService.addQuestion(paper.id, q1.id, 5);
    await bankService.addQuestion(paper.id, q2.id, 5);
    const paperSet = await extServices.paperSet.createPaperSet({ name: 'smoke-ext 集合', type: 'uniform' });
    await extServices.paperSet.addPaper(paperSet.id, paper.id);

    // ---------- driver 页：真实 preload → window.__mofangBankExt ----------
    const driver = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: join(repoRoot, 'dist/shell/preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        // 与主窗一致：preload 需 require 本地契约模块，sandbox 白名单不含本地文件
        sandbox: false,
      },
    });
    await driver.loadFile(join(repoRoot, 'scripts/fixtures/ext-driver.html'));

    const driverScript = '(async () => {\n' +
      '  const ext = window.__mofangBankExt;\n' +
      '  if (!ext) throw new Error("window.__mofangBankExt 未暴露");\n' +
      '  for (const ns of ["dict", "student", "class", "exam", "mistake", "paperSet", "paper"]) {\n' +
      '    if (!ext[ns] || typeof ext[ns] !== "object") throw new Error("__mofangBankExt." + ns + " 缺失");\n' +
      '  }\n' +
      '  const dictEntries = await ext.dict.list({ filter: { kind: "subject" } });\n' +
      '  if (!Array.isArray(dictEntries)) throw new Error("dict.list 应返回数组");\n' +
      '\n' +
      '  // 建生\n' +
      '  const s = await ext.student.create({ data: { name: "烟测学生", gender: "女", school: "烟测中学" } });\n' +
      '  if (!s.id || s.status !== "active") throw new Error("student.create 返回异常: " + JSON.stringify(s));\n' +
      '  // 建班 + 分班\n' +
      '  const c = await ext.class.create({ data: { name: "烟测一班", gradeLevel: "初二" } });\n' +
      '  if (!c.id || c.status !== "active") throw new Error("class.create 返回异常: " + JSON.stringify(c));\n' +
      '  await ext.student.enroll({ studentId: s.id, classId: c.id });\n' +
      '  const periods = await ext.student.getClasses({ id: s.id });\n' +
      '  if (periods.length !== 1) throw new Error("getClasses 应有 1 条时期: " + JSON.stringify(periods));\n' +
      '  if (periods[0].className !== "烟测一班") throw new Error("getClasses 未带班级名: " + JSON.stringify(periods[0]));\n' +
      '  if (periods[0].endedAt) throw new Error("新分班 endedAt 应为空（在班）");\n' +
      '\n' +
      '  // 建考试（关联卷集合）→ recordResults：q1 勾错\n' +
      '  const exam = await ext.exam.create({ data: { title: "烟测月考", classId: c.id, occurredAt: "2026-09-01", paperSetId: ' + JSON.stringify(paperSet.id) + ' } });\n' +
      '  if (!exam.id) throw new Error("exam.create 返回异常");\n' +
      '  const summary = await ext.exam.recordResults({ examId: exam.id, entries: [{ studentId: s.id, score: 5, wrongQuestionIds: [' + JSON.stringify(q1.id) + '] }] });\n' +
      '  if (summary.scoresUpserted !== 1 || summary.mistakesCreated !== 1) throw new Error("recordResults summary 异常: " + JSON.stringify(summary));\n' +
      '  if (summary.autoPromotedToYellow !== 0 || summary.promotedStudents !== 0) throw new Error("首次登记不应触发自动升黄: " + JSON.stringify(summary));\n' +
      '\n' +
      '  // 查错题：红 + 快照可读\n' +
      '  let mistakes = await ext.mistake.list({ filter: { studentId: s.id } });\n' +
      '  if (mistakes.length !== 1) throw new Error("错题应为 1 条: " + JSON.stringify(mistakes.length));\n' +
      '  if (mistakes[0].stage !== "red") throw new Error("新错题应为红: " + mistakes[0].stage);\n' +
      '  if (!mistakes[0].snapshot.stemHtml) throw new Error("错题快照题面缺失");\n' +
      '  if (mistakes[0].examId !== exam.id) throw new Error("错题 examId 关联错误");\n' +
      '\n' +
      '  // 二次登记：无勾错 → U9 红自动升黄（卷中未勾错题视为做对）\n' +
      '  const summary2 = await ext.exam.recordResults({ examId: exam.id, entries: [{ studentId: s.id, score: 10, wrongQuestionIds: [] }] });\n' +
      '  if (summary2.autoPromotedToYellow !== 1 || summary2.promotedStudents !== 1) throw new Error("U9 自动升黄异常: " + JSON.stringify(summary2));\n' +
      '  if (summary2.mistakesCreated !== 0 || summary2.mistakesUpdated !== 0) throw new Error("二次登记不应新增错题: " + JSON.stringify(summary2));\n' +
      '  mistakes = await ext.mistake.list({ filter: { studentId: s.id } });\n' +
      '  if (mistakes[0].stage !== "yellow") throw new Error("U9 后应为黄: " + mistakes[0].stage);\n' +
      '  if (!mistakes[0].lastCorrectAt) throw new Error("U9 后 lastCorrectAt 应刷新");\n' +
      '\n' +
      '  // 状态灯：循环 yellow→green；手动回退红；备注\n' +
      '  const cycled = await ext.mistake.cycleStage({ id: mistakes[0].id });\n' +
      '  if (cycled.stage !== "green") throw new Error("cycleStage yellow→green 异常: " + cycled.stage);\n' +
      '  const back = await ext.mistake.setStage({ id: mistakes[0].id, stage: "red" });\n' +
      '  if (back.stage !== "red") throw new Error("setStage 回退红异常: " + back.stage);\n' +
      '  await ext.mistake.setNote({ id: mistakes[0].id, note: "二次订正仍未掌握" });\n' +
      '  const withNote = await ext.mistake.get({ id: mistakes[0].id });\n' +
      '  if (!withNote || withNote.note !== "二次订正仍未掌握") throw new Error("setNote 未生效");\n' +
      '\n' +
      '  // 成绩查询（U14 独立表）\n' +
      '  const scores = await ext.exam.getScores({ examId: exam.id });\n' +
      '  if (scores.length !== 1 || scores[0].score !== 10) throw new Error("getScores 异常: " + JSON.stringify(scores));\n' +
      '  const studentScores = await ext.exam.getStudentScores({ studentId: s.id });\n' +
      '  if (studentScores.length !== 1 || studentScores[0].examTitle !== "烟测月考") throw new Error("getStudentScores 异常: " + JSON.stringify(studentScores));\n' +
      '\n' +
      '  // 封存 → 默认列表隐藏 → includeArchived 查回；编辑字段\n' +
      '  const renamed = await ext.student.update({ id: s.id, data: { remark: "smoke 备注" } });\n' +
      '  if (renamed.remark !== "smoke 备注") throw new Error("student.update 异常");\n' +
      '  await ext.student.setStatus({ id: s.id, status: "archived" });\n' +
      '  const activeList = await ext.student.list({ filter: {} });\n' +
      '  if (activeList.some((x) => x.id === s.id)) throw new Error("封存后默认列表应隐藏");\n' +
      '  const allList = await ext.student.list({ filter: { includeArchived: true } });\n' +
      '  if (!allList.some((x) => x.id === s.id)) throw new Error("includeArchived 应查回封存学生");\n' +
      '\n' +
      '  // 集合卷查询\n' +
      '  const setPapers = await ext.paperSet.getPapers({ paperSetId: ' + JSON.stringify(paperSet.id) + ' });\n' +
      '  if (setPapers.length !== 1 || setPapers[0].paperId !== ' + JSON.stringify(paper.id) + ') throw new Error("paperSet.getPapers 异常");\n' +
      '\n' +
      '  // fix-2：新通道真桥调用——paper.updatePaperStatus（状态机 basket→composing→done）+ paperSet.addPaper（建集合挂卷）\n' +
      '  await ext.paper.updatePaperStatus({ id: ' + JSON.stringify(paper.id) + ', status: "composing" });\n' +
      '  await ext.paper.updatePaperStatus({ id: ' + JSON.stringify(paper.id) + ', status: "done" });\n' +
      '  let illegalRejected = false;\n' +
      '  try { await ext.paper.updatePaperStatus({ id: ' + JSON.stringify(paper.id) + ', status: "basket" }); } catch { illegalRejected = true; }\n' +
      '  if (!illegalRejected) throw new Error("非法迁移 done→basket 未被拒绝");\n' +
      '  const bridgeSet = await ext.paperSet.create({ data: { name: "smoke-ext fix-2 桥接集合", type: "uniform" } });\n' +
      '  await ext.paperSet.addPaper({ paperSetId: bridgeSet.id, paperId: ' + JSON.stringify(paper.id) + ' });\n' +
      '\n' +
      '  // ==================== 0025：8 条既有 unwired 通道真桥调用 ====================\n' +
      '  const dictEntry = await ext.dict.create({ data: { kind: "difficulty", code: "smoke-l2", label: "烟测中档" } });\n' +
      '  if (!dictEntry.id || dictEntry.label !== "烟测中档") throw new Error("dict.create 真桥调用异常: " + JSON.stringify(dictEntry));\n' +
      '  const tree = await ext.tree.createTree({ data: { type: "knowledge", name: "烟测知识树" } });\n' +
      '  if (!tree.id) throw new Error("tree.createTree 真桥调用异常");\n' +
      '  const node = await ext.tree.createNode({ data: { treeId: tree.id, name: "烟测力学", sourceMapping: { site: "smoke", siteNodeId: "sn-1", siteNodeName: "烟测力学" } } });\n' +
      '  if (!node.id || node.treeId !== tree.id) throw new Error("tree.createNode 真桥调用异常");\n' +
      '  const resolved = await ext.tree.resolveSourceNode({ site: "smoke", siteNodeId: "sn-1" });\n' +
      '  if (!resolved || resolved.id !== node.id) throw new Error("tree.resolveSourceNode 真桥调用未命中同节点");\n' +
      '  await ext.tree.linkQuestion({ questionId: ' + JSON.stringify(q1.id) + ', nodeId: node.id });\n' +
      '  const linked = await ext.tree.getQuestionNodes({ questionId: ' + JSON.stringify(q1.id) + ' });\n' +
      '  if (linked.length !== 1 || linked[0].id !== node.id) throw new Error("tree.linkQuestion 真桥调用未落库");\n' +
      '  await ext.tree.unlinkQuestion({ questionId: ' + JSON.stringify(q1.id) + ', nodeId: node.id });\n' +
      '  const unlinked = await ext.tree.getQuestionNodes({ questionId: ' + JSON.stringify(q1.id) + ' });\n' +
      '  if (unlinked.length !== 0) throw new Error("tree.unlinkQuestion 真桥调用未落库");\n' +
      '  const loopSet = await ext.paperSet.create({ data: { name: "烟测错题批次", type: "custom-mistake", batchMeta: { perStudentLimit: 3, timeWindowDays: 30, sourceRule: "stage=red" } } });\n' +
      '  if (!loopSet.batchMeta || loopSet.batchMeta.perStudentLimit !== 3) throw new Error("paperSet.create batchMeta 往返异常");\n' +
      '  const loopSetRead = await ext.paperSet.get({ id: loopSet.id });\n' +
      '  if (!loopSetRead || JSON.stringify(loopSetRead.batchMeta) !== JSON.stringify({ perStudentLimit: 3, timeWindowDays: 30, sourceRule: "stage=red" })) throw new Error("paperSet.get batchMeta 解析异常");\n' +
      '  await ext.paperSet.addPaper({ paperSetId: loopSet.id, paperId: ' + JSON.stringify(paper.id) + ' });\n' +
      '  await ext.paperSet.removePaper({ paperSetId: loopSet.id, paperId: ' + JSON.stringify(paper.id) + ' });\n' +
      '  const afterRemove = await ext.paperSet.getPapers({ paperSetId: loopSet.id });\n' +
      '  if (afterRemove.length !== 0) throw new Error("paperSet.removePaper 真桥调用未落库");\n' +
      '  await ext.paperSet.delete({ id: loopSet.id });\n' +
      '  if (await ext.paperSet.get({ id: loopSet.id })) throw new Error("paperSet.delete 真桥调用未落库");\n' +
      '\n' +
      '  // ==================== 0025：错题闭环 4 通道真桥调用 ====================\n' +
      '  // 先造第二条错题（q2），供批量两参计数；其后批量删除两条（替换原单条删除路径）\n' +
      '  await ext.mistake.recordWrong({ data: { questionId: ' + JSON.stringify(q2.id) + ', studentId: s.id, occurredAt: "2026-09-02" } });\n' +
      '  const agg = await ext.mistake.aggregateByQuestion({ filter: {} });\n' +
      '  if (agg.length !== 2) throw new Error("mistake.aggregateByQuestion 真桥调用行数异常: " + JSON.stringify(agg));\n' +
      '  if (agg.some((r) => r.wrongCount !== 1)) throw new Error("聚合人次应各为 1: " + JSON.stringify(agg));\n' +
      '  if (agg.some((r) => !r.stemSummary || !r.subject)) throw new Error("聚合行缺题干摘要/学科");\n' +
      '  const aggRed = await ext.mistake.aggregateByQuestion({ filter: { stage: "red" } });\n' +
      '  if (aggRed.length !== 2) throw new Error("聚合 stage 过滤异常");\n' +
      '  const exported = await ext.mistake.exportQuestionIds({ filter: {} });\n' +
      '  if (exported.length !== 2) throw new Error("mistake.exportQuestionIds 真桥调用异常: " + JSON.stringify(exported));\n' +
      '  const allMistakes = await ext.mistake.list({ filter: { studentId: s.id } });\n' +
      '  const batchStage = await ext.mistake.batchSetStage({ ids: allMistakes.map((m) => m.id), stage: "yellow" });\n' +
      '  if (batchStage.affectedCount !== 2) throw new Error("mistake.batchSetStage 影响条数异常: " + JSON.stringify(batchStage));\n' +
      '  const batchDel = await ext.mistake.batchDelete({ ids: allMistakes.map((m) => m.id) });\n' +
      '  if (batchDel.affectedCount !== 2) throw new Error("mistake.batchDelete 影响条数异常: " + JSON.stringify(batchDel));\n' +
      '  mistakes = await ext.mistake.list({ filter: { studentId: s.id } });\n' +
      '  if (mistakes.length !== 0) throw new Error("批量删除后错题应清空");\n' +
      '  const aggAfter = await ext.mistake.aggregateByQuestion({ filter: {} });\n' +
      '  if (aggAfter.length !== 0) throw new Error("批量删除后聚合应清空");\n' +
      '\n' +
      '  return { studentId: s.id, classId: c.id, examId: exam.id, bridgeSetId: bridgeSet.id, dictEntryId: dictEntry.id, treeId: tree.id, nodeId: node.id, loopSetId: loopSet.id };\n' +
      '})()';

    const ids = await driver.webContents.executeJavaScript(driverScript, true);
    driver.close();

    // ---------- 主进程侧库行断言 ----------
    const student = await extServices.student.getStudent(ids.studentId);
    if (!student || student.status !== 'archived') throw new Error('主进程侧：学生封存状态未落库');
    const classes = await extServices.student.getStudentClasses(ids.studentId);
    if (classes.length !== 1 || classes[0].classId !== ids.classId) throw new Error('主进程侧：分班时期未落库');
    const scores = await extServices.exam.getExamScores(ids.examId);
    if (scores.length !== 1 || scores[0].score !== 10) throw new Error('主进程侧：成绩未落表（exam_scores）');
    const mistakesAfterDelete = await extServices.mistake.listMistakes({ studentId: ids.studentId });
    if (mistakesAfterDelete.length !== 0) throw new Error('主进程侧：错题删除未落库');
    // fix-2 新通道库行断言：真桥 paper.updatePaperStatus / paperSet.addPaper
    const statusPaper = await bankService.getPaper(paper.id);
    if (!statusPaper || statusPaper.status !== 'done') throw new Error('主进程侧：paper.updatePaperStatus（真桥）未落库');
    const bridgeSetPapers = await extServices.paperSet.getSetPapers(ids.bridgeSetId);
    if (bridgeSetPapers.length !== 1 || bridgeSetPapers[0].paperId !== paper.id) {
      throw new Error('主进程侧：paperSet.addPaper（真桥）未落库');
    }

    // 0025 新通道库行断言：8 条补线（dict/tree/paper_set 写）+ 错题闭环 4 通道
    const dictRow = await extServices.dict.getEntry(ids.dictEntryId);
    if (!dictRow || dictRow.label !== '烟测中档') throw new Error('主进程侧：dict.create（真桥）未落库');
    const treeNodes = await extServices.tree.getNodes(ids.treeId);
    if (treeNodes.length !== 1 || treeNodes[0].id !== ids.nodeId) throw new Error('主进程侧：tree.createNode（真桥）未落库');
    const mapped = await extServices.tree.getSourceMappings(ids.nodeId);
    if (mapped.length !== 1 || mapped[0].siteNodeId !== 'sn-1') throw new Error('主进程侧：tree 源映射（真桥）未落库');
    const linkedAfter = await extServices.tree.getQuestionNodes(q1.id);
    if (linkedAfter.length !== 0) throw new Error('主进程侧：tree.unlinkQuestion（真桥）未落库');
    const deletedLoopSet = await extServices.paperSet.getPaperSet(ids.loopSetId);
    if (deletedLoopSet !== null) throw new Error('主进程侧：paperSet.delete（真桥）未落库');
    const aggregateAfterBatch = await extServices.mistake.aggregateByQuestion();
    if (aggregateAfterBatch.length !== 0) throw new Error('主进程侧：批量删除后聚合未清空（真桥）');

    console.log(`OK   smoke-ext（Electron）通过: 建生→分班→建考→recordResults→红→U9升黄→循环/回退/备注→封存→fix-2 状态机+挂卷→0025 八条补线通道（dict.create/tree 写 5/paperSet.removePaper+delete）+错题闭环四通道（聚合/批量删/批量改档/题 id 导出）全链（真 preload 桥 + 真 SQLite）`);
    app.exit(0);
  } catch (err) {
    console.error('FAIL smoke-ext（Electron）失败:', err);
    app.exit(1);
  }
}
