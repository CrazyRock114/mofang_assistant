/**
 * --capture-smoke：capture.* IPC 接线真实可调验证（Electron 模式）
 *
 * 流程：preload driver 页 → window.__mofangCapture 全链（openWindow→navigate→getState
 * →extractBasket→collect→closeWindow→getState），全程本地 fixture：
 * capture session 的 https 协议被拦截映射到 scripts/fixtures，未命中一律 418 拒网
 * （无站点访问、无凭据）。答案图/内容图同步落盘，主进程侧断言资产文件与入库行数。
 */

import { app, BrowserWindow } from 'electron';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BankService, DictService } from '../shared/contracts/bank-types.js';
import type { CaptureHost } from '../capture/browser/host.js';

const HTML = 'text/html; charset=utf-8';
const PNG = 'image/png';
const JSON_TYPE = 'application/json; charset=utf-8';

export async function runCaptureSmoke(
  host: CaptureHost,
  bankService: BankService,
  dictService: DictService
): Promise<void> {
  try {
    const repoRoot = process.cwd();
    const fixturesDir = join(repoRoot, 'scripts', 'fixtures');

    // 0006-fix-3 P3-3：临时库先 seed 最小学科字典（走 DictService 真实接口）——
    // 归一行 math/physics + jyeoo 站点行 physics2→physics；questions.subject_id 有外键约束，
    // 不 seed 则 subjectId 落库必 FOREIGN KEY constraint failed。
    await dictService.createEntry({ kind: 'subject', code: 'math', label: '数学' });
    await dictService.createEntry({ kind: 'subject', code: 'physics', label: '物理' });
    await dictService.createEntry({ kind: 'subject', code: 'physics', label: 'physics2', site: 'jyeoo', sourceLabel: 'physics2' });
    // 0006 P4：组卷站点行（学段+学科组合原文，dict-collect 同款）——整卷题 meta.subject「初中物理」经此归一
    await dictService.createEntry({ kind: 'subject', code: 'physics', label: '初中物理', site: 'zujuan', sourceLabel: '初中物理' });

    // fixture 路由表：capture session 内 https 全拦截（含隐藏答案窗口与图片下载）
    // D1-fix-3：jyeoo 篮改锚真实快照（live/，已脱敏）；report/detail 未抓真实快照（302 缺口）不注册路由，
    // 两跳补抓在 smoke 中失败降级为 warning（不中断、不串题、不覆写篮内联答案）
    const routes: Record<string, { file: string; contentType: string }> = {
      'https://zujuan.xkw.com/__capture_smoke__/basket': { file: 'zujuan-basket-fixture.html', contentType: HTML },
      'https://www.jyeoo.com/__capture_smoke__/basket': { file: 'live/jyeoo-basket-20260906.html', contentType: HTML },
      'https://zujuan.xkw.com/13q987654.html': { file: 'zujuan-detail-13q987654.html', contentType: HTML },
      'https://zujuan.xkw.com/13q123456.html': { file: 'zujuan-detail-13q123456.html', contentType: HTML },
      'https://zujuan.xkw.com/13q555555.html': { file: 'zujuan-detail-13q555555.html', contentType: HTML },
      // 0006 P4：整卷下载（PC 详情页 SSR + mzujuan 批量 API；移动窗 UA 覆盖由 host 负责，协议层不感知 UA）
      'https://zujuan.xkw.com/4p2338916.html': { file: '0006-p4-zujuan-paper-4p2338916.html', contentType: HTML },
      'https://mzujuan.xkw.com': { file: '0006-p4-mzujuan-page.html', contentType: HTML },
      'https://mzujuan.xkw.com/server_api/ques/ids/4': { file: '0006-p4-zujuan-paper-api.json', contentType: JSON_TYPE },
      'https://imzujuan.xkw.com/getAnswerAndParse/smoke-987654.png': { file: 'pixel.png', contentType: PNG },
      'https://imzujuan.xkw.com/getAnswerAndParse/smoke-123456.png': { file: 'pixel.png', contentType: PNG },
      'https://imzujuan.xkw.com/getAnswerAndParse/smoke-555555.png': { file: 'pixel.png', contentType: PNG },
      'https://img.xkw.com/question/12345.png': { file: 'pixel.png', contentType: PNG },
      // jyeoo 真实快照配图（q1 放风筝图 / q3 轻绳图 / q4 竖直上抛图）
      'https://img.jyeoo.net/quiz/images/svg/202607/328/bf949583.png': { file: 'pixel.png', contentType: PNG },
      'https://img.jyeoo.net/quiz/images/svg/202308/372/0d5c28b1.png': { file: 'pixel.png', contentType: PNG },
      'https://img.jyeoo.net/quiz/images/202609/20/352237b0.png': { file: 'pixel.png', contentType: PNG },
    };

    host.session.protocol.handle('https', (req) => {
      const key = req.url.split('?')[0].replace(/\/$/, '');
      const route = routes[key];
      if (!route) {
        // 0006 P4：整卷题配图（题库 img.xkw.com CDN，URL 带 resizew 查询）统一回落像素图
        // 0006-P4-fix-1：答案解析区公式图的资源 CDN（staticzujuan.xkw.com，裸相对/src 绝对形态都落这里）
        // 同法回落——裸相对路径首次被冒烟真实走过（像素图是真 PNG，过 P2 内容校验）
        if (key.startsWith('https://img.xkw.com/') || key.startsWith('https://staticzujuan.xkw.com/quesimg/')) {
          return new Response(readFileSync(join(fixturesDir, 'pixel.png')), {
            status: 200,
            headers: { 'content-type': PNG },
          });
        }
        return new Response('capture-smoke: network blocked', { status: 418 });
      }
      return new Response(readFileSync(join(fixturesDir, route.file)), {
        status: 200,
        headers: { 'content-type': route.contentType },
      });
    });

    // driver 页：真实 preload → window.__mofangCapture（验证 preload 暴露 + IPC 全链）
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
    await driver.loadFile(join(fixturesDir, 'capture-driver.html'));

    const driverScript = `(async () => {
      const b = window.__mofangCapture;
      if (!b) throw new Error('window.__mofangCapture 未暴露');
      for (const m of ['openWindow', 'closeWindow', 'navigate', 'getState', 'extractBasket', 'collect', 'getLastExtraction']) {
        if (typeof b[m] !== 'function') throw new Error('__mofangCapture.' + m + ' 不是函数');
      }
      // 0012（只增）：内嵌 view 形态新通道在桥上（setBounds/onEvent/savePageHtml）
      for (const m of ['setBounds', 'onEvent', 'savePageHtml']) {
        if (typeof b[m] !== 'function') throw new Error('__mofangCapture.' + m + ' 不是函数');
      }

      // zujuan：开窗口（attach view，容器=driver 窗）→ bounds 上报 → 导航 → 状态 → 提篮 → 收篮（L-1 带用户选择学科）
      await b.openWindow();
      await b.setBounds({ x: 0, y: 48, width: 1200, height: 700 });
      await b.navigate({ url: 'https://zujuan.xkw.com/__capture_smoke__/basket' });
      const s1 = await b.getState();
      if (!s1.open) throw new Error('getState.open 应为 true');
      if (s1.site !== 'zujuan') throw new Error('getState.site 应为 zujuan，实际 ' + s1.site);

      const e1 = await b.extractBasket();
      if (e1.extracted.mode !== 'zujuan-basket') throw new Error('mode 应为 zujuan-basket，实际 ' + e1.extracted.mode);
      if (e1.extracted.captured.length !== 3) throw new Error('zujuan 提取应为 3 题，实际 ' + e1.extracted.captured.length);
      if (!e1.extracted.captured[0].questionId) throw new Error('zujuan questionId 为空');

      // L-2：控件条提取路径依赖 — 最近一次提取结果可经 getLastExtraction 拉取
      const le1 = await b.getLastExtraction();
      if (!le1.extracted || le1.extracted.captured.length !== 3) {
        throw new Error('getLastExtraction 应返回 3 题，实际 ' + JSON.stringify(le1 && le1.extracted && le1.extracted.captured.length));
      }

      const r1 = await b.collect({ extracted: e1.extracted, subject: '高中数学' });
      if (r1.failed.length > 0) throw new Error('zujuan collect 有失败: ' + JSON.stringify(r1.failed));
      if (r1.ok !== 3) throw new Error('zujuan collect ok 应为 3，实际 ' + JSON.stringify(r1));

      // jyeoo（D1-fix-3 真实快照锚定）：内容哈希 questionId + report token 中间键 + 篮内联答案
      await b.navigate({ url: 'https://www.jyeoo.com/__capture_smoke__/basket' });
      const s2 = await b.getState();
      if (s2.site !== 'jyeoo') throw new Error('getState.site 应为 jyeoo，实际 ' + s2.site);

      const e2 = await b.extractBasket();
      if (e2.extracted.captured.length !== 4) throw new Error('jyeoo 提取应为 4 题，实际 ' + e2.extracted.captured.length);
      if (!/^jh[0-9a-f]{16}$/.test(e2.extracted.captured[0].questionId)) {
        throw new Error('jyeoo questionId 应为内容哈希 jh+16hex，实际 ' + e2.extracted.captured[0].questionId);
      }
      if (e2.extracted.captured[0].meta.reportId !== '5SIRL6dZc4PfopyizaYHe899HJekvIgPzq4kSKQILKBaIuJ6g5AkSm') {
        throw new Error('jyeoo reportId 中间键错误: ' + JSON.stringify(e2.extracted.captured[0].meta));
      }
      if (e2.extracted.captured[0].meta.answerVia !== 'basket-inline') {
        throw new Error('jyeoo answerVia 应为 basket-inline: ' + e2.extracted.captured[0].meta.answerVia);
      }
      // 题干剥离：qseq 题号 + ques-source 来源链接（出处保留在 meta.source）
      if (e2.extracted.captured[0].stemHtml.includes('ques-source') || e2.extracted.captured[0].stemHtml.includes('新乡一模')) {
        throw new Error('jyeoo 题干未剥来源链接: ' + e2.extracted.captured[0].stemHtml.slice(0, 120));
      }
      if (e2.extracted.captured[0].meta.source !== '（2027•新乡一模）') {
        throw new Error('jyeoo meta.source 错误: ' + e2.extracted.captured[0].meta.source);
      }
      // 第 4 题解答题：无内联答案，answerVia 指向两跳（smoke 无报告页路由 → 补抓降级 warning，不串题）
      const q4 = e2.extracted.captured[3];
      if (q4.answerHtml !== '' || q4.meta.answerVia !== 'report-page-tid') {
        throw new Error('jyeoo 第 4 题（解答）应无内联答案且 answerVia=report-page-tid: ' + JSON.stringify(q4.meta));
      }

      const r2 = await b.collect({ extracted: e2.extracted });
      if (r2.failed.length > 0) throw new Error('jyeoo collect 有失败: ' + JSON.stringify(r2.failed));
      if (r2.ok !== 4) throw new Error('jyeoo collect ok 应为 4，实际 ' + JSON.stringify(r2));

      // 0012 P2（只增）：保存当前页 HTML（取证，主进程落盘 capture-html-snapshots/）
      const sv = await b.savePageHtml();
      if (!sv.ok || !sv.path) throw new Error('savePageHtml 应成功落盘: ' + JSON.stringify(sv));

      await b.closeWindow();
      const s3 = await b.getState();
      if (s3.open) throw new Error('closeWindow 后 getState.open 应为 false');

      return { zujuan: r1, jyeoo: r2, savedHtml: sv.path };
    })()`;

    const result = await driver.webContents.executeJavaScript(driverScript, true);

    // 主进程侧断言：图片资产真实落盘
    const assetsRoot = join(app.getPath('userData'), 'data', 'assets', 'capture');
    const zujuanDir = join(assetsRoot, 'zujuan');
    const jyeooDir = join(assetsRoot, 'jyeoo');
    if (!existsSync(zujuanDir)) throw new Error('zujuan 资产目录不存在: ' + zujuanDir);
    const zujuanFiles = readdirSync(zujuanDir);
    // 3 张答案图 + 1 张内容图（q2 配图）
    if (zujuanFiles.length !== 4) throw new Error('zujuan 资产应为 4 个文件，实际 ' + zujuanFiles.length + ': ' + zujuanFiles.join(','));
    if (!existsSync(jyeooDir) || readdirSync(jyeooDir).length !== 3) {
      throw new Error('jyeoo 资产应为 3 个文件（q1/q3/q4 配图），实际 ' + (existsSync(jyeooDir) ? readdirSync(jyeooDir).join(',') : '(目录不存在)'));
    }

    // 入库断言：7 题 network
    const questions = await bankService.listQuestions();
    const network = questions.filter((q) => q.sourceType === 'network');
    if (network.length !== 7) throw new Error('入库 network 题应为 7，实际 ' + network.length);
    const withAnswer = network.filter((q) => q.answer);
    // 6 题带答案；jyeoo 第 4 题（解答）无篮内联答案，两跳在 smoke 无报告页路由下降级，不入答案
    if (withAnswer.length !== 6) throw new Error('带答案题应为 6（jyeoo 解答题除外），实际 ' + withAnswer.length);
    // L-1：zujuan 题带用户选择学科「高中数学」→ subject 数学；jyeoo 题无选择 → meta.subject 'physics2' 站点行解析物理。
    // stage 断言已删（0006 顺修）：0002 拍板 B2 删 questions.stage 列（question-service 入参兼容保留、服务端忽略，
    // 识别信息并入树），q.stage 恒为 undefined——断言未跟进致 capture:smoke 红（Kimi 2026-09-09 根因实锤）。
    // 0006-fix-3 P3-3：subjectId 断言兑现——用户选择经 dict 归一行、站点原文经站点行解析，落 subj:{code}
    const zujuanQs = network.filter((q) => (q.sourceDetail as any)?.site === 'zujuan');
    if (!zujuanQs.every((q) => q.subject === '数学')) {
      throw new Error('zujuan 题 subject 应为 数学（stage 列已随 0002-B2 删除不再校验），实际 ' + JSON.stringify(zujuanQs.map((q) => [q.subject, q.stage])));
    }
    if (!zujuanQs.every((q) => q.subjectId === 'subj:math')) {
      throw new Error('zujuan 题 subjectId 应为 subj:math（用户选择「高中数学」→ dict 归一行 math），实际 ' + JSON.stringify(zujuanQs.map((q) => q.subjectId)));
    }
    const jyeooQs = network.filter((q) => (q.sourceDetail as any)?.site === 'jyeoo');
    if (!jyeooQs.every((q) => q.subject === '物理')) {
      throw new Error('jyeoo 题 subject 应为 物理（meta.subject physics2 站点行解析），实际 ' + JSON.stringify(jyeooQs.map((q) => q.subject)));
    }
    if (!jyeooQs.every((q) => q.subjectId === 'subj:physics')) {
      throw new Error('jyeoo 题 subjectId 应为 subj:physics（站点行 physics2→physics），实际 ' + JSON.stringify(jyeooQs.map((q) => q.subjectId)));
    }
    const withImages = network.filter((q) => q.images.length > 0);
    // 6 题带图：zujuan 3 题各有答案图（q2 另有内容图）、jyeoo q1/q3/q4 各有配图
    if (withImages.length !== 6) throw new Error('6 题应带图片，实际 ' + withImages.length);

    // ==================== 0006 P4：整卷下载（第二段，真 IPC + 真 SQLite） ====================
    // 清点口径与迁移工具同源：卷面题号（PC fixture）∩ 批量接口返回题号 = 可下载题；配图按 (src,role) 去重
    const paperHtmlText = readFileSync(join(fixturesDir, '0006-p4-zujuan-paper-4p2338916.html'), 'utf-8');
    const paperIds = [...paperHtmlText.matchAll(/questionid="(\d+)"/g)].map((m) => m[1]);
    const apiFixture = JSON.parse(readFileSync(join(fixturesDir, '0006-p4-zujuan-paper-api.json'), 'utf-8'));
    const onPaper = (apiFixture.data as any[]).filter((d) => paperIds.includes(String(d.id)));
    const expectedPaperImages = onPaper.reduce((total, d) => {
      const seen = new Set<string>();
      for (const m of String(d.quesBody ?? '').matchAll(/<img[^>]*src="([^"]+)"/g)) seen.add(`content|${m[1]}`);
      for (const m of `${d.quesAnswer ?? ''}${d.quesParse ?? ''}`.matchAll(/<img[^>]*src="([^"]+)"/g)) seen.add(`answer|${m[1]}`);
      return total + seen.size;
    }, 0);

    const paperScript = `(async () => {
      const b = window.__mofangCapture;
      const ext = window.__mofangBankExt;
      const bank = window.__mofangBank;
      for (const m of ['paperPreview', 'paperImport']) {
        if (typeof b[m] !== 'function') throw new Error('__mofangCapture.' + m + ' 不是函数');
      }
      const url = 'https://zujuan.xkw.com/4p2338916.html';

      // 预览：PC SSR 27 题号，批量 API 命中实卷题号 6 题（另 1 题为接口多返回，按卷面顺序忽略）
      // 0006-P4-fix-1：可下载集 5→6（23268476 补入卷面索引），total 26→27、missing 仍 21
      const pv = await b.paperPreview({ url });
      if (pv.total !== 27) throw new Error('paperPreview.total 应为 27（PC SSR），实际 ' + pv.total);
      if (pv.items.length !== 6) throw new Error('paperPreview.items 应为 6，实际 ' + pv.items.length);
      if (pv.missing.length !== 21) throw new Error('paperPreview.missing 应为 21，实际 ' + pv.missing.length);
      if (pv.title.indexOf('东华初级中学') < 0) throw new Error('卷名错误: ' + pv.title);
      if (pv.items[0].questionId !== '22724580' || pv.items[0].questionType !== '单选题') {
        throw new Error('首题预览字段错误: ' + JSON.stringify(pv.items[0]));
      }
      if (!pv.items[0].stemSummary) throw new Error('首题题干摘要为空');
      if (pv.items.some((i) => i.bankid !== '4')) throw new Error('预览题 bankid 应全为 4');
      if (!pv.warnings.some((w) => w.indexOf('未返回') >= 0)) throw new Error('缺少覆盖率缺口告警');

      const ids = pv.items.map((i) => i.questionId);
      // 去向一：散题入题库（首跑 ok=6）
      const r1 = await b.paperImport({ url, questionIds: ids, target: 'bank' });
      if (r1.ok !== 6 || r1.dup !== 0 || r1.failed.length !== 0) {
        throw new Error('散题入库结果异常: ' + JSON.stringify(r1));
      }
      // 去向二：成品卷（题已在库 → dup=6；卷挂题 → 快照 → done）
      const r2 = await b.paperImport({ url, questionIds: ids, target: 'paper' });
      if (!r2.paperId || r2.done !== true || r2.snapshotCount !== 6) {
        throw new Error('成品卷结果异常: ' + JSON.stringify(r2));
      }
      const paper = await ext.paper.getPaperEx({ id: r2.paperId });
      if (!paper || paper.status !== 'done') throw new Error('成品卷状态应为 done: ' + JSON.stringify(paper));
      const refs = await bank.getPaperQuestions({ paperId: r2.paperId });
      const positions = refs.map((r) => r.position);
      if (positions.join(',') !== '0,1,2,3,4,5') throw new Error('挂题 position 应连续 0..5，实际 ' + positions.join(','));
      // 挂题顺序 == 勾选（卷面）顺序：paper_questions 存本地题 id，按 sourceDetail.questionId 还站点题号比对
      const allQs = await bank.listQuestions({});
      const siteIdOf = new Map(allQs.map((q) => [q.id, q.sourceDetail && q.sourceDetail.questionId]));
      const refSiteIds = refs.map((r) => siteIdOf.get(r.questionId));
      if (refSiteIds.join(',') !== ids.join(',')) {
        throw new Error('挂题顺序应与勾选顺序一致: refs=' + refSiteIds.join(',') + ' ids=' + ids.join(','));
      }
      const snap = await ext.paper.listPaperSnapshotQuestions({ paperId: r2.paperId });
      if (snap.length !== 6) throw new Error('快照题数应为 6，实际 ' + snap.length);
      // 整卷题字段：答案/解析 + 溯源（bankid/卷 URL/来源卷 from）+ 学科（PC 侧栏 → dict 站点行归一）
      const paperQs = allQs.filter((q) => q.sourceDetail && ids.indexOf(q.sourceDetail.questionId) >= 0);
      if (paperQs.length !== 6) throw new Error('入库整卷题应为 6，实际 ' + paperQs.length);
      if (paperQs.some((q) => !q.answer)) throw new Error('整卷题应带答案（移动 API 全字段）');
      if (paperQs.some((q) => q.sourceDetail.bankid !== '4' || q.sourceDetail.url !== url)) {
        throw new Error('整卷题溯源（bankid/卷 URL）缺失');
      }
      if (paperQs.some((q) => !q.sourceDetail.paper || !q.sourceDetail.paper.from)) {
        throw new Error('来源卷 from 溯源缺失');
      }
      if (paperQs.some((q) => q.subject !== '物理')) throw new Error('整卷题学科应为 物理，实际 ' + JSON.stringify(paperQs.map((q) => q.subject)));

      // 0006-P4-fix-1：裸相对公式图题（23268476，解析区 8 个 img 标签 / 7 个去重 src）必须整条本地化——
      // 无 mzujuan 死链、无 .html WAF 资产引用，且本次导入 warnings 无 http-404/405
      const formulaQ = paperQs.filter((q) => q.sourceDetail.questionId === '23268476')[0];
      if (!formulaQ) throw new Error('裸相对公式图题 23268476 未入库');
      const analysisSrcs = [...String(formulaQ.analysis).matchAll(/<img[^>]*src="([^"]+)"/g)].map((m) => m[1]);
      if (analysisSrcs.length !== 8) throw new Error('23268476 解析区 img 应为 8 个（裸相对样本），实际 ' + analysisSrcs.length);
      if (!analysisSrcs.every((s) => s.indexOf('data-assets/capture/zujuan/23268476-') === 0)) {
        throw new Error('23268476 解析区仍有非本地化 src: ' + analysisSrcs.join(','));
      }
      if (String(formulaQ.analysis).indexOf('mzujuan.xkw.com') >= 0 || String(formulaQ.answer).indexOf('mzujuan.xkw.com') >= 0) {
        throw new Error('23268476 答案/解析仍含 mzujuan 死链');
      }
      if (/\.html/.test(String(formulaQ.analysis) + String(formulaQ.answer))) {
        throw new Error('23268476 答案/解析仍引用 .html 资产');
      }
      const formulaImages = formulaQ.images.map((img) => img.assetId);
      if (formulaImages.length !== 11 || !formulaImages.every((a) => a.indexOf('data-assets/capture/zujuan/23268476-') === 0)) {
        throw new Error('23268476 images 列应为 11 条本地资产: ' + JSON.stringify(formulaImages));
      }
      if (r1.warnings.some((w) => w.indexOf('http-404') >= 0 || w.indexOf('http-405') >= 0)) {
        throw new Error('本次导入出现 http-404/405: ' + r1.warnings.join(' | '));
      }

      return {
        preview: { total: pv.total, items: pv.items.length, missing: pv.missing.length },
        bank: r1,
        paper: { id: r2.paperId, done: r2.done, snapshot: r2.snapshotCount, positions: positions.join(',') },
      };
    })()`;

    const paper = await driver.webContents.executeJavaScript(paperScript, true);
    driver.close();

    // 0012 P2（只增）：savePageHtml 落盘主进程侧复核（driver 已关，文件须在）
    if (!result.savedHtml || !existsSync(result.savedHtml)) {
      throw new Error('savePageHtml 落盘文件缺失: ' + String(result.savedHtml));
    }
    const savedHtmlHead = readFileSync(result.savedHtml, 'utf-8').slice(0, 200);
    if (!savedHtmlHead.includes('<!DOCTYPE html>')) {
      throw new Error('savePageHtml 落盘内容异常（应为完整 HTML 文档）: ' + savedHtmlHead.slice(0, 80));
    }

    // 主进程侧：整卷题入库（7 + 6 = 13 network）、配图逐题落盘
    const questionsAfterPaper = await bankService.listQuestions();
    const networkAfter = questionsAfterPaper.filter((q) => q.sourceType === 'network');
    if (networkAfter.length !== 13) throw new Error('整卷导入后 network 题应为 13，实际 ' + networkAfter.length);
    const paperQuestions = networkAfter.filter((q) => paperIds.includes(String((q.sourceDetail as any)?.questionId)));
    if (paperQuestions.length !== 6) throw new Error('整卷题入库应为 6，实际 ' + paperQuestions.length);
    const paperWithImages = paperQuestions.filter((q) => q.content.includes('data-assets/capture/zujuan/'));
    const expectedPaperWithImages = onPaper.filter((d) => (String(d.quesBody ?? '').match(/<img/g) || []).length > 0).length;
    if (paperWithImages.length !== expectedPaperWithImages) {
      throw new Error(`整卷题本地化配图题数应为 ${expectedPaperWithImages}，实际 ${paperWithImages.length}`);
    }
    const zujuanFilesAfter = readdirSync(zujuanDir);
    if (zujuanFilesAfter.length !== 4 + expectedPaperImages) {
      throw new Error(`整卷题配图落盘应为 ${4 + expectedPaperImages} 个文件（4 篮内 + ${expectedPaperImages} 整卷），实际 ${zujuanFilesAfter.length}: ${zujuanFilesAfter.join(',')}`);
    }
    // P2 回归：WAF 挑战页不再被当图落盘（资产目录零 `.html`）
    const htmlAssets = zujuanFilesAfter.filter((f) => f.toLowerCase().endsWith('.html'));
    if (htmlAssets.length !== 0) {
      throw new Error(`资产目录不得出现非图片落盘（.html）: ${htmlAssets.join(',')}`);
    }

    console.log(`OK   capture-smoke（Electron）通过: zujuan ok=${result.zujuan.ok} jyeoo ok=${result.jyeoo.ok}，资产 zujuan=${zujuanFiles.length} jyeoo=3，入库 7 题（6 带答案，jyeoo 解答题待两跳；subjectId zujuan=subj:math jyeoo=subj:physics）`);
    console.log(`OK   0006-P4 整卷下载: 预览 ${paper.preview.total} 题号/可下载 ${paper.preview.items}（缺 ${paper.preview.missing}）→ 散题 ok=${paper.bank.ok} → 成品卷 done=${paper.paper.done} 快照 ${paper.paper.snapshot} position=${paper.paper.positions}；整卷配图 ${expectedPaperImages} 张落盘（含 23268476 裸相对公式图 7 张，零 mzujuan 死链/零 .html 资产）`);
    app.exit(0);
  } catch (err) {
    console.error('FAIL capture-smoke（Electron）失败:', err);
    app.exit(1);
  }
}
