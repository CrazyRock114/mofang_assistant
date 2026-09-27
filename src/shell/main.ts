// Phase 3: app-shell 主进程 — 窗口生命周期 + IPC 接线 + PDF 导出

import { app, BrowserWindow, nativeImage } from 'electron';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { inflateSync, inflateRawSync } from 'node:zlib';
import { openDatabase } from '../bank/db.js';
import type { Database } from '../bank/db.js';
import { BankServiceImpl } from '../bank/bank-service.js';
import { OperationLogger } from '../bank/operation-log.js';
import { createExtServices } from '../bank/ext-services.js';
import type { BankExtServices, Paper, PaperLayoutConfig, Question } from '../shared/contracts/bank-types.js';
import { registerIpcHandlers, registerCaptureIpcHandlers, registerGuardIpcHandlers, registerExtIpcHandlers, registerFileIpcHandlers, registerAiIpcHandlers, registerRecogIpcHandlers, registerSplitIpcHandlers, registerAiSuggestIpcHandlers, registerQuestionAiCleanIpcHandlers, paginatePdfWindow } from './ipc.js';
import { CaptureHost } from '../capture/browser/host.js';
// 0023（只增）：模型配置体系——档案 service + AI 网关 + Key 托管工厂
import { ModelProfileServiceImpl } from '../bank/model-profile-service.js';
import { AiGateway } from './ai/ai-gateway.js';
// 0028（只增）：识别 run 宿主（素材收件 + 编排 + 事件广播）
import { RecogHost } from './recog/recog-host.js';
// 0036（只增）：PDF 切题工作区宿主（工作区文件态 IO）
import { SplitHost } from './splitting/split-host.js';
// 0057（只增）：存量录题内联图资产化 backfill（挂在 reloadDatabase 内；见该处注释）
import { runRecogImageBackfill } from './recog-image-backfill.js';
// 0056（只增）：存量采集题小图误判回填（R-064；同挂 reloadDatabase 内，同一份启动期 backfill 机制）
import { runInlineFigureBackfill } from './inline-figure-backfill.js';
// 0056 目检返工①：AI 整理的图片准备器（SVG 公式图栅格化 → PNG；复用 0035 隐藏窗栅格器）
import { createAiCleanImagePreparer } from './ai-clean-image-prep.js';
import { RecogRunServiceImpl } from '../bank/recog-run-service.js';
import { createDefaultKeyVault } from './ai/dpapi-vault.js';
// 0029（只增）：AI 挂树/打标建议宿主 + 锚点快照（bank 只读）
import { AiSuggestHost } from './ai/suggest-host.js';
import { AnchorSnapshotServiceImpl } from '../bank/anchor-snapshot-service.js';
// 0066（只增）：可运维性一期——主进程所需 electron 符号单列一行引进（既有 import 行零改动）
import { ipcMain, dialog, crashReporter } from 'electron';
// 0066（只增）：日志与崩溃捕获（零 electron 依赖；本文件只做挂点）
import { initDiagLogger, installIpcErrorLogging, diagLog } from './diag/logger.js';
import { createCrashWiring } from './diag/crash.js';
// 0066（只增）：diag.* 注册器（单列一行——既有 ipc.js 导入清单零改动）
import { registerDiagIpcHandlers } from './ipc.js';
// 0071（只增）：dataLocation.* 注册器（同 diag 先例：单列一行，既有 ipc.js 导入清单零改动）
import { registerDataLocationIpcHandlers } from './ipc.js';
// 0071（只增）：自定义数据保存位置（R-043）——引导配置 + 启动重定向 + pending 迁移（零 electron 依赖）
import {
  DATA_LOCATION_CONFIG_DIR,
  DATA_LOCATION_CONFIG_FILE,
  resolveBootstrapPlan,
  runPendingMigration,
  type MigrationResult,
} from './data-location.js';
// 0071（只增）：迁移复制复用 guard 公共件（整棵树复制：目录/顶层普通文件/符号链接分类）；迁移前备份复用 guard 备份服务（zip 同源）
import { copyTree } from '../guard/fs-utils.js';
import { createBackup } from '../guard/backup/backup-service.js';
// 0071（只增）：导出资产根单点注入（消除 buildPaperHtml.ts 内自取 userData 的第二真源）
import { setDefaultAssetsRoot } from '../docgen/render/buildPaperHtml.js';
// 0071（只增）：迁移前备份前置判定（旧库是否存在；既有 node:fs 导入行零改动）
import { existsSync } from 'node:fs';
// 0071（只增）：--smoke-appdata 归一为绝对路径（app.setPath 只收绝对路径）
import { resolve as resolvePath } from 'node:path';
// 0071（只增）：db 类值引用（迁移前备份要打开旧库做快照；既有 `import type { Database }` 行零改动）
import { Database as BankDatabase } from '../bank/db.js';
// 0071（只增）：迁移台账（operation_log 留痕）
import { randomUUID } from 'node:crypto';
import type { DataLocationSource } from '../shared/contracts/ipc-channels.js';
// 0072（只增）：公告与版本更新（R-073 发布批 lane A）——端点单一真源 + 公告/更新服务 + 生产适配器
import { MF_ANNOUNCE_URL, MF_UPDATE_FEED_URL } from '../shared/endpoints.js';
import { IPC_CHANNELS } from '../shared/contracts/ipc-channels.js';
import { AnnounceService } from './announce/announce-service.js';
import { UpdateService, createNotAvailableAdapter } from './update/update-service.js';
import { createElectronUpdaterAdapter } from './update/electron-updater-adapter.js';
import { isUsableFeedUrl } from './update/feed-url.js';
// 0072（只增）：公告/更新注册器（同 diag/dataLocation 先例：单列一行，既有 ipc.js 导入清单零改动）
import { registerAnnounceIpcHandlers, registerUpdateIpcHandlers } from './ipc.js';


const isDev = process.env.NODE_ENV === 'development';

let mainWindow: BrowserWindow | null = null;
let bankService: BankServiceImpl | null = null;
let captureHost: CaptureHost | null = null;
// 0003：bank 扩展服务（student/class/exam/mistake/dict/paper_set 等），随 reloadDatabase 重建
let extServices: BankExtServices | null = null;
// P0-2：数据库句柄收进可变容器，恢复后 reloadDatabase() 重建依赖（银行服务/采集宿主随之指向新实例）
let currentDb: Database | null = null;
// 0023（只增）：AI 网关（持 profiles service 引用，随 reloadDatabase 重建；vault 无库态只建一次）
let aiGateway: AiGateway | null = null;
// 0028（只增）：识别 run 宿主（依赖 aiGateway 的 invoke；随 reloadDatabase 重建）
let recogHost: RecogHost | null = null;
// 0036（只增）：PDF 切题工作区宿主（纯文件态，不依赖库句柄；随 reloadDatabase 重建以对齐 getter 语义）
let splitHost: SplitHost | null = null;
// 0029（只增）：AI 挂树/打标建议宿主（依赖 aiGateway invoke + bank 只读；随 reloadDatabase 重建）
let suggestHost: AiSuggestHost | null = null;
// 0072（只增）：公告与更新服务实例（initDatabase 内构造；whenReady 探针分支与启动调度消费）
let announceService: AnnounceService | null = null;
let updateService: UpdateService | null = null;
const aiVault = createDefaultKeyVault();
// 0005：smoke-m6 模式（feedback 模板真链 + 卡片 PNG 落盘探针）
const isSmokeM6 = process.argv.includes('--smoke-m6');
// 0030：smoke-feedback030 模式（反馈模块真链 + 真渲染页「旧草稿白屏」回归）
const isSmokeFeedback030 = process.argv.includes('--smoke-feedback030');
// 0035：smoke-docx 模式（DOCX 导出真管线；产物目录 --smoke-docx-out <dir>，缺省 userData/smoke-docx）
const isSmokeDocx = process.argv.includes('--smoke-docx');
const smokeDocxOutArg = (() => {
  const index = process.argv.indexOf('--smoke-docx-out');
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null;
})();
// 0066：smoke-diag 模式（诊断包真链：真渲染页 → 真桥 → 真通道 → zip；产物路径 --smoke-diag-out <zip 路径>）
const isSmokeDiag = process.argv.includes('--smoke-diag');
const smokeDiagOutArg = (() => {
  const index = process.argv.indexOf('--smoke-diag-out');
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null;
})();
// 0072（只增）：smoke-announce 模式（公告/更新真链自证：本地 fixture 服务器喂 announce.json 与
// /dl/latest.yml+假包；端点经 --smoke-feed-base=<base> 覆盖，仅 smoke 生效；产物 --smoke-announce-out <json>）
const isSmokeAnnounce = process.argv.includes('--smoke-announce');
/** 0072（只增）：argv 值提取——兼容 `--x v` 与 `--x=v` 两种形态（探针/手跑都自然） */
const smokeArgValue = (flag: string): string | null => {
  const index = process.argv.indexOf(flag);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  const eq = process.argv.find((a) => a.startsWith(`${flag}=`));
  return eq ? eq.slice(flag.length + 1) || null : null;
};
const smokeFeedBaseArg = smokeArgValue('--smoke-feed-base');
const smokeAnnounceOutArg = smokeArgValue('--smoke-announce-out');
// 0072（只增）：探针可模拟便携形态（--smoke-portable → 等效 PORTABLE_EXECUTABLE_DIR 降级 L1+L2）
const isSmokeAnnouncePortable = process.argv.includes('--smoke-portable');
// 0072（只增）：探针场景选择（fetch=好拉取+可用链 / fallback=断网回落 / slow=慢速提示 / quit=安装转发 / portable=降级）
const smokeAnnounceScenario = smokeArgValue('--smoke-announce-scenario') ?? 'fetch';
// 0071（只增，自动化分支）：探针隔离 appData（引导配置落点）——仅 --smoke* 运行生效
//（同 --smoke-diag-out 先例：argv 探针分支，正常启动无此参数即零影响）
const smokeAppDataArg = (() => {
  const index = process.argv.indexOf('--smoke-appdata');
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null;
})();
// 0071（只增）：自行重定向 userData 的自动化模式清单（与 initDatabase 内既有分支一一对应）——
// 这些运行各有确定性数据目录，既不该被用户配置改道，也不该在它们身上执行用户待办的迁移
const isUserDataRedirectingRun =
  process.argv.includes('--smoke-pdf') ||
  process.argv.includes('--capture-smoke') ||
  process.argv.includes('--smoke-ext') ||
  process.argv.includes('--smoke-basket') ||
  isSmokeM6 ||
  isSmokeFeedback030 ||
  process.argv.includes('--smoke-pdfsplit') ||
  isSmokeDocx;
// 0071（只增）：数据位置本机制是否介入——「--smoke / --smoke-diag」这两个自带 userData 的探针运行
// 与上面自行重定向的一并让位（否则用户配置会把探针的确定性目录改道）；显式给 --smoke-appdata
// （数据位置探针隔离声明）时一律介入。其余（正常启动、--capture-live 等）按用户配置介入。
const shouldApplyDataLocation =
  smokeAppDataArg !== null ||
  !(isUserDataRedirectingRun || isSmokeDiag || process.argv.includes('--smoke'));
// 0071（只增）：数据位置启动解析结果（initDatabase 内消费；日志与 dataLocation.* 通道接线取此）
let dataLocationReport: DataLocationStartupReport | null = null;

// 0066（只增）：崩溃捕获接线（模块级=尽可能早）。落盘后不 process.exit——保持现状行为，只多落盘
//（任务书 §一.2）。日志目录取活动 logger，initDatabase 重定向 userData 后自动跟随。
const crashWiring = createCrashWiring();
process.on('uncaughtException', (error) => {
  crashWiring.uncaughtException(error);
});
process.on('unhandledRejection', (reason) => {
  crashWiring.unhandledRejection(reason);
});
// 0066（只增）：Electron 侧崩溃事件统一记录点（app 级=覆盖所有窗口，含 smoke 的 driver 窗口；
// 主窗的用户可见提示另挂 webContents 监听，见 createWindow——两处分工避免同一事件双记）
app.on('child-process-gone', (_event, details) => {
  crashWiring.childProcessGone(details);
});
app.on('render-process-gone', (_event, _webContents, details) => {
  crashWiring.renderProcessGone(details);
});
// 0066（只增）：自动化运行（smoke/采集探针）不弹模态提示——无人值守会挂死
const isAutomationRun = process.argv.some(
  (arg) => arg.startsWith('--smoke') || arg.startsWith('--capture-smoke') || arg.startsWith('--capture-live'),
);

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      // 0022：资源定位一律走 app.getAppPath()（开发=仓库根，打包=asar 根）——process.cwd() 打包后会解析错
      preload: join(app.getAppPath(), 'dist/shell/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // preload 需要 require 本地契约模块（shared/contracts），sandbox 白名单不含本地文件
      sandbox: false,
      // D1 Phase 0：主进程单点注入 userData 根（renderer 经 __mofangPaths 只读消费，解析 data-assets/ 前缀）
      additionalArguments: [`--mofang-user-data=${app.getPath('userData')}`],
    },
  });

  // 加载 renderer（同 preload：asar 内路径靠 app.getAppPath() 定位，勿回退 process.cwd()）
  const indexPath = join(app.getAppPath(), 'dist/renderer/index.html');
  await mainWindow.loadFile(indexPath);

  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 0066（只增）：主窗渲染进程崩溃 → 用户可见提示 + 一键重载（界面进程已死，页内提示不可用，
  // 故用 Electron 原生对话框——不新造 UI 体系）。落盘由 app 级同事件监听统一负责（避免双记）。
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    const win = mainWindow;
    if (!win || win.isDestroyed() || isAutomationRun) return;
    void dialog
      .showMessageBox(win, {
        type: 'error',
        title: '界面进程异常',
        message: '界面进程异常退出，已记录诊断日志。',
        detail: `原因：${details.reason}（退出码 ${details.exitCode}）。可在设置页「诊断」卡导出诊断包。`,
        buttons: ['重新加载界面', '稍后再说'],
        defaultId: 0,
        cancelId: 1,
      })
      .then((choice) => {
        if (choice.response === 0 && !win.isDestroyed()) win.webContents.reload();
      })
      .catch((err) => {
        diagLog('warn', 'crash', `重载提示弹窗失败：${err instanceof Error ? err.message : String(err)}`);
      });
  });
}

/** 0071：数据位置启动解析结果（供 app.log 留痕与 dataLocation.* 通道接线） */
interface DataLocationStartupReport {
  /** 本机制是否介入（false = 自动化/探针运行自带确定性 userData，让位；见 shouldApplyDataLocation） */
  applied: boolean;
  configPath: string;
  source: DataLocationSource;
  /** 本次实际生效的 userData 根 */
  userDataPath: string;
  /** 本应执行的迁移目标（仅在迁移失败时仍非空） */
  pendingDataRoot: string | null;
  warnings: string[];
  migration: MigrationResult | null;
}

/**
 * 0071：数据保存位置启动引导（R-043）。
 *
 * 时序：whenReady 最前（与既有 smoke setPath 先例同位）——必须在任何 Chromium 会话/缓存访问之前。
 * 步骤：读引导配置（appData 下，数据目录之外）→ 解析生效位置（config → portable → 默认）→
 * 有 pending 则**此时**执行迁移（db 未开、零句柄；备份→复制→校验→校验过才翻转）→ setPath 生效位置。
 * 迁移失败不阻断启动：仍用原位置，pending 保留待下次，原因进 app.log + 引导配置留痕。
 */
async function bootstrapDataLocation(): Promise<DataLocationStartupReport> {
  // 自动化探针分支：隔离 appData（引导配置落点），仅 --smoke* 运行生效
  if (smokeAppDataArg !== null && process.argv.some((arg) => arg.startsWith('--smoke'))) {
    const appDataPath = resolvePath(smokeAppDataArg);
    mkdirSync(appDataPath, { recursive: true });
    app.setPath('appData', appDataPath);
  }

  const configPath = join(app.getPath('appData'), DATA_LOCATION_CONFIG_DIR, DATA_LOCATION_CONFIG_FILE);
  // 默认 userData：必须在 setPath('userData') 之前取（appData 已就位）
  const defaultUserDataPath = app.getPath('userData');

  if (!shouldApplyDataLocation) {
    return {
      applied: false,
      configPath,
      source: 'default',
      userDataPath: defaultUserDataPath,
      pendingDataRoot: null,
      warnings: [],
      migration: null,
    };
  }

  const plan = resolveBootstrapPlan({
    configPath,
    defaultUserDataPath,
    portableDir: process.env.PORTABLE_EXECUTABLE_DIR,
  });

  let userDataPath = plan.userDataPath;
  let migration: MigrationResult | null = null;
  if (plan.pendingDataRoot !== null) {
    migration = await runPendingMigration(
      { configPath, fromUserData: plan.userDataPath, toRoot: plan.pendingDataRoot },
      {
        copyTree,
        // 迁移前备份：真库 zip 快照落旧位置 backups/（复用 guard 备份服务，格式与手动备份同源；
        // 库不存在 = 全新安装，无可备份）；失败由迁移流程按「中止」处理
        createPreMigrationBackup: async ({ dataDir, outputPath }) => {
          const dbPath = join(dataDir, 'bank.db');
          if (!existsSync(dbPath)) return;
          const db = new BankDatabase(dbPath);
          try {
            const result = await createBackup(db, dataDir, outputPath, app.getVersion());
            if (!result.success) throw new Error(result.error ?? '备份失败');
          } finally {
            db.close();
          }
        },
      },
    );
    if (migration.ok) userDataPath = plan.pendingDataRoot;
  }

  app.setPath('userData', userDataPath);
  return {
    applied: true,
    configPath,
    source: migration?.ok ? 'config' : plan.source,
    userDataPath,
    pendingDataRoot: migration?.ok ? null : plan.pendingDataRoot,
    warnings: plan.warnings,
    migration,
  };
}

async function initDatabase() {
  // 0071：数据位置引导（必须在任何 userData 使用之前——与既有 smoke setPath 分支同位，且先于它们；
  // 自行重定向 userData 的自动化模式下本机制让位，见 isUserDataRedirectingRun）
  dataLocationReport = await bootstrapDataLocation();

  // smoke-pdf 模式：重定向 userData 到仓库 tmp-smoke
  if (process.argv.includes('--smoke-pdf')) {
    const repoRoot = process.cwd();
    app.setPath('userData', join(repoRoot, 'tmp-smoke'));
  }

  // capture-smoke 模式：重定向 userData 到独立新目录（确定性，无历史数据干扰）
  if (process.argv.includes('--capture-smoke')) {
    const repoRoot = process.cwd();
    app.setPath('userData', join(repoRoot, 'tmp-smoke', `capture-${Date.now()}`));
  }

  // 0003 smoke-ext 模式：重定向 userData 到独立新目录（确定性，真 SQLite 全链）
  if (process.argv.includes('--smoke-ext')) {
    const repoRoot = process.cwd();
    app.setPath('userData', join(repoRoot, 'tmp-smoke', `ext-${Date.now()}`));
  }

  // 0004 smoke-basket 模式：重定向 userData 到独立新目录（确定性，真 SQLite 全链 + file 落盘探针）
  if (process.argv.includes('--smoke-basket')) {
    const repoRoot = process.cwd();
    app.setPath('userData', join(repoRoot, 'tmp-smoke', `basket-${Date.now()}`));
  }

  // 0005 smoke-m6 模式：重定向 userData 到独立新目录（确定性，反馈模板真链 + 卡片 PNG 落盘探针）
  if (isSmokeM6) {
    const repoRoot = process.cwd();
    app.setPath('userData', join(repoRoot, 'tmp-smoke', `m6-${Date.now()}`));
  }

  // 0030 smoke-feedback030 模式：userData 落独立临时目录（真 SQLite + 真渲染页，跑完自清）
  if (isSmokeFeedback030) {
    app.setPath('userData', join(tmpdir(), `mofang-smoke-feedback030-${Date.now()}`));
  }

  // 0036 smoke-pdfsplit 模式：userData 落独立临时目录（工作区文件态可查、不污染真库）
  if (process.argv.includes('--smoke-pdfsplit')) {
    app.setPath('userData', join(tmpdir(), `mofang-smoke-pdfsplit-${Date.now()}`));
  }

  // 0035 smoke-docx 模式：userData 落系统临时目录（出仓包实测同样可用——仓库路径在打包态不存在）
  if (isSmokeDocx) {
    app.setPath('userData', join(tmpdir(), `mofang-smoke-docx-${Date.now()}`));
  }

  const userDataPath = app.getPath('userData');
  const dataDir = join(userDataPath, 'data');
  mkdirSync(dataDir, { recursive: true });

  // 0071（只增）：导出链资产根单点注入（assetsRoot 由本处装配链给值——消除 buildPaperHtml.ts
  // 内自取 userData 的第二真源；重定向后与 dataDir 恒一致）
  setDefaultAssetsRoot(join(dataDir, 'assets'));

  // 0066（只增）：日志初始化（必须在上面 smoke 重定向判定之后——尊重重定向后的 userData）。
  // 放 initDatabase 内最前：数据库初始化失败也要能落日志。
  const diagLogger = initDiagLogger(userDataPath, { echo: isDev });
  diagLogger.info('diag', '应用启动：日志就绪', {
    userData: userDataPath,
    mode: isSmokeDiag ? 'smoke-diag' : 'normal',
    argv: process.argv.filter((a) => a.startsWith('--smoke') || a.startsWith('--capture')).join(' '),
  });
  // 0071（只增）：数据位置解析与迁移结果全量交代到 app.log（回退原因/坏配置/迁移失败都留痕）
  if (dataLocationReport) {
    const report = dataLocationReport;
    if (!report.applied) {
      diagLogger.info('data-location', '数据位置：本次为自动化/探针运行（自带确定性 userData），本机制未介入');
    } else {
      const sourceLabel =
        report.source === 'config' ? '用户自定义' : report.source === 'portable' ? '便携版（exe 旁）' : '系统默认';
      diagLogger.info('data-location', `数据位置：${sourceLabel}`, {
        userDataPath: report.userDataPath,
        configPath: report.configPath,
        pending: report.pendingDataRoot,
      });
      for (const warning of report.warnings) diagLogger.warn('data-location', warning);
      if (report.migration) {
        const migration = report.migration;
        diagLogger.log(
          migration.ok ? 'info' : 'error',
          'data-location',
          migration.ok
            ? `数据位置迁移完成：${migration.copiedFiles ?? 0} 个文件 / ${migration.copiedBytes ?? 0} 字节 → ${report.userDataPath}`
            : `数据位置迁移未完成（仍用原位置启动）：${migration.error ?? '未知原因'}`,
          { backup: migration.backupPath, config: report.configPath },
        );
        // 跳过项全量列出（运行期易变条目/悬空链接/复制期间消失）——不静默丢文件
        if (migration.skipped && migration.skipped.length > 0) {
          diagLogger.info('data-location', `迁移跳过 ${migration.skipped.length} 项（不影响数据）`, {
            skipped: migration.skipped,
          });
        }
      }
    }
  }
  // 0066（只增）：崩溃转储（本地、不上传；转储目录 = userData/crashes，且不进诊断包——
  // 内存镜像可能含密钥/账号痕迹，只留本地供人工取证）。失败即降级为「只做事件日志」并记档。
  try {
    const crashesDir = join(userDataPath, 'crashes');
    mkdirSync(crashesDir, { recursive: true });
    app.setPath('crashDumps', crashesDir);
    crashReporter.start({ uploadToServer: false, compress: false, rateLimit: false });
    diagLogger.info('diag', 'crashReporter 已启动（本地转储，不上传）', { crashesDir });
  } catch (err) {
    diagLogger.warn('diag', `crashReporter 启动失败，降级为仅事件日志：${err instanceof Error ? err.message : String(err)}`);
  }

  const dbPath = join(dataDir, 'bank.db');
  // 迁移脚本随包进 asar（package.json files 白名单），定位同 preload/index：app.getAppPath()
  const migrationsDir = join(app.getAppPath(), 'src/bank/migrations');

  /**
   * P0-2：重建数据库与 bankService/captureHost 依赖。
   * 恢复成功（指向恢复后的库）或失败（指向回滚后的原库）后都由 guard restore IPC 调用，
   * 保证 main 持有的句柄始终可用、应用无需重启即可继续使用。
   */
  const reloadDatabase = (): Database => {
    if (currentDb) {
      try { currentDb.close(); } catch { /* 忽略重复关闭 */ }
      currentDb = null;
    }
    const db = openDatabase(dbPath, migrationsDir);
    currentDb = db;
    bankService = new BankServiceImpl(db);
    // 0057（只增）：存量录题内联图资产化 backfill（一次性、幂等）。
    // 挂在这里（openDatabase 之后）而非 initDatabase 一次性点：guard restore 同样走 reloadDatabase，
    // 挂里面才能覆盖「恢复旧备份后再升版」场景。异步不阻塞窗口创建（无待迁移题时纯读即返回）。
    void runRecogImageBackfill({
      listQuestions: () => bankService!.listQuestions(),
      updateQuestion: (id, patch) => bankService!.updateQuestion(id, patch),
      dataDir,
      dbPath,
      logger: new OperationLogger(db),
      warn: (message) => console.warn(message),
    }).then((report) => {
      if (report.changed > 0 || report.failures.length > 0) {
        console.log(`0057 backfill：扫 ${report.scanned} 题 / 待迁移 ${report.candidates} 题 / 改写 ${report.changed} 题 / 落图 ${report.persistedFiles} 张 / 失败 ${report.failures.length} 题`);
      }
    }).catch((err) => {
      console.warn(`0057 backfill 未执行（不阻塞启动）：${err instanceof Error ? err.message : String(err)}`);
    });
    // 0056（只增）：存量采集题小图误判回填（R-064；一次性、幂等——同挂 reloadDatabase 内）。
    // 判据：content 里 inline-figure 包裹 且 位图（非 .svg）且 高 >60px 且 非选项区 → 还原块级 figure.diagram
    // （只改包裹结构，不动资产文件/images；备份 data/bank.db.bak-0056，单题失败不中断启动）。
    void runInlineFigureBackfill({
      listQuestions: () => bankService!.listQuestions(),
      updateQuestion: (id, patch) => bankService!.updateQuestion(id, patch),
      dbPath,
      logger: new OperationLogger(db),
      warn: (message) => console.warn(message),
    }).then((report) => {
      if (report.changed > 0 || report.failures.length > 0) {
        console.log(`0056 回填：扫 ${report.scanned} 题 / 待回填 ${report.candidates} 题 / 改写 ${report.changed} 题 / 还原 ${report.convertedFigures} 图 / 选项区保持行内 ${report.skippedOptionRegion} 图 / 失败 ${report.failures.length} 题`);
      }
    }).catch((err) => {
      console.warn(`0056 回填未执行（不阻塞启动）：${err instanceof Error ? err.message : String(err)}`);
    });
    // 0003：扩展服务组装（复用同一 db 句柄；paper 扩展服务由 createExtServices 内建）
    extServices = createExtServices(db);
    // 0023（只增）：AI 网关（模型档案 service + Key 托管 + 测连通随包小图）
    aiGateway = new AiGateway({
      profiles: new ModelProfileServiceImpl(db),
      vault: aiVault,
      // 随包测试图在 electron-builder files 白名单 build/**/* 内（0022 打包教训：资源定位一律 app.getAppPath()）
      testImagePath: join(app.getAppPath(), 'build', 'ai-test-image.png'),
      // 0037（只增）：invoke 成功留痕（operation_log 复用零新表；主进程直调 bank service 不经 IPC）
      opLogger: new OperationLogger(db),
    });
    // 0028（只增）：识别 run 宿主——素材落 data/recog/runs，编排经 recog/runs/pipeline，
    // 视觉识别经 aiGateway.invoke({role:'vision'})（Key 红线 D-043：宿主不触 Key）
    recogHost = new RecogHost({
      runs: new RecogRunServiceImpl(db),
      invoke: (payload) => aiGateway!.invoke(payload),
      runsRoot: join(dataDir, 'recog', 'runs'),
    });
    // 0036（只增）：PDF 切题工作区宿主——项目/切段/框/草稿/页图缓存落 data/splitting/<项目>/，
    // 纯文件态（无迁移）；识别仍走 recog.run.*（本宿主不碰编排语义，任务书禁区 2）
    splitHost = new SplitHost({ root: join(dataDir, 'splitting') });
    // 0029（只增）：AI 挂树/打标建议宿主——快照（bank 只读）+ reasoning 建议（经 aiGateway，
    // D-043 本宿主不触 Key）+ 题面装载（bankService.getQuestion）；纯读面，写入回走既有通道（P-07）
    suggestHost = new AiSuggestHost({
      snapshots: new AnchorSnapshotServiceImpl(db),
      invoke: (payload) => aiGateway!.invoke(payload),
      getQuestion: (id) => bankService!.getQuestion(id),
    });
    // captureHost 持 bankService 引用，重建新实例（最小改动，不触碰 capture 内部实现）
    // 0006 P2（只增）：注入树服务，题带 meta.sourceNodeIds 时入库挂树
    // 0006-fix-3 P3（只增）：注入学科字典服务，collect 时把用户选择学科解析为 subjectId
    // 0006 P4（只增）：注入成品卷服务，整卷下载去向「成品卷」走既有 service 面（bank 层零改动）
    captureHost = new CaptureHost({
      bankService,
      userDataPath,
      treeService: extServices.tree,
      dictService: extServices.dict,
      paperService: extServices.paper,
      // 0012 P1（只增）：内嵌 view 挂载容器窗 = 主窗；capture-smoke 场景（主窗未建）回落首个存活窗口=driver
      getContainerWindow: () =>
        mainWindow ?? BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null,
    });
    return db;
  };

  // 初始打开
  reloadDatabase();
  // 0066（只增）：数据库初始化结果落日志（含 schema 版本；失败由 process 级 uncaughtException 兜底记录）
  try {
    diagLog('info', 'db', '数据库初始化完成', { dbPath, schemaVersion: currentDb!.getUserVersion() });
  } catch (err) {
    diagLog('error', 'db', `数据库初始化后读版本失败：${err instanceof Error ? err.message : String(err)}`);
  }
  // 0071（只增）：迁移留痕（operation_log 零新表；落的是迁移产物新库，故写在此处——迁移本身发生在开库之前）
  if (dataLocationReport?.applied && dataLocationReport.migration?.ok) {
    const migration = dataLocationReport.migration;
    try {
      const now = new Date().toISOString();
      currentDb!.prepare(
        'INSERT INTO operation_log (id, operation_type, started_at, finished_at, status, affected_count, description, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        randomUUID(),
        'data-location.migrate',
        now,
        now,
        'succeeded',
        migration.copiedFiles ?? 0,
        `Migrate data location to ${dataLocationReport.userDataPath}: files=${migration.copiedFiles ?? 0}, bytes=${migration.copiedBytes ?? 0}`,
        JSON.stringify({
          to: dataLocationReport.userDataPath,
          from: dataLocationReport.migration.backupPath ?? null,
          backup_path: migration.backupPath ?? null,
          skipped: migration.skipped ?? [],
        })
      );
    } catch (err) {
      diagLog('warn', 'data-location', `迁移台账写入失败（不影响迁移结果）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 0066（只增）：IPC 错误路径统一收口（必须在下面任何 register* 之前调用一次；
  // 之后所有 ipcMain.handle 的 handler 异常都会先落 app.log 再原样抛出）
  installIpcErrorLogging(ipcMain);

  // 注册 IPC handlers（P0-2：getter 闭包，service 重建后 handler 自动指向新实例，无需重复注册）
  // 0035（只增）：DOCX 导出 handler 需 data 目录（data-assets 资产根）；smoke-docx 时固定落盘路径
  registerIpcHandlers(() => bankService!, {
    dataDir,
    smoke: isSmokeDocx ? { docxExportPath: join(app.getPath('userData'), 'smoke-docx', 'via-ipc.docx') } : undefined,
  });
  registerCaptureIpcHandlers(() => captureHost!);
  // 0003（只增）：bank 扩展通道接线（student/class/exam/mistake 全量 + dict/paper_set 查询子集）
  registerExtIpcHandlers(() => extServices!);

  // 0023（只增）：ai.* 通道接线（模型配置；getter 闭包对齐 reloadDatabase 重建语义）
  registerAiIpcHandlers(() => aiGateway!);

  // 0056（只增）：bank.question.aiClean 接线（采集题 AI 整理；库面懒取对齐 reloadDatabase 重建语义，
  // 模型腿 = aiGateway.invoke——本层不触 Key，D-043）
  registerQuestionAiCleanIpcHandlers({
    getBank: () => bankService!,
    invoke: (payload) => aiGateway!.invoke(payload),
    dataDir,
    // 0056 目检返工①/⑥：学科网/组卷公式图是 SVG，视觉端点不收 → 送模型前 canvas 栅格化成 PNG
    // （返工⑥（用户拍板）：转写只走 vision 档案=DeepSeek-OCR，不挂第二意见腿）
    prepareImages: createAiCleanImagePreparer(),
    logger: () => new OperationLogger(currentDb!),
  });

  // 0028（只增）：recog.run.* 通道接线（识别 run 任务化；同 getter 闭包语义）
  // 0044（只增）：注入 recog.saveAsPaper 编排依赖（db 事务边界 + bank/ext getter，getter 闭包对齐重建）
  registerRecogIpcHandlers(() => recogHost!, {
    getDb: () => currentDb!,
    getBank: () => bankService!,
    getExt: () => extServices!,
  });

  // 0036（只增）：split.* 通道接线（PDF 切题工作区；getter 闭包对齐 reloadDatabase 重建语义）
  registerSplitIpcHandlers(() => splitHost!);

  // 0029（只增）：ai.suggest.* 通道接线（AI 挂树/打标建议；同 getter 闭包语义）
  registerAiSuggestIpcHandlers(() => suggestHost!);

  // 0004（只增）：file.* 通道接线（Logo/剪贴板/预设导入导出）；
  // --smoke-basket 时 pickLogo/importPreset/exportPreset 不经 dialog 走固定测试文件（探针分支）
  // 0005（只增）：--smoke-m6 时 exportTextFile/exportCards 不经 dialog 走固定路径/目录（探针分支）
  registerFileIpcHandlers({
    dataDir,
    // 0061（只增）：废图清理两通道的只读库面 + 台账面（**懒取**：库句柄与服务实例随 reloadDatabase 重建，
    // 与 registerExtIpcHandlers 的 getter 闭包同语义；reference 判定所需全部为既有只读方法，零新 SQL）
    cleaner: () => ({
      refs: { bank: bankService!, paper: extServices!.paper, mistake: extServices!.mistake },
      logger: new OperationLogger(currentDb!),
    }),
    smoke: process.argv.includes('--smoke-basket')
      ? {
          logoSourcePath: join(process.cwd(), 'scripts/fixtures/pixel.png'),
          presetFilePath: join(dataDir, 'preset-smoke.json'),
        }
      : isSmokeM6
        ? {
            logoSourcePath: join(process.cwd(), 'scripts/fixtures/pixel.png'),
            presetFilePath: join(dataDir, 'preset-smoke.json'),
            textExportPath: join(dataDir, 'feedback-smoke.txt'),
            cardsOutputDir: join(app.getPath('userData'), 'smoke-cards'),
          }
        : undefined,
  });

  // E1（只增）：注册 guard.* IPC handlers（数据备份与恢复）
  const packageJson = require('../../package.json');
  registerGuardIpcHandlers(() => currentDb!, reloadDatabase, dataDir, packageJson.version, migrationsDir);

  // 0066（只增）：注册 diag.* IPC handlers（诊断包导出；R-002）。
  // smoke-diag 时跳过保存对话框直落指定 zip（自证/探针分支），正常启动走 dialog。
  registerDiagIpcHandlers({
    getDb: () => currentDb!,
    userDataPath,
    dataDir,
    appVersion: packageJson.version,
    ...(isSmokeDiag
      ? {
          smokeOutputPath:
            smokeDiagOutArg ?? join(app.getPath('userData'), 'smoke-diag', 'mofang-diagnostics-smoke.zip'),
        }
      : {}),
  });

  // 0071（只增）：注册 dataLocation.* IPC handlers（自定义数据保存位置；R-043）。
  // get/change/cancel 的读写逻辑在 shell/data-location，本处只给配置落点与生效态（进程内不变）。
  registerDataLocationIpcHandlers({
    configPath:
      dataLocationReport?.configPath ??
      join(app.getPath('appData'), DATA_LOCATION_CONFIG_DIR, DATA_LOCATION_CONFIG_FILE),
    userDataPath,
    source: dataLocationReport?.applied ? dataLocationReport.source : 'default',
    portable: Boolean(process.env.PORTABLE_EXECUTABLE_DIR),
  });

  // 0072（只增）：公告服务构造 + announce.* 通道接线。
  // --smoke-feed-base 时端点指向本地 fixture（仅 smoke 生效）；缓存落 <userData>/announce-cache.json；
  // 拉取/回落永不 throw（服务内敛），log 挂 diagLog 留 app.log。
  const effectiveFeedBase = smokeFeedBaseArg ? smokeFeedBaseArg.replace(/\/+$/, '') : null;
  announceService = new AnnounceService({
    announceUrl: effectiveFeedBase ? `${effectiveFeedBase}/announce.json` : MF_ANNOUNCE_URL,
    cachePath: join(userDataPath, 'announce-cache.json'),
    log: (message) => diagLog('info', 'announce', message),
  });
  registerAnnounceIpcHandlers({
    getSnapshot: () => announceService!.getSnapshot(),
    refresh: () => announceService!.refresh(),
  });

  // 0072（只增）：更新链三态接线（任务书 §一.3）。
  //  - 生产：app.isPackaged && !isAutomationRun → electron-updater generic 真 adapter（feed=端点常量；
  //    feed URL 非 http(s) 绝对地址 → 降级 adapter，0075 A6 守卫）；
  //  - 探针：--smoke-announce → stub adapter（本地 fixture 真拉 latest.yml/假包，事件同形）；
  //  - dev（未打包非自动化）：降级 adapter 恒 not-available（目检返工②，更新区可见且恒「已是最新」）；
  //  - 自动化：不注册通道（渲染层 invoke 拒绝 → 更新区不渲染，同无桥口径）。
  // 状态广播：update.onStatus 订阅型通道（webContents.send）；便携降级=PORTABLE_EXECUTABLE_DIR（探针 --smoke-portable）。
  const isPortableRun = isSmokeAnnounce ? isSmokeAnnouncePortable : Boolean(process.env.PORTABLE_EXECUTABLE_DIR);
  if (isSmokeAnnounce && effectiveFeedBase) {
    const { createStubUpdaterAdapter } = await import('./smoke-announce.js');
    updateService = new UpdateService({
      adapter: createStubUpdaterAdapter(effectiveFeedBase, smokeAnnounceScenario),
      statePath: join(userDataPath, 'update-state.json'),
      isPortable: isSmokeAnnouncePortable,
      log: (level, message) => diagLog(level, 'update', message),
    });
  } else if (app.isPackaged && !isAutomationRun) {
    // 0075 A6：feed URL 非 http(s) 绝对地址时不构造生产 adapter——electron-updater GenericProvider
    // 对相对路径构造即抛 TypeError 且无兜底（异常冒泡致打包态无主窗，任务书 §零.1）；
    // 降级 not-available 与 dev 口径同型（开源构建端点置空即走此分支）。
    const feedUrl = effectiveFeedBase ? `${effectiveFeedBase}/dl/` : MF_UPDATE_FEED_URL;
    if (isUsableFeedUrl(feedUrl)) {
      updateService = new UpdateService({
        adapter: createElectronUpdaterAdapter(feedUrl),
        statePath: join(userDataPath, 'update-state.json'),
        isPortable: isPortableRun,
        log: (level, message) => diagLog(level, 'update', message),
      });
    } else {
      diagLog('warn', 'update', '更新通道未配置，降级（feed URL 非 http(s) 绝对地址）');
      updateService = new UpdateService({
        adapter: createNotAvailableAdapter(),
        statePath: join(userDataPath, 'update-state.json'),
        isPortable: isPortableRun,
        log: (level, message) => diagLog(level, 'update', message),
      });
    }
  } else if (!app.isPackaged && !isAutomationRun) {
    // 0072 目检返工②（用户 2026-09-25）：dev 态（npm start）也要可见「检查更新」入口——
    // 降级 adapter 恒 not-available（零 electron-updater 触达；真实检查归打包态）。
    // 节流文件与打包态隔离（update-state.dev.json）——dev 的检查时间不得挡住打包版首次自动检查。
    updateService = new UpdateService({
      adapter: createNotAvailableAdapter(),
      statePath: join(userDataPath, 'update-state.dev.json'),
      isPortable: false,
      log: (level, message) => diagLog(level, 'update', message),
    });
  }
  if (updateService) {
    registerUpdateIpcHandlers({
      getStatus: () => updateService!.getStatus(),
      checkNow: () => updateService!.checkNow(),
      quitAndInstall: () => updateService!.quitAndInstall(),
    });
    // 状态变化 → 渲染层推送（update.onStatus；主窗未建时静默跳过，UI 进设置页会 getStatus 水合）
    updateService.onStatus((status) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_CHANNELS.UPDATE_ON_STATUS, status);
      }
    });
  }
}

app.whenReady().then(async () => {
  await initDatabase();

  // smoke 模式：启动后立即退出
  if (process.argv.includes('--smoke')) {
    setTimeout(() => {
      app.quit();
    }, 1000);
    return;
  }

  // smoke-pdf 模式：生成测试 PDF 并验证
  if (process.argv.includes('--smoke-pdf')) {
    await runSmokePdf();
    return;
  }

  // capture-smoke 模式：验证 capture.* IPC 接线真实可调（本地 fixture，无站点访问）
  if (process.argv.includes('--capture-smoke')) {
    const { runCaptureSmoke } = await import('./capture-smoke.js');
    await runCaptureSmoke(captureHost!, bankService!, extServices!.dict);
    return;
  }

  // 0003 smoke-ext 模式：验证 bank 扩展通道（__mofangBankExt）真接线跑通
  // 建生→分班→建考→recordResults→查错题红黄绿 最小闭环（真 SQLite）
  if (process.argv.includes('--smoke-ext')) {
    const { runExtSmoke } = await import('./smoke-ext.js');
    await runExtSmoke(bankService!, extServices!);
    return;
  }

  // 0004 smoke-basket 模式：验证试题篮通道（__mofangBankExt 0004 子集 + __mofangFile）真接线跑通
  // 建篮→加题→快照→done→恒定→克隆→归档恢复→file 4 通道（真 SQLite）
  if (process.argv.includes('--smoke-basket')) {
    const { runBasketSmoke } = await import('./smoke-basket.js');
    await runBasketSmoke(bankService!, extServices!);
    return;
  }

  // 0036 smoke-pdfsplit 模式：PDF 切题工作区真链路实测（导入→分块上传→栅格化→画框 + 大 PDF 耗时/内存，S-2）
  if (process.argv.includes('--smoke-pdfsplit')) {
    const { runSplitSmoke } = await import('./smoke-split.js');
    const { failures, report } = await runSplitSmoke();
    if (failures.length > 0) {
      console.error(`[0036] SMOKE FAIL：${failures.join('；')}`);
      app.exit(1);
      return;
    }
    console.log(`[0036] SMOKE PASS（页数 ${report.pageCount}，采样 ${report.visitedPages} 页，均耗时 ${report.rasterMsAvg}ms）`);
    app.exit(0);
    return;
  }

  // 0035 smoke-docx 模式：DOCX 导出真管线（KaTeX 栅格 + 图片落位 + 组装落盘；样例卷含公式/图/双栏）
  if (isSmokeDocx) {
    try {
      const { runSmokeDocx } = await import('./smoke-docx.js');
      await runSmokeDocx({
        userDataPath: app.getPath('userData'),
        outDir: smokeDocxOutArg ?? join(app.getPath('userData'), 'smoke-docx'),
      });
      app.exit(0);
    } catch (err) {
      console.error('FAIL smoke-docx 失败:', err);
      app.exit(1);
    }
    return;
  }

  // 0005 smoke-m6 模式：验证课后反馈（feedback 模板 CRUD + exportCards 批量 PNG + exportTextFile）
  if (isSmokeM6) {
    const { runFeedbackSmoke } = await import('./smoke-m6.js');
    await runFeedbackSmoke(extServices!);
    return;
  }

  // 0030 smoke-feedback030 模式：反馈模块一期（记录/提示词模板真链 + 真渲染页旧草稿白屏回归）
  if (isSmokeFeedback030) {
    const { runFeedback030Smoke } = await import('./smoke-feedback030.js');
    await runFeedback030Smoke(extServices!);
    return;
  }

  // capture-live 模式（D1 P4）：双站实站真调辅助，用户在场手动登录/加篮，脚本只读提取不入库
  if (process.argv.includes('--capture-live')) {
    const { runCaptureLive } = await import('./capture-live.js');
    await runCaptureLive(captureHost!);
    return;
  }

  // 0066 smoke-diag 模式：诊断包真链自证（真渲染页点「导出诊断包」→ 真桥 → 真通道 → zip；
  // 产物白名单 + 排除清单核验在 smoke-diag.ts 内完成，结论打印到 stdout）
  if (isSmokeDiag) {
    const { runDiagSmoke } = await import('./smoke-diag.js');
    try {
      const report = await runDiagSmoke({
        userDataPath: app.getPath('userData'),
        dataDir: join(app.getPath('userData'), 'data'),
        outputPath:
          smokeDiagOutArg ?? join(app.getPath('userData'), 'smoke-diag', 'mofang-diagnostics-smoke.zip'),
      });
      console.log(`[0066] SMOKE PASS 诊断包：${report.path}（${report.entries.length} 件）`);
      for (const entry of report.entries) console.log(`[0066]   包内 ${entry}`);
      for (const check of report.checks) console.log(`[0066]   ${check}`);
      app.exit(0);
    } catch (err) {
      console.error('[0066] SMOKE FAIL 诊断包：', err);
      app.exit(1);
    }
    return;
  }

  // 0072 smoke-announce 模式：公告/更新真链自证（本地 fixture 服务器驱动；场景脚本化，
  // 产物 JSON 由探针脚本断言）。--smoke-announce 归 isAutomationRun——公告定时器/生产更新链不启动，
  // 本分支显式驱动服务走完整链路，跑完自退（无人值守不挂）。
  if (isSmokeAnnounce) {
    const { runAnnounceSmoke } = await import('./smoke-announce.js');
    try {
      const report = await runAnnounceSmoke({
        scenario: smokeAnnounceScenario,
        announceService: announceService!,
        updateService,
        outPath: smokeAnnounceOutArg ?? join(app.getPath('userData'), 'smoke-announce', 'result.json'),
        cachePath: join(app.getPath('userData'), 'announce-cache.json'),
      });
      console.log(`[0072] SMOKE PASS announce-update（${smokeAnnounceScenario}）：${report.checks.length} 项断言全过`);
      for (const check of report.checks) console.log(`[0072]   ${check}`);
      app.exit(0);
    } catch (err) {
      console.error('[0072] SMOKE FAIL announce-update：', err);
      app.exit(1);
    }
    return;
  }

  await createWindow();

  // 0072（只增）：公告拉取与更新检查调度——isAutomationRun 与未打包 dev 态不启动
  //（任务书 §一.2/§零.4：无人值守挂死先例；探针走 --smoke-announce 显式分支）。
  // setTimeout 异步触发，不阻塞启动与首窗渲染；启动后 ~30s 首拉/首查 + 公告每 6h 一拉 + 更新 24h 节流（服务内判）。
  if (!isAutomationRun && app.isPackaged && announceService) {
    setTimeout(() => {
      void announceService!.refresh();
    }, 30_000);
    setInterval(() => {
      void announceService!.refresh();
    }, 6 * 60 * 60 * 1000);
    if (updateService) {
      setTimeout(() => {
        void updateService!.maybeCheckOnStartup();
      }, 30_000);
    }
  }

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

async function runSmokePdf() {
  try {
    const { MockBankService } = await import('../bank/mock/mock-bank.js');
    const { buildPaperHtml } = await import('../docgen/render/buildPaperHtml.js');

    const mockService = new MockBankService();
    const papers = await mockService.listPapers();
    if (papers.length === 0) {
      throw new Error('MockBankService 没有预置试卷');
    }

    const paper = papers[0].paper;
    const refs = await mockService.getPaperQuestions(paper.id);
    const questions = await Promise.all(
      refs.map(ref => mockService.getQuestion(ref.questionId))
    );
    const validQuestions = questions.filter(q => q !== null);

    const html = await buildPaperHtml(paper, validQuestions, { mode: 'teacher' });

    // 创建临时 HTML 并生成 PDF
    const tmpDir = join(app.getPath('userData'), 'tmp');
    mkdirSync(tmpDir, { recursive: true });
    const tmpHtmlPath = join(tmpDir, 'smoke-test.html');
    writeFileSync(tmpHtmlPath, html, 'utf-8');

    const pdfWindow = new BrowserWindow({
      show: false,
      width: Math.ceil((210 * 96) / 25.4) + 80,
      height: 1200,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    await pdfWindow.loadFile(tmpHtmlPath);

    // 0007 P5：基线冒烟改走页化导出唯一路径（旧 footerTemplate 路径已退役）——
    // 与 doc.exportPdf 同参：先注入预览同源运行时写回 sheet DOM，再零边距无 header/footer 出纸。
    const pagination = await paginatePdfWindow(pdfWindow.webContents, { pageWmm: 210, pageHmm: 297, columns: 1, columnGapMm: 0 });
    if (pagination.sheets < 1) {
      throw new Error(`smoke-pdf 基线：页化 sheet 数为 0（卷面应有内容）`);
    }

    const pdfData = await pdfWindow.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      displayHeaderFooter: false,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    });

    pdfWindow.close();

    // 验证 PDF
    if (pdfData.length < 5000) {
      throw new Error(`PDF 文件太小: ${pdfData.length} bytes`);
    }

    const pdfHeader = pdfData.toString('utf8', 0, 4);
    if (pdfHeader !== '%PDF') {
      throw new Error(`PDF 文件头错误: ${pdfHeader}`);
    }

    const pdfText = pdfData.toString('utf8');

    // 页码自 0007 P2 起为 sheet 页脚内容化（「第 N 页 / 共 M 页」入文本层，不再走 Chromium
    // footerTemplate 的 Type3 渲染）；文本层逐页断言在多页探针（pdftotext）覆盖。

    // N-2: 验证 KaTeX 字体嵌入（从 /BaseFont 提取字体名，至少 1 个以 KaTeX 开头）
    const fontNames = [...pdfText.matchAll(/\/BaseFont\s*\/([A-Za-z0-9+-]+)/g)].map(m => m[1]);
    if (!fontNames.some(name => name.startsWith('KaTeX') || name.includes('+KaTeX'))) {
      throw new Error(`PDF 缺少 KaTeX 字体嵌入，实际字体: ${fontNames.join(', ') || '(无)'}`);
    }

    // 写入测试 PDF
    const pdfPath = join(tmpDir, 'smoke-test.pdf');
    writeFileSync(pdfPath, pdfData);

    console.log(`OK   smoke-pdf 通过: ${pdfPath} (${pdfData.length} bytes)`);

    // 清理临时文件
    unlinkSync(tmpHtmlPath);

    // 0004-fix-3 多页卷实机探针 → 0007 P3 演进：页化路径 Logo 逐页内容化 + 像素采样落点对拍
    await runMultiPagePdfProbe(tmpDir);
    console.log('OK   smoke-pdf 多页卷探针通过（Logo 逐页内容化 + 像素采样落点屏显=打印 + 页码逐页正确）');

    // 0007 P2：页化导出对拍探针（预览装箱 == PDF 实际分页，逐页首题一致）
    await runPaginateParityProbe(tmpDir);
    console.log('OK   smoke-pdf 页化对拍探针通过（sheet 数 == PDF 页数、逐页首题一致）');

    // 0007 P4：A3 横版双列手工列盒对拍探针（列盒结构 + 逐页首题一致 + 出纸规格）
    await runTwoColumnParityProbe(tmpDir);
    console.log('OK   smoke-pdf A3 双列对拍探针通过（手工列盒 == PDF 分页、逐页首题一致、A3 横版出纸）');

    // 0007 P6：长文段内行级拆分对拍探针（阅读篇长段跨页：逐字一致 + 续片段 + 无溢出）
    await runInlineSplitParityProbe(tmpDir);
    console.log('OK   smoke-pdf 长文段内拆分对拍探针通过（逐字一致 + 续片段 + sheet 数 == PDF 页数）');

    app.quit();
  } catch (err) {
    console.error('FAIL smoke-pdf 失败:', err);
    app.exit(1);
  }
}

/**
 * 0004-fix-3 多页卷实机探针（打印高风险面验证）→ 0007 P3 演进为页化导出路径：
 * ① config 驱动卷（10 题含 KaTeX 公式 + SVG 题图 + 45mm 作答区 + 品红 Logo 位图——
 *   品红纯色是像素采样定位锚，运行时生成入 tmp，不动 scripts/fixtures  Lane A 域）；
 * ② 打印分流断言演进：@media print Logo fixed 已退役（0007 P3：逐页克隆内容化取代，
 *   fixed 会使克隆叠影）；屏显边距模拟 / 打印归零规则保留断言；
 * ③ 走导出同路径：loadFile → paginatePdfWindow（预览同源装箱写回 sheet）→ printToPDF
 *   页化参数（零边距 + 无 header/footer，与 doc.exportPdf 页化分支同参）；
 * ④ Logo 逐页内容化断言：DOM 侧每 sheet 恰好 1 个 .paper-logo 且 inline 坐标逐点一致；
 *   PDF 侧每页内容流含图像 Do（品红位图是全卷唯一图片 XObject）；
 * ⑤ 像素采样（视觉层断言铁律）：pdftoppm 逐页渲染 PNG → nativeImage 位图扫品红包围盒，
 *   逐页落点 == 屏显 DOM 实测落点（容差 ≈1.6mm）——屏显/打印两态落点差消除的实机证据；
 * ⑥ 页码内容化逐页断言：pdftotext（-enc UTF-8）文本层每页含「第 N 页 / 共 M 页」。
 * ⑦ 0007 P5：段级装箱 + 「纸张结束」提示——DOM 侧逐 sheet 1 个 .mf-sheet-end 且线落
 *   内容区底边（纸高 − 下边距，config 路径有页边距 → 标签可见区）；提示为屏显物，
 *   PDF 页数仍 == sheet 数（绝对定位零流内高）。
 * 产物 smoke-multipage.{html,pdf} 留存 tmp-smoke/tmp/ 供目检。
 */
/** 品红 4×4 PNG（zlib 运行时生成；探针 Logo 唯一色源，像素采样阈值 r>200&&b>200&&g<120） */
const MAGENTA_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEUlEQVR4nGP4z/AfjhiI4wAAPSEf4dghpuIAAAAASUVORK5CYII=';

/** 位图品红扫描 → 包围盒（BGRA；无品红像素返回 null） */
function scanMagentaBBox(pngPath: string): { cx: number; cy: number; w: number } | null {
  const img = nativeImage.createFromPath(pngPath);
  const { width, height } = img.getSize();
  const bitmap = img.toBitmap();
  if (bitmap.length !== width * height * 4) {
    throw new Error(`位图尺寸异常（${bitmap.length} != ${width * height * 4}，scaleFactor 预期 1）`);
  }
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4; // BGRA
      if (bitmap[o] > 200 && bitmap[o + 2] > 200 && bitmap[o + 1] < 120) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w: maxX - minX + 1 };
}

async function runMultiPagePdfProbe(tmpDir: string): Promise<void> {
  const { buildPaperHtml } = await import('../docgen/render/buildPaperHtml.js');

  // 探针资产根：品红 Logo 位图 + SVG 题图（矢量，不产生图像 XObject）
  const assetsRoot = join(tmpDir, 'probe-assets');
  const logosDir = join(assetsRoot, 'logos');
  const figuresDir = join(assetsRoot, 'capture');
  mkdirSync(logosDir, { recursive: true });
  mkdirSync(figuresDir, { recursive: true });
  writeFileSync(join(logosDir, 'pixel.png'), Buffer.from(MAGENTA_PNG_BASE64, 'base64'));
  writeFileSync(
    join(figuresDir, 'probe.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="150"><rect width="298" height="148" x="1" y="1" fill="none" stroke="black" stroke-width="2"/><line x1="1" y1="1" x2="299" y2="149" stroke="black" stroke-width="2"/></svg>',
    'utf-8'
  );

  const questions: Question[] = Array.from({ length: 10 }, (_, i) => ({
    id: `probe-q${i + 1}`,
    subject: '物理',
    sourceType: 'local',
    sourceDetail: { origin: 'smoke' },
    content:
      `<div class="question">第 ${i + 1} 题：如图所示，光滑水平面上质量为 ` +
      `<span class="math" data-tex="m=${i + 1}\\,\\text{kg}" data-display="true"></span>` +
      ` 的物体受水平恒力作用，由静止开始运动。` +
      `<figure data-w="300"><img src="data-assets/capture/probe.svg"></figure>` +
      `<p>求物体的加速度大小，以及 ${i + 1} 秒末的速度。</p>` +
      `</div>`,
    answer: `<p><span class="math" data-tex="a=F/m" data-display="false"></span></p>`,
    images: [],
    createdAt: '2026-09-09T00:00:00Z',
    updatedAt: '2026-09-09T00:00:00Z',
  }));

  const paper: Paper = {
    id: 'probe-multipage',
    title: 'fix-3 多页探针卷',
    config: { totalScore: 100, duration: 90 },
    createdAt: '2026-09-09T00:00:00Z',
    archived: false,
  };
  const layoutConfig: PaperLayoutConfig = {
    version: 2,
    answerSpace: { enabled: true, style: 'lines', heightMm: 45 },
    logos: [{ assetId: 'logos/pixel.png', xRatio: 0.06, yRatio: 0.05, widthRatio: 0.12 }],
  };

  const html = await buildPaperHtml(paper, questions, { mode: 'teacher', assetsRoot, layoutConfig });

  // 打印分流断言（0007 P3 演进：Logo fixed 退役；屏显边距模拟/打印归零保留）
  if (html.includes('.paper-logo { position: fixed; }')) {
    throw new Error('多页探针：Logo 打印 fixed 规则应已退役（0007 P3 逐页克隆取代）');
  }
  if (!html.includes('@media print { .paper { padding: 0; } }')) {
    throw new Error('多页探针：打印 padding 归零规则缺失');
  }
  if (!html.includes('@media screen { .paper { box-sizing: border-box; padding: 20mm 15mm 20mm 15mm; } }')) {
    throw new Error('多页探针：屏显页边距模拟规则缺失');
  }

  const tmpHtmlPath = join(tmpDir, 'smoke-multipage.html');
  writeFileSync(tmpHtmlPath, html, 'utf-8');
  const pdfWindow = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  await pdfWindow.loadFile(tmpHtmlPath);

  // 0007 P3：页化导出同路径（预览同源运行时装箱写回 sheet）
  const stats = await paginatePdfWindow(pdfWindow.webContents, { pageWmm: 210, pageHmm: 297, columns: 1, columnGapMm: 0 });
  if (stats.sheets < 3) {
    pdfWindow.close();
    throw new Error(`多页探针：sheet 数不足（${stats.sheets} < 3，卷内容应≥3 页）`);
  }
  if (stats.overflow !== 0) {
    pdfWindow.close();
    throw new Error(`多页探针：存在溢出块（${stats.overflow}，探针卷单题均低于页容量）`);
  }

  // DOM 侧：每 sheet 恰好 1 个 Logo 且 inline 坐标逐点一致；屏显落点（首页实测 mm）作像素采样期望；
  // 0007 P5：「纸张结束」提示逐 sheet 一个且线落内容区底边（config 路径有页边距 → 标签可见区）
  const logoInfoJson: string = await pdfWindow.webContents.executeJavaScript(
    `(function () {
      var sheets = document.querySelectorAll('.mf-sheet');
      var out = { counts: [], styles: [], first: null, sheetEndCount: 0, sheetEndTops: [], padBottom: 0 };
      for (var i = 0; i < sheets.length; i++) {
        var logos = sheets[i].querySelectorAll('.paper-logo');
        out.counts.push(logos.length);
        if (logos[0]) out.styles.push(logos[0].style.left + '|' + logos[0].style.top + '|' + logos[0].style.width);
        var end = sheets[i].querySelector(':scope > .mf-sheet-end');
        if (end) out.sheetEndCount++;
        out.sheetEndTops.push(end ? end.style.top : null);
        if (i === 0) {
          out.padBottom = parseFloat(sheets[0].style.paddingBottom) || 0;
          if (logos[0]) {
            var sr = sheets[0].getBoundingClientRect();
            var lr = logos[0].getBoundingClientRect();
            out.first = {
              leftMm: (lr.left - sr.left) * 25.4 / 96,
              topMm: (lr.top - sr.top) * 25.4 / 96,
              wMm: lr.width * 25.4 / 96,
              hMm: lr.height * 25.4 / 96,
            };
          }
        }
      }
      return JSON.stringify(out);
    })()`,
  );
  const logoInfo = JSON.parse(logoInfoJson) as {
    counts: number[];
    styles: string[];
    first: { leftMm: number; topMm: number; wMm: number; hMm: number } | null;
    sheetEndCount: number;
    sheetEndTops: (string | null)[];
    padBottom: number;
  };
  if (logoInfo.counts.length !== stats.sheets || !logoInfo.counts.every((c) => c === 1)) {
    pdfWindow.close();
    throw new Error(`多页探针：Logo 未逐 sheet 内容化（逐页计数 ${logoInfo.counts.join(',')}，应全 1）`);
  }
  if (!logoInfo.first || !logoInfo.styles.every((s) => s === logoInfo.styles[0])) {
    pdfWindow.close();
    throw new Error(`多页探针：Logo 克隆坐标不一致（${logoInfo.styles.join(' / ')}）`);
  }
  // 纸张结束提示：线=内容区底边（纸高 − 下边距），逐 sheet 一个，绝对定位不占流内高（页数不受影响）
  const expectEndTop = `${Math.round((297 * 96) / 25.4 - logoInfo.padBottom)}px`;
  if (logoInfo.sheetEndCount !== stats.sheets || !logoInfo.sheetEndTops.every((t) => t === expectEndTop)) {
    pdfWindow.close();
    throw new Error(
      `多页探针：纸张结束提示异常——逐 sheet ${logoInfo.sheetEndCount}/${stats.sheets}，` +
      `top=[${logoInfo.sheetEndTops.join(',')}] 应全为 ${expectEndTop}（下边距 ${logoInfo.padBottom}px）`,
    );
  }

  // 页化参数 printToPDF（与 doc.exportPdf 页化分支同参）
  const pdfData = await pdfWindow.webContents.printToPDF({
    printBackground: true,
    pageSize: 'A4',
    displayHeaderFooter: false,
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
  });
  pdfWindow.close();

  const pdfPath = join(tmpDir, 'smoke-multipage.pdf');
  writeFileSync(pdfPath, pdfData);

  const pages = pageContentStreams(pdfData);
  if (pages.length !== stats.sheets) {
    throw new Error(`多页探针：PDF 页数 ${pages.length} != sheet 数 ${stats.sheets}`);
  }
  // 每页内容流含图像 Do（品红位图是全卷唯一图片 XObject → Logo 每页内容化入 PDF）
  for (let p = 0; p < pages.length; p++) {
    if (!/\/[A-Za-z]+\d*\s+Do\b/.test(pages[p])) {
      throw new Error(`多页探针：PDF 第 ${p + 1} 页内容流无图像 Do（Logo 未逐页内容化）`);
    }
  }

  // 页码内容化逐页断言（pdftotext 双通道传统；-enc UTF-8 防 Latin-1 中文失真；
  // -raw 保原文序——阅读序模式会把「第 N 页 / 共 M 页」里的空格按字距吞掉，页码串断词）
  const text = execFileSync('pdftotext', ['-enc', 'UTF-8', '-raw', pdfPath, '-'], { encoding: 'utf-8' });
  const textPages = text.split('\f');
  for (let p = 0; p < pages.length; p++) {
    const pageText = textPages[p] ?? '';
    if (!pageText.includes(`第 ${p + 1} 页`) || !pageText.includes(`共 ${pages.length} 页`)) {
      throw new Error(`多页探针：PDF 第 ${p + 1} 页页码内容化缺失（应含「第 ${p + 1} 页 / 共 ${pages.length} 页」）`);
    }
  }

  // 像素采样：逐页 PNG 品红包围盒 == 屏显 DOM 落点（屏显/打印两态落点差消除的实机证据）
  const pngPrefix = join(tmpDir, 'smoke-multipage-page');
  execFileSync('pdftoppm', ['-png', '-r', '96', pdfPath, pngPrefix]);
  const MM_TO_PX = 96 / 25.4;
  const expectCx = (logoInfo.first.leftMm + logoInfo.first.wMm / 2) * MM_TO_PX;
  const expectCy = (logoInfo.first.topMm + logoInfo.first.hMm / 2) * MM_TO_PX;
  const expectW = logoInfo.first.wMm * MM_TO_PX;
  const pngFiles = readdirSync(tmpDir)
    .filter((f) => f.startsWith('smoke-multipage-page-') && f.endsWith('.png'))
    .sort((a, b) => parseInt(a.match(/-(\d+)\.png$/)![1], 10) - parseInt(b.match(/-(\d+)\.png$/)![1], 10));
  if (pngFiles.length !== pages.length) {
    throw new Error(`多页探针：pdftoppm 渲染页数 ${pngFiles.length} != PDF 页数 ${pages.length}`);
  }
  for (let p = 0; p < pngFiles.length; p++) {
    const bbox = scanMagentaBBox(join(tmpDir, pngFiles[p]));
    if (!bbox) {
      throw new Error(`多页探针：PDF 第 ${p + 1} 页未找到品红 Logo 像素`);
    }
    if (Math.abs(bbox.cx - expectCx) > 6 || Math.abs(bbox.cy - expectCy) > 6 || Math.abs(bbox.w - expectW) > 8) {
      throw new Error(
        `多页探针：第 ${p + 1} 页 Logo 落点屏显≠打印——像素 bbox(cx=${bbox.cx.toFixed(1)},cy=${bbox.cy.toFixed(1)},w=${bbox.w}) ` +
        `vs 期望(${expectCx.toFixed(1)},${expectCy.toFixed(1)},w≈${expectW.toFixed(1)})（容差 6px≈1.6mm）`,
      );
    }
  }
  console.log(`     多页探针：${pages.length} 页，Logo 逐页内容化 + 像素落点屏显=打印（逐页 ≤1.6mm）+ 页码逐页正确`);
}

/**
 * 0007 P2 页化对拍探针（预览=导出同构的实机断言）→ 0007 P5 演进为段级语义：
 * ① 合成 10 题纯文字探针卷——题号 span 色 rgb(i+1,0,0)，PDF 内容流里首个非零
 *   `x 0 0 rg` 即该页**新题起点**（纯 JS 解析；探针卷无 Logo/公式，全卷红字仅题号 span，
 *   续片段无题号 → 纯续页允许无红字）；
 * ② 隐藏窗走导出同路径：loadFile → paginatePdfWindow（与 doc.exportPdf 同一 helper，
 *   预览同源运行时装箱写回）→ DOM 侧读「逐 sheet 首个非续片段的 data-mf-qindex」；
 * ③ printToPDF 页化参数（displayHeaderFooter:false + 零边距，与导出同参）；
 * ④ 断言：PDF 页数 == sheet 数；逐页新题起点一致（纯续页 PDF 无题号红字）；
 *   题首防孤（含 .question-header 的片段必含段落）；段级断页生效（续片段页 ≥1）；
 *   「纸张结束」提示逐 sheet 一个且线落内容区底边、打印隐藏（PDF 文本层不得出现）；
 *   续片段「（续）」标记入 PDF 文本层（预览=PDF 同源）；溢出块数 == 0。
 * 产物 smoke-paginate-parity.{html,pdf} 留存 tmp 供目检。
 */
function pageContentStreams(pdf: Buffer): string[] {
  const latin = pdf.toString('latin1');
  const objStreams = new Map<number, string>();
  for (const m of latin.matchAll(/(\d+)\s+\d+\s+obj\b([\s\S]*?)endobj/g)) {
    const body = m[2];
    if (!body.includes('/FlateDecode')) continue;
    const relStreamMark = body.indexOf('stream');
    if (relStreamMark < 0) continue;
    // 0007 P5 硬化：对象体可能因压缩流内偶现 "endobj" 被非贪婪匹配截断（实测 7 页卷丢 1 页）——
    // 流数据改以 /Length 精确定位（间接 Length 引用时回退 endstream 搜索），坐标按原文反推 body 起点。
    const bodyStart = m.index + (m[0].length - body.length - 'endobj'.length);
    const absStreamMark = bodyStart + relStreamMark;
    const dict = latin.slice(bodyStart, absStreamMark);
    const lengthMatch = dict.match(/\/Length\s+(\d+)(\s+\d+\s+R)?/);
    const declared = lengthMatch && lengthMatch[2] === undefined ? parseInt(lengthMatch[1], 10) : null;
    let start = absStreamMark + 'stream'.length;
    if (latin.charCodeAt(start) === 13) start++;
    if (latin.charCodeAt(start) === 10) start++;
    const end = declared !== null ? start + declared : latin.indexOf('endstream', start);
    if (end <= start) continue;
    const raw = Buffer.from(latin.slice(start, end), 'latin1');
    try {
      objStreams.set(parseInt(m[1], 10), inflateSync(raw).toString('latin1'));
    } catch {
      try {
        objStreams.set(parseInt(m[1], 10), inflateRawSync(raw).toString('latin1'));
      } catch {
        /* 非 zlib 流跳过 */
      }
    }
  }
  // 页对象文档序=页序（Chromium 顺页写出）；/Type /Page\b 不吃 /Pages（\b 挡住 s）
  const pages: string[] = [];
  for (const m of latin.matchAll(/(\d+)\s+\d+\s+obj\b([\s\S]*?)endobj/g)) {
    const body = m[2];
    if (!/\/Type\s*\/Page\b/.test(body)) continue;
    const contents = body.match(/\/Contents\s+(?:\[\s*)?(\d+)\s+\d+\s+R/);
    if (!contents) continue;
    const stream = objStreams.get(parseInt(contents[1], 10));
    if (stream !== undefined) pages.push(stream);
  }
  return pages;
}

/** 内容流里首个非零红（`x 0 0 rg`，x>0）→ 红值 1..255；无红字返回 null */
function firstRedValue(stream: string): number | null {
  for (const m of stream.matchAll(/([\d.]+)\s+0\s+0\s+rg\b/g)) {
    const v = parseFloat(m[1]);
    if (v > 0) return Math.round(v * 255);
  }
  return null;
}

async function runPaginateParityProbe(tmpDir: string): Promise<void> {
  const { buildPaperHtml } = await import('../docgen/render/buildPaperHtml.js');

  // 纯文字探针卷：每题约 2/3 页高（无图无公式，红字仅题号 span）
  const filler = '探针填充文本：页化对拍断言预览装箱与导出 PDF 实际分页逐页一致。'.repeat(3);
  const questions: Question[] = Array.from({ length: 10 }, (_, i) => ({
    id: `parity-q${i + 1}`,
    subject: '物理',
    sourceType: 'local',
    sourceDetail: { origin: 'smoke' },
    content:
      `<div class="question"><p><span style="color: rgb(${i + 1}, 0, 0);">第 ${i + 1} 题</span>　${filler}</p>` +
      Array.from({ length: 8 }, () => `<p>${filler}</p>`).join('') +
      `</div>`,
    answer: `<p>探针答案 ${i + 1}</p>`,
    images: [],
    createdAt: '2026-09-09T00:00:00Z',
    updatedAt: '2026-09-09T00:00:00Z',
  }));

  const paper: Paper = {
    id: 'probe-paginate-parity',
    title: '0007 页化对拍探针卷',
    config: { totalScore: 100, duration: 90 },
    createdAt: '2026-09-09T00:00:00Z',
    archived: false,
  };

  const html = await buildPaperHtml(paper, questions, { mode: 'student' });
  const tmpHtmlPath = join(tmpDir, 'smoke-paginate-parity.html');
  writeFileSync(tmpHtmlPath, html, 'utf-8');

  const pdfWindow = new BrowserWindow({
    show: false,
    width: Math.ceil((210 * 96) / 25.4) + 80,
    height: 1200,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  await pdfWindow.loadFile(tmpHtmlPath);

  // 导出同路径：字体/图片就绪 → 预览同源运行时装箱写回 → 读统计
  const paginate = { pageWmm: 210, pageHmm: 297, columns: 1 as const, columnGapMm: 0 };
  const stats = await paginatePdfWindow(pdfWindow.webContents, paginate);
  if (stats.sheets < 3) {
    pdfWindow.close();
    throw new Error(`页化对拍：sheet 数不足（${stats.sheets} < 3，探针卷应≥3 页）`);
  }
  if (stats.overflow !== 0) {
    pdfWindow.close();
    throw new Error(`页化对拍：存在溢出块（${stats.overflow}，探针卷单题均低于页容量）`);
  }

  // DOM 侧（0007 P5 段级语义）：
  //  · 逐 sheet「新题起点」= 该 sheet 首个非续片段（.mf-continued 无题号 → PDF 侧红字对位）；
  //  · 段级断页生效证据：以续片段开头的 sheet 数（>0 且题跨页）；
  //  · 防孤：含 .question-header 的片段必含 ≥1 段（题首与首段同片）；
  //  · 「纸张结束」提示：逐 sheet 一个、top=内容区底边、打印样式隐藏。
  const domJson: string = await pdfWindow.webContents.executeJavaScript(
    `(function () {
      var sheets = Array.prototype.slice.call(document.querySelectorAll('.mf-sheet'));
      var firstNew = sheets.map(function (s) {
        var frags = s.querySelectorAll(':scope > .question-item');
        for (var i = 0; i < frags.length; i++) {
          if (!frags[i].classList.contains('mf-continued')) {
            var q = frags[i].getAttribute('data-mf-qindex');
            return q === null ? null : parseInt(q, 10);
          }
        }
        return null;
      });
      var continuedSheets = sheets.filter(function (s) {
        var first = s.querySelector(':scope > .question-item');
        return Boolean(first && first.classList.contains('mf-continued'));
      }).length;
      var headerFrags = 0, headerFragsWithoutPara = 0;
      Array.prototype.forEach.call(document.querySelectorAll('.question-item'), function (f) {
        if (!f.querySelector('.question-header')) return;
        headerFrags++;
        if (!f.querySelector('p')) headerFragsWithoutPara++;
      });
      var styleEl = document.querySelector('style[data-mf-paginate-css]');
      return JSON.stringify({
        sheets: sheets.length,
        firstNew: firstNew,
        continuedSheets: continuedSheets,
        headerFrags: headerFrags,
        headerFragsWithoutPara: headerFragsWithoutPara,
        sheetEndCount: sheets.filter(function (s) { return Boolean(s.querySelector(':scope > .mf-sheet-end')); }).length,
        sheetEndTops: sheets.map(function (s) {
          var e = s.querySelector(':scope > .mf-sheet-end');
          return e ? e.style.top : null;
        }),
        padBottom: sheets.length ? (parseFloat(sheets[0].style.paddingBottom) || 0) : 0,
        sheetEndPrintHidden: Boolean(styleEl && styleEl.textContent.indexOf('@media print') >= 0
          && /\\.mf-sheet-end \\{ display: none; \\}/.test(styleEl.textContent)),
      });
    })()`,
  );
  const dom = JSON.parse(domJson) as {
    sheets: number;
    firstNew: (number | null)[];
    continuedSheets: number;
    headerFrags: number;
    headerFragsWithoutPara: number;
    sheetEndCount: number;
    sheetEndTops: (string | null)[];
    padBottom: number;
    sheetEndPrintHidden: boolean;
  };
  // 防孤：题首片段必含首段（题首不落单）
  if (dom.headerFrags !== questions.length || dom.headerFragsWithoutPara !== 0) {
    pdfWindow.close();
    throw new Error(`页化对拍：题首防孤失败——题首片段 ${dom.headerFrags}（应 ${questions.length}），其中无段落 ${dom.headerFragsWithoutPara}（应 0）`);
  }
  // 段级断页生效（P5 行为锚点：题内段落跨页 → 续片段开头的 sheet）
  if (dom.continuedSheets < 1) {
    pdfWindow.close();
    throw new Error(`页化对拍：段级断页未生效（以续片段开头的 sheet 数 ${dom.continuedSheets}，探针卷题目应跨页）`);
  }
  // 纸张结束提示：逐 sheet 一个，线落内容区底边（纸高 − 下边距），打印隐藏规则在
  const expectedEndTop = `${Math.round((297 * 96) / 25.4 - dom.padBottom)}px`;
  if (dom.sheetEndCount !== stats.sheets || !dom.sheetEndTops.every((t) => t === expectedEndTop)) {
    pdfWindow.close();
    throw new Error(`页化对拍：纸张结束提示异常——逐 sheet 计数 ${dom.sheetEndCount}/${stats.sheets}，top=[${dom.sheetEndTops.join(',')}] 应全为 ${expectedEndTop}`);
  }
  if (!dom.sheetEndPrintHidden) {
    pdfWindow.close();
    throw new Error('页化对拍：纸张结束提示未随打印样式隐藏（PDF 每页会多一条屏显提示）');
  }

  const pdfData = await pdfWindow.webContents.printToPDF({
    printBackground: true,
    pageSize: 'A4',
    displayHeaderFooter: false,
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
  });
  pdfWindow.close();

  const pdfPath = join(tmpDir, 'smoke-paginate-parity.pdf');
  writeFileSync(pdfPath, pdfData);

  const pages = pageContentStreams(pdfData);
  if (pages.length !== stats.sheets) {
    throw new Error(`页化对拍：PDF 页数 ${pages.length} != sheet 数 ${stats.sheets}`);
  }
  // 逐页首题对拍（段级语义：续片段页无题号 → PDF 该页首个红字=该页新题；纯续页 red=null 合法）
  for (let p = 0; p < pages.length; p++) {
    const red = firstRedValue(pages[p]);
    const expected = dom.firstNew[p];
    if (expected === null) {
      if (red !== null) {
        throw new Error(`页化对拍：第 ${p + 1} 页无新题起点（续片段页），PDF 却出现题号红字 ${red}`);
      }
      continue;
    }
    if (red === null) {
      throw new Error(`页化对拍：PDF 第 ${p + 1} 页未找到题号红字（预览该页新题为第 ${expected + 1} 题）`);
    }
    const pdfQIndex = red - 1; // 题 i（0 基）红值 = i+1（避开 0=黑）
    if (pdfQIndex !== expected) {
      throw new Error(`页化对拍：第 ${p + 1} 页新题起点不一致——PDF=题 ${pdfQIndex + 1}，预览 sheet=题 ${expected + 1}`);
    }
  }
  // 视觉层/文本层断言（PDF 实机）：续片段标「（续）」入 PDF 文本层（预览=PDF 同源），
  // 「纸张结束」提示为屏显物——不得入 PDF 文本层（否则打印件每页多一条提示）。
  const pdfText = execFileSync('pdftotext', ['-enc', 'UTF-8', '-raw', pdfPath, '-'], { encoding: 'utf-8' });
  if (!pdfText.includes('（续）')) {
    throw new Error('页化对拍：PDF 文本层缺「（续）」续片段标记（段级断页在导出侧未同源呈现）');
  }
  if (pdfText.includes('纸张结束')) {
    throw new Error('页化对拍：PDF 文本层出现「纸张结束」提示（屏显物未按打印样式隐藏）');
  }
  console.log(
    `     页化对拍：${stats.sheets} 页，逐页新题起点一致（${dom.firstNew.map((q) => (q ?? -1) + 1).join(',')}）` +
    `，续片段页 ${dom.continuedSheets}，题首防孤 ${dom.headerFrags}/${dom.headerFrags}，纸张结束提示 ${dom.sheetEndCount}/${stats.sheets}`,
  );
}

/**
 * 0007 P4 A3 横版双列对拍探针（双列打印根治的实机断言）→ 0007 P5 段级语义演进：
 * ① 合成 12 题红色题号卷（同页化对拍手法：PDF 内容流首个非零 `x 0 0 rg` = 该页新题起点），
 *   layoutConfig：A3 + landscape + columns:2 + gap 8mm + exam 抬头（通栏验证）；
 * ② 隐藏窗视口归一：宽=纸宽 px + 余量（420mm≈1587px > 缺省 800px 视口，不归一则 .paper
 *   被钳窄、超页高预判失真）→ loadFile → paginatePdfWindow（columns:2）→ 手工列盒段级装箱；
 * ③ DOM 断言：每 sheet = .mf-sheet-cols > 2×.mf-col（无 columnCount 内联——Chromium
 *   断列路径退役）；抬头为 sheet 直接子级（通栏，不在列盒内）；列内续片段 ≥1（段级断页生效）；
 *   题首防孤（含 .question-header 的片段必含段落）；纸张结束提示逐 sheet；
 * ④ printToPDF A3 landscape 页化参数 → pdfinfo 出纸规格断言（1190.55×841.89pt 横版）；
 * ⑤ 对拍：PDF 页数 == sheet 数、逐页新题起点一致（纯续片段页 PDF 无题号红字）、溢出 0、
 *   PDF 文本层无「纸张结束」（屏显物打印隐藏）。
 * 产物 smoke-twocol-a3.{html,pdf} 留存 tmp 供目检（列内分布合理性归用户目检）。
 */
async function runTwoColumnParityProbe(tmpDir: string): Promise<void> {
  const { buildPaperHtml } = await import('../docgen/render/buildPaperHtml.js');

  const filler = '探针填充文本：A3 横版双列手工列盒对拍，断言预览装箱与导出 PDF 逐页一致。'.repeat(2);
  const questions: Question[] = Array.from({ length: 12 }, (_, i) => ({
    id: `twocol-q${i + 1}`,
    subject: '物理',
    sourceType: 'local',
    sourceDetail: { origin: 'smoke' },
    content:
      `<div class="question"><p><span style="color: rgb(${i + 1}, 0, 0);">第 ${i + 1} 题</span>　${filler}</p>` +
      Array.from({ length: 5 }, () => `<p>${filler}</p>`).join('') +
      `</div>`,
    answer: `<p>探针答案 ${i + 1}</p>`,
    images: [],
    createdAt: '2026-09-09T00:00:00Z',
    updatedAt: '2026-09-09T00:00:00Z',
  }));

  const paper: Paper = {
    id: 'probe-twocol-a3',
    title: '0007 双列对拍探针卷',
    config: { totalScore: 100, duration: 90 },
    createdAt: '2026-09-09T00:00:00Z',
    archived: false,
  };
  const layoutConfig: PaperLayoutConfig = {
    version: 2,
    pageSize: 'A3',
    orientation: 'landscape',
    columns: 2,
    columnGapMm: 8,
  };

  const html = await buildPaperHtml(paper, questions, { mode: 'student', layoutConfig });
  // column-count 收敛屏显断言（0007 P4：打印分栏=页化手工列盒，浏览器断列路径退役）
  if (!html.includes('@media screen { .paper-questions { column-count: 2; column-gap: 8mm; } }')) {
    throw new Error('双列对拍：column-count 未收敛 @media screen');
  }

  const tmpHtmlPath = join(tmpDir, 'smoke-twocol-a3.html');
  writeFileSync(tmpHtmlPath, html, 'utf-8');
  const pdfWindow = new BrowserWindow({
    show: false,
    // 视口归一：宽=420mm 纸宽 px + 余量（不归一则 .paper 被缺省 800px 视口钳窄）
    width: Math.ceil((420 * 96) / 25.4) + 80,
    height: 1200,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  await pdfWindow.loadFile(tmpHtmlPath);

  const stats = await paginatePdfWindow(pdfWindow.webContents, {
    pageWmm: 420, pageHmm: 297, columns: 2, columnGapMm: 8,
  });
  if (stats.sheets < 3) {
    pdfWindow.close();
    throw new Error(`双列对拍：sheet 数不足（${stats.sheets} < 3，12 题双列应≥3 页）`);
  }
  if (stats.overflow !== 0) {
    pdfWindow.close();
    throw new Error(`双列对拍：存在溢出块（${stats.overflow}，探针卷单题均低于列容量）`);
  }

  // DOM 结构断言 + 逐 sheet 新题起点（0007 P5 段级：阅读序=列盒链序 col0→col1，
  // 首个非续片段 = 该页新题起点；续片段无题号）
  const domJson: string = await pdfWindow.webContents.executeJavaScript(
    `(function () {
      var sheets = Array.prototype.slice.call(document.querySelectorAll('.mf-sheet'));
      var colCounts = sheets.map(function (s) { return s.querySelectorAll(':scope > .mf-sheet-cols > .mf-col').length; });
      var sheetFirst = sheets.map(function (s) {
        var frags = s.querySelectorAll('.mf-col .question-item');
        for (var i = 0; i < frags.length; i++) {
          if (!frags[i].classList.contains('mf-continued')) {
            var q = frags[i].getAttribute('data-mf-qindex');
            return q === null ? null : parseInt(q, 10);
          }
        }
        return null;
      });
      var continuedFrags = document.querySelectorAll('.mf-col .question-item.mf-continued').length;
      var headerFragsWithoutPara = 0;
      Array.prototype.forEach.call(document.querySelectorAll('.question-item'), function (f) {
        if (f.querySelector('.question-header') && !f.querySelector('p')) headerFragsWithoutPara++;
      });
      var badInlineCols = Array.prototype.some.call(
        document.querySelectorAll('.mf-sheet-cols'),
        function (el) { return Boolean(el.style.columnCount); },
      );
      return JSON.stringify({
        colCounts: colCounts,
        sheetFirst: sheetFirst,
        continuedFrags: continuedFrags,
        headerFragsWithoutPara: headerFragsWithoutPara,
        sheetEndCount: sheets.filter(function (s) { return Boolean(s.querySelector(':scope > .mf-sheet-end')); }).length,
        headerDirectChild: Boolean(sheets[0] && sheets[0].querySelector(':scope > .paper-header')),
        headerInCol: Boolean(document.querySelector('.mf-col .paper-header')),
        badInlineCols: badInlineCols,
      });
    })()`,
  );
  const dom = JSON.parse(domJson) as {
    colCounts: number[];
    sheetFirst: (number | null)[];
    continuedFrags: number;
    headerFragsWithoutPara: number;
    sheetEndCount: number;
    headerDirectChild: boolean;
    headerInCol: boolean;
    badInlineCols: boolean;
  };
  if (!dom.colCounts.every((c) => c === 2)) {
    pdfWindow.close();
    throw new Error(`双列对拍：列盒数异常（逐 sheet ${dom.colCounts.join(',')}，应全 2）`);
  }
  if (!dom.headerDirectChild || dom.headerInCol) {
    pdfWindow.close();
    throw new Error('双列对拍：抬头未通栏（应为 sheet 直接子级、不在列盒内）');
  }
  if (dom.badInlineCols) {
    pdfWindow.close();
    throw new Error('双列对拍：仍存在 columnCount 内联（Chromium 断列路径未退役干净）');
  }
  // 0007 P5：段级断页在列内生效（续片段存在）+ 题首防孤 + 纸张结束提示逐 sheet
  if (dom.continuedFrags < 1) {
    pdfWindow.close();
    throw new Error(`双列对拍：段级断页未生效（列内续片段数 ${dom.continuedFrags}，探针卷题目应跨列/跨页）`);
  }
  if (dom.headerFragsWithoutPara !== 0) {
    pdfWindow.close();
    throw new Error(`双列对拍：题首防孤失败（无段落的题首片段 ${dom.headerFragsWithoutPara}）`);
  }
  if (dom.sheetEndCount !== stats.sheets) {
    pdfWindow.close();
    throw new Error(`双列对拍：纸张结束提示异常（逐 sheet ${dom.sheetEndCount}/${stats.sheets}）`);
  }

  const pdfData = await pdfWindow.webContents.printToPDF({
    printBackground: true,
    pageSize: 'A3',
    landscape: true,
    displayHeaderFooter: false,
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
  });
  pdfWindow.close();

  const pdfPath = join(tmpDir, 'smoke-twocol-a3.pdf');
  writeFileSync(pdfPath, pdfData);

  // 出纸规格：A3 横版 = 1190.55 × 841.89 pt（pdfinfo 双通道）
  const info = execFileSync('pdfinfo', [pdfPath], { encoding: 'utf-8' });
  const sizeMatch = info.match(/Page size:\s*([\d.]+) x ([\d.]+) pts/);
  if (!sizeMatch || Math.abs(parseFloat(sizeMatch[1]) - 1190.55) > 2 || Math.abs(parseFloat(sizeMatch[2]) - 841.89) > 2) {
    throw new Error(`双列对拍：出纸规格非 A3 横版（${sizeMatch ? sizeMatch[0] : '未解析'}）`);
  }

  const pages = pageContentStreams(pdfData);
  if (pages.length !== stats.sheets) {
    throw new Error(`双列对拍：PDF 页数 ${pages.length} != sheet 数 ${stats.sheets}`);
  }
  for (let p = 0; p < pages.length; p++) {
    const red = firstRedValue(pages[p]);
    const expected = dom.sheetFirst[p];
    if (expected === null) {
      if (red !== null) {
        throw new Error(`双列对拍：第 ${p + 1} 页无新题起点（纯续片段页），PDF 却出现题号红字 ${red}`);
      }
      continue;
    }
    if (red === null) {
      throw new Error(`双列对拍：PDF 第 ${p + 1} 页未找到题号红字（预览该页新题为第 ${expected + 1} 题）`);
    }
    const pdfQIndex = red - 1;
    if (pdfQIndex !== expected) {
      throw new Error(`双列对拍：第 ${p + 1} 页新题起点不一致——PDF=题 ${pdfQIndex + 1}，预览 sheet=题 ${expected + 1}`);
    }
  }
  console.log(
    `     双列对拍：${pages.length} 页 A3 横版，逐页新题起点一致（${dom.sheetFirst.map((q) => (q ?? -1) + 1).join(',')}）` +
    `，列内续片段 ${dom.continuedFrags}，纸张结束提示 ${dom.sheetEndCount}/${stats.sheets}`,
  );
  // 屏显物不得入 PDF 文本层（纸张结束提示随打印样式隐藏）
  const twocolText = execFileSync('pdftotext', ['-enc', 'UTF-8', '-raw', pdfPath, '-'], { encoding: 'utf-8' });
  if (twocolText.includes('纸张结束')) {
    throw new Error('双列对拍：PDF 文本层出现「纸张结束」提示（屏显物未按打印样式隐藏）');
  }
}

/**
 * 0007 P6 长文段内行级拆分对拍探针（语文/英语阅读篇场景——长段落必跨页，段内按行盒断页）：
 * ① 合成阅读篇卷：q1 = 3 个长段（每段约 20+ 行，段内嵌唯一哨兵串）+ q2 = 单段超长（约 80 行，跨 2+ 页）；
 * ② 隐藏窗导出同路径：先抓页化前原文（逐字基准）→ paginatePdfWindow（懒测量 + 行级拆分写回）→
 *    DOM 侧断言：纸流阅读序逐字 == 原文（不丢字不重字）、续片段 ≥2、无 ⚠ 溢出（拆得掉不再标）、
 *    残段首行文字可取；③ printToPDF 页化参数 → PDF 页数 == sheet 数；
 *    PDF 文本层：含残段首行文字、含「（续）」、哨兵各恰好一次、无「纸张结束」。
 * 产物 smoke-inline-split.{html,pdf} 留存 tmp 供目检。
 */
async function runInlineSplitParityProbe(tmpDir: string): Promise<void> {
  const { buildPaperHtml } = await import('../docgen/render/buildPaperHtml.js');

  const filler = '语文阅读篇长文对拍填充：段内行级断页须与导出 PDF 逐页一致，不丢字不重字。';
  const longPara = (tag: string, repeat: number): string =>
    `<p>〈${tag}起〉${filler.repeat(repeat)}〈${tag}讫〉</p>`;
  const questions: Question[] = [
    {
      id: 'split-q1',
      subject: '语文',
      sourceType: 'local',
      sourceDetail: { origin: 'smoke' },
      content: `<div class="question">${longPara('甲', 24)}${longPara('乙', 24)}${longPara('丙', 24)}</div>`,
      answer: '<p>探针答案 1</p>',
      images: [],
      createdAt: '2026-09-11T00:00:00Z',
      updatedAt: '2026-09-11T00:00:00Z',
    },
    {
      id: 'split-q2',
      subject: '语文',
      sourceType: 'local',
      sourceDetail: { origin: 'smoke' },
      content: `<div class="question">${longPara('丁', 85)}</div>`,
      answer: '<p>探针答案 2</p>',
      images: [],
      createdAt: '2026-09-11T00:00:00Z',
      updatedAt: '2026-09-11T00:00:00Z',
    },
  ];
  const paper: Paper = {
    id: 'probe-inline-split',
    title: '0007 P6 长文段内拆分对拍卷',
    config: { totalScore: 100, duration: 90 },
    createdAt: '2026-09-11T00:00:00Z',
    archived: false,
  };

  const html = await buildPaperHtml(paper, questions, { mode: 'student' });
  const tmpHtmlPath = join(tmpDir, 'smoke-inline-split.html');
  writeFileSync(tmpHtmlPath, html, 'utf-8');
  const pdfWindow = new BrowserWindow({
    show: false,
    width: Math.ceil((210 * 96) / 25.4) + 80,
    height: 1200,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  await pdfWindow.loadFile(tmpHtmlPath);

  // 逐字基准：页化前的题文（页化会把题切成片段，对拍 = 片段拼接 == 原文）
  const beforeJson: string = await pdfWindow.webContents.executeJavaScript(
    `JSON.stringify(Array.prototype.map.call(document.querySelectorAll('.paper-questions .question-item'), function (el) { return el.textContent; }))`,
  );
  const beforeText = (JSON.parse(beforeJson) as string[]).join('');

  const t0 = Date.now();
  const stats = await paginatePdfWindow(pdfWindow.webContents, { pageWmm: 210, pageHmm: 297, columns: 1, columnGapMm: 0 });
  const paginateMs = Date.now() - t0;
  if (stats.sheets < 3) {
    pdfWindow.close();
    throw new Error(`长文对拍：sheet 数不足（${stats.sheets} < 3，阅读篇探针卷应≥3 页）`);
  }
  if (stats.overflow !== 0) {
    pdfWindow.close();
    throw new Error(`长文对拍：存在溢出块（${stats.overflow}）——段内行级拆分未生效（拆得掉的长段不应再标 ⚠）`);
  }

  const domJson: string = await pdfWindow.webContents.executeJavaScript(
    `(function () {
      var frags = Array.prototype.slice.call(document.querySelectorAll('.mf-sheet > .question-item'));
      var after = frags.map(function (f) { return f.textContent; }).join('');
      var continued = frags.filter(function (f) { return f.classList.contains('mf-continued'); }).length;
      // 残段首行文字（PDF 文本层抽验锚点）：首个续片段的首个 <p> 开头 8 字
      var cont = document.querySelector('.mf-sheet > .question-item.mf-continued p');
      var tailHead = cont ? (cont.textContent || '').slice(0, 8) : '';
      return JSON.stringify({ after: after, continued: continued, tailHead: tailHead });
    })()`,
  );
  const dom = JSON.parse(domJson) as { after: string; continued: number; tailHead: string };
  // 不丢字不重字：纸流阅读序逐字 == 页化前原文。口径 = 去空白逐字守恒：
  // 引擎产物的块间缩进空白是纯排版废符（渲染时坍缩、collectRuns 留原位不产单元），
  // 段内拆分后其归位顺序变（总字符守恒）——逐字断言须作用于内容字符（去空白），
  // 与 PDF 文本层对拍口径（pdfFlat 去空白）同源。（实测锚：before/after 各 6289 字、
  // 去空白各 5845 字逐字一致，差异全部为块间缩进空白归位。）
  const beforeFlat = beforeText.replace(/\s+/g, '');
  const afterFlat = dom.after.replace(/\s+/g, '');
  if (afterFlat !== beforeFlat) {
    pdfWindow.close();
    throw new Error(
      `长文对拍：拆分后全文去空白逐字不一致（页化前 ${beforeFlat.length} 字 / 页化后 ${afterFlat.length} 字）——存在丢字或重字`,
    );
  }
  if (dom.continued < 2) {
    pdfWindow.close();
    throw new Error(`长文对拍：续片段不足（${dom.continued} < 2，超长单段跨 2+ 页应产生多个续片段）`);
  }

  const pdfData = await pdfWindow.webContents.printToPDF({
    printBackground: true,
    pageSize: 'A4',
    displayHeaderFooter: false,
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
  });
  pdfWindow.close();

  const pdfPath = join(tmpDir, 'smoke-inline-split.pdf');
  writeFileSync(pdfPath, pdfData);

  const pages = pageContentStreams(pdfData);
  if (pages.length !== stats.sheets) {
    throw new Error(`长文对拍：PDF 页数 ${pages.length} != sheet 数 ${stats.sheets}`);
  }

  const pdfText = execFileSync('pdftotext', ['-enc', 'UTF-8', '-raw', pdfPath, '-'], { encoding: 'utf-8' });
  const pdfFlat = pdfText.replace(/\s+/g, '');
  // PDF 文本层含残段首行文字（预览=导出同一断点）
  const tailHeadFlat = dom.tailHead.replace(/\s+/g, '');
  if (!tailHeadFlat || !pdfFlat.includes(tailHeadFlat)) {
    throw new Error(`长文对拍：PDF 文本层缺残段首行文字「${dom.tailHead}」（段内断点预览≠导出）`);
  }
  // 哨兵各恰好一次（不丢字不重字的 PDF 侧抽验）
  for (const tag of ['甲', '乙', '丙', '丁']) {
    for (const mark of [`〈${tag}起〉`, `〈${tag}讫〉`]) {
      const hits = pdfFlat.split(mark).length - 1;
      if (hits !== 1) {
        throw new Error(`长文对拍：PDF 文本层哨兵「${mark}」出现 ${hits} 次（应恰好 1 次）`);
      }
    }
  }
  if (!pdfText.includes('（续）')) {
    throw new Error('长文对拍：PDF 文本层缺「（续）」续片段标记（段内拆分续片段与 P5 同款标记未同源呈现）');
  }
  if (pdfText.includes('纸张结束')) {
    throw new Error('长文对拍：PDF 文本层出现「纸张结束」提示（屏显物未按打印样式隐藏）');
  }
  console.log(
    `     长文对拍：${stats.sheets} 页，逐字一致（${beforeText.length} 字），续片段 ${dom.continued}，` +
    `残段首行「${dom.tailHead}…」入 PDF 文本层（页化耗时 ${paginateMs}ms）`,
  );
}


app.on('window-all-closed', () => {
  // 0035：smoke-docx 全程无主窗（导出在 whenReady 内同步跑完即 app.exit）——公式栅格隐藏窗
  // 用完销毁那一刻会触发本事件，照常 quit 会把导出从中间掐断（探针实测：产物 0 字节、无报错）。
  if (isSmokeDocx) return;
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

