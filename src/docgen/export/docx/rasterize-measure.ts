// 0035 P2：公式行量取脚本（纯函数产出 → 主进程经 webContents.executeJavaScript 执行）。
// 单独成模块的理由（S-1 探针实测事故）：
//   旧实现按 key 内插 CSS 选择器 `[data-key="<key>"]`。TeX 常态含反斜杠（`\frac`/`\neq`），
//   经「CSS 转义 → JS 字符串字面量」两层后 `\n`/`\s` 等被当成**字符转义**，选择器被改写为
//   另一串字符 → 行查不到 → 该式静默判 row-missing 跳过（样例卷 15 式只成 4 式）。
//   现改为**按行序号寻址**（结构上与 key 内容无关），key 仅作回读校验与失败定位。
// 尺寸口径：strut 并集 = 行盒（KaTeX 自算，比元素 rect 并集干净——后者被字体 ascent/descent 撑大）；
// 基线 = 零尺寸 inline-block 探针底边；depth = 盒底 − 基线（display 式无基线语义，恒 0）。
// 输出恒为 JSON 字符串（executeJavaScript 结构化克隆的安全形态）。

/** 量取结果的对外形态（rasterize.ts 消费；error 存在时尺寸全 0） */
export interface RawMeasurement {
  key: string;
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  error?: string;
}

/**
 * 第 index 行的量取脚本（先滚动进视口再取坐标——截图只覆盖可视区）。
 * 越界/无 KaTeX 输出/KaTeX 报错盒均落 error 字段，调用方显式记账，不中断整卷。
 */
export function measureRowScript(index: number): string {
  return `(() => {
    const rows = document.querySelectorAll('.mf-row');
    const row = rows[${index}];
    const miss = (error) => JSON.stringify({ key: '', index: ${index}, x: 0, y: 0, width: 0, height: 0, depth: 0, error });
    if (!row) return miss('row-missing');
    row.scrollIntoView({ block: 'center' });
    const box = row.querySelector('.katex, .katex-error');
    if (!box) return miss('katex-no-output');
    if (box.classList.contains('katex-error')) return miss(box.getAttribute('title') || 'katex-error');
    const rect = box.getBoundingClientRect();
    const struts = Array.from(row.querySelectorAll('.strut')).map((element) => element.getBoundingClientRect());
    let top = rect.top;
    let bottom = rect.bottom;
    if (struts.length > 0) {
      top = Math.min.apply(null, struts.map((r) => r.top));
      bottom = Math.max.apply(null, struts.map((r) => r.bottom));
    }
    const probe = row.querySelector('.mf-bl');
    const baseline = probe ? probe.getBoundingClientRect().bottom : bottom;
    const display = row.getAttribute('data-display') === '1';
    return JSON.stringify({
      key: row.getAttribute('data-key') || '',
      index: ${index},
      x: rect.left,
      y: top,
      width: rect.width,
      height: bottom - top,
      depth: display ? 0 : Math.max(0, bottom - baseline),
    });
  })()`;
}
