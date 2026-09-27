// 0036 P3：识别衔接单测（任务书 §四 TDD 第三项：框 → 裁剪小图 → run 创建参数断言，mock provider）
// 断言的是**交给 recog.run.create 的载荷本身**：一题一 run、只送裁剪小图、页序、sourceKind='pdf-split'、
// 素材名可溯源——这些错了会静默烧 token 或串页，比画框错更难发现。

import { describe, it, expect, vi } from 'vitest';
import { planQuestionRun, launchQuestionRun, type CroppedImage } from '../../src/app/splitting/run-launch.js';
import type { MofangRecogBridge } from '../../src/shared/contracts/bridge.js';
import type { RecogMaterial } from '../../src/shared/contracts/recog-run-types.js';
import type { SplitBox } from '../../src/shared/contracts/split-types.js';

const SIZES = new Map([[1, { w: 1000, h: 2000 }], [2, { w: 1000, h: 2000 }]]);

function box(id: string, qid: string, page: number, type: SplitBox['type'] = 'text'): SplitBox {
  return { id, qid, type, page, x: 0.1, y: 0.1, w: 0.5, h: 0.2 };
}

/** mock 裁剪器：把「页号 + 矩形」编码进假 PNG 字节，便于断言走的是哪一块 */
function makeCrop(seen: Array<{ page: number; w: number }> = []) {
  return async (page: number, rect: { x: number; y: number; w: number; h: number }): Promise<CroppedImage> => {
    seen.push({ page, w: rect.w });
    return { dataBase64: Buffer.from(`crop-p${page}-${rect.x}x${rect.y}`).toString('base64'), mime: 'image/png' };
  };
}

function makeRecog() {
  const create = vi.fn(async (_payload: { materials: RecogMaterial[]; sourceKind: string }) => ({ runId: 'run-1', pageCount: 1 }));
  return { bridge: { create } as unknown as MofangRecogBridge, create };
}

describe('0036 P3：一题一 run 的裁剪计划', () => {
  it('单页多框 → 一张裁剪图（题干+配图并集）', () => {
    const boxes = [box('p1-b1', 'q1', 1), box('p1-b2', 'q1', 1, 'image')];
    const plan = planQuestionRun(boxes, 'q1', SIZES);
    expect(plan.cards).toHaveLength(1);
    expect(plan.cards[0].page).toBe(1);
    expect(plan.materials).toEqual(['q1-p1.png']);
  });

  it('跨页题 → 仍按页出裁剪计划（页序升序），但**素材只有一张**（拼接后送）', () => {
    const boxes = [box('p2-b2', 'q1', 2, 'answer'), box('p1-b1', 'q1', 1)];
    const plan = planQuestionRun(boxes, 'q1', SIZES);
    // 页序升序仍是硬约束（拼接顺序 = 阅读顺序）
    expect(plan.cards.map((c) => c.page)).toEqual([1, 2]);
    // 2026-09-18 目检案底：跨页出两张素材 = 两次并发 vision 调用，免费通道极易翻车；
    // 改为本地拼成一张，模型一次看全题（也只算一次调用/一半 token）
    expect(plan.materials).toEqual(['q1-p1-2.png']);
  });

  it('别人的框不参与（一题一 run 不能被邻题污染）', () => {
    const boxes = [box('p1-b1', 'q1', 1), box('p1-b9', 'q2', 1)];
    expect(planQuestionRun(boxes, 'q1', SIZES).cards).toHaveLength(1);
  });

  it('没有框 / 页尺寸未知 → 拒绝并说明原因（宁可不发起，也不烧一次空识别）', () => {
    expect(() => planQuestionRun([], 'q1', SIZES)).toThrow(/没有可识别的框/);
    expect(() => planQuestionRun([box('p9-b1', 'q1', 9)], 'q1', SIZES)).toThrow(/页尺寸/);
  });
});

describe('0036 P3：发起识别（create 载荷断言）', () => {
  it('sourceKind=pdf-split、素材=裁剪小图、只送小图不送整页', async () => {
    const seen: Array<{ page: number; w: number }> = [];
    const { bridge, create } = makeRecog();
    const boxes = [box('p1-b1', 'q1', 1), box('p1-b2', 'q1', 1, 'image')];

    const out = await launchQuestionRun({
      boxes, qid: 'q1', pageSizes: SIZES, crop: makeCrop(seen), recog: bridge,
    });

    expect(out.runId).toBe('run-1');
    expect(create).toHaveBeenCalledTimes(1);
    const payload = create.mock.calls[0][0];
    expect(payload.sourceKind).toBe('pdf-split');
    expect(payload.materials).toHaveLength(1);
    expect(payload.materials[0]).toMatchObject({ name: 'q1-p1.png', mime: 'image/png' });
    // 送出去的字节确实是裁剪产物（不是整页）
    expect(Buffer.from(payload.materials[0].dataBase64, 'base64').toString()).toContain('crop-p1');
    expect(seen).toHaveLength(1);
  });

  it('跨页题：拼成一张素材（页号进名字，溯源能对上原 PDF 页）', async () => {
    const { bridge, create } = makeRecog();
    const boxes = [box('p1-b1', 'q1', 1), box('p2-b2', 'q1', 2, 'answer')];
    const stitched: string[] = [];
    await launchQuestionRun({
      boxes, qid: 'q1', pageSizes: SIZES, crop: makeCrop(), recog: bridge,
      stitch: async (parts) => {
        stitched.push(...parts.map((p) => Buffer.from(p.dataBase64, 'base64').toString()));
        return { dataBase64: Buffer.from('stitched').toString('base64'), mime: 'image/png' };
      },
    });
    const payload = create.mock.calls[0][0];
    expect(payload.materials).toHaveLength(1);
    expect(payload.materials[0].name).toBe('q1-p1-2.png');
    // 拼接的输入是**按页序**的两张裁剪图（顺序错了等于把答案接到题干前面）；
    // 只断言页序，不锁死留白后的像素原点（留白调整不该弄坏这条用例）
    expect(stitched.map((s) => s.split('-')[1])).toEqual(['p1', 'p2']);
    expect(Buffer.from(payload.materials[0].dataBase64, 'base64').toString()).toBe('stitched');
  });

  it('单页题不拼接（一次裁剪直接送，拼接器不该被调用）', async () => {
    const { bridge, create } = makeRecog();
    const stitch = vi.fn(async () => ({ dataBase64: 'X', mime: 'image/png' }));
    await launchQuestionRun({
      boxes: [box('p1-b1', 'q1', 1)], qid: 'q1', pageSizes: SIZES, crop: makeCrop(), recog: bridge, stitch,
    });
    expect(stitch).not.toHaveBeenCalled();
    expect(create.mock.calls[0][0].materials.map((m) => m.name)).toEqual(['q1-p1.png']);
  });

  it('跨页题未提供拼接器 → 明确报错（降级回两张素材会原样复现目检案底，故不允许静默降级）', async () => {
    const { bridge, create } = makeRecog();
    await expect(
      launchQuestionRun({
        boxes: [box('p1-b1', 'q1', 1), box('p2-b2', 'q1', 2)], qid: 'q1', pageSizes: SIZES,
        crop: makeCrop(), recog: bridge,
      }),
    ).rejects.toThrow(/拼接/);
    expect(create).not.toHaveBeenCalled();
  });

  it('拼接失败即整体失败：不发起 run（不留半张图的识别结果）', async () => {
    const { bridge, create } = makeRecog();
    await expect(
      launchQuestionRun({
        boxes: [box('p1-b1', 'q1', 1), box('p2-b2', 'q1', 2)], qid: 'q1', pageSizes: SIZES,
        crop: makeCrop(), recog: bridge,
        stitch: async () => {
          throw new Error('canvas 被回收');
        },
      }),
    ).rejects.toThrow(/拼接失败.*canvas 被回收/);
    expect(create).not.toHaveBeenCalled();
  });

  it('裁剪失败即整体失败：不发起 run，错误带页号', async () => {
    const { bridge, create } = makeRecog();
    const crop = async (page: number): Promise<CroppedImage> => {
      if (page === 2) throw new Error('canvas 被回收');
      return { dataBase64: 'AA==', mime: 'image/png' };
    };
    await expect(
      launchQuestionRun({
        boxes: [box('p1-b1', 'q1', 1), box('p2-b2', 'q1', 2)], qid: 'q1', pageSizes: SIZES, crop, recog: bridge,
      }),
    ).rejects.toThrow(/第 2 页/);
    expect(create).not.toHaveBeenCalled();
  });

  it('create 失败原样上抛（UI 据此显示错误，不吞）', async () => {
    const { bridge } = makeRecog();
    (bridge.create as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('没有可识别的图片素材'));
    await expect(
      launchQuestionRun({ boxes: [box('p1-b1', 'q1', 1)], qid: 'q1', pageSizes: SIZES, crop: makeCrop(), recog: bridge }),
    ).rejects.toThrow(/没有可识别的图片素材/);
  });
});
