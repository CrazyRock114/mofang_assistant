// C0: 图位标记解析 — <|ref|>image<|/ref|><|det|>[[x1,y1,x2,y2]]<|/det|> → OcrImageRef
// det 为两角坐标 [x1,y1,x2,y2]，bbox = {x:x1, y:y1, w:x2-x1, h:y2-y1}
// text/equation 等非 image 标记不产图，剥除即可

import type { OcrImageRef } from '../shared/contracts/recog-types.js';

const IMAGE_MARK_RE = /<\|ref\|>image<\|\/ref\|><\|det\|>\[\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]\]<\|\/det\|>/g;
const ANY_REF_MARK_RE = /<\|ref\|>[^<]*<\|\/ref\|>(<\|det\|>\[\[[^\]]*\]\]<\|\/det\|>)?/g;

/** 从 OCR 文本提取全部图位引用（按出现顺序，id 稳定：`p{pageNo}-img-{idx}`） */
export function extractImageRefs(text: string, pageNo: number): OcrImageRef[] {
  const refs: OcrImageRef[] = [];
  let idx = 0;
  for (const m of text.matchAll(IMAGE_MARK_RE)) {
    const x1 = Number(m[1]);
    const y1 = Number(m[2]);
    const x2 = Number(m[3]);
    const y2 = Number(m[4]);
    refs.push({
      id: `p${pageNo}-img-${idx++}`,
      pageNo,
      bbox: { x: x1, y: y1, w: x2 - x1, h: y2 - y1 },
    });
  }
  return refs;
}

export interface ImageMark {
  raw: string;
  bbox: { x: number; y: number; w: number; h: number };
}

/** 两 bbox 的交并比（IoU）；不相交为 0 */
export function bboxIoU(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  if (inter === 0) return 0;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

export function bboxEquals(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/** 从单行文本取出 image 标记（可能多个），返回标记与剥除全部 ref 标记后的剩余文本 */
export function extractImageMarksFromLine(line: string): { marks: ImageMark[]; rest: string } {
  const marks: ImageMark[] = [];
  for (const m of line.matchAll(IMAGE_MARK_RE)) {
    const x1 = Number(m[1]);
    const y1 = Number(m[2]);
    const x2 = Number(m[3]);
    const y2 = Number(m[4]);
    marks.push({ raw: m[0], bbox: { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } });
  }
  const rest = line.replace(ANY_REF_MARK_RE, '').trim();
  return { marks, rest };
}
