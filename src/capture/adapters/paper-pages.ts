/**
 * 0006 P4：组卷整卷页解析（与注入 bundle 共用同一实现，禁在主进程/冒烟里手工复制）
 *
 * - PC 详情页（`zujuan.xkw.com/{bankId}p{paperId}.html`）SSR：`div.tk-quest-item[questionid]` 全量题号
 *   （class 选择器，侦察教训：不是标签选择器）+ `<title>` 卷名。免登录。
 * - 移动站批量 API 响应（`/server_api/ques/ids/{bankId}?ids=…`）：`code="0"`（**字符串**）、`data[]` 全字段。
 *   本模块只做纯映射；取页（隐藏窗 + 移动 UA 覆盖 + 页内同源 fetch）在 papers/collect.ts 编排。
 *
 * 一切解析锚定实站脱敏 fixture（scripts/fixtures/0006-p4-*），字段清单见 0006 实站侦察纪要 §3。
 */

import type { CapturedQuestion } from '../../shared/contracts/capture-types.js';
import { cleanCapturedHtml } from '../normalize.js';
import { splitStemAndOptions } from './zujuan.js';

export interface PaperIndexEntry {
  questionId: string;
  bankid?: string;
}

export interface PaperIndex {
  /** 卷名（已剥「-组卷网」站名后缀） */
  title: string;
  questions: PaperIndexEntry[];
  /** 反爬挑战页（滑块/验证码）如实标记，不解析题目、不自动绕过 */
  challenge: boolean;
  /**
   * 卷级学科（实站侧栏 `.subject-menu .title-txt`，如「初中物理」；缺失 undefined）。
   * 用于整卷题 meta.subject → dict 站点行归一（0006-fix-3 P3 语义），避免整卷入散题后 subject 落 unknown。
   */
  subject?: string;
}

/**
 * 图片资源基准（0006-P4-fix-1 P1）：答案解析区公式图在批量接口里是**裸相对**路径
 * （`Upload/formula/<hash>.png`，无主机无前导斜杠），其真实 CDN 基准是 `staticzujuan.xkw.com/quesimg/`
 * ——实站定点验证（侦察 findings 环节 6）：同路径 200 `image/png`；打到 `mzujuan.xkw.com` 则是
 * 404/405 或阿里云 WAF 挑战页（200 `text/html`）。
 * **禁与页内同源 fetch 基准混用**：移动站根（`papers/collect.ts` MOBILE_SITE_URL）只用于取页/取接口。
 */
const IMAGE_CDN_BASE = 'https://staticzujuan.xkw.com/quesimg/';

/** 图片资源 CDN origin：根相对（`/...`）的兜底基准；实站无该形态证据，命中时落 warning 记档（不猜不静默） */
const IMAGE_CDN_ORIGIN = 'https://staticzujuan.xkw.com/';

/** 带 scheme 的绝对 URL（http:/https:/data:/blob:…）：原样保留，不参与基准拼接 */
const ABSOLUTE_URL_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

const CHALLENGE_RE = /(滑块|滑动验证|安全验证|人机验证|请输入验证码|验证码|challenge)/i;

/** 反爬挑战识别（PC 页/接口响应共用；只标记不绕） */
export function looksLikeChallenge(text: string): boolean {
  return CHALLENGE_RE.test(String(text ?? ''));
}

/** 剥字段前缀（【答案】/【解析】/【题文】；含紧随其后的 <br/> 与空白），无前缀原样返回 */
export function stripFieldLabel(html: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(html ?? '').replace(new RegExp(`^\\s*【${escaped}】\\s*(?:<br\\s*/?>\\s*)*`), '');
}

/** 实体归一 + 白名单清洗（&nbsp;→U+00A0；script/on* 剥除；br/img/p/b/sub/sup/table 保留） */
export function cleanPaperQuestionHtml(html: string): string {
  return cleanCapturedHtml(String(html ?? '').replace(/&nbsp;/g, '\u00a0'));
}

/**
 * PC 详情页 SSR 题号提取：`div.tk-quest-item[questionid]`（class 选择器，实站 26 题全在）。
 * 同题号去重保序；bankid 缺失时留 undefined（调用方以 URL 的 bankId 兜底）。
 */
export function extractPaperIndex(doc: any): PaperIndex {
  const title = String(doc?.title ?? '')
    .replace(/\s*[-–—|·]\s*组卷网\s*$/, '')
    .trim();
  const questions: PaperIndexEntry[] = [];
  const seen = new Set<string>();
  const items = doc?.querySelectorAll?.('.tk-quest-item[questionid]') ?? [];
  items.forEach?.((el: any) => {
    const questionId = String(el.getAttribute('questionid') ?? '').trim();
    if (!questionId || seen.has(questionId)) return;
    seen.add(questionId);
    const bankid = el.getAttribute('bankid');
    questions.push({ questionId, ...(bankid ? { bankid: String(bankid) } : {}) });
  });

  // 0020 目检实证：挑战判定此前是「title + 文档 HTML 前 2 万字」纯文本匹配，题干自然用词会命中
  // （物理力学「滑块」、信息题「验证码」、英文题 challenge）→ 正常卷页被判挑战 → 整卷下载直接抛错
  // （题号其实已解析出来），表现为「只有特定试卷报错」。真挑战页不含题目块，故口径收紧为：
  // **有题目块即不判挑战**（文本匹配规则不动，只加这一道前提）。
  const challenge = questions.length === 0
    && looksLikeChallenge(`${doc?.title ?? ''} ${String(doc?.documentElement?.innerHTML ?? '').slice(0, 20000)}`);

  const subject = String(doc?.querySelector?.('.subject-menu .title-txt')?.textContent ?? '').trim() || undefined;

  return { title, questions, challenge, ...(subject ? { subject } : {}) };
}

/** 批量接口上下文（题批响应不带卷级信息，由编排层注入文案 + 溯源 + 卷级学科） */
export interface PaperBatchContext {
  bankid: string;
  paperUrl: string;
  paperTitle: string;
  /** 卷级学科原文（PC SSR 侧栏；缺省不落 meta.subject，入库回落 unknown） */
  subject?: string;
}

export interface PaperBatchParse {
  /** 站点 code 原文（'0'=成功；字符串形态是实站形态，数字 0 一并接受） */
  code: string;
  questions: CapturedQuestion[];
  warnings: string[];
  /** data[] 条数（含跳过的子题/异常条目） */
  total: number;
  /** 子母题条数（quesChildNum>1；v1 不拆子题，按母题整题入库） */
  childCount: number;
  challenge: boolean;
}

/**
 * 图片 src 绝对化（0006-P4-fix-1 P1）：
 * - 绝对 URL（含 `data:`）原样保留；
 * - 协议相对（`//host/...`）按 CDN origin 补协议，主机不变；
 * - 根相对（`/...`）按 CDN origin 解析并记 warning（实站无证据，不猜不静默）；
 * - 裸相对（`Upload/...`）按 CDN `quesimg/` 基准解析（答案解析区公式图的实际形态）。
 */
function absolutizeImageSrc(src: string, warnings: string[], questionId: string): string {
  if (ABSOLUTE_URL_RE.test(src)) return src;
  try {
    if (src.startsWith('//')) return new URL(src, IMAGE_CDN_ORIGIN).href;
    if (src.startsWith('/')) {
      const resolved = new URL(src, IMAGE_CDN_ORIGIN).href;
      const warning = `题 ${questionId} 图片 src 为根相对路径（${src.slice(0, 60)}）：实站无该形态证据，按图片 CDN origin ${IMAGE_CDN_ORIGIN} 解析`;
      if (!warnings.includes(warning)) warnings.push(warning);
      return resolved;
    }
    return new URL(src, IMAGE_CDN_BASE).href;
  } catch {
    return src;
  }
}

/** 收集 img（src 绝对化；题干区=content，答案/解析区=answer），按 src+role 去重 */
function collectImages(
  el: any,
  role: 'content' | 'answer',
  out: Array<{ src: string; alt?: string; role: 'content' | 'answer' }>,
  warnings: string[],
  questionId: string,
): void {
  el.querySelectorAll?.('img').forEach?.((img: any) => {
    const raw = img.getAttribute('src');
    if (!raw) return;
    const src = absolutizeImageSrc(raw, warnings, questionId);
    img.setAttribute('src', src);
    if (out.some((i) => i.src === src && i.role === role)) return;
    out.push({ src, alt: img.getAttribute('alt') || undefined, role });
  });
}

/**
 * 知识点/挂树节点解析：
 * 1) `tagTreeNodes` 非空 → 直接取（侦察定论字段；实抓样本为空数组）
 * 2) 回落 `categoriesList` 各路径叶子（type=1 知识树 / type=0 教材树；实抓样本靠此字段带知识点）
 * 知识点名 = 上述节点名 + `categoriesInfo`（去重保序）
 */
function resolveKnowledge(item: any): { knowledgePoints: string[]; sourceNodeIds: Array<{ site: string; siteNodeId: string }> } {
  const names: string[] = [];
  const nodeIds: Array<{ site: string; siteNodeId: string }> = [];
  const pushName = (name: unknown) => {
    const value = String(name ?? '').trim();
    if (value && !names.includes(value)) names.push(value);
  };
  const pushNode = (id: unknown) => {
    const value = id === undefined || id === null ? '' : String(id).trim();
    if (value && !nodeIds.some((n) => n.siteNodeId === value)) nodeIds.push({ site: 'zujuan', siteNodeId: value });
  };

  const tags = Array.isArray(item?.tagTreeNodes) ? item.tagTreeNodes : [];
  if (tags.length > 0) {
    for (const tag of tags) {
      if (Array.isArray(tag)) {
        const leaf = tag[tag.length - 1];
        pushNode(leaf?.id);
        pushName(leaf?.name);
      } else {
        pushNode(tag?.id);
        pushName(tag?.name);
      }
    }
    return { knowledgePoints: names, sourceNodeIds: nodeIds };
  }

  const categories = Array.isArray(item?.categoriesList) ? item.categoriesList : [];
  for (const path of categories) {
    if (!Array.isArray(path) || path.length === 0) continue;
    const leaf = path[path.length - 1];
    pushNode(leaf?.id);
    pushName(leaf?.name);
  }
  pushName(item?.categoriesInfo);
  return { knowledgePoints: names, sourceNodeIds: nodeIds };
}

/** 单条 data[] → CapturedQuestion；题号缺失等异常返回 null + warning */
function mapItem(
  item: any,
  ctx: PaperBatchContext,
  docFor: (html: string) => any,
  warnings: string[],
): CapturedQuestion | null {
  const rawId = item?.id;
  if (rawId === undefined || rawId === null || String(rawId).trim() === '') {
    warnings.push('题批接口有条目缺 id，已跳过');
    return null;
  }
  const questionId = String(rawId);
  const childNum = Number(item?.quesChildNum ?? 0) || 0;

  const sourceUrl = ctx.paperUrl;
  const doc = docFor('<div></div>');
  const stemEl = doc.createElement('div');
  stemEl.innerHTML = stripFieldLabel(item?.quesBody, '题文');
  const answerEl = doc.createElement('div');
  answerEl.innerHTML = stripFieldLabel(item?.quesAnswer, '答案');
  const analysisEl = doc.createElement('div');
  analysisEl.innerHTML = stripFieldLabel(item?.quesParse, '解析');

  const images: CapturedQuestion['images'] = [];
  collectImages(stemEl, 'content', images, warnings, questionId);
  collectImages(answerEl, 'answer', images, warnings, questionId);
  collectImages(analysisEl, 'answer', images, warnings, questionId);

  const { stemHtml, options } = splitStemAndOptions(stemEl);
  const { knowledgePoints, sourceNodeIds } = resolveKnowledge(item);

  const questionType = String(item?.quesType?.name ?? item?.quesType?.typeName ?? '').trim() || undefined;
  const difficulty = String(item?.quesDiff?.name ?? '').trim() || undefined;
  const answerHtml = cleanPaperQuestionHtml(answerEl.innerHTML);
  const analysisHtml = cleanPaperQuestionHtml(analysisEl.innerHTML);

  return {
    questionId,
    site: 'zujuan',
    sourceUrl,
    stemHtml: cleanPaperQuestionHtml(stemHtml),
    options: options.map(cleanPaperQuestionHtml),
    answerHtml,
    analysisHtml,
    images,
    meta: {
      questionType,
      difficulty,
      // 整卷题天然带 bankId（URL 权威；移动接口 quesType.bankId 同值仅作校验备份）
      bankid: ctx.bankid,
      // 卷级学科（PC SSR 侧栏原文，如「初中物理」）→ ingest 经 dict 站点行归一
      ...(ctx.subject ? { subject: ctx.subject } : {}),
      knowledgePoints,
      sourceNodeIds,
      answerVia: answerHtml || analysisHtml ? 'paper-api' : '',
      // 0006 P4 溯源：卷名/卷 URL/来源卷（from）——ingest 合并入 sourceDetail.paper
      paperRef: {
        title: ctx.paperTitle,
        url: ctx.paperUrl,
        ...(item?.from ? { from: String(item.from) } : {}),
        ...(item?.title ? { paperTitle: String(item.title) } : {}),
      },
      ...(childNum > 1 ? { childQuestionCount: childNum } : {}),
    },
    rect: null,
  };
}

/**
 * 批量 API 响应文本 → CapturedQuestion[]（纯映射）。
 * docFor：HTML→Document 工厂（页内 = new DOMParser().parseFromString；测试 = jsdom）。
 */
export function parsePaperBatch(
  jsonText: string,
  ctx: PaperBatchContext,
  docFor: (html: string) => any,
): PaperBatchParse {
  const warnings: string[] = [];
  const result: PaperBatchParse = { code: '', questions: [], warnings, total: 0, childCount: 0, challenge: false };

  let payload: any;
  try {
    payload = JSON.parse(String(jsonText ?? ''));
  } catch {
    result.challenge = looksLikeChallenge(String(jsonText ?? ''));
    const head = String(jsonText ?? '').replace(/\s+/g, ' ').slice(0, 120);
    warnings.push(`题批接口返回非 JSON（${result.challenge ? '疑似反爬挑战页' : '404/异常页'}）：${head}`);
    return result;
  }

  result.code = payload?.code === undefined || payload?.code === null ? '' : String(payload.code);
  const data = Array.isArray(payload?.data) ? payload.data : [];
  result.total = data.length;

  if (result.code !== '0') {
    warnings.push(`题批接口 code=${result.code || '(空)'}（msg=${String(payload?.msg ?? '')}），本批不产出题目`);
    return result;
  }

  for (const item of data) {
    const question = mapItem(item, ctx, docFor, warnings);
    if (!question) continue;
    if (question.meta.childQuestionCount) {
      result.childCount++;
      warnings.push(`子母题不拆题（v1）：题 ${question.questionId} 含 ${question.meta.childQuestionCount} 小题，按母题整题入库`);
    }
    result.questions.push(question);
  }

  return result;
}
