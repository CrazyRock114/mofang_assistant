// 0036 P1：PDF 切题工作区主进程宿主（工作区文件态的唯一 IO 口）
// 职责边界（对齐 0028 RecogHost 的接线层定位）：
//   - 本层只做 fs + 校验，不碰 SQL（工作区是纯文件态，本单无迁移）、不碰识别编排（复用 recog.run.*）
//   - 渲染层交付的是「归一化框 + 段 meta + 草稿」，本层落盘并做硬校验；几何/校验真源在 recog/splitting
//
// 目录布局 <root>/<项目 id>/：
//   project.json   项目元（源文件名 + 字节数 + 页数 + 切段 meta）
//   source.pdf     源 PDF 副本（自包含；分块 append 写入、分块 read 读出）
//   draft.json     草稿（按段独立；渲染层 1.5s 防抖后写，主进程不解释内容）
//   pages/pNNN.png 页图缓存
//
// 安全：项目 id 只接受 UUID 形态，任何含分隔符/相对段的 id 直接拒绝——工作区根外不可触达。

import { randomUUID } from 'node:crypto';
import {
  appendFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, closeSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';

import type {
  SplitDraft, SplitPageReadPayload, SplitPageReadResult, SplitPageWritePayload, SplitPageWriteResult,
  SplitProjectCreatePayload, SplitProjectDetail, SplitProjectIdPayload, SplitProjectMeta,
  SplitProjectSaveDraftPayload, SplitProjectSaveDraftResult, SplitProjectSaveMetaPayload,
  SplitProjectSummary, SplitSegment, SplitSourceAppendPayload, SplitSourceAppendResult,
  SplitSourceReadPayload, SplitSourceReadResult,
} from '../../shared/contracts/split-types.js';
import { sanitizeDraft, segmentsBlockingSave, toSummary, validateSegments } from '../../recog/splitting/workspace-model.js';
import type { RawSplitDraft } from '../../recog/splitting/workspace-model.js';

/** 单次读源 PDF 的字节上限（8MB）：渲染层按此循环拼装，单条 IPC 消息水位可控 */
export const SOURCE_READ_MAX_BYTES = 8 * 1024 * 1024;
/** 单次追加字节上限（8MB）：与读对称，防一条消息塞进整本教辅 */
export const SOURCE_APPEND_MAX_BYTES = 8 * 1024 * 1024;
/** 页数上限（保护：真出问题也不会把 UI 撑成 10 万页列表） */
export const MAX_PAGE_COUNT = 5000;

const PROJECT_DIR = 'project.json';
const SOURCE_FILE = 'source.pdf';
const DRAFT_FILE = 'draft.json';
const PAGES_DIR = 'pages';

/** 项目 id 形态（randomUUID）；用于把所有外部传入的 id 挡在路径拼接之外 */
const PROJECT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SplitHostDeps {
  /** 工作区根目录（<userData>/data/splitting） */
  root: string;
  now?: () => string;
}

export class SplitHost {
  constructor(private readonly deps: SplitHostDeps) {
    mkdirSync(deps.root, { recursive: true });
  }

  // ---------- 项目 ----------

  async createProject(payload: SplitProjectCreatePayload): Promise<SplitProjectSummary> {
    const sourceName = typeof payload.sourceName === 'string' ? payload.sourceName.trim() : '';
    if (!sourceName) throw new Error('Invalid payload.sourceName（源文件名不能为空）');
    if (!Number.isInteger(payload.sourceBytes) || payload.sourceBytes < 0) {
      throw new Error('Invalid payload.sourceBytes（源文件字节数须为非负整数）');
    }
    const now = this.now();
    const id = randomUUID();
    const meta: SplitProjectMeta = {
      id,
      name: payload.name?.trim() ? payload.name.trim() : stripExtension(sourceName),
      sourceName,
      sourceBytes: payload.sourceBytes,
      pageCount: 0,
      segments: [],
      createdAt: now,
      updatedAt: now,
    };
    const dir = this.projectDir(id);
    mkdirSync(join(dir, PAGES_DIR), { recursive: true });
    this.writeMeta(meta);
    return toSummary(meta);
  }

  async listProjects(): Promise<SplitProjectSummary[]> {
    if (!existsSync(this.deps.root)) return [];
    const out: SplitProjectSummary[] = [];
    for (const entry of readdirSafe(this.deps.root)) {
      if (!PROJECT_ID_RE.test(entry)) continue; // 残骸/手建目录不进列表
      const meta = this.readMetaOrNull(entry);
      if (meta) out.push(toSummary(meta));
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async openProject(payload: SplitProjectIdPayload): Promise<SplitProjectDetail> {
    const id = this.requireProjectId(payload.projectId);
    const meta = this.readMetaOrNull(id);
    if (!meta) throw new Error(`切题项目不存在：${id}`);
    return { meta, draft: this.readDraft(id) };
  }

  async removeProject(payload: SplitProjectIdPayload): Promise<void> {
    const id = this.requireProjectId(payload.projectId);
    const dir = this.projectDir(id);
    if (resolve(dir) === resolve(this.deps.root)) throw new Error('拒绝删除工作区根目录');
    rmSync(dir, { recursive: true, force: true });
  }

  async saveMeta(payload: SplitProjectSaveMetaPayload): Promise<SplitProjectSummary> {
    const id = this.requireProjectId(payload.projectId);
    const meta = this.readMetaOrNull(id);
    if (!meta) throw new Error(`切题项目不存在：${id}`);

    if (!Number.isInteger(payload.pageCount) || payload.pageCount < 0 || payload.pageCount > MAX_PAGE_COUNT) {
      throw new Error(`Invalid payload.pageCount（页数须为 0–${MAX_PAGE_COUNT} 的整数）`);
    }
    const segments = payload.segments ?? [];
    const blocking = segmentsBlockingSave(validateSegments(segments, payload.pageCount));
    if (blocking.length > 0) {
      throw new Error(`切段校验未通过：${blocking.join('；')}`);
    }

    // 副本完整性：登记了字节数就必须一致——上传没传完不许开工（截断的 PDF 渲染会静默少页）
    const sourcePath = join(this.projectDir(id), SOURCE_FILE);
    if (!existsSync(sourcePath)) throw new Error('源文件尚未上传（source.pdf 缺失）');
    const actual = statSync(sourcePath).size;
    if (meta.sourceBytes > 0 && actual !== meta.sourceBytes) {
      throw new Error(`源文件不完整：已登记 ${meta.sourceBytes} 字节，实际 ${actual} 字节（请重新导入）`);
    }

    const next: SplitProjectMeta = {
      ...meta,
      sourceBytes: actual,
      pageCount: payload.pageCount,
      segments: segments.map(normalizeSegment),
      updatedAt: this.now(),
    };
    this.writeMeta(next);
    return toSummary(next);
  }

  // ---------- 源 PDF（分块） ----------

  async appendSource(payload: SplitSourceAppendPayload): Promise<SplitSourceAppendResult> {
    const id = this.requireProjectId(payload.projectId);
    if (!Number.isInteger(payload.offset) || payload.offset < 0) {
      throw new Error('Invalid payload.offset（非负整数）');
    }
    const buffer = decodeBase64(payload.dataBase64, 'payload.dataBase64');
    if (buffer.length > SOURCE_APPEND_MAX_BYTES) {
      throw new Error(`单次追加超过上限 ${SOURCE_APPEND_MAX_BYTES} 字节`);
    }
    const path = join(this.projectDir(id), SOURCE_FILE);
    const size = existsSync(path) ? statSync(path).size : 0;
    if (payload.offset !== size) {
      throw new Error(`offset 错位：期望 ${size}，收到 ${payload.offset}（分块必须顺序追加）`);
    }
    appendFileSync(path, buffer);
    return { size: size + buffer.length };
  }

  /** 未上传/项目不存在时返回空块 + eof（调用方按「没有源文件」处理，不必多一条通道问存在性） */
  async readSource(payload: SplitSourceReadPayload): Promise<SplitSourceReadResult> {
    const id = this.requireProjectId(payload.projectId);
    if (!Number.isInteger(payload.offset) || payload.offset < 0) {
      throw new Error('Invalid payload.offset（非负整数）');
    }
    if (!Number.isInteger(payload.length) || payload.length <= 0) {
      throw new Error('Invalid payload.length（正整数）');
    }
    const path = join(this.projectDir(id), SOURCE_FILE);
    if (!existsSync(path)) return { dataBase64: '', eof: true };
    const total = statSync(path).size;
    if (payload.offset >= total) return { dataBase64: '', eof: true };

    const length = Math.min(payload.length, SOURCE_READ_MAX_BYTES, total - payload.offset);
    const buffer = Buffer.alloc(length);
    const fd = openSync(path, 'r');
    try {
      readSync(fd, buffer, 0, length, payload.offset);
    } finally {
      closeSync(fd);
    }
    return { dataBase64: buffer.toString('base64'), eof: payload.offset + length >= total };
  }

  // ---------- 草稿 ----------

  async saveDraft(payload: SplitProjectSaveDraftPayload): Promise<SplitProjectSaveDraftResult> {
    const id = this.requireProjectId(payload.projectId);
    const meta = this.readMetaOrNull(id);
    if (!meta) throw new Error(`切题项目不存在：${id}`);
    if (!payload.draft || typeof payload.draft !== 'object' || !payload.draft.segments) {
      throw new Error('Invalid payload.draft（须为 { version, segments } 结构）');
    }
    const savedAt = this.now();
    const draft: SplitDraft = { version: 1, segments: payload.draft.segments, updatedAt: savedAt };
    writeFileSync(join(this.projectDir(id), DRAFT_FILE), JSON.stringify(draft, null, 2), 'utf8');
    const next: SplitProjectMeta = { ...meta, updatedAt: savedAt };
    this.writeMeta(next);
    return { savedAt };
  }

  // ---------- 页图缓存 ----------

  async writePage(payload: SplitPageWritePayload): Promise<SplitPageWriteResult> {
    const id = this.requireProjectId(payload.projectId);
    const pageNo = requirePageNo(payload.pageNo);
    const buffer = decodeBase64(payload.dataBase64, 'payload.dataBase64');
    const rel = pageRel(pageNo);
    mkdirSync(join(this.projectDir(id), PAGES_DIR), { recursive: true });
    writeFileSync(join(this.projectDir(id), rel), buffer);
    return { file: rel };
  }

  async readPage(payload: SplitPageReadPayload): Promise<SplitPageReadResult> {
    const id = this.requireProjectId(payload.projectId);
    const pageNo = requirePageNo(payload.pageNo);
    const path = join(this.projectDir(id), pageRel(pageNo));
    if (!existsSync(path)) return { dataBase64: null };
    return { dataBase64: readFileSync(path).toString('base64') };
  }

  // ---------- 内部 ----------

  private projectDir(id: string): string {
    const dir = join(this.deps.root, id);
    // 双保险：id 已过正则，这里再确认解析结果确实落在根目录内（防日后放宽 id 形态时失守）
    const rootResolved = resolve(this.deps.root);
    const dirResolved = resolve(dir);
    if (dirResolved !== rootResolved && !dirResolved.startsWith(rootResolved + sep)) {
      throw new Error(`非法项目路径：${id}`);
    }
    return dir;
  }

  private requireProjectId(value: string): string {
    if (typeof value !== 'string' || !PROJECT_ID_RE.test(value)) {
      throw new Error(`非法项目 id：${String(value)}`);
    }
    return value;
  }

  private writeMeta(meta: SplitProjectMeta): void {
    writeFileSync(join(this.projectDir(meta.id), PROJECT_DIR), JSON.stringify(meta, null, 2), 'utf8');
  }

  private readMetaOrNull(id: string): SplitProjectMeta | null {
    const path = join(this.projectDir(id), PROJECT_DIR);
    if (!existsSync(path)) return null;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as SplitProjectMeta;
      if (typeof raw?.id !== 'string' || typeof raw?.sourceName !== 'string') return null;
      return {
        id: raw.id,
        name: typeof raw.name === 'string' && raw.name ? raw.name : stripExtension(raw.sourceName),
        sourceName: raw.sourceName,
        sourceBytes: Number.isFinite(raw.sourceBytes) ? raw.sourceBytes : 0,
        pageCount: Number.isFinite(raw.pageCount) ? raw.pageCount : 0,
        segments: Array.isArray(raw.segments) ? raw.segments.map(normalizeSegment) : [],
        createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : this.now(),
        updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : this.now(),
      };
    } catch {
      return null;
    }
  }

  /** 读草稿：损坏/缺失一律回落空草稿——草稿坏掉不该让整个项目打不开（用户的框比草稿文件重要） */
  private readDraft(id: string): SplitDraft {
    const now = this.now();
    const path = join(this.projectDir(id), DRAFT_FILE);
    if (!existsSync(path)) return { version: 1, segments: {}, updatedAt: now };
    try {
      return sanitizeDraft(JSON.parse(readFileSync(path, 'utf8')) as RawSplitDraft, now);
    } catch {
      return { version: 1, segments: {}, updatedAt: now };
    }
  }

  private now(): string {
    return this.deps.now ? this.deps.now() : new Date().toISOString();
  }
}

// ---------- 纯工具 ----------

function stripExtension(name: string): string {
  return name.replace(/\.[a-z0-9]+$/i, '');
}

function pageRel(pageNo: number): string {
  return `${PAGES_DIR}/p${String(pageNo).padStart(3, '0')}.png`;
}

function requirePageNo(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_COUNT) {
    throw new Error(`Invalid pageNo（页号须为 1–${MAX_PAGE_COUNT} 的整数）`);
  }
  return value;
}

function decodeBase64(value: string, field: string): Buffer {
  if (typeof value !== 'string' || value === '') throw new Error(`Invalid ${field}`);
  const buffer = Buffer.from(value, 'base64');
  if (buffer.length === 0) throw new Error(`Invalid ${field}（解码后为空）`);
  return buffer;
}

function normalizeSegment(seg: SplitSegment): SplitSegment {
  return {
    id: String(seg.id),
    title: String(seg.title ?? ''),
    fromPage: Math.round(Number(seg.fromPage)),
    toPage: Math.round(Number(seg.toPage)),
    createdAt: typeof seg.createdAt === 'string' ? seg.createdAt : new Date().toISOString(),
  };
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
