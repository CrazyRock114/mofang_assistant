import { Node, mergeAttributes } from '@tiptap/core';

export const AnswerBlock = Node.create({
  name: 'answerBlock',
  group: 'block',
  content: 'block+',

  parseHTML() {
    return [{ tag: 'div.answer' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ class: 'answer' }, HTMLAttributes), 0];
  },
});
