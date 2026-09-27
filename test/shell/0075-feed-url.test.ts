// 0075 A6：更新通道 feed URL 可用性守卫（纯函数）。
// 背景（任务书 §零.1 阻断级发现）：开源构建 MF_DIST_BASE 置空后 MF_UPDATE_FEED_URL 退化为相对路径
// '/dl/'，electron-updater GenericProvider 构造 new URL('/dl/') 抛 TypeError 且无 try/catch → 打包态无主窗。
// 守卫口径（任务书 §一 A6）：feed URL 非 http(s) 绝对地址时不构造生产 adapter，降级 not-available。
import { describe, it, expect } from 'vitest';
import { isUsableFeedUrl } from '../../src/shell/update/feed-url.js';

describe('isUsableFeedUrl（feed URL 非 http(s) 绝对地址 → false）', () => {
  it('空串 → false', () => {
    expect(isUsableFeedUrl('')).toBe(false);
  });

  it('相对路径（端点常量置空退化形态 /dl/）→ false', () => {
    expect(isUsableFeedUrl('/dl/')).toBe(false);
  });

  it('相对路径（无前导斜杠）→ false', () => {
    expect(isUsableFeedUrl('dl/')).toBe(false);
  });

  it('file: 协议 → false', () => {
    expect(isUsableFeedUrl('file:///D:/dist/dl/')).toBe(false);
  });

  it('ftp: 协议 → false', () => {
    expect(isUsableFeedUrl('ftp://example.com/dl/')).toBe(false);
  });

  it('https 绝对地址 → true', () => {
    expect(isUsableFeedUrl('https://dist.example.com/dl/')).toBe(true);
  });

  it('http 绝对地址 → true', () => {
    expect(isUsableFeedUrl('http://localhost:8080/dl/')).toBe(true);
  });
});
