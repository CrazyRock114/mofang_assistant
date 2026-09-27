// 0040 P1：一步到位校验层六条（0042 §七 + §9.3 建议，反推自实测失败模式）。
//
// 六条与其处置强度（每条都有正反例单测，见 test/recog/onestep-validate.test.ts）：
//   ① empty-output        空数组/空串拒绝 —— 硬失败（追问：模型能力不足或提示词未遵循）
//   ② bad-json-escape     JSON 坏转义修复（解析层已修）→ 记 warning；修不动 = 硬失败并要求重试一次
//   ③ subquestion-split   小题不拆分结构校验 —— 非阻断核验提示（schema 过 ≠ 结构对）
//   ④ proof-answer-null   题干含试证/证明类关键词 → 答案字段强制置空（不得自行作答）
//   ⑤ budget-exhausted    finish=length（预算耗尽→产出为空）识别为「预算问题」而非「模型不干活」
//   ⑥ thinking-switch     思考开关按模型能力配置（provider 发送 + 网关不识别的降级省略）
//
// 本文件是纯函数：不发起调用、不触 IO。重试决策以 `retry` 信号上抛给 provider。

import type { OnestepDraft, OnestepFigure, OnestepFigureSource, OnestepOption, OnestepQuestionType } from '../../shared/contracts/onestep-types.js';
import { ONESTEP_QUESTION_TYPES } from '../../shared/contracts/onestep-types.js';
import { figureRefsInMarkdown } from './figures.js';
import { extractOptionsFromStem, stripDuplicateOptionTail } from './options.js';
import type { JsonValue, ParsedOnestep, RawOnestepQuestion } from './parse.js';
import { asObject, readArray, readString, readStringArray } from './parse.js';

/** 校验层六条规则 id（任务书 §二 P1.3；测试与告警文案共用同一口径） */
export const ONESTEP_RULE_IDS = [
  'empty-output',
  'bad-json-escape',
  'subquestion-split',
  'proof-answer-null',
  'budget-exhausted',
  'thinking-switch',
] as const;
export type OnestepRuleId = (typeof ONESTEP_RULE_IDS)[number];

/** 上层重试信号：none = 不重试；model = 原样重试一次；budget = 提预算/关思考后重试 */
export type OnestepRetryHint = 'none' | 'model' | 'budget';

/** 题干含「证明」类关键词（0042 §2.2：两类模型都会把求证目标抄进 answerMarkdown） */
const PROOF_KEYWORD_RE = /试证|证明|求证|论证/;

const MAX_TAGS = 8;

/** 规则 ③ 的小序号上界（≤ 此值的「章-小号」重复出现才判为小题被拆；`2-17/2-18` 是正常章题号） */
const SUB_INDEX_MAX = 9;

export interface BuildDraftsInput {
  /** 模型原始返回体（空串判定 = 预算耗尽的现场证据） */
  raw: string;
  parsed: ParsedOnestep;
  pageNo: number;
  /** 页级图块（对账层产出） */
  figures: OnestepFigure[];
  figureSource: OnestepFigureSource;
  /** 对账层告警（原样并入每张草稿） */
  figureWarnings: string[];
}

export interface BuildDraftsResult {
  drafts: OnestepDraft[];
  /** 硬失败人读原因（非 null 时 drafts 为空） */
  failure: string | null;
  retry: OnestepRetryHint;
  /** 页级告警（与草稿内 warnings 同源，便于调用方汇总） */
  warnings: string[];
}

/** 规则 ①：空数组/空串拒绝；规则 ⑤：空串 = 预算耗尽的现场证据 → 提预算重试 */
function checkEmptiness(input: BuildDraftsInput): { failure: string; retry: OnestepRetryHint } | null {
  if (input.raw.trim() === '') {
    return {
      failure:
        '模型未返回任何内容（finish=length 预算耗尽：思考 token 烧尽输出预算，产出为空）——已按规则 ⑤ 提预算/关思考重试',
      retry: 'budget',
    };
  }
  if (input.parsed.questions.length === 0) {
    return {
      failure:
        '模型返回空题目数组（合规空响应，多为模型不具备该能力域）——已按规则 ① 拒绝；请更换主档模型或改用半自动/手动档',
      retry: 'model',
    };
  }
  return null;
}

/**
 * 规则 ③：小题不拆分结构校验（0042：glm 把嵌套小题拆成 `2-1/2-2/3-1×3`）。
 * 判据（同页多题时）：① 出现同基号的多条 `base-idx` 题号；② 同一题号重复出现。
 * 非阻断——小题拆分真假需人看，故只出核验提示不硬拦。
 */
export function detectSubquestionSplit(questions: RawOnestepQuestion[]): string | null {
  const qnos: string[] = [];
  for (const q of questions) {
    const qno = readString(q.raw, 'qno');
    if (typeof qno === 'string' && qno.trim() !== '' && qno.trim() !== 'null') qnos.push(qno.trim());
  }
  if (qnos.length < 2) return null;

  const seen = new Set<string>();
  for (const qno of qnos) {
    if (seen.has(qno)) {
      return `同页出现重复题号「${qno}」——疑似小题/子问被拆成了多题（(1)(2)① 应并入同一大题）`;
    }
    seen.add(qno);
  }

  // 章-题号形态（`2-17`）的「章」相同是**正常现象**（同章多题），故真正的信号是
  // 后段是小序号（≤ SUB_INDEX_MAX）且同章重复出现——那正是 (1)(2) 被拆成 2-1/2-2 的形态。
  const groups = new Map<string, number[]>();
  for (const qno of qnos) {
    const m = /^(\d+)\s*[-—.]\s*(\d+)$/.exec(qno);
    if (!m) continue;
    const base = m[1]!;
    const list = groups.get(base) ?? [];
    list.push(Number(m[2]));
    groups.set(base, list);
  }
  for (const [base, indexes] of groups) {
    if (indexes.length >= 2 && indexes.every((i) => i <= SUB_INDEX_MAX)) {
      return `题号「${base}-N」出现 ${indexes.length} 次且后段为小序号——疑似小题被拆成了多题（题号保「章-题号」形态，小题并入同一大题题干）`;
    }
  }
  return null;
}

/** 规则 ④：题干含证明类关键词 → 答案强制置空（模型不得自行作答） */
export function shouldNullAnswer(stemMarkdown: string): boolean {
  return PROOF_KEYWORD_RE.test(stemMarkdown);
}

function normalizeQuestionType(value: string | null, warnings: string[]): OnestepQuestionType {
  if (value !== null) {
    const trimmed = value.trim();
    const hit = ONESTEP_QUESTION_TYPES.find((t) => t === trimmed || trimmed.startsWith(t));
    if (hit) return hit;
    if (trimmed !== '') warnings.push(`题型「${trimmed}」不在枚举内，已按「解答」处理`);
  }
  return '解答';
}

function normalizeQno(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'null') return null;
  return trimmed;
}

function normalizeOptionalText(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function normalizeOptions(value: JsonValue[] | null, warnings: string[]): OnestepOption[] | null {
  if (value === null) return null;
  const options: OnestepOption[] = [];
  for (const item of value) {
    const obj = asObject(item);
    if (!obj) continue;
    const label = readString(obj, 'label');
    const content = readString(obj, 'content');
    if (content === null || content.trim() === '') continue;
    options.push({
      label: (label ?? '').replace(/[\s.．、:：]*$/u, '').trim().toUpperCase() || '?',
      content: content.trim(),
    });
  }
  if (options.length === 0) {
    warnings.push('模型给出的 options 为空/无效，已按无选项处理（null）');
    return null;
  }
  return options;
}

function normalizeTags(value: string[]): string[] {
  const out: string[] = [];
  for (const tag of value) {
    if (out.includes(tag)) continue;
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/**
 * 页级图块 → 逐题分配。模型侧 [图N] 的编号口径实测不统一，故按数据形态自动判别：
 *
 *  全局编号（默认实测形态：全页 [图1..图N] 各出现一次，见 0042 奥赛卷留档）→
 *    第 N 张页级图块直接分给引用 [图N] 的题（一一对应，最精确）。
 *  题内编号（提示词口径：同一题内从 1 重新计，跨题出现重复 N）→
 *    按题序窗口切分（每题消耗 max([图N]) 个页级图块），并显式提示逐题核对。
 *
 * 无 [图N] 占位的题不分配图块（图块冗余由对账告警显式提示）。
 */
export function assignFigures(
  drafts: Array<{ stemMarkdown: string }>,
  pageFigures: OnestepFigure[],
): { perDraft: OnestepFigure[][]; warnings: string[] } {
  const warnings: string[] = [];
  const refsPerDraft = drafts.map((draft) => figureRefsInMarkdown(draft.stemMarkdown));
  const allRefs = refsPerDraft.flat();
  const perQuestionNumbering = new Set(allRefs).size !== allRefs.length;
  const draftsWithFigures = refsPerDraft.filter((refs) => refs.length > 0).length;

  if (!perQuestionNumbering) {
    const perDraft = refsPerDraft.map((refs) =>
      refs.map((n) => pageFigures[n - 1]).filter((f): f is OnestepFigure => f !== undefined),
    );
    const covered = new Set(refsPerDraft.flat());
    if (pageFigures.length > 0 && covered.size < pageFigures.length) {
      warnings.push(`页级图块 ${pageFigures.length} 个，题面只引用了 ${covered.size} 个（未被引用的图块未分配）`);
    }
    return { perDraft, warnings };
  }

  const perDraft: OnestepFigure[][] = [];
  let cursor = 0;
  for (const refs of refsPerDraft) {
    if (refs.length === 0) {
      perDraft.push([]);
      continue;
    }
    const need = Math.max(...refs);
    perDraft.push(pageFigures.slice(cursor, cursor + need));
    cursor += need;
  }
  if (draftsWithFigures > 1) {
    warnings.push('本页多题且多题带图：图块按题序窗口切分分配，请逐题核对图与题的对应关系');
  }
  return { perDraft, warnings };
}

/** 六条规则 → 草稿集（硬失败/重试信号/告警一并上抛） */
export function buildOnestepDrafts(input: BuildDraftsInput): BuildDraftsResult {
  const empty = checkEmptiness(input);
  if (empty) return { drafts: [], failure: empty.failure, retry: empty.retry, warnings: [] };

  const pageWarnings: string[] = [];

  // 规则 ②：转义修复留痕（不静默——修复过就要说）
  if (input.parsed.escapeRepaired) {
    pageWarnings.push('返回体含非法 JSON 转义，已按规则 ② 本地修复后解析（LaTeX 反斜杠高发，已如实留痕）');
  }
  if (input.parsed.looseRepaired) {
    pageWarnings.push('返回体含尾逗号等 JSON 瑕疵，已宽松清理后解析');
  }

  // 规则 ③：小题拆分结构校验（非阻断核验提示）
  const splitWarning = detectSubquestionSplit(input.parsed.questions);
  if (splitWarning) pageWarnings.push(splitWarning);

  const stems = input.parsed.questions.map((q) => readString(q.raw, 'stemMarkdown') ?? '');
  const assigned = assignFigures(
    stems.map((stemMarkdown) => ({ stemMarkdown })),
    input.figures,
  );
  pageWarnings.push(...assigned.warnings);

  const drafts: OnestepDraft[] = [];
  input.parsed.questions.forEach((question, index) => {
    const warnings: string[] = [];
    const stemMarkdown = (stems[index] ?? '').trim();
    if (stemMarkdown === '') warnings.push('题干为空（模型未给出题干文本）');

    const questionType = normalizeQuestionType(readString(question.raw, 'questionType'), warnings);
    let options = normalizeOptions(readArray(question.raw, 'options'), warnings);
    // 返工④：模型把选项写进题干正文时（0042 留档实测的常态）本地还原结构化选项
    let stemForDraft = stemMarkdown;
    if (options === null && stemMarkdown !== '') {
      const recovered = extractOptionsFromStem(stemMarkdown);
      if (recovered) {
        options = recovered.options;
        stemForDraft = recovered.stem;
        warnings.push('选项由题干正文还原（模型未按 options 结构化输出）——请确认选项切分是否与原题一致');
      }
    } else if (options !== null && options.length >= 2) {
      // 模型给了结构化选项、题干末尾又留了一份同样的选项行 → 去重（否则题卡里选项显示两遍）
      stemForDraft = stripDuplicateOptionTail(stemMarkdown, options);
    }
    // 选择题却没选项：模型多半用了本地认不出的形态（提示用户手动补，而不是静静当填空题）
    if (options === null && (questionType === '单选' || questionType === '多选')) {
      warnings.push('题型是选择题但没拿到选项（题干里也没有 A/B/C/D 标号）——请确认原题选项是否漏识');
    }

    let answerMarkdown = normalizeOptionalText(readString(question.raw, 'answerMarkdown'));
    const analysisMarkdown = normalizeOptionalText(readString(question.raw, 'analysisMarkdown'));
    // 规则 ④：证明/试证类题强制清空答案（模型会抄求证目标当答案）
    if (answerMarkdown !== null && shouldNullAnswer(stemForDraft)) {
      answerMarkdown = null;
      warnings.push('题干含「证明/试证」类关键词，已按规则 ④ 强制清空答案字段（防模型自行作答），请人工确认');
    }

    const tags = normalizeTags(readStringArray(question.raw, 'suggestedTags'));
    drafts.push({
      qno: normalizeQno(readString(question.raw, 'qno')),
      questionType,
      stemMarkdown: stemForDraft,
      options,
      answerMarkdown,
      analysisMarkdown,
      suggestedTags: tags,
      figures: assigned.perDraft[index] ?? [],
      figureSource: input.figureSource,
      warnings: [...warnings, ...input.figureWarnings],
    });
  });

  return { drafts, failure: null, retry: 'none', warnings: pageWarnings };
}

/**
 * 规则 ⑤ 的重试预算口径：首次失败 → 关思考 + 预算**翻倍**（4096 → 8192 → 16384）。
 * 返回 null = 到顶不再重试。
 *
 * 为什么是逐级翻倍而不是一步到顶（2026-09-19 用户实测教训）：一步跳到 16384 会撞上供应商
 * 自己的输出上限（回「token 超过上限」），识别整条链失败。逐级试探把「模型需要更多预算」
 * 与「供应商不许更大预算」两件事解耦——网关侧另有 max_tokens 被拒即丢参数重试的兜底。
 */
export function nextBudgetRetry(current: { thinking: 'enabled' | 'disabled'; maxTokens: number }):
  | { thinking: 'disabled'; maxTokens: number }
  | null {
  if (current.thinking === 'disabled' && current.maxTokens >= ONESTEP_BUDGET_RETRY_MAX_TOKENS) return null;
  return {
    thinking: 'disabled',
    maxTokens: Math.min(current.maxTokens * 2, ONESTEP_BUDGET_RETRY_MAX_TOKENS),
  };
}

/** 规则 ⑤ 提预算上限（对齐 POC 外源思考模型实测 13k 级推理 token 的余量） */
export const ONESTEP_BUDGET_RETRY_MAX_TOKENS = 16384;
