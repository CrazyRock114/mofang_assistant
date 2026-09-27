// 0035：图片内在尺寸解析（PNG/JPEG/GIF/BMP）——纯函数，零依赖。

import { describe, it, expect } from 'vitest';
import { imageIntrinsicSize, imageTypeOfExtension } from '../../src/docgen/export/docx/image-size.js';

function pngBytes(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  buf.writeUInt32BE(0x89504e47, 0);
  buf.writeUInt32BE(0x0d0a1a0a, 4);
  buf.writeUInt32BE(13, 8); // IHDR 长度
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf[24] = 8; // bit depth
  buf[25] = 6; // color type RGBA
  return buf;
}

function jpegBytes(width: number, height: number): Buffer {
  const parts: number[] = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]; // SOI + APP0
  for (let i = 0; i < 14; i++) parts.push(0x00);
  parts.push(0xff, 0xc0, 0x00, 0x11, 0x08); // SOF0（len=17, 精度 8）
  parts.push((height >> 8) & 0xff, height & 0xff);
  parts.push((width >> 8) & 0xff, width & 0xff);
  parts.push(0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01);
  return Buffer.from(parts);
}

function gifBytes(width: number, height: number): Buffer {
  const buf = Buffer.alloc(13);
  buf.write('GIF89a', 0, 'ascii');
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

function bmpBytes(width: number, height: number): Buffer {
  const buf = Buffer.alloc(26);
  buf.write('BM', 0, 'ascii');
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  return buf;
}

describe('0035 image-size：内在尺寸解析', () => {
  it('PNG/JPEG/GIF/BMP 四格式宽高', () => {
    expect(imageIntrinsicSize(pngBytes(300, 200))).toEqual({ type: 'png', width: 300, height: 200 });
    expect(imageIntrinsicSize(jpegBytes(640, 480))).toEqual({ type: 'jpg', width: 640, height: 480 });
    expect(imageIntrinsicSize(gifBytes(64, 32))).toEqual({ type: 'gif', width: 64, height: 32 });
    expect(imageIntrinsicSize(bmpBytes(20, 10))).toEqual({ type: 'bmp', width: 20, height: 10 });
  });

  it('未知/过短内容 → null（显式降级，不猜尺寸）', () => {
    expect(imageIntrinsicSize(Buffer.from('not-an-image'))).toBeNull();
    expect(imageIntrinsicSize(Buffer.alloc(4))).toBeNull();
  });

  it('扩展名 → docx 图片类型白名单（svg/webp 不在支持面）', () => {
    expect(imageTypeOfExtension('a.PNG')).toBe('png');
    expect(imageTypeOfExtension('a.jpg')).toBe('jpg');
    expect(imageTypeOfExtension('a.jpeg')).toBe('jpg');
    expect(imageTypeOfExtension('a.gif')).toBe('gif');
    expect(imageTypeOfExtension('a.bmp')).toBe('bmp');
    expect(imageTypeOfExtension('a.svg')).toBeNull();
    expect(imageTypeOfExtension('a.webp')).toBeNull();
    expect(imageTypeOfExtension('noext')).toBeNull();
  });
});
