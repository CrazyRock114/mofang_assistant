// M0 Task 1 最小冒烟：只验证脚手架可构建、Electron 二进制可启动。
// 完整冒烟（主窗口加载、SQLite 初始化、contextIsolation 校验、printToPDF 产物）
// 属 Task 5/6 范围，本轮明确不实现。
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let failed = false;

const artifacts = ['dist/renderer/index.html', 'dist/shell/main.js', 'dist/shell/preload.js'];
for (const rel of artifacts) {
  if (existsSync(rel)) {
    console.log(`OK   构建产物存在: ${rel}`);
  } else {
    console.error(`FAIL 缺少构建产物: ${rel}（请先运行 npm run build）`);
    failed = true;
  }
}

try {
  const electronBin = require('electron');
  const version = execFileSync(electronBin, ['--version'], { encoding: 'utf8' }).trim();
  console.log(`OK   Electron 二进制可启动: ${version}`);
} catch (err) {
  console.error('FAIL Electron 二进制无法启动:', err.message);
  failed = true;
}

if (failed) {
  console.error('smoke 未通过');
  process.exit(1);
}
console.log('smoke 通过（Task 1 范围：构建产物 + Electron 可启动；完整冒烟待 Task 6）');
