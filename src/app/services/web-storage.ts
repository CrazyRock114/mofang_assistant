// 纯网页端 IndexedDB 本地数据持久化与导入导出备份
import { MockBankStore } from '../../bank/mock/mock-store.js';

const DB_NAME = 'mofang_assistant_web_db';
const STORE_NAME = 'store_data';
const DB_VERSION = 1;
const STORAGE_KEY = 'bank_store_state';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      return reject(new Error('IndexedDB not supported'));
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function serializeStore(store: MockBankStore): Record<string, unknown> {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    questions: Array.from(store.questions.entries()),
    tags: Array.from(store.tags.entries()).map(([k, v]) => [k, Array.from(v.entries())]),
    papers: Array.from(store.papers.entries()),
    paperQuestions: Array.from(store.paperQuestions.entries()),
    logs: store.logs,
    dictEntries: Array.from(store.dictEntries.entries()),
    trees: Array.from(store.trees.entries()),
    treeNodes: Array.from(store.treeNodes.entries()),
    questionNodeLinks: Array.from(store.questionNodeLinks.entries()).map(([k, v]) => [k, Array.from(v.values())]),
    treeSourceMap: Array.from(store.treeSourceMap.entries()),
    students: Array.from(store.students.entries()),
    classes: Array.from(store.classes.entries()),
    studentClasses: store.studentClasses,
    studentEvents: Array.from(store.studentEvents.entries()),
    exams: Array.from(store.exams.entries()),
    examScores: Array.from(store.examScores.entries()),
    mistakes: Array.from(store.mistakes.entries()),
    paperSets: Array.from(store.paperSets.entries()),
    paperSetPapers: Array.from(store.paperSetPapers.entries()),
    presets: Array.from(store.presets.entries()),
    paperSnapshots: Array.from(store.paperSnapshots.entries()).map(([k, v]) => [k, Array.from(v.entries())]),
    paperFolders: Array.from(store.paperFolders.entries()),
    feedbackTemplates: Array.from(store.feedbackTemplates.entries()),
    modelProfiles: Array.from(store.modelProfiles.entries()),
    feedbackPromptTemplates: Array.from(store.feedbackPromptTemplates.entries()),
    feedbackRecords: Array.from(store.feedbackRecords.entries()),
  };
}

export function deserializeStore(store: MockBankStore, data: any): void {
  if (!data || typeof data !== 'object') return;

  if (Array.isArray(data.questions)) {
    store.questions.clear();
    for (const [k, v] of data.questions) store.questions.set(k, v);
  }
  if (Array.isArray(data.tags)) {
    store.tags.clear();
    for (const [k, v] of data.tags) store.tags.set(k, new Map(v));
  }
  if (Array.isArray(data.papers)) {
    store.papers.clear();
    for (const [k, v] of data.papers) store.papers.set(k, v);
  }
  if (Array.isArray(data.paperQuestions)) {
    store.paperQuestions.clear();
    for (const [k, v] of data.paperQuestions) store.paperQuestions.set(k, v);
  }
  if (Array.isArray(data.logs)) {
    store.logs = data.logs;
  }
  if (Array.isArray(data.dictEntries)) {
    store.dictEntries.clear();
    for (const [k, v] of data.dictEntries) store.dictEntries.set(k, v);
  }
  if (Array.isArray(data.trees)) {
    store.trees.clear();
    for (const [k, v] of data.trees) store.trees.set(k, v);
  }
  if (Array.isArray(data.treeNodes)) {
    store.treeNodes.clear();
    for (const [k, v] of data.treeNodes) store.treeNodes.set(k, v);
  }
  if (Array.isArray(data.questionNodeLinks)) {
    store.questionNodeLinks.clear();
    for (const [k, v] of data.questionNodeLinks) store.questionNodeLinks.set(k, new Set(v));
  }
  if (Array.isArray(data.treeSourceMap)) {
    store.treeSourceMap.clear();
    for (const [k, v] of data.treeSourceMap) store.treeSourceMap.set(k, v);
  }
  if (Array.isArray(data.students)) {
    store.students.clear();
    for (const [k, v] of data.students) store.students.set(k, v);
  }
  if (Array.isArray(data.classes)) {
    store.classes.clear();
    for (const [k, v] of data.classes) store.classes.set(k, v);
  }
  if (Array.isArray(data.studentClasses)) {
    store.studentClasses = data.studentClasses;
  }
  if (Array.isArray(data.studentEvents)) {
    store.studentEvents.clear();
    for (const [k, v] of data.studentEvents) store.studentEvents.set(k, v);
  }
  if (Array.isArray(data.exams)) {
    store.exams.clear();
    for (const [k, v] of data.exams) store.exams.set(k, v);
  }
  if (Array.isArray(data.examScores)) {
    store.examScores.clear();
    for (const [k, v] of data.examScores) store.examScores.set(k, v);
  }
  if (Array.isArray(data.mistakes)) {
    store.mistakes.clear();
    for (const [k, v] of data.mistakes) store.mistakes.set(k, v);
  }
  if (Array.isArray(data.paperSets)) {
    store.paperSets.clear();
    for (const [k, v] of data.paperSets) store.paperSets.set(k, v);
  }
  if (Array.isArray(data.paperSetPapers)) {
    store.paperSetPapers.clear();
    for (const [k, v] of data.paperSetPapers) store.paperSetPapers.set(k, v);
  }
  if (Array.isArray(data.presets)) {
    for (const [k, v] of data.presets) store.presets.set(k, v);
  }
  if (Array.isArray(data.paperSnapshots)) {
    store.paperSnapshots.clear();
    for (const [k, v] of data.paperSnapshots) store.paperSnapshots.set(k, new Map(v));
  }
  if (Array.isArray(data.paperFolders)) {
    store.paperFolders.clear();
    for (const [k, v] of data.paperFolders) store.paperFolders.set(k, v);
  }
  if (Array.isArray(data.feedbackTemplates)) {
    for (const [k, v] of data.feedbackTemplates) store.feedbackTemplates.set(k, v);
  }
  if (Array.isArray(data.modelProfiles)) {
    store.modelProfiles.clear();
    for (const [k, v] of data.modelProfiles) store.modelProfiles.set(k, v);
  }
  if (Array.isArray(data.feedbackPromptTemplates)) {
    for (const [k, v] of data.feedbackPromptTemplates) store.feedbackPromptTemplates.set(k, v);
  }
  if (Array.isArray(data.feedbackRecords)) {
    store.feedbackRecords.clear();
    for (const [k, v] of data.feedbackRecords) store.feedbackRecords.set(k, v);
  }
}

export async function saveStoreToIndexedDb(store: MockBankStore): Promise<void> {
  try {
    const data = serializeStore(store);
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const os = tx.objectStore(STORE_NAME);
      const req = os.put(data, STORAGE_KEY);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('[WebStorage] Failed to save store to IndexedDB:', err);
  }
}

export async function loadStoreFromIndexedDb(store: MockBankStore): Promise<boolean> {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const os = tx.objectStore(STORE_NAME);
      const req = os.get(STORAGE_KEY);
      req.onsuccess = () => {
        if (req.result) {
          deserializeStore(store, req.result);
          resolve(true);
        } else {
          resolve(false);
        }
      };
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('[WebStorage] Failed to load store from IndexedDB:', err);
    return false;
  }
}

let saveTimer: any = null;

export function scheduleAutoSave(store: MockBankStore, delayMs = 300): void {
  if (typeof window === 'undefined') return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void saveStoreToIndexedDb(store);
  }, delayMs);
}

export function downloadJsonFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
