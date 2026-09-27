// 0010-merge P1.1：裸控件兜底外观验收（Lane A 兜底块移植 theme.css 后生效性）
// jsdom 计算样式断言（jsdom 支持样式表级联；var() 不解析但声明可见——变量色部分做源级断言）：
// .main 内裸 button/input 有兜底观感；挂 .btn 的按钮不被兜底覆盖（:not([class]) 天然排除）；
// table 刻意不兜底（题面 HTML 表格在 .main 内，泛化会给内容物染色——纪律注释保留）。
// @vitest-environment jsdom

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const themeCss = readFileSync(resolve(process.cwd(), 'src/app/theme.css'), 'utf-8');

let style: HTMLStyleElement | null = null;
let host: HTMLDivElement | null = null;

function mount(): HTMLDivElement {
  style = document.createElement('style');
  style.textContent = themeCss;
  document.head.appendChild(style);
  host = document.createElement('div');
  host.className = 'main';
  document.body.appendChild(host);
  return host;
}

afterEach(() => {
  style?.remove();
  style = null;
  host?.remove();
  host = null;
});

describe('0010-merge P1.1 裸控件兜底（.main 内未挂 class 控件获得暖纸观感）', () => {
  it('裸 button：兜底字阶/内边距/圆角生效（jsdom 计算样式）', () => {
    const main = mount();
    const bare = document.createElement('button');
    main.appendChild(bare);
    const cs = getComputedStyle(bare);
    expect(cs.fontSize).toBe('13px');
    expect(cs.paddingTop).toBe('6px');
    expect(cs.paddingLeft).toBe('12px');
    // 圆角声明来自兜底块（var() 在 jsdom 不解析，原样透传即为「该规则已命中」的证据）
    expect(cs.borderRadius).toContain('var(--radius-sm)');
  });

  it('变量色走主题变量：兜底块 border/background/focus 环为 --line-strong/--card/--picked-ring（源级断言）', () => {
    // jsdom 不解析 var()——变量取值正确性由三主题变量表 + 用户目检保证，此处锁定规则形态
    expect(themeCss).toMatch(/\.main button:not\(\[class\]\)\s*\{[^}]*border:\s*1px solid var\(--line-strong\)/);
    expect(themeCss).toMatch(/\.main button:not\(\[class\]\)\s*\{[^}]*background:\s*var\(--card\)/);
    expect(themeCss).toMatch(/\.main input:not\(\[class\]\):focus[\s\S]{0,120}?box-shadow:\s*0 0 0 3px var\(--picked-ring\)/);
  });

  it('挂 .btn 的按钮不被兜底覆盖（:not([class]) 排除；padding 保持 .btn 自身的 7px 14px）', () => {
    const main = mount();
    const btned = document.createElement('button');
    btned.className = 'btn';
    main.appendChild(btned);
    const cs = getComputedStyle(btned);
    expect(cs.paddingTop).toBe('7px');
    expect(cs.paddingLeft).toBe('14px');
    // 与兜底值（6px 12px）不同——兜底规则未命中
    expect(cs.paddingTop).not.toBe('6px');
  });

  it('裸 input/select/textarea：兜底字阶 13px 生效', () => {
    const main = mount();
    for (const tag of ['input', 'select', 'textarea'] as const) {
      const el = document.createElement(tag);
      main.appendChild(el);
      expect(getComputedStyle(el).fontSize).toBe('13px');
    }
    // checkbox/radio 不在兜底范围（选择器显式排除）
    const check = document.createElement('input');
    check.type = 'checkbox';
    main.appendChild(check);
    expect(getComputedStyle(check).fontSize).not.toBe('13px');
  });

  it('table 刻意不兜底（无 padding 染色）+ 纪律注释保留', () => {
    const main = mount();
    const table = document.createElement('table');
    main.appendChild(table);
    expect(Number.parseFloat(getComputedStyle(table).paddingTop)).toBe(0);
    expect(themeCss).toContain('刻意**不**兜底 table');
  });

  it('兜底块完整移植：hover/disabled/focus/placeholder 规则齐备（源级断言）', () => {
    expect(themeCss).toMatch(/\.main button:not\(\[class\]\):hover:not\(:disabled\)/);
    expect(themeCss).toMatch(/\.main button:not\(\[class\]\):disabled/);
    expect(themeCss).toMatch(/\.main select:not\(\[class\]\):focus/);
    expect(themeCss).toMatch(/\.main textarea:not\(\[class\]\):focus/);
    expect(themeCss).toMatch(/\.main ::placeholder\s*\{[^}]*var\(--ink-3\)/);
  });
});

describe('0014 题库页两栏布局（.bank-layout 接线 + 全仓首个窄窗降级 media query）', () => {
  it('两栏 grid：左栏 240–280px 档 + 右栏 1fr（theme.css .bank-layout 实际接线）', () => {
    expect(themeCss).toMatch(/\.bank-layout\s*\{[^}]*display:\s*grid/);
    expect(themeCss).toMatch(/\.bank-layout\s*\{[^}]*grid-template-columns:\s*(2[4-7]\d)px\s+1fr/);
  });

  it('窄窗降级：@media screen and (max-width: 900px) 内 .bank-layout 降单列（类断言，不测像素）', () => {
    const mq = themeCss.match(/@media\s+screen\s+and\s+\(max-width:\s*900px\)\s*\{[\s\S]*?\}\s*\}/);
    expect(mq).not.toBeNull();
    expect(mq![0]).toMatch(/\.bank-layout\s*\{[^}]*grid-template-columns:\s*1fr/);
  });
});

describe('0014 目检返工二：题库页全高布局（头部固定仅列表滚动）+ 图片灯箱', () => {
  it('.bank-page 全高 flex 列；bank-main 分固定头与滚动体；窄窗 media 降级恢复页面滚动', () => {
    expect(themeCss).toMatch(/\.bank-page\s*\{[^}]*display:\s*flex/);
    expect(themeCss).toMatch(/\.bank-page\s*\{[^}]*height:\s*calc\(100vh/);
    // 返工三：flex 链三层连通（bank-browser-root 中间层不接链则整页仍滚——返工二目检实证）
    expect(themeCss).toMatch(/\.bank-page\s+\.bank-browser-root\s*\{[^}]*flex:\s*1/);
    expect(themeCss).toMatch(/\.bank-page\s+\.bank-layout\s*\{[^}]*flex:\s*1/);
    // 返工四：grid 行高钉死为容器高（默认 auto 由内容决定，树展开后左栏顶破固定层随整页滚）
    expect(themeCss).toMatch(/\.bank-page\s+\.bank-layout\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\)/);
    expect(themeCss).toMatch(/\.bank-page\s+\.bank-side,\s*\.bank-page\s+\.bank-main\s*\{[^}]*min-height:\s*0/);
    expect(themeCss).toMatch(/\.bank-main\s*\{[^}]*flex-direction:\s*column/);
    expect(themeCss).toMatch(/\.bank-main-scroll\s*\{[^}]*overflow-y:\s*auto/);
    // 左栏树面板：撑满左栏、节点列表占满余量内滚（展开大分支自身滚动）
    expect(themeCss).toMatch(/\.bank-page\s+\.bank-side\s+\.card\s*\{[^}]*max-height:\s*100%/);
    expect(themeCss).toMatch(/\.bank-page\s+\.bank-side-tree\s*\{[^}]*flex:\s*1/);
    const mq = themeCss.match(/@media\s+screen\s+and\s+\(max-width:\s*900px\)\s*\{[\s\S]*?\}\s*\}/);
    expect(mq![0]).toMatch(/\.bank-page\s*\{[^}]*height:\s*auto/);
    expect(mq![0]).toMatch(/grid-template-rows:\s*auto/);
  });

  it('灯箱样式：fixed 全屏遮罩 + 大图 92vw/90vh 封顶', () => {
    expect(themeCss).toMatch(/\.image-lightbox\s*\{[^}]*position:\s*fixed/);
    expect(themeCss).toMatch(/\.image-lightbox\s+img\s*\{[^}]*max-width:\s*92vw/);
    expect(themeCss).toMatch(/\.image-lightbox\s+img\s*\{[^}]*max-height:\s*90vh/);
  });

  it('选篮弹窗卡片：basket-pick-card 边框卡 + 选中高亮 + 长名截断 + 列表内滚', () => {
    expect(themeCss).toMatch(/\.basket-pick-card\s*\{[^}]*border:\s*1px solid/);
    expect(themeCss).toMatch(/\.basket-pick-card\.selected[^{]*\{[^}]*border-color:\s*var\(--orange\)/);
    expect(themeCss).toMatch(/\.basket-pick-title\s*\{[^}]*text-overflow:\s*ellipsis/);
    expect(themeCss).toMatch(/\.basket-pick-list\s*\{[^}]*overflow-y:\s*auto/);
  });
});
