// 0040 P1：OnestepProvider 双实现测试（注入假 invoke，不真调模型）。
// 覆盖：
//   - 主档：主调用 + DSO 双模板并行；图块来源对账（dso / inline / none）
//   - 规则⑤：空返回 → 关思考 + 提预算重试一次（payload 逐字断言）
//   - 规则⑥：首次调用即带 thinking='disabled'（按模型能力配置，网关负责不识别的降级省略）
//   - 降级档：两段式（vision 转写腿 + reasoning 结构化腿），无坐标能力并显式告警

import { describe, it, expect, vi } from 'vitest';

import { createOnestepProvider, createTwoStageProvider } from '../../src/recog/providers/onestep.js';
import { DSO_GROUNDING_PROMPTS, ONESTEP_TRANSCRIBE_PROMPT, TWOSTAGE_STRUCTURE_PROMPT } from '../../src/recog/onestep/prompts.js';
import type { AiChatMessage, AiInvokePayload, AiInvokeResult } from '../../src/shared/contracts/ai-types.js';

const IMAGE = { dataBase64: 'AAAA', mime: 'image/png', pageNo: 1 };

const DSO_RAW =
  '<|ref|>image<|/ref|><|det|>[[300, 255, 668, 360]]<|/det|>\n' +
  '<|ref|>image<|/ref|><|det|>[[644, 630, 910, 797]]<|/det|>';

const MAIN_JSON = JSON.stringify({
  questions: [{
    qno: '2-17',
    questionType: '填空',
    stemMarkdown: '如图[图1]与[图2]，将同一物体分别放入甲、乙两种液体中。',
    options: null,
    answerMarkdown: null,
    analysisMarkdown: null,
    suggestedTags: ['浮力'],
  }],
});

function messageText(messages: AiChatMessage[]): string {
  return messages
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : m.content.map((p) => (p.type === 'text' ? p.text : p.type)).join(' '),
    )
    .join(' ');
}

/** 假网关：按消息内容分流（DSO 模板 / 主提示词 / 转写 / 结构化） */
function fakeInvoke(handlers: {
  main?: () => AiInvokeResult;
  dso?: (prompt: string) => AiInvokeResult;
  transcribe?: () => AiInvokeResult;
  structure?: () => AiInvokeResult;
}) {
  const calls: AiInvokePayload[] = [];
  const invoke = vi.fn(async (payload: AiInvokePayload): Promise<AiInvokeResult> => {
    calls.push(payload);
    const text = messageText(payload.messages);
    if (DSO_GROUNDING_PROMPTS.some((p) => text.includes(p))) {
      return handlers.dso ? handlers.dso(text) : { ok: true, content: DSO_RAW, latencyMs: 5 };
    }
    if (text.includes(ONESTEP_TRANSCRIBE_PROMPT.slice(0, 20))) {
      return handlers.transcribe ? handlers.transcribe() : { ok: true, content: '2-17 如图…（转写文本）', latencyMs: 3 };
    }
    if (text.includes(TWOSTAGE_STRUCTURE_PROMPT.slice(0, 20))) {
      return handlers.structure ? handlers.structure() : { ok: true, content: MAIN_JSON, latencyMs: 40 };
    }
    return handlers.main ? handlers.main() : { ok: true, content: MAIN_JSON, latencyMs: 60 };
  });
  return { invoke, calls };
}

describe('0040 P1 主档 OnestepProvider（一步到位 VLM）', () => {
  it('主调用 + DSO 双模板并行；图块来源=dso（坐标交给 OCR）', async () => {
    const { invoke, calls } = fakeInvoke({});
    const provider = createOnestepProvider({ invoke });
    const drafts = await provider.extract({ image: IMAGE });

    expect(provider.name).toBe('onestep-vlm');
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.figures.map((f) => f.ref)).toEqual(['图1', '图2']);
    expect(drafts[0]!.figureSource).toBe('dso');
    expect(drafts[0]!.warnings.some((w) => w.includes('DeepSeek-OCR 定位 2 个'))).toBe(true);
    // 1 次主调用 + 2 次 grounding 模板
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.role === 'vision')).toBe(true);
  });

  it('规则⑥：主调用带 thinking=disabled（0042 §9.1 必须关思考）；grounding 腿不带（OCR 无思考开关）', async () => {
    const { invoke, calls } = fakeInvoke({});
    await createOnestepProvider({ invoke }).extract({ image: IMAGE });
    const grounding = calls.filter((c) => DSO_GROUNDING_PROMPTS.some((p) => messageText(c.messages).includes(p)));
    const main = calls.filter((c) => !DSO_GROUNDING_PROMPTS.some((p) => messageText(c.messages).includes(p)));
    expect(grounding).toHaveLength(2);
    expect(grounding.every((c) => c.thinking === undefined)).toBe(true);
    expect(main).toHaveLength(1);
    expect(main[0]!.thinking).toBe('disabled');
  });

  it('DSO 无出图（返回纯文本）→ 回落主模型内联框并显式标注来源=inline', async () => {
    const inlineJson = JSON.stringify({
      questions: [{ qno: '1', questionType: '填空', stemMarkdown: '如图[图1]', options: null, answerMarkdown: null, analysisMarkdown: null, suggestedTags: [] }],
      figures: [{ ref: '图1', bboxNorm: [100, 100, 400, 400] }],
    });
    const { invoke } = fakeInvoke({
      main: () => ({ ok: true, content: inlineJson, latencyMs: 60 }),
      dso: () => ({ ok: true, content: '（纯文本转写，无 grounding 标记）', latencyMs: 2 }),
    });
    const drafts = await createOnestepProvider({ invoke }).extract({ image: IMAGE });
    expect(drafts[0]!.figureSource).toBe('inline');
    expect(drafts[0]!.figures).toHaveLength(1);
    expect(drafts[0]!.warnings.some((w) => w.includes('显式降级'))).toBe(true);
  });

  it('两侧都无框 + 题面有占位符 → source=none 且告警未配平（不静默留占位）', async () => {
    const noFigJson = JSON.stringify({
      questions: [{ qno: '1', questionType: '解答', stemMarkdown: '如图[图1]', options: null, answerMarkdown: null, analysisMarkdown: null, suggestedTags: [] }],
    });
    const { invoke } = fakeInvoke({
      main: () => ({ ok: true, content: noFigJson, latencyMs: 60 }),
      dso: () => ({ ok: false, error: 'HTTP 429：rate limited', latencyMs: 1 }),
    });
    const drafts = await createOnestepProvider({ invoke }).extract({ image: IMAGE });
    expect(drafts[0]!.figureSource).toBe('none');
    expect(drafts[0]!.figures).toEqual([]);
    expect(drafts[0]!.warnings.some((w) => w.includes('[图1] 未配到图块'))).toBe(true);
    expect(drafts[0]!.warnings.some((w) => w.includes('grounding 调用失败'))).toBe(true);
  });

  it('规则⑤：首次空返回 → 关思考 + 提预算重试一次（第二次成功）', async () => {
    let mainCalls = 0;
    const { invoke, calls } = fakeInvoke({
      main: () => {
        mainCalls += 1;
        return mainCalls === 1
          ? { ok: true, content: '', latencyMs: 30 }
          : { ok: true, content: MAIN_JSON, latencyMs: 40 };
      },
    });
    const drafts = await createOnestepProvider({ invoke, thinking: 'enabled', maxTokens: 4096 }).extract({ image: IMAGE });
    expect(drafts).toHaveLength(1);
    const mainPayloads = calls.filter((c) => !DSO_GROUNDING_PROMPTS.some((p) => messageText(c.messages).includes(p)));
    expect(mainPayloads).toHaveLength(2);
    expect(mainPayloads[0]!.thinking).toBe('enabled');
    expect(mainPayloads[0]!.maxTokens).toBe(4096);
    expect(mainPayloads[1]!.thinking).toBe('disabled');
    expect(mainPayloads[1]!.maxTokens).toBe(8192); // 逐级翻倍：4096 → 8192（不一步跳到 16384）
  });

  it('规则⑤：预算逐级提到上限仍空 → 抛出可执行建议（不静默返回空数组）', async () => {
    const { invoke, calls } = fakeInvoke({ main: () => ({ ok: true, content: '   ', latencyMs: 30 }) });
    await expect(createOnestepProvider({ invoke }).extract({ image: IMAGE })).rejects.toThrow(/换一个非思考档模型/);
    const mainPayloads = calls.filter((c) => !DSO_GROUNDING_PROMPTS.some((p) => messageText(c.messages).includes(p)));
    expect(mainPayloads.map((c) => c.maxTokens)).toEqual([4096, 8192, 16384]);
    expect(mainPayloads.every((c) => c.thinking === 'disabled' || c === mainPayloads[0])).toBe(true);
    // 坐标腿只跑一次：重试只重试主调用（不重复烧 DSO 调用）
    const dsoCalls = calls.filter((c) => DSO_GROUNDING_PROMPTS.some((p) => messageText(c.messages).includes(p)));
    expect(dsoCalls).toHaveLength(2);
  });

  it('规则①：合规空数组重试一次后仍空 → 抛出（指明换档）', async () => {
    const { invoke, calls } = fakeInvoke({ main: () => ({ ok: true, content: '{"questions":[]}', latencyMs: 10 }) });
    await expect(createOnestepProvider({ invoke }).extract({ image: IMAGE })).rejects.toThrow(/空题目数组/);
    const mainPayloads = calls.filter((c) => !DSO_GROUNDING_PROMPTS.some((p) => messageText(c.messages).includes(p)));
    expect(mainPayloads).toHaveLength(2);
  });

  it('主调用失败（网关结果形态）→ 直接抛出原始错误（不吞）', async () => {
    const { invoke } = fakeInvoke({ main: () => ({ ok: false, error: 'HTTP 401：invalid api key', latencyMs: 5 }) });
    await expect(createOnestepProvider({ invoke }).extract({ image: IMAGE })).rejects.toThrow(/HTTP 401/);
  });

  it('调用上下文：pageNo 落进草稿图块页号；图块 bbox 已换到 0~1 归一', async () => {
    const { invoke } = fakeInvoke({});
    const drafts = await createOnestepProvider({ invoke }).extract({ image: { ...IMAGE, pageNo: 3 } });
    expect(drafts[0]!.figures[0]!.bbox[0]).toBeCloseTo(300 / 999, 6);
  });
});

describe('0040 P1 降级档 TwoStageProvider（OCR 转写 → 文本结构化）', () => {
  it('两腿角色正确（vision 转写 + reasoning 结构化），无坐标能力并显式告警', async () => {
    const { invoke, calls } = fakeInvoke({});
    const provider = createTwoStageProvider({ invoke });
    const drafts = await provider.extract({ image: IMAGE });

    expect(provider.name).toBe('onestep-twostage');
    expect(calls.map((c) => c.role)).toEqual(['vision', 'reasoning']);
    expect(messageText(calls[0]!.messages)).toContain(ONESTEP_TRANSCRIBE_PROMPT.slice(0, 20));
    expect(messageText(calls[1]!.messages)).toContain(TWOSTAGE_STRUCTURE_PROMPT.slice(0, 20));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.figures).toEqual([]);
    expect(drafts[0]!.figureSource).toBe('none');
    expect(drafts[0]!.warnings.some((w) => w.includes('无坐标能力'))).toBe(true);
  });

  it('转写腿空返回 → 抛出（该档案不具备转写能力域，不静默降级）', async () => {
    const { invoke } = fakeInvoke({ transcribe: () => ({ ok: true, content: '  ', latencyMs: 2 }) });
    await expect(createTwoStageProvider({ invoke }).extract({ image: IMAGE })).rejects.toThrow(/不具备转写能力域/);
  });

  it('结构化腿失败 → 抛出原始错误', async () => {
    const { invoke } = fakeInvoke({ structure: () => ({ ok: false, error: '角色 reasoning 未配置', latencyMs: 1 }) });
    await expect(createTwoStageProvider({ invoke }).extract({ image: IMAGE })).rejects.toThrow(/未配置/);
  });
});
