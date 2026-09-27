// 0028 P3：核验清单 V1-V5 纯函数 + V8 人签门禁（任务书 §一 P3 / §四）
// 逐项构造用例钉死判据；另对随仓 mock 夹具跑真样本（判据不得对真数据全绿而失去意义）

import { describe, it, expect } from 'vitest';
import { verifyProofItems, ingestGate, extractTexValues } from '../../src/recog/verify/checklist.js';
import type { ProofItem } from '../../src/shared/contracts/recog-ui-types.js';
import { MOCK_PROOF_INPUT } from '../../src/app/proof/mock-proof-input.js';
import { MOCK_PROOF_INPUT_CHUTIAN } from '../../src/app/proof/mock-proof-input-chutian.js';

function makeItem(overrides: Partial<ProofItem> = {}): ProofItem {
  return {
    draftId: '1-1',
    pageNo: 1,
    qno: 1,
    source: 'rule',
    contentHtml: '<div class="question"><p>题面文本</p></div>',
    imageRefIds: [],
    status: 'pending',
    warnings: [],
    rawText: '1. 题面文本',
    ...overrides,
  };
}

function codes(report: ReturnType<typeof verifyProofItems>, level: 'fail' | 'warn'): string[] {
  return report[level === 'fail' ? 'fails' : 'warnings'].map((f) => f.code);
}

describe('0028 P3：V1 题号连续性与层级', () => {
  it('连续题号 → 通过；无 finding', () => {
    const r = verifyProofItems([makeItem({ qno: 1 }), makeItem({ draftId: '1-2', qno: 2 }), makeItem({ draftId: '1-3', qno: 3 })]);
    expect(codes(r, 'fail')).toEqual([]);
    expect(r.passed).toBe(true);
  });

  it('跳号 → warn（不阻断），文案带缺号', () => {
    const r = verifyProofItems([makeItem({ qno: 1 }), makeItem({ draftId: '1-3', qno: 3 })]);
    expect(codes(r, 'fail')).toEqual([]);
    expect(r.warnings.filter((f) => f.code === 'V1').map((f) => f.message).join('|')).toContain('2');
  });

  it('题号重复 → fail（同卷两道 3 题）', () => {
    const r = verifyProofItems([makeItem({ qno: 3 }), makeItem({ draftId: '1-3b', qno: 3 })]);
    expect(codes(r, 'fail')).toEqual(['V1']);
    expect(r.passed).toBe(false);
  });

  it('题号倒退 → fail', () => {
    const r = verifyProofItems([makeItem({ qno: 5 }), makeItem({ draftId: '1-2', qno: 2 })]);
    expect(codes(r, 'fail')).toContain('V1');
  });

  it('非法题号（0/负/非整数）→ fail', () => {
    expect(codes(verifyProofItems([makeItem({ qno: 0 })]), 'fail')).toContain('V1');
    expect(codes(verifyProofItems([makeItem({ qno: -1 })]), 'fail')).toContain('V1');
    expect(codes(verifyProofItems([makeItem({ qno: 1.5 })]), 'fail')).toContain('V1');
  });

  it('手工新起条目（source=manual）→ warn 提示人工确认层级', () => {
    const r = verifyProofItems([makeItem({ source: 'manual' })]);
    expect(r.warnings.some((f) => f.code === 'V1' && f.message.includes('人工'))).toBe(true);
    expect(r.passed).toBe(true);
  });

  it('已删除条目不参与 V1（剔除后连续即通过）', () => {
    const r = verifyProofItems([makeItem({ qno: 1 }), makeItem({ draftId: '1-2', qno: 2, status: 'delete' })]);
    expect(codes(r, 'fail')).toEqual([]);
  });
});

describe('0028 P3：V2 题干完整性启发式', () => {
  it('题面为空（只有选项/图）→ fail', () => {
    const r = verifyProofItems([makeItem({ contentHtml: '<div class="question"><div class="options"><span class="option">A. 甲</span></div></div>' })]);
    expect(codes(r, 'fail')).toContain('V2');
  });

  it('尾部悬挂连接词（句子被截断）→ fail；合法收束（求：/。）不误伤', () => {
    const normal = verifyProofItems([makeItem({ contentHtml: '<div class="question"><p>求该物体的加速度为多少。</p></div>' })]);
    expect(codes(normal, 'fail')).not.toContain('V2');
    // 中文理科题「求：」是合法收束（真夹具 7-14 实证），不作截断信号
    const colon = verifyProofItems([makeItem({ contentHtml: '<div class="question"><p>（1）求小球到达 B 点时速度大小；</p><p>（2）求：</p></div>' })]);
    expect(codes(colon, 'fail')).not.toContain('V2');
    const dangling = verifyProofItems([makeItem({ contentHtml: '<div class="question"><p>求该物体的加速度，</p></div>' })]);
    expect(codes(dangling, 'fail')).toContain('V2');
    expect(dangling.fails.find((f) => f.code === 'V2')!.message).toContain('截断');
  });

  it('括号不配对 → warn（OCR 常见但不致命）', () => {
    const r = verifyProofItems([makeItem({ contentHtml: '<div class="question"><p>如图（甲所示，求加速度</p></div>' })]);
    expect(r.warnings.some((f) => f.code === 'V2' && f.message.includes('括号'))).toBe(true);
    expect(r.passed).toBe(true);
  });

  it('题面内混入下一条题号锚（串题）→ fail', () => {
    const r = verifyProofItems([makeItem({ contentHtml: '<div class="question"><p>甲题题面</p><p>2. 乙题题面</p></div>' })]);
    expect(codes(r, 'fail')).toContain('V2');
    expect(r.fails.find((f) => f.code === 'V2')!.message).toContain('串题');
  });

  it('缺 question 根容器 → warn（结构契约漂移）', () => {
    const r = verifyProofItems([makeItem({ contentHtml: '<p>题面文本</p>' })]);
    expect(r.warnings.some((f) => f.code === 'V2' && f.message.includes('question'))).toBe(true);
  });
});

describe('0028 P3：V3 公式 KaTeX 自动编译（不过直接标红）', () => {
  it('全部公式可编译 → 无 V3 finding', () => {
    const r = verifyProofItems([makeItem({ contentHtml: '<div class="question"><p>x <span class="math" data-tex="\\frac{1}{2}"></span></p></div>' })]);
    expect(r.findings.filter((f) => f.code === 'V3')).toEqual([]);
  });

  it('公式编译失败 → fail 且带原文与原因（可定位）', () => {
    const r = verifyProofItems([makeItem({ contentHtml: '<div class="question"><p><span class="math" data-tex="\\frac{1}{"></span></p></div>' })]);
    const v3 = r.fails.filter((f) => f.code === 'V3');
    expect(v3).toHaveLength(1);
    expect(v3[0].message).toContain('\\frac{1}{');
    expect(v3[0].draftId).toBe('1-1');
    expect(r.passed).toBe(false);
  });

  it('答案/解析里的公式同样受检（三字段全覆盖）', () => {
    const r = verifyProofItems([
      makeItem({ answerHtml: '<p><span class="math" data-tex="a^"></span></p>' }),
      makeItem({ draftId: '1-2', qno: 2, analysisHtml: '<p><span class="math" data-tex="a^"></span></p>' }),
    ]);
    expect(r.fails.filter((f) => f.code === 'V3').map((f) => f.draftId)).toEqual(['1-1', '1-2']);
  });

  it('HTML 实体未解码的 tex（&lt;）判失败——与 renderMath 实际消费同一份原样串', () => {
    const r = verifyProofItems([makeItem({ contentHtml: '<div class="question"><p><span class="math" data-tex="0 \\leq &lt; 1"></span></p></div>' })]);
    expect(codes(r, 'fail')).toContain('V3');
  });

  it('同一原文重复出现只报一条（附处数），避免长填空被刷屏', () => {
    const html = '<div class="question"><p><span class="math" data-tex="M=__"></span><span class="math" data-tex="M=__"></span><span class="math" data-tex="M=__"></span></p></div>';
    const r = verifyProofItems([makeItem({ contentHtml: html })]);
    const v3 = r.fails.filter((f) => f.code === 'V3');
    expect(v3).toHaveLength(1);
    expect(v3[0].message).toContain('×3');
  });

  it('extractTexValues 按出现顺序抽全（含 data-display 形态）', () => {
    const html = '<p><span class="math" data-tex="a"></span><span class="math" data-tex="b" data-display="true"></span></p>';
    expect(extractTexValues(html)).toEqual(['a', 'b']);
  });
});

describe('0028 P3：V4 配图与题目绑定', () => {
  it('声明图引用且题面有对应 figure → 通过', () => {
    const r = verifyProofItems([makeItem({
      imageRefIds: ['p1-img-0'],
      contentHtml: '<div class="question"><p>如图</p><figure class="diagram"><img src="" alt="p1-img-0"></figure></div>',
    })]);
    expect(codes(r, 'fail')).toEqual([]);
  });

  it('声明了图引用但题面无绑定 → fail', () => {
    const r = verifyProofItems([makeItem({ imageRefIds: ['p1-img-0'], contentHtml: '<div class="question"><p>如图</p></div>' })]);
    expect(codes(r, 'fail')).toContain('V4');
    expect(r.fails.find((f) => f.code === 'V4')!.message).toContain('p1-img-0');
  });

  it('题面 figure 引用了未声明的图 → fail（孤儿图）', () => {
    const r = verifyProofItems([makeItem({
      imageRefIds: [],
      contentHtml: '<div class="question"><figure class="diagram"><img src="" alt="p9-img-3"></figure></div>',
    })]);
    expect(codes(r, 'fail')).toContain('V4');
  });

  it('无图题不产生 V4 finding', () => {
    const r = verifyProofItems([makeItem()]);
    expect(r.findings.filter((f) => f.code === 'V4')).toEqual([]);
  });
});

describe('0028 P3：V5 答案解析字段完整', () => {
  it('答案/解析皆缺 → warn（原卷可能本就不含），不阻断', () => {
    const r = verifyProofItems([makeItem()]);
    expect(codes(r, 'warn')).toContain('V5');
    expect(r.passed).toBe(true);
  });

  it('字段存在但无文本 → fail', () => {
    expect(codes(verifyProofItems([makeItem({ answerHtml: '<p> </p>' })]), 'fail')).toContain('V5');
    expect(codes(verifyProofItems([makeItem({ analysisHtml: '' })]), 'fail')).toContain('V5');
  });

  it('字段有内容 → 无 V5 finding', () => {
    const r = verifyProofItems([makeItem({ answerHtml: '<p>B</p>', analysisHtml: '<p>由动能定理得…</p>' })]);
    expect(r.findings.filter((f) => f.code === 'V5')).toEqual([]);
  });
});

describe('0028 P3：V8 人签门禁（全绿才允许入库）', () => {
  it('全题已通过 + 核验无 fail → 放行', () => {
    const items = [makeItem({ qno: 1, status: 'ok' }), makeItem({ draftId: '1-2', qno: 2, status: 'ok' })];
    const report = verifyProofItems(items);
    expect(ingestGate(items, report)).toEqual({ allowed: true, reasons: [] });
  });

  it('有未标记「校对通过」的条目 → 拒绝（人签缺失）', () => {
    const items = [makeItem({ qno: 1, status: 'ok' }), makeItem({ draftId: '1-2', qno: 2, status: 'pending' })];
    const gate = ingestGate(items, verifyProofItems(items));
    expect(gate.allowed).toBe(false);
    expect(gate.reasons.join('|')).toContain('未标记「校对通过」');
  });

  it('核验存在 fail（如公式编译失败）→ 拒绝，理由带 code 与条数', () => {
    const items = [makeItem({ status: 'ok', contentHtml: '<div class="question"><p><span class="math" data-tex="a^"></span></p></div>' })];
    const gate = ingestGate(items, verifyProofItems(items));
    expect(gate.allowed).toBe(false);
    expect(gate.reasons.join('|')).toContain('V3');
  });

  it('无可见条目（全删除）→ 拒绝', () => {
    const items = [makeItem({ status: 'delete' })];
    const gate = ingestGate(items, verifyProofItems(items));
    expect(gate.allowed).toBe(false);
    expect(gate.reasons.join('|')).toContain('没有');
  });

  it('warn 不阻断（V5 无答案仍可入库）', () => {
    const items = [makeItem({ status: 'ok' })];
    expect(ingestGate(items, verifyProofItems(items)).allowed).toBe(true);
  });
});

describe('0028 P3：真样本夹具回归（判据对真数据有区分度而非恒绿）', () => {
  it('上海 2024 夹具（4 题/14 页）：零 fail，仅 V5「原卷无答案」warn', () => {
    const report = verifyProofItems(MOCK_PROOF_INPUT.items);
    expect(report.fails).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.warnings.map((f) => f.code)).toEqual(['V5', 'V5', 'V5', 'V5']);
  });

  it('楚天 2025-12 夹具（15 题/11 页）：fail 全部是 V3 真缺陷（5 条），无结构性 fail', () => {
    const report = verifyProofItems(MOCK_PROOF_INPUT_CHUTIAN.items);
    expect(report.fails.map((f) => [f.code, f.draftId])).toEqual([
      ['V3', '2-7'],   // HTML 实体 &lt; 未解码 → 渲染必炸（renderMath 同口径取原样串）
      ['V3', '4-11'],  // 填空下划线被整段裹进公式
      ['V3', '4-11'],  // 同上，第二处（单位形态）
      ['V3', '4-12'],  // 长实验题：同一处填空重复 15 次，按原文去重后只报一条
      ['V3', '4-12'],
    ]);
    expect(report.fails[0].message).toContain('&lt;');
    expect(report.fails[3].message).toContain('×15');
    expect(report.warnings.filter((f) => f.code === 'V5')).toHaveLength(11);
    expect(report.warnings.filter((f) => f.code !== 'V5')).toEqual([]);
    // V3 有牙齿：这两道题核验不过 → 门禁不放行
    expect(report.byItem['2-7'].ok).toBe(false);
    expect(report.byItem['1-1'].ok).toBe(true);
  });
});
