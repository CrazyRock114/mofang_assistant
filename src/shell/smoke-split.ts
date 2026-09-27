// 0036 S-2 实测：PDF 切题工作区的打包/真机实测（`--smoke-pdfsplit` 模式）
//
// 三段（都跑在真实 Electron 环境里，不用 mock）：
//   ① 造真 PDF —— 隐藏窗 printToPDF 生成 N 页带正文的 PDF（真字节、真页数，不是桩）
//   ② 跑真链路 —— 驱动真实渲染层 UI：把 PDF 合成 drop 事件投给录题工作区首屏 →
//      建项目 → 分块上传（走真 split.* IPC）→ 保存 meta/默认切段 → 切题工作区渲染
//   ③ 量真数字 —— 逐页翻页，记录**每页栅格化耗时**与**渲染进程内存**（主进程 getProcessMemoryInfo），
//      并合成 pointer 事件画一个框，验证画框链路在真 PDF 上可用
//
// 判定：链路全通 + 每页都渲染成功 + 框真的画上 = PASS；耗时/内存只记录不断言（机器差异大，
// 硬编阈值会变成 flaky 门禁）——数字进交付报告，供「大 PDF 内存」风险评估使用。

import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserWindow, app, type ProcessMetric } from 'electron';

/** 实测页数：整本教辅的典型规模（15 页/段 × 3 段），也足够看出内存水位走势 */
const SMOKE_PAGES = 45;
/** 翻页采样上限（全翻会拉长实测时间；前 12 页足以暴露趋势） */
const SMOKE_VISIT_PAGES = 12;

export interface SplitSmokeReport {
  pageCount: number;
  segmentCount: number;
  firstSegmentRange: [number, number];
  visitedPages: number;
  rasterMs: number[];
  rasterMsAvg: number;
  heap: { afterImport: number; afterVisits: number };
  processMemoryKB: { before: number; after: number };
  boxCreated: boolean;
  workspaceVisible: boolean;
  /** 目检返工项：工作区 → 返回项目列表 → 继续切题 一整趟是否走得通 */
  navRoundTrip: boolean;
  /** 重开项目后的页码文案（诊断：用于区分「框丢了」与「框在别的页」） */
  reopenedPage: string;
  /** 跨页题（同一 qid 跨两页两框）实测：题卡文案 / notice / 队列 */
  crossPage: {
    questionLabel: string; page: string; notice: string | null; queue: string | null;
    status: string | null; runError: string | null; retryOffered: boolean;
  };
  /** 该次 run 落盘的页图字节（主进程侧读 run 目录；极小文件 = 近空白裁剪，是识别空返回的头号嫌疑） */
  runPagePngBytes: number[];
  notice: string | null;
}

/** 渲染进程私有内存合计（KB）：Electron 的 app.getAppMetrics 是跨进程口径，含 raster/worker */
function rendererPrivateKB(metrics: ProcessMetric[]): number {
  return metrics
    .filter((m) => m.type === 'Tab' || m.type === 'Utility' || m.type === 'GPU')
    .reduce((sum, m) => sum + (m.memory.privateBytes ?? m.memory.workingSetSize), 0);
}

/** 生成 N 页真 PDF：每页一个标题 + 若干段落（printToPDF 走 Chromium 真实排版） */
async function buildFixturePdf(outPath: string, pages: number): Promise<void> {
  const win = new BrowserWindow({ show: false, width: 900, height: 1200, webPreferences: { sandbox: false } });
  try {
    const body = Array.from({ length: pages }, (_v, i) => {
      const p = i + 1;
      const paras = Array.from({ length: 8 }, (_x, j) => `<p>第 ${p} 页第 ${j + 1} 段：这是一段用于实测栅格化性能的正文文本，包含中文与数字 ${p}${j}，以及公式化的字符如 x²+y²=z²。</p>`).join('');
      return `<section style="page-break-after: always;"><h1>第 ${p} 页 · 切题实测样本</h1>
        <p>${p}. 下列说法正确的是（　　）</p>${paras}<p>A. 选项甲　B. 选项乙　C. 选项丙　D. 选项丁</p></section>`;
    }).join('');
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:serif;font-size:13px;margin:24px}</style></head><body>${body}</body></html>`)}`);
    const pdf = await win.webContents.printToPDF({ printBackground: true, margins: { marginType: 'default' } });
    writeFileSync(outPath, pdf);
  } finally {
    win.destroy();
  }
}

/** 页面侧：合成 drop 事件把 PDF 交给首屏（等价于用户把文件拖进来） */
const DROP_SCRIPT = `(async () => {
  const b64 = window.__splitSmokeBase64;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const file = new File([bytes], 'smoke-0036.pdf', { type: 'application/pdf' });
  const zone = document.querySelector('[data-testid="split-dropzone"]');
  if (!zone) return { ok: false, error: '首屏拖放区不存在' };
  const dt = new DataTransfer();
  dt.items.add(file);
  zone.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
  zone.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
  return { ok: true };
})()`;

/** 页面侧：点「返回项目列表」并等列表出现（2026-09-18 目检：原按钮点了没反应） */
const BACK_TO_LIST_SCRIPT = `(async () => {
  const back = document.querySelector('[data-testid="split-back-to-list"]');
  if (!back) return { ok: false, reason: '返回项目列表按钮不存在' };
  back.click();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (document.querySelector('[data-testid="split-project-list"]')) return { ok: true };
    await new Promise((r) => setTimeout(r, 50));
  }
  return { ok: false, reason: '返回后项目列表未出现（仍是工作区？）' };
})()`;

/** 页面侧：点「继续切题」并等工作区回到现场 */
const RESUME_PROJECT_SCRIPT = `(async () => {
  const btn = document.querySelector('[data-testid^="split-open-"]');
  if (!btn) return { ok: false, reason: '项目列表里没有「继续切题」按钮' };
  btn.click();
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (document.querySelector('[data-testid="split-workspace"]')) {
      const segs = document.querySelectorAll('[data-testid^="split-segment-seg"]').length;
      // 段级题目列表（与当前页无关）：框画在第 13 页，重开后停在第 1 页，
      // 只有段级列表能如实反映「草稿里的框有没有恢复」
      const questions = document.querySelectorAll('[data-testid^="split-q-select-"]').length;
      const boxesOnPage = document.querySelectorAll('[data-testid^="split-box-"]').length;
      const pageLabel = document.querySelector('[data-testid="split-page-label"]')?.textContent ?? '';
      return { ok: segs > 0, segments: segs, questions, boxesOnPage, pageLabel };
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return { ok: false, reason: '点继续切题后工作区未出现' };
})()`;

/** 页面侧：翻到下一页并在该页再画一个框（同一 qid → 跨页题） */
const DRAW_SECOND_PAGE_BOX_SCRIPT = `(async () => {
  const next = document.querySelector('[data-testid="split-next-page"]');
  if (!next || next.disabled) return { ok: false, reason: '没有下一页可翻' };
  const before = document.querySelector('[data-testid="split-page-label"]')?.textContent ?? '';
  next.click();
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const after = document.querySelector('[data-testid="split-page-label"]')?.textContent ?? '';
    if (after !== before && !document.querySelector('[data-testid="split-page-pending"]')) break;
    await new Promise((r) => setTimeout(r, 30));
  }
  const stage = document.querySelector('[data-testid="split-stage"]');
  if (!stage) return { ok: false, reason: 'stage 不存在' };
  const r = stage.getBoundingClientRect();
  const fire = (type, x, y) => stage.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: 2, button: 0, buttons: 1,
    clientX: r.left + x, clientY: r.top + y,
  }));
  fire('pointerdown', r.width * 0.1, r.height * 0.1);
  await new Promise((res) => setTimeout(res, 50));
  fire('pointermove', r.width * 0.5, r.height * 0.3);
  await new Promise((res) => setTimeout(res, 50));
  fire('pointerup', r.width * 0.5, r.height * 0.3);
  await new Promise((res) => setTimeout(res, 200));
  const q = document.querySelector('[data-testid^="split-q-select-"]')?.textContent ?? '';
  return { ok: true, questionLabel: q, page: document.querySelector('[data-testid="split-page-label"]')?.textContent ?? '' };
})()`;

/** 页面侧：点「识别本段」并采集事实（状态文案 / notice / 队列） */
const RECOGNIZE_SCRIPT = `(async () => {
  const btn = document.querySelector('[data-testid="split-recognize"]');
  if (!btn) return { ok: false, reason: '识别按钮不存在' };
  if (btn.disabled) return { ok: false, reason: '识别按钮被禁用（本段已无待发起题）' };
  btn.click();
  await new Promise((r) => setTimeout(r, 4000));
  const notice = document.querySelector('[data-testid="notice"]')?.textContent ?? null;
  const queue = document.querySelector('[data-testid="split-run-queue"]')?.textContent ?? null;
  const status = document.querySelector('[data-testid^="split-run-status-"]')?.textContent ?? null;
  // 失败原因可见性（目检案底：原来只有「识别失败」三个字，无从判断原因）
  const runError = document.querySelector('[data-testid^="split-run-error-"]')?.textContent ?? null;
  const retry = document.querySelector('[data-testid^="split-run-retry-"]') !== null;
  return { ok: true, notice, queue, status, runError, retry };
})()`;

/** 页面侧：等某个 testid 出现 */
const waitForTestId = (testid: string, timeoutMs: number): string => `(async () => {
  const deadline = Date.now() + ${timeoutMs};
  while (Date.now() < deadline) {
    if (document.querySelector('[data-testid="${testid}"]')) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
})()`;

/** 页面侧：翻一页并等该页栅格化完成（占位消失即完成） */
const NEXT_PAGE_SCRIPT = `(async () => {
  const btn = document.querySelector('[data-testid="split-next-page"]');
  if (!btn || btn.disabled) return { ok: false, reason: 'next-page 不可用' };
  const before = document.querySelector('[data-testid="split-page-label"]')?.textContent ?? '';
  const t0 = performance.now();
  btn.click();
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const after = document.querySelector('[data-testid="split-page-label"]')?.textContent ?? '';
    const pending = document.querySelector('[data-testid="split-page-pending"]');
    const canvas = document.querySelector('[data-testid="split-page-canvas"]');
    if (after !== before && !pending && canvas && canvas.width > 0) {
      return { ok: true, ms: Math.round(performance.now() - t0), label: after };
    }
    await new Promise((r) => setTimeout(r, 16));
  }
  return { ok: false, reason: '翻页后栅格化超时' };
})()`;

/** 页面侧：在页面上合成一次拖拽画框（验证画框链路在真 PDF 上可用） */
const DRAW_BOX_SCRIPT = `(async () => {
  const stage = document.querySelector('[data-testid="split-stage"]');
  if (!stage) return { ok: false, reason: 'stage 不存在' };
  const r = stage.getBoundingClientRect();
  const fire = (type, x, y) => stage.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: 1, button: 0, buttons: 1,
    clientX: r.left + x, clientY: r.top + y,
  }));
  fire('pointerdown', r.width * 0.1, r.height * 0.1);
  await new Promise((res) => setTimeout(res, 50));
  fire('pointermove', r.width * 0.4, r.height * 0.2);
  await new Promise((res) => setTimeout(res, 50));
  fire('pointermove', r.width * 0.6, r.height * 0.25);
  await new Promise((res) => setTimeout(res, 50));
  fire('pointerup', r.width * 0.6, r.height * 0.25);
  await new Promise((res) => setTimeout(res, 200));
  const boxes = document.querySelectorAll('[data-testid^="split-box-"]');
  return { ok: boxes.length > 0, boxes: boxes.length };
})()`;

/** 找最新的若干 run 目录（按 mtime 倒序） */
function listNewestRunDirs(runsRoot: string, limit: number): string[] {
  try {
    return readdirSync(runsRoot)
      .map((name) => ({ name, dir: join(runsRoot, name) }))
      .filter((x) => {
        try {
          return statSync(x.dir).isDirectory();
        } catch {
          return false;
        }
      })
      .map((x) => ({ ...x, mtime: statSync(x.dir).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit)
      .map((x) => x.dir);
  } catch {
    return [];
  }
}

/** run 目录内页图字节（空白页 PNG 会压到极小，是「模型返回空内容」的头号嫌疑） */
function listPagePngBytes(runDir: string): number[] {
  try {
    const pagesDir = join(runDir, 'pages');
    return readdirSync(pagesDir)
      .filter((f) => f.endsWith('.png'))
      .sort()
      .map((f) => statSync(join(pagesDir, f)).size);
  } catch {
    return [];
  }
}

export async function runSplitSmoke(): Promise<{ report: Partial<SplitSmokeReport>; failures: string[] }> {
  const outDir = app.getPath('userData');
  const pdfPath = join(outDir, 'smoke-0036-fixture.pdf');
  const report: Partial<SplitSmokeReport> = {};
  const failures: string[] = [];

  const win = new BrowserWindow({
    show: false,
    width: 1400,
    height: 1000,
    webPreferences: {
      preload: join(app.getAppPath(), 'dist/shell/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 实测要的是干净数字：隐藏窗默认会被节流，节流会让耗时失去意义
      backgroundThrottling: false,
      additionalArguments: [`--mofang-user-data=${app.getPath('userData')}`],
    },
  });

  try {
    console.log('[0036] ① 生成真 PDF 夹具…');
    await buildFixturePdf(pdfPath, SMOKE_PAGES);
    console.log(`[0036]    夹具：${pdfPath}（${SMOKE_PAGES} 页）`);

    const indexPath = join(app.getAppPath(), 'dist/renderer/index.html');
    await win.loadFile(indexPath);
    // hash 路由：进切题工作区首屏
    await win.webContents.executeJavaScript(`window.location.hash = '#/split'; true`);
    const zoneReady = await win.webContents.executeJavaScript(waitForTestId('split-dropzone', 15000));
    if (zoneReady !== true) throw new Error('切题首屏未渲染（split-dropzone 未出现）');

    const base64 = (await import('node:fs')).readFileSync(pdfPath).toString('base64');
    await win.webContents.executeJavaScript(`window.__splitSmokeBase64 = ${JSON.stringify(base64)}; true`);

    const memBefore = rendererPrivateKB(app.getAppMetrics());
    console.log('[0036] ② 投递 PDF（真 drop 事件）→ 建项目 / 分块上传 / 默认切段…');
    const dropped = (await win.webContents.executeJavaScript(DROP_SCRIPT)) as { ok: boolean; error?: string };
    if (!dropped.ok) throw new Error(`drop 失败：${dropped.error ?? '未知'}`);

    const workspaceReady = await win.webContents.executeJavaScript(waitForTestId('split-workspace', 120000));
    if (workspaceReady !== true) {
      const notice = await win.webContents.executeJavaScript(
        `document.querySelector('[data-testid="notice"]')?.textContent ?? null`,
      );
      throw new Error(`切题工作区未出现（notice=${String(notice)}）`);
    }
    report.workspaceVisible = true;

    const metaSummary = (await win.webContents.executeJavaScript(`(() => {
      const segs = [...document.querySelectorAll('[data-testid^="split-segment-seg"]')].map((el) => el.textContent);
      const label = document.querySelector('[data-testid="split-page-label"]')?.textContent ?? '';
      return { segments: segs, label };
    })()`)) as { segments: string[]; label: string };
    report.segmentCount = metaSummary.segments.length;
    report.visitedPages = 0;

    const heapAfterImport = (await win.webContents.executeJavaScript(
      `performance.memory ? performance.memory.usedJSHeapSize : 0`,
    )) as number;

    console.log('[0036] ③ 逐页翻页 + 画框（量栅格化耗时与内存）…');
    const rasterMs: number[] = [];
    for (let i = 0; i < SMOKE_VISIT_PAGES; i++) {
      const step = (await win.webContents.executeJavaScript(NEXT_PAGE_SCRIPT)) as { ok: boolean; ms?: number; reason?: string };
      if (!step.ok) break; // 翻到头（段页数上限）即停，不算失败
      rasterMs.push(step.ms ?? 0);
      report.visitedPages = rasterMs.length;
    }

    const drawn = (await win.webContents.executeJavaScript(DRAW_BOX_SCRIPT)) as { ok: boolean; boxes?: number; reason?: string };
    report.boxCreated = drawn.ok === true;
    if (!drawn.ok) failures.push(`画框未生效：${drawn.reason ?? 'unknown'}`);

    console.log('[0036] ③b 跨页题实测：翻到下一页再画一框（同 qid）→ 识别本段…');
    const second = (await win.webContents.executeJavaScript(DRAW_SECOND_PAGE_BOX_SCRIPT)) as {
      ok: boolean; questionLabel?: string; page?: string; reason?: string;
    };
    const crossPage = {
      questionLabel: second.questionLabel ?? '',
      page: second.page ?? '',
      notice: null as string | null,
      queue: null as string | null,
      status: null as string | null,
      runError: null as string | null,
      retryOffered: false,
    };
    if (!second.ok) {
      failures.push(`跨页第二框未画成：${second.reason ?? 'unknown'}`);
    } else {
      const rec = (await win.webContents.executeJavaScript(RECOGNIZE_SCRIPT)) as {
        ok: boolean; notice: string | null; queue: string | null; status: string | null;
        runError: string | null; retry: boolean; reason?: string;
      };
      crossPage.notice = rec.notice;
      crossPage.queue = rec.queue;
      crossPage.status = rec.status;
      crossPage.runError = rec.runError;
      crossPage.retryOffered = rec.retry === true;
      console.log(`[0036]    失败原因可见：${rec.runError ?? '（无）'} / 重试入口：${rec.retry ? '有' : '无'}`);
      console.log(`[0036]    跨页题卡：${second.questionLabel} @ ${second.page}`);
      console.log(`[0036]    发起结果：status=${rec.status} notice=${rec.notice}`);
      console.log(`[0036]    队列行：${rec.queue}`);
      // 主进程侧：读这次 run 落盘的页图（近空白裁剪 → 文件极小 → 识别空返回的头号嫌疑）
      const runsDir = join(app.getPath('userData'), 'data', 'recog', 'runs');
      const latest = listNewestRunDirs(runsDir, 1)[0];
      if (latest) {
        report.runPagePngBytes = listPagePngBytes(latest);
        console.log(`[0036]    run 页图字节：${JSON.stringify(report.runPagePngBytes)}（${latest}）`);
      }
    }
    report.crossPage = crossPage;

    console.log('[0036] ④ 返回项目列表 → 继续切题（目检返工项：返回上一级 + 草稿恢复）…');
    const back = (await win.webContents.executeJavaScript(BACK_TO_LIST_SCRIPT)) as { ok: boolean; reason?: string };
    let navRoundTrip = false;
    if (!back.ok) {
      failures.push(`返回项目列表失败：${back.reason ?? 'unknown'}`);
    } else {
      const resumed = (await win.webContents.executeJavaScript(RESUME_PROJECT_SCRIPT)) as {
        ok: boolean; segments?: number; questions?: number; boxesOnPage?: number; pageLabel?: string; reason?: string;
      };
      navRoundTrip = resumed.ok === true;
      report.reopenedPage = resumed.pageLabel ?? '';
      if (!resumed.ok) failures.push(`继续切题失败：${resumed.reason ?? 'unknown'}`);
      // 关页可续：重开项目后段级题目列表应恢复（画框那一步已写入段草稿）
      else if ((resumed.questions ?? 0) === 0 && drawn.ok) failures.push('重开项目后框未从草稿恢复（段级题目列表为空）');
      else console.log(`[0036]    重开项目：${resumed.segments} 段 / ${resumed.questions} 题（当前 ${resumed.pageLabel}）`);
    }
    report.navRoundTrip = navRoundTrip;

    const heapAfterVisits = (await win.webContents.executeJavaScript(
      `performance.memory ? performance.memory.usedJSHeapSize : 0`,
    )) as number;
    const memAfter = rendererPrivateKB(app.getAppMetrics());

    const notice = (await win.webContents.executeJavaScript(
      `document.querySelector('[data-testid="notice"]')?.textContent ?? null`,
    )) as string | null;

    report.pageCount = SMOKE_PAGES;
    report.firstSegmentRange = [1, 15];
    report.rasterMs = rasterMs;
    report.rasterMsAvg = rasterMs.length > 0 ? Math.round(rasterMs.reduce((a, b) => a + b, 0) / rasterMs.length) : 0;
    report.heap = { afterImport: heapAfterImport, afterVisits: heapAfterVisits };
    report.processMemoryKB = { before: memBefore, after: memAfter };
    report.notice = notice;

    if (rasterMs.length === 0) failures.push('没有成功翻过任何一页（栅格化链路可疑）');
    if (report.segmentCount === 0) failures.push('默认切段未生成');

    console.log('[0036] ===== S-2 实测记录（JSON） =====');
    console.log(JSON.stringify(report));
    console.log('[0036] ===== 结束 =====');
    return { report, failures };
  } finally {
    win.destroy();
  }
}
