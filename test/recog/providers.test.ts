// 0028 P1：vision OCR provider 收编（经 ai.invoke，不直连 fetch、不持 Key）
// 原 C0/C1 siliconflow 直 fetch provider 已拆除；本文件为其替代者契约 + MockOcrProvider 回归
// 任务书 §一 P1「收编：vision 配置源读 model_profiles；siliconflow 直 fetch 路径拆除」

import { describe, it, expect, vi } from 'vitest';

import type { OcrPageResult } from '../../src/shared/contracts/recog-types.js';
import type { AiInvokePayload, AiInvokeResult } from '../../src/shared/contracts/ai-types.js';
import { MockOcrProvider } from '../../src/recog/providers/mock.js';
import { createVisionOcrProvider, VISION_OCR_PROMPT } from '../../src/recog/providers/vision.js';

function okProvider(content: string, usage?: { promptTokens: number; completionTokens: number; totalTokens: number }) {
  const invoke = vi.fn(async (_p: AiInvokePayload): Promise<AiInvokeResult> => ({
    ok: true, content, latencyMs: 12, ...(usage ? { usage } : {}),
  }));
  return { invoke, provider: createVisionOcrProvider({ invoke }) };
}

describe('MockOcrProvider', () => {
  const pages: OcrPageResult[] = [
    { pageNo: 1, text: '第一页', images: [] },
    {
      pageNo: 2,
      text: '第二页 <|ref|>image<|/ref|><|det|>[[1,2,5,9]]<|/det|>',
      images: [{ id: 'p2-img-0', pageNo: 2, bbox: { x: 1, y: 2, w: 4, h: 7 } }],
      model: 'mock-model',
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    },
  ];

  it('按页码回放对应 OcrPageResult', async () => {
    const provider = new MockOcrProvider(pages);
    expect(provider.name).toBe('mock');

    const result = await provider.ocrPage({ data: Buffer.alloc(0), pageNo: 2 });
    expect(result).toEqual(pages[1]);
  });

  it('夹具缺页时抛错', async () => {
    const provider = new MockOcrProvider(pages);
    await expect(provider.ocrPage({ data: Buffer.alloc(0), pageNo: 99 })).rejects.toThrow('夹具中无第 99 页');
  });
});

describe('0028 P1：vision provider 请求构造', () => {
  it('按 vision 角色走 ai.invoke：图 data URL 在前、识别提示语在后（与原直连 provider 同序）', async () => {
    const { invoke, provider } = okProvider('1. 题干内容');
    await provider.ocrPage({ data: new Uint8Array([1, 2, 3]), pageNo: 2, mime: 'image/jpeg' });

    expect(invoke).toHaveBeenCalledTimes(1);
    const payload = invoke.mock.calls[0][0];
    expect(payload.role).toBe('vision');
    expect(payload.temperature).toBe(0);
    const content = payload.messages[0].content as unknown as Array<{ type: string; text?: string; imageUrl?: { url: string } }>;
    expect(content[0].type).toBe('image_url');
    expect(content[0].imageUrl!.url).toBe(`data:image/jpeg;base64,${Buffer.from([1, 2, 3]).toString('base64')}`);
    expect(content[1]).toEqual({ type: 'text', text: VISION_OCR_PROMPT });
  });

  it('mime 缺省按 image/png 拼 data URL；页号原样回填', async () => {
    const { invoke, provider } = okProvider('x');
    const r = await provider.ocrPage({ data: new Uint8Array([9]), pageNo: 7 });
    const content = invoke.mock.calls[0][0].messages[0].content as unknown as Array<{ imageUrl?: { url: string } }>;
    expect(content[0].imageUrl!.url).toBe(`data:image/png;base64,${Buffer.from([9]).toString('base64')}`);
    expect(r.pageNo).toBe(7);
  });

  it('超时参数化：缺省 120s（S-4：ai.invoke 缺省 30s 对 vision 大图不够），显式值原样透传', async () => {
    const a = okProvider('x');
    await a.provider.ocrPage({ data: new Uint8Array([1]), pageNo: 1 });
    expect(a.invoke.mock.calls[0][0].timeoutMs).toBe(120_000);

    const invoke = vi.fn(async (_p: AiInvokePayload): Promise<AiInvokeResult> => ({ ok: true, content: 'x', latencyMs: 1 }));
    const provider = createVisionOcrProvider({ invoke, timeoutMs: 45_000 });
    await provider.ocrPage({ data: new Uint8Array([1]), pageNo: 1 });
    expect(invoke.mock.calls[0][0].timeoutMs).toBe(45_000);
  });

  it('name 固定 vision；图位由页文本内 ref 标记抽出（复用 extractImageRefs）', async () => {
    const { provider } = okProvider('第一段\n<|ref|>image<|/ref|><|det|>[[1,2,5,9]]<|/det|>\n第二段');
    const r = await provider.ocrPage({ data: new Uint8Array([1]), pageNo: 3 });
    expect(provider.name).toBe('vision');
    expect(r.text).toContain('第一段');
    expect(r.images).toEqual([{ id: 'p3-img-0', pageNo: 3, bbox: { x: 1, y: 2, w: 4, h: 7 } }]);
  });
});

describe('0028 P1：vision provider 结果与失败形态', () => {
  it('usage 透传（prompt/completion/total）', async () => {
    const { provider } = okProvider('题面', { promptTokens: 900, completionTokens: 120, totalTokens: 1020 });
    const r = await provider.ocrPage({ data: new Uint8Array([1]), pageNo: 1 });
    expect(r.usage).toEqual({ promptTokens: 900, completionTokens: 120, totalTokens: 1020 });
  });

  it('ai.invoke 失败结果 → 抛错并带已脱敏错误文案（不静默产出空页）', async () => {
    const invoke = vi.fn(async (_p: AiInvokePayload): Promise<AiInvokeResult> => ({
      ok: false, error: 'HTTP 401：invalid api key sk-***', latencyMs: 30,
    }));
    const provider = createVisionOcrProvider({ invoke });
    await expect(provider.ocrPage({ data: new Uint8Array([1]), pageNo: 5 })).rejects.toThrow(/HTTP 401/);
  });

  it('内容为空白 → 抛错（空页不得当成功页写进 checkpoint）', async () => {
    const { provider } = okProvider('   ');
    await expect(provider.ocrPage({ data: new Uint8Array([1]), pageNo: 1 })).rejects.toThrow(/空/);
  });

  it('provider 不持 Key 概念：对外只有 name/ocrPage，实例自有属性不含任何凭据字段', () => {
    const { provider } = okProvider('x');
    expect(provider.name).toBe('vision');
    expect(typeof provider.ocrPage).toBe('function');
    expect(Object.keys(provider).filter((k) => /key|token|auth|secret|baseurl/i.test(k))).toEqual([]);
  });
});
