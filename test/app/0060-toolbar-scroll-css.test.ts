// 0063 改写（原 0060 内滚口径，D-077③ 拍板退役）：排版页顶栏样式锁。
//
// 原口径（0060/D-071③ B 方案：[data-testid="compose-toolbar-actions"] 自身横向内滚 + 条内按钮
// 不收缩不折行）随 0063 顶栏重做退役——五操作位（D-077②）设计下按钮恒不溢出，窄窗由卷名
// ellipsis（h1 min-width:0 内联锚点）吸收；theme.css 中 actions 的 overflow-x:auto 已删除。
// 等强改写口径（0063 任务书 §一.1 末条，逐处登记进交付报告）：
//   ① 新顶栏卡片块 .compose-toolbar 在场（flex 布局收编 + 卡片皮肤：--card 底/细线边/圆角 12/浅阴影）；
//   ② 退役判据：[data-testid="compose-toolbar-actions"] 不再有 overflow-x:auto（内滚段确实不在）；
//   ③ 配方保留判据：actions 直属按钮 flex:0 0 auto + white-space:nowrap（防折行配方从 0060 段平移保留）。
// 区段追加在 theme.css 末尾（0018 口径：theme-fallback.test.tsx 用非贪婪正则抓 900px media block，
// 插在中间会撞捕获）。顶栏 JSX 内联 flex:'0 0 auto' 与 h1 内联样式的 DOM 侧锁由
// test/app/basket-pages.test.tsx 既有工具条断言覆盖，此处不重复造。

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(__dirname, '../../src/app/theme.css'), 'utf-8');

/** 0063 区段锚点（追加在文件末尾，唯一） */
const ANCHOR = '0063（R-067 / D-077）：排版页顶栏卡片 + 工具条菜单';
/** 既有 0018 锚点：0063 区段必须晚于它（末尾追加纪律） */
const LATE_ANCHOR = '0018 目检返工一';
const section = css.slice(css.indexOf(ANCHOR));

describe('0063：theme.css 顶栏卡片块在场 + 0060 内滚段退役（D-077③）', () => {
  it('0063 区段存在且追加在 theme.css 末尾（晚于 0018 锚点）', () => {
    expect(css).toContain(ANCHOR);
    expect(section.length).toBeGreaterThan(0);
    expect(css.indexOf(ANCHOR)).toBeGreaterThan(css.indexOf(LATE_ANCHOR));
  });

  it('新顶栏卡片块：.compose-toolbar flex 布局 + 卡片皮肤（--card 底/细线边/圆角 12/浅阴影）', () => {
    expect(section).toMatch(/\.compose-toolbar\s*\{[^}]*display:\s*flex/);
    expect(section).toMatch(/\.compose-toolbar\s*\{[^}]*background:\s*var\(--card\)/);
    expect(section).toMatch(/\.compose-toolbar\s*\{[^}]*border:\s*1px solid var\(--line\)/);
    expect(section).toMatch(/\.compose-toolbar\s*\{[^}]*border-radius:\s*12px/);
    expect(section).toMatch(/\.compose-toolbar\s*\{[^}]*box-shadow:/);
  });

  it('退役判据：[data-testid="compose-toolbar-actions"] 不再有 overflow-x:auto（内滚段删除）', () => {
    expect(css).not.toMatch(/\[data-testid="compose-toolbar-actions"\]\s*\{[^}]*overflow-x:\s*auto/);
  });

  it('配方保留：actions 直属按钮 flex:0 0 auto + white-space:nowrap（0060 段平移，五操作位防折行保险）', () => {
    expect(css).toMatch(/\[data-testid="compose-toolbar-actions"\]\s*>\s*button\s*\{[^}]*flex:\s*0\s+0\s+auto/);
    expect(css).toMatch(/\[data-testid="compose-toolbar-actions"\]\s*>\s*button\s*\{[^}]*white-space:\s*nowrap/);
  });
});
