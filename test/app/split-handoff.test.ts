// 0036 P4：录题页 → 工作区 的交接单测（一次性消费 + 过期作废）
// @vitest-environment node

import { describe, it, expect, beforeEach } from 'vitest';
import {
  HANDOFF_TTL_MS, clearPendingPdf, peekPendingPdf, putPendingPdf, setHandoffClock, takePendingPdf,
} from '../../src/app/splitting/handoff.js';

/** File 在 node 环境不存在：用最小结构占位（交接层只搬运引用，不读内容） */
function fakeFile(name: string): File {
  return { name } as unknown as File;
}

let clock = 1000;

beforeEach(() => {
  clock = 1000;
  setHandoffClock(() => clock);
  clearPendingPdf();
});

describe('0036 P4：PDF 交接（跨路由一次性传递）', () => {
  it('放入后可被查看与取走；取走后不再出现（一次性）', () => {
    const files = [fakeFile('教辅.pdf')];
    putPendingPdf(files, '另有 2 张图片未处理');
    const peeked = peekPendingPdf();
    expect(peeked?.files).toHaveLength(1);
    expect(peeked?.notice).toBe('另有 2 张图片未处理');
    expect(takePendingPdf()?.files[0].name).toBe('教辅.pdf');
    expect(peekPendingPdf()).toBeNull();
    expect(takePendingPdf()).toBeNull();
  });

  it('未放入时为空（手动进工作区不该凭空冒出上次的 PDF）', () => {
    expect(peekPendingPdf()).toBeNull();
  });

  it('超过交接有效期即作废（中途走开又回来不该被旧 PDF 突袭）', () => {
    putPendingPdf([fakeFile('a.pdf')]);
    clock += HANDOFF_TTL_MS + 1;
    expect(peekPendingPdf()).toBeNull();
    expect(takePendingPdf()).toBeNull();
  });

  it('有效期内不过期', () => {
    putPendingPdf([fakeFile('a.pdf')]);
    clock += HANDOFF_TTL_MS - 1;
    expect(peekPendingPdf()).not.toBeNull();
  });

  it('无附带说明时 notice 为 null', () => {
    putPendingPdf([fakeFile('a.pdf')]);
    expect(peekPendingPdf()?.notice).toBeNull();
  });
});
