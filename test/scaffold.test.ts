import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const at = (rel: string) => join(root, rel);

describe('M0 Task 1 工程脚手架', () => {
  it('必备文件全部存在', () => {
    const required = [
      'package.json',
      'tsconfig.json',
      'tsconfig.main.json',
      'tsconfig.renderer.json',
      'vite.config.ts',
      'vitest.config.ts',
      'index.html',
      'src/shell/main.ts',
      'src/shell/preload.ts',
      'src/app/main.tsx',
    ];
    for (const rel of required) {
      expect(existsSync(at(rel)), `缺少文件: ${rel}`).toBe(true);
    }
  });

  it('package.json scripts 明确区分构建/测试/启动/冒烟', () => {
    const pkg = JSON.parse(readFileSync(at('package.json'), 'utf8'));
    const scripts = pkg.scripts ?? {};
    for (const name of ['build:renderer', 'build:main', 'build', 'test', 'start', 'smoke']) {
      expect(scripts[name], `缺少 script: ${name}`).toBeTypeOf('string');
    }
    // 固定 vitest run，避免 Windows shell glob 差异
    expect(scripts.test).toBe('vitest run');
  });

  it('tsconfig.main.json 真实产出 dist/shell', () => {
    const cfg = JSON.parse(readFileSync(at('tsconfig.main.json'), 'utf8'));
    expect(cfg.compilerOptions.outDir).toBe('dist');
    expect(cfg.include).toContain('src/shell');
  });

  it('vite.config.ts 将 renderer 构建到 dist/renderer', () => {
    const src = readFileSync(at('vite.config.ts'), 'utf8');
    expect(src).toContain('dist/renderer');
  });

  it('index.html 以 /src/app/main.tsx 为入口', () => {
    const html = readFileSync(at('index.html'), 'utf8');
    expect(html).toContain('/src/app/main.tsx');
  });
});
