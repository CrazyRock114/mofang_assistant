// 0010-merge P2：导航壳 v2 —— 用户拍板新导航（权威覆盖 0010 §一.2 映射表）；
// 0011 §一.2 导航合并（Q1-4 拍板）：「组卷排版」+「试卷管理」并为一条「组卷」恒 #/basket，
// 4 组 11 条 → 10 条（nav-basket 退役，唯一授权 testid 删除）；resolveComposeHref 三态解析链全删。
// 侧栏可折叠（localStorage mfa-nav-collapsed="1"/"0" 持久化，折叠态纯图标 + title 悬浮提示）；
// 品牌位 = 新 Logo 方块标（旧手绘吉祥物退役）；左下固定区 = 皮肤三档开关 + 设置入口，
// 固定底部不随导航滚动（nav 自身滚动）。
// main.tsx 的 12 条路由分发逻辑零改动；children = 路由结果页面；route prop 仅用于高亮。

import { useState } from 'react';
import type { ReactNode } from 'react';
import '../theme.css';
import logoMark from '../assets/brand/logo-mark.png';
import { ThemeSwitch } from './ThemeSwitch.js';
import { ImageLightbox } from './ImageLightbox.js';
// 0072（只增）：公告中心（左下入口 + 弹窗；D-088 口径）
import { AnnounceCenter } from './AnnounceCenter.js';
import { useExtPageServices, type ExtPageServices } from '../pages/ExtUi.js';

/** 16×16 线性图标（stroke 走 currentColor 随导航态变色） */
function Icon({ d }: { d: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

const ICON_PATHS = {
  home: 'M2 7 L8 2 L14 7 V14 H10 V10 H6 V14 H2 Z',
  bank: 'M2.5 3.5 H13.5 V12.5 H2.5 Z M5 6.5 H11 M5 9.5 H9',
  capture: 'M8 2 A6 6 0 1 0 8 14 A6 6 0 1 0 8 2 M2 8 H14 M8 2 C10 4.5 10 11.5 8 14 C6 11.5 6 4.5 8 2',
  compose: 'M4 2 H12 V14 H4 Z M6.5 5.5 H9.5 M6.5 8 H9.5 M6.5 10.5 H9.5',
  proof: 'M3 2.5 H11 L13 4.5 V13.5 H3 Z M5.5 6 H10.5 M5.5 8.5 H10.5 M5.5 11 H8.5',
  // 0040（只增）：录题工作台——页 + 框选 + 识别（合并原「试题录入」「PDF 切题」两入口）
  intake: 'M2.5 3 H9.5 V10.5 H2.5 Z M6 4.5 L8 6.5 M8 6.5 L6 8.5 M11.5 5.5 V13.5 H4.5',
  basket: 'M3 3 H13 L12 13 H4 Z M5.5 5.5 V3.5 A2.5 2.5 0 0 1 10.5 3.5 V5.5',
  students: 'M8 5.5 A2.6 2.6 0 1 0 8 3 A2.6 2.6 0 1 0 8 5.5 M3 13.5 C3 10.5 5.5 9.5 8 9.5 C10.5 9.5 13 10.5 13 13.5',
  classes: 'M8 2 L14 5 L8 8 L2 5 Z M4.5 6.5 V10 C4.5 11 6 12 8 12 C10 12 11.5 11 11.5 10 V6.5 M2 5 V9',
  mistakes: 'M3 2.5 H13 V13.5 H3 Z M5.5 6 L7 7.5 L10.5 4.5 M5.5 10.5 H10.5',
  exams: 'M3 13 V5 M8 13 V3 M13 13 V8 M2 13.5 H14',
  feedback: 'M2.5 3.5 H13.5 V10.5 H8 L5 13 V10.5 H2.5 Z',
  // 0036（只增）：PDF 切题——整卷页 + 其上画出的框
  split: 'M3 2.5 H11 L13 4.5 V13.5 H3 Z M6 6.5 H10.5 V9.5 H6 Z',
  settings: 'M8 5.5 A2.5 2.5 0 1 0 8 10.5 A2.5 2.5 0 1 0 8 5.5 M8 1.5 V3.2 M8 12.8 V14.5 M1.5 8 H3.2 M12.8 8 H14.5 M3.4 3.4 L4.6 4.6 M11.4 11.4 L12.6 12.6 M12.6 3.4 L11.4 4.6 M4.6 11.4 L3.4 12.6',
} as const;

export type NavKey =
  | 'home' | 'bank' | 'capture' | 'compose' | 'proof' | 'split' | 'intake'
  | 'students' | 'classes' | 'exams' | 'mistakes' | 'feedback';

interface NavItemDef {
  key: NavKey;
  label: string;
  icon: string;
  /** 导航落地路由（静态恒定；组卷条目 = #/basket） */
  href: string;
  /** 该条目命中的路由（与 main.tsx 分发规则同构，只读不改） */
  match: (route: string) => boolean;
}

/** 4 组 9 条（0011 §一.2：组卷排版+试卷管理 → 组卷，Q1-4 拍板；0040 三入口合并为「录题工作台」） */
export const NAV_ITEMS: NavItemDef[] = [
  { key: 'home', label: '首页', icon: ICON_PATHS.home, href: '#/', match: (r) => r === '#/' },
  { key: 'bank', label: '题库管理', icon: ICON_PATHS.bank, href: '#/bank', match: (r) => r.startsWith('#/bank') },
  { key: 'capture', label: '网络采集', icon: ICON_PATHS.capture, href: '#/capture', match: (r) => r === '#/capture' || r.startsWith('#/capture?') },
  // 0044（D-060⑦）：「组卷」更名「试卷管理」，落地 #/papers（旧 #/basket 重定向同页）；
  // match 含 #/papers、#/basket（旧链重定向态）、#/compose 与 #/paper 前缀（排版中高亮不丢）。
  { key: 'compose', label: '试卷管理', icon: ICON_PATHS.compose, href: '#/papers', match: (r) => r.startsWith('#/compose/') || r.startsWith('#/paper/') || r === '#/papers' || r === '#/basket' || r.startsWith('#/basket/') },
  // 0040（重挂）：原「试题录入（#/proof）」+「PDF 切题（#/split）」两项**合并**为「录题工作台」——
  // 单题/多题/整卷三类入口在入口页分流（图片走 #/intake，整卷走卡二的 #/split）。
  // 路由侧 #/split 与 #/proof/<runId> 均保留（前者仍在用，后者为旧直链兼容）。
  { key: 'intake', label: '录题工作台', icon: ICON_PATHS.intake, href: '#/intake', match: (r) => r === '#/intake' || r.startsWith('#/intake/') || r === '#/proof' || r.startsWith('#/proof/') || r === '#/split' || r.startsWith('#/split/') },
  { key: 'students', label: '学生档案', icon: ICON_PATHS.students, href: '#/students', match: (r) => r.startsWith('#/students') },
  { key: 'classes', label: '班级管理', icon: ICON_PATHS.classes, href: '#/classes', match: (r) => r.startsWith('#/classes') },
  { key: 'exams', label: '考试管理', icon: ICON_PATHS.exams, href: '#/exams', match: (r) => r.startsWith('#/exams') },
  { key: 'mistakes', label: '错题本', icon: ICON_PATHS.mistakes, href: '#/mistakes', match: (r) => r === '#/mistakes' },
  { key: 'feedback', label: '课后反馈', icon: ICON_PATHS.feedback, href: '#/feedback', match: (r) => r === '#/feedback' },
];

interface NavGroupDef {
  title: string;
  keys: NavKey[];
}

const NAV_GROUPS: NavGroupDef[] = [
  { title: '首页', keys: ['home'] },
  { title: '备课工具', keys: ['bank', 'capture', 'compose', 'intake'] },
  { title: '学生管理', keys: ['students', 'classes', 'exams', 'mistakes'] },
  { title: '课后反馈', keys: ['feedback'] },
];

/** 路由 → 高亮条目（子页父项高亮；未知路由回落首页，与 main.tsx 兜底 HomePage 同语义） */
export function resolveActiveKey(route: string): NavKey {
  for (const item of NAV_ITEMS) {
    if (item.key !== 'home' && item.match(route)) return item.key;
  }
  return 'home';
}

/** 折叠态 localStorage key（0010-merge 任务书 §一.P2.6 钉死；"1"=折叠 / "0"=展开） */
export const NAV_COLLAPSED_KEY = 'mfa-nav-collapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(NAV_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(NAV_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    /* localStorage 不可用（隐私模式等）——折叠仅本次会话生效 */
  }
}

/**
 * 导航壳：route prop 用于高亮计算（hash 分发仍在 main.tsx，逐字不动）。
 * children = 路由结果页面；svc 可注入（测试双跑），缺省走服务工厂（Electron IPC / 浏览器 mock）。
 * 0011：组卷条目 href 静态恒 #/basket，无运行时解析（resolveComposeHref 已随多篮正式化删除）。
 */
export function AppShell({ route, children, svc }: { route: string; children: ReactNode; svc?: ExtPageServices }) {
  useExtPageServices(svc);
  const active = resolveActiveKey(route);
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsed);

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      writeCollapsed(!prev);
      return !prev;
    });
  };

  return (
    <div className="app">
      <aside className={collapsed ? 'sidebar collapsed' : 'sidebar'}>
        <div className="brand">
          {/* 品牌位：新 Logo 方块标（圆角托底容器化解素材白色辉光，P3.12）；折叠态纯方块标 */}
          <img className="brand-logo" data-testid="brand-logo" src={logoMark} alt="魔方助教" draggable={false} />
          <div className="brand-text">
            <div className="brand-name" data-testid="brand-name">魔方助教</div>
            <div className="brand-sub">教师一站式工作台</div>
          </div>
          <button
            type="button"
            className="sidebar-toggle"
            data-testid="sidebar-collapse-toggle"
            aria-expanded={!collapsed}
            aria-label={collapsed ? '展开侧栏' : '折叠侧栏'}
            title={collapsed ? '展开侧栏' : '折叠侧栏'}
            onClick={toggleCollapsed}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              {collapsed ? <path d="M6 3.5 L10.5 8 L6 12.5" /> : <path d="M10 3.5 L5.5 8 L10 12.5" />}
            </svg>
          </button>
        </div>

        <nav data-testid="app-shell-nav">
          {NAV_GROUPS.map((group) => (
            <div className="nav-group" key={group.title}>
              <div className="nav-group-title">{group.title}</div>
              {group.keys.map((key) => {
                const item = NAV_ITEMS.find((n) => n.key === key)!;
                const isActive = item.key === active;
                return (
                  <a
                    key={item.key}
                    className={isActive ? 'nav-item active' : 'nav-item'}
                    data-testid={`nav-${item.key}`}
                    data-active={isActive ? 'true' : 'false'}
                    href={item.href}
                    title={collapsed ? item.label : undefined}
                  >
                    <Icon d={item.icon} />
                    <span className="nav-label">{item.label}</span>
                  </a>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="sidebar-foot">
          {/* 0018 P3：折叠态传 compact（竖排色点紧凑形态），展开态零变化 */}
          <ThemeSwitch testid="shell-theme-switch" compact={collapsed} />
          {/* 0072（只增）：公告入口（D-088：设置上方；无桥不渲染；未读红点；点击打开公告弹窗） */}
          <AnnounceCenter collapsed={collapsed} />
          {/* 设置入口（设置页 v0：外观 + 关于） */}
          <a className="foot-link" data-testid="nav-settings" href="#/settings" title={collapsed ? '设置' : undefined}>
            <Icon d={ICON_PATHS.settings} />
            <span className="nav-label">设置</span>
          </a>
        </div>
      </aside>

      <main className="main">{children}</main>

      {/* 0014 目检返工二：全局题目图片灯箱（点图放大），委托监听一处全域生效 */}
      <ImageLightbox />
    </div>
  );
}
