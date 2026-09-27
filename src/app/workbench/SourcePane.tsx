// 0040 P3/P4 左栏：原文件预览（多图连续滚动 + 智能缩放）+ 手动框选（垫底档）+ 图块红框微调。
//
// 关键约束（任务书 §二 P3）：
//   - 手动框选**全程不依赖任何模型**（无模型时框选图可直接入题卡当图）；
//   - 几何一律复用 `box-geometry.ts`（其底层是 0036 的 box-model 纯函数），归一化 0~1 口径；
//   - 框上四动作条：✓ 加入右侧待识别 / ↩ 并入最新待识别题 / 📋 复制 / ✕（D-056⑤）；
//   - 「并入」目标 = 右列最新待识别卡；无待识别卡时由调用方 toast 提示（本组件只上抛动作）。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OnestepFigureSource, WorkbenchPage, WorkbenchRect } from '../../shared/contracts/onestep-types.js';
import { useLayoutEffect } from 'react';
import {
  denormalizeRect, moveRect, rectFromDrag, rectToBoxStyle, resizeRect,
  type PageSize, type Point,
} from './box-geometry.js';
import { createRafThrottle } from './raf-throttle.js';
import type { PageImageLike } from './crop.js';
import type { WarnJumpTarget } from '../pages/WorkbenchPage.js';

/** 已提交到右栏的框（溯源显示用） */
export interface SourceFrameMark {
  id: string;
  pageNo: number;
  rect: WorkbenchRect;
  kind: 'pending' | 'attached';
}

/** 题卡图块叠加（可微调） */
export interface SourceFigureMark {
  cardId: string;
  index: number;
  pageNo: number;
  rect: WorkbenchRect;
  adjusted: boolean;
  source: OnestepFigureSource;
  /** 该题卡已入库（锁定态：图块不再可调） */
  locked: boolean;
}

export interface FrameActionPayload {
  pageNo: number;
  rect: WorkbenchRect;
}

const ZOOM_MIN = 0.3;
const ZOOM_MAX = 2.5;
/** 页图区左右内边距合计（.wb-src-pages padding 14×2）——宽度铺满要减掉它，否则页图比可视区宽 28px */
const PAGES_PADDING_X = 28;

interface Props {
  pages: WorkbenchPage[];
  pageUrls: Map<number, string>;
  pageImages: Map<number, PageImageLike>;
  frameMarks: SourceFrameMark[];
  figureMarks: SourceFigureMark[];
  /**
   * 0046 P3（只增，可选）：黄条「去处理」的图块定位目标（页面受控口下传，禁事件总线）。
   * figureIndex≥0 且对应框存在 → 滚动定位并闪烁该框；否则闪烁所属页（缺坐标图块的显式提示）。
   */
  figureFocus?: WarnJumpTarget | null;
  /** 0046 目检返工③（只增，可选）：AI 一键录入进左栏工具条（与手动框选同排；缺省不渲染） */
  aiOneClickSlot?: { aiReady: boolean; aiBusy: boolean; onClick: () => void };
  onFrameAction: (action: 'toNew' | 'mergeLatest' | 'copy' | 'discard', payload: FrameActionPayload) => void;
  /** 松手提交：重裁并写回题卡 */
  onFigureChange: (cardId: string, index: number, rect: WorkbenchRect) => void;
  /** 拖动中（实时）：rect=当前框，null=拖动结束/取消（2026-09-20 目检返工②） */
  onFigureDrag: (cardId: string, index: number, rect: WorkbenchRect | null) => void;
}

/**
 * 默认缩放 = 宽度铺满预览区（2026-09-20 目检返工②，取代 D-055④ 的「图小铺满、图大原尺寸」）。
 * 大页不再缩到 100% 之外留白，小图也放大到铺满（上限 ZOOM_MAX 兜住过度放大）。
 */
export function autoZoom(pageWidth: number, availWidth: number): number {
  if (pageWidth <= 0 || availWidth <= 0) return 1;
  return clampZoom(availWidth / pageWidth);
}

export function clampZoom(zoom: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

export function SourcePane({ pages, pageUrls, pageImages, frameMarks, figureMarks, figureFocus, aiOneClickSlot, onFrameAction, onFigureChange, onFigureDrag }: Props) {
  const pagesRef = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState(1);
  /** 用户点过 −/+ 之后不再自动改缩放（自动铺满只服务于「没调过」的默认态） */
  const [zoomTouched, setZoomTouched] = useState(false);
  const [framing, setFraming] = useState(false);
  const [draftRect, setDraftRect] = useState<{ pageNo: number; rect: WorkbenchRect } | null>(null);
  const dragRef = useRef<{ pageNo: number; start: Point; page: PageSize } | null>(null);
  // 0046 P4：最新拖拽框独立 ref（rAF 节流下 state 滞后一帧，收尾必须取最新值，末帧才准）；
  // 不并入 dragRef——onPagePointerDown（0043 领地）函数体零触及
  const dragRectRef = useRef<WorkbenchRect | null>(null);
  const [dragPreview, setDragPreview] = useState<{ pageNo: number; rect: WorkbenchRect } | null>(null);
  const [figurePreview, setFigurePreview] = useState<{ cardId: string; index: number; rect: WorkbenchRect } | null>(null);

  // 0046 P4：框选预览的视觉腿走 rAF 节流（leading + trailing；逐帧 setState 不再每 move 一次）
  const dragPreviewThrottle = useMemo(
    () => createRafThrottle<[preview: { pageNo: number; rect: WorkbenchRect }]>((preview) => setDragPreview(preview)),
    [],
  );
  useEffect(() => () => dragPreviewThrottle.dispose(), [dragPreviewThrottle]);

  const firstPage = pages[0];
  const firstImage = firstPage ? pageImages.get(firstPage.pageNo) : undefined;
  const firstWidth = firstImage?.naturalWidth ?? firstPage?.width ?? 0;

  /** 页图区可视宽度（clientWidth 已含内边距、已扣竖向滚动条） */
  const availableWidth = useCallback((): number => {
    return (pagesRef.current?.clientWidth ?? 0) - PAGES_PADDING_X;
  }, []);

  // 默认宽度铺满（返工②）：页图尺寸已知时按页图区宽度自适应
  useLayoutEffect(() => {
    if (zoomTouched) return;
    const avail = availableWidth();
    if (avail > 0 && firstWidth > 0) setZoom(autoZoom(firstWidth, avail));
  }, [firstWidth, zoomTouched, availableWidth]);

  // 窗口/栏宽变化时保持铺满（同样只作用于未手动调过的默认态）
  useEffect(() => {
    const element = pagesRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (zoomTouched) return;
      const avail = availableWidth();
      if (avail > 0 && firstWidth > 0) setZoom(autoZoom(firstWidth, avail));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [firstWidth, zoomTouched, availableWidth]);

  const pageSizeOf = useCallback((pageNo: number): PageSize => {
    const image = pageImages.get(pageNo);
    const meta = pages.find((p) => p.pageNo === pageNo);
    return {
      w: image?.naturalWidth ?? meta?.width ?? 0,
      h: image?.naturalHeight ?? meta?.height ?? 0,
    };
  }, [pageImages, pages]);

  /** 指针位置 → 页内归一化点（除零保护：页面未布局时报 (0,0)，不产生 NaN 框） */
  const pointOf = useCallback((event: React.PointerEvent, element: HTMLElement): Point | null => {
    const size = element.dataset['pageSize'];
    if (!size) return null;
    const [wRaw, hRaw] = size.split('x');
    const w = Number(wRaw);
    const h = Number(hRaw);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
    const rect = element.getBoundingClientRect();
    const renderW = rect.width || w;
    const renderH = rect.height || h;
    return { x: (event.clientX - rect.left) / renderW, y: (event.clientY - rect.top) / renderH };
  }, []);

  // ---------- 手动框选拖拽 ----------
  const onPagePointerDown = (pageNo: number, event: React.PointerEvent<HTMLDivElement>) => {
    if (!framing) return;
    // 按下落在叠加层（草稿框动作条/标记框/图块框，类名一律 .wb-fig-box）内部时放行：
    // 否则会按「起新框」处理——preventDefault + setPointerCapture 抢走指针，真实浏览器里
    // 动作条按钮的 click 会被重定向吞掉（0043；一处判据覆盖全部叠加层）。
    if (event.target instanceof Element && event.target.closest('.wb-fig-box')) return;
    const element = event.currentTarget;
    const page = pageSizeOf(pageNo);
    const point = pointOf(event, element);
    if (!point || page.w <= 0) return;
    event.preventDefault();
    element.setPointerCapture?.(event.pointerId);
    dragRef.current = { pageNo, start: point, page };
    setDragPreview({ pageNo, rect: { x: point.x, y: point.y, w: 0, h: 0 } });
  };

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (drag) {
        const element = document.querySelector<HTMLElement>(`[data-wb-page="${drag.pageNo}"]`);
        if (!element) return;
        const rect = element.getBoundingClientRect();
        const renderW = rect.width || drag.page.w;
        const renderH = rect.height || drag.page.h;
        const point = { x: (event.clientX - rect.left) / renderW, y: (event.clientY - rect.top) / renderH };
        // 0046 P4：最新框先进 ref（收尾数据源，永不滞后），视觉刷新走 rAF 节流
        const next = {
          x: Math.min(drag.start.x, point.x),
          y: Math.min(drag.start.y, point.y),
          w: Math.abs(point.x - drag.start.x),
          h: Math.abs(point.y - drag.start.y),
        };
        dragRectRef.current = next;
        dragPreviewThrottle({ pageNo: drag.pageNo, rect: next });
      }
    };
    const onUp = () => {
      const drag = dragRef.current;
      if (drag) {
        dragRef.current = null;
        // 0046 P4：收尾提交不受节流影响——取消滞后帧，用 ref 里的最新框算终值（末帧必达）。
        // 用 cancel 而非 dispose：节流器是组件级单例，第二次拖框还要用（目检返工①）
        dragPreviewThrottle.cancel();
        const previewRect = dragRectRef.current ?? { x: drag.start.x, y: drag.start.y, w: 0, h: 0 };
        dragRectRef.current = null;
        setDragPreview(null);
        const normalized = rectFromDrag({ x: drag.start.x * drag.page.w, y: drag.start.y * drag.page.h }, {
          x: (previewRect.x + previewRect.w) * drag.page.w,
          y: (previewRect.y + previewRect.h) * drag.page.h,
        }, drag.page);
        if (normalized) setDraftRect({ pageNo: drag.pageNo, rect: normalized });
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [dragPreviewThrottle]);

  // ---------- 图块微调（拖动移动 / 右下角缩放；松手提交重裁） ----------
  const onFigurePointerDown = (
    mark: SourceFigureMark,
    mode: 'move' | 'resize',
    event: React.PointerEvent<HTMLElement>,
  ) => {
    if (mark.locked) return;
    event.preventDefault();
    event.stopPropagation();
    const element = document.querySelector<HTMLElement>(`[data-wb-page="${mark.pageNo}"]`);
    if (!element) return;
    const page = pageSizeOf(mark.pageNo);
    const rect = element.getBoundingClientRect();
    const renderW = rect.width || page.w;
    const renderH = rect.height || page.h;
    const anchor = { x: (event.clientX - rect.left) / renderW, y: (event.clientY - rect.top) / renderH };
    const rectAt = (clientX: number, clientY: number): WorkbenchRect => {
      const point = { x: (clientX - rect.left) / renderW, y: (clientY - rect.top) / renderH };
      return mode === 'move'
        ? moveRect(mark.rect, point.x - anchor.x, point.y - anchor.y)
        : resizeRect(mark.rect, 'se', point);
    };
    // 0046 P4：拖动中的实时腿（预览框 + 上层重裁）走 rAF 节流，帧间至多一次
    const dragThrottle = createRafThrottle((next: WorkbenchRect) => {
      setFigurePreview({ cardId: mark.cardId, index: mark.index, rect: next });
      // 实时腿：拖动中就把新框交给上层重裁，右侧题卡的图跟着框走（2026-09-20 目检返工②）
      onFigureDrag(mark.cardId, mark.index, next);
    });
    const onMove = (moveEvent: PointerEvent) => {
      dragThrottle(rectAt(moveEvent.clientX, moveEvent.clientY));
    };
    const onUp = (upEvent: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      // 0046 P4：收尾提交不受节流影响——丢掉滞后帧；终值由事件坐标现算（末帧必达）
      dragThrottle.dispose();
      const next = rectAt(upEvent.clientX, upEvent.clientY);
      setFigurePreview(null);
      onFigureDrag(mark.cardId, mark.index, null);
      onFigureChange(mark.cardId, mark.index, next);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    setFigurePreview({ cardId: mark.cardId, index: mark.index, rect: mark.rect });
    onFigureDrag(mark.cardId, mark.index, mark.rect);
  };

  // 0046 P3：黄条「去处理」→ 左栏定位：滚动 + 闪烁（图块框；无坐标图块则闪页框提示缺图）
  useEffect(() => {
    if (!figureFocus) return;
    const markExists = figureMarks.some((m) => m.cardId === figureFocus.cardId && m.index === figureFocus.figureIndex);
    const element = markExists
      ? document.querySelector(`[data-testid="wb-figure-${figureFocus.cardId}-${figureFocus.figureIndex}"]`)
      : document.querySelector(`[data-wb-page="${figureFocus.pageNo}"]`);
    if (!element) return;
    element.scrollIntoView?.({ block: 'center' });
    element.classList.add('wb-fig-flash');
    const timer = setTimeout(() => element.classList.remove('wb-fig-flash'), 1600);
    return () => {
      clearTimeout(timer);
      element.classList.remove('wb-fig-flash');
    };
  }, [figureFocus, figureMarks]);

  const drawFrames = (pageNo: number): SourceFrameMark[] => frameMarks.filter((f) => f.pageNo === pageNo);
  const drawFigures = (pageNo: number): SourceFigureMark[] => figureMarks.filter((f) => f.pageNo === pageNo);

  return (
    <div className="wb-col wb-src-col" data-testid="wb-source-col">
      <div className="wb-src-panel">
        <div className="wb-src-tools" data-testid="wb-src-tools">
          <span className="wb-muted">原文件</span>
          <button
            type="button"
            className="wb-zbtn"
            data-testid="wb-zoom-out"
            onClick={() => { setZoomTouched(true); setZoom((z) => clampZoom(z / 1.2)); }}
          >
            −
          </button>
          <span className="wb-zval" data-testid="wb-zoom-value" data-zoom={zoom}>{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            className="wb-zbtn"
            data-testid="wb-zoom-in"
            onClick={() => { setZoomTouched(true); setZoom((z) => clampZoom(z * 1.2)); }}
          >
            +
          </button>
          <button
            type="button"
            className="wb-zbtn"
            data-testid="wb-zoom-auto"
            title="按预览区宽度铺满"
            onClick={() => {
              setZoomTouched(true);
              setZoom(clampZoom(autoZoom(firstWidth, availableWidth())));
            }}
          >
            适应宽度
          </button>
          <span className="wb-sp" />
          <button
            type="button"
            className={framing ? 'wb-frame-toggle on' : 'wb-frame-toggle'}
            data-testid="wb-frame-toggle"
            aria-pressed={framing}
            onClick={() => { setFraming((v) => !v); setDraftRect(null); }}
          >
            ✂ 手动框选
          </button>
          {/* 0046 目检返工③：AI 一键与手动框选同排（功能同族）——手动框选在左、AI 一键在右 */}
          {aiOneClickSlot?.aiReady && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              data-testid="wb-ai-one-click"
              disabled={aiOneClickSlot.aiBusy}
              title={aiOneClickSlot.aiBusy ? 'AI 一键识别进行中' : '整页自动识别，逐题落卡'}
              onClick={aiOneClickSlot.onClick}
            >
              ✨ AI 一键录入
            </button>
          )}
        </div>

        <div className="wb-src-pages" data-testid="wb-pages-scroll" ref={pagesRef}>
          {pages.map((page) => {
            const url = pageUrls.get(page.pageNo);
            const size = pageSizeOf(page.pageNo);
            // 页面与叠加层一律用**显示尺寸**（原图尺寸 × zoom）：
            // 叠加层是页面的绝对定位子元素，用未缩放的像素坐标就会随缩放比例整体飘（2026-09-20 目检返工②）
            const box = { w: size.w * zoom, h: size.h * zoom };
            return (
              <div
                key={page.pageNo}
                className={framing ? 'wb-src-page framing' : 'wb-src-page'}
                data-wb-page={page.pageNo}
                data-testid={`wb-page-${page.pageNo}`}
                data-page-size={`${size.w}x${size.h}`}
                style={box.w > 0 ? { width: box.w, height: box.h } : undefined}
                onPointerDown={(e) => onPagePointerDown(page.pageNo, e)}
              >
                {url
                  ? <img className="wb-src-img" src={url} alt={page.name || `第 ${page.pageNo} 页`} draggable={false} />
                  : <div className="wb-src-placeholder">第 {page.pageNo} 页图未就绪</div>}

                {/* 已入列的框选（待识别卡溯源） */}
                {drawFrames(page.pageNo).map((frame) => {
                  const style = rectToBoxStyle(frame.rect, box);
                  return (
                    <div
                      key={frame.id}
                      className={frame.kind === 'pending' ? 'wb-fig-box pending' : 'wb-fig-box attached'}
                      data-testid={`wb-frame-mark-${frame.id}`}
                      style={style}
                    >
                      <span className="wb-fb-tag">{frame.kind === 'pending' ? '待识别' : '已并入'}</span>
                    </div>
                  );
                })}

                {/* 拖拽中的新框 */}
                {dragPreview && dragPreview.pageNo === page.pageNo && (
                  <div className="wb-fig-box manual" data-testid="wb-frame-dragging" style={rectToBoxStyle(dragPreview.rect, box)} />
                )}

                {/* 待确认（新框画完的四动作条） */}
                {draftRect && draftRect.pageNo === page.pageNo && (
                  <div className="wb-fig-box manual" data-testid="wb-frame-draft" style={rectToBoxStyle(draftRect.rect, box)}>
                    <span className="wb-fb-tag">新框</span>
                    <span
                      className="wb-fb-act"
                      style={{ bottom: `${frameActionBarBottomOffset(draftRect.rect.y + draftRect.rect.h, box.h)}px` }}
                    >
                      <button type="button" data-testid="wb-frame-to-new" onClick={() => { onFrameAction('toNew', draftRect); setDraftRect(null); }}>
                        ✓ 加入右侧待识别
                      </button>
                      <button type="button" data-testid="wb-frame-merge" onClick={() => { onFrameAction('mergeLatest', draftRect); setDraftRect(null); }}>
                        ↩ 并入最新待识别题
                      </button>
                      <button type="button" data-testid="wb-frame-copy" onClick={() => { onFrameAction('copy', draftRect); setDraftRect(null); }}>
                        📋 复制
                      </button>
                      <button type="button" data-testid="wb-frame-discard" onClick={() => setDraftRect(null)}>✕</button>
                    </span>
                  </div>
                )}

                {/* 题卡图块（可拖动 / 拖右下角缩放微调 → 松手重裁） */}
                {drawFigures(page.pageNo).map((mark) => {
                  const rect = figurePreview && figurePreview.cardId === mark.cardId && figurePreview.index === mark.index
                    ? figurePreview.rect
                    : mark.rect;
                  return (
                    <div
                      key={`${mark.cardId}-${mark.index}`}
                      className={mark.adjusted ? 'wb-fig-box adjusted' : 'wb-fig-box'}
                      data-testid={`wb-figure-${mark.cardId}-${mark.index}`}
                      data-adjusted={mark.adjusted ? '1' : '0'}
                      data-locked={mark.locked ? '1' : '0'}
                      style={rectToBoxStyle(rect, box)}
                      onPointerDown={(e) => onFigurePointerDown(mark, 'move', e)}
                    >
                      <span className="wb-fb-tag">
                        {mark.adjusted ? '人工确认' : '自动定位'}
                        {mark.source === 'inline' ? '（内联）' : ''}
                      </span>
                      {!mark.locked && (
                        <span
                          className="wb-fb-handle"
                          data-testid={`wb-figure-handle-${mark.cardId}-${mark.index}`}
                          onPointerDown={(e) => onFigurePointerDown(mark, 'resize', e)}
                        />
                      )}
                    </div>
                  );
                })}

                <span className="wb-pgno">{page.pageNo} / {pages.length}</span>
              </div>
            );
          })}
          {pages.length === 0 && <div className="wb-muted" data-testid="wb-no-pages">没有页图（run 尚未落盘页图）</div>}
        </div>
      </div>
    </div>
  );
}

/** 归一化矩形是否够大（太小的拖拽视为误点，与 box-model 的最小边长同口径） */
export function isUsableDraftRect(rect: WorkbenchRect): boolean {
  const px = denormalizeRect(rect, { w: 1000, h: 1000 });
  return px.w >= 24 && px.h >= 16;
}

// ---------- 四动作条防裁切（0043 返工①） ----------
// workbench.css：.wb-fb-act 定位 bottom:-30px（挂在框底边下方），而 .wb-src-page overflow:hidden
// 会把超出页图范围的部分裁掉——框贴近页底时动作条被裁得只剩一条缝。CSS 属禁区，
// 故在渲染处用行内 bottom 覆盖：把动作条底边钳在页元素内。
/** 动作条默认悬挂距离（px），与 workbench.css .wb-fb-act bottom:-30px 同值 */
export const FRAME_ACT_DROP_PX = 30;
/** 钳制时动作条底边距页底的留缝（px） */
const FRAME_ACT_MARGIN_PX = 2;

/**
 * 动作条 bottom 偏移（px）：页内剩余空间足够时维持默认悬挂；不够时上钳（框底贴页底时为负值，
 * 动作条缩进框内保证可见）。
 */
export function frameActionBarBottomOffset(rectBottomNorm: number, pageDisplayHeight: number): number {
  if (!(pageDisplayHeight > 0)) return FRAME_ACT_DROP_PX;
  const room = pageDisplayHeight * (1 - rectBottomNorm) - FRAME_ACT_MARGIN_PX;
  return Math.round(Math.min(FRAME_ACT_DROP_PX, room));
}
