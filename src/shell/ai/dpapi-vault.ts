// 0023 P2：Key 托管层——safeStorage（Win=DPAPI）主形态 + 默认工厂。
// D-044 拍板：safeStorage 优先（零新依赖，否 keytar）；isEncryptionAvailable()=false 时
// 回退机器密钥派生形态（key-vault.ts MachineKeyVault）。两形态对 service 透明。
// 本文件是唯一直接 import 'electron' 的 AI 模块（ai-gateway/proxy 不 import，
// 保证纯 Node vitest 直测）；main.ts 经 createDefaultKeyVault() 取实例。

import * as electron from 'electron';
import { DPAPI_PREFIX, MachineKeyVault, type KeyVault } from './key-vault.js';

export class DpapiKeyVault implements KeyVault {
  readonly kind = 'dpapi' as const;

  async encrypt(plaintext: string): Promise<string> {
    return DPAPI_PREFIX + electron.safeStorage.encryptString(plaintext).toString('base64');
  }

  async decrypt(stored: string): Promise<string> {
    if (!stored.startsWith(DPAPI_PREFIX)) {
      throw new Error(`无法识别的 Key 密文形态（期望 ${DPAPI_PREFIX} 前缀）`);
    }
    return electron.safeStorage.decryptString(Buffer.from(stored.slice(DPAPI_PREFIX.length), 'base64'));
  }
}

/** 默认工厂：加密可用 → dpapi；不可用或 app 未就绪 → 机器密钥回退（两形态前缀自识，历史数据不迁移） */
export function createDefaultKeyVault(): KeyVault {
  // safeStorage 在 app 就绪（app.isReady()）之前调用在 macOS/Linux 等平台上可能触发死锁或钥匙串弹窗阻塞；
  // 必须确保 app 已就绪且 safeStorage.isEncryptionAvailable() 为 true 才使用 DpapiKeyVault。
  const hasApp = 'app' in electron;
  const app = hasApp ? (electron as any).app : undefined;
  const safeStorage = electron.safeStorage;

  if (app && typeof app.isReady === 'function' && !app.isReady()) {
    return new MachineKeyVault();
  }
  try {
    if (safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable()) {
      return new DpapiKeyVault();
    }
  } catch {
    // 捕获权限异常或平台初始化错误，平滑降级
  }
  return new MachineKeyVault();
}
