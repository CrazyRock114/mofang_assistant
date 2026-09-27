// D1 P1: CaptureServiceFactory — Electron 走 IPC 桥，浏览器回落内存 mock（与 BankServiceFactory 同构）

import { CaptureClient } from './capture-client.js';

export function createCaptureService(): CaptureClient {
  // Electron 环境：window.__mofangCapture 存在 → 真实 IPC
  if (window.__mofangCapture) {
    return new CaptureClient(window.__mofangCapture);
  }

  // 浏览器环境：CaptureClient 构造无桥 → 内存 mock 回落
  return new CaptureClient();
}
