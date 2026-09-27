// 0040 P4：引擎题型 → 字典题型码的映射（纯函数）。
//
// 引擎侧题型是固定五枚举（单选/多选/填空/解答/判断，见 onestep-types.ts）；题库侧题型是字典归一行
// （question_type）。映射按「字典 label 与引擎枚举的语义对应」做，不硬编码字典 id（字典可治理、可改名）。

import type { DictEntry } from '../../shared/contracts/bank-types.js';

/** 引擎枚举 → 字典行 label 的匹配候选（按序优先；宽松包含匹配，字典叫法差异容错） */
const ENGINE_TYPE_ALIASES: Record<string, string[]> = {
  单选: ['单选', '单项选择', '选择'],
  多选: ['多选', '多项选择'],
  填空: ['填空'],
  解答: ['解答', '计算', '综合', '简答', '实验'],
  判断: ['判断'],
};

/**
 * 引擎题型 + 字典行 → 字典行 id（'' = 未匹配，UI 显示引擎原文并提示人工选）。
 * 只读匹配，不写字典（不治理、不新建）。
 */
export function mapQuestionTypeToDict(engineType: string, entries: DictEntry[]): string {
  const aliases = ENGINE_TYPE_ALIASES[engineType] ?? [engineType];
  for (const alias of aliases) {
    const hit = entries.find((e) => e.label === alias);
    if (hit) return hit.id;
  }
  for (const alias of aliases) {
    const hit = entries.find((e) => e.label.includes(alias));
    if (hit) return hit.id;
  }
  return '';
}

/** 题型下拉选项（字典行；空表 = 只有引擎枚举的兜底项，不造假数据） */
export interface TypeOption {
  value: string;
  label: string;
}

export function typeOptionsOf(entries: DictEntry[]): TypeOption[] {
  return entries.map((e) => ({ value: e.id, label: e.label }));
}
