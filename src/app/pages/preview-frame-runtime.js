// 0007 P1：预览/导出共用注入运行时（真模块，单一来源）。
// 由 preview-frame-script.ts 的 SCRIPT_BODY + PAGINATE_BODY 模板字符串提取而来
// （提取脚本 0007 P0 提取脚本留痕，恒等反转义零手改）。
// 构建期经 esbuild 打包为 IIFE 文本（scripts/preview-frame-runtime-plugin.mjs 虚拟模块），
// 由 preview-frame-script.ts injectPreviewScript 注入引擎产物；打包失败=语法错即构建期暴露。
// 本文件只在浏览器/iframe 内以打包文本形态执行，不经 tsc（纯 JS，与原模板字符串同等检验水位，
// 且新增 esbuild 语法检查）。装箱规则唯一真源 = ./paginate.js（测试同测这份）。

import { planFlow, mmToPx } from './paginate.js';

var CFG = "__CFG__";
function post(msg) { try { parent.postMessage(msg, '*'); } catch (e) { /* iframe 消息失败静默 */ } }
function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
function round2(v) { return Math.round(v * 100) / 100; }

function assetIdOf(src) {
  if (!src) return null;
  var s = decodeURIComponent(String(src).split('?')[0]);
  if (CFG.assetsRoot) {
    var root = 'file:///' + String(CFG.assetsRoot).replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    if (s.indexOf(root + '/') === 0) return s.slice(root.length + 1);
  }
  var m = s.match(/data-assets\/(.+)$/);
  return m ? m[1] : null;
}
function isForeign(qid, assetId) {
  var list = (CFG.foreignAssets || {})[qid];
  if (!list) return false;
  for (var i = 0; i < list.length; i++) { if (list[i] === assetId) return true; }
  return false;
}

// ---------- 高度上报（父层驱动 iframe 显示高度 + 纵向滚动） ----------
var reported = false;
function reportHeight(first) {
  // 0064（R-065 根因①）：scrollHeight 恒为整数——单页卷真实内容高 1202.094px 被上报成 1202，
  // 父层 Math.ceil 成幂等 no-op ⇒ iframe 比内容矮 0.094px ⇒ Chromium 必画纵向滚动条，横向条级联
  // （真机实测视口 794×1202 → 779×1187，两轴各挤窄 15px）。改取 documentElement **布局盒高**
  // （getBoundingClientRect，浮点，亚像素保留）；body.scrollHeight 作地板保留（老口径的收缩能力不丢）。
  var h = Math.ceil(Math.max(
    document.documentElement.getBoundingClientRect().height,
    document.body ? document.body.scrollHeight : 0
  ));
  post({ t: first && !reported ? 'mf-preview-ready' : 'mf-height', height: h });
  reported = true;
}
if (typeof ResizeObserver !== 'undefined' && document.body) {
  new ResizeObserver(function () { reportHeight(false); }).observe(document.body);
}

// ---------- 父层缩放补偿（fix-3 P0-1）：iframe 被父层 transform 等比缩放，
// 手柄等视觉件按 1/scale 反放大保持可命中（视觉≥16px）；拖拽位移同样按 scale 归一到布局 px ----------
function updateInvScale() {
  var inv = 1;
  try {
    var fe = window.frameElement;
    if (fe && fe.offsetWidth > 0 && fe.getBoundingClientRect().width > 0) {
      inv = fe.offsetWidth / fe.getBoundingClientRect().width;
    }
  } catch (e) { /* 受限环境保持 1 */ }
  document.documentElement.style.setProperty('--mf-inv-scale', String(round2(inv * 100) / 100));
}
function invScale() {
  var v = parseFloat(document.documentElement.style.getPropertyValue('--mf-inv-scale'));
  return isNaN(v) || v <= 0 ? 1 : v;
}

// ---------- 选中框体系（fix-3 共用基座：figure/logo 同一套框+手柄） ----------
// 框 = 紧贴目标元素真实边界（getBoundingClientRect + ResizeObserver 实时同步）的虚线框；
// 手柄 = 右下角、拖拽缩放（回调由消费方注入）；框体 pointer-events:none 不挡图点击。
var selBox = null, selTarget = null, selRO = null, selSync = null;
function deselect() {
  if (selRO) { selRO.disconnect(); selRO = null; }
  if (selSync) { window.removeEventListener('resize', selSync); selSync = null; }
  if (selBox) { selBox.remove(); selBox = null; }
  selTarget = null;
}
function selectEl(target, onHandleDown) {
  deselect();
  selTarget = target;
  selBox = document.createElement('div');
  selBox.className = 'mf-selection-box';
  var handle = document.createElement('div');
  handle.className = 'mf-selection-handle';
  handle.title = '拖拽调整大小';
  selBox.appendChild(handle);
  document.body.appendChild(selBox);
  selSync = function () {
    if (!selTarget || !selBox) return;
    var r = selTarget.getBoundingClientRect();
    selBox.style.left = String(window.scrollX + r.left) + 'px';
    selBox.style.top = String(window.scrollY + r.top) + 'px';
    selBox.style.width = String(r.width) + 'px';
    selBox.style.height = String(r.height) + 'px';
  };
  selSync();
  if (typeof ResizeObserver !== 'undefined') {
    selRO = new ResizeObserver(function () { if (selSync) selSync(); });
    selRO.observe(target);
    // 0064（R-059）：iframe 内纵向滚动条出现/消失 → 文档视口宽变 ≈15px → .mf-sheets flex 居中令纸张
    // 纯左移 ≈7.65px，而目标图尺寸不变 ⇒ RO(target) 不触发、iframe 元素尺寸不变 ⇒ window resize 不触发，
    // 框滞留旧位（真机 Δ=7.66px）。documentElement 的**内容盒**宽随滚动条切换而变，观察它即得同一触发源
    //（与上方 reportHeight 观察 document.body 同型；纯位移不改变 target 尺寸，只能靠视口侧的触发面）。
    // 注：RO 回调只在渲染帧里投递（被遮挡窗口挂起，真机用户窗口持续出帧无影响）——探针侧统一催帧取证。
    selRO.observe(document.documentElement);
  }
  window.addEventListener('resize', selSync);
  handle.addEventListener('mousedown', function (e) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    onHandleDown(e);
  });
  return selBox;
}

// ---------- 图块交互（选中框 / 缩放手柄 / 换位拖拽 / 对齐 mini 条） ----------
var toolbarEl = null;
function hideToolbar() { if (toolbarEl) { toolbarEl.remove(); toolbarEl = null; } }
function figuresOf(qid) {
  return Array.prototype.slice.call(document.querySelectorAll('.figure-block[data-mf-question-id="' + qid + '"]'));
}
// ---------- fix-5 P0-2：段边界落点候选（.mf-seg 标记 = 引擎段序列边界；图可落任意文本段间） ----------
// 引擎在交互预览里为每道题输出 boundaryCount+1 个 .mf-seg 标记（边界 k = 第 k 段之前，k=段数=题尾）。
// 空标记的自身 top 常贴在前一行行顶（绝对定位静态位置），故取「其后第一个可见盒的 top」修正；
// 无后继可见盒（题尾）取「前一个可见盒的 bottom」。都无 → 标记自身 top（退化兜底）。
function markersOf(qid) {
  return Array.prototype.slice.call(document.querySelectorAll('.mf-seg[data-mf-q="' + qid + '"]'));
}
function nextVisibleTop(el, item) {
  var node = el;
  while (node && node !== item) {
    var sib = node.nextElementSibling;
    while (sib) {
      var r = sib.getBoundingClientRect();
      if (r.width > 0 || r.height > 0) return r.top;
      sib = sib.nextElementSibling;
    }
    node = node.parentElement;
  }
  return null;
}
function prevVisibleBottom(el, item) {
  var node = el;
  while (node && node !== item) {
    var sib = node.previousElementSibling;
    while (sib) {
      var r = sib.getBoundingClientRect();
      if (r.width > 0 || r.height > 0) return r.bottom;
      sib = sib.previousElementSibling;
    }
    node = node.parentElement;
  }
  return null;
}
function boundaryY(marker, item) {
  var self = marker.getBoundingClientRect();
  var nt = nextVisibleTop(marker, item);
  if (nt !== null && nt >= self.top - 2) return nt;
  var pb = prevVisibleBottom(marker, item);
  return pb !== null ? pb : self.top;
}
// ---------- fix-6 P0-1：DOM 块级盒边界候选（marker 候选的增量补充） ----------
// 引擎 markers 只在段序列边界（fix-6 切分后 options 前后已覆盖主诉求）；此处补 options 组与
// content 直接子块的上下边界（如「选项区之后」），seg 取该盒前/后 DOM 序最近 marker 的段号。
// 段内精确位置引擎无法表达时吸附最近边界——比无候选不落锚（松手回原位）体验正确。
function segBeforeNearest(markers, node) {
  for (var k = markers.length - 1; k >= 0; k--) {
    // DOCUMENT_POSITION_FOLLOWING(4)：参数 node 在调用 marker 之后 = marker 在 node 之前
    if (markers[k].compareDocumentPosition(node) & 4) return parseInt(markers[k].getAttribute('data-mf-seg'), 10);
  }
  return null;
}
function segAfterNearest(markers, node) {
  for (var k = 0; k < markers.length; k++) {
    if (node.compareDocumentPosition(markers[k]) & 4) return parseInt(markers[k].getAttribute('data-mf-seg'), 10);
  }
  return null;
}
function domBoundaryCandidates(item, markers) {
  if (!item || markers.length === 0) return [];
  var out = [];
  function pushBox(node, seg, pageY) {
    if (seg === null || seg === undefined) return;
    out.push({ seg: seg, y: pageY });
  }
  var options = item.querySelectorAll('.options');
  for (var o = 0; o < options.length; o++) {
    var r = options[o].getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) continue;
    pushBox(options[o], segBeforeNearest(markers, options[o]), window.scrollY + r.top);
    pushBox(options[o], segAfterNearest(markers, options[o]), window.scrollY + r.bottom);
  }
  var content = item.querySelector('.question-content');
  if (content) {
    var kids = content.children;
    for (var i = 0; i < kids.length; i++) {
      var kid = kids[i];
      if (kid.classList.contains('figure-block') || kid.classList.contains('options') || kid.classList.contains('mf-seg')) continue;
      var kr = kid.getBoundingClientRect();
      if (kr.width <= 0 && kr.height <= 0) continue;
      pushBox(kid, segBeforeNearest(markers, kid), window.scrollY + kr.top);
      pushBox(kid, segAfterNearest(markers, kid), window.scrollY + kr.bottom);
    }
  }
  return out;
}
function boundaryCandidates(block, item) {
  var qid = block.getAttribute('data-mf-question-id');
  var out = [];
  var markers = markersOf(qid);
  for (var i = 0; i < markers.length; i++) {
    var seg = parseInt(markers[i].getAttribute('data-mf-seg'), 10);
    if (isNaN(seg)) continue;
    out.push({ seg: seg, y: window.scrollY + boundaryY(markers[i], item) });
  }
  // fix-6 P0-1：DOM 块级盒边界补充（options 组/content 直接子块上下界）——
  // 每个候选 seg = DOM 序位于该盒前/后最近 marker 的段号（落点复用 anchorIndex 通道）。
  // 与 marker 候选同点（|dy|<4px）去重，只留增量落点（如「选项区之后」）。sort 前 y 未定 x/w。
  var doms = domBoundaryCandidates(item, markers);
  for (var d = 0; d < doms.length; d++) {
    var dup = false;
    for (var j = 0; j < out.length; j++) { if (Math.abs(out[j].y - doms[d].y) < 4) { dup = true; break; } }
    if (!dup) out.push(doms[d]);
  }
  out.sort(function (a, b) { return a.seg - b.seg; });
  var box = block.parentElement ? block.parentElement.getBoundingClientRect() : block.getBoundingClientRect();
  for (var k = 0; k < out.length; k++) { out[k].x = window.scrollX + box.left; out[k].w = box.width; }
  return out;
}
function nearestCandidate(list, pageY) {
  if (list.length === 0) return null;
  var best = list[0];
  for (var i = 1; i < list.length; i++) {
    if (Math.abs(list[i].y - pageY) < Math.abs(best.y - pageY)) best = list[i];
  }
  return best;
}
// 兜底（无标记产物/旧构建）：吸附其它图块边界与题尾（fix-2 语义，assetId 形式回传）
function figureBoundaryFallback(block, pageY) {
  var qid = block.getAttribute('data-mf-question-id');
  var others = figuresOf(qid).filter(function (b) { return b !== block; });
  var bounds = [];
  for (var i = 0; i < others.length; i++) {
    var r = others[i].getBoundingClientRect();
    bounds.push({ y: window.scrollY + r.top - 3, before: others[i].getAttribute('data-mf-asset-id') });
    bounds.push({ y: window.scrollY + r.bottom + 3, before: i + 1 < others.length ? others[i + 1].getAttribute('data-mf-asset-id') : null });
  }
  if (bounds.length === 0) {
    var b0 = block.getBoundingClientRect();
    return { y: window.scrollY + b0.bottom + 2, x: window.scrollX + b0.left, w: b0.width, before: null };
  }
  var best = bounds[0];
  for (var j = 1; j < bounds.length; j++) {
    if (Math.abs(bounds[j].y - pageY) < Math.abs(best.y - pageY)) best = bounds[j];
  }
  var r0 = others[0].getBoundingClientRect();
  best.x = window.scrollX + r0.left;
  best.w = r0.width;
  return best;
}
// 0067（R-069 §零.10）：当前对齐/版式直读块 class（`figure-block--{align}`），无需扩预览协议。
// 缺省 center 与引擎 renderFigureBlock 同口径（无 align 覆盖时全局档默认居中）。
function alignOf(block) {
  var cls = block.className || '';
  if (cls.indexOf('figure-block--left') >= 0) return 'left';
  if (cls.indexOf('figure-block--right') >= 0) return 'right';
  return 'center';
}
// 0067（R-069）：覆盖档下块边距随对齐（与引擎 renderFigureBlock 同形）——拖手柄时块宽逐帧改，
// 若仍写死双 auto，居左/居右的图在拖动过程中会被拉回居中、松手才跳回（与预览/导出同管线口径分叉）。
var ALIGN_MARGINS = { left: ['0', 'auto'], center: ['auto', 'auto'], right: ['auto', '0'] };
function applyAlignMargins(block) {
  var pair = ALIGN_MARGINS[alignOf(block)] || ALIGN_MARGINS.center;
  block.style.marginLeft = pair[0];
  block.style.marginRight = pair[1];
}
function showToolbar(block) {
  hideToolbar();
  var qid = block.getAttribute('data-mf-question-id');
  var assetId = block.getAttribute('data-mf-asset-id');
  if (!qid || !assetId) return;
  var bar = document.createElement('div');
  bar.className = 'mf-figure-toolbar';
  // 0063 返工轮三（2026-09-24 用户授权+拍板）：①「随文」→「成行」（与左栏「单独成行」术语一致）；
  // ②高亮当前版式态——图块在 .question-side（右栏）= side-by-side，在文流 = inline（成行）。
  var sideMode = Boolean(block.closest('.question-side'));
  // 0067（R-069 §零.10）：对齐态高亮——当前对齐直读块 class `figure-block--{align}`（预览协议零扩展）。
  var curAlign = alignOf(block);
  var buttons = [
    { label: '左', type: 'mf-figure-align', value: 'left', active: curAlign === 'left' },
    { label: '中', type: 'mf-figure-align', value: 'center', active: curAlign === 'center' },
    { label: '右', type: 'mf-figure-align', value: 'right', active: curAlign === 'right' },
    { label: '成行', type: 'mf-figure-mode', value: 'inline', active: !sideMode },
    { label: '右栏', type: 'mf-figure-mode', value: 'side-by-side', active: sideMode },
    { label: '上移', type: 'move', value: -1 },
    { label: '下移', type: 'move', value: 1 },
  ];
  if (isForeign(qid, assetId)) {
    buttons.push({ label: '移除', type: 'mf-figure-remove', value: '' });
  }
  buttons.forEach(function (b) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = b.label;
    if (b.active) btn.classList.add('mf-toolbar-active');
    if (b.type === 'mf-figure-remove') btn.style.color = '#c92a2a';
    btn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (b.type === 'move') {
        // fix-5 P0-2：上移/下移 = 落到相邻段边界（有标记产物时）；无标记回落旧图块序
        var list = boundaryCandidates(block, block.closest('.question-item'));
        var cur = list.length > 0 ? nearestCandidate(list, window.scrollY + block.getBoundingClientRect().top) : null;
        var step = cur ? list.indexOf(cur) + (b.value === -1 ? -1 : 1) : -1;
        if (cur && step >= 0 && step < list.length) {
          post({ t: 'mf-figure-move', questionId: qid, assetId: assetId, beforeAssetId: null, anchorIndex: list[step].seg });
        } else if (list.length === 0) {
          var all = figuresOf(qid);
          var idx = all.indexOf(block);
          var before = null;
          if (b.value === -1) before = idx > 0 ? all[idx - 1].getAttribute('data-mf-asset-id') : null;
          else before = idx + 2 < all.length ? all[idx + 2].getAttribute('data-mf-asset-id') : null;
          post({ t: 'mf-figure-move', questionId: qid, assetId: assetId, beforeAssetId: before });
        }
      } else if (b.type === 'mf-figure-remove') {
        post({ t: 'mf-figure-remove', questionId: qid, assetId: assetId });
      } else {
        var msg = { t: b.type, questionId: qid, assetId: assetId };
        msg[b.type === 'mf-figure-align' ? 'align' : 'mode'] = b.value;
        post(msg);
      }
      hideToolbar();
    });
    bar.appendChild(btn);
  });
  document.body.appendChild(bar);
  toolbarEl = bar;
  var r = block.getBoundingClientRect();
  bar.style.top = String(Math.max(0, window.scrollY + r.top - 36)) + 'px';
  bar.style.left = String(window.scrollX + r.left) + 'px';
}
// fix-6 P0-2：拉伸图块内层——剥 figure/img 的固定像素宽与 60% 观感档封顶，改为随块宽 100%。
// 与引擎 renderFigureBlock（widthPercent 覆盖时剥固定宽 + 0058 无内联宽兜底）同语义；
// 块内行内公式图不受影响（不在块内）。
function stretchFigureInner(block) {
  var fig = block.querySelector('figure');
  if (fig) { fig.style.width = '100%'; fig.style.maxWidth = '100%'; }
  var innerImg = block.querySelector('img');
  if (innerImg) { innerImg.style.width = '100%'; innerImg.style.maxWidth = '100%'; }
}
// 0058 F3（R-054）：图选中 = 「浮动条 + 选中框贴图」一体化入口，click 与「重建后恢复」共用。
// silent=true 时**不回发** mf-figure-select——恢复路径若回发 → CFG 变 → 重建 → 恢复 → 再回发 = 自激回路
// （选中题先例同口径：preview-frame-script 的 selectedQuestionId 恢复亦不回发）。
function selectFigure(block, silent) {
  var img = block.querySelector('img');
  if (!img) return;
  showToolbar(block);
  selectEl(img, function (downEv) {
    var parentW = block.parentElement ? block.parentElement.clientWidth : 0;
    if (parentW <= 0) return;
    // fix-5 P0-1（实机测定根因）：iframe 内鼠标事件的 clientX 已是**布局 px**——外层 transform 由浏览器
    // 逆变换后投递（外层 +10px → 内层 clientX +20px @scale0.5，probe1 实测），故几何量不得再乘 inv。
    // 0058 F1（R-054 根因）：分子基准 = **手柄所贴的那个盒（img）**，不是被改的块——
    // 旧实现 w0 取块宽（默认档下块恒满栏）⇒ 小图起手 pct 已 ≈100 ⇒ 外拖被 clamp 钳死（零效果）、
    // 内拖按「整块」粒度跳变。分母保持 block.parentElement.clientWidth（widthPercent 的语义分母）不动。
    var w0 = img.getBoundingClientRect().width;
    var startX = downEv.clientX;
    var stretched = false;
    function onMove(ev) {
      // 0058 F2：内层拉满从 mousedown 挪到**首次移动**（按下期间零 DOM 变更；旧实现一按就跳一版）。
      // 与「块宽写 pct%」同帧执行 → 图宽仍与位移 1:1，不产生额外跳变。
      if (!stretched) { stretchFigureInner(block); stretched = true; }
      var pct = clamp((w0 + (ev.clientX - startX)) / parentW * 100, 5, 100);
      block.style.width = pct + '%';
      applyAlignMargins(block);
    }
    function onUp(ev) {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      var pct = round2(clamp((w0 + (ev.clientX - startX)) / parentW * 100, 5, 100));
      post({ t: 'mf-figure-resize', questionId: block.getAttribute('data-mf-question-id'), assetId: block.getAttribute('data-mf-asset-id'), widthPercent: pct });
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  if (!silent) post({ t: 'mf-figure-select', questionId: block.getAttribute('data-mf-question-id'), assetId: block.getAttribute('data-mf-asset-id') });
}
// 0058 F3：取消图选中（点空白 / Esc / 拖拽换位起手）→ 回发双 null，父层据此清记忆（下次重建不恢复）。
// 残留态兜底在恢复侧（题内无匹配 assetId 则静默跳过），故此处无需与父层状态对齐。
function clearFigureSelect() {
  hideToolbar();
  deselect();
  post({ t: 'mf-figure-select', questionId: null, assetId: null });
}
function enhanceFigure(block) {
  block.setAttribute('data-mf-enhanced', '1');
  block.style.position = 'relative';
  var img = block.querySelector('img');
  if (!img) return;
  img.setAttribute('draggable', 'false');
  var assetId = assetIdOf(img.currentSrc || img.src);
  if (!assetId) return;
  block.setAttribute('data-mf-asset-id', assetId);

  // 点击选中：虚线框贴图真实边界 + 右下角手柄（拖手柄=缩放，拖框体=换位，互不干扰）
  block.addEventListener('click', function () {
    selectFigure(block);
  });

  // 拖拽换位（阈值 6px 激活；fix-5 P0-2：落点吸附 = 引擎段边界标记，图可落任意文本段间）
  // fix-4 顺手项 #3（拖图手感）：①拖中即时预览——块跟随指针位移 + 半透明（不再只有指示线）；
  // ②抓取光标即时反馈；③松手复位。落库语义（阈值后才 post 换位）不变。
  block.style.cursor = 'grab';
  block.addEventListener('mousedown', function (e) {
    if (e.button !== 0) return;
    // fix-5 P0-1：手柄/选中框上的 mousedown 不启动换位（事件独占；手柄侧另有 stopPropagation，双保险）
    if (e.target.closest('.mf-figure-toolbar') || e.target.closest('.mf-selection-box') || e.target.closest('.mf-selection-handle')) return;
    var sx = e.clientX, sy = e.clientY;
    var active = false, indicator = null, target = null, candidates = null;
    var qid = block.getAttribute('data-mf-question-id');
    var assetId2 = block.getAttribute('data-mf-asset-id');
    var item = block.closest('.question-item');
    function cleanup() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (indicator) { indicator.remove(); indicator = null; }
      block.style.transform = '';
      block.style.opacity = '';
      block.style.cursor = 'grab';
    }
    function onMove(ev) {
      if (!active && Math.abs(ev.clientY - sy) < 6 && Math.abs(ev.clientX - sx) < 6) return;
      if (!active) {
        active = true;
        // 0058 F3：换位拖拽起手即取消图选中（框体随 deselect 消失）→ 回发双 null，重建后不恢复
        clearFigureSelect();
        // 候选在加 transform 之前采集（拖中位移不污染边界测量）
        candidates = boundaryCandidates(block, item);
        block.style.opacity = '0.55';
        block.style.cursor = 'grabbing';
        indicator = document.createElement('div');
        indicator.className = 'mf-move-indicator';
        document.body.appendChild(indicator);
      }
      // 即时预览：块随指针平移（fix-5：clientX/Y 差已是布局 px，不再乘 inv）
      block.style.transform = 'translate(' + (ev.clientX - sx) + 'px,' + (ev.clientY - sy) + 'px)';
      var pageY = window.scrollY + ev.clientY;
      target = candidates && candidates.length > 0 ? nearestCandidate(candidates, pageY) : figureBoundaryFallback(block, pageY);
      if (target && indicator) {
        indicator.style.left = target.x + 'px';
        indicator.style.width = target.w + 'px';
        indicator.style.top = target.y + 'px';
      }
    }
    function onUp() {
      cleanup();
      if (!active || !target || !qid || !assetId2) return;
      if (target.seg !== undefined) {
        post({ t: 'mf-figure-move', questionId: qid, assetId: assetId2, beforeAssetId: null, anchorIndex: target.seg });
      } else {
        post({ t: 'mf-figure-move', questionId: qid, assetId: assetId2, beforeAssetId: target.before });
      }
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ---------- Logo 交互（拖拽定位 / 选中框角柄缩放；fix-3 P0-2 复用选中框基座） ----------
function pxPerMm() {
  var paper = document.querySelector('.paper');
  return paper ? paper.offsetWidth / CFG.pageWmm : 3.78;
}
function enhanceLogo(img, idx) {
  img.setAttribute('draggable', 'false');
  img.style.cursor = 'move';
  img.addEventListener('click', function (e) {
    e.stopPropagation();
    selectEl(img, function (downEv) {
      var ppm = pxPerMm();
      // fix-5 P0-1：clientX 差已是布局 px（见 figure resize 注释），几何量不乘 inv
      var sx = downEv.clientX;
      var w0 = parseFloat(img.style.width) || 0;
      function onMove(ev) {
        var nw = clamp(w0 + (ev.clientX - sx) / ppm, 2, CFG.pageWmm);
        img.style.width = nw + 'mm';
      }
      function onUp(ev) {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        var nw = clamp(w0 + (ev.clientX - sx) / ppm, 2, CFG.pageWmm);
        post({ t: 'mf-logo-resize', index: idx, widthRatio: round2(nw / CFG.pageWmm) });
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
  img.addEventListener('mousedown', function (e) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    var ppm = pxPerMm();
    var sx = e.clientX, sy = e.clientY;
    var l0 = parseFloat(img.style.left) || 0;
    var t0 = parseFloat(img.style.top) || 0;
    function onMove(ev) {
      img.style.left = clamp(l0 + (ev.clientX - sx) / ppm, 0, CFG.pageWmm) + 'mm';
      img.style.top = clamp(t0 + (ev.clientY - sy) / ppm, 0, CFG.pageHmm) + 'mm';
    }
    function onUp(ev) {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      var nl = clamp(l0 + (ev.clientX - sx) / ppm, 0, CFG.pageWmm);
      var nt = clamp(t0 + (ev.clientY - sy) / ppm, 0, CFG.pageHmm);
      post({ t: 'mf-logo-drag', index: idx, xRatio: round2(nl / CFG.pageWmm), yRatio: round2(nt / CFG.pageHmm) });
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ---------- 0004-fix-4 2.5：右栏点选交互（题级 hover/选中 + 题尾操作条，机制全在本脚本层） ----------
// hover → 题框虚线高亮；点击题内空白处 → 选中（实线框 + 题尾操作条）；Esc/点空白取消；
// 与图选中框互斥（点图/Logo/工具条不触发题选中）。操作条按钮经 postMessage 回父层调服务。
var qSelected = null, qBarEl = null;
function hideQuestionBar() { if (qBarEl) { qBarEl.remove(); qBarEl = null; } }
function clearQuestionSelect() {
  if (qSelected) qSelected.classList.remove('mf-q-selected');
  qSelected = null;
  hideQuestionBar();
}
// fix-5 P1-3：答题区操作条三态（无 →「添加答题区」；有 → − / N 行 / ＋ / 样式 / 删除）。
// 状态真源=父层 CFG.answerSpaces（覆盖+卷级配置），脚本只渲染 + 回传动作。
function answerSpaceOf(qid) {
  var entry = (CFG.answerSpaces || {})[qid];
  return entry && entry.enabled ? entry : null;
}
function barButton(bar, label, title, onClick) {
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = label;
  if (title) btn.title = title;
  btn.addEventListener('click', function (ev) {
    ev.stopPropagation();
    onClick();
  });
  bar.appendChild(btn);
  return btn;
}
function isTextBlockRow(qid) {
  return Boolean((CFG.textBlocks || {})[qid]);
}
// 0013：选项版式循环表（auto→单行→两行→auto）与按钮文案（文案随当前生效值）。
// 状态真源=父层 CFG.optionsLayouts（题级覆盖 ?? 卷级档），脚本只渲染 + 回传下一档。
var OL_NEXT = { 'auto': 'single-line', 'single-line': 'two-lines', 'two-lines': 'auto' };
var OL_LABEL = { 'auto': '自动', 'single-line': '单行', 'two-lines': '两行' };
function optionsLayoutOf(qid) {
  var v = (CFG.optionsLayouts || {})[qid];
  return OL_LABEL[v] !== undefined ? v : 'auto';
}
// fix-6 P1-1：文本块操作条（编辑 / 对齐左中右 / 删除）——当前对齐态按钮标色；动作经协议回父层
function showTextBlockBar(item, qid) {
  hideQuestionBar();
  var bar = document.createElement('div');
  bar.className = 'mf-question-bar';
  var current = (CFG.textBlocks || {})[qid] ? (CFG.textBlocks || {})[qid].align : 'center';
  barButton(bar, '编辑', '编辑该大标题文字', function () {
    post({ t: 'mf-text-edit', questionId: qid });
  });
  var alignLabels = { left: '左对齐', center: '居中', right: '右对齐' };
  ['left', 'center', 'right'].forEach(function (a) {
    var btn = barButton(bar, alignLabels[a], '设置对齐：' + alignLabels[a], function () {
      post({ t: 'mf-text-align', questionId: qid, align: a });
    });
    if (a === current) { btn.style.background = '#1971c2'; btn.style.color = '#fff'; }
  });
  var removeBtn = barButton(bar, '删除', '移除该大标题行', function () {
    post({ t: 'mf-text-remove', questionId: qid });
  });
  removeBtn.style.color = '#c92a2a';
  document.body.appendChild(bar);
  qBarEl = bar;
  var r = item.getBoundingClientRect();
  bar.style.top = String(Math.max(0, window.scrollY + r.top - 34)) + 'px';
  bar.style.left = String(window.scrollX + r.left + 8) + 'px';
}
function showQuestionBar(item, qid) {
  // fix-6 P1-1：文本内容块行 → 文本块操作条分支（编辑/对齐/删除；无答题区/分值语义）
  if (isTextBlockRow(qid)) { showTextBlockBar(item, qid); return; }
  hideQuestionBar();
  var bar = document.createElement('div');
  bar.className = 'mf-question-bar';
  var as = answerSpaceOf(qid);
  if (as) {
    barButton(bar, '−', '减少一行', function () {
      post({ t: 'mf-question-answer-space', questionId: qid, action: 'lines', lines: Math.max(1, as.lines - 1) });
    });
    var label = document.createElement('span');
    label.className = 'mf-as-label';
    label.setAttribute('data-mf-lines', String(as.lines));
    label.textContent = as.lines + ' 行';
    bar.appendChild(label);
    barButton(bar, '＋', '增加一行', function () {
      post({ t: 'mf-question-answer-space', questionId: qid, action: 'lines', lines: as.lines + 1 });
    });
    barButton(bar, as.style === 'lines' ? '横线' : '空白', '切换作答区样式（空白/横线）', function () {
      post({ t: 'mf-question-answer-space', questionId: qid, action: 'style', style: as.style === 'lines' ? 'blank' : 'lines' });
    });
    barButton(bar, '删除答题区', '删除该题作答区（回无）', function () {
      post({ t: 'mf-question-answer-space', questionId: qid, action: 'remove' });
    });
  } else {
    barButton(bar, '添加答题区', '为该题加 3 行空白作答区', function () {
      post({ t: 'mf-question-answer-space', questionId: qid, action: 'add' });
    });
  }
  // 0013：选项版式按钮（仅含 .options 容器的题出现；文案随当前生效值，点击循环切下一档）
  if (item.querySelector('.options')) {
    var ol = optionsLayoutOf(qid);
    barButton(bar, '选项版式：' + OL_LABEL[ol], '选择题选项排列（点击切换：自动→单行→两行→自动）', function () {
      post({ t: 'mf-question-options-layout', questionId: qid, mode: OL_NEXT[ol] });
    });
  }
  // fix-5 P1-1：分值入口（点击 → 父层展开该题分值行内输入）
  barButton(bar, '分值', '设置该题分值（展开行内输入）', function () {
    post({ t: 'mf-question-score', questionId: qid });
  });
  barButton(bar, '插入大标题', '在该题之前插入大标题', function () {
    post({ t: 'mf-question-insert-text', questionId: qid });
  });
  document.body.appendChild(bar);
  qBarEl = bar;
  var r = item.getBoundingClientRect();
  bar.style.top = String(Math.max(0, window.scrollY + r.bottom - 30)) + 'px';
  bar.style.left = String(window.scrollX + r.left + 8) + 'px';
}
function enhanceQuestionSelect(item, qid) {
  if (!qid) return;
  item.addEventListener('mouseenter', function () { if (!qSelected) item.classList.add('mf-q-hover'); });
  item.addEventListener('mouseleave', function () { item.classList.remove('mf-q-hover'); });
  item.addEventListener('click', function (e) {
    // 图/Logo/工具条上的点击不触发题选中（与图选中框互斥）
    if (e.target.closest('.figure-block') || e.target.closest('.paper-logo') || e.target.closest('.mf-question-bar') || e.target.closest('.mf-figure-toolbar')) return;
    clearQuestionSelect();
    qSelected = item;
    item.classList.add('mf-q-selected');
    showQuestionBar(item, qid);
  });
}
document.addEventListener('keydown', function (e) {
  // 0058 F3：Esc 取消图选中同样回发双 null（父层清记忆）
  if (e.key === 'Escape') { clearQuestionSelect(); clearFigureSelect(); }
});

// ---------- 点空白处取消选中（框体/手柄/工具栏/图块/Logo 之外） ----------
document.addEventListener('mousedown', function (e) {
  if (e.target.closest('.mf-selection-box') || e.target.closest('.mf-figure-toolbar') || e.target.closest('.mf-question-bar')) return;
  if (e.target.closest('.figure-block') || e.target.closest('.paper-logo')) return;
  clearFigureSelect();
  clearQuestionSelect();
});

// ---------- 标题点编 ----------
// 0009：命中目标扩为卷头全部行（旧单行 .paper-title + 多行自定义 .paper-header-line）——
// 点任意卷头行 → 既有 mf-title-click（协议不变）→ 左栏聚焦对应编辑器/编辑器首行。
function enhanceTitle() {
  var targets = document.querySelectorAll('.paper-title, .paper-header-line');
  for (var i = 0; i < targets.length; i++) {
    targets[i].style.cursor = 'pointer';
    targets[i].title = '点击编辑标题';
    targets[i].addEventListener('click', function () { post({ t: 'mf-title-click' }); });
  }
}

// ---------- 装配 ----------
function setup() {
  // 0004-fix-4 2.1：先页化（块级装箱纸流），再在页流 DOM 上挂交互层
  if (CFG.paginate) paginateDocument();
  updateInvScale();
  if (CFG.interactive) {
    var items = document.querySelectorAll('.question-item');
    var restore = null;
    for (var i = 0; i < items.length; i++) {
      // 页化后题可能被切成片段（.mf-continued）——按 data-mf-qindex 映射题序，不靠文档下标
      var qidxAttr = items[i].getAttribute('data-mf-qindex');
      var qid = qidxAttr !== null ? CFG.questionIds[parseInt(qidxAttr, 10)] : CFG.questionIds[i];
      if (!qid) continue;
      // fix-5 P0-2：段边界标记归属该题（交互层按 data-mf-q 收集落点候选）
      var segs = items[i].querySelectorAll('.mf-seg');
      for (var s = 0; s < segs.length; s++) segs[s].setAttribute('data-mf-q', qid);
      var blocks = items[i].querySelectorAll('.figure-block');
      for (var k = 0; k < blocks.length; k++) {
        blocks[k].setAttribute('data-mf-question-id', qid);
        enhanceFigure(blocks[k]);
      }
      // fix-4 2.5：题级 hover/点选 + 题尾操作条（与图选中互斥）
      enhanceQuestionSelect(items[i], qid);
      // fix-5 P1-3：重建后恢复选中题（行数步进/样式切换后操作条不消失）
      if (CFG.selectedQuestionId && qid === CFG.selectedQuestionId && !restore) restore = { item: items[i], qid: qid };
    }
    if (restore) {
      qSelected = restore.item;
      restore.item.classList.add('mf-q-selected');
      showQuestionBar(restore.item, restore.qid);
    }
    // 0058 F3：重建后恢复图选中态（照选中题先例，silent=不回发 → 防自激回路）。
    // 恢复面=CFG.selectedFigure（父层 ref 里的最新态）；题内无匹配 assetId（换卷/图被移除/软删题）
    // → 静默跳过（残留态兜底）；同 assetId 多块取首个，题号命中优先（边角条款见任务书 §零 F3.6）。
    if (CFG.selectedFigure && CFG.selectedFigure.assetId) {
      var wantAsset = String(CFG.selectedFigure.assetId);
      var wantQid = CFG.selectedFigure.questionId ? String(CFG.selectedFigure.questionId) : null;
      var cands = document.querySelectorAll('.figure-block[data-mf-asset-id]');
      var hitBlock = null;
      for (var cb = 0; cb < cands.length; cb++) {
        if (cands[cb].getAttribute('data-mf-asset-id') !== wantAsset) continue;
        if (!hitBlock) hitBlock = cands[cb];
        if (wantQid && cands[cb].getAttribute('data-mf-question-id') === wantQid) { hitBlock = cands[cb]; break; }
      }
      if (hitBlock) selectFigure(hitBlock, true);
    }
    var logos = document.querySelectorAll('.paper-logo:not([data-mf-clone])');
    for (var m = 0; m < logos.length; m++) enhanceLogo(logos[m], m);
    enhanceTitle();
  }
  reportHeight(true);
}
// 0007 P2：setup 暴露给宿主（导出窗在字体/图片就绪后手动触发）；自动执行挂在文件末（见尾注）。
window.__mofangPaginate = { setup: setup };
// 装箱规则唯一真源 = ./paginate.js（0007 P1 收编：原内联 planPageGroups/mmToPxLocal 删除；
// 0007 P5：运行时不再持第二份规则——段级装箱单源 = planFlow（planPages/planColumns 为其块级视图））。

// ---------- 0007 P5：段级单元模型（装箱粒度题级→段级；片边界=段边界） ----------
// 单元 = 段/块：<p>、<li>、图块、选项区、作答区、公式容器、文本内容块体…；
// 连续行内节点串按匿名块盒语义合成一个单元（量高时临时包盒，量完原位还原）；
// 单链空壳容器下沉（题根 div / .question-content / 列表）→ 到叶块即止，段边界=真实排版段边界。
// 题首 .question-header 与首段绑定（keepWithNext 防孤：断页时整体推走，题首不落页尾）；
// 图块/作答区/公式容器保持原子（不内部拆段）。旧 splitTallItem（按 .mf-question-body 子块切片，
// 片边界与真实打印不一致）已退役——段级装箱即其对齐实现。
// 0007 P6：段内行级拆分——可拆文本单元（普通 <p>/行内串）放不下当前容器剩余容量时，
// 经 Range 行盒懒测量按行边界拆「前段+残段」（防孤行 orphans=widows=2，不丢字不重字）。
var BLOCK_TAGS = {
  DIV: 1, P: 1, UL: 1, OL: 1, LI: 1, DL: 1, DT: 1, DD: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1,
  FIGURE: 1, FIGCAPTION: 1, TABLE: 1, THEAD: 1, TBODY: 1, TFOOT: 1, TR: 1, TD: 1, TH: 1,
  BLOCKQUOTE: 1, PRE: 1, HR: 1, SECTION: 1, ARTICLE: 1, HEADER: 1, FOOTER: 1, MAIN: 1, ASIDE: 1,
  NAV: 1, FORM: 1, FIELDSET: 1, ADDRESS: 1, CENTER: 1, CAPTION: 1, CANVAS: 1, VIDEO: 1, AUDIO: 1
};
/** 可下沉容器白名单（单链空壳 div / 题内容根 / 列表）——叶块（p/图块/选项/公式容器）不在于此，即止 */
var CONTAINER_TAGS = {
  DIV: 1, SECTION: 1, ARTICLE: 1, MAIN: 1, ASIDE: 1, NAV: 1, HEADER: 1, FOOTER: 1,
  FORM: 1, UL: 1, OL: 1, BLOCKQUOTE: 1, LI: 1
};
/** 原子单元（内部永不拆段）：图块 / 选项区 / 公式容器（KaTeX display span）/ 作答区 / 答案解析字段 / 文本块体 */
var ATOMIC_CLASSES = ['figure-block', 'options', 'katex-display', 'answer-space', 'answer-field', 'analysis-field', 'question-side', 'mf-text-body'];

function hasClass(el, name) { return !!(el && el.classList && el.classList.contains(name)); }
function isAtomicUnitEl(el) {
  for (var ai = 0; ai < ATOMIC_CLASSES.length; ai++) { if (hasClass(el, ATOMIC_CLASSES[ai])) return true; }
  return false;
}
function isBlockChild(node) {
  return node.nodeType === 1 && (isAtomicUnitEl(node) || BLOCK_TAGS[node.tagName] === 1);
}
function isDescendContainer(el) {
  return el.nodeType === 1 && !isAtomicUnitEl(el) && CONTAINER_TAGS[el.tagName] === 1;
}
function isSegMarkerNode(node) { return node.nodeType === 1 && hasClass(node, 'mf-seg'); }
function samePath(a, b) {
  if (a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) { if (a[i] !== b[i]) return false; }
  return true;
}
function makeUnit(el, flowNodes, path, pending) {
  return {
    key: '', group: null, el: el || null, flowNodes: flowNodes, nodes: pending.concat(flowNodes), path: path,
    pendingNodes: pending.slice(), heightPx: 0, marginTopPx: 0, marginBottomPx: 0, keepWithNext: false,
    lineHeights: null, linesMeasured: false,
  };
}

/** 容器子节点 → run 序列（块级各成 run；连续行内节点合成一个 run；.mf-seg 标记进 state.pending 随下一单元走） */
function collectRuns(host, state) {
  var runs = [], run = null, kids = host.childNodes;
  for (var i = 0; i < kids.length; i++) {
    var node = kids[i];
    if (isSegMarkerNode(node)) { state.pending.push(node); continue; }
    if (isBlockChild(node)) {
      run = null;                                   // 块级截断行内串
      runs.push({ nodes: [node], block: true, el: node });
      continue;
    }
    if (node.nodeType === 3 && !/\S/.test(node.nodeValue || '')) continue;   // 纯空白：留原位（不产单元）
    if (node.nodeType !== 1 && node.nodeType !== 3) continue;
    if (!run) { run = { nodes: [], block: false, el: null }; runs.push(run); }
    run.nodes.push(node);
  }
  return runs;
}

/** 递归收集单元（path = 从片段体 .mf-question-body 到单元父级的壳链；续片段按此克隆结构，
 *  父级选择器样式（.question-content > .question > .options 等）不失效） */
function collectUnits(host, path, out, state) {
  var runs = collectRuns(host, state);
  if (runs.length === 1 && runs[0].block && isDescendContainer(runs[0].el)) {
    collectUnits(runs[0].el, path.concat([runs[0].el]), out, state);
    return;
  }
  for (var i = 0; i < runs.length; i++) {
    var run = runs[i];
    if (run.block && isDescendContainer(run.el)) {
      collectUnits(run.el, path.concat([run.el]), out, state);
      continue;
    }
    out.push(makeUnit(run.block ? run.el : null, run.nodes, path, state.pending));
    state.pending = [];
  }
}

/** 题块 → 单元序列（题首 keepWithNext=绑定首段；题尾段标记挂末单元） */
function unitsOfItem(item) {
  var units = [], header = null, i;
  for (i = 0; i < item.children.length; i++) {
    if (hasClass(item.children[i], 'question-header')) { header = item.children[i]; break; }
  }
  var state = { pending: [] };
  for (i = 0; i < item.children.length; i++) {
    var child = item.children[i];
    if (child === header) continue;
    if (isDescendContainer(child)) collectUnits(child, [], units, state);
    else units.push(makeUnit(child, [child], [], state.pending));
  }
  if (header) {
    var headerUnit = makeUnit(header, [header], [], []);
    headerUnit.keepWithNext = true;
    units.unshift(headerUnit);
  }
  if (units.length > 0 && state.pending.length > 0) {
    var lastUnit = units[units.length - 1];
    lastUnit.nodes = lastUnit.nodes.concat(state.pending);
    lastUnit.pendingNodes = lastUnit.pendingNodes.concat(state.pending);
  }
  return units;
}

/** 题块入探针量单元高 + 外边距（外边距单列，装箱按折叠口径累计——0007 P1 单源口径）：
 *  题级上下外边距归首/末单元（max 折叠）；题首浮动题号与首段同行 → 题首高按超出首段部分计入。 */
function measureItemUnits(item, units, probe, width) {
  var parent = item.parentNode, next = item.nextSibling;
  var ist = window.getComputedStyle(item);
  var itemMt = parseFloat(ist.marginTop) || 0;
  var itemMb = parseFloat(ist.marginBottom) || 0;
  probe.style.width = width + 'px';
  probe.appendChild(item);
  for (var i = 0; i < units.length; i++) {
    var unit = units[i];
    if (unit.el) {
      var st = window.getComputedStyle(unit.el);
      unit.heightPx = unit.el.offsetHeight;
      unit.marginTopPx = parseFloat(st.marginTop) || 0;
      unit.marginBottomPx = parseFloat(st.marginBottom) || 0;
    } else {
      // 行内串：临时包盒量高（匿名块盒语义），量完原位还原（DOM 不动）
      var wrap = document.createElement('div');
      wrap.className = 'mf-unit-wrap';
      var anchor = unit.flowNodes[0], host = anchor.parentNode;
      host.insertBefore(wrap, anchor);
      for (var k = 0; k < unit.flowNodes.length; k++) wrap.appendChild(unit.flowNodes[k]);
      unit.heightPx = wrap.offsetHeight;
      for (var m = 0; m < unit.flowNodes.length; m++) host.insertBefore(unit.flowNodes[m], wrap);
      host.removeChild(wrap);
    }
  }
  if (units.length > 0) {
    units[0].marginTopPx = Math.max(units[0].marginTopPx, itemMt);
    units[units.length - 1].marginBottomPx = Math.max(units[units.length - 1].marginBottomPx, itemMb);
    if (units.length > 1 && units[0].keepWithNext) {
      units[0].heightPx = Math.max(0, units[0].heightPx - units[1].heightPx);
    }
  }
  if (next && next.parentNode === parent) parent.insertBefore(item, next);
  else if (parent) parent.appendChild(item);
  return { marginTopPx: itemMt, marginBottomPx: itemMb };
}

// ---------- 0007 P6：长文段内行级拆分（Range 行盒懒测量 + 行边界断点 + 切段预执行） ----------
// 可拆单元 = 普通 <p>（非原子类）/ 连续行内节点串；keepWithNext（题首）不拆。
// 懒测量：首轮段级装箱后，仅对被推容器首单元/溢出容器单元补测行盒（getClientRects），
// 带 lineHeights 重建规格重装箱（收敛封顶 SPLIT_MEASURE_PASSES 轮）；
// 全程 try/catch → 测量异常回落段级路径（jsdom 无 Range.getClientRects 时 P5 语义零回归）。

/** 可拆文本单元：非 keepWithNext 且（普通 <p> 块 / 行内节点串）；原子单元（图/选项/公式/作答区…）不拆 */
function isSplittableUnit(unit) {
  if (unit.keepWithNext) return false;
  if (unit.el) return unit.el.tagName === 'P' && !isAtomicUnitEl(unit.el);
  return unit.flowNodes.length > 0;
}

/** 行盒矩形垂直重叠归并（同行多矩形——行内元素/sub/sup 切块——合并为一个行盒；高 <1 的碎片跳过） */
function mergeLineRects(rects) {
  var lines = [];
  for (var i = 0; i < rects.length; i++) {
    var r = rects[i];
    if (!r || r.height < 1) continue;
    var last = lines.length > 0 ? lines[lines.length - 1] : null;
    if (last && r.top < last.bottom - 1) {
      if (r.bottom > last.bottom) last.bottom = r.bottom;
      if (r.top < last.top) last.top = r.top;
    } else {
      lines.push({ top: r.top, bottom: r.bottom });
    }
  }
  return lines;
}

/** 行内串单元临时包盒（匿名块盒语义，量行盒/定位断点用）；解盒用 wrap.childNodes 回搬（flowNodes 可能已被拆改） */
function wrapUnitContent(unit) {
  var anchor = unit.flowNodes[0];
  var parent = anchor ? anchor.parentNode : null;
  if (!parent) return null;
  var wrap = document.createElement('div');
  wrap.className = 'mf-unit-wrap';
  parent.insertBefore(wrap, anchor);
  for (var i = 0; i < unit.flowNodes.length; i++) wrap.appendChild(unit.flowNodes[i]);
  return wrap;
}
function unwrapUnitContent(wrap) {
  var parent = wrap.parentNode;
  if (!parent) return;
  while (wrap.firstChild) parent.insertBefore(wrap.firstChild, wrap);
  parent.removeChild(wrap);
}

/** 单元行盒懒测量：题块入探针（样式上下文保留）→ 块单元直测 / 行内串包盒测 → 行高序列。
 *  行高 = 相邻行盒顶距；末行 = 单元测高 − 前行合计（行盒合计恒等于 heightPx 口径）。
 *  任何异常 → null（调用方保持段级路径）。
 *  性能：题块已在探针内则跳过搬动（搬动 = DOM 变更触发布局；实测 10 题卷 66 次测量
 *  搬动守卫后懒测量阶段 36ms → 8ms）。 */
function measureUnitLines(rec, unit, probe, width) {
  var wrap = null;
  try {
    probe.style.width = width + 'px';
    if (rec && rec.el && rec.el.parentNode !== probe) probe.appendChild(rec.el);   // 题块留在探针内（组装阶段 appendChild 搬走，语义天然）
    var host = unit.el;
    if (!host) {
      wrap = wrapUnitContent(unit);
      if (!wrap) return null;
      host = wrap;
    }
    var range = document.createRange();
    range.selectNodeContents(host);
    var lines = mergeLineRects(range.getClientRects());
    if (lines.length < 2) return null;
    var heights = [], acc = 0;
    for (var i = 0; i < lines.length - 1; i++) {
      var h = lines[i + 1].top - lines[i].top;
      if (!(h > 0)) return null;
      heights.push(h);
      acc += h;
    }
    var lastLine = unit.heightPx - acc;
    if (!(lastLine > 0)) return null;
    heights.push(lastLine);
    return heights;
  } catch (e) {
    return null;
  } finally {
    if (wrap) unwrapUnitContent(wrap);
  }
}

/** 前缀行数：host 起点 → (node, offset) 的 Range 行盒数（断点定位的二分判定口径） */
function prefixLineCount(host, node, offset) {
  var range = document.createRange();
  range.setStart(host, 0);
  range.setEnd(node, offset);
  return mergeLineRects(range.getClientRects()).length;
}

/** 断点定位：第 k+1 行首字符前 = (文本节点, offset)。TreeWalker 逐文本节点二分最小使前缀行数 ≥ k+1
 *  的 offset，断点取其前一字符（前段恰 k 行）。找不到（行盒口径漂移）→ null（调用方降级）。
 *  offset=0 时归一化上爬到 (父级, 节点下标)：断点落在元素边界 → 后续元素整体进残段，
 *  避免 extractContents 在原位留下空壳元素（如断在 <sub> 首字符前时残段应拿整个 <sub>）。 */
function findSplitPosition(host, k) {
  var walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  var node = walker.nextNode();
  while (node) {
    var len = (node.nodeValue || '').length;
    if (len > 0 && prefixLineCount(host, node, len) >= k + 1) {
      var lo = 1, hi = len;
      while (lo < hi) {
        var mid = (lo + hi) >> 1;
        if (prefixLineCount(host, node, mid) >= k + 1) hi = mid;
        else lo = mid + 1;
      }
      var offset = lo - 1;
      while (offset === 0 && node !== host && node.parentNode) {
        var parentNode = node.parentNode;
        offset = Array.prototype.indexOf.call(parentNode.childNodes, node);
        node = parentNode;
      }
      return { node: node, offset: offset };
    }
    node = walker.nextNode();
  }
  return null;
}

function textOfNodes(nodes) {
  var s = '';
  for (var i = 0; i < nodes.length; i++) s += nodes[i].textContent || '';
  return s;
}

/** 拆分链收集：按 split.of 归链、startLine 排序、连续性校验（0 起 / 首尾相接 / 合计 = totalLines）。
 *  不完整链 = 失败链（invalid，调用方剥 lineHeights 重装箱回落段级）。 */
function collectSplitChains(plan) {
  var byOf = {}, order = [];
  for (var ci = 0; ci < plan.containers.length; ci++) {
    var fragments = plan.containers[ci].fragments;
    for (var fi = 0; fi < fragments.length; fi++) {
      var units = fragments[fi].units;
      for (var ui = 0; ui < units.length; ui++) {
        var split = units[ui].split;
        if (!split) continue;
        if (!byOf[split.of]) { byOf[split.of] = { totalLines: split.totalLines, parts: [] }; order.push(split.of); }
        byOf[split.of].parts.push({ startLine: split.startLine, lineCount: split.lineCount });
      }
    }
  }
  var chains = {}, invalid = [];
  for (var oi = 0; oi < order.length; oi++) {
    var ofKey = order[oi];
    var chain = byOf[ofKey];
    chain.parts.sort(function (a, b) { return a.startLine - b.startLine; });
    var expect = 0, ok = chain.parts.length >= 2;
    for (var pi = 0; ok && pi < chain.parts.length; pi++) {
      if (chain.parts[pi].startLine !== expect) ok = false;
      else expect += chain.parts[pi].lineCount;
    }
    if (expect !== chain.totalLines) ok = false;
    if (ok) chains[ofKey] = chain;
    else invalid.push(ofKey);
  }
  return { chains: chains, invalid: invalid };
}

/** 非破坏定位全链断点（行内串先包盒——断点 = 文本节点引用，解盒后仍有效）。
 *  失败自带还原（解盒）→ null；成功返回 { host, wrap, positions, originalText }（wrap 待切段/清理时解盒）。 */
function locateChainPositions(unit, chain) {
  var wrap = null, host = unit.el;
  if (!host) {
    wrap = wrapUnitContent(unit);
    if (!wrap) return null;
    host = wrap;
  }
  var positions = [];
  try {
    for (var i = 1; i < chain.parts.length; i++) {
      var pos = findSplitPosition(host, chain.parts[i].startLine);
      if (!pos) throw new Error('split position not found');
      positions.push(pos);
    }
  } catch (e) {
    if (wrap) unwrapUnitContent(wrap);
    return null;
  }
  return { host: host, wrap: wrap, positions: positions, originalText: host.textContent || '' };
}

/** 切段：自后向前 extractContents（先切后段，前序断点不失效）→ 逐字校验（前段+各残段 == 原文）。
 *  失败回滚（正序 appendChild 归位 + 解盒）→ false；成功登记 splitTails[单元 key][startLine]，
 *  前段让出尾边距（与 plan 口径一致：head mb=0），块单元残段 = 克隆壳 + 顶边距归零（非末段再尾边距归零）。 */
function cutUnitChain(unit, chain, located, splitTails) {
  var host = located.host, positions = located.positions;
  var fragNodeSets = [];
  var rollback = function () {
    for (var r = 0; r < fragNodeSets.length; r++) {
      for (var r2 = 0; r2 < fragNodeSets[r].length; r2++) host.appendChild(fragNodeSets[r][r2]);
    }
    if (located.wrap) unwrapUnitContent(located.wrap);
  };
  try {
    for (var i = positions.length - 1; i >= 0; i--) {
      var range = document.createRange();
      range.setStart(positions[i].node, positions[i].offset);
      range.setEnd(host, host.childNodes.length);
      var frag = range.extractContents();
      fragNodeSets.unshift(Array.prototype.slice.call(frag.childNodes));
    }
  } catch (e) {
    rollback();
    return false;
  }
  // 逐字校验：不丢字不重字（extractContents 守恒的硬证据）
  var joined = host.textContent || '';
  for (var v = 0; v < fragNodeSets.length; v++) joined += textOfNodes(fragNodeSets[v]);
  if (joined !== located.originalText) {
    rollback();
    return false;
  }
  var tailMap = {};
  if (unit.el) {
    unit.el.style.marginBottom = '0px';
    for (var t = 0; t < fragNodeSets.length; t++) {
      var tailEl = unit.el.cloneNode(false);
      for (var tn = 0; tn < fragNodeSets[t].length; tn++) tailEl.appendChild(fragNodeSets[t][tn]);
      tailEl.style.marginTop = '0px';   // 残段顶边距归零（续片段（续）::before 占位已在 plan 侧计价）
      if (t < fragNodeSets.length - 1) tailEl.style.marginBottom = '0px';   // 末段保留原尾边距（段下边距随末段落位）
      tailMap[chain.parts[t + 1].startLine] = { el: tailEl, nodes: [tailEl] };
    }
  } else {
    // 行内串：前段 = 包盒内余下节点；残段 = 各 frag 子节点序列
    var headNodes = Array.prototype.slice.call(host.childNodes);
    unit.flowNodes = headNodes;
    unit.nodes = unit.pendingNodes.concat(headNodes);
    for (var t2 = 0; t2 < fragNodeSets.length; t2++) {
      tailMap[chain.parts[t2 + 1].startLine] = { el: null, nodes: fragNodeSets[t2] };
    }
  }
  if (located.wrap) unwrapUnitContent(located.wrap);
  splitTails[unit.key] = tailMap;
  return true;
}

/** 已切链回滚（跨链失败的灾难兜底：残段内容正序归位，单元恢复整段形态；块壳克隆丢弃） */
function rollbackUnitChain(unit, tailMap) {
  if (!tailMap) return;
  var startLines = Object.keys(tailMap).map(function (k) { return Number(k); })
    .sort(function (a, b) { return a - b; });
  if (unit.el) {
    for (var i = 0; i < startLines.length; i++) {
      var tailEl = tailMap[startLines[i]].el;
      while (tailEl && tailEl.firstChild) unit.el.appendChild(tailEl.firstChild);
    }
    unit.el.style.marginBottom = '';
  } else {
    var anchor = unit.flowNodes.length > 0 ? unit.flowNodes[unit.flowNodes.length - 1] : null;
    var parent = anchor ? anchor.parentNode : null;
    if (!parent) return;
    var all = unit.flowNodes.slice();
    for (var k = 0; k < startLines.length; k++) {
      var nodes = tailMap[startLines[k]].nodes;
      for (var n = 0; n < nodes.length; n++) {
        parent.insertBefore(nodes[n], anchor.nextSibling);
        anchor = nodes[n];
        all.push(nodes[n]);
      }
    }
    unit.flowNodes = all;
    unit.nodes = unit.pendingNodes.concat(all);
  }
}

function makeSheet(wrap, padT, padR, padB, padL, pageW, pageH) {
  var s = document.createElement('div');
  s.className = 'mf-sheet';
  s.style.width = pageW + 'px';
  s.style.height = pageH + 'px';
  s.style.padding = padT + 'px ' + padR + 'px ' + padB + 'px ' + padL + 'px';
  wrap.appendChild(s);
  return s;
}

function paginateDocument() {
  var paper = document.querySelector('.paper');
  var questions = paper ? paper.querySelector('.paper-questions') : null;
  if (!paper || !questions) return;
  var cs = window.getComputedStyle(paper);
  var padT = parseFloat(cs.paddingTop) || 0;
  var padR = parseFloat(cs.paddingRight) || 0;
  var padB = parseFloat(cs.paddingBottom) || 0;
  var padL = parseFloat(cs.paddingLeft) || 0;
  var pageW = mmToPx(CFG.pageWmm);
  var pageH = mmToPx(CFG.pageHmm);
  var contentH = Math.max(40, pageH - padT - padB);
  var contentW = Math.max(40, pageW - padL - padR);
  var columns = CFG.columns === 2 ? 2 : 1;
  var gapPx = mmToPx(CFG.columnGapMm || 0);
  var colW = columns === 2 ? Math.max(40, (contentW - gapPx) / 2) : contentW;

  var header = paper.querySelector('.paper-header');
  var items = Array.prototype.slice.call(questions.children);
  if (!header && items.length === 0) return;   // 空卷不页化（旧语义）

  // 测量探针（题块整体入探针：题内父级选择器样式保留；探针不在 .paper-questions 内 → 双列 column-count 不污染测量）
  var probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden;width:' + contentW + 'px;';
  document.body.appendChild(probe);

  var unitByKey = {};
  var groupByKey = {};
  var unitOrder = [];    // 文档序单元数组（planFlow 规格的重建真源——planFlow 克隆产出拆分片，迭代重建须从单元出发）
  var headerSpec = null;

  // 抬头：单列入流（独立单元，group=null）；双列=通栏（不进列流，仅以其高压缩首页列容量）
  if (header) {
    var hst = window.getComputedStyle(header);
    var hmt = parseFloat(hst.marginTop) || 0;
    var hmb = parseFloat(hst.marginBottom) || 0;
    probe.appendChild(header);           // 量完留在探针内，组装阶段搬进 sheet 0
    probe.style.width = contentW + 'px';
    var headerH = header.offsetHeight;
    headerSpec = { total: headerH + hmt + hmb };
    if (columns === 1) {
      var headerUnit = makeUnit(header, [header], [], []);
      headerUnit.key = 'header';
      headerUnit.heightPx = headerH;
      headerUnit.marginTopPx = hmt;
      headerUnit.marginBottomPx = hmb;
      unitOrder.push(headerUnit);
      unitByKey.header = { unit: headerUnit, group: null };
    }
  }

  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    item.setAttribute('data-mf-qindex', String(i));
    var units = unitsOfItem(item);
    if (units.length === 0) continue;
    var margins = measureItemUnits(item, units, probe, colW);
    var groupKey = 'g' + i;
    var rec = { key: groupKey, el: item, qIndex: i, units: units, itemMb: margins.marginBottomPx, fragmentCount: 0, tailEls: [] };
    groupByKey[groupKey] = rec;
    for (var u = 0; u < units.length; u++) {
      var unit = units[u];
      unit.group = groupKey;
      unit.key = groupKey + ':' + u;
      unitOrder.push(unit);
      unitByKey[unit.key] = { unit: unit, group: rec };
    }
  }

  /** 0007 P6：规格重建（行盒懒测量注入 lineHeights 后重装箱用；planFlow 不改动输入，克隆只在输出侧） */
  function buildSpecs() {
    var out = [];
    for (var bi = 0; bi < unitOrder.length; bi++) {
      var bu = unitOrder[bi];
      var spec = {
        key: bu.key, heightPx: bu.heightPx, marginTopPx: bu.marginTopPx, marginBottomPx: bu.marginBottomPx,
      };
      if (bu.group) spec.group = bu.group;
      if (bu.keepWithNext) spec.keepWithNext = true;
      if (bu.lineHeights) spec.lineHeights = bu.lineHeights;
      out.push(spec);
    }
    return out;
  }
  var specs = buildSpecs();
  if (specs.length === 0) {    // 无题无抬头（或题块无内容且双列无抬头）不页化
    if (probe.parentNode) probe.parentNode.removeChild(probe);
    return;
  }

  // 0007 P2：页化打印样式（sheet 结构 + @page margin 归零）随运行时注入——
  // 导出链路（隐藏窗 executeJavaScript）不经 FRAME_CSS，打印正确性不得依赖预览侧样式。
  // @page{margin:0}：探针①实证 @page margin 恒胜 printToPDF margins 参数；
  // 页化后边距由 sheet padding 单一承担（预览屏显与导出打印同源同值），引擎 @page margin 须归零防双倍。
  // 0007 P6：注入提前到行盒测量之前——续片段「（续）」::before 行高须在测量时已生效（否则标记占位不可测）。
  var pstyle = document.createElement('style');
  pstyle.setAttribute('data-mf-paginate-css', '1');
  pstyle.textContent = '@page { margin: 0; }\n'
    + '.mf-sheet { position: relative; box-sizing: border-box; overflow: hidden; }\n'
    + '.mf-paged { padding: 0 !important; max-width: none !important; background: transparent !important; }\n'
    + '.mf-paged .paper-questions { margin: 0; }\n'
    + '.mf-paged .paper-header { break-inside: avoid; }\n'
    // 0007 P4：手工列盒（双列打印根治）——flex 两列等宽，列盒固定高=列容量，溢出裁切+溢出标记
    + '.mf-sheet-cols { display: flex; }\n'
    + '.mf-col { overflow: hidden; }\n'
    // 0007 P5：段级片段——续片段标「（续）」（预览 FRAME_CSS 同规则，PDF 与预览同源）；
    // 切分题的题尾外边距只落在末片段（首片 mf-split 让出，避免逐片重复计入）
    + '.mf-continued::before { content: "（续）"; font-size: 10pt; color: #868e96; }\n'
    + '.mf-continued { margin-bottom: 0; }\n'
    + '.mf-split { margin-bottom: 0; }\n'
    + '.mf-sheet-footer { position: absolute; left: 0; right: 0; text-align: center; font-size: 14px; line-height: 1.2; color: #000; }\n'
    // 0007 P5：「纸张结束」页边界提示（屏显物；线=内容区底边，标签在下边距内）
    + '.mf-sheet-end { position: absolute; left: 0; right: 0; border-top: 1px dashed #adb5bd; font-size: 10px; line-height: 14px; color: #adb5bd; text-align: right; padding-right: 8px; }\n'
    + '.mf-sheet--overflow::after { content: "⚠ 块超出单页高度"; position: absolute; right: 8px; bottom: 6px; font-size: 10px; color: #c92a2a; }\n'
    // 说明便签/纸张结束提示是屏显物：打印/导出时隐藏（否则 N 页 sheet 之后多出便签高度 → 多产一页）
    + '@media print { .mf-paged-note { display: none; } .mf-sheet-end { display: none; } }';
  document.head.appendChild(pstyle);

  // 0007 P6：续片段「（续）」标记行高（::before 首行占位）——planFlow 残段顶边距占位口径，
  // 段内拆到行盒边界的容器不被标记行顶破容量（段级续片段粒度松、由既有二次校验吸收，不加价）。
  var markerH = 0;
  try {
    var markerProbe = document.createElement('div');
    markerProbe.className = 'question-item mf-continued';
    probe.appendChild(markerProbe);
    markerH = markerProbe.offsetHeight || 0;
    probe.removeChild(markerProbe);
  } catch (e) { markerH = 0; }

  // 0007 P5：段级装箱单源（容器=页/列；双列首页列容量压缩=抬头通栏占位）
  var planOptions = {
    capacityPx: contentH,
    containersPerSheet: columns,
    continuedMarkerPx: markerH,
  };
  if (columns === 2 && headerSpec) planOptions.firstSheetCapacityPx = Math.max(40, contentH - headerSpec.total);
  var plan = planFlow(specs, planOptions);

  // 0007 P6：plan 单元 → 运行时单元回映射（拆分残段的 key=`${of}#sN` 不在 unitByKey，经 split.of 回源单元）
  function unitEntryOf(planUnit) {
    var entry = unitByKey[planUnit.key];
    if (!entry && planUnit.split) entry = unitByKey[planUnit.split.of];
    return entry;
  }

  // 0007 P6：行盒懒测量循环——被推容器首的可拆单元 + 溢出容器内全部可拆单元补测行盒，
  // 测到 lineHeights 即重建规格重装箱；无新增即收敛（SPLIT_MEASURE_PASSES 封顶）。
  // 测量异常（jsdom 无 Range.getClientRects 等）→ 该单元保持段级路径，不重试不误拆。
  var SPLIT_MEASURE_PASSES = 10;
  function splitCandidates() {
    var out = [], seen = [];
    function consider(planUnit) {
      var entry = unitEntryOf(planUnit);
      if (!entry || !entry.group) return;      // 抬头/独立块（group=null）不参与段内拆分
      var u = entry.unit;
      if (!isSplittableUnit(u) || u.linesMeasured || seen.indexOf(u) !== -1) return;
      seen.push(u);
      out.push(u);
    }
    for (var ci = 0; ci < plan.containers.length; ci++) {
      var container = plan.containers[ci];
      var firstFound = false;
      for (var fi = 0; fi < container.fragments.length; fi++) {
        var funits = container.fragments[fi].units;
        for (var ui = 0; ui < funits.length; ui++) {
          if (container.overflowWarn) consider(funits[ui]);      // 溢出容器：全部可拆单元补测
          if (ci > 0 && !firstFound) {                            // 被推容器：首个可拆单元（段内拆分填页尾受益点）
            var fe = unitEntryOf(funits[ui]);
            if (fe && fe.group && isSplittableUnit(fe.unit) && !fe.unit.linesMeasured) {
              consider(funits[ui]);
              firstFound = true;
            }
          }
        }
      }
    }
    return out;
  }
  var measurePass = 0, progressed = true;
  while (progressed && measurePass < SPLIT_MEASURE_PASSES) {
    progressed = false;
    var candidates = splitCandidates();
    for (var mc = 0; mc < candidates.length; mc++) {
      var cand = candidates[mc];
      cand.linesMeasured = true;     // 含失败：异常单元不重测（保持段级路径）
      var candEntry = unitByKey[cand.key];
      var lineHeights = measureUnitLines(candEntry ? candEntry.group : null, cand, probe, colW);
      if (lineHeights && lineHeights.length >= 2) { cand.lineHeights = lineHeights; progressed = true; }
    }
    if (progressed) { plan = planFlow(buildSpecs(), planOptions); measurePass++; }
  }

  // 0007 P6：拆分预执行（组装前把行级断点落成真实 DOM）——链校验 → 全链非破坏定位 →
  // 全部定位成功才切段（逐字校验）；失败链剥 lineHeights 重装箱（VPASS_MAX 封顶，超限全剥回 P5 段级）。
  // 数学上残段必落新容器（head 填满剩余容量 + 残段 ≥2 行 + 标记占位 ≥0 ⇒ 同容器放不下），
  // 故拆分残段恒在续片段中组装，splitTails 查询路径唯一。
  var splitTails = {};
  var VPASS_MAX = 4;
  var vpass = 0;
  var pendingChains = collectSplitChains(plan);
  var stripFailed = function (keys) {
    for (var si = 0; si < keys.length; si++) {
      var failEntry = unitByKey[keys[si]];
      if (failEntry) failEntry.unit.lineHeights = null;
    }
    plan = planFlow(buildSpecs(), planOptions);
    pendingChains = collectSplitChains(plan);
  };
  while ((Object.keys(pendingChains.chains).length > 0 || pendingChains.invalid.length > 0) && vpass < VPASS_MAX) {
    var stripKeys = pendingChains.invalid.slice();
    if (stripKeys.length === 0) {
      // 全链非破坏定位（任一定位失败 → 本轮不切任何链，已包盒的行内串先解盒还原）
      var locatedAll = {};
      for (var ofKey in pendingChains.chains) {
        if (!Object.prototype.hasOwnProperty.call(pendingChains.chains, ofKey)) continue;
        var chainEntry = unitByKey[ofKey];
        var located = chainEntry ? locateChainPositions(chainEntry.unit, pendingChains.chains[ofKey]) : null;
        if (located) locatedAll[ofKey] = located;
        else stripKeys.push(ofKey);
      }
      if (stripKeys.length === 0) {
        var cutOkKeys = [];
        for (ofKey in locatedAll) {
          if (!Object.prototype.hasOwnProperty.call(locatedAll, ofKey)) continue;
          if (cutUnitChain(unitByKey[ofKey].unit, pendingChains.chains[ofKey], locatedAll[ofKey], splitTails)) {
            cutOkKeys.push(ofKey);
          } else {
            stripKeys.push(ofKey);
          }
        }
        if (stripKeys.length === 0) break;     // 全链切段成功
        // 跨链失败：已切链全部回滚（保内容守恒）后失败链剥行盒重装箱
        for (var rk = 0; rk < cutOkKeys.length; rk++) {
          rollbackUnitChain(unitByKey[cutOkKeys[rk]].unit, splitTails[cutOkKeys[rk]]);
          delete splitTails[cutOkKeys[rk]];
        }
      } else {
        for (var ck in locatedAll) {
          if (Object.prototype.hasOwnProperty.call(locatedAll, ck) && locatedAll[ck].wrap) unwrapUnitContent(locatedAll[ck].wrap);
        }
      }
    }
    stripFailed(stripKeys);
    vpass++;
  }
  if (vpass >= VPASS_MAX && (Object.keys(pendingChains.chains).length > 0 || pendingChains.invalid.length > 0)) {
    stripFailed(Object.keys(pendingChains.chains).concat(pendingChains.invalid));   // 超上限：全剥回 P5 段级
    splitTails = {};
  }
  if (probe.parentNode) probe.parentNode.removeChild(probe);

  var wrap = document.createElement('div');
  wrap.className = 'mf-sheets';
  var overflowCount = 0;
  // 流盒链（阅读序内容盒：单列=sheet 本体；双列=逐列盒）——二次校验沿链后推
  var flowBoxes = [];

  // 双列手工列盒（0007 P4：替代 column-count 打印断列，列内高度分配由装箱器控制）
  function makeCols(sheet, capPx) {
    var colsEl = document.createElement('div');
    colsEl.className = 'mf-sheet-cols';
    colsEl.style.gap = gapPx + 'px';
    for (var c = 0; c < 2; c++) {
      var col = document.createElement('div');
      col.className = 'mf-col';
      col.style.width = colW + 'px';
      col.style.height = capPx + 'px';
      colsEl.appendChild(col);
      flowBoxes.push(col);
    }
    sheet.appendChild(colsEl);
    return colsEl;
  }
  // 链尾溢出时新开 sheet（双列列盒一并入链）
  function appendEmptySheet() {
    var s = makeSheet(wrap, padT, padR, padB, padL, pageW, pageH);
    if (columns === 1) flowBoxes.push(s);
    else makeCols(s, contentH);
    return s;
  }

  // 0007 P6：plan 单元的节点集——前段（startLine=0/未拆）用单元活节点（切段已就地完成）；
  // 残段查 splitTails 切段产物（缺失 = 灾难兜底：空片段，内容完整留在前段整段——链校验+逐字校验已拦截，不可达）。
  function nodesOfPlanUnit(planUnit, unit) {
    if (!planUnit.split || planUnit.split.startLine === 0) return unit.nodes;
    var tailMap = splitTails[planUnit.split.of];
    var tail = tailMap ? tailMap[planUnit.split.startLine] : null;
    return tail ? tail.nodes : [];
  }

  // 片段元素：首片=原题元素（题首/原壳链原样）；续片=新建 .question-item.mf-continued
  // （按单元壳链克隆结构——父级选择器样式不失效）；独立单元（抬头）=元素本体。
  function buildFragmentEl(fragment) {
    var entry = fragment.units.length > 0 ? unitEntryOf(fragment.units[0]) : null;
    if (!entry) return null;
    if (entry.group === null) return entry.unit.el;
    var rec = entry.group;
    if (!fragment.continued) { rec.fragmentCount++; return rec.el; }
    // 0013 实机反馈修复（续片类名继承）：续片此前写死 'question-item mf-continued'，会丢掉引擎输出在
    // 题容器上的版式类——跨页题的选项落在续片时 ol-single/ol-two 失效（选项版式点击后无变化）、
    // mf-text-item 系文本块续片样式同理丢失。改为继承原题容器全部类，仅剔除分页/交互标记类
    // （mf-split=首片独有让位标记；q-hover/q-selected=页化后才挂的交互态）。
    var inheritedCls = '';
    if (rec.el.classList) {
      var OL_DENY = { 'mf-split': 1, 'mf-continued': 1, 'mf-q-hover': 1, 'mf-q-selected': 1 };
      var olParts = [];
      for (var oci = 0; oci < rec.el.classList.length; oci++) {
        var olcn = rec.el.classList.item(oci);
        if (olcn && !OL_DENY[olcn]) olParts.push(olcn);
      }
      inheritedCls = olParts.join(' ');
    }
    var frag = document.createElement('div');
    frag.className = (inheritedCls ? inheritedCls + ' ' : '') + 'mf-continued';
    frag.setAttribute('data-mf-qindex', String(rec.qIndex));
    var body = document.createElement('div');
    body.className = hasClass(rec.el, 'mf-text-item') ? 'mf-text-body' : 'mf-question-body';
    frag.appendChild(body);
    var currentPath = null, currentParent = null;
    for (var i = 0; i < fragment.units.length; i++) {
      var unitEntry = unitEntryOf(fragment.units[i]);
      if (!unitEntry) continue;
      var unit = unitEntry.unit;
      if (!currentPath || !samePath(currentPath, unit.path)) {
        currentParent = body;
        for (var p = 0; p < unit.path.length; p++) {
          var shell = unit.path[p].cloneNode(false);
          currentParent.appendChild(shell);
          currentParent = shell;
        }
        currentPath = unit.path;
      }
      var nodes = nodesOfPlanUnit(fragment.units[i], unit);
      for (var n = 0; n < nodes.length; n++) currentParent.appendChild(nodes[n]);
    }
    rec.fragmentCount++;
    rec.tailEls.push(frag);
    return frag;
  }

  var perSheet = columns;
  var sheetCount = Math.ceil(plan.containers.length / perSheet);
  for (var s = 0; s < sheetCount; s++) {
    var sheetEl = makeSheet(wrap, padT, padR, padB, padL, pageW, pageH);
    if (columns === 1) {
      flowBoxes.push(sheetEl);
      var container = plan.containers[s];
      for (var f = 0; f < container.fragments.length; f++) {
        var fragEl = buildFragmentEl(container.fragments[f]);
        if (fragEl) sheetEl.appendChild(fragEl);
      }
      if (container.overflowWarn) { sheetEl.classList.add('mf-sheet--overflow'); overflowCount++; }
    } else {
      if (s === 0 && header) sheetEl.appendChild(header);
      var colsEl = makeCols(sheetEl, s === 0 && headerSpec ? Math.max(40, contentH - headerSpec.total) : contentH);
      for (var c = 0; c < perSheet; c++) {
        var colContainer = plan.containers[s * perSheet + c];
        if (!colContainer) continue;
        for (var cf = 0; cf < colContainer.fragments.length; cf++) {
          var colFragEl = buildFragmentEl(colContainer.fragments[cf]);
          if (colFragEl) colsEl.children[c].appendChild(colFragEl);
        }
        if (colContainer.overflowWarn) { sheetEl.classList.add('mf-sheet--overflow'); overflowCount++; }
      }
    }
  }
  if (sheetCount === 0 && header) {
    // 仅有抬头的空卷：落一张 sheet 不丢抬头（0007 P4 语义保留）
    var onlySheet = makeSheet(wrap, padT, padR, padB, padL, pageW, pageH);
    onlySheet.appendChild(header);
    makeCols(onlySheet, Math.max(40, contentH - headerSpec.total));
  }

  // 题被切分（0007 P5）：首片让出题尾外边距（mf-split）、末续片承担（inline，与装箱口径一致）
  for (var gk in groupByKey) {
    if (!Object.prototype.hasOwnProperty.call(groupByKey, gk)) continue;
    var splitRec = groupByKey[gk];
    if (splitRec.fragmentCount <= 1 || splitRec.tailEls.length === 0) continue;
    splitRec.el.classList.add('mf-split');
    var tail = splitRec.tailEls[splitRec.tailEls.length - 1];
    tail.style.marginBottom = Math.round(splitRec.itemMb) + 'px';
  }

  // 二次校验（0007 P4 全场景化 + P5 段级片段：真实布局溢出 → 末片段沿流盒链后推；
  // 片段=段级最小可移动单位——防孤绑定在片段内，推页不拆题首+首段）；链尾无盒 → 新开 sheet。
  var guard = 0;
  for (var bi = 0; bi < flowBoxes.length; bi++) {
    var box = flowBoxes[bi];
    while (box.scrollHeight > box.clientHeight + 2 && box.children.length > 1 && guard < 400) {
      var last = box.lastElementChild;
      box.removeChild(last);
      if (!flowBoxes[bi + 1]) appendEmptySheet();
      flowBoxes[bi + 1].insertBefore(last, flowBoxes[bi + 1].firstChild);
      guard++;
    }
    if (box.scrollHeight > box.clientHeight + 2) {
      var boxSheet = box.closest ? box.closest('.mf-sheet') : null;
      if (boxSheet && !boxSheet.classList.contains('mf-sheet--overflow')) {
        boxSheet.classList.add('mf-sheet--overflow');
        overflowCount++;
      }
    }
  }

  // 0007 P2：页码内容化——装箱定页后逐 sheet 写实「第 N 页 / 共 M 页」（footerTemplate 退役配套）；
  // HTML 死占位 .paper-footer 移除（空 span 在 PDF 是死元素，页化后由 sheet 页脚取代）。
  var footer = paper.querySelector('.paper-footer');
  if (footer && footer.parentNode) footer.parentNode.removeChild(footer);
  var sheetEls = Array.prototype.slice.call(wrap.children);
  for (var fn = 0; fn < sheetEls.length; fn++) {
    var sheetFooter = document.createElement('div');
    sheetFooter.className = 'mf-sheet-footer';
    sheetFooter.style.bottom = Math.round(padB * 0.4) + 'px';
    sheetFooter.textContent = '第 ' + (fn + 1) + ' 页 / 共 ' + sheetEls.length + ' 页';
    sheetEls[fn].appendChild(sheetFooter);

    // 0007 P5：纸张结束提示逐 sheet 落在内容区底边（顶=纸高−下边距）；
    // 下边距过薄（无页边距场景）时文字行高归零，只留纸边线（不裁半行字）。
    var sheetEnd = document.createElement('div');
    sheetEnd.className = 'mf-sheet-end';
    sheetEnd.style.top = Math.round(pageH - padB) + 'px';
    if (padB < 16) sheetEnd.style.lineHeight = '0';
    sheetEnd.textContent = '纸张结束';
    sheetEls[fn].appendChild(sheetEnd);
  }

  // Logo → 首页原件 + 其余页克隆（原件序号不变，交互层只绑原件）
  var logos = Array.prototype.slice.call(paper.querySelectorAll('.paper-logo'));
  for (var s2 = 1; s2 < sheetEls.length; s2++) {
    for (var l = 0; l < logos.length; l++) {
      var clone = logos[l].cloneNode(true);
      clone.setAttribute('data-mf-clone', '1');
      sheetEls[s2].appendChild(clone);
    }
  }
  if (logos.length > 0 && sheetEls.length > 0) {
    for (var l2 = 0; l2 < logos.length; l2++) sheetEls[0].appendChild(logos[l2]);
  }

  var note = document.createElement('div');
  note.className = 'mf-paged-note';
  note.textContent = '分页视图 = 导出 PDF 实际分页（段级装箱 + 长文段内行级断页：题号与首段同页，题内段落可续下一页、'
    + '放不下的长段按行续排，续页均标「（续）」；每页纸底虚线标「纸张结束」，其下内容另起一页）。';
  wrap.appendChild(note);

  paper.appendChild(wrap);
  paper.classList.add('mf-paged');
  if (questions.parentNode) questions.parentNode.removeChild(questions);
  document.documentElement.setAttribute('data-mf-sheets', String(sheetEls.length));
  document.documentElement.setAttribute('data-mf-overflow', String(overflowCount));
}

// 0007 P2/P5：自动执行（CFG.deferSetup=true 时由宿主显式调用 window.__mofangPaginate.setup()）。
// 必须位于文件末：readyState=complete 时 setup() 立即执行——段级装箱的 var 初始化不得晚于它（旧版曾致
// ATOMIC_CLASSES 等段级常量未初始化即被读取；函数声明提升不覆盖 var 初始化顺序）。
if (!CFG.deferSetup) {
  if (document.readyState === 'complete') setup();
  else window.addEventListener('load', setup);
}