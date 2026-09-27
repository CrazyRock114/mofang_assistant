// 0028 P2：素材入口取值层 + 分类（任务书 §四：文件分类——图/PDF 降级提示/不支持类型、粘贴板取图）
// @vitest-environment jsdom

import { describe, it, expect } from 'vitest';
import {
  classifyMaterials, isImageMaterial, isPdfMaterial, MATERIAL_MAX_BYTES, MATERIAL_MAX_PAGES,
  PDF_SPLIT_REDIRECT_NOTICE,
} from '../../src/recog/material.js';
import {
  filesFromDrop, filesFromInput, filesFromPaste, filesToMaterials, pastedFileName, withExtension,
} from '../../src/app/recog/intake.js';

const cand = (name: string, type = '', size = 1024) => ({ name, type, size });

describe('0028 P2：素材分类（图 / PDF 降级 / 不支持）', () => {
  it('图片按 mime 或扩展名收下（mime 缺失时扩展名兜底）', () => {
    expect(isImageMaterial(cand('a.png', 'image/png'))).toBe(true);
    expect(isImageMaterial(cand('a.JPG'))).toBe(true);
    expect(isImageMaterial(cand('a.jpeg', 'image/jpeg'))).toBe(true);
    expect(isImageMaterial(cand('截图', 'image/png'))).toBe(true);
    // 扩展名对但 mime 是非图片 → 不收（mime 可信时以 mime 为准）
    expect(isImageMaterial(cand('a.png', 'application/pdf'))).toBe(false);
  });

  it('PDF 转交切题工作区（0036 上线后不再是降级路径）', () => {
    expect(isPdfMaterial(cand('卷.pdf'))).toBe(true);
    expect(isPdfMaterial(cand('卷', 'application/pdf'))).toBe(true);
    const r = classifyMaterials([cand('卷.pdf', 'application/pdf'), cand('页1.png', 'image/png')]);
    expect(r.pdf.map((p) => p.name)).toEqual(['卷.pdf']);
    expect(r.accepted.map((p) => p.name)).toEqual(['页1.png']);
    // 文案单源：指向工作区入口（渲染层与主进程拒绝时用同一句）
    expect(PDF_SPLIT_REDIRECT_NOTICE).toContain('PDF 切题录题');
  });

  it('不支持类型给明确理由（不静默丢）', () => {
    const r = classifyMaterials([cand('笔记.txt', 'text/plain'), cand('卷.docx')]);
    expect(r.accepted).toEqual([]);
    expect(r.rejected).toHaveLength(2);
    expect(r.rejected[0].reason).toContain('不支持的文件类型');
    expect(r.rejected[0].name).toBe('笔记.txt');
  });

  it('超大图与超页数分别拒绝并给理由', () => {
    const big = classifyMaterials([cand('big.png', 'image/png', MATERIAL_MAX_BYTES + 1)]);
    expect(big.rejected[0].reason).toContain('过大');

    const many = Array.from({ length: MATERIAL_MAX_PAGES + 3 }, (_, i) => cand(`p${i + 1}.png`, 'image/png'));
    const r = classifyMaterials(many);
    expect(r.accepted).toHaveLength(MATERIAL_MAX_PAGES);
    expect(r.rejected).toHaveLength(3);
    expect(r.rejected[0].reason).toContain(`${MATERIAL_MAX_PAGES} 页上限`);
  });

  it('页序=入参顺序（不排序猜测）', () => {
    const r = classifyMaterials([cand('c.png', 'image/png'), cand('a.png', 'image/png'), cand('b.png', 'image/png')]);
    expect(r.accepted.map((x) => x.name)).toEqual(['c.png', 'a.png', 'b.png']);
  });
});

describe('0028 P2：三入口取值', () => {
  it('拖拽取 DataTransfer.files（图片与 PDF 都收，分类交给分类器）', () => {
    const png = new File([new Uint8Array([1])], 'a.png', { type: 'image/png' });
    const pdf = new File([new Uint8Array([1])], 'a.pdf', { type: 'application/pdf' });
    expect(filesFromDrop({ files: [png, pdf] })).toEqual([png, pdf]);
    expect(filesFromDrop(null)).toEqual([]);
    expect(filesFromDrop({})).toEqual([]);
  });

  it('Ctrl+V 只取图片项：跳过文字/HTML，且取不到 File 的项不报错', () => {
    const img = new File([new Uint8Array([2])], '', { type: 'image/png' });
    const items = [
      { kind: 'string', type: 'text/plain', getAsFile: () => null },
      { kind: 'file', type: 'text/html', getAsFile: () => null },
      { kind: 'file', type: 'image/png', getAsFile: () => img },
    ];
    expect(filesFromPaste({ items })).toEqual([img]);
    expect(filesFromPaste(null)).toEqual([]);
    expect(filesFromPaste({ items: [{ kind: 'file', type: 'image/png', getAsFile: () => null }] })).toEqual([]);
  });

  it('点选取 FileList；空/缺省 → 空数组', () => {
    const a = new File([new Uint8Array([3])], 'a.png', { type: 'image/png' });
    expect(filesFromInput([a])).toEqual([a]);
    expect(filesFromInput(null)).toEqual([]);
  });

  it('无名来源补名与扩展名（粘贴截图）', async () => {
    expect(pastedFileName(1)).toBe('粘贴图片-1.png');
    expect(withExtension('粘贴图片-1', 'image/png')).toBe('粘贴图片-1.png');
    expect(withExtension('a.jpg', 'image/jpeg')).toBe('a.jpg'); // 已有扩展名不动
    expect(withExtension('未知来源', 'application/octet-stream')).toBe('未知来源');

    const img = new File([new Uint8Array([1, 2, 3])], '', { type: 'image/png' });
    const [material] = await filesToMaterials([img], [pastedFileName(1)]);
    expect(material.name).toBe('粘贴图片-1.png');
    expect(material.mime).toBe('image/png');
    expect(material.dataBase64).toBe(Buffer.from([1, 2, 3]).toString('base64'));
  });

  it('base64 往返无损（含 >0x8000 字节的分块路径）', async () => {
    const bytes = new Uint8Array(0x8000 + 17).map((_, i) => i % 251);
    const img = new File([bytes], 'big.png', { type: 'image/png' });
    const [material] = await filesToMaterials([img]);
    expect(Buffer.from(material.dataBase64, 'base64').equals(Buffer.from(bytes))).toBe(true);
  });
});
