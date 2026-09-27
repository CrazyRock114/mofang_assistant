// 0053：设置页 initialView 入参——#/settings?view=ai 深链直达 AI 视图（录题页「去配置」落点）。
// 只增可选 prop：缺省仍落主视图（现状回归）；routing 命中由 app-routing.test.tsx 护栏覆盖。
// @vitest-environment jsdom

import { describe, it, expect, afterEach } from 'vitest';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import { SettingsPage } from '../../src/app/pages/SettingsPage.js';
import type { MofangAiBridge } from '../../src/shared/contracts/bridge.js';

let container: HTMLDivElement;
let root: Root | null = null;

function render(ui: ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => root!.render(ui));
}

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
});

/** 最小 ai 桥（挂载只读 profile.list；其余不用） */
function makeAi(): MofangAiBridge {
  return {
    profile: {
      list: async () => [],
      create: async () => { throw new Error('unused'); },
      update: async () => { throw new Error('unused'); },
      delete: async () => undefined,
      setEnabled: async () => { throw new Error('unused'); },
      testConnection: async () => ({ ok: false, latencyMs: null, error: 'unused' }),
    },
    invoke: async () => { throw new Error('unused'); },
    models: { list: async () => ({ models: [] }) },
    suggest: {
      anchorStatus: async () => { throw new Error('unused'); },
      treeLink: async () => { throw new Error('unused'); },
      tags: async () => { throw new Error('unused'); },
      treeForDraft: async () => ({ status: 'unavailable', reason: 'no profile' }),
    },
  } as unknown as MofangAiBridge;
}

describe('0053：设置页 initialView 入参（#/settings?view=ai 深链）', () => {
  it('initialView=ai 直达 AI 视图（settings-ai-detail 在场，无需再点 AI 卡）', () => {
    render(<SettingsPage ai={makeAi()} initialView="ai" />);
    expect(container.querySelector('[data-testid="settings-ai-detail"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="settings-ai-back"]')).not.toBeNull();
  });

  it('缺省 initialView 仍落主视图（现状回归：AI 入口卡在场、详情不在）', () => {
    render(<SettingsPage ai={makeAi()} />);
    expect(container.querySelector('[data-testid="settings-ai-detail"]')).toBeNull();
    expect(container.querySelector('[data-testid="settings-ai-open"]')).not.toBeNull();
  });
});
