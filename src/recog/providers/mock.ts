// C0 Phase 1: MockOcrProvider — 预置 OcrPageResult 序列回放（测试与脱网回归用）
// 夹具由 scripts/seed-recog-fixtures.mjs 生成或测试内经 fixture-convert 即时转换

import type { OcrPageResult, OcrProvider } from '../../shared/contracts/recog-types.js';

export class MockOcrProvider implements OcrProvider {
  readonly name = 'mock';
  private readonly pages = new Map<number, OcrPageResult>();

  constructor(pages: OcrPageResult[]) {
    for (const p of pages) {
      this.pages.set(p.pageNo, p);
    }
  }

  async ocrPage(image: { data: Uint8Array; pageNo: number; mime?: string }): Promise<OcrPageResult> {
    const page = this.pages.get(image.pageNo);
    if (!page) {
      throw new Error(`MockOcrProvider: 夹具中无第 ${image.pageNo} 页`);
    }
    // 深拷贝回放，避免调用方改动污染夹具
    return JSON.parse(JSON.stringify(page)) as OcrPageResult;
  }
}
