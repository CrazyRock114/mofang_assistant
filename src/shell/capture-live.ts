/**
 * --capture-live：双站实站真调辅助（用户在场模式，D1 P4）
 *
 * 合规红线：本脚本不自动登录、不自动找题/加篮、不绕过反爬。
 * 流程：开采集窗 → 停在组卷网首页（用户手动登录）→ 用户手动导航到试题篮页
 * → 脚本轮询（5s）检测篮内题后自动 extractBasket → 打印提取统计（不入库）。
 * 入库由用户在产品 UI（npm start → 采集题库面板）手动点击完成。
 * 退出：关闭采集窗口即退出进程。
 */

import { app } from 'electron';
import type { CaptureHost } from '../capture/browser/host.js';

const POLL_INTERVAL_MS = 5000;

export async function runCaptureLive(host: CaptureHost): Promise<void> {
  console.log('[capture-live] 打开采集窗口（独立窗兜底形态），停在组卷网首页。请手动登录后导航到试题篮页（不会自动登录/加篮/入库）。');
  // 0012 P5：独立窗兜底形态（无人驱动场景；产品主流程走内嵌 view，见 0012 任务书）
  await host.openWindow({ standalone: true });
  await host.navigate('https://zujuan.xkw.com/');

  let lastUrl = '';
  let extracted = false;

  const timer = setInterval(async () => {
    try {
      const state = await host.getState();
      if (!state.open) {
        clearInterval(timer);
        console.log('[capture-live] 采集窗口已关闭，退出。');
        app.quit();
        return;
      }
      if (state.url !== lastUrl) {
        lastUrl = state.url;
        console.log(`[capture-live] 页面: ${state.url}（站点=${state.site ?? '未知'}，登录态=${state.loggedIn}）`);
      }
      if (extracted || !state.site) return;

      const { extracted: ext } = await host.extractBasket();
      if (ext.captured.length === 0) return;
      extracted = true;

      // 提取统计：题目数 / 字段非空统计 / 警告（不打印题面全文，不触凭据）
      const stats = {
        total: ext.captured.length,
        withStem: ext.captured.filter((q) => q.stemHtml.length > 0).length,
        withOptions: ext.captured.filter((q) => q.options.length > 0).length,
        withAnswer: ext.captured.filter((q) => q.answerHtml.length > 0).length,
        withAnalysis: ext.captured.filter((q) => q.analysisHtml.length > 0).length,
        withImages: ext.captured.filter((q) => q.images.length > 0).length,
        gated: ext.captured.filter((q) => q.meta.gated).length,
      };
      console.log(`[capture-live] 检测到篮内题：mode=${ext.mode}，统计=${JSON.stringify(stats)}`);
      for (const q of ext.captured) {
        console.log(
          `[capture-live]   ${q.site}:${q.questionId || '(tid 待报告页解析)'} 题型=${q.meta.questionType ?? '?'} 答案=${q.answerHtml ? '有' : '缺'} 解析=${q.analysisHtml ? '有' : '缺'} 图=${q.images.length}`,
        );
      }
      if (ext.warnings.length > 0) {
        console.log(`[capture-live] 警告 ${ext.warnings.length} 条:`);
        for (const w of ext.warnings) console.log(`[capture-live]   - ${w}`);
      }
      console.log('[capture-live] 提取完成（未入库）。入库请用 npm start 的产品 UI「采集题库」面板操作。关闭采集窗口退出。');
    } catch (err: any) {
      console.warn('[capture-live] 轮询异常（继续等待）:', err?.message || String(err));
    }
  }, POLL_INTERVAL_MS);
}
