/**
 * CaptureHost：采集宿主（主进程）
 *
 * 0012 P1 起为「内嵌 WebContentsView 托管」形态（P0 探针通过，0012 P0 台账在案）：
 * - open=attach：view 挂到主窗 contentView（初始零矩形，渲染层经 capture.setBounds 上报真实矩形）；
 *   close=detach：移除 view 并销毁 webContents，语义同现状关窗
 * - session.fromPartition('persist:mofang-capture')（登录态持久，账号密码不落盘，PRD §3 M1）：
 *   UA 剥 Electron 段（菁优分级投放铁律，红线零改动）
 * - 顶部采集栏为主窗 React 顶部栏（CapturePage，P2）；view 不再挂任何 preload（toolbar-preload 退役）
 * - 状态推送：导航/title → capture.event 事件推渲染层（getState 1s 轮询保留兜底）
 * - 独立窗兜底形态（P5，--capture-live 无人驱动场景）：openWindow({standalone:true}) 双形态共存
 * - extractBasket/collect：注入 dist/capture/inject.js（esbuild 单一来源 bundle，禁手工复制）
 * - 答案补抓：zujuan 走同 session 隐藏 offscreen BrowserWindow；jyeoo 两跳优先采集视图登录态
 *   会话内页内 fetch（D1-fix-4 方案①，openSessionPage），不可用回落隐藏窗（answer-fetch.ts 编排）
 * - P0.5 红线：切走标签（detach）后 executeJavaScript 通道自然失效；遮挡/最小化期提取如实拒绝
 */

import { app, BrowserWindow, Menu, session as electronSession, WebContentsView, type Session } from 'electron';
import { readFileSync, appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BankService, DictEntry, DictService, PaperExtService } from '../../shared/contracts/bank-types.js';
import type {
  CaptureExtraction, CaptureWindowState, CapturedQuestion,
  PaperPreview, PaperPreviewItem, PaperImportRequest, PaperImportResult, PaperImportTarget,
} from '../../shared/contracts/capture-types.js';
import type {
  CaptureCollectResult, CaptureEventPayload, CaptureSavePageHtmlResult,
} from '../../shared/contracts/ipc-channels.js';
import { IPC_CHANNELS } from '../../shared/contracts/ipc-channels.js';
import { detectSite, detectLoggedIn } from './state.js';
import { enrichAnswers, injectStoredBankids, type HiddenPage } from './answer-fetch.js';
import { resolveCaptureStageSubject } from '../subject.js';
import type { CapturePageSignals } from './page-context.js';
import { htmlToText } from '../adapters/detail-pages.js';
import { downloadQuestionImages } from '../assets.js';
import { ingestCaptured, setQuestionService, setTreeService, type IngestOptions } from '../ingest.js';
import { splitStageSubject, subjectIdOf } from '../subject.js';
import { collectPaperQuestions, type PaperCollectResult } from '../papers/collect.js';
import { parseZujuanPaperUrl, ZUJUAN_PAPER_URL_HINT } from '../papers/paper-url.js';
import { assemblePaper } from '../papers/paper-import.js';

export interface CaptureHostDeps {
  bankService: BankService;
  /** app.getPath('userData') */
  userDataPath: string;
  /** 0006 P2（只增，可选）：注入后题带 meta.sourceNodeIds 时入库挂树 */
  treeService?: import('../../shared/contracts/bank-types.js').TreeService;
  /**
   * 0006-fix-3 P3（只增，可选）：学科字典服务——collect 时把用户选择学科解析为 subjectId 喂给 ingest；
   * 缺省（旧装配/测试）不解析不告警，行为同改造前（只落 subject 单学科中文）。
   */
  dictService?: DictService;
  /**
   * 0006 P4（只增，可选）：成品卷服务（createPaperEx/挂题/快照/置 done）。
   * 缺省时整卷下载的「成品卷」去向抛明确错误，「散题入题库」不受影响。
   */
  paperService?: PaperExtService;
  /**
   * 0012 P1（只增，可选）：内嵌 view 挂载的容器窗提供者——attach 时求值（主窗可能晚于宿主创建）。
   * 缺省回落当下首个存活窗口（capture-smoke driver 场景）。
   */
  getContainerWindow?: () => BrowserWindow | null;
}

/** 0012 P1：状态事件推送防抖（导航/title 连发合并；测试等待 ≤500ms 落定） */
const STATE_PUSH_DEBOUNCE_MS = 300;

export class CaptureHost {
  private view: WebContentsView | null = null;
  /** P5 独立窗兜底形态（--capture-live 无人驱动场景），与内嵌 view 双形态共存 */
  private standaloneWindow: BrowserWindow | null = null;
  /** 当前 open 语义所用的形态（navigate 自动开窗时沿用） */
  private useStandalone = false;
  private readonly captureSession: Session;
  private currentUrl = '';
  private currentTitle = '';
  private lastExtraction: { at: string; count: number } | null = null;
  // L-2：最近一次提取的完整结果（控件条提取后主窗经 capture.getLastExtraction 拉取）
  private lastExtractionData: CaptureExtraction | null = null;
  private injectBundle: string | null = null;
  /** 0006 P4：最近一次整卷抓取结果（预览勾选 → 导入复用，避免二次抓取） */
  private lastPaperCollect: PaperCollectResult | null = null;
  /** 0012 P1：渲染层最近一次上报的 bounds（零宽高=遮挡/隐藏编排期）；null=尚未上报 */
  private lastBounds: { x: number; y: number; width: number; height: number } | null = null;
  private statePushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: CaptureHostDeps) {
    this.captureSession = electronSession.fromPartition('persist:mofang-capture');
    // D1-fix-4 实站定级（ua-probe/ua-login-probe 快照取证）：菁优按客户端 UA 分级投放——
    // Electron 自报 UA（… Electron/x.y.z）被降级为混淆页（零化 fieldset id/题干抽字/详情错位），
    // 标准 Chrome UA + 登录态取回完整真实数据（用户肉眼复验：无缺字、点题不错位）。
    // 采集视图是用户真人登录、真人操作的完整 Chromium 界面，呈现真实浏览器 UA 属任务书方案①授权。
    // 注意：登录态与 UA 绑定，改 UA 后既有菁优会话失效，用户需重新登录一次（如实提示，不代登）。
    // 取默认 UA 剥掉 Electron 段，Chrome 版本号随 Electron 升级自动漂移，无需手工同步。
    this.captureSession.setUserAgent(this.captureSession.getUserAgent().replace(/ Electron\/\S+/, ''));
  // ingest 期望 bridge 形态 service（createQuestion({data})），适配 BankService 裸签名
  setQuestionService({
    listQuestions: () => deps.bankService.listQuestions(),
    createQuestion: ({ data }: { data: Parameters<BankService['createQuestion']>[0] }) =>
      deps.bankService.createQuestion(data),
    // D1-fix-4 复验 R-U：重采回填（dup 命中补缺字段）需要更新能力
    updateQuestion: (id: string, data: Parameters<BankService['updateQuestion']>[1]) =>
      deps.bankService.updateQuestion(id, data),
  });
  // 0006 P2（只增）：树服务注入（缺省不挂树，行为与注入前完全一致）
  setTreeService(deps.treeService ?? null);
  }

  get session(): Session {
    return this.captureSession;
  }

  // ==================== 0012 P1：内嵌 view 生命周期（attach/detach） ====================

  async openWindow(options: { standalone?: boolean } = {}): Promise<void> {
    if (this.isOpen()) {
      // 已开：独立窗形态聚焦；内嵌 view 形态原样（bounds 由渲染层上报编排）
      this.standaloneWindow?.focus();
      return;
    }
    this.useStandalone = options.standalone === true;
    if (this.useStandalone) {
      this.openStandaloneWindow();
      return;
    }
    this.attachView();
  }

  /**
   * P5 独立窗兜底形态：无人驱动的 --capture-live 场景沿用独立窗（无渲染层上报 bounds）。
   * toolbar-preload 已随 P2 退役，导航能力以原生菜单 + 右键菜单承载（报告记档口径）。
   */
  private openStandaloneWindow(): void {
    const win = new BrowserWindow({
      width: 1200,
      height: 800,
      autoHideMenuBar: true,
      webPreferences: {
        session: this.captureSession,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.standaloneWindow = win;
    win.setMenu(Menu.buildFromTemplate([
      {
        label: '导航',
        submenu: [
          { label: '后退', click: () => win.webContents.goBack() },
          { label: '前进', click: () => win.webContents.goForward() },
          { label: '刷新', click: () => win.webContents.reload() },
        ],
      },
    ]));
    this.wireWebContents(win.webContents, () => this.standaloneWindow);
    win.on('closed', () => {
      if (this.standaloneWindow === win) {
        this.standaloneWindow = null;
        this.currentUrl = '';
        this.currentTitle = '';
      }
    });
  }

  /** 内嵌 view 挂载（P0 探针 A1：初始零矩形，渲染层打开流程完成后经 capture.setBounds 上报） */
  private attachView(): void {
    const container = this.resolveContainerWindow();
    if (!container) {
      throw new Error('capture view 无宿主窗口可挂载（主窗未就绪）');
    }
    const view = new WebContentsView({
      webPreferences: {
        session: this.captureSession,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // 0012 P2：toolbar-preload 退役——顶部栏为主窗 React 顶部栏，view 不挂任何 preload
      },
    });
    this.view = view;
    this.lastBounds = null;
    container.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    this.wireWebContents(view.webContents, () => this.resolveContainerWindow());
  }

  async closeWindow(): Promise<void> {
    this.clearStatePushTimer();
    if (this.standaloneWindow && !this.standaloneWindow.isDestroyed()) {
      this.standaloneWindow.close();
    }
    this.standaloneWindow = null;
    const view = this.view;
    this.view = null;
    this.currentUrl = '';
    this.currentTitle = '';
    this.lastBounds = null;
    if (view && !view.webContents.isDestroyed()) {
      // detach：从容器移除并销毁 webContents（语义同现状关窗；session 持久，重开不丢登录态）
      try {
        const container = this.resolveContainerWindow();
        if (container) container.contentView.removeChildView(view);
      } catch { /* 容器窗已关，view 随窗销毁 */ }
      view.webContents.close();
    }
  }

  private resolveContainerWindow(): BrowserWindow | null {
    const provided = this.deps.getContainerWindow?.() ?? null;
    if (provided && !provided.isDestroyed()) return provided;
    return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null;
  }

  private isOpen(): boolean {
    return !!(this.view && !this.view.webContents.isDestroyed())
      || !!(this.standaloneWindow && !this.standaloneWindow.isDestroyed());
  }

  /** 当前活动 webContents（内嵌 view 或独立窗）；未开返回 null */
  private activeWebContents(): Electron.WebContents | null {
    if (this.view && !this.view.webContents.isDestroyed()) return this.view.webContents;
    if (this.standaloneWindow && !this.standaloneWindow.isDestroyed()) return this.standaloneWindow.webContents;
    return null;
  }

  private requireWebContents(): Electron.WebContents {
    const wc = this.activeWebContents();
    if (!wc) {
      throw new Error('capture window not open（先 capture.openWindow）');
    }
    return wc;
  }

  /**
   * webContents 接线（内嵌 view 与独立窗共用）：F12/右键菜单/target=_blank 收编/导航与 title 跟踪
   * + 状态事件推送（0012 P1：capture.event，替代 1s 轮询快路径，轮询保留兜底）
   */
  private wireWebContents(wc: Electron.WebContents, getWindow: () => BrowserWindow | null): void {
    // F12 开发者工具 + 右键菜单（F-6：实站取证需要，不再禁用）
    wc.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') {
        wc.toggleDevTools();
      }
    });
    wc.on('context-menu', (_event, params) => {
      const container = getWindow();
      if (!container) return;
      const menu = Menu.buildFromTemplate([
        {
          label: '检查元素',
          click: () => {
            wc.inspectElement(params.x, params.y);
            if (!wc.isDevToolsOpened()) wc.openDevTools({ mode: 'detach' });
          },
        },
        { label: '重新加载', click: () => wc.reload() },
      ]);
      menu.popup({ window: container });
    });

    // target=_blank 管控：外链在当前采集视图内导航，不弹新窗
    wc.setWindowOpenHandler(({ url }) => {
      wc.loadURL(url);
      return { action: 'deny' };
    });

    wc.on('did-navigate', (_event, url) => {
      this.currentUrl = url;
      this.scheduleStatePush();
    });
    wc.on('did-navigate-in-page', (_event, url) => {
      this.currentUrl = url;
      this.scheduleStatePush();
    });
    wc.on('page-title-updated', (_event, title) => {
      this.currentTitle = title;
      this.scheduleStatePush();
    });
  }

  // ==================== 0012 P1：bounds 通道 + 事件推送 ====================

  /** 渲染层上报内嵌 view bounds（视口坐标；零宽高=遮挡/隐藏编排，P0 A3/A4 定稿） */
  async setBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<void> {
    this.lastBounds = { ...bounds };
    const view = this.view;
    if (!view || view.webContents.isDestroyed()) return; // 未挂载：仅记录（重挂后渲染层会重报）
    view.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    });
  }

  /** P0.5 红线：遮挡编排期/最小化隐藏期禁后台采集——提取动作如实拒绝 */
  private requireVisibleForCapture(): void {
    if (this.view) {
      if (this.lastBounds && this.lastBounds.width === 0 && this.lastBounds.height === 0) {
        throw new Error('采集视图当前不可见（被弹层遮挡或收起），请恢复视图后再提取');
      }
      return;
    }
    const win = this.standaloneWindow;
    if (win && !win.isDestroyed() && (win.isMinimized() || !win.isVisible())) {
      throw new Error('采集窗口当前不可见（最小化/隐藏），请恢复窗口后再提取');
    }
  }

  private scheduleStatePush(): void {
    this.clearStatePushTimer();
    this.statePushTimer = setTimeout(() => {
      this.statePushTimer = null;
      void this.pushStateEvent();
    }, STATE_PUSH_DEBOUNCE_MS);
  }

  private clearStatePushTimer(): void {
    if (this.statePushTimer) {
      clearTimeout(this.statePushTimer);
      this.statePushTimer = null;
    }
  }

  /**
   * 推送 {url,title,loggedIn} 到所有存活窗（capture.event）；登录态检测失败=null（渲染层兜底）。
   * 0012 P4：已知站点附页面语境预填素材（stage/subject 站点原文 + via）——信号采集走 inject.js
   * 单一来源 bundle 的 pageContext()，解析走 subject.resolveCaptureStageSubject 纯函数；
   * 信号不可得/解析未命中 = 字段缺省（渲染层不预填，不打扰）。
   */
  private async pushStateEvent(): Promise<void> {
    const wc = this.activeWebContents();
    if (!wc) return;
    const url = wc.getURL() || this.currentUrl;
    const title = wc.getTitle() || this.currentTitle;
    let loggedIn: boolean | null = null;
    if (url) {
      try {
        const html: string = await wc.executeJavaScript(
          'document.documentElement ? document.documentElement.innerHTML.slice(0, 300000) : ""'
        );
        loggedIn = detectLoggedIn(url, html);
      } catch {
        loggedIn = null;
      }
    }
    let stage: string | undefined;
    let subject: string | undefined;
    let subjectVia: CaptureEventPayload['subjectVia'];
    if (url && detectSite(url)) {
      try {
        await this.injectInto(wc);
        const signals = await wc.executeJavaScript('__mofangCapturePage.pageContext()') as CapturePageSignals | null;
        const resolved = resolveCaptureStageSubject(url, signals);
        if (resolved) {
          stage = resolved.stage;
          subject = resolved.subject;
          subjectVia = resolved.via;
        }
      } catch {
        // 页面语境不可得（导航中/注入失败）= 不预填，静默
      }
    }
    const payload: CaptureEventPayload = { url, title, loggedIn, ...(stage ? { stage } : {}), ...(subject ? { subject } : {}), ...(subjectVia ? { subjectVia } : {}) };
    this.broadcastEvent(payload);
  }

  private broadcastEvent(payload: CaptureEventPayload): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.CAPTURE_EVENT, payload);
      }
    }
  }

  // ==================== 导航与状态 ====================

  async navigate(url: string, via: 'url' | 'back' | 'forward' | 'reload' = 'url'): Promise<void> {
    await this.openWindow({ standalone: this.useStandalone });
    const wc = this.requireWebContents();
    // 0012 P2：顶部栏 ⟵⟶⟳ 走 webContents 原生导航栈（会话内页历史，不重发请求）
    if (via === 'back') {
      wc.goBack();
      return;
    }
    if (via === 'forward') {
      wc.goForward();
      return;
    }
    if (via === 'reload') {
      wc.reload();
      return;
    }
    await wc.loadURL(url);
    this.currentUrl = wc.getURL() || url;
    this.currentTitle = wc.getTitle();
    this.scheduleStatePush();
  }

  async getState(): Promise<CaptureWindowState> {
    const open = this.isOpen();
    let loggedIn = false;
    let canGoBack = false;
    let canGoForward = false;
    if (open) {
      const wc = this.activeWebContents();
      canGoBack = wc?.canGoBack() ?? false;
      canGoForward = wc?.canGoForward() ?? false;
      if (this.currentUrl) {
        try {
          const html: string = await (wc as Electron.WebContents).executeJavaScript(
            'document.documentElement ? document.documentElement.innerHTML.slice(0, 300000) : ""'
          );
          loggedIn = detectLoggedIn(this.currentUrl, html);
        } catch {
          loggedIn = false;
        }
      }
    }
    return {
      open,
      url: this.currentUrl,
      title: this.currentTitle,
      site: this.currentUrl ? detectSite(this.currentUrl) : null,
      loggedIn,
      lastExtraction: this.lastExtraction,
      canGoBack,
      canGoForward,
    };
  }

  async extractBasket(): Promise<{ extracted: CaptureExtraction }> {
    const wc = this.requireWebContents();
    this.requireVisibleForCapture();
    await this.injectInto(wc);
    const extracted: CaptureExtraction = await wc.executeJavaScript(
      '__mofangCapturePage.extractBasket()',
      true
    );
    this.lastExtraction = { at: new Date().toISOString(), count: extracted.captured.length };
    this.lastExtractionData = extracted;
    return { extracted };
  }

  /** L-2：最近一次提取结果（控件条/主窗任一入口提取后均可拉取） */
  async getLastExtraction(): Promise<{ extracted: CaptureExtraction | null }> {
    return { extracted: this.lastExtractionData };
  }

  /**
   * 0012 P2：保存当前页 HTML（取证；原 toolbar-preload「保存HTML」能力迁主进程通道）。
   * 落盘 userData/data/capture-html-snapshots/<host>-<stamp>.html，路径随结果回传渲染层展示。
   */
  async savePageHtml(): Promise<CaptureSavePageHtmlResult> {
    try {
      const wc = this.requireWebContents();
      const url = wc.getURL() || this.currentUrl;
      const html: string = await wc.executeJavaScript(
        `(function () {
          var clone = document.documentElement.cloneNode(true);
          return '<!DOCTYPE html>\\n<!-- 采集窗保存快照\\n  URL: ${JSON.stringify(url).slice(1, -1)}\\n  保存时间: ${new Date().toISOString()}\\n  用途: 测试锚点 fixture；提交前人工检查无账号/密码 -->\\n' + clone.outerHTML;
        })()`
      );
      let hostLabel = 'page';
      try { hostLabel = new URL(url).hostname || 'page'; } catch { /* 非法 URL 落默认名 */ }
      const dir = join(this.deps.userDataPath, 'data', 'capture-html-snapshots');
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${hostLabel}-${new Date().toISOString().replace(/[:.]/g, '-')}.html`);
      writeFileSync(path, html, 'utf-8');
      return { ok: true, path };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * 收篮入库：答案/解析补抓（answer-fetch）→ 图片落盘（assets）→ 归一化入库（ingest）
   * 单题失败/补抓失败降级为 warning（console 记录），不中断批量
   */
  async collect(extracted: CaptureExtraction, subject?: string): Promise<CaptureCollectResult> {
    const warnings: string[] = [...(extracted.warnings || [])];

    // D1-fix-6：enrich 前注入库存 bankid——篮跨页持久，异页采集时页面无从解析 bankid，
    // 而该题首次入库已落 sourceDetail.bankid（本次解析值优先，仅补缺）。查询失败降级 warning 不中断。
    try {
      injectStoredBankids(extracted.captured, await this.deps.bankService.listQuestions());
    } catch (error) {
      warnings.push(`库存 bankid 回注失败，异页采集按页面解析/13q 回落：${error instanceof Error ? error.message : String(error)}`);
    }

    const answerWarnings = await enrichAnswers(extracted.captured, {
      openHiddenPage: (url) => this.openHiddenPage(url),
      // D1-fix-4 方案①：jyeoo 两跳优先在采集视图登录态会话内执行（页内 fetch）
      openSessionPage: (url) => this.openSessionPage(url),
    });
    warnings.push(...answerWarnings);

    // 用户选择学科（学段+学科组合串）拆分 → subject 单学科中文 + stage 学段；缺省回落 meta.subject → unknown
    // 0006-fix-3 P3：组合串学科经 dict 归一行解析出 subjectId（`subj:{code}`）随 ingest 落库；未命中不传 + warning
    const options = await this.buildIngestOptions(subject, warnings);
    const result = await ingestCaptured(extracted.captured, options);
    // 0006 P2（只增）：入库侧降级告警并入 collect warnings
    warnings.push(...(result.warnings ?? []));

    if (warnings.length > 0) {
      console.warn('[capture] collect warnings:', warnings);
    }
    this.appendCollectLog(extracted, result, warnings);
    // D1-fix-4 复验：enrich 就地改了 extracted.captured，同步为最近提取结果供 getLastExtraction 回读；
    // 并随结果回传 enriched captured，采集预览入库后刷新答案/解析徽标
    this.lastExtractionData = extracted;
    // 0004-fix-1 D：okIds 透传（仅返回值组装处改动；语义见 IngestResult.okIds）
    return { ...result, captured: extracted.captured, okIds: result.okIds ?? [] };
  }

  /**
   * collect 诊断落盘（userData/data/capture-collect.log）：两跳/落盘失败对采集预览不可见，
   * 实站排障依赖此文件（D1-fix-3 第三轮：jyeoo 解析全丢的定级证据来自这里）
   */
  private appendCollectLog(extracted: CaptureExtraction, result: CaptureCollectResult, warnings: string[]): void {
    try {
      const dir = join(this.deps.userDataPath, 'data');
      mkdirSync(dir, { recursive: true });
      const perQ = extracted.captured.map((q) => ({
        questionId: q.questionId,
        site: q.site,
        answerVia: q.meta.answerVia || '',
        gated: q.meta.gated === true,
        answerLen: (q.answerHtml || '').length,
        analysisLen: (q.analysisHtml || '').length,
      }));
      const line = JSON.stringify({
        at: new Date().toISOString(),
        url: extracted.url,
        mode: extracted.mode,
        count: extracted.captured.length,
        result: { ok: result.ok, dup: result.dup, failed: result.failed },
        questions: perQ,
        warnings,
      });
      appendFileSync(join(dir, 'capture-collect.log'), line + '\n', 'utf-8');
    } catch { /* 诊断日志不得影响采集主流程 */ }
  }

  /**
   * 0006-fix-3 P3：字典全量行（归一行 + 站点行）——subject 供用户选择 label/站点原文归一；
   * 0006 P4（只增）：question_type/difficulty 行同源消费（题型/难度归一），故一次取全量按 kind 分发。
   * 未注入 dictService（旧装配/测试）→ null：不解析不告警（行为同改造前）；查询失败降级 warning 不中断入库。
   */
  private async loadDictEntries(warnings: string[]): Promise<DictEntry[] | null> {
    if (!this.deps.dictService) return null;
    try {
      return await this.deps.dictService.listEntries({ activeOnly: true });
    } catch (error) {
      warnings.push(`字典加载失败，subjectId/题型/难度不归一：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * 入库选项组装（collect 与整卷导入共用；行为与 0006 P3 一致）：
   * 用户选择学科（学段+学科组合串）优先；缺省（如整卷导入）回落题自带 meta.subject（卷级学科）经站点行归一。
   */
  private async buildIngestOptions(subject: string | undefined, warnings: string[]): Promise<IngestOptions> {
    const sel = subject ? splitStageSubject(subject) : null;
    const entries = await this.loadDictEntries(warnings);
    // 学科解析按 kind 过滤（题型/难度行不参与 subject 解析，防跨 kind 撞名）
    const subjectEntries = entries?.filter((e) => e.kind === 'subject') ?? null;
    const selSubjectId = sel && subjectEntries ? subjectIdOf(sel.subject, undefined, subjectEntries) : null;
    if (sel && subjectEntries && !selSubjectId) {
      warnings.push(`学科「${sel.subject}」未命中字典，subjectId 不落库（人工指认后重采可补）`);
    }

    return {
      ...(sel?.subject ? { subject: sel.subject } : {}),
      ...(selSubjectId ? { subjectId: selSubjectId } : {}),
      ...(entries ? { dictEntries: entries } : {}),
      ...(sel?.stage ? { stage: sel.stage } : {}),
      assetResolver: async (q) => {
        const r = await downloadQuestionImages(q, {
          dataRoot: join(this.deps.userDataPath, 'data'),
          fetchFn: (url) => this.sessionFetch(url),
        });
        warnings.push(...r.warnings);
        return r;
      },
    };
  }

  /**
   * 0006 P4：整卷下载预览（组卷网）——PC SSR 题号 + 移动批量 API 全字段。
   * 只读抓取：不占试题篮、不自动登录、不绕 WAF；结果缓存供导入复用。
   */
  async paperPreview(url: string): Promise<PaperPreview> {
    const collected = await this.collectPaper(url);
    return {
      url: collected.ref.url,
      bankId: collected.ref.bankId,
      paperId: collected.ref.paperId,
      title: collected.title,
      total: collected.total,
      items: collected.questions.map((q) => this.toPreviewItem(q)),
      missing: collected.missing,
      warnings: collected.warnings,
    };
  }

  /**
   * 0006 P4：整卷导入（预览勾选 + 去向二选一）。
   * - 入库一律复用 ingestCaptured（去重/R-U 回填/挂树钩子；图片走既有资产管线）
   * - target='bank'：散题入题库；target='paper'：装配成品卷（composing → 挂题 → 快照 → done）
   * - 学科：不带用户选择，回落题自带卷级学科（PC 侧栏原文 → dict 站点行归一）
   */
  async paperImport(request: PaperImportRequest): Promise<PaperImportResult> {
    const ref = parseZujuanPaperUrl(request?.url);
    if (!ref) throw new Error(ZUJUAN_PAPER_URL_HINT);
    const target = request?.target as PaperImportTarget;
    if (target !== 'paper' && target !== 'bank') throw new Error(`非法去向：${String(request?.target)}`);

    const wanted = (Array.isArray(request.questionIds) ? request.questionIds : []).filter(
      (id) => typeof id === 'string' && id.trim().length > 0,
    );
    if (wanted.length === 0) throw new Error('未选择任何题目');

    const warnings: string[] = [];
    let collected = this.lastPaperCollect;
    if (!collected || collected.ref.url !== ref.url) {
      collected = await this.collectPaper(ref.url);
      warnings.push('预览缓存缺失/URL 不匹配，导入前已重新抓取整卷');
    }

    const wantedSet = new Set(wanted);
    const selected = collected.questions.filter((q) => wantedSet.has(q.questionId));
    if (selected.length === 0) throw new Error('勾选题均未取到内容（站点覆盖率缺口或缓存过期），请重新预览后再导入');
    if (selected.length < wanted.length) {
      warnings.push(`${wanted.length - selected.length} 个勾选题号无接口内容（站点覆盖率缺口），本次未入库`);
    }

    const ingestOptions = await this.buildIngestOptions(undefined, warnings);
    const ingested = await ingestCaptured(selected, ingestOptions);
    warnings.push(...(ingested.warnings ?? []));

    const localIds = ingested.localIds ?? {};
    const orderedIds = selected
      .map((q) => localIds[`${q.site}:${q.questionId}`])
      .filter((id): id is string => typeof id === 'string' && id.length > 0);

    if (target === 'bank') {
      this.appendPaperLog(ref.url, target, ingested, warnings);
      return {
        target,
        ok: ingested.ok,
        dup: ingested.dup,
        updated: ingested.updated,
        failed: ingested.failed,
        // 0012 目检返工 5：「挂树跳过：站点节点未建」为信息性降级（跳过不失败、无用户行动价值），
        // 不进结果告警（完整 warnings 留存 capture-paper.log 诊断）
        warnings: warnings.filter((w) => !w.includes('挂树跳过')),
      };
    }

    if (!this.deps.paperService) throw new Error('成品卷去向不可用：主进程未注入 paperService');
    if (orderedIds.length === 0) {
      throw new Error(`成品卷未创建：本次 ${ingested.failed.length} 题入库失败、无题可挂（散题未入库）`);
    }
    const paperService = this.deps.paperService;
    // 装配服务面拼装：卷级操作走 PaperExtService，挂题复用 bankService.addQuestion（同一 db 的 PaperService 实现）
    const assembled = await assemblePaper(
      {
        createPaperEx: (title, config, opts) => paperService.createPaperEx(title, config, opts),
        addQuestion: (paperId, questionId) => this.deps.bankService.addQuestion(paperId, questionId),
        snapshotPaperQuestions: (paperId) => paperService.snapshotPaperQuestions(paperId),
        updatePaperStatus: (paperId, status) => paperService.updatePaperStatus(paperId, status),
      },
      collected.title,
      orderedIds,
    );
    warnings.push(...assembled.warnings);
    this.appendPaperLog(ref.url, target, ingested, warnings);

    return {
      target,
      paperId: assembled.paperId,
      paperTitle: assembled.paperTitle,
      snapshotCount: assembled.snapshotCount,
      done: assembled.done,
      ok: ingested.ok,
      dup: ingested.dup,
      updated: ingested.updated,
      failed: ingested.failed,
      // 同上：挂树跳过为信息性降级，不进结果告警（诊断日志保留完整）
      warnings: warnings.filter((w) => !w.includes('挂树跳过')),
    };
  }

  private async collectPaper(url: string): Promise<PaperCollectResult> {
    // 网络/DOM 全在隐藏页内（PC：session 标准 UA；移动：webContents 级 iPhone UA，session UA 不动）
    const collected = await collectPaperQuestions(url, {
      openPage: (target, options) => this.openHiddenPage(target, options ?? {}),
    });
    this.lastPaperCollect = collected;
    return collected;
  }

  private toPreviewItem(q: CapturedQuestion): PaperPreviewItem {
    return {
      questionId: q.questionId,
      ...(q.meta.bankid ? { bankid: String(q.meta.bankid) } : {}),
      ...(q.meta.questionType ? { questionType: String(q.meta.questionType) } : {}),
      ...(q.meta.difficulty ? { difficulty: String(q.meta.difficulty) } : {}),
      stemSummary: htmlToText(q.stemHtml).slice(0, 120),
      answerPresent: !!q.answerHtml,
      analysisPresent: !!q.analysisHtml,
      childCount: q.meta.childQuestionCount ?? 1,
      ...(q.meta.knowledgePoints?.length ? { knowledgePoints: q.meta.knowledgePoints } : {}),
    };
  }

  /** 整卷下载诊断落盘（userData/data/capture-paper.log）：实站排障用；日志不得含 cookie/token */
  private appendPaperLog(
    url: string,
    target: PaperImportTarget,
    ingested: { ok: number; dup: number; updated?: number; failed: Array<{ questionId: string; error: string }> },
    warnings: string[],
  ): void {
    try {
      const dir = join(this.deps.userDataPath, 'data');
      mkdirSync(dir, { recursive: true });
      const line = JSON.stringify({
        at: new Date().toISOString(),
        url,
        target,
        total: this.lastPaperCollect?.total ?? 0,
        missing: this.lastPaperCollect?.missing.length ?? 0,
        result: { ok: ingested.ok, dup: ingested.dup, updated: ingested.updated ?? 0, failed: ingested.failed },
        warnings,
      });
      appendFileSync(join(dir, 'capture-paper.log'), line + '\n', 'utf-8');
    } catch { /* 诊断日志不得影响导入主流程 */ }
  }

  /** 同 session fetch（登录后 CDN 图带 cookie） */
  private async sessionFetch(url: string) {
    const resp = await this.captureSession.fetch(url);
    return {
      ok: resp.ok,
      status: resp.status,
      contentType: resp.headers.get('content-type'),
      bytes: new Uint8Array(await resp.arrayBuffer()),
    };
  }

  /** 同 session 隐藏 offscreen 窗口（zujuan 答案图 / jyeoo 报告页+详情页 / 0006 P4 整卷页） */
  private async openHiddenPage(url: string, options: { userAgent?: string } = {}): Promise<HiddenPage> {
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        session: this.captureSession,
        offscreen: true,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    try {
      // 0006 P4：webContents 级 UA 覆盖（mzujuan 按 UA 分流，桌面 UA 下 API 404，侦察 §3 实锤）——
      // 只覆盖本隐藏窗，**session 级 UA 不动**，不威胁菁优登录态的 UA 绑定
      if (options.userAgent) win.webContents.setUserAgent(options.userAgent);
      await win.webContents.loadURL(url);
    } catch (error) {
      // 实站实证（D1-fix-3 第三轮）：302 跳转（如 jyeoo 游客访问报告页 → /account/loginform）
      // 会使 loadURL 以 ERR_ABORTED reject；目标页其实仍在加载，稍候读 finalUrl 交给
      // isLoginPageUrl / 结构匹配如实标记（guest-redirect / report-tid-not-found），不抛错中断
      if (!String(error instanceof Error ? error.message : error).includes('ERR_ABORTED')) {
        win.destroy();
        throw error;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    await this.injectInto(win.webContents);
    return {
      finalUrl: () => win.webContents.getURL(),
      call: (fnName: string, ...args: unknown[]) =>
        win.webContents.executeJavaScript(
          `__mofangCapturePage.${fnName}(${args.map((a) => JSON.stringify(a)).join(',')})`,
          true
        ),
      close: async () => {
        win.destroy();
      },
    };
  }

  /**
   * D1-fix-4 方案①：jyeoo 两跳在采集视图登录态会话内执行（页内同源 fetch + DOMParser，
   * 真实浏览器形态，携带完整会话 cookie 含仅内存的会话级 cookie）。
   * 方向C 实证（cookie-probe.log）：persist 分区虽有 jyean 等持久 cookie，隐藏窗访问详情页仍
   * 302 跳登录——服务端按会话可信度分级，隐藏窗/独立探针拿不到完整登录态；采集视图是用户
   * 本人正在浏览的同源页面，页内 fetch 与真人浏览等效。
   * 采集视图未开/当前不在 jyeoo 域（跨域 fetch 必被拦）→ 返回 null，由 answer-fetch 回落隐藏窗。
   * 0012 红线（P0.5）：视图遮挡/隐藏编排期同样返回 null（如实降级，answer-fetch 既有回落语义）。
   */
  private async openSessionPage(url: string): Promise<HiddenPage | null> {
    const wc = this.activeWebContents();
    if (!wc) return null;
    try {
      this.requireVisibleForCapture();
    } catch {
      return null;
    }
    const currentUrl = wc.getURL() || this.currentUrl;
    if (detectSite(currentUrl) !== 'jyeoo') return null;
    await this.injectInto(wc);
    const snapshot: { finalUrl: string; status: number; length: number } =
      await wc.executeJavaScript(
        `__mofangCapturePage.sessionFetchPage(${JSON.stringify(url)})`,
        true
      );
    return {
      finalUrl: () => snapshot.finalUrl,
      call: (fnName: string, ...args: unknown[]) =>
        wc.executeJavaScript(
          `__mofangCapturePage.parseSessionPage(${[fnName, ...args].map((a) => JSON.stringify(a)).join(',')})`,
          true
        ),
      close: async () => { /* 采集视图由用户持有，不关闭 */ },
    };
  }

  private async injectInto(wc: Electron.WebContents): Promise<void> {
    if (!this.injectBundle) {
      // 0022：资源定位走 app.getAppPath()（开发=仓库根，打包=asar 根）——process.cwd() 打包后解析不到
      this.injectBundle = readFileSync(join(app.getAppPath(), 'dist/capture/inject.js'), 'utf-8');
    }
    await wc.executeJavaScript(this.injectBundle);
  }
}
