// 0043：手动框选后四动作按钮点不了（fix）——按下落在叠加层（草稿框动作条/已入列标记框/图块框）
// 内部时，页元素处理器不得把它当成「起新框」抢走（preventDefault + setPointerCapture 在真实浏览器
// 里会把后续 click 重定向到捕获元素，按钮永远收不到）。
// 复现形态说明（任务书 §四）：jsdom 不实现 setPointerCapture（HTMLElement 原型上 undefined，实测），
// 指针重定向吞噬 click 的完整路径模拟不出——`fireEvent.click` 直达按钮属消息层假绿；故按任务书预设
// 形态锁行为：直接向按钮/标记框 dispatch pointerdown，断言「未起新拖拽（wb-frame-dragging 不出现）
// 且 click 动作照常可达」。修复前的 RED 观察点 = 按钮上的 pointerdown 冒泡到页元素起了新拖拽。
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { act } from 'react';

import type { WorkbenchPage, WorkbenchRect } from '../../src/shared/contracts/onestep-types.js';
import type { PageImageLike } from '../../src/app/workbench/crop.js';
import {
  SourcePane,
  frameActionBarBottomOffset,
  type FrameActionPayload,
  type SourceFigureMark,
  type SourceFrameMark,
} from '../../src/app/workbench/SourcePane.js';

let container: HTMLElement;
let root: Root | null = null;

const PAGE: WorkbenchPage = { pageNo: 1, name: '第 1 页', width: 1000, height: 1400 };

/** 拖框起点/终点（页内归一化 (0.1, 1/7) → (0.5, 4/7)） */
const DRAG_FROM = { clientX: 100, clientY: 200 };
const DRAG_TO = { clientX: 500, clientY: 800 };

function pointer(type: string, x: number, y: number): MouseEvent {
  return new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
}

interface PaneSpies {
  onFrameAction: ReturnType<typeof vi.fn<(action: 'toNew' | 'mergeLatest' | 'copy' | 'discard', payload: FrameActionPayload) => void>>;
  onFigureChange: ReturnType<typeof vi.fn<(cardId: string, index: number, rect: WorkbenchRect) => void>>;
  onFigureDrag: ReturnType<typeof vi.fn<(cardId: string, index: number, rect: WorkbenchRect | null) => void>>;
}

function renderPane(marks?: { frameMarks?: SourceFrameMark[]; figureMarks?: SourceFigureMark[] }): PaneSpies {
  const spies: PaneSpies = {
    onFrameAction: vi.fn(),
    onFigureChange: vi.fn(),
    onFigureDrag: vi.fn(),
  };
  flushSync(() => {
    root!.render(
      <SourcePane
        pages={[PAGE]}
        pageUrls={new Map<number, string>()}
        pageImages={new Map<number, PageImageLike>()}
        frameMarks={marks?.frameMarks ?? []}
        figureMarks={marks?.figureMarks ?? []}
        onFrameAction={spies.onFrameAction}
        onFigureChange={spies.onFigureChange}
        onFigureDrag={spies.onFigureDrag}
      />,
    );
  });
  return spies;
}

function q<T extends Element>(testid: string): T | null {
  return container.querySelector<T>(`[data-testid="${testid}"]`);
}

function click(el: Element | null): void {
  if (!el) throw new Error('找不到可点元素');
  flushSync(() => { (el as HTMLElement).click(); });
}

/** 框选模式：开 ✂ → 在页面上拖出框 → 草稿框（四动作条）就位 */
async function drawDraft(): Promise<void> {
  click(q('wb-frame-toggle'));
  const page = q('wb-page-1')!;
  await act(async () => {
    page.dispatchEvent(pointer('pointerdown', DRAG_FROM.clientX, DRAG_FROM.clientY));
    window.dispatchEvent(pointer('pointermove', DRAG_TO.clientX, DRAG_TO.clientY));
    window.dispatchEvent(pointer('pointerup', DRAG_TO.clientX, DRAG_TO.clientY));
  });
}

/** 断言拖出的草稿框几何（页内归一化）与动作条四按钮齐备 */
function expectDraftReady(): void {
  expect(q('wb-frame-draft')).not.toBeNull();
  expect(q('wb-frame-to-new')).not.toBeNull();
  expect(q('wb-frame-merge')).not.toBeNull();
  expect(q('wb-frame-copy')).not.toBeNull();
  expect(q('wb-frame-discard')).not.toBeNull();
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  root?.unmount();
  root = null;
  container.remove();
});

describe('0043：叠加层内部按下放行（动作条/标记框/图块框不被当成起新框）', () => {
  it('「✓ 加入右侧待识别」：按下不起新拖拽，click 动作可达且草稿清除', async () => {
    const spies = renderPane();
    await drawDraft();
    expectDraftReady();

    await act(async () => { q('wb-frame-to-new')!.dispatchEvent(pointer('pointerdown', 150, 250)); });
    expect(q('wb-frame-dragging')).toBeNull();   // 修复前：冒泡到页元素起了新拖拽

    click(q('wb-frame-to-new'));
    expect(spies.onFrameAction).toHaveBeenCalledTimes(1);
    expect(spies.onFrameAction).toHaveBeenCalledWith('toNew', {
      pageNo: 1,
      rect: {
        x: expect.closeTo(0.1, 5),
        y: expect.closeTo(200 / 1400, 4),
        w: expect.closeTo(0.4, 5),
        h: expect.closeTo(600 / 1400, 4),
      },
    });
    expect(q('wb-frame-draft')).toBeNull();      // draftRect 正常清除
  });

  it('「↩ 并入最新待识别题」：按下不起新拖拽，click 动作可达', async () => {
    const spies = renderPane();
    await drawDraft();
    expectDraftReady();

    await act(async () => { q('wb-frame-merge')!.dispatchEvent(pointer('pointerdown', 150, 250)); });
    expect(q('wb-frame-dragging')).toBeNull();

    click(q('wb-frame-merge'));
    expect(spies.onFrameAction).toHaveBeenCalledTimes(1);
    expect(spies.onFrameAction.mock.calls[0]![0]).toBe('mergeLatest');
    expect(q('wb-frame-draft')).toBeNull();
  });

  it('「📋 复制」：按下不起新拖拽，click 动作可达', async () => {
    const spies = renderPane();
    await drawDraft();
    expectDraftReady();

    await act(async () => { q('wb-frame-copy')!.dispatchEvent(pointer('pointerdown', 150, 250)); });
    expect(q('wb-frame-dragging')).toBeNull();

    click(q('wb-frame-copy'));
    expect(spies.onFrameAction).toHaveBeenCalledTimes(1);
    expect(spies.onFrameAction.mock.calls[0]![0]).toBe('copy');
    expect(q('wb-frame-draft')).toBeNull();
  });

  it('「✕」：按下不起新拖拽，click 只清草稿不上抛动作', async () => {
    const spies = renderPane();
    await drawDraft();
    expectDraftReady();

    await act(async () => { q('wb-frame-discard')!.dispatchEvent(pointer('pointerdown', 150, 250)); });
    expect(q('wb-frame-dragging')).toBeNull();

    click(q('wb-frame-discard'));
    expect(spies.onFrameAction).not.toHaveBeenCalled();
    expect(q('wb-frame-draft')).toBeNull();
  });

  it('点已入列的「待识别」标记框（框选模式开着）：不原地冒出新框', async () => {
    renderPane({
      frameMarks: [{ id: 'f1', pageNo: 1, rect: { x: 0.2, y: 0.3, w: 0.2, h: 0.1 }, kind: 'pending' }],
    });
    click(q('wb-frame-toggle'));                 // 与现场一致：框选模式下点标记框
    await act(async () => { q('wb-frame-mark-f1')!.dispatchEvent(pointer('pointerdown', 300, 450)); });
    expect(q('wb-frame-dragging')).toBeNull();   // 修复前：标记框上起了一个新拖拽
    expect(q('wb-frame-draft')).toBeNull();
  });

  it('点锁定图块框（框选模式开着；locked 早退没有 stopPropagation）：不起新拖拽', async () => {
    renderPane({
      figureMarks: [{
        cardId: 'c1', index: 0, pageNo: 1,
        rect: { x: 0.2, y: 0.3, w: 0.2, h: 0.1 },
        adjusted: false, source: 'dso', locked: true,
      }],
    });
    click(q('wb-frame-toggle'));
    await act(async () => { q('wb-figure-c1-0')!.dispatchEvent(pointer('pointerdown', 300, 450)); });
    expect(q('wb-frame-dragging')).toBeNull();
  });

  it('回归锁：按下落在页面上（叠加层之外）仍正常起新框——判据不误杀框选', async () => {
    renderPane();
    click(q('wb-frame-toggle'));
    await act(async () => { q('wb-page-1')!.dispatchEvent(pointer('pointerdown', DRAG_FROM.clientX, DRAG_FROM.clientY)); });
    expect(q('wb-frame-dragging')).not.toBeNull();
  });
});

describe('0043 返工①：动作条贴近页底时钳回页元素内（.wb-src-page overflow:hidden 会裁掉越界部分）', () => {
  it('纯函数：框在页中部→维持默认悬挂 30px；贴近页底→钳到剩余空间；框底贴页底→缩进框内；页高未知→兜底默认', () => {
    const H = 1109;
    expect(frameActionBarBottomOffset(0.5, H)).toBe(30);          // 中部：room=552.5，不钳
    expect(frameActionBarBottomOffset(0.99, H)).toBe(9);          // 贴底：room=9.09，钳到 9
    expect(frameActionBarBottomOffset(1, H)).toBe(-2);            // 底边贴页底：缩进框内仍可见
    expect(frameActionBarBottomOffset(0.5, 0)).toBe(30);          // 页高未知：兜底默认
  });

  it('接线：拖出框后动作条带行内 bottom，值随框位置变化（贴底框的条不再悬到页外）', async () => {
    renderPane();
    click(q('wb-frame-toggle'));
    const page = q('wb-page-1')!;
    // 框画在页面上半部（中部）：默认悬挂
    await act(async () => {
      page.dispatchEvent(pointer('pointerdown', 100, 200));
      window.dispatchEvent(pointer('pointermove', 500, 700));
      window.dispatchEvent(pointer('pointerup', 500, 700));
    });
    const bar = q('wb-frame-draft')!.querySelector<HTMLElement>('.wb-fb-act')!;
    const midStyle = bar.style.bottom;
    expect(midStyle).not.toBe('');

    // 新框画到页底：bottom 被钳小（≤ 贴底余量），不悬出页元素
    click(q('wb-frame-toggle'));                       // 关掉清草稿
    click(q('wb-frame-toggle'));                       // 重开
    await act(async () => {
      page.dispatchEvent(pointer('pointerdown', 100, 1300));
      window.dispatchEvent(pointer('pointermove', 500, 1399));
      window.dispatchEvent(pointer('pointerup', 500, 1399));
    });
    const bottomBar = q('wb-frame-draft')!.querySelector<HTMLElement>('.wb-fb-act')!;
    expect(Number.parseFloat(bottomBar.style.bottom)).toBeLessThan(Number.parseFloat(midStyle));
  });
});

describe('0046 目检返工①：第二次拖框仍实时预览（节流器收尾 cancel 不停用）', () => {
  it('第一框收尾后，第二框拖动中预览框实时更新、松手草稿就位（修复前 dispose 把节流器永久停用）', async () => {
    renderPane();
    await drawDraft();
    expectDraftReady();
    click(q('wb-frame-discard')!);            // 丢第一框
    const page = q('wb-page-1')!;
    await act(async () => {
      page.dispatchEvent(pointer('pointerdown', 100, 200));
      window.dispatchEvent(pointer('pointermove', 400, 500));
    });
    const dragging = q('wb-frame-dragging');
    expect(dragging).not.toBeNull();          // 修复前：节流器已 dispose，拖动中预览不再出现
    await act(async () => {
      window.dispatchEvent(pointer('pointerup', 400, 500));
    });
    expectDraftReady();                       // 第二框收尾照常落草稿
  });

  it('三连拖：每次松手后节流器仍可用（cancel 语义回归锁）', async () => {
    renderPane();
    await drawDraft();
    expectDraftReady();
    for (let round = 0; round < 2; round++) {
      click(q('wb-frame-discard')!);
      const page = q('wb-page-1')!;
      await act(async () => {
        page.dispatchEvent(pointer('pointerdown', 120, 220));
        window.dispatchEvent(pointer('pointermove', 420, 520));
        window.dispatchEvent(pointer('pointerup', 420, 520));
      });
      expectDraftReady();
    }
  });
});
