// 0002: 真实 bank 扩展服务组装（BankExtServices → SQLite 实现）
// 与 BankServiceImpl 并列使用（bridge.ts 本轮冻结，renderer 接线随 UI 里程碑）。

import type { BankExtServices } from '../shared/contracts/bank-types.js';
import type { Database } from './db.js';
import { DictServiceImpl } from './dict-service.js';
import { TreeServiceImpl } from './tree-service.js';
import { StudentServiceImpl, ClassServiceImpl } from './school-service.js';
import { ExamServiceImpl } from './exam-service.js';
import { MistakeServiceImpl } from './mistake-service.js';
import { PaperSetServiceImpl } from './paper-set-service.js';
import { PresetServiceImpl } from './preset-service.js';
import { FeedbackServiceImpl } from './feedback-service.js';
// 0030（只增）：AI 通道提示词模板 + 反馈记录落档（迁移 0010；0005 离线模板服务一字不动）
import { FeedbackPromptTemplateServiceImpl, FeedbackRecordServiceImpl } from './feedback-record-service.js';
import { PaperService } from './paper-service.js';

export function createExtServices(db: Database, paperService?: PaperService): BankExtServices {
  return {
    dict: new DictServiceImpl(db),
    tree: new TreeServiceImpl(db),
    student: new StudentServiceImpl(db),
    class: new ClassServiceImpl(db),
    exam: new ExamServiceImpl(db),
    mistake: new MistakeServiceImpl(db),
    paperSet: new PaperSetServiceImpl(db),
    preset: new PresetServiceImpl(db),
    // 0005（只增）：课后反馈模板 CRUD
    feedback: new FeedbackServiceImpl(db),
    // 0030（只增）：AI 通道提示词模板（内置只读）+ 反馈记录落档（双模式）
    feedbackPrompt: new FeedbackPromptTemplateServiceImpl(db),
    feedbackRecord: new FeedbackRecordServiceImpl(db),
    paper: paperService ?? new PaperService(db),
  };
}
