// 0072（R-073 发布批 lane A）：公告链纯逻辑 ——
// parseAnnounceJson 宽容解析（好/坏/半坏/缺字段/空 messages/安全约束）+ AnnounceService 三级回落链
//（remote → cache → builtin）+ 缓存落盘（临时文件+rename 防半截，0071 先例）。
//
// 环境：node；真 fs（临时目录）；fetch 用可编程假实现注入（不经真网络）。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { parseAnnounceJson } from '../../src/shell/announce/parse-announce.js';
import { AnnounceService, BUILTIN_ANNOUNCE } from '../../src/shell/announce/announce-service.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mofang-0072-announce-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---------------- parseAnnounceJson：宽容解析 ----------------

describe('0072 parseAnnounceJson', () => {
  const GOOD = {
    updatedAt: '2026-09-25T10:00:00Z',
    qrImage: '/assets/qr-group.png',
    downloadUrl: 'https://mofang-assistant.larqitek.com/',
    messages: [
      { id: 'm1', level: 'info', title: '标题一', body: '正文一' },
      { id: 'm2', level: 'warn', title: '标题二', body: '正文二', links: [{ text: '看详情', url: 'https://example.com/a' }] },
      { id: 'm3', level: 'urgent', title: '标题三', body: '正文三' },
    ],
  };

  it('好 JSON 全字段解析保真（含 qrImage/downloadUrl/links）', () => {
    const data = parseAnnounceJson(JSON.stringify(GOOD));
    expect(data).not.toBeNull();
    expect(data!.updatedAt).toBe('2026-09-25T10:00:00Z');
    expect(data!.qrImage).toBe('/assets/qr-group.png');
    expect(data!.downloadUrl).toBe('https://mofang-assistant.larqitek.com/');
    expect(data!.messages).toHaveLength(3);
    expect(data!.messages[0]).toMatchObject({ id: 'm1', level: 'info', title: '标题一', body: '正文一' });
    expect(data!.messages[1].links).toEqual([{ text: '看详情', url: 'https://example.com/a' }]);
  });

  it('坏 JSON（语法错）→ null', () => {
    expect(parseAnnounceJson('{not json')).toBeNull();
  });

  it('半坏：坏条目丢弃留好条目', () => {
    const raw = JSON.stringify({
      updatedAt: '2026-09-25T10:00:00Z',
      messages: [
        { id: 'ok1', level: 'info', title: '好条目', body: '留着' },
        '不是对象',
        { id: '', level: 'info', title: '空 id', body: '丢' },
        { id: 'no-title', level: 'info', body: '缺标题丢' },
        { id: 'no-body', level: 'info', title: '缺正文丢' },
        { id: 'ok2', level: '外星级别', title: '非法级别', body: '降级 info 留着' },
      ],
    });
    const data = parseAnnounceJson(raw);
    expect(data).not.toBeNull();
    expect(data!.messages.map((m) => m.id)).toEqual(['ok1', 'ok2']);
    expect(data!.messages[1].level).toBe('info');
  });

  it('全坏（messages 全部不合法）= 坏 JSON → null', () => {
    const raw = JSON.stringify({ updatedAt: '2026-09-25T10:00:00Z', messages: ['a', 1] });
    expect(parseAnnounceJson(raw)).toBeNull();
  });

  it('缺字段：updatedAt 缺 → null；messages 缺/非数组 → null', () => {
    expect(parseAnnounceJson(JSON.stringify({ messages: [] }))).toBeNull();
    expect(parseAnnounceJson(JSON.stringify({ updatedAt: '2026-09-25' }))).toBeNull();
    expect(parseAnnounceJson(JSON.stringify({ updatedAt: '2026-09-25', messages: 'x' }))).toBeNull();
  });

  it('空 messages 是合法公告（updatedAt 在即可，UI 层不自动弹）', () => {
    const data = parseAnnounceJson(JSON.stringify({ updatedAt: '2026-09-25', messages: [] }));
    expect(data).not.toBeNull();
    expect(data!.messages).toEqual([]);
  });

  it('qrImage 非站点相对路径（不以 / 开头）→ 省略（防外链裂图）', () => {
    const data = parseAnnounceJson(
      JSON.stringify({ updatedAt: '2026-09-25', qrImage: 'http://evil.example.com/qr.png', messages: [] }),
    );
    expect(data!.qrImage).toBeUndefined();
  });

  it('downloadUrl 非 http(s) → 省略（openExternal 只放行 http(s)）', () => {
    const data = parseAnnounceJson(
      JSON.stringify({ updatedAt: '2026-09-25', downloadUrl: 'file:///C:/x', messages: [] }),
    );
    expect(data!.downloadUrl).toBeUndefined();
  });

  it('坏 links 条目丢弃、全坏 links 省略', () => {
    const data = parseAnnounceJson(
      JSON.stringify({
        updatedAt: '2026-09-25',
        messages: [
          {
            id: 'm',
            level: 'info',
            title: 't',
            body: 'b',
            links: [{ text: 'ok', url: 'https://a.b/c' }, 'x', { text: 'no-url' }],
          },
        ],
      }),
    );
    expect(data!.messages[0].links).toEqual([{ text: 'ok', url: 'https://a.b/c' }]);
  });
});

// ---------------- AnnounceService：三级回落链 ----------------

/** 可编程假 fetch：按 URL 前缀决定响应（或抛网络错） */
function makeFetch(opts: { body?: string; status?: number; networkError?: boolean }): typeof fetch {
  return (async () => {
    if (opts.networkError) throw new Error('ECONNREFUSED');
    const status = opts.status ?? 200;
    return new Response(opts.body ?? '', { status });
  }) as unknown as typeof fetch;
}

const CACHE = () => join(root, 'announce-cache.json');

function makeService(fetchImpl: typeof fetch, cachePath: string = CACHE()): AnnounceService {
  return new AnnounceService({ announceUrl: 'https://dist.example/announce.json', cachePath, fetchImpl });
}

describe('0072 AnnounceService 三级回落链', () => {
  it('① remote 成功：source=remote，缓存落盘，getSnapshot 读到内存态', async () => {
    const svc = makeService(makeFetch({ body: JSON.stringify({ updatedAt: '2026-09-25T12:00:00Z', messages: [{ id: 'a', level: 'info', title: 't', body: 'b' }] }) }));
    const snap = await svc.refresh();
    expect(snap.source).toBe('remote');
    expect(snap.data.messages[0].id).toBe('a');
    expect(existsSync(CACHE())).toBe(true);
    const onDisk = JSON.parse(readFileSync(CACHE(), 'utf8')) as { messages: Array<{ id: string }> };
    expect(onDisk.messages[0].id).toBe('a');
    expect(svc.getSnapshot().source).toBe('remote');
  });

  it('② remote 失败 → cache：上次成功缓存被采用，source=cache', async () => {
    // 第一轮：好数据建缓存
    const svc = makeService(makeFetch({ body: JSON.stringify({ updatedAt: '2026-09-25T12:00:00Z', messages: [{ id: 'cached', level: 'info', title: 't', body: 'b' }] }) }));
    await svc.refresh();
    // 第二轮：断网
    const down = makeService(makeFetch({ networkError: true }));
    const snap = await down.refresh();
    expect(snap.source).toBe('cache');
    expect(snap.data.messages[0].id).toBe('cached');
  });

  it('③ remote 失败 + 无缓存 → builtin：内置兜底（指向发布页，无二维码）', async () => {
    const svc = makeService(makeFetch({ networkError: true }));
    const snap = await svc.refresh();
    expect(snap.source).toBe('builtin');
    expect(snap.data).toEqual(BUILTIN_ANNOUNCE);
    expect(snap.data.qrImage).toBeUndefined();
    expect(snap.data.messages.length).toBeGreaterThan(0);
  });

  it('④ remote 坏 JSON → cache → builtin 逐级回落', async () => {
    const svc = makeService(makeFetch({ body: '{bad json' }));
    const snap = await svc.refresh();
    expect(snap.source).toBe('builtin');
  });

  it('⑤ 缓存文件坏 JSON → 跳过缓存用 builtin（不 throw）', async () => {
    writeFileSync(CACHE(), '{broken', 'utf8');
    const svc = makeService(makeFetch({ networkError: true }));
    const snap = await svc.refresh();
    expect(snap.source).toBe('builtin');
  });

  it('⑥ HTTP 非 200 → 视同失败回落', async () => {
    const svc = makeService(makeFetch({ status: 500, body: 'oops' }));
    const snap = await svc.refresh();
    expect(snap.source).toBe('builtin');
  });

  it('⑦ getSnapshot 在任何 refresh 之前调用也不 throw（懒初始化：缓存→builtin）', () => {
    writeFileSync(CACHE(), JSON.stringify({ updatedAt: '2026-09-24', messages: [{ id: 'old', level: 'info', title: 't', body: 'b' }] }), 'utf8');
    const svc = makeService(makeFetch({ networkError: true }));
    const snap = svc.getSnapshot();
    expect(snap.source).toBe('cache');
    expect(snap.data.messages[0].id).toBe('old');
  });

  it('⑧ refresh 永不 throw（fetch 实现抛任意异常也回落 builtin）', async () => {
    const svc = makeService((async () => {
      throw new Error('unexpected');
    }) as unknown as typeof fetch);
    const snap = await svc.refresh();
    expect(snap.source).toBe('builtin');
  });
});
