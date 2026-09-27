import { describe, it, expect } from 'vitest';
import { normalizeStem, isStemMatch } from '../../src/capture/adapters/stem-match.js';

describe('normalizeStem', () => {
  it('应移除全角括号和空白', () => {
    const stem = '（1）一物体从高处下落，   求速度。';
    const normalized = normalizeStem(stem);

    expect(normalized).not.toContain('（');
    expect(normalized).not.toContain('）');
    expect(normalized).not.toMatch(/\s{2,}/);
  });

  it('应移除题号前缀变体', () => {
    const stems = [
      '1. 题干内容',
      '1、题干内容',
      '（1）题干内容',
      '【1】题干内容',
      'A. 题干内容',
    ];

    stems.forEach((stem) => {
      const normalized = normalizeStem(stem);
      expect(normalized).toContain('题干内容');
      expect(normalized).not.toMatch(/^[1A][\.\、]/);
      expect(normalized).not.toMatch(/^[（【]/);
    });
  });

  it('应统一空白符为单空格', () => {
    const stem = '题干\n内容\t测试';
    const normalized = normalizeStem(stem);

    expect(normalized).toBe('题干 内容 测试');
  });

  it('应移除前后空白', () => {
    const stem = '  题干内容  ';
    const normalized = normalizeStem(stem);

    expect(normalized).toBe('题干内容');
  });
});

describe('isStemMatch', () => {
  it('应匹配归一化后相同的题干', () => {
    const basketStem = '（1）一物体从高处下落，求速度。';
    const detailStem = '1. 一物体从高处下落， 求速度。';

    expect(isStemMatch(basketStem, detailStem)).toBe(true);
  });

  it('应匹配详情页题干包含篮内题干前缀', () => {
    const basketStem = '一物体从高处下落';
    const detailStem = '一物体从高处下落，经过时间 t 落地，求末速度。';

    expect(isStemMatch(basketStem, detailStem)).toBe(true);
  });

  it('应拒绝不匹配的题干（防串题）', () => {
    const basketStem = '一物体从高处下落';
    const detailStem = '一小球沿斜面滚下';

    expect(isStemMatch(basketStem, detailStem)).toBe(false);
  });

  it('应拒绝错位 id 导致的题干不匹配', () => {
    const basketStem = '计算电路电阻';
    const detailStem = '求物体加速度';

    expect(isStemMatch(basketStem, detailStem)).toBe(false);
  });

  it('应容忍全角半角标点差异', () => {
    const basketStem = '题干，内容（测试）。';
    const detailStem = '题干,内容(测试).';

    expect(isStemMatch(basketStem, detailStem)).toBe(true);
  });
});


describe('D1-fix R-6：实站误杀形态回归（真实库 61fd/09bb 取证复现）', () => {
  it('行内图标签边界空白不对称不应误杀：篮内 img→空格 vs 详情页 textContent 无空格', () => {
    // 真实库 09bb 形态：篮内 stemHtml 行内公式图经 htmlToText 变为空格
    const basketStem = '一本质量为 的书平放在水平桌面上，将一张A4纸夹在书页间';
    // 详情页 textContent：img 无文本，两侧文字直接相连
    const detailStem = '一本质量为的书平放在水平桌面上，将一张A4纸夹在书页间，如图所示。';

    expect(isStemMatch(basketStem, detailStem)).toBe(true);
  });

  it('带空格题号前缀（"1 . "真实库 61fd 形态）应剥除后匹配', () => {
    const basketStem = '1 . 北京时间2023年9月21日15时48分，“天宫课堂”第四课在中国空间站开讲';
    const detailStem = '北京时间2023年9月21日15时48分，“天宫课堂”第四课在中国空间站开讲，演示了动量守恒等实验。';

    expect(isStemMatch(basketStem, detailStem)).toBe(true);
  });

  it('空白不对称修正不放松防串题：无关题干仍拒绝', () => {
    const basketStem = '一本质量为 的书平放在水平桌面上';
    const detailStem = '一小球沿斜面由静止滚下，求加速度。';

    expect(isStemMatch(basketStem, detailStem)).toBe(false);
  });

  it('篮内题干为空不得匹配任何详情页题干（防串题加固）', () => {
    expect(isStemMatch('', '一物体从高处下落，求速度。')).toBe(false);
  });
});
