// Phase 1 (B1-fix): 浏览器环境渲染入口 — vite ?raw import 获取 CSS

import type { Paper, Question } from '../../shared/contracts/bank-types.js';
import {
  renderQuestions,
  buildHtmlDocument,
  hasPerQuestionAnswerSpace,
  type RenderOptions,
} from './buildPaperHtml.core.js';
import { resolveLayout } from './layout.js';

// Vite 特殊导入：?raw 获取文本内容（离线应用，不用 CDN）
import katexCss from 'katex/dist/katex.min.css?raw';
import paperCss from './paper.css?raw';

export type { RenderOptions };

export async function buildPaperHtml(
  paper: Paper,
  questions: Question[],
  options: RenderOptions
): Promise<string> {
  // 使用核心渲染逻辑（D1 P3 消费点 A：data-assets 资产根缺省取 __mofangPaths，浏览器 dev 回落占位）
  const assetsRoot =
    options.assetsRoot ??
    (typeof window !== 'undefined' ? window.__mofangPaths?.userDataAssets : null) ??
    null;
  const questionsHtml = renderQuestions(questions, {
    ...options,
    assetsRoot,
  });

  // 构建完整 HTML（浏览器侧：vite 提供的 CSS 文本；config 驱动时附 layout 上下文，基线时缺省）
  const resolved =
    options.layoutConfig || options.questionLayouts
      ? resolveLayout(options.layoutConfig)
      : null;
  return buildHtmlDocument(
    paper,
    questionsHtml,
    katexCss,
    paperCss,
    resolved
      ? {
          resolved,
          assetsRoot,
          perQuestionAnswerSpace: hasPerQuestionAnswerSpace(options.questionLayouts),
        }
      : undefined
  );
}
