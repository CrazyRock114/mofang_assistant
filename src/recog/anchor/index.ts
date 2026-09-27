// 0024 P2：AI 锚点底座（纯函数出口）——注入组装 + 后置校验，供 0028/0029/0030 调用
// 快照来源：src/bank/anchor-snapshot-service.ts（只读）；本目录不含 IO。

export { serializeAnchorSnapshot, serializeAnchorNodes, serializeAnchorDict } from './serialize.js';
export { estimateTokens, estimateAnchorTokens } from './budget.js';
export { buildAnchorPrompt, NONE_TOKEN } from './prompt.js';
export { validateAnchorSuggestions } from './validate.js';
