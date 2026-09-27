// 0024 P3（D-049 / P-12）：学段-学科共享状态模块——通知语义 + 多消费者一致性 + 挂载生命周期等同改造前 useState
// 「行为零变化」的钉死点：最后一个消费者卸载即复位（等价于旧的组件内 useState 生命周期：
// 离开题库页再回来仍是默认筛选），既避免跨页残留，也避免用例互染。

// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import {
  acquireStageSubject, getStageSubject, setStageSubject, subscribeStageSubject,
  INITIAL_STAGE_SUBJECT,
} from '../../src/app/state/stage-subject.js';
import { useStageSubject } from '../../src/app/state/use-stage-subject.js';

function Probe({ id }: { id: string }) {
  const { stage, subjectId, setStage, setSubjectId } = useStageSubject();
  return (
    <div data-testid={`probe-${id}`} data-stage={stage} data-subject={subjectId}>
      <button data-testid={`set-stage-${id}`} onClick={() => setStage('高中')}>学段</button>
      <button data-testid={`set-subject-${id}`} onClick={() => setSubjectId('subj:physics')}>学科</button>
    </div>
  );
}

let container: HTMLDivElement;
let root: Root | null = null;

function render(ui: ReactElement) {
  root?.unmount();
  container?.remove();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => { root!.render(ui); });
}

beforeEach(() => {
  expect(getStageSubject()).toEqual(INITIAL_STAGE_SUBJECT); // 用例起点恒为默认态（无跨用例残留）
});

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
});

describe('0024 P3 学段-学科共享状态模块', () => {
  it('set → 订阅者收到通知且读到新值；同值 set 不通知（引用稳定，供 useSyncExternalStore）', () => {
    const release = acquireStageSubject();
    const seen: string[] = [];
    const un = subscribeStageSubject(() => seen.push(getStageSubject().stage));

    setStageSubject({ stage: '初中' });
    expect(getStageSubject().stage).toBe('初中');
    expect(seen).toEqual(['初中']);

    const before = getStageSubject();
    setStageSubject({ stage: '初中' }); // 同值
    expect(seen).toEqual(['初中']);
    expect(getStageSubject()).toBe(before); // 引用不变

    setStageSubject({ subjectId: 'subj:physics' });
    expect(getStageSubject()).toEqual({ stage: '初中', subjectId: 'subj:physics' });
    expect(seen).toHaveLength(2);

    un();
    setStageSubject({ stage: '高中' });
    expect(seen).toHaveLength(2); // 退订后不再收到

    release();
  });

  it('多消费者一致性：全部订阅者同一快照，退订互不影响', () => {
    const release = acquireStageSubject();
    const a: string[] = [];
    const b: string[] = [];
    const unA = subscribeStageSubject(() => a.push(`${getStageSubject().stage}/${getStageSubject().subjectId}`));
    const unB = subscribeStageSubject(() => b.push(`${getStageSubject().stage}/${getStageSubject().subjectId}`));

    setStageSubject({ stage: '初中', subjectId: 'subj:physics' });
    expect(a).toEqual(['初中/subj:physics']);
    expect(b).toEqual(['初中/subj:physics']);

    unA();
    setStageSubject({ stage: '高中' });
    expect(a).toHaveLength(1);
    expect(b).toEqual(['初中/subj:physics', '高中/subj:physics']);

    unB();
    release();
  });

  it('挂载生命周期：最后一个持有者释放即复位（等价改造前 useState，跨页/跨用例零残留）', () => {
    const r1 = acquireStageSubject();
    const r2 = acquireStageSubject();
    setStageSubject({ stage: '初中', subjectId: 'subj:physics' });

    r1();
    expect(getStageSubject()).toEqual({ stage: '初中', subjectId: 'subj:physics' }); // 仍有持有者

    r2();
    expect(getStageSubject()).toEqual(INITIAL_STAGE_SUBJECT); // 最后持有者释放 → 复位
  });

  it('React 侧：两组件同源单状态，改一处另一处同步；全部卸载后重挂载回默认', () => {
    render(<><Probe id="left" /><Probe id="right" /></>);
    expect(container.querySelector('[data-testid="probe-left"]')!.getAttribute('data-stage')).toBe('');
    expect(container.querySelector('[data-testid="probe-right"]')!.getAttribute('data-subject')).toBe('');

    flushSync(() => { (container.querySelector('[data-testid="set-stage-left"]') as HTMLButtonElement).click(); });
    expect(container.querySelector('[data-testid="probe-right"]')!.getAttribute('data-stage')).toBe('高中');

    flushSync(() => { (container.querySelector('[data-testid="set-subject-right"]') as HTMLButtonElement).click(); });
    expect(container.querySelector('[data-testid="probe-left"]')!.getAttribute('data-subject')).toBe('subj:physics');

    const state = getStageSubject();
    expect(state).toEqual({ stage: '高中', subjectId: 'subj:physics' });

    // 卸载一个消费者：状态保留（另一个仍在读）；全部卸载：复位
    render(<Probe id="solo" />);
    expect(getStageSubject()).toEqual(INITIAL_STAGE_SUBJECT);
    expect(container.querySelector('[data-testid="probe-solo"]')!.getAttribute('data-stage')).toBe('');

    void vi;
  });
});
