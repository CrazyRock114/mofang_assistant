/**
 * 组卷网（zujuan.xkw.com）与菁优网（jyeoo.com）采集适配器
 * DOM 提取逻辑，注入脚本会调用这些函数
 *
 * 注：这些函数在浏览器环境执行，使用 any 类型避免 Node 环境 DOM 类型冲突
 */

import type { CapturedQuestion } from '../../shared/contracts/capture-types.js';
import { replaceMathJyeWithTex } from './mathjye.js';
import { jyeooContentId } from './content-id.js';

// 合规红线：单次提取上限（防失控批量），不截用户手动加篮的正常题量（D1-fix-3 复验：上限 3 曾截掉篮内第 4 题）
const MAX_CAPTURE_COUNT = 20;

/**
 * absolutize 相对 URL
 */
function absolutizeUrl(src: string, baseUrl: string): string {
  try {
    return new URL(src, baseUrl).href;
  } catch {
    return src;
  }
}

/**
 * 提取图片（absolutize src）
 */
function extractImages(element: any, baseUrl: string, role: 'content' | 'answer'): Array<{ src: string; alt?: string; role: 'content' | 'answer' }> {
  const images: Array<{ src: string; alt?: string; role: 'content' | 'answer' }> = [];
  const imgElements = element.querySelectorAll('img');

  imgElements.forEach((img: any) => {
    const src = img.getAttribute('src');
    if (src) {
      images.push({
        src: absolutizeUrl(src, baseUrl),
        alt: img.getAttribute('alt') || undefined,
        role,
      });
    }
  });

  return images;
}

/** 选项格标记：A．/A./A、 开头（全角句点为组卷网实站形态） */
const OPTION_CELL_MARKER = /^[A-Z]\s*[．.、]/;

/**
 * 表后剩余文本阈值：去空白后 ≤ 该字符数视为「表后无实质题面内容」（纯标点/空括号等尾巴）。
 * 取 4 的理由：真站单选表收尾仅见「。」「（　）」类零碎标点（实抓 fixture 全卷题表后文本长度=0），
 * 而最小实质题面（如小问题干「请分析」）也超过 4 字，阈值贴地以避免误剔也避免误留。
 */
const OPTION_TABLE_TRAILING_TEXT_MAX = 4;

/**
 * 拆分题干内选项表（D1-fix-2 F-5，库存 31576438 取证：篮内 .exam-item__cnt 把选项 table 包在题干里，
 * 不拆出则入库后选项重复——题干里一份带公式图 + options 一份）。
 * 判定：table 首格以 A 标记开头；数据表格（"次数/电压"类）不误剔。
 * 0006-P4-fix-2 收窄：仅「恰好 1 个选项表」且「表后无实质题面内容」（去空白 ≤ OPTION_TABLE_TRAILING_TEXT_MAX）
 * 才抽离为 options[]；阅读大题（一题多小问：多选项表/表后还有小问题干）全部原样保留在题干内，
 * 选项随小问就地渲染，题面原序不被拍平堆尾。
 * 返回剔除选项表后的题干 HTML 与全量选项（一行两列全取，旧实现只取每行第一列丢 B/D）。
 *
 * 0006 P4（只增公开）：整卷下载的移动 API 题文（quesBody 内嵌 name="optionsTable" 选项表）复用同一拆分
 * ——选项表形态与篮内一致，避免两份实现漂移。
 */
export function splitStemAndOptions(stemEl: any): { stemHtml: string; options: string[] } {
  const clone = stemEl.cloneNode(true);
  const options: string[] = [];
  const optionTables: any[] = [];
  clone.querySelectorAll('table').forEach((table: any) => {
    const tds: any[] = [];
    table.querySelectorAll('td').forEach((td: any) => tds.push(td));
    if (tds.length === 0) return;
    if (!OPTION_CELL_MARKER.test((tds[0].textContent || '').trim())) return;
    optionTables.push(table);
  });

  const optionTable = optionTables.length === 1 ? optionTables[0] : null;

  // 表后是否有实质题面：从表节点向上逐层收集后继兄弟的 textContent（不含表自身子树，语义=表在文档序之后）
  let trailingText = '';
  let cursor = optionTable;
  while (cursor && cursor !== clone) {
    let sibling = cursor.nextSibling;
    while (sibling) {
      trailingText += sibling.textContent || '';
      sibling = sibling.nextSibling;
    }
    cursor = cursor.parentNode;
  }

  if (optionTable && trailingText.replace(/\s+/g, '').length <= OPTION_TABLE_TRAILING_TEXT_MAX) {
    optionTable.querySelectorAll('td').forEach((td: any) => {
      const html = (td.innerHTML || '').trim();
      if (html) options.push(html);
    });
    optionTable.parentNode.removeChild(optionTable);
  }

  return { stemHtml: clone.innerHTML, options };
}

/**
 * bankid（题的题库 id）解析：题块自身属性 → 祖先题块 → 同页同题号的列表题块 → 页面级三层兜底
 *
 * D1-fix-5 根因：详情页题库前缀硬编码 13q（13=物理），非物理学科题落「当前请求资源不存在」→ 答案漏采。
 * 实站形态（快照取证）：篮内题块 `.tk-mini-quest[questionid]` 不带 bankid，列表题块 `.tk-quest-item[bankid]` 带；
 * 用户采集现场是列表页加篮后原地提取（sourceUrl = 列表页 URL），故按题号回落取同页列表题块的属性值。
 *
 * D1-fix-6 根因：组卷试题篮跨页持久（题随用户走遍全站），异页（如首页）采集时 ①②③ 全落空 → 回落 13q。
 * 第④层按序兜底（侦察证据 D1-fix-6 侦察台账，全部只读、零网络）：
 *   ④a 题块后代 [bankid]——真站篮内题块 `.knowledge-box a[bankid="14"]`；
 *   ④b localStorage「questionBasket{bankid}」分桶——键名即 bankid（站点 JS saveToLocalStorage 实证），
 *      按题号命中桶号（同一 localStorage 为本站全站同源，跨页可用；天然与站点自身分库逻辑同源）；
 *   ④c window.bankid || window.currBankId 页面全局——多库共存时可能张冠李戴，故排末位。
 * 每层取不到即落下一层，全落空返回 undefined（由 zujuanDetailUrl 回落 13q，老数据兼容），不猜。
 */
function resolveBankid(doc: any, item: any, questionId: string): string | undefined {
  const own = item.getAttribute('bankid');
  if (own) return own;

  const ancestor = typeof item.closest === 'function' ? item.closest('[bankid]') : null;
  const fromAncestor = ancestor?.getAttribute('bankid');
  if (fromAncestor) return fromAncestor;

  let found: string | undefined;
  doc.querySelectorAll('[bankid][questionid]').forEach((block: any) => {
    if (!found && block.getAttribute('questionid') === questionId) {
      found = block.getAttribute('bankid') || undefined;
    }
  });
  if (found) return found;

  // ④a 题块后代 [bankid]（D1-fix-6 侦察：篮内题块知识解读链接带 bankid）
  const descendant = typeof item.querySelector === 'function' ? item.querySelector('[bankid]') : null;
  const fromDescendant = descendant?.getAttribute('bankid');
  if (fromDescendant) return fromDescendant;

  // ④b 客户端篮缓存分桶（键名 questionBasket{bankid}，值 JSON 数组）
  const fromStorage = bankidFromBasketStorage(doc, questionId);
  if (fromStorage) return fromStorage;

  // ④c 页面全局单值（末位兜底）
  return bankidFromPageGlobals(doc);
}

/** 客户端篮缓存键名：questionBasket{bankid}（站点 JS `localStorage.setItem("questionBasket"+bankId, JSON.stringify(questions))`） */
const BASKET_STORAGE_KEY_RE = /^questionBasket(\d+)$/;

/** 桶值是否含该题号（站点形态为 questionId 数字的平铺数组；探针兼容 questionList 分组一层） */
function basketBucketHasQuestion(parsed: any, questionId: string): boolean {
  const groups: any[] = Array.isArray(parsed) ? parsed : [];
  const items = groups.reduce(
    (acc: any[], g: any) => acc.concat(g && Array.isArray(g.questionList) ? g.questionList : [g]),
    [],
  );
  return items.some(
    (q: any) => q && (String(q.questionId ?? '') === questionId || String(q.id ?? '') === questionId),
  );
}

/**
 * ④b：遍历 localStorage 的 questionBasket{n} 桶，含当前题号者桶号即该题 bankid。
 * 任何异常（无 window/无 localStorage/权限拒绝/值非法 JSON）静默落下一层，不抛错不猜。
 */
function bankidFromBasketStorage(doc: any, questionId: string): string | undefined {
  try {
    const storage = doc?.defaultView?.localStorage;
    if (!storage) return undefined;
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (typeof key === 'string') keys.push(key);
    }
    for (const key of keys) {
      const matched = BASKET_STORAGE_KEY_RE.exec(key);
      if (!matched) continue;
      const raw = storage.getItem(key);
      if (!raw) continue;
      if (basketBucketHasQuestion(JSON.parse(raw), questionId)) return matched[1];
    }
  } catch { /* 无 window/localStorage/解析失败 → 落下一层 */ }
  return undefined;
}

/** ④c：页面全局（站点 getPageBankId 同款语义，本站实测 window.bankid=14 / currBankId=14） */
function bankidFromPageGlobals(doc: any): string | undefined {
  try {
    const pageWindow = doc?.defaultView;
    if (!pageWindow) return undefined;
    const raw = pageWindow.bankid ?? pageWindow.currBankId;
    if (typeof raw === 'string') return raw || undefined;
    if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  } catch { /* 页面全局不可读 → 落空 */ }
  return undefined;
}

/**
 * zujuan 篮提取
 */
export function extractZujuanBasket(doc: any, baseUrl: string): CapturedQuestion[] {
  const results: CapturedQuestion[] = [];

  // 查找题块：.quest-basket .mini-quest-item 或 .tk-mini-quest
  const questItems = doc.querySelectorAll('.quest-basket .mini-quest-item, .quest-basket .tk-mini-quest');

  let count = 0;
  questItems.forEach((item: any) => {
    if (count >= MAX_CAPTURE_COUNT) return;

    // 提取 qid
    const questionId = item.getAttribute('data-questionid') || item.getAttribute('questionid');
    if (!questionId) return;

    // 题干：.exam-item__cnt（选项表拆出为 options，见 splitStemAndOptions）
    const stemEl = item.querySelector('.exam-item__cnt');
    if (!stemEl) return;

    const { stemHtml, options } = splitStemAndOptions(stemEl);

    // 元信息
    const questionType = item.querySelector('.ques-type')?.textContent?.trim();
    const difficulty = item.querySelector('.ques-hard')?.textContent?.trim();
    const knowledgeEl = item.querySelector('.knowledge-name');
    const knowledgePoints = knowledgeEl ? [knowledgeEl.textContent?.trim() || ''] : [];
    const source = item.querySelector('.ques-src')?.textContent?.trim();

    // 题库 id（D1-fix-5）：详情页 URL 前缀 = 该题 bankid，非物理学科不再落 13q 硬编码
    const bankid = resolveBankid(doc, item, questionId);

    // 图片
    const images = extractImages(item, baseUrl, 'content');

    results.push({
      questionId,
      site: 'zujuan',
      sourceUrl: baseUrl,
      stemHtml,
      options,
      answerHtml: '', // 答案需补抓
      analysisHtml: '',
      images,
      meta: {
        questionType,
        difficulty,
        knowledgePoints: knowledgePoints.filter(Boolean),
        source,
        bankid,
      },
      rect: null,
    });

    count++;
  });

  return results;
}

/**
 * jyeoo 篮提取（D1-fix-3 J-1 实站锚定，fixtures/live/jyeoo-basket-20260906.html）
 *
 * 实站实证要点（与旧假设的差异）：
 * - fieldset id / report token / detail token 均每次渲染轮换 → questionId 改用内容哈希
 * - 篮内题干带 <span class="qseq">1．</span> 题号 → 提取层剥元素
 * - 篮内即带答案：选择正确项 label class="s sh"；填空答案内联 .sanwser（占位格 .quizPutTag）
 * - 公式为 MathJye 渲染 div 汤 → 重建 TeX 为 span.math[data-tex]（mathJyeToTex）
 * - 出处 = fieldset data-label 属性；学科 = s 属性（physics2=高中物理等）
 * - 篮内无 pt3 考点（考点在详情页 .pt3，由两跳链路补）
 */
export function extractJyeooBasket(doc: any, baseUrl: string): CapturedQuestion[] {
  const results: CapturedQuestion[] = [];

  // 篮题块：.ques-basket .basket-list fieldset.quesborder（实站命中 4，上限截断）
  const fieldsets = doc.querySelectorAll('.ques-basket .basket-list fieldset.quesborder, .ques-basket fieldset.quesborder');

  let count = 0;
  fieldsets.forEach((fieldset: any) => {
    if (count >= MAX_CAPTURE_COUNT) return;

    // 题干：.pt1（克隆后加工，不改动页面 DOM）
    const stemEl = fieldset.querySelector('.pt1');
    if (!stemEl) return;
    const stemClone = stemEl.cloneNode(true);

    // 题号元素剥离（实站：span.qseq "1．"）
    stemClone.querySelectorAll('.qseq').forEach((el: any) => el.parentNode.removeChild(el));

    // 来源链接剥离（实站：a.ques-source "（2027•新乡一模）" 在题干开头；出处已由 meta.source 承载）
    stemClone.querySelectorAll('.ques-source').forEach((el: any) => el.parentNode.removeChild(el));

    // 填空：.sanwser 为内联答案（收作答案，题干剔除）；.quizPutTag 占位格 → ____
    const blankAnswers: string[] = [];
    stemClone.querySelectorAll('.sanwser').forEach((el: any) => {
      const t = (el.textContent || '').trim();
      if (t) blankAnswers.push(t);
      el.parentNode.removeChild(el);
    });
    stemClone.querySelectorAll('.quizPutTag').forEach((el: any) => {
      el.parentNode.replaceChild(stemClone.ownerDocument.createTextNode('____'), el);
    });

    // 公式：MathJye div 汤 → span.math[data-tex]
    replaceMathJyeWithTex(stemClone);

    const stemHtml = stemClone.innerHTML;
    const stemText = (stemClone.textContent || '') as string;

    // 选项：.pt2 td.selectoption > label（实站：label 内联 HTML，含 MathJye 公式）；
    // 正确项 label class 含 s sh（篮内答案态实证：单选 1 项 / 多选多项）
    const options: string[] = [];
    const answerLetters: string[] = [];
    fieldset.querySelectorAll('.pt2 td.selectoption label').forEach((label: any) => {
      const optClone = label.cloneNode(true);
      replaceMathJyeWithTex(optClone);
      options.push((optClone.innerHTML || '').trim());
      const cls = String(label.getAttribute('class') || '').split(/\s+/);
      if (cls.includes('s') && cls.includes('sh')) {
        const m = (label.textContent || '').trim().match(/^([A-Z])/);
        if (m) answerLetters.push(m[1]);
      }
    });

    // 篮内联答案：选择题字母 / 填空 .sanwser；均无则留空走两跳补抓
    let answerHtml = '';
    if (answerLetters.length > 0) answerHtml = `<p>${answerLetters.join('')}</p>`;
    else if (blankAnswers.length > 0) answerHtml = `<p>${blankAnswers.join('；')}</p>`;

    // 报告页链接：实站 token 为 50 位加密串（非数字），仅作两跳中间键，不作主键
    const reportLink = fieldset.querySelector('a.ques-source[href*="/report/detail/"]');
    const reportHref = reportLink?.getAttribute('href') || '';
    const reportMatch = reportHref.match(/\/([a-z0-9]+)\/report\/detail\/([A-Za-z0-9]+)/i);
    const reportId = reportMatch ? reportMatch[2] : undefined;
    const subject = fieldset.getAttribute('s') || (reportMatch ? reportMatch[1].toLowerCase() : undefined);

    // questionId = 内容哈希（token 轮换实证后唯一可用的稳定去重键）
    const questionId = jyeooContentId(stemText, options.join(' '));

    // 出处 = fieldset data-label 属性（实站："（2027•新乡一模）"）；回落 ques-source 文本
    const source =
      fieldset.getAttribute('data-label') ||
      fieldset.querySelector('.ques-source')?.textContent?.trim() ||
      undefined;

    // 图片
    const images = extractImages(fieldset, baseUrl, 'content');

    results.push({
      questionId,
      site: 'jyeoo',
      sourceUrl: baseUrl,
      stemHtml,
      options,
      answerHtml,
      analysisHtml: '',
      images,
      meta: {
        source,
        knowledgePoints: [], // 篮内无 pt3 考点（实站实证），由两跳详情页补
        reportId,
        reportUrl: reportHref ? absolutizeUrl(reportHref, baseUrl) : undefined,
        subject,
        answerVia: answerHtml ? 'basket-inline' : reportId ? 'report-page-tid' : '',
      },
      rect: null,
    });

    count++;
  });

  return results;
}
