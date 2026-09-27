// 0036: SplitServiceFactory — Electron 走 __mofangSplit 白名单桥，浏览器 demo 回落 mock split 桥。
// 模式照 RecogServiceFactory（页面组件统一从 factory 拿服务实例，不直接摸 window）。

import type { MofangSplitBridge } from '../../shared/contracts/bridge.js';
import { createMockSplitBridge } from '../../bank/mock/mock-split.js';

export function createSplitService(): MofangSplitBridge {
  if (window.__mofangSplit) {
    return window.__mofangSplit;
  }
  return createMockSplitBridge();
}
