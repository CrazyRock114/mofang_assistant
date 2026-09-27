// 0040 P1：一步到位响应解析（纯函数，无 IO）。
//
// 职责：把模型原始文本尽力解析成「原始题条目 + 内联图块」结构；不做业务判定（那在 validate.ts）。
// 覆盖 0042 实测的三类失败模式里的前两类的前半步：
//   ①静默空数组（32b-Instruct）→ 解析成功但 questions 为空（由校验层规则 ① 拒绝）
//   ②非法 JSON 转义（30b-think，`Invalid \escape`）→ 本地修复 `\x` → 仍失败则交上层重试一次
//
// 禁 any/unknown：结构守卫一律走 JsonValue 联合类型。

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** 原始题条目（字段全部容忍缺失/错型——域校验在校验层，此处只保证是「能拿到的形状」） */
export interface RawOnestepQuestion {
  raw: { [key: string]: JsonValue };
}

/** 原始图块框（0-999 口径，来自主模型内联 grounding 兜底腿或 DSO 双模板） */
export interface RawFigureBox {
  ref: string;
  bbox999: [number, number, number, number];
}

export interface ParsedOnestep {
  questions: RawOnestepQuestion[];
  /** 顶层 figures（内联 grounding 兜底腿；DSO 另走 figures.ts，两者在对账层合并） */
  inlineFigures: RawFigureBox[];
  /** JSON 坏转义被本地修复过（校验层记 warning；上层据此决定是否再重试一次模型调用） */
  escapeRepaired: boolean;
  /** 围栏/尾逗号等宽松清理命中过 */
  looseRepaired: boolean;
}

export type OnestepParseResult =
  | { ok: true; value: ParsedOnestep }
  | { ok: false; reason: string };

// ==================== JSON 宽松解析 ====================

/** 剥 Markdown 代码围栏（模型常见；围栏内才是 JSON 本体） */
export function stripCodeFence(text: string): string {
  const match = /^```[A-Za-z]*\s*([\s\S]*?)\s*```$/.exec(text.trim());
  return match ? match[1]!.trim() : text.trim();
}

const VALID_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u']);

/**
 * 修复非法反斜杠转义（0042 实测 `Invalid \escape`：模型把 LaTeX `\alpha` 原样塞进 JSON 字符串）。
 * 只处理「反斜杠 + 非法转义字符」与「\u 后不足 4 位十六进制」两种；合法转义原样保留。
 */
export function repairInvalidEscapes(text: string): { text: string; repaired: boolean } {
  let out = '';
  let repaired = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = text[i + 1];
    if (next === undefined) {
      out += '\\\\';
      repaired = true;
      continue;
    }
    if (!VALID_ESCAPES.has(next)) {
      out += '\\\\';
      repaired = true;
      continue;
    }
    if (next === 'u') {
      const hex = text.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
        out += '\\\\';
        repaired = true;
        continue;
      }
      out += '\\u' + hex;
      i += 5;
      continue;
    }
    out += '\\' + next;
    i += 1;
  }
  return { text: out, repaired };
}

/** 尾逗号清理（`{"a":1,}` → `{"a":1}`；只在首次 JSON.parse 失败后兜底） */
export function stripTrailingCommas(text: string): { text: string; repaired: boolean } {
  const fixed = text.replace(/,\s*([}\]])/g, '$1');
  return { text: fixed, repaired: fixed !== text };
}

/** 取最外层对象文本（容忍前后杂文字；无花括号 = 失败） */
function sliceBraces(text: string): string | null {
  const i = text.indexOf('{');
  const j = text.lastIndexOf('}');
  if (i === -1 || j === -1 || j <= i) return null;
  return text.slice(i, j + 1);
}

function asObject(value: JsonValue): { [key: string]: JsonValue } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value;
}

export function parseJsonLoose(raw: string): { ok: true; value: JsonValue; escapeRepaired: boolean; looseRepaired: boolean } | { ok: false; reason: string } {
  const trimmed = stripCodeFence(raw).trim();
  if (!trimmed) return { ok: false, reason: '模型返回空内容' };
  const body = sliceBraces(trimmed);
  if (body === null) return { ok: false, reason: '返回体中没有可解析的 JSON 对象（未找到花括号）' };

  try {
    return { ok: true, value: JSON.parse(body) as JsonValue, escapeRepaired: false, looseRepaired: false };
  } catch (firstErr) {
    // 第一层兜底：非法转义修复（0042 实测失败模式 ②）
    const escapes = repairInvalidEscapes(body);
    if (escapes.repaired) {
      try {
        return { ok: true, value: JSON.parse(escapes.text) as JsonValue, escapeRepaired: true, looseRepaired: false };
      } catch {
        /* 继续下一层兜底 */
      }
    }
    // 第二层兜底：尾逗号清理（在转义修复结果上做，避免二次污染）
    const base = escapes.repaired ? escapes.text : body;
    const commas = stripTrailingCommas(base);
    if (commas.repaired) {
      try {
        return { ok: true, value: JSON.parse(commas.text) as JsonValue, escapeRepaired: escapes.repaired, looseRepaired: true };
      } catch {
        /* 落到失败 */
      }
    }
    return { ok: false, reason: `返回体不是合法 JSON：${firstErr instanceof Error ? firstErr.message : String(firstErr)}` };
  }
}

// ==================== 一步到位响应结构提取 ====================

/** 四个 0-999 数值构成合法框即收（其余字段不解释） */
function asBox999(value: JsonValue): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length < 4) return null;
  const nums = value.slice(0, 4).map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null));
  if (nums.some((n) => n === null)) return null;
  return [nums[0]!, nums[1]!, nums[2]!, nums[3]!];
}

function asFigureBoxes(value: JsonValue): RawFigureBox[] {
  if (!Array.isArray(value)) return [];
  const out: RawFigureBox[] = [];
  for (const item of value) {
    const obj = asObject(item);
    if (!obj) continue;
    const ref = obj['ref'];
    const box = asBox999(obj['bboxNorm'] ?? obj['bbox'] ?? null);
    if (typeof ref !== 'string' || !ref.trim() || !box) continue;
    out.push({ ref: ref.trim(), bbox999: box });
  }
  return out;
}

/**
 * 一步到位响应 → 原始题条目 + 内联图块。
 * 顶层 `questions` 缺失/非数组 = 结构性失败（上层按「无效结构」重试或报错）；
 * `questions` 存在但为空数组 = 结构合法、内容为空（由校验层规则 ① 拒绝，这里如实放行）。
 */
export function parseOnestepResponse(raw: string): OnestepParseResult {
  const parsed = parseJsonLoose(raw);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const obj = asObject(parsed.value);
  if (!obj) return { ok: false, reason: '返回体顶层不是 JSON 对象' };
  const questionsRaw = obj['questions'];
  if (!Array.isArray(questionsRaw)) {
    return { ok: false, reason: '返回体缺 questions 数组（顶层结构不符：应为 {"questions":[…]}}' };
  }
  const questions: RawOnestepQuestion[] = [];
  for (const item of questionsRaw) {
    const entry = asObject(item);
    if (!entry) continue;
    questions.push({ raw: entry });
  }
  return {
    ok: true,
    value: {
      questions,
      inlineFigures: asFigureBoxes(obj['figures'] ?? []),
      escapeRepaired: parsed.escapeRepaired,
      looseRepaired: parsed.looseRepaired,
    },
  };
}

// ==================== 字段级读取器（校验层/组装层共用，无 any） ====================

export function readString(source: { [key: string]: JsonValue }, key: string): string | null {
  const v = source[key];
  return typeof v === 'string' ? v : null;
}

export function readNumber(source: { [key: string]: JsonValue }, key: string): number | null {
  const v = source[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function readStringArray(source: { [key: string]: JsonValue }, key: string): string[] {
  const v = source[key];
  if (!Array.isArray(v)) return [];
  return v.filter((item): item is string => typeof item === 'string').map((s) => s.trim()).filter((s) => s !== '');
}

export function readArray(source: { [key: string]: JsonValue }, key: string): JsonValue[] | null {
  const v = source[key];
  return Array.isArray(v) ? v : null;
}

export { asObject, asBox999 };
