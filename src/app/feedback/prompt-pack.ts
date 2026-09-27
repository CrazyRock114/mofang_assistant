// 0030 P5：提示词模板 pack（导出/导入文本，纯函数）——D-065②「全文可见、可改、可导出/导入（文本分享）」。
// 格式（人可读、可手改、可群发分享）：
//   # 魔方助教 · 反馈提示词模板
//   name: <模板名>
//   ---
//   <提示词正文，原样保留换行与槽位>
// 导入宽容：没有头部/分隔线时按「纯正文」处理，名称回落到文件名。

export const PROMPT_PACK_HEADER = '# 魔方助教 · 反馈提示词模板';
export const PROMPT_PACK_SEPARATOR = '---';

/** 模板 → pack 文本（导出文件内容） */
export function formatPromptPack(name: string, body: string): string {
  return `${PROMPT_PACK_HEADER}\nname: ${name}\n${PROMPT_PACK_SEPARATOR}\n${body}`;
}

export interface ParsedPromptPack {
  name: string;
  body: string;
}

function stripExtension(fileName: string): string {
  return fileName.replace(/\.(txt|md|markdown)$/i, '');
}

/**
 * pack 文本 → { name, body }。
 * - 有 `---` 分隔线：其上取 `name:` 行，其下全部为正文；
 * - 无分隔线：整段（去掉头部注释与 name 行）当正文，名称取 fallbackName；
 * - 正文空白 → 抛错（不建空模板）。
 */
export function parsePromptPack(content: string, fallbackName?: string): ParsedPromptPack {
  const normalized = (content ?? '').replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const separatorIndex = lines.findIndex((line) => line.trim() === PROMPT_PACK_SEPARATOR);

  let name = '';
  let bodyLines: string[];
  if (separatorIndex >= 0) {
    const headerLines = lines.slice(0, separatorIndex);
    const nameLine = headerLines.find((line) => line.trim().toLowerCase().startsWith('name:'));
    if (nameLine) name = nameLine.slice(nameLine.indexOf(':') + 1).trim();
    bodyLines = lines.slice(separatorIndex + 1);
  } else {
    bodyLines = lines.filter((line) => !line.trim().startsWith('#') && !line.trim().toLowerCase().startsWith('name:'));
  }

  const body = bodyLines.join('\n').trim();
  if (body === '') throw new Error('提示词模板正文为空（导入失败）');
  if (name === '') {
    const fallback = stripExtension((fallbackName ?? '').trim());
    name = fallback === '' ? '导入的模板' : `${fallback}（导入）`;
  }
  return { name, body };
}
