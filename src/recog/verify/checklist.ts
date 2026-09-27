// 0028 P3：校对核验清单 V1-V5 纯函数 + V8 人签门禁（任务书 §一 P3，P-08 范围）
// V1 题号连续性与层级 / V2 题干完整性启发式 / V3 公式 KaTeX 自动编译 / V4 配图与题目绑定 /
// V5 答案解析字段完整 / V8 人签门禁（全绿才允许入库）。V6/V7 二期不做。
//
// 判据口径（先取证后定规则，证据见交付报告 §P3）：真实夹具 121 条公式里 3 条真编译失败
// （`&lt;` 实体未解码、`M=______` 填空被当公式）——V3 因此有牙齿，不是恒绿检查。
// V3 消费的 tex 串与 renderMath 实际消费的完全一致（都取 data-tex 原样值，不解码实体），
// 故 V3 红 ⇔ 用户看到的渲染出错，不产生「检查绿但页面坏」的错位。

import katex from 'katex';
import type { ProofItem } from '../../shared/contracts/recog-ui-types.js';

export type VerifyCode = 'V1' | 'V2' | 'V3' | 'V4' | 'V5';
export type VerifyLevel = 'warn' | 'fail';

export interface VerifyFinding {
  code: VerifyCode;
  level: VerifyLevel;
  message: string;
  /** 归属条目（null = 全卷级 finding） */
  draftId: string | null;
}

export interface VerifyReport {
  findings: VerifyFinding[];
  fails: VerifyFinding[];
  warnings: VerifyFinding[];
  /** 每条目是否无 fail 级 finding */
  byItem: Record<string, { ok: boolean; findings: VerifyFinding[] }>;
  /** 全绿 = 无 fail（warn 不阻断） */
  passed: boolean;
}

/** data-tex 原样抽取（与 buildPaperHtml.core:renderMath 同口径：不解码 HTML 实体） */
export function extractTexValues(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/data-tex="([^"]*)"/g)) out.push(m[1]);
  return out;
}

/** 去标签取纯文本（图/公式转占位符，便于启发式判空与截断） */
export function plainTextOf(html: string): string {
  return html
    .replace(/<span class="math"[^>]*><\/span>/g, '⟨公式⟩')
    .replace(/<span class="math"[^>]*>[^<]*<\/span>/g, '⟨公式⟩')
    .replace(/<figure[^>]*>[\s\S]*?<\/figure>/g, '⟨图⟩')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 去掉选项块后的题面文本（V2 判空要排除「只有选项没有题面」） */
function stemTextOf(html: string): string {
  return plainTextOf(html.replace(/<div class="options">[\s\S]*?<\/div>/g, '')).replace(/⟨图⟩/g, '').trim();
}

const BARE_ANSWER_TEX = /^[A-E]{1,4}\s*$/;

function visible(items: ProofItem[]): ProofItem[] {
  return items.filter((it) => it.status !== 'delete');
}

/** V3：公式编译（throwOnError:true），逐条失败；同字段同原文只报一次（附出现处数） */
function checkFormulas(item: ProofItem): VerifyFinding[] {
  const findings: VerifyFinding[] = [];
  const fields: Array<[string, string | undefined]> = [
    ['题面', item.contentHtml],
    ['答案', item.answerHtml],
    ['解析', item.analysisHtml],
  ];
  for (const [field, html] of fields) {
    if (!html) continue;
    const counts = new Map<string, number>();
    for (const tex of extractTexValues(html)) {
      // 速答区单字母（如 "5.D" 拆出的 D）不构成公式，跳过——与渲染层同宽容
      if (BARE_ANSWER_TEX.test(tex)) continue;
      counts.set(tex, (counts.get(tex) ?? 0) + 1);
    }
    for (const [tex, count] of counts) {
      try {
        katex.renderToString(tex, { throwOnError: true, displayMode: false });
      } catch (err) {
        findings.push({
          code: 'V3',
          level: 'fail',
          message: `${field}公式编译失败（原文：${tex}${count > 1 ? ` ×${count}` : ''}）：${err instanceof Error ? err.message : String(err)}`,
          draftId: item.draftId,
        });
      }
    }
  }
  return findings;
}

/** V1：题号连续性与层级 */
function checkNumbering(items: ProofItem[]): { findings: VerifyFinding[]; } {
  const findings: VerifyFinding[] = [];
  const seen = new Map<number, string>();
  let prev: ProofItem | null = null;

  for (const item of items) {
    // 0046（qno nullable 适配，逐处申报）：null = 未编号（一步到位草稿的题号原文不可映射），
    // 降为 warn 提示补号，不误报「题号非法」硬拦；其余校验对未编号条目跳过
    if (item.qno === null) {
      findings.push({ code: 'V1', level: 'warn', message: '题号未识别（未编号），请人工补号', draftId: item.draftId });
    } else if (!Number.isInteger(item.qno) || item.qno < 1) {
      findings.push({ code: 'V1', level: 'fail', message: `题号非法（${item.qno}）`, draftId: item.draftId });
    } else if (seen.has(item.qno)) {
      findings.push({
        code: 'V1', level: 'fail',
        message: `题号 ${item.qno} 重复（与 ${seen.get(item.qno)} 撞号）`, draftId: item.draftId,
      });
    } else {
      seen.set(item.qno, item.draftId);
    }

    const itemQno = item.qno;
    const prevQno = prev?.qno ?? null;
    if (prev && prevQno !== null && itemQno !== null) {
      if (itemQno < prevQno) {
        findings.push({
          code: 'V1', level: 'fail',
          message: `题号倒退：${prevQno} → ${itemQno}（顺序与题号不符）`, draftId: item.draftId,
        });
      } else if (itemQno > prevQno + 1) {
        findings.push({
          code: 'V1', level: 'warn',
          message: `题号跳号：${prevQno} → ${itemQno}（缺 ${Array.from({ length: itemQno - prevQno - 1 }, (_, i) => prevQno + i + 1).join('/')}，请确认原卷是否含该题）`,
          draftId: item.draftId,
        });
      }
    }
    if (item.source === 'manual') {
      findings.push({
        code: 'V1', level: 'warn',
        message: `题号 ${item.qno ?? '（未编号）'} 为手工新起条目，请人工确认题号与层级`, draftId: item.draftId,
      });
    }
    prev = item;
  }
  return { findings };
}

/** V2：题干完整性启发式（截断 / 空题面 / 串题 / 结构漂移） */
function checkStem(item: ProofItem): VerifyFinding[] {
  const findings: VerifyFinding[] = [];
  const stem = stemTextOf(item.contentHtml);

  if (stem === '') {
    findings.push({ code: 'V2', level: 'fail', message: '题面无文本（可能整段未识别到）', draftId: item.draftId });
  } else if (/[，、,（(；;]$/.test(stem)) {
    // 结尾悬挂逗号/顿号/左括号/分号 = 句子被切开。冒号不算：中文理科题「求：」是合法收束
    findings.push({ code: 'V2', level: 'fail', message: `题面疑似截断（结尾悬挂「${stem.slice(-1)}」）`, draftId: item.draftId });
  }

  const open = (item.contentHtml.match(/（/g) ?? []).length;
  const close = (item.contentHtml.match(/）/g) ?? []).length;
  const openEn = (item.contentHtml.match(/\(/g) ?? []).length;
  const closeEn = (item.contentHtml.match(/\)/g) ?? []).length;
  if (open !== close || openEn !== closeEn) {
    findings.push({
      code: 'V2', level: 'warn',
      message: `括号不配对（中文 ${open}/${close}，英文 ${openEn}/${closeEn}），疑似 OCR 缺字`,
      draftId: item.draftId,
    });
  }

  // 串题：正文段落以「n.」「n、」起头 = 下一条题号混入本题面
  const paragraphs = [...item.contentHtml.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => plainTextOf(m[1]));
  const intruder = paragraphs.slice(1).find((p) => /^\d{1,2}\s*[.、．](?!\d)/.test(p));
  if (intruder) {
    findings.push({
      code: 'V2', level: 'fail',
      message: `题面疑似串题：混入下一条题号段落「${intruder.slice(0, 24)}」`, draftId: item.draftId,
    });
  }

  if (!item.contentHtml.includes('<div class="question">')) {
    findings.push({
      code: 'V2', level: 'warn',
      message: '题面缺 <div class="question"> 根容器（内容契约结构漂移）', draftId: item.draftId,
    });
  }
  return findings;
}

/** V4：配图与题目绑定（声明图引用 ⇄ 题面 figure 双向核对） */
function checkFigures(item: ProofItem): VerifyFinding[] {
  const findings: VerifyFinding[] = [];
  const bound = new Set([...item.contentHtml.matchAll(/<img\b[^>]*\balt="([^"]*)"/g)].map((m) => m[1]));
  for (const id of item.imageRefIds) {
    if (!bound.has(id)) {
      findings.push({
        code: 'V4', level: 'fail',
        message: `图引用 ${id} 未在题面绑定（图丢了）`, draftId: item.draftId,
      });
    }
  }
  for (const alt of bound) {
    if (alt !== '' && !item.imageRefIds.includes(alt)) {
      findings.push({
        code: 'V4', level: 'fail',
        message: `题面含未声明的图引用 ${alt}（孤儿图）`, draftId: item.draftId,
      });
    }
  }
  return findings;
}

/** V5：答案解析字段完整（缺失=warn 原卷可能本就不含；存在但空=fail） */
function checkAnswerAnalysis(item: ProofItem): VerifyFinding[] {
  const findings: VerifyFinding[] = [];
  const hasAnswer = item.answerHtml !== undefined;
  const hasAnalysis = item.analysisHtml !== undefined;

  if (!hasAnswer && !hasAnalysis) {
    findings.push({
      code: 'V5', level: 'warn',
      message: '未识别到答案/解析（原卷若含答案请人工补录）', draftId: item.draftId,
    });
    return findings;
  }
  if (hasAnswer && plainTextOf(item.answerHtml!).replace(/⟨公式⟩/g, '').trim() === '') {
    findings.push({ code: 'V5', level: 'fail', message: '答案字段存在但无文本', draftId: item.draftId });
  }
  if (hasAnalysis && plainTextOf(item.analysisHtml!).replace(/⟨公式⟩/g, '').trim() === '') {
    findings.push({ code: 'V5', level: 'fail', message: '解析字段存在但无文本', draftId: item.draftId });
  }
  return findings;
}

/** 全量核验（只检可见条目；已删除条目退出核验面，与入库口径一致） */
export function verifyProofItems(items: ProofItem[]): VerifyReport {
  const target = visible(items);
  const findings: VerifyFinding[] = [];
  for (const item of target) {
    findings.push(...checkStem(item));
    findings.push(...checkFigures(item));
    findings.push(...checkAnswerAnalysis(item));
    findings.push(...checkFormulas(item));
  }
  findings.push(...checkNumbering(target).findings);

  const byItem: VerifyReport['byItem'] = {};
  for (const item of target) {
    const own = findings.filter((f) => f.draftId === item.draftId);
    byItem[item.draftId] = { ok: !own.some((f) => f.level === 'fail'), findings: own };
  }

  const fails = findings.filter((f) => f.level === 'fail');
  return {
    findings,
    fails,
    warnings: findings.filter((f) => f.level === 'warn'),
    byItem,
    passed: fails.length === 0,
  };
}

/**
 * V8 人签门禁：全绿才允许入库。
 * 三条件——① 有可见条目；② 每条可见条目都已人工标「校对通过」；③ 核验无 fail 级 finding。
 */
export function ingestGate(items: ProofItem[], report: VerifyReport): { allowed: boolean; reasons: string[] } {
  const target = visible(items);
  const reasons: string[] = [];

  if (target.length === 0) {
    reasons.push('没有可入库的条目（全部已删除或列表为空）');
    return { allowed: false, reasons };
  }

  const unsigned = target.filter((it) => it.status !== 'ok');
  if (unsigned.length > 0) {
    reasons.push(
      `有 ${unsigned.length} 题未标记「校对通过」：${unsigned.slice(0, 5).map((it) => `q${it.qno}`).join('、')}` +
        (unsigned.length > 5 ? ' 等' : ''),
    );
  }

  const byCode = new Map<VerifyCode, number>();
  for (const f of report.fails) byCode.set(f.code, (byCode.get(f.code) ?? 0) + 1);
  if (byCode.size > 0) {
    reasons.push(
      `核验未通过：${[...byCode.entries()].map(([code, n]) => `${code}×${n}`).join('、')}（修正后重跑核验）`,
    );
  }

  return { allowed: reasons.length === 0, reasons };
}
