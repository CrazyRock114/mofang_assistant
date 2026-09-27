// 0045 P2：图片选中态浮动条（块级 figureNode 与行内 inlineFigure 共用）。
//
// 参照成熟案例（设计初稿 v1.2 §0）：Word Online / Google Docs 图片选中浮动工具条。
// 2026-09-21 目检返工（用户复查①②）重做：
//   - **操作菜单放到图片上方**（`bottom: calc(100% + 8px)`）且 `width: max-content` 不换行——
//     原实现的条被可用宽度挤到 150px 宽、换行成 81px 高并**压在图片下半部**，用户"再点一下图片"
//     就会点到条上的按钮（命中过「删除」→ 图片被误删；命中过「尺寸」→ 弹出像素输入框）。
//   - **删除改两步确认**（首点变「确认删除」，3 秒内再点才真删；失焦/换选自动复位）——防误删兜底。
//   - **去掉「输入像素数调尺寸」按钮**（用户口径：尺寸只走拖拽缩放，即右下角拖柄）；
//     原「尺寸」位改为 **「预览」**（放大看图，点任意处关闭）——预览从"点击即放大"降为菜单选项。

import type { Editor } from '@tiptap/core';

export interface FigureBarOptions {
  editor: Editor;
  getPos: () => number | undefined;
  /** 当前节点形态：block = 单独成行（figureNode）；inline = 串在文中（inlineFigure） */
  mode: 'block' | 'inline';
  /** 当前图片 src（预览用） */
  getSrc: () => string;
}

export interface FigureBarHandle {
  dom: HTMLElement;
  /** 形态/状态同步（选中态切换时由 NodeView 调用） */
  refresh(): void;
  /** 复位（取消选中/节点更新时调用）：解除删除确认待确认态 */
  reset(): void;
}

/** 图片放大预览（就地覆盖层；点任意处 / Esc 关闭） */
export function openImagePreview(src: string): void {
  if (!src) return;
  const mask = document.createElement('div');
  mask.className = 'qe-fig-preview-mask';
  mask.setAttribute('data-testid', 'qe-fig-preview');
  const img = document.createElement('img');
  img.src = src;
  mask.appendChild(img);
  const close = (): void => {
    mask.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };
  mask.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    close();
  });
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(mask);
}

export function createFigureBar(options: FigureBarOptions): FigureBarHandle {
  const { editor, getPos, mode, getSrc } = options;

  const dom = document.createElement('div');
  dom.className = 'qe-fig-bar';
  dom.setAttribute('contenteditable', 'false');

  const toInline = document.createElement('button');
  toInline.type = 'button';
  toInline.className = 'qe-fig-act qe-fig-to-inline';
  toInline.textContent = '串在文中';
  toInline.title = '让图片随文字串行（行内小图）';

  const toBlock = document.createElement('button');
  toBlock.type = 'button';
  toBlock.className = 'qe-fig-act qe-fig-to-block';
  toBlock.textContent = '单独成行';
  toBlock.title = '让图片独占一行（块级配图）';

  const preview = document.createElement('button');
  preview.type = 'button';
  preview.className = 'qe-fig-act qe-fig-preview';
  preview.textContent = '预览';
  preview.title = '放大查看这张图';

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'qe-fig-act qe-fig-del';
  del.textContent = '删除';
  del.title = '删除图片（需再点一次确认）';

  dom.append(toInline, toBlock, preview, del);

  // 防误触（第五轮）：条上的按钮只在**按下与抬起都发生在条上**时才响应。
  // 若按下点在被选中的图片上、抬起时落到了刚弹出的条上（或条在指针下突然出现），
  // 即便 click 的目标是条上按钮，两项校验有一项不满足 → 一律不动作、并复位。
  // 彻底杀掉「点图片 → 第二击命中删除/预览」这一整类误触。
  let pressedInside = false;
  let releasedOnBar = false;
  dom.addEventListener('mousedown', () => {
    pressedInside = true;
  });
  dom.addEventListener('mouseup', () => {
    releasedOnBar = true;
  });
  /** 包一层：校验 + 复位（每次 click 后两标志都归零，语义等价"这次点击必须完整发生在条上"） */
  const guarded = (fn: (e: MouseEvent) => void) => (e: MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    const ok = pressedInside && releasedOnBar;
    pressedInside = false;
    releasedOnBar = false;
    if (ok) fn(e);
  };

  const runForPos = (run: (pos: number) => boolean): void => {
    const pos = getPos();
    if (typeof pos === 'number') {
      editor.view.focus();
      run(pos);
    }
  };

  toInline.addEventListener('click', guarded((e) => {
    e.preventDefault();
    if (mode === 'block') {
      runForPos((pos) => editor.commands.figureNodeToInline(pos));
    }
  }));
  toBlock.addEventListener('click', guarded((e) => {
    e.preventDefault();
    if (mode === 'inline') {
      runForPos((pos) => editor.commands.inlineFigureToBlock(pos));
    }
  }));
  preview.addEventListener('click', guarded((e) => {
    e.preventDefault();
    openImagePreview(getSrc());
  }));

  // 删除：两步确认（防误删——返工②根因引子即"第二击落在条上"）
  let armed = false;
  let armTimer: number | null = null;
  const disarm = (): void => {
    armed = false;
    del.textContent = '删除';
    del.classList.remove('armed');
    if (armTimer !== null) {
      window.clearTimeout(armTimer);
      armTimer = null;
    }
  };
  del.addEventListener('click', guarded((e) => {
    e.preventDefault();
    if (!armed) {
      armed = true;
      del.textContent = '确认删除';
      del.classList.add('armed');
      armTimer = window.setTimeout(disarm, 3000);
      return;
    }
    disarm();
    runForPos((pos) =>
      mode === 'block' ? editor.commands.removeFigureNode(pos) : editor.commands.removeInlineFigure(pos),
    );
  }));

  const refresh = (): void => {
    toInline.classList.toggle('cur', mode === 'inline');
    toBlock.classList.toggle('cur', mode === 'block');
    if (mode === 'inline') toInline.setAttribute('disabled', 'disabled');
    else toInline.removeAttribute('disabled');
    if (mode === 'block') toBlock.setAttribute('disabled', 'disabled');
    else toBlock.removeAttribute('disabled');
  };
  refresh();

  return {
    dom,
    refresh,
    reset: disarm,
  };
}
