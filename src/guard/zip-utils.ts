// 最小 ZIP 读写工具 — 使用 Node.js 内置 zlib + 手写 ZIP 格式
// 仅支持 DEFLATE 压缩，足够本项目备份/恢复使用

import { deflateRawSync, inflateRawSync, inflateSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * ZIP 文件条目
 */
export interface ZipEntry {
  /** 文件路径（ZIP 内部路径，使用 / 分隔符） */
  path: string;
  /** 文件内容（Buffer） */
  content: Buffer;
}

/**
 * 创建 ZIP 文件
 *
 * 格式说明：
 * - 压缩方法 8 = raw DEFLATE（RFC1951，无 zlib 头尾）——ZIP 规范要求，标准工具（unzip/python zipfile/
 *   Windows 资源管理器）据此解压；0068 之前误用 deflateSync（zlib 包裹流），产出的包只有本项目 readZip 能解。
 * - 本地文件头 + 压缩数据（每个文件）
 * - 中央目录（所有文件）
 * - 结束记录
 */
export function createZip(entries: ZipEntry[], outputPath: string): void {
  const localFileHeaders: Buffer[] = [];
  const compressedData: Buffer[] = [];
  const centralDirectory: Buffer[] = [];

  let offset = 0;

  for (const entry of entries) {
    const compressed = deflateRawSync(entry.content);
    const pathBuffer = Buffer.from(entry.path, 'utf8');

    const crc32 = calculateCrc32(entry.content);

    // 本地文件头
    const localHeader = Buffer.alloc(30 + pathBuffer.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // 签名
    localHeader.writeUInt16LE(20, 4); // 版本
    localHeader.writeUInt16LE(0, 6); // 标志
    localHeader.writeUInt16LE(8, 8); // 压缩方法（8 = DEFLATE）
    localHeader.writeUInt16LE(0, 10); // 修改时间
    localHeader.writeUInt16LE(0, 12); // 修改日期
    localHeader.writeUInt32LE(crc32, 14); // CRC-32
    localHeader.writeUInt32LE(compressed.length, 18); // 压缩后大小
    localHeader.writeUInt32LE(entry.content.length, 22); // 原始大小
    localHeader.writeUInt16LE(pathBuffer.length, 26); // 文件名长度
    localHeader.writeUInt16LE(0, 28); // 扩展字段长度
    pathBuffer.copy(localHeader, 30);

    localFileHeaders.push(localHeader);
    compressedData.push(compressed);

    // 中央目录条目
    const centralHeader = Buffer.alloc(46 + pathBuffer.length);
    centralHeader.writeUInt32LE(0x02014b50, 0); // 签名
    centralHeader.writeUInt16LE(20, 4); // 创建版本
    centralHeader.writeUInt16LE(20, 6); // 提取版本
    centralHeader.writeUInt16LE(0, 8); // 标志
    centralHeader.writeUInt16LE(8, 10); // 压缩方法
    centralHeader.writeUInt16LE(0, 12); // 修改时间
    centralHeader.writeUInt16LE(0, 14); // 修改日期
    centralHeader.writeUInt32LE(crc32, 16); // CRC-32
    centralHeader.writeUInt32LE(compressed.length, 20); // 压缩后大小
    centralHeader.writeUInt32LE(entry.content.length, 24); // 原始大小
    centralHeader.writeUInt16LE(pathBuffer.length, 28); // 文件名长度
    centralHeader.writeUInt16LE(0, 30); // 扩展字段长度
    centralHeader.writeUInt16LE(0, 32); // 注释长度
    centralHeader.writeUInt16LE(0, 34); // 磁盘号
    centralHeader.writeUInt16LE(0, 36); // 内部属性
    centralHeader.writeUInt32LE(0, 38); // 外部属性
    centralHeader.writeUInt32LE(offset, 42); // 本地头偏移
    pathBuffer.copy(centralHeader, 46);

    centralDirectory.push(centralHeader);

    offset += localHeader.length + compressed.length;
  }

  // 中央目录偏移
  const centralDirOffset = offset;
  const centralDirSize = centralDirectory.reduce((sum, buf) => sum + buf.length, 0);

  // 结束记录
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0); // 签名
  endRecord.writeUInt16LE(0, 4); // 当前磁盘号
  endRecord.writeUInt16LE(0, 6); // 中央目录起始磁盘号
  endRecord.writeUInt16LE(entries.length, 8); // 当前磁盘条目数
  endRecord.writeUInt16LE(entries.length, 10); // 总条目数
  endRecord.writeUInt32LE(centralDirSize, 12); // 中央目录大小
  endRecord.writeUInt32LE(centralDirOffset, 16); // 中央目录偏移
  endRecord.writeUInt16LE(0, 20); // 注释长度

  // 组装最终 ZIP
  const parts: Buffer[] = [];
  for (let i = 0; i < entries.length; i++) {
    parts.push(localFileHeaders[i]);
    parts.push(compressedData[i]);
  }
  parts.push(...centralDirectory);
  parts.push(endRecord);

  const zipBuffer = Buffer.concat(parts);
  writeFileSync(outputPath, zipBuffer);
}

/**
 * 解压 method 8 条目数据（两类格式并存，都必须长期可读）：
 * - raw DEFLATE（RFC1951）：0068 起 createZip 产出的标准格式，也是 unzip / python zipfile / 资源管理器的口径；
 * - zlib 包裹流（RFC1950，0x78 头 + Adler32 尾）：0068 之前 createZip 误用 deflateSync 产出，已落盘的
 *   用户备份与已导出诊断包是这种格式，不回溯转换 ⇒ 此回退分支永久保留。
 */
function inflateDeflateEntry(data: Buffer): Buffer {
  try {
    return inflateRawSync(data);
  } catch {
    return inflateSync(data);
  }
}

/**
 * 读取 ZIP 文件
 */
export function readZip(zipPath: string): ZipEntry[] {
  const buffer = readFileSync(zipPath);
  const entries: ZipEntry[] = [];

  // 查找中央目录结束记录
  let endRecordPos = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      endRecordPos = i;
      break;
    }
  }

  if (endRecordPos === -1) {
    throw new Error('Invalid ZIP file: end of central directory not found');
  }

  const entryCount = buffer.readUInt16LE(endRecordPos + 10);
  const centralDirOffset = buffer.readUInt32LE(endRecordPos + 16);

  // 读取中央目录
  let pos = centralDirOffset;
  for (let i = 0; i < entryCount; i++) {
    if (buffer.readUInt32LE(pos) !== 0x02014b50) {
      throw new Error('Invalid ZIP file: central directory signature mismatch');
    }

    const fileNameLength = buffer.readUInt16LE(pos + 28);
    const extraFieldLength = buffer.readUInt16LE(pos + 30);
    const commentLength = buffer.readUInt16LE(pos + 32);
    const localHeaderOffset = buffer.readUInt32LE(pos + 42);

    const path = buffer.toString('utf8', pos + 46, pos + 46 + fileNameLength);

    // 读取本地文件头和数据
    const localPos = localHeaderOffset;
    if (buffer.readUInt32LE(localPos) !== 0x04034b50) {
      throw new Error('Invalid ZIP file: local file header signature mismatch');
    }

    const compressionMethod = buffer.readUInt16LE(localPos + 8);
    const compressedSize = buffer.readUInt32LE(localPos + 18);
    const uncompressedSize = buffer.readUInt32LE(localPos + 22);
    const localFileNameLength = buffer.readUInt16LE(localPos + 26);
    const localExtraFieldLength = buffer.readUInt16LE(localPos + 28);

    const dataStart = localPos + 30 + localFileNameLength + localExtraFieldLength;
    const compressedData = buffer.subarray(dataStart, dataStart + compressedSize);

    let content: Buffer;
    if (compressionMethod === 8) {
      // DEFLATE（标准 raw 优先，存量旧格式回退；见 inflateDeflateEntry）
      content = inflateDeflateEntry(compressedData);
    } else if (compressionMethod === 0) {
      // 无压缩
      content = compressedData;
    } else {
      throw new Error(`Unsupported compression method: ${compressionMethod}`);
    }

    if (content.length !== uncompressedSize) {
      throw new Error(`Size mismatch for ${path}: expected ${uncompressedSize}, got ${content.length}`);
    }

    entries.push({ path, content });

    pos += 46 + fileNameLength + extraFieldLength + commentLength;
  }

  return entries;
}

/**
 * CRC-32 计算（ZIP 格式要求）
 */
function calculateCrc32(buffer: Buffer): number {
  let crc = 0xffffffff;

  for (let i = 0; i < buffer.length; i++) {
    crc = crc ^ buffer[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}
