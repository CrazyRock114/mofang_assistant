// 0040 P4：识别执行（渲染层编排）。**不新增通道**：引擎调用经 ai.invoke 白名单桥走网关
// （Provider 层是纯 TS + 注入式 invoke，主/渲染两侧同源；Key 始终不出主进程，D-043）。
//
// 口径（0036「裁剪本地做」+ 0042「只送小图」）：手动框选/图块一律本地裁成小图再送模型；
// 「AI 一键录入」送整页；降级档（semi）= 两段式（OCR 转写 → 文本推理结构化）。

import type { AiInvokePayload, AiInvokeResult, ModelProfile, ModelRole } from '../../shared/contracts/ai-types.js';
import type { OnestepDraft, OnestepExtractContext, WorkbenchMode, WorkbenchRect } from '../../shared/contracts/onestep-types.js';
import { createOnestepProvider, createTwoStageProvider } from '../../recog/providers/onestep.js';
import { cropNormalizedRect, type PageImageLike } from './crop.js';

/**
 * 双模型档位选择（D-057「OCR + 视觉推理双模型」的落点）。
 *
 * 这一步不做会出事（2026-09-19 用户实测踩到）：一步到位是**理解活**，必须交给视觉推理模型；
 * 若错发到 vision 档的 OCR 模型，会连报「不认思考参数」+「输出超上限」，而真相是那个模型
 * 只会照抄文字、不产结构化 JSON。
 *   主档 = `reasoning` 档有启用档案就用它（视觉推理模型的自然档位），否则回落 `vision`；
 *   坐标腿 = `vision` 档（OCR 模型的档位；没配则沿用主档，坐标自行降级为内联/无）。
 */
export interface RecognizeModelChoice {
  mainRole: ModelRole;
  groundingRole: ModelRole;
  /** 人读标签（进错误文案：出问题时要能一眼看出「是发给哪个模型的」） */
  label: string;
}

export function resolveRecognizeModelChoice(profiles: ModelProfile[]): RecognizeModelChoice {
  const enabled = (role: ModelRole): ModelProfile | undefined =>
    profiles.find((p) => p.role === role && p.isEnabled);
  const reasoning = enabled('reasoning');
  const vision = enabled('vision');
  const main = reasoning ?? vision;
  const mainRole: ModelRole = reasoning ? 'reasoning' : 'vision';
  const groundingRole: ModelRole = vision ? 'vision' : mainRole;
  return {
    mainRole,
    groundingRole,
    label: main ? `${mainRole} 档 · ${main.model}` : '未配置模型',
  };
}

export interface RecognizeRequest {
  pageImage: PageImageLike;
  pageNo: number;
  /** 归一化待识别区域（手动框选 = 该区域；AI 一键/整页 = {0,0,1,1}） */
  rect: WorkbenchRect;
  mode: WorkbenchMode;
  invoke: (payload: AiInvokePayload) => Promise<AiInvokeResult>;
  context?: OnestepExtractContext;
  /** 档位选择（缺省按 deps 里的默认值：主档 vision）；由调用方用 resolveRecognizeModelChoice 解析 */
  roles?: RecognizeModelRoles;
}

/** 档位选择（主档 / 坐标腿 / 人读标签）——由 `resolveRecognizeModelChoice` 解析后透传 */
export type RecognizeModelRoles = Pick<RecognizeModelChoice, 'mainRole' | 'groundingRole' | 'label'>;

/** 已就绪的送模型图（单帧裁剪或多帧拼接的产物；pageNo/宽高作溯源与图块回填口径） */
export interface RecognizeImageInput {
  dataBase64: string;
  mime: string;
  pageNo: number;
  width: number;
  height: number;
}

export interface RecognizeImageRequest {
  image: RecognizeImageInput;
  mode: WorkbenchMode;
  invoke: (payload: AiInvokePayload) => Promise<AiInvokeResult>;
  context?: OnestepExtractContext;
  roles?: RecognizeModelRoles;
}

export type RecognizeOutcome =
  | { ok: true; drafts: OnestepDraft[]; sentWidth: number; sentHeight: number }
  | { ok: false; error: string };

/** 整页矩形（AI 一键录入 / 半自动整页） */
export const FULL_PAGE_RECT: WorkbenchRect = { x: 0, y: 0, w: 1, h: 1 };

/** data URL → { mime, dataBase64 }（桥面只传纯 base64，与 recog.create 素材同口径） */
export function splitDataUrl(dataUrl: string): { mime: string; dataBase64: string } {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) throw new Error('裁图产出不是合法的 base64 data URL');
  return { mime: match[1]!, dataBase64: match[2]! };
}

/**
 * 识别一块区域：本地裁图 → 已有图识别（recognizeImage）。
 * 失败一律返回 ok:false + 人读原因（UI 红条 + 可重试），绝不静默吞错。
 */
export async function recognizeRegion(request: RecognizeRequest): Promise<RecognizeOutcome> {
  const cropped = cropNormalizedRect(request.pageImage, request.rect);
  if (!cropped.ok) return { ok: false, error: cropped.reason };

  let image: RecognizeImageInput;
  try {
    const { mime, dataBase64 } = splitDataUrl(cropped.dataUrl);
    image = { dataBase64, mime, pageNo: request.pageNo, width: cropped.width, height: cropped.height };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  return recognizeImage({
    image,
    mode: request.mode,
    invoke: request.invoke,
    ...(request.roles ? { roles: request.roles } : {}),
    ...(request.context ? { context: request.context } : {}),
  });
}

/**
 * 已有图 → Provider（auto=一步到位 VLM / semi=两段式）→ 结构化草稿。
 * 单帧卡（裁剪图）与多帧卡（拼接图，0070）共用这一段——送进模型的永远是**一张**图。
 */
export async function recognizeImage(request: RecognizeImageRequest): Promise<RecognizeOutcome> {
  const roles = request.roles;
  const provider = request.mode === 'semi'
    ? createTwoStageProvider({
        invoke: request.invoke,
        ...(roles ? { groundingRole: roles.groundingRole, structureRole: roles.mainRole } : {}),
      })
    : createOnestepProvider({
        invoke: request.invoke,
        ...(roles ? { role: roles.mainRole, groundingRole: roles.groundingRole } : {}),
      });
  const where = roles ? `${roles.label}｜` : '';

  try {
    const drafts = await provider.extract({
      image: request.image,
      ...(request.context ? { context: request.context } : {}),
    });
    if (drafts.length === 0) {
      return { ok: false, error: `${where}模型未返回任何题目（该区域可能不是题目，或模型未按提示词输出）` };
    }
    return { ok: true, drafts, sentWidth: request.image.width, sentHeight: request.image.height };
  } catch (err) {
    // 失败文案带「发给哪个档位/哪个模型」——用户实测教训：不写清档位，报错根本无从定位
    return { ok: false, error: `${where}${err instanceof Error ? err.message : String(err)}` };
  }
}
