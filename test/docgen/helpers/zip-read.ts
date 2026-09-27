// 0035 测试辅助：最小 zip 读取（docx 产物 = zip；本地头顺序扫描，store/deflate 两法）。
// 不引第三方解包依赖；docx（jszip）产物本地头含尺寸（探针已实证），无需读 data descriptor。

import { inflateRawSync } from 'node:zlib';

/** 读取 zip 全部条目：name → 解压后 Buffer */
export function readZipEntries(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let i = 0;
  while (i + 30 <= buf.length && buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8);
    const compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.toString('utf8', i + 30, i + 30 + nameLen);
    const dataStart = i + 30 + nameLen + extraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    out.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
    i = dataStart + compSize;
  }
  return out;
}

/** 取 word/document.xml 文本 */
export function documentXml(buf: Buffer): string {
  const xml = readZipEntries(buf).get('word/document.xml');
  if (!xml) throw new Error('docx 产物缺 word/document.xml');
  return xml.toString('utf8');
}

/** 计数：子串出现次数 */
export function countOf(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx >= 0) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}
