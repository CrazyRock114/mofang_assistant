// 0028 P1：run 产物文件存储（T-07 混合持久化的「文件」一半）
// 目录布局：<runsRoot>/<runId>/pages/pNNN.png · ocr/pNNN.json · drafts.json
// 「文件存在即 checkpoint」——readOcr 命中即表明该页已完成，编排器据此跳过（ocr-batch 已验证语义）。
//
// 本层是编排器端口 RecogPipelineStore 的 fs 实现；状态位（status/pages_done）回写走 service，
// 故本文件不碰 SQL（架构硬规则 2：bank-core 唯一 SQL 入口）。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OcrPageResult, ScanDraft } from '../../shared/contracts/recog-types.js';
import type { RecogRun, RecogRunPage, RecogRunService } from '../../shared/contracts/recog-run-types.js';
import type { RecogPipelineStore } from './pipeline.js';

export const PAGE_IMAGE_REL = (pageNo: number): string => `pages/p${String(pageNo).padStart(3, '0')}.png`;
export const PAGE_OCR_REL = (pageNo: number): string => `ocr/p${String(pageNo).padStart(3, '0')}.json`;
export const DRAFTS_REL = 'drafts.json';

export interface RecogDraftsFile {
  drafts: ScanDraft[];
  warnings: string[];
}

export interface FsRunStoreDeps {
  runId: string;
  /** run 产物目录（绝对路径） */
  runDir: string;
  /** 已在编排前取好的页记录（listPages 是纯读，避免编排器里再 await 一次 IO） */
  pages: RecogRunPage[];
  runs: RecogRunService;
}

/** run 目录准备（幂等）：pages/ 与 ocr/ 子目录 */
export function ensureRunDir(runDir: string): void {
  mkdirSync(join(runDir, 'pages'), { recursive: true });
  mkdirSync(join(runDir, 'ocr'), { recursive: true });
}

/** 页图落盘（素材入库第一步；数据来自渲染层上传的 base64） */
export function writePageImage(runDir: string, pageNo: number, data: Buffer): string {
  const rel = PAGE_IMAGE_REL(pageNo);
  writeFileSync(join(runDir, rel), data);
  return rel;
}

/** 读 run 草稿产物（未产出/损坏 → null；损坏不 throw，交由上层以 error 语义呈现） */
export function readDraftsFile(runDir: string): RecogDraftsFile | null {
  const path = join(runDir, DRAFTS_REL);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as RecogDraftsFile;
    if (!Array.isArray(parsed.drafts) || !Array.isArray(parsed.warnings)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** run 草稿产物落盘（0046：从 writeDrafts 提出为独立导出，recog.draft.write 直写复用同一字节口径） */
export function writeDraftsFile(runDir: string, drafts: ScanDraft[], warnings: string[]): void {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, DRAFTS_REL), JSON.stringify({ drafts, warnings } satisfies RecogDraftsFile, null, 2), 'utf8');
}

export function createFsRunStore(deps: FsRunStoreDeps): RecogPipelineStore {
  const { runId, runDir, pages, runs } = deps;
  const abs = (rel: string): string => join(runDir, rel);
  let cursor: RecogRunPage[] = pages.map((p) => ({ ...p }));

  return {
    listPages: () => cursor.map((p) => ({ pageNo: p.pageNo, imageFile: p.imageFile, ocrFile: p.ocrFile })),

    readImage: (_runId, pageNo) => {
      const page = cursor.find((p) => p.pageNo === pageNo);
      if (!page) throw new Error(`readImage：run ${runId} 无第 ${pageNo} 页`);
      return { data: new Uint8Array(readFileSync(abs(page.imageFile))), mime: 'image/png' };
    },

    readOcr: (_runId, pageNo) => {
      const page = cursor.find((p) => p.pageNo === pageNo);
      if (!page?.ocrFile) return null;
      const path = abs(page.ocrFile);
      if (!existsSync(path)) return null; // 表里有名、盘上无文件 = 未完成，重跑该页
      return JSON.parse(readFileSync(path, 'utf8')) as OcrPageResult;
    },

    writeOcr: (_runId, pageNo, result) => {
      const rel = PAGE_OCR_REL(pageNo);
      mkdirSync(join(runDir, 'ocr'), { recursive: true });
      writeFileSync(abs(rel), JSON.stringify(result, null, 2), 'utf8');
      return rel;
    },

    writeDrafts: (_runId, drafts, warnings) => {
      writeDraftsFile(runDir, drafts, warnings);
    },

    setWarnings: (_runId, warnings) => runs.setWarnings(runId, warnings, new Date().toISOString()).then(() => undefined),

    updateRun: (_runId, patch) =>
      runs.setStatus(runId, {
        status: patch.status,
        stage: patch.stage,
        ...(patch.error !== undefined ? { error: patch.error } : {}),
        now: new Date().toISOString(),
      }).then(() => undefined),

    markPage: (_runId, pageNo, patch) => {
      const page = cursor.find((p) => p.pageNo === pageNo);
      if (page) {
        if (patch.status !== undefined) page.status = patch.status;
        if (patch.ocrFile !== undefined) page.ocrFile = patch.ocrFile;
      }
      return runs.markPage(runId, pageNo, { ...patch, now: new Date().toISOString() });
    },
  };
}

/** 续跑入口：中断的 run 需要 error/cancelled → ocr 的续跑边（done 不可回退） */
export function isResumable(run: RecogRun): boolean {
  return run.status === 'error' || run.status === 'cancelled';
}
