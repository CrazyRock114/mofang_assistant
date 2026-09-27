// zip-utils 测试

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createZip, readZip, type ZipEntry } from '../../src/guard/zip-utils.js';

describe('zip-utils', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `mofang-test-zip-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should create and read a simple ZIP file', () => {
    const zipPath = join(testDir, 'test.zip');
    const entries: ZipEntry[] = [
      { path: 'file1.txt', content: Buffer.from('Hello, World!') },
      { path: 'file2.txt', content: Buffer.from('Another file') },
    ];

    createZip(entries, zipPath);

    expect(existsSync(zipPath)).toBe(true);

    const readEntries = readZip(zipPath);

    expect(readEntries).toHaveLength(2);
    expect(readEntries[0].path).toBe('file1.txt');
    expect(readEntries[0].content.toString()).toBe('Hello, World!');
    expect(readEntries[1].path).toBe('file2.txt');
    expect(readEntries[1].content.toString()).toBe('Another file');
  });

  it('should handle nested paths', () => {
    const zipPath = join(testDir, 'nested.zip');
    const entries: ZipEntry[] = [
      { path: 'dir1/file1.txt', content: Buffer.from('nested1') },
      { path: 'dir1/dir2/file2.txt', content: Buffer.from('nested2') },
      { path: 'root.txt', content: Buffer.from('root') },
    ];

    createZip(entries, zipPath);

    const readEntries = readZip(zipPath);

    expect(readEntries).toHaveLength(3);
    expect(readEntries.find(e => e.path === 'dir1/file1.txt')?.content.toString()).toBe('nested1');
    expect(readEntries.find(e => e.path === 'dir1/dir2/file2.txt')?.content.toString()).toBe('nested2');
    expect(readEntries.find(e => e.path === 'root.txt')?.content.toString()).toBe('root');
  });

  it('should handle binary data', () => {
    const zipPath = join(testDir, 'binary.zip');
    const binaryData = Buffer.from([0x00, 0x01, 0x02, 0xFF, 0xFE, 0xFD]);

    const entries: ZipEntry[] = [
      { path: 'binary.bin', content: binaryData },
    ];

    createZip(entries, zipPath);

    const readEntries = readZip(zipPath);

    expect(readEntries).toHaveLength(1);
    expect(readEntries[0].content).toEqual(binaryData);
  });

  it('should handle empty files', () => {
    const zipPath = join(testDir, 'empty.zip');
    const entries: ZipEntry[] = [
      { path: 'empty.txt', content: Buffer.alloc(0) },
    ];

    createZip(entries, zipPath);

    const readEntries = readZip(zipPath);

    expect(readEntries).toHaveLength(1);
    expect(readEntries[0].content.length).toBe(0);
  });

  it('should handle large files', () => {
    const zipPath = join(testDir, 'large.zip');
    const largeContent = Buffer.alloc(100000).fill('A');

    const entries: ZipEntry[] = [
      { path: 'large.txt', content: largeContent },
    ];

    createZip(entries, zipPath);

    const readEntries = readZip(zipPath);

    expect(readEntries).toHaveLength(1);
    expect(readEntries[0].content.length).toBe(100000);
    expect(readEntries[0].content[0]).toBe(0x41); // 'A'
  });

  it('should handle UTF-8 filenames', () => {
    const zipPath = join(testDir, 'utf8.zip');
    const entries: ZipEntry[] = [
      { path: '中文文件名.txt', content: Buffer.from('中文内容') },
      { path: 'Español.txt', content: Buffer.from('contenido') },
    ];

    createZip(entries, zipPath);

    const readEntries = readZip(zipPath);

    expect(readEntries).toHaveLength(2);
    expect(readEntries.find(e => e.path === '中文文件名.txt')?.content.toString()).toBe('中文内容');
    expect(readEntries.find(e => e.path === 'Español.txt')?.content.toString()).toBe('contenido');
  });

  it('should throw on invalid ZIP file', () => {
    const invalidZipPath = join(testDir, 'invalid.zip');
    require('node:fs').writeFileSync(invalidZipPath, 'not a zip file');

    expect(() => readZip(invalidZipPath)).toThrow();
  });
});
