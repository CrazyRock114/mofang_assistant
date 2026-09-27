/**
 * --smoke-basket：0004 试题篮通道（__mofangBankExt 0004 子集 + __mofangFile）真接线验证（Electron 模式）
 *
 * 流程（对齐任务书 §三 smoke-basket 探针）：建篮→加题→setStatus composing→重命名→
 * 【Phase 5 定稿全序列走真桥：setLayoutConfig 通道→snapshot×2（幂等）→setStatus done】→
 * listPapersEx 可见→【主进程注入：改题+软删（恒定/克隆分支前置）】→快照内容不变→
 * setQuestionLayouts 通道 roundtrip（写/读/清/引用不存在抛错）→
 * preset 5 通道（内置种子 A3双列/A4 可见可守卫、create/update/delete/软删不可见）→
 * clone×2（原题在引原 id / 软删后快照重建）→archived（getPaperEx 可见 + 旧 listPapers 隐藏）→
 * archived→done 恢复；file 通道 smoke 分支：pickLogo（固定 fixture 不经 dialog）落盘路径合法、
 * readClipboardImage 落盘（剪贴板预置图；清空后 null）、exportPreset/importPreset 回环、非法 JSON 导入报错。退出码 0/1。
 *
 * 前置：npm run build（dist/shell/preload.js、dist/shell/main.js 存在）；main.ts --smoke-basket 分支
 * 已注册 file 通道 smoke fixture（scripts/fixtures/pixel.png）。
 */

import { app, BrowserWindow, clipboard, nativeImage } from 'electron';
import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import type { BankService } from '../shared/contracts/bank-types.js';
import type { BankExtServices } from '../shared/contracts/bank-types.js';

export async function runBasketSmoke(bankService: BankService, extServices: BankExtServices): Promise<void> {
  try {
    const repoRoot = process.cwd();

    // ---------- 主进程侧预置：两题一篮（createPaper 默认 basket 语义） ----------
    const q1 = await bankService.createQuestion({
      subject: '物理',
      sourceType: 'local',
      sourceDetail: { origin: 'smoke-basket' },
      content: '<div class="question">smoke-basket 第一题：匀速直线运动求位移</div>',
      stemHtml: '<div class="question">smoke-basket 第一题：匀速直线运动求位移</div>',
      answer: '<p>s = vt</p>',
      images: [],
    });
    const q2 = await bankService.createQuestion({
      subject: '物理',
      sourceType: 'local',
      sourceDetail: { origin: 'smoke-basket' },
      content: '<div class="question">smoke-basket 第二题：欧姆定律求电流</div>',
      stemHtml: '<div class="question">smoke-basket 第二题：欧姆定律求电流</div>',
      images: [],
    });
    const paper = await bankService.createPaper('smoke-basket 试题篮');
    await bankService.addQuestion(paper.id, q1.id, 5);
    await bankService.addQuestion(paper.id, q2.id, 5);

    // ---------- file 通道前置：剪贴板预置测试图（fixture PNG） ----------
    const logoFixturePath = join(repoRoot, 'scripts/fixtures/pixel.png');
    if (!existsSync(logoFixturePath)) throw new Error(`fixture 缺失: ${logoFixturePath}`);
    clipboard.writeImage(nativeImage.createFromPath(logoFixturePath));

    // ---------- driver 页：真实 preload → window.__mofangBankExt / __mofangFile ----------
    const driver = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: join(repoRoot, 'dist/shell/preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false, // 与主窗一致：preload 需 require 本地契约模块
      },
    });
    await driver.loadFile(join(repoRoot, 'scripts/fixtures/basket-driver.html'));

    const validPresetJson = JSON.stringify({
      version: 2, pageSize: 'A4', columns: 1, fontSize: 12, lineHeight: 1.5, header: { style: 'exam' },
    });

    // ---- 阶段一：composing→重命名→【定稿全序列走真桥：setLayoutConfig→快照×2（幂等）→done】→listPapersEx/getPaperEx ----
    const stage1Script = '(async () => {\n' +
      '  const ext = window.__mofangBankExt;\n' +
      '  const paperId = ' + JSON.stringify(paper.id) + ';\n' +
      '  if (!ext || !ext.paper) throw new Error("window.__mofangBankExt.paper 未暴露");\n' +
      '  await ext.paper.updatePaperStatus({ id: paperId, status: "composing" });\n' +
      '  const renamed = await ext.paper.updatePaperTitle({ id: paperId, title: "smoke-basket 改名卷" });\n' +
      '  if (renamed.title !== "smoke-basket 改名卷") throw new Error("updatePaperTitle 返回异常");\n' +
      '  // Phase 5 定稿序列第①步：版式落库走 setLayoutConfig 通道（原 service 直调改真桥）\n' +
      '  await ext.paper.setLayoutConfig({ id: paperId, layoutConfig: { version: 2, fontSize: 12, lineHeight: 1.5, header: { style: "exam" } } });\n' +
      '  const snapCount = await ext.paper.snapshotPaperQuestions({ paperId });\n' +
      '  if (snapCount !== 2) throw new Error("snapshotPaperQuestions 应写 2 行: " + snapCount);\n' +
      '  const snapAgain = await ext.paper.snapshotPaperQuestions({ paperId });\n' +
      '  if (snapAgain !== 2) throw new Error("重复快照应幂等仍 2 行: " + snapAgain);\n' +
      '  const snapQuestions = await ext.paper.listPaperSnapshotQuestions({ paperId });\n' +
      '  if (snapQuestions.length !== 2) throw new Error("快照还原应 2 题");\n' +
      '  if (snapQuestions[0].answer !== "<p>s = vt</p>") throw new Error("快照答案字段缺失");\n' +
      '  await ext.paper.updatePaperStatus({ id: paperId, status: "done" });\n' +
      '  const doneList = await ext.paper.listPapersEx({ filter: { statuses: ["done"] } });\n' +
      '  if (!doneList.some((s) => s.paper.id === paperId)) throw new Error("listPapersEx done 应可见");\n' +
      '  const donePaper = await ext.paper.getPaperEx({ id: paperId });\n' +
      '  if (!donePaper || donePaper.status !== "done") throw new Error("getPaperEx done 异常");\n' +
      '  if (!donePaper.layoutConfig || donePaper.layoutConfig.fontSize !== 12 || donePaper.layoutConfig.version !== 2) throw new Error("setLayoutConfig 通道未落库");\n' +
      '  return { ok: true };\n' +
      '})()'

    await driver.webContents.executeJavaScript(stage1Script, true);

    // ---- 主进程侧：恒定/克隆分支注入（改题+软删） ----
    await bankService.updateQuestion(q1.id, { answer: '<p>改后答案</p>' });
    await bankService.deleteQuestion(q2.id);

    // ---- 阶段二：恒定 + layoutConfig 读出 + clone 两分支 + archived/恢复 + file 通道 ----
    const stage2Script = '(async () => {\n' +
      '  const ext = window.__mofangBankExt;\n' +
      '  const fileBridge = window.__mofangFile;\n' +
      '  const bank = window.__mofangBank;\n' +
      '  const paperId = ' + JSON.stringify(paper.id) + ';\n' +
      '  if (!fileBridge) throw new Error("window.__mofangFile 未暴露");\n' +
      '\n' +
      '  const snapQuestions = await ext.paper.listPaperSnapshotQuestions({ paperId });\n' +
      '  if (snapQuestions[0].answer !== "<p>s = vt</p>") throw new Error("快照漂移：改题后快照应不变");\n' +
      '  if (snapQuestions[1].content.indexOf("欧姆定律") < 0) throw new Error("软删题快照应保留");\n' +
      '  const donePaper = await ext.paper.getPaperEx({ id: paperId });\n' +
      '  if (!donePaper.layoutConfig || donePaper.layoutConfig.fontSize !== 12) throw new Error("layoutConfig 未随卷读出");\n' +
      '\n' +
      '  const clone1 = await ext.paper.clonePaperToBasket({ sourcePaperId: paperId });\n' +
      '  if (clone1.status !== "basket") throw new Error("clone1 应为 basket");\n' +
      '  if (clone1.title !== "smoke-basket 改名卷复制") throw new Error("clone1 标题缺省规则异常: " + clone1.title);\n' +
      '  const clone1Q = await bank.getPaperQuestions({ paperId: clone1.id });\n' +
      '  if (clone1Q.length !== 2) throw new Error("clone1 引用数异常");\n' +
      '  if (clone1Q[0].questionId !== ' + JSON.stringify(q1.id) + ') throw new Error("clone1 q1 应引原 id");\n' +
      '  if (clone1Q[1].questionId === ' + JSON.stringify(q2.id) + ') throw new Error("clone1 q2 应为重建新 id");\n' +
      '  const rebuilt = await bank.getQuestion({ id: clone1Q[1].questionId });\n' +
      '  if (!rebuilt || rebuilt.content.indexOf("欧姆定律") < 0) throw new Error("重建题内容应来自快照");\n' +
      '  if (rebuilt.answer !== null && rebuilt.answer !== undefined) throw new Error("重建题不应混入他题快照字段");\n' +
      '  if (clone1Q[0].score !== 5 || clone1Q[1].score !== 5) throw new Error("分值未拷贝");\n' +
      '\n' +
      '  const clone2 = await ext.paper.clonePaperToBasket({ sourcePaperId: paperId, title: "二号克隆" });\n' +
      '  if (clone2.title !== "二号克隆") throw new Error("自定义标题未生效");\n' +
      '\n' +
      '  await ext.paper.updatePaperStatus({ id: paperId, status: "archived" });\n' +
      '  const archivedPaper = await ext.paper.getPaperEx({ id: paperId });\n' +
      '  if (!archivedPaper || archivedPaper.status !== "archived") throw new Error("getPaperEx 应见 archived");\n' +
      '  const oldList = await bank.listPapers();\n' +
      '  if (oldList.some((s) => s.paper.id === paperId)) throw new Error("旧 listPapers 应排除 archived");\n' +
      '  await ext.paper.updatePaperStatus({ id: paperId, status: "done" });\n' +
      '  const restored = await ext.paper.getPaperEx({ id: paperId });\n' +
      '  if (!restored || restored.status !== "done") throw new Error("archived→done 恢复失败");\n' +
      '\n' +
      '  // ---- Phase 5：setQuestionLayouts 通道（写→读 roundtrip→清除→引用不存在抛错） ----\n' +
      '  await ext.paper.setQuestionLayouts({ paperId: paperId, questionId: ' + JSON.stringify(q1.id) + ', layout: { figures: [{ assetId: "capture/a.png", mode: "inline", align: "center", widthPercent: 30, orderIndex: 0 }] } });\n' +
      '  const refsWithLayout = await bank.getPaperQuestions({ paperId: paperId });\n' +
      '  const layoutQ1 = refsWithLayout.find((r) => r.questionId === ' + JSON.stringify(q1.id) + ');\n' +
      '  if (!layoutQ1 || !layoutQ1.layout || !layoutQ1.layout.figures || layoutQ1.layout.figures.length !== 1) throw new Error("setQuestionLayouts 写入未带出");\n' +
      '  if (layoutQ1.layout.figures[0].widthPercent !== 30 || layoutQ1.layout.figures[0].orderIndex !== 0) throw new Error("题级覆盖字段不完整");\n' +
      '  const layoutQ2 = refsWithLayout.find((r) => r.questionId === ' + JSON.stringify(q2.id) + ');\n' +
      '  if (layoutQ2 && layoutQ2.layout !== undefined && layoutQ2.layout.figures !== undefined && layoutQ2.layout.figures.length > 0) throw new Error("未覆盖题不应有覆盖");\n' +
      '  await ext.paper.setQuestionLayouts({ paperId: paperId, questionId: ' + JSON.stringify(q1.id) + ', layout: { figures: [] } });\n' +
      '  const cleared = await bank.getPaperQuestions({ paperId: paperId });\n' +
      '  const clearedQ1 = cleared.find((r) => r.questionId === ' + JSON.stringify(q1.id) + ');\n' +
      '  if (!clearedQ1 || !clearedQ1.layout || clearedQ1.layout.figures.length !== 0) throw new Error("空 figures 未清除覆盖");\n' +
      '  let layoutThrew = false;\n' +
      '  try { await ext.paper.setQuestionLayouts({ paperId: paperId, questionId: "no-such-question", layout: { figures: [] } }); } catch (e) { layoutThrew = true; }\n' +
      '  if (!layoutThrew) throw new Error("setQuestionLayouts 引用不存在应抛错");\n' +
      '  // fix-2 F2-E：clone 拷贝题级图覆盖（layout_json 随行拷贝，重新编辑新卷覆盖不丢）\n' +
      '  await ext.paper.setQuestionLayouts({ paperId: paperId, questionId: ' + JSON.stringify(q1.id) + ', layout: { figures: [{ assetId: "capture/a.png", widthPercent: 25, orderIndex: 0 }] } });\n' +
      '  const clone3 = await ext.paper.clonePaperToBasket({ sourcePaperId: paperId, title: "三号克隆带覆盖" });\n' +
      '  const clone3Q = await bank.getPaperQuestions({ paperId: clone3.id });\n' +
      '  const c3q1 = clone3Q.find((r) => r.questionId === ' + JSON.stringify(q1.id) + ');\n' +
      '  if (!c3q1 || !c3q1.layout || !c3q1.layout.figures || c3q1.layout.figures.length !== 1 || c3q1.layout.figures[0].widthPercent !== 25) throw new Error("clone 未拷贝题级图覆盖");\n' +
      '  const c3others = clone3Q.filter((r) => r.questionId !== ' + JSON.stringify(q1.id) + ');\n' +
      '  if (c3others.some((r) => r.layout && r.layout.figures && r.layout.figures.length > 0)) throw new Error("未覆盖题不应带出覆盖");\n' +
      '\n' +
      '  // ---- Phase 5：preset 5 通道（内置种子可见 + create/update/delete/守卫/软删不可见） ----\n' +
      '  const presets = await ext.preset.list({ filter: {} });\n' +
      '  const a3 = presets.find((p) => p.name === "A3双列");\n' +
      '  const a4 = presets.find((p) => p.name === "A4");\n' +
      '  if (!a3 || !a3.isBuiltin) throw new Error("内置种子 A3双列 不可见");\n' +
      '  if (!a4 || !a4.isBuiltin) throw new Error("内置种子 A4 不可见");\n' +
      '  if (a3.config.pageSize !== "A3" || a3.config.columns !== 2 || a3.config.version !== 2) throw new Error("A3双列 种子 config 异常");\n' +
      '  if (a4.config.pageSize !== "A4" || a4.config.columns !== 1) throw new Error("A4 种子 config 异常");\n' +
      '  // fix-2 F2-A：迁移 0004_a3_landscape 后种子 orientation（真实库与 mock 逐字段一致）\n' +
      '  if (a3.config.orientation !== "landscape") throw new Error("A3双列 种子 orientation 应为 landscape: " + JSON.stringify(a3.config));\n' +
      '  if (a4.config.orientation !== "portrait") throw new Error("A4 种子 orientation 应为 portrait: " + JSON.stringify(a4.config));\n' +
      '  const myPreset = await ext.preset.create({ data: { name: "smoke-预设", config: { version: 2, pageSize: "A3", columns: 2 } } });\n' +
      '  if (myPreset.isBuiltin) throw new Error("createPreset 不应产出内置");\n' +
      '  const renamedPreset = await ext.preset.update({ id: myPreset.id, data: { name: "smoke-预设v2" } });\n' +
      '  if (renamedPreset.name !== "smoke-预设v2") throw new Error("updatePreset 改名未生效");\n' +
      '  let builtinGuard = false;\n' +
      '  try { await ext.preset.delete({ id: a3.id }); } catch (e) { builtinGuard = true; }\n' +
      '  if (!builtinGuard) throw new Error("内置预设删除应抛错");\n' +
      '  let builtinUpdateGuard = false;\n' +
      '  try { await ext.preset.update({ id: a4.id, data: { name: "改内置" } }); } catch (e) { builtinUpdateGuard = true; }\n' +
      '  if (!builtinUpdateGuard) throw new Error("内置预设改名应抛错");\n' +
      '  await ext.preset.delete({ id: myPreset.id });\n' +
      '  const afterDelete = await ext.preset.get({ id: myPreset.id });\n' +
      '  if (afterDelete !== null) throw new Error("软删后 getPreset 应为 null");\n' +
      '\n' +
      '  const logo = await fileBridge.pickLogoImage();\n' +
      '  if (!logo || !/^logos\\/[0-9a-f-]{36}\\.png$/.test(logo.relPath)) throw new Error("pickLogoImage relPath 非法: " + JSON.stringify(logo));\n' +
      '  const clip = await fileBridge.readClipboardImage();\n' +
      '  if (!clip || !/^logos\\/[0-9a-f-]{36}\\.png$/.test(clip.relPath)) throw new Error("readClipboardImage relPath 非法");\n' +
      '  if (typeof clip.width !== "number" || typeof clip.height !== "number") throw new Error("readClipboardImage 应带尺寸");\n' +
      '  const exported = await fileBridge.exportPresetFile({ suggestedName: "preset.json", content: ' + JSON.stringify(validPresetJson) + ' });\n' +
      '  if (!exported.filePath) throw new Error("exportPresetFile 未落盘");\n' +
      '  const imported = await fileBridge.importPresetFile();\n' +
      '  if (!imported || imported.content !== ' + JSON.stringify(validPresetJson) + ') throw new Error("importPreset 回环内容不一致");\n' +
      '\n' +
      '  return { clone1Id: clone1.id, clone2Id: clone2.id };\n' +
      '})()';

    const ids = await driver.webContents.executeJavaScript(stage2Script, true);

    // ---- 阶段三：非法 JSON 导入报错 + 剪贴板清空 → null ----
    await driver.webContents.executeJavaScript(
      '(async () => window.__mofangFile.exportPresetFile({ suggestedName: "preset.json", content: "{ this is not json" }))()',
      true,
    );
    await driver.webContents.executeJavaScript(
      '(async () => { const r = await window.__mofangFile.importPresetFile(); let rejected = false; try { JSON.parse(r.content); } catch { rejected = true; } if (!rejected) throw new Error("非法 JSON 未报错"); return { ok: true }; })()',
      true,
    );

    clipboard.clear();
    const emptyClip = await driver.webContents.executeJavaScript(
      '(async () => window.__mofangFile.readClipboardImage())()',
      true,
    );
    if (emptyClip !== null) throw new Error('剪贴板清空后 readClipboardImage 应返回 null');

    driver.close();

    // ---------- 主进程侧库行断言 ----------
    const sourcePaper = await extServices.paper.getPaperEx(paper.id);
    if (!sourcePaper || sourcePaper.status !== 'done' || sourcePaper.title !== 'smoke-basket 改名卷') {
      throw new Error('主进程侧：源卷 done/重命名未落库');
    }
    if (!sourcePaper.layoutConfig) throw new Error('主进程侧：layoutConfig 未落库');
    // 快照 upsert 无重复行（JOIN paper_questions 后恰 2 条；若重复 insert 会 4 条）
    const snapshots = await extServices.paper.listPaperSnapshotQuestions(paper.id);
    if (snapshots.length !== 2) throw new Error('主进程侧：快照行数异常（应 2）');
    if (snapshots[0].answer !== '<p>s = vt</p>') throw new Error('主进程侧：快照恒定破坏');
    // 克隆卷落库
    const clone1 = await extServices.paper.getPaperEx(ids.clone1Id);
    if (!clone1 || clone1.status !== 'basket') throw new Error('主进程侧：clone1 未落库');
    const cloneRefs = await bankService.getPaperQuestions(ids.clone1Id);
    if (cloneRefs.length !== 2) throw new Error('主进程侧：clone1 引用未落库');
    // file 落盘：logos 目录至少 2 个文件（pickLogo + clipboard），文件名 = <uuid>.png
    const logosDir = join(app.getPath('userData'), 'data', 'assets', 'logos');
    const logoFiles = readdirSync(logosDir);
    if (logoFiles.length < 2) throw new Error(`主进程侧：logo 落盘异常 (${logoFiles.length})`);
    for (const f of logoFiles) {
      if (!/^[0-9a-f-]{36}\.png$/.test(f)) throw new Error(`主进程侧：logo 文件名非法: ${f}`);
    }

    console.log('OK   smoke-basket（Electron）通过: 建篮→加题→composing→重命名→【定稿全序列走真桥 setLayoutConfig→快照×2(幂等)→done】→listPapersEx→恒定→setQuestionLayouts(写/读/清/引用不存在抛错)→clone 带题级覆盖(F2-E)→preset 5通道(内置A3双列/A4种子可见含orientation[fix-2 F2-A]+守卫+软删不可见)→clone×2(原题在/软删重建)→archived/恢复→file 4通道(smoke 分支) 全链（真桥真 SQLite）');
    app.exit(0);
  } catch (err) {
    console.error('FAIL smoke-basket（Electron）失败:', err);
    app.exit(1);
  }
}
