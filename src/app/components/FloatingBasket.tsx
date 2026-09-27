// 0026 B2：右侧吸附悬浮篮（学科网/菁优网式）——收起时只是边缘一枚图标，点击展开抽屉。
//
// 为什么要独立成组件：错题篮与试题篮是同一心智（都落 papers 模型），题库页后续要用同一形态，
// 故这里只做**形态**（图标 + 计数角标 + 抽屉壳 + 开合/关闭交互），内容全由 children 决定，
// 不绑定任何数据源。迁题库时直接复用本组件，换 children 即可。
//
// 交互约定：点图标开合；面板内点关闭按钮或按 Esc 收起；点击面板外不收起（避免误触丢操作焦点）。

import { useCallback, useEffect, useState, type ReactNode } from 'react';

export interface FloatingBasketProps {
  /** 抽屉标题（如「错题篮」） */
  title: string;
  /** 条数角标（0 显示为 0，不隐藏——空篮也让学生看到自己能往里放） */
  count: number;
  /** 收起态图标文案（默认 🧺，可用 emoji 或字符） */
  icon?: string;
  /** 测试 id 前缀（默认 floating-basket；两处并用时各自给前缀，testid 不撞） */
  testid?: string;
  /** 抽屉内容（条目列表 + 操作区） */
  children: ReactNode;
}

export function FloatingBasket({ title, count, icon = '🧺', testid = 'floating-basket', children }: FloatingBasketProps) {
  const [open, setOpen] = useState(false);

  const onKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.key === 'Escape') setOpen(false);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onKeyDown]);

  return (
    <>
      <button
        type="button"
        data-testid={`${testid}-toggle`}
        data-open={open}
        aria-expanded={open}
        className="floating-basket-toggle"
        title={open ? `收起${title}` : `展开${title}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="floating-basket-icon" aria-hidden="true">{icon}</span>
        <span className="floating-basket-label">{title}</span>
        <span data-testid={`${testid}-count`} className="floating-basket-badge">{count}</span>
      </button>

      {open && (
        <aside data-testid={`${testid}-panel`} className="floating-basket-panel" aria-label={title}>
          <div className="floating-basket-head">
            <strong>{title}（<span data-testid={`${testid}-panel-count`}>{count}</span>）</strong>
            <button
              type="button"
              className="btn btn-sm"
              data-testid={`${testid}-close`}
              onClick={() => setOpen(false)}
            >
              收起
            </button>
          </div>
          <div className="floating-basket-body">{children}</div>
        </aside>
      )}
    </>
  );
}
