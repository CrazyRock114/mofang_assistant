// 0036 P2：页图 + 画框覆盖层（canvas 自绘页面图，框用 DOM 覆盖层——零依赖、命中/拖拽用原生 pointer 事件）
//
// 为什么框不用 canvas 画：框要悬停高亮、要拖手柄、要有锁定态，DOM 元素把这些白送；
// 页图本身反而必须是 canvas（pdfjs 渲染产物就是它）。两者叠在一起，坐标只走一层归一化换算。
//
// 坐标唯一真源：**归一化 0..1 相对渲染后的页图像素尺寸**（box-model 的 normalizeRect/denormalizeRect）。
// 覆盖层的物理尺寸随时跟着容器变（窗口缩放/缩放档切换），所以每次指针事件都按当时的
// getBoundingClientRect 现算——不缓存 px 比例，换档后不会错位。

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SplitBox, SplitBoxType } from '../../shared/contracts/split-types.js';
import {
  type Point, type Rect, type ResizeHandle, denormalizeRect, hitTest, moveBox, normalizeRect,
  rectFromDrag, resizeBox,
} from '../../recog/splitting/box-model.js';

const TYPE_STYLE: Record<SplitBoxType, { label: string; color: string }> = {
  text: { label: '文字', color: 'var(--accent, #2563eb)' },
  image: { label: '图片', color: '#16a34a' },
  answer: { label: '答案', color: '#d97706' },
};

const HANDLES: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/**
 * 指针捕获是**优化不是正确性**：拖出元素外仍能收到 move 靠它，但捕获失败（合成事件、
 * 指针 id 不存在、元素已脱离文档）绝不能让画框整体失效——所以吞掉异常继续走状态机。
 * 自动化探针（S-2）正是靠这一点才能在隐藏窗里合成 pointer 事件。
 */
function capturePointer(el: HTMLElement | undefined, pointerId: number): void {
  if (!el || typeof el.setPointerCapture !== 'function') return;
  try {
    el.setPointerCapture(pointerId);
  } catch {
    /* 捕获失败不影响本次拖拽（document 级 pointermove 仍可兜底） */
  }
}

type DragMode =
  | { kind: 'draw'; start: Point; current: Point }
  | { kind: 'move'; boxId: string; origin: Point; last: Point }
  | { kind: 'resize'; boxId: string; handle: ResizeHandle };

export interface BoxCanvasProps {
  pageNo: number;
  /** 该页渲染位图（未就绪时显示占位） */
  source: HTMLCanvasElement | null;
  /** 本段本页的框 */
  boxes: SplitBox[];
  /** 已识别完成（锁定）的题号集合：这些题的框只读 */
  lockedQids: Set<string>;
  drawType: SplitBoxType;
  selectedBoxId: string | null;
  onSelect(boxId: string | null): void;
  /** 画完一个框（归一化矩形） */
  onDraw(type: SplitBoxType, rect: Rect): void;
  /** 框被移动（归一化增量） */
  onMove(boxId: string, dx: number, dy: number): void;
  /** 框被缩放（归一化新矩形） */
  onResize(boxId: string, rect: Rect): void;
  onBusyChange?(busy: boolean): void;
}

export function BoxCanvas(props: BoxCanvasProps) {
  const { pageNo, source, boxes, lockedQids, drawType, selectedBoxId } = props;
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [drag, setDrag] = useState<DragMode | null>(null);
  /**
   * 拖拽态的**权威副本**：pointer 事件是命令式的，读取必须与 state 更新同拍——
   * 只读 state 会让「同一次任务里连发的 down/move/up」全部读到旧值（自动化探针就是这样连发的）。
   * state 只负责把预览矩形画出来。
   */
  const dragRef = useRef<DragMode | null>(null);
  const applyDrag = (next: DragMode | null): void => {
    dragRef.current = next;
    setDrag(next);
  };
  /** 覆盖层显示尺寸（= 位图显示尺寸）；未就绪时为空，避免画到空气上 */
  const [stage, setStage] = useState<{ w: number; h: number } | null>(null);

  // 位图 → 可见 canvas（一次性 drawImage；位图本体留在页图缓存里供裁剪复用）
  useEffect(() => {
    const canvas = canvasRef.current;
    const host = stageRef.current;
    if (!canvas || !host) return;
    if (!source) {
      setStage(null);
      return;
    }
    canvas.width = source.width;
    canvas.height = source.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(source, 0, 0);
    // 显示尺寸以容器宽度为准（等比），覆盖层按它算归一化坐标
    const displayW = host.clientWidth;
    const displayH = Math.round((source.height / source.width) * displayW);
    setStage({ w: displayW, h: displayH });
  }, [source, pageNo]);

  // 容器尺寸变化（窗口缩放/侧栏开合）时重算覆盖层尺寸
  useEffect(() => {
    const host = stageRef.current;
    if (!host || !source) return;
    const update = (): void => {
      const displayW = host.clientWidth;
      setStage({ w: displayW, h: Math.round((source.height / source.width) * displayW) });
    };
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, [source]);

  const toNormalized = useCallback((event: React.PointerEvent): Point | null => {
    const stageEl = event.currentTarget as HTMLElement;
    const rect = stageEl.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
  }, []);

  const stageOf = useCallback((): { w: number; h: number } | null => {
    if (stage) return stage;
    return source ? { w: source.width, h: source.height } : null;
  }, [stage, source]);

  const onPointerDown = (event: React.PointerEvent): void => {
    if (event.button !== 0) return;
    const point = toNormalized(event);
    if (!point) return;
    capturePointer(event.currentTarget as HTMLElement, event.pointerId);
    applyDrag({ kind: 'draw', start: point, current: point });
    props.onSelect(null);
    props.onBusyChange?.(true);
  };

  const onBoxPointerDown = (event: React.PointerEvent, box: SplitBox, mode: 'move' | ResizeHandle): void => {
    event.stopPropagation();
    if (lockedQids.has(box.qid)) {
      props.onSelect(box.id);
      return; // 锁定题的框只允许选中查看，不允许改（任务书：识别完成后课程与框锁定）
    }
    const point = toNormalized(event);
    if (!point) return;
    capturePointer((event.currentTarget.parentElement as HTMLElement | null) ?? undefined, event.pointerId);
    props.onSelect(box.id);
    props.onBusyChange?.(true);
    if (mode === 'move') applyDrag({ kind: 'move', boxId: box.id, origin: point, last: point });
    else applyDrag({ kind: 'resize', boxId: box.id, handle: mode });
  };

  const onPointerMove = (event: React.PointerEvent): void => {
    const active = dragRef.current;
    if (!active) return;
    const point = toNormalized(event);
    if (!point) return;
    if (active.kind === 'draw') {
      applyDrag({ ...active, current: point });
      return;
    }
    if (active.kind === 'move') {
      const dx = point.x - active.last.x;
      const dy = point.y - active.last.y;
      props.onMove(active.boxId, dx, dy);
      applyDrag({ ...active, last: point });
      return;
    }
    const box = boxes.find((b) => b.id === active.boxId);
    if (!box) return;
    const stageSize = stageOf();
    if (!stageSize) return;
    const currentPx = denormalizeRect(box, stageSize);
    const next = resizeBox(
      { ...box, x: currentPx.x / stageSize.w, y: currentPx.y / stageSize.h, w: box.w, h: box.h },
      active.handle,
      point,
    );
    props.onResize(active.boxId, { x: next.x, y: next.y, w: next.w, h: next.h });
  };

  const finishDrag = (): void => {
    const active = dragRef.current;
    if (active?.kind === 'draw' && source) {
      const startPx = { x: active.start.x * source.width, y: active.start.y * source.height };
      const endPx = { x: active.current.x * source.width, y: active.current.y * source.height };
      const rect = rectFromDrag(startPx, endPx, { w: source.width, h: source.height });
      if (rect) props.onDraw(drawType, rect);
    }
    applyDrag(null);
    props.onBusyChange?.(false);
  };

  const preview: Rect | null = drag?.kind === 'draw'
    ? {
        x: Math.min(drag.start.x, drag.current.x),
        y: Math.min(drag.start.y, drag.current.y),
        w: Math.abs(drag.current.x - drag.start.x),
        h: Math.abs(drag.current.y - drag.start.y),
      }
    : null;

  const lockedOnPage = boxes.some((b) => lockedQids.has(b.qid));

  return (
    <div style={{ position: 'relative' }}>
      <div
        ref={stageRef}
        data-testid="split-stage"
        data-page={pageNo}
        style={{ position: 'relative', width: '100%', cursor: source ? 'crosshair' : 'progress' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
      >
        <canvas
          ref={canvasRef}
          data-testid="split-page-canvas"
          style={{
            width: '100%',
            height: stage ? `${stage.h}px` : 'auto',
            display: 'block',
            border: '1px solid var(--line)',
            background: 'var(--card)',
            touchAction: 'none',
          }}
        />
        {!source && (
          <div data-testid="split-page-pending" style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: 'var(--ink-2)' }}>
            第 {pageNo} 页栅格化中…
          </div>
        )}

        {/* 覆盖层：与位图同尺寸的绝对定位层，框按百分比定位（随容器缩放自动正确） */}
        {source && (
          <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
            {boxes.map((box) => {
              const locked = lockedQids.has(box.qid);
              const selected = box.id === selectedBoxId;
              const style = TYPE_STYLE[box.type];
              return (
                <div
                  key={box.id}
                  data-testid={`split-box-${box.id}`}
                  data-locked={locked ? 'true' : 'false'}
                  data-selected={selected ? 'true' : 'false'}
                  onPointerDown={(e) => onBoxPointerDown(e, box, 'move')}
                  style={{
                    position: 'absolute',
                    left: `${box.x * 100}%`,
                    top: `${box.y * 100}%`,
                    width: `${box.w * 100}%`,
                    height: `${box.h * 100}%`,
                    border: `${selected ? 2 : 1}px solid ${style.color}`,
                    background: selected ? `${style.color}22` : 'transparent',
                    boxSizing: 'border-box',
                    pointerEvents: 'auto',
                    cursor: locked ? 'not-allowed' : 'move',
                    opacity: locked ? 0.75 : 1,
                  }}
                >
                  <span
                    style={{
                      position: 'absolute', top: '-1.1em', left: 0, fontSize: '11px', whiteSpace: 'nowrap',
                      color: style.color, background: 'var(--card)', padding: '0 2px',
                    }}
                  >
                    {locked ? '🔒 ' : ''}{style.label}·{box.qid}
                  </span>
                  {selected && !locked && HANDLES.map((handle) => (
                    <span
                      key={handle}
                      data-testid={`split-handle-${box.id}-${handle}`}
                      onPointerDown={(e) => onBoxPointerDown(e, box, handle)}
                      style={{
                        position: 'absolute',
                        width: '8px',
                        height: '8px',
                        background: style.color,
                        [handle.includes('n') ? 'top' : 'bottom']: '-4px',
                        [handle.includes('w') ? 'left' : 'right']: '-4px',
                        ...(handle === 'n' || handle === 's' ? { left: '50%', marginLeft: '-4px' } : {}),
                        ...(handle === 'e' || handle === 'w' ? { top: '50%', marginTop: '-4px' } : {}),
                        cursor: 'nwse-resize',
                        pointerEvents: 'auto',
                      }}
                    />
                  ))}
                </div>
              );
            })}
            {preview && (
              <div
                data-testid="split-draw-preview"
                style={{
                  position: 'absolute',
                  left: `${preview.x * 100}%`,
                  top: `${preview.y * 100}%`,
                  width: `${preview.w * 100}%`,
                  height: `${preview.h * 100}%`,
                  border: `1px dashed ${TYPE_STYLE[drawType].color}`,
                  background: `${TYPE_STYLE[drawType].color}11`,
                }}
              />
            )}
          </div>
        )}
      </div>
      {lockedOnPage && (
        <div data-testid="split-lock-note" style={{ marginTop: '0.25rem', color: 'var(--ink-2)', fontSize: '12px' }}>
          本页有已识别完成的题，对应框已锁定；如需改框请先删除该题的识别结果。
        </div>
      )}
    </div>
  );
}

/** 覆盖层命中的框（供页面层做「点空白处取消选中」判定；与 canvas 层共用同一份 hitTest） */
export function pickBoxAt(boxes: SplitBox[], page: number, point: Point): SplitBox | null {
  return hitTest(boxes, page, point);
}

export { denormalizeRect, moveBox, normalizeRect };
