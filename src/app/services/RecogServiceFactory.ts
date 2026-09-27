// 0028: RecogServiceFactory — Electron 走 __mofangRecog 白名单桥，浏览器 demo 回落 mock recog 桥。
// 模式照 AiServiceFactory（页面组件统一从 factory 拿服务实例，不直接摸 window）。

import type { MofangRecogBridge } from '../../shared/contracts/bridge.js';
import { createMockRecogBridge } from '../../bank/mock/mock-recog.js';

export function createRecogService(): MofangRecogBridge {
  if (window.__mofangRecog) {
    return window.__mofangRecog;
  }
  return createMockRecogBridge();
}
