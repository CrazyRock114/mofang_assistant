// 0035：DOCX 导出自检（--smoke-docx）——真管线跑样例卷：KaTeX 栅格 + 图片落位 + 组装 + 落盘。
// 用途：① 开发态验证（脚本 scripts/probe-0035-docx.mjs）；② S-1 出仓包实测（打包后便携 exe 同参启动）。
// 样例卷覆盖：行内/行间公式（分数、根号、积分、极限）、题图（真 PNG）、双栏、选项版式、
// 题级 side-by-side 图、作答区横线、卷头多行、Logo（页眉近似）、文本内容块、教师版答案/解析。

import { nativeImage } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Paper, PaperLayoutConfig, Question } from '../shared/contracts/bank-types.js';
import { buildDocxBuffer } from '../docgen/export/docx/index.js';
import { rasterizeMath } from '../docgen/export/docx/rasterize.js';
import { rasterizeSvgAssets } from '../docgen/export/docx/svg-raster.js';
import type { ExportDocxStats } from '../shared/contracts/bridge.js';

export interface SmokeDocxOptions {
  /** 产物目录（docx 与 stats 落此） */
  outDir: string;
  /** userData 路径（data/assets 资产根） */
  userDataPath: string;
}

export interface SmokeDocxReport {
  docxPath: string;
  bytes: number;
  stats: ExportDocxStats;
  degradations: Array<{ tag: string; count: number; sample: string }>;
}

/** 位图 → PNG（BGRA 原生位图；用于样例卷的题图/Logo 素材，零额外依赖） */
function makePng(width: number, height: number, paint: (x: number, y: number) => [number, number, number]): Buffer {
  const buf = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = paint(x, y);
      const at = (y * width + x) * 4;
      buf[at] = b;
      buf[at + 1] = g;
      buf[at + 2] = r;
      buf[at + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(buf, { width, height }).toPNG();
}

/** 题图素材：白底 + 边框 + 对角 + 网格（像电路/示意图，便于目检图块落位与清晰度） */
export function sampleFigurePng(): Buffer {
  return makePng(320, 200, (x, y) => {
    const border = x < 2 || y < 2 || x > 317 || y > 197;
    if (border) return [40, 40, 40];
    if (Math.abs(x - y) < 2) return [200, 60, 60];
    const grid = x % 40 === 0 || y % 40 === 0;
    return grid ? [210, 220, 235] : [255, 255, 255];
  });
}

/** Logo 素材：深底白字块（页眉近似落位目检用） */
export function sampleLogoPng(): Buffer {
  return makePng(180, 48, (x, y) => {
    if (x < 3 || y < 3 || x > 176 || y > 44) return [30, 60, 120];
    if ((x + y) % 16 < 8) return [45, 90, 170];
    return [250, 250, 250];
  });
}

/**
 * 0035 修复批：行内符号 SVG 素材（采集站公式/符号图多为 SVG；旧实现只认位图 → 整幅 [图缺失]）。
 * 画出等比三角符号，尺寸与菁优采集小图同量级（22×39），走 `.inline-figure` 行内路径。
 */
export function sampleInlineSvg(): Buffer {
  return Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="39" viewBox="0 0 22 39">'
    + '<rect x="0" y="0" width="22" height="39" fill="none"/>'
    + '<path d="M3 36 L11 4 L19 36 Z" fill="none" stroke="#111" stroke-width="1.6"/>'
    + '<line x1="11" y1="4" x2="11" y2="36" stroke="#111" stroke-width="0.8"/>'
    + '</svg>',
    'utf-8'
  );
}

function sampleLayout(): PaperLayoutConfig {
  return {
    version: 2,
    pageSize: 'A4',
    orientation: 'portrait',
    columns: 2,
    columnGapMm: 8,
    fontSize: 12,
    fontFamily: "'SimSun', 'STSong', serif",
    pageMarginMm: { top: 20, right: 15, bottom: 20, left: 15 },
    header: { style: 'exam', lines: [{ text: '0035 DOCX 样例卷（公式/图片/双栏）', sizePt: 16, align: 'center', bold: true }, { text: '考试时间：60 分钟　满分：100 分', sizePt: 10, align: 'center', bold: false }] },
    answerSpace: { enabled: true, style: 'lines', heightMm: 15 },
    figureLayout: { mode: 'inline', align: 'center' },
    logos: [{ assetId: 'smoke/logo.png', xRatio: 0.06, yRatio: 0.03, widthRatio: 0.12 }],
    optionsLayout: 'auto',
  };
}

function q(over: Partial<Question> & { id: string; content: string }): Question {
  return {
    subject: '物理',
    sourceType: 'local',
    sourceDetail: { origin: 'smoke-docx' },
    images: [],
    createdAt: '2026-09-17T00:00:00Z',
    updatedAt: '2026-09-17T00:00:00Z',
    ...over,
  };
}

function sampleQuestions(): Question[] {
  return [
    q({
      id: 'smoke-q1',
      content: '<div class="question">质量为 <span class="math" data-tex="m"></span> 的物体从高 <span class="math" data-tex="h"></span> 处自由下落，'
        + '落地速度 <span class="math" data-tex="v=\\sqrt{2gh}"></span> 是怎么来的？写出机械能守恒式 '
        + '<span class="math" data-tex="mgh=\\frac{1}{2}mv^2"></span> 并说明各项含义。<div class="options">'
        + '<span class="option">A. 动能增加量等于重力势能减少量</span>'
        + '<span class="option">B. 动能增加量大于重力势能减少量</span>'
        + '<span class="option">C. 机械能总量随下落而增大</span>'
        + '<span class="option">D. 以上均不正确</span></div></div>',
      answer: '落地速度满足 <span class="math" data-tex="v=\\sqrt{2gh}"></span>',
    }),
    q({
      id: 'smoke-q2',
      content: '<div class="question">如图为测量电阻 <span class="math" data-tex="R"></span> 的电路，'
        + '请按欧姆定律 <span class="math" data-tex="R=\\frac{U}{I}"></span> 计算阻值。'
        // 0035 修复批：行内符号 SVG（采集站同形态；须原样留在文字流内，不得拆段/丢图）
        + '范围为 <span class="inline-figure">'
        + '<img class="q-figure" data-w="22" data-h="39" src="data-assets/smoke/symbol.svg">'
        + '</span><i>mg</i> 以内。'
        + '<figure class="diagram" data-align="center" data-w="320" data-h="200"><img src="data-assets/smoke/figure-1.png" alt="电路图"></figure></div>',
      images: [
        { assetId: 'smoke/figure-1.png', type: 'figure', width: 320, height: 200 },
        { assetId: 'data-assets/smoke/symbol.svg', type: 'figure' },
      ],
      analysis: '<p>先读电压表与电流表示数，再作商。</p>',
    }),
    q({
      id: 'smoke-q3',
      content: '<div class="question">求定积分并写出过程：'
        + '<span class="math" data-tex="\\int_{0}^{1} x^2\\,\\mathrm{d}x" data-display="true"></span>'
        + '并讨论极限 <span class="math" data-tex="\\lim_{x\\to 0}\\frac{\\sin x}{x}"></span> 的值。</div>',
      answer: '<span class="math" data-tex="\\int_{0}^{1} x^2\\,\\mathrm{d}x=\\frac{1}{3}"></span>',
      analysis: '<p>先求原函数，再代入上下限。</p>',
    }),
    q({
      id: 'smoke-q4',
      content: '<div class="question">下列各式正确的是（　　）<div class="options">'
        + '<span class="option">A. <span class="math" data-tex="\\sqrt{2}\\approx 1.414"></span></span>'
        + '<span class="option">B. <span class="math" data-tex="\\frac{\\pi}{2}=1"></span></span>'
        + '<span class="option">C. <span class="math" data-tex="e^{0}=0"></span></span>'
        + '<span class="option">D. <span class="math" data-tex="\\log_{2}8=4"></span></span></div></div>',
    }),
    q({
      id: 'smoke-q5',
      content: '<div class="question">化简：<span class="math" data-tex="\\frac{x^{2}-1}{x-1}"></span>，并指出 '
        + '<span class="math" data-tex="x\\neq 1"></span> 的理由。'
        + '<figure class="diagram" data-w="200"><img src="data-assets/smoke/figure-1.png" alt="示意图"></figure></div>',
      images: [{ assetId: 'smoke/figure-1.png', type: 'figure', width: 200 }],
    }),
  ];
}

/** 文本内容块（节标题行；不占题号） */
const TEXT_ROW_ID = 'text:smoke-section';

export async function runSmokeDocx(opts: SmokeDocxOptions): Promise<SmokeDocxReport> {
  const assetsDir = join(opts.userDataPath, 'data', 'assets', 'smoke');
  mkdirSync(assetsDir, { recursive: true });
  mkdirSync(opts.outDir, { recursive: true });
  writeFileSync(join(assetsDir, 'figure-1.png'), sampleFigurePng());
  writeFileSync(join(assetsDir, 'logo.png'), sampleLogoPng());
  writeFileSync(join(assetsDir, 'symbol.svg'), sampleInlineSvg());

  const questions = sampleQuestions();
  const paper: Paper = {
    id: 'smoke-paper-0035',
    title: '0035 DOCX 样例卷',
    config: { totalScore: 100, duration: 60 },
    createdAt: '2026-09-17T00:00:00Z',
    archived: false,
    status: 'done',
    layoutConfig: sampleLayout(),
  };

  // 行序：题 1 → 文本块（节标题）→ 题 2..5；题级覆盖：q2 side-by-side、q4 选项单行
  const rows: Question[] = [
    questions[0],
    q({ id: TEXT_ROW_ID, content: '<div class="question">二、综合题</div>' }),
    ...questions.slice(1),
  ];

  const result = await buildDocxBuffer(
    {
      paper,
      questions: rows,
      mode: 'teacher',
      options: {
        scores: [10, undefined, 20, 15, 20, 35],
        textBlocks: { [TEXT_ROW_ID]: { id: TEXT_ROW_ID, text: '二、综合题', style: 'section' } },
        questionLayouts: {
          'smoke-q4': { optionsLayout: 'single-line' },
        },
      },
    },
    { rasterize: rasterizeMath, rasterizeSvg: rasterizeSvgAssets, assetsRoot: join(opts.userDataPath, 'data', 'assets') }
  );

  const docxPath = join(opts.outDir, 'sample-0035.docx');
  writeFileSync(docxPath, result.buffer);
  const stats: ExportDocxStats = {
    mathTotal: result.math.total,
    mathRasterized: result.math.rasterized,
    mathFailed: result.math.failed.length,
    imagesTotal: result.images.total,
    imagesEmbedded: result.images.embedded,
    imagesMissing: result.images.missing.length,
    degradations: result.degradations.map((d) => ({ tag: d.tag, count: d.count })),
    issues: result.issues.map((issue) => `${issue.kind}: ${issue.detail}`),
  };
  const report: SmokeDocxReport = {
    docxPath,
    bytes: result.buffer.length,
    stats,
    degradations: result.degradations,
  };
  writeFileSync(join(opts.outDir, 'sample-0035.stats.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  console.log(`OK   smoke-docx 导出完成: ${docxPath} (${result.buffer.length} bytes)`);
  console.log(`     公式 ${stats.mathRasterized}/${stats.mathTotal} 栅格成功；图片 ${stats.imagesEmbedded}/${stats.imagesTotal} 内嵌；降级 ${stats.degradations.length} 类`);
  if (stats.imagesMissing > 0 || stats.mathFailed > 0) {
    console.log(`     缺口（如实记录）: ${JSON.stringify({ missing: result.images.missing, failed: result.math.failed })}`);
  }
  return report;
}
