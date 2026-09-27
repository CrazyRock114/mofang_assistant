/**
 * 0020：整卷下载反爬挑战提示的单源判定（纯模块，零 Node/DOM 依赖）
 *
 * 来源：0012 目检新记录——整卷下载遇反爬挑战时只提示「请在采集窗口打开该整卷页人工通过后再试」，
 * 但 UI 无一键跳转通路，用户无法自助解决。
 *
 * 单源约束：collect.ts 两条挑战消息由此模块常量拼装（文案逐字不变），渲染层用同一谓词判定是否挂
 * 自助跳转按钮——判定逻辑只此一处，禁在 app 层另写正则/魔法串。
 *
 * P3 记档（未验证，禁猜修）：题批接口挑战消息指向 mzujuan 移动域，而自助跳转按钮的目标是 PC 整卷页，
 * PC 页过验证对移动域接口挑战是否同源生效未经验证。
 */

/** 挑战消息公共标识子串（现有两条消息共有的字样） */
export const PAPER_CHALLENGE_MARK = '反爬挑战';

/** 谓词：该消息是否为整卷下载反爬挑战提示（渲染层据此挂「去浏览器页打开本卷」按钮） */
export function isPaperChallengeMessage(msg: string | null | undefined): boolean {
  return typeof msg === 'string' && msg.includes(PAPER_CHALLENGE_MARK);
}
