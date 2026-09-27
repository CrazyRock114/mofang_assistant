// Phase 2: 简单路由 — hash 分发（0004：#/basket 试题篮 + #/compose 排版间 + #/bank 题库管理；
// 旧 #/paper/:id 301 式重定向 #/compose/:id）
// 0010：路由分发逻辑逐字不动；各路由结果包进 <AppShell route>{page}</AppShell>（导航壳 + 三主题）。

import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './app.css'; // 产品全局样式（题目图限宽/行内公式图等，见 app.css 注释）
import './workbench.css'; // 0040：录题工作台样式（设计稿 v4 类名落地，见文件头注释）
import './papers.css'; // 0044：试卷管理页 + 存为试卷弹层样式（设计稿 v5 类名落地）
import './home.css'; // 0049：首页 v3 工作足迹样式（.home-v3 作用域 + 三主题热力色阶 --heat0~4）
import './feedback.css'; // 0030：反馈工作台样式（.fbw-* 作用域，四视图版式）
import { AppShell } from './components/AppShell.js';
import { HomePage } from './pages/HomePage.js';
import { ProofIntakePage } from './pages/ProofIntakePage.js';
// 0040：录题工作台 v2（入口页 + 工作台；导航「录题工作台」指向 #/intake）
import { IntakePage } from './pages/IntakePage.js';
import { WorkbenchPage } from './pages/WorkbenchPage.js';
// 0036：PDF 切题工作区（R-027）
import { SplitWorkspacePage } from './pages/SplitWorkspacePage.js';
import { CapturePage } from './pages/CapturePage.js';
// 0003：学生/班级/考试/错题本四页（接入现有 hash 路由，不做新导航壳）
import { StudentsPage } from './pages/StudentsPage.js';
import { ClassesPage, ClassDetailPage } from './pages/ClassesPage.js';
import { ExamsPage, ExamDetailPage } from './pages/ExamsPage.js';
import { MistakesPage } from './pages/MistakesPage.js';
// 0004：试题篮两阶段流程 + 题库管理页
import { BasketListPage } from './pages/BasketListPage.js';
import { BasketDetailPage } from './pages/BasketDetailPage.js';
import { ComposePage } from './pages/ComposePage.js';
// 0044：试卷管理页（R-036/D-058——组卷页升级；旧 #/basket 重定向本页，旧链接不失效 D-060⑦）
import { PapersPage } from './pages/PapersPage.js';
import { BankPage } from './pages/BankPage.js';
// 0005：课后反馈（M6）
import { FeedbackPage } from './pages/FeedbackPage.js';
// 0010-merge：设置页 v0（外观 + 关于；本文件唯一新增路由）
// 0053：#/settings?view=ai 深链解析（hashSearchOf 复用，nav.ts 现成工具）
import { SettingsPage } from './pages/SettingsPage.js';
import { hashSearchOf } from './utils/nav.js';

/** 旧路由 301 式重定向（渲染即改 hash，由 hashchange 驱动重渲） */
function RouteRedirect({ to }: { to: string }) {
  useEffect(() => {
    window.location.hash = to;
  }, [to]);
  return null;
}

export function App() {
  const [route, setRoute] = useState(window.location.hash || '#/');

  useEffect(() => {
    const handleHashChange = () => setRoute(window.location.hash);
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  // 0004：旧组卷路由 → 排版间（先于其它匹配）
  const legacyPaperMatch = route.match(/^#\/paper\/(.+)$/);
  if (legacyPaperMatch) {
    return <RouteRedirect to={`#/compose/${decodeURIComponent(legacyPaperMatch[1])}`} />;
  }

  // 0044（D-060⑦）：试卷管理页接管组卷列表——旧 `#/basket`（无 id）301 式重定向 `#/papers`
  //（旧链接不失效）；`#/basket/<id>` 篮详情与 `#/compose/<id>` 排版间不动（任务书禁区 2）。
  if (route === '#/basket') {
    return <RouteRedirect to="#/papers" />;
  }
  if (route === '#/papers') {
    return <AppShell route={route}><PapersPage /></AppShell>;
  }
  const basketMatch = route.match(/^#\/basket\/(.+)$/);
  if (basketMatch) {
    return <AppShell route={route}><BasketDetailPage paperId={decodeURIComponent(basketMatch[1])} /></AppShell>;
  }
  const composeMatch = route.match(/^#\/compose\/(.+)$/);
  if (composeMatch) {
    return <AppShell route={route}><ComposePage paperId={decodeURIComponent(composeMatch[1])} /></AppShell>;
  }
  if (route === '#/bank') {
    return <AppShell route={route}><BankPage /></AppShell>;
  }
  // 0005：课后反馈
  if (route === '#/feedback') {
    return <AppShell route={route}><FeedbackPage /></AppShell>;
  }

  // 0028：试题录入转正（R-007 识别管线开放）——第一屏=大拖放区（R-028「先拖进来」），
  // #/proof/<runId> 带入既有 run（关页回来续跑）。分支锚点与总数（13 条）逐字不动。
  //
  // 0040（只增 + 一处重定向）：录题工作台 v2 接管入口——`#/proof`（无 runId）重定向到 `#/intake`；
  // `#/proof/<runId>` **保留**（旧 run 直链兼容，ProofPage 呈 deprecated 注释，见 P6.4）。
  if (route === '#/proof') {
    return <RouteRedirect to="#/intake" />;
  }
  if (route.startsWith('#/proof/')) {
    const runMatch = route.match(/^#\/proof\/(.+)$/);
    // 0036：runId 段可能带 query（切题工作区跳转带 ?from=split/<项目> 供校对页返回），
    // 必须切掉 query 再解 id——否则 runId 变成 "abc?from=..."，状态回读直接查不到 run。
    const runId = runMatch ? decodeURIComponent(runMatch[1].split('?')[0]) : undefined;
    return <AppShell route={route}><ProofIntakePage {...(runId ? { runId } : {})} /></AppShell>;
  }

  // 0040（只增）：录题工作台 v2 —— 入口页 `#/intake` + 工作台 `#/intake/<runId>`（关页回来即恢复现场）
  if (route === '#/intake') {
    return <AppShell route={route}><IntakePage /></AppShell>;
  }
  if (route.startsWith('#/intake/')) {
    const intakeMatch = route.match(/^#\/intake\/(.+)$/);
    const runId = intakeMatch ? decodeURIComponent(intakeMatch[1].split('?')[0]) : '';
    if (runId) return <AppShell route={route}><WorkbenchPage runId={runId} /></AppShell>;
  }

  // 0036：PDF 切题工作区（R-027）——录题页拖入 PDF 后跳这里；#/split/<projectId> 带入项目即恢复现场
  // （切段/框/识别队列都在工作区文件态里）。这是第 14 条分发分支，前 13 条逐字未动。
  if (route === '#/split' || route.startsWith('#/split/')) {
    const splitMatch = route.match(/^#\/split\/(.+)$/);
    const projectId = splitMatch ? decodeURIComponent(splitMatch[1]) : undefined;
    return <AppShell route={route}><SplitWorkspacePage {...(projectId ? { projectId } : {})} /></AppShell>;
  }

  // D1：采集面板（控制独立采集窗口 + 试题篮提取预览 + 入库回显）
  // 0004-fix-1 D：带 query 的采集路由（#/capture?toBasket=<paperId>）必须同样命中——
  // 否则回落 HomePage，篮详情「从网络采集」的目标篮联动整条链断（目检实测定位）
  if (route === '#/capture' || route.startsWith('#/capture?')) {
    return <AppShell route={route}><CapturePage /></AppShell>;
  }

  // 0003：学生/班级/考试/错题本
  if (route === '#/students') {
    return <AppShell route={route}><StudentsPage /></AppShell>;
  }
  if (route === '#/classes') {
    return <AppShell route={route}><ClassesPage /></AppShell>;
  }
  const classMatch = route.match(/^#\/classes\/(.+)$/);
  if (classMatch) {
    return <AppShell route={route}><ClassDetailPage classId={decodeURIComponent(classMatch[1])} /></AppShell>;
  }
  if (route === '#/exams') {
    return <AppShell route={route}><ExamsPage /></AppShell>;
  }
  const examMatch = route.match(/^#\/exams\/(.+)$/);
  if (examMatch) {
    return <AppShell route={route}><ExamDetailPage examId={decodeURIComponent(examMatch[1])} /></AppShell>;
  }
  if (route === '#/mistakes') {
    return <AppShell route={route}><MistakesPage /></AppShell>;
  }

  // 0010-merge：设置页 v0（只增这一条路由，其余分发逐字不动）
  // 0053：#/settings?view=ai 深链直达 AI 视图（query 路由先例=#/capture?；同一 return 位单行保持，
  // app-routing 的 AppShell 计数护栏 :137 依赖单行形态）
  if (route === '#/settings' || route.startsWith('#/settings?')) {
    const settingsView = new URLSearchParams(hashSearchOf(route)).get('view');
    return <AppShell route={route}><SettingsPage {...(settingsView === 'ai' ? { initialView: settingsView } : {})} /></AppShell>;
  }

  return <AppShell route={route}><HomePage /></AppShell>;
}

// 入口自挂载（生产 index.html 提供 #root；测试/SSR 无 #root 时跳过，便于直接测 App 路由）
const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
