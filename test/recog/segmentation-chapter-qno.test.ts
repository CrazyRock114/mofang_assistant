// 0028 目检返工：章-题号式行首题号（`2-17`）——真机样本回归（先 RED 后 GREEN）
//
// 背景（用户目检实录）：用 deepseek-ai/DeepSeek-OCR 跑几张题集截图，三条 run 全部 status=done、
// OCR 文本正确（含 LaTeX），但 drafts=0 —— 用户看到的是「识别完成，但没有切出题目」。
// 根因：旧 QSTART_RE 只认行首 `1.`/`1、`，而题集截图的行首题号是「章-题号」形式（`2-17`），
// 整页因此进 skipped（reason=页首未归属内容）且无任何 warning 可循。
//
// 样本：逐字取自真机 run 产物（`<userData>/data/recog/runs/<runId>/ocr/p001.json` 的 text 字段），
// 不再手抄——断言里的期望串同样逐字来自样本本身，保证「真数据 → 真判据」。
// 断言结构化：精确块文本/题号匹配，不做子串降级。

import { describe, it, expect } from 'vitest';

import { createDraftBuilder } from '../../src/recog/draft.js';
import { createRuleSegmenter, segmentPaper, SKIP_REASON } from '../../src/recog/segmentation/rule.js';

/** 真机样本 A：`2-17` 单题截图（无答案/解析，OCR 124 字） */
const SAMPLE_A =
  '2-17 炮弹欲击中地面上某一目的物。但若以仰角 \\(\\alpha\\) 发射，则落在目的物前 \\(a\\) 米；若以仰角 \\(\\beta\\) 发射，则落在目的物后 \\(b\\) 米。假定炮弹的出口速度相同，并且空气阻力不计，试证击中目的物的适当仰角应为';

/** 真机样本 A 的题面（去掉行首标记后的逐字文本） */
const SAMPLE_A_STEM =
  '炮弹欲击中地面上某一目的物。但若以仰角 \\(\\alpha\\) 发射，则落在目的物前 \\(a\\) 米；若以仰角 \\(\\beta\\) 发射，则落在目的物后 \\(b\\) 米。假定炮弹的出口速度相同，并且空气阻力不计，试证击中目的物的适当仰角应为';

/** 真机样本 C：`2-18` 单题截图（题面 + 两行图注，行内含「图2-3」；OCR 187 字） */
const SAMPLE_C =
  '2-18 如图2-3所示，从高 \\( H \\) 处的一点 \\( O \\)，先后平抛两个小球1和2，球1刚好直接越过竖直挡板，落到水平地面上的 \\( B \\) 点；球2则与地面碰撞一次后，然后刚好越过竖直挡板，也落在 \\( B \\) 点。设球2以及与之碰撞的地面是光滑的，碰撞中无能量损耗。求竖直挡板的高度 \\( h \\)。  \n\n图2-3 图2-3  \n\n图2-3 图2-3';

const page = (text: string, pageNo = 1) => ({ text, pageNo, imageRefs: [] });

describe('0028 返工：章-题号式行首题号（真机样本）', () => {
  it('样本 A（2-17）：切出 1 题，qno=章内序号 17，行首标记不进题面', () => {
    const seg = segmentPaper([page(SAMPLE_A)]);
    expect(seg.pages[0].questions).toHaveLength(1);
    const q = seg.pages[0].questions[0];
    expect(q.qno).toBe(17);
    expect(q.blocks).toHaveLength(1);
    expect(q.blocks[0].type).toBe('question');
    expect(q.blocks[0].text).toBe(SAMPLE_A_STEM);
    expect(seg.pages[0].skipped).toHaveLength(0);
    expect(seg.warnings).toHaveLength(0);
  });

  it('样本 C（2-18）：行内「图2-3」不误切；两行图注续接题面，仍只 1 题', () => {
    const seg = segmentPaper([page(SAMPLE_C)]);
    expect(seg.pages[0].questions).toHaveLength(1);
    const q = seg.pages[0].questions[0];
    expect(q.qno).toBe(18);
    expect(q.blocks).toHaveLength(1);
    expect(q.blocks[0].text).toBe(
      '如图2-3所示，从高 \\( H \\) 处的一点 \\( O \\)，先后平抛两个小球1和2，球1刚好直接越过竖直挡板，落到水平地面上的 \\( B \\) 点；球2则与地面碰撞一次后，然后刚好越过竖直挡板，也落在 \\( B \\) 点。设球2以及与之碰撞的地面是光滑的，碰撞中无能量损耗。求竖直挡板的高度 \\( h \\)。\n图2-3 图2-3\n图2-3 图2-3',
    );
    expect(seg.warnings).toHaveLength(0);
  });

  it('样本 A 走草稿链：产出 1 题卡（qno=17，无「题面为空」告警，rawText 保留原题号可溯源）', () => {
    const seg = segmentPaper([page(SAMPLE_A)]);
    const builder = createDraftBuilder();
    const drafts = seg.pages[0].questions.map((q) => builder.build(q));
    expect(drafts).toHaveLength(1);
    expect(drafts[0].qno).toBe(17);
    expect(drafts[0].warnings).toHaveLength(0);
    expect(drafts[0].rawText).toBe(SAMPLE_A);
    expect(drafts[0].contentHtml.startsWith('<div class="question"><p>')).toBe(true);
  });

  it('中线出现「2-3」不切题（只在行首认标记）：续行留在原题面', () => {
    const seg = segmentPaper([page('1. 第一题题干第一行\n另见 2-3 的说明文字继续。')]);
    expect(seg.pages[0].questions).toHaveLength(1);
    expect(seg.pages[0].questions[0].blocks[0].text).toBe('第一题题干第一行\n另见 2-3 的说明文字继续。');
  });

  it('行首孤立「2-3」（标记后无内容）不当题号：进 skipped，题数不受影响', () => {
    const seg = segmentPaper([page('2-3\n\n1. 一题题干。')]);
    expect(seg.pages[0].questions).toHaveLength(1);
    expect(seg.pages[0].questions[0].qno).toBe(1);
    expect(seg.pages[0].skipped).toHaveLength(1);
    expect(seg.pages[0].skipped[0]).toEqual({ rawText: '2-3', reason: SKIP_REASON.FRONT });
  });

  it('破折号变体（en dash / 全角连字符）同样识别', () => {
    const enDash = segmentPaper([page('3–2 需求出速度之比。')]);
    expect(enDash.pages[0].questions).toHaveLength(1);
    expect(enDash.pages[0].questions[0].qno).toBe(2);
    expect(enDash.pages[0].questions[0].blocks[0].text).toBe('需求出速度之比。');

    const fullWidth = segmentPaper([page('12－5 试求该比值。')]);
    expect(fullWidth.pages[0].questions).toHaveLength(1);
    expect(fullWidth.pages[0].questions[0].qno).toBe(5);
  });
});

describe('0028 返工：零题自解释告警（避免静默 0 题卡）', () => {
  it('整卷有文字但切不出题 → 给出带字数与支持格式的告警（不再静默）', () => {
    const text = '本题集自测卷\n本卷所有小题均无行首题号，仅作抄录。';
    const seg = segmentPaper([page(text)]);
    expect(seg.pages[0].questions).toHaveLength(0);
    expect(seg.warnings).toEqual([
      `整卷未切出题目（识别到 ${text.length} 字）：题号须在行首，当前支持「1.」「1、」「2-17」等；请确认原图是否含题号`,
    ]);
  });

  it('切出题时不加该告警（正常卷零噪声）', () => {
    const seg = segmentPaper([page(SAMPLE_A)]);
    expect(seg.warnings).toHaveLength(0);
  });

  it('空白页不加该告警（无文字可诊断）', () => {
    const seg = segmentPaper([page('   \n\n')]);
    expect(seg.warnings).toHaveLength(0);
  });

  it('单页无状态切分（RuleSegmenter）对样本 A 亦成立（契约实现同源）', () => {
    const seg = createRuleSegmenter().segment(SAMPLE_A, { pageNo: 1, imageRefs: [] });
    expect(seg.questions).toHaveLength(1);
    expect(seg.questions[0].qno).toBe(17);
    expect(seg.skipped).toHaveLength(0);
  });
});
