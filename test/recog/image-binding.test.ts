// C1 Phase 5 清偿：rule.ts 图块绑定由「顺序对齐死代码」改为真实 bbox 匹配（D7）
// 探针：构造非全等 bbox 用例验证就近绑定 + 回退

import { describe, it, expect } from 'vitest';

import type { OcrImageRef } from '../../src/shared/contracts/recog-types.js';
import { createRuleSegmenter } from '../../src/recog/segmentation/rule.js';

function imageMark(x1: number, y1: number, x2: number, y2: number): string {
  return `<|ref|>image<|/ref|><|det|>[[${x1},${y1},${x2},${y2}]]<|/det|>`;
}

function makeRef(id: string, x: number, y: number, w: number, h: number): OcrImageRef {
  return { id, pageNo: 1, bbox: { x, y, w, h } };
}

describe('图块绑定（bbox 匹配 + 顺序回退）', () => {
  it('引用顺序与标记出现顺序不一致且 bbox 非全等 → 按 IoU 就近绑定', () => {
    // 两个标记先后出现；refs 顺序刻意颠倒且坐标轻微偏移（非全等）
    const text = ['1. 题面', imageMark(100, 100, 200, 200), imageMark(500, 500, 600, 600)].join('\n');
    const imageRefs = [makeRef('p1-img-0', 505, 505, 100, 100), makeRef('p1-img-1', 98, 98, 100, 100)];

    const seg = createRuleSegmenter().segment(text, { pageNo: 1, imageRefs });
    expect(seg.questions).toHaveLength(1);
    // 顺序对齐会给出 ['p1-img-0','p1-img-1']；bbox 就近绑定应纠正为：
    expect(seg.questions[0].imageRefIds).toEqual(['p1-img-1', 'p1-img-0']);
    const imageBlocks = seg.questions[0].blocks.filter((b) => b.type === 'image');
    expect(imageBlocks.map((b) => b.imageRefId)).toEqual(['p1-img-1', 'p1-img-0']);
  });

  it('标记与任何引用都无重叠 → 回退顺序对齐（取首个未消费引用）', () => {
    // mark1 远离所有引用（IoU=0）；mark2 靠近 p1-img-1
    const text = ['1. 题面', imageMark(0, 0, 10, 10), imageMark(500, 500, 600, 600)].join('\n');
    const imageRefs = [makeRef('p1-img-0', 900, 900, 50, 50), makeRef('p1-img-1', 498, 498, 100, 100)];

    const seg = createRuleSegmenter().segment(text, { pageNo: 1, imageRefs });
    const imageBlocks = seg.questions[0].blocks.filter((b) => b.type === 'image');
    // mark1 回退绑定 p1-img-0（首个未消费）；mark2 IoU 就近绑定 p1-img-1
    expect(imageBlocks.map((b) => b.imageRefId)).toEqual(['p1-img-0', 'p1-img-1']);
  });

  it('bbox 全等 → 精确绑定（既有行为不变）', () => {
    const text = ['1. 题面', imageMark(100, 100, 200, 200)].join('\n');
    const imageRefs = [makeRef('p1-img-0', 100, 100, 100, 100)];

    const seg = createRuleSegmenter().segment(text, { pageNo: 1, imageRefs });
    const imageBlocks = seg.questions[0].blocks.filter((b) => b.type === 'image');
    expect(imageBlocks.map((b) => b.imageRefId)).toEqual(['p1-img-0']);
  });
});
