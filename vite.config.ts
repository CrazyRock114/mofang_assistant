import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
// 0007 P1：预览注入运行时虚拟模块（esbuild 打包 preview-frame-runtime.js 为文本）
import { previewFrameRuntimePlugin } from './scripts/preview-frame-runtime-plugin.mjs';

export default defineConfig({
  plugins: [react(), previewFrameRuntimePlugin()],
  base: './',
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
      },
    },
  },
});
