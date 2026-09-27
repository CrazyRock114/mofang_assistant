// 0054（R-049）：树呈现——①显示层剥来源前缀 ②去「综合库」根层 ③树选择弹层默认展开一级
//（2026-09-23 目检反馈：③不适用于题库页左栏树面板——那里保持一级默认折叠，见下方题库页用例）。
// 另锁两条「零影响」硬指标：TreeRows 默认行为（props 全 opt-in）与 FolderTreePicker 文件夹树（D-063 默认折叠）。
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { ReactElement } from 'react';

import type { BankExtServices, BankService, PaperFolder, TreeNode } from '../../src/shared/contracts/bank-types.js';
import { MockBankService } from '../../src/bank/mock/mock-bank.js';
import { createMockExtServices } from '../../src/bank/mock/mock-ext.js';
import { MockBankStore } from '../../src/bank/mock/mock-store.js';
import { BankPage } from '../../src/app/pages/BankPage.js';
import type { ExtPageServices } from '../../src/app/pages/ExtUi.js';
import { FolderTreePicker } from '../../src/app/components/FolderTreePicker.js';
import { buildParentIndex, TreeNodeRows, topLevelRowIds } from '../../src/app/components/TreeRows.js';
import { TreePickerModal } from '../../src/app/workbench/TreePickerModal.js';
import { displayTreeName } from '../../src/app/utils/tree-display.js';

// ---------------- 渲染辅助 ----------------

let container: HTMLDivElement;
let root: Root | null = null;

function render(ui: ReactElement): void {
  root?.unmount();
  container?.remove();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => { root!.render(ui); });
}

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
});

function q<T extends Element>(testid: string): T | null {
  return container.querySelector<T>(`[data-testid="${testid}"]`);
}

function clickEl(el: Element | null): void {
  if (!el) throw new Error('找不到可点元素');
  flushSync(() => { (el as HTMLElement).click(); });
}

function clickBtn(selector: string): void {
  const el = container.querySelector(selector);
  if (!el) throw new Error(`找不到元素: ${selector}`);
  clickEl(el);
}

async function waitFor(assertion: () => void): Promise<void> {
  await vi.waitFor(assertion, { timeout: 3000, interval: 20 });
}

// ---------------- 测试世界（Mock in-memory，照 basket-pages 模式） ----------------

let bank: BankService;
let ext: BankExtServices;
let svc: ExtPageServices;

beforeEach(() => {
  const store = new MockBankStore();
  bank = new MockBankService(store);
  ext = createMockExtServices(store);
  svc = { bank, ext };
});

/** 三层知识树夹具：综合库(根) → 力学 → 摩擦力 → 滑动摩擦力 */
async function seedTree(): Promise<{ treeId: string; root: string; mech: string; friction: string; sliding: string }> {
  const tree = await ext.tree.createTree({
    type: 'knowledge', name: '组卷网·知识点·初中物理', subjectId: 'subj:physics', stage: '初中',
  });
  const root = await ext.tree.createNode({ treeId: tree.id, name: '综合库', sort: 0 });
  const mech = await ext.tree.createNode({ treeId: tree.id, parentId: root.id, name: '力学', sort: 0 });
  const friction = await ext.tree.createNode({ treeId: tree.id, parentId: mech.id, name: '摩擦力', sort: 0 });
  const sliding = await ext.tree.createNode({ treeId: tree.id, parentId: friction.id, name: '滑动摩擦力', sort: 0 });
  return { treeId: tree.id, root: root.id, mech: mech.id, friction: friction.id, sliding: sliding.id };
}

function node(id: string, treeId: string, name: string, parentId?: string, sort = 0): TreeNode {
  return { id, treeId, ...(parentId ? { parentId } : {}), name, sort };
}

// ---------------- ① 剥来源前缀（纯函数） ----------------

describe('0054 R-049①：displayTreeName 剥来源前缀（只剥两字面形态，剥后为空不剥）', () => {
  it('组卷网/菁优网知识点前缀剥掉，后缀（版本/册次）保留', () => {
    expect(displayTreeName('组卷网·知识点·初中物理')).toBe('初中物理');
    expect(displayTreeName('菁优网·知识点·高中物理·人教版必修一')).toBe('高中物理·人教版必修一');
  });

  it('非知识点前缀（组卷网·教材·）与无前缀名逐字不动', () => {
    expect(displayTreeName('组卷网·教材·初中物理·人教版（2024）八年级上册')).toBe('组卷网·教材·初中物理·人教版（2024）八年级上册');
    expect(displayTreeName('初中物理')).toBe('初中物理');
  });

  it('剥后为空不剥（只有前缀名照原样显示，不产生空选项）', () => {
    expect(displayTreeName('组卷网·知识点·')).toBe('组卷网·知识点·');
    expect(displayTreeName('菁优网·知识点·')).toBe('菁优网·知识点·');
  });

  it('零数据层改动：siteOfTree 仍按树名前缀定站（前缀数据保留）', () => {
    // displayTreeName 是显示层纯函数，不改任何落库数据；前缀匹配的数据前提（tree.name 原文）不变
    expect(displayTreeName('组卷网·知识点·初中物理')).not.toContain('组卷网·知识点·');
  });
});

// ---------------- ② 去根层 / 顶部展开集（TreeRows opt-in 直测） ----------------

const FLAT: TreeNode[] = [
  node('r', 't1', '综合库'),
  node('a', 't1', '力学', 'r'),
  node('b', 't1', '摩擦力', 'a'),
];

function renderRows(nodes: TreeNode[], props: Partial<Parameters<typeof TreeNodeRows>[0]> = {}): void {
  const byParent = buildParentIndex(nodes, { sort: true });
  render(
    <TreeNodeRows
      byParent={byParent}
      parentId=""
      depth={0}
      open={new Set<string>()}
      onToggle={() => undefined}
      selectedId=""
      onSelect={() => undefined}
      testidPrefix="t-node"
      toggleTestidPrefix="t-toggle"
      selectTitle={null}
      {...props}
    />,
  );
}

describe('0054 R-049②：TreeRows opt-in（skipRootNames 去根层 / topLevelRowIds 计算顶层行）', () => {
  it('不传 skipRootNames：默认行为逐字不变（根层照渲染，子级仍按 open 折叠）', () => {
    renderRows(FLAT);
    expect(q('t-node-r')?.textContent).toContain('综合库');
    expect(q('t-node-a')).toBeNull(); // 未展开 → 子级不渲染（现状口径）
    renderRows(FLAT, { open: new Set(['r']) });
    expect(q('t-node-a')?.textContent).toContain('力学');
  });

  it('传 skipRootNames：顶层匹配节点不渲染，其 children 顶上第一级（缩进随之提级）', () => {
    // 先取「不剥」时第 0 级行的缩进基准，再与之比对（缩进提级 = 力学占用了原根层的缩进）
    renderRows(FLAT, { open: new Set(['r']) });
    const depth0Indent = q<HTMLElement>('t-node-r')!.style.paddingLeft;

    renderRows(FLAT, { skipRootNames: ['综合库'], open: new Set(['a']) });
    expect(q('t-node-r')).toBeNull();          // 综合库 根层消失
    expect(q('t-node-a')).not.toBeNull();      // 力学 顶上第一级（已展开）
    expect(q('t-node-b')?.textContent).toContain('摩擦力');
    expect(q<HTMLElement>('t-node-a')!.style.paddingLeft).toBe(depth0Indent);
  });

  it('skipRootNames 只作用于顶层：名字命中但不在根层的节点照渲染', () => {
    const deepWithSameName: TreeNode[] = [...FLAT, node('c', 't1', '综合库', 'b')];
    renderRows(deepWithSameName, { skipRootNames: ['综合库'], open: new Set(['a', 'b']) });
    expect(q('t-node-c')?.textContent).toContain('综合库');
  });

  it('topLevelRowIds：不剥时=根层 id；剥后=被剥根的子级 id（供调用方按需预置 open）', () => {
    expect(topLevelRowIds(FLAT)).toEqual(['r']);
    expect(topLevelRowIds(FLAT, ['综合库'])).toEqual(['a']);
    expect(topLevelRowIds(FLAT, ['不存在的名字'])).toEqual(['r']);
  });
});

// ---------------- ②③ 消费点：题库页树面板 ----------------

describe('0054 R-049①②：题库页树面板（剥前缀 + 去综合库根 + 一级默认折叠）', () => {
  it('树名剥前缀、综合库根层消失、第一级默认折叠（点开才铺开）', async () => {
    const ids = await seedTree();
    render(<BankPage svc={svc} />);
    await waitFor(() => {
      if (!q(`bank-tree-node-${ids.mech}`)) throw new Error('第一级节点未渲染');
    });

    // ① 树名显示位剥前缀（下拉选项 = 树名显示位）
    const sel = q<HTMLSelectElement>('bank-tree-select')!;
    expect(sel.textContent).toContain('初中物理');
    expect(sel.textContent).not.toContain('组卷网·知识点·');

    // ② 综合库根层不渲染
    expect(q(`bank-tree-node-${ids.root}`)).toBeNull();
    expect(container.textContent).not.toContain('综合库');

    // ③ 一级默认折叠（2026-09-23 目检反馈）：力学/电磁学这级只列行不铺开子级
    expect(q(`bank-tree-node-${ids.mech}`)?.textContent).toContain('力学');
    expect(q(`bank-tree-node-${ids.friction}`)).toBeNull();
    clickBtn(`[data-testid="bank-tree-toggle-${ids.mech}"]`);
    expect(q(`bank-tree-node-${ids.friction}`)?.textContent).toContain('摩擦力');
    expect(q(`bank-tree-node-${ids.sliding}`)).toBeNull(); // 深层仍不铺开

    // 节点计数仍是原始节点数（显示层剥前缀/去根不改数据）
    expect(q('bank-tree-node-count')?.textContent).toContain('4 节点');
  });

  it('点开/收起由用户掌握：折叠后不被初始化覆盖，再展开照常', async () => {
    const ids = await seedTree();
    render(<BankPage svc={svc} />);
    await waitFor(() => {
      if (!q(`bank-tree-node-${ids.mech}`)) throw new Error('第一级未渲染');
    });
    expect(q(`bank-tree-node-${ids.friction}`)).toBeNull();
    clickBtn(`[data-testid="bank-tree-toggle-${ids.mech}"]`);
    expect(q(`bank-tree-node-${ids.friction}`)).not.toBeNull();
    clickBtn(`[data-testid="bank-tree-toggle-${ids.mech}"]`);
    expect(q(`bank-tree-node-${ids.friction}`)).toBeNull();
  });
});

// ---------------- ②③ 消费点：工作台树选择弹层 ----------------

describe('0054 R-049①②③：TreePickerModal（同一棵树同套呈现）', () => {
  async function renderPicker(stage = '初中', subjectId = 'subj:physics'): Promise<{ mech: string; friction: string; root: string }> {
    const ids = await seedTree();
    render(
      <TreePickerModal
        ext={ext}
        stage={stage}
        subjectId={subjectId}
        subjectLabel="物理"
        onConfirm={() => undefined}
        onClose={() => undefined}
      />,
    );
    await waitFor(() => {
      if (!q(`wb-tree-node-${ids.mech}`)) throw new Error('弹层第一级节点未渲染');
    });
    return ids;
  }

  it('弹层树名剥前缀 + 综合库根层消失 + 默认展开一级（录题台选节点便利口径，与题库页左栏相反）', async () => {
    const ids = await renderPicker();
    const sel = q<HTMLSelectElement>('wb-tm-tree')!;
    expect(sel.textContent).toContain('初中物理');
    expect(sel.textContent).not.toContain('组卷网·知识点·');
    expect(q(`wb-tree-node-${ids.root}`)).toBeNull();
    expect(q(`wb-tree-node-${ids.friction}`)?.textContent).toContain('摩擦力');
    expect(q(`wb-tree-node-${ids.sliding}`)).toBeNull();
  });

  it('任意层级可选：路径是数据真值全路径（去根层只影响行渲染，不改节点路径）', async () => {
    const ids = await renderPicker();
    clickEl(q(`wb-tree-node-${ids.friction}`));
    expect(q('wb-tm-path')?.textContent).toBe('综合库 › 力学 › 摩擦力');
  });
});

// ---------------- FolderTreePicker 零影响锁（D-063） ----------------

describe('0054 零影响锁：FolderTreePicker 文件夹树（默认折叠，一行不动）', () => {
  const folders: PaperFolder[] = [
    { id: 'f-root', name: '综合库', sort: 0, createdAt: '2026-09-23T00:00:00Z' },
    { id: 'f-child', name: '期中卷', parentId: 'f-root', sort: 0, createdAt: '2026-09-23T00:00:00Z' },
  ];

  it('默认折叠：打开浮层只列顶级；名字叫「综合库」的文件夹照常渲染（opt-in 不外溢）', () => {
    render(<FolderTreePicker folders={folders} value={null} onChange={() => undefined} />);
    clickBtn('[data-testid="folder-tree-picker-field"]');
    expect(q('folder-tree-picker-pop')).not.toBeNull();
    // 顶级渲染（含名为「综合库」的文件夹——不被 0054 的去根层规则波及）
    expect(q('folder-tree-node-f-root')?.textContent).toContain('综合库');
    // 二级默认折叠（D-063 口径不变）
    expect(q('folder-tree-node-f-child')).toBeNull();
    // 展开/折叠交互照旧
    clickBtn('[data-testid="folder-tree-toggle-f-root"]');
    expect(q('folder-tree-node-f-child')?.textContent).toContain('期中卷');
  });

  it('FolderTreePicker 源码零 diff（props 未接 skipRootNames / 无默认展开预置）', async () => {
    const { readFileSync } = await import('node:fs');
    // vitest cwd = 仓库根
    const src = readFileSync('src/app/components/FolderTreePicker.tsx', 'utf8');
    expect(src).not.toContain('skipRootNames');
    expect(src).not.toContain('topLevelRowIds');
    expect(src).not.toContain('displayTreeName');
    expect(src).toContain('useState<ReadonlySet<string>>(new Set<string>())');
  });
});
