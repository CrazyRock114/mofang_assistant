// 0007 P1：esbuild 虚拟模块类型声明（构建期打包文本，见 scripts/preview-frame-runtime-plugin.mjs）
declare module 'virtual:preview-frame-runtime' {
  /** preview-frame-runtime.js 的 esbuild IIFE 打包文本（含 paginate.js 装箱单源） */
  const runtimeText: string;
  export default runtimeText;
}
