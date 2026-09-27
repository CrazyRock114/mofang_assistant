// 0036 P1：切题工作区主进程宿主单测（任务书 §四 TDD：工作区草稿存取 / 切段 meta 校验 / 页图缓存）
// 用真文件系统（mkdtemp 隔离临时目录）——工作区就是文件态，mock fs 会把最容易错的地方（偏移、覆盖、清理）测没了。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SplitHost } from '../../src/shell/splitting/split-host.js';
import { createEmptyDraft, makeSegment } from '../../src/recog/splitting/workspace-model.js';

const NOW = '2026-09-18T10:00:00.000Z';

let root = '';
let host: SplitHost;

function pdfBytes(size: number): Buffer {
  return Buffer.alloc(size, 0x25); // '%'
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mofang-split-'));
  host = new SplitHost({ root, now: () => NOW });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('0036 P1：建项目', () => {
  it('建目录 + project.json + pages/，返回列表项摘要', async () => {
    const summary = await host.createProject({ sourceName: '教辅 A.pdf', sourceBytes: 1024 });
    expect(summary.name).toBe('教辅 A');
    expect(summary.sourceName).toBe('教辅 A.pdf');
    expect(summary.pageCount).toBe(0);
    expect(summary.segmentCount).toBe(0);
    const dir = join(root, summary.id);
    expect(existsSync(join(dir, 'project.json'))).toBe(true);
    expect(existsSync(join(dir, 'pages'))).toBe(true);
    const meta = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as { sourceBytes: number; createdAt: string };
    expect(meta.sourceBytes).toBe(1024);
    expect(meta.createdAt).toBe(NOW);
  });

  it('name 缺省取源文件名去扩展名；显式 name 优先', async () => {
    const a = await host.createProject({ sourceName: '第 3 章 电磁学.PDF', sourceBytes: 10 });
    expect(a.name).toBe('第 3 章 电磁学');
    const b = await host.createProject({ name: '  高二物理  ', sourceName: 'x.pdf', sourceBytes: 10 });
    expect(b.name).toBe('高二物理');
  });

  it('空文件名被拒（没有溯源就不是工作区）', async () => {
    await expect(host.createProject({ sourceName: '   ', sourceBytes: 10 })).rejects.toThrow(/源文件名/);
  });

  it('非法字节数被拒', async () => {
    await expect(host.createProject({ sourceName: 'a.pdf', sourceBytes: -5 })).rejects.toThrow(/字节数/);
  });
});

describe('0036 P1：源 PDF 分块上传（整本教辅不进单条 IPC 消息）', () => {
  it('顺序追加：两段拼接后与原字节逐位一致', async () => {
    const { id } = await host.createProject({ sourceName: 'a.pdf', sourceBytes: 6 });
    const first = await host.appendSource({ projectId: id, offset: 0, dataBase64: Buffer.from('abc').toString('base64') });
    expect(first.size).toBe(3);
    const second = await host.appendSource({ projectId: id, offset: 3, dataBase64: Buffer.from('def').toString('base64') });
    expect(second.size).toBe(6);
    expect(readFileSync(join(root, id, 'source.pdf')).toString()).toBe('abcdef');
  });

  it('offset 错位被拒（防乱序/重放把副本写坏）', async () => {
    const { id } = await host.createProject({ sourceName: 'a.pdf', sourceBytes: 6 });
    await host.appendSource({ projectId: id, offset: 0, dataBase64: Buffer.from('abc').toString('base64') });
    await expect(
      host.appendSource({ projectId: id, offset: 0, dataBase64: Buffer.from('xyz').toString('base64') }),
    ).rejects.toThrow(/offset/);
    expect(readFileSync(join(root, id, 'source.pdf')).toString()).toBe('abc');
  });

  it('分块读回：offset/length 拼接还原原文，末块 eof=true', async () => {
    const { id } = await host.createProject({ sourceName: 'a.pdf', sourceBytes: 10 });
    await host.appendSource({ projectId: id, offset: 0, dataBase64: Buffer.from('0123456789').toString('base64') });
    const c1 = await host.readSource({ projectId: id, offset: 0, length: 4 });
    expect(Buffer.from(c1.dataBase64, 'base64').toString()).toBe('0123');
    expect(c1.eof).toBe(false);
    const c2 = await host.readSource({ projectId: id, offset: 4, length: 4 });
    expect(Buffer.from(c2.dataBase64, 'base64').toString()).toBe('4567');
    const c3 = await host.readSource({ projectId: id, offset: 8, length: 4 });
    expect(Buffer.from(c3.dataBase64, 'base64').toString()).toBe('89');
    expect(c3.eof).toBe(true);
  });

  it('读越界位置返回空块且 eof=true（不抛错，调用方按空块收尾）', async () => {
    const { id } = await host.createProject({ sourceName: 'a.pdf', sourceBytes: 3 });
    await host.appendSource({ projectId: id, offset: 0, dataBase64: Buffer.from('abc').toString('base64') });
    const out = await host.readSource({ projectId: id, offset: 99, length: 4 });
    expect(out.dataBase64).toBe('');
    expect(out.eof).toBe(true);
  });

  it('单次读长度被夹到上限（防一次读回整个 PDF）', async () => {
    const { id } = await host.createProject({ sourceName: 'a.pdf', sourceBytes: 40 });
    await host.appendSource({ projectId: id, offset: 0, dataBase64: pdfBytes(40).toString('base64') });
    const out = await host.readSource({ projectId: id, offset: 0, length: 999_999_999 });
    expect(Buffer.from(out.dataBase64, 'base64').length).toBe(40);
    expect(out.eof).toBe(true);
  });
});

describe('0036 P1：项目元保存（页数 + 切段硬校验）', () => {
  it('段页码越界 → 拒绝且不写盘（工作区不被半合法数据污染）', async () => {
    const { id } = await host.createProject({ sourceName: 'a.pdf', sourceBytes: 3 });
    await host.appendSource({ projectId: id, offset: 0, dataBase64: Buffer.from('abc').toString('base64') });
    await expect(
      host.saveMeta({ projectId: id, pageCount: 10, segments: [makeSegment('seg1', 1, 99, NOW)] }),
    ).rejects.toThrow(/越界/);
    const meta = JSON.parse(readFileSync(join(root, id, 'project.json'), 'utf8')) as { pageCount: number };
    expect(meta.pageCount).toBe(0);
  });

  it('副本字节数与登记不一致 → 拒绝（上传没传完不许开工）', async () => {
    const { id } = await host.createProject({ sourceName: 'a.pdf', sourceBytes: 100 });
    await host.appendSource({ projectId: id, offset: 0, dataBase64: Buffer.from('abc').toString('base64') });
    await expect(
      host.saveMeta({ projectId: id, pageCount: 10, segments: [makeSegment('seg1', 1, 10, NOW)] }),
    ).rejects.toThrow(/源文件/);
  });

  it('合法时写盘并返回摘要（段数与页数入摘要）', async () => {
    const { id } = await host.createProject({ sourceName: 'a.pdf', sourceBytes: 3 });
    await host.appendSource({ projectId: id, offset: 0, dataBase64: Buffer.from('abc').toString('base64') });
    const summary = await host.saveMeta({
      projectId: id,
      pageCount: 32,
      segments: [makeSegment('seg1', 1, 15, NOW), makeSegment('seg2', 16, 32, NOW)],
    });
    expect(summary.pageCount).toBe(32);
    expect(summary.segmentCount).toBe(2);
  });

  it('非整数/越界页数被拒', async () => {
    const { id } = await host.createProject({ sourceName: 'a.pdf', sourceBytes: 3 });
    await host.appendSource({ projectId: id, offset: 0, dataBase64: Buffer.from('abc').toString('base64') });
    await expect(host.saveMeta({ projectId: id, pageCount: 1.5, segments: [] })).rejects.toThrow(/页数/);
    await expect(host.saveMeta({ projectId: id, pageCount: 99999, segments: [] })).rejects.toThrow(/页数/);
  });
});

describe('0036 P1：草稿存取与恢复', () => {
  it('saveDraft 落盘 → openProject 原样读回（关页可续）', async () => {
    const { id } = await host.createProject({ sourceName: 'a.pdf', sourceBytes: 3 });
    const draft = createEmptyDraft(NOW);
    const saved = await host.saveDraft({
      projectId: id,
      draft: {
        ...draft,
        segments: {
          seg1: { boxes: [{ id: 'p1-b1', qid: 'q1', type: 'text', page: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.1 }], runs: [] },
        },
      },
    });
    expect(saved.savedAt).toBe(NOW);
    const opened = await host.openProject({ projectId: id });
    expect(opened.draft.segments.seg1.boxes).toHaveLength(1);
    expect(opened.draft.segments.seg1.boxes[0].qid).toBe('q1');
  });

  it('尚无草稿时给空草稿（新项目直接能画框）', async () => {
    const { id } = await host.createProject({ sourceName: 'a.pdf', sourceBytes: 3 });
    const opened = await host.openProject({ projectId: id });
    expect(opened.draft.segments).toEqual({});
    expect(opened.draft.version).toBe(1);
  });

  it('草稿 JSON 损坏 → 回落空草稿，不让整个项目打不开', async () => {
    const { id } = await host.createProject({ sourceName: 'a.pdf', sourceBytes: 3 });
    writeFileSync(join(root, id, 'draft.json'), '{ 这不是 JSON', 'utf8');
    const opened = await host.openProject({ projectId: id });
    expect(opened.draft.segments).toEqual({});
    expect(opened.meta.id).toBe(id);
  });
});

describe('0036 P1：项目列表与删除', () => {
  it('列表按 updatedAt 倒序，跳过目录缺失 project.json 的残骸', async () => {
    const a = await host.createProject({ sourceName: 'a.pdf', sourceBytes: 3 });
    const later = new SplitHost({ root, now: () => '2026-09-18T11:00:00.000Z' });
    const b = await later.createProject({ sourceName: 'b.pdf', sourceBytes: 3 });
    mkdirSync(join(root, 'broken-dir'), { recursive: true });
    const list = await host.listProjects();
    expect(list.map((p) => p.id)).toEqual([b.id, a.id]);
  });

  it('删除项目连同工作区目录（含页图缓存）', async () => {
    const { id } = await host.createProject({ sourceName: 'a.pdf', sourceBytes: 3 });
    await host.writePage({ projectId: id, pageNo: 1, dataBase64: Buffer.from('x').toString('base64') });
    await host.removeProject({ projectId: id });
    expect(existsSync(join(root, id))).toBe(false);
    await expect(host.openProject({ projectId: id })).rejects.toThrow(/不存在/);
  });

  it('路径穿越的 projectId 一律拒绝（工作区根外不可触达）', async () => {
    const evil = '../../etc';
    await expect(host.openProject({ projectId: evil })).rejects.toThrow(/非法/);
    await expect(host.removeProject({ projectId: evil })).rejects.toThrow(/非法/);
    await expect(
      host.appendSource({ projectId: evil, offset: 0, dataBase64: 'AA==' }),
    ).rejects.toThrow(/非法/);
  });
});

describe('0036 P1：页图缓存', () => {
  it('写入后读回逐位一致，相对路径形如 pages/p001.png', async () => {
    const { id } = await host.createProject({ sourceName: 'a.pdf', sourceBytes: 3 });
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    const written = await host.writePage({ projectId: id, pageNo: 1, dataBase64: bytes.toString('base64') });
    expect(written.file).toBe('pages/p001.png');
    expect(statSync(join(root, id, 'pages', 'p001.png')).size).toBe(6);
    const read = await host.readPage({ projectId: id, pageNo: 1 });
    expect(read.dataBase64).toBe(bytes.toString('base64'));
  });

  it('三位补零（p007）批量页序不串位', async () => {
    const { id } = await host.createProject({ sourceName: 'a.pdf', sourceBytes: 3 });
    expect((await host.writePage({ projectId: id, pageNo: 7, dataBase64: 'AA==' })).file).toBe('pages/p007.png');
    expect((await host.writePage({ projectId: id, pageNo: 123, dataBase64: 'AA==' })).file).toBe('pages/p123.png');
  });

  it('未缓存的页返回 null（渲染层据此回落重新栅格化）', async () => {
    const { id } = await host.createProject({ sourceName: 'a.pdf', sourceBytes: 3 });
    expect((await host.readPage({ projectId: id, pageNo: 42 })).dataBase64).toBeNull();
  });

  it('非法页号被拒', async () => {
    const { id } = await host.createProject({ sourceName: 'a.pdf', sourceBytes: 3 });
    await expect(host.writePage({ projectId: id, pageNo: 0, dataBase64: 'AA==' })).rejects.toThrow(/页号/);
    await expect(host.readPage({ projectId: id, pageNo: -1 })).rejects.toThrow(/页号/);
  });
});
