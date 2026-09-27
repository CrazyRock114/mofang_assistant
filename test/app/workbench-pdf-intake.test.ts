// 0040 返工③：整卷 PDF → 逐页 PNG 素材（本地栅格化）。
// 依赖全部注入（jsdom/Node 里没有 pdfjs worker 也没有真 canvas）：
// 这里锁的是「页序、命名、上限截断与告知、文档句柄必须 close」四件事。

import { describe, it, expect } from 'vitest';

import type { LoadedPdf } from '../../src/app/splitting/pdf-raster.js';
import { pdfPaperTitle, pdfStem, rasterizePdf, type PdfIntakeDeps } from '../../src/app/workbench/pdf-intake.js';

interface Harness {
  deps: PdfIntakeDeps;
  rasterized: number[];
  destroyed: number;
}

/** 假 PDF：pageCount 页，每页产出「页号」字节的 PNG Blob */
function harness(pageCount: number, maxPages = 30): Harness {
  const rasterized: number[] = [];
  const state = { destroyed: 0 };
  const canvas = {} as HTMLCanvasElement;
  return {
    rasterized,
    get destroyed() { return state.destroyed; },
    deps: {
      load: async (): Promise<LoadedPdf> => ({
        doc: { destroy: async () => { state.destroyed += 1; } } as unknown as LoadedPdf['doc'],
        pageCount,
        firstPageSize: { w: 595, h: 842 },
      }),
      rasterize: async (_doc, pageNo) => { rasterized.push(pageNo); return { canvas }; },
      toBlob: async () => new Blob([new Uint8Array([9])], { type: 'image/png' }),
      maxPages,
    },
  };
}

function pdfFile(name: string, bytes: number[] = [1, 2, 3]): File {
  return new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });
}

describe('0040 返工③：PDF 逐页转图', () => {
  it('按页序产出素材与页图字节（命名带卷名与页号，mime 固定 png）', async () => {
    const h = harness(3);
    const result = await rasterizePdf(pdfFile('八年级物理练习.pdf'), h.deps);
    expect(h.rasterized).toEqual([1, 2, 3]);
    expect(result.materials.map((m) => m.name)).toEqual([
      '八年级物理练习-p001.png', '八年级物理练习-p002.png', '八年级物理练习-p003.png',
    ]);
    expect(result.materials.every((m) => m.mime === 'image/png')).toBe(true);
    expect(result.materials[0]!.dataBase64).toBe(Buffer.from([9]).toString('base64'));
    expect(result.files.map((f) => f.name)).toEqual(result.materials.map((m) => m.name));
    expect(result.totalPages).toBe(3);
    expect(result.importedPages).toBe(3);
    expect(result.notice).toBeNull();
    expect(h.destroyed).toBe(1); // pdfjs 文档句柄必须收
  });

  it('超上限 → 只转前 N 页并如实告知（不静默丢页）', async () => {
    const h = harness(42, 30);
    const result = await rasterizePdf(pdfFile('整本教辅.pdf'), h.deps);
    expect(result.importedPages).toBe(30);
    expect(result.totalPages).toBe(42);
    expect(result.materials).toHaveLength(30);
    expect(result.notice).toContain('42');
    expect(result.notice).toContain('30');
  });

  it('单页 PDF → 素材名即卷名页图（run.sourceName 单素材口径能显示人话）', async () => {
    const h = harness(1);
    const result = await rasterizePdf(pdfFile('期末卷.pdf'), h.deps);
    expect(result.materials).toHaveLength(1);
    expect(result.materials[0]!.name).toBe('期末卷-p001.png');
  });

  it('空文件 / 零页 PDF → 明确报错（不是静默出一个空 run）', async () => {
    const empty = harness(1);
    await expect(rasterizePdf(pdfFile('空.pdf', []), empty.deps)).rejects.toThrow(/为空/);

    const zero = harness(0);
    await expect(rasterizePdf(pdfFile('零页.pdf'), zero.deps)).rejects.toThrow(/没有可读页面/);
    expect(zero.destroyed).toBe(1);
  });

  it('卷名归一：去扩展名、去路径、压掉非法字符、限长', () => {
    expect(pdfStem('C:\\tmp\\八年级物理.pdf')).toBe('八年级物理');
    expect(pdfPaperTitle('期末·物理(卷).PDF')).toBe('期末·物理(卷)');
    expect(pdfStem('a<b>:"c.pdf')).toBe('a_b___c');
    expect(pdfStem('.pdf')).toBe('整卷');
    expect(pdfStem(`${'长'.repeat(80)}.pdf`)).toHaveLength(60);
  });
});
