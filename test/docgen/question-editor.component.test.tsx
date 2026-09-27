// @vitest-environment jsdom

// 0045 · QuestionEditor 组件级测试（任务书 §四：新增组件级 jsdom 测试，当前为零，本单补齐）。
// 覆盖：挂载/工具条符号化（ƒx/🖼/✓/💾 带 tooltip、无锁定按钮）/受控插入 API（P1）/粘贴图片（P2）/
// ƒx 直弹可视化公式弹层并插入（P3）。mathlive 以 vi.mock 替身注入（jsdom 不承载真键盘）。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { act } from 'react';

import { QuestionEditor, type QuestionEditorApi } from '../../src/docgen/editor/QuestionEditor';
// mathlive 替身（vi.mock 提升到顶层；测试内直接取替身实例断言）
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { MathfieldElement as FakeMathfieldElementClass } from 'mathlive';

// mathlive 替身：MathfieldElement 记录 value/focus/insert，可被读回（确认时取 value 存 tex；
// 点符号面板走 insert/executeCommand）
vi.mock('mathlive', () => {
  class FakeMathfieldElement {
    static instances: FakeMathfieldElement[] = [];
    value = '';
    style: Record<string, string> = {};
    inserts: string[] = [];
    commands: string[] = [];
    constructor() {
      FakeMathfieldElement.instances.push(this);
    }
    insert(s: string): boolean {
      this.inserts.push(s);
      this.value = `${this.value}${s}`;
      return true;
    }
    executeCommand(cmd: string): boolean {
      this.commands.push(cmd);
      if (cmd === 'deleteBackward') this.value = this.value.slice(0, -1);
      return true;
    }
    focus(): void {}
    addEventListener(): void {}
  }
  return { MathfieldElement: FakeMathfieldElement };
});

const SAMPLE = '<div class="question"><p>质量为 <span class="math" data-tex="m"></span> 的物体。</p></div>';
const IMG_DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';
const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

// jsdom 无布局：ProseMirror 的坐标换算/滚动（scrollToSelection → coordsAtPos → singleRect）
// 会摸 Node/Range 的盒模型 API，缺实现会抛未处理异常——补空实现
// （仅测试环境；返回零矩形，坐标无意义但通路不炸）
const ZERO_RECT = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
for (const proto of [Node.prototype, Range.prototype] as const) {
  const p = proto as unknown as Record<string, unknown>;
  if (typeof p['getClientRects'] !== 'function') {
    Object.defineProperty(proto, 'getClientRects', { value: () => [], configurable: true, writable: true });
  }
  if (typeof p['getBoundingClientRect'] !== 'function') {
    Object.defineProperty(proto, 'getBoundingClientRect', { value: () => ZERO_RECT, configurable: true, writable: true });
  }
}

let container: HTMLElement;
let root: Root | null = null;

function mountEditor(initialContent = '', onSave?: (html: string) => void, refCb?: (api: QuestionEditorApi | null) => void): void {
  flushSync(() => {
    root!.render(
      <QuestionEditor ref={refCb} initialContent={initialContent} onSave={onSave} />,
    );
  });
}

function q(testid: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testid}"]`);
}

/** 向编辑器内容区派发伪造 paste 事件（jsdom 无 DataTransfer 图片通道，与 0043 同款直接 dispatch 手法） */
function firePaste(target: HTMLElement, file: File): void {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData?: unknown };
  Object.defineProperty(event, 'clipboardData', {
    value: { files: [file], items: [], getData: () => '' },
  });
  target.dispatchEvent(event);
}

/** 真实点击序列（mousedown → mouseup → click）：
 *  浮动条按钮要求"指针确实按在条上"才响应（第五轮防误触），单发 click 不再生效 */
function pressClick(el: Element): void {
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container.remove();
});

describe('0045：QuestionEditor 组件级', () => {
  it('工具条（题面）：ƒx/图片/表格/插入选项/💾 带 tooltip；无插入答案块/锁定/锁位置/导出契约', () => {
    mountEditor();
    expect(q('qe-btn-math')?.textContent).toBe('ƒx');
    expect(q('qe-btn-math')?.getAttribute('title')).toBe('插入公式');
    // 0045 目检返工⑥：图片按钮改标准风景照图标（内联 SVG，不再是 emoji）
    expect(q('qe-btn-figure')?.getAttribute('title')).toBe('插入图片');
    expect(q('qe-btn-figure')?.querySelector('svg')).not.toBeNull();
    // 0045 目检返工④：表格按钮
    expect(q('qe-btn-table')?.getAttribute('title')).toBe('插入表格');
    expect(q('qe-btn-table')?.querySelector('svg')).not.toBeNull();
    // 0045 目检返工③：题面有「插入选项」；答案块按钮移除
    expect(q('qe-btn-options')?.getAttribute('title')).toBe('插入选项');
    expect(q('qe-btn-answer')).toBeNull();
    expect(q('qe-btn-save')?.textContent).toBe('💾');
    expect(q('qe-btn-save')?.getAttribute('title')).toBe('存回题库');
    const texts = Array.from(container.querySelectorAll('button')).map((b) => b.textContent ?? '');
    expect(texts.join('|')).not.toContain('锁定');
    expect(texts.join('|')).not.toContain('锁位置');
    expect(texts.join('|')).not.toContain('导出契约');
  });

  it('工具条（答案/解析 variant=plain）：有公式/图片/表格，无「插入选项」', () => {
    flushSync(() => {
      root!.render(<QuestionEditor variant="plain" />);
    });
    expect(q('qe-btn-math')).not.toBeNull();
    expect(q('qe-btn-figure')).not.toBeNull();
    expect(q('qe-btn-table')).not.toBeNull();
    expect(q('qe-btn-options')).toBeNull();
  });

  it('目检返工③：点「插入选项」落 A~D 四行选项区块；重复插入被拒', () => {
    mountEditor(SAMPLE);
    const btn = q('qe-btn-options');
    expect(btn).not.toBeNull();
    act(() => {
      btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const options = container.querySelector('.question-editor-content .options');
    expect(options).not.toBeNull();
    const rows = container.querySelectorAll('.question-editor-content .options .option');
    expect(rows).toHaveLength(4);
    expect(Array.from(rows).map((r) => (r.textContent ?? '').replace(/✕$/, ''))).toEqual(['A. ', 'B. ', 'C. ', 'D. ']);
    // 已有选项区 → 再次点击不再叠加（题面只有一个选项区）
    act(() => {
      btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.querySelectorAll('.question-editor-content .options')).toHaveLength(1);
  });

  it('目检返工④：点「插入表格」先出尺寸面板（几行几列），选 3×3 落带表头表格', () => {
    mountEditor(SAMPLE);
    const btn = q('qe-btn-table');
    expect(btn).not.toBeNull();
    act(() => {
      btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // 先出尺寸选择面板（不是直接插表）
    const picker = q('qe-table-picker');
    expect(picker).not.toBeNull();
    expect(container.querySelector('.question-editor-content table')).toBeNull();
    expect(q('qe-table-picker-caption')?.textContent).toBe('拖动选择行列');
    // 悬停 3 行 × 3 列 → 悬浮提示显示行列数（React onMouseEnter 由 mouseover 合成）→ 点选落表
    const cell = q('qe-table-cell-3-3');
    expect(cell).not.toBeNull();
    act(() => {
      cell!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: null }));
    });
    expect(q('qe-table-picker-caption')?.textContent).toBe('3 行 × 3 列');
    act(() => {
      cell!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(q('qe-table-picker')).toBeNull(); // 选完即关
    const table = container.querySelector('.question-editor-content table');
    expect(table).not.toBeNull();
    expect(table!.querySelectorAll('tr')).toHaveLength(3);
    expect(table!.querySelectorAll('th')).toHaveLength(3);
    expect(table!.querySelectorAll('td')).toHaveLength(6);
  });

  it('第五轮：表格面板下方「行 × 列」数字输入 + 插入（大表格不用划格子）', () => {
    mountEditor(SAMPLE);
    act(() => {
      q('qe-btn-table')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(q('qe-table-picker')).not.toBeNull();
    const rowsInput = q('qe-table-rows') as HTMLInputElement;
    const colsInput = q('qe-table-cols') as HTMLInputElement;
    expect(rowsInput).not.toBeNull();
    expect(colsInput).not.toBeNull();
    expect(q('qe-table-insert')).not.toBeNull();
    act(() => {
      // React 受控 input：需走原生 value setter 再派发 input，React 才读到新值
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(rowsInput, '5');
      rowsInput.dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(colsInput, '2');
      colsInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      q('qe-table-insert')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(q('qe-table-picker')).toBeNull();
    const table = container.querySelector('.question-editor-content table');
    expect(table).not.toBeNull();
    expect(table!.querySelectorAll('tr')).toHaveLength(5);
    expect(table!.querySelectorAll('th')).toHaveLength(2);
    expect(table!.querySelectorAll('td')).toHaveLength(8);
  });

  it('目检返工⑤/④：showSave=false 隐藏工具条保存钮（题库弹层统一保存）；minHeight 生效', () => {
    flushSync(() => {
      root!.render(<QuestionEditor showSave={false} minHeight={246} />);
    });
    expect(q('qe-btn-save')).toBeNull();
    // 编辑区滚动容器的 minHeight 生效（编辑器根 → 上溯找带 min-height 的容器）
    let el: HTMLElement | null = container.querySelector('.question-editor-content');
    let found: HTMLElement | null = null;
    while (el && !found) {
      if (el.style.minHeight) found = el;
      el = el.parentElement;
    }
    expect(found?.style.minHeight).toBe('246px');
  });

  it('目检返工①②：图片操作菜单=成行⇄串文/预览/删除（两步确认），无像素尺寸输入', async () => {
    const FIG_SAMPLE = `<div class="question"><p>见图</p><figure class="diagram" data-align="center" data-w="300" data-h="200"><img class="q-figure" src="${IMG_DATA_URL}"></figure></div>`;
    mountEditor(FIG_SAMPLE);
    const fig = container.querySelector('.question-editor-content figure.diagram');
    expect(fig).not.toBeNull();
    const bar = fig!.querySelector('.qe-fig-bar');
    expect(bar).not.toBeNull();
    const acts = [...bar!.querySelectorAll('.qe-fig-act')].map((b) => b.textContent);
    expect(acts).toEqual(['串在文中', '单独成行', '预览', '删除']);
    // 像素数值输入已删除（用户：尺寸只走拖拽缩放）
    expect(bar!.querySelector('.qe-fig-size-input')).toBeNull();
    expect(bar!.querySelector('.qe-fig-size')).toBeNull();

    // 预览：点「预览」出放大层，点遮罩关闭
    act(() => {
      pressClick(bar!.querySelector('.qe-fig-preview')!);
    });
    const mask = container.ownerDocument.querySelector('[data-testid="qe-fig-preview"]');
    expect(mask).not.toBeNull();
    expect(mask!.querySelector('img')?.getAttribute('src')).toBe(IMG_DATA_URL);
    act(() => {
      mask!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.ownerDocument.querySelector('[data-testid="qe-fig-preview"]')).toBeNull();

    // 防误触（第五轮）：只派发 click（无 mousedown，等价"按下在图片上、抬起落在条上"）→ 不动作
    const previewBtn = bar!.querySelector<HTMLButtonElement>('.qe-fig-preview')!;
    act(() => {
      previewBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(container.ownerDocument.querySelector('[data-testid="qe-fig-preview"]')).toBeNull();

    // 删除：两步确认——首点只进入待确认（图还在），二点才真删
    const del = bar!.querySelector<HTMLButtonElement>('.qe-fig-del')!;
    act(() => {
      pressClick(del);
    });
    expect(del.textContent).toBe('确认删除');
    expect(container.querySelectorAll('.question-editor-content figure.diagram')).toHaveLength(1);
    act(() => {
      pressClick(del);
    });
    expect(container.querySelectorAll('.question-editor-content figure.diagram')).toHaveLength(0);
  });

  it('挂载载入 initialContent， onSave 输出契约 HTML（兼容存量行为）', () => {
    const saved: string[] = [];
    mountEditor(SAMPLE, (html) => saved.push(html));
    expect(container.querySelector('.question-editor-content')?.textContent).toContain('的物体');
    const saveBtn = q('qe-btn-save');
    expect(saveBtn).not.toBeNull();
    act(() => {
      saveBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toContain('class="question"');
    expect(saved[0]).toContain('data-tex="m"');
  });

  it('P1 受控插入 API：insertHtml / insertFigure / insertInlineFigure', () => {
    let api: QuestionEditorApi | null = null;
    mountEditor(SAMPLE, undefined, (a) => {
      api = a;
    });
    expect(api).not.toBeNull();

    act(() => {
      api!.insertHtml('<p>受控插入的段落</p>');
    });
    expect(container.querySelector('.question-editor-content')?.textContent).toContain('受控插入的段落');

    act(() => {
      api!.insertFigure({ src: 'data:image/png;base64,BLK=', w: 220, h: 120 });
    });
    expect(container.querySelectorAll('figure.diagram img.q-figure')).toHaveLength(1);

    act(() => {
      api!.insertInlineFigure({ src: 'data:image/png;base64,INL=', w: 56, h: 20 });
    });
    expect(container.querySelectorAll('span.inline-figure img.q-figure')).toHaveLength(1);
  });

  it('P2 Ctrl+V 粘贴图片进题干（image/* → 行内图）', async () => {
    mountEditor();
    const contentEl = container.querySelector('.question-editor-content');
    expect(contentEl).not.toBeNull();
    const file = new File([PNG_BYTES], 'clip.png', { type: 'image/png' });
    act(() => {
      firePaste(contentEl!, file);
    });
    // FileReader 异步：轮询等待落点（固定 sleep 在负载下会假红）
    await act(async () => {
      await vi.waitFor(() => {
        if (container.querySelectorAll('span.inline-figure img.q-figure').length < 1) {
          throw new Error('粘贴未落编辑器');
        }
      }, { timeout: 5000, interval: 20 });
    });
    const imgs = container.querySelectorAll<HTMLImageElement>('span.inline-figure img.q-figure');
    expect(imgs.length).toBeGreaterThanOrEqual(1);
    expect(imgs[0]!.getAttribute('src')?.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('P3 点 ƒx 直弹可视化公式弹层，确认后插入 mathInline（全程无 LaTeX 输入框）', async () => {
    let api: QuestionEditorApi | null = null;
    mountEditor(SAMPLE, undefined, (a) => {
      api = a;
    });

    act(() => {
      q('qe-btn-math')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // 动态 import('mathlive') 为异步：让替身模块装载完成（跨宏/微任务）
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    const popup = q('qe-math-popup');
    expect(popup).not.toBeNull();
    // 弹层文案面向「点符号即输」，不出现要求输入 LaTeX 的提示
    expect(popup!.textContent).toContain('点符号');
    expect(popup!.textContent).not.toContain('LaTeX');

    // 往替身 mathfield 写值 → 点「插入」→ mathInline 落文档、弹层关闭
    const MFE = FakeMathfieldElementClass as unknown as { instances: Array<{ value: string }> };
    MFE.instances[MFE.instances.length - 1]!.value = 'x^2+y^2';

    act(() => {
      q('qe-math-confirm')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(q('qe-math-popup')).toBeNull();
    // 断言契约输出（编辑器 DOM 呈现的是 KaTeX 可视化结果，data-tex 在契约 HTML 里）
    expect(api!.getHtml()).toContain('data-tex="x^2+y^2"');
  });

  it('P3 返工②：弹层三重关闭——点弹层外（mousedown）/ ✕ 按钮 / Esc 都能关，且点外不阻断该次点击', async () => {
    mountEditor(SAMPLE);

    // (1) 点弹层外（document 捕获 mousedown，不 preventDefault）——该次点击照常作用于下层元素
    act(() => {
      q('qe-btn-math')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(q('qe-math-popup')).not.toBeNull();
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    let outsideClicked = 0;
    outside.addEventListener('click', () => (outsideClicked += 1));
    act(() => {
      outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      outside.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(q('qe-math-popup')).toBeNull();
    expect(outsideClicked).toBe(1); // 点外关闭不吞点击
    outside.remove();

    // (2) ✕ 按钮关闭
    act(() => {
      q('qe-btn-math')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(q('qe-math-popup')).not.toBeNull();
    act(() => {
      q('qe-math-close')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(q('qe-math-popup')).toBeNull();

    // (3) Esc（document 级捕获）关闭
    act(() => {
      q('qe-btn-math')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(q('qe-math-popup')).not.toBeNull();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(q('qe-math-popup')).toBeNull();
  });

  it('P3 返工②：紧凑符号面板（五页签 + 点键插符号），无 mathlive 大键盘', async () => {
    mountEditor(SAMPLE);
    act(() => {
      q('qe-btn-math')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const popup = q('qe-math-popup')!;
    // 五页签：常用/运算符/希腊/函数/上下标
    const tabs = [...popup.querySelectorAll('.qe-math-tab')].map((t) => t.textContent);
    expect(tabs).toEqual(['常用', '运算符', '希腊', '函数', '上下标']);
    // 面板键帽（6 列小格）——不是整宽大键盘
    const keysGrid = q('qe-math-keys')!;
    expect(keysGrid.querySelectorAll('.qe-math-key').length).toBeGreaterThanOrEqual(18);

    // 点「÷」→ 替身 mathfield 收到 \div；切到希腊页签点 α → 收到 \alpha
    const fake = FakeMathfieldElementClass as unknown as { instances: Array<{ value: string; inserts: string[] }> };
    const mf = fake.instances[fake.instances.length - 1]!;

    const divKey = [...keysGrid.querySelectorAll<HTMLButtonElement>('.qe-math-key')].find((k) => k.textContent === '÷');
    expect(divKey).toBeTruthy();
    act(() => {
      divKey!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(mf.inserts).toContain('\\div');

    const greekTab = [...popup.querySelectorAll<HTMLButtonElement>('.qe-math-tab')].find((t) => t.textContent === '希腊');
    act(() => {
      greekTab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const alphaKey = [...q('qe-math-keys')!.querySelectorAll<HTMLButtonElement>('.qe-math-key')].find((k) => k.textContent === 'α');
    expect(alphaKey).toBeTruthy();
    act(() => {
      alphaKey!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(mf.inserts).toContain('\\alpha');
  });

  it('P3 返工②：单击公式不再弹窗；双击公式进编辑态改该公式；ƒx 选中公式即编辑', async () => {
    let api: QuestionEditorApi | null = null;
    mountEditor(SAMPLE, undefined, (a) => {
      api = a;
    });
    const mathView = container.querySelector('.question-editor-content .math-view');
    expect(mathView).not.toBeNull();

    // 单击：不弹（正常文本编辑）
    act(() => {
      mathView!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(q('qe-math-popup')).toBeNull();

    // 双击：进编辑态（弹层打开，改 tex 后确认 → 原节点更新）
    act(() => {
      mathView!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(q('qe-math-popup')).not.toBeNull();
    const fake = FakeMathfieldElementClass as unknown as { instances: Array<{ value: string }> };
    fake.instances[fake.instances.length - 1]!.value = 'm_0';
    act(() => {
      q('qe-math-confirm')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(api!.getHtml()).toContain('data-tex="m_0"');

    // ƒx：弹层再开为插入态（SAMPLE 里公式已被选中与否都走插入，不破坏既有编辑路径）
    act(() => {
      q('qe-btn-math')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(q('qe-math-popup')).not.toBeNull();
    act(() => {
      q('qe-math-cancel')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(q('qe-math-popup')).toBeNull();
  });
});
