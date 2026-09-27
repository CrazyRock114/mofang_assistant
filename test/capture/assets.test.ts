import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeExtension,
  assetRelativePath,
  assetDiskPath,
  rewriteImageSources,
  downloadQuestionImages,
  readImageDimensions,
  DATA_ASSETS_PREFIX,
} from '../../src/capture/assets.js';
import type { CapturedQuestion } from '../../src/shared/contracts/capture-types.js';

describe('normalizeExtension（POC 实证坑：扩展名归一）', () => {
  it('svg+xml → svg', () => {
    expect(normalizeExtension('image/svg+xml', 'https://x.com/a')).toBe('svg');
  });

  it('jpeg → jpg', () => {
    expect(normalizeExtension('image/jpeg', 'https://x.com/a')).toBe('jpg');
  });

  it('content-type 带参数也能取', () => {
    expect(normalizeExtension('image/png; charset=binary', 'https://x.com/a')).toBe('png');
  });

  it('content-type 缺失按 URL 后缀兜底', () => {
    expect(normalizeExtension(null, 'https://x.com/quiz/images/12345.PNG?x=1')).toBe('png');
    expect(normalizeExtension('', 'https://x.com/f.svg')).toBe('svg');
    expect(normalizeExtension(null, 'https://x.com/f.jpeg')).toBe('jpg');
  });

  it('两头都没有 → bin', () => {
    expect(normalizeExtension(null, 'https://x.com/getAnswerAndParse/abc')).toBe('bin');
  });
});

describe('assetRelativePath / assetDiskPath', () => {
  it('落盘约定：data-assets/capture/<site>/<questionId>-<idx>.<ext>（POSIX 相对路径）', () => {
    expect(assetRelativePath('zujuan', '13q987654', 1, 'png')).toBe(`${DATA_ASSETS_PREFIX}capture/zujuan/13q987654-1.png`);
    expect(assetRelativePath('jyeoo', 'tid888', 2, 'svg')).toBe(`${DATA_ASSETS_PREFIX}capture/jyeoo/tid888-2.svg`);
  });

  it('questionId 清洗文件系统不安全字符', () => {
    expect(assetRelativePath('jyeoo', 'a/b c:d', 1, 'png')).toBe(`${DATA_ASSETS_PREFIX}capture/jyeoo/a_b_c_d-1.png`);
  });

  it('diskPath 映射到 userData/data/assets 下', () => {
    const p = assetDiskPath('/ud/data', `${DATA_ASSETS_PREFIX}capture/zujuan/q-1.png`);
    expect(p.replace(/\\/g, '/')).toBe('/ud/data/assets/capture/zujuan/q-1.png');
  });
});

describe('rewriteImageSources', () => {
  it('img src 改写为本地相对路径（双引号/单引号）', () => {
    const html = '<p>题干</p><img src="https://img.xkw.com/a.png"><img src=\'https://img.xkw.com/b.svg\'>';
    const out = rewriteImageSources(html, [
      { origSrc: 'https://img.xkw.com/a.png', localPath: 'data-assets/capture/zujuan/q-1.png', role: 'content' },
      { origSrc: 'https://img.xkw.com/b.svg', localPath: 'data-assets/capture/zujuan/q-2.svg', role: 'content' },
    ]);
    expect(out).toContain('src="data-assets/capture/zujuan/q-1.png"');
    expect(out).toContain("src='data-assets/capture/zujuan/q-2.svg'");
    expect(out).not.toContain('https://img.xkw.com');
  });

  it('未命中的 src 保持不变', () => {
    const html = '<img src="https://other.com/x.png">';
    const out = rewriteImageSources(html, [
      { origSrc: 'https://img.xkw.com/a.png', localPath: 'data-assets/capture/zujuan/q-1.png', role: 'content' },
    ]);
    expect(out).toBe(html);
  });
});

describe('downloadQuestionImages', () => {
  function makeQ(images: CapturedQuestion['images']): CapturedQuestion {
    return {
      questionId: '13q987654',
      site: 'zujuan',
      sourceUrl: 'https://zujuan.xkw.com/basket',
      stemHtml: '<p>题干</p><img src="https://img.xkw.com/question/1.png">',
      options: [],
      answerHtml: '<img src="https://imzujuan.xkw.com/getAnswerAndParse/k1.png">',
      analysisHtml: '',
      images,
      meta: {},
      rect: null,
    };
  }

  it('同 session 下载 → 落盘 + 返回本地相对路径 + 改写 contentHtml/answerHtml 的 src', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'mofang-assets-'));
    try {
      // R-4 起下载层会读真实尺寸：PNG fixture 升级为完整 IHDR 头（300x200），不再是不含尺寸的 4 字节桩
      const pngBytes = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x01, 0x2c, 0x00, 0x00, 0x00, 0xc8,
        0x08, 0x06, 0x00, 0x00, 0x00,
      ]);
      const q = makeQ([
        { src: 'https://img.xkw.com/question/1.png', role: 'content' },
        { src: 'https://imzujuan.xkw.com/getAnswerAndParse/k1.png', role: 'answer' },
      ]);

      const fetchFn = async (url: string) => ({
        ok: true,
        status: 200,
        contentType: url.includes('getAnswerAndParse') ? null : 'image/png',
        bytes: pngBytes,
      });

      const { images, warnings } = await downloadQuestionImages(q, { dataRoot, fetchFn });

      // 第二张 content-type 缺失 → 按 URL 后缀兜底为 png，正文 PNG 魔数相符 → 照常落盘
      expect(warnings).toHaveLength(0);
      expect(images).toEqual([
        { localPath: `${DATA_ASSETS_PREFIX}capture/zujuan/13q987654-1.png`, origSrc: 'https://img.xkw.com/question/1.png', role: 'content', width: 300, height: 200 },
        { localPath: `${DATA_ASSETS_PREFIX}capture/zujuan/13q987654-2.png`, origSrc: 'https://imzujuan.xkw.com/getAnswerAndParse/k1.png', role: 'answer', width: 300, height: 200 },
      ]);

      // 文件真实落盘且字节一致
      const f1 = assetDiskPath(dataRoot, images[0].localPath);
      expect(existsSync(f1)).toBe(true);
      expect(new Uint8Array(readFileSync(f1))).toEqual(pngBytes);

      // 题干/答案 HTML 的 src 已改写本地相对路径
      expect(q.stemHtml).toContain(`src="${DATA_ASSETS_PREFIX}capture/zujuan/13q987654-1.png"`);
      expect(q.answerHtml).toContain(`src="${DATA_ASSETS_PREFIX}capture/zujuan/13q987654-2.png"`);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('单图失败降级 warning，其他图照常落盘', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'mofang-assets-'));
    try {
      const pngBytes = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x01, 0x2c, 0x00, 0x00, 0x00, 0xc8,
        0x08, 0x06, 0x00, 0x00, 0x00,
      ]);
      const q = makeQ([
        { src: 'https://img.xkw.com/question/1.png', role: 'content' },
        { src: 'https://img.xkw.com/question/2.png', role: 'content' },
      ]);
      const fetchFn = async (url: string) => {
        if (url.endsWith('/1.png')) throw new Error('network down');
        return { ok: true, status: 200, contentType: 'image/png', bytes: pngBytes };
      };

      const { images, warnings } = await downloadQuestionImages(q, { dataRoot, fetchFn });

      expect(images).toHaveLength(1);
      expect(images[0].origSrc).toBe('https://img.xkw.com/question/2.png');
      expect(warnings.some((w) => w.includes('1.png'))).toBe(true);
      // 失败图 src 保持远端
      expect(q.stemHtml).toContain('https://img.xkw.com/question/1.png');
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('HTTP 非 2xx → warning 不落盘', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'mofang-assets-'));
    try {
      const q = makeQ([{ src: 'https://img.xkw.com/question/1.png', role: 'content' }]);
      const fetchFn = async () => ({ ok: false, status: 403, contentType: null, bytes: new Uint8Array() });

      const { images, warnings } = await downloadQuestionImages(q, { dataRoot, fetchFn });

      expect(images).toHaveLength(0);
      expect(warnings.some((w) => w.includes('403'))).toBe(true);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});


describe('readImageDimensions（D1-fix R-4：真实像素尺寸解析，无第三方依赖）', () => {
  it('SVG：width/height 属性直读（zujuan 公式小图形态）', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="42" height="15"><text>x</text></svg>';
    expect(readImageDimensions(new TextEncoder().encode(svg), 'svg')).toEqual({ width: 42, height: 15 });
  });

  it('SVG：无 width/height 时回落 viewBox', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 480"><rect/></svg>';
    expect(readImageDimensions(new TextEncoder().encode(svg), 'svg')).toEqual({ width: 640, height: 480 });
  });

  it('SVG：小数宽度取整', () => {
    const svg = '<svg width="11.6" height="8.2"></svg>';
    expect(readImageDimensions(new TextEncoder().encode(svg), 'svg')).toEqual({ width: 12, height: 8 });
  });

  it('PNG：IHDR 头读宽高', () => {
    // 最小 PNG 头：8 字节签名 + IHDR length/type + width(300)/height(200) 大端
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x01, 0x2c, 0x00, 0x00, 0x00, 0xc8,
      0x08, 0x06, 0x00, 0x00, 0x00,
    ]);
    expect(readImageDimensions(png, 'png')).toEqual({ width: 300, height: 200 });
  });

  it('JPEG：SOF0 段读宽高', () => {
    // FFD8 + APP0(空) + SOF0: FFC0 len=17 precision=8 height=480 width=640
    const jpg = new Uint8Array([
      0xff, 0xd8,
      0xff, 0xe0, 0x00, 0x0e, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0x01, 0x11, 0x00,
    ]);
    expect(readImageDimensions(jpg, 'jpg')).toEqual({ width: 640, height: 480 });
  });

  it('无法解析（截断/未知格式）→ null', () => {
    expect(readImageDimensions(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'png')).toBeNull();
    expect(readImageDimensions(new Uint8Array([1, 2, 3]), 'bin')).toBeNull();
    expect(readImageDimensions(new TextEncoder().encode('<svg></svg>'), 'svg')).toBeNull();
  });
});

describe('downloadQuestionImages — 尺寸写入（R-4）', () => {
  function makeQ(images: CapturedQuestion['images']): CapturedQuestion {
    return {
      questionId: '13q111',
      site: 'zujuan',
      sourceUrl: 'https://zujuan.xkw.com/basket',
      stemHtml: '<p>题干</p><img src="https://img.xkw.com/f.svg">',
      options: [],
      answerHtml: '',
      analysisHtml: '',
      images,
      meta: {},
      rect: null,
    };
  }

  it('SVG 下载成功后读取真实像素宽高并随资产返回', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'mofang-assets-'));
    try {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="42" height="15"></svg>';
      const q = makeQ([{ src: 'https://img.xkw.com/f.svg', role: 'content' }]);
      const fetchFn = async () => ({ ok: true, status: 200, contentType: 'image/svg+xml', bytes: new TextEncoder().encode(svg) });

      const { images, warnings } = await downloadQuestionImages(q, { dataRoot, fetchFn });

      expect(images).toHaveLength(1);
      expect(images[0].width).toBe(42);
      expect(images[0].height).toBe(15);
      expect(warnings).toHaveLength(0);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('尺寸读不到 → warning + 资产不带宽高（归一化降级块级）', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'mofang-assets-'));
    try {
      const q = makeQ([{ src: 'https://img.xkw.com/f.svg', role: 'content' }]);
      const fetchFn = async () => ({ ok: true, status: 200, contentType: 'image/svg+xml', bytes: new TextEncoder().encode('<svg></svg>') });

      const { images, warnings } = await downloadQuestionImages(q, { dataRoot, fetchFn });

      expect(images).toHaveLength(1);
      expect(images[0].width).toBeUndefined();
      expect(images[0].height).toBeUndefined();
      expect(warnings.some((w) => w.includes('尺寸'))).toBe(true);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});

// 0006-P4-fix-1 P2：错误域的 WAF 挑战页（200 + text/html）曾被按 content-type 落成 `.html` 资产并改写 src，
// 把裂图伪装成本地资产。落盘前按 ①Content-Type ②扩展名白名单 ③魔数 校验，非图一律拒收（warning 记 URL + 判据）。
describe('downloadQuestionImages — 非图片响应拒绝（0006-P4-fix-1 P2：落盘前内容校验）', () => {
  const PNG_HEAD = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x01, 0x2c, 0x00, 0x00, 0x00, 0xc8,
    0x08, 0x06, 0x00, 0x00, 0x00,
  ]);
  const WAF_HTML = '<body onload="check()"> <input type="hidden" name="parm_0" value="x"></body>';

  function makeQ(src: string): CapturedQuestion {
    return {
      questionId: '13q987654',
      site: 'zujuan',
      sourceUrl: 'https://zujuan.xkw.com/4p2338916.html',
      stemHtml: '',
      options: [],
      answerHtml: `<img src="${src}">`,
      analysisHtml: '',
      images: [{ src, role: 'answer' }],
      meta: {},
      rect: null,
    };
  }

  it('① Content-Type 非 image/*（WAF 200 text/html 挑战页）→ 拒：不落盘 `.html`、不改写 src，warning 含 URL 与判据', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'mofang-assets-'));
    try {
      const src = 'https://mzujuan.xkw.com/Upload/formula/b57f6047e618345b8809478e08fd7935.png';
      const q = makeQ(src);
      const fetchFn = async () => ({
        ok: true,
        status: 200,
        contentType: 'text/html; charset=utf-8',
        bytes: new TextEncoder().encode(WAF_HTML),
      });

      const { images, warnings } = await downloadQuestionImages(q, { dataRoot, fetchFn });

      expect(images).toHaveLength(0);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(src.slice(0, 80));
      expect(warnings[0]).toContain('text/html');
      // 不落盘（`.html` 资产不再产生）、不改写 src（裂在明处）
      expect(existsSync(assetDiskPath(dataRoot, assetRelativePath('zujuan', '13q987654', 1, 'html')))).toBe(false);
      expect(q.answerHtml).toContain(src);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('② 扩展名不在图片白名单（无 Content-Type + URL 无后缀 → bin）→ 拒', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'mofang-assets-'));
    try {
      const src = 'https://imzujuan.xkw.com/getAnswerAndParse/k1';
      const q = makeQ(src);
      const fetchFn = async () => ({ ok: true, status: 200, contentType: null, bytes: PNG_HEAD });

      const { images, warnings } = await downloadQuestionImages(q, { dataRoot, fetchFn });

      expect(images).toHaveLength(0);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('bin');
      expect(existsSync(assetDiskPath(dataRoot, assetRelativePath('zujuan', '13q987654', 1, 'bin')))).toBe(false);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('③ 声明 image/png 但魔数不符 → 拒（WAF 页错标图片类型也不落盘）', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'mofang-assets-'));
    try {
      const src = 'https://mzujuan.xkw.com/Upload/formula/9340b4c890ef70a3385d021917fc6cf6.png';
      const q = makeQ(src);
      const fetchFn = async () => ({ ok: true, status: 200, contentType: 'image/png', bytes: new TextEncoder().encode(WAF_HTML) });

      const { images, warnings } = await downloadQuestionImages(q, { dataRoot, fetchFn });

      expect(images).toHaveLength(0);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('魔数');
      expect(existsSync(assetDiskPath(dataRoot, assetRelativePath('zujuan', '13q987654', 1, 'png')))).toBe(false);
      expect(q.answerHtml).toContain(src);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('真图但尺寸读不出仍落盘并降级 warning（既有语义保留：非图才拒）', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'mofang-assets-'));
    try {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
      const q = makeQ('https://staticzujuan.xkw.com/quesimg/Upload/formula/a7256efe9fcf5ea038c948b514e19b47.svg');
      const fetchFn = async () => ({ ok: true, status: 200, contentType: 'image/svg+xml', bytes: new TextEncoder().encode(svg) });

      const { images, warnings } = await downloadQuestionImages(q, { dataRoot, fetchFn });

      expect(images).toHaveLength(1);
      expect(existsSync(assetDiskPath(dataRoot, images[0].localPath))).toBe(true);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('尺寸不可读');
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('白名单内真图（png 后缀 + image/png + PNG 魔数）照常落盘', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'mofang-assets-'));
    try {
      const src = 'https://staticzujuan.xkw.com/quesimg/Upload/formula/a3e8b5e08812f92622f79e7b17a5a78d.png';
      const q = makeQ(src);
      const fetchFn = async () => ({ ok: true, status: 200, contentType: 'image/png; charset=binary', bytes: PNG_HEAD });

      const { images, warnings } = await downloadQuestionImages(q, { dataRoot, fetchFn });

      expect(images).toEqual([
        { localPath: `${DATA_ASSETS_PREFIX}capture/zujuan/13q987654-1.png`, origSrc: src, role: 'answer', width: 300, height: 200 },
      ]);
      expect(warnings).toHaveLength(0);
      expect(q.answerHtml).toContain(`${DATA_ASSETS_PREFIX}capture/zujuan/13q987654-1.png`);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
