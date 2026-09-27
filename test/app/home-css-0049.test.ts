// 0049 P4：home.css 静态守卫 —— 作用域收敛 + 三主题热力色阶方向（任务书 §P4）。
// 背景：home.css 是全局样式表，类名沿用设计稿（.card/.hero/.notice-warm 等与全局同名），
// 一旦漏掉 `.home-v3` 前缀就会外溢污染其它页；热力图色阶方向反了（夜航变浅底深墨）是设计稿
// 明确点名的红线。两件事都无法由 jsdom 组件测试覆盖（jsdom 不跑层叠），故在文本层钉桩。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const homeCss = readFileSync(join(__dirname, '../../src/app/home.css'), 'utf-8');
const mainTsx = readFileSync(join(__dirname, '../../src/app/main.tsx'), 'utf-8');
const themeCss = readFileSync(join(__dirname, '../../src/app/theme.css'), 'utf-8');

/** 去掉注释后的规则体（按 } 切块，便于逐块检查选择器） */
function ruleBlocks(css: string): string[] {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('}')
    .map((b) => b.trim())
    .filter((b) => b.includes('{'));
}

/** 取某主题块内的变量值 */
function themeVar(css: string, theme: 'warm' | 'light' | 'dark', name: string): string | null {
  const start = css.indexOf(theme === 'warm' ? ':root,\n:root[data-theme="warm"]' : `:root[data-theme="${theme}"]`);
  if (start < 0) return null;
  const block = css.slice(start, css.indexOf('}', start));
  const m = block.match(new RegExp(`${name}:\\s*([^;]+);`));
  return m ? m[1]!.trim() : null;
}

describe('0049 P4：home.css 作用域与热力色阶', () => {
  it('main.tsx 引入 home.css（全局生效，pages 级样式独立文件先例）', () => {
    expect(mainTsx).toContain("import './home.css'");
  });

  it('除 :root 变量块外，全部规则以 .home-v3 作用域收敛（防外溢到其它页）', () => {
    const offenders = ruleBlocks(homeCss).filter((block) => {
      const selector = block.slice(0, block.indexOf('{')).trim();
      return !selector.split(',').every((s) => s.trim().startsWith('.home-v3') || s.trim().startsWith(':root'));
    });
    expect(offenders, `未加 .home-v3 前缀的规则：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('三主题各有 --heat0~4 五档（色阶变量不全 = 局部主题下热力图失色）', () => {
    for (const theme of ['warm', 'light', 'dark'] as const) {
      for (let i = 0; i <= 4; i++) {
        expect(themeVar(homeCss, theme, `--heat${i}`), `${theme} --heat${i}`).toBeTruthy();
      }
    }
  });

  it('夜航档位方向不反：透明度递增（0.08 < 0.16 < 0.34 < 0.58 < 0.88）', () => {
    const alphas = Array.from({ length: 5 }, (_, i) => {
      const v = themeVar(homeCss, 'dark', `--heat${i}`)!;
      const m = v.match(/rgba\([^)]*,\s*([\d.]+)\s*\)/);
      expect(m, `--heat${i} 应为 rgba（透明度递增叙事）：${v}`).toBeTruthy();
      return Number(m![1]);
    });
    for (let i = 1; i < alphas.length; i++) expect(alphas[i]!).toBeGreaterThan(alphas[i - 1]!);
  });

  it('浅底主题（暖纸/澄光）档位由浅到深：--heat4 明显深于 --heat1（亮度递减）', () => {
    const luma = (hex: string) => {
      const m = hex.trim().match(/^#([0-9a-f]{6})$/i);
      expect(m, `应为十六进制色：${hex}`).toBeTruthy();
      const n = Number.parseInt(m![1]!, 16);
      return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    };
    for (const theme of ['warm', 'light'] as const) {
      const ramp = [1, 2, 3, 4].map((i) => luma(themeVar(homeCss, theme, `--heat${i}`)!));
      for (let i = 1; i < ramp.length; i++) {
        expect(ramp[i]!, `${theme} --heat${i + 1} 应深于 --heat${i}`).toBeLessThan(ramp[i - 1]!);
      }
    }
  });

  it('theme.css 本单零改动：--heat* 只出现在 home.css（避让纪律）', () => {
    expect(themeCss).not.toContain('--heat');
    expect(themeCss).not.toContain('home-v3');
  });
});
