// 0035：DOCX 导出编排层——计划 → 资源解析（公式栅格 / 图片读盘）→ 组装 → Buffer。
// 环境无关：公式栅格器与资源根经依赖注入（主进程接 rasterize.ts，测试/探针可注入替身）。
// 资源缺失一律显式入账（issues/降级清单），不静默丢内容。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Paper, Question } from '../../../shared/contracts/bank-types.js';
import { buildDocxPlan, type DocxPlan, type DocxPlanOptions, type MathItem } from './plan.js';
import type { MergedDegradation } from './content-subset.js';
import {
  assembleDocx,
  type AssetEntry,
  type AssemblyIssue,
  type DocxAssets,
  type RasteredMath,
} from './assemble.js';
import { imageIntrinsicSize, imageTypeOfExtension, type DocxImageType } from './image-size.js';

export interface MathRasterOutcomeLike {
  images: Map<string, RasteredMath>;
  failed: Array<{ key: string; error: string }>;
}

/** 0035 修复批：待栅格的 SVG 资产（采集站公式/符号图多为 SVG；位图直读，SVG 需渲染） */
export interface SvgAssetItem {
  /** data-assets/... 原样（map 键 + 失败记账） */
  key: string;
  svg: Buffer;
  /** 版式给的显示尺寸（DOM data-w/data-h；null = 交给栅格器按 SVG 自身内在尺寸） */
  widthPx: number | null;
  heightPx: number | null;
}

export interface SvgRasterOutcomeLike {
  images: Map<string, AssetEntry>;
  failed: Array<{ key: string; error: string }>;
}

export interface DocxExportDeps {
  /** 公式栅格器（主进程 = KaTeX + 隐藏窗；测试可注入替身） */
  rasterize: (items: MathItem[]) => Promise<MathRasterOutcomeLike>;
  /**
   * 0035 修复批：SVG 栅格器（主进程 = 隐藏窗渲染 → PNG；测试可注入替身）。
   * 缺省 = SVG 记缺图（显式入账，不静默）；位图路径不受影响。
   */
  rasterizeSvg?: (items: SvgAssetItem[]) => Promise<SvgRasterOutcomeLike>;
  /** data-assets/ 资产磁盘根（userData/data/assets）；null = 无资产根（图全落占位） */
  assetsRoot: string | null;
  onIssue?: (issue: AssemblyIssue) => void;
}

export interface DocxExportInput {
  paper: Paper;
  questions: Question[];
  mode: 'student' | 'teacher';
  options?: Omit<DocxPlanOptions, 'mode'>;
}

export interface DocxExportResult {
  buffer: Buffer;
  plan: DocxPlan;
  /** 公式栅格统计（探针/报告用） */
  math: { total: number; rasterized: number; failed: string[] };
  /** 图片资源统计 */
  images: { total: number; embedded: number; missing: string[] };
  issues: AssemblyIssue[];
  degradations: MergedDegradation[];
}

const MIME_TYPES: Record<string, DocxImageType | null> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/x-ms-bmp': 'bmp',
  'image/svg+xml': null,
  'image/webp': null,
};

function fromBytes(data: Buffer, type: DocxImageType): AssetEntry {
  const size = imageIntrinsicSize(data);
  if (!size) return { kind: 'missing', reason: '图片字节无法解析（损坏或格式不支持）' };
  return { kind: 'image', data, type, width: size.width, height: size.height };
}

/** data-assets/ 路径的磁盘读取（不含格式判定——位图与 SVG 共用；SVG 交给栅格器） */
function readDataAsset(src: string, assetsRoot: string | null): { ok: true; data: Buffer; rel: string } | { ok: false; reason: string } {
  const rel = src.slice('data-assets/'.length);
  if (assetsRoot === null) return { ok: false, reason: '当前环境无资产根（Electron 内可加载）' };
  const filePath = join(assetsRoot, ...rel.split('/'));
  if (!existsSync(filePath)) return { ok: false, reason: `文件不存在：${rel}` };
  try {
    return { ok: true, data: readFileSync(filePath), rel };
  } catch (err) {
    return { ok: false, reason: `读取失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

/** SVG 资产判定（扩展名；仅 data-assets 本地产物走栅格） */
function isSvgSrc(src: string): boolean {
  return /\.svg$/i.test(src.split(/[?#]/)[0]);
}

/** 单图资源解析：data-assets/ 读盘 / data: URL 解码 / 其余外源显式不入卷 */
export function loadAssetEntry(src: string, assetsRoot: string | null): AssetEntry {
  if (src.startsWith('data-assets/')) {
    const rel = src.slice('data-assets/'.length);
    const type = imageTypeOfExtension(rel);
    if (type === null) return { kind: 'missing', reason: `格式不支持（仅 PNG/JPEG/GIF/BMP）：${rel}` };
    const read = readDataAsset(src, assetsRoot);
    if (!read.ok) return { kind: 'missing', reason: read.reason };
    return fromBytes(read.data, type);
  }
  if (src.startsWith('data:')) {
    const match = /^data:([^;,]+)(;base64)?,([\s\S]*)$/.exec(src);
    if (!match) return { kind: 'missing', reason: 'data: URL 解析失败' };
    const type = MIME_TYPES[match[1].toLowerCase()];
    if (type === undefined || type === null) return { kind: 'missing', reason: `data: 图片类型不支持：${match[1]}` };
    if (match[2] !== ';base64') return { kind: 'missing', reason: 'data: 图片需 base64 编码' };
    try {
      return fromBytes(Buffer.from(match[3], 'base64'), type);
    } catch (err) {
      return { kind: 'missing', reason: `data: 图片解码失败：${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return { kind: 'missing', reason: '外源图片引用（http/file）不随卷导出' };
}

/** 计划 + 依赖 → .docx Buffer（资源缺失/降级全部入账） */
export async function buildDocxBuffer(input: DocxExportInput, deps: DocxExportDeps): Promise<DocxExportResult> {
  const plan = buildDocxPlan(input.paper, input.questions, { ...input.options, mode: input.mode });
  const issues: AssemblyIssue[] = [];

  const raster = await deps.rasterize(plan.mathItems);
  const assets = new Map<string, AssetEntry>();
  const missing: string[] = [];

  // 0035 修复批：SVG 与位图分流——SVG 攒批交栅格器（读盘失败才当场记缺图），位图直读
  const svgItems: SvgAssetItem[] = [];
  for (const src of plan.imageSrcs) {
    if (isSvgSrc(src)) {
      const read = readDataAsset(src, deps.assetsRoot);
      if (!read.ok) {
        assets.set(src, { kind: 'missing', reason: read.reason });
        missing.push(`${src}（${read.reason}）`);
        continue;
      }
      const hint = plan.imageHints[src];
      svgItems.push({
        key: src,
        svg: read.data,
        widthPx: hint?.widthPx ?? null,
        heightPx: hint?.heightPx ?? null,
      });
      continue;
    }
    const entry = loadAssetEntry(src, deps.assetsRoot);
    assets.set(src, entry);
    if (entry.kind === 'missing') missing.push(`${src}（${entry.reason}）`);
  }
  if (svgItems.length > 0) {
    if (deps.rasterizeSvg === undefined) {
      for (const item of svgItems) {
        const reason = 'SVG 需渲染为位图，但当前环境未接 SVG 栅格器';
        assets.set(item.key, { kind: 'missing', reason });
        missing.push(`${item.key}（${reason}）`);
      }
    } else {
      const outcome = await deps.rasterizeSvg(svgItems);
      for (const item of svgItems) {
        const rastered = outcome.images.get(item.key);
        if (rastered !== undefined) {
          assets.set(item.key, rastered);
          continue;
        }
        const failure = outcome.failed.find((f) => f.key === item.key);
        const reason = `SVG 栅格失败：${failure?.error ?? '未返回图像'}`;
        assets.set(item.key, { kind: 'missing', reason });
        missing.push(`${item.key}（${reason}）`);
      }
    }
  }

  const docxAssets: DocxAssets = { math: raster.images, assets };
  const buffer = await assembleDocx(plan, docxAssets, {
    onIssue: (issue) => {
      issues.push(issue);
      deps.onIssue?.(issue);
    },
  });

  return {
    buffer,
    plan,
    math: {
      total: plan.mathItems.length,
      rasterized: raster.images.size,
      failed: raster.failed.map((f) => `${f.key}（${f.error}）`),
    },
    images: { total: plan.imageSrcs.length, embedded: plan.imageSrcs.length - missing.length, missing },
    issues,
    degradations: plan.degradations,
  };
}
