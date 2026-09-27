// 0035 P2：公式栅格「行量取脚本」测试——纯函数产出可执行脚本，在 jsdom 真 DOM 上跑命中/度量。
// 背景（S-1 探针实测事故）：旧实现把 key 内插进 CSS 选择器 `.mf-row[data-key="<key>"]`，
// key 含反斜杠（TeX 常态，如 `\neq`/`\frac`）时经「CSS 转义 → JS 字符串字面量」两层后
// 选择器被改写为 `\n`(换行) 等字符转义 → 行查不到 → 该式静默判 `row-missing` 跳过
// （样例卷 15 式只成 4 式）。改为**按行序号取元素**（结构上与 key 内容无关）+ key 回读校验。
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { measureRowScript } from '../../src/docgen/export/docx/rasterize-measure.js';

interface Measured {
  key?: string;
  index?: number;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  error?: string;
}

/** 造一行（含 strut 并集与基线探针；rect 全部可控），返回该行元素 */
function makeRow(doc: Document, key: string, rect: { x: number; y: number; top: number; bottom: number; width: number }, struts: Array<{ top: number; bottom: number }>, baselineBottom: number): HTMLElement {
  const row = doc.createElement('div');
  row.className = 'mf-row';
  row.setAttribute('data-key', key);
  const bl = doc.createElement('span');
  bl.className = 'mf-bl';
  bl.getBoundingClientRect = () => ({ bottom: baselineBottom }) as DOMRect;
  const tex = doc.createElement('span');
  tex.className = 'mf-tex';
  const katex = doc.createElement('span');
  katex.className = 'katex';
  katex.getBoundingClientRect = () => ({ left: rect.x, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.bottom - rect.top }) as DOMRect;
  for (const s of struts) {
    const strut = doc.createElement('span');
    strut.className = 'strut';
    strut.getBoundingClientRect = () => ({ top: s.top, bottom: s.bottom }) as DOMRect;
    katex.appendChild(strut);
  }
  tex.appendChild(katex);
  row.appendChild(bl);
  row.appendChild(tex);
  row.scrollIntoView = () => {};
  doc.body.appendChild(row);
  return row;
}

/** 在 jsdom 里执行脚本（等价 webContents.executeJavaScript），返回解析后的测量结果 */
function runScript(script: string): Measured {
  return JSON.parse(new Function(`return ${script}`)() as string) as Measured;
}

let originalScrollIntoView: typeof Element.prototype.scrollIntoView;

beforeEach(() => {
  document.body.innerHTML = '';
  originalScrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  Element.prototype.scrollIntoView = originalScrollIntoView;
});

describe('0035 P2：行量取脚本（序号寻址，与 key 内容解耦）', () => {
  it('key 含反斜杠/冒号/引号（TeX 常态）仍能命中该行——旧 CSS 选择器实现此处静默 miss', () => {
    // 顺序：m（无转义）→ \frac（反斜杠）→ x\neq 1（反斜杠 + 空格）→ 带引号
    makeRow(document, 'inline:16:m', { x: 10, y: 10, top: 10, bottom: 24, width: 8 }, [{ top: 8, bottom: 26 }], 22);
    makeRow(document, 'inline:16:\\frac{1}{2}mv^2', { x: 12, y: 40, top: 40, bottom: 60, width: 60 }, [{ top: 36, bottom: 62 }], 56);
    const target = makeRow(document, 'inline:16:x\\neq 1', { x: 14, y: 70, top: 70, bottom: 86, width: 40 }, [{ top: 68, bottom: 88 }], 84);
    makeRow(document, 'display:16:"quoted"', { x: 16, y: 100, top: 100, bottom: 140, width: 90 }, [{ top: 96, bottom: 144 }], 140);

    const third = runScript(measureRowScript(2));
    expect(third.error).toBeUndefined();
    expect(third.key).toBe('inline:16:x\\neq 1');
    expect(third.x).toBe(14);
    expect(third.y).toBe(68); // strut 并集顶（比元素 rect.top 更贴行盒）
    expect(third.height).toBe(20); // strut 并集高（96…88 之外不取元素 rect）
    expect(third.depth).toBe(4); // 基线 84 → 盒底 88 = 4（行内式基线校正）
    // 目标行确实是被索引到的那一行（防止「命中隔壁行」的静默错位）
    expect(document.querySelectorAll('.mf-row')[2]).toBe(target);

    // 全部 4 行都能逐一命中（旧实现只有无转义的第 0 行能成）
    for (let i = 0; i < 4; i += 1) {
      expect(runScript(measureRowScript(i)).error).toBeUndefined();
    }
  });

  it('display 公式 depth 恒 0（无基线语义）', () => {
    const row = makeRow(document, 'display:16:\\int_0^1', { x: 0, y: 0, top: 0, bottom: 40, width: 100 }, [{ top: 0, bottom: 40 }], 30);
    row.setAttribute('data-display', '1');
    const measured = runScript(measureRowScript(0));
    expect(measured.depth).toBe(0);
  });

  it('越界序号 → 显式 row-missing（不静默返回 0 尺寸）', () => {
    makeRow(document, 'inline:16:m', { x: 0, y: 0, top: 0, bottom: 10, width: 5 }, [{ top: 0, bottom: 10 }], 8);
    const measured = runScript(measureRowScript(7));
    expect(measured.error).toBe('row-missing');
    expect(measured.width).toBe(0);
  });

  it('KaTeX 报错盒（.katex-error）→ 显式失败而非当作正常公式量取', () => {
    const row = document.createElement('div');
    row.className = 'mf-row';
    row.setAttribute('data-key', 'inline:16:\\bad{');
    const bl = document.createElement('span');
    bl.className = 'mf-bl';
    const err = document.createElement('span');
    err.className = 'katex-error';
    err.setAttribute('title', 'KaTeX parse error');
    row.appendChild(bl);
    row.appendChild(err);
    row.scrollIntoView = () => {};
    document.body.appendChild(row);

    const measured = runScript(measureRowScript(0));
    expect(measured.error).toBe('KaTeX parse error');
  });
});
