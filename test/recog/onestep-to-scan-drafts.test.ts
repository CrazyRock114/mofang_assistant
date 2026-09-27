// 0046 P5.1：OnestepDraft[] → ScanDraft[] 转换器（P6.3 换档落地的纯函数半边）。
// - qno 降级口径（任务书 P5.1 逐字）：取首个整数；复合形态（"2-17"）与 null 取不到 → null（不猜）
// - 渲染复用 markdown.ts 渲染件（题干公式行内 / [图N] 块级图 / 选项行内图）
// - ScanDraft 契约字段逐一落位（answerHtml/analysisHtml 未产出 = undefined，不用空串蒙混）

import { describe, it, expect } from 'vitest';
import { onestepToScanDrafts, qnoToNumber } from '../../src/recog/onestep/to-scan-drafts.js';
import type { OnestepDraft } from '../../src/shared/contracts/onestep-types.js';

function draftOf(over: Partial<OnestepDraft> = {}): OnestepDraft {
  return {
    qno: '17',
    questionType: '填空',
    stemMarkdown: '求 $F_\\text{浮}$ 的大小。',
    options: null,
    answerMarkdown: null,
    analysisMarkdown: null,
    suggestedTags: [],
    figures: [],
    figureSource: 'none',
    warnings: [],
    ...over,
  };
}

describe('0046 P5.1：qnoToNumber 降级口径', () => {
  it('纯整数取到：17 → 17（含前后空白）', () => {
    expect(qnoToNumber('17')).toBe(17);
    expect(qnoToNumber(' 17 ')).toBe(17);
  });

  it('「取首个整数」：整串仅一个整数段时带非数字缀也取到（第17题 / 17.）', () => {
    expect(qnoToNumber('第17题')).toBe(17);
    expect(qnoToNumber('17.')).toBe(17);
  });

  it('复合形态取不到 → null：2-17（章-题号不猜卷内题号）', () => {
    expect(qnoToNumber('2-17')).toBeNull();
  });

  it('null / 空串 / 无数字 → null', () => {
    expect(qnoToNumber(null)).toBeNull();
    expect(qnoToNumber('')).toBeNull();
    expect(qnoToNumber('题')).toBeNull();
  });
});

describe('0046 P5.1：onestepToScanDrafts 转换', () => {
  it('题干公式行内：$…$ → span.math data-tex（复用 markdown 渲染件口径）', () => {
    const [scan] = onestepToScanDrafts([draftOf()], { pageNo: 3 });
    expect(scan).toBeTruthy();
    expect(scan!.contentHtml).toContain('<div class="question">');
    expect(scan!.contentHtml).toContain('data-tex="F_\\text{浮}"');
    expect(scan!.pageNo).toBe(3);
  });

  it('选项 → .options > .option（与 draftToCard 同源外壳）；选项内 [图N] 落行内图', () => {
    const [scan] = onestepToScanDrafts([
      draftOf({
        questionType: '单选',
        stemMarkdown: '如图[图1]所示。',
        options: [
          { label: 'A', content: '10N' },
          { label: 'B', content: '见图[图1]' },
        ],
        figures: [{ ref: '图1', bbox: [0.1, 0.1, 0.4, 0.4] }],
      }),
    ], { pageNo: 1 });
    expect(scan!.contentHtml).toContain('<div class="options">');
    expect(scan!.contentHtml).toContain('<span class="option">A. 10N</span>');
    // 题干 [图N] → 块级 figure.diagram；选项内 [图N] → span.inline-figure（0045 P4 口径）
    expect(scan!.contentHtml).toContain('<figure class="diagram"');
    expect(scan!.contentHtml).toContain('<span class="inline-figure">');
    expect(scan!.imageRefIds).toEqual(['图1']);
  });

  it('qno 降级：2-17 → qno=null 且告警明示（不静默）', () => {
    const [scan] = onestepToScanDrafts([draftOf({ qno: '2-17' })], { pageNo: 1 });
    expect(scan!.qno).toBeNull();
    expect(scan!.warnings.some((w) => w.includes('2-17'))).toBe(true);
  });

  it('答案/解析：markdown → 契约 HTML；null → undefined（不产出≠空串）', () => {
    const scan = onestepToScanDrafts([
      draftOf({ answerMarkdown: '$F=10N$', analysisMarkdown: null }),
    ], { pageNo: 1 })[0]!;
    expect(scan.answerHtml).toContain('data-tex="F=10N"');
    expect(scan.analysisHtml).toBeUndefined();

    const empty = onestepToScanDrafts([draftOf({ answerMarkdown: null, analysisMarkdown: null })], { pageNo: 1 })[0]!;
    expect(empty.answerHtml).toBeUndefined();
    expect(empty.analysisHtml).toBeUndefined();
  });

  it('rawText 非空（题干 + 答案聚合，供诊断/审计）；warnings 透传引擎告警', () => {
    const scan = onestepToScanDrafts([
      draftOf({ answerMarkdown: '10N', warnings: ['图块来源 none'] }),
    ], { pageNo: 2 })[0]!;
    expect(scan.rawText.length).toBeGreaterThan(0);
    expect(scan.rawText).toContain('10N');
    expect(scan.warnings).toContain('图块来源 none');
  });

  it('多题批量：逐题转换、qno 各自降级、互不串扰', () => {
    const scans = onestepToScanDrafts([
      draftOf({ qno: '1' }),
      draftOf({ qno: '2-3', stemMarkdown: '第二题 $x$。' }),
      draftOf({ qno: null }),
    ], { pageNo: 1 });
    expect(scans).toHaveLength(3);
    expect(scans[0]!.qno).toBe(1);
    expect(scans[1]!.qno).toBeNull();
    expect(scans[2]!.qno).toBeNull();
    expect(scans[1]!.contentHtml).toContain('第二题');
  });

  it('图块裁图注入：figureSrc/figureSize 透传（题卡真图同机制）', () => {
    const [scan] = onestepToScanDrafts([
      draftOf({
        stemMarkdown: '如图[图1]。',
        figures: [{ ref: '图1', bbox: [0, 0, 0.5, 0.5] }],
      }),
    ], {
      pageNo: 1,
      figureSrc: () => 'data:image/png;base64,QUJD',
      figureSize: () => ({ width: 320, height: 200 }),
    });
    expect(scan!.contentHtml).toContain('src="data:image/png;base64,QUJD"');
    expect(scan!.contentHtml).toContain('data-w="320"');
  });
});
