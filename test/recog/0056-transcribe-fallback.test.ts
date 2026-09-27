// 0056 目检返工②：转写腿「专用 OCR 模型只认自己的模板」——空返回时按备用提示词再试一次。
//
// 真机现场（用户复检 2026-09-23）：`OCR 转写腿返回空内容（该档案不具备转写能力域）` 出现在 **SVG 已栅格化之后**
// （400 `image_url ... not a valid image` 已消失），说明格式问题已解决、剩下的空返回另有其因。
// 只读核对用户模型档案：`vision` 角色 = 硅基流动 `deepseek-ai/DeepSeek-OCR`——**专用 OCR 模型**，
// 0042 侦察纪要 §Q2 路线2 逐字记录过：「v1（`<|ref|>image<|/ref|><|grounding|>`）与 v3 稳定出全页布局；
// **v2（中文「图」）两次空返回淘汰**」——中文通用指令（我们的 ONESTEP_TRANSCRIBE_PROMPT 就是中文）
// 正是它不认的那种输入。而 DSO 的官方模板 `<|grounding|>Convert the document to markdown.`
// 稳定产出带 LaTeX 的 markdown（同纪要留档原文：`\( U \)`、`\( R_0 \)`…）= 我们要的转写结果。
//
// 口径：provider 仍是「模型无关」的（不按模型名分支）——只在**空返回**这一失败信号上补一次备用模板重试；
// 未传备用提示词 = 行为与既有完全一致（0040 workbench 链零影响）。

import { describe, it, expect } from 'vitest';
import { createTwoStageProvider } from '../../src/recog/providers/onestep.js';
import { DSO_GROUNDING_PROMPTS } from '../../src/recog/onestep/prompts.js';
import type { AiInvokePayload, AiInvokeResult } from '../../src/shared/contracts/ai-types.js';

const IMAGE = { dataBase64: 'AAAA', mime: 'image/png' };
const STRUCTURED = JSON.stringify({
  questions: [{ qno: null, questionType: '解答', stemMarkdown: '$x$', options: null, answerMarkdown: null, analysisMarkdown: null, suggestedTags: [] }],
});

/** 记录每次调用用的提示词 + 图片 URL，按脚本出响应 */
function makeInvoke(script: Array<{ text?: string; content: string } | { fail: string }>) {
  const calls: Array<{ isVision: boolean; prompt: string }> = [];
  let index = 0;
  const invoke = async (payload: AiInvokePayload): Promise<AiInvokeResult> => {
    const isVision = Array.isArray(payload.messages[0]?.content);
    const prompt = isVision
      ? (payload.messages[0]!.content as Array<{ type: string; text?: string }>).find((p) => p.type === 'text')?.text ?? ''
      : String(payload.messages[0]?.content ?? '');
    calls.push({ isVision, prompt });
    if (isVision) {
      const step = script[index] ?? script[script.length - 1]!;
      index += 1;
      if ('fail' in step) return { ok: false, error: step.fail, code: 'http' } as AiInvokeResult;
      return { ok: true, content: step.content } as AiInvokeResult;
    }
    return { ok: true, content: STRUCTURED } as AiInvokeResult;
  };
  return { invoke, calls };
}

describe('0056 返工②：转写腿备用模板重试', () => {
  it('中文模板空返回 → 用备用模板（DSO 官方 grounding 模板）再试一次，成功即继续', async () => {
    const { invoke, calls } = makeInvoke([
      { content: '' },                     // 第一次：中文模板 → 空（DSO 现场形态）
      { content: '8. 中国空间站…\\( U \\) 保持不变' }, // 第二次：备用模板 → 有内容
    ]);
    const provider = createTwoStageProvider({ invoke, transcribeFallbackPrompt: DSO_GROUNDING_PROMPTS[1] });
    const drafts = await provider.extract({ image: IMAGE });
    expect(drafts).toHaveLength(1);
    const visionCalls = calls.filter((c) => c.isVision);
    expect(visionCalls).toHaveLength(2);
    expect(visionCalls[0]!.prompt).toContain('逐字转写');            // 先走原口径（中文通用指令）
    expect(visionCalls[1]!.prompt).toBe(DSO_GROUNDING_PROMPTS[1]);   // 再走专用 OCR 模板
  });

  it('两次都空 → 仍抛既有错误（不静默、不无限重试）', async () => {
    const { invoke, calls } = makeInvoke([{ content: '' }, { content: '   ' }]);
    const provider = createTwoStageProvider({ invoke, transcribeFallbackPrompt: DSO_GROUNDING_PROMPTS[1] });
    await expect(provider.extract({ image: IMAGE })).rejects.toThrow(/不具备转写能力域/);
    expect(calls.filter((c) => c.isVision)).toHaveLength(2); // 备用模板只试一次
  });

  it('未传备用提示词 → 行为与既有完全一致（一次调用即抛，0040 链零影响）', async () => {
    const { invoke, calls } = makeInvoke([{ content: '' }]);
    const provider = createTwoStageProvider({ invoke });
    await expect(provider.extract({ image: IMAGE })).rejects.toThrow(/不具备转写能力域/);
    expect(calls.filter((c) => c.isVision)).toHaveLength(1);
  });

  it('返工③：transcribePrompt 覆盖主提示词（公式靶英文「只出 LaTeX」口径）', async () => {
    const FORMULA = 'Identify the math formula in the image. Output ONLY the LaTeX code, nothing else.';
    const { invoke, calls } = makeInvoke([{ content: '$\sin 37°=0.6$' }]);
    const provider = createTwoStageProvider({ invoke, transcribePrompt: FORMULA, transcribeFallbackPrompt: DSO_GROUNDING_PROMPTS[1] });
    await provider.extract({ image: IMAGE });
    expect(calls.filter((c) => c.isVision)).toHaveLength(1);
    expect(calls.filter((c) => c.isVision)[0]!.prompt).toBe(FORMULA);
  });

  it('首次就有内容 → 不触发备用模板（零额外成本）', async () => {
    const { invoke, calls } = makeInvoke([{ content: '公式：$\\sin 37°=0.6$' }]);
    const provider = createTwoStageProvider({ invoke, transcribeFallbackPrompt: DSO_GROUNDING_PROMPTS[1] });
    const drafts = await provider.extract({ image: IMAGE });
    expect(drafts).toHaveLength(1);
    expect(calls.filter((c) => c.isVision)).toHaveLength(1);
    expect(calls.filter((c) => c.isVision)[0]!.prompt).toContain('逐字转写');
  });
});
