// Phase 3: smoke-pdf — 验证 PDF 导出功能（使用 MockBankService 预置数据）

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

try {
  const electronBin = require('electron');

  // 清理旧的 tmp-smoke 目录
  const tmpSmokeDir = 'tmp-smoke';
  if (existsSync(tmpSmokeDir)) {
    rmSync(tmpSmokeDir, { recursive: true, force: true });
  }

  console.log('启动 Electron 进行 PDF 冒烟测试（--smoke-pdf 模式）...');

  // 启动 Electron --smoke-pdf，超时 180 秒（本机空闲实测整程约 89 秒，五探针全跑；
  // 并发跑其它 lane 时曾 >120 秒 ETIMEDOUT，故留 2 倍余量）
  execFileSync(electronBin, ['.', '--smoke-pdf'], {
    encoding: 'utf8',
    timeout: 180000,
    stdio: 'inherit',
  });

  // 检查是否生成了 PDF（在实际实现中，smoke-pdf 模式应该自动生成测试 PDF）
  // 这里先检查退出码 0 即可，实际文件检查在 smoke-pdf 模式内部完成

  console.log('OK   smoke-pdf 通过（Electron 启动且正常退出）');
  process.exit(0);
} catch (err) {
  console.error('FAIL smoke-pdf 未通过:', err.message);
  process.exit(1);
}
