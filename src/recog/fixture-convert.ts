// C0 Phase 1/3: POC 样本 JSON → OcrPageResult 转换（夹具种子与回归/测试共用的唯一转换逻辑）
// 源 JSON 结构：{page, text, model, usage:{prompt_tokens,completion_tokens,total_tokens}, elapsed_seconds, success}

import type { OcrPageResult } from '../shared/contracts/recog-types.js';
import { extractImageRefs } from './image-refs.js';

export interface PocPageJson {
  page: number;
  text: string;
  model?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  elapsed_seconds?: number;
  success?: boolean;
}

export function pocPageToOcrPageResult(raw: PocPageJson): OcrPageResult {
  return {
    pageNo: raw.page,
    text: raw.text,
    images: extractImageRefs(raw.text, raw.page),
    model: raw.model,
    usage: raw.usage
      ? {
          promptTokens: raw.usage.prompt_tokens,
          completionTokens: raw.usage.completion_tokens,
          totalTokens: raw.usage.total_tokens,
        }
      : undefined,
    raw,
  };
}
