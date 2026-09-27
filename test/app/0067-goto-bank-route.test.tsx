// 0067 顺手修复（用户 2026-09-24 授权）：路由侧闭合断言——采集结果条「查看题库」产出的 hash
// 必须真的落到「题库管理」页面组件（不只是字符串相等）。
// 断言面 = 真 App 路由分发（main.tsx）+ 被替换成轻量标记的各路由目标页（照 app-routing.test.tsx 范式）。
// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import { App } from '../../src/app/main.js';

vi.mock('../../src/app/pages/BankPage.js', () => ({ BankPage: () => <div data-page="bank" /> }));
vi.mock('../../src/app/pages/HomePage.js', () => ({ HomePage: () => <div data-page="home" /> }));
vi.mock('../../src/app/pages/CapturePage.js', () => ({ CapturePage: () => <div data-page="capture" /> }));
vi.mock('../../src/app/pages/ProofIntakePage.js', () => ({ ProofIntakePage: () => <div data-page="proof-intake" /> }));
vi.mock('../../src/app/pages/IntakePage.js', () => ({ IntakePage: () => <div data-page="intake" /> }));
vi.mock('../../src/app/pages/WorkbenchPage.js', () => ({ WorkbenchPage: () => <div data-page="workbench" /> }));
vi.mock('../../src/app/pages/SplitWorkspacePage.js', () => ({ SplitWorkspacePage: () => <div data-page="split" /> }));
vi.mock('../../src/app/pages/StudentsPage.js', () => ({ StudentsPage: () => <div data-page="students" /> }));
vi.mock('../../src/app/pages/ClassesPage.js', () => ({ ClassesPage: () => <div data-page="classes" />, ClassDetailPage: () => <div data-page="class-detail" /> }));
vi.mock('../../src/app/pages/ExamsPage.js', () => ({ ExamsPage: () => <div data-page="exams" />, ExamDetailPage: () => <div data-page="exam-detail" /> }));
vi.mock('../../src/app/pages/MistakesPage.js', () => ({ MistakesPage: () => <div data-page="mistakes" /> }));
vi.mock('../../src/app/pages/BasketListPage.js', () => ({ BasketListPage: () => <div data-page="basket-list" /> }));
vi.mock('../../src/app/pages/PapersPage.js', () => ({ PapersPage: () => <div data-page="papers" /> }));
vi.mock('../../src/app/pages/BasketDetailPage.js', () => ({ BasketDetailPage: () => <div data-page="basket-detail" /> }));
vi.mock('../../src/app/pages/ComposePage.js', () => ({ ComposePage: () => <div data-page="compose" /> }));
vi.mock('../../src/app/pages/FeedbackPage.js', () => ({ FeedbackPage: () => <div data-page="feedback" /> }));
vi.mock('../../src/app/pages/SettingsPage.js', () => ({ SettingsPage: () => <div data-page="settings" /> }));

let container: HTMLDivElement;
let root: Root | null = null;

function renderAt(hash: string) {
  window.location.hash = hash;
  container?.remove();
  root?.unmount();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => root!.render(<App />));
}

function pageName(): string | null {
  const el = container.querySelector('[data-page]');
  return el ? el.getAttribute('data-page') : null;
}

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  window.location.hash = '';
});

describe('0067 顺手修复：题库路由落地（#/bank → 题库管理页，而非首页工作台）', () => {
  it('#/bank 渲染题库管理页（BankPage），不是首页', () => {
    renderAt('#/bank');
    expect(pageName()).toBe('bank');
  });

  it('对照：#/ 才是首页（旧实现「查看题库」跳的就是这里）', () => {
    renderAt('#/');
    expect(pageName()).toBe('home');
  });
});
