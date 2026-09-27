// 0010：三档主题分段开关（React 重写自参考实现 app.js 的 mountThemeSwitches）。
// 暖纸 / 澄光 / 夜航；点击即切 <html data-theme> + localStorage(mfa-theme) 持久化。
// 挂载位：导航底部（AppShell sidebar-foot）+ 采集页顶部采集栏右侧（参照 capture.html）。
// 0018 P3：compact 形态（折叠态侧栏竖排色点，CSS 见 theme.css 末尾 .theme-switch.compact）；
// AppShell 折叠分支传入，SettingsPage 等复用点缺省 false = 展开态观感零回归。

import { useEffect, useState } from 'react';
import { applyTheme, currentTheme, storedTheme, THEME_LABEL, type AppTheme } from '../theme.js';

const THEME_ORDER: AppTheme[] = ['warm', 'light', 'dark'];

export function ThemeSwitch({ testid, compact }: { testid?: string; compact?: boolean }) {
  const [active, setActive] = useState<AppTheme>(() => currentTheme());

  // 挂载自愈：无防闪烁脚本的场景（测试环境/异常路径）按 localStorage 对齐，
  // 生产环境 index.html 内联脚本先行应用，此处结果一致（幂等）
  useEffect(() => {
    const stored = storedTheme();
    if (stored !== currentTheme() || document.documentElement.getAttribute('data-theme') === null) {
      applyTheme(stored);
    }
    setActive(stored);
  }, []);

  const pick = (t: AppTheme) => {
    applyTheme(t);
    setActive(t);
  };

  return (
    <div className={compact ? 'theme-switch compact' : 'theme-switch'} role="group" aria-label="主题切换" data-testid={testid}>
      {THEME_ORDER.map((t) => (
        <button
          key={t}
          type="button"
          className={t === active ? 'ts-btn on' : 'ts-btn'}
          data-theme-btn={t}
          data-testid={testid ? `${testid}-${t}` : `theme-btn-${t}`}
          aria-pressed={t === active}
          onClick={() => pick(t)}
        >
          <i className="sw" />
          {/* label 包一层 span：侧栏折叠态经 .sidebar.collapsed .ts-label 隐藏文字只留色点 */}
          <span className="ts-label">{THEME_LABEL[t]}</span>
        </button>
      ))}
    </div>
  );
}
