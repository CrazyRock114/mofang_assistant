// 0036: mock split 桥（浏览器 demo 回落）——与 createMockRecogBridge 同口径：如实报「桌面端功能」，不静默造假。
// 切题工作区要主进程文件态（源 PDF 副本/页图缓存/草稿落盘），浏览器 demo 无此能力。

import type { MofangSplitBridge } from '../../shared/contracts/bridge.js';
import type {
  SplitPageReadResult, SplitPageWriteResult, SplitProjectDetail, SplitProjectSaveDraftResult,
  SplitProjectSummary, SplitSourceAppendResult, SplitSourceReadResult,
} from '../../shared/contracts/split-types.js';

const DESKTOP_ONLY = '浏览器演示环境不支持 PDF 切题工作区（工作区与识别都跑在桌面端主进程）';

export function createMockSplitBridge(): MofangSplitBridge {
  const reject = async (): Promise<never> => {
    throw new Error(DESKTOP_ONLY);
  };
  return {
    createProject: async (): Promise<SplitProjectSummary> => reject(),
    appendSource: async (): Promise<SplitSourceAppendResult> => reject(),
    readSource: async (): Promise<SplitSourceReadResult> => reject(),
    saveMeta: async (): Promise<SplitProjectSummary> => reject(),
    saveDraft: async (): Promise<SplitProjectSaveDraftResult> => reject(),
    /** 列表是空态而非错误：浏览器 demo 里「没有项目」是如实描述 */
    listProjects: async (): Promise<SplitProjectSummary[]> => [],
    openProject: async (): Promise<SplitProjectDetail> => reject(),
    removeProject: async (): Promise<void> => reject(),
    writePage: async (): Promise<SplitPageWriteResult> => reject(),
    readPage: async (): Promise<SplitPageReadResult> => ({ dataBase64: null }),
  };
}
