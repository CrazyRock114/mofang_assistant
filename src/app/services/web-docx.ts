// 纯网页端 Word (DOCX) 导出引擎：浏览器端纯前端生成 .docx 离线文件
import {
  Document,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  Packer,
} from 'docx';
import type { Paper, Question } from '../../shared/contracts/bank-types.js';
import type { PreviewMode, PaperRenderLayout } from '../pages/paper-actions.js';

export async function exportPaperDocxInBrowser(
  paper: Paper,
  questions: Question[],
  mode: PreviewMode,
  _layout?: PaperRenderLayout
): Promise<Blob> {
  const children: Paragraph[] = [];

  // 卷头大标题
  children.push(
    new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: paper.title || '试卷',
          bold: true,
          size: 36, // 18pt
        }),
      ],
      spacing: { after: 240 },
    })
  );

  // 卷头信息
  const versionText = mode === 'student' ? '学生版' : '教师版';
  const duration = paper.config?.duration ? `考试时间：${paper.config.duration}分钟` : '';
  const totalScore = paper.config?.totalScore ? `总分：${paper.config.totalScore}分` : '';
  const infoParts = [versionText, totalScore, duration].filter(Boolean).join('  |  ');

  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: infoParts,
          size: 20, // 10pt
          color: '666666',
        }),
      ],
      spacing: { after: 360 },
    })
  );

  // 逐题写入
  let index = 1;
  for (const q of questions) {
    // 题干 HTML 文本提取
    const tmp = document.createElement('div');
    tmp.innerHTML = q.content || q.stemHtml || '';
    const cleanContent = (tmp.textContent || tmp.innerText || '').trim();

    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `${index}. `,
            bold: true,
            size: 22,
          }),
          new TextRun({
            text: cleanContent,
            size: 22,
          }),
        ],
        spacing: { before: 240, after: 120 },
      })
    );

    // 选项列表
    if (q.options && q.options.length > 0) {
      for (const opt of q.options) {
        children.push(
          new Paragraph({
            indent: { left: 400 },
            children: [
              new TextRun({
                text: `${opt.key}. ${opt.content}`,
                size: 20,
              }),
            ],
            spacing: { after: 80 },
          })
        );
      }
    }

    // 教师版：答案与解析
    if (mode === 'teacher') {
      if (q.answer) {
        const tmpAns = document.createElement('div');
        tmpAns.innerHTML = q.answer;
        children.push(
          new Paragraph({
            indent: { left: 200 },
            children: [
              new TextRun({
                text: `【答案】${(tmpAns.textContent || tmpAns.innerText || '').trim()}`,
                color: 'D32F2F',
                bold: true,
                size: 20,
              }),
            ],
            spacing: { before: 120, after: 60 },
          })
        );
      }
      if (q.analysis) {
        const tmpAna = document.createElement('div');
        tmpAna.innerHTML = q.analysis;
        children.push(
          new Paragraph({
            indent: { left: 200 },
            children: [
              new TextRun({
                text: `【解析】${(tmpAna.textContent || tmpAna.innerText || '').trim()}`,
                color: '2E7D32',
                size: 20,
              }),
            ],
            spacing: { after: 120 },
          })
        );
      }
    }

    index++;
  }

  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: 1440, // 1 inch
              right: 1440,
              bottom: 1440,
              left: 1440,
            },
          },
        },
        children,
      },
    ],
  });

  return await Packer.toBlob(doc);
}
