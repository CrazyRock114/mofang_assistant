// 0024 P2：NONE 协议 prompt 模板（P-11 硬边界）
//
// 硬边界只有两条，必须同时出现在 system 里：
//   1) 只能从锚点清单中选取 ID；
//   2) 清单内没有匹配项时必须输出 NONE（不得编造、不得输出空数组蒙混）。
// 空锚点直接拒绝构建（P-11「空锚点=必然编词」）——这是结构性保护，不靠调用方自觉。
//
// 分层注入（超预算预案）只留接口：strategy='layered' 明确报错而非静默回落全量，
// 避免 0029/0030 以为拿到的是分层结果却实际注入全量（V-6 实测结论见 0024 交付报告）。

import type { AnchorPrompt, AnchorPromptOptions } from '../../shared/contracts/ai-anchor.js';
import { serializeAnchorSnapshot } from './serialize.js';

/** 清单内无匹配的约定输出（校验器与 prompt 共用同一常量，防止两边写歪） */
export const NONE_TOKEN = 'NONE';

const SYSTEM_PROMPT = [
  '你是教辅题库的标注助手。以下「锚点清单」是本次任务唯一可用的词汇表。',
  '',
  '硬边界：',
  `1. 只能从锚点清单中选取 ID，不得使用清单外的任何 ID，也不得自己编造名称或 ID。`,
  `2. 清单内没有匹配项时，必须只输出 ${NONE_TOKEN}（不要输出空数组、不要解释）。`,
  '3. 每条建议都必须带 evidence，evidence 里引用的 ID 必须同样出现在清单中。',
  '',
  '输出格式（严格遵守，不要输出 Markdown 代码块以外的任何说明文字）：',
  `- 有匹配项：{"suggestions":[{"kind":"tree-node","targetId":"<清单中的节点ID>","confidence":0.0,"evidence":[{"kind":"tree-node","nodeId":"<清单中的节点ID>"}]}]}`,
  `- 无匹配项：${NONE_TOKEN}`,
  'kind 取值：tree-node（挂树节点）/ question-type（题型）/ difficulty（难度）。',
  'question-type 与 difficulty 的 targetId 取「题型」「难度」两节的字典 ID，'
  + 'evidence 用 {"kind":"dict","entryId":"<字典ID>"}；引用题号用 {"kind":"question","questionId":"<题号>"}。',
].join('\n');

/**
 * 组装注入 prompt。
 * @throws 空锚点（P-11 拒绝放行）/ strategy='layered'（预案未实现）
 */
export function buildAnchorPrompt(options: AnchorPromptOptions): AnchorPrompt {
  const { snapshot, task, strategy = 'full' } = options;

  if (snapshot.empty) {
    throw new Error(`锚点快照为空（${snapshot.emptyReason ?? '未知原因'}）：空锚点=必然编词，拒绝构建 AI 请求（P-11）`);
  }
  if (strategy === 'layered') {
    throw new Error('分层注入未实现：接口已预留，待 V-6 实测超预算后启用（见 0024 交付报告）');
  }

  return {
    system: SYSTEM_PROMPT,
    user: [
      task.trim(),
      '',
      serializeAnchorSnapshot(snapshot),
      '',
      `再次强调：只能从上述清单中选取 ID；清单内没有匹配项时只输出 ${NONE_TOKEN}。`,
    ].join('\n'),
  };
}
