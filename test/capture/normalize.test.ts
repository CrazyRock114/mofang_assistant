import { describe, it, expect } from 'vitest';
import { normalizeCaptured, cleanCapturedHtml, relocateLeadingFigures } from '../../src/capture/normalize.js';
import type { CapturedQuestion } from '../../src/shared/contracts/capture-types.js';

describe('normalizeCaptured', () => {
  it('应将 zujuan 原始题块转换为契约结构（题干+选项+答案分离）', () => {
    const captured: CapturedQuestion = {
      questionId: 'q123',
      site: 'zujuan',
      sourceUrl: 'https://zujuan.xkw.com/basket',
      stemHtml: '<div>一物体从高处自由下落，经过时间 t 落地。</div>',
      options: [
        '<td>A. v = gt</td>',
        '<td>B. v = 2gt</td>',
        '<td>C. h = ½gt²</td>',
        '<td>D. h = gt²</td>',
      ],
      answerHtml: '<div>答案：A、C</div>',
      analysisHtml: '<div>解析：自由落体加速度为 g。</div>',
      images: [],
      meta: {},
      rect: null,
    };

    const normalized = normalizeCaptured(captured);

    // 题干在 question 根内
    expect(normalized.contentHtml).toContain('<div class="question">');
    expect(normalized.contentHtml).toContain('一物体从高处自由下落');

    // 选项逐个 span.option
    expect(normalized.contentHtml).toContain('<div class="options">');
    expect(normalized.contentHtml).toMatch(/<span class="option">.*A\. v = gt.*<\/span>/);
    expect(normalized.contentHtml).toMatch(/<span class="option">.*B\. v = 2gt.*<\/span>/);
    expect(normalized.contentHtml).toMatch(/<span class="option">.*C\. h = ½gt².*<\/span>/);
    expect(normalized.contentHtml).toMatch(/<span class="option">.*D\. h = gt².*<\/span>/);

    // 答案/解析字段归属
    expect(normalized.answerHtml).toContain('答案：A、C');
    expect(normalized.analysisHtml).toContain('解析：自由落体加速度为 g');
  });

  it('应将 jyeoo 原始题块转换为契约结构', () => {
    const captured: CapturedQuestion = {
      questionId: 't456',
      site: 'jyeoo',
      sourceUrl: 'https://www.jyeoo.com/basket',
      stemHtml: '<div class="pt1">某电路电阻为 10Ω，电流为 2A。</div>',
      options: [
        '<td class="selectoption">A. 电压为 20V</td>',
        '<td class="selectoption">B. 电压为 5V</td>',
      ],
      answerHtml: '<div>A</div>',
      analysisHtml: '<div>根据欧姆定律 U=IR。</div>',
      images: [],
      meta: {},
      rect: null,
    };

    const normalized = normalizeCaptured(captured);

    expect(normalized.contentHtml).toContain('<div class="question">');
    expect(normalized.contentHtml).toContain('某电路电阻为 10Ω');
    expect(normalized.contentHtml).toContain('<div class="options">');
    expect(normalized.contentHtml).toMatch(/<span class="option">.*A\. 电压为 20V.*<\/span>/);
    expect(normalized.answerHtml).toContain('A');
    expect(normalized.analysisHtml).toContain('根据欧姆定律');
  });

  it('应清洗剥离 on* 事件属性', () => {
    const captured: CapturedQuestion = {
      questionId: 'q789',
      site: 'zujuan',
      sourceUrl: 'https://zujuan.xkw.com/basket',
      stemHtml: '<div onclick="alert(1)">题干内容</div>',
      options: [],
      answerHtml: '',
      analysisHtml: '',
      images: [],
      meta: {},
      rect: null,
    };

    const normalized = normalizeCaptured(captured);

    expect(normalized.contentHtml).not.toContain('onclick');
    expect(normalized.contentHtml).toContain('题干内容');
  });

  it('应清洗剥离 style 属性和 script 标签', () => {
    const captured: CapturedQuestion = {
      questionId: 'q999',
      site: 'zujuan',
      sourceUrl: 'https://zujuan.xkw.com/basket',
      stemHtml: '<div style="color:red">题干<script>alert(1)</script></div>',
      options: [],
      answerHtml: '',
      analysisHtml: '',
      images: [],
      meta: {},
      rect: null,
    };

    const normalized = normalizeCaptured(captured);

    expect(normalized.contentHtml).not.toContain('style=');
    expect(normalized.contentHtml).not.toContain('<script>');
    expect(normalized.contentHtml).not.toContain('alert');
  });

  it('应将空选项题型归一化为空 options div', () => {
    const captured: CapturedQuestion = {
      questionId: 'q111',
      site: 'jyeoo',
      sourceUrl: 'https://www.jyeoo.com/basket',
      stemHtml: '<div>计算题：求解以下方程。</div>',
      options: [],
      answerHtml: '<div>x = 5</div>',
      analysisHtml: '',
      images: [],
      meta: {},
      rect: null,
    };

    const normalized = normalizeCaptured(captured);

    expect(normalized.contentHtml).toContain('<div class="question">');
    expect(normalized.contentHtml).toContain('计算题');
    // 空选项不应有 options div 或应为空
    expect(normalized.contentHtml).toMatch(/<div class="options"><\/div>|<\/div>$/);
  });

  it('应将纯文本选项归一化为 option span', () => {
    const captured: CapturedQuestion = {
      questionId: 'q222',
      site: 'generic',
      sourceUrl: 'https://example.com',
      stemHtml: '<div>判断题：地球是圆的。</div>',
      options: ['正确', '错误'],
      answerHtml: '<div>正确</div>',
      analysisHtml: '',
      images: [],
      meta: {},
      rect: null,
    };

    const normalized = normalizeCaptured(captured);

    expect(normalized.contentHtml).toContain('<span class="option">');
    expect(normalized.contentHtml).toContain('正确');
    expect(normalized.contentHtml).toContain('错误');
  });
});

describe('cleanCapturedHtml', () => {
  it('应保留白名单标签和属性', () => {
    const html = '<p class="text"><strong>加粗</strong><em>斜体</em></p>';
    const cleaned = cleanCapturedHtml(html);

    expect(cleaned).toContain('<p');
    expect(cleaned).toContain('class=');
    expect(cleaned).toContain('<strong>');
    expect(cleaned).toContain('<em>');
  });

  it('应剥离 iframe 和外链 href', () => {
    const html = '<div><iframe src="evil.com"></iframe><a href="javascript:alert(1)">链接</a></div>';
    const cleaned = cleanCapturedHtml(html);

    expect(cleaned).not.toContain('<iframe');
    expect(cleaned).not.toContain('javascript:');
  });

  it('应保留公式容器元素的 class', () => {
    const html = '<i class="formula-inline"><img src="formula.svg" /></i>';
    const cleaned = cleanCapturedHtml(html);

    expect(cleaned).toContain('class="formula-inline"');
  });
});


describe('normalizeCaptured — 图片联动（R-2）', () => {
  it('题干内 img 应包裹为 render 层消费的 figure.diagram 契约结构', () => {
    const captured: CapturedQuestion = {
      questionId: 'q1',
      site: 'zujuan',
      sourceUrl: 'https://zujuan.xkw.com/basket',
      stemHtml: '<p>如图所示</p><img src="data-assets/capture/zujuan/q1-1.png">',
      options: [],
      answerHtml: '',
      analysisHtml: '',
      images: [],
      meta: {},
      rect: null,
    };

    const normalized = normalizeCaptured(captured);

    // R-4 起 figure 带 data-w/h（无下载尺寸信息时 = 0，渲染按 max-width 限宽）
    expect(normalized.contentHtml).toContain('<figure class="diagram" data-w="0" data-h="0">');
    expect(normalized.contentHtml).toContain('<img class="q-figure" src="data-assets/capture/zujuan/q1-1.png">');
  });

  it('答案内 img 同样包裹为 figure.diagram', () => {
    const captured: CapturedQuestion = {
      questionId: 'q2',
      site: 'zujuan',
      sourceUrl: 'https://zujuan.xkw.com/basket',
      stemHtml: '<p>题干</p>',
      options: [],
      answerHtml: '<img src="data-assets/capture/zujuan/q2-1.png">',
      analysisHtml: '',
      images: [],
      meta: {},
      rect: null,
    };

    const normalized = normalizeCaptured(captured);

    expect(normalized.answerHtml).toContain('<figure class="diagram" data-w="0" data-h="0">');
    expect(normalized.answerHtml).toContain('<img class="q-figure" src="data-assets/capture/zujuan/q2-1.png">');
  });

  it('normalizedImages 由参数填充（本地下载结果）', () => {
    const captured: CapturedQuestion = {
      questionId: 'q3',
      site: 'jyeoo',
      sourceUrl: 'https://www.jyeoo.com/basket',
      stemHtml: '<p>题干</p>',
      options: [],
      answerHtml: '',
      analysisHtml: '',
      images: [],
      meta: {},
      rect: null,
    };
    const localImages = [
      { localPath: 'data-assets/capture/jyeoo/q3-1.png', origSrc: 'https://img.jyeoo.com/a.png', role: 'content' as const },
    ];

    const normalized = normalizeCaptured(captured, localImages);

    expect(normalized.normalizedImages).toEqual(localImages);
  });

  it('无图片时 normalizedImages 为空数组', () => {
    const captured: CapturedQuestion = {
      questionId: 'q4',
      site: 'zujuan',
      sourceUrl: 'https://zujuan.xkw.com/basket',
      stemHtml: '<p>题干</p>',
      options: [],
      answerHtml: '',
      analysisHtml: '',
      images: [],
      meta: {},
      rect: null,
    };

    expect(normalizeCaptured(captured).normalizedImages).toEqual([]);
  });
});


describe('wrapImagesAsFigures — 尺寸分流（D1-fix R-3/R-4）', () => {
  function makeQ(stemHtml: string, images: Array<{ localPath: string; origSrc: string; role: 'content' | 'answer'; width?: number; height?: number }> = []) {
    return normalizeCaptured(
      {
        questionId: 'qd1',
        site: 'zujuan',
        sourceUrl: 'https://zujuan.xkw.com/basket',
        stemHtml,
        options: [],
        answerHtml: '',
        analysisHtml: '',
        images: [],
        meta: {},
        rect: null,
      },
      images,
    );
  }

  it('小图（宽≤200 且 高≤200）→ 行内 span.inline-figure，data-w/h 写在 img 上，不断开文字流', () => {
    const out = makeQ(
      '<p>距离地面高度为<img src="data-assets/capture/zujuan/qd1-1.svg">，地球半径为<img src="data-assets/capture/zujuan/qd1-2.svg"></p>',
      [
        { localPath: 'data-assets/capture/zujuan/qd1-1.svg', origSrc: 'https://img.xkw.com/1.svg', role: 'content', width: 42, height: 15 },
        { localPath: 'data-assets/capture/zujuan/qd1-2.svg', origSrc: 'https://img.xkw.com/2.svg', role: 'content', width: 11, height: 12 },
      ],
    );

    // 行内公式图：span.inline-figure 紧贴前后文字，无块级 figure
    expect(out.contentHtml).toContain(
      '距离地面高度为<span class="inline-figure"><img class="q-figure" data-w="42" data-h="15" src="data-assets/capture/zujuan/qd1-1.svg"></span>，地球半径为',
    );
    expect(out.contentHtml).not.toContain('<figure');
  });

  it('公式串图（~84px，实站 "sin37°=0.6，cos37°=0.8" 形态）→ 行内，不断开文字流', () => {
    const out = makeQ(
      '<p>取<img src="data-assets/capture/zujuan/qd1-1.svg">，<img src="data-assets/capture/zujuan/qd1-2.svg">。求：</p>',
      [
        { localPath: 'data-assets/capture/zujuan/qd1-1.svg', origSrc: 'a', role: 'content', width: 84, height: 12 },
        { localPath: 'data-assets/capture/zujuan/qd1-2.svg', origSrc: 'b', role: 'content', width: 60, height: 13 },
      ],
    );
    expect(out.contentHtml).toContain('取<span class="inline-figure"><img class="q-figure" data-w="84" data-h="12"');
    expect(out.contentHtml).toContain('</span>，<span class="inline-figure">');
    expect(out.contentHtml).not.toContain('<figure');
  });

  it('大图（任一维度 >200）→ 块级 figure.diagram，data-w/h 写在 figure 上', () => {
    const out = makeQ(
      '<p>如图所示</p><img src="data-assets/capture/zujuan/qd1-1.png">',
      [{ localPath: 'data-assets/capture/zujuan/qd1-1.png', origSrc: 'https://img.xkw.com/1.png', role: 'content', width: 300, height: 200 }],
    );

    expect(out.contentHtml).toContain(
      '<figure class="diagram" data-w="300" data-h="200"><img class="q-figure" src="data-assets/capture/zujuan/qd1-1.png"></figure>',
    );
  });

  it('阈值边界：200 → 行内；201 → 块级', () => {
    const out = makeQ(
      '<img src="data-assets/capture/zujuan/qd1-1.svg"><img src="data-assets/capture/zujuan/qd1-2.svg">',
      [
        { localPath: 'data-assets/capture/zujuan/qd1-1.svg', origSrc: 'a', role: 'content', width: 200, height: 200 },
        { localPath: 'data-assets/capture/zujuan/qd1-2.svg', origSrc: 'b', role: 'content', width: 201, height: 20 },
      ],
    );

    expect(out.contentHtml).toContain('<span class="inline-figure"><img class="q-figure" data-w="200" data-h="200"');
    expect(out.contentHtml).toContain('<figure class="diagram" data-w="201" data-h="20">');
  });

  it('尺寸未知 → 块级 figure data-w="0" data-h="0"（渲染按 max-width 限）', () => {
    const out = makeQ('<p>题干</p><img src="data-assets/capture/zujuan/qd1-1.png">');

    expect(out.contentHtml).toContain('<figure class="diagram" data-w="0" data-h="0">');
    expect(out.contentHtml).not.toContain('inline-figure');
  });
});

describe('normalizeCaptured — 入库题干题号前缀剥离（D1-fix-2 F-2）', () => {
  function stemOf(html: string, site: 'zujuan' | 'jyeoo' = 'zujuan') {
    return normalizeCaptured({
      questionId: 'qf2',
      site,
      sourceUrl: 'https://zujuan.xkw.com/basket',
      stemHtml: html,
      options: [],
      answerHtml: '',
      analysisHtml: '',
      images: [],
      meta: {},
      rect: null,
    }).contentHtml;
  }

  it('篮内题号前缀 "1 . "（实站带空格形态，库存 31576438 取证）入库时剥离', () => {
    const out = stemOf('\n  1 . 如图，一质量为 M 的木板静止在桌面上');
    expect(out).toContain('<div class="question">如图，一质量为 M 的木板');
    expect(out).not.toMatch(/<div class="question">\s*1\s*\./);
  });

  it('"2."/"3、" 形态同样剥离；jyeoo 同步生效', () => {
    expect(stemOf('2. 一个铍原子核发生衰变')).toContain('<div class="question">一个铍原子核');
    expect(stemOf('3、如图所示，加速电场')).toContain('<div class="question">如图所示');
    expect(stemOf('2 . 某电路电阻为 10Ω', 'jyeoo')).toContain('<div class="question">某电路电阻');
  });

  it('【推荐N】残留前缀剥离', () => {
    expect(stemOf('【推荐1】如图，一轻弹簧原长为 L')).toContain('<div class="question">如图，一轻弹簧');
  });

  it('前缀在首个块级标签内（<p>1. …）同样剥离', () => {
    expect(stemOf('<p>1. 某物体做匀速直线运动</p>')).toContain('<p>某物体做匀速直线运动</p>');
  });

  it('正文开头的小数（3.14米）不得误剥', () => {
    const out = stemOf('3.14米长的绳子绕在圆柱上');
    expect(out).toContain('3.14米长的绳子');
  });

  it('无题号前缀的题干原样保留', () => {
    const out = stemOf('光在真空中的传播速度约为多少？');
    expect(out).toContain('光在真空中的传播速度');
  });
});

describe('normalizeCaptured — 选项保留公式图（D1-fix-2 F-5）', () => {
  it('选项内公式小图包裹为 inline-figure 保留在选项里，不剥成纯文本', () => {
    const normalized = normalizeCaptured(
      {
        questionId: 'qf5',
        site: 'zujuan',
        sourceUrl: 'https://zujuan.xkw.com/basket',
        stemHtml: '<p>如图，木板静止（　　）</p>',
        options: [
          'A．物块的动能一定小于<img src="data-assets/capture/zujuan/qf5-3.svg">',
          'B．物块的动能可能等于<img src="data-assets/capture/zujuan/qf5-3.svg">',
        ],
        answerHtml: '',
        analysisHtml: '',
        images: [],
        meta: {},
        rect: null,
      },
      [{ localPath: 'data-assets/capture/zujuan/qf5-3.svg', origSrc: 'https://img.xkw.com/f3.svg', role: 'content', width: 76, height: 27 }],
    );

    const optionsBlock = normalized.contentHtml.slice(normalized.contentHtml.indexOf('<div class="options">'));
    // 每个选项一份公式图（行内），A/B 两项各一，无纯文本重复副本
    expect(optionsBlock.match(/inline-figure/g)).toHaveLength(2);
    expect(optionsBlock).toContain('A．物块的动能一定小于<span class="inline-figure">');
    expect(optionsBlock).toContain('B．物块的动能可能等于<span class="inline-figure">');
  });
});

describe('cleanCapturedHtml — 脏 HTML 白名单清洗（D1-fix R-7）', () => {
  it('剥除站点私有属性 qml-space-size 与字体残留，保留文本与 span', () => {
    const html = '<span qml-space-size="5" data-author="x">候选文本</span>';
    const cleaned = cleanCapturedHtml(html);

    expect(cleaned).not.toContain('qml-space-size');
    expect(cleaned).not.toContain('data-author');
    expect(cleaned).toContain('候选文本');
    expect(cleaned).toContain('<span>');
  });

  it('剥除字体样式残留的畸形属性串（Times New Roman 残留形态）', () => {
    const html = '<span Times New Roman\'" qml-space-size="5">高度为</span>';
    const cleaned = cleanCapturedHtml(html);

    expect(cleaned).not.toContain('Times New Roman');
    expect(cleaned).not.toContain('qml-space-size');
    expect(cleaned).toContain('高度为');
  });

  it('畸形标签（spanTimes 类粘连）整标签剥除、文本保留', () => {
    const html = '<spanTimes New Roman qml-space-size="5">残留文本';
    const cleaned = cleanCapturedHtml(html);

    expect(cleaned).not.toContain('spanTimes');
    expect(cleaned).not.toContain('qml-space-size');
    expect(cleaned).toContain('残留文本');
  });

  it('白名单外标签剥除但保留内部文本；白名单标签与安全属性保留', () => {
    const html = '<font color="red">公式</font><sub>2</sub><img src="data-assets/x.svg" alt="f" onclick="evil()">';
    const cleaned = cleanCapturedHtml(html);

    expect(cleaned).not.toContain('<font');
    expect(cleaned).toContain('公式');
    expect(cleaned).toContain('<sub>');
    expect(cleaned).toContain('src="data-assets/x.svg"');
    expect(cleaned).toContain('alt="f"');
    expect(cleaned).not.toContain('onclick');
  });
});


describe('relocateLeadingFigures — 题首孤图后移（0004-fix-1c B组）', () => {
  it('四态①前置单图：figure 冲题首 → 移到题干末尾，标签/data-w/类原样保留', () => {
    const fig = '<figure class="diagram" data-w="873" data-h="491"><img class="q-figure" src="data-assets/capture/jyeoo/48e21ffd-2.png"></figure>';
    const html = `${fig}<p>如图所示，物体受到的合力大小为多少？</p>`;
    const out = relocateLeadingFigures(html);
    expect(out).toBe('<p>如图所示，物体受到的合力大小为多少？</p>' + fig);
  });

  it('四态②前置图群：连续图块（行内 span + figure）整体后移，群内相对顺序不变', () => {
    const span = '<span class="inline-figure"><img class="q-figure" data-w="192" data-h="188" src="data-assets/capture/jyeoo/a-1.png"></span>';
    const fig = '<figure class="diagram" data-w="300" data-h="200"><img class="q-figure" src="data-assets/capture/jyeoo/a-2.png"></figure>';
    const html = `${span}${fig}<p>已知条件如上，两图分别为受力示意与运动轨迹。</p>`;
    const out = relocateLeadingFigures(html);
    expect(out).toBe('<p>已知条件如上，两图分别为受力示意与运动轨迹。</p>' + span + fig);
  });

  it('四态③纯图不移动：图块后无文本（纯图题/图形题）保持原序', () => {
    const fig1 = '<figure class="diagram" data-w="400" data-h="300"><img class="q-figure" src="a-1.png"></figure>';
    const fig2 = '<figure class="diagram" data-w="400" data-h="300"><img class="q-figure" src="a-2.png"></figure>';
    expect(relocateLeadingFigures(fig1 + fig2)).toBe(fig1 + fig2);
  });

  it('四态④无图原样：纯文本/公式题干原样返回', () => {
    const html = '<p>计算 3.14 米长的绳子绕在圆柱上，求圈数。</p>';
    expect(relocateLeadingFigures(html)).toBe(html);
  });

  it('jyeoo 左文右图实证形态（48e21ffd）：题首 span.inline-figure 图 + 文本在后 → 文本回句首', () => {
    const span = '<span class="inline-figure"><img class="q-figure" data-w="192" data-h="188" src="data-assets/capture/jyeoo/48e21ffd-1.png"></span>';
    const html = `${span}<p>1．如图，闭合开关 S 后，两灯均发光，则两灯是串联还是并联？</p>`;
    const out = relocateLeadingFigures(html);
    expect(out).toBe('<p>1．如图，闭合开关 S 后，两灯均发光，则两灯是串联还是并联？</p>' + span);
  });

  it('zujuan 结构样本：figure 前置 + div 题干 → 后移；首节点是文本/公式则不动', () => {
    const fig = '<figure class="diagram" data-w="500" data-h="350"><img class="q-figure" src="data-assets/capture/zujuan/b-1.png"></figure>';
    expect(relocateLeadingFigures(`${fig}<div>如图，质量为 M 的木板静止在桌面上。</div>`))
      .toBe('<div>如图，质量为 M 的木板静止在桌面上。</div>' + fig);
    // 首节点是文本（行内公式图随文字流在后）→ 不触发
    const textFirst = '<p>取<span class="inline-figure"><img class="q-figure" data-w="84" data-h="12" src="f.svg"></span>，求合力。</p>';
    expect(relocateLeadingFigures(textFirst)).toBe(textFirst);
  });

  it('p 包裹孤图：整 p 后移；p 包图带文字（非孤图）不触发', () => {
    const wrapped = '<p><figure class="diagram" data-w="300" data-h="200"><img class="q-figure" src="a.png"></figure></p>';
    expect(relocateLeadingFigures(`${wrapped}<p>题干文本在后。</p>`))
      .toBe('<p>题干文本在后。</p>' + wrapped);
    // p 内图+文字 → 非孤图包裹，首节点不算图块 → 整体不动
    const pWithText = '<p><figure class="diagram" data-w="300" data-h="200"><img class="q-figure" src="a.png"></figure>如图所示。</p><p>后续文本。</p>';
    expect(relocateLeadingFigures(pWithText)).toBe(pWithText);
  });

  it('图块间允许空白间隔；question-content 契约包裹只后移题干区、选项保持居尾（C组直通入口）', () => {
    const fig = '<figure class="diagram" data-w="300" data-h="200"><img class="q-figure" src="a.png"></figure>';
    const content = `<div class="question">${fig}\n<p>题干文本。</p><div class="options"><span class="option">A. 1</span><span class="option">B. 2</span></div></div>`;
    const out = relocateLeadingFigures(content);
    // 前导空白保留在句首，图块移到题干区末尾、选项之前
    expect(out).toBe(`<div class="question">\n<p>题干文本。</p>${fig}<div class="options"><span class="option">A. 1</span><span class="option">B. 2</span></div></div>`);
    // 题干区只有图（无文本节点）→ 不后移（选项区固定居尾，不参与题干区后移判定）
    const figOnlyStem = `<div class="question">${fig}<div class="options"><span class="option">A. 1</span></div></div>`;
    expect(relocateLeadingFigures(figOnlyStem)).toBe(figOnlyStem);
  });
});

describe('normalizeCaptured — 题首孤图后移接入（0004-fix-1c B组）', () => {
  function makeQ(site: 'jyeoo' | 'zujuan', stemHtml: string, images: Array<{ localPath: string; origSrc: string; role: 'content' | 'answer'; width?: number; height?: number }> = []) {
    return normalizeCaptured(
      {
        questionId: 'q1c',
        site,
        sourceUrl: 'https://example.com',
        stemHtml,
        options: ['<td>A. 1</td>', '<td>B. 2</td>'],
        answerHtml: '',
        analysisHtml: '',
        images: [],
        meta: {},
        rect: null,
      },
      images,
    );
  }

  it('接入探针（jyeoo 左文右图 fixture）：入库 content 首节点为文本，图在题干末尾、选项之前', () => {
    const out = makeQ(
      'jyeoo',
      '<img src="data-assets/capture/jyeoo/q1c-1.png">如图所示，闭合开关后两灯均发光。（　　）',
      [{ localPath: 'data-assets/capture/jyeoo/q1c-1.png', origSrc: 'https://img.jyeoo.com/1.png', role: 'content', width: 873, height: 491 }],
    );
    // <div class="question"> 后紧跟文本（首节点为文本，图不再冲题首）
    expect(out.contentHtml).toMatch(/^<div class="question">如图所示，闭合开关后两灯均发光。/);
    // 图块保持契约结构（figure + data-w）且在选项容器之前
    expect(out.contentHtml).toContain('<figure class="diagram" data-w="873" data-h="491">');
    expect(out.contentHtml.indexOf('<figure')).toBeGreaterThan(out.contentHtml.indexOf('两灯均发光'));
    expect(out.contentHtml.indexOf('<figure')).toBeLessThan(out.contentHtml.indexOf('<div class="options">'));
  });

  it('接入探针（zujuan）：题首图群入库后文本在前；题号随文本回句首被剥离', () => {
    const out = makeQ(
      'zujuan',
      '<img src="data-assets/capture/zujuan/q1c-2.png"><img src="data-assets/capture/zujuan/q1c-3.png">2．如图，一物体沿光滑斜面下滑。',
      [
        { localPath: 'data-assets/capture/zujuan/q1c-2.png', origSrc: 'a', role: 'content', width: 400, height: 300 },
        { localPath: 'data-assets/capture/zujuan/q1c-3.png', origSrc: 'b', role: 'content', width: 350, height: 280 },
      ],
    );
    expect(out.contentHtml).toMatch(/^<div class="question">如图，一物体沿光滑斜面下滑。/);
    expect(out.contentHtml).not.toContain('2．');
    expect(out.contentHtml.indexOf('<figure')).toBeGreaterThan(out.contentHtml.indexOf('光滑斜面'));
  });

  it('纯图题入库保持原序（图块后无文本不后移）', () => {
    const out = makeQ(
      'jyeoo',
      '<img src="data-assets/capture/jyeoo/q1c-4.png">',
      [{ localPath: 'data-assets/capture/jyeoo/q1c-4.png', origSrc: 'c', role: 'content', width: 600, height: 400 }],
    );
    expect(out.contentHtml).toMatch(/^<div class="question"><figure class="diagram" data-w="600" data-h="400">/);
  });
});
