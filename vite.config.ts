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
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
      },
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/mathlive')) {
            return 'mathlive';
          }
          if (id.includes('node_modules/@tiptap') || id.includes('node_modules/prosemirror')) {
            return 'tiptap';
          }
          if (id.includes('node_modules/katex')) {
            return 'katex';
          }
          if (id.includes('node_modules/pdfjs-dist')) {
            return 'pdfjs';
          }
          if (id.includes('node_modules/docx')) {
            return 'docx';
          }
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom')) {
            return 'react-vendor';
          }
        },
      },
    },
  },
});
