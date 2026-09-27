// 0004-fix-2 F2-B/D：排版间页内预览 iframe（srcdoc=引擎产物 + 交互层注入脚本）。
// 纸张物理宽按 96dpi 换算，窗口容纳不下 → transform 等比缩放整纸可见 + 外层纵向滚动；
// 内容高度由注入脚本 postMessage（mf-preview-ready/mf-height）上报，父层驱动 iframe 高度。
// 本组件不解析引擎产物语义，只负责装载/缩放/消息转发（业务 reducer 在 preview-frame-protocol.ts）。
// 0004-fix-3 P1-1（目检 #3）：纸感视口——外露灰边≥24px、缩放控件（−/+/适应/100%+百分比）、
// Ctrl+滚轮缩放、overflowX auto（放大后横滚）。

import { useCallback, useEffect, useRef, useState } from 'react';
import { parsePreviewMessage, type PreviewFrameMessage } from './preview-frame-protocol.js';

/** mm → px（96dpi 标准换算） */
export function mmToPx(mm: number): number {
  return (mm * 96) / 25.4;
}

/** 视口外露灰边（px；任务书 P1-1 ≥24px） */
export const PREVIEW_VIEWPORT_PAD = 24;
/** 缩放倍率界限 */
const ZOOM_MIN = 0.3;
const ZOOM_MAX = 3;
const ZOOM_STEP = 1.1;
/** 高度上报后静默多久才显示纸（防「首报偏小 → 跳一次」与纸内滚动条闪现；与 300ms srcdoc 防抖同量级） */
const HEIGHT_SETTLE_MS = 150;

export interface PaperPreviewFrameProps {
  /** 完整 srcdoc（引擎 buildPaperHtml 产物 + injectPreviewScript 注入） */
  html: string;
  /** 取向换算后的纸宽 mm（缩放基准） */
  pageWidthMm: number;
  /** 业务消息回调（ready/height 在组件内消费，不透传） */
  onMessage: (msg: PreviewFrameMessage) => void;
  testid?: string;
  /** fix-4 2.1：视图模式（paged=块级装箱纸流 / continuous=连续单流）；缺省 paged */
  viewMode?: 'paged' | 'continuous';
  /** fix-4 2.1：视图切换回调（父层据此重建注入产物——页化在注入脚本内完成） */
  onViewModeChange?: (mode: 'paged' | 'continuous') => void;
}

/** 缩放值收窄（纯函数，导出供单测）：倍率钳到 [ZOOM_MIN, ZOOM_MAX] 并保留两位小数 */
export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value)) * 100) / 100;
}

/** 步进缩放（纯函数，导出供单测）：dir=+1 放大 / −1 缩小，从当前倍率乘/除步进系数 */
export function stepZoom(current: number, dir: 1 | -1): number {
  return clampZoom(dir === 1 ? current * ZOOM_STEP : current / ZOOM_STEP);
}

/**
 * 0004-fix-4 #1：Ctrl+滚轮/触控板捏合缩放（纯函数，导出供单测）。
 * 触控板捏合在 Chromium 中同样以 ctrlKey=true 的 wheel 事件投递；deltaY<0=放大。
 */
export function wheelZoom(current: number, deltaY: number): number {
  return stepZoom(current, deltaY < 0 ? 1 : -1);
}

export function PaperPreviewFrame({ html, pageWidthMm, onMessage, testid, viewMode = 'paged', onViewModeChange }: PaperPreviewFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [docHeight, setDocHeight] = useState(0);
  /** 缩放状态机：'fit'=适应窗口（随容器宽联动）；数值=手动倍率 */
  const [zoomMode, setZoomMode] = useState<'fit' | number>('fit');
  const [containerW, setContainerW] = useState(0);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;
  /** 缩放模式镜像（原生 wheel 监听为稳定回调，经 ref 取当前值，避免反复挂摘） */
  const zoomModeRef = useRef<'fit' | number>(zoomMode);
  zoomModeRef.current = zoomMode;

  // 容器宽变化 → 记录（适应模式下换算缩放；手动模式不变）。
  // 0011 §一.8：改 ResizeObserver 监听容器自身——侧栏折叠/窗口拖动/布局列宽变化都触发 fit 重算
  // （旧实现只挂 window resize，侧栏折叠不改窗口尺寸 → 预览不重排）。jsdom 等无 ResizeObserver
  // 环境回落 window resize（功能等价降级，仅影响测试/旧内核）。
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (typeof ResizeObserver === 'undefined') {
      const update = () => {
        setContainerW(el.clientWidth);
      };
      update();
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }
    const observer = new ResizeObserver(() => {
      setContainerW(el.clientWidth);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const paperPx = mmToPx(pageWidthMm);
  const availW = Math.max(0, containerW - PREVIEW_VIEWPORT_PAD * 2);
  const fitScale = paperPx > 0 && availW > 0 ? Math.min(1, availW / paperPx) : 1;
  const scale = zoomMode === 'fit' ? fitScale : zoomMode;
  const fitScaleRef = useRef(fitScale);
  fitScaleRef.current = fitScale;

  // Ctrl+滚轮/捏合缩放（React 合成 wheel 为 passive，preventDefault 须原生监听）。
  // fix-4 #1（目检 #1）：监听必须挂到**两个**目标——①容器灰边区（纸外滚轮）；
  // ②iframe 内文档（srcdoc 同源）的 contentWindow——iframe 内的手势事件不跨文档冒泡到容器，
  // 只挂容器时纸面上 Ctrl+双指/捏合完全无响应（旧实现 bug）。iframe 每次 srcDoc 重建都会换文档，
  // 故在 onLoad 里重新挂载（旧监听成对摘除，无泄漏）。
  const applyWheelZoom = useCallback((e: WheelEvent) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const cur = zoomModeRef.current === 'fit' ? fitScaleRef.current : zoomModeRef.current;
    setZoomMode(wheelZoom(cur, e.deltaY));
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener('wheel', applyWheelZoom, { passive: false });
    return () => el.removeEventListener('wheel', applyWheelZoom);
  }, [applyWheelZoom]);

  const detachFrameWheel = useRef<(() => void) | null>(null);
  /** iframe 装载完成 → 在 iframe 文档上挂 Ctrl+滚轮（同源 srcdoc；跨域受限时静默保留容器监听） */
  const attachFrameWheel = useCallback(() => {
    detachFrameWheel.current?.();
    detachFrameWheel.current = null;
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    try {
      win.addEventListener('wheel', applyWheelZoom, { passive: false });
      detachFrameWheel.current = () => win.removeEventListener('wheel', applyWheelZoom);
    } catch {
      /* 受限环境（跨域）：容器监听仍可用 */
    }
  }, [applyWheelZoom]);

  useEffect(() => () => {
    detachFrameWheel.current?.();
    detachFrameWheel.current = null;
  }, []);

  // iframe → 父层消息（限定 source 为本 iframe，协议白名单收窄）
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const msg = parsePreviewMessage(event.data);
      if (!msg) return;
      if (msg.t === 'mf-preview-ready' || msg.t === 'mf-height') {
        setDocHeight(Math.max(200, Math.ceil(msg.height)));
        return;
      }
      onMessageRef.current(msg);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  const shownHeight = docHeight || 900;

  /**
   * 0052 目检追加二（用户反馈「刚进排版页时纸上有滚动条，一瞬间后消失」）：高度未落定前不显示纸。
   * 机理：iframe 缺省高 900，而文档实高由注入脚本上报（首报可能在图/字体就位前偏小，随后被
   * ResizeObserver 修正）——这段窗口里 iframe 内部文档比 iframe 高 → **纸内滚动条闪一下**。
   * 门控=最近一次上报后静默 HEIGHT_SETTLE_MS 才显示（高度不再跳变才算落定），期间整块不可见，
   * 用户看到的是「纸一次性以正确尺寸出现」，而不是先错尺寸再跳一版。
   * **一次性**：首次落定后不再隐藏——编辑期纸高变化很常见，二次门控会让预览每改一下闪一次。
   */
  const [heightSettled, setHeightSettled] = useState(false);
  useEffect(() => {
    if (docHeight <= 0) return;
    const timer = window.setTimeout(() => setHeightSettled(true), HEIGHT_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [docHeight]);

  return (
    <div className="preview-frame-root">
      {/* 缩放工具栏（fix-3 P1-1；0018 目检返工一：根挂 preview-frame-root，列内占满、纸面容器自身内滚） */}
      <div
        data-testid="preview-zoom-toolbar"
        style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.4rem', fontSize: '0.85rem' }}
      >
        <button
          data-testid="preview-zoom-out"
          title="缩小"
          onClick={() => setZoomMode(stepZoom(zoomMode === 'fit' ? fitScale : zoomMode, -1))}
        >
          −
        </button>
        <span data-testid="preview-zoom-label" style={{ minWidth: 48, textAlign: 'center', color: 'var(--ink-2)' }}>
          {Math.round(scale * 100)}%
        </span>
        <button
          data-testid="preview-zoom-in"
          title="放大"
          onClick={() => setZoomMode(stepZoom(zoomMode === 'fit' ? fitScale : zoomMode, 1))}
        >
          +
        </button>
        <button
          data-testid="preview-zoom-fit"
          onClick={() => setZoomMode('fit')}
          style={zoomMode === 'fit' ? { fontWeight: 'bold', color: 'var(--orange-deep)' } : undefined}
        >
          适应
        </button>
        <button
          data-testid="preview-zoom-100"
          onClick={() => setZoomMode(1)}
          style={zoomMode === 1 ? { fontWeight: 'bold', color: 'var(--orange-deep)' } : undefined}
        >
          100%
        </button>
        <span style={{ color: 'var(--ink-3)', fontSize: '0.78rem' }}>Ctrl+滚轮缩放 · 放大后可横向滚动</span>
        {onViewModeChange && (
          <>
            <span style={{ flex: 1 }} />
            <button
              data-testid="preview-view-paged"
              onClick={() => onViewModeChange('paged')}
              style={viewMode === 'paged' ? { fontWeight: 'bold', borderColor: 'var(--orange)', color: 'var(--orange-deep)' } : undefined}
              title="分页视图：按页高块级装箱，纸间分界可见（近似，精确分页以导出 PDF 为准）"
            >
              分页视图
            </button>
            <button
              data-testid="preview-view-continuous"
              onClick={() => onViewModeChange('continuous')}
              style={viewMode === 'continuous' ? { fontWeight: 'bold', borderColor: 'var(--orange)', color: 'var(--orange-deep)' } : undefined}
              title="连续视图：单流长纸（无分页纸流）"
            >
              连续视图
            </button>
          </>
        )}
      </div>
      <div
        ref={containerRef}
        data-testid={testid ?? 'compose-paper-preview'}
        data-page-width-mm={pageWidthMm}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          overflowX: 'auto',
          backgroundColor: 'var(--paper-deep)',
          border: '1px solid var(--line-strong)',
          borderRadius: '4px',
          padding: `${PREVIEW_VIEWPORT_PAD}px`,
          boxSizing: 'border-box',
        }}
      >
      {/* 0052 目检追加（用户 2026-09-22 拍板「修预览区滚动条」）：缩放用 transform 只改视觉、不改 iframe 的
          布局盒（布局盒恒为未缩放的 纸宽×内容高）——包裹盒若不裁剪，父容器就按未缩放盒算滚动范围：
          适配档也冒横向滚动条、上下/左右能多滚一截空档，且容器滚动条会压在纸的可视右缘上（真机实测：
          容器 scrollW 818 vs clientW 577，80% 态垂直可多滚 219px）。
          故包裹盒：① 尺寸=视觉尺寸（精确值不取整，取整会让盒比纸小半像素反切掉纸边）；② 裁掉未缩放布局盒；
          ③ 阴影移到包裹盒（盒=视觉尺寸，不被自己裁掉；留在被裁的 iframe 上会切掉下沿阴影）。 */}
      <div
        style={{
          width: paperPx * scale,
          height: shownHeight * scale,
          margin: '0 auto',
          overflow: 'hidden',
          boxShadow: '0 1px 4px rgba(0,0,0,0.18)',
          // 高度落定前整块不可见（含 iframe 与阴影）——见 heightSettled 注释
          visibility: heightSettled ? 'visible' : 'hidden',
        }}
      >
        <iframe
          ref={iframeRef}
          data-testid="compose-preview-iframe"
          title="卷面实时预览"
          srcDoc={html}
          onLoad={attachFrameWheel}
          style={{
            width: paperPx,
            height: shownHeight,
            border: 'none',
            backgroundColor: '#FDFDFC',
            transform: `scale(${scale})`,
            transformOrigin: '0 0',
          }}
        />
      </div>
      </div>
    </div>
  );
}
