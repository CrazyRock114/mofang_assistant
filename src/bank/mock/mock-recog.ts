// 0028: mock recog 桥（浏览器 demo 回落）——与 createMockAiBridge 同口径：如实报「桌面端功能」，不静默造假。
// 识别要主进程（素材落盘 + 编排 + ai.invoke），浏览器 demo 无此能力。

import type { MofangRecogBridge } from '../../shared/contracts/bridge.js';
import type {
  RecogDraftWriteResult, RecogEventPayload, RecogRun, RecogRunCreateResult, RecogRunDetail,
} from '../../shared/contracts/recog-run-types.js';
// 0040（只增）：工作台文件态类型（类型单源 onestep-types.ts）
import type { RecogWorkbenchSaveResult, WorkbenchState } from '../../shared/contracts/onestep-types.js';
// 0044（只增）：存为试卷编排结果类型
import type { RecogSaveAsPaperResult } from '../../shared/contracts/ipc-channels.js';

const DESKTOP_ONLY = '浏览器演示环境不支持识别（识别管线跑在桌面端主进程）';

export function createMockRecogBridge(): MofangRecogBridge {
  const reject = async (): Promise<never> => {
    throw new Error(DESKTOP_ONLY);
  };
  return {
    create: async (_payload): Promise<RecogRunCreateResult> => reject(),
    status: async (_payload): Promise<RecogRunDetail> => reject(),
    cancel: async (_payload): Promise<RecogRun> => reject(),
    history: async (): Promise<RecogRun[]> => [],
    attachQuestions: async (_payload): Promise<RecogRun> => reject(),
    resume: async (_payload): Promise<RecogRun> => reject(),
    /** 无事件源：订阅即空订阅，退订幂等（语义等价，与 capture mock 同口径） */
    onEvent: (_callback: (payload: RecogEventPayload) => void) => () => undefined,
    // 0040（只增）：工作台文件态同属桌面端能力 → 读回 null（无草稿，首次进入语义）、写如实拒绝
    workbench: {
      load: async (_payload): Promise<WorkbenchState | null> => null,
      save: async (_payload): Promise<RecogWorkbenchSaveResult> => reject(),
    },
    // 0044（只增）：存为试卷主进程编排 → 如实拒绝（题入库/建卷要主进程，浏览器 demo 不造假）
    saveAsPaper: async (_payload): Promise<RecogSaveAsPaperResult> => reject(),
    // 0046（只增）：Onestep 草稿写回 run → 同属桌面端能力，如实拒绝
    draftWrite: async (_payload): Promise<RecogDraftWriteResult> => reject(),
  };
}
