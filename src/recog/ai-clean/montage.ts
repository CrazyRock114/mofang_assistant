// 0056 目检返工⑦：公式靶「拼大图」——一题内多张公式图拼成**一张带编号的网格大图**，一次调用取回全部。
//
// 依据（线上实测经验 + 用户 2026-09-24 拍板）：
//   · 孤立小图缺上下文：`√(d/g)` 单张送模型会被读成 `√a`（d↔a 混淆），同题其他公式都含 d，拼在一起
//     模型能靠上下文自洽；
//   · 一次调用取代 N 次（成本/时延），且编号给了**可机械校验的对应关系**（缺号/重号/越界 → 判该次作废）。
//
// 本层纯函数零 IO：只算「怎么摆」与「怎么把回包按编号拆回来」。绘制在 `ai-clean-canvas-raster.ts`（canvas）。

/** 单次拼图的公式张数上限（超过则分片多次拼图；防单图过大导致缩放丢细节） */
export const MONTAGE_MAX_ITEMS = 8;
/** 行号字号（最终像素） */
export const MONTAGE_LABEL_PX = 44;
/** 行号列宽（最终像素；含行号与片段之间的空隙） */
export const MONTAGE_LABEL_COL_PX = 112;
/** 片段间距与画布边距（最终像素） */
export const MONTAGE_GAP_PX = 20;
export const MONTAGE_MARGIN_PX = 20;
/** 拼图长边上限（与送模型单图同口径） */
export const MONTAGE_MAX_LONG_EDGE_PX = 1800;
/**
 * 可拼片段的内容长边上限（<= 此值才进拼图）：大图（整页/大配图）留在单图路径按 1:1 送——
 * 一格里塞 1700px 的整图会把整张拼图拖到上限、其余公式被连坐缩小。
 *
 * 取值 520：图片准备层产出的**小图**长边上限是 408（内容 300 + 两侧留白 54×2），
 * 而「原样过桥」的大图长边 > 400 —— 两档在 401~408 处重叠，故阈值必须高于 408 才不误伤小图。
 */
export const MONTAGE_MAX_FRAGMENT_LONG_EDGE_PX = 520;

export interface MontageFragmentSize {
  width: number;
  height: number;
}

/** 拼图排版（全部为最终像素；`scale` <1 = 超上限后整体收敛） */
export interface MontagePlan {
  cols: number;
  rows: number;
  /** 片段格尺寸（不含行号列） */
  cellWidth: number;
  cellHeight: number;
  /** 行号列宽 */
  labelCol: number;
  gap: number;
  margin: number;
  scale: number;
  width: number;
  height: number;
}

/**
 * 算拼图排版：列数取 ⌈√n⌉（3 张以内单行），格尺寸取各片段最大值（不重采样片段本身），
 * 超长边上限则整体等比收敛。
 */
export function planMontage(sizes: MontageFragmentSize[], maxLongEdgePx: number = MONTAGE_MAX_LONG_EDGE_PX): MontagePlan {
  const count = Math.max(1, sizes.length);
  const cols = count <= 3 ? count : Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const cellWidth = Math.max(1, ...sizes.map((size) => Math.max(1, Math.round(size.width))));
  const cellHeight = Math.max(1, ...sizes.map((size) => Math.max(1, Math.round(size.height))));
  const rawWidth = MONTAGE_MARGIN_PX * 2 + cols * (MONTAGE_LABEL_COL_PX + cellWidth) + (cols - 1) * MONTAGE_GAP_PX;
  const rawHeight = MONTAGE_MARGIN_PX * 2 + rows * cellHeight + (rows - 1) * MONTAGE_GAP_PX;
  const longEdge = Math.max(rawWidth, rawHeight);
  const scale = longEdge > maxLongEdgePx ? maxLongEdgePx / longEdge : 1;
  return {
    cols,
    rows,
    cellWidth,
    cellHeight,
    labelCol: MONTAGE_LABEL_COL_PX,
    gap: MONTAGE_GAP_PX,
    margin: MONTAGE_MARGIN_PX,
    scale,
    width: Math.round(rawWidth * scale),
    height: Math.round(rawHeight * scale),
  };
}

/** 把待拼片段切成 ≤max 的若干片（片序 = 原序；片内序 = 原序） */
export function chunkMontage<T>(items: T[], max: number = MONTAGE_MAX_ITEMS): T[][] {
  const size = Math.max(1, max);
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

/** 拼图回包的解析结果：行号（1 起）→ LaTeX 文本 */
export type MontageRows = Map<number, string>;

/** 去代码围栏（模型偶尔回 ```latex … ```） */
function stripFence(raw: string): string {
  const fenced = /^\s*```[a-zA-Z]*\s*\n?([\s\S]*?)\n?\s*```\s*$/.exec(raw);
  return fenced ? (fenced[1] ?? '') : raw;
}

/**
 * 「像公式」的最低要求（**只用于无编号的按行序兜底**）：含 LaTeX 命令 / 上下标 / 括号 / 数字 / 运算符之一。
 * 编号形态不需要它——编号本身是可校验的对应关系，内容好坏由幻觉闸门与骨架校验管。
 * 有序兜底没有对应关系可校验，若再放过 `banana` 这种纯词，就会把垃圾写进 data-tex。
 */
function looksLikeFormula(text: string): boolean {
  return /\\[a-zA-Z]+|[{}^_$]|[=<>≤≥≈±+\-*/×÷]|\d/.test(text);
}

/**
 * 解析拼图回包（**要求与 `count` 严格对齐**，否则返回 null = 整片作废走单图兜底）。
 * 接受两种形态：
 *   ① 编号形态（首选，可校验）——逐行 `1: \frac{d}{4}`（冒号/顿号/点/右括号分隔均可）；
 *   ② 纯行序形态（模型忘了编号时的兜底）——恰 `count` 行非空且无编号 → 按行序对齐，`ordered=true` 报出。
 */
export function parseMontageRows(raw: string, count: number): { rows: MontageRows; ordered: boolean } | null {
  if (count <= 0) return null;
  const text = stripFence(String(raw ?? ''));
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length === 0) return null;

  const numbered = new Map<number, string>();
  const unnumbered: string[] = [];
  for (const line of lines) {
    const match = /^\(?\[?(\d{1,3})\]?[)）.:：、\-]\s*(.+)$/.exec(line);
    if (match) {
      const key = Number(match[1]);
      const value = (match[2] ?? '').trim();
      if (!Number.isFinite(key) || key < 1 || key > count || value === '') return null;
      if (numbered.has(key)) return null;      // 重号 → 作废
      numbered.set(key, value);
      continue;
    }
    unnumbered.push(line);
  }

  if (numbered.size === count) return { rows: numbered, ordered: false };
  if (numbered.size === 0 && unnumbered.length === count && unnumbered.every(looksLikeFormula)) {
    return { rows: new Map(unnumbered.map((value, index) => [index + 1, value])), ordered: true };
  }
  return null;                                  // 缺号/混排/行数不符/兜底行不像公式 → 作废
}
