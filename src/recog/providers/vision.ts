// 0028 P1：vision OCR provider（收编）——经 ai.invoke 走 vision 角色档案，不再直连 fetch
// 任务书 §一 P1「收编：vision 配置源读 model_profiles；siliconflow 直 fetch 路径拆除」。
//
// 红线（D-043）：本层不持 Key、不读 .env、不知 base_url —— 档案解析/Key 解密/超时/重试/脱敏
// 全在 shell 的 AiGateway 内完成；本 provider 只把「页图 + 识别提示语」翻译成 AiInvokePayload。
// 因而 recognition 模块对 bank-core 零依赖（架构硬规则 1 单向依赖保持）。

import type { OcrPageResult, OcrProvider } from '../../shared/contracts/recog-types.js';
import type { AiInvokePayload, AiInvokeResult } from '../../shared/contracts/ai-types.js';
import { extractImageRefs } from '../image-refs.js';

/** 与原直连 provider 逐字同一条提示语（OCR 质量依赖它，不随收编改） */
export const VISION_OCR_PROMPT = '请识别图片中的全部文字和公式，输出为Markdown格式，公式用LaTeX。';

/**
 * 单页超时缺省 120s。
 * S-4 实测依据：ai.invoke 的缺省 30s（ai-gateway.ts INVOKE_TIMEOUT_DEFAULT_MS）面向短文本，
 * 整页 A4@150dpi 图 + 长输出在免费/慢速通道上常态超过 30s；调用级参数化（本题实现）
 * 把超时抬到 120s，档案级超时列需 model_profiles 迁移（未授权，见交付报告 §S-4）。
 */
export const VISION_OCR_TIMEOUT_MS = 120_000;

export interface VisionOcrProviderDeps {
  /** 调用方注入的 ai.invoke（shell 侧绑 role 解析与 Key 托管；浏览器/测试可注入桩） */
  invoke(payload: AiInvokePayload): Promise<AiInvokeResult>;
  /** 单页超时（毫秒），缺省 120s */
  timeoutMs?: number;
  /** 识别提示语，缺省 VISION_OCR_PROMPT */
  prompt?: string;
}

class VisionOcrProvider implements OcrProvider {
  readonly name = 'vision';

  constructor(private readonly deps: VisionOcrProviderDeps) {}

  async ocrPage(image: { data: Uint8Array; pageNo: number; mime?: string }): Promise<OcrPageResult> {
    const url = `data:${image.mime ?? 'image/png'};base64,${Buffer.from(image.data).toString('base64')}`;
    const result = await this.deps.invoke({
      role: 'vision',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', imageUrl: { url } },
            { type: 'text', text: this.deps.prompt ?? VISION_OCR_PROMPT },
          ],
        },
      ],
      temperature: 0,
      timeoutMs: this.deps.timeoutMs ?? VISION_OCR_TIMEOUT_MS,
    });

    if (!result.ok) {
      throw new Error(`vision OCR 调用失败：${result.error}`);
    }
    const text = result.content;
    if (text.trim() === '') {
      throw new Error('vision OCR 返回空内容（该页无法识别，请检查原图清晰度或换用视觉档案）');
    }
    return {
      pageNo: image.pageNo,
      text,
      images: extractImageRefs(text, image.pageNo),
      ...(result.usage ? { usage: result.usage } : {}),
    };
  }
}

export function createVisionOcrProvider(deps: VisionOcrProviderDeps): OcrProvider {
  return new VisionOcrProvider(deps);
}
