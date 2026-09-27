// D1 P1: CaptureClient — renderer 侧采集服务统一入口（仿 IpcBankClient 模式）
// 包装 window.__mofangCapture 桥方法；桥缺失（纯浏览器 dev）时回落内存 mock，行为与真实链路一致

import type { MofangCaptureBridge } from '../../shared/contracts/bridge.js';
import type { CaptureExtraction, CaptureWindowState, PaperImportRequest, PaperImportResult, PaperPreview } from '../../shared/contracts/capture-types.js';
import type { CaptureCollectPayload, CaptureCollectResult, CaptureSetBoundsPayload, CaptureEventPayload, CaptureSavePageHtmlResult, CaptureNavigatePayload } from '../../shared/contracts/ipc-channels.js';
import { createMockCaptureBridge } from '../capture/mock-capture-data.js';

export class CaptureClient {
  private readonly bridge: MofangCaptureBridge;

  constructor(bridge?: MofangCaptureBridge) {
    this.bridge = bridge ?? createMockCaptureBridge();
  }

  openWindow(): Promise<void> {
    return this.bridge.openWindow();
  }

  closeWindow(): Promise<void> {
    return this.bridge.closeWindow();
  }

  /** 0012 P2（只增）：payload 扩可选 via（'back'/'forward'/'reload' 走 webContents 原生导航栈） */
  navigate(payload: CaptureNavigatePayload): Promise<void> {
    return this.bridge.navigate(payload);
  }

  getState(): Promise<CaptureWindowState> {
    return this.bridge.getState();
  }

  extractBasket(): Promise<{ extracted: CaptureExtraction }> {
    return this.bridge.extractBasket();
  }

  collect(payload: CaptureCollectPayload): Promise<CaptureCollectResult> {
    return this.bridge.collect(payload);
  }

  /** L-2：拉取最近一次提取结果（控件条「提取试题篮」后同步主窗预览） */
  getLastExtraction(): Promise<{ extracted: CaptureExtraction | null }> {
    return this.bridge.getLastExtraction();
  }

  /** 0006 P4：整卷下载预览（组卷网整卷 URL → 题号/题型/题干摘要/答案解析有无/子母题标注） */
  paperPreview(payload: { url: string }): Promise<PaperPreview> {
    return this.bridge.paperPreview(payload);
  }

  /** 0006 P4：整卷导入（勾选题号 + 去向二选一：'paper' 成品卷 | 'bank' 散题入题库） */
  paperImport(payload: PaperImportRequest): Promise<PaperImportResult> {
    return this.bridge.paperImport(payload);
  }

  /** 0012：内嵌 view bounds 上报（渲染层视口坐标；零宽高=遮挡编排）。旧桥无通道时 no-op（轮询兜底语义） */
  setBounds(payload: CaptureSetBoundsPayload): Promise<void> {
    if (typeof this.bridge.setBounds === 'function') return this.bridge.setBounds(payload);
    return Promise.resolve();
  }

  /** 0012：订阅采集状态事件推送（返回退订函数）。旧桥/mock 无推送通道时 no-op 订阅（语义等价） */
  onEvent(callback: (payload: CaptureEventPayload) => void): () => void {
    if (typeof this.bridge.onEvent === 'function') return this.bridge.onEvent(callback);
    return () => { /* no-op */ };
  }

  /** 0012 P2：保存当前页 HTML（取证；{ok,path?,error?} 如实回传）。旧桥无通道时如实不支持 */
  savePageHtml(): Promise<CaptureSavePageHtmlResult> {
    if (typeof this.bridge.savePageHtml === 'function') return this.bridge.savePageHtml();
    return Promise.resolve({ ok: false, error: '当前桥不支持保存页面 HTML' });
  }
}
