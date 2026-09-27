// 0011 §一.7：hash 导航小工具单测 —— withFrom 拼接 / resolveBackHref 白名单 / hashSearchOf；
// PageHeader backHref 动态化（string | (() => string)，不破坏既有字符串调用点）。
// @vitest-environment jsdom

import { describe, it, expect } from 'vitest';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

import { withFrom, resolveBackHref, hashSearchOf, backLabelOf } from '../../src/app/utils/nav.js';
import { PageHeader } from '../../src/app/pages/ExtUi.js';

describe('0011 nav.withFrom：from 参数拼接', () => {
  it('无 query → ?from= 拼接', () => {
    expect(withFrom('#/capture', 'basket/p1')).toBe('#/capture?from=basket/p1');
  });

  it('已有 query → &from= 追加（篮详情→采集接点形态）', () => {
    expect(withFrom('#/capture?toBasket=p1', 'basket/p1'))
      .toBe('#/capture?toBasket=p1&from=basket/p1');
    expect(withFrom('#/capture?toBasket=p9', 'compose/p9'))
      .toBe('#/capture?toBasket=p9&from=compose/p9');
  });

  it('空 from / 非内部路由形态（外链）→ 原样返回，不拼外链', () => {
    expect(withFrom('#/capture', '')).toBe('#/capture');
    expect(withFrom('#/capture', 'https://evil.example')).toBe('#/capture');
    expect(withFrom('#/capture?toBasket=p1', '')).toBe('#/capture?toBasket=p1');
  });
});

describe('0011 nav.resolveBackHref：白名单解析（防开放跳转）', () => {
  it('合法内部 from → #/<from>（自动补 #/ 前缀）', () => {
    expect(resolveBackHref('?toBasket=p1&from=basket/p9', '#/papers')).toBe('#/basket/p9');
    expect(resolveBackHref('from=compose/c1', '#/papers')).toBe('#/compose/c1');
    expect(resolveBackHref('?from=basket/p9', '#/papers')).toBe('#/basket/p9');
  });

  it('无参数 / 空 from / 纯空白 → fallback', () => {
    expect(resolveBackHref('', '#/papers')).toBe('#/papers');
    expect(resolveBackHref('?toBasket=p1', '#/papers')).toBe('#/papers');
    expect(resolveBackHref('?from=', '#/papers')).toBe('#/papers');
    expect(resolveBackHref('?from=%20', '#/papers')).toBe('#/papers');
  });

  it('白名单：拒绝外链 scheme 与 query/可疑字符', () => {
    expect(resolveBackHref('?from=https://evil.example', '#/papers')).toBe('#/papers');
    expect(resolveBackHref('?from=http://evil.example/x', '#/papers')).toBe('#/papers');
    expect(resolveBackHref('?from=javascript:alert(1)', '#/papers')).toBe('#/papers');
    expect(resolveBackHref('?from=basket/p9?x=1', '#/papers')).toBe('#/papers');
    // 重复 from 取首现（URLSearchParams.get 语义），首现合法即按首现解析
    expect(resolveBackHref('?from=basket/p9&x=1&from=https://evil.example', '#/papers')).toBe('#/basket/p9');
  });
});

describe('0011 nav.hashSearchOf：hash query 拆取', () => {
  it('带 query 拆出；无 query 空串', () => {
    expect(hashSearchOf('#/capture?toBasket=p1&from=basket/p9')).toBe('toBasket=p1&from=basket/p9');
    expect(hashSearchOf('#/capture')).toBe('');
    expect(hashSearchOf('#/papers/p3')).toBe('');
  });
});

describe('0011-fix nav.backLabelOf：返回按钮指名（目检返工二）', () => {
  it('from=basket/* → 返回试题篮；from=compose/* → 返回排版', () => {
    expect(backLabelOf('?toBasket=p1&from=basket/p9')).toBe('返回试题篮');
    expect(backLabelOf('?toBasket=p1&from=compose/c1')).toBe('返回排版');
  });

  it('无 from / 非法 from → 返回组卷（fallback 落组卷列表）', () => {
    expect(backLabelOf('')).toBe('返回组卷');
    // 0036：整串 hash 直接传入也认（hashSearchOf 容错，防「href 对、文案兜底」静默出错）
    expect(backLabelOf('#/proof/run-1?from=split/abc')).toBe('返回切题项目');
    expect(backLabelOf('?from=split/abc')).toBe('返回切题项目');
    expect(backLabelOf('#/capture?from=basket/p9')).toBe('返回试题篮');
    expect(backLabelOf('?toBasket=p1')).toBe('返回组卷');
    expect(backLabelOf('?from=https://evil.example')).toBe('返回组卷');
  });
});

describe('0011 PageHeader backHref 动态化', () => {
  it('backHref 支持函数形态；字符串形态不受影响', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    flushSync(() => root.render(<PageHeader title="组卷" backHref={() => '#/papers/p3'} />));
    expect(container.querySelector('a.page-back')!.getAttribute('href')).toBe('#/papers/p3');
    flushSync(() => root.render(<PageHeader title="组卷" backHref="#/papers" />));
    expect(container.querySelector('a.page-back')!.getAttribute('href')).toBe('#/papers');
    flushSync(() => root.render(<PageHeader title="组卷" />));
    expect(container.querySelector('a.page-back')).toBeNull();
    root.unmount();
    container.remove();
  });

  it('0011-fix backLabel：返回文案可定制（组卷各页统一「← 返回试卷列表」），缺省仍「← 返回」', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    flushSync(() => root.render(<PageHeader title="试题篮" backHref="#/papers" backLabel="返回试卷列表" />));
    expect(container.querySelector('a.page-back')!.textContent).toBe('← 返回试卷列表');
    flushSync(() => root.render(<PageHeader title="试题篮" backHref="#/papers" />));
    expect(container.querySelector('a.page-back')!.textContent).toBe('← 返回');
    root.unmount();
    container.remove();
  });
});
