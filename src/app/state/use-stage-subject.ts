// 0024 P3：共享状态 React 消费口——订阅 + 挂载期持有（卸载释放，见 stage-subject.ts 生命周期说明）
// 与 0023 的 ai.* 代理无耦合：本 hook 只解决「学段-学科唯一真源」，不做任何 IO。

import { useEffect, useSyncExternalStore } from 'react';
import {
  acquireStageSubject, getStageSubject, setStageSubject, subscribeStageSubject,
  type StageSubjectState,
} from './stage-subject.js';

export interface StageSubjectControls extends StageSubjectState {
  setStage: (stage: string) => void;
  setSubjectId: (subjectId: string) => void;
}

export function useStageSubject(): StageSubjectControls {
  const state = useSyncExternalStore(subscribeStageSubject, getStageSubject);
  useEffect(() => acquireStageSubject(), []);
  return {
    stage: state.stage,
    subjectId: state.subjectId,
    setStage: (stage) => setStageSubject({ stage }),
    setSubjectId: (subjectId) => setStageSubject({ subjectId }),
  };
}
