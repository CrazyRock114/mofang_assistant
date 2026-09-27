// 0005 课后反馈 M6：图片卡片自绘 HTML 构建器（纯函数；域隔离红线：不用 buildPaperHtml、
// 不引 KaTeX——反馈文本无公式）。固定像素容器（750×1000，微信友好 2:3）+ body margin 0，
// 配合 feedback.exportCards（主进程 capturePage，窗口内容尺寸=卡片尺寸）保证输出 PNG 完整无白边。
// 内置 2 款样式（简洁=白底黑字灰线 / 暖色=米底棕字），参数化主色 + 顶部徽标图位
// （data-assets 相对引用，主进程导出时改写 file:// 绝对路径）。

export type FeedbackCardStyle = 'clean' | 'warm';

export interface FeedbackCardOptions {
  /** 称呼/标题行下的正文（已 renderFeedback 渲染的成品文本；\n 换行） */
  bodyText: string;
  /** 卡片标题（缺省「课后反馈」） */
  title?: string;
  studentName?: string;
  subject?: string;
  date?: string;
  teacherName?: string;
  style?: FeedbackCardStyle;
  /** 主色（缺省随款式内置默认） */
  accentColor?: string;
  /** 徽标图 data-assets 相对路径（如 logos/<uuid>.png；缺省无徽标） */
  logoRelPath?: string;
}

/** 卡片设计尺寸（px；exportCards 窗口内容尺寸据此设定） */
export const FEEDBACK_CARD_WIDTH = 750;
export const FEEDBACK_CARD_HEIGHT = 1000;

const STYLE_PRESETS: Record<FeedbackCardStyle, { bg: string; text: string; accent: string; line: string; label: string }> = {
  clean: { bg: '#ffffff', text: '#333333', accent: '#222222', line: '#d9d9d9', label: '简洁' },
  warm: { bg: '#fdf6ec', text: '#5a4634', accent: '#8b5a2b', line: '#e7d8c3', label: '暖色' },
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 文本 → HTML（换行转 <br>；已转义） */
function textToHtml(text: string): string {
  return escapeHtml(text).replace(/\n/g, '<br>');
}

export interface FeedbackCard {
  html: string;
  width: number;
  height: number;
}

/** 卡片 HTML 构建（纯函数；img 用 data-assets 相对引用，页面预览与导出改写同源引用形态） */
export function buildFeedbackCardHtml(options: FeedbackCardOptions): FeedbackCard {
  const style = options.style ?? 'clean';
  const preset = STYLE_PRESETS[style];
  const accent = options.accentColor ?? preset.accent;
  const title = options.title?.trim() ? options.title.trim() : '课后反馈';
  const width = FEEDBACK_CARD_WIDTH;
  const height = FEEDBACK_CARD_HEIGHT;

  const heading = options.studentName?.trim() ? `致 ${options.studentName.trim()} 家长` : '';
  const metaParts: string[] = [];
  if (options.subject?.trim()) metaParts.push(`科目：${options.subject.trim()}`);
  if (options.date?.trim()) metaParts.push(`日期：${options.date.trim()}`);
  const metaHtml = metaParts.length > 0
    ? `<div class="meta">${textToHtml(metaParts.join('　·　'))}</div>`
    : '';

  const logoHtml = options.logoRelPath
    ? `<img class="brand" src="data-assets/${escapeHtml(options.logoRelPath)}" alt="">`
    : '';

  const footer = options.teacherName?.trim()
    ? `<div class="footer">—— ${escapeHtml(options.teacherName.trim())}</div>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
  html, body { margin: 0; padding: 0; }
  .card {
    width: ${width}px; height: ${height}px; box-sizing: border-box;
    background: ${preset.bg}; color: ${preset.text};
    padding: 64px 56px; display: flex; flex-direction: column;
    font-family: 'PingFang SC', 'Microsoft YaHei', sans-serif;
  }
  .brand { width: 140px; margin-bottom: 28px; display: block; }
  h1 { color: ${accent}; font-size: 40px; margin: 0 0 12px; letter-spacing: 2px; }
  .who { font-size: 24px; margin: 0 0 6px; color: ${accent}; }
  .meta { font-size: 18px; color: ${preset.text}; opacity: 0.75; margin: 0 0 20px; }
  .divider { border: none; border-top: 2px solid ${preset.line}; width: 100%; margin: 18px 0 28px; }
  .body { font-size: 24px; line-height: 1.85; flex: 1 1 auto; overflow: hidden; white-space: normal; word-break: break-word; }
  .footer { font-size: 22px; text-align: right; color: ${accent}; margin-top: 20px; }
</style>
</head>
<body>
  <div class="card">
    ${logoHtml}
    <h1>${escapeHtml(title)}</h1>
    ${heading ? `<div class="who">${escapeHtml(heading)}</div>` : ''}
    ${metaHtml}
    <hr class="divider">
    <div class="body">${textToHtml(options.bodyText)}</div>
    ${footer}
  </div>
</body>
</html>
`.trim();

  return { html, width, height };
}
