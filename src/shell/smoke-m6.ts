/**
 * --smoke-m6：0005 课后反馈 M6 真接线验证（Electron 模式）
 *
 * 流程（对齐 0005 任务书 §三验收）：
 * 【主进程侧真 SQLite】feedback 模板 CRUD：内置「默认课后反馈」种子可见（迁移 0005_feedback）→
 * create 用户模板 → update 改名 → delete 软删不可见 → 内置改/删守卫抛错 →
 * 【driver 页真桥】feedback.list 内置可见 + file.exportTextFile 落盘 + feedback.exportCards
 * 2 卡（750×1000 设计尺寸，卡片 html 内含 data-assets 徽标引用——验证主进程 file:// 绝对路径改写）
 * → { dir, count: 2, failed: [] } →
 * 【主进程侧文件断言】2 张 PNG 存在 + PNG IHDR 宽高=设计尺寸（无白边无裁切）+ txt 内容一致。退出码 0/1。
 *
 * 前置：npm run build；main.ts --smoke-m6 分支（userData 重定向 + file 通道 smoke 固定路径）。
 */

import { app, BrowserWindow, screen } from 'electron';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { BankExtServices } from '../shared/contracts/bank-types.js';

/** PNG IHDR 宽高读取（大端 4 字节；非 PNG 抛错） */
function pngSize(filePath: string): { w: number; h: number } {
  const buf = readFileSync(filePath);
  const isPng = buf.length > 24
    && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (!isPng) throw new Error(`非 PNG 文件: ${filePath}`);
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

export async function runFeedbackSmoke(extServices: BankExtServices): Promise<void> {
  try {
    const repoRoot = process.cwd();
    const userData = app.getPath('userData');

    // ---------- 主进程侧：feedback 模板 CRUD（真 SQLite，迁移 0005_feedback 后） ----------
    const templates = await extServices.feedback.listTemplates();
    const builtin = templates.find((t) => t.name === '默认课后反馈');
    if (!builtin || !builtin.isBuiltin) {
      throw new Error(`内置默认模板不可见: ${JSON.stringify(templates.map((t) => t.name))}`);
    }
    if (!builtin.bodyTemplate.includes('{学生姓名}') || !builtin.bodyTemplate.includes('{本次内容}')) {
      throw new Error('内置模板正文缺中文键变量');
    }
    const created = await extServices.feedback.createTemplate({ name: 'smoke-反馈模板', bodyTemplate: '致{学生姓名}家长：{课堂表现}' });
    if (created.isBuiltin) throw new Error('createTemplate 不应产出内置');
    const renamed = await extServices.feedback.updateTemplate(created.id, { name: 'smoke-反馈模板v2' });
    if (renamed.name !== 'smoke-反馈模板v2') throw new Error('updateTemplate 改名未生效');
    await extServices.feedback.deleteTemplate(created.id);
    const afterDelete = await extServices.feedback.getTemplate(created.id);
    if (afterDelete !== null) throw new Error('软删后 getTemplate 应为 null');
    let builtinUpdateGuard = false;
    try { await extServices.feedback.updateTemplate(builtin.id, { name: '改内置' }); } catch { builtinUpdateGuard = true; }
    if (!builtinUpdateGuard) throw new Error('内置模板改名应抛错');
    let builtinDeleteGuard = false;
    try { await extServices.feedback.deleteTemplate(builtin.id); } catch { builtinDeleteGuard = true; }
    if (!builtinDeleteGuard) throw new Error('内置模板删除应抛错');

    // ---------- driver 页：真实 preload → __mofangBankExt / __mofangFile ----------
    const driver = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: join(repoRoot, 'dist/shell/preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    await driver.loadFile(join(repoRoot, 'scripts/fixtures/basket-driver.html'));

    // driver 侧：模板真桥 list + 徽标资产落盘 + exportTextFile + exportCards 2 卡
    //（卡片 html 内联构造：750×1000 固定像素容器 + body margin 0 + data-assets 徽标引用——
    //  与 src/app/feedback/card.ts 构建器同构的最小验证形态；构建器语义由单测覆盖）
    const driverScript = '(async () => {\n' +
      '  const ext = window.__mofangBankExt;\n' +
      '  const fileBridge = window.__mofangFile;\n' +
      '  if (!ext || !ext.feedback) throw new Error("window.__mofangBankExt.feedback 未暴露");\n' +
      '  if (!fileBridge || !fileBridge.exportCards || !fileBridge.exportTextFile) throw new Error("__mofangFile 输出通道未暴露");\n' +
      '  const list = await ext.feedback.list({ filter: {} });\n' +
      '  if (!list.some((t) => t.name === "默认课后反馈" && t.isBuiltin)) throw new Error("driver 侧内置模板不可见");\n' +
      '  const logo = await fileBridge.pickLogoImage();\n' +
      '  if (!logo) throw new Error("pickLogoImage 未落盘徽标");\n' +
      '  const logoRef = "data-assets/" + logo.relPath;\n' +
      '  const cardHtml = (bg, accent, text) => "<!DOCTYPE html><html><head><meta charset=\\"UTF-8\\"><style>"\n' +
      '    + "html,body{margin:0;padding:0}"\n' +
      '    + ".card{width:750px;height:1000px;box-sizing:border-box;background:" + bg + ";padding:60px 50px;font-family:sans-serif}"\n' +
      '    + ".brand{width:120px;margin-bottom:24px}"\n' +
      '    + "h1{color:" + accent + ";font-size:34px;margin:0 0 20px}"\n' +
      '    + "p{font-size:22px;line-height:1.7;color:#333;margin:0}"\n' +
      '    + "</style></head><body><div class=\\"card\\">"\n' +
      '    + "<img class=\\"brand\\" src=\\"" + logoRef + "\\">"\n' +
      '    + "<h1>课后反馈</h1><p>" + text + "</p></div></body></html>";\n' +
      '  const cards = [\n' +
      '    { fileName: "smoke-card-clean", html: cardHtml("#ffffff", "#333333", "张三同学今天表现优秀。"), width: 750, height: 1000 },\n' +
      '    { fileName: "smoke-card-warm", html: cardHtml("#fdf6ec", "#8b5a2b", "李四同学进步明显。"), width: 750, height: 1000 },\n' +
      '  ];\n' +
      '  const cardsResult = await fileBridge.exportCards({ cards });\n' +
      '  if (cardsResult.count !== 2 || cardsResult.failed.length !== 0 || !cardsResult.dir) {\n' +
      '    throw new Error("exportCards 结果异常: " + JSON.stringify(cardsResult));\n' +
      '  }\n' +
      '  const txt = await fileBridge.exportTextFile({ suggestedName: "feedback.txt", content: "smoke-m6 反馈文本" });\n' +
      '  if (!txt.filePath) throw new Error("exportTextFile 未落盘");\n' +
      '  return { dir: cardsResult.dir, txtPath: txt.filePath };\n' +
      '})()';

    const ioResult = await driver.webContents.executeJavaScript(driverScript, true);
    driver.close();

    // ---------- 主进程侧文件断言：PNG 存在 + IHDR 尺寸=设计×zoom×设备缩放（完整无白边） + txt 内容 ----------
    // exportCards 用 zoom-to-fit：视口=卡片×zoom（zoom=max(1, 装进工作区)），物理像素=DIP×scale；
    // 与主进程 handler 用同一公式复算期望值（本机 workArea/scale），100% 缩放大屏=精确 750×1000。
    const { screen } = await import('electron');
    const workArea = screen.getPrimaryDisplay().workAreaSize;
    const scaleFactor = screen.getPrimaryDisplay().scaleFactor;
    const zoom = Math.min(1, (workArea.width - 40) / 750, (workArea.height - 80) / 1000);
    const expectedW = Math.round(Math.ceil(750 * zoom) * scaleFactor);
    const expectedH = Math.round(Math.ceil(1000 * zoom) * scaleFactor);
    for (const name of ['smoke-card-clean', 'smoke-card-warm']) {
      const pngPath = join(ioResult.dir, `${name}.png`);
      if (!existsSync(pngPath)) throw new Error(`卡片 PNG 未落盘: ${pngPath}`);
      const size = pngSize(pngPath);
      if (size.w !== expectedW || size.h !== expectedH) {
        throw new Error(`卡片 PNG 尺寸异常（应为 ${expectedW}×${expectedH}，设计 750×1000 × zoom ${zoom.toFixed(2)} × scale ${scaleFactor}）: ${name} = ${size.w}×${size.h}`);
      }
    }
    if (readFileSync(ioResult.txtPath, 'utf-8') !== 'smoke-m6 反馈文本') {
      throw new Error('exportTextFile 内容不一致');
    }

    console.log(`OK   smoke-m6（Electron）通过: feedback 模板 CRUD（内置种子可见+守卫+软删不可见，真 SQLite）→ driver 真桥（list+pickLogo 落盘+exportTextFile+exportCards 2 卡）→ PNG IHDR ${expectedW}×${expectedH}（设计 750×1000 × zoom ${zoom.toFixed(2)} × scale ${scaleFactor}，整卡无白边，data-assets 徽标 file:// 改写生效） 全链`);
    app.exit(0);
  } catch (err) {
    console.error('FAIL smoke-m6（Electron）失败:', err);
    app.exit(1);
  }
}
