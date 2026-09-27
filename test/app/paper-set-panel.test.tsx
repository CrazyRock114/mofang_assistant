// 0026 P3：试卷集组卷侧暴露 — jsdom，Mock (in-memory) 单跑。
// 覆盖任务书 §一 P3：试卷集分组展示（统一/错题两类）+ 手动新建 + 加卷/移出/删集 +
// batch_meta 只读展示（P-06 一期只定字段）+ custom-mistake 每生一卷「只展示既有数据」（不生成）。
// @vitest-environment jsdom

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import { MockBankService } from '../../src/bank/mock/mock-bank.js';
import { createMockExtServices } from '../../src/bank/mock/mock-ext.js';
import { MockBankStore } from '../../src/bank/mock/mock-store.js';
import { PaperSetPanel } from '../../src/app/pages/PaperSetPanel.js';
import { PaperSections } from '../../src/app/pages/BasketListPage.js';
import { BasketListPage } from '../../src/app/pages/BasketListPage.js';
import type { ExtPageServices } from '../../src/app/pages/ExtUi.js';
import type { BankExtServices, BankService, Paper, Student } from '../../src/shared/contracts/bank-types.js';

interface World {
  bank: BankService;
  ext: BankExtServices;
  store: MockBankStore;
  svc: ExtPageServices;
  donePaper: Paper;
  loosePaper: Paper;
  student: Student;
  uniformSetId: string;
  customSetId: string;
}

async function seedWorld(): Promise<World> {
  const store = new MockBankStore();
  const bank = new MockBankService(store, false);
  const ext = createMockExtServices(store);

  const student = await ext.student.createStudent({ name: '王小明', studentNo: 'S001' });

  const donePaper = await ext.paper.createPaperEx('期中统一卷', {}, { status: 'done' });
  const customPaper = await ext.paper.createPaperEx('王小明错题卷', {}, { status: 'done' });
  const loosePaper = await ext.paper.createPaperEx('未入集卷', {}, { status: 'done' });

  const uniformSet = await ext.paperSet.createPaperSet({
    name: '期中卷集',
    type: 'uniform',
    batchMeta: { perStudentLimit: 10, timeWindowDays: 30, sourceRule: '按错误人次' },
  });
  await ext.paperSet.addPaper(uniformSet.id, donePaper.id);

  const customSet = await ext.paperSet.createPaperSet({ name: '错题卷集', type: 'custom-mistake' });
  await ext.paperSet.addPaper(customSet.id, customPaper.id, student.id);

  return {
    bank, ext, store, svc: { bank, ext }, donePaper, loosePaper, student,
    uniformSetId: uniformSet.id, customSetId: customSet.id,
  };
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

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});

function el(selector: string): HTMLElement {
  const found = container.querySelector(selector);
  if (!found) throw new Error(`找不到元素: ${selector}`);
  return found as HTMLElement;
}

function clickEl(selector: string) {
  flushSync(() => el(selector).click());
}

function setInput(selector: string, value: string) {
  const input = el(selector) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function setSelect(selector: string, value: string) {
  const select = el(selector) as HTMLSelectElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  setter.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

async function waitFor(assertion: () => void) {
  await vi.waitFor(assertion, { timeout: 3000, interval: 20 });
}

describe('0026 P3：试卷集在组卷侧暴露', () => {
  let world: World;

  beforeEach(async () => { world = await seedWorld(); });

  it('分组展示：统一卷集与错题卷集分类可见，各带卷名/类型徽标', async () => {
    render(<PaperSetPanel svc={world.svc} />);
    await waitFor(() => expect(container.querySelector(String.raw`[data-testid="paper-set-name-input"]`)).toBeTruthy());

    expect(container.querySelector(`[data-testid="paper-set-card-${world.uniformSetId}"]`)).toBeTruthy();
    expect(container.querySelector(`[data-testid="paper-set-card-${world.customSetId}"]`)).toBeTruthy();
    expect(el(`[data-testid="paper-set-type-${world.uniformSetId}"]`).textContent).toBe('统一卷集合');
    expect(el(`[data-testid="paper-set-type-${world.customSetId}"]`).textContent).toBe('定制错题卷集合');
    // 集合内的卷分组展示
    expect(el(`[data-testid="paper-set-paper-${world.uniformSetId}-${world.donePaper.id}"]`).textContent).toContain('期中统一卷');
  });

  it('batch_meta 只读展示：登记键出中文行，且集合内无可编辑控件', async () => {
    render(<PaperSetPanel svc={world.svc} />);
    await waitFor(() => expect(container.querySelector(String.raw`[data-testid="paper-set-name-input"]`)).toBeTruthy());

    const meta = el(`[data-testid="paper-set-meta-${world.uniformSetId}"]`);
    expect(meta.textContent).toContain('每人上限：10 题');
    expect(meta.textContent).toContain('时间窗：30 天');
    expect(meta.textContent).toContain('选题来源：按错误人次');
    expect(meta.querySelectorAll('input, select, textarea').length).toBe(0);
    // 目检返工：没定 batch_meta 的集合不再挂一行「未设置」占位（一期只定字段，无数据就不占行）
    expect(container.querySelector(`[data-testid="paper-set-meta-${world.customSetId}"]`)).toBeNull();
  });

  it('custom-mistake 每生一卷：展示既有学生卷（含学生名），只读不生成', async () => {
    const before = { papers: world.store.papers.size, sets: world.store.paperSets.size };
    render(<PaperSetPanel svc={world.svc} />);
    await waitFor(() => expect(container.querySelector(String.raw`[data-testid="paper-set-name-input"]`)).toBeTruthy());

    const row = el(`[data-testid="paper-set-paper-${world.customSetId}-${world.store.papers.get('p2')!.id}"]`);
    expect(row.textContent).toContain('王小明');
    // 谁和哪份卷配上了，摆在行首（目检：原来只把学生名挤在右侧，看不清关系）
    expect(el(`[data-testid="paper-set-student-${world.customSetId}-${world.store.papers.get('p2')!.id}"]`).textContent).toBe('王小明');
    expect(el(`[data-testid="paper-set-perstudent-hint-${world.customSetId}"]`).textContent).toContain('每生一卷');
    expect(el(`[data-testid="paper-set-perstudent-hint-${world.customSetId}"]`).textContent).toContain('已入集');
    // 只展示既有数据：渲染不新增卷、不新增集合
    expect(world.store.papers.size).toBe(before.papers);
    expect(world.store.paperSets.size).toBe(before.sets);
  });

  it('手动新建试卷集：名称 + 类型 → 落库并出现在列表', async () => {
    render(<PaperSetPanel svc={world.svc} />);
    await waitFor(() => expect(container.querySelector(String.raw`[data-testid="paper-set-name-input"]`)).toBeTruthy());

    setInput('[data-testid="paper-set-name-input"]', '月考卷集');
    setSelect('[data-testid="paper-set-type-select"]', 'uniform');
    clickEl('[data-testid="paper-set-create-btn"]');
    await waitFor(() => {
      const created = [...world.store.paperSets.values()].find((s) => s.name === '月考卷集');
      expect(created).toBeTruthy();
    });
    const created = [...world.store.paperSets.values()].find((s) => s.name === '月考卷集')!;
    await waitFor(() => expect(container.querySelector(`[data-testid="paper-set-card-${created.id}"]`)).toBeTruthy());
  });

  it('加入试卷：下拉只列已定稿卷（含未入集卷），加入后集合内可见', async () => {
    render(<PaperSetPanel svc={world.svc} />);
    await waitFor(() => expect(container.querySelector(String.raw`[data-testid="paper-set-name-input"]`)).toBeTruthy());

    const options = [...(el(`[data-testid="paper-set-add-select-${world.uniformSetId}"]`) as HTMLSelectElement).options].map((o) => o.value);
    expect(options).toContain(world.loosePaper.id);
    expect(options).not.toContain(world.donePaper.id); // 已在集内的卷不再列

    setSelect(`[data-testid="paper-set-add-select-${world.uniformSetId}"]`, world.loosePaper.id);
    clickEl(`[data-testid="paper-set-add-btn-${world.uniformSetId}"]`);
    await waitFor(async () => {
      const refs = await world.ext.paperSet.getSetPapers(world.uniformSetId);
      expect(refs.map((r) => r.paperId)).toContain(world.loosePaper.id);
    });
    await waitFor(() => expect(container.querySelector(`[data-testid="paper-set-paper-${world.uniformSetId}-${world.loosePaper.id}"]`)).toBeTruthy());
    expect(container.querySelector(`[data-testid="paper-set-paper-${world.uniformSetId}-${world.loosePaper.id}"]`)).toBeTruthy();
  });

  it('错题卷集入集时指定学生：卷与学生配成一行（关系可见），提示计数随之更新', async () => {
    // 另造一名学生：指派后「已入集 N 名学生」应随之 +1
    const second = await world.ext.student.createStudent({ name: '张三' });
    render(<PaperSetPanel svc={world.svc} />);
    await waitFor(() => expect(container.querySelector(String.raw`[data-testid="paper-set-name-input"]`)).toBeTruthy());

    // 错题卷集才有「学生」下拉（统一卷集没有此项）
    const studentSelect = el(`[data-testid="paper-set-add-student-${world.customSetId}"]`) as HTMLSelectElement;
    expect(container.querySelector(`[data-testid="paper-set-add-student-${world.uniformSetId}"]`)).toBeNull();
    expect([...studentSelect.options].map((o) => o.textContent)).toContain('王小明');
    expect(el(`[data-testid="paper-set-perstudent-hint-${world.customSetId}"]`).textContent).toContain('已入集 1');

    setSelect(`[data-testid="paper-set-add-select-${world.customSetId}"]`, world.loosePaper.id);
    setSelect(`[data-testid="paper-set-add-student-${world.customSetId}"]`, second.id);
    clickEl(`[data-testid="paper-set-add-btn-${world.customSetId}"]`);

    await waitFor(() => {
      const row = container.querySelector(`[data-testid="paper-set-student-${world.customSetId}-${world.loosePaper.id}"]`);
      if (!row || row.textContent !== '张三') throw new Error('学生与卷未配上');
    });
    // 提示计数：已入集 2 名学生（原 1 + 新指派的 1）
    expect(el(`[data-testid="paper-set-perstudent-hint-${world.customSetId}"]`).textContent).toContain('已入集 2');
  });

  it('移出试卷：集合内消失且卷本身保留（B11）', async () => {
    render(<PaperSetPanel svc={world.svc} />);
    await waitFor(() => expect(container.querySelector(String.raw`[data-testid="paper-set-name-input"]`)).toBeTruthy());

    clickEl(`[data-testid="paper-set-remove-paper-${world.uniformSetId}-${world.donePaper.id}"]`);
    await waitFor(() => expect(container.querySelector(`[data-testid="paper-set-paper-${world.uniformSetId}-${world.donePaper.id}"]`)).toBeNull());
    expect(await world.ext.paperSet.getSetPapers(world.uniformSetId)).toEqual([]);
    expect(await world.ext.paper.getPaperEx(world.donePaper.id)).not.toBeNull();
  });

  it('删除试卷集：两步确认 → 集合消失、集内卷保留', async () => {
    render(<PaperSetPanel svc={world.svc} />);
    await waitFor(() => expect(container.querySelector(String.raw`[data-testid="paper-set-name-input"]`)).toBeTruthy());

    clickEl(`[data-testid="paper-set-delete-${world.customSetId}"]`);
    flushSync(() => [...container.querySelectorAll('button')].find((b) => b.textContent === '确认删除')!.click());
    await waitFor(() => expect(container.querySelector(`[data-testid="paper-set-card-${world.customSetId}"]`)).toBeNull());
    expect(await world.ext.paperSet.getPaperSet(world.customSetId)).toBeNull();
    expect(await world.ext.paper.getPaperEx(world.store.papers.get('p2')!.id)).not.toBeNull();
  });

  it('坏 batch_meta：读失败不炸面板（错误可见，其余集合仍可用）', async () => {
    const set = world.store.paperSets.get(world.uniformSetId)!;
    world.store.paperSets.set(world.uniformSetId, { ...set, batchMeta: { perStudentLimit: '10' } });

    render(<PaperSetPanel svc={world.svc} />);
    await waitFor(() => expect(container.querySelector('[data-testid="page-message"]')).toBeTruthy());
    expect(el('[data-testid="page-message"]').textContent).toContain('试卷集');
    // 面板骨架仍在（不整页崩）
    expect(container.querySelector('[data-testid="paper-set-section"]')).toBeTruthy();
  });
});

describe('0026 P3：面板只在组卷页出现（HomePage 复用零变化）', () => {
  let world: World;

  beforeEach(async () => { world = await seedWorld(); });

  it('PaperSections 缺省不渲染试卷集面板；showPaperSets 打开后渲染（BasketListPage 走此路径）', async () => {
    render(<PaperSections svc={world.svc} />);
    await waitFor(() => expect(container.querySelector('[data-testid="section-inflight"]')).toBeTruthy());
    expect(container.querySelector('[data-testid="paper-set-section"]')).toBeNull();

    render(<PaperSections svc={world.svc} showPaperSets />);
    await waitFor(() => expect(container.querySelector(String.raw`[data-testid="paper-set-name-input"]`)).toBeTruthy());
  });

  it('BasketListPage 注入 services 时含试卷集面板（组卷页入口）', async () => {
    render(<BasketListPage services={world.svc} />);
    await waitFor(() => expect(container.querySelector(String.raw`[data-testid="paper-set-name-input"]`)).toBeTruthy());
  });
});
