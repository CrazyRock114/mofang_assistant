// 0066 可运维性一期（R-002）：--smoke-diag 自证出口
//
// 真链：真渲染页（真 preload）→ 点「导出诊断包」→ 真 IPC 通道 → 真组装 → zip 产物，
// 产物落盘后在本模块做**白名单**核验（只许 manifest.json + logs/*）与排除清单核验，
// 最后打印包内文件树 + manifest 摘要 + 核验结论。退出码由 main.ts 决定（0=PASS / 1=FAIL）。

import { app, BrowserWindow } from 'electron';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readZip } from '../guard/zip-utils.js';

export interface DiagSmokeReport {
  path: string;
  entries: string[];
  checks: string[];
}

/** 包内只允许出现的路径（白名单：比黑名单更强的合规断言） */
const ALLOWED_ENTRY = /^(manifest\.json|logs\/[A-Za-z0-9._-]+)$/;
/** 内容级禁词：题库原库进包必现的标记（sqlite 文件头 / 建表语句 / 登录态分区名） */
const FORBIDDEN_CONTENT = ['SQLite format 3', 'CREATE TABLE', 'Partitions', 'key_encrypted'];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runDiagSmoke(opts: {
  userDataPath: string;
  dataDir: string;
  outputPath: string;
}): Promise<DiagSmokeReport> {
  const checks: string[] = [];
  mkdirSync(dirname(opts.outputPath), { recursive: true });

  const driver = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    webPreferences: {
      // 0022 打包教训：资源定位一律 app.getAppPath()（开发=仓库根，打包=asar 根）
      preload: join(app.getAppPath(), 'dist/shell/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: [`--mofang-user-data=${opts.userDataPath}`],
    },
  });

  try {
    await driver.loadFile(join(process.cwd(), 'dist', 'renderer', 'index.html'));
    await driver.webContents.executeJavaScript(`
      location.hash = '#/settings';
      'routed';
    `);
    await sleep(1200);

    const clicked = await driver.webContents.executeJavaScript(`
      (() => {
        const btn = document.querySelector('[data-testid="settings-diagnostics-export"]');
        if (!btn) return { clicked: false, reason: '未找到导出按钮（诊断卡未渲染）' };
        btn.click();
        return { clicked: true, label: btn.textContent };
      })()
    `);
    if (!clicked.clicked) throw new Error(`诊断卡不可用：${clicked.reason}`);

    // 等成功横幅（真链：IPC 返回 → React 状态 → banner）
    let banner: { type: string | null; text: string } | null = null;
    for (let i = 0; i < 100; i++) {
      banner = await driver.webContents.executeJavaScript(`
        (() => {
          const el = document.querySelector('[data-testid="page-message"]');
          return el ? { type: el.getAttribute('data-type'), text: el.textContent } : null;
        })()
      `);
      if (banner) break;
      await sleep(200);
    }
    driver.close();

    if (!banner) throw new Error('点击「导出诊断包」后未出现结果横幅（真链未闭环）');
    checks.push(`渲染层结果横幅 ${banner.type}：${banner.text}`);
    if (banner.type !== 'success') throw new Error(`导出未成功：${banner.text}`);
    if (!banner.text.includes(opts.outputPath)) {
      throw new Error(`横幅未回显落盘路径（应含 ${opts.outputPath}）：${banner.text}`);
    }

    // ---------- 产物核验 ----------
    if (!existsSync(opts.outputPath)) throw new Error(`产物不存在：${opts.outputPath}`);
    const size = statSync(opts.outputPath).size;
    if (size === 0) throw new Error('产物为空文件');

    const entries = readZip(opts.outputPath);
    const paths = entries.map((entry) => entry.path);
    checks.push(`产物 ${opts.outputPath}（${size} 字节，${paths.length} 件）`);

    for (const entry of entries) {
      if (!ALLOWED_ENTRY.test(entry.path)) throw new Error(`白名单外条目：${entry.path}`);
    }
    checks.push(`白名单核验：全部条目 ∈ {manifest.json, logs/*}（${paths.join(', ')}）`);

    const manifestEntry = entries.find((entry) => entry.path === 'manifest.json');
    if (!manifestEntry) throw new Error('包内缺 manifest.json');
    const manifest = JSON.parse(manifestEntry.content.toString('utf8')) as Record<string, unknown>;
    for (const field of ['format', 'format_version', 'generated_at', 'app_version', 'electron_version', 'platform', 'arch', 'logs', 'db', 'excluded']) {
      if (!(field in manifest)) throw new Error(`manifest 缺字段：${field}`);
    }
    const stats = (manifest.db as { stats: Array<{ name: string; count: number }> }).stats;
    if (!Array.isArray(stats) || stats.length === 0) throw new Error('manifest.db.stats 为空（脱敏统计未采集）');
    checks.push(`manifest：format=${manifest.format} v${manifest.format_version} app=${manifest.app_version} electron=${manifest.electron_version} ${manifest.platform}/${manifest.arch} @${manifest.generated_at}`);
    checks.push(`脱敏统计：${stats.length} 张表行数（${stats.map((s) => `${s.name}=${s.count}`).join(' ')}）`);

    const appLog = entries.find((entry) => entry.path === 'logs/app.log');
    if (!appLog) throw new Error('包内缺 logs/app.log（本单新增日志未进包）');
    checks.push(`logs/app.log ${appLog.content.length} 字节（启动期日志已进包）`);

    const joined = Buffer.concat(entries.map((entry) => entry.content)).toString('utf8');
    const raw = readFileSync(opts.outputPath).toString('utf8');
    for (const word of FORBIDDEN_CONTENT) {
      if (joined.includes(word)) throw new Error(`包内容命中禁词「${word}」`);
      if (raw.includes(word)) throw new Error(`压缩流命中禁词「${word}」`);
    }
    checks.push(`排除清单核验：${FORBIDDEN_CONTENT.map((w) => `「${w}」0 命中`).join(' / ')}（解压面 + 原始字节面双查）`);

    const excluded = manifest.excluded as string[];
    checks.push(`manifest.excluded 自述 ${excluded.length} 条`);
    checks.push(`包内文件树：\n    ${paths.join('\n    ')}`);

    return { path: opts.outputPath, entries: paths, checks };
  } finally {
    if (!driver.isDestroyed()) driver.close();
  }
}
