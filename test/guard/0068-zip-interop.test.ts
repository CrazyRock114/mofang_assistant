// 0068 zip-utils DEFLATE 格式互操作测试
//
// 标准 zip fixture `test/guard/fixtures/0068-standard.zip` 生成命令（Python 3.13 zipfile，DEFLATE，在仓库根执行）：
//   python -c "import zipfile; z=zipfile.ZipFile('test/guard/fixtures/0068-standard.zip','w',zipfile.ZIP_DEFLATED); z.writestr('hello.txt','Hello from standard DEFLATE\n'); z.writestr('logs/app.log','2026-01-01T00:00:00.000Z info python-zipfile fixture line\n'); z.writestr('manifest.json','{\"format\":\"0068-standard\",\"produced_by\":\"python zipfile\"}\n'); z.close()"
//
// 旧格式 fixture `test/guard/fixtures/0068-legacy-zlib-deflate.zip`（0068 之前的 createZip 产物：deflateSync 产出
// zlib 包裹流（RFC1950，0x78 头 + Adler32 尾）冒充 ZIP method 8 要求的 raw DEFLATE（RFC1951）），生成方式：
//   ① git show 6b1f4a4:src/guard/zip-utils.ts > zip-utils-legacy.ts   # 0068 之前的实现（开工锚点版）
//   ② 用该实现的 createZip 打 3 条目包（manifest.json + logs/app.log + logs/capture-collect.log）到上述路径
// 生成物用 `unzip -t` 复核报 invalid compressed data to inflate（旧格式铁证）——readZip 的回退分支必须永久兼容它。
// 注：0066 lane 的实物包 logs/*.zip 会被 probe-0066 复跑覆盖重写，故样本入库。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { createZip, readZip, type ZipEntry } from '../../src/guard/zip-utils.js';

const STANDARD_FIXTURE = fileURLToPath(new URL('./fixtures/0068-standard.zip', import.meta.url));
const LEGACY_FIXTURE = fileURLToPath(new URL('./fixtures/0068-legacy-zlib-deflate.zip', import.meta.url));

/**
 * 测试侧参考实现：只按本地文件头顺序扫描取压缩流原始字节（不读中央目录、不做任何解压）。
 * 解压由调用方显式选择 inflateRawSync（标准）/ inflateSync（旧格式），与生产实现无关。
 */
function rawStreams(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let i = 0;
  while (i + 30 <= buf.length && buf.readUInt32LE(i) === 0x04034b50) {
    const compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.toString('utf8', i + 30, i + 30 + nameLen);
    const start = i + 30 + nameLen + extraLen;
    out.set(name, buf.subarray(start, start + compSize));
    i = start + compSize;
  }
  return out;
}

function entryText(entries: ZipEntry[], path: string): string {
  const entry = entries.find((e) => e.path === path);
  if (!entry) throw new Error(`条目缺失：${path}`);
  return entry.content.toString('utf8');
}

describe('0068 zip-utils DEFLATE 格式互操作', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `mofang-test-zip-0068-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('RED-a: createZip 产物是 raw DEFLATE —— 参考实现 inflateRawSync 逐条目直解成功（不经 readZip）', () => {
    const zipPath = join(testDir, 'raw-deflate.zip');
    const entries: ZipEntry[] = [
      { path: 'hello.txt', content: Buffer.from('Hello from createZip\n') },
      { path: 'logs/app.log', content: Buffer.from('line-1\nline-2\nline-3\n') },
      { path: '中文名.json', content: Buffer.from('{"format":"0068"}\n') },
    ];

    createZip(entries, zipPath);

    const streams = rawStreams(readFileSync(zipPath));
    expect([...streams.keys()].sort()).toEqual(entries.map((e) => e.path).sort());
    for (const entry of entries) {
      const raw = streams.get(entry.path);
      if (!raw) throw new Error(`参考实现未取到条目压缩流：${entry.path}`);
      expect(inflateRawSync(raw)).toEqual(entry.content);
    }
  });

  it('RED-b: readZip 能读标准工具（python zipfile）产出的 zip', () => {
    expect(existsSync(STANDARD_FIXTURE)).toBe(true);

    const entries = readZip(STANDARD_FIXTURE);

    expect(entries.map((e) => e.path).sort()).toEqual(['hello.txt', 'logs/app.log', 'manifest.json']);
    expect(entryText(entries, 'hello.txt')).toBe('Hello from standard DEFLATE\n');
    expect(entryText(entries, 'logs/app.log')).toBe('2026-01-01T00:00:00.000Z info python-zipfile fixture line\n');
    const manifest = JSON.parse(entryText(entries, 'manifest.json')) as { format?: string; produced_by?: string };
    expect(manifest.format).toBe('0068-standard');
    expect(manifest.produced_by).toBe('python zipfile');
  });

  it('兼容锁: readZip 读旧格式（zlib 包裹 deflate）样本 zip 必须成功 —— 回退分支永久保留', () => {
    expect(existsSync(LEGACY_FIXTURE)).toBe(true);

    // 先钉住「这确实是旧格式」：其压缩流按 ZIP 要求的 raw DEFLATE 解不开
    const streams = rawStreams(readFileSync(LEGACY_FIXTURE));
    expect(streams.size).toBeGreaterThan(0);
    for (const raw of streams.values()) {
      expect(() => inflateRawSync(raw)).toThrow();
    }

    // 再钉住 readZip 对存量旧格式的兼容读取
    const entries = readZip(LEGACY_FIXTURE);
    expect(entries.map((e) => e.path).sort()).toEqual(['logs/app.log', 'logs/capture-collect.log', 'manifest.json']);
    const manifest = JSON.parse(entryText(entries, 'manifest.json')) as { format?: string; format_version?: number };
    expect(manifest.format).toBe('mofang-assistant-diagnostics');
    expect(manifest.format_version).toBe(1);
  });

  it('跨格式: createZip 产物 readZip 回读与参考实现 raw 直解口径一致（自造自读之外的第二口径）', () => {
    const zipPath = join(testDir, 'cross-format.zip');
    const entries: ZipEntry[] = [
      { path: 'manifest.json', content: Buffer.from('{"format":"mofang-assistant-diagnostics"}\n') },
      { path: 'logs/app.log', content: Buffer.from('应用启动：日志就绪\n') },
      { path: 'empty.txt', content: Buffer.alloc(0) },
    ];

    createZip(entries, zipPath);

    const viaReadZip = readZip(zipPath);
    const streams = rawStreams(readFileSync(zipPath));
    for (const entry of entries) {
      const raw = streams.get(entry.path);
      if (!raw) throw new Error(`参考实现未取到条目压缩流：${entry.path}`);
      expect(inflateRawSync(raw)).toEqual(entry.content);
      expect(viaReadZip.find((e) => e.path === entry.path)?.content).toEqual(entry.content);
    }
  });
});
