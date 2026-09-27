// 0023: AiServiceFactory — Electron 走 __mofangAi 白名单桥，浏览器 demo 回落 mock ai 桥。
// 模式照 BankExtServiceFactory（页面组件统一从 factory 拿服务实例，不直接摸 window）。

import type { MofangAiBridge } from '../../shared/contracts/bridge.js';
import { createMockAiBridge } from '../../bank/mock/mock-ai.js';
import { getSharedMockBankStore } from './BankExtServiceFactory.js';

export function createAiServices(): MofangAiBridge {
  // Electron 环境：preload 暴露的 __mofangAi 白名单桥
  if (window.__mofangAi) {
    return window.__mofangAi;
  }
  // 浏览器 demo 环境：mock（档案 CRUD 内存可见；测连通/invoke 如实报「桌面端功能」）
  return createMockAiBridge(getSharedMockBankStore());
}
