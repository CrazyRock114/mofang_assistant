// Phase 2: BankService 统一实现（组合 QuestionService 和 PaperService）

import type { BankService, Question, QuestionFilter, Paper, PaperSummary, PaperQuestionRef, PaperTextBlockStyle } from '../shared/contracts/bank-types.js';
import type { Database } from './db.js';
import { QuestionService } from './question-service.js';
import { PaperService } from './paper-service.js';

export class BankServiceImpl implements BankService {
  private questionService: QuestionService;
  private paperService: PaperService;

  constructor(db: Database) {
    this.questionService = new QuestionService(db);
    this.paperService = new PaperService(db);
  }

  // Question operations
  createQuestion(data: Omit<Question, 'id' | 'createdAt' | 'updatedAt'>): Promise<Question> {
    return this.questionService.createQuestion(data);
  }

  getQuestion(id: string): Promise<Question | null> {
    return this.questionService.getQuestion(id);
  }

  listQuestions(filter?: QuestionFilter): Promise<Question[]> {
    return this.questionService.listQuestions(filter);
  }

  updateQuestion(id: string, data: Partial<Omit<Question, 'id' | 'createdAt'>>): Promise<Question> {
    return this.questionService.updateQuestion(id, data);
  }

  deleteQuestion(id: string): Promise<void> {
    return this.questionService.deleteQuestion(id);
  }

  addTag(questionId: string, tag: string, color?: string): Promise<void> {
    return this.questionService.addTag(questionId, tag, color);
  }

  removeTag(questionId: string, tag: string): Promise<void> {
    return this.questionService.removeTag(questionId, tag);
  }

  // Paper operations
  createPaper(title: string, config?: Record<string, unknown>): Promise<Paper> {
    return this.paperService.createPaper(title, config);
  }

  getPaper(id: string): Promise<Paper | null> {
    return this.paperService.getPaper(id);
  }

  listPapers(): Promise<PaperSummary[]> {
    return this.paperService.listPapers();
  }

  addQuestion(
    paperId: string,
    questionId: string,
    score?: number,
    layout?: PaperQuestionRef['layout'],
    textBlock?: { text: string; style?: PaperTextBlockStyle }
  ): Promise<void> {
    // 0004-fix-4 2.3：5 参直通（textBlock=文本内容块；此前只透传 3 参会丢行类型）
    return this.paperService.addQuestion(paperId, questionId, score, layout, textBlock);
  }

  removeQuestion(paperId: string, questionId: string): Promise<void> {
    return this.paperService.removeQuestion(paperId, questionId);
  }

  reorderQuestions(paperId: string, questionIds: string[]): Promise<void> {
    return this.paperService.reorderQuestions(paperId, questionIds);
  }

  getPaperQuestions(paperId: string): Promise<PaperQuestionRef[]> {
    return this.paperService.getPaperQuestions(paperId);
  }

  setQuestionScore(paperId: string, questionId: string, score: number | undefined): Promise<void> {
    return this.paperService.setQuestionScore(paperId, questionId, score);
  }
}
