// 0072（只增）：--smoke-announce 探针分支（公告/更新真链自证；仿 smoke-diag/smoke-0066 先例）。
//
// 形态：探针脚本（scripts/probe-0072-announce-update.mjs）起**本地 HTTP fixture 服务器**喂
// announce.json 与 /dl/latest.yml + 假包，--smoke-feed-base=http://127.0.0.1:<port> 覆盖端点（仅 smoke 生效），
// 多轮 launch electron --smoke-announce --smoke-announce-scenario=<场景>，本模块在主进程内：
//  1) stub adapter（探针专用 electron-updater 替身）——真拉 fixture 的 latest.yml/假包，
//     按 electron-updater 的事件语义（checking/available/progress/downloaded/error）回流 UpdateService；
//     quitAndInstall 只记账不真重启（任务书 §一.6 ⑤「stub 不断言真重启」）；
//  2) runAnnounceSmoke——按场景驱动公告服务/更新服务，断言写产物 JSON（探针脚本独立复核）。
//
// electron-updater 本体在未打包态 isUpdaterActive() 短路（checkForUpdates 恒 null）——生产适配器无法在
// 探针（dev 树）运行，stub 同形替身是本单探针的既定口径（交付报告申报）；真包联调归 0073 出仓实测。

import { app } from 'electron';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AnnounceService } from './announce/announce-service.js';
import type { UpdateService, UpdaterAdapter } from './update/update-service.js';
import type { UpdaterEvent } from './update/update-state.js';
import type { UpdateStatus } from '../shared/contracts/distribution-types.js';

/** stub 记账：quitAndInstall 是否被调用（探针 ⑤ 断言面；模块级，与 runAnnounceSmoke 同进程） */
let stubQuitCalled = false;
export function wasStubQuitCalled(): boolean {
  return stubQuitCalled;
}

/** 慢速场景节奏：40KB/s（< 150KB/s 阈值）持续 31s+ 才满慢速窗口 */
const SLOW_BPS = 40 * 1024;
const SLOW_TOTAL = 1_600 * 1024; // 1600KB @ 40KB/s = 40s 窗口必满
const SLOW_TICK_MS = 1_000;

/** 从 latest.yml 抓 version（探针 fixture 用简单行解析，不引 yaml 依赖） */
function parseLatestVersion(yaml: string): string | null {
  const m = yaml.match(/^version:\s*(\S+)\s*$/m);
  return m ? m[1] : null;
}

/**
 * stub updater adapter：事件同形替身（真 HTTP，假重启）。
 * @param feedBase fixture 基址（--smoke-feed-base）
 * @param scenario fetch/quit=快速下载到 downloaded；slow=慢速节奏（40KB/s 持续 >31s）；portable 同 fetch
 */
export function createStubUpdaterAdapter(feedBase: string, scenario: string): UpdaterAdapter {
  const handlers: Array<(event: UpdaterEvent) => void> = [];
  const emit = (event: UpdaterEvent): void => {
    for (const handler of [...handlers]) handler(event);
  };
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  return {
    async checkForUpdates(): Promise<void> {
      emit({ type: 'checking' });
      const resp = await fetch(`${feedBase}/dl/latest.yml`);
      if (!resp.ok) throw new Error(`latest.yml HTTP ${resp.status}`);
      const version = parseLatestVersion(await resp.text());
      if (version === null) throw new Error('latest.yml 缺 version 字段');
      if (version === app.getVersion()) {
        emit({ type: 'not-available' });
      } else {
        emit({ type: 'available', version });
      }
    },

    async downloadUpdate(): Promise<void> {
      if (scenario === 'slow') {
        // 慢速节奏：40KB/s 匀速爬升（total=1600KB → 40s，31s 窗口必满 → slowHint 置位时仍在 downloading）
        let transferred = 0;
        while (transferred < SLOW_TOTAL) {
          await sleep(SLOW_TICK_MS);
          transferred = Math.min(transferred + SLOW_BPS, SLOW_TOTAL);
          emit({ type: 'progress', percent: (transferred / SLOW_TOTAL) * 100, bytesPerSecond: SLOW_BPS, transferred, total: SLOW_TOTAL });
        }
        emit({ type: 'downloaded', version: 'slow' });
        return;
      }
      // 快速节奏：三跳到 downloaded（fetch/quit/portable 场景）
      const total = 900 * 1024;
      for (const transferred of [300 * 1024, 600 * 1024, total]) {
        await sleep(50);
        emit({ type: 'progress', percent: (transferred / total) * 100, bytesPerSecond: 6 * 1024 * 1024, transferred, total });
      }
      emit({ type: 'downloaded', version: 'fast' });
    },

    quitAndInstall(): void {
      stubQuitCalled = true; // stub 不断言真重启——只记账（任务书 §一.6 ⑤）
    },

    onEvent(handler: (event: UpdaterEvent) => void): () => void {
      handlers.push(handler);
      return () => {
        const i = handlers.indexOf(handler);
        if (i >= 0) handlers.splice(i, 1);
      };
    },
  };
}

export interface AnnounceSmokeDeps {
  scenario: string;
  announceService: AnnounceService;
  updateService: UpdateService | null;
  /** 产物 JSON 路径（--smoke-announce-out；缺省 userData/smoke-announce/result.json） */
  outPath: string;
  /** announce 缓存路径（探针断言缓存落盘用） */
  cachePath?: string;
}

export interface AnnounceSmokeReport {
  scenario: string;
  checks: string[];
  facts: Record<string, unknown>;
}

/** 轮询直至谓词成立或超时（返回最终状态） */
async function pollStatus(updateService: UpdateService, predicate: (s: UpdateStatus) => boolean, timeoutMs: number): Promise<UpdateStatus> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = updateService.getStatus();
    if (predicate(status)) return status;
    if (Date.now() > deadline) return status;
    await new Promise<void>((r) => setTimeout(r, 200));
  }
}

/** 场景驱动 + 断言（断言失败 = throw → main 分支 exit 1；产物 JSON 无论成败都落盘供探针复核） */
export async function runAnnounceSmoke(deps: AnnounceSmokeDeps): Promise<AnnounceSmokeReport> {
  const checks: string[] = [];
  const facts: Record<string, unknown> = { scenario: deps.scenario };
  const check = (ok: boolean, label: string): void => {
    checks.push(`${ok ? 'OK  ' : 'FAIL'} ${label}`);
    if (!ok) throw new Error(`smoke 断言失败：${label}`);
  };

  try {
    if (deps.scenario === 'fetch') {
      // ① 好 JSON 拉取 → 缓存落盘 → 桥可读；③ latest.yml 报新版本 → available → 自动下载 → downloaded
      const snap = await deps.announceService.refresh();
      check(snap.source === 'remote', '① 公告首拉 source=remote');
      check(snap.data.messages.length > 0, '① 公告消息非空');
      const cachePath = deps.cachePath ?? '';
      check(cachePath !== '' && existsSync(cachePath), '① 缓存落盘 announce-cache.json');
      const reread = deps.announceService.getSnapshot();
      check(reread.source === 'remote' && reread.data.messages.length > 0, '① getSnapshot（桥可读面）返回生效公告');
      facts.announceSource = snap.source;
      facts.firstMessageId = snap.data.messages[0]?.id ?? null;

      check(deps.updateService !== null, '③ 探针态更新服务已接线');
      // 探针态无启动调度（isAutomationRun 让位）——显式 checkNow 触发（→available→自动下载→downloaded）
      await deps.updateService!.checkNow();
      const status = await pollStatus(deps.updateService!, (s) => s.phase === 'downloaded', 20_000);
      check(status.phase === 'downloaded', `③ latest.yml 新版本 → downloaded（实际 ${status.phase}）`);
      facts.updatePhase = status.phase;
      facts.updateVersion = status.version ?? null;
      facts.quitAndInstallCalled = wasStubQuitCalled();
      check(wasStubQuitCalled() === false, '③ 自动链不触发 quitAndInstall（须用户重启）');
    } else if (deps.scenario === 'fallback') {
      // ② 断网/坏 JSON 回落链（探针侧已按场景关 fixture/喂坏 JSON；此处只验「能回落且不 throw」）
      const snap = await deps.announceService.refresh();
      check(snap.source === 'cache' || snap.source === 'builtin', `② 回落链生效（source=${snap.source}）`);
      check(snap.data.messages.length > 0, '② 回落产物非空（cache 或内置兜底）');
      facts.announceSource = snap.source;
    } else if (deps.scenario === 'slow') {
      // ④ 慢速 fixture（40KB/s 持续 >31s）→ slowHint 置位且下载不停（不自动取消）
      check(deps.updateService !== null, '④ 探针态更新服务已接线');
      const svc = deps.updateService!;
      const started = await svc.checkNow();
      check(started.started, '④ checkNow 启动');
      const slowStatus = await pollStatus(svc, (s) => s.slowHint === true, 60_000);
      check(slowStatus.slowHint === true, `④ slowHint 置位（实际 phase=${slowStatus.phase}）`);
      check(slowStatus.phase === 'downloading', '④ slowHint 置位时下载仍在进行（不自动停）');
      const final = await pollStatus(svc, (s) => s.phase === 'downloaded', 60_000);
      check(final.phase === 'downloaded', '④ 慢速不取消：最终下载完成');
      facts.slowHint = slowStatus.slowHint;
      facts.finalPhase = final.phase;
    } else if (deps.scenario === 'quit') {
      // ⑤ downloaded → quitAndInstall 被调用（stub 记账，不断言真重启）
      check(deps.updateService !== null, '⑤ 探针态更新服务已接线');
      const svc = deps.updateService!;
      await svc.checkNow();
      await pollStatus(svc, (s) => s.phase === 'downloaded', 20_000);
      svc.quitAndInstall();
      check(wasStubQuitCalled(), '⑤ quitAndInstall 被调用（stub 记账）');
      facts.quitAndInstallCalled = wasStubQuitCalled();
    } else if (deps.scenario === 'portable') {
      // 便携降级（L1+L2）：检查到 available 即停——不自动下载；downloadUpdate 拒绝；永不 quitAndInstall
      check(deps.updateService !== null, '⑥ 探针态更新服务已接线');
      const svc = deps.updateService!;
      const started = await svc.checkNow();
      check(started.started, '⑥ 便携 checkNow 启动');
      const status = await pollStatus(svc, (s) => s.phase === 'available' || s.phase === 'error', 20_000);
      check(status.phase === 'available', `⑥ 便携停在 available（L2 提示，实际 ${status.phase}）`);
      await new Promise<void>((r) => setTimeout(r, 1_500)); // 留观察窗：确认无自动下载进度
      check(svc.getStatus().phase === 'available', '⑥ 观察窗内无自动下载（不离开 available）');
      let rejected = false;
      try {
        await svc.downloadUpdate();
      } catch {
        rejected = true;
      }
      check(rejected, '⑥ 便携 downloadUpdate 被拒');
      svc.quitAndInstall();
      check(wasStubQuitCalled() === false, '⑥ 便携 quitAndInstall 被拦（service 层）');
      facts.phase = svc.getStatus().phase;
      facts.downloadRejected = rejected;
      facts.quitAndInstallCalled = wasStubQuitCalled();
    } else {
      throw new Error(`未知场景：${deps.scenario}`);
    }
  } finally {
    mkdirSync(dirname(deps.outPath), { recursive: true });
    writeFileSync(deps.outPath, JSON.stringify({ checks, facts }, null, 2), 'utf8');
  }
  return { scenario: deps.scenario, checks, facts };
}
