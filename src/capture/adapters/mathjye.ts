/**
 * MathJye 渲染后 div 汤 → TeX 启发式重建（D1-fix-3 J-1）
 *
 * 实站取证：菁优网公式由 mathJye.min.js 把原始 <math> 自定义标签消费成绝对定位
 * div 汤（类名词汇：mrow/mfrac(fracZi,fracLine,fracMu)/msubsup(msubsupCont,msub,msup)/
 * msqrt(msqrtSign,msqrtBox)/math-letter/mo/mnormal），原始源码不保留在 DOM。
 * 本模块按类名结构语义重建 TeX，未知结构回落 textContent（不丢内容）。
 *
 * 纯函数，浏览器/jsdom 双环境可执行（inject bundle 与 Node 测试共用），DOM 一律 any 化
 */

/** 直接子元素中按类名查找 */
function directChildByClass(el: any, cls: string): any | null {
  const children = el?.children || [];
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    if (String(c.className || '').split(/\s+/).includes(cls)) return c;
  }
  return null;
}

function texOfChildren(el: any): string {
  let out = '';
  const nodes = el?.childNodes || [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.nodeType === 3) out += node.textContent || '';
    else if (node.nodeType === 1) out += texOf(node);
  }
  return out;
}

function texOf(el: any): string {
  const cls = String(el.className || '');

  // 分数：\frac{分子}{分母}；fracLine 为分数线，无内容
  if (/\bmfrac\b/.test(cls)) {
    const zi = directChildByClass(el, 'fracZi');
    const mu = directChildByClass(el, 'fracMu');
    return `\\frac{${zi ? texOfChildren(zi) : ''}}{${mu ? texOfChildren(mu) : ''}}`;
  }
  if (/\bfracLine\b/.test(cls)) return '';

  // 上下标一体：msubsupCont 为底，msub/msup 为直接子级（实站实证可各自缺省）
  if (/\bmsubsup\b/.test(cls)) {
    const base = directChildByClass(el, 'msubsupCont');
    const sub = directChildByClass(el, 'msub');
    const sup = directChildByClass(el, 'msup');
    let out = base ? texOfChildren(base) : '';
    if (sub) out += `_{${texOfChildren(sub)}}`;
    if (sup) out += `^{${texOfChildren(sup)}}`;
    return out;
  }

  // 根式：msqrtBox 为被开方内容（msqrtSign 为根号图形，无内容）
  if (/\bmsqrt\b/.test(cls)) {
    const box = directChildByClass(el, 'msqrtBox');
    return `\\sqrt{${box ? texOfChildren(box) : ''}}`;
  }
  if (/\bmsqrtSign\b/.test(cls)) return '';

  // mrow/mnormal/math-letter/mo 及未知类：递归拼接（未知结构不丢内容）
  return texOfChildren(el);
}

/** 单个 .MathJye 根元素 → TeX 字符串 */
export function mathJyeRootToTex(root: any): string {
  return texOfChildren(root).trim();
}

/**
 * 容器内所有 .MathJye 公式块原位替换为 <span class="math" data-tex="...">
 * （与既有公式管线一致：renderMath 消费 span.math[data-tex] → KaTeX）
 */
export function replaceMathJyeWithTex(container: any): void {
  if (!container) return;
  const roots: any[] = Array.from(container.querySelectorAll('.MathJye'));
  for (const root of roots) {
    const tex = mathJyeRootToTex(root).replace(/"/g, "'").replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const span = container.ownerDocument.createElement('span');
    span.setAttribute('class', 'math');
    span.setAttribute('data-tex', tex);
    root.parentNode.replaceChild(span, root);
  }
}
