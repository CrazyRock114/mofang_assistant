// 纯网页端 Web Bridges Polyfill：在纯浏览器环境模拟 Electron bridge
import type {
  HomeDashboardStats,
  HomeActivityDay,
  HomeWorkCategory,
  AiDailyCount,
  PaperStatus,
} from '../../shared/contracts/bank-types.js';
import type {
  MofangFileBridge,
  MofangGuardBridge,
  MofangDiagBridge,
  MofangDataLocationBridge,
  MofangAnnounceBridge,
  MofangUpdateBridge,
} from '../../shared/contracts/bridge.js';
import type { MockBankStore } from '../../bank/mock/mock-store.js';
import { getSharedMockBankStore } from './BankExtServiceFactory.js';
import {
  serializeStore,
  deserializeStore,
  saveStoreToIndexedDb,
  downloadJsonFile,
} from './web-storage.js';

function triggerFilePick(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    document.body.appendChild(input);

    input.onchange = () => {
      const file = input.files?.[0] ?? null;
      document.body.removeChild(input);
      resolve(file);
    };

    input.oncancel = () => {
      document.body.removeChild(input);
      resolve(null);
    };

    input.click();
  });
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

function getImageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 100, height: 100 });
    img.src = dataUrl;
  });
}

export function computeWebDashboard(store: MockBankStore): HomeDashboardStats {
  const now = new Date();
  const validQuestions = Array.from(store.questions.values()).filter((q) => !q.deleted);
  const validPapers = Array.from(store.papers.values()).filter((p) => p.status !== 'trashed');

  // 最近 3 份有效试卷
  const sortedPapers = [...validPapers].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 3);
  const recentPapers = sortedPapers.map((p) => {
    const qList = store.paperQuestions.get(p.id) || [];
    return {
      id: p.id,
      title: p.title,
      status: (p.status ?? 'draft') as PaperStatus,
      questionCount: qList.length,
      updatedAt: p.createdAt,
    };
  });

  // 26 周工作足迹窗口 (182 天)
  const activityDays: HomeActivityDay[] = [];
  const startDay = new Date(now);
  startDay.setDate(now.getDate() - 182);

  // 统计每天各个动作频次
  const dayMap = new Map<string, Record<HomeWorkCategory, number>>();
  for (const log of store.logs) {
    const dateStr = log.timestamp.slice(0, 10);
    if (!dayMap.has(dateStr)) {
      dayMap.set(dateStr, { intake: 0, bank: 0, compose: 0, feedback: 0, ai: 0, capture: 0 });
    }
    const cat = dayMap.get(dateStr)!;
    if (log.type.startsWith('question.')) cat.bank++;
    else if (log.type.startsWith('paper.')) cat.compose++;
    else if (log.type.startsWith('feedback.')) cat.feedback++;
    else if (log.type.startsWith('ai.')) cat.ai++;
    else if (log.type.startsWith('recog.')) cat.intake++;
  }

  const cur = new Date(startDay);
  while (cur <= now) {
    const dStr = cur.toISOString().slice(0, 10);
    const counts = dayMap.get(dStr) ?? { intake: 0, bank: 0, compose: 0, feedback: 0, ai: 0, capture: 0 };
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    activityDays.push({
      date: dStr,
      counts,
      total,
      level: total === 0 ? 0 : total <= 2 ? 1 : total <= 5 ? 2 : total <= 10 ? 3 : 4,
    });
    cur.setDate(cur.getDate() + 1);
  }

  // 计算连续活跃天数
  let currentStreak = 0;
  let longestStreak = 0;
  let tempStreak = 0;
  for (let i = activityDays.length - 1; i >= 0; i--) {
    if (activityDays[i].total > 0) {
      if (i === activityDays.length - 1 || currentStreak > 0) currentStreak++;
    } else if (currentStreak > 0) {
      break;
    }
  }
  for (const day of activityDays) {
    if (day.total > 0) {
      tempStreak++;
      if (tempStreak > longestStreak) longestStreak = tempStreak;
    } else {
      tempStreak = 0;
    }
  }

  // 题目增长趋势
  const questionGrowthMap = new Map<string, number>();
  for (const q of validQuestions) {
    const d = q.createdAt.slice(0, 10);
    questionGrowthMap.set(d, (questionGrowthMap.get(d) ?? 0) + 1);
  }
  const sortedDates = Array.from(questionGrowthMap.keys()).sort();
  let cumulative = 0;
  const questionGrowth = sortedDates.map((date) => {
    cumulative += questionGrowthMap.get(date)!;
    return { date, total: cumulative };
  });

  return {
    questions: validQuestions.length,
    papers: validPapers.length,
    documentsRecognized: store.logs.filter((l) => l.type.startsWith('recog.')).length,
    mistakeRecords: store.mistakes.size,
    aiInvocations: store.logs.filter((l) => l.type === 'ai.invoke').length,
    aiTokens: 0,
    aiDaily: [],
    activity: activityDays,
    streak: { current: currentStreak, longest: longestStreak },
    questionGrowth,
    recentPapers,
  };
}

export function createWebFileBridge(): MofangFileBridge {
  return {
    pickLogoImage: async () => {
      const file = await triggerFilePick('image/*');
      if (!file) throw new Error('用户取消了选择');
      const dataUrl = await readFileAsDataUrl(file);
      const dims = await getImageDimensions(dataUrl);
      return { assetId: dataUrl, width: dims.width, height: dims.height };
    },

    saveRecogImage: async (payload: { dataUrl: string; width?: number; height?: number }) => {
      return { assetId: payload.dataUrl };
    },

    readClipboardImage: async () => {
      try {
        if (!navigator.clipboard?.read) return null;
        const items = await navigator.clipboard.read();
        for (const item of items) {
          const imageType = item.types.find((t) => t.startsWith('image/'));
          if (imageType) {
            const blob = await item.getType(imageType);
            const dataUrl = await readFileAsDataUrl(new File([blob], 'clipboard.png', { type: imageType }));
            const dims = await getImageDimensions(dataUrl);
            return { assetId: dataUrl, width: dims.width, height: dims.height };
          }
        }
      } catch (err) {
        console.warn('Failed to read clipboard image:', err);
      }
      return null;
    },

    importPresetFile: async () => {
      const file = await triggerFilePick('.json');
      if (!file) return { ok: false, reason: '用户取消了选择' };
      const content = await readFileAsText(file);
      return { ok: true, content, filePath: file.name };
    },

    exportPresetFile: async (payload: { suggestedName: string; content: string }) => {
      downloadJsonFile(payload.suggestedName || 'preset.json', payload.content);
      return { ok: true, filePath: payload.suggestedName };
    },

    exportTextFile: async (payload: { suggestedName: string; content: string }) => {
      const blob = new Blob([payload.content], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = payload.suggestedName || 'export.txt';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      return { ok: true, filePath: payload.suggestedName };
    },

    importTextFile: async () => {
      const file = await triggerFilePick('.txt,.json');
      if (!file) return { ok: false, reason: '用户取消了选择' };
      const content = await readFileAsText(file);
      return { ok: true, content, filePath: file.name };
    },

    scanRecogAssetGarbage: async () => ({ totalCount: 0, totalBytes: 0, items: [] }),
    trashRecogAssets: async () => ({ trashedCount: 0, freedBytes: 0 }),
    exportCards: async () => ({ ok: true, count: 0 }),
  };
}

export function createWebGuardBridge(store: MockBankStore): MofangGuardBridge {
  return {
    getDashboard: async () => computeWebDashboard(store),

    getStats: async () => ({
      questions: store.questions.size,
      papers: store.papers.size,
      dbSizeBytes: 0,
    }),

    createBackup: async () => {
      const data = serializeStore(store);
      const filename = `mofang-backup-${new Date().toISOString().slice(0, 10)}.json`;
      downloadJsonFile(filename, JSON.stringify(data, null, 2));
      return { ok: true, filePath: filename, timestamp: new Date().toISOString() };
    },

    restoreBackup: async () => {
      const file = await triggerFilePick('.json');
      if (!file) throw new Error('用户取消了选择备份文件');
      const text = await readFileAsText(file);
      const data = JSON.parse(text);
      deserializeStore(store, data);
      await saveStoreToIndexedDb(store);
      store.notifyChange();
      return { ok: true, restoredAt: new Date().toISOString(), backupPath: file.name };
    },
  };
}

export function initWebBridges(): void {
  if (typeof window === 'undefined') return;

  // 如果已经在真实的 Electron 环境中，则不覆盖原生 bridge
  if (window.__mofangBank) return;

  const store = getSharedMockBankStore();

  if (!window.__mofangFile) {
    (window as any).__mofangFile = createWebFileBridge();
  }

  if (!window.__mofangGuard) {
    (window as any).__mofangGuard = createWebGuardBridge(store);
  }

  if (!window.__mofangDiag) {
    (window as any).__mofangDiag = {
      exportDiagnostics: async () => {
        const diag = {
          userAgent: navigator.userAgent,
          timestamp: new Date().toISOString(),
          questionsCount: store.questions.size,
          papersCount: store.papers.size,
          logsCount: store.logs.length,
        };
        downloadJsonFile(`mofang-diag-${Date.now()}.json`, JSON.stringify(diag, null, 2));
        return { ok: true, filePath: 'mofang-diag.json' };
      },
    };
  }

  if (!window.__mofangDataLocation) {
    (window as any).__mofangDataLocation = {
      get: async () => ({
        currentDir: '当前浏览器 IndexedDB 本地数据库',
        configDir: null,
        targetDir: null,
        isPending: false,
      }),
      change: async () => ({ ok: false, reason: '纯网页端数据自动保存在浏览器本地，无需修改目录' }),
      cancel: async () => ({ ok: true }),
    };
  }

  if (!window.__mofangAnnounce) {
    (window as any).__mofangAnnounce = {
      get: async () => ({
        items: [
          {
            id: 'web-v1',
            title: '魔方助教网页版已就绪',
            content: '纯网页版数据保存在本机浏览器（IndexedDB），不依赖任何后台服务，安全私密。',
            date: new Date().toISOString().slice(0, 10),
          },
        ],
        source: 'builtin',
      }),
      refresh: async () => ({
        items: [],
        source: 'builtin',
      }),
    };
  }

  if (!window.__mofangUpdate) {
    (window as any).__mofangUpdate = {
      getStatus: async () => ({ status: 'not-available' }),
      checkNow: async () => {},
      openExternal: async (url: string) => {
        window.open(url, '_blank');
        return { ok: true };
      },
      quitAndInstall: async () => {},
      onStatus: () => () => {},
    };
  }
}
