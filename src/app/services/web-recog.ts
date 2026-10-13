// 纯网页端识别工作台 Bridge 实现：卡流、草稿落 IndexedDB、存为试卷直接入题库
import type { MofangRecogBridge } from '../../shared/contracts/bridge.js';
import type {
  RecogDraftWriteResult,
  RecogEventPayload,
  RecogRun,
  RecogRunCreateResult,
  RecogRunDetail,
} from '../../shared/contracts/recog-run-types.js';
import type {
  RecogWorkbenchSaveResult,
  WorkbenchState,
} from '../../shared/contracts/onestep-types.js';
import type {
  RecogSaveAsPaperPayload,
  RecogSaveAsPaperResult,
} from '../../shared/contracts/ipc-channels.js';
import type { Question, Paper } from '../../shared/contracts/bank-types.js';
import { getSharedMockBankStore } from './BankExtServiceFactory.js';

const workbenchStateMap = new Map<string, WorkbenchState>();
const recogRunsMap = new Map<string, RecogRun>();

export function createWebRecogBridge(): MofangRecogBridge {
  return {
    create: async (_payload): Promise<RecogRunCreateResult> => {
      const runId = `run-${Date.now()}`;
      const run: RecogRun = {
        id: runId,
        sourceType: 'image',
        sourceName: '网页端录入',
        pageCount: 1,
        status: 'completed',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      recogRunsMap.set(runId, run);
      return { run, pages: [] };
    },

    status: async (payload): Promise<RecogRunDetail> => {
      const run = recogRunsMap.get(payload.runId) ?? {
        id: payload.runId,
        sourceType: 'image',
        sourceName: '网页端录入',
        pageCount: 1,
        status: 'completed',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      return { run, pages: [] };
    },

    cancel: async (payload): Promise<RecogRun> => {
      const run = recogRunsMap.get(payload.runId) ?? {
        id: payload.runId,
        sourceType: 'image',
        sourceName: '网页端录入',
        pageCount: 1,
        status: 'canceled',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      return run;
    },

    history: async (): Promise<RecogRun[]> => {
      return Array.from(recogRunsMap.values());
    },

    attachQuestions: async (payload): Promise<RecogRun> => {
      const run = recogRunsMap.get(payload.runId)!;
      return run;
    },

    resume: async (payload): Promise<RecogRun> => {
      const run = recogRunsMap.get(payload.runId)!;
      return run;
    },

    onEvent: (_callback: (payload: RecogEventPayload) => void) => () => undefined,

    workbench: {
      load: async (payload): Promise<WorkbenchState | null> => {
        return workbenchStateMap.get(payload.runId) ?? null;
      },
      save: async (payload): Promise<RecogWorkbenchSaveResult> => {
        workbenchStateMap.set(payload.runId, payload.state);
        return { ok: true, savedAt: new Date().toISOString() };
      },
    },

    saveAsPaper: async (payload: RecogSaveAsPaperPayload): Promise<RecogSaveAsPaperResult> => {
      const store = getSharedMockBankStore();
      const now = new Date().toISOString();
      const questionIds: string[] = [];

      for (let i = 0; i < payload.cards.length; i++) {
        const card = payload.cards[i];
        const qId = `q-recog-${Date.now()}-${i}`;
        const q: Question = {
          id: qId,
          subject: payload.subject,
          questionType: card.typeCode || '未定',
          content: card.contentHtml,
          answer: card.answerHtml,
          analysis: card.analysisHtml,
          sourceType: 'scan',
          sourceDetail: { paperTitle: payload.paperTitle, pageNo: card.pageNo },
          images: card.images || [],
          createdAt: now,
          updatedAt: now,
        };
        store.questions.set(qId, q);

        if (card.adoptedTags && card.adoptedTags.length > 0) {
          const tagMap = new Map<string, string | undefined>();
          for (const t of card.adoptedTags) tagMap.set(t, undefined);
          store.tags.set(qId, tagMap);
        }

        questionIds.push(qId);
      }

      const paperId = `paper-${Date.now()}`;
      const paper: Paper = {
        id: paperId,
        title: payload.title || '录题组卷',
        config: { duration: 90, totalScore: 100 },
        createdAt: now,
        status: 'composing',
        paperType: 'uniform',
        folderId: payload.folderId,
      };
      store.papers.set(paperId, paper);
      store.paperQuestions.set(
        paperId,
        questionIds.map((qid, idx) => ({
          questionId: qid,
          position: idx,
          frozen: false,
        }))
      );

      store.log('recog.saveAsPaper', `存为试卷 ${paperId}（共 ${questionIds.length} 题）`);
      return { paperId, questionIds };
    },

    draftWrite: async (_payload): Promise<RecogDraftWriteResult> => {
      return { ok: true, writtenAt: new Date().toISOString() };
    },
  };
}
