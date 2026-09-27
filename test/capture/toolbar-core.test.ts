import { describe, it, expect } from 'vitest';
import {
  updateNavStack,
  canGoBack,
  canGoForward,
  normalizeInputUrl,
  formatExtractNotice,
  CAPTURE_QUICK_LINKS,
} from '../../src/capture/browser/toolbar-core.js';

describe('updateNavStack — 采集窗导航历史栈（D1-fix-2 F-6）', () => {
  it('首次加载：空栈 → 压入当前页，不可后退/前进', () => {
    const s = updateNavStack(null, 'https://zujuan.xkw.com/');
    expect(s).toEqual({ stack: ['https://zujuan.xkw.com/'], index: 0 });
    expect(canGoBack(s)).toBe(false);
    expect(canGoForward(s)).toBe(false);
  });

  it('新导航：截断前向分支并压入，可后退不可前进', () => {
    let s = updateNavStack(null, 'https://a.com/');
    s = updateNavStack(s, 'https://b.com/');
    expect(s.stack).toEqual(['https://a.com/', 'https://b.com/']);
    expect(s.index).toBe(1);
    expect(canGoBack(s)).toBe(true);
    expect(canGoForward(s)).toBe(false);
  });

  it('刷新（栈顶同 href）：栈与指针不动', () => {
    let s = updateNavStack(null, 'https://a.com/');
    s = updateNavStack(s, 'https://b.com/');
    const r = updateNavStack(s, 'https://b.com/');
    expect(r).toEqual(s);
  });

  it('后退后落前一项：指针回移，可前进', () => {
    let s = updateNavStack(null, 'https://a.com/');
    s = updateNavStack(s, 'https://b.com/');
    const r = updateNavStack(s, 'https://a.com/');
    expect(r.index).toBe(0);
    expect(canGoBack(r)).toBe(false);
    expect(canGoForward(r)).toBe(true);
  });

  it('后退后导航新页：前向分支被截断', () => {
    let s = updateNavStack(null, 'https://a.com/');
    s = updateNavStack(s, 'https://b.com/');
    s = updateNavStack(s, 'https://a.com/'); // 后退
    const r = updateNavStack(s, 'https://c.com/'); // 新导航
    expect(r.stack).toEqual(['https://a.com/', 'https://c.com/']);
    expect(r.index).toBe(1);
    expect(canGoForward(r)).toBe(false);
  });

  it('损坏状态（stack 为空数组）按首访处理', () => {
    const s = updateNavStack({ stack: [], index: 0 }, 'https://a.com/');
    expect(s).toEqual({ stack: ['https://a.com/'], index: 0 });
  });
});

describe('normalizeInputUrl — 地址栏输入归一化', () => {
  it('完整 URL 原样通过', () => {
    expect(normalizeInputUrl('https://zujuan.xkw.com/13q31576438.html'))
      .toBe('https://zujuan.xkw.com/13q31576438.html');
  });

  it('缺协议自动补 https://', () => {
    expect(normalizeInputUrl('zujuan.xkw.com')).toBe('https://zujuan.xkw.com/');
    expect(normalizeInputUrl('  www.jyeoo.com  ')).toBe('https://www.jyeoo.com/');
  });

  it('空输入 / 非 http(s) 协议 → null', () => {
    expect(normalizeInputUrl('')).toBeNull();
    expect(normalizeInputUrl('   ')).toBeNull();
    expect(normalizeInputUrl('javascript:alert(1)')).toBeNull();
  });
});

describe('CAPTURE_QUICK_LINKS', () => {
  it('含组卷网与菁优网入口', () => {
    const labels = CAPTURE_QUICK_LINKS.map((l) => l.label);
    expect(labels).toContain('组卷网');
    expect(labels).toContain('菁优网');
    for (const l of CAPTURE_QUICK_LINKS) expect(l.url).toMatch(/^https:\/\//);
  });
});

describe('formatExtractNotice — 控件条「提取试题篮」结果提示（D1-fix-3 L-2）', () => {
  it('成功：提示题数 + 回主窗入库指引', () => {
    expect(formatExtractNotice(3)).toBe('已提取 3 题，请回主窗点「入库」');
  });

  it('0 题：如实提示', () => {
    expect(formatExtractNotice(0)).toBe('已提取 0 题，请回主窗点「入库」');
  });
});
