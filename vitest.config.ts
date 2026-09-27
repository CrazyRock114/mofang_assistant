import { defineConfig } from 'vitest/config';
// 0007 P1：预览注入运行时虚拟模块（paginate-dom 测试经 injectPreviewScript 触达）
import { previewFrameRuntimePlugin } from './scripts/preview-frame-runtime-plugin.mjs';

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  plugins: [previewFrameRuntimePlugin()],
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'node',
  },
});
