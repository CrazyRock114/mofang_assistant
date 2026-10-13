// 纯网页端 PDF 切题工作区 Bridge 实现：项目元与切片内存/本地存储
import type { MofangSplitBridge } from '../../shared/contracts/bridge.js';
import type {
  SplitPageReadResult,
  SplitPageWriteResult,
  SplitProjectDetail,
  SplitProjectSaveDraftResult,
  SplitProjectSummary,
  SplitSourceAppendResult,
  SplitSourceReadResult,
} from '../../shared/contracts/split-types.js';

interface WebProjectStore {
  meta: SplitProjectSummary;
  sourceChunks: string[];
  drafts: Map<string, any>;
  pages: Map<number, string>;
}

const projects = new Map<string, WebProjectStore>();

export function createWebSplitBridge(): MofangSplitBridge {
  return {
    createProject: async (payload): Promise<SplitProjectSummary> => {
      const id = payload.id || `split-${Date.now()}`;
      const now = new Date().toISOString();
      const meta: SplitProjectSummary = {
        id,
        name: payload.name || '未命名切题项目',
        sourceFileName: payload.sourceFileName || 'document.pdf',
        totalPages: payload.totalPages || 1,
        segments: payload.segments || [],
        createdAt: now,
        updatedAt: now,
      };
      projects.set(id, {
        meta,
        sourceChunks: [],
        drafts: new Map(),
        pages: new Map(),
      });
      return meta;
    },

    appendSource: async (payload): Promise<SplitSourceAppendResult> => {
      const p = projects.get(payload.projectId);
      if (p) {
        p.sourceChunks.push(payload.chunkBase64);
        const totalBytes = p.sourceChunks.reduce((acc, c) => acc + Math.round((c.length * 3) / 4), 0);
        return { totalBytesReceived: totalBytes };
      }
      return { totalBytesReceived: 0 };
    },

    readSource: async (payload): Promise<SplitSourceReadResult> => {
      const p = projects.get(payload.projectId);
      if (!p) return { chunkBase64: '', done: true };
      const chunk = p.sourceChunks[payload.chunkIndex] ?? '';
      return {
        chunkBase64: chunk,
        done: payload.chunkIndex >= p.sourceChunks.length - 1,
      };
    },

    saveMeta: async (payload): Promise<SplitProjectSummary> => {
      const p = projects.get(payload.meta.id);
      if (p) {
        p.meta = { ...payload.meta, updatedAt: new Date().toISOString() };
        return p.meta;
      }
      return payload.meta;
    },

    saveDraft: async (payload): Promise<SplitProjectSaveDraftResult> => {
      const p = projects.get(payload.projectId);
      if (p) {
        p.drafts.set(payload.segmentId, payload.draft);
      }
      return { savedAt: new Date().toISOString() };
    },

    listProjects: async (): Promise<SplitProjectSummary[]> => {
      return Array.from(projects.values()).map((p) => p.meta);
    },

    openProject: async (payload): Promise<SplitProjectDetail> => {
      const p = projects.get(payload.id);
      if (!p) throw new Error(`项目 ${payload.id} 不存在`);
      return {
        meta: p.meta,
        drafts: Object.fromEntries(p.drafts.entries()),
      };
    },

    removeProject: async (payload): Promise<void> => {
      projects.delete(payload.id);
    },

    writePage: async (payload): Promise<SplitPageWriteResult> => {
      const p = projects.get(payload.projectId);
      if (p) {
        p.pages.set(payload.pageNo, payload.pngBase64);
      }
      return { ok: true };
    },

    readPage: async (payload): Promise<SplitPageReadResult> => {
      const p = projects.get(payload.projectId);
      const data = p?.pages.get(payload.pageNo) ?? null;
      return { dataBase64: data };
    },
  };
}
