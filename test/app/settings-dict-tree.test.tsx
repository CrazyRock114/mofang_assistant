// 0016 P2/P3：设置页「字典映射」「树映射」块 — jsdom + Mock (in-memory) 单跑
// 目检返工 1：映射条目收进入口卡——设置页仅一张「字典 / 树映射」入口卡（概要统计），点击进入详情视图（页内态，零新路由）
// 目检返工 2：树映射降级节点级——点树 → 节点列表（1 次 getNodes）；点节点 → 该节点映射（1 次 getSourceMappings），消除原 1+N 聚合卡顿
// - 字典块：kind 分区只读查看 + 未知行高亮 + 指认交互（updateEntry(id,{code,active:true})）
// - IpcExtClient 补线：dict.updateEntry / tree.getSourceMappings 走桥调用（不再 unwired 抛错）
// 环境约束同 ext-pages.test.tsx：jsdom worker 禁 node: 导入。
// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi } from 'vitest';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import type { BankExtServices } from '../../src/shared/contracts/bank-types.js';
import { createMockExtServices } from '../../src/bank/mock/mock-ext.js';
import { MockBankStore } from '../../src/bank/mock/mock-store.js';
import { IpcExtClient } from '../../src/app/services/IpcExtClient.js';

import { SettingsPage } from '../../src/app/pages/SettingsPage.js';

// ---------------- 测试世界（Mock in-memory） ----------------

function createExt(): BankExtServices {
  return createMockExtServices(new MockBankStore());
}

// ---------------- 渲染/交互辅助（照 ext-pages 测试模式） ----------------

let container: HTMLDivElement;
let root: Root | null = null;

function render(ui: ReactElement) {
  root?.unmount();
  container?.remove();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => {
    root!.render(ui);
  });
}

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
});

function q(selector: string): Element | null {
  return container.querySelector(selector);
}

function all(selector: string): Element[] {
  return [...container.querySelectorAll(selector)];
}

async function waitFor(assertion: () => void) {
  await vi.waitFor(assertion, { timeout: 3000, interval: 20 });
}

/** 目检返工 1：经入口卡进入映射详情视图（真实用户路径） */
async function openMappingDetail() {
  await waitFor(() => {
    expect(q('[data-testid="settings-mapping-open"]')).not.toBeNull();
  });
  flushSync(() => (q('[data-testid="settings-mapping-open"]') as HTMLButtonElement).click());
  await waitFor(() => {
    expect(q('[data-testid="settings-mapping-detail"]')).not.toBeNull();
  });
}

/** React 受控下拉：change 事件 */
function setSelect(selector: string, value: string) {
  const el = q(selector);
  if (!el) throw new Error(`找不到下拉框: ${selector}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  setter.call(el as HTMLSelectElement, value);
  (el as HTMLSelectElement).dispatchEvent(new Event('change', { bubbles: true }));
}

/** 播种：subject 归一行×2 + 已指认站点行 + 未知站点行 + difficulty 归一行 + 无归一 kind 的未知行 */
async function seedDict(ext: BankExtServices) {
  await ext.dict.createEntry({ kind: 'subject', code: 'physics', label: '物理' });
  await ext.dict.createEntry({ kind: 'subject', code: 'math', label: '数学' });
  await ext.dict.createEntry({ kind: 'subject', code: 'physics', label: 'physics2', site: 'jyeoo', sourceLabel: 'physics2' });
  await ext.dict.createEntry({ kind: 'subject', code: '', label: '玄学', site: 'jyeoo', sourceLabel: 'xuanxue0', active: false });
  await ext.dict.createEntry({ kind: 'difficulty', code: 'easy', label: '容易' });
  // question_type 无归一行 → 其未知行下拉应「（待采集）」禁用
  await ext.dict.createEntry({ kind: 'question_type', code: '', label: '怪题', site: 'zujuan', sourceLabel: '怪题', active: false });
}

// ==================== P1：IpcExtClient 补线 ====================

describe('0016 P1：IpcExtClient dict.updateEntry / tree.getSourceMappings 补线', () => {
  it('走桥调用（不再 unwired 抛错）：入参按桥 payload 形态透传', async () => {
    const update = vi.fn(async () => ({}));
    const getSourceMappings = vi.fn(async () => []);
    (window as any).__mofangBankExt = {
      dict: { update },
      tree: { getSourceMappings },
    };
    try {
      const client = new IpcExtClient();
      await client.dict.updateEntry('subj:jyeoo:xuanxue0', { code: 'physics', active: true });
      expect(update).toHaveBeenCalledWith({ id: 'subj:jyeoo:xuanxue0', data: { code: 'physics', active: true } });

      await client.tree.getSourceMappings('node-1');
      expect(getSourceMappings).toHaveBeenCalledWith({ nodeId: 'node-1' });
    } finally {
      delete (window as any).__mofangBankExt;
    }
  });
});

// ==================== 返工 1：入口卡 ====================

describe('0016 返工 1：映射入口卡（设置页只留入口，条目进详情）', () => {
  it('入口卡概要统计：字典 N 行 · 未知值 M · 树 K 棵；点击进入详情，详情含返回', async () => {
    const ext = createExt();
    await seedDict(ext);
    await ext.tree.createTree({ type: 'knowledge', name: '组卷网·初中物理知识点', source: 'zujuan' });
    render(<SettingsPage ext={ext} />);

    // 概要（2 次轻查询：listEntries + listTrees，不预取节点计数）
    await waitFor(() => {
      const entry = q('[data-testid="settings-mapping-entry"]')!;
      expect(entry).not.toBeNull();
      expect(entry.textContent).toContain('字典 6 行');
      expect(entry.textContent).toContain('未知值 2');
      expect(entry.textContent).toContain('树 1 棵');
    });
    // 主视图不直接渲染映射条目
    expect(q('[data-testid="settings-dict-card"]')).toBeNull();
    expect(q('[data-testid="settings-tree-card"]')).toBeNull();

    // 点击进入详情 → 字典/树两块出现；返回按钮存在
    await openMappingDetail();
    expect(q('[data-testid="settings-dict-card"]')).not.toBeNull();
    expect(q('[data-testid="settings-tree-card"]')).not.toBeNull();
    expect(q('[data-testid="settings-mapping-back"]')).not.toBeNull();

    // 返回主视图：详情消失、入口卡回归
    flushSync(() => (q('[data-testid="settings-mapping-back"]') as HTMLButtonElement).click());
    expect(q('[data-testid="settings-mapping-detail"]')).toBeNull();
    expect(q('[data-testid="settings-mapping-entry"]')).not.toBeNull();
  });
});

// ==================== P2：字典映射块 ====================

describe('0016 P2：设置页「字典映射」块', () => {
  it('分区渲染：三 kind 分区；归一行列 code+label；站点行挂归一行下（site·sourceLabel→code）；未指认显示「未指认」', async () => {
    const ext = createExt();
    await seedDict(ext);
    render(<SettingsPage ext={ext} />);
    await openMappingDetail();

    await waitFor(() => {
      expect(q('[data-testid="settings-dict-card"]')).not.toBeNull();
      expect(all('[data-testid="settings-dict-kind"]').length).toBe(3);
    });

    const kinds = all('[data-testid="settings-dict-kind"]');
    expect(kinds.map((k) => k.getAttribute('data-kind'))).toEqual(['subject', 'question_type', 'difficulty']);

    // 归一行：code+label（listEntries 组内按 code 升序：math 在前）
    const subjectKind = kinds[0];
    const norms = [...subjectKind.querySelectorAll('[data-testid="settings-dict-norm"]')];
    expect(norms.length).toBe(2);
    const physicsNorm = norms.find((n) => n.textContent!.includes('physics'))!;
    expect(physicsNorm.textContent).toContain('物理');

    // 站点行挂归一行下：site · sourceLabel → code
    const sites = [...subjectKind.querySelectorAll('[data-testid="settings-dict-site"]')];
    expect(physicsNorm.textContent).toContain('jyeoo');
    expect(sites.some((s) => s.textContent!.includes('physics2') && s.textContent!.includes('physics'))).toBe(true);

    // 未指认：未知行显示「未指认」
    const unknown = subjectKind.querySelector('[data-testid="settings-dict-unknown"]')!;
    expect(unknown.textContent).toContain('未指认');
    expect(unknown.textContent).toContain('xuanxue0');
  });

  it('未知行高亮（data-unknown）+ 指认下拉（选项=同 kind 归一行；无归一 kind 禁用「（待采集）」）', async () => {
    const ext = createExt();
    await seedDict(ext);
    render(<SettingsPage ext={ext} />);
    await openMappingDetail();

    await waitFor(() => {
      expect(all('[data-testid="settings-dict-unknown"]').length).toBe(2);
    });

    // 未知行带 data-unknown 标记（高亮视觉由 --brick 变量内联实现）
    const unknowns = all('[data-testid="settings-dict-unknown"]');
    expect(unknowns.every((u) => u.getAttribute('data-unknown') === 'true')).toBe(true);

    // subject 未知行：下拉选项 = 同 kind 归一行（physics/math），非空可选
    const subjectSelect = unknowns[0].querySelector('[data-testid="settings-dict-assign-select"]') as HTMLSelectElement;
    const subjectOptions = [...subjectSelect.options].map((o) => o.value);
    expect(subjectOptions).toContain('physics');
    expect(subjectOptions).toContain('math');
    expect(subjectOptions).not.toContain('easy');

    // question_type 未知行：无归一行 → 禁用 +「（待采集）」
    const qtypeSelect = unknowns[1].querySelector('[data-testid="settings-dict-assign-select"]') as HTMLSelectElement;
    expect(qtypeSelect.disabled).toBe(true);
    expect(qtypeSelect.textContent).toContain('（待采集）');
  });

  it('指认流：选归一 code 点「指认」→ updateEntry 以 {code, active:true} 被调 → 行刷新为已指认（不整页重载）', async () => {
    const ext = createExt();
    await seedDict(ext);
    const updateSpy = vi.spyOn(ext.dict, 'updateEntry');
    render(<SettingsPage ext={ext} />);
    await openMappingDetail();

    await waitFor(() => {
      expect(all('[data-testid="settings-dict-unknown"]').length).toBe(2);
    });

    const unknownRow = all('[data-testid="settings-dict-unknown"]')[0];
    setSelect('[data-testid="settings-dict-assign-select"]', 'physics');
    const assignBtn = unknownRow.querySelector('[data-testid="settings-dict-assign-btn"]') as HTMLButtonElement;
    flushSync(() => assignBtn.click());

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith(unknownRow.getAttribute('data-id'), { code: 'physics', active: true });
      // 行刷新：subject 未知行消失（该行变为已指认站点行）
      const subjectUnknowns = all('[data-testid="settings-dict-kind"]')[0]
        .querySelectorAll('[data-testid="settings-dict-unknown"]');
      expect(subjectUnknowns.length).toBe(0);
    });
    // 已指认行出现在归一行 physics 组下
    const norms = all('[data-testid="settings-dict-kind"]')[0].querySelectorAll('[data-testid="settings-dict-norm"]');
    const physicsNorm = [...norms].find((n) => n.textContent!.includes('physics'))!;
    expect(physicsNorm.textContent).toContain('xuanxue0');
  });

  it('指认失败：updateEntry 抛错 → 错误文本原样展示（不静默吞）', async () => {
    const ext = createExt();
    await seedDict(ext);
    vi.spyOn(ext.dict, 'updateEntry').mockRejectedValueOnce(new Error('未知归一码 "physics"（kind=subject 无此归一行；指认须指向同 kind 已建归一行）'));
    render(<SettingsPage ext={ext} />);
    await openMappingDetail();

    await waitFor(() => {
      expect(all('[data-testid="settings-dict-unknown"]').length).toBe(2);
    });

    setSelect('[data-testid="settings-dict-assign-select"]', 'physics');
    const assignBtn = all('[data-testid="settings-dict-unknown"]')[0]
      .querySelector('[data-testid="settings-dict-assign-btn"]') as HTMLButtonElement;
    flushSync(() => assignBtn.click());

    await waitFor(() => {
      const err = q('[data-testid="settings-dict-error"]');
      expect(err).not.toBeNull();
      expect(err!.textContent).toContain('未知归一码');
    });
  });

  it('负例：归一行无指认入口；无未知行时无指认按钮', async () => {
    const ext = createExt();
    await ext.dict.createEntry({ kind: 'subject', code: 'physics', label: '物理' });
    await ext.dict.createEntry({ kind: 'subject', code: 'physics', label: 'physics2', site: 'jyeoo', sourceLabel: 'physics2' });
    render(<SettingsPage ext={ext} />);
    await openMappingDetail();

    await waitFor(() => {
      expect(all('[data-testid="settings-dict-norm"]').length).toBe(1);
    });
    expect(q('[data-testid="settings-dict-unknown"]')).toBeNull();
    expect(q('[data-testid="settings-dict-assign-btn"]')).toBeNull();
    expect(q('[data-testid="settings-dict-assign-select"]')).toBeNull();
  });
});

// ==================== P3：树映射块（目检返工 2：节点级浏览，零 1+N 聚合） ====================

describe('0016 P3：设置页「树映射」块（只读、节点级）', () => {
  it('树列表：类型/学科（归一展示）/名称/站点；点树 → 节点层级列表（1 次查询）；点节点 → 该节点站点映射（1 次查询）', async () => {
    const ext = createExt();
    await ext.dict.createEntry({ kind: 'subject', code: 'physics', label: '物理' });
    const tree = await ext.tree.createTree({ type: 'knowledge', name: '组卷网·初中物理知识点', subjectId: 'subj:physics', source: 'zujuan' });
    const root = await ext.tree.createNode({ treeId: tree.id, name: '物理', sourceMapping: { site: 'zujuan', siteNodeId: 'n0', siteNodeName: '物理root' } });
    const child = await ext.tree.createNode({ treeId: tree.id, parentId: root.id, name: '力学', sourceMapping: { site: 'zujuan', siteNodeId: 'n1', siteNodeName: '力学基础' } });
    await ext.tree.createNode({ treeId: tree.id, parentId: child.id, name: '压强' });
    render(<SettingsPage ext={ext} />);
    await openMappingDetail();

    await waitFor(() => {
      expect(all('[data-testid="settings-tree-row"]').length).toBe(1);
    });

    const row = all('[data-testid="settings-tree-row"]')[0];
    expect(row.textContent).toContain('知识点');
    expect(row.textContent).toContain('物理');
    expect(row.textContent).toContain('组卷网·初中物理知识点');
    expect(row.textContent).toContain('zujuan');

    // 点树 → 节点层级列表出现（3 节点；缩进 = 深度）
    flushSync(() => (row as HTMLButtonElement).click());
    await waitFor(() => {
      expect(all('[data-testid="settings-tree-node"]').length).toBe(3);
    });
    const nodes = all('[data-testid="settings-tree-node"]');
    expect(nodes.map((n) => n.getAttribute('data-name'))).toEqual(['物理', '力学', '压强']);
    expect(nodes.map((n) => n.getAttribute('data-depth'))).toEqual(['0', '1', '2']);

    // 点有映射的节点 → 该节点映射条目（1 次 getSourceMappings）
    flushSync(() => (nodes[1] as HTMLButtonElement).click());
    await waitFor(() => {
      expect(all('[data-testid="settings-tree-mapping"]').length).toBe(1);
    });
    const mapping = all('[data-testid="settings-tree-mapping"]')[0];
    expect(mapping.textContent).toContain('zujuan');
    expect(mapping.textContent).toContain('n1');
    expect(mapping.textContent).toContain('力学基础');
  });

  it('空库占位：无树时显示「（暂无树数据，先运行采集）」不渲染假数据', async () => {
    const ext = createExt();
    render(<SettingsPage ext={ext} />);
    await openMappingDetail();

    await waitFor(() => {
      expect(q('[data-testid="settings-tree-empty"]')).not.toBeNull();
    });
    expect(q('[data-testid="settings-tree-empty"]')!.textContent).toContain('（暂无树数据，先运行采集）');
    expect(q('[data-testid="settings-tree-row"]')).toBeNull();
  });

  it('点无映射节点 → 显示（该节点暂无站点映射）', async () => {
    const ext = createExt();
    const tree = await ext.tree.createTree({ type: 'textbook', name: '人教版物理教材章节', subjectId: 'subj:physics' });
    await ext.tree.createNode({ treeId: tree.id, name: '第一章' });
    render(<SettingsPage ext={ext} />);
    await openMappingDetail();

    await waitFor(() => {
      expect(all('[data-testid="settings-tree-row"]').length).toBe(1);
    });
    flushSync(() => (all('[data-testid="settings-tree-row"]')[0] as HTMLButtonElement).click());
    await waitFor(() => {
      expect(all('[data-testid="settings-tree-node"]').length).toBe(1);
    });
    flushSync(() => (all('[data-testid="settings-tree-node"]')[0] as HTMLButtonElement).click());
    await waitFor(() => {
      expect(q('[data-testid="settings-tree-node-empty"]')).not.toBeNull();
    });
    expect(q('[data-testid="settings-tree-node-empty"]')!.textContent).toContain('（该节点暂无站点映射）');
  });
});
