// 0003 Phase 2: BankExtServiceFactory — Electron 走 IpcExtClient（真实 SQLite），浏览器回落 mock
//
// 页面组件统一从本 factory 拿服务实例（不直接 new IPC client）。
// 浏览器 demo 环境：bank mock 与 ext mock 共享同一 MockBankStore（考试登记联动需跨服务读题/卷，
// 语义对齐真实侧"同一 db 句柄"），store 模块级单例保证跨页面数据可见。

import type { BankExtServices } from '../../shared/contracts/bank-types.js';
import { IpcExtClient } from './IpcExtClient.js';
import { createMockExtServices } from '../../bank/mock/mock-ext.js';
import { MockBankStore } from '../../bank/mock/mock-store.js';

let sharedMockStore: MockBankStore | null = null;

/** 浏览器 demo 共享 store（MockBankService 构造时会播种示例数据，幂等无害） */
export function getSharedMockBankStore(): MockBankStore {
  if (!sharedMockStore) {
    sharedMockStore = new MockBankStore();
  }
  return sharedMockStore;
}

export function createBankExtServices(): BankExtServices {
  // Electron 环境：window.__mofangBankExt 存在
  if (window.__mofangBankExt) {
    return new IpcExtClient();
  }

  // 浏览器环境：回落 mock（0002 mock 已就绪，契约测试双跑同绿）
  return createMockExtServices(getSharedMockBankStore());
}
