// Phase 1: 核心渲染逻辑（环境无关的纯函数）
// 0004 Phase 4（乙路）：新增 config 驱动渲染路径（layoutConfig/questionLayouts）；
// 无 config 且无题级覆盖 → 基线路径，输出与历史逐字节一致（既有 docgen 测试与 smoke-pdf 零回归）。

import type {
  Paper,
  Question,
  PaperLayoutConfig,
  QuestionFigureLayout,
  QuestionAnswerSpaceOverride,
  OptionsLayoutMode,
  PaperTextBlock,
} from '../../shared/contracts/bank-types.js';
import katex from 'katex';
import {
  resolveLayout,
  normalizeOptionsLayout,
  effectiveContentVisibility,
  buildLayoutCss,
  mm,
  pageDimsMm,
  answerSpaceLineHeightMm,
  type ResolvedLayout,
  type ResolvedHeaderLine,
} from './layout.js';
import {
  planQuestionFigures,
  buildRenderSegments,
  buildImageTypeTable,
  applyFigureOverrides,
  renderFigureBlock,
  normalizeAssetId,
} from './figureBlocks.js';

export interface RenderOptions {
  mode: 'student' | 'teacher';
  /** 0018 目检返工三：元素允许 undefined（该题未设置分值 → 不渲染题头分值；与 0 分区分） */
  scores?: (number | undefined)[];
  /** data-assets/ 资产磁盘根（userData/data/assets）；null/缺省 → 图引用转可读占位 */
  assetsRoot?: string | null;
  /** 0004 v2：版式配置（缺省且无 questionLayouts → 基线渲染） */
  layoutConfig?: PaperLayoutConfig;
  /** 0004：题级覆盖（key=questionId；引擎只消费传入值，不读库）。
   * fix-3 P0-1：figures 覆盖 assetId 全集并入块化参与集（覆盖优先参与）；
   * content 匹配不到的外来图合成渲染（题尾默认位）。
   * fix-3 P1-2：answerSpace 题级作答区覆盖（题级>卷级，style 'none'=该题不插）。
   * 0013：optionsLayout 题级选项版式覆盖（键存在即覆盖卷级档；非法值归一 auto）。 */
  questionLayouts?: Record<string, { figures?: QuestionFigureLayout[]; answerSpace?: QuestionAnswerSpaceOverride; optionsLayout?: OptionsLayoutMode }>;
  /**
   * 0004-fix-4 2.3（只增）：文本内容块（key=行 id，与 questions 数组中的占位题 id 一致）。
   * 命中者渲染为节标题块，且**不占题号**（题号按题目行递增）。
   */
  textBlocks?: Record<string, PaperTextBlock>;
  /**
   * 0004-fix-5 P0-2（只增）：段边界标记（`.mf-seg[data-mf-seg]`）——交互预览落点吸附用。
   * 缺省 false：打印/PDF 与历史产物零改动；仅 ComposePage 页内预览置 true。
   */
  segmentAnchors?: boolean;
}

/** buildHtmlDocument 的 config 驱动上下文（缺省=基线文档骨架） */
export interface DocumentLayoutContext {
  resolved: ResolvedLayout;
  assetsRoot: string | null;
  /** fix-3 P1-2：任一题存在题级作答区覆盖（buildLayoutCss 据此补注入作答区结构规则） */
  perQuestionAnswerSpace?: boolean;
}

/**
 * D1 P3：data-assets/ 前缀渲染层解析（纯函数，renderer 与 Node 共用）
 * src="data-assets/capture/..." → file:///<assetsRoot>/capture/...（Windows 反斜杠归一）
 * assetsRoot 为 null（浏览器 dev 无 __mofangPaths）→ 整 img 转可读占位，不残留裂图
 */
export function rewriteDataAssetSrcs(html: string, assetsRoot: string | null): string {
  if (!html.includes('data-assets/')) return html;
  return html.replace(
    /<img\b[^>]*?\bsrc=(["'])data-assets\/([^"']*)\1[^>]*>/g,
    (match, quote: string, rel: string) => {
      if (!assetsRoot) {
        return `<span class="asset-placeholder">[图: data-assets/${rel}（当前环境无资产根，Electron 内可加载）]</span>`;
      }
      const root = assetsRoot.replace(/\\/g, '/').replace(/\/+$/, '');
      const fileUrl = `${root.startsWith('/') ? 'file://' : 'file:///'}${root}/${rel}`;
      return match.replace(`src=${quote}data-assets/${rel}${quote}`, `src=${quote}${fileUrl}${quote}`);
    }
  );
}

/**
 * 渲染公式：将契约格式 <span class="math" data-tex="..."> 替换为 KaTeX HTML
 */
export function renderMath(content: string): string {
  // 处理带 data-display 属性的公式（行间/行内）
  content = content.replace(
    /<span class="math"[^>]*data-tex="([^"]*)"[^>]*data-display="([^"]*)"[^>]*>/g,
    (match, tex, display) => {
      const displayMode = display === 'true';
      try {
        return katex.renderToString(tex, { throwOnError: false, displayMode });
      } catch {
        return `<span class="math-error">${tex}</span>`;
      }
    }
  );

  // 处理无 data-display 的公式（默认行内）
  content = content.replace(
    /<span class="math"[^>]*data-tex="([^"]*)"[^>]*>/g,
    (match, tex) => {
      try {
        return katex.renderToString(tex, { throwOnError: false, displayMode: false });
      } catch {
        return `<span class="math-error">${tex}</span>`;
      }
    }
  );

  return content;
}

/**
 * 处理 figure：data-w → width style，添加 break-inside
 * data-w="0"（尺寸未知）不转样式，交给 CSS max-width 限宽（D1-fix R-4/R-5）
 * 大图封顶：width 保留原像素值 + max-width:60%（0004 S4 默认观感档，由 D1-fix-3 J-3 的 80% 收紧）——
 * 块级配图宽 = min(原像素宽按 96dpi 换算, 容器宽 × 60%)：原宽小于 60% 时按原宽再现（只收敛不放大小图），
 * 原宽超档（如实站 1031px 配图 vs A4 约 680px 版心）时收敛到 60% 版心（多列下 % 天然相对列盒）；
 * 采集预览同观感（容器百分比限宽）。行内公式图不受影响（.inline-figure > img 200px 封顶随文流）
 */
export function processFigures(content: string): string {
  // 块级配图：figure data-w>0 → width style（max-width:60% 默认观感档封顶）
  content = content.replace(
    /<figure([^>]*)data-w="([1-9]\d*)"([^>]*)>/g,
    '<figure$1$3 style="width: $2px; max-width: 60%; break-inside: avoid;">'
  );
  // 行内公式图（inline-figure 内 img）：data-w>0 → width style，再现网页预览像素宽
  content = content.replace(
    /<img\b([^>]*?)data-w="([1-9]\d*)"([^>]*?)>/g,
    '<img$1$3 style="width: $2px;">'
  );
  return content;
}

/**
 * 移除答案块（学生版）
 */
export function stripAnswerBlocks(content: string): string {
  return content.replace(/<div class="answer"[^>]*>[\s\S]*?<\/div>/g, '');
}

/**
 * 标记答案块为红色（教师版）
 */
export function highlightAnswerBlocks(content: string): string {
  return content.replace(
    /<div class="answer"([^>]*)>/g,
    '<div class="answer"$1 style="color: #d32f2f;">'
  );
}

/**
 * 处理题目内容（公式渲染 + figure 处理 + 答案处理）——基线路径
 */
export function processQuestionContent(content: string, mode: 'student' | 'teacher'): string {
  // 渲染公式
  content = renderMath(content);

  // 处理 figure
  content = processFigures(content);

  // 答案处理
  if (mode === 'student') {
    content = stripAnswerBlocks(content);
  } else if (mode === 'teacher') {
    content = highlightAnswerBlocks(content);
  }

  return content;
}

/**
 * 0004-fix-4 2.3：文本内容块渲染（节标题/备注）。
 * 不占题号（renderQuestions 只在题目行递增题号）；结构复用 .question-item 顶层块，
 * 分页装箱/拖拽排序/克隆导出与题目行同机制。正文纯文本 → HTML 转义 + 换行转 <br>。
 * 0004-fix-6 P1-1：显式 align 输出对齐类（.mf-text-item--align-*）覆盖样式基线观感；
 * 缺省不输出类（section 居中 / note 左 = CSS 基线），存量渲染零漂移。
 */
export function renderTextBlockHtml(block: PaperTextBlock): string {
  const style = block.style ?? 'section';
  const alignClass = block.align ? ` mf-text-item--align-${block.align}` : '';
  return `
      <div class="question-item mf-text-item mf-text-item--${style}${alignClass}">
        <div class="mf-text-body">${escapeTextHtml(block.text)}</div>
      </div>`;
}

/** 文本块正文转义（防注入；换行保留） */
function escapeTextHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r?\n/g, '<br>');
}

/**
 * 0009：卷头自定义行渲染（输入=归一化后的行——字号/对齐/加粗缺省与界内收拢都在归一化层落定）。
 * 文本走 escapeTextHtml（含 \n→<br>）；行内联样式承载三项可调参数，paper.css 只给基础行距。
 */
function renderHeaderLineHtml(line: ResolvedHeaderLine): string {
  const weight = line.bold ? 'bold' : 'normal';
  return `      <div class="paper-header-line" style="font-size:${line.sizePt}pt;text-align:${line.align};font-weight:${weight}">${escapeTextHtml(line.text)}</div>`;
}

/**
 * 渲染题目列表（基线 / config 驱动双路径分发）。
 * 0004-fix-4 2.3：textBlocks 命中的行渲染为文本内容块，且不占题号——
 * 题号/分值索引按题目行（kind!=='text'）单独递增，与 UI 列表序号语义一致。
 */
export function renderQuestions(
  questions: Question[],
  options: RenderOptions
): string {
  const layout: ResolvedLayout | null =
    options.layoutConfig || options.questionLayouts
      ? resolveLayout(options.layoutConfig)
      : null;

  let questionIndex = 0;
  return questions
    .map((q) => {
      const textBlock = options.textBlocks?.[q.id];
      if (textBlock) return renderTextBlockHtml(textBlock);
      const index = questionIndex++;
      return layout
        ? renderLayoutQuestion(q, index, options, layout)
        : renderBaselineQuestion(q, index, options);
    })
    .join('\n');
}

/** 基线题目渲染（与历史实现逐字节一致，勿动） */
function renderBaselineQuestion(
  q: Question,
  index: number,
  options: RenderOptions
): string {
  const { mode } = options;
  const score = options.scores?.[index];

  // 处理题目 content（公式渲染 + figure + 答案处理 + data-assets 资产解析）
  let content = processQuestionContent(q.content, mode);
  content = rewriteDataAssetSrcs(content, options.assetsRoot ?? null);

  // 拼装题目 HTML（0004-fix-4 #5：题号同行——header 浮动 + 题体 BFC 悬挂缩进）
  // 0018 目检返工三：score 按数字渲染（0 分照常显示；scores 整体未传=不渲染题头分值）
  let questionHtml = `
      <div class="question-item">
        <div class="question-header">
          <span class="question-number">${index + 1}.</span>
          ${score !== undefined ? `<span class="question-score">(${score}分)</span>` : ''}
        </div>
        <div class="mf-question-body">
          <div class="question-content">${content}</div>
    `;

  // 教师版：追加 answer 和 analysis 字段（如果存在）
  if (mode === 'teacher') {
    if (q.answer) {
      const answerHtml = rewriteDataAssetSrcs(renderMath(q.answer), options.assetsRoot ?? null);
      questionHtml += `<div class="answer-field" style="color: #d32f2f;"><strong>答案：</strong>${answerHtml}</div>`;
    }
    if (q.analysis) {
      // D1-fix-4 J-10：解析与答案同管线过 renderMath（漏了则 span.math[data-tex] 空壳原样输出，解析公式"丢失"）
      const analysisHtml = rewriteDataAssetSrcs(renderMath(q.analysis), options.assetsRoot ?? null);
      questionHtml += `<div class="analysis-field" style="color: #d32f2f;"><strong>解析：</strong>${analysisHtml}</div>`;
    }
  }

  questionHtml += `</div></div>`;
  return questionHtml;
}

/**
 * 0004 config 驱动题目渲染：显隐位 + 块化图排版 + 作答区。
 * 红显仅教师版（student+显式覆盖=讲义形态，答案可见但不红显）。
 */
function renderLayoutQuestion(
  q: Question,
  index: number,
  options: RenderOptions,
  layout: ResolvedLayout
): string {
  const assetsRoot = options.assetsRoot ?? null;
  const score = options.scores?.[index];
  const vis = effectiveContentVisibility(layout.fieldVisibility, options.mode);

  // 内容管线：公式 → figure 宽度 → 答案显隐（答案位关闭一律剥离）
  let content = renderMath(q.content);
  content = processFigures(content);
  if (!vis.answer) {
    content = stripAnswerBlocks(content);
  } else if (options.mode === 'teacher') {
    content = highlightAnswerBlocks(content);
  }

  // 块化图排版（题级覆盖优先；G3 非 figure 语义留文本流）。
  // fix-3 P0-1 覆盖优先参与：题级覆盖 assetId 全集（图类资格过滤后）并入块化参与集——
  // 裸行内图（无语义）被覆盖提升=块化可调；content 匹配不到的外来图合成渲染（段序列题尾默认位），
  // 排序/移动/缩放复用既有槽位语义；默认（无覆盖）行为零变化。
  // fix-2 F2-C：块化输出交错段序列（图块锚点=段位置），inline 按段序原位输出（图随文流），
  // 题首孤图后移（与 capture relocateLeadingFigures 语义一致，存量菁优题引擎路径即时正常）；
  // side-by-side 图块聚合右栏（图按覆盖序）。
  // S4 遗留#1 修复（0004-S4 交付报告 §6-1）：figure 块 HTML 同样过 rewriteDataAssetSrcs——
  // 否则 config 路径下图块 src 保持 data-assets/ 相对引用，预览/导出裂图。
  // 无资产根（vitest/无 __mofangPaths 环境）保持原始形态（既有探针锚定此形态，不产占位）；
  // 预览/导出真机路径恒有 assetsRoot（getUserDataAssetsRoot/__mofangPaths），重写生效防裂图
  const rewriteFigureBlock = (html: string): string =>
    assetsRoot ? rewriteDataAssetSrcs(html, assetsRoot) : html;
  const imageTypes = buildImageTypeTable(q.images ?? []);
  const overrideFigures = options.questionLayouts?.[q.id]?.figures ?? [];
  // fix-5 P0-2：块化/提升/外来合成/段边界归属统一走 planQuestionFigures（UI 锚位换算同源；assetId 归一见其注释）
  // 0041：.inline-figure 包裹的行内公式图恒留文本流（skipInlineFigureWrap）——
  //   块化会在 span 内插 div.figure-block，使 paper.css `.inline-figure > img`（0010 P5：1.25×字号下限 +
  //   width:auto 等比 + 200px 封顶）直系选择器失配，且被 `.figure-block > img{max-width:60%}` 相对
  //   shrink-to-fit 盒再收缩（真机实测排版 34.2×7.2 vs 题库 95×20，纸面高 1.9mm vs 5.29mm）。
  //   用户口径（2026-09-18 拍板「排版页公式固定」）：行内公式图不进图排版——题级覆盖对它不生效
  //   （planQuestionFigures 内过滤；存量 layout_json 条目自然失效）；裸行内 img（无 .inline-figure）
  //   仍按 0004-fix-4 #7 可调；块级配图零变化；DOCX 导出同口径。
  const plan = planQuestionFigures(content, imageTypes, overrideFigures, { skipInlineFigureWrap: true });
  const specs = applyFigureOverrides(plan.figures, layout.figureLayout, overrideFigures);
  // 外来图缺省宽档=60% 观感档（同 S4 默认档）：题级/全局均未配置 widthPercent 时兜底
  const foreignSet = new Set(plan.foreignAssets);
  for (const spec of specs) {
    const id = normalizeAssetId(spec.figure.assetId);
    if (id !== null && foreignSet.has(id) && spec.widthPercent === null) {
      spec.widthPercent = 60;
    }
  }
  const sideHtml = specs
    .filter((s) => s.sideBySide)
    .map((s) => rewriteFigureBlock(renderFigureBlock(s)))
    .join('\n');
  // 文流 = text 段原样 + inline 图块按段序/锚位（side-by-side 图块跳过，聚右栏）；
  // fix-5 P0-2：segmentAnchors=true（交互预览）时每段边界插 .mf-seg 标记——打印/导出路径零标记零改动
  const flowParts: string[] = [];
  for (const segment of buildRenderSegments(plan.segments, specs, { markers: options.segmentAnchors === true })) {
    if (segment.kind === 'text') {
      flowParts.push(rewriteDataAssetSrcs(segment.html, assetsRoot));
    } else if (segment.kind === 'marker') {
      flowParts.push(`<span class="mf-seg" data-mf-seg="${segment.boundary}"></span>`);
    } else if (!segment.spec.sideBySide) {
      flowParts.push(rewriteFigureBlock(renderFigureBlock(segment.spec)));
    }
  }
  const flowHtml = flowParts.join('');

  const headerParts: string[] = [];
  if (vis.questionNo) headerParts.push(`<span class="question-number">${index + 1}.</span>`);
  if (vis.score && score !== undefined) headerParts.push(`<span class="question-score">(${score}分)</span>`);

  // 0013：选项版式生效值 = 题级覆盖 ?? 卷级默认档（两侧均已归一；题级非法值按显式覆盖归一 auto）。
  // 类只挂题容器：auto（缺省）不加类 → 输出逐字节零回归；无 .options 容器的题类虽在而规则无目标（零误伤）。
  const perQOptionsLayout = options.questionLayouts?.[q.id]?.optionsLayout;
  const effectiveOptionsLayout = perQOptionsLayout !== undefined
    ? normalizeOptionsLayout(perQOptionsLayout)
    : layout.optionsLayout;
  const optionsLayoutClass = effectiveOptionsLayout === 'single-line'
    ? ' ol-single'
    : effectiveOptionsLayout === 'two-lines'
      ? ' ol-two'
      : '';

  let body: string;
  if (sideHtml) {
    body = `<div class="question-row"><div class="question-content">${flowHtml}</div><div class="question-side">${sideHtml}</div></div>`;
  } else {
    body = `<div class="question-content">${flowHtml}</div>`;
  }

  let questionHtml = `
      <div class="question-item${optionsLayoutClass}">
        <div class="question-header">${headerParts.join('')}</div>
        <div class="mf-question-body">
        ${body}
    `;

  if (vis.answer && q.answer) {
    const answerHtml = rewriteDataAssetSrcs(renderMath(q.answer), assetsRoot);
    const red = options.mode === 'teacher' ? ' style="color: #d32f2f;"' : '';
    questionHtml += `<div class="answer-field"${red}><strong>答案：</strong>${answerHtml}</div>`;
  }
  if (vis.analysis && q.analysis) {
    const analysisHtml = rewriteDataAssetSrcs(renderMath(q.analysis), assetsRoot);
    const red = options.mode === 'teacher' ? ' style="color: #d32f2f;"' : '';
    questionHtml += `<div class="analysis-field"${red}><strong>解析：</strong>${analysisHtml}</div>`;
  }

  // 作答区（fix-3 P1-2）：题级覆盖优先、卷级值做缺省——题级存在即启用（style 'none'=该题不插）；
  // 复用 .answer-space 结构类；插入位=题尾（解析/答案字段后），学生/教师版语义同卷级现状
  const perQAnswerSpace = options.questionLayouts?.[q.id]?.answerSpace;
  /** fix-4 #6：题级行数（存在即优先；0=该题不留作答区） */
  const perQLines = perQAnswerSpace?.lines;
  const answerEnabled = perQAnswerSpace
    ? (perQLines !== undefined ? perQLines > 0 : perQAnswerSpace.style !== 'none')
    : layout.answerSpace.enabled;
  if (answerEnabled) {
    const style = perQAnswerSpace?.style === 'lines' || perQAnswerSpace?.style === 'blank'
      ? perQAnswerSpace.style
      : layout.answerSpace.style;
    /** fix-4 #6：行数优先（行数 × 行高 mm）；无 lines 时沿用 heightMm 语义 */
    const heightMm = perQLines !== undefined
      ? Number((perQLines * answerSpaceLineHeightMm(layout)).toFixed(2))
      : perQAnswerSpace?.heightMm ?? layout.answerSpace.heightMm;
    questionHtml += `<div class="answer-space answer-space--${style}" style="height: ${mm(heightMm)}"></div>`;
  }

  questionHtml += `</div></div>`;
  return questionHtml;
}

/**
 * fix-3 P1-2：任一题存在题级作答区覆盖（渲染入口据此给 buildLayoutCss 补注入作答区结构规则——
 * 卷级关闭而题级启用时，.answer-space 规则仍需存在）。
 */
export function hasPerQuestionAnswerSpace(
  questionLayouts?: Record<string, { figures?: QuestionFigureLayout[]; answerSpace?: QuestionAnswerSpaceOverride; optionsLayout?: OptionsLayoutMode }>
): boolean {
  for (const layout of Object.values(questionLayouts ?? {})) {
    if (layout.answerSpace && layout.answerSpace.style !== 'none') return true;
    if (layout.answerSpace && layout.answerSpace.heightMm !== undefined) return true;
  }
  return false;
}

/**
 * 构建完整 HTML（需要外部提供 CSS）。
 * layoutCtx 缺省 = 基线骨架（历史输出逐字节一致）；传入 = config 驱动（抬头样式/分栏容器/Logo 绝对定位/增量 CSS）。
 */
export function buildHtmlDocument(
  paper: Paper,
  questionsHtml: string,
  katexCss: string,
  paperCss: string,
  layoutCtx?: DocumentLayoutContext
): string {
  if (!layoutCtx) {
    const totalScore = (paper.config?.totalScore as number) ?? 0;
    const duration = (paper.config?.duration as number) ?? 0;

    return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${paper.title}</title>
  <style>${katexCss}</style>
  <style>${paperCss}</style>
</head>
<body>
  <div class="paper">
    <div class="paper-header">
      <h1 class="paper-title">${paper.title}</h1>
      <div class="paper-meta">
        ${totalScore ? `<span>总分：${totalScore}分</span>` : ''}
        ${duration ? `<span>时长：${duration}分钟</span>` : ''}
      </div>
    </div>
    <div class="paper-questions">
      ${questionsHtml}
    </div>
    <div class="paper-footer">
      <span class="pageNumber"></span> / <span class="totalPages"></span>
    </div>
  </div>
</body>
</html>
  `.trim();
  }

  const { resolved, assetsRoot } = layoutCtx;
  const title = resolved.header.title ?? paper.title;
  const totalScore = (paper.config?.totalScore as number) ?? 0;
  const duration = (paper.config?.duration as number) ?? 0;

  // 0009：卷头三态 + 多行自定义（优先级：none 无条件全灭 > lines 多行 > exam > simple）。
  // 文本走 escapeTextHtml（含 \n→<br>）；标题插值同路转义（安全修复）。
  let headerHtml = '';
  if (resolved.header.style === 'none') {
    headerHtml = '';
  } else if (resolved.header.lines.length > 0) {
    headerHtml = `
    <div class="paper-header">
${resolved.header.lines.map(renderHeaderLineHtml).join('\n')}
    </div>`;
  } else if (resolved.header.style === 'exam') {
    headerHtml = `
    <div class="paper-header">
      <h1 class="paper-title">${escapeTextHtml(title)}</h1>
      <div class="paper-meta">
        ${totalScore ? `<span>总分：${totalScore}分</span>` : ''}
        ${duration ? `<span>时长：${duration}分钟</span>` : ''}
      </div>
    </div>`;
  } else if (resolved.header.style === 'simple') {
    headerHtml = `
    <div class="paper-header paper-header--simple">
      <h1 class="paper-title">${escapeTextHtml(title)}</h1>
    </div>`;
  }

  const logosHtml = rewriteDataAssetSrcs(
    resolved.logos
      .map((logo) => {
        // fix-2 F2-A：Logo 比例坐标换算基准 = 取向换算后页宽高
        const page = pageDimsMm(resolved);
        const left = mm(logo.xRatio * page.w);
        const top = mm(logo.yRatio * page.h);
        const width = mm(logo.widthRatio * page.w);
        return `<img class="paper-logo" src="data-assets/${escapeAttr(logo.assetId)}" style="left: ${left}; top: ${top}; width: ${width};">`;
      })
      .join('\n'),
    assetsRoot
  );

  return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${paper.title}</title>
  <style>${katexCss}</style>
  <style>${paperCss}</style>
  <style>${buildLayoutCss(resolved, { perQuestionAnswerSpace: layoutCtx.perQuestionAnswerSpace === true })}</style>
</head>
<body>
  <div class="paper">
    ${headerHtml}
    <div class="paper-questions">
      ${questionsHtml}
    </div>
    <div class="paper-footer">
      <span class="pageNumber"></span> / <span class="totalPages"></span>
    </div>
    ${logosHtml}
  </div>
</body>
</html>
  `.trim();
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
