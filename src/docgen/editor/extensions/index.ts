export { MathInline, mathBridge } from './mathInline';
export { QuestionBlock } from './questionBlock';
export { FigureNode } from './figureNode';
export { InlineFigure } from './inlineFigure';
export { OptionsNode, OptionNode, canRemoveOption } from './optionsNode';
export { AnswerBlock } from './answerBlock';

import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';

/**
 * 0045 目检返工④：表格扩展组（官方 @tiptap/extension-table）。
 * QuestionBlock 的内容白名单引用 `table`，**凡自建 Editor 并注册 QuestionBlock 的消费方必须一并注册本组**，
 * 否则 schema 构建报「Unknown node type: table」（既有三处测试已同步登记）。
 */
export const QUESTION_TABLE_EXTENSIONS = [
  Table.configure({ resizable: false }),
  TableRow,
  TableHeader,
  TableCell,
];
