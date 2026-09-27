// 0040 P1/P2：工作台控制器（状态装载/防抖落盘/页图/档位判定）。
//
// 数据流：runId → recog.status（页图路径 + run 元）→ recog.workbench.load（卡流状态）→ 内存态
//         → 每次变更防抖 save（createDebouncedSaver，0036 同源）→ 关窗回来即恢复现场。
//
// 档位判定（D-057 / 验收探针 §六.4）：vision 角色有启用档案 → auto 档可用（AI 一键显示）；
// 否则 semi 档（横幅 + 无 AI 按钮 + OCR 链可用）；手动框选恒可用、不受档位影响。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MofangAiBridge, MofangRecogBridge } from '../../shared/contracts/bridge.js';
import type { WorkbenchMode, WorkbenchPage, WorkbenchState } from '../../shared/contracts/onestep-types.js';
import { createWorkbenchState } from '../../recog/onestep/workbench.js';
import { createDebouncedSaver, type SaveState } from '../../recog/splitting/auto-save.js';
import { createAiServices } from '../services/AiServiceFactory.js';
import { createRecogService } from '../services/RecogServiceFactory.js';
import { imageSrcOf, loadFileImage, loadPageImage, type PageImageLike } from './crop.js';
import { resolveRecognizeModelChoice, type RecognizeModelChoice } from './recognize.js';

export interface UseWorkbenchOptions {
  runId: string;
  mode: WorkbenchMode;
  stage: string;
  subjectId: string;
  paperTitle?: string;
  /** 本次会话拖入的原始图片（可裁图源；按 run 页序对应） */
  files?: File[];
  recog?: MofangRecogBridge;
  ai?: MofangAiBridge;
  now?: () => string;
}

export interface WorkbenchController {
  state: WorkbenchState | null;
  /** pageNo → 可裁页图（内存字节优先，回落磁盘 file:// 路径） */
  pageImages: Map<number, PageImageLike>;
  /** 页图就绪（左侧预览可显示） */
  pageUrls: Map<number, string>;
  loading: boolean;
  loadError: string | null;
  saveState: SaveState;
  /** vision 角色是否已配置启用档案（auto 档可用性；手动框选不受影响） */
  aiReady: boolean;
  /** 双模型档位解析结果（主档优先 reasoning，坐标腿 vision；进错误文案） */
  modelChoice: RecognizeModelChoice;
  /**
   * 0046 P1.7：页图解码/加载进度（有页数时驱动统一读条；全部就绪后为 null）。
   * 口径 = 已就绪页数 / 总页数（内存解码与磁盘补载都算「就绪」）。
   */
  pageLoadProgress: { done: number; total: number } | null;
  /** 更新状态（函数式；自动防抖落盘） */
  update: (recipe: (draft: WorkbenchState) => WorkbenchState) => void;
  /** 立即落盘（切换页面/关窗前） */
  flush: () => Promise<void>;
  /** 内存图是否可作为裁图源（false = 只读预览，裁图会因安全限制失败） */
  canCrop: boolean;
}

export function useWorkbench(options: UseWorkbenchOptions): WorkbenchController {
  const recog = useMemo(() => options.recog ?? createRecogService(), [options.recog]);
  const ai = useMemo(() => options.ai ?? createAiServices(), [options.ai]);
  // 时钟走 ref：内联 `now` 每次渲染都是新函数，若进 effect 依赖会引发装载 effect 无限重跑
  const nowRef = useRef(options.now);
  nowRef.current = options.now;
  const now = useCallback(() => nowRef.current?.() ?? new Date().toISOString(), []);

  const [state, setState] = useState<WorkbenchState | null>(null);
  const [pageUrls, setPageUrls] = useState<Map<number, string>>(new Map());
  const [pageImages, setPageImages] = useState<Map<number, PageImageLike>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // 0046 P1.7：页图加载读条的数据源
  const [pageLoadProgress, setPageLoadProgress] = useState<{ done: number; total: number } | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [aiReady, setAiReady] = useState(false);
  const [modelChoice, setModelChoice] = useState<RecognizeModelChoice>({
    mainRole: 'vision', groundingRole: 'vision', label: '未配置模型',
  });

  const filesRef = useRef<File[]>(options.files ?? []);
  filesRef.current = options.files ?? [];

  // ---------- 装载：run 元 + 卡流状态 ----------
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError(null);
    void (async () => {
      try {
        const detail = await recog.status({ runId: options.runId });
        if (!alive) return;

        const memoryFiles = filesRef.current;
        const urls = new Map<number, string>();
        const images = new Map<number, PageImageLike>();
        for (const page of detail.pages) {
          urls.set(page.pageNo, imageSrcOf(page.imagePath));
        }
        // 0046 P1.7：读条口径 = 已就绪页数 / 总页数（内存解码 + 磁盘补载，每页只计一次）
        let pagesReady = 0;
        const totalPages = detail.pages.length;
        const bumpProgress = (): void => {
          pagesReady += 1;
          if (totalPages > 0) setPageLoadProgress({ done: pagesReady, total: totalPages });
        };
        if (totalPages > 0) setPageLoadProgress({ done: 0, total: totalPages });
        if (memoryFiles.length > 0) {
          // 本次会话拖入的字节 = 可裁源（与 run 页序一一对应：accepted 顺序即页序）
          await Promise.all(
            memoryFiles.slice(0, detail.pages.length).map(async (file, index) => {
              const pageNo = detail.pages[index]!.pageNo;
              try {
                images.set(pageNo, await loadFileImage(file));
                bumpProgress();
              } catch {
                /* 单页解码失败不阻断整体：该页回落磁盘预览 */
              }
            }),
          );
        }
        if (!alive) return;
        setPageUrls(urls);
        setPageImages(images);

        const persisted = await recog.workbench.load({ runId: options.runId });
        if (!alive) return;
        if (persisted) {
          setState({ ...persisted, mode: persisted.mode });
        } else {
          const pages: WorkbenchPage[] = detail.pages.map((p, index) => ({
            pageNo: p.pageNo,
            name: memoryFiles[index]?.name ?? `p${String(p.pageNo).padStart(3, '0')}.png`,
            width: images.get(p.pageNo)?.naturalWidth ?? 0,
            height: images.get(p.pageNo)?.naturalHeight ?? 0,
          }));
          setState(createWorkbenchState({
            runId: options.runId,
            mode: options.mode,
            stage: options.stage,
            subjectId: options.subjectId,
            paperTitle: options.paperTitle ?? detail.run.sourceName ?? '',
            pages,
            now: now(),
          }));
        }

        // 磁盘预览图（内存源缺失时补 decode，供左侧显示尺寸与叠加层坐标）
        for (const page of detail.pages) {
          if (images.has(page.pageNo)) continue;
          const url = urls.get(page.pageNo);
          if (!url) continue;
          try {
            const image = await loadPageImage(url, 'disk');
            if (!alive) return;
            setPageImages((prev) => new Map(prev).set(page.pageNo, image));
            bumpProgress();
          } catch {
            /* 单页预览失败：左侧显示占位，不阻断 */
          }
        }
        if (alive) setPageLoadProgress(null); // 全部就绪：读条撤下
      } catch (err) {
        if (alive) setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [recog, options.runId, options.mode, options.stage, options.subjectId, options.paperTitle, now]);

  // ---------- AI 档位可用性 + 双模型档位解析 ----------
  // 口径（任务书 §二 P2 / 探针 §六.4）：auto 档可用性看 **vision 档案**（禁用它即回落半自动）；
  // 但「一步到位」主调用优先发给 **reasoning 档**（视觉推理模型的自然档位），坐标腿走 vision（OCR 档）。
  // 二者混淆正是 2026-09-19 用户实测的病因（主调用错发到 OCR 模型 → 连着两条误导性报错）。
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const profiles = await ai.profile.list({});
        if (!alive) return;
        setAiReady(profiles.some((p) => p.role === 'vision' && p.isEnabled));
        setModelChoice(resolveRecognizeModelChoice(profiles));
      } catch {
        if (alive) { setAiReady(false); setModelChoice({ mainRole: 'vision', groundingRole: 'vision', label: '未配置模型' }); }
      }
    })();
    return () => { alive = false; };
  }, [ai]);

  // ---------- 防抖落盘 ----------
  const stateRef = useRef<WorkbenchState | null>(null);
  const saver = useMemo(
    () => createDebouncedSaver<WorkbenchState>({
      save: async (value) => { await recog.workbench.save({ runId: options.runId, state: value }); },
      onState: (next) => setSaveState(next),
    }),
    [recog, options.runId],
  );
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  useEffect(() => () => { void saver.flush().catch(() => undefined); saver.dispose(); }, [saver]);

  const update = useCallback((recipe: (draft: WorkbenchState) => WorkbenchState) => {
    setState((prev) => {
      if (!prev) return prev;
      const next = recipe({ ...prev, cards: [...prev.cards] });
      saver.schedule(next);
      return next;
    });
  }, [saver]);

  const flush = useCallback(async () => {
    const current = stateRef.current;
    if (!current) return;
    await saver.flush();
  }, [saver]);

  return {
    state,
    pageImages,
    pageUrls,
    loading,
    loadError,
    saveState,
    aiReady,
    modelChoice,
    pageLoadProgress,
    update,
    flush,
    canCrop: pageImages.size > 0,
  };
}
