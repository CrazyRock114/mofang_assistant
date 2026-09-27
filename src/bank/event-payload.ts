// 0003: 时间线事件 payload 校验（独立模块——mock 服务在 renderer 侧复用，
// 不能沿 school-service 链把 db/node 模块拉进 renderer 编译图；school-service 原位 re-export 保持兼容）

import type { StudentEventType, StudentEventPayload } from '../shared/contracts/bank-types.js';

/** payload 与 eventType 匹配校验（service 层契约，不得错配入库） */
export function validateEventPayload(eventType: StudentEventType, payload: StudentEventPayload): void {
  if (payload.eventType !== eventType) {
    throw new Error(`Event payload type mismatch: expected "${eventType}", got "${payload.eventType}"`);
  }
  switch (eventType) {
    case 'exam_score':
      if (payload.eventType !== 'exam_score') return;
      if (payload.score !== undefined && typeof payload.score !== 'number') {
        throw new Error('exam_score payload.score must be a number');
      }
      return;
    case 'performance':
    case 'note':
      if ((payload.eventType === 'performance' || payload.eventType === 'note') && !payload.text) {
        throw new Error(`${eventType} payload.text is required`);
      }
      return;
    case 'photo_attach':
      if (payload.eventType === 'photo_attach' && !payload.assetId) {
        throw new Error('photo_attach payload.assetId is required');
      }
      return;
  }
}
