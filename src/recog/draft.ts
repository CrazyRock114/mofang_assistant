// C0 Phase 3: DraftBuilder — RecognizedQuestion → ScanDraft
// 最小 markdown→HTML 转换（禁止引入 markdown 库），只覆盖：段落包 <p>、\(...\) 行内公式、
// \[...\] 展示公式（data-display="true"）、选项块 <div class="options">、图位块 <figure class="diagram">。
// 取舍：块内换行保留 \n 不细分段落；图块无裁图数据时 data-w/h=0、img src 留空占位并记 warning。

import type { DraftBuilder, QuestionBlock, RecognizedQuestion, ScanDraft } from '../shared/contracts/recog-types.js';

function escapeHtmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

const MATH_RE = /\\\[([\s\S]*?)\\\]|\\\(([\s\S]*?)\\\)/g;

/** markdown 文本 → HTML 片段：正文转义 + 公式转 <span class="math" data-tex> */
export function inlineToHtml(text: string): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(MATH_RE)) {
    out += escapeHtmlText(text.slice(last, m.index));
    const display = m[1] !== undefined;
    const tex = (display ? m[1] : m[2]).trim();
    out += `<span class="math" data-tex="${escapeHtmlAttr(tex)}"${display ? ' data-display="true"' : ''}></span>`;
    last = m.index + m[0].length;
  }
  out += escapeHtmlText(text.slice(last));
  return out;
}

function blockToParagraphHtml(block: QuestionBlock): string {
  return `<p>${inlineToHtml(block.text)}</p>`;
}

function imageBlockToHtml(block: QuestionBlock): string {
  const alt = escapeHtmlAttr(block.imageRefId ?? '');
  return `<figure class="diagram" data-align="center" data-w="0" data-h="0"><img src="" alt="${alt}"></figure>`;
}

class MinimalDraftBuilder implements DraftBuilder {
  build(q: RecognizedQuestion): ScanDraft {
    const warnings: string[] = [];
    const contentParts: string[] = [];
    const answerParts: string[] = [];
    const analysisParts: string[] = [];

    let hasStem = false;
    let i = 0;
    while (i < q.blocks.length) {
      const block = q.blocks[i];
      if (block.type === 'question') {
        if (block.text.trim()) hasStem = true;
        contentParts.push(blockToParagraphHtml(block));
        i++;
      } else if (block.type === 'option') {
        const options: string[] = [];
        while (i < q.blocks.length && q.blocks[i].type === 'option') {
          options.push(`<span class="option">${inlineToHtml(q.blocks[i].text)}</span>`);
          i++;
        }
        contentParts.push(`<div class="options">${options.join('')}</div>`);
      } else if (block.type === 'image') {
        contentParts.push(imageBlockToHtml(block));
        warnings.push(`图片块 ${block.imageRefId ?? block.id} 无裁图数据，img 为占位`);
        i++;
      } else if (block.type === 'answer') {
        answerParts.push(blockToParagraphHtml(block));
        i++;
      } else {
        analysisParts.push(blockToParagraphHtml(block));
        i++;
      }
    }

    if (!hasStem) warnings.unshift('题面为空');

    return {
      pageNo: q.pageNo,
      qno: q.qno,
      contentHtml: `<div class="question">${contentParts.join('')}</div>`,
      answerHtml: answerParts.length > 0 ? answerParts.join('') : undefined,
      analysisHtml: analysisParts.length > 0 ? analysisParts.join('') : undefined,
      imageRefIds: [...q.imageRefIds],
      rawText: q.rawText,
      warnings,
    };
  }
}

export function createDraftBuilder(): DraftBuilder {
  return new MinimalDraftBuilder();
}
