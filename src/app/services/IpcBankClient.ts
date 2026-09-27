// Phase 3: IpcBankClient — renderer 侧 BankService 实现（包装 window.__mofangBank）

import type { BankService, Question, QuestionFilter, Paper, PaperSummary, PaperQuestionRef } from '../../shared/contracts/bank-types.js';
import type { MofangBridge } from '../../shared/contracts/bridge.js';

export class IpcBankClient implements BankService {
  private bridge: MofangBridge;

  constructor() {
    if (!window.__mofangBank) {
      throw new Error('IpcBankClient requires window.__mofangBank (Electron environment)');
    }
    this.bridge = window.__mofangBank;
  }

  async createQuestion(data: Omit<Question, 'id' | 'createdAt' | 'updatedAt'>): Promise<Question> {
    return this.bridge.createQuestion({ data });
  }

  async getQuestion(id: string): Promise<Question | null> {
    return this.bridge.getQuestion({ id });
  }

  async listQuestions(filter?: QuestionFilter): Promise<Question[]> {
    return this.bridge.listQuestions({ filter });
  }

  async updateQuestion(id: string, data: Partial<Omit<Question, 'id' | 'createdAt'>>): Promise<Question> {
    return this.bridge.updateQuestion({ id, data });
  }

  async deleteQuestion(id: string): Promise<void> {
    return this.bridge.deleteQuestion({ id });
  }

  async addTag(questionId: string, tag: string, color?: string): Promise<void> {
    return this.bridge.addTag({ questionId, tag, color });
  }

  async removeTag(questionId: string, tag: string): Promise<void> {
    return this.bridge.removeTag({ questionId, tag });
  }

  async createPaper(title: string, config?: Record<string, unknown>): Promise<Paper> {
    return this.bridge.createPaper({ title, config });
  }

  async getPaper(id: string): Promise<Paper | null> {
    return this.bridge.getPaper({ id });
  }

  async listPapers(): Promise<PaperSummary[]> {
    return this.bridge.listPapers();
  }

  /**
   * 0004-fix-5 P1-2：全 5 参直通（此前只透传 paperId/questionId/score → textBlock/layout 在真机路径丢失，
   * 插入大标题落不了库 = 用户「插入标题无效果」根因；mock 路径支持 5 参故 UI 测试未暴露）。
   */
  async addQuestion(
    paperId: string,
    questionId: string,
    score?: number,
    layout?: PaperQuestionRef['layout'],
    textBlock?: { text: string; style?: 'section' | 'note' }
  ): Promise<void> {
    return this.bridge.addQuestion({ paperId, questionId, score, layout, textBlock });
  }

  async removeQuestion(paperId: string, questionId: string): Promise<void> {
    return this.bridge.removeQuestion({ paperId, questionId });
  }

  async reorderQuestions(paperId: string, questionIds: string[]): Promise<void> {
    return this.bridge.reorderQuestions({ paperId, questionIds });
  }

  async getPaperQuestions(paperId: string): Promise<PaperQuestionRef[]> {
    return this.bridge.getPaperQuestions({ paperId });
  }

  async setQuestionScore(paperId: string, questionId: string, score: number | undefined): Promise<void> {
    return this.bridge.setQuestionScore({ paperId, questionId, score });
  }
}
