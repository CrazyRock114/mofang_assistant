/**
 * 构建采集注入 bundle：src/capture/browser/inject-entry.ts → dist/capture/inject.js（IIFE）
 *
 * 单一来源：页内注入脚本与主进程/测试共用 src/capture 纯函数实现，
 * 由此脚本打包生成，禁止在冒烟/主进程里手工复制提取逻辑（D0 smoke 漂移坏味道）。
 * esbuild 为 vite 既有传递依赖，不新增 npm 依赖。
 *
 * 0012 P2：toolbar-preload 构建段退役——顶部采集栏改为主窗 React 顶部栏（CapturePage cap-bar），
 * 内嵌 view 不再挂任何 preload（inject.js 构建保留，单一来源不动）。
 */

import { build } from 'esbuild';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

await build({
  entryPoints: [join(root, 'src/capture/browser/inject-entry.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  outfile: join(root, 'dist/capture/inject.js'),
  logLevel: 'warning',
});

console.log('OK   build-capture-inject → dist/capture/inject.js');
