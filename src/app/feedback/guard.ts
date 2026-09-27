// 0030 P2：红线守卫（纯函数，任务书 §一 P2 下半）。输入=四项输入 + 生成正文，输出 failures 明细列表。
//
// 三条规则（D-065⑥ 口径：**标红提醒、保存时提示、不硬拦**——是否采纳由教师判断）：
//   ① 数字一致：正文的每个阿拉伯数字都必须能在输入里找到；登记的成绩数字必须原值出现；
//   ② 禁词：技术词清单（AI/人工智能/模型/大模型/数据驱动，可维护常量）；
//   ③ 称呼：正文须含学生姓名，且不得出现「该生」。
//
// 不做的事（报告 §六 登记）：语义级「新增事实」检测超出纯函数能力，由模板约束（内置正文已写死
// 「不得编造、不得改动数字」）+ 人工过目承接。中文数字（「八十二分」）不在数字规则内，同属登记项。
// 模式参照 0024 anchor/validate.ts（返回明细不抛异常），逻辑全新。

import { extractNumbers, feedbackNumbers, type FeedbackInputs } from './prompt.js';

/** 去空白取值（与组装器同口径） */
function trimmed(value: string | undefined): string {
  return (value ?? '').trim();
}

/** 禁词清单（任务书 §一 P2 规则②；可维护常量——改这里即全链生效，模板正文另有一层同源约束） */
export const FEEDBACK_BANNED_WORDS = ['AI', '人工智能', '模型', '大模型', '数据驱动'] as const;

export type FeedbackGuardRule =
  | 'number-mismatch'
  | 'score-missing'
  | 'banned-word'
  | 'missing-name'
  | 'impolite-address';

export interface FeedbackGuardFailure {
  rule: FeedbackGuardRule;
  /** 人读明细（UI 直接展示在标红条里） */
  detail: string;
}

export interface FeedbackGuardResult {
  failures: FeedbackGuardFailure[];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface BannedHit {
  word: string;
  index: number;
  length: number;
}

/**
 * 禁词命中（去重口径）：先各自全量匹配，再丢掉被更长命中区间覆盖的短命中——
 * 避免「大模型」同时报「模型」+「大模型」两条。英文词按词边界匹配（小写 ai 也拦，但不误伤 said）。
 */
function bannedWordHits(text: string): string[] {
  const hits: BannedHit[] = [];
  for (const word of FEEDBACK_BANNED_WORDS) {
    const pattern = /^[A-Za-z]+$/.test(word)
      ? new RegExp(`\\b${escapeRegExp(word)}\\b`, 'gi')
      : new RegExp(escapeRegExp(word), 'g');
    for (const match of text.matchAll(pattern)) {
      hits.push({ word, index: match.index ?? 0, length: word.length });
    }
  }
  const kept = hits.filter((hit) => !hits.some((other) => (
    other !== hit
    && other.length > hit.length
    && hit.index >= other.index
    && hit.index + hit.length <= other.index + other.length
  )));
  const words: string[] = [];
  for (const hit of kept) if (!words.includes(hit.word)) words.push(hit.word);
  return words;
}

/**
 * 红线检查：返回 failures 明细（空数组 = 全过）。任何输入都不抛异常——
 * 正文为空/姓名缺失时如实产出明细，由 UI 标红。
 */
export function checkFeedbackText(inputs: FeedbackInputs, body: string): FeedbackGuardResult {
  const text = body ?? '';
  const failures: FeedbackGuardFailure[] = [];

  // ① 数字一致
  const allowed = new Set(feedbackNumbers(inputs));
  const bodyNumbers = extractNumbers(text);
  const unknown = [...new Set(bodyNumbers)].filter((n) => !allowed.has(n));
  if (unknown.length > 0) {
    failures.push({
      rule: 'number-mismatch',
      detail: `正文出现登记信息里没有的数字「${unknown.join('、')}」（数字只许照抄、不得改写或新增）`,
    });
  }
  const score = trimmed(inputs.score);
  if (score !== '' && !bodyNumbers.includes(score)) {
    failures.push({
      rule: 'score-missing',
      detail: `登记的成绩「${score}」没有出现在正文里（成绩数字须保持原值）`,
    });
  }

  // ② 禁词
  for (const word of bannedWordHits(text)) {
    failures.push({ rule: 'banned-word', detail: `正文出现不能对家长使用的技术词「${word}」` });
  }

  // ③ 称呼
  const name = trimmed(inputs.studentName);
  if (name === '') {
    failures.push({ rule: 'missing-name', detail: '学生姓名为空，无法核对称呼' });
  } else if (!text.includes(name)) {
    failures.push({ rule: 'missing-name', detail: `正文没有出现学生姓名「${name}」` });
  }
  if (text.includes('该生')) {
    failures.push({ rule: 'impolite-address', detail: '正文出现「该生」（须称呼学生姓名）' });
  }

  return { failures };
}
