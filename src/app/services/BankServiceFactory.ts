// Phase 3: BankServiceFactory — Electron 走 IPC，浏览器回落 Mock
// 0003：浏览器 demo 下 mock bank 与 mock 扩展服务共享同一 store（考试登记联动需跨服务读题/卷），
// 见 BankExtServiceFactory.getSharedMockBankStore。

import type { BankService } from '../../shared/contracts/bank-types.js';
import { IpcBankClient } from './IpcBankClient.js';
import { MockBankService } from '../../bank/mock/mock-bank.js';
import { getSharedMockBankStore } from './BankExtServiceFactory.js';

export function createBankService(): BankService {
  // Electron 环境：window.__mofangBank 存在
  if (window.__mofangBank) {
    return new IpcBankClient();
  }

  // 浏览器环境：回落 Mock（与 ext mock 共享 store，保持跨服务数据可见）
  return new MockBankService(getSharedMockBankStore());
}
