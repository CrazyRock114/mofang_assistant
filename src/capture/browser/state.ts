/**
 * 站点识别与登录态检测（纯函数）
 */

import type { CaptureSite } from '../../shared/contracts/capture-types.js';

/**
 * 根据 URL 识别站点
 */
export function detectSite(url: string): CaptureSite | null {
  try {
    const hostname = new URL(url).hostname.toLowerCase();

    if (hostname.endsWith('xkw.com')) {
      return 'zujuan';
    }

    if (hostname.endsWith('jyeoo.com')) {
      return 'jyeoo';
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * 检测登录态（基于页面 HTML 特征）
 */
export function detectLoggedIn(url: string, html: string): boolean {
  const site = detectSite(url);

  if (!site || !html) {
    return false;
  }

  switch (site) {
    case 'zujuan':
      // zujuan 登录特征：首页有"我的存档"/"我的下载"链接
      return html.includes('我的存档') || html.includes('我的下载') || html.includes('/my/archive');

    case 'jyeoo':
      // jyeoo 登录特征：用户菜单"退出"链接（实站快照实证 account/logoff）或"我的菁优"相关
      return (
        html.includes('account/logoff') ||
        html.includes('我的菁优') ||
        html.includes('/user/center') ||
        html.includes('user-info')
      );

    default:
      return false;
  }
}
