// 0006-P4-fix-1 P3：裂图形态判定（纯函数；ingest dup 分支的修复性回填以此为准）
import { describe, it, expect } from 'vitest';
import { hasBrokenImageRefs } from '../../src/capture/assets.js';

describe('hasBrokenImageRefs（裂图形态判定）', () => {
  it('data-assets 下的 `.html` 资产引用 = 损坏（WAF 挑战页被当图落盘后的形态）', () => {
    expect(hasBrokenImageRefs('<p>【答案】C</p><img src="data-assets/capture/zujuan/34066870-3.html">')).toBe(true);
    expect(hasBrokenImageRefs("<img src='data-assets/capture/jyeoo/q123-2.html'>")).toBe(true);
  });

  it('mzujuan 错误域公式图 src = 损坏（下载失败后未改写的死链）', () => {
    expect(hasBrokenImageRefs('<img src="https://mzujuan.xkw.com/Upload/formula/b57f6047e618345b8809478e08fd7935.png">')).toBe(true);
  });

  it('健康形态不为损坏：本地真图资产 / CDN 绝对 URL / 无图文 / 空字段', () => {
    expect(hasBrokenImageRefs('<img src="data-assets/capture/zujuan/34066870-1.svg">')).toBe(false);
    expect(hasBrokenImageRefs('<img src="https://staticzujuan.xkw.com/quesimg/Upload/formula/a3e8b5e08812f92622f79e7b17a5a78d.png">')).toBe(false);
    expect(hasBrokenImageRefs('<p>纯文本答案</p>')).toBe(false);
    expect(hasBrokenImageRefs('')).toBe(false);
    expect(hasBrokenImageRefs(undefined)).toBe(false);
  });

  it('不误伤同片段：多段后缀资产（`.html.png`）与站点页面链接（`.html` 超链接）不判损坏', () => {
    expect(hasBrokenImageRefs('<img src="data-assets/capture/zujuan/q-1.html.png">')).toBe(false);
    expect(hasBrokenImageRefs('<a href="https://zujuan.xkw.com/13p3314701.html">原卷</a>')).toBe(false);
    expect(hasBrokenImageRefs('<a href="https://mzujuan.xkw.com/help">移动站</a>')).toBe(false);
  });
});
