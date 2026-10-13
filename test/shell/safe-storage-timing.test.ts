import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  appReady: false,
  encryptionAvailable: true,
  throwOnCheck: false,
  checkedCalls: 0,
}));

vi.mock('electron', () => ({
  app: {
    isReady: () => mockState.appReady,
  },
  safeStorage: {
    isEncryptionAvailable: () => {
      mockState.checkedCalls += 1;
      if (mockState.throwOnCheck) throw new Error('Keychain access denied');
      return mockState.encryptionAvailable;
    },
    encryptString: (str: string) => Buffer.from(str),
    decryptString: (buf: Buffer) => buf.toString(),
  },
}));

import { createDefaultKeyVault } from '../../src/shell/ai/dpapi-vault.js';

describe('VACCINE: safeStorage timing & ready guard', () => {
  beforeEach(() => {
    mockState.appReady = false;
    mockState.encryptionAvailable = true;
    mockState.throwOnCheck = false;
    mockState.checkedCalls = 0;
  });

  it('safeStorage 绝不能在 app.isReady() 为 false 时被调用，必须安全回退至 MachineKeyVault', () => {
    mockState.appReady = false;

    const vault = createDefaultKeyVault();
    expect(vault.kind).toBe('machine-key');
    // 验证未调用 safeStorage.isEncryptionAvailable，杜绝在 macOS/Linux 上死锁或弹窗
    expect(mockState.checkedCalls).toBe(0);
  });

  it('app.isReady() 为 true 时可正常选用 DpapiKeyVault', () => {
    mockState.appReady = true;
    mockState.encryptionAvailable = true;

    const vault = createDefaultKeyVault();
    expect(vault.kind).toBe('dpapi');
    expect(mockState.checkedCalls).toBe(1);
  });

  it('app.isReady() 为 true 时若 safeStorage 抛错，平滑回退至 MachineKeyVault', () => {
    mockState.appReady = true;
    mockState.throwOnCheck = true;

    const vault = createDefaultKeyVault();
    expect(vault.kind).toBe('machine-key');
  });
});
