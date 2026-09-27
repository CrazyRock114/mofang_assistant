// Phase 3: IPC handlers — 注册所有 bank 通道 + PDF 导出

import { ipcMain, BrowserWindow, dialog } from 'electron';
// 0072（只增）：update.openExternal 外链出口（单列一行——既有 electron import 行零改动）
import { shell } from 'electron';
import { IPC_CHANNELS } from '../shared/contracts/ipc-channels.js';
import type { BankService, BankExtServices } from '../shared/contracts/bank-types.js';
// 0057（只增）：题内图片语义类型四枚举（形验用；类型单源 bank-types.QuestionImageType）
import type { QuestionImageType } from '../shared/contracts/bank-types.js';
import type { FeedbackExportCardsResult } from '../shared/contracts/ipc-channels.js';
import type { FileSaveRecogImagePayload } from '../shared/contracts/ipc-channels.js';
// 0061（只增）：废图清理（两通道 + 类型；只读库面/移动全在 cleaner 模块，本文件只做接线与形验转发）
import type { FileTrashRecogAssetsPayload } from '../shared/contracts/ipc-channels.js';
import { scanRecogAssetGarbage, trashRecogAssets } from './recog-asset-cleaner.js';
import type { OperationLogLike, RecogAssetCleanerDeps, RecogAssetCleanerServices } from './recog-asset-cleaner.js';
// 0066（只增）：可运维性一期——诊断包返回类型（通道返回面单源 ipc-channels.DiagExportResult）
import type { DiagExportResult } from '../shared/contracts/ipc-channels.js';
// 0066（只增）：诊断包组装 + 日志（本文件只做弹窗/台账/接线；包内容构成与脱敏在 shell/diag）
import { buildDiagnosticsPackage, type DiagnosticTableCount } from './diag/diagnostics-package.js';
import { diagLog } from './diag/logger.js';
// 0071（只增）：自定义数据保存位置（引导配置读写/校验/迁移逻辑在 shell/data-location，本文件只做弹窗与接线）
import {
  cancelDataLocationChange,
  changeDataLocation,
  describeDataLocation,
  type DataLocationRuntime,
} from './data-location.js';
import type {
  DataLocationCancelResult,
  DataLocationChangePayload,
  DataLocationChangeResult,
  DataLocationInfo,
  DataLocationSource,
} from '../shared/contracts/ipc-channels.js';
// 0072（只增）：公告与版本更新通道返回类型（服务与回落链在 shell/announce、shell/update，本文件只做转发）
import type { AnnounceSnapshot, UpdateStatus, UpdateOpenExternalResult } from '../shared/contracts/ipc-channels.js';
// 0057（只增）：录题图资产落盘唯一实现（本文件的 file.saveRecogImage handler 与启动期 backfill 共用）
import { saveRecogImageDataUrl } from './recog-image-store.js';
import type { CaptureHost } from '../capture/browser/host.js';
import { join } from 'node:path';
import { writeFileSync, unlinkSync, mkdirSync, copyFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { rewriteKatexFontUrls } from '../docgen/render/buildPaperHtml.js';
import type { ExportPdfPaginateConfig, ExportDocxResult, ExportDocxStats } from '../shared/contracts/bridge.js';
// 0035（只增）：Word(DOCX) 导出（计划层 + 组装器 + 公式栅格）
import { buildDocxBuffer } from '../docgen/export/docx/index.js';
import { rasterizeMath } from '../docgen/export/docx/rasterize.js';
// 0035 修复批（只增）：SVG 资产栅格（隐藏窗渲染 → PNG；nativeImage 不支持 SVG）
import { rasterizeSvgAssets } from '../docgen/export/docx/svg-raster.js';
// 0023（只增）：ai.* 模型配置体系（网关 + payload + 五角色枚举）
import type { AiGateway } from './ai/ai-gateway.js';
import type {
  AiProfileCreatePayload, AiProfileUpdatePayload, AiProfileIdPayload,
  AiProfileSetEnabledPayload, AiProfileTestConnectionPayload, AiInvokePayload,
  AiModelsListPayload,
} from '../shared/contracts/ai-types.js';
import { MODEL_ROLES } from '../shared/contracts/ai-types.js';
// 0028（只增）：recog.run.* 识别 run 任务化（宿主 + payload）
import type { RecogHost } from './recog/recog-host.js';
import type {
  RecogRunCreatePayload, RecogRunHistoryPayload, RecogRunAttachQuestionsPayload, RecogRunIdPayload,
  RecogDraftWritePayload,
} from '../shared/contracts/recog-run-types.js';
// 0040（只增）：工作台文件态 payload（类型单源 onestep-types.ts）
import type { RecogWorkbenchSavePayload } from '../shared/contracts/onestep-types.js';
// 0036（只增）：切题工作区宿主与契约类型（split.* 通道接线用）
import type { SplitHost } from './splitting/split-host.js';
import type { SplitDraft, SplitSegment } from '../shared/contracts/split-types.js';
// 0029（只增）：AI 挂树/打标建议（宿主 + payload）
import type { AiSuggestHost } from './ai/suggest-host.js';
import type { AiAnchorStatusPayload, AiSuggestPayload } from '../shared/contracts/ai-suggest-types.js';
// 0044（只增）：存为试卷编排（主进程一步编排；服务在 bank 层，shell 注入 db 事务边界 + service getter）
import { SaveAsPaperService, type SaveAsPaperDeps } from '../bank/save-as-paper-service.js';
import { getHomeDashboard } from '../bank/dashboard-service.js';
import type { RecogSaveAsPaperPayload } from '../shared/contracts/ipc-channels.js';
import type { Database } from '../bank/db.js';
// 0056（只增）：采集题 AI 整理（编排在 question-ai-clean.ts；本文件只做接线与形验转发）
import { QUESTION_AI_CLEAN_MODES } from '../shared/contracts/ipc-channels.js';
import {
  commitQuestionAiClean,
  previewQuestionAiClean,
  type AiCleanLogger,
  type AiCleanQuestionLike,
} from './question-ai-clean.js';
import type { AiCleanImagePreparer } from './ai-clean-image-prep.js';
import type {
  AiInvokePayload as AiInvokePayloadType,
  AiInvokeResult as AiInvokeResultType,
  ModelRole as ModelRoleType,
} from '../shared/contracts/ai-types.js';

/**
 * 0007 P2（拍板①②③）：导出隐藏窗页化——预览=PDF 同构核心。
 * 在已 loadFile 的窗口里：等字体/图片就绪 → 注入与预览同源的运行时文本
 * （dist/app/preview-frame-runtime.iife.js，装箱规则单源=paginate.ts；CFG.deferSetup）
 * → 手动 setup → 读回 sheet/溢出统计。main.ts 的 smoke:pdf 对拍探针复用本函数。
 */
export async function paginatePdfWindow(
  webContents: Electron.WebContents,
  paginate: ExportPdfPaginateConfig,
): Promise<{ sheets: number; overflow: number }> {
  const runtimePath = join(__dirname, '../app/preview-frame-runtime.iife.js');
  let runtimeText: string;
  try {
    runtimeText = readFileSync(runtimePath, 'utf-8');
  } catch {
    throw new Error(`页化导出运行时缺失（${runtimePath}）——请先执行 npm run build`);
  }
  const cfg = JSON.stringify({
    assetsRoot: null,
    pageWmm: paginate.pageWmm,
    pageHmm: paginate.pageHmm,
    questionIds: [],
    foreignAssets: {},
    columns: paginate.columns ?? 1,
    columnGapMm: paginate.columnGapMm ?? 0,
    paginate: true,
    interactive: false,
    answerSpaces: {},
    selectedQuestionId: null,
    textBlocks: {},
    deferSetup: true,
  });
  // 与 injectPreviewScript 同手法：函数式替换防 $ 序列展开；打包文本已含 IIFE
  const script = runtimeText.replace(/(["'])__CFG__\1/, () => cfg);
  // 就绪等待：字体/个别图片解码失败静默（资产缺失不阻塞导出，测量以实际渲染为准）
  await webContents.executeJavaScript(
    `(async () => {
      try { await document.fonts.ready; } catch (e) { /* 静默 */ }
      var imgs = Array.prototype.slice.call(document.images || []);
      await Promise.all(imgs.map(function (img) {
        if (img.complete) return Promise.resolve();
        return (img.decode ? img.decode() : Promise.resolve()).catch(function () { /* 静默 */ });
      }));
      return true;
    })()`,
  );
  const statsJson: string = await webContents.executeJavaScript(
    `${script}\nwindow.__mofangPaginate.setup();\nJSON.stringify({ sheets: document.documentElement.getAttribute('data-mf-sheets'), overflow: document.documentElement.getAttribute('data-mf-overflow') })`,
  );
  const stats = JSON.parse(statsJson) as { sheets: string | null; overflow: string | null };
  return { sheets: Number(stats.sheets ?? 0), overflow: Number(stats.overflow ?? 0) };
}

/** 0007 P2：payload.paginate 白名单校验（0007 P5 起必填——旧 footerTemplate 导出路径已退役，
 *  缺页化参数即拒（不静默降级到无页化打印：那会产出与预览不一致的 PDF）。 */
function requirePaginateConfig(raw: unknown): ExportPdfPaginateConfig {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid paginate（0007 P5 起导出必带页化参数）');
  const p = raw as ExportPdfPaginateConfig;
  if (typeof p.pageWmm !== 'number' || !(p.pageWmm > 0)) throw new Error('Invalid paginate.pageWmm');
  if (typeof p.pageHmm !== 'number' || !(p.pageHmm > 0)) throw new Error('Invalid paginate.pageHmm');
  if (p.columns !== undefined && p.columns !== 1 && p.columns !== 2) throw new Error('Invalid paginate.columns');
  if (p.columnGapMm !== undefined && (typeof p.columnGapMm !== 'number' || p.columnGapMm < 0)) {
    throw new Error('Invalid paginate.columnGapMm');
  }
  return { pageWmm: p.pageWmm, pageHmm: p.pageHmm, columns: p.columns ?? 1, columnGapMm: p.columnGapMm ?? 0 };
}

/**
 * 0057（只增）：题内图片语义类型四枚举（saveAsPaper images 逐条形验用；类型单源 bank-types.QuestionImageType）
 */
const QUESTION_IMAGE_TYPES: readonly QuestionImageType[] = ['figure', 'formula-image', 'answer-image', 'analysis-image'];

/**
 * P0-2：bank.* 通道 handler 改为 getter 闭包——每次调用取当前 service 实例。
 * 恢复后 reloadDatabase() 重建 bankService，handler 自动指向新实例（无需重复注册，避免 ipcMain.handle 二次注册抛错）。
 */
export function registerIpcHandlers(
  getBankService: () => BankService,
  /** 0035（只增）：DOCX 导出需要 data 目录（data-assets 资产根）；smoke 分支不经对话框走固定路径 */
  opts?: { dataDir?: string; smoke?: { docxExportPath?: string } }
) {
  // Question operations
  ipcMain.handle(IPC_CHANNELS.QUESTION_CREATE, async (_event, payload) => {
    if (!payload || typeof payload !== 'object') throw new Error('Invalid payload');
    return getBankService().createQuestion(payload.data);
  });

  ipcMain.handle(IPC_CHANNELS.QUESTION_GET, async (_event, payload) => {
    if (!payload || typeof payload.id !== 'string') throw new Error('Invalid id');
    return getBankService().getQuestion(payload.id);
  });

  ipcMain.handle(IPC_CHANNELS.QUESTION_LIST, async (_event, payload) => {
    return getBankService().listQuestions(payload?.filter);
  });

  ipcMain.handle(IPC_CHANNELS.QUESTION_UPDATE, async (_event, payload) => {
    if (!payload || typeof payload.id !== 'string') throw new Error('Invalid id');
    return getBankService().updateQuestion(payload.id, payload.data);
  });

  ipcMain.handle(IPC_CHANNELS.QUESTION_DELETE, async (_event, payload) => {
    if (!payload || typeof payload.id !== 'string') throw new Error('Invalid id');
    return getBankService().deleteQuestion(payload.id);
  });

  ipcMain.handle(IPC_CHANNELS.QUESTION_ADD_TAG, async (_event, payload) => {
    if (!payload || typeof payload.questionId !== 'string' || typeof payload.tag !== 'string') {
      throw new Error('Invalid payload');
    }
    return getBankService().addTag(payload.questionId, payload.tag, payload.color);
  });

  ipcMain.handle(IPC_CHANNELS.QUESTION_REMOVE_TAG, async (_event, payload) => {
    if (!payload || typeof payload.questionId !== 'string' || typeof payload.tag !== 'string') {
      throw new Error('Invalid payload');
    }
    return getBankService().removeTag(payload.questionId, payload.tag);
  });

  // Paper operations
  ipcMain.handle(IPC_CHANNELS.PAPER_CREATE, async (_event, payload) => {
    if (!payload || typeof payload.title !== 'string') throw new Error('Invalid title');
    return getBankService().createPaper(payload.title, payload.config);
  });

  ipcMain.handle(IPC_CHANNELS.PAPER_GET, async (_event, payload) => {
    if (!payload || typeof payload.id !== 'string') throw new Error('Invalid id');
    return getBankService().getPaper(payload.id);
  });

  ipcMain.handle(IPC_CHANNELS.PAPER_LIST, async () => {
    return getBankService().listPapers();
  });

  ipcMain.handle(IPC_CHANNELS.PAPER_ADD_QUESTION, async (_event, payload) => {
    if (!payload || typeof payload.paperId !== 'string' || typeof payload.questionId !== 'string') {
      throw new Error('Invalid payload');
    }
    // fix-4 2.3：textBlock 直通（文本内容块插入/更新；复用本通道）
    return getBankService().addQuestion(payload.paperId, payload.questionId, payload.score, undefined, payload.textBlock);
  });

  ipcMain.handle(IPC_CHANNELS.PAPER_REMOVE_QUESTION, async (_event, payload) => {
    if (!payload || typeof payload.paperId !== 'string' || typeof payload.questionId !== 'string') {
      throw new Error('Invalid payload');
    }
    return getBankService().removeQuestion(payload.paperId, payload.questionId);
  });

  ipcMain.handle(IPC_CHANNELS.PAPER_REORDER_QUESTIONS, async (_event, payload) => {
    if (!payload || typeof payload.paperId !== 'string' || !Array.isArray(payload.questionIds)) {
      throw new Error('Invalid payload');
    }
    return getBankService().reorderQuestions(payload.paperId, payload.questionIds);
  });

  ipcMain.handle(IPC_CHANNELS.PAPER_GET_QUESTIONS, async (_event, payload) => {
    if (!payload || typeof payload.paperId !== 'string') throw new Error('Invalid paperId');
    return getBankService().getPaperQuestions(payload.paperId);
  });

  ipcMain.handle(IPC_CHANNELS.PAPER_SET_SCORE, async (_event, payload) => {
    // 0018 目检返工三：score 允许缺省（undefined = 清除分值回未设置），但传入时必须是 number
    if (!payload || typeof payload.paperId !== 'string' || typeof payload.questionId !== 'string' || (payload.score !== undefined && typeof payload.score !== 'number')) {
      throw new Error('Invalid payload');
    }
    return getBankService().setQuestionScore(payload.paperId, payload.questionId, payload.score);
  });

  // PDF export
  ipcMain.handle('doc.exportPdf', async (_event, payload) => {
    if (!payload || typeof payload.html !== 'string' || typeof payload.suggestedName !== 'string') {
      throw new Error('Invalid payload');
    }
    // 0004（乙路 Phase 4）：可选 pageSize 白名单校验（A3/A4），缺省 A4 语义不变
    if (payload.pageSize !== undefined && payload.pageSize !== 'A3' && payload.pageSize !== 'A4') {
      throw new Error('Invalid pageSize');
    }
    // 0004-fix-2 F2-A：可选 landscape 白名单校验（横版出纸）
    if (payload.landscape !== undefined && typeof payload.landscape !== 'boolean') {
      throw new Error('Invalid landscape');
    }
    // 0007 P5：paginate 必填（旧 footerTemplate 导出路径已退役——页化链路已全量覆盖导出）
    const paginate = requirePaginateConfig(payload.paginate);

    // Q-1 修复：改写 browser 入口的相对字体路径为绝对路径
    let { html } = payload;
    const { suggestedName } = payload;
    html = rewriteKatexFontUrls(html);

    // 创建临时 HTML 文件
    const tmpDir = join(tmpdir(), 'mofang-pdf');
    mkdirSync(tmpDir, { recursive: true });
    const tmpHtmlPath = join(tmpDir, `${Date.now()}.html`);
    writeFileSync(tmpHtmlPath, html, 'utf-8');

    try {
      // 创建隐藏窗口加载 HTML
      // 0007 P4：页化导出视口归一——纸宽超缺省视口（800px）时 .paper 被钳窄，
      // 超页高预判/非探针测量失真（A3 横版 420mm ≈ 1587px）；宽=纸宽 px + 余量
      const pdfWindow = new BrowserWindow({
        show: false,
        width: Math.ceil((paginate.pageWmm * 96) / 25.4) + 80,
        height: 1200,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
        },
      });

      await pdfWindow.loadFile(tmpHtmlPath);

      // 0007 P2/P5：页化导出唯一路径——字体/图片就绪后注入预览同源运行时写回 sheet DOM，
      // printToPDF 用零边距 + 无 header/footer（@page margin:0 由运行时注入；P0 探针①实证
      // @page margin 恒胜 margins 参数，旧 margins 硬编码与 footerTemplate 均为死代码，已退役）。
      const pagination = await paginatePdfWindow(pdfWindow.webContents, paginate);

      // 生成 PDF（0004：pageSize 由 payload 驱动，缺省 A4；fix-2 F2-A：landscape 横版出纸）
      const pdfData = await pdfWindow.webContents.printToPDF({
        printBackground: true,
        pageSize: payload.pageSize ?? 'A4',
        ...(payload.landscape ? { landscape: true } : {}),
        displayHeaderFooter: false,
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
      });

      pdfWindow.close();

      // 保存对话框
      const { filePath, canceled } = await dialog.showSaveDialog({
        defaultPath: suggestedName,
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });

      if (!canceled && filePath) {
        writeFileSync(filePath, pdfData);
        return { filePath, pagination };
      }

      return { filePath: null };
    } finally {
      // 清理临时文件
      try {
        unlinkSync(tmpHtmlPath);
      } catch {
        // 忽略清理失败
      }
    }
  });

  // 0035：Word(DOCX) 导出——结构化数据直接组装（不走 HTML→DOM；公式=图片，D-051）。
  // 管线：buildDocxPlan（纯函数）→ KaTeX 隐藏窗栅格 PNG → assembleDocx → 保存对话框。
  // 统计（公式栅格/缺图/降级）如实回传，UI 与探针看得到缺口（不静默吞内容）。
  ipcMain.handle(IPC_CHANNELS.DOC_EXPORT_DOCX, async (_event, payload): Promise<ExportDocxResult> => {
    if (!payload || typeof payload !== 'object') throw new Error('Invalid payload');
    if (typeof payload.suggestedName !== 'string' || payload.suggestedName === '') throw new Error('Invalid suggestedName');
    if (payload.mode !== 'student' && payload.mode !== 'teacher') throw new Error('Invalid mode');
    if (!payload.paper || typeof payload.paper !== 'object' || typeof payload.paper.id !== 'string') throw new Error('Invalid paper');
    if (!Array.isArray(payload.questions)) throw new Error('Invalid questions');

    const assetsRoot = opts?.dataDir ? join(opts.dataDir, 'assets') : null;
    const result = await buildDocxBuffer(
      {
        paper: payload.paper,
        questions: payload.questions,
        mode: payload.mode,
        options: {
          ...(payload.layoutConfig ? { layoutConfig: payload.layoutConfig } : {}),
          ...(payload.questionLayouts ? { questionLayouts: payload.questionLayouts } : {}),
          ...(payload.textBlocks ? { textBlocks: payload.textBlocks } : {}),
          ...(payload.scores ? { scores: payload.scores } : {}),
        },
      },
      {
        rasterize: rasterizeMath,
        // 0035 修复批：SVG 资产（采集站公式/符号图多为 SVG）渲染为 PNG 入卷，零新依赖
        rasterizeSvg: rasterizeSvgAssets,
        assetsRoot,
        onIssue: (issue) => console.warn(`[docx] 资源问题 ${issue.kind}: ${issue.detail}`),
      }
    );

    // 缺口显式入日志（清单外标签降级 / 公式栅格失败 / 缺图）
    if (result.degradations.length > 0) console.warn('[docx] 清单外标签降级:', JSON.stringify(result.degradations));
    if (result.math.failed.length > 0) console.warn('[docx] 公式栅格失败:', result.math.failed.join(' | '));
    if (result.images.missing.length > 0) console.warn('[docx] 图片缺失:', result.images.missing.join(' | '));

    const stats: ExportDocxStats = {
      mathTotal: result.math.total,
      mathRasterized: result.math.rasterized,
      mathFailed: result.math.failed.length,
      imagesTotal: result.images.total,
      imagesEmbedded: result.images.embedded,
      imagesMissing: result.images.missing.length,
      degradations: result.degradations.map((d) => ({ tag: d.tag, count: d.count })),
      issues: result.issues.map((issue) => `${issue.kind}: ${issue.detail}`),
    };

    const { filePath, canceled } = opts?.smoke?.docxExportPath
      ? { filePath: opts.smoke.docxExportPath, canceled: false }
      : await dialog.showSaveDialog({
          title: '导出 Word 试卷',
          defaultPath: payload.suggestedName,
          filters: [{ name: 'Word 文档', extensions: ['docx'] }],
        });

    if (canceled || !filePath) return { filePath: null, stats };
    writeFileSync(filePath, result.buffer);
    return { filePath, stats };
  });
}

/**
 * capture.* 六通道接线（D0-fix R-3 新增；既有 registerIpcHandlers 零改动）
 * P0-2：改为 getter 闭包，恢复后 captureHost 重建，handler 自动指向新实例。
 */
export function registerCaptureIpcHandlers(getCaptureHost: () => CaptureHost) {
  ipcMain.handle(IPC_CHANNELS.CAPTURE_OPEN_WINDOW, async () => {
    return getCaptureHost().openWindow();
  });

  ipcMain.handle(IPC_CHANNELS.CAPTURE_CLOSE_WINDOW, async () => {
    return getCaptureHost().closeWindow();
  });

  ipcMain.handle(IPC_CHANNELS.CAPTURE_NAVIGATE, async (_event, payload) => {
    if (!payload || typeof payload.url !== 'string') throw new Error('Invalid payload');
    // 0012 P2（只增）：via 缺省 'url'；白名单外值按 'url' 处理
    const via = payload.via === 'back' || payload.via === 'forward' || payload.via === 'reload' ? payload.via : 'url';
    return getCaptureHost().navigate(payload.url, via);
  });

  ipcMain.handle(IPC_CHANNELS.CAPTURE_GET_STATE, async () => {
    return getCaptureHost().getState();
  });

  ipcMain.handle(IPC_CHANNELS.CAPTURE_EXTRACT_BASKET, async () => {
    return getCaptureHost().extractBasket();
  });

  ipcMain.handle(IPC_CHANNELS.CAPTURE_COLLECT, async (_event, payload) => {
    if (!payload || typeof payload !== 'object' || !payload.extracted) throw new Error('Invalid payload');
    // L-1：subject 可选；非法类型按缺省处理（回落 meta.subject → unknown）
    const subject = typeof payload.subject === 'string' && payload.subject.trim() ? payload.subject : undefined;
    return getCaptureHost().collect(payload.extracted, subject);
  });

  // D1-fix-3 L-2：控件条「提取试题篮」后主窗拉取最近一次提取结果
  ipcMain.handle(IPC_CHANNELS.CAPTURE_GET_LAST_EXTRACTION, async () => {
    return getCaptureHost().getLastExtraction();
  });

  // 0006 P4（只增）：整卷下载预览（组卷网 URL；非整卷形态由 host 按提示拒绝）
  ipcMain.handle(IPC_CHANNELS.CAPTURE_PAPER_PREVIEW, async (_event, payload) => {
    if (!payload || typeof payload.url !== 'string' || !payload.url.trim()) throw new Error('Invalid payload');
    return getCaptureHost().paperPreview(payload.url);
  });

  // 0006 P4（只增）：整卷导入（勾选题号 + 去向二选一）
  ipcMain.handle(IPC_CHANNELS.CAPTURE_PAPER_IMPORT, async (_event, payload) => {
    if (!payload || typeof payload.url !== 'string' || !payload.url.trim()) throw new Error('Invalid payload');
    if (!Array.isArray(payload.questionIds)) throw new Error('Invalid payload');
    if (payload.target !== 'paper' && payload.target !== 'bank') throw new Error('Invalid payload: target');
    return getCaptureHost().paperImport({
      url: payload.url,
      questionIds: payload.questionIds.filter((id: unknown) => typeof id === 'string'),
      target: payload.target,
    });
  });

  // 0012（只增）：内嵌 view bounds 上报（渲染层视口坐标；x/y 允许负=滚动滚出（P0 A3 实证），宽高须非负有限）
  ipcMain.handle(IPC_CHANNELS.CAPTURE_SET_BOUNDS, async (_event, payload) => {
    if (!payload || typeof payload !== 'object') throw new Error('Invalid payload');
    const { x, y, width, height } = payload as Record<string, unknown>;
    if (
      typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number'
      || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)
    ) {
      throw new Error('Invalid payload');
    }
    if (width < 0 || height < 0) throw new Error('Invalid payload');
    return getCaptureHost().setBounds({ x, y, width, height });
  });

  // 0012 P2（只增）：保存当前页 HTML（取证；结果 {ok,path?,error?} 如实回传渲染层）
  ipcMain.handle(IPC_CHANNELS.CAPTURE_SAVE_PAGE_HTML, async () => {
    return getCaptureHost().savePageHtml();
  });
}

/**
 * E1（只增）：注册 guard.* IPC handlers（数据备份与恢复）
 *
 * P0-2：恢复流程不再由本层自行 openDatabase——改为调用 main.ts 提供的 reloadDatabase()：
 *  - 成功：重开恢复后的库并重建 bankService/captureHost，应用无需重启即可继续使用；
 *  - 失败：restoreBackup 内部已回滚原数据，reloadDatabase() 重开原库，保证 main 句柄始终可用。
 *  活动库句柄由 restoreBackup 的 onBeforeReplace 回调在真正替换 data/ 前关闭。
 */
export function registerGuardIpcHandlers(
  getDb: () => import('../bank/db.js').Database,
  reloadDatabase: () => import('../bank/db.js').Database,
  dataDir: string,
  appVersion: string,
  migrationsDir: string
) {
  // guard.createBackup — 主进程弹保存对话框，选择备份路径
  ipcMain.handle(IPC_CHANNELS.GUARD_CREATE_BACKUP, async () => {
    const { dialog } = require('electron');
    const { createBackup } = await import('../guard/backup/backup-service.js');

    try {
      // 弹出保存对话框
      const result = await dialog.showSaveDialog({
        title: '选择备份保存位置',
        defaultPath: `mofang-backup-${new Date().toISOString().slice(0, 10)}.mofang-backup.zip`,
        filters: [
          { name: '魔方助教备份文件', extensions: ['mofang-backup.zip'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      });

      if (result.canceled || !result.filePath) {
        return { success: false, error: 'Backup canceled' };
      }

      const backupResult = await createBackup(getDb(), dataDir, result.filePath, appVersion);

      if (backupResult.success && backupResult.manifest) {
        return {
          success: true,
          backupPath: backupResult.backupPath,
          manifest: {
            backup_id: backupResult.manifest.backup_id,
            created_at: backupResult.manifest.created_at,
            counts: backupResult.manifest.counts,
          },
        };
      } else {
        return { success: false, error: backupResult.error };
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // guard.restoreBackup — 主进程弹打开对话框，选择备份文件
  ipcMain.handle(IPC_CHANNELS.GUARD_RESTORE_BACKUP, async (_event, payload: { confirmed: boolean }) => {
    const { dialog } = require('electron');
    const { restoreBackup, previewBackup } = await import('../guard/restore/restore-service.js');

    try {
      // 弹出打开对话框
      const result = await dialog.showOpenDialog({
        title: '选择要恢复的备份文件',
        filters: [
          { name: '魔方助教备份文件', extensions: ['mofang-backup.zip'] },
          { name: '所有文件', extensions: ['*'] },
        ],
        properties: ['openFile'],
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, error: 'Restore canceled' };
      }

      const backupPath = result.filePaths[0];

      // 预览备份
      const preview = previewBackup(backupPath);
      if (!preview.valid) {
        return { success: false, error: `Invalid backup: ${preview.errors.join('; ')}` };
      }

      // 检查是否需要确认
      if (!payload.confirmed) {
        // 返回预览信息，要求 UI 确认
        return {
          success: false,
          needsConfirmation: true,
          manifest: preview.manifest,
        };
      }

      // 执行恢复（句柄由 onBeforeReplace 在真正替换前关闭；事后统一 reloadDatabase 重开）
      const currentDb = getDb();
      const currentSchemaVersion = currentDb.getUserVersion();

      try {
        const restoreResult = await restoreBackup(
          backupPath,
          dataDir,
          currentSchemaVersion,
          migrationsDir,
          true, // confirmed
          () => {
            // P0-2：替换前关闭活动库句柄（Windows 上未关闭会阻塞目录替换）
            try { currentDb.close(); } catch { /* 忽略重复关闭 */ }
          }
        );
        return restoreResult;
      } finally {
        // P0-2：无论成功（恢复后库）还是失败（回滚后的原库），都重开数据库并重建
        // bankService/captureHost，保证应用无需重启即可继续使用
        reloadDatabase();
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // guard.getStats — 获取当前数据统计
  ipcMain.handle(IPC_CHANNELS.GUARD_GET_STATS, async () => {
    try {
      const currentDb = getDb();
      const questionCount = currentDb.prepare('SELECT COUNT(*) as count FROM questions WHERE deleted = 0').get() as { count: number };
      const paperCount = currentDb.prepare('SELECT COUNT(*) as count FROM papers').get() as { count: number };

      // 统计资产数量
      const { readdirSync, statSync, existsSync } = require('node:fs');
      const { join } = require('node:path');

      let assetCount = 0;
      const assetsDir = join(dataDir, 'assets');

      if (existsSync(assetsDir)) {
        const countFiles = (dir: string): number => {
          let count = 0;
          const items = readdirSync(dir);
          for (const item of items) {
            const fullPath = join(dir, item);
            const stat = statSync(fullPath);
            if (stat.isDirectory()) {
              count += countFiles(fullPath);
            } else if (stat.isFile()) {
              count++;
            }
          }
          return count;
        };

        assetCount = countFiles(assetsDir);
      }

      return {
        questions: questionCount.count,
        papers: paperCount.count,
        assets: assetCount,
      };
    } catch (err) {
      throw new Error(`Failed to get stats: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // 0037（只增）：guard.getDashboard — 首页沉淀统计聚合（资产四指标 + AI 用量，读 operation_log 留痕）
  ipcMain.handle(IPC_CHANNELS.GUARD_GET_DASHBOARD, async () => {
    try {
      return getHomeDashboard(getDb());
    } catch (err) {
      throw new Error(`Failed to get dashboard: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}
/**
 * 0003：bank 扩展通道接线（student/class/exam/mistake 全量 + dict/paper_set 查询子集，共 35 通道；
 * fix-2 只增补 2：paper_set.addPaper + bank.paper.setStatus，共 37；
 * 0004 只增补 6：paper 试题篮 6 通道；0004 只增补 4：tree 查询 4 通道，共 47；
 * 0004 Phase 5 只增补 8：paper.setLayoutConfig + setQuestionLayouts + preset 5 通道，共 55；
 * 0005 只增补 5：feedback 模板 4 通道 + （file 注册器内）feedback.exportCards 输出通道，共 60；
 * 0025 只增补 12：8 条既有 unwired 补线（dict.create / paper_set.removePaper+delete / tree 写 5）
 * + 4 条错题闭环新通道（聚合/批量删/批量改档/题 id 集导出），本注册器共 73。
 * 0030 只增补 10：反馈记录 5 通道（feedback.records.*）+ AI 提示词模板 5 通道
 *（feedback.promptTemplates.*），本注册器共 83）。
 * 接线模式照抄既有先例：payload 校验（handler 层只校验分发所需字段，业务校验在 service 层）
 * → 调 service → 返回结果；P0-2 getter 闭包，恢复后 reloadDatabase() 重建 extServices，
 * handler 自动指向新实例（无需重复注册）。
 * 仍未接线（通道本就未定义，非本单范围）：tree.getTrees（无 TREE_GET 通道）、class.close（R-014）。
 */
export function registerExtIpcHandlers(getExtServices: () => BankExtServices) {
  const requireStr = (value: unknown, name: string): string => {
    if (typeof value !== 'string' || !value) throw new Error(`Invalid ${name}`);
    return value;
  };

  // ---------- dict.*（0003 子集：list/get） ----------
  ipcMain.handle(IPC_CHANNELS.DICT_LIST, async (_event, payload) => {
    return getExtServices().dict.listEntries(payload?.filter);
  });

  ipcMain.handle(IPC_CHANNELS.DICT_GET, async (_event, payload) => {
    if (!payload || typeof payload.id !== 'string') throw new Error('Invalid id');
    return getExtServices().dict.getEntry(payload.id);
  });

  // ---------- 0016（只增补线）：dict.update（U12 未知值指认；code 指向守卫在 service 层） ----------
  ipcMain.handle(IPC_CHANNELS.DICT_UPDATE, async (_event, payload) => {
    if (!payload || typeof payload.id !== 'string' || typeof payload.data !== 'object' || payload.data === null) {
      throw new Error('Invalid payload');
    }
    return getExtServices().dict.updateEntry(payload.id, payload.data);
  });

  // ---------- 0025（只增补线）：dict.create（归一行重名守卫在 service 层） ----------
  ipcMain.handle(IPC_CHANNELS.DICT_CREATE, async (_event, payload) => {
    if (!payload || typeof payload.data !== 'object' || payload.data === null) throw new Error('Invalid payload');
    const kind = payload.data.kind;
    if (kind !== 'subject' && kind !== 'question_type' && kind !== 'difficulty') throw new Error('Invalid dict kind');
    requireStr(payload.data.code, 'code');
    requireStr(payload.data.label, 'label');
    return getExtServices().dict.createEntry(payload.data);
  });

  // ---------- student.*（10 全） ----------
  ipcMain.handle(IPC_CHANNELS.STUDENT_CREATE, async (_event, payload) => {
    if (!payload || typeof payload.data !== 'object' || payload.data === null) throw new Error('Invalid payload');
    requireStr(payload.data.name, 'student name');
    return getExtServices().student.createStudent(payload.data);
  });

  ipcMain.handle(IPC_CHANNELS.STUDENT_GET, async (_event, payload) => {
    if (!payload || typeof payload.id !== 'string') throw new Error('Invalid id');
    return getExtServices().student.getStudent(payload.id);
  });

  ipcMain.handle(IPC_CHANNELS.STUDENT_LIST, async (_event, payload) => {
    return getExtServices().student.listStudents(payload?.filter);
  });

  ipcMain.handle(IPC_CHANNELS.STUDENT_UPDATE, async (_event, payload) => {
    if (!payload || typeof payload.id !== 'string' || typeof payload.data !== 'object' || payload.data === null) {
      throw new Error('Invalid payload');
    }
    return getExtServices().student.updateStudent(payload.id, payload.data);
  });

  ipcMain.handle(IPC_CHANNELS.STUDENT_SET_STATUS, async (_event, payload) => {
    if (!payload || typeof payload.id !== 'string' || (payload.status !== 'active' && payload.status !== 'archived')) {
      throw new Error('Invalid payload');
    }
    return getExtServices().student.setStudentStatus(payload.id, payload.status);
  });

  ipcMain.handle(IPC_CHANNELS.STUDENT_ENROLL, async (_event, payload) => {
    if (!payload || typeof payload.studentId !== 'string' || typeof payload.classId !== 'string') {
      throw new Error('Invalid payload');
    }
    return getExtServices().student.enrollStudent(payload.studentId, payload.classId, payload.startedAt);
  });

  ipcMain.handle(IPC_CHANNELS.STUDENT_END_ENROLLMENT, async (_event, payload) => {
    if (!payload || typeof payload.studentId !== 'string' || typeof payload.classId !== 'string' || typeof payload.endedAt !== 'string') {
      throw new Error('Invalid payload');
    }
    return getExtServices().student.endEnrollment(payload.studentId, payload.classId, payload.endedAt);
  });

  ipcMain.handle(IPC_CHANNELS.STUDENT_GET_CLASSES, async (_event, payload) => {
    if (!payload || typeof payload.id !== 'string') throw new Error('Invalid id');
    return getExtServices().student.getStudentClasses(payload.id);
  });

  ipcMain.handle(IPC_CHANNELS.STUDENT_ADD_EVENT, async (_event, payload) => {
    if (!payload || typeof payload.data !== 'object' || payload.data === null) throw new Error('Invalid payload');
    requireStr(payload.data.studentId, 'studentId');
    requireStr(payload.data.eventType, 'eventType');
    requireStr(payload.data.occurredAt, 'occurredAt');
    if (typeof payload.data.payload !== 'object' || payload.data.payload === null) throw new Error('Invalid event payload');
    return getExtServices().student.addEvent(payload.data);
  });

  ipcMain.handle(IPC_CHANNELS.STUDENT_LIST_EVENTS, async (_event, payload) => {
    if (!payload || typeof payload.filter !== 'object' || payload.filter === null || typeof payload.filter.studentId !== 'string') {
      throw new Error('Invalid payload');
    }
    return getExtServices().student.listEvents(payload.filter);
  });

  // ---------- class.*（4 全；class.close 通道 0002 未定义，不接） ----------
  ipcMain.handle(IPC_CHANNELS.CLASS_CREATE, async (_event, payload) => {
    if (!payload || typeof payload.data !== 'object' || payload.data === null) throw new Error('Invalid payload');
    requireStr(payload.data.name, 'class name');
    return getExtServices().class.createClass(payload.data);
  });

  ipcMain.handle(IPC_CHANNELS.CLASS_GET, async (_event, payload) => {
    if (!payload || typeof payload.id !== 'string') throw new Error('Invalid id');
    return getExtServices().class.getClass(payload.id);
  });

  ipcMain.handle(IPC_CHANNELS.CLASS_LIST, async (_event, payload) => {
    return getExtServices().class.listClasses(payload?.filter);
  });

  ipcMain.handle(IPC_CHANNELS.CLASS_UPDATE, async (_event, payload) => {
    if (!payload || typeof payload.id !== 'string' || typeof payload.data !== 'object' || payload.data === null) {
      throw new Error('Invalid payload');
    }
    return getExtServices().class.updateClass(payload.id, payload.data);
  });

  // ---------- exam.*（7 全） ----------
  ipcMain.handle(IPC_CHANNELS.EXAM_CREATE, async (_event, payload) => {
    if (!payload || typeof payload.data !== 'object' || payload.data === null) throw new Error('Invalid payload');
    requireStr(payload.data.title, 'exam title');
    requireStr(payload.data.occurredAt, 'occurredAt');
    return getExtServices().exam.createExam(payload.data);
  });

  ipcMain.handle(IPC_CHANNELS.EXAM_GET, async (_event, payload) => {
    if (!payload || typeof payload.id !== 'string') throw new Error('Invalid id');
    return getExtServices().exam.getExam(payload.id);
  });

  ipcMain.handle(IPC_CHANNELS.EXAM_LIST, async (_event, payload) => {
    return getExtServices().exam.listExams(payload?.filter);
  });

  ipcMain.handle(IPC_CHANNELS.EXAM_RECORD_SCORES, async (_event, payload) => {
    if (!payload || typeof payload.examId !== 'string' || !Array.isArray(payload.entries)) throw new Error('Invalid payload');
    return getExtServices().exam.recordScores(payload.examId, payload.entries);
  });

  ipcMain.handle(IPC_CHANNELS.EXAM_GET_SCORES, async (_event, payload) => {
    if (!payload || typeof payload.examId !== 'string') throw new Error('Invalid examId');
    return getExtServices().exam.getExamScores(payload.examId);
  });

  ipcMain.handle(IPC_CHANNELS.EXAM_GET_STUDENT_SCORES, async (_event, payload) => {
    if (!payload || typeof payload.studentId !== 'string') throw new Error('Invalid studentId');
    return getExtServices().exam.getStudentScores(payload.studentId);
  });

  ipcMain.handle(IPC_CHANNELS.EXAM_RECORD_RESULTS, async (_event, payload) => {
    if (!payload || typeof payload.examId !== 'string' || !Array.isArray(payload.entries)) throw new Error('Invalid payload');
    return getExtServices().exam.recordResults(payload.examId, payload.entries);
  });

  // ---------- mistake.*（7 全） ----------
  ipcMain.handle(IPC_CHANNELS.MISTAKE_RECORD_WRONG, async (_event, payload) => {
    if (!payload || typeof payload.data !== 'object' || payload.data === null) throw new Error('Invalid payload');
    requireStr(payload.data.questionId, 'questionId');
    requireStr(payload.data.studentId, 'studentId');
    requireStr(payload.data.occurredAt, 'occurredAt');
    return getExtServices().mistake.recordWrong(payload.data);
  });

  ipcMain.handle(IPC_CHANNELS.MISTAKE_GET, async (_event, payload) => {
    if (!payload || typeof payload.id !== 'string') throw new Error('Invalid id');
    return getExtServices().mistake.getMistake(payload.id);
  });

  ipcMain.handle(IPC_CHANNELS.MISTAKE_LIST, async (_event, payload) => {
    return getExtServices().mistake.listMistakes(payload?.filter);
  });

  ipcMain.handle(IPC_CHANNELS.MISTAKE_SET_STAGE, async (_event, payload) => {
    if (!payload || typeof payload.id !== 'string'
      || (payload.stage !== 'red' && payload.stage !== 'yellow' && payload.stage !== 'green')) {
      throw new Error('Invalid payload');
    }
    return getExtServices().mistake.setStage(payload.id, payload.stage);
  });

  ipcMain.handle(IPC_CHANNELS.MISTAKE_CYCLE_STAGE, async (_event, payload) => {
    if (!payload || typeof payload.id !== 'string') throw new Error('Invalid id');
    return getExtServices().mistake.cycleStage(payload.id);
  });

  ipcMain.handle(IPC_CHANNELS.MISTAKE_SET_NOTE, async (_event, payload) => {
    if (!payload || typeof payload.id !== 'string' || typeof payload.note !== 'string') throw new Error('Invalid payload');
    return getExtServices().mistake.setNote(payload.id, payload.note);
  });

  ipcMain.handle(IPC_CHANNELS.MISTAKE_DELETE, async (_event, payload) => {
    if (!payload || typeof payload.id !== 'string') throw new Error('Invalid id');
    return getExtServices().mistake.deleteMistake(payload.id);
  });

  // ---------- 0025（只增）：错题闭环数据层——聚合/批量/题 id 集导出 ----------
  // 批量 ids 守卫在 handler 层先拦（空集/含非字符串 → 不触达 service，也不产生无效 operation_log）
  const requireMistakeIds = (ids: string[]): string[] => {
    if (!Array.isArray(ids) || ids.length === 0) throw new Error('Invalid ids');
    if (ids.some((id) => typeof id !== 'string' || !id)) throw new Error('Invalid ids');
    return ids;
  };

  ipcMain.handle(IPC_CHANNELS.MISTAKE_AGGREGATE, async (_event, payload) => {
    return getExtServices().mistake.aggregateByQuestion(payload?.filter);
  });

  ipcMain.handle(IPC_CHANNELS.MISTAKE_BATCH_DELETE, async (_event, payload) => {
    if (!payload) throw new Error('Invalid payload');
    return getExtServices().mistake.deleteMistakes(requireMistakeIds(payload.ids));
  });

  ipcMain.handle(IPC_CHANNELS.MISTAKE_BATCH_SET_STAGE, async (_event, payload) => {
    if (!payload) throw new Error('Invalid payload');
    const ids = requireMistakeIds(payload.ids);
    if (payload.stage !== 'red' && payload.stage !== 'yellow' && payload.stage !== 'green') {
      throw new Error('Invalid stage');
    }
    return getExtServices().mistake.setStages(ids, payload.stage);
  });

  ipcMain.handle(IPC_CHANNELS.MISTAKE_EXPORT_QUESTION_IDS, async (_event, payload) => {
    return getExtServices().mistake.exportQuestionIds(payload?.filter);
  });

  // ---------- paper_set.*（0003 拍板子集：create/get/list/getPapers/getStudentPaper） ----------
  ipcMain.handle(IPC_CHANNELS.PAPER_SET_CREATE, async (_event, payload) => {
    if (!payload || typeof payload.data !== 'object' || payload.data === null) throw new Error('Invalid payload');
    requireStr(payload.data.name, 'paperSet name');
    if (payload.data.type !== 'uniform' && payload.data.type !== 'custom-mistake') throw new Error('Invalid paperSet type');
    return getExtServices().paperSet.createPaperSet(payload.data);
  });

  ipcMain.handle(IPC_CHANNELS.PAPER_SET_GET, async (_event, payload) => {
    if (!payload || typeof payload.id !== 'string') throw new Error('Invalid id');
    return getExtServices().paperSet.getPaperSet(payload.id);
  });

  ipcMain.handle(IPC_CHANNELS.PAPER_SET_LIST, async (_event, payload) => {
    return getExtServices().paperSet.listPaperSets(payload?.filter);
  });

  ipcMain.handle(IPC_CHANNELS.PAPER_SET_GET_PAPERS, async (_event, payload) => {
    if (!payload || typeof payload.paperSetId !== 'string') throw new Error('Invalid paperSetId');
    return getExtServices().paperSet.getSetPapers(payload.paperSetId);
  });

  ipcMain.handle(IPC_CHANNELS.PAPER_SET_GET_STUDENT_PAPER, async (_event, payload) => {
    if (!payload || typeof payload.paperSetId !== 'string' || typeof payload.studentId !== 'string') {
      throw new Error('Invalid payload');
    }
    return getExtServices().paperSet.getStudentPaper(payload.paperSetId, payload.studentId);
  });

  // ---------- fix-2（只增）：paper_set.addPaper（考试关联已定稿卷编排用） ----------
  ipcMain.handle(IPC_CHANNELS.PAPER_SET_ADD_PAPER, async (_event, payload) => {
    if (!payload || typeof payload.paperSetId !== 'string' || typeof payload.paperId !== 'string') {
      throw new Error('Invalid payload');
    }
    return getExtServices().paperSet.addPaper(payload.paperSetId, payload.paperId, payload.studentId);
  });

  // ---------- 0025（只增补线）：paper_set 写通道 removePaper/delete（B11：删集合不伤卷） ----------
  ipcMain.handle(IPC_CHANNELS.PAPER_SET_REMOVE_PAPER, async (_event, payload) => {
    if (!payload || typeof payload.paperSetId !== 'string') throw new Error('Invalid paperSetId');
    if (typeof payload.paperId !== 'string') throw new Error('Invalid paperId');
    return getExtServices().paperSet.removePaper(payload.paperSetId, payload.paperId);
  });

  ipcMain.handle(IPC_CHANNELS.PAPER_SET_DELETE, async (_event, payload) => {
    if (!payload || typeof payload.id !== 'string') throw new Error('Invalid id');
    return getExtServices().paperSet.deletePaperSet(payload.id);
  });

  // ---------- fix-2（只增）：bank.paper.setStatus（组卷页定稿/状态机，迁移合法性校验在 service 层） ----------
  ipcMain.handle(IPC_CHANNELS.PAPER_UPDATE_STATUS, async (_event, payload) => {
    if (!payload || typeof payload.id !== 'string'
      || (payload.status !== 'basket' && payload.status !== 'composing'
        && payload.status !== 'done' && payload.status !== 'archived')) {
      throw new Error('Invalid payload');
    }
    return getExtServices().paper.updatePaperStatus(payload.id, payload.status);
  });

  // ==================== 0004 Phase 5（只增）：版式定稿 + 预设 5 通道 + 题级图覆盖 ====================

  // ---------- bank.paper.setLayoutConfig（出卷定稿序列第①步；config 结构校验在消费侧/导入校验） ----------
  ipcMain.handle(IPC_CHANNELS.PAPER_SET_LAYOUT_CONFIG, async (_event, payload) => {
    if (!payload || typeof payload.id !== 'string'
      || !payload.layoutConfig || typeof payload.layoutConfig !== 'object'
      || (payload.layoutConfig.version !== 1 && payload.layoutConfig.version !== 2)) {
      throw new Error('Invalid payload');
    }
    return getExtServices().paper.setPaperLayoutConfig(payload.id, payload.layoutConfig);
  });

  // ---------- preset.*（5 全；内置不可改/删守卫在 service 层） ----------
  ipcMain.handle(IPC_CHANNELS.PRESET_CREATE, async (_event, payload) => {
    if (!payload || typeof payload.data !== 'object' || payload.data === null) throw new Error('Invalid payload');
    requireStr(payload.data.name, 'preset name');
    if (!payload.data.config || typeof payload.data.config !== 'object'
      || (payload.data.config.version !== 1 && payload.data.config.version !== 2)) {
      throw new Error('Invalid preset config');
    }
    return getExtServices().preset.createPreset(payload.data);
  });

  ipcMain.handle(IPC_CHANNELS.PRESET_GET, async (_event, payload) => {
    if (!payload || typeof payload.id !== 'string') throw new Error('Invalid id');
    return getExtServices().preset.getPreset(payload.id);
  });

  ipcMain.handle(IPC_CHANNELS.PRESET_LIST, async (_event, payload) => {
    return getExtServices().preset.listPresets(payload?.filter);
  });

  ipcMain.handle(IPC_CHANNELS.PRESET_UPDATE, async (_event, payload) => {
    if (!payload || typeof payload.id !== 'string' || typeof payload.data !== 'object' || payload.data === null) {
      throw new Error('Invalid payload');
    }
    if (payload.data.config !== undefined
      && (!payload.data.config || typeof payload.data.config !== 'object'
        || (payload.data.config.version !== 1 && payload.data.config.version !== 2))) {
      throw new Error('Invalid preset config');
    }
    return getExtServices().preset.updatePreset(payload.id, payload.data);
  });

  ipcMain.handle(IPC_CHANNELS.PRESET_DELETE, async (_event, payload) => {
    if (!payload || typeof payload.id !== 'string') throw new Error('Invalid id');
    return getExtServices().preset.deletePreset(payload.id);
  });

  // ==================== 0005（只增）：feedback 课后反馈模板 4 通道 ====================
  //（内置守卫在服务层；payload 校验照 preset 既有风格）

  ipcMain.handle(IPC_CHANNELS.FEEDBACK_CREATE, async (_event, payload) => {
    if (!payload || typeof payload.data !== 'object' || payload.data === null) throw new Error('Invalid payload');
    requireStr(payload.data.name, 'template name');
    requireStr(payload.data.bodyTemplate, 'template body');
    return getExtServices().feedback.createTemplate(payload.data);
  });

  ipcMain.handle(IPC_CHANNELS.FEEDBACK_GET, async (_event, payload) => {
    if (!payload || typeof payload.id !== 'string') throw new Error('Invalid id');
    return getExtServices().feedback.getTemplate(payload.id);
  });

  ipcMain.handle(IPC_CHANNELS.FEEDBACK_LIST, async (_event, payload) => {
    return getExtServices().feedback.listTemplates(payload?.filter);
  });

  ipcMain.handle(IPC_CHANNELS.FEEDBACK_UPDATE, async (_event, payload) => {
    if (!payload || typeof payload.id !== 'string' || typeof payload.data !== 'object' || payload.data === null) {
      throw new Error('Invalid payload');
    }
    if (payload.data.name !== undefined && typeof payload.data.name !== 'string') throw new Error('Invalid name');
    if (payload.data.bodyTemplate !== undefined && typeof payload.data.bodyTemplate !== 'string') throw new Error('Invalid bodyTemplate');
    return getExtServices().feedback.updateTemplate(payload.id, payload.data);
  });

  ipcMain.handle(IPC_CHANNELS.FEEDBACK_DELETE, async (_event, payload) => {
    if (!payload || typeof payload.id !== 'string') throw new Error('Invalid id');
    return getExtServices().feedback.deleteTemplate(payload.id);
  });

  // ==================== 0030（只增）：反馈记录 5 通道 + AI 提示词模板 5 通道 ====================
  //（payload 校验照 0005/preset 风格：handler 只校验分发所需字段，业务校验在服务层；
  //  双模式落档语义在服务层——快速模式 student_id 缺省即 NULL 留痕，见 feedback-record-service.ts）

  ipcMain.handle(IPC_CHANNELS.FEEDBACK_RECORD_CREATE, async (_event, payload) => {
    if (!payload || typeof payload.data !== 'object' || payload.data === null) throw new Error('Invalid payload');
    requireStr(payload.data.studentName, 'record studentName');
    requireStr(payload.data.body, 'record body');
    requireStr(payload.data.inputJson, 'record inputJson');
    return getExtServices().feedbackRecord.createRecord(payload.data);
  });

  ipcMain.handle(IPC_CHANNELS.FEEDBACK_RECORD_GET, async (_event, payload) => {
    if (!payload || typeof payload.id !== 'string') throw new Error('Invalid id');
    return getExtServices().feedbackRecord.getRecord(payload.id);
  });

  ipcMain.handle(IPC_CHANNELS.FEEDBACK_RECORD_LIST, async (_event, payload) => {
    return getExtServices().feedbackRecord.listRecords(payload?.query);
  });

  ipcMain.handle(IPC_CHANNELS.FEEDBACK_RECORD_UPDATE, async (_event, payload) => {
    if (!payload || typeof payload.id !== 'string' || typeof payload.data !== 'object' || payload.data === null) {
      throw new Error('Invalid payload');
    }
    if (payload.data.body !== undefined && typeof payload.data.body !== 'string') throw new Error('Invalid body');
    if (payload.data.studentName !== undefined && typeof payload.data.studentName !== 'string') throw new Error('Invalid studentName');
    return getExtServices().feedbackRecord.updateRecord(payload.id, payload.data);
  });

  ipcMain.handle(IPC_CHANNELS.FEEDBACK_RECORD_DELETE, async (_event, payload) => {
    if (!payload || typeof payload.id !== 'string') throw new Error('Invalid id');
    return getExtServices().feedbackRecord.deleteRecord(payload.id);
  });

  ipcMain.handle(IPC_CHANNELS.FEEDBACK_PROMPT_CREATE, async (_event, payload) => {
    if (!payload || typeof payload.data !== 'object' || payload.data === null) throw new Error('Invalid payload');
    requireStr(payload.data.name, 'prompt template name');
    requireStr(payload.data.body, 'prompt template body');
    return getExtServices().feedbackPrompt.createTemplate(payload.data);
  });

  ipcMain.handle(IPC_CHANNELS.FEEDBACK_PROMPT_GET, async (_event, payload) => {
    if (!payload || typeof payload.id !== 'string') throw new Error('Invalid id');
    return getExtServices().feedbackPrompt.getTemplate(payload.id);
  });

  ipcMain.handle(IPC_CHANNELS.FEEDBACK_PROMPT_LIST, async (_event, payload) => {
    return getExtServices().feedbackPrompt.listTemplates(payload?.filter);
  });

  ipcMain.handle(IPC_CHANNELS.FEEDBACK_PROMPT_UPDATE, async (_event, payload) => {
    if (!payload || typeof payload.id !== 'string' || typeof payload.data !== 'object' || payload.data === null) {
      throw new Error('Invalid payload');
    }
    if (payload.data.name !== undefined && typeof payload.data.name !== 'string') throw new Error('Invalid name');
    if (payload.data.body !== undefined && typeof payload.data.body !== 'string') throw new Error('Invalid body');
    return getExtServices().feedbackPrompt.updateTemplate(payload.id, payload.data);
  });

  ipcMain.handle(IPC_CHANNELS.FEEDBACK_PROMPT_DELETE, async (_event, payload) => {
    if (!payload || typeof payload.id !== 'string') throw new Error('Invalid id');
    return getExtServices().feedbackPrompt.deleteTemplate(payload.id);
  });

  // ---------- bank.paper.setQuestionLayouts（题级图排版覆盖整体覆盖式写入） ----------
  ipcMain.handle(IPC_CHANNELS.BANK_PAPER_SET_QUESTION_LAYOUTS, async (_event, payload) => {
    if (!payload || typeof payload.paperId !== 'string' || typeof payload.questionId !== 'string') {
      throw new Error('Invalid payload');
    }
    const layout = payload.layout;
    if (!layout || typeof layout !== 'object') throw new Error('Invalid layout');
    if (layout.figures !== undefined) {
      if (!Array.isArray(layout.figures)) throw new Error('Invalid layout figures');
      for (const f of layout.figures) {
        if (!f || typeof f.assetId !== 'string') throw new Error('Invalid figure layout entry');
        if (f.mode !== undefined && f.mode !== 'inline' && f.mode !== 'side-by-side') throw new Error('Invalid figure mode');
        if (f.align !== undefined && f.align !== 'left' && f.align !== 'center' && f.align !== 'right') throw new Error('Invalid figure align');
        if (f.widthPercent !== undefined && (typeof f.widthPercent !== 'number' || f.widthPercent <= 0 || f.widthPercent > 100)) {
          throw new Error('Invalid figure widthPercent');
        }
        if (f.orderIndex !== undefined && (typeof f.orderIndex !== 'number' || !Number.isInteger(f.orderIndex))) {
          throw new Error('Invalid figure orderIndex');
        }
        // 0004-fix-5 P0-2：段边界锚位（非负整数；与 orderIndex 同款收窄）
        if (f.anchorIndex !== undefined && (typeof f.anchorIndex !== 'number' || !Number.isInteger(f.anchorIndex) || f.anchorIndex < 0)) {
          throw new Error('Invalid figure anchorIndex');
        }
      }
    }
    return getExtServices().paper.setQuestionLayouts(payload.paperId, payload.questionId, layout);
  });

  // ==================== 0004（只增）：试题篮 6 通道 ====================

  // ---------- bank.paper.listPapersEx（不过滤 archived；statuses 白名单校验） ----------
  ipcMain.handle(IPC_CHANNELS.BANK_PAPER_LIST_EX, async (_event, payload) => {
    const filter = payload?.filter;
    if (filter !== undefined && (typeof filter !== 'object' || filter === null)) throw new Error('Invalid payload');
    if (filter?.statuses !== undefined) {
      if (!Array.isArray(filter.statuses)) throw new Error('Invalid statuses');
      for (const s of filter.statuses) {
        // 0044：白名单只增 'trashed'（回收站显式查询口径）
        if (s !== 'basket' && s !== 'composing' && s !== 'done' && s !== 'archived' && s !== 'trashed') throw new Error('Invalid status');
      }
    }
    return getExtServices().paper.listPapersEx(filter);
  });

  // ---------- bank.paper.getPaperEx（含 archived 卷） ----------
  ipcMain.handle(IPC_CHANNELS.BANK_PAPER_GET_EX, async (_event, payload) => {
    if (!payload || typeof payload.id !== 'string') throw new Error('Invalid id');
    return getExtServices().paper.getPaperEx(payload.id);
  });

  // ---------- bank.paper.snapshotPaperQuestions（快照 upsert；题缺失抛错在 service 层） ----------
  ipcMain.handle(IPC_CHANNELS.BANK_PAPER_SNAPSHOT, async (_event, payload) => {
    if (!payload || typeof payload.paperId !== 'string') throw new Error('Invalid paperId');
    return getExtServices().paper.snapshotPaperQuestions(payload.paperId);
  });

  // ---------- bank.paper.listPaperSnapshotQuestions ----------
  ipcMain.handle(IPC_CHANNELS.BANK_PAPER_SNAPSHOT_LIST, async (_event, payload) => {
    if (!payload || typeof payload.paperId !== 'string') throw new Error('Invalid paperId');
    return getExtServices().paper.listPaperSnapshotQuestions(payload.paperId);
  });

  // ---------- bank.paper.clonePaperToBasket ----------
  ipcMain.handle(IPC_CHANNELS.BANK_PAPER_CLONE_TO_BASKET, async (_event, payload) => {
    if (!payload || typeof payload.sourcePaperId !== 'string') throw new Error('Invalid sourcePaperId');
    if (payload.title !== undefined && typeof payload.title !== 'string') throw new Error('Invalid title');
    return getExtServices().paper.clonePaperToBasket(payload.sourcePaperId, payload.title);
  });

  // ---------- bank.paper.updatePaperTitle（空标题拒绝在 service 层） ----------
  ipcMain.handle(IPC_CHANNELS.BANK_PAPER_UPDATE_TITLE, async (_event, payload) => {
    if (!payload || typeof payload.id !== 'string' || typeof payload.title !== 'string') {
      throw new Error('Invalid payload');
    }
    return getExtServices().paper.updatePaperTitle(payload.id, payload.title);
  });

  // ==================== 0044（只增）：paper.folder.* / 移卷 / 回收站三动作 ====================
  // 业务守卫（父存在/防环/删夹卷回未分类+子夹上移/trashed_from 记录与还原/仅 trashed 可彻底删）在 service 层。

  ipcMain.handle(IPC_CHANNELS.PAPER_FOLDER_LIST, async () => {
    return getExtServices().paper.listFolders();
  });

  ipcMain.handle(IPC_CHANNELS.PAPER_FOLDER_CREATE, async (_event, payload) => {
    if (!payload || typeof payload.data !== 'object' || payload.data === null) throw new Error('Invalid payload');
    requireStr(payload.data.name, 'payload.data.name');
    if (payload.data.parentId !== undefined && typeof payload.data.parentId !== 'string') throw new Error('Invalid payload.data.parentId');
    return getExtServices().paper.createFolder({ name: payload.data.name, ...(payload.data.parentId !== undefined ? { parentId: payload.data.parentId } : {}) });
  });

  ipcMain.handle(IPC_CHANNELS.PAPER_FOLDER_RENAME, async (_event, payload) => {
    if (!payload || typeof payload.id !== 'string' || typeof payload.name !== 'string') throw new Error('Invalid payload');
    return getExtServices().paper.renameFolder(payload.id, payload.name);
  });

  ipcMain.handle(IPC_CHANNELS.PAPER_FOLDER_DELETE, async (_event, payload) => {
    if (!payload || typeof payload.id !== 'string') throw new Error('Invalid payload.id');
    return getExtServices().paper.deleteFolder(payload.id);
  });

  ipcMain.handle(IPC_CHANNELS.PAPER_MOVE_TO_FOLDER, async (_event, payload) => {
    if (!payload || typeof payload.paperId !== 'string') throw new Error('Invalid payload.paperId');
    if (payload.folderId !== null && typeof payload.folderId !== 'string') throw new Error('Invalid payload.folderId');
    return getExtServices().paper.moveToFolder(payload.paperId, payload.folderId);
  });

  ipcMain.handle(IPC_CHANNELS.PAPER_TRASH, async (_event, payload) => {
    if (!payload || typeof payload.id !== 'string') throw new Error('Invalid payload.id');
    return getExtServices().paper.trashPaper(payload.id);
  });

  ipcMain.handle(IPC_CHANNELS.PAPER_RESTORE, async (_event, payload) => {
    if (!payload || typeof payload.id !== 'string') throw new Error('Invalid payload.id');
    return getExtServices().paper.restorePaper(payload.id);
  });

  ipcMain.handle(IPC_CHANNELS.PAPER_DELETE_FOREVER, async (_event, payload) => {
    if (!payload || typeof payload.id !== 'string') throw new Error('Invalid payload.id');
    return getExtServices().paper.deleteForeverPaper(payload.id);
  });

  // ==================== 0004（只增）：tree 查询 4 通道 ====================
  //（仅为知识树空态判定与未来数据就绪；数据未采集 UI 显示「待采集」；写通道不在本轮）

  ipcMain.handle(IPC_CHANNELS.TREE_LIST, async (_event, payload) => {
    return getExtServices().tree.listTrees(payload?.filter);
  });

  ipcMain.handle(IPC_CHANNELS.TREE_GET_NODES, async (_event, payload) => {
    if (!payload || typeof payload.treeId !== 'string') throw new Error('Invalid treeId');
    return getExtServices().tree.getNodes(payload.treeId);
  });

  ipcMain.handle(IPC_CHANNELS.TREE_GET_DESCENDANTS, async (_event, payload) => {
    if (!payload || typeof payload.nodeId !== 'string') throw new Error('Invalid nodeId');
    return getExtServices().tree.getDescendants(payload.nodeId);
  });

  ipcMain.handle(IPC_CHANNELS.TREE_GET_QUESTION_NODES, async (_event, payload) => {
    if (!payload || typeof payload.questionId !== 'string') throw new Error('Invalid questionId');
    return getExtServices().tree.getQuestionNodes(payload.questionId);
  });

  // ---------- 0016（只增补线）：tree.getSourceMappings（U12 站点映射只读查看；树级聚合在渲染层） ----------
  ipcMain.handle(IPC_CHANNELS.TREE_GET_SOURCE_MAPPINGS, async (_event, payload) => {
    if (!payload || typeof payload.nodeId !== 'string') throw new Error('Invalid nodeId');
    return getExtServices().tree.getSourceMappings(payload.nodeId);
  });

  // ==================== 0025（只增补线）：tree 写入 5 通道（闭环第②步「入库+挂树」数据前提） ====================
  // 业务守卫（根节点重名/节点存在性/挂接幂等）一律在 service 层；handler 只验分发所需字段。

  ipcMain.handle(IPC_CHANNELS.TREE_CREATE, async (_event, payload) => {
    if (!payload || typeof payload.data !== 'object' || payload.data === null) throw new Error('Invalid payload');
    if (payload.data.type !== 'textbook' && payload.data.type !== 'knowledge') throw new Error('Invalid tree type');
    requireStr(payload.data.name, 'tree name');
    return getExtServices().tree.createTree(payload.data);
  });

  ipcMain.handle(IPC_CHANNELS.TREE_CREATE_NODE, async (_event, payload) => {
    if (!payload || typeof payload.data !== 'object' || payload.data === null) throw new Error('Invalid payload');
    requireStr(payload.data.treeId, 'treeId');
    requireStr(payload.data.name, 'node name');
    return getExtServices().tree.createNode(payload.data);
  });

  ipcMain.handle(IPC_CHANNELS.TREE_LINK_QUESTION, async (_event, payload) => {
    if (!payload || typeof payload.questionId !== 'string') throw new Error('Invalid questionId');
    if (typeof payload.nodeId !== 'string') throw new Error('Invalid nodeId');
    return getExtServices().tree.linkQuestion(payload.questionId, payload.nodeId);
  });

  ipcMain.handle(IPC_CHANNELS.TREE_UNLINK_QUESTION, async (_event, payload) => {
    if (!payload || typeof payload.questionId !== 'string') throw new Error('Invalid questionId');
    if (typeof payload.nodeId !== 'string') throw new Error('Invalid nodeId');
    return getExtServices().tree.unlinkQuestion(payload.questionId, payload.nodeId);
  });

  ipcMain.handle(IPC_CHANNELS.TREE_RESOLVE_SOURCE_NODE, async (_event, payload) => {
    if (!payload || typeof payload.site !== 'string') throw new Error('Invalid site');
    if (typeof payload.siteNodeId !== 'string') throw new Error('Invalid siteNodeId');
    return getExtServices().tree.resolveSourceNode(payload.site, payload.siteNodeId);
  });
}

/**
 * 0004（只增）：file.* 通道接线（Logo 本地图片 + 剪贴板图片 + 预设导入导出）。
 * dialog/剪贴板/文件读写只在主进程；服务层无 file 概念（不经 SQLite）。
 * smoke 分支（--smoke-basket）：pickLogo/importPreset/exportPreset 不经 dialog 走固定测试文件。
 * 0005（只增）：exportTextFile（反馈 txt）+ exportCards（feedback.exportCards：选目录 →
 * 逐卡临时 html → 隐藏窗口 capturePage → PNG 落盘；卡片内 data-assets 相对引用改写 file:// 绝对路径，
 * 参照 doc.exportPdf 的 rewriteKatexFontUrls 手法——本地实现，零依赖 docgen/render 域）；
 * smoke 分支（--smoke-m6）：不经 dialog，text 固定路径、cards 固定输出目录。
 */
export function registerFileIpcHandlers(opts: {
  /** userData/data 目录（资产落 data/assets/logos/） */
  dataDir: string;
  /**
   * 0061（只增）：废图清理两通道的接线面（懒取——库句柄与服务实例随 reloadDatabase 重建）；
   * 缺省不注册这两条通道（浏览器 demo/测试环境不出现半截功能）。
   */
  cleaner?: () => { refs: RecogAssetCleanerServices; logger?: OperationLogLike };
  smoke?: {
    /** pickLogoImage 固定复制源（如 scripts/fixtures/pixel.png） */
    logoSourcePath: string;
    /** importPresetFile 固定读取 / exportPresetFile 固定写入路径 */
    presetFilePath: string;
    /** 0005：exportTextFile 固定写入路径（--smoke-m6） */
    textExportPath?: string;
    /** 0005：exportCards 固定输出目录（--smoke-m6） */
    cardsOutputDir?: string;
    /** 0030：importTextFile 固定读取路径（提示词模板导入；探针/smoke 用） */
    textImportPath?: string;
  };
}) {
  const logosDir = join(opts.dataDir, 'assets', 'logos');
  const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];

  /** PNG 尺寸解析（IHDR：宽高各 4 字节大端；非 PNG 返回 undefined，字段可选） */
  const pngSize = (filePath: string): { width: number; height: number } | undefined => {
    const buf = readFileSync(filePath);
    const isPng = buf.length > 24
      && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    if (!isPng) return undefined;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  };

  const saveImageToLogos = (sourcePath: string): { relPath: string; width?: number; height?: number } => {
    mkdirSync(logosDir, { recursive: true });
    const ext = sourcePath.split('.').pop()?.toLowerCase() ?? 'png';
    if (!IMAGE_EXTENSIONS.includes(ext)) throw new Error(`Unsupported image extension: .${ext}`);
    const fileName = `${crypto.randomUUID()}.${ext}`;
    copyFileSync(sourcePath, join(logosDir, fileName));
    const size = pngSize(sourcePath);
    // relPath 相对 data/assets（复用 data-assets 加载管线解析）
    return { relPath: `logos/${fileName}`, ...(size ?? {}) };
  };

  // file.pickLogoImage — 本地图片选择 → 复制进 logos/；取消 → null
  ipcMain.handle(IPC_CHANNELS.FILE_PICK_LOGO_IMAGE, async () => {
    if (opts.smoke) {
      return saveImageToLogos(opts.smoke.logoSourcePath);
    }
    const result = await dialog.showOpenDialog({
      title: '选择 Logo 图片',
      filters: [{ name: '图片', extensions: IMAGE_EXTENSIONS }],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return saveImageToLogos(result.filePaths[0]);
  });

  // file.readClipboardImage — 剪贴板图片落盘；无图 → null
  ipcMain.handle(IPC_CHANNELS.FILE_READ_CLIPBOARD_IMAGE, async () => {
    const { clipboard } = require('electron') as typeof import('electron');
    const image = clipboard.readImage();
    if (image.isEmpty()) return null;

    mkdirSync(logosDir, { recursive: true });
    const fileName = `${crypto.randomUUID()}.png`;
    writeFileSync(join(logosDir, fileName), image.toPNG());
    const size = image.getSize();
    return { relPath: `logos/${fileName}`, width: size.width, height: size.height };
  });

  // 0057（只增）：file.saveRecogImage —— 录题裁图产物落 assets/recog/
  // （落盘实现单源在 recog-image-store.ts：启动期存量 backfill 与本通道共用同一份）
  ipcMain.handle(IPC_CHANNELS.FILE_SAVE_RECOG_IMAGE, (_event, payload) => {
    if (!payload || typeof payload !== 'object' || typeof payload.dataUrl !== 'string') {
      throw new Error('Invalid payload（dataUrl 必填字符串）');
    }
    if (payload.width !== undefined && typeof payload.width !== 'number') throw new Error('Invalid payload.width');
    if (payload.height !== undefined && typeof payload.height !== 'number') throw new Error('Invalid payload.height');
    return saveRecogImageDataUrl(opts.dataDir, payload as FileSaveRecogImagePayload);
  });

  // file.importPresetFile — 预设 .json 读文本返回（JSON 结构校验在 UI 层）；取消 → null
  ipcMain.handle(IPC_CHANNELS.FILE_IMPORT_PRESET_FILE, async () => {
    if (opts.smoke) {
      return {
        content: readFileSync(opts.smoke.presetFilePath, 'utf-8'),
        fileName: opts.smoke.presetFilePath.split(/[\\/]/).pop(),
      };
    }
    const result = await dialog.showOpenDialog({
      title: '导入版式预设',
      filters: [{ name: '预设 JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const filePath = result.filePaths[0];
    return {
      content: readFileSync(filePath, 'utf-8'),
      fileName: filePath.split(/[\\/]/).pop(),
    };
  });

  // 0030（只增）：file.importTextFile — 文本文件导入（反馈提示词模板 pack；取消 → null）
  ipcMain.handle(IPC_CHANNELS.FILE_IMPORT_TEXT_FILE, async () => {
    if (opts.smoke?.textImportPath) {
      return {
        content: readFileSync(opts.smoke.textImportPath, 'utf-8'),
        fileName: opts.smoke.textImportPath.split(/[\/]/).pop(),
      };
    }
    const result = await dialog.showOpenDialog({
      title: '导入提示词模板',
      filters: [{ name: '文本', extensions: ['txt', 'md'] }],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const filePath = result.filePaths[0];
    return {
      content: readFileSync(filePath, 'utf-8'),
      fileName: filePath.split(/[\/]/).pop(),
    };
  });

  // 0061（只增）：file.scanRecogAssetGarbage / file.trashRecogAssets —— recog 图资产废图清理
  //（设置页「存储清理」：先扫预览再确认；判定与移动全在主进程，渲染层只见 relPath/字节数）
  if (opts.cleaner) {
    const cleanerDeps = (): RecogAssetCleanerDeps => {
      const { refs, logger } = opts.cleaner!();
      return { dataDir: opts.dataDir, refs, ...(logger ? { logger } : {}) };
    };
    ipcMain.handle(IPC_CHANNELS.FILE_SCAN_RECOG_ASSET_GARBAGE, async () => scanRecogAssetGarbage(cleanerDeps()));
    ipcMain.handle(IPC_CHANNELS.FILE_TRASH_RECOG_ASSETS, async (_event, payload) => (
      trashRecogAssets(cleanerDeps(), payload as FileTrashRecogAssetsPayload)
    ));
  }

  // file.exportPresetFile — 保存对话框 + 写文本；取消 → { filePath: null }
  ipcMain.handle(IPC_CHANNELS.FILE_EXPORT_PRESET_FILE, async (_event, payload) => {
    if (!payload || typeof payload.suggestedName !== 'string' || typeof payload.content !== 'string') {
      throw new Error('Invalid payload');
    }
    if (opts.smoke) {
      writeFileSync(opts.smoke.presetFilePath, payload.content, 'utf-8');
      return { filePath: opts.smoke.presetFilePath };
    }
    const result = await dialog.showSaveDialog({
      title: '导出版式预设',
      defaultPath: payload.suggestedName,
      filters: [{ name: '预设 JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { filePath: null };
    writeFileSync(result.filePath, payload.content, 'utf-8');
    return { filePath: result.filePath };
  });

  // ==================== 0005（只增）：feedback 输出 IO ====================

  // file.exportTextFile — 文本文件导出（保存对话框 + 写文本）；取消 → { filePath: null }
  ipcMain.handle(IPC_CHANNELS.FILE_EXPORT_TEXT_FILE, async (_event, payload) => {
    if (!payload || typeof payload.suggestedName !== 'string' || typeof payload.content !== 'string') {
      throw new Error('Invalid payload');
    }
    if (opts.smoke?.textExportPath) {
      writeFileSync(opts.smoke.textExportPath, payload.content, 'utf-8');
      return { filePath: opts.smoke.textExportPath };
    }
    const result = await dialog.showSaveDialog({
      title: '导出反馈文本',
      defaultPath: payload.suggestedName,
      filters: [{ name: '文本', extensions: ['txt'] }],
    });
    if (result.canceled || !result.filePath) return { filePath: null };
    writeFileSync(result.filePath, payload.content, 'utf-8');
    return { filePath: result.filePath };
  });

  // feedback.exportCards — 卡片图片批量导出（选目录 → 逐卡临时 html → capturePage → PNG；逐卡容错）
  ipcMain.handle(IPC_CHANNELS.FEEDBACK_EXPORT_CARDS, async (_event, payload): Promise<FeedbackExportCardsResult> => {
    if (!payload || !Array.isArray(payload.cards)) throw new Error('Invalid payload');
    for (const card of payload.cards) {
      if (!card || typeof card.fileName !== 'string' || typeof card.html !== 'string') {
        throw new Error('Invalid card entry');
      }
      if (card.width !== undefined && (typeof card.width !== 'number' || card.width <= 0)) throw new Error('Invalid card width');
      if (card.height !== undefined && (typeof card.height !== 'number' || card.height <= 0)) throw new Error('Invalid card height');
    }

    // 输出目录：正常=用户选；smoke=固定目录
    let outDir: string;
    if (opts.smoke?.cardsOutputDir) {
      outDir = opts.smoke.cardsOutputDir;
    } else {
      const picked = await dialog.showOpenDialog({
        title: '选择卡片图片保存目录',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (picked.canceled || picked.filePaths.length === 0) {
        return { dir: '', count: 0, failed: [] };
      }
      outDir = picked.filePaths[0];
    }
    mkdirSync(outDir, { recursive: true });

    // 卡片 html 中 data-assets/ 相对引用 → file:/// 绝对路径（临时 html 在 tmp 目录，
    // 相对引用解析不到 userData/data/assets；本地实现零依赖 docgen/render 域）
    const assetsRoot = join(opts.dataDir, 'assets').replace(/\\/g, '/').replace(/\/+$/, '');
    const fileUrlPrefix = `file:///${assetsRoot.replace(/^\/+/, '')}`;
    const rewriteDataAssets = (html: string): string => html.replace(
      /src=(["'])data-assets\/([^"']+)\1/g,
      (_m, quote: string, rel: string) => `src=${quote}${fileUrlPrefix}/${rel}${quote}`,
    );

    const failed: Array<{ fileName: string; error: string }> = [];
    let count = 0;
    const tmpDir = join(tmpdir(), 'mofang-feedback-cards');
    mkdirSync(tmpDir, { recursive: true });
    // zoom-to-fit：Windows 会把高于工作区的窗口内容钳短（实测 1000px 卡截到 884 DIP），
    // 以「视口=卡片×zoom」绕开钳位，保证整卡入帧无白边；工作区足够（100% 缩放大屏）时 zoom=1，
    // PNG=精确设计尺寸。物理像素 = 视口 DIP × 设备缩放。
    const { screen } = require('electron') as typeof import('electron');
    const workArea = screen.getPrimaryDisplay().workAreaSize;

    for (const card of payload.cards) {
      const safeName = card.fileName.replace(/[\\/:*?"<>|]/g, '_');
      const tmpHtmlPath = join(tmpDir, `${Date.now()}-${safeName}.html`);
      try {
        writeFileSync(tmpHtmlPath, rewriteDataAssets(card.html), 'utf-8');
        const width = card.width ?? 750;
        const height = card.height ?? 1000;
        const zoom = Math.min(1, (workArea.width - 40) / width, (workArea.height - 80) / height);
        const viewW = Math.ceil(width * zoom);
        const viewH = Math.ceil(height * zoom);
        const cardWindow = new BrowserWindow({
          show: false,
          useContentSize: true,
          width: viewW,
          height: viewH,
          webPreferences: { nodeIntegration: false, contextIsolation: true, zoomFactor: zoom },
        });
        await cardWindow.loadFile(tmpHtmlPath);
        // 窗口视口（zoom 换算后）恰为整卡 → capturePage 输出=卡片完整无白边
        const image = await cardWindow.webContents.capturePage();
        cardWindow.close();
        writeFileSync(join(outDir, `${safeName}.png`), image.toPNG());
        count += 1;
      } catch (err) {
        failed.push({ fileName: safeName, error: err instanceof Error ? err.message : String(err) });
      } finally {
        try { unlinkSync(tmpHtmlPath); } catch { /* 忽略清理失败 */ }
      }
    }

    return { dir: outDir, count, failed };
  });
}

/**
 * 0023（只增）：ai.* 通道接线——模型配置体系（五角色档案 + Key 托管 + invoke 代理）。
 * 业务编排全在 AiGateway（src/shell/ai/）；handler 只做 payload 形验 + 透传（既有模式）。
 * D-043：密文/明文转换在网关完成，handler 层不触 Key；getter 闭包对齐 P0-2 重建语义。
 */
export function registerAiIpcHandlers(getAi: () => AiGateway) {
  const requireObj = (value: unknown, name: string): Record<string, unknown> => {
    if (!value || typeof value !== 'object') throw new Error(`Invalid ${name}`);
    return value as Record<string, unknown>;
  };
  const requireStr = (value: unknown, name: string): string => {
    if (typeof value !== 'string' || !value) throw new Error(`Invalid ${name}`);
    return value;
  };

  ipcMain.handle(IPC_CHANNELS.AI_PROFILE_LIST, async (_event, payload) => {
    return getAi().listProfiles(payload ?? {});
  });

  ipcMain.handle(IPC_CHANNELS.AI_PROFILE_CREATE, async (_event, payload) => {
    const data = requireObj(requireObj(payload, 'payload').data, 'payload.data');
    if (!MODEL_ROLES.includes(data.role as never)) throw new Error('Invalid payload.data.role');
    return getAi().createProfile(payload as AiProfileCreatePayload);
  });

  ipcMain.handle(IPC_CHANNELS.AI_PROFILE_UPDATE, async (_event, payload) => {
    const raw = requireObj(payload, 'payload');
    requireStr(raw.id, 'payload.id');
    requireObj(raw.data, 'payload.data');
    return getAi().updateProfile(payload as AiProfileUpdatePayload);
  });

  ipcMain.handle(IPC_CHANNELS.AI_PROFILE_DELETE, async (_event, payload) => {
    requireStr(requireObj(payload, 'payload').id, 'payload.id');
    return getAi().deleteProfile(payload as AiProfileIdPayload);
  });

  ipcMain.handle(IPC_CHANNELS.AI_PROFILE_SET_ENABLED, async (_event, payload) => {
    const raw = requireObj(payload, 'payload');
    requireStr(raw.id, 'payload.id');
    if (typeof raw.enabled !== 'boolean') throw new Error('Invalid payload.enabled');
    return getAi().setEnabled(payload as AiProfileSetEnabledPayload);
  });

  ipcMain.handle(IPC_CHANNELS.AI_PROFILE_TEST_CONNECTION, async (_event, payload) => {
    requireStr(requireObj(payload, 'payload').profileId, 'payload.profileId');
    return getAi().testConnection(payload as AiProfileTestConnectionPayload);
  });

  ipcMain.handle(IPC_CHANNELS.AI_INVOKE, async (_event, payload) => {
    const raw = requireObj(payload, 'payload');
    if (!MODEL_ROLES.includes(raw.role as never)) throw new Error('Invalid payload.role（五角色之一）');
    if (!Array.isArray(raw.messages) || raw.messages.length === 0) throw new Error('Invalid payload.messages（不能为空）');
    return getAi().invoke(payload as AiInvokePayload);
  });

  // 0023 目检返工 R3（只增）：获取模型列表（profileId 或 baseUrl+apiKey 至少其一；余校验在网关，ok:false 结果形态）
  ipcMain.handle(IPC_CHANNELS.AI_MODELS_LIST, async (_event, payload) => {
    const raw = requireObj(payload, 'payload');
    const hasProfile = typeof raw.profileId === 'string' && raw.profileId !== '';
    const hasDirect = typeof raw.baseUrl === 'string' && raw.baseUrl !== '';
    if (!hasProfile && !hasDirect) throw new Error('Invalid payload：profileId 与 baseUrl 至少提供一个');
    return getAi().listModels(payload as AiModelsListPayload);
  });
}

/**
 * 0028（只增）：recog.run.* 通道接线——识别 run 任务化（素材收件 + 编排 + 状态回读）。
 * 业务编排全在 RecogHost（src/shell/recog/）；handler 只做 payload 形验 + 透传（既有模式）。
 * Key 红线（D-043）：识别经 ai.invoke 走视线角色档案，本层不触任何 Key；
 * 大产物不过桥（T-07）：上行只有 base64 素材，下行只有状态/草稿。
 */
export function registerRecogIpcHandlers(
  getRecog: () => RecogHost,
  /** 0044（只增，可选）：recog.saveAsPaper 编排依赖注入——db 事务边界 + bank/ext service getter。
   *  缺省不注册该通道（旧调用点/测试零影响）。getter 闭包对齐 reloadDatabase 重建语义。 */
  saveAsPaperDeps?: { getDb: () => Database; getBank: () => BankService; getExt: () => BankExtServices },
) {
  const requireObj = (value: unknown, name: string): Record<string, unknown> => {
    if (!value || typeof value !== 'object') throw new Error(`Invalid ${name}`);
    return value as Record<string, unknown>;
  };
  const requireStr = (value: unknown, name: string): string => {
    if (typeof value !== 'string' || !value) throw new Error(`Invalid ${name}`);
    return value;
  };
  const requireRunId = (payload: unknown): string =>
    requireStr(requireObj(payload, 'payload').runId, 'payload.runId');

  ipcMain.handle(IPC_CHANNELS.RECOG_RUN_CREATE, async (_event, payload) => {
    const raw = requireObj(payload, 'payload');
    if (!Array.isArray(raw.materials) || raw.materials.length === 0) {
      throw new Error('Invalid payload.materials（至少一项素材）');
    }
    raw.materials.forEach((m, i) => {
      const item = requireObj(m, `payload.materials[${i}]`);
      requireStr(item.name, `payload.materials[${i}].name`);
      requireStr(item.mime, `payload.materials[${i}].mime`);
      requireStr(item.dataBase64, `payload.materials[${i}].dataBase64`);
    });
    // 0046 P5.2（只增）：sourceName 可选，传了必须是非空字符串
    if (raw.sourceName !== undefined) requireStr(raw.sourceName, 'payload.sourceName');
    return getRecog().createRun(payload as RecogRunCreatePayload);
  });

  ipcMain.handle(IPC_CHANNELS.RECOG_RUN_STATUS, async (_event, payload) => {
    return getRecog().status(requireRunId(payload));
  });

  ipcMain.handle(IPC_CHANNELS.RECOG_RUN_CANCEL, async (_event, payload) => {
    return getRecog().cancel(requireRunId(payload));
  });

  ipcMain.handle(IPC_CHANNELS.RECOG_RUN_HISTORY, async (_event, payload) => {
    const raw = payload === undefined || payload === null ? {} : requireObj(payload, 'payload');
    const limit = raw.limit;
    if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1)) {
      throw new Error('Invalid payload.limit（正整数字或缺省）');
    }
    return getRecog().history(limit as number | undefined);
  });

  ipcMain.handle(IPC_CHANNELS.RECOG_RUN_ATTACH_QUESTIONS, async (_event, payload) => {
    const raw = requireObj(payload, 'payload');
    const runId = requireStr(raw.runId, 'payload.runId');
    if (!Array.isArray(raw.questionIds) || raw.questionIds.some((q) => typeof q !== 'string' || q === '')) {
      throw new Error('Invalid payload.questionIds（非空字符串数组）');
    }
    return getRecog().attachQuestions(runId, raw.questionIds as string[]);
  });

  ipcMain.handle(IPC_CHANNELS.RECOG_RUN_RESUME, async (_event, payload) => {
    return getRecog().resume(requireRunId(payload));
  });

  // 0040（只增）：工作台卡流文件态（形验：runId 字符串；save 另验 state 对象与 runId 一致）
  ipcMain.handle(IPC_CHANNELS.RECOG_WORKBENCH_LOAD, async (_event, payload) => {
    return getRecog().loadWorkbench({ runId: requireRunId(payload) });
  });

  ipcMain.handle(IPC_CHANNELS.RECOG_WORKBENCH_SAVE, async (_event, payload) => {
    const raw = requireObj(payload, 'payload');
    const runId = requireStr(raw.runId, 'payload.runId');
    const state = requireObj(raw.state, 'payload.state');
    if (state.runId !== runId) {
      throw new Error('Invalid payload.state.runId（须与 payload.runId 一致）');
    }
    if (!Array.isArray(state.cards)) throw new Error('Invalid payload.state.cards（数组）');
    return getRecog().saveWorkbench(payload as RecogWorkbenchSavePayload);
  });

  // 0046（只增）：recog.draft.write——Onestep 草稿写回 run（形验 + 透传；转换/落盘/状态同步全在 host）
  ipcMain.handle(IPC_CHANNELS.RECOG_DRAFT_WRITE, async (_event, payload) => {
    const raw = requireObj(payload, 'payload');
    requireStr(raw.runId, 'payload.runId');
    if (!Array.isArray(raw.drafts)) throw new Error('Invalid payload.drafts（数组）');
    raw.drafts.forEach((d, i) => requireObj(d, `payload.drafts[${i}]`));
    return getRecog().draftWrite(payload as RecogDraftWritePayload);
  });

  // 0044（只增）：recog.saveAsPaper——「存为试卷」主进程一步编排（形验 + 组装注入依赖）。
  // 编排顺序与失败口径见 SaveAsPaperService（题保留、卷不建；建卷+挂题单事务）。
  if (saveAsPaperDeps) {
    ipcMain.handle(IPC_CHANNELS.RECOG_SAVE_AS_PAPER, async (_event, payload) => {
      const raw = requireObj(payload, 'payload');
      const runId = requireStr(raw.runId, 'payload.runId');
      const title = requireStr(raw.title, 'payload.title');
      const subject = requireStr(raw.subject, 'payload.subject');
      if (raw.folderId !== undefined && typeof raw.folderId !== 'string') throw new Error('Invalid payload.folderId');
      if (raw.subjectId !== undefined && typeof raw.subjectId !== 'string') throw new Error('Invalid payload.subjectId');
      if (raw.paperTitle !== undefined && typeof raw.paperTitle !== 'string') throw new Error('Invalid payload.paperTitle');
      // 0062（只增）：stage 形验（字符串；缺省/undefined 不收该键 → 读侧按「未分组」归一）
      if (raw.stage !== undefined && typeof raw.stage !== 'string') throw new Error('Invalid payload.stage');
      if (!Array.isArray(raw.cards) || raw.cards.length === 0) {
        throw new Error('Invalid payload.cards（非空数组）');
      }
      const cards = raw.cards.map((card, index) => {
        const c = requireObj(card, `payload.cards[${index}]`);
        const qno = c.qno === null ? null : requireStr(c.qno, `payload.cards[${index}].qno`);
        // typeCode 允许空串（'' = 题型未定，0040 卡口径）
        if (typeof c.typeCode !== 'string') throw new Error(`Invalid payload.cards[${index}].typeCode`);
        requireStr(c.contentHtml, `payload.cards[${index}].contentHtml`);
        if (typeof c.answerHtml !== 'string' || typeof c.analysisHtml !== 'string' || typeof c.pageNo !== 'number') {
          throw new Error(`Invalid payload.cards[${index}]`);
        }
        if (!Array.isArray(c.adoptedTags) || c.adoptedTags.some((t) => typeof t !== 'string')) {
          throw new Error(`Invalid payload.cards[${index}].adoptedTags`);
        }
        let adoptedNode: RecogSaveAsPaperPayload['cards'][number]['adoptedNode'] = null;
        if (c.adoptedNode !== null && c.adoptedNode !== undefined) {
          const node = requireObj(c.adoptedNode, `payload.cards[${index}].adoptedNode`);
          adoptedNode = { nodeId: requireStr(node.nodeId, 'adoptedNode.nodeId'), label: requireStr(node.label, 'adoptedNode.label') };
        }
        // 0054（只增）：adoptedNodes 多值逐条形验（数组 + 每项 nodeId/label 字符串）；
        // 缺省/undefined → 不下发该键（主进程回落单值 adoptedNode 口径，旧调用方零影响）
        let adoptedNodes: RecogSaveAsPaperPayload['cards'][number]['adoptedNodes'];
        if (c.adoptedNodes !== undefined && c.adoptedNodes !== null) {
          if (!Array.isArray(c.adoptedNodes)) throw new Error(`Invalid payload.cards[${index}].adoptedNodes（数组）`);
          adoptedNodes = c.adoptedNodes.map((n, j) => {
            const node = requireObj(n, `payload.cards[${index}].adoptedNodes[${j}]`);
            return {
              nodeId: requireStr(node.nodeId, `payload.cards[${index}].adoptedNodes[${j}].nodeId`),
              label: requireStr(node.label, `payload.cards[${index}].adoptedNodes[${j}].label`),
            };
          });
        }
        // 0057（只增）：images 逐条形验（assetId 字符串 / type 四枚举）；缺省按空数组（旧调用方零影响）
        let images: RecogSaveAsPaperPayload['cards'][number]['images'] = [];
        if (c.images !== undefined && c.images !== null) {
          if (!Array.isArray(c.images)) throw new Error(`Invalid payload.cards[${index}].images（数组）`);
          images = c.images.map((img, j) => {
            const entry = requireObj(img, `payload.cards[${index}].images[${j}]`);
            const assetId = requireStr(entry.assetId, `payload.cards[${index}].images[${j}].assetId`);
            if (typeof entry.type !== 'string' || !QUESTION_IMAGE_TYPES.includes(entry.type as typeof QUESTION_IMAGE_TYPES[number])) {
              throw new Error(`Invalid payload.cards[${index}].images[${j}].type（figure/formula-image/answer-image/analysis-image）`);
            }
            return { assetId, type: entry.type as typeof QUESTION_IMAGE_TYPES[number] };
          });
        }
        return {
          qno,
          typeCode: c.typeCode as string,
          contentHtml: c.contentHtml as string,
          answerHtml: c.answerHtml as string,
          analysisHtml: c.analysisHtml as string,
          pageNo: c.pageNo as number,
          adoptedTags: c.adoptedTags as string[],
          adoptedNode,
          ...(adoptedNodes !== undefined ? { adoptedNodes } : {}),
          images,
        };
      });

      const db = saveAsPaperDeps.getDb();
      const deps: SaveAsPaperDeps = {
        bank: saveAsPaperDeps.getBank(),
        tree: saveAsPaperDeps.getExt().tree,
        paper: saveAsPaperDeps.getExt().paper,
        runs: {
          attachQuestions: async (id, questionIds) => {
            await getRecog().attachQuestions(id, questionIds);
          },
        },
        tx: {
          begin: () => db.exec('BEGIN'),
          commit: () => db.exec('COMMIT'),
          rollback: () => db.exec('ROLLBACK'),
        },
      };
      return new SaveAsPaperService(deps).saveAsPaper({
        runId,
        title,
        subject,
        cards,
        ...(raw.folderId !== undefined ? { folderId: raw.folderId as string } : {}),
        ...(raw.subjectId !== undefined ? { subjectId: raw.subjectId as string } : {}),
        ...(raw.paperTitle !== undefined ? { paperTitle: raw.paperTitle as string } : {}),
        // 0062（只增）：学段透传（收空串按缺省口径——「学段不限」与不传同义）
        ...(raw.stage ? { stage: raw.stage as string } : {}),
      });
    });
  }
}

/**
 * 0036（只增）：split.* 通道接线——PDF 切题工作区（D-051 / R-027）。
 * 工作区文件态全在 SplitHost（src/shell/splitting/）；handler 只做 payload 形验 + 透传（既有模式）。
 * 深校验（段页码越界 / 源文件字节数 / 路径穿越）在宿主内做——handler 不复制业务规则，避免双轨漂移。
 */
export function registerSplitIpcHandlers(getSplit: () => SplitHost) {
  const requireObj = (value: unknown, name: string): Record<string, unknown> => {
    if (!value || typeof value !== 'object') throw new Error(`Invalid ${name}`);
    return value as Record<string, unknown>;
  };
  const requireStr = (value: unknown, name: string): string => {
    if (typeof value !== 'string' || !value) throw new Error(`Invalid ${name}`);
    return value;
  };
  const requireInt = (value: unknown, name: string, min: number): number => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min) throw new Error(`Invalid ${name}`);
    return value;
  };
  const requireProjectId = (payload: unknown): string => {
    const raw = requireObj(payload, 'payload');
    return requireStr(raw.projectId, 'payload.projectId');
  };

  ipcMain.handle(IPC_CHANNELS.SPLIT_PROJECT_CREATE, async (_event, payload) => {
    const raw = requireObj(payload, 'payload');
    const sourceName = requireStr(raw.sourceName, 'payload.sourceName');
    const sourceBytes = requireInt(raw.sourceBytes, 'payload.sourceBytes', 0);
    const name = raw.name === undefined ? undefined : requireStr(raw.name, 'payload.name');
    return getSplit().createProject({ sourceName, sourceBytes, ...(name !== undefined ? { name } : {}) });
  });

  ipcMain.handle(IPC_CHANNELS.SPLIT_PROJECT_SAVE_META, async (_event, payload) => {
    const raw = requireObj(payload, 'payload');
    const projectId = requireStr(raw.projectId, 'payload.projectId');
    const pageCount = requireInt(raw.pageCount, 'payload.pageCount', 0);
    if (!Array.isArray(raw.segments)) throw new Error('Invalid payload.segments（切段数组）');
    raw.segments.forEach((seg, i) => {
      const item = requireObj(seg, `payload.segments[${i}]`);
      requireStr(item.id, `payload.segments[${i}].id`);
      requireStr(item.title, `payload.segments[${i}].title`);
      requireInt(item.fromPage, `payload.segments[${i}].fromPage`, 1);
      requireInt(item.toPage, `payload.segments[${i}].toPage`, 1);
    });
    return getSplit().saveMeta({ projectId, pageCount, segments: raw.segments as SplitSegment[] });
  });

  ipcMain.handle(IPC_CHANNELS.SPLIT_PROJECT_SAVE_DRAFT, async (_event, payload) => {
    const raw = requireObj(payload, 'payload');
    const projectId = requireStr(raw.projectId, 'payload.projectId');
    requireObj(raw.draft, 'payload.draft');
    return getSplit().saveDraft({ projectId, draft: raw.draft as SplitDraft });
  });

  ipcMain.handle(IPC_CHANNELS.SPLIT_PROJECT_LIST, async () => {
    return getSplit().listProjects();
  });

  ipcMain.handle(IPC_CHANNELS.SPLIT_PROJECT_OPEN, async (_event, payload) => {
    return getSplit().openProject({ projectId: requireProjectId(payload) });
  });

  ipcMain.handle(IPC_CHANNELS.SPLIT_PROJECT_REMOVE, async (_event, payload) => {
    await getSplit().removeProject({ projectId: requireProjectId(payload) });
  });

  ipcMain.handle(IPC_CHANNELS.SPLIT_SOURCE_APPEND, async (_event, payload) => {
    const raw = requireObj(payload, 'payload');
    const projectId = requireStr(raw.projectId, 'payload.projectId');
    const offset = requireInt(raw.offset, 'payload.offset', 0);
    const dataBase64 = requireStr(raw.dataBase64, 'payload.dataBase64');
    return getSplit().appendSource({ projectId, offset, dataBase64 });
  });

  ipcMain.handle(IPC_CHANNELS.SPLIT_SOURCE_READ, async (_event, payload) => {
    const raw = requireObj(payload, 'payload');
    const projectId = requireStr(raw.projectId, 'payload.projectId');
    const offset = requireInt(raw.offset, 'payload.offset', 0);
    const length = requireInt(raw.length, 'payload.length', 1);
    return getSplit().readSource({ projectId, offset, length });
  });

  ipcMain.handle(IPC_CHANNELS.SPLIT_PAGE_WRITE, async (_event, payload) => {
    const raw = requireObj(payload, 'payload');
    const projectId = requireStr(raw.projectId, 'payload.projectId');
    const pageNo = requireInt(raw.pageNo, 'payload.pageNo', 1);
    const dataBase64 = requireStr(raw.dataBase64, 'payload.dataBase64');
    return getSplit().writePage({ projectId, pageNo, dataBase64 });
  });

  ipcMain.handle(IPC_CHANNELS.SPLIT_PAGE_READ, async (_event, payload) => {
    const raw = requireObj(payload, 'payload');
    const projectId = requireStr(raw.projectId, 'payload.projectId');
    const pageNo = requireInt(raw.pageNo, 'payload.pageNo', 1);
    return getSplit().readPage({ projectId, pageNo });
  });
}

/**
 * 0029（只增）：ai.suggest.* 通道接线——AI 挂树/打标建议（D-050：≤4 层单次注入 + NONE + 必人确认）。
 * 业务编排全在 AiSuggestHost（src/shell/ai/suggest-host.ts）；handler 只做 payload 形验 + 透传（既有模式）。
 * 纯读面（P-07）：锚点状态回执 + 建议产出；确认写入由 renderer 回走 tree.linkQuestion / bank.addTag。
 */
export function registerAiSuggestIpcHandlers(getSuggest: () => AiSuggestHost) {
  const requireObj = (value: unknown, name: string): Record<string, unknown> => {
    if (!value || typeof value !== 'object') throw new Error(`Invalid ${name}`);
    return value as Record<string, unknown>;
  };
  const requireStr = (value: unknown, name: string): string => {
    if (typeof value !== 'string' || !value) throw new Error(`Invalid ${name}`);
    return value;
  };

  /** AnchorQuery 形验：subjectId 必填非空；stage/edition 可选非空串（缺省=不限） */
  const requireQuery = (raw: Record<string, unknown>): AiAnchorStatusPayload['query'] => {
    const query = requireObj(raw.query, 'payload.query');
    const subjectId = requireStr(query.subjectId, 'payload.query.subjectId');
    const stage = typeof query.stage === 'string' ? query.stage : '';
    const edition = typeof query.edition === 'string' ? query.edition : undefined;
    return {
      subjectId,
      ...(stage ? { stage } : {}),
      ...(edition ? { edition } : {}),
    };
  };

  ipcMain.handle(IPC_CHANNELS.AI_ANCHOR_STATUS, async (_event, payload) => {
    const raw = requireObj(payload, 'payload');
    return getSuggest().anchorStatus({ query: requireQuery(raw) });
  });

  const requireSuggestPayload = (payload: unknown): AiSuggestPayload => {
    const raw = requireObj(payload, 'payload');
    const questionIds = raw.questionIds;
    if (!Array.isArray(questionIds) || questionIds.length === 0 || questionIds.some((q) => typeof q !== 'string' || q === '')) {
      throw new Error('Invalid payload.questionIds（非空字符串数组）');
    }
    return { questionIds: questionIds as string[], query: requireQuery(raw) };
  };

  ipcMain.handle(IPC_CHANNELS.AI_SUGGEST_TREE, async (_event, payload) => {
    return getSuggest().suggestTree(requireSuggestPayload(payload));
  });

  ipcMain.handle(IPC_CHANNELS.AI_SUGGEST_TAGS, async (_event, payload) => {
    return getSuggest().suggestTags(requireSuggestPayload(payload));
  });

  // 0040（只增）：工作台草稿挂树建议——题面来源是草稿文本（尚未入库），锚点链口径不变
  ipcMain.handle(IPC_CHANNELS.AI_SUGGEST_TREE_FOR_DRAFT, async (_event, payload) => {
    const raw = requireObj(payload, 'payload');
    const stemText = requireStr(raw.stemText, 'payload.stemText');
    // 0040 返工⑥：subjectId 形验放宽为「可选字符串」——空学科是合法起步态，
    // 在这里抛 Invalid payload 只会把用户推进死胡同；具体原因由业务层给（见 AiSuggestHost.treeForDraft）
    const subjectId = typeof raw.subjectId === 'string' ? raw.subjectId : '';
    const stage = typeof raw.stage === 'string' ? raw.stage : '';
    return getSuggest().treeForDraft({
      subjectId,
      stemText,
      ...(stage ? { stage } : {}),
    });
  });
}

/**
 * 0056（只增）：bank.question.aiClean —— 采集题 AI 整理（R-041）接线。
 * 业务编排全在 `question-ai-clean.ts`（本 handler 只做 payload 形验 + getter 闭包取面，既有模式）；
 * 库/台账/L 面一律懒取（reloadDatabase 重建服务实例后 handler 自动指向新实例，对齐 P0-2 语义）。
 * 模型调用经注入的 invoke（= aiGateway.invoke，D-043：本层不触 Key）。
 */
export interface QuestionAiCleanIpcDeps {
  getBank: () => BankService;
  /** 模型调用腿（aiGateway.invoke） */
  invoke: (payload: AiInvokePayloadType) => Promise<AiInvokeResultType>;
  /** userData/data 目录（资产根 data/assets） */
  dataDir: string;
  /**
   * 0056 目检返工①/⑥：图片准备器（SVG/小位图 → canvas 栅格化 + 留白；大位图原样过桥）——
   * 真机由 main.ts 注入 `createAiCleanImagePreparer()`。缺省 = 编排层保守口径（SVG 显式报错）。
   */
  prepareImages?: AiCleanImagePreparer;
  /** operation_log 面（懒取：库句柄随 reloadDatabase 重建） */
  logger?: () => AiCleanLogger;
}

export function registerQuestionAiCleanIpcHandlers(deps: QuestionAiCleanIpcDeps): void {
  const requireObj = (value: unknown, name: string): Record<string, unknown> => {
    if (!value || typeof value !== 'object') throw new Error(`Invalid ${name}`);
    return value as Record<string, unknown>;
  };
  const requireIds = (value: unknown, name: string): string[] => {
    if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || id === '')) {
      throw new Error(`Invalid ${name}（字符串数组）`);
    }
    return value as string[];
  };
  const requireImages = (value: unknown): Array<{ assetId: string; type: QuestionImageType }> => {
    if (!Array.isArray(value)) throw new Error('Invalid items[].images（数组）');
    for (const entry of value) {
      const row = requireObj(entry, 'items[].images[]');
      if (typeof row.assetId !== 'string' || row.assetId === '') throw new Error('Invalid items[].images[].assetId');
      if (!QUESTION_IMAGE_TYPES.includes(row.type as never)) throw new Error('Invalid items[].images[].type（四枚举之一）');
    }
    return value as Array<{ assetId: string; type: QuestionImageType }>;
  };

  ipcMain.handle(IPC_CHANNELS.QUESTION_AI_CLEAN, async (_event, payload) => {
    const raw = requireObj(payload, 'payload');
    if (!QUESTION_AI_CLEAN_MODES.includes(raw.mode as never)) throw new Error('Invalid payload.mode（preview|commit）');
    const questionIds = requireIds(raw.questionIds, 'payload.questionIds');
    const logger = deps.logger?.();

    if (raw.mode === 'preview') {
      const items = await previewQuestionAiClean({
        getQuestion: (id) => deps.getBank().getQuestion(id) as Promise<AiCleanQuestionLike | null>,
        updateQuestion: (id, patch) => deps.getBank().updateQuestion(id, patch),
        dataDir: deps.dataDir,
        invoke: deps.invoke,
        ...(deps.prepareImages ? { prepareImages: deps.prepareImages } : {}),
      }, questionIds);
      return { mode: 'preview' as const, items, saved: 0, failed: [] };
    }

    if (!Array.isArray(raw.items)) throw new Error('Invalid payload.items（commit 必填数组）');
    const items = raw.items.map((entry, index) => {
      const item = requireObj(entry, `payload.items[${index}]`);
      const questionId = item.questionId;
      if (typeof questionId !== 'string' || questionId === '') throw new Error(`Invalid payload.items[${index}].questionId`);
      for (const field of ['content', 'answer', 'analysis'] as const) {
        if (typeof item[field] !== 'string') throw new Error(`Invalid payload.items[${index}].${field}`);
      }
      return {
        questionId,
        content: item.content as string,
        answer: item.answer as string,
        analysis: item.analysis as string,
        images: requireImages(item.images),
      };
    });
    const result = await commitQuestionAiClean({
      getQuestion: (id) => deps.getBank().getQuestion(id) as Promise<AiCleanQuestionLike | null>,
      updateQuestion: (id, patch) => deps.getBank().updateQuestion(id, patch),
      dataDir: deps.dataDir,
      invoke: deps.invoke,
      ...(deps.prepareImages ? { prepareImages: deps.prepareImages } : {}),
      ...(logger ? { logger } : {}),
    }, items);
    return { mode: 'commit' as const, items: [], saved: result.saved, failed: result.failed };
  });
}

/**
 * 0066（只增）：diag.* 通道接线（可运维性一期 / R-002）
 *
 * 范式同 registerGuardIpcHandlers：主进程弹 dialog → 调组装器 → 返回 {success, path} / {canceled}。
 *  - 库面经 getDb getter 闭包（reloadDatabase 重建后自动指向新实例）；本文件只取各表行数，
 *    不 SELECT 任何列值——模型档案的密钥密文列因此天然不进包（与 diag 模块的排除清单互为双保险）。
 *  - --smoke-diag：由 smokeOutputPath 指定落点，跳过 dialog（自证/探针分支；正常启动为 undefined）。
 *  - 成败均写 operation_log（operation_type='diag.export'，BackupCard/guard 台账同范式）。
 */
export function registerDiagIpcHandlers(deps: {
  getDb: () => import('../bank/db.js').Database;
  userDataPath: string;
  dataDir: string;
  appVersion: string;
  smokeOutputPath?: string;
}): void {
  const electronVersion = process.versions.electron ?? 'unknown';

  const listTableCounts = (): DiagnosticTableCount[] => {
    const db = deps.getDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    return tables.map((table) => ({
      name: table.name,
      // 只计行数，不读列值（脱敏统计口径：包内只有数字）
      count: (db.prepare(`SELECT COUNT(*) AS c FROM "${table.name}"`).get() as { c: number }).c,
    }));
  };

  const writeOperationLog = (
    status: 'succeeded' | 'failed',
    description: string,
    metadata: Record<string, unknown>,
    affectedCount: number
  ): void => {
    try {
      const now = new Date().toISOString();
      deps
        .getDb()
        .prepare(
          'INSERT INTO operation_log (id, operation_type, started_at, finished_at, status, affected_count, description, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(crypto.randomUUID(), 'diag.export', now, now, status, affectedCount, description, JSON.stringify(metadata));
    } catch {
      // 台账失败不改变导出结论（尽力而为，与 backup-service 同口径）
    }
  };

  // diag.exportDiagnostics — 主进程弹保存对话框，组装诊断包 zip
  ipcMain.handle(IPC_CHANNELS.DIAG_EXPORT_DIAGNOSTICS, async (): Promise<DiagExportResult> => {
    try {
      let outputPath: string;
      if (deps.smokeOutputPath) {
        outputPath = deps.smokeOutputPath;
      } else {
        const picked = await dialog.showSaveDialog({
          title: '导出诊断包',
          defaultPath: `mofang-diagnostics-${new Date().toISOString().slice(0, 10)}.zip`,
          filters: [
            { name: '诊断包', extensions: ['zip'] },
            { name: '所有文件', extensions: ['*'] },
          ],
        });
        if (picked.canceled || !picked.filePath) {
          diagLog('info', 'diag', '诊断包导出已取消（用户关闭保存对话框）');
          return { success: false, canceled: true };
        }
        outputPath = picked.filePath;
      }

      const built = buildDiagnosticsPackage({
        outputPath,
        userDataPath: deps.userDataPath,
        dataDir: deps.dataDir,
        appVersion: deps.appVersion,
        electronVersion,
        getTableCounts: listTableCounts,
      });

      if (!built.success) {
        diagLog('error', 'diag', `诊断包导出失败：${built.error}`, { error: built.error });
        writeOperationLog('failed', `Export diagnostics failed: ${built.error}`, { error: built.error }, 0);
        return { success: false, error: built.error };
      }

      writeOperationLog(
        'succeeded',
        `Export diagnostics to ${built.path}: ${built.entries.length} files`,
        { path: built.path, entries: built.entries },
        built.entries.length
      );
      diagLog('info', 'diag', `诊断包已导出：${built.path}`, { entries: built.entries.length });
      return { success: true, path: built.path };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      diagLog('error', 'diag', `诊断包导出异常：${message}`, { error: message });
      return { success: false, error: message };
    }
  });
}

/**
 * 0071（只增）：dataLocation.* 通道接线（自定义数据保存位置 / R-043）
 *
 * - get：实时读引导配置（pending 与上次失败留痕），生效位置与来源取启动解析结果（进程内不变）。
 * - change：targetDir 缺省弹系统目录选择框（正常 UI 路径）；校验（绝对路径 / 空目录或不存在 /
 *   不与当前位置互为包含）通过才写 pending —— 正式位置不动，等重启迁移成功再翻转（任务书 §一.3）。
 * - cancel：清 pending，保留正式生效位置。
 * 写 pending 只影响下次启动：本进程不做热切换（任务书 §一「明确不做」）。
 */
export function registerDataLocationIpcHandlers(deps: {
  configPath: string;
  userDataPath: string;
  source: DataLocationSource;
  portable: boolean;
}): void {
  const runtime: DataLocationRuntime = {
    configPath: deps.configPath,
    userDataPath: deps.userDataPath,
    source: deps.source,
    portable: deps.portable,
  };

  ipcMain.handle(IPC_CHANNELS.DATA_LOCATION_GET, async (): Promise<DataLocationInfo> =>
    describeDataLocation(runtime),
  );

  ipcMain.handle(
    IPC_CHANNELS.DATA_LOCATION_CHANGE,
    async (_event, payload: DataLocationChangePayload | undefined): Promise<DataLocationChangeResult> => {
      let targetDir =
        typeof payload?.targetDir === 'string' && payload.targetDir.trim() !== '' ? payload.targetDir.trim() : null;
      if (targetDir === null && typeof payload?.targetDir === 'string') {
        return { success: false, error: '目标目录不能为空' };
      }
      if (targetDir === null) {
        const picked = await dialog.showOpenDialog({
          title: '选择数据保存位置',
          buttonLabel: '选为数据位置',
          properties: ['openDirectory', 'createDirectory'],
        });
        if (picked.canceled || picked.filePaths.length === 0) return { success: false, canceled: true };
        targetDir = picked.filePaths[0];
      }

      const result = changeDataLocation(runtime, targetDir);
      if (result.success) {
        diagLog('info', 'data-location', `已登记数据位置变更（重启后迁移）：${result.pendingDataRoot}`, {
          targetDir: result.pendingDataRoot,
        });
      } else {
        diagLog('warn', 'data-location', `数据位置变更被拒：${result.error}`, { targetDir, error: result.error });
      }
      return result;
    },
  );

  ipcMain.handle(IPC_CHANNELS.DATA_LOCATION_CANCEL, async (): Promise<DataLocationCancelResult> => {
    const result = cancelDataLocationChange(runtime);
    diagLog(
      result.success ? 'info' : 'warn',
      'data-location',
      result.success ? '已撤销待迁移的数据位置变更' : `撤销待迁移失败：${result.error}`,
    );
    return result;
  });
}

// 0072（只增）：公告与版本更新通道接线（R-073 发布批 lane A）。
// 服务与回落链在 shell/announce、shell/update（零 electron）；本文件只做通道白名单转发与
// openExternal 的 http(s) 放行——公告条目 links 与更新 downloadUrl 同一出口（防动态下发任意协议）。
export function registerAnnounceIpcHandlers(deps: {
  getSnapshot: () => AnnounceSnapshot;
  refresh: () => Promise<AnnounceSnapshot>;
}): void {
  ipcMain.handle(IPC_CHANNELS.ANNOUNCE_GET, async (): Promise<AnnounceSnapshot> => deps.getSnapshot());
  ipcMain.handle(IPC_CHANNELS.ANNOUNCE_REFRESH, async (): Promise<AnnounceSnapshot> => deps.refresh());
}

export function registerUpdateIpcHandlers(deps: {
  getStatus: () => UpdateStatus;
  checkNow: () => Promise<{ started: boolean }>;
  quitAndInstall: () => void;
}): void {
  ipcMain.handle(IPC_CHANNELS.UPDATE_GET_STATUS, async (): Promise<UpdateStatus> => deps.getStatus());
  ipcMain.handle(IPC_CHANNELS.UPDATE_CHECK_NOW, async () => deps.checkNow());
  // downloaded 后「立即重启」：转发 service（便携版 service 层拦截不装；NSIS 覆盖安装 userData 保留）
  ipcMain.handle(IPC_CHANNELS.UPDATE_QUIT_AND_INSTALL, async () => deps.quitAndInstall());
  // 外链出口统一收口：announce downloadUrl / 条目 links / 手动下载全走本通道（仅放行 http(s)，
  // 防远端动态下发 file:// 等协议；协议校验在主进程，渲染层文案不可信）。
  ipcMain.handle(
    IPC_CHANNELS.UPDATE_OPEN_EXTERNAL,
    async (_event: unknown, url: unknown): Promise<UpdateOpenExternalResult> => {
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
        return { ok: false, error: '仅支持 http(s) 链接' };
      }
      try {
        await shell.openExternal(url);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
}
