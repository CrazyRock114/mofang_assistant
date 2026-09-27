// 0041：排版页公式固定——「图片排版」可调列表（QuestionFigureSettings 数据源）不再列出
// `.inline-figure` 包裹的行内公式图；存量 layout_json 里对它们的条目一并过滤（保存即自愈）。

import { describe, it, expect } from 'vitest';
import type { Question, QuestionFigureLayout } from '../../src/shared/contracts/bank-types.js';
import { listAdjustableAssets } from '../../src/app/pages/paper-actions.js';

function makeQuestion(): Question {
  return {
    id: 'q-0041-ui',
    subject: '物理',
    sourceType: 'network',
    sourceDetail: { site: 'zujuan' },
    content:
      '<div class="question">长度<span class="inline-figure"><img class="q-figure" data-w="57" data-h="12" src="data-assets/capture/zujuan/f-1.svg"></span>，'
      + '如图<figure class="diagram" data-w="339" data-h="74"><img class="q-figure" src="data-assets/capture/zujuan/big.png"></figure>'
      + '裸图<img class="q-figure" src="data-assets/capture/zujuan/bare.png">结束。</div>',
    images: [
      { assetId: 'capture/zujuan/f-1.svg', type: 'figure' },
      { assetId: 'capture/zujuan/big.png', type: 'figure' },
      { assetId: 'capture/zujuan/bare.png', type: 'figure' },
    ],
    createdAt: '2026-09-18T00:00:00Z',
    updatedAt: '2026-09-18T00:00:00Z',
  };
}

describe('0041：行内公式图不进「图片排版」列表', () => {
  it('无覆盖：行内公式图不列出，块级图与裸行内图仍列出', () => {
    const list = listAdjustableAssets(makeQuestion());
    expect(list).not.toContain('capture/zujuan/f-1.svg');
    expect(list).toContain('capture/zujuan/big.png');
    expect(list).toContain('capture/zujuan/bare.png');
  });

  it('存量覆盖（历史 UI 全量写入，含 data-assets/ 前缀形态）：行内公式条目被过滤 → 下次保存即清除', () => {
    const stale: QuestionFigureLayout[] = [
      { assetId: 'data-assets/capture/zujuan/f-1.svg', orderIndex: 0, widthPercent: 100 },
      { assetId: 'capture/zujuan/big.png', orderIndex: 1 },
    ];
    const list = listAdjustableAssets(makeQuestion(), stale);
    expect(list).not.toContain('data-assets/capture/zujuan/f-1.svg');
    expect(list).not.toContain('capture/zujuan/f-1.svg');
    expect(list).toContain('capture/zujuan/big.png');
  });

  it('公式语义图（formula-image）本就不列出——口径不变（零回归）', () => {
    const q = makeQuestion();
    q.images = [...(q.images ?? []), { assetId: 'capture/zujuan/math.png', type: 'formula-image' }];
    q.content = q.content.replace('裸图', '裸图<span class="inline-figure"><img src="data-assets/capture/zujuan/math.png"></span>');
    const list = listAdjustableAssets(q);
    expect(list).not.toContain('capture/zujuan/math.png');
    expect(list).toContain('capture/zujuan/bare.png');
  });
});
