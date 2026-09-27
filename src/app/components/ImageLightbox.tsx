// 0014 目检返工二：全局题目图片灯箱——题干/答案/解析区的图点击放大查看（用户建议：
// 答案整图受列宽约束放大有限，与其逐处调档，不如全域「点图放大」兜底）。
// document 捕获阶段委托，AppShell 挂载一处覆盖全部页面（题库/篮详情/采集预览/校对/排版间）；
// 采集预览等区域的 img src 已由渲染层解析为可直接加载的 URL，直接引用其 src/currentSrc。
// ESC / 点击遮罩关闭；零契约改动（纯 app 显示层）。
import { useEffect, useState } from 'react';

/** 命中这些题目呈现容器内的 img 才触发（与 app.css 题图限宽规则的作用域一致） */
const ZONE_SELECTOR = '.question-content, .question, .answer-field, .analysis-field';

export function ImageLightbox() {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target || target.tagName !== 'IMG') return;
      const img = target as HTMLImageElement;
      if (!img.closest(ZONE_SELECTOR)) return;
      e.preventDefault();
      e.stopPropagation();
      setSrc(img.currentSrc || img.src);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSrc(null);
    };
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  if (!src) return null;
  return (
    <div className="image-lightbox" data-testid="image-lightbox" onClick={() => setSrc(null)}>
      <img src={src} alt="图片放大查看" />
      <div className="image-lightbox-hint">点击任意处或按 ESC 关闭</div>
    </div>
  );
}
