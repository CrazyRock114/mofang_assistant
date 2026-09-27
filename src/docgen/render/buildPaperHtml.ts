// Phase 1: Node 环境渲染入口 — readFileSync 获取 CSS

import type { Paper, Question } from '../../shared/contracts/bank-types.js';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  renderQuestions,
  buildHtmlDocument,
  hasPerQuestionAnswerSpace,
  type RenderOptions,
} from './buildPaperHtml.core.js';
import { resolveLayout } from './layout.js';

/**
 * Q-1 修复：改写 KaTeX 相对字体路径为绝对路径
 *
 * 将 CSS/HTML 中的 `url(fonts/KaTeX_*.woff2)` 改写为 `url(file:///...katex/dist/fonts/...)`
 * 确保 browser 入口和 Node 入口都能正确加载字体到 PDF
 */
export function rewriteKatexFontUrls(cssOrHtml: string): string {
  // 如果不包含相对路径模式，原样返回
  if (!cssOrHtml.includes('url(fonts/')) {
    return cssOrHtml;
  }

  // 解析 katex 模块路径
  const katexPath = require.resolve('katex/dist/katex.min.css');
  const katexDistDir = dirname(katexPath);
  const absoluteFontPath = `file:///${join(katexDistDir, 'fonts').replace(/\\/g, '/')}`;

  // 全局替换所有相对路径
  return cssOrHtml.replace(/url\(fonts\//g, `url(${absoluteFontPath}/`);
}

// 延迟读取 CSS（在函数内部执行，避免编译时 __dirname 问题）
let katexCss: string | null = null;
let paperCss: string | null = null;

// 0071：装配链单点注入的 data-assets 根（主进程 main.ts 启动时以 dataDir 给值）
let injectedAssetsRoot: string | null = null;

/**
 * 0071：注入缺省资产根（= `<dataDir>/assets`，由主进程装配链单点给值）。
 * 消除本模块「自取 userData」的第二真源——数据位置重定向后此处与 dataDir 恒一致；
 * 未注入（单测/浏览器环境）时保持既有派生行为，smoke 链零影响。
 */
export function setDefaultAssetsRoot(root: string | null): void {
  injectedAssetsRoot = root;
}

/**
 * D1 P3 消费点 B：Node 侧 data-assets 资产根缺省解析（userData/data/assets）
 * 仅 Electron 主进程可用（app.getPath）；vitest/非 Electron 环境返回 null → 占位回落
 */
function defaultAssetsRoot(): string | null {
  // 0071：装配链注入值优先（主进程正常启动恒走此分支）
  if (injectedAssetsRoot !== null) return injectedAssetsRoot;
  try {
    const electron = require('electron');
    const electronApp = electron?.app;
    if (!electronApp || typeof electronApp.getPath !== 'function') return null;
    return join(electronApp.getPath('userData'), 'data', 'assets');
  } catch {
    return null;
  }
}

function loadCss() {
  if (!katexCss) {
    // N-3: 使用 require.resolve 解析 node_modules 路径（不依赖 cwd）
    const katexPath = require.resolve('katex/dist/katex.min.css');
    katexCss = readFileSync(katexPath, 'utf-8');

    // N-2: 改写相对路径为绝对 file:// 路径（使用公用函数）
    katexCss = rewriteKatexFontUrls(katexCss);
  }
  if (!paperCss) {
    // N-3: paper.css 路径解析（编译后在 dist，源码在 src）
    // 优先尝试 dist 同级目录，回退到源码目录
    let paperCssPath = join(__dirname, 'paper.css');
    if (!existsSync(paperCssPath)) {
      // 回退：从 dist/docgen/render 向上找 src/docgen/render
      paperCssPath = join(__dirname, '../../../src/docgen/render/paper.css');
    }
    paperCss = readFileSync(paperCssPath, 'utf-8');
  }
}

export type { RenderOptions };

export async function buildPaperHtml(
  paper: Paper,
  questions: Question[],
  options: RenderOptions
): Promise<string> {
  loadCss();

  // 使用核心渲染逻辑（data-assets 资产根：调用方可显式覆盖，缺省取 Electron userData）
  const assetsRoot = options.assetsRoot ?? defaultAssetsRoot();
  const questionsHtml = renderQuestions(questions, {
    ...options,
    assetsRoot,
  });

  // 构建完整 HTML（Node 侧：内联 CSS；config 驱动时附 layout 上下文，基线时缺省）
  const resolved =
    options.layoutConfig || options.questionLayouts
      ? resolveLayout(options.layoutConfig)
      : null;
  return buildHtmlDocument(
    paper,
    questionsHtml,
    katexCss!,
    paperCss!,
    resolved
      ? {
          resolved,
          assetsRoot,
          perQuestionAnswerSpace: hasPerQuestionAnswerSpace(options.questionLayouts),
        }
      : undefined
  );
}
