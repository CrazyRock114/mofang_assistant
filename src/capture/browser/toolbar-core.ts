/**
 * 采集窗导航控件条 — 纯逻辑层（D1-fix-2 F-6 / Phase 0）
 *
 * 【0012 退役记档】DOM 接线层 toolbar-preload.ts 已随 0012 P2 退役（顶部栏改主窗 React cap-bar，
 * 导航栈用 webContents 原生 canGoBack/goBack，不复用本层 sessionStorage 栈）。本模块保留原因：
 * 测试基线只增不删（toolbar-core.test.ts 在 93 文件基线内）+ normalizeInputUrl/updateNavStack
 * 纯逻辑可供 0015「采集本页跟随式按钮」复用。
 */

/** 控件条维护的导航历史（sessionStorage 持久，跨页面加载存活） */
export interface NavStackState {
  stack: string[];
  index: number;
}

/**
 * 页面加载后按当前 href 推进历史栈：
 * - 命中栈顶 → 刷新，不动
 * - 命中前/后一项 → 后退/前进，只移指针
 * - 否则 → 截断前向分支并压入（新导航）
 */
export function updateNavStack(state: NavStackState | null, href: string): NavStackState {
  if (!state || !Array.isArray(state.stack) || state.stack.length === 0) {
    return { stack: [href], index: 0 };
  }
  const { stack, index } = state;
  if (stack[index] === href) return { stack, index };
  if (index > 0 && stack[index - 1] === href) return { stack, index: index - 1 };
  if (index < stack.length - 1 && stack[index + 1] === href) return { stack, index: index + 1 };
  const next = stack.slice(0, index + 1);
  next.push(href);
  return { stack: next, index: next.length - 1 };
}

export function canGoBack(state: NavStackState): boolean {
  return state.index > 0;
}

export function canGoForward(state: NavStackState): boolean {
  return state.index < state.stack.length - 1;
}

/**
 * 地址栏输入归一化：空输入 → null；缺协议补 https://；非法 → null
 */
export function normalizeInputUrl(raw: string): string | null {
  const input = raw.trim();
  if (!input) return null;
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(input) ? input : `https://${input}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.href;
  } catch {
    return null;
  }
}

/** 控件条快捷入口（与主窗 CapturePage 面板一致） */
export const CAPTURE_QUICK_LINKS: Array<{ label: string; url: string }> = [
  { label: '组卷网', url: 'https://zujuan.xkw.com/' },
  { label: '菁优网', url: 'https://www.jyeoo.com' },
];

/** D1-fix-3 L-2：控件条「提取试题篮」成功提示（题数 + 回主窗入库指引） */
export function formatExtractNotice(count: number): string {
  return `已提取 ${count} 题，请回主窗点「入库」`;
}
