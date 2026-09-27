// 0010：主题读写（React 化重写自 warm-paper 设计稿 app.js 的 getTheme/setTheme）。
// localStorage key = mfa-theme（沿用参考实现，不许另起）；颜色挂在 <html data-theme>。
// index.html 的防闪烁内联脚本先行应用同源逻辑，本模块负责运行时切换与自愈。

export type AppTheme = 'warm' | 'light' | 'dark';

/** localStorage key（参考实现同款，禁改） */
export const THEME_KEY = 'mfa-theme';

export const THEME_LABEL: Record<AppTheme, string> = {
  warm: '暖纸',
  light: '澄光',
  dark: '夜航',
};

/** 任意字符串 → 合法主题（非法值回落 warm，缺省 warm） */
export function normalizeTheme(value: string | null | undefined): AppTheme {
  return value === 'light' || value === 'dark' ? value : 'warm';
}

/** 当前生效主题：<html data-theme> 优先，缺省 warm */
export function currentTheme(): AppTheme {
  if (typeof document === 'undefined') return 'warm';
  return normalizeTheme(document.documentElement.getAttribute('data-theme'));
}

/** localStorage 存储的主题（无存储/非法 → warm） */
export function storedTheme(): AppTheme {
  try {
    return normalizeTheme(localStorage.getItem(THEME_KEY));
  } catch {
    return 'warm';
  }
}

/** 应用主题：写 <html data-theme> + localStorage 持久化（语义照搬参考实现 setTheme） */
export function applyTheme(theme: AppTheme): void {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* localStorage 不可用（隐私模式等）——主题仅本次会话生效 */
  }
}
