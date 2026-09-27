// 0006 P4：组卷整卷 URL 识别矩阵（通路入口第一道闸）

import { describe, it, expect } from 'vitest';
import { parseZujuanPaperUrl, ZUJUAN_PAPER_URL_HINT } from '../../src/capture/papers/paper-url.js';

describe('parseZujuanPaperUrl', () => {
  it('识别标准整卷详情页 URL（bankId 从 URL 前缀取，与 meta.bankid 同源）', () => {
    expect(parseZujuanPaperUrl('https://zujuan.xkw.com/4p2338916.html')).toEqual({
      bankId: '4',
      paperId: '2338916',
      url: 'https://zujuan.xkw.com/4p2338916.html',
    });
  });

  it('接受 http 与 www. 前缀；query/hash 不影响识别（url 归一为无 query 形态）', () => {
    expect(parseZujuanPaperUrl('http://zujuan.xkw.com/13p123456.html')).toMatchObject({ bankId: '13', paperId: '123456' });
    expect(parseZujuanPaperUrl('https://www.zujuan.xkw.com/4p2338916.html')).toMatchObject({ bankId: '4', paperId: '2338916' });
    expect(parseZujuanPaperUrl('https://zujuan.xkw.com/4p2338916.html?from=share#x')).toEqual({
      bankId: '4',
      paperId: '2338916',
      url: 'https://zujuan.xkw.com/4p2338916.html',
    });
  });

  it('两端空白可容忍（用户从地址栏复制常带空白）', () => {
    expect(parseZujuanPaperUrl('  https://zujuan.xkw.com/4p2338916.html \n')).toMatchObject({ bankId: '4', paperId: '2338916' });
  });

  it('非整卷形态一律拒绝：站点不符/移动站/知识点页/裸域/无 html/缺 bankId/缺 paperId', () => {
    const rejects = [
      '',
      '   ',
      'https://www.jyeoo.com/physics2/ques/detail/abc',
      'https://mzujuan.xkw.com/4p2338916.html',
      'https://zujuan.xkw.com/zsd18194/x4o2/',
      'https://zujuan.xkw.com/',
      'https://zujuan.xkw.com/4p2338916',
      'https://zujuan.xkw.com/p2338916.html',
      'https://zujuan.xkw.com/4p.html',
      'https://zujuan.xkw.com/4p2338916.html/',
      'https://evil.com/4p2338916.html',
      'not a url',
    ];
    for (const input of rejects) {
      expect(parseZujuanPaperUrl(input), input).toBeNull();
    }
    expect(parseZujuanPaperUrl(undefined as unknown as string)).toBeNull();
    expect(parseZujuanPaperUrl(123 as unknown as string)).toBeNull();
  });

  it('拒绝提示文案明确指向支持形态', () => {
    expect(ZUJUAN_PAPER_URL_HINT).toContain('zujuan.xkw.com');
    expect(ZUJUAN_PAPER_URL_HINT).toContain('{bankId}p{paperId}.html');
  });
});
