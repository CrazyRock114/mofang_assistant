// 0023 P2：Key 托管层——密钥形态契约 + 机器密钥回退实现（纯 Node，vitest 可测）。
// D-044：safeStorage（Win=DPAPI）为主形态；isEncryptionAvailable()=false 时回退本实现的
// 「机器密钥派生加密」。两形态对 service 透明：service 只存取不透明串。
// 存储形态（写进 model_profiles.key_encrypted 的串）：
//   dpapi:v1:<base64(safeStorage 密文)>   —— 见 dpapi-vault.ts
//   mkey:v1:<base64(salt[16]|iv[12]|tag[16]|ciphertext)> —— 本实现（AES-256-GCM）
// 密钥材料 = 机器属性（hostname/username/platform/arch）经 scrypt 派生——换机器不可解，
// 与 DPAPI 的机器绑定语义对齐；随机 salt/iv 保证同明文密文不重样。

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { hostname, userInfo, platform, arch } from 'node:os';

export const DPAPI_PREFIX = 'dpapi:v1:';
export const MACHINE_KEY_PREFIX = 'mkey:v1:';

export interface KeyVault {
  /** 形态标识（工厂选择结果断言用） */
  readonly kind: 'dpapi' | 'machine-key';
  /** 明文 → 存储形态串（含前缀；串即密文，不含明文） */
  encrypt(plaintext: string): Promise<string>;
  /** 存储形态串 → 明文；无法识别的前缀明确报错（不静默） */
  decrypt(stored: string): Promise<string>;
}

function machineSecret(): string {
  let user = '';
  try {
    user = userInfo().username;
  } catch {
    user = ''; // 极端环境（无用户上下文）退化为其余机器属性
  }
  return ['mofang-assistant-ai-vault-v1', hostname(), user, platform(), arch()].join('|');
}

export class MachineKeyVault implements KeyVault {
  readonly kind = 'machine-key' as const;

  async encrypt(plaintext: string): Promise<string> {
    const salt = randomBytes(16);
    const key = scryptSync(machineSecret(), salt, 32);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return MACHINE_KEY_PREFIX + Buffer.concat([salt, iv, tag, enc]).toString('base64');
  }

  async decrypt(stored: string): Promise<string> {
    if (!stored.startsWith(MACHINE_KEY_PREFIX)) {
      throw new Error(`无法识别的 Key 密文形态（期望 ${MACHINE_KEY_PREFIX} 或 ${DPAPI_PREFIX} 前缀）`);
    }
    const raw = Buffer.from(stored.slice(MACHINE_KEY_PREFIX.length), 'base64');
    const salt = raw.subarray(0, 16);
    const iv = raw.subarray(16, 28);
    const tag = raw.subarray(28, 44);
    const enc = raw.subarray(44);
    const key = scryptSync(machineSecret(), salt, 32);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  }
}
