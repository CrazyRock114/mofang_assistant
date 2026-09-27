/**
 * 0007 P1：预览注入运行时虚拟模块插件（vite + vitest 共用）。
 * 0007 P2：同一打包逻辑导出 buildPreviewFrameRuntimeText()，并在 vite build 的 buildEnd
 * 落盘 dist/app/preview-frame-runtime.iife.js——主进程导出链路（shell/ipc.ts doc.exportPdf
 * 页化分支）在隐藏窗 executeJavaScript 该文本跑同一套测量+装箱（预览=导出单一实现）。
 *
 * 单一来源：src/app/pages/preview-frame-runtime.js（含 ./paginate.js 装箱单源），
 * 经 esbuild 打包为 IIFE 文本；注入/导出/测试三方共用，禁手工复制（D0 smoke 漂移教训）。
 * esbuild 为 vite 既有传递依赖（build-capture-inject.mjs 同先例），零新增 npm 依赖。
 */
import { buildSync } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export const PREVIEW_FRAME_RUNTIME_ID = 'virtual:preview-frame-runtime';
const RESOLVED_ID = '\0' + PREVIEW_FRAME_RUNTIME_ID;

/** 主进程消费路径（dist/shell/ipc.js 相对 ../app/ 读取） */
export const PREVIEW_FRAME_RUNTIME_DIST = join(root, 'dist', 'app', 'preview-frame-runtime.iife.js');

/** esbuild 打包注入运行时 → IIFE 文本（charset utf8：缺省 ascii 会把中文转 \u 转义，文本锚点断言受损） */
export function buildPreviewFrameRuntimeText() {
  const result = buildSync({
    entryPoints: [join(root, 'src/app/pages/preview-frame-runtime.js')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    charset: 'utf8',
    write: false,
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

export function previewFrameRuntimePlugin() {
  let isBuild = false;
  return {
    name: 'mofang-preview-frame-runtime',
    configResolved(config) {
      isBuild = config.command === 'build';
    },
    resolveId(id) {
      return id === PREVIEW_FRAME_RUNTIME_ID ? RESOLVED_ID : null;
    },
    load(id) {
      if (id !== RESOLVED_ID) return null;
      return `export default ${JSON.stringify(buildPreviewFrameRuntimeText())};`;
    },
    buildEnd() {
      // vite build 时落盘 dist 供主进程导出链路读取；dev server 场景失败静默（主进程始终跑构建产物）
      try {
        mkdirSync(dirname(PREVIEW_FRAME_RUNTIME_DIST), { recursive: true });
        writeFileSync(PREVIEW_FRAME_RUNTIME_DIST, buildPreviewFrameRuntimeText(), 'utf-8');
      } catch (err) {
        if (isBuild) throw err;
      }
    },
  };
}
