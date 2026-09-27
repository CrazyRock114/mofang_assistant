// 0010-merge P3.11：吉祥物「小方同学」改为位图组件（决策更新：raster 固定位图、不随主题变色，
// 取代 0010 视觉定稿「SVG 走 --m-*」条）。表情名 → 裁图文件映射；裁图产物由
// scripts/crop-brand-assets.mjs 从 品牌设计稿 mascot-sprites.png 裁出（已剔底部中文标签、
// trim 透明边、统一高 512px），vite import 引用，零外链零新依赖。
// data-mascot 属性 = 角色标记（测试/目检定位）保留。出现位：首页引导（happy）、各页空状态
// （stand，失败/异常场景可用 lost）、采集等待进度区（work）、设置页关于（like）。
// 导航内不放吉祥物——品牌位已由 Logo（logo-mark.png）占位。

import type { CSSProperties } from 'react';
import standPng from '../assets/brand/mascot-stand.png';
import happyPng from '../assets/brand/mascot-happy.png';
import likePng from '../assets/brand/mascot-like.png';
import workPng from '../assets/brand/mascot-work.png';
import lostPng from '../assets/brand/mascot-lost.png';
import cheerPng from '../assets/brand/mascot-cheer.png';
import byePng from '../assets/brand/mascot-bye.png';

export type MascotMood = 'stand' | 'happy' | 'like' | 'work' | 'lost' | 'cheer' | 'bye';

/** 表情名 → 裁图资产（雪碧图格位见裁图脚本 CELLS 表） */
const MOOD_SRC: Record<MascotMood, string> = {
  stand: standPng,
  happy: happyPng,
  like: likePng,
  work: workPng,
  lost: lostPng,
  cheer: cheerPng,
  bye: byePng,
};

export function Mascot({
  mood = 'stand',
  size = 72,
  className,
  style,
}: {
  mood?: MascotMood;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <img
      className={className ? `mascot-img ${className}` : 'mascot-img'}
      data-mascot={mood}
      src={MOOD_SRC[mood]}
      height={size}
      alt="小方同学"
      draggable={false}
      style={{ width: 'auto', ...style }}
    />
  );
}
