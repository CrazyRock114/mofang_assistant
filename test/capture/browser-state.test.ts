import { describe, it, expect } from 'vitest';
import { detectLoggedIn, detectSite } from '../../src/capture/browser/state.js';

describe('detectSite', () => {
  it('应识别 zujuan 站点（*.xkw.com 学科网系）', () => {
    expect(detectSite('https://zujuan.xkw.com')).toBe('zujuan');
    expect(detectSite('https://sub.xkw.com/path')).toBe('zujuan');
  });

  it('裸域 zujuan.com（第三方组卷易/在线组卷网）不应误判为学科网系 zujuan', () => {
    expect(detectSite('https://www.zujuan.com')).toBeNull();
  });

  it('应识别 jyeoo 站点（*.jyeoo.com）', () => {
    expect(detectSite('https://www.jyeoo.com')).toBe('jyeoo');
    expect(detectSite('https://math.jyeoo.com')).toBe('jyeoo');
  });

  it('应返回 null 当不在已知站点', () => {
    expect(detectSite('https://example.com')).toBeNull();
    expect(detectSite('https://google.com')).toBeNull();
    expect(detectSite('about:blank')).toBeNull();
  });
});

describe('detectLoggedIn', () => {
  it('应检测 zujuan 登录态：首页有"我的存档"链接', () => {
    const html = `
      <html>
        <body>
          <nav>
            <a href="/my/archive">我的存档</a>
            <a href="/my/download">我的下载</a>
          </nav>
        </body>
      </html>
    `;

    expect(detectLoggedIn('https://zujuan.xkw.com', html)).toBe(true);
  });

  it('应检测 zujuan 未登录：无登录特征', () => {
    const html = `
      <html>
        <body>
          <nav>
            <a href="/login">登录</a>
          </nav>
        </body>
      </html>
    `;

    expect(detectLoggedIn('https://zujuan.xkw.com', html)).toBe(false);
  });

  it('应检测 jyeoo 登录态：有用户头像或"我的"链接', () => {
    const html = `
      <html>
        <body>
          <div class="user-info">
            <a href="/user/center">我的菁优</a>
          </div>
        </body>
      </html>
    `;

    expect(detectLoggedIn('https://www.jyeoo.com', html)).toBe(true);
  });

  it('jyeoo 登录态实站锚定（D1-fix-3）：退出登录链接 account/logoff', () => {
    // 实站快照实证：已登录页用户菜单含 <a href="https://www.jyeoo.com/account/logoff">退出</a>
    const html = `<html><body><div class="profile-fd"><a href="https://www.jyeoo.com/account/logoff">退出</a></div></body></html>`;
    expect(detectLoggedIn('https://www.jyeoo.com', html)).toBe(true);
  });

  it('应返回 false 当站点未知', () => {
    const html = `<html><body><a href="/my">我的</a></body></html>`;

    expect(detectLoggedIn('https://example.com', html)).toBe(false);
  });

  it('应容忍 DOM 内容为空', () => {
    expect(detectLoggedIn('https://zujuan.xkw.com', '')).toBe(false);
  });
});
