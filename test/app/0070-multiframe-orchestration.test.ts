// 0070（R-052）：多帧识别编排的模块级口径（帧序 / 一次调用 / 失败不静默）+ draftToCard 首帧溯源。
//
// 页面级链路（真裁图 + 真拼接器 + 真 WorkbenchPage）在 0070-multiframe-merge.test.tsx；
// 本文件把编排函数拉出来单测，覆盖错误路径与「谁调了谁、按什么顺序」这类页面测试不易断言的细节。
// @vitest-environment jsdom

import { describe, it, expect } from 'vitest';

import type { AiChatMessage, AiInvokePayload, AiInvokeResult } from '../../src/shared/contracts/ai-types.js';
import type { OnestepDraft, WorkbenchFrame } from '../../src/shared/contracts/onestep-types.js';
import type { CropOutcome, PageImageLike } from '../../src/app/workbench/crop.js';
import type { CroppedImage, StitchFn } from '../../src/app/splitting/run-launch.js';
import { draftToCard, makeFrame } from '../../src/recog/onestep/workbench.js';
import { recognizeStitchedFrames } from '../../src/app/workbench/multiframe.js';

const MAIN_JSON = JSON.stringify({
  questions: [{
    qno: '17', questionType: '解答', stemMarkdown: '跨页题：上半在上一页、下半在下一页。',
    options: null, answerMarkdown: null, analysisMarkdown: null, suggestedTags: [],
  }],
  figures: [],
});
const DSO_RAW = '<|ref|>text<|/ref|><|det|>[[1, 1, 2, 2]]<|/det|>';

function pageImage(pageNo: number): PageImageLike {
  return {
    naturalWidth: 1000, naturalHeight: 1400,
    source: { __page: pageNo } as unknown as CanvasImageSource, origin: 'memory',
  };
}

const FRAME_A: WorkbenchFrame = makeFrame('a', { pageNo: 1, rect: { x: 0, y: 0.5, w: 1, h: 0.5 } });
const FRAME_B: WorkbenchFrame = makeFrame('b', { pageNo: 2, rect: { x: 0, y: 0, w: 1, h: 0.25 } });

/** 记录式回放：主调用与 DSO 坐标腿按提示词分流，全量记录载荷 */
function replay(): { invoke: (payload: AiInvokePayload) => Promise<AiInvokeResult>; calls: Array<{ text: string; imageUrl: string }> } {
  const calls: Array<{ text: string; imageUrl: string }> = [];
  const invoke = async (payload: AiInvokePayload): Promise<AiInvokeResult> => {
    let text = '';
    let imageUrl = '';
    for (const message of payload.messages) {
      if (typeof message.content === 'string') {
        text += message.content;
        continue;
      }
      for (const part of message.content) {
        if (part.type === 'text') text += part.text;
        else imageUrl = part.imageUrl.url;
      }
    }
    calls.push({ text, imageUrl });
    const dso = text.includes('<|ref|>image<|/ref|>') || text.includes('Convert the document to markdown');
    return { ok: true, content: dso ? DSO_RAW : MAIN_JSON, latencyMs: 1 };
  };
  return { invoke, calls };
}

describe('0070 多帧识别编排（模块级）', () => {
  it('逐帧裁剪按 frames 数组序、每帧取自己的页与 rect；拼接恰一次、模型恰一次主调用', async () => {
    const croppedCalls: Array<{ page: string; rect: string }> = [];
    const stitchedParts: CroppedImage[][] = [];
    const replaying = replay();
    let stitchedSeq = 0;

    const outcome = await recognizeStitchedFrames({
      frames: [FRAME_A, FRAME_B],
      pageImageOf: (pageNo) => pageImage(pageNo),
      crop: (page, rect): CropOutcome => {
        croppedCalls.push({ page: String((page.source as { __page: number }).__page), rect: `${rect.x},${rect.y},${rect.w},${rect.h}` });
        return { ok: true, dataUrl: `data:image/png;base64,part${croppedCalls.length}`, width: 100, height: 50 };
      },
      stitch: async (parts): Promise<CroppedImage> => {
        stitchedParts.push(parts);
        stitchedSeq += 1;
        return { dataBase64: `stitched${stitchedSeq}`, mime: 'image/png' };
      },
      decode: async (): Promise<PageImageLike> => ({
        naturalWidth: 900, naturalHeight: 1042,
        source: {} as CanvasImageSource, origin: 'memory',
      }),
      mode: 'auto',
      invoke: replaying.invoke,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // 帧序 = 数组序、每帧自己的页号与 rect（跨页帧天然支持）
    expect(croppedCalls).toEqual([
      { page: '1', rect: '0,0.5,1,0.5' },
      { page: '2', rect: '0,0,1,0.25' },
    ]);
    expect(stitchedParts).toHaveLength(1);
    expect(stitchedParts[0]!.map((p) => p.dataBase64)).toEqual(['part1', 'part2']);
    // 拼接图尺寸进 outcome（回填裁图源的口径）
    expect(outcome.sentWidth).toBe(900);
    expect(outcome.sentHeight).toBe(1042);
    expect(outcome.sentImage.naturalWidth).toBe(900);
    expect(outcome.drafts).toHaveLength(1);
    expect(outcome.drafts[0]!.qno).toBe('17');
    // 送模型的就是拼接图（逐字节）
    const main = replaying.calls.find((c) => !c.text.includes('<|ref|>image<|/ref|>') && !c.text.includes('Convert the document to markdown'));
    expect(main?.imageUrl).toBe('data:image/png;base64,stitched1');
    const mainCalls = replaying.calls.filter((c) => !c.text.includes('<|ref|>image<|/ref|>') && !c.text.includes('Convert the document to markdown'));
    expect(mainCalls).toHaveLength(1);
  });

  it('某帧页图未就绪 → ok:false 且指明页号（零裁剪零模型调用）', async () => {
    const replaying = replay();
    let cropped = 0;
    const outcome = await recognizeStitchedFrames({
      frames: [FRAME_A, FRAME_B],
      pageImageOf: (pageNo) => (pageNo === 1 ? pageImage(1) : undefined),
      crop: (): CropOutcome => { cropped += 1; return { ok: true, dataUrl: 'data:image/png;base64,x', width: 1, height: 1 }; },
      stitch: async (): Promise<CroppedImage> => ({ dataBase64: 'x', mime: 'image/png' }),
      decode: async (): Promise<PageImageLike> => pageImage(1),
      mode: 'auto',
      invoke: replaying.invoke,
    });
    expect(outcome).toEqual({ ok: false, error: expect.stringContaining('第 2 页') });
    expect(cropped).toBe(1);     // 帧 1 已裁，帧 2 缺页即停（不硬凑）
    expect(replaying.calls).toHaveLength(0);
  });

  it('裁剪失败 / 拼接失败 → ok:false 透传人读原因（不静默产坏图）', async () => {
    const replaying = replay();
    const cropFail = await recognizeStitchedFrames({
      frames: [FRAME_A, FRAME_B],
      pageImageOf: (pageNo) => pageImage(pageNo),
      crop: (page): CropOutcome => (String((page.source as { __page: number }).__page) === '2'
        ? { ok: false, reason: '重开草稿的页图受浏览器安全限制不可导出' }
        : { ok: true, dataUrl: 'data:image/png;base64,a', width: 10, height: 10 }),
      stitch: async (): Promise<CroppedImage> => ({ dataBase64: 'x', mime: 'image/png' }),
      decode: async (): Promise<PageImageLike> => pageImage(1),
      mode: 'auto',
      invoke: replaying.invoke,
    });
    expect(cropFail.ok).toBe(false);
    if (!cropFail.ok) expect(cropFail.error).toContain('浏览器安全限制');

    const stitchFail = await recognizeStitchedFrames({
      frames: [FRAME_A, FRAME_B],
      pageImageOf: (pageNo) => pageImage(pageNo),
      crop: (): CropOutcome => ({ ok: true, dataUrl: 'data:image/png;base64,a', width: 10, height: 10 }),
      stitch: async (): Promise<CroppedImage> => { throw new Error('无法获取 canvas 2D 上下文'); },
      decode: async (): Promise<PageImageLike> => pageImage(1),
      mode: 'auto',
      invoke: replaying.invoke,
    });
    expect(stitchFail.ok).toBe(false);
    if (!stitchFail.ok) expect(stitchFail.error).toContain('拼接失败');
    expect(replaying.calls).toHaveLength(0);
  });

  it('模型失败 → ok:false 且带档位/原因（沿用既有失败文案口径）', async () => {
    const outcome = await recognizeStitchedFrames({
      frames: [FRAME_A, FRAME_B],
      pageImageOf: (pageNo) => pageImage(pageNo),
      crop: (): CropOutcome => ({ ok: true, dataUrl: 'data:image/png;base64,a', width: 10, height: 10 }),
      stitch: async (): Promise<CroppedImage> => ({ dataBase64: 'stitched', mime: 'image/png' }),
      decode: async (): Promise<PageImageLike> => pageImage(1),
      mode: 'auto',
      roles: { mainRole: 'reasoning', groundingRole: 'vision', label: 'reasoning 档 · deepseek-flash' },
      invoke: async (): Promise<AiInvokeResult> => ({ ok: false, error: 'HTTP 429：rate limited', latencyMs: 1 }),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain('reasoning 档 · deepseek-flash');
      expect(outcome.error).toContain('HTTP 429');
    }
  });
});

describe('0070 draftToCard 框溯源', () => {
  const draft: OnestepDraft = {
    qno: '17', questionType: '解答', stemMarkdown: '题干', options: null,
    answerMarkdown: null, analysisMarkdown: null, suggestedTags: [],
    figures: [], figureSource: 'none', warnings: [],
  };

  it('给 frames 选项 → question 卡保留全部框；缺省 → 空（既有调用点行为零变化）', () => {
    const both = draftToCard(draft, { id: 'c1', source: 'manual', pageNo: 1, frames: [FRAME_A, FRAME_B] });
    expect(both.frames.map((f) => f.id)).toEqual(['a', 'b']);

    const without = draftToCard(draft, { id: 'c2', source: 'manual', pageNo: 1 });
    expect(without.frames).toEqual([]);

    const empty = draftToCard(draft, { id: 'c3', source: 'manual', pageNo: 1, frames: [] });
    expect(empty.frames).toEqual([]);
  });

  it('帧数组按传入顺序原样落卡（帧序 = 框选/并入顺序，供左栏溯源框逐个画出）', () => {
    const card = draftToCard(draft, { id: 'c1', source: 'manual', pageNo: 1, frames: [FRAME_B, FRAME_A] });
    expect(card.frames.map((f) => f.id)).toEqual(['b', 'a']);
    expect(card.frames.map((f) => f.pageNo)).toEqual([2, 1]);
  });
});
