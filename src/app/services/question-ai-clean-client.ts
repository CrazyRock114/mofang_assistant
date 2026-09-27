// 0056（R-041）：采集题 AI 整理的渲染层取用面（桥取用单源）。
//
// 为什么不做成服务工厂（BankServiceFactory 同款）：任务书 §三.1 的契约预授权清单只允许
// `bridge.ts`/`preload.ts` 只增对应面——`BankService` 面（bank-types.ts）零触碰，故 AI 整理
// 不经 IpcBankClient，直接取桥面（0061 废图清理卡取 `window.__mofangFile` 的同口径）。
// 无桥（浏览器 demo / 单测未注入）= null：入口不渲染死按钮（0016 口径）。

import type { QuestionAiCleanPayload, QuestionAiCleanResult } from '../../shared/contracts/ipc-channels.js';

export type AiCleanRunner = (payload: QuestionAiCleanPayload) => Promise<QuestionAiCleanResult>;

export function createAiCleanRunner(): AiCleanRunner | null {
  const bridge = typeof window === 'undefined' ? undefined : window.__mofangBank;
  if (!bridge || typeof bridge.questionAiClean !== 'function') return null;
  return (payload: QuestionAiCleanPayload) => bridge.questionAiClean(payload);
}
