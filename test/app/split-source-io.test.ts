// 0036 P1：源 PDF 分块上传/读回（渲染层侧）单测
// 整本教辅可达数十 MB，一次性 base64 过桥会把 IPC 消息撑到百 MB 级；分块循环是这里最容易错的
// （offset 记错 → 字节静默错位 → pdfjs 解析失败或渲染出乱页），故独立成可测层。

import { describe, it, expect, vi } from 'vitest';
import {
  SOURCE_CHUNK_BYTES, bytesToBase64, base64ToBytes, readSourceBytes, uploadSourceBytes,
} from '../../src/app/splitting/source-io.js';
import type { MofangSplitBridge } from '../../src/shared/contracts/bridge.js';

/** 测试用小块（生产块 4MB：真编 4MB base64 会让本文件从毫秒级变成秒级，拖累 gate 预算） */
const TEST_CHUNK = 1024;

/** 内存假宿主：append/read 语义与真 SplitHost 对齐（含 offset 校验与 eof） */
function makeFakeBridge(initial: Uint8Array = new Uint8Array()): MofangSplitBridge & { stored: () => Uint8Array } {
  let data = initial;
  const bridge = {
    createProject: vi.fn(),
    appendSource: vi.fn(async (payload: { offset: number; dataBase64: string }) => {
      const chunk = base64ToBytes(payload.dataBase64);
      if (payload.offset !== data.length) throw new Error(`offset 错位：期望 ${data.length}，收到 ${payload.offset}`);
      const next = new Uint8Array(data.length + chunk.length);
      next.set(data, 0);
      next.set(chunk, data.length);
      data = next;
      return { size: data.length };
    }),
    readSource: vi.fn(async (payload: { offset: number; length: number }) => {
      if (payload.offset >= data.length) return { dataBase64: '', eof: true };
      const end = Math.min(data.length, payload.offset + payload.length);
      return { dataBase64: bytesToBase64(data.subarray(payload.offset, end)), eof: end >= data.length };
    }),
    saveMeta: vi.fn(),
    saveDraft: vi.fn(),
    listProjects: vi.fn(),
    openProject: vi.fn(),
    removeProject: vi.fn(),
    writePage: vi.fn(),
    readPage: vi.fn(),
    stored: () => data,
  };
  return bridge as unknown as MofangSplitBridge & { stored: () => Uint8Array };
}

describe('0036 P1：base64 往返（renderer 侧，不依赖 Buffer）', () => {
  it('往返逐位一致（含 0x00 与 0xff 边界字节）', () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255, 128, 127]);
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
  });

  it('空数组往返为空', () => {
    expect(base64ToBytes(bytesToBase64(new Uint8Array())).length).toBe(0);
  });
});

describe('0036 P1：分块上传', () => {
  it('大字节按块切分，拼回原文逐位一致', async () => {
    const bridge = makeFakeBridge();
    const bytes = new Uint8Array(TEST_CHUNK * 2 + 17).map((_v, i) => i % 251);
    await uploadSourceBytes(bridge, 'p1', bytes, { chunkBytes: TEST_CHUNK });
    expect(bridge.stored().length).toBe(bytes.length);
    expect(Array.from(bridge.stored().subarray(0, 5))).toEqual(Array.from(bytes.subarray(0, 5)));
    expect(Array.from(bridge.stored().subarray(bytes.length - 5))).toEqual(Array.from(bytes.subarray(bytes.length - 5)));
  });

  it('每块不超过契约块大小（单条 IPC 消息水位可控）', async () => {
    const bridge = makeFakeBridge();
    const calls: number[] = [];
    (bridge.appendSource as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (payload: { offset: number; dataBase64: string }) => {
        calls.push(base64ToBytes(payload.dataBase64).length);
        return { size: payload.offset + base64ToBytes(payload.dataBase64).length };
      },
    );
    await uploadSourceBytes(bridge, 'p1', new Uint8Array(TEST_CHUNK + 5), { chunkBytes: TEST_CHUNK });
    expect(calls).toEqual([TEST_CHUNK, 5]);
  });

  it('进度回调按累计字节上报（大 PDF 要有进度感）', async () => {
    const bridge = makeFakeBridge();
    const seen: number[] = [];
    await uploadSourceBytes(bridge, 'p1', new Uint8Array(TEST_CHUNK + 5), {
      chunkBytes: TEST_CHUNK, onProgress: (done) => seen.push(done),
    });
    expect(seen).toEqual([TEST_CHUNK, TEST_CHUNK + 5]);
  });

  it('空文件被拒（空 PDF 没有工作区可言）', async () => {
    await expect(uploadSourceBytes(makeFakeBridge(), 'p1', new Uint8Array())).rejects.toThrow(/为空/);
  });
});

describe('0036 P1：分块读回', () => {
  it('拼回原文逐位一致 + eof 收尾', async () => {
    const bridge = makeFakeBridge();
    const bytes = new Uint8Array(TEST_CHUNK * 2 + 3).map((_v, i) => (i * 7) % 256);
    await uploadSourceBytes(bridge, 'p1', bytes, { chunkBytes: TEST_CHUNK });
    const back = await readSourceBytes(bridge, 'p1', bytes.length, { chunkBytes: TEST_CHUNK });
    expect(back.length).toBe(bytes.length);
    expect(Array.from(back.subarray(bytes.length - 8))).toEqual(Array.from(bytes.subarray(bytes.length - 8)));
  });

  it('字节数与项目登记不一致 → 拒绝（截断的 PDF 会静默少页）', async () => {
    const bridge = makeFakeBridge(new Uint8Array([1, 2, 3]));
    await expect(readSourceBytes(bridge, 'p1', 999)).rejects.toThrow(/不完整/);
  });

  it('项目里没有源文件 → 明确报错（不是返回空 PDF 让 pdfjs 抛天书）', async () => {
    await expect(readSourceBytes(makeFakeBridge(), 'p1', 100)).rejects.toThrow(/源文件/);
  });

  it('进度回调按累计字节上报', async () => {
    const bytes = new Uint8Array(TEST_CHUNK + 10);
    const bridge = makeFakeBridge(bytes);
    const seen: number[] = [];
    await readSourceBytes(bridge, 'p1', bytes.length, {
      chunkBytes: TEST_CHUNK, onProgress: (done) => seen.push(done),
    });
    expect(seen).toEqual([TEST_CHUNK, TEST_CHUNK + 10]);
  });
});
