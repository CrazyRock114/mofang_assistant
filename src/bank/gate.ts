// Phase 2: 来源门禁 — NULL source 不可入库（产品红线）

import type { Question } from '../shared/contracts/bank-types.js';

export class SourceGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceGateError';
  }
}

/**
 * 来源门禁：createQuestion/updateQuestion 必须通过此函数验证
 * 拒绝 sourceType 缺失或 sourceDetail 为空/非法 JSON 的输入
 */
export function validateSource(data: Partial<Pick<Question, 'sourceType' | 'sourceDetail'>>): void {
  // 拒绝 sourceType 缺失
  if (!data.sourceType) {
    throw new SourceGateError('sourceType is required and cannot be null or empty');
  }

  // 拒绝 sourceDetail 缺失
  if (!data.sourceDetail) {
    throw new SourceGateError('sourceDetail is required and cannot be null or empty');
  }

  // 拒绝 sourceDetail 为空对象
  if (typeof data.sourceDetail === 'object' && Object.keys(data.sourceDetail).length === 0) {
    throw new SourceGateError('sourceDetail cannot be an empty object');
  }
}
