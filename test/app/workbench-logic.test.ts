// 0040 P3/P4：工作台纯逻辑测试（几何复用 0036 box-model / 题型映射 / 裁图口径 / 缩放）。
// 无 DOM 依赖（crop 的像素换算部分），可在 node 环境直测。

import { describe, it, expect } from 'vitest';

import {
  fromSplitBox, moveRect, rectToBoxStyle, resizeRect, toSplitBox, unionRects,
} from '../../src/app/workbench/box-geometry.js';
import { BOX_MIN_SIZE } from '../../src/recog/splitting/box-model.js';
import { rectToPixels, CROP_MAX_EDGE_PX } from '../../src/app/workbench/crop.js';
import { mapQuestionTypeToDict, typeOptionsOf } from '../../src/app/workbench/question-types.js';
import { splitDataUrl, FULL_PAGE_RECT, resolveRecognizeModelChoice } from '../../src/app/workbench/recognize.js';
import { autoZoom, clampZoom } from '../../src/app/workbench/SourcePane.js';
import type { DictEntry } from '../../src/shared/contracts/bank-types.js';
import type { ModelProfile, ModelRole } from '../../src/shared/contracts/ai-types.js';

describe('0040 P3：框选几何（复用 0036 box-model 归一化口径）', () => {
  it('SplitBox 形状适配往返无损', () => {
    const rect = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
    expect(fromSplitBox(toSplitBox(rect, 3))).toEqual(rect);
  });

  it('平移：整框夹回页内，宽高不变（拖出边界贴边而非变形）', () => {
    const rect = { x: 0.8, y: 0.1, w: 0.3, h: 0.2 };
    const moved = moveRect(rect, 0.5, 0);
    expect(moved.x).toBeCloseTo(0.7, 6);
    expect(moved.w).toBe(0.3);
  });

  it('缩放手柄 se：右下角跟手，左上角不动', () => {
    const rect = { x: 0.2, y: 0.2, w: 0.3, h: 0.3 };
    const next = resizeRect(rect, 'se', { x: 0.8, y: 0.9 });
    expect(next.x).toBeCloseTo(0.2, 6);
    expect(next.y).toBeCloseTo(0.2, 6);
    expect(next.w).toBeCloseTo(0.6, 6);
    expect(next.h).toBeCloseTo(0.7, 6);
  });

  it('缩到最小边长即停（不翻转、不归零）', () => {
    const rect = { x: 0.5, y: 0.5, w: 0.3, h: 0.3 };
    const next = resizeRect(rect, 'se', { x: 0.1, y: 0.1 });
    expect(next.w).toBeCloseTo(BOX_MIN_SIZE, 6);
    expect(next.h).toBeCloseTo(BOX_MIN_SIZE, 6);
  });

  it('归一化矩形 → 面板像素（与 denormalizeRect 严格互逆）', () => {
    const style = rectToBoxStyle({ x: 0.25, y: 0.5, w: 0.5, h: 0.25 }, { w: 800, h: 1200 });
    expect(style).toEqual({ left: 200, top: 600, width: 400, height: 300 });
  });

  it('多框最小外接矩形（并入多帧溯源展示）', () => {
    const union = unionRects([{ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, { x: 0.5, y: 0.6, w: 0.2, h: 0.3 }])!;
    expect(union.x).toBeCloseTo(0.1, 6);
    expect(union.y).toBeCloseTo(0.1, 6);
    expect(union.w).toBeCloseTo(0.6, 6);
    expect(union.h).toBeCloseTo(0.8, 6);
    expect(unionRects([])).toBeNull();
  });
});

describe('0040 P3：本地裁图像素换算（降级口径由 crop.ts 保证）', () => {
  it('归一化矩形 → 像素矩形（含边距外扩）', () => {
    const px = rectToPixels({ x: 0.5, y: 0.5, w: 0.25, h: 0.25 }, { width: 1000, height: 800 }, { padding: 0.01 });
    // 右/下边界一起外扩：右 = (0.5+0.25+0.01)*1000 = 760，下 = (0.5+0.25+0.01)*800 = 608
    expect(px).toEqual({ x: 490, y: 392, w: 270, h: 216 });
  });

  it('越界矩形被夹回页内（不产出负宽高）', () => {
    const px = rectToPixels({ x: -0.2, y: -0.2, w: 0.5, h: 0.5 }, { width: 400, height: 400 });
    expect(px.x).toBe(0);
    expect(px.y).toBe(0);
    expect(px.w).toBeGreaterThan(0);
    expect(px.h).toBeGreaterThan(0);
  });

  it('裁图长边上限常量就位（防 workbench.json/HTML 膨胀）', () => {
    expect(CROP_MAX_EDGE_PX).toBeGreaterThanOrEqual(600);
    expect(CROP_MAX_EDGE_PX).toBeLessThanOrEqual(1600);
  });
});

describe('0040 P4：引擎题型 → 字典题型映射', () => {
  const entries: DictEntry[] = [
    { id: 'qtype:single', kind: 'question_type', code: 'single-choice', label: '单选题', site: null, active: true },
    { id: 'qtype:multi', kind: 'question_type', code: 'multi-choice', label: '多选题', site: null, active: true },
    { id: 'qtype:blank', kind: 'question_type', code: 'fill', label: '填空题', site: null, active: true },
    { id: 'qtype:essay', kind: 'question_type', code: 'solve', label: '解答题', site: null, active: true },
  ];

  it('按语义匹配字典行（不硬编码字典 id）', () => {
    expect(mapQuestionTypeToDict('单选', entries)).toBe('qtype:single');
    expect(mapQuestionTypeToDict('多选', entries)).toBe('qtype:multi');
    expect(mapQuestionTypeToDict('填空', entries)).toBe('qtype:blank');
    expect(mapQuestionTypeToDict('解答', entries)).toBe('qtype:essay');
  });

  it('字典无对应行 → 空串（UI 显示「题型未定」，不造假数据）', () => {
    expect(mapQuestionTypeToDict('判断', entries)).toBe('');
    expect(mapQuestionTypeToDict('单选', [])).toBe('');
  });

  it('宽松包含匹配（字典叫法差异容错）', () => {
    const loose: DictEntry[] = [
      { id: 'qtype:x', kind: 'question_type', code: 'choice', label: '选择题', site: null, active: true },
    ];
    expect(mapQuestionTypeToDict('单选', loose)).toBe('qtype:x');
  });

  it('下拉选项 = 字典行（保序）', () => {
    expect(typeOptionsOf(entries).map((o) => o.label)).toEqual(['单选题', '多选题', '填空题', '解答题']);
  });
});

describe('0040 P4：裁图结果 → 引擎入参', () => {
  it('data URL 拆出 mime 与纯 base64（桥面只传纯 base64）', () => {
    expect(splitDataUrl('data:image/png;base64,QUJD')).toEqual({ mime: 'image/png', dataBase64: 'QUJD' });
  });

  it('非法 data URL → 抛错（不静默送坏图给模型）', () => {
    expect(() => splitDataUrl('not-a-data-url')).toThrow(/data URL/);
  });

  it('整页矩形常量 = 全画幅（AI 一键录入口径）', () => {
    expect(FULL_PAGE_RECT).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});

describe('0040 P3：预览缩放', () => {
  // 2026-09-20 目检返工②：默认缩放口径由「图小铺满、图大原尺寸」改为「宽度铺满预览区」
  it('宽度铺满：大页缩放 < 1 也铺满，小图放大到铺满（上限 2.5 兜住）', () => {
    expect(autoZoom(560, 1120)).toBe(2);
    expect(autoZoom(560, 300)).toBe(300 / 560);
    expect(autoZoom(1240, 620)).toBe(0.5);
    expect(autoZoom(100, 10000)).toBe(2.5);
  });

  it('缩放夹取上下界', () => {
    expect(clampZoom(0.01)).toBe(0.3);
    expect(clampZoom(99)).toBe(2.5);
    expect(clampZoom(1.2)).toBe(1.2);
  });

  it('页尺寸未知时回落到 1（不产生 NaN 缩放）', () => {
    expect(autoZoom(0, 500)).toBe(1);
    expect(autoZoom(500, 0)).toBe(1);
  });
});

describe('0040 P4：双模型档位解析（D-057 双模型落点）', () => {
  const profile = (role: ModelRole, model: string, isEnabled = true): ModelProfile => ({
    id: `${role}-${model}`, role, name: model, provider: 'x', protocol: 'openai-chat',
    baseUrl: 'https://x', model, capability: null, isEnabled, hasKey: true,
    lastTestAt: null, lastTestOk: null, createdAt: '2026-09-19T00:00:00.000Z', updatedAt: '2026-09-19T00:00:00.000Z',
  });

  it('reasoning 有档案 → 一步到位走 reasoning，坐标腿走 vision（OCR 档）', () => {
    const choice = resolveRecognizeModelChoice([profile('vision', 'deepseek-ocr'), profile('reasoning', 'deepseek-flash')]);
    expect(choice.mainRole).toBe('reasoning');
    expect(choice.groundingRole).toBe('vision');
    expect(choice.label).toBe('reasoning 档 · deepseek-flash');
  });

  it('只有 vision → 主档回落 vision（单模型也能跑）', () => {
    const choice = resolveRecognizeModelChoice([profile('vision', 'qwen3-vl-8b')]);
    expect(choice.mainRole).toBe('vision');
    expect(choice.groundingRole).toBe('vision');
  });

  it('只有 reasoning（没配 OCR 档）→ 坐标腿沿用主档（坐标由内联/无兜底并告警）', () => {
    const choice = resolveRecognizeModelChoice([profile('reasoning', 'deepseek-flash')]);
    expect(choice.mainRole).toBe('reasoning');
    expect(choice.groundingRole).toBe('reasoning');
  });

  it('停用的档案不参与（禁用的 reasoning 不算配好）', () => {
    const choice = resolveRecognizeModelChoice([profile('vision', 'deepseek-ocr'), profile('reasoning', 'deepseek-flash', false)]);
    expect(choice.mainRole).toBe('vision');
    expect(choice.label).toBe('vision 档 · deepseek-ocr');
  });

  it('一个都没有 → 显式「未配置模型」（不猜）', () => {
    const choice = resolveRecognizeModelChoice([]);
    expect(choice.mainRole).toBe('vision');
    expect(choice.label).toBe('未配置模型');
  });
});
